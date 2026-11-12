/**
 * SEL-93 U3a — 결정(decision) 명령: propose / adopt / supersede / revoke (tester, 작성 모드). 구현 전에는 명령이 없어 실패하는 것이 정상.
 *
 * 있던 것: DDL decisions(scope project|edition, originated_from_version_id)·decision_versions(state, decided_by,
 *   supersedes_decision_id, CHECK state='proposed' OR decided_by NOT NULL). 없던 것: 아래 네 명령.
 *
 * 정한 해석:
 *   decision.propose { statement, scope:'project'|'edition', rationale? }          사람 또는 에이전트(제안만)
 *       새 결정 객체+버전 1 state 'proposed', decided_by=null. scope 필수·두 값만. 현재 판에 둔다. 결과 { object_id, version_id, version_no:1, state:'proposed', scope }.
 *       **제안은 채택이 아니다**: proposed 버전은 decided_by 가 없고 adopted 로 보이지 않는다.
 *   decision.adopt { decision_id, base_version_id, rationale? }   **사람 소유자만**(에이전트 → forbidden). proposed 만 채택 가능.
 *       새 버전 state 'adopted', decided_by=부른 사람, statement 그대로. 결과 { decision_id, version_id, version_no, state:'adopted', decided_by }.
 *   decision.supersede { decision_id, base_version_id, statement, rationale (비어 있지 않음), scope? }   **사람만**. adopted 인 결정만 대체.
 *       ① 새 결정 객체(adopted, decided_by=사람, supersedes_decision_id=옛 결정 객체 id, scope 기본=옛 결정 scope)
 *       ② 옛 결정 객체에 새 버전 state 'superseded'(decided_by=사람, rationale 같이) — **옛 버전 행은 그대로(덮어쓰기 없음)**.
 *       결과 { decision_id(새), version_id, superseded_decision_id(옛), superseded_version_id }.
 *   decision.revoke { decision_id, base_version_id, rationale (비어 있지 않음) }   **사람만**. adopted 인 결정만 폐기.
 *       새 버전 state 'revoked'(decided_by=사람). 결과 { decision_id, version_id, version_no, state:'revoked' }.
 *   상태 전이표(decision_versions.state):
 *       proposed → adopted (adopt)            adopted → superseded (supersede, 새 결정과 함께)      adopted → revoked (revoke)
 *       그 밖은 conflict: adopted/superseded/revoked 를 다시 adopt 불가, proposed·superseded·revoked 를 supersede/revoke 불가.
 *       base_version_id 가 현재 버전이 아니면 rev_conflict. 모르는 결정은 not_found.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { COMMANDS } from "../scripts/pes_core/commands.ts";
import { with_env, type Env } from "./helpers/blob_env.ts";
import { state_signature } from "./helpers/state_signature.ts";
import { agent_of, agent_with_key, count, current_version, decision_scope, decision_versions, ok, refused } from "./helpers/sel93_env.ts";

const NAMES = ["decision.propose", "decision.adopt", "decision.supersede", "decision.revoke"];

async function adopted(env: Env, tag: string, scope = "edition", statement = "2판은 정책 대안 B를 중심으로 구성한다."): Promise<{ object_id: string; version_id: string }> {
  const p = await ok(env, env.ctx(`${tag}-p`), "decision.propose", { statement, scope, rationale: "합성 근거" });
  const a = await ok(env, env.ctx(`${tag}-a`), "decision.adopt", { decision_id: p.object_id, base_version_id: p.version_id });
  return { object_id: p.object_id, version_id: a.version_id };
}

test("all four decision commands are registered", () => {
  for (const name of NAMES) assert.ok(COMMANDS.has(name), `${name} is a registered command`);
});

test("propose: version 1 is proposed with no decider; scope is recorded; it is not an adoption", async () => {
  await with_env(async (env) => {
    for (const scope of ["project", "edition"]) {
      const out = await ok(env, env.ctx(`p-${scope}`), "decision.propose", { statement: `${scope} 범위 결정`, scope, rationale: "근거" });
      assert.equal(out.state, "proposed");
      assert.equal(out.scope, scope);
      assert.equal(out.version_no, 1);
      assert.equal(decision_scope(env.db, out.object_id), scope);
      const rows = decision_versions(env.db, out.object_id);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.state, "proposed");
      assert.equal(rows[0]!.decided_by, null, "a proposal has no decider");
      assert.equal(rows[0]!.supersedes_decision_id, null);
      assert.equal(rows[0]!.statement, `${scope} 범위 결정`);
      assert.equal(current_version(env.db, out.object_id), out.version_id);
    }
  });
});

test("an agent's proposal is only a proposal: attributed to the agent, never decided", async () => {
  await with_env(async (env) => {
    const agent = agent_of(env);
    const out = await ok(env, agent_with_key(agent, "ag-d"), "decision.propose", { statement: "AI 가 제안한 결정", scope: "edition" });
    const row = decision_versions(env.db, out.object_id)[0]!;
    assert.equal(row.state, "proposed");
    assert.equal(row.decided_by, null);
    assert.equal(row.actor_id, agent.actor_id);
  });
});

test("propose refuses blank statements, a missing/unknown scope and unknown fields; nothing is written", async () => {
  await with_env(async (env) => {
    const sig = state_signature(env.db);
    const bad: Array<Record<string, unknown>> = [
      { statement: "", scope: "edition" },
      { statement: "  ", scope: "edition" },
      { scope: "edition" },
      { statement: "결정" },
      { statement: "결정", scope: "global" },
      { statement: "결정", scope: 1 },
      { statement: "결정", scope: "edition", state: "adopted" },
      { statement: "결정", scope: "edition", decided_by: "someone" },
      { statement: "결정", scope: "edition", supersedes_decision_id: "x" },
    ];
    let n = 0;
    for (const payload of bad) await refused(env, env.ctx(`bad-${n++}`), "decision.propose", payload, "invalid_payload", "validation_failed");
    assert.equal(state_signature(env.db), sig);
  });
});

test("adopt: only a human, only a proposal; a new version records who decided; the proposal version is untouched", async () => {
  await with_env(async (env) => {
    const p = await ok(env, env.ctx("ad-p"), "decision.propose", { statement: "결정 문장", scope: "project" });
    const agent = agent_of(env);
    const sig = state_signature(env.db);
    await refused(env, agent_with_key(agent, "ad-ag"), "decision.adopt", { decision_id: p.object_id, base_version_id: p.version_id }, "forbidden");
    assert.equal(state_signature(env.db), sig, "an agent cannot adopt");
    const a = await ok(env, env.ctx("ad-h"), "decision.adopt", { decision_id: p.object_id, base_version_id: p.version_id, rationale: "채택 이유" });
    assert.equal(a.state, "adopted");
    assert.equal(a.decided_by, env.p.actor_id);
    const [v1, v2] = decision_versions(env.db, p.object_id);
    assert.equal(v1!.state, "proposed");
    assert.equal(v1!.decided_by, null, "the proposal version is not rewritten");
    assert.equal(v2!.version_id, a.version_id);
    assert.equal(v2!.state, "adopted");
    assert.equal(v2!.decided_by, env.p.actor_id);
    assert.equal(v2!.statement, "결정 문장");
    assert.equal(v2!.rationale, "채택 이유");
    assert.equal(v2!.version_no, 2);
    assert.equal(current_version(env.db, p.object_id), a.version_id);
    assert.equal(decision_scope(env.db, p.object_id), "project");
  });
});

test("adopt twice, or against a stale base, or an unknown decision, is refused", async () => {
  await with_env(async (env) => {
    const p = await ok(env, env.ctx("a2-p"), "decision.propose", { statement: "결정", scope: "edition" });
    const a = await ok(env, env.ctx("a2-a"), "decision.adopt", { decision_id: p.object_id, base_version_id: p.version_id });
    const sig = state_signature(env.db);
    await refused(env, env.ctx("a2-stale"), "decision.adopt", { decision_id: p.object_id, base_version_id: p.version_id }, "rev_conflict", "conflict");
    await refused(env, env.ctx("a2-again"), "decision.adopt", { decision_id: p.object_id, base_version_id: a.version_id }, "conflict");
    await refused(env, env.ctx("a2-none"), "decision.adopt", { decision_id: "no-such", base_version_id: a.version_id }, "not_found");
    assert.equal(state_signature(env.db), sig);
  });
});

test("supersede: a NEW decision with supersedes_decision_id; the old decision keeps every old version and gains a 'superseded' one", async () => {
  await with_env(async (env) => {
    const old = await adopted(env, "sp", "edition", "1판 결정");
    const before = decision_versions(env.db, old.object_id);
    const out = await ok(env, env.ctx("sp-do"), "decision.supersede", {
      decision_id: old.object_id,
      base_version_id: old.version_id,
      statement: "2판 결정(대체)",
      rationale: "검토 결과 대안 B 로 바꾼다",
    });
    assert.notEqual(out.decision_id, old.object_id, "the replacement is another decision object");
    assert.equal(out.superseded_decision_id, old.object_id);
    const fresh = decision_versions(env.db, out.decision_id);
    assert.equal(fresh.length, 1);
    assert.equal(fresh[0]!.state, "adopted");
    assert.equal(fresh[0]!.decided_by, env.p.actor_id);
    assert.equal(fresh[0]!.supersedes_decision_id, old.object_id);
    assert.equal(fresh[0]!.statement, "2판 결정(대체)");
    assert.equal(fresh[0]!.rationale, "검토 결과 대안 B 로 바꾼다");
    assert.equal(decision_scope(env.db, out.decision_id), "edition", "scope defaults to the old decision's scope");
    const after = decision_versions(env.db, old.object_id);
    assert.equal(after.length, before.length + 1);
    assert.deepEqual(after.slice(0, before.length), before, "no earlier version of the old decision changed");
    const last = after[after.length - 1]!;
    assert.equal(last.state, "superseded");
    assert.equal(last.version_id, out.superseded_version_id);
    assert.equal(last.statement, "1판 결정", "the old text is kept as it was");
    assert.equal(last.decided_by, env.p.actor_id);
    assert.equal(current_version(env.db, old.object_id), out.superseded_version_id);
    assert.equal(current_version(env.db, out.decision_id), out.version_id);
  });
});

test("supersede a chain: A ← B ← C keeps every link and exactly one live (adopted) decision", async () => {
  await with_env(async (env) => {
    const a = await adopted(env, "ch", "project", "결정 A");
    const b = await ok(env, env.ctx("ch-b"), "decision.supersede", { decision_id: a.object_id, base_version_id: a.version_id, statement: "결정 B", rationale: "B 로" });
    const c = await ok(env, env.ctx("ch-c"), "decision.supersede", { decision_id: b.decision_id, base_version_id: b.version_id, statement: "결정 C", rationale: "C 로" });
    assert.equal(decision_versions(env.db, b.decision_id)[0]!.supersedes_decision_id, a.object_id);
    assert.equal(decision_versions(env.db, c.decision_id)[0]!.supersedes_decision_id, b.decision_id);
    const live = env.db.all<{ object_id: string }>(
      `SELECT d.object_id FROM decisions d JOIN objects o ON o.id = d.object_id
         JOIN decision_versions v ON v.version_id = o.current_version_id WHERE v.state = 'adopted'`,
    );
    assert.deepEqual(live.map((r) => r.object_id), [c.decision_id]);
  });
});

test("supersede an explicit scope: a project decision can be replaced by an edition decision (scope is the new decision's own)", async () => {
  await with_env(async (env) => {
    const old = await adopted(env, "sc", "project");
    const out = await ok(env, env.ctx("sc-do"), "decision.supersede", {
      decision_id: old.object_id,
      base_version_id: old.version_id,
      statement: "이번 판에서만 다르게",
      rationale: "판 한정",
      scope: "edition",
    });
    assert.equal(decision_scope(env.db, out.decision_id), "edition");
    assert.equal(decision_scope(env.db, old.object_id), "project", "the old decision's scope is not rewritten");
  });
});

test("supersede/revoke need an adopted decision, a reason, a human and a current base; each refusal writes nothing", async () => {
  await with_env(async (env) => {
    const proposed = await ok(env, env.ctx("n-p"), "decision.propose", { statement: "제안만", scope: "edition" });
    const live = await adopted(env, "n-live");
    const agent = agent_of(env);
    const sig = state_signature(env.db);
    // not adopted yet
    await refused(env, env.ctx("n-sp1"), "decision.supersede", { decision_id: proposed.object_id, base_version_id: proposed.version_id, statement: "새", rationale: "이유" }, "conflict");
    await refused(env, env.ctx("n-rv1"), "decision.revoke", { decision_id: proposed.object_id, base_version_id: proposed.version_id, rationale: "이유" }, "conflict");
    // reason required
    await refused(env, env.ctx("n-sp2"), "decision.supersede", { decision_id: live.object_id, base_version_id: live.version_id, statement: "새" }, "invalid_payload", "validation_failed");
    await refused(env, env.ctx("n-sp3"), "decision.supersede", { decision_id: live.object_id, base_version_id: live.version_id, statement: "새", rationale: " " }, "invalid_payload", "validation_failed");
    await refused(env, env.ctx("n-sp4"), "decision.supersede", { decision_id: live.object_id, base_version_id: live.version_id, rationale: "이유" }, "invalid_payload", "validation_failed");
    await refused(env, env.ctx("n-rv2"), "decision.revoke", { decision_id: live.object_id, base_version_id: live.version_id }, "invalid_payload", "validation_failed");
    // humans only
    await refused(env, agent_with_key(agent, "n-sp5"), "decision.supersede", { decision_id: live.object_id, base_version_id: live.version_id, statement: "새", rationale: "이유" }, "forbidden");
    await refused(env, agent_with_key(agent, "n-rv3"), "decision.revoke", { decision_id: live.object_id, base_version_id: live.version_id, rationale: "이유" }, "forbidden");
    // stale base / unknown
    await refused(env, env.ctx("n-sp6"), "decision.supersede", { decision_id: live.object_id, base_version_id: "old-version", statement: "새", rationale: "이유" }, "rev_conflict", "conflict", "not_found");
    await refused(env, env.ctx("n-rv4"), "decision.revoke", { decision_id: "no-such", base_version_id: live.version_id, rationale: "이유" }, "not_found");
    assert.equal(state_signature(env.db), sig);
  });
});

test("revoke: a new 'revoked' version by the person with the reason; earlier versions stay; a revoked decision cannot be adopted, superseded or revoked again", async () => {
  await with_env(async (env) => {
    const live = await adopted(env, "rv");
    const before = decision_versions(env.db, live.object_id);
    const out = await ok(env, env.ctx("rv-do"), "decision.revoke", { decision_id: live.object_id, base_version_id: live.version_id, rationale: "전제가 무너졌다" });
    assert.equal(out.state, "revoked");
    const after = decision_versions(env.db, live.object_id);
    assert.deepEqual(after.slice(0, before.length), before);
    const last = after[after.length - 1]!;
    assert.equal(last.state, "revoked");
    assert.equal(last.rationale, "전제가 무너졌다");
    assert.equal(last.decided_by, env.p.actor_id);
    assert.equal(last.statement, before[before.length - 1]!.statement);
    assert.equal(current_version(env.db, live.object_id), out.version_id);
    const sig = state_signature(env.db);
    await refused(env, env.ctx("rv-again"), "decision.revoke", { decision_id: live.object_id, base_version_id: out.version_id, rationale: "또" }, "conflict");
    await refused(env, env.ctx("rv-adopt"), "decision.adopt", { decision_id: live.object_id, base_version_id: out.version_id }, "conflict");
    await refused(env, env.ctx("rv-sup"), "decision.supersede", { decision_id: live.object_id, base_version_id: out.version_id, statement: "새", rationale: "이유" }, "conflict");
    assert.equal(state_signature(env.db), sig);
  });
});

test("a superseded decision cannot be superseded or revoked a second time (the live one is the replacement)", async () => {
  await with_env(async (env) => {
    const old = await adopted(env, "ss");
    const out = await ok(env, env.ctx("ss-do"), "decision.supersede", { decision_id: old.object_id, base_version_id: old.version_id, statement: "새", rationale: "이유" });
    const sig = state_signature(env.db);
    await refused(env, env.ctx("ss-sup"), "decision.supersede", { decision_id: old.object_id, base_version_id: out.superseded_version_id, statement: "또 새", rationale: "이유" }, "conflict");
    await refused(env, env.ctx("ss-rev"), "decision.revoke", { decision_id: old.object_id, base_version_id: out.superseded_version_id, rationale: "이유" }, "conflict");
    assert.equal(state_signature(env.db), sig);
  });
});

test("idempotent replay: the same key writes once", async () => {
  await with_env(async (env) => {
    const a = await env.service.execute(env.ctx("i-p"), "decision.propose", { statement: "결정", scope: "edition" });
    const b = await env.service.execute(env.ctx("i-p"), "decision.propose", { statement: "결정", scope: "edition" });
    assert.equal(b.replayed, true);
    assert.deepEqual(b.result, a.result);
    assert.equal(count(env.db, "decisions"), 1);
    await refused(env, env.ctx("i-p"), "decision.propose", { statement: "다른 결정", scope: "edition" }, "idempotency_key_reuse", "conflict");
    assert.equal(count(env.db, "decisions"), 1);
  });
});

test("every decision command leaves a receipt whose action names it, and an event", async () => {
  await with_env(async (env) => {
    const live = await adopted(env, "rc");
    await ok(env, env.ctx("rc-sp"), "decision.supersede", { decision_id: live.object_id, base_version_id: live.version_id, statement: "새", rationale: "이유" });
    const actions = env.db
      .all<{ action: string }>("SELECT action FROM mutation_commits WHERE project_id = ? AND client_request_id LIKE 'rc-%' ORDER BY rowid", env.p.project_id)
      .map((r) => r.action);
    assert.equal(actions.length, 3);
    for (const action of actions) assert.match(action, /^decision\./);
    const events = env.db.all<{ type: string }>("SELECT type FROM events WHERE project_id = ? AND type LIKE 'decision.%'", env.p.project_id);
    assert.ok(events.length >= 3);
  });
});
