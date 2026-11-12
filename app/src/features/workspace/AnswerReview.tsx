import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SKIP_TEXT, summary, type Plan } from "./answer-model";

/**
 * 답 검토(F06) — 묶음으로 보내기 전에 한 번 더 보는 모달. 보낼 답 · 아직 비어 있는 필수 질문 · 보내지 않는 초안을 따로 보인다.
 * 하나라도 받아들여지지 않으면 아무것도 접수되지 않는다(부분 접수 0). 필수가 비어 있으면 확정은 aria-disabled(누르면 아무 일도 없다).
 * 기본값을 그대로 보내는 답은 따로 드러난다([data-used-default]). 보내는 동안에는 닫지 않고 두 번 눌러도 한 번만 간다.
 */
export function AnswerReview({ plan, pending, onCancel, onConfirm }: { plan: Plan; pending: boolean; onCancel: () => void; onConfirm: () => void }) {
  const off = plan.missing.length > 0 || plan.items.length === 0 || pending;
  return (
    <Dialog open onOpenChange={(o) => !o && !pending && onCancel()}>
      <DialogContent onCloseAutoFocus={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>답 검토</DialogTitle>
          <DialogDescription>
            아래 답 {plan.items.length}개를 한 번에 보내요. 하나라도 받아들여지지 않으면 아무것도 접수되지 않아요.
          </DialogDescription>
        </DialogHeader>

        <ul aria-label="보낼 답" className="grid gap-2.5">
          {plan.items.map((it) => (
            <li key={it.q.id} data-review-item={it.q.id} className="rounded-md bg-surface-sunk px-3 py-2">
              <p className="flex flex-wrap items-center gap-x-2 text-meta font-semibold text-ink">
                질문 {it.q.number}
                {it.usedDefault ? (
                  <span data-used-default="" className="rounded-sm border border-line px-1.5 text-caption font-normal text-ink-2">
                    기본값 그대로
                  </span>
                ) : null}
              </p>
              <p className="mt-0.5 text-body whitespace-pre-wrap text-ink">{summary(it)}</p>
              {it.comment ? <p className="mt-1 text-meta whitespace-pre-wrap text-ink-2">의견: {it.comment}</p> : null}
            </li>
          ))}
        </ul>

        {plan.missing.length ? (
          <section aria-label="아직 비어 있는 필수 질문" className="rounded-md border border-warn-line bg-warn-soft px-3 py-2.5">
            <p className="text-meta font-semibold text-ink">아직 비어 있는 필수 질문 {plan.missing.length}개 — 채워야 보낼 수 있어요</p>
            <ul className="mt-1.5 grid gap-1">
              {plan.missing.map((q) => (
                <li key={q.id} data-missing={q.id} className="text-meta text-ink">
                  질문 {q.number} <span className="text-ink-2">· {q.text.length > 36 ? `${q.text.slice(0, 36)}…` : q.text}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {plan.skipped.length ? (
          <section aria-label="보내지 않는 초안">
            <p className="text-meta font-semibold text-ink">보내지 않는 초안 {plan.skipped.length}개</p>
            <ul className="mt-1 grid gap-0.5">
              {plan.skipped.map((s) => (
                <li key={s.q.id} data-skipped={s.q.id} className="text-caption text-ink-2">
                  질문 {s.q.number} — {SKIP_TEXT[s.reason]}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <DialogFooter>
          <Button className="coarse:min-h-[44px]" onClick={() => !pending && onCancel()} aria-disabled={pending ? "true" : undefined}>
            취소
          </Button>
          <Button
            variant="default"
            className="coarse:min-h-[44px]"
            aria-disabled={off ? "true" : undefined}
            onClick={(e) => {
              if (off) return void e.preventDefault();
              onConfirm();
            }}
          >
            묶음으로 보내기
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
