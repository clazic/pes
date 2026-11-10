// Thin Node side of serve.py's /api/v1 boundary (stage 2 PR13).
//
// `--limits` prints the request-budget policy (limits, control and poll routes) once for serve.py.
// `--migrate` is the one-shot startup entry point serve.py calls before its
// first API request. A normal invocation reads one HTTP request as JSON on
// stdin and relays the ApiApp response as JSON on stdout; it never migrates.
// An unmigrated database is answered with a clear schema_not_ready envelope
// instead of crashing or silently changing the user's schema.

import { randomBytes } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ApiApp } from "./api.ts";
import { SystemClock } from "./clock.ts";
import { connect, load_migrations, migrate, type Db } from "./db.ts";
import { db_path, objects_dir, pes_dir, type Environment } from "./paths.ts";

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
}

const FORMAT_VERSION = "1.0";

const SECRET_FILE = "local_session_secret";

/**
 * The local session secret also keys cursor HMACs, so it must be the same in
 * every bridge process. Order: PES_LOCAL_SESSION_SECRET, then
 * ~/.pes/config.json local_session_secret, then a persistent 0600 file under
 * ~/.pes created once on first need. The secret text is never logged.
 */
function local_session_secret(env: Environment): string {
  const from_env = env.PES_LOCAL_SESSION_SECRET;
  if (typeof from_env === "string" && from_env.length > 0) return from_env;
  try {
    const config = JSON.parse(readFileSync(join(pes_dir(env), "config.json"), "utf8")) as {
      local_session_secret?: unknown;
    };
    if (typeof config.local_session_secret === "string" && config.local_session_secret.length > 0) {
      return config.local_session_secret;
    }
  } catch {
    // No readable config: fall through to the persistent secret file.
  }
  return persistent_secret(pes_dir(env));
}

function read_secret(path: string): string | null {
  try {
    const text = readFileSync(path, "utf8").trim();
    return text.length >= 16 && !text.includes("\n") ? text : null;
  } catch {
    return null;
  }
}

function persistent_secret(dir: string): string {
  const path = join(dir, SECRET_FILE);
  const existing = read_secret(path);
  if (existing !== null) return existing;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const secret = randomBytes(32).toString("base64url");
  const temp = join(dir, `.${SECRET_FILE}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  writeFileSync(temp, `${secret}\n`, { mode: 0o600, flag: "wx" });
  try {
    // link() refuses to replace an existing file, so two first requests agree
    // on whichever secret was published first.
    linkSync(temp, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    unlinkSync(temp);
  }
  const published = read_secret(path);
  if (published === null) throw new Error("the local session secret file is unreadable or malformed");
  return published;
}

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
