/**
 * SEL-71 first review (r1), the core half: what the CLI-only options (`any_order`, `plan_asking`, `allow_blank`, `compat_approve`, `v015`)
 * and the legacy read model must NOT let other callers do. Everything is synthetic and in-process (no CLI child).
 *
 *   A. recommendation 2  `note_stage`: a project without a current stage still answers `not_found` to a plain `project.add_note`
 *                        (the exact payload the A runner sends) — the "stage: null" relaxation is the CLI's option only.
 *   B. recommendation 2  the HTTP API (and so MCP, which goes through it) refuses `any_order` / `plan_asking` / `allow_blank` /
 *                        `any_name` / `v015` in a body, one case each; the A runner's note tool ignores `allow_blank`.
 *   C. recommendation 3  the read model takes only the seven `set` fields (stage: summary·changes·carry_over·settings·review;
 *                        project: executive_summary·conclusion) from a `project_field` / `stage_field` review artifact; a forged
 *                        artifact naming any other field changes nothing that the dashboard or `status` shows.
 *   D. recommendation 4  the read model's round count and history cannot be shifted by names a client picks: an uploaded manifest called
 *                        `implicit-approval.json`, a reopen reason of `pes-cli:re-approve`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { run_tool, type ToolEnv } from "../scripts/pes_core/a_runtime/tools.ts";
import { add_note } from "../scripts/pes_core/records.ts";
import { add_artifact, create_object } from "../scripts/pes_core/content.ts";
import { reopen_stage, seal_round } from "../scripts/pes_core/editions.ts";
import { store_blob } from "../scripts/pes_core/files.ts";
import { build_project_view, IMPLICIT_MANIFEST, REAPPROVE_REASON } from "../scripts/pes_core/legacy_view.ts";
import { assert_error, assert_ok, call, project_path, with_api } from "./helpers/api_env.ts";
import { complete, reserve, type Env } from "./helpers/blob_env.ts";
import { approve, make_content, seal, stage_ids, start, with_env } from "./helpers/editions_env.ts";

// ---------------------------------------------------------------------------------------------------- helpers

/** The payload shape the A runner's note tools build (a_runtime/tools.ts): the text, and a stage key only when the run has a stage. */
const A_RUNNER_NOTE = { text: "[AI 제안: 가정]\n합성 가정" };

function without_current_stage(env: Env): void {
  env.db.run("UPDATE editions SET current_stage_id = NULL WHERE id = ?", env.p.edition_id);
  const row = env.db.get<{ current_stage_id: string | null }>("SELECT current_stage_id FROM editions WHERE id = ?", env.p.edition_id);
  assert.equal(row?.current_stage_id, null, "fixture: the edition has no current stage");
}

function tool_env(env: Env): ToolEnv {
  return {
    service: env.service,
    db: env.db,
    run: { project_id: env.p.project_id, actor_id: env.p.actor_id, run_id: "synthetic-run", lease_id: "synthetic-lease", fence: 0, stage_id: null, round_id: null },
    request_key: "r1-tool",
    save_retries: 0,
  };
}

function view(env: Env): any {
  return build_project_view(env.db, env.p.project_id, env.objects).project;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

// ---------------------------------------------------------------------------------------------------- A

test("A. note_stage: without a current stage a plain project.add_note is still not_found (as before SEL-71); with one it is recorded", async () => {
  await with_env(async (env) => {
    // control: the project has a current stage → the note is recorded on it
    const ok = await add_note(env.service, env.ctx("r1-note-ok"), A_RUNNER_NOTE);
    assert.equal((ok.result as { note_count: number }).note_count, 1);

    without_current_stage(env);
    const before = env.db.get<{ n: bigint }>("SELECT COUNT(*) AS n FROM objects WHERE project_id = ?", env.p.project_id);
    await assert.rejects(add_note(env.service, env.ctx("r1-note-nostage"), A_RUNNER_NOTE), (error: any) => error?.code === "not_found", "no current stage + no stage named = not_found, not a stage-less note");
    // naming a stage that does not exist is not_found too (it always was)
    await assert.rejects(add_note(env.service, env.ctx("r1-note-badstage"), { text: "x", stage: "nonsense" }), (error: any) => error?.code === "not_found" || error?.code === "invalid_payload");
    const after = env.db.get<{ n: bigint }>("SELECT COUNT(*) AS n FROM objects WHERE project_id = ?", env.p.project_id);
    assert.equal(after?.n, before?.n, "a refused note writes nothing");
  });
});

test("A. the A runner's note tools (assumption.propose, decision.propose, reflection.write, followup.propose) on a project without a current stage answer the not_found refusal and write nothing", async () => {
  await with_env(async (env) => {
    without_current_stage(env);
    const before = env.db.get<{ n: bigint }>("SELECT COUNT(*) AS n FROM objects WHERE project_id = ?", env.p.project_id)?.n;
    for (const name of ["assumption.propose", "decision.propose", "reflection.write", "followup.propose"]) {
      const out = await run_tool(tool_env(env), { id: `call-${name}`, name, args: { text: "합성 제안" } }, 0);
      assert.equal(out.result.is_error, true, `${name}: refused`);
      assert.match(out.result.content, /not_found/, `${name}: the old refusal`);
    }
    assert.equal(env.db.get<{ n: bigint }>("SELECT COUNT(*) AS n FROM objects WHERE project_id = ?", env.p.project_id)?.n, before, "nothing was written");
  });
});

// ---------------------------------------------------------------------------------------------------- B

test("B. the API refuses the CLI-only options in a body — one case each (any_order, plan_asking, any_name, allow_blank, v015) — and changes nothing", async () => {
  await with_api(async (env) => {
    const ids = stage_ids(env.db, env.p.edition_id);
    const json = (value: unknown): string => JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    const counts = () => json(env.db.all("SELECT 'rounds' AS t, COUNT(*) AS n FROM rounds UNION ALL SELECT 'projects', COUNT(*) FROM projects UNION ALL SELECT 'objects', COUNT(*) FROM objects"));
    const before = counts();
    const stage_before = json(env.db.get("SELECT status, current_round_id FROM stages WHERE id = ?", ids.research));
    const edition_before = json(env.db.get("SELECT current_stage_id FROM editions WHERE id = ?", env.p.edition_id));

    // round start: `any_order` would let a person start any stage (and make it the current one)
    const round = await call(env, { method: "POST", path: project_path(env, `/stages/${ids.research}/rounds`), auth: "owner", body: { any_order: true } });
    assert_error(round, 400, "invalid_payload");
    // project create / register: `plan_asking` and `any_name` belong to `pes init`
    for (const extra of [{ plan_asking: true }, { any_name: true }, { allow_blank: true }, { v015: true }]) {
      const create = await call(env, { method: "POST", path: "/api/v1/projects", auth: "owner", body: { slug: "synthetic-r1", topic: "합성", owner_display_name: "합성 소유자", ...extra } });
      assert_error(create, 400, "invalid_payload");
      const register = await call(env, { method: "POST", path: "/api/v1/projects/register", auth: "owner", body: { slug: "synthetic-r1", topic: "합성", owner_display_name: "합성 소유자", ...extra } });
      assert.ok(register.status >= 400 && register.status < 500, `register with ${Object.keys(extra)[0]} is refused (${register.status})`);
    }
    // a name `pes init` accepts (any_name) is a plain slug rule in the API: a path-like name is refused as before
    const named = await call(env, { method: "POST", path: "/api/v1/projects", auth: "owner", body: { slug: "../x", topic: "합성", owner_display_name: "합성 소유자" } });
    assert.ok(named.status >= 400 && named.status < 500, `a path-like slug is still refused (${named.status})`);

    assert.equal(counts(), before, "no project, round or object appeared");
    assert.equal(json(env.db.get("SELECT status, current_round_id FROM stages WHERE id = ?", ids.research)), stage_before, "the research stage did not move");
    assert.equal(json(env.db.get("SELECT current_stage_id FROM editions WHERE id = ?", env.p.edition_id)), edition_before, "the current stage did not move");
    assert_ok(await call(env, { method: "POST", path: project_path(env, `/stages/${ids.plan}/rounds`), auth: "owner", body: {} }), 201);
  });
});

test("B. the A runner's note tool ignores allow_blank: an empty text is still refused (the blank note is the CLI's v0.15 rule only)", async () => {
  await with_env(async (env) => {
    const before = env.db.get<{ n: bigint }>("SELECT COUNT(*) AS n FROM objects WHERE project_id = ?", env.p.project_id)?.n;
    for (const args of [{ text: "", allow_blank: true }, { text: "   ", allow_blank: true }, { allow_blank: true }]) {
      const out = await run_tool(tool_env(env), { id: "call-blank", name: "assumption.propose", args }, 0);
      assert.equal(out.result.is_error, true, JSON.stringify(args));
      assert.match(out.result.content, /text must be a non-empty string/);
    }
    assert.equal(env.db.get<{ n: bigint }>("SELECT COUNT(*) AS n FROM objects WHERE project_id = ?", env.p.project_id)?.n, before, "nothing was written");
  });
});

// ---------------------------------------------------------------------------------------------------- C

async function forged_review(env: Env, key: string, stage_key: string | null, metadata: Record<string, unknown>): Promise<void> {
  const stages = stage_ids(env.db, env.p.edition_id);
  const created = await create_object(env.service, env.ctx(`${key}-o`), { kind: "artifact", edition_id: env.p.edition_id });
  await add_artifact(env.service, env.ctx(`${key}-a`), {
    object_id: (created.result as { object_id: string }).object_id,
    artifact_kind: "review",
    ...(stage_key === null ? {} : { stage_id: (stages as Record<string, string>)[stage_key] }),
    title: "(위조)",
    status: "done",
    metadata,
  });
}

test("C. read model: a project_field / stage_field review artifact naming a field outside the seven `set` fields changes nothing that is shown (one fresh project per forged field)", async () => {
  const project_forgeries: Array<[string, unknown]> = [
    ["current", "publish"], ["stages", {}], ["topic", "위조된 주제"], ["slug", "forged"], ["created", "1999-01-01"], ["complete", true],
    ["processed", ["a.json"]], ["notes", [{ time: "x", stage: "plan", text: "위조 메모" }]], ["library", { items: [] }], ["settings", { forged: true }],
    ["pes", 2], ["__proto__", { polluted: true }], ["constructor", "x"],
  ];
  const stage_forgeries: Array<[string, unknown]> = [
    ["status", "approved"], ["round", 9], ["items", [{ id: 1, title: "위조 항목" }]], ["history", ["승인 위조"]], ["approved_at", "2000-01-01"],
    ["stale", true], ["reports", ["위조.md"]], ["suggestions", ["위조"]], ["warnings", ["위조"]], ["id", "x"], ["qa", [{ x: 1 }]], ["review_log", [{ x: 1 }]],
  ];
  const cases: Array<[string | null, string, unknown]> = [
    ...project_forgeries.map(([f, v]) => [null, f, v] as [string | null, string, unknown]),
    ...["plan", "research", "publish"].flatMap((stage) => stage_forgeries.map(([f, v]) => [stage, f, v] as [string | null, string, unknown])),
  ];
  for (const [stage_key, field, value] of cases) {
    await with_env(async (env) => {
      const before = clone(view(env));
      await forged_review(env, "r1-forge", stage_key, { role: stage_key === null ? "project_field" : "stage_field", field, value, stage: stage_key });
      let after: unknown;
      try {
        after = view(env);
      } catch (error) {
        assert.fail(`${stage_key ?? "project"}.${field}: the read model must not fail on a forged field (${String(error)})`);
      }
      assert.deepEqual(after, before, `${stage_key ?? "project"}.${field}: a forged artifact left the read model as it was`);
      assert.equal(({} as any).polluted, undefined, "no prototype pollution");
    });
  }
});

test("C. read model control: the seven real fields still show (stage summary·changes·carry_over·settings·review, project executive_summary·conclusion)", async () => {
  await with_env(async (env) => {
    let n = 0;
    const key = () => `r1-real-${(n += 1)}`;
    await forged_review(env, key(), null, { role: "project_field", field: "executive_summary", value: "합성 요약", stage: null });
    await forged_review(env, key(), null, { role: "project_field", field: "conclusion", value: "합성 결론", stage: null });
    await forged_review(env, key(), "research", { role: "stage_field", field: "summary", value: "단계 요약", stage: "research" });
    await forged_review(env, key(), "research", { role: "stage_field", field: "changes", value: ["바뀐 점"], stage: "research" });
    await forged_review(env, key(), "research", { role: "stage_field", field: "carry_over", value: [{ k: 1 }], stage: "research" });
    await forged_review(env, key(), "research", { role: "stage_field", field: "settings", value: { a: 1 }, stage: "research" });
    await forged_review(env, key(), "research", { role: "stage_field", field: "review", value: { r: 1 }, stage: "research" });
    const shown = view(env);
    assert.equal(shown.executive_summary, "합성 요약");
    assert.equal(shown.conclusion, "합성 결론");
    assert.equal(shown.stages.research.summary, "단계 요약");
    assert.deepEqual(shown.stages.research.changes, ["바뀐 점"]);
    assert.deepEqual(shown.stages.research.carry_over, [{ k: 1 }]);
    assert.deepEqual(shown.stages.research.settings, { a: 1 });
    assert.deepEqual(shown.stages.research.review, { r: 1 });
  });
});

// ---------------------------------------------------------------------------------------------------- D

test("D. read model: a manifest the client uploads under the name `implicit-approval.json` does not hide the round (round count and approval history stay)", async () => {
  await with_env(async (env) => {
    assert.equal(IMPLICIT_MANIFEST, "implicit-approval.json", "the name this test forges is the one the read model used to trust");
    const stages = stage_ids(env.db, env.p.edition_id);
    const round = await start(env, stages.plan, "r1-d-start");
    const content = await make_content(env, "r1-d");
    const versions = [{ object_id: content.object_id, version_id: content.version_id }];
    // the client picks the upload's original name
    const body = new TextEncoder().encode(JSON.stringify({ versions }));
    const reserved = await reserve(env, body, "r1-d-mf", { original_name: IMPLICIT_MANIFEST });
    await store_blob(env.store, env.p.project_id, reserved.blob_id, body);
    await complete(env, reserved.blob_id, "r1-d-mf-c");
    const sealed = await seal_round(env.service, env.ctx("r1-d-seal"), { round_id: round.round_id, manifest_blob_id: reserved.blob_id, versions });
    const snapshot_id = (sealed.result as { snapshot_id: string }).snapshot_id;
    await approve(env, stages.plan, snapshot_id, "r1-d-approve");

    const shown = view(env).stages.plan;
    assert.equal(shown.round, 1, "a round a person started is round 1, whatever the manifest was called");
    assert.equal(shown.history.filter((line: string) => line.startsWith("승인")).length, 1, "the approval is in the history");
  });
});

test("D. read model: a reopen whose reason is `pes-cli:re-approve` (client-chosen text) still shows in the history as a reopen, like any other reason", async () => {
  await with_env(async (env) => {
    assert.equal(REAPPROVE_REASON, "pes-cli:re-approve");
    const stages = stage_ids(env.db, env.p.edition_id);
    const reopened = (line: string) => line.startsWith("다시 열기");
    // two stages, driven the same way; only the reopen reason differs
    const plan = [["plan", REAPPROVE_REASON], ["research", "사람이 다시 열기"]] as const;
    for (const [stage] of plan) {
      const round = await start(env, stages[stage], `r1-e-${stage}-start`);
      const content = await make_content(env, `r1-e-${stage}`);
      const versions = [{ object_id: content.object_id, version_id: content.version_id }];
      const sealed = (await seal(env, round.round_id, versions, `r1-e-${stage}-seal`)).result as { snapshot_id: string };
      await approve(env, stages[stage], sealed.snapshot_id, `r1-e-${stage}-approve`);
    }
    for (const [stage, reason] of plan) await reopen_stage(env.service, env.ctx(`r1-e-${stage}-reopen`), { stage_id: stages[stage], reason });
    const shown = view(env).stages;
    assert.equal(shown.research.history.filter(reopened).length, 1, "control: an ordinary reason is a visible reopen");
    assert.equal(shown.plan.history.filter(reopened).length, 1, "the same reopen with the client-chosen `pes-cli:re-approve` reason is visible too");
  });
});
