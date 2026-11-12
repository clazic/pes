/**
 * SEL-119 U6a — 최종 리뷰(F1) 필수 7건 수정 시험. 합성 데이터만, 실제 모델·네트워크 호출 없음.
 * 각 시험은 리뷰의 합성 재현을 그대로 옮겼고, 고치기 전에 실패해야 한다.
 *
 *  F1-1  인쇄 파생 blob(출력·manifest)을 GET files/{b}/content·preview 로 바로 읽어 AI 금지를 우회하지 못한다:
 *        비사람이 읽을 때 그 blob 을 쓰는 인쇄의 현재 AI 판정(print_ai_view)을 다시 본다. 금지 뒤 → 403.
 *  F1-2  print.commit 이 롤백된 뒤의 파일 정리는 쓰기 잠금 안에서, 지금 어떤 blob 행도 그 파일을 쓰지 않을 때만 지운다.
 *        (별도 SQLite 연결 둘: A 의 ROLLBACK 직후·정리 직전에 B 가 같은 내용을 인쇄해 성공하면 B 의 파일은 남는다.)
 *  F1-3  AI manifest 필터가 reflection 의 금지 자료 버전과 excluded 의 금지 산출물 id 를 남기지 않는다.
 *  F1-4  고른 범위의 실제 첨언(스레드·메시지·anchor 상태)이 manifest 와 출력에 실리고, 뒤에 바뀌어도 고정본은 그대로다.
 *  F1-5  본문 blob 을 못 읽거나 sha256·크기가 다르면 인쇄 commit 이 거절된다(빈 본문으로 성공하지 않는다).
 *  F1-6  보존 중인 인쇄의 출력 blob 은 linked: file.quarantine 이 거절한다.
 *  F1-7  인쇄 snapshot 은 참고자료의 '최신 고정본' 고르기에 섞이지 않고, 인쇄 id 를 직접 고르는 것도 거절된다.
 */

import assert from "node:assert/strict";
import { unlinkSync } from "node:fs";
import { test } from "node:test";

import { CommandService } from "../scripts/pes_core/commands.ts";
import { add_citation } from "../scripts/pes_core/content.ts";
import { connect, type Db } from "../scripts/pes_core/db.ts";
import { get_blob } from "../scripts/pes_core/files.ts";
import { reference_caller, reference_content, reference_row, reference_view } from "../scripts/pes_core/references.ts";
import { assert_ok, call, make_agent, with_api, type ApiEnv } from "./helpers/api_env.ts";
import { wire } from "./helpers/adapter_b_env.ts";
import { with_cleanup } from "./helpers/adapter_b_flow.ts";
import { FINISH, context_turn, open_stage, ready_project, request_text, set_script, start_run, with_a_env } from "./helpers/a_builtin_env.ts";
import { blob_row, ctx_for, disk_path, list_files, put_ready, rejects_any, rejects_api, with_env, type Env } from "./helpers/blob_env.ts";
import { start } from "./helpers/editions_env.ts";
import { P, new_material, set_access, wire_of } from "./helpers/sel115_env.ts";
import { grant_access, make_source } from "./helpers/sel113_env.ts";
import { art, items_of, more, ok, stage_of, stored_html, stored_manifest } from "./helpers/sel119_env.ts";
import { cp_find } from "./helpers/sel99_env.ts";

const SECRET_QUOTE = "비공개발췌-F1-77ab";

async function scene(env: Env, tag: string, body_md = `공개본문-${tag}`) {
  const plan = stage_of(env, "plan");
  const round = await start(env, plan, `${tag}-start`);
  const body = await art(env, `${tag}-body`, { stage_id: plan, body_md, title: `공개제목-${tag}` });
  return { plan, round, body };
}

const owner_commit = async (env: ApiEnv, payload: Record<string, unknown>, key: string) =>
  assert_ok(await call(env, { method: "POST", path: P(env, "/print/commit"), auth: "owner", body: payload, key }), 201);

// ---------------------------------------------------------------------------
// F1-1

test("F1-1 a stored print's output and manifest blobs are not a way around the AI decision (content and preview)", async () => {
  await with_api(async (env) => {
    const s = await scene(env, "f1");
    const secret = await new_material(env, "f1", { name: "비공개파일-f1.txt", extra: { title: "비공개제목-f1" } });
    await add_citation(env.service, env.ctx("f1-cite"), { artifact_version_id: s.body.version_id, source_version_id: secret.data.version_id, quote: SECRET_QUOTE });
    const done = await owner_commit(env, { scope: "round", round_id: s.round.round_id }, "f1-commit");
    const agent = await make_agent(env, "f1-reader", ["context:read", "file:read"]);

    // allowed: the agent reads the print normally and learns the output id
    const first = await call(env, { method: "GET", path: P(env, `/print?scope=round&snapshot=${done.snapshot_id}`), auth: { token: agent.token } });
    assert.equal(first.status, 200);
    const output_id = first.json.data.output.blob_id as string;
    assert.equal(output_id, done.output_blob_id);
    const before = await call(env, { method: "GET", path: P(env, `/files/${output_id}/content`), auth: { token: agent.token } });
    assert.equal(before.status, 200, "while allowed the derived file reads as before");

    assert_ok(await set_access(env, secret.data.file_policy_id, "deny"));
    const print = await call(env, { method: "GET", path: P(env, `/print?scope=round&snapshot=${done.snapshot_id}`), auth: { token: agent.token } });
    assert.equal(print.json.data.document, null);
    for (const [blob_id, what] of [
      [output_id, "output"],
      [done.manifest_blob_id as string, "manifest"],
    ] as const) {
      for (const route of ["content", "preview"]) {
        const raw = await call(env, { method: "GET", path: P(env, `/files/${blob_id}/${route}`), auth: { token: agent.token } });
        assert.equal(raw.status, 403, `${what} ${route}: an agent must not read a print blob that carries a closed material`);
        const text = raw.bytes === null ? JSON.stringify(raw.json) : new TextDecoder().decode(raw.bytes);
        assert.ok(!text.includes(SECRET_QUOTE) && !text.includes("비공개제목-f1") && !text.includes(secret.data.object_id), `${what} ${route}: no closed fact`);
      }
    }
    // the human still reads the stored bytes
    const human = await call(env, { method: "GET", path: P(env, `/files/${output_id}/content`), auth: "owner" });
    assert.equal(human.status, 200);
    assert.ok(new TextDecoder().decode(human.bytes!).includes(SECRET_QUOTE));
    // allow again: the agent reads it again
    assert_ok(await set_access(env, secret.data.file_policy_id, "allow"));
    const back = await call(env, { method: "GET", path: P(env, `/files/${output_id}/content`), auth: { token: agent.token } });
    assert.equal(back.status, 200);
  });
});

// ---------------------------------------------------------------------------
// F1-2

test("F1-2 cleanup after a rolled back print never deletes a file another connection's committed print now uses", async () => {
  await with_env(async (env) => {
    const s = await scene(env, "f2");
    const payload = { scope: "round", round_id: s.round.round_id };
    const raw_a = connect(env.db.path);
    let rolled = false;
    let second: Record<string, any> | null = null;
    let files_before_cleanup = 0;
    const a_db: Db = {
      path: raw_a.path,
      exec: (sql) => {
        raw_a.exec(sql);
        if (sql === "ROLLBACK" && !rolled) {
          rolled = true;
          // the write lock is free: B (the other connection) prints the same selection now, before A's cleanup
          second = env.service.execute_sync(env.ctx("f2-b"), "print.commit", payload).result as Record<string, any>;
          files_before_cleanup = list_files(env.objects).length;
        }
      },
      prepare: (sql) => raw_a.prepare(sql),
      run: (sql, ...params) => {
        if (/INSERT INTO events/i.test(sql)) throw new Error("synthetic failure at the event insert");
        return raw_a.run(sql, ...params);
      },
      get: (sql, ...params) => raw_a.get(sql, ...params),
      all: (sql, ...params) => raw_a.all(sql, ...params),
      close: () => raw_a.close(),
    };
    try {
      const service_a = new CommandService(a_db, { clock: env.clock, policy: env.policy, objects_dir: env.objects });
      await rejects_any(service_a.execute(env.ctx("f2-a"), "print.commit", payload));
      assert.ok(rolled && second !== null, "B committed between A's rollback and A's cleanup");
      const b = second as Record<string, any>;
      assert.equal(env.db.get<{ c: bigint }>("SELECT count(*) AS c FROM snapshots WHERE id = ?", b.snapshot_id)?.c, 1n);
      assert.ok(files_before_cleanup >= 2);
      for (const blob_id of [b.output_blob_id, b.manifest_blob_id]) {
        const read = await get_blob(env.store, env.p.project_id, blob_id);
        assert.ok(read.bytes.byteLength > 0, `B's blob ${blob_id} is still readable after A's cleanup`);
      }
    } finally {
      raw_a.close();
    }
  });
});

// ---------------------------------------------------------------------------
// F1-3

test("F1-3a a reflection whose source is a closed material is left out of an agent's print view, and the document is withheld", async () => {
  await with_api(async (env) => {
    const s = await scene(env, "f3a");
    const secret = await new_material(env, "f3a", { name: "비공개파일-f3a.txt", extra: { title: "비공개제목-f3a" } });
    await ok(env, env.ctx("f3a-rf"), "reflection.create", {
      target_round_id: s.round.round_id,
      entries: [{ source_version_id: secret.data.version_id, disposition: "rejected", rationale: "반영 안 함-f3a" }],
    });
    assert_ok(await set_access(env, secret.data.file_policy_id, "deny"));
    const done = await owner_commit(env, { scope: "round", round_id: s.round.round_id }, "f3a-commit");
    const agent = await make_agent(env, "f3a-reader", ["context:read"]);
    const res = await call(env, { method: "GET", path: P(env, `/print?scope=round&snapshot=${done.snapshot_id}`), auth: { token: agent.token } });
    assert.equal(res.status, 200);
    const wire = wire_of(res);
    for (const needle of [secret.data.version_id, secret.data.object_id, "반영 안 함-f3a"]) assert.ok(!wire.includes(needle), `"${needle}" must not appear`);
    assert.equal(res.json.data.document, null);
    assert.deepEqual(res.json.data.withheld, { reason: "ai_reference_denied" });
    assert.equal(res.json.data.manifest.items.filter((i: any) => i.category === "reflection").length, 0);
  });
});

test("F1-3b an excluded draft that carries a closed file is not named in an agent's print view", async () => {
  await with_api(async (env) => {
    const s = await scene(env, "f3b");
    const draft = await art(env, "f3b-draft", { stage_id: s.plan, body_md: "초안본문-f3b", title: "초안제목-f3b", status: "draft" });
    const secret = await new_material(env, "f3b", { name: "비공개파일-f3b.txt" });
    await ok(env, env.ctx("f3b-attach"), "file.attach_version", { version_id: draft.version_id, blob_id: secret.blob.blob_id, role: "attachment" });
    assert_ok(await set_access(env, secret.data.file_policy_id, "deny"));
    const done = await owner_commit(env, { scope: "round", round_id: s.round.round_id }, "f3b-commit");
    const human = await call(env, { method: "GET", path: P(env, `/print?scope=round&snapshot=${done.snapshot_id}`), auth: "owner" });
    assert.ok(wire_of(human).includes(draft.object_id), "the human manifest records the draft as excluded");
    const agent = await make_agent(env, "f3b-reader", ["context:read"]);
    const res = await call(env, { method: "GET", path: P(env, `/print?scope=round&snapshot=${done.snapshot_id}`), auth: { token: agent.token } });
    assert.equal(res.status, 200);
    assert.ok(!wire_of(res).includes(draft.object_id), "closed draft object id");
    assert.ok(!wire_of(res).includes(draft.version_id), "closed draft version id");
    // nothing closed is in the printed document itself: the agent still gets it
    assert.equal(typeof res.json.data.document, "string");
  });
});

// ---------------------------------------------------------------------------
// F1-4

test("F1-4 the chosen comments are printed: threads, replies and a lost anchor are fixed in the manifest and the document", async () => {
  await with_env(async (env) => {
    const BODY = "첫 문단에는 확인할 문장-오메가 이 있다.";
    const s = await scene(env, "f4", BODY);
    const note = await ok(env, env.ctx("f4-note"), "annotation.create", {
      target_object_id: s.body.object_id,
      anchor: { exact_quote: "확인할 문장-오메가", ...cp_find(BODY, "확인할 문장-오메가") },
      body_md: "근거를 보태 주세요-첨언1",
    });
    await ok(env, env.ctx("f4-reply"), "thread.reply", { thread_id: note.thread_id, body_md: "보탰습니다-답글1" });
    // a second body whose anchored text is gone in the printed version: the anchor is lost, and it is shown, not hidden
    const LOST = "사라질 문장-시그마 은 여기 있다.";
    const other = await art(env, "f4-other", { stage_id: s.plan, body_md: LOST, title: "다른제목-f4" });
    const lost_note = await ok(env, env.ctx("f4-lost"), "annotation.create", {
      target_object_id: other.object_id,
      anchor: { exact_quote: "사라질 문장-시그마", ...cp_find(LOST, "사라질 문장-시그마") },
      body_md: "잃을 첨언-첨언2",
    });
    // the printed (current) version of the other body no longer has the anchored text
    await more(env, "f4-v2", other.object_id, { title: "다른제목-f4", body_md: "전혀 다른 글이다.", current: true });

    const done = await ok(env, env.ctx("f4-commit"), "print.commit", { scope: "round", round_id: s.round.round_id, include: ["body", "comment"] });
    const m = stored_manifest(env, done.snapshot_id);
    const comments = items_of(m, "comment");
    assert.ok(comments.length >= 3, `three messages are printed, got ${JSON.stringify(comments)}`);
    assert.ok(comments.every((c) => typeof c.thread_id === "string" && typeof c.version_id === "string" && typeof c.object_id === "string"));
    assert.ok(comments.some((c) => c.thread_id === note.thread_id));
    assert.ok(comments.some((c) => c.thread_id === lost_note.thread_id));
    assert.equal(m.comments.included, true);
    assert.deepEqual(m.comments.items, comments, "the comments slot carries the same entries");
    const html = stored_html(env, m);
    assert.match(html, /근거를 보태 주세요-첨언1/);
    assert.match(html, /보탰습니다-답글1/);
    assert.match(html, /잃을 첨언-첨언2/);
    assert.ok(comments.some((c) => c.thread_id === lost_note.thread_id && c.anchor_status === "lost"), "the lost anchor is recorded as lost");
    assert.ok(comments.some((c) => c.thread_id === note.thread_id && c.anchor_status === "exact"));

    // a later reply does not change the stored print
    await ok(env, env.ctx("f4-reply2"), "thread.reply", { thread_id: note.thread_id, body_md: "나중답글-답글2" });
    assert.equal(stored_html(env, stored_manifest(env, done.snapshot_id)), html);
    assert.doesNotMatch(html, /나중답글-답글2/);

    // comment not chosen: recorded as not_selected, nothing printed
    const none = stored_manifest(env, (await ok(env, env.ctx("f4-nc"), "print.commit", { scope: "round", round_id: s.round.round_id, include: ["body"] })).snapshot_id);
    assert.equal(items_of(none, "comment").length, 0);
    assert.ok(none.excluded.some((e: any) => e.category === "comment" && e.reason === "not_selected"));
    assert.doesNotMatch(stored_html(env, none), /근거를 보태 주세요-첨언1/);
  });
});

// ---------------------------------------------------------------------------
// F1-5

test("F1-5 a body file that cannot be read, or whose bytes do not match, refuses the print instead of printing an empty body", async () => {
  await with_env(async (env) => {
    const s = await scene(env, "f5");
    const blob = await put_ready(env, new TextEncoder().encode("파일본문-f5 문단"), "f5-blob");
    env.db.run("UPDATE artifact_versions SET body_md = NULL, body_blob_id = ? WHERE version_id = ?", blob.blob_id, s.body.version_id);
    const first = await ok(env, env.ctx("f5-a"), "print.commit", { scope: "round", round_id: s.round.round_id });
    assert.match(stored_html(env, stored_manifest(env, first.snapshot_id)), /파일본문-f5 문단/);

    const row = blob_row(env.db, blob.blob_id)!;
    unlinkSync(disk_path(env, row));
    const before = env.db.get<{ c: bigint }>("SELECT count(*) AS c FROM snapshots")!.c;
    await rejects_api(env.service.execute(env.ctx("f5-b"), "print.commit", { scope: "round", round_id: s.round.round_id, selection_hash: first.selection_hash }), "conflict");
    await rejects_api(env.service.execute(env.ctx("f5-p"), "print.prepare", { scope: "round", round_id: s.round.round_id }), "conflict");
    assert.equal(env.db.get<{ c: bigint }>("SELECT count(*) AS c FROM snapshots")!.c, before, "no print snapshot was written");
  });
});

test("F1-5b a body file whose recorded sha256/size does not match its bytes refuses the print", async () => {
  await with_env(async (env) => {
    const s = await scene(env, "f5b");
    const blob = await put_ready(env, new TextEncoder().encode("원래본문-f5b"), "f5b-blob");
    env.db.run("UPDATE artifact_versions SET body_md = NULL, body_blob_id = ? WHERE version_id = ?", blob.blob_id, s.body.version_id);
    const row = blob_row(env.db, blob.blob_id)!;
    const { writeFileSync } = await import("node:fs");
    writeFileSync(disk_path(env, row), "바뀐본문-f5b!!");
    await rejects_api(env.service.execute(env.ctx("f5b-c"), "print.commit", { scope: "round", round_id: s.round.round_id }), "conflict");
  });
});

// ---------------------------------------------------------------------------
// F1-6

test("F1-6 the output blob of a stored print is linked: quarantine refuses it and the print still reads", async () => {
  await with_api(async (env) => {
    const s = await scene(env, "f6");
    const done = await owner_commit(env, { scope: "round", round_id: s.round.round_id }, "f6-commit");
    // the same selection printed twice shares the output bytes (dedupe): both prints are protected
    const again = await owner_commit(env, { scope: "round", round_id: s.round.round_id }, "f6-commit-2");
    assert.equal(again.output_blob_id, done.output_blob_id);
    await rejects_api(env.service.execute(env.ctx("f6-q"), "file.quarantine", { blob_id: done.output_blob_id, reason: "synthetic quarantine" }), "conflict");
    await rejects_api(env.service.execute(env.ctx("f6-q2"), "file.quarantine", { blob_id: done.manifest_blob_id, reason: "synthetic quarantine" }), "conflict");
    const res = await call(env, { method: "GET", path: P(env, `/print?scope=round&snapshot=${done.snapshot_id}`), auth: "owner" });
    assert.equal(res.status, 200);
    assert.equal(typeof res.json.data.document, "string");
  });
});

// ---------------------------------------------------------------------------
// F1-7

test("F1-7 a print snapshot is never the 'newest snapshot' a reference pins, and naming one is refused", async () => {
  await with_env(async (env) => {
    const src = await make_source(env, "f7");
    grant_access(env, src);
    const attach = (key: string, extra: Record<string, unknown> = {}) => ok(env, env.ctx(key), "reference.attach", { referenced_project_id: src.p.project_id, ...extra });
    const first = await attach("f7-att-1");
    assert.equal(first.source_snapshot_id, src.snapshot_id);
    await ok(env, env.ctx("f7-det-1"), "reference.detach", { reference_id: first.reference_id });

    const printed = (await env.service.execute(ctx_for(src.p, "f7-print"), "print.commit", { scope: "edition" })).result as Record<string, any>;
    const second = await attach("f7-att-2");
    assert.equal(second.source_snapshot_id, src.snapshot_id, "the default pin is still the edition snapshot, not the print");
    const row = reference_row(env.db, env.p.project_id, second.reference_id)!;
    const content = reference_content(env.db, row) as any;
    assert.deepEqual(content.items_status, { final_report: "ok", sources: "ok" });
    assert.equal(content.items.length, 2);
    // a print alone is not a new version of the source
    const view = reference_view(env.db, row, reference_caller(env.db, env.p.actor_id, false)) as any;
    assert.equal(view.new_version_available, false, "printing the source is not a new version");
    assert.equal(view.latest_snapshot_id, src.snapshot_id);
    await rejects_api(ok(env, env.ctx("f7-ref"), "reference.refresh", { reference_id: second.reference_id }), "conflict");

    await ok(env, env.ctx("f7-det-2"), "reference.detach", { reference_id: second.reference_id });
    await rejects_api(attach("f7-att-3", { source_snapshot_id: printed.snapshot_id }), "not_found");
  });
});

// ---------------------------------------------------------------------------
// F2 (최종 2회차 · 사용자 결정): 인쇄물은 사람용이다 — 비사람의 GET P/print 와 인쇄 blob 읽기는 모두 막힌다.

const count_rows = (env: ApiEnv, table: string): number => Number(env.db.get<{ n: bigint }>(`SELECT count(*) AS n FROM ${table}`)?.n ?? 0n);

test("F2-1 a non-human caller never reads GET P/print: 403 forbidden with no fact about the print, no event, no receipt", async () => {
  await with_api(async (env) => {
    const s = await scene(env, "f21");
    const done = await owner_commit(env, { scope: "round", round_id: s.round.round_id }, "f21-commit");
    const agent = await make_agent(env, "f21-reader", ["context:read", "file:read"]);
    const events = count_rows(env, "events");
    const receipts = count_rows(env, "run_input_receipts");
    for (const query of [`scope=round&snapshot=${done.snapshot_id}`, "scope=round", "scope=stage", "scope=edition", "scope=round&snapshot=no-such", "scope=project", ""]) {
      const res = await call(env, { method: "GET", path: P(env, `/print?${query}`), auth: { token: agent.token } });
      assert.equal(res.status, 403, `agent GET /print?${query}`);
      assert.equal(res.json.error.code, "forbidden");
      const wire = wire_of(res);
      for (const needle of [done.snapshot_id, done.output_blob_id, done.manifest_blob_id, "공개본문-f21", s.body.object_id, s.body.version_id]) {
        assert.ok(!wire.includes(needle as string), `"${needle}" must not appear in the 403 (${query})`);
      }
    }
    // the same answer for a snapshot that exists and one that does not: nothing is told about the print
    const a = await call(env, { method: "GET", path: P(env, `/print?scope=round&snapshot=${done.snapshot_id}`), auth: { token: agent.token } });
    const b = await call(env, { method: "GET", path: P(env, "/print?scope=round&snapshot=no-such"), auth: { token: agent.token } });
    assert.deepEqual(a.json.error, b.json.error);
    assert.equal(count_rows(env, "events"), events, "a refused read writes no event");
    assert.equal(count_rows(env, "run_input_receipts"), receipts, "a refused read writes no receipt");
    // no credential is still 401; the owner session still reads the print as it was fixed
    assert.equal((await call(env, { method: "GET", path: P(env, `/print?scope=round&snapshot=${done.snapshot_id}`), auth: "none" })).status, 401);
    const human = await call(env, { method: "GET", path: P(env, `/print?scope=round&snapshot=${done.snapshot_id}`), auth: "owner" });
    assert.equal(human.status, 200);
    assert.equal(human.json.data.snapshot.content_hash, done.content_hash);
    assert.match(human.json.data.document as string, /공개본문-f21/);
  });
});

test("F2-2 the blobs a print made (output, manifest) are closed to a non-human caller even when nothing is denied; the owner still reads them", async () => {
  await with_api(async (env) => {
    const s = await scene(env, "f22");
    const done = await owner_commit(env, { scope: "round", round_id: s.round.round_id }, "f22-commit");
    const agent = await make_agent(env, "f22-reader", ["context:read", "file:read"]);
    for (const blob_id of [done.output_blob_id, done.manifest_blob_id] as string[]) {
      for (const route of ["content", "preview"]) {
        const raw = await call(env, { method: "GET", path: P(env, `/files/${blob_id}/${route}`), auth: { token: agent.token } });
        assert.equal(raw.status, 403, `${blob_id} ${route}`);
        assert.ok(!wire_of(raw).includes("공개본문-f22"));
        const human = await call(env, { method: "GET", path: P(env, `/files/${blob_id}/${route}`), auth: "owner" });
        assert.equal(human.status, 200, `owner ${route}`);
      }
    }
    // a file that is not a print's stays readable by the agent
    const plain = await new_material(env, "f22", { name: "공개파일-f22.txt" });
    const read = await call(env, { method: "GET", path: P(env, `/files/${plain.blob.blob_id}/content`), auth: { token: agent.token } });
    assert.equal(read.status, 200);
  });
});

test("F2-3 review repro 1: a print blob registered as a material and denied is 403 on both the print and the raw route (and stays closed after allow)", async () => {
  await with_api(async (env) => {
    const s = await scene(env, "f23");
    const done = await owner_commit(env, { scope: "round", round_id: s.round.round_id }, "f23-commit");
    const agent = await make_agent(env, "f23-reader", ["context:read", "file:read"]);
    for (const blob_id of [done.output_blob_id, done.manifest_blob_id] as string[]) {
      const reg = await call(env, { method: "POST", path: P(env, "/materials"), auth: "owner", body: { blob_id, title: `인쇄자료-${blob_id}` } });
      assert.equal(reg.status, 201, JSON.stringify(reg.json));
      assert_ok(await set_access(env, reg.json.data.file_policy_id, "deny"));
      const print = await call(env, { method: "GET", path: P(env, `/print?scope=round&snapshot=${done.snapshot_id}`), auth: { token: agent.token } });
      assert.equal(print.status, 403);
      assert.ok(!wire_of(print).includes(blob_id));
      const raw = await call(env, { method: "GET", path: P(env, `/files/${blob_id}/content`), auth: { token: agent.token } });
      assert.equal(raw.status, 403);
      assert_ok(await set_access(env, reg.json.data.file_policy_id, "allow"));
      assert.equal((await call(env, { method: "GET", path: P(env, `/files/${blob_id}/content`), auth: { token: agent.token } })).status, 403, "allow does not reopen a print blob");
    }
  });
});

// A lost anchor keeps its quote forever. V1 carried a file closed to AI; V2 (current) does not. The quote must not leave through
// any non-human exit of a print or a thread (the print is closed now; the thread read follows the version the anchor was made on).
const LOST_PHRASE = "비밀문장-앵커-3c8d";

async function lost_scene(env: ApiEnv, tag: string, with_round = true) {
  const s = with_round ? await scene(env, tag) : { plan: stage_of(env, "plan"), round: null as never, body: null as never };
  const BODY1 = `앞글 ${LOST_PHRASE} 뒷글 ${tag}`;
  const doc = await art(env, `${tag}-doc`, { stage_id: s.plan, body_md: BODY1, title: `문서-${tag}` });
  const secret = await new_material(env, tag, { name: `비공개파일-${tag}.txt` });
  await ok(env, env.ctx(`${tag}-attach`), "file.attach_version", { version_id: doc.version_id, blob_id: secret.blob.blob_id, role: "attachment" });
  const note = await ok(env, env.ctx(`${tag}-note`), "annotation.create", {
    target_object_id: doc.object_id,
    anchor: { exact_quote: LOST_PHRASE, ...cp_find(BODY1, LOST_PHRASE) },
    body_md: `첨언본문-${tag}`,
  });
  const v2 = await more(env, `${tag}-v2`, doc.object_id, { title: `문서-${tag}`, body_md: "전혀 다른 공개 글이다.", current: true });
  assert_ok(await set_access(env, secret.data.file_policy_id, "deny"));
  return { s, doc, secret, note, v2 };
}

test("F2-4 review repro 2: the lost-anchor quote of a closed version does not reach a non-human caller by any print route", async () => {
  await with_api(async (env) => {
    const l = await lost_scene(env, "f24");
    const done = await owner_commit(env, { scope: "round", round_id: l.s.round.round_id }, "f24-commit");
    const agent = await make_agent(env, "f24-reader", ["context:read", "file:read"]);
    for (const path of [`/print?scope=round&snapshot=${done.snapshot_id}`, "/print?scope=round", `/files/${done.output_blob_id}/content`, `/files/${done.output_blob_id}/preview`, `/files/${done.manifest_blob_id}/content`]) {
      const res = await call(env, { method: "GET", path: P(env, path), auth: { token: agent.token } });
      assert.equal(res.status, 403, path);
      assert.ok(!wire_of(res).includes(LOST_PHRASE), path);
    }
    // the human keeps the lost mark and the fixed print
    const human = await call(env, { method: "GET", path: P(env, `/print?scope=round&snapshot=${done.snapshot_id}`), auth: "owner" });
    assert.equal(human.status, 200);
    assert.ok((human.json.data.document as string).includes(LOST_PHRASE));
    assert.ok(human.json.data.manifest.items.some((i: any) => i.category === "comment" && i.anchor_status === "lost"));
  });
});

test("F2-5 the lost-anchor quote follows the decision of the version the anchor was made on: GET threads/{t} leaves quote, prefix and suffix out, keeps the anchor state", async () => {
  await with_api(async (env) => {
    const l = await lost_scene(env, "f25");
    const agent = await make_agent(env, "f25-reader", ["context:read", "file:read"]);
    const thread = (auth: any) => call(env, { method: "GET", path: P(env, `/threads/${l.note.thread_id}`), auth });

    const closed = await thread({ token: agent.token });
    assert.equal(closed.status, 200);
    assert.ok(!wire_of(closed).includes(LOST_PHRASE), "no quote, prefix, suffix or current text of the closed version");
    assert.equal(closed.json.data.anchor.id, l.note.anchor_id, "the anchor is still named");
    assert.equal(closed.json.data.anchor.current.status, "lost", "its state stays");
    for (const key of ["exact_quote", "prefix", "suffix"]) assert.equal(key in closed.json.data.anchor, false, `${key} is left out`);
    assert.equal(closed.json.data.anchor.current.text, null);
    const list = await call(env, { method: "GET", path: P(env, `/threads?target_object_id=${l.doc.object_id}`), auth: { token: agent.token } });
    assert.ok(!wire_of(list).includes(LOST_PHRASE));
    assert.equal(list.json.data.threads[0].anchor_status, "lost");

    // the owner still reads the quote
    const human = await thread("owner");
    assert.equal(human.json.data.anchor.exact_quote, LOST_PHRASE);

    // the decision is the version's: allow the file again and the agent reads the quote again
    assert_ok(await set_access(env, l.secret.data.file_policy_id, "allow"));
    const open = await thread({ token: agent.token });
    assert.equal(open.json.data.anchor.exact_quote, LOST_PHRASE);
  });
});

test("F2-6 no other non-human exit carries the closed lost-anchor quote: context, changes, version reads, the round's threads", async () => {
  await with_api(async (env) => {
    const l = await lost_scene(env, "f26");
    const agent = await make_agent(env, "f26-reader", ["context:read", "file:read"]);
    const paths = [
      "/context",
      "/changes",
      // (V1's own text is the artifact's, read as before by the version read; what is closed here is the quote an anchor kept)
      `/objects/${l.doc.object_id}/versions/${l.v2}`,
      `/stages/${l.s.plan}/rounds/${l.s.round.round_id}/threads`,
      "/materials",
      "/followups",
    ];
    for (const path of paths) {
      const res = await call(env, { method: "GET", path: P(env, path), auth: { token: agent.token } });
      assert.ok(res.status < 500, `${path} ${res.status}`);
      assert.ok(!wire_of(res).includes(LOST_PHRASE), `${path}: the closed quote must not appear`);
    }
  });
});

// The same lost-anchor scene through the other two non-human exits that have their own code: B (the MCP tools over the API) and A (the
// built-in runner's context.get). Neither carries a thread's anchor at all; the closed quote must still be in no byte they send.
test("F2-7 B MCP: pes_context and pes_read carry no closed lost-anchor quote; the thread read through the API is the only exit that has one", async () => {
  await with_cleanup(async (env, open) => {
    const client = open(await env.client());
    const l = await lost_scene(env as unknown as ApiEnv, "f27", false);
    const context = await client.ok("pes_context", {});
    assert.ok(!wire(context).includes(LOST_PHRASE), "pes_context");
    for (const [object_id, version_id] of [
      [l.doc.object_id, l.v2],
      [l.note.thread_id, env.db.get<{ v: string }>("SELECT current_version_id AS v FROM objects WHERE id = ?", l.note.thread_id)!.v],
    ] as const) {
      const out = await client.tool("pes_read", { object_id, version_id });
      assert.ok(!wire(out.data).includes(LOST_PHRASE), `pes_read ${object_id}`);
    }
    assert.ok(!client.lines.join("\n").includes(LOST_PHRASE), "no raw MCP line carries the closed quote");
  });
});

test("F2-8 A context.get: the closed lost-anchor quote reaches no request sent to the model", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env);
    const opened = await open_stage(env, "plan");
    const BODY1 = `앞글 ${LOST_PHRASE} 뒷글 f28`;
    const doc = await art(env, "f28-doc", { stage_id: opened.stage_id, body_md: BODY1, title: "문서-f28" });
    const blob = await put_ready(env, new TextEncoder().encode("비공개 파일 본문-f28"), "f28-file");
    const material = (await env.service.execute(env.ctx("f28-up"), "file.upload", { blob_id: blob.blob_id, title: "비공개파일-f28" })).result as Record<string, any>;
    await ok(env, env.ctx("f28-attach"), "file.attach_version", { version_id: doc.version_id, blob_id: blob.blob_id, role: "attachment" });
    await ok(env, env.ctx("f28-note"), "annotation.create", {
      target_object_id: doc.object_id,
      anchor: { exact_quote: LOST_PHRASE, ...cp_find(BODY1, LOST_PHRASE) },
      body_md: "첨언본문-f28",
    });
    await more(env, "f28-v2", doc.object_id, { title: "문서-f28", body_md: "전혀 다른 공개 글이다.", current: true });
    await env.service.execute(env.ctx("f28-deny"), "file.ai_access_set", { file_policy_id: material.file_policy_id, ai_access: "deny" });
    set_script(env, [context_turn(), FINISH]);
    const mark = env.fake.bodies().length;
    await start_run(env, { stage_id: opened.stage_id, round_id: opened.round_id });
    const sent = env.fake.bodies().slice(mark);
    assert.ok(sent.length >= 2, "the run read the context");
    assert.ok(!sent.map((b: any) => request_text(b)).join("\n").includes(LOST_PHRASE) && !JSON.stringify(sent).includes(LOST_PHRASE));
  });
});
