// Thin Node side of serve.py's /api/v1 boundary (stage 2 PR13).
//
// serve.py reads one HTTP request and runs this file once, piping a JSON
// request in on stdin and relaying the JSON response from stdout. The API
// contract, credentials, and transactions stay in ApiApp; this file only
// opens the local database and serializes the response for the Python server.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ApiApp } from "./api.ts";
import { SystemClock } from "./clock.ts";
import { connect, migrate } from "./db.ts";
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
    // No local config yet; a per-process secret still keeps unauthenticated
    // and token requests working until PR14 installs the human-session model.
  }
  return globalThis.crypto.randomUUID();
}

async function main(): Promise<void> {
  const input = JSON.parse(readFileSync(0, "utf8")) as BridgeInput;
  const env = process.env as Environment;
  const db = connect(db_path(env));
  try {
    migrate(db);
    const app = new ApiApp({
      db,
      clock: new SystemClock(),
      objects_dir: objects_dir(env),
      local_session_secret: local_session_secret(env),
    });
    const body =
      typeof input.body_b64 === "string" && input.body_b64.length > 0
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
