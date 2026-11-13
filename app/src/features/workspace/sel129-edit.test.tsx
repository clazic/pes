// SEL-129 — 인라인 고치기 · 질문 카드가 여러 값 조건(in:[a,b])을 보여 주고 고칠 수 있다. 지원하지 않는 모양은 정직하게 표시한다 (Vitest, jsdom, 가짜 클라이언트, 합성 자료).
// 계약: src/api/sel129-show-if.test.ts 머리말(ShowIf = {question_id, in: string[]}, show_if_unsupported) + 아래 화면 계약. 기존 계약(src/test/u2b.ts 머리말)에서 바뀌는 곳:
//   "조건 답" 은 select 가 아니라 checkbox 묶음이다: group "조건 답"(role=group, aria-label/legend "조건 답") 안에 조건 질문의 선택지마다 checkbox (이름 = 선택지 글).
//     조건 질문을 고르면 묶음이 나타나고(아무것도 안 켜짐), '항상 보임' 이면 사라진다. 지금 조건의 in 값이 켜져 있다. 조건 질문의 선택지에 없는 값은 값 그대로 이름 붙은 켜진 checkbox 로 남는다(조용히 버리지 않는다).
//     하나도 안 켜면 저장은 aria-disabled + 이유 글 "조건 답을 골라 주세요."(aria-describedby). 저장 body.show_if = {question_id, in:[켠 값 — 조건 질문의 선택지 순서]}.
//   질문 카드의 조건 줄: 값 하나 `질문 21에서 ‘이어 보기’를 고르면 보임`(지금 그대로), 둘 `…‘이어 보기’ 또는 ‘따로 보기’를 고르면 보임`.
//   지원하지 않는 조건(QuestionView.show_if_unsupported): 카드에 `[data-show-if="unsupported"]` 한 줄(“지원하지 않는 조건” 포함, '항상 보임'처럼 보이게 하지 않는다),
//     고치기 form 의 "조건 질문" select 는 disabled 이고 form 안에 role=status 안내(“지원하지 않는 조건”)가 있다. 다른 칸을 고쳐 저장하면 body.show_if === null 이고 body.show_if_unsupported === true (http 가 키를 싣지 않는다).
import { waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { U2B_QUESTIONS, aside, boot, editor, item, leaks, type Wire } from "@/test/u2b";

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
});

type Boot = Awaited<ReturnType<typeof boot>>;
const withQ23 = (patch: Wire): Wire[] => U2B_QUESTIONS.map((q) => (q.id === "q-23" ? { ...q, ...patch } : q));
const MULTI_IF = { question_id: "q-21", in: ["join", "split"] };

const openEditor = async (user: Boot["user"], n: number) => {
  await user.click(within(aside()).getByRole("button", { name: `질문 ${n} 고치기` }));
  return editor(n);
};
const group = (form: HTMLElement) => within(form).getByRole("group", { name: "조건 답" });
const box = (form: HTMLElement, label: string) => within(group(form)).getByRole("checkbox", { name: label });
const save = (form: HTMLElement) => within(form).getByRole("button", { name: "새 버전으로 저장" });
const sent = (calls: Boot["calls"]) => calls("reviseQuestion")[0]!.args[3] as { show_if: unknown; show_if_unsupported?: boolean } & Record<string, unknown>;

describe("[SEL-129] 질문 카드 — 여러 값 조건 줄", () => {
  it("값 둘: ‘이어 보기’ 또는 ‘따로 보기’를 고르면 보임", async () => {
    await boot({ questions: withQ23({ show_if: MULTI_IF }) });
    expect(item("q-23").textContent).toMatch(/질문 21에서 ‘이어 보기’ 또는 ‘따로 보기’를 고르면 보임/);
  });

  it("값 하나는 지금 문구 그대로", async () => {
    await boot({ questions: withQ23({ show_if: { question_id: "q-21", in: ["join"] } }) });
    expect(item("q-23").textContent).toMatch(/질문 21에서 ‘이어 보기’를 고르면 보임/);
  });

  it("지원하지 않는 조건: 그렇다고 말한다 — 조건 줄이 없는 질문과 구별된다", async () => {
    await boot({ questions: withQ23({ show_if: null, show_if_unsupported: true }) });
    const mark = item("q-23").querySelector<HTMLElement>('[data-show-if="unsupported"]');
    expect(mark).not.toBeNull();
    expect(mark!.textContent).toMatch(/지원하지 않는 조건/);
    expect(item("q-23").textContent).not.toMatch(/질문 21에서.*보임/);
    expect(leaks(item("q-23"))).toEqual([]);
  });

  it("조건이 없는 질문과 지원 안 하는 표시는 서로 새지 않는다", async () => {
    await boot({ questions: withQ23({ show_if: MULTI_IF }) });
    expect(item("q-22").querySelector('[data-show-if="unsupported"]')).toBeNull();
    expect(item("q-23").querySelector('[data-show-if="unsupported"]')).toBeNull();
  });
});

describe("[SEL-129] 인라인 고치기 — 여러 값 조건", () => {
  it("조건 답이 checkbox 묶음: in 의 값은 켜져 있고 나머지는 꺼져 있다", async () => {
    const { user } = await boot({ questions: withQ23({ show_if: MULTI_IF }) });
    const form = await openEditor(user, 23);
    expect(within(form).getByLabelText("조건 질문")).toHaveDisplayValue("질문 21");
    expect(box(form, "이어 보기")).toBeChecked();
    expect(box(form, "따로 보기")).toBeChecked();
    expect(box(form, "기타")).not.toBeChecked();
    expect(within(group(form)).getAllByRole("checkbox")).toHaveLength(3);
  });

  it("값 하나를 끄고 저장 → show_if.in 이 남은 값 하나", async () => {
    const { user, calls } = await boot({ questions: withQ23({ show_if: MULTI_IF }) });
    const form = await openEditor(user, 23);
    await user.click(box(form, "따로 보기"));
    await user.click(save(form));
    await waitFor(() => expect(calls("reviseQuestion")).toHaveLength(1));
    expect(sent(calls).show_if).toEqual({ question_id: "q-21", in: ["join"] });
    expect(sent(calls).show_if_unsupported).not.toBe(true);
  });

  it("값을 더 켜고 저장 → 선택지 순서로 모든 값", async () => {
    const { user, calls } = await boot({ questions: withQ23({ show_if: MULTI_IF }) });
    const form = await openEditor(user, 23);
    await user.click(box(form, "기타"));
    await user.click(save(form));
    await waitFor(() => expect(calls("reviseQuestion")).toHaveLength(1));
    expect(sent(calls).show_if).toEqual({ question_id: "q-21", in: ["join", "split", "other"] });
  });

  it("값 하나짜리 조건에 값을 더해 여러 값으로 만들 수 있다", async () => {
    const { user, calls } = await boot({ questions: withQ23({ show_if: { question_id: "q-21", in: ["join"] } }) });
    const form = await openEditor(user, 23);
    expect(box(form, "이어 보기")).toBeChecked();
    await user.click(box(form, "기타"));
    await user.click(save(form));
    await waitFor(() => expect(calls("reviseQuestion")).toHaveLength(1));
    expect(sent(calls).show_if).toEqual({ question_id: "q-21", in: ["join", "other"] });
  });

  it("조건이 없던 질문에 조건을 새로 건다: 조건 질문을 고르면 묶음이 나타나고 아무것도 안 켜져 있다 → 둘을 켜 저장", async () => {
    const { user, calls } = await boot();
    const form = await openEditor(user, 22);
    expect(within(form).queryByRole("group", { name: "조건 답" })).toBeNull();
    await user.selectOptions(within(form).getByLabelText("조건 질문"), "질문 21");
    expect(within(group(form)).getAllByRole("checkbox").every((c) => !(c as HTMLInputElement).checked)).toBe(true);
    await user.click(box(form, "기타"));
    await user.click(box(form, "이어 보기"));
    await user.click(save(form));
    await waitFor(() => expect(calls("reviseQuestion")).toHaveLength(1));
    expect(sent(calls).show_if).toEqual({ question_id: "q-21", in: ["join", "other"] });
  });

  it("전부 끄면 저장할 수 없다: aria-disabled + ‘조건 답을 골라 주세요.’ · 명령 0번", async () => {
    const { user, calls } = await boot({ questions: withQ23({ show_if: MULTI_IF }) });
    const form = await openEditor(user, 23);
    await user.click(box(form, "이어 보기"));
    await user.click(box(form, "따로 보기"));
    const btn = save(form);
    expect(btn).toHaveAttribute("aria-disabled", "true");
    const why = btn.getAttribute("aria-describedby");
    expect(why).toBeTruthy();
    expect(document.getElementById(why!)!.textContent).toMatch(/조건 답을 골라 주세요/);
    await user.click(btn);
    expect(calls("reviseQuestion")).toHaveLength(0);
  });

  it("‘항상 보임’으로 두면 묶음이 사라지고 show_if 는 null 로 지운다", async () => {
    const { user, calls } = await boot({ questions: withQ23({ show_if: MULTI_IF }) });
    const form = await openEditor(user, 23);
    await user.selectOptions(within(form).getByLabelText("조건 질문"), "항상 보임");
    expect(within(form).queryByRole("group", { name: "조건 답" })).toBeNull();
    await user.click(save(form));
    await waitFor(() => expect(calls("reviseQuestion")).toHaveLength(1));
    expect(sent(calls).show_if).toBeNull();
    expect(sent(calls).show_if_unsupported).not.toBe(true);
  });

  it("조건 질문을 다른 질문으로 바꾸면 켜진 값이 모두 꺼진다 (옛 질문의 선택지 id 를 끌고 가지 않는다)", async () => {
    const { user } = await boot({ questions: withQ23({ show_if: MULTI_IF }) });
    const form = await openEditor(user, 23);
    await user.selectOptions(within(form).getByLabelText("조건 질문"), "질문 24");
    // 질문 24 는 글 질문 — 선택지 묶음에 옛 선택지가 켜진 채 남지 않는다
    expect(within(form).queryByRole("checkbox", { name: "이어 보기" })).toBeNull();
    expect(within(form).queryByRole("checkbox", { name: "따로 보기" })).toBeNull();
  });

  it("조건 질문의 선택지에 없는 옛 값(gone)은 값 그대로 켜진 checkbox 로 보이고, 저장해도 버려지지 않는다", async () => {
    const { user, calls } = await boot({ questions: withQ23({ show_if: { question_id: "q-21", in: ["join", "gone"] } }) });
    const form = await openEditor(user, 23);
    expect(box(form, "gone")).toBeChecked();
    await user.click(box(form, "기타"));
    await user.click(save(form));
    await waitFor(() => expect(calls("reviseQuestion")).toHaveLength(1));
    const inn = (sent(calls).show_if as { in: string[] }).in;
    expect([...inn].sort()).toEqual(["gone", "join", "other"]);
  });

  it("조건만 고쳐도 재확인 경고는 없다 (뜻이 바뀌는 칸이 아니다)", async () => {
    const { user } = await boot({ questions: withQ23({ show_if: MULTI_IF }) });
    const form = await openEditor(user, 23);
    await user.click(box(form, "기타"));
    expect(form.querySelector('[data-warning="recheck"]')).toBeNull();
  });
});

describe("[SEL-129] 인라인 고치기 — 지원하지 않는 조건은 정직하게", () => {
  const unsupported = () => boot({ questions: withQ23({ show_if: null, show_if_unsupported: true }) });

  it("고치기 form: 조건 질문 select 는 disabled, 조건 답 묶음은 없고, ‘지원하지 않는 조건’ 안내(role=status)가 있다", async () => {
    const { user } = await unsupported();
    const form = await openEditor(user, 23);
    expect(within(form).getByLabelText("조건 질문")).toBeDisabled();
    expect(within(form).queryByRole("group", { name: "조건 답" })).toBeNull();
    const notes = within(form).getAllByRole("status").filter((n) => /지원하지 않는 조건/.test(n.textContent ?? ""));
    expect(notes.length).toBeGreaterThan(0);
  });

  it("다른 칸(중요도)만 고쳐 저장하면 show_if:null + show_if_unsupported:true 로 간다 — 서버의 모르는 조건을 지우지 않는다", async () => {
    const { user, calls } = await unsupported();
    const form = await openEditor(user, 23);
    await user.selectOptions(within(form).getByLabelText("중요도"), "높음");
    await user.click(save(form));
    await waitFor(() => expect(calls("reviseQuestion")).toHaveLength(1));
    expect(sent(calls).show_if).toBeNull();
    expect(sent(calls).show_if_unsupported).toBe(true);
    expect(sent(calls).importance).toBe("high");
  });

  it("저장한 뒤에도 카드는 여전히 ‘지원하지 않는 조건’ 이다 (사라지거나 ‘항상 보임’이 되지 않는다)", async () => {
    const { user, calls } = await unsupported();
    const form = await openEditor(user, 23);
    await user.selectOptions(within(form).getByLabelText("중요도"), "높음");
    await user.click(save(form));
    await waitFor(() => expect(calls("reviseQuestion")).toHaveLength(1));
    await waitFor(() => expect(item("q-23").querySelector('[data-show-if="unsupported"]')).not.toBeNull());
  });
});

describe("[F1] 빈 조건 · CLI 모양 조건 — 편집에서 유지", () => {
  it("빈 in:[] 조건: 문장만 바꿔도 저장할 수 있고 in:[] 이 그대로 간다 · 카드는 항상 숨김이라고 말한다", async () => {
    const { user, calls } = await boot({ questions: withQ23({ show_if: { question_id: "q-21", in: [] } }) });
    expect(item("q-23").textContent).toMatch(/질문 21의 조건 답이 비어 있어 항상 숨김/);
    const form = await openEditor(user, 23);
    await user.selectOptions(within(form).getByLabelText("중요도"), "높음");
    expect(save(form)).not.toHaveAttribute("aria-disabled", "true");
    await user.click(save(form));
    await waitFor(() => expect(calls("reviseQuestion")).toHaveLength(1));
    expect(sent(calls).show_if).toEqual({ question_id: "q-21", in: [] });
  });

  it("CLI 모양 {id, in, position}: 지원하는 조건으로 고칠 수 있고 값만 바꾸면 position 이 그대로 간다", async () => {
    const cli = { question_id: "scope", in: ["a", "b"], extra: { position: 0 } };
    const { user, calls } = await boot({ questions: withQ23({ show_if: cli }) });
    expect(item("q-23").querySelector('[data-show-if="unsupported"]')).toBeNull();
    const form = await openEditor(user, 23);
    expect(within(form).getByLabelText("조건 질문")).toBeEnabled();
    await user.click(within(group(form)).getByRole("checkbox", { name: "b" }));
    await user.click(save(form));
    await waitFor(() => expect(calls("reviseQuestion")).toHaveLength(1));
    expect(sent(calls).show_if).toEqual({ question_id: "scope", in: ["a"], extra: { position: 0 } });
  });

  it("CLI 모양: 문장만 바꿔 저장해도 조건이 그대로 간다", async () => {
    const cli = { question_id: "scope", in: ["a", "b"], extra: { position: 0 } };
    const { user, calls } = await boot({ questions: withQ23({ show_if: cli }) });
    const form = await openEditor(user, 23);
    await user.selectOptions(within(form).getByLabelText("중요도"), "높음");
    await user.click(save(form));
    await waitFor(() => expect(calls("reviseQuestion")).toHaveLength(1));
    expect(sent(calls).show_if).toEqual(cli);
  });
});
