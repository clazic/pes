// SEL-43 hardening round 2 (reinforcement mode, narrow): attacks the area around the fix for
// "a disabled user's actor still passes" and "now_ms NaN/Infinity -> RangeError". Everything is synthetic.
//
// Areas: a user disabled between a command and its replay (scope/policy before replay), disabled
// user's token / actor_id on dispatch, run and content commands, a re-enabled user, an agent actor
// without a user, now_ms boundaries (0, negative, MAX_SAFE_INTEGER, fraction, string, bigint, ...),
// and user / token information in error messages.

import assert from "node:assert/strict";
import { test } from "node:test";

import { FakeClock } from "../scripts/pes_core/clock.ts";
import { connect, migrate, type Db } from "../scripts/pes_core/db.ts";
import { ApiError } from "../scripts/pes_core/errors.ts";
import { CommandService, type MutationContext } from "../scripts/pes_core/commands.ts";
import type { RunConfig } from "../scripts/pes_core/config.ts";
import { claim } from "../scripts/pes_core/runs.ts";
import {
  agent_token_hash,
  generate_agent_token,
  issue_agent_token,
  resolve_actor,
  verify_agent_token,
} from "../scripts/pes_core/actors.ts";
import { DbPolicyChecker, set_policy } from "../scripts/pes_core/policy.ts";
import { db_path } from "../scripts/pes_core/paths.ts";
import { isolated_home, type IsolatedHome } from "./helpers/isolated_home.ts";
import { state_signature } from "./helpers/state_signature.ts";

const START_MS = 1_760_000_000_000;
const DAY_MS = 86_400_000;
const TOKEN_TTL_MS = 30 * DAY_MS;
const TEST_CONFIG: RunConfig = { lease_ttl_ms: 60_000, heartbeat_interval_ms: 20_000 };
const GO_MODEL = "opencode-go/deepseek-v4.1-flash";
const TOKEN_SHAPE = /pes_[A-Za-z0-9_-]{20,}/;

interface Env {
  home: IsolatedHome;
  db: Db;
  clock: FakeClock;
  service: CommandService;
  project_id: string;
  owner_actor_id: string;
  owner_user_id: string;
  ctx(key: string, actor_id?: string): MutationContext;
  close(): void;
}

async function make_env(): Promise<Env> {
  const home = isolated_home("pes-sel43h2-");
  const db = connect(db_path(home.env));
  migrate(db);
  const clock = new FakeClock(START_MS);
  const service = new CommandService(db, { clock, policy: new DbPolicyChecker(), run_config: TEST_CONFIG });
  const out = await service.execute(
    { project_id: null, actor_id: null, via: "cli", client_request_id: "setup-p" },
    "project.bootstrap",
    { slug: "synthetic-hardening-2", topic: "합성 보강2 주제", owner_display_name: "합성 소유자 비밀이름" },
  );
  const r = out.result as { project_id: string; owner_actor_id: string; owner_user_id: string };
  return {
    home,
    db,
    clock,
    service,
    project_id: r.project_id,
    owner_actor_id: r.owner_actor_id,
    owner_user_id: r.owner_user_id,
    ctx: (key, actor_id) => ({
      project_id: r.project_id,
      actor_id: actor_id ?? r.owner_actor_id,
      via: "cli",
      client_request_id: key,
    }),
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

async function rejects_with_api_error(p: Promise<unknown> | unknown, code?: string): Promise<ApiError> {
  try {
    await p;
  } catch (error) {
    assert.ok(error instanceof ApiError, `expected ApiError, got ${String(error)}`);
    if (code !== undefined) assert.equal(error.code, code);
    return error;
  }
  assert.fail("expected the call to be rejected");
}

function throws_api_error(fn: () => unknown, code?: string): ApiError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ApiError, `expected ApiError, got ${String(error)}`);
    if (code !== undefined) assert.equal(error.code, code);
    return error;
  }
  assert.fail("expected the call to throw");
}

function error_texts(error: unknown): string[] {
  const texts = [String(error), JSON.stringify(error)];
  if (error instanceof Error) texts.push(error.message, error.stack ?? "");
  if (error instanceof ApiError) texts.push(JSON.stringify(error.details ?? null));
  return texts;
}

function assert_clean(error: unknown, forbidden: string[], label: string): void {
  for (const text of error_texts(error)) {
    assert.equal(TOKEN_SHAPE.test(text), false, `${label}: token-shaped text`);
    for (const f of forbidden) {
      assert.equal(text.includes(f), false, `${label}: leaks ${f.slice(0, 8)}...`);
    }
  }
}

/** A member with its OWN user (so disabling that user does not touch the owner). */
function add_member(env: Env, id: string, kind: "human" | "external_agent", role: "editor" | "reader"): { actor_id: string; user_id: string } {
  const user_id = `user-${id}`;
  env.db.run("INSERT INTO users (id, display_name, created_at) VALUES (?, ?, 0)", user_id, `비밀표시이름-${id}`);
  env.db.run(
    "INSERT INTO actors (id, kind, user_id, display_name) VALUES (?, ?, ?, ?)",
    `actor-${id}`,
    kind,
    user_id,
    `합성 ${id}`,
  );
  env.db.run("INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)", env.project_id, user_id, role);
  return { actor_id: `actor-${id}`, user_id };
}

function disable_user(env: Env, user_id: string): void {
  env.db.run("UPDATE users SET disabled_at = ? WHERE id = ?", START_MS, user_id);
}

function enable_user(env: Env, user_id: string): void {
  env.db.run("UPDATE users SET disabled_at = NULL WHERE id = ?", user_id);
}

interface Issued {
  token: string;
  token_id: string;
}

async function issue_for(env: Env, key: string, actor_id: string): Promise<Issued> {
  const out = await issue_agent_token(env.service, env.ctx(key), { actor_id, scopes: ["run"] });
  return out.result as Issued;
}

/** A token row written straight into the table (token.issue refuses ineligible actors since the final review). */
function plant_token(env: Env, actor_id: string): Issued {
  const token = generate_agent_token();
  const token_id = `planted-${actor_id}`;
  env.db.run(
    `INSERT INTO agent_tokens (id, project_id, actor_id, scopes, token_hash, created_at, expires_at, revoked_at)
     VALUES (?, ?, ?, '["run"]', ?, ?, ?, NULL)`,
    token_id,
    env.project_id,
    actor_id,
    agent_token_hash(token),
    BigInt(env.clock.now_ms()),
    BigInt(env.clock.now_ms() + TOKEN_TTL_MS),
  );
  return { token, token_id };
}

function lookup_by_token(env: Env, token: string, now_ms = env.clock.now_ms()) {
  return resolve_actor(env.db, { project_id: env.project_id, token }, now_ms);
}

function content_payload() {
  return { kind: "artifact", edition_id: null };
}

async function go_lease_ctx_payload(env: Env, key: string, actor_id: string) {
  return env.service.execute(env.ctx(key, actor_id), "run.claim", {
    mode: "A",
    runtime: "synthetic-runtime",
    provider: "opencode-go",
    model: GO_MODEL,
  });
}

// ---------------------------------------------------------------------------
// 1. User disabled between a command and its replay

test("R1 replay of a finished content command is forbidden once the member's user is disabled (not replayed)", async () => {
  await with_env(async (env) => {
    const m = add_member(env, "ed1", "human", "editor");
    const first = await env.service.execute(env.ctx("r1-create", m.actor_id), "content.create_object", content_payload());
    assert.equal(first.replayed, false);
    const again = await env.service.execute(env.ctx("r1-create", m.actor_id), "content.create_object", content_payload());
    assert.equal(again.replayed, true);

    disable_user(env, m.user_id);
    const before = state_signature(env.db);
    const err = await rejects_with_api_error(
      env.service.execute(env.ctx("r1-create", m.actor_id), "content.create_object", content_payload()),
      "forbidden",
    );
    assert_clean(err, [m.user_id, "비밀표시이름-ed1"], "r1");
    assert.equal(state_signature(env.db), before, "a rejected replay changes nothing");
  });
});

test("R2 replay of token.issue after the owner's user is disabled is forbidden and never returns the stored result", async () => {
  await with_env(async (env) => {
    const agent = add_member(env, "ag1", "external_agent", "editor");
    const t = await issue_for(env, "r2-issue", agent.actor_id);
    disable_user(env, env.owner_user_id);
    const err = await rejects_with_api_error(
      issue_agent_token(env.service, env.ctx("r2-issue"), { actor_id: agent.actor_id, scopes: ["run"] }),
      "forbidden",
    );
    assert_clean(err, [t.token, t.token_id, env.owner_user_id, "비밀이름"], "r2");
    // a replay with a changed payload must not turn into idempotency_key_reuse either (scope first)
    const err2 = await rejects_with_api_error(
      issue_agent_token(env.service, env.ctx("r2-issue"), { actor_id: agent.actor_id, scopes: ["other"] }),
      "forbidden",
    );
    assert_clean(err2, [t.token, env.owner_user_id], "r2b");
  });
});

test("R3 policy (Go off) plus a disabled user: the answer is forbidden, so policy state is not disclosed to a dead actor", async () => {
  await with_env(async (env) => {
    const agent = add_member(env, "ag2", "external_agent", "editor");
    await set_policy(env.service, env.ctx("r3-off"), { allow_opencode_go: false, reason: "합성" });
    disable_user(env, agent.user_id);
    const err = await rejects_with_api_error(go_lease_ctx_payload(env, "r3-claim", agent.actor_id), "forbidden");
    assert_clean(err, [agent.user_id], "r3");
  });
});

test("R4 re-enabled user: the earlier receipt replays again with the same result, and new commands work", async () => {
  await with_env(async (env) => {
    const m = add_member(env, "ed2", "human", "editor");
    const first = await env.service.execute(env.ctx("r4-create", m.actor_id), "content.create_object", content_payload());
    disable_user(env, m.user_id);
    await rejects_with_api_error(
      env.service.execute(env.ctx("r4-create", m.actor_id), "content.create_object", content_payload()),
      "forbidden",
    );
    enable_user(env, m.user_id);
    const again = await env.service.execute(env.ctx("r4-create", m.actor_id), "content.create_object", content_payload());
    assert.equal(again.replayed, true);
    assert.deepEqual(again.result, first.result);
    const fresh = await env.service.execute(env.ctx("r4-new", m.actor_id), "content.create_object", content_payload());
    assert.equal(fresh.replayed, false);
  });
});

test("R5 disabling a user mid-lease: run.release / heartbeat by that user's actor are forbidden and the lease row is untouched", async () => {
  await with_env(async (env) => {
    const agent = add_member(env, "ag3", "external_agent", "editor");
    const out = await go_lease_ctx_payload(env, "r5-claim", agent.actor_id);
    const lease = out.result as { run_id: string; lease_id: string; fence: number };
    disable_user(env, agent.user_id);
    const before = state_signature(env.db);
    for (const [command, key] of [
      ["run.heartbeat", "r5-hb"],
      ["run.release", "r5-rel"],
    ] as const) {
      const err = await rejects_with_api_error(
        env.service.execute(env.ctx(key, agent.actor_id), command, {
          run_id: lease.run_id,
          lease_id: lease.lease_id,
          fence: lease.fence,
        }),
        "forbidden",
      );
      assert_clean(err, [agent.user_id, lease.lease_id], command);
    }
    assert.equal(state_signature(env.db), before);
  });
});

// ---------------------------------------------------------------------------
// 2. A disabled user's token / actor id in each command family

test("R6 a disabled user's agent token: verify / resolve both forbidden; the same token works again after re-enable", async () => {
  await with_env(async (env) => {
    const agent = add_member(env, "ag4", "external_agent", "editor");
    const t = await issue_for(env, "r6-issue", agent.actor_id);
    assert.equal(lookup_by_token(env, t.token).actor_id, agent.actor_id);

    disable_user(env, agent.user_id);
    const e1 = throws_api_error(() => verify_agent_token(env.db, t.token, { project_id: env.project_id, now_ms: env.clock.now_ms() }), "forbidden");
    const e2 = throws_api_error(() => lookup_by_token(env, t.token), "forbidden");
    const e3 = throws_api_error(() => resolve_actor(env.db, { project_id: env.project_id, actor_id: agent.actor_id }, env.clock.now_ms()), "forbidden");
    for (const e of [e1, e2, e3]) assert_clean(e, [t.token, agent_token_hash(t.token), agent.user_id, "비밀표시이름-ag4"], "r6");
    // same message for the token routes: a caller cannot tell "user disabled" from "token unknown"
    const unknown = throws_api_error(() => verify_agent_token(env.db, "pes_" + "z".repeat(43), { project_id: env.project_id, now_ms: env.clock.now_ms() }), "forbidden");
    assert.equal(e1.message, unknown.message);

    enable_user(env, agent.user_id);
    assert.equal(lookup_by_token(env, t.token).actor_id, agent.actor_id);
  });
});

test("R7 disabled user: dispatch / run / content / token commands all forbidden by actor id, none writes", async () => {
  await with_env(async (env) => {
    const agent = add_member(env, "ag5", "external_agent", "editor");
    const lease = (await go_lease_ctx_payload(env, "r7-claim", agent.actor_id)).result as {
      run_id: string;
      lease_id: string;
      fence: number;
    };
    disable_user(env, agent.user_id);
    const before = state_signature(env.db);
    const attempts: Array<[string, unknown]> = [
      ["run.claim", { mode: "A", runtime: "synthetic-runtime", provider: "opencode-go", model: GO_MODEL }],
      ["run.heartbeat", { run_id: lease.run_id, lease_id: lease.lease_id, fence: lease.fence }],
      ["dispatch.prepare", { run_id: lease.run_id, lease_id: lease.lease_id, fence: lease.fence, provider: "opencode-go" }],
      ["dispatch.authorize", { dispatch_id: "nope", run_id: lease.run_id, lease_id: lease.lease_id, fence: lease.fence }],
      ["dispatch.mark_sent", { dispatch_id: "nope", run_id: lease.run_id, lease_id: lease.lease_id, fence: lease.fence, external_request_id: "x" }],
      ["dispatch.block", { dispatch_id: "nope", reason: "x" }],
      ["content.create_object", content_payload()],
      ["policy.set", { allow_opencode_go: true, reason: "x" }],
      ["token.issue", { actor_id: agent.actor_id, scopes: [] }],
      ["token.revoke", { token_id: "nope" }],
    ];
    let n = 0;
    for (const [command, payload] of attempts) {
      const err = await rejects_with_api_error(
        env.service.execute(env.ctx(`r7-${n++}`, agent.actor_id), command, payload),
        "forbidden",
      );
      assert_clean(err, [agent.user_id, "비밀표시이름-ag5"], command);
    }
    assert.equal(state_signature(env.db), before, "no rejected command left a row behind");
  });
});

test("R8 user disabled but actor row enabled, and the opposite (actor disabled, user re-enabled): both stay forbidden", async () => {
  await with_env(async (env) => {
    const agent = add_member(env, "ag6", "external_agent", "editor");
    disable_user(env, agent.user_id);
    env.db.run("UPDATE actors SET disabled_at = ? WHERE id = ?", START_MS, agent.actor_id);
    enable_user(env, agent.user_id);
    await rejects_with_api_error(
      env.service.execute(env.ctx("r8-a", agent.actor_id), "content.create_object", content_payload()),
      "forbidden",
    );
    throws_api_error(
      () => resolve_actor(env.db, { project_id: env.project_id, actor_id: agent.actor_id }, env.clock.now_ms()),
      "forbidden",
    );
  });
});

test("R9 a human owner whose user is disabled cannot issue or revoke tokens or set policy, even with an old receipt", async () => {
  await with_env(async (env) => {
    const agent = add_member(env, "ag7", "external_agent", "editor");
    disable_user(env, env.owner_user_id);
    await rejects_with_api_error(issue_agent_token(env.service, env.ctx("r9-i"), { actor_id: agent.actor_id }), "forbidden");
    await rejects_with_api_error(set_policy(env.service, env.ctx("r9-p"), { allow_opencode_go: false, reason: "x" }), "forbidden");
    throws_api_error(
      () => resolve_actor(env.db, { project_id: env.project_id, actor_id: env.owner_actor_id }, env.clock.now_ms()),
      "forbidden",
    );
    assert.equal(
      env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM agent_tokens")?.n,
      0n,
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Agent actor without a user

test("R10 an agent actor without a user can never act: token or id resolve forbidden, commands forbidden", async () => {
  await with_env(async (env) => {
    env.db.run("INSERT INTO actors (id, kind, display_name) VALUES ('actor-nouser', 'external_agent', '무사용자')");
    const t = plant_token(env, "actor-nouser"); // Final-review R1: token.issue refuses a userless actor
    throws_api_error(() => lookup_by_token(env, t.token), "forbidden");
    throws_api_error(
      () => resolve_actor(env.db, { project_id: env.project_id, actor_id: "actor-nouser" }, env.clock.now_ms()),
      "forbidden",
    );
    const err = await rejects_with_api_error(
      env.service.execute(env.ctx("r10-c", "actor-nouser"), "content.create_object", content_payload()),
      "forbidden",
    );
    assert_clean(err, [t.token], "r10");
  });
});

test("R11 verify_agent_token of a userless actor does not hand out a usable credential (forbidden, like resolve_actor)", async () => {
  await with_env(async (env) => {
    env.db.run("INSERT INTO actors (id, kind, display_name) VALUES ('actor-nouser2', 'external_agent', '무사용자2')");
    const t = plant_token(env, "actor-nouser2"); // Final-review R1: token.issue refuses a userless actor
    throws_api_error(
      () => verify_agent_token(env.db, t.token, { project_id: env.project_id, now_ms: env.clock.now_ms() }),
      "forbidden",
    );
  });
});

test("R12 a member removed from the project (user still enabled) is forbidden too", async () => {
  await with_env(async (env) => {
    const agent = add_member(env, "ag8", "external_agent", "editor");
    const t = await issue_for(env, "r12-issue", agent.actor_id);
    env.db.run("DELETE FROM project_members WHERE project_id = ? AND user_id = ?", env.project_id, agent.user_id);
    throws_api_error(() => lookup_by_token(env, t.token), "forbidden");
    await rejects_with_api_error(
      env.service.execute(env.ctx("r12-c", agent.actor_id), "content.create_object", content_payload()),
      "forbidden",
    );
  });
});

// ---------------------------------------------------------------------------
// 4. now_ms boundaries

async function token_env(env: Env): Promise<{ token: string; actor_id: string }> {
  const agent = add_member(env, "agn", "external_agent", "editor");
  const t = await issue_for(env, "tok-issue", agent.actor_id);
  return { token: t.token, actor_id: agent.actor_id };
}

test("R13 now_ms invalid kinds are invalid_payload (never RangeError / TypeError) on verify, token resolve and id resolve", async () => {
  await with_env(async (env) => {
    const { token, actor_id } = await token_env(env);
    const bad: unknown[] = [
      -1,
      -1e12,
      1.5,
      0.1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
      Number.MAX_VALUE,
      "1",
      "",
      "NaN",
      10n,
      null,
      undefined,
      {},
      [],
      true,
    ];
    for (const value of bad) {
      const label = typeof value === "bigint" ? `${value}n` : String(value);
      throws_api_error(() => verify_agent_token(env.db, token, { project_id: env.project_id, now_ms: value as number }), "invalid_payload");
      throws_api_error(() => resolve_actor(env.db, { project_id: env.project_id, token }, value as number), "invalid_payload");
      throws_api_error(() => resolve_actor(env.db, { project_id: env.project_id, actor_id }, value as number), "invalid_payload");
      void label;
    }
  });
});

test("R14 now_ms bad value is reported before the token is looked at: even a garbage token gives invalid_payload for a bad clock", async () => {
  await with_env(async (env) => {
    const e = throws_api_error(
      () => verify_agent_token(env.db, "garbage", { project_id: env.project_id, now_ms: Number.NaN }),
      "invalid_payload",
    );
    assert_clean(e, ["garbage"], "r14");
  });
});

test("R15 now_ms boundaries on a valid token: 0 and START ok; expires_at - 1 ok; expires_at and MAX_SAFE_INTEGER forbidden; -0 ok", async () => {
  await with_env(async (env) => {
    const { token } = await token_env(env);
    const issued_at = START_MS;
    const expires_at = issued_at + TOKEN_TTL_MS;
    const ok = (now_ms: number) => verify_agent_token(env.db, token, { project_id: env.project_id, now_ms });
    assert.ok(ok(0));
    assert.ok(ok(-0));
    assert.ok(ok(issued_at));
    assert.ok(ok(expires_at - 1));
    throws_api_error(() => ok(expires_at), "forbidden");
    throws_api_error(() => ok(expires_at + 1), "forbidden");
    throws_api_error(() => ok(Number.MAX_SAFE_INTEGER), "forbidden");
    // resolve by token uses the same clock
    assert.ok(lookup_by_token(env, token, expires_at - 1));
    throws_api_error(() => lookup_by_token(env, token, expires_at), "forbidden");
  });
});

test("R16 resolve_actor by actor id has no expiry: MAX_SAFE_INTEGER and 0 both resolve", async () => {
  await with_env(async (env) => {
    const agent = add_member(env, "ag9", "external_agent", "editor");
    for (const now_ms of [0, START_MS, Number.MAX_SAFE_INTEGER]) {
      const r = resolve_actor(env.db, { project_id: env.project_id, actor_id: agent.actor_id }, now_ms);
      assert.equal(r.token_id, null);
      assert.equal(r.actor_id, agent.actor_id);
    }
  });
});

test("R17 invalid now_ms errors do not echo the value or any credential", async () => {
  await with_env(async (env) => {
    const { token, actor_id } = await token_env(env);
    const e1 = throws_api_error(() => verify_agent_token(env.db, token, { project_id: env.project_id, now_ms: "123456789secret" as unknown as number }), "invalid_payload");
    const e2 = throws_api_error(() => resolve_actor(env.db, { project_id: env.project_id, actor_id }, 7.25), "invalid_payload");
    assert_clean(e1, [token, "123456789secret"], "r17a");
    assert_clean(e2, [actor_id, "7.25"], "r17b");
  });
});

test("R18 an options object that is missing or not an object does not escape as a TypeError", async () => {
  await with_env(async (env) => {
    const { token } = await token_env(env);
    for (const bad of [null, undefined, 5, "x"]) {
      try {
        verify_agent_token(env.db, token, bad as never);
        assert.fail("expected a rejection");
      } catch (error) {
        assert.ok(error instanceof ApiError, `expected ApiError for ${String(bad)}, got ${String(error)}`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Error text

test("R19 forbidden messages for a disabled user, a missing actor and a non-member never contain user ids, display names or hashes", async () => {
  await with_env(async (env) => {
    const agent = add_member(env, "ag10", "external_agent", "editor");
    const t = await issue_for(env, "r19-issue", agent.actor_id);
    disable_user(env, agent.user_id);
    const forbidden = [agent.user_id, "비밀표시이름-ag10", agent_token_hash(t.token), t.token, t.token_id, env.owner_user_id, "비밀이름"];
    const errors: unknown[] = [];
    errors.push(await rejects_with_api_error(env.service.execute(env.ctx("r19-a", agent.actor_id), "content.create_object", content_payload()), "forbidden"));
    errors.push(throws_api_error(() => lookup_by_token(env, t.token), "forbidden"));
    errors.push(throws_api_error(() => resolve_actor(env.db, { project_id: env.project_id, actor_id: agent.actor_id }, START_MS), "forbidden"));
    errors.push(await rejects_with_api_error(env.service.execute(env.ctx("r19-b", "no-such-actor"), "content.create_object", content_payload()), "forbidden"));
    for (const e of errors) assert_clean(e, forbidden, "r19");
  });
});
