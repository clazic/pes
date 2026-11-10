/**
 * SEL-50 PR17 — `pes set` 거부 경로 (tester, 작성 모드). 허용 경로는 test_cli_set_accept.test.ts, 해석 번호도 거기와 이어진다.
 *
 * 해석 6  허용 필드 화이트리스트: 단계 대상은 summary·changes·carry_over·settings·review, `project` 대상은 executive_summary·conclusion 뿐이다.
 *         그 밖의 필드(items·status·round·approved_at·qa·history·notes·processed·topic …), 단계에 최상위 필드, project 에 단계 필드,
 *         점 경로(stages.plan.status)·대소문자 다른 이름은 모두 거부한다.
 * 해석 7  거부는 0 아닌 종료 + 한국어 이유 + 스택 추적 없음이고, 거부된 호출은 project.json 바이트·프로젝트 폴더 파일 목록을 바꾸지 않는다
 *         (project.json.tmp 도 남기지 않는다). 모르는 프로젝트는 폴더를 만들지 않는다.
 * 해석 8  형식 검사: JSON 필드는 파싱돼야 하고 모양이 맞아야 한다 — changes·carry_over 는 배열, settings·review 는 객체.
 *         (carry_over 의 각 항목이 객체가 아니면 v0.15 보고서가 `c.get` 에서 죽으므로 거부한다. changes 는 문자열 배열.)
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { expect_refused, make_set_env, ok_run, with_set, type SetEnv } from "./helpers/set_env.ts";

/**
 * 양성 대조: 거부 시험이 "set 을 몰라서" 통과하지 않도록, 먼저 같은 환경에서 정상 set 이 성공함을 확인한다.
 * (거부 호출은 같은 프로젝트에서 이어진다.)
 */
function with_ready<T>(fn: (e: SetEnv) => T): T {
  return with_set((e) => {
    ok_run(e.py(["set", e.slug, "plan", "summary", e.value_file("control.txt", "양성 대조 요약")]), "양성 대조 set");
    return fn(e);
  });
}

/** 거부 호출 한 번: 거부 + 파일·폴더 불변. */
function refuse(e: SetEnv, args: string[], what: string, opts: { input?: string; allow_usage?: boolean } = {}): void {
  const raw = e.raw();
  const listing = e.listing();
  const res = e.py(args, opts.input !== undefined ? { input: opts.input } : {});
  expect_refused(res, what, { allow_usage: opts.allow_usage === true });
  assert.equal(e.raw(), raw, `${what}: project.json 바이트가 그대로다`);
  assert.deepEqual(e.listing(), listing, `${what}: 프로젝트 폴더가 그대로다 (tmp 없음)`);
  assert.ok(!existsSync(join(e.folder, "project.json.tmp")), `${what}: project.json.tmp 가 남지 않는다`);
}

test("set 은 모르는 필드를 거부한다 — 단계 대상 (업무 상태 필드 전부, 점 경로, 대소문자)", () =>
  with_ready((e) => {
    const file = e.value_file("v.txt", '"x"');
    const arr = e.value_file("v-arr.json", "[]");
    const forbidden = [
      "items", "status", "round", "approved_at", "qa", "review_log", "history", "reports", "stale", "suggestions", "warnings",
      "executive_summary", "conclusion", "topic", "notes", "processed", "current",
      "stages.plan.status", "items.0", "summary.x", "../x", "Summary", "SUMMARY", " summary", "summary ", "", "*",
    ];
    for (const field of forbidden) refuse(e, ["set", e.slug, "plan", field, field === "history" || field === "reports" ? arr : file], `plan ${JSON.stringify(field)}`);
  }));

test("set 은 모르는 필드를 거부한다 — project 대상 (단계 필드와 최상위 업무 필드)", () =>
  with_ready((e) => {
    const file = e.value_file("v.txt", "x");
    const obj = e.value_file("v-obj.json", "{}");
    const arr = e.value_file("v-arr.json", "[]");
    for (const field of [
      "summary", "changes", "carry_over", "review", // 단계 필드
      "settings", "stages", "notes", "processed", "current", "complete", "topic", "slug", "created", "library", "pes",
      "executive_summary ", "Conclusion", "stages.plan.summary", "",
    ]) {
      refuse(e, ["set", e.slug, "project", field, field === "notes" || field === "processed" ? arr : field === "stages" || field === "settings" || field === "library" ? obj : file], `project ${JSON.stringify(field)}`);
    }
  }));

test("set 은 모르는 단계·대상 이름을 거부한다", () =>
  with_ready((e) => {
    const file = e.value_file("v.txt", "x");
    for (const target of ["foo", "Plan", "PLAN", "projects", "Project", "project2", "stages", "items", "0", "plan/research", "..", "", "all"]) {
      refuse(e, ["set", e.slug, target, "summary", file], `대상 ${JSON.stringify(target)}`);
    }
  }));

test("set 은 인자가 모자라거나 값 파일이 없으면 거부한다", () =>
  with_ready((e) => {
    refuse(e, ["set"], "인자 없음", { allow_usage: true });
    refuse(e, ["set", e.slug], "폴더만");
    refuse(e, ["set", e.slug, "plan"], "단계만");
    refuse(e, ["set", e.slug, "plan", "summary"], "값 파일 없음");
    refuse(e, ["set", e.slug, "project", "conclusion"], "project 값 파일 없음");
    refuse(e, ["set", e.slug, "plan", "summary", join(e.home.root, "없는-파일.txt")], "값 파일이 없는 경로");
    refuse(e, ["set", e.slug, "plan", "summary", e.home.root], "값 파일 자리에 폴더");
    // 표준 입력이 비었을 때(`-` 인데 입력 없음)는 텍스트 필드를 비우는 것이 아니라 거부한다
    refuse(e, ["set", e.slug, "plan", "carry_over", "-"], "JSON 인데 입력이 비었다", { input: "" });
  }));

test("set 은 JSON 필드의 잘못된 JSON 을 거부한다 — 4개 필드 모두", () =>
  with_ready((e) => {
    const bad_texts = ["{bad", "[1, 2", "", "   ", "undefined", "{'a': 1}", "[1,]", "NaN"];
    for (const field of ["changes", "carry_over", "settings", "review"]) {
      bad_texts.forEach((text, i) => {
        // 비어 있는 입력과 NaN 은 구현이 어떻게 파싱하든 '유효한 값'이 아니다
        refuse(e, ["set", e.slug, "plan", field, e.value_file(`bad-${field}-${i}.txt`, text)], `${field} 잘못된 JSON ${JSON.stringify(text)}`);
      });
    }
    refuse(e, ["set", e.slug, "plan", "settings", "-"], "stdin 의 잘못된 JSON", { input: "{bad" });
  }));

test("set 은 JSON 필드의 모양이 틀리면 거부한다 — 배열이어야 할 곳에 객체·문자열·숫자·null, 객체여야 할 곳에 배열 등 (해석 8)", () =>
  with_ready((e) => {
    const put = (field: string, text: string, what: string) => refuse(e, ["set", e.slug, "plan", field, e.value_file(`shape-${field}-${what}.json`, text)], `${field} ${what}`);
    for (const [what, text] of [["객체", '{"a": 1}'], ["문자열", '"문자열"'], ["숫자", "3"], ["null", "null"], ["true", "true"]] as const) {
      put("changes", text, what);
      put("carry_over", text, what);
    }
    for (const [what, text] of [["배열", "[1]"], ["빈 배열", "[]"], ["문자열", '"s"'], ["숫자", "3"], ["null", "null"]] as const) {
      put("settings", text, what);
      put("review", text, what);
    }
    put("changes", "[1, 2]", "숫자 항목");
    put("changes", '[{"a": 1}]', "객체 항목");
    put("carry_over", '["문자열 항목"]', "문자열 항목");
    put("carry_over", "[1]", "숫자 항목");
    put("carry_over", "[[]]", "배열 항목");
  }));

test("set 은 모르는 프로젝트를 거부하고 폴더를 만들지 않는다", () => {
  const e = make_set_env();
  try {
    ok_run(e.py(["set", e.slug, "plan", "summary", e.value_file("control.txt", "양성 대조 요약")]), "양성 대조 set");
    const before = readdirSync(e.home.env.PES_HOME as string).sort();
    const file = e.value_file("v.txt", "x");
    for (const slug of ["없는-프로젝트", "no-such", join(e.home.root, "no", "such", "dir")]) {
      const res = e.py(["set", slug, "plan", "summary", file]);
      expect_refused(res, `프로젝트 ${slug}`);
      assert.deepEqual(readdirSync(e.home.env.PES_HOME as string).sort(), before, "프로젝트 홈에 새 폴더가 생기지 않는다");
    }
  } finally {
    e.cleanup();
  }
});

test("거부 뒤에도 정상 쓰기는 된다 — 거부가 상태를 망가뜨리지 않았다", () =>
  with_ready((e) => {
    refuse(e, ["set", e.slug, "plan", "items", e.value_file("x.txt", "[]")], "items");
    refuse(e, ["set", e.slug, "plan", "changes", e.value_file("y.txt", "{bad")], "bad json");
    ok_run(e.py(["set", e.slug, "plan", "summary", e.value_file("z.txt", "정상 요약")]), "정상");
    assert.equal(e.state().stages.plan.summary.trimEnd(), "정상 요약");
  }));
