import { describe, expect, it } from "vitest";
import type { ProblemKind, ProblemView, WorkspaceView } from "@/api/types";
import { approvalBlockers } from "./research-ui";

/** 합성 자료 — approvalBlockers가 읽는 칸(problems · approval.reasons)만 채운다 */
function problem(id: string, kind: ProblemKind, blocks: string[]): ProblemView {
  return { id, kind, state: "open", title: `막힌 것 ${id}`, cause: "합성 원인", where: { label: "위치", href: "#" }, options: [], found: "합성", blocks };
}
function ws(reasons: string[], problems: ProblemView[]): WorkspaceView {
  return { problems, approval: { stage_label: "조사", reasons, note: "" } } as unknown as WorkspaceView;
}

describe("approvalBlockers — 승인을 막는 것의 수(설계 18.3-4)", () => {
  it("필수 질문 미응답 + 사유 “필수 답 1개 없음” + 다른 사유 1개 → 필수 사유는 빠지고 total = 남은 사유 1 + 막힌 것 수", () => {
    const required = problem("q1", "required_question", ["단계 승인", "다음 실행"]);
    const out = approvalBlockers(ws(["필수 답 1개 없음", "실행이 끝나지 않음"], [required]));
    expect(out.reasons).toEqual(["실행이 끝나지 않음"]);
    expect(out.blocking).toEqual([required]);
    expect(out.total).toBe(2);
  });

  it("막힌 것이 여럿이면 total에 모두 더한다", () => {
    const out = approvalBlockers(
      ws(
        ["필수 답 1개 없음", "실행이 끝나지 않음"],
        [problem("q1", "required_question", ["단계 승인"]), problem("w1", "weak_evidence", ["단계 승인"]), problem("c1", "conflict_data", ["단계 승인"])],
      ),
    );
    expect(out.reasons).toEqual(["실행이 끝나지 않음"]);
    expect(out.blocking.map((p) => p.id)).toEqual(["q1", "w1", "c1"]);
    expect(out.total).toBe(4);
  });

  it("“필수 시작 질문 4개 답 없음”처럼 “필수”로 시작하는 사유도 한 번만(막힌 것 쪽에서 센다)", () => {
    const out = approvalBlockers(ws(["필수 시작 질문 4개 답 없음", "실행 시작 전"], [problem("q1", "required_question", ["단계 승인"])]));
    expect(out.reasons).toEqual(["실행 시작 전"]);
    expect(out.total).toBe(2);
  });

  it("승인을 막지 않는 막힌 것(다음 실행만 막음 · 아무것도 안 막음)은 세지 않는다", () => {
    const out = approvalBlockers(ws(["실행이 끝나지 않음"], [problem("r1", "run_stopped", ["다음 실행"]), problem("s1", "sync_conflict", [])]));
    expect(out.blocking).toEqual([]);
    expect(out.reasons).toEqual(["실행이 끝나지 않음"]);
    expect(out.total).toBe(1);
  });

  it("막힌 것 없음 → reasons 그대로, blocking 0, total = 사유 수", () => {
    const reasons = ["필수 답 1개 없음", "실행이 끝나지 않음"];
    const out = approvalBlockers(ws(reasons, []));
    expect(out.reasons).toEqual(reasons);
    expect(out.blocking).toHaveLength(0);
    expect(out.total).toBe(2);
  });

  it("막힌 것 없음 + 사유 없음 → 모두 0(승인할 수 있음)", () => {
    const out = approvalBlockers(ws([], []));
    expect(out).toEqual({ reasons: [], blocking: [], total: 0 });
  });

  it("필수 질문이 승인을 막지 않으면(다음 실행만 막음) “필수 …” 사유는 그대로 센다", () => {
    const out = approvalBlockers(ws(["필수 답 1개 없음"], [problem("q1", "required_question", ["다음 실행"])]));
    expect(out.reasons).toEqual(["필수 답 1개 없음"]);
    expect(out.blocking).toEqual([]);
    expect(out.total).toBe(1);
  });

  it("필수 질문이 아닌 막힌 것만 있으면 “필수 …” 사유를 지우지 않는다", () => {
    const out = approvalBlockers(ws(["필수 답 1개 없음"], [problem("w1", "weak_evidence", ["단계 승인"])]));
    expect(out.reasons).toEqual(["필수 답 1개 없음"]);
    expect(out.total).toBe(2);
  });
});
