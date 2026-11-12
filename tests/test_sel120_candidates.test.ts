/**
 * SEL-120 REF1c — 참고자료 후보 읽기: GET P/reference-candidates (tester, 작성 모드).
 * 구현 전에는 경로가 없어 404 라서 실패하는 것이 정상. 합성 자료만(실제 자료 · 키 · 경로 없음).
 *
 * 이슈: 지금 사용자가 접근할 수 있는 다른 프로젝트(자기 자신 제외)와 각 프로젝트의 스냅숏(추천 · 승인 표시)을 돌려주는 읽기 길 하나.
 * 서버 읽기 전용 · 새 표 없음 · 권한은 REF1a(SEL-113)와 같은 판정(`is_member` — `decide()` 의 has_access)을 쓴다.
 * 서버 응답은 앱(SEL-114 REF1b, `git show origin/ai/SEL-114:app/src/test/sel114.ts` 의 ReferenceCandidate · ReferenceSnapshot)이 기대하는 모양에 맞춘다.
 * 이름을 바꿔야 하면 구현이 아니라 이 파일(과 보고서의 해석)을 고치고 leader 에게 알린다.
 *
 * ═══ 정한 인터페이스 ═══
 *   GET /api/v1/projects/{id}/reference-candidates          (쿼리 없음. 모르는 쿼리는 무시하지 않아도 되고 시험하지 않는다)
 *     누가: 소유자 세션(사람)만. 토큰(에이전트)은 어떤 범위든 403(human_required) — 후보는 붙이기(사람만)를 위한 읽기이고,
 *           다른 프로젝트의 이름 · 스냅숏 id 를 AI 에게 흘리지 않는다(Go OFF 라도 마찬가지로 fail closed). 무자격 401, 모르는 프로젝트 404.
 *           토큰의 오류 코드는 human_required 하나(문서 기준). 다른 프로젝트 토큰은 있는 프로젝트든 없는 프로젝트든 같은 401 봉투.
 *     성공: 200 data = { candidates: [후보] }
 *     후보(키 다섯 개뿐): { project_id, key, label, attached, snapshots }
 *       project_id   원본 프로젝트 id
 *       key          = project_id (REF1a 의 referenced_project_key 와 같은 값)
 *       label        = 프로젝트 주제(topic), 비었으면 slug (REF1a attach 의 source_label 기본값과 같은 규칙)
 *       attached     이 프로젝트가 이미 그 프로젝트를 참고자료로 붙였는가(project_references 에 그 key 의 줄이 있음)
 *       snapshots    고를 수 있는 스냅숏 목록, **가장 나중 것이 앞**. 인쇄(print.committed) 스냅숏은 뺀다(REF1a 의 pinnable 규칙).
 *     스냅숏(키 다섯 개뿐): { id, key, label, approved, recommended }
 *       id           스냅숏 id
 *       key          = id (REF1a 의 source_snapshot_key 와 같은 값)
 *       label        null — 서버에는 스냅숏 이름이 없다(지어내지 않는다). 앱이 key 로 보여 준다.
 *       approved     true: 어느 단계 승인(approvals)이 이 스냅숏을 가리킴 / false: 아님. 승인본처럼 보이는 거짓이 없어야 한다.
 *       recommended  프로젝트마다 스냅숏이 하나라도 있으면 **정확히 하나만 true**: 승인된 것 중 가장 나중 것, 승인된 것이 하나도 없으면 가장 나중 스냅숏.
 *     목록 순서: 후보는 프로젝트가 만들어진 순서(오래된 것이 앞). 스냅숏이 0 개인 프로젝트도 후보에 남는다(snapshots: [] — 고를 것이 없을 뿐).
 *
 *   누가 후보에 나오는가 (REF1a 판정과 같다 — 권한 없는 프로젝트는 존재도 안 드러난다)
 *     - 자기 자신: 나오지 않는다(구성원이어도).
 *     - 호출 사용자가 구성원(owner · editor · reader 모두)인 다른 프로젝트: 나온다.
 *     - 구성원이 아닌 프로젝트: 나오지 않는다 — 목록에도 · 응답 어디(이름 · id · 스냅숏 id)에도 없다. 구성원이 되면 그때 나온다. 빠지면 사라진다.
 *     - Go OFF(원본 또는 이 프로젝트): 사람(소유자 세션)은 영향 없음 — decide() 와 같이 사람은 Go 에 막히지 않는다. 그대로 나온다.
 *     - 보관(status 'archived')된 프로젝트: 새로 붙일 후보가 아니다 — 나오지 않는다. 이미 붙인 줄(GET P/references)은 REF1a 대로 따로 읽힌다(이 길은 건드리지 않음).
 *
 *   읽기라 부작용 0: 영수증 · 사건 · 어떤 표도 바뀌지 않는다(두 번 읽어도 같은 답, state_signature 같음).
 *   질의 수: 프로젝트 수에 비례(프로젝트마다 상수 개)하고 프로젝트당 스냅숏 수에는 무관하다(N+1 이 스냅숏까지 번지지 않는다).
 *   OpenAPI(docs/api/openapi-v1.yaml)에 경로가 get 하나로 적히고, 닫힌 경로표(EXPECTED_ROUTES)와 capabilities routes 에 들어간다.
 *
 *   범위 밖(후속): 앱 getReferenceCandidates 의 http 매핑(SEL-114 병합 뒤). 프로젝트가 아직 없는 생성 화면(scope=null)용 길은 이 이슈에 없다 — 앱은 그 경우 NotConnectedError 를 유지한다.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { issue_agent_token } from "../scripts/pes_core/actors.ts";
import type { Db } from "../scripts/pes_core/db.ts";
import { approve_stage, seal_round, start_round } from "../scripts/pes_core/editions.ts";
import { assert_error, assert_ok, call, make_agent, OPENAPI_PATH, with_api, type ApiEnv, type ApiResponse, type Auth } from "./helpers/api_env.ts";
import { P, assert_final_error } from "./helpers/api_flow.ts";
import { ctx_for, put_ready } from "./helpers/blob_env.ts";
import { stage_ids } from "./helpers/editions_env.ts";
import {
  add_new_version,
  attach_ref,
  current_go,
  grant_access,
  has_text,
  make_source,
  owner_user_of,
  revoke_access,
  source_go,
  type Source,
} from "./helpers/sel113_env.ts";
import { ok } from "./helpers/sel93_env.ts";
import { state_signature } from "./helpers/state_signature.ts";

const CANDIDATE_KEYS = ["attached", "key", "label", "project_id", "snapshots"];
const SNAPSHOT_KEYS = ["approved", "id", "key", "label", "recommended"];
const PATH = "/reference-candidates";

const get = (env: ApiEnv, auth: Auth = "owner", rest = PATH) => call(env, { method: "GET", path: P(env, rest), auth });
const candidates_of = async (env: ApiEnv, auth: Auth = "owner"): Promise<any[]> => assert_ok(await get(env, auth)).candidates;
const ids_of = (list: any[]): string[] => list.map((c) => c.project_id);

/** 응답 전체(본문 · 헤더)에 원본의 id · 스냅숏 id · 표지 · extra(이름) 가 있는가 */
function leaks(res: ApiResponse, src: Source, extra: string[] = []): boolean {
  const body = JSON.stringify(res.json) + (res.bytes === null ? "" : Buffer.from(res.bytes).toString("utf8"));
  const text = body + JSON.stringify(res.headers);
  return [src.p.project_id, src.snapshot_id, src.report_marker, src.source_marker, ...extra].some((m) => text.includes(m));
}

/** 합성 원본마다 고유한 주제(topic)를 주고 [주제, slug] 를 돌려준다. 이름이 응답에 새면 이 두 값이 잡힌다. */
function names_of(env: ApiEnv, src: Source): string[] {
  const topic = `합성주제-${src.tag}-고유값`;
  env.db.run("UPDATE projects SET topic = ? WHERE id = ?", topic, src.p.project_id);
  const slug = env.db.get<{ slug: string }>("SELECT slug FROM projects WHERE id = ?", src.p.project_id)!.slug;
  return [topic, slug];
}

/** 다른 프로젝트(src)의 소유자 사용자로 만든 에이전트 토큰. 이 프로젝트 경로에는 맞지 않는다. */
async function other_project_token(env: ApiEnv, src: Source, name: string): Promise<string> {
  const actor_id = `agent-${name}`;
  env.db.run("INSERT INTO actors (id, kind, user_id, display_name) VALUES (?, ?, ?, ?)", actor_id, "external_agent", src.user_id, `합성 ${name}`);
  const out = await issue_agent_token(env.service, ctx_for(src.p, `tok-${name}`), { actor_id, scopes: ["context:read"] });
  return (out.result as { token: string }).token;
}

/** 원본의 계획 단계를 열고, 지정한 버전들로 봉인하고 승인한다. 승인된 스냅숏 id 를 돌려준다. */
async function approve_source(env: ApiEnv, src: Source, tag: string, versions: Array<{ object_id: string; version_id: string }>): Promise<string> {
  const stage_id = stage_ids(env.db, src.p.edition_id).plan;
  const round = (await start_round(env.service, ctx_for(src.p, `${tag}-start`), { stage_id })).result as { round_id: string };
  const body = new TextEncoder().encode(JSON.stringify({ versions }));
  const blob = await put_ready(env, body, `${tag}-mf`, src.p);
  const sealed = (await seal_round(env.service, ctx_for(src.p, `${tag}-seal`), { round_id: round.round_id, manifest_blob_id: blob.blob_id, versions })).result as { snapshot_id: string };
  await approve_stage(env.service, ctx_for(src.p, `${tag}-approve`), { stage_id, snapshot_id: sealed.snapshot_id });
  return sealed.snapshot_id;
}

const refs_of = (db: Db, project_id: string): number => Number(db.get<{ n: bigint }>("SELECT count(*) AS n FROM project_references WHERE project_id = ?", project_id)?.n ?? 0n);

// ---------------------------------------------------------------------------
// 준비물이 제대로 서는가 (경로 없이도 통과해야 하는 시험 — 다른 시험의 실패가 준비물 때문이 아님을 보인다)

test("fixture sanity: a synthetic source with an approved round snapshot, a newer unapproved one and a print exists", async () => {
  await with_api(async (env) => {
    const src = await make_source(env, "fx");
    grant_access(env, src);
    const approved = await approve_source(env, src, "fx-ap", [{ object_id: src.report.object_id, version_id: src.report.version_id }]);
    const v2 = await add_new_version(env, src, 2);
    const printed = (await env.service.execute(ctx_for(src.p, "fx-print"), "print.commit", { scope: "edition" })).result as { snapshot_id: string };
    const n = (sql: string, ...p: string[]) => Number(env.db.get<{ n: bigint }>(sql, ...p)?.n ?? 0n);
    assert.equal(n("SELECT count(*) AS n FROM approvals WHERE project_id = ? AND snapshot_id = ?", src.p.project_id, approved), 1);
    assert.equal(n("SELECT count(*) AS n FROM snapshots WHERE project_id = ?", src.p.project_id) >= 4, true);
    assert.notEqual(printed.snapshot_id, v2.snapshot_id);
    assert.equal(n("SELECT count(*) AS n FROM project_members WHERE project_id = ?", src.p.project_id) >= 2, true);
  });
});

// ---------------------------------------------------------------------------
// OpenAPI · 닫힌 경로표

test("OpenAPI documents the reference-candidates path with get only", () => {
  const doc = readFileSync(OPENAPI_PATH, "utf8");
  const at = doc.indexOf("/api/v1/projects/{id}/reference-candidates:");
  assert.ok(at >= 0, "reference-candidates is documented");
  const rest = doc.slice(at + 10);
  const next = rest.search(/\n {2}\/api\/v1\//);
  const block = next < 0 ? rest : rest.slice(0, next);
  assert.match(block, /\n {4}get:/);
  assert.doesNotMatch(block, /\n {4}(post|put|patch|delete):/, "a read, not a write");
  for (const word of ["candidates", "attached", "recommended", "approved"]) assert.ok(block.includes(word), `the description names ${word}`);
});

test("stage-1-api names the route and its human-only rule", () => {
  const doc = readFileSync(new URL("../docs/plan/stage-1-api.md", import.meta.url), "utf8");
  assert.ok(doc.includes("reference-candidates"), "stage-1-api documents GET P/reference-candidates");
});

// ---------------------------------------------------------------------------
// 모양

test("GET reference-candidates: empty when the user has no other project; the envelope is the usual one", async () => {
  await with_api(async (env) => {
    const res = await get(env);
    const data = assert_ok(res);
    assert.deepEqual(Object.keys(data), ["candidates"]);
    assert.deepEqual(data.candidates, []);
    assert.equal(res.json.replayed, undefined, "a GET carries no replayed");
  });
});

test("a member project is a candidate: five keys, key = project id, label = topic (else slug), snapshots with five keys, label null, nothing invented", async () => {
  await with_api(async (env) => {
    const src = await make_source(env, "s1");
    grant_access(env, src);
    const list = await candidates_of(env);
    assert.equal(list.length, 1);
    const c = list[0];
    assert.deepEqual(Object.keys(c).sort(), CANDIDATE_KEYS);
    assert.equal(c.project_id, src.p.project_id);
    assert.equal(c.key, src.p.project_id, "same as REF1a referenced_project_key");
    const row = env.db.get<{ slug: string; topic: string }>("SELECT slug, topic FROM projects WHERE id = ?", src.p.project_id)!;
    assert.equal(c.label, row.topic.trim().length > 0 ? row.topic : row.slug, "same rule as the default source_label of reference.attach");
    assert.equal(c.attached, false);
    assert.equal(c.snapshots.length, 1);
    const s = c.snapshots[0];
    assert.deepEqual(Object.keys(s).sort(), SNAPSHOT_KEYS);
    assert.equal(s.id, src.snapshot_id);
    assert.equal(s.key, src.snapshot_id, "same as REF1a source_snapshot_key");
    assert.equal(s.label, null, "the server has no snapshot name — null, not made up");
    assert.equal(s.approved, false, "an edition snapshot nobody approved is not an approved version");
    assert.equal(s.recommended, true, "the only snapshot is the recommended one");
  });
});

test("a source with a topic uses the topic as label; a blank topic falls back to the slug", async () => {
  await with_api(async (env) => {
    const a = await make_source(env, "l1");
    const b = await make_source(env, "l2");
    grant_access(env, a);
    grant_access(env, b);
    env.db.run("UPDATE projects SET topic = ? WHERE id = ?", "합성 주제 라벨", a.p.project_id);
    env.db.run("UPDATE projects SET topic = ? WHERE id = ?", "   ", b.p.project_id);
    const list = await candidates_of(env);
    const slug_b = env.db.get<{ slug: string }>("SELECT slug FROM projects WHERE id = ?", b.p.project_id)!.slug;
    assert.equal(list.find((c) => c.project_id === a.p.project_id).label, "합성 주제 라벨");
    assert.equal(list.find((c) => c.project_id === b.p.project_id).label, slug_b);
  });
});

test("candidates come in the order the projects were made; a project with no snapshot stays with snapshots: []", async () => {
  await with_api(async (env) => {
    const a = await make_source(env, "o1");
    const b = await make_source(env, "o2");
    const c = await make_source(env, "o3");
    for (const s of [a, b, c]) grant_access(env, s);
    env.db.run("DELETE FROM snapshots WHERE project_id = ?", b.p.project_id);
    const list = await candidates_of(env);
    assert.deepEqual(ids_of(list), [a.p.project_id, b.p.project_id, c.p.project_id]);
    assert.deepEqual(list[1].snapshots, []);
    assert.equal(list[0].snapshots.length, 1);
  });
});

// ---------------------------------------------------------------------------
// 자기 자신 · 권한

test("the project itself is never a candidate, even though its owner is a member", async () => {
  await with_api(async (env) => {
    const src = await make_source(env, "self");
    grant_access(env, src);
    const list = await candidates_of(env);
    assert.ok(!ids_of(list).includes(env.p.project_id));
    assert.deepEqual(ids_of(list), [src.p.project_id]);
  });
});

test("a project the user is not a member of is absent — no name, id or snapshot id anywhere in the response; membership brings it in, losing it takes it out", async () => {
  await with_api(async (env) => {
    const mine = await make_source(env, "p1");
    const secret = await make_source(env, "p2");
    grant_access(env, mine);
    const secret_names = names_of(env, secret);
    const res = await get(env);
    const list = assert_ok(res).candidates;
    assert.deepEqual(ids_of(list), [mine.p.project_id]);
    assert.equal(leaks(res, secret, secret_names), false, "the unreachable project leaves no trace");
    assert.equal(list.length, 1, "not even a placeholder row");

    grant_access(env, secret);
    assert.deepEqual(ids_of(await candidates_of(env)), [mine.p.project_id, secret.p.project_id]);
    revoke_access(env, secret);
    const after = await get(env);
    assert.deepEqual(ids_of(assert_ok(after).candidates), [mine.p.project_id]);
    assert.equal(leaks(after, secret, secret_names), false, "after losing membership the name and id are gone again");
  });
});

test("every membership role counts (editor, reader; a project has one owner, who is someone else) — the same is_member rule as REF1a", async () => {
  await with_api(async (env) => {
    const a = await make_source(env, "r1");
    const b = await make_source(env, "r2");
    grant_access(env, a, "editor");
    grant_access(env, b, "reader");
    assert.deepEqual(ids_of(await candidates_of(env)).sort(), [a, b].map((s) => s.p.project_id).sort());
  });
});

test("it agrees with the REF1a decision: a source the user is in is attachable, one the user is not in is not offered (and attach is refused)", async () => {
  await with_api(async (env) => {
    const inside = await make_source(env, "d1");
    const outside = await make_source(env, "d2");
    grant_access(env, inside);
    const offered = ids_of(await candidates_of(env));
    assert.deepEqual(offered, [inside.p.project_id]);
    const attach = (src: Source) => call(env, { method: "POST", path: P(env, "/references"), auth: "owner", body: { referenced_project_id: src.p.project_id, source_snapshot_id: src.snapshot_id } });
    assert_ok(await attach(inside), 201);
    const refused = await attach(outside);
    assert_error(refused, 404, "not_found");
  });
});

test("Go OFF does not hide a project from the person (REF1a decide: the owner session is not affected) — source Go off, this project's Go off, both", async () => {
  await with_api(async (env) => {
    const src = await make_source(env, "go1");
    grant_access(env, src);
    await source_go(env, src, false, "go1-src-off");
    assert.deepEqual(ids_of(await candidates_of(env)), [src.p.project_id], "source Go off");
    await current_go(env, false, "go1-cur-off");
    assert.deepEqual(ids_of(await candidates_of(env)), [src.p.project_id], "both off");
    await source_go(env, src, true, "go1-src-on");
    assert.deepEqual(ids_of(await candidates_of(env)), [src.p.project_id], "only this project's Go off");
  });
});

test("an archived project is not a candidate; the other projects are unaffected", async () => {
  await with_api(async (env) => {
    const live = await make_source(env, "ar1");
    const old = await make_source(env, "ar2");
    grant_access(env, live);
    grant_access(env, old);
    const old_names = names_of(env, old);
    env.db.run("UPDATE projects SET status = 'archived' WHERE id = ?", old.p.project_id);
    const res = await get(env);
    assert.deepEqual(ids_of(assert_ok(res).candidates), [live.p.project_id]);
    assert.equal(leaks(res, old, old_names), false, "the archived project's name and id do not appear");
  });
});

// ---------------------------------------------------------------------------
// attached

test("attached is true for a project already attached (matched by project id), false for the rest; detaching clears it", async () => {
  await with_api(async (env) => {
    const a = await make_source(env, "t1");
    const b = await make_source(env, "t2");
    grant_access(env, a);
    grant_access(env, b);
    const ref = await attach_ref(env, a, "t-att");
    let list = await candidates_of(env);
    assert.deepEqual(list.map((c) => [c.project_id, c.attached]), [[a.p.project_id, true], [b.p.project_id, false]], "an attached project stays in the list, marked — not hidden");
    await ok(env, env.ctx("t-det"), "reference.detach", { reference_id: ref.reference_id });
    list = await candidates_of(env);
    assert.deepEqual(list.map((c) => c.attached), [false, false]);
  });
});

test("attached looks at this project's references only: another project's reference to the source does not count", async () => {
  await with_api(async (env) => {
    const a = await make_source(env, "t3");
    const other = await make_source(env, "t4");
    grant_access(env, a);
    grant_access(env, other);
    // `other` (a different project) attaches `a`; this project (env.p) has attached nothing
    env.db.run("INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, 'editor')", a.p.project_id, owner_user_of(env.db, other.p.project_id));
    await ok(env, ctx_for(other.p, "t-foreign"), "reference.attach", { referenced_project_id: a.p.project_id, source_snapshot_id: a.snapshot_id });
    assert.equal(refs_of(env.db, other.p.project_id), 1);
    assert.equal(refs_of(env.db, env.p.project_id), 0);
    assert.deepEqual((await candidates_of(env)).map((c) => c.attached), [false, false]);
  });
});

// ---------------------------------------------------------------------------
// 스냅숏 · 추천 · 승인

test("snapshots are newest first; approval comes from the approvals table; recommended is the newest APPROVED one (not the newest)", async () => {
  await with_api(async (env) => {
    const src = await make_source(env, "sn1");
    grant_access(env, src);
    const approved = await approve_source(env, src, "sn1-ap", [{ object_id: src.report.object_id, version_id: src.report.version_id }]);
    const v2 = await add_new_version(env, src, 2);
    const list = await candidates_of(env);
    const snaps: any[] = list[0].snapshots;
    assert.deepEqual(snaps.map((s) => s.id), [v2.snapshot_id, approved, src.snapshot_id], "newest first");
    assert.deepEqual(snaps.map((s) => s.approved), [false, true, false]);
    assert.deepEqual(snaps.map((s) => s.recommended), [false, true, false], "the approved version is recommended although a newer one exists");
    for (const s of snaps) assert.deepEqual(Object.keys(s).sort(), SNAPSHOT_KEYS);
    assert.equal(snaps.filter((s) => s.recommended).length, 1, "exactly one recommended per project");
  });
});

test("with no approved snapshot the newest one is recommended; still exactly one", async () => {
  await with_api(async (env) => {
    const src = await make_source(env, "sn2");
    grant_access(env, src);
    const v2 = await add_new_version(env, src, 2);
    const v3 = await add_new_version(env, src, 3);
    const snaps: any[] = (await candidates_of(env))[0].snapshots;
    assert.deepEqual(snaps.map((s) => s.id), [v3.snapshot_id, v2.snapshot_id, src.snapshot_id]);
    assert.deepEqual(snaps.map((s) => s.approved), [false, false, false]);
    assert.deepEqual(snaps.map((s) => s.recommended), [true, false, false]);
  });
});

test("with two approved snapshots the later approved one is recommended and both say approved", async () => {
  await with_api(async (env) => {
    const src = await make_source(env, "sn3");
    grant_access(env, src);
    const first = await approve_source(env, src, "sn3-a1", [{ object_id: src.report.object_id, version_id: src.report.version_id }]);
    const v2 = await add_new_version(env, src, 2);
    const stage = stage_ids(env.db, src.p.edition_id);
    const second = (await (async () => {
      const round = (await start_round(env.service, ctx_for(src.p, "sn3-r2"), { stage_id: stage.research })).result as { round_id: string };
      const versions = [{ object_id: src.report.object_id, version_id: v2.version_id }];
      const blob = await put_ready(env, new TextEncoder().encode(JSON.stringify({ versions })), "sn3-mf2", src.p);
      const sealed = (await seal_round(env.service, ctx_for(src.p, "sn3-s2"), { round_id: round.round_id, manifest_blob_id: blob.blob_id, versions })).result as { snapshot_id: string };
      await approve_stage(env.service, ctx_for(src.p, "sn3-ap2"), { stage_id: stage.research, snapshot_id: sealed.snapshot_id });
      return sealed.snapshot_id;
    })());
    const snaps: any[] = (await candidates_of(env))[0].snapshots;
    const by_id = new Map(snaps.map((s) => [s.id, s]));
    assert.equal(by_id.get(first).approved, true);
    assert.equal(by_id.get(second).approved, true);
    assert.equal(by_id.get(src.snapshot_id).approved, false);
    assert.deepEqual(snaps.filter((s) => s.recommended).map((s) => s.id), [second]);
  });
});

test("a print snapshot is not offered (REF1a: a print is a human's fixed document, not a version to pin) and is never the recommended one", async () => {
  await with_api(async (env) => {
    const src = await make_source(env, "pr1");
    grant_access(env, src);
    const printed = (await env.service.execute(ctx_for(src.p, "pr1-print"), "print.commit", { scope: "edition" })).result as { snapshot_id: string };
    const snaps: any[] = (await candidates_of(env))[0].snapshots;
    assert.deepEqual(snaps.map((s) => s.id), [src.snapshot_id]);
    assert.ok(!snaps.some((s) => s.id === printed.snapshot_id));
    assert.equal(snaps[0].recommended, true);
    // every offered snapshot can really be pinned
    const att = await call(env, { method: "POST", path: P(env, "/references"), auth: "owner", body: { referenced_project_id: src.p.project_id, source_snapshot_id: snaps[0].id } });
    assert_ok(att, 201);
  });
});

test("snapshots of another project never mix in: each candidate lists only its own", async () => {
  await with_api(async (env) => {
    const a = await make_source(env, "mx1");
    const b = await make_source(env, "mx2");
    grant_access(env, a);
    grant_access(env, b);
    const v = await add_new_version(env, b, 2);
    const list = await candidates_of(env);
    const sa = list.find((c) => c.project_id === a.p.project_id).snapshots.map((s: any) => s.id);
    const sb = list.find((c) => c.project_id === b.p.project_id).snapshots.map((s: any) => s.id);
    assert.deepEqual(sa, [a.snapshot_id]);
    assert.deepEqual(sb, [v.snapshot_id, b.snapshot_id]);
  });
});

// ---------------------------------------------------------------------------
// 원본 삭제(tombstone) 와의 일관

test("a source that went away (reference.source_gone) is not offered again as a candidate by its tombstone: the row has no project id", async () => {
  await with_api(async (env) => {
    const a = await make_source(env, "tb1");
    const b = await make_source(env, "tb2");
    grant_access(env, a);
    grant_access(env, b);
    await attach_ref(env, a, "tb-att");
    await ok(env, { project_id: a.p.project_id, actor_id: a.p.actor_id, via: "cli", client_request_id: "tb-gone" }, "reference.source_gone", { referenced_project_id: a.p.project_id });
    // the tombstone keeps the pointer-free row; candidates are built from live projects and snapshots only
    const res = await get(env);
    const list: any[] = assert_ok(res).candidates;
    for (const c of list) {
      assert.ok(typeof c.project_id === "string" && c.project_id.length > 0, "no candidate without a project id");
      for (const s of c.snapshots) assert.ok(typeof s.id === "string" && s.id.length > 0, "no snapshot without an id");
    }
    assert.ok(ids_of(list).includes(b.p.project_id));
    // a project that is still a member project stays offered; its `attached` follows the project_references key (tombstone keeps it)
    const a_row = list.find((c) => c.project_id === a.p.project_id);
    assert.ok(a_row, "the source project is still a live member project, so its row stays");
    assert.equal(a_row.attached, true, "the tombstone still holds the key, so attaching it again is still a conflict");
  });
});

// ---------------------------------------------------------------------------
// 누가 읽는가

test("only the owner session reads: a token (any scope set) is 403 with no fact about other projects; no credential 401; unknown project 404", async () => {
  await with_api(async (env) => {
    const src = await make_source(env, "who1");
    grant_access(env, src);
    const names = names_of(env, src);
    const all = await make_agent(env, "who-all");
    const reader = await make_agent(env, "who-reader", ["context:read"]);
    const ai = await make_agent(env, "who-ai", ["context:read"], "internal_ai");
    for (const agent of [all, reader, ai]) {
      const res = await get(env, { token: agent.token });
      assert.equal(res.status, 403, "a non-human caller is refused");
      assert.equal(res.json.error.code, "human_required", "the documented code, and only that one");
      assert.equal(leaks(res, src, names), false, "the refusal names no project");
    }
    assert_error(await get(env, "none"), 401, "unauthenticated");
    assert_error(await call(env, { method: "GET", path: "/api/v1/projects/no-such-project" + PATH, auth: "owner" }), 404, "not_found");
  });
});

test("a token of another project gets the same 401 for an existing project and for a missing one: no existence leak", async () => {
  await with_api(async (env) => {
    const src = await make_source(env, "ex1");
    grant_access(env, src);
    const names = names_of(env, src);
    const other = await other_project_token(env, src, "ex1-other");
    const existing = await get(env, { token: other });
    const missing = await call(env, { method: "GET", path: "/api/v1/projects/no-such-project" + PATH, auth: { token: other } });
    const a = assert_error(existing, 401, "unauthenticated");
    const b = assert_error(missing, 401, "unauthenticated");
    assert.deepEqual(a.error, b.error, "the same error object whether the project exists or not");
    assert.equal(leaks(existing, src, names), false);
    assert.equal(leaks(missing, src, names), false);
  });
});

test("a token is refused even when Go is OFF on every side (fail closed), and the answer is the same as with Go on", async () => {
  await with_api(async (env) => {
    const src = await make_source(env, "who2");
    grant_access(env, src);
    const names = names_of(env, src);
    const reader = await make_agent(env, "who2-reader", ["context:read"]);
    const on = await get(env, { token: reader.token });
    await source_go(env, src, false, "who2-src-off");
    await current_go(env, false, "who2-cur-off");
    const off = await get(env, { token: reader.token });
    assert.equal(on.status, 403);
    assert.equal(off.status, 403);
    assert.equal(on.json.error.code, "human_required");
    assert.equal(off.json.error.code, on.json.error.code);
    assert.equal(leaks(off, src, names), false);
  });
});

test("write methods on the path are not routes: POST / PUT / DELETE are 404 or 405 and change nothing", async () => {
  await with_api(async (env) => {
    const src = await make_source(env, "who3");
    grant_access(env, src);
    const sig = state_signature(env.db);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await call(env, { method, path: P(env, PATH), auth: "owner", body: {} });
      assert.ok(res.status === 404 || res.status === 405, `${method} → ${res.status}`);
    }
    assert.equal(state_signature(env.db), sig);
  });
});

// ---------------------------------------------------------------------------
// 읽기라 부작용 0

test("a read writes nothing: no receipt, no event, no row anywhere; twice gives the same answer; also not for a refused token", async () => {
  await with_api(async (env) => {
    const a = await make_source(env, "z1");
    const b = await make_source(env, "z2");
    grant_access(env, a);
    grant_access(env, b);
    await attach_ref(env, a, "z-att");
    await approve_source(env, b, "z-ap", [{ object_id: b.report.object_id, version_id: b.report.version_id }]);
    const reader = await make_agent(env, "z-reader", ["context:read"]);
    const sig = state_signature(env.db);
    const first = assert_ok(await get(env));
    const second = assert_ok(await get(env));
    assert.deepEqual(second, first);
    assert.equal((await get(env, { token: reader.token })).status, 403);
    assert.equal(state_signature(env.db), sig, "state_signature covers every table, so receipts and events are included");
    const events = Number(env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM events")?.n ?? 0n);
    await get(env);
    assert.equal(Number(env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM events")?.n ?? 0n), events);
  });
});

// ---------------------------------------------------------------------------
// 질의 수

async function queries_for(projects: number, snapshots_each: number): Promise<number> {
  let count = 0;
  let counting = false;
  await with_api(
    async (env) => {
      for (let i = 0; i < projects; i += 1) {
        const src = await make_source(env, `q${projects}-${snapshots_each}-${i}`);
        grant_access(env, src);
        for (let n = 2; n <= snapshots_each; n += 1) await add_new_version(env, src, n);
      }
      counting = true;
      count = 0;
      assert_ok(await get(env));
      counting = false;
    },
    {
      wrap: (db: Db): Db => ({
        path: db.path,
        exec: (sql) => db.exec(sql),
        prepare: (sql) => db.prepare(sql),
        run: (sql, ...p) => {
          if (counting) count += 1;
          return db.run(sql, ...p);
        },
        get: (sql, ...p) => {
          if (counting) count += 1;
          return db.get(sql, ...p);
        },
        all: (sql, ...p) => {
          if (counting) count += 1;
          return db.all(sql, ...p);
        },
        close: () => db.close(),
      }),
    },
  );
  return count;
}

test("queries grow with the number of projects (a constant per project) and do not grow with the number of snapshots per project", async () => {
  const few = await queries_for(2, 1);
  const many = await queries_for(6, 1);
  const deep = await queries_for(2, 5);
  assert.ok(few > 0, "the read really goes through the counted database");
  assert.ok(many - few <= 4 * 6, `4 more projects added ${many - few} queries — at most 6 per project`);
  assert.ok(deep - few <= 2, `3 more snapshots in each of 2 projects added ${deep - few} queries — must not scale with snapshots`);
});
