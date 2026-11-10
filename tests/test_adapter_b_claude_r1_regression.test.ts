/**
 * SEL-53 PR20a — 1차 리뷰(r1-1) 회귀 (tester, 작성 모드).
 *
 * 구현 전에 쓴 정답이다. 리뷰의 권장 사항을 요구사항으로 고정한다:
 *  R1  같은 request_id를 다른 멱등 키로 두 번 가져와도 run·결과는 1번 (서버가 import-<request_id>를 강제)
 *  R2  키 없는 pes_claim 탐침의 본문은 {} (어떤 탐침도 유효한 쓰기 본문을 보내지 않는다)
 *  R3  실제 프로세스의 기본 runtime은 claude_code가 아니다(mcp 또는 unknown), PES_RUNTIME을 주면 그 값
 *  R4  heartbeat 답의 progress.observed_at은 저장된 값과 같다 (재전송도 같다)
 *  R6  묶음 범위 밖(다른 판·단계·라운드)·내보낸 뒤 상태가 바뀐 묶음은 거부, 승인된 단계는 내보내기도 거부
 *  R7  stdio 상대가 닫아도(EPIPE) 서버는 죽지 않고 정리된다
 *  R8  applied_by_key가 다른 run의 결과 제출 키면 applied가 아니다
 *  N1  문서(8.17·claude-app·adapter-contract·openapi RunImport)에 승인/봉인 conflict·중복 object invalid_payload·
 *      receipt 규칙이 적혀 있다
 * 모두 합성 자료이고 실제 Claude·앱·MCP 설정은 읽지 않는다.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { McpServer, serve_stdio } from "../scripts/pes_core/mcp_server.ts";
import { assert_ok, call } from "./helpers/api_env.ts";
import { P } from "./helpers/api_flow.ts";
import { ask_args, owner_answers, FakeMcpClient, type AdapterEnv } from "./helpers/adapter_b_env.ts";
import { claim_fresh, events_of_type, with_cleanup } from "./helpers/adapter_b_flow.ts";
import { adapter, export_for, forge_bundle, paste, refused, register_second } from "./helpers/adapter_b_harden.ts";
import { manifest_blob } from "./helpers/editions_env.ts";
import { isolated_home } from "./helpers/isolated_home.ts";
import { state_signature, table_counts } from "./helpers/state_signature.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_SCRIPT = join(REPO, "scripts", "pes_core", "mcp_server.ts");
const TOKEN = "synthetic-r1-token-0123456789";

const read_text = (...parts: string[]): string => readFileSync(join(REPO, ...parts), "utf8").replace(/\r\n/g, "\n");

// ---------------------------------------------------------------------------
// R1: the server, not the adapter, makes one request_id one import

const import_body = (env: AdapterEnv, request_id: string, title: string) => ({
  import: {
    results: [{ op: "append_version", object_id: env.object_id, title }],
    request_id,
    stage_id: env.stage.plan,
    round_id: env.round_id,
  },
});

const post_import = (env: AdapterEnv, body: unknown, key: string) =>
  call(env, { method: "POST", path: P(env, "/runs"), auth: "owner", body, key });

const handoff_runs = (env: AdapterEnv): bigint =>
  env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM runs WHERE runtime = 'claude_app_handoff'")!.n;

test("R1: the same request_id under a second idempotency key imports nothing more (the server forces import-<request_id>)", async () => {
  await with_cleanup(async (env) => {
    const request_id = "r1-dup-request-0001";
    const first = await post_import(env, import_body(env, request_id, "첫 가져오기"), `import-${request_id}`);
    assert.equal(first.status, 201, JSON.stringify(first.json).slice(0, 200));
    const run_id = first.json.data.run_id as string;
    assert.equal(handoff_runs(env), 1n);
    const sig = state_signature(env.db);

    for (const key of ["another-key-1", "import-r1-dup-request-0002", "IMPORT-r1-dup-request-0001", `import-${request_id} `]) {
      const again = await post_import(env, import_body(env, request_id, "다른 키로 다시"), key);
      if (again.status >= 200 && again.status < 300) {
        assert.equal(again.json.data.run_id, run_id, `key ${JSON.stringify(key)}: a 2xx answer may only repeat the first import`);
      } else {
        assert.ok(again.status >= 400 && again.status < 500, `key ${JSON.stringify(key)}: ${again.status}`);
        assert.equal(typeof again.json.error.code, "string");
      }
      assert.equal(state_signature(env.db), sig, `key ${JSON.stringify(key)}: no second run, version, receipt or event`);
    }
    assert.equal(handoff_runs(env), 1n, "one request_id, one run");
    assert.equal(events_of_type(env, "run.created").filter((e) => JSON.parse(e.payload).request_id === request_id).length, 1);
  });
});

test("R1: two imports of one new request_id, neither under the forced key, write at most one run", async () => {
  await with_cleanup(async (env) => {
    const request_id = "r1-dup-request-0003";
    const before = handoff_runs(env);
    await post_import(env, import_body(env, request_id, "임의 키 1"), "arbitrary-key-1");
    await post_import(env, import_body(env, request_id, "임의 키 2"), "arbitrary-key-2");
    const made = handoff_runs(env) - before;
    assert.ok(made <= 1n, `at most one run, got ${made}`);
    assert.equal(events_of_type(env, "run.created").filter((e) => JSON.parse(e.payload).request_id === request_id).length <= 1, true);
  });
});

test("R1: the adapter path still imports once and refuses the repeat", async () => {
  await with_cleanup(async (env) => {
    const a = adapter(env);
    const { text } = await export_for(env, a);
    const out = await a.import_result({ bundle_text: text, result_text: paste(env.object_id, "한 번") });
    assert.equal(out.status, "imported");
    const sig = state_signature(env.db);
    await refused(a.import_result({ bundle_text: text, result_text: paste(env.object_id, "두 번") }), "duplicate_import");
    assert.equal(state_signature(env.db), sig);
    assert.equal(handoff_runs(env), 1n);
  });
});

// ---------------------------------------------------------------------------
// R2: a probe never carries a valid claim body

/** The ApiApp, with every request it is asked to handle recorded. */
function recording(env: AdapterEnv) {
  const seen: Array<{ method: string; path: string; body: string | null; has_key: boolean }> = [];
  const api = {
    async handle(request: { method: string; path: string; headers: Record<string, string>; body: string | Uint8Array | null }) {
      seen.push({
        method: request.method,
        path: request.path,
        body: typeof request.body === "string" ? request.body : request.body === null ? null : Buffer.from(request.body).toString("utf8"),
        has_key: request.headers["idempotency-key"] !== undefined,
      });
      return env.app.handle(request as any);
    },
  };
  return { api, seen };
}

async function recorded_client(env: AdapterEnv) {
  const { api, seen } = recording(env);
  const server = new McpServer({
    api: api as any,
    project_id: env.p.project_id,
    token: env.agent.token,
    claim_defaults: { runtime: "claude_code", provider: "anthropic", model: "synthetic-model" },
  });
  const client = new FakeMcpClient(server);
  await client.initialize();
  return { client, seen };
}

test("R2: the keyless pes_claim probe sends an empty body, never {mode, runtime, provider, model}", async () => {
  await with_cleanup(async (env, open) => {
    const { client, seen } = await recorded_client(env);
    open(client);
    const sig = state_signature(env.db);

    const fresh = await client.tool("pes_claim", {});
    assert.equal(fresh.is_error, true, "no idempotency_key, no claim");
    const known = await client.tool("pes_claim", { run_id: "r1-some-run" });
    assert.equal(known.is_error, true);

    const claims = seen.filter((r) => r.method === "POST" && r.path.endsWith("/claims"));
    assert.ok(claims.length >= 1, "the probe went to the claim route (credential and scope are PES's to judge)");
    for (const request of claims) {
      assert.equal(request.has_key, false, "a probe carries no idempotency key");
      const body = JSON.parse(request.body ?? "null") as Record<string, unknown>;
      for (const field of ["mode", "runtime", "provider", "model"]) {
        assert.equal(field in body, false, `the probe body must not hold ${field}`);
      }
      assert.ok(Object.keys(body).every((k) => k === "run_id"), JSON.stringify(body));
    }
    assert.deepEqual(JSON.parse(claims[0]!.body ?? "null"), {}, "no run_id given: the body is {}");
    assert.equal(state_signature(env.db), sig, "a probe writes nothing");
  });
});

test("R2: every keyless, guardless tool call sends only an empty (or run_id) body and writes nothing", async () => {
  await with_cleanup(async (env, open) => {
    const { client, seen } = await recorded_client(env);
    open(client);
    const sig = state_signature(env.db);
    const tools: Array<[string, Record<string, unknown>]> = [
      ["pes_claim", {}],
      ["pes_submit", { results: [{ op: "append_version", object_id: env.object_id, title: "키 없음" }] }],
      ["pes_ask", ask_args(env, "r1-probe") as Record<string, unknown>],
      ["pes_wait", {}],
      ["pes_complete", { status: "succeeded" }],
      ["pes_heartbeat", { progress: { phase: "stage" } }],
      ["pes_release", {}],
      ["pes_cancel", { confirm: true }],
      ["pes_receipt", { receipts: [{ input_version_id: "x", state: "seen" }] }],
    ];
    for (const [name, args] of tools) {
      const { idempotency_key: _drop, ...without_key } = args;
      const out = await client.tool(name, without_key);
      assert.equal(out.is_error, true, `${name} without a key is refused`);
    }
    const posts = seen.filter((r) => r.method !== "GET");
    assert.ok(posts.length >= 1);
    for (const request of posts) {
      const body = JSON.parse(request.body ?? "{}") as Record<string, unknown>;
      assert.ok(Object.keys(body).every((k) => k === "run_id"), `${request.method} ${request.path}: ${request.body}`);
    }
    assert.equal(state_signature(env.db), sig, "the probes wrote nothing");
    assert.equal(table_counts(env.db).runs, 0n);
  });
});

// ---------------------------------------------------------------------------
// R3: the real process does not call itself claude_code unless told

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

async function fake_pes(handler: (req: Seen, res: ServerResponse) => void): Promise<{ server: Server; base: string; seen: Seen[]; close(): Promise<void> }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const entry: Seen = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
      seen.push(entry);
      handler(entry, res);
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    base: `http://127.0.0.1:${port}`,
    seen,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

function run_server(env_extra: Record<string, string>, messages: unknown[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const home = isolated_home("pes-sel53-r1-");
  const env: Record<string, string | undefined> = { ...home.env };
  for (const name of Object.keys(env)) if (name.startsWith("PES_") && name !== "PES_HOME") delete env[name];
  Object.assign(env, env_extra);
  return new Promise((resolve_run, reject) => {
    const child = spawn(process.execPath, [SERVER_SCRIPT], { env, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("the server process did not end"));
    }, 30_000);
    child.on("error", (e) => {
      clearTimeout(timer);
      home.cleanup();
      reject(e);
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      home.cleanup();
      resolve_run({ status, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(messages.map((m) => `${JSON.stringify(m)}\n`).join(""));
  });
}

const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "synthetic", version: "0" } } };
const claim_call = (id: number, key: string) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "pes_claim", arguments: { idempotency_key: key } } });
const claim_ok = (res: ServerResponse): void => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ format_version: "1.0", request_id: "r", data: { run_id: "run-1", lease_id: "lease-1", fence: "1" } }));
};

test("R3: without PES_RUNTIME the claim does not say claude_code; with it, that value is sent as is", async () => {
  const bare = await fake_pes((_req, res) => claim_ok(res));
  try {
    const ran = await run_server({ PES_PROJECT_ID: "synthetic-proj", PES_API_BASE_URL: bare.base, PES_AGENT_TOKEN: TOKEN }, [init, claim_call(2, "r1-claim-bare")]);
    assert.equal(ran.status, 0, ran.stderr);
    const body = JSON.parse(bare.seen.find((r) => r.method === "POST" && r.url.endsWith("/claims"))!.body) as Record<string, string>;
    assert.equal(body.mode, "B");
    assert.notEqual(body.runtime, "claude_code", "an unconfigured server must not record itself as Claude Code");
    assert.ok(["mcp", "unknown"].includes(body.runtime), `runtime ${body.runtime}`);
    assert.notEqual(body.provider, "anthropic", "nor guess a provider");
  } finally {
    await bare.close();
  }

  const named = await fake_pes((_req, res) => claim_ok(res));
  try {
    const ran = await run_server(
      { PES_PROJECT_ID: "synthetic-proj", PES_API_BASE_URL: named.base, PES_AGENT_TOKEN: TOKEN, PES_RUNTIME: "claude_code", PES_PROVIDER: "anthropic", PES_MODEL: "synthetic-model-2" },
      [init, claim_call(2, "r1-claim-named")],
    );
    assert.equal(ran.status, 0, ran.stderr);
    const body = JSON.parse(named.seen.find((r) => r.method === "POST" && r.url.endsWith("/claims"))!.body);
    assert.deepEqual(body, { mode: "B", runtime: "claude_code", provider: "anthropic", model: "synthetic-model-2" });
  } finally {
    await named.close();
  }
});

// ---------------------------------------------------------------------------
// R4: the heartbeat answer repeats what was stored

test("R4: the progress a heartbeat answers is the stored one, even when the clock moves between reads", async () => {
  await with_cleanup(async (env, open) => {
    // every read of the clock moves it, so the command's time and the answer's server_time cannot coincide
    const clock = env.clock as any;
    const read = clock.now_ms.bind(clock) as () => number;
    clock.now_ms = (): number => {
      const value = read();
      clock.advance(7);
      return value;
    };
    const client = open(await env.client());
    await claim_fresh(client);
    const beat = await client.ok("pes_heartbeat", { progress: { phase: "stage" }, idempotency_key: "r1-hb" });

    const events = events_of_type(env, "run.heartbeat");
    assert.equal(events.length, 1);
    const stored = JSON.parse(events[0]!.payload).progress as { phase: string; observed_at: number };
    assert.equal(stored.phase, "stage");
    assert.equal(beat.progress.observed_at, stored.observed_at, "the answer's observed_at is the saved one");
    assert.notEqual(beat.server_time, stored.observed_at, "(the clock really moved between the two reads)");

    const replay = await client.ok("pes_heartbeat", { progress: { phase: "stage" }, idempotency_key: "r1-hb" });
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.progress, beat.progress, "a replay repeats the saved note");
    assert.equal(events_of_type(env, "run.heartbeat").length, 1, "and adds no event");

    const given = await client.ok("pes_heartbeat", { progress: { phase: "stage", observed_at: 12345 }, idempotency_key: "r1-hb-given" });
    assert.deepEqual(given.progress, { phase: "stage", observed_at: 12345 }, "a caller's observed_at is kept");
  });
});

// ---------------------------------------------------------------------------
// R6: the bundle is bound to this edition, stage, round and state

async function seal_plan_round(env: AdapterEnv): Promise<{ snapshot_id: string }> {
  const versions = [{ object_id: env.object_id, version_id: env.version_id }];
  const blob = await manifest_blob(env, versions, "r1-manifest");
  const sealed = assert_ok(await call(env, { method: "POST", path: P(env, `/rounds/${env.round_id}/seal`), auth: "owner", body: { manifest_blob_id: blob, versions } }));
  return { snapshot_id: sealed.round.sealed_snapshot_id as string };
}

test("R6: a bundle outside this edition, stage or round is refused, though its hash was recomputed", async () => {
  await with_cleanup(async (env) => {
    const a = adapter(env);
    const other = await register_second(env, "synthetic-r1-scope");
    const { bundle } = await export_for(env, a);
    const sig = state_signature(env.db);
    const cases: Array<[string, Record<string, unknown>]> = [
      ["another edition", { edition_id: other.edition_id }],
      ["an unknown edition", { edition_id: "no-such-edition" }],
      ["another stage of this project with this round", { stage_id: env.stage.research, stage_key: "research" }],
      ["a stage key that is not the stage's", { stage_key: "research" }],
      ["a stage of another project", { stage_id: other.stage_ids.plan }],
      ["a round of another project", { round_id: other.round_id }],
      ["an unknown round", { round_id: "no-such-round" }],
      ["a stage and a round that do not belong together", { stage_id: env.stage.research, stage_key: "research", round_id: env.round_id }],
    ];
    for (const [name, patch] of cases) {
      await refused(a.import_result({ bundle_text: forge_bundle(bundle, patch), result_text: paste(env.object_id, `범위 밖: ${name}`) }));
      assert.equal(state_signature(env.db), sig, `${name}: nothing written`);
    }
    assert.equal(handoff_runs(env), 0n);
  });
});

test("R6: a bundle copied before a human sealed the round or approved the stage is refused at import (conflict)", async () => {
  await with_cleanup(async (env) => {
    const a = adapter(env);
    const copied = await export_for(env, a);
    const { snapshot_id } = await seal_plan_round(env);
    const sig = state_signature(env.db);
    await refused(a.import_result({ bundle_text: copied.text, result_text: paste(env.object_id, "봉인 뒤") }), ["conflict", "bundle_stale"]);
    assert.equal(state_signature(env.db), sig, "sealed after the copy: nothing written");

    assert_ok(await call(env, { method: "POST", path: P(env, `/stages/${env.stage.plan}/approve`), auth: "owner", body: { snapshot_id } }));
    const sig2 = state_signature(env.db);
    await refused(a.import_result({ bundle_text: copied.text, result_text: paste(env.object_id, "승인 뒤") }), ["conflict", "bundle_stale"]);
    assert.equal(state_signature(env.db), sig2, "approved after the copy: nothing written");
    assert.equal(handoff_runs(env), 0n);
  });
});

test("R6: an approved stage cannot even be copied out (conflict), and copying writes nothing", async () => {
  await with_cleanup(async (env) => {
    const a = adapter(env);
    const { snapshot_id } = await seal_plan_round(env);
    assert_ok(await call(env, { method: "POST", path: P(env, `/stages/${env.stage.plan}/approve`), auth: "owner", body: { snapshot_id } }));
    const sig = state_signature(env.db);
    await refused(export_for(env, a), "conflict");
    assert.equal(state_signature(env.db), sig);
  });
});

// ---------------------------------------------------------------------------
// R7: a peer that closes the pipe does not kill the server

async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: not finished in ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** A stdout whose reader has gone away: every write fails the way a closed pipe does. */
function broken_pipe(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    },
  });
}

test("R7: when the client has closed the pipe, a write error ends the server cleanly (no uncaught error), input ended", async () => {
  await with_cleanup(async (env) => {
    const input = new PassThrough();
    const done = serve_stdio(env.server(), { input, output: broken_pipe() });
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })}\n`);
    input.end();
    await within(done, 5_000, "serve_stdio after a broken output");
  });
});

test("R7: ...and also when the input stays open, the server stops serving instead of waiting forever", async () => {
  await with_cleanup(async (env) => {
    const input = new PassThrough();
    const done = serve_stdio(env.server(), { input, output: broken_pipe() });
    try {
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}\n`);
      await within(done, 5_000, "serve_stdio with an open input and a broken output");
    } finally {
      input.end();
    }
  });
});

// ---------------------------------------------------------------------------
// R8: an applied receipt cites a submit of THIS run

test("R8: another run's submit key is not evidence that this run used an input", async () => {
  await with_cleanup(async (env, open) => {
    const client = open(await env.client());
    // run A: submits under its own key and ends
    await claim_fresh(client);
    await client.ok("pes_submit", { results: [{ op: "append_version", object_id: env.object_id, title: "다른 실행의 제출" }], idempotency_key: "r1-run-a-submit" });
    await client.ok("pes_complete", { status: "succeeded", idempotency_key: "r1-run-a-complete" });

    // run B: asks, waits, gets the human's answer as an input and takes the run back
    const b = await claim_fresh(client);
    const asked = await client.ok("pes_ask", ask_args(env, "r1-run-b"));
    await client.ok("pes_wait", { idempotency_key: "r1-run-b-wait" });
    const input = await owner_answers(env, asked, "a");
    await client.ok("pes_claim", { run_id: b.run_id, idempotency_key: "r1-run-b-claim" });

    const sig = state_signature(env.db);
    const out = await client.tool("pes_receipt", { receipts: [{ input_version_id: input, state: "applied", applied_by_key: "r1-run-a-submit" }], idempotency_key: "r1-run-b-receipt-bad" });
    assert.equal(out.is_error, true, "run A's submit cannot prove run B used the input");
    assert.ok(["not_found", "invalid_payload", "conflict"].includes(out.data.error.code), out.data.error.code);
    assert.equal(state_signature(env.db), sig, "refused: nothing written");
    assert.equal(env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM run_input_receipts WHERE state = 'applied'")!.n, 0n);

    // the same run's own submit still counts
    await client.ok("pes_submit", { results: [{ op: "append_version", object_id: env.object_id, title: "이 실행의 제출" }], idempotency_key: "r1-run-b-submit" });
    const good = await client.ok("pes_receipt", { receipts: [{ input_version_id: input, state: "applied", applied_by_key: "r1-run-b-submit" }], idempotency_key: "r1-run-b-receipt-good" });
    assert.deepEqual(good.accepted, [{ input_version_id: input, state: "applied" }]);
  });
});

// ---------------------------------------------------------------------------
// N1: the documents say what the code refuses

/** From the heading line matching `start` up to the next heading of the same or a higher level. */
function section(text: string, start: RegExp): string {
  const lines = text.split("\n");
  const at = lines.findIndex((line) => start.test(line));
  assert.ok(at >= 0, `no heading matches ${start}`);
  const level = /^(#+) /.exec(lines[at]!)![1]!.length;
  let end = lines.length;
  for (let i = at + 1; i < lines.length; i += 1) {
    const m = /^(#+) /.exec(lines[i]!);
    if (m !== null && m[1]!.length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(at, end).join("\n");
}

const APPROVED = /승인(된|해제)?\s*단계|단계.{0,12}승인/;
const SEALED = /봉인(된|해제)?\s*라운드|라운드.{0,12}봉인/;
const SAME_OBJECT = /같은\s*(object|자료)|(object|자료).{0,24}(한 번|두 번|둘 이상|중복)|중복\s*(object|자료)/i;

function assert_import_rules(text: string, where: string): void {
  assert.match(text, /conflict/, `${where}: conflict`);
  assert.match(text, APPROVED, `${where}: approved stage`);
  assert.match(text, SEALED, `${where}: sealed round`);
  assert.match(text, /invalid_payload/, `${where}: invalid_payload`);
  assert.match(text, SAME_OBJECT, `${where}: the same object twice`);
}

test("N1: 8.17 states the import refusals: approved stage and sealed round are conflict, a repeated object is invalid_payload", () => {
  const text = section(read_text("docs", "plan", "stage-2-db-guarantees.md"), /^### 8\.17 /);
  assert_import_rules(text, "8.17");
  assert.match(text, /다시 열|reopen|재개/, "8.17: a human reopens the stage first");
  assert.match(text, /쓰지 않|쓰기 0|아무것도 (쓰|바뀌)/, "8.17: a refusal writes nothing");
});

test("N1: claude-app.md's refusal list is not a closed list that leaves out conflict and the repeated object", () => {
  const text = read_text("docs", "adapters", "claude-app.md");
  assert_import_rules(text, "claude-app.md");
  assert.match(text, /다시 열|reopen|재개/, "claude-app.md: how the person gets out of a conflict");
});

test("N1: adapter-contract.md lists the same refusals in section 6 and the receipt rule in 2.4", () => {
  const text = read_text("docs", "adapters", "adapter-contract.md");
  assert_import_rules(section(text, /^## 6\. /), "adapter-contract.md 6");
  const receipts = section(text, /^### 2\.4 /);
  assert.match(receipts, /applied_by_key/);
  assert.match(receipts, /pes_submit/, "2.4: only a result submission is evidence");
  assert.match(receipts, /heartbeat/, "2.4: a heartbeat key is not evidence");
  assert.match(receipts, /not_found/, "2.4: the code a non-submit key gets");
  assert.match(receipts, /다른\s*(실행|run)|같은\s*(실행|run)|이 (실행|run)/, "2.4: the submit must be of this run (or the limit is written down)");
});

test("N1: openapi RunImport names the 409 cases and the 400 for a repeated object", () => {
  const yaml = read_text("docs", "api", "openapi-v1.yaml");
  const lines = yaml.split("\n");
  const at = lines.findIndex((line) => /^ {4}RunImport:\s*$/.test(line));
  assert.ok(at >= 0, "RunImport schema exists");
  let end = lines.length;
  for (let i = at + 1; i < lines.length; i += 1) {
    if (/^ {4}\S/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  const text = lines.slice(at, end).join("\n");
  assert.match(text, /409|conflict/, "RunImport: 409 conflict");
  assert.match(text, /approved|승인/, "RunImport: approved stage");
  assert.match(text, /sealed|봉인/, "RunImport: sealed round");
  assert.match(text, /400|invalid_payload/, "RunImport: 400 invalid_payload");
  assert.match(text, /same object|each object|once|twice|duplicate|한 번|두 번|같은 (object|자료)|중복/i, "RunImport: a repeated object");
});
