// SEL-94 U3b 최종 리뷰 2(Codex) 고침 시험 — 다시 읽는 동안 이어 쓴 글이 복원 초안에 남는다 · 시험 클라이언트 네 쓰기의 영수증 version_id = 저장 행 version_id.
// 기존 시험은 그대로 두고 고친 동작만 새로 못 박는다. 합성 자료뿐.
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FORMAT_VERSION, PesApiError } from "@/api/types";
import { boot, rowButton, rowOf, row } from "@/test/u3b";

afterEach(() => cleanup());

const dialog = (name: RegExp) => screen.findByRole("dialog", { name });
const submit = (d: HTMLElement) => within(d).getByRole("button", { name: "판단 기록" });
const box = (d: HTMLElement, name: string) => within(d).getByRole("textbox", { name }) as HTMLTextAreaElement;
const conflict = () => new PesApiError({ format_version: FORMAT_VERSION, error: { code: "rev_conflict", message: "기준 버전이 현재와 다릅니다.", retryable: false, next_action: "reread_context" }, request_id: "req-final2" });

/** 다시 읽기(가정·결정 읽기)를 release() 까지 붙잡는다 — 읽는 동안 사용자가 이어 쓸 수 있게 */
function holdReads(client: { getAssumptions: (...a: never[]) => Promise<unknown>; getDecisions: (...a: never[]) => Promise<unknown> }) {
  let release: () => void = () => {};
  let armed = false;
  const gate = new Promise<void>((res) => (release = res));
  for (const m of ["getAssumptions", "getDecisions"] as const) {
    const orig = client[m].bind(client) as (...a: unknown[]) => Promise<unknown>;
    (client as unknown as Record<string, unknown>)[m] = async (...a: unknown[]) => {
      if (armed) await gate;
      return orig(...a);
    };
  }
  return { arm: () => (armed = true), release: () => release() };
}

describe("필수 1 — 다시 읽는 동안 이어 쓴 글도 복원 초안에 남는다", () => {
  it("가정 고침: 다시 보기를 누른 뒤 읽는 동안 두 칸을 이어 쓰면, 읽기가 끝나 다시 열 때 이어 쓴 글까지 그대로 있다", async () => {
    const { u3, user } = await boot();
    const gate = holdReads(u3.client as never);
    await user.click(rowButton(await rowOf("assumption", "as-1"), "고침"));
    const d = await dialog(/가정 고침/);
    await user.clear(box(d, "고친 가정"));
    await user.type(box(d, "고친 가정"), "고친 문장");
    await user.type(box(d, "근거"), "근거 글");
    u3.failNext(conflict());
    await user.click(submit(d));
    await within(d).findByRole("button", { name: "다시 보기" });

    gate.arm();
    // 읽는 동안 이어 쓴다 (읽기가 붙잡힌 상태라 대화 상자는 아직 열려 있다) — 클릭은 이미 지나갔다
    await user.click(within(d).getByRole("button", { name: "다시 보기" }));
    await user.type(box(d, "고친 가정"), " 이어쓴문장");
    await user.type(box(d, "근거"), " 이어쓴근거");
    expect(screen.queryByRole("dialog")).not.toBeNull();
    gate.release();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await user.click(rowButton(row("assumption", "as-1")!, "고침"));
    const again = await dialog(/가정 고침/);
    expect(box(again, "고친 가정").value).toBe("고친 문장 이어쓴문장");
    expect(box(again, "근거").value).toBe("근거 글 이어쓴근거");
  });

  it("결정 대체도 같은 경로 — 읽는 동안 이어 쓴 새 결정 · 근거가 다시 열 때 남는다", async () => {
    const { u3, user } = await boot();
    const gate = holdReads(u3.client as never);
    await user.click(rowButton(await rowOf("decision", "dec-2"), "대체"));
    const d = await dialog(/결정 대체/);
    await user.type(box(d, "새 결정"), "새 결정 글");
    await user.type(box(d, "근거"), "대체 근거");
    u3.failNext(conflict());
    await user.click(submit(d));
    await within(d).findByRole("button", { name: "다시 보기" });

    gate.arm();
    await user.click(within(d).getByRole("button", { name: "다시 보기" }));
    await user.type(box(d, "새 결정"), " +덧붙임");
    await user.type(box(d, "근거"), " +덧붙임2");
    gate.release();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await user.click(rowButton(row("decision", "dec-2")!, "대체"));
    const again = await dialog(/결정 대체/);
    expect(box(again, "새 결정").value).toBe("새 결정 글 +덧붙임");
    expect(box(again, "근거").value).toBe("대체 근거 +덧붙임2");
  });
});

describe("권장 1 — 네 쓰기 모두 성공 영수증의 version_id = 재조회한 저장 행의 version_id", () => {
  it("가정 판단 · 결정 채택 · 대체(새 행) · 철회", async () => {
    const { u3 } = await boot();
    const ws = ["sample-study", 1] as const;
    const a = await u3.client.assessAssumption(...ws, "as-1", { verdict: "confirm", rationale: "", base_version_id: "as-1-v1" }, "q1");
    expect((await u3.client.getAssumptions(...ws)).find((x) => x.object_id === a.data.object_id)!.version_id).toBe(a.data.version_id);

    const ad = await u3.client.adoptDecision(...ws, "dec-4", { rationale: "", base_version_id: "dec-4-v1" }, "q2");
    expect((await u3.client.getDecisions(...ws)).find((x) => x.object_id === ad.data.object_id)!.version_id).toBe(ad.data.version_id);

    const sup = await u3.client.supersedeDecision(...ws, "dec-2", { statement: "새 결정", rationale: "x", base_version_id: "dec-2-v1" }, "q3");
    const rows = await u3.client.getDecisions(...ws);
    expect(sup.data.object_id).not.toBe("dec-2");
    expect(rows.find((x) => x.object_id === sup.data.object_id)!.version_id).toBe(sup.data.version_id);

    const rv = await u3.client.revokeDecision(...ws, "dec-3", { rationale: "x", base_version_id: "dec-3-v1" }, "q4");
    expect((await u3.client.getDecisions(...ws)).find((x) => x.object_id === rv.data.object_id)!.version_id).toBe(rv.data.version_id);
  });
});
