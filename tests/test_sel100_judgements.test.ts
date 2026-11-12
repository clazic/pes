/**
 * SEL-100 U3c — 결정 채택·폐기의 statement, draft 판 결정을 프로젝트 범위로 넓히는 대체, 새 판 복사 시점 문서 (tester, 작성 모드).
 *
 * ═══ 4. 채택·폐기에 statement ═══
 * 있던 것: 가정은 state confirmed/rejected 에 statement 가 오면 422 validation_failed target $.body.statement reason revised_only (test_sel93_api 의 가정 시험).
 *   결정 채택·폐기는 statement 를 조용히 버린다.
 * 없던 것: 결정의 같은 거절.
 * 정한 해석 — "채택하면서 문장 고치기는 허용하지 않는다(문장을 바꾸려면 대체)":
 *   POST P/decisions state adopted(decision_id 로 채택) · revoked 에서 body.statement 가 **그 결정의 현재 문장과 다르면** 422 validation_failed,
 *   target "$.body.statement", details.reason 은 문자열(이름은 구현이 정함), 아무것도 쓰지 않는다.
 *   **같은 문장이거나 statement 가 없으면(또는 null) 지금처럼 통과**한다. 이유: 기존 시험·문서 픽스처(docs/plan/fixtures/api-v1/decisions.json)와
 *   test_sel93_api 209·236·237행 등은 채택·폐기 본문에 제안과 **같은** 문장을 싣고 있어 가정의 revised_only(무엇이든 오면 거절)와 똑같이 하면 그것들이 모두 깨진다.
 *   "다른 statement 로 채택 201" 을 기대한 단언은 지금 저장소에 없다 — test_sel93_api:209 는 같은 문장으로 채택한다(Linear 댓글의 설명과 다르다).
 *   그래서 :209 는 새 계약과 충돌하지 않아 **고치지 않았다**(보고서에 적음). 다만 test_sel93_final_fixes:69 는 폐기 본문에 결정 문장과 다른 "x" 를 실어 201 을 기대한다 — 새 계약에서 422 가 되므로 구현 때 그 "x" 를 결정 문장으로 바꿔야 한다(leader 승인 필요, 보고서에 적음).
 *   대체(supersedes)는 statement 가 새 문장이라 필수 — 그대로.
 * 순서: scope_mismatch(422 target $.body.scope) 검사가 statement 검사보다 앞이거나 같은 422 라서, 이 파일은 scope 를 맞춰 보낸다.
 *
 * ═══ 5. draft 판에 복사된 판 범위 결정을 프로젝트 범위로 넓혀 대체 ═══
 * 있던 것: 판 범위→판 범위 대체의 새 결정은 옛 결정이 속한 판에 들어간다(test_sel93_final2_fixes 1번). 활성 판의 판 범위 결정을 프로젝트 범위로 넓히는 대체는 201.
 * 없던 것: 활성 판이 아닌 판(draft 복사본)의 결정을 scope "project" 로 넓히는 대체 거절.
 * 정한 해석: 옛 결정이 속한 판이 활성 판이 아니고 새 scope 가 project 면 409 conflict(details.reason 은 문자열 — 구현이 정함), 아무것도 안 쓴다.
 *   활성 판 안의 넓히기·프로젝트→프로젝트·draft 안에서 판 범위끼리 대체는 지금처럼 201(회귀 가드).
 *
 * ═══ 6. 새 판 복사 시점 ═══
 * 정한 해석: 지금처럼 edition.create 때 한 번 복사하고 판 활성화 명령은 만들지 않는다. 문서 확인 시험만 둔다:
 *   docs/plan/stage-3.md 의 "### U3 가정·결정·반영" 절에 그 사실을 한 줄로 적어야 한다 — `edition.create`, "복사", "한 번" 세 낱말, 그리고 활성화 명령이 없다는 말("활성화").
 *   (거절된 가정이 새 판에서 proposed 로 되살아나는 것은 의도다: 복사본은 늘 proposed·needs_review=1 — 같은 줄에 적는다 → "다시"/"proposed" 중 하나.)
 *   동작 시험은 이미 있다(test_sel93_legacy_carry 의 복사본 시험).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { assert_ok, call, with_api, type ApiEnv, type Auth } from "./helpers/api_env.ts";
import { P, assert_final_error } from "./helpers/api_flow.ts";
import { state_signature } from "./helpers/state_signature.ts";

const post = (env: ApiEnv, rest: string, auth: Auth, body: unknown) => call(env, { method: "POST", path: P(env, rest), auth, body });

async function proposed(env: ApiEnv, scope: string, statement: string): Promise<any> {
  return assert_ok(await post(env, "/decisions", "owner", { scope, statement, state: "proposed", supersedes: null }), 201).decision;
}
async function adopted(env: ApiEnv, scope: string, statement: string): Promise<any> {
  const d = await proposed(env, scope, statement);
  return assert_ok(await post(env, "/decisions", "owner", { scope, statement, state: "adopted", supersedes: null, decision_id: d.id, base_version_id: d.version_id }), 201).decision;
}

// ---------------------------------------------------------------------------
// 4

test("adopting with a statement that differs from the proposal is 422 at $.body.statement and writes nothing (changing the sentence is a supersede)", async () => {
  await with_api(async (env) => {
    const d = await proposed(env, "edition", "제안한 문장");
    const sig = state_signature(env.db);
    for (const statement of ["다른 문장", "제안한 문장 ", " 제안한 문장", ""]) {
      const err = assert_final_error(
        await post(env, "/decisions", "owner", { scope: "edition", statement, state: "adopted", supersedes: null, decision_id: d.id, base_version_id: d.version_id }),
        422,
        "validation_failed",
        { target: "$.body.statement", next_action: "fix_request" },
      );
      assert.equal(typeof err.details.reason, "string");
    }
    assert.equal(state_signature(env.db), sig);
    assert.equal(env.db.all("SELECT 1 FROM decision_versions WHERE object_id = ?", d.id).length, 1, "still only the proposal");
  });
});

test("adopting with the same sentence, with no statement, or with statement null still works; the adopted text is the proposal's", async () => {
  await with_api(async (env) => {
    const a = await proposed(env, "edition", "그대로 채택");
    assert_ok(await post(env, "/decisions", "owner", { scope: "edition", statement: "그대로 채택", state: "adopted", supersedes: null, decision_id: a.id, base_version_id: a.version_id }), 201);
    const b = await proposed(env, "edition", "문장 없이 채택");
    const bd = assert_ok(await post(env, "/decisions", "owner", { scope: "edition", state: "adopted", decision_id: b.id, base_version_id: b.version_id }), 201).decision;
    assert.equal(bd.state, "adopted");
    const c = await proposed(env, "project", "null 로 채택");
    assert_ok(await post(env, "/decisions", "owner", { scope: "project", statement: null, state: "adopted", supersedes: null, decision_id: c.id, base_version_id: c.version_id }), 201);
    const texts = env.db.all<{ statement: string; state: string }>("SELECT statement, state FROM decision_versions WHERE state = 'adopted' ORDER BY rowid").map((r) => r.statement);
    assert.deepEqual(texts, ["그대로 채택", "문장 없이 채택", "null 로 채택"]);
  });
});

test("revoking with a statement that differs from the decision's sentence is 422 at $.body.statement and writes nothing; the same sentence or none works", async () => {
  await with_api(async (env) => {
    const a = await adopted(env, "edition", "폐기할 결정");
    const sig = state_signature(env.db);
    const err = assert_final_error(
      await post(env, "/decisions", "owner", { scope: "edition", statement: "다른 문장", state: "revoked", supersedes: null, decision_id: a.id, base_version_id: a.version_id, rationale: "전제가 무너짐" }),
      422,
      "validation_failed",
      { target: "$.body.statement", next_action: "fix_request" },
    );
    assert.equal(typeof err.details.reason, "string");
    assert.equal(state_signature(env.db), sig);
    assert_ok(await post(env, "/decisions", "owner", { scope: "edition", statement: "폐기할 결정", state: "revoked", supersedes: null, decision_id: a.id, base_version_id: a.version_id, rationale: "전제가 무너짐" }), 201);
    const b = await adopted(env, "project", "문장 없이 폐기");
    assert_ok(await post(env, "/decisions", "owner", { scope: "project", state: "revoked", decision_id: b.id, base_version_id: b.version_id, rationale: "필요 없음" }), 201);
  });
});

test("a superseding request still carries the NEW sentence (required) — the statement rule above does not touch it", async () => {
  await with_api(async (env) => {
    const a = await adopted(env, "edition", "옛 문장");
    const next = assert_ok(await post(env, "/decisions", "owner", { scope: "edition", statement: "새 문장", state: "adopted", supersedes: a.id, base_version_id: a.version_id, rationale: "바꾼다" }), 201).decision;
    assert.equal(env.db.get<{ statement: string }>("SELECT statement FROM decision_versions WHERE version_id = ?", next.version_id)?.statement, "새 문장");
  });
});

// ---------------------------------------------------------------------------
// 5

function active_edition(env: ApiEnv): string {
  return env.db.get<{ id: string }>("SELECT active_edition_id AS id FROM projects WHERE id = ?", env.p.project_id)!.id;
}
async function make_draft(env: ApiEnv, key: string): Promise<string> {
  const out = await env.service.execute(env.ctx(key), "edition.create", { parent_edition_id: active_edition(env) });
  const edition_id = (out.result as { edition_id: string }).edition_id;
  assert.notEqual(edition_id, active_edition(env));
  return edition_id;
}
function draft_copy(env: ApiEnv, edition_id: string): { id: string; version_id: string } {
  const row = env.db.get<{ id: string; version_id: string }>(
    "SELECT id, current_version_id AS version_id FROM objects WHERE project_id = ? AND edition_id = ? AND kind = 'decision' ORDER BY display_no",
    env.p.project_id,
    edition_id,
  );
  assert.ok(row, "the draft edition has a decision copy");
  return row;
}
const widen = (env: ApiEnv, old: { id: string; version_id: string }, scope: string, statement: string) =>
  post(env, "/decisions", "owner", { scope, statement, state: "adopted", supersedes: old.id, base_version_id: old.version_id, rationale: "범위를 넓힌다" });

test("widening a DRAFT edition's copy of an edition decision to project scope is 409 conflict and writes nothing (a new edition's work must not leak into the active edition)", async () => {
  await with_api(async (env) => {
    await adopted(env, "edition", "판 결정");
    const draft = await make_draft(env, "w-draft");
    const copy = draft_copy(env, draft);
    const sig = state_signature(env.db);
    const err = assert_final_error(await widen(env, copy, "project", "프로젝트로 넓힘"), 409, "conflict");
    assert.equal(typeof err.details.reason, "string");
    assert.equal(state_signature(env.db), sig);
    const active = assert_ok(await call(env, { method: "GET", path: P(env, "/decisions"), auth: "owner" })).decisions as any[];
    assert.ok(!active.some((r) => r.statement === "프로젝트로 넓힘"), "the active edition shows nothing new");
  });
});

test("regression: edition → edition inside the draft is still allowed and lands in the draft edition", async () => {
  await with_api(async (env) => {
    await adopted(env, "edition", "판 결정");
    const draft = await make_draft(env, "w-draft2");
    const copy = draft_copy(env, draft);
    const next = assert_ok(await widen(env, copy, "edition", "초안 안에서 바꾼 문장"), 201).decision;
    assert.equal(env.db.get<{ edition_id: string }>("SELECT edition_id FROM objects WHERE id = ?", next.id)?.edition_id, draft);
  });
});

test("regression: widening an ACTIVE edition's decision to project scope is allowed (201), and so is project → project", async () => {
  await with_api(async (env) => {
    const e = await adopted(env, "edition", "활성 판 결정");
    const wide = assert_ok(await widen(env, e, "project", "프로젝트 범위로 넓힘"), 201).decision;
    assert.equal(wide.scope, "project");
    const again = assert_ok(await post(env, "/decisions", "owner", { scope: "project", statement: "프로젝트 범위 새 문장", state: "adopted", supersedes: wide.id, base_version_id: wide.version_id, rationale: "고친다" }), 201).decision;
    assert.equal(again.scope, "project");
  });
});

// ---------------------------------------------------------------------------
// 6

test("docs: the U3 section of docs/plan/stage-3.md says that a new edition copies records once, at edition.create, and that there is no activation command", () => {
  const text = readFileSync(new URL("../docs/plan/stage-3.md", import.meta.url), "utf8");
  const start = text.search(/^### U3 가정·결정·반영/m);
  assert.ok(start >= 0, "the U3 section exists");
  const rest = text.slice(start + 5);
  const end = rest.search(/^### /m);
  const section = end < 0 ? rest : rest.slice(0, end);
  assert.match(section, /edition\.create/, "names the command that copies");
  assert.match(section, /복사/);
  assert.match(section, /한 번/, "once");
  assert.match(section, /활성화/, "says there is no activation command / nothing is copied again at activation");
  assert.match(section, /proposed|다시 판단|다시 확인/, "says rejected assumptions come back as proposals (needs review) in the copy");
});
