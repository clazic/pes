// load() of 0.15 (scripts/pes.py): tests/test_project_basic.py (test_load_fills_legacy_fields, test_load_broken_json,
// test_large_project_load_save) → TS (SEL-70, PR26a; table 8: test_state_load). SEL-74: the same contracts on the TS CLI.
//
// 0.15 called pes.load()/pes.save() on project.json. The TS CLI never writes project.json (D02) — an old folder is read-only (D14) until
// `pes migrate` / the importer puts it into the database, and the defaults load() filled are filled by the importer. So: a hand-written legacy
// folder is moved into the database (ts_seed_legacy) and a command that writes (`note`) shows what was filled (project_state); `show` / `status`
// read the old folder directly and must not write; a broken file ends with ONE Korean line (D11 — 0.15 died with a JSONDecodeError traceback).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";

import { STAGES, make_ctx, pes, project_state, synthetic_project } from "./helpers/compat_env.ts";
import { ts_seed_legacy } from "./helpers/compat_ts.ts";
import { use_home_guard } from "./helpers/home_guard.ts";
import { assert_one_line_error, bytes_digest, mtime_map } from "./helpers/sel74_env.ts";

use_home_guard();

const ctx = make_ctx("pes-state-load-");
after(() => ctx.cleanup());
const home = () => ({ env: ctx.env, pes_home: ctx.pes_home, home_dir: ctx.home_dir });

test("a hand-written legacy project gets the fields it lacks filled (seen through import → a writing command)", async () => {
  const project = synthetic_project(ctx, "legacy");
  await ts_seed_legacy(home(), project);
  const note = pes(ctx, "note", project, "합성 메모");
  assert.equal(note.code, 0, note.out + note.err);
  const data = project_state(ctx, project);
  assert.deepEqual(Object.keys(data.stages).sort(), [...STAGES].sort());
  assert.deepEqual(data.processed, []);
  assert.equal(data.notes.length, 1);
  assert.equal(data.notes[0].text, "합성 메모");
  const plan = data.stages.plan;
  assert.equal(plan.status, "pending");
  assert.equal(plan.round, 0);
  assert.deepEqual(plan.settings, {});
  assert.deepEqual(plan.reports, []);
  const item = plan.items[0];
  assert.equal(item.title, "합성 항목");
  assert.equal(item.status, "new");
  assert.deepEqual(item.sources, []);
  assert.deepEqual(item.links, {});
});

test("show reads the old folder's default-filled item without writing anything", () => {
  const project = synthetic_project(ctx, "legacy");
  const bytes = bytes_digest(project);
  const times = mtime_map(project);
  const run = pes(ctx, "show", project, "plan", "1");
  assert.equal(run.code, 0, run.out + run.err);
  const items = JSON.parse(run.out);
  assert.equal(items.length, 1);
  assert.equal(items[0].status, "new");
  assert.deepEqual(items[0].sources, []);
  assert.deepEqual(items[0].links, {});
  assert.equal(bytes_digest(project), bytes, "a read command must not write");
  assert.deepEqual(mtime_map(project), times, "not even an mtime");
});

test("a broken project.json ends with exit 1, nothing on stdout and ONE Korean line (no stack trace), and the file is left byte-for-byte alone (D11: 0.15 ended with a JSONDecodeError traceback)", () => {
  const project = synthetic_project(ctx, "broken");
  const before = readFileSync(join(project, "project.json"));
  const run = pes(ctx, "status", project);
  assert.equal(run.code, 1);
  assert.equal(run.out, "");
  assert_one_line_error({ ...run, status: run.code, signal: null, stdout: run.out, stderr: run.err, hub_attempts: [] }, "status of a broken project.json");
  assert.deepEqual(readFileSync(join(project, "project.json")), before);
});

test("a 2 MB project moves into the database and takes a write without any change to the old folder (its payload stays in project.json byte for byte); the time is reported, not asserted", async (t) => {
  const project = synthetic_project(ctx, "large");
  const size = readFileSync(join(project, "project.json")).length;
  assert.ok(size >= 2 * 1024 * 1024 && size < 3 * 1024 * 1024, `fixture size ${size}`);
  const before = bytes_digest(project);
  const start = performance.now();
  await ts_seed_legacy(home(), project);
  const run = pes(ctx, "note", project, "큰 프로젝트 메모");
  const elapsed = performance.now() - start;
  t.diagnostic(`synthetic 2MB project: import + validate + activate + note + process start ${elapsed.toFixed(0)} ms`);
  assert.equal(run.code, 0, run.out + run.err);
  assert.equal(project_state(ctx, project).notes.length, 1);
  assert.equal(bytes_digest(project), before, "the 2 MB payload in the old project.json is untouched");
});
