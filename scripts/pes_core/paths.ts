// PES home layout. Stage-2 decision 2.7: the database and objects always live
// under ~/.pes on the local machine. PES_HOME only moves project folders, so it
// deliberately does not participate here.
//
// The environment object is required and has no default: a caller that forgets
// to pass an isolated environment must fail instead of silently touching the
// real user's home.

import { join } from "node:path";

export type Environment = Record<string, string | undefined>;

function home_dir(env: Environment): string {
  const variable = process.platform === "win32" ? "USERPROFILE" : "HOME";
  const value = env[variable];
  const home = typeof value === "string" ? value.trim() : "";
  if (home.length === 0) {
    throw new Error(`${variable} is required to locate the PES home; no home-directory fallback is used`);
  }
  return home;
}

export function pes_dir(env: Environment): string {
  return join(home_dir(env), ".pes");
}

export function db_path(env: Environment): string {
  return join(pes_dir(env), "pes.db");
}

export function objects_dir(env: Environment): string {
  return join(pes_dir(env), "objects");
}
