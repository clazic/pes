/**
 * SEL-68 최종 리뷰 1/2 필수 2건 (작성 모드) — 합성 자료만. 기존 시험은 건드리지 않는다.
 *
 *  1  접기 조합 우회: provider/model 에 "공백(스페이스·탭·NBSP U+00A0·전각 U+3000) + Cf(U+200B·U+FEFF·U+2060)" 를
 *     앞·뒤·양쪽·사이에 섞은 Go 라벨은 접은 뒤 정확히 Go 라벨이어야 한다(fold 후 앞뒤 공백을 다시 떼고 구분자를 접는다).
 *     external·human 의 새 claim(mode B), POST /runs(외부 actor 대상), 그런 라벨로 저장된 run 의 run_id claim 은
 *     API·코어(CLI) 모두 403 forbidden, 상태 변화 0. fold 는 고정점(fold(fold(x)) === fold(x)).
 *  2  코어 영수증 재전송 전 현재 검사: 성공한 mode A claim / run_id claim / run.create 의 같은 키 재전송은, 그 사이 Go 가 꺼졌으면
 *     policy_denied, actor 종류가 external_agent 로 바뀌었으면 forbidden(둘 다이면 권한이 먼저) — 재전송 결과가 아니며 상태 변화 0.
 *     검사를 통과하는 재전송은 기존대로 replayed:true 와 원래 결과를 그대로 돌려주고 새 행이 없다.
 *
 * 해석 1: Go OFF → 다시 ON 이면 같은 키 재전송은 원래 결과(replayed:true, 깊은 비교 동일)를 돌려준다(영수증은 지워지지 않는다).
 * 해석 2: actor 가 external 로 강등됐다가 internal_ai 로 되돌려지면 같은 이유로 원래 결과를 돌려준다.
 * 해석 3: 접힌 결과의 정확한 문자열은 provider 만 단언한다(`opencode-go`, 끝 구분자 없음). model 은 접두(`opencode-go/`) 판정만.
 * 해석 4: 코어 거절 코드는 이름으로 단언한다 — 권한 `forbidden`, Go 정책 `policy_denied`.
 *
 * Windows: 외부 프로세스·경로·줄바꿈을 쓰지 않는 순수 인-프로세스 시험이다(UTF-8 문제 없음).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { fold_go_label } from "../scripts/pes_core/commands/shared.ts";
import { assert_error, assert_ok, call, go_off, make_agent, with_api, type ApiEnv, type ApiResponse, type Auth } from "./helpers/api_env.ts";
import { P } from "./helpers/api_flow.ts";
import { state_signature } from "./helpers/state_signature.ts";

const GO_MODEL = "opencode-go/deepseek-v4.1-flash";
const A_BODY = { mode: "A", runtime: "synthetic-runtime", provider: "opencode-go", model: GO_MODEL };

const claim = (env: ApiEnv, auth: Auth, body: unknown): Promise<ApiResponse> =>
  call(env, { method: "POST", path: P(env, "/claims"), auth, body });
const create_run = (env: ApiEnv, body: unknown): Promise<ApiResponse> =>
  call(env, { method: "POST", path: P(env, "/runs"), auth: "owner", body });

/** Core command (no HTTP): the same thing the CLI calls. Returns {result, replayed}. */
function core(env: ApiEnv, actor_id: string, command: "run.claim" | "run.create", input: Record<string, unknown>, key: string) {
  return env.service.execute({ project_id: env.p.project_id, actor_id, via: "cli", client_request_id: key }, command, input);
}
async function core_code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error: any) {
    return String(error?.code);
  }
  return "(no error)";
}
const human_id = (env: ApiEnv): string => env.p.actor_id;

/** The project holds one active lease at a time: give it back through the API so the next claim can run. */
async function release(env: ApiEnv, token: string, out: { result: unknown }): Promise<void> {
  const r = out.result as { run_id: string; lease_id: string; fence: string };
  assert_ok(await call(env, { method: "POST", path: P(env, `/runs/${r.run_id}/release`), auth: { token }, body: { lease_id: r.lease_id, fence: String(r.fence) } }));
}

// ---------------------------------------------------------------------------
// 1) fold combinations

const WS = [" ", "\t", " ", "　"];
const CF = ["​", "﻿", "⁠"];
const PADS: string[] = [];
for (const w of WS) for (const c of CF) PADS.push(w + c, c + w, w + c + w, c + w + c);

/** provider spellings: pad before / after / both / between the words (and after the hyphen). */
const PROVIDERS: string[] = [];
for (const p of PADS) PROVIDERS.push(`${p}opencode-go`, `opencode-go${p}`, `${p}opencode-go${p}`, `opencode${p}go`, `opencode-${p}go`);
const MODELS: string[] = [];
for (const p of PADS) MODELS.push(`${p}opencode-go/x`, `opencode-go${p}/x`, `${p}opencode-go/x${p}`);

/** a small, readable core of the table for the heavier (per-call state) paths */
const CORE_PROVIDERS = ["opencode-go ​", "opencode-go​ ", "opencode-go\t﻿", "opencode-go ⁠", "opencode-go　​", " ​opencode-go", "　﻿opencode-go　﻿", "opencode ​go"];

test("SEL-68 final1 #1 fold: every whitespace+Cf combination of a provider folds to exactly opencode-go; models keep the prefix", () => {
  for (const p of PROVIDERS) assert.equal(fold_go_label(p), "opencode-go", JSON.stringify(p));
  for (const m of MODELS) assert.ok(fold_go_label(m).startsWith("opencode-go/"), JSON.stringify(m));
  // a different word is not turned into a Go label
  for (const p of PADS) {
    assert.notEqual(fold_go_label(`${p}opencode-gox${p}`), "opencode-go");
    assert.notEqual(fold_go_label(`${p}opencode${p}`), "opencode-go");
  }
});

test("SEL-68 final1 #1 fold: fold is a fixed point (fold(fold(x)) === fold(x)) over the table and a deterministic random sweep", () => {
  for (const x of [...PROVIDERS, ...MODELS, "", " ", "​", "-", " - ", "a​ ", " ​ ", "OpenCode－go ", "opencode_go　"]) {
    const once = fold_go_label(x);
    assert.equal(fold_go_label(once), once, JSON.stringify(x));
    assert.equal(once, once.trim(), `no surrounding whitespace: ${JSON.stringify(x)}`);
    assert.ok(!/\p{Cf}/u.test(once), `no format chars: ${JSON.stringify(x)}`);
  }
  const alphabet = ["o", "p", "G", "-", "_", "/", "x", "‑", "−", ...WS, ...CF, "­", "ｏ", "9"];
  let seed = 123456789;
  const next = (): number => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed;
  };
  for (let i = 0; i < 4000; i++) {
    const len = next() % 9;
    let s = "";
    for (let j = 0; j < len; j++) s += alphabet[next() % alphabet.length];
    const once = fold_go_label(s);
    assert.equal(fold_go_label(once), once, JSON.stringify(s));
  }
});

test("SEL-68 final1 #1 API: whitespace+Cf combined provider/model as mode B -> 403 forbidden for external token and owner, nothing written", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "f1-claim");
    const before = state_signature(env.db);
    const bodies: Array<[string, Record<string, unknown>]> = [
      ...PROVIDERS.map((provider): [string, Record<string, unknown>] => [`provider ${JSON.stringify(provider)}`, { mode: "B", runtime: "codex_cli", provider, model: "plain-model" }]),
      ...MODELS.map((model): [string, Record<string, unknown>] => [`model ${JSON.stringify(model)}`, { mode: "B", runtime: "codex_cli", provider: "synthetic", model }]),
    ];
    for (const [label, body] of bodies) {
      assert_error(await claim(env, { token: agent.token }, body), 403, "forbidden");
      assert_error(await claim(env, "owner", body), 403, "forbidden");
      if (label.length % 7 === 0) assert.equal(state_signature(env.db), before, label);
    }
    assert.equal(state_signature(env.db), before);
  });
});

test("SEL-68 final1 #1 API: POST /runs with such a label for an external actor or the human is 403 forbidden, nothing written", async () => {
  await with_api(async (env) => {
    const ext = await make_agent(env, "f1-run");
    const before = state_signature(env.db);
    for (const provider of PROVIDERS) {
      for (const actor_id of [ext.actor_id, human_id(env)]) {
        const res = await create_run(env, { actor_id, mode: "B", runtime: "synthetic-runtime", provider, model: "plain" });
        assert.equal(res.status, 403, `${JSON.stringify(provider)} ${actor_id}: ${res.status}`);
        assert.equal(res.json.error.code, "forbidden");
      }
    }
    for (const model of MODELS) {
      const res = await create_run(env, { actor_id: ext.actor_id, mode: "B", runtime: "synthetic-runtime", provider: "synthetic", model });
      assert.equal(res.status, 403, JSON.stringify(model));
      assert.equal(res.json.error.code, "forbidden");
    }
    assert.equal(state_signature(env.db), before);
  });
});

function store_labeled_runs(env: ApiEnv, actor_id: string, labels: Array<[string, string, string]>): void {
  const edition = env.db.get<{ active_edition_id: string }>("SELECT active_edition_id FROM projects WHERE id = ?", env.p.project_id)!;
  for (const [id, provider, model] of labels) {
    env.db.run(
      `INSERT INTO runs (id, project_id, edition_id, actor_id, mode, runtime, provider, model, role, status, base_control_rev, started_at)
       VALUES (?, ?, ?, ?, 'B', 'synthetic-runtime', ?, ?, 'worker', 'queued', 0, 1)`,
      id,
      env.p.project_id,
      edition.active_edition_id,
      actor_id,
      provider,
      model,
    );
  }
}

test("SEL-68 final1 #1 API: a stored run labelled with a combined spelling cannot be taken by run_id (external token and owner)", async () => {
  await with_api(async (env) => {
    const ext = await make_agent(env, "f1-rid");
    const labels = CORE_PROVIDERS.map((p, i): [string, string, string] => [`stored-p-${i}`, p, "plain"]);
    labels.push(["stored-m-0", "synthetic", "　​opencode-go/x"], ["stored-m-1", "synthetic", "opencode-go ﻿/x"]);
    store_labeled_runs(env, ext.actor_id, labels);
    const before = state_signature(env.db);
    for (const [id] of labels) {
      assert_error(await claim(env, { token: ext.token }, { run_id: id }), 403, "forbidden");
      assert_error(await claim(env, "owner", { run_id: id }), 403, "forbidden");
    }
    assert.equal(state_signature(env.db), before);
  });
});

test("SEL-68 final1 #1 core: new claim / run.create / run_id claim with such labels -> forbidden for external and human, nothing written", async () => {
  await with_api(async (env) => {
    const ext = await make_agent(env, "f1-core");
    store_labeled_runs(env, ext.actor_id, CORE_PROVIDERS.map((p, i): [string, string, string] => [`core-stored-${i}`, p, "plain"]));
    const before = state_signature(env.db);
    let k = 0;
    const key = (): string => `f1-core-${k++}`;
    for (const provider of [...CORE_PROVIDERS, ...PROVIDERS.filter((_p, i) => i % 11 === 0)]) {
      const body = { mode: "B", runtime: "codex_cli", provider, model: "plain-model" };
      assert.equal(await core_code(core(env, ext.actor_id, "run.claim", body, key())), "forbidden", `ext claim ${JSON.stringify(provider)}`);
      assert.equal(await core_code(core(env, human_id(env), "run.claim", body, key())), "forbidden", `human claim ${JSON.stringify(provider)}`);
      assert.equal(await core_code(core(env, human_id(env), "run.create", { actor_id: ext.actor_id, ...body, runtime: "synthetic-runtime" }, key())), "forbidden", `create ext ${JSON.stringify(provider)}`);
      assert.equal(await core_code(core(env, human_id(env), "run.create", { actor_id: human_id(env), ...body, runtime: "synthetic-runtime" }, key())), "forbidden", `create human ${JSON.stringify(provider)}`);
    }
    for (const model of MODELS.filter((_m, i) => i % 9 === 0)) {
      const body = { mode: "B", runtime: "codex_cli", provider: "synthetic", model };
      assert.equal(await core_code(core(env, ext.actor_id, "run.claim", body, key())), "forbidden", `ext claim model ${JSON.stringify(model)}`);
      assert.equal(await core_code(core(env, human_id(env), "run.claim", body, key())), "forbidden", `human claim model ${JSON.stringify(model)}`);
    }
    for (let i = 0; i < CORE_PROVIDERS.length; i++) {
      assert.equal(await core_code(core(env, ext.actor_id, "run.claim", { run_id: `core-stored-${i}` }, key())), "forbidden", `stored ${i}`);
    }
    assert.equal(state_signature(env.db), before);
  });
});

test("SEL-68 final1 #1 regression: an unrelated provider with padding / Cf is still an ordinary mode B claim (200)", async () => {
  await with_api(async (env) => {
    const agent = await make_agent(env, "f1-ok");
    assert_ok(await claim(env, { token: agent.token }, { mode: "B", runtime: "codex_cli", provider: " ​openai​ ", model: "unknown" }));
  });
});

// ---------------------------------------------------------------------------
// 2) core receipt replay is checked against the current state first

test("SEL-68 final1 #2 core: run.claim mode A success -> Go OFF -> same actor/key/payload is policy_denied, not a replay, nothing changes", async () => {
  await with_api(async (env) => {
    const int = await make_agent(env, "p2-claim", undefined, "internal_ai");
    const first = await core(env, int.actor_id, "run.claim", { ...A_BODY }, "p2-claim-key");
    assert.equal(first.replayed, false);
    await go_off(env);
    const before = state_signature(env.db);
    assert.equal(await core_code(core(env, int.actor_id, "run.claim", { ...A_BODY }, "p2-claim-key")), "policy_denied");
    assert.equal(state_signature(env.db), before, "no new row, lease or receipt");
    // and again: still the same refusal
    assert.equal(await core_code(core(env, int.actor_id, "run.claim", { ...A_BODY }, "p2-claim-key")), "policy_denied");
    assert.equal(state_signature(env.db), before);
  });
});

test("SEL-68 final1 #2 core: run_id claim and run.create replays are also policy_denied after Go OFF, nothing changes", async () => {
  await with_api(async (env) => {
    const int = await make_agent(env, "p2-rid", undefined, "internal_ai");
    const made = assert_ok(await create_run(env, { actor_id: int.actor_id, ...A_BODY }), 201);
    await release(env, int.token, await core(env, int.actor_id, "run.claim", { run_id: made.run_id }, "p2-rid-claim"));
    const int2 = await make_agent(env, "p2-create", undefined, "internal_ai");
    await core(env, human_id(env), "run.create", { actor_id: int2.actor_id, ...A_BODY }, "p2-create-key");
    await go_off(env);
    const before = state_signature(env.db);
    assert.equal(await core_code(core(env, int.actor_id, "run.claim", { run_id: made.run_id }, "p2-rid-claim")), "policy_denied");
    assert.equal(await core_code(core(env, human_id(env), "run.create", { actor_id: int2.actor_id, ...A_BODY }, "p2-create-key")), "policy_denied");
    assert.equal(state_signature(env.db), before);
  });
});

test("SEL-68 final1 #2 core: actor demoted to external_agent -> same key resent is forbidden (claim, run_id claim, run.create), nothing changes", async () => {
  await with_api(async (env) => {
    const a = await make_agent(env, "p3-a", undefined, "internal_ai");
    const b = await make_agent(env, "p3-b", undefined, "internal_ai");
    const c = await make_agent(env, "p3-c", undefined, "internal_ai");
    await release(env, a.token, await core(env, a.actor_id, "run.claim", { ...A_BODY }, "p3-claim"));
    const made = assert_ok(await create_run(env, { actor_id: b.actor_id, ...A_BODY }), 201);
    await release(env, b.token, await core(env, b.actor_id, "run.claim", { run_id: made.run_id }, "p3-rid"));
    await core(env, human_id(env), "run.create", { actor_id: c.actor_id, ...A_BODY }, "p3-create");
    for (const x of [a, b, c]) env.db.run("UPDATE actors SET kind = 'external_agent' WHERE id = ?", x.actor_id);
    const before = state_signature(env.db);
    assert.equal(await core_code(core(env, a.actor_id, "run.claim", { ...A_BODY }, "p3-claim")), "forbidden");
    assert.equal(await core_code(core(env, b.actor_id, "run.claim", { run_id: made.run_id }, "p3-rid")), "forbidden");
    assert.equal(await core_code(core(env, human_id(env), "run.create", { actor_id: c.actor_id, ...A_BODY }, "p3-create")), "forbidden");
    assert.equal(state_signature(env.db), before);
  });
});

test("SEL-68 final1 #2 core: demoted AND Go OFF -> forbidden wins (permission before policy)", async () => {
  await with_api(async (env) => {
    const a = await make_agent(env, "p4-a", undefined, "internal_ai");
    await core(env, a.actor_id, "run.claim", { ...A_BODY }, "p4-claim");
    env.db.run("UPDATE actors SET kind = 'external_agent' WHERE id = ?", a.actor_id);
    await go_off(env);
    const before = state_signature(env.db);
    assert.equal(await core_code(core(env, a.actor_id, "run.claim", { ...A_BODY }, "p4-claim")), "forbidden");
    assert.equal(state_signature(env.db), before);
  });
});

test("SEL-68 final1 #2 core (해석 1): Go OFF then ON again -> the same key returns the original result, replayed:true, no new row", async () => {
  await with_api(async (env) => {
    const int = await make_agent(env, "p5-int", undefined, "internal_ai");
    const int2 = await make_agent(env, "p5-int2", undefined, "internal_ai");
    const made = assert_ok(await create_run(env, { actor_id: int2.actor_id, ...A_BODY }), 201);
    const first_claim = await core(env, int.actor_id, "run.claim", { ...A_BODY }, "p5-claim");
    await release(env, int.token, first_claim);
    const first_rid = await core(env, int2.actor_id, "run.claim", { run_id: made.run_id }, "p5-rid");
    await release(env, int2.token, first_rid);
    const first_create = await core(env, human_id(env), "run.create", { actor_id: (await make_agent(env, "p5-int3", undefined, "internal_ai")).actor_id, ...A_BODY }, "p5-create");
    const int3 = env.agents.get("p5-int3")!;
    await go_off(env);
    assert.equal(await core_code(core(env, int.actor_id, "run.claim", { ...A_BODY }, "p5-claim")), "policy_denied");
    // switch Go back on through the owner policy command
    const { set_policy } = await import("../scripts/pes_core/policy.ts");
    await set_policy(env.service, env.ctx("go-on-again"), { allow_opencode_go: true, reason: "합성: Go 켜기" });
    const before = state_signature(env.db);
    const again_claim = await core(env, int.actor_id, "run.claim", { ...A_BODY }, "p5-claim");
    const again_rid = await core(env, int2.actor_id, "run.claim", { run_id: made.run_id }, "p5-rid");
    const again_create = await core(env, human_id(env), "run.create", { actor_id: int3.actor_id, ...A_BODY }, "p5-create");
    assert.equal(again_claim.replayed, true);
    assert.equal(again_rid.replayed, true);
    assert.equal(again_create.replayed, true);
    assert.deepEqual(again_claim.result, first_claim.result);
    assert.deepEqual(again_rid.result, first_rid.result);
    assert.deepEqual(again_create.result, first_create.result);
    assert.equal(state_signature(env.db), before, "replay adds no row");
  });
});

test("SEL-68 final1 #2 core (해석 2): demoted then restored to internal_ai -> the same key returns the original result", async () => {
  await with_api(async (env) => {
    const a = await make_agent(env, "p6-a", undefined, "internal_ai");
    const first = await core(env, a.actor_id, "run.claim", { ...A_BODY }, "p6-claim");
    env.db.run("UPDATE actors SET kind = 'external_agent' WHERE id = ?", a.actor_id);
    assert.equal(await core_code(core(env, a.actor_id, "run.claim", { ...A_BODY }, "p6-claim")), "forbidden");
    env.db.run("UPDATE actors SET kind = 'internal_ai' WHERE id = ?", a.actor_id);
    const before = state_signature(env.db);
    const again = await core(env, a.actor_id, "run.claim", { ...A_BODY }, "p6-claim");
    assert.equal(again.replayed, true);
    assert.deepEqual(again.result, first.result);
    assert.equal(state_signature(env.db), before);
  });
});

test("SEL-68 final1 #2 core regression: a replay that passes the checks is still replayed:true with the original result, no new row", async () => {
  await with_api(async (env) => {
    const int = await make_agent(env, "p7-int", undefined, "internal_ai");
    const ext = await make_agent(env, "p7-ext");
    const b_body = { mode: "B", runtime: "synthetic-runtime", provider: "synthetic", model: "synthetic-model" };
    const first_a = await core(env, int.actor_id, "run.claim", { ...A_BODY }, "p7-a");
    await release(env, int.token, first_a);
    const first_b = await core(env, ext.actor_id, "run.claim", { ...b_body }, "p7-b");
    const before = state_signature(env.db);
    const again_a = await core(env, int.actor_id, "run.claim", { ...A_BODY }, "p7-a");
    const again_b = await core(env, ext.actor_id, "run.claim", { ...b_body }, "p7-b");
    assert.equal(again_a.replayed, true);
    assert.equal(again_b.replayed, true);
    assert.deepEqual(again_a.result, first_a.result);
    assert.deepEqual(again_b.result, first_b.result);
    assert.equal(state_signature(env.db), before);
    // Go OFF does not touch a mode B replay (policy only concerns Go routes)
    await go_off(env);
    const mid = state_signature(env.db);
    const still_b = await core(env, ext.actor_id, "run.claim", { ...b_body }, "p7-b");
    assert.equal(still_b.replayed, true);
    assert.deepEqual(still_b.result, first_b.result);
    assert.equal(state_signature(env.db), mid);
  });
});
