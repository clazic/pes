/**
 * SEL-93 U3a — 반영 내역(reflection) 명령 reflection.create 와 applied/partial 의미 증거 (tester, 작성 모드).
 * 구현 전에는 명령이 없어 실패하는 것이 정상.
 *
 * 있던 것: DDL reflection_entries — CHECK(disposition NOT IN ('applied','partial') OR (applied_tx_id NOT NULL AND (result_version_id OR followup_id)))
 *   + FK 들. 이것은 **존재만** 본다. 이 파일의 핵심은 DDL 이 못 잡는 **의미 일치**를 서비스가 검증하는지다.
 * 없던 것: 명령 reflection.create.
 *
 * 정한 해석:
 *   reflection.create { target_round_id, entries:[{ source_version_id, disposition, rationale, result_version_id?, followup_id?,
 *                       evidence_tx_id?, supersedes_entry_id? }] }      사람 또는 에이전트(A 도구 reflection.write 가 이 명령을 쓴다)
 *     결과 { target_round_id, count, applied_count, partial_count, entries:[{ entry_id, disposition }] }.
 *     entries 는 배열(빈 배열 가능 = "0건 제출": 행은 없고 receipt+event 만 남는다). 배열이 아니거나 없으면 invalid_payload.
 *     행: reflection_entries(id, source_version_id, target_round_id, disposition, rationale, result_version_id, followup_id,
 *         applied_tx_id=evidence_tx_id, supersedes_entry_id, actor_id=부른 행위자, tx_id=이 명령의 tx). 한 호출은 전부 쓰거나 전부 안 쓴다.
 *   disposition 별 규칙:
 *     rejected | deferred : rationale(비어 있지 않음) 필수. result_version_id·followup_id·evidence_tx_id 를 주면 invalid_payload(증거 칸은 applied/partial 전용).
 *     applied | partial   : rationale 필수 + 의미 증거 필수:
 *        (a) evidence_tx_id 가 있어야 하고, (b) result_version_id 또는 followup_id 중 하나 이상, 그리고 **일치**:
 *        - result_version_id 가 있으면 그 버전이 이 프로젝트의 object_versions 이고 **그 버전을 만든 tx(object_versions.tx_id) == evidence_tx_id**,
 *          그리고 result_version_id != source_version_id(원문 그대로는 결과가 아니다).
 *        - followup_id 가 있으면 그 후속의 **현재 버전 state 가 'applied' 이고 applied_tx_id == evidence_tx_id**
 *          (proposed/accepted/running/deferred/rejected/cancelled 는 증거가 아니다. FK 존재나 proposed 상태만으로 통과 금지).
 *        - 둘 다 주면 둘 다 일치해야 한다.
 *        증거가 모자라면 invalid_payload, 있지만 서로 안 맞거나 상태가 안 되면 conflict(또는 invalid_payload). 모르는 id 는 not_found(또는 invalid_payload).
 *   target_round_id 가 이 프로젝트의 라운드가 아니면 not_found. source_version_id 가 이 프로젝트 버전이 아니면 not_found.
 *   reflection.create 는 followups·followup_versions 를 만들거나 바꾸지 않는다(연결만).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { COMMANDS } from "../scripts/pes_core/commands.ts";
import { with_env, type Env } from "./helpers/blob_env.ts";
import { insert_followup, stage_ids } from "./helpers/editions_env.ts";
import { open_round } from "./helpers/questions_env.ts";
import { state_signature } from "./helpers/state_signature.ts";
import { agent_of, agent_with_key, artifact_version, count, ok, reflection_rows, refused, tx_of_version } from "./helpers/sel93_env.ts";

const BAD = ["invalid_payload", "validation_failed", "conflict", "not_found"];

interface Scene {
  round_id: string;
  stage_id: string;
  source: { object_id: string; version_id: string };
  result: { object_id: string; version_id: string };
  result_tx: string;
  other: { object_id: string; version_id: string };
}

async function scene(env: Env, tag = "s"): Promise<Scene> {
  const { stage_id, round_id } = await open_round(env, tag);
  const source = await artifact_version(env, `${tag}-src`);
  const result = await artifact_version(env, `${tag}-res`);
  const other = await artifact_version(env, `${tag}-oth`);
  return { round_id, stage_id, source, result, result_tx: tx_of_version(env.db, result.version_id), other };
}

function entry(s: Scene, extra: Record<string, unknown>): Record<string, unknown> {
  return { source_version_id: s.source.version_id, disposition: "applied", rationale: "본문에 반영했다.", ...extra };
}

test("reflection.create is registered", () => {
  assert.ok(COMMANDS.has("reflection.create"));
});

test("applied with a result version made by the evidence tx is recorded with all links", async () => {
  await with_env(async (env) => {
    const s = await scene(env);
    const out = await ok(env, env.ctx("ok-1"), "reflection.create", {
      target_round_id: s.round_id,
      entries: [entry(s, { result_version_id: s.result.version_id, evidence_tx_id: s.result_tx })],
    });
    assert.equal(out.applied_count, 1);
    assert.equal(out.partial_count, 0);
    assert.equal(out.count, 1);
    assert.equal(out.target_round_id, s.round_id);
    const rows = reflection_rows(env.db, s.round_id);
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.equal(row.id, out.entries[0].entry_id);
    assert.equal(row.disposition, "applied");
    assert.equal(row.source_version_id, s.source.version_id);
    assert.equal(row.result_version_id, s.result.version_id);
    assert.equal(row.applied_tx_id, s.result_tx);
    assert.equal(row.followup_id, null);
    assert.equal(row.actor_id, env.p.actor_id);
    assert.notEqual(row.tx_id, row.applied_tx_id, "tx_id is this command's commit; applied_tx_id is the evidence commit");
    assert.equal(row.rationale, "본문에 반영했다.");
  });
});

test("partial counts separately and needs the same evidence", async () => {
  await with_env(async (env) => {
    const s = await scene(env);
    const sig = state_signature(env.db);
    await refused(env, env.ctx("p-no"), "reflection.create", { target_round_id: s.round_id, entries: [entry(s, { disposition: "partial" })] }, ...BAD);
    assert.equal(state_signature(env.db), sig);
    const out = await ok(env, env.ctx("p-ok"), "reflection.create", {
      target_round_id: s.round_id,
      entries: [entry(s, { disposition: "partial", rationale: "절반만 반영", result_version_id: s.result.version_id, evidence_tx_id: s.result_tx })],
    });
    assert.equal(out.partial_count, 1);
    assert.equal(out.applied_count, 0);
    assert.equal(reflection_rows(env.db)[0]!.disposition, "partial");
  });
});

test("applied needs evidence: no result/followup, no tx, or neither — all refused and nothing is written", async () => {
  await with_env(async (env) => {
    const s = await scene(env);
    const sig = state_signature(env.db);
    const bad: Array<Record<string, unknown>> = [
      {},
      { evidence_tx_id: s.result_tx },
      { result_version_id: s.result.version_id },
      { result_version_id: null, evidence_tx_id: null },
      { result_version_id: "", evidence_tx_id: s.result_tx },
      { result_version_id: s.result.version_id, evidence_tx_id: "" },
    ];
    let n = 0;
    for (const extra of bad) {
      await refused(env, env.ctx(`ne-${n++}`), "reflection.create", { target_round_id: s.round_id, entries: [entry(s, extra)] }, ...BAD);
    }
    assert.equal(state_signature(env.db), sig);
  });
});

test("FK existence is not evidence: a real tx and a real result version that do not belong together are refused", async () => {
  await with_env(async (env) => {
    const s = await scene(env);
    const first_tx = env.db.get<{ id: string }>("SELECT id FROM mutation_commits WHERE project_id = ? ORDER BY rowid LIMIT 1", env.p.project_id)!.id;
    const other_tx = tx_of_version(env.db, s.other.version_id);
    assert.notEqual(other_tx, s.result_tx);
    const sig = state_signature(env.db);
    // both ids exist and are in this project, but the tx did not make that result
    await refused(env, env.ctx("fk-1"), "reflection.create", { target_round_id: s.round_id, entries: [entry(s, { result_version_id: s.result.version_id, evidence_tx_id: first_tx })] }, "conflict", "invalid_payload", "validation_failed");
    await refused(env, env.ctx("fk-2"), "reflection.create", { target_round_id: s.round_id, entries: [entry(s, { result_version_id: s.result.version_id, evidence_tx_id: other_tx })] }, "conflict", "invalid_payload", "validation_failed");
    // the result version is the source itself (nothing changed)
    await refused(env, env.ctx("fk-3"), "reflection.create", { target_round_id: s.round_id, entries: [entry(s, { result_version_id: s.source.version_id, evidence_tx_id: tx_of_version(env.db, s.source.version_id) })] }, "conflict", "invalid_payload", "validation_failed");
    assert.equal(state_signature(env.db), sig);
  });
});

test("unknown ids are refused (result, tx, source, round) and nothing is written", async () => {
  await with_env(async (env) => {
    const s = await scene(env);
    const sig = state_signature(env.db);
    await refused(env, env.ctx("u-1"), "reflection.create", { target_round_id: s.round_id, entries: [entry(s, { result_version_id: "no-such-version", evidence_tx_id: s.result_tx })] }, "not_found", "invalid_payload");
    await refused(env, env.ctx("u-2"), "reflection.create", { target_round_id: s.round_id, entries: [entry(s, { result_version_id: s.result.version_id, evidence_tx_id: "no-such-tx" })] }, "not_found", "invalid_payload", "conflict");
    await refused(env, env.ctx("u-3"), "reflection.create", { target_round_id: s.round_id, entries: [entry(s, { source_version_id: "no-such-source", result_version_id: s.result.version_id, evidence_tx_id: s.result_tx })] }, "not_found");
    await refused(env, env.ctx("u-4"), "reflection.create", { target_round_id: "no-such-round", entries: [entry(s, { result_version_id: s.result.version_id, evidence_tx_id: s.result_tx })] }, "not_found");
    assert.equal(state_signature(env.db), sig);
  });
});

test("a follow-up is evidence only when it is applied by the evidence tx; proposed and other states are not", async () => {
  await with_env(async (env) => {
    const s = await scene(env);
    const ids = stage_ids(env.db, env.p.edition_id);
    const applied = insert_followup(env, "fa", ids.research, "applied", "다음 라운드에 반영 완료");
    const applied_tx = env.db.get<{ t: string }>("SELECT applied_tx_id AS t FROM followup_versions WHERE version_id = ?", applied.version_id)!.t;
    const sig_before = state_signature(env.db);
    for (const state of ["proposed", "accepted", "running", "deferred", "rejected", "cancelled"] as const) {
      const f = insert_followup(env, `f-${state}`, ids.research, state, `상태 ${state}`);
      const sig = state_signature(env.db);
      await refused(
        env,
        env.ctx(`f-${state}`),
        "reflection.create",
        { target_round_id: s.round_id, entries: [entry(s, { followup_id: f.object_id, evidence_tx_id: applied_tx })] },
        "conflict",
        "invalid_payload",
        "validation_failed",
      );
      assert.equal(state_signature(env.db), sig, `${state} follow-up is not evidence`);
    }
    // an applied follow-up with a DIFFERENT tx than its own applied_tx_id is a mismatch
    await refused(env, env.ctx("f-mismatch"), "reflection.create", { target_round_id: s.round_id, entries: [entry(s, { followup_id: applied.object_id, evidence_tx_id: s.result_tx })] }, "conflict", "invalid_payload", "validation_failed");
    // the applied follow-up with its own tx passes
    const followups_before = count(env.db, "followups");
    const versions_before = count(env.db, "followup_versions");
    const out = await ok(env, env.ctx("f-ok"), "reflection.create", { target_round_id: s.round_id, entries: [entry(s, { followup_id: applied.object_id, evidence_tx_id: applied_tx })] });
    assert.equal(out.applied_count, 1);
    const row = reflection_rows(env.db, s.round_id).find((r) => r.followup_id === applied.object_id)!;
    assert.equal(row.applied_tx_id, applied_tx);
    assert.equal(row.result_version_id, null);
    assert.equal(count(env.db, "followups"), followups_before, "reflection links follow-ups, it does not create them");
    assert.equal(count(env.db, "followup_versions"), versions_before);
    assert.notEqual(state_signature(env.db), sig_before);
  });
});

test("result and follow-up together must BOTH agree with the evidence tx", async () => {
  await with_env(async (env) => {
    const s = await scene(env);
    const ids = stage_ids(env.db, env.p.edition_id);
    const f = insert_followup(env, "both", ids.research, "applied", "후속");
    const f_tx = env.db.get<{ t: string }>("SELECT applied_tx_id AS t FROM followup_versions WHERE version_id = ?", f.version_id)!.t;
    assert.notEqual(f_tx, s.result_tx);
    const sig = state_signature(env.db);
    await refused(env, env.ctx("b-1"), "reflection.create", { target_round_id: s.round_id, entries: [entry(s, { result_version_id: s.result.version_id, followup_id: f.object_id, evidence_tx_id: s.result_tx })] }, "conflict", "invalid_payload", "validation_failed");
    await refused(env, env.ctx("b-2"), "reflection.create", { target_round_id: s.round_id, entries: [entry(s, { result_version_id: s.result.version_id, followup_id: f.object_id, evidence_tx_id: f_tx })] }, "conflict", "invalid_payload", "validation_failed");
    assert.equal(state_signature(env.db), sig);
  });
});

test("rejected and deferred need a reason and carry no evidence fields", async () => {
  await with_env(async (env) => {
    const s = await scene(env);
    for (const disposition of ["rejected", "deferred"]) {
      const out = await ok(env, env.ctx(`rd-${disposition}`), "reflection.create", {
        target_round_id: s.round_id,
        entries: [{ source_version_id: s.source.version_id, disposition, rationale: `${disposition} 이유` }],
      });
      assert.equal(out.applied_count, 0);
      assert.equal(out.partial_count, 0);
      const row = reflection_rows(env.db).find((r) => r.disposition === disposition)!;
      assert.equal(row.result_version_id, null);
      assert.equal(row.followup_id, null);
      assert.equal(row.applied_tx_id, null);
      assert.equal(row.rationale, `${disposition} 이유`);
    }
    const sig = state_signature(env.db);
    for (const disposition of ["rejected", "deferred"]) {
      await refused(env, env.ctx(`rd-nr-${disposition}`), "reflection.create", { target_round_id: s.round_id, entries: [{ source_version_id: s.source.version_id, disposition, rationale: " " }] }, "invalid_payload", "validation_failed");
      await refused(env, env.ctx(`rd-ev-${disposition}`), "reflection.create", { target_round_id: s.round_id, entries: [{ source_version_id: s.source.version_id, disposition, rationale: "이유", result_version_id: s.result.version_id, evidence_tx_id: s.result_tx }] }, "invalid_payload", "validation_failed");
    }
    assert.equal(state_signature(env.db), sig);
  });
});

test("bad shapes: entries missing / not an array, unknown disposition, blank rationale, unknown fields", async () => {
  await with_env(async (env) => {
    const s = await scene(env);
    const sig = state_signature(env.db);
    const base = { source_version_id: s.source.version_id, rationale: "이유" };
    const cases: Array<Record<string, unknown>> = [
      { target_round_id: s.round_id },
      { target_round_id: s.round_id, entries: "x" },
      { target_round_id: s.round_id, entries: {} },
      { entries: [] },
      { target_round_id: s.round_id, entries: [{ ...base, disposition: "done" }] },
      { target_round_id: s.round_id, entries: [{ ...base, disposition: "rejected", rationale: "" }] },
      { target_round_id: s.round_id, entries: [{ ...base, disposition: "rejected", extra: 1 }] },
      { target_round_id: s.round_id, entries: [{ disposition: "rejected", rationale: "이유" }] },
      { target_round_id: s.round_id, entries: [{ ...base, disposition: "rejected" }], extra: 1 },
      { target_round_id: s.round_id, entries: [null] },
    ];
    let n = 0;
    for (const payload of cases) await refused(env, env.ctx(`sh-${n++}`), "reflection.create", payload, "invalid_payload", "validation_failed");
    assert.equal(state_signature(env.db), sig);
  });
});

test("one bad entry among good ones rolls the whole call back", async () => {
  await with_env(async (env) => {
    const s = await scene(env);
    const sig = state_signature(env.db);
    await refused(
      env,
      env.ctx("atom"),
      "reflection.create",
      {
        target_round_id: s.round_id,
        entries: [
          entry(s, { result_version_id: s.result.version_id, evidence_tx_id: s.result_tx }),
          { source_version_id: s.source.version_id, disposition: "rejected", rationale: "이유" },
          entry(s, { result_version_id: s.result.version_id }), // the third has no tx
        ],
      },
      ...BAD,
    );
    assert.equal(reflection_rows(env.db).length, 0);
    assert.equal(state_signature(env.db), sig, "no row, receipt or event");
  });
});

test("'0건' is a real submission: an empty entries list is accepted, writes no row, and leaves a receipt that says so", async () => {
  await with_env(async (env) => {
    const s = await scene(env);
    const before = reflection_rows(env.db).length;
    const out = await ok(env, env.ctx("zero"), "reflection.create", { target_round_id: s.round_id, entries: [] });
    assert.equal(out.count, 0);
    assert.equal(out.applied_count, 0);
    assert.deepEqual(out.entries, []);
    assert.equal(reflection_rows(env.db).length, before);
    const receipt = env.db.get<{ action: string }>("SELECT action FROM mutation_commits WHERE project_id = ? AND client_request_id = 'zero'", env.p.project_id);
    assert.match(receipt?.action ?? "", /^reflection\./, "the submission itself is on record, so it differs from 'not submitted'");
  });
});

test("an agent may write a reflection (attributed to it) but a reflection from an agent still needs the same evidence", async () => {
  await with_env(async (env) => {
    const s = await scene(env);
    const agent = agent_of(env);
    const out = await ok(env, agent_with_key(agent, "ag-rej"), "reflection.create", {
      target_round_id: s.round_id,
      entries: [{ source_version_id: s.source.version_id, disposition: "deferred", rationale: "다음 판에서" }],
    });
    assert.equal(out.count, 1);
    assert.equal(reflection_rows(env.db)[0]!.actor_id, agent.actor_id);
    const sig = state_signature(env.db);
    await refused(env, agent_with_key(agent, "ag-app"), "reflection.create", { target_round_id: s.round_id, entries: [entry(s, { result_version_id: s.result.version_id })] }, ...BAD);
    assert.equal(state_signature(env.db), sig);
  });
});

test("a correction keeps the old entry: supersedes_entry_id points at it; an unknown one is refused", async () => {
  await with_env(async (env) => {
    const s = await scene(env);
    const first = await ok(env, env.ctx("c-1"), "reflection.create", { target_round_id: s.round_id, entries: [{ source_version_id: s.source.version_id, disposition: "deferred", rationale: "보류" }] });
    const old_id = first.entries[0].entry_id as string;
    const sig = state_signature(env.db);
    await refused(env, env.ctx("c-bad"), "reflection.create", { target_round_id: s.round_id, entries: [{ source_version_id: s.source.version_id, disposition: "deferred", rationale: "보류", supersedes_entry_id: "no-such-entry" }] }, "not_found", "invalid_payload");
    assert.equal(state_signature(env.db), sig);
    await ok(env, env.ctx("c-2"), "reflection.create", {
      target_round_id: s.round_id,
      entries: [entry(s, { result_version_id: s.result.version_id, evidence_tx_id: s.result_tx, supersedes_entry_id: old_id })],
    });
    const rows = reflection_rows(env.db, s.round_id);
    assert.equal(rows.length, 2, "the first entry is still there");
    assert.equal(rows[0]!.id, old_id);
    assert.equal(rows[0]!.disposition, "deferred");
    assert.equal(env.db.get<{ s: string | null }>("SELECT supersedes_entry_id AS s FROM reflection_entries WHERE id <> ?", old_id)?.s, old_id);
  });
});

test("idempotent replay writes once; the same key with another payload is idempotency_key_reuse", async () => {
  await with_env(async (env) => {
    const s = await scene(env);
    const payload = { target_round_id: s.round_id, entries: [{ source_version_id: s.source.version_id, disposition: "deferred", rationale: "보류" }] };
    const a = await env.service.execute(env.ctx("idem"), "reflection.create", payload);
    const b = await env.service.execute(env.ctx("idem"), "reflection.create", payload);
    assert.equal(b.replayed, true);
    assert.deepEqual(b.result, a.result);
    assert.equal(reflection_rows(env.db).length, 1);
    await refused(env, env.ctx("idem"), "reflection.create", { ...payload, entries: [] }, "idempotency_key_reuse", "conflict");
    assert.equal(reflection_rows(env.db).length, 1);
  });
});
