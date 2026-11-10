/**
 * SEL-53 PR20a — first registration of method B on an empty account (PR14 project-registrations API),
 * progress/schedule events, the Claude Code connection entry, and the adapter contract documents
 * (tester, 작성 모드).
 *
 * 해석 (continued, numbered on):
 *  해석 17 Empty account / new project: the owner's local session registers a project and a device
 *          (POST /api/v1/project-registrations, PR14); the returned device token is the ONLY credential the
 *          MCP server is given. From there context → claim → submit → complete runs through the MCP tools
 *          with that token, on the registered project (not on the harness's bootstrapped one).
 *  해석 18 Progress and schedule events are heartbeats with `progress.phase` from a closed list
 *          ["started","stage","completed","failed","waiting","scheduled"] (start, stage change, done, failed,
 *          waiting, planned work). All phases use the same tool, the same result shape ({run_id, lease,
 *          progress:{phase, observed_at}, server_time}), the same event type `run.heartbeat`, and the same
 *          idempotency rule: a replay writes no second event. observed_at defaults to the server clock.
 *          Any other phase is `invalid_payload` (target "$.arguments.progress.phase") with no API call.
 *  해석 19 `scripts/pes_core/adapters/claude_code.ts` exports `claude_code_mcp_entry({command, server_script,
 *          project_id, api_base_url})` → {command, args:[server_script], env:{PES_PROJECT_ID, PES_API_BASE_URL,
 *          PES_AGENT_TOKEN:"${PES_AGENT_TOKEN}"}}. The token is passed by reference (Claude Code's ${VAR}
 *          expansion), never by value, and the function reads and writes no file.
 *  해석 20 docs/adapters/adapter-contract.md is the contract. Executable examples are fenced blocks whose info
 *          string is `json pes-example`: {name, steps:[{tool, arguments, expect:"ok"|"<error code>"}]}, with the
 *          placeholders ${object_id} ${stage_plan} ${round_id}. Every such block in the three adapter docs is
 *          run against a fresh synthetic project and must behave as written ("문서만 보고 재현"). The
 *          `pes link` / `pes sync` local contract is in blocks `json pes-link-example` / `json pes-sync-example`:
 *          {command:"pes link"|"pes sync", request:{...}, response:{...}}; the link response names
 *          credential_kind "helper_device" (never an AI tool's MCP credential) and carries no agent token;
 *          sync request and response both carry a `cursor`.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { claude_code_mcp_entry } from "../scripts/pes_core/adapters/claude_code.ts";
import { McpServer } from "../scripts/pes_core/mcp_server.ts";
import { add_artifact, create_object } from "../scripts/pes_core/content.ts";
import { SESSION_SECRET, assert_error, assert_ok, call, DECIMAL } from "./helpers/api_env.ts";
import { ctx_for } from "./helpers/blob_env.ts";
import { FakeMcpClient } from "./helpers/adapter_b_env.ts";
import { claim_fresh, events_of_type, with_cleanup } from "./helpers/adapter_b_flow.ts";
import { state_signature, table_counts } from "./helpers/state_signature.ts";
import { wire } from "./helpers/adapter_b_env.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REGISTER = "/api/v1/project-registrations";
const PHASES = ["started", "stage", "completed", "failed", "waiting", "scheduled"] as const;

test("empty account: register a project and device, then context → claim → submit → complete through MCP", async () => {
  await with_cleanup(async (env, open) => {
    const body = { slug: "synthetic-first-run", topic: "합성 첫 등록", owner_display_name: "합성 소유자", device_label: "합성 Claude Code" };
    const reg = assert_ok(await call(env, { method: "POST", path: REGISTER, auth: "owner", body }), 201);
    assert.equal(typeof reg.token, "string");

    // The human side of the new project: a round and one artifact (core service, owner context).
    const owner = { project_id: reg.project_id as string, actor_id: reg.owner_actor_id as string, edition_id: reg.edition_id as string };
    assert_ok(await call(env, { method: "POST", path: `/api/v1/projects/${reg.project_id}/stages/${reg.stage_ids.plan}/rounds`, auth: "owner", body: {} }), 201);
    const created = (await create_object(env.service, ctx_for(owner, "reg-o"), { kind: "artifact", edition_id: owner.edition_id })).result as { object_id: string };
    await add_artifact(env.service, ctx_for(owner, "reg-v"), { object_id: created.object_id, artifact_kind: "chapter", title: "등록 직후 장", summary: "합성" });

    const server = new McpServer({
      api: env.app,
      project_id: reg.project_id,
      token: reg.token,
      claim_defaults: { runtime: "claude_code", provider: "anthropic", model: "synthetic-model" },
    });
    const client = open(new FakeMcpClient(server));
    await client.initialize();

    const ctx = await client.ok("pes_context", {});
    assert.equal(ctx.project_id, reg.project_id, "the MCP server works on the registered project");
    assert.equal(ctx.lease, null);
    assert.ok(ctx.manifest.some((m: any) => m.object_id === created.object_id));

    const claim = await claim_fresh(client);
    const run = env.db.get<{ actor_id: string; mode: string }>("SELECT actor_id, mode FROM runs WHERE id = ?", claim.run_id)!;
    assert.equal(run.actor_id, reg.device_actor_id, "the run belongs to the registered device");
    assert.equal(run.mode, "B");
    const submitted = await client.ok("pes_submit", {
      results: [{ op: "append_version", object_id: created.object_id, title: "첫 결과" }],
      idempotency_key: "reg-submit",
    });
    assert.equal(typeof submitted.results[0].version_id, "string");
    assert.equal((await client.ok("pes_complete", { status: "succeeded", idempotency_key: "reg-done" })).status, "succeeded");

    assert.equal(events_of_type(env, "result.submitted", reg.project_id).length, 1);
    assert.equal(events_of_type(env, "run.completed", reg.project_id).length, 1);
    assert.equal(events_of_type(env, "project.registered", reg.project_id).length, 1);
    // the device token does not reach the harness's other project, and cannot do the human's work
    const other = new FakeMcpClient(new McpServer({ api: env.app, project_id: env.p.project_id, token: reg.token }));
    open(other);
    await other.initialize();
    await other.fails("pes_context", {}, "unauthenticated");
    assert.equal(table_counts(env.db).approvals, 0n);
  });
});

test("no MCP tool registers a project; the agent token cannot, and the session secret never reaches the client", async () => {
  await with_cleanup(async (env, open) => {
    const client = open(await env.client());
    const sig = state_signature(env.db);
    const body = { slug: "synthetic-second", topic: "합성", owner_display_name: "합성", device_label: "합성 기기" };
    // no tool can register: the call is a protocol error, not a tool result
    const res = await client.request("tools/call", { name: "pes_register", arguments: body });
    assert.equal(res.error.code, -32602);
    // and the agent's own token is refused by the API for the same route
    assert_error(await call(env, { method: "POST", path: REGISTER, auth: { token: env.agent.token }, body }), 401, "unauthenticated");
    assert.equal(state_signature(env.db), sig);
    assert.ok(!client.lines.join("\n").includes(SESSION_SECRET));
  });
});

test("progress and schedule events share one format, one event type and one idempotency rule", async () => {
  await with_cleanup(async (env, open) => {
    const client = open(await env.client());
    const claim = await claim_fresh(client);
    const shapes = new Set<string>();
    for (const phase of PHASES) {
      env.clock.advance(1_000);
      const out = await client.ok("pes_heartbeat", { progress: { phase }, idempotency_key: `hb-${phase}` });
      assert.equal(out.run_id, claim.run_id);
      assert.deepEqual(out.progress, { phase, observed_at: env.clock.now_ms() }, "observed_at defaults to the server clock");
      assert.equal(out.lease.lease_id, claim.lease_id);
      shapes.add(Object.keys(out).sort().join(","));
    }
    assert.equal(shapes.size, 1, "every phase answers with the same keys");
    assert.equal(events_of_type(env, "run.heartbeat").length, PHASES.length, "one event of the same type per phase");

    // a replay (the app retried after a lost answer) writes nothing and answers the same
    const sig = state_signature(env.db);
    const first = await client.ok("pes_heartbeat", { progress: { phase: "scheduled" }, idempotency_key: "hb-scheduled" });
    assert.equal(first.replayed, true);
    assert.equal(state_signature(env.db), sig);
    assert.equal(events_of_type(env, "run.heartbeat").length, PHASES.length);

    // the same key for another phase is a different request
    const reuse = await client.fails("pes_heartbeat", { progress: { phase: "failed" }, idempotency_key: "hb-scheduled" }, "idempotency_key_reuse");
    assert.equal(reuse.next_action, "use_new_key");

    // outside the closed list, or malformed, nothing reaches the API
    for (const progress of [{ phase: "thinking" }, { phase: "" }, { phase: 3 }, { phase: "started", observed_at: "now" }, { phase: "started", observed_at: -1 }, { phase: "started", extra: 1 }]) {
      const error = await client.fails("pes_heartbeat", { progress, idempotency_key: `hb-bad-${JSON.stringify(progress)}` }, "invalid_payload");
      assert.match(error.target, /^\$\.arguments\.progress/);
    }
    assert.equal(state_signature(env.db), sig);
  });
});

test("an event with an explicit observed_at keeps it; a heartbeat never changes business revisions", async () => {
  await with_cleanup(async (env, open) => {
    const client = open(await env.client());
    await claim_fresh(client);
    const rev = env.db.get<{ control_rev: bigint }>("SELECT control_rev FROM projects WHERE id = ?", env.p.project_id)!.control_rev;
    const out = await client.ok("pes_heartbeat", { progress: { phase: "stage", observed_at: env.clock.now_ms() - 5_000 }, idempotency_key: "hb-obs" });
    assert.equal(out.progress.observed_at, env.clock.now_ms() - 5_000);
    assert.match(out.lease.fence, DECIMAL);
    assert.equal(env.db.get<{ control_rev: bigint }>("SELECT control_rev FROM projects WHERE id = ?", env.p.project_id)!.control_rev, rev);
  });
});

test("the Claude Code entry passes the token by reference and touches no file", async () => {
  const entry = claude_code_mcp_entry({
    command: process.execPath,
    server_script: join(REPO, "scripts", "pes_core", "mcp_server.ts"),
    project_id: "synthetic-project-id",
    api_base_url: "http://127.0.0.1:8760",
  });
  assert.equal(entry.command, process.execPath, "the node path is given, never looked up with which");
  assert.equal(entry.args.length, 1);
  assert.match(entry.args[0]!, /mcp_server\.ts$/);
  assert.deepEqual(Object.keys(entry.env).sort(), ["PES_AGENT_TOKEN", "PES_API_BASE_URL", "PES_PROJECT_ID"]);
  assert.equal(entry.env.PES_PROJECT_ID, "synthetic-project-id");
  assert.equal(entry.env.PES_API_BASE_URL, "http://127.0.0.1:8760");
  assert.equal(entry.env.PES_AGENT_TOKEN, "${PES_AGENT_TOKEN}", "by reference, not by value");
  assert.doesNotMatch(wire(entry), /Bearer|session/i);
});

// ---------------------------------------------------------------------------
// documents: "문서만 보고 재현된다"

const DOCS = ["adapter-contract.md", "claude-code.md", "claude-app.md"].map((name) => join(REPO, "docs", "adapters", name));

function fenced(path: string, info: string): Array<{ info: string; text: string }> {
  const text = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  const out: Array<{ info: string; text: string }> = [];
  const re = /^```([^\n`]*)\n([\s\S]*?)\n```[ \t]*$/gm;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if ((m[1] ?? "").trim() === info) out.push({ info, text: m[2] ?? "" });
  }
  return out;
}

test("the contract names the ten tools, the key rule, the hash caveat and what is unverified", () => {
  const text = readFileSync(join(REPO, "docs", "adapters", "adapter-contract.md"), "utf8").replace(/\r\n/g, "\n");
  for (const tool of ["pes_context", "pes_claim", "pes_submit", "pes_ask", "pes_wait", "pes_complete", "pes_heartbeat", "pes_release", "pes_cancel", "pes_receipt"]) {
    assert.ok(text.includes(tool), `the contract documents ${tool}`);
  }
  for (const phrase of ["idempotency_key", "claim_required", "manifest_hash", "hash는 인증", "claude_app_handoff", "pes link", "pes sync", "미확인"]) {
    assert.ok(text.includes(phrase), `the contract says ${phrase}`);
  }
  for (const phase of PHASES) assert.ok(text.includes(phase), `the contract lists the phase ${phase}`);
  const app = readFileSync(join(REPO, "docs", "adapters", "claude-app.md"), "utf8");
  assert.match(app, /명시적 전달/, "the app note describes the explicit handoff");
  assert.match(app, /미확인|검증하지 않았/, "a real app connection is stated as unverified");
});

test("every pes-example block in the adapter documents runs as written", async () => {
  const blocks = DOCS.flatMap((path) => fenced(path, "json pes-example"));
  assert.ok(blocks.length >= 2, "the documents carry at least two runnable examples");
  for (const block of blocks) {
    const example = JSON.parse(block.text) as { name: string; steps: Array<{ tool: string; arguments?: Record<string, unknown>; expect: string }> };
    assert.equal(typeof example.name, "string");
    await with_cleanup(async (env, open) => {
      const client = open(await env.client());
      const fill = (value: unknown): unknown =>
        JSON.parse(
          JSON.stringify(value)
            .replaceAll("${object_id}", env.object_id)
            .replaceAll("${stage_plan}", env.stage.plan)
            .replaceAll("${round_id}", env.round_id),
        );
      for (const step of example.steps) {
        const args = fill(step.arguments ?? {}) as Record<string, unknown>;
        if (step.expect === "ok") await client.ok(step.tool, args);
        else await client.fails(step.tool, args, step.expect);
      }
    });
  }
});

test("the pes link / pes sync local contract is reproducible from the documents", () => {
  const links = DOCS.flatMap((path) => fenced(path, "json pes-link-example"));
  const syncs = DOCS.flatMap((path) => fenced(path, "json pes-sync-example"));
  assert.ok(links.length >= 1 && syncs.length >= 1, "one example for each command");
  for (const block of links) {
    const doc = JSON.parse(block.text);
    assert.equal(doc.command, "pes link");
    assert.equal(typeof doc.request, "object");
    assert.equal(doc.response.credential_kind, "helper_device", "the helper has its own credential kind, not an AI tool's MCP credential");
    assert.doesNotMatch(block.text, /agent[_ ]?token|Bearer|PES_AGENT_TOKEN/i, "no agent token in the link contract");
  }
  for (const block of syncs) {
    const doc = JSON.parse(block.text);
    assert.equal(doc.command, "pes sync");
    assert.ok("cursor" in doc.request && "cursor" in doc.response, "the sync cursor travels both ways");
  }
});
