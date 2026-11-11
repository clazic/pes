// tests/test_serve.py (answers, rejections, pending answers, status paths, start-up) → TS (SEL-70, PR26a; table 8: test_feedback_http).
// A real scripts/serve.py child process (127.0.0.1, free port), isolated HOME / PES_HOME, synthetic projects.
// The concurrency tests of the same file are in test_feedback_collision.test.ts (own file: they wait on barriers).
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, utimesSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { ServeProcess, make_ctx, make_serve_home, pes, read_json, write_json, type CompatCtx } from "./helpers/compat_env.ts";
import { slow_fqdn_injection } from "./helpers/compat_inject.ts";
import { use_home_guard } from "./helpers/home_guard.ts";

use_home_guard();

const MAX_BODY = 256 * 1024;
const SLOW_FQDN_SECONDS = 60;
const STARTUP_LIMIT_S = 10;

let ctx: CompatCtx;
let server: ServeProcess;
let project: string;

beforeEach(async () => {
  ctx = make_ctx("pes-feedback-");
  const root = make_serve_home(ctx);
  project = join(root, "synthetic");
  server = await new ServeProcess(ctx, root).start();
});
afterEach(async () => {
  await server.stop();
  ctx.cleanup();
});

const feedback = (payload: unknown, origin: string | null | "default" = "default") => server.post("/synthetic/feedback", payload, origin === "default" ? server.origin() : origin);
const answers = (): string[] => (existsSync(join(project, "feedback")) ? readdirSync(join(project, "feedback")).filter((n) => n.endsWith(".json")).sort() : []);

test("POST feedback saves the answer file and the log line", async () => {
  const response = await feedback({ stage: "plan", round: 2, kind: "feedback", text: "합성 답변", answers: { purpose: "report", purpose__other: "덧붙임" }, spec: "plan-start" });
  const body = response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.ok, true);
  assert.match(body.file, /^plan-R2-\d{8}-\d{6}\.json$/);

  const path = join(project, "feedback", body.file);
  const record = read_json(path);
  assert.equal(record.stage, "plan");
  assert.equal(record.round, 2);
  assert.equal(record.kind, "feedback");
  assert.equal(record.text, "합성 답변");
  assert.deepEqual(record.answers, { purpose: "report", purpose__other: "덧붙임" });
  assert.equal(record.spec, "plan-start");
  assert.equal(record.via, "html");
  assert.equal(record.origin, server.origin());

  const log = readFileSync(join(project, "feedback.log"), "utf8");
  assert.ok(log.includes(`FEEDBACK plan R2 feedback ${path}`), log);
});

test("a trusted origin from the isolated ~/.pes/config.json is accepted (via = remote), another origin gets 403 with a hint", async () => {
  write_json(join(ctx.home_dir, ".pes", "config.json"), { trusted_origins: ["https://remote.example"] }, undefined);
  const ok = await feedback({ stage: "plan", round: 0, text: "원격 답" }, "https://remote.example");
  assert.equal(ok.status, 200, ok.text());
  const record = read_json(join(project, "feedback", ok.json().file));
  assert.equal(record.via, "remote");
  assert.equal(record.origin, "https://remote.example");

  const denied = await feedback({ stage: "plan", round: 0, text: "거부" }, "https://evil.example");
  assert.equal(denied.status, 403);
  assert.deepEqual(denied.json(), { ok: false, error: "origin", hint: "pes remote add https://evil.example" });
});

const REJECTIONS: [string, unknown, string | null | "default", number, string][] = [
  ["foreign origin", { stage: "plan", text: "합성" }, "https://evil.example", 403, "origin"],
  ["no origin header", { stage: "plan", text: "합성" }, null, 403, "origin"],
  ["unknown kind", { stage: "plan", kind: "bogus", text: "합성" }, "default", 400, "kind"],
  ["blank text and empty answers", { stage: "plan", kind: "feedback", text: "   ", answers: {} }, "default", 400, "empty"],
  ["neither text nor answers", { stage: "plan", kind: "feedback" }, "default", 400, "empty"],
];
for (const [name, payload, origin, status, error] of REJECTIONS) {
  test(`feedback rejection: ${name} → ${status} ${error}, nothing is written`, async () => {
    const response = await feedback(payload, origin);
    assert.equal(response.status, status);
    const body = response.json();
    assert.equal(body.ok, false);
    assert.equal(body.error, error);
    assert.deepEqual(answers(), []);
    assert.ok(!existsSync(join(project, "feedback.log")) || readFileSync(join(project, "feedback.log"), "utf8") === "");
  });
}

test("broken JSON is rejected with 400 {ok:false}", async () => {
  const response = await server.post("/synthetic/feedback", Buffer.from('{"stage": "plan", "text":', "utf8"), server.origin());
  assert.equal(response.status, 400);
  assert.deepEqual(response.json(), { ok: false });
  assert.deepEqual(answers(), []);
});

test("a body over 256 KiB is rejected with 413 {ok:false}", async () => {
  const payload = Buffer.concat([Buffer.from('{"stage": "plan", "text": "', "utf8"), Buffer.alloc(MAX_BODY + 1, "x"), Buffer.from('"}', "utf8")]);
  const response = await server.post("/synthetic/feedback", payload, server.origin());
  assert.equal(response.status, 413);
  assert.deepEqual(response.json(), { ok: false });
  assert.deepEqual(answers(), []);
});

test("an unknown project is 404 {ok:false} and no folder is created for it", async () => {
  const response = await server.post("/missing/feedback", { stage: "plan", text: "합성" }, server.origin());
  assert.equal(response.status, 404);
  assert.deepEqual(response.json(), { ok: false });
  assert.ok(!existsSync(join(server.root, "missing")));
  assert.deepEqual(answers(), []);
});

test("pending answers survive mark and a server restart; processed lists them in order", async () => {
  const names: string[] = [];
  for (const text of ["첫 답", "둘째 답"]) {
    const response = await feedback({ stage: "plan", round: 1, kind: "feedback", text });
    assert.equal(response.status, 200, response.text());
    names.push(response.json().file);
  }
  assert.notEqual(names[0], names[1]);
  assert.deepEqual(answers(), [...names].sort());

  const pending = (): string[] => {
    const run = pes(ctx, "pending", project);
    assert.equal(run.code, 0, run.out + run.err);
    return run.out.split("\n").filter((l) => l.trim() !== "").map((l) => basename(l.trim().split("\\").join("/")));
  };
  assert.deepEqual(pending().sort(), [...names].sort());

  assert.equal(pes(ctx, "mark", project, names[0] as string).code, 0);
  assert.deepEqual(pending(), [names[1]]);

  // The answer files and the processed marks are the same after the server is restarted.
  await server.restart();
  assert.deepEqual(pending(), [names[1]]);
  assert.ok(existsSync(join(project, "feedback", names[1] as string)));

  assert.equal(pes(ctx, "mark", project, names[1] as string).code, 0);
  assert.deepEqual(pending(), []);
  const processed = read_json(join(project, "project.json")).processed;
  assert.deepEqual(processed, names);
});

test("version / ping / whoami", async () => {
  const old = 1_600_000_000;
  utimesSync(join(project, "index.html"), old, old);
  utimesSync(join(project, "ask-plan.html"), old + 10, old + 10);
  utimesSync(join(server.root, "index.html"), old + 20, old + 20);

  const ping = await server.request("/ping");
  assert.deepEqual([ping.status, ping.json()], [200, { ok: true }]);
  const project_ping = await server.request("/synthetic/ping");
  assert.deepEqual([project_ping.status, project_ping.json()], [200, { ok: true }]);

  const who = await server.request("/whoami");
  assert.equal(who.status, 200);
  const info = who.json();
  assert.equal(info.single, true);
  assert.equal(String(info.root).split("\\").join("/").toLowerCase(), server.root.split("\\").join("/").toLowerCase());

  const project_version = await server.request("/synthetic/version");
  assert.deepEqual([project_version.status, project_version.json()], [200, { v: old + 10 }]);
  const home_version = await server.request("/version");
  assert.deepEqual([home_version.status, home_version.json()], [200, { v: old + 20 }]);
});

test("start-up does not wait for a slow reverse DNS lookup (SEL-33)", async () => {
  const slow_ctx = make_ctx("pes-feedback-dns-");
  const slow = new ServeProcess(slow_ctx, make_serve_home(slow_ctx), { sitecustomize: slow_fqdn_injection(SLOW_FQDN_SECONDS) });
  const started = performance.now();
  try {
    await slow.start();
    const ping = await slow.request("/ping");
    assert.deepEqual([ping.status, ping.json()], [200, { ok: true }]);
  } finally {
    await slow.stop();
    slow_ctx.cleanup();
  }
  const elapsed = (performance.now() - started) / 1000;
  assert.ok(elapsed < STARTUP_LIMIT_S, `first answer after ${elapsed.toFixed(1)}s (reverse DNS wait suspected)`);
});

// ---------------------------------------------------------------- the start-up failure paths of the harness itself
for (const failure of ["timeout", "early_exit", "spawn_error"] as const) {
  test(`start failure (${failure}): every child is gone and the object is clean`, async () => {
    const broken_ctx = make_ctx("pes-feedback-fail-");
    const root = make_serve_home(broken_ctx);
    const options =
      failure === "timeout"
        ? { expected_root: join(broken_ctx.tmp, "other root"), ready_timeout_ms: 400 }
        : failure === "early_exit"
          ? { script: join(broken_ctx.tmp, "missing-serve.py") }
          : { command: join(broken_ctx.tmp, "no-such-python") };
    const broken = new ServeProcess(broken_ctx, root, options);
    try {
      await assert.rejects(broken.start(), /did not start after 3 attempts/);
      assert.equal(broken.children.length, 3);
      for (const child of broken.children) {
        const gone = child.pid === undefined || child.exitCode !== null || child.signalCode !== null;
        assert.ok(gone, "a child of a failed start is still running");
      }
      assert.equal(broken.proc, undefined);
    } finally {
      await broken.stop();
      for (const child of broken.children) if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) child.kill("SIGKILL");
      broken_ctx.cleanup();
    }
  });
}
