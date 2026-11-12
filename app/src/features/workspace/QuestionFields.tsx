import * as React from "react";
import { Plus, X } from "lucide-react";
import type { Importance, QuestionDirection, QuestionKind, QuestionView } from "@/api/types";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { DIRECTION_OPTION, IMPORTANCE_LABEL, KIND_LABEL } from "@/lib/labels";
import { controlClass, Field } from "./fields";
import { isChoice, kindOf, newOptionId, type EditorValue } from "./question-model";

const KINDS: QuestionKind[] = ["single_choice", "multi_choice", "free_text"];
const IMPORTANCES: Importance[] = ["high", "normal", "low"];
const DIRECTIONS: QuestionDirection[] = ["ask_human", "ask_ai"];

/**
 * 질문 칸들 — 인라인 고치기와 “질문 더하기” 대화 상자가 같이 쓴다.
 * 순서(위에서 아래): 문장 → 유형과 선택지 → 중요도 · 필수 · 방향 → (고치기만) 기본값 · 조건 → 도움말.
 * 값은 위에서 내려주고(value) 바뀌면 set 으로 되돌린다. 여기서는 명령을 보내지 않는다.
 */
export function QuestionFields({
  prefix,
  value,
  set,
  others,
  advanced,
  textRef,
}: {
  /** 칸 id 앞부분 (한 화면에 여럿이 열려도 id 가 겹치지 않게) */
  prefix: string;
  value: EditorValue;
  set: (patch: Partial<EditorValue>) => void;
  /** 조건 질문 후보 — 자기 자신을 뺀 열린 질문 */
  others: QuestionView[];
  /** 기본값 · 조건 질문 칸을 보인다 */
  advanced: boolean;
  textRef?: React.Ref<HTMLTextAreaElement>;
}) {
  const choice = isChoice(value.kind);
  const named = value.options.filter((o) => o.label.trim());
  const cond = others.find((q) => q.id === value.show_question);
  const condOptions = cond && isChoice(kindOf(cond)) ? (cond.options ?? []) : null;

  const changeKind = (kind: QuestionKind) => {
    // 선택지 ↔ 글 사이에서는 기본값의 뜻이 달라진다(선택지 id ↔ 글) — 새 유형에 맞지 않는 값이 남지 않게 비운다
    const patch: Partial<EditorValue> = isChoice(kind) === isChoice(value.kind) ? { kind } : { kind, default_value: "" };
    if (isChoice(kind) && value.options.length < 2) {
      const next = [...value.options];
      while (next.length < 2) next.push({ id: newOptionId(next), label: "" });
      set({ ...patch, options: next });
    } else set(patch);
  };
  const setOption = (id: string, label: string) => set({ options: value.options.map((o) => (o.id === id ? { ...o, label } : o)) });

  return (
    <div className="grid gap-3.5">
      <Field id={`${prefix}-text`} label="질문 문장">
        <textarea id={`${prefix}-text`} ref={textRef} rows={3} className={cn(controlClass, "resize-y")} value={value.text} onChange={(e) => set({ text: e.target.value })} />
      </Field>

      <div className="grid gap-3 min-[26rem]:grid-cols-2">
        <Field id={`${prefix}-kind`} label="유형">
          <select id={`${prefix}-kind`} className={controlClass} value={value.kind} onChange={(e) => changeKind(e.target.value as QuestionKind)}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </Field>
        <Field id={`${prefix}-direction`} label="방향">
          <select id={`${prefix}-direction`} className={controlClass} value={value.direction} onChange={(e) => set({ direction: e.target.value as QuestionDirection })}>
            {DIRECTIONS.map((d) => (
              <option key={d} value={d}>
                {DIRECTION_OPTION[d]}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {choice ? (
        <div className="grid gap-2">
          {value.options.map((o, i) => (
            <div key={o.id} className="flex items-end gap-2">
              <Field id={`${prefix}-opt-${o.id}`} label={`선택지 ${i + 1}`} className="flex-1">
                <input id={`${prefix}-opt-${o.id}`} type="text" className={controlClass} value={o.label} onChange={(e) => setOption(o.id, e.target.value)} />
              </Field>
              <Button variant="ghost" size="icon" aria-label={`선택지 ${i + 1} 지우기`} onClick={() => set({ options: value.options.filter((x) => x.id !== o.id) })}>
                <X aria-hidden="true" />
              </Button>
            </div>
          ))}
          <div>
            <Button variant="outline" size="sm" onClick={() => set({ options: [...value.options, { id: newOptionId(value.options), label: "" }] })}>
              <Plus aria-hidden="true" />
              선택지 더하기
            </Button>
          </div>
        </div>
      ) : null}

      <div className="grid items-end gap-3 min-[26rem]:grid-cols-2">
        <Field id={`${prefix}-importance`} label="중요도">
          <select id={`${prefix}-importance`} className={controlClass} value={value.importance} onChange={(e) => set({ importance: e.target.value as Importance | "" })}>
            <option value="">미정</option>
            {IMPORTANCES.map((i) => (
              <option key={i} value={i}>
                {IMPORTANCE_LABEL[i]}
              </option>
            ))}
          </select>
        </Field>
        <label htmlFor={`${prefix}-required`} className="flex min-h-9 items-center gap-2 text-meta font-medium text-ink coarse:min-h-[44px]">
          <input id={`${prefix}-required`} type="checkbox" className="size-4 accent-primary" checked={value.required} onChange={(e) => set({ required: e.target.checked })} />
          필수
        </label>
      </div>

      {advanced ? (
        <>
          <Field id={`${prefix}-default`} label="기본값">
            {choice ? (
              <select id={`${prefix}-default`} className={controlClass} value={named.some((o) => o.id === value.default_value) ? value.default_value : ""} onChange={(e) => set({ default_value: e.target.value })}>
                <option value="">없음</option>
                {named.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : (
              <input id={`${prefix}-default`} type="text" className={controlClass} value={value.default_value} onChange={(e) => set({ default_value: e.target.value })} />
            )}
          </Field>
          <div className="grid gap-3 min-[26rem]:grid-cols-2">
            <Field id={`${prefix}-cond`} label="조건 질문">
              <select id={`${prefix}-cond`} className={controlClass} value={value.show_question} onChange={(e) => set({ show_question: e.target.value, show_equals: "" })}>
                <option value="">항상 보임</option>
                {others.map((q) => (
                  <option key={q.id} value={q.id}>
                    질문 {q.number}
                  </option>
                ))}
              </select>
            </Field>
            {cond ? (
              <Field id={`${prefix}-cond-equals`} label="조건 답">
                {condOptions ? (
                  <select id={`${prefix}-cond-equals`} className={controlClass} value={value.show_equals} onChange={(e) => set({ show_equals: e.target.value })}>
                    <option value="">고르기</option>
                    {condOptions.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input id={`${prefix}-cond-equals`} type="text" className={controlClass} value={value.show_equals} onChange={(e) => set({ show_equals: e.target.value })} />
                )}
              </Field>
            ) : null}
          </div>
        </>
      ) : null}

      <Field id={`${prefix}-help`} label="도움말">
        <input id={`${prefix}-help`} type="text" className={controlClass} value={value.help} onChange={(e) => set({ help: e.target.value })} />
      </Field>
    </div>
  );
}
