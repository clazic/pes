/**
 * SEL-47 PR14 — HTTP API: the finished error envelope, authentication order, request limits, and the
 * completeness of capabilities and of the route list (tester, 작성 모드).
 *
 *   Error envelope: see tests/helpers/api_flow.ts (Korean message, retryable, target, next_action).
 *   Order of checks on every project route: route and method (404/405) -> credential (401) -> project
 *   (404) -> kind of actor / scope (403) -> Idempotency-Key and body (400/413) -> state (409).
 *   So an unauthenticated caller gets the same 401 for a project that exists and one that does not.
 *
 *   429: `rate_limited`, retryable true, next_action "retry_after", details {retry_after_ms (integer,
 *   1..60000), scope}, header `retry-after` = whole seconds (>= 1). The refused request ran nothing; the
 *   same Idempotency-Key succeeds after the wait. Budgets (announced by capabilities.limits):
 *     agent_requests_per_minute 60 per token, owner_requests_per_minute > 60 (relaxed),
 *     heartbeat / interrupt / cancel / operations / requests lookups have a budget of their own,
 *     min_poll_interval_ms: an empty GET inputs again sooner than this is 429 (details.scope "poll").
 *
 *   GET /api/v1/capabilities (no credential): data {
 *     format_version, server:"pes-local", api_version:"v1",
 *     routes: ["METHOD /api/v1/..."] (== the closed 2단계 list == the OpenAPI operations),
 *     unsupported: ["METHOD /api/v1/..."] (every other route of docs/plan/fixtures/api-v1; each answers 501
 *       `not_supported`, writes nothing), scopes, human_only: [routes only an owner session may call],
 *     limits {max_body_bytes, max_results_per_batch, list_max_items, long_poll_max_ms, min_poll_interval_ms,
 *       agent_requests_per_minute, owner_requests_per_minute},
 *     capabilities: {                                   (the document shape of capabilities.json)
 *       operations: { "<operation>": {supported: bool} } for every `operation` named by docs/plan/fixtures/api-v1
 *         (supported exactly when its route is in the closed list),
 *       limits {long_poll_max_ms, request_body_max_bytes, results_per_submit, list_max_items,
 *         agent_requests_per_minute},
 *       error_codes: [every code of the documents and of this suite] } }.
 *   No server answer-draft route anywhere.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

import {
  ALL_AGENT_SCOPES,
  OPENAPI_PATH,
  assert_ok,
  call,
  make_agent,
  agent_claims,
  with_api,
  type ApiEnv,
} from "./helpers/api_env.ts";
import { new_artifact, wrap_db } from "./helpers/blob_env.ts";
import { EXPECTED_ROUTES, EXPECTED_UNSUPPORTED, NEXT_ACTION, P, assert_final_error, doc_operations } from "./helpers/api_flow.ts";
import { parse_yaml } from "./helpers/mini_yaml.ts";
import { state_signature } from "./helpers/state_signature.ts";

const norm = (route: string) => route.replace(/\{[^}]+\}/g, "{}");
const fill = (env: ApiEnv | null, path: string, project = env?.p.project_id ?? "no-such-project") =>
  path.replace("{id}", project).replace(/\{[^}]+\}/g, "x1");
const split = (route: string): [string, string] => {
  const i = route.indexOf(" ");
  return [route.slice(0, i), route.slice(i + 1)];
};

// ---------------------------------------------------------------------------
// the envelope, one case per code

test("every error code carries a Korean message, retryable, a JSON-path target where one field is at fault, and a next_action", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "env-agent");
    // 401
    assert_final_error(await call(env, { method: "GET", path: P(env, "/context") }), 401, "unauthenticated", { next_action: NEXT_ACTION.unauthenticated });
    // 403 (kind of actor)
    assert_final_error(await call(env, { method: "POST", path: P(env, "/runs"), auth: { token: agent.token }, body: {} }), 403, "forbidden");
    // 404 (known credential, unknown project)
    assert_final_error(await call(env, { method: "GET", path: "/api/v1/projects/no-such-project/context", auth: "owner" }), 404, "not_found", {
      next_action: NEXT_ACTION.not_found,
    });
    // 405
    const wrong = await call(env, { method: "DELETE", path: P(env, "/context"), auth: "owner" });
    assert_final_error(wrong, 405, "method_not_allowed", { next_action: NEXT_ACTION.invalid_payload });
    assert.equal(wrong.headers["allow"], "GET");
    // 400 with a target
    assert_final_error(await call(env, { method: "POST", path: P(env, "/claims"), auth: { token: agent.token }, body: { mode: "C", runtime: "r", provider: "p", model: "m" } }), 400, "invalid_payload", {
      target: "$.body.mode",
      next_action: NEXT_ACTION.invalid_payload,
    });
    // 400 without a single faulty field: not JSON at all
    assert_final_error(await call(env, { method: "POST", path: P(env, "/claims"), auth: { token: agent.token }, raw: "{nope" }), 400, "invalid_payload", { target: null });
    // 409 rev_conflict with decimal-string details
    const stale = await call(env, {
      method: "POST",
      path: P(env, "/claims"),
      auth: { token: agent.token },
      body: { mode: "B", runtime: "r", provider: "p", model: "m", expected_control_rev: "9" },
    });
    const conflict = assert_final_error(stale, 409, "rev_conflict", { next_action: NEXT_ACTION.rev_conflict });
    assert.match(conflict.details.expected, /^(0|[1-9][0-9]*)$/);
    assert.match(conflict.details.current, /^(0|[1-9][0-9]*)$/);
    // 409 idempotency_key_reuse
    await call(env, { method: "POST", path: P(env, "/claims"), auth: { token: agent.token }, body: { mode: "B", runtime: "r", provider: "p", model: "m" }, key: "same" });
    assert_final_error(
      await call(env, { method: "POST", path: P(env, "/claims"), auth: { token: agent.token }, body: { mode: "B", runtime: "r2", provider: "p", model: "m" }, key: "same" }),
      409,
      "idempotency_key_reuse",
      { next_action: NEXT_ACTION.idempotency_key_reuse },
    );
    // 413
    const big = await call(env, { method: "POST", path: P(env, "/claims"), auth: { token: agent.token }, raw: "x".repeat(256 * 1024 + 1) });
    const too_big = assert_final_error(big, 413, "payload_too_large", { next_action: NEXT_ACTION.invalid_payload });
    assert.equal(too_big.details.max_bytes, 256 * 1024);
    // the English words of the core ApiError never leak as the whole message
    for (const code_res of [stale, big, wrong]) {
      assert.doesNotMatch(code_res.json.error.message, /\b[A-Za-z]{3,}\s+[A-Za-z]{3,}\s+[A-Za-z]{3,}\b/, "no English sentence as the message");
    }
  });
});

test("an internal failure is a Korean 500 without internals, never retryable by default, with the caller's request id echoed", async () => {
  let armed = false;
  await with_api(
    async (env) => {
      armed = true;
      const res = await call(env, {
        method: "POST",
        path: "/api/v1/projects",
        auth: "owner",
        body: { slug: "boom-project", topic: "합성", owner_display_name: "합성" },
        headers: { "x-request-id": "synthetic-request-7" },
      });
      const error = assert_final_error(res, 500, "internal_error");
      assert.doesNotMatch(JSON.stringify(res.json), /boom|disk full/i);
      assert.equal(res.json.request_id, "synthetic-request-7");
      assert.equal(res.headers["x-request-id"], "synthetic-request-7");
      assert.equal(error.retryable, false);
    },
    {
      wrap: (db) =>
        wrap_db(db, (sql) => {
          if (armed && /^\s*INSERT INTO projects\b/i.test(sql)) throw new Error("boom: disk full");
        }),
    },
  );
});

// ---------------------------------------------------------------------------
// authentication before 404

test("on every project route a caller without a valid credential gets the same 401 whether or not the project exists", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "order");
    const project_routes = EXPECTED_ROUTES.filter((r) => r.includes("{id}"));
    assert.ok(project_routes.length >= 25);
    for (const route of project_routes) {
      const [method, template] = split(route);
      const make = (project: string, auth: "none" | { token: string }) =>
        call(env, {
          method,
          path: fill(env, template, project),
          auth,
          ...(method === "POST" ? { body: {} } : method === "PUT" ? { raw: "x" } : {}),
        });
      const unknown = await make("no-such-project", "none");
      const known = await make(env.p.project_id, "none");
      assert_final_error(unknown, 401, "unauthenticated");
      assert_final_error(known, 401, "unauthenticated");
      assert.deepEqual({ ...unknown.json.error }, { ...known.json.error }, `${route}: identical error for a project that exists and one that does not`);
      assert_final_error(await make("no-such-project", { token: "pes_garbage_token" }), 401, "unauthenticated");
      // A valid token of the project is not valid for an unknown project: still 401, never a 404 that tells.
      assert_final_error(await make("no-such-project", { token: agent.token }), 401, "unauthenticated");
    }
  });
});

test("with a valid owner session an unknown project is 404 on every project route, before the body is looked at", async () => {
  await with_api(async (env) => {
    for (const route of EXPECTED_ROUTES.filter((r) => r.includes("{id}"))) {
      const [method, template] = split(route);
      const res = await call(env, {
        method,
        path: fill(null, template),
        auth: "owner",
        ...(method === "POST" ? { raw: "not json at all" } : method === "PUT" ? { raw: "x" } : {}),
      });
      assert_final_error(res, 404, "not_found");
    }
  });
});

// ---------------------------------------------------------------------------
// 429

test("429: the 61st request of one token within the minute is rate_limited with Retry-After; the same key works after the wait", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "busy");
    const other = await make_agent(env, "calm");
    const caps = assert_ok(await call(env, { method: "GET", path: "/api/v1/capabilities" }));
    assert.equal(caps.limits.agent_requests_per_minute, 60);
    assert.ok(caps.limits.owner_requests_per_minute > 60, "the human session has a relaxed limit");

    const lease = await agent_claims(env, agent); // request 1 of 60
    let ok = 1;
    let limited: any = null;
    for (let i = 0; i < 80 && limited === null; i += 1) {
      const res = await call(env, { method: "GET", path: P(env, "/context"), auth: { token: agent.token } });
      if (res.status === 200) ok += 1;
      else limited = res;
    }
    assert.equal(ok, 60, "exactly 60 requests are served per token and minute");
    const error = assert_final_error(limited, 429, "rate_limited", { retryable: true, next_action: NEXT_ACTION.rate_limited });
    assert.ok(Number.isSafeInteger(error.details.retry_after_ms));
    assert.ok(error.details.retry_after_ms >= 1 && error.details.retry_after_ms <= 60_000);
    assert.match(limited.headers["retry-after"], /^[1-9][0-9]*$/);
    assert.equal(Number(limited.headers["retry-after"]), Math.ceil(error.details.retry_after_ms / 1000));

    // A refused write ran nothing; after the wait the same key is accepted as a first request.
    const art = await new_artifact(env, "limited-artifact");
    const sig = state_signature(env.db);
    const body = { lease_id: lease.lease_id, fence: lease.fence, results: [{ op: "append_version", object_id: art.object_id, title: "제한 뒤 제출" }] };
    const results_path = P(env, `/runs/${lease.run_id}/results`);
    const refused = await call(env, { method: "POST", path: results_path, auth: { token: agent.token }, body, key: "limited-1" });
    assert_final_error(refused, 429, "rate_limited", { retryable: true });
    assert.equal(state_signature(env.db), sig);

    // Another token and the owner session are not slowed down; heartbeat and lookups have their own budget.
    assert_ok(await call(env, { method: "GET", path: P(env, "/context"), auth: { token: other.token } }));
    assert_ok(await call(env, { method: "GET", path: P(env, "/context"), auth: "owner" }));
    assert_ok(await call(env, { method: "POST", path: P(env, `/runs/${lease.run_id}/heartbeat`), auth: { token: agent.token }, body: { lease_id: lease.lease_id, fence: lease.fence } }));
    assert_final_error(await call(env, { method: "GET", path: P(env, "/requests/no-such-key"), auth: { token: agent.token } }), 404, "not_found");

    env.clock.advance(error.details.retry_after_ms);
    const after = await call(env, { method: "POST", path: results_path, auth: { token: agent.token }, body, key: "limited-1" });
    assert_ok(after);
    assert.equal(after.json.replayed, false, "the refused attempt left nothing to replay");
  });
});

test("the human session is limited more gently: 100 requests in a minute are all served", async () => {
  await with_api(async (env) => {
    for (let i = 0; i < 100; i += 1) {
      const res = await call(env, { method: "GET", path: P(env, "/context"), auth: "owner" });
      assert.equal(res.status, 200, `request ${i + 1}`);
    }
  });
});

test("polling inputs again sooner than min_poll_interval_ms is 429 with its own scope; waiting the announced time fixes it", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "pollster");
    const lease = await agent_claims(env, agent);
    const caps = assert_ok(await call(env, { method: "GET", path: "/api/v1/capabilities" }));
    const gap = caps.limits.min_poll_interval_ms;
    assert.ok(Number.isSafeInteger(gap) && gap > 0 && gap <= 10_000);
    const path = P(env, `/runs/${lease.run_id}/inputs`);
    assert_ok(await call(env, { method: "GET", path, auth: { token: agent.token } }));
    env.clock.advance(Math.floor(gap / 2));
    const fast = await call(env, { method: "GET", path, auth: { token: agent.token } });
    const error = assert_final_error(fast, 429, "rate_limited", { retryable: true });
    assert.equal(error.details.scope, "poll");
    assert.ok(error.details.retry_after_ms >= 1 && error.details.retry_after_ms <= gap);
    assert.match(fast.headers["retry-after"], /^[1-9][0-9]*$/);
    env.clock.advance(error.details.retry_after_ms);
    assert_ok(await call(env, { method: "GET", path, auth: { token: agent.token } }));
  });
});

// ---------------------------------------------------------------------------
// capabilities and the closed route list

test("capabilities is open, complete, and says what is not supported", async () => {
  await with_api(async (env) => {
    const res = await call(env, { method: "GET", path: "/api/v1/capabilities" });
    const data = assert_ok(res);
    assert.equal(data.format_version, "1.0");
    assert.equal(data.server, "pes-local");
    assert.equal(data.api_version, "v1");
    assert.deepEqual([...data.routes].sort(), [...EXPECTED_ROUTES], "capabilities lists exactly the closed 2단계 routes");
    assert.equal(new Set(data.routes).size, data.routes.length, "no duplicate route");
    assert.deepEqual([...data.scopes].sort(), [...ALL_AGENT_SCOPES].sort());
    for (const route of EXPECTED_UNSUPPORTED) assert.ok(data.unsupported.includes(route), `unsupported lists ${route}`);
    assert.deepEqual(data.unsupported.filter((r: string) => data.routes.includes(r)), [], "nothing is both supported and unsupported");
    for (const key of ["max_body_bytes", "max_results_per_batch", "list_max_items", "long_poll_max_ms", "min_poll_interval_ms", "agent_requests_per_minute", "owner_requests_per_minute"]) {
      assert.ok(Number.isSafeInteger(data.limits[key]) && data.limits[key] > 0, `limits.${key}`);
    }
    assert.equal(data.limits.max_body_bytes, 256 * 1024);
    assert.equal(data.limits.long_poll_max_ms, 25_000);
    assert.equal(data.limits.list_max_items, 100);
    assert.equal(data.limits.max_results_per_batch, 20);
    for (const route of [
      "POST /api/v1/projects/{id}/stages/{s}/approve",
      "POST /api/v1/projects/{id}/stages/{s}/reopen",
      "POST /api/v1/projects/{id}/policies/opencode-go/revisions",
      "POST /api/v1/projects/{id}/submissions",
      "POST /api/v1/projects/{id}/runs",
      "POST /api/v1/project-registrations",
    ]) {
      assert.ok(data.human_only.includes(route), `human_only lists ${route}`);
    }
    for (const route of data.human_only) assert.ok(data.routes.includes(route));

    // The document shape (docs/plan/fixtures/api-v1/capabilities.json): operations, limits, error codes.
    const caps = data.capabilities;
    assert.equal(caps.limits.request_body_max_bytes, 256 * 1024);
    assert.equal(caps.limits.results_per_submit, 20);
    assert.equal(caps.limits.long_poll_max_ms, 25_000);
    assert.equal(caps.limits.list_max_items, 100);
    assert.equal(caps.limits.agent_requests_per_minute, 60);
    const supported = new Set((data.routes as string[]).map(norm));
    const unsupported = new Set((data.unsupported as string[]).map(norm));
    const documented = doc_operations().filter((o) => o.operation !== "uploads.put"); // doc path /api/v1/uploads/{upload_id} contradicts PR13's P/uploads/{b}; reported
    assert.ok(documented.length >= 35);
    for (const { operation, route } of documented) {
      const entry = caps.operations[operation];
      assert.ok(entry !== undefined, `capabilities.operations names ${operation}`);
      assert.equal(typeof entry.supported, "boolean");
      assert.equal(entry.supported, supported.has(norm(route)), `${operation} (${route}) supported flag`);
      if (!entry.supported) assert.ok(unsupported.has(norm(route)), `${operation} (${route}) is listed as unsupported`);
    }
    for (const op of ["runs.heartbeat", "runs.inputs", "runs.input_receipts", "submissions.create", "questions.create", "questions.withdraw", "questions.defer", "questions.merge", "threads.create", "threads.messages.create", "stages.approve", "changes.list", "rounds.seal", "runs.handoff", "runs.cancel"]) {
      assert.equal(caps.operations[op].supported, true, op);
    }
    for (const op of ["exports.create", "threads.resolutions.create", "decisions.create", "reflections.create", "assumptions.create", "projects.delete"]) {
      assert.equal(caps.operations[op].supported, false, op);
    }
    for (const code of [
      "unauthenticated", "forbidden", "not_found", "method_not_allowed", "invalid_payload", "validation_failed", "payload_too_large",
      "idempotency_key_reuse", "rev_conflict", "conflict", "policy_blocked", "cursor_invalid", "cursor_expired", "rate_limited",
      "input_not_visible", "not_supported", "internal_error", "human_required", "owner_required", "lease_lost", "run_terminal",
      "question_version_changed", "stale_stage", "stage_not_active", "already_sealed",
    ]) {
      assert.ok(caps.error_codes.includes(code), `error_codes lists ${code}`);
    }
    // No server-side answer drafts, and no singular /handoff, anywhere in what the server announces.
    const text = JSON.stringify(res.json);
    assert.doesNotMatch(text, /answer-drafts|answer_drafts/);
    assert.doesNotMatch(text, /\/handoff["\s{]/);
    assert.doesNotMatch(text, /\/runs\/\{[^}]+\}\/claims/, "the canonical claim is POST P/claims");
  });
});

test("every documented route outside the closed list is announced as unsupported", async () => {
  await with_api(async (env) => {
    const data = assert_ok(await call(env, { method: "GET", path: "/api/v1/capabilities" }));
    const listed = new Set((data.unsupported as string[]).map(norm));
    const closed = new Set(EXPECTED_ROUTES.map(norm));
    for (const { operation, route } of doc_operations()) {
      if (operation === "uploads.put" || closed.has(norm(route))) continue;
      assert.ok(listed.has(norm(route)), `${operation}: ${route} is in capabilities.unsupported`);
    }
  });
});

test("an unsupported action answers 501 not_supported and changes nothing — there is no fake success", async () => {
  await with_api(async (env) => {
    const caps = assert_ok(await call(env, { method: "GET", path: "/api/v1/capabilities" }));
    const agent = await make_agent(env, "tries-later");
    const sig = state_signature(env.db);
    for (const route of caps.unsupported as string[]) {
      const [method, template] = split(route);
      for (const auth of ["owner", { token: agent.token }] as const) {
        const res = await call(env, { method, path: fill(env, template), auth, ...(method === "POST" ? { body: {} } : {}) });
        assert_final_error(res, 501, "not_supported", { next_action: NEXT_ACTION.not_supported });
      }
    }
    assert.equal(state_signature(env.db), sig);
    // Without a credential it is still 401 first (the order is the same everywhere).
    const [m, t] = split(EXPECTED_UNSUPPORTED[0]!);
    assert_final_error(await call(env, { method: m, path: fill(env, t), body: {} }), 401, "unauthenticated");
  });
});

test("unknown things stay 404: a made-up table route, the singular handoff, the non-canonical claim path, answer drafts", async () => {
  await with_api(async (env) => {
    for (const path of [
      "/api/v1/tables/projects",
      "/api/v1/sql",
      P(env, "/commands/anything"),
      P(env, "/runs/r1/handoff"),
      P(env, "/runs/r1/claims"),
      P(env, "/answer-drafts"),
    ]) {
      assert_final_error(await call(env, { method: "POST", path, auth: "owner", body: {} }), 404, "not_found");
    }
  });
});

test("the route list is exact: each listed route exists with exactly its methods (405 Allow), and the OpenAPI operations are the same set", async () => {
  await with_api(async (env) => {
    const methods_of = new Map<string, Set<string>>();
    for (const route of EXPECTED_ROUTES) {
      const [method, path] = split(route);
      const key = norm(path);
      methods_of.set(key, (methods_of.get(key) ?? new Set()).add(method));
    }
    for (const [path_template, methods] of methods_of) {
      const raw = [...EXPECTED_ROUTES].map(split).find(([, p]) => norm(p) === path_template)![1];
      const res = await call(env, { method: "DELETE", path: fill(env, raw), auth: "owner", key: null });
      assert_final_error(res, 405, "method_not_allowed", { next_action: NEXT_ACTION.invalid_payload });
      const allow = new Set((res.headers["allow"] ?? "").split(",").map((m) => m.trim()).filter(Boolean));
      assert.deepEqual([...allow].sort(), [...methods].sort(), `Allow of ${path_template}`);
    }

    assert.ok(existsSync(OPENAPI_PATH));
    const doc = parse_yaml(readFileSync(OPENAPI_PATH, "utf8"));
    const documented: string[] = [];
    for (const [path, item] of Object.entries<any>(doc.paths)) {
      for (const method of Object.keys(item)) {
        if (["get", "post", "put", "delete", "patch"].includes(method)) documented.push(`${method.toUpperCase()} ${path}`);
      }
    }
    assert.deepEqual(documented.map(norm).sort(), EXPECTED_ROUTES.map(norm).sort(), "OpenAPI operations == route table");
    assert.equal(new Set(documented.map(norm)).size, documented.length, "no operation documented twice");

    const caps = assert_ok(await call(env, { method: "GET", path: "/api/v1/capabilities" }));
    assert.deepEqual(caps.routes.map(norm).sort(), documented.map(norm).sort(), "capabilities == OpenAPI");
  });
});

test("the plan document's closed route table names every route (nothing left out of docs/plan/stage-2.md 4.2.1)", () => {
  const doc = readFileSync(new URL("../docs/plan/stage-2.md", import.meta.url), "utf8");
  const section = doc.slice(doc.indexOf("### 4.2.1"), doc.indexOf("### 4.3"));
  assert.ok(section.length > 500);
  for (const route of EXPECTED_ROUTES) {
    const [, path] = split(route);
    const tail = path
      .replace("/api/v1/projects/{id}", "")
      .replace("/api/v1", "")
      .split("/")
      .filter((s) => s.length > 0 && !s.startsWith("{"))
      .pop()!;
    assert.ok(section.includes(tail), `${route}: the table mentions "${tail}"`);
  }
  assert.ok(section.includes("/handoffs"));
});
