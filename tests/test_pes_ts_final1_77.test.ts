// SEL-77 final review 1/2 (logs/SEL-77-final-review-1.md) — the worker's tests for its two required fixes:
//   필수 1  a server record (`.pes-hub-server` of the home, `.pes-server` of an old per-project server) is only a note: its pid is signalled
//           only when the port the record names answers /whoami (127.0.0.1) with this home (or this project). A stale record whose pid now
//           belongs to an unrelated process is forgotten without a signal — nothing on the port, or another home's server on it.
//           The real server of this home is still stopped.
//   필수 2  `report` registers the .docx / .hwpx / .pdf / .pptx files in reports/<stage>/ as stage reports like 0.15 (pes.py cmd_report):
//           `show`'s reports (the read model: dashboard, hub) lists them with a '/' path, and the printed line and the list equal 0.15's.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { test } from "node:test";

import { looks_like_stack_trace, norm_out } from "./helpers/compat_cases.ts";
import { free_port, make_ctx, type CompatCtx } from "./helpers/compat_env.ts";
import { golden } from "./helpers/cli_read_env.ts";
import { run_ts_cli, run_ts_cli_async, type TsRunOptions } from "./helpers/compat_ts.ts";
import { use_home_guard } from "./helpers/home_guard.ts";
import { HUB_PORT_FIRST, HUB_PORT_LAST } from "./helpers/hub_block.ts";

use_home_guard();

const SLUG = "final1-시험";

/** An unrelated process of the test (stands for whatever program got the recorded pid after a crash or a reboot). */
function bystander(): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  assert.ok(typeof child.pid === "number" && child.pid > 1);
  return child;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const settle = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

async function stand_in(root: string): Promise<{ port: number; server: Server }> {
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(req.url === "/whoami" ? JSON.stringify({ root, single: true }) : "{}");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  return { port: (server.address() as { port: number }).port, server };
}

function outside_real_range(port: number): void {
  assert.ok(port < HUB_PORT_FIRST || port > HUB_PORT_LAST, "the injected port is outside the real PES range");
}

test("필수 1: a stale record whose pid is an unrelated process and whose port is empty — `stop` (home and project) and `doctor --fix` forget the record and leave the process alive", { timeout: 240_000 }, async () => {
  const ctx = make_ctx("pes-ts-final1-stale-");
  const child = bystander();
  try {
    const pid = child.pid as number;
    const port = await free_port(); // nothing listens there
    outside_real_range(port);
    const project = join(ctx.pes_home, SLUG);
    assert.equal(run_ts_cli(ctx, ["init", project, "--topic", "합성 주제"]).status, 0);
    const opts: TsRunOptions = { env: { PES_HUB_PORTS: `${port}-${port}` } };

    writeFileSync(join(ctx.pes_home, ".pes-hub-server"), JSON.stringify({ pid, port }), "utf8");
    writeFileSync(join(project, ".pes-server"), JSON.stringify({ pid, port }), "utf8");
    writeFileSync(join(project, ".pes-port"), String(port), "utf8");
    const stop = await run_ts_cli_async(ctx, ["stop", project], opts);
    assert.equal(stop.status, 0, stop.stderr);
    assert.match(stop.stdout, /^서버 종료 \(.+ — 이 홈의 모든 프로젝트 화면이 함께 꺼집니다\)\n$/, "0.15's line is kept");
    assert.ok(!looks_like_stack_trace(stop.stderr.split("\n")));
    await settle(300);
    assert.ok(alive(pid), "the unrelated process got no signal from `stop <project>`");
    for (const f of [join(ctx.pes_home, ".pes-hub-server"), join(project, ".pes-server"), join(project, ".pes-port")]) assert.ok(!existsSync(f), `${f} is forgotten`);

    // the home's record alone (`stop` without a project)
    writeFileSync(join(ctx.pes_home, ".pes-hub-server"), JSON.stringify({ pid, port }), "utf8");
    const home_stop = await run_ts_cli_async(ctx, ["stop"], opts);
    assert.equal(home_stop.status, 0, home_stop.stderr);
    await settle(300);
    assert.ok(alive(pid), "the unrelated process got no signal from `stop`");
    assert.ok(!existsSync(join(ctx.pes_home, ".pes-hub-server")));

    // a record without a port: only the old `.pes-port` may name it; with neither nothing is asked and nothing is signalled
    writeFileSync(join(project, ".pes-server"), JSON.stringify({ pid }), "utf8");
    const fix = await run_ts_cli_async(ctx, ["doctor", project, "--fix"], { ...opts, narrow_path: true, extra_read: [ctx.narrow_bin], allow_child_process: true });
    assert.ok(fix.status === 0 || fix.status === 1, fix.stderr);
    await settle(300);
    assert.ok(alive(pid), "the unrelated process got no signal from `doctor --fix`");
    assert.ok(!existsSync(join(project, ".pes-server")), "doctor --fix forgets the stale record");
  } finally {
    child.kill();
    ctx.cleanup();
  }
});

test("필수 1: the recorded port answers /whoami for ANOTHER home (or another project) — no signal, the record is forgotten", { timeout: 240_000 }, async () => {
  const ctx = make_ctx("pes-ts-final1-other-");
  const child = bystander();
  const other = join(ctx.tmp, "다른-홈");
  mkdirSync(other, { recursive: true });
  const { port, server } = await stand_in(other);
  try {
    outside_real_range(port);
    const pid = child.pid as number;
    const project = join(ctx.pes_home, SLUG);
    assert.equal(run_ts_cli(ctx, ["init", project, "--topic", "합성 주제"]).status, 0);
    writeFileSync(join(ctx.pes_home, ".pes-hub-server"), JSON.stringify({ pid, port }), "utf8");
    writeFileSync(join(project, ".pes-server"), JSON.stringify({ pid, port }), "utf8");
    const stop = await run_ts_cli_async(ctx, ["stop", project], { env: { PES_HUB_PORTS: `${port}-${port}` } });
    assert.equal(stop.status, 0, stop.stderr);
    await settle(300);
    assert.ok(alive(pid), "a server of another home on the recorded port does not make the recorded pid ours");
    assert.ok(!existsSync(join(ctx.pes_home, ".pes-hub-server")) && !existsSync(join(project, ".pes-server")), "both records are forgotten");
  } finally {
    server.close();
    child.kill();
    ctx.cleanup();
  }
});

test("필수 1 (control): the real server of this home is still stopped by its record", { timeout: 240_000 }, async () => {
  const ctx = make_ctx("pes-ts-final1-real-");
  const port = await free_port();
  outside_real_range(port);
  const run = (args: string[]) => run_ts_cli(ctx, args, { allow_child_process: true, timeout_ms: 90_000, env: { PES_HUB_PORTS: `${port}-${port}` } });
  let pid = 0;
  try {
    const project = join(ctx.pes_home, SLUG);
    assert.equal(run(["init", project, "--topic", "합성 주제"]).status, 0);
    const served = run(["serve", project]);
    assert.equal(served.status, 0, served.stderr);
    pid = Number(JSON.parse(readFileSync(join(ctx.pes_home, ".pes-hub-server"), "utf8")).pid);
    assert.ok(alive(pid), "the server runs");
    const stop = run(["stop"]);
    assert.equal(stop.status, 0, stop.stderr);
    for (let i = 0; i < 50 && alive(pid); i += 1) await settle(100);
    assert.ok(!alive(pid), "this home's server is stopped");
    assert.ok(!existsSync(join(ctx.pes_home, ".pes-hub-server")));
  } finally {
    if (pid > 1 && alive(pid)) process.kill(pid);
    ctx.cleanup();
  }
});

/** E05's start (init, round-start), a Word and a PDF file in reports/plan/, then `report` (ts); the printed lines and the registered list. */
function report_with_files(ctx: CompatCtx): { out: string[]; reports: unknown } {
  const project = ctx.project();
  const run = (...args: string[]) => run_ts_cli(ctx, args);
  for (const step of [["init", project, "--topic", "합성 주제"], ["round-start", project, "plan"]]) {
    const r = run(...step);
    assert.equal(r.status, 0, `ts ${step[0]}: ${r.stderr}`);
  }
  const rd = join(project, "reports", "plan");
  mkdirSync(rd, { recursive: true });
  writeFileSync(join(rd, "report.docx"), Buffer.from("PK\u0003\u0004 synthetic docx", "latin1"));
  writeFileSync(join(rd, "report.pdf"), Buffer.from("%PDF-1.4 synthetic", "latin1"));
  const rep = run("report", project, "plan");
  assert.equal(rep.status, 0, `ts report: ${rep.stderr}`);
  const out = norm_out(rep.stdout, ctx.roots(project));
  const show = run_ts_cli(ctx, ["show", project, "plan"]);
  assert.equal(show.status, 0, show.stderr);
  const reports = JSON.parse(show.stdout).reports;
  assert.equal(readFileSync(join(rd, "report.docx"), "latin1"), "PK\u0003\u0004 synthetic docx", "ts: the Word file is left as it was");
  return { out, reports };
}

test("필수 2: report registers reports/plan/report.docx and report.pdf like 0.15 — show's reports lists them with '/' paths, same line and list as 0.15 (frozen record)", { timeout: 240_000 }, () => {
  // what 0.15 printed and registered for the same steps: tests/fixtures/golden/report-with-docx-pdf.json
  const old = golden<{ out: string[]; reports: Array<{ format: string; label: string; path: string; bytes: number }> }>("report-with-docx-pdf");
  const ts_ctx = make_ctx("pes-ts-final1-rep-ts-");
  try {
    const ts = report_with_files(ts_ctx);
    assert.deepEqual(ts.out, old.out, "the printed lines equal 0.15's (E05 with a Word and a PDF file)");
    const shape = (list: unknown) =>
      (list as Array<Record<string, unknown>>).map((r) => ({ format: r.format, label: r.label, path: String(r.path).split("\\").join("/") }));
    assert.deepEqual(shape(ts.reports), shape(old.reports), "the registered formats, labels and paths equal 0.15's");
    const ts_list = ts.reports as Array<Record<string, unknown>>;
    for (const fmt of ["docx", "pdf"]) {
      const row = ts_list.find((r) => r.format === fmt);
      assert.ok(row !== undefined, `${fmt} is in show's reports`);
      assert.equal(row.path, `reports/plan/report.${fmt}`, "a '/' path on every platform");
      const want = old.reports.find((r) => r.format === fmt);
      assert.equal(row.bytes, want?.bytes, `${fmt}: the size of the file as it is (no line-end change)`);
    }
  } finally {
    ts_ctx.cleanup();
  }
});
