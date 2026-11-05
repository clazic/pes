import test from "node:test";
import assert from "node:assert/strict";
import { call, dataOf, freshDb, loadFixture } from "./helpers.ts";
import { IDS, makeIds, newId, seedBase } from "../ts-core/store.ts";
import { toBigInt } from "../ts-core/decimal.ts";

const T0 = 1762311600000;

test("results event_seq is the actual last event for the tx, not a project MAX estimate", async () => {
  const db = await freshDb();
  const other = makeIds("other");
  await seedBase(db, { ids: other });

  const claimFixture = loadFixture("claims.json");
  const claim = await call(db, claimFixture, claimFixture.normal);
  assert.equal(claim.status, 201);
  const lease = dataOf(claim.envelope).lease as { lease_id: string; fence: string };

  // Five events for another project land between this project's claim and results.
  for (let index = 0; index < 5; index += 1) {
    await db.run(
      `INSERT INTO events
        (id, project_id, tx_id, tx_index, tx_size, type, payload, schema_version, created_at)
        VALUES (?, ?, ?, ?, 5, 'other.project', '{}', 1, ?)`,
      [newId("evt"), other.project, other.seedTx, index, T0 + index],
    );
  }

  const before = await db.all<{ max_seq: string }>(
    `SELECT CAST(COALESCE(MAX(event_seq), 0) AS TEXT) AS max_seq
     FROM events WHERE project_id = ?`,
    [IDS.project],
  );
  const projectMaxBefore = before[0]?.max_seq ?? "0";

  const resultsFixture = loadFixture("results.json");
  const body = structuredClone(resultsFixture.normal.request.body) as Record<string, unknown>;
  body.lease_id = lease.lease_id;
  body.fence = lease.fence;
  const result = await call(db, resultsFixture, resultsFixture.normal, { body });
  assert.equal(result.status, 201);
  const data = dataOf(result.envelope);
  const txId = String(data.mutation_id ?? "");

  const actualRows = await db.all<{ last_seq: string }>(
    `SELECT CAST(MAX(event_seq) AS TEXT) AS last_seq FROM events WHERE tx_id = ?`,
    [txId],
  );
  const actual = actualRows[0]?.last_seq ?? "";
  assert.equal(data.event_seq, actual);
  assert.ok(toBigInt(actual) > toBigInt(projectMaxBefore));
  // The old estimate (project max + 2) would be wrong with interleaved events.
  assert.notEqual(actual, (toBigInt(projectMaxBefore) + 2n).toString());

  const receiptRows = await db.all<{ result_json: string }>(
    `SELECT result_json FROM mutation_commits WHERE project_id = ? AND id = ?`,
    [IDS.project, txId],
  );
  const receipt = JSON.parse(receiptRows[0]?.result_json ?? "{}") as { event_seq?: string };
  assert.equal(receipt.event_seq, actual);

  const eventCount = await db.all<{ n: number }>(
    `SELECT COUNT(*) AS n FROM events WHERE tx_id = ?`,
    [txId],
  );
  assert.equal(eventCount[0]?.n, 2);

  const replay = await call(db, resultsFixture, resultsFixture.normal, { body });
  assert.equal(replay.status, 201);
  const replayData = dataOf(replay.envelope);
  assert.equal(replayData.replayed, true);
  assert.equal(replayData.event_seq, actual);
});
