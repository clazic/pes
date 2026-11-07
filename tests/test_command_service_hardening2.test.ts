/**
 * SEL-37 PR4 — second hardening round (tester, 보강 모드 2차).
 *
 * Targets the fixes added in 8b59de8: the read-only COMMANDS registry,
 * fail-closed policy results, the policy payload/context copies, and the
 * well-formed-Unicode check. Each test states the property the requirement
 * implies; a failing test is reported to the leader, not fixed here.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { FakeClock } from "../scripts/pes_core/clock.ts";
import { connect, migrate, type Db } from "../scripts/pes_core/db.ts";
import { ApiError } from "../scripts/pes_core/errors.ts";
import {
  COMMANDS,
  CommandService,
  type MutationContext,
  type PolicyChecker,
  type PolicyDecision,
} from "../scripts/pes_core/commands.ts";
import { db_path } from "../scripts/pes_core/paths.ts";
import { isolated_home, type IsolatedHome } from "./helpers/isolated_home.ts";
import { state_signature } from "./helpers/state_signature.ts";

const START_MS = 1_760_000_000_000;

class HookPolicy implements PolicyChecker {
  calls = 0;
  decision: unknown = { allowed: true };
  on_check: ((ctx: MutationContext, command: string, payload: unknown) => void) | undefined;
  last: { ctx: MutationContext; command: string; payload: unknown } | undefined;
  check(ctx: MutationContext, command: string, payload: unknown): PolicyDecision {
    this.calls += 1;
    this.last = { ctx, command, payload };
    this.on_check?.(ctx, command, payload);
    return this.decision as PolicyDecision;
  }
}

interface Env {
  home: IsolatedHome;
  db: Db;
  policy: HookPolicy;
  service: CommandService;
  project_id: string;
  actor_id: string;
  ctx(key: string, base?: number): MutationContext;
  rev(): number;
  topic(): string | undefined;
  close(): void;
}

async function make_env(): Promise<Env> {
  const home = isolated_home("pes-sel37-hard2-");
  const db = connect(db_path(home.env));
  migrate(db);
  const policy = new HookPolicy();
  const service = new CommandService(db, { clock: new FakeClock(START_MS), policy });
  const out = await service.execute(
    { project_id: null, actor_id: null, via: "cli", client_request_id: "setup" },
    "project.bootstrap",
    { slug: "synthetic-h2", topic: "합성 주제", owner_display_name: "합성 소유자" },
  );
  const r = out.result as { project_id: string; owner_actor_id: string };
  policy.calls = 0;
  const rev = () =>
    Number(db.get<{ control_rev: bigint }>("SELECT control_rev FROM projects WHERE id = ?", r.project_id)?.control_rev);
  return {
    home,
    db,
    policy,
    service,
    project_id: r.project_id,
    actor_id: r.owner_actor_id,
    ctx: (key, base) => ({
      project_id: r.project_id,
      actor_id: r.owner_actor_id,
      via: "cli",
      client_request_id: key,
      ...(base === undefined ? {} : { base_control_rev: base }),
    }),
    rev,
    topic: () => db.get<{ topic: string }>("SELECT topic FROM projects WHERE id = ?", r.project_id)?.topic,
    close() {
      db.close();
      home.cleanup();
    },
  };
}

async function with_env(fn: (env: Env) => Promise<void> | void): Promise<void> {
  const env = await make_env();
  try {
    await fn(env);
  } finally {
    env.close();
  }
}

function assert_no_open_tx(db: Db): void {
  db.exec("BEGIN IMMEDIATE");
  db.exec("ROLLBACK");
}

const EVIL = { action: "evil", scope: "project", rev_bearing: false, run() {} };

// ---------------------------------------------------------------------------
// Registry bypasses

test("registry: Map.prototype.set.call cannot register a command", () => {
  const before = [...COMMANDS.keys()].sort();
  try {
    Map.prototype.set.call(COMMANDS, "evil.bypass_set", EVIL);
  } catch {
    // a thrown error is an acceptable way to refuse
  }
  const leaked = COMMANDS.has("evil.bypass_set");
  try {
    Map.prototype.delete.call(COMMANDS, "evil.bypass_set");
  } catch {
    // ignore
  }
  assert.equal(leaked, false, "Map.prototype.set.call(COMMANDS, ...) registered a command");
  assert.deepEqual([...COMMANDS.keys()].sort(), before);
});

test("registry: Map.prototype.delete.call cannot remove a real command", async () => {
  const snapshot = new Map(COMMANDS);
  try {
    Map.prototype.delete.call(COMMANDS, "project.set_topic");
  } catch {
    // refusing is fine
  }
  const still_there = COMMANDS.has("project.set_topic");
  // restore so later tests in this process are not poisoned
  if (!still_there) Map.prototype.set.call(COMMANDS, "project.set_topic", snapshot.get("project.set_topic"));
  assert.equal(still_there, true, "Map.prototype.delete.call(COMMANDS, ...) removed a command");
});

test("registry: Map.prototype.clear.call cannot empty the registry", () => {
  const snapshot = new Map(COMMANDS);
  try {
    Map.prototype.clear.call(COMMANDS);
  } catch {
    // fine
  }
  const size = COMMANDS.size;
  if (size === 0) for (const [k, v] of snapshot) Map.prototype.set.call(COMMANDS, k, v);
  assert.equal(size, snapshot.size, "Map.prototype.clear.call(COMMANDS) emptied the registry");
});

test("registry: delete on an existing key refuses loudly like set and clear (no silent no-op)", () => {
  const registry = COMMANDS as unknown as Map<string, unknown>;
  assert.throws(() => registry.delete("project.set_topic"), TypeError, "delete must throw TypeError, not return false");
  assert.equal(COMMANDS.has("project.set_topic"), true);
});

test("registry: delete on a missing key also refuses (a refusal must not depend on the key)", () => {
  const registry = COMMANDS as unknown as Map<string, unknown>;
  assert.throws(() => registry.delete("never.registered"), TypeError);
});

test("registry: a subclass or Reflect cannot add entries through the prototype chain", () => {
  const registry = COMMANDS as unknown as Map<string, unknown>;
  try {
    Reflect.apply(Map.prototype.set, registry, ["evil.reflect", EVIL]);
  } catch {
    // fine
  }
  const leaked = COMMANDS.has("evil.reflect");
  try {
    Map.prototype.delete.call(COMMANDS, "evil.reflect");
  } catch {
    // ignore
  }
  assert.equal(leaked, false);
});

test("registry: the service refuses a command smuggled in through Map.prototype.set", async () => {
  await with_env(async (env) => {
    let ran = false;
    const def = { action: "evil", scope: "project", rev_bearing: false, run: () => { ran = true; return { project_id: env.project_id }; } };
    try {
      Map.prototype.set.call(COMMANDS, "evil.smuggled", def);
    } catch {
      // refused up front: good
    }
    try {
      await assert.rejects(env.service.execute(env.ctx("smuggle-1"), "evil.smuggled", {}));
      assert.equal(ran, false);
    } finally {
      try {
        Map.prototype.delete.call(COMMANDS, "evil.smuggled");
      } catch {
        // ignore
      }
    }
  });
});

test("registry: a command definition cannot be rewritten in place", async () => {
  const def = COMMANDS.get("project.set_topic") as unknown as { run: unknown; action: string };
  const original_run = def.run;
  const original_action = def.action;
  let rewritten = false;
  try {
    def.run = () => ({ project_id: "x" });
    def.action = "hijacked";
    rewritten = def.run !== original_run || def.action !== original_action;
  } catch {
    // frozen in strict mode: good
  } finally {
    // restore so other tests still see the real definition
    try {
      def.run = original_run;
      def.action = original_action;
    } catch {
      // frozen
    }
  }
  assert.equal(rewritten, false, "COMMANDS definitions are mutable: a caller can replace run()/action");
});

test("registry: read paths still work (get/has/keys/iteration/size/forEach)", () => {
  assert.equal(COMMANDS.size, 2);
  assert.ok(COMMANDS.get("project.bootstrap"));
  assert.ok(COMMANDS.has("project.set_topic"));
  assert.deepEqual([...COMMANDS.keys()].sort(), ["project.bootstrap", "project.set_topic"]);
  assert.equal([...COMMANDS].length, 2);
  let n = 0;
  COMMANDS.forEach(() => { n += 1; });
  assert.equal(n, 2);
  assert.equal(new Map(COMMANDS).size, 2, "a plain Map copy works");
});

// ---------------------------------------------------------------------------
// Policy: exceptions and odd results

test("policy: a thrown non-Error value (string, null, undefined) still aborts and writes nothing", async () => {
  await with_env(async (env) => {
    const sig = state_signature(env.db);
    for (const thrown of ["plain string", null, undefined, 42, { allowed: true }]) {
      env.policy.on_check = () => {
        throw thrown;
      };
      let caught = false;
      try {
        await env.service.execute(env.ctx("pe-1", env.rev()), "project.set_topic", { topic: "예외값" });
      } catch {
        caught = true;
      }
      assert.equal(caught, true, `throwing ${String(thrown)} must not count as allowed`);
      assert_no_open_tx(env.db);
    }
    assert.equal(state_signature(env.db), sig);
  });
});

test("policy: a throw after the payload was mutated still leaves the original untouched and unwritten", async () => {
  await with_env(async (env) => {
    const sig = state_signature(env.db);
    env.policy.on_check = (_c, _m, payload) => {
      (payload as { topic: string }).topic = "바뀐 값";
      throw new Error("boom");
    };
    const payload = { topic: "원본" };
    await assert.rejects(env.service.execute(env.ctx("pe-2", env.rev()), "project.set_topic", payload));
    assert.equal(payload.topic, "원본");
    assert.equal(state_signature(env.db), sig);
  });
});

test("policy: execute_sync surfaces a policy exception synchronously and leaves no open transaction", async () => {
  await with_env(async (env) => {
    env.policy.on_check = () => {
      throw new RangeError("down");
    };
    assert.throws(() => env.service.execute_sync(env.ctx("pe-3", env.rev()), "project.set_topic", { topic: "동기" }), RangeError);
    assert_no_open_tx(env.db);
    env.policy.on_check = undefined;
    env.service.execute_sync(env.ctx("pe-3", env.rev()), "project.set_topic", { topic: "동기" });
    assert.equal(env.topic(), "동기");
  });
});

test("policy: allowed getter that flips between reads is read at most once (true then false still decides on one read)", async () => {
  await with_env(async (env) => {
    let reads = 0;
    env.policy.decision = {
      get allowed() {
        reads += 1;
        return reads === 1;
      },
    };
    // Either outcome is acceptable, but the decision must be consistent with a
    // single read: if it was let through, the gate saw `true` exactly once.
    let passed = false;
    try {
      await env.service.execute(env.ctx("pg-1", env.rev()), "project.set_topic", { topic: "게터" });
      passed = true;
    } catch (error) {
      assert.ok(error instanceof ApiError);
    }
    if (passed) assert.equal(reads, 1, "the gate read `allowed` more than once");
  });
});

test("policy: allowed getter that is false first then true is denied", async () => {
  await with_env(async (env) => {
    const sig = state_signature(env.db);
    let reads = 0;
    env.policy.decision = {
      get allowed() {
        reads += 1;
        return reads > 1;
      },
    };
    await assert.rejects(env.service.execute(env.ctx("pg-2", env.rev()), "project.set_topic", { topic: "게터" }));
    assert.equal(state_signature(env.db), sig);
  });
});

test("policy: a throwing allowed getter fails closed and writes nothing", async () => {
  await with_env(async (env) => {
    const sig = state_signature(env.db);
    env.policy.decision = {
      get allowed(): boolean {
        throw new Error("getter exploded");
      },
    };
    await assert.rejects(env.service.execute(env.ctx("pg-3", env.rev()), "project.set_topic", { topic: "게터" }));
    assert_no_open_tx(env.db);
    assert.equal(state_signature(env.db), sig);
  });
});

test("policy: a denial whose reason getter throws is still a denial and writes nothing", async () => {
  await with_env(async (env) => {
    const sig = state_signature(env.db);
    env.policy.decision = {
      allowed: false,
      get reason(): string {
        throw new Error("reason exploded");
      },
    };
    await assert.rejects(env.service.execute(env.ctx("pg-4", env.rev()), "project.set_topic", { topic: "게터" }));
    assert_no_open_tx(env.db);
    assert.equal(state_signature(env.db), sig);
  });
});

test("policy: a denial with a throwing reason getter is reported as policy_denied, not as the getter's error", async () => {
  await with_env(async (env) => {
    env.policy.decision = {
      allowed: false,
      get reason(): string {
        throw new Error("reason exploded");
      },
    };
    const error = await env.service
      .execute(env.ctx("pg-5", env.rev()), "project.set_topic", { topic: "게터" })
      .then(() => undefined, (e: unknown) => e);
    assert.ok(error instanceof ApiError, `expected ApiError(policy_denied), got ${String(error)}`);
    assert.equal(error.code, "policy_denied");
  });
});

test("policy: a Proxy decision that throws on every read fails closed", async () => {
  await with_env(async (env) => {
    const sig = state_signature(env.db);
    env.policy.decision = new Proxy({}, { get() { throw new Error("proxy"); } });
    await assert.rejects(env.service.execute(env.ctx("pg-6", env.rev()), "project.set_topic", { topic: "프록시" }));
    assert.equal(state_signature(env.db), sig);
  });
});

test("policy: allowed:true inherited from the prototype is not an explicit allow... or is, but never crashes", async () => {
  await with_env(async (env) => {
    env.policy.decision = Object.create({ allowed: true });
    // The requirement only says 'explicit true'; an inherited true must not throw a raw TypeError.
    try {
      await env.service.execute(env.ctx("pg-7", env.rev()), "project.set_topic", { topic: "상속" });
    } catch (error) {
      assert.ok(error instanceof ApiError, `got ${String(error)}`);
    }
  });
});

test("policy: a non-string or empty reason falls back to a message", async () => {
  await with_env(async (env) => {
    for (const reason of [123, "", null, {}, ["x"]]) {
      env.policy.decision = { allowed: false, reason };
      const error = await env.service
        .execute(env.ctx("pr-1", env.rev()), "project.set_topic", { topic: "사유" })
        .then(() => undefined, (e: unknown) => e);
      assert.ok(error instanceof ApiError);
      assert.equal(error.code, "policy_denied");
      assert.ok(error.message.length > 0);
    }
  });
});

test("policy: a very long reason survives as policy_denied", async () => {
  await with_env(async (env) => {
    env.policy.decision = { allowed: false, reason: "r".repeat(100_000) };
    const error = await env.service
      .execute(env.ctx("pr-2", env.rev()), "project.set_topic", { topic: "사유" })
      .then(() => undefined, (e: unknown) => e);
    assert.ok(error instanceof ApiError);
    assert.equal(error.code, "policy_denied");
  });
});

// ---------------------------------------------------------------------------
// Policy copies

test("policy copy: a nested mutation in the policy's payload does not reach the stored data", async () => {
  await with_env(async (env) => {
    env.policy.on_check = (_c, _m, payload) => {
      const p = payload as { topic: string; extra: { list: number[] } };
      p.extra.list.push(99);
      p.extra.list[0] = -1;
      p.topic = "정책이 바꿈";
    };
    const payload = { topic: "원래 주제", extra: { list: [1, 2, 3] } };
    await env.service.execute(env.ctx("cp-1", env.rev()), "project.set_topic", payload);
    assert.deepEqual(payload.extra.list, [1, 2, 3]);
    assert.equal(env.topic(), "원래 주제");
  });
});

test("policy copy: the policy payload is not the caller's object", async () => {
  await with_env(async (env) => {
    const payload = { topic: "동일성", extra: { a: 1 } };
    await env.service.execute(env.ctx("cp-2", env.rev()), "project.set_topic", payload);
    assert.notEqual(env.policy.last?.payload, payload);
    assert.notEqual((env.policy.last?.payload as { extra: unknown }).extra, payload.extra);
  });
});

test("policy copy: the policy context is not the caller's object and mutating it leaves the caller's ctx intact", async () => {
  await with_env(async (env) => {
    const ctx = env.ctx("cp-3", env.rev());
    env.policy.on_check = (c) => {
      (c as { via: string }).via = "mcp";
      (c as { project_id: string | null }).project_id = "other-project";
      (c as { actor_id: string | null }).actor_id = "other-actor";
    };
    await env.service.execute(ctx, "project.set_topic", { topic: "컨텍스트" });
    assert.notEqual(env.policy.last?.ctx, ctx);
    assert.equal(ctx.via, "cli");
    assert.equal(ctx.project_id, env.project_id);
    assert.equal(ctx.actor_id, env.actor_id);
    const row = env.db.get<{ via: string; actor_id: string }>(
      "SELECT via, actor_id FROM mutation_commits WHERE client_request_id = 'cp-3'",
    );
    assert.equal(row?.via, "cli");
    assert.equal(row?.actor_id, env.actor_id);
  });
});

test("policy copy: a payload key named __proto__ reaches the policy as an own key", async () => {
  await with_env(async (env) => {
    const payload = JSON.parse('{"topic":"프로토","__proto__":{"admin":true}}') as Record<string, unknown>;
    assert.ok(Object.hasOwn(payload, "__proto__"), "test setup: JSON.parse makes it an own property");
    await env.service.execute(env.ctx("cp-4", env.rev()), "project.set_topic", payload);
    const seen = env.policy.last?.payload as Record<string, unknown>;
    assert.ok(Object.hasOwn(seen, "__proto__"), "the policy must see the same keys the caller sent");
    assert.equal(Object.getPrototypeOf(seen), Object.prototype, "the copy's prototype must not be replaced by data");
  });
});

test("policy copy: a __proto__ key nested in the payload does not pollute Object.prototype or the copy's prototype", async () => {
  await with_env(async (env) => {
    const payload = JSON.parse('{"topic":"중첩","extra":{"__proto__":{"polluted":"yes"}}}');
    await env.service.execute(env.ctx("cp-5", env.rev()), "project.set_topic", payload);
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    const extra = (env.policy.last?.payload as { extra: Record<string, unknown> }).extra;
    assert.equal((extra as Record<string, unknown>).polluted, undefined, "data must not become the copy's prototype");
  });
});

test("policy copy: a payload with a very deep nesting is handled without crashing the process", async () => {
  await with_env(async (env) => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 5000; i += 1) deep = { n: deep };
    const sig = state_signature(env.db);
    let outcome: "ok" | "rejected" = "ok";
    try {
      await env.service.execute(env.ctx("cp-6", env.rev()), "project.set_topic", { topic: "깊음", deep });
    } catch (error) {
      outcome = "rejected";
      assert.ok(error instanceof ApiError, `a stack overflow must be an ApiError, got ${String(error)}`);
      assert.equal(error.code, "invalid_payload");
    }
    if (outcome === "rejected") assert.equal(state_signature(env.db), sig);
    assert_no_open_tx(env.db);
  });
});

test("policy copy: circular references are invalid_payload before the policy runs", async () => {
  await with_env(async (env) => {
    const sig = state_signature(env.db);
    const payload: Record<string, unknown> = { topic: "순환" };
    payload.self = payload;
    const error = await env.service
      .execute(env.ctx("cp-7", env.rev()), "project.set_topic", payload)
      .then(() => undefined, (e: unknown) => e);
    assert.ok(error instanceof ApiError, `got ${String(error)}`);
    assert.equal(error.code, "invalid_payload");
    assert.equal(env.policy.calls, 0);
    assert.equal(state_signature(env.db), sig);
  });
});

test("policy copy: a circular array is invalid_payload", async () => {
  await with_env(async (env) => {
    const arr: unknown[] = [];
    arr.push(arr);
    const error = await env.service
      .execute(env.ctx("cp-8", env.rev()), "project.set_topic", { topic: "순환 배열", arr })
      .then(() => undefined, (e: unknown) => e);
    assert.ok(error instanceof ApiError);
    assert.equal(error.code, "invalid_payload");
    assert.equal(env.policy.calls, 0);
  });
});

test("policy copy: a bigint anywhere in the payload is invalid_payload, not a raw TypeError", async () => {
  await with_env(async (env) => {
    const sig = state_signature(env.db);
    for (const payload of [{ topic: "큰 수", n: 10n }, { topic: "중첩", extra: { n: [1n] } }]) {
      const error = await env.service
        .execute(env.ctx("cp-9", env.rev()), "project.set_topic", payload)
        .then(() => undefined, (e: unknown) => e);
      assert.ok(error instanceof ApiError, `got ${String(error)}`);
      assert.equal(error.code, "invalid_payload");
    }
    assert.equal(env.policy.calls, 0);
    assert.equal(state_signature(env.db), sig);
  });
});

test("policy copy: a Date value is handled consistently: the hash, the policy copy and the replay agree", async () => {
  await with_env(async (env) => {
    const when = new Date(START_MS);
    const rev0 = env.rev();
    const first = await env.service.execute(env.ctx("cp-10", rev0), "project.set_topic", { topic: "날짜", when });
    // Same key, a different Date: a Date serialises through toJSON, so a different time is a different request.
    const error = await env.service
      .execute(env.ctx("cp-10", rev0), "project.set_topic", { topic: "날짜", when: new Date(START_MS + 1000) })
      .then(() => undefined, (e: unknown) => e);
    const same = await env.service.execute(env.ctx("cp-10", rev0), "project.set_topic", { topic: "날짜", when: new Date(START_MS) });
    assert.equal(same.replayed, true);
    assert.deepEqual(same.result, first.result);
    assert.ok(error instanceof ApiError, "a different Date under the same key must not replay as the same request");
    assert.equal(error.code, "idempotency_key_reuse");
  });
});

test("policy copy: a Date and an empty object are not the same request under one key", async () => {
  await with_env(async (env) => {
    const rev0 = env.rev();
    await env.service.execute(env.ctx("cp-11", rev0), "project.set_topic", { topic: "날짜 대 객체", when: new Date(START_MS) });
    const error = await env.service
      .execute(env.ctx("cp-11", rev0), "project.set_topic", { topic: "날짜 대 객체", when: {} })
      .then(() => undefined, (e: unknown) => e);
    assert.ok(error instanceof ApiError, "{} must not replay a request that carried a Date");
  });
});

test("policy copy: the policy sees a Date as data it can read (not an emptied object)", async () => {
  await with_env(async (env) => {
    await env.service.execute(env.ctx("cp-12", env.rev()), "project.set_topic", { topic: "날짜 정책", when: new Date(START_MS) });
    const seen = (env.policy.last?.payload as { when: unknown }).when;
    const text = JSON.stringify(seen);
    assert.ok(text !== "{}", `the policy copy lost the Date: ${text}`);
  });
});

test("policy copy: NaN, Infinity and -0 inside the payload do not crash the copy", async () => {
  await with_env(async (env) => {
    const payload = { topic: "특수 수", a: Number.NaN, b: Number.POSITIVE_INFINITY, c: -0 };
    try {
      await env.service.execute(env.ctx("cp-13", env.rev()), "project.set_topic", payload);
    } catch (error) {
      assert.ok(error instanceof ApiError, `got ${String(error)}`);
    }
    assert_no_open_tx(env.db);
  });
});

test("policy copy: a payload getter that returns different values per read cannot make the stored topic differ from the hashed one", async () => {
  await with_env(async (env) => {
    let reads = 0;
    const payload = {
      get topic(): string {
        reads += 1;
        return reads === 1 ? "해시된 값" : `다른 값 ${reads}`;
      },
    };
    const rev0 = env.rev();
    let ok = true;
    try {
      await env.service.execute(env.ctx("cp-14", rev0), "project.set_topic", payload);
    } catch (error) {
      ok = false;
      assert.ok(error instanceof ApiError, `got ${String(error)}`);
    }
    if (ok) {
      assert.equal(env.topic(), "해시된 값", "the stored topic is not the one the request hash was computed from");
    }
  });
});

test("policy copy: a payload getter that throws on the second read is not a half-applied command", async () => {
  await with_env(async (env) => {
    const sig = state_signature(env.db);
    let reads = 0;
    const payload = {
      get topic(): string {
        reads += 1;
        if (reads > 1) throw new Error("second read");
        return "한 번만";
      },
    };
    let ok = true;
    try {
      await env.service.execute(env.ctx("cp-15", env.rev()), "project.set_topic", payload);
    } catch {
      ok = false;
    }
    if (!ok) assert.equal(state_signature(env.db), sig, "a failure must roll back everything");
    assert_no_open_tx(env.db);
  });
});

test("policy copy: a class instance payload is accepted or rejected as data, never executed", async () => {
  await with_env(async (env) => {
    class Evil {
      topic = "클래스";
      toJSON(): unknown {
        return { topic: "toJSON 값" };
      }
    }
    try {
      await env.service.execute(env.ctx("cp-16", env.rev()), "project.set_topic", new Evil());
    } catch (error) {
      assert.ok(error instanceof ApiError, `got ${String(error)}`);
    }
    assert_no_open_tx(env.db);
  });
});

test("policy copy: symbol keys and non-enumerable keys do not reach the policy or the hash", async () => {
  await with_env(async (env) => {
    const secret = Symbol("s");
    const payload: Record<string | symbol, unknown> = { topic: "심볼" };
    payload[secret] = "숨김";
    Object.defineProperty(payload, "hidden", { value: "숨김", enumerable: false });
    const rev0 = env.rev();
    await env.service.execute(env.ctx("cp-17", rev0), "project.set_topic", payload);
    const seen = env.policy.last?.payload as Record<string | symbol, unknown>;
    assert.equal(seen[secret], undefined);
    assert.equal(seen.hidden, undefined);
    // the same JSON replays
    const again = await env.service.execute(env.ctx("cp-17", rev0), "project.set_topic", { topic: "심볼" });
    assert.equal(again.replayed, true);
  });
});

test("policy copy: a context getter cannot make the receipt key differ from the validated one", async () => {
  await with_env(async (env) => {
    let reads = 0;
    const ctx = {
      project_id: env.project_id,
      actor_id: env.actor_id,
      via: "cli",
      get client_request_id(): string {
        reads += 1;
        return reads === 1 ? "valid-key" : "";
      },
      base_control_rev: env.rev(),
    } as MutationContext;
    let ok = true;
    try {
      await env.service.execute(ctx, "project.set_topic", { topic: "키 게터" });
    } catch (error) {
      ok = false;
      assert.ok(error instanceof ApiError || error instanceof TypeError, `got ${String(error)}`);
    }
    if (ok) {
      const row = env.db.get<{ client_request_id: string }>(
        "SELECT client_request_id FROM mutation_commits WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
        env.project_id,
      );
      assert.ok(row && row.client_request_id.length > 0, "a receipt was stored under an empty key");
    }
  });
});

// ---------------------------------------------------------------------------
// Well-formed Unicode

test("unicode: a lone surrogate (high or low) in topic is invalid_payload and changes nothing", async () => {
  await with_env(async (env) => {
    const sig = state_signature(env.db);
    for (const topic of ["앞\ud800", "\udc00뒤", "\ud800\ud800", "\udc00\ud800", "정상\udbff"]) {
      const error = await env.service
        .execute(env.ctx("u-1", env.rev()), "project.set_topic", { topic })
        .then(() => undefined, (e: unknown) => e);
      assert.ok(error instanceof ApiError, `got ${String(error)}`);
      assert.equal(error.code, "invalid_payload");
    }
    assert.equal(state_signature(env.db), sig);
  });
});

test("unicode: two client_request_ids that differ only by a lone surrogate are not the same request", async () => {
  await with_env(async (env) => {
    const rev0 = env.rev();
    let first;
    try {
      first = await env.service.execute(env.ctx("키\ud800", rev0), "project.set_topic", { topic: "첫째" });
    } catch (error) {
      assert.ok(error instanceof ApiError);
      return; // rejected up front: fine
    }
    const second = await env.service
      .execute(env.ctx("키\ud801", env.rev()), "project.set_topic", { topic: "둘째" })
      .then((o) => o, (e: unknown) => e);
    // Stored as U+FFFD both keys collide; a second, different request must not
    // be answered with the first one's result.
    if (!(second instanceof Error)) {
      assert.notDeepEqual((second as { result: unknown }).result, first.result);
      assert.equal(env.topic(), "둘째");
    }
  });
});

test("unicode: a valid surrogate pair (emoji) is accepted and round-trips", async () => {
  await with_env(async (env) => {
    const topic = "😀 이모지 𠮷";
    const out = await env.service.execute(env.ctx("u-2", env.rev()), "project.set_topic", { topic });
    assert.equal((out.result as { topic: string }).topic, topic);
    assert.equal(env.topic(), topic);
  });
});

test("unicode: bootstrap rejects a lone surrogate in slug, topic and owner_display_name, creating nothing", async () => {
  await with_env(async (env) => {
    const sig = state_signature(env.db);
    const base = { slug: "synthetic-u3", topic: "주제", owner_display_name: "소유자" };
    for (const field of ["slug", "topic", "owner_display_name"] as const) {
      const error = await env.service
        .execute(
          { project_id: null, actor_id: null, via: "cli", client_request_id: `u-3-${field}` },
          "project.bootstrap",
          { ...base, [field]: "깨진\ud800" },
        )
        .then(() => undefined, (e: unknown) => e);
      assert.ok(error instanceof ApiError, `${field}: got ${String(error)}`);
      assert.equal(error.code, "invalid_payload", field);
    }
    assert.equal(state_signature(env.db), sig);
  });
});

test("unicode: a lone surrogate in an extra payload field is handled consistently (hash and replay agree)", async () => {
  await with_env(async (env) => {
    const rev0 = env.rev();
    let first;
    try {
      first = await env.service.execute(env.ctx("u-4", rev0), "project.set_topic", { topic: "추가 필드", note: "\ud800" });
    } catch (error) {
      assert.ok(error instanceof ApiError, `got ${String(error)}`);
      return;
    }
    const again = await env.service.execute(env.ctx("u-4", rev0), "project.set_topic", { topic: "추가 필드", note: "\ud800" });
    assert.equal(again.replayed, true);
    assert.deepEqual(again.result, first.result);
    const other = await env.service
      .execute(env.ctx("u-4", rev0), "project.set_topic", { topic: "추가 필드", note: "\udc00" })
      .then(() => undefined, (e: unknown) => e);
    assert.ok(other instanceof ApiError, "two different lone surrogates must not hash to the same request");
  });
});

test("unicode: a lone surrogate in an object key of the payload does not collide with another key", async () => {
  await with_env(async (env) => {
    const rev0 = env.rev();
    try {
      await env.service.execute(env.ctx("u-5", rev0), "project.set_topic", { topic: "키", ["\ud800"]: 1 });
    } catch (error) {
      assert.ok(error instanceof ApiError);
      return;
    }
    const other = await env.service
      .execute(env.ctx("u-5", rev0), "project.set_topic", { topic: "키", ["\udc00"]: 1 })
      .then(() => undefined, (e: unknown) => e);
    assert.ok(other instanceof ApiError, "different lone-surrogate keys must be different requests");
  });
});

test("unicode: a lone surrogate in client_request_id is invalid_payload and writes nothing", async () => {
  await with_env(async (env) => {
    const sig = state_signature(env.db);
    const error = await env.service
      .execute(env.ctx("키\ud800", env.rev()), "project.set_topic", { topic: "키 서로게이트" })
      .then(() => undefined, (e: unknown) => e);
    assert.ok(error instanceof ApiError, `got ${String(error)}`);
    assert.equal(error.code, "invalid_payload");
    assert.equal(state_signature(env.db), sig);
  });
});

test("unicode: a lone surrogate in project_id or actor_id never reaches a row", async () => {
  await with_env(async (env) => {
    const sig = state_signature(env.db);
    for (const ctx of [
      { ...env.ctx("u-7", env.rev()), project_id: "\ud800" },
      { ...env.ctx("u-7", env.rev()), actor_id: "\ud800" },
    ]) {
      await assert.rejects(env.service.execute(ctx, "project.set_topic", { topic: "아이디" }));
    }
    assert.equal(state_signature(env.db), sig);
  });
});

test("unicode: the check is on the value, not trimmed text (a lone surrogate hidden between spaces is still rejected)", async () => {
  await with_env(async (env) => {
    const error = await env.service
      .execute(env.ctx("u-8", env.rev()), "project.set_topic", { topic: "   \ud800   " })
      .then(() => undefined, (e: unknown) => e);
    assert.ok(error instanceof ApiError);
    assert.equal(error.code, "invalid_payload");
  });
});

test("unicode: a topic that is only whitespace is still invalid_payload (the new check did not loosen the old one)", async () => {
  await with_env(async (env) => {
    for (const topic of ["", " ", "\t\n", "　"]) {
      const error = await env.service
        .execute(env.ctx("u-9", env.rev()), "project.set_topic", { topic })
        .then(() => undefined, (e: unknown) => e);
      assert.ok(error instanceof ApiError);
      assert.equal(error.code, "invalid_payload");
    }
  });
});
