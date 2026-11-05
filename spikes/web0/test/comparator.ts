// Fixture-driven contract comparator for the seven required paths.
// Contract: status and error.code are exact; every fixture key must exist in the
// actual response; extra optional fields are allowed; dynamic IDs/times are
// normalized so they never decide the comparison.

import type { Envelope } from "../ts-core/service.ts";
import type { Fixture, FixtureCase } from "./helpers.ts";

const DYNAMIC_KEYS = new Set([
  "id",
  "request_id",
  "digest",
  "next_cursor",
  "context_cursor",
  "created_at",
  "updated_at",
  "expires_at",
  "completed_at",
  "started_at",
  "ended_at",
  "since",
  "sha256",
  "content_hash",
  "request_hash",
  "payload_hash",
  "token_hash",
]);

const DYNAMIC_PREFIX =
  /^(prj|run|lea|ver|mut|req|evt|cur|obj|qst|act|edt|stg|rnd|usr|pol|blb|sub|ans|anv|qsv|grd)_/;

/** Replace IDs and timestamps with placeholders. Used for diagnostics and tests. */
export function normalizeDynamic(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeDynamic(item));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [childKey, child] of Object.entries(value)) {
      out[childKey] = normalizeDynamic(child, childKey);
    }
    return out;
  }
  if (typeof value === "string") {
    if (key && (DYNAMIC_KEYS.has(key) || key.endsWith("_id"))) return "<dynamic>";
    if (DYNAMIC_PREFIX.test(value)) return "<dynamic>";
    return value;
  }
  if (typeof value === "number" && value > 1_000_000_000_000) return "<dynamic>";
  return value;
}

export interface CompareOptions {
  /** Paths where an empty actual list is valid (fileless scenarios). */
  allowEmptyArrayPaths?: string[];
}

export interface ResponseExpectation {
  status: number;
  errorCode?: string;
  replayed?: boolean;
  bodyShape: Record<string, unknown>;
}

export function expectationFromFixture(
  fixture: Fixture,
  caseName: "normal" | "error" | "replay",
): ResponseExpectation {
  const example = fixture[caseName] as FixtureCase | undefined;
  if (!example) throw new Error(`fixture ${fixture.operation} has no ${caseName} case`);
  const body = example.response.body;
  if (caseName === "error") {
    const error = body.error as Record<string, unknown> | undefined;
    if (!error || typeof error.code !== "string") {
      throw new Error(`fixture ${fixture.operation} error body has no error.code`);
    }
    return { status: example.response.status, errorCode: error.code, bodyShape: body };
  }
  return {
    status: example.response.status,
    bodyShape: body,
    replayed: caseName === "replay" ? true : undefined,
  };
}

function requireShape(
  actual: unknown,
  expected: unknown,
  path: string,
  diffs: string[],
  options: CompareOptions,
): void {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      diffs.push(`${path}: expected array, got ${typeName(actual)}`);
      return;
    }
    if (expected.length === 0) return;
    if (actual.length === 0) {
      if (!options.allowEmptyArrayPaths?.includes(path)) {
        diffs.push(`${path}: expected at least one item`);
      }
      return;
    }
    for (let index = 0; index < actual.length; index += 1) {
      requireShape(actual[index], expected[0], `${path}[${index}]`, diffs, options);
    }
    return;
  }
  if (expected !== null && typeof expected === "object") {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) {
      diffs.push(`${path}: expected object, got ${typeName(actual)}`);
      return;
    }
    const actualRecord = actual as Record<string, unknown>;
    for (const key of Object.keys(expected as Record<string, unknown>)) {
      if (!Object.hasOwn(actualRecord, key)) {
        diffs.push(`${path}.${key}: missing required key`);
      } else if (isDynamicKey(key)) {
        checkDynamicType(
          actualRecord[key],
          (expected as Record<string, unknown>)[key],
          `${path}.${key}`,
          diffs,
        );
      } else {
        requireShape(
          actualRecord[key],
          (expected as Record<string, unknown>)[key],
          `${path}.${key}`,
          diffs,
          options,
        );
      }
    }
    return;
  }
  const expectedType = expected === null ? "null" : typeof expected;
  const actualType = actual === null ? "null" : typeof actual;
  if (expectedType !== actualType) {
    diffs.push(`${path}: type ${actualType} !== ${expectedType}`);
  }
}

function checkDynamicType(
  actual: unknown,
  expected: unknown,
  path: string,
  diffs: string[],
): void {
  if (expected === null) {
    if (actual !== null) diffs.push(`${path}: dynamic value must be null`);
    return;
  }
  const expectedType = typeof expected;
  const actualType = actual === null ? "null" : typeof actual;
  if (actualType !== expectedType) {
    diffs.push(`${path}: dynamic type ${actualType} !== ${expectedType}`);
  }
}

function isDynamicKey(key: string): boolean {
  return DYNAMIC_KEYS.has(key) || key.endsWith("_id");
}

function typeName(value: unknown): string {
  return value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
}

export function compareContractResponse(
  actual: { status: number; envelope: Envelope },
  expectation: ResponseExpectation,
  options: CompareOptions = {},
): string[] {
  const diffs: string[] = [];
  if (actual.status !== expectation.status) {
    diffs.push(`status: ${actual.status} !== ${expectation.status}`);
  }
  const envelope = actual.envelope;
  if (expectation.errorCode !== undefined) {
    if (!("error" in envelope)) {
      diffs.push("error envelope missing");
      return diffs;
    }
    if (envelope.error.code !== expectation.errorCode) {
      diffs.push(`error.code: ${envelope.error.code} !== ${expectation.errorCode}`);
    }
    requireShape(envelope, expectation.bodyShape, "$", diffs, options);
    return diffs;
  }
  if (!("data" in envelope)) {
    diffs.push("success envelope missing (got error)");
    return diffs;
  }
  requireShape(envelope, expectation.bodyShape, "$", diffs, options);
  const data = envelope.data as Record<string, unknown>;
  if (expectation.replayed === true && data.replayed !== true) {
    diffs.push("data.replayed: expected true");
  }
  if (expectation.replayed === undefined && data.replayed === true) {
    diffs.push("data.replayed: unexpected true");
  }
  return diffs;
}

export function normalizedView(value: unknown): unknown {
  return normalizeDynamic(value);
}
