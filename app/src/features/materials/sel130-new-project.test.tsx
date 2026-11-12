// SEL-130 — /new 새 프로젝트 만들기 폼(주제·이름·만들기) · HTTP 클라이언트 createProject · 세션 이어받기 rememberProject. 합성 자료뿐, 네트워크 0(가짜 fetch · 가짜 클라이언트).
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeClient } from "@/api/fake-client";
import { rememberProject } from "@/api/handoff-exchange";
import { createHttpClient } from "@/api/http-client";
import { FORMAT_VERSION, PesApiError, type CreateProjectInput, type PesClient } from "@/api/types";
import { renderApp } from "@/test/render-app";
import { ready } from "@/test/ui";

afterEach(cleanup);
beforeEach(() => {
  window.sessionStorage.clear();
  delete (window as unknown as Record<string, unknown>).__PES_APP__;
});

const rejection = (code: string, retryable = false) =>
  new PesApiError({ format_version: FORMAT_VERSION, error: { code: code as never, message: "합성 거절 문장", retryable }, request_id: "req-rej" });

/** createProject 만 가로채는 클라이언트 — 읽기는 가짜 클라이언트(합성 작업 공간) */
function scripted(create: (input: CreateProjectInput, key: string | undefined) => Promise<{ slug: string; project_id: string }>) {
  const base = createFakeClient();
  const calls: { input: CreateProjectInput; key: string | undefined }[] = [];
  const client: PesClient = {
    ...base,
    createProject: (input, key) => {
      calls.push({ input, key });
      return create(input, key);
    },
  };
  return { client, calls };
}
const boot = async (client: PesClient) => {
  const view = await renderApp("/new", {}, { client });
  await ready();
  return view;
};
const topic = () => screen.getByLabelText(/주제/);
const slugBox = () => screen.getByLabelText(/slug/i);
const make = () => screen.getByRole("button", { name: "만들기" });
const alertText = () => screen.getByRole("alert").textContent ?? "";

describe("/new 폼", () => {
  it("주제가 비면 요청 없이 한국어 한 줄로 알리고 주제 칸에 초점을 둔다", async () => {
    const { client, calls } = scripted(() => Promise.reject(new Error("부르면 안 된다")));
    await boot(client);
    const user = userEvent.setup();
    await user.click(make());
    expect(alertText()).toContain("주제");
    expect(topic()).toHaveFocus();
    await user.type(topic(), "   ");
    await user.click(make());
    expect(alertText()).toContain("주제");
    expect(calls).toEqual([]);
  });

  it("이름(slug) 모양이 틀리면 요청 없이 알린다", async () => {
    const { client, calls } = scripted(() => Promise.reject(new Error("부르면 안 된다")));
    await boot(client);
    const user = userEvent.setup();
    await user.type(topic(), "합성 주제");
    await user.type(slugBox(), "Bad Name");
    await user.click(make());
    expect(alertText()).toContain("이름(slug)");
    expect(slugBox()).toHaveFocus();
    expect(calls).toEqual([]);
  });

  it("이름을 비우면 모양에 맞는 이름을 정해 보내고, 성공하면 그 프로젝트의 현재 위치(/p/<slug>)로 간다", async () => {
    const { client, calls } = scripted(async (input) => ({ slug: input.slug, project_id: "pj-synthetic-1" }));
    const { router } = await boot(client);
    const user = userEvent.setup();
    await user.type(topic(), "합성 주제 Alpha");
    await user.click(make());
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.input.slug).toMatch(/^alpha-[a-z0-9]{5}$/);
    expect(calls[0]!.input.topic).toBe("합성 주제 Alpha");
    expect(calls[0]!.input.owner_display_name).not.toBe("");
    expect(calls[0]!.key).toBeTruthy();
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/p\//));
  });

  it("같은 내용을 다시 보내면 같은 멱등 키·같은 이름, 내용을 바꾸면 새 키 — 실패(연결 오류) 뒤 재시도도 같은 키", async () => {
    let n = 0;
    const { client, calls } = scripted(async (input) => {
      n += 1;
      if (n === 1) throw new TypeError("network down");
      return { slug: input.slug, project_id: "pj-synthetic-2" };
    });
    await boot(client);
    const user = userEvent.setup();
    await user.type(topic(), "합성 재시도 주제");
    await user.click(make());
    await waitFor(() => expect(alertText()).toContain("서버에 연결하지 못했습니다"));
    await user.click(make());
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]!.key).toBe(calls[0]!.key);
    expect(calls[1]!.input.slug).toBe(calls[0]!.input.slug);
  });

  it("보내는 동안 다시 눌러도(Enter 포함) 요청은 하나다", async () => {
    let release!: () => void;
    const held = new Promise<void>((done) => (release = done));
    const { client, calls } = scripted(async (input) => {
      await held;
      return { slug: input.slug, project_id: "pj-synthetic-3" };
    });
    await boot(client);
    const user = userEvent.setup();
    await user.type(topic(), "합성 두 번 누름");
    await user.click(make());
    await user.click(make());
    await user.type(topic(), "{Enter}");
    expect(calls).toHaveLength(1);
    expect(make()).toHaveAttribute("aria-disabled", "true");
    release();
    await waitFor(() => expect(make()).not.toHaveAttribute("aria-disabled"));
  });

  it("이름 중복(conflict)은 이름 칸을 가리키고 새 키로 다시 보낼 수 있다", async () => {
    const { client, calls } = scripted(async (input) => {
      if (input.slug === "taken-name") throw rejection("conflict");
      return { slug: input.slug, project_id: "pj-synthetic-4" };
    });
    const { router } = await boot(client);
    const user = userEvent.setup();
    await user.type(topic(), "합성 중복");
    await user.type(slugBox(), "taken-name");
    await user.click(make());
    await waitFor(() => expect(alertText()).toMatch(/이미/));
    expect(slugBox()).toHaveFocus();
    expect(router.state.location.pathname).toBe("/new");
    await user.clear(slugBox());
    await user.type(slugBox(), "free-name");
    await user.click(make());
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/p\/free-name/));
    expect(calls[1]!.key).not.toBe(calls[0]!.key);
  });

  it("세션이 없거나 서버가 거절하면(unauthenticated·forbidden) '권한' 한 줄 — /new 에 머문다", async () => {
    for (const code of ["unauthenticated", "forbidden"]) {
      cleanup();
      const { client } = scripted(() => Promise.reject(rejection(code)));
      const { router } = await boot(client);
      const user = userEvent.setup();
      await user.type(topic(), "합성 권한 없음");
      await user.click(make());
      await waitFor(() => expect(alertText()).toContain("권한"));
      expect(router.state.location.pathname).toBe("/new");
    }
  });

  it("합성 자료 앱(가짜 클라이언트)은 만들 수 없다고 알린다", async () => {
    await boot(createFakeClient());
    const user = userEvent.setup();
    await user.type(topic(), "합성 가짜 클라이언트");
    await user.click(make());
    await waitFor(() => expect(alertText()).toContain("만들 수 없습니다"));
  });

  it("요청이 가는 중에 /new 를 떠났다면 늦게 온 응답은 이동시키지 않는다(프로젝트는 만들어졌다)", async () => {
    let release!: () => void;
    const held = new Promise<void>((done) => (release = done));
    const { client, calls } = scripted(async (input) => {
      await held;
      return { slug: input.slug, project_id: "pj-synthetic-5" };
    });
    const { router } = await boot(client);
    const user = userEvent.setup();
    await user.type(topic(), "합성 늦은 응답");
    await user.click(make());
    await waitFor(() => expect(calls).toHaveLength(1));
    await router.navigate("/p/elsewhere/e/1/records"); // 다른 화면으로 떠남
    await waitFor(() => expect(router.state.location.pathname).toBe("/p/elsewhere/e/1/records"));
    await waitFor(() => expect(screen.queryByLabelText(/주제/)).toBeNull()); // 폼이 실제로 사라진 뒤(화면 갱신은 주소보다 한 박자 늦다)
    release();
    await new Promise((r) => setTimeout(r, 100));
    expect(router.state.location.pathname).toBe("/p/elsewhere/e/1/records");
  });
});

describe("HTTP 클라이언트 createProject", () => {
  const SESSION = "synthetic-session-sel130";
  const okBody = (id: string) => JSON.stringify({ format_version: FORMAT_VERSION, request_id: "req-1", data: { project_id: id } });
  const input: CreateProjectInput = { slug: "synthetic-made", topic: "합성 주제", owner_display_name: "합성 소유자" };

  it("POST /api/v1/projects — 세션 헤더·멱등 키·credentials omit, 본문은 세 칸뿐, 성공하면 slug → id 를 지도에 더한다", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const impl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(url), init: init ?? {} });
      return new Response(okBody("pj-made-1"), { status: 201, headers: { "content-type": "application/json" } });
    });
    const projects: Record<string, string> = {};
    const client = createHttpClient({ session: SESSION, projects, fetch: impl as unknown as typeof fetch });
    await expect(client.createProject(input, "key-1")).resolves.toEqual({ slug: "synthetic-made", project_id: "pj-made-1" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("/api/v1/projects");
    expect(seen[0]!.init.method).toBe("POST");
    expect(seen[0]!.init.credentials).toBe("omit");
    const headers = new Headers(seen[0]!.init.headers);
    expect(headers.get("x-pes-session")).toBe(SESSION);
    expect(headers.get("idempotency-key")).toBe("key-1");
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual(input);
    expect(projects["synthetic-made"]).toBe("pj-made-1");
  });

  it("세션이 비었거나 키가 없으면 요청 0 으로 거절한다", async () => {
    const impl = vi.fn();
    const empty = createHttpClient({ session: "", projects: {}, fetch: impl as unknown as typeof fetch });
    await expect(empty.createProject(input, "key-1")).rejects.toMatchObject({ body: { error: { code: "unauthenticated" } } });
    const keyless = createHttpClient({ session: SESSION, projects: {}, fetch: impl as unknown as typeof fetch });
    await expect(keyless.createProject(input, undefined)).rejects.toMatchObject({ body: { error: { code: "invalid_payload" } } });
    expect(impl).not.toHaveBeenCalled();
  });

  it("서버 거절(409 conflict)은 PesApiError 로 그대로, 지도는 바뀌지 않는다 · 본문에 project_id 가 없으면 실패", async () => {
    const projects: Record<string, string> = {};
    const refuse = vi.fn(async () => new Response(JSON.stringify({ format_version: FORMAT_VERSION, request_id: "r", error: { code: "conflict", message: "m", retryable: false } }), { status: 409 }));
    const a = createHttpClient({ session: SESSION, projects, fetch: refuse as unknown as typeof fetch });
    await expect(a.createProject(input, "key-1")).rejects.toMatchObject({ body: { error: { code: "conflict" } } });
    const blank = vi.fn(async () => new Response(JSON.stringify({ data: {} }), { status: 201 }));
    const b = createHttpClient({ session: SESSION, projects, fetch: blank as unknown as typeof fetch });
    await expect(b.createProject(input, "key-2")).rejects.toBeInstanceOf(PesApiError);
    expect(projects).toEqual({});
  });
});

describe("rememberProject — 이 탭이 만든 프로젝트를 세션 설정에 더한다", () => {
  const CONFIG = { api: "http" as const, session: "synthetic-session-remember", projects: { older: "pj-older" } };

  it("설정에 더하고 같은 탭 sessionStorage 에 session·projects 만 쓴다", () => {
    (window as unknown as Record<string, unknown>).__PES_APP__ = CONFIG;
    rememberProject(window, "newer", "pj-newer");
    expect(JSON.parse(window.sessionStorage.getItem("pes-app-handoff") as string)).toEqual({ session: CONFIG.session, projects: { older: "pj-older", newer: "pj-newer" } });
    expect((window as unknown as { __PES_APP__: typeof CONFIG }).__PES_APP__.projects).toEqual({ older: "pj-older", newer: "pj-newer" });
  });

  it("설정이 없으면(세션 없이 연 /new) 아무것도 쓰지 않는다", () => {
    rememberProject(window, "newer", "pj-newer");
    expect(window.sessionStorage.getItem("pes-app-handoff")).toBeNull();
  });
});
