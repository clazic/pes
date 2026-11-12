/**
 * SEL-113 REF1a — HTTP: POST/GET P/references · POST refresh · POST detach · GET P/context 의 references (tester, 작성 모드).
 * 구현 전에는 경로가 없어 404 라서 실패하는 것이 정상.
 *
 * 있던 것: 같은 파이프라인(세션 비밀 헤더·Bearer 토큰·Idempotency-Key·오류 봉투·context:read 범위·internal_ai 의 Go 게이트).
 * 없던 것: 아래 경로 전부와 OpenAPI 항목.
 *
 * 정한 인터페이스 (표 — 명령 쪽 표는 test_sel113_commands.test.ts 머리말)
 *
 *  경로                                   누가                      성공                          오류
 *  POST P/references                      소유자 세션만(토큰 403 human_required)   201 data.reference     400 invalid_payload(알 수 없는 칸·키 없음), 401, 404 알 수 없는 프로젝트,
 *       본문 {referenced_project_id, source_snapshot_id?, scope?, source_label?}                          422 validation_failed(target $.body.referenced_project_id | $.body.scope),
 *                                                                                                          404 not_found(원본/스냅숏 없음), 403 forbidden 또는 404(원본 접근 없음, 내용 0), 409 conflict(이미 붙임),
 *                                                                                                          409 idempotency_key_reuse
 *  GET  P/references                      세션 또는 context:read 토큰   200 data.references[]   (범위 없는 토큰 403 forbidden, 무자격 401)
 *  GET  P/references/{ref}                같음                      200 data = {reference, content}   접근 없음 403 forbidden · 모르는/다른 프로젝트의 ref 404 not_found
 *  POST P/references/{ref}/refresh        소유자 세션만             200 data.reference            404, 409 conflict(이미 그 버전·원본 없음), 409 rev_conflict
 *       본문 {source_snapshot_id?, base_rev?}
 *  POST P/references/{ref}/detach         소유자 세션만             200 data {reference_id, detached:true}   404
 *  GET  P/context                         기존                      data.references = 목록(본문 없음)
 *
 *  읽기 줄(references[] 한 줄): 키 열여섯 개 REF_KEYS — access('ok'|'no_permission'), ai_delivery{allowed, withheld_reason|null}, attached_at(ISO), attached_by_actor_id,
 *    id, latest_snapshot_id(원본의 지금 가장 나중 스냅숏|null), new_version_available(bool), referenced_project_id|null, referenced_project_key, refreshed_at(ISO|null),
 *    rev(10진 문자열), scope[], source_label, source_snapshot_id|null, source_snapshot_key|null,
 *    state('pinned'|'new_version'|'source_missing'|'source_archived'|'no_permission').
 *    권한 없는 줄은 키 세 개뿐 {id, access:'no_permission', state:'no_permission'} — 이름·key·label·버전 id 어느 것도 없다.
 *  content = {items:[…]} | null. 항목 = {item:'final_report'|'sources', object_id, version_id, kind, title, …본문 칸, citation:{reference_id, project_id, project_label, snapshot_id, object_id, version_id}}.
 *    final_report 는 보고서 artifact 의 title·summary·body_md, sources 는 출처의 title·url·quote. scope 에 없는 항목은 content 에 없다.
 *    content 는 **고정한 스냅숏의 그 버전**이다(원본이 새 버전을 만들어도 바뀌지 않는다). 원본 없음/접근 없음이면 null.
 *  읽기는 부작용이 없다(GET 두 번 사이에 DB 가 변하지 않는다).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { assert_error, assert_ok, call, make_agent, OPENAPI_PATH, with_api, type ApiEnv, type ApiResponse, type Auth } from "./helpers/api_env.ts";
import { P, assert_final_error } from "./helpers/api_flow.ts";
import {
  DEFAULT_SCOPE,
  REF_KEYS,
  REF_NOPERM_KEYS,
  add_new_version,
  attached,
  grant_access,
  has_text,
  make_source,
  ref_count,
  ref_row,
  revoke_access,
  type Source,
} from "./helpers/sel113_env.ts";
import { ok } from "./helpers/sel93_env.ts";
import { state_signature } from "./helpers/state_signature.ts";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const DEC = /^(0|[1-9][0-9]*)$/;

const post = (env: ApiEnv, rest: string, auth: Auth, body: unknown, key?: string) =>
  call(env, { method: "POST", path: P(env, rest), auth, body, ...(key === undefined ? {} : { key }) });
const get = (env: ApiEnv, rest: string, auth: Auth = "owner") => call(env, { method: "GET", path: P(env, rest), auth });

async function api_attach(env: ApiEnv, src: Source, body: Record<string, unknown> = {}): Promise<any> {
  return assert_ok(await post(env, "/references", "owner", { referenced_project_id: src.p.project_id, source_snapshot_id: src.snapshot_id, ...body }), 201).reference;
}

/** 접근을 주고 HTTP 로 붙인 참고자료 하나. */
async function with_ref(env: ApiEnv, tag: string, body: Record<string, unknown> = {}): Promise<{ src: Source; ref: any }> {
  const src = await make_source(env, tag);
  grant_access(env, src);
  return { src, ref: await api_attach(env, src, body) };
}

function markers_in(res: ApiResponse, src: Source): boolean {
  const text = JSON.stringify(res.json) + (res.bytes === null ? "" : Buffer.from(res.bytes).toString("utf8"));
  return [src.report_marker, src.source_marker, src.p.project_id, src.snapshot_id].some((m) => text.includes(m));
}

// ---------------------------------------------------------------------------
// OpenAPI

test("OpenAPI documents the four reference paths with the right methods", () => {
  const doc = readFileSync(OPENAPI_PATH, "utf8");
  const wants: Array<[string, string[]]> = [
    ["references", ["get", "post"]],
    ["references/{ref}", ["get"]],
    ["references/{ref}/refresh", ["post"]],
    ["references/{ref}/detach", ["post"]],
  ];
  for (const [route, methods] of wants) {
    const at = doc.indexOf(`/api/v1/projects/{id}/${route}:`);
    assert.ok(at >= 0, `${route} is documented`);
    const rest = doc.slice(at + 10);
    const next = rest.search(/\n {2}\/api\/v1\//);
    const block = next < 0 ? rest : rest.slice(0, next);
    for (const m of methods) assert.match(block, new RegExp(`\\n {4}${m}:`), `${route}: ${m}`);
  }
});

// ---------------------------------------------------------------------------
// attach

test("POST references: 201 with the sixteen documented keys, pinned state, default items, ISO/decimal formats; the row exists", async () => {
  await with_api(async (env) => {
    const { src, ref } = await with_ref(env, "h1");
    assert.deepEqual(Object.keys(ref).sort(), [...REF_KEYS].sort());
    assert.equal(ref.access, "ok");
    assert.equal(ref.state, "pinned");
    assert.equal(ref.new_version_available, false);
    assert.equal(ref.referenced_project_id, src.p.project_id);
    assert.equal(ref.referenced_project_key, src.p.project_id);
    assert.equal(ref.source_snapshot_id, src.snapshot_id);
    assert.equal(ref.source_snapshot_key, src.snapshot_id);
    assert.equal(ref.latest_snapshot_id, src.snapshot_id);
    assert.deepEqual(ref.scope, DEFAULT_SCOPE);
    assert.match(ref.attached_at, ISO);
    assert.equal(ref.refreshed_at, null);
    assert.match(ref.rev, DEC);
    assert.equal(ref.attached_by_actor_id, env.p.actor_id);
    assert.equal(typeof ref.source_label, "string");
    assert.deepEqual(ref.ai_delivery, { allowed: true, withheld_reason: null });
    assert.equal(ref_row(env.db, ref.id)!.status, "active");
  });
});

test("POST references: Idempotency-Key is required; the same key and body replays; another body under the key is 409 idempotency_key_reuse; unauthenticated 401; unknown project 404", async () => {
  await with_api(async (env) => {
    const a = await make_source(env, "h2a");
    const b = await make_source(env, "h2b");
    grant_access(env, a);
    grant_access(env, b);
    const body = { referenced_project_id: a.p.project_id, source_snapshot_id: a.snapshot_id };
    assert_final_error(await call(env, { method: "POST", path: P(env, "/references"), auth: "owner", body, key: null }), 400, "invalid_payload");
    const first = await post(env, "/references", "owner", body, "ref-k1");
    const again = await post(env, "/references", "owner", body, "ref-k1");
    assert_ok(first, 201);
    assert_ok(again, 201);
    assert.equal(again.json.replayed, true);
    assert.deepEqual(again.json.data, first.json.data);
    assert.equal(ref_count(env.db), 1);
    assert_final_error(await post(env, "/references", "owner", { referenced_project_id: b.p.project_id }, "ref-k1"), 409, "idempotency_key_reuse");
    assert_error(await post(env, "/references", "none", body, "ref-k2"), 401, "unauthenticated");
    const unknown = await call(env, { method: "POST", path: "/api/v1/projects/no-such-project/references", auth: "owner", body, key: "ref-k3" });
    assert_error(unknown, 404, "not_found");
    assert.equal(ref_count(env.db), 1);
  });
});

test("POST references: only the owner session attaches — an agent token (even with every scope) is 403 human_required and nothing is written", async () => {
  await with_api(async (env) => {
    const src = await make_source(env, "h3");
    grant_access(env, src);
    const agent = await make_agent(env, "attacher");
    const sig = state_signature(env.db);
    assert_final_error(await post(env, "/references", { token: agent.token }, { referenced_project_id: src.p.project_id }), 403, "human_required");
    assert.equal(state_signature(env.db), sig);
  });
});

test("POST references: bad requests — self 422, unknown source/snapshot/foreign snapshot 404, bad items 422, unknown field 400, duplicate 409; none writes", async () => {
  await with_api(async (env) => {
    const a = await make_source(env, "h4a");
    const b = await make_source(env, "h4b");
    grant_access(env, a);
    grant_access(env, b);
    await api_attach(env, a);
    const sig = state_signature(env.db);
    assert_final_error(await post(env, "/references", "owner", { referenced_project_id: env.p.project_id }), 422, "validation_failed", { target: "$.body.referenced_project_id" });
    assert_final_error(await post(env, "/references", "owner", { referenced_project_id: "no-such-project" }), 404, "not_found");
    assert_final_error(await post(env, "/references", "owner", { referenced_project_id: b.p.project_id, source_snapshot_id: "no-such" }), 404, "not_found");
    assert_final_error(await post(env, "/references", "owner", { referenced_project_id: b.p.project_id, source_snapshot_id: a.snapshot_id }), 404, "not_found");
    for (const scope of [[], ["nope"], ["sources", "sources"], "sources"]) {
      assert_final_error(await post(env, "/references", "owner", { referenced_project_id: b.p.project_id, scope }), 422, "validation_failed", { target: "$.body.scope" });
    }
    assert_final_error(await post(env, "/references", "owner", { referenced_project_id: b.p.project_id, surprise: 1 }), 400, "invalid_payload");
    assert_final_error(await post(env, "/references", "owner", { source_snapshot_id: b.snapshot_id }), 422, "validation_failed", { target: "$.body.referenced_project_id" });
    assert_final_error(await post(env, "/references", "owner", { referenced_project_id: a.p.project_id }), 409, "conflict");
    assert.equal(state_signature(env.db), sig, "no refusal wrote anything");
  });
});

test("POST references without access to the source: refused (403 forbidden or 404), no content, no receipt — then it works once access is granted", async () => {
  await with_api(async (env) => {
    const src = await make_source(env, "h5");
    const sig = state_signature(env.db);
    const res = await post(env, "/references", "owner", { referenced_project_id: src.p.project_id, source_snapshot_id: src.snapshot_id });
    assert.ok(res.status === 403 || res.status === 404, `expected 403/404, got ${res.status}`);
    assert.ok(["forbidden", "not_found"].includes(res.json.error.code));
    assert.equal(markers_in(res, src), false, "the refusal reveals nothing of the source");
    assert.equal(state_signature(env.db), sig);
    grant_access(env, src);
    assert_ok(await post(env, "/references", "owner", { referenced_project_id: src.p.project_id, source_snapshot_id: src.snapshot_id }), 201);
  });
});

// ---------------------------------------------------------------------------
// reads

test("GET references: a list of the sixteen-key rows; empty before any attach; the read changes nothing", async () => {
  await with_api(async (env) => {
    assert.deepEqual(assert_ok(await get(env, "/references")).references, []);
    const a = await with_ref(env, "g1a");
    const b = await with_ref(env, "g1b", { scope: ["sources"] });
    const sig = state_signature(env.db);
    const first = assert_ok(await get(env, "/references"));
    const second = assert_ok(await get(env, "/references"));
    assert.deepEqual(second, first, "reading twice gives the same answer");
    assert.equal(state_signature(env.db), sig, "a GET is not a write");
    assert.equal(first.references.length, 2);
    for (const row of first.references) assert.deepEqual(Object.keys(row).sort(), [...REF_KEYS].sort());
    assert.deepEqual(first.references.map((r: any) => r.id), [a.ref.id, b.ref.id], "attach order");
    assert.deepEqual(first.references[1].scope, ["sources"]);
  });
});

test("GET references/{ref}: pinned content with a citation (project, label, snapshot, object, version) on every item; only the chosen items", async () => {
  await with_api(async (env) => {
    const { src, ref } = await with_ref(env, "g2");
    const data = assert_ok(await get(env, `/references/${ref.id}`));
    assert.deepEqual(Object.keys(data).sort(), ["content", "reference"]);
    assert.deepEqual(data.reference, assert_ok(await get(env, "/references")).references[0]);
    const items: any[] = data.content.items;
    const report = items.find((i) => i.item === "final_report");
    const source = items.find((i) => i.item === "sources");
    assert.ok(report && source, "default items: final report and sources");
    assert.equal(items.length, 2);
    assert.equal(report.version_id, src.report.version_id);
    assert.match(report.title, new RegExp(src.report_marker));
    assert.match(report.body_md, new RegExp(src.report_marker));
    assert.match(source.quote, new RegExp(src.source_marker));
    for (const item of items) {
      assert.deepEqual(Object.keys(item.citation).sort(), ["object_id", "project_id", "project_label", "reference_id", "snapshot_id", "version_id"]);
      assert.equal(item.citation.reference_id, ref.id);
      assert.equal(item.citation.project_id, src.p.project_id, "which project is cited");
      assert.equal(item.citation.snapshot_id, src.snapshot_id, "which snapshot");
      assert.equal(item.citation.version_id, item.version_id, "which version");
      assert.equal(item.citation.object_id, item.object_id);
      assert.equal(item.citation.project_label, ref.source_label);
    }
  });
});

test("scope limits the content: sources-only has no report text anywhere in the response", async () => {
  await with_api(async (env) => {
    const { src, ref } = await with_ref(env, "g3", { scope: ["sources"] });
    const res = await get(env, `/references/${ref.id}`);
    const data = assert_ok(res);
    assert.deepEqual(data.content.items.map((i: any) => i.item), ["sources"]);
    assert.ok(!JSON.stringify(res.json).includes(src.report_marker), "the report is not in the response");
    assert.ok(JSON.stringify(res.json).includes(src.source_marker));
  });
});

test("version pinning: the source gets a newer version — the content stays on the pinned one, the row says 'new_version'; the person refreshes and the content moves, the old snapshot is untouched", async () => {
  await with_api(async (env) => {
    const { src, ref } = await with_ref(env, "g4");
    const v2 = await add_new_version(env, src, 2);
    let row = assert_ok(await get(env, "/references")).references[0];
    assert.equal(row.state, "new_version");
    assert.equal(row.new_version_available, true);
    assert.equal(row.latest_snapshot_id, v2.snapshot_id);
    assert.equal(row.source_snapshot_id, src.snapshot_id, "no automatic update");
    let res = await get(env, `/references/${ref.id}`);
    assert.ok(JSON.stringify(res.json).includes(src.report_marker), "still the pinned version");
    assert.ok(!JSON.stringify(res.json).includes(v2.marker), "the new version is not shown until refreshed");

    const refreshed = assert_ok(await post(env, `/references/${ref.id}/refresh`, "owner", { source_snapshot_id: v2.snapshot_id }));
    assert.equal(refreshed.reference.state, "pinned");
    assert.equal(refreshed.reference.source_snapshot_id, v2.snapshot_id);
    assert.equal(refreshed.reference.new_version_available, false);
    assert.equal(refreshed.reference.rev, "1");
    assert.match(refreshed.reference.refreshed_at, ISO);
    res = await get(env, `/references/${ref.id}`);
    assert.ok(JSON.stringify(res.json).includes(v2.marker));
    const item = assert_ok(res).content.items.find((i: any) => i.item === "final_report");
    assert.equal(item.citation.snapshot_id, v2.snapshot_id, "the citation names the new pinned snapshot");
    assert.ok(env.db.get("SELECT 1 FROM snapshots WHERE id = ?", src.snapshot_id), "the old snapshot is still there");
  });
});

test("refresh without a body goes to the newest; an already-newest pin is 409 conflict; a stale base_rev is 409 rev_conflict; agent token is 403 human_required; unknown ref 404", async () => {
  await with_api(async (env) => {
    const { src, ref } = await with_ref(env, "g5");
    const agent = await make_agent(env, "refresher");
    assert_final_error(await post(env, `/references/${ref.id}/refresh`, "owner", {}), 409, "conflict");
    const v2 = await add_new_version(env, src, 2);
    assert_final_error(await post(env, `/references/${ref.id}/refresh`, { token: agent.token }, {}), 403, "human_required");
    assert_final_error(await post(env, `/references/${ref.id}/refresh`, "owner", { base_rev: "7" }), 409, "rev_conflict");
    assert_final_error(await post(env, "/references/no-such/refresh", "owner", {}), 404, "not_found");
    const out = assert_ok(await post(env, `/references/${ref.id}/refresh`, "owner", { base_rev: "0" }));
    assert.equal(out.reference.source_snapshot_id, v2.snapshot_id);
    const actions = env.db.all<{ action: string }>("SELECT action FROM mutation_commits WHERE project_id = ?", env.p.project_id).map((r) => r.action);
    assert.ok(actions.filter((a) => /^reference\./.test(a)).length >= 2, "attach and refresh each left a receipt");
  });
});

test("detach removes the row; a replay is safe; unknown 404; agent 403; the source project is unchanged", async () => {
  await with_api(async (env) => {
    const { src, ref } = await with_ref(env, "g6");
    const agent = await make_agent(env, "detacher");
    assert_final_error(await post(env, `/references/${ref.id}/detach`, { token: agent.token }, {}), 403, "human_required");
    const a = await post(env, `/references/${ref.id}/detach`, "owner", {}, "det-key");
    const b = await post(env, `/references/${ref.id}/detach`, "owner", {}, "det-key");
    assert.deepEqual(assert_ok(a), { reference_id: ref.id, detached: true });
    assert.equal(b.json.replayed, true);
    assert.deepEqual(assert_ok(await get(env, "/references")).references, []);
    assert.equal(ref_row(env.db, ref.id), undefined);
    assert_final_error(await post(env, `/references/${ref.id}/detach`, "owner", {}), 404, "not_found");
    assert.ok(env.db.get("SELECT 1 FROM snapshots WHERE id = ?", src.snapshot_id), "the source snapshot stays");
    assert_final_error(await get(env, `/references/${ref.id}`), 404, "not_found");
  });
});

// ---------------------------------------------------------------------------
// who may read

test("a token reads references only with context:read (403 forbidden otherwise, 401 without a credential); a token with it sees the same rows as the owner", async () => {
  await with_api(async (env) => {
    const { src, ref } = await with_ref(env, "w1");
    const reader = await make_agent(env, "reader", ["context:read"]);
    const writer = await make_agent(env, "writer", ["run:submit"]);
    const owner_rows = assert_ok(await get(env, "/references")).references;
    const token_rows = assert_ok(await get(env, "/references", { token: reader.token })).references;
    assert.deepEqual(token_rows, owner_rows);
    const one = assert_ok(await get(env, `/references/${ref.id}`, { token: reader.token }));
    assert.equal(one.content.items.length, 2);
    for (const path of ["/references", `/references/${ref.id}`]) {
      assert_final_error(await get(env, path, { token: writer.token }), 403, "forbidden");
      assert_error(await get(env, path, "none"), 401, "unauthenticated");
    }
    void src;
  });
});

test("a reference of another project is invisible: 404 for its id, and not in the list", async () => {
  await with_api(async (env) => {
    const mine = await with_ref(env, "w2");
    const res = await call(env, {
      method: "GET",
      path: `/api/v1/projects/${mine.src.p.project_id}/references/${mine.ref.id}`,
      auth: "owner",
    });
    assert_error(res, 404, "not_found");
    const list = assert_ok(await call(env, { method: "GET", path: `/api/v1/projects/${mine.src.p.project_id}/references`, auth: "owner" }));
    assert.deepEqual(list.references, []);
  });
});

test("permission revoked: the list shows only 'no permission' (3 keys), the one-read is 403, and neither the owner session nor a context:read token gets a byte of the source", async () => {
  await with_api(async (env) => {
    const { src, ref } = await with_ref(env, "w3");
    const reader = await make_agent(env, "reader3", ["context:read"]);
    revoke_access(env, src);
    for (const auth of ["owner" as Auth, { token: reader.token } as Auth]) {
      const list = await get(env, "/references", auth);
      const rows = assert_ok(list).references;
      assert.equal(rows.length, 1);
      assert.deepEqual(Object.keys(rows[0]).sort(), [...REF_NOPERM_KEYS].sort());
      assert.equal(rows[0].id, ref.id);
      assert.equal(rows[0].access, "no_permission");
      assert.equal(rows[0].state, "no_permission");
      assert.equal(markers_in(list, src), false, "no name, key, label or content in the list");
      const one = await get(env, `/references/${ref.id}`, auth);
      assert_final_error(one, 403, "forbidden");
      assert.equal(markers_in(one, src), false);
    }
    const ctx = await get(env, "/context");
    assert.equal(markers_in(ctx, src), false, "the project context leaks nothing either");
    grant_access(env, src);
    assert.equal(assert_ok(await get(env, "/references")).references[0].access, "ok", "access back → readable again");
  });
});

test("a refresh by someone who lost access to the source is refused (the pin does not move)", async () => {
  await with_api(async (env) => {
    const { src, ref } = await with_ref(env, "w4");
    const v2 = await add_new_version(env, src, 2);
    revoke_access(env, src);
    const sig = state_signature(env.db);
    const res = await post(env, `/references/${ref.id}/refresh`, "owner", { source_snapshot_id: v2.snapshot_id });
    assert.ok(res.status === 403 || res.status === 404, `expected 403/404, got ${res.status}`);
    assert.equal(markers_in(res, src), false);
    assert.equal(state_signature(env.db), sig);
    assert.equal(ref_row(env.db, ref.id)!.source_snapshot_id, src.snapshot_id);
  });
});

// ---------------------------------------------------------------------------
// source gone

test("source gone: the row stays with its name and last pinned version, state 'source_missing', content null — the read says 'original gone', not an error", async () => {
  await with_api(async (env) => {
    const { src, ref } = await with_ref(env, "m1");
    await ok(env, { project_id: src.p.project_id, actor_id: src.p.actor_id, via: "cli", client_request_id: "m1-gone" }, "reference.source_gone", { referenced_project_id: src.p.project_id });
    const list = assert_ok(await get(env, "/references")).references;
    assert.equal(list.length, 1);
    const row = list[0];
    assert.deepEqual(Object.keys(row).sort(), [...REF_KEYS].sort());
    assert.equal(row.state, "source_missing");
    assert.equal(row.new_version_available, false);
    assert.equal(row.source_label, ref.source_label, "the name is kept");
    assert.equal(row.source_snapshot_key, src.snapshot_id, "the last pinned version is still identifiable");
    assert.equal(row.referenced_project_key, src.p.project_id);
    assert.equal(row.source_snapshot_id, null);
    assert.equal(row.referenced_project_id, null);
    assert.equal(row.latest_snapshot_id, null);
    const res = await get(env, `/references/${ref.id}`);
    const one = assert_ok(res);
    assert.equal(one.reference.state, "source_missing");
    assert.equal(one.content, null, "no content once the original is gone");
    assert.ok(!JSON.stringify(res.json).includes(src.report_marker));
    assert_final_error(await post(env, `/references/${ref.id}/refresh`, "owner", {}), 409, "conflict");
    assert_ok(await post(env, `/references/${ref.id}/detach`, "owner", {}));
  });
});

// ---------------------------------------------------------------------------
// context

test("GET context carries the reference list (rows only, no bodies) for the owner and for a context:read token", async () => {
  await with_api(async (env) => {
    const { src, ref } = await with_ref(env, "c1");
    const reader = await make_agent(env, "ctx-reader", ["context:read"]);
    const owner = await get(env, "/context");
    const token = await get(env, "/context", { token: reader.token });
    for (const res of [owner, token]) {
      const data = assert_ok(res);
      assert.ok(Array.isArray(data.references), "references is part of the context");
      assert.equal(data.references.length, 1);
      assert.equal(data.references[0].id, ref.id);
      assert.equal(data.references[0].source_snapshot_id, src.snapshot_id);
      assert.ok(!JSON.stringify(res.json).includes(src.report_marker), "the list holds no report text");
      assert.ok(!JSON.stringify(res.json).includes(src.source_marker), "the list holds no source text");
    }
    assert.deepEqual(assert_ok(token).references, assert_ok(owner).references);
  });
});
