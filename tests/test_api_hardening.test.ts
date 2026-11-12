/**
 * SEL-46 PR13 — HTTP API 보강 시험 (tester, 보강 모드).
 *
 * api.ts 구현을 읽고 빠진 경계를 채운다: result.submit 묶음 원자성, wait 의 tx, 토큰·세션 범위,
 * 10진 문자열 경계, 모르는 필드·큰 body, project.create 무쓰기, OpenAPI ↔ 라우트 표.
 * 합성 자료만 쓴다. 구현이 틀렸다고 보이는 시험은 실패한 채로 두고 이름에 DEFECT 를 붙인다.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { revoke_agent_token } from "../scripts/pes_core/actors.ts";
import { add_artifact, create_object } from "../scripts/pes_core/content.ts";
import {
  OPENAPI_PATH,
  SESSION_SECRET,
  agent_claims,
  assert_error,
  assert_ok,
  bump_control_rev,
  call,
  make_agent,
  project_path,
  with_api,
  type ApiEnv,
  type Lease,
} from "./helpers/api_env.ts";
import { bytes_of, ctx_for, new_artifact, second_project, wrap_db } from "./helpers/blob_env.ts";
import { state_signature, table_counts } from "./helpers/state_signature.ts";

const P = (env: ApiEnv, rest = "") => project_path(env, rest);

function results_call(
  env: ApiEnv,
  token: string,
  lease: Lease,
  results: unknown,
  extra: Record<string, unknown> = {},
  key?: string,
) {
  return call(env, {
    method: "POST",
    path: P(env, `/runs/${lease.run_id}/results`),
    auth: { token },
    key,
    body: { lease_id: lease.lease_id, fence: lease.fence, results, ...extra },
  });
}

async function foreign_artifact(env: ApiEnv, slug: string) {
  const other = await second_project(env, slug);
  const obj = (await create_object(env.service, ctx_for(other, `${slug}-o`), { kind: "artifact", edition_id: other.edition_id }))
    .result as { object_id: string };
  await add_artifact(env.service, ctx_for(other, `${slug}-v`), {
    object_id: obj.object_id,
    artifact_kind: "chapter",
    title: "다른 프로젝트 장",
    summary: "합성",
  });
  return { other, object_id: obj.object_id };
}

function changed_tables(a: Record<string, bigint>, b: Record<string, bigint>): string[] {
  return Object.keys(b).filter((k) => a[k] !== b[k]);
}

// ---------------------------------------------------------------------------
// (1) result.submit 묶음 원자성

test("results: a foreign-project object in the middle rolls back the whole bundle, then the fixed retry works", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "atom");
    const a = await new_artifact(env, "aa");
    const c = await new_artifact(env, "ac");
    const foreign = await foreign_artifact(env, "synthetic-atom-other");
    const lease = await agent_claims(env, agent);
    const before = state_signature(env.db);
    const counts = table_counts(env.db);
    const res = await results_call(
      env,
      agent.token,
      lease,
      [
        { op: "append_version", object_id: a.object_id, title: "앞 항목" },
        { op: "append_version", object_id: foreign.object_id, title: "다른 프로젝트 항목" },
        { op: "append_version", object_id: c.object_id, title: "뒤 항목" },
      ],
      {},
      "atom-key",
    );
    assert_error(res, 404, "not_found");
    assert.equal(state_signature(env.db), before, "no version, receipt, or event for any item");
    assert.deepEqual(changed_tables(counts, table_counts(env.db)), []);
    // the failed attempt left no receipt: the same key with a fixed body succeeds and is not a replay
    const ok = await results_call(
      env,
      agent.token,
      lease,
      [
        { op: "append_version", object_id: a.object_id, title: "앞 항목" },
        { op: "append_version", object_id: c.object_id, title: "뒤 항목" },
      ],
      {},
      "atom-key",
    );
    assert_ok(ok);
    assert.equal(ok.json.replayed, false);
  });
});

test("results: based_on_version_id of another object or an unknown version in the middle saves nothing", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "based");
    const a = await new_artifact(env, "ba");
    const b = await new_artifact(env, "bb");
    const lease = await agent_claims(env, agent);
    const before = state_signature(env.db);
    const mixed = await results_call(env, agent.token, lease, [
      { op: "append_version", object_id: a.object_id, title: "좋은 항목" },
      { op: "append_version", object_id: b.object_id, based_on_version_id: a.version_id, title: "남의 버전 기반" },
    ]);
    assert_error(mixed, 409, "conflict");
    assert.equal(state_signature(env.db), before);
    const unknown = await results_call(env, agent.token, lease, [
      { op: "append_version", object_id: a.object_id, title: "좋은 항목" },
      { op: "append_version", object_id: b.object_id, based_on_version_id: "no-such-version", title: "없는 버전" },
    ]);
    assert_error(unknown, 404, "not_found");
    assert.equal(state_signature(env.db), before);
  });
});

test("results: an expired lease and a fence made stale by a re-claim save nothing", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "expire");
    const a = await new_artifact(env, "ea");
    const lease = await agent_claims(env, agent);
    const item = [{ op: "append_version", object_id: a.object_id, title: "t" }];
    const row = env.db.get<{ expires_at: bigint }>("SELECT expires_at FROM project_leases WHERE project_id = ?", env.p.project_id);
    assert.ok(row);
    env.clock.advance(Number(row.expires_at) - env.clock.now_ms());
    let before = state_signature(env.db);
    assert_error(await results_call(env, agent.token, lease, item), 409, "conflict");
    assert.equal(state_signature(env.db), before, "expired lease: nothing written, no receipt, no event");

    // a fresh claim after expiry interrupts the old run and issues a newer fence; the old lease stays refused
    const again = await agent_claims(env, agent);
    assert.notEqual(again.lease_id, lease.lease_id);
    before = state_signature(env.db);
    assert_error(await results_call(env, agent.token, lease, item), 409, "conflict");
    assert.equal(state_signature(env.db), before, "stale fence: nothing written");
    assert_ok(await results_call(env, agent.token, again, item));
  });
});

test("results: the same agent re-claims its dead running run by run_id after expiry (fence + 1, new lease); the old lease saves nothing", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "reclaim");
    const a = await new_artifact(env, "rca");
    const lease = await agent_claims(env, agent);
    const item = [{ op: "append_version", object_id: a.object_id, title: "t" }];
    const row = env.db.get<{ expires_at: bigint }>("SELECT expires_at FROM project_leases WHERE project_id = ?", env.p.project_id);
    assert.ok(row);
    env.clock.advance(Number(row.expires_at) - env.clock.now_ms());
    const res = await call(env, { method: "POST", path: P(env, "/claims"), auth: { token: agent.token }, body: { run_id: lease.run_id } });
    const again = assert_ok(res);
    assert.equal(again.run_id, lease.run_id);
    assert.equal(BigInt(again.fence), BigInt(lease.fence) + 1n);
    assert.notEqual(again.lease_id, lease.lease_id);
    const before = state_signature(env.db);
    assert_error(await results_call(env, agent.token, lease, item), 409, "conflict");
    assert.equal(state_signature(env.db), before, "old lease: nothing written");
    assert_ok(await results_call(env, agent.token, again, item));
  });
});

test("results: a write failure on the second version rolls back the receipt, the first version, and the events", async () => {
  let armed = false;
  let seen = 0;
  await with_api(
    async (env) => {
      const agent = await make_agent(env, "fail");
      const a = await new_artifact(env, "fa");
      const b = await new_artifact(env, "fb");
      const lease = await agent_claims(env, agent);
      const item = [
        { op: "append_version", object_id: a.object_id, title: "하나" },
        { op: "append_version", object_id: b.object_id, title: "둘" },
      ];
      const before = state_signature(env.db);
      armed = true;
      const res = await results_call(env, agent.token, lease, item, {}, "fail-key");
      const error = assert_error(res, 500, "internal_error");
      assert.doesNotMatch(error.message, /boom|object_versions/i);
      assert.equal(seen, 2, "the failure hit the second version insert");
      assert.equal(state_signature(env.db), before);
      armed = false;
      const retry = await results_call(env, agent.token, lease, item, {}, "fail-key");
      assert_ok(retry);
      assert.equal(retry.json.replayed, false);
    },
    {
      wrap: (db) =>
        wrap_db(db, (sql) => {
          if (armed && /^\s*INSERT INTO object_versions\b/i.test(sql)) {
            seen += 1;
            if (seen === 2) throw new Error("boom: disk full");
          }
        }),
    },
  );
});

test("results: 20 items on one object chain version numbers in order (the upper bound is accepted) under one receipt", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "twenty");
    const a = await new_artifact(env, "ta");
    const lease = await agent_claims(env, agent);
    const items = Array.from({ length: 20 }, (_, i) => ({ op: "append_version", object_id: a.object_id, title: `제목 ${i}` }));
    const counts = table_counts(env.db);
    const data = assert_ok(await results_call(env, agent.token, lease, items));
    assert.equal(data.results.length, 20);
    assert.deepEqual(
      data.results.map((r: { version_no: number }) => r.version_no),
      Array.from({ length: 20 }, (_, i) => a.version_no + 1 + i),
    );
    const after = table_counts(env.db);
    assert.equal(after.object_versions - counts.object_versions, 20n);
    assert.equal(after.mutation_commits - counts.mutation_commits, 1n, "one receipt for the whole bundle");
    const rows = env.db.all<{ id: string; based_on_version_id: string | null }>(
      "SELECT id, based_on_version_id FROM object_versions WHERE object_id = ? ORDER BY version_no",
      a.object_id,
    );
    for (let i = 2; i < rows.length; i += 1) assert.equal(rows[i].based_on_version_id, rows[i - 1].id);
  });
});

test("results: the stale expected_control_rev error reports string revisions and the current one then passes", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "revs");
    const a = await new_artifact(env, "ra");
    const lease = await agent_claims(env, agent);
    await bump_control_rev(env);
    const item = [{ op: "append_version", object_id: a.object_id, title: "t" }];
    const before = state_signature(env.db);
    const error = assert_error(await results_call(env, agent.token, lease, item, { expected_control_rev: "0" }), 409, "rev_conflict");
    assert.equal(error.details.expected, "0");
    assert.equal(error.details.current, "1");
    assert.equal(state_signature(env.db), before);
    assert_ok(await results_call(env, agent.token, lease, item, { expected_control_rev: "1" }));
  });
});

test("results: replay of a finished request returns the same ids and writes nothing more; other input under the key is 409", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "replay");
    const a = await new_artifact(env, "pa");
    const lease = await agent_claims(env, agent);
    const item = [{ op: "append_version", object_id: a.object_id, title: "t" }];
    const first = await results_call(env, agent.token, lease, item, {}, "same-key");
    const data = assert_ok(first);
    const before = state_signature(env.db);
    const second = await results_call(env, agent.token, lease, item, {}, "same-key");
    assert.equal(assert_ok(second).results[0].version_id, data.results[0].version_id);
    assert.equal(second.json.replayed, true);
    assert.equal(state_signature(env.db), before);
    const other = await results_call(env, agent.token, lease, [{ op: "append_version", object_id: a.object_id, title: "다른" }], {}, "same-key");
    assert_error(other, 409, "idempotency_key_reuse");
    assert.equal(state_signature(env.db), before);
  });
});

// ---------------------------------------------------------------------------
// (2) wait: no transaction held, bounds, no parking on a failed wait

test("wait: a refused wait (wrong lease) does not park, wait_ms 0 returns at once, and 25000 parks for exactly 25000", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "wb");
    const lease = await agent_claims(env, agent);
    env.hold_sleep = true;
    const path = P(env, `/runs/${lease.run_id}/wait`);
    const bad = await call(env, {
      method: "POST",
      path,
      auth: { token: agent.token },
      body: { lease_id: "wrong-lease", fence: lease.fence, wait_ms: 10_000 },
    });
    assert_error(bad, 409, "conflict");
    assert.equal(env.gates.length, 0, "a refused wait never sleeps");
    const zero = await call(env, {
      method: "POST",
      path,
      auth: { token: agent.token },
      body: { lease_id: lease.lease_id, fence: lease.fence, wait_ms: 0 },
    });
    assert_ok(zero);
    assert.equal(env.gates.length, 0, "wait_ms 0 returns at once");
  });
  await with_api(async (env) => {
    const agent = await make_agent(env, "wmax");
    const lease = await agent_claims(env, agent);
    env.hold_sleep = true;
    const pending = call(env, {
      method: "POST",
      path: P(env, `/runs/${lease.run_id}/wait`),
      auth: { token: agent.token },
      body: { lease_id: lease.lease_id, fence: lease.fence, wait_ms: 25_000 },
    });
    for (let i = 0; i < 200 && env.gates.length === 0; i += 1) await new Promise((r) => setImmediate(r));
    assert.equal(env.gates[0]?.ms, 25_000);
    env.gates[0].release();
    assert.equal(assert_ok(await pending).status, "waiting_human");
  });
});

test("wait: while a response is held the owner can write, and the same lease cannot wait again", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "held");
    const lease = await agent_claims(env, agent);
    env.hold_sleep = true;
    const pending = call(env, {
      method: "POST",
      path: P(env, `/runs/${lease.run_id}/wait`),
      auth: { token: agent.token },
      body: { lease_id: lease.lease_id, fence: lease.fence, wait_ms: 5_000 },
    });
    for (let i = 0; i < 200 && env.gates.length === 0; i += 1) await new Promise((r) => setImmediate(r));
    assert.equal(env.gates.length, 1);
    await env.service.execute({ ...env.ctx("held-topic"), base_control_rev: 0 }, "project.set_topic", { topic: "대기 중 바뀐 주제" });
    assert.equal(env.db.get<{ topic: string }>("SELECT topic FROM projects WHERE id = ?", env.p.project_id)?.topic, "대기 중 바뀐 주제");
    const again = await call(env, {
      method: "POST",
      path: P(env, `/runs/${lease.run_id}/wait`),
      auth: { token: agent.token },
      body: { lease_id: lease.lease_id, fence: lease.fence },
    });
    assert.equal(again.status, 409, `second wait got ${again.status}`);
    env.gates[0].release();
    assert_ok(await pending);
  });
});

test("wait: wait_ms must be an integer from 0 to 25000 (negative, string, null, boolean, float, array, object are 400)", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "wv");
    const lease = await agent_claims(env, agent);
    const before = state_signature(env.db);
    for (const wait_ms of [-1, "100", null, true, 1.5, 25_001, 1e12, [], {}]) {
      const res = await call(env, {
        method: "POST",
        path: P(env, `/runs/${lease.run_id}/wait`),
        auth: { token: agent.token },
        body: { lease_id: lease.lease_id, fence: lease.fence, wait_ms },
      });
      assert_error(res, 400, "invalid_payload");
    }
    assert.equal(state_signature(env.db), before);
  });
});

// ---------------------------------------------------------------------------
// (3) tokens, scopes, other projects, session

interface ScopedRoute {
  name: string;
  scope: string;
  method: string;
  rest: (lease: Lease) => string;
  body?: (lease: Lease) => unknown;
}

const SCOPED_ROUTES: ScopedRoute[] = [
  { name: "context", scope: "context:read", method: "GET", rest: () => "/context" },
  { name: "claims", scope: "run:claim", method: "POST", rest: () => "/claims", body: () => ({ mode: "B", runtime: "r", provider: "p", model: "m" }) },
  { name: "wait", scope: "run:submit", method: "POST", rest: (l) => `/runs/${l.run_id}/wait`, body: (l) => ({ lease_id: l.lease_id, fence: l.fence }) },
  { name: "results", scope: "run:submit", method: "POST", rest: (l) => `/runs/${l.run_id}/results`, body: (l) => ({ lease_id: l.lease_id, fence: l.fence, results: [] }) },
  { name: "complete", scope: "run:submit", method: "POST", rest: (l) => `/runs/${l.run_id}/complete`, body: (l) => ({ lease_id: l.lease_id, fence: l.fence }) },
  { name: "uploads", scope: "file:write", method: "POST", rest: () => "/uploads", body: () => ({}) },
  { name: "upload put", scope: "file:write", method: "PUT", rest: () => "/uploads/some-blob" },
  { name: "upload complete", scope: "file:write", method: "POST", rest: () => "/uploads/some-blob/complete", body: () => ({}) },
  { name: "file read", scope: "file:read", method: "GET", rest: () => "/files/some-blob/content" },
];

const ALL_SCOPES = ["context:read", "run:claim", "run:submit", "file:write", "file:read"];

function route_call(env: ApiEnv, route: ScopedRoute, lease: Lease, auth: Parameters<typeof call>[1]["auth"], headers: Record<string, string> = {}, project_path_override?: string) {
  return call(env, {
    method: route.method,
    path: project_path_override ?? P(env, route.rest(lease)),
    auth,
    headers,
    body: route.body?.(lease),
    raw: route.method === "PUT" ? bytes_of("x") : undefined,
  });
}

test("every scoped route refuses a token that has every scope except its own (403) and writes nothing", async () => {
  await with_api(async (env) => {
    const holder = await make_agent(env, "holder");
    const lease = await agent_claims(env, holder);
    const agents = new Map<string, Awaited<ReturnType<typeof make_agent>>>();
    for (const route of SCOPED_ROUTES) {
      if (!agents.has(route.scope)) {
        agents.set(route.scope, await make_agent(env, `no-${route.scope.replace(":", "-")}`, ALL_SCOPES.filter((s) => s !== route.scope)));
      }
    }
    const before = state_signature(env.db);
    for (const route of SCOPED_ROUTES) {
      const res = await route_call(env, route, lease, { token: agents.get(route.scope)!.token });
      assert_error(res, 403, "forbidden");
    }
    assert.equal(state_signature(env.db), before);
  });
});

test("every scoped route answers 401 for a missing, malformed, or non-Bearer credential", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "creds");
    const lease = await agent_claims(env, agent);
    const before = state_signature(env.db);
    const headers: Array<Record<string, string>> = [
      {},
      { authorization: "" },
      { authorization: "Bearer" },
      { authorization: "Bearer " },
      { authorization: `Basic ${agent.token}` },
      { authorization: `Token ${agent.token}` },
      { authorization: `Bearer ${agent.token} extra` },
      { authorization: "Bearer pes_not-a-real-token" },
    ];
    for (const route of SCOPED_ROUTES) {
      for (const h of headers) {
        assert_error(await route_call(env, route, lease, "none", h), 401, "unauthenticated");
      }
    }
    assert.equal(state_signature(env.db), before);
  });
});

test("a revoked, an expired, and a disabled-actor token are refused on a write route and change nothing", async () => {
  await with_api(async (env) => {
    const revoked = await make_agent(env, "rev");
    const expiring = await make_agent(env, "exp");
    const disabled = await make_agent(env, "dis");
    await revoke_agent_token(env.service, env.ctx("revoke-hard"), { token_id: revoked.token_id });
    env.db.run("UPDATE actors SET disabled_at = ? WHERE id = ?", env.clock.now_ms(), disabled.actor_id);
    const body = { mode: "B", runtime: "r", provider: "p", model: "m" };
    const before = state_signature(env.db);
    for (const agent of [revoked, disabled]) {
      const res = await call(env, { method: "POST", path: P(env, "/claims"), auth: { token: agent.token }, body });
      assert.ok([401, 403].includes(res.status), `got ${res.status}`);
      assert.ok(res.json.error);
    }
    assert.equal(state_signature(env.db), before);
    env.clock.advance(31 * 24 * 60 * 60 * 1000);
    const after_expiry = state_signature(env.db);
    assert_error(await call(env, { method: "POST", path: P(env, "/claims"), auth: { token: expiring.token }, body }), 401, "unauthenticated");
    assert.equal(state_signature(env.db), after_expiry);
  });
});

test("a token of project A on project B's paths is refused on every route and opens nothing", async () => {
  await with_api(async (env) => {
    const foreign = await foreign_artifact(env, "synthetic-token-other");
    const agent = await make_agent(env, "home-only");
    const lease = await agent_claims(env, agent);
    const before = state_signature(env.db);
    for (const route of SCOPED_ROUTES) {
      const res = await route_call(env, route, lease, { token: agent.token }, {}, `/api/v1/projects/${foreign.other.project_id}${route.rest(lease)}`);
      assert.ok([401, 403, 404].includes(res.status), `${route.name}: got ${res.status}`);
      assert.equal(res.json?.data, undefined);
    }
    assert.equal(state_signature(env.db), before);
  });
});

test("x-pes-session: a wrong, empty, or altered secret is 401 even next to a valid Bearer token", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "both");
    for (const secret of ["wrong", "", `${SESSION_SECRET}x`, SESSION_SECRET.toUpperCase(), ` ${SESSION_SECRET}`]) {
      const res = await call(env, {
        method: "GET",
        path: P(env, "/context"),
        auth: { token: agent.token },
        headers: { "x-pes-session": secret },
      });
      assert_error(res, 401, "unauthenticated");
    }
    assert_ok(await call(env, { method: "GET", path: P(env, "/context"), auth: "owner" }));
  });
});

test("x-pes-session cannot claim, wait, submit, or complete as the owner (the human gets no lease) and writes nothing", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "lease-holder");
    const lease = await agent_claims(env, agent);
    const a = await new_artifact(env, "sess");
    const before = state_signature(env.db);
    const attempts: Array<[string, unknown]> = [
      ["/claims", { mode: "B", runtime: "r", provider: "p", model: "m" }],
      [`/runs/${lease.run_id}/wait`, { lease_id: lease.lease_id, fence: lease.fence }],
      [`/runs/${lease.run_id}/results`, { lease_id: lease.lease_id, fence: lease.fence, results: [{ op: "append_version", object_id: a.object_id, title: "t" }] }],
      [`/runs/${lease.run_id}/complete`, { lease_id: lease.lease_id, fence: lease.fence }],
    ];
    for (const [rest, body] of attempts) {
      const res = await call(env, { method: "POST", path: P(env, rest), auth: "owner", body });
      assert.ok(res.status >= 400 && res.status < 500, `${rest}: the owner session got ${res.status}`);
      assert.equal(res.json.data, undefined);
    }
    assert.equal(state_signature(env.db), before);
  });
});

test("x-pes-session on a project with no human owner is 401, not an anonymous success", async () => {
  await with_api(async (env) => {
    env.db.run("UPDATE actors SET disabled_at = ? WHERE kind = 'human' AND id = ?", env.clock.now_ms(), env.p.actor_id);
    assert_error(await call(env, { method: "GET", path: P(env, "/context"), auth: "owner" }), 401, "unauthenticated");
  });
});

// ---------------------------------------------------------------------------
// (4) decimal-string boundaries

const BIG_DECIMALS = ["9007199254740992", "9007199254740993", "18446744073709551616", "99999999999999999999999999"];
const BAD_FORMS: unknown[] = [-1, "-1", "-0", "+1", "1.0", "1e3", "0x10", "\n1", "1\n", "１", "١", "1_0", "00", "01", 1e21, true, [], {}];

test("fence: values at or beyond 2^53, zero, negatives, and non-string forms are 400 on wait, results, and complete", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "fence");
    const lease = await agent_claims(env, agent);
    const before = state_signature(env.db);
    const routes: Array<[string, (fence: unknown) => unknown]> = [
      ["wait", (fence) => ({ lease_id: lease.lease_id, fence })],
      ["results", (fence) => ({ lease_id: lease.lease_id, fence, results: [] })],
      ["complete", (fence) => ({ lease_id: lease.lease_id, fence })],
    ];
    for (const [name, body] of routes) {
      for (const fence of ["0", ...BIG_DECIMALS, ...BAD_FORMS]) {
        const res = await call(env, { method: "POST", path: P(env, `/runs/${lease.run_id}/${name}`), auth: { token: agent.token }, body: body(fence) });
        assert_error(res, 400, "invalid_payload");
      }
    }
    assert.equal(state_signature(env.db), before);
  });
});

test("results expected_control_rev: bad forms and any number are 400; well-formed 2^53-and-larger strings are 409 (one decimal rule)", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "revbig");
    const lease = await agent_claims(env, agent);
    const items = [{ op: "append_version", object_id: (await new_artifact(env, "revbig")).object_id, title: "합성 항목" }];
    const before = state_signature(env.db);
    for (const rev of [...BAD_FORMS, 0, 5]) {
      const res = await results_call(env, agent.token, lease, items, { expected_control_rev: rev });
      assert_error(res, 400, "invalid_payload");
    }
    for (const rev of BIG_DECIMALS) {
      const error = assert_error(await results_call(env, agent.token, lease, items, { expected_control_rev: rev }), 409, "rev_conflict");
      assert.equal(error.details.expected, rev);
      assert.equal(error.details.current, "0");
    }
    assert.equal(state_signature(env.db), before);
  });
});

test("claim expected_control_rev: every well-formed huge decimal string is a clean 409 with exact strings, other forms are 400", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "claimbig");
    const body = { mode: "B", runtime: "r", provider: "p", model: "m" };
    const before = state_signature(env.db);
    for (const rev of [...BIG_DECIMALS, "9007199254740994", "9223372036854775808"]) {
      const res = await call(env, { method: "POST", path: P(env, "/claims"), auth: { token: agent.token }, body: { ...body, expected_control_rev: rev } });
      const error = assert_error(res, 409, "rev_conflict");
      assert.equal(error.details.expected, rev);
      assert.equal(error.details.current, "0");
    }
    for (const rev of BAD_FORMS) {
      assert_error(
        await call(env, { method: "POST", path: P(env, "/claims"), auth: { token: agent.token }, body: { ...body, expected_control_rev: rev } }),
        400,
        "invalid_payload",
      );
    }
    assert.equal(state_signature(env.db), before);
  });
});

test("the same expected_control_rev gets the same answer on results and claims at every size (one decimal rule)", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "uniform");
    const lease = await agent_claims(env, agent);
    const items = [{ op: "append_version", object_id: (await new_artifact(env, "uniform")).object_id, title: "합성 항목" }];
    for (const rev of ["9007199254740991", "9007199254740992", "9007199254740993", "9007199254740994", "9223372036854775808", "99999999999999999999999999"]) {
      const results = await results_call(env, agent.token, lease, items, { expected_control_rev: rev });
      const claims = await call(env, {
        method: "POST",
        path: P(env, "/claims"),
        auth: { token: agent.token },
        body: { mode: "B", runtime: "r", provider: "p", model: "m", expected_control_rev: rev },
      });
      assert.equal(results.status, 409, `results ${rev}`);
      assert.equal(claims.status, 409, `claims ${rev}`);
    }
  });
});

// ---------------------------------------------------------------------------
// (5) unknown fields, bad JSON, big bodies

interface BodyRoute {
  name: string;
  rest: (lease: Lease) => string;
  ok: (lease: Lease) => Record<string, unknown>;
  owner?: boolean;
}

const BODY_ROUTES: BodyRoute[] = [
  { name: "claims", rest: () => "/claims", ok: () => ({ mode: "B", runtime: "r", provider: "p", model: "m" }) },
  { name: "wait", rest: (l) => `/runs/${l.run_id}/wait`, ok: (l) => ({ lease_id: l.lease_id, fence: l.fence }) },
  { name: "results", rest: (l) => `/runs/${l.run_id}/results`, ok: (l) => ({ lease_id: l.lease_id, fence: l.fence, results: [] }) },
  { name: "complete", rest: (l) => `/runs/${l.run_id}/complete`, ok: (l) => ({ lease_id: l.lease_id, fence: l.fence }) },
  { name: "uploads", rest: () => "/uploads", ok: () => ({}) },
  { name: "upload complete", rest: () => "/uploads/some-blob/complete", ok: () => ({}) },
  { name: "runs", rest: () => "/runs", ok: () => ({}), owner: true },
];

test("every JSON route rejects an unknown field, __proto__, and non-object or broken bodies with 400 and no write", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "closed");
    const lease = await agent_claims(env, agent);
    const before = state_signature(env.db);
    for (const route of BODY_ROUTES) {
      const auth = route.owner === true ? ("owner" as const) : { token: agent.token };
      const path = P(env, route.rest(lease));
      const send = (raw: string | Uint8Array) => call(env, { method: "POST", path, auth, raw });
      assert_error(await call(env, { method: "POST", path, auth, body: { ...route.ok(lease), surprise: 1 } }), 400, "invalid_payload");
      assert_error(await send(`{"__proto__":{"admin":true}}`), 400, "invalid_payload");
      for (const raw of ["null", "123", '"text"', "true", "   ", "[1]", "{", '{"a":}', "{'a':1}", "{}garbage"]) {
        const res = await send(raw);
        assert.equal(res.status, 400, `${route.name} ${JSON.stringify(raw)} got ${res.status}`);
        assert.equal(res.json.error.code, "invalid_payload");
      }
      assert_error(await send(new Uint8Array([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x3a, 0x31, 0x7d])), 400, "invalid_payload");
    }
    assert.equal(({} as Record<string, unknown>).admin, undefined, "no prototype pollution");
    assert.equal(state_signature(env.db), before);
  });
});

test("deeply nested JSON inside the size limit is a clean 400, never a 500", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "deep");
    const depth = 100_000;
    const raw = `{"mode":${"[".repeat(depth)}${"]".repeat(depth)}}`;
    assert.ok(raw.length < 256 * 1024);
    const res = await call(env, { method: "POST", path: P(env, "/claims"), auth: { token: agent.token }, raw });
    assert.equal(res.status, 400);
    assert.equal(res.json.error.code, "invalid_payload");
  });
});

test("body size: exactly 256 KiB passes the size gate, one byte more is 413 (bytes, not characters), auth comes first", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "size");
    const path = P(env, "/claims");
    const pad = (total: number) => {
      const base = JSON.stringify({ mode: "B", runtime: "r", provider: "p", model: "m", pad: "" });
      return base.replace('"pad":""', `"pad":"${"x".repeat(total - base.length)}"`);
    };
    const exact = pad(256 * 1024);
    assert.equal(Buffer.byteLength(exact), 256 * 1024);
    // past the size gate; `pad` is then rejected by the closed field list
    assert_error(await call(env, { method: "POST", path, auth: { token: agent.token }, raw: exact }), 400, "invalid_payload");
    const over = pad(256 * 1024 + 1);
    assert_error(await call(env, { method: "POST", path, auth: { token: agent.token }, raw: over }), 413, "payload_too_large");
    const wide = `{"mode":"B","runtime":"r","provider":"p","model":"m","pad":"${"가".repeat(90_000)}"}`;
    assert.ok(Buffer.byteLength(wide) > 256 * 1024 && wide.length < 256 * 1024);
    assert_error(await call(env, { method: "POST", path, auth: { token: agent.token }, raw: wide }), 413, "payload_too_large");
    assert_error(await call(env, { method: "POST", path, raw: over }), 401, "unauthenticated");
    const put = await call(env, { method: "PUT", path: P(env, "/uploads/no-such-blob"), auth: { token: agent.token }, raw: new Uint8Array(300 * 1024) });
    assert.ok(put.status < 500, `PUT of 300 KiB got ${put.status}`);
  });
});

test("lone surrogates and blank strings in text fields are 400 and write nothing", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "text");
    const lease = await agent_claims(env, agent);
    const before = state_signature(env.db);
    for (const bad of ["\\ud800", "", "   "]) {
      const raw = `{"mode":"B","runtime":"${bad}","provider":"p","model":"m"}`;
      assert_error(await call(env, { method: "POST", path: P(env, "/claims"), auth: { token: agent.token }, raw }), 400, "invalid_payload");
      const raw2 = `{"lease_id":"${bad}","fence":"${lease.fence}"}`;
      assert_error(await call(env, { method: "POST", path: P(env, `/runs/${lease.run_id}/complete`), auth: { token: agent.token }, raw: raw2 }), 400, "invalid_payload");
    }
    assert.equal(state_signature(env.db), before);
  });
});

test("odd paths: trailing or double slash, dot segments, encoded separators, and traversal ids are 404 with a JSON error", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "paths");
    const base = `/api/v1/projects/${env.p.project_id}`;
    const before = state_signature(env.db);
    for (const path of [
      "/api/v1/capabilities/",
      "/api//v1/capabilities",
      `${base}/context/`,
      `${base}//context`,
      `${base}/files/../context`,
      `${base}/files//content`,
      `${base}/runs//wait`,
    ]) {
      const res = await call(env, { method: "GET", path, auth: { token: agent.token } });
      assert.ok([404, 405].includes(res.status), `${path} got ${res.status}`);
      assert.ok(res.json?.error, `${path}: JSON error envelope`);
      assert.equal(res.bytes, null);
    }
    assert.equal(state_signature(env.db), before);
  });
});

test("encoded or traversal blob ids are a client error with a JSON envelope and never read a file", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "blobid");
    const before = state_signature(env.db);
    for (const id of ["%2e%2e%2fcontext", "..%2F..%2Fetc%2Fpasswd", "%2e%2e", "a%00b", "x".repeat(5000)]) {
      const res = await call(env, { method: "GET", path: `${P(env, `/files/${id}/content`)}`, auth: { token: agent.token } });
      assert.ok([400, 404].includes(res.status), `${id.slice(0, 20)} got ${res.status}`);
      assert.ok(res.json?.error);
      assert.equal(res.bytes, null);
    }
    assert.equal(state_signature(env.db), before);
  });
});

test("a query string does not change the route and a very long Idempotency-Key is never a 500", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "query");
    assert_ok(await call(env, { method: "GET", path: `${P(env, "/context")}?a=1&b=%00`, auth: { token: agent.token } }));
    const res = await call(env, {
      method: "POST",
      path: P(env, "/claims"),
      auth: { token: agent.token },
      key: "k".repeat(100_000),
      body: { mode: "B", runtime: "r", provider: "p", model: "m" },
    });
    assert.ok(res.status < 500, `long key got ${res.status}`);
  });
});

// ---------------------------------------------------------------------------
// (6) project.create writes nothing on failure

test("project create: invalid bodies and client-chosen ids write nothing", async () => {
  await with_api(async (env) => {
    const before = state_signature(env.db);
    const base = { slug: "synthetic-v", topic: "합성 주제", owner_display_name: "합성" };
    const bad: string[] = [
      JSON.stringify({ ...base, slug: "" }),
      JSON.stringify({ ...base, slug: "  " }),
      JSON.stringify({ ...base, topic: 5 }),
      JSON.stringify({ ...base, owner_display_name: null }),
      JSON.stringify({ slug: base.slug, topic: base.topic }),
      JSON.stringify({ ...base, project_id: "client-chosen" }),
      JSON.stringify({ ...base, policy_id: "client-chosen" }),
      `{"slug":"\\ud800","topic":"t","owner_display_name":"o"}`,
    ];
    for (const raw of bad) {
      assert_error(await call(env, { method: "POST", path: "/api/v1/projects", auth: "owner", raw }), 400, "invalid_payload");
    }
    assert.equal(state_signature(env.db), before);
  });
});

test("DEFECT? project create must refuse a slug that is not a safe single path name (../x, a/b, control characters, 300 chars)", async () => {
  await with_api(async (env) => {
    const accepted: string[] = [];
    for (const slug of ["../escape", "a/b", "a\\b", "bad\u0000slug", "x".repeat(300), " lead", "UPPER Case"]) {
      const res = await call(env, {
        method: "POST",
        path: "/api/v1/projects",
        auth: "owner",
        body: { slug, topic: "합성", owner_display_name: "합성" },
      });
      assert.ok(res.status < 500, `slug ${JSON.stringify(slug.slice(0, 20))} got ${res.status}`);
      if (res.status < 300) accepted.push(slug.slice(0, 20));
    }
    assert.deepEqual(accepted, [], "these slugs were accepted");
  });
});

test("project create: a failing receipt, user, or actor insert also leaves nothing behind, and no 'replayed' leaks into the error", async () => {
  for (const failing_table of ["mutation_commits", "users", "actors"]) {
    let armed = true;
    const body = { slug: "synthetic-hard", topic: "합성", owner_display_name: "합성" };
    await with_api(
      async (env) => {
        const before = state_signature(env.db);
        const res = await call(env, { method: "POST", path: "/api/v1/projects", auth: "owner", key: "create-hard", body });
        assert_error(res, 500, "internal_error");
        assert.equal("replayed" in res.json, false);
        assert.equal(state_signature(env.db), before, `${failing_table}: nothing written`);
        armed = false;
        assert_ok(await call(env, { method: "POST", path: "/api/v1/projects", auth: "owner", key: "create-hard", body }), 201);
      },
      {
        wrap: (db) =>
          wrap_db(db, (sql) => {
            if (armed && new RegExp(`^\\s*INSERT INTO ${failing_table}\\b`, "i").test(sql)) throw new Error("boom: disk full");
          }),
      },
    );
  }
});

test("project create: an agent token or no credential cannot create or replay a finished create", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "creator");
    const body = { slug: "synthetic-rep", topic: "합성", owner_display_name: "합성" };
    assert_ok(await call(env, { method: "POST", path: "/api/v1/projects", auth: "owner", key: "rep", body }), 201);
    const before = state_signature(env.db);
    assert_error(await call(env, { method: "POST", path: "/api/v1/projects", auth: { token: agent.token }, key: "rep", body }), 401, "unauthenticated");
    assert_error(await call(env, { method: "POST", path: "/api/v1/projects", key: "rep", body }), 401, "unauthenticated");
    assert.equal(state_signature(env.db), before);
  });
});

// ---------------------------------------------------------------------------
// (8) OpenAPI ↔ route table

interface OpenApiOperation {
  method: string;
  path: string;
  statuses: string[];
}

function read_openapi(): { operations: OpenApiOperation[]; text: string } {
  const text = readFileSync(OPENAPI_PATH, "utf8");
  const operations: OpenApiOperation[] = [];
  let in_paths = false;
  let path = "";
  let current: OpenApiOperation | null = null;
  let in_responses = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^paths:\s*$/.test(line)) {
      in_paths = true;
      continue;
    }
    if (/^\S/.test(line)) in_paths = false;
    if (!in_paths) continue;
    const p = line.match(/^ {2}(\/\S*):\s*$/);
    if (p) {
      path = p[1];
      current = null;
      in_responses = false;
      continue;
    }
    const m = line.match(/^ {4}(get|post|put|patch|delete|head|options):\s*$/);
    if (m) {
      current = { method: m[1].toUpperCase(), path, statuses: [] };
      operations.push(current);
      in_responses = false;
      continue;
    }
    if (current === null) continue;
    if (/^ {6}responses:\s*$/.test(line)) {
      in_responses = true;
      continue;
    }
    if (/^ {6}\S/.test(line)) in_responses = false;
    const s = line.match(/^ {8}['"]?(\d{3})['"]?:/);
    if (in_responses && s) current.statuses.push(s[1]);
  }
  return { operations, text };
}

const normalize_route = (route: string) => route.replace(/\{r\}/g, "{run}").replace(/\{b\}/g, "{blob}");

test("OpenAPI documents exactly the routes capabilities lists (no missing, no extra, same methods)", async () => {
  await with_api(async (env) => {
    const caps = assert_ok(await call(env, { method: "GET", path: "/api/v1/capabilities" }));
    const listed = (caps.routes as string[]).map(normalize_route).sort();
    const { operations } = read_openapi();
    const documented = operations.map((op) => normalize_route(`${op.method} ${op.path}`)).sort();
    assert.deepEqual(documented, listed);
  });
});

test("every capabilities route exists in the app: any other method on its path is 405 with an Allow naming its method", async () => {
  await with_api(async (env) => {
    const caps = assert_ok(await call(env, { method: "GET", path: "/api/v1/capabilities" }));
    for (const route of caps.routes as string[]) {
      const [method, template] = route.split(" ");
      const path = template.replace("{id}", env.p.project_id).replace("{run}", "r1").replace("{blob}", "b1");
      // a method that is registered on this very path (GET and POST of the SEL-93 records routes) is not "another" method
      const registered = new Set((caps.routes as string[]).filter((r) => r.split(" ")[1] === template).map((r) => r.split(" ")[0]));
      for (const other of ["GET", "POST", "PUT", "PATCH", "DELETE"].filter((m) => !registered.has(m))) {
        const res = await call(env, { method: other, path, auth: "owner", raw: "{}" });
        assert_error(res, 405, "method_not_allowed");
        assert.ok((res.headers["allow"] ?? "").split(/,\s*/).includes(method), `${route}: Allow lists ${method}`);
      }
    }
  });
});

test("OpenAPI documents the success statuses the app really returns for each operation", () => {
  const { operations } = read_openapi();
  const success = (path: string, method: string) =>
    operations.find((op) => op.path === path && op.method === method)?.statuses.filter((s) => s.startsWith("2")).sort() ?? [];
  assert.deepEqual(success("/api/v1/projects", "POST"), ["201"]);
  assert.deepEqual(success("/api/v1/projects/{id}/runs", "POST"), ["201"]);
  assert.deepEqual(success("/api/v1/projects/{id}/uploads", "POST"), ["200", "201"]);
  for (const [path, method] of [
    ["/api/v1/capabilities", "GET"],
    ["/api/v1/projects/{id}/context", "GET"],
    ["/api/v1/projects/{id}/claims", "POST"],
    ["/api/v1/projects/{id}/runs/{r}/wait", "POST"],
    ["/api/v1/projects/{id}/runs/{r}/results", "POST"],
    ["/api/v1/projects/{id}/runs/{r}/complete", "POST"],
    ["/api/v1/projects/{id}/uploads/{b}", "PUT"],
    ["/api/v1/projects/{id}/uploads/{b}/complete", "POST"],
    ["/api/v1/projects/{id}/files/{b}/content", "GET"],
  ]) {
    assert.deepEqual(success(path, method), ["200"], `${method} ${path}`);
  }
});

test("DEFECT? OpenAPI documents every error status the app returns: 401, 404 unknown project, 400 and 413 for JSON bodies", () => {
  const { operations } = read_openapi();
  const missing: string[] = [];
  for (const op of operations) {
    const need: string[] = [];
    if (op.path !== "/api/v1/capabilities") need.push("401");
    if (op.path.includes("{id}")) need.push("404");
    if (op.method === "POST") need.push("400", "413");
    for (const status of need) {
      if (!op.statuses.includes(status)) missing.push(`${op.method} ${op.path} lacks ${status}`);
    }
  }
  assert.deepEqual(missing, []);
});

test("OpenAPI documents the Idempotency-Key header, the x-pes-session header, and the Bearer scheme", () => {
  const { text } = read_openapi();
  assert.match(text, /Idempotency-Key/);
  assert.match(text, /x-pes-session/i);
  assert.match(text, /bearer/i);
});

test("DEFECT? OpenAPI documents the 405 method_not_allowed answer and its Allow header", () => {
  const { text } = read_openapi();
  assert.match(text, /["']?405["']?\s*:/);
  assert.match(text, /\bAllow\b/);
});

test("capabilities limits match what the app enforces (batch size, long-poll maximum) and every scope can be issued", async () => {
  await with_api(async (env) => {
    const caps = assert_ok(await call(env, { method: "GET", path: "/api/v1/capabilities" }));
    assert.equal(caps.limits.max_body_bytes, 256 * 1024);
    assert.equal(caps.limits.max_results_per_batch, 20);
    assert.equal(caps.limits.long_poll_max_ms, 25_000);
    const agent = await make_agent(env, "limits");
    const lease = await agent_claims(env, agent);
    assert_error(
      await results_call(env, agent.token, lease, Array.from({ length: caps.limits.max_results_per_batch + 1 }, () => ({ op: "append_version" }))),
      400,
      "invalid_payload",
    );
    assert_error(
      await call(env, {
        method: "POST",
        path: P(env, `/runs/${lease.run_id}/wait`),
        auth: { token: agent.token },
        body: { lease_id: lease.lease_id, fence: lease.fence, wait_ms: caps.limits.long_poll_max_ms + 1 },
      }),
      400,
      "invalid_payload",
    );
    assert.deepEqual([...(caps.scopes as string[])].sort(), [...ALL_SCOPES].sort());
  });
});
