/**
 * SEL-50 PR17 — `pes set` 허용 경로 (tester, 작성 모드). 구현 전이므로 새 시험은 실패하는 것이 정상이다.
 *
 * 문제: 옛 스킬은 stages.<s>.summary·changes·carry_over·settings·review 와 최상위 executive_summary·conclusion 을
 * Python 으로 project.json 에 직접 썼다. v0.15 보고서가 이 필드를 읽는데 전용 명령이 없었다. leader 결정: 허용 필드 화이트리스트를 쓰는
 * `pes set` 을 더한다.
 *
 *   pes set <dir> <stage> <field> <file|->     field: summary · changes · carry_over · settings · review
 *   pes set <dir> project <field> <file|->     field: executive_summary · conclusion
 *
 * 이 파일은 플래그 없음(v0.15)의 허용 경로를 고정한다. 거부는 test_cli_set_reject, 보고서 반영은 test_cli_set_report,
 * PES_DB_CORE=1 은 test_cli_set_db_flag, 스킬 문서는 test_skill_set_docs. (Python 을 띄워 느리므로 파일을 나눴다.)
 *
 * 이 시험이 고정하는 해석 (보고서의 '해석'과 같은 번호):
 *   해석 1  값 형식: summary·executive_summary·conclusion 은 **텍스트**(파일 내용이 그대로 문자열이 된다 — JSON 처럼 보여도 문자열),
 *           changes·carry_over 는 JSON 배열, settings·review 는 JSON 객체.
 *   해석 2  `-` 는 표준 입력에서 읽는다(UTF-8).
 *   해석 3  한 번 쓰면 그 필드를 **통째로 바꾼다**(병합·덧붙임 없음). 같은 값을 또 써도 결과가 같다.
 *   해석 4  쓰는 방식은 v0.15 save()와 같다: 잠금 확인(PES_OWNER·.pes-lock), project.json.tmp 에 쓰고 교체. 대상 필드 말고 다른 값은 그대로이고
 *           프로젝트 폴더에 새 파일이 생기지 않는다.
 *   해석 5  텍스트 값의 끝 줄바꿈은 시험이 고정하지 않는다(저장 때 지워도, 두어도 된다). 끝 공백을 뺀 내용이 같으면 통과한다.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { at_path, expect_refused, field_path, make_set_env, ok_run, STAGE_NAMES, with_set, without, type SetEnv } from "./helpers/set_env.ts";

const SUMMARY = '첫 줄 요약이다 (근거: 조사 #1)\n둘째 줄 | 표 `코드` {"a": 1} [^1] <b>태그</b> "따옴표" 100%';
const CHANGES = ["라벨 하나: 내용 하나", "라벨 둘: 내용 둘 (이유 포함)"];
const CARRY = [{ item: 3, title: "합성 이월 항목", request: "원문을 확인한다", from: "plan" }];
const SETTINGS = { depth: "deep", sources: ["kosis", "law"], 메모: "한글 키" };
const REVIEW = { round: 1, questions: [{ id: "q1", kind: "choice", label: "합성 점검 질문" }] };

interface Case {
  target: (typeof STAGE_NAMES)[number] | "project";
  field: string;
  text: string;
  expect: unknown;
}

const CASES: Case[] = [
  ...STAGE_NAMES.map((s): Case => ({ target: s, field: "summary", text: `${s} 단계 요약\n${SUMMARY}`, expect: `${s} 단계 요약\n${SUMMARY}` })),
  { target: "plan", field: "changes", text: JSON.stringify(CHANGES), expect: CHANGES },
  { target: "plan", field: "carry_over", text: JSON.stringify(CARRY), expect: CARRY },
  { target: "plan", field: "settings", text: JSON.stringify(SETTINGS), expect: SETTINGS },
  { target: "plan", field: "review", text: JSON.stringify(REVIEW), expect: REVIEW },
  { target: "research", field: "carry_over", text: JSON.stringify(CARRY), expect: CARRY },
  { target: "project", field: "executive_summary", text: `최종 요약\n${SUMMARY}`, expect: `최종 요약\n${SUMMARY}` },
  { target: "project", field: "conclusion", text: "최종 결론이다.\n\n- 하나\n- 둘", expect: "최종 결론이다.\n\n- 하나\n- 둘" },
];

function norm(value: unknown): unknown {
  return typeof value === "string" ? value.replace(/\r\n/g, "\n").trimEnd() : value;
}

function set_ok(e: SetEnv, c: Case, via: "file" | "stdin" = "file"): void {
  const before = e.state();
  const listing = e.listing();
  const args = ["set", e.slug, c.target, c.field];
  const res =
    via === "file" ? e.py([...args, e.value_file(`v-${c.target}-${c.field}.txt`, c.text)]) : e.py([...args, "-"], { input: c.text });
  const what = `set ${c.target} ${c.field} (${via})`;
  ok_run(res, what);
  const after = e.state();
  const path = field_path(c.target, c.field);
  assert.deepEqual(norm(at_path(after, path)), norm(c.expect), `${what}: 값이 들어갔다`);
  // set plan settings 는 옛 스킬처럼 최상위 settings 도 같은 값으로 바꾼다(r1-1 필수 3, leader 결정) — 그 칸도 값으로 확인하고 비교에서 뺀다.
  const plan_settings = c.target === "plan" && c.field === "settings";
  if (plan_settings) assert.deepEqual(norm(after.settings), norm(c.expect), `${what}: 최상위 settings 도 같은 값`);
  const strip = (o: unknown) => (plan_settings ? without(without(o, path), ["settings"]) : without(o, path));
  assert.deepEqual(strip(after), strip(before), `${what}: 다른 필드는 그대로다`);
  assert.deepEqual(e.listing(), listing, `${what}: 프로젝트 폴더에 새 파일(project.json.tmp 포함)이 없다`);
  assert.ok(!existsSync(join(e.folder, "project.json.tmp")), `${what}: tmp 파일이 남지 않는다`);
}

test("set 허용 필드: 단계 summary 6개·changes·carry_over·settings·review·최상위 executive_summary·conclusion 이 들어가고 다른 값은 그대로다", () =>
  with_set((e) => {
    for (const c of CASES) set_ok(e, c);
    // v0.15 의 다른 명령이 그대로 읽을 수 있는 파일이다
    const status = ok_run(e.py(["status", e.slug]), "status");
    assert.ok(status.stdout.trim().length > 0);
  }));

test("set `-` 는 표준 입력에서 읽는다 (한글 텍스트·JSON 모두)", () =>
  with_set((e) => {
    set_ok(e, CASES.find((c) => c.target === "analyze" && c.field === "summary")!, "stdin");
    set_ok(e, CASES.find((c) => c.target === "plan" && c.field === "carry_over")!, "stdin");
    set_ok(e, CASES.find((c) => c.target === "project" && c.field === "conclusion")!, "stdin");
  }));

test("set 텍스트 필드: JSON 처럼 보여도 문자열로 저장하고, 끝 줄바꿈·CRLF 는 내용을 바꾸지 않는다 (해석 1·5)", () =>
  with_set((e) => {
    const jsonish = '{"a": [1, 2], "b": "가"}';
    ok_run(e.py(["set", e.slug, "plan", "summary", e.value_file("j.txt", jsonish)]), "set json-like summary");
    assert.equal(e.state().stages.plan.summary, jsonish, "객체로 해석하지 않는다");
    const crlf = "윗줄\r\n아랫줄\r\n";
    ok_run(e.py(["set", e.slug, "project", "conclusion", e.value_file("c.txt", crlf)]), "set crlf");
    assert.equal(String(e.state().conclusion).replace(/\r\n/g, "\n").trimEnd(), "윗줄\n아랫줄");
    ok_run(e.py(["set", e.slug, "plan", "summary", e.value_file("n.txt", "끝 줄바꿈\n")]), "trailing newline");
    assert.equal(String(e.state().stages.plan.summary).trimEnd(), "끝 줄바꿈");
  }));

test("set 은 필드를 통째로 바꾼다 — 병합·덧붙임 없음, 같은 값을 또 써도 파일이 같다 (해석 3)", () =>
  with_set((e) => {
    const put = (field: string, value: unknown) => ok_run(e.py(["set", e.slug, "plan", field, e.value_file(`r-${field}.json`, JSON.stringify(value))]), `set ${field}`);
    put("settings", { a: 1, b: 2 });
    put("settings", { c: 3 });
    assert.deepEqual(e.state().stages.plan.settings, { c: 3 }, "settings 는 병합이 아니라 교체");
    put("carry_over", [{ item: 1, title: "하나", request: "가" }, { item: 2, title: "둘", request: "나" }]);
    put("carry_over", [{ item: 9, title: "아홉", request: "다" }]);
    assert.deepEqual(e.state().stages.plan.carry_over, [{ item: 9, title: "아홉", request: "다" }], "carry_over 는 덧붙임이 아니라 교체");
    put("changes", ["가: 하나"]);
    put("changes", []);
    assert.deepEqual(e.state().stages.plan.changes, [], "빈 배열로 비울 수 있다");
    put("settings", {});
    assert.deepEqual(e.state().stages.plan.settings, {}, "빈 객체로 비울 수 있다");
    const first = e.raw();
    put("settings", {});
    assert.equal(e.raw(), first, "같은 값을 또 써도 바이트가 같다");
    ok_run(e.py(["set", e.slug, "plan", "summary", e.value_file("s1.txt", "같은 요약")]), "summary 1");
    const once = e.raw();
    ok_run(e.py(["set", e.slug, "plan", "summary", e.value_file("s2.txt", "같은 요약")]), "summary 2");
    assert.equal(e.raw(), once, "같은 텍스트를 또 써도 바이트가 같다");
  }));

test("set 은 다른 명령이 쌓은 상태를 건드리지 않는다 — 라운드·항목·메모가 있는 프로젝트에서도 대상 필드만 바뀐다", () =>
  with_set((e) => {
    ok_run(e.py(["round-start", e.slug, "plan"]), "round-start");
    const items = e.value_file("items.json", JSON.stringify([{ id: 1, kind: "rq", title: "합성 연구 질문", summary: "왜", status: "done" }]));
    ok_run(e.py(["merge", e.slug, "plan", items]), "merge");
    ok_run(e.py(["note", e.slug, "합성 인계 메모"]), "note");
    const c = CASES.find((x) => x.target === "plan" && x.field === "summary")!;
    set_ok(e, c);
    set_ok(e, { target: "plan", field: "changes", text: JSON.stringify(CHANGES), expect: CHANGES });
    const st = e.state();
    assert.equal(st.stages.plan.items.length, 1);
    assert.equal(st.stages.plan.round, 1);
    assert.equal(st.notes.length, 1);
  }));

// ---------------------------------------------------------------------------
// 잠금: v0.15 쓰기 규칙 그대로 (check_lock)

const lock_owner = (e: SetEnv): string | undefined => e.lock_owner(); // DB 의 살아 있는 lease 의 세션 표시 (0.15 는 .pes-lock 파일)

test("set 은 다른 세션의 살아 있는 잠금이면 거부한다 — 파일·잠금 그대로 (v0.15 쓰기 규칙)", () =>
  with_set((e) => {
    ok_run(e.py(["lock", e.slug], { extra: { PES_OWNER: "session-aaaa1111" } }), "lock");
    const before = e.raw();
    const lock_before = lock_owner(e);
    assert.equal(lock_before, "session-aaaa1111");
    const file = e.value_file("lk.txt", "잠금 시험 요약");

    const other = e.py(["set", e.slug, "plan", "summary", file], { extra: { PES_OWNER: "session-bbbb2222" } });
    expect_refused(other, "다른 세션");
    assert.match(other.stderr + other.stdout, /다른 세션/, "v0.15 와 같은 이유 문구");
    const anonymous = e.py(["set", e.slug, "plan", "summary", file]);
    expect_refused(anonymous, "세션 표시 없음");
    assert.equal(e.raw(), before, "거부된 쓰기는 project.json 을 바꾸지 않는다");
    assert.equal(lock_owner(e), lock_before, "남의 잠금은 그대로");
    assert.ok(!existsSync(join(e.folder, "project.json.tmp")), "tmp 가 남지 않는다");

    ok_run(e.py(["set", e.slug, "plan", "summary", file], { extra: { PES_OWNER: "session-aaaa1111" } }), "잠금 주인");
    assert.equal(e.state().stages.plan.summary.trimEnd(), "잠금 시험 요약", "잠근 세션은 쓸 수 있다");
    assert.equal(lock_owner(e), "session-aaaa1111");
  }));

test("set 은 잠금이 없을 때 PES_OWNER 가 있으면 v0.15 처럼 그 세션의 잠금을 남긴다, 없으면 잠금을 만들지 않는다", () =>
  with_set((e) => {
    ok_run(e.py(["set", e.slug, "plan", "summary", e.value_file("a.txt", "표시 없음")]), "no owner");
    assert.equal(lock_owner(e), undefined, "PES_OWNER 가 없으면 잠금 파일이 생기지 않는다");
    ok_run(e.py(["set", e.slug, "plan", "summary", e.value_file("b.txt", "표시 있음")], { extra: { PES_OWNER: "session-cccc3333" } }), "owner");
    assert.equal(lock_owner(e), "session-cccc3333", "쓰는 세션의 잠금이 남는다");
  }));

test("set 은 오래된(2시간 넘은) 남의 잠금은 넘어서 쓴다 — v0.15 와 같다", () =>
  with_set((e) => {
    ok_run(e.py(["lock", e.slug], { extra: { PES_OWNER: "session-dddd4444" } }), "lock");
    // 잠금 시각을 3시간 전으로 돌린다 (0.15 는 .pes-lock 의 at, TS 는 DB lease 의 시각 — ts_age_lease)
    e.age_lock(3 * 3600);
    ok_run(e.py(["set", e.slug, "plan", "summary", e.value_file("old.txt", "오래된 잠금 뒤 요약")], { extra: { PES_OWNER: "session-eeee5555" } }), "stale lock");
    assert.equal(e.state().stages.plan.summary.trimEnd(), "오래된 잠금 뒤 요약");
  }));
