// Thin Node side of serve.py's /api/v1 boundary (stage 2 PR13).
//
// `--limits` prints the request-budget policy (limits, control and poll routes) once for serve.py.
// `--migrate` is the one-shot startup entry point serve.py calls before its
// first API request. A normal invocation reads one HTTP request as JSON on
// stdin and relays the ApiApp response as JSON on stdout; it never migrates.
// An unmigrated database is answered with a clear schema_not_ready envelope
// instead of crashing or silently changing the user's schema.

import { readFileSync } from "node:fs";

import { ApiApp } from "./api.ts";
import { local_session_secret } from "./api_secret.ts";
import { SystemClock } from "./clock.ts";
import { connect, load_migrations, migrate, type Db } from "./db.ts";
import { db_path, objects_dir, type Environment } from "./paths.ts";

interface BridgeInput {
  method: string;
  path: string;
  headers: Record<string, string>;
  body_b64?: string | null;
}

interface BridgeOutput {
  status: number;
  headers: Record<string, string>;
  body_b64: string;
  /** Internal to serve.py (rate budget): the credential passed verification. Never sent to the client. */
  credential_verified?: boolean;
}

const FORMAT_VERSION = "1.0";

function newest_schema_version(): bigint {
  const migrations = load_migrations();
  if (migrations.length === 0) throw new Error("no database migrations were found");
  return BigInt(migrations[migrations.length - 1]!.version);
}

/** True only when db_meta names exactly the newest known schema. */
function schema_is_current(db: Db): boolean {
  try {
    const row = db.get<{ schema_version: bigint }>(
      "SELECT schema_version FROM db_meta WHERE id = 1",
    );
    return row !== undefined && row.schema_version === newest_schema_version();
  } catch {
    return false;
  }
}

function error_response(
  status: number,
  code: string,
  message: string,
  request_id: string,
  next_action: string,
): BridgeOutput {
  const body = {
    format_version: FORMAT_VERSION,
    error: {
      code,
      message,
      retryable: status === 503,
      target: null,
      details: null,
      next_action: next_action,
    },
    request_id,
  };
  return {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-request-id": request_id,
    },
    body_b64: Buffer.from(JSON.stringify(body), "utf8").toString("base64"),
  };
}

function migrate_only(env: Environment): void {
  const db = connect(db_path(env));
  try {
    migrate(db);
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const env = process.env as Environment;
  if (process.argv.includes("--migrate")) {
    migrate_only(env);
    return;
  }

  if (process.argv.includes("--limits")) {
    const db = connect(db_path(env));
    try {
      const app = new ApiApp({
        db,
        clock: new SystemClock(),
        objects_dir: objects_dir(env),
        local_session_secret: globalThis.crypto.randomUUID(),
      });
      process.stdout.write(JSON.stringify(app.budget_policy()));
    } finally {
      db.close();
    }
    return;
  }

  const input = JSON.parse(readFileSync(0, "utf8")) as BridgeInput;
  const request_id = globalThis.crypto.randomUUID();
  const db = connect(db_path(env));
  try {
    if (!schema_is_current(db)) {
      process.stdout.write(
        JSON.stringify(
          error_response(
            503,
            "schema_not_ready",
            "PES 데이터베이스가 아직 마이그레이션되지 않았습니다.",
            request_id,
            "migrate_database",
          ),
        ),
      );
      return;
    }
    const app = new ApiApp({
      db,
      clock: new SystemClock(),
      objects_dir: objects_dir(env),
      local_session_secret: local_session_secret(env),
    });
    const body =
      typeof input.body_b64 === "string"
        ? new Uint8Array(Buffer.from(input.body_b64, "base64"))
        : null;
    const response = await app.handle({
      method: typeof input.method === "string" ? input.method : "GET",
      path: typeof input.path === "string" ? input.path : "/",
      headers: input.headers ?? {},
      body,
    });
    const bytes =
      response.bytes ?? new Uint8Array(Buffer.from(JSON.stringify(response.json), "utf8"));
    const output: BridgeOutput = {
      status: response.status,
      headers: response.headers,
      body_b64: Buffer.from(bytes).toString("base64"),
      credential_verified: response.credential_verified === true,
    };
    process.stdout.write(JSON.stringify(output));
  } finally {
    db.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
