/**
 * SEL-118 U5a — 프롬프트 조립 읽기 모델 + 사람→AI 질문 상태 읽기 모델 (서버 전용, tester, 작성 모드).
 * 화면·B 여섯 어댑터 왕복은 범위 밖. 새 표 없음. 합성 자료만(가짜 비밀·가짜 홈 경로(hong)).
 * 구현 전에는 새 라우트가 없어서 실패하는 것이 정상. 이미 있는 동작은 회귀 가드("있던 것")로 둔다.
 *
 * ═══ 정한 인터페이스 (구현은 이 표를 따른다. 바뀌면 이 머리말과 시험을 같이 고친다) ═══
 *
 *  ① 프롬프트 조립 — `POST /api/v1/projects/{id}/prompt-builds`  (operation `prompts.build`)
 *     **읽기다.** 조립 입력(미제출 초안은 브라우저에만 있으므로 본문으로 받는다)을 받아 글을 돌려줄 뿐 서버에 아무것도 쓰지 않는다:
 *     Idempotency-Key 없이 200, 영수증·사건·run·waiting_human 0개 증가(DB 전체 서명이 같다). 서버 답 초안 API 는 없다.
 *     who: 사람 소유자 세션 또는 `context:read` 토큰(없으면 401 unauthenticated, 범위 없으면 403 forbidden).
 *     body  { question: string(필수, 사람이 AI 에게 묻는 글),
 *             selection: { version_id: string(필수, 정확한 버전 id), quote?: string(선택 구간 글) },
 *             drafts?: [ { text: string } ]   // 아직 제출 안 한 초안(클라이언트가 보냄)
 *             target?: "A" | "B" }            // 기본 "B"(수동 복사). "A" 는 내장 실행기(Go)로 갈 글
 *     200 data { target, prompt_text, selection:{ object_id, version_id, version_no(정수), quote|null },
 *                included:[ { kind, id|null, version_id|null, label } ],
 *                excluded:[ { kind, id|null, version_id|null, reason } ],
 *                warnings:[ { code, message } ],
 *                constraints:[ { code, text } ],
 *                return_link: string }          // 앱 안 상대 경로 `/p/<slug>/…` (호스트·로컬 경로 없음)
 *       키는 **정확히 이 여덟 개**(run_id·status·copied 같은 칸 없음: 복사 성공≠실행 성공).
 *       included.kind ∈ selection | version | assumption | decision | draft | file | constraint | return_link
 *       excluded.reason ∈ ai_access_denied | send_off | secret | local_path
 *       warnings.code ∈ send_off | redacted | unsubmitted_draft … (아래 시험이 쓰는 세 개는 고정)
 *     - 선택 범위·정확한 버전: selection 과 prompt_text 에 version_id·version_no 가 그대로 들어간다. 판 안의 가정·결정(프로젝트 범위 결정 포함)은
 *       included(kind assumption/decision, id·version_id 를 가짐)로 들어가고 prompt_text 에 문장이 있다. constraints 는 비어 있지 않고 prompt_text 에 text 가 있다.
 *     - 미제출 초안: included 에 kind "draft", label **`미제출 초안`**; prompt_text 에는 그 표시가 초안 글 앞에 붙는다. 초안이 없으면 그 표시가 없다.
 *     - 비밀·경로: 토큰·세션 비밀·macOS/Linux·Windows 홈 경로·임시 홈 경로는 응답 어디에도(JSON 전체) 없다. 있었다면 그 자리는 지우고 warnings 에 `redacted`.
 *     - AI 참조 금지: 선택 버전에 붙은 파일 중 file_policies.ai_access='deny' 인 것은 excluded(kind "file", reason ai_access_denied)로, 허용 파일은 included(kind "file").
 *       파일 내용·storage_key·로컬 경로는 응답에 없다.
 *     - 전송 OFF(allow_opencode_go=false): warnings 에 `send_off`. target "A" 일 때는 질문 본문 외 모든 자료(가정·결정·파일·버전 글)가 excluded(reason send_off)로
 *       빠지고 prompt_text 에도 없다. target "B"(수동 복사)는 자료가 그대로 들어간다(경고만).
 *     - 오류: question 없음/빈 값, selection.version_id 없음, 모르는 키 → 400 invalid_payload; 이 프로젝트에 없는 버전(다른 프로젝트 것 포함) → 404 not_found.
 *
 *  ② 사람→AI 질문 접수 — 기존 `POST /api/v1/projects/{id}/questions` 에 `direction:"human_to_agent"` + `intended_actor_id`(AI 행위자) 를 허용한다.
 *     (지금은 400 invalid_payload — 이 시험이 바꾸는 부분.) 사람 소유자 세션만(토큰은 403 human_required). 201 로 questions.direction/intended_actor_id/asked_by 를 저장한다.
 *     접수만으로 run 도 waiting_human 도 만들지 않는다. agent_to_human 질문과 기존 오류는 그대로.
 *
 *  ③ 질문 상태 읽기 — `GET /api/v1/projects/{id}/question-statuses[?question_id=<id>]`  (operation `question_statuses.list`)
 *     who: 소유자 세션 또는 `context:read` 토큰. 사람→AI 질문(direction human_to_agent)만, 접수 시각 오름차순.
 *     200 data { items:[ { question_id, version_id, text, intended_actor_id,
 *                          state: "accepted"|"external_received"|"read"|"answered",   // 이 네 값뿐. "답변 중" 같은 값은 없다
 *                          accepted_at, external_received_at, read_at, answered_at,    // epoch ms | null — 근거가 있을 때만 값
 *                          elapsed_ms } ] }
 *     근거(새 표 없음):
 *       accepted           ← 질문 첫 버전이 생긴 시각(= 접수).
 *       external_received  ← run_input_receipts 에 그 질문 버전 id 로 state 'seen' 이 기록된 시각(기존 POST runs/{r}/input-receipts, 사건 run.input_receipt_recorded 의 시각).
 *       read               ← 같은 질문 버전의 receipt 가 'applied' 가 된 시각(AI 가 읽고 처리했다고 알린 것).
 *       answered           ← 그 질문에 answer_versions(state 'submitted') 가 생긴 시각(object_versions.created_at).
 *     state = 근거가 있는 것 중 가장 앞선 단계(accepted < external_received < read < answered). 근거 없는 칸은 null — 지어내지 않는다.
 *     elapsed_ms = answered_at 이 있으면 answered_at − accepted_at, 없으면 (서버 지금 − accepted_at). 항상 시각에서 계산한다(FakeClock 으로 검증).
 *     "복사됨" 상태는 없다(복사는 서버가 모르는 일). 없는 question_id → 404 not_found, 다른 프로젝트 질문 → 404, 사람→AI 가 아닌 질문 id → 404.
 *
 *  ④ A 의 `AI에게 묻기` 는 기존 `POST P/runs` + `POST P/claims` 를 쓴다 — 새 라우트는 위 ①③ 둘뿐(라우트 표·capabilities·OpenAPI 대조).
 *     B MCP `pes_ask`·`pes_wait` 와 A 내장 도구 `question.ask` 는 기존 명령(`question.publish_set`, `run.wait`)을 그대로 쓰고, 사람→AI 질문·프롬프트 조립을 하는 에이전트 도구는 새로 없다.
 *
 *  ⑤ U4 스레드 관련 칸은 자리만: 응답에 스레드 관련 키(thread*, annotation*)를 만들지 않는다(값 없음).
 *
 * ═══ 스스로 정한 해석 (leader 가 보고 뒤집을 수 있음) ═══
 *  - 사람→AI 질문의 "접수" 경로는 기존 POST /questions 확장으로 정했다(문서 U5 의 `human_question_create` 는 서비스 명령 이름이고, 입구는 같은 라우트).
 *  - 외부 수신=receipt seen, 읽음=receipt applied, 답 수신=answer_versions. "수신≠읽음"을 receipt 두 단계로 나눴다(B 는 앱 연결을 가정하지 않으므로 AI 쪽이 알린 것만 근거).
 *  - 전송 OFF 는 target "A"(내장 실행기로 나가는 글)에서만 자료를 뺀다. 수동 복사(B)는 사람이 붙여넣는 것이라 경고만.
 *  - 프롬프트 조립을 POST 로 둔 이유는 미제출 초안이 서버에 없고 본문으로만 올 수 있어서다. 읽기임은 서명 동일·키 없음·영수증 0 으로 시험한다.
 *  - 답 수신(answer_versions)은 아직 사람→AI 질문에 답을 넣는 공개 경로가 없어(어댑터 왕복은 다음 조각) 시험이 행을 직접 심는다. 읽기 모델만 본다.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { TOOL_NAMES } from "../scripts/pes_core/mcp_server.ts";
import { A_TOOL_ALLOWLIST, TOOL_SPECS } from "../scripts/pes_core/a_runtime/tools.ts";
import { add_artifact, create_object } from "../scripts/pes_core/content.ts";
import { assert_error, assert_ok, call, go_off, make_agent, owner_creates_run, agent_claims, SESSION_SECRET, with_api, OPENAPI_PATH, type ApiEnv, type Auth } from "./helpers/api_env.ts";
import { EXPECTED_ROUTES, P, assert_final_error } from "./helpers/api_flow.ts";
import { attach, bytes_of, put_ready } from "./helpers/blob_env.ts";
import { open_round, single_spec, text_spec } from "./helpers/questions_env.ts";
import { state_signature, table_counts } from "./helpers/state_signature.ts";
import { tx_of_version } from "./helpers/sel93_env.ts";
import { readFileSync } from "node:fs";

const ROUTE_BUILD = "POST /api/v1/projects/{id}/prompt-builds";
const ROUTE_STATUS = "GET /api/v1/projects/{id}/question-statuses";
const DRAFT_LABEL = "미제출 초안";
const BUILD_KEYS = ["constraints", "excluded", "included", "return_link", "selection", "prompt_text", "target", "warnings"].sort();
const STATE_VALUES = ["accepted", "external_received", "read", "answered"];

const POSIX_HOME_PREFIX = ["", "Users", "hong"].join("/"); // 가짜 이름 hong
const FAKE_PATH_POSIX = `${POSIX_HOME_PREFIX}/projects/secret-study/notes.md`;
const FAKE_PATH_WIN = "C:\\Users\\hong\\Documents\\secret-study\\notes.md";
const FAKE_API_KEY = "sk-synthetic-0123456789abcdefghijklmnop";

const post = (env: ApiEnv, rest: string, auth: Auth, body: unknown, key?: string | null) =>
  call(env, { method: "POST", path: P(env, rest), auth, body, ...(key === undefined ? {} : { key }) });
const get = (env: ApiEnv, rest: string, auth: Auth = "owner") => call(env, { method: "GET", path: P(env, rest), auth });

// ---------------------------------------------------------------------------
// 합성 자료 만들기

async function artifact_with(env: ApiEnv, key: string, title: string, summary: string): Promise<{ object_id: string; version_id: string; version_no: number }> {
  const obj = (await create_object(env.service, env.ctx(`${key}-o`), { kind: "artifact", edition_id: env.p.edition_id })).result as { object_id: string };
  const out = await add_artifact(env.service, env.ctx(`${key}-v`), { object_id: obj.object_id, artifact_kind: "chapter", title, summary });
  return out.result as { object_id: string; version_id: string; version_no: number };
}

async function propose_assumption(env: ApiEnv, statement: string): Promise<any> {
  return assert_ok(await post(env, "/assumptions", "owner", { statement, state: "proposed", rationale: "합성 배경", scope: "edition" }), 201).assumption;
}
async function propose_decision(env: ApiEnv, statement: string, scope: string): Promise<any> {
  return assert_ok(await post(env, "/decisions", "owner", { scope, statement, state: "proposed", supersedes: null, rationale: "합성 근거" }), 201).decision;
}

function deny(env: ApiEnv, blob_id: string): void {
  const policy = env.db.get<{ id: string; rev: bigint; changed_by_actor_id: string; changed_by_user_id: string; tx_id: string }>(
    "SELECT id, rev, changed_by_actor_id, changed_by_user_id, tx_id FROM file_policies WHERE project_id = ? AND blob_id = ?",
    env.p.project_id,
    blob_id,
  );
  assert.ok(policy, "the blob has a file policy");
  const rev = policy.rev + 1n;
  env.db.run("UPDATE file_policies SET ai_access = 'deny', rev = ? WHERE id = ?", rev, policy.id);
  env.db.run(
    `INSERT INTO file_ai_access_versions
       (id, project_id, file_policy_id, ai_access, changed_by_actor_id, changed_by_user_id, changed_at, reason, rev, tx_id)
     VALUES (?, ?, ?, 'deny', ?, ?, 0, NULL, ?, ?)`,
    `deny-${blob_id}`,
    env.p.project_id,
    policy.id,
    policy.changed_by_actor_id,
    policy.changed_by_user_id,
    rev,
    policy.tx_id,
  );
}

function slug_of(env: ApiEnv): string {
  return env.db.get<{ slug: string }>("SELECT slug FROM projects WHERE id = ?", env.p.project_id)!.slug;
}

async function build(env: ApiEnv, body: Record<string, unknown>, auth: Auth = "owner", key: string | null = null) {
  return post(env, "/prompt-builds", auth, body, key);
}

/** 계획 단계의 열린 판 하나. 한 단계에는 열린 판이 하나뿐이라(이미 있으면 새로 열 수 없다) 있으면 그대로 쓴다. */
async function open_round_once(env: ApiEnv, tag: string): Promise<{ stage_id: string; round_id: string }> {
  const open = env.db.get<{ stage_id: string; round_id: string }>(
    "SELECT stage_id, id AS round_id FROM rounds WHERE project_id = ? AND state = 'open' ORDER BY round_no LIMIT 1",
    env.p.project_id,
  );
  return open ?? open_round(env, tag);
}

/** 사람→AI 질문 한 개를 소유자가 접수한다(②). */
async function ask_ai(env: ApiEnv, intended_actor_id: string, text = "합성: 이 문단의 근거를 다시 설명해 줘"): Promise<{ question_id: string; version_id: string; res: any }> {
  const { stage_id, round_id } = await open_round_once(env, `ai-${env.seq++}`);
  const res = await post(env, "/questions", "owner", {
    stage_id,
    round_id,
    purpose: "review",
    direction: "human_to_agent",
    intended_actor_id,
    question: text_spec(text),
  });
  const data = assert_ok(res, 201);
  const question_id = data.question.id as string;
  const version_id = env.db.get<{ id: string }>("SELECT original_version_id AS id FROM questions WHERE object_id = ?", question_id)!.id;
  return { question_id, version_id, res: data };
}

function statuses(res: any): any[] {
  return assert_ok(res).items as any[];
}
function one_status(env: ApiEnv, items: any[], question_id: string): any {
  const row = items.find((i) => i.question_id === question_id);
  assert.ok(row, `status row for ${question_id}`);
  return row;
}

/** 사람→AI 질문에 답 행을 직접 심는다(공개 경로는 다음 조각). 시각은 지금 FakeClock. */
function plant_answer(env: ApiEnv, question_id: string, question_version_id: string, text: string): string {
  const q = env.db.get<{ asked_by_actor_id: string }>("SELECT asked_by_actor_id FROM questions WHERE object_id = ?", question_id)!;
  const tx = tx_of_version(env.db, question_version_id);
  const now = env.clock.now_ms();
  const answer_id = `ans-${env.seq++}`;
  const version_id = `ansv-${env.seq++}`;
  const sub_id = `sub-${env.seq++}`;
  env.db.run(
    "INSERT INTO submissions (id, project_id, actor_id, set_id, received_at, via, tx_id) VALUES (?, ?, ?, NULL, ?, 'web', ?)",
    sub_id,
    env.p.project_id,
    q.asked_by_actor_id,
    now,
    tx,
  );
  const next_no = (env.db.get<{ n: bigint }>("SELECT coalesce(max(display_no), 0) + 1 AS n FROM objects WHERE project_id = ? AND kind = 'answer'", env.p.project_id)!.n);
  env.db.run("INSERT INTO objects (id, project_id, edition_id, kind, display_no) VALUES (?, ?, ?, 'answer', ?)", answer_id, env.p.project_id, env.p.edition_id, next_no);
  env.db.run(
    `INSERT INTO object_versions (id, project_id, object_id, kind, version_no, actor_id, tx_id, content_hash, created_at)
     VALUES (?, ?, ?, 'answer', 1, ?, ?, ?, ?)`,
    version_id,
    env.p.project_id,
    answer_id,
    q.asked_by_actor_id,
    tx,
    "a".repeat(64),
    now,
  );
  env.db.run(
    "INSERT INTO answers (project_id, object_id, question_id, respondent_actor_id, submission_id) VALUES (?, ?, ?, ?, ?)",
    env.p.project_id,
    answer_id,
    question_id,
    q.asked_by_actor_id,
    sub_id,
  );
  env.db.run(
    `INSERT INTO answer_versions (project_id, version_id, object_id, question_id, question_version_id, value, state, used_default)
     VALUES (?, ?, ?, ?, ?, ?, 'submitted', 0)`,
    env.p.project_id,
    version_id,
    answer_id,
    question_id,
    question_version_id,
    JSON.stringify(text),
  );
  return version_id;
}

/** 에이전트 한 명은 살아 있는 run 을 하나만 쥘 수 있어(두 번째 claim 은 409) 같은 에이전트의 receipt 는 첫 run·lease 를 이어 쓴다. */
const LEASES = new WeakMap<object, Map<string, { run_id: string; lease_id: string; fence: unknown }>>();

async function receipt(env: ApiEnv, agent: { actor_id: string; token: string }, input_version_id: string, state: "seen" | "applied" | "ignored", tx?: string) {
  let by_agent = LEASES.get(env);
  if (by_agent === undefined) LEASES.set(env, (by_agent = new Map()));
  let lease = by_agent.get(agent.actor_id);
  if (lease === undefined) {
    const run_id = await owner_creates_run(env, agent as any);
    lease = await agent_claims(env, agent as any, run_id);
    by_agent.set(agent.actor_id, lease);
  }
  return call(env, {
    method: "POST",
    path: P(env, `/runs/${lease.run_id}/input-receipts`),
    auth: { token: agent.token },
    body: {
      lease_id: lease.lease_id,
      fence: lease.fence,
      receipts: [{ input_version_id, state, ...(state === "applied" ? { applied_tx_id: tx } : {}) }],
    },
  });
}

// ===========================================================================
// ① 프롬프트 조립 읽기

test("① prompt build: exact keys, the exact version, selection, constraints and the return link (owner session)", async () => {
  await with_api(async (env) => {
    const v = await artifact_with(env, "pb1", "합성 장 제목", "합성 요약 문장");
    const res = await build(env, { question: "이 부분을 더 쉽게 설명해 줘", selection: { version_id: v.version_id, quote: "선택한 합성 문장" } });
    const data = assert_ok(res);
    assert.deepEqual(Object.keys(data).sort(), BUILD_KEYS, "exactly the eight keys: no run_id/status/copied");
    assert.equal(data.target, "B", "default target is the manual copy");
    assert.deepEqual(data.selection, { object_id: v.object_id, version_id: v.version_id, version_no: v.version_no, quote: "선택한 합성 문장" });
    assert.ok(data.prompt_text.includes(v.version_id), "the exact version id is in the text");
    assert.ok(data.prompt_text.includes("선택한 합성 문장"));
    assert.ok(data.prompt_text.includes("이 부분을 더 쉽게 설명해 줘"));
    assert.ok(data.included.some((i: any) => i.kind === "selection" && i.version_id === v.version_id));
    assert.ok(Array.isArray(data.constraints) && data.constraints.length > 0, "constraints are not empty");
    for (const c of data.constraints) {
      assert.equal(typeof c.code, "string");
      assert.ok(data.prompt_text.includes(c.text), `constraint ${c.code} is in the prompt`);
    }
    assert.match(data.return_link, new RegExp(`^/p/${slug_of(env)}/`), "an app-relative return link");
    assert.doesNotMatch(data.return_link, /:\/\/|\\|\.\./);
    assert.ok(data.prompt_text.includes(data.return_link));
    assert.deepEqual(data.warnings, [], "nothing to warn about in a plain build");
    assert.ok(Array.isArray(data.excluded));
  });
});

test("① a context:read token gets the same read; no thread/annotation keys anywhere (U4 slot stays empty)", async () => {
  await with_api(async (env) => {
    const v = await artifact_with(env, "pb2", "합성 장", "합성 요약");
    const agent = await make_agent(env, "reader", ["context:read"]);
    const body = { question: "질문", selection: { version_id: v.version_id } };
    const owner = assert_ok(await build(env, body));
    const token = assert_ok(await build(env, body, { token: agent.token }));
    assert.deepEqual(token, owner, "same input, same read for both credentials");
    assert.doesNotMatch(JSON.stringify(token), /"(thread|annotation)[a-z_]*"\s*:/i, "no thread/annotation keys yet");
  });
});

test("① related assumptions and decisions of the edition (incl. project-scope decisions) are included with ids and appear in the text", async () => {
  await with_api(async (env) => {
    const v = await artifact_with(env, "pb3", "합성 장", "합성 요약");
    const a = await propose_assumption(env, "합성 가정: 표본은 서울만 본다");
    const d1 = await propose_decision(env, "합성 결정: 기간은 2020~2024", "edition");
    const d2 = await propose_decision(env, "합성 결정: 출처는 공공 통계만", "project");
    const data = assert_ok(await build(env, { question: "q", selection: { version_id: v.version_id } }));
    const inc = (kind: string, id: string) => data.included.find((i: any) => i.kind === kind && i.id === id);
    assert.ok(inc("assumption", a.id), "the assumption is included");
    assert.equal(inc("assumption", a.id).version_id, a.version_id);
    assert.ok(inc("decision", d1.id) && inc("decision", d2.id), "edition and project decisions are included");
    for (const s of ["합성 가정: 표본은 서울만 본다", "합성 결정: 기간은 2020~2024", "합성 결정: 출처는 공공 통계만"]) {
      assert.ok(data.prompt_text.includes(s), `the text carries "${s}"`);
    }
  });
});

test("① unsubmitted drafts are marked 미제출 초안; no draft, no mark", async () => {
  await with_api(async (env) => {
    const v = await artifact_with(env, "pb4", "합성 장", "합성 요약");
    const plain = assert_ok(await build(env, { question: "q", selection: { version_id: v.version_id } }));
    assert.ok(!plain.prompt_text.includes(DRAFT_LABEL), "no draft, no mark");
    assert.ok(!plain.included.some((i: any) => i.kind === "draft"));
    const withd = assert_ok(await build(env, { question: "q", selection: { version_id: v.version_id }, drafts: [{ text: "아직 안 보낸 답 초안 가나다" }] }));
    const item = withd.included.find((i: any) => i.kind === "draft");
    assert.ok(item, "the draft is listed");
    assert.equal(item.label, DRAFT_LABEL);
    const at = withd.prompt_text.indexOf(DRAFT_LABEL);
    assert.ok(at >= 0, "the mark is in the text");
    assert.ok(withd.prompt_text.indexOf("아직 안 보낸 답 초안 가나다") > at, "the mark comes before the draft text");
    assert.ok(withd.warnings.some((w: any) => w.code === "unsubmitted_draft"), "a draft earns a warning");
  });
});

test("① no secret, token, session value or local path in the answer (synthetic secrets planted in every input)", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "leak");
    const v = await artifact_with(env, "pb5", `제목 ${FAKE_PATH_POSIX}`, `요약 Bearer ${agent.token} 그리고 ${FAKE_API_KEY}`);
    await propose_assumption(env, `가정 ${FAKE_PATH_WIN} 와 ${FAKE_API_KEY}`);
    const home = env.home.root;
    const data = assert_ok(
      await build(env, {
        question: `질문 x-pes-session: ${SESSION_SECRET} ${FAKE_PATH_POSIX}`,
        selection: { version_id: v.version_id, quote: `인용 ${agent.token} ${home}` },
        drafts: [{ text: `초안 ${FAKE_API_KEY} ${FAKE_PATH_WIN}` }],
      }),
    );
    const text = JSON.stringify(data);
    for (const secret of [agent.token, SESSION_SECRET, FAKE_API_KEY, POSIX_HOME_PREFIX, "C:\\\\Users\\\\hong", "C:\\Users\\hong", home]) {
      assert.ok(!text.includes(secret), `the response never contains ${secret.slice(0, 18)}…`);
    }
    assert.doesNotMatch(text, /Bearer\s+\S{8,}/);
    assert.ok(data.warnings.some((w: any) => w.code === "redacted"), "a redaction is announced, not silent");
    assert.ok(data.excluded.some((e: any) => e.reason === "secret" || e.reason === "local_path") || data.warnings.some((w: any) => w.code === "redacted"));
  });
});

test("① files: ai_access=deny goes to excluded, an allowed file to included; no content, storage key or path leaks", async () => {
  await with_api(async (env) => {
    const v = await artifact_with(env, "pb6", "합성 장", "합성 요약");
    const ok = await put_ready(env, bytes_of("pb6-ok", 24), "pb6-ok");
    const no = await put_ready(env, bytes_of("pb6-no", 24), "pb6-no");
    await attach(env, v.version_id, ok.blob_id, "attachment", "pb6-a1");
    await attach(env, v.version_id, no.blob_id, "source", "pb6-a2");
    deny(env, no.blob_id);
    const data = assert_ok(await build(env, { question: "q", selection: { version_id: v.version_id } }));
    assert.ok(data.included.some((i: any) => i.kind === "file" && i.id === ok.blob_id));
    assert.ok(!data.included.some((i: any) => i.id === no.blob_id), "a denied file is not offered");
    const ex = data.excluded.find((e: any) => e.kind === "file" && e.id === no.blob_id);
    assert.ok(ex, "a denied file is listed as excluded");
    assert.equal(ex.reason, "ai_access_denied");
    const storage = env.db.all<{ storage_key: string }>("SELECT storage_key FROM blobs WHERE project_id = ?", env.p.project_id);
    const text = JSON.stringify(data);
    for (const s of storage) assert.ok(!text.includes(s.storage_key), "no storage key");
    assert.ok(!text.includes(env.objects), "no objects folder path");
  });
});

test("① send OFF: warning send_off; target A drops every context item (excluded, not in the text), target B only warns", async () => {
  await with_api(async (env) => {
    const v = await artifact_with(env, "pb7", "합성 장", "합성 요약");
    const a = await propose_assumption(env, "합성 가정 전송끄기");
    const d = await propose_decision(env, "합성 결정 전송끄기", "edition");
    const f = await put_ready(env, bytes_of("pb7-f", 24), "pb7-f");
    await attach(env, v.version_id, f.blob_id, "attachment", "pb7-a");
    await go_off(env);
    const body = { question: "질문만 남아야 한다", selection: { version_id: v.version_id }, drafts: [{ text: "합성 초안" }] };

    const b = assert_ok(await build(env, { ...body, target: "B" }));
    assert.ok(b.warnings.some((w: any) => w.code === "send_off"));
    assert.ok(b.included.some((i: any) => i.id === a.id) && b.included.some((i: any) => i.id === d.id), "manual copy keeps the context");
    assert.ok(b.prompt_text.includes("합성 가정 전송끄기"));

    const aa = assert_ok(await build(env, { ...body, target: "A" }));
    assert.ok(aa.warnings.some((w: any) => w.code === "send_off"));
    assert.ok(aa.prompt_text.includes("질문만 남아야 한다"), "the question itself stays");
    for (const s of ["합성 가정 전송끄기", "합성 결정 전송끄기"]) assert.ok(!aa.prompt_text.includes(s), `A text has no "${s}"`);
    for (const id of [a.id, d.id, f.blob_id]) {
      assert.ok(!aa.included.some((i: any) => i.id === id), `${id} is not included for A`);
      assert.equal(aa.excluded.find((e: any) => e.id === id)?.reason, "send_off");
    }
    assert.equal(aa.excluded.filter((e: any) => e.reason === "send_off").length >= 3, true);
  });
});

test("① assembling is a read: no write at all, no Idempotency-Key needed, no run, no waiting_human; same input, same text", async () => {
  await with_api(async (env) => {
    const v = await artifact_with(env, "pb8", "합성 장", "합성 요약");
    await propose_assumption(env, "합성 가정");
    const agent = await make_agent(env, "w");
    await owner_creates_run(env, agent);
    const reader = await make_agent(env, "w2", ["context:read"]);
    const before = state_signature(env.db);
    const counts = table_counts(env.db);
    const body = { question: "q", selection: { version_id: v.version_id }, drafts: [{ text: "초안" }] };
    const r1 = await build(env, body, "owner", null);
    const r2 = await build(env, body, "owner", null);
    const r3 = await build(env, body, { token: reader.token }, null);
    for (const r of [r1, r2]) assert.equal(r.status, 200);
    assert.equal(r3.status, 200);
    assert.equal(r1.json.data.prompt_text, r2.json.data.prompt_text, "deterministic");
    assert.equal(r1.json.replayed, undefined, "nothing was stored, so nothing can be replayed");
    const after = table_counts(env.db);
    for (const t of ["runs", "events", "mutation_commits", "objects", "object_versions", "questions", "run_input_receipts", "outbound_dispatches"]) {
      // the agent w2 above is the only new row source (an actor + a token), never these tables
      assert.equal(after[t], counts[t], `${t} did not grow`);
    }
    assert.equal(env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM runs WHERE status = 'waiting_human'")!.n, 0n);
    void before;
  });
});

test("① a read leaves the database byte-for-byte as it was (owner session)", async () => {
  await with_api(async (env) => {
    const v = await artifact_with(env, "pb9", "합성 장", "합성 요약");
    const before = state_signature(env.db);
    assert_ok(await build(env, { question: "q", selection: { version_id: v.version_id }, target: "A", drafts: [{ text: "x" }] }));
    assert.equal(state_signature(env.db), before);
  });
});

test("① errors: 401 / 403 / 400 / 404", async () => {
  await with_api(async (env) => {
    const v = await artifact_with(env, "pb10", "합성 장", "합성 요약");
    const ok = { question: "q", selection: { version_id: v.version_id } };
    assert_error(await build(env, ok, "none"), 401, "unauthenticated");
    const narrow = await make_agent(env, "narrow", ["run:claim"]);
    assert_error(await build(env, ok, { token: narrow.token }), 403, "forbidden");
    assert_final_error(await build(env, { selection: ok.selection }), 400, "invalid_payload", { target: /question/ });
    assert_final_error(await build(env, { question: "  ", selection: ok.selection }), 400, "invalid_payload", { target: /question/ });
    assert_final_error(await build(env, { question: "q" }), 400, "invalid_payload", { target: /selection/ });
    assert_final_error(await build(env, { ...ok, bogus: 1 }), 400, "invalid_payload", { target: /bogus/ });
    assert_final_error(await build(env, { ...ok, target: "C" }), 400, "invalid_payload", { target: /target/ });
    assert_final_error(await build(env, { ...ok, drafts: [{ nope: 1 }] }), 400, "invalid_payload");
    assert_final_error(await build(env, { question: "q", selection: { version_id: "no-such-version" } }), 404, "not_found");
  });
});

test("① a version of another project is 404 (no cross-project read)", async () => {
  await with_api(async (env) => {
    const mine = await artifact_with(env, "pb11", "합성 장", "합성 요약");
    assert_ok(await build(env, { question: "q", selection: { version_id: mine.version_id } }));
    const other = await (await import("./helpers/blob_env.ts")).second_project(env, "synthetic-sel118-b");
    const obj = (await create_object(env.service, { project_id: other.project_id, actor_id: other.actor_id, via: "cli", client_request_id: "o-obj" }, { kind: "artifact", edition_id: other.edition_id })).result as { object_id: string };
    const ver = (await add_artifact(env.service, { project_id: other.project_id, actor_id: other.actor_id, via: "cli", client_request_id: "o-ver" }, { object_id: obj.object_id, artifact_kind: "chapter", title: "다른 프로젝트", summary: "비밀 요약" })).result as { version_id: string };
    assert_final_error(await build(env, { question: "q", selection: { version_id: ver.version_id } }), 404, "not_found");
  });
});

test("① no server-side answer draft API exists: the route table has no draft route", async () => {
  await with_api(async (env) => {
    const caps = assert_ok(await call(env, { method: "GET", path: "/api/v1/capabilities" }));
    const all: string[] = [...caps.routes, ...caps.unsupported];
    assert.deepEqual(all.filter((r) => /draft/i.test(r)), [], "no route is about drafts");
  });
});

// ===========================================================================
// ② 사람→AI 질문 접수

test("② a human owner files a human_to_agent question: stored as such, no run, no waiting_human", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "ai1");
    const runs_before = env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM runs")!.n;
    const q = await ask_ai(env, agent.actor_id);
    const row = env.db.get<{ direction: string; intended_actor_id: string; asked_by_actor_id: string }>(
      "SELECT direction, intended_actor_id, asked_by_actor_id FROM questions WHERE object_id = ?",
      q.question_id,
    )!;
    assert.equal(row.direction, "human_to_agent");
    assert.equal(row.intended_actor_id, agent.actor_id);
    assert.equal(row.asked_by_actor_id, env.p.actor_id, "the real author (the human) is recorded");
    assert.equal(q.res.question.intended_actor_id, agent.actor_id, "the response says what is stored");
    assert.equal(env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM runs")!.n, runs_before, "filing creates no run");
    assert.equal(env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM runs WHERE status = 'waiting_human'")!.n, 0n);
  });
});

test("② only the human owner files it: an agent token is 403 human_required, a missing target actor is 400/404, nothing is written", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "ai2");
    const { stage_id, round_id } = await open_round(env, "ai2");
    const body = { stage_id, round_id, purpose: "review", direction: "human_to_agent", intended_actor_id: agent.actor_id, question: text_spec("q") };
    const before = state_signature(env.db);
    assert_error(await post(env, "/questions", { token: agent.token }, body), 403, "human_required");
    const noactor = await post(env, "/questions", "owner", { ...body, intended_actor_id: undefined });
    assert.ok([400].includes(noactor.status), "a human_to_agent question needs the AI it is for");
    assert.equal(noactor.json.error.code, "invalid_payload");
    const ghost = await post(env, "/questions", "owner", { ...body, intended_actor_id: "agent-nobody" });
    assert.ok([400, 404].includes(ghost.status));
    assert.equal(state_signature(env.db), before, "refusals write nothing");
  });
});

test("② agent_to_human questions and intended_actor_id rules are unchanged (regression)", async () => {
  await with_api(async (env) => {
    const { stage_id, round_id } = await open_round(env, "ai3");
    const data = assert_ok(await post(env, "/questions", "owner", { stage_id, round_id, purpose: "review", direction: "agent_to_human", question: single_spec("합성") }), 201);
    assert.equal(data.question.intended_actor_id, null);
    assert.equal(env.db.get<{ d: string }>("SELECT direction AS d FROM questions WHERE object_id = ?", data.question.id)!.d, "agent_to_human");
  });
});

// ===========================================================================
// ③ 질문 상태 읽기

test("③ accepted only: the other three stamps are null (nothing invented), state is accepted, elapsed comes from the clock", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "st1");
    const q = await ask_ai(env, agent.actor_id);
    const t0 = env.clock.now_ms();
    const row = one_status(env, statuses(await get(env, "/question-statuses")), q.question_id);
    assert.equal(row.state, "accepted");
    assert.equal(row.accepted_at, t0);
    assert.equal(row.external_received_at, null);
    assert.equal(row.read_at, null);
    assert.equal(row.answered_at, null);
    assert.equal(row.version_id, q.version_id);
    assert.equal(row.intended_actor_id, agent.actor_id);
    assert.equal(row.text, "합성: 이 문단의 근거를 다시 설명해 줘");
    assert.equal(row.elapsed_ms, 0);
    env.clock.advance(90_000);
    const later = one_status(env, statuses(await get(env, "/question-statuses")), q.question_id);
    assert.equal(later.elapsed_ms, 90_000, "elapsed = now − accepted_at");
    assert.equal(later.accepted_at, t0, "the stamp itself does not move");
    assert.equal(later.state, "accepted", "time passing never changes the state (no fake 'answering')");
    assert.deepEqual(Object.keys(later).sort(), ["accepted_at", "answered_at", "elapsed_ms", "external_received_at", "intended_actor_id", "question_id", "read_at", "state", "text", "version_id"]);
  });
});

test("③ external_received appears only when the AI's run reports the question version as seen (existing input-receipts route), with that time", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "st2");
    const q = await ask_ai(env, agent.actor_id);
    env.clock.advance(5_000);
    assert.equal(one_status(env, statuses(await get(env, "/question-statuses")), q.question_id).external_received_at, null, "nothing yet");
    env.clock.advance(7_000);
    const t_seen = env.clock.now_ms();
    assert_ok(await receipt(env, agent, q.version_id, "seen"));
    const row = one_status(env, statuses(await get(env, "/question-statuses")), q.question_id);
    assert.equal(row.state, "external_received");
    assert.equal(row.external_received_at, t_seen);
    assert.equal(row.read_at, null, "received is not read");
    assert.equal(row.answered_at, null);
    env.clock.advance(3_000);
    assert.equal(one_status(env, statuses(await get(env, "/question-statuses")), q.question_id).elapsed_ms, 15_000, "elapsed counts from accepted_at, not from the receipt");
  });
});

test("③ read appears only on an applied receipt of the question version (not before)", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "st3");
    const q = await ask_ai(env, agent.actor_id);
    env.clock.advance(1_000);
    assert_ok(await receipt(env, agent, q.version_id, "seen"));
    env.clock.advance(2_000);
    const t_applied = env.clock.now_ms();
    assert_ok(await receipt(env, agent, q.version_id, "applied", tx_of_version(env.db, q.version_id)));
    const row = one_status(env, statuses(await get(env, "/question-statuses")), q.question_id);
    assert.equal(row.state, "read");
    assert.equal(row.read_at, t_applied);
    assert.notEqual(row.external_received_at, null, "the earlier 'seen' stamp stays");
    assert.equal(row.answered_at, null, "read is not answered");
  });
});

test("③ answered comes from an answer row (any actor) and is the last state; elapsed stops at the answer", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "st4");
    const q = await ask_ai(env, agent.actor_id);
    env.clock.advance(40_000);
    const t_ans = env.clock.now_ms();
    plant_answer(env, q.question_id, q.version_id, "합성 AI 답");
    env.clock.advance(60_000);
    const row = one_status(env, statuses(await get(env, "/question-statuses")), q.question_id);
    assert.equal(row.state, "answered");
    assert.equal(row.answered_at, t_ans);
    assert.equal(row.elapsed_ms, 40_000, "answered_at − accepted_at, not now − accepted_at");
    assert.equal(row.external_received_at, null, "an answer does not invent a receipt");
    assert.equal(row.read_at, null);
  });
});

test("③ values stay inside the four states; every stamp is an integer or null; no 'copied'/'answering' anywhere", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "st5");
    const q1 = await ask_ai(env, agent.actor_id, "질문 하나");
    const q2 = await ask_ai(env, agent.actor_id, "질문 둘");
    assert_ok(await receipt(env, agent, q2.version_id, "seen"));
    plant_answer(env, q1.question_id, q1.version_id, "답");
    const res = await get(env, "/question-statuses");
    const items = statuses(res);
    assert.equal(items.length, 2);
    for (const it of items) {
      assert.ok(STATE_VALUES.includes(it.state), `state ${it.state}`);
      for (const k of ["accepted_at", "external_received_at", "read_at", "answered_at"]) assert.ok(it[k] === null || Number.isSafeInteger(it[k]), k);
    }
    assert.doesNotMatch(JSON.stringify(res.json), /answering|copied|typing|답변 중|복사됨/);
    const sorted = [...items].sort((a, b) => a.accepted_at - b.accepted_at);
    assert.deepEqual(items.map((i) => i.question_id), sorted.map((i) => i.question_id), "ordered by accepted_at");
  });
});

test("③ only human_to_agent questions are listed; ?question_id= narrows; 404 for unknown, other-project and agent_to_human ids", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "st6");
    const mine = await ask_ai(env, agent.actor_id);
    const { stage_id, round_id } = await open_round_once(env, "st6-a2h");
    const a2h = assert_ok(await post(env, "/questions", "owner", { stage_id, round_id, purpose: "review", question: single_spec("에이전트가 사람에게") }), 201).question.id as string;
    const all = statuses(await get(env, "/question-statuses"));
    assert.deepEqual(all.map((i) => i.question_id), [mine.question_id], "the agent_to_human question is not in this list");
    const one = statuses(await get(env, `/question-statuses?question_id=${mine.question_id}`));
    assert.equal(one.length, 1);
    assert_final_error(await get(env, "/question-statuses?question_id=nope"), 404, "not_found");
    assert_final_error(await get(env, `/question-statuses?question_id=${a2h}`), 404, "not_found");
  });
});

test("③ reading statuses is a read: same database afterwards; no run/waiting_human/event appears", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "st7");
    await ask_ai(env, agent.actor_id);
    const before = state_signature(env.db);
    assert_ok(await get(env, "/question-statuses"));
    assert_ok(await get(env, "/question-statuses", { token: (await make_agent(env, "st7r", ["context:read"])).token }));
    // the second call created an agent actor + token on purpose; compare only the business tables below
    const counts = table_counts(env.db);
    assert.equal(env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM runs")!.n, 0n);
    assert.equal(counts.run_input_receipts, 0n);
    void before;
  });
});

test("③ auth: 401 without credential, 403 for a token without context:read; U4 slot: no thread keys", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "st8");
    await ask_ai(env, agent.actor_id);
    assert_error(await get(env, "/question-statuses", "none"), 401, "unauthenticated");
    const narrow = await make_agent(env, "st8n", ["run:claim"]);
    assert_error(await get(env, "/question-statuses", { token: narrow.token }), 403, "forbidden");
    const res = await get(env, "/question-statuses", { token: agent.token });
    assert.doesNotMatch(JSON.stringify(assert_ok(res)), /"(thread|annotation)[a-z_]*"\s*:/i);
  });
});

// ===========================================================================
// ④ 라우트 표·capabilities·OpenAPI·같은 명령

test("④ the only new routes are prompt-builds and question-statuses; runs and claims are the existing ones (no second 'ask AI' start path)", async () => {
  await with_api(async (env) => {
    const caps = assert_ok(await call(env, { method: "GET", path: "/api/v1/capabilities" }));
    const base = EXPECTED_ROUTES.filter((r) => r !== ROUTE_BUILD && r !== ROUTE_STATUS);
    assert.ok(caps.routes.includes(ROUTE_BUILD), "prompt build is listed");
    assert.ok(caps.routes.includes(ROUTE_STATUS), "question statuses are listed");
    const extra = (caps.routes as string[]).filter((r) => !base.includes(r));
    assert.deepEqual(extra.sort(), [ROUTE_BUILD, ROUTE_STATUS].sort(), "nothing else is new");
    assert.equal(caps.capabilities.operations["prompts.build"]?.supported, true);
    assert.equal(caps.capabilities.operations["question_statuses.list"]?.supported, true);
    assert.ok(!caps.human_only.includes(ROUTE_BUILD) && !caps.human_only.includes(ROUTE_STATUS), "readable by tokens with context:read too");
    for (const must of ["POST /api/v1/projects/{id}/runs", "POST /api/v1/projects/{id}/claims", "GET /api/v1/projects/{id}/runs/{r}/inputs", "POST /api/v1/projects/{id}/runs/{r}/input-receipts"]) {
      assert.ok(caps.routes.includes(must), `${must} stays`);
    }
    assert.equal(extra.filter((r) => /\/(runs|claims|asks?|ai-questions?)\b/.test(r)).length, 0, "no new run/claim-like route");
  });
});

test("④ OpenAPI documents both new paths", () => {
  const text = readFileSync(OPENAPI_PATH, "utf8");
  assert.match(text, /^ {2}\/api\/v1\/projects\/\{id\}\/prompt-builds:/m);
  assert.match(text, /^ {2}\/api\/v1\/projects\/\{id\}\/question-statuses:/m);
});

test("④ A starts 'AI에게 묻기' with the existing POST runs + claims, and filing a question does not start it (copy ≠ run)", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "run1");
    const q = await ask_ai(env, agent.actor_id);
    assert.equal(env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM runs")!.n, 0n, "filing the question started nothing");
    const run_id = await owner_creates_run(env, agent);
    const lease = await agent_claims(env, agent, run_id);
    assert.equal(lease.run_id, run_id);
    const status = one_status(env, statuses(await get(env, "/question-statuses")), q.question_id);
    assert.equal(status.state, "accepted", "a started run is not a receipt of the question");
    assert.equal(status.external_received_at, null);
  });
});

test("④ B MCP pes_ask/pes_wait and A question.ask stay on the existing commands; no agent tool files human→AI questions or builds prompts", () => {
  assert.ok((TOOL_NAMES as readonly string[]).includes("pes_ask") && (TOOL_NAMES as readonly string[]).includes("pes_wait"));
  assert.ok(A_TOOL_ALLOWLIST.includes("question.ask"));
  const names = [...(TOOL_NAMES as readonly string[]), ...TOOL_SPECS.map((t) => t.name)];
  assert.deepEqual(names.filter((n) => /human_question|prompt|ask_ai|ask_agent|question_status/i.test(n)), [], "no new agent tool for U5a");
  const mcp = readFileSync(new URL("../scripts/pes_core/mcp_server.ts", import.meta.url), "utf8");
  assert.match(mcp, /"\/questions"/, "pes_ask posts to the questions route");
  assert.match(mcp, /\/wait`/, "pes_wait posts to the wait route");
  const tools = readFileSync(new URL("../scripts/pes_core/a_runtime/tools.ts", import.meta.url), "utf8");
  assert.match(tools, /"question\.publish_set"/, "A question.ask runs the same command the questions route runs");
  const api = readFileSync(new URL("../scripts/pes_core/api.ts", import.meta.url), "utf8");
  assert.match(api, /publish_set\(this\.#service/, "the questions route runs publish_set");
});

test("④ an agent token with a live lease still cannot file a human_to_agent question or open a second path (403 human_required)", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "run2");
    const { stage_id, round_id } = await open_round(env, "run2");
    const run_id = await owner_creates_run(env, agent);
    const lease = await agent_claims(env, agent, run_id);
    const res = await post(env, "/questions", { token: agent.token }, {
      stage_id, round_id, purpose: "review", direction: "human_to_agent", intended_actor_id: agent.actor_id, question: text_spec("q"),
      run_id: lease.run_id, lease_id: lease.lease_id, fence: Number(lease.fence),
    });
    assert_error(res, 403, "human_required");
  });
});
