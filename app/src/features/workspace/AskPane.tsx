import * as React from "react";
import { ContextMenu as ContextMenuPrimitive } from "radix-ui";
import { Eye, Import, PenLine } from "lucide-react";
import type { QuestionView, RoundView } from "@/api/types";
import { questionActions, type PesAction } from "@/app/actions";
import { ActionButton } from "@/components/pes/action-button";
import { Button } from "@/components/ui/button";
import { draftKey, readDraft, useDraft, type DraftField, type DraftSetOptions } from "@/lib/draft";
import { formatAt, IMPORTANCE_LABEL, SOURCE_LABEL } from "@/lib/labels";
import { cn } from "@/lib/utils";

const fieldClass =
  "mt-1 block w-full resize-y rounded-md border border-control bg-background px-2.5 py-2 text-body text-ink shadow-xs outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

function Chip({ children, tone = "plain" }: { children: React.ReactNode; tone?: "plain" | "strong" }) {
  return (
    <span
      className={cn(
        "rounded-sm border px-1.5 text-caption",
        tone === "strong" ? "border-primary-line bg-primary-soft font-medium text-primary-ink" : "border-line text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

/** 로그인 없는 이 컴퓨터 화면의 사용자 칸(초안 키) — 로그인이 생기면 사용자 id 로 바뀐다 */
export const DRAFT_USER = "local";

type DraftScope = { project: string; edition: number; form: number };
const keyFor = (scope: DraftScope, question: string, version: number, field: DraftField) =>
  draftKey({ ...scope, user: DRAFT_USER, question, version, field });

/** 이어 붙이기 — 새 칸에 이미 쓴 글이 있으면 그 뒤에 옛 글을 붙인다(덮어쓰지 않음) */
const merge = (now: string, old: string) => (!old ? now : !now ? old : `${now}\n${old}`);

/**
 * 초안 칸 — 같은 DOM 노드를 유지한다(갱신이 와도 다시 만들지 않음 → 초점 · 선택 범위 · 값 그대로).
 * 한글 조합 중(compositionstart ~ end)에는 화면 값만 바꾸고 저장하지 않으며, 조합이 끝나면 확정된 값을 저장한다.
 */
function DraftTextarea({ id, rows, draft }: { id: string; rows: number; draft: [string, (v: string, o?: DraftSetOptions) => void] }) {
  const [value, setValue] = draft;
  const composing = React.useRef(false);
  return (
    <textarea
      id={id}
      rows={rows}
      className={fieldClass}
      value={value}
      onCompositionStart={() => {
        composing.current = true;
      }}
      onCompositionEnd={(e) => {
        composing.current = false;
        setValue(e.currentTarget.value);
      }}
      onChange={(e) => setValue(e.target.value, { store: !composing.current })}
    />
  );
}

type Review = { from: number; answer: string; opinion: string };

/**
 * 새 버전 질문의 옛 초안 검토(U1c · 설계 12.5-6) — 옛 버전 초안을 새 칸으로 몰래 옮기지 않는다.
 * 안내(role=status) · 옛 초안(읽기 전용) · "이전 초안 가져오기"(사람이 눈으로 본 뒤 새 칸에 채움). 옛 키 저장값은 지우지 않는다.
 */
function DraftReview({ qid, version, review, onImport, onDismiss }: { qid: string; version: number; review: Review; onImport: () => void; onDismiss: () => void }) {
  return (
    <div data-draft-review={qid} className="mt-3 rounded-md border border-warn-line bg-warn-soft px-3 py-2.5">
      <p role="status" className="text-meta font-medium text-ink">
        질문이 새 버전(버전 {version})으로 바뀌었어요. 버전 {review.from}에 쓴 초안은 옮기지 않았습니다 — 읽어 보고 필요하면 가져오세요.
      </p>
      <dl className="mt-2 space-y-1.5">
        {review.answer ? (
          <div>
            <dt className="text-caption text-ink-2">이전 답 초안</dt>
            <dd className="ml-0 text-meta whitespace-pre-wrap text-ink">{review.answer}</dd>
          </div>
        ) : null}
        {review.opinion ? (
          <div>
            <dt className="text-caption text-ink-2">이전 의견 초안</dt>
            <dd className="ml-0 text-meta whitespace-pre-wrap text-ink">{review.opinion}</dd>
          </div>
        ) : null}
      </dl>
      <div className="mt-2.5 flex flex-wrap gap-2">
        <Button variant="outline" size="sm" className="bg-background" onClick={onImport}>
          <Import aria-hidden="true" />
          이전 초안 가져오기
        </Button>
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          새로 쓰기
        </Button>
      </div>
    </div>
  );
}

/** 키보드로 맥락 메뉴 열기(ContextMenu 키 · Shift+F10) — 초점 요소 자리에서 contextmenu 를 일으킨다 */
function openContextFromKeyboard(e: React.KeyboardEvent) {
  if (!(e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey))) return;
  if (e.nativeEvent.isComposing) return;
  e.preventDefault();
  const el = e.target as HTMLElement;
  const r = el.getBoundingClientRect();
  el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 12, clientY: r.top + Math.min(r.height, 24) }));
}

/**
 * 질문 동작(맥락 메뉴) — 질문 항목 안에서 오른쪽 단추 · ContextMenu 키 · Shift+F10. 동작은 명령 메뉴와 같은 목록의 부분 집합.
 * Shift 를 누른 오른쪽 단추는 브라우저 메뉴(붙여넣기 · 맞춤법)를 그대로 쓴다. 글 칸의 길게 누르기(터치)는 글 고르기에 양보한다.
 * 닫히면 열기 전 요소로 초점이 돌아가고, 동작을 골랐으면 그 동작이 초점을 맡는다.
 */
function QuestionContextMenu({ q, actions, children }: { q: QuestionView; actions: PesAction[]; children: React.ReactNode }) {
  const chosen = React.useRef<PesAction | null>(null);
  const returnTo = React.useRef<HTMLElement | null>(null);
  return (
    <ContextMenuPrimitive.Root>
      <ContextMenuPrimitive.Trigger asChild>
        {/* 키보드 처리는 ContextMenu 키 · Shift+F10 을 맥락 메뉴로 넘기는 것뿐 — 안의 칸 · 단추가 실제 조작 대상이다 */}
        {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
        <div
          role="group"
          aria-labelledby={`${q.id}-head`}
          onKeyDown={openContextFromKeyboard}
          onContextMenuCapture={(e) => {
            if (e.shiftKey) return void e.stopPropagation(); // 브라우저 메뉴
            returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          }}
        >
          {children}
        </div>
      </ContextMenuPrimitive.Trigger>
      <ContextMenuPrimitive.Portal>
        <ContextMenuPrimitive.Content
          aria-label="질문 동작"
          className="z-50 min-w-52 rounded-md border bg-popover p-1 text-popover-foreground shadow-[0_8px_24px_-8px_rgb(0_0_0/0.25)] data-open:animate-in data-open:fade-in-0 data-open:zoom-in-[0.98]"
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            const a = chosen.current;
            chosen.current = null;
            if (a) a.run();
            else returnTo.current?.focus();
          }}
        >
          {actions.map((a) => (
            <ContextMenuPrimitive.Item
              key={a.id}
              aria-keyshortcuts={a.keys}
              onSelect={() => {
                chosen.current = a;
              }}
              className="flex min-h-8 cursor-default items-center rounded-sm px-2 text-meta text-ink outline-none select-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
            >
              {a.label}
            </ContextMenuPrimitive.Item>
          ))}
        </ContextMenuPrimitive.Content>
      </ContextMenuPrimitive.Portal>
    </ContextMenuPrimitive.Root>
  );
}

function findReview(scope: DraftScope, q: QuestionView): Review | null {
  if (q.sent) return null;
  if (readDraft(keyFor(scope, q.id, q.version, "answer")) || readDraft(keyFor(scope, q.id, q.version, "opinion"))) return null;
  for (let v = q.version - 1; v >= 1; v--) {
    const answer = readDraft(keyFor(scope, q.id, v, "answer"));
    const opinion = readDraft(keyFor(scope, q.id, v, "opinion"));
    if (answer || opinion) return { from: v, answer, opinion };
  }
  return null;
}

function QuestionItem({ q, scope, actions, open, onPeek }: { q: QuestionView; scope: DraftScope; actions: PesAction[]; open: boolean; onPeek: (id: string) => void }) {
  const answer = useDraft(keyFor(scope, q.id, q.version, "answer"));
  const opinion = useDraft(keyFor(scope, q.id, q.version, "opinion"));
  // 새 버전이 되었거나 처음 그릴 때(그 그림에서 바로): 앞 버전 초안이 있고 새 칸이 비었으면 검토 영역을 연다
  const reviewFor = `${keyFor(scope, q.id, q.version, "answer")}|${q.sent ? "sent" : ""}`;
  const [rv, setRv] = React.useState(() => ({ for: reviewFor, review: findReview(scope, q) }));
  const current = rv.for === reviewFor ? rv : { for: reviewFor, review: findReview(scope, q) };
  if (current !== rv) setRv(current);
  const review = current.review;
  const setReview = (r: Review | null) => setRv({ for: reviewFor, review: r });

  const closeReview = (bring: boolean) => {
    if (bring && review) {
      answer[1](merge(answer[0], review.answer));
      opinion[1](merge(opinion[0], review.opinion));
    }
    setReview(null);
    document.getElementById(q.id)?.focus();
  };

  const head = `질문 ${q.number}`;
  return (
    <li className="border-t py-4 first:border-t-0 first:pt-1">
      <QuestionContextMenu q={q} actions={questionActions(actions, q.id)}>
        <div>
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 id={`${q.id}-head`} className="text-meta font-semibold text-ink">
              {head}
            </h3>
            {q.required ? <Chip tone="strong">필수</Chip> : null}
            <Chip>중요도 {IMPORTANCE_LABEL[q.importance]}</Chip>
            <span className="text-caption text-muted-foreground">{SOURCE_LABEL[q.source]}</span>
            <Button
              id={`peek-${q.id}`}
              variant="ghost"
              size="xs"
              className="ml-auto"
              aria-label={`${head} 미리보기`}
              aria-haspopup="dialog"
              aria-expanded={open}
              onClick={() => onPeek(q.id)}
            >
              <Eye aria-hidden="true" />
              미리보기
            </Button>
          </div>
          <p className="mt-1.5 text-body text-ink">{q.text}</p>
          {q.help ? <p className="mt-1 text-meta text-muted-foreground">{q.help}</p> : null}
          {q.sent ? (
            <div className="mt-3 rounded-md bg-surface-sunk px-3 py-2">
              <p className="text-body text-ink">{q.sent.answer}</p>
              <p className="mt-1 text-caption text-muted-foreground">
                보냄 · <time dateTime={q.sent.committed_at}>{formatAt(q.sent.committed_at)}</time> · 접수 {q.sent.receipt_no}
              </p>
            </div>
          ) : (
            <>
              {review ? <DraftReview qid={q.id} version={q.version} review={review} onImport={() => closeReview(true)} onDismiss={() => closeReview(false)} /> : null}
              {/* 글 칸의 길게 누르기(터치)는 글 고르기 — 맥락 메뉴가 가로채지 않게 */}
              <div className="mt-3 space-y-3" onPointerDown={(e) => e.pointerType !== "mouse" && e.stopPropagation()}>
                <div>
                  <label className="block text-meta font-medium text-ink" htmlFor={q.id}>
                    <span className="sr-only">{head} </span>답{q.required ? " (필수)" : ""}
                  </label>
                  <DraftTextarea id={q.id} rows={3} draft={answer} />
                </div>
                <div>
                  <label className="block text-meta font-medium text-ink" htmlFor={`${q.id}-opinion`}>
                    <span className="sr-only">{head} </span>의견 <span className="font-normal text-muted-foreground">(선택)</span>
                  </label>
                  <DraftTextarea id={`${q.id}-opinion`} rows={2} draft={opinion} />
                </div>
              </div>
            </>
          )}
        </div>
      </QuestionContextMenu>
    </li>
  );
}

/**
 * 질문 영역(설계 4.7 질문·답 · 4.16). 휴대폰에서도 답 · 의견은 켜져 있고, 질문 고치기는 데스크톱으로 안내한다.
 * 지난 라운드는 읽기 전용 — 보낸 답만 보인다.
 */
export function AskPane({
  round,
  project,
  edition,
  actions,
  editBlocked,
  peekId,
  onPeek,
}: {
  round: RoundView;
  project: string;
  edition: number;
  /** 동작 목록 하나(명령 메뉴와 같은 것) — 질문 맥락 메뉴가 부분 집합을 쓴다 */
  actions: PesAction[];
  editBlocked?: string;
  peekId: string | null;
  onPeek: (id: string) => void;
}) {
  const [editNote, setEditNote] = React.useState(false);
  const past = round.state !== "current";
  const total = round.questions.length;
  const open = round.questions.filter((q) => !q.sent);
  const requiredLeft = open.filter((q) => q.required).length;
  const scope = React.useMemo(() => ({ project, edition, form: round.form_version }), [project, edition, round.form_version]);
  return (
    <div className="px-4 pt-5 pb-16">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id="ask-title" tabIndex={-1} className="text-title text-ink outline-none">
            질문
          </h2>
          <p className="text-caption text-muted-foreground">
            {past ? `보낸 답 ${total - open.length}개 · 읽기 전용` : `답할 질문 ${open.length} / 전체 ${total} · 필수 남음 ${requiredLeft}`}
          </p>
        </div>
        <ActionButton
          variant="outline"
          size="sm"
          blockedReason={editBlocked}
          reasonId="edit-reason"
          reasonClassName="max-w-48"
          aria-expanded={editBlocked ? undefined : editNote}
          aria-controls={!editBlocked && editNote ? "edit-note" : undefined}
          onClick={() => setEditNote((v) => !v)}
        >
          <PenLine aria-hidden="true" />
          질문 고치기
        </ActionButton>
      </div>
      {!editBlocked && editNote ? (
        <p id="edit-note" className="mt-3 rounded-md border bg-surface-soft px-3 py-2 text-meta text-ink-2">
          질문 문구 고치기 · 더하기 · 빼기는 다음 작업(U2)에서 연결됩니다. 지금은 합성 자료라 바꾸지 않습니다.
        </p>
      ) : null}
      <ol className="mt-4">
        {round.questions.map((q) => (
          <QuestionItem key={q.id} q={q} scope={scope} actions={actions} open={peekId === q.id} onPeek={onPeek} />
        ))}
      </ol>
      {!past ? (
        <div className="mt-2 space-y-3 border-t pt-4">
          <p className="text-caption text-muted-foreground">초안은 이 탭에만 있어요. 탭을 닫거나 다른 기기로 옮기면 남지 않습니다.</p>
          <ActionButton variant="default" blockedReason="합성 자료 화면이라 답을 보내지 않습니다 — 서버 연결 뒤에 열립니다." reasonId="send-reason">
            답 검토 후 보내기
          </ActionButton>
        </div>
      ) : null}
    </div>
  );
}
