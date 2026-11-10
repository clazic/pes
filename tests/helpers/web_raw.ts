// Byte-level HTTP for the hardening tests (SEL-51 PR18, 보강 모드). fetch() normalises paths ("/../"), forbids some headers and
// always speaks well-formed bodies; these tests need the opposite, so they use node:http directly. Everything is synthetic.

import { request, type IncomingHttpHeaders } from "node:http";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

import type { Server } from "./web_env.ts";

export interface RawOptions {
  method?: string;
  path: string;
  /** Sent exactly as given. An array value sends the header twice. */
  headers?: Record<string, string | string[]>;
  body?: Buffer | string;
  /** No Content-Length: Transfer-Encoding: chunked. */
  chunked?: boolean;
}

export interface RawResponse {
  /** 0 = the server closed the connection without an answer. */
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  text: string;
  json: any;
}

export function raw(server: Server, opts: RawOptions): Promise<RawResponse> {
  return new Promise((resolve) => {
    const body = opts.body === undefined ? undefined : Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body, "utf8");
    const headers: Record<string, string | string[]> = { ...opts.headers };
    if (body !== undefined && opts.chunked !== true) headers["Content-Length"] = String(body.byteLength);
    const done = (status: number, res_headers: IncomingHttpHeaders, chunks: Buffer[]): void => {
      const buf = Buffer.concat(chunks);
      const text = buf.toString("utf8");
      let json: any = null;
      try {
        json = JSON.parse(text);
      } catch {
        // not JSON
      }
      resolve({ status, headers: res_headers, body: buf, text, json });
    };
    const req = request({ host: "127.0.0.1", port: server.port, method: opts.method ?? "GET", path: opts.path, headers, agent: false, timeout: 60_000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => done(res.statusCode ?? 0, res.headers, chunks));
      res.on("error", () => done(res.statusCode ?? 0, res.headers, chunks));
    });
    req.on("error", () => done(0, {}, []));
    req.on("timeout", () => req.destroy());
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** POST to /<slug>/feedback with the server's own Origin unless `origin` says otherwise (null = none). */
export function raw_post(server: Server, path: string, body: Buffer | string, extra: { origin?: string | null; headers?: Record<string, string | string[]>; chunked?: boolean } = {}): Promise<RawResponse> {
  const headers: Record<string, string | string[]> = { "Content-Type": "application/json", ...extra.headers };
  const origin = extra.origin === undefined ? server.origin : extra.origin;
  if (origin !== null) headers.Origin = origin;
  return raw(server, { method: "POST", path, headers, body, ...(extra.chunked === true ? { chunked: true } : {}) });
}

/** Every file under `dir` (relative, forward slashes, sorted). A symlink counts as a file and is not followed. */
export function tree(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    if (!existsSync(current)) return;
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      const stat = lstatSync(full);
      if (stat.isDirectory()) walk(full);
      else out.push(relative(dir, full).split(sep).join("/"));
    }
  };
  walk(dir);
  return out.sort();
}
