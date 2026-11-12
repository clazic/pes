// SEL-100 1차 리뷰(R1) 고침 시험 — 화면이 서버가 안 주는 숫자를 말하지 않는다 · 목록에 없는 옛 결정을 uuid 로 보이지 않는다.
// 기존 시험은 그대로 두고 고친 동작만 새로 못 박는다. 합성 자료뿐.
import { cleanup, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DECISIONS, RECORDS, REFLECTION_FULL, ROUND_RESEARCH_2, boot, fullData, region, rowOf } from "@/test/u3b";

afterEach(() => cleanup());

const text = (el: HTMLElement | null) => el?.textContent ?? "";

describe("필수 2 — 반영 요약은 서버가 주지 않은 '보낸 의견 수'를 말하지 않는다", () => {
  const summary = async (view: (typeof REFLECTION_FULL) | { submission: "submitted"; sent_count: number; entries: [] }) => {
    await boot({ ...fullData(), reflections: { "research/2": view } }, ROUND_RESEARCH_2, {});
    const r = region("반영 내역");
    await waitFor(() => expect(text(r).trim().length).toBeGreaterThan("반영 내역".length));
    return text(r);
  };

  it("제출했지만 처리된 줄이 0건이면 '의견 N개를 보냈지만' 같은 숫자 문장이 없다", async () => {
    const t = await summary({ submission: "submitted", sent_count: 3, entries: [] });
    expect(t).toMatch(/처리 0건/);
    expect(t).toMatch(/제출/);
    expect(t).not.toMatch(/의견 \d+개/);
    expect(t).not.toMatch(/3개/);
  });

  it("처리된 줄이 있으면 '처리된 줄 수'만 말하고 의견 수는 말하지 않는다", async () => {
    const t = await summary({ ...REFLECTION_FULL, sent_count: 99 });
    expect(t).toContain(`${REFLECTION_FULL.entries.length}줄이 처리됐어요`);
    expect(t).not.toMatch(/의견 \d+개/);
    expect(t).not.toMatch(/99/);
  });
});

describe("권장 2 — 같은 목록에 없는 옛 결정은 uuid 가 아니라 말로", () => {
  it("대체한 옛 결정의 문장이 비어 있으면 id 를 보이지 않고 링크도 만들지 않는다", async () => {
    const data = fullData();
    const dec2 = data.decisions.find((x) => x.object_id === "dec-2")!;
    dec2.supersedes = { object_id: "dec-gone-uuid-0000", statement: "" };
    await boot(data, RECORDS, {});
    const line = await rowOf("decision", "dec-2");
    const note = line.querySelector('[data-cell="supersedes"]') as HTMLElement;
    expect(text(note)).toContain("이 목록에 없는 결정");
    expect(text(note)).not.toContain("dec-gone-uuid-0000");
    expect(note.querySelector("a")).toBeNull();
  });

  it("문장이 있으면 지금처럼 링크로 보인다", async () => {
    await boot(fullData(), RECORDS, {});
    const line = await rowOf("decision", "dec-2");
    const a = (line.querySelector('[data-cell="supersedes"]') as HTMLElement).querySelector("a");
    expect(a?.textContent).toBe(DECISIONS.find((x) => x.object_id === "dec-2")!.supersedes!.statement);
  });
});
