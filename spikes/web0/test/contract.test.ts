import test from "node:test";
import assert from "node:assert/strict";
import { call, dataOf, errorOf, freshDb, loadFixture, type Fixture } from "./helpers.ts";
import type { Envelope } from "../ts-core/service.ts";

const ERROR_KEYS = ["code", "details", "message", "next_action", "retryable", "target"];

function assertSuccess(
  result: { status: number; envelope: Envelope },
  status: number,
  expectedDataKeys: string[],
): Record<string, unknown> {
  assert.equal(result.status, status);
  const data = dataOf(result.envelope);
  assert.deepEqual(Object.keys(data).sort(), [...expectedDataKeys].sort());
  return data;
}

function assertError(
  result: { status: number; envelope: Envelope },
  status: number,
  code: string,
): Record<string, unknown> {
  assert.equal(result.status, status);
  const error = errorOf(result.envelope);
  assert.equal(error.code, code);
  assert.deepEqual(Object.keys(error).sort(), ERROR_KEYS);
  return error;
}

async function claimOnce(db: Awaited<ReturnType<typeof freshDb>>): Promise<{
  lease_id: string;
  fence: string;
}> {
  const fixture = loadFixture("claims.json");
  const result = await call(db, fixture, fixture.normal);
  assert.equal(result.status, 201);
  return dataOf(result.envelope).lease as { lease_id: string; fence: string };
}

function requiredKeysPresent(actual: Record<string, unknown>, required: string[]): void {
  for (const key of required) {
    assert.ok(Object.hasOwn(actual, key), `missing required response field: ${key}`);
  }
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

test("capabilities normal/error", async () => {
  const fixture = loadFixture("capabilities.json");

  const normalDb = await freshDb();
  const normal = await call(normalDb, fixture, fixture.normal);
  assertSuccess(normal, 200, ["server", "api_version", "capabilities"]);

  const errorDb = await freshDb();
  const error = await call(errorDb, fixture, fixture.error, { requireCapabilitiesAuth: true });
  assertError(error, 401, "unauthorized");

  // Fixture note: normal auth is `any`, error case documents a required-auth mode.
  const anonymous = await call(errorDb, fixture, fixture.normal);
  assert.equal(anonymous.status, 200);
});

test("context normal/error", async () => {
  const fixture = loadFixture("context.json");
  const db = await freshDb();
  const normal = await call(db, fixture, fixture.normal);
  const data = assertSuccess(normal, 200, [
    "project",
    "edition",
    "stage",
    "round",
    "policy",
    "digest",
    "manifest",
    "next_cursor",
  ]);
  assert.equal((data.project as Record<string, unknown>).id, "prj_01J9Z3K7Q2");
  assert.equal((data.project as Record<string, unknown>).control_rev, "12");

  const error = await call(db, fixture, fixture.error);
  assertError(error, 404, "project_not_found");
});

test("versions normal/error", async () => {
  const fixture = loadFixture("versions.json");
  const db = await freshDb();
  const normal = await call(db, fixture, fixture.normal);
  const data = assertSuccess(normal, 200, ["object", "version", "artifact", "files"]);
  assert.equal((data.version as Record<string, unknown>).version_no, "3");
  assert.equal((data.object as Record<string, unknown>).rev, "7");

  const error = await call(db, fixture, fixture.error);
  assertError(error, 404, "version_not_found");
});

test("claims normal/error and idempotent replay", async () => {
  const fixture = loadFixture("claims.json");

  const normalDb = await freshDb();
  const normal = await call(normalDb, fixture, fixture.normal);
  const data = assertSuccess(normal, 201, ["run", "lease", "context_cursor"]);
  const lease = data.lease as Record<string, unknown>;
  assert.equal(lease.fence, "3");
  assert.equal((data.run as Record<string, unknown>).status, "running");

  const replay = await call(normalDb, fixture, fixture.normal);
  assert.equal(replay.status, 201);
  assert.equal(dataOf(replay.envelope).replayed, true);

  const errorDb = await freshDb({ competingLease: true });
  const error = await call(errorDb, fixture, fixture.error);
  assertError(error, 409, "lease_held");
  assert.equal(errorOf(error.envelope).retryable, true);
});

test("results normal/replay/error", async () => {
  const fixture = loadFixture("results.json");

  const normalDb = await freshDb();
  const lease = await claimOnce(normalDb);
  const normalBody = withLease(fixture, lease);
  const normal = await call(normalDb, fixture, fixture.normal, { body: normalBody });
  const data = assertSuccess(normal, 201, ["object_versions", "mutation_id", "event_seq"]);
  const version = (data.object_versions as Record<string, unknown>[])[0];
  assert.equal(version?.version_no, "4");
  assert.equal(version?.object_id, "obj_01J9Z3K7Q9");

  const replay = await call(normalDb, fixture, fixture.normal, { body: normalBody });
  assert.equal(replay.status, 201);
  const replayData = dataOf(replay.envelope);
  assert.equal(replayData.replayed, true);
  assert.equal(replayData.mutation_id, data.mutation_id);
  assert.deepEqual(replayData.object_versions, data.object_versions);

  const errorDb = await freshDb();
  const errorLease = await claimOnce(errorDb);
  const errorBody = structuredClone(fixture.error.request.body) as Record<string, unknown>;
  errorBody.lease_id = errorLease.lease_id;
  errorBody.fence = errorLease.fence;
  const error = await call(errorDb, fixture, fixture.error, { body: errorBody });
  assertError(error, 409, "rev_conflict");
  const details = errorOf(error.envelope).details as Record<string, unknown>;
  assert.equal(details.expected, "ver_stale_01J9Z3K7Q2");
  assert.equal(details.current, "ver_01J9Z3K7QA");
});

test("wait normal/error", async () => {
  const fixture = loadFixture("wait.json");

  const normalDb = await freshDb();
  const lease = await claimOnce(normalDb);
  const normalBody = withLease(fixture, lease);
  normalBody.reason = "waiting_human";
  normalBody.question_ids = ["qst_01J9Z3K7QB"];
  const normal = await call(normalDb, fixture, fixture.normal, { body: normalBody });
  const data = assertSuccess(normal, 200, ["run", "lease", "waiting"]);
  assert.equal((data.run as Record<string, unknown>).status, "waiting_human");
  assert.equal((data.lease as Record<string, unknown>).released, true);

  const errorDb = await freshDb();
  await claimOnce(errorDb);
  const error = await call(errorDb, fixture, fixture.error);
  assertError(error, 409, "not_lease_holder");
});

test("complete normal/error and idempotent replay", async () => {
  const fixture = loadFixture("complete.json");

  const normalDb = await freshDb();
  const lease = await claimOnce(normalDb);
  const normalBody = withLease(fixture, lease);
  const normal = await call(normalDb, fixture, fixture.normal, { body: normalBody });
  const data = assertSuccess(normal, 200, ["run", "stage_approved", "note"]);
  assert.equal((data.run as Record<string, unknown>).status, "succeeded");
  assert.equal(data.stage_approved, false);

  const replay = await call(normalDb, fixture, fixture.normal, { body: normalBody });
  assert.equal(replay.status, 200);
  assert.equal(dataOf(replay.envelope).replayed, true);

  const errorDb = await freshDb({ runStatus: "cancelled" });
  // Fixture note: the complete error example omits Idempotency-Key. The harness adds a
  // synthetic key so the state error (run_terminal) is reached; the key requirement is
  // itself exercised in router.test.ts.
  const error = await call(errorDb, fixture, {
    ...fixture.error,
    request: {
      ...fixture.error.request,
      headers: { ...fixture.error.request.headers, "Idempotency-Key": "idem_complete_error_fixture" },
    },
  });
  assertError(error, 409, "run_terminal");
});

test("contract: error codes are fixed snake_case and retryable is boolean", async () => {
  const fixture = loadFixture("results.json");
  const db = await freshDb();
  const lease = await claimOnce(db);
  const body = structuredClone(fixture.error.request.body) as Record<string, unknown>;
  body.lease_id = lease.lease_id;
  body.fence = lease.fence;
  const result = await call(db, fixture, fixture.error, { body });
  const error = errorOf(result.envelope);
  assert.match(String(error.code), /^[a-z][a-z0-9_]*$/);
  assert.equal(typeof error.retryable, "boolean");
  assert.match(String(error.message), /[가-힣]/);
  assert.ok(String(error.target).startsWith("$"));
});

test("contract: unknown request field is rejected; optional response field is allowed", async () => {
  const fixture = loadFixture("claims.json");
  const db = await freshDb();
  const body = structuredClone(fixture.normal.request.body) as Record<string, unknown>;
  body.unexpected_field = true;
  const result = await call(db, fixture, fixture.normal, { body });
  assertError(result, 422, "validation_failed");

  // Success responses allow optional fields. The required keys stay present; unknown
  // response fields are ignored (unlike request DTOs).
  const normal = await call(await freshDb(), fixture, fixture.normal);
  const normalData = dataOf(normal.envelope);
  const withOptionalField = { ...normalData, future_optional_field: { enabled: true } };
  requiredKeysPresent(withOptionalField, ["run", "lease", "context_cursor"]);
  assert.equal((withOptionalField.future_optional_field as { enabled: boolean }).enabled, true);
  assert.throws(() => requiredKeysPresent({ run: {} }, ["run", "lease"]));
});

test("contract: same idempotency key with different body is rejected", async () => {
  const fixture = loadFixture("claims.json");
  const db = await freshDb();
  const first = await call(db, fixture, fixture.normal);
  assert.equal(first.status, 201);
  const changed = structuredClone(fixture.normal.request.body) as Record<string, unknown>;
  changed.lease_ttl_ms = 130000;
  const second = await call(db, fixture, fixture.normal, { body: changed });
  assertError(second, 409, "idempotency_key_reused");
});
