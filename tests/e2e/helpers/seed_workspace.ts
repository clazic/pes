// Builds the synthetic workspace the Playwright smoke serves, then prints one JSON line:
//   { root, home, pes_home, slug }
// Run it with plain Node (`node tests/e2e/helpers/seed_workspace.ts`), not under Playwright's loader: it reuses the
// node:test harness (isolated HOME / USERPROFILE / PES_HOME, PES_DB_CORE=1 CLI, DB bootstrap). Everything is synthetic.
//
// What it makes (all through the DB path — the project folder has NO project.json):
//   - a start-question form `plan-start` (recommended, __other, show_if, required)
//   - plan round 1 with items, one of them hostile ("악성 항목": script / javascript: link / onerror image in summary and details)
//   - notes, a sealed plan snapshot, a plan report (+ eli5.json) and the final web report
//   - runs: one running, one waiting_human; dispatches: one sent (in flight), one unknown
import { writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { make_cli_env, SLUG } from "../../helpers/cli_write_env.ts";
import { plain_legacy, seed, write_json, write_legacy } from "../../helpers/cli_read_env.ts";
import { ASK_SPEC, step, write_spec } from "../../helpers/web_env.ts";

const HOSTILE =
  '[클릭](javascript:window.__pwned=1) **굵게** <script>window.__pwned=1</script> <img src=x onerror="window.__pwned=1"> <a href="javascript:window.__pwned=1">링크</a>';

// PES_E2E_V015=1: the same project as a v0.15 project.json project, no flag — only to check that the smoke's selectors
// and flows are valid against the behaviour that must stay the same. The real run never sets it.
const V015 = process.env.PES_E2E_V015 === "1";
const F = V015 ? undefined : "1";
const c = await make_cli_env();
if (V015) write_legacy(c.folder, plain_legacy(SLUG));
else unlinkSync(c.project_json);
step(c, F, ["ask", SLUG, write_spec(c, ASK_SPEC)]);
seed(c, F);
step(c, F, ["merge", SLUG, "plan", write_json(c, "hostile.json", [{ id: 9, kind: "topic", title: "악성 항목", summary: HOSTILE, details: HOSTILE, status: "done" }])]);
writeFileSync(join(c.folder, "..", ".pes-hub"), "1", "utf8"); // render 가 홈 허브도 짓는다(pes hub 를 한 번 쓴 사용자)
step(c, F, ["render", SLUG, "plan"]);
step(c, F, ["round-start", SLUG, "plan"]);
step(c, F, ["merge", SLUG, "plan", write_json(c, "r2.json", [{ id: 2, kind: "topic", title: "합성 기획 항목 둘", summary: "합성 요약 둘 (보강)", status: "done" }])]);
step(c, F, ["render", SLUG, "plan"]);
mkdirSync(join(c.folder, "reports", "plan"), { recursive: true });
writeFileSync(
  join(c.folder, "reports", "plan", "eli5.json"),
  JSON.stringify({ title: "합성 그림 설명", lead: "합성 한 줄", scenes: [{ step: "그림 1", big: "합성 장면", emoji: "🔍", say: "합성 말" }], takeaway: "합성 끝" }),
  "utf8",
);
step(c, F, ["report", SLUG, "plan"]);
step(c, F, ["web", SLUG, "--assemble"]);

const { db, p } = c.env;
if (V015) {
  db.close();
  console.log(JSON.stringify({ root: c.env.home.root, home: c.env.home.env.HOME, pes_home: c.env.home.env.PES_HOME, slug: SLUG, dispatches: false }));
  process.exit(0);
}
const stage_id = c.stages.plan;
for (const [id, status] of [["run-running", "running"], ["run-waiting", "waiting_human"]] as const) {
  db.run(
    `INSERT INTO runs (id, project_id, edition_id, stage_id, round_id, actor_id, mode, runtime, provider, model,
        status, base_control_rev, context_snapshot_id, started_at, ended_at)
     VALUES (?, ?, ?, ?, NULL, ?, 'B', 'synthetic-runtime', 'synthetic', 'synthetic-model', ?, 0, NULL, 1, NULL)`,
    id, p.project_id, p.edition_id, stage_id, p.actor_id, status,
  );
}
const policy = db.get<{ id: string }>("SELECT id FROM project_policy_versions WHERE project_id = ? ORDER BY rowid DESC LIMIT 1", p.project_id);
const blob = db.get<{ id: string }>("SELECT id FROM blobs ORDER BY rowid LIMIT 1");
if (policy !== undefined && blob !== undefined) {
  for (const [id, state] of [["disp-sent", "sent"], ["disp-unknown", "unknown"]] as const) {
    db.run(
      `INSERT INTO outbound_dispatches (id, project_id, run_id, provider, policy_version_id, manifest_blob_id, payload_hash, state, request_key,
          sent_at, unknown_at, unknown_reason)
       VALUES (?, ?, 'run-running', 'opencode-go', ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, p.project_id, policy.id, blob.id, "0".repeat(64), state, `rk-${id}`,
    state === "sent" ? 1n : null, state === "unknown" ? 1n : null, state === "unknown" ? "synthetic: response lost" : null,
    );
  }
}
db.close();
console.log(JSON.stringify({ root: c.env.home.root, home: c.env.home.env.HOME, pes_home: c.env.home.env.PES_HOME, slug: SLUG, dispatches: policy !== undefined && blob !== undefined }));
