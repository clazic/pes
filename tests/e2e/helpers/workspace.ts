// Test-side harness for tests/e2e/workspace_smoke.spec.ts. Node built-ins only (Playwright's loader runs this file).
//
// open_workspace(): seeds a synthetic DB-backed project in a temporary HOME / USERPROFILE / PES_HOME (tests/e2e/helpers/seed_workspace.ts,
// run with plain Node), starts `python3 -I -X utf8 scripts/serve.py` with PES_DB_CORE=1 on a free port, and offers pes() / pending()
// to run the CLI against the same isolated home. -X utf8 because `python -I` ignores PYTHONIOENCODING (Windows pipes are cp1252).
// close(): stops the server and removes the temporary folders.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { hub_blocked_argv } from "../../helpers/hub_block.ts";

export const REPO = resolve(process.cwd());
export const SESSION_SECRET = "synthetic-owner-session-secret-sel51-e2e";

export interface Workspace {
  slug: string;
  base: string;
  port: number;
  pes(args: string[]): { status: number | null; stdout: string; stderr: string };
  pending(): string[];
  close(): Promise<void>;
}

function free_port(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolvePort(port));
    });
  });
}

export async function open_workspace(): Promise<Workspace> {
  const seeded = spawnSync(process.execPath, [join(REPO, "tests", "e2e", "helpers", "seed_workspace.ts")], { encoding: "utf8", cwd: REPO, timeout: 120_000 });
  if (seeded.status !== 0) throw new Error(`seed_workspace failed (${seeded.status}): ${seeded.stderr}`);
  const info = JSON.parse(seeded.stdout.trim().split("\n").pop() as string) as { root: string; home: string; pes_home: string; slug: string };
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^PES_/.test(k)) env[k] = v;
  Object.assign(env, { HOME: info.home, USERPROFILE: info.home, PES_HOME: info.pes_home, PES_LOCAL_SESSION_SECRET: SESSION_SECRET });
  if (process.env.PES_E2E_V015 !== "1") env.PES_DB_CORE = "1"; // PES_E2E_V015=1: selector self-check against v0.15 (see seed_workspace.ts)
  for (const guard of ["HOME", "USERPROFILE", "PES_HOME"]) {
    if (!env[guard] || !env[guard]!.startsWith(info.root)) throw new Error(`${guard} is not the isolated temporary folder`);
  }

  const port = await free_port();
  const server: ChildProcess = spawn("python3", hub_blocked_argv(["-I", "-X", "utf8", join(REPO, "scripts", "serve.py"), info.pes_home, String(port)]), {
    env,
    cwd: info.root,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  server.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  let exited = false;
  server.once("exit", () => {
    exited = true;
  });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (exited) throw new Error(`serve.py exited early: ${stderr}`);
    try {
      if ((await fetch(`${base}/ping`)).ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`serve.py did not start: ${stderr}`);
    await new Promise((r) => setTimeout(r, 100));
  }

  const pes = (args: string[]) => {
    const r = spawnSync("python3", hub_blocked_argv(["-I", "-X", "utf8", join(REPO, "scripts", "pes.py"), ...args]), { env, cwd: info.root, encoding: "utf8", timeout: 60_000 });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  return {
    slug: info.slug,
    base,
    port,
    pes,
    pending() {
      const r = pes(["pending", info.slug]);
      if (r.status !== 0) throw new Error(`pending failed: ${r.stderr}`);
      return r.stdout.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    },
    async close() {
      if (!exited) {
        await new Promise<void>((done) => {
          server.once("exit", () => done());
          server.kill();
          setTimeout(done, 3000).unref();
        });
      }
      rmSync(info.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}
