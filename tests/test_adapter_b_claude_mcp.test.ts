/**
 * SEL-53 PR20a — the MCP server speaks the protocol and exposes exactly the closed tool set
 * (tester, 작성 모드). Written from the issue (docs/plan/issues/stage-2-linear.md PR20a), the ledger
 * decision for SEL-53 and docs/plan/spikes/mode-b-tui.md; scripts/pes_core/mcp_server.ts does not exist yet.
 *
 * 해석 (interpretations the worker must follow or the leader must overrule — every test below pins one):
 *  해석 1  Module `scripts/pes_core/mcp_server.ts` exports `McpServer` (constructor option bag
 *          {api, project_id, token, claim_defaults?}; `api` is an ApiApp-shaped object) and `serve_stdio`.
 *          The wire is newline-delimited JSON-RPC 2.0 over stdio; the fake client in
 *          tests/helpers/adapter_b_env.ts writes it by hand, so no Claude process is ever started.
 *  해석 2  Methods: `initialize` (result has protocolVersion, capabilities.tools, serverInfo.name),
 *          `notifications/initialized` (no reply), `ping` ({}), `tools/list`, `tools/call`.
 *          An unknown method is JSON-RPC error -32601; malformed JSON is -32700 with id null and the server
 *          keeps serving; an unknown tool name is -32602.
 *  해석 3  The tool set is closed: pes_context, pes_claim, pes_submit, pes_ask, pes_wait, pes_complete,
 *          pes_heartbeat, pes_release, pes_cancel, pes_receipt. There is NO approve / reopen / seal /
 *          policy / register tool: a connected AI cannot reach what only a human may do.
 *  해석 4  A tool result is {content:[{type:"text", text: JSON}], structuredContent: same JSON, isError}.
 *          A PES refusal is isError:true with structuredContent {error:{code,message(Korean),next_action,
 *          retryable,...}} copied from the API envelope — never a protocol-level error.
 *  해석 5  Nothing but JSON-RPC lines is ever written to stdout, and the token never appears in any reply.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { TOOLS, wire } from "./helpers/adapter_b_env.ts";
import { FakeMcpClient } from "./helpers/adapter_b_env.ts";
import { with_cleanup } from "./helpers/adapter_b_flow.ts";

test("initialize answers with protocol, a tools capability and a server name; initialized has no reply", async () => {
  await with_cleanup(async (env, open) => {
    const client = open(new FakeMcpClient(env.server()));
    const res = await client.initialize();
    assert.equal(res.jsonrpc, "2.0");
    assert.equal(res.id, 1);
    assert.equal(typeof res.result.protocolVersion, "string");
    assert.ok(res.result.capabilities.tools !== undefined, "declares the tools capability");
    assert.equal(typeof res.result.serverInfo.name, "string");
    assert.ok(res.result.serverInfo.name.length > 0);
    const pong = await client.request("ping");
    assert.deepEqual(pong.result, {});
    assert.equal(client.lines.length, 2, "one reply for initialize, one for ping; the notification got none");
  });
});

test("tools/list is the closed set of ten tools, each with a description and an object input schema", async () => {
  await with_cleanup(async (env, open) => {
    const client = open(new FakeMcpClient(env.server()));
    await client.initialize();
    const res = await client.request("tools/list");
    const tools = res.result.tools as Array<{ name: string; description: string; inputSchema: any }>;
    assert.deepEqual(tools.map((t) => t.name).sort(), [...TOOLS].sort());
    for (const tool of tools) {
      assert.equal(typeof tool.description, "string");
      assert.ok(tool.description.length > 0, tool.name);
      assert.equal(tool.inputSchema.type, "object", `${tool.name} input schema`);
    }
    const by = Object.fromEntries(tools.map((t) => [t.name, t.inputSchema]));
    for (const name of ["pes_claim", "pes_submit", "pes_ask", "pes_wait", "pes_complete", "pes_heartbeat", "pes_release", "pes_cancel", "pes_receipt"]) {
      assert.ok(by[name].properties.idempotency_key !== undefined, `${name} takes an idempotency_key`);
      assert.ok((by[name].required ?? []).includes("idempotency_key"), `${name} requires it`);
    }
    for (const forbidden of ["approve", "reopen", "seal", "policy", "register", "create_project", "token"]) {
      assert.ok(!tools.some((t) => t.name.includes(forbidden)), `no tool named like ${forbidden}`);
    }
  });
});

test("protocol errors: unknown method, malformed JSON and unknown tool; the server keeps serving", async () => {
  await with_cleanup(async (env, open) => {
    const client = open(new FakeMcpClient(env.server()));
    await client.initialize();
    const unknown = await client.request("resources/subscribe", {});
    assert.equal(unknown.error.code, -32601);
    assert.equal(unknown.result, undefined);

    const parse = await client.raw_line("{ not json");
    assert.equal(parse.error.code, -32700);
    assert.equal(parse.id, null);

    const bad_tool = await client.request("tools/call", { name: "pes_approve", arguments: {} });
    assert.equal(bad_tool.error.code, -32602);
    const bad_params = await client.request("tools/call", { arguments: {} });
    assert.equal(bad_params.error.code, -32602);

    const still = await client.ok("pes_context", {});
    assert.equal(still.project_id, env.p.project_id, "the server survived all of that");
  });
});

test("stdout carries JSON-RPC lines only, and the token is in none of them", async () => {
  await with_cleanup(async (env, open) => {
    const client = open(new FakeMcpClient(env.server()));
    await client.initialize();
    await client.request("tools/list");
    await client.ok("pes_context", {});
    await client.tool("pes_claim", { run_id: "no-such-run" });
    await client.tool("pes_submit", {});
    await client.ok("pes_claim", { idempotency_key: "claim-wire" });
    for (const line of client.lines) {
      const parsed = JSON.parse(line);
      assert.equal(parsed.jsonrpc, "2.0", line);
    }
    const all = client.lines.join("\n");
    assert.ok(!all.includes(env.agent.token), "the agent token is never sent to the client");
    assert.ok(!wire(all).includes("Bearer"), "no Authorization header text is echoed");
  });
});

test("a tool refusal is a tool result with the API error, not a protocol error", async () => {
  await with_cleanup(async (env, open) => {
    const client = open(new FakeMcpClient(env.server()));
    await client.initialize();
    const error = await client.fails("pes_claim", { run_id: "no-such-run" }, "not_found");
    assert.equal(error.retryable, false);
    assert.equal(error.next_action, "reread_context");

    const bad = new FakeMcpClient(env.server("synthetic-wrong-token"));
    open(bad);
    await bad.initialize();
    const denied = await bad.fails("pes_context", {}, "unauthenticated");
    assert.equal(denied.next_action, "authenticate");
  });
});

test("a read tool with an agent token lacking the scope is refused by PES, not by the adapter", async () => {
  await with_cleanup(async (env, open) => {
    const { make_agent } = await import("./helpers/api_env.ts");
    const narrow = await make_agent(env, "narrow", ["context:read"]);
    const client = open(new FakeMcpClient(env.server(narrow.token)));
    await client.initialize();
    assert.equal((await client.ok("pes_context", {})).project_id, env.p.project_id);
    const error = await client.fails("pes_claim", {}, "forbidden");
    assert.equal(typeof error.next_action, "string");
    await client.fails("pes_submit", { idempotency_key: "k1", results: [] }, "forbidden");
  });
});
