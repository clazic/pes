// Harness for the HTTP API tests (stage 2 PR13). Everything is synthetic: invented slugs, bytes, and
// tokens made by the PR10 token command; a temporary HOME/PES_HOME and a FakeClock.
//
// Interface the tests pin (the worker implements it in scripts/pes_core/api.ts):
//
//   new ApiApp({ db, clock, objects_dir, local_session_secret, sleep?, new_id? })
//   await app.handle({ method, path, headers, body }) -> { status, headers, json, bytes }
//
//   request.headers  lower-case names -> string
//   request.body     string | Uint8Array | null   (raw bytes; the app parses JSON itself)
//   response.json    parsed JSON object, or null when the body is raw bytes / empty
//   response.bytes   Uint8Array for a raw body (file content), else null
//
// Credentials, resolved per request (never cached between requests):
//   Authorization: Bearer <agent token>   -> PR10 verify_agent_token / resolve_actor
//   x-pes-session: <local_session_secret> -> the project's human owner (local session; PR14 completes
//                                             the human-session model). For POST /api/v1/projects it
//                                             is the only credential that exists.
//
// Success body:  { format_version: "1.0", request_id, data, replayed? }   (replayed on POST only)
// Error body:    { format_version: "1.0", error: { code, message, retryable, target, details,
//                  next_action }, request_id }

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { issue_agent_token } from "../../scripts/pes_core/actors.ts";
import { ApiApp } from "../../scripts/pes_core/api.ts";
import { set_policy } from "../../scripts/pes_core/policy.ts";
import { make_env, type Env } from "./blob_env.ts";
import type { Db } from "../../scripts/pes_core/db.ts";

export const SESSION_SECRET = "synthetic-local-session-secret";
const HERE = dirname(fileURLToPath(import.meta.url));
export const API_FIXTURE_DIR = resolve(HERE, "..", "fixtures", "contracts", "api");
export const OPENAPI_PATH = resolve(HERE, "..", "..", "docs", "api", "openapi-v1.yaml");

export interface ApiResponse {
  status: number;
  headers: Record<string, string>;
  json: any;
  bytes: Uint8Array | null;
}

export type Auth = "none" | "owner" | { token: string };

export interface Gate {
  ms: number;
  release(): void;
}

export interface Agent {
  actor_id: string;
  token: string;
  token_id: string;
}

export interface ApiEnv extends Env {
  app: ApiApp;
  /** When true, the app's injected sleep() stays pending until a gate is released. */
  hold_sleep: boolean;
  gates: Gate[];
  /** Times db.exec saw BEGIN (i.e. transactions the app opened) through the wrapped handle. */
  begin_count(): number;
  agents: Map<string, Agent>;
  seq: number;
}

export const ALL_AGENT_SCOPES = [
  "context:read",
  "run:claim",
  "run:submit",
  "file:write",
  "file:read",
] as const;

export interface MakeApiOptions {
  /** Wrap the database handed to the app (failure injection). The env keeps the plain handle. */
  wrap?: (db: Db) => Db;
}

export async function make_api_env(options: MakeApiOptions = {}): Promise<ApiEnv> {
  const base = await make_env();
  let begins = 0;
  const counting: Db = {
    path: base.db.path,
    exec: (sql) => {
      if (/^\s*BEGIN/i.test(sql)) begins += 1;
      return base.db.exec(sql);
    },
    prepare: (sql) => base.db.prepare(sql),
    run: (sql, ...params) => base.db.run(sql, ...params),
    get: (sql, ...params) => base.db.get(sql, ...params),
    all: (sql, ...params) => base.db.all(sql, ...params),
    close: () => base.db.close(),
  };
  const app_db = options.wrap === undefined ? counting : options.wrap(counting);
  const env = base as ApiEnv;
  env.hold_sleep = false;
  env.gates = [];
  env.agents = new Map();
  env.seq = 0;
  env.begin_count = () => begins;
  env.app = new ApiApp({
    db: app_db,
    clock: base.clock,
    objects_dir: base.objects,
    local_session_secret: SESSION_SECRET,
    sleep: (ms: number) =>
      env.hold_sleep
        ? new Promise<void>((done) => {
            env.gates.push({ ms, release: done });
          })
        : Promise.resolve(),
  });
  return env;
}

export async function with_api(
  fn: (env: ApiEnv) => Promise<void> | void,
  options: MakeApiOptions = {},
): Promise<void> {
  const env = await make_api_env(options);
  try {
    await fn(env);
  } finally {
    env.close();
  }
}

/** A synthetic agent actor of the owner's user plus a project token with the given scopes. */
export async function make_agent(
  env: ApiEnv,
  name: string,
  scopes: readonly string[] = ALL_AGENT_SCOPES,
  kind: "external_agent" | "internal_ai" = "external_agent",
): Promise<Agent> {
  const user = env.db.get<{ owner_user_id: string }>(
    "SELECT owner_user_id FROM projects WHERE id = ?",
    env.p.project_id,
  );
  assert.ok(user);
  const actor_id = `agent-${name}`;
  env.db.run(
    "INSERT INTO actors (id, kind, user_id, display_name) VALUES (?, ?, ?, ?)",
    actor_id,
    kind,
    user.owner_user_id,
    `합성 ${name}`,
  );
  const out = await issue_agent_token(env.service, env.ctx(`tok-${name}`), {
    actor_id,
    scopes: [...scopes],
  });
  const r = out.result as { token: string; token_id: string };
  const agent = { actor_id, token: r.token, token_id: r.token_id };
  env.agents.set(name, agent);
  return agent;
}

export interface CallInput {
  method: string;
  path: string;
  auth?: Auth;
  /** Idempotency-Key for a mutating call; auto-generated when omitted, header left out when null. */
  key?: string | null;
  body?: unknown;
  /** Raw body (bytes or already-encoded text); wins over body. */
  raw?: string | Uint8Array;
  headers?: Record<string, string>;
}

export function project_path(env: ApiEnv, rest = ""): string {
  return `/api/v1/projects/${env.p.project_id}${rest}`;
}

export async function call(env: ApiEnv, input: CallInput): Promise<ApiResponse> {
  const headers: Record<string, string> = { ...(input.headers ?? {}) };
  const auth = input.auth ?? "none";
  if (auth === "owner") headers["x-pes-session"] = SESSION_SECRET;
  else if (auth !== "none") headers["authorization"] = `Bearer ${auth.token}`;
  let body: string | Uint8Array | null = null;
  if (input.raw !== undefined) {
    body = input.raw;
  } else if (input.body !== undefined) {
    body = JSON.stringify(input.body);
    headers["content-type"] ??= "application/json";
  }
  const method = input.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD" && input.key !== null) {
    env.seq += 1;
    headers["idempotency-key"] ??= input.key ?? `api-key-${env.seq}`;
  }
  const res = await env.app.handle({ method, path: input.path, headers, body });
  return res as ApiResponse;
}

// ---------------------------------------------------------------------------
// shared assertions

const SQL_LEAK = /SELECT |INSERT |UPDATE |DELETE |sqlite|node_modules|\.ts:\d|at \S+ \(/i;

export function assert_ok(res: ApiResponse, status = 200): any {
  assert.equal(res.status, status, `expected ${status}, got ${res.status}: ${JSON.stringify(res.json)}`);
  assert.equal(res.json.format_version, "1.0");
  assert.equal(typeof res.json.request_id, "string");
  assert.ok(res.json.request_id.length > 0);
  assert.notEqual(res.json.data, undefined);
  return res.json.data;
}

export function assert_error(res: ApiResponse, status: number, code: string): any {
  assert.equal(res.status, status, `expected ${status} ${code}, got ${res.status}: ${JSON.stringify(res.json)}`);
  const body = res.json;
  assert.equal(body.format_version, "1.0");
  assert.equal(typeof body.request_id, "string");
  assert.ok(body.request_id.length > 0);
  assert.equal(body.error.code, code);
  assert.equal(typeof body.error.message, "string");
  assert.ok(body.error.message.length > 0);
  assert.equal(typeof body.error.retryable, "boolean");
  assert.ok("target" in body.error && "details" in body.error && "next_action" in body.error);
  assert.equal(body.data, undefined, "an error body carries no data");
  const text = JSON.stringify(body);
  assert.doesNotMatch(text, SQL_LEAK, "an error never leaks SQL, table names, or stack text");
  assert.equal(res.headers["x-request-id"], body.request_id);
  return body.error;
}

export const DECIMAL = /^(0|[1-9][0-9]*)$/;

// ---------------------------------------------------------------------------
// run helpers that go through the HTTP surface

export interface Lease {
  run_id: string;
  lease_id: string;
  fence: string;
}

export async function owner_creates_run(env: ApiEnv, agent: Agent): Promise<string> {
  const res = await call(env, {
    method: "POST",
    path: project_path(env, "/runs"),
    auth: "owner",
    body: { actor_id: agent.actor_id, mode: "B", runtime: "synthetic-runtime", provider: "synthetic", model: "synthetic-model" },
  });
  return assert_ok(res, 201).run_id as string;
}

export async function agent_claims(env: ApiEnv, agent: Agent, run_id?: string): Promise<Lease> {
  const res = await call(env, {
    method: "POST",
    path: project_path(env, "/claims"),
    auth: { token: agent.token },
    body:
      run_id === undefined
        ? { mode: "B", runtime: "synthetic-runtime", provider: "synthetic", model: "synthetic-model" }
        : { run_id },
  });
  const data = assert_ok(res);
  return { run_id: data.run_id, lease_id: data.lease_id, fence: data.fence };
}

/** Owner-side setup through the core command service (not through HTTP). */
export async function go_off(env: ApiEnv): Promise<void> {
  await set_policy(env.service, env.ctx(`go-off-${env.seq++}`), {
    allow_opencode_go: false,
    reason: "합성: Go 끄기",
  });
}

/** One human topic change through the core service: control_rev goes up by 1. */
export async function bump_control_rev(env: ApiEnv): Promise<void> {
  const row = env.db.get<{ control_rev: bigint }>("SELECT control_rev FROM projects WHERE id = ?", env.p.project_id);
  assert.ok(row);
  env.seq += 1;
  await env.service.execute(
    { ...env.ctx(`bump-${env.seq}`), base_control_rev: Number(row.control_rev) },
    "project.set_topic",
    { topic: `합성 주제 ${env.seq}` },
  );
}

// ---------------------------------------------------------------------------
// contract fixtures: tests/fixtures/contracts/api/*.json
//
// { name, description, agents?: {name: {kind?, scopes}}, steps: [
//     { before?: ["go_off"|"bump_rev"],
//       request: { method, path, auth: "none"|"owner"|"agent:<name>", key?, headers?, body? },
//       save?: { var: "data.run_id" },
//       expect: { status, json?, headers_absent?: [..] } } ] }
//
// Strings may use ${project}, ${owner_actor}, ${agent:<name>.actor_id}, ${agent:<name>.token}, and
// variables saved by earlier steps. Expected JSON is a subset match with these placeholders:
//   "$any" "$string" "$dec"(10진 문자열) "$hex64" "$int" "$bool" "$null"
//   { "$array_of": tmpl, "min": n, "max": n }      { "$absent": ["key", ...] } inside an object

export interface ApiFixture {
  name: string;
  description: string;
  agents?: Record<string, { kind?: "external_agent" | "internal_ai"; scopes: string[] }>;
  steps: Array<{
    before?: string[];
    request: { method: string; path: string; auth: string; key?: string | null; headers?: Record<string, string>; body?: unknown };
    save?: Record<string, string>;
    expect: { status: number; json?: unknown; headers_absent?: string[] };
  }>;
}

export function api_fixture_files(): string[] {
  return readdirSync(API_FIXTURE_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();
}

export function load_api_fixture(file: string): ApiFixture {
  return JSON.parse(readFileSync(join(API_FIXTURE_DIR, file), "utf8")) as ApiFixture;
}

function lookup(vars: Map<string, string>, name: string): string {
  const value = vars.get(name);
  assert.ok(value !== undefined, `fixture variable ${name} is not defined`);
  return value;
}

function interpolate(value: unknown, vars: Map<string, string>): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([^}]+)\}/g, (_m, name: string) => lookup(vars, name));
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, vars));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v, vars)]));
  }
  return value;
}

function pick(root: unknown, dotted: string): unknown {
  let cur: any = root;
  for (const part of dotted.split(".")) {
    assert.ok(cur !== null && typeof cur === "object" && part in cur, `no ${dotted} in the response`);
    cur = cur[part];
  }
  return cur;
}

export function match_json(actual: unknown, expected: unknown, where: string): void {
  if (typeof expected === "string" && expected.startsWith("$")) {
    switch (expected) {
      case "$any":
        assert.notEqual(actual, undefined, `${where}: missing`);
        return;
      case "$string":
        assert.equal(typeof actual, "string", `${where}: expected a string`);
        return;
      case "$dec":
        assert.equal(typeof actual, "string", `${where}: a rev/fence must be a string`);
        assert.match(actual as string, DECIMAL, `${where}: not a normalized decimal string`);
        return;
      case "$hex64":
        assert.match(String(actual), /^[0-9a-f]{64}$/, `${where}: not a sha-256 hex`);
        return;
      case "$int":
        assert.ok(Number.isSafeInteger(actual), `${where}: expected a safe integer`);
        return;
      case "$bool":
        assert.equal(typeof actual, "boolean", `${where}: expected a boolean`);
        return;
      case "$null":
        assert.equal(actual, null, `${where}: expected null`);
        return;
      default:
        assert.fail(`${where}: unknown placeholder ${expected}`);
    }
  }
  if (expected !== null && typeof expected === "object" && !Array.isArray(expected)) {
    const spec = expected as Record<string, unknown>;
    if ("$array_of" in spec) {
      assert.ok(Array.isArray(actual), `${where}: expected an array`);
      const list = actual as unknown[];
      if (typeof spec.min === "number") assert.ok(list.length >= spec.min, `${where}: at least ${spec.min} items`);
      if (typeof spec.max === "number") assert.ok(list.length <= spec.max, `${where}: at most ${spec.max} items`);
      list.forEach((item, i) => match_json(item, spec.$array_of, `${where}[${i}]`));
      return;
    }
    assert.ok(actual !== null && typeof actual === "object" && !Array.isArray(actual), `${where}: expected an object`);
    const record = actual as Record<string, unknown>;
    for (const [key, value] of Object.entries(spec)) {
      if (key === "$absent") {
        for (const name of value as string[]) assert.ok(!(name in record), `${where}: ${name} must be absent`);
        continue;
      }
      assert.ok(key in record, `${where}: missing key ${key}`);
      match_json(record[key], value, `${where}.${key}`);
    }
    return;
  }
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${where}: expected an array`);
    const list = actual as unknown[];
    assert.equal(list.length, expected.length, `${where}: array length`);
    expected.forEach((item, i) => match_json(list[i], item, `${where}[${i}]`));
    return;
  }
  assert.deepEqual(actual, expected, `${where}`);
}

export async function run_api_fixture(env: ApiEnv, fixture: ApiFixture): Promise<void> {
  const vars = new Map<string, string>([
    ["project", env.p.project_id],
    ["owner_actor", env.p.actor_id],
  ]);
  for (const [name, spec] of Object.entries(fixture.agents ?? {})) {
    const agent = await make_agent(env, name, spec.scopes, spec.kind ?? "external_agent");
    vars.set(`agent:${name}.actor_id`, agent.actor_id);
    vars.set(`agent:${name}.token`, agent.token);
  }
  for (const [i, step] of fixture.steps.entries()) {
    for (const action of step.before ?? []) {
      if (action === "go_off") await go_off(env);
      else if (action === "bump_rev") await bump_control_rev(env);
      else assert.fail(`unknown fixture action ${action}`);
    }
    const req = interpolate(step.request, vars) as ApiFixture["steps"][number]["request"];
    let auth: Auth = "none";
    if (req.auth === "owner") auth = "owner";
    else if (req.auth.startsWith("agent:")) {
      auth = { token: lookup(vars, `${req.auth}.token`) };
    } else assert.equal(req.auth, "none");
    const res = await call(env, {
      method: req.method,
      path: req.path,
      auth,
      key: req.key,
      headers: req.headers,
      body: req.body,
    });
    const where = `${fixture.name} step ${i + 1} ${req.method} ${req.path}`;
    assert.equal(res.status, step.expect.status, `${where}: status (${JSON.stringify(res.json)})`);
    if (step.expect.json !== undefined) match_json(res.json, interpolate(step.expect.json, vars), where);
    for (const name of step.expect.headers_absent ?? []) {
      assert.equal(res.headers[name.toLowerCase()], undefined, `${where}: header ${name} must be absent`);
    }
    for (const [name, dotted] of Object.entries(step.save ?? {})) {
      vars.set(name, String(pick(res.json, dotted)));
    }
  }
}

