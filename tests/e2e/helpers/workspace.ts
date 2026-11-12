// Test-side harness for tests/e2e/workspace_smoke.spec.ts. Node built-ins only (Playwright's loader runs this file).
//
// open_workspace(): seeds a synthetic DB-backed project in a temporary HOME / USERPROFILE / PES_HOME (tests/e2e/helpers/seed_workspace.ts,
// run with plain Node), starts `node scripts/serve.ts` on a free port, and offers pes() / pending() to run the CLI
// (`node scripts/pes.ts`) against the same isolated home. (SEL-74: the 0.15 Python server and CLI are gone.)
// close(): stops the server and removes the temporary folders.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";

export const REPO = resolve(process.cwd());
export const SESSION_SECRET = "synthetic-owner-session-secret-sel51-e2e";

export interface Workspace {
  slug: string;
  /** the project id the API paths use (SEL-82) */
  project_id: string;
  /** the owner session secret the server was started with (x-pes-session) */
  session: string;
  base: string;
  port: number;
  pes(args: string[], extra_env?: Record<string, string>): { status: number | null; stdout: string; stderr: string };
  /**
   * The address `pes open <slug> --app` gives (SEL-82 R1 필수 1): http://127.0.0.1:<port>/p/<slug>/e/../s/../r/..#pes=<base64url JSON>.
   * Runs the real CLI in the isolated home with PES_NO_BROWSER=1 (no browser) and PES_HUB_PORTS=<this server's port> (it finds this server).
   */
  open_app(): string;
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

/** `extra_env`: more variables for the server child only (SEL-82: PES_APP_DIR). `seed_script`: 시드 스크립트 파일명(tests/e2e/helpers 안, 기본 seed_workspace.ts). */
export async function open_workspace(extra_env: Record<string, string> = {}, seed_script = "seed_workspace.ts"): Promise<Workspace> {
  const seeded = spawnSync(process.execPath, [join(REPO, "tests", "e2e", "helpers", seed_script)], { encoding: "utf8", cwd: REPO, timeout: 120_000 });
  if (seeded.status !== 0) throw new Error(`seed_workspace failed (${seeded.status}): ${seeded.stderr}`);
  const info = JSON.parse(seeded.stdout.trim().split("\n").pop() as string) as { root: string; home: string; pes_home: string; slug: string; project_id: string };
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^PES_/.test(k)) env[k] = v;
  Object.assign(env, { HOME: info.home, USERPROFILE: info.home, PES_HOME: info.pes_home, PES_LOCAL_SESSION_SECRET: SESSION_SECRET, ...extra_env });
  for (const guard of ["HOME", "USERPROFILE", "PES_HOME"]) {
    if (!env[guard] || !env[guard]!.startsWith(info.root)) throw new Error(`${guard} is not the isolated temporary folder`);
  }

  const port = await free_port();
  const server: ChildProcess = spawn(process.execPath, [join(REPO, "scripts", "serve.ts"), info.pes_home, String(port)], {
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
    if (exited) throw new Error(`serve.ts exited early: ${stderr}`);
    try {
      if ((await fetch(`${base}/ping`)).ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`serve.ts did not start: ${stderr}`);
    await new Promise((r) => setTimeout(r, 100));
  }

  const pes = (args: string[], extra: Record<string, string> = {}) => {
    const r = spawnSync(process.execPath, [join(REPO, "scripts", "pes.ts"), ...args], { env: { ...env, ...extra }, cwd: info.root, encoding: "utf8", timeout: 60_000 });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  return {
    slug: info.slug,
    project_id: info.project_id,
    session: SESSION_SECRET,
    base,
    port,
    pes,
    open_app() {
      const r = pes(["open", info.slug, "--app"], { PES_NO_BROWSER: "1", PES_HUB_PORTS: `${port}-${port}` });
      if (r.status !== 0) throw new Error(`pes open --app failed (${r.status}): ${r.stderr}${r.stdout}`);
      return r.stdout.trim();
    },
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
