// SEL-83 U1c — 초안 모듈 계약: 열쇠 여섯 칸 · 지우개 · 저장소 접근 불가 때 모듈 수준 메모리 대체 (Vitest, jsdom).
// 계약: src/test/contract.ts 머리말 "초안". 구현 위치 제안: src/lib/draft.ts 에 draftKey · clearDraft 추가.
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as draft from "@/lib/draft";
import { useDraft } from "@/lib/draft";
import { U1C } from "@/test/contract";

type Parts = { project: string; user: string; edition: number; form: number; question: string; version: number; field: "answer" | "opinion" };
const keyOf = (parts: Parts): string => (draft as unknown as { draftKey: (p: Parts) => string }).draftKey(parts);
const clear = (key: string): void => (draft as unknown as { clearDraft: (k: string) => void }).clearDraft(key);
const BASE: Parts = { project: "sample-study", user: U1C.draftUser, edition: 1, form: 2, question: "q-21", version: 1, field: "answer" };

beforeEach(() => window.sessionStorage.clear());
const stored = () => ({ ...window.sessionStorage }) as Record<string, string>;

describe("draftKey — 프로젝트·사용자·판·폼 버전·질문·질문 버전(+칸)", () => {
  it("값이 모두 키 글자에 들어 있다", () => {
    const k = keyOf(BASE);
    for (const part of ["sample-study", U1C.draftUser, "q-21", "answer"]) expect(k, part).toContain(part);
    expect(k).toMatch(/1/);
    expect(k).toMatch(/2/);
  });

  it.each([
    ["project", { project: "other-study" }],
    ["user", { user: "someone" }],
    ["edition", { edition: 2 }],
    ["form", { form: 3 }],
    ["question", { question: "q-22" }],
    ["version", { version: 2 }],
    ["field", { field: "opinion" as const }],
  ])("%s 가 다르면 키가 다르다", (_name, change) => {
    expect(keyOf({ ...BASE, ...change })).not.toBe(keyOf(BASE));
  });

  it("같은 값이면 같은 키(안정적)", () => {
    expect(keyOf({ ...BASE })).toBe(keyOf({ ...BASE }));
  });

  it("칸 경계가 섞이지 않는다 — (edition 1, form 12) 와 (edition 11, form 2) 는 다른 키", () => {
    expect(keyOf({ ...BASE, edition: 1, form: 12 })).not.toBe(keyOf({ ...BASE, edition: 11, form: 2 }));
  });

  it("useDraft 에 이 키를 넘기면 sessionStorage 항목이 `pes-draft:` + 키 로 생긴다", () => {
    const key = keyOf(BASE);
    const { result } = renderHook(() => useDraft(key));
    act(() => result.current[1]("초안"));
    expect(stored()[`pes-draft:${key}`]).toBe("초안");
  });
});

describe("clearDraft — 확정(영수증) 성공 뒤 그 초안만 지운다", () => {
  it("저장 항목을 지우고, 다시 읽으면 빈 글", () => {
    const key = keyOf(BASE);
    const a = renderHook(() => useDraft(key));
    act(() => a.result.current[1]("보낼 글"));
    a.unmount();
    clear(key);
    expect(Object.keys(stored()).filter((k) => k.endsWith(key))).toEqual([]);
    const b = renderHook(() => useDraft(key));
    expect(b.result.current[0]).toBe("");
  });

  it("다른 질문·다른 버전·다른 칸의 초안은 그대로", () => {
    const keys = [BASE, { ...BASE, question: "q-22" }, { ...BASE, version: 2 }, { ...BASE, field: "opinion" as const }].map(keyOf);
    for (const k of keys) {
      const h = renderHook(() => useDraft(k));
      act(() => h.result.current[1](`글 ${k}`));
      h.unmount();
    }
    clear(keys[0]!);
    const left = stored();
    expect(left[`pes-draft:${keys[0]}`]).toBeUndefined();
    for (const k of keys.slice(1)) expect(left[`pes-draft:${k}`], k).toBe(`글 ${k}`);
  });

  it("화면에 떠 있는 훅도 지운 뒤에는 빈 글로 돌아간다", () => {
    const key = keyOf(BASE);
    const h = renderHook(() => useDraft(key));
    act(() => h.result.current[1]("보낼 글"));
    act(() => clear(key));
    expect(h.result.current[0]).toBe("");
  });

  it("없는 키를 지워도 예외가 없다", () => {
    expect(() => clear("없는-키")).not.toThrow();
  });
});

describe("저장소를 아예 못 쓰는 환경(sessionStorage 접근이 예외) — 모듈 수준 메모리 대체", () => {
  const real = Object.getOwnPropertyDescriptor(window, "sessionStorage")!;
  afterEach(() => Object.defineProperty(window, "sessionStorage", real));
  const block = () =>
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      get() {
        throw new DOMException("차단", "SecurityError");
      },
    });

  it("훅이 사라졌다 다시 생겨도(화면 이동) 같은 키의 글이 남는다", () => {
    block();
    const key = keyOf({ ...BASE, project: "memory-only" });
    const a = renderHook(() => useDraft(key));
    act(() => a.result.current[1]("메모리에만"));
    a.unmount();
    const b = renderHook(() => useDraft(key));
    expect(b.result.current[0]).toBe("메모리에만");
  });

  it("다른 키 글과 섞이지 않는다", () => {
    block();
    const k1 = keyOf({ ...BASE, project: "mem-a" });
    const k2 = keyOf({ ...BASE, project: "mem-b" });
    const h1 = renderHook(() => useDraft(k1));
    act(() => h1.result.current[1]("가"));
    const h2 = renderHook(() => useDraft(k2));
    expect(h2.result.current[0]).toBe("");
  });

  it("clearDraft 는 메모리 대체 값도 지운다", () => {
    block();
    const key = keyOf({ ...BASE, project: "mem-clear" });
    const a = renderHook(() => useDraft(key));
    act(() => a.result.current[1]("지울 글"));
    a.unmount();
    clear(key);
    const b = renderHook(() => useDraft(key));
    expect(b.result.current[0]).toBe("");
  });

  it("읽기만 막혀도(getItem 예외) 쓴 글은 이 화면에서 읽힌다", () => {
    const proto = Storage.prototype;
    const realGet = proto.getItem;
    proto.getItem = () => {
      throw new Error("읽기 차단");
    };
    try {
      const key = keyOf({ ...BASE, project: "read-blocked" });
      const h = renderHook(() => useDraft(key));
      act(() => h.result.current[1]("읽기 막힘"));
      expect(h.result.current[0]).toBe("읽기 막힘");
    } finally {
      proto.getItem = realGet;
    }
  });
});

describe("저장소는 살아 있는데 쓰기만 실패(용량 초과) — 메모리에 든 글을 다시 읽는다 (R1 권장 2)", () => {
  const proto = Storage.prototype;
  const realSet = proto.setItem;
  afterEach(() => {
    proto.setItem = realSet;
  });
  const quotaFull = () => {
    proto.setItem = () => {
      throw new DOMException("용량 초과", "QuotaExceededError");
    };
  };

  it("훅을 지웠다 다시 만들어도(화면 이동) 메모리에 든 초안이 읽힌다", () => {
    quotaFull();
    const key = keyOf({ ...BASE, project: "quota-full" });
    const a = renderHook(() => useDraft(key));
    act(() => a.result.current[1]("용량이 가득 찬 뒤에 쓴 글"));
    expect(stored(), "저장소에는 못 썼다").toEqual({});
    a.unmount();
    const b = renderHook(() => useDraft(key));
    expect(b.result.current[0]).toBe("용량이 가득 찬 뒤에 쓴 글");
  });

  it("다른 키 글과 섞이지 않고, 저장소 값이 있는 키는 저장소 값이 이긴다", () => {
    const real = keyOf({ ...BASE, project: "quota-real" });
    const other = keyOf({ ...BASE, project: "quota-other" });
    const mem = keyOf({ ...BASE, project: "quota-mem" });
    window.sessionStorage.setItem(`pes-draft:${real}`, "저장소 글");
    quotaFull();
    const m = renderHook(() => useDraft(mem));
    act(() => m.result.current[1]("메모리 글"));
    m.unmount();
    expect(renderHook(() => useDraft(real)).result.current[0]).toBe("저장소 글");
    expect(renderHook(() => useDraft(other)).result.current[0]).toBe("");
    expect(renderHook(() => useDraft(mem)).result.current[0]).toBe("메모리 글");
  });

  it("clearDraft 는 이 메모리 값도 지운다", () => {
    quotaFull();
    const key = keyOf({ ...BASE, project: "quota-clear" });
    const a = renderHook(() => useDraft(key));
    act(() => a.result.current[1]("지울 글"));
    a.unmount();
    clear(key);
    expect(renderHook(() => useDraft(key)).result.current[0]).toBe("");
  });

  it("저장소 쓰기가 다시 되면 그 값이 이기고 메모리 값은 남지 않는다", () => {
    const key = keyOf({ ...BASE, project: "quota-recover" });
    quotaFull();
    const a = renderHook(() => useDraft(key));
    act(() => a.result.current[1]("메모리"));
    proto.setItem = realSet;
    act(() => a.result.current[1]("저장소로"));
    a.unmount();
    expect(window.sessionStorage.getItem(`pes-draft:${key}`)).toBe("저장소로");
    expect(renderHook(() => useDraft(key)).result.current[0]).toBe("저장소로");
    window.sessionStorage.removeItem(`pes-draft:${key}`);
    expect(renderHook(() => useDraft(key)).result.current[0], "옛 메모리 값이 되살아나지 않는다").toBe("");
  });
});
