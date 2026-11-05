import test from "node:test";
import assert from "node:assert/strict";
import { handleCore } from "../ts-core/http.ts";
import { freshDb, DDL } from "./helpers.ts";
import { SqliteDb } from "../ts-core/sqlite-adapter.ts";
import { validateObject } from "../ts-core/dto.ts";
import { PesError } from "../ts-core/contract.ts";

test("unknown route returns route_not_found", async () => {
  const db = await freshDb();
  const result = await handleCore(
    { db },
    { method: "GET", pathname: "/api/v1/nope", headers: {} },
  );
  assert.equal(result.status, 404);
  if ("error" in result.envelope) assert.equal(result.envelope.error.code, "route_not_found");
});

test("wrong method returns method_not_allowed", async () => {
  const db = await freshDb();
  const result = await handleCore(
    { db },
    { method: "GET", pathname: "/api/v1/projects/prj_01J9Z3K7Q2/claims", headers: {} },
  );
  assert.equal(result.status, 405);
});

test("missing agent token is unauthorized", async () => {
  const db = await freshDb();
  const result = await handleCore(
    { db },
    { method: "GET", pathname: "/api/v1/projects/prj_01J9Z3K7Q2/context", headers: {} },
  );
  assert.equal(result.status, 401);
});

test("missing project is 404 before any membership leak", async () => {
  const db = await freshDb();
  const result = await handleCore(
    { db },
    {
      method: "GET",
      pathname: "/api/v1/projects/prj_other/context",
      headers: { Authorization: "Bearer ${PES_AGENT_TOKEN}" },
    },
  );
  assert.equal(result.status, 404);
});

test("request DTO rejects unknown fields and missing required fields", () => {
  assert.throws(
    () => validateObject({ format_version: "1.0", extra: 1 }, { format_version: { type: "enum", values: ["1.0"] } }, "$.body"),
    (error: unknown) =>
      error instanceof PesError &&
      error.code === "validation_failed" &&
      error.target === "$.body.extra",
  );
  assert.throws(
    () => validateObject({}, { format_version: { type: "enum", values: ["1.0"] } }, "$.body"),
    (error: unknown) =>
      error instanceof PesError &&
      error.code === "validation_failed" &&
      error.target === "$.body.format_version",
  );
});

test("DTO decimal rejects Number and leading zeros", () => {
  for (const value of [12, "012", "1.0", "-1"]) {
    assert.throws(
      () =>
        validateObject(
          { format_version: "1.0", rev: value },
          {
            format_version: { type: "enum", values: ["1.0"] },
            rev: { type: "decimal" },
          },
          "$.body",
        ),
      PesError,
    );
  }
});

test("SQLite DDL applies with 61 tables and foreign keys enabled", async () => {
  const db = new SqliteDb(":memory:");
  await db.exec(DDL);
  const tables = await db.all<{ n: number }>(
    `SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
  );
  assert.equal(tables[0]?.n, 61);
  const fk = await db.all<{ foreign_keys: number }>("PRAGMA foreign_keys");
  assert.equal(fk[0]?.foreign_keys, 1);
  db.close();
});
