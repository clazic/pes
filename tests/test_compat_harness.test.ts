// Dual-run harness (SEL-70): normalisers N1~N10, target selection, the E01~E15 table, and the explicit list of cases
// the TS target cannot run yet. Nothing here is skipped: a missing TS command is an asserted "not_yet".
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { ts_baseline, baseline_for, baseline_path, compare_ts_record, d02_drop_defaults, file_digest, load_contract_table, load_table, not_yet_ids, read_baseline, run_case, type CaseDef, type CaseRecord } from "./helpers/compat_cases.ts";
import { KNOWN_DIFFS, STAGES, TS_FILES, dto_from_project_json, make_ctx, read_state_dto, run_pes, run_setup, target_from_env, ts_available, ts_gate, type CaseKind } from "./helpers/compat_env.ts";
import {
  d06_depth_fix,
  d06_file_fix,
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
  n13_os_not_found,
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
import { SEL72_DONE } from "./helpers/sel72_scope.ts";
import { SEL71_DONE, SEL77_DONE } from "./helpers/sel_scope.ts";

use_home_guard();

// ---------------------------------------------------------------- the list of cases the TS target implements today
// SEL-71 (PR26b) turned the ratchet from "per kind" into "per case": cases.json `ts.status` says, case by case, whether the ts target
// must match 0.15 (implemented) or answers not_yet (and is not even run, whether the scripts/*.ts file exists or not). Edit this list and
// cases.json together. The owners: SEL71_DONE (pes.ts, tests/helpers/sel_scope.ts; tests/test_pes_ts_contract.test.ts pins it) and
// SEL72_DONE (E08 E09 E13 → serve.ts, E14 → setup.ts; tests/helpers/sel72_scope.ts); SEL77_DONE (E05 E06 E07 E11 E12 E15, the read / report / doctor commands) since SEL-77 — no not_yet case is left.
const TS_IMPLEMENTED: string[] = [...SEL71_DONE.filter((id) => id.startsWith("E")), ...SEL72_DONE, ...SEL77_DONE.filter((id) => id.startsWith("E"))];
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
  const used = new Set([...load_table().cases, ...load_contract_table().cases].flatMap((c) => c.diffs));
  for (const [id, diff] of Object.entries(KNOWN_DIFFS)) {
    assert.equal(diff.id, id);
    assert.ok(diff.title.length > 0 && diff.reason.length > 10, id);
    // Reason: D14 (un-migrated old folder is read-only) is not a 0.15-vs-ts baseline case — 0.15 would write — so it is pinned by its own test; every other difference still needs a case.
    if (id === "D14") continue;
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

test("target selection: py runs; a ts kind with an implemented case needs its scripts/*.ts file, a kind without one has none yet", () => {
  assert.equal(target_from_env("py"), "py");
  const ctx = make_ctx("pes-harness-");
  try {
    const py = run_pes("py", ctx, ["remote"]);
    assert.equal(py.kind, "ran");
    assert.equal(py.kind === "ran" ? py.status : -1, 0);
    // one ts file per kind of case: pes.ts (cli) / serve.ts (http) / setup.ts (setup). Per-case ratchet (SEL-71): a kind that has an
    // implemented case needs its file (a missing pes.ts is what fails SEL-71 until the worker writes it); a kind with none keeps no
    // file yet — serve.ts / setup.ts appearing without turning their cases is a forgotten ratchet.
    for (const kind of KINDS) {
      const implemented = TS_IMPLEMENTED.filter((id) => kind_of(id) === kind).length;
      assert.equal(ts_available(kind), implemented > 0, `${TS_FILES[kind]} ${ts_available(kind) ? "appeared with no implemented case of that kind (turn the cases in cases.json + TS_IMPLEMENTED)" : "is missing but cases of that kind are implemented in cases.json"}`);
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

test("the ts gate only reports the missing file of a kind (all of pes.ts, serve.ts, setup.ts are wired: SEL-71 / SEL-72) — the file is injected, scripts/ is not touched", () => {
  for (const kind of KINDS) {
    const absent = ts_gate(kind, () => false);
    assert.equal(absent.kind, "not_yet");
    assert.match(absent.reason, new RegExp(`scripts/${kind === "cli" ? "pes" : kind === "http" ? "serve" : "setup"}\\.ts`));
    assert.equal(ts_gate(kind, (path) => path === TS_FILES[kind]).kind, "not_yet", `${kind}: wired, an existing file is not the gate's business`);
    // only the file of the kind itself counts
    assert.equal(ts_gate(kind, (path) => path !== TS_FILES[kind]).kind, "not_yet", kind);
  }
});

test("the not-yet list on the TS target equals the table exactly (an implemented case must leave the list; a not-yet case is never run)", async () => {
  const expected = ALL_IDS.filter((id) => !TS_IMPLEMENTED.includes(id));
  assert.deepEqual(not_yet_ids(), expected, "cases.json ts.status and TS_IMPLEMENTED disagree");
  assert.equal(expected.length, 15 - TS_IMPLEMENTED.length);
  // the implemented http / setup cases are exactly SEL-72's (serve.ts / setup.ts)
  assert.deepEqual(TS_IMPLEMENTED.filter((id) => kind_of(id) !== "cli"), [...SEL72_DONE], "http / setup cases are SEL-72's");
  // per-case ratchet: a not-yet case answers not_yet WITHOUT running anything, whether or not scripts/pes.ts exists
  for (const id of expected) {
    const outcome = await run_case("ts", id);
    assert.equal(outcome.kind, "not_yet", `${id} ran on the ts target although it is listed as not_yet`);
  }
});

// ---------------------------------------------------------------- "implemented" means the same comparison as py (injected records)
// No ts target exists, so a fake `implemented` case is built from the pinned baseline itself: a copy of it stands in for the ts record.
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
/** The baseline as a (correct) ts record would show it: every 0.15 traceback step (D11) ends in a plain Korean one-line error instead. */
function ts_like(record: CaseRecord): CaseRecord {
  const copy = clone(record);
  for (const step of copy.steps as any[]) if (Array.isArray(step.stderr) && step.stderr.some((l: string) => l.startsWith("traceback:"))) step.stderr = ["오류: 합성 한국어 메시지 (스택 추적 없음)"];
  return copy;
}
const def_of = (id: string): CaseDef => load_table().cases.find((c) => c.id === id) as CaseDef;
const with_diffs = (id: string, diffs: string[]): CaseDef => ({ ...def_of(id), diffs });

test("an implemented ts case with the baseline's own record passes (the comparison is not stricter than the contract)", () => {
  // E03 is the one case whose pinned 0.15 value is a known defect (D06): it passes with the fixed value, see the D06 test below.
  for (const id of ALL_IDS.filter((x) => x !== "E03")) compare_ts_record(def_of(id), ts_like(read_baseline(id)), read_baseline(id));
});

test("an implemented ts case fails when a produced file differs, is missing, or is extra (files are compared like on py)", () => {
  const base = read_baseline("E02");
  const names = Object.keys(base.files);
  assert.ok(names.length >= 2, "E02 must pin produced files (ask HTML, report…)");
  // D02 drops project.json / library.json by name (the DTO covers them): pick a file that is still compared
  const compared = names.filter((n) => !["project.json", "library.json"].includes(n));
  const changed = ts_like(base);
  changed.files[compared[0] as string] = "0000000000000000";
  assert.throws(() => compare_ts_record(def_of("E02"), changed, base), /produced files differ/);
  const missing = ts_like(base);
  delete missing.files[compared[0] as string];
  assert.throws(() => compare_ts_record(def_of("E02"), missing, base), /produced files differ/);
  const extra = ts_like(base);
  extra.files["out/extra.md"] = "1111111111111111";
  assert.throws(() => compare_ts_record(def_of("E02"), extra, base), /produced files differ/);
  const steps = ts_like(base);
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
  const moved = ts_like(base);
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
  assert.throws(() => compare_ts_record(with_diffs("E03", ["D11"]), moved, base), /produced files differ|DTO differs/);
});

test("D06 is a value, not a hole: E03 item 7 must be depth 2 (0.15 says 3); D01 / D03 keep their own checks", () => {
  const base = read_baseline("E03");
  const fixed = ts_like(base);
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

test("N13 OS 'not found' wording: the two Windows phrases fold to the POSIX one in a traceback line; other messages stay", () => {
  const posix = "FileNotFoundError: [Errno 2] No such file or directory: '<TMP>/work/없는-프로젝트/ask'";
  const win3 = "FileNotFoundError: [WinError 3] The system cannot find the path specified: '<TMP>/work/없는-프로젝트/ask'";
  const win2 = "FileNotFoundError: [WinError 2] The system cannot find the file specified: '<TMP>/work/a.json'";
  assert.equal(n13_os_not_found(win3), posix);
  assert.equal(n13_os_not_found(win2), "FileNotFoundError: [Errno 2] No such file or directory: '<TMP>/work/a.json'");
  assert.equal(n13_os_not_found(posix), posix, "the POSIX form is unchanged");
  // not the same meaning → never folded
  assert.equal(n13_os_not_found("PermissionError: [WinError 5] Access is denied: 'x'"), "PermissionError: [WinError 5] Access is denied: 'x'");
  assert.equal(n13_os_not_found("FileExistsError: [WinError 183] Cannot create a file when that file already exists: 'x'"), "FileExistsError: [WinError 183] Cannot create a file when that file already exists: 'x'");
  assert.equal(n13_os_not_found("KeyError: 'The system cannot find the path specified:'"), "KeyError: 'The system cannot find the path specified:'");
  // through stderr_kind (a Windows traceback)
  const tb = 'Traceback (most recent call last):\r\n  File "C:\\x\\pes.py", line 9, in main\r\n' + win3 + "\r\n";
  assert.deepEqual(stderr_kind(tb, {}), ["traceback: " + posix]);
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

test("os_overrides split: ts baseline on win32 has W3 (gitbash row) but not W1·W2; py baseline has all", () => {
  const names = (r: any) => JSON.parse(r.steps[1].stdout[0]).names as string[];
  assert.ok(names(ts_baseline("E14", "win32")).includes("gitbash"), "W3 applies to ts");
  assert.ok(names(baseline_for("E14", "win32")).includes("gitbash"));
  assert.equal(names(ts_baseline("E14", "darwin")).includes("gitbash"), false, "no W3 off Windows");
  for (const id of ["E05", "E11"]) assert.deepEqual(ts_baseline(id, "win32"), read_baseline(id), `${id}: W1·W2 not applied to ts`);
  for (const c of load_table().cases) for (const o of Object.values(c.os_overrides ?? {})) assert.equal(o.applies_to_ts === true, o.item === "W3", `${c.id}: only W3 applies to ts`);
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

// ---------------------------------------------------------------- SEL-71 sorting of E03 / E10 (mutation tests)
test("D06 on produced files: only the named item's depth is rewritten — any other field difference still changes the digest", () => {
  const fix = d06_depth_fix("E03", ["D01", "D06"], KNOWN_DIFFS);
  assert.deepEqual(fix, { item_id: 7, delta: 1 });
  assert.equal(d06_depth_fix("E01", ["D06"], KNOWN_DIFFS), undefined, "D06 has no file rule for other cases");
  const state = (depth: number, summary: string) => ({ state: { items: [{ id: 1, depth: 2, summary: "a" }, { id: 7, depth, summary }] } });
  const bytes = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8");
  const digest = (value: unknown, apply = true) => file_digest("snapshots/x.json", bytes(value), {}, apply ? fix : undefined);
  // 0.15 content (depth 3) == ts content with the fixed depth (2) after the rewrite; the item id 1 is left alone
  assert.equal(digest(state(2, "s")), digest(state(3, "s"), false));
  // mutations: another field, another item's depth, a depth that is not the fixed one — all stay different
  assert.notEqual(digest(state(2, "t")), digest(state(3, "s"), false), "a summary difference must still fail");
  assert.notEqual(digest(state(3, "s")), digest(state(3, "s"), false), "depth 3 on ts is not the fixed value (+1 → 4)");
  assert.notEqual(digest({ state: { items: [{ id: 1, depth: 3, summary: "a" }, { id: 7, depth: 2, summary: "s" }] } }), digest(state(3, "s"), false), "item 1 depth is not rewritten");
  // html: the data JSON gets the same rewrite, the rest of the page is compared as is
  const page = (depth: number, text: string) => Buffer.from(`<html><head><title>t</title></head><body>${text}<script id="data" type="application/json">${JSON.stringify(state(depth, "s"))}</script></body></html>`, "utf8");
  assert.equal(file_digest("index.html", page(2, "x"), {}, fix), file_digest("index.html", page(3, "x"), {}));
  assert.notEqual(file_digest("index.html", page(2, "y"), {}, fix), file_digest("index.html", page(3, "x"), {}), "visible text difference must still fail");
  assert.equal(d06_file_fix(state(2, "s"), undefined) !== undefined, true);
});

test("D02 default keys (E10): only slug / created / settings / complete, only at their defaults, only when the baseline lacks them", () => {
  const base = { pes: 1, topic: "t", stages: {} };
  const got = { ...base, slug: "legacy-project", created: "", settings: {}, complete: false };
  assert.deepEqual(d02_drop_defaults(got, base, "legacy-project"), base);
  // wrong values stay and fail the comparison
  assert.notDeepEqual(d02_drop_defaults({ ...got, slug: "other" }, base, "legacy-project"), base);
  assert.notDeepEqual(d02_drop_defaults({ ...got, created: "2026-01-01" }, base, "legacy-project"), base);
  assert.notDeepEqual(d02_drop_defaults({ ...got, settings: { a: 1 } }, base, "legacy-project"), base);
  assert.notDeepEqual(d02_drop_defaults({ ...got, complete: true }, base, "legacy-project"), base);
  // a key outside the list is never dropped
  assert.notDeepEqual(d02_drop_defaults({ ...got, extra: 1 }, base, "legacy-project"), base);
  // a key the baseline has is compared as is (the baseline value wins)
  assert.deepEqual(d02_drop_defaults({ ...got, slug: "x" }, { ...base, slug: "legacy-project" }, "legacy-project"), { ...base, slug: "x" });
});

// ---------------------------------------------------------------- D13 (SEL-71 review 1): refused-on-purpose steps
const x_def = (id: string): CaseDef => load_contract_table().cases.find((c) => c.id === id) as CaseDef;
/** What a correct ts run of X08 / X09 records: the 0.15 baseline, the divergent step replaced by the pinned ts result, the end state = ts_end. */
function d13_ts_like(id: string): CaseRecord {
  const base = read_baseline(id);
  const copy = clone(base);
  const own = KNOWN_DIFFS.D13?.ts_steps?.[id] ?? [];
  for (const [index, step] of (copy.steps as any[]).entries()) {
    const mine = own.find((x) => JSON.stringify(x.step) === JSON.stringify(step.step));
    if (mine !== undefined) copy.steps[index] = { ...step, exit: mine.exit, stdout: mine.stdout, stderr: mine.stderr };
  }
  copy.dto = (base.ts_end as NonNullable<CaseRecord["ts_end"]>).dto;
  copy.files = (base.ts_end as NonNullable<CaseRecord["ts_end"]>).files;
  delete copy.ts_end;
  return copy;
}

test("D13: every ts_steps entry names exactly one `d13` step of its case, every `d13` step has an entry, and the ts text is one Korean line without a code prefix or stack", () => {
  for (const [id, wanted] of Object.entries(KNOWN_DIFFS.D13?.ts_steps ?? {})) {
    const def = x_def(id);
    assert.ok(def.diffs.includes("D13"), `${id} must list D13`);
    const flagged = def.steps.filter((s) => s.d13 === true).map((s) => s.run);
    assert.deepEqual(flagged, wanted.map((w) => w.step), `${id}: d13-flagged steps and ts_steps must be the same list`);
    for (const w of wanted) {
      assert.equal(w.exit, 1);
      assert.deepEqual(w.stdout, []);
      assert.equal(w.stderr.length, 1);
      assert.match(w.stderr[0] as string, /[가-힣]/);
      assert.doesNotMatch(w.stderr[0] as string, /^[a-z_]+: [a-z_ ]+$|conflict|ERR_|Error/, "no English `code: message` text");
    }
    const base = read_baseline(id);
    assert.ok(base.ts_end, `${id}: baseline carries ts_end`);
    assert.notDeepEqual(base.ts_end?.dto, base.dto, `${id}: the end state without the divergent step must differ from the 0.15 one (otherwise the step is not divergent)`);
  }
  assert.deepEqual(Object.keys(KNOWN_DIFFS.D13?.ts_steps ?? {}).sort(), ["X08", "X09"]);
});

test("D13: the pinned wording (the 0.15 result stays in the baseline: exit 0)", () => {
  assert.deepEqual(KNOWN_DIFFS.D13?.ts_steps?.X08?.[0]?.stderr, ["approve: 앞 단계(기획)가 아직 승인되지 않았습니다"]);
  assert.deepEqual(KNOWN_DIFFS.D13?.ts_steps?.X09?.[0]?.stderr, ["round-start: 기획은 이미 승인됐습니다 — 먼저 reopen 하세요"]);
  const steps = (id: string) => read_baseline(id).steps as any[];
  assert.equal(steps("X08")[1].exit, 0);
  assert.deepEqual(steps("X08")[1].stdout.slice(0, 1), ["조사 승인"]);
  assert.equal(steps("X09")[3].exit, 0);
  assert.deepEqual(steps("X09")[3].stdout, ["기획 R1 시작"]);
});

test("D13: a record shaped like a correct ts run passes; the 0.15 result, another text, another exit, a stack, stdout or a changed end state fail", () => {
  for (const id of ["X08", "X09"]) {
    const def = x_def(id);
    const good = d13_ts_like(id);
    compare_ts_record(def, clone(good), read_baseline(id));
    const at = (good.steps as any[]).findIndex((s) => (KNOWN_DIFFS.D13?.ts_steps?.[id] ?? []).some((x) => JSON.stringify(x.step) === JSON.stringify(s.step)));
    const mutate = (fn: (step: any) => void): CaseRecord => {
      const copy = clone(good);
      fn(copy.steps[at]);
      return copy;
    };
    const base = read_baseline(id);
    assert.throws(() => compare_ts_record(def, clone(base), base), /ts_end|differs|DTO/, "the 0.15 behaviour itself is not accepted on ts");
    assert.throws(() => compare_ts_record(def, mutate((s) => (s.exit = 0)), base), /D13/);
    assert.throws(() => compare_ts_record(def, mutate((s) => (s.exit = 2)), base), /D13/);
    assert.throws(() => compare_ts_record(def, mutate((s) => (s.stderr = ["conflict: an earlier stage is not approved"])), base), /D13/);
    assert.throws(() => compare_ts_record(def, mutate((s) => (s.stderr = ["오류: 다른 문구"])), base), /D13/);
    assert.throws(() => compare_ts_record(def, mutate((s) => (s.stderr = [s.stderr[0], "다음 줄"])), base), /D13/);
    assert.throws(() => compare_ts_record(def, mutate((s) => (s.stdout = ["x"])), base), /D13/);
    assert.throws(() => compare_ts_record(def, mutate((s) => (s.stderr = ["    at file:///x.ts:1:1"])), base), /stack trace/);
    const moved = clone(good);
    moved.dto = clone(base.dto);
    assert.throws(() => compare_ts_record(def, moved, base), /DTO differs/, "the refused step must change nothing on ts");
    const files = clone(good);
    files.files = clone(base.files);
    const compared = (f: Record<string, string> | undefined) => JSON.stringify(Object.entries(f ?? {}).filter(([k]) => k !== "project.json" && k !== "library.json"));
    if (compared(base.files) !== compared(base.ts_end?.files)) assert.throws(() => compare_ts_record(def, files, base), /produced files differ/);
  }
});
