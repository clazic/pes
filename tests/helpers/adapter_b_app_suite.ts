// SEL-55 (stage 2 PR20c) shared suite for the two method-B APP adapters: Codex app and OpenCode app.
// Everything is synthetic: the 20a fake MCP client over the real in-memory ApiApp, a temporary HOME, an in-memory
// fake key store, invented slugs and tokens. No app is started, nothing is read from or written to ~/.codex,
// ~/.config/opencode, an app's own settings or ~/.claude.
//
// Two paths, both pinned here (the worker implements them; 해석 numbers are in the two test files):
//   direct   the app authenticates to PES itself with the agent token (the MCP connection of 20a/20b, runtime
//            codex_app / opencode_app) -> the actor is the external_agent, the receipt is not an import
//   handoff  the app cannot connect: the person copies a bundle to the app and pastes its answer back (the 20a
//            explicit hand-off) -> the actor is the human owner, via = import, runtime <app>_handoff
// The handoff adapter class has the SAME constructor and methods as ClaudeAppAdapter
// ({api, project_id, owner_session}; export_bundle({stage_id, round_id}); import_result({bundle_text, result_text})).

import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { McpServer } from "../../scripts/pes_core/mcp_server.ts";
import type { ApiLike } from "../../scripts/pes_core/adapters/api_client.ts";
import { FakeMcpClient, wire } from "./adapter_b_env.ts";
import {
  a_run_row,
  a_side_counts,
  API_BASE_URL,
  FakeKeyStore,
  GO_MODEL,
  REPO,
  SERVER_SCRIPT,
  with_cli,
  type CliEnv,
  type CliSpec,
} from "./adapter_b_cli_suite.ts";
import { ALL_AGENT_SCOPES, assert_ok, bump_control_rev, call, make_agent, project_path, SESSION_SECRET } from "./api_env.ts";
import { restart_app } from "./api_flow.ts";
import { more_version } from "./blob_env.ts";
import { set_current } from "../../scripts/pes_core/content.ts";
import { isolated_home } from "./isolated_home.ts";
import { events_of_type } from "./adapter_b_flow.ts";
import { state_signature, table_counts } from "./state_signature.ts";

interface HandoffAdapterLike {
  export_bundle(input: { stage_id: string; round_id: string }): Promise<{ bundle: Record<string, any>; text: string }>;
  import_result(input: { bundle_text: string; result_text: string; attachments?: Array<{ name: string }> }): Promise<any>;
}

export interface AppSpec {
  /** Test title prefix, e.g. "codex-app". */
  label: string;
  runtime: "codex_app" | "opencode_app";
  /** runtime of the run an import creates, e.g. "codex_app_handoff" */
  handoff_runtime: string;
  /** provider of both the direct and the hand-off run */
  provider: string;
  /** the terminal sibling that shares the tool's vendor: it must not interfere with the app */
  sibling: { runtime: "codex_cli" | "opencode_tui"; provider: string };
  /** the hand-off adapter under test */
  make_adapter(options: { api: ApiLike; project_id: string; owner_session: string }): HandoffAdapterLike;
  /** the direct-connection spec for the shared 20b suite (entry, launch_env, doc example, ...) */
  cli: CliSpec;
  /** adapter file name without .ts, e.g. "codex_app" */
  module: string;
  doc: string;
}

const CHILD = fileURLToPath(new URL("./app_entry_child.ts", import.meta.url));

function owner_adapter(spec: AppSpec, env: CliEnv, overrides: Record<string, unknown> = {}): HandoffAdapterLike {
  return spec.make_adapter({ api: env.app, project_id: env.p.project_id, owner_session: SESSION_SECRET, ...overrides } as any);
}

const exported = (spec: AppSpec, env: CliEnv, a: HandoffAdapterLike = owner_adapter(spec, env)) =>
  a.export_bundle({ stage_id: env.stage.plan, round_id: env.round_id });

function result_text(env: CliEnv, title = "앱이 쓴 장", extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    results: [{ op: "append_version", object_id: env.object_id, title }],
    claimed: { tool: "synthetic-app", model: "synthetic-model-name" },
    ...extra,
  });
}

async function refused(promise: Promise<unknown>, code: string | string[]): Promise<any> {
  const wanted = Array.isArray(code) ? code : [code];
  try {
    await promise;
  } catch (error: any) {
    assert.ok(wanted.includes(error.code), `expected ${wanted.join("|")}, got ${error.code}: ${error.message}`);
    assert.match(String(error.message), /[가-힣]/, "the message is Korean");
    return error;
  }
  assert.fail(`expected the import to be refused with ${wanted.join("|")}`);
}

/** The ApiLike that records every request the adapter sends, so a test can replay or alter one by hand. */
function recording(env: CliEnv): { api: ApiLike; sent: Array<{ method: string; path: string; headers: Record<string, string>; body: string | Uint8Array | null }> } {
  const sent: Array<{ method: string; path: string; headers: Record<string, string>; body: string | Uint8Array | null }> = [];
  return {
    sent,
    api: {
      handle: (request) => {
        sent.push({ ...request, headers: { ...request.headers } });
        return env.app.handle(request) as any;
      },
    },
  };
}

function fenced(path: string, info: string): string[] {
  const text = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  const out: string[] = [];
  const re = /^```([^\n`]*)\n([\s\S]*?)\n```[ \t]*$/gm;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) if ((m[1] ?? "").trim() === info) out.push(m[2] ?? "");
  return out;
}

/** every file AND folder below dir -> "size:mtimeMs" (a touch is noticed too). Relative paths use "/". */
function stamps(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      const st = lstatSync(full);
      out[relative(dir, full).replace(/\\/g, "/")] = `${st.isDirectory() ? "d" : st.size}:${st.mtimeMs}`;
      if (st.isDirectory()) walk(full);
    }
  };
  walk(dir);
  out["."] = `d:${lstatSync(dir).mtimeMs}`;
  return out;
}

export function define_app_suite(spec: AppSpec): void {
  const t = (name: string, fn: () => Promise<void> | void) => test(`${spec.label}: ${name}`, fn);

  t("the bundle is a pure read: the request, no secret, no lease, no run", async () => {
    await with_cli(spec.cli, async (env) => {
      const before = state_signature(env.db);
      const { bundle, text } = await exported(spec, env);
      assert.equal(state_signature(env.db), before, "copying is not submitting: nothing written");
      assert.equal(bundle.kind, "pes.handoff");
      assert.equal(bundle.project_id, env.p.project_id);
      assert.equal(bundle.stage_id, env.stage.plan);
      assert.equal(bundle.round_id, env.round_id);
      assert.deepEqual(bundle.base_versions, [{ object_id: env.object_id, version_id: env.version_id }]);
      assert.match(bundle.manifest_hash, /^[0-9a-f]{64}$/);
      assert.match(bundle.instructions, /[가-힣]/);
      for (const secret of [env.cli_agent.token, env.agent.token, SESSION_SECRET, "lease_id", "fence", "Bearer"]) {
        assert.ok(!text.includes(secret), `the bundle never contains ${secret}`);
      }
      env.clock.advance(3 * 60 * 60 * 1000);
      assert.equal(table_counts(env.db).runs, 0n);
      assert.equal(table_counts(env.db).project_leases, 0n, "nothing expires while the person talks to the app");
    });
  });

  t("hand-off round trip: the import is the human owner's (via import), runtime and provider exact, the app's claims are not trusted", async () => {
    await with_cli(spec.cli, async (env) => {
      const a = owner_adapter(spec, env);
      const { text } = await exported(spec, env, a);
      const versions = table_counts(env.db).object_versions;
      const out = await a.import_result({ bundle_text: text, result_text: result_text(env) });
      assert.equal(out.status, "imported");
      assert.equal(out.via, "import");
      assert.equal(out.adopted_by, env.p.actor_id);
      assert.equal(table_counts(env.db).object_versions - versions, 1n);
      const run = env.db.get<{ mode: string; runtime: string; provider: string; model: string; status: string; actor_id: string }>(
        "SELECT mode, runtime, provider, model, status, actor_id FROM runs WHERE id = ?",
        out.run_id,
      )!;
      assert.deepEqual(
        { mode: run.mode, runtime: run.runtime, provider: run.provider, model: run.model, status: run.status },
        { mode: "B", runtime: spec.handoff_runtime, provider: spec.provider, model: "unknown", status: "succeeded" },
        "a pasted model name never becomes the run's model",
      );
      assert.equal(run.actor_id, env.p.actor_id, "the run is the owner's own");
      assert.equal(env.db.get<{ kind: string }>("SELECT kind FROM actors WHERE id = ?", run.actor_id)?.kind, "human");
      const receipt = env.db.get<{ actor_id: string; via: string }>(
        "SELECT m.actor_id AS actor_id, m.via AS via FROM mutation_commits m JOIN events e ON e.tx_id = m.id AND e.project_id = m.project_id WHERE e.project_id = ? AND e.type = 'result.submitted' AND e.run_id = ?",
        env.p.project_id,
        out.run_id,
      )!;
      assert.deepEqual({ ...receipt }, { actor_id: env.p.actor_id, via: "import" });
      assert.deepEqual(out.provenance, { source: "manual_import", claimed_tool: "synthetic-app", claimed_model: "synthetic-model-name", verified: false });
      assert.equal(events_of_type(env, "run.claimed").length, 0, "an import has no agent claim");
      assert.equal(table_counts(env.db).project_leases, 0n, "no lease");
      assert.equal(table_counts(env.db).approvals, 0n, "import is not approval");
    });
  });

  t("direct and hand-off are told apart: the direct app is the external_agent (runtime exact), the pasted result is the human's", async () => {
    await with_cli(spec.cli, async (env, open) => {
      const client = open(await env.cli_client());
      const claim = await client.ok("pes_claim", { idempotency_key: "p-claim" });
      const direct = env.db.get<{ mode: string; runtime: string; provider: string; model: string; actor_id: string }>(
        "SELECT mode, runtime, provider, model, actor_id FROM runs WHERE id = ?",
        claim.run_id,
      )!;
      assert.deepEqual({ mode: direct.mode, runtime: direct.runtime, provider: direct.provider, model: direct.model }, { mode: "B", runtime: spec.runtime, provider: spec.provider, model: "unknown" });
      assert.equal(direct.actor_id, env.cli_agent.actor_id);
      assert.equal(env.db.get<{ kind: string }>("SELECT kind FROM actors WHERE id = ?", direct.actor_id)?.kind, "external_agent");
      await client.ok("pes_submit", { results: [{ op: "append_version", object_id: env.object_id, title: "직접 연결" }], idempotency_key: "p-submit" });
      await client.ok("pes_complete", { status: "succeeded", idempotency_key: "p-done" });
      const direct_receipt = env.db.get<{ actor_id: string; via: string }>(
        "SELECT m.actor_id AS actor_id, m.via AS via FROM mutation_commits m JOIN events e ON e.tx_id = m.id AND e.project_id = m.project_id WHERE e.project_id = ? AND e.type = 'result.submitted' AND e.run_id = ?",
        env.p.project_id,
        claim.run_id,
      )!;
      assert.equal(direct_receipt.actor_id, env.cli_agent.actor_id, "the direct receipt names the agent");
      assert.notEqual(direct_receipt.via, "import");

      const a = owner_adapter(spec, env);
      const { text } = await exported(spec, env, a);
      const out = await a.import_result({ bundle_text: text, result_text: result_text(env, "붙여 넣은 결과") });
      const pasted = env.db.get<{ runtime: string; actor_id: string }>("SELECT runtime, actor_id FROM runs WHERE id = ?", out.run_id)!;
      assert.notEqual(pasted.runtime, direct.runtime, "the two paths are two runtimes");
      assert.notEqual(pasted.actor_id, direct.actor_id, "the two paths are two actors");
      assert.equal(table_counts(env.db).runs, 2n);
      assert.equal(events_of_type(env, "run.claimed").length, 1, "only the direct run was claimed");
    });
  });

  t("a refused paste burns nothing; a bundle copied before a restart is imported by a brand-new adapter", async () => {
    await with_cli(spec.cli, async (env) => {
      const a = owner_adapter(spec, env);
      const { text } = await exported(spec, env, a);
      const sig = state_signature(env.db);
      await refused(a.import_result({ bundle_text: text, result_text: "여기에 결과가 있습니다" }), "bundle_invalid");
      await refused(a.import_result({ bundle_text: text, result_text: JSON.stringify({ results: [] }) }), "bundle_invalid");
      assert.equal(state_signature(env.db), sig, "refusals leave no run, no version, no receipt");
      restart_app(env);
      const fresh = owner_adapter(spec, env);
      const out = await fresh.import_result({ bundle_text: text, result_text: result_text(env, "재접속 뒤 이어서") });
      assert.equal(out.status, "imported");
      assert.equal(events_of_type(env, "result.submitted").length, 1);
    });
  });

  t("a second import of the same bundle writes nothing; the same key with another request is refused (409); an exact retry replays", async () => {
    await with_cli(spec.cli, async (env) => {
      const rec = recording(env);
      const a = spec.make_adapter({ api: rec.api, project_id: env.p.project_id, owner_session: SESSION_SECRET });
      const { text } = await exported(spec, env, a);
      const first = await a.import_result({ bundle_text: text, result_text: result_text(env, "처음") });
      const sig = state_signature(env.db);
      await refused(a.import_result({ bundle_text: text, result_text: result_text(env, "처음") }), "duplicate_import");
      await refused(a.import_result({ bundle_text: text, result_text: result_text(env, "다른 내용") }), "duplicate_import");
      await refused(owner_adapter(spec, env).import_result({ bundle_text: text, result_text: result_text(env, "처음") }), "duplicate_import");
      assert.equal(state_signature(env.db), sig, "duplicates: 0 rows");
      assert.equal(events_of_type(env, "result.submitted").length, 1);

      // by hand: the very request the adapter sent
      const sent = rec.sent.filter((r) => r.method === "POST" && /\/runs$/.test(r.path));
      assert.equal(sent.length, 1, "the adapter sent exactly one write for the import");
      const original = sent[0]!;
      const key = original.headers["idempotency-key"];
      assert.match(String(key), /^import-/, "the key is derived from the request id");
      const body = JSON.parse(String(original.body));
      const replay = await env.app.handle({ method: "POST", path: original.path, headers: { ...original.headers }, body: original.body });
      assert.equal((replay as any).json.replayed, true, "the same key and the same request replays");
      assert.equal((replay as any).json.data.run_id, first.run_id);
      assert.equal(state_signature(env.db), sig, "a replay writes nothing");
      const altered = JSON.stringify({ import: { ...body.import, results: [{ op: "append_version", object_id: env.object_id, title: "다른 요청" }] } });
      const other = await env.app.handle({ method: "POST", path: original.path, headers: { ...original.headers }, body: altered });
      assert.equal(other.status, 409, wire((other as any).json));
      assert.equal((other as any).json.error.code, "idempotency_key_reuse");
      assert.equal(state_signature(env.db), sig, "the refusal wrote nothing");
    });
  });

  t("version errors are refused with nothing written: a changed project, a moved base version, a result outside the bundle", async () => {
    await with_cli(spec.cli, async (env) => {
      const a = owner_adapter(spec, env);
      const mine = await exported(spec, env, a);
      const sig = state_signature(env.db);
      await refused(a.import_result({ bundle_text: mine.text.replace(mine.bundle.manifest_hash, "0".repeat(64)), result_text: result_text(env) }), "bundle_hash_mismatch");
      const out_of_scope = JSON.stringify({ results: [{ op: "append_version", object_id: "no-such-object-in-bundle", title: "범위 밖" }] });
      await refused(a.import_result({ bundle_text: mine.text, result_text: out_of_scope }), "result_out_of_scope");
      assert.equal(state_signature(env.db), sig);

      await bump_control_rev(env);
      await refused(a.import_result({ bundle_text: mine.text, result_text: result_text(env) }), "bundle_stale");

      const fresh = await exported(spec, env, a);
      const v2 = await more_version(env, "app-v2", env.object_id);
      await set_current(env.service, env.ctx("app-adopt"), { object_id: env.object_id, version_id: v2.version_id });
      await refused(a.import_result({ bundle_text: fresh.text, result_text: result_text(env) }), "bundle_stale");
      assert.equal(events_of_type(env, "result.submitted").length, 0, "no stale result was written");
      // a bundle copied now works
      const now = await exported(spec, env, a);
      assert.equal((await a.import_result({ bundle_text: now.text, result_text: result_text(env, "최신 기준") })).status, "imported");
    });
  });

  t("the owner session is what PES checks: a pristine bundle gets no right from a wrong or missing session", async () => {
    await with_cli(spec.cli, async (env) => {
      const { text } = await exported(spec, env);
      const sig = state_signature(env.db);
      for (const owner_session of ["synthetic-wrong-session", ""]) {
        await assert.rejects(
          owner_adapter(spec, env, { owner_session }).import_result({ bundle_text: text, result_text: result_text(env) }),
          (error: any) => error.code === "unauthenticated" || error.code === "forbidden",
        );
      }
      assert.equal(state_signature(env.db), sig);
    });
  });

  t("no secret leaks: bundle, import result, refusal messages, entry, launch environment and console carry no token or session", async () => {
    const seen: string[] = [];
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const originals = methods.map((m) => console[m]);
    for (const m of methods) console[m] = (...args: unknown[]) => void seen.push(args.map(String).join(" "));
    try {
      await with_cli(spec.cli, async (env, open) => {
        const secrets = [env.cli_agent.token, env.agent.token, SESSION_SECRET];
        const a = owner_adapter(spec, env);
        const { text } = await exported(spec, env, a);
        const out = await a.import_result({ bundle_text: text, result_text: result_text(env) });
        const messages: string[] = [wire(out), text];
        for (const attempt of [
          a.import_result({ bundle_text: text, result_text: result_text(env) }),
          a.import_result({ bundle_text: "{ not json", result_text: "x" }),
          owner_adapter(spec, env, { owner_session: "synthetic-wrong-session" }).import_result({ bundle_text: text, result_text: result_text(env) }),
        ]) {
          await attempt.then(
            () => assert.fail("must be refused"),
            (error: any) => void messages.push(String(error.message), String(error.stack ?? ""), wire(error.details ?? null)),
          );
        }
        const client = open(await env.cli_client());
        await client.ok("pes_claim", { idempotency_key: "l-claim" });
        await client.tool("pes_submit", { results: [{ op: "append_version", object_id: "no-such-object", title: "x" }], idempotency_key: "l-bad" });
        messages.push(...client.lines);
        messages.push(wire(spec.cli.entry({ command: process.execPath, server_script: SERVER_SCRIPT, project_id: env.p.project_id, api_base_url: API_BASE_URL })));
        const store = new FakeKeyStore();
        await store.put(`pes-agent-token-${spec.runtime}-${env.p.project_id}`, env.cli_agent.token);
        messages.push(wire(await spec.cli.launch_env({ key_store: store, project_id: env.p.project_id }).then((o) => Object.keys(o))));
        try {
          await spec.cli.launch_env({ key_store: new FakeKeyStore(), project_id: env.p.project_id });
        } catch (error: any) {
          messages.push(String(error.message), String(error.stack ?? ""));
        }
        for (const secret of secrets) {
          for (const message of [...messages, ...seen]) assert.ok(!message.includes(secret), "a secret reached a message, log or result");
        }
      });
    } finally {
      methods.forEach((m, i) => (console[m] = originals[i]!));
    }
  });

  t("no interference: the terminal sibling and this app take turns on the one project lease; a refused claim writes nothing", async () => {
    await with_cli(spec.cli, async (env, open) => {
      const sibling_agent = await make_agent(env, "sibling");
      const sibling = open(
        new FakeMcpClient(
          new McpServer({
            api: env.app,
            project_id: env.p.project_id,
            token: sibling_agent.token,
            claim_defaults: { runtime: spec.sibling.runtime, provider: spec.sibling.provider, model: "unknown" },
          }),
        ),
      );
      await sibling.initialize();
      const app = open(await env.cli_client());

      const held_by_app = await app.ok("pes_claim", { idempotency_key: "i-app-1" });
      const sig = state_signature(env.db);
      await sibling.fails("pes_claim", { idempotency_key: "i-sib-1" }, "conflict");
      assert.equal(state_signature(env.db), sig, "the refused sibling claim wrote nothing");
      assert.equal(env.db.get<{ status: string }>("SELECT status FROM runs WHERE id = ?", held_by_app.run_id)?.status, "running");
      await app.ok("pes_complete", { status: "succeeded", idempotency_key: "i-app-done" });

      const held_by_sibling = await sibling.ok("pes_claim", { idempotency_key: "i-sib-2" });
      const mid = state_signature(env.db);
      await app.fails("pes_claim", { idempotency_key: "i-app-2" }, "conflict");
      assert.equal(state_signature(env.db), mid, "the refused app claim wrote nothing");
      await sibling.ok("pes_complete", { status: "succeeded", idempotency_key: "i-sib-done" });

      const rows = env.db.all<{ id: string; runtime: string; provider: string }>("SELECT id, runtime, provider FROM runs ORDER BY rowid");
      assert.deepEqual(
        rows.map((r) => [r.id, r.runtime, r.provider]),
        [
          [held_by_app.run_id, spec.runtime, spec.provider],
          [held_by_sibling.run_id, spec.sibling.runtime, spec.sibling.provider],
        ],
        "each run keeps its own runtime label",
      );
    });
  });

  t("the built-in runner (mode A) is left alone by a hand-off import: its run row and every A-side table stay as they were", async () => {
    await with_cli(spec.cli, async (env) => {
      const builtin = await make_agent(env, "pes-builtin", ALL_AGENT_SCOPES, "internal_ai");
      const claimed = assert_ok(
        await call(env, {
          method: "POST",
          path: project_path(env, "/claims"),
          auth: { token: builtin.token },
          body: { mode: "A", runtime: "pes_builtin", provider: "opencode-go", model: GO_MODEL },
        }),
      );
      assert_ok(
        await call(env, {
          method: "POST",
          path: project_path(env, `/runs/${claimed.run_id}/complete`),
          auth: { token: builtin.token },
          body: { lease_id: claimed.lease_id, fence: claimed.fence, status: "succeeded" },
        }),
      );
      const a_row = a_run_row(env, claimed.run_id);
      const a_side = a_side_counts(env);
      const a = owner_adapter(spec, env);
      const { text } = await exported(spec, env, a);
      await a.import_result({ bundle_text: text, result_text: result_text(env) });
      assert.equal(a_run_row(env, claimed.run_id), a_row, "the A run is untouched");
      assert.deepEqual(a_side_counts(env), a_side, "no dispatch, usage, Go or connection row was written by the import");
      assert.equal(env.db.get<{ n: bigint }>("SELECT COUNT(*) AS n FROM runs WHERE mode = 'A'")?.n, 1n);
    });
  });

  t("token refs are per app and per project: the app reads only its own pes-agent-token-<runtime>-<project_id>", async () => {
    const project_id = "synthetic-project-id";
    const own = `pes-agent-token-${spec.runtime}-${project_id}`;
    const terminal = `pes-agent-token-${spec.sibling.runtime}-${project_id}`;
    assert.notEqual(own, terminal, "the app and the terminal tool have different refs");
    const store = new FakeKeyStore();
    await store.put(own, "synthetic-app-token-0001");
    await store.put(terminal, "synthetic-terminal-token-0002");
    await store.put(`pes-agent-token-${spec.runtime}-other-project`, "synthetic-other-project-token-0003");
    store.calls.length = 0;
    assert.deepEqual(await spec.cli.launch_env({ key_store: store, project_id }), { PES_AGENT_TOKEN: "synthetic-app-token-0001" });
    assert.deepEqual(store.calls, [["get", [own]]], "one read of its own ref; the terminal's token is never read");

    const only_terminal = new FakeKeyStore();
    await only_terminal.put(terminal, "synthetic-terminal-token-0002");
    only_terminal.calls.length = 0;
    await assert.rejects(spec.cli.launch_env({ key_store: only_terminal, project_id }), (error: any) => error.code === "token_missing");
    assert.deepEqual(only_terminal.calls, [["get", [own]]]);
  });

  t("when no token is there the message points to the explicit hand-off as the way that always works", async () => {
    await assert.rejects(spec.cli.launch_env({ key_store: new FakeKeyStore(), project_id: "synthetic-project-id" }), (error: any) => {
      assert.equal(error.code, "token_missing");
      assert.match(String(error.message), /명시적 전달/, "the way that is guaranteed is named");
      assert.match(String(error.message), /[가-힣]/);
      return true;
    });
  });

  t(`${spec.doc}: says that the explicit hand-off is the guaranteed path when the direct connection does not work`, () => {
    const text = readFileSync(join(REPO, "docs", "adapters", spec.doc), "utf8").replace(/\r\n/g, "\n");
    const paragraphs = text.split(/\n\s*\n/);
    assert.ok(
      paragraphs.some((p) => /명시적 전달/.test(p) && /보장/.test(p) && /직접 연결/.test(p)),
      "one paragraph ties 직접 연결, 명시적 전달 and 보장 together",
    );
    assert.match(text, /external_agent/, "the direct path actor");
    assert.match(text, /import/, "the hand-off marker via=import");
    assert.match(text, /사람|소유자/, "the hand-off actor is the human");
    assert.ok(text.includes(spec.runtime), `names ${spec.runtime}`);
    assert.ok(text.includes(spec.handoff_runtime), `names ${spec.handoff_runtime}`);
    assert.match(text, /export_bundle/);
    assert.match(text, /import_result/);
  });

  t(`${spec.doc}: sharing the tool's configuration with the terminal tool is 미확인 and is never promised`, () => {
    const text = readFileSync(join(REPO, "docs", "adapters", spec.doc), "utf8").replace(/\r\n/g, "\n");
    assert.match(text, /미확인/);
    assert.match(text, /시험 결과/, "the open point is stated as a test result");
    const sharing = text.split("\n").filter((line) => /공유/.test(line));
    assert.ok(sharing.length >= 1, "the note speaks about sharing at all");
    for (const line of sharing) {
      assert.match(line, /미확인|않|없|보장하지|아니|못/, `a sentence about sharing must not promise it: ${line}`);
    }
    assert.doesNotMatch(text, /(설정|config\.toml|opencode\.json)[^\n]{0,40}(공유됩니다|공유된다|같이 씁니다|함께 씁니다)/);
    assert.doesNotMatch(text, /sk-[A-Za-z0-9]{8,}/);
    assert.doesNotMatch(text, /\/Users\/|\/home\/[a-z]/, "no personal absolute path in a public note");
  });

  t("the adapter takes nothing from the built-in runner at run time, starts no process, reads no file", () => {
    const code = readFileSync(join(REPO, "scripts", "pes_core", "adapters", `${spec.module}.ts`), "utf8")
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");
    assert.doesNotMatch(code, /^\s*import\s+(?!type\b)[^;]*a_runtime/m, "only a type may come from the built-in runner");
    assert.doesNotMatch(code, /node:fs|node:child_process|node:os|writeFile|readFile|homedir|execFile|spawn\(|exec\(/);
    assert.doesNotMatch(code, /\.codex|\.config\/opencode|\.config[\\/]+opencode|\.claude|APPDATA|Application Support/);
    assert.doesNotMatch(code, /codex exec|opencode run/);
  });

  t("the config pieces stay in memory: building the entry and the launch environment under a HOME with the tools' own config planted changes nothing there", () => {
    const home = isolated_home("pes-sel55-home-");
    try {
      const plant: Array<[string, string]> = [
        [".codex/config.toml", '[mcp_servers.other]\ncommand = "synthetic"\n'],
        [".config/opencode/opencode.json", '{"mcp":{"servers":{}}}\n'],
        [".claude/settings.json", "{}\n"],
        ["Library/Application Support/Codex/state.json", "{}\n"],
        ["AppData/Roaming/OpenCode/config.json", "{}\n"],
      ];
      const root = home.env.HOME!;
      const old = new Date("2026-01-01T00:00:00Z");
      for (const [rel, content] of plant) {
        const file = join(root, ...rel.split("/"));
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, content, "utf8");
        utimesSync(file, old, old);
      }
      const before = stamps(root);
      const env = {
        ...home.env,
        HOME: root,
        USERPROFILE: root,
        APPDATA: join(root, "AppData", "Roaming"),
        LOCALAPPDATA: join(root, "AppData", "Local"),
        XDG_CONFIG_HOME: join(root, ".config"),
      };
      const run = spawnSync(process.execPath, [CHILD, spec.module], { env, encoding: "utf8", timeout: 60_000 });
      assert.equal(run.status, 0, `${run.stderr}`);
      const line = run.stdout.replace(/\r\n/g, "\n").trim().split("\n").at(-1) ?? "";
      const out = JSON.parse(line) as { entry: unknown; gets: string[]; launched_token_ok: boolean; keys: string[] };
      assert.equal(out.launched_token_ok, true);
      assert.deepEqual(out.keys, ["PES_AGENT_TOKEN"]);
      assert.deepEqual(out.gets, [`pes-agent-token-${spec.runtime}-synthetic-project-id`]);
      assert.deepEqual(
        out.entry,
        JSON.parse(wire(spec.cli.entry({ command: process.execPath, server_script: "/path/to/pes/scripts/pes_core/mcp_server.ts", project_id: "synthetic-project-id", api_base_url: API_BASE_URL }))),
        "the child builds the same entry as this process",
      );
      assert.ok(!run.stdout.includes("synthetic-token-not-real-child-0001"), "the token is not printed");
      assert.ok(!run.stderr.includes("synthetic-token-not-real-child-0001"));
      assert.deepEqual(stamps(root), before, "no file or folder of any tool configuration was created, read-and-rewritten or touched");
      for (const [rel, content] of plant) assert.equal(readFileSync(join(root, ...rel.split("/")), "utf8"), content);
      assert.ok(!existsSync(join(root, ".config", "opencode", "pes.json")));
    } finally {
      home.cleanup();
    }
  });
}
