/**
 * SEL-47 PR14 — HTTP API, 보강 모드 (tester). Gaps found by reading the implementation, not the issue text.
 * A test whose title starts with "DEFECT?" fails on purpose: the implementation looks wrong there and the
 * reason is in the comment above it.
 *
 *   1. human session vs agent token (credential matrix on every human-only route, session + token together)
 *   2. project.register (key reuse across commands, hostile slugs, the raw token appears nowhere)
 *   3. changes cursor (other scope, tampering, the 2-event round.start transaction is never split)
 *   4. run lifecycle (non-holders, lease_lost must not hand out another actor's lease, operations lookups)
 *   5. request budgets (the bridge builds a new ApiApp per request, so an in-memory budget never fires)
 *   6. error envelope on every route
 *   7. stage.activated next to round.started
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SESSION_SECRET,
  agent_claims,
  assert_ok,
  call,
  make_agent,
  owner_creates_run,
  with_api,
  type ApiEnv,
  type ApiResponse,
} from "./helpers/api_env.ts";
import { EXPECTED_ROUTES, P, restart_app } from "./helpers/api_flow.ts";
import { approve, make_content, seal, stage_ids, start } from "./helpers/editions_env.ts";
import { state_signature, table_counts } from "./helpers/state_signature.ts";

const REGISTER = "/api/v1/project-registrations";
const HANGUL = /[가-힣]/;

function envelope_ok(res: ApiResponse, where: string): void {
  assert.ok(res.json, `${where}: a JSON body`);
  assert.equal(res.json.format_version, "1.0", where);
  assert.equal(typeof res.json.request_id, "string", where);
  const e = res.json.error;
  assert.ok(e, `${where}: an error body, got ${res.status} ${JSON.stringify(res.json)}`);
  assert.match(e.message, HANGUL, `${where}: Korean message`);
  assert.equal(typeof e.code, "string", where);
  assert.equal(typeof e.retryable, "boolean", where);
  assert.match(e.next_action, /^[a-z][a-z0-9_]*$/, `${where}: next_action`);
  assert.ok("target" in e && "details" in e, `${where}: target and details keys`);
  assert.equal(res.headers["x-request-id"], res.json.request_id, where);
}

function dump(env: ApiEnv): string {
  return state_signature(env.db);
}

// ---------------------------------------------------------------------------
// 1. human session vs agent token

test("human-only routes: no credential, forged or empty session, a foreign project's device token, and a full-scope agent all fail and write nothing", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "sweeper");
    const s = stage_ids(env.db, env.p.edition_id);
    const reg = assert_ok(
      await call(env, {
        method: "POST",
        path: REGISTER,
        auth: "owner",
        body: { slug: "synthetic-sweep-other", topic: "합성", owner_display_name: "합성", device_label: "합성 기기" },
      }),
      201,
    );
    const foreign = reg.token as string;
    const routes: Array<[string, string, unknown]> = [
      ["POST", `/stages/${s.plan}/approve`, { snapshot_id: "snap-x" }],
      ["POST", `/stages/${s.plan}/reopen`, { reason: "x" }],
      ["POST", `/submissions`, { set_id: "s", answers: [] }],
      ["POST", `/policies/opencode-go/revisions`, { reason: "x", allow_opencode_go: false }],
      ["POST", `/runs`, { actor_id: agent.actor_id, mode: "B", runtime: "r", provider: "p", model: "m" }],
    ];
    const before = dump(env);
    const credentials: Array<[string, Record<string, string>, number[]]> = [
      ["none", {}, [401]],
      ["forged session", { "x-pes-session": "not-the-secret" }, [401]],
      ["empty session", { "x-pes-session": "" }, [401]],
      ["session with a trailing space", { "x-pes-session": `${SESSION_SECRET} ` }, [401]],
      ["forged session beside a valid token", { "x-pes-session": "nope", authorization: `Bearer ${agent.token}` }, [401]],
      ["foreign project token", { authorization: `Bearer ${foreign}` }, [401, 403, 404]],
      ["valid agent token", { authorization: `Bearer ${agent.token}` }, [403]],
      ["valid agent token, lower-case scheme", { authorization: `bearer ${agent.token}` }, [403]],
    ];
    for (const [method, rest, body] of routes) {
      for (const [label, headers, allowed] of credentials) {
        const res = await call(env, { method, path: P(env, rest), body, headers });
        assert.ok(allowed.includes(res.status), `${rest} with ${label}: ${res.status} ${JSON.stringify(res.json)}`);
        envelope_ok(res, `${rest} with ${label}`);
      }
    }
    assert.equal(dump(env), before, "no refusal wrote anything");
  });
});

test("a valid session next to an agent token is the human session: it never acts as the agent on agent-only routes", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "both");
    const lease = await agent_claims(env, agent);
    const before = dump(env);
    const both = { "x-pes-session": SESSION_SECRET, authorization: `Bearer ${agent.token}` };
    const guard = { lease_id: lease.lease_id, fence: lease.fence };
    const tries: Array<[string, string, string, unknown]> = [
      ["POST", `/runs/${lease.run_id}/heartbeat`, "heartbeat", guard],
      ["POST", `/runs/${lease.run_id}/release`, "release", guard],
      ["POST", `/runs/${lease.run_id}/input-receipts`, "receipts", { ...guard, receipts: [{ input_version_id: "x", state: "seen" }] }],
      ["GET", `/runs/${lease.run_id}/inputs`, "inputs", undefined],
    ];
    for (const [method, rest, label, body] of tries) {
      const res = await call(env, { method, path: P(env, rest), body, headers: both });
      assert.equal(res.status, 403, `${label}: ${res.status} ${JSON.stringify(res.json)}`);
      envelope_ok(res, label);
    }
    assert.equal(dump(env), before);
  });
});

// ---------------------------------------------------------------------------
// 2. project.register

test("register: with no credential, a project token, or a wrong session nothing is created, and hostile slugs and override fields are 400", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "reg");
    const body = { slug: "synthetic-reg-x", topic: "합성", owner_display_name: "합성", device_label: "합성" };
    const before = dump(env);
    for (const headers of [{}, { "x-pes-session": "wrong" }, { authorization: `Bearer ${agent.token}` }] as Array<Record<string, string>>) {
      const res = await call(env, { method: "POST", path: REGISTER, body, headers });
      assert.equal(res.status, 401);
      envelope_ok(res, "register credential");
    }
    for (const slug of ["", " ", "../x", "a/b", "A B", "x\u0000y", "x".repeat(300), "Ü"]) {
      const res = await call(env, { method: "POST", path: REGISTER, auth: "owner", body: { ...body, slug } });
      assert.ok([400, 422].includes(res.status), `slug ${JSON.stringify(slug).slice(0, 20)}: ${res.status}`);
      envelope_ok(res, "register slug");
    }
    for (const extra of [
      { owner_user_id: "u" },
      { actor_id: "a" },
      { project_id: "p" },
      { role: "owner" },
      { kind: "human" },
      { token: "tok" },
      { expires_at: 1 },
      { allow_opencode_go: false },
      { policy: { allow_opencode_go: false } },
      { edition_id: "e" },
      { via: "cli" },
    ]) {
      const res = await call(env, { method: "POST", path: REGISTER, auth: "owner", body: { ...body, ...extra } });
      assert.equal(res.status, 400, JSON.stringify(extra));
      envelope_ok(res, "register override");
    }
    assert.equal(dump(env), before, "nothing was created");
  });
});

test("register: one Idempotency-Key text used by POST /projects and by register makes two projects, and each replay answers its own", async () => {
  await with_api(async (env) => {
    const mk = { slug: "synthetic-shared-a", topic: "합성", owner_display_name: "합성" };
    const rg = { slug: "synthetic-shared-b", topic: "합성", owner_display_name: "합성", device_label: "합성" };
    const created = assert_ok(await call(env, { method: "POST", path: "/api/v1/projects", auth: "owner", key: "shared-key", body: mk }), 201);
    const registered = assert_ok(await call(env, { method: "POST", path: REGISTER, auth: "owner", key: "shared-key", body: rg }), 201);
    assert.notEqual(created.project_id, registered.project_id);
    const before = table_counts(env.db);
    const again_create = await call(env, { method: "POST", path: "/api/v1/projects", auth: "owner", key: "shared-key", body: mk });
    const again_register = await call(env, { method: "POST", path: REGISTER, auth: "owner", key: "shared-key", body: rg });
    assert.equal(assert_ok(again_create, 201).project_id, created.project_id);
    const replayed = assert_ok(again_register, 201);
    assert.equal(replayed.project_id, registered.project_id);
    assert.equal(replayed.token, undefined, "a register replay never repeats the token");
    assert.deepEqual(table_counts(env.db), before, "the replays wrote nothing");
    const other_body = await call(env, { method: "POST", path: REGISTER, auth: "owner", key: "shared-key", body: { ...rg, slug: "synthetic-shared-c" } });
    assert.equal(other_body.status, 409);
    envelope_ok(other_body, "register key reuse");
  });
});

test("register: the raw device token appears in the first answer only — not in a replay, the request lookup, the changes feed, or any stored row", async () => {
  await with_api(async (env) => {
    const body = { slug: "synthetic-reg-secret", topic: "합성", owner_display_name: "합성", device_label: "합성" };
    const first = await call(env, { method: "POST", path: REGISTER, auth: "owner", key: "reg-secret-1", body });
    const data = assert_ok(first, 201);
    const token = data.token as string;
    assert.ok(token.length >= 20);
    const replay = await call(env, { method: "POST", path: REGISTER, auth: "owner", key: "reg-secret-1", body });
    assert.equal(replay.json.replayed, true);
    assert.ok(!JSON.stringify(replay.json).includes(token), "replay");
    const lookup = await call(env, { method: "GET", path: `/api/v1/projects/${data.project_id}/requests/reg-secret-1`, auth: "owner" });
    // The lookup may be 200 or 404 (the receipt belongs to no project actor yet); either way no secret.
    assert.ok(!JSON.stringify(lookup.json).includes(token), "request lookup");
    for (const who of ["owner", { token }] as const) {
      const feed = await call(env, { method: "GET", path: `/api/v1/projects/${data.project_id}/changes`, auth: who });
      assert.ok(!JSON.stringify(feed.json).includes(token), "changes feed");
    }
    const everything = dump(env);
    assert.ok(!everything.includes(token), "no row stores the raw token");
    const hash = Buffer.from(token).toString("hex");
    assert.ok(!everything.includes(hash));
  });
});

test("register: a failure in the request itself leaves the key reusable — a corrected body under the same key registers once", async () => {
  await with_api(async (env) => {
    const bad = await call(env, { method: "POST", path: REGISTER, auth: "owner", key: "reg-fix", body: { slug: "Bad Slug", topic: "합성", owner_display_name: "합성", device_label: "합성" } });
    assert.equal(bad.status, 400);
    const before = table_counts(env.db);
    const ok = await call(env, { method: "POST", path: REGISTER, auth: "owner", key: "reg-fix", body: { slug: "synthetic-reg-fix", topic: "합성", owner_display_name: "합성", device_label: "합성" } });
    assert_ok(ok, 201);
    const after = table_counts(env.db);
    assert.equal(after.projects - before.projects, 1n);
    assert.equal(after.agent_tokens - before.agent_tokens, 1n);
  });
});

// ---------------------------------------------------------------------------
// 3. changes cursor

test("changes: a cursor of another route (inputs) or a flipped, cut, or extended cursor is cursor_invalid, and an empty one is not 'from the start'", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "cur");
    const lease = await agent_claims(env, agent);
    const feed = assert_ok(await call(env, { method: "GET", path: P(env, "/changes"), auth: "owner" }));
    const good = feed.next_cursor as string;
    const inputs = assert_ok(await call(env, { method: "GET", path: P(env, `/runs/${lease.run_id}/inputs`), auth: { token: agent.token } }));
    const foreign_scope = inputs.next_cursor as string;

    const bad = async (cursor: string, label: string) => {
      const res = await call(env, { method: "GET", path: P(env, `/changes?cursor=${encodeURIComponent(cursor)}`), auth: "owner" });
      assert.equal(res.status, 400, `${label}: ${res.status} ${JSON.stringify(res.json)}`);
      assert.equal(res.json.error.code, "cursor_invalid", label);
      envelope_ok(res, label);
    };
    await bad(foreign_scope, "inputs cursor on changes");
    await bad("", "empty cursor");
    await bad(good.slice(0, -1), "cut");
    await bad(`${good}A`, "extended");
    await bad(good.split("").reverse().join(""), "reversed");
    for (const i of [0, Math.floor(good.length / 2), good.length - 1]) {
      const c = good[i] === "A" ? "B" : "A";
      await bad(good.slice(0, i) + c + good.slice(i + 1), `byte ${i} flipped`);
    }
    // and the other way round: a changes cursor is not an inputs cursor
    const res = await call(env, { method: "GET", path: P(env, `/runs/${lease.run_id}/inputs?cursor=${encodeURIComponent(good)}`), auth: { token: agent.token } });
    assert.equal(res.status, 400);
    assert.equal(res.json.error.code, "cursor_invalid");
  });
});

test("changes: round.start leaves two events in one transaction; limit=1 never splits them and paging visits every visible event once", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "pager");
    const s = stage_ids(env.db, env.p.edition_id);
    await start(env, s.plan, "pager-start");
    await make_agent(env, "pager2"); // a hidden token.* transaction after the round
    await start(env, s.research, "pager-start-2").catch(() => undefined); // may be refused by order; never matters here
    const all = assert_ok(await call(env, { method: "GET", path: P(env, "/changes"), auth: { token: agent.token } }));
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 100; i += 1) {
      const path = P(env, `/changes?limit=1${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`);
      const page = assert_ok(await call(env, { method: "GET", path, auth: { token: agent.token } }));
      for (const e of page.events) seen.push(e.event_seq);
      cursor = page.next_cursor;
      if (!page.has_more) break;
    }
    assert.deepEqual(seen, all.events.map((e: any) => e.event_seq), "limit=1 paging equals the single read");
    assert.equal(new Set(seen).size, seen.length, "no duplicates");
    const types = all.events.map((e: any) => e.type);
    const i = types.indexOf("round.started");
    assert.ok(i >= 0 && types[i + 1] === "stage.activated", `round.started is followed by stage.activated: ${types.join(",")}`);
    const first = assert_ok(await call(env, { method: "GET", path: P(env, `/changes?limit=1&cursor=${encodeURIComponent(assert_ok(await call(env, { method: "GET", path: P(env, "/changes?limit=100"), auth: "owner" })).next_cursor)}`), auth: "owner" }));
    assert.deepEqual(first.events, []);
  });
});

// ---------------------------------------------------------------------------
// 4. run lifecycle

// DEFECT? lease_lost hands the project's CURRENT live lease_id and fence to whoever sent the failing
// request (api.ts #lease_lost reads project_leases without checking the caller). The project has one lease,
// so any other agent — one that never held it — learns the holder's lease_id by sending a heartbeat,
// release, or input-receipts with a made-up lease.
test("DEFECT? lease_lost to a caller who is not the holder does not reveal the holder's lease_id or fence", async () => {
  await with_api(async (env) => {
    const holder = await make_agent(env, "holder");
    const other = await make_agent(env, "outsider");
    const lease = await agent_claims(env, holder);
    const other_run = await owner_creates_run(env, other);
    const before = dump(env);
    const fake = { lease_id: "made-up-lease", fence: "1" };
    for (const [rest, body] of [
      [`/runs/${other_run}/heartbeat`, fake],
      [`/runs/${other_run}/release`, fake],
      [`/runs/${lease.run_id}/heartbeat`, fake],
      [`/runs/${lease.run_id}/release`, fake],
    ] as Array<[string, unknown]>) {
      const res = await call(env, { method: "POST", path: P(env, rest), auth: { token: other.token }, body });
      assert.ok(res.status >= 400 && res.status < 500, `${rest}: ${res.status}`);
      const text = JSON.stringify(res.json);
      assert.ok(!text.includes(lease.lease_id), `${rest} leaked the holder's lease_id: ${text}`);
    }
    assert.equal(dump(env), before);
  });
});

test("heartbeat, release, interrupt, cancel and handoffs by an agent that is not the run's holder or actor write nothing", async () => {
  await with_api(async (env) => {
    const holder = await make_agent(env, "own");
    const other = await make_agent(env, "stranger");
    const lease = await agent_claims(env, holder);
    const before = dump(env);
    const guard = { lease_id: lease.lease_id, fence: lease.fence };
    const tries: Array<[string, unknown]> = [
      [`/runs/${lease.run_id}/heartbeat`, guard],
      [`/runs/${lease.run_id}/release`, guard],
      [`/runs/${lease.run_id}/handoffs`, { target_mode: "B" }],
      [`/runs/${lease.run_id}/interrupt`, {}],
      [`/runs/${lease.run_id}/cancel`, { confirm: true }],
      [`/runs/${lease.run_id}/input-receipts`, { ...guard, receipts: [{ input_version_id: "x", state: "seen" }] }],
    ];
    for (const [rest, body] of tries) {
      const res = await call(env, { method: "POST", path: P(env, rest), auth: { token: other.token }, body });
      assert.ok([403, 404, 409].includes(res.status), `${rest}: ${res.status} ${JSON.stringify(res.json)}`);
      envelope_ok(res, rest);
    }
    const inputs = await call(env, { method: "GET", path: P(env, `/runs/${lease.run_id}/inputs`), auth: { token: other.token } });
    assert.equal(inputs.status, 403);
    assert.equal(dump(env), before, "the strangers wrote nothing and the holder's lease is intact");
    assert.ok(assert_ok(await call(env, { method: "POST", path: P(env, `/runs/${lease.run_id}/heartbeat`), auth: { token: holder.token }, body: guard })));
  });
});

test("run routes of a run in another project or an unknown run id are 404/403 for agents and the owner, and write nothing", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "xrun");
    const lease = await agent_claims(env, agent);
    const reg = assert_ok(
      await call(env, { method: "POST", path: REGISTER, auth: "owner", body: { slug: "synthetic-xrun", topic: "합성", owner_display_name: "합성", device_label: "합성" } }),
      201,
    );
    const foreign_path = (rest: string) => `/api/v1/projects/${reg.project_id}${rest}`;
    const before = dump(env);
    const agent_only = new Set(["heartbeat", "release"]);
    for (const rest of ["heartbeat", "release", "interrupt", "cancel", "handoffs"]) {
      const body = rest === "cancel" ? { confirm: true } : rest === "handoffs" ? { target_mode: "B" } : { lease_id: lease.lease_id, fence: lease.fence };
      for (const auth of ["owner", { token: agent.token }] as const) {
        const res = await call(env, { method: "POST", path: foreign_path(`/runs/${lease.run_id}/${rest}`), auth, body });
        assert.ok([401, 403, 404].includes(res.status), `${rest} ${typeof auth === "string" ? auth : "token"}: ${res.status}`);
        envelope_ok(res, rest);
      }
      const who = agent_only.has(rest) ? { token: agent.token } : "owner";
      const unknown = await call(env, { method: "POST", path: P(env, `/runs/no-such-run/${rest}`), auth: who, body });
      assert.ok([403, 404, 409].includes(unknown.status), `${rest} unknown run: ${unknown.status}`);
      envelope_ok(unknown, `${rest} unknown run`);
    }
    assert.equal(dump(env), before, "nothing was written");
  });
});

test("operations: the id of a receipt that is not an interrupt or cancel is 404 for its own actor and the owner; the owner sees the agent's operation; a restart keeps both", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "ops");
    const stranger = await make_agent(env, "ops2");
    const lease = await agent_claims(env, agent);
    env.clock.advance(5_000);
    const claim_tx = env.db.get<{ id: string }>("SELECT id FROM mutation_commits WHERE action LIKE 'run.claim%' ORDER BY rowid DESC LIMIT 1");
    assert.ok(claim_tx);
    for (const auth of ["owner", { token: agent.token }] as const) {
      const res = await call(env, { method: "GET", path: P(env, `/operations/${claim_tx.id}`), auth });
      assert.equal(res.status, 404, "a claim receipt is not an operation");
    }
    const intr = await call(env, { method: "POST", path: P(env, `/runs/${lease.run_id}/interrupt`), auth: { token: agent.token }, body: {} });
    const op = assert_ok(intr, 202).operation_id as string;
    restart_app(env);
    env.clock.advance(5_000);
    const mine = assert_ok(await call(env, { method: "GET", path: P(env, `/operations/${op}`), auth: { token: agent.token } }));
    const owners = assert_ok(await call(env, { method: "GET", path: P(env, `/operations/${op}`), auth: "owner" }));
    assert.deepEqual(mine, owners);
    assert.equal(mine.action, "run.interrupt");
    const denied = await call(env, { method: "GET", path: P(env, `/operations/${op}`), auth: { token: stranger.token } });
    assert.equal(denied.status, 404);
    envelope_ok(denied, "operation of another actor");
  });
});

// DEFECT? GET requests/{key} for the owner session looks up the key WITHOUT an actor filter and takes the
// first row. Idempotency keys belong to (actor, key); when an agent used the same key text earlier, the
// owner asking about their own request is shown the agent's receipt.
test("DEFECT? the owner's request lookup returns the owner's own receipt when an agent used the same key text first", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "samekey");
    assert_ok(await call(env, { method: "POST", path: P(env, "/claims"), auth: { token: agent.token }, key: "same-key-text", body: { mode: "B", runtime: "r", provider: "p", model: "m" } }));
    const created = await call(env, {
      method: "POST",
      path: P(env, "/runs"),
      auth: "owner",
      key: "same-key-text",
      body: { actor_id: agent.actor_id, mode: "B", runtime: "r", provider: "p", model: "m" },
    });
    assert.equal(created.status, 201);
    const lookup = assert_ok(await call(env, { method: "GET", path: P(env, "/requests/same-key-text"), auth: "owner" }));
    assert.equal(lookup.action, "run.create", "the owner's own request, not the agent's claim");
    assert.equal(lookup.status, 201);
  });
});

// ---------------------------------------------------------------------------
// 5. request budgets

// DEFECT? The budget lives in an ApiApp field. api_bridge.ts builds a new ApiApp for every request (one
// process per request), so the documented 60 requests per minute per token (capabilities, stage-1-api.md)
// is never enforced on the only deployed path. The same holds for the minimum poll interval.
test("DEFECT? a token's budget survives a new ApiApp over the same database (the bridge builds one per request)", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "burst");
    let limited = 0;
    for (let i = 0; i < 70; i += 1) {
      restart_app(env);
      const res = await call(env, { method: "GET", path: P(env, "/context"), auth: { token: agent.token } });
      if (res.status === 429) limited += 1;
    }
    assert.ok(limited > 0, "70 requests in one minute from one token were all served");
  });
});

test("DEFECT? the minimum poll interval for inputs survives a new ApiApp over the same database", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "poller");
    const lease = await agent_claims(env, agent);
    restart_app(env);
    assert_ok(await call(env, { method: "GET", path: P(env, `/runs/${lease.run_id}/inputs`), auth: { token: agent.token } }));
    restart_app(env);
    const again = await call(env, { method: "GET", path: P(env, `/runs/${lease.run_id}/inputs`), auth: { token: agent.token } });
    assert.equal(again.status, 429, "an empty poll repeated at once");
  });
});

// ---------------------------------------------------------------------------
// 6. error envelope on every route

test("every listed route answers the shared Korean error envelope without a credential, for a bad method, and for a hostile body", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "env");
    const lease = await agent_claims(env, agent);
    const fill = (path: string) =>
      path
        .replace("{id}", env.p.project_id)
        .replace("{r}", lease.run_id)
        .replace("{key}", "k")
        .replace(/\{[a-z]+\}/g, "unknown-id");
    for (const entry of EXPECTED_ROUTES) {
      const [method, template] = entry.split(" ") as [string, string];
      const path = fill(template);
      if (path === "/api/v1/capabilities") continue;
      const bare = await call(env, { method, path, body: method === "GET" ? undefined : {} });
      envelope_ok(bare, `${entry} without credential`);
      if (path.includes("/projects/")) assert.equal(bare.status, 401, entry);
      const wrong = await call(env, { method: method === "GET" ? "DELETE" : "GET", path, auth: "owner" });
      envelope_ok(wrong, `${entry} wrong method`);
      assert.ok([404, 405].includes(wrong.status) || path === "/api/v1/projects", `${entry} wrong method ${wrong.status}`);
      if (method !== "GET") {
        for (const raw of ["[1,2]", "{\"__proto__\":{\"x\":1}}", "\u0000", "{"]) {
          const hostile = await call(env, { method, path, auth: "owner", raw });
          assert.ok(hostile.status >= 400 && hostile.status < 500, `${entry} hostile body ${JSON.stringify(raw)}: ${hostile.status}`);
          envelope_ok(hostile, `${entry} hostile ${raw}`);
        }
      }
    }
    // 429 carries the retry hint in both header and body
    const caps = assert_ok(await call(env, { method: "GET", path: "/api/v1/capabilities" }));
    const limit = caps.limits.agent_requests_per_minute as number;
    let last: ApiResponse | null = null;
    for (let i = 0; i < limit + 2; i += 1) {
      last = await call(env, { method: "GET", path: P(env, "/context"), auth: { token: agent.token } });
      if (last.status === 429) break;
    }
    assert.ok(last && last.status === 429);
    envelope_ok(last, "429");
    assert.equal(last.json.error.retryable, true);
    assert.ok(Number(last.headers["retry-after"]) >= 1);
    assert.ok(Number.isSafeInteger(last.json.error.details.retry_after_ms));
  });
});

// ---------------------------------------------------------------------------
// 7. stage.activated beside round.started

test("round.start: the two events share one transaction in order, the stage rev moves once, and approve, reopen, and a second round still work", async () => {
  await with_api(async (env) => {
    const s = stage_ids(env.db, env.p.edition_id);
    const rev0 = env.db.get<{ rev: bigint }>("SELECT rev FROM stages WHERE id = ?", s.plan)!.rev;
    const round = await start(env, s.plan, "act-1");
    const events = env.db.all<{ type: string; tx_index: bigint; tx_size: bigint; tx_id: string }>(
      "SELECT type, tx_index, tx_size, tx_id FROM events WHERE tx_id = (SELECT tx_id FROM events WHERE type = 'round.started' ORDER BY event_seq DESC LIMIT 1) ORDER BY tx_index",
    );
    assert.deepEqual(events.map((e) => [e.type, Number(e.tx_index), Number(e.tx_size)]), [["round.started", 0, 2], ["stage.activated", 1, 2]]);
    const rev1 = env.db.get<{ rev: bigint }>("SELECT rev FROM stages WHERE id = ?", s.plan)!.rev;
    assert.equal(rev1, rev0 + 1n);

    const content = await make_content(env, "act");
    const versions = [{ object_id: content.object_id, version_id: content.version_id }];
    const sealed = (await seal(env, round.round_id, versions, "act-seal")).result as { snapshot_id: string };
    await approve(env, s.plan, sealed.snapshot_id, "act-approve");
    assert_ok(await call(env, { method: "POST", path: P(env, `/stages/${s.plan}/reopen`), auth: "owner", body: { reason: "다시" } }));
    const again = await start(env, s.plan, "act-2");
    assert.notEqual(again.round_id, round.round_id);
    const count = env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM events WHERE type = 'stage.activated'")!.n;
    assert.equal(count, 2n, "one stage.activated per round.start, no other command writes it");

    const feed = assert_ok(await call(env, { method: "GET", path: P(env, "/changes?limit=100"), auth: "owner" }));
    for (const e of feed.events) {
      assert.deepEqual(Object.keys(e).sort(), ["after_version_id", "at", "before_version_id", "event_seq", "object_id", "type"]);
    }
    const agent = await make_agent(env, "reader");
    const agent_feed = assert_ok(await call(env, { method: "GET", path: P(env, "/changes?limit=100"), auth: { token: agent.token } }));
    assert.deepEqual(
      agent_feed.events.map((e: any) => e.event_seq),
      feed.events.filter((e: any) => !e.type.startsWith("token.")).map((e: any) => e.event_seq),
    );
  });
});
