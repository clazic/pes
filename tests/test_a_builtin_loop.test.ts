// SEL-52 (PR19) the built-in executor loop: one synthetic project walks all six stages (with wait / resume /
// interrupt), the tool allowlist, one model per run (no fallback), and the run's recorded identity.

import assert from "node:assert/strict";
import { test } from "node:test";

import { A_TOOL_ALLOWLIST } from "../scripts/pes_core/a_runtime/tools.ts";
import { interrupt } from "../scripts/pes_core/runs.ts";
import { submit_answers } from "../scripts/pes_core/questions.ts";
import { members_of, single_spec } from "./helpers/questions_env.ts";
import {
  A_TOOLS,
  FINISH,
  MODEL_A,
  MODEL_B,
  context_turn,
  dispatches,
  lease_state,
  max_tokens_of,
  models_sent,
  next_key,
  offered_tools,
  open_stage,
  ready_project,
  request_text,
  resume_run,
  run_row,
  seal_and_approve,
  select_model,
  set_script,
  start_run,
  submit_turn,
  versions_of_run,
  with_a_env,
  all_runs,
  artifact_versions_of_run,
  close_stage,
  type AEnv,
} from "./helpers/a_builtin_env.ts";
import type { StageKey } from "./helpers/editions_env.ts";

const STAGES: StageKey[] = ["plan", "research", "analyze", "write", "verify", "publish"];

test("the allowlist is exactly the eight PES commands — no file, shell, or network tool", () => {
  assert.deepEqual([...A_TOOL_ALLOWLIST].sort(), [...A_TOOLS].sort());
  assert.ok(Object.isFrozen(A_TOOL_ALLOWLIST), "the list cannot be extended at run time");
  for (const forbidden of ["shell", "bash", "exec", "fs.", "file.", "http", "fetch", "web.", "net."]) {
    assert.equal(A_TOOL_ALLOWLIST.some((t: string) => t.startsWith(forbidden)), false, `no ${forbidden}* tool`);
  }
});

test("openai_compatible: one synthetic project walks the six stages; analyze asks a human and resumes", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env);
    for (const key of STAGES) {
      const opened = await open_stage(env, key);
      if (key !== "analyze") {
        set_script(env, [context_turn(), submit_turn(opened.object_id, `합성 ${key} 결과`), FINISH]);
        const res = await start_run(env, { stage_id: opened.stage_id, round_id: opened.round_id });
        assert.equal(res.status, "succeeded", `${key}: ${JSON.stringify(res)}`);
        const row = run_row(env, res.run_id);
        assert.equal(row.status, "succeeded");
        assert.equal(row.mode, "A");
        assert.equal(row.runtime, "pes_builtin");
        assert.equal(row.model, MODEL_A, "runs.model is the real model id");
        assert.equal(row.stage_id, opened.stage_id);
        assert.equal(row.round_id, opened.round_id);
        assert.equal(row.actor_id, env.ai_actor_id);
        assert.equal(lease_state(env)?.state, "released", `${key}: the lease is given back at the end`);
        const versions = versions_of_run(env, res.run_id);
        assert.equal(versions.length, 1, `${key}: the result.submit tool wrote exactly one version`);
        await seal_and_approve(env, opened, versions, key);
        continue;
      }

      // --- analyze: ask a human (wait), answer, resume ---
      set_script(env, [
        context_turn(),
        { tools: [{ name: "question.ask", args: { questions: [single_spec("합성 분석 질문")] } }] },
        submit_turn(opened.object_id, "합성 analyze 결과"),
        FINISH,
      ]);
      const first = await start_run(env, { stage_id: opened.stage_id, round_id: opened.round_id });
      assert.equal(first.status, "waiting_human");
      assert.equal(typeof first.question_set_id, "string");
      const waiting = run_row(env, first.run_id);
      assert.equal(waiting.status, "waiting_human", "a question is waiting_human, never blocked_usage");
      assert.equal(waiting.go_block_reason, null);
      assert.equal(lease_state(env)?.state, "released", "waiting gives the lease back");
      const fence_before = lease_state(env)!.fence;
      assert.equal(env.fake.calls.length > 0, true);

      // no answer yet: a resume is refused and costs no model call
      const res_before = env.fake.calls.length;
      await assert.rejects(resume_run(env, first.run_id), (e: any) => e?.code === "conflict" || e?.code === "invalid_payload");
      assert.equal(env.fake.calls.length, res_before, "an unanswered resume sends nothing");
      assert.equal(run_row(env, first.run_id).status, "waiting_human");

      // the human answers; the response alone resumes nothing
      const members = members_of(env.db, first.question_set_id!);
      await submit_answers(env.service, env.ctx(next_key(env, "ans")), {
        set_id: first.question_set_id,
        answers: [{ question_id: members[0]!.question_id, value: "c" }],
      });
      assert.equal(env.fake.calls.length, res_before, "an answer arriving does not start the model by itself");
      assert.equal(run_row(env, first.run_id).status, "waiting_human");

      const second = await resume_run(env, first.run_id);
      assert.equal(second.run_id, first.run_id, "resume continues the same run");
      assert.equal(second.status, "succeeded");
      assert.ok(lease_state(env)!.fence > fence_before, "a resume is a new claim with a higher fence");
      const after = env.fake.bodies()[env.fake.calls.length - 2]!;
      assert.match(request_text(after), /합성 분석 질문/, "after the answer the model sees the question again");
      const versions = artifact_versions_of_run(env, first.run_id);
      assert.equal(versions.length, 1);
      await seal_and_approve(env, opened, versions, key);
    }
    // all six approved; every call of every stage went to the one selected model
    assert.equal(
      env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM stages WHERE edition_id = ? AND status = 'approved'", env.p.edition_id)!.n,
      6n,
    );
    assert.ok(models_sent(env).every((m) => m === MODEL_A));
    assert.equal(all_runs(env).every((r) => r.runtime === "pes_builtin" && r.model === MODEL_A), true);
  });
});

test("openai_compatible: the request shape — tools, token cap, tool results fed back", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env);
    const opened = await open_stage(env, "plan");
    set_script(env, [context_turn(), submit_turn(opened.object_id, "합성"), FINISH]);
    const res = await start_run(env, { stage_id: opened.stage_id, round_id: opened.round_id, max_output_tokens: 321 });
    assert.equal(res.status, "succeeded");
    assert.equal(env.fake.calls.length, 3);
    const [first, second] = env.fake.bodies() as [any, any];
    assert.deepEqual(offered_tools(first), (A_TOOLS as readonly string[]).filter((n) => n !== "thread.reply").sort(), "the model is offered the allowlist except thread.reply (no command backs it yet)");
    assert.equal(max_tokens_of(first), 321, "the reservation cap is also the request cap");
    assert.equal(first.model, MODEL_A);
    assert.ok(first.messages.some((m: any) => m.role === "user" || m.role === "system"));
    const tool_message = second.messages.find((m: any) => m.role === "tool");
    assert.ok(tool_message, "the tool result is sent back as a tool message");
    assert.equal(tool_message.tool_call_id, "call_1_0");
    assert.equal(second.messages.some((m: any) => m.role === "assistant" && Array.isArray(m.tool_calls)), true);
  });
});

test("anthropic: the same walk in the Messages format (system, tool_use / tool_result)", async () => {
  await with_a_env("anthropic", async (env) => {
    await ready_project(env);
    const opened = await open_stage(env, "plan");
    set_script(env, [context_turn(), submit_turn(opened.object_id, "합성"), FINISH]);
    const res = await start_run(env, { stage_id: opened.stage_id, round_id: opened.round_id, max_output_tokens: 222 });
    assert.equal(res.status, "succeeded");
    const calls = env.fake.calls;
    assert.equal(calls.length, 3);
    for (const call of calls) {
      assert.match(call.path, /\/v1\/messages$/);
      assert.equal(typeof call.headers["anthropic-version"], "string");
      assert.equal(call.headers["x-api-key"] !== undefined, true);
      assert.equal(call.headers["authorization"], undefined, "anthropic is not sent a bearer header");
    }
    const [first, second] = env.fake.bodies() as [any, any];
    assert.deepEqual(offered_tools(first), (A_TOOLS as readonly string[]).filter((n) => n !== "thread.reply").sort());
    assert.ok(first.tools.every((t: any) => t.input_schema !== undefined), "tools use input_schema");
    assert.equal(first.max_tokens, 222, "anthropic requires max_tokens and gets the run's cap");
    assert.equal(first.model, MODEL_A);
    const last = second.messages[second.messages.length - 1];
    assert.equal(last.role, "user");
    assert.ok(last.content.some((b: any) => b.type === "tool_result" && b.tool_use_id === "toolu_1_0"));
    assert.equal(versions_of_run(env, res.run_id).length, 1);
    assert.equal(run_row(env, res.run_id).runtime, "pes_builtin");
  });
});

test("a tool outside the allowlist does nothing: no file, no shell, no network, and the loop goes on", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env);
    const decoy = await (await import("./helpers/a_builtin_env.ts")).FakeAi.start("openai_compatible");
    try {
      const canary = `${env.home.root}/canary-should-not-exist.txt`;
      const opened = await open_stage(env, "plan");
      set_script(env, [
        {
          tools: [
            { name: "fs.write", args: { path: canary, content: "x" } },
            { name: "shell.exec", args: { command: `touch ${canary}` } },
            { name: "http.fetch", args: { url: `${decoy.origin}/v1/models` } },
          ],
        },
        submit_turn(opened.object_id, "합성"),
        FINISH,
      ]);
      const res = await start_run(env, { stage_id: opened.stage_id, round_id: opened.round_id });
      assert.equal(res.status, "succeeded", "a refused tool is reported back to the model, the run is not killed");
      const { existsSync } = await import("node:fs");
      assert.equal(existsSync(canary), false, "no file was written");
      assert.equal(decoy.all.length, 0, "no arbitrary network call was made");
      const body2 = JSON.stringify(env.fake.bodies()[1]);
      assert.match(body2, /call_1_0/);
      assert.match(body2, /call_1_1/);
      assert.match(body2, /call_1_2/);
      assert.equal(versions_of_run(env, res.run_id).length, 1, "only the allowed result.submit wrote anything");
    } finally {
      await decoy.close();
    }
  });
});

test("a runaway loop stops at the turn cap and fails the run", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await ready_project(env);
    const opened = await open_stage(env, "plan");
    env.fake.script = () => context_turn();
    const res = await start_run(env, { stage_id: opened.stage_id, round_id: opened.round_id, max_turns: 3 });
    assert.equal(res.status, "failed");
    assert.equal(env.fake.calls.length, 3, "exactly max_turns model calls were made");
    assert.equal(run_row(env, res.run_id).status, "failed");
    assert.equal(lease_state(env)?.state, "released");
  });
});

test("one run, one model: a failing model never falls back, and a new selection only affects the next run", async () => {
  await with_a_env("openai_compatible", async (env) => {
    const dto = await ready_project(env, {}, MODEL_A);
    const opened = await open_stage(env, "plan");
    // the human switches the selection while call 1 is in flight; the running run keeps its model
    env.fake.on_call = async (n) => {
      if (n === 1) await select_model(env, dto.connection_id, MODEL_B);
    };
    set_script(env, [context_turn(), submit_turn(opened.object_id, "합성"), FINISH]);
    const first = await start_run(env, { stage_id: opened.stage_id, round_id: opened.round_id });
    assert.equal(first.status, "succeeded");
    assert.deepEqual([...new Set(models_sent(env))], [MODEL_A]);
    assert.equal(run_row(env, first.run_id).model, MODEL_A);
    await close_stage(env, opened, "plan", versions_of_run(env, first.run_id));

    // a provider error on the selected model: the run fails, nothing is sent to the other model
    env.fake.on_call = undefined;
    const second_open = await open_stage(env, "research");
    const before = env.fake.calls.length;
    set_script(env, [{ http: { status: 400, body: { error: { message: "model_not_found", type: "invalid_request_error", code: "model_not_found" } } } }]);
    const second = await start_run(env, { stage_id: second_open.stage_id, round_id: second_open.round_id });
    assert.equal(run_row(env, second.run_id).model, MODEL_B, "the next run uses the new selection");
    assert.equal(second.status, "failed");
    assert.equal(env.fake.calls.length, before + 1, "one attempt, no retry, no fallback");
    assert.deepEqual(models_sent(env).slice(before), [MODEL_B]);
    assert.equal(dispatches(env, second.run_id).length, 1);
    assert.equal(dispatches(env, second.run_id)[0]!.state, "failed");
  });
});

test("an interrupted run stops sending: no further model call after the lease is lost", async () => {
  await with_a_env("openai_compatible", async (env: AEnv) => {
    await ready_project(env);
    const opened = await open_stage(env, "plan");
    env.fake.on_call = async (n) => {
      if (n !== 1) return;
      const lease = env.db.get<{ lease_id: string; fence: bigint; run_id: string }>(
        "SELECT lease_id, fence, run_id FROM project_leases WHERE project_id = ?",
        env.p.project_id,
      )!;
      await interrupt(env.service, env.agent_ctx(env.ai_actor_id, "ext-interrupt"), {
        run_id: lease.run_id,
        lease_id: lease.lease_id,
        fence: Number(lease.fence),
      });
    };
    set_script(env, [context_turn(), submit_turn(opened.object_id, "합성"), FINISH]);
    const res = await start_run(env, { stage_id: opened.stage_id, round_id: opened.round_id });
    assert.equal(res.status, "interrupted");
    assert.equal(run_row(env, res.run_id).status, "interrupted");
    assert.equal(env.fake.calls.length, 1, "the loop did not call the model again after the interrupt");
    assert.notEqual(lease_state(env)?.state, "active");
    assert.equal(versions_of_run(env, res.run_id).length, 0, "nothing was written with the lost lease");
    for (const d of dispatches(env, res.run_id)) {
      assert.ok(["response", "unknown", "failed", "blocked"].includes(d.state), `no dispatch left half-sent: ${d.state}`);
    }
  });
});
