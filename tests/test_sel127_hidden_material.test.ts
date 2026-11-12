/**
 * SEL-127 (MAT1 후속, 작성 모드) — 숨긴 자료의 존재가 새는 길 닫기. 근거: SEL-115 최종 리뷰 2/2 권장 R-A·R-B·R-C + 4번(질의 수).
 * 합성 값만 쓴다. 아래 인터페이스는 이 파일이 정한 것이다(구현이 따른다. 이름이 바뀌면 머리말과 이 파일만 고친다).
 *
 * ── 정한 것 ──────────────────────────────────────────────────────────────────────────────────────────────────
 * R-A  GET P/changes 의 AI(비사람) 쪽 숨김 단위 = 자료 **객체**.
 *      닫힌 파일이 어느 판에든 있는 자료 객체(material_object_denied)에 관한 사건은 전부 안 나간다. 닫히기 전·후에 붙은
 *      **허용 판**의 file.upload_reserved / file.upload_completed / file.material_uploaded 도 숨긴다(지금은 blob 단위라 드러난다).
 *      커서는 숨긴 사건을 지나 간다. 사람(owner 세션)은 모든 사건을 그대로 본다. allow 로 되돌리면 다시 나온다.
 *      (문서 stage-1-api.md 의 「판정 단위」 문장을 다시 객체 단위로 되돌릴지는 구현이 정한다 — 이 파일은 동작만 본다.)
 * R-B  results.submit(append_version) — B API POST runs/{r}/results · MCP pes_submit · A result.submit 이 모두 이 길로 간다 —
 *      비사람이 닫힌 자료 객체(어느 판이든 닫힌 파일이 있음)를 object_id 로 가리키면 **모르는 object_id 와 같은 404**
 *      (같은 error.code). 영수증·사건·객체·판 0 개 늘어난다. 사람 목록(현재 판)은 그대로. 열린 자료·artifact 의 정책은 이 파일이 정하지 않는다.
 * R-C  사람용 GET P/materials 행(과 GET P/context 의 materials)에 칸 `object_ai_access: "allow"|"deny"` 를 더한다.
 *      = 객체 단위 상태: 그 자료 객체의 **어느 판이든** 닫힌 파일이 있으면 "deny", 아니면 "allow". 기존 `ai_access`(그 행 파일의 스위치 값)는 그대로 둔다.
 *      AI 가 받는 행에는 이 칸이 없다(다른 ai_access 처럼 사람 전용 — 닫힌 자료는 목록에 아예 없다).
 * (4)  changes_page 질의 수 = GET P/changes 한 번이 DB 에 보낸 get/all 호출 수(ApiEnv wrap 으로 센다). 사건 수 N 에 비례하지 않는다:
 *      자료 4건일 때와 24건일 때의 차이가 QUERY_SLACK(6) 이하. 쪽 나누기(limit)와 커서 결과는 전과 같다.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { Db } from "../scripts/pes_core/db.ts";
import { assert_ok, call, make_agent, with_api, agent_claims, type ApiEnv, type Agent } from "./helpers/api_env.ts";
import { P, http_blob, set_access, text_bytes, upload_material, wire_of } from "./helpers/sel115_env.ts";

type Kind = "external_agent" | "internal_ai";
const KINDS: Kind[] = ["external_agent", "internal_ai"];

const agent_get = (env: ApiEnv, token: string, rest: string) => call(env, { method: "GET", path: P(env, rest), auth: { token } });
const owner_get = (env: ApiEnv, rest: string) => call(env, { method: "GET", path: P(env, rest), auth: "owner" });

async function material(env: ApiEnv, label: string, opts: { object_id?: string } = {}) {
  const marker = `SECRET-${label}`;
  const name = `합성-${label}.txt`;
  const blob = await http_blob(env, text_bytes(label, marker), { name });
  const res = await upload_material(env, { blob_id: blob.blob_id, ...(opts.object_id === undefined ? {} : { object_id: opts.object_id }) });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return { data: res.json.data as any, blob, marker, name };
}

type Mat = Awaited<ReturnType<typeof material>>;

interface Ev {
  event_seq: string;
  type: string;
}

async function feed(env: ApiEnv, auth: "owner" | { token: string }): Promise<Ev[]> {
  const res = await call(env, { method: "GET", path: P(env, "/changes?limit=100"), auth });
  return assert_ok(res).events as Ev[];
}

/** event_seq of every stored event whose payload names one of these ids (the feed itself carries only seq/type/ids of objects). */
function seqs_naming(env: ApiEnv, ids: string[]): Set<string> {
  const rows = env.db.all<{ event_seq: bigint; payload: string }>("SELECT event_seq, payload FROM events WHERE project_id = ?", env.p.project_id);
  return new Set(rows.filter((r) => ids.some((id) => r.payload.includes(id))).map((r) => r.event_seq.toString()));
}

const counts = (env: ApiEnv) => {
  const n = (t: string) => Number(env.db.get<{ n: bigint }>(`SELECT count(*) AS n FROM ${t}`)?.n ?? 0n);
  return { objects: n("objects"), versions: n("object_versions"), receipts: n("mutation_commits"), events: n("events") };
};

// ---------------------------------------------------------------------------
// R-A — GET changes 는 객체 단위로 숨긴다 (닫힌 자료에 붙은 허용 판의 사건도)

for (const kind of KINDS) {
  for (const order of ["deny 먼저, 그 뒤 허용 v2 올리기", "허용 v2 올린 뒤 v1 deny"] as const) {
    test(`R-A (${kind}, ${order}): 에이전트 changes 의 사건 목록이 자료를 올리기 전과 같다 — 허용 v2 의 reserved·completed·material_uploaded 도 안 나간다; 사람은 모두 보고, allow 로 되돌리면 다시`, async () => {
      await with_api(async (env) => {
        const agent = await make_agent(env, "ra", ["context:read", "file:read"], kind);
        const base = await feed(env, { token: agent.token });

        const secret = await material(env, `ra-${kind}`);
        const v2_blob = await http_blob(env, text_bytes("ra-v2", `OPEN-V2-${kind}`), { name: `공개-v2-${kind}.txt` });
        let v2: any;
        if (order === "deny 먼저, 그 뒤 허용 v2 올리기") {
          assert_ok(await set_access(env, secret.data.file_policy_id, "deny"));
          const up = await upload_material(env, { blob_id: v2_blob.blob_id, object_id: secret.data.object_id });
          assert.equal(up.status, 201, JSON.stringify(up.json));
          v2 = up.json.data;
        } else {
          const up = await upload_material(env, { blob_id: v2_blob.blob_id, object_id: secret.data.object_id });
          assert.equal(up.status, 201, JSON.stringify(up.json));
          v2 = up.json.data;
          assert_ok(await set_access(env, secret.data.file_policy_id, "deny"));
        }
        assert.equal(v2.ai_access, "allow", "전제: v2 파일은 허용이다");

        const mine = seqs_naming(env, [secret.blob.blob_id, secret.data.file_policy_id, secret.data.object_id, secret.data.version_id, v2.version_id, v2_blob.blob_id, v2.file_policy_id]);
        assert.ok(mine.size >= 6, "예약·완료·자료 올림이 v1 v2 각각 + deny 가 저장된 사건이다");

        const seen = await feed(env, { token: agent.token });
        assert.deepEqual(seen.map((e) => e.type), base.map((e) => e.type), "사건 type 목록이 자료를 올리기 전과 같다 (존재·개수가 안 드러난다)");
        assert.ok(![...mine].some((q) => seen.some((e) => e.event_seq === q)), "그 자료 객체에 관한 저장된 사건이 하나도 안 나간다");
        assert.equal(seen.filter((e) => e.type === "file.material_uploaded").length, 0);
        assert_no_wire_trace(wire_of(await call(env, { method: "GET", path: P(env, "/changes?limit=100"), auth: { token: agent.token } })), [secret.blob.blob_id, secret.data.object_id, secret.data.version_id, v2.version_id, v2_blob.blob_id, secret.name]);

        const owner = await feed(env, "owner");
        assert.ok([...mine].every((q) => owner.some((e) => e.event_seq === q)), "사람은 모든 사건을 그대로 본다");

        assert_ok(await set_access(env, secret.data.file_policy_id, "allow"));
        const back = await feed(env, { token: agent.token });
        assert.equal(back.filter((e) => e.type === "file.material_uploaded").length, 2, "allow 로 되돌리면 두 판의 사건이 다시 나온다");
      });
    });
  }
}

test("R-A: 숨긴 자료 사이에 낀 열린 자료의 사건은 그대로 나가고, 쪽 나누기(limit=1)로 따라가도 닫힌 사건의 번호는 안 나온다", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "ra-page", ["context:read", "file:read"]);
    const secret = await material(env, "page-secret");
    const open = await material(env, "page-open");
    const v2_blob = await http_blob(env, text_bytes("page-v2", "OPEN-PAGE-V2"), { name: "공개-page-v2.txt" });
    assert_ok(await set_access(env, secret.data.file_policy_id, "deny"));
    assert.equal((await upload_material(env, { blob_id: v2_blob.blob_id, object_id: secret.data.object_id })).status, 201);

    const hidden = seqs_naming(env, [secret.blob.blob_id, secret.data.object_id, secret.data.file_policy_id, v2_blob.blob_id]);
    const open_seqs = seqs_naming(env, [open.blob.blob_id, open.data.object_id]);
    const got: string[] = [];
    let cursor = "";
    for (let i = 0; i < 60; i += 1) {
      const res = await call(env, { method: "GET", path: P(env, `/changes?limit=1${cursor === "" ? "" : `&cursor=${encodeURIComponent(cursor)}`}`), auth: { token: agent.token } });
      const data = assert_ok(res);
      got.push(...data.events.map((e: Ev) => e.event_seq));
      cursor = data.next_cursor;
      if (!data.has_more) break;
    }
    assert.ok(!got.some((q) => hidden.has(q)), "쪽마다 따라가도 닫힌 자료의 사건 번호가 안 나온다");
    assert.ok([...open_seqs].every((q) => got.includes(q)), "열린 자료의 사건은 모두 나온다");
  });
});

// ---------------------------------------------------------------------------
// R-B — results.submit 은 닫힌 자료 객체에 판을 못 붙인다 (모르는 것과 같은 404)

const item = (object_id: string) => ({ op: "append_version", object_id, title: "합성 제출", method: "search", verification_state: "unverified" });

for (const kind of KINDS) {
  for (const order of ["v1 deny", "deny 뒤 허용 v2 가 현재 판"] as const) {
    test(`R-B (${kind}, ${order}): 에이전트가 닫힌 자료 객체에 results.submit 하면 모르는 object_id 와 같은 404 — 영수증·사건·판이 안 늘고 id·판 수가 안 나간다`, async () => {
      await with_api(async (env) => {
        const agent = await make_agent(env, "rb", undefined, kind);
        const secret = await material(env, `rb-${kind}`);
        // 닫기 전에 id 를 알았다는 전제(리뷰 probe) — 열려 있을 때 /materials 에서 읽는다.
        const listed = assert_ok(await agent_get(env, agent.token, "/materials")).materials as any[];
        const object_id: string = listed.find((m) => m.object_id === secret.data.object_id).object_id;
        assert_ok(await set_access(env, secret.data.file_policy_id, "deny"));
        if (order === "deny 뒤 허용 v2 가 현재 판") {
          const v2 = await http_blob(env, text_bytes("rb-v2", `OPEN-RB-${kind}`), { name: `공개-rb-v2-${kind}.txt` });
          assert.equal((await upload_material(env, { blob_id: v2.blob_id, object_id })).status, 201);
        }
        const owner_before = assert_ok(await owner_get(env, "/materials")).materials;

        const lease = await agent_claims(env, agent);
        const post = (object_id: string) =>
          call(env, {
            method: "POST",
            path: P(env, `/runs/${lease.run_id}/results`),
            auth: { token: agent.token },
            body: { lease_id: lease.lease_id, fence: lease.fence, results: [item(object_id)] },
          });
        const unknown = await post("no-such-object-0000");
        assert.equal(unknown.status, 404, JSON.stringify(unknown.json));
        const before = counts(env);
        const res = await post(object_id);
        assert.equal(res.status, 404, `닫힌 자료는 모르는 것과 같은 404 이어야 한다: ${res.status} ${JSON.stringify(res.json)}`);
        assert.equal(res.json.error.code, unknown.json.error.code, "같은 error.code");
        assert.ok(!JSON.stringify(res.json).includes("version_no"), "판 수가 안 나간다");
        assert.deepEqual(counts(env), before, "영수증·사건·객체·판 0 개 늘어난다");

        const owner_after = assert_ok(await owner_get(env, "/materials")).materials;
        assert.deepEqual(owner_after, owner_before, "사람 목록은 그대로(현재 판도 안 옮겨졌다)");
      });
    });
  }
}

test("R-B: 두 건짜리 results 중 하나가 닫힌 자료면 묶음 전체가 거절된다 — 한 건도 안 써진다", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "rb2");
    const secret = await material(env, "rb2");
    const open = await material(env, "rb2-open");
    assert_ok(await set_access(env, secret.data.file_policy_id, "deny"));
    const lease = await agent_claims(env, agent);
    const before = counts(env);
    const res = await call(env, {
      method: "POST",
      path: P(env, `/runs/${lease.run_id}/results`),
      auth: { token: agent.token },
      body: { lease_id: lease.lease_id, fence: lease.fence, results: [item(open.data.object_id), item(secret.data.object_id)] },
    });
    assert.equal(res.status, 404, JSON.stringify(res.json));
    assert.deepEqual(counts(env), before, "열린 자료 쪽 판도 안 붙는다(한 묶음 = 한 거래)");
  });
});

/** SEL-127 리뷰 F2-2 — 닫힌 자료 판 id 를 based_on_version_id 로 아는 비사람도 모르는 판 id 와 같은 404·같은 본문을 받는다. */
test("F2-2: 비사람이 열린 자료에 based_on_version_id 로 닫힌 자료 판을 주면 모르는 판 id 와 같은 404·같은 본문 — 쓰기 0", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "f22", undefined, "external_agent");
    const closed = await material(env, "f22-closed");
    const open = await material(env, "f22-open");
    assert_ok(await set_access(env, closed.data.file_policy_id, "deny"));
    const lease = await agent_claims(env, agent);
    const post = (based_on_version_id: string) =>
      call(env, {
        method: "POST",
        path: P(env, `/runs/${lease.run_id}/results`),
        auth: { token: agent.token },
        body: { lease_id: lease.lease_id, fence: lease.fence, results: [{ ...item(open.data.object_id), based_on_version_id }] },
      });
    const unknown = await post("no-such-version-0000");
    assert.equal(unknown.status, 404, JSON.stringify(unknown.json));
    const before = counts(env);
    const res = await post(closed.data.version_id);
    assert.equal(res.status, unknown.status, `닫힌 판은 모르는 판과 같은 상태여야 한다: ${res.status} ${JSON.stringify(res.json)}`);
    // request_id 는 요청마다 새로 나오므로 뺀다. 나머지(format_version·error 전체)는 글자까지 같아야 한다.
    assert.deepEqual({ ...res.json, request_id: undefined }, { ...unknown.json, request_id: undefined }, "닫힌 판과 모르는 판의 응답 본문이 완전히 같아야 한다(request_id 제외)");
    assert.deepEqual(counts(env), before, "영수증·사건·판 0 개 늘어난다");
  });
});

/** SEL-127 리뷰 F2-2 (input-receipts 길) — 닫힌 자료 판 id 를 input_version_id 로 줘도 모르는 id 와 같은 응답이다. */
test("F2-2: 비사람의 input-receipts 에 닫힌 자료 판 id 를 주면 모르는 id 와 같은 응답 — 영수증 0", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "f22r", undefined, "external_agent");
    const closed = await material(env, "f22r-closed");
    assert_ok(await set_access(env, closed.data.file_policy_id, "deny"));
    const lease = await agent_claims(env, agent);
    const post = (input_version_id: string) =>
      call(env, {
        method: "POST",
        path: P(env, `/runs/${lease.run_id}/input-receipts`),
        auth: { token: agent.token },
        body: { lease_id: lease.lease_id, fence: lease.fence, receipts: [{ input_version_id, state: "seen" }] },
      });
    const unknown = await post("no-such-version-0000");
    const before = counts(env);
    const res = await post(closed.data.version_id);
    assert.equal(res.status, unknown.status, `닫힌 판 = 모르는 판 상태: ${res.status} ${JSON.stringify(res.json)}`);
    assert.deepEqual({ ...res.json, request_id: undefined }, { ...unknown.json, request_id: undefined }, "응답 본문 같음(request_id 제외)");
    assert.deepEqual(counts(env), before, "영수증 0 개 늘어난다");
  });
});

// ---------------------------------------------------------------------------
// R-C — 사람용 GET materials 행에 객체 단위 상태 object_ai_access

for (const order of ["deny 먼저, 그 뒤 허용 v2 올리기", "허용 v2 올린 뒤 v1 deny"] as const) {
  test(`R-C (${order}): 사람의 /materials 행 — 현재 판 파일은 allow 여도 object_ai_access 는 "deny"; 열린 자료는 "allow"; allow 로 되돌리면 "allow"`, async () => {
    await with_api(async (env) => {
      const secret = await material(env, "rc");
      const open = await material(env, "rc-open");
      const v2_blob = await http_blob(env, text_bytes("rc-v2", "OPEN-RC-V2"), { name: "공개-rc-v2.txt" });
      const add_v2 = async () => assert.equal((await upload_material(env, { blob_id: v2_blob.blob_id, object_id: secret.data.object_id })).status, 201);
      if (order === "deny 먼저, 그 뒤 허용 v2 올리기") {
        assert_ok(await set_access(env, secret.data.file_policy_id, "deny"));
        await add_v2();
      } else {
        await add_v2();
        assert_ok(await set_access(env, secret.data.file_policy_id, "deny"));
      }
      const row_of = async (path: string, object_id: string) => {
        const data = assert_ok(await owner_get(env, path));
        return (data.materials as any[]).find((m) => m.object_id === object_id);
      };
      for (const path of ["/materials", "/context"]) {
        const s = await row_of(path, secret.data.object_id);
        assert.ok(s, `${path}: 사람은 닫힌 자료를 본다`);
        assert.equal(s.version_no, 2, "현재 판은 v2");
        assert.equal(s.ai_access, "allow", `${path}: 기존 ai_access 는 그 행(v2) 파일의 값 그대로`);
        assert.equal(s.object_ai_access, "deny", `${path}: 객체 단위 상태는 닫힘`);
        const o = await row_of(path, open.data.object_id);
        assert.equal(o.ai_access, "allow");
        assert.equal(o.object_ai_access, "allow");
      }
      assert_ok(await set_access(env, secret.data.file_policy_id, "allow"));
      assert.equal((await row_of("/materials", secret.data.object_id)).object_ai_access, "allow", "allow 로 되돌리면 객체도 allow");
    });
  });
}

test("R-C: 판 하나뿐인 닫힌 자료는 ai_access 와 object_ai_access 가 둘 다 deny", async () => {
  await with_api(async (env) => {
    const m = await material(env, "rc-single");
    assert_ok(await set_access(env, m.data.file_policy_id, "deny"));
    const row = (assert_ok(await owner_get(env, "/materials")).materials as any[]).find((r) => r.object_id === m.data.object_id);
    assert.equal(row.ai_access, "deny");
    assert.equal(row.object_ai_access, "deny");
  });
});

for (const kind of KINDS) {
  test(`R-C (${kind}): AI 가 받는 행에는 object_ai_access 도 ai_access 도 없다 (열린 자료만, 칸 없음)`, async () => {
    await with_api(async (env) => {
      const agent = await make_agent(env, "rc-ai", ["context:read", "file:read"], kind);
      const open = await material(env, `rc-ai-open-${kind}`);
      const secret = await material(env, `rc-ai-secret-${kind}`);
      assert_ok(await set_access(env, secret.data.file_policy_id, "deny"));
      for (const path of ["/materials", "/context"]) {
        const rows = assert_ok(await agent_get(env, agent.token, path)).materials as any[];
        assert.deepEqual(rows.map((r) => r.object_id), [open.data.object_id], `${path}: 열린 자료 하나`);
        assert.ok(!("object_ai_access" in rows[0]) && !("ai_access" in rows[0]), `${path}: 사람 전용 칸이 없다`);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// (4) changes_page 질의 수 — 사건 수에 비례하지 않는다

const QUERY_SLACK = 6;

async function changes_query_count(n_materials: number): Promise<{ queries: number; events: number }> {
  let counting = false;
  let queries = 0;
  let events = 0;
  const wrap = (db: Db): Db => ({
    ...db,
    path: db.path,
    exec: (sql) => db.exec(sql),
    prepare: (sql) => db.prepare(sql),
    run: (sql, ...p) => db.run(sql, ...p),
    get: (sql, ...p) => {
      if (counting) queries += 1;
      return db.get(sql, ...p);
    },
    all: (sql, ...p) => {
      if (counting) queries += 1;
      return db.all(sql, ...p);
    },
    close: () => db.close(),
  });
  await with_api(
    async (env) => {
      const agent = await make_agent(env, "q", ["context:read", "file:read"]);
      for (let i = 0; i < n_materials; i += 1) {
        const m = await material(env, `q${n_materials}-${i}`);
        if (i % 3 === 0) assert_ok(await set_access(env, m.data.file_policy_id, "deny"));
      }
      counting = true;
      const res = await call(env, { method: "GET", path: P(env, "/changes?limit=100"), auth: { token: agent.token } });
      counting = false;
      events = assert_ok(res).events.length;
    },
    { wrap },
  );
  return { queries, events };
}

test("(4) changes_page: 자료 4건과 24건(셋 중 하나는 deny)일 때 GET changes 의 DB 질의 수 차이가 상수(QUERY_SLACK) 이하 — 사건마다 따로 묻지 않는다", async () => {
  const small = await changes_query_count(4);
  const large = await changes_query_count(24);
  assert.ok(large.events > small.events, `사건이 더 많이 나간다(${small.events} → ${large.events})`);
  assert.ok(large.queries <= small.queries + QUERY_SLACK, `질의 수 ${small.queries} → ${large.queries}: 사건 수에 비례해 늘면 안 된다 (허용 차이 ${QUERY_SLACK})`);
});

function assert_no_wire_trace(text: string, needles: string[]): void {
  for (const needle of needles) assert.ok(!text.includes(needle), `"${needle}" must not appear`);
}
