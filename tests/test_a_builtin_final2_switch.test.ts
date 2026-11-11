// SEL-52 final review 2/2 (~/hc-work/pes/logs/SEL-52-final-review-2.md), required N3 and N4, with their variants.
// Written BEFORE the fix.
//   N3  while the key AND the address change, the executor / the test never send the NEW key to the OLD address
//       (nor the old key to the new address); afterwards only the new key goes to the new address
//   N4  changing the key, the address, or both voids the earlier "extra charge OFF" confirmation and usage baseline:
//       no start, no resume, no next call until BOTH are recorded again (also within the same millisecond)
// Two fake servers on 127.0.0.1 record which key reached which address. Windows: no child process, no paths.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FINISH,
  FakeAi,
  SYNTHETIC_KEY,
  confirm_off,
  context_turn,
  dispatches,
  make_a_env,
  next_key,
  open_stage,
  ready_project,
  reauth,
  record_baseline,
  resume_outcome,
  set_script,
  start_outcome,
  start_run,
  type AEnv,
  type ExecResult,
  type Format,
} from "./helpers/a_builtin_env.ts";
import { assert_clean, sleep } from "./helpers/a_leak.ts";
import type { ApiError } from "../scripts/pes_core/errors.ts";

const FORMATS: Format[] = ["openai_compatible", "anthropic"];
const KEY_NEW = "sk-synthetic-canary-new0aaaa1111bbbb";

/** did any request this server got carry `key` (header or body)? */
function saw_key(server: FakeAi, key: string): boolean {
  return server.all.some((r) => Object.values(r.headers).some((v) => v.includes(key)) || r.text.includes(key));
}

interface Pair {
  env: AEnv;
  /** the original address: accepts only SYNTHETIC_KEY */
  a: FakeAi;
  /** the new address: accepts only KEY_NEW */
  b: FakeAi;
  close(): Promise<void>;
}

async function make_pair(format: Format): Promise<Pair> {
  const env = await make_a_env(format);
  const b = await FakeAi.start(format, KEY_NEW);
  return {
    env,
    a: env.fake,
    b,
    close: async () => {
      await b.close();
      await env.close_all();
    },
  };
}

// =========================================================================================================
// N3 — new key + old address (or the reverse) is never sent

type During = "run" | "test";

async function race(format: Format, during: During): Promise<void> {
  const pair = await make_pair(format);
  const { env, a, b } = pair;
  try {
    const dto = await ready_project(env, { billing: "pay_per_use" });
    const o = await open_stage(env, "plan");
    set_script(env, [FINISH]);
    b.script = [FINISH];

    let stored!: () => void;
    const key_stored = new Promise<void>((resolve) => {
      stored = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    // hold the change right after the NEW secret reached the key store and before the NEW address is committed
    env.keys.after_put = async (_ref, secret) => {
      if (secret !== KEY_NEW) return;
      stored();
      await Promise.race([released, sleep(400)]);
    };
    const update = env.conns
      .update(env.ctx(next_key(env, "n3")), {
        reauth_code: await reauth(env),
        connection_id: dto.connection_id,
        api_key: KEY_NEW,
        base_url: b.base_url,
      })
      .then(
        (value) => ({ ok: value }),
        (error: unknown) => ({ error }),
      );
    await Promise.race([key_stored, update]);

    // meanwhile something uses the connection
    let used: Promise<unknown>;
    if (during === "run") {
      used = start_outcome(env, { stage_id: o.stage_id, round_id: o.round_id });
    } else {
      used = env.conns
        .test(env.ctx(next_key(env, "n3t")), { reauth_code: await reauth(env), connection_id: dto.connection_id })
        .then(
          (value) => ({ ok: value }),
          (error: unknown) => ({ error }),
        );
    }
    await used;
    release();
    const done = await update;

    assert.equal(saw_key(a, KEY_NEW), false, "the NEW key never reached the OLD address");
    assert.equal(saw_key(b, SYNTHETIC_KEY), false, "the OLD key never reached the NEW address");
    assert.equal((done as { error?: unknown }).error, undefined, "the change itself works");
  } finally {
    await pair.close();
  }
}

for (const format of FORMATS) {
  for (const during of ["run", "test"] as const) {
    test(`N3 ${format}: key and address change while a ${during} uses the connection -> no key/address cross`, async () => {
      await race(format, during);
    });
  }

  test(`N3 ${format}: after the change only the new key goes to the new address (and nothing else reaches the old one)`, async () => {
    const pair = await make_pair(format);
    const { env, a, b } = pair;
    try {
      const dto = await ready_project(env, { billing: "pay_per_use" });
      const a_requests_before = a.all.length;
      await env.conns.update(env.ctx(next_key(env)), {
        reauth_code: await reauth(env),
        connection_id: dto.connection_id,
        api_key: KEY_NEW,
        base_url: b.base_url,
      });
      const o = await open_stage(env, "plan");
      b.script = [FINISH];
      const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
      assert.equal(res.status, "succeeded");
      assert.equal(a.all.length, a_requests_before, "the old address got no request after the change");
      assert.ok(b.calls.length >= 1, "the new address was called");
      for (const call of b.calls) {
        const header = format === "anthropic" ? call.headers["x-api-key"] : call.headers["authorization"];
        assert.ok(header?.includes(KEY_NEW), "with the new key");
        assert.equal(Object.values(call.headers).some((v) => v.includes(SYNTHETIC_KEY)), false);
      }
      assert.equal(saw_key(a, KEY_NEW), false);
    } finally {
      await pair.close();
    }
  });
}

test("N3: two changes of key+address in a row keep every key with its own address", async () => {
  const pair = await make_pair("openai_compatible");
  const { env, a, b } = pair;
  try {
    const dto = await ready_project(env, { billing: "pay_per_use" });
    const c = await FakeAi.start("openai_compatible", "sk-synthetic-canary-third2222cccc3333");
    try {
      await env.conns.update(env.ctx(next_key(env)), { reauth_code: await reauth(env), connection_id: dto.connection_id, api_key: KEY_NEW, base_url: b.base_url });
      await env.conns.update(env.ctx(next_key(env)), {
        reauth_code: await reauth(env),
        connection_id: dto.connection_id,
        api_key: "sk-synthetic-canary-third2222cccc3333",
        base_url: c.base_url,
      });
      assert.equal(saw_key(a, KEY_NEW), false);
      assert.equal(saw_key(a, "sk-synthetic-canary-third2222cccc3333"), false);
      assert.equal(saw_key(b, "sk-synthetic-canary-third2222cccc3333"), false);
      assert.equal(saw_key(b, SYNTHETIC_KEY), false);
      assert.equal(saw_key(c, SYNTHETIC_KEY), false);
      assert.equal(saw_key(c, KEY_NEW), false);
    } finally {
      await c.close();
    }
  } finally {
    await pair.close();
  }
});

// =========================================================================================================
// N4 — a key / address change voids the "extra charge OFF" confirmation and the usage baseline

type Change = "key only" | "address only" | "key and address";

interface Setup {
  pair: Pair;
  connection_id: string;
  apply(): Promise<void>;
  total_calls(): number;
}

async function change_setup(format: Format, change: Change): Promise<Setup> {
  const pair = await make_pair(format);
  const { env, a, b } = pair;
  // a: accepts the old key AND the new key; b: accepts both too (so an address-only / key-only change is accepted)
  a.accepted_keys.add(KEY_NEW);
  b.accepted_keys.add(SYNTHETIC_KEY);
  a.script = () => FINISH;
  b.script = () => FINISH;
  const dto = await ready_project(env); // subscription: confirmation + baseline recorded, long valid
  const connection_id = dto.connection_id;
  return {
    pair,
    connection_id,
    total_calls: () => a.calls.length + b.calls.length,
    apply: async () => {
      const fields: Record<string, unknown> = {};
      if (change !== "address only") fields["api_key"] = KEY_NEW;
      if (change !== "key only") fields["base_url"] = b.base_url;
      await env.conns.update(env.ctx(next_key(env, "n4")), { reauth_code: await reauth(env), connection_id, ...fields });
    },
  };
}

function refused_or_stopped(out: { result: ExecResult | null; error: ApiError | null }, why: string): void {
  if (out.result !== null) assert.notEqual(out.result.status, "succeeded", `${why}: the run must not succeed`);
  assert.equal(out.result === null && out.error === null, false, why);
}

const CHANGES: Change[] = ["key only", "address only", "key and address"];

for (const format of FORMATS) {
  for (const change of CHANGES) {
    for (const gap of [0, 1]) {
      test(`N4 ${format}: ${change} (clock +${gap}ms) -> no start until a NEW confirmation and a NEW baseline; then it runs`, async () => {
        const s = await change_setup(format, change);
        const { env } = s.pair;
        try {
          const o = await open_stage(env, "plan");
          env.clock.advance(gap);
          await s.apply();
          env.clock.advance(gap);

          refused_or_stopped(await start_outcome(env, { stage_id: o.stage_id, round_id: o.round_id }), "after the change");
          assert.equal(s.total_calls(), 0, "no model call after the change, before re-confirming");
          assert.equal(dispatches(env).length, 0, "no dispatch row either");

          await confirm_off(env, s.connection_id);
          refused_or_stopped(await start_outcome(env, { stage_id: o.stage_id, round_id: o.round_id }), "only the new confirmation");
          assert.equal(s.total_calls(), 0, "the new confirmation alone is not enough");

          await record_baseline(env, s.connection_id);
          const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
          assert.equal(res.status, "succeeded", "both new records are in: the run goes");
          assert.ok(s.total_calls() >= 1);
        } finally {
          await s.pair.close();
        }
      });

      test(`N4 ${format}: ${change} (clock +${gap}ms) -> the new baseline first, then the new confirmation, also opens it`, async () => {
        const s = await change_setup(format, change);
        const { env } = s.pair;
        try {
          const o = await open_stage(env, "plan");
          env.clock.advance(gap);
          await s.apply();
          env.clock.advance(gap);
          await record_baseline(env, s.connection_id);
          refused_or_stopped(await start_outcome(env, { stage_id: o.stage_id, round_id: o.round_id }), "only the new baseline");
          assert.equal(s.total_calls(), 0, "the new baseline alone is not enough");
          await confirm_off(env, s.connection_id);
          const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
          assert.equal(res.status, "succeeded");
        } finally {
          await s.pair.close();
        }
      });
    }
  }
}

// controls: a change that is neither key nor address keeps the records
test("N4: control - renaming or changing the stop percent keeps the confirmation and the baseline", async () => {
  const s = await change_setup("openai_compatible", "key only");
  const { env } = s.pair;
  try {
    const o = await open_stage(env, "plan");
    await env.conns.update(env.ctx(next_key(env)), { reauth_code: await reauth(env), connection_id: s.connection_id, name: "다른 이름" });
    await env.conns.update(env.ctx(next_key(env)), { reauth_code: await reauth(env), connection_id: s.connection_id, stop_percent: 80 });
    const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
    assert.equal(res.status, "succeeded");
  } finally {
    await s.pair.close();
  }
});

// a blocked run does not resume on the old records after a change
for (const change of CHANGES) {
  test(`N4: ${change} while a run is blocked -> resume sends nothing until both records are made again`, async () => {
    const s = await change_setup("openai_compatible", change);
    const { env, a } = s.pair;
    try {
      const o = await open_stage(env, "plan");
      // the first call is lost: an unknown call that a person settles as not charged
      a.script = [{ drop: true }];
      const first = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
      assert.equal(first.status, "blocked_usage");
      const unknown = dispatches(env, first.run_id)[0]!;
      await env.service.execute(env.ctx(next_key(env)), "dispatch.resolve_unknown", { dispatch_id: unknown.id, outcome: "not_charged", note: "합성" });
      const calls = s.total_calls();

      await s.apply();
      refused_or_stopped(await resume_outcome(env, first.run_id), "resume after the change");
      assert.equal(s.total_calls(), calls, "no call from the resume");

      await confirm_off(env, s.connection_id);
      await record_baseline(env, s.connection_id);
      a.script = () => FINISH;
      s.pair.b.script = () => FINISH;
      const again = await resume_outcome(env, first.run_id);
      assert.equal(again.error, null, "the resume is allowed again");
      assert.equal(again.result?.status, "succeeded");
      assert.ok(s.total_calls() > calls);
    } finally {
      await s.pair.close();
    }
  });
}

// the change happens in the middle of a run: the NEXT call does not leave
for (const change of CHANGES) {
  test(`N4: ${change} in the middle of a run -> the next call is not sent`, async () => {
    const s = await change_setup("openai_compatible", change);
    const { env, a } = s.pair;
    try {
      const o = await open_stage(env, "plan");
      a.script = [context_turn(), FINISH];
      a.on_call = async (n) => {
        if (n === 1) await s.apply();
      };
      const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
      assert.notEqual(res.status, "succeeded", "the run does not finish on the voided records");
      await sleep(40);
      assert.equal(s.total_calls(), 1, "only the call that was already in flight");
      assert.equal(s.pair.b.calls.length, 0);
      assert_clean(env.logs.join("\n"), "the log lines");
    } finally {
      await s.pair.close();
    }
  });
}
