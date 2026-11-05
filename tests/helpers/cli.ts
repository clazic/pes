// Minimal child-process helper. Every child runs with the caller-provided
// environment only, so tests cannot fall back to the real user's home.

import { spawnSync } from "node:child_process";

export interface ChildResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface NodeRunOptions {
  cwd?: string;
  timeout_ms?: number;
}

export function run_node(
  env: Record<string, string | undefined>,
  args: string[],
  options: NodeRunOptions = {},
): ChildResult {
  const result = spawnSync(process.execPath, args, {
    env,
    cwd: options.cwd,
    encoding: "utf8",
    timeout: options.timeout_ms ?? 30_000,
  });
  if (result.error !== undefined) throw result.error;
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}
