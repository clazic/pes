// SEL-71: the comparison devices PR26a postponed — D02 (project.json → DB state DTO), D03 (feedback files → submissions), D04 (.pes-lock →
// lease) — and the rules of the ts target in the case ratchet (D10 posix storage, D11 tracebacks). These tests need no scripts/pes.ts:
// the 0.15 side is a hand-made 0.15 project folder (SEL-74: the py CLI that used to make it is gone — project.json written the way 0.15 saved it),
// the PR11/PR12 importer puts a COPY of it into a DB (compat_ts.ts_seed_legacy), and the device reads it back.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { test } from "node:test";

import {
  baseline_for,
  case_def,
  compare_steps,
  d02_canon,
  d03_stdout,
  assert_posix_storage,
  load_contract_table,
  load_table,
  looks_like_stack_trace,
  read_baseline,
  not_yet_ids,
  ts_baseline,
  type CaseRecord,
} from "./helpers/compat_cases.ts";
import { KNOWN_DIFFS, dto_from_project_json, make_ctx, project_json, type CompatCtx } from "./helpers/compat_env.ts";
import { REPO_ROOT, answers_multiset, ts_age_lease, ts_seed_feedback, ts_seed_legacy, ts_view, run_ts_cli } from "./helpers/compat_ts.ts";
import { use_home_guard } from "./helpers/home_guard.ts";

use_home_guard();

const home_of = (ctx: CompatCtx) => ({ env: ctx.env, pes_home: ctx.pes_home, home_dir: ctx.home_dir });
const BRIDGE = join(REPO_ROOT, "scripts", "pes_core", "cli_bridge.ts");

const STAGE_NAMES = ["plan", "research", "analyze", "write", "verify", "publish"] as const;

/** A 0.15 project folder written the way 0.15 saved it: plan R1 with two merged items, one html answer (pending) and one chat answer (processed). */
function make_015_project(folder: string, slug: string): void {
  const item = (id: number, kind: string, title: string, summary: string, sources: Array<{ url: string; title: string }>): Record<string, unknown> => ({
    id, title, kind, question: "", status: "done", request: "", depth: 1, updated_round: 1, summary, details: "", sources, stats: [], shots: [],
    confidence: "", conflicts: [], verify: [], links: {}, user_links: [],
  });
  const stage = (status: string, round: number, items: unknown[]): Record<string, unknown> => ({ status, round, settings: {}, items, review: null, suggestions: [], warnings: [], changes: [], history: [], summary: "", approved_at: null, stale: false, reports: [] });
  const stages: Record<string, unknown> = {};
  for (const name of STAGE_NAMES) {
    stages[name] = name === "plan"
      ? stage("active", 1, [
          item(1, "rq", "연구 질문", "요약", [{ url: "https://example.test/a", title: "출처 A" }, { url: "https://example.test/b", title: "출처 B" }]),
          item(2, "topic", "범위", "범위 요약", []),
        ])
      : stage("pending", 0, []);
  }
  mkdirSync(join(folder, "feedback"), { recursive: true });
  writeFileSync(join(folder, "feedback", "plan-R1-20260101-000000.json"), JSON.stringify({ stage: "plan", round: 1, kind: "feedback", text: "합성 답", via: "html" }), "utf8");
  writeFileSync(join(folder, "feedback", "plan-R1-20260101-000001.json"), JSON.stringify({ stage: "plan", round: 1, kind: "feedback", text: "채팅 글", via: "chat" }), "utf8");
  writeFileSync(
    join(folder, "project.json"),
    JSON.stringify({ pes: 1, topic: "합성 주제", slug, created: "2026-01-01", current: "plan", complete: false, settings: {}, processed: ["plan-R1-20260101-000001.json"], notes: [], stages }, null, 1),
    "utf8",
  );
}

/** A 0.15 project folder (in `a`), copied into `b` and imported into b's database. */
async function seeded_pair(name = "device-project"): Promise<{ a: CompatCtx; b: CompatCtx; py_folder: string; db_folder: string }> {
  const a = make_ctx("pes-dev-a-");
  const b = make_ctx("pes-dev-b-");
  const py_folder = join(a.tmp, name);
  make_015_project(py_folder, name);
  const db_folder = join(b.tmp, name);
  cpSync(py_folder, db_folder, { recursive: true });
  await ts_seed_legacy(home_of(b), db_folder);
  return { a, b, py_folder, db_folder };
}

test("D02: the DTO read from the database equals the DTO of the 0.15 project.json it came from (ids too: the importer keeps the numbers)", async () => {
  const { a, b, py_folder } = await seeded_pair();
  try {
    const view = ts_view(home_of(b), "device-project");
    assert.ok(view, "the project is served from the database");
    const got = dto_from_project_json(view.project, view.project.library ?? undefined);
    const want = dto_from_project_json(project_json(py_folder));
    assert.deepEqual(d02_canon(got), d02_canon(want));
    assert.notDeepEqual(got, want, "without d02_canon the empty executive_summary / conclusion / qa / review_log of the DB differ from 0.15's absent keys — that is what the canon removes");
    assert.equal(ts_view(home_of(b), "no-such-project"), undefined);
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

test("D02 canon: only EMPTY executive_summary / conclusion / qa / review_log are dropped — a value stays", () => {
  const dto = { executive_summary: "", conclusion: "결론", stages: { plan: { qa: [], review_log: [{ x: 1 }], summary: "" } } };
  assert.deepEqual(d02_canon(dto), { conclusion: "결론", stages: { plan: { review_log: [{ x: 1 }], summary: "" } } });
  assert.equal(d02_canon(null), null);
});

test("D03: answers read from the DB equal the 0.15 feedback files (multiset of stage/round/kind/text); a browser answer seeded later joins them", async () => {
  const { a, b } = await seeded_pair();
  try {
    const view = ts_view(home_of(b), "device-project");
    assert.ok(view);
    assert.deepEqual(answers_multiset(view.answers), answers_multiset([{ stage: "plan", round: 1, kind: "feedback", text: "합성 답" }, { stage: "plan", round: 1, kind: "feedback", text: "채팅 글" }]));
    assert.deepEqual(view.pending_texts, ["합성 답"], "the html answer is pending, the chat one was processed");
    ts_seed_feedback(b, "device-project", { stage: "plan", round: 1, kind: "feedback", text: "나중 답" });
    const later = ts_view(home_of(b), "device-project");
    assert.ok(later?.answers.some((x) => x.text === "나중 답"));
    assert.equal(later?.answers.length, 3);
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

test("D03 stdout: chat's answer line collapses to one token, pending's paths to their last segment; other commands are untouched", () => {
  assert.deepEqual(d03_stdout(["chat", "{P}", "plan", "글"], ["<PROJECT>/feedback/plan-R1-<TIME>.json"]), ["<답 기록됨>"]);
  assert.deepEqual(d03_stdout(["chat", "{P}", "plan", "글"], ["채팅 입력 기록: abc"]), ["<답 기록됨>"]);
  assert.deepEqual(d03_stdout(["pending", "{P}"], ["<PROJECT>/feedback/plan-R0-<TIME>.json", "plan-R1-<TIME>.json"]), ["plan-R0-<TIME>.json", "plan-R1-<TIME>.json"]);
  assert.deepEqual(d03_stdout(["mark", "{P}", "x.json"], ["처리 완료 표시 1개"]), ["처리 완료 표시 1개"]);
});

test("D04: the lock owner is read from the live lease (PES_OWNER label), `--force` hands it over, an expired lease is no lock", async () => {
  const { a, b } = await seeded_pair();
  try {
    const lock = (session: string, force = false) => {
      const run = run_ts_cli(b, [], { script: BRIDGE, input: JSON.stringify({ op: "lock", slug: "device-project", session, token: null, args: { force } }) });
      return JSON.parse(run.stdout.trim().split("\n").pop() as string) as { ok: boolean; exit?: number };
    };
    assert.equal(ts_view(home_of(b), "device-project")?.lock, null, "nobody holds it after the import");
    assert.equal(lock("alice-session").ok, true);
    assert.deepEqual(ts_view(home_of(b), "device-project")?.lock, { owner: "alice-session" });
    const refused = lock("bob-session");
    assert.deepEqual([refused.ok, refused.exit], [false, 3]);
    assert.deepEqual(ts_view(home_of(b), "device-project")?.lock, { owner: "alice-session" });
    assert.equal(lock("bob-session", true).ok, true);
    assert.deepEqual(ts_view(home_of(b), "device-project")?.lock, { owner: "bob-session" });
    ts_age_lease(home_of(b), "device-project", 7210);
    assert.equal(ts_view(home_of(b), "device-project")?.lock, null, "a lease older than its expiry is not a lock (the 0.15 .pes-lock TTL is 7200 s)");
    assert.equal(lock("alice-session").ok, true, "…and anybody can take it");
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

test("the cases carry the devices they need: D02 on every cli case that writes project.json, D03 on E07, D04 on E10, D10 on the cases with generated files, D11 where 0.15 crashes", () => {
  const table = [...load_table().cases, ...load_contract_table().cases];
  const diffs = (id: string): string[] => table.find((c) => c.id === id)?.diffs ?? [];
  for (const id of ["E01", "E02", "E03", "E04", "E05", "E06", "E07", "E10", "E11", "E12", "X05"]) assert.ok(diffs(id).includes("D02"), `${id} needs D02 (project.json is not written by ts)`);
  assert.ok(diffs("E07").includes("D03") && diffs("X05").includes("D03") && diffs("E10").includes("D04"));
  for (const id of ["E02", "E05", "E06", "E11"]) assert.ok(diffs(id).includes("D10"), `${id} needs D10`);
  for (const id of ["E02", "E03", "E12", "X02", "X03", "X06"]) assert.ok(diffs(id).includes("D11"), `${id} has a 0.15 traceback step`);
  // every traceback step of every baseline is covered by a case that lists D11 (nothing hides behind a missing difference)
  for (const def of table) {
    const rec = read_baseline(def.id);
    const crashes = (rec.steps as any[]).some((s) => Array.isArray(s.stderr) && s.stderr.some((l: string) => l.startsWith("traceback:")));
    assert.equal(crashes, def.diffs.includes("D11"), `${def.id}: D11 is listed exactly when the 0.15 baseline has a traceback step`);
  }
  const e10 = read_baseline("E10").steps.filter((s: any) => "exit" in s);
  assert.ok(e10.every((s: any) => "lock" in s), "E10 records the lock owner after every step (D04 device)");
  assert.ok((read_baseline("E07") as CaseRecord).answers?.length === 2 && (read_baseline("X05") as CaseRecord).answers?.length === 2, "E07 and its write half X05 record their answers (D03 device)");
});

test("D10 (W1·W2): the ts target is held to the posix baseline on EVERY OS — win32 os_overrides are not applied; a CR or a backslash path in the output fails", () => {
  for (const id of ["E05", "E11"]) {
    const posix = ts_baseline(id);
    assert.deepEqual(posix, read_baseline(id), `${id}: ts_baseline is the stored record as is`);
    assert.notDeepEqual(baseline_for(id, "win32"), posix, `${id}: the 0.15 win32 record differs (that is W1/W2) — ts must not be measured against it`);
    assert.deepEqual(baseline_for(id, "linux"), posix);
  }
  assert.ok(KNOWN_DIFFS.D10?.posix_storage === true && /LF/.test(KNOWN_DIFFS.D10.title) && /W1/.test(KNOWN_DIFFS.D10.title));
  const ctx = make_ctx("pes-posix-");
  try {
    const dir = join(ctx.tmp, "p");
    mkdirSync(join(dir, "reports", "plan"), { recursive: true });
    writeFileSync(join(dir, "reports", "plan", "report.md"), "한 줄\n둘째 줄\n", "utf8");
    writeFileSync(join(dir, "project.json"), JSON.stringify({ stages: { plan: { reports: [{ path: "reports/plan/report.md" }] } } }), "utf8");
    assert.doesNotThrow(() => assert_posix_storage(dir, "T"));
    writeFileSync(join(dir, "reports", "plan", "report.md"), "한 줄\r\n둘째 줄\r\n", "utf8");
    assert.throws(() => assert_posix_storage(dir, "T"), /has CR/);
    writeFileSync(join(dir, "reports", "plan", "report.md"), "한 줄\n", "utf8");
    writeFileSync(join(dir, "project.json"), JSON.stringify({ stages: { plan: { reports: [{ path: "reports\\plan\\report.md" }] } } }), "utf8");
    assert.throws(() => assert_posix_storage(dir, "T"), /backslash path/);
  } finally {
    ctx.cleanup();
  }
});

test("D11: a 0.15 traceback step passes with the same exit and a plain Korean one-liner; a stack trace, another exit, an English/empty message or another command fails", () => {
  const def = case_def("E03");
  const step = { step: ["merge", "{P}", "research", "{T}/없는 결과.json"], exit: 1, stdout: [], stderr: ["traceback: FileNotFoundError: [Errno 2] No such file or directory: 'x'"] };
  const ok = { ...step, stderr: ["결과 파일을 읽지 못했습니다: <TMP>/work/없는 결과.json"] };
  assert.doesNotThrow(() => compare_steps(def, [ok], [step]));
  assert.doesNotThrow(() => compare_steps(def, [{ ...ok, stdout: ["아무 글"] }], [step]), "stdout of a crashed step is not compared");
  for (const bad of [
    { ...ok, stderr: ["traceback: FileNotFoundError: x"] },
    { ...ok, stderr: ["Error: ENOENT: no such file", "    at Object.openSync (node:fs:573:18)"] },
    { ...ok, stderr: ["    at file:///x/pes.ts:1:1"] },
    { ...ok, exit: 2 },
    { ...ok, exit: 0 },
    { ...ok, stderr: [] },
    { ...ok, stderr: ["no such file"] },
    { ...ok, step: ["merge", "{P}", "plan", "x"] },
  ]) assert.throws(() => compare_steps(def, [bad], [step]), Error, JSON.stringify(bad));
  assert.ok(looks_like_stack_trace(["    at foo (node:internal/x:1:1)"]) && !looks_like_stack_trace(["파일 없음"]));
  // a step without a traceback stays exact, D11 or not
  const plain = { step: ["status", "{P}"], exit: 0, stdout: ["a"], stderr: [] };
  assert.throws(() => compare_steps(def, [{ ...plain, stdout: ["b"] }], [plain]));
  // a case without D11 never relaxes
  assert.throws(() => compare_steps(case_def("E05"), [ok], [step]));
  // E12 `status {T}/large` may be FIXED (exit 0, no stack trace) — no other traceback step may
  const e12 = case_def("E12");
  const large = { step: ["status", "{T}/large"], exit: 1, stdout: ["주제: 합성 주제  (<PROJECT>)"], stderr: ["traceback: KeyError: 'current'"] };
  assert.doesNotThrow(() => compare_steps(e12, [{ ...large, exit: 0, stderr: [] }], [large]));
  assert.throws(() => compare_steps(e12, [{ step: ["merge", "{P}", "research", "{T}/없는 결과.json"], exit: 0, stdout: [], stderr: [] }], [step]), Error, "only the listed step may succeed");
  assert.throws(() => compare_steps(e12, [{ ...large, exit: 0, stderr: ["    at x (node:internal/y:1:1)"] }], [large]));
});

test("the case ratchet is per case: after SEL-77 no case is not_yet (every case runs on ts); the reason text of the ratchet still says a not_yet case is never run", () => {
  assert.deepEqual(not_yet_ids(), [], "SEL-77 (E05~E07, E11, E12, E15 + X06, X07) turned the last not_yet cases on");
  assert.match(load_table().ts_not_yet_reason, /실행하지 않는다/);
  assert.match(load_contract_table().ts_not_yet_reason, /SEL-77/);
  assert.equal(basename(join("a", "b")), "b");
});
