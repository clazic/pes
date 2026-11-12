/**
 * SEL-93 U3a — 이전된 합성 프로젝트는 "기록 없음"으로 읽히고, 새 판으로 가정이 복사돼도 자동 확인되지 않는다 (tester, 작성 모드).
 *
 * 있던 것: 옛 프로젝트 가져오기·활성화(legacy.*)는 가정·결정·반영 객체를 만들지 않는다. GET workspace 의 records.empty. 이 파일의 첫 시험은 그 회귀 가드이기도 하다.
 * 없던 것: GET assumptions/decisions/reflections 가 이전된 프로젝트에서 200 + 빈 목록(지어낸 줄 없음), 새 판으로의 가정 복사 규칙.
 *
 * 정한 해석 (이 파일의 "새 판 복사"는 이슈에 방법이 적혀 있지 않아 정한 것 — 구현이 다르게 풀면 이 파일만 고친다):
 *   새 판 복사 = 기존 명령 edition.create { parent_edition_id } 가 부모 판의 **현재 가정**을 새 판으로 복사한다(새 객체, 새 판 소속).
 *     복사본의 현재 버전은 state 'proposed', needs_review=1, assessment_actor_id=null — 부모가 confirmed 였어도 자동으로 confirmed 가 아니다.
 *     부모의 가정 객체·버전은 하나도 바뀌지 않는다. 사람이 복사본을 assumption.assess 하면 그때 confirmed(needs_review=0).
 *   결정: scope 'project' 결정은 새 판으로 복사하지 않고 그대로 참조한다. scope 'edition' 결정은 새 판에 복사하되(새 객체, 새 판 소속)
 *     decisions.originated_from_version_id = 복사 당시 부모 결정의 현재 버전 id(당시 버전 고정). 부모 결정은 바뀌지 않는다.
 *   이전된 프로젝트: 가져오기→검증→활성화한 합성 옛 폴더("full")에서 GET assumptions/decisions → 200 빈 목록, GET reflections → submitted:false,
 *     가정·결정 개수 0 (이전된 의견이 있으면 records.empty 는 false). 이 읽기들은 DB 를 바꾸지 않는다(상태 서명 불변).
 */

import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { activate_import, validate_import } from "../scripts/pes_core/migration.ts";
import { assert_ok, call, with_api, type ApiEnv } from "./helpers/api_env.ts";
import { with_env } from "./helpers/blob_env.ts";
import { copy_fixture, legacy } from "./helpers/legacy_env.ts";
import { state_signature } from "./helpers/state_signature.ts";
import { assumption_versions, count, current_version, decision_scope, decision_versions, ok } from "./helpers/sel93_env.ts";

async function migrated_project(env: ApiEnv): Promise<string> {
  const api = await legacy();
  const dir = copy_fixture(env, "full");
  const imp = await api.import_project(env.service, dir, { owner_actor_id: env.p.actor_id });
  const val = await validate_import(env.service, imp.batch_id, { owner_actor_id: env.p.actor_id, source_dir: dir });
  assert.equal(val.ok, true, JSON.stringify(val.report.problems));
  const backup_dir = join(env.home.root, "sel93-backup");
  mkdirSync(backup_dir, { recursive: true });
  await activate_import(env.service, imp.batch_id, { owner_actor_id: env.p.actor_id, backup_dir, pes_home: env.home.env.PES_HOME as string });
  return imp.project_id;
}

test("a migrated synthetic project reads '기록 없음': empty lists, not submitted, records.empty, no invented rows, reads write nothing", async () => {
  await with_api(async (env) => {
    const id = await migrated_project(env);
    const sig = state_signature(env.db);
    const base = `/api/v1/projects/${id}`;
    const assumptions = assert_ok(await call(env, { method: "GET", path: `${base}/assumptions`, auth: "owner" }));
    assert.deepEqual(assumptions.assumptions, []);
    const decisions = assert_ok(await call(env, { method: "GET", path: `${base}/decisions`, auth: "owner" }));
    assert.deepEqual(decisions.decisions, []);
    const round = env.db.get<{ id: string }>("SELECT id FROM rounds WHERE project_id = ? ORDER BY rowid LIMIT 1", id);
    assert.ok(round, "the migrated project has a round");
    const refl = assert_ok(await call(env, { method: "GET", path: `${base}/reflections?round_id=${encodeURIComponent(round.id)}`, auth: "owner" }));
    assert.equal(refl.submitted, false, "nothing was submitted: '미제출', not '0건'");
    assert.deepEqual(refl.entries, []);
    const ws = assert_ok(await call(env, { method: "GET", path: `${base}/workspace`, auth: "owner" }));
    // "기록 없음" is about assumptions and decisions; migrated comments (messages) are counted apart and make records.empty false (SEL-90 tests)
    assert.equal(ws.records.assumptions.count, 0);
    assert.equal(ws.records.decisions.count, 0);
    assert.equal(state_signature(env.db), sig, "GET never writes");
    const own = env.db.all("SELECT 1 FROM objects WHERE project_id = ? AND kind IN ('assumption','decision')", id);
    assert.equal(own.length, 0, "migration made no assumption or decision");
  });
});

test("edition.create copies the parent's assumptions as unconfirmed, needs-review proposals; the parent's rows are untouched", async () => {
  await with_env(async (env) => {
    const confirmed = await ok(env, env.ctx("c-1"), "assumption.propose", { statement: "확인된 가정" });
    await ok(env, env.ctx("c-1a"), "assumption.assess", { assumption_id: confirmed.object_id, base_version_id: confirmed.version_id, state: "confirmed" });
    const revised = await ok(env, env.ctx("c-2"), "assumption.propose", { statement: "고칠 가정" });
    await ok(env, env.ctx("c-2a"), "assumption.assess", { assumption_id: revised.object_id, base_version_id: revised.version_id, state: "revised", statement: "고친 가정", rationale: "범위 축소" });
    const open = await ok(env, env.ctx("c-3"), "assumption.propose", { statement: "아직 안 본 가정" });
    const parent_rows = [confirmed, revised, open].map((a) => assumption_versions(env.db, a.object_id));
    const parent_current = [confirmed, revised, open].map((a) => current_version(env.db, a.object_id));

    const created = (await env.service.execute(env.ctx("ed2"), "edition.create", { parent_edition_id: env.p.edition_id })).result as { edition_id: string };

    // parent untouched
    assert.deepEqual([confirmed, revised, open].map((a) => assumption_versions(env.db, a.object_id)), parent_rows);
    assert.deepEqual([confirmed, revised, open].map((a) => current_version(env.db, a.object_id)), parent_current);

    const copies = env.db.all<{ object_id: string }>(
      `SELECT a.object_id FROM assumptions a JOIN objects o ON o.id = a.object_id WHERE o.edition_id = ? ORDER BY o.display_no`,
      created.edition_id,
    );
    assert.equal(copies.length, 3, "all three current assumptions are carried into the new edition");
    const statements: string[] = [];
    for (const copy of copies) {
      const rows = assumption_versions(env.db, copy.object_id);
      const cur = rows.find((r) => r.version_id === current_version(env.db, copy.object_id))!;
      statements.push(cur.statement);
      assert.equal(cur.state, "proposed", "a copy is never auto-confirmed");
      assert.equal(cur.needs_review, 1, "needs_review survives the copy");
      assert.equal(cur.assessment_actor_id, null);
      assert.equal(cur.assessed_at, null);
      assert.notEqual(current_version(env.db, copy.object_id), parent_current[0]);
    }
    assert.deepEqual(statements.sort(), ["아직 안 본 가정", "확인된 가정", "고친 가정"].sort(), "the revised assumption is carried with its current (person-revised) text");
  });
});

test("a person assesses the copy: only then it becomes confirmed with needs_review cleared; the parent stays as it was", async () => {
  await with_env(async (env) => {
    const p = await ok(env, env.ctx("a-1"), "assumption.propose", { statement: "가정" });
    const a = await ok(env, env.ctx("a-1a"), "assumption.assess", { assumption_id: p.object_id, base_version_id: p.version_id, state: "confirmed" });
    const created = (await env.service.execute(env.ctx("ed2"), "edition.create", { parent_edition_id: env.p.edition_id })).result as { edition_id: string };
    const copy = env.db.get<{ object_id: string }>(
      "SELECT a.object_id FROM assumptions a JOIN objects o ON o.id = a.object_id WHERE o.edition_id = ?",
      created.edition_id,
    )!;
    const copy_cur = current_version(env.db, copy.object_id)!;
    const assessed = await ok(env, env.ctx("a-2"), "assumption.assess", { assumption_id: copy.object_id, base_version_id: copy_cur, state: "confirmed" });
    assert.equal(assessed.state, "confirmed");
    const last = assumption_versions(env.db, copy.object_id).pop()!;
    assert.equal(last.state, "confirmed");
    assert.equal(last.needs_review, 0);
    assert.equal(last.assessment_actor_id, env.p.actor_id);
    assert.equal(current_version(env.db, p.object_id), a.version_id, "the parent is unchanged");
  });
});

test("decisions on a new edition: a project decision is referenced (not copied); an edition decision is copied with its version pinned", async () => {
  await with_env(async (env) => {
    const mk = async (tag: string, scope: string) => {
      const p = await ok(env, env.ctx(`${tag}-p`), "decision.propose", { statement: `${scope} 결정`, scope });
      const a = await ok(env, env.ctx(`${tag}-a`), "decision.adopt", { decision_id: p.object_id, base_version_id: p.version_id });
      return { object_id: p.object_id, version_id: a.version_id as string };
    };
    const proj = await mk("pj", "project");
    const ed = await mk("ed", "edition");
    const before = { proj: decision_versions(env.db, proj.object_id), ed: decision_versions(env.db, ed.object_id), n: count(env.db, "decisions") };
    const created = (await env.service.execute(env.ctx("ed2"), "edition.create", { parent_edition_id: env.p.edition_id })).result as { edition_id: string };
    assert.deepEqual(decision_versions(env.db, proj.object_id), before.proj, "parents untouched");
    assert.deepEqual(decision_versions(env.db, ed.object_id), before.ed);
    assert.equal(decision_scope(env.db, proj.object_id), "project");
    assert.equal(count(env.db, "decisions"), before.n + 1, "exactly one decision is copied: the edition-scoped one");
    const copied = env.db.get<{ object_id: string; scope: string; originated_from_version_id: string | null; edition_id: string }>(
      `SELECT d.object_id, d.scope, d.originated_from_version_id, o.edition_id FROM decisions d JOIN objects o ON o.id = d.object_id WHERE o.edition_id = ?`,
      created.edition_id,
    )!;
    assert.equal(copied.scope, "edition");
    assert.equal(copied.originated_from_version_id, ed.version_id, "pinned to the version that stood when the edition was made");
    assert.equal(
      env.db.all("SELECT 1 FROM decisions WHERE originated_from_version_id = ?", proj.version_id).length,
      0,
      "the project decision has no copy",
    );
  });
});
