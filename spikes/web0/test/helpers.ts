import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SqliteDb } from "../ts-core/sqlite-adapter.ts";
import { handleCore } from "../ts-core/http.ts";
import type { Envelope } from "../ts-core/service.ts";
import { seedBase, type SeedOptions } from "../ts-core/store.ts";

export const FIXTURE_DIR = fileURLToPath(
  new URL("../../../docs/plan/fixtures/api-v1/", import.meta.url),
);
export const DDL_PATH = fileURLToPath(
  new URL("../../../docs/plan/schemas/stage-1-ddl-draft.sql", import.meta.url),
);

export const DDL = readFileSync(DDL_PATH, "utf8");

export const FIXTURE_NAMES = [
  "agent-tokens.json",
  "assumptions.json",
  "cancel.json",
  "capabilities.json",
  "changes.json",
  "claims.json",
  "complete.json",
  "context.json",
  "decisions.json",
  "editions.json",
  "exports.json",
  "files-content.json",
  "followup-apply.json",
  "handoffs.json",
  "heartbeat.json",
  "input-receipts.json",
  "inputs.json",
  "interrupt.json",
  "policy-revisions.json",
  "project-deletion.json",
  "question-revisions.json",
  "questions.json",
  "reflections.json",
  "results.json",
  "round-seal.json",
  "rounds.json",
  "runs.json",
  "stage-approve.json",
  "stage-reopen.json",
  "submissions.json",
  "thread-messages.json",
  "thread-resolutions.json",
  "threads.json",
  "uploads-complete.json",
  "uploads-put.json",
  "uploads.json",
  "versions.json",
  "wait.json",
] as const;

export interface Fixture {
  operation: string;
  method: string;
  path: string;
  auth: string;
  normal: FixtureCase;
  error: FixtureCase;
  replay?: FixtureCase;
}

export interface FixtureCase {
  request: {
    path_params?: Record<string, string>;
    query?: Record<string, string>;
    headers?: Record<string, string>;
    body?: Record<string, unknown>;
  };
  response: {
    status: number;
    headers?: Record<string, string>;
    body: Record<string, unknown>;
  };
}

export function loadFixture(name: string): Fixture {
  return JSON.parse(readFileSync(`${FIXTURE_DIR}${name}`, "utf8")) as Fixture;
}

export function allFixtures(): { name: string; fixture: Fixture }[] {
  return FIXTURE_NAMES.map((name) => ({ name, fixture: loadFixture(name) }));
}

export function concretePath(fixture: Fixture, example: FixtureCase): string {
  let path = fixture.path;
  for (const [key, value] of Object.entries(example.request.path_params ?? {})) {
    path = path.replace(`{${key}}`, encodeURIComponent(value));
  }
  const query = example.request.query;
  if (query && Object.keys(query).length > 0) {
    path += `?${new URLSearchParams(query).toString()}`;
  }
  return path;
}

export async function freshDb(seed: SeedOptions = {}): Promise<SqliteDb> {
  const db = new SqliteDb(":memory:");
  await db.exec(DDL);
  await seedBase(db, seed);
  return db;
}

export async function call(
  db: SqliteDb,
  fixture: Fixture,
  example: FixtureCase,
  options: {
    requireCapabilitiesAuth?: boolean;
    body?: unknown;
    now?: number;
    headers?: Record<string, string>;
  } = {},
): Promise<{ status: number; envelope: Envelope }> {
  return handleCore(
    {
      db,
      requireCapabilitiesAuth: options.requireCapabilitiesAuth,
      now: options.now ?? 1762311600000,
    },
    {
      method: fixture.method,
      pathname: concretePath(fixture, example),
      headers: options.headers ?? example.request.headers ?? {},
      body: options.body ?? example.request.body,
    },
  );
}

export function dataOf(envelope: Envelope): Record<string, unknown> {
  if (!("data" in envelope)) {
    throw new Error(`expected success envelope, got ${JSON.stringify(envelope)}`);
  }
  return envelope.data as Record<string, unknown>;
}

export function errorOf(envelope: Envelope): Record<string, unknown> {
  if (!("error" in envelope)) {
    throw new Error(`expected error envelope, got ${JSON.stringify(envelope)}`);
  }
  return envelope.error as unknown as Record<string, unknown>;
}

export function claimBody(lease: { lease_id: string; fence: string }): Record<string, unknown> {
  return {
    format_version: "1.0",
    lease_id: lease.lease_id,
    fence: lease.fence,
    base_control_rev: "12",
  };
}
