import test from "node:test";
import assert from "node:assert/strict";
import { call, dataOf, freshDb, loadFixture } from "./helpers.ts";
import { isDecimalString, toBigInt } from "../ts-core/decimal.ts";
import { IDS } from "../ts-core/store.ts";

const BIG = "9007199254740993"; // 2^53 + 1
const BIG_FENCE = "9007199254740993"; // seeded fence 2^53, claim bumps to +1
const BIG_VERSION = "9007199254740993";

test("large decimals survive claim -> results -> complete without Number conversion", async () => {
  const db = await freshDb({ largeDecimals: true });
  const claimFixture = loadFixture("claims.json");
  const claimKey = claimFixture.normal.request.headers?.["Idempotency-Key"] ?? "idem_claim_big";
  const claimBody = {
    format_version: "1.0",
    run_id: IDS.run,
    expected_control_rev: BIG,
    lease_ttl_ms: 120000,
  };
  const claim = await call(db, claimFixture, claimFixture.normal, {
    body: claimBody,
    now: 1762311600000,
  });
  assert.equal(claim.status, 201);
  const claimData = dataOf(claim.envelope);
  assert.equal((claimData.run as Record<string, unknown>).base_control_rev, BIG);
  const lease = claimData.lease as { lease_id: string; fence: string; expires_at: number };
  assert.equal(lease.fence, BIG_FENCE);
  assert.ok(isDecimalString(lease.fence));

  const leaseRows = await db.all<{ fence: string }>(
    `SELECT CAST(fence AS TEXT) AS fence FROM project_leases WHERE project_id = ?`,
    [IDS.project],
  );
  assert.equal(leaseRows[0]?.fence, BIG_FENCE);

  const claimReceipts = await db.all<{ base_control_rev: string; fence: string }>(
    `SELECT CAST(base_control_rev AS TEXT) AS base_control_rev, CAST(fence AS TEXT) AS fence
     FROM mutation_commits WHERE project_id = ? AND client_request_id = ?`,
    [IDS.project, claimKey],
  );
  assert.equal(claimReceipts[0]?.base_control_rev, BIG);
  assert.equal(claimReceipts[0]?.fence, BIG_FENCE);

  const resultsFixture = loadFixture("results.json");
  const resultsBody = structuredClone(resultsFixture.normal.request.body) as Record<string, unknown>;
  resultsBody.lease_id = lease.lease_id;
  resultsBody.fence = lease.fence;
  resultsBody.base_control_rev = BIG;
  const results = await call(db, resultsFixture, resultsFixture.normal, {
    body: resultsBody,
    now: 1762311600001,
  });
  assert.equal(results.status, 201);
  const resultData = dataOf(results.envelope);
  const version = (resultData.object_versions as Record<string, unknown>[])[0];
  const versionId = String(version?.version_id ?? "");
  assert.equal(version?.version_no, BIG_VERSION);
  assert.ok(isDecimalString(resultData.event_seq));
  assert.ok(toBigInt(resultData.event_seq as string) > toBigInt(BIG));

  const objectRows = await db.all<{ rev: string; current_version_id: string }>(
    `SELECT CAST(rev AS TEXT) AS rev, current_version_id FROM objects
     WHERE project_id = ? AND id = ?`,
    [IDS.project, IDS.artifact],
  );
  assert.equal(objectRows[0]?.rev, BIG_VERSION);
  assert.equal(objectRows[0]?.current_version_id, versionId);

  const versionRows = await db.all<{ version_no: string }>(
    `SELECT CAST(version_no AS TEXT) AS version_no FROM object_versions
     WHERE project_id = ? AND id = ?`,
    [IDS.project, versionId],
  );
  assert.equal(versionRows[0]?.version_no, BIG_VERSION);

  const eventRows = await db.all<{ max_seq: string }>(
    `SELECT CAST(MAX(event_seq) AS TEXT) AS max_seq FROM events WHERE project_id = ?`,
    [IDS.project],
  );
  assert.equal(resultData.event_seq, eventRows[0]?.max_seq);

  const resultsReceipts = await db.all<{ base_control_rev: string; fence: string }>(
    `SELECT CAST(base_control_rev AS TEXT) AS base_control_rev, CAST(fence AS TEXT) AS fence
     FROM mutation_commits WHERE project_id = ? AND client_request_id = ?`,
    [IDS.project, resultsFixture.normal.request.headers?.["Idempotency-Key"] ?? ""],
  );
  assert.equal(resultsReceipts[0]?.base_control_rev, BIG);
  assert.equal(resultsReceipts[0]?.fence, BIG_FENCE);

  const completeFixture = loadFixture("complete.json");
  const completeBody = structuredClone(completeFixture.normal.request.body) as Record<string, unknown>;
  completeBody.lease_id = lease.lease_id;
  completeBody.fence = lease.fence;
  const complete = await call(db, completeFixture, completeFixture.normal, {
    body: completeBody,
    now: 1762311600002,
  });
  assert.equal(complete.status, 200);
  assert.equal(
    (dataOf(complete.envelope).run as Record<string, unknown>).status,
    "succeeded",
  );

  const completeReceipts = await db.all<{ fence: string }>(
    `SELECT CAST(fence AS TEXT) AS fence FROM mutation_commits
     WHERE project_id = ? AND client_request_id = ?`,
    [IDS.project, completeFixture.normal.request.headers?.["Idempotency-Key"] ?? ""],
  );
  assert.equal(completeReceipts[0]?.fence, BIG_FENCE);
});
