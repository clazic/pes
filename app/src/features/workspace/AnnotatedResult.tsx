import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Bot, ListTodo, MessageSquarePlus, Paperclip } from "lucide-react";
import { useAnnotations, useClient } from "@/api/queries";
import { PesApiError, type AnnotationInput, type ResultView, type WorkspaceView, type RoundView } from "@/api/types";
import { Kbd } from "@/components/pes/kbd";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cpLength, sliceCp, snapUtf16Range, utf16ToCp } from "@/lib/anchor-text";
import { formatAt } from "@/lib/labels";
import { AnnotationRegion } from "./AnnotationRegion";
import { AnnotationContext, ErrorLine, Quote, annotationScope, loadTaskProgress, pendingKeep, saveTaskProgress, useAnnotationWrite, useAnnotationCtx, type AnnotationCtx, type Note } from "./annotation-kit";
import { controlClass, Field } from "./fields";
import { parseBody, segmentsOf, type Block, type CellBlock, type MarkSpec } from "./result-blocks";

/** 결과 글 본문이 첨언 기준을 모두 갖춘 모양(서버가 object_id · version_id · body_md 를 모두 줄 때만) */
export type AnnotatableResult = ResultView & { object_id: string; version_id: string; body_md: string };

export const isAnnotatable = (r: ResultView | null | undefined): r is AnnotatableResult => !!r && typeof r.object_id === "string" && typeof r.version_id === "string" && typeof r.body_md === "string";

/** prefix · suffix 로 싣는 앞뒤 글의 길이(code point) */
const CONTEXT_CP = 40;

/** 글에서 고른 한 구간 — 위치는 body_md 기준 code point, version_id 는 그 구간을 고른 글 버전(다른 버전에 그 좌표를 쓰지 않는다) */
interface Picked {
  version_id: string;
  start_cp: number;
  end_cp: number;
  quote: string;
  prefix: string;
  suffix: string;
}

type Read = { kind: "none" } | { kind: "cross" } | { kind: "ok"; picked: Picked };

const blockOf = (n: Node): HTMLElement | null => (n.nodeType === Node.TEXT_NODE ? n.parentElement : (n as Element))?.closest<HTMLElement>("[data-cp-start]") ?? null;

/** 그 블록 안에서 (container, offset) 앞에 있는 글자 수(UTF-16) */
function offsetIn(block: HTMLElement, container: Node, offset: number): number {
  const r = document.createRange();
  r.selectNodeContents(block);
  r.setEnd(container, offset);
  return r.toString().length;
}

/**
 * 지금 DOM 선택 → 글 위치. 접힌 선택 · 결과 글 밖은 none, 블록(문단 · 표 칸)을 넘나들면 cross.
 * 서로게이트 쌍 한가운데에서 시작/끝난 선택은 쌍 바깥으로 넓힌다(서버가 외톨이 서로게이트를 거절한다).
 */
function readSelection(article: HTMLElement, body: string, versionId: string): Read {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return { kind: "none" };
  const range = sel.getRangeAt(0);
  const startIn = article.contains(range.startContainer);
  const endIn = article.contains(range.endContainer);
  if (!startIn && !endIn) return { kind: "none" };
  if (!startIn || !endIn) return { kind: "cross" };
  let a = blockOf(range.startContainer);
  let b = blockOf(range.endContainer);
  if (!a || !b) return { kind: "cross" };
  let su = offsetIn(a, range.startContainer, range.startOffset);
  let eu = offsetIn(b, range.endContainer, range.endOffset);
  if (a !== b) {
    // 문단 통째로 고르면(세 번 누르기) 끝이 다음 블록 맨 앞에 놓인다 — 그 선택은 앞 블록 안의 선택이다
    if (eu === 0) {
      b = a;
      eu = (a.textContent ?? "").length;
    } else if (su === (a.textContent ?? "").length) {
      a = b;
      su = 0;
    }
  }
  if (a !== b) return { kind: "cross" };
  const text = a.textContent ?? "";
  try {
    const snapped = snapUtf16Range(text, su, eu);
    if (snapped.end <= snapped.start || text.slice(snapped.start, snapped.end).trim() === "") return { kind: "none" };
    const base = Number(a.dataset.cpStart);
    const start_cp = base + utf16ToCp(text, snapped.start);
    const end_cp = base + utf16ToCp(text, snapped.end);
    const quote = sliceCp(body, start_cp, end_cp);
    // 화면 글과 본문이 어긋나 있으면(다시 읽는 중) 위치를 지어내지 않는다
    if (quote !== text.slice(snapped.start, snapped.end)) return { kind: "none" };
    const total = cpLength(body);
    return {
      kind: "ok",
      picked: { version_id: versionId, start_cp, end_cp, quote, prefix: sliceCp(body, Math.max(0, start_cp - CONTEXT_CP), start_cp), suffix: sliceCp(body, end_cp, Math.min(total, end_cp + CONTEXT_CP)) },
    };
  } catch {
    return { kind: "none" };
  }
}

const samePicked = (x: Picked | null, y: Picked | null) => (x === null || y === null ? x === y : x.version_id === y.version_id && x.start_cp === y.start_cp && x.end_cp === y.end_cp);

/** 고른 구간이 지금 글과 다른 버전에서 나온 것일 때(본문이 그사이 바뀜) */
const STALE_PICK = "본문이 바뀌었어요 — 고른 구간은 쓰지 않았어요. 새 본문에서 구간을 다시 골라 주세요.";

const MARK_CLASS = {
  open: "rounded-xs bg-primary-soft text-ink underline decoration-primary decoration-2 underline-offset-[3px]",
  resolved: "rounded-xs bg-surface-sunk text-ink underline decoration-ink-2 decoration-1 underline-offset-[3px]",
} as const;

function Marked({ block, marks }: { block: { start_cp: number; text: string }; marks: MarkSpec[] }) {
  return segmentsOf(block, marks).map((seg, i) =>
    seg.threads.reduce<React.ReactNode>(
      (inner, m) => (
        <mark key={m.thread_id} data-thread={m.thread_id} data-anchor-status={m.status} aria-describedby={`annotation-${m.thread_id}`} className={m.state === "resolved" ? MARK_CLASS.resolved : MARK_CLASS.open}>
          {inner}
        </mark>
      ),
      <React.Fragment key={i}>{seg.text}</React.Fragment>,
    ),
  );
}

const BlockView = React.memo(function BlockView({ block, marks }: { block: Block; marks: MarkSpec[] }) {
  if (block.kind === "p") {
    return (
      <p data-cp-start={block.start_cp} className="text-body whitespace-pre-line text-ink">
        <Marked block={block} marks={marks} />
      </p>
    );
  }
  const cell = (c: CellBlock, key: number) => {
    const Tag = c.header ? "th" : "td";
    return (
      <Tag key={key} data-cp-start={c.start_cp} className={c.header ? "border-b bg-surface-soft px-3 py-1.5 text-left text-meta font-semibold text-ink" : "border-b px-3 py-1.5 text-meta text-ink"}>
        <Marked block={c} marks={marks} />
      </Tag>
    );
  };
  const [head, ...rest] = block.rows;
  const hasHead = head?.[0]?.header === true;
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full border-collapse">
        {hasHead && head ? (
          <thead>
            <tr>{head.map(cell)}</tr>
          </thead>
        ) : null}
        <tbody>
          {(hasHead ? rest : block.rows).map((row, r) => (
            <tr key={r}>{row.map(cell)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
});

/* ───────────── 대화 상자: 첨언 달기 · 다음 라운드 할 일 ───────────── */

function TextCommandDialog({
  title,
  description,
  quote,
  initialText,
  label,
  submitLabel,
  emptyHint,
  alert,
  pending,
  doneRef,
  onSubmit,
  onCancel,
}: {
  title: string;
  description: string;
  quote: string;
  /** 확인 중인 요청이 처음 보낸 글 — 다시 열었을 때 되살린다(같은 글이면 같은 멱등 키로 확인한다) */
  initialText?: string;
  label: string;
  submitLabel: string;
  emptyHint: string;
  alert: string | null;
  pending: boolean;
  doneRef: React.RefObject<boolean>;
  onSubmit: (text: string) => Promise<void>;
  onCancel: () => void;
}) {
  const ctx = useAnnotationCtx();
  const [text, setText] = React.useState(initialText ?? "");
  const [tried, setTried] = React.useState(false);
  const box = React.useRef<HTMLTextAreaElement>(null);
  const empty = text.trim() === "";
  const invalid = tried && empty;
  const submit = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    if (pending) return;
    if (empty) {
      setTried(true);
      return;
    }
    await onSubmit(text.trim());
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          box.current?.focus();
        }}
        // 성공으로 닫히면 초점은 상태 줄(영수증)로, 취소 · Esc 는 연 단추로(기본 동작)
        onCloseAutoFocus={(e) => {
          if (doneRef.current) {
            e.preventDefault();
            ctx.focusStatus();
          } else {
            // 취소 · Esc: 초점이 도구 단추로 돌아간 다음 고른 구간을 다시 선택 상태로 둔다
            setTimeout(ctx.restoreSelection, 0);
          }
        }}
      >
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <Quote>{quote}</Quote>
          <Field id="annotation-text" label={label}>
            <textarea
              ref={box}
              id="annotation-text"
              rows={4}
              value={text}
              onChange={(e) => setText(e.target.value)}
              aria-invalid={invalid ? true : undefined}
              aria-describedby={invalid ? "annotation-text-hint" : undefined}
              className={controlClass}
            />
            {invalid ? (
              <p id="annotation-text-hint" className="mt-1 text-caption text-bad">
                {emptyHint}
              </p>
            ) : null}
          </Field>
          {alert ? <ErrorLine>{alert}</ErrorLine> : null}
          <DialogFooter>
            <Button onClick={onCancel}>취소</Button>
            <Button type="submit" variant="default" aria-disabled={pending ? "true" : undefined}>
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function annotationInput(ctx: AnnotationCtx, picked: Picked, text: string): AnnotationInput {
  return {
    target_object_id: ctx.objectId,
    // 구간을 고른 그 버전(지금 글 버전과 다르면 보내기 전에 막는다)
    target_version_id: picked.version_id,
    anchor: { exact_quote: picked.quote, prefix: picked.prefix, suffix: picked.suffix, start_cp: picked.start_cp, end_cp: picked.end_cp },
    body_md: text,
  };
}

/** 확인 중인 첨언 요청(keep)이 지금 고른 구간 · 글 버전과 같으면 그 글 — 아니면 빈 글 */
function keptBody(keep: unknown, ctx: AnnotationCtx, picked: Picked): string {
  if (!keep || typeof keep !== "object") return "";
  const k = keep as Partial<AnnotationInput>;
  const same = k.target_object_id === ctx.objectId && k.target_version_id === picked.version_id && k.anchor?.start_cp === picked.start_cp && k.anchor?.end_cp === picked.end_cp;
  return same && typeof k.body_md === "string" ? k.body_md : "";
}

function AnnotateDialog({ ctx, picked, doneRef, onDone, onCancel }: { ctx: AnnotationCtx; picked: Picked; doneRef: React.RefObject<boolean>; onDone: () => void; onCancel: () => void }) {
  const client = useClient();
  const scope = annotationScope(ctx, "create");
  const write = useAnnotationWrite(ctx, scope);
  // 시간 초과 뒤 닫았다 다시 연 같은 구간이면, 확인 중인 첨언 글을 되살린다
  const [initial] = React.useState(() => keptBody(pendingKeep(scope), ctx, picked));
  const submit = async (text: string) => {
    if (picked.version_id !== ctx.versionId) return;
    const input = annotationInput(ctx, picked, text);
    const r = await write.run(JSON.stringify(input), (key) => client.createAnnotation(ctx.slug, ctx.edition, input, key), "첨언을 남겼어요.", input);
    if (r.ok) onDone();
  };
  return (
    <TextCommandDialog
      title="첨언 달기"
      description="고른 구간에 첨언을 남겨요. 글은 바뀌지 않고, 구간은 글이 고쳐져도 인용문으로 다시 찾아요."
      quote={picked.quote}
      initialText={initial}
      label="첨언"
      submitLabel="첨언 달기"
      emptyHint="첨언을 적어 주세요."
      alert={write.alert}
      pending={write.pending}
      doneRef={doneRef}
      onSubmit={submit}
      onCancel={onCancel}
    />
  );
}

/** “할 일로” — 첨언 스레드를 먼저 만들고 그 스레드에서 다음 라운드 할 일을 제안한다. 제안일 뿐 적용하지 않는다 */
function TaskDialog({ ctx, picked, doneRef, onDone, onCancel }: { ctx: AnnotationCtx; picked: Picked; doneRef: React.RefObject<boolean>; onDone: () => void; onCancel: () => void }) {
  const client = useClient();
  const createScope = annotationScope(ctx, "task-create");
  const progressScope = annotationScope(ctx, "task-thread");
  const create = useAnnotationWrite(ctx, createScope);
  const propose = useAnnotationWrite(ctx, annotationScope(ctx, "task-propose"));
  const anchor = `${picked.version_id}|${picked.start_cp}|${picked.end_cp}`;
  // 스레드는 만들어졌는데 제안이 막혔을 때, 다시 눌러도 · 닫았다 다시 열어도 스레드를 또 만들지 않는다(진행은 대화 상자 밖에 둔다)
  const [initial] = React.useState(() => {
    const p = loadTaskProgress(progressScope);
    return p && p.anchor === anchor ? p.text : keptBody(pendingKeep(createScope), ctx, picked);
  });
  const submit = async (text: string) => {
    if (picked.version_id !== ctx.versionId) return;
    const progress = loadTaskProgress(progressScope);
    let origin = progress && progress.anchor === anchor ? progress.thread_id : null;
    if (origin === null) {
      const input = annotationInput(ctx, picked, text);
      const r = await create.run(JSON.stringify(input), (key) => client.createAnnotation(ctx.slug, ctx.edition, input, key), "첨언을 남겼어요.", input);
      if (!r.ok) return;
      origin = r.value.data.thread_id;
      saveTaskProgress(progressScope, { anchor, thread_id: origin, text });
    }
    const thread = origin;
    const r = await propose.run(
      `${thread}|${text}`,
      (key) => client.proposeFollowup(ctx.slug, ctx.edition, { origin_thread_id: thread, kind: "next_round_task", description: text, target_stage: ctx.stage }, key),
      "다음 라운드 할 일로 남겼어요. 제안 상태예요.",
    );
    if (r.ok) {
      saveTaskProgress(progressScope, null);
      onDone();
    }
  };
  return (
    <TextCommandDialog
      title="다음 라운드 할 일"
      description="고른 구간을 첨언으로 남기고, 다음 라운드에서 할 일로 제안해요. 제안만 남고 글은 바뀌지 않아요."
      quote={picked.quote}
      initialText={initial}
      label="할 일"
      submitLabel="할 일로 남기기"
      emptyHint="할 일을 적어 주세요."
      alert={create.alert ?? propose.alert}
      pending={create.pending || propose.pending}
      doneRef={doneRef}
      onSubmit={submit}
      onCancel={onCancel}
    />
  );
}

/* ───────────── 선택 도구줄 ───────────── */

const TOOL_CLASS = "min-w-0";

function SelectionToolbar({ picked, reanchoring, toolbarRef, onAnnotate, onAsk, onTask, onAttach }: { picked: Picked; reanchoring: boolean; toolbarRef: React.RefObject<HTMLDivElement | null>; onAnnotate: () => void; onAsk: () => void; onTask: () => void; onAttach: () => void }) {
  // 도구줄 패턴: 좌우 화살표로 단추 사이를 옮긴다
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const buttons = [...(toolbarRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    e.preventDefault();
    buttons[(at + (e.key === "ArrowRight" ? 1 : buttons.length - 1)) % buttons.length]?.focus();
  };
  return (
    <div
      ref={toolbarRef}
      role="toolbar"
      aria-label="선택한 글 도구"
      aria-keyshortcuts="Alt+M"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      data-print="hide"
      className="sticky bottom-4 z-20 mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border bg-popover px-3 py-2 text-popover-foreground shadow-md"
    >
      <p className="min-w-0 flex-[1_1_12rem] truncate text-caption text-ink-2">
        고른 글 · <span className="text-ink">“{picked.quote}”</span>
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {reanchoring ? (
          <Button variant="default" size="sm" className={TOOL_CLASS} onClick={onAttach}>
            <Paperclip aria-hidden="true" />
            이 구간에 붙이기
          </Button>
        ) : (
          <>
            <Button variant="default" size="sm" className={TOOL_CLASS} onClick={onAnnotate}>
              <MessageSquarePlus aria-hidden="true" />
              첨언
            </Button>
            <Button size="sm" className={TOOL_CLASS} onClick={onAsk}>
              <Bot aria-hidden="true" />
              AI에게 묻기
            </Button>
            <Button size="sm" className={TOOL_CLASS} onClick={onTask}>
              <ListTodo aria-hidden="true" />
              할 일로
            </Button>
          </>
        )}
      </div>
      <p className="text-caption text-muted-foreground">
        <Kbd>Alt</Kbd>+<Kbd>M</Kbd> 로 여기로 옮겨요 · <Kbd>Esc</Kbd> 닫기
      </p>
    </div>
  );
}

/**
 * 결과 글(첨언 가능) — 본문을 블록(문단 · 표 칸)으로 그려 위치(data-cp-start)를 싣고, 글에서 구간을 고르면 도구줄(첨언 · AI에게 묻기 · 할 일로)이 뜬다.
 * 그 아래 첨언 목록(앵커 4상태 · 해결 · 후속 채택). 서버가 본문 · 객체 · 버전을 주지 않으면 이 컴포넌트를 쓰지 않는다(위치를 지어내지 않는다).
 * enabled = 쓸 수 있는가(휴대폰 · 지난 라운드가 아님). 아니면 목록은 읽기만 되고 쓰기 단추는 이유와 함께 막힌다.
 */
export function AnnotatedResult({ ws, round, result, blockedReason }: { ws: WorkspaceView; round: RoundView; result: AnnotatableResult; blockedReason?: string }) {
  const qc = useQueryClient();
  const client = useClient();
  const enabled = !blockedReason;
  const blocks = React.useMemo(() => parseBody(result.body_md), [result.body_md]);
  const read = useAnnotations(ws.slug, ws.edition, result.object_id);
  const threads = React.useMemo(() => read.data?.threads ?? [], [read.data]);

  const [note, setNote] = React.useState<Note>(null);
  const [pickedRaw, setPicked] = React.useState<Picked | null>(null);
  const [dialog, setDialog] = React.useState<"annotate" | "task" | null>(null);
  const [reanchoringRaw, setReanchoring] = React.useState<string | null>(null);
  const [focusTick, setFocusTick] = React.useState(0);
  // 쓸 수 없게 되면(휴대폰으로 바뀜 · 지난 라운드로 이동) 도구를 거둔다 — 상태를 지우지 않고 보이는 값만 막는다
  // 다른 글 버전에서 고른 구간은 지금 글에 쓰지 않는다(본문이 바뀐 그 커밋부터 도구 · 대화 상자가 그 좌표를 못 쓴다)
  const picked = enabled && pickedRaw?.version_id === result.version_id ? pickedRaw : null;
  // 본문이 새 버전으로 바뀐 렌더에서 옛 버전에서 고른 구간 · 열린 대화 상자를 거두고 다시 고르라고 알린다(다시 붙이기는 이어서 할 수 있다)
  const [staleTick, setStaleTick] = React.useState(0);
  if (pickedRaw && pickedRaw.version_id !== result.version_id) {
    setPicked(null);
    setDialog(null);
    setNote({ kind: "hint", text: STALE_PICK });
    setStaleTick((t) => t + 1);
  }
  const reanchoring = enabled ? reanchoringRaw : null;

  const articleRef = React.useRef<HTMLElement>(null);
  const toolbarRef = React.useRef<HTMLDivElement>(null);
  const statusRef = React.useRef<HTMLParagraphElement>(null);
  const doneRef = React.useRef(false);
  const openerRef = React.useRef<HTMLElement | null>(null);
  const hadDialog = React.useRef(false);
  /** 마지막으로 읽은 선택 범위의 사본 — 초점이 옮겨지며 선택이 접혀도 되돌릴 수 있게 */
  const savedRange = React.useRef<Range | null>(null);
  // 이벤트 처리기가 마지막 값을 읽는다
  const live = React.useRef({ picked, dialog, reanchoring });
  React.useLayoutEffect(() => {
    live.current = { picked, dialog, reanchoring };
  }, [picked, dialog, reanchoring]);

  const restoreSelection = React.useCallback(() => {
    const saved = savedRange.current;
    const sel = window.getSelection();
    if (!saved || !sel || !sel.isCollapsed || !articleRef.current?.contains(saved.commonAncestorContainer)) return;
    sel.removeAllRanges();
    sel.addRange(saved);
  }, []);
  const say = React.useCallback((n: Note) => setNote(n), []);
  const focusStatus = React.useCallback(() => statusRef.current?.focus(), []);
  const refresh = React.useCallback(() => qc.invalidateQueries({ queryKey: ["round", ws.slug, ws.edition] }), [qc, ws.slug, ws.edition]);
  const startReanchor = React.useCallback((threadId: string) => {
    setReanchoring(threadId);
    setNote({ kind: "hint", text: "새 구간을 고르세요 — 글에서 붙일 구간을 고르면 ‘이 구간에 붙이기’가 나와요. Esc 로 그만둘 수 있어요." });
  }, []);
  const cancelReanchor = React.useCallback(() => {
    setReanchoring(null);
    setNote(null);
  }, []);

  const ctx: AnnotationCtx = {
    slug: ws.slug,
    edition: ws.edition,
    stage: round.stage,
    objectId: result.object_id,
    versionId: result.version_id,
    body: result.body_md,
    ...(blockedReason ? { readOnly: blockedReason } : {}),
    say,
    restoreSelection,
    focusStatus,
    refresh,
    reanchoring,
    startReanchor,
    cancelReanchor,
  };

  // 글 위 표시: exact · moved 만(ambiguous · lost 는 추측으로 칠하지 않는다), 보관된 것 제외
  const marks = React.useMemo<MarkSpec[]>(
    () =>
      threads.flatMap((t): MarkSpec[] => {
        const c = t.anchor.current;
        // 판정이 지금 보는 글과 다른 버전 기준이면 그 위치를 이 글에 칠하지 않는다(다른 버전의 좌표다)
        if (t.state === "archived" || c.evaluated_version_id !== result.version_id || (c.status !== "exact" && c.status !== "moved") || c.start_cp === null || c.end_cp === null) return [];
        return [{ thread_id: t.thread_id, start_cp: c.start_cp, end_cp: c.end_cp, state: t.state, status: c.status }];
      }),
    [threads, result.version_id],
  );

  // 선택 · 키보드(Alt+M · Esc)
  React.useEffect(() => {
    const article = articleRef.current;
    if (!enabled || !article) return;
    let dragging = false;
    let pressing = false;
    const inTool = (n: EventTarget | null) => n instanceof Node && !!toolbarRef.current?.contains(n);
    const update = () => {
      // 대화 상자가 열린 동안은 고른 구간(사진)을 그대로 둔다 — 글 입력칸으로 초점이 가며 선택이 풀려도 도구를 잃지 않게
      if (live.current.dialog) return;
      const r = readSelection(article, result.body_md, result.version_id);
      if (r.kind === "ok") {
        savedRange.current = window.getSelection()?.getRangeAt(0).cloneRange() ?? null;
        setPicked((prev) => (samePicked(prev, r.picked) ? prev : r.picked));
        setNote((n) => (n?.kind === "hint" && live.current.reanchoring === null ? null : n));
      } else {
        setPicked((prev) => (prev === null ? prev : null));
        if (r.kind === "cross") setNote({ kind: "hint", text: "선택은 한 문단이나 한 표 칸 안에서만 할 수 있어요. 구간을 줄여 다시 골라 주세요." });
      }
    };
    // 도구줄 단추를 누르는 동안(브라우저에 따라 선택이 접힌다)에는 도구를 거두지 않는다
    const onDown = (e: Event) => {
      if (inTool(e.target)) pressing = true;
      else if (article.contains(e.target as Node)) dragging = true;
    };
    const onUp = (e: Event) => {
      dragging = false;
      if (pressing || inTool(e.target)) {
        pressing = false;
        return;
      }
      update();
    };
    const onChange = () => {
      if (!dragging && !pressing && !inTool(document.activeElement)) update();
    };
    const onKeyUp = () => {
      if (!inTool(document.activeElement)) update();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "KeyM" && e.altKey && !e.ctrlKey && !e.metaKey) {
        if (live.current.dialog) return;
        const r = readSelection(article, result.body_md, result.version_id);
        if (r.kind !== "ok") return;
        e.preventDefault();
        savedRange.current = window.getSelection()?.getRangeAt(0).cloneRange() ?? null;
        setPicked((prev) => (samePicked(prev, r.picked) ? prev : r.picked));
        setFocusTick((t) => t + 1);
      } else if (e.key === "Escape" && !live.current.dialog) {
        if (live.current.picked) {
          window.getSelection()?.removeAllRanges();
          setPicked(null);
        } else if (live.current.reanchoring) {
          setReanchoring(null);
          setNote({ kind: "hint", text: "다시 붙이기를 그만뒀어요." });
        }
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("mouseup", onUp);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("touchend", onUp);
    document.addEventListener("keyup", onKeyUp);
    document.addEventListener("selectionchange", onChange);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("mouseup", onUp);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("touchend", onUp);
      document.removeEventListener("keyup", onKeyUp);
      document.removeEventListener("selectionchange", onChange);
      document.removeEventListener("keydown", onKey);
    };
  }, [enabled, result.body_md, result.version_id]);

  // 거둔 뒤: 옛 선택(DOM)을 지우고 초점을 안내가 뜬 상태 줄로
  React.useEffect(() => {
    if (staleTick === 0) return;
    savedRange.current = null;
    window.getSelection()?.removeAllRanges();
    statusRef.current?.focus();
  }, [staleTick]);

  // 대화 상자가 닫히는 그 커밋에서 초점을 정한다(닫힌 뒤 한 박자 늦게 body 로 떨어져 있지 않게) — 성공이면 상태 줄(영수증), 취소 · Esc 면 연 단추
  React.useLayoutEffect(() => {
    if (dialog) {
      hadDialog.current = true;
      return;
    }
    if (!hadDialog.current) return;
    hadDialog.current = false;
    if (doneRef.current) statusRef.current?.focus();
    else if (openerRef.current?.isConnected) openerRef.current.focus();
  }, [dialog]);

  // Alt+M: 도구 첫 단추로 초점(선택은 그대로)
  React.useEffect(() => {
    if (focusTick === 0) return;
    toolbarRef.current?.querySelector<HTMLElement>("button")?.focus();
    restoreSelection();
  }, [focusTick, restoreSelection]);

  const reanchorWrite = useAnnotationWrite(ctx, annotationScope({ slug: ws.slug, edition: ws.edition, objectId: result.object_id }, "reanchor"));
  const finish = () => {
    doneRef.current = true;
    setDialog(null);
    setPicked(null);
    window.getSelection()?.removeAllRanges();
  };
  const openDialog = (which: "annotate" | "task") => {
    doneRef.current = false;
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setDialog(which);
  };
  const dropStale = () => {
    savedRange.current = null;
    setPicked(null);
    window.getSelection()?.removeAllRanges();
    setNote({ kind: "hint", text: STALE_PICK });
    statusRef.current?.focus();
  };
  const attach = async () => {
    const thread = reanchoring;
    if (!thread || !picked) return;
    // 고른 글 버전 = 지금 글 버전 = 서버가 이 스레드를 판정한 버전일 때만 보낸다(아니면 좌표가 다른 글자를 가리킨다)
    const evaluated = threads.find((t) => t.thread_id === thread)?.anchor.current.evaluated_version_id;
    if (picked.version_id !== result.version_id || (evaluated !== undefined && evaluated !== picked.version_id)) {
      dropStale();
      return;
    }
    // 서버도 basis_version_id 로 다시 확인한다(그사이 본문이 바뀌었으면 409 basis_changed, 아무것도 안 쓴다)
    const input = { version_id: picked.version_id, basis_version_id: picked.version_id, start_cp: picked.start_cp, end_cp: picked.end_cp };
    const r = await reanchorWrite.run(`reanchor|${thread}|${picked.version_id}|${picked.start_cp}|${picked.end_cp}`, (key) => client.reanchorAnnotation(ws.slug, ws.edition, thread, input, key), "새 구간에 다시 붙였어요.");
    if (!r.ok && r.error instanceof PesApiError && r.error.body.error.code === "basis_changed") {
      dropStale();
      return;
    }
    if (r.ok) {
      setReanchoring(null);
      setPicked(null);
      window.getSelection()?.removeAllRanges();
      statusRef.current?.focus();
    }
  };

  return (
    <AnnotationContext.Provider value={ctx}>
      <article ref={articleRef} className="mt-8 selection:bg-primary-soft selection:text-ink" aria-labelledby="result-title">
        <h2 id="result-title" className="text-title text-ink">
          {result.title}
        </h2>
        <p className="mt-0.5 text-caption text-muted-foreground">
          v{result.version} · {result.status === "adopted" ? "채택본" : "초안"} · <time dateTime={result.updated_at}>{formatAt(result.updated_at, false)}</time>
        </p>
        <div className="mt-3 space-y-4">
          {blocks.map((b) => (
            <BlockView key={b.kind === "p" ? `p${b.start_cp}` : `t${b.rows[0]?.[0]?.start_cp ?? 0}`} block={b} marks={marks} />
          ))}
        </div>
      </article>

      {enabled && picked ? (
        <SelectionToolbar
          picked={picked}
          reanchoring={reanchoring !== null}
          toolbarRef={toolbarRef}
          onAnnotate={() => openDialog("annotate")}
          onAsk={() => setNote({ kind: "hint", text: "AI에게 묻기는 아직 열리지 않았어요. 지금은 ‘첨언’이나 ‘할 일로’를 써 주세요." })}
          onTask={() => openDialog("task")}
          onAttach={attach}
        />
      ) : null}

      <AnnotationRegion threads={threads} failed={read.data?.failed === true} loading={read.isPending} note={note} statusRef={statusRef} currentVersionId={result.version_id} body={result.body_md} />

      {dialog === "annotate" && picked ? <AnnotateDialog ctx={ctx} picked={picked} doneRef={doneRef} onDone={finish} onCancel={() => setDialog(null)} /> : null}
      {dialog === "task" && picked ? <TaskDialog ctx={ctx} picked={picked} doneRef={doneRef} onDone={finish} onCancel={() => setDialog(null)} /> : null}
    </AnnotationContext.Provider>
  );
}
