// Dual-run harness (SEL-70): normalisers N1~N10, target selection, the E01~E15 table, and the explicit list of cases
// the TS target cannot run yet. Nothing here is skipped: a missing TS command is an asserted "not_yet".
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { baseline_for, baseline_path, compare_ts_record, load_table, not_yet_ids, read_baseline, run_case, type CaseDef, type CaseRecord } from "./helpers/compat_cases.ts";
import { KNOWN_DIFFS, STAGES, TS_FILES, dto_from_project_json, make_ctx, read_state_dto, run_pes, run_setup, target_from_env, ts_available, ts_gate, type CaseKind } from "./helpers/compat_env.ts";
import {
  html_unescape,
  lines,
  n1_json,
  n1_time,
  n10_apply,
  n10_checks,
  n10_files,
  n10_override,
  n11_relpaths,
  n12_stdlib_error_page,
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

test("the rows that still differ per OS / PC (E13 http, E14 setup, E15 doctor) say how the single baseline copes, with a reason each", () => {
  const table = load_table();
  for (const id of ["E13", "E14", "E15"]) {
    const notes = table.cases.find((c) => c.id === id)?.os_notes ?? [];
    assert.ok(notes.length >= 3, `${id}: os_notes missing`);
    for (const note of notes) {
      assert.ok(note.what.length > 3 && note.why.length > 10, `${id}: ${note.what}`);
      assert.match(note.handling, /정규화|제외|임시 HOME|하나의 기준값|narrow_path|접속하지 못하게 막는다/, `${id}: ${note.what} must be normalised, excluded or moved to the temp HOME`);
    }
  }
  // the machine-dependent rows really are out of the baselines: no tool state, no server state, no version
  const e14_check = JSON.parse(((read_baseline("E14").steps[1] as any).stdout as string[])[0] as string) as { stable: Record<string, string> };
  assert.deepEqual(Object.keys(e14_check.stable).sort(), ["key-kosis", "key-law", "key-vworld", "python"], "E14 pins only rows no machine can change");
  for (const id of ["E14", "E15"]) assert.ok(!/0\.15\.\d|Python 3\.\d/.test(JSON.stringify(read_baseline(id))), `${id}: a version number is pinned`);
  // …except the server rows: the child cannot reach the hub ports (block_hub), so "꺼짐" is the same on every PC and is pinned whole
  assert.ok(JSON.stringify(read_baseline("E15")).includes("꺼짐"), "E15: the server rows are pinned (no <STATE> mask)");
  assert.ok(!JSON.stringify(read_baseline("E15")).includes("<STATE>"), "E15: the server rows are not masked");
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

const KINDS: CaseKind[] = ["cli", "http", "setup"];
const kind_of = (id: string): CaseKind => load_table().cases.find((c) => c.id === id)?.kind as CaseKind;

test("target selection: py runs, ts answers not_yet for every kind while its scripts/*.ts file does not exist", () => {
  assert.equal(target_from_env("py"), "py");
  const ctx = make_ctx("pes-harness-");
  try {
    const py = run_pes("py", ctx, ["remote"]);
    assert.equal(py.kind, "ran");
    assert.equal(py.kind === "ran" ? py.status : -1, 0);
    // one ts file per kind of case: pes.ts (cli) / serve.ts (http) / setup.ts (setup). A file exists exactly when some case of
    // that kind is listed as implemented — otherwise the ratchet has to be turned by hand (cases.json + TS_IMPLEMENTED + wiring).
    for (const kind of KINDS) {
      const implemented = TS_IMPLEMENTED.filter((id) => kind_of(id) === kind).length;
      assert.equal(ts_available(kind), implemented > 0, `${TS_FILES[kind]} ${ts_available(kind) ? "appeared" : "is missing"}: wire the ts "${kind}" target in compat_env / compat_cases and update TS_IMPLEMENTED + cases.json`);
    }
    if (!ts_available("cli")) {
      assert.equal(run_pes("ts", ctx, ["remote"]).kind, "not_yet");
      assert.equal(read_state_dto("ts", ctx, ctx.project()).kind, "not_yet");
    }
    if (!ts_available("setup")) assert.equal(run_setup("ts", ctx, ["check", "--json"]).kind, "not_yet");
  } finally {
    ctx.cleanup();
  }
});

test("the ts gate throws as soon as the ts file of a kind exists (pes.ts, serve.ts and setup.ts alike) — the file is injected, scripts/ is not touched", () => {
  for (const kind of KINDS) {
    const absent = ts_gate(kind, () => false);
    assert.equal(absent.kind, "not_yet");
    assert.match(absent.reason, new RegExp(`scripts/${kind === "cli" ? "pes" : kind === "http" ? "serve" : "setup"}\\.ts`));
    assert.throws(() => ts_gate(kind, (path) => path === TS_FILES[kind]), /exists: wire the ts target/, kind);
    // only the file of the kind itself counts
    assert.equal(ts_gate(kind, (path) => path !== TS_FILES[kind]).kind, "not_yet", kind);
  }
});

test("the not-yet list on the TS target equals the table exactly (an implemented case must leave the list)", async () => {
  const expected = ALL_IDS.filter((id) => !TS_IMPLEMENTED.includes(id));
  assert.deepEqual(not_yet_ids(), expected, "cases.json ts.status and TS_IMPLEMENTED disagree");
  assert.equal(expected.length, 15 - TS_IMPLEMENTED.length);
  // the three ts files, each against its kind of cases: a file that exists without an implemented case of its kind (E08/E09/E13
  // http, E14 setup, the rest cli) means the not-yet entries were forgotten.
  for (const kind of KINDS) {
    const of_kind = ALL_IDS.filter((id) => kind_of(id) === kind);
    const missing = of_kind.filter((id) => !TS_IMPLEMENTED.includes(id));
    if (ts_available(kind)) assert.deepEqual(missing, [], `${TS_FILES[kind]} exists but these ${kind} cases are still not_yet`);
    else assert.deepEqual(missing, of_kind, `${TS_FILES[kind]} is missing but ${kind} cases are listed as implemented`);
  }
  for (const id of expected) {
    const outcome = await run_case("ts", id);
    assert.equal(outcome.kind, "not_yet", `${id} ran on the ts target although it is listed as not_yet`);
  }
});

// ---------------------------------------------------------------- "implemented" means the same comparison as py (injected records)
// No ts target exists, so a fake `implemented` case is built from the pinned baseline itself: a copy of it stands in for the ts record.
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const def_of = (id: string): CaseDef => load_table().cases.find((c) => c.id === id) as CaseDef;
const with_diffs = (id: string, diffs: string[]): CaseDef => ({ ...def_of(id), diffs });

test("an implemented ts case with the baseline's own record passes (the comparison is not stricter than the contract)", () => {
  // E03 is the one case whose pinned 0.15 value is a known defect (D06): it passes with the fixed value, see the D06 test below.
  for (const id of ALL_IDS.filter((x) => x !== "E03")) compare_ts_record(def_of(id), clone(read_baseline(id)), read_baseline(id));
});

test("an implemented ts case fails when a produced file differs, is missing, or is extra (files are compared like on py)", () => {
  const base = read_baseline("E02");
  const names = Object.keys(base.files);
  assert.ok(names.length >= 2, "E02 must pin produced files (ask HTML, report…)");
  const changed = clone(base);
  changed.files[names[0] as string] = "0000000000000000";
  assert.throws(() => compare_ts_record(def_of("E02"), changed, base), /produced files differ/);
  const missing = clone(base);
  delete missing.files[names[0] as string];
  assert.throws(() => compare_ts_record(def_of("E02"), missing, base), /produced files differ/);
  const extra = clone(base);
  extra.files["out/extra.md"] = "1111111111111111";
  assert.throws(() => compare_ts_record(def_of("E02"), extra, base), /produced files differ/);
  const steps = clone(base);
  (steps.steps[0] as any).exit = 99;
  assert.throws(() => compare_ts_record(def_of("E02"), steps, base), /stdout \/ stderr kind \/ exit differ/);
});

test("a name-pattern difference removes only its own files: D07 drops snapshots/** by name and checks their contents instead", () => {
  const base = read_baseline("E03");
  const snapshots = Object.keys(base.files).filter((name) => name.startsWith("snapshots/"));
  assert.ok(snapshots.length >= 2, "E03 pins the first state and a later state of the same round");
  const kept = n10_files(base.files, ["D07"], KNOWN_DIFFS);
  assert.deepEqual(Object.keys(kept).filter((name) => name.startsWith("snapshots/")), []);
  assert.equal(Object.keys(kept).length, Object.keys(base.files).length - snapshots.length, "only snapshots/** is removed, nothing else");

  // the new core keeps its editions under other names (the ts record builder lists them below snapshots/** too): accepted, contents unchanged
  const moved = clone(base);
  (moved.dto as any).stages.research.items[2].depth = 2; // D06: the fixed value, unrelated to this test
  for (const name of snapshots) {
    moved.files[`snapshots/edition-${name.replace(/^snapshots\//, "").replace(/\W+/g, "-")}`] = moved.files[name] as string;
    delete moved.files[name];
  }
  compare_ts_record(def_of("E03"), moved, base);

  // a lost state (the first one, or a later one) fails even though no remaining file differs by name
  for (const lost of snapshots) {
    const less = clone(moved);
    delete less.files[`snapshots/edition-${lost.replace(/^snapshots\//, "").replace(/\W+/g, "-")}`];
    assert.throws(() => compare_ts_record(def_of("E03"), less, base), /snapshot state of 0\.15 .* is missing/, lost);
  }
  // a changed content fails too
  const edited = clone(moved);
  edited.files[Object.keys(edited.files).find((name) => name.startsWith("snapshots/edition-")) as string] = "0000000000000000";
  assert.throws(() => compare_ts_record(def_of("E03"), edited, base), /snapshot state of 0\.15/);
  // without D07 the same move is a files difference
  assert.throws(() => compare_ts_record(with_diffs("E03", []), moved, base), /produced files differ|DTO differs/);
});

test("D06 is a value, not a hole: E03 item 7 must be depth 2 (0.15 says 3); D01 / D03 keep their own checks", () => {
  const base = read_baseline("E03");
  const fixed = clone(base);
  (fixed.dto as any).stages.research.items[2].depth = 2;
  compare_ts_record(def_of("E03"), fixed, base);
  for (const wrong of [1, 3, 99]) {
    const bad = clone(fixed);
    (bad.dto as any).stages.research.items[2].depth = wrong;
    assert.throws(() => compare_ts_record(def_of("E03"), bad, base), /state DTO differs/, `depth ${wrong}`);
  }
  const other = clone(fixed);
  (other.dto as any).stages.research.items[0].depth = 5;
  assert.throws(() => compare_ts_record(def_of("E03"), other, base), /state DTO differs/, "an unrelated depth is still compared");
  assert.throws(() => n10_override({ stages: {} }, "E03", ["D06"], KNOWN_DIFFS), /does not exist/);

  // D01: ids may be anything, but present and distinct
  const uuid = clone(fixed);
  (uuid.dto as any).stages.research.items.forEach((item: any, index: number) => (item.id = `id-${index}`));
  compare_ts_record(def_of("E03"), uuid, base);
  const repeated = clone(uuid);
  (repeated.dto as any).stages.research.items[1].id = "id-0";
  assert.throws(() => compare_ts_record(def_of("E03"), repeated, base), /own check failed/);
  assert.match(n10_checks({ stages: { research: { items: [{ id: 1 }, { id: 1 }] } } }, { stages: { research: {} } }, ["D01"], KNOWN_DIFFS)[0] ?? "", /repeat/);

  // D03: processed stays a list of the same length
  const e07 = read_baseline("E07");
  assert.deepEqual(n10_checks(clone(e07.dto), e07.dto, ["D03"], KNOWN_DIFFS), []);
  assert.match(n10_checks({ ...(e07.dto as object), processed: "x" }, e07.dto, ["D03"], KNOWN_DIFFS)[0] ?? "", /processed/);
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
  const out = n10_apply(dto, ["D01"], KNOWN_DIFFS) as any;
  assert.equal(out.stages.research.items[0].id, undefined);
  assert.equal(out.stages.research.items[0].depth, 2, "D01 drops the id only; depth is D06's and is never dropped");
  assert.equal(out.stages.research.items[1].title, "u");
  assert.equal(dto.stages.research.items[0]?.id, 1, "the input is not modified");
  assert.deepEqual(n10_files({ "snapshots/a.json": "1", "snapshots/x/2.json": "2", "report.md": "3" }, ["D07"], KNOWN_DIFFS), { "report.md": "3" });
  assert.deepEqual(n10_files({ "snapshots/a.json": "1" }, [], KNOWN_DIFFS), { "snapshots/a.json": "1" }, "no listed difference, nothing removed");
  assert.deepEqual((n10_apply(dto, ["D03"], KNOWN_DIFFS) as any).processed, undefined);
  assert.throws(() => n10_apply(dto, ["D99"], KNOWN_DIFFS), /unknown intended difference/);
});

test("state DTO: only the fields of 7.1, items in input order, library carried, no volatile file name", () => {
  const dto = dto_from_project_json(
    { pes: 1, topic: "t", slug: "s", created: "2026-11-11", current: "plan", complete: false, settings: {}, processed: [], notes: [], extra: "x", stages: { plan: { status: "asking", round: 0, junk: 1, items: [{ id: 1, title: "a", extra: 1 }] } } },
    { items: [] },
  );
  assert.deepEqual(Object.keys(dto).sort(), ["complete", "conclusion", "created", "current", "executive_summary", "library", "notes", "pes", "processed", "settings", "slug", "stages", "topic"]);
  const plan = dto.stages.plan as any;
  assert.equal(plan.junk, undefined);
  assert.deepEqual(plan.items, [{ id: 1, title: "a" }]);
  assert.deepEqual(dto.library, { items: [] });
});

test("N11 relative file paths: a printed `\\` path becomes `/`; roots, literal \\n and stored data are untouched", () => {
  assert.equal(n11_relpaths("웹 보고서 reports\\plan\\report.html, 마크다운 reports\\plan\\report.md"), "웹 보고서 reports/plan/report.html, 마크다운 reports/plan/report.md");
  assert.equal(n11_relpaths("reports/plan/report.html"), "reports/plan/report.html");
  assert.equal(n11_relpaths("줄\\n바꿈 a\\nb"), "줄\\n바꿈 a\\nb", "no file extension → not a path");
  assert.equal(n8_console("기획보고서: reports\\plan\\report.html\r\n", {}), "기획보고서: reports/plan/report.html\n");
  // the same path as DATA (project.json) is not passed through n8_console by the runner; n3_json keeps it
  assert.equal(n3_json({ path: "reports\\plan\\report.html" }), '{\n "path": "reports\\\\plan\\\\report.html"\n}');
});

test("N12 stdlib error page: only an HTML error from http.server counts, whatever the Python version's wording", () => {
  const short = '<!DOCTYPE HTML>\n<html lang="en">\n<head><title>Error response</title></head>\n<body><h1>Error response</h1>\n<p>Error code: 404</p></body></html>\n';
  const long = '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN">\n<html><head><title>Error response</title></head><body><h1>Error response</h1><p>Error code: 404</p><p>Message: File not found.</p></body></html>';
  assert.equal(n12_stdlib_error_page(404, short), "<python http.server error page>");
  assert.equal(n12_stdlib_error_page(404, long), "<python http.server error page>");
  assert.equal(n12_stdlib_error_page(200, short), null, "a 200 is never the error page");
  assert.equal(n12_stdlib_error_page(404, "<html>Not found</html>"), null, "PES's own 404 text is compared as is");
});

test("os_overrides: win32 edits apply on win32 only, a path that is not in the baseline throws, json_set edits a JSON text", () => {
  const base = read_baseline("E05");
  assert.deepEqual(baseline_for("E05", "darwin", base), base, "no override on macOS / Linux");
  const win = baseline_for("E05", "win32", base) as any;
  assert.equal(win.dto.stages.plan.reports[0].path, "reports\\plan\\report.html");
  assert.ok(win.dto.stages.plan.reports[0].bytes > (base as any).dto.stages.plan.reports[0].bytes, "CRLF makes the stored size larger");
  assert.notEqual(win.files["project.json"], base.files["project.json"]);
  assert.equal(win.files["reports/plan/report.html"], base.files["reports/plan/report.html"], "report contents are compared after CRLF → LF (N7), so they stay equal");
  const e14 = baseline_for("E14", "win32") as any;
  const stable = JSON.parse(e14.steps[1].stdout[0]);
  assert.ok(stable.names.includes("gitbash") && stable.names.length === stable.groups.length, "gitbash row: one name and one group more");
  assert.equal(JSON.parse((read_baseline("E14") as any).steps[1].stdout[0]).names.includes("gitbash"), false);
  // a patch whose path is gone fails loudly
  const broken = { ...base, dto: null } as any;
  assert.throws(() => baseline_for("E05", "win32", broken), /not in the baseline/);
});

test("every os_overrides entry names a README item and a reason", () => {
  for (const c of load_table().cases) {
    for (const [platform, o] of Object.entries(c.os_overrides ?? {})) {
      assert.ok(platform === "win32" || platform === "linux" || platform === "darwin", `${c.id}: unknown platform ${platform}`);
      assert.ok(o.item.length > 0 && o.what.length > 0 && o.why.length > 0 && o.edits.length > 0, `${c.id}: os_overrides[${platform}] needs item/what/why/edits`);
      for (const item of o.item.split(",")) assert.ok(readFileSync(new URL("./README.md", import.meta.url), "utf8").includes(`**${item}.`), `${c.id}: README has no item ${item}`);
    }
  }
});
