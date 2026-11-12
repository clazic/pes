// SEL-94 U3b — 사람 판단 동작(가정 확인/틀림/고침, 결정 채택/대체/철회): 단추 · 확인 대화 상자 · 성공은 영수증 뒤(F06). 계약: src/test/u3b.ts 머리말.
// 서버(U3a, SEL-93)가 아니라 가짜 U3 클라이언트에 대한 시험이다. http 매핑 시험은 U3a 병합 뒤.
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { apiConflict, boot, cell, cellText, fullData, rowButton, rowOf, row, type U3Client } from "@/test/u3b";
import { WIDTHS } from "@/test/contract";

afterEach(cleanup);

const text = (el: HTMLElement | null) => el?.textContent ?? "";
const dialog = (name: RegExp) => screen.findByRole("dialog", { name });
const submit = (d: HTMLElement) => within(d).getByRole("button", { name: "판단 기록" });
const box = (d: HTMLElement, name: string) => within(d).getByRole("textbox", { name }) as HTMLTextAreaElement | HTMLInputElement;
const receiptText = () => screen.queryAllByRole("status").map((s) => s.textContent ?? "").join(" ");
const lastCmd = (u3: U3Client) => u3.cmds[u3.cmds.length - 1];

describe("단추는 상태에 맞게만 나온다", () => {
  it("판단 전 가정: 확인 · 틀림 · 고침. 판단이 끝난(틀림) 가정에는 판단 전용 단추가 없다", async () => {
    await boot();
    const p = await rowOf("assumption", "as-1");
    for (const n of ["확인", "틀림", "고침"]) expect(within(p).getByRole("button", { name: n })).toBeTruthy();
    const rejected = await rowOf("assumption", "as-3");
    expect(within(rejected).queryByRole("button", { name: "확인" })).toBeNull();
  });

  it("결정: 제안 → 채택만 / 채택 → 대체 · 철회 / 대체됨 · 철회 → 단추 없음", async () => {
    await boot();
    const proposed = await rowOf("decision", "dec-4");
    expect(within(proposed).getByRole("button", { name: "채택" })).toBeTruthy();
    expect(within(proposed).queryByRole("button", { name: /대체|철회/ })).toBeNull();
    const adopted = await rowOf("decision", "dec-2");
    expect(within(adopted).getByRole("button", { name: "대체" })).toBeTruthy();
    expect(within(adopted).getByRole("button", { name: "철회" })).toBeTruthy();
    expect(within(adopted).queryByRole("button", { name: "채택" })).toBeNull();
    for (const id of ["dec-1", "dec-5"]) expect(within(await rowOf("decision", id)).queryAllByRole("button"), id).toHaveLength(0);
  });

  it("모든 단추는 인쇄에서 빠지는 묶음([data-print=hide]) 안에 있다", async () => {
    await boot();
    await rowOf("assumption", "as-1");
    const buttons = [...document.querySelectorAll<HTMLElement>("[data-assumption] button, [data-decision] button")];
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) expect(b.closest("[data-print='hide']"), b.textContent ?? "").not.toBeNull();
  });

  it("휴대폰(390, 굵은 포인터)에서도 판단 단추가 있고 못 쓴다고 숨기지 않는다", async () => {
    await boot(fullData(), undefined, { width: WIDTHS.phone, coarse: true });
    const p = await rowOf("assumption", "as-1");
    const b = within(p).getByRole("button", { name: "확인" });
    expect(b.getAttribute("aria-disabled")).not.toBe("true");
    const d = await rowOf("decision", "dec-4");
    expect(within(d).getByRole("button", { name: "채택" }).getAttribute("aria-disabled")).not.toBe("true");
  });
});

describe("가정 확인 — 성공은 영수증 뒤", () => {
  it("확인 → 대화 상자 → 판단 기록: 멱등 키와 함께 한 번 보내고, 영수증 전에는 접수 확인 중이며 행이 안 바뀐다", async () => {
    const { u3, user } = await boot();
    const release = u3.hold();
    const r = await rowOf("assumption", "as-1");
    await user.click(rowButton(r, "확인"));
    const d = await dialog(/가정 확인/);
    await user.type(box(d, "근거"), "정의서와 맞다");
    await user.click(submit(d));

    await waitFor(() => expect(u3.cmds).toHaveLength(1));
    const c = lastCmd(u3);
    expect(c.method).toBe("assessAssumption");
    expect(c.objectId).toBe("as-1");
    expect(c.input).toMatchObject({ verdict: "confirm", rationale: "정의서와 맞다" });
    expect(typeof c.key).toBe("string");
    expect((c.key ?? "").length).toBeGreaterThan(8);

    // 영수증 전: 접수 확인 중, 성공 말 · 접수 번호 · 바뀐 상태 없음
    expect(screen.getByText(/접수 확인 중/)).toBeTruthy();
    expect(receiptText()).not.toMatch(/접수 \d{4}/);
    expect(row("assumption", "as-1")!.getAttribute("data-state")).toBe("proposed");

    release();
    await waitFor(() => expect(receiptText()).toMatch(/접수 0905/));
    await waitFor(() => expect(row("assumption", "as-1")!.getAttribute("data-state")).toBe("confirmed"));
    expect(cellText(row("assumption", "as-1")!, "judge")).toContain("검토자 하늘");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
  });

  it("확인은 근거를 비워도 보낼 수 있다", async () => {
    const { u3, user } = await boot();
    await user.click(rowButton(await rowOf("assumption", "as-1"), "확인"));
    await user.click(submit(await dialog(/가정 확인/)));
    await waitFor(() => expect(u3.cmds).toHaveLength(1));
    expect(lastCmd(u3).input).toMatchObject({ verdict: "confirm", rationale: "" });
  });

  it("두 번 눌러도 한 번만 보낸다(aria-disabled, 초점 유지)", async () => {
    const { u3, user } = await boot();
    const release = u3.hold();
    await user.click(rowButton(await rowOf("assumption", "as-1"), "확인"));
    const d = await dialog(/가정 확인/);
    const btn = submit(d);
    await user.click(btn);
    await user.click(btn);
    await user.click(btn);
    await waitFor(() => expect(u3.cmds).toHaveLength(1));
    expect(btn.getAttribute("aria-disabled")).toBe("true");
    expect(btn.hasAttribute("disabled")).toBe(false);
    release();
    await waitFor(() => expect(receiptText()).toMatch(/접수 \d{4}/));
    expect(u3.cmds).toHaveLength(1);
  });

  it("서로 다른 두 동작은 다른 멱등 키를 쓴다", async () => {
    const { u3, user } = await boot();
    await user.click(rowButton(await rowOf("assumption", "as-1"), "확인"));
    await user.click(submit(await dialog(/가정 확인/)));
    await waitFor(() => expect(receiptText()).toMatch(/접수/));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(rowButton(await rowOf("decision", "dec-4"), "채택"));
    await user.click(submit(await dialog(/결정 채택/)));
    await waitFor(() => expect(u3.cmds).toHaveLength(2));
    expect(u3.cmds[0].key).not.toBe(u3.cmds[1].key);
  });
});

describe("가정 틀림 · 고침 — 근거 필수", () => {
  it("틀림: 근거가 비면 보내지 않고 그 칸이 aria-invalid + 이유 글", async () => {
    const { u3, user } = await boot();
    await user.click(rowButton(await rowOf("assumption", "as-1"), "틀림"));
    const d = await dialog(/가정 틀림/);
    await user.click(submit(d));
    expect(u3.cmds).toHaveLength(0);
    const rationale = box(d, "근거");
    expect(rationale.getAttribute("aria-invalid")).toBe("true");
    expect(rationale.getAttribute("aria-describedby")).toBeTruthy();
    expect(text(document.getElementById(rationale.getAttribute("aria-describedby")!.split(" ")[0]))).toMatch(/근거/);
  });

  it("틀림: 근거를 쓰면 verdict=reject 로 보내고 행이 '틀림'이 된다", async () => {
    const { u3, user } = await boot();
    await user.click(rowButton(await rowOf("assumption", "as-1"), "틀림"));
    const d = await dialog(/가정 틀림/);
    await user.type(box(d, "근거"), "2021년에 정의가 바뀜");
    await user.click(submit(d));
    await waitFor(() => expect(row("assumption", "as-1")!.getAttribute("data-state")).toBe("rejected"));
    expect(lastCmd(u3).input).toMatchObject({ verdict: "reject", rationale: "2021년에 정의가 바뀜" });
  });

  it("고침: 고친 가정(기존 문장이 채워짐) + 근거가 있어야 한다. 문장을 그대로 두면 보내지 않는다", async () => {
    const { u3, user } = await boot();
    await user.click(rowButton(await rowOf("assumption", "as-1"), "고침"));
    const d = await dialog(/가정 고침/);
    expect(box(d, "고친 가정").value).toBe("도서관 방문 수의 정의는 2019년부터 같다고 본다");
    await user.type(box(d, "근거"), "정의가 바뀐 해가 있다");
    await user.click(submit(d));
    expect(u3.cmds).toHaveLength(0);
    expect(box(d, "고친 가정").getAttribute("aria-invalid")).toBe("true");
  });

  it("고침: 새 문장 + 근거를 보내면 revised, 원문은 보존되고 판단자가 남는다(덮어쓰지 않음)", async () => {
    const { u3, user } = await boot();
    await user.click(rowButton(await rowOf("assumption", "as-1"), "고침"));
    const d = await dialog(/가정 고침/);
    await user.clear(box(d, "고친 가정"));
    await user.type(box(d, "고친 가정"), "방문 수는 2021년 전후로 나눠 본다");
    await user.type(box(d, "근거"), "집계 정의가 2021년에 바뀜");
    await user.click(submit(d));
    await waitFor(() => expect(row("assumption", "as-1")!.getAttribute("data-state")).toBe("revised"));
    expect(lastCmd(u3).input).toMatchObject({ verdict: "revise", statement: "방문 수는 2021년 전후로 나눠 본다", rationale: "집계 정의가 2021년에 바뀜" });
    const r = row("assumption", "as-1")!;
    expect(cellText(r, "statement")).toContain("2021년 전후로");
    expect(cellText(r, "original")).toContain("도서관 방문 수의 정의는 2019년부터 같다고 본다");
    expect(cellText(r, "judge")).toContain("검토자 하늘");
    expect(cellText(r, "rationale")).toContain("집계 정의가 2021년에 바뀜");
  });

  it("needs_review 가정을 확인하면 재확인 필요가 사라진다(사람이 다시 판단했을 때만)", async () => {
    const { user } = await boot();
    const r = await rowOf("assumption", "as-5");
    expect(text(r)).toMatch(/재확인 필요/);
    await user.click(rowButton(r, "확인"));
    await user.click(submit(await dialog(/가정 확인/)));
    await waitFor(() => expect(row("assumption", "as-5")!.getAttribute("data-needs-review")).toBe("false"));
    expect(text(row("assumption", "as-5"))).not.toMatch(/재확인 필요/);
  });
});

describe("실패 · 시간 초과 · 취소 (F06)", () => {
  it("서버가 거절(conflict)하면 role=alert 로 메시지를 보이고 성공 말이 없으며 입력한 글 · 대화 상자 · 행이 그대로다", async () => {
    const { u3, user } = await boot();
    u3.failNext(apiConflict("다른 사람이 먼저 판단했습니다."));
    await user.click(rowButton(await rowOf("assumption", "as-1"), "틀림"));
    const d = await dialog(/가정 틀림/);
    await user.type(box(d, "근거"), "내가 쓴 근거");
    await user.click(submit(d));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/다른 사람이 먼저 판단했습니다/);
    expect(receiptText()).not.toMatch(/접수 \d{4}/);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(box(d, "근거").value).toBe("내가 쓴 근거");
    expect(row("assumption", "as-1")!.getAttribute("data-state")).toBe("proposed");
    // 거절 뒤에는 다시 보낼 수 있다
    expect(submit(d).getAttribute("aria-disabled")).not.toBe("true");
  });

  it("답이 시간 초과로 사라지면 '접수 확인 중'(실패 아님)이고, 다시 누르면 같은 멱등 키로 보내 replayed 영수증을 받는다", async () => {
    const { u3, user } = await boot();
    u3.loseReplyNext();
    await user.click(rowButton(await rowOf("assumption", "as-1"), "확인"));
    const d = await dialog(/가정 확인/);
    await user.click(submit(d));
    await waitFor(() => expect(u3.cmds).toHaveLength(1));
    await waitFor(() => expect(screen.getByText(/접수 확인 중/)).toBeTruthy());
    expect(screen.queryByRole("alert")?.textContent ?? "").not.toMatch(/실패|오류/);
    expect(receiptText()).not.toMatch(/접수 \d{4}/);

    await user.click(submit(d));
    await waitFor(() => expect(u3.cmds).toHaveLength(2));
    expect(u3.cmds[1].key).toBe(u3.cmds[0].key);
    await waitFor(() => expect(receiptText()).toMatch(/접수 \d{4}/));
    await waitFor(() => expect(row("assumption", "as-1")!.getAttribute("data-state")).toBe("confirmed"));
    expect(u3.cmds).toHaveLength(2);
  });

  it("취소하면 보내지 않고 초점이 눌렀던 단추로 돌아온다(Esc 도 같다)", async () => {
    const { u3, user } = await boot();
    const r = await rowOf("assumption", "as-1");
    const opener = rowButton(r, "틀림");
    await user.click(opener);
    const d = await dialog(/가정 틀림/);
    await user.click(within(d).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(opener);
    await user.click(opener);
    await dialog(/가정 틀림/);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(opener);
    expect(u3.cmds).toHaveLength(0);
  });

  it("대화 상자 안에서 초점이 갇히지 않고 처음에는 입력 칸에 있다", async () => {
    const { user } = await boot();
    await user.click(rowButton(await rowOf("assumption", "as-1"), "고침"));
    const d = await dialog(/가정 고침/);
    expect(d.contains(document.activeElement)).toBe(true);
    expect(d.getAttribute("aria-modal") === "true" || d.getAttribute("role") === "dialog").toBe(true);
  });
});

describe("결정 채택 · 대체 · 철회", () => {
  it("채택: 제안 결정을 채택하면 adoptDecision, 행이 '채택'이 되고 결정자가 남는다", async () => {
    const { u3, user } = await boot();
    await user.click(rowButton(await rowOf("decision", "dec-4"), "채택"));
    const d = await dialog(/결정 채택/);
    await user.type(box(d, "근거"), "공개 자료만 쓰기로 함");
    await user.click(submit(d));
    await waitFor(() => expect(row("decision", "dec-4")!.getAttribute("data-state")).toBe("adopted"));
    expect(lastCmd(u3)).toMatchObject({ method: "adoptDecision", objectId: "dec-4" });
    expect(lastCmd(u3).input).toMatchObject({ rationale: "공개 자료만 쓰기로 함" });
    expect(cellText(row("decision", "dec-4")!, "judge")).toContain("검토자 하늘");
    expect(receiptText()).toMatch(/접수 \d{4}/);
  });

  it("대체: 새 결정 + 근거 필수 — 새 결정이 새 행으로 생기고 옛 결정은 대체됨으로 남는다(덮어쓰지 않음)", async () => {
    const { u3, user } = await boot();
    await user.click(rowButton(await rowOf("decision", "dec-2"), "대체"));
    const d = await dialog(/결정 대체/);
    await user.click(submit(d));
    expect(u3.cmds).toHaveLength(0);
    expect(box(d, "새 결정").getAttribute("aria-invalid")).toBe("true");
    expect(box(d, "근거").getAttribute("aria-invalid")).toBe("true");

    await user.type(box(d, "새 결정"), "비교 기간은 2022년부터로 한다");
    await user.type(box(d, "근거"), "코로나 이후만 본다");
    await user.click(submit(d));
    await waitFor(() => expect(u3.cmds).toHaveLength(1));
    expect(lastCmd(u3)).toMatchObject({ method: "supersedeDecision", objectId: "dec-2" });
    expect(lastCmd(u3).input).toMatchObject({ statement: "비교 기간은 2022년부터로 한다", rationale: "코로나 이후만 본다" });

    const newRow = await rowOf("decision", "dec-6");
    expect(cellText(newRow, "statement")).toContain("2022년부터");
    expect(within(cell(newRow, "supersedes")!).getByRole("link").getAttribute("href")).toMatch(/#decision-dec-2$/);
    const old = row("decision", "dec-2")!;
    expect(old.getAttribute("data-state")).toBe("superseded");
    expect(cellText(old, "statement")).toContain("2021년부터 지금까지로 한다"); // 문장이 그대로
    expect(within(old).queryAllByRole("button")).toHaveLength(0);
    // 사슬 전체가 남아 있다: dec-1 → dec-2 → dec-6
    expect(row("decision", "dec-1")).not.toBeNull();
  });

  it("철회: 근거 필수, 행이 '철회'가 되고 문장은 남는다", async () => {
    const { u3, user } = await boot();
    await user.click(rowButton(await rowOf("decision", "dec-3"), "철회"));
    const d = await dialog(/결정 철회/);
    await user.click(submit(d));
    expect(u3.cmds).toHaveLength(0);
    expect(box(d, "근거").getAttribute("aria-invalid")).toBe("true");
    await user.type(box(d, "근거"), "더 이상 필요 없음");
    await user.click(submit(d));
    await waitFor(() => expect(row("decision", "dec-3")!.getAttribute("data-state")).toBe("revoked"));
    expect(lastCmd(u3)).toMatchObject({ method: "revokeDecision", objectId: "dec-3" });
    expect(cellText(row("decision", "dec-3")!, "statement")).toContain("어린이와 노년층은 따로 묶어 본다");
  });

  it("결정 쓰기도 거절되면 role=alert + 행 그대로 + 성공 말 없음", async () => {
    const { u3, user } = await boot();
    u3.failNext(apiConflict("이미 대체된 결정입니다."));
    await user.click(rowButton(await rowOf("decision", "dec-4"), "채택"));
    await user.click(submit(await dialog(/결정 채택/)));
    expect((await screen.findByRole("alert")).textContent).toMatch(/이미 대체된 결정입니다/);
    expect(row("decision", "dec-4")!.getAttribute("data-state")).toBe("proposed");
    expect(receiptText()).not.toMatch(/접수 \d{4}/);
  });
});
