import { FORMAT_VERSION, PesApiError, type ApiError, type ChangesRead, type ChangeTx, type CommandResult, type PesClient, type ProjectRef, type RoundView, type WorkspaceView } from "./types";

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
}

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

  return {
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
