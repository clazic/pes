// SEL-52 (PR19) 1차 리뷰 R5-a / R6: a key-store tool that never finishes (a locked keychain, an open password
// dialog) must end in a clear error, not an endless wait — `await key_store.get` runs while the executor holds the
// project lease. The "tool" here is a harmless local Node child that only sleeps; no OS keychain is involved.
// This is the one test that waits for a real timer, so it lives in a file of its own (it takes as long as the
// timeout, about 15 s).

import assert from "node:assert/strict";
import { test } from "node:test";

import { os_key_store, spawn_exec, type ExecFn } from "../scripts/pes_core/a_runtime/keystore.ts";

/** how long a sleeping child lives if nobody kills it (so a missing timeout cannot leave a process for ever) */
const SLEEP_MS = 50_000;
/** the longest a caller may wait for the stuck tool */
const DEADLINE_MS = 40_000;
const SECRET = "sk-synthetic-timeout-canary-4d1b";

const SLEEPER_ARGS = ["-e", `setTimeout(() => {}, ${SLEEP_MS})`];

/** an exec that really spawns the sleeper (default timeout of spawn_exec applies) whatever program the store asks for */
const sleeper_exec: ExecFn = (_program, _args, input, env) => spawn_exec(process.execPath, SLEEPER_ARGS, input, env);

async function outcome_within<T>(promise: Promise<T>, label: string): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: still waiting after ${DEADLINE_MS} ms`)), DEADLINE_MS);
  });
  try {
    return { ok: true, value: await Promise.race([promise, deadline]) };
  } catch (error) {
    return { ok: false, error };
  } finally {
    clearTimeout(timer);
  }
}

test("a key-store tool that never finishes is killed: every call ends in a clear timeout error (and a quick child still works)", async () => {
  // everything runs at once, so the whole test costs one timeout, not nine
  const stuck_direct = outcome_within(spawn_exec(process.execPath, SLEEPER_ARGS, SECRET), "stuck child");
  const results = await Promise.all(
    (["darwin", "win32", "linux"] as const).flatMap((platform) => {
      const store = os_key_store({ platform, exec: sleeper_exec });
      return [
        outcome_within(Promise.resolve(store.put("pes-ai-conn-timeout", SECRET)), `${platform} put`),
        outcome_within(Promise.resolve(store.get("pes-ai-conn-timeout")), `${platform} get`),
        outcome_within(Promise.resolve(store.delete("pes-ai-conn-timeout")), `${platform} delete`),
      ];
    }),
  );
  for (const result of results) {
    assert.equal(result.ok, false, "a stuck tool is an error, never a quiet success");
    if (result.ok) continue;
    assert.ok(result.error instanceof Error);
    assert.match(result.error.message, /time|시간/i, `the message says what happened: ${result.error.message}`);
    assert.equal(result.error.message.includes("still waiting after"), false, "the call ended by itself, not by this test's deadline");
    assert.equal(result.error.message.includes(SECRET), false, "the message does not carry the secret");
  }

  const stuck = await stuck_direct;
  assert.equal(stuck.ok, false);
  if (!stuck.ok) {
    assert.ok(stuck.error instanceof Error);
    assert.match(stuck.error.message, /time|시간/i);
    assert.equal(stuck.error.message.includes("still waiting after"), false);
  }

  const quick = await spawn_exec(
    process.execPath,
    ["-e", "process.stdin.resume();let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{process.stdout.write('got:'+s);process.exit(5)})"],
    "hello",
  );
  assert.equal(quick.code, 5);
  assert.equal(quick.stdout, "got:hello");
});
