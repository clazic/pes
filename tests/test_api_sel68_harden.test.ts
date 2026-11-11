/**
 * SEL-68 보강 (보안) — 구현 커밋 20d3f60 을 우회·경로·순서·사후 상태로 공격한다.
 * 규칙: mode A 이거나 Go 라벨(provider opencode-go / model opencode-go/ 접두)인 run 은 internal_ai 만
 * claim·run_id claim·run.create 할 수 있다. 그 밖(external_agent 토큰·사람 세션)은 쓰기 전에 403 forbidden.
 * 합성 자료만. 정답 시험(test_api_sel68_mode_a_claim)은 건드리지 않는다.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { McpServer } from "../scripts/pes_core/mcp_server.ts";
import type { Db } from "../scripts/pes_core/db.ts";
import { FakeMcpClient } from "./helpers/adapter_b_env.ts";
import { assert_error, assert_ok, call, go_off, make_agent, with_api, type Agent, type ApiEnv, type ApiResponse, type Auth } from "./helpers/api_env.ts";
import { P } from "./helpers/api_flow.ts";
import { expect_rejected, with_cli, SLUG } from "./helpers/cli_write_env.ts";
import { state_signature } from "./helpers/state_signature.ts";

const GO_MODEL = "opencode-go/deepseek-v4.1-flash";
const A_BODY = { mode: "A", runtime: "pes_builtin", provider: "opencode-go", model: GO_MODEL };
const B_BODY = { mode: "B", runtime: "codex_cli", provider: "openai", model: "unknown" };

const TABLES = ["runs", "project_leases", "mutation_commits", "events", "run_input_receipts", "outbound_dispatches", "counters", "projects", "db_meta"];

function sig(db: Db): string {
  return TABLES.map((t) => `${t}:${JSON.stringify(db.all(`SELECT * FROM "${t}" ORDER BY rowid`), (_k, v) => (typeof v === "bigint" ? `${v}n` : v))}`).join("\n");
}
function n(db: Db, sql: string, ...p: unknown[]): number {
  return Number(db.get<{ n: bigint }>(sql, ...(p as any[]))?.n ?? 0n);
}
const runs_n = (env: ApiEnv) => n(env.db, "SELECT COUNT(*) AS n FROM runs");
const leases_n = (env: ApiEnv) => n(env.db, "SELECT COUNT(*) AS n FROM project_leases");
const a_runs_n = (env: ApiEnv) => n(env.db, "SELECT COUNT(*) AS n FROM runs WHERE mode = 'A'");
const go_label_non_internal_n = (env: ApiEnv) =>
  n(
    env.db,
    `SELECT COUNT(*) AS n FROM runs r JOIN actors a ON a.id = r.actor_id
      WHERE (r.mode = 'A' OR r.provider = 'opencode-go' OR r.model LIKE 'opencode-go/%') AND a.kind <> 'internal_ai'`,
  );

const claim = (env: ApiEnv, auth: Auth, body: unknown, key?: string): Promise<ApiResponse> =>
  call(env, { method: "POST", path: P(env, "/claims"), auth, body, key });
const create_run = (env: ApiEnv, body: unknown, key?: string): Promise<ApiResponse> =>
  call(env, { method: "POST", path: P(env, "/runs"), auth: "owner", body, key });

function refused(res: ApiResponse, label: string): void {
  const e = assert_error(res, 403, "forbidden");
  assert.equal(e.retryable, false, `${label}: not retryable`);
}

// ---------------------------------------------------------------------------
// (1) 우회 변형

test("SEL-68 harden: mode variants (lowercase, padded, array, number, null) never produce a run for an external token", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "v-mode");
    const before = sig(env.db);
    for (const mode of ["a", "b", " A", "A ", "A\n", "Ａ", ["A"], { v: "A" }, 1, true, null, ""]) {
      const res = await claim(env, { token: agent.token }, { ...A_BODY, mode });
      assert.ok(res.status === 400 || res.status === 403, `${JSON.stringify(mode)}: ${res.status}`);
      assert.equal(sig(env.db), before, JSON.stringify(mode));
    }
    // owner session, same
    for (const mode of ["a", " A", ["A"]]) {
      const res = await claim(env, "owner", { ...A_BODY, mode });
      assert.ok(res.status === 400 || res.status === 403, `owner ${JSON.stringify(mode)}: ${res.status}`);
      assert.equal(sig(env.db), before);
    }
    assert.equal(runs_n(env), 0);
  });
});

const GO_VARIANTS: Array<[string, string, string]> = [
  ["provider exact, model plain", "opencode-go", "plain-model"],
  ["model prefix only", "synthetic", "opencode-go/x"],
  ["model bare prefix", "synthetic", "opencode-go/"],
  ["provider upper", "OPENCODE-GO", "plain-model"],
  ["provider mixed", "OpenCode-Go", "plain-model"],
  ["provider padded left", " opencode-go", "plain-model"],
  ["provider padded right", "opencode-go ", "plain-model"],
  ["provider tab", "\topencode-go", "plain-model"],
  ["model upper prefix", "synthetic", "OPENCODE-GO/x"],
  ["model mixed prefix", "synthetic", "OpenCode-Go/x"],
  ["model padded prefix", "synthetic", " opencode-go/x"],
  ["model nested prefix", "synthetic", "vendor/opencode-go/x"],
];

test("SEL-68 harden: Go-label variants as mode B are refused 403 for an external token (exact spelling)", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "v-go");
    const before = sig(env.db);
    for (const [label, provider, model] of GO_VARIANTS.slice(0, 3)) {
      refused(await claim(env, { token: agent.token }, { mode: "B", runtime: "codex_cli", provider, model }), label);
      assert.equal(sig(env.db), before, label);
    }
  });
});

// HARDEN2: leader decision — fail-closed, same folding as opencode_tui.ts (NFKC, format chars, hyphen-likes, case, space).
const FOLDED_PROVIDERS = ["OPENCODE-GO", "OpenCode-Go", " opencode-go", "opencode-go ", " opencode-go ", "\topencode-go", "\uFF4F\uFF50\uFF45\uFF4E\uFF43\uFF4F\uFF44\uFF45-\uFF47\uFF4F", "opencode\u2011go", "opencode\u2212go", "opencode-go\u200B", "open\u200Bcode-go"];
const FOLDED_MODELS = ["OPENCODE-GO/x", "OpenCode-Go/x", " opencode-go/x", "\uFF4F\uFF50\uFF45\uFF4E\uFF43\uFF4F\uFF44\uFF45-\uFF47\uFF4F/x", "opencode\u2011go/x", "opencode-go\u200B/x"];

test("SEL-68 harden2: folded Go-label spellings (case, padding, NFKC, hyphen-likes, zero-width) are 403 forbidden for external token and owner, nothing written", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "v-fold");
    const before = sig(env.db);
    const full = state_signature(env.db);
    const bodies: Array<[string, Record<string, unknown>]> = [
      ...FOLDED_PROVIDERS.map((provider): [string, Record<string, unknown>] => [`provider ${JSON.stringify(provider)}`, { mode: "B", runtime: "codex_cli", provider, model: "plain-model" }]),
      ...FOLDED_MODELS.map((model): [string, Record<string, unknown>] => [`model ${JSON.stringify(model)}`, { mode: "B", runtime: "codex_cli", provider: "synthetic", model }]),
    ];
    for (const [label, body] of bodies) {
      refused(await claim(env, { token: agent.token }, body), `ext ${label}`);
      refused(await claim(env, "owner", body), `owner ${label}`);
      assert.equal(sig(env.db), before, label);
    }
    assert.equal(state_signature(env.db), full);
    assert.equal(runs_n(env), 0);
  });
});

test("SEL-68 harden2: folded Go-label spellings are 403 forbidden for POST /runs to a non-internal actor, and run_id claim of such a stored run", async () => {
  await with_api(async (env) => {
    const ext = await make_agent(env, "v-fold-run");
    const human = env.db.get<{ id: string }>("SELECT id FROM actors WHERE kind = 'human' LIMIT 1")!.id;
    const before = sig(env.db);
    for (const [provider, model] of [...FOLDED_PROVIDERS.map((x) => [x, "plain"]), ...FOLDED_MODELS.map((x) => ["synthetic", x])]) {
      for (const actor_id of [ext.actor_id, human]) {
        const res = await create_run(env, { actor_id, mode: "B", runtime: "synthetic-runtime", provider, model });
        assert.equal(res.status, 403, `${JSON.stringify([provider, model])} ${actor_id}: ${res.status}`);
        assert.equal(res.json.error.code, "forbidden");
        assert.equal(sig(env.db), before);
      }
    }
    // a stored run carrying such a label cannot be taken by run_id by an external token
    const edition = env.db.get<{ active_edition_id: string }>("SELECT active_edition_id FROM projects WHERE id = ?", env.p.project_id)!;
    env.db.run(
      `INSERT INTO runs (id, project_id, edition_id, actor_id, mode, runtime, provider, model, role, status, base_control_rev, started_at)
       VALUES ('legacy-fold', ?, ?, ?, 'B', 'synthetic-runtime', 'OpenCode-Go', 'plain', 'worker', 'queued', 0, 1)`,
      env.p.project_id,
      edition.active_edition_id,
      ext.actor_id,
    );
    const mid = sig(env.db);
    refused(await claim(env, { token: ext.token }, { run_id: "legacy-fold" }), "stored folded label");
    assert.equal(sig(env.db), mid);
  });
});

test("SEL-68 harden2: internal_ai asking mode A with a folded spelling stays 400 invalid_payload (exact spelling required), nothing written (regression)", async () => {
  await with_api(async (env) => {
    const int = await make_agent(env, "v-fold-int", undefined, "internal_ai");
    const before = sig(env.db);
    for (const [provider, model] of [
      ["OpenCode-Go", GO_MODEL],
      [" opencode-go", GO_MODEL],
      ["opencode-go", "OpenCode-Go/x"],
      ["opencode\u2011go", GO_MODEL],
    ]) {
      assert_error(await claim(env, { token: int.token }, { mode: "A", runtime: "pes_builtin", provider, model }), 400, "invalid_payload");
      assert.equal(sig(env.db), before, JSON.stringify([provider, model]));
    }
    // exact spelling still works
    assert_ok(await claim(env, { token: int.token }, A_BODY));
  });
});

test("SEL-68 harden: lookalike-unicode provider/model for an external token never becomes a mode A run", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "v-uni");
    for (const [provider, model] of [
      ["пpencode-go", "x"], // Cyrillic
      ["opencode‑go", "x"], // non-breaking hyphen
      ["opencode-go​", "x"], // zero width space
      ["synthetic", "opencode∕go/x"], // division slash
    ]) {
      const res = await claim(env, { token: agent.token }, { mode: "B", runtime: "codex_cli", provider, model });
      assert.ok([200, 400, 403].includes(res.status), `${res.status}`);
      assert.equal(a_runs_n(env), 0);
      if (res.status === 200) {
        await call(env, {
          method: "POST",
          path: P(env, `/runs/${res.json.data.run_id}/release`),
          auth: { token: agent.token },
          body: { lease_id: res.json.data.lease_id, fence: res.json.data.fence },
        });
      }
    }
    assert.equal(go_label_non_internal_n(env), 0);
  });
});

test("SEL-68 harden: empty or missing provider with a Go model, and mode B + Go label, write nothing", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "v-empty");
    const before = sig(env.db);
    for (const body of [
      { mode: "B", runtime: "codex_cli", provider: "", model: GO_MODEL },
      { mode: "B", runtime: "codex_cli", model: GO_MODEL },
      { mode: "B", runtime: "codex_cli", provider: null, model: GO_MODEL },
      { mode: "B", runtime: "codex_cli", provider: 5, model: GO_MODEL },
      { mode: "A", runtime: "pes_builtin", provider: "", model: GO_MODEL },
    ]) {
      const res = await claim(env, { token: agent.token }, body);
      assert.ok(res.status === 400 || res.status === 403, `${JSON.stringify(body)}: ${res.status}`);
      assert.equal(sig(env.db), before, JSON.stringify(body));
    }
    refused(await claim(env, { token: agent.token }, { mode: "B", runtime: "codex_cli", provider: "x", model: GO_MODEL }), "B + Go model");
  });
});

test("SEL-68 harden: claim_defaults / expected_control_rev combinations — stale or fresh rev, the refusal is 403 and writes nothing", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "v-rev");
    const before = sig(env.db);
    for (const expected_control_rev of ["0", "1", "999999", "-1", "x", 7, null]) {
      const res = await claim(env, { token: agent.token }, { ...A_BODY, expected_control_rev });
      assert.ok(res.status === 400 || res.status === 403, `${JSON.stringify(expected_control_rev)}: ${res.status}`);
      assert.equal(sig(env.db), before);
    }
    const cur = env.db.get<{ control_rev: bigint }>("SELECT control_rev FROM projects WHERE id = ?", env.p.project_id)!.control_rev;
    refused(await claim(env, { token: agent.token }, { ...A_BODY, expected_control_rev: String(cur) }), "fresh rev");
    refused(await claim(env, { token: agent.token }, { ...A_BODY, expected_control_rev: String(cur + 5n) }), "stale rev (future)");
    refused(await claim(env, "owner", { ...A_BODY, expected_control_rev: String(cur) }), "owner fresh rev");
    assert.equal(sig(env.db), before);
  });
});

test("SEL-68 harden: extra / unknown body fields cannot smuggle a mode (claim with mode + run_id, label fields beside run_id)", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "v-extra");
    const before = sig(env.db);
    for (const body of [
      { run_id: "nope", ...A_BODY },
      { ...A_BODY, run_id: "nope" },
      { ...A_BODY, actor_id: "x" },
      { ...A_BODY, kind: "internal_ai" },
      { ...A_BODY, actor_kind: "internal_ai" },
      { ...A_BODY, internal: true },
    ]) {
      const res = await claim(env, { token: agent.token }, body);
      assert.ok(res.status >= 400 && res.status < 500, `${JSON.stringify(body)}: ${res.status}`);
      assert.equal(sig(env.db), before);
    }
  });
});

// ---------------------------------------------------------------------------
// (2) 경로

test("SEL-68 harden: POST /runs — owner cannot create an A / Go-labelled run for external_agent, human owner actor, or any non-internal actor", async () => {
  await with_api(async (env) => {
    const ext = await make_agent(env, "p-ext");
    const owner_actor = env.db.get<{ id: string }>("SELECT id FROM actors WHERE kind = 'human' LIMIT 1")?.id;
    assert.ok(owner_actor, "a human actor exists");
    const before = sig(env.db);
    const bodies = (actor_id: string) => [
      { actor_id, mode: "A", runtime: "synthetic-runtime", provider: "opencode-go", model: GO_MODEL },
      { actor_id, mode: "B", runtime: "synthetic-runtime", provider: "opencode-go", model: "plain" },
      { actor_id, mode: "B", runtime: "synthetic-runtime", provider: "synthetic", model: GO_MODEL },
    ];
    for (const actor_id of [ext.actor_id, owner_actor!]) {
      for (const body of bodies(actor_id)) {
        const res = await create_run(env, body);
        assert.ok(res.status === 403, `${actor_id} ${JSON.stringify(body)}: ${res.status} ${JSON.stringify(res.json)}`);
        assert.equal(res.json.error.code, "forbidden");
        assert.equal(sig(env.db), before);
        assert.equal(state_signature(env.db), state_signature(env.db));
      }
    }
    // an external agent token cannot start runs at all
    const tok = await call(env, { method: "POST", path: P(env, "/runs"), auth: { token: ext.token }, body: bodies(ext.actor_id)[0] });
    assert.equal(tok.status, 403);
    assert.equal(sig(env.db), before);
    // a normal B run for the external agent is still created
    assert_ok(await create_run(env, { actor_id: ext.actor_id, mode: "B", runtime: "synthetic-runtime", provider: "synthetic", model: "synthetic-model" }), 201);
  });
});

test("SEL-68 harden: POST /runs — unknown actor stays 404, internal_ai target gets A (Go ON) and policy_blocked (Go OFF)", async () => {
  await with_api(async (env) => {
    const int = await make_agent(env, "p-int", undefined, "internal_ai");
    const before = sig(env.db);
    const unknown = await create_run(env, { actor_id: "no-such-actor", ...A_BODY, runtime: "synthetic-runtime" });
    assert.ok(unknown.status === 404 || unknown.status === 403, `${unknown.status}`);
    assert.equal(sig(env.db), before);
    const ok = assert_ok(await create_run(env, { actor_id: int.actor_id, ...A_BODY, runtime: "synthetic-runtime" }), 201);
    assert.equal(ok.mode, "A");
    assert.equal(a_runs_n(env), 1);
    await go_off(env);
    const off_before = sig(env.db);
    assert_error(await create_run(env, { actor_id: int.actor_id, ...A_BODY, runtime: "synthetic-runtime" }), 403, "policy_blocked");
    assert.equal(sig(env.db), off_before);
  });
});

test("SEL-68 harden: run_id claim — external token and owner cannot take an A run or a Go-labelled B run assigned to them", async () => {
  await with_api(async (env) => {
    const int = await make_agent(env, "r-int", undefined, "internal_ai");
    const ext = await make_agent(env, "r-ext");
    const made = assert_ok(await create_run(env, { actor_id: int.actor_id, ...A_BODY, runtime: "synthetic-runtime" }), 201);
    const before = sig(env.db);
    refused(await claim(env, { token: ext.token }, { run_id: made.run_id }), "external takes internal A run");
    refused(await claim(env, "owner", { run_id: made.run_id }), "owner takes internal A run");
    assert.equal(sig(env.db), before);
    // a Go-labelled B run stored for an external actor (legacy / forged row) is also refused
    const edition = env.db.get<{ active_edition_id: string }>("SELECT active_edition_id FROM projects WHERE id = ?", env.p.project_id)!;
    for (const [id, provider, model] of [
      ["legacy-go-prov", "opencode-go", "plain"],
      ["legacy-go-model", "synthetic", GO_MODEL],
    ]) {
      env.db.run(
        `INSERT INTO runs (id, project_id, edition_id, actor_id, mode, runtime, provider, model, role, status, base_control_rev, started_at)
         VALUES (?, ?, ?, ?, 'B', 'synthetic-runtime', ?, ?, 'worker', 'queued', 0, 1)`,
        id,
        env.p.project_id,
        edition.active_edition_id,
        ext.actor_id,
        provider,
        model,
      );
    }
    const mid = sig(env.db);
    refused(await claim(env, { token: ext.token }, { run_id: "legacy-go-prov" }), "legacy provider label");
    refused(await claim(env, { token: ext.token }, { run_id: "legacy-go-model" }), "legacy model label");
    assert.equal(sig(env.db), mid);
    assert.equal(leases_n(env), 0);
    // unknown run id is still not_found (no kind oracle)
    assert_error(await claim(env, { token: ext.token }, { run_id: "nope" }), 404, "not_found");
    // the owning internal_ai takes its own A run
    const taken = assert_ok(await claim(env, { token: int.token }, { run_id: made.run_id }));
    assert.equal(taken.run_id, made.run_id);
  });
});

test("SEL-68 harden: handoff cannot turn an A run over to an external actor or mode; the external still cannot claim it afterwards", async () => {
  await with_api(async (env) => {
    const int = await make_agent(env, "h-int", undefined, "internal_ai");
    const ext = await make_agent(env, "h-ext");
    const held = assert_ok(await claim(env, { token: int.token }, A_BODY));
    const handoff = (auth: Auth, body: unknown) => call(env, { method: "POST", path: P(env, `/runs/${held.run_id}/handoffs`), auth, body });
    const before = sig(env.db);
    for (const body of [{ target_actor_id: ext.actor_id }, { target_mode: "B" }, { target_mode: "B", target_actor_id: ext.actor_id }]) {
      const res = await handoff("owner", body);
      assert.equal(res.status, 400, JSON.stringify(res.json));
      assert.equal(sig(env.db), before);
    }
    // the external agent is not the holder: it cannot hand off either
    const stolen = await handoff({ token: ext.token }, {});
    assert.equal(stolen.status, 403);
    assert.equal(sig(env.db), before);
    // genuine handoff by the holder, then the external agent tries to pick the queued A run up
    assert_ok(await handoff({ token: int.token }, {}));
    const queued = sig(env.db);
    refused(await claim(env, { token: ext.token }, { run_id: held.run_id }), "external after handoff");
    refused(await claim(env, "owner", { run_id: held.run_id }), "owner after handoff");
    assert.equal(sig(env.db), queued);
    assert.equal(n(env.db, "SELECT COUNT(*) AS n FROM project_leases WHERE state = 'active'"), 0, "no live lease");
    // the internal actor re-claims it
    assert_ok(await claim(env, { token: int.token }, { run_id: held.run_id }));
    assert.equal(go_label_non_internal_n(env), 0);
  });
});

test("SEL-68 harden: interrupt then re-claim — external cannot pick up the interrupted A run, internal can", async () => {
  await with_api(async (env) => {
    const int = await make_agent(env, "i-int", undefined, "internal_ai");
    const ext = await make_agent(env, "i-ext");
    const held = assert_ok(await claim(env, { token: int.token }, A_BODY));
    const stop = await call(env, { method: "POST", path: P(env, `/runs/${held.run_id}/interrupt`), auth: "owner", body: {} });
    assert.ok(stop.status === 200 || stop.status === 202, `${stop.status} ${JSON.stringify(stop.json)}`);
    const status = env.db.get<{ status: string }>("SELECT status FROM runs WHERE id = ?", held.run_id)!.status;
    const before = sig(env.db);
    refused(await claim(env, { token: ext.token }, { run_id: held.run_id }), `external after interrupt (${status})`);
    assert.equal(sig(env.db), before);
    if (status === "interrupted" || status === "queued") assert_ok(await claim(env, { token: int.token }, { run_id: held.run_id }));
  });
});

test("SEL-68 harden: owner import cannot mint a Go-labelled or mode A run for the human, even with Go claimed_tool/model", async () => {
  await with_api(async (env) => {
    const ctx_before = a_runs_n(env);
    // A bad import body is rejected for its own reasons; whatever happens, no A / Go-labelled run is stored.
    for (const claimed_model of [GO_MODEL, "opencode-go", "OpenCode-Go/x"]) {
      const request_id = `req-${claimed_model.replace(/[^a-z]/gi, "")}`;
      await call(env, {
        method: "POST",
        path: P(env, "/runs"),
        auth: "owner",
        key: `import-${request_id}`,
        body: { import: { request_id, claimed_tool: "opencode-go", claimed_model, results: [{ op: "append_version", object_id: "none", title: "합성", content: {} }] } },
      });
    }
    assert.equal(a_runs_n(env), ctx_before);
    assert.equal(
      n(env.db, "SELECT COUNT(*) AS n FROM runs WHERE provider = 'opencode-go' OR model LIKE 'opencode-go/%'"),
      0,
      "the import run's labels are fixed, never the claimed Go label",
    );
  });
});

test("SEL-68 harden: MCP — lowercase / padded mode in claim_defaults, Go label in defaults, and per-call overrides write nothing", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "m-ext");
    const before = sig(env.db);
    for (const defaults of [
      { mode: "a", runtime: "pes_builtin", provider: "opencode-go", model: GO_MODEL },
      { mode: " A", runtime: "pes_builtin", provider: "opencode-go", model: GO_MODEL },
      { mode: "B", runtime: "codex_cli", provider: "opencode-go", model: "x" },
      { runtime: "codex_cli", provider: "synthetic", model: "opencode-go/" },
    ]) {
      const client = new FakeMcpClient(new McpServer({ api: env.app, project_id: env.p.project_id, token: agent.token, claim_defaults: defaults as any }));
      try {
        await client.initialize();
        for (const args of [{ idempotency_key: "m-1" }, { idempotency_key: "m-2", run_id: "nope" }]) {
          const out = await client.tool("pes_claim", args);
          assert.equal(out.is_error, true, JSON.stringify(defaults));
        }
        assert.equal(sig(env.db), before, JSON.stringify(defaults));
      } finally {
        await client.close();
      }
    }
    assert.equal(runs_n(env), 0);
  });
});

test("SEL-68 harden: CLI — lowercase mode, upper-case provider, and Go model as B are not a way to a Go run", async () => {
  await with_cli(async (c) => {
    const agent = await c.agent("cli-h");
    const flags = (mode: string, provider: string, model: string) => ["--mode", mode, "--runtime", "pes_builtin", "--provider", provider, "--model", model];
    const before = sig(c.env.db);
    const commits = c.commits().length;
    for (const [label, args] of [
      ["lowercase mode", flags("a", "opencode-go", GO_MODEL)],
      ["B + Go model", flags("B", "synthetic", GO_MODEL)],
      ["B + Go provider", flags("B", "opencode-go", "plain")],
    ] as Array<[string, string[]]>) {
      for (const extra of [{ PES_TOKEN: agent.token }, {}] as Array<Record<string, string | undefined>>) {
        expect_rejected(c.run(["claim", SLUG, ...args], extra), label);
        assert.equal(sig(c.env.db), before, label);
        assert.equal(c.commits().length, commits, label);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// (3) 순서: 영수증·커서·이벤트·lease 보다 앞선 거절

test("SEL-68 harden: refusal precedes receipt/cursor/event/lease writes; same key resent is the same refusal with no change", async () => {
  await with_api(async (env) => {
    const ext = await make_agent(env, "o-ext");
    const key = "sel68-harden-key";
    const before = sig(env.db);
    const full = state_signature(env.db);
    const first = await claim(env, { token: ext.token }, A_BODY, key);
    refused(first, "first");
    assert.equal(sig(env.db), before, "no receipt / event / lease / counter after the first refusal");
    for (let i = 0; i < 3; i++) {
      const again = await claim(env, { token: ext.token }, A_BODY, key);
      refused(again, `resend ${i}`);
      assert.equal(again.json.error.code, first.json.error.code);
      assert.equal(sig(env.db), before);
    }
    assert.equal(state_signature(env.db), full);
    // GET /requests/{key} knows nothing of the refused key
    const info = await call(env, { method: "GET", path: P(env, `/requests/${key}`), auth: { token: ext.token } });
    assert.ok(info.status === 404 || info.status === 403, `${info.status}`);
    // same key, now a legal B body: one consistent behaviour (a fresh 200, or 409 key reuse), never a mode A run
    const second = await claim(env, { token: ext.token }, B_BODY, key);
    assert.ok(second.status === 200 || second.status === 409, `${second.status} ${JSON.stringify(second.json)}`);
    const third = await claim(env, { token: ext.token }, B_BODY, key);
    assert.equal(third.status, second.status === 200 ? 200 : 409, "replay is consistent with the first answer");
    assert.equal(a_runs_n(env), 0);
    assert.ok(leases_n(env) <= 1);
  });
});

test("SEL-68 harden: a refused POST /runs and a refused run_id claim also leave receipts, events and counters untouched on resend", async () => {
  await with_api(async (env) => {
    const ext = await make_agent(env, "o2-ext");
    const int = await make_agent(env, "o2-int", undefined, "internal_ai");
    const made = assert_ok(await create_run(env, { actor_id: int.actor_id, ...A_BODY, runtime: "synthetic-runtime" }), 201);
    const before = sig(env.db);
    for (let i = 0; i < 2; i++) {
      const res = await create_run(env, { actor_id: ext.actor_id, ...A_BODY, runtime: "synthetic-runtime" }, "sel68-h-create");
      assert.equal(res.status, 403);
      assert.equal(sig(env.db), before);
      refused(await claim(env, { token: ext.token }, { run_id: made.run_id }, "sel68-h-runid"), `run_id resend ${i}`);
      assert.equal(sig(env.db), before);
    }
  });
});

// ---------------------------------------------------------------------------
// (4) 토큰 회수·actor 종류 변경 뒤

test("SEL-68 harden: revoked token on an A run — claim is 401/403 and nothing is written", async () => {
  await with_api(async (env) => {
    const int = await make_agent(env, "t-int", undefined, "internal_ai");
    const held = assert_ok(await claim(env, { token: int.token }, A_BODY));
    assert_ok(await call(env, { method: "POST", path: P(env, `/runs/${held.run_id}/release`), auth: { token: int.token }, body: { lease_id: held.lease_id, fence: held.fence } }));
    env.db.run("UPDATE agent_tokens SET revoked_at = ? WHERE id = ?", 1n, int.token_id);
    const before = sig(env.db);
    const res = await claim(env, { token: int.token }, { run_id: held.run_id });
    assert.ok(res.status === 401 || res.status === 403, `${res.status}`);
    assert.equal(sig(env.db), before);
  });
});

test("SEL-68 harden: actor kind changed internal_ai -> external_agent — the old A run is no longer claimable by it (403), a B claim still works", async () => {
  await with_api(async (env) => {
    const actor = await make_agent(env, "k-actor", undefined, "internal_ai");
    const held = assert_ok(await claim(env, { token: actor.token }, A_BODY));
    assert_ok(await call(env, { method: "POST", path: P(env, `/runs/${held.run_id}/release`), auth: { token: actor.token }, body: { lease_id: held.lease_id, fence: held.fence } }));
    env.db.run("UPDATE actors SET kind = 'external_agent' WHERE id = ?", actor.actor_id);
    const before = sig(env.db);
    refused(await claim(env, { token: actor.token }, { run_id: held.run_id }), "demoted actor resumes A run");
    refused(await claim(env, { token: actor.token }, A_BODY), "demoted actor new A claim");
    assert.equal(sig(env.db), before);
    assert_ok(await claim(env, { token: actor.token }, B_BODY));
  });
});

test("SEL-68 harden: actor kind changed external_agent -> internal_ai — Go policy applies from then on (OFF -> policy_blocked)", async () => {
  await with_api(async (env) => {
    const actor = await make_agent(env, "k2-actor");
    env.db.run("UPDATE actors SET kind = 'internal_ai' WHERE id = ?", actor.actor_id);
    await go_off(env);
    const before = sig(env.db);
    assert_error(await claim(env, { token: actor.token }, A_BODY), 403, "policy_blocked");
    assert.equal(sig(env.db), before);
  });
});

// ---------------------------------------------------------------------------
// (5) 회귀

test("SEL-68 harden: internal_ai Go ON/OFF and external B regressions", async () => {
  await with_api(async (env) => {
    const int = await make_agent(env, "g-int", undefined, "internal_ai");
    const ext = await make_agent(env, "g-ext");
    const on = assert_ok(await claim(env, { token: int.token }, A_BODY));
    assert.equal(a_runs_n(env), 1);
    assert_ok(await call(env, { method: "POST", path: P(env, `/runs/${on.run_id}/release`), auth: { token: int.token }, body: { lease_id: on.lease_id, fence: on.fence } }));
    // internal_ai can also resume its own A run by run_id with Go ON
    const again = assert_ok(await claim(env, { token: int.token }, { run_id: on.run_id }));
    assert_ok(await call(env, { method: "POST", path: P(env, `/runs/${again.run_id}/release`), auth: { token: int.token }, body: { lease_id: again.lease_id, fence: again.fence } }));
    await go_off(env);
    assert_error(await claim(env, { token: int.token }, { run_id: on.run_id }), 403, "policy_blocked");
    assert_error(await claim(env, { token: int.token }, A_BODY), 403, "policy_blocked");
    // an internal_ai with a mode B claim and no Go label is unaffected by Go OFF
    assert_ok(await claim(env, { token: int.token }, B_BODY));
    // external B (no Go label) unaffected by Go OFF too
    const other = await make_agent(env, "g-ext2");
    const res = await claim(env, { token: other.token }, B_BODY);
    assert.ok(res.status === 200 || res.status === 409, `${res.status}`); // 409: the int B lease is live
    void ext;
  });
  await with_api(async (env) => {
    const ext = await make_agent(env, "g-ext3");
    await go_off(env);
    assert_ok(await claim(env, { token: ext.token }, B_BODY));
    assert.equal(a_runs_n(env), 0);
  });
});
