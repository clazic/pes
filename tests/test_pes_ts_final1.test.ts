/**
 * SEL-71 final review 1, recommendations 1 and 3. Everything is synthetic, isolated (temporary HOME / PES_HOME).
 *
 *   1. `pes.py chat <dir> <stage> ""` on the DB path (PES_DB_CORE=1) is refused as on main: the shared `cli_bridge` chat handler takes a
 *      blank answer only when the caller asks (`allow_blank`, which only scripts/pes.ts `chat` sends). Nothing is written.
 *   3. the core itself refuses `round.start { any_order }` and `project.bootstrap { plan_asking }` from any transport but the CLI
 *      (`via !== "cli"` → invalid_payload), like `implicit` — a second layer behind the API's fixed payloads. The CLI transport still works.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { start_round } from "../scripts/pes_core/editions.ts";
import type { MutationContext } from "../scripts/pes_core/commands.ts";
import { SLUG, with_cli } from "./helpers/cli_write_env.ts";
import { rejects_api, stage_ids, with_env } from "./helpers/editions_env.ts";

const OTHER_VIAS = ["http", "mcp", "webmcp", "web", "import"] as const;

// ---------------------------------------------------------------------------------------------------- 1

test("1. pes.py DB path: chat with an empty or blank answer is refused as on main (no allow_blank) and writes nothing", async () => {
  await with_cli((c) => {
    for (const text of ["", "   "]) {
      const before = c.commits().length;
      const out = c.run(["chat", SLUG, "plan", text]);
      assert.notEqual(out.status, 0, `chat ${JSON.stringify(text)}: refused (stdout: ${out.stdout})`);
      assert.doesNotMatch(out.stdout, /채팅 입력 기록/, "no answer recorded");
      assert.doesNotMatch(out.stderr, /Traceback/, "a refusal, not a crash");
      assert.equal(c.commits().length, before, "nothing was committed");
    }
    // control: a real answer on the same path is still recorded
    const ok = c.run(["chat", SLUG, "plan", "합성 채팅"]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /채팅 입력 기록/);
  });
});

// ---------------------------------------------------------------------------------------------------- 3

test("3. round.start { any_order } from a transport other than the CLI is invalid_payload and changes nothing; via cli it opens the round", async () => {
  await with_env(async (env) => {
    const ids = stage_ids(env.db, env.p.edition_id);
    const rounds = () => env.db.get<{ n: bigint }>("SELECT COUNT(*) AS n FROM rounds WHERE stage_id = ?", ids.research)?.n;
    const before = rounds();
    for (const via of OTHER_VIAS) {
      const ctx: MutationContext = { ...env.ctx(`final1-any-order-${via}`), via };
      await rejects_api(start_round(env.service, ctx, { stage_id: ids.research, any_order: true }), "invalid_payload");
    }
    assert.equal(rounds(), before, "no round was opened");
    // control: the CLI transport may lift the order (scripts/pes.ts round-start)
    await start_round(env.service, env.ctx("final1-any-order-cli"), { stage_id: ids.research, any_order: true });
    assert.equal(rounds(), (before ?? 0n) + 1n, "via cli the round is opened");
  });
});

test("3. project.bootstrap { plan_asking } from a transport other than the CLI is invalid_payload and makes no project; via cli the plan stage is asking", async () => {
  await with_env(async (env) => {
    const projects = () => env.db.get<{ n: bigint }>("SELECT COUNT(*) AS n FROM projects")?.n;
    const before = projects();
    const body = (slug: string) => ({ slug, topic: "합성 주제", owner_display_name: "합성 소유자", plan_asking: true });
    for (const via of OTHER_VIAS) {
      const ctx: MutationContext = { project_id: null, actor_id: null, via, client_request_id: `final1-plan-asking-${via}` };
      await rejects_api(env.service.execute(ctx, "project.bootstrap", body(`synthetic-final1-${via}`)), "invalid_payload");
    }
    assert.equal(projects(), before, "no project was made");
    // control: the CLI transport may ask for it (scripts/pes.ts init)
    const ctx: MutationContext = { project_id: null, actor_id: null, via: "cli", client_request_id: "final1-plan-asking-cli" };
    const out = await env.service.execute(ctx, "project.bootstrap", body("synthetic-final1-cli"));
    const project_id = (out.result as { project_id: string }).project_id;
    const plan = env.db.get<{ status: string }>("SELECT status FROM stages WHERE project_id = ? AND key = 'plan'", project_id);
    assert.equal(plan?.status, "asking");
  });
});
