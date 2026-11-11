// tests/test_state.py (restore copy, broken / large project.json) → TS (SEL-70, PR26a; table 8: test_restore_compat).
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";

import { copy_dir, init_project, make_ctx, merge, pes, project_json, synthetic_project } from "./helpers/compat_env.ts";
import { unique_name } from "./helpers/compat_state.ts";
import { use_home_guard } from "./helpers/home_guard.ts";

use_home_guard();

const ctx = make_ctx("pes-restore-");
after(() => ctx.cleanup());

test("a copied project folder reloads, and render / report / assemble / web regenerate their outputs", () => {
  const project = init_project(ctx, unique_name(), "합성 주제");
  pes(ctx, "round-start", project, "plan");
  merge(ctx, project, "plan", [{ id: 1, kind: "rq", title: "복원 질문", summary: "복원 요약", sources: [{ url: "https://example.test/restore", title: "복원 출처" }] }]);
  pes(ctx, "round-start", project, "write");
  merge(ctx, project, "write", [{ id: 1, kind: "section", title: "복원 장", details: "복원 본문.[^1]", sources: [{ url: "https://example.test/restore", title: "복원 출처" }] }]);

  const restored = join(ctx.tmp, "복원 위치", "사본 프로젝트");
  copy_dir(project, restored);
  rmSync(project, { recursive: true, force: true });
  assert.ok(!existsSync(project));
  assert.ok(existsSync(join(restored, "project.json")));

  const status = pes(ctx, "status", restored);
  assert.equal(status.code, 0, status.out + status.err);
  assert.ok(status.out.includes("합성 주제"));
  assert.ok(status.out.includes("현재 단계: 집필"));

  const render = pes(ctx, "render", restored);
  assert.equal(render.code, 0, render.out + render.err);
  assert.ok(existsSync(join(restored, "index.html")));
  assert.ok(readFileSync(join(restored, "index.html"), "utf8").includes("합성 주제"));

  const report = pes(ctx, "report", restored, "plan");
  assert.equal(report.code, 0, report.out + report.err);
  assert.ok(readFileSync(join(restored, "reports", "plan", "report.md"), "utf8").includes("복원 요약"));

  const assemble = pes(ctx, "assemble", restored);
  assert.equal(assemble.code, 0, assemble.out + assemble.err);
  assert.ok(readFileSync(join(restored, "out", "report.md"), "utf8").includes("복원 본문."));

  const web = pes(ctx, "web", restored);
  assert.equal(web.code, 0, web.out + web.err);
  assert.ok(existsSync(join(restored, "out", "report.html")));
});

test("a broken project.json keeps the current error behaviour: exit 1, empty stdout, JSONDecodeError, file untouched", () => {
  const project = synthetic_project(ctx, "broken");
  const before = readFileSync(join(project, "project.json"));
  const run = pes(ctx, "status", project);
  assert.equal(run.code, 1);
  assert.equal(run.out, "");
  assert.match(run.err, /JSONDecodeError/);
  assert.deepEqual(readFileSync(join(project, "project.json")), before);
});

test("a 2 MB project.json reads and updates; status of the fixture without `current` ends with KeyError until round-start fills it", () => {
  const project = synthetic_project(ctx, "large");
  // The fixture has no top-level "current", so status ends with a KeyError (0.15 behaviour, pinned).
  const first = pes(ctx, "status", project);
  assert.equal(first.code, 1);
  assert.ok(first.out.includes("합성 주제"));
  assert.match(first.err, /KeyError/);
  assert.ok(first.err.includes("'current'"));

  // round-start fills `current` after load, so the big file is read and saved.
  const run = pes(ctx, "round-start", project, "plan");
  assert.equal(run.code, 0, run.out + run.err);
  const data = project_json(project);
  assert.equal(data.synthetic_payload, "x".repeat(2 * 1024 * 1024));
  assert.equal(data.stages.plan.round, 1);
  assert.equal(data.current, "plan");

  const again = pes(ctx, "status", project);
  assert.equal(again.code, 0, again.out + again.err);
  assert.ok(again.out.includes("현재 단계: 기획"));
});
