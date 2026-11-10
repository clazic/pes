/**
 * SEL-46 PR13 — Codex 최종 리뷰 2/2 회귀 시험 (tester, 회귀 모드). 리뷰 전문: logs/SEL-46-final-review-2.md
 *
 *   F3(계속) GET P/objects/{o}/versions/{v} 는 그 버전의 실제 내용을 돌려준다.
 *
 * 이 시험이 고정하는 DTO — 기존 필드(project_id, object_id, kind, version_id, version_no, is_current,
 * content_hash, files)는 그대로 두고 `content` 하나를 더한다 (DTO 이름: `content`):
 *
 *   kind = "artifact": data.content = { title, summary, body_md }    // 저장된 값 그대로 (없으면 null 가능)
 *   kind = "source":   data.content = { title, url, quote, locator, source_kind, method, verification_state }
 *                      locator 는 저장된 JSON 을 파싱한 객체(예: {page: 3}).
 *
 * 읽기 규칙 (본문이 나가는 길이 넓어지므로 기존 규칙이 그대로 적용돼야 한다):
 *   - 토큰은 context:read 필요(없으면 403), 프로젝트 소속 불일치는 404, Go OFF 에서 internal_ai 는
 *     403 policy_blocked. 거부 응답 어디에도 본문 문자열이 없다.
 *   - ai_access='deny' 인 blob(file_policies / 최신 file_ai_access_versions)은 에이전트 토큰의 응답에서
 *     files 목록에 나오지 않고 blob_id 도 응답 어디에도 없으며, 같은 blob 의 파일 경로 읽기도 403.
 *     사람 owner 는 규칙대로 그대로 본다.
 * 합성 값만 쓴다.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { add_artifact, add_source, append_version, create_object, set_current } from "../scripts/pes_core/content.ts";
import {
  OPENAPI_PATH,
  assert_error,
  assert_ok,
  call,
  go_off,
  make_agent,
  project_path,
  with_api,
  type ApiEnv,
  type ApiResponse,
} from "./helpers/api_env.ts";
import { attach, bytes_of, ctx_for, new_artifact, put_ready, second_project } from "./helpers/blob_env.ts";

const P = (env: ApiEnv, rest = "") => project_path(env, rest);
const VPATH = (env: ApiEnv, o: string, v: string) => P(env, `/objects/${o}/versions/${v}`);

const ART = {
  title: "합성 본문 제목 alpha-title",
  summary: "합성 요약 alpha-summary",
  body_md: "# 합성 본문\n\nalpha-body-marker 문단.",
};
const SRC = {
  source_kind: "web",
  title: "합성 출처 제목 beta-title",
  url: "https://example.invalid/synthetic-beta",
  quote: "beta-quote-marker 합성 발췌",
  locator: { page: 3, section: "beta-section" },
  method: "fetch",
  verification_state: "unverified",
};
const MARKERS = ["alpha-title", "alpha-summary", "alpha-body-marker", "beta-title", "beta-quote-marker", "beta-section", "synthetic-beta"];

async function make_artifact(env: ApiEnv, key: string, fields: Record<string, unknown> = ART) {
  const obj = (await create_object(env.service, env.ctx(`${key}-o`), { kind: "artifact", edition_id: env.p.edition_id }))
    .result as { object_id: string };
  const v = (await add_artifact(env.service, env.ctx(`${key}-v`), { object_id: obj.object_id, artifact_kind: "chapter", ...fields }))
    .result as { object_id: string; version_id: string; version_no: number };
  return v;
}

async function make_source(env: ApiEnv, key: string, fields: Record<string, unknown> = SRC) {
  const obj = (await create_object(env.service, env.ctx(`${key}-o`), { kind: "source", edition_id: env.p.edition_id }))
    .result as { object_id: string };
  return (await add_source(env.service, env.ctx(`${key}-v`), { object_id: obj.object_id, ...fields })).result as {
    object_id: string;
    version_id: string;
    version_no: number;
  };
}

function no_markers(res: ApiResponse, markers: readonly string[] = MARKERS): void {
  const text = JSON.stringify(res.json) + (res.bytes === null ? "" : Buffer.from(res.bytes).toString("utf8"));
  for (const m of markers) assert.ok(!text.includes(m), `the response must not contain ${m}`);
}

// ---------------------------------------------------------------------------
// 내용 반환

test("F3 content: an artifact version returns title, summary and body_md as stored, next to the existing fields", async () => {
  await with_api(async (env) => {
    const v = await make_artifact(env, "c-art");
    const data = assert_ok(await call(env, { method: "GET", path: VPATH(env, v.object_id, v.version_id), auth: "owner" }));
    assert.equal(data.kind, "artifact");
    assert.equal(data.version_id, v.version_id);
    assert.match(data.content_hash, /^[0-9a-f]{64}$/);
    assert.ok(Array.isArray(data.files));
    assert.ok(data.content && typeof data.content === "object", "data.content exists");
    assert.equal(data.content.title, ART.title);
    assert.equal(data.content.summary, ART.summary);
    assert.equal(data.content.body_md, ART.body_md);
  });
});

test("F3 content: a source version returns title, url, quote, locator, source_kind, method and verification_state", async () => {
  await with_api(async (env) => {
    const v = await make_source(env, "c-src");
    const data = assert_ok(await call(env, { method: "GET", path: VPATH(env, v.object_id, v.version_id), auth: "owner" }));
    assert.equal(data.kind, "source");
    const c = data.content;
    assert.ok(c && typeof c === "object", "data.content exists");
    assert.equal(c.title, SRC.title);
    assert.equal(c.url, SRC.url);
    assert.equal(c.quote, SRC.quote);
    assert.deepEqual(c.locator, SRC.locator);
    assert.equal(c.source_kind, "web");
    assert.equal(c.method, "fetch");
    assert.equal(c.verification_state, "unverified");
  });
});

test("F3 content: reading an older version returns its own content, not the current one's", async () => {
  await with_api(async (env) => {
    const v1 = await make_artifact(env, "h-art");
    const v2 = (
      await append_version(env.service, env.ctx("h-art-2"), {
        object_id: v1.object_id,
        title: "합성 새 제목 gamma-title",
        summary: "합성 새 요약",
        body_md: "gamma-body 새 본문",
      })
    ).result as { version_id: string };
    await set_current(env.service, env.ctx("h-art-cur"), { object_id: v1.object_id, version_id: v2.version_id });

    const old = assert_ok(await call(env, { method: "GET", path: VPATH(env, v1.object_id, v1.version_id), auth: "owner" }));
    const cur = assert_ok(await call(env, { method: "GET", path: VPATH(env, v1.object_id, v2.version_id), auth: "owner" }));
    assert.equal(old.is_current, false);
    assert.equal(cur.is_current, true);
    assert.equal(old.content.title, ART.title);
    assert.equal(old.content.body_md, ART.body_md);
    assert.equal(cur.content.title, "합성 새 제목 gamma-title");
    assert.equal(cur.content.body_md, "gamma-body 새 본문");
    assert.notEqual(old.content_hash, cur.content_hash);
    assert.ok(!JSON.stringify(old).includes("gamma-"), "the old version carries nothing of the new one");
  });
});

test("F3 content: a source's older version keeps its quote and locator after a newer version is appended and adopted", async () => {
  await with_api(async (env) => {
    const v1 = await make_source(env, "h-src");
    const v2 = (
      await append_version(env.service, env.ctx("h-src-2"), {
        object_id: v1.object_id,
        title: "합성 출처 새 제목 delta-title",
        method: "fetch",
        verification_state: "unverified",
        quote: "delta-quote 새 발췌",
        locator: { page: 9 },
      })
    ).result as { version_id: string };
    await set_current(env.service, env.ctx("h-src-cur"), { object_id: v1.object_id, version_id: v2.version_id });
    const old = assert_ok(await call(env, { method: "GET", path: VPATH(env, v1.object_id, v1.version_id), auth: "owner" }));
    const cur = assert_ok(await call(env, { method: "GET", path: VPATH(env, v1.object_id, v2.version_id), auth: "owner" }));
    assert.equal(old.content.quote, SRC.quote);
    assert.deepEqual(old.content.locator, SRC.locator);
    assert.equal(cur.content.quote, "delta-quote 새 발췌");
    assert.deepEqual(cur.content.locator, { page: 9 });
  });
});

test("F3 content: an agent token with context:read gets the same content as the owner", async () => {
  await with_api(async (env) => {
    const a = await make_artifact(env, "t-art");
    const s = await make_source(env, "t-src");
    const reader = await make_agent(env, "reader", ["context:read"]);
    for (const v of [a, s]) {
      const own = assert_ok(await call(env, { method: "GET", path: VPATH(env, v.object_id, v.version_id), auth: "owner" }));
      const tok = assert_ok(await call(env, { method: "GET", path: VPATH(env, v.object_id, v.version_id), auth: { token: reader.token } }));
      assert.deepEqual(tok, own);
    }
  });
});

// ---------------------------------------------------------------------------
// (1) 토큰 범위  (2) 프로젝트 소속  (3) Go OFF  — 거부 응답에 본문 없음

test("F3 exposure (1): a token without context:read and a missing credential get 403/401 and no content", async () => {
  await with_api(async (env) => {
    const a = await make_artifact(env, "s-art");
    const s = await make_source(env, "s-src");
    const files_only = await make_agent(env, "files-only", ["file:read", "file:write"]);
    for (const v of [a, s]) {
      const path = VPATH(env, v.object_id, v.version_id);
      const denied = await call(env, { method: "GET", path, auth: { token: files_only.token } });
      assert_error(denied, 403, "forbidden");
      no_markers(denied);
      const anon = await call(env, { method: "GET", path });
      assert_error(anon, 401, "unauthenticated");
      no_markers(anon);
    }
  });
});

test("F3 exposure (2): another project's token, and another project's object/version through this path, are refused with no content", async () => {
  await with_api(async (env) => {
    const mine = await make_artifact(env, "p-mine");
    const other = await second_project(env, "synthetic-f3-exposure");
    const other_obj = (await create_object(env.service, ctx_for(other, "p-o-obj"), { kind: "artifact", edition_id: other.edition_id }))
      .result as { object_id: string };
    const other_ver = (
      await add_artifact(env.service, ctx_for(other, "p-o-ver"), {
        object_id: other_obj.object_id,
        artifact_kind: "chapter",
        title: "합성 다른 프로젝트 omega-title",
        summary: "omega-summary",
        body_md: "omega-body",
      })
    ).result as { version_id: string };
    const omega = ["omega-title", "omega-summary", "omega-body"];

    // the other project's object+version asked through this project's path -> 404, no content
    for (const [o, v] of [
      [other_obj.object_id, other_ver.version_id],
      [mine.object_id, other_ver.version_id],
      [other_obj.object_id, mine.version_id],
    ] as const) {
      const res = await call(env, { method: "GET", path: VPATH(env, o, v), auth: "owner" });
      assert_error(res, 404, "not_found");
      no_markers(res, [...omega, ...MARKERS]);
    }
    // this project's content asked through the other project's path -> 404 / refused, no content
    const other_path = `/api/v1/projects/${other.project_id}/objects/${mine.object_id}/versions/${mine.version_id}`;
    const res = await call(env, { method: "GET", path: other_path, auth: "owner" });
    assert.ok(res.status === 404 || res.status === 403, `got ${res.status}`);
    no_markers(res);
    // a token issued in this project is no key to the other project
    const agent = await make_agent(env, "mine-reader", ["context:read"]);
    const other_ver_path = `/api/v1/projects/${other.project_id}/objects/${other_obj.object_id}/versions/${other_ver.version_id}`;
    const via_token = await call(env, { method: "GET", path: other_ver_path, auth: { token: agent.token } });
    assert.ok([401, 403, 404].includes(via_token.status), `got ${via_token.status}`);
    no_markers(via_token, omega);
  });
});

test("F3 exposure (3): Go OFF blocks internal_ai with 403 policy_blocked and no content; external agent and owner still read", async () => {
  await with_api(async (env) => {
    const a = await make_artifact(env, "g-art");
    const s = await make_source(env, "g-src");
    const internal = await make_agent(env, "internal", ["context:read"], "internal_ai");
    const external = await make_agent(env, "external", ["context:read"]);
    await go_off(env);
    for (const v of [a, s]) {
      const path = VPATH(env, v.object_id, v.version_id);
      const denied = await call(env, { method: "GET", path, auth: { token: internal.token } });
      assert.equal(assert_error(denied, 403, "policy_blocked").retryable, false);
      no_markers(denied);
      const ext = assert_ok(await call(env, { method: "GET", path, auth: { token: external.token } }));
      assert.ok(ext.content, "external agent still gets content");
      assert.ok(assert_ok(await call(env, { method: "GET", path, auth: "owner" })).content);
    }
  });
});

// ---------------------------------------------------------------------------
// (4) ai_access = 'deny'

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

test("F3 exposure (4): a denied file is neither listed nor referenced in an agent's version read, but the owner sees it; content text is unaffected", async () => {
  await with_api(async (env) => {
    const v = await new_artifact(env, "d-art");
    const allowed = await put_ready(env, bytes_of("d-allowed", 24), "d-allowed");
    const denied = await put_ready(env, bytes_of("d-denied", 24), "d-denied");
    await attach(env, v.version_id, allowed.blob_id, "attachment", "d-att-1");
    await attach(env, v.version_id, denied.blob_id, "source", "d-att-2");
    deny(env, denied.blob_id);

    const agent = await make_agent(env, "reader", ["context:read", "file:read"]);
    const path = VPATH(env, v.object_id, v.version_id);
    const res = await call(env, { method: "GET", path, auth: { token: agent.token } });
    const data = assert_ok(res);
    const ids = data.files.map((f: { blob_id: string }) => f.blob_id);
    assert.deepEqual(ids, [allowed.blob_id], "only the allowed file is listed to the agent");
    assert.ok(!JSON.stringify(res.json).includes(denied.blob_id), "the denied blob id appears nowhere in the agent's response");
    assert.equal(data.content.title, `합성 장 d-art`, "the version's own text is still returned");

    const owner = assert_ok(await call(env, { method: "GET", path, auth: "owner" }));
    assert.deepEqual(
      owner.files.map((f: { blob_id: string }) => f.blob_id).sort(),
      [allowed.blob_id, denied.blob_id].sort(),
      "the human owner sees both",
    );
  });
});

test("F3 exposure (4): the file-content route refuses the denied blob to an agent token (and serves the allowed one); the owner reads both", async () => {
  await with_api(async (env) => {
    const v = await new_artifact(env, "d2-art");
    const allowed = await put_ready(env, bytes_of("d2-allowed", 24), "d2-allowed");
    const denied = await put_ready(env, bytes_of("d2-denied", 24), "d2-denied");
    await attach(env, v.version_id, allowed.blob_id, "attachment", "d2-att-1");
    await attach(env, v.version_id, denied.blob_id, "attachment", "d2-att-2");
    deny(env, denied.blob_id);
    const agent = await make_agent(env, "reader", ["context:read", "file:read"]);
    const file = (blob_id: string, auth: "owner" | { token: string }) =>
      call(env, { method: "GET", path: P(env, `/files/${blob_id}/content`), auth });

    const refused = await file(denied.blob_id, { token: agent.token });
    assert.equal(refused.status, 403, `got ${refused.status}`);
    assert.ok(refused.bytes === null || refused.bytes.byteLength === 0 || refused.json !== undefined);
    assert.equal(
      (await file(allowed.blob_id, { token: agent.token })).status,
      200,
    );
    assert.equal((await file(denied.blob_id, "owner")).status, 200, "the human owner reads it by the rule");
  });
});

test("F3 exposure (4): an internal_ai actor is treated like any agent for a denied file", async () => {
  await with_api(async (env) => {
    const v = await new_artifact(env, "d3-art");
    const denied = await put_ready(env, bytes_of("d3-denied", 24), "d3-denied");
    await attach(env, v.version_id, denied.blob_id, "attachment", "d3-att");
    deny(env, denied.blob_id);
    const internal = await make_agent(env, "internal", ["context:read", "file:read"], "internal_ai");
    const res = await call(env, { method: "GET", path: VPATH(env, v.object_id, v.version_id), auth: { token: internal.token } });
    const data = assert_ok(res);
    assert.deepEqual(data.files, []);
    assert.ok(!JSON.stringify(res.json).includes(denied.blob_id));
  });
});

// ---------------------------------------------------------------------------
// OpenAPI

test("F3 OpenAPI: the version route's 200 response is described by a schema that names content, body_md and quote", () => {
  const lines = readFileSync(OPENAPI_PATH, "utf8").split(/\r?\n/);
  const start = lines.findIndex((l) => /^ {2}['"]?\/api\/v1\/projects\/\{[^}]+\}\/objects\/\{[^}]+\}\/versions\/\{[^}]+\}['"]?:\s*$/.test(l));
  assert.notEqual(start, -1, "OpenAPI has no objects/versions path");
  const block: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {2}\S/.test(lines[i]!) || /^\S/.test(lines[i]!)) break;
    block.push(lines[i]!);
  }
  const text = block.join("\n");
  const ok200 = text.slice(text.search(/['"]?200['"]?:/));
  const ref = /\$ref:\s*["']#\/components\/schemas\/(\w+)["']/.exec(ok200.split(/['"]?40\d['"]?:/)[0]!);
  assert.ok(ref && ref[1] !== "Success", `200 must reference a dedicated schema, not the generic Success (got ${ref?.[1]})`);
  const name = ref![1]!;
  const s = lines.findIndex((l) => new RegExp(`^ {4}${name}:\\s*$`).test(l));
  assert.notEqual(s, -1, `schema ${name} is defined`);
  const body: string[] = [];
  for (let i = s + 1; i < lines.length; i += 1) {
    if (/^ {0,4}\S/.test(lines[i]!)) break;
    body.push(lines[i]!);
  }
  // the content schema may be inline or a second schema; accept either by searching the whole components text
  const whole = readFileSync(OPENAPI_PATH, "utf8");
  const scope = body.join("\n");
  for (const word of ["content", "files"]) assert.match(scope, new RegExp(`\\b${word}\\b`), `${name} names ${word}`);
  for (const word of ["body_md", "quote", "locator", "verification_state"]) {
    assert.match(whole, new RegExp(`\\b${word}\\b`), `OpenAPI mentions ${word}`);
  }
  assert.match(scope + "\n" + whole.slice(whole.indexOf(`    ${name}:`)), /body_md/);
});
