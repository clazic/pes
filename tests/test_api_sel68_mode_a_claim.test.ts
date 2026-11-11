/**
 * SEL-68 (결함·보안, 작성 모드) — an external_agent (or the human owner) must not start a mode A run.
 *
 * Today `#claims` (api.ts) lets any caller with `run:claim` send mode A + provider opencode-go: the Go policy check
 * runs only `op.go === true && auth.kind === "internal_ai"` / `if (mode === "A") #require_go`, so an external_agent
 * token gets a lease and a run labelled as a built-in Go run. The rule these tests pin:
 *
 *   - Mode A (the PES built-in runner, provider opencode-go) belongs to `internal_ai` actors only. Any other actor
 *     kind — external_agent token or the owner's human session — is refused with 403 `forbidden` (error envelope,
 *     retryable=false) and NOTHING changes: no run, lease, receipt, event, cursor/counter.
 *   - Method B (codex, opencode-tui, claude ...) for an external_agent stays exactly as it is (200).
 *   - An internal_ai caller keeps the Go policy: Go OFF -> 403 `policy_blocked`, Go ON -> 200. (regression, passes today)
 *
 * 해석 (numbered from 1):
 *  해석 1  Error: 403, code `forbidden`, retryable=false, the usual envelope. NOT `policy_blocked` (Go may be ON, and
 *          policy_blocked tells the caller to ask the owner to turn Go on — which would not help). With Go OFF an
 *          external caller on mode A is also 403 (either code is fine there; the test only pins the status).
 *  해석 2  "A-only provider": provider `opencode-go` or a model starting with `opencode-go/`. A claim by a non-internal
 *          actor that carries this provider/model is refused even when it writes mode "B" (otherwise the run would be
 *          labelled as a Go run — see PR20b 해석 31). Same 403 `forbidden`.
 *  해석 3  mode omitted / invalid stays 400 `invalid_payload` (today's behaviour; not an authorisation question).
 *  해석 4  The refusal comes before the idempotency receipt is written, so the same client_request_id (Idempotency-Key)
 *          sent again is refused again with the same status/code and creates nothing.
 *  해석 5  A mode A run is never assigned to or claimed by a non-internal actor: the owner creating a mode A run with
 *          actor_id = an external agent is refused (403 `forbidden` or 400/422), or — if it were created — the
 *          external agent's claim by run_id is refused. Either way the external agent never holds a mode A lease.
 *          (NEW requirement. tests/test_api_sel47_final1.test.ts `run_for(env, agent, "A")` with an external agent, two
 *          call sites, assumes the old behaviour and must move to an internal_ai actor with this fix.)
 *  해석 6  A mode A run held by an internal_ai actor cannot be continued by an external agent holding the guard
 *          (heartbeat / wait / results / complete / release / claim by run_id): refused, nothing changes. (Passes today:
 *          regression guard.)
 *  해석 7  MCP pes_claim and the CLI `claim` go through the same API/command rule: no path around it. A forged claim
 *          default (mode "A" injected into claim_defaults) cannot produce a mode A run for an external token.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { McpServer } from "../scripts/pes_core/mcp_server.ts";
import { FakeMcpClient } from "./helpers/adapter_b_env.ts";
import { assert_error, assert_ok, call, go_off, make_agent, with_api, type Agent, type ApiEnv, type ApiResponse, type Auth } from "./helpers/api_env.ts";
import { P } from "./helpers/api_flow.ts";
import { expect_rejected, json_out, with_cli, SLUG } from "./helpers/cli_write_env.ts";
import { state_signature } from "./helpers/state_signature.ts";
import type { Db } from "../scripts/pes_core/db.ts";

const GO_MODEL = "opencode-go/deepseek-v4.1-flash";

/** Rows that a claim touches: runs, leases, receipts, events, counters, project row, dispatches. Tokens are left out on purpose. */
const CLAIM_TABLES = ["runs", "project_leases", "mutation_commits", "events", "run_input_receipts", "outbound_dispatches", "counters", "projects", "db_meta"];

function claim_sig(db: Db): string {
  return CLAIM_TABLES.map((table) => {
    const rows = db.all(`SELECT * FROM "${table}" ORDER BY rowid`);
    return `${table}:${JSON.stringify(rows, (_k, v) => (typeof v === "bigint" ? `${v}n` : v))}`;
  }).join("\n");
}

function count(db: Db, sql: string, ...params: unknown[]): number {
  return Number(db.get<{ n: bigint }>(sql, ...(params as any[]))?.n ?? 0n);
}

const runs_n = (env: ApiEnv) => count(env.db, "SELECT COUNT(*) AS n FROM runs");
const leases_n = (env: ApiEnv) => count(env.db, "SELECT COUNT(*) AS n FROM project_leases");
const mode_a_runs_n = (env: ApiEnv) => count(env.db, "SELECT COUNT(*) AS n FROM runs WHERE mode = 'A'");

const claim = (env: ApiEnv, auth: Auth, body: unknown, key?: string): Promise<ApiResponse> =>
  call(env, { method: "POST", path: P(env, "/claims"), auth, body, key });

/** 해석 1: 403 forbidden, not retryable, with the envelope. */
function assert_refused(res: ApiResponse, label: string): void {
  const error = assert_error(res, 403, "forbidden");
  assert.equal(error.retryable, false, `${label}: not retryable`);
}

const MODE_A_BODIES: Array<[string, Record<string, unknown>]> = [
  ["A pes_builtin / opencode-go", { mode: "A", runtime: "pes_builtin", provider: "opencode-go", model: GO_MODEL }],
  ["A synthetic runtime / opencode-go", { mode: "A", runtime: "synthetic-runtime", provider: "opencode-go", model: GO_MODEL }],
  ["A codex_cli runtime / opencode-go", { mode: "A", runtime: "codex_cli", provider: "opencode-go", model: "opencode-go/synthetic" }],
  ["A with expected_control_rev", { mode: "A", runtime: "pes_builtin", provider: "opencode-go", model: GO_MODEL, expected_control_rev: "0" }],
];

// 해석 2: mode B written, but the provider / model is the A-only (Go) pair
const GO_LABELLED_B_BODIES: Array<[string, Record<string, unknown>]> = [
  ["B + provider opencode-go + Go model", { mode: "B", runtime: "pes_builtin", provider: "opencode-go", model: GO_MODEL }],
  ["B + provider opencode-go + plain model", { mode: "B", runtime: "synthetic-runtime", provider: "opencode-go", model: "synthetic-model" }],
  ["B + other provider + opencode-go/ model", { mode: "B", runtime: "synthetic-runtime", provider: "synthetic", model: GO_MODEL }],
];

// ---------------------------------------------------------------------------
// 1) API: external_agent token

test("SEL-68 API: an external_agent token cannot claim mode A (Go provider) — 403 forbidden, nothing written (Go ON)", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "ext");
    const before = claim_sig(env.db);
    const full = state_signature(env.db);
    for (const [label, body] of MODE_A_BODIES) {
      assert_refused(await claim(env, { token: agent.token }, body), label);
      assert.equal(claim_sig(env.db), before, `${label}: no run, lease, receipt, event or counter`);
    }
    assert.equal(runs_n(env), 0);
    assert.equal(leases_n(env), 0);
    assert.equal(state_signature(env.db), full, "the whole database is as before");
  });
});

test("SEL-68 API: the refusal does not depend on Go policy — with Go OFF an external mode A claim is still 403 and writes nothing", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "ext-off");
    await go_off(env);
    const before = claim_sig(env.db);
    for (const [label, body] of MODE_A_BODIES) {
      const res = await claim(env, { token: agent.token }, body);
      assert.equal(res.status, 403, `${label}: ${JSON.stringify(res.json)}`);
      assert.equal(claim_sig(env.db), before, label);
    }
  });
});

test("SEL-68 API: an external_agent token cannot claim with a Go-labelled provider/model even as mode B (해석 2)", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "ext-golabel");
    const before = claim_sig(env.db);
    for (const [label, body] of GO_LABELLED_B_BODIES) {
      assert_refused(await claim(env, { token: agent.token }, body), label);
      assert.equal(claim_sig(env.db), before, label);
    }
    assert.equal(runs_n(env), 0);
  });
});

test("SEL-68 API: a claim without a mode, or with a bad mode, stays 400 invalid_payload and writes nothing (해석 3)", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "ext-nomode");
    const before = claim_sig(env.db);
    const bodies: Array<Record<string, unknown>> = [
      { runtime: "pes_builtin", provider: "opencode-go", model: GO_MODEL },
      { mode: "a", runtime: "pes_builtin", provider: "opencode-go", model: GO_MODEL },
      { mode: "C", runtime: "pes_builtin", provider: "opencode-go", model: GO_MODEL },
      { mode: null, runtime: "pes_builtin", provider: "opencode-go", model: GO_MODEL },
      { mode: ["A"], runtime: "pes_builtin", provider: "opencode-go", model: GO_MODEL },
    ];
    for (const body of bodies) {
      const res = await claim(env, { token: agent.token }, body);
      assert.ok(res.status === 400 || res.status === 403, `${JSON.stringify(body)}: ${res.status}`);
      assert.equal(claim_sig(env.db), before, JSON.stringify(body));
    }
    // plain missing mode is the validation error it is today
    assert_error(await claim(env, { token: agent.token }, { runtime: "pes_builtin", provider: "opencode-go", model: GO_MODEL }), 400, "invalid_payload");
  });
});

// ---------------------------------------------------------------------------
// 2) API: the human owner session

test("SEL-68 API: the owner's human session cannot claim mode A either — 403 forbidden, nothing written", async () => {
  await with_api(async (env) => {
    const before = claim_sig(env.db);
    for (const [label, body] of MODE_A_BODIES) {
      assert_refused(await claim(env, "owner", body), `owner ${label}`);
      assert.equal(claim_sig(env.db), before, `owner ${label}`);
    }
    for (const [label, body] of GO_LABELLED_B_BODIES) {
      assert_refused(await claim(env, "owner", body), `owner ${label}`);
      assert.equal(claim_sig(env.db), before, `owner ${label}`);
    }
    assert.equal(runs_n(env), 0);
  });
});

test("SEL-68 API: the owner's human session and an external agent still claim mode B normally (regression)", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "ext-b");
    const body = { mode: "B", runtime: "codex_cli", provider: "openai", model: "unknown" };
    const data = assert_ok(await claim(env, { token: agent.token }, body));
    assert.equal(typeof data.run_id, "string");
    assert.equal(data.mode ?? "B", "B");
    const row = env.db.get<{ mode: string; actor_id: string; provider: string }>("SELECT mode, actor_id, provider FROM runs WHERE id = ?", data.run_id);
    assert.deepEqual({ ...row }, { mode: "B", actor_id: agent.actor_id, provider: "openai" });
    assert.equal(mode_a_runs_n(env), 0);
  });
  await with_api(async (env) => {
    const owner = await claim(env, "owner", { mode: "B", runtime: "claude_app", provider: "anthropic", model: "unknown" });
    assert_ok(owner);
  });
});

// ---------------------------------------------------------------------------
// 3) idempotent replay of a refused request (해석 4)

test("SEL-68 API: the same Idempotency-Key sent again after a refusal is refused again and creates no run", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "ext-replay");
    const body = MODE_A_BODIES[0]![1];
    const before = claim_sig(env.db);
    for (let i = 0; i < 3; i++) {
      assert_refused(await claim(env, { token: agent.token }, body, "sel68-replay-key"), `try ${i}`);
      assert.equal(claim_sig(env.db), before, `try ${i}`);
    }
    // the refused key is not poisoned into a success either: a different (valid B) body under a fresh key works
    assert_ok(await claim(env, { token: agent.token }, { mode: "B", runtime: "codex_cli", provider: "openai", model: "unknown" }, "sel68-fresh-key"));
    assert.equal(mode_a_runs_n(env), 0);
  });
});

test("SEL-68 API: an internal_ai success stored under a key is not replayed to an external token that reuses the key", async () => {
  await with_api(async (env) => {
    const internal = await make_agent(env, "int-key", undefined, "internal_ai");
    const external = await make_agent(env, "ext-key");
    const body = MODE_A_BODIES[0]![1];
    const ok = assert_ok(await claim(env, { token: internal.token }, body, "sel68-shared-key"));
    const rows = runs_n(env);
    const res = await claim(env, { token: external.token }, body, "sel68-shared-key");
    assert.ok(res.status >= 400, `the external caller must not get the internal run back: ${res.status} ${JSON.stringify(res.json)}`);
    assert.doesNotMatch(JSON.stringify(res.json), new RegExp(String(ok.lease_id)), "no lease of the internal run leaks");
    assert.equal(runs_n(env), rows, "no second run");
  });
});

// ---------------------------------------------------------------------------
// 4) policy for internal_ai (regression — passes today)

test("SEL-68 API: internal_ai + Go OFF -> 403 policy_blocked, nothing written (regression)", async () => {
  await with_api(async (env) => {
    const internal = await make_agent(env, "int-off", undefined, "internal_ai");
    await go_off(env);
    const before = claim_sig(env.db);
    for (const [label, body] of MODE_A_BODIES.slice(0, 2)) {
      assert_error(await claim(env, { token: internal.token }, body), 403, "policy_blocked");
      assert.equal(claim_sig(env.db), before, label);
    }
  });
});

test("SEL-68 API: internal_ai + Go ON claims mode A: 200, one A run owned by the internal actor, one lease (regression)", async () => {
  await with_api(async (env) => {
    const internal = await make_agent(env, "int-on", undefined, "internal_ai");
    const data = assert_ok(await claim(env, { token: internal.token }, MODE_A_BODIES[0]![1]));
    const row = env.db.get<{ mode: string; provider: string; actor_id: string }>("SELECT mode, provider, actor_id FROM runs WHERE id = ?", data.run_id);
    assert.deepEqual({ ...row }, { mode: "A", provider: "opencode-go", actor_id: internal.actor_id });
    assert.equal(leases_n(env), 1);
    assert.equal(mode_a_runs_n(env), 1);
  });
});

test("SEL-68 API: an internal_ai caller still cannot send a non-Go provider as mode A (400 invalid_payload, regression)", async () => {
  await with_api(async (env) => {
    const internal = await make_agent(env, "int-bad", undefined, "internal_ai");
    const before = claim_sig(env.db);
    assert_error(await claim(env, { token: internal.token }, { mode: "A", runtime: "pes_builtin", provider: "openai", model: "x" }), 400, "invalid_payload");
    assert_error(await claim(env, { token: internal.token }, { mode: "A", runtime: "pes_builtin", provider: "opencode-go", model: "plain-model" }), 400, "invalid_payload");
    assert.equal(claim_sig(env.db), before);
  });
});

// ---------------------------------------------------------------------------
// 5) A runs never belong to a non-internal actor (해석 5, 해석 6)

test("SEL-68 API: the owner cannot hand a mode A run to an external agent, and the agent cannot claim one by run_id (해석 5, NEW)", async () => {
  await with_api(async (env) => {
    const external = await make_agent(env, "ext-assigned");
    const create = await call(env, {
      method: "POST",
      path: P(env, "/runs"),
      auth: "owner",
      body: { actor_id: external.actor_id, mode: "A", runtime: "synthetic-runtime", provider: "opencode-go", model: "opencode-go/synthetic" },
    });
    if (create.status >= 400) {
      assert.ok(create.status === 400 || create.status === 403 || create.status === 422, `${create.status} ${JSON.stringify(create.json)}`);
      assert.equal(mode_a_runs_n(env), 0, "nothing was created");
      return;
    }
    const run_id = assert_ok(create, 201).run_id as string;
    const before = claim_sig(env.db);
    const res = await claim(env, { token: external.token }, { run_id });
    assert.ok(res.status >= 400, `an external agent must not take a mode A run by run_id: ${res.status} ${JSON.stringify(res.json)}`);
    assert.equal(claim_sig(env.db), before, "no lease");
    assert.equal(leases_n(env), 0);
  });
});

test("SEL-68 API: an external agent cannot continue an internal_ai mode A run with its guard (해석 6, regression)", async () => {
  await with_api(async (env) => {
    const internal = await make_agent(env, "int-held", undefined, "internal_ai");
    const external = await make_agent(env, "ext-thief");
    const held = assert_ok(await claim(env, { token: internal.token }, MODE_A_BODIES[0]![1]));
    const guard = { lease_id: held.lease_id, fence: held.fence };
    const before = claim_sig(env.db);
    const attempts: Array<[string, string, string, Record<string, unknown>]> = [
      ["heartbeat", "POST", `/runs/${held.run_id}/heartbeat`, guard],
      ["wait", "POST", `/runs/${held.run_id}/wait`, guard],
      ["results", "POST", `/runs/${held.run_id}/results`, { ...guard, results: [] }],
      ["complete", "POST", `/runs/${held.run_id}/complete`, { ...guard, status: "succeeded" }],
      ["release", "POST", `/runs/${held.run_id}/release`, guard],
      ["claim by run_id", "POST", "/claims", { run_id: held.run_id }],
    ];
    for (const [label, method, rest, body] of attempts) {
      const res = await call(env, { method, path: P(env, rest), auth: { token: external.token }, body });
      assert.ok(res.status >= 400, `${label}: ${res.status} ${JSON.stringify(res.json)}`);
      assert.equal(claim_sig(env.db), before, `${label}: nothing changed`);
    }
    // the inputs reader refuses it too
    const inputs = await call(env, { method: "GET", path: P(env, `/runs/${held.run_id}/inputs`), auth: { token: external.token } });
    assert.ok(inputs.status >= 400, `inputs: ${inputs.status}`);
    assert.equal(claim_sig(env.db), before);
  });
});

// ---------------------------------------------------------------------------
// 6) MCP pes_claim (해석 7)

function mcp_client(env: ApiEnv, agent: Agent, defaults: Record<string, unknown>): FakeMcpClient {
  return new FakeMcpClient(new McpServer({ api: env.app, project_id: env.p.project_id, token: agent.token, claim_defaults: defaults as any }));
}

test("SEL-68 MCP: pes_claim with a Go-labelled connection default is refused for an external token, nothing written", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "mcp-go");
    const before = claim_sig(env.db);
    for (const defaults of [
      { runtime: "pes_builtin", provider: "opencode-go", model: GO_MODEL },
      { runtime: "codex_cli", provider: "opencode-go", model: "unknown" },
      { runtime: "codex_cli", provider: "openai", model: GO_MODEL },
    ]) {
      const client = mcp_client(env, agent, defaults);
      try {
        await client.initialize();
        const out = await client.tool("pes_claim", { idempotency_key: "sel68-mcp-1" });
        assert.equal(out.is_error, true, `pes_claim must be refused: ${JSON.stringify(out.data)}`);
        assert.equal(out.data.error.code, "forbidden", JSON.stringify(out.data));
        assert.equal(claim_sig(env.db), before, JSON.stringify(defaults));
        // the same key again: refused again, still no run
        const again = await client.tool("pes_claim", { idempotency_key: "sel68-mcp-1" });
        assert.equal(again.is_error, true);
        assert.equal(claim_sig(env.db), before);
      } finally {
        await client.close();
      }
    }
    assert.equal(runs_n(env), 0);
  });
});

test("SEL-68 MCP: pes_claim arguments cannot select mode A, and a forged mode in the claim defaults makes no mode A run", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "mcp-forge");
    const forged = { mode: "A", runtime: "pes_builtin", provider: "opencode-go", model: GO_MODEL };
    const client = mcp_client(env, agent, forged);
    try {
      await client.initialize();
      const before = claim_sig(env.db);
      for (const args of [
        { idempotency_key: "sel68-forge-0" },
        { idempotency_key: "sel68-forge-1", mode: "A", provider: "opencode-go", model: GO_MODEL, runtime: "pes_builtin" },
      ]) {
        const out = await client.tool("pes_claim", args);
        assert.equal(out.is_error, true, JSON.stringify(out.data));
        assert.equal(claim_sig(env.db), before);
      }
      assert.equal(mode_a_runs_n(env), 0);
    } finally {
      await client.close();
    }
  });
});

test("SEL-68 MCP: an external token's normal B claim (codex_cli / opencode_tui / claude_code defaults) is still 200 (regression)", async () => {
  await with_api(async (env) => {
    for (const [name, defaults] of [
      ["mcp-codex", { runtime: "codex_cli", provider: "openai", model: "unknown" }],
      ["mcp-oc", { runtime: "opencode_tui", provider: "unknown", model: "unknown" }],
      ["mcp-claude", { runtime: "claude_code", provider: "anthropic", model: "synthetic-model" }],
    ] as const) {
      const agent = await make_agent(env, name);
      const client = mcp_client(env, agent, defaults);
      try {
        await client.initialize();
        const claimed = await client.ok("pes_claim", { idempotency_key: `${name}-claim` });
        const row = env.db.get<{ mode: string; actor_id: string; runtime: string }>("SELECT mode, actor_id, runtime FROM runs WHERE id = ?", claimed.run_id);
        assert.deepEqual({ ...row }, { mode: "B", actor_id: agent.actor_id, runtime: defaults.runtime });
        await client.ok("pes_complete", { status: "succeeded", idempotency_key: `${name}-done` });
      } finally {
        await client.close();
      }
    }
    assert.equal(mode_a_runs_n(env), 0);
  });
});

// ---------------------------------------------------------------------------
// 7) CLI `pes.py claim` (해석 7). Runs the CLI in an isolated HOME/PES_HOME (helper), never the real ones.

test("SEL-68 CLI: `claim --mode A --provider opencode-go` is refused for an external token and for the human owner, nothing written", async () => {
  await with_cli(async (c) => {
    const agent = await c.agent("cli-ext");
    const flags = (mode: string, provider: string, model: string) => ["--mode", mode, "--runtime", "pes_builtin", "--provider", provider, "--model", model];
    const cases: Array<[string, string[], Record<string, string | undefined>]> = [
      ["token A", flags("A", "opencode-go", GO_MODEL), { PES_TOKEN: agent.token }],
      ["token B + Go label (해석 2)", flags("B", "opencode-go", GO_MODEL), { PES_TOKEN: agent.token }],
      ["owner A", flags("A", "opencode-go", GO_MODEL), {}],
      ["owner B + Go label (해석 2)", flags("B", "opencode-go", GO_MODEL), {}],
    ];
    const before = claim_sig(c.env.db);
    const commits = c.commits().length;
    for (const [label, args, extra] of cases) {
      const res = c.run(["claim", SLUG, ...args], extra);
      expect_rejected(res, label);
      assert.equal(claim_sig(c.env.db), before, `${label}: no run, lease, receipt, event`);
      assert.equal(c.commits().length, commits, `${label}: no commit`);
      assert.equal(count(c.env.db, "SELECT COUNT(*) AS n FROM runs WHERE mode = 'A'"), 0, label);
    }
  });
});

test("SEL-68 CLI: a normal `claim` (mode B default) by an external token still works (regression)", async () => {
  await with_cli(async (c) => {
    const agent = await c.agent("cli-ok");
    const claimed = json_out(c.run(["claim", SLUG], { PES_TOKEN: agent.token }));
    assert.match(String(claimed.fence), /^[1-9][0-9]*$/);
    const row = c.env.db.get<{ mode: string; actor_id: string }>("SELECT mode, actor_id FROM runs WHERE id = ?", claimed.run_id);
    assert.deepEqual({ ...row }, { mode: "B", actor_id: agent.actor_id });
  });
});
