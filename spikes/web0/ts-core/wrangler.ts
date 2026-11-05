// Local-only Wrangler helpers. No login, deploy, or remote resource is used.

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { readdirSync, rmSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createServer } from "node:net";

export const WEB0_ROOT = fileURLToPath(new URL("../", import.meta.url));
export const WRANGLER_BIN = join(WEB0_ROOT, "node_modules/wrangler/bin/wrangler.js");

const baseEnv = {
  ...process.env,
  WRANGLER_SEND_METRICS: "false",
  NO_COLOR: "1",
  CI: "1",
};

export function applyDdl(persistDir: string, ddlPath: string): string {
  rmSync(persistDir, { recursive: true, force: true });
  mkdirSync(persistDir, { recursive: true });
  return execFileSync(
    process.execPath,
    [
      WRANGLER_BIN,
      "d1",
      "execute",
      "pes-web0-spike",
      "--local",
      "--persist-to",
      persistDir,
      "--file",
      ddlPath,
      "--yes",
    ],
    {
      cwd: WEB0_ROOT,
      env: baseEnv,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120000,
    },
  );
}

export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = address && typeof address !== "string" ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

export interface WranglerDev {
  process: ChildProcess;
  pid: number;
  url: string;
  logs: () => string;
  stop: () => Promise<void>;
}

export async function startWranglerDev(options: {
  persistDir: string;
  fakeGoUrl: string;
  port: number;
  timeoutMs?: number;
}): Promise<WranglerDev> {
  const child = spawn(
    process.execPath,
    [
      WRANGLER_BIN,
      "dev",
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      String(options.port),
      "--persist-to",
      options.persistDir,
      "--var",
      `FAKE_GO_URL:${options.fakeGoUrl}`,
      "--log-level",
      "error",
      "--show-interactive-dev-session=false",
    ],
    {
      cwd: WEB0_ROOT,
      env: baseEnv,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const chunks: string[] = [];
  const collect = (chunk: Buffer) => {
    chunks.push(chunk.toString("utf8"));
    if (chunks.length > 200) chunks.shift();
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  const url = `http://127.0.0.1:${options.port}`;
  const deadline = Date.now() + (options.timeoutMs ?? 90000);
  let lastError = "";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`${url}/api/v1/capabilities`);
      if (response.status === 200) {
        return {
          process: child,
          pid: child.pid ?? 0,
          url,
          logs: () => chunks.join(""),
          stop: async () => {
            if (child.exitCode !== null) return;
            child.kill("SIGTERM");
            await new Promise<void>((resolve) => {
              const timer = setTimeout(() => {
                child.kill("SIGKILL");
                resolve();
              }, 8000);
              child.once("exit", () => {
                clearTimeout(timer);
                resolve();
              });
            });
          },
        };
      }
      lastError = `status ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  child.kill("SIGKILL");
  throw new Error(`wrangler dev did not become ready: ${lastError}\n${chunks.join("")}`);
}

export function findD1Sqlite(persistDir: string): string | null {
  const root = join(persistDir, "v3", "d1");
  try {
    const files = (readdirSync(root, { recursive: true }) as string[])
      .map((file) => join(root, file))
      .filter((file) => file.endsWith(".sqlite"));
    return files[0] ?? null;
  } catch {
    return null;
  }
}

export function cleanupDir(path: string): void {
  rmSync(path, { recursive: true, force: true });
}
