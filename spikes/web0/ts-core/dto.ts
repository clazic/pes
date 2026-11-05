// Minimal request DTO validator for the spike. Unknown request fields are rejected
// (fixtures README 2.2); response validation is separate and allows extra fields.

import { errors, FORMAT_VERSION } from "./contract.ts";
import { isDecimalString } from "./decimal.ts";

export type FieldSpec =
  | { type: "string"; minLength?: number; maxLength?: number }
  | { type: "decimal" }
  | { type: "integer" }
  | { type: "boolean" }
  | { type: "enum"; values: readonly string[] }
  | { type: "array"; items: FieldSpec; minItems?: number; maxItems?: number }
  | { type: "object"; fields: Record<string, FieldSpec> };

export type ObjectSpec = Record<string, FieldSpec>;

function fail(path: string, expected: string, actual: unknown): never {
  throw errors.validationFailed(path, {
    expected,
    actual_type: actual === null ? "null" : Array.isArray(actual) ? "array" : typeof actual,
  });
}

function checkField(value: unknown, spec: FieldSpec, path: string): unknown {
  switch (spec.type) {
    case "string": {
      if (typeof value !== "string") fail(path, "string", value);
      if (spec.minLength !== undefined && value.length < spec.minLength) {
        fail(path, `string(minLength=${spec.minLength})`, value);
      }
      if (spec.maxLength !== undefined && value.length > spec.maxLength) {
        fail(path, `string(maxLength=${spec.maxLength})`, value);
      }
      return value;
    }
    case "decimal": {
      if (!isDecimalString(value)) fail(path, "canonical decimal string", value);
      return value;
    }
    case "integer": {
      if (typeof value !== "number" || !Number.isInteger(value)) fail(path, "integer", value);
      return value;
    }
    case "boolean": {
      if (typeof value !== "boolean") fail(path, "boolean", value);
      return value;
    }
    case "enum": {
      if (typeof value !== "string" || !spec.values.includes(value)) {
        fail(path, `enum(${spec.values.join("|")})`, value);
      }
      return value;
    }
    case "array": {
      if (!Array.isArray(value)) fail(path, "array", value);
      if (spec.minItems !== undefined && value.length < spec.minItems) {
        fail(path, `array(minItems=${spec.minItems})`, value);
      }
      if (spec.maxItems !== undefined && value.length > spec.maxItems) {
        fail(path, `array(maxItems=${spec.maxItems})`, value);
      }
      return value.map((item, index) => checkField(item, spec.items, `${path}[${index}]`));
    }
    case "object": {
      return validateObject(value, spec.fields, path);
    }
  }
}

export function validateObject(
  value: unknown,
  spec: ObjectSpec,
  path: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "object", value);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(key in spec)) {
      throw errors.validationFailed(`${path}.${key}`, { reason: "unknown_field", field: key });
    }
  }
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(spec)) {
    const childPath = `${path}.${key}`;
    if (!(key in record) || record[key] === undefined) {
      throw errors.validationFailed(childPath, { reason: "required_field_missing", field: key });
    }
    out[key] = checkField(record[key], field, childPath);
  }
  return out;
}

/** Envelope for a parsed request body. */
export function requestEnvelope(value: unknown): Record<string, unknown> {
  return validateObject(
    value,
    {
      format_version: { type: "enum", values: [FORMAT_VERSION] },
    },
    "$.body",
  );
}

export const specs = {
  claim: {
    format_version: { type: "enum", values: [FORMAT_VERSION] },
    run_id: { type: "string", minLength: 1 },
    expected_control_rev: { type: "decimal" },
    lease_ttl_ms: { type: "integer" },
  } satisfies ObjectSpec,

  results: {
    format_version: { type: "enum", values: [FORMAT_VERSION] },
    lease_id: { type: "string", minLength: 1 },
    fence: { type: "decimal" },
    base_control_rev: { type: "decimal" },
    results: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      items: {
        type: "object",
        fields: {
          client_ref: { type: "string", minLength: 1 },
          kind: { type: "enum", values: ["artifact"] },
          object_id: { type: "string", minLength: 1 },
          base_version_id: { type: "string", minLength: 1 },
          title: { type: "string", minLength: 1 },
          body_md: { type: "string" },
          source_version_ids: { type: "array", items: { type: "string", minLength: 1 } },
        },
      },
    },
    input_receipts: {
      type: "array",
      items: {
        type: "object",
        fields: {
          input_version_id: { type: "string", minLength: 1 },
          state: { type: "enum", values: ["seen", "applied", "ignored"] },
        },
      },
    },
  } satisfies ObjectSpec,

  wait: {
    format_version: { type: "enum", values: [FORMAT_VERSION] },
    lease_id: { type: "string", minLength: 1 },
    fence: { type: "decimal" },
    reason: { type: "enum", values: ["waiting_human"] },
    question_ids: { type: "array", items: { type: "string", minLength: 1 } },
  } satisfies ObjectSpec,

  complete: {
    format_version: { type: "enum", values: [FORMAT_VERSION] },
    lease_id: { type: "string", minLength: 1 },
    fence: { type: "decimal" },
    result_version_ids: { type: "array", items: { type: "string", minLength: 1 } },
    status: { type: "enum", values: ["succeeded", "failed"] },
    summary: { type: "string" },
  } satisfies ObjectSpec,
};

export function validateClaim(body: unknown): {
  run_id: string;
  expected_control_rev: string;
  lease_ttl_ms: number;
} {
  return validateObject(body, specs.claim, "$.body") as never;
}

export function validateResults(body: unknown): {
  lease_id: string;
  fence: string;
  base_control_rev: string;
  results: {
    client_ref: string;
    kind: "artifact";
    object_id: string;
    base_version_id: string;
    title: string;
    body_md: string;
    source_version_ids: string[];
  }[];
  input_receipts: { input_version_id: string; state: "seen" | "applied" | "ignored" }[];
} {
  return validateObject(body, specs.results, "$.body") as never;
}

export function validateWait(body: unknown): {
  lease_id: string;
  fence: string;
  reason: "waiting_human";
  question_ids: string[];
} {
  return validateObject(body, specs.wait, "$.body") as never;
}

export function validateComplete(body: unknown): {
  lease_id: string;
  fence: string;
  result_version_ids: string[];
  status: "succeeded" | "failed";
  summary: string;
} {
  return validateObject(body, specs.complete, "$.body") as never;
}
