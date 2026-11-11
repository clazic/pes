// SEL-74 C (3/3) — what the user SEES for a not-migrated 0.15 folder:
//   doctor  → a row "이전 필요" (guidance only, never fixable, never `bad`), gone after `pes migrate`; `doctor --fix` does not migrate
//   status · hub (the dashboard list) → the old folder is shown as it was
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { use_home_guard } from "./helpers/home_guard.ts";
import { serve_fixture } from "./helpers/serve_ts_env.ts";
import { bytes_digest, legacy_folder, mtime_map, pes_ts, with_ctx } from "./helpers/sel74_env.ts";

use_home_guard();

type Row = { group: string; level: string; title: string; detail: string; fixable: boolean };
const DOCTOR = { narrow_path: true, allow_child_process: true } as const;

function rows(ctx: Parameters<typeof pes_ts>[0], extra: string[] = []): { status: number | null; rows: Row[] } {
  const run = pes_ts(ctx, ["doctor", ...extra, "--json"], { ...DOCTOR, extra_read: [ctx.narrow_bin] });
  assert.ok(run.status === 0 || run.status === 1, run.stderr);
  return { status: run.status, rows: (JSON.parse(run.stdout) as Row[]).filter((r) => r.group !== "도구") };
}

test("C16: doctor shows ONE 이전 필요 row for a not-migrated folder — guidance (names `pes migrate`), not fixable, not bad", { timeout: 300_000 }, async () => {
  await with_ctx("pes-sel74-c16-", (ctx) => {
    legacy_folder(ctx, "old-one");
    const out = rows(ctx);
    const found = out.rows.filter((r) => /이전 필요/.test(r.title));
    assert.equal(found.length, 1, `one 이전 필요 row (rows: ${JSON.stringify(out.rows.map((r) => r.title))})`);
    const row = found[0] as Row;
    assert.equal(row.group, "old-one", "grouped under the folder's name");
    assert.ok(row.level === "warn" || row.level === "info", `guidance, not a defect (level ${row.level})`);
    assert.equal(row.fixable, false, "doctor --fix never migrates — only the user does");
    assert.match(row.detail, /pes migrate/);
  });
});

test("C17: `doctor --fix` leaves a not-migrated folder alone (no migrate, no write, mtimes unchanged); `doctor <folder>` shows the same row", { timeout: 300_000 }, async () => {
  await with_ctx("pes-sel74-c17-", (ctx) => {
    const dir = legacy_folder(ctx, "old-one");
    const bytes = bytes_digest(dir);
    const times = mtime_map(dir);
    const fixed = pes_ts(ctx, ["doctor", "--fix"], { ...DOCTOR, extra_read: [ctx.narrow_bin] });
    assert.ok(fixed.status === 0 || fixed.status === 1, fixed.stderr);
    assert.equal(bytes_digest(dir), bytes);
    assert.deepEqual(mtime_map(dir), times);
    const one = rows(ctx, ["old-one"]);
    assert.equal(one.rows.filter((r) => /이전 필요/.test(r.title)).length, 1);
  });
});

test("C18: after `pes migrate` the 이전 필요 row is gone", { timeout: 300_000 }, async () => {
  await with_ctx("pes-sel74-c18-", (ctx) => {
    legacy_folder(ctx, "old-one");
    assert.equal(pes_ts(ctx, ["migrate", "old-one"]).status, 0);
    assert.equal(rows(ctx).rows.filter((r) => /이전 필요/.test(r.title)).length, 0);
  });
});

test("C19: a broken project.json is still `bad` (읽기 실패) — not an 이전 필요 row", { timeout: 300_000 }, async () => {
  await with_ctx("pes-sel74-c19-", (ctx) => {
    legacy_folder(ctx, "broken-one", "complete");
    writeFileSync(join(ctx.pes_home, "broken-one", "project.json"), '{"pes": 1, "stages":', "utf8");
    const out = rows(ctx);
    assert.ok(out.rows.some((r) => r.group === "broken-one" && r.level === "bad"));
    assert.equal(out.rows.filter((r) => r.group === "broken-one" && /이전 필요/.test(r.title)).length, 0);
  });
});

test("C20: the server serves the not-migrated folder's own dashboard page (index.html) as it was — and its answer box (POST /feedback) is refused, not silently written to project.json (D02)", { timeout: 300_000 }, async () => {
  const fx = await serve_fixture("pes-sel74-c20-", { legacy_only: ["old-one"] });
  try {
    const page = await fetch(`${fx.server.origin()}/old-one/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /old-one/);
    const post = await fetch(`${fx.server.origin()}/old-one/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: fx.server.origin() },
      body: JSON.stringify({ stage: "plan", round: 1, kind: "feedback", text: "답" }),
    });
    assert.equal(post.status, 404, "not in the database: 404 (the old folder is read-only)");
  } finally {
    await fx.cleanup();
  }
});
