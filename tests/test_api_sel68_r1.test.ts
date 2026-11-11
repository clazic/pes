/**
 * SEL-68 r1 권장 1~4 (작성 모드) — 1차 리뷰(.ai-review.md)의 권장을 leader 결정대로 못 박는다. 합성 자료만.
 *
 *  1  코어 run.claim(새 run·run_id 둘 다)·run.create 도 mode A 면 Go 정책 검사를 돈다(actor 종류 무관, API 의
 *     `#require_go` 와 같은 규칙). Go OFF 에서 internal_ai 가 CLI/코어로 mode A 를 청하면 ApiError `policy_denied`
 *     (코어의 닫힌 오류 코드 목록의 이름; API 는 같은 거절을 `policy_blocked` 로 내보낸다) 이고 상태 변화 0.
 *     Go ON 이면 정상(회귀).
 *  2  오류 순서가 API 와 코어에서 같다: external/human + mode A + 잘못된 provider → 둘 다 403 forbidden(권한 먼저).
 *     internal_ai + mode A + 잘못된 provider → 둘 다 400 invalid_payload.
 *  3  새 403 forbidden 봉투에 target 과 details.actor_kind 가 실린다.
 *       새 claim / run 생성: mode A 면 `$.body.mode`, 아니면 Go 라벨이 있는 칸 — provider 면 `$.body.provider`,
 *       model 이면 `$.body.model`. run_id claim: `$.body.run_id`.
 *       details.actor_kind: claim 은 호출자의 종류, POST /runs 는 run 을 받을 대상 actor 의 종류(거절 이유가 그 종류이므로).
 *  4  Go 라벨 접기 판정이 한 곳: commands/shared.ts 가 `fold_go_label` 을 export 하고 adapters/opencode_tui.ts 의
 *     on_go_route 가 그것을 import 해 쓴다(NFKC·\p{Cf} 복제 없음). 두 판정의 규칙 차이(TUI 는 넓게, 서버는 provider 정확·
 *     model 접두)는 그대로다.
 *
 * 지금 실패해야 정상인 것: 1 전부, 2 의 코어 쪽 external/human, 3 전부, 4 전부. 나머지는 회귀 보호(통과).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { issue_agent_token } from "../scripts/pes_core/actors.ts";
import { opencode_tui_mcp_entry } from "../scripts/pes_core/adapters/opencode_tui.ts";
import * as shared from "../scripts/pes_core/commands/shared.ts";
import { set_policy } from "../scripts/pes_core/policy.ts";
import { assert_error, assert_ok, call, go_off, make_agent, with_api, type ApiEnv, type ApiResponse, type Auth } from "./helpers/api_env.ts";
import { P } from "./helpers/api_flow.ts";
import { SERVER_SCRIPT, API_BASE_URL } from "./helpers/adapter_b_cli_suite.ts";
import { expect_rejected, json_out, with_cli, SLUG } from "./helpers/cli_write_env.ts";
import { state_signature } from "./helpers/state_signature.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const GO_MODEL = "opencode-go/deepseek-v4.1-flash";
const A_BODY = { mode: "A", runtime: "synthetic-runtime", provider: "opencode-go", model: GO_MODEL };
const A_WRONG_PROVIDER = { mode: "A", runtime: "pes_builtin", provider: "synthetic", model: "synthetic-model" };

const claim = (env: ApiEnv, auth: Auth, body: unknown): Promise<ApiResponse> =>
  call(env, { method: "POST", path: P(env, "/claims"), auth, body });
const create_run = (env: ApiEnv, body: unknown): Promise<ApiResponse> =>
  call(env, { method: "POST", path: P(env, "/runs"), auth: "owner", body });

/** Core command (no HTTP): the same thing the CLI calls. */
function core(env: ApiEnv, actor_id: string, command: "run.claim" | "run.create", input: Record<string, unknown>, key: string) {
  return env.service.execute({ project_id: env.p.project_id, actor_id, via: "cli", client_request_id: key }, command, input);
}

async function core_error(promise: Promise<unknown>): Promise<{ code: string; details: unknown }> {
  try {
    await promise;
  } catch (error: any) {
    return { code: String(error?.code), details: error?.details };
  }
  assert.fail("the core command was expected to be refused");
}

async function human_actor_id(env: ApiEnv): Promise<string> {
  return env.p.actor_id;
}

// ---------------------------------------------------------------------------
// 1) core run.claim / run.create run the Go policy for mode A (actor kind does not matter)

test("SEL-68 r1 #1 core: run.claim mode A by internal_ai with Go OFF -> policy_denied, nothing written", async () => {
  await with_api(async (env) => {
    const int = await make_agent(env, "c1-int", undefined, "internal_ai");
    await go_off(env);
    const before = state_signature(env.db);
    const err = await core_error(core(env, int.actor_id, "run.claim", { ...A_BODY }, "c1-claim"));
    assert.equal(err.code, "policy_denied");
    assert.equal(state_signature(env.db), before, "no receipt, lease or run");
    // the same key sent again is refused again and still writes nothing
    assert.equal((await core_error(core(env, int.actor_id, "run.claim", { ...A_BODY }, "c1-claim"))).code, "policy_denied");
    assert.equal(state_signature(env.db), before);
  });
});

test("SEL-68 r1 #1 core: run_id claim of a mode A run with Go OFF -> policy_denied, nothing written", async () => {
  await with_api(async (env) => {
    const int = await make_agent(env, "c1-rid", undefined, "internal_ai");
    const made = assert_ok(await create_run(env, { actor_id: int.actor_id, ...A_BODY }), 201);
    await go_off(env);
    const before = state_signature(env.db);
    const err = await core_error(core(env, int.actor_id, "run.claim", { run_id: made.run_id }, "c1-rid-claim"));
    assert.equal(err.code, "policy_denied");
    assert.equal(state_signature(env.db), before);
  });
});

test("SEL-68 r1 #1 core: run.create mode A for an internal_ai target with Go OFF -> policy_denied, nothing written", async () => {
  await with_api(async (env) => {
    const int = await make_agent(env, "c1-create", undefined, "internal_ai");
    await go_off(env);
    const before = state_signature(env.db);
    const err = await core_error(core(env, await human_actor_id(env), "run.create", { actor_id: int.actor_id, ...A_BODY }, "c1-create"));
    assert.equal(err.code, "policy_denied");
    assert.equal(state_signature(env.db), before);
  });
});

test("SEL-68 r1 #1 core: with Go ON the same core claims and create succeed (regression)", async () => {
  await with_api(async (env) => {
    const int = await make_agent(env, "c1-on", undefined, "internal_ai");
    const claimed = await core(env, int.actor_id, "run.claim", { ...A_BODY }, "c1-on-claim");
    const row = env.db.get<{ mode: string; actor_id: string }>("SELECT mode, actor_id FROM runs WHERE id = ?", (claimed.result as any).run_id);
    assert.deepEqual({ ...row }, { mode: "A", actor_id: int.actor_id });
    const int2 = await make_agent(env, "c1-on2", undefined, "internal_ai");
    const created = await core(env, await human_actor_id(env), "run.create", { actor_id: int2.actor_id, ...A_BODY }, "c1-on-create");
    assert.ok((created.result as any).run_id);
  });
});

test("SEL-68 r1 #1 core: a mode B claim is not touched by the Go policy (Go OFF still claims)", async () => {
  await with_api(async (env) => {
    const int = await make_agent(env, "c1-b", undefined, "internal_ai");
    await go_off(env);
    const out = await core(env, int.actor_id, "run.claim", { mode: "B", runtime: "synthetic-runtime", provider: "synthetic", model: "synthetic-model" }, "c1-b-claim");
    assert.ok((out.result as any).run_id);
  });
});

test("SEL-68 r1 #1 API: internal_ai + Go OFF stays policy_blocked on claim / run_id claim / create (regression)", async () => {
  await with_api(async (env) => {
    const int = await make_agent(env, "a1-int", undefined, "internal_ai");
    const made = assert_ok(await create_run(env, { actor_id: int.actor_id, ...A_BODY }), 201);
    await go_off(env);
    const before = state_signature(env.db);
    assert_error(await claim(env, { token: int.token }, A_BODY), 403, "policy_blocked");
    assert_error(await claim(env, { token: int.token }, { run_id: made.run_id }), 403, "policy_blocked");
    assert_error(await create_run(env, { actor_id: int.actor_id, ...A_BODY }), 403, "policy_blocked");
    assert.equal(state_signature(env.db), before);
  });
});

test("SEL-68 r1 #1 CLI: internal_ai `claim --mode A` with Go OFF is refused (policy), nothing written; Go ON works", async () => {
  await with_cli(async (c) => {
    const owner = c.env.db.get<{ owner_user_id: string }>("SELECT owner_user_id FROM projects WHERE id = ?", c.env.p.project_id);
    assert.ok(owner);
    c.env.db.run("INSERT INTO actors (id, kind, user_id, display_name) VALUES (?, 'internal_ai', ?, ?)", "agent-cli-int", owner.owner_user_id, "합성 내부 AI");
    const token = ((await issue_agent_token(c.env.service, c.env.ctx("cli-int-token"), {
      actor_id: "agent-cli-int",
      scopes: ["context:read", "run:claim", "run:submit", "file:write", "file:read"],
    })).result as { token: string }).token;
    const flags = ["--mode", "A", "--runtime", "pes_builtin", "--provider", "opencode-go", "--model", GO_MODEL];

    await set_policy(c.env.service, c.env.ctx("cli-go-off"), { allow_opencode_go: false, reason: "합성: Go 끄기" });
    const before = state_signature(c.env.db);
    const commits = c.commits().length;
    const res = c.run(["claim", SLUG, ...flags], { PES_TOKEN: token });
    expect_rejected(res, "Go OFF");
    assert.match(res.stderr + res.stdout, /policy_denied|policy_blocked/, "the refusal names the Go policy");
    assert.equal(state_signature(c.env.db), before, "no run, lease or receipt");
    assert.equal(c.commits().length, commits);

    await set_policy(c.env.service, c.env.ctx("cli-go-on"), { allow_opencode_go: true, reason: "합성: Go 켜기" });
    const claimed = json_out(c.run(["claim", SLUG, ...flags], { PES_TOKEN: token }));
    assert.match(String(claimed.fence), /^[1-9][0-9]*$/);
    assert.equal(c.env.db.get<{ mode: string }>("SELECT mode FROM runs WHERE id = ?", claimed.run_id)?.mode, "A");
  });
});

// ---------------------------------------------------------------------------
// 2) same error order in the API and the core: permission (403) before the mode A shape (400)

test("SEL-68 r1 #2 API: external / human + mode A + wrong provider -> 403 forbidden; internal_ai -> 400 invalid_payload", async () => {
  await with_api(async (env) => {
    const ext = await make_agent(env, "o2-ext");
    const int = await make_agent(env, "o2-int", undefined, "internal_ai");
    const before = state_signature(env.db);
    assert_error(await claim(env, { token: ext.token }, A_WRONG_PROVIDER), 403, "forbidden");
    assert_error(await create_run(env, { actor_id: ext.actor_id, ...A_WRONG_PROVIDER, runtime: "synthetic-runtime" }), 403, "forbidden");
    assert_error(await claim(env, { token: int.token }, A_WRONG_PROVIDER), 400, "invalid_payload");
    assert_error(await create_run(env, { actor_id: int.actor_id, ...A_WRONG_PROVIDER, runtime: "synthetic-runtime" }), 400, "invalid_payload");
    assert.equal(state_signature(env.db), before);
    await go_off(env);
    // the shape error still comes before the Go policy
    assert_error(await claim(env, { token: int.token }, A_WRONG_PROVIDER), 400, "invalid_payload");
    assert_error(await claim(env, { token: ext.token }, A_WRONG_PROVIDER), 403, "forbidden");
  });
});

test("SEL-68 r1 #2 core: external / human + mode A + wrong provider -> forbidden; internal_ai -> invalid_payload", async () => {
  await with_api(async (env) => {
    const ext = await make_agent(env, "o2c-ext");
    const int = await make_agent(env, "o2c-int", undefined, "internal_ai");
    const human = await human_actor_id(env);
    const before = state_signature(env.db);
    const runtime = { runtime: "synthetic-runtime" };
    assert.equal((await core_error(core(env, ext.actor_id, "run.claim", { ...A_WRONG_PROVIDER }, "o2c-1"))).code, "forbidden");
    assert.equal((await core_error(core(env, human, "run.claim", { ...A_WRONG_PROVIDER }, "o2c-2"))).code, "forbidden");
    assert.equal((await core_error(core(env, human, "run.create", { actor_id: ext.actor_id, ...A_WRONG_PROVIDER, ...runtime }, "o2c-3"))).code, "forbidden");
    assert.equal((await core_error(core(env, int.actor_id, "run.claim", { ...A_WRONG_PROVIDER }, "o2c-4"))).code, "invalid_payload");
    assert.equal((await core_error(core(env, human, "run.create", { actor_id: int.actor_id, ...A_WRONG_PROVIDER, ...runtime }, "o2c-5"))).code, "invalid_payload");
    assert.equal(state_signature(env.db), before);
  });
});

// ---------------------------------------------------------------------------
// 3) the new 403 forbidden envelope carries target and details.actor_kind

test("SEL-68 r1 #3 API: claim mode A (any provider) -> target $.body.mode, details.actor_kind", async () => {
  await with_api(async (env) => {
    const ext = await make_agent(env, "t3-ext");
    for (const body of [A_BODY, A_WRONG_PROVIDER, { ...A_BODY, runtime: "pes_builtin" }]) {
      const error = assert_error(await claim(env, { token: ext.token }, body), 403, "forbidden");
      assert.equal(error.target, "$.body.mode");
      assert.equal(error.details?.actor_kind, "external_agent");
    }
  });
});

test("SEL-68 r1 #3 API: claim mode B with a Go label -> target is the Go-labelled field", async () => {
  await with_api(async (env) => {
    const ext = await make_agent(env, "t3-label");
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["provider", { mode: "B", runtime: "synthetic-runtime", provider: "opencode-go", model: "synthetic-model" }, "$.body.provider"],
      ["folded provider", { mode: "B", runtime: "synthetic-runtime", provider: " OpenCode_Go ", model: "synthetic-model" }, "$.body.provider"],
      ["model", { mode: "B", runtime: "synthetic-runtime", provider: "synthetic", model: GO_MODEL }, "$.body.model"],
      ["folded model", { mode: "B", runtime: "synthetic-runtime", provider: "synthetic", model: "ＯＰＥＮＣＯＤＥ-go/x" }, "$.body.model"],
    ];
    for (const [label, body, target] of cases) {
      const error = assert_error(await claim(env, { token: ext.token }, body), 403, "forbidden");
      assert.equal(error.target, target, label);
      assert.equal(error.details?.actor_kind, "external_agent", label);
    }
  });
});

test("SEL-68 r1 #3 API: run_id claim of an A run or a Go-labelled run -> target $.body.run_id", async () => {
  await with_api(async (env) => {
    const ext = await make_agent(env, "t3-rid");
    const int = await make_agent(env, "t3-rid-int", undefined, "internal_ai");
    const a_run = assert_ok(await create_run(env, { actor_id: int.actor_id, ...A_BODY }), 201).run_id as string;
    for (const run_id of [a_run]) {
      const error = assert_error(await claim(env, { token: ext.token }, { run_id }), 403, "forbidden");
      assert.equal(error.target, "$.body.run_id");
      assert.equal(error.details?.actor_kind, "external_agent");
    }
    // the human owner's session too
    const owner_error = assert_error(await claim(env, "owner", { run_id: a_run }), 403, "forbidden");
    assert.equal(owner_error.target, "$.body.run_id");
    assert.equal(typeof owner_error.details?.actor_kind, "string");
  });
});

test("SEL-68 r1 #3 API: POST /runs for a non-internal target -> target $.body.mode / provider / model, details.actor_kind of the target", async () => {
  await with_api(async (env) => {
    const ext = await make_agent(env, "t3-create");
    const base = { actor_id: ext.actor_id, runtime: "synthetic-runtime" };
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["mode A", { ...base, ...A_BODY }, "$.body.mode"],
      ["mode A, wrong provider", { ...base, ...A_WRONG_PROVIDER }, "$.body.mode"],
      ["B + provider", { ...base, mode: "B", provider: "opencode-go", model: "synthetic-model" }, "$.body.provider"],
      ["B + model", { ...base, mode: "B", provider: "synthetic", model: GO_MODEL }, "$.body.model"],
    ];
    for (const [label, body, target] of cases) {
      const error = assert_error(await create_run(env, body), 403, "forbidden");
      assert.equal(error.target, target, label);
      assert.equal(error.details?.actor_kind, "external_agent", label);
    }
  });
});

// ---------------------------------------------------------------------------
// 4) one place folds a Go label

const TUI_SRC = readFileSync(join(REPO, "scripts", "pes_core", "adapters", "opencode_tui.ts"), "utf8");
const BASE = { command: process.execPath, server_script: SERVER_SCRIPT, project_id: "synthetic-project-id", api_base_url: API_BASE_URL };

function code_only(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

test("SEL-68 r1 #4 static: opencode_tui.ts has no folding copy and imports the shared fold function", () => {
  const code = code_only(TUI_SRC);
  assert.doesNotMatch(code, /\.normalize\(/, "no NFKC copy in the adapter");
  assert.doesNotMatch(code, /\\p\{Cf\}[^/]*\/gu\s*,\s*""/, "no format-character stripping copy in the adapter");
  assert.doesNotMatch(code, /\\p\{Pd\}/, "no hyphen-folding copy in the adapter");
  assert.match(code, /import\s*\{[^}]*\bfold_go_label\b[^}]*\}\s*from\s*"\.\.\/commands\/shared\.ts"/, "imports fold_go_label from commands/shared.ts");
  assert.match(code, /\bfold_go_label\(/, "on_go_route calls it");
});

test("SEL-68 r1 #4 shared exports fold_go_label with the documented folding", () => {
  const fold = (shared as Record<string, unknown>).fold_go_label;
  assert.equal(typeof fold, "function", "fold_go_label is exported from commands/shared.ts");
  const f = fold as (value: string) => string;
  const table: Array<[string, string]> = [
    ["opencode-go", "opencode-go"],
    ["  OpenCode-Go  ", "opencode-go"],
    ["opencode_go", "opencode-go"],
    ["opencode go", "opencode-go"],
    ["opencode‐go", "opencode-go"],
    ["opencode−go", "opencode-go"],
    ["opencode​-go", "opencode-go"],
    ["opencode­-go", "opencode-go"],
    ["﻿opencode-go", "opencode-go"],
    ["ｏｐｅｎｃｏｄｅ-ｇｏ", "opencode-go"],
    ["-opencode-go", "opencode-go"],
    ["OPENCODE-GO/Deepseek", "opencode-go/deepseek"],
    ["opencodeо-go", "opencodeо-go"], // Cyrillic look-alike stays unfolded
  ];
  for (const [input, expected] of table) assert.equal(f(input), expected, JSON.stringify(input));
});

test("SEL-68 r1 #4 both judgments see the same folded text; their rule difference stays", () => {
  const fold = (shared as Record<string, unknown>).fold_go_label as ((value: string) => string) | undefined;
  assert.equal(typeof fold, "function", "fold_go_label is exported");
  const tui_blocks = (model: string): boolean => {
    try {
      opencode_tui_mcp_entry({ ...BASE, model });
      return false;
    } catch (error: any) {
      if (error?.code === "go_route_blocked") return true;
      return false; // another refusal (input check) — not the Go route
    }
  };
  // [label, TUI blocks (wide), server provider test, server model test]
  const rows: Array<[string, boolean, boolean, boolean]> = [
    ["opencode-go", true, true, false],
    ["OPENCODE-GO", true, true, false],
    [" opencode_go ", true, true, false],
    ["opencode‐go", true, true, false],
    ["opencode​-go", true, true, false],
    ["ｏｐｅｎｃｏｄｅ-ｇｏ", true, true, false],
    ["opencode-go/x", true, false, true],
    ["OpenCode-Go/x", true, false, true],
    ["opencode­-go/x", true, false, true],
    ["ｏｐｅｎｃｏｄｅ-ｇｏ/x", true, false, true],
    ["opencode-go:x", true, false, false], // TUI wide, server needs the exact `opencode-go/` prefix
    ["opencode-go.x", true, false, false],
    ["opencode-goat", false, false, false],
    ["opencode-go2", false, false, false],
    ["opencodeо-go/x", false, false, false], // look-alike: neither side folds it
  ];
  for (const [label, tui, provider, model] of rows) {
    assert.equal(tui_blocks(label), tui, `TUI ${JSON.stringify(label)}`);
    assert.equal(shared.is_go_label(label, "synthetic-model"), provider, `server provider ${JSON.stringify(label)}`);
    assert.equal(shared.is_go_label("synthetic", label), model, `server model ${JSON.stringify(label)}`);
    // one fold: where either side says Go, the folded text starts with the Go name
    if (tui || provider || model) assert.match(fold!(label), /^opencode-go/, JSON.stringify(label));
    else assert.doesNotMatch(fold!(label), /^opencode-go(?![a-z0-9])/, JSON.stringify(label));
  }
});
