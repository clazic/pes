import * as React from "react";
import { X } from "lucide-react";
import type { QuestionView, RoundView } from "@/api/types";
import { Button } from "@/components/ui/button";
import { formatAt, IMPORTANCE_LABEL, SOURCE_LABEL } from "@/lib/labels";
import type { View } from "./paths";

/**
 * 질문 미리보기(설계 4.7) — 비모달 대화 상자. 질문 영역 맨 위에 흐름 안으로 들어간다(떠 있는 판이 아니라 —
 * 떠 있으면 그 아래 질문 칸에 초점이 가도 가려진다, WCAG 2.4.11). 화면의 나머지는 그대로 쓸 수 있다.
 * Esc · 닫기 · 뒤로 가기로 닫으면 연 단추로 초점이 돌아간다(작업 공간이 맡음). Esc 는 다른 층(메뉴 · 판)이 먼저 받았으면 넘긴다.
 * 주소의 peek 가 열림 상태다(딥링크 · 새로고침 · 뒤로 가기에 같은 화면).
 */
export function PeekDialog({ q, focusOnOpen, onClose }: { q: QuestionView; focusOnOpen: boolean; onClose: () => void }) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (focusOnOpen) ref.current?.focus();
  }, [focusOnOpen, q.id]);
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 메뉴 · 판(radix 층)이 먼저 Esc 를 받아 닫았으면(defaultPrevented) 미리보기는 그대로 둔다
      if (e.key === "Escape" && !e.isComposing && !e.defaultPrevented) {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="false"
      aria-labelledby={`peek-title-${q.id}`}
      tabIndex={-1}
      className="mx-4 mt-4 rounded-lg border border-primary-line bg-popover p-4 text-popover-foreground shadow-sm outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 id={`peek-title-${q.id}`} className="text-title text-ink">
            미리보기
          </h2>
          <p className="text-caption text-muted-foreground">
            질문 {q.number} · 버전 {q.version} · {SOURCE_LABEL[q.source]} · {q.required ? "필수" : "선택"} · 중요도 {IMPORTANCE_LABEL[q.importance]}
          </p>
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="미리보기 닫기" onClick={onClose}>
          <X aria-hidden="true" />
        </Button>
      </div>
      <p className="mt-3 text-body text-ink">{q.text}</p>
      {q.help ? <p className="mt-1.5 text-meta text-muted-foreground">{q.help}</p> : null}
      {q.sent ? (
        <p className="mt-3 rounded-md bg-surface-sunk px-3 py-2 text-meta text-ink">
          보낸 답: {q.sent.answer}
          <span className="block text-caption text-muted-foreground">
            <time dateTime={q.sent.committed_at}>{formatAt(q.sent.committed_at)}</time> · 접수 {q.sent.receipt_no}
          </span>
        </p>
      ) : (
        <p className="mt-3 text-caption text-muted-foreground">아직 보낸 답이 없습니다.</p>
      )}
    </div>
  );
}

/**
 * 인쇄 미리보기(설계 4.7 인쇄 · U6) — 주소의 print=1. 저절로 인쇄하지 않는다(사람이 “인쇄하기”를 눌러야 window.print).
 * 출력 시점 고정 · 보내지 않은 초안은 빼고, 보낸 답과 결과 글만.
 */
export function PrintPreview({ round, title, headingRef, onClose }: { round: RoundView; title: string; headingRef: React.RefObject<HTMLHeadingElement | null>; onClose: () => void }) {
  const sent = round.questions.filter((q) => q.sent);
  return (
    <section aria-label="인쇄 미리보기" data-print-preview="" className="border-b bg-surface-soft px-4 py-4 tab:px-6">
      <div className="flex flex-wrap items-center gap-2" data-print="hide">
        <h2 ref={headingRef} tabIndex={-1} className="mr-auto text-title text-ink outline-none">
          인쇄 미리보기
        </h2>
        <Button variant="default" size="sm" onClick={() => window.print()}>
          인쇄하기
        </Button>
        <Button variant="ghost" size="sm" onClick={onClose}>
          미리보기 닫기
        </Button>
      </div>
      <div className="print-paper mt-3 max-w-[46rem] rounded-md border bg-background px-5 py-6 shadow-sm">
        <p className="text-caption text-muted-foreground">출력 시점 고정 · 보내지 않은 초안은 빠집니다</p>
        <p className="mt-1 text-title font-semibold text-ink">{title}</p>
        <h3 className="mt-4 text-meta font-semibold text-ink">질문과 보낸 답</h3>
        {sent.length ? (
          <dl className="mt-1 space-y-2">
            {sent.map((q) => (
              <div key={q.id}>
                <dt className="text-meta text-ink">
                  질문 {q.number}. {q.text}
                </dt>
                <dd className="ml-0 text-meta text-ink-2">{q.sent?.answer}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="mt-1 text-meta text-ink-2">아직 보낸 답이 없습니다.</p>
        )}
        {round.result ? (
          <>
            <h3 className="mt-4 text-meta font-semibold text-ink">
              {round.result.title} <span className="font-normal text-muted-foreground">v{round.result.version} · {round.result.status === "adopted" ? "채택본" : "초안"}</span>
            </h3>
            {round.result.paragraphs.map((p) => (
              <p key={p} className="mt-1 text-meta text-ink">
                {p}
              </p>
            ))}
          </>
        ) : null}
      </div>
    </section>
  );
}

const VIEWS: { value: View; label: string }[] = [
  { value: "body", label: "본문" },
  { value: "ask", label: "질문" },
];

/**
 * 좁은 화면 보기 전환(설계 12.4 C12) — 탭 모양 라디오 묶음(WAI-ARIA radio group): Tab 으로는 고른 칸 하나에 닿고,
 * 화살표(←↑ 앞 · →↓ 뒤, 끝에서 돈다 · Home · End)로 옮기면 바로 고른다. Space 로도 고른다.
 * 1280 미만 어디서나 본문 · 질문 둘이다(단계·라운드는 사이드바 나무). 1280 이상에서는 숨는다(본문 · 질문이 나란히 보임).
 */
export function ViewSwitch({ view, onChange }: { view: View; onChange: (v: View) => void }) {
  const views = VIEWS;
  const current = view;
  const refs = React.useRef<(HTMLButtonElement | null)[]>([]);
  const move = (to: number) => {
    const i = (to + views.length) % views.length;
    onChange(views[i]!.value);
    refs.current[i]?.focus();
  };
  const onKeyDown = (e: React.KeyboardEvent, i: number) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (step) move(i + step);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(views.length - 1);
    else return;
    e.preventDefault();
  };
  return (
    <div className="view-switch border-b px-3 py-2" data-print="hide">
      <div role="radiogroup" aria-label="보기" className="mx-auto grid max-w-xs grid-cols-2 gap-1 rounded-lg bg-muted p-1">
        {views.map((v, i) => {
          const checked = v.value === current;
          return (
            <button
              key={v.value}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              tabIndex={checked ? 0 : -1}
              onClick={() => onChange(v.value)}
              onKeyDown={(e) => onKeyDown(e, i)}
              className="min-h-8 rounded-md border border-transparent px-2 text-meta text-ink-2 outline-none hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-checked:border-line-strong aria-checked:bg-background aria-checked:font-semibold aria-checked:text-ink aria-checked:shadow-xs"
            >
              {v.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
