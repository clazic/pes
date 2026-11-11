// SEL-72 (PR26c): scripts/serve.ts — what a browser and the pes commands rely on besides the E08/E09/E13 cases: the way it is run, the
// banner, port handling, loopback-only binding, no reverse DNS (SEL-33), no contact with the hub ports, the static-file rules of
// serve.py (content types, redirects, no directory listing, no traversal), CORS of /whoami, the unsupported methods.
//
// Contract = scripts/serve.py run directly: `serve.py <PES 홈 폴더> [포트=8760]`. The port is ALWAYS injected here (a free ephemeral port);
// 8760~8775 are the user's real PES ports and are refused to every child by the guard.
// `/api/v1/*` (the DB API pass-through of serve.py) and the pes.ts commands that start / stop the server (serve, hub, open, watch) are NOT
// part of this issue — they belong to SEL-77 and later.
import assert from "node:assert/strict";
import { createConnection, createServer } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { readFileSync, statSync } from "node:fs";
import { test } from "node:test";

import { BARE_SERVE, REPO_ROOT, run_ts_bare } from "./helpers/compat_ts_srv.ts";
import { make_ctx } from "./helpers/compat_env.ts";
import { use_home_guard } from "./helpers/home_guard.ts";
import { header_of, raw_http, serve_fixture, status_line, touch_at } from "./helpers/serve_ts_env.ts";

use_home_guard();

const NO_STACK = /^\s+at .+\(.+:\d+:\d+\)$|node:internal|\bTypeError\b|\bReferenceError\b/m;

test("run method: plain `node scripts/serve.ts` (Node strips the types) — no tsx / ts-node / build step; no arguments → usage on stderr, exit 2, nothing on stdout", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as Record<string, any>;
  const text = JSON.stringify({ d: pkg.dependencies, dd: pkg.devDependencies, s: pkg.scripts });
  assert.doesNotMatch(text, /\btsx\b|ts-node|esbuild|swc/, "serve.ts runs on plain node");
  const ctx = make_ctx("pes-serve-usage-");
  try {
    const run = run_ts_bare(ctx, BARE_SERVE, []);
    assert.equal(run.status, 2);
    assert.equal(run.stdout, "");
    assert.match(run.stderr, /사용: node scripts\/serve\.ts <PES 홈 폴더> \[포트=8760\]/);
    assert.doesNotMatch(run.stderr, NO_STACK, "a usage error is a message, not a stack trace");
  } finally {
    ctx.cleanup();
  }
});

test("a port that is not a number, or not a TCP port, is refused with a one-line Korean message and exit 2 (never a stack trace, never a listening socket)", () => {
  const ctx = make_ctx("pes-serve-badport-");
  try {
    for (const bad of ["abc", "-1", "65536", "80x", ""]) {
      const run = run_ts_bare(ctx, BARE_SERVE, [ctx.pes_home, bad]);
      assert.equal(run.status, 2, `port ${JSON.stringify(bad)}`);
      assert.equal(run.stdout, "", `port ${JSON.stringify(bad)}`);
      assert.match(run.stderr, /포트/, `port ${JSON.stringify(bad)}`);
      assert.doesNotMatch(run.stderr, NO_STACK, `port ${JSON.stringify(bad)}`);
    }
  } finally {
    ctx.cleanup();
  }
});

test("a port that is already taken: exit 1 with a message, the other program is left alone", { timeout: 60_000 }, async () => {
  const ctx = make_ctx("pes-serve-busy-");
  const holder = createServer((socket) => socket.end("HOLDER"));
  try {
    const port = await new Promise<number>((done) => holder.listen(0, "127.0.0.1", () => done((holder.address() as { port: number }).port)));
    const run = run_ts_bare(ctx, BARE_SERVE, [ctx.pes_home, String(port)]);
    assert.equal(run.status, 1);
    assert.equal(run.stdout.includes("serving"), false, "no banner for a server that did not start");
    assert.match(run.stderr, new RegExp(`${port}`));
    assert.doesNotMatch(run.stderr, NO_STACK);
    const answer = await new Promise<string>((done) => {
      const socket = createConnection({ host: "127.0.0.1", port }, () => undefined);
      let text = "";
      socket.on("data", (chunk) => (text += chunk.toString("utf8")));
      socket.on("close", () => done(text));
    });
    assert.equal(answer, "HOLDER", "the program that held the port still answers");
  } finally {
    holder.close();
    ctx.cleanup();
  }
});

test("banner, loopback-only binding, no reverse DNS (SEL-33), no hub contact", { timeout: 90_000 }, async () => {
  const fx = await serve_fixture("pes-serve-bind-");
  try {
    const { server } = fx;
    const banner = /^serving (.+) at http:\/\/127\.0\.0\.1:(\d+)\/$/m.exec(server.log);
    assert.ok(banner !== null, `first stdout line is "serving <root> at http://127.0.0.1:<port>/":\n${server.log}`);
    assert.equal(Number(banner[2]), server.port);
    await server.request("/ping");
    await server.request("/whoami");
    await server.request("/synthetic/");
    await server.post("/synthetic/feedback", { stage: "plan", round: 1, kind: "feedback", text: "합성" });
    assert.deepEqual(server.dns_attempts(), [], "no reverse-DNS / host-name lookup at start or while serving (a getfqdn()-style call stalled 30 s on macOS runners)");
    assert.deepEqual(server.hub_attempts(), [], "serve.ts never reaches for the hub ports 8760~8775");

    // only 127.0.0.1: neither IPv6 loopback nor any other local address accepts a connection
    const refused = (host: string): Promise<boolean> =>
      new Promise((done) => {
        const socket = createConnection({ host, port: server.port });
        socket.setTimeout(2000, () => {
          socket.destroy();
          done(true);
        });
        socket.on("connect", () => {
          socket.destroy();
          done(false);
        });
        socket.on("error", () => done(true));
      });
    assert.equal(await refused("::1"), true, "::1 must not be served");
    const others = Object.values(networkInterfaces())
      .flat()
      .filter((a) => a !== undefined && a.family === "IPv4" && !a.internal)
      .map((a) => (a as { address: string }).address);
    for (const address of others.slice(0, 2)) assert.equal(await refused(address), true, `${address} must not be served`);
  } finally {
    await fx.cleanup();
  }
});

test("static files: content types, no-store everywhere, redirects, latest ask form, HEAD, query string ignored", { timeout: 90_000 }, async () => {
  const fx = await serve_fixture("pes-serve-static-", {
    files: {
      "synthetic/out/note.md": "# 메모\n",
      "synthetic/out/note.txt": "text",
      "synthetic/out/data.json": '{"a":1}',
      "synthetic/out/style.css": "body{}",
      "synthetic/out/pic.svg": "<svg xmlns='http://www.w3.org/2000/svg'/>",
      "synthetic/out/blob.bin": Buffer.from([0, 1, 2, 3]),
      "synthetic/out/shot.png": Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      "synthetic/feedback.log": "log line\n",
      "askonly/project.json": JSON.stringify({ pes: 1, topic: "합성 주제", stages: {} }),
      "askonly/ask-plan.html": "<html>ask plan</html>",
      "askonly/ask-research.html": "<html>ask research</html>",
    },
  });
  try {
    const { server, root } = fx;
    touch_at(join(root, "askonly", "ask-plan.html"), 1_600_000_000);
    touch_at(join(root, "askonly", "ask-research.html"), 1_600_000_100);
    const types: Record<string, string> = {
      "/synthetic/out/note.md": "text/plain; charset=utf-8",
      "/synthetic/out/note.txt": "text/plain; charset=utf-8",
      "/synthetic/feedback.log": "text/plain; charset=utf-8",
      "/synthetic/out/data.json": "application/json; charset=utf-8",
      "/synthetic/out/style.css": "text/css; charset=utf-8",
      "/synthetic/out/pic.svg": "image/svg+xml; charset=utf-8",
      "/synthetic/out/blob.bin": "application/octet-stream",
      "/synthetic/out/shot.png": "image/png",
      "/synthetic/index.html": "text/html; charset=utf-8",
    };
    for (const [path, type] of Object.entries(types)) {
      const answer = await server.request(path);
      assert.equal(answer.status, 200, path);
      assert.equal(answer.headers["content-type"], type, path);
      assert.equal(answer.headers["cache-control"], "no-store", path);
    }
    assert.equal((await server.request("/synthetic/out/note.md")).text(), "# 메모\n", "UTF-8 bytes are served as they are");

    const noslash = await server.request("/synthetic");
    assert.equal(noslash.status, 302);
    assert.equal(noslash.headers.location, "/synthetic/");
    assert.equal(noslash.headers["cache-control"], "no-store");

    // a project with no index.html but ask forms: /<slug>/ goes to the newest ask form
    const ask = await server.request("/askonly/");
    assert.equal(ask.status, 302);
    assert.equal(ask.headers.location, "/askonly/ask-research.html");
    assert.equal((await server.request("/askonly/ask-plan.html")).text(), "<html>ask plan</html>");

    const head = await server.request("/synthetic/index.html", { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);
    assert.equal(head.headers["content-length"], String(Buffer.byteLength("<html>synthetic</html>")));
    assert.equal((await server.request("/synthetic/index.html?x=1&y=2")).text(), "<html>synthetic</html>");
    assert.equal((await server.request("/synthetic/ping?x=1")).json().ok, true);
    assert.deepEqual((await server.request("/nothing-here/ping")).json(), { ok: true }, "any path ending in /ping answers");
    // an unknown first segment is no project: the version is the home's own (index.html time), like serve.py's project_of() miss
    assert.deepEqual((await server.request("/nothing-here/version")).json(), { v: Math.floor(statSync(join(root, "index.html")).mtimeMs / 1000) });
  } finally {
    await fx.cleanup();
  }
});

test("a directory is never listed, a request cannot leave the PES home, and the 404 page is the plain error page with the python-compatible type", { timeout: 90_000 }, async () => {
  const fx = await serve_fixture("pes-serve-traversal-", { files: { "synthetic/out/note.md": "x", "../outside.txt": "OUTSIDE-SECRET" } });
  try {
    const { server } = fx;
    for (const path of ["/synthetic/out/", "/synthetic/out", "/synthetic/feedback/", "/nope/", "/nope.html"]) {
      const answer = await server.request(path);
      assert.ok([404, 301, 302].includes(answer.status), `${path} → ${answer.status}`);
      if (answer.status === 404) {
        assert.equal(answer.headers["content-type"], "text/html;charset=utf-8", `${path}: the stdlib error page type (no space) is part of the 0.15 contract`);
        assert.match(answer.text(), /<title>Error response<\/title>[\s\S]*Error code: 404/);
        assert.doesNotMatch(answer.text(), /note\.md/, "no listing");
      }
    }
    for (const target of ["/../outside.txt", "/%2e%2e/outside.txt", "/..%5coutside.txt", "/synthetic/../../outside.txt", "/synthetic/%2e%2e/%2e%2e/outside.txt", "//..//outside.txt", "/..%2foutside.txt"]) {
      const raw = await raw_http(server.port, `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
      assert.doesNotMatch(raw.text, /OUTSIDE-SECRET/, `${target} leaked a file outside the PES home`);
      assert.doesNotMatch(status_line(raw.text), /\s200\s/, `${target}: ${status_line(raw.text)}`);
    }
    // a request line that is not HTTP does not take the server down
    await raw_http(server.port, "NOT HTTP AT ALL\r\n\r\n", 1500);
    assert.equal((await server.request("/ping")).status, 200, "the server is still up");
  } finally {
    await fx.cleanup();
  }
});

test("/whoami: root + single, CORS only for the local PES ports (87xx) and only there; other methods", { timeout: 90_000 }, async () => {
  const fx = await serve_fixture("pes-serve-whoami-");
  try {
    const { server } = fx;
    const who = await server.request("/whoami");
    assert.equal(who.json().single, true);
    assert.equal(who.headers["access-control-allow-origin"], undefined, "no Origin header → no CORS header");
    const cors = async (origin: string): Promise<string | undefined> => (await server.request("/whoami", { headers: { Origin: origin } })).headers["access-control-allow-origin"];
    assert.equal(await cors("http://127.0.0.1:8765"), "http://127.0.0.1:8765");
    assert.equal(await cors("http://localhost:8799"), "http://localhost:8799");
    assert.equal(await cors("http://127.0.0.1:9000"), undefined);
    assert.equal(await cors("http://evil.example:8760"), undefined);
    assert.equal(await cors("https://127.0.0.1:8760"), undefined);
    assert.equal((await server.request("/ping", { headers: { Origin: "http://127.0.0.1:8765" } })).headers["access-control-allow-origin"], undefined, "only /whoami speaks CORS");

    const put = await server.request("/synthetic/x", { method: "PUT", body: "{}" });
    assert.equal(put.status, 405);
    assert.deepEqual(put.json(), { ok: false });
    for (const method of ["DELETE", "PATCH", "OPTIONS"]) {
      const answer = await server.request("/synthetic/x", { method });
      assert.equal(answer.status, 501, method);
      assert.match(answer.text(), /Error code: 501/, method);
    }
    const stray = await server.post("/synthetic/other", { a: 1 });
    assert.equal(stray.status, 404);
    assert.deepEqual(stray.json(), { ok: false });
  } finally {
    await fx.cleanup();
  }
});

test("the version cursor follows the newest index.html / ask-*.html time of the folder (home: the home's own files)", { timeout: 90_000 }, async () => {
  const fx = await serve_fixture("pes-serve-version-");
  try {
    const { server, root } = fx;
    touch_at(join(root, "synthetic", "index.html"), 1_600_000_000);
    touch_at(join(root, "synthetic", "ask-plan.html"), 1_600_000_500);
    touch_at(join(root, "index.html"), 1_600_000_900);
    assert.deepEqual((await server.request("/synthetic/version")).json(), { v: 1_600_000_500 });
    assert.deepEqual((await server.request("/version")).json(), { v: 1_600_000_900 });
    touch_at(join(root, "synthetic", "index.html"), 1_600_001_000);
    assert.deepEqual((await server.request("/synthetic/version")).json(), { v: 1_600_001_000 });
  } finally {
    await fx.cleanup();
  }
});
