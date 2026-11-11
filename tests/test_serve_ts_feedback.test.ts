// SEL-72 (PR26c): POST /<slug>/feedback on scripts/serve.ts — the part of the contract that the E08/E09 cases (one fixed script of
// requests) do not reach: what is stored, how the Origin / size / JSON / round rules answer, the Referer alias, the trusted-origin list
// read per request, and 40 simultaneous answers without a loss.
//
// D03 (intended): an answer is a SUBMISSION in the DB, not feedback/<stage>-R<round>-<time>.json. Everything else is serve.py's:
//   order of the checks   project (404) → Origin (403) → size (413) → JSON (400) → kind (400) → empty (400) → round range (400)
//   200 body              { ok: true, file: "<stage>-R<round>-<YYYYMMDD-HHMMSS>[-k].json", v: <change cursor> }  — `v` is the PR18 addition
//   notice                <slug>/feedback.log gets one line  FEEDBACK <stage> R<round> <kind> <file name>   (the name, not a path)
//   nothing else on disk  the project folder gets no feedback/ folder and no answer file
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { srv_answer_docs, strip_db_ids } from "./helpers/compat_ts_srv.ts";
import { use_home_guard } from "./helpers/home_guard.ts";
import { header_of, raw_http, serve_fixture, status_line } from "./helpers/serve_ts_env.ts";

use_home_guard();

const MAX_BODY = 256 * 1024;
const NAME = /^plan-R(-?\d+)-\d{8}-\d{6}(-\d+)?\.json$/;

test("the stored answer carries exactly 0.15's record: stage round time kind text answers spec via origin who", { timeout: 90_000 }, async () => {
  const fx = await serve_fixture("pes-fb-record-", { config: { trusted_origins: ["https://remote.example"] } });
  try {
    const { server, ctx } = fx;
    const first = await server.post(
      "/synthetic/feedback",
      { stage: "plan", round: 3, kind: "review", text: "  앞뒤 공백이 있는 답  ", answers: { purpose: "report", n: [1, 2] }, spec: `plan-${"x".repeat(100)}` },
      server.origin(),
      { "Tailscale-User-Login": "someone@example.test" },
    );
    assert.equal(first.status, 200);
    assert.equal(first.headers["content-type"], "application/json; charset=utf-8");
    assert.equal(first.headers["cache-control"], "no-store");
    const body = first.json();
    assert.deepEqual(Object.keys(body).sort(), ["file", "ok", "v"]);
    assert.equal(body.ok, true);
    assert.match(body.file, NAME);
    assert.ok(Number.isSafeInteger(body.v) && body.v >= 0, "v is the change cursor right after the commit");

    const remote = await server.post("/synthetic/feedback", { stage: "plan", round: 1, text: "원격에서" }, "https://remote.example");
    assert.equal(remote.status, 200);
    const local = await server.post("/synthetic/feedback", { stage: "plan", round: 1, text: "로컬", kind: null, answers: ["not", "an", "object"] }, `http://localhost:${server.port}`);
    assert.equal(local.status, 200, "http://localhost:<port> is as good as 127.0.0.1");

    const docs = srv_answer_docs(ctx, "synthetic");
    assert.equal(docs.length, 3);
    const [a, b, c] = docs.map((d) => ({ name: d.name, doc: strip_db_ids(d.doc) }));
    assert.equal(a?.name, body.file, "the name in the answer is the name the DB gave the stored answer");
    assert.deepEqual(a?.doc, {
      stage: "plan",
      round: 3,
      time: (a?.doc.time as string),
      kind: "review",
      text: "앞뒤 공백이 있는 답",
      answers: { purpose: "report", n: [1, 2] },
      spec: `plan-${"x".repeat(75)}`,
      via: "html",
      origin: server.origin(),
      who: "someone@example.test",
    });
    assert.match(a?.doc.time as string, /^\d{8}-\d{6}$/);
    assert.equal(b?.doc.via, "remote");
    assert.equal(b?.doc.origin, "https://remote.example");
    assert.equal(b?.doc.kind, "feedback", "no kind → feedback");
    assert.equal(c?.doc.kind, "feedback", "kind null → feedback");
    assert.deepEqual(c?.doc.answers, {}, "answers that are not an object are {}");
    assert.equal(c?.doc.who, "");

    // notice line + nothing else on disk
    const log = readFileSync(join(fx.project, "feedback.log"), "utf8").split("\n").filter((x) => x !== "");
    assert.equal(log.length, 3);
    assert.equal(log[0], `FEEDBACK plan R3 review ${body.file}`);
    assert.ok(!existsSync(join(fx.project, "feedback")), "the DB answer leaves no feedback/ folder");
    assert.ok(!readdirSync(fx.project).some((name) => /^plan-R/.test(name)), "no answer file in the project folder");
  } finally {
    await fx.cleanup();
  }
});

test("the order of the checks: unknown project 404 → Origin 403 → size 413 → JSON 400 → kind 400 → empty 400", { timeout: 90_000 }, async () => {
  const fx = await serve_fixture("pes-fb-order-");
  try {
    const { server } = fx;
    const evil = "https://evil.example";
    const bad = Buffer.from("{ this is not json", "utf8");
    // project first: an unknown project is 404 even from a rejected origin with garbage in the body
    const missing = await server.post("/missing/feedback", bad, evil);
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.json(), { ok: false });
    // then the Origin: garbage from a rejected origin is 403, not 400
    const forbidden = await server.post("/synthetic/feedback", bad, evil);
    assert.equal(forbidden.status, 403);
    assert.deepEqual(forbidden.json(), { ok: false, error: "origin", hint: `pes remote add ${evil}` });
    // a good origin and garbage: 400 {ok:false}
    const garbage = await server.post("/synthetic/feedback", bad);
    assert.equal(garbage.status, 400);
    assert.deepEqual(garbage.json(), { ok: false });
    for (const odd of [[], "text", null, 5]) {
      const answer = await server.post("/synthetic/feedback", Buffer.from(JSON.stringify(odd), "utf8"));
      assert.equal(answer.status, 400, `body ${JSON.stringify(odd)}`);
      assert.deepEqual(answer.json(), { ok: false });
    }
    const kind = await server.post("/synthetic/feedback", { stage: "plan", kind: "bogus", text: "x" });
    assert.deepEqual([kind.status, kind.json()], [400, { ok: false, error: "kind" }]);
    const empty = await server.post("/synthetic/feedback", { stage: "plan", text: " \n\t ", answers: {} });
    assert.deepEqual([empty.status, empty.json()], [400, { ok: false, error: "empty" }]);
    // kind is checked before empty
    const both = await server.post("/synthetic/feedback", { stage: "plan", kind: "bogus", text: "" });
    assert.deepEqual(both.json(), { ok: false, error: "kind" });
    // answers alone are enough
    const answers_only = await server.post("/synthetic/feedback", { stage: "plan", round: 1, text: "", answers: { a: 1 } });
    assert.equal(answers_only.status, 200);
    // nothing was stored by any refusal
    assert.equal(srv_answer_docs(fx.ctx, "synthetic").length, 1);
  } finally {
    await fx.cleanup();
  }
});

test("the Origin must be exactly this server (127.0.0.1 or localhost, this port) or listed in ~/.pes/config.json — the list is read on every request", { timeout: 90_000 }, async () => {
  const fx = await serve_fixture("pes-fb-origin-");
  try {
    const { server, ctx } = fx;
    const body = { stage: "plan", round: 1, text: "합성" };
    const port = server.port;
    for (const origin of [null, "null", "", `http://127.0.0.1:${port}/`, `HTTP://127.0.0.1:${port}`, `http://127.0.0.1:${port + 1}`, `http://127.0.0.1:${port}.evil.example`, `https://127.0.0.1:${port}`, `http://[::1]:${port}`, "https://remote.example"]) {
      const answer = await server.post("/synthetic/feedback", body, origin);
      assert.equal(answer.status, 403, `Origin ${JSON.stringify(origin)}`);
      assert.equal(answer.json().error, "origin");
      assert.equal(answer.json().hint, `pes remote add ${origin ?? ""}`);
    }
    // the trusted list changes while the server runs
    mkdirSync(join(ctx.home_dir, ".pes"), { recursive: true });
    writeFileSync(join(ctx.home_dir, ".pes", "config.json"), JSON.stringify({ trusted_origins: ["https://remote.example"], other: 1 }), "utf8");
    assert.equal((await server.post("/synthetic/feedback", body, "https://remote.example")).status, 200);
    assert.equal((await server.post("/synthetic/feedback", body, "https://remote.example/")).status, 403, "exact string match, no normalisation");
    // a broken config file means "no trusted origins", never a crash
    writeFileSync(join(ctx.home_dir, ".pes", "config.json"), "{ not json", "utf8");
    assert.equal((await server.post("/synthetic/feedback", body, "https://remote.example")).status, 403);
    assert.equal((await server.post("/synthetic/feedback", body)).status, 200, "the server itself still answers");
    writeFileSync(join(ctx.home_dir, ".pes", "config.json"), JSON.stringify({ trusted_origins: null }), "utf8");
    assert.equal((await server.post("/synthetic/feedback", body, "https://remote.example")).status, 403);
  } finally {
    await fx.cleanup();
  }
});

test("body size: 0 bytes and anything above 256 KiB are 413 (connection closed), exactly 256 KiB is read; chunked bodies without a length are 413 too; the server stays up", { timeout: 120_000 }, async () => {
  const fx = await serve_fixture("pes-fb-size-");
  try {
    const { server } = fx;
    const exact = (total: number): Buffer => {
      const head = '{"stage":"plan","round":1,"text":"';
      const tail = '"}';
      return Buffer.from(head + "a".repeat(total - head.length - tail.length) + tail, "utf8");
    };
    const at_limit = await server.post("/synthetic/feedback", exact(MAX_BODY));
    assert.equal(at_limit.status, 200, "256 KiB exactly is accepted");
    const over = await server.post("/synthetic/feedback", exact(MAX_BODY + 1));
    assert.deepEqual([over.status, over.json()], [413, { ok: false }]);
    assert.equal(over.headers.connection, "close");
    const empty = await server.post("/synthetic/feedback", Buffer.alloc(0));
    assert.deepEqual([empty.status, empty.json()], [413, { ok: false }], "Content-Length 0 → 413 like serve.py");
    const big = await server.post("/synthetic/feedback", Buffer.alloc(3 * 1024 * 1024, 0x61));
    assert.equal(big.status, 413, "a body within the 8 MiB drain limit is read away and answered 413 (the sender is not cut off)");

    // a body above the drain limit: the answer comes at once, the connection is closed
    const head = `POST /synthetic/feedback HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nOrigin: ${server.origin()}\r\nContent-Type: application/json\r\nContent-Length: ${9 * 1024 * 1024}\r\n\r\n{"stage":"plan"`;
    const huge = await raw_http(server.port, head, 8000);
    assert.match(status_line(huge.text), /^HTTP\/1\.[01] 413 /);
    assert.equal(header_of(huge.text, "connection")?.toLowerCase(), "close");

    // chunked upload (no Content-Length)
    const chunked = await raw_http(
      server.port,
      `POST /synthetic/feedback HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nOrigin: ${server.origin()}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n10\r\n{"stage":"plan"}\r\n0\r\n\r\n`,
      8000,
    );
    assert.match(status_line(chunked.text), /^HTTP\/1\.[01] 413 /, "no Content-Length means no body: 413, not a hang");

    assert.equal((await server.post("/synthetic/feedback", { stage: "plan", round: 1, text: "아직 산다" })).status, 200);
    assert.equal(srv_answer_docs(fx.ctx, "synthetic").length, 2, "only the two accepted answers were stored");
  } finally {
    await fx.cleanup();
  }
});

test("round and nesting limits of the DB route: |round| above 2^53-1 and JSON nested deeper than 200 → 400 {ok:false,error:'invalid'}; a round that is no integer → 400 {ok:false}", { timeout: 90_000 }, async () => {
  const fx = await serve_fixture("pes-fb-limits-");
  try {
    const { server } = fx;
    const raw = (round: string, extra = ""): Buffer => Buffer.from(`{"stage":"plan","round":${round},"text":"합성"${extra}}`, "utf8");
    const safe = await server.post("/synthetic/feedback", raw("9007199254740991"));
    assert.equal(safe.status, 200);
    assert.match(safe.json().file, /^plan-R9007199254740991-/);
    for (const round of ["9007199254740992", "-9007199254740992"]) {
      const answer = await server.post("/synthetic/feedback", raw(round));
      assert.deepEqual([answer.status, answer.json()], [400, { ok: false, error: "invalid" }], `round ${round}`);
    }
    for (const round of ['"abc"', "null", "[1]", '{"a":1}', "1e400"]) {
      const answer = await server.post("/synthetic/feedback", raw(round));
      assert.deepEqual([answer.status, answer.json()], [400, { ok: false }], `round ${round}`);
    }
    assert.equal((await server.post("/synthetic/feedback", raw('"4"'))).status, 200, "a round written as a numeric string is a round");
    const nested = (depth: number): string => `{"a":`.repeat(depth - 1) + "1" + "}".repeat(depth - 1);
    const deep = await server.post("/synthetic/feedback", raw("1", `,"answers":${nested(200)}`));
    assert.equal(deep.status, 200, "200 levels (the answers object included) are the limit");
    const deeper = await server.post("/synthetic/feedback", raw("1", `,"answers":${nested(202)}`));
    assert.deepEqual([deeper.status, deeper.json()], [400, { ok: false, error: "invalid" }]);
    assert.equal((await server.request("/ping")).status, 200);
  } finally {
    await fx.cleanup();
  }
});

test("POST /feedback (the pre-0.8 alias) finds the project from the Referer; without one it is 404", { timeout: 90_000 }, async () => {
  const fx = await serve_fixture("pes-fb-referer-");
  try {
    const { server, ctx } = fx;
    const body = { stage: "plan", round: 1, text: "별칭" };
    const none = await server.post("/feedback", body);
    assert.deepEqual([none.status, none.json()], [404, { ok: false }]);
    const unknown = await server.post("/feedback", body, server.origin(), { Referer: `${server.origin()}/missing/` });
    assert.equal(unknown.status, 404);
    const ok = await server.post("/feedback", body, server.origin(), { Referer: `${server.origin()}/synthetic/ask-plan.html` });
    assert.equal(ok.status, 200);
    assert.match(ok.json().file, NAME);
    assert.deepEqual(srv_answer_docs(ctx, "synthetic").map((d) => d.doc.text), ["별칭"]);
    const evil = await server.post("/feedback", body, "https://evil.example", { Referer: `${server.origin()}/synthetic/` });
    assert.equal(evil.status, 403);
  } finally {
    await fx.cleanup();
  }
});

test("a folder that has a project.json but is not in the DB takes no answer: 404 {ok:false}, nothing is written next to it", { timeout: 90_000 }, async () => {
  const fx = await serve_fixture("pes-fb-notindb-", { legacy_only: ["oldfolder"] });
  try {
    const { server, root } = fx;
    const before = readdirSync(join(root, "oldfolder")).sort();
    const answer = await server.post("/oldfolder/feedback", { stage: "plan", round: 1, text: "어디에도 못 둔다" });
    assert.deepEqual([answer.status, answer.json()], [404, { ok: false }]);
    assert.deepEqual(readdirSync(join(root, "oldfolder")).sort(), before, "no feedback/ folder, no log");
    assert.equal((await server.request("/oldfolder/")).text(), "<html>oldfolder</html>", "its static page is still served");
  } finally {
    await fx.cleanup();
  }
});

test("40 answers at once: all 200, 40 different names, 40 stored, 40 intact notice lines, nothing lost (E09 at 3x the size)", { timeout: 180_000 }, async () => {
  const fx = await serve_fixture("pes-fb-burst-");
  try {
    const { server, ctx } = fx;
    const count = 40;
    const answers = await Promise.all(Array.from({ length: count }, (_x, i) => server.post("/synthetic/feedback", { stage: "plan", round: 1, kind: "feedback", text: `동시 답 ${i}` })));
    assert.deepEqual([...new Set(answers.map((a) => a.status))], [200]);
    const names = answers.map((a) => a.json().file as string);
    assert.equal(new Set(names).size, count, "every answer got its own name");
    const docs = srv_answer_docs(ctx, "synthetic");
    assert.equal(docs.length, count);
    assert.deepEqual(docs.map((d) => d.doc.text).sort(), Array.from({ length: count }, (_x, i) => `동시 답 ${i}`).sort());
    assert.deepEqual(docs.map((d) => d.name).sort(), [...names].sort(), "the names in the answers are the stored names");
    const lines = readFileSync(join(fx.project, "feedback.log"), "utf8").split("\n").filter((x) => x !== "");
    assert.equal(lines.length, count);
    assert.deepEqual(lines.map((l) => l.replace(/^FEEDBACK plan R1 feedback /, "")).sort(), [...names].sort(), "each notice line is whole (no interleaved writes)");
    assert.deepEqual(server.dns_attempts(), []);
    assert.deepEqual(server.hub_attempts(), []);
  } finally {
    await fx.cleanup();
  }
});

test("the answers survive a restart of the server (they are in the DB, not in memory)", { timeout: 90_000 }, async () => {
  const fx = await serve_fixture("pes-fb-restart-");
  try {
    const { server, ctx } = fx;
    assert.equal((await server.post("/synthetic/feedback", { stage: "plan", round: 1, text: "재시작 전" })).status, 200);
    await server.restart();
    assert.equal((await server.post("/synthetic/feedback", { stage: "plan", round: 1, text: "재시작 후" })).status, 200);
    assert.deepEqual(srv_answer_docs(ctx, "synthetic").map((d) => d.doc.text), ["재시작 전", "재시작 후"]);
  } finally {
    await fx.cleanup();
  }
});
