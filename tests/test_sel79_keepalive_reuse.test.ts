// SEL-79 (defect candidate from SEL-78 R1 recommendation 2): the built-in runner's model POST (a_runtime/http.ts
// http_json, undici's default keep-alive fetch) reuses an idle keep-alive socket. When the server closed that idle
// socket before the new request's bytes reached it, undici does not retry a POST, the fetch rejects, and the call
// is classified "lost" -> usage_unknown -> the run is held although NOTHING was ever sent to the server.
//
// Written BEFORE the fix. What is required:
//  1. repro: the server closes the idle keep-alive socket at the moment the next call is made, before reading any
//     request byte -> the second call must still be a normal reply (the request never reached the server, so it
//     is not an unknown call), and it reaches the server exactly once.
//  2. billing safety stays: when the request body DID reach the server (it may have been charged) and the
//     connection then breaks, the outcome stays "lost" and the server saw the request exactly once (no automatic
//     retry that could bill twice). Same for a reply cut off after its headers.
//  3. other users of http_json (a GET such as the model listing, an injected fetch_fn) are not affected.
//
// Deterministic: no timer, no sleep, no real race. With `close_reused` on, the server behaves like one that closed
// its idle keep-alive socket a moment before the client's next request: any request that arrives on a connection
// that already carried a request is NOT handled (not recorded as seen) and the socket is destroyed with no answer.
// A client that opens a fresh connection per call never meets that. (To the client, a write on a reused socket that
// is closed without any answer looks exactly like the real race.) The FakeAi helper's `connection: close`
// workaround is deliberately NOT used here. Windows/macOS safe: loopback only, no paths, no child process, ASCII
// payloads.

import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Socket } from "node:net";
import { test } from "node:test";

import { http_json, type HttpOutcome } from "../scripts/pes_core/a_runtime/http.ts";

type Mode = "ok" | "destroy_after_body" | "cut_after_headers";

interface Seen {
  method: string;
  body: string;
  socket: Socket;
}

class KeepAliveServer {
  readonly seen: Seen[] = [];
  readonly sockets = new Set<Socket>();
  mode: Mode = "ok";
  /** the server "already closed" an idle socket: a request arriving on a reused connection gets no answer and is not seen */
  close_reused = false;
  /** how many requests were thrown away on a reused connection */
  stale_closes = 0;
  readonly #used = new WeakSet<Socket>();
  readonly #server: http.Server;
  url = "";

  constructor() {
    this.#server = http.createServer((req, res) => {
      if (this.close_reused && this.#used.has(req.socket)) {
        this.stale_closes += 1;
        req.socket.destroy();
        return;
      }
      this.#used.add(req.socket);
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        this.seen.push({ method: req.method ?? "", body: Buffer.concat(chunks).toString("utf8"), socket: req.socket });
        if (this.mode === "destroy_after_body") {
          req.socket.destroy();
          return;
        }
        if (this.mode === "cut_after_headers") {
          res.writeHead(200, { "content-type": "application/json", "content-length": "1000" });
          res.write('{"partial":');
          setImmediate(() => req.socket.destroy());
          return;
        }
        const payload = JSON.stringify({ ok: true, n: this.seen.length });
        // keep-alive reply: a content-length body and no `connection: close`
        res.writeHead(200, { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) });
        res.end(payload);
      });
    });
    this.#server.keepAliveTimeout = 60_000; // the server never closes an idle socket by itself
    this.#server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.#server.listen(0, "127.0.0.1", () => resolve()));
    this.url = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}/v1/chat/completions`;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }
}

async function with_server(run: (server: KeepAliveServer) => Promise<void>): Promise<void> {
  const server = new KeepAliveServer();
  await server.listen();
  try {
    await run(server);
  } finally {
    await server.close();
  }
}

function post(url: string, n: number): Promise<HttpOutcome> {
  return http_json({ method: "POST", url, headers: { "content-type": "application/json" }, body: JSON.stringify({ call: n }) }, 10_000);
}

function expect_reply(outcome: HttpOutcome, why: string): void {
  assert.equal(outcome.kind, "reply", `${why}: got ${JSON.stringify(outcome)}`);
}

// ---------------------------------------------------------------------------------------------------------
// 1. repro: idle keep-alive socket closed by the server just as the next call starts (no request byte read)

const ROUNDS = 5;

test("SEL-79 repro: a reused keep-alive socket the server had already closed does not make a lost model call", async () => {
  await with_server(async (server) => {
    server.close_reused = true;
    for (let n = 1; n <= ROUNDS; n += 1) {
      const outcome = await post(server.url, n);
      expect_reply(outcome, `call ${n}: the request never reached the server, so it is not an unknown call`);
      assert.deepEqual(JSON.parse(server.seen[server.seen.length - 1]!.body), { call: n }, `call ${n}: the body is this call's`);
    }
    assert.equal(server.seen.length, ROUNDS, "each call reaches the server exactly once");
  });
});

// ---------------------------------------------------------------------------------------------------------
// 2. billing safety: a request that reached the server and then broke stays unknown, never retried

test("SEL-79 billing safety: the server read the body and then dropped the connection -> lost, sent once", async () => {
  await with_server(async (server) => {
    server.mode = "destroy_after_body";
    const outcome = await post(server.url, 1);
    assert.equal(outcome.kind, "lost", JSON.stringify(outcome));
    assert.equal(server.seen.length, 1, "no automatic retry: the server got the request exactly once");
    assert.deepEqual(JSON.parse(server.seen[0]!.body), { call: 1 });
  });
});

test("SEL-79 billing safety: same on a REUSED keep-alive socket (second call, body read, then dropped) -> lost, sent once", async () => {
  await with_server(async (server) => {
    expect_reply(await post(server.url, 1), "first call");
    server.mode = "destroy_after_body";
    const outcome = await post(server.url, 2);
    assert.equal(outcome.kind, "lost", JSON.stringify(outcome));
    assert.equal(server.seen.length, 2, "the second call reached the server once and was not sent again");
    assert.deepEqual(JSON.parse(server.seen[1]!.body), { call: 2 });
  });
});

test("SEL-79 billing safety: a reply cut off after its headers is lost and keeps the status; sent once", async () => {
  await with_server(async (server) => {
    expect_reply(await post(server.url, 1), "first call");
    server.mode = "cut_after_headers";
    const outcome = await post(server.url, 2);
    assert.equal(outcome.kind, "lost", JSON.stringify(outcome));
    if (outcome.kind === "lost") assert.equal(outcome.status, 200, "the status that arrived is kept");
    assert.equal(server.seen.length, 2, "not sent again");
  });
});

test("SEL-79 billing safety: after a lost call the next call is not blocked by a stale socket and is sent once", async () => {
  await with_server(async (server) => {
    server.mode = "destroy_after_body";
    assert.equal((await post(server.url, 1)).kind, "lost");
    server.mode = "ok";
    expect_reply(await post(server.url, 2), "next call opens a working connection");
    assert.equal(server.seen.length, 2, "one request per call, nothing replayed");
  });
});

// ---------------------------------------------------------------------------------------------------------
// 3. other http_json uses are not affected

test("SEL-79 other uses: a GET (model listing) works twice in a row", async () => {
  await with_server(async (server) => {
    const get = (): Promise<HttpOutcome> => http_json({ method: "GET", url: server.url, headers: {} }, 10_000);
    expect_reply(await get(), "first GET");
    expect_reply(await get(), "second GET");
    assert.equal(server.seen.length, 2);
  });
});

test("SEL-79 other uses: an injected fetch_fn is used as given (the fix must not override it)", async () => {
  let called = 0;
  const fake = async (url: string, init: RequestInit): Promise<Response> => {
    called += 1;
    assert.equal(url, "http://127.0.0.1:1/never");
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "error", "still never follows a redirect");
    return new Response(JSON.stringify({ injected: true }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const outcome = await http_json({ method: "POST", url: "http://127.0.0.1:1/never", headers: {}, body: "{}" }, 10_000, fake);
  expect_reply(outcome, "injected fetch");
  assert.equal(called, 1);
  if (outcome.kind === "reply") assert.deepEqual(outcome.json, { injected: true });
});

test("SEL-79 other uses: an injected fetch_fn that rejects is still lost (never retried by http_json)", async () => {
  let called = 0;
  const failing = async (): Promise<Response> => {
    called += 1;
    throw new TypeError("fetch failed");
  };
  const outcome = await http_json({ method: "POST", url: "http://127.0.0.1:1/never", headers: {}, body: "{}" }, 10_000, failing);
  assert.equal(outcome.kind, "lost");
  assert.equal(called, 1, "one attempt, no retry");
});
