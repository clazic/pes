import { act, fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { mockSettings } from "@/lib/mock-settings";
import { setViewport } from "@/test/render-app";
import { renderBarePage } from "@/test/render-page";
import { UsagePage } from "@/features/usage/UsagePage";

/** UI7-2 동작 보존 — 사용량 화면 탭: 주소 해시 #ops는 “웹 운영 한도” 탭, 다른 해시는 “API 사용량” 탭 */

beforeEach(() => {
  sessionStorage.clear();
  mockSettings.reset();
  setViewport(1440);
});

const TAB_API = /^API 사용량$/;
const TAB_OPS = /^웹 운영 한도/;
const selected = async (name: RegExp) => (await screen.findByRole("tab", { name }, { timeout: 4000 })).getAttribute("aria-selected") === "true";

describe("사용량 화면 탭 ↔ 주소 해시", () => {
  it("해시가 없으면 API 사용량 탭이 열린다", async () => {
    await renderBarePage(UsagePage, "usage", "/usage");
    expect(await selected(TAB_API)).toBe(true);
    expect(await selected(TAB_OPS)).toBe(false);
  });

  it("#ops로 들어오면 웹 운영 한도 탭이 처음부터 열린다", async () => {
    await renderBarePage(UsagePage, "usage", "/usage#ops");
    expect(await selected(TAB_OPS)).toBe(true);
    expect(await selected(TAB_API)).toBe(false);
  });

  it("다른 해시(#connections)는 API 사용량 탭이다", async () => {
    await renderBarePage(UsagePage, "usage", "/usage#connections");
    expect(await selected(TAB_API)).toBe(true);
  });

  it("해시가 #ops로 바뀌면 웹 운영 탭으로 가고, 다른 해시로 바뀌면 API 탭으로 돌아온다", async () => {
    const view = await renderBarePage(UsagePage, "usage", "/usage");
    expect(await selected(TAB_API)).toBe(true);
    await act(async () => {
      await view.router.navigate("/usage#ops");
    });
    expect(await selected(TAB_OPS)).toBe(true);
    await act(async () => {
      await view.router.navigate("/usage#connections");
    });
    expect(await selected(TAB_API)).toBe(true);
  });

  it("해시를 지우면(빈 해시) 지금 탭을 그대로 둔다", async () => {
    const view = await renderBarePage(UsagePage, "usage", "/usage#ops");
    expect(await selected(TAB_OPS)).toBe(true);
    await act(async () => {
      await view.router.navigate("/usage");
    });
    expect(await selected(TAB_OPS)).toBe(true);
  });

  it("사람이 탭을 눌러 바꾸면 그대로 바뀐다", async () => {
    await renderBarePage(UsagePage, "usage", "/usage#ops");
    expect(await selected(TAB_OPS)).toBe(true);
    fireEvent.mouseDown(screen.getByRole("tab", { name: TAB_API }));
    expect(await selected(TAB_API)).toBe(true);
    fireEvent.mouseDown(screen.getByRole("tab", { name: TAB_OPS }));
    expect(await selected(TAB_OPS)).toBe(true);
  });

  it("탭을 눌러 옮긴 뒤 같은 해시로 다시 그려도 사람이 고른 탭을 되돌리지 않는다", async () => {
    const view = await renderBarePage(UsagePage, "usage", "/usage#ops");
    expect(await selected(TAB_OPS)).toBe(true);
    fireEvent.mouseDown(screen.getByRole("tab", { name: TAB_API }));
    expect(await selected(TAB_API)).toBe(true);
    // 같은 주소(해시 그대로)로 다시 이동해도 해시가 바뀐 게 아니라서 탭은 그대로
    await act(async () => {
      await view.router.navigate("/usage#ops", { replace: true });
    });
    expect(await selected(TAB_API)).toBe(true);
  });
});
