// SEL-82 U1b R1 필수 1 — 앱이 URL 조각(#pes=…)으로 받은 세션을 같은 탭에 두고 주소에서 지운다 (Vitest, jsdom). 구현 전이라 `@/api/handoff` 가 없어 실패하는 것이 정상.
//
// 해석 (leader 결정 = 권장안 A — 구현을 추측하지 않음; 전체 흐름은 tests/e2e/app_real_api.spec.ts 머리말):
//   - `takeHandoff(win: Window): { api: "http"; session: string; projects: Record<string, string> } | null`  (named export, `@/api/handoff`).
//     main.tsx 가 렌더 전에 부른다. 하는 일:
//       1. win.location.hash 가 `#pes=<base64url(JSON {session, projects})>` 이면 읽는다. 올바른 모양 = session 이 비어 있지 않은 문자열, projects 가 {문자열: 비어 있지 않은 문자열} 객체
//          (그 밖의 키는 무시). 올바르면 같은 탭 sessionStorage 에 두고(키 이름은 구현 몫 — 시험은 보지 않음; 막히면 메모리만),
//       2. `pes=` 조각이면(올바르든 깨졌든) 항상 history.replaceState 로 조각을 지운다(경로·쿼리는 그대로, 새 기록 없음). `#main` 같은 다른 조각은 건드리지 않는다.
//       3. 조각에서 못 읽었으면 같은 탭 sessionStorage 에 둔 것을 읽는다(새로고침). 둘 다 없으면 null.
//     올바른 설정을 얻으면 win.__PES_APP__ = { api: "http", session, projects } 로 두고(selectClient 가 읽는 그 설정) 같은 것을 돌려준다. 못 얻으면 __PES_APP__ 를 건드리지 않고 null.
//   - 세션 값을 console 에 쓰지 않고, localStorage·쿠키에 두지 않는다. sessionStorage 가 막혀 있어도(throw) 던지지 않고 메모리만으로 동작한다.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Config = { api: "http"; session: string; projects: Record<string, string> };
type Take = (win: Window) => Config | null;
const modules = import.meta.glob<{ takeHandoff: Take }>("/src/api/handoff.{ts,tsx}");
const load = async (): Promise<Take> => {
  const loader = Object.values(modules)[0];
  if (!loader) throw new Error("src/api/handoff.ts 가 없다 — 계약은 이 파일 머리말");
  return (await loader()).takeHandoff;
};

const SESSION = "synthetic-handoff-session-0123456789";
const PATH = "/p/demo/e/1/s/plan/r/start";
const b64url = (text: string) => Buffer.from(text, "utf8").toString("base64url");
const payload = (obj: unknown) => b64url(JSON.stringify(obj));
const GOOD = { session: SESSION, projects: { demo: "pj-demo-1" } };

function openAt(hash: string, search = "") {
  window.history.replaceState(null, "", `${PATH}${search}${hash}`);
}
const app = () => (window as unknown as { __PES_APP__?: unknown }).__PES_APP__;

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  delete (window as unknown as Record<string, unknown>).__PES_APP__;
  window.history.replaceState(null, "", "/");
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("조각으로 받은 세션 (takeHandoff)", () => {
  it("올바른 조각: 설정을 돌려주고 __PES_APP__ 로 두며 주소창의 조각을 지운다(경로·쿼리는 그대로)", async () => {
    const take = await load();
    openAt(`#pes=${payload(GOOD)}`, "?view=body&print=1");
    const config = take(window);
    expect(config).toEqual({ api: "http", session: SESSION, projects: { demo: "pj-demo-1" } });
    expect(app()).toEqual(config);
    expect(window.location.hash).toBe("");
    expect(window.location.pathname).toBe(PATH);
    expect(window.location.search).toBe("?view=body&print=1");
  });

  it("조각 지우기는 history.replaceState 이다(새 기록을 쌓지 않는다) — 넘긴 주소에 세션이 없다", async () => {
    const take = await load();
    openAt(`#pes=${payload(GOOD)}`);
    const before = window.history.length;
    const replace = vi.spyOn(window.history, "replaceState");
    const push = vi.spyOn(window.history, "pushState");
    take(window);
    expect(push).not.toHaveBeenCalled();
    expect(replace).toHaveBeenCalled();
    for (const call of replace.mock.calls) expect(String(call[2] ?? "")).not.toMatch(/pes=|#/);
    expect(window.history.length).toBe(before);
  });

  it("새로고침: 조각이 이미 지워진 같은 탭에서 다시 부르면 같은 설정을 돌려준다(sessionStorage)", async () => {
    const take = await load();
    openAt(`#pes=${payload(GOOD)}`);
    take(window);
    delete (window as unknown as Record<string, unknown>).__PES_APP__; // 새로고침 = 메모리가 사라진다
    expect(window.location.hash).toBe("");
    const again = take(window);
    expect(again).toEqual({ api: "http", session: SESSION, projects: { demo: "pj-demo-1" } });
    expect(app()).toEqual(again);
  });

  it("다른 탭/창(빈 sessionStorage)에는 넘어가지 않는다: 조각도 저장된 것도 없으면 null 이고 __PES_APP__ 는 비어 있다", async () => {
    const take = await load();
    openAt("");
    expect(take(window)).toBeNull();
    expect(app()).toBeUndefined();
  });

  it("세션은 localStorage·쿠키·console 어디에도 남지 않는다", async () => {
    const take = await load();
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "info"), vi.spyOn(console, "warn"), vi.spyOn(console, "error"), vi.spyOn(console, "debug")];
    openAt(`#pes=${payload(GOOD)}`);
    take(window);
    take(window);
    expect(JSON.stringify({ ...window.localStorage })).not.toContain(SESSION);
    expect(document.cookie).toBe("");
    for (const spy of logs) expect(JSON.stringify(spy.mock.calls)).not.toContain(SESSION);
  });

  it("깨진 조각은 모두 null 이고 __PES_APP__ 를 만들지 않으며 조각은 그래도 주소에서 지운다", async () => {
    const take = await load();
    const broken = [
      "#pes=",
      "#pes=!!!not-base64!!!",
      `#pes=${b64url("this is not json")}`,
      `#pes=${b64url("[]")}`,
      `#pes=${b64url("null")}`,
      `#pes=${b64url('"just a string"')}`,
      `#pes=${payload({ projects: { demo: "pj" } })}`,
      `#pes=${payload({ session: "", projects: { demo: "pj" } })}`,
      `#pes=${payload({ session: 123, projects: {} })}`,
      `#pes=${payload({ session: SESSION })}`,
      `#pes=${payload({ session: SESSION, projects: "nope" })}`,
      `#pes=${payload({ session: SESSION, projects: ["demo"] })}`,
      `#pes=${payload({ session: SESSION, projects: { demo: 7 } })}`,
      `#pes=${payload({ session: SESSION, projects: { demo: "" } })}`,
    ];
    for (const hash of broken) {
      window.sessionStorage.clear();
      delete (window as unknown as Record<string, unknown>).__PES_APP__;
      openAt(hash);
      expect(take(window), hash).toBeNull();
      expect(app(), hash).toBeUndefined();
      expect(window.location.hash, hash).toBe("");
    }
  });

  it("깨진 조각은 같은 탭에 이미 있던 올바른 설정을 지우지도, 깨진 값으로 덮지도 않는다", async () => {
    const take = await load();
    openAt(`#pes=${payload(GOOD)}`);
    take(window);
    delete (window as unknown as Record<string, unknown>).__PES_APP__;
    openAt(`#pes=${b64url("garbage")}`);
    const config = take(window);
    // 깨진 조각 자리에서는 저장된 올바른 설정을 쓴다(또는 null) — 깨진 값이 설정이 되어서는 안 된다
    if (config !== null) expect(config).toEqual({ api: "http", session: SESSION, projects: { demo: "pj-demo-1" } });
    expect(window.location.hash).toBe("");
  });

  it("조각이 pes= 가 아니면(#main 건너뛰기 링크 등) 그대로 둔다", async () => {
    const take = await load();
    openAt("#main");
    expect(take(window)).toBeNull();
    expect(window.location.hash).toBe("#main");
    expect(app()).toBeUndefined();
  });

  it("projects 의 문자열이 아닌 추가 키·알 수 없는 최상위 키는 무시하고 올바른 부분만 받는다", async () => {
    const take = await load();
    openAt(`#pes=${payload({ ...GOOD, extra: { a: 1 } })}`);
    expect(take(window)).toEqual({ api: "http", session: SESSION, projects: { demo: "pj-demo-1" } });
  });

  it("sessionStorage 가 막혀 있어도(throw) 던지지 않고 이번 로드는 메모리로 동작하며 조각은 지운다", async () => {
    const take = await load();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    openAt(`#pes=${payload(GOOD)}`);
    let config: Config | null = null;
    expect(() => {
      config = take(window);
    }).not.toThrow();
    expect(config).toEqual({ api: "http", session: SESSION, projects: { demo: "pj-demo-1" } });
    expect(app()).toEqual(config);
    expect(window.location.hash).toBe("");
    // 조각도 저장도 없는 새로고침은 던지지 않고 null
    delete (window as unknown as Record<string, unknown>).__PES_APP__;
    expect(() => take(window)).not.toThrow();
    expect(take(window)).toBeNull();
  });
});
