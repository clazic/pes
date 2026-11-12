/**
 * SEL-115 1차 리뷰 필수 3건(+ 같은 누출의 다른 출구) — deny 자료는 AI 쪽에 이름·id·해시·본문·개수까지 안 나간다.
 * 이 파일의 시험은 고치기 전에 실패했다(기존 enforce 시험은 title 을 따로 줘서, 그리고 object_id/version_id 를 안 봐서 이 구멍을 못 잡았다).
 *
 *   1. GET /context 의 manifest·digest 가 deny 자료 객체(object_id·version_id·kind=source·개수)를 싣는다.
 *   2. GET /objects/{o}/versions/{v} 의 content.title(기본값 = 파일 이름)·content_hash(파일 sha256 포함) 가 그대로 나간다.
 *   3. GET /changes 가 file.material_uploaded·file.ai_access_changed 와 그 자료의 object_id·version_id 를 그대로 싣는다.
 *   4. 전달 묶음(ClaudeAppAdapter.export_bundle)의 base_versions 가 deny 자료의 object_id·version_id 를 외부 AI 앱으로 보낸다.
 *
 * 사람(owner 세션)은 어느 경로에서도 그대로 본다. allow 로 되돌리면 다시 나온다.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { ClaudeAppAdapter } from "../scripts/pes_core/adapters/claude_app.ts";
import { SESSION_SECRET, assert_ok, call, make_agent, with_api, type ApiEnv } from "./helpers/api_env.ts";
import { with_cleanup } from "./helpers/adapter_b_flow.ts";
import { P, http_blob, set_access, text_bytes, upload_material, wire_of } from "./helpers/sel115_env.ts";

/** 제목 없이 올린 자료: title 기본값 = 파일 이름. */
async function untitled_material(env: ApiEnv, label: string, marker: string, name: string) {
  const bytes = text_bytes(label, marker);
  const blob = await http_blob(env, bytes, { name });
  const res = await upload_material(env, { blob_id: blob.blob_id });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return { data: res.json.data as any, blob, marker, name, bytes };
}

type Mat = Awaited<ReturnType<typeof untitled_material>>;

/** deny 자료의 흔적 전부(파일 이름·blob·정책·해시·본문 표식 + 자료 객체 id·버전 id). */
function ids_of(m: Mat): string[] {
  return [m.blob.blob_id, m.data.file_policy_id, m.blob.sha256, m.marker, m.name, m.data.object_id, m.data.version_id];
}

function assert_clean(text: string, m: Mat, where: string): void {
  for (const needle of ids_of(m)) assert.ok(!text.includes(needle), `${where}: "${needle}" must not appear`);
}

const agent_get = (env: ApiEnv, token: string, rest: string) => call(env, { method: "GET", path: P(env, rest), auth: { token } });

for (const kind of ["external_agent", "internal_ai"] as const) {
  test(`누출 1 (${kind}): GET /context — manifest 에 deny 자료 객체가 없고 digest·개수는 자료가 없을 때와 같다; 사람은 그대로 보고, allow 로 되돌리면 다시 나온다`, async () => {
    await with_api(async (env) => {
      const agent = await make_agent(env, "ctx", ["context:read", "file:read"], kind);
      const base = assert_ok(await agent_get(env, agent.token, "/context"));

      const secret = await untitled_material(env, `c-${kind}`, `SECRET-CTX-${kind}`, `비공개-ctx-${kind}.txt`);
      assert_ok(await set_access(env, secret.data.file_policy_id, "deny"));

      const res = await agent_get(env, agent.token, "/context");
      const ctx = assert_ok(res);
      assert_clean(wire_of(res), secret, "agent context");
      assert.equal(ctx.manifest.length, base.manifest.length, "not even a count of the hidden material in manifest");
      assert.deepEqual(ctx.materials, [], "materials list was already clean");
      assert.equal(ctx.digest, base.digest, "the digest is computed from the same list the agent sees");

      // 사람: manifest 에 그대로 있다.
      const owner = assert_ok(await call(env, { method: "GET", path: P(env, "/context"), auth: "owner" }));
      const entry = owner.manifest.find((e: any) => e.object_id === secret.data.object_id);
      assert.ok(entry, "the owner still sees the material in the manifest");
      assert.equal(entry.version_id, secret.data.version_id);
      assert.equal(owner.manifest.length, base.manifest.length + 1);

      // allow 로 되돌리면 agent 에게도 다시 나온다.
      assert_ok(await set_access(env, secret.data.file_policy_id, "allow"));
      const back = assert_ok(await agent_get(env, agent.token, "/context"));
      assert.ok(back.manifest.some((e: any) => e.object_id === secret.data.object_id), "allow → listed again");
      assert.notEqual(back.digest, base.digest);
    });
  });
}

for (const kind of ["external_agent", "internal_ai"] as const) {
  test(`누출 2 (${kind}): GET /objects/{o}/versions/{v} — deny 자료 버전은 제목(=파일 이름)·content_hash·파일을 안 준다; 사람은 그대로, 허용 자료는 그대로`, async () => {
    await with_api(async (env) => {
      const secret = await untitled_material(env, `v-${kind}`, `SECRET-VER-${kind}`, `비공개-ver-${kind}.txt`);
      const open = await untitled_material(env, `vo-${kind}`, `OPEN-VER-${kind}`, `공개-ver-${kind}.txt`);
      const agent = await make_agent(env, "ver", ["context:read", "file:read"], kind);
      const path = (m: Mat) => `/objects/${m.data.object_id}/versions/${m.data.version_id}`;

      // deny 전: title 기본값이 파일 이름이므로 agent 는 이름을 본다(= 이 시험이 구멍을 재현한다).
      const before = assert_ok(await agent_get(env, agent.token, path(secret)));
      assert.equal(before.content.title, secret.name, "title defaults to the original file name");
      const real_hash: string = before.content_hash;

      assert_ok(await set_access(env, secret.data.file_policy_id, "deny"));
      const res = await agent_get(env, agent.token, path(secret));
      const out = assert_ok(res);
      for (const needle of [secret.name, secret.marker, secret.blob.blob_id, secret.blob.sha256, secret.data.file_policy_id, real_hash]) {
        assert.ok(!wire_of(res).includes(needle), `version read after deny: "${needle}" must not appear`);
      }
      assert.deepEqual(out.files, []);
      assert.equal(out.content, null, "the file's own title/quote are withheld");
      assert.match(out.content_hash, /^[0-9a-f]{64}$/, "still a valid 64-hex value");
      assert.notEqual(out.content_hash, real_hash);

      // 허용 자료는 그대로.
      const ok = assert_ok(await agent_get(env, agent.token, path(open)));
      assert.equal(ok.content.title, open.name);
      assert.equal(ok.files.length, 1);

      // 사람은 그대로.
      const owner = assert_ok(await call(env, { method: "GET", path: P(env, path(secret)), auth: "owner" }));
      assert.equal(owner.content.title, secret.name);
      assert.equal(owner.content_hash, real_hash);
      assert.equal(owner.files.length, 1);

      // 되돌리면 다시.
      assert_ok(await set_access(env, secret.data.file_policy_id, "allow"));
      const again = assert_ok(await agent_get(env, agent.token, path(secret)));
      assert.equal(again.content.title, secret.name);
      assert.equal(again.content_hash, real_hash);
    });
  });
}

test("누출 2: 제목을 직접 준 deny 자료의 제목도 안 나간다 (제목은 사람이 붙인 이 자료의 이름이다)", async () => {
  await with_api(async (env) => {
    const bytes = text_bytes("titled", "SECRET-TITLED");
    const blob = await http_blob(env, bytes, { name: "x.txt" });
    const made = assert_ok(await upload_material(env, { blob_id: blob.blob_id, title: "비공개 제목 가나다" }), 201);
    assert_ok(await set_access(env, made.file_policy_id, "deny"));
    const agent = await make_agent(env, "titled", ["context:read", "file:read"]);
    const res = await agent_get(env, agent.token, `/objects/${made.object_id}/versions/${made.version_id}`);
    assert_ok(res);
    assert.ok(!wire_of(res).includes("비공개 제목 가나다"));
  });
});

/** The event_seq of every stored event that names this material's blob, file policy, object or version (the feed itself carries only seq/type). */
function seqs_of(env: ApiEnv, m: Mat): Set<string> {
  const rows = env.db.all<{ event_seq: bigint; payload: string }>("SELECT event_seq, payload FROM events WHERE project_id = ?", env.p.project_id);
  return new Set(rows.filter((r) => ids_of(m).slice(0, 3).concat([m.data.object_id, m.data.version_id]).some((id) => r.payload.includes(id))).map((r) => r.event_seq.toString()));
}

for (const kind of ["external_agent", "internal_ai"] as const) {
  test(`누출 3 (${kind}): GET /changes — deny 자료의 사건(file.upload_*·file.material_uploaded·file.ai_access_changed)이 안 나가고, 허용 자료 사건은 나간다; 사람은 그대로, allow 로 되돌리면 다시`, async () => {
    await with_api(async (env) => {
      const secret = await untitled_material(env, `e-${kind}`, `SECRET-EVT-${kind}`, `비공개-evt-${kind}.txt`);
      const open = await untitled_material(env, `eo-${kind}`, `OPEN-EVT-${kind}`, `공개-evt-${kind}.txt`);
      const agent = await make_agent(env, "evt", ["context:read", "file:read"], kind);

      const feed = async (auth: any) => {
        const res = await call(env, { method: "GET", path: P(env, "/changes?limit=100"), auth });
        const events = assert_ok(res).events as Array<{ event_seq: string; type: string; object_id: string | null; before_version_id: string | null; after_version_id: string | null }>;
        return { res, events, seqs: new Set(events.map((e) => e.event_seq)) };
      };
      const has_any = (feed_seqs: Set<string>, mine: Set<string>) => [...mine].some((q) => feed_seqs.has(q));

      assert_ok(await set_access(env, secret.data.file_policy_id, "deny"));
      const secret_seqs = seqs_of(env, secret);
      const open_seqs = seqs_of(env, open);
      assert.ok(secret_seqs.size >= 3, "reserve, complete, material_uploaded and the deny are stored events");

      const a = await feed({ token: agent.token });
      assert_clean(wire_of(a.res), secret, "agent changes feed");
      assert.ok(!has_any(a.seqs, secret_seqs), "no stored event of the denied file reaches the agent");
      assert.ok([...open_seqs].every((q) => a.seqs.has(q)), "the allowed material's events are still in the feed");
      assert.equal(a.events.filter((e) => e.type === "file.ai_access_changed").length, 0, "the deny itself is not announced to the agent");
      assert.equal(a.events.filter((e) => e.type === "file.material_uploaded").length, 1, "only the allowed upload is announced (not even a count of the hidden one)");

      const owner = await feed("owner");
      assert.ok([...secret_seqs].every((q) => owner.seqs.has(q)), "the owner still sees every event");

      assert_ok(await set_access(env, secret.data.file_policy_id, "allow"));
      const back = await feed({ token: agent.token });
      assert.ok(back.events.filter((e) => e.type === "file.material_uploaded").length === 2, "allow → the material's events come back");
    });
  });
}

test("누출 3: 모든 에이전트 읽기 경로를 한 번씩 돌려도 deny 자료의 object_id·version_id 가 어디에도 없다 (workspace·rounds·assumptions 등 포함)", async () => {
  await with_api(async (env) => {
    const secret = await untitled_material(env, "sweep", "SECRET-SWEEP", "비공개-sweep.txt");
    assert_ok(await set_access(env, secret.data.file_policy_id, "deny"));
    const agent = await make_agent(env, "sweep", ["context:read", "file:read"]);
    const stage_id: string = assert_ok(await agent_get(env, agent.token, "/context")).stages[0].stage_id;
    const paths = [
      "/context",
      "/materials",
      "/workspace",
      "/changes?limit=100",
      "/assumptions",
      "/decisions",
      "/reflections",
      `/stages/${stage_id}/rounds/1`,
      `/stages/${stage_id}/rounds/1/threads`,
    ];
    for (const path of paths) {
      const res = await agent_get(env, agent.token, path);
      assert.ok(res.status < 500, `${path} ${res.status}`);
      assert_clean(wire_of(res), secret, `agent GET ${path}`);
    }
  });
});

test("출구 4: 전달 묶음(export_bundle)의 base_versions 에 deny 자료가 없다 — 외부 AI 앱으로 가는 글에 id 가 없어야 한다; 사람이 allow 로 되돌리면 다시 들어간다", async () => {
  await with_cleanup(async (env, _open) => {
    const secret = await untitled_material(env, "bundle", "SECRET-BUNDLE", "비공개-묶음.txt");
    const make = () => new ClaudeAppAdapter({ api: env.app, project_id: env.p.project_id, owner_session: SESSION_SECRET } as any);
    const exported = () => make().export_bundle({ stage_id: env.stage.plan, round_id: env.round_id });

    const before = await exported();
    assert.ok(before.bundle.base_versions.some((v: any) => v.object_id === secret.data.object_id), "allowed material is a base version");

    assert_ok(await set_access(env, secret.data.file_policy_id, "deny"));
    const after = await exported();
    assert_clean(after.text, secret, "handoff bundle text");
    assert.equal(after.bundle.base_versions.length, before.bundle.base_versions.length - 1);

    assert_ok(await set_access(env, secret.data.file_policy_id, "allow"));
    const back = await exported();
    assert.ok(back.bundle.base_versions.some((v: any) => v.object_id === secret.data.object_id), "allow → in the bundle again");
  });
});

// ---------------------------------------------------------------------------
// 2회차 필수 N1 — 쓰기 출구: AI 가 같은 바이트로 upload 예약(중복) → blob_id 를 얻은 뒤 POST /materials 하면
// 응답이 original_name·file_policy_id·ai_access:"deny" 를 줬다(file_ai_denied 를 안 지났다).

const row_counts = (env: ApiEnv) => ({
  objects: Number(env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM objects")?.n ?? 0n),
  versions: Number(env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM object_versions")?.n ?? 0n),
  files: Number(env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM version_files")?.n ?? 0n),
  receipts: Number(env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM mutation_commits")?.n ?? 0n),
  events: Number(env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM events")?.n ?? 0n),
});

for (const kind of ["external_agent", "internal_ai"] as const) {
  test(`N1 (${kind}): file:write AI 가 같은 바이트의 예약(중복)으로 deny blob_id 를 얻어도 POST /materials 는 404 — 이름·정책 id·deny 상태가 안 나가고 아무 행도 안 늘어난다; 사람은 같은 호출이 201`, async () => {
    await with_api(async (env) => {
      const secret = await untitled_material(env, `n1-${kind}`, `SECRET-N1-${kind}`, `비공개-n1-${kind}.txt`);
      assert_ok(await set_access(env, secret.data.file_policy_id, "deny"));
      const agent = await make_agent(env, "writer", ["context:read", "file:read", "file:write"], kind);

      // 같은 바이트를 가진 호출자는 예약 중복으로 blob_id 를 받는다(알려진 한계 — 문서에 적음).
      const same = await http_blob(env, secret.bytes, { auth: { token: agent.token } });
      assert.equal(same.blob_id, secret.blob.blob_id);

      const before = row_counts(env);
      const res = await upload_material(env, { blob_id: same.blob_id }, { token: agent.token });
      assert.equal(res.status, 404, JSON.stringify(res.json));
      assert_clean(wire_of(res), secret, "agent POST /materials (deny blob)");
      assert.ok(!wire_of(res).includes("deny"), "not even the word deny");
      assert.deepEqual(row_counts(env), before, "nothing was written: no receipt, no event, no object, no version, no file");

      // 모르는 blob 과 같은 답이다.
      const unknown = await upload_material(env, { blob_id: "no-such-blob-0000" }, { token: agent.token });
      assert.equal(unknown.status, 404);
      assert.equal(res.json.error.code, unknown.json.error.code);

      // 사람은 같은 호출이 그대로 된다(deny 표시와 함께).
      const human = await upload_material(env, { blob_id: secret.blob.blob_id });
      assert.equal(human.status, 201, JSON.stringify(human.json));
      assert.equal(human.json.data.ai_access, "deny");
      assert.equal(human.json.data.original_name, secret.name);
    });
  });

  test(`N1 (${kind}): AI 는 닫힌 자료 객체에 새 버전을 못 붙인다 (허용 blob 이어도 404, 옛 제목 상속 없음); 열린 자료·새 자료는 되고 응답에 ai_access 키가 없다`, async () => {
    await with_api(async (env) => {
      const secret = await untitled_material(env, `n1o-${kind}`, `SECRET-N1O-${kind}`, `비공개-n1o-${kind}.txt`);
      assert_ok(await set_access(env, secret.data.file_policy_id, "deny"));
      const agent = await make_agent(env, "writer2", ["context:read", "file:read", "file:write"], kind);
      const fresh = await http_blob(env, text_bytes("fresh", `FRESH-${kind}`), { name: `새파일-${kind}.txt`, auth: { token: agent.token } });

      const before = row_counts(env);
      const into_closed = await upload_material(env, { blob_id: fresh.blob_id, object_id: secret.data.object_id }, { token: agent.token });
      assert.equal(into_closed.status, 404, JSON.stringify(into_closed.json));
      assert_clean(wire_of(into_closed), secret, "agent POST /materials into a closed object");
      assert.deepEqual(row_counts(env), before);

      // 새 자료는 된다. 응답에 ai_access 키가 없다(AI 는 이 키를 못 받는다).
      const made = await upload_material(env, { blob_id: fresh.blob_id }, { token: agent.token });
      assert.equal(made.status, 201, JSON.stringify(made.json));
      assert.ok(!("ai_access" in made.json.data), "an AI caller never gets the ai_access key");
      assert.equal(made.json.data.original_name, `새파일-${kind}.txt`);
      assert_clean(wire_of(made), secret, "agent POST /materials (new material)");

      // 열린 자료의 새 버전도 된다.
      const second = await http_blob(env, text_bytes("fresh2", `FRESH2-${kind}`), { name: `새파일2-${kind}.txt`, auth: { token: agent.token } });
      const again = await upload_material(env, { blob_id: second.blob_id, object_id: made.json.data.object_id }, { token: agent.token });
      assert.equal(again.status, 201, JSON.stringify(again.json));
      assert.ok(!("ai_access" in again.json.data));

      // 사람의 응답에는 ai_access 가 그대로 있다.
      const third = await http_blob(env, text_bytes("fresh3", `FRESH3-${kind}`), { name: `새파일3-${kind}.txt` });
      const human = await upload_material(env, { blob_id: third.blob_id });
      assert.equal(human.status, 201);
      assert.equal(human.json.data.ai_access, "allow");
    });
  });
}
