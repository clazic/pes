/**
 * SEL-46 PR13 — 정정·회귀 시험 (tester, 1차 리뷰 r1-1 의 leader 결정을 고정한다).
 *
 * 1) claim rev 검사는 run.claim 명령 안(영수증 재생 뒤): 같은 키 재시도는 그사이 rev 가 바뀌어도 원래 결과를 재생,
 *    새 키 + 낡은 rev 는 409.  2) 업로드 PUT 은 Idempotency-Key 없이 성공.
 * 3) 10진 rev 규칙 하나: 형식 틀림 400, 형식 맞음 + 불일치 409 rev_conflict (claims·results 같음, 2^53 이상·int64 초과 포함).
 * 4) POST /runs mode A + Go OFF → 403.  5) wait 재생은 sleep 안 함.
 * 7) 브리지는 요청마다 migrate 하지 않는다.  8) OpenAPI 요청 본문 스키마.
 * 합성 자료만 쓴다.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { ApiError } from "../scripts/pes_core/errors.ts";
import { claim } from "../scripts/pes_core/runs.ts";
import { connect, migrate } from "../scripts/pes_core/db.ts";
import { db_path } from "../scripts/pes_core/paths.ts";
import { sha256_hex } from "./helpers/backup_fixture.ts";
import {
  OPENAPI_PATH,
  agent_claims,
  api_fixture_files,
  assert_error,
  assert_ok,
  bump_control_rev,
  call,
  go_off,
  load_api_fixture,
  make_agent,
  project_path,
  with_api,
  type ApiEnv,
  type Lease,
} from "./helpers/api_env.ts";
import { bytes_of, new_artifact } from "./helpers/blob_env.ts";
import { isolated_home } from "./helpers/isolated_home.ts";
import { parse_yaml, resolve_ref, validate } from "./helpers/mini_yaml.ts";
import { state_signature } from "./helpers/state_signature.ts";

const P = (env: ApiEnv, rest = "") => project_path(env, rest);
const FRESH = { mode: "B", runtime: "synthetic-runtime", provider: "synthetic", model: "synthetic-model" };

async function claim_call(env: ApiEnv, token: string, body: Record<string, unknown>, key?: string) {
  return call(env, { method: "POST", path: P(env, "/claims"), auth: { token }, key, body });
}

/** One real append_version item: an empty results list is itself a 400, which would hide the rev rule. */
async function one_item(env: ApiEnv, name: string) {
  const made = await new_artifact(env, name);
  return [{ op: "append_version", object_id: made.object_id, title: "합성 항목" }];
}

function results_call(env: ApiEnv, token: string, lease: Lease, results: unknown, extra: Record<string, unknown> = {}, key?: string) {
  return call(env, {
    method: "POST",
    path: P(env, `/runs/${lease.run_id}/results`),
    auth: { token },
    key,
    body: { lease_id: lease.lease_id, fence: lease.fence, results, ...extra },
  });
}

// ---------------------------------------------------------------------------
// 1) claim: rev 검사는 명령 안, 영수증 재생 뒤

test("claim: the same Idempotency-Key replays the original success after control_rev moved; a new key with the old rev is 409", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "replay");
    const body = { ...FRESH, expected_control_rev: "0" };
    const first = await claim_call(env, agent.token, body, "claim-replay-1");
    const lease = assert_ok(first);
    assert.equal(first.json.replayed, false);
    await bump_control_rev(env); // control_rev 0 -> 1 between the two attempts
    const before = state_signature(env.db);
    const again = await claim_call(env, agent.token, body, "claim-replay-1");
    const replay = assert_ok(again);
    assert.equal(again.json.replayed, true, "the retry is a replay, not a 409");
    assert.equal(replay.run_id, lease.run_id);
    assert.equal(replay.lease_id, lease.lease_id);
    assert.equal(replay.fence, lease.fence);
    assert.equal(state_signature(env.db), before, "a replay writes nothing");
  });
});

test("claim by run_id: the same key replays after control_rev moved too", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "replayrun");
    const made = await call(env, {
      method: "POST",
      path: P(env, "/runs"),
      auth: "owner",
      body: { actor_id: agent.actor_id, ...FRESH },
    });
    const run_id = assert_ok(made, 201).run_id as string;
    const body = { run_id, expected_control_rev: "0" };
    const first = assert_ok(await claim_call(env, agent.token, body, "claim-replay-run"));
    await bump_control_rev(env);
    const again = await claim_call(env, agent.token, body, "claim-replay-run");
    const replay = assert_ok(again);
    assert.equal(again.json.replayed, true);
    assert.equal(replay.lease_id, first.lease_id);
    assert.equal(replay.fence, first.fence);
  });
});

test("claim: a NEW key with the old rev is 409 rev_conflict with exact strings and writes nothing", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "stalekey");
    await bump_control_rev(env); // control_rev is 1
    const before = state_signature(env.db);
    const res = await claim_call(env, agent.token, { ...FRESH, expected_control_rev: "0" }, "claim-new-key");
    const error = assert_error(res, 409, "rev_conflict");
    assert.equal(error.details.expected, "0");
    assert.equal(error.details.current, "1");
    assert.equal(state_signature(env.db), before);
  });
});

test("run.claim (core): base_control_rev is checked inside the command, after the receipt replay", async () => {
  await with_api(async (env: ApiEnv) => {
    const agent = await make_agent(env, "corereplay");
    const ctx = (key: string, base?: number) => ({
      project_id: env.p.project_id,
      actor_id: agent.actor_id,
      via: "http" as const,
      client_request_id: key,
      ...(base === undefined ? {} : { base_control_rev: base }),
    });
    // a stale base on a fresh key is rejected and leaves nothing
    await bump_control_rev(env); // rev 1
    const before = state_signature(env.db);
    await assert.rejects(
      claim(env.service, ctx("core-stale", 0), FRESH),
      (error: unknown) => error instanceof ApiError && error.code === "rev_conflict",
    );
    assert.equal(state_signature(env.db), before, "no run, lease, receipt, or event");
    // the current base succeeds ...
    const first = await claim(env.service, ctx("core-ok", 1), FRESH);
    assert.equal(first.replayed, false);
    await bump_control_rev(env); // rev 2
    // ... and the same key with the same (now old) base replays the original result
    const again = await claim(env.service, ctx("core-ok", 1), FRESH);
    assert.equal(again.replayed, true);
    assert.deepEqual(again.result, first.result);
    // a different key with the old base is stale
    await assert.rejects(
      claim(env.service, ctx("core-other", 1), FRESH),
      (error: unknown) => error instanceof ApiError && error.code === "rev_conflict",
    );
  });
});

// ---------------------------------------------------------------------------
// 2) 업로드 PUT 은 Idempotency-Key 없이 성공

test("upload PUT works without an Idempotency-Key (the docs list none) and the blob then completes", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "putnokey");
    const bytes = bytes_of("put-without-key");
    const reserved = assert_ok(
      await call(env, {
        method: "POST",
        path: P(env, "/uploads"),
        auth: { token: agent.token },
        body: { sha256: sha256_hex(bytes), size: bytes.byteLength, media_type: "application/octet-stream", original_name: "합성.bin" },
      }),
      201,
    );
    const put = await call(env, {
      method: "PUT",
      path: P(env, `/uploads/${reserved.blob_id}`),
      auth: { token: agent.token },
      key: null,
      raw: bytes,
      headers: { "content-type": "application/octet-stream" },
    });
    assert.equal(put.json?.error, undefined, JSON.stringify(put.json));
    assert_ok(put);
    const done = assert_ok(
      await call(env, { method: "POST", path: P(env, `/uploads/${reserved.blob_id}/complete`), auth: { token: agent.token }, body: {} }),
    );
    assert.equal(done.state, "ready");
  });
});

// ---------------------------------------------------------------------------
// 3) 10진 rev 규칙 하나

const BAD_REV_FORMS: unknown[] = [
  "", " ", "00", "01", "-1", "-0", "+1", "+0", "1.0", "1.", ".5", "1e3", "0x10", " 1", "1 ", "\n1", "1\n", "１", "١", "1_0",
  0, 5, -1, 1.5, 1e21, true, null, [], {}, ["0"],
];
// 형식은 맞고 저장된 rev(0)와 다르다: 안전 정수 경계, 2^53 전후(표현 가능·불가능), int64 경계 위
const MISMATCH_REVS = [
  "1",
  "9007199254740991",
  "9007199254740992",
  "9007199254740993",
  "9007199254740994",
  "9223372036854775807",
  "9223372036854775808",
  "18446744073709551616",
  "99999999999999999999999999",
];

test("expected_control_rev: a malformed value is 400 on both claims and results, and nothing is written", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "badrev");
    const lease = await agent_claims(env, agent);
    const other = await make_agent(env, "badrev2");
    const items = await one_item(env, "badrev");
    const before = state_signature(env.db);
    for (const rev of BAD_REV_FORMS) {
      assert_error(await claim_call(env, other.token, { ...FRESH, expected_control_rev: rev }), 400, "invalid_payload");
      assert_error(await results_call(env, agent.token, lease, items, { expected_control_rev: rev }), 400, "invalid_payload");
    }
    assert.equal(state_signature(env.db), before);
  });
});

test("expected_control_rev: a well-formed but different value is 409 rev_conflict on claims AND results, at every size", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "mismatch");
    const lease = await agent_claims(env, agent);
    const other = await make_agent(env, "mismatch2");
    const items = await one_item(env, "mismatch");
    const before = state_signature(env.db);
    for (const rev of MISMATCH_REVS) {
      const claims = assert_error(await claim_call(env, other.token, { ...FRESH, expected_control_rev: rev }), 409, "rev_conflict");
      assert.equal(claims.details.expected, rev, `claims ${rev}`);
      assert.equal(claims.details.current, "0");
      const results = assert_error(await results_call(env, agent.token, lease, items, { expected_control_rev: rev }), 409, "rev_conflict");
      assert.equal(results.details.expected, rev, `results ${rev}`);
      assert.equal(results.details.current, "0");
    }
    assert.equal(state_signature(env.db), before);
  });
});

test("expected_control_rev beyond 2^53 against a stored rev beyond 2^53: 409 with exact strings on claims and results", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "bigstored");
    const lease = await agent_claims(env, agent);
    const other = await make_agent(env, "bigstored2");
    const items = await one_item(env, "bigstored");
    env.db.run("UPDATE projects SET control_rev = 9007199254740993 WHERE id = ?", env.p.project_id);
    for (const rev of ["9007199254740992", "9007199254740994"]) {
      const claims = assert_error(await claim_call(env, other.token, { ...FRESH, expected_control_rev: rev }), 409, "rev_conflict");
      assert.equal(claims.details.expected, rev);
      assert.equal(claims.details.current, "9007199254740993");
      const results = assert_error(await results_call(env, agent.token, lease, items, { expected_control_rev: rev }), 409, "rev_conflict");
      assert.equal(results.details.expected, rev);
      assert.equal(results.details.current, "9007199254740993");
    }
  });
});

test("the matching rev still passes on claims and results (current rev as a decimal string)", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "matchrev");
    await bump_control_rev(env);
    const lease = assert_ok(await claim_call(env, agent.token, { ...FRESH, expected_control_rev: "1" }));
    assert.equal(typeof lease.fence, "string");
    const items = await one_item(env, "matchrev");
    assert_ok(await results_call(env, agent.token, { run_id: lease.run_id, lease_id: lease.lease_id, fence: lease.fence }, items, { expected_control_rev: "1" }));
  });
});

// ---------------------------------------------------------------------------
// 4) POST /runs mode A + Go OFF

test("POST /runs mode A with Go OFF is 403 policy_blocked and writes nothing; mode B and Go ON still work", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "goruns", undefined, "internal_ai");
    const mode_a = { actor_id: agent.actor_id, mode: "A", runtime: "synthetic-runtime", provider: "opencode-go", model: "opencode-go/synthetic" };
    await go_off(env);
    const before = state_signature(env.db);
    const denied = await call(env, { method: "POST", path: P(env, "/runs"), auth: "owner", body: mode_a });
    const error = assert_error(denied, 403, "policy_blocked");
    assert.equal(error.retryable, false);
    assert.equal(state_signature(env.db), before, "no run, receipt, or event");
    // mode B is not a Go run
    assert_ok(await call(env, { method: "POST", path: P(env, "/runs"), auth: "owner", body: { ...mode_a, mode: "B", provider: "synthetic", model: "synthetic-model" } }), 201);
  });
  await with_api(async (env) => {
    const agent = await make_agent(env, "goon", undefined, "internal_ai");
    const mode_a = { actor_id: agent.actor_id, mode: "A", runtime: "synthetic-runtime", provider: "opencode-go", model: "opencode-go/synthetic" };
    assert_ok(await call(env, { method: "POST", path: P(env, "/runs"), auth: "owner", body: mode_a }), 201);
  });
});

// ---------------------------------------------------------------------------
// 5) wait 재생은 sleep 하지 않는다

test("wait: replaying the same key does not call sleep again (the injected sleep ran once)", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "waitreplay");
    const lease = await agent_claims(env, agent);
    const path = P(env, `/runs/${lease.run_id}/wait`);
    const body = { lease_id: lease.lease_id, fence: lease.fence, wait_ms: 5_000 };
    const tick = async () => {
      for (let i = 0; i < 100; i += 1) await new Promise((r) => setImmediate(r));
    };
    env.hold_sleep = true;
    const first = call(env, { method: "POST", path, auth: { token: agent.token }, key: "wait-replay-1", body });
    for (let i = 0; i < 200 && env.gates.length === 0; i += 1) await new Promise((r) => setImmediate(r));
    assert.equal(env.gates.length, 1, "the first wait sleeps once");
    env.gates[0].release();
    const first_res = await first;
    assert_ok(first_res);
    assert.equal(first_res.json.replayed, false);

    const retry = call(env, { method: "POST", path, auth: { token: agent.token }, key: "wait-replay-1", body });
    await tick();
    const slept = env.gates.length;
    for (const gate of env.gates) gate.release(); // never leave the retry hanging
    const retry_res = await retry;
    assert.equal(slept, 1, "the replay did not park on a second sleep");
    assert_ok(retry_res);
    assert.equal(retry_res.json.replayed, true);
  });
});

// ---------------------------------------------------------------------------
// 7) 브리지는 요청마다 migrate 하지 않는다

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIDGE = resolve(HERE, "..", "scripts", "pes_core", "api_bridge.ts");

function run_bridge(env: Record<string, string | undefined>, request: Record<string, unknown>) {
  const child = spawnSync(process.execPath, [BRIDGE], {
    input: JSON.stringify(request),
    env: { ...env, PES_LOCAL_SESSION_SECRET: "synthetic-bridge-secret" },
    encoding: "utf8",
    timeout: 60_000,
  });
  return child;
}

function schema_snapshot(db_file: string): string {
  const db = connect(db_file);
  try {
    const meta = db.get<{ schema_version: bigint }>("SELECT schema_version FROM db_meta WHERE id = 1");
    const tables = db.all<{ name: string; sql: string | null }>("SELECT name, sql FROM sqlite_master ORDER BY name");
    return JSON.stringify({ version: String(meta?.schema_version), tables });
  } finally {
    db.close();
  }
}

const CONTEXT_REQUEST = { method: "GET", path: "/api/v1/projects/no-such-project/context", headers: {}, body_b64: null };

test("bridge: a current database is left exactly as it was by a request", () => {
  const home = isolated_home("pes-sel46-bridge-");
  try {
    const file = db_path(home.env);
    const setup = connect(file);
    try {
      migrate(setup);
    } finally {
      setup.close();
    }
    const before = schema_snapshot(file);
    const child = run_bridge(home.env, CONTEXT_REQUEST);
    assert.equal(child.status, 0, child.stderr);
    const out = JSON.parse(child.stdout) as { status: number; body_b64: string };
    // PR14: credentials are checked before the project lookup, so an unauthenticated request is 401 even for an
    // unknown project. The point of this test is unchanged: a current database answers and is not migrated.
    assert.equal(out.status, 401);
    assert.equal(schema_snapshot(file), before);
  } finally {
    home.cleanup();
  }
});

test("bridge: an unmigrated database (schema older than any known version) is NOT migrated by a request; the answer is a clear error, not a crash or a 500", () => {
  const home = isolated_home("pes-sel46-bridge-old-");
  try {
    const file = db_path(home.env);
    mkdirSync(dirname(file), { recursive: true });
    connect(file).close(); // an empty database file: no db_meta, no tables
    const child = run_bridge(home.env, CONTEXT_REQUEST);
    assert.equal(child.status, 0, `the bridge answers instead of crashing: ${child.stderr}`);
    const out = JSON.parse(child.stdout) as { status: number; body_b64: string };
    const body = JSON.parse(Buffer.from(out.body_b64, "base64").toString("utf8"));
    assert.ok(out.status >= 400 && out.status !== 500, `got ${out.status}`);
    assert.equal(typeof body.error?.code, "string");
    assert.notEqual(body.error.code, "internal_error");
    assert.notEqual(body.error.code, "not_found", "the missing schema is reported, not hidden behind a 404");
    assert.doesNotMatch(JSON.stringify(body), /SELECT |INSERT |sqlite|node_modules|\.ts:\d/i);
    assert.doesNotMatch(child.stderr, /node_modules|\.ts:\d/, "no stack on stderr");
    const after = connect(file);
    try {
      assert.deepEqual(
        after.all("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'"),
        [],
        "the request created no table",
      );
    } finally {
      after.close();
    }
  } finally {
    home.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 8) OpenAPI 요청 본문 스키마

const OPENAPI: any = parse_yaml(readFileSync(OPENAPI_PATH, "utf8"));

function operation(path: string, method: string): any {
  const op = OPENAPI.paths?.[path]?.[method];
  assert.ok(op, `${method.toUpperCase()} ${path} is documented`);
  return op;
}

function body_schema(path: string, method = "post"): any {
  const body = resolve_ref(OPENAPI, operation(path, method).requestBody);
  assert.ok(body, `${method.toUpperCase()} ${path} has a requestBody`);
  const media = body.content?.["application/json"];
  assert.ok(media?.schema, `${method.toUpperCase()} ${path} has an application/json request schema`);
  return media.schema;
}

const FENCE = "1";
const LEASE = { lease_id: "lease-1", fence: FENCE };
const EXAMPLES: Array<{ name: string; path: string; ok: Record<string, unknown>[]; required: string[]; strings: string[] }> = [
  {
    name: "projects",
    path: "/api/v1/projects",
    ok: [{ slug: "synthetic-slug", topic: "합성 주제", owner_display_name: "합성 소유자" }],
    required: ["slug", "topic", "owner_display_name"],
    strings: [],
  },
  {
    name: "runs",
    path: "/api/v1/projects/{id}/runs",
    ok: [{ actor_id: "agent-1", mode: "B", runtime: "r", provider: "p", model: "m" }],
    required: ["actor_id", "mode", "runtime", "provider", "model"],
    strings: [],
  },
  {
    name: "claims",
    path: "/api/v1/projects/{id}/claims",
    ok: [
      { mode: "B", runtime: "r", provider: "p", model: "m", expected_control_rev: "0" },
      { mode: "B", runtime: "r", provider: "p", model: "m" },
      { run_id: "run-1", expected_control_rev: "12" },
      { run_id: "run-1" },
    ],
    required: [],
    strings: ["expected_control_rev"],
  },
  {
    name: "wait",
    path: "/api/v1/projects/{id}/runs/{r}/wait",
    ok: [{ ...LEASE }, { ...LEASE, reason: "합성 이유", wait_ms: 1000 }],
    required: ["lease_id", "fence"],
    strings: ["fence"],
  },
  {
    name: "results",
    path: "/api/v1/projects/{id}/runs/{r}/results",
    ok: [
      { ...LEASE, results: [] },
      { ...LEASE, results: [{ op: "append_version", object_id: "obj-1", title: "합성" }], expected_control_rev: "3" },
    ],
    required: ["lease_id", "fence", "results"],
    strings: ["fence", "expected_control_rev"],
  },
  {
    name: "complete",
    path: "/api/v1/projects/{id}/runs/{r}/complete",
    ok: [{ ...LEASE }, { ...LEASE, status: "failed" }],
    required: ["lease_id", "fence"],
    strings: ["fence"],
  },
  {
    name: "uploads",
    path: "/api/v1/projects/{id}/uploads",
    ok: [
      { sha256: "a".repeat(64), size: 3, media_type: "application/octet-stream" },
      { sha256: "a".repeat(64), size: 3, media_type: "application/octet-stream", original_name: "합성.bin" },
    ],
    required: ["sha256", "size", "media_type"],
    strings: [],
  },
  {
    name: "upload complete",
    path: "/api/v1/projects/{id}/uploads/{b}/complete",
    ok: [{}],
    required: [],
    strings: [],
  },
];

test("OpenAPI: every JSON POST operation documents a request body schema", () => {
  const missing: string[] = [];
  for (const [path, item] of Object.entries<any>(OPENAPI.paths)) {
    if (item.post === undefined) continue;
    const body = resolve_ref(OPENAPI, item.post.requestBody);
    if (body?.content?.["application/json"]?.schema === undefined) missing.push(path);
  }
  assert.deepEqual(missing, []);
  assert.equal(EXAMPLES.length, 8, "the example table covers all eight POST routes");
});

function closed_objects(schema_in: any, where: string): string[] {
  const schema = resolve_ref(OPENAPI, schema_in);
  const out: string[] = [];
  for (const key of ["oneOf", "anyOf", "allOf"]) {
    if (Array.isArray(schema[key])) schema[key].forEach((sub: any, i: number) => out.push(...closed_objects(sub, `${where}.${key}[${i}]`)));
  }
  if (schema.type === "object" && schema.additionalProperties !== false) out.push(where);
  return out;
}

test("OpenAPI: every request body schema is closed (additionalProperties: false)", () => {
  for (const example of EXAMPLES) {
    assert.deepEqual(closed_objects(body_schema(example.path), example.name), [], `${example.name} request schema`);
  }
});

test("OpenAPI: each request example passes its documented schema", () => {
  for (const example of EXAMPLES) {
    const schema = body_schema(example.path);
    for (const [i, body] of example.ok.entries()) {
      assert.deepEqual(validate(OPENAPI, schema, body), [], `${example.name} example ${i}`);
    }
  }
});

test("OpenAPI: the contract fixtures' successful request bodies pass their documented schemas", () => {
  let checked = 0;
  for (const file of api_fixture_files()) {
    const fixture = load_api_fixture(file);
    for (const step of fixture.steps) {
      if (step.expect.status >= 300 || step.request.body === undefined) continue;
      const method = step.request.method.toLowerCase();
      if (method !== "post") continue;
      const concrete = step.request.path;
      const found = Object.entries<any>(OPENAPI.paths).find(([template, item]) => {
        if (item.post === undefined) return false;
        const pattern = new RegExp("^" + template.replace(/\{[^}]+\}/g, "[^/]+") + "$");
        return pattern.test(concrete.replace(/\$\{[^}]+\}/g, "x"));
      });
      assert.ok(found, `${file}: ${concrete} is a documented route`);
      assert.deepEqual(validate(OPENAPI, body_schema(found[0]), step.request.body), [], `${file}: ${concrete}`);
      checked += 1;
    }
  }
  assert.ok(checked >= 4, `checked ${checked} fixture bodies`);
});

test("OpenAPI: an unknown field, a missing required field, or a numeric fence/rev is rejected by the documented schema", () => {
  for (const example of EXAMPLES) {
    const schema = body_schema(example.path);
    for (const [i, body] of example.ok.entries()) {
      assert.notDeepEqual(validate(OPENAPI, schema, { ...body, surprise: 1 }), [], `${example.name} #${i}: unknown field`);
      assert.notDeepEqual(validate(OPENAPI, schema, { ...body, __proto__x: true }), [], `${example.name} #${i}: unknown field 2`);
    }
    const full = example.ok[example.ok.length - 1];
    for (const name of example.required) {
      const { [name]: _dropped, ...rest } = full;
      assert.notDeepEqual(validate(OPENAPI, schema, rest), [], `${example.name}: ${name} is required`);
    }
    for (const name of example.strings) {
      const body = example.ok.find((b) => name in b);
      assert.ok(body, `${example.name}: an example carries ${name}`);
      assert.notDeepEqual(validate(OPENAPI, schema, { ...body, [name]: 1 }), [], `${example.name}: ${name} must be a string`);
    }
  }
  // the two claim shapes do not mix
  const claims = body_schema("/api/v1/projects/{id}/claims");
  assert.notDeepEqual(validate(OPENAPI, claims, { run_id: "r", mode: "B", runtime: "r", provider: "p", model: "m" }), []);
});

test("OpenAPI: the upload PUT is a raw-bytes operation that needs no Idempotency-Key; every POST still does", () => {
  const put = operation("/api/v1/projects/{id}/uploads/{b}", "put");
  const params = (put.parameters ?? []).map((p: any) => resolve_ref(OPENAPI, p));
  assert.ok(!params.some((p: any) => p.name === "Idempotency-Key" && p.required === true), "PUT needs no Idempotency-Key");
  const content = resolve_ref(OPENAPI, put.requestBody)?.content ?? {};
  assert.ok(!("application/json" in content), "the PUT body is raw bytes, not JSON");
  // SEL-118 (leader approved): a POST that is only a read (the body carries input that exists in the client alone) is named here
  // and must say so: it writes nothing, so it does not take an Idempotency-Key.
  const READ_ONLY_POSTS = ["/api/v1/projects/{id}/prompt-builds"];
  for (const [path, item] of Object.entries<any>(OPENAPI.paths)) {
    if (item.post === undefined) continue;
    const posts = (item.post.parameters ?? []).map((p: any) => resolve_ref(OPENAPI, p));
    if (READ_ONLY_POSTS.includes(path)) {
      assert.equal(item.post["x-pes-read-only"], true, `POST ${path} is documented as read-only`);
      assert.ok(!posts.some((p: any) => p.name === "Idempotency-Key"), `read-only POST ${path} does not take an Idempotency-Key`);
      continue;
    }
    assert.ok(posts.some((p: any) => p.name === "Idempotency-Key" && p.required === true), `POST ${path} requires Idempotency-Key`);
  }
});
