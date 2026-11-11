// SEL-53 helpers: env lifecycle for the adapter tests and the shared "claim a run" steps.

import assert from "node:assert/strict";

import { FakeMcpClient, make_adapter_env, type AdapterEnv } from "./adapter_b_env.ts";

/** Runs fn with a fresh adapter env; every client opened through `open` is closed, then the env is closed. */
export async function with_cleanup(
  fn: (env: AdapterEnv, open: <T extends FakeMcpClient>(client: T) => T) => Promise<void>,
): Promise<void> {
  const env = await make_adapter_env();
  const opened: FakeMcpClient[] = [];
  try {
    await fn(env, (client) => {
      opened.push(client);
      return client;
    });
  } finally {
    for (const client of opened) await client.close();
    env.close();
  }
}

export interface Claimed {
  run_id: string;
  lease_id: string;
  fence: string;
}

/** Claim a fresh run through the tool and check the shape every later test relies on. */
export async function claim_fresh(client: FakeMcpClient): Promise<Claimed> {
  const out = await client.ok("pes_claim", { idempotency_key: `claim-${Math.random().toString(36).slice(2)}` });
  assert.equal(typeof out.run_id, "string");
  assert.equal(typeof out.lease_id, "string");
  assert.match(out.fence, /^(0|[1-9][0-9]*)$/);
  return { run_id: out.run_id, lease_id: out.lease_id, fence: out.fence };
}

/** Rows of `events` of a type, newest last. */
export function events_of_type(env: AdapterEnv, type: string, project_id: string = env.p.project_id): Array<{ id: string; run_id: string | null; tx_id: string; payload: string }> {
  return env.db.all(
    "SELECT id, run_id, tx_id, payload FROM events WHERE project_id = ? AND type = ? ORDER BY event_seq",
    project_id,
    type,
  ) as any;
}
