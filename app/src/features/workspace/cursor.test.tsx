// SEL-83 U1c — 커서 갱신: tx 묶음 단위 · 활성 약 3초 · 비활성/오류 때 늦춤 · 바뀐 읽기만 무효화 (Vitest, jsdom, 가짜 시계).
// 계약: src/test/contract.ts 머리말 "PesClient 확장 — 변경분 읽기" · "갱신 박자". 폴링으로 읽기를 직접 부르지 않는다(결정 0017).
import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiError, createScriptedClient, timeoutError } from "@/test/scripted-client";
import { renderApp } from "@/test/render-app";
import { CURRENT, U1C, WIDTHS } from "@/test/contract";
import { ready } from "@/test/ui";

const realVisibility = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState");
const setVisible = (visible: boolean) => {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (visible ? "visible" : "hidden") });
  document.dispatchEvent(new Event("visibilitychange"));
};
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

async function boot() {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const s = createScriptedClient();
  const app = await renderApp(CURRENT, { width: WIDTHS.wide1440 }, { client: s.client });
  await ready();
  s.reset();
  return { s, ...app };
}
const gaps = (s: ReturnType<typeof createScriptedClient>) => s.changesCalls().map((c, i, all) => (i === 0 ? 0 : c.at - all[i - 1]!.at)).slice(1);

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  if (realVisibility) delete (document as unknown as Record<string, unknown>).visibilityState;
});

describe("박자 — 활성 약 3초", () => {
  it("10초 동안 getChanges 가 2~4번, 호출 사이 간격은 2~4초", async () => {
    const { s } = await boot();
    await advance(10_000);
    const n = s.changesCalls().length;
    expect(n).toBeGreaterThanOrEqual(2);
    expect(n).toBeLessThanOrEqual(4);
    for (const g of gaps(s)) {
      expect(g).toBeGreaterThanOrEqual(U1C.active.minGap);
      expect(g).toBeLessThanOrEqual(U1C.active.maxGap);
    }
  });

  it("커서는 서버가 준 불투명 값을 그대로 되돌려 준다", async () => {
    const { s } = await boot();
    s.queueChanges({ cursor: "opaque-A", txs: [] }, { cursor: "opaque-B", txs: [] });
    await advance(12_000);
    const args = s.changesCalls().map((c) => c.args[2]);
    // 서버가 준 값이 그대로 다음 호출의 커서로 쓰인다
    expect(args).toContain("opaque-A");
    expect(args).toContain("opaque-B");
    expect(args.indexOf("opaque-B")).toBeGreaterThan(args.indexOf("opaque-A"));
  });

  it("slug 와 판을 함께 보낸다", async () => {
    const { s } = await boot();
    await advance(4_000);
    expect(s.changesCalls()[0]?.args.slice(0, 2)).toEqual(["sample-study", 1]);
  });

  it("응답이 오지 않는 동안 다음 호출을 겹쳐 보내지 않는다(동시 1개)", async () => {
    const { s } = await boot();
    s.queueChanges("hang");
    await advance(8_000);
    expect(s.changesCalls().length).toBe(1);
  });

  it("변경이 없으면 읽기(workspace·round)를 다시 부르지 않는다 — 폴링이 읽기를 직접 부르지 않음", async () => {
    const { s } = await boot();
    await advance(30_000);
    expect(s.changesCalls().length).toBeGreaterThan(5);
    expect(s.count("getWorkspace")).toBe(0);
    expect(s.count("getRound")).toBe(0);
  });

  it("읽기 목록 밖 메서드(다른 쓰기·전송)는 부르지 않는다", async () => {
    const { s } = await boot();
    await advance(20_000);
    expect(s.unexpected()).toEqual([]);
  });

  it("화면이 사라지면(unmount) 더 부르지 않는다", async () => {
    const { s, unmount } = await boot();
    await advance(4_000);
    unmount();
    s.reset();
    await advance(15_000);
    expect(s.changesCalls()).toHaveLength(0);
  });
});

describe("tx 묶음 → 바뀐 읽기만 무효화", () => {
  it("touched 에 든 라운드 읽기만 다시 받는다 (workspace 는 그대로)", async () => {
    const { s } = await boot();
    s.queueChanges({ cursor: "c1", txs: [{ tx_id: "tx-1", touched: ["round:research/2"] }] });
    await advance(5_000);
    expect(s.calls.filter((c) => c.method === "getRound" && c.args[2] === "research" && c.args[3] === "2").length).toBe(1);
    expect(s.count("getWorkspace")).toBe(0);
  });

  it("touched 가 workspace 이면 workspace 만", async () => {
    const { s } = await boot();
    s.queueChanges({ cursor: "c1", txs: [{ tx_id: "tx-1", touched: ["workspace"] }] });
    await advance(5_000);
    expect(s.count("getWorkspace")).toBe(1);
    expect(s.count("getRound")).toBe(0);
  });

  it("한 응답의 tx 여럿이 같은 키를 건드려도 그 읽기는 한 번만 다시 받는다", async () => {
    const { s } = await boot();
    s.queueChanges({
      cursor: "c1",
      txs: [
        { tx_id: "tx-1", touched: ["round:research/2", "workspace"] },
        { tx_id: "tx-2", touched: ["round:research/2"] },
        { tx_id: "tx-3", touched: ["workspace"] },
      ],
    });
    await advance(5_000);
    expect(s.count("getRound")).toBe(1);
    expect(s.count("getWorkspace")).toBe(1);
  });

  it("지금 화면에 없는 읽기(다른 라운드)나 모르는 키는 지금 다시 받지 않고, 깨지지도 않는다", async () => {
    const { s } = await boot();
    s.queueChanges({ cursor: "c1", txs: [{ tx_id: "tx-1", touched: ["round:plan/1", "nonsense", "round:research/99"] }] });
    await advance(5_000);
    expect(s.count("getRound")).toBe(0);
    expect(s.count("getWorkspace")).toBe(0);
    expect(screen.getByRole("main")).toBeInTheDocument();
  });

  it("숨은 사건(txs 가 비고 커서만 앞으로) 은 읽기를 부르지 않고, 새 커서를 다음 호출에 쓴다", async () => {
    const { s } = await boot();
    s.queueChanges({ cursor: "skip-1", txs: [] });
    await advance(9_000);
    expect(s.count("getRound") + s.count("getWorkspace")).toBe(0);
    expect(s.changesCalls().map((c) => c.args[2])).toContain("skip-1");
  });
});

describe("활성이 아닐 때 — 늦춘다", () => {
  it("탭이 숨겨지면 10초 동안 호출 0", async () => {
    const { s } = await boot();
    await advance(4_000);
    s.reset();
    setVisible(false);
    await advance(U1C.inactiveQuietMs);
    expect(s.changesCalls()).toHaveLength(0);
  });

  it("다시 보이면 1초 안에 한 번 받고 활성 박자로 돌아온다", async () => {
    const { s } = await boot();
    setVisible(false);
    await advance(U1C.inactiveQuietMs);
    s.reset();
    setVisible(true);
    await advance(1_000);
    expect(s.changesCalls().length).toBeGreaterThanOrEqual(1);
    s.reset();
    await advance(10_000);
    expect(s.changesCalls().length).toBeGreaterThanOrEqual(2);
  });

  it("숨은 동안 쌓인 변경도 돌아오면 반영된다", async () => {
    const { s } = await boot();
    setVisible(false);
    await advance(U1C.inactiveQuietMs);
    s.reset();
    s.queueChanges({ cursor: "c9", txs: [{ tx_id: "tx-9", touched: ["round:research/2"] }] });
    setVisible(true);
    await advance(3_000);
    expect(s.count("getRound")).toBe(1);
  });
});

describe("오류·시간 초과·커서 무효", () => {
  it.each([
    ["일반 오류", () => new Error("네트워크 끊김")],
    ["시간 초과", () => timeoutError()],
    ["서버 오류 봉투", () => apiError("conflict")],
  ])("%s 뒤: 다음 호출은 3.5초 안에 오지 않고(늦춤) 60초 안에 다시 시도, 성공하면 3초 박자로", async (_name, make) => {
    const { s } = await boot();
    s.queueChanges(make());
    await advance(90_000);
    const calls = s.changesCalls();
    expect(calls.length).toBeGreaterThan(3);
    // 첫 호출이 오류. 그다음 간격이 늦춰졌다
    const afterError = calls[1]!.at - calls[0]!.at;
    expect(afterError).toBeGreaterThanOrEqual(U1C.backoff.notBeforeMs);
    expect(afterError).toBeLessThanOrEqual(U1C.backoff.retryWithinMs);
    // 재시도가 성공한 뒤엔 다시 활성 박자
    expect(calls[2]!.at - calls[1]!.at).toBeLessThanOrEqual(U1C.active.maxGap);
  });

  it.each(["cursor_expired", "cursor_invalid"])("%s 이면 보이는 읽기(workspace·지금 라운드)만 다시 받고 커서는 null 로 다시 시작", async (code) => {
    const { s } = await boot();
    s.queueChanges({ cursor: "c1", txs: [] }, apiError(code));
    await advance(40_000);
    const calls = s.changesCalls();
    expect(s.count("getWorkspace")).toBeGreaterThanOrEqual(1);
    expect(s.calls.filter((c) => c.method === "getRound" && c.args[2] === "research" && c.args[3] === "2").length).toBeGreaterThanOrEqual(1);
    // 다른 라운드를 끌어오지 않는다
    expect(s.calls.filter((c) => c.method === "getRound" && !(c.args[2] === "research" && c.args[3] === "2"))).toEqual([]);
    // 무효 응답 뒤 첫 호출의 커서는 null
    const idx = calls.findIndex((c) => c.args[2] === "c1");
    expect(idx).toBeGreaterThan(-1);
    // calls[idx] 가 무효 응답을 받은 호출 → 그다음 호출은 처음부터
    expect(calls[idx + 1]?.args[2], "무효 응답 다음 호출").toBeNull();
  });

  it("커서 무효여도 주소와 본문 DOM 은 그대로(전체 새로고침·다시 만들기 없음)", async () => {
    const { s, router } = await boot();
    const mainBefore = screen.getByRole("main");
    const hrefBefore = router.state.location.pathname + router.state.location.search;
    s.queueChanges(apiError("cursor_expired"));
    await advance(20_000);
    expect(screen.getByRole("main")).toBe(mainBefore);
    expect(router.state.location.pathname + router.state.location.search).toBe(hrefBefore);
  });
});

describe("첫 호출은 마운트 즉시 — 기준 커서 (R1 권장 3)", () => {
  it("화면이 붙자마자(3초를 기다리지 않고) cursor=null 로 한 번 부른다", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const s = createScriptedClient();
    const t0 = Date.now();
    await renderApp(CURRENT, { width: WIDTHS.wide1440 }, { client: s.client });
    await ready();
    await advance(500);
    const first = s.changesCalls()[0];
    expect(first, "마운트 뒤 0.5초 안에 첫 호출이 있어야 한다").toBeDefined();
    expect(first!.args).toEqual(["sample-study", 1, null]);
    expect(first!.at - t0, "첫 읽기와 기준 사이에 3초 틈을 두지 않는다").toBeLessThan(U1C.active.minGap);
  });

  it("기준을 받은 뒤 다음 호출은 그 커서로 — 첫 호출만 null", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const s = createScriptedClient();
    s.queueChanges({ cursor: "base-0", txs: [] });
    await renderApp(CURRENT, { width: WIDTHS.wide1440 }, { client: s.client });
    await ready();
    await advance(8_000);
    const args = s.changesCalls().map((c) => c.args[2]);
    expect(args[0]).toBeNull();
    expect(args[1]).toBe("base-0");
    expect(args.slice(1).includes(null), "이후 호출은 null 이 아니다").toBe(false);
  });

  it("기준 호출이 실패하면 늦춰 다시 시도하되 계속 null 로 기준부터 받는다", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const s = createScriptedClient();
    s.queueChanges(new Error("끊김"));
    await renderApp(CURRENT, { width: WIDTHS.wide1440 }, { client: s.client });
    await ready();
    await advance(70_000);
    const calls = s.changesCalls();
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(calls[0]!.args[2]).toBeNull();
    expect(calls[1]!.args[2], "기준을 못 받았으니 또 null").toBeNull();
    expect(calls[1]!.at - calls[0]!.at).toBeGreaterThanOrEqual(U1C.backoff.notBeforeMs);
  });

  it.each(["cursor_expired", "cursor_invalid"])("%s 재동기화 뒤에도 3초를 기다리지 않고 곧바로 cursor=null 로 기준을 다시 잡는다", async (code) => {
    const { s } = await boot();
    await advance(500); // 마운트 즉시 기준 호출이 끝난 뒤
    s.reset();
    s.queueChanges(apiError(code));
    await advance(U1C.active.every + 1_000); // 활성 박자의 다음 호출 = 오류
    const calls = s.changesCalls();
    expect(calls.length, "오류 호출 뒤 곧바로 다음 호출까지 와 있어야 한다").toBeGreaterThanOrEqual(2);
    const errIdx = 0;
    expect(calls[errIdx + 1]!.args[2], "재동기화 뒤 첫 호출은 기준(null)").toBeNull();
    expect(calls[errIdx + 1]!.at - calls[errIdx]!.at, "3초 틈 없음").toBeLessThan(U1C.active.minGap);
  });
});

describe("시간 초과 가드 15초 → 늦춤 → 재개 (R1 권장 8)", () => {
  it("응답이 안 오는 호출은 15초 뒤 시간 초과로 끝나고, 그 뒤 늦춰서(3.5초 이상) 다시 부르고, 성공하면 3초 박자로 돌아온다", async () => {
    const { s } = await boot();
    await advance(500);
    s.reset();
    s.queueChanges("hang");
    await advance(U1C.active.every + 500); // 멈춘 호출이 나간다
    const hangAt = s.changesCalls()[0]!.at;
    await advance(14_000 - 500); // 아직 15초 전
    expect(s.changesCalls().length, "15초 전에는 겹쳐 보내지 않는다").toBe(1);
    await advance(70_000);
    const calls = s.changesCalls();
    expect(calls.length).toBeGreaterThanOrEqual(3);
    const retryGap = calls[1]!.at - hangAt;
    expect(retryGap, "시간 초과(15초) + 늦춤").toBeGreaterThanOrEqual(15_000 + U1C.backoff.notBeforeMs);
    expect(retryGap).toBeLessThanOrEqual(15_000 + U1C.backoff.retryWithinMs);
    expect(calls[2]!.at - calls[1]!.at, "성공 뒤 활성 박자").toBeLessThanOrEqual(U1C.active.maxGap);
    expect(screen.getByRole("main"), "화면 자료는 그대로").toBeInTheDocument();
  });

  it("멈춘 호출이 시간 초과로 끝난 뒤 늦게 도착하는 거절이 처리되지 않은 거부(unhandledrejection)를 만들지 않는다", async () => {
    const { s } = await boot();
    await advance(500);
    const seen: unknown[] = [];
    const onRej = (e: PromiseRejectionEvent | Event) => seen.push(e);
    window.addEventListener("unhandledrejection", onRej);
    process.on("unhandledRejection", onRej as never);
    try {
      s.queueChanges("hang");
      await advance(40_000);
      expect(seen).toEqual([]);
    } finally {
      window.removeEventListener("unhandledrejection", onRej);
      process.off("unhandledRejection", onRej as never);
    }
  });
});

describe("오류 뒤 숨김 → 다시 보임 (R1 권장 8: failures>0 분기)", () => {
  it("오류가 난 뒤 숨겼다가 다시 보이면 곧바로(1초 안) 부르지 않고 늦춤 박자로 재개한 뒤 성공하면 3초 박자", async () => {
    const { s } = await boot();
    await advance(500);
    s.reset();
    s.queueChanges(new Error("끊김"));
    await advance(U1C.active.every + 500); // 오류 호출이 나가고 실패 처리됨
    expect(s.changesCalls().length).toBe(1);
    setVisible(false);
    await advance(U1C.inactiveQuietMs);
    expect(s.changesCalls().length, "숨은 동안 0").toBe(1);
    s.reset();
    setVisible(true);
    await advance(1_000);
    expect(s.changesCalls().length, "오류 뒤에는 보이자마자 곧바로 부르지 않는다").toBe(0);
    await advance(U1C.backoff.retryWithinMs);
    const calls = s.changesCalls();
    expect(calls.length, "늦춤 박자로 재개").toBeGreaterThanOrEqual(2);
    expect(calls[1]!.at - calls[0]!.at, "성공 뒤 활성 박자").toBeLessThanOrEqual(U1C.active.maxGap);
  });

  it("호출이 떠 있는 채 숨겨졌다가 숨은 동안 시간 초과로 끝나면, 다시 보일 때 늦춤 박자로 재개한다(숨은 동안 호출 0)", async () => {
    const { s } = await boot();
    await advance(500);
    s.reset();
    s.queueChanges("hang");
    await advance(U1C.active.every + 500);
    expect(s.changesCalls().length).toBe(1);
    setVisible(false);
    await advance(20_000); // 15초 가드가 숨은 동안 끝난다
    expect(s.changesCalls().length, "숨은 동안 새 호출 없음").toBe(1);
    s.reset();
    setVisible(true);
    await advance(1_000);
    expect(s.changesCalls().length, "실패 뒤 다시 보임은 늦춤").toBe(0);
    await advance(U1C.backoff.retryWithinMs);
    expect(s.changesCalls().length).toBeGreaterThanOrEqual(2);
  });
});

