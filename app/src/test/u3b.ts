import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FORMAT_VERSION, PesApiError, type CommandResult, type PesClient } from "@/api/types";
import { renderApp, type Env } from "@/test/render-app";
import { createScriptedClient, timeoutError } from "@/test/scripted-client";
import { base, url } from "@/test/contract";
import { ready } from "@/test/ui";

/**
 * SEL-94 U3b 시험 계약 — 가정·결정·반영 화면과 다음 라운드 첫머리 반영 요약(앱).
 * 이슈(stage-3.md U3 · 2.4절), UI 결정 4 · F03 · F04 · F06 · F08, 설계 dashboard-v2.md 359행 · 610~613행, 승인 시안(AiPartner 의 제안 카드 · ResultPanel 의 반영 내역 표)에서 뽑은 해석이다.
 * 구현을 추측해서 맞춘 것이 아니다. 이름을 바꿔야 하면 구현이 아니라 이 파일(과 보고서의 해석)을 고치고 leader 에게 알린다. 합성 자료뿐(실제 자료·키·경로 없음).
 * 시안의 mock 자료 · mock-client 는 가져오지 않았다(구조 · 문구 · 상호작용만 기준).
 *
 * [근거 링크가 보고서·산출물로 가는 경우 — SEL-86 병합 뒤 병합 조건]
 *   source.href 가 `/<slug>/reports/…` · `/<slug>/out/…`(서버가 내주는 보고서 · 산출물 HTML)이면 앱 안 라우터 이동이 아니라 **같은 탭 전체 이동**이다.
 *   시험은 그 링크가 평범한 <a href="그 주소"> 이고 target 이 없음(같은 탭)임을 못 박는다. 같은 탭이라 앱 화면의 열린 초안이 사라질 수 있으므로,
 *   SEL-86(보고서 · 산출물 주소) 병합 뒤에 주소 모양(/<slug>/reports · out)이 그대로인지 다시 확인해야 한다. 앱 안 주소(`/p/…`)는 라우터 링크로 새로 고침 없이 이동한다.
 *
 * [화면 주소 · 위치 — 스스로 정한 해석]
 *   - 기록 화면: `/p/:slug/e/:edition/records` (사이드바 · 머리줄 셸 안, `main` 하나, 화면 제목 `[data-screen-title]` h1 "가정·결정·반영").
 *   - 다음 라운드 첫머리 반영 요약: 작업 공간 라운드 화면(`/p/:slug/e/:edition/s/:stage/r/:round`) 본문 맨 위, 화면 제목 바로 뒤 · U1d "기록" 영역보다 앞.
 *   - 기록 화면은 세 영역 region "가정" · "결정" · "반영 내역", 각각 안에 표 하나(caption 이 영역 이름을 포함, th scope="col").
 *
 * [PesClient 확장 — '정한 인터페이스' (types.ts 에 추가, U3a 서버 계약 SEL-93 의 라우트 POST P/assumptions · P/decisions · P/reflections 를 HTTP 클라이언트가 채운다. http 매핑 시험은 U3a 병합 뒤)]
 *   읽기(봉투 없는 값):
 *     getAssumptions(slug, edition): Promise<AssumptionRow[]>
 *     getDecisions(slug, edition): Promise<DecisionRow[]>
 *     getReflections(slug, edition, stage, round): Promise<ReflectionView | null>   round = 숫자 문자열 또는 "start". null = 서버가 반영 자료를 주지 않음(이전된 프로젝트)
 *   쓰기(멱등 키 하나 → CommandResult<{ object_id, version_id }> ; 거절은 PesApiError):
 *     assessAssumption(slug, edition, objectId, input: { verdict: "confirm" | "reject" | "revise"; rationale: string; statement?: string }, idempotencyKey)
 *     adoptDecision(slug, edition, objectId, input: { base_version_id: string; rationale: string }, idempotencyKey)
 *     supersedeDecision(slug, edition, objectId, input: { base_version_id: string; statement: string; rationale: string }, idempotencyKey)   // 새 결정을 만든다(옛 결정은 덮어쓰지 않음)
 *     revokeDecision(slug, edition, objectId, input: { base_version_id: string; rationale: string }, idempotencyKey)
 *   모양은 AssumptionRow · DecisionRow · ReflectionView 아래 타입. 기계 값만 싣고 화면 글자(상태 낱말 · 범위 이름)는 앱이 만든다. 시험의 가짜 클라이언트(createU3Client)가 이 모양을 그대로 돌려준다.
 *
 * [표시 어휘 — 화면 계약]
 *   가정 상태(state): proposed → "판단 전" · confirmed → "확인" · rejected → "틀림" · revised → "고침". 제안자는 따로 "AI 제안"(proposed_by.kind = ai) / "사람 제안".
 *   결정 상태: proposed → "제안" · adopted → "채택" · superseded → "대체됨" · revoked → "철회". 범위: project → "프로젝트" · edition → "이 판".
 *   반영 처리(disposition): applied → "적용" · partial → "부분" · deferred → "유예" · rejected → "거절". 증거가 모자란 applied/partial 은 "적용"/"부분"이라 쓰지 않고 "증거 없음"이라 쓴다.
 *   후속 종류: edit_text → "글 수정" · next_round_task → "다음 라운드 할 일" · reopen_stage → "앞 단계 다시 열기". 후속 상태 낱말: proposed → "제안" · applied → "적용" (그 밖은 시험 대상 아님).
 *   요약 낱말: 제출된 반영 의견이 없으면(submission = "none") "미제출", 제출됐는데 처리 줄이 없으면 "처리 0건", reflection 자체가 null/가정·결정이 [] 이면 "기록 없음". 세 가지는 서로 다른 낱말이다.
 *   사람 판단 없음: confirmed/adopted 인데 판단자가 없거나 AI(kind = ai)면 "사람 판단 없음"이라 쓰고 "확인"/"채택"이라 쓰지 않는다(DB CHECK 는 판단자 non-null 만 본다 — AI 를 사람으로 보이게 하지 않음).
 *   재확인: needs_review = true 는 상태가 confirmed 여도 "재확인 필요"로 쓰고 자동 확인처럼 보이지 않는다(새 판 복사본 포함).
 *
 * [표 칸 — data 속성 (행 요소에 붙는다)]
 *   행: 가정 [data-assumption="<object_id>"][data-state=<state>][data-needs-review="true|false"] · 결정 [data-decision="<object_id>"][data-state=<state>][data-scope=project|edition]
 *       · 반영 [data-reflection="<id>"][data-disposition=<disposition>][data-evidence="ok|missing|none"]  (none = rejected/deferred 라 증거를 요구하지 않음)
 *   칸 [data-cell="…"]: statement · state · proposer · judge(판단자/결정자 — 없으면 이름 없음) · version · rationale · source(근거 링크) · scope(결정) · original(고침의 원문) · copied-from · supersedes · superseded-by
 *       · 반영: opinion · state · rationale · judge · evidence(적용 tx · 결과 버전 · 후속) · source.
 *   결정 행은 id="decision-<object_id>", 대체한 결정 칸의 링크는 그 id 의 쪽 주소(#decision-<id>)로 간다.
 *   반영 요약 막대 [data-reflection-bar] 안 조각 [data-seg="applied|partial|deferred|rejected|unverified"] — 글자(낱말 + 개수)가 있다(색만으로 알리지 않음). 증거 없는 줄은 applied/partial 에 세지 않고 unverified("증거 없음") 에 센다.
 *
 * [동작 — 사람 판단 단추와 확인 대화 상자 (F06)]
 *   가정 판단 단추(행 안): "확인" · "틀림" · "고침" → 누르면 role=dialog "가정 확인" | "가정 틀림" | "가정 고침". textbox "근거"(확인은 선택, 틀림 · 고침은 필수), 고침은 textbox "고친 가정"(기존 문장이 채워져 있고 바뀌어야 함).
 *   결정 단추: 제안 → "채택" / 채택 → "대체" · "철회" / 대체됨 · 철회 행은 단추 없음. 대화 상자 "결정 채택" | "결정 대체" | "결정 철회", textbox "근거"(채택은 선택, 대체 · 철회는 필수), 대체는 textbox "새 결정".
 *   보내기 단추는 모두 "판단 기록", 닫기 "취소". 필수 칸이 비면 클라이언트를 부르지 않고 그 칸이 aria-invalid="true" + 이유 글.
 *   보내는 동안 단추는 disabled 가 아니라 aria-disabled="true"(초점 유지)이고 두 번 눌러도 한 번만 보낸다. 보낸 뒤 영수증이 오기 전에는 "접수 확인 중"이고 성공 말(접수 번호 · 바뀐 상태)이 없다 — 행은 영수증 뒤 다시 읽어 바뀐다(낙관적 갱신 없음).
 *   성공: role=status 에 "접수 <receipt_no>" · 대화 상자 닫힘 · 초점은 document.body 가 아님. 거절(PesApiError): role=alert 에 서버 메시지, 대화 상자와 입력한 글 그대로, 행 그대로.
 *   시간 초과(TimeoutError): "접수 확인 중"(실패 아님) 유지, 다시 "판단 기록"을 누르면 **같은 멱등 키**로 보낸다(서버가 replayed 영수증을 돌려줌).
 *   모든 단추 묶음은 [data-print="hide"] 안(인쇄에는 표만). 휴대폰(390, 굵은 포인터)에서도 단추가 있고 44px 이상.
 *
 * [e2e 가 기대하는 앱 기본 가짜 클라이언트 자료 — sample-study 판 1, 이 파일의 U3 fixture 와 같은 id]
 *   가정 as-1(proposed · AI 제안) · as-2(confirmed · 사람), 결정 dec-2(adopted) · dec-4(proposed), 반영 research/2: applied(증거 ok) 한 줄 이상 + deferred 한 줄 이상.
 */

/* ───────────── 타입(정한 인터페이스) ───────────── */

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
  assessed_at: string | null;
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
  kind: "edit_text" | "next_round_task" | "reopen_stage";
  state: "proposed" | "accepted" | "applied" | "deferred" | "rejected";
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
  sent_count: number | null;
  entries: ReflectionEntry[];
}

/** 네 쓰기 모두 사람이 본 버전(base_version_id)을 싣는다 — 현재 행의 version_id 와 다르면 서버는 rev_conflict 로 거절한다 */
export interface AssessInput {
  verdict: "confirm" | "reject" | "revise";
  base_version_id: string;
  rationale: string;
  statement?: string;
}
export interface U3Methods {
  getAssumptions(slug: string, edition: number): Promise<AssumptionRow[]>;
  getDecisions(slug: string, edition: number): Promise<DecisionRow[]>;
  getReflections(slug: string, edition: number, stage: string, round: string): Promise<ReflectionView | null>;
  assessAssumption(slug: string, edition: number, objectId: string, input: AssessInput, idempotencyKey: string | undefined): Promise<CommandResult<{ object_id: string; version_id: string }>>;
  adoptDecision(slug: string, edition: number, objectId: string, input: { base_version_id: string; rationale: string }, idempotencyKey: string | undefined): Promise<CommandResult<{ object_id: string; version_id: string }>>;
  supersedeDecision(slug: string, edition: number, objectId: string, input: { base_version_id: string; statement: string; rationale: string }, idempotencyKey: string | undefined): Promise<CommandResult<{ object_id: string; version_id: string }>>;
  revokeDecision(slug: string, edition: number, objectId: string, input: { base_version_id: string; rationale: string }, idempotencyKey: string | undefined): Promise<CommandResult<{ object_id: string; version_id: string }>>;
}

/* ───────────── 합성 자료 ───────────── */

const AI: Actor = { id: "act-ai", kind: "ai", name: "조사 AI" };
export const HUMAN: Actor = { id: "act-h1", kind: "human", name: "검토자 하늘" };
const stamp = "2026-11-05T14:03:00+09:00";

export const RECORDS = `${base}/records`;
export const ROUND_RESEARCH_2 = url("research", 2);
export const PLAN_REPORT = "/sample-study/reports/plan.html";
export const OUT_DOC = "/sample-study/out/final.html";
export const R1_RESULT = url("research", 1);

const a = (id: string, over: Partial<AssumptionRow>): AssumptionRow => ({
  object_id: id,
  version_id: `${id}-v1`,
  version: 1,
  statement: `가정 ${id}`,
  state: "proposed",
  proposed_by: AI,
  assessed_by: null,
  assessed_at: null,
  needs_review: false,
  rationale: "",
  original: null,
  copied_from: null,
  source: null,
  ...over,
});

export const ASSUMPTIONS: AssumptionRow[] = [
  a("as-1", { statement: "도서관 방문 수의 정의는 2019년부터 같다고 본다", source: { label: "조사 R1 결과 글 v1", href: R1_RESULT } }),
  a("as-2", { statement: "공개 통계의 대출 수는 도서 반납분을 뺀 값이다", state: "confirmed", version: 2, assessed_by: HUMAN, assessed_at: stamp, rationale: "공개 통계 정의서와 대조했다", source: { label: "기획 보고서", href: PLAN_REPORT } }),
  a("as-3", { statement: "어린이 이용자는 보호자 방문과 겹치지 않는다", state: "rejected", version: 2, assessed_by: HUMAN, assessed_at: stamp, rationale: "보호자 동반 방문이 같이 집계된다" }),
  a("as-4", {
    statement: "방문 수는 2021년 이전과 이후를 나눠서 본다",
    state: "revised",
    version: 2,
    assessed_by: HUMAN,
    assessed_at: stamp,
    rationale: "2021년에 방문 집계 정의가 바뀌었다",
    original: { version_id: "as-4-v1", statement: "방문 수는 2019년부터 같은 정의다" },
  }),
  a("as-5", { statement: "노년층 이용 자료는 연령 구간이 같다", state: "confirmed", version: 3, assessed_by: HUMAN, assessed_at: stamp, needs_review: true, copied_from: { edition: 1, label: "이전 판에서 복사" } }),
  a("as-6", { statement: "야간 개관 시간은 해마다 같다", state: "confirmed", version: 2, assessed_by: AI, assessed_at: stamp }),
];

const d = (id: string, over: Partial<DecisionRow>): DecisionRow => ({
  object_id: id,
  version_id: `${id}-v1`,
  version: 1,
  statement: `결정 ${id}`,
  state: "proposed",
  scope: "project",
  proposed_by: AI,
  decided_by: null,
  rationale: "",
  supersedes: null,
  superseded_by: null,
  originated_from: null,
  source: null,
  ...over,
});

export const DECISIONS: DecisionRow[] = [
  d("dec-1", { statement: "비교 기간은 2019년부터 지금까지로 한다", state: "superseded", decided_by: HUMAN, rationale: "처음 범위", superseded_by: "dec-2" }),
  d("dec-2", {
    statement: "비교 기간은 2021년부터 지금까지로 한다",
    state: "adopted",
    decided_by: HUMAN,
    version: 2,
    rationale: "집계 정의가 2021년에 바뀜",
    supersedes: { object_id: "dec-1", statement: "비교 기간은 2019년부터 지금까지로 한다" },
    source: { label: "분석 보고서", href: OUT_DOC },
  }),
  d("dec-3", { statement: "어린이와 노년층은 따로 묶어 본다", state: "adopted", scope: "edition", decided_by: HUMAN, originated_from: { label: "1판 결정", version: 2 } }),
  d("dec-4", { statement: "기관 내부 자료는 쓰지 않는다", state: "proposed", source: { label: "조사 R1 결과 글 v1", href: R1_RESULT } }),
  d("dec-5", { statement: "민간 통계도 비교에 넣는다", state: "revoked", decided_by: HUMAN, rationale: "공개 자료가 아니다" }),
];

const e = (id: string, over: Partial<ReflectionEntry>): ReflectionEntry => ({
  id,
  opinion: `의견 ${id}`,
  source: null,
  disposition: "applied",
  rationale: "",
  actor: HUMAN,
  applied_tx_id: null,
  result_version: null,
  followup: null,
  ...over,
});
const fu = (over: Partial<FollowupView>): FollowupView => ({ id: "fu-1", kind: "next_round_task", state: "applied", label: "후속", result_version: null, ...over });

export const R_APPLIED = e("rf-1", { opinion: "표에 연도별 합계를 넣어 주세요", disposition: "applied", rationale: "합계 줄을 더했다", applied_tx_id: "tx-0901", result_version: { label: "조사 결과 글 v3", href: ROUND_RESEARCH_2 }, source: { label: "첨언 12", href: R1_RESULT } });
export const R_PARTIAL = e("rf-2", { opinion: "노년층 자료를 더 찾아 주세요", disposition: "partial", rationale: "일부만 찾음", applied_tx_id: "tx-0902", followup: fu({ id: "fu-2", kind: "next_round_task", state: "applied", label: "R3 에서 노년층 자료 더 찾기" }) });
export const R_DEFERRED = e("rf-3", { opinion: "시군구별로 나눠 주세요", disposition: "deferred", rationale: "자료가 없어 다음 판으로", followup: fu({ id: "fu-3", kind: "reopen_stage", state: "proposed", label: "기획 단계 다시 열기 제안" }) });
export const R_REJECTED = e("rf-4", { opinion: "민간 통계를 섞어 주세요", disposition: "rejected", rationale: "연구 범위 밖" });
export const R_UNVERIFIED = e("rf-5", { opinion: "그래프를 넣어 주세요", disposition: "applied", rationale: "넣었다고 함", applied_tx_id: null, result_version: null });

/** 증거가 모자란 applied/partial 변형 — 어느 하나도 성공(“적용”/“부분”)으로 보이면 안 된다 */
export const CORRUPT: Record<string, ReflectionEntry> = {
  "tx 없음 + 결과 있음": e("bad-1", { disposition: "applied", applied_tx_id: null, result_version: { label: "결과 글 v9", href: ROUND_RESEARCH_2 } }),
  "tx 있음 + 결과·후속 없음": e("bad-2", { disposition: "applied", applied_tx_id: "tx-0990" }),
  "tx 있음 + 후속이 제안 상태": e("bad-3", { disposition: "partial", applied_tx_id: "tx-0991", followup: fu({ id: "fu-9", kind: "next_round_task", state: "proposed", label: "제안일 뿐" }) }),
  "tx 있음 + 글 수정 후속인데 결과 버전 없음": e("bad-4", { disposition: "applied", applied_tx_id: "tx-0992", followup: fu({ id: "fu-8", kind: "edit_text", state: "applied", label: "글 고침", result_version: null }) }),
  "partial 인데 tx 없음": e("bad-5", { disposition: "partial", applied_tx_id: null, followup: fu({ id: "fu-7", kind: "next_round_task", state: "applied", label: "할 일" }) }),
};

export const REFLECTION_FULL: ReflectionView = { submission: "submitted", sent_count: 5, entries: [R_APPLIED, R_PARTIAL, R_DEFERRED, R_REJECTED, R_UNVERIFIED] };

export interface U3Data {
  assumptions: AssumptionRow[];
  decisions: DecisionRow[];
  /** 키 = "<stage>/<round>" */
  reflections: Record<string, ReflectionView | null>;
}
export const fullData = (): U3Data => ({ assumptions: structuredClone(ASSUMPTIONS), decisions: structuredClone(DECISIONS), reflections: { "research/2": structuredClone(REFLECTION_FULL) } });
/** 이전된 합성 프로젝트: 가정·결정·반영 모두 없음 */
export const migratedData = (): U3Data => ({ assumptions: [], decisions: [], reflections: { "research/2": null } });

/* ───────────── 가짜 U3 클라이언트 ───────────── */

export function apiConflict(message = "현재 상태에서는 처리할 수 없는 요청입니다.") {
  return new PesApiError({ format_version: FORMAT_VERSION, error: { code: "conflict", message, retryable: false, next_action: "reread_context" }, request_id: "req-u3b" });
}

export interface CmdCall {
  method: "assessAssumption" | "adoptDecision" | "supersedeDecision" | "revokeDecision";
  objectId: string;
  input: Record<string, unknown>;
  key: string | undefined;
}

/**
 * 가짜 클라이언트 위에 U3 읽기·쓰기를 얹는다. 쓰기는 서버처럼 행을 바꾸고(다시 읽으면 반영) 멱등 키가 같으면 처음 영수증을 replayed 로 돌려준다.
 * hold(): 다음 쓰기를 release() 까지 붙잡는다 · failNext(err): 다음 쓰기를 거절 · loseReplyNext(): 서버는 처리했지만 답이 시간 초과로 사라진다.
 */
export function createU3Client(data: U3Data, workspacePatch?: (w: unknown) => unknown) {
  const s = createScriptedClient();
  const store = structuredClone(data);
  const cmds: CmdCall[] = [];
  const reads: { method: string; args: unknown[] }[] = [];
  const done = new Map<string, CommandResult<{ object_id: string; version_id: string }>>();
  let seq = 904;
  let nextObj = 6;
  let holdGate: Promise<void> | null = null;
  let release: () => void = () => {};
  let failure: Error | null = null;
  let lose = false;
  const broken = new Set<string>();

  const result = (objectId: string, key: string | undefined) => {
    const n = String(++seq).padStart(4, "0");
    const r: CommandResult<{ object_id: string; version_id: string }> = {
      format_version: FORMAT_VERSION,
      request_id: `req-${n}`,
      receipt: { receipt_no: n, tx_id: `tx-${n}`, committed_at: new Date().toISOString(), idempotency_key: key ?? "", replayed: false },
      data: { object_id: objectId, version_id: `${objectId}-v${seq}` },
    };
    return r;
  };

  async function command(method: CmdCall["method"], objectId: string, input: Record<string, unknown>, key: string | undefined, apply: () => string): Promise<CommandResult<{ object_id: string; version_id: string }>> {
    cmds.push({ method, objectId, input: structuredClone(input), key });
    if (holdGate) await holdGate;
    if (failure) {
      const f = failure;
      failure = null;
      throw f;
    }
    if (key && done.has(key)) return { ...structuredClone(done.get(key)!), receipt: { ...done.get(key)!.receipt, replayed: true } };
    const outId = apply();
    const r = result(outId, key);
    if (key) done.set(key, r);
    if (lose) {
      lose = false;
      throw timeoutError();
    }
    return structuredClone(r);
  }
  /** 서버처럼: 사람이 본 버전이 현재 행의 version_id 와 다르면 rev_conflict(행은 그대로) */
  const guard = (row: { version_id: string }, base: string) => {
    if (base !== row.version_id) throw new PesApiError({ format_version: FORMAT_VERSION, error: { code: "rev_conflict", message: "기준 버전이 현재와 다릅니다.", retryable: false, next_action: "reread_context" }, request_id: "req-u3b" });
  };
  const findA = (id: string) => store.assumptions.find((x) => x.object_id === id)!;
  const findD = (id: string) => store.decisions.find((x) => x.object_id === id)!;

  const u3: U3Methods = {
    async getAssumptions(...args) {
      reads.push({ method: "getAssumptions", args });
      if (broken.has("getAssumptions")) throw new Error("읽기 실패(시험)");
      return structuredClone(store.assumptions);
    },
    async getDecisions(...args) {
      reads.push({ method: "getDecisions", args });
      if (broken.has("getDecisions")) throw new Error("읽기 실패(시험)");
      return structuredClone(store.decisions);
    },
    async getReflections(slug, edition, stage, round) {
      reads.push({ method: "getReflections", args: [slug, edition, stage, round] });
      if (broken.has("getReflections")) throw new Error("읽기 실패(시험)");
      return structuredClone(store.reflections[`${stage}/${round}`] ?? null);
    },
    assessAssumption: (_s, _e, id, input, key) =>
      command("assessAssumption", id, { ...input }, key, () => {
        const row = findA(id);
        guard(row, input.base_version_id);
        if (input.verdict === "revise") {
          row.original ??= { version_id: row.version_id, statement: row.statement };
          row.statement = input.statement ?? row.statement;
        }
        row.state = input.verdict === "confirm" ? "confirmed" : input.verdict === "reject" ? "rejected" : "revised";
        row.assessed_by = HUMAN;
        row.assessed_at = new Date().toISOString();
        row.needs_review = false;
        row.rationale = input.rationale;
        row.version += 1;
        row.version_id = `${id}-v${seq + 1}`;
        return id;
      }),
    adoptDecision: (_s, _e, id, input, key) =>
      command("adoptDecision", id, { ...input }, key, () => {
        const row = findD(id);
        guard(row, input.base_version_id);
        row.state = "adopted";
        row.decided_by = HUMAN;
        row.rationale = input.rationale;
        row.version += 1;
        row.version_id = `${id}-v${seq + 1}`;
        return id;
      }),
    supersedeDecision: (_s, _e, id, input, key) =>
      command("supersedeDecision", id, { ...input }, key, () => {
        const old = findD(id);
        guard(old, input.base_version_id);
        const newId = `dec-${nextObj++}`;
        old.state = "superseded";
        old.superseded_by = newId;
        old.version_id = `${id}-v${seq + 1}`;
        const created = d(newId, { statement: input.statement, state: "adopted", scope: old.scope, decided_by: HUMAN, rationale: input.rationale, supersedes: { object_id: id, statement: old.statement } });
        // 영수증의 version_id(result() 가 ++seq 로 만든다)와 새 저장 행의 version_id 를 맞춘다
        created.version_id = `${newId}-v${seq + 1}`;
        store.decisions.push(created);
        return newId;
      }),
    revokeDecision: (_s, _e, id, input, key) =>
      command("revokeDecision", id, { ...input }, key, () => {
        const row = findD(id);
        guard(row, input.base_version_id);
        row.state = "revoked";
        row.decided_by = HUMAN;
        row.rationale = input.rationale;
        row.version += 1;
        row.version_id = `${id}-v${seq + 1}`;
        return id;
      }),
  };

  const client = { ...s.client, ...u3 } as unknown as PesClient;
  if (workspacePatch) (client as unknown as { getWorkspace: (slug: string, ed: number) => Promise<unknown> }).getWorkspace = async (slug, ed) => workspacePatch(await s.client.getWorkspace(slug, ed));

  return {
    s,
    client,
    store,
    cmds,
    reads,
    readCalls: (method: string) => reads.filter((r) => r.method === method),
    hold() {
      holdGate = new Promise<void>((res) => (release = res));
      return () => {
        holdGate = null;
        release();
      };
    },
    /** 이 읽기 메서드를 계속 실패시킨다 */
    breakRead: (method: "getAssumptions" | "getDecisions" | "getReflections") => void broken.add(method),
    failNext: (err: Error) => void (failure = err),
    loseReplyNext: () => void (lose = true),
  };
}

export type U3Client = ReturnType<typeof createU3Client>;

/* ───────────── 화면 찾기 ───────────── */

export async function boot(data: U3Data = fullData(), path = RECORDS, env: Env = {}, prepare?: (u3: U3Client) => void) {
  const u3 = createU3Client(data);
  prepare?.(u3);
  const user = userEvent.setup();
  const app = await renderApp(path, { width: 1440, ...env }, { client: u3.client });
  await ready();
  return { u3, user, ...app };
}

export const region = (name: string) => screen.getByRole("region", { name });
export const queryRegion = (name: string) => screen.queryByRole("region", { name });

type Kind = "assumption" | "decision" | "reflection";
const attr = (kind: Kind, id: string) => `[data-${kind}="${id}"]`;
export const row = (kind: Kind, id: string) => document.querySelector<HTMLElement>(attr(kind, id));
/** 행이 그려질 때까지 기다린다(읽기는 비동기) */
export async function rowOf(kind: Kind, id: string): Promise<HTMLElement> {
  return waitFor(() => {
    const r = row(kind, id);
    if (!r) throw new Error(`${kind} 행 ${id} 가 아직 없다`);
    return r;
  });
}
export const cell = (r: HTMLElement, name: string) => r.querySelector<HTMLElement>(`[data-cell="${name}"]`);
export const cellText = (r: HTMLElement, name: string) => cell(r, name)?.textContent ?? "";
export const rowButton = (r: HTMLElement, name: string | RegExp) => within(r).getByRole("button", { name });

/** 보이는 글 · aria-label · title 에 낱말 'Go' 가 없다 */
export function goWordsIn(root: HTMLElement = document.body): string[] {
  const texts = [root.textContent ?? "", ...[...root.querySelectorAll("[aria-label],[title],[alt]")].flatMap((n) => [n.getAttribute("aria-label"), n.getAttribute("title"), n.getAttribute("alt")])];
  return texts.filter((t): t is string => !!t && /\bGo\b/.test(t));
}

export const MISSING = /증거 없음/;
