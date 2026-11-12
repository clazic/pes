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
export type ApiErrorCode =
  | "not_found"
  | "invalid_payload"
  | "idempotency_key_reuse"
  | "conflict"
  | "rev_conflict"
  | "question_version_changed"
  | "cursor_expired"
  | "cursor_invalid"
  | "not_supported"
  // U4b(SEL-112) — 서버 첨언·후속(SEL-99 U4a)의 닫힌 목록 중 화면이 알아보는 것
  | "basis_changed"
  | "thread_closed"
  | "already_resolved"
  | "human_required"
  | "forbidden"
  | "validation_failed";

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
    /** 거절 사유 상세(서버 봉투가 이미 갖는다) — 답 제출은 { reason: "required_missing" | "not_applicable" | "single_requires_one_item" | "stale_question_version", question_ids? } */
    details?: Record<string, unknown> | null;
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
  /** 화면에 보이는 접수 번호(번호만 — “접수” 같은 말은 화면이 붙인다). `numbered: false` 이면 서버가 번호를 주지 않은 것 — 이 값은 tx_id 와 같고 화면에 번호로 보이지 않는다 */
  receipt_no: string;
  /** false = 서버가 접수 번호를 주지 않았다(HTTP 클라이언트가 번호를 지어내지 않는다) — 화면은 번호 없이 “접수됨”. 없으면 번호가 있는 것 */
  numbered?: boolean;
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

/**
 * outbound_dispatches 읽기 — state 는 DB 8값 그대로(서버가 이름을 바꾸거나 합치지 않는다). `cancel_requested` · `cancelled` 는
 * 서버가 보내지 않는 옛 값(U1d 첫 모양) — 사전이 계속 읽는다. 취소 시도는 state 가 아니라 별도 칸 cancel_state 이며
 * 서버는 DB 근거가 생길 때만 보낸다(지금은 보내지 않는다). resolution 은 결과를 모르던 전송을 사람이 정리한 결과(행이 있을 때만).
 */
export interface AiDispatchView {
  id: string;
  run_id: string;
  state: "prepared" | "authorized" | "sent" | "response" | "adopted" | "blocked" | "failed" | "unknown" | "cancel_requested" | "cancelled";
  resolution?: "charged" | "not_charged";
  cancel_state?: "requested" | "cancelled";
}

export interface AiConnectionView {
  policy: AiPolicy;
  dispatches?: AiDispatchView[];
}

/* ───────────── 실행(중단 · 취소 · 인계) · 실행 권한(U1d) ───────────── */

/** runs.status 8값 그대로 + handed_off(서버가 앱 인계 가져오기 기록 run 에만 붙이는 값) */
export type RunStatus = "running" | "queued" | "waiting_human" | "blocked_usage" | "interrupted" | "cancelled" | "handed_off" | "failed" | "succeeded";
export type ExternalStop = "pending" | "confirmed" | "failed" | "unknown";

export interface RunView {
  id: string;
  /** 단계가 없는 run 은 null */
  stage: StageKey | null;
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
  /** 서버가 가진 답 값 그대로(JSON: 글 · 선택지 id · 여러 개는 배열 · 숫자 …) — 조건 판정에 쓴다. 없으면 answer(화면 글)에서 되찾는다 */
  value?: unknown;
}

/* ───────────── 질문 칸(U2b · SEL-91) — 서버 계약은 SEL-90(U2a). 이전된 합성 프로젝트는 아래 칸이 하나도 없어도 깨지지 않는다 ───────────── */

export type QuestionKind = "single_choice" | "multi_choice" | "free_text";
/** ask_human = AI 가 사람에게 묻는다 · ask_ai = 사람이 AI 에게(“내가 AI에게”) */
export type QuestionDirection = "ask_human" | "ask_ai";
export type QuestionStatus = "open" | "withdrawn" | "deferred" | "merged";

export interface QuestionOption {
  id: string;
  label: string;
}

/** in = 그 질문의 선택지 id(또는 글 답 값)들 — 하나라도 고르면 보임. 서버 {id, in:[…]} 와 같은 뜻 */
export interface ShowIf {
  question_id: string;
  in: string[];
  /** 앱이 모르는 서버 키(예: `pes ask` 가 붙이는 position) — 고치기에서 조건 질문을 바꾸지 않는 한 그대로 되돌려 보낸다 */
  extra?: Record<string, unknown>;
}

/** 옛 버전의 답 — 보존할 뿐 새 버전으로 승계하지 않는다 */
export interface PreviousAnswer {
  answer: string;
  /** 그 답이 가리킨 질문 버전 번호. 서버가 주지 않으면 없다(버전을 지어내지 않는다) */
  version?: number;
  receipt_no: string;
  committed_at: IsoTime;
}

export interface QuestionView {
  /** 화면 요소 id 이기도 하다(`q-21`) — 주소의 focus · peek 가 가리킨다 */
  id: string;
  number: number;
  version: number;
  required: boolean;
  /** 없음 = 미정(이전된 프로젝트) — 중요도를 지어내지 않는다 */
  importance?: Importance;
  source: QuestionSource;
  text: string;
  help?: string;
  sent?: SentAnswer;
  /** 없으면 free_text */
  kind?: QuestionKind;
  options?: QuestionOption[];
  /** 기본값 — 선택지 id 또는 글. 미리 답으로 채우지 않는다 */
  default_value?: string | null;
  /** AI 추천 — 기본값과 다르고 답도 아니다 */
  recommendation?: { value: string; reason: string } | null;
  show_if?: ShowIf | null;
  /** 조건 값에 문자열이 아닌 것(숫자 …)이 있을 때만: 서버처럼 값 그대로 판정하려고 원래 조건을 둔다(고치기에는 쓰지 않는다) */
  show_if_judge?: { question_id: string; in: readonly unknown[] };
  /** 서버 조건이 앱이 다루지 못하는 모양이다(show_if 는 null 이거나 읽을 수 있는 만큼만) — '조건 없음'처럼 감추지 않고 말한다 */
  show_if_unsupported?: boolean;
  /** 없으면 ask_human */
  direction?: QuestionDirection;
  /** 없으면 open */
  status?: QuestionStatus;
  /** status === "merged" 일 때 합쳐진 질문 id */
  merged_into?: string;
  /** 질문이 바뀌어 답을 다시 확인해야 함 */
  needs_recheck?: boolean;
  previous_answer?: PreviousAnswer | null;
  /** U2c — 의견(value 없음 + comment)만으로 필수를 채울 수 있는 질문. 없으면 false */
  allow_comment_as_answer?: boolean;
  /** U2c — 서버 질문 버전 id. 있으면 답 제출이 그대로 싣는다 */
  version_id?: string;
  /** U2c — 보낸 답이 기본값 채택이었음(읽기 전용) */
  used_default?: boolean;
}

/** 질문 하나를 만들거나 고칠 때 보내는 값 */
export interface QuestionInput {
  text: string;
  kind: QuestionKind;
  options: QuestionOption[];
  importance: Importance | null;
  required: boolean;
  default_value: string | null;
  show_if: ShowIf | null;
  /** true 면 보내는 쪽은 show_if 키를 아예 싣지 않는다 — 앱이 모르는 서버 조건을 null 로 지우지 않는다 */
  show_if_unsupported?: boolean;
  help: string | null;
  direction: QuestionDirection;
}

/** base_version = 지금 보는 질문 버전 — 어긋나면 conflict */
export interface QuestionRevision extends QuestionInput {
  base_version: number;
  /** U2c — 서버 버전 id(QuestionView.version_id). 서버로 고칠 때 필요하다. 지금 HTTP 클라이언트의 getRound 는 질문·version_id 를 아직 채우지 않아(SEL-98 에서 라운드 읽기가 이어질 때 채운다) 비어 있으면 reviseQuestion 은 요청 없이 “서버 버전을 알 수 없어” 로 거절한다 */
  base_version_id?: string;
}

/** 질문 버전 기록 한 줄(최신이 먼저) */
export interface QuestionVersionView {
  version: number;
  text: string;
  importance?: Importance;
  required: boolean;
  kind: QuestionKind;
  created_at: IsoTime;
  answer?: { answer: string; receipt_no: string; committed_at: IsoTime };
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
  /** 글 버전 번호 — 서버가 안 주면 null(SEL-126: 지어내지 않는다, 화면은 "v…" 표시를 숨긴다) */
  version: number | null;
  /** 채택 여부 — 라운드 읽기는 주지 않으므로 서버에서 온 결과 글은 null(화면은 채택본/초안 표시를 숨긴다) */
  status: "adopted" | "draft" | null;
  /** 이 버전이 쓰인 시각 — 서버가 안 주면 null(화면은 날짜를 숨긴다) */
  updated_at: IsoTime | null;
  paragraphs: string[];
  /**
   * U4b(SEL-112) — 결과 글 선택 도구(첨언)의 기준. 셋이 모두 있어야 선택 도구가 켜진다(서버가 안 주면 없다 — 지어내지 않는다).
   * object_id = 결과 글 객체 · version_id = 지금 보는 글 버전 · body_md = 그 버전 본문 그대로(앵커 위치의 기준, 정규화 없음).
   */
  object_id?: string;
  version_id?: string;
  body_md?: string;
}

export interface RoundView {
  stage: StageKey;
  round_id: number | null;
  state: "closed" | "current";
  form_version: number;
  /** U2c — 서버 폼 세트 id(답 제출에 쓴다). 서버가 아직 주지 않으면 없다 */
  set_id?: string;
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

/* ───────────── 가정 · 결정 · 반영 (U3b · SEL-94) ───────────── */

/**
 * 기계 값만 싣는다 — 화면 글자(상태 낱말 · 범위 이름 · 처리 낱말)는 앱이 만든다(상태 사전 status-registry.ts).
 * 서버 계약은 SEL-93(U3a)이 정하고 SEL-100(U3c)이 읽기 칸을 보강했다. HTTP 클라이언트는 서버가 주는 것만 싣고, 못 주는 칸(복사 원본 판 · 근거 링크)은 null 로 둔다.
 */
export interface Actor {
  id: string;
  kind: "human" | "ai";
  name: string;
}
export interface Link {
  label: string;
  href: string;
}
export interface AssumptionRow {
  object_id: string;
  version_id: string;
  version: number;
  statement: string;
  state: "proposed" | "confirmed" | "rejected" | "revised";
  proposed_by: Actor;
  assessed_by: Actor | null;
  assessed_at: IsoTime | null;
  /** 새 판 복사본 등 — 상태가 confirmed 여도 사람이 다시 봐야 한다 */
  needs_review: boolean;
  rationale: string;
  /** 고침이면 고치기 전 문장(원문 보존) */
  original: { version_id: string; statement: string } | null;
  copied_from: { edition: number; label: string } | null;
  source: Link | null;
}
export interface DecisionRow {
  object_id: string;
  version_id: string;
  version: number;
  statement: string;
  state: "proposed" | "adopted" | "superseded" | "revoked";
  scope: "project" | "edition";
  proposed_by: Actor;
  decided_by: Actor | null;
  rationale: string;
  /** 이 결정이 대체한 옛 결정 */
  supersedes: { object_id: string; statement: string } | null;
  superseded_by: string | null;
  /** 판 결정: 새 판으로 복사될 때 고정된 당시 버전 */
  originated_from: { label: string; version: number } | null;
  source: Link | null;
}
export interface FollowupView {
  id: string;
  kind: "edit_text" | "next_round_task" | "reopen_stage" | "none";
  state: "proposed" | "accepted" | "running" | "applied" | "deferred" | "rejected" | "cancelled";
  label: string;
  result_version: Link | null;
}
export interface ReflectionEntry {
  id: string;
  opinion: string;
  source: Link | null;
  disposition: "applied" | "partial" | "deferred" | "rejected";
  rationale: string;
  actor: Actor | null;
  applied_tx_id: string | null;
  result_version: Link | null;
  followup: FollowupView | null;
}
export interface ReflectionView {
  /** none = 지난 라운드에 보낸 반영 의견 자체가 없음(미제출) · submitted = 보냄 */
  submission: "none" | "submitted";
  /** 보낸 의견 수. 서버는 이 값을 주지 않으므로 http 클라이언트는 null(처리된 줄 수로 지어내지 않는다). 화면은 쓰지 않는다 */
  sent_count: number | null;
  entries: ReflectionEntry[];
}
/** 판단 입력 공통 — 사람이 본 버전(= 행의 version_id). 그 사이 바뀌었으면 서버가 rev_conflict 로 거절한다 */
export interface BaseVersion {
  base_version_id: string;
}
export interface AssessInput extends BaseVersion {
  verdict: "confirm" | "reject" | "revise";
  rationale: string;
  statement?: string;
}
export type JudgeResult = CommandResult<{ object_id: string; version_id: string }>;

/* ───────────── 답 제출 · 질문별 의견(U2c · SEL-92) — 서버 계약은 SEL-90(U2a): POST P/submissions · P/threads ───────────── */

export interface AnswerItemInput {
  question_id: string;
  /** 이 답이 가리키는 질문 버전(화면이 보고 있던 버전) — 어긋나면 conflict(부분 접수 0) */
  question_version: number;
  /** 서버 버전 id(QuestionView.version_id 가 있을 때만) */
  question_version_id?: string;
  /** 하나 고르기 = 선택지 id · 여러 개 = 선택지 id 배열 · 글 = 글 · 의견만 있으면 null */
  value: string | string[] | null;
  /** 그 질문의 “의견 칸” 글(제출에 붙는 의견; 스레드 의견과 다르다) */
  comment?: string | null;
  /** 기본값 쓰기로 채운 뒤 바꾸지 않은 답일 때만 true */
  used_default?: boolean;
}

export interface SubmitInput {
  /** bundle = 이 제출 + 이미 낸 답으로 적용 필수 질문이 모두 채워져야 한다 · single = 항목 정확히 1개 */
  mode: "bundle" | "single";
  form_version: number;
  set_id?: string;
  answers: AnswerItemInput[];
}

export interface SubmitResult {
  submission_id: string;
  answers: { question_id: string; state: "submitted" }[];
  form_complete: boolean;
  missing_required: string[];
}

export interface CommentMessageView {
  message_id: string;
  body_md: string;
  at: IsoTime;
  by: "human" | "ai";
  receipt_no?: string;
}

/** question_id "__other" = 이전된 프로젝트의 질문에 묶이지 않은 의견 */
export interface CommentThreadView {
  thread_id: string;
  question_id: string | "__other";
  question_version?: number;
  messages: CommentMessageView[];
}

export interface CommentInput {
  body_md: string;
  /** 있으면 그 스레드에 메시지만 더한다 */
  thread_id?: string;
  question_version?: number;
  question_version_id?: string;
}


/* ───────────── 이전 프로젝트 참고자료(REF1b · SEL-114) — 서버 계약은 SEL-113(REF1a): GET/POST P/references · P/references/{ref}(/refresh · /detach) ───────────── */

/** 서버가 정한 참고 상태 — 모르는 값은 사전이 “미상”으로 읽는다(허용·정상으로 해석하지 않음) */
export type ReferenceState = "pinned" | "new_version" | "source_missing" | "source_archived" | "no_permission";

export interface ReferenceAiDelivery {
  allowed: boolean;
  /** 알려진 값: source_go_off · project_go_off · source_missing. 처음 보는 값은 화면이 그대로 찍지 않는다 */
  withheld_reason: string | null;
}

/** 서버가 안 주는 칸은 null — 권한 없는 줄은 id · access · state 만 값이 있고 나머지는 모두 null. rev 는 서버의 10진 문자열 그대로 */
export interface ReferenceRow {
  id: string;
  access: "ok" | "no_permission";
  state: ReferenceState;
  referenced_project_id: string | null;
  referenced_project_key: string | null;
  source_label: string | null;
  source_snapshot_id: string | null;
  source_snapshot_key: string | null;
  latest_snapshot_id: string | null;
  new_version_available: boolean | null;
  scope: string[] | null;
  ai_delivery: ReferenceAiDelivery | null;
  attached_at: IsoTime | null;
  refreshed_at: IsoTime | null;
  rev: string | null;
}

export interface ReferenceCitation {
  reference_id: string;
  project_id: string;
  project_label: string;
  snapshot_id: string;
  object_id: string;
  version_id: string;
}

/** 서버가 항목 종류별로만 주는 칸(보고서: title · summary · body_md / 출처: title · url · quote)을 안 준 쪽은 null */
export interface ReferenceContentItem {
  item: "final_report" | "sources";
  object_id: string;
  version_id: string;
  kind: string;
  title: string;
  summary: string | null;
  body_md: string | null;
  url: string | null;
  quote: string | null;
  citation: ReferenceCitation;
}

export interface ReferenceContent {
  items: ReferenceContentItem[];
}

export interface ReferenceSnapshot {
  id: string;
  key: string;
  /** 서버에는 스냅숏 이름이 없어 null 일 수 있다(지어내지 않는다) — 화면은 key 로 보여 준다 */
  label: string | null;
  approved: boolean;
  recommended: boolean;
}

/** 붙일 수 있는 프로젝트와 각 프로젝트의 고를 수 있는 스냅숏 */
export interface ReferenceCandidate {
  project_id: string;
  key: string;
  label: string;
  /** 이미 이 프로젝트에 붙인 프로젝트 */
  attached: boolean;
  snapshots: ReferenceSnapshot[];
}

export interface ReferenceAttachInput {
  referenced_project_id: string;
  source_snapshot_id: string;
  scope?: string[];
  source_label?: string;
}

export interface ReferenceRefreshInput {
  source_snapshot_id?: string;
  base_rev?: string;
}

/**
 * 참고 프로젝트 읽기 · 쓰기 — 쓰기는 모두 멱등 키 필수(없으면 요청 없이 invalid_payload) · 같은 키·같은 요청은 처음 영수증을 replayed 로 · 거절은 PesApiError.
 * 후보 읽기(getReferenceCandidates)는 작업 중(scope 있음)이면 GET P/reference-candidates(소유자 세션만, SEL-120). scope=null(프로젝트가 아직 없는 생성 화면)은 서버에 길이 없어 HTTP 클라이언트가 NotConnectedError 로 답한다.
 */
export interface ReferencesMethods {
  /** 모르는 slug · 없는 판 = [] */
  getReferences(slug: string, edition: number): Promise<ReferenceRow[]>;
  /** 없으면 null. 403 은 PesApiError */
  getReference(slug: string, edition: number, refId: string): Promise<{ reference: ReferenceRow; content: ReferenceContent | null } | null>;
  getReferenceCandidates(scope: { slug: string; edition: number } | null): Promise<ReferenceCandidate[]>;
  attachReference(slug: string, edition: number, input: ReferenceAttachInput, idempotencyKey: string | undefined): Promise<CommandResult<{ reference: ReferenceRow }>>;
  refreshReference(slug: string, edition: number, refId: string, input: ReferenceRefreshInput, idempotencyKey: string | undefined): Promise<CommandResult<{ reference: ReferenceRow }>>;
  detachReference(slug: string, edition: number, refId: string, idempotencyKey: string | undefined): Promise<CommandResult<{ reference_id: string; detached: true }>>;
}

/* ───────────── 결과 글 첨언 · 후속(U4b · SEL-112) — 서버 계약은 SEL-99(U4a): P/threads(context_kind annotation) · P/followups ───────────── */

/** 위치는 서버와 같은 code point(유니코드 스칼라) — `@/lib/anchor-text` */
export interface CpRange {
  start_cp: number;
  end_cp: number;
}
/** 글의 지금 버전에서 인용문이 어떻게 보이는가(서버 판정) — 상태 사전 anchor 의 키 */
export type AnchorStatus = "exact" | "moved" | "ambiguous" | "lost";
export type FollowupKind = "edit_text" | "next_round_task" | "reopen_stage" | "none";
export type FollowupState = "proposed" | "accepted" | "running" | "applied" | "deferred" | "rejected" | "cancelled";

/** 후속 상세(GET P/followups 한 줄) — version_no 는 서버 그대로의 10진 문자열(expected_rev 로 되돌려 보낸다) */
export interface FollowupDetail {
  id: string;
  kind: FollowupKind;
  state: FollowupState;
  description: string;
  version_no: string;
  origin_thread_id: string;
  base_version_id: string | null;
  proposed_body_md: string | null;
  proposed_version_id: string | null;
  result_version_id: string | null;
  applied_tx_id: string | null;
  confirmed_by_actor_id: string | null;
}

export interface AnnotationAnchorView {
  exact_quote: string;
  prefix: string;
  suffix: string;
  start_cp: number;
  end_cp: number;
  target_version_id: string;
  /** 글의 현재 버전 기준 판정 — 화면의 표시 상태. ambiguous · lost 는 위치가 null(서버가 하나를 고르지 않았으니 앱도 고르지 않는다) */
  current: {
    evaluated_version_id: string;
    status: AnchorStatus;
    start_cp: number | null;
    end_cp: number | null;
    text: string | null;
    candidates: CpRange[];
    confirmed_by_actor_id: string | null;
  };
}

export interface AnnotationMessageView {
  message_id: string;
  body_md: string;
  at: IsoTime;
  actor_id: string;
  /** 서버가 행위자 종류를 주지 않으면 null — 화면은 사람/AI 라고 쓰지 않는다 */
  by: "human" | "ai" | null;
}

export interface AnnotationThreadView {
  thread_id: string;
  state: "open" | "resolved" | "archived";
  target_object_id: string;
  target_version_id: string;
  anchor: AnnotationAnchorView;
  messages: AnnotationMessageView[];
  resolution: { resolution: FollowupKind; reason: string; followup_id: string | null } | null;
  followups: FollowupDetail[];
}

export interface AnnotationInput {
  target_object_id: string;
  target_version_id: string;
  anchor: { exact_quote: string; prefix: string; suffix: string; start_cp: number; end_cp: number };
  body_md: string;
}

/* ───────────── 내 자료 · 파일별 AI 참조 · 미리보기 (MAT1c · SEL-117) — 서버 계약은 SEL-115(MAT1a): P/materials · P/uploads · P/file-policies/{fp}/ai-access · P/files/{b}/preview ───────────── */

export type AiAccess = "allow" | "deny";

/** 작업 중 자료 한 줄(각 자료 객체의 현재 버전 파일). 사람 화면이라 금지(deny) 파일도 온다 */
export interface MaterialRow {
  object_id: string;
  version_id: string;
  version: number;
  blob_id: string;
  file_policy_id: string;
  role: string;
  title: string;
  original_name: string;
  media_type: string;
  size: number;
  sha256: string;
  /** 서버가 주지 않으면 null — 허용으로 간주하지 않는다 */
  ai_access: AiAccess | null;
  /** 글자 뽑기 상태는 SEL-116 계약 전이라 항상 null(화면은 “추출 상태 정보 없음”) */
  extraction: null;
}

export interface MaterialUploadResult {
  object_id: string;
  version_id: string;
  /** 서버가 주지 않으면 null */
  version: number | null;
  blob_id: string;
  file_policy_id: string;
  role: string;
  /** 서버가 주지 않으면 null — 허용으로 지어내지 않는다 */
  ai_access: AiAccess | null;
  original_name: string;
  media_type: string;
  size: number | null;
  sha256: string;
}

export interface MaterialAiAccessResult {
  file_policy_id: string;
  blob_id: string;
  /** 서버가 주지 않으면 null (화면: 정보 없음) */
  ai_access: AiAccess | null;
  rev: number | null;
  /** false = 이미 그 값이었다(서버가 기록·rev 를 바꾸지 않음) */
  changed: boolean;
}

/** 미리보기 바이트 — 클라이언트가 세션 헤더로 받는다(주소 링크로는 세션이 안 간다) */
export interface MaterialPreview {
  blob_id: string;
  content_type: string;
  /** content-disposition 이 inline 인가(아니면 attachment · 모르면 false) */
  inline: boolean;
  /** content-security-policy 헤더 값(sandbox 가 필요한 형식) · 없으면 null */
  sandbox: string | null;
  bytes: Uint8Array;
}

export interface MaterialsMethods {
  /** 모르는 slug · 없는 판 = []. 읽기 실패는 PesApiError(빈 목록으로 삼키지 않음) */
  getMaterials(slug: string, edition: number): Promise<MaterialRow[]>;
  /** 예약 → 올리기 → 완료 → 자료 등록을 묶는다. object_id 가 있으면 그 자료의 새 버전(원본을 덮어쓰지 않음). 멱등 키 필수 */
  uploadMaterial(slug: string, edition: number, input: { file: File; title?: string; object_id?: string }, idempotencyKey: string | undefined): Promise<CommandResult<MaterialUploadResult>>;
  /** 파일별 AI 참조 바꾸기(소유자만). 같은 값이면 changed:false. 멱등 키 필수 */
  setMaterialAiAccess(slug: string, edition: number, filePolicyId: string, input: { ai_access: AiAccess; reason?: string }, idempotencyKey: string | undefined): Promise<CommandResult<MaterialAiAccessResult>>;
  /** 이 blob 의 미리보기 바이트. 거절은 PesApiError */
  getMaterialPreview(slug: string, edition: number, blobId: string): Promise<MaterialPreview>;
}

/** 가짜 클라이언트와 (U1b) HTTP 클라이언트가 같이 지키는 모양 */
export interface PesClient extends MaterialsMethods, ReferencesMethods {
  listProjects(): Promise<ProjectRef[]>;
  /** 없으면 null(모르는 slug 에 자료를 지어내지 않는다) */
  getWorkspace(slug: string, edition: number): Promise<WorkspaceView | null>;
  /** round: 숫자 또는 "start"(단계 시작). 없으면 null */
  getRound(slug: string, edition: number, stage: string, round: string): Promise<RoundView | null>;
  /** 오류 알림 확인 — 멱등 키 필수. 거절은 PesApiError */
  acknowledgeAlert(slug: string, edition: number, alertId: string, idempotencyKey: string | undefined): Promise<CommandResult<{ alert_id: string }>>;
  /** 변경분 읽기 — 커서 다음의 공개 tx 묶음. 거절은 PesApiError(cursor_expired · cursor_invalid) */
  getChanges(slug: string, edition: number, cursor: string | null): Promise<ChangesRead>;
  /** 가정 · 결정 읽기(U3b · U3c 에서 서버에 연결). 없는 판은 [] */
  getAssumptions(slug: string, edition: number): Promise<AssumptionRow[]>;
  getDecisions(slug: string, edition: number): Promise<DecisionRow[]>;
  /** round: 숫자 문자열 또는 "start". null = 서버가 반영 자료를 주지 않음(이전된 프로젝트) */
  getReflections(slug: string, edition: number, stage: string, round: string): Promise<ReflectionView | null>;
  /** 사람 판단 쓰기(U3b) — 멱등 키 필수. 거절은 PesApiError */
  assessAssumption(slug: string, edition: number, objectId: string, input: AssessInput, idempotencyKey: string | undefined): Promise<JudgeResult>;
  adoptDecision(slug: string, edition: number, objectId: string, input: BaseVersion & { rationale: string }, idempotencyKey: string | undefined): Promise<JudgeResult>;
  /** 새 결정을 만든다(옛 결정은 덮어쓰지 않음) */
  supersedeDecision(slug: string, edition: number, objectId: string, input: BaseVersion & { statement: string; rationale: string }, idempotencyKey: string | undefined): Promise<JudgeResult>;
  revokeDecision(slug: string, edition: number, objectId: string, input: BaseVersion & { rationale: string }, idempotencyKey: string | undefined): Promise<JudgeResult>;

  /**
   * 질문 쓰기(U2b) — 서버 계약은 SEL-90(U2a): POST P/questions · P/questions/{q}/revisions · P/questions/{q}/withdraw|defer|merge.
   * 모두 멱등 키 필수(없으면 invalid_payload) · 같은 키·같은 요청은 영수증 재생 · 거절은 PesApiError. 삭제(hard delete) 명령은 없다.
   * 추가 · 철회 · 보류 · 합치기 · 순서 바꾸기 · 고치기는 모두 새 폼 버전을 만든다. 성공하면 화면은 getRound 를 다시 읽는다.
   * HTTP 클라이언트는 U2c 에서 매핑했다. 서버에 길이 없는 것(순서 바꾸기 · 버전 기록 읽기 · 의견 읽기)은 NotConnectedError.
   */
  getQuestionVersions(slug: string, edition: number, questionId: string): Promise<QuestionVersionView[] | null>;
  reviseQuestion(slug: string, edition: number, questionId: string, body: QuestionRevision, idempotencyKey: string | undefined): Promise<CommandResult<{ question_id: string; version: number; needs_recheck: boolean }>>;
  addQuestion(slug: string, edition: number, stage: string, round: string, body: QuestionInput, idempotencyKey: string | undefined): Promise<CommandResult<{ question_id: string; version: number }>>;
  withdrawQuestion(slug: string, edition: number, questionId: string, idempotencyKey: string | undefined): Promise<CommandResult<{ question_id: string; status: "withdrawn" }>>;
  deferQuestion(slug: string, edition: number, questionId: string, idempotencyKey: string | undefined): Promise<CommandResult<{ question_id: string; status: "deferred" }>>;
  mergeQuestion(slug: string, edition: number, questionId: string, intoQuestionId: string, idempotencyKey: string | undefined): Promise<CommandResult<{ question_id: string; status: "merged"; merged_into: string }>>;
  /** orderedIds = 상태 open 질문 전부의 새 순서(닫힌 질문은 제외) */
  reorderQuestions(slug: string, edition: number, stage: string, round: string, orderedIds: string[], idempotencyKey: string | undefined): Promise<CommandResult<{ form_version: number }>>;

  /**
   * 답 제출(U2c) — 멱등 키 필수(없으면 invalid_payload) · 같은 키·같은 요청은 영수증 재생 · 거절은 PesApiError 이고 아무것도 접수되지 않는다(부분 접수 0).
   * 거절 details: { reason: "required_missing" | "not_applicable", question_ids } | { reason: "single_requires_one_item" } · 질문 버전이 어긋나면 conflict.
   */
  submitAnswers(slug: string, edition: number, stage: string, round: string, input: SubmitInput, idempotencyKey: string | undefined): Promise<CommandResult<SubmitResult>>;
  /** 이 라운드의 모든 의견 스레드. 읽는 길이 없으면 NotConnectedError */
  getComments(slug: string, edition: number, stage: string, round: string): Promise<CommentThreadView[]>;
  /** 질문별 의견 — thread_id 없으면 새 스레드 + 첫 메시지, 있으면 메시지만. 답·제출은 만들지 않는다. 멱등 키 필수 */
  addComment(slug: string, edition: number, questionId: string, input: CommentInput, idempotencyKey: string | undefined): Promise<CommandResult<{ thread_id: string; message_id: string; thread_created: boolean }>>;

  /**
   * 결과 글 첨언 · 후속(U4b · SEL-112) — 서버 계약은 SEL-99(U4a). 읽기: 그 글(object)의 첨언 스레드 전부(열림 · 해결됨 · 후속 상세 포함), 없으면 [] · 모르는 판 [].
   * 쓰기는 멱등 키 필수(없으면 invalid_payload) · 거절은 PesApiError(409 basis_changed · thread_closed · already_resolved · 403 human_required …) · 모두 사람만 하는 일이다(소유자 세션).
   * 성공 표시는 영수증 뒤에만 — 화면은 영수증을 받은 뒤 읽기를 다시 한다(낙관적 갱신 없음).
   */
  getAnnotations(slug: string, edition: number, objectId: string): Promise<AnnotationThreadView[]>;
  createAnnotation(slug: string, edition: number, input: AnnotationInput, idempotencyKey: string | undefined): Promise<CommandResult<{ thread_id: string; message_id: string; anchor_id: string; anchor_status: "exact" | "moved" }>>;
  replyAnnotation(slug: string, edition: number, threadId: string, input: { body_md: string }, idempotencyKey: string | undefined): Promise<CommandResult<{ thread_id: string; message_id: string }>>;
  /** 해결 ≠ 반영: 결과의 applied 는 늘 false 다(글은 해결로 바뀌지 않는다) */
  resolveAnnotation(slug: string, edition: number, threadId: string, input: { resolution: FollowupKind; reason: string; target_stage?: StageKey; base_version_id?: string }, idempotencyKey: string | undefined): Promise<CommandResult<{ thread_id: string; state: "resolved"; followup_id: string | null; applied: false }>>;
  /** 다시 붙이기(사람만) — 구간은 code point. version_id 를 주면 그 글 버전 기준. basis_version_id = 구간을 고른 글 버전(글의 현재 버전이 아니면 서버가 409 basis_changed, 아무것도 안 쓴다) */
  reanchorAnnotation(slug: string, edition: number, threadId: string, input: { version_id?: string; basis_version_id?: string } & CpRange, idempotencyKey: string | undefined): Promise<CommandResult<{ thread_id: string; anchor_status: AnchorStatus }>>;
  /** 후속 제안(적용하지 않는다). target_stage = 단계 키 — next_round_task · reopen_stage 는 서버가 그 단계 id 를 요구한다 */
  proposeFollowup(slug: string, edition: number, input: { origin_thread_id: string; kind: FollowupKind; description: string; target_stage?: StageKey }, idempotencyKey: string | undefined): Promise<CommandResult<{ followup_id: string; state: "proposed" }>>;
  /** 후속 채택(사람만) — base_version_id = 후속이 제안된 기반 글 버전 · expected_rev = FollowupDetail.version_no(문자열 그대로) */
  applyFollowup(slug: string, edition: number, followupId: string, input: { base_version_id: string; expected_rev: string }, idempotencyKey: string | undefined): Promise<CommandResult<{ followup_id: string; state: FollowupState; result_version_id: string | null; applied_tx_id: string | null }>>;

  /** 이 클라이언트가 못 하는 일(정직하게 알린다). 없으면 모두 된다 */
  readonly capabilities?: { questionTools?: boolean };
}

/** 아직 서버에 이어지지 않은 일 — 지어내서 성공시키지 않는다 */
export class NotConnectedError extends Error {
  constructor(what = "이 기능") {
    super(`${what}은(는) 아직 서버에 이어지지 않았어요.`);
    this.name = "NotConnectedError";
  }
}
