import * as React from "react";
import type { CommandResult, QuestionInput, QuestionView } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { controlClass, Field } from "./fields";
import { QuestionFields } from "./QuestionFields";
import { useKeyedCommand } from "./question-command";
import { isChoice, toInput, type EditorValue } from "./question-model";

const EMPTY: EditorValue = { text: "", kind: "free_text", options: [], importance: "", required: false, default_value: "", show_question: "", show_equals: "", help: "", direction: "ask_human" };

function ErrorLine({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <p id={id} role="alert" className="rounded-md border border-bad-line bg-bad-soft px-3 py-2 text-meta text-bad">
      {children}
    </p>
  );
}

function AddForm({ add, onDone, onCancel }: { add: (body: QuestionInput, key: string) => Promise<CommandResult<{ question_id: string; version: number }>>; onDone: (id: string) => void; onCancel: () => void }) {
  const [value, setValue] = React.useState<EditorValue>(EMPTY);
  const set = React.useCallback((patch: Partial<EditorValue>) => setValue((v) => ({ ...v, ...patch })), []);
  const cmd = useKeyedCommand();
  const input = toInput(value);
  const reason = !input.text ? "질문 문장을 적어 주세요." : isChoice(input.kind) && input.options.length < 2 ? "선택지를 2개 이상 적어 주세요." : null;
  const textRef = React.useRef<HTMLTextAreaElement>(null);

  const submit = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    if (reason || cmd.pending) return;
    const r = await cmd.run(JSON.stringify(input), (key) => add(input, key));
    if (r.ok) onDone(r.value.data.question_id);
  };

  return (
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>질문 더하기</DialogTitle>
        <DialogDescription>사람이 더한 질문은 “사람”이 낸 것으로 보여요. 더해도 이미 보낸 답은 그대로 남아요.</DialogDescription>
      </DialogHeader>
      <QuestionFields prefix="add" value={value} set={set} others={[]} advanced={false} textRef={textRef} />
      {cmd.error ? <ErrorLine id="add-error">{cmd.error}</ErrorLine> : null}
      <DialogFooter className="items-center">
        {reason ? (
          <span id="add-reason" className="mr-auto text-caption text-muted-foreground">
            {reason}
          </span>
        ) : null}
        <Button onClick={onCancel}>취소</Button>
        <Button type="submit" variant="default" aria-disabled={reason || cmd.pending ? "true" : undefined} aria-describedby={reason ? "add-reason" : undefined}>
          추가하기
        </Button>
      </DialogFooter>
    </form>
  );
}

/** 질문 더하기 — 대화 상자. 문장 칸으로 초점이 가고, Esc 로 닫으면 연 단추로 돌아온다(radix 가 맡음) */
export function AddQuestionDialog({
  open,
  onOpenChange,
  add,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  add: (body: QuestionInput, key: string) => Promise<CommandResult<{ question_id: string; version: number }>>;
  onAdded: (id: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <DialogContent
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            document.getElementById("add-text")?.focus();
          }}
          // 닫힌 뒤 초점은 작업 공간이 정한다 — 추가했으면 새 질문, 취소 · Esc 는 ‘질문 더하기’ 단추
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <AddForm
            add={add}
            onCancel={() => onOpenChange(false)}
            onDone={(id) => {
              onOpenChange(false);
              onAdded(id);
            }}
          />
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

export type TidyKind = "withdraw" | "defer" | "merge";
const TIDY_NAME: Record<TidyKind, string> = { withdraw: "철회", defer: "보류", merge: "합치기" };
const TIDY_RESULT: Record<TidyKind, string> = { withdraw: "철회됨", defer: "보류됨", merge: "합쳐짐" };

/**
 * 철회 · 보류 · 합치기 확인 — 지우지 않는다는 말과 “보낸 답은 남는다”는 말을 먼저 알린다.
 * 확정하면 명령 한 번(멱등 키 하나), 취소하면 0번. 실패하면 열린 채 오류를 읽힌다.
 */
export function TidyDialog({
  kind,
  q,
  targets,
  onClose,
  run,
  onDone,
}: {
  kind: TidyKind;
  q: QuestionView;
  /** 합칠 수 있는 질문(자기 자신 제외 열린 질문) */
  targets: QuestionView[];
  onClose: () => void;
  run: (into: string, key: string) => Promise<unknown>;
  onDone: () => void;
}) {
  const [into, setInto] = React.useState("");
  const cmd = useKeyedCommand();
  const name = TIDY_NAME[kind];
  const blocked = kind === "merge" && !into;
  const confirm = async () => {
    if (blocked || cmd.pending) return;
    const r = await cmd.run(`${kind}:${into}`, (key) => run(into, key));
    if (r.ok) onDone();
  };
  return (
    // 모달 — 상태를 바꾸는 확인이라 초점이 안에 갇히고 뒤 화면은 비활성이다. Esc · 취소로 닫는다
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        // 닫힌 뒤 초점은 작업 공간이 정한다 — 끝냈으면 다음 질문, 취소 · Esc 는 연 단추
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>
            질문 {q.number} {name}
          </DialogTitle>
          <DialogDescription>
            질문을 지우지 않아요. ‘정리된 질문’에 ‘{TIDY_RESULT[kind]}’으로 남고, 보낸 답은 그대로 남아요.
          </DialogDescription>
        </DialogHeader>
        {kind === "merge" ? (
          <Field id={`${q.id}-merge-into`} label="합칠 질문">
            <select id={`${q.id}-merge-into`} className={controlClass} value={into} onChange={(e) => setInto(e.target.value)}>
              <option value="">고르기</option>
              {targets.map((t) => (
                <option key={t.id} value={t.id}>
                  질문 {t.number} · {t.text.length > 40 ? `${t.text.slice(0, 40)}…` : t.text}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        {cmd.error ? <ErrorLine id={`${q.id}-tidy-error`}>{cmd.error}</ErrorLine> : null}
        <DialogFooter>
          <Button onClick={onClose}>취소</Button>
          <Button variant="default" aria-disabled={blocked || cmd.pending ? "true" : undefined} onClick={confirm}>
            {name} 확정
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
