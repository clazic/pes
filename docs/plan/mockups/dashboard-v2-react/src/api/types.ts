/**
 * PES API 모양 — 시안용 타입.
 *
 * 근거: docs/plan/stage-1-api.md(2절 결정·3절 값·6절 동작 표·6.1 WEB15 명령), stage-3.md(REF1·MAT1),
 * docs/plan/ui/dashboard-v2.md(화면 → 명령 대응). 이름이 계획에 없는 것은 `status: "미정"`과 근거(G 번호)를 붙였다.
 *
 * 이 시안은 네트워크를 쓰지 않는다. 화면은 이 타입만 보고, 실제 구현에서는 같은 타입을 PES HTTP API 클라이언트가 채운다.
 * 내부 식별자(provider 값 등)는 화면에 그대로 내보내지 않는다. 화면 글자는 components/pes/status-registry.ts 와 각 화면이 정한다.
 */

export const FORMAT_VERSION = "1.0" as const;

/** rev·control_rev·fence·event_seq 는 정규화한 10진 문자열(API 결정 5). JS Number로 바꾸지 않는다. */
export type DecimalString = string;
export type IsoTime = string;

/* ───────────── 봉투·오류·영수증 (API 결정 4·3절 오류 봉투) ───────────── */

export type ApiErrorCode =
  | "policy_blocked" // AI가 읽기: 막음·차단 중, AI 참조 금지 등. 자동 재시도 금지
  | "version_conflict" // 그사이 폼·결과·정책 rev가 바뀜
  | "permission_denied" // 서버가 권한을 다시 검사해 거절(단추를 숨기는 것은 권한 검사가 아님)
  | "lease_lost"
  | "cursor_invalid"
  | "duplicate_slug"
  | "usage_blocked" // 사용량 문턱·비용 상한·확인 기록 없음
  | "cost_cap_missing" // 쓴 만큼 과금 연결에 비용 상한이 없음(사용자 결정 2026-11-05)
  | "connection_test_failed"
  | "rate_limited"
  /** 보내기 전에 끊김 — 서버에 닿지 않았음이 확실할 때만(Codex F07) */
  | "network_unreachable"
  /** 보낸 뒤 응답을 못 받음 — 접수됐는지 모름. 같은 키로 확인해야 함(Codex F07) */
  | "result_unknown";

export interface ApiError {
  format_version: typeof FORMAT_VERSION;
  error: {
    code: ApiErrorCode;
    /** 한국어 문장. 화면에 그대로 쓸 수 있다. */
    message: string;
    /** 같은 요청을 자동으로 다시 보내도 되는가 */
    retryable: boolean;
    /** 문제 필드의 JSON 경로 */
    target?: string;
    details?: Record<string, string>;
    next_action?: string;
  };
  request_id: string;
}

/** 서버 영수증(mutation_commits). “됨”은 이것을 받은 뒤에만 쓴다(설계 P5). */
export interface Receipt {
  /** 화면에 보이는 접수 번호 */
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

/* ───────────── 명령 목록 (닫힌 업무 명령, API 결정 1) ───────────── */

export type CommandStatus = "계획" | "미정";

export interface CommandSpec {
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** P = /api/v1/projects/{id} */
  path: string;
  /** 담당 이슈 */
  owner: string;
  status: CommandStatus;
  /** 사람(소유자)만 */
  humanOnly?: boolean;
  note?: string;
}

/** 쓰기 명령. 시안의 모든 단추는 이 이름 중 하나로만 바뀐다(“검증된 쓰기 경로 하나”). */
export const COMMANDS = {
  "project.create": { method: "POST", path: "/api/v1/projects", owner: "PR13 · WEB3", status: "계획", humanOnly: true, note: "소유자·처음 정책·1판을 한 tx(실패하면 아무것도 없음), 중복 slug·멱등" },
  "project.register": { method: "POST", path: "/api/v1/project-registrations", owner: "PR14 · PR20a · WEB3", status: "계획", humanOnly: true, note: "방식 B 등록. 기기 승인 자격" },
  "device.approve": { method: "POST", path: "/auth/device/*", owner: "WEB2", status: "계획", humanOnly: true },
  "question.create": { method: "POST", path: "P/questions", owner: "PR14 · PR8 · U2", status: "계획" },
  "question.revise": { method: "POST", path: "P/questions/{q}/revisions", owner: "PR14 · PR8 · U2", status: "계획" },
  "submission.create": { method: "POST", path: "P/submissions", owner: "PR14 · PR8 · U2", status: "계획", note: "당시 폼 버전 검증, 부분 접수 없음" },
  "run.start": { method: "POST", path: "P/runs", owner: "PR13 · U5", status: "계획", humanOnly: true },
  "run.resume": { method: "POST", path: "(미정)", owner: "PR8 resume_ready · PR19 · PR20a~c", status: "미정", humanOnly: true, note: "사람의 ‘계속’. 2단계 닫힌 경로 목록에 없음(G4)" },
  "run.interrupt": { method: "POST", path: "P/runs/{r}/interrupt", owner: "PR14", status: "계획" },
  "run.cancel": { method: "POST", path: "P/runs/{r}/cancel", owner: "PR14", status: "계획" },
  "run.handoff": { method: "POST", path: "P/runs/{r}/handoffs", owner: "PR14", status: "계획" },
  "stage.approve": { method: "POST", path: "P/stages/{s}/approve", owner: "PR14 · PR6", status: "계획", humanOnly: true },
  "stage.reopen": { method: "POST", path: "P/stages/{s}/reopen", owner: "PR14 · PR6", status: "계획", humanOnly: true },
  "thread.create": { method: "POST", path: "P/threads", owner: "U4", status: "계획" },
  "thread.message": { method: "POST", path: "P/threads/{t}/messages", owner: "U4", status: "계획" },
  "thread.resolve": { method: "POST", path: "P/threads/{t}/resolutions", owner: "U4", status: "계획" },
  // 계획 문서(stage-1-api 6절)의 경로 이름은 POST P/policies/<기존 제공사 이름>/revisions — AI 연결 일반화로 이름을 다시 정한다(0013 일부 변경 필요).
  "policy.api_transfer.revise": { method: "POST", path: "P/policies/…/revisions (이름 재검토)", owner: "PR14 · PR10", status: "계획", humanOnly: true, note: "화면 이름은 ‘AI가 읽기’(허용/막음 — 4차 사용자 결정)" },
  "project.ai_connection.set": { method: "POST", path: "(미정)", owner: "PR10 · PR19", status: "미정", humanOnly: true, note: "프로젝트가 쓸 AI 연결·모델. 다음 실행부터(0013 일부 변경 필요)" },
  "ai_connection.create": { method: "POST", path: "(미정)", owner: "PR19 · WEB4", status: "미정", humanOnly: true, note: "AI 연결 수동 등록(사용자 결정 2026-11-05). 키는 응답에 다시 싣지 않음" },
  "ai_connection.test": { method: "POST", path: "(미정)", owner: "PR19", status: "미정", humanOnly: true, note: "PES 서버가 연결을 시험. 브라우저가 외부 API를 직접 부르지 않음" },
  "ai_connection.models.refresh": { method: "POST", path: "(미정)", owner: "PR19", status: "미정", humanOnly: true },
  "ai_connection.key.replace": { method: "POST", path: "(미정)", owner: "PR19 · WEB4", status: "미정", humanOnly: true },
  "ai_connection.limits.set": { method: "POST", path: "(미정)", owner: "PR19 · WEB7", status: "미정", humanOnly: true, note: "멈춤 문턱(구독형) · 비용 상한(쓴 만큼 과금, 필수)" },
  "usage.extra_usage.confirm": { method: "POST", path: "(미정)", owner: "PR19 · WEB7", status: "미정", humanOnly: true, note: "추가 요금 꺼짐 확인 기록 — 저장 자리 미정(G1)" },
  "usage.baseline.set": { method: "POST", path: "(미정)", owner: "PR19", status: "미정", humanOnly: true, note: "다른 앱 사용량 기준점(G2)" },
  "dispatch.settle": { method: "POST", path: "(미정)", owner: "PR19 · WEB7", status: "미정", humanOnly: true, note: "확인 안 된 호출 정리(outbound_dispatches unknown)" },
  reference_attach: { method: "POST", path: "(REF1)", owner: "REF1", status: "계획", humanOnly: true },
  reference_detach: { method: "POST", path: "(REF1)", owner: "REF1", status: "계획", humanOnly: true },
  reference_refresh: { method: "POST", path: "(REF1)", owner: "REF1", status: "계획", humanOnly: true },
  file_upload: { method: "POST", path: "P/uploads → PUT P/uploads/{u} → POST P/uploads/{u}/complete", owner: "PR13 · PR9 · MAT1", status: "계획", note: "폴더 안 상대 경로를 함께 받음(폴더째 올리기 — MAT1 확장, 사용자 결정 2026-11-05)" },
  "upload_batch.create": { method: "POST", path: "(미정)", owner: "MAT1", status: "미정", note: "폴더째 올리기 묶음: 진행률·일부 실패를 한 묶음으로 보여 줌" },
  file_extract: { method: "POST", path: "(MAT1)", owner: "MAT1", status: "계획" },
  file_ai_access_set: { method: "POST", path: "(MAT1)", owner: "MAT1", status: "계획", humanOnly: true, note: "파일 여러 개를 한 tx로(폴더 단위 켜기·끄기) — 묶음 형태는 MAT1에서 확정" },
  "sync.link.create": { method: "POST", path: "P/sync-links", owner: "WEB15", status: "계획", humanOnly: true },
  "sync.link.revoke": { method: "DELETE", path: "P/sync-links/{l}", owner: "WEB15", status: "계획" },
  "sync.pause": { method: "POST", path: "(미정)", owner: "WEB15", status: "미정", note: "동기화 일시 중지(sync_links.status='paused')" },
  "sync.conflict.resolve": { method: "POST", path: "P/sync-links/{l}/conflicts/{c}/resolve", owner: "WEB15", status: "계획", humanOnly: true },
  // 5차(2026-11-08): 연구 공간 — 막힌 것·풀 것 보드 · AI 동료(설계 16절)
  "problem.resolve": { method: "POST", path: "(미정)", owner: "U3 · U4 · U5 · (새) 막힌 것 보드", status: "미정", note: "막힌 것 하나에 고른 선택지 하나 — 그 종류의 업무 처리(글 수정 제안 · 결정·가정 기록 · 사람→AI 질문 · 실행 넘기기/취소 · 자료 정리)와 해결 기록을 한 tx로. 선택지는 서버가 문제 종류별 닫힌 목록으로 검사(설계 16.4)" },
  "decision.record": { method: "POST", path: "P/assumptions · P/decisions", owner: "U3", status: "계획", note: "AI가 남긴 가정·결정 제안을 사람이 받아들이거나 버림 — 판단자 · 근거 버전 기록" },
} as const satisfies Record<string, CommandSpec>;

export type PesCommand = keyof typeof COMMANDS;

/** 읽기. SPA는 화면마다 JSON 읽기 경로가 필요하다 — 서버 렌더 계획에는 없던 것(0017 영향, G24). */
export const READS = {
  capabilities: { method: "GET", path: "/api/v1/capabilities", owner: "PR13 · PR14", status: "계획" },
  "projects.list": { method: "GET", path: "(미정)", owner: "PR14 · WEB1", status: "미정", note: "공개 JSON 목록 경로가 2단계 닫힌 목록에 없음(G24)" },
  workspace: { method: "GET", path: "P/workspace", owner: "U1", status: "계획", note: "지금 할 일은 서버가 계산(G22). 5차: 연구 개요(연구 질문·핵심 발견) · 막힌 것·풀 것 · 지금 할 일 순서 · AI 제안도 같은 읽기 묶음(설계 16.6)" },
  changes: { method: "GET", path: "P/changes?cursor=", owner: "PR14", status: "계획" },
  "files.list": { method: "GET", path: "(MAT1)", owner: "MAT1", status: "계획" },
  "usage.summary": { method: "GET", path: "(미정)", owner: "PR19 · WEB7 · WEB12", status: "미정" },
  "ai_connections.list": { method: "GET", path: "(미정)", owner: "PR19", status: "미정", note: "키 값은 싣지 않음(끝 4자리·저장 위치만)" },
  "computer.summary": { method: "GET", path: "(미정)", owner: "WEB15", status: "미정" },
  "notifications.list": { method: "GET", path: "(WEB8)", owner: "WEB8", status: "계획" },
} as const satisfies Record<string, CommandSpec>;

export type PesRead = keyof typeof READS;

/* ───────────── 공통 값 ───────────── */

export type Role = "owner" | "editor" | "reader";
export type Mode = "A" | "B";
export type StageKey = "plan" | "research" | "analyze" | "write" | "verify" | "publish";

export const STAGES: StageKey[] = ["plan", "research", "analyze", "write", "verify", "publish"];

/** 화면에 보이는 단계 이름(glossary·현행 STAGES 그대로) */
export const STAGE_LABEL: Record<StageKey, string> = {
  plan: "기획",
  research: "조사",
  analyze: "분석·종합",
  write: "집필",
  verify: "검증",
  publish: "산출·공유",
};
export const STAGE_SHORT: Record<StageKey, string> = {
  plan: "기획",
  research: "조사",
  analyze: "분석",
  write: "집필",
  verify: "검증",
  publish: "산출",
};

/** 상태 칩 하나 = 영역 + 값(+화면에 덧붙일 짧은 글자). 모양·색·기본 글자는 상태 사전이 정한다. */
export interface StatusRef {
  domain: StatusDomain;
  value: string;
  /** 기본 글자 대신 쓸 글자(예: “답할 질문 2”, “올리는 중 63%”) */
  label?: string;
}

export type StatusDomain =
  | "run"
  | "ask"
  | "timeline"
  | "computer"
  | "sync"
  | "refresh"
  | "transfer"
  | "meter"
  | "resetBasis"
  | "extraUsage"
  | "baseline"
  | "costCap"
  | "connTest"
  | "upload"
  | "extract"
  | "aiAccess"
  | "reference"
  | "question"
  | "answer"
  | "submission"
  | "stage"
  | "reflection"
  | "anchor"
  | "notify"
  | "device"
  | "turn"
  | "check"
  | "problem"
  | "problemState"
  | "claim"
  | "proposal"
  | "generic";

/* ───────────── AI 연결 (사용자 결정 2026-11-05: 수동 등록, 특정 서비스 비의존 — 0013 일부 변경 필요) ───────────── */

/** 종류. 화면 글자: 구독형 API / OpenAI 호환 API / Anthropic API / Google API / 직접 입력 */
export type AiConnectionKind = "subscription" | "openai_compatible" | "anthropic" | "google" | "custom";
/** 과금 방식. 화면 글자: 구독 한도 안 / 쓴 만큼 과금 */
export type BillingType = "subscription" | "metered";

/**
 * 구독형 연결의 구간 하나(5시간·주간·월간).
 * 추정 = API 회사 화면에서 본 숫자(확인한 시각에 사람이 API 회사 화면에서 본 계정 전체 사용률) + 확인한 시각 이후 PES가 센 증분 + 아직 정산 안 된 예약.
 * 확인한 시각 이전 PES 사용은 그 숫자에 이미 들어 있으므로 다시 더하지 않는다(중복 집계 없음 — Codex F03).
 */
export interface UsageWindow {
  key: "h5" | "week" | "month";
  estimated_percent: number;
  t0_console: number | null;
  pes_since_t0: number;
  reserved: number;
  resets: { at: string | null; basis: "api" | "estimate" | "unknown" | "human"; text: string };
  pes_runs: number;
}

export interface AiModel {
  id: string;
  available: boolean;
  /** 사용량 가중치를 아는가(구독형) */
  weight_known?: boolean;
  /** 쓴 만큼 과금: 단가 근거 */
  price?: { source: "provider" | "human" | "unknown"; text: string };
  is_default?: boolean;
}

export interface AiConnection {
  id: string;
  name: string;
  kind: AiConnectionKind;
  endpoint: string;
  /** 키 값은 다시 보내지 않는다. 끝 4자리·저장 위치·바꾼 사람만 */
  key: { last4: string; storage: "os_keychain" | "server_secret"; set_at: string; set_by: string };
  billing: BillingType;
  owner: string;
  models_source: "loaded" | "manual";
  models_listed_at: string | null;
  models: AiModel[];
  test: { state: "ok" | "failed" | "never" | "testing"; at: string | null; message: string };
  /** 구독형 */
  subscription?: {
    stop_percent: number;
    windows: UsageWindow[];
    extra_usage: { applicable: boolean; state: "confirmed" | "expiring" | "expired" | "none" | "billing"; last: string | null; by: string | null; valid_until: string | null };
    /** API 회사 화면에서 본 숫자. 0은 그 구간에서 API 회사 화면이 0을 보여 준 경우에만. “다른 앱 안 씀”은 확인한 시각 이후에 대한 선언일 뿐 과거 0의 증거가 아님 */
    baseline: { state: "entered" | "stale" | "none" | "not_used"; t0: string | null; h5: number | null; week: number | null; month: number | null; no_other_use_after_t0: boolean };
  };
  /** 쓴 만큼 과금 — 비용 상한 필수(없으면 실행을 시작하지 않음) */
  metered?: {
    cap: { amount: number; currency: "KRW" | "USD"; period: "month"; set_by: string; set_at: string } | null;
    spent_estimate: { amount: number; as_of: string };
    state: "set" | "near" | "reached" | "missing" | "price_unknown";
  };
  used_by: string[];
}

/* ───────────── 프로젝트 목록 ───────────── */

export type StageView = "approved" | "current_you" | "current_ai" | "current_blocked" | "stale" | "pending";

/**
 * 차례 — 지금 누가 움직일 차례인가(설계 1.3 · 3.3 · 15절, 4차 사용자 결정 2026-11-05).
 * 서버 읽기 묶음이 사람·권한별로 계산해 싣는다(화면이 추측하지 않음 — Codex F08). 목록·작업 공간·사이드바·휴대폰이 같은 값을 쓴다.
 * - you: 나의 할 일 — 지금 이 사람이 할 수 있는 일이 있음(지금 할 일 1~5순위)
 * - ai: AI 작업 중 — 실행이 담당을 잡고 진행(6순위). 움직임은 fresh(관측 근거가 시험값 안)일 때만(15.3)
 * - waiting: 기다림 — 다른 사람(소유자·API 연결 관리자)이나 시각을 기다림, 내 할 일 아님
 * - done: 끝남 — 판 완료 · 누구의 할 일도 없음
 */
export interface TurnView {
  side: "you" | "ai" | "waiting" | "done";
  /** you: 나의 할 일 수 — 서버의 “나의 할 일” 목록에서 이 범위(프로젝트)의 항목 수. 목록 표·사이드바 배지와 같은 셈 */
  count?: number;
  /** you: 먼저 할 일 한 줄 · ai: 지금 하는 일 한 줄(A 실행기 사건 · B 도우미·AI 도구 보고) · waiting: 무엇을 기다리는지 */
  text?: string;
  /** you: 바로 가기(먼저 할 일의 동작) */
  action?: { label: string; href: string };
  /** ai: 차례가 AI로 넘어간(실행이 담당을 잡은) 시각 — 경과 시간 */
  since?: IsoTime;
  /** ai: 마지막 진행 소식 시각 */
  last_signal?: IsoTime;
  /** ai: 소식이 시험값 안에 있는가(서버 판단). false면 움직이지 않고 “소식 없음”(stage-3 2.6 — 답이 없으면 없다고) */
  fresh?: boolean;
}

export interface ProjectCard {
  slug: string;
  title: string;
  edition: number;
  mode: Mode;
  /** A: 모델 이름, B: 도구 이름(도구가 알린 값) */
  runner_label: string;
  api_transfer: StatusRef;
  stages: { key: StageKey; view: StageView }[];
  /** 차례 밖의 줄(AI · 내 컴퓨터/사용량/참고 …). 차례는 turn이 말한다 */
  lines: { label: string; status?: StatusRef; text: string }[];
  foot: [string, string];
  current: string;
  table: { ai: string; last: string };
  href: string;
  /** 서버가 읽을 때 계산해 싣는다(시안은 목 클라이언트가 붙임) */
  turn?: TurnView;
  /** 막힌 것·풀 것 중 아직 열린 수(나의 할 일 · AI 작업 중 · 기다림 모두) — 연구 공간 보드와 같은 계산(5차) */
  problems_open?: number;
}

export interface TurnItem {
  id: string;
  /** 어느 프로젝트의 일인가 — 프로젝트별 “나의 할 일 n건”을 같은 목록에서 센다 */
  slug: string;
  rank: 1 | 2 | 3 | 4 | 5 | 6;
  status: StatusRef;
  project_title: string;
  where: string;
  /** 차례 표시기에 쓰는 짧은 한 줄(“조사 R2 질문 2”) — 서버가 따로 준다(N19) */
  short: string;
  text: string;
  since: string;
  action: { label: string; href: string; primary?: boolean };
  /** 연구 공간 “지금 할 일” 순서에서 이 일이 여는 단계(answer · review · sync · refs · resume · blocked · approve · p-<문제>) — 서버가 준다(5차) */
  step?: string;
  /** 같은 순위 안 순서(서버: 기한 → 오래된 것) */
  order?: number;
}

export interface ProjectsView {
  scene_time: string;
  /** 나의 할 일 — 지금 이 사람이 할 수 있는 일만(서버가 사람·권한별로 계산 — Codex F08). 휴대폰도 같은 순서 */
  turns: TurnItem[];
  /** 기다리기만 할 수 있는 막힘·다른 사람 차례 — 순위 밖 정보(AI 작업 중인 프로젝트는 각 카드의 turn이 말함) */
  waiting: { slug: string; project_title: string; text: string; who: string }[];
  active: ProjectCard[];
  archived_count: number;
  legacy: { title: string; note: string }[];
  failed_cards: { code: string; last_received: string }[];
}

/* ───────────── 작업 공간 읽기 묶음 (GET P/workspace, U1 — G22) ───────────── */

export interface NowItem {
  rank: 1 | 2 | 3 | 4 | 5 | 6;
  /** 막힘·내 답·승인·계속·확인·기다림 */
  kind: "blocked" | "answer" | "approve" | "resume" | "check" | "wait";
  title: string;
  /** 첫눈에 보일 짧은 사실 2~3개(예: “필수 1개 남음”, “기한 11-07 18:00”) — 정보 밀도 원칙(설계 14절) */
  facts?: string[];
  /** 설명 문장 — 화면에서는 “자세히” 안에 둔다 */
  detail: string;
  action: { label: string; href: string };
  hint?: string;
  then: { label: string; href: string }[];
  /** 권한이 없는 사람에게 보일 문장 */
  for_others?: string;
}

export interface ChoiceOption {
  id: string;
  label: string;
}

export interface QuestionView {
  id: string;
  number: string;
  version: number;
  source: "ai" | "bank" | "human" | "legacy";
  source_label: string;
  importance: "높음" | "보통" | "낮음";
  required: boolean;
  recheck?: { diff: { removed: string; added: string; note: string }; old_answer: string };
  meta: string;
  text: string;
  help?: string;
  options: ChoiceOption[];
  default_option?: string;
  allow_comment_as_answer: boolean;
  sent?: { answer: string; by: string; at: string; receipt_no: string };
  /** 보류(빼기의 한 갈래 — 지우지 않음, 새 폼 버전). 보류한 질문은 답할 질문·필수 수에서 빠진다 */
  deferred?: { by: string; at: string };
}

export interface ReflectionRow {
  opinion: string;
  result: "applied" | "partial" | "deferred" | "rejected";
  evidence: string;
  judged: string;
}

export interface Citation {
  kind: "source" | "file" | "ref" | "before_off";
  label: string;
  href: string;
}

export interface ResultParagraph {
  text: string;
  highlighted?: boolean;
  cites: Citation[];
  /** 글 수정 제안(채택 전) — 결과 글은 아직 그대로이고, 채택하면 다음 버전이 된다(U4). 막힌 것을 “고쳐 쓰기”로 풀었을 때 */
  pending_edit?: string;
}

export interface RunRow {
  id: string;
  where: string;
  runner: string;
  status: StatusRef;
  started: string;
  last: string;
  selected?: boolean;
}

export interface TimelineJob {
  time: string;
  title: string;
  body: string;
  files?: string[];
}

export interface SyncRow {
  id: string;
  item: string;
  direction: "up" | "down";
  status: StatusRef;
  version: string;
  action?: "resolve" | "open_web";
}

export interface ReferenceView {
  id: string;
  title: string;
  status: StatusRef;
  pinned: string;
  new_version?: string;
  scope: string;
  to_api: { status: StatusRef; text: string };
  to_b: { status: StatusRef; text: string };
}

export interface WorkspaceView {
  scene_time: string;
  slug: string;
  title: string;
  edition: number;
  mode: Mode;
  runner_label: string;
  owner: string;
  members: string;
  current: { stage: StageKey; round: string; label: string };
  api_transfer: StatusRef;
  strip: { k: string; v: string }[];
  now: NowItem;
  ai_card: { title: string; status: StatusRef; line: string; foot: string };
  /** B: 내 컴퓨터 카드, A: API 사용량 카드 */
  third_card:
    | {
        kind: "computer";
        device: string;
        status: StatusRef;
        checked: string;
        /** 핵심 상태 줄에 쓰는 짧은 값(예: “14:12 확인”) */
        short?: string;
        line: string;
        foot: string;
        /** 도우미 연결 · AI 도구 · 업무 실행/담당을 따로(Codex F09) */
        observations: { k: string; v: string }[];
      }
    | { kind: "usage"; connection: string; status: StatusRef; short?: string; line: string; foot: string };
  /** state_text가 없으면 상태 사전(stage)의 이름을 쓴다 — “현재 · 나의 할 일”처럼 차례 말은 사전 한 곳에서 */
  stages: { key: StageKey; view: StageView; state_text?: string; rounds?: { label: string; state: string; current?: boolean }[] }[];
  nav_counts: { questions: number; files: number; refs_new: boolean };
  form: { version: number; answerable: number; total: number; required_left: number; round_label: string; questions: QuestionView[]; asks_count: number };
  reflection: { title: string; summary: StatusRef; rows: ReflectionRow[] } | null;
  /** meta_short = 제목 아래 한 줄(예: “v4 · 채택 14:03”), meta = 전체(제출자·기반·모델 이름 근거) — “결과물 정보”에 */
  result: { eyebrow: string; title: string; meta: string; meta_short?: string; status: StatusRef; paragraphs: ResultParagraph[] } | null;
  annotations: { no: number; who: string; at: string; quote: string; anchor: StatusRef; note: string; body: string }[];
  references: ReferenceView[];
  approval: { stage_label: string; reasons: string[]; note: string };
  runs: { mode_label: string; continue_reason: string; rows: RunRow[]; lanes: { done: TimelineJob[]; running: TimelineJob[]; planned: TimelineJob[] }; running_empty: string; planned_note: string };
  asks: { number: string; who: string; text: string; steps: StatusRef[] }[];
  local_permission?: { text: string; note: string };
  control_scope?: { status: StatusRef; text: string; note: string };
  sync?: { folder_label: string; device: string; summary: string; rows: SyncRow[] };
  conflict?: { item: string; pc: string[]; web: string[] };
  /** 차례(15절) — 서버가 목록과 같은 계산으로 싣는다(시안은 목 클라이언트가 읽을 때 붙임) */
  turn?: TurnView;

  /* ── 5차(2026-11-08): 연구 공간(설계 16절) — 같은 읽기 묶음에 실린다. 서버가 계산하고 화면은 그린다 ── */
  /** 연구 개요: 연구 질문 · 범위 · 핵심 발견 · 다음 마일스톤 */
  brief: ResearchBrief;
  /** 막힌 것·풀 것 — 아직 안 풀린 것만(나의 할 일 · AI 작업 중 · 기다림). 해결된 것은 problem_log */
  problems: ProblemView[];
  /** 해결 기록(지우지 않음, 최근 것부터) */
  problem_log: ProblemRecord[];
  /** AI가 남긴 가정·결정 제안(U3) */
  proposals: ProposalView[];
  /** 지난 단계 결과 요약(승인본) — 단계 길에서 다시 보기 */
  stage_summaries: Partial<Record<StageKey, StageSummary>>;
  /** 지금 할 일 순서 — 나의 할 일 목록(사람·권한별)에서 이 프로젝트 항목을 단계로 묶은 것 + 다음 마일스톤 */
  tasks: TaskStep[];
}

/** 정적 목 자료(작업 공간 읽기의 바탕). 연구 공간 칸은 목 클라이언트가 읽을 때 계산해 붙인다(실제로는 서버). */
export type WorkspaceCore = Omit<WorkspaceView, "brief" | "problems" | "problem_log" | "proposals" | "stage_summaries" | "tasks">;

/* ───────────── 연구 공간 (5차 — 설계 16절) ───────────── */

/**
 * 막힌 것·풀 것의 종류. 연구 내용(content) 셋 + 진행(progress) 넷.
 * 화면 글자·모양은 상태 사전(problem)이 정한다.
 */
export type ProblemKind =
  | "weak_evidence" // 근거 부족한 주장
  | "conflict_data" // 서로 어긋나는 자료
  | "verify_failed" // 검증 실패 — 출처가 주장을 뒷받침하지 않음
  | "required_question" // 답 안 한 필수 질문
  | "run_stopped" // AI 실행 멈춤(사용량 · 연결 끊김)
  | "sync_conflict" // 동기화 충돌
  | "extract_failed"; // 글자 뽑기 실패한 자료

export const PROBLEM_GROUP: Record<ProblemKind, "content" | "progress"> = {
  weak_evidence: "content",
  conflict_data: "content",
  verify_failed: "content",
  required_question: "progress",
  run_stopped: "progress",
  sync_conflict: "progress",
  extract_failed: "progress",
};

/** 선택지 하나 — 원인 한 줄 → 선택지 2~3개(추천 표시) → 한 번에 처리(설계 16.4) */
export interface ProblemOption {
  id: string;
  /** 동사로 끝나는 짧은 말(단추 글자로도 씀) */
  label: string;
  /** 고르면 무엇이 바뀌는지 한 줄 */
  effect: string;
  recommended?: boolean;
  /** 추천 이유(ⓘ) — 추천은 제안일 뿐 미리 고르지 않는다 */
  why?: string;
  /** 이 선택이 쓰는 닫힌 명령 하나 */
  via: PesCommand;
  /** 이 화면에서 처리하지 않고 그 자리로 가는 선택(예: 질문으로 가서 답하기) */
  go?: string;
  /** 처리 전에 더 받을 것: 메모(필수) · 확인 안 된 호출 정리(근거·이유 — 정리 대화 상자) */
  needs?: "note" | "settle";
  owner_only?: boolean;
  /** 고르면 그 일이 AI에게 넘어감(문제 상태 → AI 작업 중) */
  to_ai?: boolean;
}

export interface ProblemView {
  id: string;
  kind: ProblemKind;
  /** 나의 할 일(사람이 고를 차례) · AI 작업 중(사람이 맡김) · 기다림(다른 사람·시각) — 해결됨은 기록으로 옮겨 감 */
  state: "open" | "ai" | "waiting";
  title: string;
  /** 원인 한 줄 */
  cause: string;
  /** 관련 위치로 바로 가기(문단 · 자료 · 질문 · 실행) */
  where: { label: string; href: string };
  /** 결과 글 문단(0부터) — 그 문단에 표시가 붙는다 */
  paragraph?: number;
  /** 문단 안 문제 부분(밑줄) */
  quote?: string;
  options: ProblemOption[];
  /** 누가·언제 찾았나(“AI 점검 · 조사 R2 · 14:05”) */
  found: string;
  /** 무엇을 막는가(“단계 승인” · “다음 실행”) */
  blocks: string[];
  /** 상태 보충(“AI에게 맡김 15:02 — 내 컴퓨터 AI가 받아야 시작”) */
  note?: string;
}

export interface ProblemRecord {
  id: string;
  kind: ProblemKind;
  title: string;
  /** 고른 것 */
  choice: string;
  /** 고른 선택지 id(그 문제 종류의 닫힌 목록 안) */
  option?: string;
  by: string;
  at: string;
  receipt_no: string;
  note?: string;
}

export interface ResearchBrief {
  /** 연구 질문 */
  question: string;
  /** 범위 한 줄 */
  scope: string;
  /** 핵심 발견 3~5개(없으면 빈 목록 — 0으로 채우지 않음). problem_id가 있으면 그 문제 상태로 근거 칩을 계산 */
  findings: { id: string; text: string; basis: StatusRef; where: string; href: string; problem_id?: string }[];
  /** 다음 마일스톤 — 남은 것은 승인 준비 이유 + 막는 문제로 화면이 센다 */
  milestone: { title: string; note: string };
}

export interface StageSummary {
  /** 승인(누가 · 언제) */
  approved: string;
  /** 대표 결과물 */
  result: string;
  points: string[];
  href: string;
}

export interface ProposalView {
  id: string;
  kind: "assumption" | "decision";
  text: string;
  basis: string;
  by: string;
  at: string;
  state: StatusRef;
}

/**
 * 지금 할 일 순서의 한 단계(설계 16.3). id가 주소의 ?t= 값이다.
 * counted=true는 나의 할 일 항목(목록 표 · 사이드바 수와 같은 셈), false는 읽기·마일스톤처럼 세지 않는 단계.
 */
export interface TaskStep {
  id: string;
  kind: "answer" | "review" | "problem" | "sync" | "refs" | "resume" | "blocked" | "approve" | "wait";
  problem_id?: string;
  title: string;
  /** 순서 줄에 쓰는 짧은 말(“질문 2”) */
  short: string;
  counted: boolean;
  status: StatusRef;
}

/* ───────────── 자료 (MAT1 + 폴더째 올리기) ───────────── */

export interface FileRow {
  id: string;
  name: string;
  /** 폴더째 올린 파일의 폴더 안 상대 경로(폴더 이름 포함). 실제 내 컴퓨터 경로는 보내지 않는다. */
  folder: string | null;
  format: string;
  version: string;
  size: string;
  by: string;
  at: string;
  extract: StatusRef;
  extract_note?: string;
  access: "allow" | "deny" | "na";
  access_note?: string;
  used: string;
  used_note?: string;
  pc: StatusRef | null;
  action: string;
  upload_percent?: number;
}

export interface MaterialsView {
  scene_time: string;
  now: NowItem;
  kpi: { k: string; v: string; s: string; meter?: number }[];
  files: FileRow[];
  failed_upload: string;
  from_refs: { file: string; ref: string; origin_access: StatusRef | null; effect: string; status: StatusRef; status_note?: string }[];
  history: { no: number; state: StatusRef; who: string; why: string }[];
}

/** 폴더째 올리기 — 올리기 전 미리 보기(브라우저가 계산, 서버에 아직 아무것도 없음) */
export interface UploadCandidate {
  path: string;
  size: number;
  /** 미리 보기 판정 */
  verdict: "ok" | "unsupported" | "too_large" | "hidden" | "same_name" | "same_content";
  note?: string;
  access: "allow" | "deny";
}

/* ───────────── 사용량 ───────────── */

export interface UsageView {
  scene_time: string;
  now: NowItem;
  connections: AiConnection[];
  blocked: {
    project: string;
    run: string;
    where: string;
    stopped: string;
    reason: string;
    model: string;
    connection: string;
    reset: string;
    checks: { item: string; detail: string; pass: boolean }[];
  } | null;
  unknown_calls: { id: string; run: string; at: string; what: string; reserve: string; evidence_hint: string }[];
  flow: { time: string; title: string; body: string; state: "past" | "now" | "next" }[];
  rank: { label: string; value: number; tip: string; external?: boolean }[];
  projects: { title: string; mode: Mode; connection: string; model: string; limit: string; status: StatusRef | null; note?: string }[];
  ops: { resource: string; used: string; limit: string; percent: number | null; status: StatusRef }[];
  /**
   * 사용량 추이(시안 2차, 차트 하나) — 연결 하나의 5시간 구간 추정 사용률을 시각별로.
   * est = 그 시각의 추정(API 회사 화면에서 본 숫자 t0 + 확인한 시각 이후 PES 증분 + 예약), proj = 재개 가능 시각까지의 예상(PES 추정).
   * 읽기 경로는 사용량 요약(PR19/WEB7/WEB12)에 붙인다고 가정 — 새 쓰기 없음.
   */
  trend: { connection: string; window: UsageWindow["key"]; stop_percent: number; points: { t: string; est?: number; proj?: number; note?: string }[] };
}

/* ───────────── 내 컴퓨터 · 알림 ───────────── */

export interface ComputerView {
  devices: { name: string; helper: string; status: StatusRef; checked: string; projects: number }[];
  links: { project: string; folder: string; tool: string; scope: StatusRef; scope_note: string }[];
  approvals: { at: string; device: string; result: StatusRef }[];
}

export interface NotificationItem {
  id: string;
  title: string;
  at: string;
  channel: string;
  delivery: StatusRef;
  href: string;
  unread: boolean;
  /** 어느 프로젝트의 알림인가 — 화면 글자에는 싣지 않고, 연구 공간의 “이 프로젝트 알림만” 거르기에만 쓴다(5차) */
  slug?: string;
}

/* ───────────── 변경 알림 (WEB1 · 설계 3.5) ───────────── */

/** 알림 통로로 오는 것: “새 사건 있음”과 번호만. 내용은 싣지 않는다. */
export interface ChangeNotice {
  project: string;
  event_seq: DecimalString;
}

/** GET P/changes?cursor= 의 한 tx 묶음. 화면은 바뀐 읽기만 다시 가져온다. */
export interface ChangeTx {
  event_seq: DecimalString;
  /** 시안은 사용자 전체 통로 하나만 쓴다. 실제로는 열린 프로젝트마다 통로 + 사용자 통로(목록·알림). */
  project?: string;
  touched: ("workspace" | "files" | "usage" | "projects" | "notifications" | "computer")[];
  /** 사람이 할 일이 생긴 사건만 화면 읽기 프로그램에 알린다(설계 3.5) */
  human_action?: string;
}

export interface ChangesPage {
  cursor: string;
  txs: ChangeTx[];
}
