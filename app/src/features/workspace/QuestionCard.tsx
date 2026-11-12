import * as React from "react";
import { ContextMenu as ContextMenuPrimitive } from "radix-ui";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Eye, History, Import, PenLine, Settings2 } from "lucide-react";
import { useClient } from "@/api/queries";
import type { CommandResult, QuestionRevision, QuestionView } from "@/api/types";
import { type PesAction, questionActions } from "@/app/actions";
import { Status } from "@/components/pes/status";
import { Button } from "@/components/ui/button";
import { draftKey, originForm, readDraft, useDraft, type DraftField, type DraftSetOptions } from "@/lib/draft";
import { DIRECTION_CHIP, formatAt, importanceLabel, KIND_LABEL, SOURCE_LABEL } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { QuestionEditor } from "./QuestionEditor";
import { directionOf, isChoice, kindOf, optionLabel, showIfLine, statusOf } from "./question-model";
import type { TidyKind } from "./QuestionDialogs";

const fieldClass =
  "mt-1 block w-full resize-y rounded-md border border-control bg-background px-2.5 py-2 text-body text-ink shadow-xs outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/** 카드 표식 하나 — 서로 다른 뜻은 서로 다른 칩(중요도 ≠ 필수). tone: strong = 필수, quiet = 테두리 없는 보조 표시 */
function Chip({ chip, tone = "plain", children }: { chip: string; tone?: "plain" | "strong" | "quiet"; children: React.ReactNode }) {
  return (
    <span
      data-chip={chip}
      className={cn(
        "text-caption",
        tone === "quiet" ? "text-muted-foreground" : "rounded-sm border px-1.5",
        tone === "strong" && "border-primary-line bg-primary-soft font-medium text-primary-ink",
        tone === "plain" && "border-line text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

/** 로그인 없는 이 컴퓨터 화면의 사용자 칸(초안 키) — 로그인이 생기면 사용자 id 로 바뀐다 */
export const DRAFT_USER = "local";

export type DraftScope = { project: string; edition: number; form: number };
/** 초안 키 — 폼 버전 칸은 그 질문 버전이 이 탭에 처음 보인 때의 것(폼이 올라가도 질문 버전이 같으면 같은 키) */
const keyFor = (scope: DraftScope, question: string, version: number, field: DraftField, write = true) =>
  draftKey({ project: scope.project, user: DRAFT_USER, edition: scope.edition, form: originForm({ project: scope.project, user: DRAFT_USER, edition: scope.edition, question, version }, scope.form, write), question, version, field });

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
    const answer = readDraft(keyFor(scope, q.id, v, "answer", false));
    const opinion = readDraft(keyFor(scope, q.id, v, "opinion", false));
    if (answer || opinion) return { from: v, answer, opinion };
  }
  return null;
}

/** 값 구분 한 줄 — 기본값 · AI 추천은 표시일 뿐 답이 아니다(서로 다른 노드, 서로 다른 말) */
function ValueLine({ kind, label, children }: { kind: "default" | "recommendation"; label: string; children: React.ReactNode }) {
  return (
    <div data-field-kind={kind} className="flex flex-wrap gap-x-2 text-meta">
      <dt className="font-medium text-ink-2">{label}</dt>
      <dd className="ml-0 min-w-0 text-ink">{children}</dd>
    </div>
  );
}

/** 선택지 답 칸 — 하나 고르기(라디오) · 여러 개 고르기(체크). 기본값 · 추천을 미리 고르지 않는다. 초안은 선택지 id 를 글로 저장 */
function ChoiceAnswer({ q, draft, head }: { q: QuestionView; draft: [string, (v: string, o?: DraftSetOptions) => void]; head: string }) {
  const [value, setValue] = draft;
  const multi = kindOf(q) === "multi_choice";
  const picked = value ? value.split("\n") : [];
  return (
    <fieldset id={q.id} tabIndex={-1} className="min-w-0 rounded-md outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
      <legend className="text-meta font-medium text-ink">
        <span className="sr-only">{head} </span>답{q.required ? " (필수)" : ""}
        {multi ? <span className="font-normal text-muted-foreground"> · 여러 개 고를 수 있어요</span> : null}
      </legend>
      <div className="mt-1 grid gap-1">
        {(q.options ?? []).map((o) => {
          const checked = picked.includes(o.id);
          return (
            <label key={o.id} className="flex min-h-8 cursor-pointer items-center gap-2.5 rounded-md px-1 text-body text-ink has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ring coarse:min-h-[44px]">
              <input
                type={multi ? "checkbox" : "radio"}
                name={`${q.id}-answer`}
                className="size-4 shrink-0 accent-primary"
                checked={checked}
                onChange={() => setValue(multi ? (checked ? picked.filter((p) => p !== o.id) : [...picked, o.id]).join("\n") : o.id)}
              />
              {o.label}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

export interface CardTools {
  /** 못 쓰는 이유(휴대폰 · 서버 미연결). 있으면 도구는 aria-disabled + 이 이유 글(edit-reason)을 가리킨다 */
  blocked?: string;
  first: boolean;
  last: boolean;
}

export interface CardProps {
  q: QuestionView;
  all: QuestionView[];
  /** 자기 자신을 뺀 열린 질문 */
  others: QuestionView[];
  scope: DraftScope;
  actions: PesAction[];
  open: boolean;
  onPeek: (id: string) => void;
  /** null = 도구 없음(지난 라운드) */
  tools: CardTools | null;
  editing: boolean;
  onEditing: (open: boolean) => void;
  save: (id: string, body: QuestionRevision, key: string) => Promise<CommandResult<{ question_id: string; version: number; needs_recheck: boolean }>>;
  onSaved: (q: QuestionView, r: CommandResult<{ question_id: string; version: number; needs_recheck: boolean }>) => void;
  onMove: (id: string, dir: "up" | "down") => void;
  onTidy: (id: string, kind: TidyKind) => void;
}

/** 도구 단추 하나 — 못 쓰면 숨기지 않고 aria-disabled(초점은 받고, 눌러도 그대로) + 이유 글 */
function ToolButton({ blocked, edge, onClick, children, ...rest }: Omit<React.ComponentProps<typeof Button>, "onClick"> & { blocked?: string; edge?: boolean; onClick: () => void }) {
  const off = !!blocked || !!edge;
  return (
    <Button
      variant="ghost"
      {...rest}
      aria-disabled={off || undefined}
      aria-describedby={blocked ? "edit-reason" : undefined}
      onClick={(e) => {
        if (off) return void e.preventDefault();
        onClick();
      }}
    >
      {children}
    </Button>
  );
}

function VersionHistory({ q, project, edition }: { q: QuestionView; project: string; edition: number }) {
  const client = useClient();
  const h = useQuery({ queryKey: ["question-versions", project, edition, q.id, q.version], queryFn: () => client.getQuestionVersions(project, edition, q.id) });
  return (
    <div className="mt-3 rounded-md bg-surface-sunk px-3 py-2.5">
      {h.isPending ? (
        <p className="text-meta text-muted-foreground">불러오는 중</p>
      ) : h.isError ? (
        <p role="alert" className="text-meta text-bad">
          버전 기록을 읽지 못했어요.
        </p>
      ) : !h.data ? (
        <p className="text-meta text-muted-foreground">버전 기록을 찾지 못했어요.</p>
      ) : (
        <ol aria-label={`질문 ${q.number} 버전 기록`} className="space-y-2.5">
          {h.data.map((v) => (
            <li key={v.version} className="text-meta text-ink">
              <p className="font-medium">
                버전 {v.version} <span className="font-normal text-muted-foreground">· {KIND_LABEL[v.kind]} · {v.required ? "필수" : "선택"} · 중요도 {importanceLabel(v.importance)} · <time dateTime={v.created_at}>{formatAt(v.created_at)}</time></span>
              </p>
              <p className="mt-0.5 text-ink-2">{v.text}</p>
              {v.answer ? (
                <p className="mt-0.5 text-caption text-muted-foreground">
                  그때 보낸 답: {v.answer.answer} · 접수 {v.answer.receipt_no}
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/**
 * 열린 질문 카드 — 한 카드에 질문의 사실(문장 · 유형 · 중요도 · 필수 · 방향 · 버전 · 조건)과 값 구분(보낸 답 · 의견 · 기본값 · AI 추천 · 옛 답)을 따로 보인다.
 * 읽기 순서: 제목줄(번호 · 표식) → 질문 문장 → 보조 설명 → 답 · 의견 → 도구. 도구는 답하는 일보다 아래에 조용히 둔다.
 */
export function QuestionCard(p: CardProps) {
  const { q, scope, tools } = p;
  const kind = kindOf(q);
  const answer = useDraft(keyFor(scope, q.id, q.version, "answer"));
  const opinion = useDraft(keyFor(scope, q.id, q.version, "opinion"));
  // 새 버전이 되었거나 처음 그릴 때(그 그림에서 바로): 앞 버전 초안이 있고 새 칸이 비었으면 검토 영역을 연다
  const reviewFor = `${keyFor(scope, q.id, q.version, "answer")}|${q.sent ? "sent" : ""}`;
  const [rv, setRv] = React.useState(() => ({ for: reviewFor, review: findReview(scope, q) }));
  const current = rv.for === reviewFor ? rv : { for: reviewFor, review: findReview(scope, q) };
  if (current !== rv) setRv(current);
  const review = current.review;
  const setReview = (r: Review | null) => setRv({ for: reviewFor, review: r });
  const [showOld, setShowOld] = React.useState(false);
  const [tidyOpen, setTidyOpen] = React.useState(false);
  const [historyOpen, setHistoryOpen] = React.useState(false);

  const closeReview = (bring: boolean) => {
    if (bring && review) {
      answer[1](merge(answer[0], review.answer));
      opinion[1](merge(opinion[0], review.opinion));
    }
    setReview(null);
    document.getElementById(q.id)?.focus();
  };

  const head = `질문 ${q.number}`;
  const showIf = showIfLine(q, p.all);
  const defaultText = q.default_value ? optionLabel(q.options, q.default_value) : null;
  const rec = q.recommendation ?? null;
  const prev = q.previous_answer ?? null;
  const editId = `tool-edit-${q.id}`;

  return (
    <li data-question={q.id} data-status="open" tabIndex={-1} className="border-t py-4 outline-none first:border-t-0 first:pt-1 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">
      <QuestionContextMenu q={q} actions={questionActions(p.actions, q.id)}>
        <div>
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
            <h3 id={`${q.id}-head`} className="text-meta font-semibold text-ink">
              {head}
            </h3>
            {q.required ? (
              <Chip chip="required" tone="strong">
                필수
              </Chip>
            ) : null}
            <Chip chip="importance">중요도 {importanceLabel(q.importance)}</Chip>
            <Button
              id={`peek-${q.id}`}
              variant="ghost"
              size="xs"
              className="ml-auto"
              aria-label={`${head} 미리보기`}
              aria-haspopup="dialog"
              aria-expanded={p.open}
              onClick={() => p.onPeek(q.id)}
            >
              <Eye aria-hidden="true" />
              미리보기
            </Button>
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <Chip chip="kind" tone="quiet">
              {KIND_LABEL[kind]}
            </Chip>
            <Chip chip="direction" tone="quiet">
              {DIRECTION_CHIP[directionOf(q)]}
            </Chip>
            <Chip chip="version" tone="quiet">
              버전 {q.version}
            </Chip>
            <span className="text-caption text-muted-foreground">{SOURCE_LABEL[q.source]}</span>
          </p>
          {q.needs_recheck || prev ? (
            <p className="mt-2 flex flex-wrap items-center gap-1.5">
              {q.needs_recheck ? (
                <span data-badge="recheck">
                  <Status of="question" value="recheck" />
                </span>
              ) : null}
              {prev ? (
                <span data-badge="old-answer" className="rounded-full border border-line px-2 py-px text-caption text-ink-2">
                  옛 답 있음
                </span>
              ) : null}
            </p>
          ) : null}
          <p className="mt-2 text-body text-ink">{q.text}</p>
          {q.help ? <p className="mt-1 text-meta text-muted-foreground">{q.help}</p> : null}
          {showIf ? <p className="mt-1 text-caption text-ink-2">{showIf}</p> : null}
          {q.needs_recheck ? <p className="mt-1.5 text-meta text-ink-2">질문이 바뀌어 답을 다시 확인해야 해요. 옛 답은 남아 있고, 새 답으로 옮겨지지 않아요.</p> : null}
          {prev ? (
            <div className="mt-1.5">
              <Button variant="link" aria-expanded={showOld} onClick={() => setShowOld((v) => !v)}>
                옛 답 보기
              </Button>
              {showOld ? (
                <div data-field-kind="old-answer" className="mt-1.5 rounded-md bg-surface-sunk px-3 py-2">
                  <p className="text-body whitespace-pre-wrap text-ink">{prev.answer}</p>
                  <p className="mt-1 text-caption text-muted-foreground">
                    버전 {prev.version}에서 보낸 답 · <time dateTime={prev.committed_at}>{formatAt(prev.committed_at)}</time> · 접수 {prev.receipt_no} · 새 답 칸에는 옮기지 않았어요
                  </p>
                </div>
              ) : null}
            </div>
          ) : null}

          {defaultText || rec ? (
            <dl className="mt-2.5 grid gap-1">
              {defaultText ? (
                <ValueLine kind="default" label="기본값">
                  {defaultText} <span className="text-caption text-muted-foreground">· 고르기 전에는 답이 아니에요</span>
                </ValueLine>
              ) : null}
              {rec ? (
                <ValueLine kind="recommendation" label="AI 추천">
                  {optionLabel(q.options, rec.value)} <span className="text-muted-foreground">— {rec.reason}</span>
                </ValueLine>
              ) : null}
            </dl>
          ) : null}

          {q.sent ? (
            <div data-field-kind="answer" className="mt-3 rounded-md bg-surface-sunk px-3 py-2">
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
                {isChoice(kind) ? (
                  <ChoiceAnswer q={q} draft={answer} head={head} />
                ) : (
                  <div>
                    <label className="block text-meta font-medium text-ink" htmlFor={q.id}>
                      <span className="sr-only">{head} </span>답{q.required ? " (필수)" : ""}
                    </label>
                    <DraftTextarea id={q.id} rows={3} draft={answer} />
                  </div>
                )}
                <div data-field-kind="opinion">
                  <label className="block text-meta font-medium text-ink" htmlFor={`${q.id}-opinion`}>
                    <span className="sr-only">{head} </span>의견 <span className="font-normal text-muted-foreground">(선택)</span>
                  </label>
                  <DraftTextarea id={`${q.id}-opinion`} rows={2} draft={opinion} />
                </div>
              </div>
            </>
          )}

          {tools ? (
            <div className="mt-3 flex flex-wrap items-center gap-x-1 gap-y-1 border-t border-dashed pt-2.5">
              <ToolButton id={editId} size="sm" blocked={tools.blocked} aria-label={`${head} 고치기`} aria-expanded={p.editing} onClick={() => p.onEditing(!p.editing)}>
                <PenLine aria-hidden="true" />
                고치기
              </ToolButton>
              <ToolButton id={`tool-up-${q.id}`} size="icon-sm" blocked={tools.blocked} edge={tools.first} aria-label={`${head} 위로 옮기기`} onClick={() => p.onMove(q.id, "up")}>
                <ArrowUp aria-hidden="true" />
              </ToolButton>
              <ToolButton id={`tool-down-${q.id}`} size="icon-sm" blocked={tools.blocked} edge={tools.last} aria-label={`${head} 아래로 옮기기`} onClick={() => p.onMove(q.id, "down")}>
                <ArrowDown aria-hidden="true" />
              </ToolButton>
              <ToolButton id={`tool-tidy-${q.id}`} size="sm" blocked={tools.blocked} aria-label={`${head} 정리`} aria-expanded={tidyOpen} onClick={() => setTidyOpen((v) => !v)}>
                <Settings2 aria-hidden="true" />
                정리
              </ToolButton>
              <ToolButton id={`tool-history-${q.id}`} size="sm" blocked={tools.blocked} aria-label={`${head} 버전 기록`} aria-expanded={historyOpen} onClick={() => setHistoryOpen((v) => !v)}>
                <History aria-hidden="true" />
                버전 기록
              </ToolButton>
              {tidyOpen && !tools.blocked ? (
                <div role="group" aria-label={`${head} 정리`} className="flex basis-full flex-wrap items-center gap-1.5 pt-1">
                  <span className="text-caption text-muted-foreground">지우지 않고 ‘정리된 질문’으로 옮겨요</span>
                  {(
                    [
                      ["withdraw", "철회"],
                      ["defer", "보류"],
                      ["merge", "합치기"],
                    ] as const
                  ).map(([k, label]) => (
                    <Button key={k} id={`tidy-${k}-${q.id}`} variant="outline" size="sm" onClick={() => p.onTidy(q.id, k)}>
                      {label}
                    </Button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          {historyOpen && tools && !tools.blocked ? <VersionHistory q={q} project={scope.project} edition={scope.edition} /> : null}
          {p.editing && tools && !tools.blocked ? (
            <QuestionEditor
              q={q}
              others={p.others}
              save={(body, key) => p.save(q.id, body, key)}
              onClose={() => {
                p.onEditing(false);
                document.getElementById(editId)?.focus();
              }}
              onSaved={(r) => {
                p.onEditing(false);
                p.onSaved(q, r);
                document.getElementById(editId)?.focus();
              }}
            />
          ) : null}
        </div>
      </QuestionContextMenu>
    </li>
  );
}

const CLOSED_NAME = { withdrawn: "withdrawn", deferred: "deferred", merged: "merged" } as const;

/** 정리된 질문(철회 · 보류 · 합쳐짐) — 지우지 않고 이름으로 남긴다. 답 칸 · 도구 없음, 보낸 답은 그대로 보인다 */
export function ClosedCard({ q, all }: { q: QuestionView; all: QuestionView[] }) {
  const st = statusOf(q);
  const into = q.merged_into ? all.find((x) => x.id === q.merged_into) : undefined;
  return (
    <li data-question={q.id} data-status={st} tabIndex={-1} className="border-t py-3 outline-none first:border-t-0 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h3 className="text-meta font-semibold text-ink">질문 {q.number}</h3>
        {st in CLOSED_NAME ? <Status of="question" value={CLOSED_NAME[st as keyof typeof CLOSED_NAME]} /> : null}
        {st === "merged" ? <span className="text-caption text-muted-foreground">질문 {into ? into.number : (q.merged_into ?? "").replace(/^q-/, "")}에 합쳐졌어요</span> : null}
      </div>
      <p className="mt-1 text-meta text-ink-2">{q.text}</p>
      {q.sent ? (
        <div data-field-kind="answer" className="mt-2 rounded-md bg-surface-sunk px-3 py-2">
          <p className="text-meta text-ink">{q.sent.answer}</p>
          <p className="mt-1 text-caption text-muted-foreground">
            보낸 답은 그대로 남아 있어요 · <time dateTime={q.sent.committed_at}>{formatAt(q.sent.committed_at)}</time> · 접수 {q.sent.receipt_no}
          </p>
        </div>
      ) : null}
    </li>
  );
}
