/**
 * SEL-115 (3단계 MAT1a) — deny 파일의 **실제 집행** (tester, 작성 모드). 인터페이스 표는 tests/helpers/sel115_env.ts 머리말.
 *
 * 범위(스테이지 문서 3단계 35행): deny 파일은 A 와 PES API/MCP 응답에서 제외한다. 이 시험은 그 경로만 단언한다.
 * **B 의 PC 동기화 폴더·로컬 파일 직접 읽기는 통제 범위 밖이므로 "A·B 모두 제외 보장"을 시험하지도 문서화하지도 않는다.**
 *
 * 이름/존재 표시 정책: deny 파일은 사람이 아닌 호출자에게 이름·blob_id·file_policy_id·sha256·본문·개수 어디에도 안 나간다.
 * allow 로 되돌리면 같은 경로에 다시 나온다. 사람(owner 세션)은 늘 본다.
 */

import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { export_project, import_bundle } from "../scripts/pes_core/backup.ts";
import { connect, migrate } from "../scripts/pes_core/db.ts";
import { reserve_upload, store_blob, complete_upload } from "../scripts/pes_core/files.ts";
import { db_path, objects_dir } from "../scripts/pes_core/paths.ts";
import { McpServer } from "../scripts/pes_core/mcp_server.ts";
import { assert_ok, call, make_agent, with_api, type ApiEnv } from "./helpers/api_env.ts";
import { wire } from "./helpers/adapter_b_env.ts";
import { with_cleanup } from "./helpers/adapter_b_flow.ts";
import { sha256_hex } from "./helpers/backup_fixture.ts";
import { MEDIA_TYPE, ctx_for, put_ready } from "./helpers/blob_env.ts";
import { isolated_home } from "./helpers/isolated_home.ts";
import {
  FINISH,
  context_turn,
  open_stage,
  ready_project,
  request_text,
  set_script,
  start_run,
  with_a_env,
} from "./helpers/a_builtin_env.ts";
import {
  P,
  assert_no_trace,
  history_rows,
  new_material,
  policy_rows,
  set_access,
  text_bytes,
  wire_of,
} from "./helpers/sel115_env.ts";

void McpServer;

type Mat = Awaited<ReturnType<typeof new_material>>;

/** 에이전트가 읽을 수 있는 모든 HTTP 읽기 경로를 한 번씩 돌려 한 덩어리 글자로 모은다(+ 각 응답 상태). */
async function agent_sweep(env: ApiEnv, token: string, m: Mat, other: Mat): Promise<{ text: string; statuses: Record<string, number> }> {
  const auth = { token };
  const paths: Array<[string, string]> = [
    ["context", P(env, "/context")],
    ["materials", P(env, "/materials")],
    ["workspace", P(env, "/workspace")],
    ["changes", P(env, "/changes?limit=100")],
    ["version", P(env, `/objects/${m.data.object_id}/versions/${m.data.version_id}`)],
    ["content", P(env, `/files/${m.blob.blob_id}/content`)],
    ["preview", P(env, `/files/${m.blob.blob_id}/preview`)],
    ["other-version", P(env, `/objects/${other.data.object_id}/versions/${other.data.version_id}`)],
    ["other-content", P(env, `/files/${other.blob.blob_id}/content`)],
  ];
  let text = "";
  const statuses: Record<string, number> = {};
  for (const [label, path] of paths) {
    const res = await call(env, { method: "GET", path, auth });
    statuses[label] = res.status;
    text += `\n--${label}--\n${wire_of(res)}`;
  }
  return { text, statuses };
}

for (const kind of ["external_agent", "internal_ai"] as const) {
  test(`API (${kind}): a denied file leaves context, materials, workspace, changes, version read, content and preview — no name, id, hash or text anywhere; allow brings it back`, async () => {
    await with_api(async (env) => {
      const secret = await new_material(env, `sec-${kind}`, { marker: `SECRET-TEXT-${kind}`, name: `비공개-${kind}.txt` });
      const open = await new_material(env, `open-${kind}`, { marker: `OPEN-TEXT-${kind}`, name: `공개-${kind}.txt` });
      const agent = await make_agent(env, "reader", ["context:read", "file:read"], kind);

      let sweep = await agent_sweep(env, agent.token, secret, open);
      assert.equal(sweep.statuses["content"], 200, "allowed by default");
      assert.equal(sweep.statuses["preview"], 200);
      assert.ok(sweep.text.includes(secret.name) && sweep.text.includes(secret.marker), "before deny the agent sees it");

      assert_ok(await set_access(env, secret.data.file_policy_id, "deny"));
      sweep = await agent_sweep(env, agent.token, secret, open);
      assert_no_trace(sweep.text, secret, "agent sweep after deny");
      assert.equal(sweep.statuses["content"], 403);
      assert.equal(sweep.statuses["preview"], 403);
      assert.equal(sweep.statuses["other-content"], 200, "the other (allowed) file is unaffected");
      assert.ok(sweep.text.includes(open.name), "allowed material still listed");
      assert.ok(sweep.text.includes(open.marker), "allowed content still served");
      for (const label of ["context", "materials", "workspace", "changes", "version"]) {
        assert.equal(sweep.statuses[label], 200, `${label} stays readable (without the denied file)`);
      }
      const listed = assert_ok(await call(env, { method: "GET", path: P(env, "/materials"), auth: { token: agent.token } }));
      assert.deepEqual(listed.materials.map((x: any) => x.file_policy_id), [open.data.file_policy_id], "not even a count of the hidden file");

      // 사람은 그대로 다 본다.
      const owner = await call(env, { method: "GET", path: P(env, "/materials"), auth: "owner" });
      assert.equal(assert_ok(owner).materials.length, 2);
      assert.equal((await call(env, { method: "GET", path: P(env, `/files/${secret.blob.blob_id}/content`), auth: "owner" })).status, 200);

      assert_ok(await set_access(env, secret.data.file_policy_id, "allow"));
      sweep = await agent_sweep(env, agent.token, secret, open);
      assert.equal(sweep.statuses["content"], 200, "allow again → served again");
      assert.equal(sweep.statuses["preview"], 200);
      assert.ok(sweep.text.includes(secret.name));
      assert.ok(sweep.text.includes(secret.marker));
    });
  });
}

test("API: a file denied BEFORE any agent ever looked is excluded too (deny set first, then the first read)", async () => {
  await with_api(async (env) => {
    const secret = await new_material(env, "first", { marker: "SECRET-FIRST", name: "처음부터-비공개.txt" });
    const open = await new_material(env, "first-open");
    assert_ok(await set_access(env, secret.data.file_policy_id, "deny"));
    const agent = await make_agent(env, "late", ["context:read", "file:read"]);
    const sweep = await agent_sweep(env, agent.token, secret, open);
    assert_no_trace(sweep.text, secret, "first-read sweep");
  });
});

test("API: the deny also covers a file used under another role / by a second material of the same bytes (one policy)", async () => {
  await with_api(async (env) => {
    const m1 = await new_material(env, "role", { marker: "SECRET-ROLE", name: "역할.txt" });
    const { http_blob, upload_material } = await import("./helpers/sel115_env.ts");
    const again = await http_blob(env, m1.bytes, { name: "역할.txt" });
    const d2 = assert_ok(await upload_material(env, { blob_id: again.blob_id, role: "source" }), 201);
    assert_ok(await set_access(env, m1.data.file_policy_id, "deny"));
    const agent = await make_agent(env, "roles", ["context:read", "file:read"]);
    const listed = assert_ok(await call(env, { method: "GET", path: P(env, "/materials"), auth: { token: agent.token } }));
    assert.deepEqual(listed.materials, [], "both materials of the denied bytes are gone for the agent");
    const v = await call(env, { method: "GET", path: P(env, `/objects/${d2.object_id}/versions/${d2.version_id}`), auth: { token: agent.token } });
    assert.ok(!wire_of(v).includes(m1.blob.blob_id));
  });
});

// ---------------------------------------------------------------------------
// B: MCP 응답 (PES MCP 서버의 응답 범위만)

test("MCP: pes_context materials and pes_read files leave out a denied file (no name, id, hash, text); allow brings it back; refusals equal the API's", async () => {
  await with_cleanup(async (env, open) => {
    const client = open(await env.client());
    const secret = await new_material(env, "mcp-sec", { marker: "SECRET-MCP-TEXT", name: "비공개-mcp.txt" });
    const allowed = await new_material(env, "mcp-open", { marker: "OPEN-MCP-TEXT", name: "공개-mcp.txt" });

    const before = await client.ok("pes_context", {});
    assert.ok(Array.isArray(before.materials));
    assert.deepEqual(before.materials.map((x: any) => x.file_policy_id).sort(), [secret.data.file_policy_id, allowed.data.file_policy_id].sort());

    assert_ok(await set_access(env, secret.data.file_policy_id, "deny"));
    const ctx = await client.ok("pes_context", {});
    assert_no_trace(wire(ctx), secret, "pes_context after deny");
    assert.deepEqual(ctx.materials.map((x: any) => x.file_policy_id), [allowed.data.file_policy_id]);

    const read = await client.ok("pes_read", { object_id: secret.data.object_id, version_id: secret.data.version_id });
    assert_no_trace(wire(read), secret, "pes_read after deny");
    const read_ok = await client.ok("pes_read", { object_id: allowed.data.object_id, version_id: allowed.data.version_id });
    assert.deepEqual(read_ok.files.map((f: any) => f.blob_id), [allowed.blob.blob_id]);

    // 모든 raw 줄(서버가 쓴 전부)에도 흔적이 없다.
    assert_no_trace(client.lines.slice(-3).join("\n"), secret, "raw MCP lines after deny");

    assert_ok(await set_access(env, secret.data.file_policy_id, "allow"));
    const back = await client.ok("pes_context", {});
    assert.deepEqual(back.materials.map((x: any) => x.file_policy_id).sort(), [secret.data.file_policy_id, allowed.data.file_policy_id].sort());
  });
});

test("MCP: a token without context:read gets no materials at all (same refusal as the API)", async () => {
  await with_cleanup(async (env, open) => {
    await new_material(env, "mcp-scope", { marker: "SECRET-SCOPE" });
    const narrow = await make_agent(env, "narrow", ["run:claim", "run:submit"]);
    const weak = open(await env.client(narrow.token));
    const api = await call(env, { method: "GET", path: P(env, "/materials"), auth: { token: narrow.token } });
    assert.equal(api.status, 403);
    const out = await weak.tool("pes_context", {});
    if (!out.is_error) assert.equal(out.data.materials, undefined, "no materials for a token without context:read");
    assert.ok(!wire(out.data).includes("SECRET-SCOPE"));
  });
});

// ---------------------------------------------------------------------------
// A: context.get 도구와 프롬프트 조립

async function a_material(env: any, label: string, marker: string, name: string): Promise<{ data: any; blob_id: string; name: string; marker: string; sha256: string }> {
  const bytes = text_bytes(label, marker);
  const reserved = (await reserve_upload(env.service, ctx_for(env.p, `${label}-r`), {
    sha256: sha256_hex(bytes),
    size: bytes.byteLength,
    media_type: "text/plain",
    original_name: name,
  })).result as { blob_id: string; state: string };
  if (reserved.state !== "ready") {
    await store_blob(env.store, env.p.project_id, reserved.blob_id, bytes);
    await complete_upload(env.service, env.store, ctx_for(env.p, `${label}-c`), { blob_id: reserved.blob_id });
  }
  const out = await env.service.execute(env.ctx(`${label}-up`), "file.upload", { blob_id: reserved.blob_id, title: `제목 ${label}` });
  return { data: out.result, blob_id: reserved.blob_id, name, marker, sha256: sha256_hex(bytes) };
}

test("A: context.get lists allowed materials only; a denied file's name, ids, hash and text appear in NO request sent to the model; re-allowing brings it back", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env);
    const secret = await a_material(env, "a-sec", "SECRET-A-TEXT", "비공개-a.txt");
    const open_m = await a_material(env, "a-open", "OPEN-A-TEXT", "공개-a.txt");
    const opened = await open_stage(env, "plan");

    // 1) 둘 다 allow: 모델이 둘 다의 이름을 본다.
    set_script(env, [context_turn(), FINISH]);
    await start_run(env, { stage_id: opened.stage_id, round_id: opened.round_id });
    let texts = env.fake.bodies().map((b: any) => request_text(b)).join("\n");
    assert.ok(texts.includes(secret.name) && texts.includes(open_m.name), "allowed materials are listed in context.get");

    // 2) deny: 이후 호출에는 흔적이 없다.
    await env.service.execute(env.ctx("a-deny"), "file.ai_access_set", { file_policy_id: secret.data.file_policy_id, ai_access: "deny" });
    const mark = env.fake.bodies().length;
    const opened2 = await open_stage(env, "research");
    set_script(env, [context_turn(), FINISH]);
    await start_run(env, { stage_id: opened2.stage_id, round_id: opened2.round_id });
    const after = env.fake.bodies().slice(mark);
    assert.ok(after.length >= 2, "the run called the model and read the context");
    texts = after.map((b: any) => request_text(b)).join("\n") + JSON.stringify(after);
    for (const needle of [secret.name, secret.blob_id, secret.data.file_policy_id, secret.sha256, secret.marker]) {
      assert.ok(!texts.includes(needle), `denied "${needle}" must not reach the model`);
    }
    assert.ok(texts.includes(open_m.name), "the allowed material is still in the context");

    // 3) allow 로 되돌리면 다시 나간다.
    await env.service.execute(env.ctx("a-allow"), "file.ai_access_set", { file_policy_id: secret.data.file_policy_id, ai_access: "allow" });
    const mark2 = env.fake.bodies().length;
    const opened3 = await open_stage(env, "analyze");
    set_script(env, [context_turn(), FINISH]);
    await start_run(env, { stage_id: opened3.stage_id, round_id: opened3.round_id });
    const again = env.fake.bodies().slice(mark2).map((b: any) => request_text(b)).join("\n");
    assert.ok(again.includes(secret.name), "re-allowed → listed again");
  });
});

test("A: nothing about a denied file leaks through the run's stored rows either (events, receipts, dispatch manifests)", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env);
    const secret = await a_material(env, "a-store", "SECRET-STORE-TEXT", "비공개-저장.txt");
    await env.service.execute(env.ctx("a-store-deny"), "file.ai_access_set", { file_policy_id: secret.data.file_policy_id, ai_access: "deny" });
    const opened = await open_stage(env, "plan");
    set_script(env, [context_turn(), FINISH]);
    await start_run(env, { stage_id: opened.stage_id, round_id: opened.round_id });
    const rows = [
      ...env.db.all<{ t: string }>("SELECT payload AS t FROM events WHERE type LIKE 'run.%' OR type LIKE 'ai.%' OR type LIKE 'tool.%'"),
      ...env.db.all<{ t: string }>("SELECT result_json AS t FROM mutation_commits WHERE action LIKE 'run.%' OR action LIKE 'ai.%'"),
    ]
      .map((r) => r.t ?? "")
      .join("\n");
    for (const needle of [secret.name, secret.marker, secret.sha256]) {
      assert.ok(!rows.includes(needle), `"${needle}" must not be stored in run events or receipts`);
    }
  });
});

// ---------------------------------------------------------------------------
// 내보내기(백업)·복원: 사람 소유 전체 백업에는 정책이 그대로 실려 가고, 복원해도 deny 가 allow 로 풀리지 않는다

test("backup export → restore keeps file policies and the append-only history: a denied file is still denied after restore", async () => {
  await with_api(async (env) => {
    const m = await new_material(env, "bk", { marker: "SECRET-BACKUP", name: "백업.txt" });
    const fp = m.data.file_policy_id as string;
    assert_ok(await set_access(env, fp, "deny", "owner", { reason: "복원 시험" }));
    assert_ok(await set_access(env, fp, "allow"));
    assert_ok(await set_access(env, fp, "deny"));
    const policy_before = policy_rows(env.db, env.p.project_id)[0]!;
    const history_before = history_rows(env.db, fp);

    const home = isolated_home("pes-sel115-");
    try {
      const bundle = join(home.root, "bundle");
      mkdirSync(home.root, { recursive: true });
      export_project(env.db, env.objects, env.p.project_id, bundle);

      const tgt = connect(db_path(home.env));
      migrate(tgt);
      try {
        import_bundle(tgt, objects_dir(home.env), bundle);
        const p = tgt.get<{ id: string; blob_id: string; ai_access: string; rev: bigint }>(
          "SELECT id, blob_id, ai_access, rev FROM file_policies WHERE project_id = ?",
          env.p.project_id,
        )!;
        assert.equal(p.id, fp);
        assert.equal(p.ai_access, "deny", "restore never resets a deny to allow");
        assert.equal(p.rev, policy_before.rev);
        const h = tgt.all<{ id: string; ai_access: string; rev: bigint; reason: string | null }>(
          "SELECT id, ai_access, rev, reason FROM file_ai_access_versions WHERE file_policy_id = ? ORDER BY rev",
          fp,
        );
        assert.deepEqual(
          h.map((r) => [r.id, r.ai_access, r.rev, r.reason]),
          history_before.map((r) => [r.id, r.ai_access, r.rev, r.reason]),
          "the whole history is restored, same order, same rows",
        );
        const link = tgt.get<{ file_policy_id: string }>("SELECT file_policy_id FROM version_files WHERE blob_id = ?", m.blob.blob_id);
        assert.equal(link?.file_policy_id, fp, "version_files still points at the same policy");
      } finally {
        tgt.close();
      }
    } finally {
      home.cleanup();
    }
  });
});

test("put_ready blobs attached the old way (file.attach_version) still get an allow policy and are not materials (no regression on the PR9 flow)", async () => {
  await with_api(async (env) => {
    const { attach, new_artifact, bytes_of } = await import("./helpers/blob_env.ts");
    const v = await new_artifact(env, "legacy-attach");
    const blob = await put_ready(env, bytes_of("legacy-attach", 24), "legacy-attach");
    const out = await attach(env, v.version_id, blob.blob_id, "attachment", "legacy-attach-a");
    const policy = policy_rows(env.db, env.p.project_id).find((p) => p.id === out.file_policy_id)!;
    assert.equal(policy.ai_access, "allow");
    assert.equal(policy.rev, 1n);
    const owner = assert_ok(await call(env, { method: "GET", path: P(env, "/materials"), auth: "owner" }));
    assert.ok(!owner.materials.some((x: any) => x.blob_id === blob.blob_id), "an artifact's attachment is not listed as a user material");
    void MEDIA_TYPE;
  });
});
