/**
 * SEL-53 PR20a — 보강: progress/schedule events, first registration, and the documents (tester, 보강 모드).
 *
 *  - a progress event is a note, not a state change: no phase completes, fails or ends anything
 *  - re-sending a progress event (same connection, another connection, after a restart, concurrently) adds no event
 *  - registration (PR14) is the owner's; its body is closed; the device it hands out has no human power
 *  - the documents: examples fail when the behaviour differs, the tool↔route table matches the requests really sent,
 *    the documented answer shapes are the real ones, the claims in the app note are true
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { claude_code_mcp_entry } from "../scripts/pes_core/adapters/claude_code.ts";
import { PROGRESS_PHASES, McpServer } from "../scripts/pes_core/mcp_server.ts";
import { SESSION_SECRET, assert_ok, call, make_agent } from "./helpers/api_env.ts";
import { P, restart_app } from "./helpers/api_flow.ts";
import { FakeMcpClient, TOOLS, ask_args, owner_answers, type AdapterEnv } from "./helpers/adapter_b_env.ts";
import { claim_fresh, events_of_type, with_cleanup } from "./helpers/adapter_b_flow.ts";
import { adapter, export_for, paste, register_second } from "./helpers/adapter_b_harden.ts";
import { state_signature, table_counts } from "./helpers/state_signature.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REGISTER = "/api/v1/project-registrations";
const PHASES = ["started", "stage", "completed", "failed", "waiting", "scheduled"] as const;
const run_status = (env: AdapterEnv, run_id: string) => env.db.get<{ status: string }>("SELECT status FROM runs WHERE id = ?", run_id)?.status;

// ---------------------------------------------------------------------------
// progress and schedule events

test("a progress phase is a note: completed, failed and waiting end nothing, and the lease stays", async () => {
  await with_cleanup(async (env, open) => {
    const client = open(await env.client());
    const g = await claim_fresh(client);
    for (const phase of PHASES) {
      env.clock.advance(1_000);
      const out = await client.ok("pes_heartbeat", { progress: { phase }, idempotency_key: `note-${phase}` });
      assert.equal(out.lease.lease_id, g.lease_id, phase);
      assert.equal(run_status(env, g.run_id), "running", `${phase} did not change the run`);
    }
    assert.equal(events_of_type(env, "run.completed").length, 0, "the phase 'completed' is not a completion");
    assert.equal(events_of_type(env, "run.failed").length, 0);
    assert.equal(events_of_type(env, "run.waiting_human").length, 0);
    assert.equal(table_counts(env.db).approvals, 0n);
    // the real end is still the complete tool
    assert.equal((await client.ok("pes_complete", { status: "succeeded", idempotency_key: "note-done" })).status, "succeeded");
  });
});

test("a re-sent progress event writes nothing: same connection, a new connection, after a restart", async () => {
  await with_cleanup(async (env, open) => {
    const client = open(await env.client());
    const g = await claim_fresh(client);
    env.clock.advance(2_000);
    const first = await client.ok("pes_heartbeat", { progress: { phase: "stage" }, idempotency_key: "resend" });
    const stored = events_of_type(env, "run.heartbeat").map((e) => e.payload);
    const dump = (value: unknown) => JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    const lease_rows = dump(env.db.all("SELECT * FROM project_leases"));
    const sig = state_signature(env.db);

    env.clock.advance(60_000);
    const same = await client.ok("pes_heartbeat", { progress: { phase: "stage" }, idempotency_key: "resend" });
    assert.equal(same.replayed, true);
    assert.deepEqual(same.progress.phase, first.progress.phase);
    assert.equal(same.lease.lease_id, g.lease_id);
    assert.equal(same.lease.expires_at, first.lease.expires_at, "a replay does not extend the lease");
    assert.equal(state_signature(env.db), sig, "a replay is not a write");
    assert.equal(dump(env.db.all("SELECT * FROM project_leases")), lease_rows);

    // a brand-new MCP connection (explicit ids) after a server restart
    restart_app(env);
    const fresh = open(await env.client());
    const again = await fresh.ok("pes_heartbeat", { run_id: g.run_id, lease_id: g.lease_id, fence: g.fence, progress: { phase: "stage" }, idempotency_key: "resend" });
    assert.equal(again.replayed, true);
    assert.equal(state_signature(env.db), sig);
    // the first observed_at stays in the event, whatever the replay answers
    assert.deepEqual(events_of_type(env, "run.heartbeat").map((e) => e.payload), stored);
    assert.equal(JSON.parse(stored[0]!).progress.observed_at, first.progress.observed_at);

    // other content under the same key is refused, also from the new connection
    await fresh.fails("pes_heartbeat", { run_id: g.run_id, lease_id: g.lease_id, fence: g.fence, progress: { phase: "failed" }, idempotency_key: "resend" }, "idempotency_key_reuse");
    await fresh.fails("pes_heartbeat", { run_id: g.run_id, lease_id: g.lease_id, fence: g.fence, progress: { phase: "stage", observed_at: 5 }, idempotency_key: "resend" }, "idempotency_key_reuse");
    await fresh.fails("pes_heartbeat", { run_id: g.run_id, lease_id: g.lease_id, fence: g.fence, idempotency_key: "resend" }, "idempotency_key_reuse");
    assert.equal(state_signature(env.db), sig);
  });
});

test("the same progress event sent at the same moment from two connections is one event", async () => {
  await with_cleanup(async (env, open) => {
    const one = open(await env.client());
    const g = await claim_fresh(one);
    const two = open(await env.client());
    const args = { run_id: g.run_id, lease_id: g.lease_id, fence: g.fence, progress: { phase: "scheduled" }, idempotency_key: "twice-at-once" };
    const [a, b] = await Promise.all([one.tool("pes_heartbeat", args), two.tool("pes_heartbeat", args)]);
    assert.equal(a.is_error, false);
    assert.equal(b.is_error, false);
    assert.equal([a.data, b.data].filter((d) => d.replayed === true).length, 1, "one first answer and one replay");
    assert.equal(events_of_type(env, "run.heartbeat").length, 1);
  });
});

test("progress after the lease is gone or the run has ended is refused and leaves no event", async () => {
  await with_cleanup(async (env, open) => {
    const old = open(await env.client());
    const g = await claim_fresh(old);
    await old.ok("pes_wait", { idempotency_key: "gone-wait" });
    const taker = open(await env.client());
    await taker.ok("pes_claim", { run_id: g.run_id, idempotency_key: "gone-reclaim" });
    const sig = state_signature(env.db);
    const stale = await old.fails("pes_heartbeat", { run_id: g.run_id, lease_id: g.lease_id, fence: g.fence, progress: { phase: "started" }, idempotency_key: "gone-hb" }, "lease_lost");
    assert.equal(stale.next_action, "reclaim_run");
    assert.equal(state_signature(env.db), sig);

    await taker.ok("pes_complete", { status: "succeeded", idempotency_key: "gone-done" });
    const sig2 = state_signature(env.db);
    const late = await taker.tool("pes_heartbeat", { run_id: g.run_id, lease_id: g.lease_id, fence: "2", progress: { phase: "completed" }, idempotency_key: "gone-late" });
    assert.equal(late.is_error, true);
    assert.equal(state_signature(env.db), sig2);
  });
});

test("progress observed_at must be a whole number of milliseconds; the phase list is the documented one", async () => {
  await with_cleanup(async (env, open) => {
    assert.deepEqual([...PROGRESS_PHASES], [...PHASES]);
    const client = open(await env.client());
    await claim_fresh(client);
    const sig = state_signature(env.db);
    let n = 0;
    for (const observed_at of [1.5, -1, "5", null, true, [], {}, 2 ** 53, Number.MAX_VALUE, 1e21]) {
      const out = await client.tool("pes_heartbeat", { progress: { phase: "stage", observed_at }, idempotency_key: `obs-${n++}` });
      assert.equal(out.is_error, true, `observed_at ${JSON.stringify(observed_at)}`);
      assert.equal(out.data.error.code, "invalid_payload");
    }
    for (const phase of ["Started", "started ", " started", "STARTED", "start", "stage\n", "스테이지", null, 1, [], {}, ""]) {
      const out = await client.tool("pes_heartbeat", { progress: { phase }, idempotency_key: `ph-${n++}` });
      assert.equal(out.is_error, true, `phase ${JSON.stringify(phase)}`);
      assert.equal(out.data.error.code, "invalid_payload");
    }
    for (const progress of [null, "started", 5, [], [{ phase: "started" }]]) {
      const out = await client.tool("pes_heartbeat", { progress, idempotency_key: `pg-${n++}` });
      assert.equal(out.is_error, true, `progress ${JSON.stringify(progress)}`);
    }
    assert.equal(state_signature(env.db), sig);
    // zero is a time; it is kept as given
    const zero = await client.ok("pes_heartbeat", { progress: { phase: "started", observed_at: 0 }, idempotency_key: "obs-zero" });
    assert.equal(zero.progress.observed_at, 0);
  });
});

// ---------------------------------------------------------------------------
// registration

test("registration is the owner's act and its body is closed: nothing else registers, nothing extra is accepted", async () => {
  await with_cleanup(async (env) => {
    const sig = state_signature(env.db);
    const good = { slug: "synthetic-reg-ok", topic: "합성", owner_display_name: "합성 소유자", device_label: "합성 기기" };
    const refused_auth: Array<[string, any, Record<string, string> | undefined]> = [
      ["no credential", "none", undefined],
      ["an agent token", { token: env.agent.token }, undefined],
      ["the session as a bearer token", { token: SESSION_SECRET }, undefined],
      ["a wrong session", "none", { "x-pes-session": "synthetic-wrong-session" }],
    ];
    for (const [name, auth, headers] of refused_auth) {
      const res = await call(env, { method: "POST", path: REGISTER, auth, body: good, headers });
      assert.equal(res.status, 401, name);
    }
    const bad_bodies: Array<[string, Record<string, unknown>]> = [
      ["scopes smuggled in", { ...good, scopes: ["run:claim", "file:write", "owner"] }],
      ["actor smuggled in", { ...good, owner_actor_id: env.p.actor_id }],
      ["user smuggled in", { ...good, owner_user_id: "someone" }],
      ["project id chosen", { ...good, project_id: env.p.project_id }],
      ["token chosen", { ...good, token: "chosen-by-the-caller" }],
      ["no device label", { slug: good.slug, topic: good.topic, owner_display_name: good.owner_display_name }],
      ["no slug", { topic: good.topic, owner_display_name: good.owner_display_name, device_label: good.device_label }],
      ["empty topic", { ...good, topic: "" }],
      ["topic a number", { ...good, topic: 5 }],
    ];
    for (const slug of ["", "A B", "../x", "a/b", "x".repeat(300), "a\nb", " ", "UPPER", "한글", "-leading", ".dot", "con\u0000trol"]) {
      bad_bodies.push([`slug ${JSON.stringify(slug).slice(0, 24)}`, { ...good, slug }]);
    }
    for (const [name, body] of bad_bodies) {
      const res = await call(env, { method: "POST", path: REGISTER, auth: "owner", body });
      assert.equal(res.status, 400, `${name}: ${res.status} ${JSON.stringify(res.json).slice(0, 120)}`);
      assert.notEqual(res.json.error.code, "internal_error");
    }
    assert.equal(state_signature(env.db), sig, "no refused registration left a project, an actor or a token");
  });
});

test("registering twice: same slug conflicts, a replay hands out no second token, other content under the key is refused", async () => {
  await with_cleanup(async (env) => {
    const body = { slug: "synthetic-reg-twice", topic: "합성", owner_display_name: "합성 소유자", device_label: "합성 기기" };
    const first = assert_ok(await call(env, { method: "POST", path: REGISTER, auth: "owner", body, key: "reg-twice-1" }), 201);
    const sig = state_signature(env.db);
    const again = await call(env, { method: "POST", path: REGISTER, auth: "owner", body, key: "reg-twice-1" });
    assert.equal(again.status, 201);
    assert.equal(again.json.replayed, true);
    assert.equal(again.json.data.project_id, first.project_id);
    assert.ok(!JSON.stringify(again.json).includes(first.token), "a replay never prints the token again");
    const reuse = await call(env, { method: "POST", path: REGISTER, auth: "owner", body: { ...body, topic: "다른 주제" }, key: "reg-twice-1" });
    assert.equal(reuse.json.error?.code, "idempotency_key_reuse");
    const clash = await call(env, { method: "POST", path: REGISTER, auth: "owner", body, key: "reg-twice-2" });
    assert.equal(clash.status, 409);
    assert.equal(clash.json.error.code, "conflict");
    assert.equal(state_signature(env.db), sig, "nothing moved after the first registration");
  });
});

test("the device a registration hands out has no human power, and its token is stored hashed", async () => {
  await with_cleanup(async (env, open) => {
    const b = await register_second(env, "synthetic-device-power");
    const sig = state_signature(env.db);
    const path = (rest: string) => `/api/v1/projects/${b.project_id}${rest}`;
    const humans_only: Array<[string, string, string, unknown]> = [
      ["POST", path(`/stages/${b.stage_ids.plan}/approve`), "approve", { snapshot_id: "forged" }],
      ["POST", path(`/stages/${b.stage_ids.plan}/reopen`), "reopen", {}],
      ["POST", path(`/rounds/${b.round_id}/seal`), "seal", { manifest_blob_id: "forged", versions: [] }],
      ["POST", path("/policies/opencode-go/revisions"), "policy", { allow_opencode_go: true, reason: "위조" }],
      ["POST", path("/submissions"), "answer as the human", { set_id: "forged", answers: [] }],
      ["POST", path("/runs"), "create a run for someone", { actor_id: b.owner_actor_id, mode: "B", runtime: "r", provider: "p", model: "m" }],
      ["POST", REGISTER, "register another project", { slug: "synthetic-from-device", topic: "x", owner_display_name: "x", device_label: "x" }],
    ];
    for (const [method, url, name, body] of humans_only) {
      const res = await call(env, { method, path: url, auth: { token: b.token }, body });
      assert.ok(res.status === 401 || res.status === 403, `${name}: ${res.status} ${JSON.stringify(res.json).slice(0, 120)}`);
      assert.ok(["human_required", "forbidden", "unauthenticated", "owner_required"].includes(res.json.error.code), `${name}: ${res.json.error.code}`);
    }
    assert.equal(state_signature(env.db), sig);
    assert.ok(!sig.includes(b.token), "the device token is not in the database in clear");
    const feed = assert_ok(await call(env, { method: "GET", path: path("/changes?limit=100"), auth: "owner" }));
    assert.ok(!JSON.stringify(feed).includes(b.token));

    // and an MCP connection with it can still work in its own project
    const server = new McpServer({ api: env.app, project_id: b.project_id, token: b.token });
    const client = open(new FakeMcpClient(server));
    await client.initialize();
    const claim = await client.ok("pes_claim", { idempotency_key: "dev-claim" });
    assert.equal(env.db.get<{ actor_id: string }>("SELECT actor_id FROM runs WHERE id = ?", claim.run_id)?.actor_id, b.device_actor_id);
  });
});

test("a freshly registered project with no round and no object works through MCP, and a foreign object is not_found", async () => {
  await with_cleanup(async (env, open) => {
    const body = { slug: "synthetic-empty-start", topic: "합성 빈 시작", owner_display_name: "합성 소유자", device_label: "합성 기기" };
    const reg = assert_ok(await call(env, { method: "POST", path: REGISTER, auth: "owner", body }), 201);
    const server = new McpServer({ api: env.app, project_id: reg.project_id, token: reg.token, claim_defaults: { runtime: "claude_code", provider: "anthropic", model: "synthetic-model" } });
    const client = open(new FakeMcpClient(server));
    await client.initialize();
    const ctx = await client.ok("pes_context", {});
    assert.equal(ctx.project_id, reg.project_id);
    assert.deepEqual(ctx.manifest, []);
    await client.ok("pes_claim", { idempotency_key: "empty-claim" });
    await client.fails("pes_submit", { results: [{ op: "append_version", object_id: env.object_id, title: "다른 프로젝트 자료" }], idempotency_key: "empty-submit" }, "not_found");
    assert.equal((await client.ok("pes_complete", { status: "succeeded", idempotency_key: "empty-done" })).status, "succeeded");
  });
});

// ---------------------------------------------------------------------------
// documents

const DOCS = ["adapter-contract.md", "claude-code.md", "claude-app.md"].map((name) => join(REPO, "docs", "adapters", name));
const read_doc = (name: string) => readFileSync(join(REPO, "docs", "adapters", name), "utf8").replace(/\r\n/g, "\n");

function fenced(path: string, info: string): string[] {
  const text = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  const out: string[] = [];
  const re = /^```([^\n`]*)\n([\s\S]*?)\n```[ \t]*$/gm;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) if ((m[1] ?? "").trim() === info) out.push(m[2] ?? "");
  return out;
}

interface Example {
  name: string;
  steps: Array<{ tool: string; arguments?: Record<string, unknown>; expect: string }>;
}

/** Run an example the way the documents say and list every step whose outcome differs from `expect`. */
async function run_example(env: AdapterEnv, client: FakeMcpClient, example: Example): Promise<string[]> {
  const fill = (value: unknown): unknown =>
    JSON.parse(JSON.stringify(value).replaceAll("${object_id}", env.object_id).replaceAll("${stage_plan}", env.stage.plan).replaceAll("${round_id}", env.round_id));
  const mismatches: string[] = [];
  for (const [i, step] of example.steps.entries()) {
    const out = await client.tool(step.tool, fill(step.arguments ?? {}) as Record<string, unknown>);
    const actual = out.is_error ? String(out.data.error.code) : "ok";
    if (actual !== step.expect) mismatches.push(`step ${i + 1} ${step.tool}: documented ${step.expect}, actual ${actual}`);
  }
  return mismatches;
}

test("the example runner has teeth: documents that disagree with the behaviour are reported", async () => {
  const examples = DOCS.flatMap((path) => fenced(path, "json pes-example")).map((text) => JSON.parse(text) as Example);
  assert.ok(examples.length >= 3);
  for (const example of examples) {
    await with_cleanup(async (env, open) => {
      assert.deepEqual(await run_example(env, open(await env.client()), example), [], `${example.name} runs as documented`);
    });
    for (const [i, step] of example.steps.entries()) {
      // a document that said something else for this one step
      const wrong: Example = { ...example, steps: example.steps.map((s, j) => (j === i ? { ...s, expect: s.expect === "ok" ? "invalid_payload" : "ok" } : s)) };
      await with_cleanup(async (env, open) => {
        const found = await run_example(env, open(await env.client()), wrong);
        assert.equal(found.length, 1, `${example.name} step ${i + 1} (${step.tool}): a wrong document must be caught, got ${JSON.stringify(found)}`);
      });
    }
  }
});

test("the tool ↔ route table in the contract is the requests the tools really send", async () => {
  const table = read_doc("adapter-contract.md");
  const documented = new Map<string, Set<string>>();
  for (const line of table.split("\n")) {
    const m = /^\| `(pes_[a-z_]+)` \|.*\|\s*(`[^|]+)\|\s*$/.exec(line);
    if (m === null) continue;
    documented.set(m[1]!, new Set([...(m[2] ?? "").matchAll(/`((?:GET|POST) [^`]+)`/g)].map((r) => r[1]!)));
  }
  assert.equal(documented.size, TOOLS.length, "all tools (14, with pes_read and the SEL-93 three) are in the table");

  await with_cleanup(async (env, open) => {
    const sent: string[] = [];
    const seen = new Set<string>();
    const spy = {
      handle: async (request: { method: string; path: string; headers: Record<string, string>; body: string | Uint8Array | null }) => {
        const rest = request.path.replace(/^\/api\/v1\/projects\/[^/]+/, "").replace(/\?.*$/, "");
        sent.push(`${request.method} ${rest.replace(/^\/runs\/[^/]+/, "/runs/{r}").replace(/^\/objects\/[^/]+\/versions\/[^/]+$/, "/objects/{o}/versions/{v}")}`);
        return env.app.handle(request);
      },
    };
    const client = open(new FakeMcpClient(new McpServer({ api: spy as any, project_id: env.p.project_id, token: env.agent.token, claim_defaults: { runtime: "claude_code", provider: "anthropic", model: "m" } })));
    await client.initialize();
    const used = async (tool: string, args: Record<string, unknown>): Promise<any> => {
      const from = sent.length;
      const data = await client.ok(tool, args);
      const routes = new Set(sent.slice(from));
      const wanted = documented.get(tool)!;
      for (const route of routes) assert.ok(wanted.has(route), `${tool} sent ${route}, which the table does not list (${[...wanted].join(", ")})`);
      for (const route of routes) seen.add(`${tool} ${route}`);
      return data;
    };
    await used("pes_claim", { idempotency_key: "t-claim" });
    await used("pes_context", {});
    await used("pes_read", { object_id: env.object_id }); // 최종 리뷰 1/2 F1: 본문 읽기 도구도 문서의 경로를 실제로 쓴다
    const asked = await used("pes_ask", ask_args(env, "t"));
    await used("pes_submit", { results: [{ op: "append_version", object_id: env.object_id, title: "표" }], idempotency_key: "t-submit" });
    await used("pes_heartbeat", { idempotency_key: "t-hb" });
    await used("pes_wait", { idempotency_key: "t-wait" });
    const input = await owner_answers(env, asked, "a");
    const run = env.db.get<{ id: string }>("SELECT id FROM runs ORDER BY rowid DESC LIMIT 1")!.id;
    await used("pes_claim", { run_id: run, idempotency_key: "t-claim-2" });
    await used("pes_receipt", { receipts: [{ input_version_id: input, state: "seen" }], idempotency_key: "t-receipt" });
    await used("pes_release", { idempotency_key: "t-release" });
    await used("pes_claim", { run_id: run, idempotency_key: "t-claim-3" });
    await used("pes_complete", { status: "succeeded", idempotency_key: "t-complete" });
    // SEL-93 U3a: the three proposal / reflection tools send exactly the documented routes
    await used("pes_assumption_propose", { statement: "표 시험 가정", idempotency_key: "t-assume" });
    await used("pes_decision_propose", { statement: "표 시험 결정", scope: "edition", idempotency_key: "t-decide" });
    await used("pes_reflection_write", { target_round_id: env.round_id, entries: [], idempotency_key: "t-reflect" });
    await claim_fresh(client);
    await used("pes_cancel", { confirm: true, idempotency_key: "t-cancel" });
    for (const [tool, routes] of documented) {
      for (const route of routes) {
        if (tool === "pes_context" && route.endsWith("/inputs")) assert.ok(seen.has(`${tool} ${route}`), "the context tool read the inputs when it knew the run");
        else assert.ok([...seen].some((s) => s.startsWith(`${tool} `) && s.endsWith(route)), `${tool}: the documented route ${route} was never used`);
      }
    }
  });
});

test("the documented answer shapes are the real ones: a progress heartbeat, a replay, the context", async () => {
  await with_cleanup(async (env, open) => {
    const client = open(await env.client());
    const g = await claim_fresh(client);
    const beat = await client.ok("pes_heartbeat", { progress: { phase: "stage" }, idempotency_key: "shape-hb" });
    // docs/adapters/adapter-contract.md 2.3: {run_id, lease: {lease_id, fence, expires_at}, progress: {phase, observed_at}, server_time}
    assert.deepEqual(Object.keys(beat).sort(), ["lease", "progress", "run_id", "server_time"]);
    assert.deepEqual(Object.keys(beat.lease).sort(), ["expires_at", "fence", "lease_id"]);
    assert.deepEqual(Object.keys(beat.progress).sort(), ["observed_at", "phase"]);
    assert.equal(beat.run_id, g.run_id);
    const replay = await client.ok("pes_heartbeat", { progress: { phase: "stage" }, idempotency_key: "shape-hb" });
    assert.deepEqual(Object.keys(replay).sort(), ["lease", "progress", "replayed", "run_id", "server_time"]);
    const plain = await client.ok("pes_heartbeat", { idempotency_key: "shape-hb-plain" });
    assert.equal("progress" in plain, false, "no progress was sent, none is answered");
    // 2.1 / 2.2: the refusal envelope, and what the guard rule says
    const missing = await client.fails("pes_heartbeat", { progress: { phase: "stage" } }, "invalid_payload");
    assert.deepEqual([missing.target, missing.next_action], ["$.arguments.idempotency_key", "fix_request"]);
    const ctx = await client.ok("pes_context", {});
    for (const key of ["project_id", "control_rev", "digest", "stages", "manifest", "lease"]) assert.ok(key in ctx, `context has ${key}`);
    assert.ok(Array.isArray(ctx.inputs), "the context lists the inputs of the known run");
  });
});

test("wait, complete, release and cancel each make the server forget the lease (contract 2.2)", async () => {
  await with_cleanup(async (env, open) => {
    const client = open(await env.client());
    const ends: Array<[string, Record<string, unknown>]> = [
      ["pes_wait", {}],
      ["pes_release", {}],
      ["pes_complete", { status: "succeeded" }],
      ["pes_cancel", { confirm: true }],
    ];
    for (const [tool, args] of ends) {
      const g = await claim_fresh(client);
      await client.ok(tool, { ...args, idempotency_key: `forget-${tool}` });
      const error = await client.fails("pes_heartbeat", { idempotency_key: `forget-hb-${tool}` }, "claim_required");
      assert.equal(error.next_action, "claim", tool);
      // and the old guard, spelled out, no longer works either
      const out = await client.tool("pes_heartbeat", { run_id: g.run_id, lease_id: g.lease_id, fence: g.fence, idempotency_key: `forget-old-${tool}` });
      assert.equal(out.is_error, true, `${tool}: the lease is gone for good`);
    }
  });
});

test("the app note's claim about via is true: a direct MCP submit is not an import, an import is not an agent's", async () => {
  await with_cleanup(async (env, open) => {
    const client = open(await env.client());
    const g = await claim_fresh(client);
    await client.ok("pes_submit", { results: [{ op: "append_version", object_id: env.object_id, title: "직접" }], idempotency_key: "via-direct" });
    await client.ok("pes_complete", { status: "succeeded", idempotency_key: "via-direct-done" });
    const a = adapter(env);
    const imported = await a.import_result({ bundle_text: (await export_for(env, a)).text, result_text: paste(env.object_id, "가져옴") });
    const via = (run_id: string) =>
      env.db.all<{ via: string; actor_id: string }>(
        "SELECT m.via AS via, m.actor_id AS actor_id FROM mutation_commits m JOIN events e ON e.tx_id = m.id AND e.project_id = m.project_id WHERE e.type = 'result.submitted' AND e.run_id = ?",
        run_id,
      );
    assert.deepEqual(via(g.run_id).map((r) => [r.via, r.actor_id]), [["http", env.agent.actor_id]], "docs: 직접 MCP로 한 제출은 에이전트 토큰의 http");
    assert.deepEqual(via(imported.run_id).map((r) => [r.via, r.actor_id]), [["import", env.p.actor_id]]);
    const app = read_doc("claude-app.md");
    assert.ok(app.includes("`import`") && app.includes("`http`"), "the note names both values");
  });
});

test("the Claude Code entry block in the document has the keys and the by-reference token the code produces", () => {
  const blocks = fenced(join(REPO, "docs", "adapters", "claude-code.md"), "json");
  assert.ok(blocks.length >= 1);
  const documented = JSON.parse(blocks[0]!) as { command: string; args: string[]; env: Record<string, string> };
  const real = claude_code_mcp_entry({ command: process.execPath, server_script: join(REPO, "scripts", "pes_core", "mcp_server.ts"), project_id: "synthetic-project-id", api_base_url: "http://127.0.0.1:8760" });
  assert.deepEqual(Object.keys(documented).sort(), Object.keys(real).sort());
  assert.deepEqual(Object.keys(documented.env).sort(), Object.keys(real.env).sort());
  assert.equal(documented.env.PES_AGENT_TOKEN, real.env.PES_AGENT_TOKEN, "the document writes the same reference the code does");
  assert.equal(documented.args.length, real.args.length);
  assert.match(documented.args[0]!, /mcp_server\.ts$/);
  assert.match(documented.env.PES_API_BASE_URL!, /^http:\/\/127\.0\.0\.1:\d+$/);
  const contract = read_doc("adapter-contract.md");
  for (const name of Object.keys(real.env)) assert.ok(contract.includes(`\`${name}\``), `the contract's variable table names ${name}`);
  for (const name of ["PES_RUNTIME", "PES_PROVIDER", "PES_MODEL"]) assert.ok(contract.includes(name));
});

test("the documents never carry a real secret shape: no token, no session, no home path", () => {
  for (const path of DOCS) {
    const text = readFileSync(path, "utf8");
    assert.doesNotMatch(text, /\/Users\/[a-z]|C:\\Users\\|\/home\/[a-z]/i, `${path} has a user path`);
    assert.doesNotMatch(text, /sk-[A-Za-z0-9]{20,}|pes_[a-z0-9]{32,}|Bearer [A-Za-z0-9._-]{20,}/, `${path} has a secret-looking value`);
  }
  assert.ok(typeof make_agent === "function");
});
