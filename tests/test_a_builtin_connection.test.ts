// SEL-52 (PR19) AI connection registration: register / test / update / remove / set_price / select, the
// human-only + re-authentication rules, and "the key never comes back". The "PES server" tests the connection
// against a fake local HTTP server; nothing leaves the machine.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  KEY_LAST4,
  MODEL_A,
  MODEL_B,
  SYNTHETIC_KEY,
  assert_no_key,
  everything_stored,
  make_a_env,
  next_key,
  reauth,
  register_connection,
  rejects_one_of,
  select_model,
  set_price,
  with_a_env,
  type AEnv,
  type ConnectionDto,
  type Format,
} from "./helpers/a_builtin_env.ts";

const FORMATS: Format[] = ["openai_compatible", "anthropic"];

/** An agent (non-human) actor of the same project: it must never manage connections. */
function agent_of(env: AEnv): string {
  return env.ai_actor_id;
}

for (const format of FORMATS) {
  test(`${format}: register tests the connection from the PES side and keeps only the last 4 characters`, async () => {
    await with_a_env(format, async (env) => {
      const dto = await register_connection(env, { name: "합성 연결 하나" });

      // the PES server called the (fake) models endpoint exactly once, with the key in the format's own header
      assert.equal(env.fake.all.length, 1);
      const req = env.fake.all[0]!;
      assert.equal(req.method, "GET");
      assert.match(req.path, format === "anthropic" ? /\/v1\/models$/ : /\/v1\/models$/);
      if (format === "anthropic") {
        assert.equal(req.headers["x-api-key"], SYNTHETIC_KEY);
        assert.equal(typeof req.headers["anthropic-version"], "string");
      } else {
        assert.equal(req.headers["authorization"], `Bearer ${SYNTHETIC_KEY}`);
      }
      assert.equal(env.fake.calls.length, 0, "no model completion is spent on a connection test");

      assert.equal(dto.request_format, format);
      assert.equal(dto.supported, true);
      assert.equal(dto.billing, "subscription");
      assert.equal(dto.key_last4, KEY_LAST4);
      assert.equal(dto.key_storage, env.keys.where());
      assert.equal(dto.key_set_by, env.p.actor_id);
      assert.equal(typeof dto.key_set_at, "number");
      assert.equal(dto.base_url, env.fake.base_url);
      assert_no_key(JSON.stringify(dto), "the register result");

      // the secret lives in the key store only
      assert.deepEqual([...env.keys.keys.values()], [SYNTHETIC_KEY]);
      assert_no_key(everything_stored(env), "any table or stored file");

      // an audit trail names the connection and the human, never the key
      const events = env.db.all<{ payload: string }>(
        "SELECT payload FROM events WHERE project_id = ? AND payload LIKE ?",
        env.p.project_id,
        `%${dto.connection_id}%`,
      );
      assert.ok(events.length >= 1, "registering leaves an event that names the connection");
    });
  });

  test(`${format}: a failing connection test saves nothing and stores no key`, async () => {
    for (const how of ["wrong_key", "models_down"] as const) {
      await with_a_env(format, async (env) => {
        if (how === "models_down") env.fake.models_status = 500;
        const before = env.keys.puts;
        await rejects_one_of(
          register_connection(env, how === "wrong_key" ? { api_key: "sk-synthetic-wrong-key-0000" } : {}),
          "conflict",
          "invalid_payload",
        );
        assert.equal(env.keys.keys.size, 0, `${how}: no key stored`);
        assert.equal(env.keys.puts, before, `${how}: the key store was not even written`);
        assert.deepEqual(await env.conns.list(env.ctx(next_key(env))), [], `${how}: no connection saved`);
        assert_no_key(env.logs.join("\n"), "the log");
      });
    }
  });

  test(`${format}: test() reports models, and a bad key as ok:false without echoing any key`, async () => {
    await with_a_env(format, async (env) => {
      const dto = await register_connection(env);
      const ok = await env.conns.test(env.ctx(next_key(env)), { reauth_code: await reauth(env), connection_id: dto.connection_id });
      assert.equal(ok.ok, true);
      assert.deepEqual([...ok.models].sort(), [MODEL_A, MODEL_B]);
      assert.equal(ok.error_code, null);

      env.fake.models_status = 500;
      const bad = await env.conns.test(env.ctx(next_key(env)), { reauth_code: await reauth(env), connection_id: dto.connection_id });
      assert.equal(bad.ok, false);
      assert.equal(typeof bad.error_code, "string");
      assert_no_key(JSON.stringify(bad), "the test result");
    });
  });
}

test("google: registered without any HTTP call, kept as unsupported, and never executable", async () => {
  await with_a_env("openai_compatible", async (env) => {
    const dto = await register_connection(env, {
      kind: "google",
      base_url: "http://127.0.0.1:9/never-called",
      name: "합성 구글",
    });
    assert.equal(dto.request_format, "google");
    assert.equal(dto.supported, false, "google is stored but marked unsupported");
    assert.equal(env.fake.all.length, 0, "an unsupported format is not tested over the network");
    assert.equal(dto.key_last4, KEY_LAST4);

    await select_model(env, dto.connection_id, "synthetic-google-model");
    await rejects_one_of(env.exec.start({
      owner_ctx: env.ctx(next_key(env)),
      actor_id: env.ai_actor_id,
      stage_id: env.db.get<{ id: string }>("SELECT id FROM stages WHERE edition_id = ? AND key = 'plan'", env.p.edition_id)!.id,
      round_id: null,
      max_output_tokens: 100,
    }), "conflict", "invalid_payload");
    assert.equal(env.fake.all.length, 0);
    assert.deepEqual(env.db.all("SELECT id FROM runs"), [], "no run row for an unsupported format");
  });
});

test("the key is never a command field: ai_connection.register with api_key in the payload is invalid", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await rejects_one_of(
      env.service.execute(env.ctx(next_key(env)), "ai_connection.register", {
        name: "합성",
        kind: "openai_compatible",
        base_url: env.fake.base_url,
        api_key: SYNTHETIC_KEY,
        billing: "subscription",
      }),
      "invalid_payload",
    );
    assert_no_key(everything_stored(env), "any table (receipts and events included)");
    assert.equal(env.fake.all.length, 0);
  });
});

test("pay_per_use without a cost cap is refused at registration; subscription limits are validated", async () => {
  await with_a_env("openai_compatible", async (env) => {
    await rejects_one_of(register_connection(env, { billing: "pay_per_use", cost_cap: null }), "invalid_payload");
    await rejects_one_of(register_connection(env, { billing: "pay_per_use", cost_cap: { currency: "USD", amount_micros: 0 } }), "invalid_payload");
    await rejects_one_of(register_connection(env, { billing: "pay_per_use", cost_cap: { currency: "USD", amount_micros: -5 } }), "invalid_payload");
    await rejects_one_of(register_connection(env, { stop_percent: 49 }), "invalid_payload");
    await rejects_one_of(register_connection(env, { stop_percent: 101 }), "invalid_payload");
    await rejects_one_of(
      register_connection(env, { subscription_limits: { five_hour_tokens: -1, weekly_tokens: 10, monthly_tokens: 10 } }),
      "invalid_payload",
    );
    await rejects_one_of(register_connection(env, { kind: "carrier_pigeon" }), "invalid_payload");
    assert.equal(env.keys.keys.size, 0, "a refused registration stores no key");
    assert.equal(env.fake.all.length, 0, "an invalid request is refused before any network call");
  });
});

test("only the human owner manages connections: an agent actor is refused on every command", async () => {
  await with_a_env("openai_compatible", async (env) => {
    const dto = await register_connection(env);
    const agent = env.agent_ctx(agent_of(env), "agent-try");
    const traffic = env.fake.all.length;
    const attempts: Array<[string, () => Promise<unknown>]> = [
      ["issue_reauth", () => env.conns.issue_reauth({ ...agent, client_request_id: "a-1" })],
      ["register", async () => env.conns.register({ ...agent, client_request_id: "a-2" }, {
        reauth_code: "none", name: "x", kind: "openai_compatible", base_url: env.fake.base_url, api_key: SYNTHETIC_KEY, billing: "subscription",
        subscription_limits: { five_hour_tokens: 1000, weekly_tokens: 1000, monthly_tokens: 1000 },
      })],
      ["update", async () => env.conns.update({ ...agent, client_request_id: "a-3" }, { reauth_code: "none", connection_id: dto.connection_id, name: "y" })],
      ["remove", async () => env.conns.remove({ ...agent, client_request_id: "a-4" }, { reauth_code: "none", connection_id: dto.connection_id })],
      ["test", async () => env.conns.test({ ...agent, client_request_id: "a-5" }, { reauth_code: "none", connection_id: dto.connection_id })],
      ["set_price", async () => env.conns.set_price({ ...agent, client_request_id: "a-6" }, {
        reauth_code: "none", connection_id: dto.connection_id, model: MODEL_A, currency: "USD", input_per_mtok_micros: 1, output_per_mtok_micros: 1,
      })],
      ["select", async () => env.conns.select({ ...agent, client_request_id: "a-7" }, { connection_id: dto.connection_id, model: MODEL_A })],
    ];
    for (const [name, attempt] of attempts) {
      await rejects_one_of(attempt(), "forbidden").catch((e) => {
        throw new Error(`${name}: ${String(e)}`);
      });
    }
    assert.equal(env.fake.all.length, traffic, "a refused agent call causes no network traffic");
    assert.equal((await env.conns.list(env.ctx(next_key(env)))).length, 1, "the connection is untouched");
    assert.deepEqual([...env.keys.keys.values()], [SYNTHETIC_KEY]);
  });
});

test("re-authentication is required for every request and a code works once", async () => {
  await with_a_env("openai_compatible", async (env) => {
    const base = {
      name: "합성",
      kind: "openai_compatible",
      base_url: env.fake.base_url,
      api_key: SYNTHETIC_KEY,
      billing: "subscription",
      subscription_limits: { five_hour_tokens: 1000, weekly_tokens: 1000, monthly_tokens: 1000 },
    };
    await rejects_one_of(env.conns.register(env.ctx(next_key(env)), base), "forbidden");
    await rejects_one_of(env.conns.register(env.ctx(next_key(env)), { ...base, reauth_code: "not-a-real-code" }), "forbidden");
    assert.equal(env.keys.keys.size, 0);

    const code = await reauth(env);
    const dto = await env.conns.register(env.ctx(next_key(env)), { ...base, reauth_code: code });
    assert.equal(typeof dto.connection_id, "string");

    // the same code cannot be used for a second request
    await rejects_one_of(
      env.conns.update(env.ctx(next_key(env)), { reauth_code: code, connection_id: dto.connection_id, name: "다른 이름" }),
      "forbidden",
    );
    const renamed = await env.conns.update(env.ctx(next_key(env)), {
      reauth_code: await reauth(env),
      connection_id: dto.connection_id,
      name: "다른 이름",
    });
    assert.equal(renamed.name, "다른 이름");
    // removal also needs a fresh code
    await rejects_one_of(env.conns.remove(env.ctx(next_key(env)), { connection_id: dto.connection_id }), "forbidden");
  });
});

test("update replaces the stored key (new last 4, old secret gone) and re-tests it", async () => {
  await with_a_env("openai_compatible", async (env) => {
    const dto = await register_connection(env);
    const new_key = "sk-synthetic-canary-0000aaaa1111bbbb";
    // the fake server accepts only its expected key: point it at the new one for the re-test
    env.fake.expected_key = new_key;
    const traffic = env.fake.all.length;
    const out = await env.conns.update(env.ctx(next_key(env)), {
      reauth_code: await reauth(env),
      connection_id: dto.connection_id,
      api_key: new_key,
    });
    assert.equal(out.key_last4, "bbbb");
    assert.equal(env.fake.all.length, traffic + 1, "a changed key is tested again");
    assert.deepEqual([...env.keys.keys.values()], [new_key], "the old secret is not kept next to the new one");
    assert.equal(out.key_set_by, env.p.actor_id);
    assert.equal(JSON.stringify(out).includes(new_key), false);
    assert_no_key(everything_stored(env), "any table or file after a key change");

    // a new key that fails the test changes nothing
    env.fake.expected_key = "something-else";
    await rejects_one_of(
      env.conns.update(env.ctx(next_key(env)), { reauth_code: await reauth(env), connection_id: dto.connection_id, api_key: "sk-synthetic-bad-key-zzzz" }),
      "conflict",
      "invalid_payload",
    );
    assert.deepEqual([...env.keys.keys.values()], [new_key]);
  });
});

test("remove deletes the stored key and the connection; removing twice is not_found", async () => {
  await with_a_env("openai_compatible", async (env) => {
    const dto = await register_connection(env);
    const out = await env.conns.remove(env.ctx(next_key(env)), { reauth_code: await reauth(env), connection_id: dto.connection_id });
    assert.equal(out.removed, true);
    assert.equal(env.keys.keys.size, 0, "the secret is deleted from the key store");
    assert.deepEqual(await env.conns.list(env.ctx(next_key(env))), []);
    await rejects_one_of(
      env.conns.remove(env.ctx(next_key(env)), { reauth_code: await reauth(env), connection_id: dto.connection_id }),
      "not_found",
    );
  });
});

test("set_price is a human entry with who/when; invalid prices are refused; a later price does not rewrite history", async () => {
  await with_a_env("openai_compatible", async (env) => {
    const dto = await register_connection(env, { billing: "pay_per_use" });
    env.clock.advance(1_000);
    const first = await set_price(env, dto.connection_id, { model: MODEL_A, input_per_mtok_micros: 3_000_000, output_per_mtok_micros: 15_000_000 });
    assert.equal(first.entered_by, env.p.actor_id);
    assert.equal(first.entered_at, Number(env.clock.now_ms()));
    assert.equal(first.model, MODEL_A);

    await rejects_one_of(set_price(env, dto.connection_id, { input_per_mtok_micros: -1 }), "invalid_payload");
    await rejects_one_of(set_price(env, dto.connection_id, { currency: "" }), "invalid_payload");
    await rejects_one_of(set_price(env, "no-such-connection"), "not_found");
    // 0 is a deliberate entry only for a human who means it; the executor treats a missing price (not 0) as unknown
    env.clock.advance(1_000);
    const second = await set_price(env, dto.connection_id, { model: MODEL_A, input_per_mtok_micros: 4_000_000, output_per_mtok_micros: 16_000_000 });
    assert.notEqual(second.price_id, first.price_id, "a new entry, not an overwrite");
    const listed = (await env.conns.list(env.ctx(next_key(env))))[0]!;
    const current = listed.prices.filter((p: ConnectionDto["prices"][number]) => p.model === MODEL_A);
    assert.ok(current.length >= 1);
    assert.equal(current[current.length - 1]!.input_per_mtok_micros, 4_000_000, "the newest entry is the current price");
  });
});

test("select needs an existing connection and a model; list never carries a secret", async () => {
  await with_a_env("anthropic", async (env) => {
    await rejects_one_of(select_model(env, "no-such-connection"), "not_found");
    const dto = await register_connection(env);
    await rejects_one_of(env.conns.select(env.ctx(next_key(env)), { connection_id: dto.connection_id, model: "" }), "invalid_payload");
    const sel = await select_model(env, dto.connection_id, MODEL_B);
    assert.equal(sel.model, MODEL_B);
    assert.equal(sel.connection_id, dto.connection_id);
    assert.equal(sel.project_id, env.p.project_id);
    const list = await env.conns.list(env.ctx(next_key(env)));
    assert_no_key(JSON.stringify(list), "the connection list");
    for (const row of list) {
      assert.deepEqual(
        Object.keys(row).filter((k) => /key|secret|token|password/i.test(k)).sort(),
        ["key_last4", "key_set_at", "key_set_by", "key_storage"],
        "only the display facts about the key are exposed",
      );
    }
  });
});

test("a second environment does not see another environment's connection or key", async () => {
  const a = await make_a_env("openai_compatible");
  const b = await make_a_env("openai_compatible");
  try {
    await register_connection(a);
    assert.deepEqual(await b.conns.list(b.ctx("list-b")), []);
    assert.equal(b.keys.keys.size, 0);
  } finally {
    await a.close_all();
    await b.close_all();
  }
});
