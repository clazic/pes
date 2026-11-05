// Vercel-style Node function handler. The local HTTP server in vc-server.ts mounts it
// on 127.0.0.1; no Vercel account, CLI link, or deploy is involved.

import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteDb } from "./sqlite-adapter.ts";
import { runRound } from "./scenario.ts";

export interface VcState {
  directory: string;
  ddl: string;
  fakeGoUrl: string;
  pool: string[];
  next: number;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(text),
  });
  response.end(text);
}

export async function preparePool(count: number, ddlPath: string): Promise<VcState> {
  const directory = await mkdtemp(join(tmpdir(), "pes-web0-vc-"));
  const ddl = await readFile(ddlPath, "utf8");
  const pool: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const file = join(directory, `round-${index}.sqlite`);
    const db = new SqliteDb(file);
    await db.exec(ddl);
    db.close();
    pool.push(file);
  }
  return { directory, ddl, fakeGoUrl: "", pool, next: 0 };
}

export async function closePool(state: VcState): Promise<void> {
  await rm(state.directory, { recursive: true, force: true });
}

export function handler(state: VcState) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/health") {
      send(response, 200, { ready: true, remaining: state.pool.length - state.next });
      return;
    }
    if (url.pathname === "/api/v1/_spike/round" && request.method === "POST") {
      void (await readBody(request));
      const file = state.pool[state.next];
      if (!file) {
        send(response, 503, { ok: false, error: "pool_exhausted" });
        return;
      }
      state.next += 1;
      const db = new SqliteDb(file);
      try {
        const stats = await runRound(db, { fakeGoUrl: state.fakeGoUrl });
        send(response, 200, { ok: true, stats, pool_index: state.next - 1 });
      } catch (error) {
        send(response, 500, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        db.close();
      }
      return;
    }
    send(response, 404, { ok: false, error: "route_not_found" });
  };
}
