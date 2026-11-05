import test from "node:test";
import assert from "node:assert/strict";
import { SqliteDb } from "../ts-core/sqlite-adapter.ts";
import { runRound } from "../ts-core/scenario.ts";
import { startFakeGo } from "../ts-core/fake-go.ts";
import { DDL } from "./helpers.ts";

test("A round scenario executes on node:sqlite with 3 model calls and DB writes", async () => {
  const db = new SqliteDb(":memory:");
  await db.exec(DDL);
  const fake = await startFakeGo();
  try {
    const stats = await runRound(db, { fakeGoUrl: fake.url });
    assert.equal(stats.subrequests, 3);
    assert.equal(fake.stats.requests, 3);
    assert.deepEqual(
      fake.stats.calls.map((call) => call.requestBytes),
      [12 * 1024, 24 * 1024, 28 * 1024],
    );
    assert.deepEqual(
      fake.stats.calls.map((call) => call.responseBytes),
      [8 * 1024, 16 * 1024, 12 * 1024],
    );
    assert.ok(stats.dbWriteOps >= 30, `dbWriteOps=${stats.dbWriteOps}`);
    assert.ok(stats.insertedRows >= 40, `insertedRows=${stats.insertedRows}`);
    assert.equal(stats.tableDeltas.runs, 0); // seeded run is updated, not inserted
    assert.equal(stats.tableDeltas.object_versions, 4); // 2 results + question + answer
    assert.equal(stats.tableDeltas.outbound_dispatches, 3);
    assert.equal(stats.tableDeltas.questions, 1);
    assert.equal(stats.tableDeltas.answers, 1);
    assert.equal(stats.tableDeltas.submissions, 1);

    const run = await db.all<{ status: string }>(`SELECT status FROM runs WHERE id = ?`, [
      stats.ids.run,
    ]);
    assert.equal(run[0]?.status, "succeeded");
  } finally {
    await fake.stop();
    db.close();
  }
});
