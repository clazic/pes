import test from "node:test";
import assert from "node:assert/strict";
import { allFixtures, FIXTURE_NAMES } from "./helpers.ts";

const FORMAT_VERSION = "1.0";
const AUTH_VALUES = new Set([
  "any",
  "agent_token",
  "human",
  "human_owner",
  "human_or_agent",
  "human_or_permitted_agent",
  "human_or_agent_self",
  "human_or_current_agent",
  "agent_or_human",
  "human_or_agent_or_browser",
  "upload_token",
]);
const STATUS_CODES = new Set([200, 201, 202, 400, 401, 403, 404, 409, 410, 413, 422]);
const DECIMAL_KEYS = new Set([
  "rev",
  "control_rev",
  "fence",
  "event_seq",
  "version_no",
  "round_no",
  "edition_no",
]);
const CODE_RE = /^[a-z][a-z0-9_]*$/;
const DECIMAL_RE = /^(0|[1-9][0-9]*)$/;
const HANGUL_RE = /[가-힣]/;

function walkDecimal(node: unknown, path: string, errors: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((value, index) => walkDecimal(value, `${path}[${index}]`, errors));
    return;
  }
  if (typeof node !== "object" || node === null) return;
  for (const [key, value] of Object.entries(node)) {
    const child = `${path}.${key}`;
    if (DECIMAL_KEYS.has(key)) {
      if (typeof value !== "string") {
        errors.push(`${child}: decimal key must be a string`);
      } else if (!DECIMAL_RE.test(value)) {
        errors.push(`${child}: not a canonical decimal string: ${value}`);
      }
    }
    walkDecimal(value, child, errors);
  }
}

function checkSuccessBody(body: Record<string, unknown>, label: string): void {
  assert.equal(body.format_version, FORMAT_VERSION, `${label}: format_version`);
  assert.equal(typeof body.data, "object", `${label}: data object`);
  assert.ok(body.data !== null && !Array.isArray(body.data), `${label}: data is object`);
  const meta = body.meta as Record<string, unknown> | undefined;
  assert.ok(meta && typeof meta === "object", `${label}: meta object`);
  assert.equal(typeof meta.request_id, "string", `${label}: meta.request_id`);
  assert.ok((meta.request_id as string).length > 0, `${label}: meta.request_id non-empty`);
}

function checkErrorBody(body: Record<string, unknown>, label: string): void {
  assert.equal(body.format_version, FORMAT_VERSION, `${label}: format_version`);
  assert.equal(typeof body.request_id, "string", `${label}: request_id`);
  const error = body.error as Record<string, unknown> | undefined;
  assert.ok(error && typeof error === "object", `${label}: error object`);
  assert.match(String(error.code), CODE_RE, `${label}: code`);
  assert.match(String(error.message), HANGUL_RE, `${label}: Korean message`);
  assert.equal(typeof error.retryable, "boolean", `${label}: retryable`);
  assert.ok(String(error.target).startsWith("$"), `${label}: target JSON path`);
  assert.equal(typeof error.details, "object", `${label}: details`);
  assert.ok(error.details !== null && !Array.isArray(error.details), `${label}: details object`);
  assert.ok(
    typeof error.next_action === "string" && (error.next_action as string).length > 0,
    `${label}: next_action`,
  );
}

test("fixture set is exactly 38 JSON files", () => {
  assert.equal(allFixtures().length, 38);
  assert.equal(FIXTURE_NAMES.length, 38);
  assert.equal(new Set(FIXTURE_NAMES).size, 38);
});

for (const { name, fixture } of allFixtures()) {
  test(`fixture ${name}: shape and envelope`, () => {
    assert.equal(typeof fixture.operation, "string", "operation");
    assert.match(fixture.operation, /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/, "operation name");
    assert.ok(["GET", "POST", "PUT", "DELETE"].includes(fixture.method), "method");
    assert.ok(fixture.path.startsWith("/api/v1/"), "path");
    assert.ok(AUTH_VALUES.has(fixture.auth), `auth=${fixture.auth}`);
    for (const extra of Object.keys(fixture)) {
      assert.ok(
        ["operation", "method", "path", "auth", "normal", "error", "replay"].includes(extra),
        `unknown fixture top-level key: ${extra}`,
      );
    }

    for (const caseName of ["normal", "error"] as const) {
      const example = fixture[caseName];
      assert.ok(example && typeof example === "object", `${caseName} exists`);
      assert.ok(example.request, `${caseName}.request`);
      assert.ok(example.response, `${caseName}.response`);
      assert.ok(STATUS_CODES.has(example.response.status), `${caseName}.status`);
      assert.equal(typeof example.request.headers, "object", `${caseName}.request.headers`);
      if (example.request.body !== undefined) {
        assert.equal(example.request.body.format_version, FORMAT_VERSION, `${caseName}.request.format_version`);
      }
    }

    checkSuccessBody(fixture.normal.response.body, `${name} normal`);
    checkErrorBody(fixture.error.response.body, `${name} error`);
    if (fixture.replay) {
      checkSuccessBody(fixture.replay.response.body, `${name} replay`);
      assert.equal((fixture.replay.response.body.data as Record<string, unknown>).replayed, true);
    }

    const decimalErrors: string[] = [];
    walkDecimal(fixture, name, decimalErrors);
    assert.deepEqual(decimalErrors, []);
  });
}

test("all 38 fixtures carry operation/method/path/auth and normal/error", () => {
  const rows = allFixtures().map(({ name, fixture }) => ({
    name,
    operation: fixture.operation,
    method: fixture.method,
    path: fixture.path,
    auth: fixture.auth,
    normal: fixture.normal.response.status,
    error: fixture.error.response.status,
    replay: Boolean(fixture.replay),
  }));
  assert.equal(rows.length, 38);
  assert.equal(rows.filter((row) => row.replay).length, 1);
  assert.equal(rows.find((row) => row.replay)?.name, "results.json");
});

test("required 7 operations exist", () => {
  const operations = new Set(allFixtures().map(({ fixture }) => fixture.operation));
  for (const operation of [
    "capabilities.get",
    "context.get",
    "object.version.get",
    "runs.claim",
    "results.submit",
    "runs.wait",
    "runs.complete",
  ]) {
    assert.ok(operations.has(operation), operation);
  }
});

test("files-content and uploads-put are marked schema-only in the runner", () => {
  const names = new Set<string>(FIXTURE_NAMES);
  assert.ok(names.has("files-content.json"));
  assert.ok(names.has("uploads-put.json"));
});
