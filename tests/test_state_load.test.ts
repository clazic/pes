// load() of scripts/pes.py: tests/test_project_basic.py (test_load_fills_legacy_fields, test_load_broken_json,
// test_large_project_load_save) → TS (SEL-70, PR26a; table 8: test_state_load).
//
// pytest called pes.load()/pes.save() in process. The CLI form of the same contract: a command that loads and saves (`note`) shows
// what load() filled and what save() wrote; `status`/`show` show what load() returned; a broken file ends with the Python error.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";

import { STAGES, make_ctx, pes, project_json, synthetic_project } from "./helpers/compat_env.ts";
import { use_home_guard } from "./helpers/home_guard.ts";

use_home_guard();

const ctx = make_ctx("pes-state-load-");
after(() => ctx.cleanup());

test("load() fills the fields a hand-written legacy project lacks (seen through a load → save round trip)", () => {
  const project = synthetic_project(ctx, "legacy");
  const note = pes(ctx, "note", project, "합성 메모");
  assert.equal(note.code, 0, note.out + note.err);
  const data = project_json(project);
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
  assert.equal(item.id, 1);
  assert.equal(item.title, "합성 항목");
  assert.equal(item.status, "new");
  assert.deepEqual(item.sources, []);
  assert.deepEqual(item.links, {});
});

test("show reads the loaded (default-filled) item without writing project.json", () => {
  const project = synthetic_project(ctx, "legacy");
  const before = readFileSync(join(project, "project.json"));
  const run = pes(ctx, "show", project, "plan", "1");
  assert.equal(run.code, 0, run.out + run.err);
  const items = JSON.parse(run.out);
  assert.equal(items.length, 1);
  assert.equal(items[0].status, "new");
  assert.deepEqual(items[0].sources, []);
  assert.deepEqual(items[0].links, {});
  assert.deepEqual(readFileSync(join(project, "project.json")), before, "a read command must not write");
});

test("load() of a broken project.json ends with JSONDecodeError and leaves the file byte-for-byte alone", () => {
  const project = synthetic_project(ctx, "broken");
  const before = readFileSync(join(project, "project.json"));
  const run = pes(ctx, "status", project);
  assert.equal(run.code, 1);
  assert.equal(run.out, "");
  assert.match(run.err, /JSONDecodeError/);
  assert.deepEqual(readFileSync(join(project, "project.json")), before);
});

test("a 2 MB project loads and saves without losing the payload (load / save time is reported, not asserted)", (t) => {
  const project = synthetic_project(ctx, "large");
  const size = readFileSync(join(project, "project.json")).length;
  assert.ok(size >= 2 * 1024 * 1024 && size < 3 * 1024 * 1024, `fixture size ${size}`);
  const start = performance.now();
  const run = pes(ctx, "note", project, "큰 프로젝트 메모");
  const elapsed = performance.now() - start;
  t.diagnostic(`synthetic 2MB project: load + save + process start ${elapsed.toFixed(0)} ms`);
  assert.equal(run.code, 0, run.out + run.err);
  const data = project_json(project);
  assert.equal(data.synthetic_payload, "x".repeat(2 * 1024 * 1024));
  assert.equal(data.notes.length, 1);
});
