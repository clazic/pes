// SEL-85 1차 리뷰 권장 3 — 교환 요청의 시간 제한 (Vitest, jsdom, fetch 와 시계는 가짜). 새 시험만 더한다(기존 시험은 그대로).
//
//   - 서버가 연결만 받고 답을 안 주면 5초 뒤 끊고 null 로 떨어진다 → main.tsx 가 안내를 그린다(빈 화면에 멈추지 않는다).
//   - 끊을 때 요청에 실은 AbortSignal 도 abort 된다(진짜 fetch 는 연결을 닫는다). 조각은 요청 전에 이미 지워져 있다.
//   - 시간 제한이 재시도를 만들지 않는다(요청 1번). 제때 온 답은 그대로 쓰이고 타이머는 남지 않는다.
//   - 시간 안에 오는 느린 답(4.9초)은 받는다.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EXCHANGE_TIMEOUT_MS, exchangeHandoff } from "@/api/handoff-exchange";

const SESSION = "synthetic-sel85-session-0123456789";
const CODE = "AbCdEfGhIjKlMnOpQrStUv_-0123";
const PATH = "/p/demo/e/1/s/plan/r/start";
const app = () => (window as unknown as { __PES_APP__?: unknown }).__PES_APP__;
const okResponse = () => new Response(JSON.stringify({ format_version: "1.0", request_id: "r", data: { session: SESSION, projects: { demo: "pj-1" } } }), { status: 200 });

beforeEach(() => {
  vi.useFakeTimers();
  window.sessionStorage.clear();
  delete (window as unknown as Record<string, unknown>).__PES_APP__;
  window.history.replaceState(null, "", `${PATH}#code=${CODE}`);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("교환 요청의 시간 제한", () => {
  it("5초를 넘기면 끊고 null — 조각은 이미 지워졌고 요청은 한 번뿐이며 __PES_APP__ 가 없다", async () => {
    expect(EXCHANGE_TIMEOUT_MS).toBe(5000);
    const signals: AbortSignal[] = [];
    const fn = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      signals.push(init!.signal as AbortSignal);
      return new Promise<Response>(() => undefined); // 답이 영영 안 온다(신호도 무시하는 가짜)
    });
    let result: unknown = "pending";
    const run = exchangeHandoff(window, fn as unknown as typeof fetch).then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(EXCHANGE_TIMEOUT_MS - 1);
    expect(result).toBe("pending");
    expect(window.location.hash).toBe("");
    await vi.advanceTimersByTimeAsync(1);
    await run;
    expect(result).toBeNull();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(true);
    expect(app()).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fn).toHaveBeenCalledTimes(1); // 재시도 없음
  });

  it("신호를 지키는 fetch 는 abort 로 거절되어도 null", async () => {
    const fn = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))));
    const run = exchangeHandoff(window, fn as unknown as typeof fetch);
    await vi.advanceTimersByTimeAsync(EXCHANGE_TIMEOUT_MS);
    expect(await run).toBeNull();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("시간 안에 온 느린 답은 받고, 끝나면 타이머가 남지 않는다", async () => {
    const fn = vi.fn(() => new Promise<Response>((resolve) => setTimeout(() => resolve(okResponse()), EXCHANGE_TIMEOUT_MS - 100)));
    const run = exchangeHandoff(window, fn as unknown as typeof fetch);
    await vi.advanceTimersByTimeAsync(EXCHANGE_TIMEOUT_MS - 100);
    expect(await run).toEqual({ api: "http", session: SESSION, projects: { demo: "pj-1" } });
    expect(app()).toEqual({ api: "http", session: SESSION, projects: { demo: "pj-1" } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("조각이 없으면 요청도 타이머도 없다", async () => {
    window.history.replaceState(null, "", PATH);
    const fn = vi.fn();
    expect(await exchangeHandoff(window, fn as unknown as typeof fetch)).toBeNull();
    expect(fn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
