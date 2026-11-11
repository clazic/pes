// tests/test_lock.py → TS (SEL-70, PR26a; table 8: test_lock_compat). The lock of the CLI: owner, expiry, hand-over, driven through the real
// CLI. PES_OWNER is the session id. SEL-74: the 0.15 `.pes-lock` file is a lease in the database now (D04), so "who holds it" and "how old"
// are read from there (ts_view / project_leases) and the clock is played by ts_age_lease — the same sequences as the 0.15 pytest file.
//
// The 0.15 test of `lock_info()` with a frozen Python clock (live up to TTL-1 s, expired at TTL) has no frozen clock any more: the TTL is
// pinned from the lease row (expires - heartbeat = 2 hours) and the edge is checked 30 s each side of it with the lease aged by the harness.
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { init_project, make_ctx, pes, pes_as, project_state } from "./helpers/compat_env.ts";
import { ts_age_lease, ts_view } from "./helpers/compat_ts.ts";
import { use_home_guard } from "./helpers/home_guard.ts";
import { db_rows } from "./helpers/sel74_env.ts";

use_home_guard();

const ctx = make_ctx("pes-lock-");
after(() => ctx.cleanup());

const TTL = 2 * 3600;
let seq = 0;
const fresh = (): string => init_project(ctx, `잠금 시험 ${++seq}`);
const home = () => ({ env: ctx.env, pes_home: ctx.pes_home, home_dir: ctx.home_dir });
const slug_of = (project: string): string => project.split(/[\\/]/).pop() as string;
const owner = (project: string): string | undefined => ts_view(home(), slug_of(project))?.lock?.owner;

interface Lease {
  acquired_at: number;
  heartbeat_at: number;
  expires_at: number;
}
/** the lease row of a project (acquired / heartbeat / expires in ms), or undefined */
function lease(project: string): Lease | undefined {
  const rows = db_rows<{ acquired_at: bigint; heartbeat_at: bigint; expires_at: bigint }>(
    ctx,
    "SELECT l.acquired_at, l.heartbeat_at, l.expires_at FROM project_leases l JOIN projects p ON p.id = l.project_id WHERE p.slug = ? AND l.state = 'active'",
    slug_of(project),
  );
  const row = rows[0];
  return row === undefined ? undefined : { acquired_at: Number(row.acquired_at), heartbeat_at: Number(row.heartbeat_at), expires_at: Number(row.expires_at) };
}

test("lock without PES_OWNER exits 2, names the variable, and writes nothing", () => {
  const project = fresh();
  const run = pes(ctx, "lock", project);
  assert.equal(run.code, 2, run.out + run.err);
  assert.match(run.err, /PES_OWNER/);
  assert.equal(owner(project), undefined);
  assert.equal(lease(project), undefined);
});

test("another owner is rejected with exit 3 (lock and write commands), and the state stays as it was", () => {
  const project = fresh();
  assert.equal(pes_as(ctx, "alice-session", "lock", project).code, 0);
  assert.equal(owner(project), "alice-session");
  assert.ok(lease(project) !== undefined, "a lease row exists");
  const before = JSON.stringify(project_state(ctx, project));

  const other = pes_as(ctx, "bob-session", "lock", project);
  assert.equal(other.code, 3, other.out + other.err);
  assert.match(other.err, /다른 세션이 사용 중/);
  assert.equal(owner(project), "alice-session");

  // Write commands refuse for the same reason and leave the state alone.
  const note = pes_as(ctx, "bob-session", "note", project, "합성 메모");
  assert.equal(note.code, 3, note.out + note.err);
  assert.match(note.err, /다른 세션이 이 프로젝트를 쓰고 있습니다/);
  assert.equal(JSON.stringify(project_state(ctx, project)), before);
});

test("the same owner refreshing keeps `since` (acquired) and moves `at` (heartbeat) forward", () => {
  const project = fresh();
  assert.equal(pes_as(ctx, "alice-session", "lock", project).code, 0);
  assert.equal(owner(project), "alice-session");
  const first = lease(project) as Lease;
  assert.equal(first.expires_at - first.heartbeat_at, TTL * 1000, "the TTL is 2 hours");

  ts_age_lease(home(), slug_of(project), TTL - 300); // still alive, but older than a refresh
  const aged = lease(project) as Lease;
  assert.ok(aged.heartbeat_at < first.heartbeat_at - (TTL - 301) * 1000);

  const run = pes_as(ctx, "alice-session", "lock", project);
  assert.equal(run.code, 0, run.out + run.err);
  const refreshed = lease(project) as Lease;
  assert.equal(owner(project), "alice-session");
  assert.equal(refreshed.acquired_at, aged.acquired_at, "`since` is kept");
  assert.ok(refreshed.heartbeat_at > aged.heartbeat_at, "`at` moves forward");
});

test("an expired lock can be taken over, and does not block write commands either", () => {
  const project = fresh();
  assert.equal(pes_as(ctx, "alice-session", "lock", project).code, 0);
  ts_age_lease(home(), slug_of(project), TTL + 10);

  const take = pes_as(ctx, "bob-session", "lock", project);
  assert.equal(take.code, 0, take.out + take.err);
  assert.equal(owner(project), "bob-session");

  ts_age_lease(home(), slug_of(project), TTL + 10);
  const note = pes_as(ctx, "bob-session", "note", project, "만료 뒤 인계");
  assert.equal(note.code, 0, note.out + note.err);
  assert.equal(owner(project), "bob-session");
  assert.equal(project_state(ctx, project).notes.length, 1);
});

test("--force takes the lock over and unlock hands it back: only the owner (or --force) can unlock", () => {
  const project = fresh();
  assert.equal(pes_as(ctx, "alice-session", "lock", project).code, 0);

  const denied = pes_as(ctx, "bob-session", "unlock", project);
  assert.equal(denied.code, 3, denied.out + denied.err);
  assert.match(denied.err, /다른 세션의 잠금/);
  assert.equal(owner(project), "alice-session", "the lock is still there");

  const forced = pes_as(ctx, "bob-session", "lock", project, "--force");
  assert.equal(forced.code, 0, forced.out + forced.err);
  assert.equal(owner(project), "bob-session");

  assert.equal(pes_as(ctx, "alice-session", "unlock", project).code, 3);
  assert.equal(owner(project), "bob-session", "the lock is still there");

  assert.equal(pes_as(ctx, "bob-session", "unlock", project).code, 0);
  assert.equal(owner(project), undefined, "the lock is gone");

  assert.equal(pes_as(ctx, "alice-session", "lock", project).code, 0);
  assert.equal(owner(project), "alice-session");
});

test("a lock is live up to TTL (2 hours) and expired beyond it — checked 30 s each side of the edge with the lease aged by the harness", () => {
  const project = fresh();
  assert.equal(pes_as(ctx, "alice-session", "lock", project).code, 0);
  const l = lease(project) as Lease;
  assert.equal(l.expires_at - l.heartbeat_at, TTL * 1000, "TTL = 2 hours (lease expires − heartbeat)");
  ts_age_lease(home(), slug_of(project), TTL - 30);
  assert.equal(owner(project), "alice-session", "TTL − 30 s: still live");
  assert.equal(pes_as(ctx, "bob-session", "lock", project).code, 3, "TTL − 30 s: another session is refused");
  ts_age_lease(home(), slug_of(project), 60); // now TTL + 30 s old
  assert.equal(owner(project), undefined, "TTL + 30 s: expired");
  assert.equal(pes_as(ctx, "bob-session", "lock", project).code, 0, "TTL + 30 s: another session takes it");
});
