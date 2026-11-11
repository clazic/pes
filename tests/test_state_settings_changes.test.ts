/**
 * SEL-50 PR17 r1-1 필수 3·5 — `set plan settings` 가 프로젝트 설정을 함께 갱신하고, 현재 `changes` 를 읽는 길이 있다 (tester, 작성 모드 회귀).
 *
 * 필수 3: v0.15 는 최상위 `p.settings` 를 읽는다 — `report_formats()`(stage_reports: 보고서 형식), 대시보드 승인 창, `qa-brief` 의 「기획 답(사용자)」.
 *         옛 문서는 "답은 `p.settings` 와 `stages.plan.settings` 에 저장". 새 문서의 `set <dir> plan settings` 는 둘 다 갱신해야 한다.
 * 필수 5: `set changes` 는 통째로 바꾼다. 그러므로 문서가 시키는 "한 줄 더하기"는 (읽기 + 전체 배열 다시 쓰기)여야 하고, 읽는 길이 필요하다.
 *
 * 해석 R3 (leader 결정 3)
 *   (가) `set <dir> plan settings` 후 최상위 settings 는 그 값과 같다(통째로 바뀜, 병합 아님). stages.plan.settings 도 같다.
 *   (나) 다른 단계의 settings(`set <dir> research settings`)는 최상위 settings 를 건드리지 않는다. 다른 필드·단계·notes 는 그대로.
 *   (다) 반영 확인은 명령 출력으로: `approve plan` 이 알리는 "(형식: …)" 과 `qa-brief` 파일의 「기획 답(사용자)」 줄.
 *   (라) `set` 은 PES_DB_CORE=1 에서 거부된다(8.14) — DB 경로는 이 절의 대상이 아니다.
 * 해석 R5 (leader 결정 5, "형식은 구현이 정함 — 해석으로 보고")
 *   (가) 읽는 길은 `show <dir> <단계> --fields changes`(id 없음). 출력은 JSON 이고 현재 값이 들어 있다 — 정확한 껍질(객체/배열)은 가리지 않고,
 *        줄 문자열이 저장 순서대로 나타나는지만 본다(껍질이 `{changes:[…]}` 이면 그 배열이 저장값과 같은지도 본다).
 *   (나) 읽기는 파일을 바꾸지 않는다. `set changes` 두 번째 호출은 첫 값을 통째로 바꾼다(문서는 "이미 쓴 줄을 모두 포함한 전체 배열을 다시 쓴다"고 지시한다 — 문서 시험은 test_skill_state_docs).
 *   (다) `show … --fields summary` 처럼 항목 필드를 고르면 옛 동작(항목 목록)이 그대로다 — 단계 필드와 이름이 겹치는 summary 는 항목 요약이다.
 *   (라) PES_DB_CORE=1 의 `show … --fields changes` 는 충돌 없이 JSON 을 낸다(DB 에는 set 이 없어 값은 비어 있다).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { ok, with_mode, type Mode } from "./helpers/state_modes.ts";

const SETTINGS = { stage_reports: ["docx", "md"], audience: "정책 담당자", depth: "보통" };

function show_stage(m: Mode, fields: string, stage = "plan"): { text: string; json: any } {
  const res = ok(m.py(["show", m.slug, stage, "--fields", fields]), `show ${stage} --fields ${fields}`);
  let json: any;
  try {
    json = JSON.parse(res.stdout);
  } catch (e) {
    assert.fail(`show --fields ${fields} 출력은 JSON 이어야 한다: ${res.stdout.slice(0, 200)}`);
  }
  return { text: res.stdout, json };
}

function lines_in_order(text: string, lines: string[]): void {
  let at = -1;
  for (const line of lines) {
    const next = text.indexOf(line, at + 1);
    assert.ok(next > at, `'${line}' 이(가) 저장 순서대로 보여야 한다:\n${text}`);
    at = next;
  }
}

/** 출력 껍질이 `{changes:[…]}` 면 그 배열이 저장값과 같아야 한다 (다른 껍질은 줄 문자열 포함만 본다). */
function maybe_shell_equals(json: any, key: string, want: unknown): void {
  if (json !== null && typeof json === "object" && !Array.isArray(json) && key in json) assert.deepEqual(json[key], want);
}

// ---------------------------------------------------------------------------
// 필수 3

test("set plan settings 는 최상위 settings 와 stages.plan.settings 를 함께 갱신한다", async () => {
  await with_mode("off", (m) => {
    const before = m.state();
    ok(m.py(["set", m.slug, "plan", "settings", m.json("s.json", SETTINGS)]), "set plan settings");
    const after = m.state();
    assert.deepEqual(after.stages.plan.settings, SETTINGS, "단계 settings");
    assert.deepEqual(after.settings, SETTINGS, "최상위 settings 도 같다 — v0.15 가 읽는 곳");
    // 나머지는 그대로
    for (const key of Object.keys(before)) if (key !== "settings" && key !== "stages") assert.deepEqual(after[key], before[key], `최상위 ${key} 는 그대로`);
    for (const st of ["research", "analyze", "write", "verify", "publish"]) assert.deepEqual(after.stages[st], before.stages[st], `${st} 단계는 그대로`);
    const { settings: _a, ...plan_after } = after.stages.plan;
    const { settings: _b, ...plan_before } = before.stages.plan;
    assert.deepEqual(plan_after, plan_before, "plan 단계의 다른 칸은 그대로");
  });
});

test("set plan settings 를 다시 쓰면 최상위 settings 도 통째로 바뀐다(병합 아님)", async () => {
  await with_mode("off", (m) => {
    ok(m.py(["set", m.slug, "plan", "settings", m.json("s1.json", SETTINGS)]), "첫 set");
    const second = { audience: "연구자" };
    ok(m.py(["set", m.slug, "plan", "settings", m.json("s2.json", second)]), "둘째 set");
    const p = m.state();
    assert.deepEqual(p.settings, second, "옛 stage_reports 가 남아 있으면 안 된다");
    assert.deepEqual(p.stages.plan.settings, second);
  });
});

test("다른 단계의 settings 는 최상위 settings 를 건드리지 않는다", async () => {
  await with_mode("off", (m) => {
    ok(m.py(["set", m.slug, "plan", "settings", m.json("s1.json", SETTINGS)]), "plan settings");
    ok(m.py(["set", m.slug, "research", "settings", m.json("s2.json", { depth: "깊게", models: "opus" })]), "research settings");
    const p = m.state();
    assert.deepEqual(p.settings, SETTINGS, "research settings 가 기획 답을 덮으면 안 된다");
    assert.deepEqual(p.stages.research.settings, { depth: "깊게", models: "opus" });
  });
});

test("set plan settings 의 stage_reports 가 보고서 형식 안내(approve plan 의 '형식:')에 반영된다", async () => {
  await with_mode("off", (m) => {
    ok(m.py(["round-start", m.slug, "plan"]), "round-start");
    const base = ok(m.py(["approve", m.slug, "plan"]), "approve (설정 전)");
    assert.match(base.stdout, /형식: md, html, eli5/, "설정 전 기본 형식");
    ok(m.py(["reopen", m.slug, "plan"]), "reopen");
    ok(m.py(["set", m.slug, "plan", "settings", m.json("s.json", SETTINGS)]), "set plan settings");
    const res = ok(m.py(["approve", m.slug, "plan"]), "approve (설정 후)");
    assert.match(res.stdout, /형식: docx, md/, `사용자가 고른 보고서 형식이 안내에 반영돼야 한다:\n${res.stdout}`);
    assert.doesNotMatch(res.stdout, /형식: md, html, eli5/);
  });
});

test("set plan settings 의 기획 답이 qa-brief 「기획 답(사용자)」에 들어간다 (stage_reports 는 제외)", async () => {
  await with_mode("off", (m) => {
    ok(m.py(["round-start", m.slug, "plan"]), "round-start");
    ok(m.py(["set", m.slug, "plan", "settings", m.json("s.json", SETTINGS)]), "set plan settings");
    const out = ok(m.py(["qa-brief", m.slug, "plan"]), "qa-brief");
    const brief = readFileSync(out.stdout.trim(), "utf8").replace(/\r\n/g, "\n");
    const line = brief.split("\n").find((l) => l.startsWith("- 기획 답(사용자):"));
    assert.ok(line, `「기획 답(사용자)」 줄이 있어야 한다:\n${brief}`);
    assert.match(line!, /audience=정책 담당자/);
    assert.match(line!, /depth=보통/);
    assert.doesNotMatch(line!, /stage_reports/, "보고서 형식은 검토 기준이 아니다");
  });
});

test("후속 단계의 qa-brief 도 기획 답을 읽는다 (최상위 settings)", async () => {
  await with_mode("off", (m) => {
    ok(m.py(["set", m.slug, "plan", "settings", m.json("s.json", SETTINGS)]), "set plan settings");
    ok(m.py(["round-start", m.slug, "research"]), "round-start research");
    const out = ok(m.py(["qa-brief", m.slug, "research"]), "qa-brief research");
    const brief = readFileSync(out.stdout.trim(), "utf8").replace(/\r\n/g, "\n");
    assert.match(brief, /- 기획 답\(사용자\): .*audience=정책 담당자/);
  });
});

// ---------------------------------------------------------------------------
// 필수 5

test("show <단계> --fields changes: set 으로 쓴 현재 값을 저장 순서대로 읽는다", async () => {
  await with_mode("off", (m) => {
    ok(m.py(["round-start", m.slug, "plan"]), "round-start");
    const first = ["가: 나", "다: 라"];
    ok(m.py(["set", m.slug, "plan", "changes", m.json("c.json", first)]), "set changes");
    const { text, json } = show_stage(m, "changes");
    lines_in_order(text, first);
    maybe_shell_equals(json, "changes", first);
  });
});

test("changes 를 '한 줄 더하기'는 읽고 전체 배열을 다시 쓰는 것이고, 앞 줄을 잃지 않는다", async () => {
  await with_mode("off", (m) => {
    ok(m.py(["round-start", m.slug, "plan"]), "round-start");
    const first = ["가: 나", "다: 라", "마: 바"];
    ok(m.py(["set", m.slug, "plan", "changes", m.json("c1.json", first)]), "첫 set");
    // 에이전트가 앞 줄을 기억하지 못해도 읽어서 이어 쓴다
    const cur = show_stage(m, "changes");
    for (const line of first) assert.ok(cur.text.includes(line), `읽기에 앞 줄 '${line}' 이 있어야 이어 쓸 수 있다`);
    const next = [...first, "독립 검토 반영: 사 아"];
    ok(m.py(["set", m.slug, "plan", "changes", m.json("c2.json", next)]), "전체 배열 다시 쓰기");
    const { text, json } = show_stage(m, "changes");
    lines_in_order(text, next);
    maybe_shell_equals(json, "changes", next);
    assert.deepEqual(m.state().stages.plan.changes, next, "저장된 값");
    // 통째로 바뀐다는 계약(덧붙이기 아님): 짧은 배열로 다시 쓰면 앞 줄은 사라진다
    ok(m.py(["set", m.slug, "plan", "changes", m.json("c3.json", ["하나: 둘"])]), "짧게 다시 쓰기");
    const short = show_stage(m, "changes");
    assert.ok(short.text.includes("하나: 둘"));
    assert.ok(!short.text.includes("가: 나"), "set 은 통째로 바꾼다 — 앞 줄이 남으면 덧붙이기다");
  });
});

test("show --fields changes 는 읽기 전용이다: 상태가 그대로이고 빈 값도 JSON 으로 나온다", async () => {
  await with_mode("off", (m) => {
    const read = () => JSON.stringify(m.state()); // 상태 전체 (pes.ts 의 원본은 DB — project.json 이 없다)
    const empty = show_stage(m, "changes");
    assert.ok(!/가: 나/.test(empty.text));
    maybe_shell_equals(empty.json, "changes", []);
    ok(m.py(["set", m.slug, "plan", "changes", m.json("c.json", ["가: 나"])]), "set");
    const before = read();
    show_stage(m, "changes");
    show_stage(m, "changes", "research");
    assert.equal(read(), before, "읽기는 상태를 바꾸지 않는다");
  });
});

test("단계 필드를 함께 고르면(carry_over·settings·review) 같은 길로 읽는다", async () => {
  await with_mode("off", (m) => {
    ok(m.py(["set", m.slug, "plan", "settings", m.json("s.json", SETTINGS)]), "set settings");
    ok(m.py(["set", m.slug, "plan", "changes", m.json("c.json", ["가: 나"])]), "set changes");
    const { text, json } = show_stage(m, "changes,settings");
    assert.ok(text.includes("가: 나") && text.includes("정책 담당자"), `둘 다 보여야 한다:\n${text}`);
    maybe_shell_equals(json, "settings", SETTINGS);
  });
});

test("항목 필드를 고르는 show --fields 는 옛 동작 그대로다 (summary 는 항목 요약)", async () => {
  await with_mode("off", (m) => {
    ok(m.py(["round-start", m.slug, "plan"]), "round-start");
    ok(m.py(["merge", m.slug, "plan", m.json("i.json", { id: 1, kind: "rq", title: "RQ1", summary: "항목 요약" })]), "merge");
    ok(m.py(["set", m.slug, "plan", "summary", m.file("sum.txt", "단계 요약")]), "set summary");
    const res = ok(m.py(["show", m.slug, "plan", "--fields", "summary"]), "show --fields summary");
    const arr = JSON.parse(res.stdout);
    assert.deepEqual(arr, [{ id: 1, title: "RQ1", summary: "항목 요약" }]);
    // 단계 필드와 항목 필드를 섞으면 항목 목록이 그대로 나오고 충돌하지 않는다
    const mixed = ok(m.py(["show", m.slug, "plan", "1", "--fields", "summary"]), "show 1 --fields summary");
    assert.deepEqual(JSON.parse(mixed.stdout), [{ id: 1, title: "RQ1", summary: "항목 요약" }]);
  });
});

test("round-start 는 이전 라운드 changes 를 이력으로 넘기고 현재 changes 를 비운다 (읽기에도 반영)", async () => {
  await with_mode("off", (m) => {
    ok(m.py(["round-start", m.slug, "plan"]), "R1");
    ok(m.py(["set", m.slug, "plan", "changes", m.json("c.json", ["가: 나"])]), "set");
    ok(m.py(["render", m.slug, "plan"]), "render"); // pes.ts: 열린 라운드가 있으면 round-start 는 거절한다(conflict) — 0.15 는 연달아 열었다. 봉인한 뒤 연다.
    ok(m.py(["round-start", m.slug, "plan"]), "R2");
    const { text } = show_stage(m, "changes");
    assert.ok(!text.includes("가: 나"), "새 라운드의 changes 는 비어 있다");
    assert.ok(m.state().stages.plan.history.some((h: string) => h.includes("가")), "이전 라운드 변경점은 이력에 남는다");
  });
});

test("PES_DB_CORE=1: show --fields changes 는 충돌 없이 JSON 을 낸다 (DB 에는 set 이 없어 값은 비어 있다)", async () => {
  await with_mode("on", (m) => {
    ok(m.py(["round-start", m.slug, "plan"]), "round-start");
    const { text } = show_stage(m, "changes");
    assert.ok(text.trim().length > 0);
  });
});
