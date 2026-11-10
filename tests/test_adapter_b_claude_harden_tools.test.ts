/**
 * SEL-53 PR20a — 보강: forged tool arguments and calls that must not write (tester, 보강 모드).
 *
 * The MCP server only forwards; PES decides. These tests try to make it forward something PES must refuse and then check
 * the DATABASE (the whole state signature, not only the answer): a refusal leaves nothing behind.
 *
 *  - run_id / lease_id / fence of another project, of another agent, a lowered or raised fence, malformed fences
 *  - the remembered guard is never borrowed for another run
 *  - a call without an idempotency_key writes nothing even when a lease is held (server-side rows, receipts, events)
 *  - a refused call does not "use up" its key; one key is never shared between two tools
 *  - pes_cancel of someone else's run, pes_receipt evidence, pes_submit with forged item fields
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { McpServer } from "../scripts/pes_core/mcp_server.ts";
import { assert_ok, bump_control_rev, call, make_agent, owner_creates_run } from "./helpers/api_env.ts";
import { P } from "./helpers/api_flow.ts";
import { FakeMcpClient, ask_args, owner_answers, type AdapterEnv } from "./helpers/adapter_b_env.ts";
import { claim_fresh, events_of_type, with_cleanup } from "./helpers/adapter_b_flow.ts";
import { register_second } from "./helpers/adapter_b_harden.ts";
import { state_signature, table_counts } from "./helpers/state_signature.ts";

const REFUSED_FOR_SCOPE = ["not_found", "forbidden", "lease_lost", "conflict", "unauthenticated", "invalid_payload", "claim_required"];

type Guard = { run_id: string; lease_id: string; fence: string | number };

/** One call for each lease-bound tool, with the guard spelled out. `cancel` is separate (it takes a run only). */
function guarded_calls(env: AdapterEnv, guard: Guard | Record<string, unknown>, tag: string): Array<[string, Record<string, unknown>]> {
  return [
    ["pes_submit", { ...guard, results: [{ op: "append_version", object_id: env.object_id, title: `위조 ${tag}` }], idempotency_key: `f-submit-${tag}` }],
    ["pes_ask", { ...guard, ...ask_args(env, `f-${tag}`), idempotency_key: `f-ask-${tag}` }],
    ["pes_wait", { ...guard, idempotency_key: `f-wait-${tag}` }],
    ["pes_complete", { ...guard, status: "succeeded", idempotency_key: `f-complete-${tag}` }],
    ["pes_heartbeat", { ...guard, progress: { phase: "started" }, idempotency_key: `f-hb-${tag}` }],
    ["pes_release", { ...guard, idempotency_key: `f-release-${tag}` }],
    ["pes_receipt", { ...guard, receipts: [{ input_version_id: "forged-input", state: "seen" }], idempotency_key: `f-receipt-${tag}` }],
  ];
}

async function every_refused(client: FakeMcpClient, calls: Array<[string, Record<string, unknown>]>, codes: string[] = REFUSED_FOR_SCOPE): Promise<void> {
  for (const [tool, args] of calls) {
    const out = await client.tool(tool, args);
    assert.equal(out.is_error, true, `${tool} must be refused: ${JSON.stringify(out.data).slice(0, 200)}`);
    assert.ok(codes.includes(out.data.error.code), `${tool}: ${out.data.error.code} is not one of ${codes.join("|")}`);
    assert.notEqual(out.data.error.code, "internal_error", tool);
  }
}

async function second_connection(env: AdapterEnv, open: <T extends FakeMcpClient>(c: T) => T, b: Awaited<ReturnType<typeof register_second>>): Promise<FakeMcpClient> {
  const server = new McpServer({
    api: env.app,
    project_id: b.project_id,
    token: b.token,
    claim_defaults: { runtime: "claude_code", provider: "anthropic", model: "synthetic-model" },
  });
  const client = open(new FakeMcpClient(server));
  await client.initialize();
  return client;
}

test("a run, lease and fence of ANOTHER project are refused by every lease-bound tool and change nothing", async () => {
  await with_cleanup(async (env, open) => {
    const b = await register_second(env);
    const b_client = await second_connection(env, open, b);
    const b_guard = await claim_fresh(b_client);
    const a_client = open(await env.client());

    const sig = state_signature(env.db);
    await every_refused(a_client, guarded_calls(env, b_guard, "xproject"), ["not_found", "forbidden", "lease_lost", "conflict"]);
    const cancel = await a_client.tool("pes_cancel", { run_id: b_guard.run_id, confirm: true, idempotency_key: "f-cancel-x" });
    assert.equal(cancel.is_error, true);
    assert.ok(["not_found", "forbidden"].includes(cancel.data.error.code), cancel.data.error.code);
    const claim = await a_client.fails("pes_claim", { run_id: b_guard.run_id, idempotency_key: "f-claim-x" }, "not_found");
    assert.equal(claim.retryable, false);
    assert.equal(state_signature(env.db), sig, "nothing in either project moved");

    // B's lease is untouched: B still works with its own guard
    const beat = await b_client.ok("pes_heartbeat", { idempotency_key: "b-own-hb" });
    assert.equal(beat.lease.lease_id, b_guard.lease_id);
    assert.equal(beat.lease.fence, b_guard.fence);

    // and A's context never shows B
    const wire = JSON.stringify(await a_client.ok("pes_context", {}));
    for (const foreign of [b.project_id, b.object_id, b.version_id, b_guard.run_id]) assert.ok(!wire.includes(foreign), "no foreign id in A's context");
  });
});

test("a token of one project against the other project's path is unauthenticated for all ten tools, with or without a guard", async () => {
  await with_cleanup(async (env, open) => {
    const b = await register_second(env, "synthetic-token-swap");
    const a_guard_client = open(await env.client());
    const a_guard = await claim_fresh(a_guard_client);
    const sig = state_signature(env.db);

    const a_token_on_b = new McpServer({ api: env.app, project_id: b.project_id, token: env.agent.token });
    const b_token_on_a = new McpServer({ api: env.app, project_id: env.p.project_id, token: b.token });
    for (const server of [a_token_on_b, b_token_on_a]) {
      const client = open(new FakeMcpClient(server));
      await client.initialize();
      const calls: Array<[string, Record<string, unknown>]> = [
        ["pes_context", {}],
        ["pes_claim", { idempotency_key: "swap-claim" }],
        ["pes_claim", { run_id: a_guard.run_id, idempotency_key: "swap-claim-run" }],
        ...guarded_calls(env, a_guard, "swap"),
        ...guarded_calls(env, {}, "swap-noguard"),
        ["pes_cancel", { run_id: a_guard.run_id, confirm: true, idempotency_key: "swap-cancel" }],
        ["pes_cancel", { confirm: true, idempotency_key: "swap-cancel-2" }],
      ];
      for (const [tool, args] of calls) {
        const out = await client.tool(tool, args);
        assert.equal(out.is_error, true, tool);
        assert.equal(out.data.error.code, "unauthenticated", `${tool}: ${out.data.error.code}`);
      }
    }
    assert.equal(state_signature(env.db), sig);
    assert.equal((await a_guard_client.ok("pes_heartbeat", { idempotency_key: "swap-own" })).lease.lease_id, a_guard.lease_id);
  });
});

test("another agent of the same project cannot use, take over or burn the lease holder's guard", async () => {
  await with_cleanup(async (env, open) => {
    const second = await make_agent(env, "second");
    const one = open(await env.client());
    const two = open(new FakeMcpClient(env.server(second.token)));
    await two.initialize();
    const g1 = await claim_fresh(one);

    let sig = state_signature(env.db);
    // agent two spells out agent one's whole guard
    await every_refused(two, guarded_calls(env, g1, "stolen"), ["forbidden", "lease_lost", "conflict", "not_found"]);
    const cancel = await two.fails("pes_cancel", { run_id: g1.run_id, confirm: true, idempotency_key: "steal-cancel" }, "forbidden");
    assert.equal(cancel.next_action, "use_owner_session");
    await two.fails("pes_claim", { idempotency_key: "steal-claim" }, "conflict");
    const steal = await two.tool("pes_claim", { run_id: g1.run_id, idempotency_key: "steal-claim-run" });
    assert.equal(steal.is_error, true);
    assert.ok(["forbidden", "conflict"].includes(steal.data.error.code), steal.data.error.code);
    assert.equal(state_signature(env.db), sig, "the holder's lease and run are untouched");
    assert.equal((await one.ok("pes_heartbeat", { idempotency_key: "own-hb-1" })).lease.fence, g1.fence);

    // agent one lets go; agent two takes the project lease
    await one.ok("pes_release", { idempotency_key: "own-release" });
    const g2 = await claim_fresh(two);
    assert.notEqual(g2.lease_id, g1.lease_id);
    assert.ok(BigInt(g2.fence) > BigInt(g1.fence), "the fence only goes up");

    sig = state_signature(env.db);
    const lowered = String(BigInt(g2.fence) - 1n);
    const raised = String(BigInt(g2.fence) + 1n);
    const mixes: Array<[string, Record<string, unknown>]> = [
      ["old guard", { run_id: g1.run_id, lease_id: g1.lease_id, fence: g1.fence }],
      ["right run, old lease", { run_id: g2.run_id, lease_id: g1.lease_id, fence: g2.fence }],
      ["old run, right lease", { run_id: g1.run_id, lease_id: g2.lease_id, fence: g2.fence }],
      ["lowered fence", { run_id: g2.run_id, lease_id: g2.lease_id, fence: lowered }],
      ["raised fence", { run_id: g2.run_id, lease_id: g2.lease_id, fence: raised }],
      ["fence zero", { run_id: g2.run_id, lease_id: g2.lease_id, fence: "0" }],
      ["fence as number, raised", { run_id: g2.run_id, lease_id: g2.lease_id, fence: Number(raised) }],
      ["huge fence", { run_id: g2.run_id, lease_id: g2.lease_id, fence: "99999999999999999999999999" }],
    ];
    for (const [name, guard] of mixes) {
      // the stale connection AND the live one both try it, with the two tools that matter most
      for (const [who, client] of [["one", one], ["two", two]] as const) {
        for (const [tool, args] of guarded_calls(env, guard, `${name}-${who}`).filter(([t]) => t === "pes_complete" || t === "pes_heartbeat" || t === "pes_submit")) {
          const out = await client.tool(tool, args);
          assert.equal(out.is_error, true, `${name} via ${who}/${tool} must be refused`);
          assert.ok(["lease_lost", "conflict", "not_found", "forbidden", "invalid_payload"].includes(out.data.error.code), `${name}: ${out.data.error.code}`);
        }
      }
    }
    assert.equal(state_signature(env.db), sig, "forged guards left no row and burned no fence");
    // the real holder still works with the real guard
    const beat = await two.ok("pes_heartbeat", { idempotency_key: "own-hb-2" });
    assert.equal(beat.lease.fence, g2.fence);
    assert.equal(beat.lease.lease_id, g2.lease_id);
  });
});

test("malformed fences, run ids and lease ids never reach a write", async () => {
  await with_cleanup(async (env, open) => {
    const client = open(await env.client());
    const g = await claim_fresh(client);
    const sig = state_signature(env.db);
    let n = 0;
    const fences: unknown[] = [-1, 1.5, "01", "1e0", " 1", "1 ", "", "-1", "९", "0x1", null, true, [], {}, 2 ** 53, Number.MAX_VALUE];
    for (const fence of fences) {
      const out = await client.tool("pes_complete", { run_id: g.run_id, lease_id: g.lease_id, fence, status: "succeeded", idempotency_key: `bad-fence-${n++}` });
      assert.equal(out.is_error, true, `fence ${JSON.stringify(fence)}`);
      assert.ok(["invalid_payload", "lease_lost", "conflict"].includes(out.data.error.code), `${JSON.stringify(fence)} -> ${out.data.error.code}`);
    }
    for (const run_id of ["", 0, null, true, [], {}, g.run_id.toUpperCase(), `${g.run_id} `, `${g.run_id}/../x`, "\u0000"]) {
      const out = await client.tool("pes_complete", { run_id, lease_id: g.lease_id, fence: g.fence, status: "succeeded", idempotency_key: `bad-run-${n++}` });
      assert.equal(out.is_error, true, `run_id ${JSON.stringify(run_id)}`);
    }
    for (const lease_id of ["", 0, null, [], {}, g.lease_id.toUpperCase(), `${g.lease_id}\n`, "\ud800"]) {
      const out = await client.tool("pes_complete", { run_id: g.run_id, lease_id, fence: g.fence, status: "succeeded", idempotency_key: `bad-lease-${n++}` });
      assert.equal(out.is_error, true, `lease_id ${JSON.stringify(lease_id)}`);
    }
    assert.equal(state_signature(env.db), sig);
    assert.equal(env.db.get<{ status: string }>("SELECT status FROM runs WHERE id = ?", g.run_id)?.status, "running");
  });
});

test("the remembered guard is never borrowed for another run, and a lone lease_id does not pass", async () => {
  await with_cleanup(async (env, open) => {
    const second = await make_agent(env, "second");
    const other_run = await owner_creates_run(env, second);
    const client = open(await env.client());
    const g = await claim_fresh(client);
    const sig = state_signature(env.db);

    for (const run_id of [other_run, "no-such-run-id"]) {
      for (const [tool, args] of guarded_calls(env, { run_id }, `borrow-${run_id.slice(0, 4)}`)) {
        const out = await client.tool(tool, args);
        assert.equal(out.is_error, true, `${tool} on ${run_id}`);
        assert.ok(["claim_required", "not_found", "forbidden"].includes(out.data.error.code), `${tool}: ${out.data.error.code}`);
      }
    }
    // only a lease id, from nowhere: the remembered fence does not make it valid
    for (const [tool, args] of guarded_calls(env, { lease_id: "forged-lease" }, "lone-lease")) {
      const out = await client.tool(tool, args);
      assert.equal(out.is_error, true, tool);
      // a receipt's input is looked at before its lease
      assert.ok(["lease_lost", "conflict", "input_not_visible"].includes(out.data.error.code), `${tool}: ${out.data.error.code}`);
    }
    assert.equal(state_signature(env.db), sig);
    assert.equal(env.db.get<{ status: string }>("SELECT status FROM runs WHERE id = ?", other_run)?.status, "queued", "the other agent's run was not touched");
    assert.equal((await client.ok("pes_heartbeat", { idempotency_key: "borrow-ok" })).lease.lease_id, g.lease_id);
  });
});

test("a call without idempotency_key writes nothing, even with a lease held; the run keeps running", async () => {
  await with_cleanup(async (env, open) => {
    const client = open(await env.client());
    const g = await claim_fresh(client);
    const counts = () => ({ ...table_counts(env.db) });
    const before_sig = state_signature(env.db);
    const before_counts = counts();
    const keyless: Array<[string, Record<string, unknown>]> = [
      ["pes_claim", {}],
      ["pes_claim", { run_id: g.run_id }],
      ["pes_submit", { results: [{ op: "append_version", object_id: env.object_id, title: "키 없음" }] }],
      ["pes_ask", { ...ask_args(env, "nokey2"), idempotency_key: undefined }],
      ["pes_wait", {}],
      ["pes_complete", { status: "succeeded" }],
      ["pes_heartbeat", { progress: { phase: "completed" } }],
      ["pes_release", {}],
      ["pes_cancel", { confirm: true }],
      ["pes_cancel", { run_id: g.run_id, confirm: true }],
      ["pes_receipt", { receipts: [{ input_version_id: "x", state: "seen" }] }],
      // the same, with the guard spelled out
      ["pes_complete", { run_id: g.run_id, lease_id: g.lease_id, fence: g.fence, status: "failed" }],
      ["pes_release", { run_id: g.run_id, lease_id: g.lease_id, fence: g.fence }],
      ["pes_wait", { run_id: g.run_id, lease_id: g.lease_id, fence: g.fence }],
      // wrong-typed or empty keys count as no key
      ["pes_complete", { status: "succeeded", idempotency_key: "" }],
      ["pes_complete", { status: "succeeded", idempotency_key: null }],
      ["pes_complete", { status: "succeeded", idempotency_key: ["k"] }],
      ["pes_complete", { status: "succeeded", idempotency_key: "\ud800" }],
      ["pes_complete", { status: "succeeded", idempotency_key: "k".repeat(201) }],
    ];
    for (const [tool, args] of keyless) {
      const out = await client.tool(tool, args);
      assert.equal(out.is_error, true, `${tool} ${JSON.stringify(args).slice(0, 80)}`);
      assert.equal(out.data.error.code, "invalid_payload", `${tool}: ${out.data.error.code}`);
      assert.equal(out.data.error.target, "$.arguments.idempotency_key");
    }
    assert.equal(state_signature(env.db), before_sig, "every table, row for row, is as it was");
    assert.deepEqual(counts(), before_counts, "no receipt (mutation_commits), no event, no run, no lease row");
    assert.equal(events_of_type(env, "run.completed").length, 0);
    assert.equal(env.db.get<{ status: string }>("SELECT status FROM runs WHERE id = ?", g.run_id)?.status, "running");
    // the lease is still ours and a keyed call works
    assert.equal((await client.ok("pes_heartbeat", { idempotency_key: "keyed" })).lease.lease_id, g.lease_id);
    // a key of exactly 200 characters is a key
    assert.equal((await client.ok("pes_heartbeat", { idempotency_key: "k".repeat(200) })).lease.lease_id, g.lease_id);
  });
});

test("a keyless claim of a waiting or queued run does not claim it; credential refusals still come first", async () => {
  await with_cleanup(async (env, open) => {
    const queued = await owner_creates_run(env, env.agent);
    const client = open(await env.client());
    const sig = state_signature(env.db);
    const code = await client.fails("pes_claim", { run_id: queued }, "invalid_payload");
    assert.equal(code.target, "$.arguments.idempotency_key");
    await client.fails("pes_claim", {}, "invalid_payload");
    assert.equal(env.db.get<{ status: string }>("SELECT status FROM runs WHERE id = ?", queued)?.status, "queued");
    assert.equal(table_counts(env.db).project_leases, 0n);
    assert.equal(state_signature(env.db), sig);

    // a wrong token: the credential answer comes first for each of them, and nothing is written either
    const bad = open(new FakeMcpClient(env.server("synthetic-wrong-token")));
    await bad.initialize();
    for (const [tool, args] of [
      ["pes_claim", {}],
      ["pes_claim", { run_id: queued }],
      ["pes_submit", { results: [] }],
      ["pes_complete", {}],
      ["pes_cancel", { confirm: true }],
      ["pes_receipt", { receipts: [{ input_version_id: "x", state: "seen" }] }],
    ] as Array<[string, Record<string, unknown>]>) {
      await bad.fails(tool, args, "unauthenticated");
    }
    // a token without scopes: forbidden first, for the tools that need a scope
    const narrow = await make_agent(env, "narrow", ["context:read"]);
    const narrow_client = open(new FakeMcpClient(env.server(narrow.token)));
    await narrow_client.initialize();
    for (const [tool, args] of [
      ["pes_claim", {}],
      ["pes_submit", { results: [] }],
      ["pes_wait", {}],
      ["pes_complete", {}],
      ["pes_heartbeat", {}],
      ["pes_release", {}],
      ["pes_receipt", { receipts: [{ input_version_id: "x", state: "seen" }] }],
    ] as Array<[string, Record<string, unknown>]>) {
      await narrow_client.fails(tool, args, "forbidden");
    }
    assert.equal(env.db.get<{ status: string }>("SELECT status FROM runs WHERE id = ?", queued)?.status, "queued");
  });
});

test("a refused call does not use up its key: the same key works once the refusal's cause is gone", async () => {
  await with_cleanup(async (env, open) => {
    const client = open(await env.client());
    // refused first for lack of a claim ...
    await client.fails("pes_submit", { results: [{ op: "append_version", object_id: env.object_id, title: "재시도" }], idempotency_key: "retry-key" }, "claim_required");
    await client.fails("pes_heartbeat", { idempotency_key: "retry-hb" }, "claim_required");
    const g = await claim_fresh(client);
    // ... then the very same keys are accepted as new requests, not replays and not reuse
    const submitted = await client.ok("pes_submit", { results: [{ op: "append_version", object_id: env.object_id, title: "재시도" }], idempotency_key: "retry-key" });
    assert.notEqual(submitted.replayed, true);
    const beat = await client.ok("pes_heartbeat", { idempotency_key: "retry-hb" });
    assert.notEqual(beat.replayed, true);
    assert.equal(beat.lease.lease_id, g.lease_id);
    // an invalid_payload refusal from the tool itself does not use the key up either
    await client.fails("pes_heartbeat", { progress: { phase: "nope" }, idempotency_key: "retry-hb-2" }, "invalid_payload");
    assert.equal((await client.ok("pes_heartbeat", { progress: { phase: "stage" }, idempotency_key: "retry-hb-2" })).progress.phase, "stage");
  });
});

test("one key is never shared between two tools: the second tool is refused and does nothing", async () => {
  await with_cleanup(async (env, open) => {
    const client = open(await env.client());
    const g = await claim_fresh(client);
    await client.ok("pes_heartbeat", { idempotency_key: "shared" });
    const sig = state_signature(env.db);
    // identical bodies ({lease_id, fence}) on other routes: they must not be answered with the heartbeat's answer
    for (const [tool, args] of [
      ["pes_release", {}],
      ["pes_wait", {}],
      ["pes_complete", {}],
      ["pes_complete", { status: "failed" }],
      ["pes_cancel", { confirm: true, run_id: g.run_id }],
    ] as Array<[string, Record<string, unknown>]>) {
      const out = await client.tool(tool, { ...args, idempotency_key: "shared" });
      assert.equal(out.is_error, true, `${tool} with a key already used by pes_heartbeat`);
      assert.equal(out.data.error.code, "idempotency_key_reuse", tool);
    }
    assert.equal(state_signature(env.db), sig);
    assert.equal(env.db.get<{ status: string }>("SELECT status FROM runs WHERE id = ?", g.run_id)?.status, "running", "no tool ran under the heartbeat's key");
    // and a claim key is not a submit key
    await client.fails("pes_claim", { run_id: g.run_id, idempotency_key: "shared" }, "idempotency_key_reuse");
  });
});

test("pes_cancel: someone else's run is refused; confirm must be exactly true; the own run ends and the lease is forgotten", async () => {
  await with_cleanup(async (env, open) => {
    const second = await make_agent(env, "second");
    const theirs = await owner_creates_run(env, second);
    const client = open(await env.client());
    const g = await claim_fresh(client);
    const sig = state_signature(env.db);
    await client.fails("pes_cancel", { run_id: theirs, confirm: true, idempotency_key: "c-theirs" }, "forbidden");
    for (const confirm of [false, "true", 1, null, "yes", [true], {}]) {
      const out = await client.tool("pes_cancel", { run_id: g.run_id, confirm, idempotency_key: `c-confirm-${JSON.stringify(confirm)}` });
      assert.equal(out.is_error, true, `confirm ${JSON.stringify(confirm)}`);
      assert.equal(out.data.error.code, "invalid_payload");
      assert.equal(out.data.error.target, "$.arguments.confirm");
    }
    assert.equal(state_signature(env.db), sig);
    assert.equal(env.db.get<{ status: string }>("SELECT status FROM runs WHERE id = ?", theirs)?.status, "queued");

    const done = await client.ok("pes_cancel", { confirm: true, idempotency_key: "c-own" });
    assert.ok(done.run_id === g.run_id || done.operation_id !== undefined || done.status !== undefined, `cancel answered: ${JSON.stringify(done)}`);
    assert.notEqual(env.db.get<{ status: string }>("SELECT status FROM runs WHERE id = ?", g.run_id)?.status, "running", "the own run is no longer running");
    await client.fails("pes_heartbeat", { idempotency_key: "c-after" }, "claim_required");
    await client.fails("pes_claim", { run_id: g.run_id, idempotency_key: "c-reclaim" }, "conflict");
  });
});

test("pes_receipt evidence: applied needs a submit's key; unknown, foreign and owner keys and foreign inputs are refused", async () => {
  await with_cleanup(async (env, open) => {
    const client = open(await env.client());
    const g = await claim_fresh(client);
    const asked = await client.ok("pes_ask", ask_args(env, "evidence"));
    await client.ok("pes_heartbeat", { idempotency_key: "ev-hb" });
    await client.ok("pes_wait", { idempotency_key: "ev-wait" });
    const input = await owner_answers(env, asked, "a");
    await client.ok("pes_claim", { run_id: g.run_id, idempotency_key: "ev-claim-2" });
    // an owner action under a key of its own: an agent must not be able to cite it
    await call(env, { method: "POST", path: P(env, "/rounds/none/seal"), auth: "owner", body: {}, key: "owner-private-key" });

    const sig = state_signature(env.db);
    const applied = () => table_counts(env.db);
    const before = applied();
    // keys that do not exist for this agent, or are not its own
    for (const key of ["no-such-key", "owner-private-key", "", "ev-hb ".trim() + "x"]) {
      const out = await client.tool("pes_receipt", { receipts: [{ input_version_id: input, state: "applied", applied_by_key: key }], idempotency_key: `ev-r-${key}` });
      assert.equal(out.is_error, true, `applied_by_key ${JSON.stringify(key)}`);
      assert.ok(["not_found", "invalid_payload"].includes(out.data.error.code), `${JSON.stringify(key)} -> ${out.data.error.code}`);
    }
    // inputs that this run never received
    for (const input_version_id of ["forged-input", env.version_id, asked.question.version_id, asked.question_set_id]) {
      const out = await client.tool("pes_receipt", { receipts: [{ input_version_id, state: "seen" }], idempotency_key: `ev-in-${input_version_id}` });
      assert.equal(out.is_error, true, `input ${input_version_id}`);
      assert.equal(out.data.error.code, "input_not_visible");
    }
    // 21 receipts, unknown fields, wrong state
    const many = Array.from({ length: 21 }, () => ({ input_version_id: input, state: "seen" }));
    await client.fails("pes_receipt", { receipts: many, idempotency_key: "ev-many" }, "invalid_payload");
    await client.fails("pes_receipt", { receipts: [{ input_version_id: input, state: "seen", applied_tx_id: "forged-tx" }], idempotency_key: "ev-field" }, "invalid_payload");
    await client.fails("pes_receipt", { receipts: [{ input_version_id: input, state: "approved" }], idempotency_key: "ev-state" }, "invalid_payload");
    assert.equal(state_signature(env.db), sig);
    assert.deepEqual(applied(), before);

    // with a real submit it works
    await client.ok("pes_submit", { results: [{ op: "append_version", object_id: env.object_id, title: "증거" }], idempotency_key: "ev-submit" });
    const ok = await client.ok("pes_receipt", { receipts: [{ input_version_id: input, state: "applied", applied_by_key: "ev-submit" }], idempotency_key: "ev-good" });
    assert.deepEqual(ok.accepted, [{ input_version_id: input, state: "applied" }]);
  });
});

test("pes_receipt: a heartbeat, ask or wait transaction is not proof that an input was applied", async () => {
  await with_cleanup(async (env, open) => {
    const client = open(await env.client());
    const g = await claim_fresh(client);
    const asked = await client.ok("pes_ask", ask_args(env, "evidence2"));
    await client.ok("pes_heartbeat", { idempotency_key: "ev2-hb" });
    await client.ok("pes_wait", { idempotency_key: "ev2-wait" });
    const input = await owner_answers(env, asked, "a");
    await client.ok("pes_claim", { run_id: g.run_id, idempotency_key: "ev2-claim-2" });
    // docs/adapters/adapter-contract.md 2.4: applied_by_key is "the idempotency_key of the pes_submit that used the input"
    for (const key of ["ev2-hb", "ev2-wait", "ask-evidence2", "ev2-claim-2"]) {
      const before = state_signature(env.db);
      const out = await client.tool("pes_receipt", { receipts: [{ input_version_id: input, state: "applied", applied_by_key: key }], idempotency_key: `ev2-bad-${key}` });
      assert.equal(out.is_error, true, `the ${key} transaction is not a submit, so it cannot prove the input was applied`);
      assert.equal(state_signature(env.db), before, `refused ${key} wrote nothing`);
    }
    const stored = env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM run_input_receipts WHERE state = 'applied'")?.n;
    assert.equal(stored, 0n, "no 'applied' receipt exists without a submit behind it");
  });
});

test("pes_submit: forged item fields, ops and objects of another project are refused; a stale expected_control_rev too", async () => {
  await with_cleanup(async (env, open) => {
    const b = await register_second(env, "synthetic-submit-forge");
    const client = open(await env.client());
    await claim_fresh(client);
    const sig = state_signature(env.db);
    let n = 0;
    const item = (extra: Record<string, unknown>) => ({ op: "append_version", object_id: env.object_id, title: "위조", ...extra });
    const forged: Array<[string, unknown[]]> = [];
    for (const field of ["actor_id", "run_id", "status", "current", "is_current", "set_current", "approved", "approval", "version_id", "version_no", "created_at", "via", "provenance", "adopted_by", "content_hash"]) {
      forged.push([`field ${field}`, [item({ [field]: field === "version_no" ? 99 : "forged" })]]);
    }
    for (const op of ["set_current", "approve", "reopen", "delete", "append_version ", "APPEND_VERSION", "", null, 5]) forged.push([`op ${JSON.stringify(op)}`, [{ ...item({}), op }]]);
    forged.push(["object of another project", [item({ object_id: b.object_id })]]);
    forged.push(["base version of another project", [item({ based_on_version_id: b.version_id })]]);
    forged.push(["base version of an unknown id", [item({ based_on_version_id: "no-such-version" })]]);
    forged.push(["no object", [{ op: "append_version", title: "x" }]]);
    forged.push(["21 items", Array.from({ length: 21 }, () => item({}))]);
    forged.push(["a null item", [null]]);
    forged.push(["an array item", [[item({})]]]);
    forged.push(["a good item after a bad one", [item({}), item({ approved: true })]]);
    for (const [name, results] of forged) {
      const out = await client.tool("pes_submit", { results, idempotency_key: `forge-${n++}` });
      assert.equal(out.is_error, true, `${name} must be refused`);
      assert.notEqual(out.data.error.code, "internal_error", name);
    }
    for (const results of [null, {}, "x", 0, [] as unknown[]]) {
      const out = await client.tool("pes_submit", { results, idempotency_key: `forge-${n++}` });
      assert.equal(out.is_error, true, `results ${JSON.stringify(results)}`);
    }
    assert.equal(state_signature(env.db), sig, "no version, no receipt, not even for the good item before a bad one");

    // a stale base: a human moved the project on, the agent still holds the old revision
    const rev = env.db.get<{ control_rev: bigint }>("SELECT control_rev FROM projects WHERE id = ?", env.p.project_id)!.control_rev;
    await bump_control_rev(env);
    const stale_sig = state_signature(env.db);
    const stale = await client.fails(
      "pes_submit",
      { results: [item({ title: "낡은 기준" })], expected_control_rev: String(rev), idempotency_key: "stale-base" },
      "rev_conflict",
    );
    assert.equal(typeof stale.next_action, "string");
    assert.equal(state_signature(env.db), stale_sig);
    await client.fails("pes_submit", { results: [item({})], expected_control_rev: "-1", idempotency_key: "bad-rev" }, "invalid_payload");
    await client.fails("pes_submit", { results: [item({})], expected_control_rev: 1.5, idempotency_key: "bad-rev-2" }, "invalid_payload");
    assert.equal(state_signature(env.db), stale_sig);
  });
});

test("the project token is never at rest in the database nor in what PES tells the owner", async () => {
  await with_cleanup(async (env, open) => {
    const client = open(await env.client());
    await claim_fresh(client);
    await client.ok("pes_ask", ask_args(env, "secret-scan"));
    await client.ok("pes_submit", { results: [{ op: "append_version", object_id: env.object_id, title: "비밀 검사" }], idempotency_key: "scan-submit" });
    const dump = state_signature(env.db);
    assert.ok(!dump.includes(env.agent.token), "the agent token is stored hashed, never in clear");
    const feed = assert_ok(await call(env, { method: "GET", path: P(env, "/changes?limit=100"), auth: "owner" }));
    const ctx = assert_ok(await call(env, { method: "GET", path: P(env, "/context"), auth: "owner" }));
    for (const text of [JSON.stringify(feed), JSON.stringify(ctx), client.lines.join("\n")]) {
      assert.ok(!text.includes(env.agent.token));
      assert.ok(!/synthetic-local-session-secret/.test(text));
    }
  });
});
