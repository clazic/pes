import { FORMAT_VERSION, NotConnectedError, PesApiError, type ApiError, type ChangesRead, type ChangeTx, type CommandResult, type PesClient, type ProjectRef, type QuestionInput, type Receipt, type RoundView, type WorkspaceView } from "./types";

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

  /** 쓰기 공통: 멱등 키 확인 → 프로젝트 확인 → POST(시간 제한) → (성공 뒤) GET P/requests/{key} 로 영수증. 순서 규칙(API 결정 4)은 서버가 같은 키로 재생한다 */
  async function write(slug: string, key: string | undefined, rest: string, body: Json, ready?: (id: string) => Promise<Json | void>) {
    if (!key) throw invalid("$.headers.idempotency-key");
    const id = idOf(slug);
    if (id === undefined) throw new PesApiError(fallbackBody(404));
    const extra = (await ready?.(id)) ?? {};
    const { json, requestId } = await timed(async (signal) => {
      const res = await send(projectUrl(id, rest), {
        method: "POST",
        headers: headers({ "content-type": "application/json", "idempotency-key": key }),
        credentials: "omit",
        body: JSON.stringify({ format_version: FORMAT_VERSION, ...extra, ...body }),
        signal,
      });
      if (!res.ok) throw await toApiError(res);
      const parsed: unknown = await res.json();
      if (!isRecord(parsed) || !isRecord(parsed.data)) throw new PesApiError(fallbackBody(500));
      return { json: parsed, requestId: typeof parsed.request_id === "string" ? parsed.request_id : "client" };
    });
    const receipt = await readReceipt(id, key, json.replayed === true);
    return { data: json.data as Json, receipt, request_id: requestId };
  }

  /**
   * 서버 본문에는 영수증이 없다 — 쓰기 성공 뒤 GET P/requests/{key} 로 받는다. 번호·시각을 지어내지 않는다:
   *  - receipt_no: 서버 응답에 있을 때만(글 · 숫자). 없으면 `numbered: false` + tx_id 를 그대로 둔다(화면은 번호 없이 “접수됨”).
   *  - committed_at: 서버가 시각을 줄 때만 그것을 쓴다. 지금 서버(GET requests/{key})는 시각을 주지 않아, 영수증을 읽은 이 클라이언트의 시각을 쓴다(접수 시각과 몇 초 차이일 수 있다 — SEL-98 이 서버에 싣는다).
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
    return { receipt_no: no || data.tx_id, ...(no ? {} : { numbered: false }), tx_id: data.tx_id, committed_at: at, idempotency_key: key, replayed };
  }

  const result = <T,>(w: { data: Json; receipt: Receipt; request_id: string }, data: T): CommandResult<T> => ({ format_version: FORMAT_VERSION, request_id: w.request_id, receipt: w.receipt, data });
  const objectAt = (data: Json, name: string): Json => (isRecord(data[name]) ? data[name] : {});
  const text = (v: unknown): string => (typeof v === "string" ? v : "");

  /** 질문 입력 → 서버 spec. 못 담는 칸은 키를 보내지 않는다 */
  function spec(q: QuestionInput): Json {
    const choice = q.kind !== "free_text";
    return {
      text: q.text,
      type: q.kind === "single_choice" ? "single" : q.kind === "multi_choice" ? "multi" : "text",
      required: q.required,
      ...(q.importance ? { importance: q.importance } : {}),
      ...(q.default_value !== null && q.default_value !== undefined ? { default_value: q.default_value } : {}),
      ...(choice ? { options: q.options.map((o) => ({ value: o.id, label: o.label })) } : {}),
      ...(q.show_if ? { show_if: { id: q.show_if.question_id, in: [q.show_if.equals] } } : {}),
      ...(q.help ? { help: q.help } : {}),
    };
  }

  const q = (id: string) => encodeURIComponent(id);
  const changeOf = (kind: "withdraw" | "defer" | "merge", slug: string, qid: string, key: string | undefined, body: Json = {}) =>
    write(slug, key, `/questions/${q(qid)}/${kind}`, body).then((w) => {
      const question = objectAt(w.data, "question");
      const base = { question_id: text(question.id), status: text(question.state) };
      return result(w, kind === "merge" ? { ...base, merged_into: text(question.merged_into_question_id) } : base);
    });

  return {
    capabilities: { questionTools: true },
    getQuestionVersions: notConnected("질문 버전 기록 읽기"),
    reorderQuestions: notConnected("질문 순서 바꾸기"),
    getComments: notConnected("의견 읽기"),

    async addQuestion(slug, _edition, stage, round, body, key) {
      if (!key) throw invalid("$.headers.idempotency-key");
      if (idOf(slug) === undefined) throw new PesApiError(fallbackBody(404));
      if (body.direction === "ask_ai") throw new NotConnectedError("사람이 AI에게 묻는 질문 더하기");
      if (round !== "start") throw new NotConnectedError("번호 라운드에 질문 더하기");
      const w = await write(slug, key, "/questions", { purpose: "stage_start", form_key: "main", direction: "agent_to_human", round_id: null, question: spec(body) }, async (id) => {
        const json = await timed(async (signal) => {
          const res = await send(projectUrl(id, "/context"), { method: "GET", headers: headers(), credentials: "omit", signal });
          if (!res.ok) throw await toApiError(res);
          return (await res.json()) as unknown;
        });
        const stages = isRecord(json) && isRecord(json.data) && Array.isArray(json.data.stages) ? json.data.stages : [];
        const found = stages.find((s) => isRecord(s) && s.key === stage);
        if (!isRecord(found) || typeof found.stage_id !== "string") throw new PesApiError({ ...fallbackBody(404) });
        return { stage_id: found.stage_id };
      });
      const question = objectAt(w.data, "question");
      return result(w, { question_id: text(question.id), version: Number(question.version_no) });
    },

    async reviseQuestion(slug, _edition, qid, body, key) {
      if (!key) throw invalid("$.headers.idempotency-key");
      if (!body.base_version_id) throw invalid("$.base_version_id", "질문의 서버 버전을 알 수 없어 고칠 수 없습니다.");
      const w = await write(slug, key, `/questions/${q(qid)}/revisions`, { base_version_id: body.base_version_id, question: spec(body) });
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

    /** 라운드 하나를 읽는 경로는 계획에 아직 없다(types.ts READS.round) — 작업 공간에 있는 자리만 돌려주고 질문·결과는 비워 둔다(지어내지 않음) */
    async getRound(slug, edition, stage, round) {
      const w = await getWorkspace(slug, edition);
      if (!w) return null;
      const roundId = round === "start" ? null : /^[1-9]\d*$/.test(round) ? Number(round) : undefined;
      if (roundId === undefined) return null;
      const place = w.stages.find((s) => s.key === stage)?.rounds.find((r) => r.round_id === roundId);
      if (!place) return null;
      const view: RoundView = { stage: stage as RoundView["stage"], round_id: roundId, state: place.state, form_version: 0, questions: [], result: null, alerts: [], prompt: "" };
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
