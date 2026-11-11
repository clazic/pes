// SEL-81 U1a (R1 권장 9) — useDraft: 키가 바뀌면(질문이 제자리에서 새 버전이 되면) 새 키의 저장값을 다시 읽고, 옛 키에 쓰지 않는다 (설계 12.5-6).
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useDraft } from "@/lib/draft";

beforeEach(() => window.sessionStorage.clear());
const stored = () => ({ ...window.sessionStorage }) as Record<string, string>;

describe("useDraft", () => {
  it("같은 키로 다시 그리면 저장한 글이 돌아온다", () => {
    const a = renderHook(() => useDraft("k1"));
    act(() => a.result.current[1]("초안"));
    a.unmount();
    const b = renderHook(() => useDraft("k1"));
    expect(b.result.current[0]).toBe("초안");
  });

  it("키가 바뀌면 옛 키의 글이 보이지 않는다(새 버전으로 옮겨 가지 않음)", () => {
    const { result, rerender } = renderHook(({ k }) => useDraft(k), { initialProps: { k: "q-21:v1" } });
    act(() => result.current[1]("v1 초안"));
    rerender({ k: "q-21:v2" });
    expect(result.current[0]).toBe("");
  });

  it("키가 바뀐 뒤 입력은 새 키에만 저장되고 옛 키 저장값은 그대로", () => {
    const { result, rerender } = renderHook(({ k }) => useDraft(k), { initialProps: { k: "q-21:v1" } });
    act(() => result.current[1]("v1 초안"));
    rerender({ k: "q-21:v2" });
    act(() => result.current[1]("v2 초안"));
    const entries = Object.entries(stored());
    expect(entries.find(([key]) => key.endsWith("q-21:v1"))?.[1]).toBe("v1 초안");
    expect(entries.find(([key]) => key.endsWith("q-21:v2"))?.[1]).toBe("v2 초안");
  });

  it("키가 바뀌면 새 키에 이미 저장된 글을 읽어 온다", () => {
    window.sessionStorage.setItem("pes-draft:q-21:v2", "저장돼 있던 v2");
    const { result, rerender } = renderHook(({ k }) => useDraft(k), { initialProps: { k: "q-21:v1" } });
    rerender({ k: "q-21:v2" });
    expect(result.current[0]).toBe("저장돼 있던 v2");
  });

  it("저장소를 못 써도(예외) 이 화면 안에서는 쓰고 읽힌다", () => {
    const real = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error("차단");
    };
    try {
      const { result } = renderHook(() => useDraft("blocked"));
      act(() => result.current[1]("메모리 안에서만"));
      expect(result.current[0]).toBe("메모리 안에서만");
    } finally {
      Storage.prototype.setItem = real;
    }
  });
});
