// SEL-74 C (1/3) — a 0.15 folder that was not moved to the new format is READ-ONLY for pes.ts (D14). A write command refuses with ONE Korean
// line that tells the way out: "먼저 이전하세요 — pes migrate <폴더>". Nothing is written, not even an mtime; the read commands keep showing the
// old folder. Written before the code: the refusal exists today (SEL-77) but names no `migrate`.
import assert from "node:assert/strict";
import { test } from "node:test";

import { use_home_guard } from "./helpers/home_guard.ts";
import { assert_one_line_error, bytes_digest, legacy_folder, mtime_map, pes_ts, with_ctx } from "./helpers/sel74_env.ts";

use_home_guard();

const SLUG = "old-folder";

// every command that would WRITE the project (project.json or the generated files) — each one needs a valid-looking argument list so the
// refusal, not an argument error, is what answers
const WRITES: string[][] = [
  ["round-start", SLUG, "plan"],
  ["merge", SLUG, "plan", "result.json"],
  ["render", SLUG],
  ["approve", SLUG, "plan"],
  ["reopen", SLUG, "plan"],
  ["mark", SLUG, "feedback/plan-R1-20260101-000000.json"],
  ["chat", SLUG, "plan", "지시"],
  ["note", SLUG, "메모"],
  ["set", SLUG, "plan", "summary", "-"],
  ["qa-brief", SLUG, "plan"],
  ["qa", SLUG, "plan"],
  ["ask-prep", SLUG, "plan"],
  ["report", SLUG, "plan"],
  ["assemble", SLUG],
  ["web", SLUG],
];

test("C1: every write command on a not-migrated folder → exit 1, stdout empty, ONE Korean line naming `pes migrate`, folder bytes AND mtimes unchanged", { timeout: 600_000 }, async () => {
  await with_ctx("pes-sel74-c1-", (ctx) => {
    const dir = legacy_folder(ctx, SLUG);
    const bytes = bytes_digest(dir);
    const times = mtime_map(dir);
    for (const args of WRITES) {
      const run = pes_ts(ctx, args, { input: args[0] === "set" ? "내용" : undefined });
      assert.equal(run.status, 1, `${args[0]}: exit 1 (got ${run.status}: ${run.stderr})`);
      assert.equal(run.stdout, "", `${args[0]}: nothing on stdout`);
      assert_one_line_error(run, args[0] as string);
      assert.match(run.stderr, /먼저 이전하세요 — pes migrate /, `${args[0]}: the way out is named (${run.stderr.trim()})`);
    }
    assert.equal(bytes_digest(dir), bytes, "no file changed");
    assert.deepEqual(mtime_map(dir), times, "no file was even touched");
    assert.equal(pes_ts(ctx, ["list"]).status, 0);
  });
});

test("C2: the refusal text is the same line for a folder given as a path inside the PES home and as a bare name", { timeout: 240_000 }, async () => {
  await with_ctx("pes-sel74-c2-", (ctx) => {
    const dir = legacy_folder(ctx, SLUG);
    const by_name = pes_ts(ctx, ["note", SLUG, "메모"]);
    const by_path = pes_ts(ctx, ["note", dir, "메모"]);
    assert.equal(by_name.status, 1);
    assert.equal(by_path.status, 1);
    assert.match(by_name.stderr, /pes migrate/);
    assert.match(by_path.stderr, /pes migrate/);
  });
});

test("C3: the read commands keep showing the old folder as 0.15 did — status · digest · show · pending end with exit 0 and change nothing (D14)", { timeout: 240_000 }, async () => {
  await with_ctx("pes-sel74-c3-", (ctx) => {
    const dir = legacy_folder(ctx, SLUG);
    const bytes = bytes_digest(dir);
    const times = mtime_map(dir);
    const status = pes_ts(ctx, ["status", SLUG]);
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /합성 완료 프로젝트/, "the topic of the old project.json is shown");
    for (const args of [["digest", SLUG, "plan"], ["show", SLUG, "plan"], ["pending", SLUG]]) {
      const run = pes_ts(ctx, args);
      assert.equal(run.status, 0, `${args[0]}: ${run.stderr}`);
    }
    assert.equal(bytes_digest(dir), bytes);
    assert.deepEqual(mtime_map(dir), times);
  });
});

test("C4: `list` still shows a not-migrated folder (with its topic) — the user can see what is waiting", { timeout: 240_000 }, async () => {
  await with_ctx("pes-sel74-c4-", (ctx) => {
    legacy_folder(ctx, SLUG);
    const run = pes_ts(ctx, ["list"]);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, new RegExp(SLUG));
  });
});

test("C5: the usage page of pes.ts lists `migrate <dir>` and `migrate --all`", async () => {
  const { USAGE } = await import("../scripts/pes_core/cli_usage.ts");
  assert.match(USAGE, /\n\s+migrate <dir>/);
  assert.match(USAGE, /migrate --all/);
  const { CMDS } = await import("../scripts/pes_core/cli_main.ts");
  assert.ok(CMDS.includes("migrate"), "migrate is in the command table");
});
