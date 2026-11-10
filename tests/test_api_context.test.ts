/**
 * SEL-46 PR13 — HTTP API: context, claim, results, wait, complete (tester, 작성 모드).
 *
 * Written from the issue requirements only (docs/plan/issues/stage-2-linear.md PR13, stage-1-api.md),
 * before scripts/pes_core/api.ts exists. The interface these tests pin is described at the top of
 * tests/helpers/api_env.ts. Routes (P = /api/v1/projects/{id}):
 *
 *   GET  /api/v1/capabilities                (open; content is finished by PR14)
 *   GET  P/context                           token scope context:read, or the owner's local session
 *   POST P/runs                              owner session only -> queued run for an agent actor
 *   POST P/claims                            token scope run:claim; body {run_id} or {mode,runtime,provider,model}
 *   POST P/runs/{r}/wait                     token scope run:submit; commits run.wait, then optionally
 *                                            holds the response (wait_ms <= 25000) WITHOUT a transaction
 *   POST P/runs/{r}/results                  token scope run:submit; {lease_id, fence, results:[...]} atomic
 *   POST P/runs/{r}/complete                 token scope run:submit; {lease_id, fence, status?}
 *
 * Numbers that are revisions or fences travel as normalized decimal strings. Not covered here
 * (PR14): questions, answers, changes cursor, approve/reopen, heartbeat/release/interrupt/handoffs,
 * GET P/operations/{id}, GET P/requests/{key}, and the full capabilities content.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { connect } from "../scripts/pes_core/db.ts";
import { db_path } from "../scripts/pes_core/paths.ts";
import { tx } from "../scripts/pes_core/db.ts";
import {
  DECIMAL,
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
  owner_creates_run,
  project_path,
  run_api_fixture,
  with_api,
  type ApiEnv,
} from "./helpers/api_env.ts";
import { new_artifact, more_version } from "./helpers/blob_env.ts";
import { set_current } from "../scripts/pes_core/content.ts";
import { state_signature, table_counts } from "./helpers/state_signature.ts";

const P = (env: ApiEnv, rest = "") => project_path(env, rest);

// ---------------------------------------------------------------------------
// 1. OpenAPI + examples match the real responses

test("every contract example under fixtures/contracts/api runs against the real app", async () => {
  const files = api_fixture_files();
  assert.ok(files.length >= 12, "expected the API contract fixtures");
  for (const file of files) {
    await with_api(async (env) => {
      await run_api_fixture(env, load_api_fixture(file));
    });
  }
});

test("docs/api/openapi-v1.yaml exists and documents each fixture's route, method, and status", () => {
  assert.ok(existsSync(OPENAPI_PATH), "docs/api/openapi-v1.yaml must exist");
  const lines = readFileSync(OPENAPI_PATH, "utf8").split(/\r?\n/);
  const generic = (path: string) =>
    path
      .replace(/\$\{(project|created)\}|no-such-project/g, "{id}")
      .replace(/\$\{run\}/g, "{r}")
      .replace(/\$\{blob\}/g, "{b}")
      .replace(/\?.*$/, "");
  const block_of = (path: string): string[] => {
    const start = lines.findIndex((l) => l.trimEnd() === `  ${path}:` || l.trimEnd() === `  '${path}':` || l.trimEnd() === `  "${path}":`);
    assert.notEqual(start, -1, `OpenAPI has no path ${path}`);
    const out: string[] = [];
    for (let i = start + 1; i < lines.length; i += 1) {
      if (/^ {2}\S/.test(lines[i]) || /^\S/.test(lines[i])) break;
      out.push(lines[i]);
    }
    return out;
  };
  for (const file of api_fixture_files()) {
    const fixture = load_api_fixture(file);
    for (const step of fixture.steps) {
      const path = generic(step.request.path);
      if (!path.startsWith("/api/v1/")) continue; // unknown-route examples are 404 by design
      if (step.expect.status === 404 && /\/(tables|sql|commands)/.test(path)) continue;
      if (step.expect.status === 405) continue;
      const block = block_of(path);
      const method = step.request.method.toLowerCase();
      assert.ok(
        block.some((l) => new RegExp(`^ {4}${method}:`).test(l)),
        `OpenAPI ${path} has no ${method} operation`,
      );
      assert.ok(
        block.some((l) => new RegExp(`['"]?${step.expect.status}['"]?:`).test(l)),
        `OpenAPI ${method} ${path} documents no ${step.expect.status} response`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 8. capabilities route is open (content is PR14's)

test("GET /api/v1/capabilities is open without credentials and answers the shared envelope", async () => {
  await with_api(async (env) => {
    const res = await call(env, { method: "GET", path: "/api/v1/capabilities" });
    const data = assert_ok(res);
    assert.equal(typeof data, "object");
    assert.ok(data !== null && !Array.isArray(data));
    const agent = await make_agent(env, "caps", ["context:read"]);
    assert_ok(await call(env, { method: "GET", path: "/api/v1/capabilities", auth: { token: agent.token } }));
    assert_ok(await call(env, { method: "GET", path: "/api/v1/capabilities", auth: "owner" }));
  });
});

test("capabilities is read-only: other methods are 405 with an Allow header", async () => {
  await with_api(async (env) => {
    for (const method of ["POST", "PUT", "DELETE"]) {
      const res = await call(env, { method, path: "/api/v1/capabilities", body: {} });
      assert_error(res, 405, "method_not_allowed");
      assert.match(res.headers["allow"] ?? "", /GET/);
    }
  });
});

// ---------------------------------------------------------------------------
// context

test("GET context as the owner returns the read boundary: rev/policy strings, six stages, digest, manifest", async () => {
  await with_api(async (env) => {
    const data = assert_ok(await call(env, { method: "GET", path: P(env, "/context"), auth: "owner" }));
    assert.equal(data.project_id, env.p.project_id);
    assert.equal(data.control_rev, "0");
    assert.equal(data.policy.policy_rev, "1");
    assert.equal(data.policy.allow_opencode_go, true);
    assert.equal(data.edition.edition_id, env.p.edition_id);
    assert.deepEqual(
      data.stages.map((s: { key: string }) => s.key),
      ["plan", "research", "analyze", "write", "verify", "publish"],
    );
    assert.match(data.digest, /^[0-9a-f]{64}$/);
    assert.deepEqual(data.manifest, []);
    assert.equal(data.lease, null);
  });
});

test("context digest is stable across reads and changes when a version is added; manifest names exact versions", async () => {
  await with_api(async (env) => {
    const read = async () => assert_ok(await call(env, { method: "GET", path: P(env, "/context"), auth: "owner" }));
    const a = await read();
    const b = await read();
    assert.equal(a.digest, b.digest);
    const v1 = await new_artifact(env, "ctx1");
    const c = await read();
    assert.notEqual(c.digest, a.digest);
    assert.ok(
      c.manifest.some((m: { object_id: string; version_id: string }) => m.object_id === v1.object_id && m.version_id === v1.version_id),
      "the manifest lists the exact version",
    );
    const v2 = await more_version(env, "ctx2", v1.object_id);
    // SEL-46 final review F4: append and adoption are separate; the manifest follows objects.current_version_id.
    const pointer = () =>
      env.db.get<{ current_version_id: string }>("SELECT current_version_id FROM objects WHERE id = ?", v1.object_id)?.current_version_id;
    assert.equal(pointer(), v1.version_id, "append alone leaves the pointer on v1");
    const unadopted = await read();
    assert.equal(unadopted.digest, c.digest, "an unadopted append does not change the digest");
    assert.ok(!unadopted.manifest.some((m: { version_id: string }) => m.version_id === v2.version_id), "an unadopted version is not in the manifest");
    await set_current(env.service, env.ctx("ctx-adopt"), { object_id: v1.object_id, version_id: v2.version_id });
    assert.equal(pointer(), v2.version_id);
    const d = await read();
    assert.notEqual(d.digest, c.digest);
    assert.ok(d.manifest.some((m: { version_id: string }) => m.version_id === v2.version_id));
    assert.ok(!d.manifest.some((m: { version_id: string }) => m.version_id === v1.version_id), "only the current version (the pointer's version)");
  });
});

test("context is readable by an agent token with context:read, and shows the live lease after a claim", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "reader");
    const lease = await agent_claims(env, agent);
    const data = assert_ok(await call(env, { method: "GET", path: P(env, "/context"), auth: { token: agent.token } }));
    assert.equal(data.lease.run_id, lease.run_id);
    assert.equal(data.lease.fence, "1");
    assert.equal(data.lease.lease_id, lease.lease_id);
  });
});

test("context errors: no credential 401, garbage token 401, unknown project 404, scope 403", async () => {
  await with_api(async (env) => {
    assert_error(await call(env, { method: "GET", path: P(env, "/context") }), 401, "unauthenticated");
    assert_error(
      await call(env, { method: "GET", path: P(env, "/context"), auth: { token: "pes_not-a-real-token" } }),
      401,
      "unauthenticated",
    );
    assert_error(await call(env, { method: "GET", path: "/api/v1/projects/no-such-project/context", auth: "owner" }), 404, "not_found");
    const narrow = await make_agent(env, "narrow", ["run:claim"]);
    assert_error(await call(env, { method: "GET", path: P(env, "/context"), auth: { token: narrow.token } }), 403, "forbidden");
  });
});

test("a revoked token, an expired token, and a wrong-session secret never authenticate", async () => {
  await with_api(async (env) => {
    const revoked = await make_agent(env, "revoked");
    const expiring = await make_agent(env, "expiring");
    assert_ok(await call(env, { method: "GET", path: P(env, "/context"), auth: { token: revoked.token } }));
    const { revoke_agent_token } = await import("../scripts/pes_core/actors.ts");
    await revoke_agent_token(env.service, env.ctx("revoke-1"), { token_id: revoked.token_id });
    assert_error(await call(env, { method: "GET", path: P(env, "/context"), auth: { token: revoked.token } }), 401, "unauthenticated");

    env.clock.advance(31 * 24 * 60 * 60 * 1000);
    assert_error(await call(env, { method: "GET", path: P(env, "/context"), auth: { token: expiring.token } }), 401, "unauthenticated");

    const res = await call(env, { method: "GET", path: P(env, "/context"), headers: { "x-pes-session": "wrong-secret" } });
    assert_error(res, 401, "unauthenticated");
  });
});

test("error bodies never echo the presented token", async () => {
  await with_api(async (env) => {
    const secret = "pes_synthetic-secret-token-text";
    const res = await call(env, { method: "GET", path: P(env, "/context"), auth: { token: secret } });
    assert_error(res, 401, "unauthenticated");
    assert.ok(!JSON.stringify(res.json).includes(secret));
    assert.ok(!Object.values(res.headers).some((v) => v.includes(secret)));
  });
});

test("a token of one project does not open another project", async () => {
  await with_api(async (env) => {
    const { second_project } = await import("./helpers/blob_env.ts");
    const other = await second_project(env, "synthetic-files-c");
    const agent = await make_agent(env, "home");
    const res = await call(env, {
      method: "GET",
      path: `/api/v1/projects/${other.project_id}/context`,
      auth: { token: agent.token },
    });
    assert.ok([401, 403, 404].includes(res.status), `got ${res.status}`);
    assert.equal(res.json.data, undefined);
    assert.ok(res.json.error);
  });
});

// ---------------------------------------------------------------------------
// runs + claims

test("POST runs is owner-only: an agent token is 403, no credential is 401; the owner gets a queued run", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "worker");
    const body = { actor_id: agent.actor_id, mode: "B", runtime: "r", provider: "p", model: "m" };
    assert_error(await call(env, { method: "POST", path: P(env, "/runs"), auth: { token: agent.token }, body }), 403, "forbidden");
    assert_error(await call(env, { method: "POST", path: P(env, "/runs"), body }), 401, "unauthenticated");
    assert.equal(table_counts(env.db).runs, 0n);
    const data = assert_ok(await call(env, { method: "POST", path: P(env, "/runs"), auth: "owner", body }), 201);
    assert.equal(data.status, "queued");
    assert.equal(data.actor_id, agent.actor_id);
    const row = env.db.get<{ status: string }>("SELECT status FROM runs WHERE id = ?", data.run_id);
    assert.equal(row?.status, "queued");
  });
});

test("claim of a queued run returns lease_id and a fence that is a decimal string", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "worker");
    const run_id = await owner_creates_run(env, agent);
    const res = await call(env, { method: "POST", path: P(env, "/claims"), auth: { token: agent.token }, body: { run_id } });
    const data = assert_ok(res);
    assert.equal(data.run_id, run_id);
    assert.equal(data.fence, "1");
    assert.equal(typeof data.lease_id, "string");
    assert.ok(Number.isSafeInteger(data.expires_at));
    assert.equal(res.json.replayed, false);
    assert.equal(env.db.get<{ status: string }>("SELECT status FROM runs WHERE id = ?", run_id)?.status, "running");
  });
});

test("a fresh claim (no run_id) creates a running run and the lease in one step", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "fresh");
    const lease = await agent_claims(env, agent);
    assert.equal(lease.fence, "1");
    assert.equal(env.db.get<{ status: string }>("SELECT status FROM runs WHERE id = ?", lease.run_id)?.status, "running");
  });
});

test("claim replay: same Idempotency-Key and body replays the original result; a different body is 409 idempotency_key_reuse", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "replay");
    const body = { mode: "B", runtime: "r", provider: "p", model: "m" };
    const first = await call(env, { method: "POST", path: P(env, "/claims"), auth: { token: agent.token }, key: "claim-k1", body });
    const a = assert_ok(first);
    const again = await call(env, { method: "POST", path: P(env, "/claims"), auth: { token: agent.token }, key: "claim-k1", body });
    const b = assert_ok(again);
    assert.equal(again.json.replayed, true);
    assert.equal(b.run_id, a.run_id);
    assert.equal(b.lease_id, a.lease_id);
    assert.equal(table_counts(env.db).runs, 1n);
    const reused = await call(env, {
      method: "POST",
      path: P(env, "/claims"),
      auth: { token: agent.token },
      key: "claim-k1",
      body: { ...body, model: "other" },
    });
    assert_error(reused, 409, "idempotency_key_reuse");
  });
});

test("a second claim while a live lease exists is 409 conflict and changes nothing", async () => {
  await with_api(async (env) => {
    const a = await make_agent(env, "a");
    const b = await make_agent(env, "b");
    await agent_claims(env, a);
    const before = state_signature(env.db);
    const res = await call(env, {
      method: "POST",
      path: P(env, "/claims"),
      auth: { token: b.token },
      body: { mode: "B", runtime: "r", provider: "p", model: "m" },
    });
    assert_error(res, 409, "conflict");
    assert.equal(state_signature(env.db), before);
  });
});

test("claim scope: a token without run:claim is 403 and writes nothing", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "ro", ["context:read"]);
    const before = state_signature(env.db);
    const res = await call(env, {
      method: "POST",
      path: P(env, "/claims"),
      auth: { token: agent.token },
      body: { mode: "B", runtime: "r", provider: "p", model: "m" },
    });
    assert_error(res, 403, "forbidden");
    assert.equal(state_signature(env.db), before);
  });
});

test("claim is not reachable at the non-canonical path POST P/runs/{r}/claims", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "canon");
    const run_id = await owner_creates_run(env, agent);
    const res = await call(env, { method: "POST", path: P(env, `/runs/${run_id}/claims`), auth: { token: agent.token }, body: {} });
    assert_error(res, 404, "not_found");
  });
});

// ---------------------------------------------------------------------------
// 2. rev conflict leaves nothing behind

test("claim with a stale expected_control_rev is 409 rev_conflict with string revs and no partial save", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "stale");
    await bump_control_rev(env); // control_rev is now 1
    const before = state_signature(env.db);
    const res = await call(env, {
      method: "POST",
      path: P(env, "/claims"),
      auth: { token: agent.token },
      body: { mode: "B", runtime: "r", provider: "p", model: "m", expected_control_rev: "0" },
    });
    const error = assert_error(res, 409, "rev_conflict");
    assert.equal(error.retryable, false);
    assert.equal(error.details.expected, "0");
    assert.equal(error.details.current, "1");
    assert.equal(state_signature(env.db), before, "no run, lease, receipt, or event");
    // The caller refreshes the context and tries again with the current rev.
    const ok = await call(env, {
      method: "POST",
      path: P(env, "/claims"),
      auth: { token: agent.token },
      body: { mode: "B", runtime: "r", provider: "p", model: "m", expected_control_rev: "1" },
    });
    assert_ok(ok);
  });
});

test("results with a stale expected_control_rev save none of the batch", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "res");
    const art_a = await new_artifact(env, "ra");
    const art_b = await new_artifact(env, "rb");
    const lease = await agent_claims(env, agent);
    await bump_control_rev(env);
    const before = state_signature(env.db);
    const res = await call(env, {
      method: "POST",
      path: P(env, `/runs/${lease.run_id}/results`),
      auth: { token: agent.token },
      body: {
        lease_id: lease.lease_id,
        fence: lease.fence,
        expected_control_rev: "0",
        results: [
          { op: "append_version", object_id: art_a.object_id, title: "새 제목 A" },
          { op: "append_version", object_id: art_b.object_id, title: "새 제목 B" },
        ],
      },
    });
    assert_error(res, 409, "rev_conflict");
    assert.equal(state_signature(env.db), before);
  });
});

// ---------------------------------------------------------------------------
// results: atomic bundle

test("results appends versions as one atomic bundle and returns exact version ids", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "res");
    const art_a = await new_artifact(env, "ra");
    const art_b = await new_artifact(env, "rb");
    const lease = await agent_claims(env, agent);
    const res = await call(env, {
      method: "POST",
      path: P(env, `/runs/${lease.run_id}/results`),
      auth: { token: agent.token },
      body: {
        lease_id: lease.lease_id,
        fence: lease.fence,
        results: [
          { op: "append_version", object_id: art_a.object_id, title: "새 제목 A" },
          { op: "append_version", object_id: art_b.object_id, title: "새 제목 B" },
        ],
      },
    });
    const data = assert_ok(res);
    assert.equal(data.run_id, lease.run_id);
    assert.equal(data.results.length, 2);
    for (const [i, art] of [art_a, art_b].entries()) {
      assert.equal(data.results[i].object_id, art.object_id);
      assert.notEqual(data.results[i].version_id, art.version_id);
      const row = env.db.get<{ object_id: string }>("SELECT object_id FROM object_versions WHERE id = ?", data.results[i].version_id);
      assert.equal(row?.object_id, art.object_id);
    }
  });
});

test("results: one bad item (unknown object) rolls back the whole bundle", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "res");
    const art = await new_artifact(env, "ra");
    const lease = await agent_claims(env, agent);
    const before = state_signature(env.db);
    const res = await call(env, {
      method: "POST",
      path: P(env, `/runs/${lease.run_id}/results`),
      auth: { token: agent.token },
      body: {
        lease_id: lease.lease_id,
        fence: lease.fence,
        results: [
          { op: "append_version", object_id: art.object_id, title: "좋은 항목" },
          { op: "append_version", object_id: "no-such-object", title: "나쁜 항목" },
        ],
      },
    });
    assert_error(res, 404, "not_found");
    assert.equal(state_signature(env.db), before, "the good item was not saved either");
  });
});

test("results is a closed list: unknown op, unknown item field, empty list, and >20 items are 400", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "res");
    const art = await new_artifact(env, "ra");
    const lease = await agent_claims(env, agent);
    const send = (results: unknown) =>
      call(env, {
        method: "POST",
        path: P(env, `/runs/${lease.run_id}/results`),
        auth: { token: agent.token },
        body: { lease_id: lease.lease_id, fence: lease.fence, results },
      });
    const before = state_signature(env.db);
    assert_error(await send([{ op: "delete_everything", object_id: art.object_id }]), 400, "invalid_payload");
    assert_error(await send([{ op: "append_version", object_id: art.object_id, title: "t", sql: "DROP TABLE runs" }]), 400, "invalid_payload");
    assert_error(await send([]), 400, "invalid_payload");
    const many = Array.from({ length: 21 }, (_, i) => ({ op: "append_version", object_id: art.object_id, title: `t${i}` }));
    assert_error(await send(many), 400, "invalid_payload");
    assert.equal(state_signature(env.db), before);
  });
});

test("results needs the current lease: stale fence, wrong lease id, another actor's run, and scope", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "res");
    const other = await make_agent(env, "other");
    const readonly = await make_agent(env, "ro", ["context:read", "run:claim"]);
    const art = await new_artifact(env, "ra");
    const lease = await agent_claims(env, agent);
    const item = [{ op: "append_version", object_id: art.object_id, title: "t" }];
    const path = P(env, `/runs/${lease.run_id}/results`);
    const before = state_signature(env.db);
    assert_error(
      await call(env, { method: "POST", path, auth: { token: agent.token }, body: { lease_id: lease.lease_id, fence: "2", results: item } }),
      409,
      "conflict",
    );
    assert_error(
      await call(env, { method: "POST", path, auth: { token: agent.token }, body: { lease_id: "wrong-lease", fence: lease.fence, results: item } }),
      409,
      "conflict",
    );
    const as_other = await call(env, { method: "POST", path, auth: { token: other.token }, body: { lease_id: lease.lease_id, fence: lease.fence, results: item } });
    assert.ok([403, 409].includes(as_other.status), `another actor got ${as_other.status}`);
    assert_error(
      await call(env, { method: "POST", path, auth: { token: readonly.token }, body: { lease_id: lease.lease_id, fence: lease.fence, results: item } }),
      403,
      "forbidden",
    );
    assert.equal(state_signature(env.db), before);
  });
});

// ---------------------------------------------------------------------------
// 3. wait does not hold a transaction

test("wait commits waiting_human and releases the lease; the held response keeps no transaction open", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "waiter");
    const lease = await agent_claims(env, agent);
    env.hold_sleep = true;
    let settled = false;
    const pending = call(env, {
      method: "POST",
      path: P(env, `/runs/${lease.run_id}/wait`),
      auth: { token: agent.token },
      body: { lease_id: lease.lease_id, fence: lease.fence, reason: "사람 입력 대기", wait_ms: 20_000 },
    }).then((res) => {
      settled = true;
      return res;
    });
    // Let the request run until it parks on the injected sleep.
    for (let i = 0; i < 200 && env.gates.length === 0; i += 1) await new Promise((r) => setImmediate(r));
    assert.equal(env.gates.length, 1, "the long wait is parked");
    assert.equal(env.gates[0].ms, 20_000);
    assert.equal(settled, false);

    // The status change is already committed while the response is still held.
    assert.equal(env.db.get<{ status: string }>("SELECT status FROM runs WHERE id = ?", lease.run_id)?.status, "waiting_human");

    // 1) no transaction is open on the app's connection
    assert.equal(tx(env.db, () => 7), 7);
    // 2) another connection can write immediately (a held write lock would block until busy_timeout)
    const other = connect(db_path(env.home.env));
    try {
      const started = Date.now();
      other.exec("BEGIN IMMEDIATE");
      other.exec("ROLLBACK");
      assert.ok(Date.now() - started < 1000, "a second writer was not blocked");
    } finally {
      other.close();
    }
    // 3) other API writes go through while the wait is held
    const second = await make_agent(env, "second");
    const claimed = await call(env, {
      method: "POST",
      path: P(env, "/claims"),
      auth: { token: second.token },
      body: { mode: "B", runtime: "r", provider: "p", model: "m" },
    });
    assert_ok(claimed);
    assert.equal(settled, false, "still parked");

    env.gates[0].release();
    const res = await pending;
    const data = assert_ok(res);
    assert.equal(data.status, "waiting_human");
    assert.equal(data.run_id, lease.run_id);
  });
});

test("wait without wait_ms returns at once; the lease is gone so the old lease cannot complete", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "waiter");
    const lease = await agent_claims(env, agent);
    const res = await call(env, {
      method: "POST",
      path: P(env, `/runs/${lease.run_id}/wait`),
      auth: { token: agent.token },
      body: { lease_id: lease.lease_id, fence: lease.fence },
    });
    assert.equal(assert_ok(res).status, "waiting_human");
    assert.equal(env.gates.length, 0);
    const done = await call(env, {
      method: "POST",
      path: P(env, `/runs/${lease.run_id}/complete`),
      auth: { token: agent.token },
      body: { lease_id: lease.lease_id, fence: lease.fence },
    });
    assert_error(done, 409, "conflict");
  });
});

test("wait_ms over 25 seconds or not an integer is 400, and nothing changes", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "waiter");
    const lease = await agent_claims(env, agent);
    const before = state_signature(env.db);
    for (const wait_ms of [25_001, -1, 1.5, "100", null]) {
      const res = await call(env, {
        method: "POST",
        path: P(env, `/runs/${lease.run_id}/wait`),
        auth: { token: agent.token },
        body: { lease_id: lease.lease_id, fence: lease.fence, wait_ms },
      });
      assert_error(res, 400, "invalid_payload");
    }
    assert.equal(state_signature(env.db), before);
    assert.equal(env.gates.length, 0);
  });
});

// ---------------------------------------------------------------------------
// complete

test("complete ends the run only: lease released, stage not approved, round not sealed", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "done");
    const lease = await agent_claims(env, agent);
    const stages_before = JSON.stringify(env.db.all("SELECT id, status, rev FROM stages ORDER BY id"), (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    const res = await call(env, {
      method: "POST",
      path: P(env, `/runs/${lease.run_id}/complete`),
      auth: { token: agent.token },
      body: { lease_id: lease.lease_id, fence: lease.fence, status: "succeeded" },
    });
    const data = assert_ok(res);
    assert.equal(data.status, "succeeded");
    assert.equal(data.run_id, lease.run_id);
    assert.equal(env.db.get<{ status: string }>("SELECT status FROM runs WHERE id = ?", lease.run_id)?.status, "succeeded");
    assert.equal(table_counts(env.db).approvals, 0n, "complete is not an approval");
    assert.equal(
      JSON.stringify(env.db.all("SELECT id, status, rev FROM stages ORDER BY id"), (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
      stages_before,
    );
    assert.equal(env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM rounds WHERE state = 'sealed'")?.n, 0n);
    // The project can be claimed again (lease released).
    await agent_claims(env, agent);
  });
});

test("complete with a stale fence, an unknown status, or without the scope changes nothing", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "done");
    const narrow = await make_agent(env, "narrow", ["context:read"]);
    const lease = await agent_claims(env, agent);
    const path = P(env, `/runs/${lease.run_id}/complete`);
    const before = state_signature(env.db);
    assert_error(await call(env, { method: "POST", path, auth: { token: agent.token }, body: { lease_id: lease.lease_id, fence: "9" } }), 409, "conflict");
    assert_error(
      await call(env, { method: "POST", path, auth: { token: agent.token }, body: { lease_id: lease.lease_id, fence: lease.fence, status: "approved" } }),
      400,
      "invalid_payload",
    );
    assert_error(await call(env, { method: "POST", path, auth: { token: narrow.token }, body: { lease_id: lease.lease_id, fence: lease.fence } }), 403, "forbidden");
    assert.equal(state_signature(env.db), before);
  });
});

test("complete replay with the same key returns the original result; a repeat with a new key is 409", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "done");
    const lease = await agent_claims(env, agent);
    const path = P(env, `/runs/${lease.run_id}/complete`);
    const body = { lease_id: lease.lease_id, fence: lease.fence };
    assert_ok(await call(env, { method: "POST", path, auth: { token: agent.token }, key: "done-1", body }));
    const replay = await call(env, { method: "POST", path, auth: { token: agent.token }, key: "done-1", body });
    assert_ok(replay);
    assert.equal(replay.json.replayed, true);
    assert_error(await call(env, { method: "POST", path, auth: { token: agent.token }, key: "done-2", body }), 409, "conflict");
  });
});

// ---------------------------------------------------------------------------
// 4. scope violations are 403; policy denial is not retried

test("an agent token cannot do human-only work: runs, project.create, and owner-only paths", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "agent");
    const res = await call(env, {
      method: "POST",
      path: P(env, "/runs"),
      auth: { token: agent.token },
      body: { actor_id: agent.actor_id, mode: "B", runtime: "r", provider: "p", model: "m" },
    });
    assert_error(res, 403, "forbidden");
    assert.equal(table_counts(env.db).runs, 0n);
  });
});

test("Go OFF: a mode A claim is 403 policy_denied, retryable=false, no Retry-After, and the server tries once", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "go", undefined, "internal_ai");
    await go_off(env);
    const before = state_signature(env.db);
    const begins = env.begin_count();
    const res = await call(env, {
      method: "POST",
      path: P(env, "/claims"),
      auth: { token: agent.token },
      body: { mode: "A", runtime: "builtin", provider: "opencode-go", model: "opencode-go/deepseek-v4.1-flash" },
    });
    const error = assert_error(res, 403, "policy_denied");
    assert.equal(error.retryable, false);
    assert.equal(res.headers["retry-after"], undefined);
    assert.equal(error.details?.retry, undefined, "no retry hint in the details");
    assert.ok(env.begin_count() - begins <= 1, "the server did not repeat the transaction");
    assert.equal(state_signature(env.db), before, "no run, lease, receipt, or event");
    // The same request again is denied again, still without any write.
    assert_error(
      await call(env, {
        method: "POST",
        path: P(env, "/claims"),
        auth: { token: agent.token },
        body: { mode: "A", runtime: "builtin", provider: "opencode-go", model: "opencode-go/deepseek-v4.1-flash" },
      }),
      403,
      "policy_denied",
    );
    assert.equal(state_signature(env.db), before);
  });
});

test("Go OFF does not block a mode B claim by an external agent or the owner's context", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "ext");
    await go_off(env);
    await agent_claims(env, agent);
    assert_ok(await call(env, { method: "GET", path: P(env, "/context"), auth: "owner" }));
  });
});

test("Go OFF blocks context for the Go-bound (internal_ai) actor but not for an external agent", async () => {
  await with_api(async (env) => {
    const internal = await make_agent(env, "internal", undefined, "internal_ai");
    const external = await make_agent(env, "external");
    assert_ok(await call(env, { method: "GET", path: P(env, "/context"), auth: { token: internal.token } }));
    await go_off(env);
    const denied = await call(env, { method: "GET", path: P(env, "/context"), auth: { token: internal.token } });
    assert.equal(assert_error(denied, 403, "policy_denied").retryable, false);
    assert_ok(await call(env, { method: "GET", path: P(env, "/context"), auth: { token: external.token } }));
  });
});

// ---------------------------------------------------------------------------
// 7. decimal strings, closed commands, unsupported fields

test("numbers beyond 2^53 are returned as exact decimal strings", async () => {
  await with_api(async (env) => {
    env.db.run("UPDATE projects SET control_rev = 9007199254740993 WHERE id = ?", env.p.project_id);
    const res = await call(env, { method: "GET", path: P(env, "/context"), auth: "owner" });
    const data = assert_ok(res);
    assert.equal(data.control_rev, "9007199254740993");
    assert.match(data.control_rev, DECIMAL);
    // The raw body text carries the string, never a rounded JSON number.
    assert.ok(JSON.stringify(res.json).includes('"9007199254740993"'));
    const agent = await make_agent(env, "big");
    const stale = await call(env, {
      method: "POST",
      path: P(env, "/claims"),
      auth: { token: agent.token },
      body: { mode: "B", runtime: "r", provider: "p", model: "m", expected_control_rev: "9007199254740992" },
    });
    const error = assert_error(stale, 409, "rev_conflict");
    assert.equal(error.details.expected, "9007199254740992");
    assert.equal(error.details.current, "9007199254740993");
  });
});

test("rev and fence inputs must be normalized decimal strings: numbers, leading zeros, signs, and decimals are 400", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "dec");
    const lease = await agent_claims(env, agent);
    const path = P(env, `/runs/${lease.run_id}/complete`);
    const before = state_signature(env.db);
    for (const fence of [1, "01", "-1", "1.0", "1e0", " 1", "", null, "0x1"]) {
      const res = await call(env, { method: "POST", path, auth: { token: agent.token }, body: { lease_id: lease.lease_id, fence } });
      assert_error(res, 400, "invalid_payload");
    }
    for (const expected_control_rev of [0, "00", "+0", "0.0", -1, null]) {
      const res = await call(env, {
        method: "POST",
        path: P(env, "/claims"),
        auth: { token: agent.token },
        body: { mode: "B", runtime: "r", provider: "p", model: "m", expected_control_rev },
      });
      assert_error(res, 400, "invalid_payload");
    }
    assert.equal(state_signature(env.db), before);
  });
});

test("the command surface is closed: no table, SQL, or generic command path exists", async () => {
  await with_api(async (env) => {
    const paths = [
      P(env, "/tables/runs"),
      P(env, "/sql"),
      P(env, "/commands"),
      P(env, "/runs/x/delete"),
      "/api/v1/commands",
      "/api/v1/sql",
      "/api/v2/capabilities",
      "/api/capabilities",
      "/",
    ];
    for (const path of paths) {
      const res = await call(env, { method: "POST", path, auth: "owner", body: { command: "content.add_source" } });
      assert_error(res, 404, "not_found");
    }
    for (const path of [P(env, "/tables/runs"), "/api/v1/nope"]) {
      assert_error(await call(env, { method: "GET", path, auth: "owner" }), 404, "not_found");
    }
  });
});

test("known paths reject other methods with 405 and an Allow header", async () => {
  await with_api(async (env) => {
    const cases: Array<[string, string, RegExp]> = [
      ["DELETE", P(env, "/context"), /GET/],
      ["POST", P(env, "/context"), /GET/],
      ["GET", P(env, "/claims"), /POST/],
      ["PUT", P(env, "/claims"), /POST/],
      ["GET", P(env, "/runs/some-run/complete"), /POST/],
      ["PATCH", P(env, "/runs/some-run/results"), /POST/],
    ];
    for (const [method, path, allow] of cases) {
      const res = await call(env, { method, path, auth: "owner", body: method === "GET" ? undefined : {} });
      assert_error(res, 405, "method_not_allowed");
      assert.match(res.headers["allow"] ?? "", allow);
    }
  });
});

test("unsupported request fields are rejected with 400 and write nothing", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "closed");
    const before = state_signature(env.db);
    const withExtra = async (path: string, auth: "owner" | { token: string }, body: Record<string, unknown>) =>
      assert_error(await call(env, { method: "POST", path, auth, body }), 400, "invalid_payload");
    await withExtra(P(env, "/claims"), { token: agent.token }, { mode: "B", runtime: "r", provider: "p", model: "m", actor_id: "someone-else" });
    await withExtra(P(env, "/claims"), { token: agent.token }, { mode: "B", runtime: "r", provider: "p", model: "m", unknown_flag: true });
    await withExtra(P(env, "/runs"), "owner", { actor_id: agent.actor_id, mode: "B", runtime: "r", provider: "p", model: "m", status: "succeeded" });
    assert.equal(state_signature(env.db), before);
  });
});

test("body problems: not JSON, a JSON array, empty body, and a missing Idempotency-Key are 400; over 256 KiB is 413", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "body");
    const claims = P(env, "/claims");
    const before = state_signature(env.db);
    assert_error(await call(env, { method: "POST", path: claims, auth: { token: agent.token }, raw: "{not json" }), 400, "invalid_payload");
    assert_error(await call(env, { method: "POST", path: claims, auth: { token: agent.token }, raw: "[]" }), 400, "invalid_payload");
    assert_error(await call(env, { method: "POST", path: claims, auth: { token: agent.token }, raw: "" }), 400, "invalid_payload");
    assert_error(
      await call(env, {
        method: "POST",
        path: claims,
        auth: { token: agent.token },
        key: null,
        body: { mode: "B", runtime: "r", provider: "p", model: "m" },
      }),
      400,
      "invalid_payload",
    );
    const big = JSON.stringify({ mode: "B", runtime: "r", provider: "p", model: "m", pad: "x".repeat(256 * 1024) });
    const res = await call(env, { method: "POST", path: claims, auth: { token: agent.token }, raw: big });
    assert_error(res, 413, "payload_too_large");
    assert.equal(state_signature(env.db), before);
  });
});

test("every response carries format_version 1.0 and a request_id; a client x-request-id is echoed", async () => {
  await with_api(async (env) => {
    const res = await call(env, { method: "GET", path: "/api/v1/capabilities", headers: { "x-request-id": "client-req-1" } });
    assert_ok(res);
    assert.equal(res.json.request_id, "client-req-1");
    assert.equal(res.headers["x-request-id"], "client-req-1");
    const generated = await call(env, { method: "GET", path: "/api/v1/capabilities" });
    assert.notEqual(generated.json.request_id, "client-req-1");
    assert.match(String(generated.headers["content-type"]), /application\/json/);
  });
});
