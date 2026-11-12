/**
 * SEL-100 U3c — 서버 읽기 필드 보강 + 판 번호/라운드 번호로 읽는 길 (tester, 작성 모드). 읽기 전용, 새 표 없음.
 * 구현 전에는 새 키가 없고 `?edition=`·`?stage=&round_no=` 가 무시/거절돼서 실패하는 것이 정상.
 *
 * 있던 것(회귀 가드는 test_sel93_api 가 맡는다): GET P/assumptions · P/decisions · P/reflections 의 기존 키 전부.
 *   이 파일은 기존 키가 그대로 남는지도 본다(키를 빼거나 이름을 바꾸지 않는다).
 * 없던 것: 아래 "필드 대응표"의 새 키 전부, 판 번호로 읽기, 라운드 번호로 읽기.
 *
 * ═══ 필드 대응표 — 앱 타입(app/src/api/types.ts) ↔ 서버 읽기 키 (앱 http 매핑이 이 표를 쓴다. 시험: app/src/api/sel100-http.test.ts) ═══
 *  AssumptionRow.object_id          ← id                              (있던 것)
 *               .version_id         ← version_id                      (있던 것)
 *               .version            ← Number(version_no)              (있던 것)
 *               .statement/.state/.needs_review/.rationale/.assessed_at   ← 같은 이름 (있던 것)
 *               .proposed_by        ← proposed_by {id,kind,name}      (**새**; 옛 proposed_by_actor_id 는 그대로 둔다)
 *               .assessed_by        ← assessed_by {id,kind,name}|null (**새**; 옛 assessed_by_actor_id 그대로)
 *               .original           ← {version_id: revised_from_version_id, statement: revised_from_statement} | null   (**새** 두 키; state==="revised" 일 때만 값, 아니면 둘 다 null)
 *               .copied_from        ← 서버에 칸 없음 → 앱이 null (복사본은 needs_review 로만 드러난다. DB 가 복사 원본 버전을 가정에는 남기지 않는다)
 *               .source             ← 서버에 칸 없음 → 앱이 null
 *  DecisionRow.object_id/.version_id/.version/.statement/.state/.scope/.rationale  ← id/version_id/Number(version_no)/… (있던 것)
 *              .proposed_by         ← proposed_by {id,kind,name}      (**새**; 결정 객체의 첫 버전을 쓴 행위자)
 *              .decided_by          ← decided_by {id,kind,name}|null  (**새**; 옛 decided_by_actor_id 는 그대로 둔다)
 *              .supersedes          ← supersedes_decision_id (있던 것) + 같은 목록 안 그 결정의 statement → {object_id, statement}
 *              .superseded_by       ← superseded_by (**새**; 이 결정을 대체한 새 결정 id | null)
 *              .originated_from     ← originated_from_version_id / originated_from_version_no(10진 글) / originated_from_edition_no(정수) (**새** 셋; 판 결정이 복사본일 때만 값, 아니면 셋 다 null)
 *                                     → 앱 {label: 판 번호가 들어간 글, version: Number(version_no)}
 *              .source              ← 서버에 칸 없음 → 앱이 null
 *  ReflectionView.submission        ← submitted ? "submitted" : "none"   (있던 것)
 *                .sent_count        ← 서버가 안 줌 → 앱이 null (leader 결정 2026-11-12: 처리 줄 수로 지어내지 않는다)
 *                .entries[]         ← entries[] (아래)
 *  ReflectionEntry.id/.disposition/.rationale/.applied_tx_id  ← 같은 이름 (있던 것)
 *                .actor             ← actor {id,kind,name}                (**새**; 옛 actor_id 그대로)
 *                .opinion           ← source_text (**새**; 원문 버전이 가정·결정 버전이면 그 statement, 글/의견 버전이면 본문, 글이 없으면 null → 앱은 "")
 *                .source            ← source_version_id 로 앱이 만드는 Link (있던 것)
 *                .result_version    ← result_version_id 로 앱이 만드는 Link (있던 것)
 *                .followup          ← followup {id,kind,state,description,result_version_id|null} | null  (**새**) → 앱 {id,kind,state,label: description, result_version: Link|null}
 *  ReflectionView 에 라운드 번호 칸: 응답에 stage(단계 키)와 round_no(정수)를 싣는다 (**새**).
 *  행위자 kind 값: actors.kind 가 human → "human", internal_ai·external_agent·browser_agent → "ai" (system·legacy_unknown 은 이 시험 대상 아님). name = actors.display_name.
 *
 * ═══ 읽는 길 (이름은 OpenAPI 규칙에 맞춰 스스로 정함) ═══
 *  GET P/assumptions?edition=<edition_no>  · GET P/decisions?edition=<edition_no>
 *     edition 이 없으면 지금처럼 활성 판. 있으면 그 판(draft·completed·archived 모두 읽을 수 있다). 응답 data 에 edition(정수)가 더해진다.
 *     정수가 아니면 400 invalid_payload(target "$.query.edition"), 이 프로젝트에 없는 판 번호면 404 not_found(target "$.query.edition").
 *     결정은 그 판의 판 범위 결정 + 프로젝트 범위 결정(어느 판을 읽어도 프로젝트 범위는 보인다).
 *  GET P/reflections?edition=<edition_no>&stage=<단계 키>&round_no=<정수>
 *     그 판·단계·번호 라운드의 반영(round_id 로 읽는 것과 같은 모양 + stage·round_no). round_id 와 같이 주면 400 invalid_payload.
 *     없는 단계 키·없는 라운드 번호는 404 not_found. 제출 전이면 submitted false(= round_id 로 읽을 때와 같다). edition 은 선택(없으면 활성 판).
 *     round_id 로 읽는 옛 길도 그대로 되고, 응답에 stage·round_no 가 더해진다. 라운드 목록(인자 없음)의 각 항목에도 stage·round_no 가 있다.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { assert_ok, call, make_agent, with_api, type ApiEnv, type Auth } from "./helpers/api_env.ts";
import { P, assert_final_error } from "./helpers/api_flow.ts";
import { open_round } from "./helpers/questions_env.ts";
import { artifact_version, tx_of_version } from "./helpers/sel93_env.ts";
import { state_signature } from "./helpers/state_signature.ts";

const post = (env: ApiEnv, rest: string, auth: Auth, body: unknown) => call(env, { method: "POST", path: P(env, rest), auth, body });
const get = (env: ApiEnv, rest: string, auth: Auth = "owner") => call(env, { method: "GET", path: P(env, rest), auth });

const ACTOR = (id: string, kind: "human" | "ai") => ({ id, kind, name: (env: ApiEnv) => env.db.get<{ n: string }>("SELECT display_name AS n FROM actors WHERE id = ?", id)!.n });

function assert_actor(env: ApiEnv, actual: any, id: string, kind: "human" | "ai"): void {
  assert.deepEqual(Object.keys(actual).sort(), ["id", "kind", "name"]);
  assert.equal(actual.id, id);
  assert.equal(actual.kind, kind);
  assert.equal(actual.name, ACTOR(id, kind).name(env));
  assert.ok(actual.name.length > 0);
}

async function propose_assumption(env: ApiEnv, statement: string, auth: Auth = "owner"): Promise<any> {
  return assert_ok(await post(env, "/assumptions", auth, { statement, state: "proposed", rationale: "합성 배경", scope: "edition" }), 201).assumption;
}
async function propose_decision(env: ApiEnv, statement: string, scope: string, auth: Auth = "owner"): Promise<any> {
  return assert_ok(await post(env, "/decisions", auth, { scope, statement, state: "proposed", supersedes: null, rationale: "합성 근거" }), 201).decision;
}
async function adopt(env: ApiEnv, d: any, scope: string, statement: string): Promise<any> {
  return assert_ok(await post(env, "/decisions", "owner", { scope, statement, state: "adopted", supersedes: null, decision_id: d.id, base_version_id: d.version_id }), 201).decision;
}

function active_edition(env: ApiEnv): string {
  return env.db.get<{ id: string }>("SELECT active_edition_id AS id FROM projects WHERE id = ?", env.p.project_id)!.id;
}
function edition_no(env: ApiEnv, edition_id: string): number {
  return Number(env.db.get<{ n: bigint }>("SELECT edition_no AS n FROM editions WHERE id = ?", edition_id)!.n);
}
async function make_draft(env: ApiEnv, key: string): Promise<{ edition_id: string; no: number }> {
  const out = await env.service.execute(env.ctx(key), "edition.create", { parent_edition_id: active_edition(env) });
  const edition_id = (out.result as { edition_id: string }).edition_id;
  assert.notEqual(edition_id, active_edition(env));
  return { edition_id, no: edition_no(env, edition_id) };
}

// ---------------------------------------------------------------------------
// 가정 줄

test("assumption rows: proposed_by / assessed_by are {id, kind, name}; the old *_actor_id keys stay", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "ap");
    const a = await propose_assumption(env, "AI 가 제안한 가정", { token: agent.token });
    const b = await propose_assumption(env, "사람이 낸 가정");
    assert_ok(await post(env, "/assumptions", "owner", { assumption_id: b.id, base_version_id: b.version_id, state: "confirmed" }), 201);
    const rows = assert_ok(await get(env, "/assumptions")).assumptions as any[];
    const ra = rows.find((r) => r.id === a.id);
    const rb = rows.find((r) => r.id === b.id);
    for (const key of ["id", "version_id", "version_no", "statement", "state", "needs_review", "proposed_by_actor_id", "assessed_by_actor_id", "assessed_at", "rationale"]) {
      assert.ok(key in ra, `the old key ${key} is kept`);
    }
    assert_actor(env, ra.proposed_by, agent.actor_id, "ai");
    assert.equal(ra.assessed_by, null);
    assert_actor(env, rb.proposed_by, env.p.actor_id, "human");
    assert_actor(env, rb.assessed_by, env.p.actor_id, "human");
    assert.equal(rb.proposed_by_actor_id, env.p.actor_id);
    assert.equal(rb.assessed_by_actor_id, env.p.actor_id);
  });
});

test("a revised assumption names the version before the fix and keeps that sentence; others have null for both", async () => {
  await with_api(async (env) => {
    const a = await propose_assumption(env, "고치기 전 문장");
    const revised = assert_ok(await post(env, "/assumptions", "owner", { assumption_id: a.id, base_version_id: a.version_id, state: "revised", statement: "고친 문장", rationale: "범위 축소" }), 201).assumption;
    const c = await propose_assumption(env, "그대로 확인");
    assert_ok(await post(env, "/assumptions", "owner", { assumption_id: c.id, base_version_id: c.version_id, state: "confirmed" }), 201);
    const d = await propose_assumption(env, "아직 판단 전");
    const rows = assert_ok(await get(env, "/assumptions")).assumptions as any[];
    const r = rows.find((x) => x.id === a.id);
    assert.equal(r.state, "revised");
    assert.equal(r.version_id, revised.version_id);
    assert.equal(r.statement, "고친 문장");
    assert.equal(r.revised_from_version_id, a.version_id, "the version that was fixed (the proposal), so the original text can be shown");
    assert.equal(r.revised_from_statement, "고치기 전 문장");
    for (const other of [c.id, d.id]) {
      const o = rows.find((x) => x.id === other);
      assert.equal(o.revised_from_version_id, null);
      assert.equal(o.revised_from_statement, null);
    }
  });
});

// ---------------------------------------------------------------------------
// 결정 줄

test("decision rows: proposed_by is whoever wrote the first version, decided_by is the judge; old keys stay", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "dp");
    const d = await propose_decision(env, "AI 제안 결정", "edition", { token: agent.token });
    const e = await propose_decision(env, "사람 제안 결정", "project");
    await adopt(env, e, "project", "사람 제안 결정");
    const rows = assert_ok(await get(env, "/decisions")).decisions as any[];
    const rd = rows.find((r) => r.id === d.id);
    const re = rows.find((r) => r.id === e.id);
    for (const key of ["id", "version_id", "version_no", "statement", "state", "scope", "decided_by_actor_id", "rationale", "supersedes_decision_id"]) assert.ok(key in rd, `the old key ${key} is kept`);
    assert_actor(env, rd.proposed_by, agent.actor_id, "ai");
    assert.equal(rd.decided_by, null);
    assert_actor(env, re.proposed_by, env.p.actor_id, "human");
    assert_actor(env, re.decided_by, env.p.actor_id, "human");
    assert.equal(re.decided_by_actor_id, env.p.actor_id);
    assert.equal(rd.superseded_by, null);
    assert.equal(rd.originated_from_version_id, null);
    assert.equal(rd.originated_from_version_no, null);
    assert.equal(rd.originated_from_edition_no, null);
  });
});

test("superseded_by names the decision that replaced this one; the new one has superseded_by null and the old id in supersedes_decision_id", async () => {
  await with_api(async (env) => {
    const d = await propose_decision(env, "1판 결정", "edition");
    const a = await adopt(env, d, "edition", "1판 결정");
    const next = assert_ok(await post(env, "/decisions", "owner", { scope: "edition", statement: "2판 결정", state: "adopted", supersedes: d.id, base_version_id: a.version_id, rationale: "바꾼다" }), 201).decision;
    const rows = assert_ok(await get(env, "/decisions")).decisions as any[];
    const old = rows.find((r) => r.id === d.id);
    const fresh = rows.find((r) => r.id === next.id);
    assert.equal(old.state, "superseded");
    assert.equal(old.superseded_by, next.id);
    assert.equal(fresh.superseded_by, null);
    assert.equal(fresh.supersedes_decision_id, d.id);
  });
});

test("a decision copied into a new edition names the parent version it came from, with that version's number and the parent edition's number", async () => {
  await with_api(async (env) => {
    const d = await propose_decision(env, "복사될 판 결정", "edition");
    const a = await adopt(env, d, "edition", "복사될 판 결정");
    const parent_no = edition_no(env, active_edition(env));
    const draft = await make_draft(env, "rd-draft");
    const rows = assert_ok(await get(env, `/decisions?edition=${draft.no}`)).decisions as any[];
    const copy = rows.find((r) => r.statement === "복사될 판 결정" && r.id !== d.id);
    assert.ok(copy, "the draft edition shows its own copy");
    assert.equal(copy.originated_from_version_id, a.version_id);
    assert.equal(copy.originated_from_version_no, env.db.get<{ n: bigint }>("SELECT version_no AS n FROM object_versions WHERE id = ?", a.version_id)!.n.toString());
    assert.equal(copy.originated_from_edition_no, parent_no);
    assert_actor(env, copy.decided_by, env.p.actor_id, "human");
  });
});

// ---------------------------------------------------------------------------
// 판 번호로 읽기

test("?edition=N reads that edition: its assumptions and edition decisions plus the project-wide ones; no edition = the active one (unchanged)", async () => {
  await with_api(async (env) => {
    const a = await propose_assumption(env, "1판 가정");
    const e1 = await propose_decision(env, "1판 결정", "edition");
    await adopt(env, e1, "edition", "1판 결정");
    const p1 = await propose_decision(env, "프로젝트 결정", "project");
    await adopt(env, p1, "project", "프로젝트 결정");
    const first_no = edition_no(env, active_edition(env));
    const draft = await make_draft(env, "re-draft");
    const sig = state_signature(env.db);

    const active_a = assert_ok(await get(env, "/assumptions"));
    const active_d = assert_ok(await get(env, "/decisions"));
    assert.equal(active_a.edition, first_no, "the plain read says which edition it is");
    assert.equal(active_d.edition, first_no);
    assert.ok(active_a.assumptions.some((r: any) => r.id === a.id));

    const first_a = assert_ok(await get(env, `/assumptions?edition=${first_no}`));
    assert.equal(first_a.edition, first_no);
    assert.deepEqual(first_a.assumptions.map((r: any) => r.id), active_a.assumptions.map((r: any) => r.id));

    const draft_a = assert_ok(await get(env, `/assumptions?edition=${draft.no}`));
    assert.equal(draft_a.edition, draft.no);
    assert.equal(draft_a.assumptions.length, 1, "the copy lives in the draft edition");
    assert.notEqual(draft_a.assumptions[0].id, a.id);
    assert.equal(draft_a.assumptions[0].state, "proposed");
    assert.equal(draft_a.assumptions[0].needs_review, true);

    const draft_d = assert_ok(await get(env, `/decisions?edition=${draft.no}`));
    assert.equal(draft_d.edition, draft.no);
    const statements = draft_d.decisions.map((r: any) => r.statement).sort();
    assert.deepEqual(statements, ["1판 결정", "프로젝트 결정"], "the edition copy + the project-wide decision");
    assert.ok(draft_d.decisions.some((r: any) => r.id === p1.id), "the project-wide decision is the same object in every edition");
    assert.ok(!draft_d.decisions.some((r: any) => r.id === e1.id), "the parent's edition decision is not in the draft");
    assert.equal(state_signature(env.db), sig, "reading writes nothing");
  });
});

test("?edition= : not an integer is 400 invalid_payload, an edition number this project does not have is 404 not_found (target $.query.edition)", async () => {
  await with_api(async (env) => {
    for (const path of ["/assumptions", "/decisions"]) {
      for (const bad of ["abc", "1.5", "-1", "0", ""]) {
        assert_final_error(await get(env, `${path}?edition=${bad}`), 400, "invalid_payload", { target: "$.query.edition" });
      }
      assert_final_error(await get(env, `${path}?edition=99`), 404, "not_found", { target: "$.query.edition" });
    }
  });
});

test("?edition= reads work for an agent token with context:read as well (the same rows as the owner)", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "reader");
    await propose_assumption(env, "읽히는 가정");
    const no = edition_no(env, active_edition(env));
    const owner = assert_ok(await get(env, `/assumptions?edition=${no}`));
    const token = assert_ok(await get(env, `/assumptions?edition=${no}`, { token: agent.token }));
    assert.deepEqual(token, owner);
  });
});

// ---------------------------------------------------------------------------
// 반영 읽기

interface Scene {
  round_id: string;
  stage_key: string;
  round_no: number;
  source: { object_id: string; version_id: string };
  result: { object_id: string; version_id: string };
  result_tx: string;
}

async function scene(env: ApiEnv, tag: string): Promise<Scene> {
  const { round_id } = await open_round(env, tag);
  const row = env.db.get<{ key: string; round_no: bigint }>("SELECT s.key AS key, r.round_no AS round_no FROM rounds r JOIN stages s ON s.id = r.stage_id WHERE r.id = ?", round_id)!;
  const source = await artifact_version(env, `${tag}-src`);
  const result = await artifact_version(env, `${tag}-res`);
  return { round_id, stage_key: row.key, round_no: Number(row.round_no), source, result, result_tx: tx_of_version(env.db, result.version_id) };
}

test("reflection entries carry actor {id,kind,name}; the round answer carries stage and round_no; old keys stay", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "rf");
    const s = await scene(env, "rd1");
    assert_ok(
      await post(env, "/reflections", { token: agent.token }, {
        target_round_id: s.round_id,
        entries: [
          { source_version_id: s.source.version_id, disposition: "applied", rationale: "반영", result_version_id: s.result.version_id, evidence_tx_id: s.result_tx },
          { source_version_id: s.source.version_id, disposition: "rejected", rationale: "안 한다" },
        ],
      }),
      201,
    );
    const round = assert_ok(await get(env, `/reflections?round_id=${s.round_id}`));
    for (const key of ["round_id", "submitted", "counts", "entries"]) assert.ok(key in round, `the old key ${key} is kept`);
    assert.equal(round.stage, s.stage_key);
    assert.equal(round.round_no, s.round_no);
    assert.equal(round.entries.length, 2);
    for (const e of round.entries) {
      for (const key of ["id", "source_version_id", "disposition", "rationale", "result_version_id", "followup_id", "applied_tx_id", "actor_id"]) assert.ok(key in e, `the old key ${key} is kept`);
      assert_actor(env, e.actor, agent.actor_id, "ai");
      assert.equal(e.actor_id, agent.actor_id);
    }
    const list = assert_ok(await get(env, "/reflections")).reflections as any[];
    assert.equal(list.length, 1);
    assert.equal(list[0].stage, s.stage_key);
    assert.equal(list[0].round_no, s.round_no);
  });
});

test("reflection entries: source_text is the sentence of a judgement source (assumption / decision version), else null; followup is {id,kind,state,description,result_version_id}", async () => {
  await with_api(async (env) => {
    const s = await scene(env, "rd2");
    const a = await propose_assumption(env, "반영의 원문이 된 가정 문장");
    const fu = env.db.get<{ id: string }>("SELECT id FROM mutation_commits WHERE project_id = ? ORDER BY rowid LIMIT 1", env.p.project_id)!;
    const stage_id = env.db.get<{ id: string }>("SELECT stage_id AS id FROM rounds WHERE id = ?", s.round_id)!.id;
    // 합성 후속: 이미 적용된(applied) next_round_task — insert_followup 과 같은 직접 쓰기(시험 자료만)
    const object_id = "fu-obj-rd2";
    const version_id = "fu-ver-rd2";
    env.db.run("INSERT INTO objects (id, project_id, kind, display_no) VALUES (?, ?, 'followup', 777)", object_id, env.p.project_id);
    env.db.run(
      "INSERT INTO object_versions (id, project_id, object_id, kind, version_no, actor_id, tx_id, content_hash) VALUES (?, ?, ?, 'followup', 1, ?, ?, ?)",
      version_id, env.p.project_id, object_id, env.p.actor_id, fu.id, "d".repeat(64),
    );
    env.db.run("INSERT INTO followups (project_id, object_id, origin_version_id) VALUES (?, ?, ?)", env.p.project_id, object_id, a.version_id);
    env.db.run(
      "INSERT INTO followup_versions (project_id, version_id, object_id, kind, state, description, target_stage_id, applied_tx_id) VALUES (?, ?, ?, 'next_round_task', 'applied', '노년층 자료 더 찾기', ?, ?)",
      env.p.project_id, version_id, object_id, stage_id, fu.id,
    );
    env.db.run("UPDATE objects SET current_version_id = ? WHERE id = ?", version_id, object_id);
    assert_ok(
      await post(env, "/reflections", "owner", {
        target_round_id: s.round_id,
        entries: [
          { source_version_id: a.version_id, disposition: "partial", rationale: "후속으로 이었다", followup_id: object_id, evidence_tx_id: fu.id },
          { source_version_id: s.source.version_id, disposition: "deferred", rationale: "다음 판으로" },
        ],
      }),
      201,
    );
    const round = assert_ok(await get(env, `/reflections?round_id=${s.round_id}`));
    const partial = round.entries.find((e: any) => e.disposition === "partial");
    const deferred = round.entries.find((e: any) => e.disposition === "deferred");
    assert.equal(partial.source_text, "반영의 원문이 된 가정 문장");
    assert.equal(deferred.source_text, null, "an artifact version has no sentence to show");
    assert.deepEqual(partial.followup, { id: object_id, kind: "next_round_task", state: "applied", description: "노년층 자료 더 찾기", result_version_id: null });
    assert.equal(deferred.followup, null);
  });
});

test("?edition=&stage=&round_no= reads the same answer as round_id; mixing the two is 400, unknown stage/round is 404; a round with no submission is submitted:false", async () => {
  await with_api(async (env) => {
    const s = await scene(env, "rd3");
    const no = edition_no(env, active_edition(env));
    const by_number = `/reflections?edition=${no}&stage=${s.stage_key}&round_no=${s.round_no}`;
    const before = assert_ok(await get(env, by_number));
    assert.equal(before.round_id, s.round_id);
    assert.equal(before.submitted, false);
    assert.deepEqual(before.entries, []);
    assert.equal(before.stage, s.stage_key);
    assert.equal(before.round_no, s.round_no);
    assert_ok(
      await post(env, "/reflections", "owner", {
        target_round_id: s.round_id,
        entries: [{ source_version_id: s.source.version_id, disposition: "applied", rationale: "반영", result_version_id: s.result.version_id, evidence_tx_id: s.result_tx }],
      }),
      201,
    );
    const after = assert_ok(await get(env, by_number));
    const by_id = assert_ok(await get(env, `/reflections?round_id=${s.round_id}`));
    assert.deepEqual(after, by_id);
    assert.equal(after.submitted, true);
    // edition 은 선택: 없으면 활성 판
    assert.deepEqual(assert_ok(await get(env, `/reflections?stage=${s.stage_key}&round_no=${s.round_no}`)), after);
    assert_final_error(await get(env, `${by_number}&round_id=${s.round_id}`), 400, "invalid_payload");
    assert_final_error(await get(env, `/reflections?edition=${no}&stage=${s.stage_key}&round_no=${s.round_no + 40}`), 404, "not_found");
    assert_final_error(await get(env, `/reflections?edition=${no}&stage=no-such-stage&round_no=${s.round_no}`), 404, "not_found");
    assert_final_error(await get(env, `/reflections?edition=${no}&stage=${s.stage_key}&round_no=abc`), 400, "invalid_payload", { target: "$.query.round_no" });
    assert_final_error(await get(env, `/reflections?edition=99&stage=${s.stage_key}&round_no=${s.round_no}`), 404, "not_found", { target: "$.query.edition" });
  });
});
