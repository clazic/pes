/**
 * SEL-99 U4a — 문서 계약 픽스처 장면을 실제 서버(ApiApp)에서 통과시키는 시험 (tester, 작성 모드).
 *
 * 왜 새 파일인가: tests/test_api_fixture_contract.test.ts 는 `threads.messages.create` 두 장면을 `U4A_ONLY` 로 건너뛰고,
 *   `threads.create`·`threads.resolutions.create`·`followups.apply` 는 `UNSUPPORTED`(501) 로 단언한다. 기존 시험은 바꾸지 않는 것이 규칙이므로
 *   (그리고 구현 worker 가 "시험을 약하게 바꿔서 통과"시키지 못하도록) 같은 장면을 이 파일이 **새 시험**으로 검사한다.
 *   구현이 끝나면 기존 파일의 U4A_ONLY 해제와 UNSUPPORTED 에서 세 항목 제거 + SCENES 추가가 따로 필요하다(보고에 적음) — 이 파일의 장면을 그대로 옮기면 된다.
 *
 * 대상 픽스처(docs/plan/fixtures/api-v1/): threads.json(annotation normal/error) · thread-messages.json · thread-resolutions.json · followup-apply.json — 각 normal 과 error.
 * 요청은 픽스처 그대로(가짜 id 만 이 시험이 만든 실제 id 로 바꿈) 보내고, 상태 코드·오류 code/next_action/retryable/target·오류와 data 의 키 집합(null 여부 포함)을 대조한다.
 *
 * 스스로 정한 해석(보고에 적음):
 *   - 픽스처의 에이전트 요청(threads normal/error, thread-messages normal/error)은 `Authorization: Bearer` 만 있고 run_id/lease_id/fence 가 없다. 이 저장소의 에이전트 쓰기는 모두
 *     리스(run_id·lease_id·fence)를 요구하므로(SEL-90, 질문 의견) 이 시험은 **요청 본문에 리스 세 칸을 더해** 보낸다(본문의 나머지는 픽스처 그대로).
 *     문서 픽스처에 세 칸을 적는 쪽이 정석이다 — 구현 worker 가 픽스처를 고칠 때 이 시험도 그대로 통과한다(칸이 이미 있으면 덮어쓰지 않는다).
 *   - thread-messages error 의 details.state 는 픽스처에 "archived" 로 적혀 있으나 이 시험은 키 집합만 본다(archived 로 가는 명령이 이 이슈에 없어 resolved 로 닫아 만든다).
 *   - thread-resolutions error 의 details.resolution_id = 해결 결론 메시지 버전 id.
 *   - followup-apply 의 expected_rev = 후속의 현재 version_no 10진 문자열(normal 은 실제 값으로 바꿔 보낸다. error 는 픽스처의 "6" 그대로 — 기반 검사가 먼저라 basis_changed).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { agent_claims, assert_ok, call, make_agent, with_api, type Agent, type ApiEnv, type Auth } from "./helpers/api_env.ts";
import { P } from "./helpers/api_flow.ts";
import { cp_find, cp_len, followup_row, text_artifact } from "./helpers/sel99_env.ts";

const FIXTURE_DIR = new URL("../docs/plan/fixtures/api-v1/", import.meta.url);

interface FixtureCase {
  request: { path_params?: Record<string, string>; headers: Record<string, string>; body?: unknown };
  response: { status: number; body: any };
}
interface Fixture {
  operation: string;
  method: string;
  path: string;
  normal?: FixtureCase;
  error?: FixtureCase;
}

const fixture = (name: string): Fixture => JSON.parse(readFileSync(new URL(name, FIXTURE_DIR), "utf8")) as Fixture;

const PH = {
  project: "prj_01J9Z3K7Q2",
  object: "obj_01J9Z3K7Q9",
  version: "ver_01J9Z3K7QA",
  thread: "thr_01J9Z3K7QH",
  first_message: "msg_01J9Z3K7Q2",
  followup: "fup_01J9Z3K7QJ",
};

const QUOTE = "정책 대안은 두 가지다.";
const PREFIX = "2장 합성 정책 분석에서 ";
const SUFFIX = " 첫 번째는 현행 유지다.";
/** 픽스처의 앵커는 start_cp 120 에서 시작한다: 그 앞을 한글로 채워 맞춘다. */
const BODY = `${"가".repeat(120 - cp_len(PREFIX))}${PREFIX}${QUOTE}${SUFFIX}\n\n끝.`;
const NEW_BODY = BODY.replace(QUOTE, "정책 대안은 두 가지이며 근거는 부록 A 에 있다.");

// ---------------------------------------------------------------------------
// 대조 도구 (tests/test_api_fixture_contract.test.ts 와 같은 규칙)

function same_shape(actual: unknown, expected: unknown, where: string): void {
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${where}: expected an array`);
    const a = actual as unknown[];
    if (expected.length > 0 && a.length > 0) same_shape(a[0], expected[0], `${where}[0]`);
    return;
  }
  if (expected !== null && typeof expected === "object") {
    assert.ok(actual !== null && typeof actual === "object" && !Array.isArray(actual), `${where}: expected an object, got ${JSON.stringify(actual)}`);
    assert.deepEqual(Object.keys(actual as object).sort(), Object.keys(expected as object).sort(), `${where}: key set`);
    for (const key of Object.keys(expected as object)) same_shape((actual as Record<string, unknown>)[key], (expected as Record<string, unknown>)[key], `${where}.${key}`);
    return;
  }
  assert.equal(actual === null, expected === null, `${where}: null-ness (got ${JSON.stringify(actual)})`);
}

function substitute(value: unknown, subst: Record<string, string>): unknown {
  if (typeof value === "string") {
    let out = value;
    for (const [from, to] of Object.entries(subst)) out = out.split(from).join(to);
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, subst));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, subst)]));
  return value;
}

interface Scene {
  subst: Record<string, string>;
  /** 요청 본문에 더하는 칸(이미 있으면 덮어쓰지 않는다) */
  extra_body?: Record<string, unknown>;
  /** 본문 칸 강제 교체 */
  force_body?: Record<string, unknown>;
  agent?: Agent;
}

async function send(env: ApiEnv, fx: Fixture, c: FixtureCase, scene: Scene, auth: Auth) {
  const subst = { ...scene.subst, [PH.project]: env.p.project_id };
  let path = fx.path;
  for (const [name, value] of Object.entries(c.request.path_params ?? {})) path = path.replace(`{${name}}`, String(substitute(value, subst)));
  let body = substitute(c.request.body, subst) as Record<string, unknown>;
  body = { ...scene.extra_body, ...body, ...scene.force_body };
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(c.request.headers)) {
    const lower = name.toLowerCase();
    if (["authorization", "cookie", "x-csrf-token", "accept", "content-type", "content-length"].includes(lower)) continue;
    headers[lower] = String(substitute(value, subst));
  }
  return call(env, { method: fx.method, path, auth, body, headers, key: headers["idempotency-key"] ?? undefined });
}

function compare(res: Awaited<ReturnType<typeof call>>, expected: FixtureCase["response"]): void {
  const where = `${res.status} ${JSON.stringify(res.json)}`;
  assert.equal(res.status, expected.status, `status: ${where}`);
  const body = res.json;
  assert.ok(body, "a JSON body");
  assert.equal(body.format_version, expected.body.format_version);
  assert.equal(typeof body.request_id, "string");
  if (expected.body.error) {
    const e = body.error;
    assert.ok(e, `an error body: ${where}`);
    assert.equal(e.code, expected.body.error.code, `error.code: ${where}`);
    assert.equal(e.next_action, expected.body.error.next_action, `error.next_action: ${where}`);
    assert.equal(e.retryable, expected.body.error.retryable, `error.retryable: ${where}`);
    assert.equal(e.target, expected.body.error.target, `error.target: ${where}`);
    same_shape(e, expected.body.error, "error");
  } else {
    assert.equal(body.error, undefined, `no error expected: ${where}`);
    same_shape(body.data, expected.body.data, "data");
    assert.deepEqual(Object.keys(body).filter((k) => k !== "replayed").sort(), Object.keys(expected.body).sort(), "envelope keys");
  }
}

// ---------------------------------------------------------------------------
// 장면 도우미

async function owner_post(env: ApiEnv, rest: string, body: unknown) {
  return call(env, { method: "POST", path: P(env, rest), auth: "owner", body });
}

async function made_art(env: ApiEnv) {
  return text_artifact(env, "fx", BODY);
}

async function made_thread(env: ApiEnv, art: { object_id: string; version_id: string }) {
  const data = assert_ok(
    await owner_post(env, "/threads", {
      target_object_id: art.object_id,
      target_version_id: art.version_id,
      context_kind: "annotation",
      anchor: { exact_quote: QUOTE, prefix: PREFIX, suffix: SUFFIX, ...cp_find(BODY, QUOTE) },
      initial_message: { body_md: "이 문장의 근거를 더 설명해 주세요." },
    }),
    201,
  );
  return { thread_id: data.thread.id as string, message_id: data.message.id as string };
}

async function agent_with_guard(env: ApiEnv): Promise<{ agent: Agent; guard: Record<string, string> }> {
  const agent = await make_agent(env, "contract-u4a");
  const lease = await agent_claims(env, agent);
  return { agent, guard: { run_id: lease.run_id, lease_id: lease.lease_id, fence: lease.fence } };
}

type Builder = (env: ApiEnv) => Promise<{ scene: Scene; auth: (c: FixtureCase) => Auth }>;

const bearer = (a: Agent) => ({ token: a.token });
const OWNER: Auth = "owner";

const SCENES: Record<string, { normal: Builder; error: Builder }> = {
  "threads.create": {
    normal: async (env) => {
      const art = await made_art(env);
      const { agent, guard } = await agent_with_guard(env);
      return { scene: { subst: { [PH.object]: art.object_id, [PH.version]: art.version_id }, extra_body: guard }, auth: () => bearer(agent) };
    },
    error: async (env) => {
      const art = await made_art(env);
      const { agent, guard } = await agent_with_guard(env);
      return { scene: { subst: { [PH.object]: art.object_id, [PH.version]: art.version_id }, extra_body: guard }, auth: () => bearer(agent) };
    },
  },
  "threads.messages.create": {
    normal: async (env) => {
      const art = await made_art(env);
      const t = await made_thread(env, art);
      const { agent, guard } = await agent_with_guard(env);
      return { scene: { subst: { [PH.thread]: t.thread_id, [PH.first_message]: t.message_id }, extra_body: guard }, auth: () => bearer(agent) };
    },
    error: async (env) => {
      const art = await made_art(env);
      const t = await made_thread(env, art);
      assert_ok(await owner_post(env, `/threads/${t.thread_id}/resolutions`, { resolution: "none", reason: "닫는다." }), 201);
      const { agent, guard } = await agent_with_guard(env);
      return { scene: { subst: { [PH.thread]: t.thread_id }, extra_body: guard }, auth: () => bearer(agent) };
    },
  },
  "threads.resolutions.create": {
    normal: async (env) => {
      const art = await made_art(env);
      const t = await made_thread(env, art);
      return { scene: { subst: { [PH.thread]: t.thread_id, [PH.version]: art.version_id } }, auth: () => OWNER };
    },
    error: async (env) => {
      const art = await made_art(env);
      const t = await made_thread(env, art);
      assert_ok(await owner_post(env, `/threads/${t.thread_id}/resolutions`, { resolution: "none", reason: "먼저 닫았다." }), 201);
      return { scene: { subst: { [PH.thread]: t.thread_id, [PH.version]: art.version_id } }, auth: () => OWNER };
    },
  },
  "followups.apply": {
    normal: async (env) => {
      const art = await made_art(env);
      const t = await made_thread(env, art);
      const f = assert_ok(await owner_post(env, "/followups", { origin_thread_id: t.thread_id, kind: "edit_text", description: "문장을 보강합니다.", proposed_body_md: NEW_BODY }), 201).followup;
      return { scene: { subst: { [PH.followup]: f.id, [PH.version]: art.version_id }, force_body: { expected_rev: f.version_no } }, auth: () => OWNER };
    },
    error: async (env) => {
      const art = await made_art(env);
      const t = await made_thread(env, art);
      const f = assert_ok(await owner_post(env, "/followups", { origin_thread_id: t.thread_id, kind: "edit_text", description: "문장을 보강합니다.", proposed_body_md: NEW_BODY }), 201).followup;
      assert.equal(followup_row(env.db, f.id).state, "proposed");
      return { scene: { subst: { [PH.followup]: f.id } }, auth: () => OWNER };
    },
  },
};

for (const file of ["threads.json", "thread-messages.json", "thread-resolutions.json", "followup-apply.json"]) {
  const fx = fixture(file);
  for (const kind of ["normal", "error"] as const) {
    const c = fx[kind];
    if (c === undefined) continue;
    test(`contract(U4a) ${file} ${kind}: ${fx.method} ${fx.path} -> ${c.response.status}${c.response.body.error ? ` ${c.response.body.error.code}` : ""}`, async () => {
      await with_api(async (env) => {
        const entry = SCENES[fx.operation];
        assert.ok(entry, `no scene for ${fx.operation}`);
        const { scene, auth } = await entry[kind](env);
        const res = await send(env, fx, c, scene, auth(c));
        compare(res, c.response);
      });
    });
  }
}

test("contract(U4a): 이 파일이 다루는 네 픽스처는 모두 normal 과 error 를 갖고 있다(장면이 빠지지 않았다)", () => {
  for (const file of ["threads.json", "thread-messages.json", "thread-resolutions.json", "followup-apply.json"]) {
    const fx = fixture(file);
    assert.ok(fx.normal && fx.error, `${file} has both cases`);
    assert.ok(SCENES[fx.operation], `scene for ${fx.operation}`);
  }
});
