/**
 * SEL-50 PR17 — `pes set` 으로 쓴 값이 v0.15 보고서·조립물·웹에 반영된다 (tester, 작성 모드). 허용·거부 계약은 test_cli_set_accept/reject.
 *
 * 문제의 증상: mid 구현은 전용 명령이 없어 요약·남은 일·변경점을 note 로 돌렸고, 실사용 보고서에서 요약·이월·결론이 빠졌다.
 * 여기서는 set 으로 넣은 값이 pes.py 의 읽는 쪽(stage_md '요약'·'이 단계에서 정한 것'·'남은 일'·'라운드 경과', assemble/web 의 요약·결론,
 * qa-brief 의 자체 점검, status 의 점검 질문 수)에 실제로 나타나는지를 본다.
 *
 * 해석 9  changes 는 `round-start` 가 다음 라운드를 열 때 이력(history)에 "R<n> (<시각>): <라벨> · <라벨> — 상세 snapshots/…" 한 줄로 옮기고
 *         비운다(v0.15 303~311행). 그래서 변경점은 set 직후 project.json 에 있고, 다음 round-start 뒤 보고서 「라운드 경과」에 나온다.
 * 해석 10 보고서·조립물은 줄바꿈을 LF 로 정규화해 비교한다. HTML 은 데이터가 JSON 으로 들어가므로 한 줄짜리 문구로 찾는다.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { ok_run, with_set, type SetEnv } from "./helpers/set_env.ts";

const lf = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

function seed(e: SetEnv): void {
  ok_run(e.py(["round-start", e.slug, "plan"]), "round-start");
  const items = e.value_file(
    "items.json",
    JSON.stringify([
      { id: 1, kind: "rq", title: "합성 연구 질문", summary: "왜 필요한가", status: "done" },
      { id: 2, kind: "topic", title: "합성 조사 항목", summary: "조사 요약", status: "deepen", request: "원문 확인" },
    ]),
  );
  ok_run(e.py(["merge", e.slug, "plan", items]), "merge");
}

function put(e: SetEnv, target: string, field: string, text: string): void {
  ok_run(e.py(["set", e.slug, target, field, e.value_file(`p-${target}-${field}.txt`, text)]), `set ${target} ${field}`);
}

test("단계 보고서: set summary 가 '1. 요약' 을 채운다 (set 없이는 '요약 없음')", () =>
  with_set((e) => {
    seed(e);
    ok_run(e.py(["report", e.slug, "plan"]), "report 1");
    const empty = lf(join(e.folder, "reports", "plan", "report.md"));
    assert.match(empty, /\(요약 없음/, "set 하기 전에는 비어 있다");

    put(e, "plan", "summary", "합성 기획 요약 첫 줄 (근거: 기획 #1)\n둘째 줄 요약");
    ok_run(e.py(["report", e.slug, "plan"]), "report 2");
    const md = lf(join(e.folder, "reports", "plan", "report.md"));
    assert.match(md, /^## 1\. 요약\n\n합성 기획 요약 첫 줄 \(근거: 기획 #1\)\n둘째 줄 요약\n/m, "요약 절에 들어간다");
    assert.doesNotMatch(md, /\(요약 없음/, "빈 요약 안내가 사라진다");
    const html = lf(join(e.folder, "reports", "plan", "report.html"));
    assert.ok(html.includes("합성 기획 요약 첫 줄"), "HTML 보고서에도 요약이 있다");
  }));

test("단계 보고서: set carry_over 가 '4-1. 남은 일' 로, set settings 가 '2. 이 단계에서 정한 것' 표로 나온다", () =>
  with_set((e) => {
    seed(e);
    put(e, "plan", "carry_over", JSON.stringify([{ item: 2, title: "합성 조사 항목", request: "원문을 다시 확인한다", from: "plan" }]));
    put(e, "plan", "settings", JSON.stringify({ zz_scope: "합성 범위 값", zz_empty: "" }));
    ok_run(e.py(["report", e.slug, "plan"]), "report");
    const md = lf(join(e.folder, "reports", "plan", "report.md"));
    assert.match(md, /^## 4-1\. 남은 일 — 다음 단계로 넘김$/m, "남은 일 절");
    assert.match(md, /^- #2 합성 조사 항목: 원문을 다시 확인한다$/m, "이월 항목 줄");
    assert.match(md, /^## 2\. 이 단계에서 정한 것/m, "정한 것 절");
    assert.match(md, /^\| zz_scope \| 합성 범위 값 \|$/m, "설정 한 줄 (모르는 키는 키 이름 그대로)");
    assert.doesNotMatch(md, /zz_empty/, "빈 값은 표에 나오지 않는다 (v0.15 규칙)");
  }));

test("단계 보고서: set changes 는 다음 round-start 가 이력으로 옮기고 '4. 라운드 경과' 에 나온다 (해석 9)", () =>
  with_set((e) => {
    seed(e);
    put(e, "plan", "changes", JSON.stringify(["연구 질문 보강: 질문 하나를 더했다", "범위 조정: 장 수를 줄였다"]));
    assert.deepEqual(e.state().stages.plan.changes, ["연구 질문 보강: 질문 하나를 더했다", "범위 조정: 장 수를 줄였다"]);
    ok_run(e.py(["round-start", e.slug, "plan"]), "round-start 2");
    const st = e.state().stages.plan;
    assert.equal(st.round, 2);
    assert.deepEqual(st.changes, [], "다음 라운드를 열면 변경점은 비워진다");
    assert.equal(st.history.length, 1);
    assert.match(st.history[0], /^R1 \(.+\): 연구 질문 보강 · 범위 조정 — 상세 snapshots\/plan-R1\.json$/, "라벨만 한 줄로");
    ok_run(e.py(["report", e.slug, "plan"]), "report");
    const md = lf(join(e.folder, "reports", "plan", "report.md"));
    assert.match(md, /^## 4\. 라운드 경과와 사용자 결정$/m);
    assert.match(md, /^- R1 \(.+\): 연구 질문 보강 · 범위 조정 — 상세 snapshots\/plan-R1\.json$/m);
  }));

test("set review: status 가 점검 질문 수를 보이고 qa-brief 의 자체 점검 파일이 set 한 값 그대로다", () =>
  with_set((e) => {
    seed(e);
    const review = { round: 1, questions: [{ id: "q1", kind: "choice", label: "합성 점검 질문 하나" }, { id: "q2", kind: "text", label: "둘" }] };
    put(e, "plan", "review", JSON.stringify(review));
    const status = ok_run(e.py(["status", e.slug]), "status");
    assert.match(status.stdout.replace(/\r\n/g, "\n"), /점검 질문 2개\(R1\)/, "상태에 점검 질문 2개");
    ok_run(e.py(["qa-brief", e.slug, "plan"]), "qa-brief");
    const self = join(e.folder, "rounds", "plan-R1", "self-review.json");
    assert.ok(existsSync(self), "자체 점검 파일");
    assert.deepEqual(JSON.parse(lf(self)), review, "set 한 review 가 그대로 지시문 재료가 된다");
  }));

test("최종 보고서: set project executive_summary·conclusion 이 assemble 의 '## 요약'·'## 결론' 과 web 의 HTML 에 들어간다", () =>
  with_set((e) => {
    put(e, "project", "executive_summary", "합성 최종 요약 한 줄");
    put(e, "project", "conclusion", "합성 최종 결론 한 줄");
    ok_run(e.py(["assemble", e.slug]), "assemble");
    const md = lf(join(e.folder, "out", "report.md"));
    assert.match(md, /^## 요약\n\n합성 최종 요약 한 줄\n/m, "맨 앞 요약");
    assert.match(md, /^## 결론\n\n합성 최종 결론 한 줄\n/m, "맨 뒤 결론");
    assert.ok(md.indexOf("## 요약") < md.indexOf("## 결론"), "요약이 결론보다 앞");
    ok_run(e.py(["web", e.slug, "--assemble"]), "web");
    const html = lf(join(e.folder, "out", "report.html"));
    assert.ok(html.includes("합성 최종 요약 한 줄"), "웹 보고서에 요약");
    assert.ok(html.includes("합성 최종 결론 한 줄"), "웹 보고서에 결론");
  }));

test("set 이 없으면 최종 보고서에 요약·결론 절이 없다 (조건부 절) — 그리고 note 로는 채워지지 않는다", () =>
  with_set((e) => {
    ok_run(e.py(["note", e.slug, "요약: 이 메모는 요약이 아니다"]), "note");
    ok_run(e.py(["assemble", e.slug]), "assemble");
    const md = lf(join(e.folder, "out", "report.md"));
    assert.doesNotMatch(md, /^## 요약$/m);
    assert.doesNotMatch(md, /^## 결론$/m);
    assert.ok(!md.includes("이 메모는 요약이 아니다"));
  }));
