import test from "node:test";
import assert from "node:assert/strict";
import { call, dataOf, errorOf, freshDb, loadFixture, type Fixture } from "./helpers.ts";
import {
  compareContractResponse,
  expectationFromFixture,
  normalizeDynamic,
  type ResponseExpectation,
} from "./comparator.ts";
import type { Envelope } from "../ts-core/service.ts";

function assertContract(
  result: { status: number; envelope: Envelope },
  expectation: ResponseExpectation,
  label: string,
  options: { allowEmptyArrayPaths?: string[] } = {},
): void {
  const diffs = compareContractResponse(result, expectation, options);
  assert.deepEqual(diffs, [], `${label}: ${diffs.join("; ")}`);
}

async function claimOnce(db: Awaited<ReturnType<typeof freshDb>>): Promise<{
  lease_id: string;
  fence: string;
}> {
  const fixture = loadFixture("claims.json");
  const result = await call(db, fixture, fixture.normal);
  assertContract(result, expectationFromFixture(fixture, "normal"), "claim setup");
  return dataOf(result.envelope).lease as { lease_id: string; fence: string };
}

function withLease(
  fixture: Fixture,
  lease: { lease_id: string; fence: string },
): Record<string, unknown> {
  const body = structuredClone(fixture.normal.request.body) as Record<string, unknown>;
  body.lease_id = lease.lease_id;
  body.fence = lease.fence;
  return body;
}

test("capabilities normal/error against fixture", async () => {
  const fixture = loadFixture("capabilities.json");

  const normal = await call(await freshDb(), fixture, fixture.normal);
  assertContract(normal, expectationFromFixture(fixture, "normal"), "capabilities normal");
  const operations = (dataOf(normal.envelope).capabilities as Record<string, unknown>)
    .operations as Record<string, unknown>;
  assert.ok(Object.hasOwn(operations, "exports.create"), "fixture operations.exports.create");

  const error = await call(await freshDb(), fixture, fixture.error, {
    requireCapabilitiesAuth: true,
  });
  assertContract(error, expectationFromFixture(fixture, "error"), "capabilities error");

  // Fixture note: normal auth is `any`; the error example documents a required-auth mode.
  const anonymous = await call(await freshDb(), fixture, fixture.normal);
  assert.equal(anonymous.status, 200);
});

test("context normal/error against fixture", async () => {
  const fixture = loadFixture("context.json");
  const db = await freshDb();
  const normal = await call(db, fixture, fixture.normal);
  assertContract(normal, expectationFromFixture(fixture, "normal"), "context normal");
  const error = await call(db, fixture, fixture.error);
  assertContract(error, expectationFromFixture(fixture, "error"), "context error");
});

test("versions normal/error against fixture", async () => {
  const fixture = loadFixture("versions.json");
  const db = await freshDb();
  const normal = await call(db, fixture, fixture.normal);
  assertContract(normal, expectationFromFixture(fixture, "normal"), "versions normal", {
    allowEmptyArrayPaths: ["$.data.files"],
  });
  const error = await call(db, fixture, fixture.error);
  assertContract(error, expectationFromFixture(fixture, "error"), "versions error");
});

test("claims normal/error/replay against fixture", async () => {
  const fixture = loadFixture("claims.json");

  const normalDb = await freshDb();
  const normal = await call(normalDb, fixture, fixture.normal);
  assertContract(normal, expectationFromFixture(fixture, "normal"), "claims normal");

  const replay = await call(normalDb, fixture, fixture.normal);
  assertContract(
    replay,
    { ...expectationFromFixture(fixture, "normal"), replayed: true },
    "claims replay",
  );

  const errorDb = await freshDb({ competingLease: true });
  const error = await call(errorDb, fixture, fixture.error);
  assertContract(error, expectationFromFixture(fixture, "error"), "claims error");
});

test("results normal/replay/error against fixture", async () => {
  const fixture = loadFixture("results.json");

  const normalDb = await freshDb();
  const lease = await claimOnce(normalDb);
  const normalBody = withLease(fixture, lease);
  const normal = await call(normalDb, fixture, fixture.normal, { body: normalBody });
  assertContract(normal, expectationFromFixture(fixture, "normal"), "results normal");

  const replay = await call(normalDb, fixture, fixture.normal, { body: normalBody });
  assertContract(replay, expectationFromFixture(fixture, "replay"), "results replay");

  const errorDb = await freshDb();
  const errorLease = await claimOnce(errorDb);
  const errorBody = structuredClone(fixture.error.request.body) as Record<string, unknown>;
  errorBody.lease_id = errorLease.lease_id;
  errorBody.fence = errorLease.fence;
  const error = await call(errorDb, fixture, fixture.error, { body: errorBody });
  assertContract(error, expectationFromFixture(fixture, "error"), "results error");
});

test("wait normal/error against fixture", async () => {
  const fixture = loadFixture("wait.json");

  const normalDb = await freshDb();
  const lease = await claimOnce(normalDb);
  const normalBody = withLease(fixture, lease);
  normalBody.reason = "waiting_human";
  normalBody.question_ids = ["qst_01J9Z3K7QB"];
  const normal = await call(normalDb, fixture, fixture.normal, { body: normalBody });
  assertContract(normal, expectationFromFixture(fixture, "normal"), "wait normal");

  const errorDb = await freshDb();
  await claimOnce(errorDb);
  const error = await call(errorDb, fixture, fixture.error);
  assertContract(error, expectationFromFixture(fixture, "error"), "wait error");
});

test("complete normal/error/replay against fixture", async () => {
  const fixture = loadFixture("complete.json");

  const normalDb = await freshDb();
  const lease = await claimOnce(normalDb);
  const normalBody = withLease(fixture, lease);
  const normal = await call(normalDb, fixture, fixture.normal, { body: normalBody });
  assertContract(normal, expectationFromFixture(fixture, "normal"), "complete normal");

  const replay = await call(normalDb, fixture, fixture.normal, { body: normalBody });
  assertContract(
    replay,
    { ...expectationFromFixture(fixture, "normal"), replayed: true },
    "complete replay",
  );

  const errorDb = await freshDb({ runStatus: "cancelled" });
  // Fixture note: the complete error example omits Idempotency-Key. The harness adds
  // a synthetic key so the state error (run_terminal) is reached.
  const error = await call(errorDb, fixture, {
    ...fixture.error,
    request: {
      ...fixture.error.request,
      headers: { ...fixture.error.request.headers, "Idempotency-Key": "idem_complete_error_fixture" },
    },
  });
  assertContract(error, expectationFromFixture(fixture, "error"), "complete error");
});

test("comparator negative: missing required key fails", async () => {
  const fixture = loadFixture("claims.json");
  const normal = await call(await freshDb(), fixture, fixture.normal);
  const envelope = structuredClone(normal.envelope);
  const data = (envelope as { data: Record<string, unknown> }).data;
  delete data.lease;
  const diffs = compareContractResponse(
    { status: normal.status, envelope: envelope as Envelope },
    expectationFromFixture(fixture, "normal"),
  );
  assert.ok(diffs.some((diff) => diff.includes("lease")), diffs.join("; "));
});

test("comparator negative: wrong error code fails", async () => {
  const fixture = loadFixture("claims.json");
  const errorDb = await freshDb({ competingLease: true });
  const actual = await call(errorDb, fixture, fixture.error);
  const expectation = expectationFromFixture(fixture, "error");
  const diffs = compareContractResponse(actual, { ...expectation, errorCode: "wrong_code" });
  assert.ok(diffs.some((diff) => diff.includes("error.code")), diffs.join("; "));
});

test("comparator allows optional response fields and normalizes dynamic IDs/times", async () => {
  const fixture = loadFixture("claims.json");
  const normal = await call(await freshDb(), fixture, fixture.normal);
  const data = dataOf(normal.envelope);
  const withOptional = {
    ...data,
    future_optional_field: { enabled: true },
  };
  const diffs = compareContractResponse(
    { status: 201, envelope: { ...normal.envelope, data: withOptional } as Envelope },
    expectationFromFixture(fixture, "normal"),
  );
  assert.deepEqual(diffs, []);

  const normalized = normalizeDynamic({
    request_id: "req_abc",
    lease: { lease_id: "lea_abc", expires_at: 1762311720000 },
    message: "그대로",
  }) as Record<string, unknown>;
  assert.deepEqual(normalized, {
    request_id: "<dynamic>",
    lease: { lease_id: "<dynamic>", expires_at: "<dynamic>" },
    message: "그대로",
  });
});

test("comparator negative: array tail, dynamic types, and meta.request_id", async () => {
  const fixture = loadFixture("results.json");
  const db = await freshDb();
  const lease = await claimOnce(db);
  const normal = await call(db, fixture, fixture.normal, {
    body: withLease(fixture, lease),
  });
  const data = structuredClone(dataOf(normal.envelope)) as Record<string, unknown>;
  const versions = data.object_versions as Record<string, unknown>[];
  versions.push({});
  data.mutation_id = null;
  const envelope = {
    ...normal.envelope,
    data,
    meta: { ...(normal.envelope as { meta: Record<string, unknown> }).meta, request_id: 42 },
  } as unknown as Envelope;
  const diffs = compareContractResponse(
    { status: 201, envelope },
    expectationFromFixture(fixture, "normal"),
  );
  assert.ok(
    diffs.some((diff) => diff.startsWith("$.data.object_versions[1]")),
    diffs.join("; "),
  );
  assert.ok(diffs.some((diff) => diff.includes("mutation_id")), diffs.join("; "));
  assert.ok(diffs.some((diff) => diff.includes("meta.request_id")), diffs.join("; "));
});

test("comparator negative: empty object_versions is not allowed", async () => {
  const fixture = loadFixture("results.json");
  const db = await freshDb();
  const lease = await claimOnce(db);
  const normal = await call(db, fixture, fixture.normal, {
    body: withLease(fixture, lease),
  });
  const data = structuredClone(dataOf(normal.envelope)) as Record<string, unknown>;
  data.object_versions = [];
  const envelope = { ...normal.envelope, data } as Envelope;
  const diffs = compareContractResponse(
    { status: 201, envelope },
    expectationFromFixture(fixture, "normal"),
  );
  assert.ok(
    diffs.some((diff) => diff.includes("object_versions") && diff.includes("at least one")),
    diffs.join("; "),
  );
});

test("contract: unknown request field is rejected", async () => {
  const fixture = loadFixture("claims.json");
  const db = await freshDb();
  const body = structuredClone(fixture.normal.request.body) as Record<string, unknown>;
  body.unexpected_field = true;
  const result = await call(db, fixture, fixture.normal, { body });
  assert.equal(result.status, 422);
  assert.equal(errorOf(result.envelope).code, "validation_failed");
});

test("contract: same idempotency key with different body is rejected", async () => {
  const fixture = loadFixture("claims.json");
  const db = await freshDb();
  const first = await call(db, fixture, fixture.normal);
  assert.equal(first.status, 201);
  const changed = structuredClone(fixture.normal.request.body) as Record<string, unknown>;
  changed.lease_ttl_ms = 130000;
  const second = await call(db, fixture, fixture.normal, { body: changed });
  assert.equal(second.status, 409);
  assert.equal(errorOf(second.envelope).code, "idempotency_key_reused");
});
