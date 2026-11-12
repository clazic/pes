/**
 * SEL-115 (3단계 MAT1a) — AI 참조 스위치 `file.ai_access_set`(POST P/file-policies/{fp}/ai-access)
 * (tester, 작성 모드). 인터페이스 표는 tests/helpers/sel115_env.ts 머리말.
 *
 * 규칙: 기본 allow · 변경은 소유자(사람)만 · file_ai_access_versions 는 추가만(덮어쓰기 없음, rev 증가) ·
 *       여러 겹(정책 행·최신 이력·프로젝트 Go)이면 엄격한 쪽(deny / 전송 OFF) 우선 · 같은 blob 은 정책 하나라서 role·버전이 달라도 같이 막힌다.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { assert_error, assert_ok, call, go_off, make_agent, with_api, type ApiEnv } from "./helpers/api_env.ts";
import { state_signature } from "./helpers/state_signature.ts";
import { P, history_rows, http_blob, new_material, policy_rows, set_access, text_bytes, upload_material } from "./helpers/sel115_env.ts";

const owner_user = (env: ApiEnv): string =>
  env.db.get<{ owner_user_id: string }>("SELECT owner_user_id FROM projects WHERE id = ?", env.p.project_id)!.owner_user_id;

// ---------------------------------------------------------------------------
// 기본값·변경·이력

test("default: a new material is allow at policy rev 1 and an agent can list and read it; the history starts empty or at rev 1", async () => {
  await with_api(async (env) => {
    const m = await new_material(env, "def");
    const p = policy_rows(env.db, env.p.project_id)[0]!;
    assert.equal(p.ai_access, "allow");
    assert.equal(p.rev, 1n);
    const reader = await make_agent(env, "reader", ["context:read", "file:read"]);
    const list = assert_ok(await call(env, { method: "GET", path: P(env, "/materials"), auth: { token: reader.token } }));
    assert.deepEqual(list.materials.map((x: any) => x.file_policy_id), [m.data.file_policy_id]);
    const got = await call(env, { method: "GET", path: P(env, `/files/${m.blob.blob_id}/content`), auth: { token: reader.token } });
    assert.equal(got.status, 200);
  });
});

test("set deny: the owner records it — policy row and a NEW history row agree, receipt + event written, who/when recorded", async () => {
  await with_api(async (env) => {
    const m = await new_material(env, "deny1");
    const fp = m.data.file_policy_id as string;
    const before = history_rows(env.db, fp).length;
    const res = await set_access(env, fp, "deny", "owner", { reason: "합성 사유: 비공개" });
    const d = assert_ok(res);
    assert.equal(d.file_policy_id, fp);
    assert.equal(d.blob_id, m.blob.blob_id);
    assert.equal(d.ai_access, "deny");
    assert.equal(d.changed, true);
    assert.equal(typeof d.rev, "number");

    const p = policy_rows(env.db, env.p.project_id)[0]!;
    assert.equal(p.ai_access, "deny");
    assert.equal(Number(p.rev), d.rev);
    assert.ok(d.rev >= 2);
    const rows = history_rows(env.db, fp);
    assert.equal(rows.length, before + 1, "exactly one row appended");
    const last = rows[rows.length - 1]!;
    assert.equal(last.ai_access, "deny");
    assert.equal(Number(last.rev), d.rev);
    assert.equal(last.reason, "합성 사유: 비공개");
    assert.equal(last.changed_by_user_id, owner_user(env));
    assert.equal(last.changed_by_actor_id, env.p.actor_id);
    assert.equal(p.changed_by_user_id, owner_user(env));
    assert.equal(
      Number(env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM mutation_commits WHERE action = 'file.ai_access_changed'")?.n ?? 0n),
      1,
    );
    assert.equal(
      Number(env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM events WHERE type = 'file.ai_access_changed'")?.n ?? 0n),
      1,
    );
  });
});

test("history is append-only: allow→deny→allow→deny keeps every earlier row byte-for-byte, revs strictly increase, policy rev = newest history rev", async () => {
  await with_api(async (env) => {
    const m = await new_material(env, "hist");
    const fp = m.data.file_policy_id as string;
    const seen: string[] = [];
    let previous = history_rows(env.db, fp);
    for (const value of ["deny", "allow", "deny", "allow"] as const) {
      assert_ok(await set_access(env, fp, value));
      const rows = history_rows(env.db, fp);
      assert.equal(rows.length, previous.length + 1);
      assert.deepEqual(rows.slice(0, previous.length), previous, "earlier rows are untouched");
      const revs = rows.map((r) => Number(r.rev));
      assert.deepEqual([...revs].sort((a, b) => a - b), revs);
      assert.equal(new Set(revs).size, revs.length, "revs are unique");
      assert.equal(rows[rows.length - 1]!.ai_access, value);
      assert.equal(Number(policy_rows(env.db, env.p.project_id)[0]!.rev), revs[revs.length - 1]);
      previous = rows;
      seen.push(value);
    }
    assert.deepEqual(seen, ["deny", "allow", "deny", "allow"]);
    assert.equal(policy_rows(env.db, env.p.project_id)[0]!.ai_access, "allow", "the owner can re-allow");
  });
});

test("setting the value it already has changes nothing: changed:false, no new history row, rev unchanged", async () => {
  await with_api(async (env) => {
    const m = await new_material(env, "same");
    const fp = m.data.file_policy_id as string;
    const before_rows = history_rows(env.db, fp);
    const before_rev = policy_rows(env.db, env.p.project_id)[0]!.rev;
    const d = assert_ok(await set_access(env, fp, "allow"));
    assert.equal(d.changed, false);
    assert.equal(d.ai_access, "allow");
    assert.deepEqual(history_rows(env.db, fp), before_rows);
    assert.equal(policy_rows(env.db, env.p.project_id)[0]!.rev, before_rev);
  });
});

test("replay: the same key + body replays the first answer and writes nothing; the same key with another value is 409", async () => {
  await with_api(async (env) => {
    const m = await new_material(env, "rep");
    const fp = m.data.file_policy_id as string;
    const first = await set_access(env, fp, "deny", "owner", {}, "acc-key-1");
    const a = assert_ok(first);
    assert.equal(first.json.replayed, false);
    const sig = state_signature(env.db);
    const again = await set_access(env, fp, "deny", "owner", {}, "acc-key-1");
    assert.deepEqual(assert_ok(again), a);
    assert.equal(again.json.replayed, true);
    assert.equal(state_signature(env.db), sig);
    assert_error(await set_access(env, fp, "allow", "owner", {}, "acc-key-1"), 409, "idempotency_key_reuse");
    assert.equal(state_signature(env.db), sig);
    assert.equal(policy_rows(env.db, env.p.project_id)[0]!.ai_access, "deny", "the conflicting reuse did not flip it");
  });
});

// ---------------------------------------------------------------------------
// 검증·권한

test("validation: bad value, missing value, unknown field, bad reason are 400; unknown policy 404; none writes", async () => {
  await with_api(async (env) => {
    const m = await new_material(env, "val");
    const fp = m.data.file_policy_id as string;
    const sig = state_signature(env.db);
    for (const bad of ["Deny", "block", "", 1, null, true, ["deny"]]) {
      assert_error(await set_access(env, fp, bad), 400, "invalid_payload");
    }
    assert_error(await call(env, { method: "POST", path: P(env, `/file-policies/${fp}/ai-access`), auth: "owner", body: {} }), 400, "invalid_payload");
    assert_error(await set_access(env, fp, "deny", "owner", { surprise: 1 }), 400, "invalid_payload");
    assert_error(await set_access(env, fp, "deny", "owner", { reason: 7 }), 400, "invalid_payload");
    assert_error(await set_access(env, "no-such-policy", "deny"), 404, "not_found");
    assert.equal(state_signature(env.db), sig);
  });
});

test("permissions: only the owner session changes it — any agent token (even with every scope) is 403, no credential 401; nothing is written", async () => {
  await with_api(async (env) => {
    const m = await new_material(env, "perm");
    const fp = m.data.file_policy_id as string;
    const all = await make_agent(env, "all");
    const narrow = await make_agent(env, "narrow", ["context:read"]);
    const internal = await make_agent(env, "internal", ["context:read", "file:read", "file:write"], "internal_ai");
    const sig = state_signature(env.db);
    assert_error(await set_access(env, fp, "deny", "none"), 401, "unauthenticated");
    for (const agent of [all, narrow, internal]) {
      assert_error(await set_access(env, fp, "deny", { token: agent.token }), 403, "forbidden");
      assert_error(await set_access(env, fp, "allow", { token: agent.token }), 403, "forbidden");
    }
    assert.equal(state_signature(env.db), sig);
    assert.equal(policy_rows(env.db, env.p.project_id)[0]!.ai_access, "allow");
  });
});

test("command layer: an agent actor's file.ai_access_set is refused and writes nothing; the owner actor succeeds", async () => {
  await with_api(async (env) => {
    const m = await new_material(env, "cmd");
    const fp = m.data.file_policy_id as string;
    const agent = await make_agent(env, "cmd-agent");
    const sig = state_signature(env.db);
    let refused: unknown = null;
    try {
      await env.service.execute(
        { project_id: env.p.project_id, actor_id: agent.actor_id, via: "cli", client_request_id: "agent-set" },
        "file.ai_access_set",
        { file_policy_id: fp, ai_access: "deny" },
      );
    } catch (error) {
      refused = error;
    }
    assert.ok(refused !== null, "the agent actor was refused");
    assert.ok(["forbidden", "policy_blocked"].includes((refused as { code?: string }).code ?? ""), String((refused as Error)?.message));
    assert.equal(state_signature(env.db), sig);
    const out = await env.service.execute(env.ctx("owner-set"), "file.ai_access_set", { file_policy_id: fp, ai_access: "deny" });
    assert.equal((out.result as { ai_access: string }).ai_access, "deny");
  });
});

test("another project's policy id is 404 and unchanged", async () => {
  await with_api(async (env) => {
    const m = await new_material(env, "cross");
    const { second_project } = await import("./helpers/blob_env.ts");
    const other = await second_project(env, "synthetic-sel115-x");
    const res = await call(env, {
      method: "POST",
      path: `/api/v1/projects/${other.project_id}/file-policies/${m.data.file_policy_id}/ai-access`,
      auth: "owner",
      body: { ai_access: "deny" },
    });
    assert.ok(res.status === 404 || res.status === 401 || res.status === 403, `got ${res.status}`);
    assert.equal(policy_rows(env.db, env.p.project_id)[0]!.ai_access, "allow");
  });
});

// ---------------------------------------------------------------------------
// 엄격한 쪽 우선 (여러 겹)

test("one policy per blob: the same bytes as two materials / roles — a single deny hides BOTH from an agent, a single allow shows both again", async () => {
  await with_api(async (env) => {
    const m1 = await new_material(env, "shared", { marker: "MARK-shared" });
    const blob2 = await http_blob(env, m1.bytes);
    const d2 = assert_ok(await upload_material(env, { blob_id: blob2.blob_id, role: "rendered" }), 201);
    assert.equal(d2.file_policy_id, m1.data.file_policy_id);
    const reader = await make_agent(env, "reader", ["context:read", "file:read"]);
    const versions = (): Promise<any[]> =>
      Promise.all(
        [m1.data, d2].map(async (d) =>
          assert_ok(await call(env, { method: "GET", path: P(env, `/objects/${d.object_id}/versions/${d.version_id}`), auth: { token: reader.token } })),
        ),
      );
    assert.deepEqual((await versions()).map((v) => v.files.length), [1, 1]);
    assert_ok(await set_access(env, m1.data.file_policy_id, "deny"));
    assert.deepEqual((await versions()).map((v) => v.files.length), [0, 0], "no role or version can be more permissive than the blob's deny");
    assert_ok(await set_access(env, m1.data.file_policy_id, "allow"));
    assert.deepEqual((await versions()).map((v) => v.files.length), [1, 1]);
  });
});

test("strict wins when the layers disagree: policy row allow + newest history deny, or the other way round → still hidden from agents", async () => {
  await with_api(async (env) => {
    const m = await new_material(env, "layers");
    const fp = m.data.file_policy_id as string;
    assert_ok(await set_access(env, fp, "deny"));
    const reader = await make_agent(env, "reader", ["context:read", "file:read"]);
    const read = () => call(env, { method: "GET", path: P(env, `/files/${m.blob.blob_id}/content`), auth: { token: reader.token } });
    assert.equal((await read()).status, 403);
    // 정책 행만 allow 로 되돌린 불일치 상태(누군가 이력 없이 고침) — 최신 이력이 deny 이므로 막힌다.
    env.db.run("UPDATE file_policies SET ai_access = 'allow' WHERE id = ?", fp);
    assert.equal((await read()).status, 403, "newest history says deny");
    // 반대로 정책 행만 deny.
    assert_ok(await set_access(env, fp, "allow")); // 정상 경로로 둘 다 allow
    env.db.run("UPDATE file_policies SET ai_access = 'deny' WHERE id = ?", fp);
    assert.equal((await read()).status, 403, "policy row says deny");
  });
});

test("Go OFF and a file deny are both strict: OFF blocks internal_ai even for an allowed file; deny blocks every agent kind even when Go is ON; the owner always reads", async () => {
  await with_api(async (env) => {
    const m = await new_material(env, "go");
    const internal = await make_agent(env, "internal", ["context:read", "file:read"], "internal_ai");
    const external = await make_agent(env, "external", ["context:read", "file:read"]);
    const read = (auth: any) => call(env, { method: "GET", path: P(env, `/files/${m.blob.blob_id}/content`), auth });

    assert.equal((await read({ token: internal.token })).status, 200);
    assert_ok(await set_access(env, m.data.file_policy_id, "deny"));
    assert_error(await read({ token: internal.token }), 403, "forbidden");
    assert.equal((await read({ token: external.token })).status, 403, "deny stops an external agent too, with Go ON");
    assert_ok(await set_access(env, m.data.file_policy_id, "allow"));
    assert.equal((await read({ token: internal.token })).status, 200, "re-allowed with Go ON");
    await go_off(env);
    assert_error(await read({ token: internal.token }), 403, "policy_blocked");
    assert.equal((await read({ token: external.token })).status, 200, "Go OFF concerns internal AI only");
    assert_ok(await set_access(env, m.data.file_policy_id, "deny"));
    assert.equal((await read({ token: external.token })).status, 403, "Go OFF + deny: still denied");
    assert.equal((await read("owner")).status, 200, "the human owner still reads a denied file");
  });
});

test("the owner keeps full access to a denied file: list shows it as deny, content and preview are served, history is readable in the DB", async () => {
  await with_api(async (env) => {
    const m = await new_material(env, "human");
    assert_ok(await set_access(env, m.data.file_policy_id, "deny", "owner", { reason: "사람 열람 유지" }));
    const list = assert_ok(await call(env, { method: "GET", path: P(env, "/materials"), auth: "owner" }));
    assert.equal(list.materials.length, 1);
    assert.equal(list.materials[0].ai_access, "deny");
    assert.equal((await call(env, { method: "GET", path: P(env, `/files/${m.blob.blob_id}/content`), auth: "owner" })).status, 200);
    assert.equal((await call(env, { method: "GET", path: P(env, `/files/${m.blob.blob_id}/preview`), auth: "owner" })).status, 200);
    assert.equal(history_rows(env.db, m.data.file_policy_id).at(-1)!.reason, "사람 열람 유지");
  });
});

// ---------------------------------------------------------------------------
// 회귀 가드(지금도 통과해야 한다): 옛 attach 흐름 + 정책 행/이력 직접 시드로 만든 deny 도 엄격한 쪽으로 막힌다

test("guard: a deny seeded on a file attached the old way (file.attach_version) still hides it from agents and 403s its content; the owner reads", async () => {
  await with_api(async (env) => {
    const { attach, bytes_of, new_artifact, put_ready } = await import("./helpers/blob_env.ts");
    const v = await new_artifact(env, "guard-art");
    const blob = await put_ready(env, bytes_of("guard-deny", 24), "guard-deny");
    const att = await attach(env, v.version_id, blob.blob_id, "attachment", "guard-att");
    env.db.run("UPDATE file_policies SET ai_access = 'deny', rev = 2 WHERE id = ?", att.file_policy_id);
    const p = policy_rows(env.db, env.p.project_id)[0]!;
    env.db.run(
      `INSERT INTO file_ai_access_versions
         (id, project_id, file_policy_id, ai_access, changed_by_actor_id, changed_by_user_id, changed_at, reason, rev, tx_id)
       VALUES ('guard-h', ?, ?, 'deny', ?, ?, 0, NULL, 2, (SELECT tx_id FROM file_policies WHERE id = ?))`,
      env.p.project_id,
      att.file_policy_id,
      p.changed_by_actor_id,
      p.changed_by_user_id,
      att.file_policy_id,
    );
    const agent = await make_agent(env, "guard-reader", ["context:read", "file:read"]);
    const ver = assert_ok(await call(env, { method: "GET", path: P(env, `/objects/${v.object_id}/versions/${v.version_id}`), auth: { token: agent.token } }));
    assert.deepEqual(ver.files, []);
    assert.equal((await call(env, { method: "GET", path: P(env, `/files/${blob.blob_id}/content`), auth: { token: agent.token } })).status, 403);
    assert.equal((await call(env, { method: "GET", path: P(env, `/files/${blob.blob_id}/content`), auth: "owner" })).status, 200);
  });
});
