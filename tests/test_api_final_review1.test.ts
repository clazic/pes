/**
 * SEL-46 PR13 — Codex 최종 리뷰 1/2 회귀 시험 (tester, 회귀 모드).
 *
 * 리뷰 전문: logs/SEL-46-final-review-1.md. 각 시험은 리뷰의 합성 재현을 그대로 시험으로 고정한다.
 *
 *   F1  잘못된 media_type(CR/LF 등) 예약은 400 invalid_payload. 이미 저장된 이상한 값은 읽기 때
 *       application/octet-stream 으로 대체된다. (serve.py 실제 HTTP 종단은 tests/test_serve_api_final.py)
 *   F2  context 는 첫 project 조회 직후 다른 SQLite 연결이 커밋해도 한 시점의 일관된 결과를 낸다.
 *   F3  GET P/objects/{o}/versions/{v} — 정확한 object/version 쌍의 내용 읽기.
 *   F4  context manifest 와 digest 는 objects.current_version_id 포인터를 따른다.
 *   F5  빈 파일(size 0) 예약 → 빈 PUT → complete → GET (ApiApp 수준. HTTP 종단은 python 시험).
 *
 * F3 DTO 모양 (이 시험이 고정한다. 기존 context manifest 항목과 맞췄다):
 *
 *   GET /api/v1/projects/{id}/objects/{o}/versions/{v}  — 토큰 scope context:read 또는 소유자 세션.
 *   data = {
 *     project_id:  string,
 *     object_id:   string,          // manifest 항목과 같은 이름
 *     kind:        string,          // manifest 항목과 같은 이름
 *     version_id:  string,          // manifest 항목과 같은 이름
 *     version_no:  number,          // manifest 항목과 같은 형식 (정수 number)
 *     is_current:  boolean,         // 이 버전이 objects.current_version_id 인가
 *     content_hash: string,         // 64자리 소문자 hex
 *     files: [ { blob_id: string, role: string } ],   // version_files 행. 그 밖의 필드는 더해도 된다.
 *   }
 *   소속이 맞지 않는 (프로젝트, 객체, 버전) 조합은 404 not_found, 권한 없음은 403 forbidden,
 *   Go OFF 에서 internal_ai 는 context 와 같은 403 policy_denied.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { CommandService } from "../scripts/pes_core/commands.ts";
import { connect } from "../scripts/pes_core/db.ts";
import { create_object, add_artifact, set_current } from "../scripts/pes_core/content.ts";
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
} from "./helpers/api_env.ts";
import { MEDIA_TYPE, attach, bytes_of, ctx_for, more_version, new_artifact, put_ready, second_project } from "./helpers/blob_env.ts";
import { sha256_hex } from "../scripts/pes_core/files.ts";

const P = (env: ApiEnv, rest = "") => project_path(env, rest);

const read_context = async (env: ApiEnv) =>
  assert_ok(await call(env, { method: "GET", path: P(env, "/context"), auth: "owner" }));

async function set_current_to(env: ApiEnv, key: string, object_id: string, version_id: string): Promise<void> {
  await set_current(env.service, env.ctx(key), { object_id, version_id });
}

function pointer(env: ApiEnv, object_id: string): string | null {
  const row = env.db.get<{ current_version_id: string | null }>(
    "SELECT current_version_id FROM objects WHERE project_id = ? AND id = ?",
    env.p.project_id,
    object_id,
  );
  assert.ok(row);
  return row.current_version_id;
}

// ---------------------------------------------------------------------------
// F1  media_type

const BAD_MEDIA_TYPES = [
  "text/plain\r\nX-Pes-Probe: injected",
  "text/plain\nX-Pes-Probe: injected",
  "text/plain\rX-Pes-Probe: injected",
  "text/plain\u0000",
  "text/plain\u0001",
  "text/plain\u007f",
  "텍스트/평문",
];

test("F1: reserving an upload with a CR/LF/control-character media_type is 400 invalid_payload and writes nothing", async () => {
  await with_api(async (env) => {
    const bytes = bytes_of("f1-bad", 32);
    const before = env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM blobs")?.n;
    for (const media_type of BAD_MEDIA_TYPES) {
      const res = await call(env, {
        method: "POST",
        path: P(env, "/uploads"),
        auth: "owner",
        body: { sha256: sha256_hex(bytes), size: bytes.byteLength, media_type, original_name: "합성.bin" },
      });
      assert_error(res, 400, "invalid_payload");
    }
    assert.equal(env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM blobs")?.n, before, "no blob row was reserved");
  });
});

test("F1: ordinary media types (with parameters) are still accepted", async () => {
  await with_api(async (env) => {
    for (const [i, media_type] of ["text/plain", "text/plain; charset=utf-8", "application/json", "image/svg+xml"].entries()) {
      const bytes = bytes_of(`f1-ok-${i}`, 16);
      const res = await call(env, {
        method: "POST",
        path: P(env, "/uploads"),
        auth: "owner",
        body: { sha256: sha256_hex(bytes), size: bytes.byteLength, media_type, original_name: "합성.bin" },
      });
      assert_ok(res, 201);
    }
  });
});

test("F1: a media_type that is already stored with CR/LF is served as application/octet-stream, no header carries a line break", async () => {
  await with_api(async (env) => {
    const bytes = bytes_of("f1-stored", 64);
    const r = await put_ready(env, bytes, "f1-stored");
    env.db.run("UPDATE blobs SET media_type = ? WHERE id = ?", "text/plain\r\nX-Pes-Probe: injected", r.blob_id);
    const res = await call(env, {
      method: "GET",
      path: P(env, `/files/${r.blob_id}/content`),
      auth: "owner",
    });
    assert.equal(res.status, 200);
    assert.deepEqual(Buffer.from(res.bytes ?? new Uint8Array()), Buffer.from(bytes));
    assert.match(res.headers["content-type"] ?? "", /^application\/octet-stream/);
    for (const [name, value] of Object.entries(res.headers)) {
      assert.doesNotMatch(name, /[\r\n\0]/, `header name ${JSON.stringify(name)}`);
      assert.doesNotMatch(value, /[\r\n\0]/, `header ${name} value ${JSON.stringify(value)}`);
    }
    assert.equal(Object.keys(res.headers).some((n) => n.toLowerCase() === "x-pes-probe"), false);
  });
});

// ---------------------------------------------------------------------------
// F2  context reads one consistent snapshot

test("F2: a commit from a second SQLite connection right after the first project SELECT never yields a mixed context", async () => {
  let race: (() => void) | null = null;
  await with_api(
    async (env) => {
      const v1 = await new_artifact(env, "f2-v1");
      const old_state = await read_context(env);
      assert.equal(old_state.control_rev, "0");
      assert.deepEqual(
        old_state.manifest.map((m: { version_id: string }) => m.version_id),
        [v1.version_id],
      );

      // The other connection: a real second handle on the same database file.
      const other = connect(env.db.path);
      try {
        const other_service = new CommandService(other, { clock: env.clock, policy: env.policy, objects_dir: env.objects });
        let fired = 0;
        race = () => {
          fired += 1;
          other_service.execute_sync({ ...env.ctx("f2-topic"), base_control_rev: 0 }, "project.set_topic", {
            topic: "합성 경합 주제",
          });
          const appended = other_service.execute_sync(env.ctx("f2-append"), "content.append_version", {
            object_id: v1.object_id,
            title: "합성 경합 제목",
          }).result as { version_id: string };
          other_service.execute_sync(env.ctx("f2-adopt"), "content.set_current", {
            object_id: v1.object_id,
            version_id: appended.version_id,
          });
        };

        const raced = await call(env, { method: "GET", path: P(env, "/context"), auth: "owner" });
        assert.equal(fired, 1, "the competing commit ran exactly once, inside the read");
        const mixed = assert_ok(raced);
        race = null;
        const new_state = await read_context(env);
        assert.equal(new_state.control_rev, "1");
        assert.notEqual(new_state.digest, old_state.digest);

        const as_old = mixed.control_rev === "0";
        const expected = as_old ? old_state : new_state;
        assert.equal(mixed.control_rev, expected.control_rev, "control_rev");
        assert.equal(mixed.topic, expected.topic, "topic matches the same moment as control_rev");
        assert.deepEqual(mixed.manifest, expected.manifest, "manifest matches the same moment as control_rev");
        assert.equal(mixed.digest, expected.digest, "digest is one that the database really had");
      } finally {
        other.close();
      }
    },
    {
      wrap: (db) => ({
        ...db,
        get: <T>(sql: string, ...params: Parameters<typeof db.get>[1][]) => {
          const row = db.get<T>(sql, ...(params as never[]));
          if (race !== null && /FROM\s+projects/i.test(sql)) {
            const fire = race;
            race = null;
            fire();
          }
          return row;
        },
      }),
    },
  );
});

// ---------------------------------------------------------------------------
// F3  GET P/objects/{o}/versions/{v}

const VERSION_PATH = (env: ApiEnv, object_id: string, version_id: string) =>
  P(env, `/objects/${object_id}/versions/${version_id}`);

test("F3: the owner reads an exact version; the DTO matches the context manifest entry and lists attached files", async () => {
  await with_api(async (env) => {
    const v1 = await new_artifact(env, "f3-a");
    const bytes = bytes_of("f3-file", 40);
    const blob = await put_ready(env, bytes, "f3-file");
    await attach(env, v1.version_id, blob.blob_id, "attachment", "f3-attach");

    const context = await read_context(env);
    const entry = context.manifest.find((m: { version_id: string }) => m.version_id === v1.version_id);
    assert.ok(entry, "the version is in the manifest");

    const res = await call(env, { method: "GET", path: VERSION_PATH(env, v1.object_id, v1.version_id), auth: "owner" });
    const data = assert_ok(res);
    assert.equal(data.project_id, env.p.project_id);
    for (const key of ["object_id", "kind", "version_id", "version_no"]) {
      assert.deepEqual(data[key], entry[key], `${key} matches the manifest entry`);
    }
    assert.equal(typeof data.version_no, "number");
    assert.equal(data.is_current, true);
    assert.match(data.content_hash, /^[0-9a-f]{64}$/);
    assert.ok(Array.isArray(data.files));
    const file = data.files.find((f: { blob_id: string }) => f.blob_id === blob.blob_id);
    assert.ok(file, "the attached file is listed");
    assert.equal(file.role, "attachment");
  });
});

test("F3: a non-current version is readable too and says so; a repeated read is identical", async () => {
  await with_api(async (env) => {
    const v1 = await new_artifact(env, "f3-b");
    const v2 = await more_version(env, "f3-b2", v1.object_id);
    const first = assert_ok(await call(env, { method: "GET", path: VERSION_PATH(env, v1.object_id, v1.version_id), auth: "owner" }));
    assert.equal(first.is_current, true, "append does not move the pointer");
    const second = assert_ok(await call(env, { method: "GET", path: VERSION_PATH(env, v2.object_id, v2.version_id), auth: "owner" }));
    assert.equal(second.is_current, false);
    assert.equal(second.version_no, v2.version_no);
    await set_current_to(env, "f3-b-adopt", v2.object_id, v2.version_id);
    const again1 = assert_ok(await call(env, { method: "GET", path: VERSION_PATH(env, v1.object_id, v1.version_id), auth: "owner" }));
    const again2 = assert_ok(await call(env, { method: "GET", path: VERSION_PATH(env, v2.object_id, v2.version_id), auth: "owner" }));
    assert.equal(again1.is_current, false);
    assert.equal(again2.is_current, true);
    assert.deepEqual(
      assert_ok(await call(env, { method: "GET", path: VERSION_PATH(env, v2.object_id, v2.version_id), auth: "owner" })),
      again2,
    );
  });
});

test("F3: another project's ids, a wrong object/version pair, and unknown ids are 404 not_found", async () => {
  await with_api(async (env) => {
    const a = await new_artifact(env, "f3-c");
    const b = await new_artifact(env, "f3-d");
    const other = await second_project(env, "synthetic-f3-other");
    const other_obj = (
      await create_object(env.service, ctx_for(other, "f3-o-obj"), { kind: "artifact", edition_id: other.edition_id })
    ).result as { object_id: string };
    const other_ver = (
      await add_artifact(env.service, ctx_for(other, "f3-o-ver"), {
        object_id: other_obj.object_id,
        artifact_kind: "chapter",
        title: "합성 다른 프로젝트",
        summary: "합성",
      })
    ).result as { version_id: string };

    // the other project's object and version asked through this project's path
    assert_error(await call(env, { method: "GET", path: VERSION_PATH(env, other_obj.object_id, other_ver.version_id), auth: "owner" }), 404, "not_found");
    // this project's object with the other project's version, and the reverse
    assert_error(await call(env, { method: "GET", path: VERSION_PATH(env, a.object_id, other_ver.version_id), auth: "owner" }), 404, "not_found");
    assert_error(await call(env, { method: "GET", path: VERSION_PATH(env, other_obj.object_id, a.version_id), auth: "owner" }), 404, "not_found");
    // same project, mismatched pair
    assert_error(await call(env, { method: "GET", path: VERSION_PATH(env, a.object_id, b.version_id), auth: "owner" }), 404, "not_found");
    assert_error(await call(env, { method: "GET", path: VERSION_PATH(env, b.object_id, a.version_id), auth: "owner" }), 404, "not_found");
    // unknown ids
    assert_error(await call(env, { method: "GET", path: VERSION_PATH(env, "no-such-object", a.version_id), auth: "owner" }), 404, "not_found");
    assert_error(await call(env, { method: "GET", path: VERSION_PATH(env, a.object_id, "no-such-version"), auth: "owner" }), 404, "not_found");
    // and the right pair is fine
    assert_ok(await call(env, { method: "GET", path: VERSION_PATH(env, a.object_id, a.version_id), auth: "owner" }));
  });
});

test("F3: credentials — no credentials 401, a token without context:read 403, a token with it 200, the route is GET only", async () => {
  await with_api(async (env) => {
    const v = await new_artifact(env, "f3-e");
    const path = VERSION_PATH(env, v.object_id, v.version_id);
    const reader = await make_agent(env, "reader", ["context:read"]);
    const files_only = await make_agent(env, "files-only", ["file:read", "file:write"]);
    assert_error(await call(env, { method: "GET", path }), 401, "unauthenticated");
    assert_error(await call(env, { method: "GET", path, auth: { token: files_only.token } }), 403, "forbidden");
    assert_ok(await call(env, { method: "GET", path, auth: { token: reader.token } }));
    for (const method of ["POST", "PUT", "DELETE"]) {
      const res = await call(env, { method, path, auth: "owner", body: {} });
      assert_error(res, 405, "method_not_allowed");
      assert.match(res.headers["allow"] ?? "", /GET/);
    }
    // an unknown project is not found, not forbidden-with-detail
    assert_error(
      await call(env, { method: "GET", path: `/api/v1/projects/no-such-project/objects/${v.object_id}/versions/${v.version_id}`, auth: "owner" }),
      404,
      "not_found",
    );
  });
});

test("F3: Go OFF follows the context rule — internal_ai 403 policy_denied, external agent and owner still read", async () => {
  await with_api(async (env) => {
    const v = await new_artifact(env, "f3-go");
    const path = VERSION_PATH(env, v.object_id, v.version_id);
    const internal = await make_agent(env, "internal", ["context:read"], "internal_ai");
    const external = await make_agent(env, "external", ["context:read"]);
    assert_ok(await call(env, { method: "GET", path, auth: { token: internal.token } }));
    await go_off(env);
    const denied = await call(env, { method: "GET", path, auth: { token: internal.token } });
    assert.equal(assert_error(denied, 403, "policy_denied").retryable, false);
    assert_ok(await call(env, { method: "GET", path, auth: { token: external.token } }));
    assert_ok(await call(env, { method: "GET", path, auth: "owner" }));
  });
});

test("F3: the route is in capabilities and in docs/api/openapi-v1.yaml with a 200 and 404 response", async () => {
  await with_api(async (env) => {
    const caps = assert_ok(await call(env, { method: "GET", path: "/api/v1/capabilities" }));
    assert.ok(
      caps.routes.some((r: string) => /^GET \/api\/v1\/projects\/\{[^}]+\}\/objects\/\{[^}]+\}\/versions\/\{[^}]+\}$/.test(r)),
      `capabilities.routes lacks the version route: ${JSON.stringify(caps.routes)}`,
    );
  });
  const lines = readFileSync(OPENAPI_PATH, "utf8").split(/\r?\n/);
  const start = lines.findIndex((l) => /^ {2}['"]?\/api\/v1\/projects\/\{[^}]+\}\/objects\/\{[^}]+\}\/versions\/\{[^}]+\}['"]?:\s*$/.test(l));
  assert.notEqual(start, -1, "OpenAPI has no objects/versions path");
  const block: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {2}\S/.test(lines[i]!) || /^\S/.test(lines[i]!)) break;
    block.push(lines[i]!);
  }
  assert.ok(block.some((l) => /^ {4}get:/.test(l)), "OpenAPI documents get");
  for (const status of ["200", "401", "403", "404"]) {
    assert.ok(block.some((l) => new RegExp(`['"]?${status}['"]?:`).test(l)), `OpenAPI documents ${status}`);
  }
});

// ---------------------------------------------------------------------------
// F4  manifest and digest follow objects.current_version_id

test("F4: v1 -> append v2 -> set_current(v2) -> context -> set_current(v1) -> context: manifest and digest follow the pointer", async () => {
  await with_api(async (env) => {
    const v1 = await new_artifact(env, "f4");
    const manifest_ids = (c: { manifest: { object_id: string; version_id: string }[] }) =>
      c.manifest.filter((m) => m.object_id === v1.object_id).map((m) => m.version_id);

    const c1 = await read_context(env);
    assert.equal(pointer(env, v1.object_id), v1.version_id);
    assert.deepEqual(manifest_ids(c1), [v1.version_id]);

    const v2 = await more_version(env, "f4-2", v1.object_id);
    assert.equal(pointer(env, v1.object_id), v1.version_id, "append alone does not move the pointer");
    const c_appended = await read_context(env);
    assert.deepEqual(manifest_ids(c_appended), [v1.version_id], "an appended but not adopted version is not in the manifest");
    assert.ok(!c_appended.manifest.some((m: { version_id: string }) => m.version_id === v2.version_id));
    assert.equal(c_appended.digest, c1.digest, "an unadopted append does not change the digest");

    await set_current_to(env, "f4-to2", v1.object_id, v2.version_id);
    assert.equal(pointer(env, v1.object_id), v2.version_id);
    const c2 = await read_context(env);
    assert.deepEqual(manifest_ids(c2), [v2.version_id]);
    assert.equal(c2.manifest.find((m: { version_id: string }) => m.version_id === v2.version_id).version_no, v2.version_no);
    assert.notEqual(c2.digest, c1.digest);

    await set_current_to(env, "f4-back", v1.object_id, v1.version_id);
    assert.equal(pointer(env, v1.object_id), v1.version_id);
    const c3 = await read_context(env);
    assert.deepEqual(manifest_ids(c3), [v1.version_id], "pointing back to the old version puts the old version back");
    assert.notEqual(c3.digest, c2.digest);
    assert.equal(c3.digest, c1.digest, "the same pointer set gives the same digest");
  });
});

test("F4: an append with a higher version_no never replaces a different adopted version in the manifest", async () => {
  await with_api(async (env) => {
    const v1 = await new_artifact(env, "f4b");
    await more_version(env, "f4b-2", v1.object_id);
    const v3 = await more_version(env, "f4b-3", v1.object_id);
    assert.ok(v3.version_no > v1.version_no);
    const c = await read_context(env);
    const mine = c.manifest.filter((m: { object_id: string }) => m.object_id === v1.object_id);
    assert.equal(mine.length, 1, "one manifest entry per object");
    assert.equal(mine[0].version_id, pointer(env, v1.object_id));
    assert.equal(mine[0].version_id, v1.version_id);
  });
});

// ---------------------------------------------------------------------------
// F5  empty file (ApiApp level; the HTTP bridge case is in tests/test_serve_api_final.py)

test("F5: size 0 reserve -> empty PUT -> complete -> GET returns an empty body with the empty sha256 (ApiApp)", async () => {
  await with_api(async (env) => {
    const empty = new Uint8Array(0);
    const reserved = assert_ok(
      await call(env, {
        method: "POST",
        path: P(env, "/uploads"),
        auth: "owner",
        body: { sha256: sha256_hex(empty), size: 0, media_type: MEDIA_TYPE, original_name: "빈.bin" },
      }),
      201,
    );
    assert_ok(await call(env, { method: "PUT", path: P(env, `/uploads/${reserved.blob_id}`), auth: "owner", raw: empty, headers: { "content-type": MEDIA_TYPE } }));
    const done = assert_ok(await call(env, { method: "POST", path: P(env, `/uploads/${reserved.blob_id}/complete`), auth: "owner", body: {} }));
    assert.equal(done.state, "ready");
    const got = await call(env, { method: "GET", path: P(env, `/files/${reserved.blob_id}/content`), auth: "owner" });
    assert.equal(got.status, 200);
    assert.equal(got.bytes?.byteLength ?? 0, 0);
    assert.equal(sha256_hex(got.bytes ?? new Uint8Array(0)), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});
