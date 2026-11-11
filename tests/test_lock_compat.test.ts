// tests/test_lock.py → TS (SEL-70, PR26a; table 8: test_lock_compat). The lock of scripts/pes.py: owner, expiry, hand-over,
// driven through the real CLI. PES_OWNER is the session id; .pes-lock is the 0.15 file (the new core replaces it by a lease, D04).
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";

import { make_ctx, pes, pes_as, project_json, run_py_code, synthetic_project, PES_PY } from "./helpers/compat_env.ts";
import { use_home_guard } from "./helpers/home_guard.ts";

use_home_guard();

const ctx = make_ctx("pes-lock-");
after(() => ctx.cleanup());

const TTL = 2 * 3600;

const lock_path = (project: string): string => join(project, ".pes-lock");
const lock = (project: string): any => JSON.parse(readFileSync(lock_path(project), "utf8"));

/** Moves only the recorded time into the past (no waiting for file times). */
function make_stale(project: string, seconds: number): void {
  const data = lock(project);
  data.at = Date.now() / 1000 - seconds;
  writeFileSync(lock_path(project), JSON.stringify(data), "utf8");
}

test("lock without PES_OWNER exits 2, names the variable, and writes nothing", () => {
  const project = synthetic_project(ctx, "legacy");
  const run = pes(ctx, "lock", project);
  assert.equal(run.code, 2, run.out + run.err);
  assert.match(run.err, /PES_OWNER/);
  assert.throws(() => readFileSync(lock_path(project)), /ENOENT/);
});

test("another owner is rejected with exit 3 (lock and write commands), and project.json stays byte-for-byte", () => {
  const project = synthetic_project(ctx, "legacy");
  const before = readFileSync(join(project, "project.json"));

  assert.equal(pes_as(ctx, "alice-session", "lock", project).code, 0);
  const first = lock(project);
  assert.equal(first.owner, "alice-session");
  assert.ok(first.since);

  const other = pes_as(ctx, "bob-session", "lock", project);
  assert.equal(other.code, 3, other.out + other.err);
  assert.match(other.err, /다른 세션이 사용 중/);
  assert.equal(lock(project).owner, "alice-session");

  // Write commands refuse for the same reason and leave project.json alone.
  const note = pes_as(ctx, "bob-session", "note", project, "합성 메모");
  assert.equal(note.code, 3, note.out + note.err);
  assert.match(note.err, /다른 세션이 이 프로젝트를 쓰고 있습니다/);
  assert.deepEqual(readFileSync(join(project, "project.json")), before);
});

test("the same owner refreshing keeps `since` and moves `at` forward", () => {
  const project = synthetic_project(ctx, "legacy");
  assert.equal(pes_as(ctx, "alice-session", "lock", project).code, 0);
  assert.equal(lock(project).owner, "alice-session");

  const data = lock(project);
  data.since = "2026-01-01 00:00";
  const old_at = Date.now() / 1000 - (TTL - 300); // still alive, but older than a refresh
  data.at = old_at;
  writeFileSync(lock_path(project), JSON.stringify(data), "utf8");

  const run = pes_as(ctx, "alice-session", "lock", project);
  assert.equal(run.code, 0, run.out + run.err);
  const refreshed = lock(project);
  assert.equal(refreshed.owner, "alice-session");
  assert.equal(refreshed.since, "2026-01-01 00:00");
  assert.ok(refreshed.at > old_at);
});

test("an expired lock can be taken over, and does not block write commands either", () => {
  const project = synthetic_project(ctx, "legacy");
  assert.equal(pes_as(ctx, "alice-session", "lock", project).code, 0);
  make_stale(project, TTL + 10);

  const take = pes_as(ctx, "bob-session", "lock", project);
  assert.equal(take.code, 0, take.out + take.err);
  assert.equal(lock(project).owner, "bob-session");

  make_stale(project, TTL + 10);
  const note = pes_as(ctx, "bob-session", "note", project, "만료 뒤 인계");
  assert.equal(note.code, 0, note.out + note.err);
  assert.equal(lock(project).owner, "bob-session");
  assert.equal(project_json(project).notes.length, 1);
});

test("--force takes the lock over and unlock hands it back: only the owner (or --force) can unlock", () => {
  const project = synthetic_project(ctx, "legacy");
  assert.equal(pes_as(ctx, "alice-session", "lock", project).code, 0);

  const denied = pes_as(ctx, "bob-session", "unlock", project);
  assert.equal(denied.code, 3, denied.out + denied.err);
  assert.match(denied.err, /다른 세션의 잠금/);
  assert.doesNotThrow(() => readFileSync(lock_path(project)));

  const forced = pes_as(ctx, "bob-session", "lock", project, "--force");
  assert.equal(forced.code, 0, forced.out + forced.err);
  assert.equal(lock(project).owner, "bob-session");

  assert.equal(pes_as(ctx, "alice-session", "unlock", project).code, 3);
  assert.doesNotThrow(() => readFileSync(lock_path(project)));

  assert.equal(pes_as(ctx, "bob-session", "unlock", project).code, 0);
  assert.throws(() => readFileSync(lock_path(project)), /ENOENT/);

  assert.equal(pes_as(ctx, "alice-session", "lock", project).code, 0);
  assert.equal(lock(project).owner, "alice-session");
});

// lock_info() with a frozen clock: pytest replaced pes.time. There is no CLI form of an exact-second boundary, so the same
// sequence runs in a short inline snippet (no .py file is added; the 0.15 module is loaded by path, time is frozen).
const FROZEN_SNIPPET = String.raw`
import importlib.util, json, sys, tempfile
from pathlib import Path
import time as real_time

spec = importlib.util.spec_from_file_location("pes_frozen_module", sys.argv[1])
pes = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pes)

class Frozen:
    def __init__(self, value): self.value = value
    def time(self): return self.value
    def strftime(self, fmt, *a): return real_time.strftime(fmt, *a)

fixed = 2_000_000_000
pes.time = Frozen(fixed)
project = Path(sys.argv[2])
pes.write_lock(project, "alice-session")
out = {"ttl": pes.LOCK_TTL}
info = pes.lock_info(project)
out["fresh"] = [info["owner"], info["age"], info["live"]]
lock = project / ".pes-lock"
data = json.loads(lock.read_text(encoding="utf-8"))
steps = {}
for name, age in (("ttl_minus_1", pes.LOCK_TTL - 1), ("ttl", pes.LOCK_TTL), ("ttl_plus_1", pes.LOCK_TTL + 1)):
    data["at"] = fixed - age
    lock.write_text(json.dumps(data), encoding="utf-8")
    steps[name] = pes.lock_info(project)["live"]
out["live"] = steps
print(json.dumps(out))
`;

test("lock_info is live up to TTL-1 seconds and expired at TTL and beyond (frozen clock, TTL = 2 hours)", () => {
  const project = synthetic_project(ctx, "legacy");
  const run = run_py_code(ctx, FROZEN_SNIPPET, [PES_PY, project]);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const out = JSON.parse(run.stdout.trim().split("\n").pop() as string);
  assert.equal(out.ttl, TTL);
  assert.deepEqual(out.fresh, ["alice-session", 0, true]);
  assert.deepEqual(out.live, { ttl_minus_1: true, ttl: false, ttl_plus_1: false });
});
