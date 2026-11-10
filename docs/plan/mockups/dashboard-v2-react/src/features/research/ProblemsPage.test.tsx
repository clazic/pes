import { act, fireEvent, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { mockSettings } from "@/lib/mock-settings";
import { researchUi } from "@/lib/research-ui";
import { setViewport } from "@/test/render-app";
import { renderWorkspacePage } from "@/test/render-page";
import { ProblemsPage } from "@/features/research/ProblemsPage";

/** UI7-2 동작 보존 — 막힌 것 보드: 주소 해시 #pb-<번호>가 그 카드를 펼치고, 거르기 탭이 목록을 바꾼다 */

const URL = "/p/dolbom-insight/problems";

beforeEach(() => {
  sessionStorage.clear();
  mockSettings.reset();
  researchUi.set({ focus: false, aiPanel: false, aiOnRound: false });
  setViewport(1440);
});

async function ready(hash = "") {
  const view = await renderWorkspacePage(ProblemsPage, "problems", URL + hash);
  await screen.findByText("막힌 것·풀 것", {}, { timeout: 4000 });
  await screen.findAllByRole("article", {}, { timeout: 4000 });
  return view;
}
const card = (id: string) => document.getElementById(`pb-${id}`) as HTMLElement;
const toggle = (id: string) => within(card(id)).getByRole("button", { name: /풀기|자세히|접기/ });
const openIds = () => screen.getAllByRole("article").filter((a) => within(a).getByRole("button", { name: /풀기|자세히|접기/ }).getAttribute("aria-expanded") === "true").map((a) => a.id);

describe("막힌 것 보드 펼침", () => {
  it("해시가 없으면 아무 카드도 펼쳐지지 않는다", async () => {
    await ready();
    expect(screen.getAllByRole("article").length).toBeGreaterThan(2);
    expect(openIds()).toEqual([]);
  });

  it("#pb-<번호>로 들어오면 그 카드만 처음부터 펼쳐져 있다", async () => {
    await ready("#pb-p-v1");
    expect(openIds()).toEqual(["pb-p-v1"]);
    expect(toggle("p-v1")).toHaveAccessibleName(/접기/);
    expect(toggle("p-w1")).toHaveAttribute("aria-expanded", "false");
  });

  it("해시가 다른 카드로 바뀌면 펼침이 그 카드로 옮겨 간다", async () => {
    const view = await ready("#pb-p-v1");
    expect(openIds()).toEqual(["pb-p-v1"]);
    await act(async () => {
      await view.router.navigate(`${URL}#pb-p-c1`);
    });
    expect(openIds()).toEqual(["pb-p-c1"]);
  });

  it("사람이 누르면 펼치고 다시 누르면 접는다 — 한 번에 하나만 펼쳐진다", async () => {
    await ready();
    fireEvent.click(toggle("p-w1"));
    expect(openIds()).toEqual(["pb-p-w1"]);
    fireEvent.click(toggle("p-v1"));
    expect(openIds()).toEqual(["pb-p-v1"]);
    fireEvent.click(toggle("p-v1"));
    expect(openIds()).toEqual([]);
  });

  it("사람이 접은 카드는 같은 해시로 다시 그려도 저절로 펼쳐지지 않는다", async () => {
    const view = await ready("#pb-p-v1");
    fireEvent.click(toggle("p-v1"));
    expect(openIds()).toEqual([]);
    await act(async () => {
      await view.router.navigate(`${URL}#pb-p-v1`, { replace: true });
    });
    expect(openIds()).toEqual([]);
  });

  it("해시 번호가 없는 카드를 가리키면 아무것도 펼치지 않는다", async () => {
    await ready("#pb-없는번호");
    expect(openIds()).toEqual([]);
  });
});

describe("막힌 것 거르기 탭", () => {
  const tab = (name: RegExp) => screen.getByRole("tab", { name });

  it("처음엔 전체이고, 연구 내용 · 진행 탭이 목록을 나눈다(합이 전체)", async () => {
    await ready();
    expect(tab(/^전체/).getAttribute("aria-selected")).toBe("true");
    const all = screen.getAllByRole("article").map((a) => a.id);
    fireEvent.mouseDown(tab(/^연구 내용/));
    const content = screen.getAllByRole("article").map((a) => a.id);
    fireEvent.mouseDown(tab(/^진행/));
    const progress = screen.getAllByRole("article").map((a) => a.id);
    expect(content.length).toBeGreaterThan(0);
    expect(progress.length).toBeGreaterThan(0);
    expect([...content, ...progress].sort()).toEqual([...all].sort());
    fireEvent.mouseDown(tab(/^전체/));
    expect(screen.getAllByRole("article").map((a) => a.id)).toEqual(all);
  });

  it("거르기 숫자는 탭 이름에 있는 수와 같다", async () => {
    await ready();
    fireEvent.mouseDown(tab(/^연구 내용/));
    const n = Number(/(\d+)\s*$/.exec(tab(/^연구 내용/).textContent ?? "")?.[1]);
    expect(screen.getAllByRole("article").length).toBe(n);
  });
});
