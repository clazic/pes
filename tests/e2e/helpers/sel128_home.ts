// Test-side harness for tests/e2e/sel128_*.spec.ts (SEL-128). Node built-ins only (Playwright's loader runs this file).
// An EMPTY PES home (no project, no database) in a temporary HOME / USERPROFILE / PES_HOME, the real `node scripts/serve.ts` on a free port with the built
// web app (PES_APP_DIR = app/dist) and `node scripts/pes.ts` against the same isolated home. Everything is synthetic; no real home, no real hub port.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const REPO = resolve(process.cwd());
export const SESSION = "synthetic-owner-session-secret-sel128-e2e";
export const CREATE = "/api/v1/projects";
export const EXCHANGE = "/api/v1/app-session";
export const STORE_KEY = "pes-app-handoff";

export interface EmptyHome {
  base: string;
  port: number;
  session: string;
  /** `pes hub --open` (PES_NO_BROWSER=1): the first-page address with #code=<one-time code> (a new code every call) */
  open_hub(): string;
  /** `pes hub` (no --open): builds the first page, prints the plain address — no code */
  plain_hub(): string;
  pes(args: string[]): { status: number | null; stdout: string; stderr: string };
  /** POST /api/v1/projects as the owner (x-pes-session), without an Origin header */
  api_create(body: Record<string, unknown>, key: string): Promise<{ status: number; json: any }>;
  /** slugs in the database (the stub owner project left out); null when there is no database file */
  slugs(): string[] | null;
  db_exists(): boolean;
  /** names + sizes below the PES home (server log excluded) */
  tree(): string[];
  close(): Promise<void>;
}

function free_port(): Promise<number> {
  return new Promise((done, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const a = probe.address();
      const port = typeof a === "object" && a !== null ? a.port : 0;
      probe.close(() => done(port));
    });
  });
}

export async function open_empty_home(): Promise<EmptyHome> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "pes-sel128-")));
  const home = join(root, "home");
  const pes_home = join(home, "pes-projects");
  mkdirSync(pes_home, { recursive: true });
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^PES_/.test(k)) env[k] = v;
  Object.assign(env, { HOME: home, USERPROFILE: home, PES_HOME: pes_home, PES_LOCAL_SESSION_SECRET: SESSION, PES_APP_DIR: join(REPO, "app", "dist") });
  for (const guard of ["HOME", "USERPROFILE", "PES_HOME"]) if (!env[guard]!.startsWith(root)) throw new Error(`${guard} is not the isolated temporary folder`);

  const port = await free_port();
  const server: ChildProcess = spawn(process.execPath, [join(REPO, "scripts", "serve.ts"), pes_home, String(port)], { env, cwd: root, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  server.stderr?.on("data", (c) => (stderr += String(c)));
  let exited = false;
  server.once("exit", () => (exited = true));
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

  const pes = (args: string[]) => {
    const r = spawnSync(process.execPath, [join(REPO, "scripts", "pes.ts"), ...args], {
      env: { ...env, PES_NO_BROWSER: "1", PES_HUB_PORTS: `${port}-${port}` },
      cwd: root,
      encoding: "utf8",
      timeout: 60_000,
    });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  const db_file = join(home, ".pes", "pes.db");
  const walk = (dir: string, out: string[]): void => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.name === ".pes-hub.out") continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        out.push(`${relative(pes_home, p)}/`);
        walk(p, out);
      } else out.push(`${relative(pes_home, p)} ${statSync(p).size}`);
    }
  };
  return {
    base,
    port,
    session: SESSION,
    open_hub() {
      const r = pes(["hub", "--open"]);
      if (r.status !== 0) throw new Error(`pes hub --open failed (${r.status}): ${r.stderr}${r.stdout}`);
      const line = r.stdout.split(/\r?\n/).find((l) => /#code=/.test(l));
      if (line === undefined) throw new Error(`no #code= address in: ${r.stdout}`);
      return line.trim();
    },
    plain_hub() {
      const r = pes(["hub"]);
      if (r.status !== 0) throw new Error(`pes hub failed (${r.status}): ${r.stderr}${r.stdout}`);
      return r.stdout.trim().split(/\r?\n/).pop() as string;
    },
    pes,
    async api_create(body, key) {
      const res = await fetch(`${base}${CREATE}`, { method: "POST", headers: { "content-type": "application/json", "x-pes-session": SESSION, "idempotency-key": key }, body: JSON.stringify(body) });
      return { status: res.status, json: await res.json() };
    },
    db_exists: () => existsSync(db_file) && statSync(db_file).size > 0,
    slugs() {
      if (!existsSync(db_file) || statSync(db_file).size === 0) return null;
      const db = new DatabaseSync(db_file, { readOnly: true });
      try {
        return (db.prepare("SELECT slug FROM projects ORDER BY slug").all() as { slug: string }[]).map((r) => r.slug).filter((s) => !s.startsWith("pes-"));
      } finally {
        db.close();
      }
    },
    tree() {
      const out: string[] = [];
      if (existsSync(pes_home)) walk(pes_home, out);
      return out;
    },
    async close() {
      if (!exited) {
        await new Promise<void>((done) => {
          server.once("exit", () => done());
          server.kill();
          setTimeout(done, 3000).unref();
        });
      }
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}
