// The guard of TypeScript children (SEL-71, the README's "TS 자식 가드는 PR26b 몫") and the SEL-75 injection module, tested with stub
// children (tests/helpers/ts_guard_probe.ts, ts_inject_probe.ts) — they need no scripts/pes.ts. Everything uses a FAKE "real home" under a
// temp folder, so the guard is proven without touching the real ~/.pes. The real pes.ts runs under the same guard in test_pes_ts_contract.
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { make_ctx } from "./helpers/compat_env.ts";
import { BARE_COMMAND, PES_TS_FILE, REPO_ROOT, TS_GUARD_MODULE, TS_INJECT_MODULE, run_ts_cli, ts_child_argv, ts_permission_flags } from "./helpers/compat_ts.ts";
import { use_home_guard } from "./helpers/home_guard.ts";

use_home_guard();

const PROBE = join(REPO_ROOT, "tests", "helpers", "ts_guard_probe.ts");
const INJECT_PROBE = join(REPO_ROOT, "tests", "helpers", "ts_inject_probe.ts");

function fake_real_home(): { dir: string; secret: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), "pes-fake-real-home-ts-"));
  mkdirSync(join(dir, ".pes"), { recursive: true });
  const secret = join(dir, ".pes", "config.json");
  writeFileSync(secret, '{"home": "synthetic"}', "utf8");
  mkdirSync(join(dir, "pes-projects", "p"), { recursive: true });
  writeFileSync(join(dir, "pes-projects", "p", "project.json"), "{}", "utf8");
  return { dir, secret, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function probe(ctx: ReturnType<typeof make_ctx>, fake: string, args: string[], extra: Parameters<typeof run_ts_cli>[2] = {}) {
  return run_ts_cli(ctx, args, { script: PROBE, real_homes: [fake], expect_violation: true, ...extra });
}

test("the run method is fixed: `node [--permission …] [--import guard] scripts/pes.ts <args>` — no loader, no build step", () => {
  assert.deepEqual([...BARE_COMMAND], ["node", "scripts/pes.ts"]);
  const ctx = make_ctx("pes-ts-argv-");
  try {
    const argv = ts_child_argv(ctx, ["status", "x"]);
    assert.equal(argv[0], "--permission");
    assert.equal(argv.at(-3), PES_TS_FILE);
    assert.deepEqual(argv.slice(-2), ["status", "x"]);
    assert.ok(argv.some((a, i) => a === "--import" && argv[i + 1]?.endsWith("ts_child_guard.ts")), "the guard is loaded with --import");
    assert.ok(!argv.some((a) => /tsx|ts-node|--loader|--experimental-loader|--experimental-strip-types|--no-warnings/.test(a)), "Node 26 strips types itself; nothing else is needed");
    assert.ok(!argv.includes("--allow-child-process"), "a child cannot spawn unless the case says so");
    assert.ok(argv.includes("--allow-net"), "sockets are allowed; the loader refuses the hub ports");
    assert.ok(!ts_permission_flags(ctx, { allow_net: false }).includes("--allow-net"));
    assert.ok(ts_permission_flags(ctx, { allow_child_process: true }).includes("--allow-child-process"));
  } finally {
    ctx.cleanup();
  }
});

test("the permission allow-list holds the repo and the case's temp root and nothing of the real home", () => {
  const ctx = make_ctx("pes-ts-allow-");
  try {
    const flags = ts_permission_flags(ctx).join("\n");
    assert.match(flags, /--allow-fs-read=.*SEL-71|--allow-fs-read=/);
    for (const home of [process.env.HOME, process.env.USERPROFILE]) if (home !== undefined && home !== "") assert.ok(!flags.includes(`${home}/.pes`) && !flags.includes(`${home}/pes-projects`));
    const writes = ts_permission_flags(ctx).filter((f) => f.startsWith("--allow-fs-write="));
    assert.ok(writes.length > 0 && writes.every((f) => f.includes(ctx.home.root) || f.includes(ctx.home.root.replace(/^\/private/, ""))), "writes only below the temp root");
  } finally {
    ctx.cleanup();
  }
});

test("a read of the (fake) real home is reported AND denied, whatever the call: fs sync / promises / stat / readdir / exists / sqlite / rename — even when the child catches the error", () => {
  const fake = fake_real_home();
  const ctx = make_ctx("pes-ts-guard-");
  try {
    for (const [op, path] of [
      ["read", fake.secret],
      ["async-read", fake.secret],
      ["stat", join(fake.dir, ".pes")],
      ["list", join(fake.dir, ".pes")],
      ["list", join(fake.dir, "pes-projects")],
      ["exists", join(fake.dir, "pes-projects", "p")],
      ["sqlite", join(fake.dir, ".pes", "pes.db")],
    ] as const) {
      const run = probe(ctx, fake.dir, [op, path]);
      assert.match(run.stdout, /caught EACCES|caught ERR_ACCESS_DENIED/, `${op} ${path}: the child saw a denial`);
      assert.match(run.stderr, /PESHomeAccessViolation/, `${op} ${path}: the harness is told even though the child swallowed the error`);
    }
    // a path that merely looks similar is allowed
    writeFileSync(join(ctx.tmp, "my.pes-notes"), "x");
    const near = probe(ctx, fake.dir, ["ok-read", join(ctx.tmp, "my.pes-notes")]);
    assert.match(near.stdout, /read 1/);
    assert.doesNotMatch(near.stderr, /PESHomeAccessViolation/);
    // the snapshot the use_home_guard of this file takes also proves nothing was created or changed
    assert.equal(readFileSync(fake.secret, "utf8"), '{"home": "synthetic"}');
  } finally {
    ctx.cleanup();
    fake.cleanup();
  }
});

test("a symlink alias of the real .pes is seen through (realpath of the existing prefix)", { skip: process.platform === "win32" ? "symlink needs a privilege on Windows" : false }, () => {
  const fake = fake_real_home();
  const ctx = make_ctx("pes-ts-guard-link-");
  try {
    const alias = join(ctx.tmp, "alias");
    symlinkSync(join(fake.dir, ".pes"), alias);
    // the loader alone sees through the alias and reports it; with `--permission` Node denies the target first
    const loader = probe(ctx, fake.dir, ["read", join(alias, "config.json")], { no_permission: true });
    assert.match(loader.stderr, /PESHomeAccessViolation/, "the alias is the real folder");
    assert.match(loader.stdout, /caught EACCES/);
    const both = probe(ctx, fake.dir, ["read", join(alias, "config.json")]);
    assert.match(both.stdout, /caught (EACCES|ERR_ACCESS_DENIED)/);
  } finally {
    ctx.cleanup();
    fake.cleanup();
  }
});

test("the two nets are independent: the loader alone reports, `--permission` alone denies (and the temp root stays writable, other folders are not)", () => {
  const fake = fake_real_home();
  const ctx = make_ctx("pes-ts-guard-nets-");
  try {
    const loader_only = probe(ctx, fake.dir, ["read", fake.secret], { no_permission: true });
    assert.match(loader_only.stdout, /caught EACCES/);
    assert.match(loader_only.stderr, /PESHomeAccessViolation/);
    // permission without the import: Node's own denial, no loader line
    const outside = probe(ctx, fake.dir, ["read", "/etc/hosts"], process.platform === "win32" ? { script: PROBE } : {});
    if (process.platform !== "win32") assert.match(outside.stdout, /caught ERR_ACCESS_DENIED/, "reads outside the allow-list are denied");
    const write = probe(ctx, fake.dir, ["write", join(ctx.tmp, "w")]);
    assert.match(write.stdout, /write ok/, "the temp root is writable");
    assert.ok(existsSync(join(ctx.tmp, "w", "probe.txt")));
    const elsewhere = probe(ctx, fake.dir, ["write", join(fake.dir, "pes-projects", "new")]);
    assert.match(elsewhere.stdout, /caught (EACCES|ERR_ACCESS_DENIED)/, "a write into the real home is refused");
    assert.ok(!existsSync(join(fake.dir, "pes-projects", "new")));
  } finally {
    ctx.cleanup();
    fake.cleanup();
  }
});

test("a context that points at the real home never starts a ts child (assert_isolated_env first), and a case env cannot switch the guard off", () => {
  const fake = fake_real_home();
  const ctx = make_ctx("pes-ts-guard-env-");
  try {
    ctx.env.HOME = fake.dir;
    ctx.env.USERPROFILE = fake.dir;
    assert.throws(() => run_ts_cli(ctx, ["list"], { script: PROBE, real_homes: [fake.dir] }), /home guard/);
    ctx.env.HOME = ctx.home_dir;
    ctx.env.USERPROFILE = ctx.home_dir;
    assert.throws(() => run_ts_cli(ctx, ["list"], { script: PROBE, env: { PES_TEST_GUARD: "0" } }), /turned the home guard off/);
    for (const key of ["PES_TOKEN", "PES_DB_CORE"]) {
      // these are scrubbed from the child instead of refused: nothing from the parent can leak in
      const run = probe(ctx, fake.dir, ["exists", ctx.tmp], { env: { [key]: "x" } });
      assert.equal(run.status, 0);
    }
  } finally {
    ctx.cleanup();
    fake.cleanup();
  }
});

test("HUB_BLOCK for ts children: net.connect and fetch to 127.0.0.1:8760~8775 are refused and counted; a stand-in hub opens only the ONE allowed port", async () => {
  const ctx = make_ctx("pes-ts-hub-");
  const fake = fake_real_home();
  const stand_in = createServer((socket) => socket.end());
  const port = await new Promise<number>((done, fail) => {
    let next = 8760;
    const attempt = (): void => {
      stand_in.once("error", () => (next < 8775 ? (next += 1, attempt()) : fail(new Error("no free port in 8760~8775"))));
      stand_in.listen(next, "127.0.0.1", () => done(next));
    };
    attempt();
  });
  try {
    const blocked = probe(ctx, fake.dir, ["connect", String(port)]);
    assert.match(blocked.stdout, /caught ECONNREFUSED/);
    assert.deepEqual(blocked.hub_attempts, [port]);
    const fetched = probe(ctx, fake.dir, ["fetch", String(port)]);
    assert.match(fetched.stdout, /caught ECONNREFUSED/);
    assert.deepEqual(fetched.hub_attempts, [port]);
    const open = probe(ctx, fake.dir, ["connect", String(port)], { allow_hub_port: port });
    assert.match(open.stdout, /connected/, "only the allowed port is open");
    assert.deepEqual(open.hub_attempts, []);
    const other = port === 8775 ? 8774 : port + 1;
    assert.match(probe(ctx, fake.dir, ["connect", String(other)], { allow_hub_port: port }).stdout, /caught ECONNREFUSED/, "the other hub ports stay blocked");
    // a port outside the range is not the harness's business (nothing listens there: a plain refusal from the OS, not a counted block)
    const outside = probe(ctx, fake.dir, ["connect", "1"]);
    assert.deepEqual(outside.hub_attempts, []);
  } finally {
    await new Promise((done) => stand_in.close(done));
    ctx.cleanup();
    fake.cleanup();
  }
});

// ---------------------------------------------------------------- the SEL-75 injection module (ts_inject_fs.ts)
function inject_run(ctx: ReturnType<typeof make_ctx>, args: string[], config: Record<string, unknown>): { stdout: string; counts: Record<string, number> } {
  const report = join(ctx.tmp, `report-${Math.random().toString(36).slice(2)}.json`);
  const run = run_ts_cli(ctx, args, { script: INJECT_PROBE, imports: [TS_INJECT_MODULE], env: { SEL75_INJECT: JSON.stringify(config), SEL75_REPORT: report } });
  assert.equal(run.status, 0, run.stderr);
  return { stdout: run.stdout, counts: JSON.parse(readFileSync(report, "utf8")) as Record<string, number> };
}

test("injection: open_fail k throws EPERM on the lock name only, then the real open works; `nt` shows win32 only while the error is handled", () => {
  const ctx = make_ctx("pes-ts-inject-");
  try {
    mkdirSync(join(ctx.tmp, "d"));
    const plain = inject_run(ctx, ["lock-open", join(ctx.tmp, "d"), "3"], { open_fail: 2 });
    assert.match(plain.stdout, new RegExp(`open EPERM@${process.platform}\\nopen EPERM@${process.platform}\\nopened\\nafter ${process.platform}`));
    assert.equal(plain.counts.open, 2);
    const nt = inject_run(ctx, ["lock-open", join(ctx.tmp, "d"), "2"], { open_fail: 1, nt: true });
    assert.match(nt.stdout, /open EPERM@win32\nopened\nafter /, "win32 inside the catch of the injected error");
    assert.doesNotMatch(nt.stdout, /after win32/, "…and the real platform again afterwards");
    const forever = inject_run(ctx, ["lock-open", join(ctx.tmp, "d"), "4"], { open_fail: -1, code: "EACCES" });
    assert.equal(forever.counts.open, 4);
    assert.equal(forever.stdout.split("\n").filter((l) => l.startsWith("open EACCES")).length, 4);
    const exists = inject_run(ctx, ["lock-open", join(ctx.tmp, "d"), "2"], { exists_fail: 1 });
    assert.match(exists.stdout, /open EEXIST@/);
    assert.equal(exists.counts.exists, 1);
    const none = inject_run(ctx, ["other", join(ctx.tmp, "d")], { open_fail: -1, stat_fail: -1, unlink_fail: -1 });
    assert.match(none.stdout, /other ok/, "a file that is not the lock is never touched");
    assert.deepEqual([none.counts.open, none.counts.stat, none.counts.unlink], [0, 0, 0]);
  } finally {
    ctx.cleanup();
  }
});

test("injection: stat_fail / unlink_fail count down, then pass through; fake_clock turns sleeping into a clock move (no real wait)", () => {
  const ctx = make_ctx("pes-ts-inject-2-");
  try {
    mkdirSync(join(ctx.tmp, "e"));
    const out = inject_run(ctx, ["lock-stat", join(ctx.tmp, "e")], { stat_fail: 1, unlink_fail: 1 });
    assert.match(out.stdout, /stat EPERM@\S+\nunlink EPERM@\S+\nunlink ok/);
    assert.deepEqual([out.counts.stat, out.counts.unlink], [1, 1]);
    const clock = inject_run(ctx, ["sleep", "2000"], { fake_clock: true });
    assert.match(clock.stdout, /moved true real_ms_small true/);
    assert.equal(clock.counts.slept, 3, "setTimeout, timers/promises and Atomics.wait each counted once");
  } finally {
    ctx.cleanup();
  }
});

test("the guard module files exist where the run method says", () => {
  assert.ok(existsSync(TS_GUARD_MODULE) && existsSync(TS_INJECT_MODULE));
  appendFileSync(join(tmpdir(), ".pes-ts-guard-touch-check"), "");
  rmSync(join(tmpdir(), ".pes-ts-guard-touch-check"), { force: true });
});
