// SEL-91 U2b — 질문 추가 · 철회 · 보류 · 합치기 · 순서 바꾸기(hard delete 없음) · 휴대폰 · 접근성 (Vitest, jsdom, 가짜 클라이언트).
// 계약: src/test/u2b.ts 머리말. 구현은 아직 없다 — 실패해야 정상(요구사항 때문에 실패).
import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { timeoutError } from "@/test/scripted-client";
import { aside, boot, chip, closedPanel, filterRadio, item, maybeItem, openOrder } from "@/test/u2b";

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
});

const tool = (name: string) => within(aside()).getByRole("button", { name });
type User = Awaited<ReturnType<typeof boot>>["user"];

async function openTidy(user: User, n: number) {
  await user.click(tool(`질문 ${n} 정리`));
  return within(aside()).getByRole("group", { name: `질문 ${n} 정리` });
}

describe("질문 더하기", () => {
  it("대화 상자: 문장 · 유형 · 방향 · 중요도 · 필수 · 도움말 칸이 있다", async () => {
    const { user } = await boot();
    await user.click(tool("질문 더하기"));
    const dlg = await screen.findByRole("dialog", { name: "질문 더하기" });
    for (const label of ["질문 문장", "유형", "방향", "중요도", "필수", "도움말"]) expect(within(dlg).getByLabelText(label)).toBeInTheDocument();
    expect(document.activeElement).toBe(within(dlg).getByLabelText("질문 문장"));
  });

  it("문장을 적고 추가하면 명령 한 번, 새 질문이 '사람'이 더한 것으로 보이고 답은 비어 있다", async () => {
    const { user, calls } = await boot();
    await user.click(tool("질문 더하기"));
    const dlg = await screen.findByRole("dialog", { name: "질문 더하기" });
    await user.type(within(dlg).getByLabelText("질문 문장"), "새로 더한 합성 질문입니다.");
    await user.click(within(dlg).getByRole("button", { name: "추가하기" }));
    await waitFor(() => expect(calls("addQuestion")).toHaveLength(1));
    const [slug, edition, stage, round, body, key] = calls("addQuestion")[0].args as [string, number, string, string, Record<string, unknown>, string];
    expect([slug, edition, stage, round]).toEqual(["sample-study", 1, "research", "2"]);
    expect(body).toMatchObject({ text: "새로 더한 합성 질문입니다.", kind: "free_text", direction: "ask_human", required: false });
    expect(key.length).toBeGreaterThan(8);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "질문 더하기" })).toBeNull());
    await waitFor(() => expect(openOrder()).toHaveLength(5));
    const added = maybeItem("q-30") as HTMLElement;
    expect(added.textContent).toContain("새로 더한 합성 질문입니다.");
    expect(added.textContent).toMatch(/사람/);
    expect((document.getElementById("q-30") as HTMLTextAreaElement).value).toBe("");
    expect(filterRadio("전체")).toHaveAccessibleName("전체 5");
  });

  it("문장이 비면 추가하기는 aria-disabled 이고 명령 0번", async () => {
    const { user, calls } = await boot();
    await user.click(tool("질문 더하기"));
    const dlg = await screen.findByRole("dialog", { name: "질문 더하기" });
    const add = within(dlg).getByRole("button", { name: "추가하기" });
    expect(add).toHaveAttribute("aria-disabled", "true");
    await user.click(add);
    expect(calls("addQuestion")).toHaveLength(0);
    expect(screen.getByRole("dialog", { name: "질문 더하기" })).toBeInTheDocument();
  });

  it("실패하면 대화 상자가 열린 채 글이 남고 오류가 읽힌다", async () => {
    const { user, calls, failNext } = await boot();
    await user.click(tool("질문 더하기"));
    const dlg = await screen.findByRole("dialog", { name: "질문 더하기" });
    await user.type(within(dlg).getByLabelText("질문 문장"), "글이 남아야 합니다");
    failNext(timeoutError());
    await user.click(within(dlg).getByRole("button", { name: "추가하기" }));
    expect(await within(dlg).findByRole("alert")).toBeInTheDocument();
    expect(within(dlg).getByLabelText("질문 문장")).toHaveValue("글이 남아야 합니다");
    await user.click(within(dlg).getByRole("button", { name: "추가하기" }));
    await waitFor(() => expect(calls("addQuestion")).toHaveLength(2));
    expect(calls("addQuestion")[0].args[5]).toBe(calls("addQuestion")[1].args[5]);
  });

  it("Esc 로 닫으면 초점이 '질문 더하기' 단추로 돌아오고 명령은 없다", async () => {
    const { user, calls } = await boot();
    await user.click(tool("질문 더하기"));
    await screen.findByRole("dialog", { name: "질문 더하기" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "질문 더하기" })).toBeNull());
    expect(document.activeElement).toBe(tool("질문 더하기"));
    expect(calls("addQuestion")).toHaveLength(0);
  });
});

describe("철회 · 보류 · 합치기 (지우지 않는다)", () => {
  it("질문 21 정리를 열면 철회 · 보류 · 합치기 단추가 보이고 '삭제'라는 단추는 어디에도 없다", async () => {
    const { user } = await boot();
    const group = await openTidy(user, 22);
    expect(tool("질문 22 정리")).toHaveAttribute("aria-expanded", "true");
    for (const name of ["철회", "보류", "합치기"]) expect(within(group).getByRole("button", { name })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /삭제|지우기$/ })).toBeNull();
  });

  it("철회: 대화 상자가 '지우지 않는다 · 보낸 답은 남는다'를 알리고, 확정하면 명령 한 번 → 정리된 질문으로 간다", async () => {
    const { user, calls } = await boot();
    const group = await openTidy(user, 23);
    await user.click(within(group).getByRole("button", { name: "철회" }));
    const dlg = await screen.findByRole("dialog", { name: "질문 23 철회" });
    expect(dlg.textContent).toMatch(/지우지 않/);
    expect(dlg.textContent).toMatch(/보낸 답은 (그대로 )?남/);
    expect(calls("withdrawQuestion")).toHaveLength(0);
    await user.click(within(dlg).getByRole("button", { name: "철회 확정" }));
    await waitFor(() => expect(calls("withdrawQuestion")).toHaveLength(1));
    const [slug, edition, id, key] = calls("withdrawQuestion")[0].args as [string, number, string, string];
    expect([slug, edition, id]).toEqual(["sample-study", 1, "q-23"]);
    expect(key.length).toBeGreaterThan(8);
    await waitFor(() => expect(openOrder()).toEqual(["q-21", "q-22", "q-24"]));
    const row = closedPanel().querySelector<HTMLElement>('[data-question="q-23"]') as HTMLElement;
    expect(row.dataset.status).toBe("withdrawn");
    expect(row.textContent).toMatch(/철회됨/);
    expect(row.querySelector("textarea,input")).toBeNull();
    expect(filterRadio("전체")).toHaveAccessibleName("전체 3");
  });

  it("보류: 같은 방식, 상태는 보류됨 — 철회됨과 다른 말", async () => {
    const { user, calls } = await boot();
    const group = await openTidy(user, 22);
    await user.click(within(group).getByRole("button", { name: "보류" }));
    const dlg = await screen.findByRole("dialog", { name: "질문 22 보류" });
    await user.click(within(dlg).getByRole("button", { name: "보류 확정" }));
    await waitFor(() => expect(calls("deferQuestion")).toHaveLength(1));
    await waitFor(() => expect(closedPanel().querySelector('[data-question="q-22"]')).not.toBeNull());
    const row = closedPanel().querySelector<HTMLElement>('[data-question="q-22"]') as HTMLElement;
    expect(row.dataset.status).toBe("deferred");
    expect(row.textContent).toMatch(/보류됨/);
    expect(row.textContent).not.toMatch(/철회됨/);
  });

  it("합치기: 합칠 질문 목록에 자기 자신이 없고, 확정하면 대상과 함께 명령 한 번", async () => {
    const { user, calls } = await boot();
    const group = await openTidy(user, 23);
    await user.click(within(group).getByRole("button", { name: "합치기" }));
    const dlg = await screen.findByRole("dialog", { name: "질문 23 합치기" });
    const select = within(dlg).getByLabelText("합칠 질문");
    const labels = within(select).getAllByRole("option").map((o) => o.textContent);
    expect(labels.some((t) => /질문 23\b/.test(t ?? ""))).toBe(false);
    expect(labels.some((t) => /질문 22\b/.test(t ?? ""))).toBe(true);
    // 합칠 대상을 고르기 전에는 확정할 수 없다
    expect(within(dlg).getByRole("button", { name: "합치기 확정" })).toHaveAttribute("aria-disabled", "true");
    await user.selectOptions(select, within(select).getAllByRole("option").find((o) => /질문 22\b/.test(o.textContent ?? "")) as HTMLElement);
    await user.click(within(dlg).getByRole("button", { name: "합치기 확정" }));
    await waitFor(() => expect(calls("mergeQuestion")).toHaveLength(1));
    const [slug, edition, id, into, key] = calls("mergeQuestion")[0].args as [string, number, string, string, string];
    expect([slug, edition, id, into]).toEqual(["sample-study", 1, "q-23", "q-22"]);
    expect(key.length).toBeGreaterThan(8);
    await waitFor(() => expect(closedPanel().querySelector('[data-question="q-23"]')?.getAttribute("data-status")).toBe("merged"));
    expect(closedPanel().querySelector('[data-question="q-23"]')?.textContent).toMatch(/질문 22/);
  });

  it("취소하면 명령 0번이고 질문은 그대로, 초점은 정리 단추로 돌아온다", async () => {
    const { user, calls } = await boot();
    const group = await openTidy(user, 23);
    await user.click(within(group).getByRole("button", { name: "철회" }));
    const dlg = await screen.findByRole("dialog", { name: "질문 23 철회" });
    await user.click(within(dlg).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "질문 23 철회" })).toBeNull());
    expect(calls("withdrawQuestion")).toHaveLength(0);
    expect(openOrder()).toEqual(["q-21", "q-22", "q-23", "q-24"]);
    expect(aside().contains(document.activeElement)).toBe(true);
  });

  it("확정을 두 번 눌러도 한 번만 보낸다", async () => {
    const { user, calls } = await boot();
    const group = await openTidy(user, 23);
    await user.click(within(group).getByRole("button", { name: "철회" }));
    const dlg = await screen.findByRole("dialog", { name: "질문 23 철회" });
    await user.dblClick(within(dlg).getByRole("button", { name: "철회 확정" }));
    await waitFor(() => expect(calls("withdrawQuestion").length).toBeGreaterThanOrEqual(1));
    expect(calls("withdrawQuestion")).toHaveLength(1);
  });

  it("실패하면 대화 상자가 열린 채 오류가 읽히고 질문은 그대로 열려 있다", async () => {
    const { user, calls, failNext } = await boot();
    const group = await openTidy(user, 23);
    await user.click(within(group).getByRole("button", { name: "철회" }));
    const dlg = await screen.findByRole("dialog", { name: "질문 23 철회" });
    failNext(timeoutError());
    await user.click(within(dlg).getByRole("button", { name: "철회 확정" }));
    expect(await within(dlg).findByRole("alert")).toBeInTheDocument();
    expect(calls("withdrawQuestion")).toHaveLength(1);
    // 모달이라 열려 있는 동안 뒤 화면은 접근성 트리에서 빠진다 — 닫은 뒤 질문이 그대로 열려 있는지 본다
    await user.click(within(dlg).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "질문 23 철회" })).toBeNull());
    expect(openOrder()).toContain("q-23");
  });

  it("대화 상자가 열려 있을 때 J/K 는 질문 이동이 아니다", async () => {
    const { user } = await boot();
    const group = await openTidy(user, 23);
    await user.click(within(group).getByRole("button", { name: "철회" }));
    await screen.findByRole("dialog", { name: "질문 23 철회" });
    await user.keyboard("jj");
    expect(document.activeElement?.closest("[data-question]")).toBeNull();
  });

  it("철회한 질문의 보낸 답은 정리된 질문에서도 남아 있다", async () => {
    const { user } = await boot({
      questions: [
        { id: "q-22", number: 22, version: 1, required: false, importance: "normal", source: "ai", text: "답이 있는 질문", kind: "free_text", options: [], status: "open", direction: "ask_human", sent: { answer: "남아야 하는 답", receipt_no: "0900", tx_id: "tx-900", committed_at: "2026-11-09T09:00:00+09:00" } },
        { id: "q-21", number: 21, version: 1, required: false, importance: "normal", source: "ai", text: "다른 질문", kind: "free_text", options: [], status: "open", direction: "ask_human" },
      ],
    });
    const group = await openTidy(user, 22);
    await user.click(within(group).getByRole("button", { name: "철회" }));
    const dlg = await screen.findByRole("dialog", { name: "질문 22 철회" });
    await user.click(within(dlg).getByRole("button", { name: "철회 확정" }));
    await waitFor(() => expect(closedPanel().querySelector('[data-question="q-22"]')).not.toBeNull());
    expect(closedPanel().querySelector('[data-question="q-22"]')?.textContent).toContain("남아야 하는 답");
  });
});

describe("순서 바꾸기", () => {
  const order = () => openOrder();

  it("위로 옮기기: 화면 순서가 바뀌고 열린 질문 전부의 새 순서가 한 번 간다", async () => {
    const { user, calls } = await boot();
    await user.click(tool("질문 22 위로 옮기기"));
    await waitFor(() => expect(calls("reorderQuestions")).toHaveLength(1));
    const [slug, edition, stage, round, ordered, key] = calls("reorderQuestions")[0].args as [string, number, string, string, string[], string];
    expect([slug, edition, stage, round]).toEqual(["sample-study", 1, "research", "2"]);
    expect(ordered).toEqual(["q-22", "q-21", "q-23", "q-24"]);
    expect(key.length).toBeGreaterThan(8);
    await waitFor(() => expect(order()).toEqual(["q-22", "q-21", "q-23", "q-24"]));
  });

  it("아래로 옮기기", async () => {
    const { user, calls } = await boot();
    await user.click(tool("질문 22 아래로 옮기기"));
    await waitFor(() => expect(order()).toEqual(["q-21", "q-23", "q-22", "q-24"]));
    expect(calls("reorderQuestions")[0].args[4]).toEqual(["q-21", "q-23", "q-22", "q-24"]);
  });

  it("맨 위의 위로 · 맨 아래의 아래로는 aria-disabled 이고 명령이 없다", async () => {
    const { user, calls } = await boot();
    expect(tool("질문 21 위로 옮기기")).toHaveAttribute("aria-disabled", "true");
    expect(tool("질문 24 아래로 옮기기")).toHaveAttribute("aria-disabled", "true");
    await user.click(tool("질문 21 위로 옮기기"));
    await user.click(tool("질문 24 아래로 옮기기"));
    expect(calls("reorderQuestions")).toHaveLength(0);
  });

  it("옮긴 뒤에도 같은 단추에 초점이 남아 연달아 옮길 수 있다", async () => {
    const { user, calls } = await boot();
    await user.click(tool("질문 24 위로 옮기기"));
    await waitFor(() => expect(order()).toEqual(["q-21", "q-22", "q-24", "q-23"]));
    expect(document.activeElement).toBe(tool("질문 24 위로 옮기기"));
    await user.keyboard("{Enter}");
    await waitFor(() => expect(order()).toEqual(["q-21", "q-24", "q-22", "q-23"]));
    expect(calls("reorderQuestions")).toHaveLength(2);
  });

  it("번호(질문 22)는 순서가 바뀌어도 그대로다", async () => {
    const { user } = await boot();
    await user.click(tool("질문 22 위로 옮기기"));
    await waitFor(() => expect(order()[0]).toBe("q-22"));
    expect(item("q-22").querySelector("h3")?.textContent).toMatch(/질문 22/);
    expect(chip("q-22", "version")?.textContent).toBe("버전 1");
  });
});

describe("휴대폰(폭<900 + 굵은 포인터)", () => {
  const phone = { width: 390, coarse: true };

  it("질문 도구는 aria-disabled + '데스크톱' 이유 글. 눌러도 form 이 열리지 않는다", async () => {
    const { user, calls } = await boot({}, undefined, phone);
    const edit = tool("질문 21 고치기");
    expect(edit).toHaveAttribute("aria-disabled", "true");
    const reason = edit.getAttribute("aria-describedby");
    expect(reason && document.getElementById(reason)?.textContent).toMatch(/데스크톱/);
    await user.click(edit);
    expect(within(aside()).queryByRole("form", { name: "질문 21 고치기" })).toBeNull();
    for (const name of ["질문 22 위로 옮기기", "질문 22 정리"]) {
      expect(tool(name)).toHaveAttribute("aria-disabled", "true");
      await user.click(tool(name));
    }
    expect(calls("reorderQuestions")).toHaveLength(0);
  });

  it("답 · 의견 쓰기와 필터는 휴대폰에서도 된다", async () => {
    const { user } = await boot({}, undefined, phone);
    await user.click(document.getElementById("q-24") as HTMLElement);
    await user.type(document.getElementById("q-24") as HTMLElement, "휴대폰에서 씀");
    expect((document.getElementById("q-24") as HTMLTextAreaElement).value).toBe("휴대폰에서 씀");
    await user.click(filterRadio("높음"));
    expect(openOrder()).toEqual(["q-21", "q-24"]);
  });

  it("폭만 좁고 포인터가 정밀하면(200% 확대) 도구가 켜져 있다", async () => {
    await boot({}, undefined, { width: 683, coarse: false });
    expect(tool("질문 21 고치기")).not.toHaveAttribute("aria-disabled", "true");
  });
});

describe("접근성", () => {
  it("모든 도구 단추가 읽는 이름을 가지고 아이콘 글자만으로 이름 짓지 않는다", async () => {
    await boot();
    for (const b of within(aside()).getAllByRole("button")) {
      const name = (b.getAttribute("aria-label") ?? b.textContent ?? "").trim();
      expect(name, `이름 없는 단추: ${b.outerHTML.slice(0, 80)}`).not.toBe("");
      expect(name).not.toMatch(/^[↑↓▲▼⋯…]+$/);
    }
  });

  it("필터는 radiogroup 이고 한 번에 하나만 선택되며 키보드로 초점이 닿는다", async () => {
    const { user } = await boot();
    const radios = within(aside()).getByRole("radiogroup", { name: "질문 거르기" });
    expect(within(radios).getAllByRole("radio").filter((r) => (r as HTMLInputElement).checked || r.getAttribute("aria-checked") === "true")).toHaveLength(1);
    let reached = false;
    for (let i = 0; i < 40 && !reached; i++) {
      await user.tab();
      reached = radios.contains(document.activeElement);
    }
    expect(reached).toBe(true);
  });

  it("질문 항목은 제목으로 이름이 붙은 묶음이고 초점을 받을 수 있다", async () => {
    await boot();
    for (const id of ["q-21", "q-22", "q-23", "q-24"]) {
      expect(item(id).getAttribute("tabindex")).toBe("-1");
      expect(item(id).querySelector("h3")?.textContent).toMatch(/^질문 \d+/);
    }
  });

  it("고치기 form 의 모든 칸에 label 이 있다", async () => {
    const { user } = await boot();
    await user.click(tool("질문 21 고치기"));
    const form = within(aside()).getByRole("form", { name: "질문 21 고치기" });
    for (const el of form.querySelectorAll("input,select,textarea")) {
      const labelled = (el as HTMLInputElement).labels?.length || el.getAttribute("aria-label") || el.getAttribute("aria-labelledby");
      expect(labelled, `label 없는 칸: ${el.outerHTML.slice(0, 80)}`).toBeTruthy();
    }
  });

  it("정리된 질문 영역은 region 이고 오류·철회 말이 색만으로 구분되지 않는다", async () => {
    await boot();
    const closed = closedPanel();
    expect(closed.textContent).toMatch(/철회됨/);
    expect(closed.textContent).toMatch(/보류됨/);
    expect(closed.textContent).toMatch(/합쳐짐/);
  });
});
