import { MATERIALS } from "@/mocks/materials";
import { AI_ACTIVITY, PROJECTS } from "@/mocks/projects";
import { RESEARCH, type ResearchMock } from "@/mocks/research";
import { COMPUTER, NOTIFICATIONS, USAGE } from "@/mocks/usage";
import { WORKSPACES } from "@/mocks/workspaces";
import { mockSettings, ROLE_PERSON } from "@/lib/mock-settings";
import {
  COMMANDS,
  FORMAT_VERSION,
  PROBLEM_GROUP,
  STAGE_LABEL,
  type AiConnection,
  type ApiError,
  type ApiErrorCode,
  type ChangeNotice,
  type ChangesPage,
  type ChangeTx,
  type CommandResult,
  type CommandSpec,
  type ComputerView,
  type FileRow,
  type MaterialsView,
  type NotificationItem,
  type PesCommand,
  type ProblemKind,
  type ProblemOption,
  type ProblemView,
  type ProjectsView,
  type QuestionView,
  type Receipt,
  type Role,
  type StatusRef,
  type TaskStep,
  type TurnItem,
  type TurnView,
  type UsageView,
  type WorkspaceCore,
  type WorkspaceView,
} from "./types";

/** 문제 종류 짧은 이름(나의 할 일 한 줄 · 해결 기록) — 화면 칩 글자는 상태 사전(problem)에서 */
const KIND_SHORT: Record<ProblemKind, string> = {
  weak_evidence: "근거 부족",
  conflict_data: "자료 어긋남",
  verify_failed: "검증 실패",
  required_question: "필수 질문",
  run_stopped: "실행 멈춤",
  sync_conflict: "동기화 충돌",
  extract_failed: "글자 뽑기 실패",
};

/** 같은 순위 안에서는 서버가 준 순서(order — 기한 → 오래된 것), 그다음 들어온 순서 */
function sortTurns(list: TurnItem[]) {
  return list
    .map((t, i) => ({ t, i }))
    .sort((a, b) => a.t.rank - b.t.rank || (a.t.order ?? 99) - (b.t.order ?? 99) || a.i - b.i)
    .map((x) => x.t);
}

const roundPathOf = (w: WorkspaceCore) => `/p/${w.slug}/e/${w.edition}/s/${w.current.stage}/r/${w.current.round}`;

/** 글 수정 제안(채택 전) — 고쳐 쓰기 선택지를 고르면 그 문단 아래에 보인다(결과 글은 아직 그대로) */
const EDIT_PROPOSAL: Record<string, string> = {
  soften: "이동 거리가 긴 읍·면 지역일수록 신규 인력이 1년 안에 그만두는 경향이 보였다(사례 지역 2곳 면담 · 추정).",
  remove: "(이 문장을 빼는 제안)",
  narrow: "가상의 A시·B군 두 사례 지역에서 요양보호사 1인당 이용자 수는 2022년보다 늘었고, 재가 돌봄의 빈 시간대가 저녁에 몰렸다.",
  official: "표 2 기준으로 2023년 A시 요양보호사는 1,180명이다(공식 통계 — 기관 보고서는 1,240명, 차이는 각주).",
  report: "기관 보고서 기준으로 2023년 A시 요양보호사는 1,240명이다(공식 통계는 1,180명).",
  assume: "2023년 A시 요양보호사는 1,180명(공식 통계) 또는 1,240명(기관 보고서)이다 — 차이는 집계 기준일 차이로 본다(가정).",
};

/** AI 진행 소식(서버가 실행 담당·사건·도우미 보고에서 계산). last_signal이 없으면 아직 AI 소식이 없음 */
interface AiActivity {
  text: string;
  since: string;
  last_signal?: string;
  fresh: boolean;
}
/** 시안의 소식 시험값 — 마지막 소식이 이보다 오래되면 움직이지 않는다(실제 값은 서버 capabilities, SEL-19) */
const FRESH_MINUTES = 10;
const isoAgo = (minutes: number) => new Date(Date.now() - minutes * 60000).toISOString();

/**
 * 목 클라이언트 — 메모리 안의 합성 자료만 바꾼다. 네트워크 호출 없음.
 * 실제 PES와 같은 약속을 흉내 낸다:
 *  - 모든 쓰기는 COMMANDS 의 닫힌 명령 하나로만(검증된 쓰기 경로 하나)
 *  - Idempotency-Key: 같은 키 = 처음 결과 재생(두 번 처리하지 않음)
 *  - 서버가 권한을 다시 검사(단추를 숨기는 것은 권한 검사가 아님)
 *  - 성공은 영수증(접수 번호)과 함께만
 *  - 바뀌면 변경 알림(번호만) → 화면이 GET changes 로 바뀐 읽기만 다시 가져옴
 */

/** 재인증(5단계 step-up)은 요청 한 건(프로젝트·동작·대상/rev)에 묶인다(Codex F01). 2~4단계 로컬은 소유자 세션 확인. */
export interface StepUp {
  method: "passkey" | "email" | "local_owner";
  bound: string;
}

/** 재인증이 필요한 명령 — 정책 변경은 끄기·켜기 모두(stage-5 2.2 계약 유지) */
export const STEP_UP_REQUIRED: string[] = ["policy.api_transfer.revise", "file_ai_access_set", "stage.approve", "stage.reopen", "ai_connection.create", "ai_connection.key.replace", "ai_connection.limits.set", "project.ai_connection.set"];

export interface CommandInputs {
  "submission.create": { slug: string; form_version: number; answers: { question_id: string; text: string }[] };
  "run.start": { slug: string };
  "run.resume": { slug: string; run_id: string };
  "run.interrupt": { slug: string; run_id: string };
  "run.cancel": { slug: string; run_id: string };
  "run.handoff": { slug: string; run_id: string; to: "A" | "B" };
  "stage.approve": { slug: string; stage: string; snapshot: string; note?: string; step_up?: StepUp };
  "policy.api_transfer.revise": { slug: string; allow: boolean; reason?: string; step_up?: StepUp };
  file_ai_access_set: { slug: string; file_ids: string[]; access: "allow" | "deny"; reason?: string; step_up?: StepUp };
  "sync.conflict.resolve": { slug: string; item: string; choice: "pc" | "web" | "later"; reason?: string };
  "sync.pause": { slug: string };
  /** 확인 안 된 호출 정리: 근거·이유 필수. 확인 불가는 예약·차단을 그대로 둔다(Codex F03) */
  "dispatch.settle": { id: string; outcome: "processed" | "not_processed" | "unverifiable"; evidence: string; reason: string };
  "usage.extra_usage.confirm": { connection_id: string };
  "usage.baseline.set": { connection_id: string; t0: string; h5: number | null; week: number | null; month: number | null; no_other_use_after_t0: boolean };
  "ai_connection.create": {
    name: string;
    kind: AiConnection["kind"];
    endpoint: string;
    /** 키는 서버로만 간다. 응답·화면·기록에 다시 싣지 않는다. */
    key: string;
    billing: AiConnection["billing"];
    models: string[];
    stop_percent?: number;
    extra_usage_applicable?: boolean;
    cap?: { amount: number; currency: "KRW" | "USD" } | null;
    step_up?: StepUp;
  };
  "ai_connection.test": { kind: AiConnection["kind"]; endpoint: string; key_present: boolean; key_length: number };
  "ai_connection.models.refresh": { kind: AiConnection["kind"]; endpoint: string };
  "ai_connection.limits.set": { connection_id: string; stop_percent?: number; cap?: number; step_up?: StepUp };
  "project.ai_connection.set": { slug: string; connection_id: string; model: string; step_up?: StepUp };
  "project.create": { name: string; slug: string; connection_id: string; model: string; files: number; refs: number };
  "upload_batch.create": { slug: string; root: string; count: number };
  file_upload: { slug: string; path: string; size: number; access: "allow" | "deny"; folder: string | null; simulateFail?: boolean };
  "device.approve": { code: string; decision: "approve" | "deny" };
  reference_refresh: { slug: string; ref_id: string; mode: "update" | "keep" };
  "thread.create": { slug: string; quote: string; body: string };
  /** direction=human_to_agent: 사람→AI 질문(U5 — AI 동료 칸의 “AI에게 부탁하기”). 없으면 사람이 폼에 질문을 더함 */
  "question.create": { slug: string; text: string; direction?: "human_to_agent"; target?: string };
  /** 질문 빼기의 한 갈래 — 보류(지우지 않음, 새 폼 버전) */
  "question.revise": { slug: string; question_ids: string[]; action: "defer" };
  /** 막힌 것 하나에 고른 선택지 하나(설계 16.4) — 선택지는 서버가 그 문제의 닫힌 목록으로 다시 검사 */
  "problem.resolve": { slug: string; problem_id: string; option_id: string; note?: string };
  "decision.record": { slug: string; proposal_id: string; verdict: "accept" | "reject" };
}

type CmdName = keyof CommandInputs;

export class PesApiError extends Error {
  constructor(public body: ApiError) {
    super(body.error.message);
  }
  get code(): ApiErrorCode {
    return this.body.error.code;
  }
  get retryable() {
    return this.body.error.retryable;
  }
}

function apiError(code: ApiErrorCode, message: string, retryable = false, details?: Record<string, string>, next_action?: string): PesApiError {
  return new PesApiError({ format_version: FORMAT_VERSION, error: { code, message, retryable, details, next_action }, request_id: `req-${Math.random().toString(36).slice(2, 8)}` });
}

const clone = <T,>(v: T): T => structuredClone(v);
const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

function nowLabel() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function minimalMaterials(slug: string, files: FileRow[]): MaterialsView {
  return {
    ...clone(MATERIALS),
    files,
    from_refs: slug === "rural-care-access" ? clone(MATERIALS.from_refs.slice(0, 2)) : [],
    failed_upload: "",
    now: {
      rank: 6,
      kind: "wait",
      title: "자료에 지금 확인할 일이 없습니다",
      detail: "올린 자료의 글자 뽑기가 모두 끝났습니다. 새 자료는 파일이나 폴더째 올릴 수 있습니다.",
      action: { label: "자료 올리기", href: "#upload" },
      then: [],
    },
  };
}

function buildStore() {
  const dolbomFiles = clone(MATERIALS.files);
  return {
    projects: clone(PROJECTS) as ProjectsView,
    workspaces: clone(WORKSPACES) as Record<string, WorkspaceCore>,
    /** 연구 공간(5차): 연구 개요 · 연구 내용 문제 · AI 제안 · 지난 단계 요약 · 해결 기록 */
    research: clone(RESEARCH) as Record<string, ResearchMock>,
    /** 사람이 “없이 진행”·“넘기기”처럼 정리한 진행 문제(다른 자료에서 계산되는 문제) — 다시 계산해도 나오지 않게 */
    dismissed: {} as Record<string, Record<string, true>>,
    materials: {
      "dolbom-insight": clone(MATERIALS),
      "youth-housing": minimalMaterials("youth-housing", dolbomFiles.slice(8, 11).map((f, i) => ({ ...f, id: `y${i}`, folder: null }))),
      "rural-care-access": minimalMaterials("rural-care-access", [dolbomFiles[0]!, dolbomFiles[1]!, dolbomFiles[2]!, dolbomFiles[3]!].map((f, i) => ({ ...f, id: `r${i}` }))),
      "ltc-survey": minimalMaterials("ltc-survey", dolbomFiles.slice(11, 13).map((f, i) => ({ ...f, id: `l${i}`, folder: null }))),
    } as Record<string, MaterialsView>,
    usage: clone(USAGE) as UsageView,
    computer: clone(COMPUTER) as ComputerView,
    notifications: clone(NOTIFICATIONS) as NotificationItem[],
    /** 장면 시각 기준 “몇 분 전”을 시안을 연 시각 기준으로 바꿔 둔다 — 경과 시간이 실제로 흐르게 */
    activity: Object.fromEntries(Object.entries(AI_ACTIVITY).map(([slug, a]) => [slug, { text: a.text, since: isoAgo(a.since_min), last_signal: isoAgo(a.signal_min), fresh: a.fresh }])) as Record<string, AiActivity>,
    seq: 1040,
    log: [] as ChangeTx[],
  };
}

type Store = ReturnType<typeof buildStore>;

export class MockPesClient {
  private store: Store = buildStore();
  constructor() {
    this.initResearchTurns();
  }
  private receipts = new Map<string, { receipt: Receipt; data: unknown; request: string }>();
  private listeners = new Map<string, Set<(n: ChangeNotice) => void>>();
  private receiptNo = 30;
  /** 응답 유실 흉내 동안에는 변경 알림도 늦게 온다(같은 키로 다시 확인할 때 내보냄) */
  private deferEmits = false;
  private deferred: (() => void)[] = [];
  /** 시안 확인용: 실제로 불린 명령 이름 기록 */
  readonly calls: { name: string; at: string; replayed: boolean }[] = [];

  /* ───────── 읽기 ───────── */

  private async readDelay() {
    const s = mockSettings.get();
    if (s.network === "offline") {
      await sleep(350);
      throw apiError("network_unreachable", "서버에 닿지 못했습니다. 연결되면 다시 받습니다.", true);
    }
    await sleep(s.network === "slow" ? 900 : 180);
  }

  /** 서버가 보는 사람·권한별로 나의 할 일을 계산한다(Codex F08). 데스크톱·휴대폰 같은 순서. 권한 밖 일은 “기다림”으로. */
  private viewTurns(role: Role): Pick<ProjectsView, "turns" | "waiting"> {
    const turns = clone(this.store.projects.turns);
    const waiting = clone(this.store.projects.waiting);
    if (role === "owner") return { turns, waiting };
    const moved: ProjectsView["waiting"] = [];
    const kept = turns.filter((t) => {
      const v = t.status.value;
      const move = (text: string, who: string) => {
        moved.push({ slug: t.slug, project_title: t.project_title, text, who });
        return false;
      };
      if (v === "blocked" || t.step === "blocked") return move("실행 멈춤 · 사용량 — 소유자(API 연결 관리자)의 정리를 기다림", "김연구");
      if (t.step === "sync") return move("동기화 충돌 — 고르기는 소유자(편집자 허용은 WEB3에서 정함, 지금은 기본 거부)", "김연구");
      if (t.step === "refs") return move("참고 프로젝트 새 버전 — 갱신·유지는 소유자", "김연구");
      if (t.step?.startsWith("p-")) return move("자료 글자 뽑기 실패 — 다시 올리기·정리는 소유자", "김연구");
      if (v === "resume" || v === "approve") return move(`${t.where} — ${v === "resume" ? "계속" : "승인"}은 소유자가 누릅니다`, "김연구");
      if (role === "reader" && (v === "answer" || v === "start_q")) return move(`${t.where} — 답은 편집자 이상이 보냅니다`, "편집자 이상");
      if (role === "reader" && t.step === "review") return move(`${t.where} — 결과 글 문제 고르기는 편집자 이상`, "편집자 이상");
      return true;
    });
    return { turns: kept, waiting: [...moved, ...waiting] };
  }

  /* ───────── 연구 공간(5차 — 설계 16절): 막힌 것·풀 것 · 지금 할 일 순서 ───────── */

  /**
   * 진행 문제는 이미 있는 자료에서 계산한다 — 같은 사실을 두 곳에 적지 않는다.
   * 필수 질문 미응답(질문 폼) · AI 실행 멈춤(실행 표 + 확인 안 된 호출) · 동기화 충돌(동기화 표) · 글자 뽑기 실패(자료 표).
   * 사람이 고르면 원래 명령(submission.create · dispatch.settle · sync.conflict.resolve)이나 problem.resolve로 풀리고, 풀리면 계산에서 빠진다.
   */
  private derivedProblems(slug: string): ProblemView[] {
    const w = this.store.workspaces[slug];
    if (!w) return [];
    const rp = roundPathOf(w);
    const dismissed = this.store.dismissed[slug] ?? {};
    const out: ProblemView[] = [];

    // 1) 답 안 한 필수 질문 — 라운드마다 하나로 묶는다(질문 수가 많아도 보드가 길어지지 않게)
    const req = w.form.questions.filter((q) => q.required && !q.sent && !q.deferred);
    if (req.length) {
      const one = req.length === 1 ? req[0]! : null;
      const def = one?.default_option ? one.options.find((o) => o.id === one.default_option)?.label : undefined;
      const go = `${rp}?t=answer${one ? `#${one.id}` : ""}`;
      out.push({
        id: `pq-${w.current.stage}-${w.current.round}`,
        kind: "required_question",
        state: "open",
        title: one ? `필수 질문 ${one.number}에 답이 없습니다` : `필수 질문 ${req.length}개에 답이 없습니다`,
        cause: one ? `“${one.text}” — 답이 없어 AI가 다음 일을 정하지 못합니다.` : `${req.map((q) => q.number).join(" · ")} — 답이 없으면 ${w.form.round_label} 다음 실행을 시작하지 않습니다.`,
        where: { label: one ? `질문 ${one.number}` : `${w.form.round_label} 질문`, href: go },
        found: `질문 폼 v${w.form.version} · 서버 준비 검사`,
        blocks: ["다음 실행", "단계 승인"],
        options: [
          { id: "go", label: "질문으로 가서 답하기", effect: "질문 폼을 엽니다. 초안은 이 탭에만 남습니다.", recommended: true, why: "답은 사람만 정할 수 있습니다.", via: "submission.create", go },
          ...(def ? [{ id: "default", label: `기본값 ‘${def}’로 답하기`, effect: "기본값을 답으로 보냅니다. 접수 번호가 남고, 나중에 고쳐 보낼 수 있습니다(옛 답은 남음).", via: "submission.create" as const }] : []),
          { id: "defer", label: one ? "이 질문 보류하기" : `필수 질문 ${req.length}개 보류하기`, effect: "이번 라운드에서 빼고(지우지 않음) 새 폼 버전을 만듭니다. AI는 가정을 적고 이어 가며 다음 라운드에서 다시 묻습니다.", via: "question.revise" },
        ],
      });
    }

    // 2) AI 실행 멈춤(사용량) — 확인 안 된 호출이 남았으면 사람이 풀 일, 정리했으면 시각을 기다림
    for (const run of w.runs.rows.filter((r) => r.status.value === "blocked_usage")) {
      const id = `pr-${run.id}`;
      if (dismissed[id]) continue;
      const unknown = this.store.usage.unknown_calls.length;
      const reset = this.store.usage.blocked?.reset ?? "재개 가능 시각 미확인";
      out.push({
        id,
        kind: "run_stopped",
        state: unknown ? "open" : "waiting",
        title: `실행 ${run.id} — API 사용량 때문에 멈췄습니다`,
        cause: unknown
          ? `5시간 추정 사용률이 멈춤 문턱을 넘었고, 결과를 모르는 호출 ${unknown}건이 남아 있습니다. 정리해야 재개 준비 검사를 통과합니다.`
          : `확인 안 된 호출은 정리됨 · 재개 가능 시각을 기다립니다(${reset}).`,
        where: { label: `실행 ${run.id} · ${run.where}`, href: `/p/${slug}/ai#ai-full` },
        found: `PES 실행기 · ${run.last}`,
        blocks: ["다음 실행"],
        note: unknown ? undefined : "기다리기만 할 수 있는 막힘이라 나의 할 일 수에 넣지 않습니다.",
        options: [
          { id: "settle", label: "확인 안 된 호출 정리하기", effect: "API 회사 화면에서 본 결과(처리됨 · 처리 안 됨 · 확인 불가)와 근거·이유를 적습니다. 같은 호출을 자동으로 다시 하지 않습니다.", recommended: true, why: "정리해야 재개 준비 검사를 통과합니다. 실행을 넘기거나 취소하지 않으니 같은 모델로 이어 갈 수 있습니다.", via: "dispatch.settle", needs: "settle", owner_only: true },
          { id: "handoff", label: "방식 B로 넘기기", effect: "새 실행을 만들어 내 컴퓨터 AI가 이어서 합니다(옛 실행은 기록에 남음). API 사용량을 쓰지 않습니다.", via: "problem.resolve", owner_only: true },
          { id: "cancel", label: "이 실행 취소하기", effect: "실행을 취소합니다. 저장된 결과(연구 설계 초안 v1)는 남습니다.", via: "problem.resolve", owner_only: true },
        ],
      });
    }

    // 3) 동기화 충돌
    for (const row of w.sync?.rows.filter((r) => r.status.value === "conflict") ?? []) {
      const c = w.conflict && w.conflict.item === row.item ? w.conflict : undefined;
      const later = Boolean(row.status.label?.includes("나중에"));
      out.push({
        id: `ps-${row.id}`,
        kind: "sync_conflict",
        state: "open",
        title: `${row.item} — 양쪽에서 바뀌었습니다`,
        cause: c ? `내 컴퓨터 ${c.pc[0]} · 웹 ${c.web[0]}. 어느 쪽도 지우지 않습니다.` : "내 컴퓨터와 웹에서 함께 바뀌었습니다. 어느 쪽도 지우지 않습니다.",
        where: { label: `내 컴퓨터 연결 · ${w.sync?.folder_label ?? "동기화"}`, href: `/p/${slug}/sync#sync` },
        found: `도우미 보고 · ${w.sync?.device ?? "내 컴퓨터"}`,
        blocks: ["이 파일 동기화"],
        note: later ? "나중에 정하기로 함 — 이 파일만 동기화를 멈췄습니다." : undefined,
        options: [
          { id: "web", label: "웹 v3을 내 컴퓨터로 받기", effect: "내 컴퓨터 것은 “충돌 사본”으로 이름을 바꿔 둡니다.", recommended: true, why: "웹 쪽이 더 나중(14:05 · 박검토)에 바뀌었습니다. 어느 쪽을 골라도 지우지 않습니다.", via: "sync.conflict.resolve", owner_only: true },
          { id: "pc", label: "내 컴퓨터 것을 새 버전(v4)으로 올리기", effect: "웹 v3은 버전 기록에 남습니다.", via: "sync.conflict.resolve", owner_only: true },
          ...(later ? [] : [{ id: "later", label: "둘 다 두고 나중에 정하기", effect: "정할 때까지 이 파일만 동기화하지 않습니다.", via: "sync.conflict.resolve" as const, owner_only: true }]),
        ],
      });
    }

    // 4) 글자 뽑기 실패한 자료(실패만 — 일부만·지원 안 함은 자료 화면의 지금 할 일)
    for (const f of this.store.materials[slug]?.files.filter((x) => x.extract.domain === "extract" && x.extract.value === "failed") ?? []) {
      const id = `px-${f.id}`;
      if (dismissed[id]) continue;
      out.push({
        id,
        kind: "extract_failed",
        state: "open",
        title: `${f.name} — 글자를 뽑지 못했습니다`,
        cause: `${f.extract_note ?? "글자 뽑기 실패"}. AI가 이 자료를 읽지 못합니다(사람은 열람할 수 있음).`,
        where: { label: `자료 · ${f.name}`, href: `/p/${slug}/files#${f.id}` },
        found: `글자 뽑기 · ${f.at}`,
        blocks: [],
        options: [
          { id: "reupload", label: "암호를 풀거나 새 파일로 다시 올리기", effect: "자료 화면에서 같은 이름으로 올리면 새 버전이 됩니다(옛 버전은 남음).", recommended: true, why: "손상·암호가 원인이면 다시 뽑아도 같은 결과입니다.", via: "file_upload", go: `/p/${slug}/files#upload`, owner_only: true },
          { id: "skip", label: "이 자료 없이 진행하기", effect: "AI는 이 파일을 읽지 않은 채로 진행합니다. 사람은 계속 열람·인용할 수 있습니다.", via: "problem.resolve", owner_only: true },
          { id: "summary", label: "사람이 요약을 적어 붙이기", effect: "적은 요약을 이 파일의 ‘사람이 적은 글’로 붙여 AI가 그 글만 읽게 합니다.", via: "problem.resolve", needs: "note", owner_only: true },
        ],
      });
    }
    return out;
  }

  /** 연구 내용 문제(정적 목 자료) + 진행 문제(계산) — 주소의 {round}를 현재 라운드로 */
  private problemsFor(slug: string): ProblemView[] {
    const w = this.store.workspaces[slug];
    const r = this.store.research[slug];
    if (!w || !r) return [];
    const rp = roundPathOf(w);
    const content = clone(r.content).map((p) => ({ ...p, where: { ...p.where, href: p.where.href.replace("{round}", rp) } }));
    const all = [...content, ...this.derivedProblems(slug)];
    const order = { open: 0, ai: 1, waiting: 2 } as const;
    return all.map((p, i) => ({ p, i })).sort((a, b) => order[a.p.state] - order[b.p.state] || a.i - b.i).map((x) => x.p);
  }

  /**
   * 역할별로 본 문제 — 그 사람이 고를 수 있는 선택지가 없으면 “기다림”(나의 할 일 아님, F08).
   * 서버가 사람·권한별로 계산하는 나의 할 일과 같은 기준이다.
   */
  private problemsForRole(slug: string, role: Role): ProblemView[] {
    return this.problemsFor(slug).map((p) => {
      if (p.state !== "open") return p;
      if (role === "reader") return { ...p, state: "waiting" as const, note: "고르기는 편집자 이상 — 읽기 멤버는 볼 수만 있습니다." };
      const mine = p.options.some((o) => !o.owner_only);
      if (role === "editor" && !mine) return { ...p, state: "waiting" as const, note: "고르기는 소유자 — 소유자 확인을 기다립니다(김연구)." };
      return p;
    });
  }

  /**
   * 연구 내용 문제 · 글자 뽑기 실패를 나의 할 일 목록에 맞춘다(한 tx에서 함께 바뀌는 흉내).
   * 결과 글 문제는 프로젝트마다 한 줄(“결과 글 문제 n건”), 자료 문제는 문제마다 한 줄.
   */
  private syncResearchTurns(slug: string) {
    const w = this.store.workspaces[slug];
    const r = this.store.research[slug];
    if (!w || !r) return;
    const rp = roundPathOf(w);
    const title = this.store.projects.active.find((p) => p.slug === slug)?.title ?? w.title;
    const old = this.store.projects.turns.filter((t) => t.slug === slug && (t.step === "review" || t.step?.startsWith("p-")));
    const list = this.store.projects.turns.filter((t) => !old.includes(t));
    const open = r.content.filter((p) => p.state === "open");
    if (open.length) {
      const kinds = [...new Set(open.map((p) => p.kind))].map((k) => `${KIND_SHORT[k]} ${open.filter((p) => p.kind === k).length}`).join(" · ");
      const prev = old.find((t) => t.step === "review");
      list.push({
        id: `t-review-${slug}`,
        slug,
        rank: 5,
        status: { domain: "turn", value: "problem", label: `풀 것 ${open.length}` },
        project_title: title,
        where: `${w.form.round_label} · 결과 글`,
        short: `결과 글 문제 ${open.length}`,
        text: kinds,
        since: prev?.since ?? "14:05부터",
        action: { label: "풀기", href: `${rp}?t=review` },
        step: "review",
        order: 4,
      });
    }
    for (const p of this.derivedProblems(slug).filter((x) => x.kind === "extract_failed" && x.state === "open")) {
      const prev = old.find((t) => t.step === `p-${p.id}`);
      list.push({
        id: `t-${p.id}`,
        slug,
        rank: 5,
        status: { domain: "turn", value: "check" },
        project_title: title,
        where: "자료",
        short: "자료 글자 뽑기 실패",
        text: p.title,
        since: prev?.since ?? `${p.found.replace("글자 뽑기 · ", "")}부터`,
        action: { label: "풀기", href: `${rp}?t=p-${p.id}` },
        step: `p-${p.id}`,
        order: 6,
      });
    }
    this.store.projects.turns = sortTurns(list);
  }

  private initResearchTurns() {
    for (const slug of Object.keys(this.store.workspaces)) this.syncResearchTurns(slug);
  }

  /**
   * 지금 할 일 순서(설계 16.3) — 그 사람의 나의 할 일 목록에서 이 프로젝트 항목을 단계로(같은 수), 그 뒤에 세지 않는 단계
   * (남은 선택 질문 · 결과 글 읽기 · 다음 마일스톤). 할 일이 하나도 없으면 맨 앞에 “AI 작업 중 / 기다림”.
   */
  private tasksFor(slug: string, v: Pick<ProjectsView, "turns" | "waiting">, w: WorkspaceCore, problems: ProblemView[], turn: TurnView): TaskStep[] {
    const steps: TaskStep[] = [];
    const add = (s: TaskStep) => {
      if (!steps.some((x) => x.id === s.id)) steps.push(s);
    };
    const contentOpen = problems.filter((p) => PROBLEM_GROUP[p.kind] === "content" && p.state === "open").length;
    for (const t of v.turns.filter((x) => x.slug === slug)) {
      const st = t.step ?? "";
      if (st === "answer") add({ id: "answer", kind: "answer", title: w.current.round === "start" ? "시작 질문에 답하기" : "질문에 답하기", short: `질문 ${w.form.answerable}`, counted: true, status: t.status });
      else if (st === "review") add({ id: "review", kind: "review", title: "결과 글 문제 풀기", short: `결과 글 문제 ${contentOpen}`, counted: true, status: t.status });
      else if (st === "sync") add({ id: "sync", kind: "sync", title: "동기화 충돌 고르기", short: "동기화 충돌", counted: true, status: t.status, problem_id: problems.find((p) => p.kind === "sync_conflict")?.id });
      else if (st === "refs") add({ id: "refs", kind: "refs", title: "참고 프로젝트 새 버전 정하기", short: "참고 새 버전", counted: true, status: t.status });
      else if (st === "resume") add({ id: "resume", kind: "resume", title: "계속 — AI가 이어서 하기", short: "계속", counted: true, status: t.status });
      else if (st === "blocked") add({ id: "blocked", kind: "blocked", title: "멈춘 실행 풀기", short: "실행 멈춤", counted: true, status: t.status, problem_id: problems.find((p) => p.kind === "run_stopped")?.id });
      else if (st === "approve") add({ id: "approve", kind: "approve", title: `${w.approval.stage_label} 단계 승인`, short: `${w.approval.stage_label} 승인`, counted: true, status: t.status });
      else if (st.startsWith("p-")) add({ id: st, kind: "problem", problem_id: st.slice(2), title: problems.find((p) => p.id === st.slice(2))?.title ?? t.text, short: t.short, counted: true, status: t.status });
    }
    if (w.form.answerable > 0 && !steps.some((s) => s.id === "answer")) add({ id: "answer", kind: "answer", title: "남은 질문 보기", short: `질문 ${w.form.answerable}`, counted: false, status: { domain: "question", value: "open", label: "선택 질문" } });
    if (w.result && !steps.some((s) => s.id === "review")) add({ id: "review", kind: "review", title: "결과 글 읽기", short: "결과 글", counted: false, status: { domain: "generic", value: "readable", label: "읽기" } });
    if (!steps.some((s) => s.id === "approve")) {
      const ready = w.approval.reasons.length === 0 && problems.every((p) => !p.blocks.includes("단계 승인"));
      add({ id: "approve", kind: "approve", title: `${w.approval.stage_label} 단계 승인`, short: `${w.approval.stage_label} 승인`, counted: false, status: ready ? { domain: "turn", value: "approve" } : { domain: "generic", value: "notyet", label: "아직" } });
    }
    if (!steps.some((s) => s.counted)) {
      const ai = turn.side === "ai";
      steps.unshift({ id: "wait", kind: "wait", title: ai ? "AI 작업 중 — 진행 보기" : "기다림", short: ai ? "AI 작업 중" : "기다림", counted: false, status: ai ? { domain: "turn", value: turn.fresh ? "ai" : "ai_quiet" } : { domain: "turn", value: "waiting" } });
    }
    return steps;
  }

  /** 핵심 발견의 근거 칩 — 문제와 이어진 발견은 그 문제 상태로(해결되면 고른 길로) */
  private findingsFor(slug: string, problems: ProblemView[]) {
    const r = this.store.research[slug]!;
    const w = this.store.workspaces[slug]!;
    const rp = roundPathOf(w);
    return r.brief.findings.map((f) => {
      const href = f.href.replace("{round}", rp);
      if (!f.problem_id) return { ...f, href };
      const p = problems.find((x) => x.id === f.problem_id);
      if (p) {
        const basis: StatusRef = p.state === "ai" ? { domain: "claim", value: "ai" } : { domain: "problem", value: p.kind };
        return { ...f, href, basis };
      }
      const rec = [...r.log].reverse().find((x) => x.id.startsWith(`rec-${f.problem_id}-`));
      const o = rec?.option;
      const basis: StatusRef =
        o === "keep" ? { domain: "claim", value: "unverified" } : o === "assume" ? { domain: "claim", value: "unverified", label: "가정으로 기록" } : o === "official" || o === "report" ? { domain: "claim", value: "decided" } : { domain: "claim", value: "pending_edit" };
      return { ...f, href, basis };
    });
  }

  private person() {
    return ROLE_PERSON[mockSettings.get().role];
  }

  /** 해결 기록 한 줄(지우지 않음). id는 rec-<문제>-<번호> — 핵심 발견이 고른 길을 찾을 때 씀 */
  private record(slug: string, p: Pick<ProblemView, "id" | "kind" | "title">, choice: string, opts: { option?: string; note?: string; receiptNo?: string } = {}) {
    const r = this.store.research[slug];
    if (!r) return;
    r.log.push({ id: `rec-${p.id}-${r.log.length + 1}`, kind: p.kind, title: p.title, choice, option: opts.option, by: this.person(), at: nowLabel(), receipt_no: opts.receiptNo ?? `${this.receiptNo + 1}`, note: opts.note });
  }

  /**
   * 차례(설계 15절) — 목록 카드와 작업 공간이 같은 계산을 쓴다(같은 DB 상태면 같은 표시 — PR21).
   * 나의 할 일이 있으면 그쪽이 먼저(3.3 순위 1~5가 6보다 앞) → AI 진행 → 기다림.
   * 수(count)는 나의 할 일 목록에서 이 프로젝트의 항목 수 — 목록 표·사이드바 배지와 같은 셈.
   */
  private turnFor(slug: string, v: Pick<ProjectsView, "turns" | "waiting">): TurnView {
    const mine = v.turns.filter((t) => t.slug === slug);
    const top = mine[0];
    if (top) return { side: "you", count: mine.length, text: top.short, action: { label: top.action.label, href: top.action.href } };
    const a = this.store.activity[slug];
    if (a) {
      const fresh = a.fresh && !!a.last_signal && Date.now() - Date.parse(a.last_signal) < FRESH_MINUTES * 60000;
      return { side: "ai", text: a.text, since: a.since, last_signal: a.last_signal, fresh };
    }
    const w = v.waiting.find((x) => x.slug === slug);
    return { side: "waiting", text: w?.text ?? "지금 할 일 없음" };
  }

  async listProjects(): Promise<ProjectsView> {
    await this.readDelay();
    const v = clone(this.store.projects);
    Object.assign(v, this.viewTurns(mockSettings.get().role));
    v.active = v.active.map((p) => ({ ...p, turn: this.turnFor(p.slug, v), problems_open: this.problemsFor(p.slug).length }));
    return v;
  }
  async getWorkspace(slug: string): Promise<WorkspaceView> {
    await this.readDelay();
    const w = this.store.workspaces[slug];
    const r = this.store.research[slug];
    if (!w || !r) throw apiError("permission_denied", "이 프로젝트를 볼 권한이 없거나 프로젝트가 없습니다.", false);
    const role = mockSettings.get().role;
    const v = this.viewTurns(role);
    const turn = this.turnFor(slug, v);
    const problems = this.problemsForRole(slug, role);
    const core = clone(w);
    // 연구 공간 칸(5차) — 실제로는 서버가 같은 읽기 묶음에 계산해 싣는다(설계 16.6)
    return {
      ...core,
      turn,
      brief: { ...clone(r.brief), findings: this.findingsFor(slug, problems) },
      problems,
      problem_log: clone(r.log).reverse(),
      proposals: clone(r.proposals),
      stage_summaries: clone(r.stage_summaries),
      tasks: this.tasksFor(slug, v, w, problems, turn),
    };
  }

  /**
   * 작업 공간의 지금 할 일(답·계속)이 바뀌면 목록의 나의 할 일도 같은 사건으로 바꾼다 — 실제 서버는 한 tx, 시안은 같은 메모리.
   * 그래야 목록 줄 · 사이드바 배지 · 작업 공간 띠의 “나의 할 일 n건”이 서로 같다.
   */
  private syncTurnItem(slug: string) {
    const w = this.store.workspaces[slug];
    if (!w) return;
    const list = this.store.projects.turns;
    const old = list.find((t) => t.slug === slug && ["answer", "start_q", "resume"].includes(t.status.value));
    const roundPath = `/p/${slug}/e/${w.edition}/s/${w.current.stage}/r/${w.current.round}`;
    const title = this.store.projects.active.find((p) => p.slug === slug)?.title ?? w.title;
    const where = old?.where ?? `${w.form.round_label} · 방식 ${w.mode}`;
    let item: TurnItem | null = null;
    if (w.now.kind === "answer" && w.form.answerable > 0) {
      const start = w.current.round === "start";
      const wasAnswer = old && old.status.value !== "resume";
      item = {
        id: old?.id ?? `t-${slug}`,
        slug,
        rank: 2,
        status: { domain: "turn", value: start ? "start_q" : "answer", label: `${start ? "시작 질문" : "답할 질문"} ${w.form.answerable}` },
        project_title: title,
        where,
        short: `${w.form.round_label} 질문 ${w.form.answerable}`,
        text: w.form.required_left ? `필수 ${w.form.required_left}개 남음 · AI는 답을 기다림` : "필수 답 모두 보냄 · 남은 질문은 선택",
        since: wasAnswer ? old.since : "방금",
        action: { label: "답하기", href: wasAnswer ? old.action.href : `${roundPath}${w.now.action.href.startsWith("#") ? w.now.action.href : "?t=answer"}` },
        step: "answer",
        order: old?.order ?? 2,
      };
    } else if (w.now.kind === "resume") {
      item = { id: old?.id ?? `t-${slug}`, slug, rank: 4, status: { domain: "turn", value: "resume" }, project_title: title, where, short: `${w.form.round_label} 계속`, text: "필수 답 모두 보냄 — 계속을 누르면 AI가 이어서 합니다", since: "방금", action: { label: "계속으로 가기", href: `${roundPath}?t=resume` }, step: "resume", order: old?.order ?? 2 };
    }
    const next = old ? (item ? list.map((t) => (t === old ? item! : t)) : list.filter((t) => t !== old)) : item ? [...list, item] : list;
    // 순위대로(같은 순위는 서버 순서 → 원래 순서)
    this.store.projects.turns = sortTurns(next);
  }

  /** 질문 폼이 바뀐 뒤(답 · 보류): 남은 수 · 지금 할 일 · 나의 할 일을 함께 맞춘다(실제로는 같은 tx) */
  private afterFormChange(slug: string) {
    const w = this.ws(slug);
    const open = w.form.questions.filter((q) => !q.sent && !q.deferred);
    w.form.answerable = open.length;
    w.form.required_left = open.filter((q) => q.required).length;
    w.nav_counts.questions = open.length;
    const answeredCount = w.form.questions.filter((q) => q.sent).length;
    w.strip = w.strip.map((c) => (c.k === "답 제출" ? { ...c, v: `${answeredCount} / ${w.form.total}` } : c));
    if (w.form.required_left === 0) {
      w.now = {
        rank: 4,
        kind: "resume",
        title: "AI가 이어서 하도록 ‘계속’을 눌러 주세요",
        facts: [`${w.form.round_label} 필수 답 모두 보냄`],
        detail: `누르면 서버가 질문·폼 버전, 실행 상태${w.mode === "B" ? ", 연결" : ", 사용량"}을 다시 확인합니다.`,
        action: { label: "계속으로 가기", href: "#ai" },
        then: w.now.then,
        for_others: "소유자가 계속을 누르면 이어집니다",
      };
      w.runs.continue_reason = "";
      // 실행은 여전히 사람(계속)을 기다리지만, 기다리는 것이 바뀌었다 — 세 칸이 같은 말을 하게
      w.ai_card = { ...w.ai_card, line: "필수 답을 받았습니다. 소유자가 ‘계속’을 누르면 이어서 합니다." };
      w.runs.running_empty = "지금 진행 중인 작업이 없습니다. AI는 ‘계속’을 기다립니다.";
      w.runs.rows = w.runs.rows.map((r) => (r.selected ? { ...r, last: "필수 답 받음 · ‘계속’ 기다림" } : r));
    } else {
      w.now = { ...w.now, title: `${w.form.round_label} 질문 ${w.form.answerable}개에 답해 주세요`, facts: [`필수 ${w.form.required_left}개 남음`, ...(w.now.facts ?? []).filter((f) => !f.startsWith("필수"))] };
    }
    w.approval = { ...w.approval, reasons: w.approval.reasons.filter((x) => !(w.form.required_left === 0 && x.startsWith("필수"))) };
    this.syncTurnItem(slug);
  }
  async getMaterials(slug: string): Promise<MaterialsView> {
    await this.readDelay();
    const m = this.store.materials[slug];
    if (!m) throw apiError("permission_denied", "이 프로젝트를 볼 권한이 없습니다.", false);
    return clone(m);
  }
  async getUsage(): Promise<UsageView> {
    await this.readDelay();
    return clone(this.store.usage);
  }
  async getComputer(): Promise<ComputerView> {
    await this.readDelay();
    return clone(this.store.computer);
  }
  async listNotifications(): Promise<NotificationItem[]> {
    await this.readDelay();
    return clone(this.store.notifications);
  }

  /** GET P/changes?cursor= — 커서 뒤의 tx 묶음만. 시안 조작으로 커서 무효를 흉내 낼 수 있다. */
  async getChanges(project: string, cursor: string): Promise<ChangesPage> {
    await sleep(120);
    const s = mockSettings.get();
    if (s.resyncNext) {
      mockSettings.set({ resyncNext: false });
      throw apiError("cursor_invalid", "변경 위치가 무효입니다. 화면 자료만 새로 받습니다(초안·초점은 그대로).", true);
    }
    const after = Number(cursor || "0");
    const txs = this.store.log.filter((t) => (project === "*" || t.project === project || t.project === "*") && Number(t.event_seq) > after);
    return { cursor: String(this.store.seq), txs: txs.map((tx) => ({ ...tx })) };
  }

  currentCursor() {
    return String(this.store.seq);
  }

  /** 변경 알림 통로(웹소켓/SSE 흉내). 알림에는 번호만 싣는다. */
  subscribe(project: string, cb: (n: ChangeNotice) => void) {
    const set = this.listeners.get(project) ?? new Set();
    set.add(cb);
    this.listeners.set(project, set);
    return () => set.delete(cb);
  }

  private emit(project: string, touched: ChangeTx["touched"], human_action?: string) {
    this.store.seq += 1;
    const tx = { project, event_seq: String(this.store.seq), touched, human_action };
    this.store.log.push(tx);
    const notice: ChangeNotice = { project, event_seq: tx.event_seq };
    const fire = () => {
      this.listeners.get(project)?.forEach((cb) => cb(notice));
      if (project !== "*") this.listeners.get("*")?.forEach((cb) => cb(notice));
      else this.listeners.forEach((set, key) => key !== "*" && set.forEach((cb) => cb(notice)));
    };
    if (this.deferEmits) {
      this.deferred.push(fire);
      return;
    }
    // 통로가 느린 갱신이면 늦게 도착
    window.setTimeout(fire, mockSettings.get().channel === "slow" ? 2500 : 60);
  }

  /* ───────── 쓰기(닫힌 명령) ───────── */

  async command<K extends CmdName>(name: K, input: CommandInputs[K], opts: { idempotencyKey: string }): Promise<CommandResult<unknown>> {
    const s = mockSettings.get();
    const requestHash = JSON.stringify(input);
    const prior = this.receipts.get(opts.idempotencyKey);
    if (prior) {
      if (prior.request !== requestHash) {
        throw apiError("version_conflict", "같은 요청 번호로 다른 내용을 보냈습니다. 새로 시작해 주세요.", false);
      }
      this.calls.push({ name, at: nowLabel(), replayed: true });
      await sleep(200);
      // 미뤄 둔 변경 알림을 이제 보낸다
      const fires = this.deferred.splice(0);
      fires.forEach((f) => window.setTimeout(f, 60));
      return { format_version: FORMAT_VERSION, request_id: "req-replay", receipt: { ...prior.receipt, replayed: true }, data: prior.data };
    }

    if (s.network === "offline") {
      // 브라우저가 오프라인이라 보내기 전에 멈춘 경우만 “보내지 않음”이라고 단정할 수 있다(Codex F07)
      await sleep(300);
      throw apiError("network_unreachable", "이 기기가 연결되지 않아 보내지 않았습니다. 입력은 그대로 있고, 연결되면 같은 요청 번호로 다시 보냅니다.", true, undefined, "다시 보내기");
    }
    await sleep(s.network === "slow" ? 2600 : 450);

    // 서버 권한 재검사(사람·소유자만 명령)
    const spec: CommandSpec | undefined = (COMMANDS as Record<string, CommandSpec>)[name as PesCommand];
    if (spec?.humanOnly && s.role !== "owner") {
      throw apiError("permission_denied", "소유자만 할 수 있습니다. 서버가 권한을 다시 확인했습니다.", false);
    }
    if (name === "submission.create" && s.role === "reader") {
      throw apiError("permission_denied", "읽기 멤버는 답을 보낼 수 없습니다. 답은 편집자 이상이 보냅니다.", false);
    }

    if (STEP_UP_REQUIRED.includes(name) && !(input as { step_up?: StepUp }).step_up) {
      throw apiError("permission_denied", "본인 확인(재인증)이 필요합니다. 이 요청 한 건에만 쓰입니다.", false, undefined, "본인 확인");
    }

    this.deferEmits = s.network === "lost";
    let data: unknown;
    try {
      data = this.apply(name, input);
    } finally {
      this.deferEmits = false;
    }
    this.receiptNo += 1;
    const receipt: Receipt = {
      receipt_no: name === "submission.create" ? `R2-S${this.receiptNo}` : `${this.receiptNo}`,
      tx_id: `tx-${this.store.seq + 1}`,
      committed_at: nowLabel(),
      idempotency_key: opts.idempotencyKey,
      replayed: false,
    };
    this.receipts.set(opts.idempotencyKey, { receipt, data, request: requestHash });
    this.calls.push({ name, at: receipt.committed_at, replayed: false });
    if (s.network === "lost") {
      // 서버는 커밋했지만 응답이 유실됨 — 화면은 성공도 실패도 단정하지 않는다
      mockSettings.set({ network: "normal" });
      throw apiError("result_unknown", "보낸 뒤 응답을 받지 못했습니다. 접수됐는지 모릅니다 — 같은 요청 번호로 확인해 주세요(두 번 처리하지 않음).", true, undefined, "같은 요청 번호로 확인");
    }
    return { format_version: FORMAT_VERSION, request_id: `req-${this.receiptNo}`, receipt, data };
  }

  private ws(slug: string) {
    const w = this.store.workspaces[slug];
    if (!w) throw apiError("permission_denied", "프로젝트를 찾지 못했습니다.", false);
    return w;
  }

  private apply<K extends CmdName>(name: K, raw: CommandInputs[K]): unknown {
    switch (name) {
      case "submission.create": {
        const input = raw as CommandInputs["submission.create"];
        const w = this.ws(input.slug);
        if (mockSettings.get().nextSubmit === "conflict") {
          mockSettings.set({ nextSubmit: "ok" });
          throw apiError("version_conflict", `그사이 질문이 바뀌었습니다 — 바뀐 곳을 보고 다시 보내 주세요. 아무것도 접수하지 않았고 초안은 그대로입니다.`, false, { expected_form_version: String(input.form_version), current_form_version: String(w.form.version + 1) });
        }
        // 막힌 것 “필수 질문 미응답”이 이 답으로 풀리면 해결 기록에 남긴다(같은 tx)
        const reqBefore = this.derivedProblems(input.slug).find((p) => p.kind === "required_question");
        const answeredRequired: string[] = [];
        for (const a of input.answers) {
          const q = w.form.questions.find((x) => x.id === a.question_id);
          if (q) {
            if (q.required && !q.sent && !q.deferred) answeredRequired.push(q.number);
            q.sent = { answer: a.text, by: this.person(), at: nowLabel(), receipt_no: `R2-S${this.receiptNo + 1}` };
          }
        }
        if (reqBefore && answeredRequired.length) this.record(input.slug, reqBefore, `답함 — ${answeredRequired.join(" · ")}`, { option: "answer", receiptNo: `R2-S${this.receiptNo + 1}` });
        this.afterFormChange(input.slug);
        this.emit(input.slug, ["workspace", "projects"]);
        return { accepted: input.answers.length };
      }
      case "question.revise": {
        const input = raw as CommandInputs["question.revise"];
        const w = this.ws(input.slug);
        if (mockSettings.get().role === "reader") throw apiError("permission_denied", "읽기 멤버는 질문을 고칠 수 없습니다.", false);
        const reqBefore = this.derivedProblems(input.slug).find((p) => p.kind === "required_question");
        const ids = new Set(input.question_ids);
        const touched = w.form.questions.filter((q) => ids.has(q.id) && !q.sent && !q.deferred);
        if (!touched.length) throw apiError("version_conflict", "그사이 그 질문이 답되었거나 바뀌었습니다 — 화면을 다시 받았습니다.", false);
        for (const q of touched) q.deferred = { by: this.person(), at: nowLabel() };
        w.form.version += 1;
        if (reqBefore && touched.some((q) => q.required)) this.record(input.slug, reqBefore, `보류 — ${touched.map((q) => q.number).join(" · ")}(새 폼 v${w.form.version})`, { option: "defer" });
        this.afterFormChange(input.slug);
        this.emit(input.slug, ["workspace", "projects"]);
        return { deferred: touched.length, form_version: w.form.version };
      }
      case "problem.resolve":
        return this.resolveProblem(raw as CommandInputs["problem.resolve"]);
      case "decision.record": {
        const input = raw as CommandInputs["decision.record"];
        if (mockSettings.get().role === "reader") throw apiError("permission_denied", "읽기 멤버는 판단을 기록할 수 없습니다.", false);
        const r = this.store.research[input.slug];
        const pr = r?.proposals.find((x) => x.id === input.proposal_id);
        if (!r || !pr) throw apiError("version_conflict", "그 제안이 바뀌었거나 없습니다.", false);
        if (pr.state.value !== "proposed") throw apiError("already_judged", "이미 판단한 제안입니다 — 화면을 다시 받았습니다.", false);
        // UI7-4b 시험용: 고른 제안 한 건을 버전 충돌로 거절한다(저장소는 그대로 — 판단 전 유지)
        if (input.verdict === "accept" && mockSettings.get().failAssumption === input.proposal_id) {
          throw apiError("version_conflict", "그사이 제안이 바뀌었습니다 — 버전 충돌입니다.", false);
        }
        pr.state = { domain: "proposal", value: input.verdict === "accept" ? "accepted" : "rejected", label: `${input.verdict === "accept" ? "받아들임" : "버림"} · ${this.person()} ${nowLabel()}` };
        this.emit(input.slug, ["workspace"]);
        return {};
      }
      case "run.resume":
      case "run.start": {
        const input = raw as CommandInputs["run.resume"];
        const w = this.ws(input.slug);
        const run = w.runs.rows.find((r) => r.selected) ?? w.runs.rows[0];
        if (w.mode === "A" && w.api_transfer.value !== "on") throw apiError("policy_blocked", "AI가 읽기: 막음이라 방식 A를 시작할 수 없습니다.", false);
        if (run) {
          run.status = w.mode === "B" ? { domain: "run", value: "queued", label: "계속 접수됨 · 내 컴퓨터가 아직 받지 않음" } : { domain: "run", value: "running" };
          run.last = `${nowLabel()} 계속 접수 · 새 담당`;
        }
        w.ai_card = { ...w.ai_card, status: run?.status ?? { domain: "run", value: "running" }, line: w.mode === "B" ? "계속 접수됨 — 내 컴퓨터 AI가 받으면 이어집니다." : "같은 모델로 이어 갑니다. 이미 저장된 결과는 다시 만들지 않습니다." };
        w.now = { rank: 6, kind: "wait", title: "지금은 AI 작업 중입니다 — 진행 상황 보기", detail: w.mode === "B" ? "내 컴퓨터 AI가 계속을 받으면 진행됩니다. AI가 꺼져 있으면 ‘AI 미접속 · 대기 중’으로 보입니다." : "PES 실행기가 이어서 합니다.", action: { label: "진행 보기", href: "#ai" }, then: [] };
        w.strip = w.strip.map((c) => (c.k === "실행" ? { ...c, v: w.mode === "B" ? "계속 접수됨" : "진행 중" } : c));
        // 차례가 AI 쪽으로: A는 PES 실행기가 직접 하므로 소식이 바로 있음, B는 내 컴퓨터 AI가 받기 전이라 아직 소식 없음(움직이지 않음)
        this.store.activity[input.slug] =
          w.mode === "A"
            ? { text: `${w.form.round_label} · 맥락 모으는 중…`, since: isoAgo(0), last_signal: isoAgo(0), fresh: true }
            : { text: "계속 접수됨 · 내 컴퓨터 AI가 아직 받지 않음", since: isoAgo(0), fresh: false };
        this.syncTurnItem(input.slug);
        this.emit(input.slug, ["workspace", "projects", "usage"]);
        return { run_id: run?.id };
      }
      case "run.interrupt":
      case "run.cancel":
      case "run.handoff": {
        const input = raw as CommandInputs["run.interrupt"];
        this.emit(input.slug, ["workspace"]);
        return {};
      }
      case "stage.approve": {
        const input = raw as CommandInputs["stage.approve"];
        this.emit(input.slug, ["workspace", "projects"]);
        return { approved_snapshot: input.snapshot };
      }
      case "policy.api_transfer.revise": {
        const input = raw as CommandInputs["policy.api_transfer.revise"];
        const w = this.ws(input.slug);
        w.api_transfer = { domain: "transfer", value: input.allow ? "on" : "off" };
        w.strip = w.strip.map((c) => (c.k === "AI가 읽기" ? { ...c, v: input.allow ? "허용 · 새 정책" : "막음 · 방식 A 불가" } : c));
        const card = this.store.projects.active.find((p) => p.slug === input.slug);
        if (card) card.api_transfer = { domain: "transfer", value: input.allow ? "on" : "off" };
        this.emit(input.slug, ["workspace", "projects", "usage"], input.allow ? undefined : "AI가 읽기를 막았습니다");
        return {};
      }
      case "file_ai_access_set": {
        const input = raw as CommandInputs["file_ai_access_set"];
        const m = this.store.materials[input.slug];
        if (!m) throw apiError("permission_denied", "프로젝트를 찾지 못했습니다.", false);
        for (const id of input.file_ids) {
          const f = m.files.find((x) => x.id === id);
          if (f && f.access !== "na") {
            f.access = input.access;
            f.access_note = `${nowLabel()} ${mockSettings.get().role === "owner" ? "김연구" : "?"}`;
            f.pc = input.access === "deny" ? { domain: "sync", value: "skipped", label: "안 받음" } : f.pc?.value === "skipped" ? { domain: "sync", value: "pending", label: "받음 대기" } : f.pc;
          }
        }
        m.history.push({ no: m.history.length + 1, state: { domain: "aiAccess", value: input.access }, who: `김연구 · ${nowLabel()}`, why: input.reason || (input.file_ids.length > 1 ? `폴더 단위로 ${input.file_ids.length}개` : "이유 없음") });
        const deny = m.files.filter((f) => f.access === "deny").length;
        const allow = m.files.filter((f) => f.access === "allow").length;
        m.kpi = m.kpi.map((k) => (k.k === "AI 참조 허용" ? { ...k, v: String(allow) } : k.k === "AI 참조 금지" ? { ...k, v: String(deny) } : k));
        this.emit(input.slug, ["files", "workspace"]);
        return { changed: input.file_ids.length };
      }
      case "sync.conflict.resolve": {
        const input = raw as CommandInputs["sync.conflict.resolve"];
        const w = this.ws(input.slug);
        const row = w.sync?.rows.find((r) => r.item === input.item);
        const pb = this.derivedProblems(input.slug).find((p) => p.kind === "sync_conflict" && row && p.id === `ps-${row.id}`);
        if (pb && input.choice !== "later") {
          const label = pb.options.find((o) => o.id === input.choice)?.label ?? input.choice;
          this.record(input.slug, pb, label, { option: input.choice, note: input.reason || undefined });
        }
        if (row) {
          row.status = input.choice === "later" ? { domain: "sync", value: "conflict", label: "충돌 · 나중에 정함(이 파일만 멈춤)" } : { domain: "sync", value: "synced" };
          row.version = input.choice === "pc" ? "내 컴퓨터 것을 v4로 올림 · 웹 v3은 기록에 남음" : input.choice === "web" ? "웹 v3을 받음 · 내 컴퓨터 것은 “충돌 사본”" : "둘 다 그대로";
          row.action = input.choice === "later" ? "resolve" : undefined;
        }
        if (w.sync && input.choice !== "later") w.sync.summary = "올림 2 · 받음 5 · 충돌 0";
        if (input.choice !== "later") {
          if (w.now.then.length) w.now.then = w.now.then.filter((t) => !t.label.startsWith("동기화 충돌"));
          this.store.projects.turns = this.store.projects.turns.filter((t) => !(t.slug === input.slug && t.short.startsWith("동기화 충돌")));
        }
        this.emit(input.slug, ["workspace", "projects"]);
        return {};
      }
      case "sync.pause": {
        const input = raw as CommandInputs["sync.pause"];
        const w = this.ws(input.slug);
        if (w.third_card.kind === "computer") w.third_card = { ...w.third_card, status: { domain: "computer", value: "paused" }, foot: "동기화 일시 중지 · 다시 시작은 데스크톱에서" };
        this.emit(input.slug, ["workspace"]);
        return {};
      }
      case "dispatch.settle": {
        const input = raw as CommandInputs["dispatch.settle"];
        const call = this.store.usage.unknown_calls.find((u) => u.id === input.id);
        if (!call) return {};
        if (!input.reason.trim() || !input.evidence.trim()) throw apiError("permission_denied", "정리에는 근거와 이유가 필요합니다.", false, undefined, "근거 적기");
        if (input.outcome === "unverifiable") {
          // 확인 불가: 예약·차단을 그대로 둔다. 기록만 남긴다
          call.what = `${call.what} · ${nowLabel()} 확인 불가로 기록(예약·차단 유지)`;
          this.emit("*", ["usage"]);
          return { kept: true };
        }
        // 연구 공간의 막힌 것 “AI 실행 멈춤”은 사람 몫이 끝나 기다림으로 바뀐다 — 해결 기록에 고른 것을 남긴다
        const stopped = this.derivedProblems("youth-housing").find((p) => p.kind === "run_stopped" && p.state === "open");
        if (stopped) this.record("youth-housing", stopped, `확인 안 된 호출 정리 — ${input.outcome === "processed" ? "처리됨(예약을 사용으로)" : "처리 안 됨(예약 해제)"} · 이제 재개 가능 시각을 기다림`, { option: "settle", note: `근거: ${input.evidence}` });
        this.store.usage.unknown_calls = this.store.usage.unknown_calls.filter((u) => u.id !== input.id);
        const sub = this.store.usage.connections.find((c) => c.id === "conn-sub")?.subscription;
        if (sub) {
          sub.windows = sub.windows.map((w) =>
            input.outcome === "not_processed"
              ? { ...w, reserved: Math.max(0, w.reserved - (w.key === "h5" ? 5 : 1)), estimated_percent: Math.max(0, w.estimated_percent - (w.key === "h5" ? 5 : 1)) }
              : { ...w, pes_since_t0: w.pes_since_t0 + (w.key === "h5" ? 5 : 1), reserved: Math.max(0, w.reserved - (w.key === "h5" ? 5 : 1)) },
          );
        }
        if (this.store.usage.blocked) {
          this.store.usage.blocked.checks = this.store.usage.blocked.checks.map((c) => (c.item === "확인 안 된 호출" ? { ...c, detail: `${nowLabel()} 정리함 · ${input.outcome === "processed" ? "처리됨 — 예약을 사용으로 확정" : "처리 안 됨 — 예약 해제"} · 근거: ${input.evidence}`, pass: true } : c));
        }
        this.store.usage.flow = this.store.usage.flow.map((f) => (f.title === "사람이 정리" ? { ...f, state: "past", body: `${nowLabel()} 정리함` } : f));
        this.store.usage.now = { ...this.store.usage.now, rank: 6, kind: "wait", title: "재개 가능 시각을 기다립니다 — 확인 안 된 호출 정리됨", facts: ["남은 검사: 추정 사용량", "16:40 예상 84%"], detail: "기다리기만 할 수 있는 막힘이라 지금 할 일 1순위가 아닙니다. 지나도 저절로 다시 시작하지 않습니다.", action: { label: "멈춘 실행 보기", href: "#blocked" } };
        this.store.projects.turns = this.store.projects.turns.filter((x) => x.id !== "t1");
        this.store.projects.waiting.unshift({ slug: "youth-housing", project_title: "청년 주거 지원 효과(가상)", text: "실행 멈춤 · 사용량 — 재개 가능 16:40(PES 추정)까지 기다림", who: "시간" });
        this.emit("*", ["usage", "projects", "workspace"]);
        return {};
      }
      case "usage.extra_usage.confirm": {
        const input = raw as CommandInputs["usage.extra_usage.confirm"];
        const c = this.store.usage.connections.find((x) => x.id === input.connection_id);
        if (c?.subscription) c.subscription.extra_usage = { ...c.subscription.extra_usage, state: "confirmed", last: `11-05 ${nowLabel()}`, by: "김연구", valid_until: `11-12 ${nowLabel()}` };
        this.emit("*", ["usage"]);
        return {};
      }
      case "usage.baseline.set": {
        const input = raw as CommandInputs["usage.baseline.set"];
        const c = this.store.usage.connections.find((x) => x.id === input.connection_id);
        if (c?.subscription) {
          c.subscription.baseline = { state: input.no_other_use_after_t0 ? "not_used" : "entered", t0: input.t0, h5: input.h5, week: input.week, month: input.month, no_other_use_after_t0: input.no_other_use_after_t0 };
          // 추정 다시 계산: 새 그 숫자 + (시안에서는 확인한 시각 이후 PES 증분 0으로 다시 시작) + 예약
          c.subscription.windows = c.subscription.windows.map((w) => {
            const v = w.key === "h5" ? input.h5 : w.key === "week" ? input.week : input.month;
            const t0v = v ?? 0;
            return { ...w, t0_console: v, pes_since_t0: 0, estimated_percent: Math.min(100, t0v + w.reserved) };
          });
        }
        this.emit("*", ["usage", "workspace"]);
        return {};
      }
      case "ai_connection.test": {
        const input = raw as CommandInputs["ai_connection.test"];
        const okAddress = /^https:\/\//.test(input.endpoint) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(input.endpoint);
        if (!okAddress) throw apiError("connection_test_failed", "주소 형식이 맞지 않습니다. https:// 로 시작하는 주소(내 컴퓨터 모델이면 http://127.0.0.1…)를 넣어 주세요.", false, undefined, "주소 고치기");
        if (!input.key_present && input.kind !== "custom") throw apiError("connection_test_failed", "API 키가 비어 있습니다.", false);
        if (input.key_present && input.key_length < 8) throw apiError("connection_test_failed", "키가 맞지 않습니다(401). API 회사 화면에서 키를 다시 확인해 주세요.", false);
        return { ok: true, at: nowLabel() };
      }
      case "ai_connection.models.refresh": {
        const input = raw as CommandInputs["ai_connection.models.refresh"];
        if (input.kind === "openai_compatible" || input.kind === "custom") return { models: [] as string[], note: "이 주소는 모델 목록을 주지 않습니다 — 직접 입력해 주세요." };
        if (input.kind === "anthropic") return { models: ["example-claude-model"], note: "목록 1개" };
        if (input.kind === "google") return { models: ["example-google-model"], note: "목록 1개" };
        return { models: ["deepseek-v4.1-flash", "example-model-b"], note: "목록 2개" };
      }
      case "ai_connection.create": {
        const input = raw as CommandInputs["ai_connection.create"];
        if (input.billing === "metered" && !input.cap) throw apiError("cost_cap_missing", "쓴 만큼 과금 연결은 비용 상한을 적어야 저장할 수 있습니다.", false);
        const conn: AiConnection = {
          id: `conn-${Math.random().toString(36).slice(2, 7)}`,
          name: input.name,
          kind: input.kind,
          endpoint: input.endpoint,
          // 키 값은 버린다 — 끝 4자리만 남긴다(실제로는 서버가 키체인·비밀 저장소에 넣고 응답에 싣지 않음)
          key: { last4: input.key ? input.key.slice(-4) : "없음", storage: "os_keychain", set_at: `11-05 ${nowLabel()}`, set_by: "김연구" },
          billing: input.billing,
          owner: "김연구",
          models_source: input.models.length ? "loaded" : "manual",
          models_listed_at: nowLabel(),
          models: input.models.map((id, i) => ({ id, available: true, is_default: i === 0, weight_known: input.billing === "subscription" ? false : undefined, price: input.billing === "metered" ? { source: "human", text: "단가 사람이 입력(예시)" } : undefined })),
          test: { state: "ok", at: nowLabel(), message: "저장 전에 시험함" },
          subscription:
            input.billing === "subscription"
              ? {
                  stop_percent: input.stop_percent ?? 90,
                  windows: [
                    { key: "h5", estimated_percent: 0, t0_console: null, pes_since_t0: 0, reserved: 0, pes_runs: 0, resets: { at: null, basis: "unknown", text: "아직 호출 없음" } },
                    { key: "week", estimated_percent: 0, t0_console: null, pes_since_t0: 0, reserved: 0, pes_runs: 0, resets: { at: null, basis: "unknown", text: "아직 호출 없음" } },
                    { key: "month", estimated_percent: 0, t0_console: null, pes_since_t0: 0, reserved: 0, pes_runs: 0, resets: { at: null, basis: "unknown", text: "아직 호출 없음" } },
                  ],
                  extra_usage: { applicable: input.extra_usage_applicable ?? true, state: "none", last: null, by: null, valid_until: null },
                  baseline: { state: "none", t0: null, h5: null, week: null, month: null, no_other_use_after_t0: false },
                }
              : undefined,
          metered: input.billing === "metered" && input.cap ? { cap: { amount: input.cap.amount, currency: input.cap.currency, period: "month", set_by: "김연구", set_at: nowLabel() }, spent_estimate: { amount: 0, as_of: nowLabel() }, state: "set" } : undefined,
          used_by: [],
        };
        this.store.usage.connections.push(conn);
        this.emit("*", ["usage"]);
        return { id: conn.id, key_last4: conn.key.last4 };
      }
      case "ai_connection.limits.set": {
        const input = raw as CommandInputs["ai_connection.limits.set"];
        const c = this.store.usage.connections.find((x) => x.id === input.connection_id);
        if (c?.subscription && input.stop_percent) c.subscription.stop_percent = input.stop_percent;
        if (c?.metered?.cap && input.cap) c.metered.cap.amount = input.cap;
        this.emit("*", ["usage"]);
        return {};
      }
      case "project.ai_connection.set": {
        const input = raw as CommandInputs["project.ai_connection.set"];
        const w = this.ws(input.slug);
        const c = this.store.usage.connections.find((x) => x.id === input.connection_id);
        w.runner_label = `${c?.name ?? "?"} · ${input.model}`;
        w.runs.mode_label = `방식 A · ${w.runner_label}`;
        this.emit(input.slug, ["workspace", "usage", "projects"]);
        return {};
      }
      case "project.create": {
        this.emit("*", ["projects"]);
        return { slug: (raw as CommandInputs["project.create"]).slug };
      }
      case "upload_batch.create": {
        return { batch_id: `batch-${this.store.seq}` };
      }
      case "file_upload": {
        const input = raw as CommandInputs["file_upload"];
        if (input.simulateFail) throw apiError("network_unreachable", "연결이 끊겨 이 파일을 올리지 못했습니다.", true, undefined, "다시 올리기");
        const m = this.store.materials[input.slug];
        if (m) {
          const name = input.path.split("/").pop() ?? input.path;
          const folder = input.folder;
          const same = m.files.find((f) => f.name === name && f.folder === folder);
          if (same) {
            const v = Number(same.version.replace("v", "")) || 1;
            same.version = `v${v + 1}`;
            same.at = nowLabel();
            same.extract_note = `같은 이름이라 새 버전(v${v}는 남음)`;
          } else {
            const ext = name.split(".").pop()?.toLowerCase() ?? "";
            m.files.push({
              id: `u-${this.store.seq}-${m.files.length}`,
              name,
              folder,
              format: ext,
              version: "v1",
              size: `${(input.size / 1_000_000).toFixed(1)}MB`,
              by: "김연구",
              at: nowLabel(),
              extract: { domain: "extract", value: ["hwpx", "pdf", "docx", "xlsx", "pptx", "csv", "txt", "md"].includes(ext) ? "extracting" : "unsupported" },
              extract_note: "이 브라우저에서 글자 뽑기",
              access: input.access,
              access_note: input.access === "deny" ? "올릴 때부터 금지" : undefined,
              used: "—",
              pc: null,
              action: "보기",
            });
          }
        }
        this.emit(input.slug, ["files"]);
        return {};
      }
      case "device.approve":
        return { decision: (raw as CommandInputs["device.approve"]).decision };
      case "reference_refresh": {
        const input = raw as CommandInputs["reference_refresh"];
        const w = this.ws(input.slug);
        const r = w.references.find((x) => x.id === input.ref_id);
        if (r) {
          if (input.mode === "update") {
            r.pinned = `2판 R1 승인본 · ${nowLabel()} 고정 (김연구) — 이미 쓴 인용은 1판 완료본을 계속 가리킴`;
            r.new_version = undefined;
          } else {
            r.new_version = "2판 R1 승인본 · 11-04 — 지금 버전 유지를 골랐습니다(다시 알리지 않음)";
          }
          r.status = { domain: "reference", value: "pinned" };
          w.nav_counts.refs_new = false;
          w.now.then = w.now.then.filter((t) => !t.label.startsWith("참고 프로젝트"));
          this.store.projects.turns = this.store.projects.turns.filter((t) => !(t.slug === input.slug && t.short.startsWith("참고 프로젝트")));
        }
        this.emit(input.slug, ["workspace", "projects"]);
        return {};
      }
      case "thread.create": {
        const input = raw as CommandInputs["thread.create"];
        const w = this.ws(input.slug);
        w.annotations.push({ no: w.annotations.length + 1, who: mockSettings.get().role === "owner" ? "김연구" : "박검토", at: nowLabel(), quote: input.quote, anchor: { domain: "anchor", value: "exact" }, note: "v4에 단 첨언", body: input.body });
        this.emit(input.slug, ["workspace"]);
        return {};
      }
      case "question.create": {
        const input = raw as CommandInputs["question.create"];
        const w = this.ws(input.slug);
        if (input.direction === "human_to_agent") {
          // 사람→AI 질문(U5): 접수됨까지가 사실이다. 받음 ≠ 읽음, 답이 오기 전에는 “AI 답변 중”을 보이지 않는다.
          if (mockSettings.get().role === "reader") throw apiError("permission_denied", "읽기 멤버는 AI에게 부탁할 수 없습니다.", false);
          this.addAsk(w, input.target ? `[${input.target}] ${input.text}` : input.text);
          this.emit(input.slug, ["workspace"]);
          return { number: w.asks[w.asks.length - 1]?.number };
        }
        w.form.version += 1;
        w.form.total += 1;
        w.form.answerable += 1;
        w.form.questions.push({ id: `q-h${w.form.total}`, number: `Q-${20 + w.form.total + 2}`, version: 1, source: "human", source_label: "사람이 더함 · 김연구", importance: "보통", required: false, meta: `폼 v${w.form.version}에 더함 · 김연구 ${nowLabel()}`, text: input.text, options: [], allow_comment_as_answer: true });
        w.nav_counts.questions = w.form.answerable;
        this.emit(input.slug, ["workspace"], "질문이 하나 더해졌습니다");
        return {};
      }
      default:
        return {};
    }
  }

  /** 사람→AI 질문 하나(U5) — AI 작업의 “AI에게 묻는 질문”에 더한다. 받음 ≠ 읽음, 답이 오기 전에는 답 없음 */
  private addAsk(w: WorkspaceCore, text: string) {
    const nums = [...w.form.questions.map((q) => q.number), ...w.asks.map((a) => a.number)].map((x) => Number(x.replace(/\D/g, "")) || 0);
    const n = Math.max(24, ...nums) + 1;
    const running = w.runs.rows.some((r) => r.status.value === "running");
    w.asks.push({
      number: `Q-${n}`,
      who: `${this.person()} → AI`,
      text,
      steps: [
        { domain: "ask", value: "received", label: `접수됨 ${nowLabel()}` },
        w.mode === "B" ? { domain: "ask", value: "no_answer", label: "내 컴퓨터가 아직 받지 않음" } : { domain: "ask", value: "no_answer", label: running ? "실행 중 · 답 없음" : "다음 실행에서 처리 · 답 없음" },
      ],
    });
    w.form.asks_count = w.asks.length;
  }

  /**
   * 막힌 것 하나 풀기(problem.resolve, 설계 16.4) — 고른 선택지 하나를 그 종류의 업무 처리로 바꾸고 해결 기록과 함께 한 tx.
   * 이 명령은 연구 내용 문제 · 실행 넘기기/취소 · 자료 정리만 맡는다. 답하기 · 동기화 고르기 · 호출 정리는 원래 명령을 그대로 쓴다.
   */
  private resolveProblem(input: CommandInputs["problem.resolve"]) {
    const role = mockSettings.get().role;
    if (role === "reader") throw apiError("permission_denied", "읽기 멤버는 막힌 것을 정할 수 없습니다. 고르기는 편집자 이상입니다.", false);
    const w = this.ws(input.slug);
    const r = this.store.research[input.slug];
    const p = this.problemsFor(input.slug).find((x) => x.id === input.problem_id);
    if (!r || !p) throw apiError("version_conflict", "그사이 이 문제가 풀렸거나 바뀌었습니다 — 아무것도 바꾸지 않았고 화면을 다시 받았습니다.", false);
    const opt: ProblemOption | undefined = p.options.find((o) => o.id === input.option_id);
    if (!opt || opt.via !== "problem.resolve") throw apiError("permission_denied", "이 문제에 없는 선택지입니다 — 서버가 닫힌 목록으로 다시 검사했습니다.", false);
    if (opt.owner_only && role !== "owner") throw apiError("permission_denied", "이 선택은 소유자만 할 수 있습니다. 서버가 권한을 다시 확인했습니다.", false);
    if (opt.needs === "note" && !input.note?.trim()) throw apiError("permission_denied", "요약을 적어 주세요 — 빈 요약은 붙이지 않습니다.", false, undefined, "요약 적기");
    const at = nowLabel();

    if (PROBLEM_GROUP[p.kind] === "content") {
      const c = r.content.find((x) => x.id === p.id);
      if (!c) throw apiError("version_conflict", "그사이 이 문제가 바뀌었습니다.", false);
      if (opt.to_ai) {
        c.state = "ai";
        c.note = `${at} ${this.person()}가 AI에게 맡김 — ${w.mode === "B" ? "내 컴퓨터 AI가 받아야 시작합니다" : "다음 실행에서 처리합니다"}. 결과는 다음 결과 글에 붙습니다.`;
        this.addAsk(w, `${opt.label} — ${p.title}`);
      } else {
        r.content = r.content.filter((x) => x.id !== p.id);
        this.record(input.slug, p, opt.label, { option: opt.id, note: input.note || undefined });
        const para = p.paragraph !== undefined ? w.result?.paragraphs[p.paragraph] : undefined;
        if (para && EDIT_PROPOSAL[opt.id]) para.pending_edit = EDIT_PROPOSAL[opt.id];
        if (opt.id === "official" || opt.id === "report" || opt.id === "assume") {
          r.proposals.push({
            id: `pd-${p.id}`,
            kind: opt.id === "assume" ? "assumption" : "decision",
            text: opt.id === "assume" ? "2023년 A시 요양보호사 수의 차이는 집계 기준일 차이로 본다" : opt.label,
            basis: `막힌 것 · ${p.title}`,
            by: this.person(),
            at,
            state: { domain: "proposal", value: "accepted", label: `사람이 정함 · ${at}` },
          });
        }
      }
      this.syncResearchTurns(input.slug);
      this.emit(input.slug, ["workspace", "projects"]);
      return { state: opt.to_ai ? "ai" : "resolved" };
    }

    if (p.kind === "run_stopped") {
      const run = w.runs.rows.find((x) => `pr-${x.id}` === p.id);
      if (run) {
        run.selected = false;
        if (opt.id === "handoff") {
          run.status = { domain: "run", value: "handed_off" };
          run.last = `${at} 방식 B로 넘김 · 새 실행 ${run.id}-B`;
          const queued: StatusRef = { domain: "run", value: "queued", label: "넘김 접수 · 내 컴퓨터가 아직 받지 않음" };
          w.runs.rows.unshift({ id: `${run.id}-B`, where: run.where, runner: "B · 내 컴퓨터 AI", status: queued, started: at, last: "내 컴퓨터 AI가 받으면 시작", selected: true });
          w.ai_card = { ...w.ai_card, title: `실행 ${run.id}-B · ${run.where}`, status: queued, line: "방식 B로 넘겼습니다. 내 컴퓨터 AI가 받으면 이어집니다(API 사용량을 쓰지 않음)." };
          this.store.activity[input.slug] = { text: "넘김 접수 · 내 컴퓨터 AI가 아직 받지 않음", since: isoAgo(0), fresh: false };
        } else {
          run.status = { domain: "run", value: "cancelled" };
          run.last = `${at} 사람이 취소 · 저장된 결과는 남음`;
          w.ai_card = { ...w.ai_card, status: { domain: "run", value: "cancelled" }, line: "실행을 취소했습니다. 저장된 결과(연구 설계 초안 v1)는 남았습니다." };
        }
        w.strip = w.strip.map((s) => (s.k === "실행" ? { ...s, v: opt.id === "handoff" ? "넘김 접수" : "취소됨" } : s));
        w.stages = w.stages.map((s) => (s.view === "current_blocked" ? { ...s, view: "current_you" as const, state_text: opt.id === "handoff" ? "현재 · 넘김 접수" : "현재 · 실행 취소됨" } : s));
        w.approval = { ...w.approval, reasons: w.approval.reasons.filter((x) => !x.startsWith("실행 멈춤")) };
      }
      (this.store.dismissed[input.slug] ??= {})[p.id] = true;
      this.record(input.slug, p, opt.label, { option: opt.id });
      this.store.projects.turns = this.store.projects.turns.filter((t) => !(t.slug === input.slug && t.step === "blocked"));
      this.store.projects.waiting = this.store.projects.waiting.filter((x) => x.slug !== input.slug);
      this.store.usage.blocked = null;
      this.store.usage.now = { rank: 6, kind: "wait", title: "지금 멈춘 실행이 없습니다", facts: [`${STAGE_LABEL[w.current.stage]} 실행을 ${opt.id === "handoff" ? "방식 B로 넘김" : "취소함"} · ${at}`], detail: "확인 안 된 호출이 남아 있으면 사용량 예약이 그대로입니다 — 아래 표에서 정리할 수 있습니다.", action: { label: "확인 안 된 호출 보기", href: "#unknown" }, then: [] };
      this.emit(input.slug, ["workspace", "projects", "usage"]);
      return { state: "resolved" };
    }

    if (p.kind === "extract_failed") {
      (this.store.dismissed[input.slug] ??= {})[p.id] = true;
      const f = this.store.materials[input.slug]?.files.find((x) => `px-${x.id}` === p.id);
      if (f && opt.id === "summary") {
        f.access_note = "사람이 적은 요약만 AI가 읽음";
        f.extract_note = `${f.extract_note ?? ""} · 사람이 요약을 붙임(${at})`;
      }
      if (f && opt.id === "skip") f.extract_note = `${f.extract_note ?? ""} · 없이 진행하기로 함(${at})`;
      this.record(input.slug, p, opt.label, { option: opt.id, note: input.note || undefined });
      this.syncResearchTurns(input.slug);
      this.emit(input.slug, ["workspace", "projects", "files"]);
      return { state: "resolved" };
    }
    throw apiError("permission_denied", "이 문제는 원래 화면의 명령으로 처리합니다.", false);
  }

  /* ───────── 시안 조작: AI 쪽 사건 흉내 ───────── */

  simulateAiQuestion(slug: string) {
    const w = this.store.workspaces[slug];
    if (!w) return;
    w.form.version += 1;
    w.form.total += 1;
    w.form.answerable += 1;
    w.form.required_left += 1;
    const n = 24 + w.form.total;
    w.form.questions.push({ id: `q-${n}`, number: `Q-${n}`, version: 1, source: "ai", source_label: "AI가 물음", importance: "높음", required: true, meta: `Q-${n} · ${w.form.round_label} 점검 · ${w.mode === "B" ? "Claude Code" : "PES 실행기"}가 ${nowLabel()}에 올림 · 질문 v1`, text: "면담 대상 기관 수를 몇 곳으로 할까요?", help: "많을수록 정확하지만 일정이 늘어납니다. (AI 설명)", options: [{ id: "a", label: "6곳" }, { id: "b", label: "10곳" }, { id: "c", label: "기타 — 직접 쓰기" }], allow_comment_as_answer: false });
    w.nav_counts.questions = w.form.answerable;
    w.now = { ...w.now, rank: 2, kind: "answer", title: `${w.form.round_label} 질문 ${w.form.answerable}개에 답해 주세요`, facts: ["새 질문 1개", `필수 ${w.form.required_left}개 남음`], detail: "AI가 새 질문을 올렸습니다.", action: { label: "질문으로 가기", href: `#q-${n}` } };
    // AI가 질문을 올리고 기다림 → AI 진행 소식은 끝, 나의 할 일이 생김
    delete this.store.activity[slug];
    this.syncTurnItem(slug);
    this.emit(slug, ["workspace", "projects"], `새 질문 1개가 생겼습니다 — ${w.form.round_label}`);
  }

  /* ───────── 시안 조작: 차례 바뀜 장면(4차) ───────── */

  private demoTimer: number | undefined;

  /**
   * “AI 끝남 → 나의 할 일로 바뀜” 장면 — 장기요양 2판(방식 B · Codex CLI).
   * ① 바로: 도우미가 방금 진행을 보고 → AI 작업 중(소식 있음 — 점이 돈다) ② finishMs 뒤: AI가 질문 2개를 올리고 기다림 → 나의 할 일.
   * 여러 번 재생할 수 있게 그 프로젝트만 처음 장면으로 되돌린 뒤 시작한다. 변경 알림은 다른 사건과 같은 길(번호 → 바뀐 읽기만).
   * 화면 읽기 알림은 TurnAnnouncer가 한 번만 한다(이 사건에는 human_action을 싣지 않음 — 두 번 읽히지 않게).
   */
  playTurnDemo(finishMs = 6000) {
    const slug = "ltc-survey";
    window.clearTimeout(this.demoTimer);
    this.store.workspaces[slug] = clone(WORKSPACES[slug]!);
    this.store.projects.turns = this.store.projects.turns.filter((t) => t.slug !== slug);
    this.store.projects.waiting = this.store.projects.waiting.filter((x) => x.slug !== slug);
    this.store.projects.active = this.store.projects.active.map((p) => (p.slug === slug ? clone(PROJECTS.active.find((x) => x.slug === slug)!) : p));
    const w = this.store.workspaces[slug]!;
    const at = nowLabel();
    this.store.activity[slug] = { text: "2판 조사 R1 결과 쓰는 중…", since: isoAgo(30), last_signal: isoAgo(0), fresh: true };
    if (w.third_card.kind === "computer") {
      w.third_card = {
        ...w.third_card,
        status: { domain: "computer", value: "connected" },
        checked: `도우미 마지막 확인 ${at} (방금)`,
        short: `${at} 확인`,
        line: `Codex CLI가 ${at}에 진행을 알림 — 도우미 보고 “조사 노트 쓰는 중”`,
        observations: [
          { k: "도우미 연결", v: `연결됨 · 마지막 확인 ${at}` },
          { k: "AI 도구", v: `Codex CLI · 마지막 호출 ${at}(도구가 알린 이름)` },
          { k: "업무 실행", v: "2-R1-1 진행 중 · 담당 유효(18:40까지)" },
        ],
      };
    }
    w.ai_card = { ...w.ai_card, line: `도우미 보고 ${at} · 조사 노트 2판 v1 쓰는 중` };
    w.runs.lanes = { ...w.runs.lanes, running: [{ time: `${at}~`, title: "조사 노트 2판 v1 쓰는 중", body: "도우미 보고: 새 출처 9개 확인" }] };
    w.strip = w.strip.map((c) => (c.k === "내 컴퓨터" ? { ...c, v: `연결됨 · ${at}` } : c));
    this.emit(slug, ["workspace", "projects"]);
    this.demoTimer = window.setTimeout(() => this.finishTurnDemo(slug), finishMs);
  }

  private finishTurnDemo(slug: string) {
    const w = this.store.workspaces[slug];
    if (!w) return;
    const at = nowLabel();
    delete this.store.activity[slug];
    const ask = (n: number, text: string, help: string, options: string[], required: boolean): QuestionView => ({
      id: `q-l${n}`,
      number: `Q-${30 + n}`,
      version: 1,
      source: "ai",
      source_label: "AI가 물음",
      importance: required ? "높음" : "보통",
      required,
      meta: `Q-${30 + n} · 2판 조사 R1 점검 · Codex CLI가 ${at}에 올림 · 질문 v1`,
      text,
      help,
      options: options.map((label, i) => ({ id: String.fromCharCode(97 + i), label })),
      allow_comment_as_answer: !required,
    });
    w.form = {
      ...w.form,
      version: w.form.version + 1,
      answerable: 2,
      total: 2,
      required_left: 1,
      questions: [
        ask(1, "면담 대상 기관을 1판과 같은 12곳으로 둘까요?", "기획을 다시 열며 지역 범위가 넓어졌습니다. 늘리면 일정이 2주 늘어납니다. (AI 설명)", ["1판과 같게 12곳", "새 지역 포함 16곳", "기타 — 직접 쓰기"], true),
        ask(2, "새로 찾은 출처 9건 중 지방정부 보도자료도 넣을까요?", "공식 통계보다 시점은 빠르지만 정의가 다를 수 있습니다. (AI 설명)", ["넣음 · 표시해서", "빼기"], false),
      ],
    };
    w.nav_counts = { ...w.nav_counts, questions: 2 };
    w.ai_card = { ...w.ai_card, status: { domain: "run", value: "waiting_human" }, line: `Codex CLI가 ${at}에 질문 2개를 올리고 기다리는 중입니다. 지금 담당은 없습니다.`, foot: "완료 3 · 진행 0 · 예정 1" };
    w.runs = {
      ...w.runs,
      rows: w.runs.rows.map((r) => (r.selected ? { ...r, status: { domain: "run", value: "waiting_human" }, last: `${at} 질문 2개 올림 · 담당 없음` } : r)),
      lanes: { ...w.runs.lanes, done: [...w.runs.lanes.done, { time: at, title: "조사 노트 2판 v1 · 질문 2개 올림", body: "면담 대상 · 새 출처 범위" }], running: [] },
      running_empty: "지금 진행 중인 작업이 없습니다. AI는 내 답을 기다립니다.",
      continue_reason: "필수 답을 보낸 뒤 누를 수 있습니다.",
    };
    w.strip = w.strip.map((c) => (c.k === "실행" ? { ...c, v: "내 답 기다림" } : c.k === "답 제출" ? { ...c, v: "0 / 2" } : c));
    w.approval = { ...w.approval, reasons: ["필수 답 1개 없음", "실행이 끝나지 않음(내 답 기다림)"] };
    w.now = {
      rank: 2,
      kind: "answer",
      title: "2판 조사 R1 질문 2개에 답해 주세요",
      facts: ["필수 1개 남음", `AI가 ${at}에 올림`],
      detail: "답을 보내면 소유자가 ‘계속’을 눌러 AI가 이어서 조사합니다.",
      action: { label: "질문으로 가기", href: "#q-l1" },
      then: [],
      for_others: "답은 편집자 이상이 보낼 수 있습니다",
    };
    const card = this.store.projects.active.find((p) => p.slug === slug);
    if (card) {
      card.table = { ...card.table, ai: "내 답 기다림 · 방식 A 불가", last: at };
      card.foot = [`마지막 활동 ${at} · Codex CLI`, card.foot[1]];
    }
    this.syncTurnItem(slug);
    this.syncResearchTurns(slug);
    this.emit(slug, ["workspace", "projects"]);
  }

  reset() {
    window.clearTimeout(this.demoTimer);
    this.store = buildStore();
    this.initResearchTurns();
    this.receipts.clear();
    this.emit("*", ["workspace", "projects", "files", "usage", "computer", "notifications"]);
  }
}

export const pes = new MockPesClient();
