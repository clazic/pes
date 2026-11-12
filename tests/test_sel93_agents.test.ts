/**
 * SEL-93 U3a — 에이전트 경로: A 내장 실행기 도구 allowlist·실제 명령 연결, B MCP 같은 명령, A·B 합성 라운드 (tester, 작성 모드).
 * 가짜 AI 서버(tests/helpers/a_builtin_env.ts FakeAi)와 가짜 MCP 클라이언트만 쓴다. 실제 모델·네트워크 호출 없음.
 *
 * 있던 것(회귀 가드): A_TOOL_ALLOWLIST 에 이미 assumption.propose·decision.propose·reflection.write 이름이 있고(8개: U3 6개 + 결정 0013 의 thread.reply·followup.propose),
 *   지금은 세 도구가 project.add_note 로 "[AI 제안: …]" 노트만 만든다(가정·결정·반영 객체가 아님). MCP 는 pes_* 11개 도구.
 * 없던 것(실패 시험): 세 도구가 진짜 가정/결정/반영을 만든다. B MCP 에 같은 명령을 쓰는 도구. 사람 전용 도구는 어디에도 없다.
 *
 * 정한 해석:
 *   allowlist: U3 가 정한 여섯(context.get·result.submit·question.ask·assumption.propose·decision.propose·reflection.write)이 모두 있고,
 *     그 밖에는 결정 0013 이 이름만 잡아 둔 thread.reply·followup.propose 외에 아무것도 없다(파일·셸·네트워크 없음). 기존 시험(8개 고정)은 그대로 통과해야 한다.
 *     A 도구 인자: assumption.propose {text, title?} → 명령 assumption.propose.statement(= title 이 있으면 "title\n" 없이 text 만, 제목은 rationale 아님: text 를 그대로)
 *       decision.propose {text, scope?='edition'} → decision.propose(scope 기본 edition). reflection.write {entries:[…], target_round_id?=이 run 의 라운드} → reflection.create.
 *     도구 결과는 성공이면 {ok:true, recorded_as|id…}, PES 거절이면 is_error 결과를 모델에게 돌려주고 run 은 계속된다(기존 규칙).
 *     decision.propose 로 만든 결정은 항상 proposed(decided_by 없음). 모델이 부르는 decision.adopt·assumption.assess 등은 "이 도구는 쓸 수 없음".
 *   B: MCP 도구 이름은 tests/helpers/sel93_env.ts 의 B_TOOL 상수(바뀌면 그 파일만 고친다). 인자 = idempotency_key + 명령 필드. 사람 전용 일을 하는 도구는 없다.
 *   A 와 B 가 만든 행·receipt action 은 모양이 같다(같은 명령).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { A_TOOL_ALLOWLIST, TOOL_SPECS } from "../scripts/pes_core/a_runtime/tools.ts";
import {
  FINISH,
  context_turn,
  offered_tools,
  open_stage,
  ready_project,
  run_row,
  start_run,
  submit_turn,
  with_a_env,
  type AEnv,
  type ScriptedTurn,
} from "./helpers/a_builtin_env.ts";
import { make_adapter_env } from "./helpers/adapter_b_env.ts";
import { claim_fresh, with_cleanup } from "./helpers/adapter_b_flow.ts";
import { B_TOOL, HUMAN_ONLY_TOOL_SHAPE, assumption_versions, decision_versions, reflection_rows, tx_of_version } from "./helpers/sel93_env.ts";
import { state_signature } from "./helpers/state_signature.ts";

const U3_SIX = ["context.get", "result.submit", "question.ask", "assumption.propose", "decision.propose", "reflection.write"];
const RESERVED_0013 = ["thread.reply", "followup.propose"];

/** set_script takes a turn list; these tests need turns computed at call time (ids made by an earlier tool), so they set the script function. */
function script_fn(env: AEnv, fn: (n: number) => ScriptedTurn): void {
  const base = env.fake.calls.length;
  env.fake.script = (n: number) => fn(n - base);
}

const all_assumptions = (env: AEnv): string[] => env.db.all<{ object_id: string }>("SELECT object_id FROM assumptions ORDER BY rowid").map((r) => r.object_id);
const all_decisions = (env: AEnv): string[] => env.db.all<{ object_id: string }>("SELECT object_id FROM decisions ORDER BY rowid").map((r) => r.object_id);
const note_count = (env: AEnv): number => Number(env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM artifacts WHERE kind = 'note'")?.n ?? 0n);

// ---------------------------------------------------------------------------
// A: the allowlist

test("A allowlist: the six U3 tools are there, nothing but the two reserved names (decision 0013) is added, and no file/shell/network tool exists", () => {
  const list = [...A_TOOL_ALLOWLIST];
  for (const name of U3_SIX) assert.ok(list.includes(name), `${name} is allowed`);
  const extra = list.filter((n) => !U3_SIX.includes(n));
  assert.deepEqual(extra.sort(), [...RESERVED_0013].sort(), "only thread.reply and followup.propose may sit beside the six");
  assert.ok(Object.isFrozen(A_TOOL_ALLOWLIST));
  for (const name of list) {
    assert.doesNotMatch(name, /^(shell|bash|exec|fs|file|http|fetch|web|net|curl|sh)\b|\.(read|write_file|run|exec|fetch|get_url)$/i, `${name} looks like a file/shell/network tool`);
    assert.doesNotMatch(name, HUMAN_ONLY_TOOL_SHAPE, `${name} must not be a human-only action`);
  }
  // every tool spec offered to a model is on the allowlist, and the three U3 tools are offered
  const offered = TOOL_SPECS.map((t) => t.name);
  for (const name of offered) assert.ok(list.includes(name), `${name} offered ⊆ allowed`);
  for (const name of ["assumption.propose", "decision.propose", "reflection.write"]) assert.ok(offered.includes(name), `${name} is offered`);
});

// ---------------------------------------------------------------------------
// A: a synthetic round through the fake AI server

function script_for_round(env: AEnv, o: { object_id: string; base_version_id: string }): (n: number) => ScriptedTurn {
  return (n) => {
    switch (n) {
      case 1:
        return context_turn();
      case 2:
        return {
          tools: [
            { name: "assumption.propose", args: { text: "응답자는 모두 성인이라고 가정한다." } },
            { name: "decision.propose", args: { text: "2판은 대안 B 를 중심으로 구성한다.", scope: "edition" } },
            ...submit_turn(o.object_id, "AI 가 고친 장").tools!,
          ],
        };
      case 3: {
        const latest = env.db.get<{ id: string; tx_id: string }>("SELECT id, tx_id FROM object_versions WHERE object_id = ? ORDER BY version_no DESC LIMIT 1", o.object_id)!;
        return {
          tools: [
            {
              name: "reflection.write",
              args: {
                entries: [
                  { source_version_id: o.base_version_id, disposition: "applied", rationale: "사람 의견을 본문에 반영했다.", result_version_id: latest.id, evidence_tx_id: latest.tx_id },
                  { source_version_id: o.base_version_id, disposition: "deferred", rationale: "다음 판에서 다룬다." },
                ],
              },
            },
          ],
        };
      }
      default:
        return FINISH;
    }
  };
}

for (const format of ["openai_compatible", "anthropic"] as const) {
  test(`A round (${format}): the built-in runner really creates an assumption proposal, a decision proposal and a reflection with evidence`, async () => {
    await with_a_env(format, async (env) => {
      await ready_project(env);
      const o = await open_stage(env, "plan");
      script_fn(env, script_for_round(env, o));
      const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
      assert.equal(res.status, "succeeded", JSON.stringify(res));
      // the model was offered the three U3 tools (and no human-only one)
      const offered = offered_tools(env.fake.calls[0]!.json);
      for (const name of ["assumption.propose", "decision.propose", "reflection.write"]) assert.ok(offered.includes(name), `${name} offered`);
      assert.equal(offered.some((n) => HUMAN_ONLY_TOOL_SHAPE.test(n)), false);

      const ai = env.ai_actor_id;
      const a = all_assumptions(env);
      assert.equal(a.length, 1, "one assumption object, not a note");
      const av = assumption_versions(env.db, a[0]!);
      assert.equal(av.length, 1);
      assert.equal(av[0]!.state, "proposed");
      assert.equal(av[0]!.needs_review, 1);
      assert.equal(av[0]!.assessment_actor_id, null, "the AI never assesses its own assumption");
      assert.equal(av[0]!.statement, "응답자는 모두 성인이라고 가정한다.");
      assert.equal(env.db.get<{ p: string }>("SELECT proposed_by_actor_id AS p FROM assumptions WHERE object_id = ?", a[0]!)?.p, ai);

      const d = all_decisions(env);
      assert.equal(d.length, 1);
      const dv = decision_versions(env.db, d[0]!);
      assert.equal(dv.length, 1);
      assert.equal(dv[0]!.state, "proposed", "decision.propose is a proposal, never an adoption");
      assert.equal(dv[0]!.decided_by, null);
      assert.equal(dv[0]!.actor_id, ai);
      assert.equal(env.db.get<{ s: string }>("SELECT scope AS s FROM decisions WHERE object_id = ?", d[0]!)?.s, "edition");

      const rows = reflection_rows(env.db, o.round_id);
      assert.equal(rows.length, 2);
      const applied = rows.find((r) => r.disposition === "applied")!;
      assert.equal(applied.actor_id, ai);
      assert.equal(applied.source_version_id, o.base_version_id);
      assert.ok(applied.result_version_id !== null && applied.result_version_id !== o.base_version_id);
      assert.equal(applied.applied_tx_id, tx_of_version(env.db, applied.result_version_id!));
      assert.equal(rows.find((r) => r.disposition === "deferred")!.applied_tx_id, null);

      assert.equal(note_count(env), 0, "these tools no longer write '[AI 제안: …]' notes");
      assert.equal(run_row(env, res.run_id).status, "succeeded");
    });
  });
}

test("A: reflection.write 'applied' without evidence comes back to the model as an error result, nothing is written, the run goes on", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env);
    const o = await open_stage(env, "plan");
    script_fn(env, (n) =>
      n === 1
        ? {
            tools: [
              { name: "reflection.write", args: { entries: [{ source_version_id: o.base_version_id, disposition: "applied", rationale: "증거 없이 적용" }] } },
              // control: a valid call in the same turn does write, so the empty result above is a refusal and not a dead tool
              { name: "reflection.write", args: { entries: [{ source_version_id: o.base_version_id, disposition: "deferred", rationale: "보류" }] } },
            ],
          }
        : FINISH,
    );
    const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
    assert.equal(res.status, "succeeded");
    assert.deepEqual(reflection_rows(env.db).map((r) => r.disposition), ["deferred"], "only the entry with no claim of application was written");
    const back = JSON.stringify(env.fake.calls[1]!.json);
    assert.match(back, /\\"ok\\":false/, "the model was told the tool failed");
  });
});

test("A: a reflection citing a real tx that did not make the result is refused too (FK existence is not evidence)", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env);
    const o = await open_stage(env, "plan");
    const first_tx = env.db.get<{ id: string }>("SELECT id FROM mutation_commits WHERE project_id = ? ORDER BY rowid LIMIT 1", env.p.project_id)!.id;
    script_fn(env, (n) =>
      n === 1
        ? {
            tools: [
              { name: "reflection.write", args: { entries: [{ source_version_id: o.base_version_id, disposition: "applied", rationale: "엉뚱한 증거", result_version_id: o.base_version_id, evidence_tx_id: first_tx }] } },
              { name: "reflection.write", args: { entries: [{ source_version_id: o.base_version_id, disposition: "rejected", rationale: "대조군" }] } },
            ],
          }
        : FINISH,
    );
    const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
    assert.equal(res.status, "succeeded");
    assert.deepEqual(reflection_rows(env.db).map((r) => r.disposition), ["rejected"], "the applied entry with unrelated evidence was refused");
  });
});

test("A: empty text is refused (no assumption/decision row); a human-only or file/shell tool name is 'not available' and changes nothing", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env);
    const o = await open_stage(env, "plan");
    const seed = await env.service.execute(env.ctx("seed-d"), "decision.propose", { statement: "먼저 있던 제안", scope: "edition" });
    const sig_before = state_signature(env.db);
    script_fn(env, (n) =>
      n === 1
        ? {
            tools: [
              { name: "assumption.propose", args: { text: "   " } },
              { name: "decision.propose", args: {} },
              { name: "decision.adopt", args: { decision_id: (seed.result as any).object_id, base_version_id: (seed.result as any).version_id } },
              { name: "assumption.assess", args: { assumption_id: "x", state: "confirmed" } },
              { name: "decision.supersede", args: {} },
              { name: "decision.revoke", args: {} },
              { name: "file.read", args: { path: "/etc/passwd" } },
              { name: "shell", args: { cmd: "id" } },
              { name: "web.fetch", args: { url: "http://example.invalid" } },
            ],
          }
        : FINISH,
    );
    const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
    assert.equal(res.status, "succeeded");
    assert.equal(state_signature(env.db).includes("먼저 있던 제안"), true);
    assert.deepEqual(decision_versions(env.db, (seed.result as any).object_id).map((v) => v.state), ["proposed"], "the AI could not adopt");
    assert.equal(all_assumptions(env).length, 0);
    assert.equal(all_decisions(env).length, 1);
    const back = JSON.stringify(env.fake.calls[1]!.json);
    assert.match(back, /not available/);
    assert.notEqual(state_signature(env.db), "");
    assert.ok(sig_before.length > 0);
  });
});

// ---------------------------------------------------------------------------
// B: MCP

test("B: tools/list has the three propose/write tools and none that judges, adopts, supersedes, revokes or approves", async () => {
  await with_cleanup(async (env, open) => {
    const client = open(await env.client());
    const listed = await client.request("tools/list", {});
    const names: string[] = listed.result.tools.map((t: any) => t.name);
    for (const name of Object.values(B_TOOL)) assert.ok(names.includes(name), `${name} is listed`);
    for (const name of names) assert.doesNotMatch(name, HUMAN_ONLY_TOOL_SHAPE, `${name}: a human-only action must not be an MCP tool`);
    for (const name of Object.values(B_TOOL)) {
      const spec = listed.result.tools.find((t: any) => t.name === name);
      assert.equal(spec.inputSchema.type, "object");
      assert.ok(spec.inputSchema.properties.idempotency_key, `${name} takes idempotency_key`);
    }
  });
});

test("B: a connected agent proposes an assumption and a decision and writes a reflection through MCP; replays are safe; refusals are tool errors", async () => {
  await with_cleanup(async (env, open) => {
    const client = open(await env.client());
    await claim_fresh(client);
    const a = await client.ok(B_TOOL.assumption, { idempotency_key: "b-a", statement: "B 가 깔고 있는 가정", rationale: "합성" });
    assert.equal(a.state ?? a.assumption?.state, "proposed");
    const a_id = a.id ?? a.assumption?.id ?? a.object_id;
    const av = assumption_versions(env.db, a_id);
    assert.equal(av.length, 1);
    assert.equal(av[0]!.state, "proposed");
    assert.equal(av[0]!.needs_review, 1);
    assert.equal(av[0]!.actor_id, env.agent.actor_id);

    const d = await client.ok(B_TOOL.decision, { idempotency_key: "b-d", statement: "B 가 제안한 결정", scope: "project" });
    const d_id = d.id ?? d.decision?.id ?? d.object_id;
    const dv = decision_versions(env.db, d_id);
    assert.equal(dv[0]!.state, "proposed");
    assert.equal(dv[0]!.decided_by, null);

    const r = await client.ok(B_TOOL.reflection, {
      idempotency_key: "b-r",
      target_round_id: env.round_id,
      entries: [{ source_version_id: env.version_id, disposition: "deferred", rationale: "다음 판에서" }],
    });
    assert.ok(r);
    assert.equal(reflection_rows(env.db, env.round_id).length, 1);

    // replay: same key + same arguments writes nothing new
    const sig = state_signature(env.db);
    await client.ok(B_TOOL.assumption, { idempotency_key: "b-a", statement: "B 가 깔고 있는 가정", rationale: "합성" });
    assert.equal(state_signature(env.db), sig);
    await client.fails(B_TOOL.assumption, { idempotency_key: "b-a", statement: "다른 가정" }, "idempotency_key_reuse");

    // refusals come back as tool errors with the API's code and write nothing
    await client.tool(B_TOOL.assumption, { idempotency_key: "b-bad", statement: "" }).then((out) => {
      assert.equal(out.is_error, true);
      assert.ok(["validation_failed", "invalid_payload"].includes(out.data.error.code), out.data.error.code);
    });
    const bad_reflection = await client.tool(B_TOOL.reflection, {
      idempotency_key: "b-r2",
      target_round_id: env.round_id,
      entries: [{ source_version_id: env.version_id, disposition: "applied", rationale: "증거 없음" }],
    });
    assert.equal(bad_reflection.is_error, true);
    assert.equal(bad_reflection.data.error.code, "evidence_required");
    assert.equal(reflection_rows(env.db, env.round_id).length, 1);
  });
});

test("B: a missing idempotency_key is a tool error and makes no write (same rule as the other write tools)", async () => {
  await with_cleanup(async (env, open) => {
    const client = open(await env.client());
    await claim_fresh(client);
    const sig = state_signature(env.db);
    for (const [name, args] of [
      [B_TOOL.assumption, { statement: "가정" }],
      [B_TOOL.decision, { statement: "결정", scope: "edition" }],
      [B_TOOL.reflection, { target_round_id: env.round_id, entries: [] }],
    ] as const) {
      const out = await client.tool(name, args as Record<string, unknown>);
      assert.equal(out.is_error, true, name);
      assert.equal(out.data.error.code, "invalid_payload", name);
    }
    assert.equal(state_signature(env.db), sig);
  });
});

// ---------------------------------------------------------------------------
// A and B use the same command

test("A and B create the same rows and the same receipts: the same commands", async () => {
  const shape = (env: { db: AEnv["db"] }): Record<string, unknown> => {
    const a = env.db.get<{ object_id: string }>("SELECT object_id FROM assumptions ORDER BY rowid LIMIT 1")!.object_id;
    const d = env.db.get<{ object_id: string }>("SELECT object_id FROM decisions ORDER BY rowid LIMIT 1")!.object_id;
    const av = assumption_versions(env.db, a)[0]!;
    const dv = decision_versions(env.db, d)[0]!;
    const actions = env.db
      .all<{ action: string }>("SELECT action FROM mutation_commits WHERE action LIKE 'assumption.%' OR action LIKE 'decision.%' OR action LIKE 'reflection.%' ORDER BY rowid")
      .map((r) => r.action);
    return {
      assumption: { state: av.state, needs_review: av.needs_review, assessed: av.assessment_actor_id, assessed_at: av.assessed_at, version_no: av.version_no },
      decision: { state: dv.state, decided_by: dv.decided_by, version_no: dv.version_no, scope: env.db.get<{ s: string }>("SELECT scope AS s FROM decisions WHERE object_id = ?", d)?.s },
      actions,
    };
  };
  let a_shape: Record<string, unknown> = {};
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env);
    const o = await open_stage(env, "plan");
    script_fn(env, (n) =>
      n === 1
        ? { tools: [{ name: "assumption.propose", args: { text: "가정" } }, { name: "decision.propose", args: { text: "결정", scope: "edition" } }, { name: "reflection.write", args: { entries: [{ source_version_id: o.base_version_id, disposition: "deferred", rationale: "보류" }] } }] }
        : FINISH,
    );
    assert.equal((await start_run(env, { stage_id: o.stage_id, round_id: o.round_id })).status, "succeeded");
    a_shape = shape(env);
  });
  const env = await make_adapter_env();
  try {
    const client = await env.client();
    await claim_fresh(client);
    await client.ok(B_TOOL.assumption, { idempotency_key: "p-a", statement: "가정" });
    await client.ok(B_TOOL.decision, { idempotency_key: "p-d", statement: "결정", scope: "edition" });
    await client.ok(B_TOOL.reflection, { idempotency_key: "p-r", target_round_id: env.round_id, entries: [{ source_version_id: env.version_id, disposition: "deferred", rationale: "보류" }] });
    await client.close();
    assert.deepEqual(shape(env), a_shape);
    assert.ok((a_shape.actions as string[]).length >= 3);
  } finally {
    env.close();
  }
});
