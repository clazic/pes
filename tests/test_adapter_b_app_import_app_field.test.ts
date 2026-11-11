/**
 * SEL-55 PR20c r1 권장 1 회귀 — the Codex/OpenCode app adapters put `app` on the import request themselves
 * (through ClaudeAppAdapter's protected handoff_app()). Without `app` PES would record the run as
 * `claude_app_handoff`. A fake api captures every request the adapter sends; the real ApiApp answers.
 * Synthetic only: in-memory ApiApp, no app is started.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { CodexAppAdapter } from "../scripts/pes_core/adapters/codex_app.ts";
import { OpencodeAppAdapter } from "../scripts/pes_core/adapters/opencode_app.ts";
import { with_cleanup } from "./helpers/adapter_b_flow.ts";
import { SESSION_SECRET } from "./helpers/api_env.ts";

const CASES = [
  { name: "codex", make: (o: any) => new CodexAppAdapter(o), app: "codex_app", runtime: "codex_app_handoff", provider: "openai" },
  { name: "opencode", make: (o: any) => new OpencodeAppAdapter(o), app: "opencode_app", runtime: "opencode_app_handoff", provider: "unknown" },
] as const;

/** the request body as an object, whether the adapter hands it over as an object or a JSON string */
const body_of = (request: { body: unknown }): any => (typeof request.body === "string" ? JSON.parse(request.body) : request.body);

for (const c of CASES) {
  test(`${c.name} app adapter: every import request carries the app, the run is ${c.runtime}, never claude_app_handoff`, async () => {
    await with_cleanup(async (env) => {
      const sent: Array<{ method: string; path: string; body: unknown }> = [];
      const api = {
        handle: (request: any) => {
          sent.push({ method: request.method, path: request.path, body: request.body });
          return env.app.handle(request) as any;
        },
      };
      const adapter = c.make({ api, project_id: env.p.project_id, owner_session: SESSION_SECRET });
      const { text } = await adapter.export_bundle({ stage_id: env.stage.plan, round_id: env.round_id });
      const done = await adapter.import_result({
        bundle_text: text,
        result_text: JSON.stringify({ results: [{ op: "append_version", object_id: env.object_id, title: "앱 필드" }] }),
      });
      const imports = sent.filter((s) => s.method === "POST" && s.body !== null && s.body !== undefined).map((s) => ({ s, body: body_of(s) })).filter((x) => x.body && "import" in x.body);
      assert.ok(imports.length >= 1, "the adapter sent an import request");
      for (const { s, body } of imports) {
        assert.equal(body.import.app, c.app, `${s.path}: the import request names the app`);
        assert.notEqual(body.import.app, "claude_app");
      }
      const row = env.db.get<{ runtime: string; provider: string }>("SELECT runtime, provider FROM runs WHERE id = ?", done.run_id)!;
      assert.equal(row.runtime, c.runtime);
      assert.equal(row.provider, c.provider);
      assert.equal(env.db.get<{ n: bigint }>("SELECT COUNT(*) AS n FROM runs WHERE runtime = 'claude_app_handoff'")?.n, 0n, "no claude_app_handoff run was recorded");
    });
  });
}
