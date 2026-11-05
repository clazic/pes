import test from "node:test";
import assert from "node:assert/strict";
import { call, dataOf, freshDb, loadFixture } from "./helpers.ts";
import { claimWithKey, submitResults } from "../ts-core/service.ts";
import type { RequestContext } from "../ts-core/service.ts";
import { IDS } from "../ts-core/store.ts";
import { PesError } from "../ts-core/contract.ts";
import type { Db, SqlStatement, SqlValue } from "../ts-core/db.ts";

const T0 = 1762311600000;
const TTL = 120000;
const EXPIRES = T0 + TTL;

function agentCtx(db: Awaited<ReturnType<typeof freshDb>>, now: number): RequestContext {
  return {
    db,
    auth: { kind: "agent", actorId: IDS.agent, projectId: IDS.project },
    now,
    ids: IDS,
  };
}

function claimBody(): Record<string, unknown> {
  return {
    format_version: "1.0",
    run_id: IDS.run,
    expected_control_rev: "12",
    lease_ttl_ms: TTL,
  };
}

async function claimAt(
  db: Awaited<ReturnType<typeof freshDb>>,
  now = T0,
  key = "idem_cas_claim",
): Promise<{ lease_id: string; fence: string }> {
  const ctx = agentCtx(db, now);
  const result = await claimWithKey(ctx, IDS.project, IDS.agent, claimBody(), key);
  assert.equal(result.status, 201);
  return dataOf(result.body).lease as { lease_id: string; fence: string };
}

function leaseBody(lease: { lease_id: string; fence: string }): Record<string, unknown> {
  return {
    format_version: "1.0",
    lease_id: lease.lease_id,
    fence: lease.fence,
    base_control_rev: "12",
    results: [
      {
        client_ref: "r1",
        kind: "artifact",
        object_id: IDS.artifact,
        base_version_id: IDS.baseVersion,
        title: "2장 합성 정책 분석",
        body_md: "## 합성 결과",
        source_version_ids: [IDS.inputVersion],
      },
    ],
    input_receipts: [{ input_version_id: IDS.inputVersion, state: "applied" }],
  };
}

function waitBody(lease: { lease_id: string; fence: string }): Record<string, unknown> {
  return {
    format_version: "1.0",
    lease_id: lease.lease_id,
    fence: lease.fence,
    reason: "waiting_human",
    question_ids: [IDS.question],
  };
}

function completeBody(lease: { lease_id: string; fence: string }): Record<string, unknown> {
  return {
    format_version: "1.0",
    lease_id: lease.lease_id,
    fence: lease.fence,
    result_version_ids: [IDS.baseVersion],
    status: "succeeded",
    summary: "합성 완료",
  };
}

test("CAS: two claims with different keys - only one wins", async () => {
  const db = await freshDb();
  const results = await Promise.allSettled([
    claimWithKey(agentCtx(db, T0), IDS.project, IDS.agent, claimBody(), "idem_cas_a"),
    claimWithKey(agentCtx(db, T0), IDS.project, IDS.agent, claimBody(), "idem_cas_b"),
  ]);
  const fulfilled = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result) => result.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  const reason = rejected[0]?.status === "rejected" ? rejected[0].reason : null;
  assert.ok(reason instanceof PesError, "loser must be a PesError");
  assert.equal(reason.code, "lease_held");

  const leases = await db.all<{ n: number; fence: string }>(
    `SELECT COUNT(*) AS n, CAST(MAX(fence) AS TEXT) AS fence
     FROM project_leases WHERE project_id = ? AND state = 'active'`,
    [IDS.project],
  );
  assert.equal(leases[0]?.n, 1);
  assert.equal(leases[0]?.fence, "3");

  const claims = await db.all<{ n: number }>(
    `SELECT COUNT(*) AS n FROM mutation_commits
     WHERE project_id = ? AND action = 'runs.claim'`,
    [IDS.project],
  );
  assert.equal(claims[0]?.n, 1);
  const events = await db.all<{ n: number }>(
    `SELECT COUNT(*) AS n FROM events WHERE project_id = ? AND type = 'run.claimed'`,
    [IDS.project],
  );
  assert.equal(events[0]?.n, 2);
});

test("CAS: two claims with the same key converge to one claim + replay", async () => {
  const db = await freshDb();
  const results = await Promise.allSettled([
    claimWithKey(agentCtx(db, T0), IDS.project, IDS.agent, claimBody(), "idem_cas_same"),
    claimWithKey(agentCtx(db, T0), IDS.project, IDS.agent, claimBody(), "idem_cas_same"),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 2);
  const data = results.map((result) => {
    assert.equal(result.status, "fulfilled");
    if (result.status !== "fulfilled") throw new Error("unreachable");
    assert.equal(result.value.status, 201);
    return dataOf(result.value.body);
  });
  const leases = data.map((body) => body.lease as { lease_id: string; fence: string });
  assert.equal(leases[0]?.lease_id, leases[1]?.lease_id);
  assert.equal(leases[0]?.fence, leases[1]?.fence);
  assert.equal(data.filter((body) => body.replayed === true).length, 1);

  const claims = await db.all<{ n: number }>(
    `SELECT COUNT(*) AS n FROM mutation_commits
     WHERE project_id = ? AND action = 'runs.claim'`,
    [IDS.project],
  );
  assert.equal(claims[0]?.n, 1);
  const events = await db.all<{ n: number }>(
    `SELECT COUNT(*) AS n FROM events WHERE project_id = ? AND type = 'run.claimed'`,
    [IDS.project],
  );
  assert.equal(events[0]?.n, 2);
});

test("lease expiry boundary: results/wait/complete reject at expires_at", async () => {
  for (const [name, fixtureName, bodyOf] of [
    ["results", "results.json", leaseBody],
    ["wait", "wait.json", waitBody],
    ["complete", "complete.json", completeBody],
  ] as const) {
    for (const delta of [-1, 0, 1]) {
      const db = await freshDb();
      const lease = await claimAt(db, T0, `idem_exp_${name}_${delta}`);
      const fixture = loadFixture(fixtureName);
      const result = await call(db, fixture, fixture.normal, {
        body: bodyOf(lease),
        now: EXPIRES + delta,
      });
      if (delta === -1) {
        assert.equal(result.status, name === "results" ? 201 : 200, `${name} at expiry-1`);
      } else {
        assert.equal(result.status, 409, `${name} at expiry+${delta}`);
        assert.equal(
          ("error" in result.envelope ? result.envelope.error.code : ""),
          "lease_lost",
          `${name} at expiry+${delta}`,
        );
      }
    }
  }
});

test("expired complete cannot make a new change but replays the original receipt", async () => {
  const db = await freshDb();
  const lease = await claimAt(db, T0, "idem_exp_replay_claim");
  const fixture = loadFixture("complete.json");
  const body = completeBody(lease);
  const first = await call(db, fixture, fixture.normal, { body, now: T0 + 1000 });
  assert.equal(first.status, 200);
  const dataBefore = dataOf(first.envelope);

  const replay = await call(db, fixture, fixture.normal, { body, now: EXPIRES + 1 });
  assert.equal(replay.status, 200);
  const replayData = dataOf(replay.envelope);
  assert.equal(replayData.replayed, true);
  assert.deepEqual(replayData.run, dataBefore.run);

  const events = await db.all<{ n: number }>(
    `SELECT COUNT(*) AS n FROM events WHERE project_id = ? AND type = 'run.completed'`,
    [IDS.project],
  );
  assert.equal(events[0]?.n, 1);
});

test("results base_control_rev mismatch is rev_conflict and writes nothing", async () => {
  const db = await freshDb();
  const lease = await claimAt(db, T0, "idem_bcr_claim");
  const fixture = loadFixture("results.json");
  const key = fixture.normal.request.headers?.["Idempotency-Key"] ?? "idem_bcr_results";
  const badBody = leaseBody(lease);
  badBody.base_control_rev = "0";

  const before = await Promise.all([
    db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM object_versions WHERE project_id = ?`, [IDS.project]),
    db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM run_input_receipts WHERE project_id = ?`, [IDS.project]),
    db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM events WHERE project_id = ?`, [IDS.project]),
    db.all<{ n: number }>(
      `SELECT COUNT(*) AS n FROM mutation_commits WHERE project_id = ? AND client_request_id = ?`,
      [IDS.project, key],
    ),
  ]);

  const bad = await call(db, fixture, fixture.normal, { body: badBody, now: T0 + 10 });
  assert.equal(bad.status, 409);
  const error = ("error" in bad.envelope ? bad.envelope.error : null);
  assert.equal(error?.code, "rev_conflict");
  assert.equal(error?.target, "$.body.base_control_rev");
  assert.equal((error?.details as Record<string, unknown>).expected, "0");
  assert.equal((error?.details as Record<string, unknown>).current, "12");

  const after = await Promise.all([
    db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM object_versions WHERE project_id = ?`, [IDS.project]),
    db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM run_input_receipts WHERE project_id = ?`, [IDS.project]),
    db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM events WHERE project_id = ?`, [IDS.project]),
    db.all<{ n: number }>(
      `SELECT COUNT(*) AS n FROM mutation_commits WHERE project_id = ? AND client_request_id = ?`,
      [IDS.project, key],
    ),
  ]);
  assert.deepEqual(
    after.map((rows) => rows[0]?.n),
    before.map((rows) => rows[0]?.n),
  );

  // The rejected request left no receipt, so the same key can now submit correctly.
  const good = await call(db, fixture, fixture.normal, { body: leaseBody(lease), now: T0 + 11 });
  assert.equal(good.status, 201);
  const receipt = await db.all<{ base_control_rev: string }>(
    `SELECT CAST(base_control_rev AS TEXT) AS base_control_rev FROM mutation_commits
     WHERE project_id = ? AND client_request_id = ?`,
    [IDS.project, key],
  );
  assert.equal(receipt[0]?.base_control_rev, "12");
});

test("concurrent complete: only one new completion is committed", async () => {
  const db = await freshDb();
  const lease = await claimAt(db, T0, "idem_concurrent_complete_claim");
  const fixture = loadFixture("complete.json");
  const body = completeBody(lease);
  const results = await Promise.allSettled([
    call(db, fixture, fixture.normal, { body, now: T0 + 10 }),
    call(db, fixture, fixture.normal, {
      body,
      now: T0 + 10,
      // Different key so this is not a replay; the CAS must reject it.
      headers: {
        ...(fixture.normal.request.headers ?? {}),
        "Idempotency-Key": "idem_concurrent_complete_b",
      },
    }),
  ]);
  const statuses = results.map((result) => {
    assert.equal(result.status, "fulfilled");
    if (result.status !== "fulfilled") throw new Error("unreachable");
    return result.value.status;
  });
  assert.deepEqual(statuses.sort(), [200, 409]);
  const events = await db.all<{ n: number }>(
    `SELECT COUNT(*) AS n FROM events WHERE project_id = ? AND type = 'run.completed'`,
    [IDS.project],
  );
  assert.equal(events[0]?.n, 1);
});


test("concurrent results with the same key: 201 + 201(replayed), one bundle", async () => {
  const db = await freshDb();
  const lease = await claimAt(db, T0, "idem_res_same_claim");
  const body = leaseBody(lease);
  const ctx = agentCtx(db, T0 + 10);
  const results = await Promise.allSettled([
    submitResults(ctx, IDS.project, IDS.run, body, "idem_res_same"),
    submitResults(ctx, IDS.project, IDS.run, body, "idem_res_same"),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 2);
  const data = results.map((result) => {
    assert.equal(result.status, "fulfilled");
    if (result.status !== "fulfilled") throw new Error("unreachable");
    assert.equal(result.value.status, 201);
    return dataOf(result.value.body);
  });
  assert.equal(data.filter((body) => body.replayed === true).length, 1);
  assert.equal(data[0]?.event_seq, data[1]?.event_seq);
  assert.equal(data[0]?.mutation_id, data[1]?.mutation_id);

  const versions = await db.all<{ n: number }>(
    `SELECT COUNT(*) AS n FROM object_versions WHERE project_id = ? AND object_id = ?`,
    [IDS.project, IDS.artifact],
  );
  assert.equal(versions[0]?.n, 3); // 2 seeded + 1 result
  const receipts = await db.all<{ n: number }>(
    `SELECT COUNT(*) AS n FROM run_input_receipts WHERE project_id = ?`,
    [IDS.project],
  );
  assert.equal(receipts[0]?.n, 1);
  const events = await db.all<{ n: number }>(
    `SELECT COUNT(*) AS n FROM events WHERE project_id = ? AND type = 'results.submitted'`,
    [IDS.project],
  );
  assert.equal(events[0]?.n, 2);
  const mutations = await db.all<{ n: number }>(
    `SELECT COUNT(*) AS n FROM mutation_commits WHERE project_id = ? AND action = 'results.submit'`,
    [IDS.project],
  );
  assert.equal(mutations[0]?.n, 1);
});

test("concurrent results with different keys: 201 + 409 rev_conflict, one bundle", async () => {
  const db = await freshDb();
  const lease = await claimAt(db, T0, "idem_res_diff_claim");
  const body = leaseBody(lease);
  const ctx = agentCtx(db, T0 + 10);
  const results = await Promise.allSettled([
    submitResults(ctx, IDS.project, IDS.run, body, "idem_res_a"),
    submitResults(ctx, IDS.project, IDS.run, body, "idem_res_b"),
  ]);
  const fulfilled = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result) => result.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  const reason = rejected[0]?.status === "rejected" ? rejected[0].reason : null;
  assert.ok(reason instanceof PesError, "loser must be a PesError");
  assert.equal(reason.code, "rev_conflict");

  const versions = await db.all<{ n: number }>(
    `SELECT COUNT(*) AS n FROM object_versions WHERE project_id = ? AND object_id = ?`,
    [IDS.project, IDS.artifact],
  );
  assert.equal(versions[0]?.n, 3);
  const receipts = await db.all<{ n: number }>(
    `SELECT COUNT(*) AS n FROM run_input_receipts WHERE project_id = ?`,
    [IDS.project],
  );
  assert.equal(receipts[0]?.n, 1);
  const events = await db.all<{ n: number }>(
    `SELECT COUNT(*) AS n FROM events WHERE project_id = ? AND type = 'results.submitted'`,
    [IDS.project],
  );
  assert.equal(events[0]?.n, 2);
  const mutations = await db.all<{ n: number }>(
    `SELECT COUNT(*) AS n FROM mutation_commits WHERE project_id = ? AND action = 'results.submit'`,
    [IDS.project],
  );
  assert.equal(mutations[0]?.n, 1);
});

test("unrelated DB error from results is not hidden as replay or rev_conflict", async () => {
  const db = await freshDb();
  const lease = await claimAt(db, T0, "idem_res_fail_claim");
  const failing: Db = {
    all: (sql, params) => db.all(sql, params),
    run: (sql, params) => db.run(sql, params),
    batch: async (_statements: SqlStatement[]) => {
      throw new Error("disk I/O error");
    },
  };
  const ctx: RequestContext = {
    db: failing,
    auth: { kind: "agent", actorId: IDS.agent, projectId: IDS.project },
    now: T0 + 10,
    ids: IDS,
  };
  await assert.rejects(
    submitResults(ctx, IDS.project, IDS.run, leaseBody(lease), "idem_res_fail"),
    /disk I\/O error/,
  );
  const versions = await db.all<{ n: number }>(
    `SELECT COUNT(*) AS n FROM object_versions WHERE project_id = ? AND object_id = ?`,
    [IDS.project, IDS.artifact],
  );
  assert.equal(versions[0]?.n, 2);
});

test("first claim with no lease row succeeds with fence 1", async () => {
  const db = await freshDb();
  await db.run(`DELETE FROM project_leases WHERE project_id = ?`, [IDS.project]);
  const lease = await claimAt(db, T0, "idem_no_lease_ok");
  assert.equal(lease.fence, "1");
  const leases = await db.all<{ n: number }>(
    `SELECT COUNT(*) AS n FROM project_leases WHERE project_id = ? AND state = 'active'`,
    [IDS.project],
  );
  assert.equal(leases[0]?.n, 1);
  const runs = await db.all<{ status: string }>(
    `SELECT status FROM runs WHERE project_id = ? AND id = ?`,
    [IDS.project, IDS.run],
  );
  assert.equal(runs[0]?.status, "running");
});

class LateRevChangeDb implements Db {
  readonly #inner: Db;
  readonly #projectId: string;

  constructor(inner: Db, projectId: string) {
    this.#inner = inner;
    this.#projectId = projectId;
  }

  all<T = Record<string, unknown>>(sql: string, params?: SqlValue[]): Promise<T[]> {
    return this.#inner.all<T>(sql, params);
  }

  run(sql: string, params?: SqlValue[]): Promise<number> {
    return this.#inner.run(sql, params);
  }

  async batch(statements: SqlStatement[]): Promise<number[]> {
    // Simulate another writer changing control_rev after claim pre-read.
    await this.#inner.run(
      `UPDATE projects SET control_rev = 13 WHERE id = ?`,
      [this.#projectId],
    );
    return this.#inner.batch(statements);
  }
}

test("first claim with no lease row still enforces control_rev CAS", async () => {
  const db = await freshDb();
  await db.run(`DELETE FROM project_leases WHERE project_id = ?`, [IDS.project]);
  const ctx: RequestContext = {
    db: new LateRevChangeDb(db, IDS.project),
    auth: { kind: "agent", actorId: IDS.agent, projectId: IDS.project },
    now: T0,
    ids: IDS,
  };
  await assert.rejects(
    claimWithKey(ctx, IDS.project, IDS.agent, claimBody(), "idem_no_lease_race"),
    (error: unknown) => error instanceof PesError && error.code === "rev_conflict",
  );
  const leases = await db.all<{ n: number }>(
    `SELECT COUNT(*) AS n FROM project_leases WHERE project_id = ?`,
    [IDS.project],
  );
  assert.equal(leases[0]?.n, 0);
  const runs = await db.all<{ status: string }>(
    `SELECT status FROM runs WHERE project_id = ? AND id = ?`,
    [IDS.project, IDS.run],
  );
  assert.equal(runs[0]?.status, "queued");
  const mutations = await db.all<{ n: number }>(
    `SELECT COUNT(*) AS n FROM mutation_commits WHERE client_request_id = ?`,
    ["idem_no_lease_race"],
  );
  assert.equal(mutations[0]?.n, 0);
  const events = await db.all<{ n: number }>(
    `SELECT COUNT(*) AS n FROM events WHERE project_id = ? AND type = 'run.claimed'`,
    [IDS.project],
  );
  assert.equal(events[0]?.n, 0);
  const rev = await db.all<{ rev: string }>(
    `SELECT CAST(control_rev AS TEXT) AS rev FROM projects WHERE id = ?`,
    [IDS.project],
  );
  assert.equal(rev[0]?.rev, "13");
});
