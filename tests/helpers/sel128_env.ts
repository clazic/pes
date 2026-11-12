// SEL-128 shared setup: an EMPTY PES home (no project, no database) in an isolated temporary HOME, the real scripts/serve.ts on an injected free port,
// and the CLI run against it. Nothing here touches the real account home or a real hub port (TsServeProcess + run_ts_cli carry the guards).
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { make_ctx, type CompatCtx } from "./compat_env.ts";
import { run_ts_cli } from "./compat_ts.ts";
import { TsServeProcess } from "./compat_ts_srv.ts";

export const SECRET = "synthetic-sel128-owner-session-0123456789abcdef";
export const CODE = /^[A-Za-z0-9_-]{20,}$/;
export const EXCHANGE = "/api/v1/app-session";
export const CREATE = "/api/v1/projects";

export interface Empty {
  ctx: CompatCtx;
  root: string;
  server: TsServeProcess;
  /** `pes <args>` in the isolated home against this server (PES_NO_BROWSER=1 unless overridden) */
  run(args: string[], extra_env?: Record<string, string>): ReturnType<typeof run_ts_cli>;
  /** POST /api/v1/projects with the owner session (x-pes-session) unless `session` is null */
  create(body: unknown, options?: { key?: string | null; session?: string | null; origin?: string | null }): ReturnType<TsServeProcess["post"]>;
  /** names + sizes of everything below the PES home (the server's own log file excluded) */
  tree(): string[];
  /** the slugs in the database ([] when there is no database file); the stub owner project is left out */
  slugs(): string[] | null;
  db_exists(): boolean;
  cleanup(): Promise<void>;
}

export async function start_empty(prefix: string, server_env: Record<string, string> = {}): Promise<Empty> {
  const ctx = make_ctx(prefix);
  mkdirSync(ctx.pes_home, { recursive: true });
  const root = realpathSync.native(ctx.pes_home);
  const server = new TsServeProcess(ctx, root, { extra_env: { PES_LOCAL_SESSION_SECRET: SECRET, ...server_env } });
  try {
    await server.start();
  } catch (error) {
    ctx.cleanup();
    throw error;
  }
  const db_file = join(ctx.home_dir, ".pes", "pes.db");
  const walk = (dir: string, out: string[]): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = join(dir, entry.name);
      if (entry.name === ".pes-hub.out") continue;
      if (entry.isDirectory()) {
        out.push(`${relative(root, path)}/`);
        walk(path, out);
      } else out.push(`${relative(root, path)} ${statSync(path).size}`);
    }
  };
  return {
    ctx,
    root,
    server,
    run: (args, extra_env = {}) => run_ts_cli(ctx, args, { env: { PES_HUB_PORTS: `${server.port}-${server.port}`, PES_NO_BROWSER: "1", PES_LOCAL_SESSION_SECRET: SECRET, ...server_env, ...extra_env } }),
    create: (body, { key = "sel128-key-1", session = SECRET, origin = server.origin() } = {}) => {
      const headers: Record<string, string> = {};
      if (session !== null) headers["x-pes-session"] = session;
      if (key !== null) headers["idempotency-key"] = key;
      return server.post(CREATE, body, origin, headers);
    },
    tree: () => {
      const out: string[] = [];
      if (existsSync(root)) walk(root, out);
      return out;
    },
    db_exists: () => existsSync(db_file) && statSync(db_file).size > 0,
    slugs: () => {
      if (!existsSync(db_file) || statSync(db_file).size === 0) return null;
      const db = new DatabaseSync(db_file, { readOnly: true });
      try {
        return (db.prepare("SELECT slug FROM projects ORDER BY slug").all() as { slug: string }[]).map((r) => r.slug).filter((s) => !s.startsWith("pes-"));
      } finally {
        db.close();
      }
    },
    cleanup: async () => {
      await server.stop();
      ctx.cleanup();
    },
  };
}

export const read_text = (path: string): string => readFileSync(path, "utf8");
