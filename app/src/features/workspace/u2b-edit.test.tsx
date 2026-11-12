// SEL-91 U2b — 인라인 고치기 · 저장 전 재확인 경고 · 새 버전 저장(옛 답 보존) · 오류 · 초안 보존 F04 (Vitest, jsdom, 가짜 클라이언트).
// 계약: src/test/u2b.ts 머리말. 구현은 아직 없다 — 실패해야 정상(요구사항 때문에 실패).
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { timeoutError } from "@/test/scripted-client";
import { aside, badge, boot, chip, editor, item, leaks, touchRound } from "@/test/u2b";

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
});
afterEach(() => vi.useRealTimers());

const openEditor = async (user: Awaited<ReturnType<typeof boot>>["user"], n: number) => {
  await user.click(within(aside()).getByRole("button", { name: `질문 ${n} 고치기` }));
  return editor(n);
};
const field = (form: HTMLElement, label: string) => within(form).getByLabelText(label);
const save = (form: HTMLElement) => within(form).getByRole("button", { name: "새 버전으로 저장" });

describe("인라인 고치기 열기", () => {
  it("질문 21 고치기 → form 이 그 항목 안에서 열리고 첫 칸(질문 문장)으로 초점", async () => {
    const { user } = await boot();
    const form = await openEditor(user, 21);
    expect(item("q-21").contains(form)).toBe(true);
    expect(document.activeElement).toBe(field(form, "질문 문장"));
    expect(within(aside()).getByRole("button", { name: "질문 21 고치기" })).toHaveAttribute("aria-expanded", "true");
  });

  it("지금 값이 칸에 채워져 있다: 문장 · 유형 · 선택지 · 중요도 · 필수 · 기본값 · 도움말 · 방향", async () => {
    const { user } = await boot();
    const form = await openEditor(user, 21);
    expect((field(form, "질문 문장") as HTMLInputElement | HTMLTextAreaElement).value).toContain("대출 수 자료의 정의가 2021년에 바뀌었어요");
    expect(field(form, "유형")).toHaveDisplayValue("하나 고르기");
    expect(field(form, "선택지 1")).toHaveValue("이어 보기");
    expect(field(form, "선택지 2")).toHaveValue("따로 보기");
    expect(field(form, "선택지 3")).toHaveValue("기타");
    expect(field(form, "중요도")).toHaveDisplayValue("높음");
    expect(field(form, "필수")).toBeChecked();
    expect(field(form, "기본값")).toHaveDisplayValue("따로 보기");
    expect((field(form, "도움말") as HTMLInputElement | HTMLTextAreaElement).value).toContain("정의 차이를 각주로");
    expect(field(form, "방향")).toHaveDisplayValue("AI가 사람에게 묻기");
  });

  it("show_if: 조건 질문과 조건 답이 지금 값으로 채워진다", async () => {
    const { user } = await boot();
    const form = await openEditor(user, 23);
    expect(field(form, "조건 질문")).toHaveDisplayValue("질문 21");
    // SEL-129: 조건 답은 select 가 아니라 checkbox 묶음 — 지금 조건의 값(이어 보기)만 켜져 있다
    const answers = within(form).getByRole("group", { name: "조건 답" });
    expect(within(answers).getByRole("checkbox", { name: "이어 보기" })).toBeChecked();
    expect(within(answers).getByRole("checkbox", { name: "따로 보기" })).not.toBeChecked();
  });

  it("조건 질문을 '항상 보임'으로 두면 조건 답 칸이 사라진다", async () => {
    const { user } = await boot();
    const form = await openEditor(user, 23);
    await user.selectOptions(field(form, "조건 질문"), "항상 보임");
    expect(within(form).queryByLabelText("조건 답")).toBeNull();
  });

  it("글로 답하기 유형에는 선택지 칸이 없고, 유형을 바꾸면 나타난다", async () => {
    const { user } = await boot();
    const form = await openEditor(user, 22);
    expect(within(form).queryByLabelText(/^선택지 \d/)).toBeNull();
    await user.selectOptions(field(form, "유형"), "하나 고르기");
    expect(within(form).getAllByLabelText(/^선택지 \d/).length).toBeGreaterThanOrEqual(2);
  });

  it("취소: form 이 닫히고 초점이 '질문 21 고치기' 단추로 돌아온다. 명령은 0번", async () => {
    const { user, calls } = await boot();
    await openEditor(user, 21);
    await user.click(within(editor(21)).getByRole("button", { name: "취소" }));
    expect(within(aside()).queryByRole("form", { name: "질문 21 고치기" })).toBeNull();
    expect(document.activeElement).toBe(within(aside()).getByRole("button", { name: "질문 21 고치기" }));
    expect(calls("reviseQuestion")).toHaveLength(0);
  });

  it("고치지 않은 form 은 Esc 로 닫히고 초점이 돌아온다", async () => {
    const { user } = await boot();
    await openEditor(user, 21);
    await user.keyboard("{Escape}");
    expect(within(aside()).queryByRole("form", { name: "질문 21 고치기" })).toBeNull();
    expect(document.activeElement).toBe(within(aside()).getByRole("button", { name: "질문 21 고치기" }));
  });

  it("form 안에서 J/K 는 글자다(질문 이동 아님)", async () => {
    const { user } = await boot();
    const form = await openEditor(user, 21);
    const help = field(form, "도움말") as HTMLInputElement;
    await user.clear(help);
    await user.type(help, "jk");
    expect(help.value).toBe("jk");
    expect(document.activeElement).toBe(help);
  });
});

describe("저장 전 '재확인 필요' 경고", () => {
  const warn = (form: HTMLElement) => form.querySelector<HTMLElement>('[data-warning="recheck"]');

  it("열기만 해서는 경고가 없고, 문장을 고치면 경고가 뜬다 (저장 전 · 명령 0번)", async () => {
    const { user, calls } = await boot();
    const form = await openEditor(user, 22);
    expect(warn(form)).toBeNull();
    await user.type(field(form, "질문 문장"), " (보태 씀)");
    const w = warn(form) as HTMLElement;
    expect(w).not.toBeNull();
    expect(w.textContent).toMatch(/재확인 필요/);
    expect(w.textContent).toMatch(/옛 답.*(보존|그대로 남)/);
    expect(w.getAttribute("role")).toBe("status");
    expect(calls("reviseQuestion")).toHaveLength(0);
  });

  it("유형을 바꾸거나 선택지를 고쳐도 경고가 뜬다", async () => {
    const { user } = await boot();
    const form = await openEditor(user, 21);
    expect(warn(form)).toBeNull();
    await user.clear(field(form, "선택지 2"));
    await user.type(field(form, "선택지 2"), "나눠 보기");
    expect(warn(form)).not.toBeNull();
    await user.clear(field(form, "선택지 2"));
    await user.type(field(form, "선택지 2"), "따로 보기");
    expect(warn(form), "원래 값으로 되돌리면 경고가 사라진다").toBeNull();
    await user.selectOptions(field(form, "유형"), "여러 개 고르기");
    expect(warn(form)).not.toBeNull();
  });

  it("중요도 · 필수 · 기본값 · 조건 · 도움말 · 방향만 고치면 경고가 없다", async () => {
    const { user } = await boot();
    const form = await openEditor(user, 21);
    await user.selectOptions(field(form, "중요도"), "낮음");
    await user.click(field(form, "필수"));
    await user.selectOptions(field(form, "기본값"), "없음");
    await user.type(field(form, "도움말"), " 덧붙임");
    await user.selectOptions(field(form, "방향"), "사람이 AI에게 묻기");
    expect(warn(form)).toBeNull();
  });
});

describe("중요도와 필수는 독립이다 (사례 2개)", () => {
  it("사례 1: 중요도만 높음으로 — 필수는 그대로 아니다", async () => {
    const { user, calls } = await boot();
    const form = await openEditor(user, 22);
    expect(field(form, "필수")).not.toBeChecked();
    await user.selectOptions(field(form, "중요도"), "높음");
    expect(field(form, "필수")).not.toBeChecked();
    await user.click(save(form));
    await waitFor(() => expect(calls("reviseQuestion")).toHaveLength(1));
    const body = calls("reviseQuestion")[0].args[3] as Record<string, unknown>;
    expect(body.importance).toBe("high");
    expect(body.required).toBe(false);
    await waitFor(() => expect(chip("q-22", "importance")?.textContent).toMatch(/높음/));
    expect(chip("q-22", "required")).toBeNull();
    expect(badge("q-22", "recheck"), "의미가 안 바뀌면 재확인 배지 없음").toBeNull();
  });

  it("사례 2: 필수만 켠다 — 중요도는 그대로 보통", async () => {
    const { user, calls } = await boot();
    const form = await openEditor(user, 22);
    await user.click(field(form, "필수"));
    expect(field(form, "중요도")).toHaveDisplayValue("보통");
    await user.click(save(form));
    await waitFor(() => expect(calls("reviseQuestion")).toHaveLength(1));
    const body = calls("reviseQuestion")[0].args[3] as Record<string, unknown>;
    expect(body.required).toBe(true);
    expect(body.importance).toBe("normal");
    await waitFor(() => expect(chip("q-22", "required")?.textContent).toBe("필수"));
    expect(chip("q-22", "importance")?.textContent).toMatch(/보통/);
  });
});

describe("저장 = 새 버전 명령", () => {
  it("문장을 고쳐 저장: 명령 한 번(base_version 과 멱등 키), 성공 안내, 새 버전·재확인 필요·옛 답 보존", async () => {
    const { user, calls } = await boot();
    const form = await openEditor(user, 22);
    const text = field(form, "질문 문장") as HTMLTextAreaElement | HTMLInputElement;
    await user.clear(text);
    await user.type(text, "더 깊이 볼 출처를 한 가지만 알려 주세요.");
    await user.click(save(form));
    await waitFor(() => expect(calls("reviseQuestion")).toHaveLength(1));
    const [slug, edition, id, body, key] = calls("reviseQuestion")[0].args as [string, number, string, Record<string, unknown>, string];
    expect([slug, edition, id]).toEqual(["sample-study", 1, "q-22"]);
    expect(body).toMatchObject({ base_version: 1, text: "더 깊이 볼 출처를 한 가지만 알려 주세요.", kind: "free_text", required: false, importance: "normal", direction: "ask_human" });
    expect(typeof key).toBe("string");
    expect(key.length).toBeGreaterThan(8);
    const status = await within(aside()).findByText(/새 버전/);
    expect(status.closest("[role=status]")?.textContent).toMatch(/접수 \d{4}/);
    expect(status.closest("[role=status]")?.textContent).toMatch(/옛 답/);
    await waitFor(() => expect(chip("q-22", "version")?.textContent).toBe("버전 2"));
    expect(badge("q-22", "recheck")?.textContent).toBe("재확인 필요");
    expect(item("q-22").textContent).toContain("더 깊이 볼 출처를 한 가지만");
    expect(within(aside()).queryByRole("form", { name: "질문 22 고치기" })).toBeNull();
  });

  it("보낸 답이 있던 질문을 고치면 옛 답은 보존되어 '옛 답 있음'으로 보이고, 새 답 칸은 비어 있다 (자동 승계 없음)", async () => {
    const { user, calls } = await boot({
      questions: [
        { id: "q-22", number: 22, version: 1, required: false, importance: "normal", source: "ai", text: "답이 있던 질문", kind: "free_text", options: [], status: "open", direction: "ask_human", sent: { answer: "처음 보낸 답", receipt_no: "0301", tx_id: "tx-301", committed_at: "2026-11-09T09:00:00+09:00" } },
      ],
    });
    const form = await openEditor(user, 22);
    await user.type(field(form, "질문 문장"), " (바뀐 문구)");
    await user.click(save(form));
    await waitFor(() => expect(calls("reviseQuestion")).toHaveLength(1));
    await waitFor(() => expect(badge("q-22", "old-answer")?.textContent).toBe("옛 답 있음"));
    expect(item("q-22").querySelector('[data-field-kind="answer"]'), "새 버전에는 보낸 답이 없다").toBeNull();
    const box = document.getElementById("q-22") as HTMLTextAreaElement;
    expect(box.value).toBe("");
    await user.click(within(item("q-22")).getByRole("button", { name: /옛 답 보기/ }));
    expect(item("q-22").querySelector('[data-field-kind="old-answer"]')?.textContent).toContain("처음 보낸 답");
  });

  it("선택지를 더하고 지우고 저장하면 그 선택지 목록이 간다", async () => {
    const { user, calls } = await boot();
    const form = await openEditor(user, 21);
    await user.click(within(form).getByRole("button", { name: "선택지 더하기" }));
    await user.type(field(form, "선택지 4"), "함께 보기");
    await user.click(within(form).getByRole("button", { name: "선택지 2 지우기" }));
    await user.click(save(form));
    await waitFor(() => expect(calls("reviseQuestion")).toHaveLength(1));
    const body = calls("reviseQuestion")[0].args[3] as { options: { id: string; label: string }[]; default_value: string | null };
    expect(body.options.map((o) => o.label)).toEqual(["이어 보기", "기타", "함께 보기"]);
    // 지운 선택지가 기본값이던 경우 기본값은 비워진다(없는 선택지를 가리키지 않는다)
    expect(body.default_value === null || body.options.some((o) => o.id === body.default_value)).toBe(true);
  });

  it("기본값 없음 · show_if 해제 · 방향 바꾸기가 그대로 간다", async () => {
    const { user, calls } = await boot();
    const form = await openEditor(user, 23);
    await user.selectOptions(field(form, "조건 질문"), "항상 보임");
    await user.selectOptions(field(form, "방향"), "사람이 AI에게 묻기");
    await user.click(save(form));
    await waitFor(() => expect(calls("reviseQuestion")).toHaveLength(1));
    const body = calls("reviseQuestion")[0].args[3] as Record<string, unknown>;
    expect(body.show_if).toBeNull();
    expect(body.direction).toBe("ask_ai");
  });

  it("show_if 를 질문과 답으로 새로 건다", async () => {
    const { user, calls } = await boot();
    const form = await openEditor(user, 22);
    await user.selectOptions(field(form, "조건 질문"), "질문 21");
    await user.click(within(within(form).getByRole("group", { name: "조건 답" })).getByRole("checkbox", { name: "따로 보기" }));
    await user.click(save(form));
    await waitFor(() => expect(calls("reviseQuestion")).toHaveLength(1));
    expect((calls("reviseQuestion")[0].args[3] as { show_if: unknown }).show_if).toEqual({ question_id: "q-21", in: ["split"] });
  });

  it("문장이 비면 저장할 수 없다: aria-disabled + 이유 글 · 명령 0번", async () => {
    const { user, calls } = await boot();
    const form = await openEditor(user, 22);
    await user.clear(field(form, "질문 문장"));
    const btn = save(form);
    expect(btn).toHaveAttribute("aria-disabled", "true");
    const reason = btn.getAttribute("aria-describedby");
    expect(reason && document.getElementById(reason)?.textContent).toMatch(/문장/);
    await user.click(btn);
    expect(calls("reviseQuestion")).toHaveLength(0);
  });

  it("선택지 유형인데 선택지가 2개 미만이면 저장할 수 없다", async () => {
    const { user, calls } = await boot();
    const form = await openEditor(user, 22);
    await user.selectOptions(field(form, "유형"), "하나 고르기");
    const btn = save(form);
    expect(btn).toHaveAttribute("aria-disabled", "true");
    await user.click(btn);
    expect(calls("reviseQuestion")).toHaveLength(0);
  });

  it("바꾼 것이 없으면 저장 단추가 aria-disabled (같은 내용으로 새 버전을 만들지 않는다)", async () => {
    const { user, calls } = await boot();
    const form = await openEditor(user, 22);
    expect(save(form)).toHaveAttribute("aria-disabled", "true");
    await user.click(save(form));
    expect(calls("reviseQuestion")).toHaveLength(0);
  });

  it("두 번 눌러도 한 번만 보낸다", async () => {
    const { user, calls } = await boot();
    const form = await openEditor(user, 22);
    await user.type(field(form, "도움말"), "도움말 보탬");
    await user.dblClick(save(form));
    await waitFor(() => expect(calls("reviseQuestion").length).toBeGreaterThanOrEqual(1));
    expect(calls("reviseQuestion")).toHaveLength(1);
  });
});

describe("저장이 거절·실패해도", () => {
  it("충돌(conflict): form 이 열린 채 입력이 남고 오류 문장이 role=alert 로 읽힌다. '새 버전 저장됨' 안내는 없다", async () => {
    const { user, calls, mutate } = await boot();
    const form = await openEditor(user, 22);
    await user.type(field(form, "질문 문장"), " 내가 쓴 글");
    mutate((qs) => {
      const q = qs.find((x) => x.id === "q-22");
      if (q) q.version = 7; // 다른 곳에서 먼저 바뀜
    });
    await user.click(save(form));
    const alert = await within(editor(22)).findByRole("alert");
    expect(alert.textContent).toMatch(/먼저 바뀌|처리할 수 없|바뀌/);
    expect(calls("reviseQuestion")).toHaveLength(1);
    expect((field(editor(22), "질문 문장") as HTMLInputElement | HTMLTextAreaElement).value).toContain("내가 쓴 글");
    expect(within(aside()).queryByText(/새 버전으로 저장했/)).toBeNull();
    expect(leaks(aside())).toEqual([]);
  });

  it("연결 실패(시간 초과): 입력이 남고, 다시 누르면 같은 멱등 키로 보낸다", async () => {
    const { user, calls, failNext } = await boot();
    const form = await openEditor(user, 22);
    await user.type(field(form, "도움말"), "도움말 보탬");
    failNext(timeoutError());
    await user.click(save(form));
    await waitFor(() => expect(calls("reviseQuestion")).toHaveLength(1));
    expect(await within(editor(22)).findByRole("alert")).toBeInTheDocument();
    expect((field(editor(22), "도움말") as HTMLInputElement | HTMLTextAreaElement).value).toContain("도움말 보탬");
    await user.click(save(editor(22)));
    await waitFor(() => expect(calls("reviseQuestion")).toHaveLength(2));
    const keys = calls("reviseQuestion").map((c) => c.args[4]);
    expect(keys[0]).toBe(keys[1]);
  });

  it("저장 성공 뒤 같은 항목을 다시 고치면 새 멱등 키다", async () => {
    const { user, calls } = await boot();
    let form = await openEditor(user, 22);
    await user.type(field(form, "도움말"), "하나");
    await user.click(save(form));
    await waitFor(() => expect(chip("q-22", "version")?.textContent).toBe("버전 2"));
    form = await openEditor(user, 22);
    await user.type(field(form, "도움말"), "둘");
    await user.click(save(form));
    await waitFor(() => expect(calls("reviseQuestion")).toHaveLength(2));
    const keys = calls("reviseQuestion").map((c) => c.args[4]);
    expect(keys[0]).not.toBe(keys[1]);
    expect((calls("reviseQuestion")[1].args[3] as { base_version: number }).base_version).toBe(2);
  });
});

describe("초안(F04): 갱신이 와도 입력을 지우지 않는다", () => {
  const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

  async function bootFake() {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    return boot();
  }

  it("다른 질문이 바뀐 갱신이 와도 쓰던 답 칸은 같은 노드 · 값 · 초점 · 선택 범위", async () => {
    const { user, mutate, s } = await bootFake();
    const box = document.getElementById("q-24") as HTMLTextAreaElement;
    await user.click(box);
    await user.type(box, "쓰는 중인 글");
    box.setSelectionRange(1, 3);
    mutate((qs) => {
      const q = qs.find((x) => x.id === "q-22");
      if (q) q.text = `${q.text as string} (갱신 표식)`;
    });
    s.queueChanges(touchRound());
    await advance(8_000);
    await waitFor(() => expect(item("q-22").textContent).toContain("(갱신 표식)"));
    expect(document.getElementById("q-24")).toBe(box);
    expect(box.value).toBe("쓰는 중인 글");
    expect(document.activeElement).toBe(box);
    expect([box.selectionStart, box.selectionEnd]).toEqual([1, 3]);
  });

  it("고치기 form 에 쓰던 글도 갱신이 와도 남는다 (같은 form · 같은 칸 · 초점)", async () => {
    const { user, mutate, s } = await bootFake();
    const form = await openEditor(user, 22);
    const help = field(form, "도움말") as HTMLInputElement;
    await user.type(help, "쓰던 도움말");
    mutate((qs) => {
      const q = qs.find((x) => x.id === "q-24");
      if (q) q.text = `${q.text as string} (갱신 표식)`;
    });
    s.queueChanges(touchRound());
    await advance(8_000);
    await waitFor(() => expect(item("q-24").textContent).toContain("(갱신 표식)"));
    expect(editor(22)).toBe(form);
    expect(field(form, "도움말")).toBe(help);
    expect(help.value).toBe("쓰던 도움말");
    expect(document.activeElement).toBe(help);
  });

  it("같은 질문이 다른 곳에서 새 버전이 되어도 고치는 중인 글은 지워지지 않는다 (저장하면 충돌로 거절될 뿐)", async () => {
    const { user, mutate, s, calls } = await bootFake();
    const form = await openEditor(user, 22);
    await user.type(field(form, "질문 문장"), " 내 글");
    mutate((qs) => {
      const q = qs.find((x) => x.id === "q-22");
      if (q) {
        q.version = 2;
        q.text = "다른 사람이 고친 문장";
      }
    });
    s.queueChanges(touchRound());
    await advance(8_000);
    await waitFor(() => expect(chip("q-22", "version")?.textContent).toBe("버전 2"));
    expect((field(editor(22), "질문 문장") as HTMLInputElement | HTMLTextAreaElement).value).toContain("내 글");
    expect(calls("reviseQuestion")).toHaveLength(0);
  });

  it("추가·순서 바꾸기로 폼 버전이 올라가도(질문 버전은 그대로) 쓰던 답 · 의견 초안이 남는다", async () => {
    const { user, mutate, s } = await bootFake();
    const box = document.getElementById("q-24") as HTMLTextAreaElement;
    const op = document.getElementById("q-24-opinion") as HTMLTextAreaElement;
    await user.click(box);
    await user.type(box, "답 초안");
    await user.click(op);
    await user.type(op, "의견 초안");
    mutate((qs) => {
      qs.reverse();
    });
    s.queueChanges(touchRound());
    await advance(8_000);
    await waitFor(() => expect((document.getElementById("q-24") as HTMLTextAreaElement).value).toBe("답 초안"));
    expect((document.getElementById("q-24-opinion") as HTMLTextAreaElement).value).toBe("의견 초안");
  });

  it("질문이 새 버전이 되면 옛 버전 초안은 몰래 옮기지 않고 검토를 청한다 (U1c 계약 유지)", async () => {
    const { user, mutate, s } = await bootFake();
    const box = document.getElementById("q-22") as HTMLTextAreaElement;
    await user.click(box);
    await user.type(box, "옛 버전에 쓴 초안");
    mutate((qs) => {
      const q = qs.find((x) => x.id === "q-22");
      if (q) {
        q.version = 2;
        q.needs_recheck = true;
      }
    });
    s.queueChanges(touchRound());
    await advance(8_000);
    await waitFor(() => expect(chip("q-22", "version")?.textContent).toBe("버전 2"));
    expect((document.getElementById("q-22") as HTMLTextAreaElement).value).toBe("");
    expect(item("q-22").querySelector("[data-draft-review]")?.textContent).toContain("옛 버전에 쓴 초안");
  });

  it("한글 조합 중 입력은 고치기 form 에서도 갱신에 지워지지 않는다", async () => {
    const { user, mutate, s } = await bootFake();
    const form = await openEditor(user, 22);
    const help = field(form, "도움말") as HTMLInputElement;
    await user.click(help);
    fireEvent.compositionStart(help);
    fireEvent.change(help, { target: { value: "한ㄱ" } });
    mutate((qs) => {
      const q = qs.find((x) => x.id === "q-24");
      if (q) q.text = `${q.text as string} (갱신 표식)`;
    });
    s.queueChanges(touchRound());
    await advance(8_000);
    await waitFor(() => expect(item("q-24").textContent).toContain("(갱신 표식)"));
    expect(help.value).toBe("한ㄱ");
    fireEvent.change(help, { target: { value: "한글" } });
    fireEvent.compositionEnd(help);
    expect(help.value).toBe("한글");
    expect(screen.getByRole("main")).toBeInTheDocument();
  });
});
