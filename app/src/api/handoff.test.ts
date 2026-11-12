// SEL-82 U1b R1 필수 1 → SEL-85 로 옮김: 앱이 받은 세션을 같은 탭에 두는 규칙 (Vitest, jsdom).
// 조각은 이제 세션이 아니라 1회용 코드(#code=…)이고 세션은 `exchangeHandoff`(@/api/handoff-exchange, 계약은 sel85-exchange.test.ts 머리말)가 서버 교환으로 얻는다.
// 옛 동기 takeHandoff 의 #pes= 조각 시험은 없앴다(그 조각은 더는 받지 않는다 — sel85-exchange.test.ts "옛 #pes= 조각은 받지 않는다").
// 여기에는 보안 보장의 뜻을 그대로 옮긴 것만 남는다: 같은 탭에만 남음(새로고침 복원 · 다른 탭 이어받기 없음), 세션이 localStorage·쿠키·console 에 없음,
// 막힌 sessionStorage 에서도 안 던짐, 깨진 응답이 설정이 되지 않음, 추가 키 무시, 깨진 코드 조각도 주소에서 지움.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Config = { api: "http"; session: string; projects: Record<string, string> };
type Exchange = (win: Window, fetchImpl?: typeof fetch) => Promise<Config | null>;
const modules = import.meta.glob<{ exchangeHandoff: Exchange }>("/src/api/handoff-exchange.{ts,tsx}");
const load = async (): Promise<Exchange> => {
  const loader = Object.values(modules)[0];
  if (!loader) throw new Error("src/api/handoff-exchange.ts 가 없다 — 계약은 app/src/api/sel85-exchange.test.ts 머리말");
  return (await loader()).exchangeHandoff;
};

const SESSION = "synthetic-handoff-session-0123456789";
const PATH = "/p/demo/e/1/s/plan/r/start";
const CODE = "AbCdEfGhIjKlMnOpQrStUv_-0123";
const GOOD = { session: SESSION, projects: { demo: "pj-demo-1" } };
const CONFIG: Config = { api: "http", ...GOOD };

const answer = (data: unknown, status = 200): typeof fetch =>
  (async () => new Response(JSON.stringify({ format_version: 1, request_id: "r", data }), { status })) as unknown as typeof fetch;
const openAt = (hash: string, search = "") => window.history.replaceState(null, "", `${PATH}${search}${hash}`);
const app = () => (window as unknown as { __PES_APP__?: unknown }).__PES_APP__;

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  delete (window as unknown as Record<string, unknown>).__PES_APP__;
  window.history.replaceState(null, "", "/");
});
afterEach(() => vi.restoreAllMocks());

describe("교환으로 받은 세션을 같은 탭에 둔다 (exchangeHandoff)", () => {
  it("새로고침: 조각이 이미 지워진 같은 탭에서 다시 부르면 같은 설정을 돌려준다(sessionStorage), 요청 없이", async () => {
    const run = await load();
    openAt(`#code=${CODE}`);
    await run(window, answer(GOOD));
    delete (window as unknown as Record<string, unknown>).__PES_APP__; // 새로고침 = 메모리가 사라진다
    expect(window.location.hash).toBe("");
    const fetchSpy = vi.fn();
    const again = await run(window, fetchSpy as unknown as typeof fetch);
    expect(again).toEqual(CONFIG);
    expect(app()).toEqual(again);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("다른 탭/창(빈 sessionStorage)에는 넘어가지 않는다: 조각도 저장된 것도 없으면 null 이고 __PES_APP__ 는 비어 있다", async () => {
    const run = await load();
    openAt("");
    expect(await run(window, vi.fn() as unknown as typeof fetch)).toBeNull();
    expect(app()).toBeUndefined();
  });

  it("세션은 localStorage·쿠키·console 어디에도 남지 않는다", async () => {
    const run = await load();
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "info"), vi.spyOn(console, "warn"), vi.spyOn(console, "error"), vi.spyOn(console, "debug")];
    openAt(`#code=${CODE}`);
    await run(window, answer(GOOD));
    await run(window);
    expect(JSON.stringify({ ...window.localStorage })).not.toContain(SESSION);
    expect(document.cookie).toBe("");
    for (const spy of logs) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(SESSION);
      expect(JSON.stringify(spy.mock.calls)).not.toContain(CODE);
    }
  });

  it("깨진 응답(모양 틀림)은 모두 null 이고 __PES_APP__ 를 만들지 않으며 코드 조각은 그래도 주소에서 지운다", async () => {
    const run = await load();
    const broken: unknown[] = [
      null,
      "just a string",
      [],
      { projects: { demo: "pj" } },
      { session: "", projects: { demo: "pj" } },
      { session: 123, projects: {} },
      { session: SESSION },
      { session: SESSION, projects: "nope" },
      { session: SESSION, projects: ["demo"] },
      { session: SESSION, projects: { demo: 7 } },
      { session: SESSION, projects: { demo: "" } },
    ];
    for (const data of broken) {
      window.sessionStorage.clear();
      delete (window as unknown as Record<string, unknown>).__PES_APP__;
      openAt(`#code=${CODE}`);
      expect(await run(window, answer(data)), JSON.stringify(data)).toBeNull();
      expect(app(), JSON.stringify(data)).toBeUndefined();
      expect(window.location.hash).toBe("");
    }
    for (const hash of ["#code=", "#code=!!!not-a-code!!!", `#code=${"x".repeat(5000)}`]) {
      delete (window as unknown as Record<string, unknown>).__PES_APP__;
      openAt(hash);
      expect(await run(window, answer(null, 401)), hash).toBeNull();
      expect(app(), hash).toBeUndefined();
      expect(window.location.hash, hash).toBe("");
    }
  });

  it("실패한 교환은 같은 탭에 이미 있던 올바른 설정을 지우지도, 깨진 값으로 덮지도 않는다", async () => {
    const run = await load();
    openAt(`#code=${CODE}`);
    await run(window, answer(GOOD));
    delete (window as unknown as Record<string, unknown>).__PES_APP__;
    openAt(`#code=${CODE}2`);
    const config = await run(window, answer({ session: "", projects: {} }));
    if (config !== null) expect(config).toEqual(CONFIG);
    expect(window.location.hash).toBe("");
    openAt("");
    expect(await run(window, vi.fn() as unknown as typeof fetch)).toEqual(CONFIG);
  });

  it("조각이 code= 가 아니면(#main 건너뛰기 링크 등) 그대로 둔다", async () => {
    const run = await load();
    const spy = vi.fn();
    openAt("#main");
    expect(await run(window, spy as unknown as typeof fetch)).toBeNull();
    expect(window.location.hash).toBe("#main");
    expect(app()).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });

  it("projects 의 문자열이 아닌 추가 키·알 수 없는 최상위 키는 무시하고 올바른 부분만 받는다", async () => {
    const run = await load();
    openAt(`#code=${CODE}`);
    expect(await run(window, answer({ ...GOOD, extra: { a: 1 } }))).toEqual(CONFIG);
  });

  it("sessionStorage 가 막혀 있어도(throw) 던지지 않고 이번 로드는 메모리로 동작하며 조각은 지운다", async () => {
    const run = await load();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    openAt(`#code=${CODE}`);
    let config: Config | null = null;
    await expect(
      (async () => {
        config = await run(window, answer(GOOD));
      })(),
    ).resolves.not.toThrow();
    expect(config).toEqual(CONFIG);
    expect(app()).toEqual(config);
    expect(window.location.hash).toBe("");
    // 조각도 저장도 없는 새로고침은 던지지 않고 null
    delete (window as unknown as Record<string, unknown>).__PES_APP__;
    expect(await run(window, vi.fn() as unknown as typeof fetch)).toBeNull();
  });
});
