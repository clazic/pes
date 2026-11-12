import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, PenLine, Plus } from "lucide-react";
import { useClient, useComments } from "@/api/queries";
import { NotConnectedError, PesApiError, type CommandResult, type CommentInput, type QuestionInput, type QuestionRevision, type QuestionView, type RoundView, type SubmitInput } from "@/api/types";
import { type PesAction } from "@/app/actions";
import { ActionButton } from "@/components/pes/action-button";
import { Button } from "@/components/ui/button";
import { clearDraft, draftsVersion, readDraft, subscribeDrafts } from "@/lib/draft";
import { cn } from "@/lib/utils";
import { AnswerReview } from "./AnswerReview";
import { makePlan, toAnswerItem, type Plan, type PlanItem } from "./answer-model";
import { keyFor } from "./draft-keys";
import { ClosedCard, QuestionCard, type CardTools } from "./QuestionCard";
import { MessageList } from "./QuestionThread";
import { AddQuestionDialog, TidyDialog, type TidyKind } from "./QuestionDialogs";
import { useKeyedCommand } from "./question-command";
import { FILTERS, isOpen, matchesFilter, type QuestionFilter } from "./question-model";

export { DRAFT_USER } from "./QuestionCard";

const asHtml = (el: Element | null) => (el instanceof HTMLElement ? el : null);

/** 질문 항목 하나를 가리킨다(초점을 받는 li). id 는 서버가 주는 값이라 선택자에 그대로 넣지 않는다 */
const itemEl = (id: string) => asHtml(document.querySelector(`[data-question="${CSS.escape(id)}"]`));

/** 방금 고치거나 더한 질문이 지금 거르기에 걸리는가 — 서버가 돌려주는 칸만으로 판단한다 */
const fitsFilter = (f: QuestionFilter, v: { importance: QuestionInput["importance"]; direction: QuestionInput["direction"]; needs_recheck: boolean }) =>
  f === "all" || (f === "high" && v.importance === "high") || (f === "recheck" && v.needs_recheck) || (f === "ask_ai" && v.direction === "ask_ai");

/** 대상 질문이 목록에서 빠졌을 때 초점이 갈 곳 — 거르기 (고른 라디오) */
const filterEl = () => asHtml(document.querySelector('input[name="ask-filter"]:checked')) ?? document.getElementById("ask-title");

/** J/K 를 글자로 써야 하는 자리 — 글 입력 · 선택 · 열린 대화 상자 · 메뉴 안 */
function typingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof Element)) return false;
  if (t.closest('input:not([type="radio"]):not([type="checkbox"]), textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"], [role="combobox"], [role="menu"], [role="listbox"]')) return true;
  // 모달 대화 상자(radix) 안이거나 밖에 열려 있는 동안. 비모달 미리보기(aria-modal=false)는 질문 이동을 막지 않는다
  return !!t.closest('[role="dialog"]:not([aria-modal="false"])') || !!document.querySelector('[role="dialog"][data-state="open"]');
}

/** 거르기 라디오 하나 — 라디오 자체가 누르는 곳 전체(굵은 포인터 44px)를 덮고, 글은 그 아래에 깔린다 */
function FilterRadio({ value, label, count, checked, onChange }: { value: QuestionFilter; label: string; count: number; checked: boolean; onChange: (v: QuestionFilter) => void }) {
  return (
    <label
      className={cn(
        "relative inline-flex min-h-8 min-w-[44px] items-center justify-center rounded-md border px-2.5 text-meta whitespace-nowrap tabular-nums coarse:min-h-[44px]",
        checked ? "border-line-strong bg-background font-semibold text-ink shadow-xs" : "border-transparent text-ink-2 hover:text-ink",
        "has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ring",
      )}
    >
      <input type="radio" name="ask-filter" value={value} checked={checked} onChange={() => onChange(value)} className="absolute -inset-px m-0 h-[calc(100%+2px)] w-[calc(100%+2px)] cursor-pointer opacity-0" />
      {`${label} ${count}`}
    </label>
  );
}

/** 보낼 요청 한 건의 사진 — 시간 초과 뒤 ‘접수 다시 확인’이 같은 요청 · 같은 멱등 키로 다시 보낸다 */
interface SubmitRequest {
  sig: string;
  input: SubmitInput;
  mode: "bundle" | "single";
  /** 보낸 뒤 지울 초안 키들 */
  drafts: string[];
  numbers: number[];
}

const isTimeout = (e: unknown) => e instanceof Error && e.name === "TimeoutError";

/** 제출 실패 문장 — 서버가 거절한 것은 아무것도 접수되지 않았다고 말하고, 연결 문제는 보냈는지 모른다고 말한다(두 번 접수되지 않는다는 말과 함께) */
function submitErrorText(e: unknown): string {
  if (e instanceof PesApiError) return `${e.body.error.message} 아무것도 접수되지 않았어요.${e.body.error.code === "conflict" ? " 질문을 새로 읽었어요 — 바뀐 문구를 확인해 주세요." : ""}`;
  if (e instanceof NotConnectedError) return `${e.message} 아무것도 접수되지 않았어요.`;
  return "보내지 못했어요. 연결을 확인하고 다시 눌러 주세요. 같은 요청이라 다시 눌러도 두 번 접수되지 않아요.";
}

/** 거절 사유 details.question_ids */
function missingIds(e: unknown): string[] {
  const d = e instanceof PesApiError ? e.body.error.details : null;
  const ids = d && typeof d === "object" && d.reason === "required_missing" ? d.question_ids : null;
  return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [];
}

const SEND_REASON = {
  recheck: "새 문구를 확인했다고 체크해 주세요.",
  inapplicable: "지금은 답하지 않는 질문이에요.",
  opinion_only: "이 질문은 답이 있어야 보낼 수 있어요.",
} as const;

/**
 * 질문 영역(설계 4.7 질문·답 · 4.16 · U2b). 위에서 아래: 제목 · 도구 → 거르기 · 이동 → 열린 질문 → 정리된 질문 → 보내기.
 * 휴대폰에서도 답 · 의견 · 거르기 · 이동은 켜져 있고, 질문을 바꾸는 도구는 데스크톱으로 안내한다. 지난 라운드는 읽기 전용 — 도구가 없다.
 * 질문을 바꾸는 명령은 모두 멱등 키 하나로 한 번만 가고, 성공하면 라운드를 다시 읽는다(내 화면이 서버 답을 앞지르지 않는다).
 */
export function AskPane({
  round,
  project,
  edition,
  actions,
  editBlocked,
  peekId,
  onPeek,
  onGoTo,
}: {
  round: RoundView;
  project: string;
  edition: number;
  /** 동작 목록 하나(명령 메뉴와 같은 것) — 질문 맥락 메뉴가 부분 집합을 쓴다 */
  actions: PesAction[];
  /** 질문 도구를 못 쓰는 이유(지난 라운드 · 휴대폰). 있으면 도구는 aria-disabled */
  editBlocked?: string;
  peekId: string | null;
  onPeek: (id: string) => void;
  /** J/K · 이전/다음으로 질문 항목에 초점을 둘 때 — 질문 영역이 숨은 좁은 본문 보기면 보기를 먼저 바꾸고 그려진 뒤 초점을 둔다(WorkspaceScreen). 없으면 바로 초점 */
  onGoTo?: (id: string) => void;
}) {
  const client = useClient();
  const qc = useQueryClient();
  const past = round.state !== "current";
  const all = round.questions;
  const openQs = all.filter(isOpen);
  const closedQs = all.filter((q) => !isOpen(q));
  const [filter, setFilter] = React.useState<QuestionFilter>("all");
  const visible = openQs.filter((q) => matchesFilter(q, filter));
  const counts: Record<QuestionFilter, number> = {
    all: openQs.length,
    high: openQs.filter((q) => matchesFilter(q, "high")).length,
    recheck: openQs.filter((q) => matchesFilter(q, "recheck")).length,
    ask_ai: openQs.filter((q) => matchesFilter(q, "ask_ai")).length,
  };
  const unanswered = openQs.filter((q) => !q.sent);
  const scope = React.useMemo(() => ({ project, edition, form: round.form_version }), [project, edition, round.form_version]);
  const roundKey = round.round_id === null ? "start" : String(round.round_id);
  const blocked = editBlocked ?? (client.capabilities?.questionTools === false ? "서버와 아직 이어지지 않아 질문을 바꿀 수 없어요." : undefined);

  /* ── 답 초안 · 기본값 · 제출(U2c) ── */
  const comments = useComments(project, edition, round.stage, roundKey);
  const threads = comments.data?.threads ?? [];
  const otherThreads = threads.filter((t) => t.question_id === "__other");
  // 초안은 질문마다 칸에 있다 — 묶음 제출은 모두를 한꺼번에 읽는다. 초안이 바뀔 때마다 다시 그린다
  React.useSyncExternalStore(subscribeDrafts, draftsVersion);
  const qk = (q: QuestionView) => `${q.id}@${q.version}`;
  /** ‘새 문구를 확인했어요’ 체크 · ‘기본값 쓰기’로 채운 글 — 질문 버전이 바뀌면 키가 달라져 이어지지 않는다 */
  const [confirmed, setConfirmed] = React.useState<ReadonlySet<string>>(new Set());
  const [defaultsUsed, setDefaultsUsed] = React.useState<ReadonlyMap<string, string>>(new Map());
  const plan: Plan = makePlan({
    open: openQs,
    draftOf: (q) => ({ answer: readDraft(keyFor(scope, q.id, q.version, "answer")), opinion: readDraft(keyFor(scope, q.id, q.version, "opinion")) }),
    confirmed: (q) => confirmed.has(qk(q)),
    defaultUsed: (q) => defaultsUsed.get(qk(q)),
  });
  const requiredLeft = unanswered.filter((q) => q.required && plan.applicable.get(q.id) !== false).length;

  /* ── 명령 뒤 처리: 라운드를 다시 읽고, 알림 글을 남기고, 초점을 되돌린다 ── */
  const refresh = React.useCallback(() => qc.invalidateQueries({ queryKey: ["round", project, edition] }), [qc, project, edition]);
  const [note, setNote] = React.useState<string | null>(null);
  /** 그려진 다음 초점을 둘 자리 — 찾을 때까지 다음 그림들에서 다시 시도하고(남은 횟수), 끝내 없으면 버린다 */
  const after = React.useRef<{ get: () => HTMLElement | null; left: number } | null>(null);
  const focusLater = (get: () => HTMLElement | null) => {
    after.current = { get, left: 30 };
  };
  React.useEffect(() => {
    const a = after.current;
    if (!a) return;
    const el = a.get();
    if (el) {
      after.current = null;
      el.focus();
    } else if (--a.left <= 0) after.current = null;
  });
  const receiptNo = (r: CommandResult<unknown>) => r.receipt.receipt_no;

  const submit = useKeyedCommand();
  const [lastReq, setLastReq] = React.useState<SubmitRequest | null>(null);
  const [reviewOpen, setReviewOpen] = React.useState(false);
  /** 검토 대화 상자를 닫고 초점을 연 단추로 — 대화 상자는 닫힐 때 사라지므로 초점은 작업 공간이 정한다 */
  const closeReview = () => {
    setReviewOpen(false);
    focusLater(() => document.getElementById("review-answers"));
  };
  const buildRequest = (mode: "bundle" | "single", items: PlanItem[]): SubmitRequest => {
    const input: SubmitInput = { mode, form_version: round.form_version, ...(round.set_id ? { set_id: round.set_id } : {}), answers: items.map(toAnswerItem) };
    return {
      sig: JSON.stringify(input),
      input,
      mode,
      drafts: items.flatMap((it) => [keyFor(scope, it.q.id, it.q.version, "answer"), keyFor(scope, it.q.id, it.q.version, "opinion")]),
      numbers: items.map((it) => it.q.number),
    };
  };
  /** 한 번 보낸다 — 성공은 영수증을 받은 뒤에만 말하고, 그때서야 보낸 질문의 초안만 지운다. 거절이면 초안은 그대로(부분 접수 0) */
  const send = async (req: SubmitRequest) => {
    setNote(null);
    setLastReq(req);
    const r = await submit.run(req.sig, (key) => client.submitAnswers(project, edition, round.stage, roundKey, req.input, key));
    if (req.mode === "bundle") closeReview();
    else setReviewOpen(false);
    if (r.ok) {
      const res = r.value;
      const left = res.data.missing_required.length;
      const who = req.mode === "bundle" ? `묶음으로 보냈어요 · 질문 ${req.numbers.length}개` : `질문 ${req.numbers[0]} — 이 답만 보냈어요`;
      const rest = res.data.form_complete ? " 필수 질문에는 모두 답이 있어요." : ` 필수 ${left}개가 남았어요.`;
      setNote(`${who} · 접수 ${receiptNo(res)}.${res.receipt.replayed ? " 이미 접수된 요청이라 다시 만들지 않았어요." : ""}${rest}`);
      setLastReq(null);
      await refresh();
      for (const key of req.drafts) clearDraft(key);
    } else if (r.error instanceof PesApiError && r.error.body.error.code === "conflict") {
      // 보던 질문이 그 사이 바뀌었다 — 새로 읽는다(쓰던 초안은 옛 버전 칸에 그대로 남는다)
      await refresh();
    }
  };
  const sendOne = (q: QuestionView) => {
    const it = plan.single.get(q.id);
    if (it && !submit.pending) void send(buildRequest("single", [it]));
  };
  const reasonFor = (q: QuestionView): string | null => {
    if (plan.single.has(q.id)) return null;
    const skip = plan.skipped.find((x) => x.q.id === q.id);
    return skip ? SEND_REASON[skip.reason] : "";
  };
  const failure = submit.failure;
  const timedOut = !!failure && isTimeout(failure);
  const missingFromServer = missingIds(failure).flatMap((id) => {
    const q = all.find((x) => x.id === id);
    return q ? [q] : [];
  });

  /* ── 질문별 의견(U2c) — 답이 아니다. 제출과 따로 가고, 필수를 채우지 않는다 ── */
  const postComment = (q: QuestionView, input: CommentInput, key: string) => client.addComment(project, edition, q.id, input, key);
  const onPosted = (q: QuestionView, r: CommandResult<unknown>) => {
    setNote(`질문 ${q.number}에 의견을 남겼어요 · 접수 ${receiptNo(r)}. 답으로 세지 않아요.`);
    void qc.invalidateQueries({ queryKey: ["round", project, edition, "comments"] });
  };

  /* ── 질문 고치기 ── */
  const [editing, setEditing] = React.useState<string[]>([]);
  const setEditingFor = (id: string, on: boolean) => setEditing((list) => (on ? (list.includes(id) ? list : [...list, id]) : list.filter((x) => x !== id)));
  /** 저장하거나 더한 질문이 지금 거르기에서 보이지 않게 된 경우 그 id (알림에 덧붙인다) */
  const [hiddenId, setHiddenId] = React.useState<string | null>(null);
  const saveFits = React.useRef(true);
  const save = async (id: string, body: QuestionRevision, key: string) => {
    const r = await client.reviseQuestion(project, edition, id, body, key);
    saveFits.current = fitsFilter(filter, { importance: body.importance, direction: body.direction, needs_recheck: r.data.needs_recheck });
    await refresh();
    return r;
  };
  const onSaved = (q: QuestionView, r: CommandResult<{ question_id: string; version: number; needs_recheck: boolean }>) => {
    setNote(`질문 ${q.number}을 새 버전으로 저장했어요 · 버전 ${r.data.version} · 접수 ${receiptNo(r)}. 옛 답은 지우지 않고 보존해요.`);
    if (saveFits.current) setHiddenId(null);
    else {
      // 고친 질문이 목록에서 빠져 초점이 사라지지 않게 — 거르기로 보낸다
      setHiddenId(q.id);
      focusLater(filterEl);
    }
  };

  /* ── 순서 바꾸기 ── */
  const reorder = useKeyedCommand();
  const move = async (id: string, dir: "up" | "down") => {
    // 보이는 이웃과 자리를 바꾼다 — 거르는 중에도 보이는 순서가 실제로 바뀐다(숨은 질문은 제자리)
    const seen = visible.map((q) => q.id);
    const vi = seen.indexOf(id);
    const vj = dir === "up" ? vi - 1 : vi + 1;
    if (vi < 0 || vj < 0 || vj >= seen.length) return;
    const ids = openQs.map((q) => q.id);
    const i = ids.indexOf(id);
    const j = ids.indexOf(seen[vj]!);
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    setNote(null);
    setHiddenId(null);
    const r = await reorder.run(JSON.stringify(ids), async (key) => {
      const res = await client.reorderQuestions(project, edition, round.stage, roundKey, ids, key);
      await refresh();
      return res;
    });
    if (r.ok) {
      // 자리가 바뀌며 초점이 빠질 수 있다 — 같은 단추로 되돌려 연달아 옮길 수 있게
      focusLater(() => document.getElementById(`tool-${dir}-${id}`));
      setNote(`질문 ${openQs.find((q) => q.id === id)!.number}의 자리를 바꿨어요 · 접수 ${receiptNo(r.value)}.`);
    }
  };

  /* ── 철회 · 보류 · 합치기 ── */
  const [tidy, setTidy] = React.useState<{ kind: TidyKind; q: QuestionView } | null>(null);
  const runTidy = async (kind: TidyKind, id: string, into: string, key: string) => {
    const r = kind === "withdraw" ? await client.withdrawQuestion(project, edition, id, key) : kind === "defer" ? await client.deferQuestion(project, edition, id, key) : await client.mergeQuestion(project, edition, id, into, key);
    await refresh();
    return r;
  };

  /* ── 질문 더하기 ── */
  const [adding, setAdding] = React.useState(false);
  const addFits = React.useRef(true);
  const add = async (body: QuestionInput, key: string) => {
    const r = await client.addQuestion(project, edition, round.stage, roundKey, body, key);
    addFits.current = fitsFilter(filter, { importance: body.importance, direction: body.direction, needs_recheck: false });
    await refresh();
    return r;
  };

  /* ── 이동: n/m · 이전 · 다음 · J/K ── */
  const [cur, setCur] = React.useState<string | null>(null);
  const curRef = React.useRef<string | null>(null);
  const visibleIds = React.useRef<string[]>([]);
  React.useEffect(() => {
    visibleIds.current = visible.map((q) => q.id);
  });
  const at = cur ? visible.findIndex((q) => q.id === cur) : -1;
  const index = at; // -1 = 아직 어느 질문에도 초점이 없었다
  const pos = visible.length === 0 ? 0 : (index < 0 ? 0 : index) + 1;
  const onGoToRef = React.useRef(onGoTo);
  React.useEffect(() => {
    onGoToRef.current = onGoTo;
  });
  const goTo = React.useCallback((id: string) => {
    curRef.current = id;
    setCur(id);
    if (onGoToRef.current) onGoToRef.current(id);
    else itemEl(id)?.focus();
  }, []);
  /** step: 한 칸. fromKey 이고 초점이 질문에 한 번도 없었으면 첫 질문으로(단추는 1/m 에서 한 칸) */
  const step = React.useCallback(
    (dir: 1 | -1, fromKey: boolean) => {
      const ids = visibleIds.current;
      if (!ids.length) return;
      const i = curRef.current ? ids.indexOf(curRef.current) : -1;
      const next = i < 0 ? (fromKey ? 0 : dir === 1 ? Math.min(1, ids.length - 1) : 0) : Math.min(ids.length - 1, Math.max(0, i + dir));
      goTo(ids[next]!);
    },
    [goTo],
  );
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (k !== "j" && k !== "k") return;
      if (e.isComposing || e.keyCode === 229) return;
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      if (typingTarget(e.target)) return;
      e.preventDefault();
      step(k === "j" ? 1 : -1, true);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [step]);
  const onFocusCapture = (e: React.FocusEvent) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>("[data-question]")?.dataset.question;
    if (id && openQs.some((q) => q.id === id)) {
      curRef.current = id;
      setCur(id);
    }
  };
  const prevOff = visible.length === 0 || pos <= 1;
  const nextOff = visible.length === 0 || pos >= visible.length;

  const toolsFor = (i: number): CardTools | null => (past ? null : { ...(blocked ? { blocked } : {}), first: i === 0, last: i === visible.length - 1 });
  const editTarget = visible.find((q) => q.id === cur) ?? visible[0];

  return (
    <div className="px-4 pt-5 pb-16" onFocus={onFocusCapture}>
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div>
          <h2 id="ask-title" tabIndex={-1} className="text-title text-ink outline-none">
            질문
          </h2>
          <p className="text-caption text-muted-foreground">
            {past ? `보낸 답 ${openQs.length - unanswered.length}개 · 읽기 전용` : `답할 질문 ${unanswered.length} / 전체 ${openQs.length} · 필수 남음 ${requiredLeft}`}
          </p>
        </div>
        <div className="flex flex-wrap items-start gap-2">
          <Button
            id="add-question"
            variant="outline"
            size="sm"
            aria-disabled={blocked ? true : undefined}
            aria-describedby={blocked ? "edit-reason" : undefined}
            onClick={(e) => {
              if (blocked) return void e.preventDefault();
              setAdding(true);
            }}
          >
            <Plus aria-hidden="true" />
            질문 더하기
          </Button>
          <ActionButton
            variant="outline"
            size="sm"
            blockedReason={blocked}
            reasonId="edit-reason"
            reasonClassName="max-w-48"
            onClick={() => {
              if (editTarget) setEditingFor(editTarget.id, true);
            }}
          >
            <PenLine aria-hidden="true" />
            질문 고치기
          </ActionButton>
        </div>
      </div>
      <p role="status" className={cn("text-meta text-ink", (note || submit.pending) && "mt-3")}>
        {submit.pending ? "보내는 중이에요. 접수 번호가 올 때까지 기다려 주세요." : note}
        {!submit.pending && note && hiddenId && !visible.some((q) => q.id === hiddenId) ? " 지금 거르기에서는 보이지 않아요. ‘전체’로 보세요." : ""}
      </p>
      {timedOut && lastReq ? (
        <div role="status" className="mt-3 rounded-md border border-warn-line bg-warn-soft px-3 py-2.5">
          <p className="text-meta text-ink">
            <strong className="font-semibold">접수 확인 중</strong> — 서버 응답이 늦어요. 접수됐는지 아직 몰라요. 같은 요청으로 다시 확인하면 두 번 접수되지 않아요.
          </p>
          <Button className="mt-2 bg-background coarse:min-h-[44px]" size="sm" aria-disabled={submit.pending ? true : undefined} onClick={() => !submit.pending && void send(lastReq)}>
            접수 다시 확인
          </Button>
        </div>
      ) : null}
      {failure && !timedOut ? (
        <div role="alert" className="mt-3 rounded-md border border-bad-line bg-bad-soft px-3 py-2.5 text-meta text-bad">
          <p>{submitErrorText(failure)}</p>
          {missingFromServer.length ? (
            <p className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <span>비어 있는 필수:</span>
              {missingFromServer.map((q) => (
                <Button key={q.id} size="xs" className="bg-background coarse:min-h-[44px]" onClick={() => goTo(q.id)}>
                  질문 {q.number}로 가기
                </Button>
              ))}
            </p>
          ) : null}
        </div>
      ) : null}
      {reorder.error ? (
        <p role="alert" className="mt-3 rounded-md border border-bad-line bg-bad-soft px-3 py-2 text-meta text-bad">
          {reorder.error}
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div role="radiogroup" aria-label="질문 거르기" className="flex flex-wrap gap-1 rounded-lg bg-muted p-1">
          {FILTERS.map((f) => (
            <FilterRadio key={f.value} value={f.value} label={f.label} count={counts[f.value]} checked={filter === f.value} onChange={setFilter} />
          ))}
        </div>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="sm" aria-label="이전 질문" aria-keyshortcuts="K" aria-disabled={prevOff ? true : undefined} onClick={(e) => (prevOff ? e.preventDefault() : step(-1, false))}>
            <ChevronUp aria-hidden="true" />
            이전
          </Button>
          <span className="min-w-11 text-center text-meta text-ink tabular-nums">
            <span className="sr-only">질문 위치 </span>
            <span data-position="">{`${pos}/${visible.length}`}</span>
          </span>
          <Button variant="outline" size="sm" aria-label="다음 질문" aria-keyshortcuts="J" aria-disabled={nextOff ? true : undefined} onClick={(e) => (nextOff ? e.preventDefault() : step(1, false))}>
            <ChevronDown aria-hidden="true" />
            다음
          </Button>
        </div>
      </div>

      {visible.length ? (
        <ol className="mt-3">
          {visible.map((q) => (
            <QuestionCard
              key={q.id}
              q={q}
              all={all}
              others={openQs.filter((x) => x.id !== q.id)}
              scope={scope}
              actions={actions}
              open={peekId === q.id}
              onPeek={onPeek}
              tools={toolsFor(visible.indexOf(q))}
              editing={editing.includes(q.id)}
              onEditing={(on) => setEditingFor(q.id, on)}
              save={save}
              onSaved={onSaved}
              onMove={move}
              onTidy={(id, kind) => setTidy({ q: all.find((x) => x.id === id)!, kind })}
              answering={
                past
                  ? null
                  : {
                      applicable: plan.applicable.get(q.id) !== false,
                      confirmed: confirmed.has(qk(q)),
                      onConfirm: (on) => setConfirmed((prev) => (on ? new Set(prev).add(qk(q)) : new Set([...prev].filter((k) => k !== qk(q))))),
                      blockedReason: reasonFor(q),
                      busy: submit.pending,
                      onSend: () => sendOne(q),
                      onFilled: (value) =>
                        setDefaultsUsed((prev) => {
                          const next = new Map(prev);
                          if (value === null) next.delete(qk(q));
                          else next.set(qk(q), value);
                          return next;
                        }),
                    }
              }
              thread={{ threads: threads.filter((t) => t.question_id === q.id), unavailable: comments.data?.unavailable === true, post: postComment, onPosted }}
            />
          ))}
        </ol>
      ) : (
        <p className="mt-4 rounded-md bg-surface-soft px-3 py-3 text-meta text-ink-2">
          {openQs.length ? "해당하는 질문이 없어요. ‘전체’로 돌아가면 모두 보여요." : "열린 질문이 없어요."}
        </p>
      )}

      {closedQs.length ? (
        <section aria-label="정리된 질문" data-region="closed" className="mt-6 border-t pt-4">
          <h3 className="text-meta font-semibold text-ink">정리된 질문 {closedQs.length}</h3>
          <p className="text-caption text-muted-foreground">지우지 않아요. 보낸 답은 그대로 남아요.</p>
          <ul className="mt-2">
            {closedQs.map((q) => (
              <ClosedCard key={q.id} q={q} all={all} />
            ))}
          </ul>
        </section>
      ) : null}

      {otherThreads.length ? (
        <section aria-label="질문에 묶이지 않은 의견" className="mt-6 border-t pt-4">
          <h3 className="text-meta font-semibold text-ink">질문에 묶이지 않은 의견</h3>
          <p className="mb-2 text-caption text-muted-foreground">이전된 프로젝트에서 질문에 붙지 않은 채 남은 의견이에요.</p>
          <MessageList threads={otherThreads} label="묶이지 않은 의견 목록" />
        </section>
      ) : null}

      {!past ? (
        <div className="mt-2 space-y-3 border-t pt-4">
          <p className="text-caption text-muted-foreground">초안은 이 탭에만 있어요. 탭을 닫거나 다른 기기로 옮기면 남지 않습니다.</p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <Button
              id="review-answers"
              variant="default"
              className="coarse:min-h-[44px]"
              aria-disabled={plan.items.length === 0 || submit.pending ? true : undefined}
              aria-describedby="review-hint"
              onClick={(e) => {
                if (plan.items.length === 0 || submit.pending) return void e.preventDefault();
                setReviewOpen(true);
              }}
            >
              답 검토 후 보내기
            </Button>
            <span id="review-hint" className="text-caption text-muted-foreground">
              {plan.items.length ? `보낼 초안 ${plan.items.length}개${plan.missing.length ? ` · 비어 있는 필수 ${plan.missing.length}개` : ""}` : "보낼 초안이 아직 없어요."}
            </span>
          </div>
        </div>
      ) : null}
      {reviewOpen ? <AnswerReview plan={plan} pending={submit.pending} onCancel={closeReview} onConfirm={() => void send(buildRequest("bundle", plan.items))} /> : null}

      <AddQuestionDialog
        open={adding}
        onOpenChange={(o) => {
          setAdding(o);
          if (!o) focusLater(() => document.getElementById("add-question"));
        }}
        add={add}
        onAdded={(id) => {
          if (addFits.current) {
            setHiddenId(null);
            setNote("질문을 더했어요. 사람이 더한 질문으로 보여요.");
            setCur(id);
            curRef.current = id;
            focusLater(() => itemEl(id));
          } else {
            setHiddenId(id);
            setNote("질문을 더했어요. 사람이 더한 질문으로 보여요.");
            focusLater(filterEl);
          }
        }}
      />
      {tidy ? (
        <TidyDialog
          kind={tidy.kind}
          q={tidy.q}
          targets={openQs.filter((x) => x.id !== tidy.q.id)}
          onClose={() => {
            // 취소 · Esc: 연 단추로
            const { kind, q } = tidy;
            setTidy(null);
            focusLater(() => document.getElementById(`tidy-${kind}-${q.id}`));
          }}
          run={(into, key) => runTidy(tidy.kind, tidy.q.id, into, key)}
          onDone={() => {
            const n = tidy.q.number;
            const name = { withdraw: "철회했어요", defer: "보류했어요", merge: "합쳤어요" }[tidy.kind];
            setHiddenId(null);
            setNote(`질문 ${n}을 ${name}. ‘정리된 질문’에 남아 있어요.`);
            const next = visible.find((x) => x.id !== tidy.q.id && x.number > n) ?? visible.find((x) => x.id !== tidy.q.id);
            setTidy(null);
            focusLater(() => (next ? itemEl(next.id) : document.getElementById("ask-title")));
          }}
        />
      ) : null}
    </div>
  );
}
