// SEL-82 U1b — 앱이 실제 클라이언트 모드에서 서버 자료를 그린다 (Vitest, jsdom, fetch 는 가짜 서버). 구현 전이라 실패가 정상.
// 모드 고르기 해석: window.__PES_APP__ = { api: "http", session, projects: { [slug]: 프로젝트 id } } 가 있으면 루트 레이아웃이 실제 클라이언트를 만든다
// (`@/api/select-client`, 자세한 해석은 src/api/http-client.test.ts 머리말). 설정이 없으면 U1a 그대로(가짜 클라이언트, 네트워크 0 — no-network.test.tsx).
import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WORKSPACE } from "@/api/fixture";
import { FORMAT_VERSION } from "@/api/types";
import { renderApp } from "@/test/render-app";
import { SHELL } from "@/test/contract";

const SLUG = "server-study";
const ID = "pj-server-1";
const TITLE = "서버가 준 합성 제목";
const SESSION = "synthetic-session-http-mode";
const SERVER_WS = { ...WORKSPACE, slug: SLUG, title: TITLE };
const PATH = `/p/${SLUG}/e/1/s/research/r/2`;

interface Call {
  path: string;
  method: string;
  session: string | null;
}
const calls: Call[] = [];

function stubServer(handler?: (path: string) => { status: number; body: unknown } | null) {
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input), window.location.href);
      calls.push({ path: url.pathname, method: (init?.method ?? "GET").toUpperCase(), session: new Headers(init?.headers).get("x-pes-session") });
      const custom = handler?.(url.pathname);
      if (custom) return new Response(JSON.stringify(custom.body), { status: custom.status });
      if (url.pathname === `/api/v1/projects/${ID}/workspace`) return new Response(JSON.stringify({ format_version: FORMAT_VERSION, request_id: "r1", data: SERVER_WS }), { status: 200 });
      return new Response(JSON.stringify({ format_version: FORMAT_VERSION, error: { code: "not_found", message: "없음", retryable: false, target: null, details: null, next_action: "reread_context" }, request_id: "r2" }), { status: 404 });
    }),
  );
}
const configure = (projects: Record<string, string> = { [SLUG]: ID }) => {
  (window as unknown as Record<string, unknown>).__PES_APP__ = { api: "http", session: SESSION, projects };
};
afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as unknown as Record<string, unknown>).__PES_APP__;
});

describe("실제 클라이언트 모드", () => {
  it("서버가 준 프로젝트 제목이 머리줄·사이드바에 나오고, 가짜 합성 제목('예시 연구')은 나오지 않는다", async () => {
    stubServer();
    configure();
    await renderApp(PATH);
    const crumbs = await screen.findByRole("navigation", { name: SHELL.crumbs });
    await waitFor(() => expect(crumbs.textContent).toContain(TITLE));
    expect(within(await screen.findByRole("navigation", { name: SHELL.sidebarNav })).getAllByRole("link").length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toContain("예시 연구");
  });

  it("요청은 같은 출처 /api/v1/ 읽기(GET)뿐이고 모두 x-pes-session 을 달고, 쿠키 저장소는 건드리지 않는다", async () => {
    stubServer();
    configure();
    await renderApp(PATH);
    await waitFor(() => expect(screen.getByRole("main").querySelector("[data-screen-title]")).not.toBeNull());
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.path, "같은 출처 /api/v1/ 만").toMatch(/^\/api\/v1\//);
      expect(c.method).toBe("GET");
      expect(c.session).toBe(SESSION);
    }
    expect(calls.some((c) => c.path === `/api/v1/projects/${ID}/workspace`)).toBe(true);
    expect(document.cookie).toBe("");
  });

  it("화면 제목은 서버 작업 공간에 있는 라운드로 그려진다(조사 R2)", async () => {
    stubServer();
    configure();
    await renderApp(PATH);
    const main = await screen.findByRole("main");
    await waitFor(() => expect(main.querySelector("[data-screen-title]")?.textContent ?? "").toContain("조사 R2"));
  });

  it("설정에 없는 slug 는 '찾을 수 없음' 이고 서버에 요청하지 않는다", async () => {
    stubServer();
    configure({ [SLUG]: ID });
    await renderApp("/p/other-project/e/1/s/research/r/2");
    expect(await screen.findByText(/찾을 수 없/)).toBeInTheDocument();
    expect(calls.filter((c) => c.path.includes("other-project"))).toEqual([]);
  });

  it("서버가 401 을 주면 가짜 자료로 되돌아가지 않고 오류를 보인다(합성 제목이 새로 나타나지 않음)", async () => {
    stubServer(() => ({ status: 401, body: { format_version: FORMAT_VERSION, error: { code: "unauthenticated", message: "인증이 필요합니다.", retryable: false, target: null, details: null, next_action: "authenticate" }, request_id: "r3" } }));
    configure();
    await renderApp(PATH);
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 200));
    expect(document.body.textContent).not.toContain("예시 연구");
    expect(document.body.textContent).not.toContain(TITLE);
  });
});
