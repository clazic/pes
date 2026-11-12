import * as React from "react";
import type { CommandResult, QuestionRevision, QuestionView } from "@/api/types";
import { Button } from "@/components/ui/button";
import { QuestionFields } from "./QuestionFields";
import { useKeyedCommand } from "./question-command";
import { blockReason, editorValueOf, inputOf, meaningChanged, sameInput, toInput, type EditorValue } from "./question-model";

type Saved = CommandResult<{ question_id: string; version: number; needs_recheck: boolean }>;

/**
 * 인라인 고치기(F04 · F06) — 질문 항목 안에서 펼친다. 저장 = 새 버전 명령 한 번(멱등 키 하나, base_version = 연 때의 버전).
 * 열린 동안 입력은 이 컴포넌트 상태에 있어 갱신(getRound 다시 읽기)이 와도 지워지지 않는다. 같은 질문이 다른 곳에서 새 버전이 되어도
 * 그대로 두고, 저장하면 서버가 conflict 로 거절한다(그때도 입력은 남는다).
 * 의미가 바뀌는 칸(문장 · 유형 · 선택지)을 고치면 저장 전에 “재확인 필요” 경고를 띄운다. 원래 값으로 되돌리면 사라진다.
 */
export function QuestionEditor({
  q,
  others,
  save,
  onClose,
  onSaved,
}: {
  q: QuestionView;
  others: QuestionView[];
  save: (body: QuestionRevision, key: string) => Promise<Saved>;
  /** 저장 없이 닫음 */
  onClose: () => void;
  onSaved: (r: Saved) => void;
}) {
  // 연 때의 질문을 기준으로 삼는다 — 다른 곳에서 바뀐 값으로 칸이 바뀌지 않는다
  const [base] = React.useState(() => ({ version: q.version, input: inputOf(q) }));
  const [value, setValue] = React.useState<EditorValue>(() => editorValueOf(q));
  const set = React.useCallback((patch: Partial<EditorValue>) => setValue((v) => ({ ...v, ...patch })), []);
  const cmd = useKeyedCommand();
  const textRef = React.useRef<HTMLTextAreaElement>(null);
  React.useEffect(() => {
    textRef.current?.focus();
  }, []);

  const input = toInput(value);
  const changed = !sameInput(input, base.input);
  const meaning = meaningChanged(input, base.input);
  const reason = blockReason(input, value, changed);
  const reasonId = `${q.id}-save-reason`;
  const errorId = `${q.id}-edit-error`;

  const onSubmit = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    if (reason || cmd.pending) return;
    const body: QuestionRevision = { ...input, base_version: base.version };
    const r = await cmd.run(JSON.stringify(body), (key) => save(body, key));
    if (r.ok) onSaved(r.value);
  };

  return (
    // 키 처리는 Esc 로 닫기 하나뿐 — 안의 칸 · 단추가 실제 조작 대상이다
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <form
      aria-label={`질문 ${q.number} 고치기`}
      aria-describedby={cmd.error ? errorId : undefined}
      onSubmit={onSubmit}
      onKeyDown={(e) => {
        // 고치지 않은 form 은 Esc 로 닫는다(쓰던 글이 있으면 두고 취소 단추를 쓰게)
        if (e.key === "Escape" && !e.nativeEvent.isComposing && !changed) {
          e.preventDefault();
          onClose();
        }
      }}
      className="mt-3 rounded-lg border border-line-strong bg-surface-soft p-3.5"
    >
      <QuestionFields prefix={`${q.id}-e`} value={value} set={set} others={others} advanced textRef={textRef} />

      {meaning ? (
        <p data-warning="recheck" role="status" className="mt-3.5 rounded-md border border-warn-line bg-warn-soft px-3 py-2 text-meta text-ink">
          <strong className="font-semibold text-warn">재확인 필요</strong> — 문장 · 유형 · 선택지를 바꾸면 이 질문의 답을 다시 확인해야 해요. 옛 답은 보존되고, 새 답으로 옮겨지지 않아요.
        </p>
      ) : null}
      {cmd.error ? (
        <p id={errorId} role="alert" className="mt-3.5 rounded-md border border-bad-line bg-bad-soft px-3 py-2 text-meta text-bad">
          {cmd.error}
        </p>
      ) : null}

      <div className="mt-3.5 flex flex-wrap items-center gap-2">
        <Button type="submit" variant="default" aria-disabled={reason || cmd.pending ? "true" : undefined} aria-describedby={reason ? reasonId : undefined}>
          새 버전으로 저장
        </Button>
        <Button variant="ghost" onClick={onClose}>
          취소
        </Button>
        {reason ? (
          <span id={reasonId} className="text-caption text-muted-foreground">
            {reason}
          </span>
        ) : null}
      </div>
    </form>
  );
}
