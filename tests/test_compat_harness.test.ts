// Dual-run harness (SEL-70): normalisers N1~N10, target selection, the E01~E15 table, and the explicit list of cases
// the TS target cannot run yet. Nothing here is skipped: a missing TS command is an asserted "not_yet".
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";

import { baseline_path, load_table, not_yet_ids, run_case } from "./helpers/compat_cases.ts";
import { KNOWN_DIFFS, STAGES, dto_from_project_json, make_ctx, read_state_dto, run_pes, run_setup, target_from_env, ts_available } from "./helpers/compat_env.ts";
import {
  html_unescape,
  lines,
  n1_json,
  n1_time,
  n10_apply,
  n2_paths,
  n3_json,
  n4_multiset,
  n4_order,
  n5_ids,
  n6_html,
  n7_text,
  n8_console,
  n9_text_hash,
  root_spellings,
  stderr_kind,
} from "./helpers/compat_normalize.ts";
import { use_home_guard } from "./helpers/home_guard.ts";

use_home_guard();

// ---------------------------------------------------------------- the list of cases the TS target implements today
// Edit this list (and cases.json `ts.status`) together when a case starts to work on the TS target.
const TS_IMPLEMENTED: string[] = [];
const ALL_IDS = Array.from({ length: 15 }, (_x, i) => `E${String(i + 1).padStart(2, "0")}`);

test("the table defines E01~E15 once each, with criteria, intended differences and a pinned 0.15 baseline", () => {
  const table = load_table();
  assert.deepEqual(table.cases.map((c) => c.id), ALL_IDS);
  for (const def of table.cases) {
    assert.ok(def.title.length > 0 && def.criteria.length > 0 && def.section.startsWith("7.4"), def.id);
    assert.ok(["cli", "http", "setup"].includes(def.kind), def.id);
    assert.ok(def.steps.length > 0, def.id);
    assert.ok(existsSync(baseline_path(def.id)), `${def.id}: no 0.15 baseline file`);
    for (const diff of def.diffs) assert.ok(KNOWN_DIFFS[diff], `${def.id}: unknown intended difference ${diff}`);
  }
});

test("what an E-row leaves out on purpose is written in the table with a reason (E13: open / serve / hub / stop)", () => {
  const e13 = load_table().cases.find((c) => c.id === "E13");
  assert.deepEqual(e13?.excluded?.map((x) => x.what), ["pes open <주소>", "pes serve / hub / stop"]);
  for (const x of e13?.excluded ?? []) assert.ok(x.why.length > 10);
});

test("every intended difference (7.5) carries a reason, and each is used by at least one case", () => {
  const used = new Set(load_table().cases.flatMap((c) => c.diffs));
  for (const [id, diff] of Object.entries(KNOWN_DIFFS)) {
    assert.equal(diff.id, id);
    assert.ok(diff.title.length > 0 && diff.reason.length > 10, id);
    assert.ok(used.has(id), `${id} is in the 7.5 table but no case lists it`);
  }
  // The two 0.15 defects (xfail in pytest) are pinned as intended differences, with the E03 case that carries them.
  const e03 = load_table().cases.find((c) => c.id === "E03");
  assert.ok(e03?.diffs.includes("D06"));
  assert.match(KNOWN_DIFFS.D06?.reason ?? "", /depth/);
  assert.match(KNOWN_DIFFS.D07?.reason ?? "", /snapshot/);
});

test("target selection: py runs, ts answers not_yet while scripts/pes.ts does not exist", () => {
  assert.equal(target_from_env("py"), "py");
  const ctx = make_ctx("pes-harness-");
  try {
    const py = run_pes("py", ctx, ["remote"]);
    assert.equal(py.kind, "ran");
    assert.equal(py.kind === "ran" ? py.status : -1, 0);
    assert.equal(ts_available(), TS_IMPLEMENTED.length > 0, "scripts/pes.ts appeared: wire the ts target in compat_env.run_pes and update TS_IMPLEMENTED + cases.json");
    if (!ts_available()) {
      assert.equal(run_pes("ts", ctx, ["remote"]).kind, "not_yet");
      assert.equal(run_setup("ts", ctx, ["check", "--json"]).kind, "not_yet");
      assert.equal(read_state_dto("ts", ctx, ctx.project()).kind, "not_yet");
    }
  } finally {
    ctx.cleanup();
  }
});

test("the not-yet list on the TS target equals the table exactly (an implemented case must leave the list)", async () => {
  const expected = ALL_IDS.filter((id) => !TS_IMPLEMENTED.includes(id));
  assert.deepEqual(not_yet_ids(), expected, "cases.json ts.status and TS_IMPLEMENTED disagree");
  assert.equal(expected.length, 15 - TS_IMPLEMENTED.length);
  for (const id of expected) {
    const outcome = await run_case("ts", id);
    assert.equal(outcome.kind, "not_yet", `${id} ran on the ts target although it is listed as not_yet`);
  }
});

// ---------------------------------------------------------------- normalisers
test("N1 time: minute, second, compact, ISO and date forms; time-like JSON keys", () => {
  assert.equal(n1_time("2026-11-11 16:30 승인"), "<TIME> 승인");
  assert.equal(n1_time("at 2026-11-11T16:30:05.123Z end"), "at <TIME> end");
  assert.equal(n1_time("plan-R2-20260101-123456.json"), "plan-R2-<TIME>.json");
  assert.equal(n1_time("created 2026-11-11"), "created <DATE>");
  const json = n1_json({ at: 1762847000.5, since: "2026-11-11 16:30", n: 3, nested: [{ built: "2026-11-11 16:31" }] }) as any;
  assert.equal(json.at, "<EPOCH>");
  assert.equal(json.since, "<TIME>");
  assert.equal(json.n, 3);
  assert.equal(json.nested[0].built, "<TIME>");
});

test("N2 paths: every root spelling (plain, native, python repr doubled backslashes) and backslashes below a root", () => {
  const roots = { PROJECT: "C:\\Users\\RUNNER~1\\work\\프로젝트", HOME: "C:\\Users\\RUNNER~1\\home", TMP: "C:\\Users\\RUNNER~1" };
  assert.equal(n2_paths("C:\\Users\\RUNNER~1\\work\\프로젝트\\out\\report.md", roots), "<PROJECT>/out/report.md");
  assert.equal(n2_paths("'C:\\\\Users\\\\RUNNER~1\\\\work\\\\프로젝트\\\\x'", roots), "'<PROJECT>/x'");
  assert.equal(n2_paths("C:\\Users\\RUNNER~1\\home\\.pes\\setup.json", roots), "<HOME>/.pes/setup.json");
  assert.equal(n2_paths("C:/Users/RUNNER~1/other", roots), "<TMP>/other");
  assert.ok(root_spellings("C:\\a\\b").includes("C:\\\\a\\\\b"));
  // the most specific root wins even when TMP is a prefix of PROJECT
  const posix = n2_paths("/t/work/p/project.json", { PROJECT: "/t/work/p", TMP: "/t" });
  assert.equal(posix, "<PROJECT>/project.json");
});

test("N3 JSON: key order and indent do not matter, number vs numeric string does, null and non-ASCII are kept", () => {
  assert.equal(n3_json({ b: 1, a: [{ d: 1, c: 2 }], 한글: "값" }), n3_json({ 한글: "값", a: [{ c: 2, d: 1 }], b: 1 }));
  assert.notEqual(n3_json({ n: 1 }), n3_json({ n: "1" }));
  assert.notEqual(n3_json({ n: null }), n3_json({}));
  assert.match(n3_json({ 한글: "값" }), /한글/);
  assert.notEqual(n3_json({ a: [1, 2] }), n3_json({ a: [2, 1] }), "arrays keep their order unless N4 says otherwise");
});

test("N4 order: business order (stage, round, id) and multiset comparison", () => {
  const rows = [
    { stage: "write", round: 1, id: 2 },
    { stage: "plan", round: 2, id: 1 },
    { stage: "plan", round: 1, id: 10 },
    { stage: "plan", round: 1, id: 9 },
  ];
  assert.deepEqual(n4_order(rows).map((r) => `${r.stage}${r.round}.${r.id}`), ["plan1.9", "plan1.10", "plan2.1", "write1.2"]);
  assert.deepEqual(n4_multiset([{ b: 1, a: 2 }, { a: 1 }]), n4_multiset([{ a: 1 }, { a: 2, b: 1 }]));
  assert.deepEqual(STAGES.length, 6);
});

test("N5 ids: first-appearance numbering keeps only the reference structure", () => {
  const seen = new Map<string, string>();
  const a = "11111111-1111-4111-8111-111111111111";
  const b = "22222222-2222-4222-8222-222222222222";
  assert.equal(n5_ids(`${a} ${b} ${a}`, seen), "<ID:1> <ID:2> <ID:1>");
  assert.equal(n5_ids(`lease_ABCDEFGH12 then ${b}`, seen), "<ID:3> then <ID:2>");
  assert.equal(n5_ids("plain 12 text"), "plain 12 text");
});

test("N6 html: title, data JSON, visible text — attribute order, whitespace, comments and `built` do not matter", () => {
  const one = '<html><head><title>합성 &lt;질문&gt;</title></head><body class="a" id="x"><!-- c --><p>안녕  <b>하세요</b></p><script id="data" type="application/json">{"built":"2026-11-11 16:30","spec":{"id":"x"}}</script><script>var x=1</script></body></html>';
  const two = '<html><head><title>합성 &lt;질문&gt;</title></head>\r\n<body id="x" class="a"><p>안녕 <b>하세요</b></p>\r\n<script type="application/json" id="data">{"built":"2026-12-01 01:02","spec":{"id":"x"}}</script></body></html>';
  const a = n6_html(one);
  assert.equal(a.title, "합성 <질문>");
  assert.deepEqual(a.data, { built: "<TIME>", spec: { id: "x" } });
  assert.equal(a.text, "안녕 하세요");
  assert.equal(n6_html(two).text, a.text);
  assert.deepEqual(n6_html(two).data, a.data, "attribute order of the data <script> does not matter");
  assert.equal(html_unescape("&lt;a&gt; &amp; &quot;q&quot; &#x27;"), "<a> & \"q\" '");
});

test("N7 encoding: BOM and CRLF are normalised, LF stays, a lone CR is kept", () => {
  assert.equal(n7_text("\uFEFFa\r\nb\nc\rd"), "a\nb\nc\rd");
  assert.deepEqual(lines("a\nb\n"), ["a", "b"]);
  assert.deepEqual(lines(""), []);
});

test("N8 console: ANSI removed, time and paths replaced, line order kept; stderr is reduced to a kind", () => {
  const roots = { PROJECT: "/t/p" };
  assert.equal(n8_console("\u001b[32mok\u001b[0m /t/p/out 2026-11-11 16:30\r\n", roots), "ok <PROJECT>/out <TIME>\n");
  const tb = 'Traceback (most recent call last):\n  File "/x/pes.py", line 9, in main\nKeyError: \'current\'\n';
  assert.deepEqual(stderr_kind(tb, roots), ["traceback: KeyError: 'current'"]);
  assert.deepEqual(stderr_kind("", roots), []);
  assert.deepEqual(stderr_kind("--topic 필요\n", roots), ["--topic 필요"]);
});

test("N9 file meta: only the normalised content counts (mtime and mode are not inputs at all)", () => {
  const roots = { PROJECT: "/t/p" };
  assert.equal(n9_text_hash("a\r\n/t/p/x 2026-11-11 16:30", roots), n9_text_hash("a\n<PROJECT>/x <TIME>", roots));
  assert.notEqual(n9_text_hash("a", roots), n9_text_hash("b", roots));
});

test("N10 known differences: listed paths are dropped from a copy; an unknown id throws", () => {
  const dto = { stages: { research: { items: [{ id: 1, depth: 2, title: "t" }, { id: 7, depth: 2, title: "u" }] } }, processed: ["a.json"] };
  const out = n10_apply(dto, ["D06"], KNOWN_DIFFS) as any;
  assert.equal(out.stages.research.items[0].depth, undefined);
  assert.equal(out.stages.research.items[1].title, "u");
  assert.equal(dto.stages.research.items[0]?.depth, 2, "the input is not modified");
  assert.deepEqual((n10_apply(dto, ["D03"], KNOWN_DIFFS) as any).processed, undefined);
  assert.throws(() => n10_apply(dto, ["D99"], KNOWN_DIFFS), /unknown intended difference/);
});

test("state DTO: only the fields of 7.1, items in input order, library carried, no volatile file name", () => {
  const dto = dto_from_project_json(
    { pes: 1, topic: "t", slug: "s", created: "2026-11-11", current: "plan", complete: false, settings: {}, processed: [], notes: [], extra: "x", stages: { plan: { status: "asking", round: 0, junk: 1, items: [{ id: 1, title: "a", extra: 1 }] } } },
    { items: [] },
  );
  assert.deepEqual(Object.keys(dto).sort(), ["complete", "conclusion", "created", "current", "executive_summary", "library", "notes", "processed", "settings", "slug", "stages", "topic"]);
  const plan = dto.stages.plan as any;
  assert.equal(plan.junk, undefined);
  assert.deepEqual(plan.items, [{ id: 1, title: "a" }]);
  assert.deepEqual(dto.library, { items: [] });
});
