// Shared setup of the scripts/serve.ts tests (SEL-72): an isolated home with a synthetic PES home folder whose project is already
// migrated into the DB, a guarded server on a free (injected) port, and a raw-socket helper for what fetch() will not send.
//
// Safety: every server is started by TsServeProcess (permission allow-list without the real home + ts_child_guard.ts + the no-reverse-DNS
// probe). The port is always injected (a free ephemeral port, never 8760~8775); the hub ports stay refused by the guard.
import { createConnection } from "node:net";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { make_ctx, make_serve_home, type CompatCtx } from "./compat_env.ts";
import { TsServeProcess, srv_seed_project, type TsServeOptions } from "./compat_ts_srv.ts";

export interface ServeFixture {
  ctx: CompatCtx;
  /** the PES home folder the server serves (realpath) */
  root: string;
  /** <root>/synthetic — a project that is in the DB */
  project: string;
  server: TsServeProcess;
  cleanup(): Promise<void>;
}

export interface FixtureOptions extends TsServeOptions {
  /** do not start the server (the test starts it itself) */
  no_start?: boolean;
  /** more files below the PES home before the server starts: { "synthetic/out/note.md": "text" } */
  files?: Record<string, string | Buffer>;
  /** folders that hold a project.json but are NOT migrated into the DB */
  legacy_only?: string[];
  /** further projects that ARE migrated (slug → topic) */
  extra_projects?: string[];
  /** ~/.pes/config.json written before the start */
  config?: Record<string, unknown>;
}

export async function serve_fixture(prefix: string, options: FixtureOptions = {}): Promise<ServeFixture> {
  const ctx = make_ctx(prefix);
  try {
    const root = make_serve_home(ctx);
    const project = join(root, "synthetic");
    for (const slug of options.extra_projects ?? []) {
      mkdirSync(join(root, slug), { recursive: true });
      writeFileSync(join(root, slug, "project.json"), JSON.stringify({ pes: 1, topic: "합성 주제", stages: {} }), "utf8");
      writeFileSync(join(root, slug, "index.html"), `<html>${slug}</html>`, "utf8");
    }
    for (const slug of options.legacy_only ?? []) {
      mkdirSync(join(root, slug), { recursive: true });
      writeFileSync(join(root, slug, "project.json"), JSON.stringify({ pes: 1, topic: "합성 주제", stages: {} }), "utf8");
      writeFileSync(join(root, slug, "index.html"), `<html>${slug}</html>`, "utf8");
    }
    // seed first: the importer sees only the project the user's migration would see; the extra files come after
    await srv_seed_project(ctx, project);
    for (const slug of options.extra_projects ?? []) await srv_seed_project(ctx, join(root, slug));
    for (const [rel, data] of Object.entries(options.files ?? {})) {
      const target = join(root, ...rel.split("/"));
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, data);
    }
    if (options.config !== undefined) {
      mkdirSync(join(ctx.home_dir, ".pes"), { recursive: true });
      writeFileSync(join(ctx.home_dir, ".pes", "config.json"), JSON.stringify(options.config), "utf8");
    }
    const server = new TsServeProcess(ctx, root, options);
    if (options.no_start !== true) await server.start();
    return {
      ctx,
      root,
      project,
      server,
      cleanup: async () => {
        await server.stop();
        ctx.cleanup();
      },
    };
  } catch (error) {
    ctx.cleanup();
    throw error;
  }
}

export function touch_at(path: string, epoch_s: number): void {
  utimesSync(path, epoch_s, epoch_s);
}

/** Writes `bytes` to 127.0.0.1:port and returns everything the server sent until it closed the socket or `timeout_ms` passed. */
export function raw_http(port: number, bytes: string | Buffer, timeout_ms = 5000): Promise<{ text: string; closed: boolean }> {
  return new Promise((done) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const chunks: Buffer[] = [];
    let closed = false;
    const timer = setTimeout(() => socket.destroy(), timeout_ms);
    socket.on("connect", () => socket.write(bytes));
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", () => {
      /* a reset after the answer is fine: what arrived is judged */
    });
    socket.on("close", () => {
      closed = true;
      clearTimeout(timer);
      done({ text: Buffer.concat(chunks).toString("utf8"), closed });
    });
  });
}

export function status_line(text: string): string {
  return text.split("\r\n")[0] ?? "";
}

export function header_of(text: string, name: string): string | undefined {
  const head = text.split("\r\n\r\n")[0] ?? "";
  for (const line of head.split("\r\n").slice(1)) {
    const i = line.indexOf(":");
    if (i > 0 && line.slice(0, i).toLowerCase() === name.toLowerCase()) return line.slice(i + 1).trim();
  }
  return undefined;
}
