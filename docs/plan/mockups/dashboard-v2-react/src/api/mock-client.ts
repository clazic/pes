import { MATERIALS } from "@/mocks/materials";
import { AI_ACTIVITY, PROJECTS } from "@/mocks/projects";
import { COMPUTER, NOTIFICATIONS, USAGE } from "@/mocks/usage";
import { WORKSPACES } from "@/mocks/workspaces";
import { mockSettings } from "@/lib/mock-settings";
import {
  COMMANDS,
  FORMAT_VERSION,
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
  type ProjectsView,
  type QuestionView,
  type Receipt,
  type Role,
  type TurnItem,
  type TurnView,
  type UsageView,
  type WorkspaceView,
} from "./types";

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
  "question.create": { slug: string; text: string };
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
    workspaces: clone(WORKSPACES) as Record<string, WorkspaceView>,
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
      if (v === "blocked") return move("실행 멈춤 · 사용량 — 소유자(API 연결 관리자)의 정리를 기다림", "김연구");
      if (v === "check" && t.short.startsWith("동기화")) return move("동기화 충돌 — 고르기는 소유자(편집자 허용은 WEB3에서 정함, 지금은 기본 거부)", "김연구");
      if (v === "check" && t.short.startsWith("참고")) return move("참고 프로젝트 새 버전 — 갱신·유지는 소유자", "김연구");
      if (v === "resume" || v === "approve") return move(`${t.where} — ${v === "resume" ? "계속" : "승인"}은 소유자가 누릅니다`, "김연구");
      if (role === "reader" && (v === "answer" || v === "start_q")) return move(`${t.where} — 답은 편집자 이상이 보냅니다`, "편집자 이상");
      return true;
    });
    return { turns: kept, waiting: [...moved, ...waiting] };
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
    v.active = v.active.map((p) => ({ ...p, turn: this.turnFor(p.slug, v) }));
    return v;
  }
  async getWorkspace(slug: string): Promise<WorkspaceView> {
    await this.readDelay();
    const w = this.store.workspaces[slug];
    if (!w) throw apiError("permission_denied", "이 프로젝트를 볼 권한이 없거나 프로젝트가 없습니다.", false);
    const out = clone(w);
    out.turn = this.turnFor(slug, this.viewTurns(mockSettings.get().role));
    return out;
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
        action: { label: "답하기", href: wasAnswer ? old.action.href : `${roundPath}${w.now.action.href.startsWith("#") ? w.now.action.href : "#qpanel"}` },
      };
    } else if (w.now.kind === "resume") {
      item = { id: old?.id ?? `t-${slug}`, slug, rank: 4, status: { domain: "turn", value: "resume" }, project_title: title, where, short: `${w.form.round_label} 계속`, text: "필수 답 모두 보냄 — 계속을 누르면 AI가 이어서 합니다", since: "방금", action: { label: "계속으로 가기", href: `${roundPath}#ai` } };
    }
    const next = old ? (item ? list.map((t) => (t === old ? item! : t)) : list.filter((t) => t !== old)) : item ? [...list, item] : list;
    // 순위대로(같은 순위는 원래 순서)
    this.store.projects.turns = next
      .map((t, i) => ({ t, i }))
      .sort((a, b) => a.t.rank - b.t.rank || a.i - b.i)
      .map((x) => x.t);
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
          throw apiError("version_conflict", `그사이 폼이 v${w.form.version + 1}로 바뀌었습니다 — 바뀐 곳을 보고 다시 보내 주세요. 아무것도 접수하지 않았고 초안은 그대로입니다.`, false, { expected_form_version: String(input.form_version), current_form_version: String(w.form.version + 1) });
        }
        for (const a of input.answers) {
          const q = w.form.questions.find((x) => x.id === a.question_id);
          if (q) q.sent = { answer: a.text, by: mockSettings.get().role === "owner" ? "김연구" : "박검토", at: nowLabel(), receipt_no: `R2-S${this.receiptNo + 1}` };
        }
        const open = w.form.questions.filter((q) => !q.sent);
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
        } else {
          w.now = { ...w.now, title: `${w.form.round_label} 질문 ${w.form.answerable}개에 답해 주세요`, facts: [`필수 ${w.form.required_left}개 남음`, ...(w.now.facts ?? []).filter((f) => !f.startsWith("필수"))] };
        }
        this.syncTurnItem(input.slug);
        this.emit(input.slug, ["workspace", "projects"]);
        return { accepted: input.answers.length };
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
        w.now = { rank: 6, kind: "wait", title: "지금은 AI가 하는 중입니다 — 진행 상황 보기", detail: w.mode === "B" ? "내 컴퓨터 AI가 계속을 받으면 진행됩니다. AI가 꺼져 있으면 ‘AI 미접속 · 대기 중’으로 보입니다." : "PES 실행기가 이어서 합니다.", action: { label: "진행 보기", href: "#ai" }, then: [] };
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
          // 추정 다시 계산: 새 t0 값 + (시안에서는 t0 이후 PES 증분 0으로 다시 시작) + 예약
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
        if (input.key_present && input.key_length < 8) throw apiError("connection_test_failed", "키가 맞지 않습니다(401). 제공사 콘솔에서 키를 다시 확인해 주세요.", false);
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
   * ① 바로: 도우미가 방금 진행을 보고 → AI가 하는 중(소식 있음 — 점이 돈다) ② finishMs 뒤: AI가 질문 2개를 올리고 기다림 → 나의 할 일.
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
    this.emit(slug, ["workspace", "projects"]);
  }

  reset() {
    window.clearTimeout(this.demoTimer);
    this.store = buildStore();
    this.receipts.clear();
    this.emit("*", ["workspace", "projects", "files", "usage", "computer", "notifications"]);
  }
}

export const pes = new MockPesClient();
