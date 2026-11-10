/**
 * SEL-47 r1 회귀 R2 — 계약 시험: docs/plan/fixtures/api-v1/*.json 의 모든 요청을 실제 ApiApp 에 보낸다.
 *
 * 픽스처의 normal.request / error.request 를 (픽스처의 가짜 id 만 이 시험이 만든 실제 id 로 바꿔서) 그대로 보내고
 *   - 상태 코드
 *   - 오류 코드 · next_action · retryable · target · details 의 모양(null 인지, 키 집합)
 *   - 성공 응답 data 의 모양(키 집합, 재귀. 배열은 첫 원소 기준) 과 봉투(format_version, request_id, POST 면 replayed)
 * 가 픽스처의 응답과 같은지 대조한다. 요청 본문은 구현에 맞게 고치지 않는다: 문서가 구현이 거부하는 본문을
 * 계약으로 적고 있으면 400 이 되어 이 시험이 실패한다 — 그것이 이 시험의 목적이다(문서를 구현에 맞게 고치거나 반대).
 *
 * 지원하지 않는 경로(2단계 목록에 없는 것)는 어떤 요청이든 501 not_supported 여야 한다.
 * 인증은 픽스처 헤더에서 정한다: Authorization 있으면 에이전트 토큰, Cookie 있으면 소유자 세션, 둘 다 없으면 그
 * 경우의 normal 과 같은 자격(capabilities 만 자격 없음).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

import {
  agent_claims,
  assert_ok,
  bump_control_rev,
  call,
  go_off,
  make_agent,
  owner_creates_run,
  with_api,
  type Agent,
  type ApiEnv,
  type Auth,
} from "./helpers/api_env.ts";
import { P } from "./helpers/api_flow.ts";
import { new_artifact } from "./helpers/blob_env.ts";
import { drive_stage, make_content, seal, start, stage_ids, type SealResult } from "./helpers/editions_env.ts";
import { single_spec } from "./helpers/questions_env.ts";

const FIXTURE_DIR = new URL("../docs/plan/fixtures/api-v1/", import.meta.url);

/** Operations the closed 2단계 list does not have: every request is 501 not_supported. */
const UNSUPPORTED = new Set([
  "agent_tokens.create",
  "assumptions.create",
  "decisions.create",
  "editions.create",
  "exports.create",
  "followups.apply",
  "projects.delete",
  "reflections.create",
  "threads.create",
  "threads.messages.create",
  "threads.resolutions.create",
]);

interface FixtureCase {
  request: { path_params?: Record<string, string>; query?: Record<string, unknown> | null; headers: Record<string, string>; body?: unknown };
  response: { status: number; body: any };
}
interface Fixture {
  operation: string;
  method: string;
  path: string;
  normal?: FixtureCase;
  error?: FixtureCase;
}

function fixtures(): Array<[string, Fixture]> {
  return readdirSync(FIXTURE_DIR)
    .filter((n) => n.endsWith(".json"))
    .sort()
    .map((n) => [n, JSON.parse(readFileSync(new URL(n, FIXTURE_DIR), "utf8")) as Fixture]);
}

// ---------------------------------------------------------------------------
// shapes

function shape(value: unknown): unknown {
  if (Array.isArray(value)) return value.length === 0 ? [] : [shape(value[0])];
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as object)
        .sort()
        .map((k) => [k, shape((value as Record<string, unknown>)[k])]),
    );
  }
  return value === null ? "null" : "value";
}

/** Like shape(), but an empty array on either side matches any array (an example list may be empty). */
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
    for (const key of Object.keys(expected as object)) {
      same_shape((actual as Record<string, unknown>)[key], (expected as Record<string, unknown>)[key], `${where}.${key}`);
    }
    return;
  }
  // scalars: only null-ness is part of the shape
  assert.equal(actual === null, expected === null, `${where}: null-ness (got ${JSON.stringify(actual)})`);
}

// ---------------------------------------------------------------------------
// world

interface Scene {
  /** fixture placeholder -> real value (exact string match, in path, query, body and header values) */
  subst: Record<string, string>;
  /** replace the revision / fence fields by the current real values (a normal case does; an error case chooses) */
  live_revs?: Record<string, string>;
  raw?: Uint8Array;
  /** use this agent's token instead of the default one (e.g. an internal_ai actor for the Go-OFF cases) */
  agent?: Agent;
}

type Builder = (env: ApiEnv, agent: Agent) => Promise<Scene>;

const PH = {
  project: "prj_01J9Z3K7Q2",
  stage: "stg_01J9Z3K7Q4",
  round: "rnd_01J9Z3K7Q5",
  run: "run_01J9Z3K7Q6",
  lease: "lea_01J9Z3K7QP",
  question: "qst_01J9Z3K7QB",
  qversion: "qvr_01J9Z3K7QC",
  qset: "qset_01J9Z3K7QD",
  object: "obj_01J9Z3K7Q9",
  version: "ver_01J9Z3K7QA",
  actor: "act_01J9Z3K7Q8",
  cursor: "cur_01J9Z3K7QK",
  snapshot: "snp_01J9Z3K7Q2",
  blob_get: "blb_01J9Z3K7QF",
  blob_put: "blb_01J9Z3K7QG",
  upload: "upl_01J9Z3K7QG",
  sha: "sha256:9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b",
};

const sha_hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const synthetic_bytes = (n: number, salt: number) => new Uint8Array(Array.from({ length: n }, (_, i) => (i * 7 + salt) % 251));

async function open_round(env: ApiEnv): Promise<{ stage_id: string; round_id: string }> {
  const s = stage_ids(env.db, env.p.edition_id);
  const round = assert_ok(await call(env, { method: "POST", path: P(env, `/stages/${s.plan}/rounds`), auth: "owner", body: {} }), 201).round;
  return { stage_id: s.plan, round_id: round.id };
}

async function ask(env: ApiEnv, stage_id: string, round_id: string | null) {
  const data = assert_ok(
    await call(env, {
      method: "POST",
      path: P(env, "/questions"),
      auth: "owner",
      body: {
        stage_id,
        round_id,
        purpose: "review",
        // the documents' answer value is "A": give the question options A and B
        question: single_spec("계약 시험 질문", { options: [{ value: "A", label: "합성 A" }, { value: "B", label: "합성 B" }], default_value: "B" }),
      },
    }),
    201,
  );
  return { set_id: data.question_set_id as string, question_id: data.question.id as string, version_id: data.question.version_id as string };
}

async function reserved_blob(env: ApiEnv, bytes: Uint8Array, stage: "reserved" | "stored" | "ready") {
  const r = assert_ok(
    await call(env, {
      method: "POST",
      path: P(env, "/uploads"),
      auth: "owner",
      body: { sha256: sha_hex(bytes), size: bytes.byteLength, media_type: "application/octet-stream", original_name: "합성.bin" },
    }),
    201,
  );
  if (stage !== "reserved") {
    assert_ok(await call(env, { method: "PUT", path: P(env, `/uploads/${r.blob_id}`), auth: "owner", raw: bytes, headers: { "content-type": "application/octet-stream" } }));
  }
  if (stage === "ready") assert_ok(await call(env, { method: "POST", path: P(env, `/uploads/${r.blob_id}/complete`), auth: "owner", body: {} }));
  return r.blob_id as string;
}

function project_rev(env: ApiEnv, sql: string, ...params: string[]): string {
  const row = env.db.get<Record<string, bigint | number | string>>(sql, ...params);
  assert.ok(row, sql);
  return String(Object.values(row)[0]);
}

function revs(env: ApiEnv, extra: Record<string, string> = {}): Record<string, string> {
  return {
    expected_control_rev: project_rev(env, "SELECT control_rev FROM projects WHERE id = ?", env.p.project_id),
    base_control_rev: project_rev(env, "SELECT control_rev FROM projects WHERE id = ?", env.p.project_id),
    ...extra,
  };
}

function lease_scene(env: ApiEnv, lease: { run_id: string; lease_id: string; fence: string }, extra: Record<string, string> = {}): Scene {
  return {
    subst: { [PH.run]: lease.run_id, [PH.lease]: lease.lease_id, ...extra },
    live_revs: { ...revs(env), fence: lease.fence },
  };
}

async function after_epoch_bump(env: ApiEnv, cursor: string): Promise<string> {
  env.db.run("UPDATE db_meta SET cursor_epoch = cursor_epoch + 1 WHERE id = 1");
  return cursor;
}

const SCENES: Record<string, { normal: Builder; error?: Builder }> = {
  "capabilities.get": { normal: async () => ({ subst: {} }) },
  "context.get": {
    normal: async (env) => ({ subst: {} }),
    error: async () => ({ subst: { prj_missing_01J9Z3K7Q2: "prj-does-not-exist" } }),
  },
  "changes.list": {
    normal: async (env, agent) => {
      const first = assert_ok(await call(env, { method: "GET", path: P(env, "/changes?limit=1"), auth: { token: agent.token } }));
      return { subst: { [PH.cursor]: first.next_cursor } };
    },
    error: async (env, agent) => {
      const first = assert_ok(await call(env, { method: "GET", path: P(env, "/changes?limit=1"), auth: { token: agent.token } }));
      await after_epoch_bump(env, first.next_cursor);
      return { subst: { cur_epoch1_01J9Z3K7Q2: first.next_cursor } };
    },
  },
  "runs.create": {
    normal: async (env, agent) => {
      const round = await open_round(env);
      const v = await new_artifact(env, "rc");
      return { subst: { [PH.stage]: round.stage_id, [PH.round]: round.round_id, [PH.version]: v.version_id, act_01J9Z3K7Q7: agent.actor_id } };
    },
    error: async (env, agent) => {
      const round = await open_round(env);
      await go_off(env);
      return { subst: { [PH.stage]: round.stage_id, [PH.round]: round.round_id } };
    },
  },
  "runs.claim": {
    normal: async (env, agent) => {
      const run_id = await owner_creates_run(env, agent);
      return { subst: { [PH.run]: run_id }, live_revs: revs(env) };
    },
    error: async (env, agent) => {
      const other = await make_agent(env, "holder");
      await agent_claims(env, other);
      const run_id = await owner_creates_run(env, agent);
      return { subst: { [PH.run]: run_id, run_01J9Z3K7QX: "x" }, live_revs: revs(env) };
    },
  },
  "runs.heartbeat": {
    normal: async (env, agent) => lease_scene(env, await agent_claims(env, agent)),
    error: async (env, agent) => {
      const lease = await agent_claims(env, agent);
      return { subst: { [PH.run]: lease.run_id, [PH.lease]: lease.lease_id } };
    },
  },
  "runs.wait": {
    normal: async (env, agent) => {
      const round = await open_round(env);
      const q = await ask(env, round.stage_id, round.round_id);
      const lease = await agent_claims(env, agent);
      return lease_scene(env, lease, { [PH.question]: q.question_id });
    },
    error: async (env, agent) => {
      const lease = await agent_claims(env, agent);
      return { subst: { [PH.run]: lease.run_id }, live_revs: { fence: lease.fence } };
    },
  },
  "runs.complete": {
    normal: async (env, agent) => lease_scene(env, await agent_claims(env, agent), { [PH.version]: (await new_artifact(env, "cm")).version_id }),
    error: async (env, agent) => {
      const lease = await agent_claims(env, agent);
      assert_ok(await call(env, { method: "POST", path: P(env, `/runs/${lease.run_id}/complete`), auth: { token: agent.token }, body: { lease_id: lease.lease_id, fence: lease.fence, status: "succeeded" } }));
      return { subst: { [PH.run]: lease.run_id, [PH.lease]: lease.lease_id }, live_revs: { fence: lease.fence } };
    },
  },
  "runs.cancel": {
    normal: async (env, agent) => ({ subst: { [PH.run]: await owner_creates_run(env, agent) } }),
    error: async (env, agent) => {
      const lease = await agent_claims(env, agent);
      assert_ok(await call(env, { method: "POST", path: P(env, `/runs/${lease.run_id}/complete`), auth: { token: agent.token }, body: { lease_id: lease.lease_id, fence: lease.fence, status: "succeeded" } }));
      return { subst: { [PH.run]: lease.run_id } };
    },
  },
  "runs.interrupt": {
    normal: async (env, agent) => ({ subst: { [PH.run]: (await agent_claims(env, agent)).run_id } }),
    error: async (env, agent) => {
      const other = await make_agent(env, "other");
      return { subst: { run_01J9Z3K7QX: await owner_creates_run(env, other) } };
    },
  },
  "runs.handoff": {
    normal: async (env, agent) => {
      const lease = await agent_claims(env, agent);
      return { subst: { [PH.run]: lease.run_id, [PH.actor]: agent.actor_id } };
    },
    error: async (env, agent) => {
      const holder = await make_agent(env, "holder2");
      const lease = await agent_claims(env, holder);
      return { subst: { [PH.run]: lease.run_id, [PH.actor]: agent.actor_id } };
    },
  },
  "runs.inputs": {
    normal: async (env, agent) => {
      const run_id = await owner_creates_run(env, agent);
      const first = assert_ok(await call(env, { method: "GET", path: P(env, `/runs/${run_id}/inputs?wait_ms=0`), auth: { token: agent.token } }));
      env.clock.advance(60_000); // past the minimum interval between two empty polls
      return { subst: { [PH.run]: run_id, [PH.cursor]: first.next_cursor } };
    },
    error: async (env, agent) => {
      const run_id = await owner_creates_run(env, agent);
      const first = assert_ok(await call(env, { method: "GET", path: P(env, `/runs/${run_id}/inputs?wait_ms=0`), auth: { token: agent.token } }));
      env.db.run("UPDATE db_meta SET cursor_epoch = cursor_epoch + 1 WHERE id = 1");
      env.clock.advance(60_000);
      return { subst: { [PH.run]: run_id, cur_stale_01J9Z3K7Q2: first.next_cursor } };
    },
  },
  "runs.input_receipts": {
    normal: async (env, agent) => {
      const round = await open_round(env);
      const lease = await agent_claims(env, agent);
      // the agent itself asks (under its lease): only the answers to a run actor's own questions are its inputs
      const asked = assert_ok(
        await call(env, {
          method: "POST",
          path: P(env, "/questions"),
          auth: { token: agent.token },
          body: {
            stage_id: round.stage_id,
            round_id: round.round_id,
            purpose: "review",
            question: single_spec("계약 시험 질문", { options: [{ value: "A", label: "합성 A" }, { value: "B", label: "합성 B" }], default_value: "B" }),
            run_id: lease.run_id,
            lease_id: lease.lease_id,
            fence: lease.fence,
          },
        }),
        201,
      );
      const q = { set_id: asked.question_set_id as string, question_id: asked.question.id as string, version_id: asked.question.version_id as string };
      assert_ok(await call(env, { method: "POST", path: P(env, `/runs/${lease.run_id}/wait`), auth: { token: agent.token }, body: { lease_id: lease.lease_id, fence: lease.fence } }));
      const sub = assert_ok(
        await call(env, { method: "POST", path: P(env, "/submissions"), auth: "owner", body: { set_id: q.set_id, answers: [{ question_id: q.question_id, question_version_id: q.version_id, value: "A" }] } }),
        201,
      );
      assert_ok(await call(env, { method: "GET", path: P(env, `/runs/${lease.run_id}/inputs?wait_ms=0`), auth: { token: agent.token } }));
      const again = await agent_claims(env, agent, lease.run_id);
      return lease_scene(env, again, { [PH.version]: sub.answers[0].answer_version_id });
    },
    error: async (env, agent) => lease_scene(env, await agent_claims(env, agent)),
  },
  "results.submit": {
    normal: async (env, agent) => {
      const art = await new_artifact(env, "rs");
      return lease_scene(env, await agent_claims(env, agent), { [PH.object]: art.object_id, [PH.version]: art.version_id });
    },
    error: async (env, agent) => {
      const art = await new_artifact(env, "rs2");
      return lease_scene(env, await agent_claims(env, agent), { [PH.object]: art.object_id, [PH.version]: art.version_id });
    },
  },
  "object.version.get": {
    normal: async (env) => {
      const art = await new_artifact(env, "vg");
      return { subst: { [PH.object]: art.object_id, [PH.version]: art.version_id } };
    },
    error: async (env) => {
      const art = await new_artifact(env, "vg2");
      return { subst: { [PH.object]: art.object_id } };
    },
  },
  "questions.create": {
    normal: async (env, agent) => {
      const round = await open_round(env);
      return { subst: { [PH.stage]: round.stage_id, [PH.round]: round.round_id, ...(await publish_guard(env, agent)) } };
    },
    error: async (env, agent) => {
      const round = await open_round(env);
      return { subst: { [PH.stage]: round.stage_id, [PH.round]: round.round_id, ...(await publish_guard(env, agent)) } };
    },
  },
  "questions.revise": {
    normal: async (env) => {
      const round = await open_round(env);
      const q = await ask(env, round.stage_id, round.round_id);
      return { subst: { [PH.question]: q.question_id, [PH.qversion]: q.version_id } };
    },
    error: async (env) => {
      const round = await open_round(env);
      const q = await ask(env, round.stage_id, round.round_id);
      return { subst: { [PH.question]: q.question_id, [PH.qversion]: q.version_id } };
    },
  },
  "submissions.create": {
    normal: async (env) => {
      const round = await open_round(env);
      const q = await ask(env, round.stage_id, round.round_id);
      return { subst: { [PH.qset]: q.set_id, [PH.question]: q.question_id, [PH.qversion]: q.version_id } };
    },
    error: async (env) => {
      const round = await open_round(env);
      const q = await ask(env, round.stage_id, round.round_id);
      return { subst: { [PH.qset]: q.set_id, [PH.question]: q.question_id, [PH.qversion]: q.version_id } };
    },
  },
  "rounds.create": {
    normal: async (env) => {
      const s = stage_ids(env.db, env.p.edition_id);
      const q = await ask(env, s.plan, null);
      return { subst: { [PH.stage]: s.plan, [PH.qset]: q.set_id }, live_revs: { base_stage_rev: project_rev(env, "SELECT rev FROM stages WHERE id = ?", s.plan) } };
    },
    error: async (env) => {
      const s = stage_ids(env.db, env.p.edition_id);
      return { subst: { [PH.stage]: s.research } };
    },
  },
  "rounds.seal": {
    normal: async (env) => {
      const s = stage_ids(env.db, env.p.edition_id);
      const round = await start(env, s.plan, "seal-n-start");
      await make_content(env, "seal-n");
      return { subst: { [PH.round]: round.round_id }, live_revs: { expected_round_rev: project_rev(env, "SELECT rev FROM rounds WHERE id = ?", round.round_id) } };
    },
    error: async (env) => {
      const s = stage_ids(env.db, env.p.edition_id);
      const round = await start(env, s.plan, "seal-e-start");
      const content = await make_content(env, "seal-e");
      await seal(env, round.round_id, [{ object_id: content.object_id, version_id: content.version_id }], "seal-e");
      return { subst: { [PH.round]: round.round_id } };
    },
  },
  "stages.approve": {
    normal: async (env) => {
      const s = stage_ids(env.db, env.p.edition_id);
      const round = await start(env, s.plan, "ap-n-start");
      const content = await make_content(env, "ap-n");
      const sealed = (await seal(env, round.round_id, [{ object_id: content.object_id, version_id: content.version_id }], "ap-n")).result as SealResult;
      return { subst: { [PH.stage]: s.plan, [PH.snapshot]: sealed.snapshot_id }, live_revs: { expected_stage_rev: project_rev(env, "SELECT rev FROM stages WHERE id = ?", s.plan) } };
    },
    error: async (env) => {
      const s = stage_ids(env.db, env.p.edition_id);
      return { subst: { [PH.stage]: s.plan } };
    },
  },
  "stages.reopen": {
    normal: async (env) => {
      const s = stage_ids(env.db, env.p.edition_id);
      await drive_stage(env, s.plan, "ro-n");
      return { subst: { [PH.stage]: s.plan }, live_revs: { expected_stage_rev: project_rev(env, "SELECT rev FROM stages WHERE id = ?", s.plan) } };
    },
    error: async (env) => {
      const s = stage_ids(env.db, env.p.edition_id);
      return { subst: { [PH.stage]: s.plan } };
    },
  },
  "policies.opencode_go.revise": {
    normal: async (env) => ({
      subst: {},
      live_revs: { expected_policy_rev: project_rev(env, "SELECT policy_rev FROM project_policy_versions WHERE project_id = ? ORDER BY policy_rev DESC LIMIT 1", env.p.project_id) },
    }),
    error: async () => ({ subst: {} }),
  },
  "uploads.create": {
    normal: async (env) => {
      const bytes = synthetic_bytes(12345, 1);
      return { subst: { [PH.sha]: `sha256:${sha_hex(bytes)}` } };
    },
    error: async () => ({ subst: {} }),
  },
  "uploads.put": {
    normal: async (env) => {
      const bytes = synthetic_bytes(12345, 2);
      const blob = await reserved_blob(env, bytes, "reserved");
      return { subst: { [PH.blob_put]: blob, [PH.sha]: `sha256:${sha_hex(bytes)}` }, raw: bytes };
    },
    error: async (env) => {
      const bytes = synthetic_bytes(12345, 3);
      const blob = await reserved_blob(env, bytes, "reserved");
      return { subst: { [PH.blob_put]: blob }, raw: synthetic_bytes(12345, 4) };
    },
  },
  "uploads.complete": {
    normal: async (env) => {
      const bytes = synthetic_bytes(12345, 5);
      const blob = await reserved_blob(env, bytes, "stored");
      return { subst: { [PH.upload]: blob, [PH.sha]: `sha256:${sha_hex(bytes)}` } };
    },
    error: async (env) => {
      const bytes = synthetic_bytes(12345, 6);
      const blob = await reserved_blob(env, bytes, "reserved");
      return { subst: { [PH.upload]: blob } };
    },
  },
  "files.content": {
    normal: async (env) => {
      const blob = await reserved_blob(env, synthetic_bytes(64, 7), "ready");
      return { subst: { [PH.blob_get]: blob } };
    },
    error: async (env) => {
      const blob = await reserved_blob(env, synthetic_bytes(64, 8), "ready");
      const go_actor = await make_agent(env, "go-bound", undefined, "internal_ai");
      await go_off(env);
      return { subst: { [PH.blob_get]: blob }, agent: go_actor };
    },
  },
};

async function publish_guard(env: ApiEnv, agent: Agent): Promise<Record<string, string>> {
  return {};
}

// ---------------------------------------------------------------------------
// sending

function substitute(value: unknown, subst: Record<string, string>): unknown {
  if (typeof value === "string") {
    let out = value;
    for (const [from, to] of Object.entries(subst)) out = out.split(from).join(to);
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, subst));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, subst)]));
  }
  return value;
}

function force(value: unknown, fields: Record<string, string>): unknown {
  if (Array.isArray(value)) return value.map((v) => force(v, fields));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, k in fields && typeof v === "string" ? fields[k] : force(v, fields)]),
    );
  }
  return value;
}

function auth_of(c: FixtureCase, agent: Agent, fallback: Auth): Auth {
  const names = Object.keys(c.request.headers).map((h) => h.toLowerCase());
  if (names.includes("authorization")) return { token: agent.token };
  if (names.includes("cookie")) return "owner";
  return fallback;
}

async function send(env: ApiEnv, fx: Fixture, c: FixtureCase, scene: Scene, auth: Auth, normal: boolean) {
  const subst: Record<string, string> = { ...scene.subst, [PH.project]: env.p.project_id };
  let path = fx.path;
  for (const [name, value] of Object.entries(c.request.path_params ?? {})) {
    path = path.replace(`{${name}}`, String(substitute(value, subst)));
  }
  let body: unknown = c.request.body === null || c.request.body === undefined ? undefined : substitute(c.request.body, subst);
  const live = normal ? scene.live_revs : scene.live_revs;
  if (body !== undefined && live !== undefined && normal) body = force(body, live);
  const query = Object.entries((substitute(c.request.query ?? {}, subst) as Record<string, unknown>) ?? {})
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(c.request.headers)) {
    const lower = name.toLowerCase();
    if (["authorization", "cookie", "x-csrf-token", "accept", "content-type", "content-length"].includes(lower)) continue;
    headers[lower] = String(substitute(value, subst));
  }
  return call(env, {
    method: fx.method,
    path: query === "" ? path : `${path}?${query}`,
    auth,
    body,
    raw: scene.raw,
    headers,
    key: headers["idempotency-key"] ?? undefined,
  });
}

function compare(res: Awaited<ReturnType<typeof call>>, expected: FixtureCase["response"], method: string): void {
  const where = `${res.status} ${JSON.stringify(res.json)}`;
  assert.equal(res.status, expected.status, `status: ${where}`);
  const body = res.json;
  assert.ok(body, "a JSON body");
  assert.equal(body.format_version, expected.body.format_version, "format_version");
  assert.equal(typeof body.request_id, "string", "request_id");
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
    const keys = Object.keys(body).filter((k) => k !== "replayed").sort(); // `replayed` (POST only) is optional in the examples
    assert.deepEqual(keys, Object.keys(expected.body).sort(), `envelope keys (${method})`);
  }
}

for (const [file, fx] of fixtures()) {
  for (const kind of ["normal", "error"] as const) {
    const c = fx[kind];
    if (c === undefined) continue;
    test(`contract ${file} ${kind}: ${fx.method} ${fx.path} -> ${UNSUPPORTED.has(fx.operation) ? "501 not_supported" : c.response.status}`, async () => {
      await with_api(async (env) => {
        const agent = await make_agent(env, "contract");
        if (UNSUPPORTED.has(fx.operation)) {
          const res = await send(env, fx, c, { subst: {} }, auth_of(c, agent, "owner"), kind === "normal");
          assert.equal(res.status, 501, `${fx.operation} is outside the closed list: ${JSON.stringify(res.json)}`);
          assert.equal(res.json.error.code, "not_supported");
          return;
        }
        const entry = SCENES[fx.operation];
        assert.ok(entry, `no scene for ${fx.operation}: add one to SCENES`);
        const builder = kind === "normal" ? entry.normal : (entry.error ?? entry.normal);
        const scene = await builder(env, agent);
        const who = scene.agent ?? agent;
        const normal_auth = auth_of(fx.normal ?? c, who, "owner");
        const res = await send(env, fx, c, scene, fx.operation === "capabilities.get" ? "none" : auth_of(c, who, normal_auth), kind === "normal");
        compare(res, c.response, fx.method);
      });
    });
  }
}
