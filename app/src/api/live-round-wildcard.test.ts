// SEL-82 × SEL-83 합치기: 실제 API(U1b)의 사건에는 라운드가 없어 http 클라이언트가 touched 'round:*' 를 낸다.
// 갱신 층(U1c)은 그것을 '그 판의 모든 라운드 읽기'로 무효화해야 한다(모르는 키로 무시하면 라운드 화면이 갱신되지 않는다).
import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { touchedToQueryKey } from "@/api/live";
import { keys } from "@/api/queries";

describe("touched 'round:*'", () => {
  it("is the prefix key of every round read of that edition", () => {
    expect(touchedToQueryKey("round:*", "s", 1)).toEqual(["round", "s", 1]);
    expect(touchedToQueryKey("round:research/2", "s", 1)).toEqual(keys.round("s", 1, "research", "2"));
    expect(touchedToQueryKey("round:bogus", "s", 1)).toBeNull();
  });

  it("invalidating that prefix (not exact) marks every round of the edition, and only that edition", async () => {
    const qc = new QueryClient();
    qc.setQueryData(keys.round("s", 1, "research", "2"), { ok: 1 });
    qc.setQueryData(keys.round("s", 1, "plan", "start"), { ok: 1 });
    qc.setQueryData(keys.round("s", 2, "plan", "1"), { ok: 1 });
    await qc.invalidateQueries({ queryKey: touchedToQueryKey("round:*", "s", 1)!, exact: false, refetchType: "none" });
    expect(qc.getQueryState(keys.round("s", 1, "research", "2"))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(keys.round("s", 1, "plan", "start"))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(keys.round("s", 2, "plan", "1"))?.isInvalidated).toBe(false);
  });
});
