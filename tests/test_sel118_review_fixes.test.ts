/**
 * SEL-118 U5a — 1차 리뷰(logs/SEL-118-r1.md) 필수 3건 + 권장 일부의 회귀 시험. 합성 자료만(가짜 비밀·가짜 이름 hong/lee).
 *
 *  필수 1 — 프롬프트의 비밀 지우기: `access_token=`·`refresh_token=`·`client_secret=`·`id_token=`, `Authorization: Basic …`, URL 안 자격
 *           (`https://user:pass@host`), `?key=`·`?sig=`, `Cookie:`, PEM 개인 키 블록, 그리고 모양을 모르는 긴 비밀 덩어리까지 지운다.
 *           정상 글(짧은 값·긴 파일 이름·UUID·앱 링크)은 지우지 않는다(오탐 시험).
 *  필수 2 — `context:read` 토큰 호출자에게 AI 참조 금지 파일 id 가 나가지 않는다(버전 읽기가 그 파일을 목록에서 빼는 것과 같은 규칙).
 *           소유자 세션은 그대로 `excluded[ai_access_denied]` 를 본다.
 *  필수 3 — `applied` 단독 영수증은 "받은 뒤의 일"이라 받음의 근거로 인정한다(leader 결정): state=read, external_received_at=applied 시각.
 *           `seen` 이 있으면 seen 시각. 문서(stage-1-api·OpenAPI)가 같은 규칙을 적는다.
 *  권장 — 찌꺼기 없는 지우기(`[지움: 비밀] 비밀]` 금지), 다른 PC 경로 변형, "관련" 문구, human_to_agent 의 form_key main 거절, 공백 초안 건너뜀.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { add_artifact, create_object } from "../scripts/pes_core/content.ts";
import { redact_text } from "../scripts/pes_core/prompt_reads.ts";
import { assert_error, assert_ok, call, go_off, make_agent, owner_creates_run, agent_claims, OPENAPI_PATH, with_api, type ApiEnv, type Auth } from "./helpers/api_env.ts";
import { P } from "./helpers/api_flow.ts";
import { attach, bytes_of, put_ready } from "./helpers/blob_env.ts";
import { open_round, text_spec } from "./helpers/questions_env.ts";
import { tx_of_version } from "./helpers/sel93_env.ts";

const U = ["", "Users", ""].join("/"); // the home root, assembled so the file holds no literal path
const MARK = "[지움: 비밀]";
const NONE = { secrets: [], paths: [] };

const post = (env: ApiEnv, rest: string, auth: Auth, body: unknown) => call(env, { method: "POST", path: P(env, rest), auth, body });
const get = (env: ApiEnv, rest: string, auth: Auth = "owner") => call(env, { method: "GET", path: P(env, rest), auth });

async function artifact_with(env: ApiEnv, key: string, title: string, summary: string): Promise<{ object_id: string; version_id: string }> {
  const obj = (await create_object(env.service, env.ctx(`${key}-o`), { kind: "artifact", edition_id: env.p.edition_id })).result as { object_id: string };
  const out = await add_artifact(env.service, env.ctx(`${key}-v`), { object_id: obj.object_id, artifact_kind: "chapter", title, summary });
  return out.result as { object_id: string; version_id: string };
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

// ===========================================================================
// 필수 1 — 비밀 지우기

const SECRET_CASES: Array<[string, string, string]> = [
  // [이름, 글, 남으면 안 되는 비밀 조각]
  ["access_token in a URL", "https://api.x.com/v1?access_token=abcdef123456", "abcdef123456"],
  ["refresh_token", "refresh_token=rt_9f8e7d6c5b4a", "9f8e7d6c5b4a"],
  ["client_secret", "client_secret: csec-1a2b3c4d5e6f", "1a2b3c4d5e6f"],
  ["id_token", "id_token=idt0987654321zz", "idt0987654321zz"],
  ["password in JSON-ish", 'password="hunter2hunter2"', "hunter2hunter2"],
  ["Authorization Basic", "Authorization: Basic dXNlcjpwYXNzd29yZDEyMw==", "dXNlcjpwYXNzd29yZDEyMw"],
  ["Authorization Token scheme", "authorization: Token abcd1234efgh5678", "abcd1234efgh5678"],
  ["Bearer alone", "Bearer abcdef0123456789", "abcdef0123456789"],
  ["URL credentials", "git clone https://lee:pa55w0rd@host.example/repo.git", "pa55w0rd"],
  ["URL token as user", "https://ghx0123456789abcdefABCDEF@host.example/r", "ghx0123456789abcdefABCDEF"],
  ["?key=", "https://maps.example/api?key=AIzaSyA1234567890abcdefghijklmno&q=a", "AIzaSyA1234567890abcdefghijklmno"],
  ["?sig=", "https://cdn.example/f?x=1&sig=3f9a7c21b8d04e56", "3f9a7c21b8d04e56"],
  ["Cookie", "Cookie: sid=abcdef0123456789abcdef; theme=dark", "abcdef0123456789abcdef"],
  [
    "PEM private key block",
    "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nZm9vYmFyYmF6\n-----END PRIVATE KEY-----",
    "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC",
  ],
  ["unknown long alnum secret", "내 키는 Zx9Kq2Lm7Pw4Rt8Vb3Nc6Hd1Fs5Jg0Yu 입니다", "Zx9Kq2Lm7Pw4Rt8Vb3Nc6Hd1Fs5Jg0Yu"],
  ["unknown long base64url secret", "값 aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0hJ3lO6rU9x_-AbCdEfGh 끝", "aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0hJ3lO6rU9x_-AbCdEfGh"],
];

for (const [name, text, secret] of SECRET_CASES) {
  test(`필수1 secret erased: ${name}`, () => {
    const out = redact_text(`앞 ${text} 뒤`, NONE);
    assert.ok(!out.text.includes(secret), `still there: ${out.text}`);
    assert.ok(out.hits > 0, "the erasure is counted");
    assert.ok(out.text.includes("앞 ") && out.text.includes(" 뒤") || out.text.startsWith("앞"), "the text around stays");
  });
}

test("필수1 no leftover of the mark: the session header does not leave '비밀]' behind (권장 5)", () => {
  const out = redact_text("x-pes-session: synthetic-local-session-secret 와 끝", { secrets: ["synthetic-local-session-secret"], paths: [] });
  assert.ok(!out.text.includes("synthetic-local-session-secret"));
  assert.doesNotMatch(out.text, /\]\s*비밀\]/);
  assert.equal(out.text.split(MARK).length - 1, 1, `exactly one mark: ${out.text}`);
});

test("필수1 normal text is not erased (false-positive guard)", () => {
  const same = [
    "max_tokens: 4096 로 설정했다",
    "the token budget is 50",
    "토큰 예산은 충분하다",
    "password policy 를 검토한다",
    "secret garden 이라는 책",
    "key results 는 분기마다 본다",
    "2024_survey_results_final_v2_revised.csv 를 열었다",
    "https://example.com/very/long/path/segments/that/go/on/and/on/forever/index.html",
    "attachment 3f2504e0-4f89-11d3-9a0c-0305e82c3301 는 붙은 파일이다",
    "/p/proj-1/home 에서 본다",
    "https://a.b/home/x 참고",
    "supercalifragilisticexpialidocious 같은 긴 단어",
    "표 3 에서 2020~2024 비교 (n=1234567)",
  ];
  for (const text of same) {
    const out = redact_text(text, NONE);
    assert.equal(out.text, text, `changed: ${text}`);
    assert.equal(out.hits, 0);
  }
});

test("필수1 through the API: every shape is gone from the whole response, and a redacted warning is announced", async () => {
  await with_api(async (env) => {
    const v = await artifact_with(env, "rf1", "합성 장", "요약 https://api.x.com/v1?access_token=abcdef123456");
    const data = assert_ok(
      await post(env, "/prompt-builds", "owner", {
        question: "Authorization: Basic dXNlcjpwYXNzd29yZDEyMw== 그리고 https://lee:pa55w0rd@host.example/r",
        selection: { version_id: v.version_id, quote: "refresh_token=rt_9f8e7d6c5b4a" },
        drafts: [{ text: "Cookie: sid=abcdef0123456789abcdef" }],
      }),
    );
    const text = JSON.stringify(data);
    for (const s of ["abcdef123456", "dXNlcjpwYXNzd29yZDEyMw", "pa55w0rd", "9f8e7d6c5b4a", "abcdef0123456789abcdef"]) {
      assert.ok(!text.includes(s), `response still has ${s}`);
    }
    assert.ok(data.warnings.some((w: any) => w.code === "redacted"));
  });
});

// 권장 4 — 다른 사용자·다른 PC 경로 변형
test("권장4 other people's path shapes are erased (file URL, Git Bash, backslash, tilde-backslash, percent-encoded)", () => {
  const cases: Array<[string, string]> = [
    [`file://${U}lee/a/b.md`, "lee"],
    [`/c${U}lee/Documents/x.md`, "lee"],
    [`/cygdrive/c${U}lee/x`, "lee"],
    ["\\Users\\lee\\a", "lee"],
    ["~\\Documents\\x", "Documents"],
    ["%2FUsers%2Flee%2Fa", "lee"],
  ];
  for (const [text, piece] of cases) {
    const out = redact_text(`앞 ${text} 뒤`, NONE);
    assert.ok(!out.text.includes(piece), `kept ${piece}: ${out.text}`);
    assert.ok(out.hits > 0);
  }
});

// ===========================================================================
// 필수 2 — 토큰 호출자에게 AI 참조 금지 파일 id 가 나가지 않는다

test("필수2 a context:read token never sees a denied file's id anywhere in the build; the owner session still sees it excluded", async () => {
  await with_api(async (env) => {
    const v = await artifact_with(env, "rf2", "합성 장", "합성 요약");
    const ok = await put_ready(env, bytes_of("rf2-ok", 24), "rf2-ok");
    const no = await put_ready(env, bytes_of("rf2-no", 24), "rf2-no");
    await attach(env, v.version_id, ok.blob_id, "attachment", "rf2-a1");
    await attach(env, v.version_id, no.blob_id, "source", "rf2-a2");
    deny(env, no.blob_id);
    const reader = await make_agent(env, "rf2r", ["context:read"]);
    const body = { question: "q", selection: { version_id: v.version_id } };

    const token_build = assert_ok(await post(env, "/prompt-builds", { token: reader.token }, body));
    assert.ok(!JSON.stringify(token_build).includes(no.blob_id), "no denied blob id in the token's build");
    assert.ok(token_build.included.some((i: any) => i.id === ok.blob_id), "an allowed file is still listed");
    assert.ok(!token_build.excluded.some((e: any) => e.reason === "ai_access_denied"), "not even the fact that something was denied");

    // the same token's version read already hides the file: both reads agree
    const version = assert_ok(await get(env, `/objects/${v.object_id}/versions/${v.version_id}`, { token: reader.token }));
    assert.ok(!JSON.stringify(version).includes(no.blob_id));

    const owner_build = assert_ok(await post(env, "/prompt-builds", "owner", body));
    assert.equal(owner_build.excluded.find((e: any) => e.kind === "file" && e.id === no.blob_id)?.reason, "ai_access_denied", "the human still sees what was held back");
  });
});

test("필수2 target A with send OFF: a token caller's 'send_off' list does not name a denied file either", async () => {
  await with_api(async (env) => {
    const v = await artifact_with(env, "rf2b", "합성 장", "합성 요약");
    const ok = await put_ready(env, bytes_of("rf2b-ok", 24), "rf2b-ok");
    const no = await put_ready(env, bytes_of("rf2b-no", 24), "rf2b-no");
    await attach(env, v.version_id, ok.blob_id, "attachment", "rf2b-a1");
    await attach(env, v.version_id, no.blob_id, "source", "rf2b-a2");
    deny(env, no.blob_id);
    await go_off(env);
    const reader = await make_agent(env, "rf2br", ["context:read"]);
    const data = assert_ok(await post(env, "/prompt-builds", { token: reader.token }, { question: "q", selection: { version_id: v.version_id }, target: "A" }));
    assert.ok(!JSON.stringify(data).includes(no.blob_id));
    assert.ok(JSON.stringify(data).includes(ok.blob_id) === true, "the allowed file is named as held back by send OFF");
  });
});

// ===========================================================================
// 필수 3 — applied 단독 = 받음의 근거

async function ask_ai(env: ApiEnv, intended_actor_id: string): Promise<{ question_id: string; version_id: string }> {
  const open = env.db.get<{ stage_id: string; round_id: string }>(
    "SELECT stage_id, id AS round_id FROM rounds WHERE project_id = ? AND state = 'open' ORDER BY round_no LIMIT 1",
    env.p.project_id,
  );
  const { stage_id, round_id } = open ?? (await open_round(env, `rf-${env.seq++}`));
  const data = assert_ok(
    await post(env, "/questions", "owner", {
      stage_id,
      round_id,
      purpose: "review",
      direction: "human_to_agent",
      intended_actor_id,
      question: text_spec("합성 질문"),
    }),
    201,
  );
  const question_id = data.question.id as string;
  const version_id = env.db.get<{ id: string }>("SELECT original_version_id AS id FROM questions WHERE object_id = ?", question_id)!.id;
  return { question_id, version_id };
}

async function receipt(env: ApiEnv, agent: { actor_id: string; token: string }, lease: { run_id: string; lease_id: string; fence: unknown }, input_version_id: string, state: "seen" | "applied") {
  return call(env, {
    method: "POST",
    path: P(env, `/runs/${lease.run_id}/input-receipts`),
    auth: { token: agent.token },
    body: {
      lease_id: lease.lease_id,
      fence: lease.fence,
      receipts: [{ input_version_id, state, ...(state === "applied" ? { applied_tx_id: tx_of_version(env.db, input_version_id) } : {}) }],
    },
  });
}

test("필수3 an applied receipt alone: state=read and external_received_at = the applied time (applied is something that happens after receiving)", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "rf3a");
    const q = await ask_ai(env, agent.actor_id);
    const lease = await agent_claims(env, agent as any, await owner_creates_run(env, agent as any));
    env.clock.advance(4_000);
    const t = env.clock.now_ms();
    assert_ok(await receipt(env, agent, lease, q.version_id, "applied"));
    const row = assert_ok(await get(env, "/question-statuses")).items.find((i: any) => i.question_id === q.question_id);
    assert.equal(row.state, "read");
    assert.equal(row.read_at, t);
    assert.equal(row.external_received_at, t, "applied stands as evidence of receiving: the latest it was received");
    assert.equal(row.answered_at, null);
  });
});

test("필수3 seen then applied: external_received_at is the seen time, read_at the applied time", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "rf3b");
    const q = await ask_ai(env, agent.actor_id);
    const lease = await agent_claims(env, agent as any, await owner_creates_run(env, agent as any));
    env.clock.advance(1_000);
    const t_seen = env.clock.now_ms();
    assert_ok(await receipt(env, agent, lease, q.version_id, "seen"));
    env.clock.advance(2_000);
    const t_applied = env.clock.now_ms();
    assert_ok(await receipt(env, agent, lease, q.version_id, "applied"));
    const row = assert_ok(await get(env, "/question-statuses")).items.find((i: any) => i.question_id === q.question_id);
    assert.equal(row.external_received_at, t_seen);
    assert.equal(row.read_at, t_applied);
    assert.equal(row.state, "read");
  });
});

test("필수3 the docs state the same rule (stage-1-api and OpenAPI)", () => {
  const openapi = readFileSync(OPENAPI_PATH, "utf8");
  const stage = readFileSync(new URL("../docs/plan/stage-1-api.md", import.meta.url), "utf8");
  assert.match(openapi, /an applied receipt alone also counts as received/);
  assert.match(stage, /applied 단독도 받음의 근거/);
});

// ===========================================================================
// 권장

test("권장6 the section names say what they are: all assumptions/decisions of the edition, not 'related' ones", async () => {
  await with_api(async (env) => {
    const v = await artifact_with(env, "rf6", "합성 장", "합성 요약");
    assert_ok(await post(env, "/assumptions", "owner", { statement: "합성 가정", state: "proposed", rationale: "r", scope: "edition" }), 201);
    assert_ok(await post(env, "/decisions", "owner", { scope: "edition", statement: "합성 결정", state: "proposed", supersedes: null, rationale: "r" }), 201);
    const data = assert_ok(await post(env, "/prompt-builds", "owner", { question: "q", selection: { version_id: v.version_id } }));
    assert.ok(!data.prompt_text.includes("## 관련 가정") && !data.prompt_text.includes("## 관련 결정"));
    assert.ok(data.prompt_text.includes("## 이 판의 가정") && data.prompt_text.includes("## 이 판의 결정"));
  });
});

test("권장7 a human_to_agent question may not use the human form key 'main'", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "rf7");
    const { stage_id, round_id } = await open_round(env, "rf7");
    const res = await post(env, "/questions", "owner", {
      stage_id,
      round_id,
      purpose: "review",
      direction: "human_to_agent",
      intended_actor_id: agent.actor_id,
      form_key: "main",
      question: text_spec("합성 질문"),
    });
    assert_error(res, 400, "invalid_payload");
  });
});

test("권장10 a blank draft is skipped: no '미제출 초안' line, no unsubmitted_draft warning", async () => {
  await with_api(async (env) => {
    const v = await artifact_with(env, "rf10", "합성 장", "합성 요약");
    const blank = assert_ok(await post(env, "/prompt-builds", "owner", { question: "q", selection: { version_id: v.version_id }, drafts: [{ text: "   \n " }] }));
    assert.ok(!blank.prompt_text.includes("미제출 초안"));
    assert.ok(!blank.warnings.some((w: any) => w.code === "unsubmitted_draft"));
    assert.ok(!blank.included.some((i: any) => i.kind === "draft"));
    const real = assert_ok(await post(env, "/prompt-builds", "owner", { question: "q", selection: { version_id: v.version_id }, drafts: [{ text: "   " }, { text: "진짜 초안" }] }));
    assert.equal(real.included.filter((i: any) => i.kind === "draft").length, 1);
    assert.ok(real.prompt_text.includes("진짜 초안"));
  });
});
