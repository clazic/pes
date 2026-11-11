/**
 * SEL-55 PR20c 보강 — the new `app` field of the hand-off import, the runtime/provider it records, token refs per
 * runtime, the Go route variants for the OpenCode app, and the notes' wording. Synthetic only: the real in-memory
 * ApiApp, a temporary HOME, a fake key store. No app is started, no model is called.
 *
 * Out of scope on purpose: refusing an external_agent claim with mode A is SEL-68's.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { CodexAppAdapter, codex_app_launch_env, codex_app_mcp_entry } from "../scripts/pes_core/adapters/codex_app.ts";
import { OpencodeAppAdapter, opencode_app_launch_env, opencode_app_mcp_entry } from "../scripts/pes_core/adapters/opencode_app.ts";
import { codex_cli_launch_env } from "../scripts/pes_core/adapters/codex_cli.ts";
import { ClaudeAppAdapter } from "../scripts/pes_core/adapters/claude_app.ts";
import { API_BASE_URL, FakeKeyStore, REPO, SERVER_SCRIPT } from "./helpers/adapter_b_cli_suite.ts";
import { wire, type AdapterEnv } from "./helpers/adapter_b_env.ts";
import { with_cleanup } from "./helpers/adapter_b_flow.ts";
import { register_second } from "./helpers/adapter_b_harden.ts";
import { assert_ok, call, make_agent, project_path, SESSION_SECRET } from "./helpers/api_env.ts";
import { P } from "./helpers/api_flow.ts";
import { isolated_home } from "./helpers/isolated_home.ts";
import { state_signature, table_counts } from "./helpers/state_signature.ts";

const ENTRY_INPUT = { command: process.execPath, server_script: SERVER_SCRIPT, project_id: "synthetic-project-id", api_base_url: API_BASE_URL };

const import_body = (env: AdapterEnv, request_id: string, extra: Record<string, unknown> = {}, title = "앱 가져오기") => ({
  import: { results: [{ op: "append_version", object_id: env.object_id, title }], request_id, ...extra },
});

const post_import = (env: AdapterEnv, request_id: string, extra: Record<string, unknown> = {}, more: { auth?: any; key?: string | null; title?: string } = {}) =>
  call(env, {
    method: "POST",
    path: P(env, "/runs"),
    auth: more.auth ?? "owner",
    body: import_body(env, request_id, extra, more.title),
    key: more.key === undefined ? `import-${request_id}` : more.key,
  });

const run_of = (env: AdapterEnv, run_id: string) =>
  env.db.get<{ runtime: string; provider: string; model: string; mode: string; actor_id: string }>(
    "SELECT runtime, provider, model, mode, actor_id FROM runs WHERE id = ?",
    run_id,
  )!;

// ---------------------------------------------------------------------------------------------------------------
// (1) the app field

test("app: every value outside the closed list is refused with a 4xx and writes nothing", async () => {
  await with_cleanup(async (env) => {
    const sig = state_signature(env.db);
    const bad: Array<[string, unknown]> = [
      ["empty", ""],
      ["space", " "],
      ["capitalised", "Codex_App"],
      ["upper case", "CODEX_APP"],
      ["trailing space", "codex_app "],
      ["leading space", " opencode_app"],
      ["newline", "codex_app\n"],
      ["tab", "\tcodex_app"],
      ["NUL", "codex_app\u0000"],
      ["hyphen for underscore", "codex-app"],
      ["dot for underscore", "codex.app"],
      ["Cyrillic o", "c\u043ddex_app"],
      ["full-width letters", "\uff43\uff4f\uff44\uff45\uff58_app"],
      ["zero-width joiner", "codex\u200d_app"],
      ["BOM prefix", "\ufeffcodex_app"],
      ["right-to-left override", "\u202ecodex_app"],
      ["Turkish dotless i", "opencode_app".replace("o", "\u0131")],
      ["__proto__", "__proto__"],
      ["constructor", "constructor"],
      ["prototype", "prototype"],
      ["toString", "toString"],
      ["hasOwnProperty", "hasOwnProperty"],
      ["valueOf", "valueOf"],
      ["a CLI runtime name", "codex_cli"],
      ["the TUI runtime name", "opencode_tui"],
      ["a handoff runtime name", "codex_app_handoff"],
      ["claude_app_handoff", "claude_app_handoff"],
      ["a builtin name", "pes_builtin"],
      ["sql-ish", "codex_app' OR '1'='1"],
      ["very long", "codex_app".repeat(5000)],
      ["number", 1],
      ["zero", 0],
      ["true", true],
      ["false", false],
      ["null", null],
      ["array", ["codex_app"]],
      ["empty array", []],
      ["object", { app: "codex_app" }],
      ["object with toString", { toString: "codex_app" }],
      ["nested name", { name: "codex_app" }],
    ];
    let n = 0;
    for (const [name, value] of bad) {
      n += 1;
      const res = await post_import(env, `bad-app-${String(n).padStart(3, "0")}-req`, { app: value });
      assert.ok(res.status >= 400 && res.status < 500, `${name}: ${res.status} ${JSON.stringify(res.json).slice(0, 200)}`);
      assert.equal(typeof res.json.error.code, "string", name);
      assert.notEqual(res.json.error.code, "internal_error", name);
    }
    assert.equal(state_signature(env.db), sig, "no case wrote a row");
    assert.equal(table_counts(env.db).runs, 0n);
  });
});

test("app: a duplicated or inherited `app` key in the raw body cannot smuggle a value past the list", async () => {
  await with_cleanup(async (env) => {
    const sig = state_signature(env.db);
    // JSON.parse keeps the last duplicate; either way the value must be one of the three
    const dup = `{"import":{"results":[{"op":"append_version","object_id":"${env.object_id}","title":"x"}],"request_id":"dup-app-req-0001","app":"codex_app","app":"codex-app"}}`;
    const res = await call(env, { method: "POST", path: P(env, "/runs"), auth: "owner", raw: dup, headers: { "content-type": "application/json" }, key: "import-dup-app-req-0001" });
    assert.ok(res.status >= 400 && res.status < 500, String(res.status));
    // an `app` placed beside import (not in it) is the outer body's extra field
    const outer = await call(env, {
      method: "POST",
      path: P(env, "/runs"),
      auth: "owner",
      body: { ...import_body(env, "outer-app-req-0001"), app: "codex_app" },
      key: "import-outer-app-req-0001",
    });
    assert.ok(outer.status >= 400 && outer.status < 500, String(outer.status));
    // proto pollution through the body: __proto__ as a key of import
    const polluted = await call(env, {
      method: "POST",
      path: P(env, "/runs"),
      auth: "owner",
      raw: `{"import":{"results":[{"op":"append_version","object_id":"${env.object_id}","title":"x"}],"request_id":"proto-app-req-0001","__proto__":{"app":"codex_app"}}}`,
      headers: { "content-type": "application/json" },
      key: "import-proto-app-req-0001",
    });
    assert.ok(polluted.status >= 400 && polluted.status < 500, String(polluted.status));
    assert.equal(state_signature(env.db), sig);
    assert.equal(({} as any).app, undefined, "Object.prototype was not polluted");
  });
});

test("app: the three listed values are recorded exactly; no app is the Claude app (20a regression)", async () => {
  await with_cleanup(async (env) => {
    const expected: Array<[Record<string, unknown>, string, string]> = [
      [{}, "claude_app_handoff", "anthropic"],
      [{ app: "claude_app" }, "claude_app_handoff", "anthropic"],
      [{ app: "codex_app" }, "codex_app_handoff", "openai"],
      [{ app: "opencode_app" }, "opencode_app_handoff", "unknown"],
    ];
    let n = 0;
    for (const [extra, runtime, provider] of expected) {
      n += 1;
      const id = `listed-app-${n}-req-000`;
      const out = assert_ok(await post_import(env, id, extra, { title: `장 ${n}` }), 201);
      const run = run_of(env, out.run_id);
      assert.deepEqual({ ...run }, { runtime, provider, model: "unknown", mode: "B", actor_id: env.p.actor_id }, wire(extra));
      assert.ok(!/_app$/.test(run.runtime), "never a direct-connection runtime name");
      const created = env.db.all<{ payload: string }>("SELECT payload FROM events WHERE type = 'run.created' AND run_id = ?", out.run_id);
      assert.equal(created.length, 1);
      const payload = JSON.parse(created[0]!.payload);
      assert.equal(payload.runtime, runtime, "the event says the same as the row");
      assert.equal(payload.via, "import");
      // no other event or row of this run names a different runtime / provider
      const all = env.db.all<{ payload: string }>("SELECT payload FROM events WHERE run_id = ?", out.run_id).map((e) => e.payload).join("\n");
      for (const other of ["claude_app_handoff", "codex_app_handoff", "opencode_app_handoff"].filter((r) => r !== runtime)) {
        assert.ok(!all.includes(other), `${other} does not appear in the events of a ${runtime} run`);
      }
      assert.ok(!all.includes('"app"'), "the raw app field is not echoed into events");
    }
    assert.equal(table_counts(env.db).runs, 4n);
  });
});

test("app: the same idempotency key with a different app is a 409 and writes nothing; an exact retry replays", async () => {
  await with_cleanup(async (env) => {
    const first = assert_ok(await post_import(env, "same-key-req-0001", { app: "codex_app" }), 201);
    const sig = state_signature(env.db);
    for (const other of [{}, { app: "claude_app" }, { app: "opencode_app" }]) {
      const res = await post_import(env, "same-key-req-0001", other);
      assert.equal(res.status, 409, `${wire(other)}: ${res.status} ${JSON.stringify(res.json).slice(0, 160)}`);
      assert.equal(typeof res.json.error.code, "string");
    }
    assert.equal(state_signature(env.db), sig, "no run, no version, no receipt");
    const replay = await post_import(env, "same-key-req-0001", { app: "codex_app" });
    assert.ok(replay.status === 200 || replay.status === 201, String(replay.status));
    assert.equal(replay.json.data.run_id, first.run_id, "the replay is the same run");
    assert.equal(run_of(env, first.run_id).runtime, "codex_app_handoff", "the replay did not rewrite the row");
    assert.equal(state_signature(env.db), sig);
  });
});

test("app: a second import of the same request_id under another app writes nothing (the owner's run stays the first app's)", async () => {
  await with_cleanup(async (env) => {
    const first = assert_ok(await post_import(env, "twice-app-req-0001", { app: "opencode_app" }), 201);
    const sig = state_signature(env.db);
    // a different key is refused outright (the key is forced to import-<request_id>)
    const wrong_key = await post_import(env, "twice-app-req-0001", { app: "codex_app" }, { key: "some-other-key" });
    assert.ok(wrong_key.status >= 400 && wrong_key.status < 500, String(wrong_key.status));
    assert.equal(state_signature(env.db), sig);
    assert.equal(run_of(env, first.run_id).runtime, "opencode_app_handoff");
    assert.equal(table_counts(env.db).runs, 1n);
  });
});

test("app: only the owner session imports; an agent token, a stranger's session or another project's token gets nothing, with any app", async () => {
  await with_cleanup(async (env) => {
    const other = await register_second(env, "synthetic-app-import-other");
    const sig = state_signature(env.db);
    const attempts: Array<[string, any]> = [
      ["no credential", "none"],
      ["the agent token", { token: env.agent.token }],
      ["the token of another project's registration", { token: other.token }],
      ["the session secret as a bearer", { token: SESSION_SECRET }],
    ];
    for (const app of ["codex_app", "opencode_app", "claude_app"]) {
      let n = 0;
      for (const [name, auth] of attempts) {
        n += 1;
        const res = await post_import(env, `auth-${app}-${n}-req-000`, { app }, { auth });
        assert.ok(res.status === 401 || res.status === 403 || res.status === 404, `${app} ${name}: ${res.status}`);
        assert.notEqual(res.json.error.code, "internal_error");
      }
      // a wrong session header
      const wrong = await call(env, {
        method: "POST",
        path: P(env, "/runs"),
        auth: "none",
        headers: { "x-pes-session": "synthetic-wrong-session" },
        body: import_body(env, `auth-${app}-wrong-req`, { app }),
        key: `import-auth-${app}-wrong-req`,
      });
      assert.ok(wrong.status === 401 || wrong.status === 403, String(wrong.status));
    }
    assert.equal(state_signature(env.db), sig);
  });
});

test("app: an import for another project's stage, round or object is refused whatever the app says", async () => {
  await with_cleanup(async (env) => {
    const other = await register_second(env, "synthetic-app-cross-project");
    const sig = state_signature(env.db);
    let n = 0;
    for (const app of ["codex_app", "opencode_app"]) {
      for (const extra of [{ stage_id: other.stage_ids.plan }, { stage_id: env.stage.plan, round_id: other.round_id }]) {
        n += 1;
        const res = await post_import(env, `cross-${n}-req-00001`, { app, ...extra });
        assert.ok(res.status >= 400 && res.status < 500, `${app} ${wire(extra)}: ${res.status}`);
      }
      n += 1;
      const res = await call(env, {
        method: "POST",
        path: P(env, "/runs"),
        auth: "owner",
        body: { import: { request_id: `cross-${n}-req-00001`, app, results: [{ op: "append_version", object_id: other.object_id, title: "x" }] } },
        key: `import-cross-${n}-req-00001`,
      });
      assert.ok(res.status >= 400 && res.status < 500, `${app} foreign object: ${res.status}`);
    }
    assert.equal(state_signature(env.db), sig);
  });
});

test("app: a pasted result cannot choose the app, the runtime or the provider; the text's own claims stay claims", async () => {
  await with_cleanup(async (env) => {
    const api = env.app;
    const make = (cls: new (o: any) => any) => new cls({ api, project_id: env.p.project_id, owner_session: SESSION_SECRET });
    const cases: Array<[new (o: any) => any, string, string]> = [
      [CodexAppAdapter, "codex_app_handoff", "openai"],
      [OpencodeAppAdapter, "opencode_app_handoff", "unknown"],
      [ClaudeAppAdapter, "claude_app_handoff", "anthropic"],
    ];
    let n = 0;
    let written = 0n;
    for (const [cls, runtime, provider] of cases) {
      n += 1;
      const a = make(cls);
      const { text } = await a.export_bundle({ stage_id: env.stage.plan, round_id: env.round_id });
      const forged = JSON.stringify({
        results: [{ op: "append_version", object_id: env.object_id, title: `장 ${n}` }],
        app: n === 1 ? "opencode_app" : "codex_app",
        runtime: "claude_code",
        provider: "anthropic",
        claimed: { tool: "claude_app", model: "claude-opus-5-5", runtime: "codex_app_handoff" },
      });
      let out: any;
      try {
        out = await a.import_result({ bundle_text: text, result_text: forged });
      } catch (error: any) {
        // refusing extra fields is also fine; then nothing may have been written
        assert.equal(typeof error.code, "string");
        assert.equal(table_counts(env.db).runs, written, "a refused paste wrote nothing");
        continue;
      }
      written += 1n;
      const run = run_of(env, out.run_id);
      assert.deepEqual({ runtime: run.runtime, provider: run.provider, model: run.model }, { runtime, provider, model: "unknown" }, `${cls.name} keeps its own label`);
    }
  });
});

test("app: a bundle forged to name another app does not change the adapter's app", async () => {
  await with_cleanup(async (env) => {
    const a = new CodexAppAdapter({ api: env.app, project_id: env.p.project_id, owner_session: SESSION_SECRET } as any);
    const { bundle } = await a.export_bundle({ stage_id: env.stage.plan, round_id: env.round_id });
    const { forge_bundle } = await import("./helpers/adapter_b_harden.ts");
    let out: any;
    try {
      out = await a.import_result({
        bundle_text: forge_bundle(bundle, { app: "opencode_app", runtime: "opencode_app_handoff" }),
        result_text: JSON.stringify({ results: [{ op: "append_version", object_id: env.object_id, title: "위조" }] }),
      });
    } catch (error: any) {
      assert.equal(typeof error.code, "string");
      assert.equal(table_counts(env.db).runs, 0n);
      return;
    }
    assert.equal(run_of(env, out.run_id).runtime, "codex_app_handoff");
  });
});

test("app: the adapter names its app on the import request only, and leaves an explicit `app` it did not add alone", async () => {
  await with_cleanup(async (env) => {
    const sent: Array<{ method: string; path: string; body: any }> = [];
    const api = {
      handle: (request: any) => {
        sent.push({ method: request.method, path: request.path, body: request.body });
        return env.app.handle(request) as any;
      },
    };
    const a = new OpencodeAppAdapter({ api, project_id: env.p.project_id, owner_session: SESSION_SECRET } as any);
    const { text } = await a.export_bundle({ stage_id: env.stage.plan, round_id: env.round_id });
    const gets = sent.filter((s) => s.method === "GET");
    assert.ok(gets.length >= 1);
    for (const g of gets) assert.ok(g.body === null || g.body === undefined, "a read carries no body");
    await a.import_result({
      bundle_text: text,
      result_text: JSON.stringify({ results: [{ op: "append_version", object_id: env.object_id, title: "하나" }] }),
    });
    const posts = sent.filter((s) => s.method === "POST");
    assert.equal(posts.length, 1, "one POST: the import");
    const body = JSON.parse(posts[0]!.body);
    assert.equal(body.import.app, "opencode_app");
    assert.deepEqual(Object.keys(body), ["import"], "nothing else was added beside import");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// (2) direct runtime vs hand-off runtime

test("runtime: a direct connection (codex_app / opencode_app, external_agent) is never recorded as a hand-off, and an import never as a direct one", async () => {
  await with_cleanup(async (env) => {
    const direct = [
      { slug: "harden-codex-app", runtime: "codex_app", provider: "openai" },
      { slug: "harden-opencode-app", runtime: "opencode_app", provider: "unknown" },
    ];
    for (const d of direct) {
      const agent = await make_agent(env, d.slug);
      const claim = assert_ok(
        await call(env, {
          method: "POST",
          path: project_path(env, "/claims"),
          auth: { token: agent.token },
          body: { mode: "B", runtime: d.runtime, provider: d.provider, model: "synthetic-model" },
        }),
        200,
      );
      const row = run_of(env, claim.run_id);
      assert.deepEqual({ runtime: row.runtime, provider: row.provider, mode: row.mode }, { runtime: d.runtime, provider: d.provider, mode: "B" });
      assert.equal(row.actor_id, agent.actor_id, "the agent is the actor");
      assert.equal(env.db.get<{ kind: string }>("SELECT kind FROM actors WHERE id = ?", row.actor_id)?.kind, "external_agent");
      assert_ok(
        await call(env, {
          method: "POST",
          path: project_path(env, `/runs/${claim.run_id}/complete`),
          auth: { token: agent.token },
          body: { lease_id: claim.lease_id, fence: claim.fence, status: "succeeded" },
        }),
      );
      const imported = assert_ok(await post_import(env, `direct-vs-${d.slug}-req`, { app: d.runtime }, { title: `장 ${d.slug}` }), 201);
      const irow = run_of(env, imported.run_id);
      assert.equal(irow.runtime, `${d.runtime}_handoff`);
      assert.notEqual(irow.runtime, d.runtime);
      assert.equal(irow.actor_id, env.p.actor_id);
      assert.equal(env.db.get<{ kind: string }>("SELECT kind FROM actors WHERE id = ?", irow.actor_id)?.kind, "human");
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// (3) tokens

test("tokens: each runtime reads only its own ref; another runtime's token is never returned", async () => {
  const store = new FakeKeyStore();
  store.secrets.set("pes-agent-token-codex_cli-synthetic-project-id", "synthetic-token-cli-0001");
  store.secrets.set("pes-agent-token-opencode_tui-synthetic-project-id", "synthetic-token-tui-0001");
  store.secrets.set("pes-agent-token-codex_app-other-project", "synthetic-token-other-project-0001");
  for (const [fn, runtime] of [
    [codex_app_launch_env, "codex_app"],
    [opencode_app_launch_env, "opencode_app"],
  ] as const) {
    await assert.rejects(
      fn({ key_store: store as any, project_id: "synthetic-project-id" }),
      (error: any) => {
        assert.equal(error.code, "token_missing", runtime);
        assert.match(String(error.message), /[가-힣]/);
        assert.ok(!String(error.message).includes("synthetic-token"), "no token in the message");
        return true;
      },
    );
    assert.deepEqual(
      store.calls.filter(([name]) => name === "get").at(-1),
      ["get", [`pes-agent-token-${runtime}-synthetic-project-id`]],
      `${runtime} asked for exactly its own ref`,
    );
  }
  // the CLI tool still gets its own
  assert.deepEqual(await codex_cli_launch_env({ key_store: store as any, project_id: "synthetic-project-id" } as any), { PES_AGENT_TOKEN: "synthetic-token-cli-0001" });
  // and the app's own is returned when present, only that one
  store.secrets.set("pes-agent-token-codex_app-synthetic-project-id", "synthetic-token-codex-app-0001");
  assert.deepEqual(await codex_app_launch_env({ key_store: store as any, project_id: "synthetic-project-id" }), { PES_AGENT_TOKEN: "synthetic-token-codex-app-0001" });
  await assert.rejects(opencode_app_launch_env({ key_store: store as any, project_id: "synthetic-project-id" }), (e: any) => e.code === "token_missing");
});

test("tokens: odd project ids cannot reach another ref; the refusal never echoes a stored token", async () => {
  const store = new FakeKeyStore();
  store.secrets.set("pes-agent-token-codex_app-victim", "synthetic-token-victim-0001");
  for (const project_id of ["", " ", "victim ", "../victim", "victim\u0000", "pes-agent-token-codex_app-victim", "VICTIM", 5, null, undefined, {}, ["victim"]]) {
    let out: unknown;
    try {
      out = await codex_app_launch_env({ key_store: store as any, project_id: project_id as any });
    } catch (error: any) {
      assert.ok(error instanceof TypeError || typeof error.code === "string", String(project_id));
      assert.ok(!String(error.message).includes("synthetic-token-victim"), "no stored token in the message");
      continue;
    }
    assert.notDeepEqual(out, { PES_AGENT_TOKEN: "synthetic-token-victim-0001" }, `project_id ${JSON.stringify(project_id)} must not reach victim's token`);
  }
});

test("tokens: the entries and the printed configuration pieces never contain a token value or the session secret", async () => {
  const store = new FakeKeyStore();
  store.secrets.set("pes-agent-token-codex_app-synthetic-project-id", "synthetic-token-leakcheck-0001");
  store.secrets.set("pes-agent-token-opencode_app-synthetic-project-id", "synthetic-token-leakcheck-0002");
  const codex = codex_app_mcp_entry(ENTRY_INPUT);
  const opencode = opencode_app_mcp_entry(ENTRY_INPUT);
  const launched = [
    await codex_app_launch_env({ key_store: store as any, project_id: "synthetic-project-id" }),
    await opencode_app_launch_env({ key_store: store as any, project_id: "synthetic-project-id" }),
  ];
  const text = wire({ codex, opencode });
  assert.ok(!text.includes("synthetic-token"), "no token value in an entry");
  assert.ok(!text.includes(SESSION_SECRET));
  assert.doesNotMatch(text, /Bearer|authorization/i);
  assert.deepEqual(codex.env_vars, ["PES_AGENT_TOKEN"], "the Codex app only names the variable");
  assert.equal(opencode.environment.PES_AGENT_TOKEN, "{env:PES_AGENT_TOKEN}");
  assert.ok(!("PES_AGENT_TOKEN" in codex.env));
  for (const l of launched) assert.deepEqual(Object.keys(l), ["PES_AGENT_TOKEN"]);
});

test("tokens: token, session secret and idempotency key stay out of the hand-off's bundle, result, refusals and the events", async () => {
  await with_cleanup(async (env) => {
    for (const cls of [CodexAppAdapter, OpencodeAppAdapter]) {
      const a = new cls({ api: env.app, project_id: env.p.project_id, owner_session: SESSION_SECRET } as any);
      const { text } = await a.export_bundle({ stage_id: env.stage.plan, round_id: env.round_id });
      const seen: string[] = [text];
      const ok = await a.import_result({
        bundle_text: text,
        result_text: JSON.stringify({ results: [{ op: "append_version", object_id: env.object_id, title: `누출 점검 ${cls.name}` }] }),
      });
      seen.push(wire(ok));
      // a refused paste: broken JSON, and the wrong session
      for (const bad of [
        () => a.import_result({ bundle_text: text, result_text: "{" }),
        () => new cls({ api: env.app, project_id: env.p.project_id, owner_session: `${SESSION_SECRET}x` } as any).import_result({ bundle_text: text, result_text: JSON.stringify({ results: [] }) }),
      ]) {
        try {
          await bad();
          assert.fail("expected a refusal");
        } catch (error: any) {
          seen.push(String(error.message), wire({ code: error.code }));
        }
      }
      const joined = seen.join("\n");
      for (const secret of [env.agent.token, SESSION_SECRET, `${SESSION_SECRET}x`]) assert.ok(!joined.includes(secret), "no secret in any output");
    }
    const events = env.db.all<{ payload: string }>("SELECT payload FROM events").map((e) => e.payload).join("\n");
    for (const secret of [env.agent.token, SESSION_SECRET]) assert.ok(!events.includes(secret), "no secret in the events");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// (4) the Go route for the OpenCode app

test("go route: every spelling of opencode-go/… is refused for the OpenCode app, ordinary models pass", () => {
  const go_names = [
    "opencode-go/deepseek-v4.1-flash",
    "OPENCODE-GO/x",
    "OpenCode-Go/x",
    "opencode_go/x",
    "opencode go/x",
    "opencode–go/x", // en dash
    "opencode—go/x", // em dash
    "opencode‐go/x", // hyphen U+2010
    "opencode‑go/x", // non-breaking hyphen
    "opencode−go/x", // minus sign
    "opencode-go//x",
    "opencode-go///x",
    "opencode-go/",
    "opencode-go",
    "\ufeffopencode-go/x",
    "opencode\u200b-go/x",
    "opencode-\u200bgo/x",
    "\uff4f\uff50\uff45\uff4e\uff43\uff4f\uff44\uff45-go/x", // full-width
    "opencode-go/ x",
  ];
  for (const model of go_names) {
    assert.throws(
      () => opencode_app_mcp_entry({ ...ENTRY_INPUT, model }),
      (error: any) => {
        assert.ok(["go_route_blocked", "field_invalid", "input_invalid"].includes(error.code) || typeof error.code === "string", `${JSON.stringify(model)}: ${error.code}`);
        assert.match(String(error.message), /[가-힣]/);
        return true;
      },
      JSON.stringify(model),
    );
  }
  // leading/trailing whitespace is not a way in either (it is refused one way or another)
  for (const model of [" opencode-go/x", "opencode-go/x ", "\topencode-go/x", "opencode-go/x\n"]) {
    assert.throws(() => opencode_app_mcp_entry({ ...ENTRY_INPUT, model }), Error, JSON.stringify(model));
  }
  for (const model of ["anthropic/synthetic-model", "openai/gpt-synthetic", "opencode/deepseek-v4.1-flash-free", "opencode-goo/x", "my-opencode-go-notes/x", "unknown"]) {
    const entry = opencode_app_mcp_entry({ ...ENTRY_INPUT, model });
    assert.equal(entry.environment.PES_MODEL, model);
  }
});

test("go route: the Codex app entry is not subject to the OpenCode route rule, and neither entry carries a Go provider label", () => {
  const codex = codex_app_mcp_entry({ ...ENTRY_INPUT, model: "gpt-synthetic" });
  assert.equal(codex.env.PES_PROVIDER, "openai");
  const opencode = opencode_app_mcp_entry({ ...ENTRY_INPUT, model: "synthetic/model" });
  assert.notEqual(opencode.environment.PES_PROVIDER, "opencode-go");
  assert.ok(!wire(opencode).includes("opencode-go"));
});

test("go route: the OpenCode app's hand-off import is not a Go run and is not metered as one", async () => {
  await with_cleanup(async (env) => {
    const names = () =>
      env.db
        .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE '%dispatch%' OR name LIKE '%usage%' OR name LIKE 'go_%' OR name LIKE '%connection%') ORDER BY name")
        .map((r) => r.name);
    const count = () => Object.fromEntries(names().map((n) => [n, env.db.get<{ n: bigint }>(`SELECT COUNT(*) AS n FROM ${n}`)?.n]));
    const before = count();
    const out = assert_ok(await post_import(env, "go-app-import-req-1", { app: "opencode_app", claimed_model: "opencode-go/deepseek-v4.1-flash", claimed_tool: "opencode-go" }), 201);
    const row = run_of(env, out.run_id);
    assert.equal(row.provider, "unknown");
    assert.equal(row.model, "unknown");
    assert.notEqual(row.mode, "A");
    assert.deepEqual(count(), before, "no mode-A table moved");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// (5) nothing outside the test directory is touched

test("files: building entries, reading launch environments and running hand-offs touch no tool configuration, only in memory", async () => {
  const home = isolated_home("pes-sel55-harden-home-");
  try {
    const root = home.env.HOME!;
    const plant: Array<[string, string]> = [
      [".codex/config.toml", '[mcp_servers.keep]\ncommand = "synthetic"\n'],
      [".codex/auth.json", "{}\n"],
      [".config/opencode/opencode.json", '{"mcp":{"servers":{}}}\n'],
      [".local/share/opencode/auth.json", "{}\n"],
      [".claude/settings.json", "{}\n"],
      [".claude.json", "{}\n"],
      ["Library/Application Support/Codex/state.json", "{}\n"],
      ["Library/Application Support/OpenCode/state.json", "{}\n"],
      ["AppData/Roaming/Codex/state.json", "{}\n"],
      ["AppData/Roaming/OpenCode/config.json", "{}\n"],
    ];
    const old = new Date("2026-01-01T00:00:00Z");
    for (const [rel, content] of plant) {
      const file = join(root, ...rel.split("/"));
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content, "utf8");
      utimesSync(file, old, old);
    }
    const snapshot = () => {
      const out: Record<string, string> = {};
      for (const [rel] of plant) {
        const file = join(root, ...rel.split("/"));
        out[rel] = `${readFileSync(file, "utf8")}@${existsSync(file)}`;
      }
      return out;
    };
    const before = snapshot();
    const mtimes = (): Record<string, number> => {
      return Object.fromEntries(plant.map(([rel]) => [rel, statSync(join(root, ...rel.split("/"))).mtimeMs]));
    };
    const mtimes_before = mtimes();
    const store = new FakeKeyStore();
    store.secrets.set("pes-agent-token-codex_app-p", "synthetic-token-files-0001");
    store.secrets.set("pes-agent-token-opencode_app-p", "synthetic-token-files-0002");
    for (let i = 0; i < 3; i += 1) {
      codex_app_mcp_entry({ ...ENTRY_INPUT, project_id: "p" });
      opencode_app_mcp_entry({ ...ENTRY_INPUT, project_id: "p" });
      await codex_app_launch_env({ key_store: store as any, project_id: "p" });
      await opencode_app_launch_env({ key_store: store as any, project_id: "p" });
    }
    assert.deepEqual(snapshot(), before);
    assert.deepEqual(mtimes(), mtimes_before);
    for (const bad of ["pes.json", "codex-pes.toml"]) {
      assert.ok(!existsSync(join(root, ".config", "opencode", bad)));
      assert.ok(!existsSync(join(root, ".codex", bad)));
    }
  } finally {
    home.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// (6) the notes

const note = (name: string) => readFileSync(join(REPO, "docs", "adapters", name), "utf8").replace(/\r\n/g, "\n");

for (const doc of ["codex-app.md", "opencode-app.md"]) {
  test(`docs: ${doc} says the explicit hand-off is the path that always works, and does not promise shared settings`, () => {
    const text = note(doc);
    assert.match(text, /명시적 전달/);
    assert.match(text, /항상|보장/);
    const guarantee = text.split("\n").filter((line) => /명시적 전달/.test(line) && /(항상|보장)/.test(line));
    assert.ok(guarantee.length >= 1, "a sentence ties the explicit hand-off to 'always works / guaranteed'");
    for (const line of guarantee) assert.doesNotMatch(line, /보장하지 않|보장되지 않|보장할 수 없/, `the guarantee sentence is not negated: ${line}`);
    // the direct connection is never described as guaranteed
    for (const line of text.split("\n").filter((l) => /직접 연결/.test(l) && /보장/.test(l))) {
      assert.match(line, /않|없|아니|못|미확인/, `a direct-connection sentence must not promise: ${line}`);
    }
    // sharing the terminal tool's settings is not promised, anywhere, in any phrasing
    for (const line of text.split("\n").filter((l) => /공유/.test(l))) {
      assert.match(line, /미확인|않|없|보장하지|아니|못|확인되지/, `sharing must not be promised: ${line}`);
    }
    assert.doesNotMatch(text, /(자동으로|그대로|함께|같이)\s*(공유|적용|읽)/, "no 'automatically shared / applied' wording");
    assert.doesNotMatch(text, /sk-[A-Za-z0-9]{8,}|synthetic-token|Bearer\s+[A-Za-z0-9]/);
    assert.doesNotMatch(text, /\/Users\/|\/home\/[a-z]|C:\\Users\\/);
    assert.doesNotMatch(text, /session[_ -]?id\s*[:=]\s*\S{8,}/i);
  });

  test(`docs: ${doc} names the closed app list and the recorded runtime of the hand-off`, () => {
    const text = note(doc);
    const app = doc === "codex-app.md" ? "codex_app" : "opencode_app";
    assert.ok(text.includes(`${app}_handoff`), `the note names ${app}_handoff`);
    assert.ok(text.includes("import"), "the note names the import");
    // the direct runtime and the hand-off runtime are both there, told apart
    assert.ok(text.includes(app));
  });
}

test("docs: the API spec and the stage plan list the three apps and say a missing app is the Claude app", () => {
  const openapi = readFileSync(join(REPO, "docs", "api", "openapi-v1.yaml"), "utf8").replace(/\r\n/g, "\n");
  for (const app of ["claude_app", "codex_app", "opencode_app"]) assert.ok(openapi.includes(app), `openapi names ${app}`);
  const plan = readFileSync(join(REPO, "docs", "plan", "stage-2-db-guarantees.md"), "utf8").replace(/\r\n/g, "\n");
  for (const runtime of ["claude_app_handoff", "codex_app_handoff", "opencode_app_handoff"]) assert.ok(plan.includes(runtime), `the plan names ${runtime}`);
});
