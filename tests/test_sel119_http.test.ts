/**
 * SEL-119 U6a — HTTP: GET P/print (순수 조회) 와 POST P/print/prepare · P/print/commit (tester, 작성 모드).
 * 구현 전에는 세 경로가 404/501 이라 실패하는 것이 정상. 명령의 의미(manifest 모양·기본 범위·포함/제외·롤백)는
 * test_sel119_commands.test.ts 가 맡고, 여기서는 **읽기가 순수한가, 고정본이 그대로 다시 나오는가, HTTP 매핑**을 본다.
 *
 * 정한 인터페이스 (경로 P = /api/v1/projects/{id}). 이슈가 "페이지 라우트냐 API 계약이냐"를 U6 에서 정하라고 했으므로 **API 계약에 등록**한다
 * (OpenAPI paths 3개 + capabilities routes + 닫힌 경로 목록 EXPECTED_ROUTES 가 같은 집합이 돼야 한다 — 기존 시험의 목록은 leader 승인으로 옮긴다).
 *
 *   GET  P/print?scope=round|stage|edition[&snapshot=<고정본 id>]     순수 조회. context:read 토큰 또는 소유자 세션.
 *        snapshot 을 주면 그 고정본, 안 주면 **그 scope 의 현재 라운드/단계/판에서 가장 나중에 만든 인쇄 고정본**.
 *        200 data = {
 *          snapshot: { id, scope, edition_id, stage_id|null, round_id|null, content_hash },
 *          manifest: <test_sel119_commands 머리말의 manifest>,
 *          output:   { blob_id, sha256, size, media_type: "text/html" },
 *          document: "<출력물 html 전체 문자열>"       // utf-8 바이트의 sha256 == output.sha256 == 저장된 blob 의 sha256
 *        }
 *        없는 고정본 · 인쇄 고정본이 아닌 snapshot(봉인/승인 snapshot) · scope 가 다른 고정본 · 아직 인쇄한 적 없음 → 404 not_found.
 *        scope 가 없거나 round|stage|edition 이 아니면(예: project) → 400 invalid_payload 또는 422 validation_failed.
 *        **호출 전후 모든 표(snapshot·blob·events·mutation_commits…)와 객체 폴더가 같다.**
 *   POST P/print/prepare  본문 = print.prepare 입력. 200 data = print.prepare 결과.   (사람 소유자 세션만; 에이전트 토큰은 403 forbidden)
 *   POST P/print/commit   본문 = print.commit 입력.  201 data = print.commit 결과.     (같음)
 *        쓰기 공통: Idempotency-Key 필수(없으면 400 invalid_payload), 같은 키·같은 본문은 replayed:true, 다른 본문은 409 idempotency_key_reuse,
 *        무자격 401, 알 수 없는 프로젝트 404, 알 수 없는 필드 400 invalid_payload, 거절은 아무것도 쓰지 않는다.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { assert_error, assert_ok, call, make_agent, OPENAPI_PATH, with_api, type ApiEnv, type Auth } from "./helpers/api_env.ts";
import { P, assert_final_error } from "./helpers/api_flow.ts";
import { start } from "./helpers/editions_env.ts";
import { state_signature } from "./helpers/state_signature.ts";
import { art, blob_bytes, footprint, more, sealed_round, sha256_hex, stage_of } from "./helpers/sel119_env.ts";

const post = (env: ApiEnv, rest: string, auth: Auth, body: unknown, key?: string) =>
  call(env, { method: "POST", path: P(env, rest), auth, body, ...(key === undefined ? {} : { key }) });
const get = (env: ApiEnv, rest: string, auth: Auth = "owner") => call(env, { method: "GET", path: P(env, rest), auth });

async function open_scene(env: ApiEnv) {
  const plan = stage_of(env, "plan");
  const round = await start(env, plan, "h-start");
  const body = await art(env, "h-body", { stage_id: plan, body_md: "열린본문-알파", title: "열린제목-알파" });
  return { plan, round, body };
}

async function http_commit(env: ApiEnv, body: Record<string, unknown>, key?: string): Promise<any> {
  return assert_ok(await post(env, "/print/commit", "owner", body, key), 201);
}

// ---------------------------------------------------------------------------
// 순수 조회

test("GET print is a pure read: with or without snapshot, found or not, no table, no blob file, no event changes", async () => {
  await with_api(async (env) => {
    const s = await open_scene(env);
    const done = await http_commit(env, { scope: "round", round_id: s.round.round_id });
    const sig = state_signature(env.db);
    const fp = footprint(env);
    const calls = [
      `/print?scope=round&snapshot=${done.snapshot_id}`,
      "/print?scope=round",
      "/print?scope=stage",
      "/print?scope=edition",
      "/print?scope=round&snapshot=no-such",
      "/print?scope=project",
      "/print",
    ];
    for (const rest of calls) await get(env, rest);
    assert.equal(state_signature(env.db), sig, "a GET writes nothing anywhere");
    assert.deepEqual(footprint(env), fp);
  });
});

test("GET print before any print was committed is 404 and creates no snapshot or blob", async () => {
  await with_api(async (env) => {
    await open_scene(env);
    const sig = state_signature(env.db);
    for (const scope of ["round", "stage", "edition"]) assert_final_error(await get(env, `/print?scope=${scope}`), 404, "not_found");
    assert.equal(state_signature(env.db), sig);
    assert.equal(footprint(env).snapshots, 0);
    assert.equal(footprint(env).blobs, 0);
  });
});

test("GET print returns the stored print: snapshot, manifest, output descriptor, and the document whose bytes hash to the stored output", async () => {
  await with_api(async (env) => {
    const s = await open_scene(env);
    const done = await http_commit(env, { scope: "round", round_id: s.round.round_id });
    const data = assert_ok(await get(env, `/print?scope=round&snapshot=${done.snapshot_id}`));
    assert.deepEqual(Object.keys(data).sort(), ["document", "manifest", "output", "snapshot"]);
    assert.equal(data.snapshot.id, done.snapshot_id);
    assert.equal(data.snapshot.scope, "round");
    assert.equal(data.snapshot.round_id, s.round.round_id);
    assert.equal(data.snapshot.stage_id, s.plan);
    assert.equal(data.snapshot.content_hash, done.content_hash);
    assert.equal(data.manifest.kind, "print");
    assert.equal(data.manifest.output.blob_id, done.output_blob_id);
    assert.equal(data.output.blob_id, done.output_blob_id);
    assert.equal(data.output.media_type, "text/html");
    assert.equal(sha256_hex(data.document), data.output.sha256, "the document is exactly the stored output");
    assert.equal(sha256_hex(blob_bytes(env, done.output_blob_id)), data.output.sha256);
    assert.match(data.document, /열린본문-알파/);
  });
});

test("reprint: the same stored print gives the same response every time, even after the content and the round moved on", async () => {
  await with_api(async (env) => {
    const s = await open_scene(env);
    const done = await http_commit(env, { scope: "round", round_id: s.round.round_id });
    const url = `/print?scope=round&snapshot=${done.snapshot_id}`;
    const first = assert_ok(await get(env, url));
    await more(env, "h-edit", s.body.object_id, { body_md: "나중에고친본문", current: true });
    const later = await http_commit(env, { scope: "round", round_id: s.round.round_id }, "h-later");
    assert.notEqual(later.snapshot_id, done.snapshot_id);
    const second = assert_ok(await get(env, url));
    assert.deepEqual(second, first);
    assert.equal(sha256_hex(second.document), first.output.sha256);
    assert.doesNotMatch(second.document, /나중에고친본문/);
  });
});

test("without snapshot GET gives the latest print of the current round / stage / edition", async () => {
  await with_api(async (env) => {
    const s = await open_scene(env);
    const r1 = await http_commit(env, { scope: "round", round_id: s.round.round_id }, "l-r1");
    const st = await http_commit(env, { scope: "stage", stage_id: s.plan }, "l-st");
    const ed = await http_commit(env, { scope: "edition" }, "l-ed");
    assert.equal(assert_ok(await get(env, "/print?scope=round")).snapshot.id, r1.snapshot_id);
    assert.equal(assert_ok(await get(env, "/print?scope=stage")).snapshot.id, st.snapshot_id);
    assert.equal(assert_ok(await get(env, "/print?scope=edition")).snapshot.id, ed.snapshot_id);
    await more(env, "l-edit", s.body.object_id, { body_md: "더나중본문", current: true });
    const r2 = await http_commit(env, { scope: "round", round_id: s.round.round_id }, "l-r2");
    assert.equal(assert_ok(await get(env, "/print?scope=round")).snapshot.id, r2.snapshot_id, "the later print is the latest");
    assert.equal(assert_ok(await get(env, `/print?scope=round&snapshot=${r1.snapshot_id}`)).snapshot.id, r1.snapshot_id, "the older one is still there by id");
  });
});

test("GET print refuses what is not a stored print of that scope: unknown id, other scope, a plain seal snapshot, bad scope", async () => {
  await with_api(async (env) => {
    const plan = stage_of(env, "plan");
    const sealed = await sealed_round(env, plan, "g");
    const done = await http_commit(env, { scope: "stage", stage_id: plan });
    const sig = state_signature(env.db);
    assert_final_error(await get(env, "/print?scope=round&snapshot=no-such-snapshot"), 404, "not_found");
    assert_final_error(await get(env, `/print?scope=round&snapshot=${done.snapshot_id}`), 404, "not_found");
    assert_final_error(await get(env, `/print?scope=edition&snapshot=${done.snapshot_id}`), 404, "not_found");
    assert_final_error(await get(env, `/print?scope=round&snapshot=${sealed.snapshot_id}`), 404, "not_found");
    for (const rest of ["/print", "/print?scope=project", "/print?scope=all", "/print?scope="]) {
      const res = await get(env, rest);
      assert.ok(res.status === 400 || res.status === 422, `${rest}: ${res.status}`);
      assert.ok(["invalid_payload", "validation_failed"].includes(res.json.error.code), `${rest}: ${res.json.error.code}`);
    }
    assert.equal(state_signature(env.db), sig);
  });
});

test("GET print: no credential 401, any agent token 403 (a print is a human's document), the owner session reads, unknown project 404", async () => {
  await with_api(async (env) => {
    const s = await open_scene(env);
    const done = await http_commit(env, { scope: "round", round_id: s.round.round_id });
    const reader = await make_agent(env, "reader", ["context:read"]);
    const writer = await make_agent(env, "writeonly", ["run:submit"]);
    const url = `/print?scope=round&snapshot=${done.snapshot_id}`;
    assert_final_error(await get(env, url, "none"), 401, "unauthenticated");
    assert_final_error(await get(env, url, { token: writer.token }), 403, "forbidden");
    // leader 승인(SEL-119 사용자 결정): 인쇄물은 사람용 — context:read 토큰도 403 이다 (전에는 읽을 수 있었다)
    assert_final_error(await get(env, url, { token: reader.token }), 403, "forbidden");
    assert.equal(assert_ok(await get(env, url)).snapshot.id, done.snapshot_id);
    assert_error(await call(env, { method: "GET", path: `/api/v1/projects/no-such-project${url}`, auth: "owner" }), 404, "not_found");
  });
});

// ---------------------------------------------------------------------------
// POST 매핑

test("POST print/prepare is 200 with no snapshot or blob; POST print/commit is 201 and the stored print is readable by GET", async () => {
  await with_api(async (env) => {
    const s = await open_scene(env);
    const fp = footprint(env);
    const prepared = assert_ok(await post(env, "/print/prepare", "owner", { scope: "round", round_id: s.round.round_id }), 200);
    assert.equal(prepared.manifest.kind, "print");
    assert.equal(prepared.manifest.output, null);
    assert.equal(footprint(env).snapshots, fp.snapshots);
    assert.equal(footprint(env).blobs, fp.blobs);
    assert.deepEqual(footprint(env).files, fp.files);
    const done = await http_commit(env, { scope: "round", round_id: s.round.round_id, selection_hash: prepared.selection_hash });
    assert.equal(done.selection_hash, prepared.selection_hash);
    assert.equal(assert_ok(await get(env, `/print?scope=round&snapshot=${done.snapshot_id}`)).snapshot.id, done.snapshot_id);
  });
});

test("print writes: Idempotency-Key required, same key replays and writes nothing, other body 409, unknown field 400, no credential 401, unknown project 404", async () => {
  await with_api(async (env) => {
    const s = await open_scene(env);
    const body = { scope: "round", round_id: s.round.round_id };
    for (const route of ["print/prepare", "print/commit"]) {
      assert_final_error(await call(env, { method: "POST", path: P(env, `/${route}`), auth: "owner", body, key: null }), 400, "invalid_payload");
      assert_final_error(await post(env, `/${route}`, "none", body), 401, "unauthenticated");
      assert_final_error(await post(env, `/${route}`, "owner", { ...body, surprise: 1 }), 400, "invalid_payload");
      assert_error(await call(env, { method: "POST", path: `/api/v1/projects/no-such-project/${route}`, auth: "owner", body }), 404, "not_found");
      const status = route === "print/commit" ? 201 : 200;
      const first = await post(env, `/${route}`, "owner", body, `k-${route}`);
      const data = assert_ok(first, status);
      assert.notEqual(first.json.replayed, true);
      const sig = state_signature(env.db);
      const again = await post(env, `/${route}`, "owner", body, `k-${route}`);
      assert.equal(again.json.replayed, true);
      assert.deepEqual(assert_ok(again, status), data);
      assert.equal(state_signature(env.db), sig, `${route}: a replay writes nothing`);
      assert_final_error(await post(env, `/${route}`, "owner", { ...body, include: ["body"] }, `k-${route}`), 409, "idempotency_key_reuse");
    }
    assert.equal(footprint(env).snapshots, 1, "one commit, however many replays and refusals");
  });
});

test("an agent token cannot prepare or commit a print even with every scope; a bad scope is a final 4xx and writes nothing", async () => {
  await with_api(async (env) => {
    const s = await open_scene(env);
    const agent = await make_agent(env, "printer");
    const sig = state_signature(env.db);
    for (const route of ["print/prepare", "print/commit"]) {
      assert_final_error(await post(env, `/${route}`, { token: agent.token }, { scope: "round", round_id: s.round.round_id }), 403, "forbidden");
      const bad = await post(env, `/${route}`, "owner", { scope: "project" });
      assert.ok(bad.status === 400 || bad.status === 422, `${route}: ${bad.status}`);
      assert.ok(["invalid_payload", "validation_failed"].includes(bad.json.error.code));
    }
    assert.equal(state_signature(env.db), sig);
  });
});

// ---------------------------------------------------------------------------
// 계약 문서

test("OpenAPI documents GET /print and POST /print/prepare, /print/commit", () => {
  const doc = readFileSync(OPENAPI_PATH, "utf8");
  const block = (path: string): string => {
    const at = doc.indexOf(`  /api/v1/projects/{id}/${path}:`);
    assert.ok(at >= 0, `${path} is documented`);
    const rest = doc.slice(at + 10);
    const next = rest.search(/\n {2}\/api\/v1\//);
    return next < 0 ? rest : rest.slice(0, next);
  };
  assert.match(block("print"), /\n {4}get:/);
  assert.match(block("print/prepare"), /\n {4}post:/);
  assert.match(block("print/commit"), /\n {4}post:/);
  assert.match(block("print"), /snapshot/);
  assert.match(block("print"), /scope/);
});

test("capabilities lists the three print routes", async () => {
  await with_api(async (env) => {
    const data = assert_ok(await call(env, { method: "GET", path: "/api/v1/capabilities" }));
    const routes = (data.routes as string[]).join("\n");
    assert.match(routes, /GET [^\n]*\/print(\s|$)/);
    assert.match(routes, /POST [^\n]*\/print\/prepare/);
    assert.match(routes, /POST [^\n]*\/print\/commit/);
  });
});
