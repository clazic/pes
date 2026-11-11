/**
 * SEL-71 first review (r1), the CLI half (children run guarded in an isolated HOME / PES_HOME; nothing real is touched):
 *   E. recommendation 5  two projects with the same folder name in different folders are one slug in the database; `set` locks are per
 *                        folder, so two `set` of the same field at once must neither duplicate the field's object nor lose a later `set`.
 *   F. recommendation 6  `init` whose folder cannot be created leaves no project in the database, and the same name can be initialised again.
 *   G. recommendation 9  an unreadable value file answers the same one line for Windows' EPERM as for EACCES (`[Errno 13] Permission denied`).
 * Windows: paths are compared through the one path string the test passed in (no `which`, no shell, LF-normalised).
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { connect_read_only } from "../scripts/pes_core/db.ts";
import { db_path } from "../scripts/pes_core/paths.ts";
import { make_ctx, type CompatCtx } from "./helpers/compat_env.ts";
import { PES_TS_FILE, run_ts_cli, run_ts_cli_async, ts_view } from "./helpers/compat_ts.ts";
import { use_home_guard } from "./helpers/home_guard.ts";

use_home_guard();

const lf = (text: string): string => text.replace(/\r\n/g, "\n");
const STACK = /^\s+at .+[(:]|node:internal|ERR_[A-Z_]+|Traceback|file:\/\//m;

function home_of(ctx: CompatCtx) {
  return { env: ctx.env, pes_home: ctx.pes_home, home_dir: ctx.home_dir };
}

function value_file(ctx: CompatCtx, name: string, text: string): string {
  const file = join(ctx.tmp, name);
  writeFileSync(file, text, "utf8");
  return file;
}

// ---------------------------------------------------------------------------------------------------- E

/** How many review objects hold the one field `role`/`field` of `stage_key` (null = project) — one is right, two is the lost-update bug. */
function field_objects(ctx: CompatCtx, slug: string, role: string, field: string, stage_key: string | null): number {
  const db = connect_read_only(db_path(ctx.env));
  try {
    const row = db.get<{ n: bigint }>(
      `SELECT COUNT(*) AS n
         FROM objects o
         JOIN artifacts a ON a.project_id = o.project_id AND a.object_id = o.id
         JOIN artifact_versions v ON v.project_id = o.project_id AND v.version_id = o.current_version_id
         JOIN projects p ON p.id = o.project_id
         LEFT JOIN stages s ON s.project_id = a.project_id AND s.id = a.stage_id
        WHERE p.slug = ? AND o.kind = 'artifact' AND a.kind = 'review'
          AND json_extract(v.metadata_json, '$.role') = ? AND json_extract(v.metadata_json, '$.field') = ?
          AND ((? IS NULL AND a.stage_id IS NULL) OR s.key = ?)`,
      slug,
      role,
      field,
      stage_key,
      stage_key,
    );
    return Number(row?.n ?? 0n);
  } finally {
    db.close();
  }
}

test("E. two `set` of the same field from two folders with the same name (one slug, two lock files) at once: both succeed, the field stays ONE object, and a later `set` is not lost", { timeout: 300_000 }, async () => {
  assert.ok(existsSync(PES_TS_FILE), "scripts/pes.ts does not exist yet — SEL-71 writes it");
  const ctx = make_ctx("pes-ts-r1-set-");
  try {
    const a = join(ctx.pes_home, "ga", "same-name");
    const b = join(ctx.pes_home, "gb", "same-name");
    const init = run_ts_cli(ctx, ["init", a, "--topic", "합성 주제"]);
    assert.equal(init.status, 0, init.stderr);
    mkdirSync(b, { recursive: true }); // the second folder of the same name: the database knows the slug, not the folder
    const targets: Array<[string | null, string]> = [
      ["plan", "summary"], ["research", "summary"], ["analyze", "summary"], ["write", "summary"], ["verify", "summary"], ["publish", "summary"], [null, "executive_summary"],
    ];
    for (const [stage, field] of targets) {
      const target = stage ?? "project";
      const first = value_file(ctx, `first-${target}-${field}.txt`, `첫째 ${target}`);
      const second = value_file(ctx, `second-${target}-${field}.txt`, `둘째 ${target}`);
      const [r1, r2] = await Promise.all([run_ts_cli_async(ctx, ["set", a, target, field, first], { timeout_ms: 120_000 }), run_ts_cli_async(ctx, ["set", b, target, field, second], { timeout_ms: 120_000 })]);
      for (const r of [r1, r2]) assert.equal(r.status, 0, `${target}.${field}: set must succeed\n${r.stderr}${r.stdout}`);
      const role = stage === null ? "project_field" : "stage_field";
      assert.equal(field_objects(ctx, "same-name", role, field, stage), 1, `${target}.${field}: the field is ONE object, however the two writers interleaved`);
      // a later, ordinary `set` must be what the project shows (a duplicate object made the read model keep the older one)
      const last = value_file(ctx, `last-${target}-${field}.txt`, `마지막 ${target}`);
      const done = run_ts_cli(ctx, ["set", a, target, field, last]);
      assert.equal(done.status, 0, done.stderr);
      const project = ts_view(home_of(ctx), "same-name")?.project as any;
      const shown = stage === null ? project[field] : project.stages[stage][field];
      assert.equal(shown, `마지막 ${target}`, `${target}.${field}: the last set is the value shown`);
      assert.equal(field_objects(ctx, "same-name", role, field, stage), 1, `${target}.${field}: still one object`);
    }
  } finally {
    ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------------- F

test("F. init whose folder cannot be created leaves no project in the database; the same name can be initialised again", () => {
  assert.ok(existsSync(PES_TS_FILE), "scripts/pes.ts does not exist yet — SEL-71 writes it");
  const ctx = make_ctx("pes-ts-r1-init-");
  try {
    // a regular file where a parent folder must be: the folder of `blocked/same-name` can never be made (on every OS)
    const blocker = join(ctx.pes_home, "blocked");
    mkdirSync(ctx.pes_home, { recursive: true });
    writeFileSync(blocker, "파일이다", "utf8");
    const failed = run_ts_cli(ctx, ["init", join(blocker, "same-name"), "--topic", "합성 주제"]);
    assert.notEqual(failed.status, 0, "init must fail when its folder cannot be made");
    assert.doesNotMatch(lf(failed.stderr), STACK, `a plain error line, no stack trace:\n${failed.stderr}`);
    assert.match(lf(failed.stderr), /[가-힣]/, "a Korean error line");
    assert.equal(ts_view(home_of(ctx), "same-name"), undefined, "the database must not keep a project whose folder was never made");

    const folder = join(ctx.pes_home, "ok", "same-name");
    const again = run_ts_cli(ctx, ["init", folder, "--topic", "합성 주제"]);
    assert.equal(again.status, 0, `the same name initialises again:\n${again.stderr}${again.stdout}`);
    assert.doesNotMatch(lf(again.stderr), /이미 프로젝트가 있습니다/);
    assert.ok(existsSync(folder), "the folder exists now");
    assert.equal(ts_view(home_of(ctx), "same-name")?.project.topic, "합성 주제");
  } finally {
    ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------------- G

test("G. an unreadable value file: Windows' EPERM answers the same one line as EACCES — `[Errno 13] Permission denied` — exit 2, nothing written", () => {
  assert.ok(existsSync(PES_TS_FILE), "scripts/pes.ts does not exist yet — SEL-71 writes it");
  const ctx = make_ctx("pes-ts-r1-eperm-");
  try {
    const folder = join(ctx.pes_home, "perm-synth");
    assert.equal(run_ts_cli(ctx, ["init", folder, "--topic", "합성 주제"]).status, 0);
    const file = value_file(ctx, "읽을수없는-값.txt", "합성 값");
    const lines: Record<string, string[]> = {};
    for (const code of ["EACCES", "EPERM"] as const) {
      const run = run_ts_cli(ctx, ["set", folder, "project", "executive_summary", file], { imports: [join(import.meta.dirname, "helpers", "ts_inject_read.ts")], env: { SEL71_READ_FAIL: JSON.stringify({ name: "읽을수없는-값.txt", code }) } });
      assert.equal(run.status, 2, `${code}: exit 2\n${run.stderr}`);
      assert.equal(run.stdout, "", `${code}: nothing on stdout`);
      lines[code] = lf(run.stderr).split("\n").filter((x) => x !== "").map((x) => x.split(file).join("<F>"));
    }
    const want = ["set: 값을 읽지 못했습니다 (<F>): [Errno 13] Permission denied: '<F>'"];
    assert.deepEqual(lines.EACCES, want);
    assert.deepEqual(lines.EPERM, want, "EPERM is the same line as EACCES");
    assert.equal((ts_view(home_of(ctx), "perm-synth")?.project as any).executive_summary ?? "", "", "nothing was written");
  } finally {
    ctx.cleanup();
  }
});
