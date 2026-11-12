/**
 * SEL-93 U3a — 가정(assumption) 명령: propose / assess (tester, 작성 모드). 구현 전에는 명령이 없어 실패하는 것이 정상.
 *
 * 있던 것(회귀 가드): DDL assumptions·assumption_versions(CHECK state='proposed' OR assessment_actor_id NOT NULL),
 *   objects.kind='assumption', GET workspace records.assumptions.count.
 * 없던 것(이 파일의 실패 시험): 아래 두 명령. 둘 다 COMMANDS 에 등록되고 receipt+event 를 남긴다(원칙 0).
 *
 * 정한 해석 (이슈 U3·docs/plan/stage-3.md 2.4·DDL 에서 뽑음):
 *   assumption.propose { statement, rationale?, target_object_id? }
 *       사람 또는 에이전트. 새 객체(kind assumption, 현재 판 edition)+버전 1: state 'proposed', needs_review=1, assessment_actor_id=null,
 *       assessed_at=null. assumptions.proposed_by_actor_id = 부른 행위자. 빈/공백 statement → invalid_payload, 알 수 없는 필드 → invalid_payload.
 *       결과 { object_id, version_id, version_no:1, state:'proposed', needs_review:true }.
 *   assumption.assess { assumption_id, base_version_id, state:'confirmed'|'rejected'|'revised', rationale?, statement? }
 *       **사람 소유자만**(에이전트 → forbidden). 항상 새 버전(원문을 덮어쓰지 않음, based_on_version_id=base_version_id).
 *       confirmed/rejected: statement 는 그대로 복사. revised: statement(새 문장)와 rationale(비어 있지 않은 근거) 필수.
 *       rejected 도 비어 있지 않은 rationale 필수(틀림은 이유를 남긴다). confirmed 의 rationale 은 선택.
 *       새 버전은 assessment_actor_id=부른 사람, assessed_at=now(ms), needs_review=0, 현재 버전이 된다.
 *       base_version_id 가 현재 버전이 아니면 rev_conflict. 'proposed' 로는 평가할 수 없다(invalid_payload).
 *       결과 { assumption_id, version_id, version_no, state, assessment_actor_id, assessed_at }.
 *   상태 전이표(assumption_versions.state): proposed → confirmed | rejected | revised (사람, 새 버전).
 *       confirmed|rejected|revised → 다시 평가(마음 바꿈)도 새 버전으로 가능(사람). 'proposed' 로 되돌리는 전이는 없다.
 *   AI 제안(proposed)과 사람 판단(confirmed/rejected/revised)은 같은 버전에서 섞이지 않는다: 사람 판단 버전만 assessment_actor_id 가 있다.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { COMMANDS } from "../scripts/pes_core/commands.ts";
import { with_env } from "./helpers/blob_env.ts";
import { state_signature } from "./helpers/state_signature.ts";
import { agent_of, agent_with_key, assumption_versions, count, current_version, ok, refused } from "./helpers/sel93_env.ts";

test("both assumption commands are registered", () => {
  for (const name of ["assumption.propose", "assumption.assess"]) {
    assert.ok(COMMANDS.has(name), `${name} is a registered command`);
  }
});

test("a person proposes an assumption: version 1 is proposed, unassessed, needs review, edition-scoped", async () => {
  await with_env(async (env) => {
    const out = await ok(env, env.ctx("a1"), "assumption.propose", { statement: "정책 대상은 광역시 거주자로 한정한다.", rationale: "합성 배경 범위" });
    assert.equal(out.version_no, 1);
    assert.equal(out.state, "proposed");
    assert.equal(out.needs_review, true);
    const rows = assumption_versions(env.db, out.object_id);
    assert.equal(rows.length, 1);
    const [v1] = rows;
    assert.equal(v1!.version_id, out.version_id);
    assert.equal(v1!.state, "proposed");
    assert.equal(v1!.statement, "정책 대상은 광역시 거주자로 한정한다.");
    assert.equal(v1!.rationale, "합성 배경 범위");
    assert.equal(v1!.needs_review, 1);
    assert.equal(v1!.assessment_actor_id, null);
    assert.equal(v1!.assessed_at, null);
    assert.equal(current_version(env.db, out.object_id), out.version_id);
    const obj = env.db.get<{ kind: string; edition_id: string }>("SELECT kind, edition_id FROM objects WHERE id = ?", out.object_id);
    assert.equal(obj?.kind, "assumption");
    assert.equal(obj?.edition_id, env.p.edition_id);
    assert.equal(env.db.get<{ p: string }>("SELECT proposed_by_actor_id AS p FROM assumptions WHERE object_id = ?", out.object_id)?.p, env.p.actor_id);
  });
});

test("an agent can propose, but its proposal is attributed to the agent and stays unassessed", async () => {
  await with_env(async (env) => {
    const agent = agent_of(env);
    const out = await ok(env, agent_with_key(agent, "ag-prop"), "assumption.propose", { statement: "AI 가 깔고 있는 가정 하나" });
    const row = assumption_versions(env.db, out.object_id)[0]!;
    assert.equal(row.state, "proposed");
    assert.equal(row.actor_id, agent.actor_id);
    assert.equal(row.assessment_actor_id, null);
    assert.equal(env.db.get<{ p: string }>("SELECT proposed_by_actor_id AS p FROM assumptions WHERE object_id = ?", out.object_id)?.p, agent.actor_id);
  });
});

test("propose refuses blank/unknown input and writes nothing", async () => {
  await with_env(async (env) => {
    const sig = state_signature(env.db);
    await refused(env, env.ctx("p-empty"), "assumption.propose", { statement: "" }, "invalid_payload", "validation_failed");
    await refused(env, env.ctx("p-blank"), "assumption.propose", { statement: "   \n" }, "invalid_payload", "validation_failed");
    await refused(env, env.ctx("p-missing"), "assumption.propose", {}, "invalid_payload", "validation_failed");
    await refused(env, env.ctx("p-num"), "assumption.propose", { statement: 3 }, "invalid_payload", "validation_failed");
    await refused(env, env.ctx("p-extra"), "assumption.propose", { statement: "가정", state: "confirmed" }, "invalid_payload");
    await refused(env, env.ctx("p-huge"), "assumption.propose", { statement: "가".repeat(200_000) }, "invalid_payload", "validation_failed");
    assert.equal(state_signature(env.db), sig, "a refusal leaves no row, receipt or event");
  });
});

test("propose with a target object that does not exist is not_found", async () => {
  await with_env(async (env) => {
    const sig = state_signature(env.db);
    await refused(env, env.ctx("p-target"), "assumption.propose", { statement: "가정", target_object_id: "no-such-object" }, "not_found");
    assert.equal(state_signature(env.db), sig);
  });
});

test("assess confirmed: a NEW version by the person, the AI's proposal stays as it was", async () => {
  await with_env(async (env) => {
    const p = await ok(env, env.ctx("c-p"), "assumption.propose", { statement: "표본은 성인이다." });
    env.clock.advance(5_000);
    const a = await ok(env, env.ctx("c-a"), "assumption.assess", { assumption_id: p.object_id, base_version_id: p.version_id, state: "confirmed" });
    assert.equal(a.state, "confirmed");
    assert.equal(a.version_no, 2);
    assert.equal(a.assessment_actor_id, env.p.actor_id);
    const [v1, v2] = assumption_versions(env.db, p.object_id);
    assert.equal(v1!.state, "proposed", "version 1 is not rewritten");
    assert.equal(v1!.needs_review, 1);
    assert.equal(v1!.assessment_actor_id, null);
    assert.equal(v2!.version_id, a.version_id);
    assert.equal(v2!.state, "confirmed");
    assert.equal(v2!.statement, "표본은 성인이다.");
    assert.equal(v2!.assessment_actor_id, env.p.actor_id);
    assert.equal(v2!.needs_review, 0);
    assert.equal(typeof v2!.assessed_at, "number");
    assert.ok(v2!.assessed_at! > 0);
    assert.equal(v2!.based_on_version_id, p.version_id);
    assert.equal(current_version(env.db, p.object_id), a.version_id);
  });
});

test("assess rejected needs a reason; with one it records state, judge, time and reason", async () => {
  await with_env(async (env) => {
    const p = await ok(env, env.ctx("r-p"), "assumption.propose", { statement: "응답자는 모두 수도권 거주자다." });
    const sig = state_signature(env.db);
    await refused(env, env.ctx("r-none"), "assumption.assess", { assumption_id: p.object_id, base_version_id: p.version_id, state: "rejected" }, "invalid_payload", "validation_failed");
    await refused(env, env.ctx("r-blank"), "assumption.assess", { assumption_id: p.object_id, base_version_id: p.version_id, state: "rejected", rationale: "  " }, "invalid_payload", "validation_failed");
    assert.equal(state_signature(env.db), sig);
    const a = await ok(env, env.ctx("r-ok"), "assumption.assess", { assumption_id: p.object_id, base_version_id: p.version_id, state: "rejected", rationale: "비수도권 응답이 40% 이다." });
    const v2 = assumption_versions(env.db, p.object_id)[1]!;
    assert.equal(a.state, "rejected");
    assert.equal(v2.state, "rejected");
    assert.equal(v2.rationale, "비수도권 응답이 40% 이다.");
    assert.equal(v2.assessment_actor_id, env.p.actor_id);
    assert.equal(v2.needs_review, 0);
  });
});

test("assess revised is a new version with the person's new statement, judge and reason; the original text is preserved", async () => {
  await with_env(async (env) => {
    const p = await ok(env, env.ctx("v-p"), "assumption.propose", { statement: "대상은 전국 거주자다." });
    const sig = state_signature(env.db);
    await refused(env, env.ctx("v-nostmt"), "assumption.assess", { assumption_id: p.object_id, base_version_id: p.version_id, state: "revised", rationale: "범위를 좁힌다" }, "invalid_payload", "validation_failed");
    await refused(env, env.ctx("v-norat"), "assumption.assess", { assumption_id: p.object_id, base_version_id: p.version_id, state: "revised", statement: "대상은 광역시 거주자다." }, "invalid_payload", "validation_failed");
    assert.equal(state_signature(env.db), sig);
    const a = await ok(env, env.ctx("v-ok"), "assumption.assess", {
      assumption_id: p.object_id,
      base_version_id: p.version_id,
      state: "revised",
      statement: "대상은 광역시 거주자다.",
      rationale: "자료가 광역시만 다룬다.",
    });
    const [v1, v2] = assumption_versions(env.db, p.object_id);
    assert.equal(v1!.statement, "대상은 전국 거주자다.", "the AI's original text is not overwritten");
    assert.equal(v1!.state, "proposed");
    assert.equal(v2!.version_id, a.version_id);
    assert.equal(v2!.state, "revised");
    assert.equal(v2!.statement, "대상은 광역시 거주자다.");
    assert.equal(v2!.rationale, "자료가 광역시만 다룬다.");
    assert.equal(v2!.assessment_actor_id, env.p.actor_id);
    assert.equal(v2!.needs_review, 0);
    assert.equal(v2!.version_no, 2);
    assert.equal(current_version(env.db, p.object_id), a.version_id);
  });
});

test("only a human owner assesses: an agent is forbidden and nothing is written", async () => {
  await with_env(async (env) => {
    const p = await ok(env, env.ctx("h-p"), "assumption.propose", { statement: "가정" });
    const agent = agent_of(env);
    const sig = state_signature(env.db);
    for (const state of ["confirmed", "rejected", "revised"]) {
      await refused(
        env,
        agent_with_key(agent, `h-${state}`),
        "assumption.assess",
        { assumption_id: p.object_id, base_version_id: p.version_id, state, rationale: "이유", statement: "고친 문장" },
        "forbidden",
      );
    }
    assert.equal(state_signature(env.db), sig);
    assert.equal(assumption_versions(env.db, p.object_id).length, 1);
  });
});

test("assess against a stale base version is rev_conflict; an unknown assumption is not_found; 'proposed' is not an assessment", async () => {
  await with_env(async (env) => {
    const p = await ok(env, env.ctx("s-p"), "assumption.propose", { statement: "가정" });
    await ok(env, env.ctx("s-a"), "assumption.assess", { assumption_id: p.object_id, base_version_id: p.version_id, state: "confirmed" });
    const sig = state_signature(env.db);
    await refused(env, env.ctx("s-stale"), "assumption.assess", { assumption_id: p.object_id, base_version_id: p.version_id, state: "rejected", rationale: "이유" }, "rev_conflict");
    await refused(env, env.ctx("s-unknown"), "assumption.assess", { assumption_id: "no-such", base_version_id: p.version_id, state: "confirmed" }, "not_found");
    const cur = current_version(env.db, p.object_id)!;
    await refused(env, env.ctx("s-proposed"), "assumption.assess", { assumption_id: p.object_id, base_version_id: cur, state: "proposed" }, "invalid_payload", "validation_failed");
    await refused(env, env.ctx("s-bad"), "assumption.assess", { assumption_id: p.object_id, base_version_id: cur, state: "maybe" }, "invalid_payload", "validation_failed");
    assert.equal(state_signature(env.db), sig);
  });
});

test("the person can change their mind: a later assessment is another new version, history is kept", async () => {
  await with_env(async (env) => {
    const p = await ok(env, env.ctx("m-p"), "assumption.propose", { statement: "가정" });
    const a = await ok(env, env.ctx("m-a"), "assumption.assess", { assumption_id: p.object_id, base_version_id: p.version_id, state: "confirmed" });
    const b = await ok(env, env.ctx("m-b"), "assumption.assess", { assumption_id: p.object_id, base_version_id: a.version_id, state: "rejected", rationale: "나중에 틀린 것으로 드러남" });
    assert.deepEqual(
      assumption_versions(env.db, p.object_id).map((r) => r.state),
      ["proposed", "confirmed", "rejected"],
    );
    assert.equal(current_version(env.db, p.object_id), b.version_id);
  });
});

test("a command replayed with the same key writes once; the same key with another payload is idempotency_key_reuse", async () => {
  await with_env(async (env) => {
    const first = await env.service.execute(env.ctx("idem-p"), "assumption.propose", { statement: "가정" });
    const again = await env.service.execute(env.ctx("idem-p"), "assumption.propose", { statement: "가정" });
    assert.equal(again.replayed, true);
    assert.deepEqual(again.result, first.result);
    assert.equal(count(env.db, "assumptions"), 1);
    await refused(env, env.ctx("idem-p"), "assumption.propose", { statement: "다른 가정" }, "idempotency_key_reuse", "conflict");
    assert.equal(count(env.db, "assumptions"), 1);
    const r = first.result as { object_id: string; version_id: string };
    const a1 = await env.service.execute(env.ctx("idem-a"), "assumption.assess", { assumption_id: r.object_id, base_version_id: r.version_id, state: "confirmed" });
    const a2 = await env.service.execute(env.ctx("idem-a"), "assumption.assess", { assumption_id: r.object_id, base_version_id: r.version_id, state: "confirmed" });
    assert.equal(a2.replayed, true);
    assert.deepEqual(a2.result, a1.result);
    assert.equal(assumption_versions(env.db, r.object_id).length, 2);
  });
});

test("each assumption command leaves a receipt and an event (no state without the one write path)", async () => {
  await with_env(async (env) => {
    const p = await ok(env, env.ctx("e-p"), "assumption.propose", { statement: "가정" });
    await ok(env, env.ctx("e-a"), "assumption.assess", { assumption_id: p.object_id, base_version_id: p.version_id, state: "confirmed" });
    const actions = env.db
      .all<{ action: string }>("SELECT action FROM mutation_commits WHERE project_id = ? AND client_request_id IN ('e-p','e-a') ORDER BY rowid", env.p.project_id)
      .map((r) => r.action);
    assert.equal(actions.length, 2);
    for (const action of actions) assert.match(action, /^assumption\./, `receipt action ${action}`);
    const events = env.db.all<{ type: string }>("SELECT type FROM events WHERE project_id = ? AND type LIKE 'assumption.%' ORDER BY rowid", env.p.project_id);
    assert.equal(events.length, 2, "one event per command");
  });
});

test("no new table: the migrations folder is unchanged", async () => {
  const { readdirSync } = await import("node:fs");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "pes_core", "migrations");
  assert.deepEqual(readdirSync(dir).sort(), ["001_initial.sql", "002_ai_connections.sql"]);
});
