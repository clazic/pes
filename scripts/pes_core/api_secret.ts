// The local session secret of the /api/v1 boundary — shared by scripts/pes_core/api_bridge.ts and scripts/serve.ts.
import { randomBytes } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { pes_dir, type Environment } from "./paths.ts";

const SECRET_FILE = "local_session_secret";

/**
 * The local session secret also keys cursor HMACs, so it must be the same in
 * every bridge process. Order: PES_LOCAL_SESSION_SECRET, then
 * ~/.pes/config.json local_session_secret, then a persistent 0600 file under
 * ~/.pes created once on first need. The secret text is never logged.
 */
export function local_session_secret(env: Environment): string {
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

/**
 * The local session secret if one exists already (environment, config.json, or the file), else null — never creates the file. The server
 * uses it to tell, before anything is created, whether a request to a home without a database could be the owner's.
 */
export function existing_local_session_secret(env: Environment): string | null {
  const from_env = env.PES_LOCAL_SESSION_SECRET;
  if (typeof from_env === "string" && from_env.length > 0) return from_env;
  try {
    const config = JSON.parse(readFileSync(join(pes_dir(env), "config.json"), "utf8")) as { local_session_secret?: unknown };
    if (typeof config.local_session_secret === "string" && config.local_session_secret.length > 0) return config.local_session_secret;
  } catch {
    // no readable config
  }
  return read_secret(join(pes_dir(env), SECRET_FILE));
}
