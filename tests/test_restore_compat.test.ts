// tests/test_state.py (restore copy, broken / large project.json) → TS (SEL-70, PR26a; table 8: test_restore_compat).
// SEL-74: the TS CLI. A project folder put into a PES home from somewhere else (a restored copy) is an OLD folder for pes.ts until it is moved
// into the database (D14: read-only → `pes migrate` → everything regenerates). The backup bundles that restore DB projects are
// test_sel74_c_migrate C8 / test_migration_restore.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";

import { make_ctx, pes, project_state, synthetic_project } from "./helpers/compat_env.ts";
import { use_home_guard } from "./helpers/home_guard.ts";
import { assert_one_line_error, bytes_digest, legacy_folder } from "./helpers/sel74_env.ts";

use_home_guard();

const ctx = make_ctx("pes-restore-");
after(() => ctx.cleanup());

test("a restored (copied-in) project folder reads as it is, and after `pes migrate` render / report / assemble / web regenerate their outputs", () => {
  const restored = legacy_folder(ctx, "복원 사본 프로젝트", "full");
  const before = bytes_digest(restored);

  const status = pes(ctx, "status", restored);
  assert.equal(status.code, 0, status.out + status.err);
  assert.ok(status.out.includes("합성 도서관 운영 연구"));
  assert.equal(bytes_digest(restored), before, "reading the old folder writes nothing");

  const refused = pes(ctx, "render", restored);
  assert.equal(refused.code, 1, "a generating command on the old folder is refused (D14) …");
  assert.match(refused.err, /migrate/);

  const migrate = pes(ctx, "migrate", "복원 사본 프로젝트");
  assert.equal(migrate.code, 0, migrate.out + migrate.err); // … until it is moved into the database
  assert.equal(bytes_digest(restored), before, "migrate only reads the folder");

  const after_status = pes(ctx, "status", restored);
  assert.equal(after_status.code, 0, after_status.out + after_status.err);
  assert.ok(after_status.out.includes("합성 도서관 운영 연구"));

  const render = pes(ctx, "render", restored);
  assert.equal(render.code, 0, render.out + render.err);
  assert.ok(existsSync(join(restored, "index.html")));
  assert.ok(readFileSync(join(restored, "index.html"), "utf8").includes("합성 도서관 운영 연구"));

  const report = pes(ctx, "report", restored, "plan");
  assert.equal(report.code, 0, report.out + report.err);
  assert.ok(existsSync(join(restored, "reports", "plan", "report.md")));

  const assemble = pes(ctx, "assemble", restored);
  assert.equal(assemble.code, 0, assemble.out + assemble.err);
  assert.ok(existsSync(join(restored, "out", "report.md")));

  const web = pes(ctx, "web", restored);
  assert.equal(web.code, 0, web.out + web.err);
  assert.ok(existsSync(join(restored, "out", "report.html")));
});

test("a broken project.json: exit 1, empty stdout, ONE Korean line (no stack trace — D11, 0.15 printed a JSONDecodeError traceback), file untouched", () => {
  const project = synthetic_project(ctx, "broken");
  const before = readFileSync(join(project, "project.json"));
  const run = pes(ctx, "status", project);
  assert.equal(run.code, 1);
  assert.equal(run.out, "");
  assert_one_line_error({ ...run, status: run.code, signal: null, stdout: run.out, stderr: run.err, hub_attempts: [] }, "status of a broken project.json");
  assert.deepEqual(readFileSync(join(project, "project.json")), before);
});

test("a 2 MB project.json: status of the fixture without `current` ends with ONE Korean line (D11 — 0.15: KeyError traceback); once migrated, round-start fills `current` and the 2 MB file in the folder stays as it was", async () => {
  const project = synthetic_project(ctx, "large");
  const before = bytes_digest(project);
  const first = pes(ctx, "status", project);
  assert.equal(first.code, 1);
  assert_one_line_error({ ...first, status: first.code, signal: null, stdout: first.out, stderr: first.err, hub_attempts: [] }, "status without current");
  assert.match(first.err, /current/, "names the missing `current`");

  const { ts_seed_legacy } = await import("./helpers/compat_ts.ts");
  await ts_seed_legacy({ env: ctx.env, pes_home: ctx.pes_home, home_dir: ctx.home_dir }, project);
  const run = pes(ctx, "round-start", project, "plan");
  assert.equal(run.code, 0, run.out + run.err);
  const data = project_state(ctx, project);
  assert.equal(data.stages.plan.round, 1);
  assert.equal(data.current, "plan");
  assert.equal(bytes_digest(project), before, "the 2 MB payload of the old project.json is untouched");

  const again = pes(ctx, "status", project);
  assert.equal(again.code, 0, again.out + again.err);
  assert.ok(again.out.includes("현재 단계: 기획"));
});
