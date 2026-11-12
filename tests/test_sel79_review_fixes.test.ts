// SEL-79 final review 1/2, required item 1: `connection: close` on the default path's POST alone is not enough.
// A GET (connection test / model listing, connections.ts) is sent keep-alive and leaves an idle socket in undici's
// pool. After a short pause that socket is back in the pool and the next model POST (to the same origin) picks it
// up. If the server had closed that idle socket, the POST fails although nothing reached the server -> a false
// "lost" (usage_unknown). The pause matters: with no pause the GET's socket is not yet back in the pool and the
// POST opens a new one, so the test would pass even without the fix.
//
// Fix under test: the default fetch path of http_json sends `connection: close` on EVERY request (GET too), so it
// leaves no idle socket behind. An injected fetch_fn is still used exactly as given.
//
// Deterministic apart from one fixed pause (50 ms) that only has to be longer than the pool hand-back. The server
// behaves like one that closed its idle keep-alive socket a moment before the next request: a request arriving on a
// connection that already carried a request is not handled (not recorded) and the socket is destroyed.
// Loopback only, no paths, no child process; same on Windows and macOS.

import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Socket } from "node:net";
import { test } from "node:test";

import { http_json, type HttpOutcome } from "../scripts/pes_core/a_runtime/http.ts";

interface Seen {
  method: string;
  connection: string | undefined;
  socket: Socket;
}

class ReuseKillingServer {
  readonly seen: Seen[] = [];
  readonly sockets = new Set<Socket>();
  /** requests thrown away because they arrived on an already-used connection */
  stale_closes = 0;
  readonly #used = new WeakSet<Socket>();
  readonly #server: http.Server;
  url = "";

  constructor() {
    this.#server = http.createServer((req, res) => {
      if (this.#used.has(req.socket)) {
        this.stale_closes += 1;
        req.socket.destroy();
        return;
      }
      this.#used.add(req.socket);
      req.resume();
      req.on("end", () => {
        this.seen.push({ method: req.method ?? "", connection: req.headers.connection, socket: req.socket });
        const payload = JSON.stringify({ ok: true, n: this.seen.length });
        res.writeHead(200, { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) });
        res.end(payload);
      });
    });
    this.#server.keepAliveTimeout = 60_000;
    this.#server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.#server.listen(0, "127.0.0.1", () => resolve()));
    this.url = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}/v1/models`;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }
}

async function with_server(run: (server: ReuseKillingServer) => Promise<void>): Promise<void> {
  const server = new ReuseKillingServer();
  await server.listen();
  try {
    await run(server);
  } finally {
    await server.close();
  }
}

const get = (url: string): Promise<HttpOutcome> => http_json({ method: "GET", url, headers: {} }, 10_000);
const post = (url: string, n: number): Promise<HttpOutcome> =>
  http_json({ method: "POST", url, headers: { "content-type": "application/json" }, body: JSON.stringify({ call: n }) }, 10_000);
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("SEL-79 review fix: a model POST right after a GET (connection test) does not ride on the GET's idle socket", async () => {
  await with_server(async (server) => {
    const first = await get(server.url);
    assert.equal(first.kind, "reply", `GET: ${JSON.stringify(first)}`);
    await pause(50); // long enough for the GET's socket to be back in undici's pool
    const second = await post(server.url, 1);
    assert.equal(second.kind, "reply", `POST after GET: nothing reached the server, so it is not an unknown call: ${JSON.stringify(second)}`);
    assert.equal(server.stale_closes, 0, "the POST never arrived on a reused connection");
    assert.equal(server.seen.length, 2, "GET and POST each reached the server exactly once");
    assert.notEqual(server.seen[0]!.socket, server.seen[1]!.socket, "the POST used a new socket");
  });
});

test("SEL-79 review fix: every default-path request, GET too, asks the server to close and uses a new socket", async () => {
  await with_server(async (server) => {
    assert.equal((await get(server.url)).kind, "reply");
    assert.equal((await get(server.url)).kind, "reply");
    assert.equal((await post(server.url, 1)).kind, "reply");
    assert.equal((await post(server.url, 2)).kind, "reply");
    assert.equal(server.seen.length, 4);
    for (const seen of server.seen) assert.equal(seen.connection, "close", `${seen.method}: connection header`);
    assert.equal(new Set(server.seen.map((s) => s.socket)).size, 4, "four requests, four sockets");
    assert.equal(server.stale_closes, 0);
  });
});
