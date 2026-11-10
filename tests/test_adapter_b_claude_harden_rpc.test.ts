/**
 * SEL-53 PR20a — 보강: the MCP JSON-RPC boundary (tester, 보강 모드). Every case writes bytes to the fake client's
 * stdin by hand; no Claude process, no MCP config is touched.
 *
 * What is pinned (not already in test_adapter_b_claude_mcp):
 *  - lines that are not JSON-RPC requests (scalars, wrong version, method not a string) get exactly one -32600 answer
 *  - a batch (array) is refused as a whole and none of its calls runs; a notification never runs and never answers
 *  - JSON-RPC ids: strings and numbers are echoed; an id that is an object, array or boolean is not a valid id
 *  - tools/call parameter shapes; `__proto__` and friends cannot reach a tool
 *  - framing: split chunks, a multi-byte character cut in half, CRLF, two messages in one chunk, no trailing newline
 *  - an oversized line gets exactly one error and the next request is served; a large legal message is a tool error
 *  - pipelined requests are answered in order, and order is also execution order
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { FakeMcpClient } from "./helpers/adapter_b_env.ts";
import { barrier, rpc_line, tool_call, write_raw } from "./helpers/adapter_b_harden.ts";
import { events_of_type, with_cleanup } from "./helpers/adapter_b_flow.ts";
import { state_signature, table_counts } from "./helpers/state_signature.ts";

const answers = (client: FakeMcpClient, from: number) => client.lines.slice(from).map((line) => JSON.parse(line));

test("lines that are not JSON-RPC requests get one -32600 each, in order, and the server keeps serving", async () => {
  await with_cleanup(async (env, open) => {
    const client = open(await env.client());
    const sig = state_signature(env.db);
    const from = client.lines.length;
    const bad = [
      "null",
      "42",
      '"just text"',
      "true",
      "{}",
      '{"id":"bad-1","method":"ping"}',
      '{"jsonrpc":"1.0","id":"bad-2","method":"ping"}',
      '{"jsonrpc":"2.0","id":"bad-3","method":5}',
      '{"jsonrpc":"2.0","id":"bad-4"}',
      '{"jsonrpc":"2.0","id":"bad-5","method":null}',
    ];
    for (const text of bad) write_raw(client, `${text}\n`);
    const extra = await barrier(client, from);
    assert.equal(extra, bad.length + 1, "one answer for each bad line, plus the barrier ping");
    const replies = answers(client, from).slice(0, bad.length);
    for (const [i, reply] of replies.entries()) {
      assert.equal(reply.jsonrpc, "2.0", bad[i]);
      assert.equal(reply.error?.code, -32600, `${bad[i]} -> invalid request`);
      assert.equal(reply.result, undefined);
      assert.ok(reply.id === null || typeof reply.id === "number" || typeof reply.id === "string", "the error id is a valid id");
    }
    assert.equal(state_signature(env.db), sig, "nothing was written");
  });
});

test("a batch is refused as a whole: none of its calls runs", async () => {
  await with_cleanup(async (env, open) => {
    const client = open(await env.client());
    const sig = state_signature(env.db);
    const from = client.lines.length;
    write_raw(
      client,
      rpc_line([
        tool_call(1, "pes_claim", { idempotency_key: "batch-claim" }),
        { jsonrpc: "2.0", id: 2, method: "ping" },
      ]),
    );
    write_raw(client, "[]\n");
    await barrier(client);
    const replies = answers(client, from);
    assert.equal(replies[0].error.code, -32600);
    assert.equal(replies[0].id, null);
    assert.equal(replies[1].error.code, -32600);
    assert.equal(replies.length, 3, "two refusals and the barrier ping: no answer for the calls inside the batch");
    assert.equal(table_counts(env.db).runs, 0n, "the claim inside the batch never ran");
    assert.equal(state_signature(env.db), sig);
  });
});

test("a message without an id is a notification: it is never answered and never executed", async () => {
  await with_cleanup(async (env, open) => {
    const client = open(await env.client());
    const sig = state_signature(env.db);
    const from = client.lines.length;
    // a tools/call that forgot its id must not run (the client would never see the result)
    write_raw(client, rpc_line({ jsonrpc: "2.0", method: "tools/call", params: { name: "pes_claim", arguments: { idempotency_key: "no-id-claim" } } }));
    write_raw(client, rpc_line({ jsonrpc: "2.0", method: "no/such/method" }));
    write_raw(client, rpc_line({ jsonrpc: "2.0", method: "initialize", params: {} }));
    write_raw(client, rpc_line({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } }));
    write_raw(client, rpc_line({ jsonrpc: "2.0", method: "tools/list" }));
    const extra = await barrier(client, from);
    assert.equal(extra, 1, "only the barrier ping was answered");
    assert.equal(answers(client, from).length, 1);
    assert.equal(table_counts(env.db).runs, 0n, "the id-less claim did not run");
    assert.equal(state_signature(env.db), sig);
  });
});

test("ids: strings and numbers are echoed exactly, also zero and large ones", async () => {
  await with_cleanup(async (env, open) => {
    const client = open(await env.client());
    const from = client.lines.length;
    for (const id of ["a-string-id", "", 0, 9007199254740991, -7]) {
      write_raw(client, rpc_line({ jsonrpc: "2.0", id, method: "ping" }));
    }
    await barrier(client);
    const replies = answers(client, from).slice(0, 5);
    assert.deepEqual(
      replies.map((r) => r.id),
      ["a-string-id", "", 0, 9007199254740991, -7],
    );
    for (const reply of replies) assert.deepEqual(reply.result, {});
  });
});

test("an id that is an object, an array or a boolean is not a JSON-RPC id: it is refused, not echoed", async () => {
  await with_cleanup(async (env, open) => {
    const client = open(await env.client());
    const from = client.lines.length;
    const ids: unknown[] = [{ a: 1 }, [1], true, false];
    for (const id of ids) write_raw(client, rpc_line({ jsonrpc: "2.0", id, method: "ping" }));
    await barrier(client);
    const replies = answers(client, from).slice(0, ids.length);
    for (const [i, reply] of replies.entries()) {
      assert.equal(reply.result, undefined, `id ${JSON.stringify(ids[i])} got a result`);
      assert.equal(reply.error?.code, -32600, `id ${JSON.stringify(ids[i])} is an invalid request`);
      assert.equal(reply.id, null, "the invalid id is not echoed back");
    }
  });
});

test("tools/call parameter shapes: a bad shape is -32602, never a tool run", async () => {
  await with_cleanup(async (env, open) => {
    const client = open(await env.client());
    const sig = state_signature(env.db);
    for (const params of [undefined, null, [], "pes_claim", 7, { name: 5 }, { name: null }, { name: ["pes_claim"] }, { name: {} }, { name: "" }]) {
      const res = await client.request("tools/call", params);
      assert.equal(res.error?.code, -32602, `params ${JSON.stringify(params)}`);
      assert.equal(res.result, undefined);
    }
    for (const name of ["__proto__", "constructor", "toString", "hasOwnProperty", "PES_CONTEXT", "pes_context ", "pes_context\n", "pes-context", "pes_approve", "pes_register"]) {
      const res = await client.request("tools/call", { name, arguments: {} });
      assert.equal(res.error?.code, -32602, `tool name ${JSON.stringify(name)} is unknown`);
    }
    for (const args of [null, [], "x", 7, true]) {
      const res = await client.request("tools/call", { name: "pes_context", arguments: args });
      assert.equal(res.error?.code, -32602, `arguments ${JSON.stringify(args)}`);
    }
    assert.equal(state_signature(env.db), sig);
    assert.equal((await client.ok("pes_context", {})).project_id, env.p.project_id, "still serving");
  });
});

test("an own `__proto__` key in the arguments is an unknown argument, and nothing is polluted", async () => {
  await with_cleanup(async (env, open) => {
    const client = open(await env.client());
    const sig = state_signature(env.db);
    const from = client.lines.length;
    // written as text: an object literal would set the prototype instead of an own key
    write_raw(client, '{"jsonrpc":"2.0","id":90,"method":"tools/call","params":{"name":"pes_context","arguments":{"__proto__":{"polluted":true}}}}\n');
    write_raw(client, '{"jsonrpc":"2.0","id":91,"method":"tools/call","params":{"name":"pes_claim","arguments":{"idempotency_key":"proto-claim","__proto__":{"run_id":"x"}}}}\n');
    write_raw(client, '{"jsonrpc":"2.0","id":92,"method":"tools/call","params":{"name":"pes_submit","arguments":{"idempotency_key":"proto-submit","results":[{"__proto__":{"op":"append_version"},"op":"append_version","object_id":"x"}]}}}\n');
    await barrier(client);
    const [one, two, three] = answers(client, from);
    for (const reply of [one, two]) {
      assert.equal(reply.result.isError, true);
      assert.equal(reply.result.structuredContent.error.code, "invalid_payload");
    }
    assert.equal(three.result.isError, true, "the forged result item is refused too");
    assert.equal(({} as any).polluted, undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, "polluted"), false);
    assert.equal(table_counts(env.db).runs, 0n);
    assert.equal(state_signature(env.db), sig);
  });
});

test("framing: CRLF, blank lines, two messages in one chunk, a split chunk and a multi-byte character cut in half", async () => {
  await with_cleanup(async (env, open) => {
    const client = open(await env.client());
    const from = client.lines.length;

    // CRLF endings and blank lines in between
    write_raw(client, `${JSON.stringify({ jsonrpc: "2.0", id: "crlf-1", method: "ping" })}\r\n\r\n   \r\n`);
    // two messages in a single chunk
    write_raw(client, rpc_line({ jsonrpc: "2.0", id: "two-a", method: "ping" }) + rpc_line({ jsonrpc: "2.0", id: "two-b", method: "ping" }));
    // one message split into three writes, the cut inside a Korean character (3 bytes in UTF-8)
    const key = "청크-키-한글";
    const bytes = Buffer.from(rpc_line(tool_call("split-1", "pes_claim", { idempotency_key: key })), "utf8");
    const cut = bytes.indexOf(Buffer.from("청", "utf8")) + 1;
    write_raw(client, bytes.subarray(0, cut));
    write_raw(client, bytes.subarray(cut, cut + 1));
    write_raw(client, bytes.subarray(cut + 1));
    await barrier(client);
    const replies = answers(client, from);
    assert.deepEqual(
      replies.slice(0, 4).map((r) => r.id),
      ["crlf-1", "two-a", "two-b", "split-1"],
    );
    assert.equal(replies[3].result.isError, false, "the split message was read as one");
    // the key arrived intact: the same key and arguments replay the first answer
    const again = await client.ok("pes_claim", { idempotency_key: key });
    assert.equal(again.replayed, true, "the multi-byte key survived the split");
    assert.equal(table_counts(env.db).runs, 1n);
  });
});

test("the last message may end without a newline: it is answered before the input closes", async () => {
  await with_cleanup(async (env) => {
    const client = new FakeMcpClient(env.server());
    write_raw(client, JSON.stringify({ jsonrpc: "2.0", id: "tail", method: "ping" }));
    await client.close();
    assert.equal(client.lines.length, 1);
    assert.deepEqual(JSON.parse(client.lines[0]!), { jsonrpc: "2.0", id: "tail", result: {} });
  });
});

test("an oversized line gets exactly one error, its tail is dropped, and the next request is served", async () => {
  await with_cleanup(async (env, open) => {
    const client = open(await env.client());
    const sig = state_signature(env.db);
    const from = client.lines.length;
    const chunk = "a".repeat(64 * 1024);
    // 9 MiB with no newline: far over the line limit, but still one message
    for (let i = 0; i < 144; i += 1) write_raw(client, chunk);
    write_raw(client, "\n");
    // the dropped line must not leak into the next one
    write_raw(client, rpc_line({ jsonrpc: "2.0", id: "after-big", method: "ping" }));
    await barrier(client);
    const replies = answers(client, from);
    const errors = replies.filter((r) => r.error !== undefined);
    assert.equal(errors.length, 1, `one oversized line is one error, got ${errors.length}`);
    assert.equal(errors[0].error.code, -32600);
    assert.equal(errors[0].id, null);
    assert.ok(replies.some((r) => r.id === "after-big" && r.result !== undefined), "the request after it was served");
    assert.equal(state_signature(env.db), sig);
  });
});

test("a large legal message is a tool error, not a crash; nothing is written", async () => {
  await with_cleanup(async (env, open) => {
    const client = open(await env.client());
    await client.ok("pes_claim", { idempotency_key: "big-claim" });
    const sig = state_signature(env.db);
    const title = "가".repeat(3 * 1024 * 1024);
    const out = await client.tool("pes_submit", { results: [{ op: "append_version", object_id: env.object_id, title }], idempotency_key: "big-submit" });
    assert.equal(out.is_error, true);
    assert.equal(typeof out.data.error.code, "string");
    assert.notEqual(out.data.error.code, "internal_error", "an over-limit body is a clean refusal");
    assert.match(out.data.error.message, /[가-힣]/);
    assert.equal(state_signature(env.db), sig);
    assert.equal((await client.ok("pes_context", {})).project_id, env.p.project_id, "still serving");
  });
});

test("pipelined requests: answers come back in request order, and execution follows the same order", async () => {
  await with_cleanup(async (env, open) => {
    const client = open(await env.client());
    const from = client.lines.length;
    const batch: unknown[] = [];
    batch.push(tool_call("ctx-before", "pes_context", {}));
    batch.push(tool_call("claim", "pes_claim", { idempotency_key: "pipe-claim" }));
    for (let i = 0; i < 8; i += 1) batch.push(tool_call(`hb-${i}`, "pes_heartbeat", { progress: { phase: "stage" }, idempotency_key: `pipe-hb-${i}` }));
    batch.push(tool_call("ctx-during", "pes_context", {}));
    batch.push({ jsonrpc: "2.0", id: "list", method: "tools/list" });
    batch.push(tool_call("complete", "pes_complete", { status: "succeeded", idempotency_key: "pipe-done" }));
    batch.push(tool_call("hb-after-complete", "pes_heartbeat", { idempotency_key: "pipe-late" }));
    batch.push(tool_call("ctx-after", "pes_context", {}));
    // one single write: everything is in the server's buffer before the first answer exists
    write_raw(client, batch.map((m) => rpc_line(m)).join(""));
    await barrier(client);
    const replies = answers(client, from);
    assert.deepEqual(
      replies.slice(0, batch.length).map((r) => r.id),
      batch.map((m: any) => m.id),
      "ids come back in the order they were sent",
    );
    const by = Object.fromEntries(replies.map((r) => [r.id, r.result]));
    assert.equal(by["ctx-before"].structuredContent.lease, null, "the context before the claim saw no lease");
    assert.equal(by["claim"].isError, false);
    for (let i = 0; i < 8; i += 1) assert.equal(by[`hb-${i}`].isError, false, `heartbeat ${i} ran after the claim`);
    assert.notEqual(by["ctx-during"].structuredContent.lease, null, "the context in the middle saw the lease");
    assert.equal(by["complete"].isError, false);
    assert.equal(by["hb-after-complete"].structuredContent.error.code, "claim_required", "the lease was forgotten by the complete before it");
    assert.equal(by["ctx-after"].structuredContent.lease, null);
    assert.equal(events_of_type(env, "run.heartbeat").length, 8);
  });
});

test("two connections served at the same time do not share a guard", async () => {
  await with_cleanup(async (env, open) => {
    const [one, two] = [open(await env.client()), open(await env.client())];
    const first = await one.ok("pes_claim", { idempotency_key: "one-claim" });
    // the second connection never claimed: it has no guard even though the project has a lease
    await two.fails("pes_heartbeat", { idempotency_key: "two-hb" }, "claim_required");
    const results = await Promise.all([
      one.tool("pes_heartbeat", { idempotency_key: "one-hb" }),
      two.tool("pes_heartbeat", { idempotency_key: "two-hb-2" }),
      one.tool("pes_context", {}),
    ]);
    assert.equal(results[0]!.is_error, false);
    assert.equal(results[1]!.is_error, true);
    assert.equal(results[2]!.data.lease.lease_id, first.lease_id);
  });
});
