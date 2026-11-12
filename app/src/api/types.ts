/**
 * PES API 모양(U1a) — 승인 시안 docs/plan/mockups/dashboard-v2-react/src/api/types.ts 와 docs/plan/stage-1-api.md 를 따른다.
 *  - 읽기는 봉투 없는 값(시안과 같음). 시각은 ISO 8601(IsoTime). 기계 값만 싣고, 화면 글자(단계 이름 · 라운드 이름 · 중요도 말 ·
 *    한국어 시각 · 상태 이름)는 화면이 만든다(상태 사전 components/pes/status-registry.ts, 이름표 lib/labels.ts).
 *  - 쓰기는 멱등 키(Idempotency-Key) 하나 → CommandResult{format_version, request_id, receipt, data}. 같은 키·같은 요청은
 *    처음 영수증을 다시 돌려주고(replayed=true), 같은 키·다른 요청은 거부(idempotency_key_reuse).
 *  - 거절은 던져진 PesApiError 의 `.body` 가 ApiError 봉투다(오류 코드는 2단계 코어 scripts/pes_core/api_support.ts 의 닫힌 목록).
 *
 * U1a 는 앱 안 가짜 클라이언트(합성 자료)만 쓴다. U1b 에서 같은 모양을 HTTP 클라이언트가 채운다.
 * 한계(U1b 에서 메움): 주소는 API 의 프로젝트 id(`P = /api/v1/projects/{id}`) 대신 화면 주소의 slug + 판으로 부른다 —
 * HTTP 클라이언트가 slug → id 를 풀어 READS/COMMANDS 경로를 만든다. 라운드 읽기 경로는 계획 문서에 아직 없다(G24와 같은 빈칸).
 */

export const FORMAT_VERSION = "1.0" as const;

export type IsoTime = string;

/* ───────────── 봉투 · 오류 · 영수증 (API 결정 4 · 3절 오류 봉투) ───────────── */

/** 2단계 코어(api_support.ts)의 닫힌 오류 코드 중 U1a 가짜 클라이언트가 쓰는 것 */
export type ApiErrorCode = "not_found" | "invalid_payload" | "idempotency_key_reuse" | "conflict" | "cursor_expired" | "cursor_invalid";

export interface ApiError {
  format_version: typeof FORMAT_VERSION;
  error: {
    code: ApiErrorCode;
    /** 한국어 문장 — 화면에 그대로 쓸 수 있다 */
    message: string;
    /** 같은 요청을 자동으로 다시 보내도 되는가 */
    retryable: boolean;
    /** 문제 필드의 JSON 경로 */
    target?: string;
    next_action?: string;
  };
  request_id: string;
}

/** 던져지는 오류 — `.body` 가 ApiError 봉투 */
export class PesApiError extends Error {
  readonly body: ApiError;
  constructor(body: ApiError) {
    super(body.error.message);
    this.name = "PesApiError";
    this.body = body;
  }
}

/** 서버 영수증(mutation_commits). “됨”은 이것을 받은 뒤에만 쓴다(설계 P5). */
export interface Receipt {
  /** 화면에 보이는 접수 번호(번호만 — “접수” 같은 말은 화면이 붙인다) */
  receipt_no: string;
  tx_id: string;
  committed_at: IsoTime;
  idempotency_key: string;
  /** 같은 키로 다시 보낸 요청이면 true — 두 번 처리하지 않고 처음 결과를 다시 돌려줌 */
  replayed: boolean;
}

export interface CommandResult<T> {
  format_version: typeof FORMAT_VERSION;
  request_id: string;
  receipt: Receipt;
  data: T;
}

/* ───────────── 경로 표 (stage-1-api 6절 · 시안 types.ts 와 같은 이름) ───────────── */

export interface CommandSpec {
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** P = /api/v1/projects/{id} */
  path: string;
  owner: string;
  status: "계획" | "미정";
  note?: string;
}

/** 읽기 — U1a 가 쓰는 것만(나머지는 시안 표에 있고 쓰는 이슈에서 옮긴다) */
export const READS = {
  capabilities: { method: "GET", path: "/api/v1/capabilities", owner: "PR13 · PR14", status: "계획" },
  "projects.list": { method: "GET", path: "(미정)", owner: "PR14 · WEB1", status: "미정", note: "공개 JSON 목록 경로가 2단계 닫힌 목록에 없음(G24)" },
  workspace: { method: "GET", path: "P/workspace", owner: "U1", status: "계획", note: "지금 할 일 · 차례는 서버가 계산(G22)" },
  round: { method: "GET", path: "(미정)", owner: "U1b", status: "미정", note: "라운드 하나의 질문·결과 글·알림. 경로는 U1b 에서 정한다" },
} as const satisfies Record<string, CommandSpec>;

/** 쓰기 — 화면의 단추는 이 이름 중 하나로만 바뀐다(검증된 쓰기 경로 하나) */
export const COMMANDS = {
  "submission.create": { method: "POST", path: "P/submissions", owner: "PR14 · PR8 · U2", status: "계획", note: "당시 폼 버전 검증, 부분 접수 없음" },
  "question.revise": { method: "POST", path: "P/questions/{q}/revisions", owner: "PR14 · PR8 · U2", status: "계획" },
  "thread.create": { method: "POST", path: "P/threads", owner: "U4", status: "계획" },
  "alert.acknowledge": { method: "POST", path: "(미정)", owner: "U1b", status: "미정", note: "오류 알림 확인. 멱등 키 필수" },
} as const satisfies Record<string, CommandSpec>;

export type PesRead = keyof typeof READS;
export type PesCommand = keyof typeof COMMANDS;

/* ───────────── 공통 값 ───────────── */

export type Mode = "A" | "B";
export type StageKey = "plan" | "research" | "analyze" | "write" | "verify" | "publish";

/** 단계 보기 — 상태 사전(stage)의 키. 차례 말(현재 · 나의 할 일 …)은 사전이 정한다 */
export type StageView = "approved" | "current_you" | "current_ai" | "current_blocked" | "stale" | "pending";

/** 차례(설계 15절) — 서버가 사람·권한별로 계산해 싣는다(화면이 추측하지 않음) */
export interface TurnView {
  side: "you" | "ai" | "waiting" | "done";
  /** you: 나의 할 일 수 */
  count?: number;
  /** you: 먼저 할 일 한 줄 · ai: 지금 하는 일 · waiting: 무엇을 기다리는지 */
  text?: string;
  since?: IsoTime;
  last_signal?: IsoTime;
  fresh?: boolean;
}

/** 라운드 하나의 자리. 단계 시작 질문은 round_id = null(가짜 R0 을 만들지 않는다) */
export interface RoundRef {
  round_id: number | null;
  state: "closed" | "current";
}

/**
 * 과거 승인(U1d · F06) — 단계가 지금 stale 이어도 “그때 승인했다”는 사실은 남는다.
 * at = null 은 시각을 모르는 옛 승인. origin = legacy_unverified 는 이전된 프로젝트의 승인(검증 안 됨).
 */
export interface PastApprovalView {
  at: IsoTime | null;
  origin: "verified" | "legacy_unverified";
}

export interface StageRef {
  key: StageKey;
  view: StageView;
  past_approval?: PastApprovalView;
  rounds: RoundRef[];
}

/* ───────────── AI 연결(U1d · F07) — 정책 읽기 + 나간 전송 ───────────── */

/** project_policy_versions 읽기. 확정 전 = pending, 누락·손상은 각각 missing · corrupt(허용으로 해석하지 않는다) */
export type AiPolicy = "allowed" | "denied" | "missing" | "corrupt" | "pending";

/** outbound_dispatches 읽기 — 보낸 뒤 끝난 것(cancelled)과 결과를 모르는 것(unknown)을 구분한다 */
export interface AiDispatchView {
  id: string;
  run_id: string;
  state: "sent" | "cancel_requested" | "cancelled" | "unknown";
}

export interface AiConnectionView {
  policy: AiPolicy;
  dispatches?: AiDispatchView[];
}

/* ───────────── 실행(중단 · 취소 · 인계) · 실행 권한(U1d) ───────────── */

export type RunStatus = "running" | "queued" | "waiting_human" | "interrupted" | "cancelled" | "handed_off" | "failed" | "succeeded";
export type ExternalStop = "pending" | "confirmed" | "failed" | "unknown";

export interface RunView {
  id: string;
  stage: StageKey;
  mode: Mode;
  status: RunStatus;
  /** 바깥에서 멈춘 결과 — unknown 은 “중단 확인됨”이 아니다(연결 끊김 ≠ 취소) */
  external_stop?: ExternalStop;
}

/** 외부 앱의 질문·권한 — PES 연구 질문(QuestionView)과 섞지 않는다(RUN A9 · B0) */
export interface RunPermissionView {
  id: string;
  run_id: string;
  source: "pes_tool" | "external_app";
  kind: "question" | "permission";
  text: string;
  state: "waiting" | "answered";
}

/** 작업 공간의 기록 개수(가정 · 결정 · 의견). empty 는 서버가 판정한 “모두 0건” */
export interface RecordsView {
  assumptions: { count: number };
  decisions: { count: number };
  comments: { count: number };
  empty: boolean;
}

/** 작업 공간 읽기 묶음(GET P/workspace) 중 화면이 쓰는 칸. U1d 칸은 서버가 아직 주지 않으면 없다(모르면 모른다고 그린다) */
export interface WorkspaceView {
  slug: string;
  /** 프로젝트 제목(사람이 정한 글) */
  title: string;
  edition: number;
  mode: Mode;
  current: { stage: StageKey; round_id: number | null };
  stages: StageRef[];
  turn: TurnView;
  /** U1d — 없으면 unknown(켜짐 아님) */
  ai_connection?: AiConnectionView;
  /** U1d — 없으면 “정보 없음”(0건이라 단정하지 않음) */
  runs?: RunView[];
  run_permissions?: RunPermissionView[];
  /** 서버 작업 공간 읽기에 이미 있는 칸 */
  records?: RecordsView;
}

export type Importance = "high" | "normal" | "low";
export type QuestionSource = "ai" | "bank" | "human";

/** 보낸 답 — 영수증 객체가 붙는다 */
export interface SentAnswer {
  answer: string;
  receipt_no: string;
  tx_id: string;
  committed_at: IsoTime;
  idempotency_key?: string;
}

export interface QuestionView {
  /** 화면 요소 id 이기도 하다(`q-21`) — 주소의 focus · peek 가 가리킨다 */
  id: string;
  number: number;
  version: number;
  required: boolean;
  importance: Importance;
  source: QuestionSource;
  text: string;
  help?: string;
  sent?: SentAnswer;
}

export interface AlertView {
  id: string;
  severity: "bad" | "warn";
  /** 알림 글(서버가 만든 한국어 문장) */
  title: string;
  detail: string;
  raised_at: IsoTime;
  acknowledged?: { receipt_no: string; tx_id: string; committed_at: IsoTime };
}

export interface ResultView {
  /** 결과물 제목(사람·AI 가 쓴 글) */
  title: string;
  version: number;
  status: "adopted" | "draft";
  updated_at: IsoTime;
  paragraphs: string[];
}

export interface RoundView {
  stage: StageKey;
  round_id: number | null;
  state: "closed" | "current";
  form_version: number;
  questions: QuestionView[];
  result: ResultView | null;
  alerts: AlertView[];
  /** 프롬프트 복사(복사 대안)에 쓰는 글 */
  prompt: string;
}

export interface ProjectRef {
  slug: string;
  edition: number;
  current: { stage: StageKey; round_id: number | null };
}

/**
 * 변경분 읽기(U1c · 설계 12.5-2 · API 결정 13) — 공개 tx 묶음 단위.
 *  - cursor: 서버가 주는 불투명 값. 화면은 해석하지 않고 다음 호출에 그대로 돌려준다. null = 처음(기준만 받음).
 *  - txs[].touched: 그 tx 가 건드린 읽기 키 — "workspace" | "projects" | "round:<stage>/<round>"(round = 숫자 또는 start).
 *  - 숨은 사건이면 txs 가 비고 cursor 만 앞으로 간다. 거절: cursor_expired(410) · cursor_invalid(400) → 화면은 재동기화한다.
 */
export interface ChangeTx {
  tx_id: string;
  touched: string[];
}
export interface ChangesRead {
  cursor: string;
  txs: ChangeTx[];
}

/** 가짜 클라이언트와 (U1b) HTTP 클라이언트가 같이 지키는 모양 */
export interface PesClient {
  listProjects(): Promise<ProjectRef[]>;
  /** 없으면 null(모르는 slug 에 자료를 지어내지 않는다) */
  getWorkspace(slug: string, edition: number): Promise<WorkspaceView | null>;
  /** round: 숫자 또는 "start"(단계 시작). 없으면 null */
  getRound(slug: string, edition: number, stage: string, round: string): Promise<RoundView | null>;
  /** 오류 알림 확인 — 멱등 키 필수. 거절은 PesApiError */
  acknowledgeAlert(slug: string, edition: number, alertId: string, idempotencyKey: string | undefined): Promise<CommandResult<{ alert_id: string }>>;
  /** 변경분 읽기 — 커서 다음의 공개 tx 묶음. 거절은 PesApiError(cursor_expired · cursor_invalid) */
  getChanges(slug: string, edition: number, cursor: string | null): Promise<ChangesRead>;
}
