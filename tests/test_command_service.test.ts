// SEL-37 (stage 2 PR4): command service tests, written before the implementation.
//
// Representative commands (decided here; keep the registry this small):
//   project.bootstrap  ctx.project_id = null, ctx.actor_id = null (no project or actor yet).
//                      payload {slug, topic, owner_display_name}.
//                      result = BootstrapResult fields (project_id, owner_user_id,
//                      owner_actor_id, edition_id, policy_id, tx_id, stage_ids, ...).
//   project.set_topic  a rev-bearing business change. ctx.base_control_rev is required.
//                      payload {topic: non-empty string}.
//                      result {project_id, topic, control_rev}; control_rev goes up by 1.
//
// bootstrap_project(db, input, deps) in bootstrap.ts keeps its signature (no ctx). Internally it runs
// the project.bootstrap command through the service with the synchronous execute_sync(ctx, command,
// payload), with via='cli' and a freshly generated client_request_id. tests/test_db_bootstrap.test.ts
// expects its events (>= 1, same tx_id as the single receipt).
// execute() is async: it returns a Promise, errors are rejections, and it never yields inside a tx.
//
// Interfaces fixed by these tests (the worker implements exactly these):
//   new CommandService(db, {clock, policy}); service.execute(ctx, command, payload)
//     -> {result, replayed}. (Async: tests `await` the call.)
//   MutationContext {project_id: string|null, actor_id: string|null, via, client_request_id,
//     base_control_rev?: number}
//   PolicyChecker.check(ctx, command, payload) -> {allowed: true} | {allowed: false, reason: string}
//     A denial surfaces as ApiError code "policy_denied". Tests inject a fake.
//   ApiError(code, message, details?) and error_envelope(err) -> {error: {code, message, details?}}.
//   Error codes (the JSON fixtures are the contract): unknown_command, invalid_payload, forbidden,
//     not_found, policy_denied, idempotency_key_reuse, rev_conflict, conflict.
//   Check order: command registry -> project/actor (forbidden, not_found) -> current policy ->
//     receipt replay (client_request_id + request_hash) -> rev -> change -> events + receipt, one tx.
//
// Fixtures: tests/fixtures/contracts/commands/*.json (language neutral; see run_fixture()).

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { FakeClock } from "../scripts/pes_core/clock.ts";
import { connect, migrate, type Db, type RunResult, type SqlValue } from "../scripts/pes_core/db.ts";
import { ApiError, error_envelope } from "../scripts/pes_core/errors.ts";
import {
  COMMANDS,
  CommandService,
  type MutationContext,
  type PolicyChecker,
} from "../scripts/pes_core/commands.ts";
import { db_path } from "../scripts/pes_core/paths.ts";
import { isolated_home, type IsolatedHome } from "./helpers/isolated_home.ts";
import { state_signature, table_counts } from "./helpers/state_signature.ts";

const START_MS = 1_760_000_000_000;
const TEN_YEARS_MS = 10 * 365 * 24 * 60 * 60 * 1000;
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const CORE_DIR = join(REPO, "scripts", "pes_core");
const FIXTURE_DIR = join(HERE, "fixtures", "contracts", "commands");

// ---------------------------------------------------------------------------
// Harness

class FakePolicy implements PolicyChecker {
  allowed = true;
  calls = 0;
  check(_ctx: MutationContext, _command: string, _payload: unknown) {
    this.calls += 1;
    return this.allowed
      ? ({ allowed: true } as const)
      : ({ allowed: false, reason: "synthetic policy: transfer is OFF" } as const);
  }
}

interface Env {
  home: IsolatedHome;
  db: Db;
  clock: FakeClock;
  policy: FakePolicy;
  service: CommandService;
  p1: { project_id: string; actor_id: string };
  p2: { project_id: string; actor_id: string };
  ctx(p: { project_id: string; actor_id: string }, key: string, base?: number): MutationContext;
  /** Same service API on a wrapped db (to inject failures). */
  with_db(db: Db): CommandService;
  close(): void;
}

function bootstrap_ctx(key: string): MutationContext {
  return { project_id: null, actor_id: null, via: "cli", client_request_id: key };
}

async function make_env(): Promise<Env> {
  const home = isolated_home("pes-sel37-");
  const db = connect(db_path(home.env));
  migrate(db);
  const clock = new FakeClock(START_MS);
  const policy = new FakePolicy();
  const service = new CommandService(db, { clock, policy });

  async function boot(n: number) {
    const out = await service.execute(bootstrap_ctx(`setup-p${n}`), "project.bootstrap", {
      slug: `synthetic-p${n}`,
      topic: `합성 주제 ${n}`,
      owner_display_name: `합성 소유자 ${n}`,
    });
    const r = out.result as { project_id: string; owner_actor_id: string };
    return { project_id: r.project_id, actor_id: r.owner_actor_id };
  }
  const p1 = await boot(1);
  const p2 = await boot(2);
  policy.calls = 0;

  return {
    home,
    db,
    clock,
    policy,
    service,
    p1,
    p2,
    ctx: (p, key, base) => ({
      project_id: p.project_id,
      actor_id: p.actor_id,
      via: "cli",
      client_request_id: key,
      ...(base === undefined ? {} : { base_control_rev: base }),
    }),
    with_db: (wrapped) => new CommandService(wrapped, { clock, policy }),
    close() {
      db.close();
      home.cleanup();
    },
  };
}

async function with_env(fn: (env: Env) => Promise<void> | void): Promise<void> {
  const env = await make_env();
  try {
    await fn(env);
  } finally {
    env.close();
  }
}

function control_rev(db: Db, project_id: string): number {
  const row = db.get<{ control_rev: bigint }>("SELECT control_rev FROM projects WHERE id = ?", project_id);
  assert.ok(row, "project row exists");
  return Number(row.control_rev);
}

function count(db: Db, table: string): number {
  return Number(db.get<{ n: bigint }>(`SELECT count(*) AS n FROM ${table}`)?.n ?? 0n);
}

/** Wraps a Db; `rule` may throw, or return a RunResult to fake the statement. */
function wrap_db(db: Db, rule: (sql: string) => RunResult | void): Db {
  return {
    path: db.path,
    exec: (sql) => db.exec(sql),
    prepare: (sql) => db.prepare(sql),
    run: (sql, ...params: SqlValue[]) => rule(sql) ?? db.run(sql, ...params),
    get: <T>(sql: string, ...params: SqlValue[]) => db.get<T>(sql, ...params),
    all: <T>(sql: string, ...params: SqlValue[]) => db.all<T>(sql, ...params),
    close: () => db.close(),
  };
}

async function rejects_with_api_error(p: Promise<unknown> | unknown, code?: string): Promise<ApiError> {
  try {
    await p;
  } catch (error) {
    assert.ok(error instanceof ApiError, `expected ApiError, got ${String(error)}`);
    if (code !== undefined) assert.equal(error.code, code);
    return error;
  }
  assert.fail("expected the command to be rejected");
}

// ---------------------------------------------------------------------------
// ApiError / envelope

test("ApiError carries code, message, details and serializes as a JSON envelope", () => {
  const err = new ApiError("rev_conflict", "base_control_rev is stale", { expected: 3, actual: 4 });
  assert.ok(err instanceof Error);
  assert.equal(err.code, "rev_conflict");
  assert.equal(err.message, "base_control_rev is stale");
  const env = JSON.parse(JSON.stringify(error_envelope(err)));
  assert.deepEqual(env, {
    error: { code: "rev_conflict", message: "base_control_rev is stale", details: { expected: 3, actual: 4 } },
  });
});

test("error_envelope omits details when none were given", () => {
  const env = JSON.parse(JSON.stringify(error_envelope(new ApiError("forbidden", "no access"))));
  assert.deepEqual(env, { error: { code: "forbidden", message: "no access" } });
  assert.equal("details" in env.error, false);
});

// ---------------------------------------------------------------------------
// Closed registry

test("COMMANDS is a closed registry of named domain commands, not table CRUD", () => {
  const names = COMMANDS instanceof Map ? [...COMMANDS.keys()] : Object.keys(COMMANDS);
  assert.ok(names.includes("project.bootstrap"));
  assert.ok(names.includes("project.set_topic"));
  for (const name of names) {
    assert.match(name, /^[a-z][a-z_]*\.[a-z][a-z_]*$/, `command name shape: ${name}`);
    assert.doesNotMatch(name, /^(sql|exec|table|ops|raw|crud|insert|update|delete|replace)\b/);
    assert.doesNotMatch(name, /\.(insert|update|delete|replace|exec|sql|ops)$/);
  }
});

// ---------------------------------------------------------------------------
// JSON contract fixtures

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

interface FixtureStep {
  policy?: "allow" | "deny";
  request: {
    command: string;
    project: "p1" | "p2" | "missing" | "none";
    actor: "p1" | "p2" | "none";
    client_request_id: string;
    base_control_rev?: number | "current";
    payload: Json;
  };
  expect: { ok: { replayed: boolean; result: Json } } | { error: Json };
}
interface Fixture {
  name: string;
  description: string;
  steps: FixtureStep[];
}

function load_fixtures(): { file: string; fixture: Fixture }[] {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((file) => ({ file, fixture: JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8")) as Fixture }));
}

function substitute(value: Json, env: Env): Json {
  if (typeof value === "string") {
    if (value === "$p1") return env.p1.project_id;
    if (value === "$p2") return env.p2.project_id;
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, env));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, env)]));
  }
  return value;
}

/** Subset match; "$any" matches any non-empty string. */
function assert_subset(expected: Json, actual: unknown, path: string): void {
  if (expected === "$any") {
    assert.equal(typeof actual, "string", `${path}: expected a string`);
    assert.ok((actual as string).length > 0, `${path}: expected a non-empty string`);
    return;
  }
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${path}: expected an array`);
    assert.equal(actual.length, expected.length, `${path}: array length`);
    expected.forEach((e, i) => assert_subset(e, actual[i], `${path}[${i}]`));
    return;
  }
  if (expected !== null && typeof expected === "object") {
    assert.ok(actual !== null && typeof actual === "object", `${path}: expected an object`);
    for (const [k, v] of Object.entries(expected)) {
      assert.ok(k in (actual as object), `${path}.${k}: missing`);
      assert_subset(v, (actual as Record<string, unknown>)[k], `${path}.${k}`);
    }
    return;
  }
  assert.equal(actual, expected, path);
}

async function run_fixture(fixture: Fixture): Promise<void> {
  await with_env(async (env) => {
    for (const [index, step] of fixture.steps.entries()) {
      const where = `${fixture.name} step ${index + 1}`;
      const req = step.request;
      const project_id =
        req.project === "none" ? null : req.project === "missing" ? "no-such-project-id" : env[req.project].project_id;
      const actor_id = req.actor === "none" ? null : env[req.actor].actor_id;
      const base =
        req.base_control_rev === "current"
          ? control_rev(env.db, env.p1.project_id)
          : req.base_control_rev;
      const ctx: MutationContext = {
        project_id,
        actor_id,
        via: "cli",
        client_request_id: req.client_request_id,
        ...(base === undefined ? {} : { base_control_rev: base }),
      };
      env.policy.allowed = step.policy !== "deny";

      const before_sig = state_signature(env.db);
      const before_commits = count(env.db, "mutation_commits");
      const before_events = count(env.db, "events");

      if ("ok" in step.expect) {
        const out = await env.service.execute(ctx, req.command, req.payload);
        assert.equal(out.replayed, step.expect.ok.replayed, `${where}: replayed`);
        const wire = JSON.parse(JSON.stringify(out.result)); // must be JSON-serializable
        assert_subset(substitute(step.expect.ok.result, env), wire, `${where}: result`);
        if (out.replayed) {
          assert.equal(state_signature(env.db), before_sig, `${where}: replay must not change anything`);
        } else {
          assert.equal(count(env.db, "mutation_commits"), before_commits + 1, `${where}: one receipt`);
          assert.ok(count(env.db, "events") > before_events, `${where}: at least one event`);
        }
      } else {
        let thrown: unknown;
        try {
          await env.service.execute(ctx, req.command, req.payload);
        } catch (error) {
          thrown = error;
        }
        assert.ok(thrown instanceof ApiError, `${where}: expected ApiError, got ${String(thrown)}`);
        const wire = JSON.parse(JSON.stringify(error_envelope(thrown)));
        assert_subset(substitute(step.expect.error, env), wire, `${where}: envelope`);
        assert.equal(state_signature(env.db), before_sig, `${where}: a rejected command changes nothing`);
      }
    }
  });
}

test("contract fixtures exist and have the language-neutral shape", () => {
  const all = load_fixtures();
  assert.ok(all.length >= 10, `expected at least 10 fixtures, found ${all.length}`);
  const names = new Set<string>();
  for (const { file, fixture } of all) {
    assert.equal(fixture.name + ".json", file, "fixture name matches the file name");
    assert.ok(!names.has(fixture.name));
    names.add(fixture.name);
    assert.ok(fixture.description.length > 0);
    assert.ok(fixture.steps.length >= 1);
    for (const step of fixture.steps) {
      assert.ok(step.request.command.length > 0);
      assert.ok("ok" in step.expect || "error" in step.expect);
    }
  }
  // The required behaviours each have a fixture.
  for (const required of [
    "set_topic_replay",
    "set_topic_key_reuse",
    "set_topic_rev_conflict",
    "policy_off_after_done",
    "set_topic_forbidden",
    "unknown_command",
  ]) {
    assert.ok(names.has(required), `missing fixture ${required}`);
  }
});

for (const { fixture } of load_fixtures()) {
  test(`contract fixture: ${fixture.name}`, async () => {
    await run_fixture(fixture);
  });
}

// ---------------------------------------------------------------------------
// Receipts, events, rev

test("a successful change leaves one receipt and its events in the same tx, and bumps control_rev by 1", async () => {
  await with_env(async (env) => {
    const rev0 = control_rev(env.db, env.p1.project_id);
    const commits_before = count(env.db, "mutation_commits");
    const out = await env.service.execute(env.ctx(env.p1, "k-1", rev0), "project.set_topic", { topic: "영수증 시험" });
    assert.equal(out.replayed, false);
    assert.equal(control_rev(env.db, env.p1.project_id), rev0 + 1);
    assert.equal(
      env.db.get<{ topic: string }>("SELECT topic FROM projects WHERE id = ?", env.p1.project_id)?.topic,
      "영수증 시험",
    );

    assert.equal(count(env.db, "mutation_commits"), commits_before + 1);
    const receipt = env.db.get<{
      id: string;
      project_id: string;
      actor_id: string;
      via: string;
      client_request_id: string;
      request_hash: string;
      base_control_rev: bigint;
      result_json: string;
      created_at: bigint;
    }>(
      "SELECT * FROM mutation_commits WHERE project_id = ? AND client_request_id = 'k-1'",
      env.p1.project_id,
    );
    assert.ok(receipt);
    assert.equal(receipt.actor_id, env.p1.actor_id);
    assert.equal(receipt.via, "cli");
    assert.match(receipt.request_hash, /^[0-9a-f]{64}$/);
    assert.equal(Number(receipt.base_control_rev), rev0);
    assert.equal(Number(receipt.created_at), START_MS);
    assert.deepEqual(JSON.parse(receipt.result_json), JSON.parse(JSON.stringify(out.result)));

    const events = env.db.all<{ tx_id: string; tx_index: bigint; tx_size: bigint; type: string; payload: string }>(
      "SELECT tx_id, tx_index, tx_size, type, payload FROM events WHERE tx_id = ? ORDER BY tx_index",
      receipt.id,
    );
    assert.ok(events.length >= 1, "at least one event");
    events.forEach((e, i) => {
      assert.equal(Number(e.tx_index), i);
      assert.equal(Number(e.tx_size), events.length);
      assert.ok(e.type.length > 0);
      JSON.parse(e.payload);
    });
    assert.deepEqual(env.db.all("PRAGMA foreign_key_check"), []);
  });
});

test("project.bootstrap through the service also leaves a receipt and events", async () => {
  await with_env(async (env) => {
    const commits_before = count(env.db, "mutation_commits");
    const events_before = count(env.db, "events");
    const out = await env.service.execute(bootstrap_ctx("boot-x"), "project.bootstrap", {
      slug: "synthetic-x",
      topic: "서비스 경유",
      owner_display_name: "합성 소유자 x",
    });
    const r = out.result as { project_id: string; owner_actor_id: string; policy_id: string; edition_id: string };
    assert.equal(out.replayed, false);
    assert.equal(count(env.db, "mutation_commits"), commits_before + 1);
    assert.ok(count(env.db, "events") > events_before);
    const project = env.db.get<{ status: string; current_policy_id: string; active_edition_id: string }>(
      "SELECT status, current_policy_id, active_edition_id FROM projects WHERE id = ?",
      r.project_id,
    );
    assert.equal(project?.status, "active");
    assert.equal(project?.current_policy_id, r.policy_id);
    assert.equal(project?.active_edition_id, r.edition_id);
    const receipt = env.db.get<{ actor_id: string }>(
      "SELECT actor_id FROM mutation_commits WHERE project_id = ? AND client_request_id = 'boot-x'",
      r.project_id,
    );
    assert.equal(receipt?.actor_id, r.owner_actor_id);
    assert.deepEqual(env.db.all("PRAGMA foreign_key_check"), []);
  });
});

test("receipts are kept for the long term: no path removes them as time passes", async () => {
  await with_env(async (env) => {
    await env.service.execute(env.ctx(env.p1, "old-1", control_rev(env.db, env.p1.project_id)), "project.set_topic", {
      topic: "오래된 영수증",
    });
    const first = env.db.get<{ id: string; created_at: bigint; result_json: string }>(
      "SELECT id, created_at, result_json FROM mutation_commits WHERE client_request_id = 'old-1'",
    );
    assert.ok(first);
    const events_of_first = count(env.db, "events");

    env.clock.advance(TEN_YEARS_MS);
    for (let i = 0; i < 3; i += 1) {
      await env.service.execute(env.ctx(env.p1, `new-${i}`, control_rev(env.db, env.p1.project_id)), "project.set_topic", {
        topic: `나중 ${i}`,
      });
    }
    const again = env.db.get<{ id: string; created_at: bigint; result_json: string }>(
      "SELECT id, created_at, result_json FROM mutation_commits WHERE client_request_id = 'old-1'",
    );
    assert.deepEqual(again, first, "the ten-year-old receipt is untouched");
    assert.ok(count(env.db, "events") >= events_of_first, "events are not pruned either");

    // ...and it still replays after ten years, with the original result.
    const replay = await env.service.execute(
      env.ctx(env.p1, "old-1", 0),
      "project.set_topic",
      { topic: "오래된 영수증" },
    );
    assert.equal(replay.replayed, true);
    assert.deepEqual(JSON.parse(JSON.stringify(replay.result)), JSON.parse(first.result_json));
  });
});

test("rev goes up one per change and a stale base is rejected without side effects", async () => {
  await with_env(async (env) => {
    const rev0 = control_rev(env.db, env.p1.project_id);
    await env.service.execute(env.ctx(env.p1, "r-1", rev0), "project.set_topic", { topic: "하나" });
    await env.service.execute(env.ctx(env.p1, "r-2", rev0 + 1), "project.set_topic", { topic: "둘" });
    assert.equal(control_rev(env.db, env.p1.project_id), rev0 + 2);

    const sig = state_signature(env.db);
    await rejects_with_api_error(
      env.service.execute(env.ctx(env.p1, "r-3", rev0), "project.set_topic", { topic: "낡은 base" }),
      "rev_conflict",
    );
    assert.equal(state_signature(env.db), sig);
  });
});

test("a rev-bearing command without base_control_rev is rejected", async () => {
  await with_env(async (env) => {
    const sig = state_signature(env.db);
    await rejects_with_api_error(
      env.service.execute(env.ctx(env.p1, "no-base"), "project.set_topic", { topic: "base 없음" }),
    );
    assert.equal(state_signature(env.db), sig);
  });
});

// ---------------------------------------------------------------------------
// Atomicity: zero-row updates and late failures

test("a zero-row update rolls everything back and does not look like a success", async () => {
  await with_env(async (env) => {
    const rev0 = control_rev(env.db, env.p1.project_id);
    const sig = state_signature(env.db);
    const fake_zero = wrap_db(env.db, (sql) =>
      /^\s*UPDATE\s+projects\b/i.test(sql) ? { changes: 0n, last_insert_rowid: 0n } : undefined,
    );
    await rejects_with_api_error(
      env.with_db(fake_zero).execute(env.ctx(env.p1, "zero-1", rev0), "project.set_topic", { topic: "0행" }),
    );
    assert.equal(state_signature(env.db), sig, "no business row, event, or receipt remains");
    assert.equal(control_rev(env.db, env.p1.project_id), rev0);

    // The failed attempt left no receipt behind, so the same key runs for real afterwards.
    const out = await env.service.execute(env.ctx(env.p1, "zero-1", rev0), "project.set_topic", { topic: "0행" });
    assert.equal(out.replayed, false);
    assert.equal(control_rev(env.db, env.p1.project_id), rev0 + 1);
  });
});

for (const [label, pattern] of [
  ["events insert", /^\s*INSERT\s+INTO\s+events\b/i],
  ["receipt insert", /^\s*INSERT\s+INTO\s+mutation_commits\b/i],
] as const) {
  test(`a late failure at the ${label} rolls back the whole command`, async () => {
    await with_env(async (env) => {
      const rev0 = control_rev(env.db, env.p1.project_id);
      const sig = state_signature(env.db);
      const counts = table_counts(env.db);
      const failing = wrap_db(env.db, (sql) => {
        if (pattern.test(sql)) throw new Error("injected late failure");
      });
      await assert.rejects(
        async () => env.with_db(failing).execute(env.ctx(env.p1, "late-1", rev0), "project.set_topic", { topic: "늦은 실패" }),
        /injected late failure/,
      );
      assert.equal(state_signature(env.db), sig, "nothing remains");
      assert.deepEqual(table_counts(env.db), counts);
      assert.equal(control_rev(env.db, env.p1.project_id), rev0);

      const retry = await env.service.execute(env.ctx(env.p1, "late-1", rev0), "project.set_topic", { topic: "늦은 실패" });
      assert.equal(retry.replayed, false, "the failed attempt was never recorded as done");
      assert.equal(control_rev(env.db, env.p1.project_id), rev0 + 1);
    });
  });
}

test("a late failure while bootstrapping leaves no project, actor, or receipt", async () => {
  await with_env(async (env) => {
    const sig = state_signature(env.db);
    const failing = wrap_db(env.db, (sql) => {
      if (/^\s*UPDATE\s+projects\b/i.test(sql)) throw new Error("injected bootstrap failure");
    });
    await assert.rejects(
      async () =>
        env.with_db(failing).execute(bootstrap_ctx("boot-fail"), "project.bootstrap", {
          slug: "synthetic-fail",
          topic: "부분 생성 금지",
          owner_display_name: "합성 소유자",
        }),
      /injected bootstrap failure/,
    );
    assert.equal(state_signature(env.db), sig);
  });
});

// ---------------------------------------------------------------------------
// Check order: authorization / policy / destination run before receipt replay

test("policy is checked before replay, including on a replayed request", async () => {
  await with_env(async (env) => {
    const rev0 = control_rev(env.db, env.p1.project_id);
    await env.service.execute(env.ctx(env.p1, "done-1", rev0), "project.set_topic", { topic: "OFF 전에 끝남" });
    const sig = state_signature(env.db);

    const calls_before = env.policy.calls;
    env.policy.allowed = true;
    const replay = await env.service.execute(env.ctx(env.p1, "done-1", rev0), "project.set_topic", { topic: "OFF 전에 끝남" });
    assert.equal(replay.replayed, true);
    assert.ok(env.policy.calls > calls_before, "the policy is consulted even when a receipt exists");

    env.policy.allowed = false; // transfer turned OFF
    const err = await rejects_with_api_error(
      env.service.execute(env.ctx(env.p1, "done-1", rev0), "project.set_topic", { topic: "OFF 전에 끝남" }),
      "policy_denied",
    );
    assert.doesNotMatch(JSON.stringify(error_envelope(err)), /OFF 전에 끝남/, "the stored result is not leaked");
    assert.equal(state_signature(env.db), sig);
  });
});

test("a policy denial wins over a key-reuse conflict", async () => {
  await with_env(async (env) => {
    const rev0 = control_rev(env.db, env.p1.project_id);
    await env.service.execute(env.ctx(env.p1, "dup-1", rev0), "project.set_topic", { topic: "원래 요청" });
    env.policy.allowed = false;
    await rejects_with_api_error(
      env.service.execute(env.ctx(env.p1, "dup-1", rev0), "project.set_topic", { topic: "다른 요청" }),
      "policy_denied",
    );
  });
});

test("a disabled actor cannot replay its old receipt", async () => {
  await with_env(async (env) => {
    const rev0 = control_rev(env.db, env.p1.project_id);
    await env.service.execute(env.ctx(env.p1, "dis-1", rev0), "project.set_topic", { topic: "비활성 전 완료" });
    env.db.run("UPDATE actors SET disabled_at = ? WHERE id = ?", BigInt(START_MS), env.p1.actor_id);
    const sig = state_signature(env.db);
    await rejects_with_api_error(
      env.service.execute(env.ctx(env.p1, "dis-1", rev0), "project.set_topic", { topic: "비활성 전 완료" }),
      "forbidden",
    );
    assert.equal(state_signature(env.db), sig);
  });
});

test("an actor from another project is forbidden", async () => {
  await with_env(async (env) => {
    const rev0 = control_rev(env.db, env.p1.project_id);
    const sig = state_signature(env.db);
    await rejects_with_api_error(
      env.service.execute(
        { ...env.ctx(env.p1, "x-1", rev0), actor_id: env.p2.actor_id },
        "project.set_topic",
        { topic: "p2가 p1을 바꿈" },
      ),
      "forbidden",
    );
    assert.equal(state_signature(env.db), sig);
  });
});

test("an unknown command is rejected before anything else, with no policy call or write", async () => {
  await with_env(async (env) => {
    const sig = state_signature(env.db);
    const calls = env.policy.calls;
    await rejects_with_api_error(
      env.service.execute(env.ctx(env.p1, "u-1", 0), "project.drop_everything", {}),
      "unknown_command",
    );
    assert.equal(state_signature(env.db), sig);
    assert.equal(env.policy.calls, calls);
  });
});

test("replay returns the original result even when the clock moved and rev changed", async () => {
  await with_env(async (env) => {
    const rev0 = control_rev(env.db, env.p1.project_id);
    const first = await env.service.execute(env.ctx(env.p1, "rp-1", rev0), "project.set_topic", { topic: "첫 결과" });
    await env.service.execute(env.ctx(env.p1, "rp-2", rev0 + 1), "project.set_topic", { topic: "그 다음" });
    env.clock.advance(60_000);
    const sig = state_signature(env.db);
    const replay = await env.service.execute(env.ctx(env.p1, "rp-1", rev0), "project.set_topic", { topic: "첫 결과" });
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.result, first.result);
    assert.equal(state_signature(env.db), sig);
  });
});

// ---------------------------------------------------------------------------
// Static check: no code outside the command service writes business tables

// Leader decision: only these files may write business tables. bootstrap.ts is
// intentionally absent (it must move into the service). backup.ts (PR3) and
// d1_smoke.ts (PR2) may not exist yet; missing files are simply not scanned.
const WRITE_ALLOWED = new Set(["commands.ts", "db.ts", "backup.ts", "d1_smoke.ts"]);

function business_tables(): string[] {
  const sql = readFileSync(join(CORE_DIR, "migrations", "001_initial.sql"), "utf8");
  const tables = [...sql.matchAll(/CREATE\s+TABLE\s+(\w+)/gi)].map((m) => m[1]!);
  return tables.filter((t) => t !== "db_meta");
}

function strip_comments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

function write_pattern(tables: string[]): RegExp {
  const names = tables.join("|");
  return new RegExp(
    `\\b(?:INSERT\\s+(?:OR\\s+\\w+\\s+)?INTO|REPLACE\\s+INTO|UPDATE(?:\\s+OR\\s+\\w+)?|DELETE\\s+FROM)\\s+["\`\\[]?(?:${names})\\b`,
    "gi",
  );
}

function ts_files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...ts_files(full));
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out.sort();
}

test("static check detector finds INSERT/UPDATE/DELETE/REPLACE on business tables", () => {
  const re = write_pattern(business_tables());
  const hits = (s: string) => strip_comments(s).match(re)?.length ?? 0;
  assert.equal(hits('db.run("INSERT INTO projects (id) VALUES (?)")'), 1);
  assert.equal(hits("db.run(`UPDATE   projects\n SET topic = ?`)"), 1);
  assert.equal(hits('db.run("delete from mutation_commits")'), 1);
  assert.equal(hits('db.run("INSERT OR REPLACE INTO events (id) VALUES (?)")'), 1);
  assert.equal(hits('db.run("REPLACE INTO users (id) VALUES (?)")'), 1);
  assert.equal(hits('db.run("SELECT * FROM projects")'), 0, "reads are fine");
  assert.equal(hits('db.run("INSERT INTO db_meta (key) VALUES (?)")'), 0, "db_meta belongs to migrate()");
  assert.equal(hits("// INSERT INTO projects is only mentioned here"), 0, "comments do not count");
});

test("no code outside the command service writes business tables", () => {
  const re = write_pattern(business_tables());
  const files = ts_files(CORE_DIR);
  assert.ok(files.length >= 5, "the scan found the core sources");
  const violations: string[] = [];
  for (const file of files) {
    const rel = relative(CORE_DIR, file);
    if (!rel.includes("/") && !rel.includes("\\") && WRITE_ALLOWED.has(rel)) continue;
    const source = strip_comments(readFileSync(file, "utf8"));
    for (const m of source.matchAll(re)) {
      violations.push(`${relative(REPO, file)}: ${m[0].replace(/\s+/g, " ")}`);
    }
  }
  assert.deepEqual(violations, [], "move these writes into commands.ts");
});

test("nothing anywhere in the core deletes receipts or events", () => {
  const re = /\bDELETE\s+FROM\s+["`\[]?(?:mutation_commits|events)\b|\bDROP\s+TABLE\s+["`\[]?(?:mutation_commits|events)\b|\bTRUNCATE\b/gi;
  const violations: string[] = [];
  for (const file of ts_files(CORE_DIR)) {
    const source = strip_comments(readFileSync(file, "utf8"));
    for (const m of source.matchAll(re)) violations.push(`${relative(REPO, file)}: ${m[0]}`);
  }
  assert.deepEqual(violations, []);
});
