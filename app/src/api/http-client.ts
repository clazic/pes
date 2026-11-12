import { FORMAT_VERSION, NotConnectedError, PesApiError, type Actor, type ApiError, type AiAccess, type AssumptionRow, type ChangesRead, type ChangeTx, type CommandResult, type DecisionRow, type FollowupView, type Link, type MaterialRow, type PesClient, type ProjectRef, type ReferenceCitation, type ReferenceContent, type ReferenceContentItem, type ReferenceRow, type ReferencesMethods, type QuestionInput, type CommentMessageView, type CommentThreadView, type QuestionKind, type QuestionStatus, type QuestionView, type Receipt, type ReflectionEntry, type RoundView, type WorkspaceView } from "./types";
import { markAfterSend } from "./send-outcome";

/**
 * 실제 HTTP 클라이언트(U1b) — 가짜 클라이언트(fake-client.ts)와 같은 PesClient 모양을 지키고, 서버 JSON API(`/api/v1/`)를 읽는다.
 *  - 소유자 세션은 모든 요청에 헤더 `x-pes-session` 으로만 보낸다(쿠키·Authorization 없음, credentials 도 보내지 않음).
 *  - 같은 출처(baseUrl 기본 "")이고, 읽기는 GET 에 본문·Idempotency-Key 가 없다.
 *  - 화면 주소의 slug 는 `projects`(slug → 프로젝트 id)로 풀어 `P = /api/v1/projects/{id}` 를 만든다. 모르는 slug 는 요청 없이 null.
 *  - 서버 404 not_found 는 null, 그 밖의 거절은 PesApiError(`.body` = 서버가 준 오류 봉투), 네트워크 실패는 그대로 reject — 삼키지 않는다.
 * 네트워크 호출(fetch)은 이 파일 한 곳에만 있다(harness.test.ts 가 지킨다).
 */

export interface HttpClientOptions {
  /** 소유자 세션 값 → 헤더 x-pes-session */
  session: string;
  /** slug → 프로젝트 id */
  projects: Record<string, string>;
  /** 기본 "" = 같은 출처 */
  baseUrl?: string;
  /** 기본 globalThis.fetch (호출 때 찾는다 — 시험이 나중에 바꿔 끼운 것도 쓴다) */
  fetch?: typeof fetch;
  /** 쓰기 요청(POST · 영수증 GET · 사전 읽기) 한 번의 시간 제한, 밀리초. 기본 15000. 넘으면 name "TimeoutError" 로 끝난다 */
  timeoutMs?: number;
}

/** 쓰기 시간 제한 기본값 — 화면의 “접수 확인 중”(F06)이 production 에서도 나오게 하는 상한 */
export const WRITE_TIMEOUT_MS = 15_000;

/** 시간 초과·접수 확인 불가 — 화면(AskPane `isTimeout` · describeError)이 name 으로 알아보고 “접수 확인 중 + 같은 멱등 키로 다시 확인”을 보인다 */
const timeoutError = (message: string): Error => Object.assign(new Error(message), { name: "TimeoutError" });

type Json = Record<string, unknown>;

const isRecord = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** 쓰기 응답이 도착한 뒤의 본문 읽기 — 2xx 인데 JSON 이 아니거나 본문이 도중에 끊기면 서버는 이미 처리했을 수 있다. 그래서 “요청을 보낸 뒤”로 표시한다 */
async function jsonAfterSend(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch (e) {
    markAfterSend(e);
    throw e;
  }
}

/** 서버 오류 봉투가 아닌 응답(빈 본문·HTML 등)에 붙이는 봉투 — 코드는 상태에서 정한다 */
function fallbackBody(status: number): ApiError {
  const code = status === 401 ? "unauthenticated" : status === 403 ? "forbidden" : status === 404 ? "not_found" : status >= 500 ? "internal_error" : "invalid_payload";
  return {
    format_version: FORMAT_VERSION,
    error: { code, message: "서버가 알 수 없는 답을 돌려주었습니다.", retryable: status >= 500, next_action: "reread_context" },
    request_id: "client",
  } as unknown as ApiError; // 서버의 닫힌 오류 코드는 types.ts 의 U1a 목록보다 많다(unauthenticated · forbidden · cursor_expired …)
}

/** 오류 응답 → PesApiError. 서버 봉투(`error.code` 가 있는 것)는 그대로 `.body` 에 둔다 */
async function toApiError(res: Response): Promise<PesApiError> {
  const body: unknown = await res.json().catch(() => null);
  if (isRecord(body) && isRecord(body.error) && typeof body.error.code === "string") return new PesApiError(body as unknown as ApiError);
  return new PesApiError(fallbackBody(res.status));
}

const isNotFound = (e: unknown): boolean => e instanceof PesApiError && e.body.error.code === "not_found";

/**
 * 변경 읽기 — PesClient.getChanges(types.ts, SEL-83 U1c). cursor null = 기준만 받음(`?cursor=head` 한 번, txs 비어 있음), 문자열 = 그 커서 다음 한 쪽.
 * 서버 events 에는 tx_id·stage·round 가 없다: 사건 하나 = tx 하나(tx_id = event_seq), touched 는 사건 type 만으로 정한다('round:*' = 어느 라운드인지 모름).
 */
export type HttpClient = PesClient;

/** 사건 type → 화면이 다시 읽을 자리. 모든 사건은 workspace, project·edition·policy 는 + projects, 라운드에 닿는 사건은 + 'round:*'(어느 라운드인지 events 에 없다) */
function touchedBy(type: string): string[] {
  const touched = ["workspace"];
  if (/^(project\.|edition\.|policy\.changed$)/.test(type)) touched.push("projects");
  if (/^(round|question|answer|result|stage|run|input)\./.test(type)) touched.push("round:*");
  return touched;
}

export function createHttpClient(options: HttpClientOptions): HttpClient {
  const base = options.baseUrl ?? "";
  const send = (url: string, init: RequestInit): Promise<Response> => (options.fetch ?? ((u, i) => globalThis.fetch(u, i)))(url, init);
  /** 쓰기 길의 fetch — 연결이 끊겨 던진 오류는 “요청을 보낸 뒤”로 표시한다(서버가 받았을 수 있다). 오류 객체는 그대로 던진다 */
  const sendWrite = async (url: string, init: RequestInit): Promise<Response> => {
    try {
      return await send(url, init);
    } catch (e) {
      if (!(e instanceof Error && e.name === "TimeoutError")) markAfterSend(e);
      throw e;
    }
  };
  const limit = options.timeoutMs ?? WRITE_TIMEOUT_MS;
  /**
   * 쓰기 길의 요청 하나(응답 본문을 읽기까지)에 시간 제한을 둔다. 넘으면 요청을 중단하고 TimeoutError 로 끝난다 —
   * fetch 가 중단 신호를 무시해도 끝나도록 경주시킨다. 멱등 키는 그대로이므로 화면이 같은 키로 다시 보내면 서버가 재생한다.
   */
  async function timed<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ctl.abort();
        reject(timeoutError("서버 응답이 늦어요."));
      }, limit);
    });
    try {
      return await Promise.race([run(ctl.signal), late]);
    } finally {
      clearTimeout(timer);
    }
  }
  const headers = (extra: Record<string, string> = {}): Record<string, string> => ({ "x-pes-session": options.session, ...extra });
  const projectUrl = (id: string, rest: string): string => `${base}/api/v1/projects/${encodeURIComponent(id)}${rest}`;
  const idOf = (slug: string): string | undefined => (Object.hasOwn(options.projects, slug) ? options.projects[slug] : undefined);

  /** GET P/workspace → data. 서버 404 는 null */
  async function readWorkspace(slug: string): Promise<WorkspaceView | null> {
    const id = idOf(slug);
    if (id === undefined) return null;
    const res = await send(projectUrl(id, "/workspace"), { method: "GET", headers: headers(), credentials: "omit" });
    if (!res.ok) {
      const error = await toApiError(res);
      if (isNotFound(error)) return null;
      throw error;
    }
    const body: unknown = await res.json();
    if (!isRecord(body) || !isRecord(body.data)) throw new PesApiError(fallbackBody(500));
    return body.data as unknown as WorkspaceView;
  }

  async function getWorkspace(slug: string, edition: number): Promise<WorkspaceView | null> {
    const w = await readWorkspace(slug);
    return w && w.edition === edition ? w : null;
  }

  /** 서버(SEL-90 U2a)에 읽을·쓸 길이 없는 것 — 경로를 지어내지 않고 요청 없이 정직하게 거절한다 */
  const notConnected = (what: string) => () => Promise.reject(new NotConnectedError(what));

  const invalid = (target: string, message = "요청 내용이 올바르지 않습니다."): PesApiError =>
    new PesApiError({
      format_version: FORMAT_VERSION,
      error: { code: "invalid_payload", message, retryable: false, target, next_action: "fix_request" },
      request_id: "client",
    });

  /**
   * 쓰기 공통: 멱등 키 확인 → 프로젝트 확인 → POST(시간 제한) → 성공 본문의 `receipt`(SEL-98). 본문에 영수증이 없는 옛 서버만 GET P/requests/{key} 로 읽는다.
   * 순서 규칙(API 결정 4)은 서버가 같은 키로 재생한다
   */
  async function write(slug: string, key: string | undefined, rest: string, body: Json, ready?: (id: string) => Promise<Json | void>, bare = false) {
    if (!key) throw invalid("$.headers.idempotency-key");
    const id = idOf(slug);
    if (id === undefined) throw new PesApiError(fallbackBody(404));
    const extra = (await ready?.(id)) ?? {};
    const { json, requestId } = await timed(async (signal) => {
      const res = await sendWrite(projectUrl(id, rest), {
        method: "POST",
        headers: headers({ "content-type": "application/json", "idempotency-key": key }),
        credentials: "omit",
        // bare: 참고 프로젝트(REF1b) 쓰기는 본문에 보낼 값만 싣는다(서버는 format_version 을 선택으로 받는다)
        body: JSON.stringify(bare ? { ...extra, ...body } : { format_version: FORMAT_VERSION, ...extra, ...body }),
        signal,
      });
      if (!res.ok) throw await toApiError(res);
      const parsed: unknown = await jsonAfterSend(res);
      if (!isRecord(parsed) || !isRecord(parsed.data)) throw new PesApiError(fallbackBody(500));
      return { json: parsed, requestId: typeof parsed.request_id === "string" ? parsed.request_id : "client" };
    });
    const receipt = bodyReceipt(json.receipt, key, json.replayed === true) ?? (await readReceipt(id, key, json.replayed === true));
    return { data: json.data as Json, receipt, request_id: requestId };
  }

  /** 성공 본문의 영수증(서버 SEL-98: 쓰기 201 의 `receipt`) → Receipt. 세 칸이 모두 글일 때만 — 값은 서버 그대로이고 번호를 지어내지 않는다. 재생(replayed)이면 서버가 첫 응답의 영수증을 다시 준다 */
  function bodyReceipt(raw: unknown, key: string, replayed: boolean): Receipt | null {
    if (!isRecord(raw)) return null;
    const { receipt_no, tx_id, committed_at } = raw;
    if (typeof receipt_no !== "string" || !receipt_no || typeof tx_id !== "string" || !tx_id || typeof committed_at !== "string" || Number.isNaN(Date.parse(committed_at))) return null;
    return { receipt_no, tx_id, committed_at, idempotency_key: key, replayed };
  }

  /**
   * (옛 서버 호환) 성공 본문에 영수증이 없으면 쓰기 성공 뒤 GET P/requests/{key} 로 받는다. 번호·시각을 지어내지 않는다:
   *  - receipt_no: 서버 응답에 있을 때만(글 · 숫자). `numbered`(번호를 서버가 줬는가)를 늘 싣는다. 없으면 `numbered: false` + tx_id 를 그대로 둔다(화면은 번호 없이 “접수됨”).
   *  - committed_at: 서버가 시각을 줄 때만 그것을 쓴다. 옛 서버(GET requests/{key})는 시각을 주지 않아, 영수증을 읽은 이 클라이언트의 시각을 쓴다(접수 시각과 몇 초 차이일 수 있다 — 영수증을 싣는 서버(SEL-98)에서는 이 길을 타지 않는다).
   *  - 조회가 실패하면 쓰기는 됐을 수 있으나 영수증을 모른다: 성공으로 보이지 않고 TimeoutError(“접수 확인 중”)로 던진다. 같은 키로 다시 보내면 서버가 재생하고 그때 영수증을 읽는다.
   */
  async function readReceipt(id: string, key: string, replayed: boolean): Promise<Receipt> {
    const unknown = () => timeoutError("접수는 보냈지만 영수증을 아직 읽지 못했어요.");
    let data: Json;
    try {
      data = await timed(async (signal) => {
        const res = await send(projectUrl(id, `/requests/${encodeURIComponent(key)}`), { method: "GET", headers: headers(), credentials: "omit", signal });
        if (!res.ok) throw unknown();
        const json: unknown = await res.json();
        if (!isRecord(json) || !isRecord(json.data)) throw unknown();
        return json.data;
      });
    } catch (e) {
      throw e instanceof Error && e.name === "TimeoutError" ? e : unknown();
    }
    if (typeof data.tx_id !== "string" || !data.tx_id) throw unknown();
    const no = typeof data.receipt_no === "string" && data.receipt_no ? data.receipt_no : typeof data.receipt_no === "number" ? String(data.receipt_no).padStart(4, "0") : "";
    const at = typeof data.committed_at === "string" && !Number.isNaN(Date.parse(data.committed_at)) ? data.committed_at : new Date().toISOString();
    return { receipt_no: no || data.tx_id, numbered: no !== "", tx_id: data.tx_id, committed_at: at, idempotency_key: key, replayed };
  }

  const result = <T,>(w: { data: Json; receipt: Receipt; request_id: string }, data: T): CommandResult<T> => ({ format_version: FORMAT_VERSION, request_id: w.request_id, receipt: w.receipt, data });
  const objectAt = (data: Json, name: string): Json => (isRecord(data[name]) ? data[name] : {});
  const text = (v: unknown): string => (typeof v === "string" ? v : "");

  /**
   * 질문 입력 → 서버 spec. 못 담는 칸은 키를 보내지 않는다.
   * revise(질문 고치기)는 서버가 부분 수정이라 키가 없으면 옛 값이 남는다 — 비운 기본값 · 조건 · 도움말은 명시적 null 로 보내야 지워진다(U2a QuestionSpec).
   */
  function spec(q: QuestionInput, revise = false): Json {
    const choice = q.kind !== "free_text";
    return {
      text: q.text,
      type: q.kind === "single_choice" ? "single" : q.kind === "multi_choice" ? "multi" : "text",
      required: q.required,
      ...(q.importance ? { importance: q.importance } : {}),
      ...(q.default_value !== null && q.default_value !== undefined ? { default_value: q.default_value } : revise ? { default_value: null } : {}),
      // 수정은 부분 수정이라 options 키가 없으면 서버의 옛 선택지가 남는다 — 글로 바꿀 때는 빈 배열을 명시해 지운다(생성은 싣지 않는다)
      ...(choice ? { options: q.options.map((o) => ({ value: o.id, label: o.label })) } : revise ? { options: [] } : {}),
      ...(q.show_if ? { show_if: { id: q.show_if.question_id, in: [q.show_if.equals] } } : revise ? { show_if: null } : {}),
      ...(q.help ? { help: q.help } : revise ? { help: null } : {}),
    };
  }

  const q = (id: string) => encodeURIComponent(id);
  const changeOf = (kind: "withdraw" | "defer" | "merge", slug: string, qid: string, key: string | undefined, body: Json = {}) =>
    write(slug, key, `/questions/${q(qid)}/${kind}`, body).then((w) => {
      const question = objectAt(w.data, "question");
      const base = { question_id: text(question.id), status: text(question.state) };
      return result(w, kind === "merge" ? { ...base, merged_into: text(question.merged_into_question_id) } : base);
    });

  /* ───────────── 가정 · 결정 · 반영 (U3c · SEL-100) — 서버 계약은 SEL-93(U3a)·SEL-100 읽기 칸 보강. 서버가 안 주는 값은 null · "" 로 두고 지어내지 않는다 ───────────── */

  /** GET P/<rest> → data. 모르는 slug 는 요청 없이 null, 서버 404(없는 판 · 라운드)는 null, 그 밖의 거절은 PesApiError */
  async function readData(slug: string, rest: string): Promise<Json | null> {
    const id = idOf(slug);
    if (id === undefined) return null;
    const res = await send(projectUrl(id, rest), { method: "GET", headers: headers(), credentials: "omit" });
    if (!res.ok) {
      const error = await toApiError(res);
      if (isNotFound(error)) return null;
      throw error;
    }
    const body: unknown = await res.json();
    if (!isRecord(body) || !isRecord(body.data)) throw new PesApiError(fallbackBody(500));
    return body.data;
  }
  const listOf = (data: Json | null, name: string): Json[] => {
    if (data === null) return [];
    const rows = data[name];
    if (!Array.isArray(rows)) throw new PesApiError(fallbackBody(500));
    return rows.filter(isRecord);
  };
  const nullable = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
  /** 서버의 행위자 {id, kind, name}. 서버가 주지 않으면(null) id 만 알 때 사람이라고 단정하지 않는다 */
  const actorOf = (v: unknown, fallbackId = ""): Actor => (isRecord(v) ? { id: text(v.id), kind: v.kind === "human" ? "human" : "ai", name: text(v.name) } : { id: fallbackId, kind: "ai", name: "" });
  const actorOrNull = (v: unknown): Actor | null => (isRecord(v) ? actorOf(v) : null);
  const shortId = (id: string): string => (id.length > 12 ? `${id.slice(0, 8)}…` : id);
  /** 버전 id → 앱 안 링크. 서버는 버전이 어느 라운드 글인지 주지 않아 쪽을 지어내지 않고, 기록 화면의 그 버전 자리(해시)로 둔다 */
  const versionLink = (slug: string, edition: number, kind: string, version_id: string): Link => ({
    label: `${kind} ${shortId(version_id)}`,
    href: `/p/${encodeURIComponent(slug)}/e/${edition}/records#version-${encodeURIComponent(version_id)}`,
  });

  function assumptionRow(r: Json): AssumptionRow {
    const revised_version = nullable(r.revised_from_version_id);
    return {
      object_id: text(r.id),
      version_id: text(r.version_id),
      version: Number(r.version_no),
      statement: text(r.statement),
      state: r.state as AssumptionRow["state"],
      proposed_by: actorOf(r.proposed_by, text(r.proposed_by_actor_id)),
      assessed_by: actorOrNull(r.assessed_by),
      assessed_at: nullable(r.assessed_at),
      needs_review: r.needs_review === true,
      rationale: text(r.rationale),
      original: revised_version !== null && typeof r.revised_from_statement === "string" ? { version_id: revised_version, statement: r.revised_from_statement } : null,
      copied_from: null,
      source: null,
    };
  }

  function decisionRows(rows: Json[]): DecisionRow[] {
    const statements = new Map(rows.map((r) => [text(r.id), text(r.statement)]));
    return rows.map((r) => {
      const supersedes_id = nullable(r.supersedes_decision_id);
      const edition_no = typeof r.originated_from_edition_no === "number" ? r.originated_from_edition_no : null;
      const origin_version = nullable(r.originated_from_version_no);
      return {
        object_id: text(r.id),
        version_id: text(r.version_id),
        version: Number(r.version_no),
        statement: text(r.statement),
        state: r.state as DecisionRow["state"],
        scope: r.scope as DecisionRow["scope"],
        proposed_by: actorOf(r.proposed_by),
        decided_by: actorOrNull(r.decided_by),
        rationale: text(r.rationale),
        supersedes: supersedes_id === null ? null : { object_id: supersedes_id, statement: statements.get(supersedes_id) ?? "" },
        superseded_by: nullable(r.superseded_by),
        originated_from: origin_version === null ? null : { label: edition_no === null ? "이전 판에서 복사" : `${edition_no}판에서 복사`, version: Number(origin_version) },
        source: null,
      };
    });
  }

  function reflectionEntry(slug: string, edition: number, r: Json): ReflectionEntry {
    const result = nullable(r.result_version_id);
    const f = isRecord(r.followup) ? r.followup : null;
    const followup_result = f === null ? null : nullable(f.result_version_id);
    return {
      id: text(r.id),
      opinion: text(r.source_text),
      source: versionLink(slug, edition, "원문 버전", text(r.source_version_id)),
      disposition: r.disposition as ReflectionEntry["disposition"],
      rationale: text(r.rationale),
      actor: actorOrNull(r.actor),
      applied_tx_id: nullable(r.applied_tx_id),
      result_version: result === null ? null : versionLink(slug, edition, "결과 버전", result),
      followup:
        f === null
          ? null
          : { id: text(f.id), kind: f.kind as FollowupView["kind"], state: f.state as FollowupView["state"], label: text(f.description), result_version: followup_result === null ? null : versionLink(slug, edition, "후속 결과 버전", followup_result) },
    };
  }

  /** 결정 쓰기의 사전 읽기 — 서버 쓰기 본문에 scope 가 필요하고 앱은 행에서 scope 를 받아 둔 적이 없어서, 그 판의 결정 목록에서 그 결정을 찾는다. 없으면 POST 없이 not_found */
  const decisionScope = (edition: number, decision_id: string) => async (id: string): Promise<Json> => {
    const data = await timed(async (signal) => {
      const res = await send(projectUrl(id, `/decisions?edition=${edition}`), { method: "GET", headers: headers(), credentials: "omit", signal });
      if (!res.ok) throw await toApiError(res);
      const body: unknown = await res.json();
      if (!isRecord(body) || !isRecord(body.data)) throw new PesApiError(fallbackBody(500));
      return body.data;
    });
    const found = listOf(data, "decisions").find((r) => r.id === decision_id);
    if (!found || (found.scope !== "project" && found.scope !== "edition")) throw new PesApiError(fallbackBody(404));
    return { scope: found.scope };
  };
  const judged = (w: { data: Json; receipt: Receipt; request_id: string }, name: "assumption" | "decision") => {
    const row = objectAt(w.data, name);
    return result(w, { object_id: text(row.id), version_id: text(row.version_id) });
  };
  const given = (v: string): Json => (v ? { rationale: v } : {});


  /* ───────────── 내 자료 (MAT1c · SEL-117) — 서버 계약은 SEL-115(MAT1a). 서버가 안 주는 값(ai_access · 추출 상태)은 null 로 두고 지어내지 않는다 ───────────── */

  const aiAccessOf = (v: unknown): AiAccess | null => (v === "allow" || v === "deny" ? v : null);
  /** 서버가 숫자를 주지 않으면 null — NaN 을 지어내지 않는다 */
  const numOf = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
  const hex = (buf: ArrayBuffer): string => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

  function materialRow(r: Json): MaterialRow {
    return {
      object_id: text(r.object_id),
      version_id: text(r.version_id),
      version: Number(r.version_no),
      blob_id: text(r.blob_id),
      file_policy_id: text(r.file_policy_id),
      role: text(r.role),
      title: text(r.title),
      original_name: text(r.original_name),
      media_type: text(r.media_type),
      size: Number(r.size),
      sha256: text(r.sha256),
      ai_access: aiAccessOf(r.ai_access),
      extraction: null,
    };
  }

  /**
   * 쓰기 길의 한 단계(예약 · 올리기 · 완료) — 시간 제한 안에서 보내고, 거절은 서버 봉투 그대로 던진다.
   * 서버는 예약(POST P/uploads)과 완료(POST P/uploads/{blob}/complete)에도 멱등 키를 요구한다(없으면 400) — `key` 로 보낸다. 올리기(PUT)는 키가 없다.
   */
  async function uploadStep(id: string, method: "POST" | "PUT", rest: string, init: { json?: Json; body?: Uint8Array; contentType?: string; key?: string }): Promise<{ data: Json; replayed: boolean }> {
    return timed(async (signal) => {
      const res = await sendWrite(projectUrl(id, rest), {
        method,
        headers: headers({ "content-type": init.contentType ?? "application/json", ...(init.key ? { "idempotency-key": init.key } : {}) }),
        credentials: "omit",
        body: init.body ? (init.body as BodyInit) : JSON.stringify(init.json ?? {}),
        signal,
      });
      if (!res.ok) throw await toApiError(res);
      const parsed: unknown = await jsonAfterSend(res);
      if (!isRecord(parsed) || !isRecord(parsed.data)) throw new PesApiError(fallbackBody(500));
      return { data: parsed.data, replayed: parsed.replayed === true };
    });
  }

  /**
   * 파일 바이트를 서버에 올려 ready 인 blob 을 만든다: 예약(지문 · 크기) → (ready 가 아니면) PUT → 완료. 같은 바이트가 이미 ready 면 올리기를 건너뛴다.
   * 예약 · 완료의 멱등 키는 자료 등록 키(`key`)에서 이어 만든다 — 서버는 한 키를 다른 명령에 다시 쓰면 409 로 거절하므로 명령마다 달라야 하고,
   * 같은 `key` 로 다시 올리면 같은 키가 나가 단계를 서버가 재생한다(응답 유실 뒤 다시 보내도 중복이 없다).
   * 재생된 예약 응답(`replayed`)의 state 는 처음 예약 때의 것이라 지금 blob 상태가 아닐 수 있다 — 이미 올리거나 완료한 blob 이면 서버는 PUT 을 409(ready blob 은 불변)로 막는다.
   * 그때는 올릴 것이 없다는 뜻이므로 PUT 만 건너뛰고 완료(같은 키 → 서버가 재생하거나 처음 실행)로 이어 간다. 바이트가 아직 없으면 PUT 이 되므로 건너뛰지 않는다.
   */
  const stageBlob = (file: File, key: string) => async (id: string): Promise<Json> => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const sha256 = hex(await globalThis.crypto.subtle.digest("SHA-256", bytes));
    const media_type = file.type || "application/octet-stream";
    const { data: reserved, replayed } = await uploadStep(id, "POST", "/uploads", { json: { sha256, size: bytes.byteLength, media_type, original_name: file.name }, key: `${key}:upload-reserve` });
    const blob_id = text(reserved.blob_id);
    if (!blob_id) throw new PesApiError(fallbackBody(500));
    if (reserved.state !== "ready") {
      try {
        await uploadStep(id, "PUT", `/uploads/${q(blob_id)}`, { body: bytes, contentType: media_type });
      } catch (e) {
        // 재생된 예약만: 옛 staging 을 보고 이미 끝난 blob 에 다시 올리려 한 409 는 “이미 올렸다”로 보고 완료로 이어 간다
        if (!(replayed && e instanceof PesApiError && e.body.error.code === "conflict")) throw e;
      }
      await uploadStep(id, "POST", `/uploads/${q(blob_id)}/complete`, { key: `${key}:upload-complete` });
    }
    return { blob_id };
  };

  /** 라운드 자리 글: "start"(단계 시작 질문) 또는 1 이상의 번호(10진). 그 밖은 자리가 아니다(null) — 요청 없이 없는 자리로 본다 */
  function placeOf(round: string): { round_id: number | null } | null {
    if (round === "start") return { round_id: null };
    return /^[1-9]\d*$/.test(round) ? { round_id: Number(round) } : null;
  }
  const roundPath = (stage: string, round: string): string => `/stages/${encodeURIComponent(stage)}/rounds/${encodeURIComponent(round)}`;

  /**
   * 라운드·의견 읽기는 서버의 활성 판 자료다. 응답이 판 번호(`data.edition`)를 싣고 그것이 앱이 보는 판(`edition`)과 다르면 그 자료를 쓰지 않는다(null) —
   * 옛 판 화면에 새 판의 질문을 얹거나, 그 세트·라운드 id 로 새 판에 쓰는 일을 막는다. 판 번호를 싣지 않은 응답은 확인할 수 없어 그대로 둔다.
   */
  const sameEdition = (data: Json, edition: number): boolean => typeof data.edition !== "number" || data.edition === edition;

  /** GET P/stages/{stage}/rounds/{round} → data. 서버 404 와 다른 판의 자료는 null, 그 밖의 거절은 PesApiError */
  async function readRound(id: string, stage: string, round: string, edition: number, signal?: AbortSignal): Promise<Json | null> {
    const res = await send(projectUrl(id, roundPath(stage, round)), { method: "GET", headers: headers(), credentials: "omit", ...(signal ? { signal } : {}) });
    if (!res.ok) {
      const error = await toApiError(res);
      if (isNotFound(error)) return null;
      throw error;
    }
    const body: unknown = await res.json();
    if (!isRecord(body) || !isRecord(body.data)) throw new PesApiError(fallbackBody(500));
    return sameEdition(body.data, edition) ? body.data : null;
  }

  /** 순서 바꾸기를 같은 멱등 키로 다시 보낼 때 같은 폼 세트 id 로 보내려고 처음 알아낸 값을 둔다(이 클라이언트의 수명 동안) */
  const orderSets = new Map<string, string>();

  /** 서버 답 값 → 화면 글: 선택지는 label(여럿은 ", "), 글은 그대로 */
  function answerText(value: unknown, options: { id: string; label: string }[]): string {
    const label = (v: unknown): string => options.find((o) => o.id === v)?.label ?? String(v);
    if (Array.isArray(value)) return value.map(label).join(", ");
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? label(value) : "";
  }

  /** 서버 질문 한 줄 → QuestionView. 서버가 주지 않은(null) 칸은 키를 두지 않는다 */
  function questionViewOf(raw: Json): QuestionView | null {
    if (typeof raw.id !== "string" || typeof raw.version_id !== "string") return null;
    const kind: QuestionKind = raw.type === "single" ? "single_choice" : raw.type === "multi" ? "multi_choice" : "free_text";
    const rawOptions = Array.isArray(raw.options) ? raw.options : [];
    const options = kind === "free_text" ? [] : rawOptions.flatMap((o) => (isRecord(o) && typeof o.value === "string" ? [{ id: o.value, label: typeof o.label === "string" ? o.label : o.value }] : []));
    const status: QuestionStatus = raw.state === "withdrawn" || raw.state === "deferred" || raw.state === "merged" ? raw.state : "open";
    const showIf = isRecord(raw.show_if) && typeof raw.show_if.id === "string" && Array.isArray(raw.show_if.in) && typeof raw.show_if.in[0] === "string" ? { question_id: raw.show_if.id, equals: raw.show_if.in[0] } : null;
    const view: QuestionView = {
      id: raw.id,
      number: Number(raw.display_no),
      version: Number(raw.version_no),
      version_id: raw.version_id,
      required: raw.required === true,
      source: "ai",
      text: text(raw.text),
      kind,
      ...(kind === "free_text" ? {} : { options }),
      default_value: typeof raw.default_value === "string" ? raw.default_value : null,
      show_if: showIf,
      direction: "ask_human",
      status,
      allow_comment_as_answer: raw.allow_comment_as_answer === true,
    };
    if (raw.importance === "high" || raw.importance === "normal" || raw.importance === "low") view.importance = raw.importance;
    if (typeof raw.help === "string" && raw.help) view.help = raw.help;
    if (status === "merged" && typeof raw.merged_into_question_id === "string") view.merged_into = raw.merged_into_question_id;
    const a = raw.answer;
    // 보낸 답: 값이 있는 제출된 답만(의견만 낸 답은 의견 목록에 있다 — 여기서 글을 지어내지 않는다)
    if (isRecord(a) && a.state === "submitted" && a.value !== null && a.value !== undefined) {
      const answer = answerText(a.value, options);
      const receipt_no = text(a.receipt_no);
      const committed_at = text(a.committed_at);
      if (a.question_version_id === raw.version_id) {
        view.sent = { answer, receipt_no, tx_id: text(a.tx_id), committed_at };
        view.used_default = a.used_default === true;
      } else {
        view.needs_recheck = true;
        view.previous_answer = { answer, ...(typeof a.question_version === "number" ? { version: a.question_version } : {}), receipt_no, committed_at };
      }
    }
    return view;
  }

  function roundViewOf(data: Json, stage: string): RoundView {
    const questions = (Array.isArray(data.questions) ? data.questions : []).flatMap((raw) => {
      const view = isRecord(raw) ? questionViewOf(raw) : null;
      return view ? [view] : [];
    });
    return {
      stage: stage as RoundView["stage"],
      round_id: typeof data.round_id === "number" ? data.round_id : null,
      state: data.state === "closed" ? "closed" : "current",
      form_version: typeof data.form_version === "number" ? data.form_version : 0,
      ...(typeof data.set_id === "string" && data.set_id ? { set_id: data.set_id } : {}),
      questions,
      result: null,
      alerts: [],
      prompt: "",
    };
  }


  /* ───────────── 이전 프로젝트 참고자료(REF1b · SEL-114) — 서버 계약은 SEL-113(REF1a). 서버가 안 주는 칸은 null 로 두고 지어내지 않는다 ───────────── */

  const boolOrNull = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
  /** rev 는 서버의 10진 문자열 그대로(다시 고정의 base_rev) — 숫자로 와도 글자로만 옮긴다 */
  const revOf = (v: unknown): string | null => (typeof v === "string" && v ? v : typeof v === "number" && Number.isSafeInteger(v) ? String(v) : null);

  function referenceRow(r: Json): ReferenceRow {
    const delivery = r.ai_delivery;
    return {
      id: text(r.id),
      access: r.access === "no_permission" ? "no_permission" : "ok",
      state: text(r.state) as ReferenceRow["state"],
      referenced_project_id: nullable(r.referenced_project_id),
      referenced_project_key: nullable(r.referenced_project_key),
      source_label: nullable(r.source_label),
      source_snapshot_id: nullable(r.source_snapshot_id),
      source_snapshot_key: nullable(r.source_snapshot_key),
      latest_snapshot_id: nullable(r.latest_snapshot_id),
      new_version_available: boolOrNull(r.new_version_available),
      scope: Array.isArray(r.scope) ? r.scope.filter((x): x is string => typeof x === "string") : null,
      // ai_delivery 가 없으면 null — 허용으로 간주하지 않는다
      ai_delivery: isRecord(delivery) && typeof delivery.allowed === "boolean" ? { allowed: delivery.allowed, withheld_reason: nullable(delivery.withheld_reason) } : null,
      attached_at: nullable(r.attached_at),
      refreshed_at: nullable(r.refreshed_at),
      rev: revOf(r.rev),
    };
  }

  function referenceItem(raw: Json): ReferenceContentItem[] {
    if ((raw.item !== "final_report" && raw.item !== "sources") || typeof raw.title !== "string") return [];
    const c = isRecord(raw.citation) ? raw.citation : {};
    const citation: ReferenceCitation = { reference_id: text(c.reference_id), project_id: text(c.project_id), project_label: text(c.project_label), snapshot_id: text(c.snapshot_id), object_id: text(c.object_id), version_id: text(c.version_id) };
    return [
      {
        item: raw.item,
        object_id: text(raw.object_id),
        version_id: text(raw.version_id),
        kind: text(raw.kind),
        title: raw.title,
        summary: nullable(raw.summary),
        body_md: nullable(raw.body_md),
        url: nullable(raw.url),
        quote: nullable(raw.quote),
        citation,
      },
    ];
  }

  const refPath = (ref: string, tail = ""): string => `/references/${q(ref)}${tail}`;
  const referenceOf = (data: Json): ReferenceRow => {
    if (!isRecord(data.reference)) throw new PesApiError(fallbackBody(500));
    return referenceRow(data.reference);
  };

  const references: ReferencesMethods = {
    /** GET P/references — 모르는 slug · 서버 404 는 []. 401 · 403 은 PesApiError(빈 목록으로 삼키지 않는다) */
    async getReferences(slug) {
      return listOf(await readData(slug, "/references"), "references").map(referenceRow);
    },
    /** GET P/references/{ref} — 404 · 모르는 slug 는 null. content 가 null(원본 없음 · 접근 없음)이면 null 그대로 */
    async getReference(slug, _edition, refId) {
      const data = await readData(slug, refPath(refId));
      if (data === null) return null;
      const content: ReferenceContent | null = isRecord(data.content) ? { items: (Array.isArray(data.content.items) ? data.content.items : []).flatMap((i) => (isRecord(i) ? referenceItem(i) : [])) } : null;
      return { reference: referenceOf(data), content };
    },
    /** 서버에 후보 프로젝트 · 스냅숏을 읽는 길이 없다(후속 SEL-120) — 후보를 지어내지 않고 요청 없이 거절한다. 생성 화면(null)도 작업 중도 같다 */
    getReferenceCandidates: notConnected("참고 프로젝트 후보 읽기"),
    async attachReference(slug, _edition, input, key) {
      const body: Json = {
        referenced_project_id: input.referenced_project_id,
        source_snapshot_id: input.source_snapshot_id,
        // 줄 때만 싣는다 — 안 주면 서버 기본 범위 · 원본 이름을 덮어쓰지 않는다
        ...(input.scope !== undefined ? { scope: input.scope } : {}),
        ...(input.source_label ? { source_label: input.source_label } : {}),
      };
      const w = await write(slug, key, "/references", body, undefined, true);
      return result(w, { reference: referenceOf(w.data) });
    },
    async refreshReference(slug, _edition, refId, input, key) {
      const body: Json = { ...(input.source_snapshot_id !== undefined ? { source_snapshot_id: input.source_snapshot_id } : {}), ...(input.base_rev !== undefined ? { base_rev: input.base_rev } : {}) };
      const w = await write(slug, key, refPath(refId, "/refresh"), body, undefined, true);
      return result(w, { reference: referenceOf(w.data) });
    },
    async detachReference(slug, _edition, refId, key) {
      const w = await write(slug, key, refPath(refId, "/detach"), {}, undefined, true);
      return result(w, { reference_id: text(w.data.reference_id), detached: true as const });
    },
  };

  return {
    ...references,
    capabilities: { questionTools: true },
    async getAssumptions(slug, edition) {
      return listOf(await readData(slug, `/assumptions?edition=${edition}`), "assumptions").map(assumptionRow);
    },
    async getDecisions(slug, edition) {
      return decisionRows(listOf(await readData(slug, `/decisions?edition=${edition}`), "decisions"));
    },
    async getReflections(slug, edition, stage, round) {
      // 'start'(단계 시작)에는 라운드가 없어 반영도 없다 — 서버에 묻지 않는다
      if (!/^[1-9]\d*$/.test(round)) return null;
      const data = await readData(slug, `/reflections?edition=${edition}&stage=${encodeURIComponent(stage)}&round_no=${round}`);
      if (data === null) return null;
      const entries = listOf(data, "entries").map((r) => reflectionEntry(slug, edition, r));
      return { submission: data.submitted === true ? "submitted" : "none", sent_count: null, entries };
    },
    async assessAssumption(slug, _edition, objectId, input, key) {
      const state = input.verdict === "confirm" ? "confirmed" : input.verdict === "reject" ? "rejected" : "revised";
      const w = await write(slug, key, "/assumptions", {
        assumption_id: objectId,
        base_version_id: input.base_version_id,
        state,
        ...given(input.rationale),
        ...(input.verdict === "revise" && input.statement !== undefined ? { statement: input.statement } : {}),
      });
      return judged(w, "assumption");
    },
    async adoptDecision(slug, edition, objectId, input, key) {
      const w = await write(slug, key, "/decisions", { state: "adopted", decision_id: objectId, base_version_id: input.base_version_id, ...given(input.rationale) }, decisionScope(edition, objectId));
      return judged(w, "decision");
    },
    async supersedeDecision(slug, edition, objectId, input, key) {
      const w = await write(slug, key, "/decisions", { state: "adopted", supersedes: objectId, base_version_id: input.base_version_id, statement: input.statement, rationale: input.rationale }, decisionScope(edition, objectId));
      return judged(w, "decision");
    },
    async revokeDecision(slug, edition, objectId, input, key) {
      const w = await write(slug, key, "/decisions", { state: "revoked", decision_id: objectId, base_version_id: input.base_version_id, rationale: input.rationale }, decisionScope(edition, objectId));
      return judged(w, "decision");
    },
    async getMaterials(slug, _edition) {
      return listOf(await readData(slug, "/materials"), "materials").map(materialRow);
    },

    async uploadMaterial(slug, _edition, input, key) {
      const w = await write(slug, key, "/materials", { ...(input.title ? { title: input.title } : {}), ...(input.object_id ? { object_id: input.object_id } : {}) }, stageBlob(input.file, key ?? ""));
      const d = w.data;
      return result(w, {
        object_id: text(d.object_id),
        version_id: text(d.version_id),
        version: numOf(d.version_no),
        blob_id: text(d.blob_id),
        file_policy_id: text(d.file_policy_id),
        role: text(d.role),
        ai_access: aiAccessOf(d.ai_access),
        original_name: text(d.original_name),
        media_type: text(d.media_type),
        size: numOf(d.size),
        sha256: text(d.sha256),
      });
    },

    async setMaterialAiAccess(slug, _edition, filePolicyId, input, key) {
      const w = await write(slug, key, `/file-policies/${q(filePolicyId)}/ai-access`, { ai_access: input.ai_access, ...(input.reason ? { reason: input.reason } : {}) });
      const d = w.data;
      return result(w, { file_policy_id: text(d.file_policy_id), blob_id: text(d.blob_id), ai_access: aiAccessOf(d.ai_access), rev: numOf(d.rev), changed: d.changed === true });
    },

    /** GET P/files/{blob}/preview — 세션 헤더가 필요해 주소 링크로는 열 수 없다. 바이트를 그대로 읽어(글로 바꾸지 않음) 화면이 형식에 맞게 그린다. 모르면 inline 으로 간주하지 않는다 */
    async getMaterialPreview(slug, _edition, blobId) {
      const id = idOf(slug);
      if (id === undefined) throw new PesApiError(fallbackBody(404));
      return timed(async (signal) => {
        const res = await send(projectUrl(id, `/files/${q(blobId)}/preview`), { method: "GET", headers: headers(), credentials: "omit", signal });
        if (!res.ok) throw await toApiError(res);
        const bytes = new Uint8Array(await res.arrayBuffer());
        return {
          blob_id: blobId,
          content_type: res.headers.get("content-type") ?? "",
          inline: /^\s*inline\b/i.test(res.headers.get("content-disposition") ?? ""),
          sandbox: res.headers.get("content-security-policy"),
          bytes,
        };
      });
    },

    getQuestionVersions: notConnected("질문 버전 기록 읽기"),

    /** GET P/stages/{stage}/rounds/{round}/threads — 의견 목록. 라운드를 못 찾으면(404) 빈 목록, 그 밖의 거절은 PesApiError */
    async getComments(slug, edition, stage, round) {
      const id = idOf(slug);
      if (id === undefined || !placeOf(round)) return [];
      const res = await send(projectUrl(id, `${roundPath(stage, round)}/threads`), { method: "GET", headers: headers(), credentials: "omit" });
      if (!res.ok) {
        const error = await toApiError(res);
        if (isNotFound(error)) return [];
        throw error;
      }
      const body: unknown = await res.json();
      const data = isRecord(body) && isRecord(body.data) ? body.data : null;
      const threads = data !== null && Array.isArray(data.threads) ? data.threads : null;
      if (data === null || threads === null) throw new PesApiError(fallbackBody(500));
      if (!sameEdition(data, edition)) return [];
      return threads.flatMap((t): CommentThreadView[] => {
        if (!isRecord(t) || typeof t.thread_id !== "string" || typeof t.question_id !== "string") return [];
        const messages = (Array.isArray(t.messages) ? t.messages : []).flatMap((m): CommentMessageView[] =>
          isRecord(m) && typeof m.message_id === "string" && typeof m.body_md === "string"
            ? [{ message_id: m.message_id, body_md: m.body_md, at: text(m.at), by: m.by === "ai" ? "ai" : "human", ...(typeof m.receipt_no === "string" ? { receipt_no: m.receipt_no } : {}) }]
            : [],
        );
        return [{ thread_id: t.thread_id, question_id: t.question_id, ...(typeof t.question_version === "number" ? { question_version: t.question_version } : {}), messages }];
      });
    },

    /**
     * 순서 바꾸기: 라운드 읽기로 폼 세트 id 를 알고 POST P/question-sets/{set_id}/order. 같은 멱등 키의 다시 보내기는 처음 알아낸 세트 id 를 그대로 쓴다 —
     * 그 사이 서버 폼이 새 세트로 바뀌었어도(첫 요청이 닿았는데 답을 못 받은 경우) 요청 내용이 같아야 서버가 재생한다(내용이 다르면 409 idempotency_key_reuse).
     */
    async reorderQuestions(slug, edition, stage, round, orderedIds, key) {
      if (!key) throw invalid("$.headers.idempotency-key");
      const id = idOf(slug);
      if (id === undefined) throw new PesApiError(fallbackBody(404));
      const memo = `${slug}\u0000${stage}\u0000${round}\u0000${key}`;
      let setId = orderSets.get(memo);
      if (setId === undefined) {
        const data = await timed((signal) => readRound(id, stage, round, edition, signal));
        if (data === null) throw new PesApiError(fallbackBody(404));
        if (typeof data.set_id !== "string" || !data.set_id) throw invalid("$.set_id", "서버 폼 세트를 알 수 없어 순서를 바꿀 수 없습니다.");
        setId = data.set_id;
        orderSets.set(memo, setId);
      }
      // 서버가 확정적으로 거절했으면(409 stale_set · 422 · 404 …) 요청이 닿지 않은 것이 분명하다 — 메모를 지워, 같은 키로 다시 눌러도 세트 id 를 새로 읽는다.
      // 시간 초과·끊김(확인 중)은 요청이 닿았을 수 있으니 메모를 남겨 같은 세트 id 로 재시도한다
      const w = await write(slug, key, `/question-sets/${q(setId)}/order`, { question_ids: orderedIds }).catch((error: unknown) => {
        if (error instanceof PesApiError) orderSets.delete(memo);
        throw error;
      });
      const set = objectAt(w.data, "set");
      return result(w, { form_version: Number(set.version_no) });
    },

    async addQuestion(slug, edition, stage, round, body, key) {
      if (!key) throw invalid("$.headers.idempotency-key");
      if (idOf(slug) === undefined) throw new PesApiError(fallbackBody(404));
      if (body.direction === "ask_ai") throw new NotConnectedError("사람이 AI에게 묻는 질문 더하기");
      if (!placeOf(round)) throw new PesApiError(fallbackBody(404));
      const w = await write(slug, key, "/questions", { purpose: round === "start" ? "stage_start" : "review", form_key: "main", direction: "agent_to_human", question: spec(body) }, async (id) => {
        // 번호 라운드는 라운드 읽기의 server_round_id 를 round_id 로 보낸다(없으면 쓰기 0 으로 거절 — 지어내지 않는다). start 는 단계 시작 자리(round_id null)
        let round_id: string | null = null;
        if (round !== "start") {
          const data = await timed((signal) => readRound(id, stage, round, edition, signal));
          if (data === null || typeof data.server_round_id !== "string" || !data.server_round_id) throw new PesApiError(fallbackBody(404));
          round_id = data.server_round_id;
        }
        const json = await timed(async (signal) => {
          const res = await send(projectUrl(id, "/context"), { method: "GET", headers: headers(), credentials: "omit", signal });
          if (!res.ok) throw await toApiError(res);
          return (await res.json()) as unknown;
        });
        const stages = isRecord(json) && isRecord(json.data) && Array.isArray(json.data.stages) ? json.data.stages : [];
        const found = stages.find((s) => isRecord(s) && s.key === stage);
        if (!isRecord(found) || typeof found.stage_id !== "string") throw new PesApiError({ ...fallbackBody(404) });
        return { stage_id: found.stage_id, round_id };
      });
      const question = objectAt(w.data, "question");
      return result(w, { question_id: text(question.id), version: Number(question.version_no) });
    },

    async reviseQuestion(slug, _edition, qid, body, key) {
      if (!key) throw invalid("$.headers.idempotency-key");
      if (!body.base_version_id) throw invalid("$.base_version_id", "질문의 서버 버전을 알 수 없어 고칠 수 없습니다.");
      // 서버 수정 본문(U2a QuestionReviseBody)에는 방향도 중요도 지우기도 실을 길이 없다 — 조용히 빼고 성공시키지 않고 요청 없이 거절한다
      if (body.direction === "ask_ai") throw new NotConnectedError("사람이 AI에게 묻는 질문 고치기");
      if (body.importance === null) throw new NotConnectedError("질문 중요도 지우기");
      const w = await write(slug, key, `/questions/${q(qid)}/revisions`, { base_version_id: body.base_version_id, question: spec(body, true) });
      const question = objectAt(w.data, "question");
      return result(w, { question_id: text(question.id), version: Number(question.version_no), needs_recheck: w.data.recheck_required === true });
    },

    withdrawQuestion: (slug, _edition, qid, key) => changeOf("withdraw", slug, qid, key) as ReturnType<PesClient["withdrawQuestion"]>,
    deferQuestion: (slug, _edition, qid, key) => changeOf("defer", slug, qid, key) as ReturnType<PesClient["deferQuestion"]>,
    mergeQuestion: (slug, _edition, qid, into, key) => changeOf("merge", slug, qid, key, { merged_into_question_id: into }) as ReturnType<PesClient["mergeQuestion"]>,

    /** POST P/submissions — 서버 폼 세트 id(set_id)가 없으면 지어내지 않고 거절한다. 앱 쪽 값(question_version 숫자 · form_version)은 보내지 않는다 */
    async submitAnswers(slug, _edition, _stage, _round, input, key) {
      if (!key) throw invalid("$.headers.idempotency-key");
      if (!input.set_id) throw invalid("$.set_id", "서버 폼 세트를 알 수 없어 답을 보낼 수 없습니다.");
      const answers = input.answers.map((a) => ({
        question_id: a.question_id,
        ...(a.question_version_id ? { question_version_id: a.question_version_id } : {}),
        ...(a.value !== null && a.value !== undefined ? { value: a.value } : {}),
        ...(a.comment ? { comment: a.comment } : {}),
        ...(a.used_default !== undefined ? { used_default: a.used_default } : {}),
      }));
      const w = await write(slug, key, "/submissions", { set_id: input.set_id, mode: input.mode, answers });
      const submission = objectAt(w.data, "submission");
      const rows = Array.isArray(w.data.answers) ? w.data.answers : [];
      return result(w, {
        submission_id: text(submission.id),
        answers: rows.flatMap((r) => (isRecord(r) && typeof r.question_id === "string" ? [{ question_id: r.question_id, state: "submitted" as const }] : [])),
        form_complete: w.data.form_complete === true,
        missing_required: Array.isArray(w.data.missing_required) ? w.data.missing_required.filter((x): x is string => typeof x === "string") : [],
      });
    },

    /** 질문별 의견 — 의견은 답이 아니다: submissions 로 가지 않고 항상 question_comment 스레드로 간다 */
    async addComment(slug, _edition, qid, input, key) {
      if (!key) throw invalid("$.headers.idempotency-key");
      if (!input.body_md.trim()) throw invalid("$.body_md", "의견이 비었습니다.");
      if (input.thread_id) {
        const w = await write(slug, key, `/threads/${q(input.thread_id)}/messages`, { body_md: input.body_md });
        return result(w, { thread_id: input.thread_id, message_id: text(objectAt(w.data, "message").id), thread_created: false });
      }
      const w = await write(slug, key, "/threads", {
        target_object_id: qid,
        ...(input.question_version_id ? { target_version_id: input.question_version_id } : {}),
        context_kind: "question_comment",
        initial_message: { body_md: input.body_md },
      });
      return result(w, { thread_id: text(objectAt(w.data, "thread").id), message_id: text(objectAt(w.data, "message").id), thread_created: true });
    },

    /** GET P/changes — 한 번만 부른다(has_more 여도 한 쪽). 400 cursor_invalid · 410 cursor_expired 는 PesApiError 로 나온다 */
    async getChanges(slug, _edition, cursor): Promise<ChangesRead> {
      const id = idOf(slug);
      if (id === undefined) throw new PesApiError(fallbackBody(404));
      const res = await send(projectUrl(id, `/changes?cursor=${encodeURIComponent(cursor ?? "head")}`), { method: "GET", headers: headers(), credentials: "omit" });
      if (!res.ok) throw await toApiError(res);
      const body: unknown = await res.json();
      const data = isRecord(body) ? body.data : undefined;
      if (!isRecord(data) || !Array.isArray(data.events) || typeof data.next_cursor !== "string") throw new PesApiError(fallbackBody(500));
      if (cursor === null) return { cursor: data.next_cursor, txs: [] };
      const txs = data.events.flatMap((event): ChangeTx[] =>
        isRecord(event) && typeof event.event_seq === "string" && typeof event.type === "string" ? [{ tx_id: event.event_seq, touched: touchedBy(event.type) }] : [],
      );
      return { cursor: data.next_cursor, txs };
    },

    async listProjects(): Promise<ProjectRef[]> {
      const found = await Promise.all(Object.keys(options.projects).map((slug) => readWorkspace(slug)));
      return found.flatMap((w) => (w ? [{ slug: w.slug, edition: w.edition, current: w.current }] : []));
    },

    getWorkspace,

    /**
     * GET P/stages/{stage}/rounds/{start|번호} (SEL-98) — 폼 세트 id · 질문(서버 버전 id 포함) · 현재 답까지 한 번에 읽는다.
     * 그 경로가 404 이면(라운드 읽기가 없는 옛 서버, 또는 그 자리가 없음) 작업 공간 읽기로 폴백한다: 작업 공간에 자리가 있을 때만 질문 없는 빈 뷰, 없으면 null(지어내지 않음).
     * 라운드 경로는 서버의 활성 판을 읽는다 — 응답의 판 번호가 앱이 보는 판과 다르면 그 자료를 쓰지 않고 null 이다(작업 공간 폴백도 판이 다르면 null).
     */
    async getRound(slug, edition, stage, round) {
      const id = idOf(slug);
      const place = placeOf(round);
      if (id === undefined || !place) return null;
      const data = await readRound(id, stage, round, edition);
      if (data !== null) return roundViewOf(data, stage);
      const w = await getWorkspace(slug, edition);
      if (!w) return null;
      const roundId = place.round_id;
      const found = w.stages.find((s) => s.key === stage)?.rounds.find((r) => r.round_id === roundId);
      if (!found) return null;
      const view: RoundView = { stage: stage as RoundView["stage"], round_id: roundId, state: found.state, form_version: 0, questions: [], result: null, alerts: [], prompt: "" };
      return view;
    },

    async acknowledgeAlert(slug, edition, alertId, idempotencyKey) {
      // 순서(API 결정 4): 요청 검사 → (서버가) 영수증 재생 → 대상 검사 · 변경
      if (!idempotencyKey) {
        throw new PesApiError({
          format_version: FORMAT_VERSION,
          error: { code: "invalid_payload", message: "요청 내용이 올바르지 않습니다.", retryable: false, target: "$.headers.idempotency-key", next_action: "fix_request" },
          request_id: "client",
        });
      }
      const id = idOf(slug);
      if (id === undefined) throw new PesApiError({ ...fallbackBody(404) });
      // 경로 이름은 계획에 아직 없다(types.ts COMMANDS "alert.acknowledge" 미정) — 서버가 이 경로를 열 때까지는 서버의 404 not_found 가 PesApiError 로 나온다
      const res = await send(projectUrl(id, `/alerts/${encodeURIComponent(alertId)}/acknowledgements`), {
        method: "POST",
        headers: headers({ "content-type": "application/json", "idempotency-key": idempotencyKey }),
        credentials: "omit",
        body: JSON.stringify({ edition, alert_id: alertId }),
      });
      if (!res.ok) throw await toApiError(res);
      return (await res.json()) as CommandResult<{ alert_id: string }>;
    },
  };
}
