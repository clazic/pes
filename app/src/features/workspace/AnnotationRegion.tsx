import * as React from "react";
import { Link } from "react-router";
import { ChevronDown } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useClient } from "@/api/queries";
import type { AnnotationThreadView, FollowupDetail, FollowupKind, StageKey } from "@/api/types";
import { ActionButton } from "@/components/pes/action-button";
import { Status } from "@/components/pes/status";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { sliceCp } from "@/lib/anchor-text";
import { FOLLOWUP_KIND_LABEL, STAGE_LABEL, formatAt } from "@/lib/labels";
import { ErrorLine, Quote, StatusLine, shortId, useAnnotationCtx, useAnnotationWrite, type Note } from "./annotation-kit";
import { controlClass, Field } from "./fields";

const MENU_ORDER: FollowupKind[] = ["edit_text", "next_round_task", "reopen_stage", "none"];

const STAGE_ORDER = Object.keys(STAGE_LABEL) as StageKey[];
/** 앞 단계 다시 열기로 고를 수 있는 단계 — 지금 단계보다 앞선 것만(가까운 앞 단계가 먼저) */
const earlierStages = (stage: StageKey): StageKey[] => STAGE_ORDER.slice(0, STAGE_ORDER.indexOf(stage)).reverse();

const itemClass =
  "flex min-h-8 cursor-pointer items-center rounded-md px-2 py-1 text-meta outline-none select-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground";

/* ───────────── 해결 대화 상자 ───────────── */

function ResolveDialog({ thread, kind, triggerRef, onClose }: { thread: AnnotationThreadView; kind: FollowupKind; triggerRef: React.RefObject<HTMLButtonElement | null>; onClose: () => void }) {
  const ctx = useAnnotationCtx();
  const client = useClient();
  const write = useAnnotationWrite(ctx);
  const [reason, setReason] = React.useState("");
  const [tried, setTried] = React.useState(false);
  const earlier = earlierStages(ctx.stage);
  const [reopenStage, setReopenStage] = React.useState<StageKey | undefined>(earlier[0]);
  const box = React.useRef<HTMLTextAreaElement>(null);
  const done = React.useRef(false);
  const empty = reason.trim() === "";
  // 서버는 후속의 단계(다음 라운드 할 일 · 앞 단계 다시 열기)와 글 수정의 기반 버전을 요구한다: 할 일은 지금 단계, 다시 열기는 고른 앞 단계, 글 수정은 지금 보는 글 버전
  const stage: StageKey | undefined = kind === "next_round_task" ? ctx.stage : kind === "reopen_stage" ? reopenStage : undefined;
  const noStage = (kind === "next_round_task" || kind === "reopen_stage") && !stage;
  const invalid = tried && empty;
  const confirm = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    if (write.pending || noStage) return;
    if (empty) {
      setTried(true);
      return;
    }
    const text = reason.trim();
    const r = await write.run(
      `resolve|${thread.thread_id}|${kind}|${stage ?? ""}|${text}`,
      (key) =>
        client.resolveAnnotation(
          ctx.slug,
          ctx.edition,
          thread.thread_id,
          { resolution: kind, reason: text, ...(stage ? { target_stage: stage } : {}), ...(kind === "edit_text" ? { base_version_id: ctx.versionId } : {}) },
          key,
        ),
      "첨언을 해결로 기록했어요.",
    );
    if (r.ok) {
      done.current = true;
      onClose();
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          box.current?.focus();
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          if (done.current) ctx.focusStatus();
          else triggerRef.current?.focus();
        }}
      >
        <form onSubmit={confirm} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>첨언 해결</DialogTitle>
            <DialogDescription>해결 방식: {FOLLOWUP_KIND_LABEL[kind]}. 해결은 이 첨언을 닫는 기록이에요. 글은 이것만으로 바뀌지 않아요.</DialogDescription>
          </DialogHeader>
          <Quote>{thread.anchor.exact_quote}</Quote>
          {kind === "edit_text" ? <p className="text-meta text-ink-2">해결하면 글 수정 후속이 ‘제안’으로 남아요. 제안 글은 아직 쓰지 않아서, 제안 글이 생기기 전에는 채택할 수 없어요.</p> : null}
          {kind === "next_round_task" ? <p className="text-meta text-ink-2">해결하면 다음 라운드 할 일이 ‘제안’으로 남아요. 대상 단계: {STAGE_LABEL[ctx.stage]}.</p> : null}
          {kind === "reopen_stage" ? (
            <Field id={`${thread.thread_id}-resolve-stage`} label="다시 열 단계">
              <select id={`${thread.thread_id}-resolve-stage`} value={reopenStage ?? ""} onChange={(e) => setReopenStage(e.target.value as StageKey)} className={controlClass}>
                {earlier.map((k) => (
                  <option key={k} value={k}>
                    {STAGE_LABEL[k]}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
          <Field id={`${thread.thread_id}-resolve-reason`} label="해결 이유">
            <textarea
              ref={box}
              id={`${thread.thread_id}-resolve-reason`}
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              aria-invalid={invalid ? true : undefined}
              aria-describedby={invalid ? `${thread.thread_id}-resolve-hint` : undefined}
              className={controlClass}
            />
            {invalid ? (
              <p id={`${thread.thread_id}-resolve-hint`} className="mt-1 text-caption text-bad">
                해결 이유를 적어 주세요.
              </p>
            ) : null}
          </Field>
          {write.alert ? <ErrorLine>{write.alert}</ErrorLine> : null}
          <DialogFooter>
            <Button onClick={onClose}>취소</Button>
            <Button type="submit" variant="default" aria-disabled={write.pending ? "true" : undefined}>
              해결 기록
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ───────────── 후속 · 글 수정 채택 ───────────── */

function AdoptDialog({ f, currentVersionId, triggerRef, onClose }: { f: FollowupDetail; currentVersionId: string; triggerRef: React.RefObject<HTMLButtonElement | null>; onClose: () => void }) {
  const ctx = useAnnotationCtx();
  const client = useClient();
  const write = useAnnotationWrite(ctx);
  const done = React.useRef(false);
  // 열어 둔 사이 글이 바뀌면(다시 읽은 뒤) 같은 낡은 제안을 또 보내지 않는다
  const stale = f.base_version_id === null || f.base_version_id !== currentVersionId;
  const confirm = async () => {
    if (write.pending || stale || f.base_version_id === null) return;
    const base = f.base_version_id;
    const r = await write.run(`apply|${f.id}|${f.version_no}|${base}`, (key) => client.applyFollowup(ctx.slug, ctx.edition, f.id, { base_version_id: base, expected_rev: f.version_no }, key), "새 버전으로 채택했어요.");
    if (r.ok) {
      done.current = true;
      onClose();
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        onCloseAutoFocus={(e) => {
          if (done.current) {
            e.preventDefault();
            ctx.focusStatus();
          } else if (triggerRef.current) {
            e.preventDefault();
            triggerRef.current.focus();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>글 수정 채택</DialogTitle>
          <DialogDescription>이 제안은 지금 결과 글과 같은 버전(기반)을 바탕으로 했어요. 채택하면 제안 글이 새 버전이 되고, 이전 버전은 기록으로 남아요.</DialogDescription>
        </DialogHeader>
        <p className="text-meta text-ink">{f.description}</p>
        {stale ? <p className="text-meta text-warn">결과 글이 바뀌어 기반이 달라졌어요. 취소하고 새 버전을 확인해 주세요.</p> : null}
        {write.alert ? <ErrorLine>{write.alert}</ErrorLine> : null}
        <DialogFooter>
          <Button onClick={onClose}>취소</Button>
          <Button variant="default" aria-disabled={write.pending || stale ? "true" : undefined} onClick={confirm}>
            새 버전으로 채택
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FollowupCard({ f, currentVersionId }: { f: FollowupDetail; currentVersionId: string }) {
  const ctx = useAnnotationCtx();
  const [adopting, setAdopting] = React.useState(false);
  const adoptRef = React.useRef<HTMLButtonElement>(null);
  const canAdopt = f.kind === "edit_text" && (f.state === "proposed" || f.state === "accepted");
  const reason = ctx.readOnly
    ? ctx.readOnly
    : f.proposed_body_md === null
      ? "제안 글이 없어 채택할 수 없어요."
      : f.base_version_id === null
        ? "제안이 기반한 글 버전을 알 수 없어 채택할 수 없어요."
        : f.base_version_id !== currentVersionId
          ? "이 제안은 이전 글 버전을 기반으로 했어요. 그사이 결과 글이 바뀌어(새 버전) 그대로는 채택할 수 없어요."
          : undefined;
  return (
    <section data-followup={f.id} data-state={f.state} aria-label={`후속 제안 · ${FOLLOWUP_KIND_LABEL[f.kind]}`} className="grid gap-2 rounded-md bg-surface-soft px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-meta font-semibold text-ink">{FOLLOWUP_KIND_LABEL[f.kind]}</span>
        <Status of="followup" value={f.state} />
      </div>
      <p className="text-meta break-words whitespace-pre-wrap text-ink">{f.description}</p>
      {f.kind === "edit_text" && f.proposed_body_md !== null ? (
        // 넘치는 글을 키보드로 스크롤할 수 있어야 해서 초점을 받는다(이름 있는 영역)
        // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        <div role="region" aria-label="제안 글 전체" tabIndex={0} className="max-h-56 overflow-auto rounded-md border bg-background px-3 py-2 text-meta break-words whitespace-pre-wrap text-ink outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
          {f.proposed_body_md}
        </div>
      ) : null}
      {f.state === "applied" && f.result_version_id ? (
        <p className="text-caption text-ink-2">
          결과 버전{" "}
          <Link to={`/p/${encodeURIComponent(ctx.slug)}/e/${ctx.edition}/records#version-${encodeURIComponent(f.result_version_id)}`} className="text-primary-ink underline underline-offset-2">
            {shortId(f.result_version_id)}
          </Link>
        </p>
      ) : null}
      {canAdopt ? (
        <div>
          <ActionButton ref={adoptRef} variant="default" size="sm" blockedReason={reason} reasonId={`${f.id}-adopt-reason`} reasonClassName="max-w-prose" onClick={() => setAdopting(true)}>
            채택
          </ActionButton>
        </div>
      ) : null}
      {adopting ? <AdoptDialog f={f} currentVersionId={currentVersionId} triggerRef={adoptRef} onClose={() => setAdopting(false)} /> : null}
    </section>
  );
}

/* ───────────── 스레드 ───────────── */

/** 후보 한 줄의 앞뒤 글(본문에서) — 같은 인용문이 여럿이어도 자리를 가려 읽히게 */
function candidateContext(body: string, c: { start_cp: number; end_cp: number }): { before: string; quote: string; after: string } | null {
  try {
    const flat = (s: string) => s.replace(/\s+/g, " ");
    return { before: flat(sliceCp(body, Math.max(0, c.start_cp - 10), c.start_cp)), quote: flat(sliceCp(body, c.start_cp, c.end_cp)), after: flat(sliceCp(body, c.end_cp, c.end_cp + 10)) };
  } catch {
    return null;
  }
}

function Candidates({ t, body }: { t: AnnotationThreadView; body: string }) {
  const ctx = useAnnotationCtx();
  const client = useClient();
  const write = useAnnotationWrite(ctx);
  const [picked, setPicked] = React.useState<number | null>(null);
  const cands = t.anchor.current.candidates;
  const reason = ctx.readOnly ?? (picked === null ? "붙일 후보를 먼저 고르세요." : undefined);
  const attach = async () => {
    if (picked === null || write.pending) return;
    const c = cands[picked];
    if (!c) return;
    await write.run(`pick|${t.thread_id}|${c.start_cp}|${c.end_cp}`, (key) => client.reanchorAnnotation(ctx.slug, ctx.edition, t.thread_id, { version_id: ctx.versionId, start_cp: c.start_cp, end_cp: c.end_cp }, key), "후보 구간에 다시 붙였어요.");
  };
  return (
    <div className="grid gap-2">
      <p className="text-caption text-ink-2">인용문이 글에 여러 곳 있어요. 어디에 붙일지 직접 골라 주세요 — 자동으로 고르지 않아요.</p>
      <div role="radiogroup" aria-label="후보" className="grid gap-1.5">
        {cands.map((c, i) => {
          const ctxText = candidateContext(body, c);
          return (
            <label key={`${c.start_cp}-${c.end_cp}`} data-candidate="" data-start-cp={c.start_cp} className="flex min-h-8 cursor-pointer items-start gap-2 rounded-md px-2 py-1 text-meta text-ink hover:bg-surface-soft">
              <input type="radio" name={`${t.thread_id}-candidate`} checked={picked === i} onChange={() => setPicked(i)} className="mt-1 size-4 shrink-0 accent-[var(--primary)]" />
              <span className="min-w-0 break-words">
                <span className="font-medium">후보 {i + 1}</span>
                {ctxText ? (
                  <>
                    {" · "}
                    <span className="text-ink-2">…{ctxText.before}</span>
                    <strong className="font-semibold">{ctxText.quote}</strong>
                    <span className="text-ink-2">{ctxText.after}…</span>
                  </>
                ) : null}
              </span>
            </label>
          );
        })}
      </div>
      <div>
        <ActionButton size="sm" variant="default" blockedReason={reason} reasonId={`${t.thread_id}-attach-reason`} onClick={attach}>
          이 후보로 붙이기
        </ActionButton>
      </div>
      {write.alert ? <ErrorLine>{write.alert}</ErrorLine> : null}
    </div>
  );
}

function Lost({ t }: { t: AnnotationThreadView }) {
  const ctx = useAnnotationCtx();
  const active = ctx.reanchoring === t.thread_id;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <p className="text-caption text-ink-2">글에서 이 인용문을 찾지 못했어요. 인용문과 메시지는 남아 있고, 새 구간은 직접 골라 붙여요.</p>
      {active ? (
        <Button size="sm" onClick={ctx.cancelReanchor}>
          그만두기
        </Button>
      ) : (
        <ActionButton size="sm" blockedReason={ctx.readOnly} reasonId={`${t.thread_id}-reanchor-reason`} onClick={() => ctx.startReanchor(t.thread_id)}>
          다시 붙이기
        </ActionButton>
      )}
    </div>
  );
}

function ThreadCard({ t, index, currentVersionId, body }: { t: AnnotationThreadView; index: number; currentVersionId: string; body: string }) {
  const ctx = useAnnotationCtx();
  const client = useClient();
  const status = t.anchor.current.status;
  const resolved = t.state === "resolved";
  const open = t.state === "open";
  const [replying, setReplying] = React.useState(false);
  const [reply, setReply] = React.useState("");
  const [tried, setTried] = React.useState(false);
  const [resolving, setResolving] = React.useState<FollowupKind | null>(null);
  const replyWrite = useAnnotationWrite(ctx);
  const replyBtn = React.useRef<HTMLButtonElement>(null);
  const resolveBtn = React.useRef<HTMLButtonElement>(null);
  const emptyReply = reply.trim() === "";

  const send = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    if (replyWrite.pending) return;
    if (emptyReply) {
      setTried(true);
      return;
    }
    const body_md = reply.trim();
    const r = await replyWrite.run(`reply|${t.thread_id}|${body_md}`, (key) => client.replyAnnotation(ctx.slug, ctx.edition, t.thread_id, { body_md }, key), "답글을 남겼어요.");
    if (r.ok) {
      setReply("");
      setTried(false);
      setReplying(false);
      replyBtn.current?.focus();
    }
  };

  const pendingFollowup = resolved && t.followups.some((f) => f.state === "proposed" || f.state === "accepted" || f.state === "running" || f.state === "deferred");
  const replyReason = resolved ? "해결된 첨언에는 답글을 달 수 없어요. 새 첨언을 남겨 주세요." : t.state === "archived" ? "보관된 첨언에는 답글을 달 수 없어요." : ctx.readOnly;
  const invalidReply = tried && emptyReply;

  return (
    <li id={`annotation-${t.thread_id}`} data-thread={t.thread_id} data-anchor-status={status} data-state={t.state} tabIndex={-1} className="grid gap-3 py-5 first:pt-0 outline-none">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <h3 className="text-meta font-semibold text-ink">첨언 {index}</h3>
        <Status of="anchor" value={status} />
        {resolved ? <Status of="thread" value="resolved" /> : null}
        {t.state === "archived" ? <Status of="thread" value="archived" /> : null}
      </div>

      <Quote>{t.anchor.exact_quote}</Quote>

      <ul className="grid gap-2">
        {t.messages.map((m) => (
          <li key={m.message_id} data-message={m.message_id} className="grid gap-0.5">
            <p className="text-body break-words whitespace-pre-wrap text-ink">{m.body_md}</p>
            <p className="text-caption text-muted-foreground">
              {m.by === "human" ? "사람 · " : m.by === "ai" ? "AI · " : ""}
              <time dateTime={m.at}>{formatAt(m.at)}</time>
            </p>
          </li>
        ))}
      </ul>

      {resolved && t.resolution ? (
        <p className="text-meta text-ink-2">
          해결 방식: {FOLLOWUP_KIND_LABEL[t.resolution.resolution]} · 이유: {t.resolution.reason}
          {pendingFollowup ? " · 후속 제안은 아직 글에 반영 전이에요." : ""}
        </p>
      ) : null}

      {t.followups.map((f) => (
        <FollowupCard key={f.id} f={f} currentVersionId={currentVersionId} />
      ))}

      {open && status === "ambiguous" ? <Candidates t={t} body={body} /> : null}
      {open && status === "lost" ? <Lost t={t} /> : null}

      <div className="flex flex-wrap items-start gap-2">
        <ActionButton
          ref={replyBtn}
          size="sm"
          blockedReason={replyReason}
          reasonId={`${t.thread_id}-reply-reason`}
          reasonClassName="max-w-prose"
          aria-expanded={replyReason ? undefined : replying}
          onClick={() => setReplying((v) => !v)}
        >
          답글
        </ActionButton>
        {open ? (
          ctx.readOnly ? (
            <ActionButton size="sm" blockedReason={ctx.readOnly} reasonId={`${t.thread_id}-resolve-reason-blocked`}>
              해결
            </ActionButton>
          ) : (
            <DropdownMenu.Root modal={false}>
              <DropdownMenu.Trigger asChild>
                <Button ref={resolveBtn} size="sm">
                  해결
                  <ChevronDown aria-hidden="true" />
                </Button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content align="start" sideOffset={6} className="z-50 min-w-48 rounded-lg border bg-popover p-1 text-popover-foreground shadow-md">
                  {MENU_ORDER.filter((k) => k !== "reopen_stage" || earlierStages(ctx.stage).length > 0).map((k) => (
                    <DropdownMenu.Item key={k} className={itemClass} onSelect={() => setResolving(k)}>
                      {FOLLOWUP_KIND_LABEL[k]}
                    </DropdownMenu.Item>
                  ))}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          )
        ) : null}
      </div>

      {replying && !replyReason ? (
        <form onSubmit={send} className="grid gap-2">
          <Field id={`${t.thread_id}-reply`} label="답글">
            <textarea
              id={`${t.thread_id}-reply`}
              rows={3}
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              aria-invalid={invalidReply ? true : undefined}
              aria-describedby={invalidReply ? `${t.thread_id}-reply-hint` : undefined}
              className={controlClass}
            />
            {invalidReply ? (
              <p id={`${t.thread_id}-reply-hint`} className="mt-1 text-caption text-bad">
                답글을 적어 주세요.
              </p>
            ) : null}
          </Field>
          {replyWrite.alert ? <ErrorLine>{replyWrite.alert}</ErrorLine> : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" variant="default" aria-disabled={replyWrite.pending ? "true" : undefined}>
              답글 보내기
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setReplying(false)}>
              닫기
            </Button>
          </div>
        </form>
      ) : null}

      {resolving ? <ResolveDialog thread={t} kind={resolving} triggerRef={resolveBtn} onClose={() => setResolving(null)} /> : null}
    </li>
  );
}

/**
 * 첨언 목록(이름 있는 영역 “첨언”) — 스레드마다 앵커 상태 낱말(색만으로 알리지 않는다) · 인용문(어떤 상태에서도 보인다) · 메시지 · 후속.
 * 해결됨 ≠ 반영: 반영은 후속이 적용될 때만 “적용”이다. 모든 쓰기의 영수증 · “접수 확인 중” · 안내는 이 영역의 상태 줄(role=status)에 모인다.
 */
export function AnnotationRegion({ threads, failed, loading, note, statusRef, currentVersionId, body }: { threads: AnnotationThreadView[]; failed: boolean; loading: boolean; note: Note; statusRef: React.RefObject<HTMLParagraphElement | null>; currentVersionId: string; body: string }) {
  const openCount = threads.filter((t) => t.state === "open").length;
  const resolvedCount = threads.filter((t) => t.state === "resolved").length;
  return (
    <section aria-label="첨언" className="mt-10 border-t pt-6">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-title text-ink">첨언</h2>
        {threads.length > 0 ? (
          <p className="text-caption text-muted-foreground">
            열림 {openCount}건 · 해결됨 {resolvedCount}건
          </p>
        ) : null}
      </div>
      <div className="mt-2">
        <StatusLine ref={statusRef} note={note} />
      </div>
      {failed ? <ErrorLine>첨언 목록을 읽지 못했어요. 잠시 뒤 글을 다시 열어 주세요.</ErrorLine> : null}
      {threads.length === 0 && !failed ? (
        <p className="mt-3 text-meta text-ink-2">{loading ? "아직 첨언이 없는지 읽는 중이에요." : "아직 첨언이 없어요. 글에서 구간을 고르고 ‘첨언’을 눌러 남겨 보세요."}</p>
      ) : (
        <ol className="mt-4 divide-y">
          {threads.map((t, i) => (
            <ThreadCard key={t.thread_id} t={t} index={i + 1} currentVersionId={currentVersionId} body={body} />
          ))}
        </ol>
      )}
    </section>
  );
}
