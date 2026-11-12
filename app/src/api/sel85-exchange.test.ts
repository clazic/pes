// SEL-85 U1b 후속 A — 앱이 주소 조각의 1회용 코드(#code=…)를 서버에서 세션으로 바꾼다 (Vitest, jsdom, fetch 는 가짜). 구현 전이라 실패가 정상.
//
// 스스로 정한 해석 (서버 쪽 계약은 tests/test_sel85_app_code.test.ts 머리말):
//   - 모듈 `@/api/handoff-exchange` 가 `exchangeHandoff(win: Window, fetchImpl?: typeof fetch): Promise<Config | null>` 를 named export 한다.
//     Config = { api: "http"; session: string; projects: Record<string, string> }. main.tsx 가 렌더·라우터 전에 기다려 부른다(옛 동기 takeHandoff 의 자리).
//   - 하는 일: ① win.location.hash 가 `#code=<코드>` 이면 **요청 전에** history.replaceState 로 조각을 지운다(경로·쿼리 유지, 새 기록 없음; 요청이 실패해도 지워져 있다).
//     ② 같은 출처 `POST /api/v1/app-session` 본문 JSON {code}, 헤더에 x-pes-session 없음, credentials "omit", 딱 한 번(재시도·두 번째 요청 없음).
//     ③ 200 이고 data 가 {session: 비지 않은 문자열, projects: {문자열: 비지 않은 문자열}} 이면 같은 탭 sessionStorage 에 두고 win.__PES_APP__ 로 두고 돌려준다.
//     ④ 그 밖(비 200 · 네트워크 실패 · 모양 틀림 · 코드 없음)은 null — __PES_APP__ 를 만들지 않는다(가짜 클라이언트로 돌아가지 않게 하는 일은 e2e 가 production 빌드로 본다).
//     ⑤ 조각이 없으면 같은 탭 sessionStorage 에 둔 것을 읽는다(새로고침). 요청 0.
//   - 합치기(F1 권장 3): 새로 받은 세션이 sessionStorage 에 있던 것과 **같으면** projects 를 합친다(같은 slug 면 새 값), **다르면** 새것으로 덮어쓴다(옛 projects 버림).
//   - 세션·코드를 console·localStorage·쿠키에 두지 않는다.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Config = { api: "http"; session: string; projects: Record<string, string> };
type Exchange = (win: Window, fetchImpl?: typeof fetch) => Promise<Config | null>;
const modules = import.meta.glob<{ exchangeHandoff: Exchange }>("/src/api/handoff-exchange.{ts,tsx}");
const load = async (): Promise<Exchange> => {
  const loader = Object.values(modules)[0];
  if (!loader) throw new Error("src/api/handoff-exchange.ts 가 없다 — 계약은 이 파일 머리말");
  return (await loader()).exchangeHandoff;
};

const SESSION = "synthetic-sel85-session-0123456789";
const OTHER = "synthetic-sel85-other-session-9876543210";
const CODE = "AbCdEfGhIjKlMnOpQrStUv_-0123";
const PATH = "/p/demo/e/1/s/plan/r/start";
const app = () => (window as unknown as { __PES_APP__?: unknown }).__PES_APP__;

function openAt(hash: string, search = "") {
  window.history.replaceState(null, "", `${PATH}${search}${hash}`);
}
function ok(session: string, projects: Record<string, string>): Response {
  return new Response(JSON.stringify({ format_version: 1, request_id: "r", data: { session, projects } }), { status: 200, headers: { "content-type": "application/json" } });
}
const refused = (status: number): Response => new Response(JSON.stringify({ error: { code: "unauthenticated" } }), { status });

interface Sent {
  url: URL;
  method: string;
  headers: Headers;
  body: string;
  credentials: string | undefined;
}
function fakeFetch(answer: () => Response | Promise<Response>) {
  const sent: Sent[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: new URL(String(input instanceof Request ? input.url : input), window.location.href), method: (init?.method ?? "GET").toUpperCase(), headers: new Headers(init?.headers), body: String(init?.body ?? ""), credentials: init?.credentials });
    return answer();
  });
  return { fn: fn as unknown as typeof fetch, sent };
}

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  delete (window as unknown as Record<string, unknown>).__PES_APP__;
  window.history.replaceState(null, "", "/");
});
afterEach(() => vi.restoreAllMocks());

describe("1회용 코드 교환 (exchangeHandoff)", () => {
  it("코드 조각: POST /api/v1/app-session {code} 한 번 → 설정을 돌려주고 __PES_APP__ 로 두며 조각을 지운다", async () => {
    const run = await load();
    const f = fakeFetch(() => ok(SESSION, { demo: "pj-1" }));
    openAt(`#code=${CODE}`, "?view=body");
    const config = await run(window, f.fn);
    expect(config).toEqual({ api: "http", session: SESSION, projects: { demo: "pj-1" } });
    expect(app()).toEqual(config);
    expect(f.sent).toHaveLength(1);
    const req = f.sent[0]!;
    expect(req.method).toBe("POST");
    expect(req.url.origin).toBe(window.location.origin);
    expect(req.url.pathname).toBe("/api/v1/app-session");
    expect(req.url.search).toBe("");
    expect(JSON.parse(req.body)).toEqual({ code: CODE });
    expect(req.headers.get("x-pes-session")).toBeNull();
    expect(req.headers.get("authorization")).toBeNull();
    expect(req.credentials).toBe("omit");
    expect(window.location.hash).toBe("");
    expect(window.location.pathname).toBe(PATH);
    expect(window.location.search).toBe("?view=body");
  });

  it("조각은 요청이 가기 전에 지워진다 — 교환이 실패하거나 멈춰 있어도 주소창에 코드가 남지 않는다", async () => {
    const run = await load();
    let seenHash: string | null = null;
    const f = fakeFetch(() => {
      seenHash = window.location.hash;
      return refused(401);
    });
    openAt(`#code=${CODE}`);
    await run(window, f.fn);
    expect(seenHash).toBe("");
    expect(window.location.hash).toBe("");
  });

  it("지우기는 history.replaceState 이다(새 기록 없음)", async () => {
    const run = await load();
    const f = fakeFetch(() => ok(SESSION, { demo: "pj-1" }));
    openAt(`#code=${CODE}`);
    const before = window.history.length;
    const replace = vi.spyOn(window.history, "replaceState");
    const push = vi.spyOn(window.history, "pushState");
    await run(window, f.fn);
    expect(replace).toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(window.history.length).toBe(before);
  });

  it("교환 실패(401·410·403·500·네트워크 오류·JSON 아님)는 null — __PES_APP__ 를 만들지 않고 던지지 않는다", async () => {
    const run = await load();
    const cases: Array<() => Response | Promise<Response>> = [
      () => refused(401),
      () => refused(410),
      () => refused(403),
      () => refused(500),
      () => Promise.reject(new TypeError("network down")),
      () => new Response("<html>no</html>", { status: 200 }),
    ];
    for (const answer of cases) {
      delete (window as unknown as Record<string, unknown>).__PES_APP__;
      window.sessionStorage.clear();
      openAt(`#code=${CODE}`);
      const f = fakeFetch(answer);
      expect(await run(window, f.fn)).toBeNull();
      expect(app()).toBeUndefined();
      expect(f.sent).toHaveLength(1); // 재시도 없음
      expect(window.location.hash).toBe("");
      expect(window.sessionStorage.length).toBe(0);
    }
  });

  it("200 이어도 모양이 틀리면(세션 없음·빈 세션·projects 값이 문자열 아님·data 없음) null", async () => {
    const run = await load();
    const bodies: unknown[] = [{ data: {} }, { data: { session: "", projects: {} } }, { data: { session: SESSION } }, { data: { session: SESSION, projects: { demo: 7 } } }, { data: { session: SESSION, projects: [] } }, {}, []];
    for (const body of bodies) {
      delete (window as unknown as Record<string, unknown>).__PES_APP__;
      openAt(`#code=${CODE}`);
      const f = fakeFetch(() => new Response(JSON.stringify(body), { status: 200 }));
      expect(await run(window, f.fn), JSON.stringify(body)).toBeNull();
      expect(app()).toBeUndefined();
    }
  });

  it("조각이 없으면 요청 0 · 같은 탭에 받아 둔 것(새로고침)을 돌려주고, 둘 다 없으면 null", async () => {
    const run = await load();
    const f1 = fakeFetch(() => ok(SESSION, { demo: "pj-1" }));
    openAt(`#code=${CODE}`);
    await run(window, f1.fn);
    openAt("");
    delete (window as unknown as Record<string, unknown>).__PES_APP__;
    const f2 = fakeFetch(() => refused(401));
    const again = await run(window, f2.fn);
    expect(again).toEqual({ api: "http", session: SESSION, projects: { demo: "pj-1" } });
    expect(f2.sent).toHaveLength(0);
    window.sessionStorage.clear();
    delete (window as unknown as Record<string, unknown>).__PES_APP__;
    expect(await run(window, f2.fn)).toBeNull();
    expect(f2.sent).toHaveLength(0);
  });

  it("옛 #pes=<세션> 조각은 받지 않는다 — 세션을 주소에서 얻지 못하고 요청도 없다", async () => {
    const run = await load();
    const payload = Buffer.from(JSON.stringify({ session: SESSION, projects: { demo: "pj-1" } }), "utf8").toString("base64url");
    const f = fakeFetch(() => refused(401));
    openAt(`#pes=${payload}`);
    expect(await run(window, f.fn)).toBeNull();
    expect(app()).toBeUndefined();
    expect(f.sent).toHaveLength(0);
    expect(window.location.hash, "세션이 든 조각은 주소창에 남기지 않는다").toBe("");
  });

  it("`#main` 같은 다른 조각은 건드리지 않고 요청도 없다", async () => {
    const run = await load();
    const f = fakeFetch(() => refused(401));
    openAt("#main");
    await run(window, f.fn);
    expect(window.location.hash).toBe("#main");
    expect(f.sent).toHaveLength(0);
  });

  it("세션·코드는 console·localStorage·쿠키에 없다", async () => {
    const run = await load();
    const logs: string[] = [];
    for (const m of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, m).mockImplementation((...a) => void logs.push(a.map(String).join(" ")));
    openAt(`#code=${CODE}`);
    await run(window, fakeFetch(() => ok(SESSION, { demo: "pj-1" })).fn);
    openAt(`#code=${CODE}`);
    await run(window, fakeFetch(() => refused(410)).fn);
    expect(logs.join("\n")).not.toContain(SESSION);
    expect(logs.join("\n")).not.toContain(CODE);
    expect(JSON.stringify({ ...window.localStorage })).not.toContain(SESSION);
    expect(document.cookie).not.toContain(SESSION);
    expect(document.cookie).not.toContain(CODE);
  });
});

describe("같은 탭에서 프로젝트를 바꿔 열 때 (F1 권장 3)", () => {
  it("같은 세션이면 projects 를 합친다 — X 를 연 뒤 Y 를 열어도 X 를 찾는다", async () => {
    const run = await load();
    openAt(`#code=${CODE}`);
    await run(window, fakeFetch(() => ok(SESSION, { x: "pj-x" })).fn);
    openAt(`#code=${CODE}2`);
    delete (window as unknown as Record<string, unknown>).__PES_APP__;
    const config = await run(window, fakeFetch(() => ok(SESSION, { y: "pj-y" })).fn);
    expect(config).toEqual({ api: "http", session: SESSION, projects: { x: "pj-x", y: "pj-y" } });
    expect(app()).toEqual(config);
    // 새로고침(조각 없음)도 합친 맵을 돌려준다
    openAt("");
    delete (window as unknown as Record<string, unknown>).__PES_APP__;
    expect(await run(window, fakeFetch(() => refused(401)).fn)).toEqual({ api: "http", session: SESSION, projects: { x: "pj-x", y: "pj-y" } });
  });

  it("같은 세션에서 같은 slug 를 다시 열면 새 id 가 이긴다", async () => {
    const run = await load();
    openAt(`#code=${CODE}`);
    await run(window, fakeFetch(() => ok(SESSION, { x: "pj-old", z: "pj-z" })).fn);
    openAt(`#code=${CODE}2`);
    const config = await run(window, fakeFetch(() => ok(SESSION, { x: "pj-new" })).fn);
    expect(config?.projects).toEqual({ x: "pj-new", z: "pj-z" });
  });

  it("세션이 다르면 새것으로 덮어쓴다 — 옛 세션도 옛 projects 도 남지 않는다", async () => {
    const run = await load();
    openAt(`#code=${CODE}`);
    await run(window, fakeFetch(() => ok(SESSION, { x: "pj-x" })).fn);
    openAt(`#code=${CODE}2`);
    const config = await run(window, fakeFetch(() => ok(OTHER, { y: "pj-y" })).fn);
    expect(config).toEqual({ api: "http", session: OTHER, projects: { y: "pj-y" } });
    expect(window.sessionStorage.length).toBeGreaterThan(0);
    expect(JSON.stringify({ ...window.sessionStorage })).not.toContain(SESSION);
    expect(JSON.stringify({ ...window.sessionStorage })).not.toContain("pj-x");
  });

  it("교환이 실패하면 같은 탭에 받아 둔 것을 잃지도 합치지도 않는다", async () => {
    const run = await load();
    openAt(`#code=${CODE}`);
    await run(window, fakeFetch(() => ok(SESSION, { x: "pj-x" })).fn);
    openAt(`#code=${CODE}2`);
    delete (window as unknown as Record<string, unknown>).__PES_APP__;
    await run(window, fakeFetch(() => refused(410)).fn);
    openAt("");
    expect(await run(window, fakeFetch(() => refused(401)).fn)).toEqual({ api: "http", session: SESSION, projects: { x: "pj-x" } });
  });
});
