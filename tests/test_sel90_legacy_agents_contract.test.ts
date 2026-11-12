/**
 * SEL-90 U2a — 이전된 합성 프로젝트, A·B 에이전트 경로, OpenAPI·픽스처 등록 (tester, 작성 모드).
 * 이름 앞 [회귀]는 지금도 통과해야 하는 가드, [신규]는 구현 전에는 실패하는 시험.
 *
 * 이전된 프로젝트: tests/fixtures/legacy/full 을 가져와 활성화한 합성 프로젝트(중요도 없음 → 기본 normal, 승인 assurance=legacy_unverified,
 * 질문 q_scope 에 __other 의견 스레드, 가정·결정 없음). 쓰기를 해도 이 상태가 깨지지 않아야 한다.
 */

import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { A_TOOL_ALLOWLIST, TOOL_SPECS } from "../scripts/pes_core/a_runtime/tools.ts";
import { assert_ok, call, SESSION_SECRET, with_api, type ApiEnv } from "./helpers/api_env.ts";
import { ask_args, make_adapter_env, owner_answers } from "./helpers/adapter_b_env.ts";
import { with_cleanup } from "./helpers/adapter_b_flow.ts";
import { assert_final_error } from "./helpers/api_flow.ts";
import { legacy } from "./helpers/legacy_env.ts";
import { activated, migration } from "./helpers/migration_env.ts";
import { read_version } from "./helpers/mcp_read.ts";
import { comment_messages, history_counts, make_form, single_spec } from "./helpers/sel90_env.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const text_of = (...parts: string[]): string => readFileSync(join(REPO, ...parts), "utf8").replace(/\r\n/g, "\n");

// ---------------------------------------------------------------------------
// 8. 이전된 합성 프로젝트

interface Migrated {
  pid: string;
  q_scope: string;
  q_note: string;
  set_id: string;
  get(rest: string): Promise<any>;
  post(rest: string, body: unknown, key?: string): Promise<any>;
  ctx(key: string): { project_id: string; actor_id: string; via: "cli"; client_request_id: string };
}

async function migrated(env: ApiEnv): Promise<Migrated> {
  const a = await activated(env, await legacy(), await migration());
  const pid = a.imp.project_id;
  const id_of = (bank_key: string): string =>
    env.db.get<{ object_id: string }>("SELECT object_id FROM questions WHERE project_id = ? AND bank_key = ?", pid, bank_key)!.object_id;
  const set = env.db.get<{ id: string }>("SELECT id FROM question_sets WHERE project_id = ? ORDER BY version_no DESC LIMIT 1", pid)!;
  const base = `/api/v1/projects/${pid}`;
  let n = 0;
  return {
    pid,
    q_scope: id_of("q_scope"),
    q_note: id_of("q_note"),
    set_id: set.id,
    get: (rest) => call(env, { method: "GET", path: `${base}${rest}`, headers: { "x-pes-session": SESSION_SECRET } }),
    post: (rest, body, key) =>
      call(env, { method: "POST", path: `${base}${rest}`, headers: { "x-pes-session": SESSION_SECRET }, body, key: key ?? `mig-${(n += 1)}` }),
    ctx: (key) => ({ project_id: pid, actor_id: env.p.actor_id, via: "cli" as const, client_request_id: key }),
  };
}

const project_counts = (env: ApiEnv, pid: string) => {
  const out: Record<string, number> = {};
  for (const t of ["questions", "question_versions", "answers", "answer_versions", "threads", "messages", "message_versions", "approvals", "legacy_mappings"]) {
    out[t] = Number(env.db.get<{ n: bigint }>(`SELECT count(*) AS n FROM ${t} WHERE project_id = ?`, pid)!.n);
  }
  return out;
};

test("[회귀] 이전된 프로젝트 읽기: 작업 공간·질문 버전·옛 답이 깨지지 않고, 중요도는 기본 normal, 가정·결정은 기록 없음", async () => {
  await with_api(async (env) => {
    const m = await migrated(env);
    const ws = assert_ok(await m.get("/workspace"));
    assert.equal(ws.records.assumptions.count, 0);
    assert.equal(ws.records.decisions.count, 0);
    assert.ok(ws.records.comments.count >= 1, "이전된 __other 의견이 센다");
    const o = env.db.get<{ current_version_id: string }>("SELECT current_version_id FROM objects WHERE id = ?", m.q_scope)!;
    const q = assert_ok(await m.get(`/objects/${m.q_scope}/versions/${o.current_version_id}`));
    assert.equal(q.kind, "question");
    assert.equal(q.content.importance, "normal");
    assert.equal(q.content.required, true);
    assert.equal(q.content.state, "open");
    const ap = env.db.all<{ assurance: string }>("SELECT assurance FROM approvals WHERE project_id = ?", m.pid);
    assert.ok(ap.length > 0 && ap.every((r) => r.assurance === "legacy_unverified"));
  });
});

test("[신규] 이전된 프로젝트 쓰기: 고치기·철회·의견·묶음 제출이 되고, 옛 답·__other 스레드·승인·이전 대응표는 그대로다", async () => {
  await with_api(async (env) => {
    const m = await migrated(env);
    const before = project_counts(env, m.pid);
    const old_messages = comment_messages(env.db, m.q_scope);
    assert.ok(old_messages.length >= 1, "이전된 __other 스레드");
    const v1 = env.db.get<{ current_version_id: string }>("SELECT current_version_id FROM objects WHERE id = ?", m.q_scope)!.current_version_id;
    const old_answer = env.db.get<{ version_id: string; value: string }>(
      "SELECT av.version_id, av.value FROM answer_versions av WHERE av.question_id = ? ORDER BY av.rowid LIMIT 1",
      m.q_scope,
    )!;

    // 중요도를 처음으로 매긴다 (이전 전에는 없던 값) — 새 버전, 옛 버전은 normal 그대로
    const rev = assert_ok(await m.post(`/questions/${m.q_scope}/revisions`, { base_version_id: v1, question: { importance: "high" } }), 201);
    assert.equal(rev.question.version_no, "2");
    const rows = env.db.all<{ importance: string }>("SELECT qv.importance FROM question_versions qv JOIN object_versions ov ON ov.id = qv.version_id WHERE qv.object_id = ? ORDER BY ov.version_no", m.q_scope);
    assert.deepEqual(rows.map((r) => r.importance), ["normal", "high"]);

    // 의견 스레드 하나 더 — 옛 스레드는 그대로
    assert_ok(await m.post("/threads", { target_object_id: m.q_scope, context_kind: "question_comment", initial_message: { body_md: "이전 뒤에 쓴 의견" } }), 201);
    const now_messages = comment_messages(env.db, m.q_scope);
    assert.equal(now_messages.length, old_messages.length + 1);
    assert.deepEqual(now_messages.slice(0, old_messages.length), old_messages, "이전된 의견은 한 글자도 바뀌지 않는다");

    // 철회: 답 없는 쪽이 아니라 답이 있는 질문도 기록은 남는다
    assert_ok(await m.post(`/questions/${m.q_note}/withdraw`, {}), 201);

    const after = project_counts(env, m.pid);
    for (const t of ["questions", "answers", "answer_versions", "approvals", "legacy_mappings"]) assert.equal(after[t], before[t], `${t} 는 그대로`);
    assert.equal(after.question_versions - before.question_versions, 2);
    assert.equal(
      env.db.get<{ value: string }>("SELECT value FROM answer_versions WHERE version_id = ?", old_answer.version_id)!.value,
      old_answer.value,
      "옛 답 버전은 그대로",
    );
    const ap = env.db.all<{ assurance: string }>("SELECT assurance FROM approvals WHERE project_id = ?", m.pid);
    assert.ok(ap.every((r) => r.assurance === "legacy_unverified"), "쓰기가 이전 승인을 verified 로 바꾸지 않는다");
  });
});

test("[신규] 이전된 프로젝트 묶음 제출: 새 문구를 확인(재게시)한 뒤 필수 질문에 다시 답하면 쌓이고, 옛 답은 승계되지 않는다", async () => {
  await with_api(async (env) => {
    const m = await migrated(env);
    const v1 = env.db.get<{ current_version_id: string }>("SELECT current_version_id FROM objects WHERE id = ?", m.q_scope)!.current_version_id;
    assert_ok(await m.post(`/questions/${m.q_scope}/revisions`, { base_version_id: v1, question: { text: "범위를 어떻게 잡을까요? (고침)" } }), 201);
    const stage = env.db.get<{ stage_id: string }>("SELECT stage_id FROM question_sets WHERE id = ?", m.set_id)!.stage_id;
    const form = env.db.get<{ form_key: string }>("SELECT form_key FROM question_sets WHERE id = ?", m.set_id)!.form_key;
    const { publish_set } = await import("../scripts/pes_core/questions.ts");
    const next = (
      await publish_set(env.service, m.ctx("mig-pub"), {
        stage_id: stage,
        round_id: null,
        purpose: "stage_start",
        form_key: form,
        questions: [{ question_id: m.q_scope }, { question_id: m.q_note }],
      })
    ).result as any;
    // q_scope 의 옛 답은 옛 버전에 묶여 있어 묶음에서는 비어 있는 것으로 본다
    const v2 = env.db.get<{ current_version_id: string }>("SELECT current_version_id FROM objects WHERE id = ?", m.q_scope)!.current_version_id;
    const bad = await m.post("/submissions", { set_id: next.set_id, mode: "bundle", answers: [{ question_id: m.q_note, value: "다시 쓴 글" }] });
    assert_final_error(bad, 422, "validation_failed", { target: "$.body.answers" });
    const ok = assert_ok(
      await m.post("/submissions", {
        set_id: next.set_id,
        mode: "bundle",
        answers: [{ question_id: m.q_scope, question_version_id: v2, value: "wide" }, { question_id: m.q_note, value: "다시 쓴 글" }],
      }),
      201,
    );
    assert.equal(ok.form_complete, true);
    const versions = env.db.all<{ value: string; question_version_id: string }>("SELECT value, question_version_id FROM answer_versions WHERE question_id = ? ORDER BY rowid", m.q_scope);
    assert.deepEqual(versions.map((v) => JSON.parse(v.value)), ["narrow", "wide"]);
    assert.equal(versions[0]!.question_version_id, v1);
    assert.equal(versions[1]!.question_version_id, v2);
  });
});

// ---------------------------------------------------------------------------
// 9. A·B 합성 라운드에서 에이전트가 질문을 게시하고 답을 읽는다

test("[회귀] B MCP 경로: pes_ask 로 게시 → 사람이 답과 의견을 제출 → pes_context 입력 → pes_read 로 답·의견을 읽는다", async () => {
  await with_cleanup(async (env, open) => {
    const client = open(await env.client());
    await client.ok("pes_claim", { idempotency_key: "u2-claim" });
    const asked = await client.ok("pes_ask", ask_args(env, "u2", "U2 합성 질문"));
    await client.ok("pes_wait", { idempotency_key: "u2-wait" });
    const res = await call(env, {
      method: "POST",
      path: `/api/v1/projects/${env.p.project_id}/submissions`,
      auth: "owner",
      body: { set_id: asked.question_set_id, answers: [{ question_id: asked.question.id, question_version_id: asked.question.version_id, value: "a", comment: "합성 의견" }] },
    });
    const version_id = assert_ok(res, 201).answers[0].answer_version_id as string;
    env.tick();
    const ctx = await client.ok("pes_context", {});
    const input = (ctx.inputs as any[]).find((i) => i.input_version_id === version_id);
    assert.ok(input, "에이전트가 사람의 답을 입력으로 본다");
    const read = await read_version(client, input.object_id, version_id);
    assert.equal(read.content.value, "a");
    assert.equal(read.content.comment, "합성 의견");
    assert.equal(read.content.question_version_id, asked.question.version_id);
  });
});

test("[신규] B MCP 경로: 질문에 따로 쓴 스레드 의견은 에이전트가 읽는 답에 섞이지 않는다", async () => {
  await with_cleanup(async (env, open) => {
    const client = open(await env.client());
    await client.ok("pes_claim", { idempotency_key: "u2b-claim" });
    const asked = await client.ok("pes_ask", ask_args(env, "u2b", "U2 합성 질문 b"));
    await client.ok("pes_wait", { idempotency_key: "u2b-wait" });
    const thread = await call(env, {
      method: "POST",
      path: `/api/v1/projects/${env.p.project_id}/threads`,
      auth: "owner",
      body: { target_object_id: asked.question.id, context_kind: "question_comment", initial_message: { body_md: "스레드에만 쓴 의견" } },
    });
    assert_ok(thread, 201);
    const version_id = await owner_answers(env, asked, "b");
    env.tick();
    const ctx = await client.ok("pes_context", {});
    const input = (ctx.inputs as any[]).find((i) => i.input_version_id === version_id)!;
    const read = await read_version(client, input.object_id, version_id);
    assert.equal(read.content.value, "b");
    assert.equal(read.content.comment, null);
    assert.doesNotMatch(JSON.stringify(read), /스레드에만 쓴 의견/);
    assert.equal(history_counts(env.db).answer_versions, 1);
  });
});

test("[회귀] A 내장 실행기 도구: 질문 게시(question.ask)는 허용 목록에 있고 모델에 제공된다 — 질문 철회·의견 도구는 아직 없다(보고 사항)", () => {
  assert.ok(A_TOOL_ALLOWLIST.includes("question.ask"));
  assert.ok(TOOL_SPECS.some((t) => t.name === "question.ask"));
  assert.ok(A_TOOL_ALLOWLIST.includes("context.get"), "답은 context.get 으로 읽는다");
  assert.ok(!A_TOOL_ALLOWLIST.some((n) => /withdraw|defer|merge/.test(n)), "에이전트가 질문을 빼는 도구는 이 이슈 범위 밖");
});

test("[회귀] API 경로: 리스를 쥔 에이전트가 질문을 게시하고 사람이 단계 시작 폼에 답한 뒤 에이전트가 답 버전을 읽는다", async () => {
  await with_api(async (env) => {
    const f = await make_form(env, [single_spec("합성 질문")]);
    const q = f.ids[0]!;
    const sub = assert_ok(
      await call(env, {
        method: "POST",
        path: `/api/v1/projects/${env.p.project_id}/submissions`,
        auth: "owner",
        body: { set_id: f.set.set_id, answers: [{ question_id: q, value: "a" }] },
      }),
      201,
    );
    const answer_version = sub.answers[0].answer_version_id as string;
    const object_id = env.db.get<{ object_id: string }>("SELECT object_id FROM answer_versions WHERE version_id = ?", answer_version)!.object_id;
    const { make_agent } = await import("./helpers/api_env.ts");
    const agent = await make_agent(env, "reader-u2");
    const read = assert_ok(
      await call(env, { method: "GET", path: `/api/v1/projects/${env.p.project_id}/objects/${object_id}/versions/${answer_version}`, auth: { token: agent.token } }),
    );
    assert.equal(read.content.value, "a");
  });
});

// ---------------------------------------------------------------------------
// 10. OpenAPI · 픽스처 · 계약 문서 등록

const NEW_QUESTION_ROUTES = [
  { file: "question-withdraw.json", operation: "questions.withdraw", suffix: "withdraw", state: "withdrawn" },
  { file: "question-defer.json", operation: "questions.defer", suffix: "defer", state: "deferred" },
  { file: "question-merge.json", operation: "questions.merge", suffix: "merge", state: "merged" },
] as const;

test("[신규] OpenAPI: 철회·보류·합치기·스레드·메시지 라우트가 POST 로 등록되고 질문 상태 값이 문서에 있다", () => {
  const yaml = text_of("docs", "api", "openapi-v1.yaml");
  const block = (path: string): string => {
    const start = yaml.indexOf(`\n  ${path}:\n`);
    assert.ok(start >= 0, `${path} 가 paths 에 있다`);
    const next = yaml.slice(start + 1).search(/\n {2}\/api\//);
    return next < 0 ? yaml.slice(start) : yaml.slice(start, start + 1 + next);
  };
  for (const r of NEW_QUESTION_ROUTES) {
    const b = block(`/api/v1/projects/{id}/questions/{q}/${r.suffix}`);
    assert.match(b, /\n {4}post:/, `${r.suffix}: POST`);
    assert.match(b, /QuestionId/, `${r.suffix}: 질문 경로 인자`);
    assert.match(b, /IdempotencyKey/, `${r.suffix}: 멱등 키`);
    assert.match(b, /"409"/, `${r.suffix}: 잘못된 전이는 409`);
  }
  for (const path of ["/api/v1/projects/{id}/threads", "/api/v1/projects/{id}/threads/{t}/messages"]) {
    assert.match(block(path), /\n {4}post:/, `${path}: POST`);
  }
  for (const state of ["withdrawn", "deferred", "merged"]) {
    assert.match(yaml, new RegExp(`enum:[^\\n]*\\b${state}\\b[^\\n]*`), `질문 상태 enum 에 ${state}`);
  }
  assert.match(yaml, /mode:\s*\{[^}\n]*enum:\s*\[bundle, single\]/, "SubmissionBody.mode");
});

test("[신규] 1단계 API 계약(6절 표)에 철회·보류·합치기 경로가 올라 있다", () => {
  const doc = text_of("docs", "plan", "stage-1-api.md");
  for (const r of NEW_QUESTION_ROUTES) assert.ok(doc.includes(`P/questions/{q}/${r.suffix}`), `stage-1-api.md 에 ${r.suffix}`);
});

test("[신규] 계약 픽스처: 철회·보류·합치기 장면이 있고 check_fixtures.py 목록에 등록되어 있다", () => {
  const script = text_of("docs", "plan", "fixtures", "check_fixtures.py");
  for (const r of NEW_QUESTION_ROUTES) {
    const path = join(REPO, "docs", "plan", "fixtures", "api-v1", r.file);
    assert.ok(existsSync(path), `${r.file} 가 있다`);
    const fx = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(fx.operation, r.operation);
    assert.equal(fx.method, "POST");
    assert.equal(fx.path, `/api/v1/projects/{project_id}/questions/{question_id}/${r.suffix}`);
    assert.equal(fx.normal.response.status, 201);
    assert.equal(fx.normal.response.body.data.question.state, r.state);
    assert.equal(fx.normal.response.body.data.previous_answers_preserved, true);
    assert.equal(fx.error.response.status, 409, "대표 오류는 잘못된 전이");
    assert.equal(fx.error.response.body.error.code, "conflict");
    assert.ok(script.includes(`"file": "${r.file}"`), `check_fixtures.py SPECS 에 ${r.file}`);
    assert.ok(script.includes(`"operation": "${r.operation}"`));
    assert.ok(script.includes(`P/questions/{q}/${r.suffix}`), "doc_fragments");
  }
});

test("[신규] 질문 의견용 스레드 픽스처에 question_comment 장면이 있다 (threads.json 은 annotation 장면 그대로)", () => {
  const fx = JSON.parse(text_of("docs", "plan", "fixtures", "api-v1", "threads.json"));
  assert.equal(fx.operation, "threads.create");
  const contexts = [fx.normal, ...(fx.extra ?? []), ...(fx.cases ?? [])].map((c: any) => c?.request?.body?.context_kind).filter(Boolean);
  assert.ok(contexts.includes("annotation"), "기존 annotation 장면 유지");
  assert.ok(contexts.includes("question_comment"), "question_comment 장면 추가");
});
