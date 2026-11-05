// Minimal child-process helper. Every child runs with the caller-provided
// environment only, so tests cannot fall back to the real user's home.

import { spawn, spawnSync } from "node:child_process";

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

/** Async sibling of run_node for tests that need genuinely concurrent children. */
export function run_node_async(
  env: Record<string, string | undefined>,
  args: string[],
  options: NodeRunOptions = {},
): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      env,
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`child process timed out after ${options.timeout_ms ?? 30_000}ms`));
    }, options.timeout_ms ?? 30_000);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr });
    });
  });
}
