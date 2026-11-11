import * as React from "react";
import { X } from "lucide-react";
import type { QuestionView, RoundView } from "@/api/types";
import { Button } from "@/components/ui/button";
import type { View } from "./paths";

/**
 * 질문 미리보기(설계 4.7) — 비모달 대화 상자. 화면의 나머지는 그대로 쓸 수 있고, Esc · 닫기로 닫으면 연 단추로 초점이 돌아간다.
 * 주소의 peek 가 열림 상태다(딥링크 · 새로고침 · 뒤로 가기에 같은 화면).
 */
export function PeekDialog({ q, focusOnOpen, onClose }: { q: QuestionView; focusOnOpen: boolean; onClose: () => void }) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (focusOnOpen) ref.current?.focus();
  }, [focusOnOpen, q.id]);
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.isComposing) {
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
      aria-label="미리보기"
      tabIndex={-1}
      className="fixed inset-x-3 bottom-3 z-40 max-h-[70dvh] overflow-y-auto rounded-xl border bg-popover p-4 text-popover-foreground shadow-lg outline-none tab:inset-x-auto tab:right-5 tab:bottom-5 tab:w-[26rem]"
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-title text-ink">질문 {q.number} 미리보기</h2>
          <p className="text-caption text-muted-foreground">
            버전 {q.version} · {q.source_label} · {q.required ? "필수" : "선택"} · 중요도 {q.importance}
          </p>
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="닫기" onClick={onClose}>
          <X aria-hidden="true" />
        </Button>
      </div>
      <p className="mt-3 text-body text-ink">{q.text}</p>
      {q.help ? <p className="mt-1.5 text-meta text-muted-foreground">{q.help}</p> : null}
      {q.sent ? (
        <p className="mt-3 rounded-md bg-surface-sunk px-3 py-2 text-meta text-ink">
          보낸 답: {q.sent.answer}
          <span className="block text-caption text-muted-foreground">
            {q.sent.at} · {q.sent.receipt_no}
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
    <section aria-label="인쇄 미리보기" className="mx-3 mt-4 mb-2 rounded-lg border bg-surface-soft p-3 tab:mx-6 tab:p-4">
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
      <div className="mt-3 rounded-md border bg-background px-5 py-6 shadow-xs">
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
            <h3 className="mt-4 text-meta font-semibold text-ink">{round.result.title}</h3>
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
  { value: "nav", label: "단계·라운드" },
  { value: "body", label: "본문" },
  { value: "ask", label: "질문" },
];

/**
 * 좁은 화면 보기 전환(설계 12.4 C12) — 탭 모양 라디오 묶음(WAI-ARIA radio group): Tab 으로는 고른 칸 하나에 닿고,
 * 화살표(←→↑↓ · Home · End)로 옮기면 바로 고른다. Space 로도 고른다. 1280 이상에서는 숨는다(3영역이 다 보임).
 */
export function ViewSwitch({ view, onChange }: { view: View; onChange: (v: View) => void }) {
  const refs = React.useRef<(HTMLButtonElement | null)[]>([]);
  const move = (to: number) => {
    const i = (to + VIEWS.length) % VIEWS.length;
    onChange(VIEWS[i]!.value);
    refs.current[i]?.focus();
  };
  const onKeyDown = (e: React.KeyboardEvent, i: number) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (step) move(i + step);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(VIEWS.length - 1);
    else return;
    e.preventDefault();
  };
  return (
    <div className="view-switch sticky top-14 z-20 border-b bg-background/95 px-3 py-2 backdrop-blur-sm" data-print="hide">
      <div role="radiogroup" aria-label="보기" className="mx-auto grid max-w-md grid-cols-3 gap-1 rounded-lg bg-muted p-1">
        {VIEWS.map((v, i) => {
          const checked = v.value === view;
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
