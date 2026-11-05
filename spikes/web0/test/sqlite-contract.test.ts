import test from "node:test";
import assert from "node:assert/strict";
import { SqliteDb } from "../ts-core/sqlite-adapter.ts";
import { runContractSuite } from "../ts-core/contract-suite.ts";
import { DDL } from "./helpers.ts";

test("SQLite contract suite: 61 tables, constraints, CAS, rollback, deferred FK, decimals", async () => {
  const db = new SqliteDb(":memory:");
  await db.exec(DDL);
  const result = await runContractSuite(db);
  db.close();

  assert.equal(result.tables, 61);
  const failures = result.checks.filter((check) => check.status === "fail");
  assert.deepEqual(failures, [], JSON.stringify(failures, null, 2));

  const names = new Set(result.checks.map((check) => check.name));
  for (const required of [
    "table_count_61",
    "check_constraint",
    "zero_row_cas",
    "partial_unique_one_project_owner",
    "foreign_key_enforced",
    "deferred_fk_atomic_batch",
    "deferred_fk_missing_member_rejected",
    "batch_atomic_rollback",
    "decimal_roundtrip_cast_text",
    "json_valid_check",
    "json_type_array_check",
    "partial_unique_one_active_edition",
    "partial_unique_one_open_round",
  ]) {
    assert.ok(names.has(required), required);
  }

  const raw = result.checks.find((check) => check.name === "decimal_raw_number_precision_loss");
  assert.equal(raw?.status, "info");
  assert.match(raw?.detail ?? "", /exact=false|threw/);
});
