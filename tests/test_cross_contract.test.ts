/**
 * SEL-56 PR21 — A·B 교차 계약 (tester, 작성 모드). Source: Linear SEL-56 완료 조건, docs/plan/issues/stage-2-linear.md
 * "PR21" (Agent notes), docs/plan/stage-2-db-guarantees.md 8.16 (PR19 A 실행기·SEL-68) 와 8.17~8.19 (20a·20b·20c),
 * decision 0019. This file is the TABLE part: the same start state, the same step list, run through path A (the
 * built-in runner's own tool path, internal_ai actor) and path B (the MCP server, external_agent, every direct
 * connection of the six tools, plus the explicit hand-off of the three apps), compared by meaning.
 * The expected tables live in tests/fixtures/contracts/cross/*.json (written here as test material).
 *
 * Tools: the PR19 fake AI HTTP server (only started, never needed for this table), the 20a fake MCP client,
 * synthetic data. No real model, no codex exec / claude -p / opencode run, nothing under ~/.claude ~/.codex
 * ~/.config/opencode, no real ~/.pes or ~/pes-projects (temporary HOME / PES_HOME via isolated_home).
 *
 * 해석 (numbered for this issue):
 *  해석 1  "같은 오류 문구" = 같은 오류 code(core 철자)·같은 target·같은 효과(쓰기 0). 문장 글자는 같을 수 없다:
 *          A 도구는 모델에게 core 의 영어 문장을 `code: message` 로 보여 주고, B(HTTP/MCP)는 code 마다 정해진 한국어
 *          문장을 보여 준다. 그래서 문장은 (a) B 의 여섯 도구가 같은 code 에 byte 단위로 같은 한국어 문장을 낸다,
 *          (b) A 는 같은 상태에서 매번 같은 문장을 낸다, (c) 둘 다 SQL·표 이름·스택을 새기지 않는다 로 시험한다.
 *  해석 2  오류 code 철자 세 가지는 같은 뜻으로 묶는다: policy_blocked=policy_denied, human_required/owner_required=
 *          forbidden, lease_lost=conflict. B 쪽 원래 철자는 fixture 의 `b_raw_code` 로 따로 고정한다.
 *  해석 3  옛 guard 거부 code 는 B 안에서도 갈린다: heartbeat·release·input-receipts 는 `lease_lost`, 제출·대기·완료는
 *          `conflict`. 이 표는 현재 동작(둘 다 거부, 쓰기 0)을 고정하고, 철자 통일 여부는 worker/leader 결정으로 둔다.
 *  해석 4  A 도구의 인자 검사 거절(예: results 가 배열이 아님)은 `code:` 접두 없는 문장이다. 이 표는 그것을
 *          invalid_payload 로 본다(B 는 invalid_payload 를 명시).
 *  해석 5  Go 를 끄면 A 만 막히고 B 는 영향이 없다(SEL-68: Go 정책은 mode A 경로의 것). '같은 권한' 항목이 아니라
 *          '의도대로 다른' 항목으로 표에 따로 적었다.
 *  해석 7  한 번의 가져오기(import)는 사건 3개(run.created, result.submitted, run.completed)와 영수증 1개(run.created,
 *          via import)를 남긴다 — 직접 제출은 사건·영수증이 도구 호출마다 따로다. 같은 '결과 사건'이 남는 것만 같은 계약이다.
 *  해석 8  pes_context 의 `policy` 묶음(allow_opencode_go, mode_a_model, go_usage_stop_percent)은 프로젝트 정책 설정이며
 *          B run 의 비용이 아니다. 비용 표시 검사는 그 묶음을 뺀 나머지(run·lease·자료·단계)에 건다.
 *  해석 6  Claude 앱은 직접 연결이 없다(어댑터는 명시적 전달만 한다). '각 도구의 직접 연결 경로 + 앱의 전달 경로'는
 *          표의 `direct`/`handoff` 칸으로 적고, 둘 다 없는 도구가 있으면 실패한다.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { ClaudeAppAdapter } from "../scripts/pes_core/adapters/claude_app.ts";
import { CodexAppAdapter } from "../scripts/pes_core/adapters/codex_app.ts";
import { OpencodeAppAdapter } from "../scripts/pes_core/adapters/opencode_app.ts";
import { set_policy } from "../scripts/pes_core/policy.ts";
import { SESSION_SECRET } from "./helpers/api_env.ts";
import { Driver, type Side, type Step, type StepResult } from "./helpers/cross_driver.ts";
import {
  B_TOOLS,
  dispatch_count,
  event_types_since,
  last_event_seq,
  last_receipt_rowid,
  lease_row,
  next_key,
  ready_cross,
  receipt_actions_since,
  run_info,
  with_cross_env,
  type BTool,
  type CrossEnv,
} from "./helpers/cross_env.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "contracts", "cross");

interface Expect {
  ok?: boolean;
  code?: string | null;
  events?: string[];
  receipts?: string[];
  lease?: string | null;
  run_status?: string | null;
  versions_added?: number;
  b_raw_code?: string;
}
interface FixtureStep extends Step {
  expect: { same?: Expect; A?: Expect; B?: Expect };
}
interface Scenario {
  name: string;
  why: string;
  setup?: string[];
  steps: FixtureStep[];
}
interface Table {
  scenarios: Scenario[];
}
interface ToolTable {
  tools: Array<{
    id: string;
    direct: { runtime: string; provider: string } | null;
    handoff: { runtime: string; provider: string } | null;
  }>;
}

const TABLE = JSON.parse(readFileSync(join(FIXTURES, "same_outcome.json"), "utf8")) as Table;
const TOOLS = JSON.parse(readFileSync(join(FIXTURES, "b_tools.json"), "utf8")) as ToolTable;

const DIRECT_TOOLS = B_TOOLS.filter((t) => t.direct !== null);
const KNOWN_OPS = new Set(["claim", "submit", "ask", "wait", "release", "complete", "heartbeat", "human_only_approve", "human_only_policy"]);

function expected_for(step: FixtureStep, kind: "A" | "B"): Expect {
  return { ...(step.expect.same ?? {}), ...(step.expect[kind] ?? {}) };
}

function check(label: string, got: StepResult, want: Expect, kind: "A" | "B"): void {
  for (const key of ["ok", "code", "events", "receipts", "lease", "run_status", "versions_added"] as const) {
    if (!(key in want)) continue;
    assert.deepEqual(got[key], want[key], `${label}: ${key} (got ${JSON.stringify(got[key])})`);
  }
  if (want.b_raw_code !== undefined && kind === "B") assert.equal(got.raw_code, want.b_raw_code, `${label}: B's own error spelling`);
}

async function run_setup(env: CrossEnv, setup: string[] | undefined): Promise<void> {
  for (const name of setup ?? []) {
    assert.equal(name, "go_off", `unknown setup ${name}`);
    await set_policy(env.service, env.ctx(next_key(env, "go-off")), { allow_opencode_go: false, reason: "합성: Go 끄기" });
  }
}

async function run_scenario(scenario: Scenario, side: Side, format: "openai_compatible" | "anthropic" = "openai_compatible"): Promise<{ trace: StepResult[]; label: string }> {
  const trace: StepResult[] = [];
  let label = "";
  await with_cross_env(format, async (env) => {
    await ready_cross(env);
    await run_setup(env, scenario.setup);
    const driver = new Driver(env, side);
    label = driver.label;
    for (const step of scenario.steps) {
      const got = await driver.step(step);
      trace.push(got);
      check(`${scenario.name} / ${driver.label} / ${step.op}${step.guard ? `:${step.guard}` : ""}`, got, expected_for(step, side.kind), side.kind);
      if (!got.ok && step.op === "claim") break; // nothing to drive without a lease
    }
  });
  return { trace, label };
}

// ---------------------------------------------------------------------------------------------------------
// the tables themselves

test("fixture: scenarios are named once, every op is known, every step states its expectation", () => {
  const names = new Set<string>();
  for (const scenario of TABLE.scenarios) {
    assert.ok(!names.has(scenario.name), `duplicate scenario ${scenario.name}`);
    names.add(scenario.name);
    assert.ok(scenario.why.length > 0, `${scenario.name}: says why`);
    assert.ok(scenario.steps.length > 0);
    for (const step of scenario.steps) {
      assert.ok(KNOWN_OPS.has(step.op), `${scenario.name}: op ${step.op}`);
      const e = step.expect;
      assert.ok(e.same !== undefined || (e.A !== undefined && e.B !== undefined), `${scenario.name}/${step.op}: same, or both A and B`);
    }
  }
  assert.ok(TABLE.scenarios.length >= 10, "a table, not a single case");
});

test("fixture: the six B tools are exactly the tools of the issue, each with at least one path", () => {
  assert.deepEqual(
    TOOLS.tools.map((t) => t.id).sort(),
    ["claude_app", "claude_code", "codex_app", "codex_cli", "opencode_app", "opencode_tui"],
  );
  assert.deepEqual(B_TOOLS.map((t) => t.id).sort(), TOOLS.tools.map((t) => t.id).sort(), "the harness knows the same six");
  for (const row of TOOLS.tools) {
    assert.ok(row.direct !== null || row.handoff !== null, `${row.id}: a path`);
    const tool = B_TOOLS.find((t) => t.id === row.id)!;
    assert.deepEqual(tool.direct === null ? null : { runtime: tool.direct.runtime, provider: tool.direct.provider }, row.direct, `${row.id}: direct claim labels come from the adapter's own entry`);
    assert.equal(tool.handoff !== null, row.handoff !== null, `${row.id}: hand-off path`);
  }
});

// ---------------------------------------------------------------------------------------------------------
// 1. the same scenario through A and through every direct B tool

for (const scenario of TABLE.scenarios) {
  test(`table / ${scenario.name}: A and every direct B tool end in the table's state — ${scenario.why}`, async () => {
    const a = await run_scenario(scenario, { kind: "A" });
    const per_tool = new Map<string, StepResult[]>();
    for (const tool of DIRECT_TOOLS) {
      const b = await run_scenario(scenario, { kind: "B", tool });
      per_tool.set(tool.id, b.trace);
    }
    // the five direct B tools leave identical traces (ids, clock and labels aside): the tool name changes nothing
    const first = DIRECT_TOOLS[0]!;
    const base = per_tool.get(first.id)!;
    for (const tool of DIRECT_TOOLS.slice(1)) {
      const other = per_tool.get(tool.id)!;
      assert.equal(other.length, base.length, `${scenario.name}: ${tool.id} ran as many steps as ${first.id}`);
      other.forEach((got, i) => {
        for (const key of ["ok", "code", "raw_code", "message", "events", "receipts", "lease", "run_status", "versions_added"] as const) {
          assert.deepEqual(got[key], base[i]![key], `${scenario.name}: ${tool.id} step ${i} ${key} equals ${first.id}`);
        }
      });
    }
    // A and B agree wherever the table says "same"
    const steps = TABLE.scenarios.find((s) => s.name === scenario.name)!.steps;
    assert.equal(a.trace.length, steps.length, `${scenario.name}: A ran every step`);
    assert.equal(base.length, steps.length, `${scenario.name}: B ran every step`);
    steps.forEach((step, i) => {
      if (step.expect.same === undefined) return;
      assert.ok(a.trace[i] !== undefined && base[i] !== undefined, `${scenario.name} step ${i}: both sides ran it`);
      const keys = Object.keys(step.expect.same).filter((k) => k !== "b_raw_code") as Array<keyof StepResult>;
      for (const key of keys) assert.deepEqual(a.trace[i]![key], base[i]![key], `${scenario.name} step ${i} ${String(key)}: A equals B`);
    });
  });
}

test("table / anthropic request format: the A side of the table does not depend on the provider wire format", async () => {
  for (const name of ["submit_ok", "stale_guard_after_release", "ask_wait_then_stale"]) {
    const scenario = TABLE.scenarios.find((s) => s.name === name)!;
    await run_scenario(scenario, { kind: "A" }, "anthropic");
  }
});

// ---------------------------------------------------------------------------------------------------------
// error wording (해석 1)

test("wording: a B refusal reads the same on all five direct tools (Korean, no SQL), an A refusal is the stable core sentence", async () => {
  const wanted = new Map<string, Set<string>>();
  const a_messages = new Map<string, Set<string>>();
  for (const scenario of TABLE.scenarios) {
    if (scenario.setup !== undefined) continue;
    for (const side of [{ kind: "A" }, ...DIRECT_TOOLS.map((tool) => ({ kind: "B", tool }))] as Side[]) {
      const { trace } = await run_scenario(scenario, side);
      for (const got of trace) {
        if (got.ok || got.message === null || got.raw_code === null) continue;
        assert.doesNotMatch(got.message, /SELECT |INSERT |UPDATE |DELETE |sqlite|node_modules|\.ts:\d|at \S+ \(/i, "no SQL or stack text");
        if (side.kind === "B") {
          assert.match(got.message, /[가-힣]/, `B ${got.raw_code}: Korean`);
          if (got.raw_code === "invalid_payload") continue; // names the faulty field, so it differs by field
          (wanted.get(got.raw_code) ?? wanted.set(got.raw_code, new Set()).get(got.raw_code)!).add(got.message);
        } else {
          (a_messages.get(`${got.code}`) ?? a_messages.set(`${got.code}`, new Set()).get(`${got.code}`)!).add(got.message);
          assert.match(got.message, /^[\x20-\x7e]+$/, "A shows the English core sentence");
        }
      }
    }
  }
  for (const [code, set] of wanted) assert.equal(set.size, 1, `B ${code}: one Korean sentence across the tools and scenarios (${[...set].join(" | ")})`);
  assert.ok(wanted.size >= 3, "the table exercised several B refusal codes");
  assert.ok(a_messages.get("conflict") !== undefined && a_messages.get("not_found") !== undefined);
  for (const [code, set] of a_messages) {
    if (code === "invalid_payload" || code === "forbidden") continue; // several different fields / actions
    assert.equal(set.size, 1, `A ${code}: same state, same sentence (${[...set].join(" | ")})`);
  }
});

// ---------------------------------------------------------------------------------------------------------
// identity of the run each path leaves (the only place the tool name and the actor may show)

test("identity: A is mode A / pes_builtin / internal_ai; each B direct tool is mode B with its own runtime label, external_agent, no A tables", async () => {
  await with_cross_env("openai_compatible", async (env) => {
    await ready_cross(env);
    const a = new Driver(env, { kind: "A" });
    await a.step({ op: "claim" });
    const a_run = run_info(env, a.guard!.run_id);
    assert.equal(a_run.mode, "A");
    assert.equal(a_run.runtime, "pes_builtin");
    assert.equal(a_run.actor_id, env.ai_actor_id);
    assert.equal(env.db.get<{ kind: string }>("SELECT kind FROM actors WHERE id = ?", a_run.actor_id)!.kind, "internal_ai");
    assert.equal(env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM ai_run_settings WHERE run_id = ?", a_run.id)!.n, 1n, "an A run has its connection settings snapshot");
    await a.step({ op: "release" });

    for (const tool of DIRECT_TOOLS) {
      const b = new Driver(env, { kind: "B", tool });
      await b.step({ op: "claim" });
      const run = run_info(env, b.guard!.run_id);
      assert.equal(run.mode, "B", tool.id);
      assert.equal(run.runtime, tool.direct!.runtime, `${tool.id}: runtime label from the entry`);
      assert.equal(run.provider, tool.direct!.provider, `${tool.id}: provider label from the entry`);
      assert.equal(run.actor_id, env.agent.actor_id);
      assert.equal(env.db.get<{ kind: string }>("SELECT kind FROM actors WHERE id = ?", run.actor_id)!.kind, "external_agent");
      assert.equal(env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM ai_run_settings WHERE run_id = ?", run.id)!.n, 0n, `${tool.id}: no A settings`);
      await b.step({ op: "release" });
    }
    const labels = new Set(
      env.db.all<{ runtime: string }>("SELECT runtime FROM runs WHERE mode = 'B' AND project_id = ?", env.p.project_id).map((r) => r.runtime),
    );
    assert.deepEqual([...labels].sort(), DIRECT_TOOLS.map((t) => t.direct!.runtime).filter((v, i, arr) => arr.indexOf(v) === i).sort());
  });
});

// ---------------------------------------------------------------------------------------------------------
// 7. the hand-off path of the apps (Claude app, Codex app, OpenCode app)

const HANDOFF_ADAPTERS = {
  claude_app: ClaudeAppAdapter,
  codex_app: CodexAppAdapter,
  opencode_app: OpencodeAppAdapter,
} as const;

for (const tool of B_TOOLS.filter((t) => t.handoff !== null)) {
  test(`hand-off / ${tool.id}: the owner's import leaves one hand-off run, no lease, no A tables, and the same result event as a direct submit`, async () => {
    const row = TOOLS.tools.find((t) => t.id === tool.id)!;
    await with_cross_env("openai_compatible", async (env) => {
      const opened = await ready_cross(env);
      const Adapter = HANDOFF_ADAPTERS[tool.handoff!];
      const adapter = new Adapter({ api: env.app, project_id: env.p.project_id, owner_session: SESSION_SECRET });
      const { text } = await adapter.export_bundle({ stage_id: opened.stage_id, round_id: opened.round_id });
      assert.equal(lease_row(env), undefined, "copying a bundle takes no lease");
      const ev = last_event_seq(env);
      const rc = last_receipt_rowid(env);
      const out = await adapter.import_result({
        bundle_text: text,
        result_text: JSON.stringify({ results: [{ op: "append_version", object_id: opened.object_id, title: "앱이 쓴 장" }], claimed: { tool: "synthetic-app", model: "synthetic-model" } }),
      });
      assert.equal(out.status, "imported");
      const run = run_info(env, out.run_id);
      assert.equal(run.mode, "B");
      assert.equal(run.runtime, row.handoff!.runtime);
      assert.equal(run.status, "succeeded");
      assert.equal(env.db.get<{ kind: string }>("SELECT kind FROM actors WHERE id = ?", run.actor_id)!.kind, "human", "an import is the owner's own act");
      assert.equal(env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM mutation_commits WHERE run_id = ? AND via = 'import'", run.id)!.n, 1n);
      assert.deepEqual(event_types_since(env, ev), ["run.created", "result.submitted", "run.completed"], "one import = the run, the result and its end, in one step");
      assert.deepEqual(receipt_actions_since(env, rc), ["run.created"], "one receipt for the whole import (via import)");
      assert.equal(env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM ai_run_settings WHERE run_id = ?", run.id)!.n, 0n);
      assert.equal(dispatch_count(env, run.id), 0, "no dispatch row: PES sent nothing outward for this run");
      assert.equal(lease_row(env), undefined, "an import takes no lease and so blocks no one");
      // a direct client can claim right away: the import left nothing behind
      const direct = DIRECT_TOOLS[0]!;
      const next = new Driver(env, { kind: "B", tool: direct });
      const claim = await next.step({ op: "claim" });
      assert.equal(claim.ok, true);
    });
  });
}

test("hand-off / the same bundle imported twice is refused and adds nothing", async () => {
  await with_cross_env("openai_compatible", async (env) => {
    const opened = await ready_cross(env);
    const adapter = new ClaudeAppAdapter({ api: env.app, project_id: env.p.project_id, owner_session: SESSION_SECRET });
    const { text } = await adapter.export_bundle({ stage_id: opened.stage_id, round_id: opened.round_id });
    const result_text = JSON.stringify({ results: [{ op: "append_version", object_id: opened.object_id, title: "한 번만" }] });
    await adapter.import_result({ bundle_text: text, result_text });
    const versions = env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM object_versions WHERE object_id = ?", opened.object_id)!.n;
    await assert.rejects(adapter.import_result({ bundle_text: text, result_text }), (e: any) => e?.code === "duplicate_import");
    assert.equal(env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM object_versions WHERE object_id = ?", opened.object_id)!.n, versions, "no second version");
  });
});

// ---------------------------------------------------------------------------------------------------------
// 8. B's outside cost is never shown as something PES enforced

const COST_WORDS = /cost|price|spent|spend|billing|usage|token_count|tokens_used|dispatch|stop_percent|cost_cap|비용|요금|사용량|과금/i;

test("cost: a B run has no dispatch row, no usage, no price, no A settings; no API/MCP answer about it carries a cost field", async () => {
  await with_cross_env("openai_compatible", async (env) => {
    const opened = await ready_cross(env);
    const dispatches_before = dispatch_count(env);
    const transcripts: unknown[] = [];
    const run_ids: string[] = [];
    for (const tool of DIRECT_TOOLS) {
      const client = await env.mcp_client(tool);
      const claim = await client.ok("pes_claim", { idempotency_key: `cost-claim-${tool.id}` });
      run_ids.push(claim.run_id);
      transcripts.push(claim);
      const context = await client.ok("pes_context", {});
      delete context.policy; // 해석 8: project-level policy settings, not this run's cost
      transcripts.push(context);
      transcripts.push(await client.ok("pes_submit", { idempotency_key: `cost-sub-${tool.id}`, results: [{ op: "append_version", object_id: opened.object_id, title: `${tool.id} 결과` }] }));
      transcripts.push(await client.ok("pes_heartbeat", { idempotency_key: `cost-hb-${tool.id}` }));
      transcripts.push(await client.ok("pes_complete", { idempotency_key: `cost-done-${tool.id}` }));
    }
    for (const answer of transcripts) {
      const keys = [...JSON.stringify(answer).matchAll(/"([A-Za-z_]+)":/g)].map((m) => m[1]!);
      for (const key of keys) assert.doesNotMatch(key, COST_WORDS, `no cost-like field name in an MCP answer: ${key}`);
    }
    assert.equal(dispatch_count(env), dispatches_before, "B work wrote no outbound dispatch");
    for (const id of run_ids) {
      assert.equal(dispatch_count(env, id), 0);
      assert.equal(env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM ai_run_settings WHERE run_id = ?", id)!.n, 0n);
    }
    // events and receipts of B runs carry no usage / cost
    const rows = env.db.all<{ payload: string }>(
      `SELECT payload FROM events WHERE project_id = ? AND run_id IN (${run_ids.map(() => "?").join(",")})`,
      env.p.project_id,
      ...run_ids,
    );
    for (const row of rows) assert.doesNotMatch(Object.keys(JSON.parse(row.payload)).join(","), COST_WORDS, "no cost key in a B event payload");
    // the change feed and the owner's view of the runs say the same
    const changes = await env.app.handle({ method: "GET", path: `/api/v1/projects/${env.p.project_id}/changes`, headers: { "x-pes-session": SESSION_SECRET }, body: null });
    assert.equal(changes.status, 200);
    const keys = [...JSON.stringify(changes.json, (_k, v) => (_k === "policy" ? undefined : v)).matchAll(/"([A-Za-z_]+)":/g)].map((m) => m[1]!);
    for (const key of keys) assert.doesNotMatch(key, COST_WORDS, `no cost-like field in /changes: ${key}`);
  });
});

test("cost: the B surface (MCP server and the six adapters' code) never reads or prints the A cost bookkeeping", () => {
  // The B side must not be able to show a cost it does not have: it has no path to the dispatch / price / usage tables.
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "pes_core");
  const files = [
    "mcp_server.ts",
    "adapters/claude_code.ts",
    "adapters/claude_app.ts",
    "adapters/codex_cli.ts",
    "adapters/codex_app.ts",
    "adapters/opencode_tui.ts",
    "adapters/opencode_app.ts",
    "adapters/cli_common.ts",
    "adapters/api_client.ts",
  ];
  for (const file of files) {
    const text = readFileSync(join(ROOT, file), "utf8");
    assert.doesNotMatch(text, /cost_json|amount_micros|outbound_dispatches|ai_run_settings|usage_json|dispatch_resolutions|ai_connection_prices/, `${file}: no cost / dispatch bookkeeping`);
  }
});
