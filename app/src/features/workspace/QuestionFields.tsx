import * as React from "react";
import { Plus, X } from "lucide-react";
import type { Importance, QuestionDirection, QuestionKind, QuestionOption, QuestionView } from "@/api/types";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { DIRECTION_OPTION, IMPORTANCE_LABEL, KIND_LABEL } from "@/lib/labels";
import { controlClass, Field } from "./fields";
import { isChoice, keepsEmptyCondition, kindOf, newOptionId, SHOW_IF_UNSUPPORTED_LINE, type EditorValue } from "./question-model";

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
  // 이 목록에 없는 질문을 가리키는 조건(예: `pes ask` 가 폼 안의 이름으로 붙인 것) — 번호를 알 수 없다고 말하고 그대로 둔다
  const unresolved = value.show_question !== "" && !cond && !value.show_unsupported;
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
              <select
                id={`${prefix}-cond`}
                className={controlClass}
                disabled={value.show_unsupported}
                aria-describedby={value.show_unsupported ? `${prefix}-cond-note` : undefined}
                value={value.show_question}
                onChange={(e) => set({ show_question: e.target.value, show_in: [] })}
              >
                <option value="">{value.show_unsupported ? "지원하지 않는 조건" : "항상 보임"}</option>
                {unresolved ? <option value={value.show_question}>목록에 없는 질문 ({value.show_question})</option> : null}
                {others.map((q) => (
                  <option key={q.id} value={q.id}>
                    질문 {q.number}
                  </option>
                ))}
              </select>
            </Field>
            {value.show_question && !value.show_unsupported ? (
              <CondAnswers prefix={prefix} options={condOptions} picked={value.show_in} onChange={(show_in) => set({ show_in })} />
            ) : null}
          </div>
          {value.show_unsupported ? (
            <p id={`${prefix}-cond-note`} role="status" className="text-meta text-ink-2">
              {SHOW_IF_UNSUPPORTED_LINE}. 다른 칸만 고쳐 저장해도 서버의 조건은 그대로 남아요.
            </p>
          ) : keepsEmptyCondition(value) ? (
            <p role="status" className="text-meta text-ink-2">
              조건 답이 비어 있어 이 질문은 항상 숨겨져요. 조건 답을 고르거나 조건 질문을 “항상 보임”으로 바꾸면 달라져요.
            </p>
          ) : null}
        </>
      ) : null}

      <Field id={`${prefix}-help`} label="도움말">
        <input id={`${prefix}-help`} type="text" className={controlClass} value={value.help} onChange={(e) => set({ help: e.target.value })} />
      </Field>
    </div>
  );
}

/**
 * 조건 답 — 조건 질문의 선택지마다 checkbox, 하나라도 고르면 이 질문이 보인다.
 * 선택지에 없는 옛 값(지운 선택지 · 글 답)은 값 그대로 켜진 checkbox 로 남긴다 — 저장해도 조용히 버리지 않는다.
 * 보내는 순서는 조건 질문의 선택지 순서(없는 값은 그 뒤).
 */
function CondAnswers({ prefix, options, picked, onChange }: { prefix: string; options: QuestionOption[] | null; picked: string[]; onChange: (next: string[]) => void }) {
  const [draft, setDraft] = React.useState("");
  const known = options ?? [];
  const order = (ids: string[]) => {
    const rank = (id: string) => {
      const i = known.findIndex((o) => o.id === id);
      return i < 0 ? known.length : i;
    };
    return [...new Set(ids)].sort((x, y) => rank(x) - rank(y));
  };
  const toggle = (id: string) => onChange(order(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]));
  const rows = [...known.map((o) => ({ id: o.id, label: o.label })), ...picked.filter((v) => !known.some((o) => o.id === v)).map((v) => ({ id: v, label: v }))];
  const addDraft = () => {
    const v = draft.trim();
    if (v && !picked.includes(v)) onChange(order([...picked, v]));
    setDraft("");
  };
  return (
    <fieldset className="min-w-0">
      <legend className="text-meta font-medium text-ink">조건 답</legend>
      <div className="mt-1 grid gap-1">
        {rows.map((r) => (
          <label key={r.id} className="flex min-h-8 cursor-pointer items-center gap-2.5 rounded-md px-1 text-body text-ink has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ring coarse:min-h-[44px]">
            <input type="checkbox" className="size-4 shrink-0 accent-primary" checked={picked.includes(r.id)} onChange={() => toggle(r.id)} />
            {r.label}
          </label>
        ))}
      </div>
      {options ? null : (
        <div className="mt-1 flex items-end gap-2">
          <Field id={`${prefix}-cond-value`} label="답 값 더하기" className="flex-1">
            <input
              id={`${prefix}-cond-value`}
              type="text"
              className={controlClass}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addDraft();
                }
              }}
            />
          </Field>
          <Button variant="outline" size="sm" onClick={addDraft}>
            <Plus aria-hidden="true" />
            더하기
          </Button>
        </div>
      )}
    </fieldset>
  );
}
