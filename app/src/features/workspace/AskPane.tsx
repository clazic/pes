import * as React from "react";
import { Eye, PenLine } from "lucide-react";
import type { QuestionView, RoundView } from "@/api/types";
import { ActionButton } from "@/components/pes/action-button";
import { Button } from "@/components/ui/button";
import { useDraft } from "@/lib/draft";
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

function QuestionItem({ q, draftScope, open, onPeek }: { q: QuestionView; draftScope: string; open: boolean; onPeek: (id: string) => void }) {
  const [answer, setAnswer] = useDraft(`${draftScope}:${q.id}:v${q.version}:answer`);
  const [opinion, setOpinion] = useDraft(`${draftScope}:${q.id}:v${q.version}:opinion`);
  const head = `질문 ${q.number}`;
  return (
    <li className="border-t py-4 first:border-t-0 first:pt-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <h3 className="text-meta font-semibold text-ink">{head}</h3>
        {q.required ? <Chip tone="strong">필수</Chip> : null}
        <Chip>중요도 {q.importance}</Chip>
        <span className="text-caption text-muted-foreground">{q.source_label}</span>
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
            보냄 · {q.sent.at} · {q.sent.receipt_no}
          </p>
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          <div>
            <label className="block text-meta font-medium text-ink" htmlFor={q.id}>
              <span className="sr-only">{head} </span>답{q.required ? " (필수)" : ""}
            </label>
            <textarea id={q.id} rows={3} className={fieldClass} value={answer} onChange={(e) => setAnswer(e.target.value)} />
          </div>
          <div>
            <label className="block text-meta font-medium text-ink" htmlFor={`${q.id}-opinion`}>
              <span className="sr-only">{head} </span>의견 <span className="font-normal text-muted-foreground">(선택)</span>
            </label>
            <textarea id={`${q.id}-opinion`} rows={2} className={fieldClass} value={opinion} onChange={(e) => setOpinion(e.target.value)} />
          </div>
        </div>
      )}
    </li>
  );
}

/**
 * 질문 영역(설계 4.7 질문·답 · 4.16). 휴대폰에서도 답 · 의견은 켜져 있고, 질문 고치기는 데스크톱으로 안내한다.
 * 지난 라운드는 읽기 전용 — 보낸 답만 보인다.
 */
export function AskPane({
  round,
  draftScope,
  editBlocked,
  peekId,
  onPeek,
}: {
  round: RoundView;
  draftScope: string;
  editBlocked?: string;
  peekId: string | null;
  onPeek: (id: string) => void;
}) {
  const [editNote, setEditNote] = React.useState(false);
  const past = round.state !== "current";
  const total = round.questions.length;
  const open = round.questions.filter((q) => !q.sent);
  const requiredLeft = open.filter((q) => q.required).length;
  return (
    <div className="px-4 pt-5 pb-16">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-title text-ink">질문</h2>
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
          aria-controls={editBlocked ? undefined : "edit-note"}
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
          <QuestionItem key={q.id} q={q} draftScope={draftScope} open={peekId === q.id} onPeek={onPeek} />
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
