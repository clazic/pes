// SEL-54 (보강 모드) shared hardening cases for the two method-B CLI adapters. The tester reads
// scripts/pes_core/adapters/{cli_common,codex_cli,opencode_tui}.ts and tries to break them with forged
// input. Nothing here starts codex or opencode or touches a tool config folder; every file is written
// under a temporary HOME.
//
// 해석 (보강, numbered on from 해석 27):
//  해석 28 api_base_url is stored VERBATIM in the tool's config, so it must already be the canonical loopback
//          origin: no userinfo (`user:pw@`), no query, no fragment, no path other than "/", no backslash, no
//          whitespace or control character, no leading/trailing space. Anything else is a TypeError and nothing
//          is built (the server's HttpApi would normalise such a string silently, hiding the difference).
//          Non-loopback hosts (remote names, 0.0.0.0, 127.0.0.2, localhost.evil.com, localhost., 127.0.0.1.evil.com,
//          a userinfo trick like http://127.0.0.1:8760@evil.com, https) stay refused.
//  해석 29 command, server_script, project_id and model carry no control character (\p{Cc}, U+2028/2029, NUL, CR, LF)
//          — they would break a hand-assembled config or smuggle a second variable. Spaces and quotes inside
//          command / server_script are data (Windows "C:\Program Files\..."), passed through unchanged.
//  해석 30 PES_RUNTIME of a run is the connection's, not the caller's: arguments of pes_claim never choose
//          runtime, provider, model or mode (a tool call is refused or the arguments are ignored; either way the
//          stored run keeps the entry's values). The ACTOR is the token's actor; the RUNTIME label is the entry's.
//  해석 31 The model label is a label, but a Go-route label would make PES look as if it metered Go. After Unicode
//          NFKC folding, removing format/zero-width characters and treating `-`, `_`, space and the Unicode
//          hyphens as one separator, a model that begins with provider `opencode go` is go_route_blocked; a model
//          with whitespace or a format/control character at all is refused (TypeError or go_route_blocked).
//  해석 32 OpenCode expands `{env:VAR}` and `{file:path}` in the whole config text. A field value that contains
//          `{env:` or `{file:` would pull a secret or a file into the config: the OpenCode entry refuses it
//          (TypeError) for command, server_script, project_id and model. (Codex expands nothing.)
//  해석 33 Doc examples are read strictly: no duplicate key (JSON/TOML), no comment-dependent meaning, the filled
//          block equals the entry function's output EXACTLY (no extra key), and no fenced block anywhere in the
//          notes assigns a literal value to PES_AGENT_TOKEN.

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { wire } from "./adapter_b_env.ts";
import { API_BASE_URL, make_cli_env, REPO, SERVER_SCRIPT, with_cli, type CliSpec } from "./adapter_b_cli_suite.ts";
import { assert_ok, call, project_path } from "./api_env.ts";
import { isolated_home } from "./isolated_home.ts";
import { json_duplicate_keys } from "./strict_config.ts";
import { state_signature } from "./state_signature.ts";

const BASE = { command: process.execPath, server_script: SERVER_SCRIPT, project_id: "synthetic-project-id", api_base_url: API_BASE_URL };

function refused(fn: () => unknown, label: string): void {
  assert.throws(fn, (error: any) => error instanceof Error, label);
}

export function define_cli_harden(spec: CliSpec): void {
  const t = (name: string, fn: () => Promise<void> | void) => test(`${spec.label} harden: ${name}`, fn);
  const build = (over: Record<string, unknown>) => spec.entry({ ...BASE, ...over } as any);

  t("api_base_url: remote hosts, loopback look-alikes and every non-loopback form are refused", () => {
    const bad = [
      "https://127.0.0.1:8760",
      "http://example.com:8760",
      "http://192.0.2.1:8760",
      "http://0.0.0.0:8760",
      "http://127.0.0.2:8760",
      "http://localhost.evil.com:8760",
      "http://localhost.:8760",
      "http://127.0.0.1.evil.com:8760",
      "http://127.0.0.1:8760@evil.com",
      "http://127.0.0.1@evil.com:8760",
      "http://evil.com#@127.0.0.1",
      "http://evil.com\\@127.0.0.1",
      "http://[::2]:8760",
      "http://[::ffff:8.8.8.8]:8760",
      "http://[fe80::1]:8760",
      "http://foo.localhost:8760",
      "http://127.0.0.1:99999",
      "ftp://127.0.0.1",
      "//127.0.0.1:8760",
      "127.0.0.1:8760",
      "file:///etc/passwd",
      "javascript:alert(1)",
    ];
    for (const url of bad) refused(() => build({ api_base_url: url }), url);
  });

  t("api_base_url: it is stored verbatim, so only the canonical origin is accepted (해석 28)", () => {
    for (const ok of ["http://127.0.0.1:8760", "http://127.0.0.1", "http://localhost:8760", "http://[::1]:8760"]) {
      const out = build({ api_base_url: ok });
      assert.equal(spec.env_of(out).PES_API_BASE_URL, ok, "kept exactly as given");
    }
    const bad = [
      "http://user:pw@127.0.0.1:8760",
      "http://:pw@127.0.0.1:8760",
      "http://127.0.0.1:8760?x=1",
      "http://127.0.0.1:8760#frag",
      "http://127.0.0.1:8760/a/b",
      "http://127.0.0.1:8760\\@evil.com",
      " http://127.0.0.1:8760",
      "http://127.0.0.1:8760 ",
      "http://127.0.0.1:8760\n",
      "http://127.0.0.1:8760\u0000",
      "http://127.0.0.1:8760\r\nX-Evil: 1",
    ];
    for (const url of bad) refused(() => build({ api_base_url: url }), JSON.stringify(url));
  });

  t("fields: control characters are refused, spaces and quotes in paths pass through unchanged (해석 29)", () => {
    for (const field of ["command", "server_script", "project_id", "model"] as const) {
      for (const bad of ["a\nb", "a\rb", "a\u0000b", "a\u2028b", "a\u2029b", "a\u007fb", "a\tb", "\n"]) {
        refused(() => build({ [field]: bad }), `${field}=${JSON.stringify(bad)}`);
      }
    }
    const spaced = String.raw`C:\Program Files\nodejs\node "x" 'y'; $(z).exe`;
    const out = build({ command: spaced, server_script: "/with space/mcp_server.ts" });
    assert.equal(JSON.stringify(out).includes(JSON.stringify(spaced).slice(1, -1)), true, "the command is data: unchanged and only JSON-quoted");
    // a value that is only whitespace or empty is not a field
    for (const field of ["command", "server_script", "project_id", "api_base_url"] as const) {
      for (const bad of ["", null, undefined, 0, {}, [], true]) refused(() => build({ [field]: bad }), `${field}=${String(bad)}`);
    }
    refused(() => spec.entry(null as any), "null input");
    refused(() => spec.entry(undefined as any), "undefined input");
    for (const model of ["", null, 0, {}, []]) refused(() => build({ model }), `model=${String(model)}`);
  });

  t("the entry never holds the token, an Authorization header or the session secret, whatever the inputs", () => {
    const out = wire(build({ project_id: "Bearer-lookalike", model: "Bearer" }));
    assert.doesNotMatch(out, /PES_AGENT_TOKEN"\s*:\s*"(?!\{env:PES_AGENT_TOKEN\})/);
    assert.ok(!/"PES_AGENT_TOKEN"\s*:\s*"[^{]/.test(out), "a token value would not start with {");
  });

  t("the launch environment: the token is in the return value only; refusals, store errors and logs never carry it", async () => {
    const token = "synthetic-token-not-real-9876543210";
    const project_id = "synthetic-project-id";
    const ref = `pes-agent-token-${spec.runtime}-${project_id}`;
    const seen: string[] = [];
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const originals = methods.map((m) => console[m]);
    for (const m of methods) console[m] = (...args: unknown[]) => void seen.push(args.map(String).join(" "));
    try {
      const good = { get: (r: string) => (r === ref ? token : null) };
      assert.deepEqual(await spec.launch_env({ key_store: good, project_id }), { PES_AGENT_TOKEN: token });
      // a sync store works the same as an async one
      assert.deepEqual(await spec.launch_env({ key_store: { get: async () => token } as any, project_id }), { PES_AGENT_TOKEN: token });
      // store answers that are not a usable token
      for (const answer of [null, undefined, "", 0, 1, {}, [], true, false, Symbol.for("x")]) {
        await assert.rejects(
          spec.launch_env({ key_store: { get: () => answer } as any, project_id }),
          (error: any) => {
            assert.equal(error.code, "token_missing", String(answer));
            assert.match(String(error.message), /[가-힣]/);
            assert.ok(!String(error.message).includes(token));
            assert.ok(!String(error.stack ?? "").includes(token));
            return true;
          },
        );
      }
      // a store that throws: the error is the store's, and it reaches the caller without the token being made up
      await assert.rejects(spec.launch_env({ key_store: { get: () => Promise.reject(new Error("store down")) } as any, project_id }), /store down/);
      // bad arguments
      for (const bad of [null, undefined, {}, { project_id }, { key_store: {}, project_id }, { key_store: null, project_id }, { key_store: good, project_id: "" }, { key_store: good, project_id: 3 }]) {
        await assert.rejects(spec.launch_env(bad as any), TypeError);
      }
      // the ref is the project's: another project's token is never read for this one
      const calls: string[] = [];
      await assert.rejects(spec.launch_env({ key_store: { get: (r: string) => (calls.push(r), null) } as any, project_id: "other-project" }));
      assert.deepEqual(calls, [`pes-agent-token-${spec.runtime}-other-project`]);
    } finally {
      methods.forEach((m, i) => (console[m] = originals[i] as any));
    }
    assert.ok(!seen.join("\n").includes(token), "nothing was logged with the token");
    // the entry and a whole round of the fake client never show it either
    const all: string[] = [wire(build({}))];
    await with_cli(spec, async (env, open) => {
      const client = open(await env.cli_client());
      await client.ok("pes_claim", { idempotency_key: "leak-claim" });
      await client.tool("pes_submit", { results: [{ op: "append_version", object_id: "no-such-object", title: "x" }], idempotency_key: "leak-bad" });
      await client.tool("pes_claim", { run_id: "no-such-run", idempotency_key: "leak-bad-2" });
      all.push(...client.lines);
      assert.ok(!all.join("\n").includes(env.cli_agent.token));
      assert.ok(!all.join("\n").includes("Bearer"));
    });
  });

  t("launch_env: a project_id outside the key store's ref alphabet or past 200 characters is field_invalid, with no key store call", async () => {
    // The real key store (scripts/pes_core/a_runtime/keystore.ts SAFE_REF) takes /^[A-Za-z0-9._:-]{1,200}$/ for the whole ref
    // "pes-agent-token-<runtime>-<project_id>". A colon is inside that alphabet (so it is accepted here), a space is not.
    const prefix = `pes-agent-token-${spec.runtime}-`;
    const make_store = () => {
      const calls: string[] = [];
      return { calls, store: { get: (ref: string) => (calls.push(ref), "synthetic-token-not-real-0123456789") } };
    };
    const outside = ["a b", " a", "a ", "a/b", "a\\b", "../x", "a\nb", "a\u0000b", "한글", "proj-한", "a@b", "a#b", "a%2fb", "a*b", "a?b", "a=b", "a,b", "a;b", "a\"b", "a'b", "a$b", "a`b", "😀", "é", "ａ", "a\u200bb"];
    for (const project_id of outside) {
      const { calls, store } = make_store();
      await assert.rejects(
        spec.launch_env({ key_store: store as any, project_id }),
        (error: any) => {
          assert.equal(error.code, "field_invalid", JSON.stringify(project_id));
          assert.ok(error instanceof TypeError);
          assert.match(String(error.message), /[가-힣]/, "the message is Korean");
          assert.ok(!String(error.message).includes("synthetic-token"));
          return true;
        },
        JSON.stringify(project_id),
      );
      assert.deepEqual(calls, [], `the key store is not called for ${JSON.stringify(project_id)}`);
    }

    // the length limit is on the whole ref: 200 characters pass, 201 do not
    const room = 200 - prefix.length;
    assert.ok(room > 100, "the limit leaves room for a real project id");
    for (const [length, ok] of [[1, true], [room - 1, true], [room, true], [room + 1, false], [room + 50, false], [5000, false]] as const) {
      const project_id = "a".repeat(length);
      const { calls, store } = make_store();
      if (ok) {
        assert.equal(`${prefix}${project_id}`.length <= 200, true);
        assert.deepEqual(await spec.launch_env({ key_store: store as any, project_id }), { PES_AGENT_TOKEN: "synthetic-token-not-real-0123456789" });
        assert.deepEqual(calls, [`${prefix}${project_id}`], `length ${length}: exactly one get with the exact ref`);
      } else {
        await assert.rejects(spec.launch_env({ key_store: store as any, project_id }), (error: any) => error.code === "field_invalid", `length ${length}`);
        assert.deepEqual(calls, [], `length ${length}: no key store call`);
      }
    }
    assert.equal(`${prefix}${"a".repeat(room)}`.length, 200, "the boundary case is exactly 200");

    // every allowed punctuation character is accepted and reaches the store unchanged
    for (const project_id of ["synthetic-project-id", "a.b_c-d", "a:b", "A0.9_z:Z-1", "0123456789abcdef-0123456789abcdef", "-", ".", "_", ":"]) {
      const { calls, store } = make_store();
      await spec.launch_env({ key_store: store as any, project_id });
      assert.deepEqual(calls, [`${prefix}${project_id}`]);
    }
  });

  t("the notes never put a token, a long secret or a person's path in any fenced block or line", () => {
    const text = readFileSync(join(REPO, "docs", "adapters", spec.doc), "utf8").replace(/\r\n/g, "\n");
    for (const m of text.matchAll(/PES_AGENT_TOKEN["']?\s*[:=]\s*["']([^"']*)["']/g)) {
      assert.match(m[1] ?? "", /^(\$\{PES_AGENT_TOKEN\}|\{env:PES_AGENT_TOKEN\})$/, "only a reference is ever assigned");
    }
    assert.doesNotMatch(text, /[A-Za-z0-9_-]{40,}/, "no long secret-looking string");
    assert.doesNotMatch(text, /\/Users\/[^\s/]+|C:\\Users\\|\/home\/[a-z][^\s/]*/);
    assert.doesNotMatch(text, /Bearer\s+[A-Za-z0-9]/);
  });

  t("a forged claim (runtime / provider / model / mode in the arguments) cannot change what the run records (해석 30)", async () => {
    await with_cli(spec, async (env, open) => {
      const client = open(await env.cli_client());
      const sig = state_signature(env.db);
      const out = await client.tool("pes_claim", {
        runtime: "claude_code",
        provider: "anthropic",
        model: "claude-opus-5-5",
        mode: "A",
        actor_id: "agent-claude-code",
        idempotency_key: "forge-1",
      });
      if (out.is_error) assert.equal(state_signature(env.db), sig, "a refused forged claim writes nothing");
      const rows = env.db.all<{ mode: string; runtime: string; provider: string; model: string; actor_id: string }>("SELECT mode, runtime, provider, model, actor_id FROM runs");
      for (const row of rows) {
        assert.deepEqual(
          { mode: row.mode, runtime: row.runtime, provider: row.provider, model: row.model, actor_id: row.actor_id },
          { mode: "B", runtime: spec.runtime, provider: spec.provider, model: "unknown", actor_id: env.cli_agent.actor_id },
        );
      }
      // the same for a resume, a heartbeat and a submit that carry the extra fields
      if (!out.is_error) {
        await client.tool("pes_heartbeat", { progress: { phase: "stage" }, runtime: "claude_code", idempotency_key: "forge-hb" });
        await client.tool("pes_complete", { status: "succeeded", runtime: "claude_code", model: "x", idempotency_key: "forge-done" });
      }
      for (const row of env.db.all<{ runtime: string; model: string }>("SELECT runtime, model FROM runs")) {
        assert.equal(row.runtime, spec.runtime);
        assert.equal(row.model, "unknown");
      }
    });
  });

  // SEL-68: an external_agent token must not start a built-in (mode A / Go) run over the API. This was a todo in PR20b
  // (the Go check ran only for internal_ai); it is now a required test. The wider matrix is in test_api_sel68_mode_a_claim.
  test(`${spec.label} harden: an external agent token cannot start a built-in (mode A / Go) run over the API`, async () => {
    await with_cli(spec, async (env) => {
      const sig = state_signature(env.db);
      for (const body of [
        { mode: "A", runtime: "pes_builtin", provider: "opencode-go", model: "opencode-go/deepseek-v4.1-flash" },
        { mode: "A", runtime: spec.runtime, provider: "opencode-go", model: "opencode-go/deepseek-v4.1-flash" },
      ]) {
        const res = await call(env, { method: "POST", path: project_path(env, "/claims"), auth: { token: env.cli_agent.token }, body });
        assert.ok(res.status >= 400, `an external_agent cannot take a mode A claim: ${res.status} ${wire(res.json)}`);
      }
      assert.equal(state_signature(env.db), sig, "nothing was written");
    });
  });

  t(`${spec.doc}: the config block is read strictly (no duplicate key, comments and CRLF harmless) and equals the entry exactly (해석 33)`, () => {
    const home = isolated_home("pes-sel54-strict-");
    try {
      const doc = readFileSync(join(REPO, "docs", "adapters", spec.doc), "utf8").replace(/\r\n/g, "\n");
      const re = new RegExp("^```" + spec.config_info.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&") + "\\n([\\s\\S]*?)\\n```[ \\t]*$", "gm");
      const blocks = [...doc.matchAll(re)].map((m) => m[1] ?? "");
      assert.equal(blocks.length, 1);
      const fill = (text: string) =>
        text
          .replace('"/path/to/node"', JSON.stringify(process.execPath))
          .replace('"/path/to/pes/scripts/pes_core/mcp_server.ts"', JSON.stringify(SERVER_SCRIPT))
          .replace("<프로젝트 id>", BASE.project_id);
      const filled = fill(blocks[0]!);
      if (spec.config_info.startsWith("json")) assert.deepEqual(json_duplicate_keys(filled), [], "no duplicate JSON key");
      const wanted = JSON.parse(JSON.stringify(spec.entry(BASE as any)));
      const read = (text: string) => JSON.parse(JSON.stringify(spec.parse_config(text)));
      assert.deepEqual(read(filled), wanted, "the example is exactly what the function builds: no extra key, no missing key");

      if (spec.config_info.startsWith("toml")) {
        // comments and CRLF are not meaning
        const noisy = `# top comment\r\n${filled.split("\n").map((line) => `${line} # trailing`).join("\r\n")}\r\n# end\r\n`.replace(/\[mcp_servers\.pes\] # trailing/, "[mcp_servers.pes] # trailing");
        const dir = join(home.root, "cfg");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, spec.config_file), noisy, "utf8");
        assert.deepEqual(read(readFileSync(join(dir, spec.config_file), "utf8")), wanted);
        // a duplicated key must not be silently merged
        assert.throws(() => spec.parse_config(filled.replace("command =", 'command = "x"\ncommand =')), /duplicate/);
        assert.throws(() => spec.parse_config(`${filled}\n[mcp_servers.pes]\ncommand = "x"\n`) && undefined, /./, "a repeated table header is not an addition");
      } else {
        assert.deepEqual(json_duplicate_keys('{"a":1,"a":2}'), ["//a"], "the detector itself works");
      }
      // every fenced config-like block in the note is consistent: the token is only a reference
      for (const m of doc.matchAll(/^```[^\n]*\n([\s\S]*?)\n```/gm)) {
        for (const a of (m[1] ?? "").matchAll(/PES_AGENT_TOKEN["']?\s*[:=]\s*["']([^"']*)["']/g)) {
          assert.match(a[1] ?? "", /^\{env:PES_AGENT_TOKEN\}$|^\$\{PES_AGENT_TOKEN\}$/);
        }
      }
    } finally {
      home.cleanup();
    }
  });

  t("two connections of this tool on one project: one claim wins, the other is a conflict, and both rounds finish cleanly", async () => {
    await with_cli(spec, async (env, open) => {
      const a = open(await env.cli_client());
      const b = open(await env.cli_client());
      const same_key = await Promise.all([a.tool("pes_claim", { idempotency_key: "twin" }), b.tool("pes_claim", { idempotency_key: "twin" })]);
      // the same key from two connections of the same agent is one request: same run, one run row
      assert.deepEqual(same_key.map((r) => r.is_error), [false, false]);
      assert.equal(same_key[0]!.data.run_id, same_key[1]!.data.run_id);
      assert.equal(env.db.get<{ n: bigint }>("SELECT COUNT(*) AS n FROM runs")?.n, 1n);
      assert.equal(env.db.get<{ n: bigint }>("SELECT COUNT(*) AS n FROM project_leases WHERE state = 'active'")?.n, 1n);
      await a.ok("pes_complete", { status: "succeeded", idempotency_key: "twin-done" });
      // different keys at once: exactly one wins
      const race = await Promise.all([a.tool("pes_claim", { idempotency_key: "race-a" }), b.tool("pes_claim", { idempotency_key: "race-b" })]);
      assert.equal(race.filter((r) => !r.is_error).length, 1, wire(race.map((r) => r.data)));
      const lost = race.find((r) => r.is_error)!;
      assert.equal(lost.data.error.code, "conflict");
      assert.equal(env.db.get<{ n: bigint }>("SELECT COUNT(*) AS n FROM project_leases WHERE state = 'active'")?.n, 1n);
      assert.equal(env.db.get<{ n: bigint }>("SELECT COUNT(*) AS n FROM runs WHERE status = 'running'")?.n, 1n);
      assert_ok(await call(env, { method: "GET", path: project_path(env, "/context"), auth: "owner" }));
    });
  });
}

export { make_cli_env };
