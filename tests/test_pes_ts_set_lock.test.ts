/**
 * SEL-71 × SEL-75: the Windows `set` lock matrix on the TypeScript target. tests/test_cli_set_lock_windows.test.ts pins what 0.15 (`pes.py
 * set`, `short_write_lock`) does when the OS answers PermissionError while another process is deleting `.project.json.lock`; the Linear
 * issue asks the same scenarios of `node scripts/pes.ts set`: retry without a traceback or an abnormal exit, and — off Windows — a real
 * "permission denied" ends at once with exit 2.
 *
 * Same method, Node side (tests/helpers/ts_inject_fs.ts, loaded with --import): the lock file name `.project.json.lock` in the project
 * folder gets EPERM / EEXIST on open·create, EPERM on stat and unlink for the first k calls (-1 = always); `nt` makes `process.platform`
 * read "win32" while the injected error is handled; `fake_clock` turns sleeps into clock moves (the 30 s deadline costs no time). The
 * counts the injector reports are what really happened. Works on every OS (macOS / Linux CI included) — no real Windows needed.
 *
 * Interpretation recorded for the worker: the ts `set` keeps the 0.15 short write lock — a file `<project folder>/.project.json.lock`
 * created exclusively, stale after 60 s, waited for up to 30 s (exit 3, text "다른 set"), exit 2 with a "권한" message for a permission
 * error on a missing lock — because the issue and the matrix name that file. The value is read back from the database (D02).
 * Windows checklist: children run guarded, outputs are LF-normalised, no shell / `which`, paths go in as arguments and env JSON only.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { make_ctx, type CompatCtx } from "./helpers/compat_env.ts";
import { PES_TS_FILE, TS_INJECT_MODULE, run_ts_cli, run_ts_cli_async, ts_view } from "./helpers/compat_ts.ts";
import { use_home_guard } from "./helpers/home_guard.ts";

use_home_guard();

const LOCK = ".project.json.lock";
const SLUG = "set-synth";

interface Inject {
  open_fail?: number;
  stat_fail?: number;
  unlink_fail?: number;
  exists_fail?: number;
  nt?: boolean;
  fake_clock?: boolean;
  code?: "EPERM" | "EACCES";
}

interface Counts {
  open: number;
  stat: number;
  unlink: number;
  exists: number;
  slept: number;
}

interface SetEnv {
  ctx: CompatCtx;
  folder: string;
  state(): any;
  value_file(name: string, text: string): string;
  cleanup(): void;
}

function make_set_env(): SetEnv {
  assert.ok(existsSync(PES_TS_FILE), "scripts/pes.ts does not exist yet — SEL-71 writes it");
  const ctx = make_ctx("pes-ts-setlock-");
  const folder = join(ctx.pes_home, SLUG);
  const init = run_ts_cli(ctx, ["init", folder, "--topic", "합성 set 주제"]);
  assert.equal(init.status, 0, `init: ${init.stderr}${init.stdout}`);
  mkdirSync(folder, { recursive: true });
  return {
    ctx,
    folder,
    state: () => {
      const view = ts_view({ env: ctx.env, pes_home: ctx.pes_home, home_dir: ctx.home_dir }, SLUG);
      assert.ok(view, "the project is in the database");
      return view.project;
    },
    value_file: (name, text) => {
      const file = join(ctx.home.root, name);
      writeFileSync(file, text, "utf8");
      return file;
    },
    cleanup: () => ctx.cleanup(),
  };
}

const CRASH = /Traceback|PermissionError|FileExistsError|WinError|EPERM|EACCES|ERR_|\n\s+at .+\(|node:internal/;
let seq = 0;

interface Ran {
  status: number | null;
  stdout: string;
  stderr: string;
  counts: Counts;
}

function report_file(e: SetEnv): string {
  return join(e.ctx.home.root, `inject-report-${seq++}.json`);
}

function counts_of(report: string): Counts {
  const empty: Counts = { open: 0, stat: 0, unlink: 0, exists: 0, slept: 0 };
  return existsSync(report) ? { ...empty, ...JSON.parse(readFileSync(report, "utf8")) } : empty;
}

function set_args(e: SetEnv, text: string, name = `v-${seq}.txt`): string[] {
  return ["set", SLUG, "plan", "summary", e.value_file(name, text)];
}

function run_set(e: SetEnv, args: string[], inject: Inject): Ran {
  const report = report_file(e);
  const run = run_ts_cli(e.ctx, args, { imports: [TS_INJECT_MODULE], env: { SEL75_INJECT: JSON.stringify(inject), SEL75_REPORT: report }, timeout_ms: 120_000 });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, counts: counts_of(report) };
}

function run_set_async(e: SetEnv, args: string[], inject: Inject): Promise<Ran> {
  const report = report_file(e);
  return run_ts_cli_async(e.ctx, args, { imports: [TS_INJECT_MODULE], env: { SEL75_INJECT: JSON.stringify(inject), SEL75_REPORT: report }, timeout_ms: 120_000 }).then((run) => ({ status: run.status, stdout: run.stdout, stderr: run.stderr, counts: counts_of(report) }));
}

function lock_path(e: SetEnv): string {
  return join(e.folder, LOCK);
}

function put_lock(e: SetEnv, age_seconds: number): void {
  mkdirSync(e.folder, { recursive: true });
  writeFileSync(lock_path(e), "", "utf8");
  if (age_seconds > 0) {
    const t = new Date(Date.now() - age_seconds * 1000);
    utimesSync(lock_path(e), t, t);
  }
}

function assert_clean(e: SetEnv, what: string): void {
  e.state(); // the project is still readable
  const left = readdirSync(e.folder).filter((n) => /\.tmp(\.\d+)?$/.test(n) || n.startsWith("project.json.tmp"));
  assert.deepEqual(left, [], `${what}: no temporary file is left`);
}

function set_ok(e: SetEnv, inject: Inject, text: string, what: string): Ran {
  const r = run_set(e, set_args(e, text), inject);
  assert.doesNotMatch(r.stderr, CRASH, `${what}: no stack trace / raw OS error\n${r.stderr}`);
  assert.equal(r.status, 0, `${what}: set must succeed (exit ${r.status})\n${r.stderr}`);
  assert.equal(e.state().stages.plan.summary, text, `${what}: the value is stored`);
  assert_clean(e, what);
  return r;
}

// ---------------------------------------------------------------------------
// the injector itself must not change a plain set

test("no injection: an ordinary set is exit 0, leaves no lock and the injector counts 0 events", () => {
  const e = make_set_env();
  try {
    const r = set_ok(e, {}, "주입 없음", "no injection");
    assert.deepEqual(r.counts, { open: 0, stat: 0, unlink: 0, exists: 0, slept: 0 });
    assert.ok(!existsSync(lock_path(e)), "the lock file is gone at the end");
  } finally {
    e.cleanup();
  }
});

// ---------------------------------------------------------------------------
// creating the lock fails with EPERM (Windows: someone is deleting the lock file)

for (const k of [1, 2, 5, 40]) {
  test(`(Windows imitation) creating the lock fails with EPERM ${k} time(s): set retries, succeeds, leaves no lock or temporary file`, () => {
    const e = make_set_env();
    try {
      const r = set_ok(e, { open_fail: k, nt: true, fake_clock: true }, `열기 ${k}번 실패 뒤 성공`, `open ${k}`);
      assert.equal(r.counts.open, k, "the injection really happened k times (the product retried through all of them)");
      assert.ok(!existsSync(lock_path(e)));
      set_ok(e, {}, "그다음 set", "the next set");
    } finally {
      e.cleanup();
    }
  });
}

test("EACCES instead of EPERM is the same case (the other code Windows uses for a file in deletion)", () => {
  const e = make_set_env();
  try {
    const r = set_ok(e, { open_fail: 3, nt: true, fake_clock: true, code: "EACCES" }, "EACCES 뒤 성공", "EACCES");
    assert.equal(r.counts.open, 3);
  } finally {
    e.cleanup();
  }
});

test("one EPERM, then a real EEXIST (someone else's lock) that is older than 60 s: the stale lock is cleared and set succeeds", () => {
  const e = make_set_env();
  try {
    put_lock(e, 120);
    const r = set_ok(e, { open_fail: 1, nt: true, fake_clock: true }, "묵은 잠금 뒤 성공", "EPERM then stale lock");
    assert.equal(r.counts.open, 1);
    assert.ok(!existsSync(lock_path(e)));
  } finally {
    e.cleanup();
  }
});

test("EPERM and EEXIST alternating still end in success", () => {
  const e = make_set_env();
  try {
    const r = set_ok(e, { open_fail: 3, exists_fail: 3, nt: true, fake_clock: true }, "번갈아 실패", "alternating");
    assert.equal(r.counts.open, 3);
    assert.equal(r.counts.exists, 3);
  } finally {
    e.cleanup();
  }
});

// ---------------------------------------------------------------------------
// stat of the lock fails with EPERM

for (const k of [1, 4]) {
  test(`a stale lock exists and stat(lock) fails with EPERM ${k} time(s): retry, then the stale lock is cleared and set succeeds`, () => {
    const e = make_set_env();
    try {
      put_lock(e, 120);
      const r = set_ok(e, { stat_fail: k, fake_clock: true }, `stat ${k}번 실패`, `stat ${k}`);
      assert.equal(r.counts.stat, k);
      assert.ok(!existsSync(lock_path(e)), "the stale lock is gone");
    } finally {
      e.cleanup();
    }
  });
}

test("open fails with EPERM and the following stat fails too (the file is in deletion): retry and succeed", () => {
  const e = make_set_env();
  try {
    put_lock(e, 120);
    const r = set_ok(e, { open_fail: 2, stat_fail: 2, nt: true, fake_clock: true }, "open·stat 모두 실패", "open+stat");
    assert.equal(r.counts.open, 2);
    assert.ok(r.counts.stat >= 1);
  } finally {
    e.cleanup();
  }
});

// ---------------------------------------------------------------------------
// unlink of the lock fails with EPERM

for (const k of [1, 3]) {
  test(`clearing a stale lock: unlink fails with EPERM ${k} time(s): retry and succeed`, () => {
    const e = make_set_env();
    try {
      put_lock(e, 120);
      const r = set_ok(e, { unlink_fail: k, fake_clock: true }, `묵은 잠금 unlink ${k}번 실패`, `stale unlink ${k}`);
      assert.equal(r.counts.unlink, k);
      assert.ok(!existsSync(lock_path(e)));
    } finally {
      e.cleanup();
    }
  });
}

// the final unlink: 50 tries x 0.02 s; up to 49 failures still end with the lock removed, 50 failures in a row are given up quietly
for (const k of [1, 2, 49]) {
  test(`the final unlink of our own lock fails with EPERM ${k} time(s) (< 50): the lock is removed in the end, no stack trace`, () => {
    const e = make_set_env();
    try {
      const r = set_ok(e, { unlink_fail: k, fake_clock: true }, `끝 unlink ${k} 실패`, `final unlink ${k}`);
      assert.equal(r.counts.unlink, k);
      assert.ok(!existsSync(lock_path(e)));
    } finally {
      e.cleanup();
    }
  });
}

test("the final unlink keeps failing: after 50 tries (about 1 s) set gives up quietly — success without a stack trace, the lock stays, and the 60 s rule governs the next set", () => {
  const e = make_set_env();
  try {
    const r = set_ok(e, { unlink_fail: -1, fake_clock: true }, "계속 unlink 실패", "final unlink forever");
    assert.equal(r.counts.unlink, 50, "exactly 50 tries");
    assert.ok(r.counts.slept >= 49 && r.counts.slept <= 52, `about 49 sleeps between the tries (${r.counts.slept})`);
    assert.ok(existsSync(lock_path(e)), "the lock that could not be deleted stays");
    // fresh (< 60 s): the next set waits out the deadline and ends with exit 3
    const before = JSON.stringify(e.state());
    const held = run_set(e, set_args(e, "아직", "next.txt"), { fake_clock: true });
    assert.equal(held.status, 3, held.stderr);
    assert.doesNotMatch(held.stderr, CRASH);
    assert.equal(JSON.stringify(e.state()), before, "the project is unchanged");
    // older than 60 s: the next set clears it and proceeds
    const t = new Date(Date.now() - 61_000);
    utimesSync(lock_path(e), t, t);
    set_ok(e, {}, "묵은 잠금 이어받음", "take over the stale lock");
    assert.ok(!existsSync(lock_path(e)));
  } finally {
    e.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Off Windows: PermissionError + no lock file = a real "permission denied" → fail at once

test("off Windows, no lock file, open fails with EPERM for good: no waiting (0 sleeps), exit 2, a message that says 권한, no stack trace, nothing changed", { skip: process.platform === "win32" ? "Windows reads EPERM as a deletion in progress and retries (the contract differs)" : false }, () => {
  const e = make_set_env();
  try {
    const before = JSON.stringify(e.state());
    const started = Date.now();
    const r = run_set(e, set_args(e, "권한 없음", "noperm.txt"), { open_fail: -1, fake_clock: true });
    assert.ok(Date.now() - started < 30_000);
    assert.doesNotMatch(r.stderr, CRASH, r.stderr);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /권한/, "it says it is a permission problem");
    assert.doesNotMatch(r.stderr, /다른 set/, "no false 'another set is saving' text");
    assert.equal(r.counts.slept, 0, `no waiting (${r.counts.slept} sleeps)`);
    assert.equal(r.counts.open, 1, "one try only");
    assert.equal(JSON.stringify(e.state()), before, "the project is unchanged");
    assert.ok(!existsSync(lock_path(e)));
  } finally {
    e.cleanup();
  }
});

test("off Windows but the lock file exists: EPERM on open means 'still held' — retry until the deadline, then exit 3 and the other's lock untouched", { skip: process.platform === "win32" ? "covered by the nt cases" : false }, () => {
  const e = make_set_env();
  try {
    put_lock(e, 0);
    const before = JSON.stringify(e.state());
    const r = run_set(e, set_args(e, "잡힘", "held.txt"), { open_fail: -1, fake_clock: true });
    assert.doesNotMatch(r.stderr, CRASH, r.stderr);
    assert.equal(r.status, 3, r.stderr);
    assert.match(r.stderr, /다른 set/);
    assert.ok(r.counts.slept >= 100, `it retried (${r.counts.slept} sleeps)`);
    assert.equal(JSON.stringify(e.state()), before);
    assert.ok(existsSync(lock_path(e)), "someone else's lock is not ours to remove");
  } finally {
    e.cleanup();
  }
});

test("off Windows, a lock exists, open fails with EPERM a few times, and the lock is older than 60 s: cleared, set succeeds", { skip: process.platform === "win32" ? "covered by the nt cases" : false }, () => {
  const e = make_set_env();
  try {
    put_lock(e, 120);
    const r = set_ok(e, { open_fail: 2, fake_clock: true }, "묵은 잠금 뒤 성공", "stale lock off Windows");
    assert.equal(r.counts.open, 2);
  } finally {
    e.cleanup();
  }
});

// ---------------------------------------------------------------------------
// real concurrency (no injection): several set children at once — no crash, no lost lock handling, all finish

test("four concurrent sets of different values: every child ends (exit 0), no stack trace, one of the values is stored, no lock or temporary file is left", async () => {
  const e = make_set_env();
  try {
    const texts = ["동시 하나", "동시 둘", "동시 셋", "동시 넷"];
    const runs = await Promise.all(texts.map((t, i) => run_set_async(e, set_args(e, t, `c-${i}.txt`), {})));
    for (const r of runs) {
      assert.doesNotMatch(r.stderr, CRASH, r.stderr);
      assert.ok(r.status === 0 || r.status === 3, `exit ${r.status}: a set either stores its value or reports the busy lock (3)\n${r.stderr}`);
    }
    assert.ok(runs.some((r) => r.status === 0), "at least one set stored its value");
    assert.ok(texts.includes(e.state().stages.plan.summary), "the stored value is one of the four");
    assert.ok(!existsSync(lock_path(e)), "no lock left behind");
    assert_clean(e, "concurrent");
  } finally {
    e.cleanup();
  }
});

// ---------------------------------------------------------------------------
// SEL-74 (5단계 시험 쪽): the rest of the 0.15 matrix of tests/test_cli_set_lock_windows.test.ts (file deleted with Python — each of its 18
// tests is now one of the tests above or one of these seven): a real read-only folder, the 30 s deadline and the 60 s stale rule, an EPERM that
// never goes away, stat / unlink that never succeed on a stale lock, and two concurrent sets with injected EPERM.

test("a real read-only folder (chmod 555): no 30 s wait, exit 2, a message that says 권한, no stack trace, the project unchanged", {
  skip: process.platform === "win32" ? "Windows cannot make a folder read-only with chmod" : process.getuid?.() === 0 ? "root can write into a chmod 555 folder" : false,
}, () => {
  const e = make_set_env();
  try {
    const before = JSON.stringify(e.state());
    chmodSync(e.folder, 0o555);
    const started = Date.now();
    const r = run_set(e, set_args(e, "읽기 전용", "ro.txt"), {});
    const elapsed = Date.now() - started;
    chmodSync(e.folder, 0o755);
    assert.ok(elapsed < 15_000, `no 30 s wait (${elapsed} ms)`);
    assert.doesNotMatch(r.stderr, CRASH, r.stderr);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /권한/);
    assert.equal(JSON.stringify(e.state()), before);
  } finally {
    try {
      chmodSync(e.folder, 0o755);
    } catch {
      // may be gone
    }
    e.cleanup();
  }
});

test("a fresh lock that never goes away: after the 30 s deadline (synthetic clock) exit 3 with the Korean line, no stack trace; the value and the other's lock are untouched", () => {
  const e = make_set_env();
  try {
    put_lock(e, 0);
    const before = JSON.stringify(e.state());
    const started = Date.now();
    const r = run_set(e, set_args(e, "마감 시험", "late.txt"), { fake_clock: true });
    assert.ok(Date.now() - started < 20_000, "the 30 s are not really waited");
    assert.doesNotMatch(r.stderr, CRASH, r.stderr);
    assert.equal(r.status, 3, r.stderr);
    assert.match(r.stderr, /다른 set/, "Korean text");
    assert.ok(r.counts.slept >= 100, `it retried until the deadline (${r.counts.slept} sleeps)`);
    assert.equal(JSON.stringify(e.state()), before, "unchanged");
    assert.ok(existsSync(lock_path(e)), "the other's lock is not ours to remove");
    assert_clean(e, "deadline");
  } finally {
    e.cleanup();
  }
});

test("(Windows imitation) open fails with EPERM for ever (a deletion that never ends): after the deadline exit 3, no stack trace, no lock file made", () => {
  const e = make_set_env();
  try {
    const before = JSON.stringify(e.state());
    const started = Date.now();
    const r = run_set(e, set_args(e, "영영", "forever.txt"), { open_fail: -1, nt: true, fake_clock: true });
    assert.ok(Date.now() - started < 20_000, "the 30 s are not really waited");
    assert.doesNotMatch(r.stderr, CRASH, r.stderr);
    assert.equal(r.status, 3, r.stderr);
    assert.match(r.stderr, /다른 set/);
    assert.equal(JSON.stringify(e.state()), before);
    assert.ok(!existsSync(lock_path(e)), "no lock file made");
    assert_clean(e, "EPERM for ever");
  } finally {
    e.cleanup();
  }
});

for (const inject of [{ stat_fail: -1 }, { unlink_fail: -1 }] as const) {
  test(`a stale lock and ${Object.keys(inject)[0]} that never succeeds: after the deadline exit 3, no stack trace, the project unchanged`, () => {
    const e = make_set_env();
    try {
      put_lock(e, 120);
      const before = JSON.stringify(e.state());
      const r = run_set(e, set_args(e, "막힘", "stuck.txt"), { ...inject, fake_clock: true });
      assert.doesNotMatch(r.stderr, CRASH, `${JSON.stringify(inject)}\n${r.stderr}`);
      assert.equal(r.status, 3, r.stderr);
      assert.equal(JSON.stringify(e.state()), before);
      assert_clean(e, JSON.stringify(inject));
    } finally {
      e.cleanup();
    }
  });
}

test("the 60 s rule (no injection): a lock younger than 60 s even at the end of the 30 s wait is refused and kept; a 61 s old lock is cleared and set succeeds", () => {
  const e = make_set_env();
  try {
    // the synthetic clock runs to the deadline (30 s): lock age 25 s + 30 s = 55 s < 60 s, so it stays fresh to the end
    put_lock(e, 25);
    const before = JSON.stringify(e.state());
    const held = run_set(e, set_args(e, "아직", "x.txt"), { fake_clock: true });
    assert.equal(held.status, 3, held.stderr);
    assert.doesNotMatch(held.stderr, CRASH);
    assert.equal(JSON.stringify(e.state()), before);
    assert.ok(existsSync(lock_path(e)));
    const t = new Date(Date.now() - 61_000);
    utimesSync(lock_path(e), t, t);
    set_ok(e, {}, "61초 묵은 잠금", "61 s");
    assert.ok(!existsSync(lock_path(e)));
  } finally {
    e.cleanup();
  }
});

test("the 30 s deadline: a lock that is released just before it lets set succeed — EEXIST for the first 1000 tries (20 synthetic seconds), then the real thing", () => {
  const e = make_set_env();
  try {
    const r = set_ok(e, { exists_fail: 1000, fake_clock: true }, "마감 안에 풀림", "inside the deadline");
    assert.equal(r.counts.exists, 1000);
    assert.ok(!existsSync(lock_path(e)));
  } finally {
    e.cleanup();
  }
});

test("two concurrent sets, each with its own first EPERMs on the lock (10 rounds): both succeed, no update is lost, no lock or temporary file is left", async () => {
  const e = make_set_env();
  try {
    for (let round = 0; round < 10; round++) {
      const a = e.value_file(`ca${round}.txt`, `에이 ${round}`);
      const b = e.value_file(`cb${round}.txt`, `비 ${round}`);
      const [ra, rb] = await Promise.all([
        run_set_async(e, ["set", SLUG, "plan", "summary", a], { open_fail: 1 + (round % 4), nt: true }),
        run_set_async(e, ["set", SLUG, "project", "conclusion", b], { open_fail: 1 + ((round + 2) % 4), nt: true }),
      ]);
      for (const [name, r] of [["a", ra], ["b", rb]] as const) {
        assert.doesNotMatch(r.stderr, CRASH, `round ${round} ${name}\n${r.stderr}`);
        assert.equal(r.status, 0, `round ${round} ${name}: exit ${r.status}\n${r.stderr}`);
      }
      const st = e.state();
      assert.equal(st.stages.plan.summary, `에이 ${round}`, `round ${round}: a lost`);
      assert.equal(st.conclusion, `비 ${round}`, `round ${round}: b lost`);
      assert_clean(e, `round ${round}`);
      assert.ok(!existsSync(lock_path(e)), `round ${round}: a lock is left`);
    }
  } finally {
    e.cleanup();
  }
});
