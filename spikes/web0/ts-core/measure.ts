// WEB0 measurement runner. Local proxies only; no account, card, deploy, or paid call.
// Values are "판정 아님 — 스모크/대리값" as documented in web0-result.md.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { SqliteDb } from "./sqlite-adapter.ts";
import { runRound, type RunStats } from "./scenario.ts";
import { startFakeGo, type FakeGoServer } from "./fake-go.ts";
import { runContractSuite, type ContractResult } from "./contract-suite.ts";
import { killTree, measureTree, snapshotTree } from "./process-stats.ts";
import { applyDdl, cleanupDir, findD1Sqlite, freePort, startWranglerDev, WEB0_ROOT } from "./wrangler.ts";
import { buildHwpxFromMarkdown } from "./hwpx.ts";
import { build as esbuild } from "esbuild";

const DDL_PATH = fileURLToPath(new URL("../../../docs/plan/schemas/stage-1-ddl-draft.sql", import.meta.url));
const FIXTURE_DIR = fileURLToPath(new URL("../../../docs/plan/fixtures/api-v1/", import.meta.url));
const OUT_DIR = fileURLToPath(new URL("../out/", import.meta.url));
const HWPX_REPORT_PATH = fileURLToPath(new URL("../fixtures/report.md", import.meta.url));
const HWPX_SOURCE_PATH = fileURLToPath(new URL("./hwpx.ts", import.meta.url));
const CSV_PATH = fileURLToPath(new URL("../../../docs/plan/spikes/web0-measurements.csv", import.meta.url));

const WARMUP = 1;
const MEASURED = 3;
const CONSECUTIVE = 10;

/** Business/contract core only. Measurement and runner tooling are excluded. */
const CORE_FILES = new Set([
  "contract.ts",
  "decimal.ts",
  "dto.ts",
  "db.ts",
  "sqlite-adapter.ts",
  "store.ts",
  "service.ts",
  "http.ts",
  "scenario.ts",
  "fake-go.ts",
]);

interface RoundRecord {
  candidate: string;
  phase: "warmup" | "measured" | "consecutive";
  round: number;
  wallMs: number;
  cpuMs: number;
  rssMb: number;
  dbWriteOps: number;
  dbRowsChanged: number;
  newRows: number;
  insertChangedRows: number;
  updateChangedRows: number;
  subrequests: number;
  requestBytes: number;
  responseBytes: number;
  serverWallMs: number;
  note: string;
}

interface RuntimeRecord {
  runtime: string;
  version: string;
  status: "pass" | "fail";
  wallMs: number;
  cpuMs: number;
  rssMb: number;
  newRows: number;
  insertChangedRows: number;
  dbWriteOps: number;
  note: string;
}

interface NamedContract {
  candidate: string;
  result: ContractResult;
}

interface HwpxRecord {
  candidate: string;
  status: "pass" | "fail";
  wallMs: number;
  cpuMs: number;
  rssMb: number;
  bytes: number;
  sha256: string;
  note: string;
}

interface RoundPayload {
  stats: RunStats;
  serverWallMs: number;
}

const roundRecords: RoundRecord[] = [];
const contractRecords: NamedContract[] = [];
const runtimeRecords: RuntimeRecord[] = [];
const hwpxRecords: HwpxRecord[] = [];
const metaRecords: { metric: string; value: string; unit: string; note: string }[] = [];
const errorRecords: { candidate: string; message: string }[] = [];

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
}

function hashFiles(directory: string, filter: (name: string) => boolean): string {
  const hash = createHash("sha256");
  const files = (readdirSync(directory, { recursive: true }) as string[])
    .filter((name) => filter(name))
    .sort();
  for (const name of files) {
    hash.update(name);
    hash.update(readFileSync(join(directory, name)));
  }
  return hash.digest("hex");
}

function round(
  candidate: string,
  phase: RoundRecord["phase"],
  index: number,
  payload: RoundPayload,
  measured: { wallMs: number; cpuMs: number; rssMb: number; subrequests: number; note: string },
): void {
  roundRecords.push({
    candidate,
    phase,
    round: index,
    wallMs: measured.wallMs,
    cpuMs: measured.cpuMs,
    rssMb: measured.rssMb,
    dbWriteOps: payload.stats.dbWriteOps,
    dbRowsChanged: payload.stats.dbRowsChanged,
    newRows: payload.stats.newRows,
    insertChangedRows: payload.stats.insertChangedRows,
    updateChangedRows: payload.stats.updateChangedRows,
    subrequests: measured.subrequests,
    requestBytes: payload.stats.requestBytes,
    responseBytes: payload.stats.responseBytes,
    serverWallMs: payload.stats.wallMs,
    note: measured.note,
  });
}

function fakeDelta(fake: FakeGoServer, before: number): number {
  return fake.stats.requests - before;
}

async function measureNode(fake: FakeGoServer): Promise<void> {
  const db = new SqliteDb(":memory:");
  try {
    await db.exec(readFileSync(DDL_PATH, "utf8"));
    const invoke = async (): Promise<RoundPayload> => {
      const stats = await runRound(db, { fakeGoUrl: fake.url });
      return { stats, serverWallMs: stats.wallMs };
    };
    const runOne = async (phase: RoundRecord["phase"], index: number) => {
      const beforeFake = fake.stats.requests;
      const cpuBefore = process.cpuUsage();
      const wallBefore = performance.now();
      const payload = await invoke();
      const wallMs = performance.now() - wallBefore;
      const cpu = process.cpuUsage(cpuBefore);
      round("vps-node", phase, index, payload, {
        wallMs,
        cpuMs: (cpu.user + cpu.system) / 1000,
        rssMb: process.memoryUsage().rss / 1024 / 1024,
        subrequests: fakeDelta(fake, beforeFake),
        note: "in-process Node 26 + node:sqlite; CPU/RSS measured in the same process (includes fake Go client)",
      });
    };
    for (let index = 1; index <= WARMUP; index += 1) await runOne("warmup", index);
    for (let index = 1; index <= MEASURED; index += 1) await runOne("measured", index);
    for (let index = 1; index <= CONSECUTIVE; index += 1) await runOne("consecutive", index);
  } finally {
    db.close();
  }
}

async function startVcServer(fake: FakeGoServer): Promise<{ child: ReturnType<typeof spawn>; url: string }> {
  const child = spawn(
    process.execPath,
    [
      "ts-core/vc-server.ts",
      "--ddl",
      DDL_PATH,
      "--fake-go",
      fake.url,
      "--pool",
      String(WARMUP + MEASURED + CONSECUTIVE + 2),
    ],
    { cwd: WEB0_ROOT, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] },
  );
  let buffer = "";
  const url = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      killTree(child.pid ?? 0, "SIGKILL");
      reject(new Error("vc server start timeout"));
    }, 30000);
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (const line of buffer.split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as { ready?: boolean; port?: number };
          if (parsed.ready && parsed.port) {
            clearTimeout(timeout);
            resolve(`http://127.0.0.1:${parsed.port}`);
            return;
          }
        } catch {
          // wait for the ready line
        }
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`vc server exited early: ${code}`));
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
  return { child, url };
}

async function postRound(url: string): Promise<RoundPayload> {
  const response = await fetch(`${url}/api/v1/_spike/round`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(120000),
  });
  const text = await response.text();
  if (response.status !== 200) throw new Error(`round failed ${response.status}: ${text.slice(0, 500)}`);
  const parsed = JSON.parse(text) as { stats: RunStats };
  return { stats: parsed.stats, serverWallMs: parsed.stats.wallMs };
}

async function measureHttpCandidate(
  candidate: string,
  url: string,
  pid: number,
  fake: FakeGoServer,
  note: string,
): Promise<void> {
  const runOne = async (phase: RoundRecord["phase"], index: number) => {
    const beforeFake = fake.stats.requests;
    const { result, cpuMs, rssMb } = await measureTree(pid, async () => {
      const wallBefore = performance.now();
      const payload = await postRound(url);
      return { payload, wallMs: performance.now() - wallBefore };
    });
    round(candidate, phase, index, result.payload, {
      wallMs: result.wallMs,
      cpuMs,
      rssMb,
      subrequests: fakeDelta(fake, beforeFake),
      note,
    });
  };
  for (let index = 1; index <= WARMUP; index += 1) await runOne("warmup", index);
  for (let index = 1; index <= MEASURED; index += 1) await runOne("measured", index);
  for (let index = 1; index <= CONSECUTIVE; index += 1) await runOne("consecutive", index);
}

async function measureVercelProxy(fake: FakeGoServer): Promise<void> {
  const { child, url } = await startVcServer(fake);
  try {
    await measureHttpCandidate(
      "vercel-node-proxy",
      url,
      child.pid ?? 0,
      fake,
      "Vercel-style Node handler on 127.0.0.1 + local SQLite (Turso/libSQL proxy); CPU/RSS from the server process tree",
    );
  } finally {
    killTree(child.pid ?? 0, "SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        killTree(child.pid ?? 0, "SIGKILL");
        resolve();
      }, 5000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

async function measureHwpxNode(): Promise<void> {
  const markdown = readFileSync(HWPX_REPORT_PATH, "utf8");
  const runs: { wallMs: number; cpuMs: number; rssMb: number; bytes: number; sha256: string }[] = [];
  let lastBytes: Uint8Array | null = null;
  for (let index = 0; index < 4; index += 1) {
    const cpuBefore = process.cpuUsage();
    const wallBefore = performance.now();
    const result = buildHwpxFromMarkdown(markdown);
    const wallMs = performance.now() - wallBefore;
    const cpu = process.cpuUsage(cpuBefore);
    if (index > 0) {
      runs.push({
        wallMs,
        cpuMs: (cpu.user + cpu.system) / 1000,
        rssMb: process.memoryUsage().rss / 1024 / 1024,
        bytes: result.bytes.byteLength,
        sha256: createHash("sha256").update(result.bytes).digest("hex"),
      });
      lastBytes = result.bytes;
    }
  }
  if (!lastBytes) throw new Error("HWPX Node build produced no output");
  const outputDir = join(OUT_DIR, "hwpx");
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, "report.hwpx"), lastBytes);
  hwpxRecords.push({
    candidate: "node-hwpx",
    status: "pass",
    wallMs: median(runs.map((run) => run.wallMs)),
    cpuMs: median(runs.map((run) => run.cpuMs)),
    rssMb: median(runs.map((run) => run.rssMb)),
    bytes: runs[runs.length - 1]?.bytes ?? 0,
    sha256: runs[runs.length - 1]?.sha256 ?? "",
    note: "1 warmup + 3 measured; pure TS + fflate; out/hwpx/report.hwpx not committed",
  });
}

async function measureHwpxCloudflare(
  dev: { url: string; pid: number },
  markdown: string,
): Promise<void> {
  const runs: { wallMs: number; cpuMs: number; rssMb: number; bytes: number; sha256: string }[] = [];
  for (let index = 0; index < 4; index += 1) {
    const measured = await measureTree(dev.pid, async () => {
      const wallBefore = performance.now();
      const response = await fetch(`${dev.url}/api/v1/_spike/hwpx`, {
        method: "POST",
        body: markdown,
        headers: { "Content-Type": "text/markdown" },
        signal: AbortSignal.timeout(60000),
      });
      const text = await response.text();
      if (response.status !== 200) throw new Error(`hwpx failed ${response.status}: ${text.slice(0, 300)}`);
      return { parsed: JSON.parse(text) as { bytes: number; sha256: string }, wallMs: performance.now() - wallBefore };
    });
    if (index > 0) {
      runs.push({
        wallMs: measured.result.wallMs,
        cpuMs: measured.cpuMs,
        rssMb: measured.rssMb,
        bytes: measured.result.parsed.bytes,
        sha256: measured.result.parsed.sha256,
      });
    }
  }
  const nodeRecord = hwpxRecords.find((record) => record.candidate === "node-hwpx");
  const last = runs[runs.length - 1];
  const sameBytes = nodeRecord ? nodeRecord.sha256 === last?.sha256 : false;
  hwpxRecords.push({
    candidate: "cf-wrangler-d1",
    status: sameBytes ? "pass" : "fail",
    wallMs: median(runs.map((run) => run.wallMs)),
    cpuMs: median(runs.map((run) => run.cpuMs)),
    rssMb: median(runs.map((run) => run.rssMb)),
    bytes: last?.bytes ?? 0,
    sha256: last?.sha256 ?? "",
    note: `same code in workerd; sha_equal_node=${sameBytes}`,
  });
}

async function measureHwpxBrowser(): Promise<void> {
  try {
    const result = await esbuild({
      entryPoints: [HWPX_SOURCE_PATH],
      bundle: true,
      write: false,
      platform: "browser",
      format: "esm",
      target: ["es2022"],
      logLevel: "silent",
    });
    const output = result.outputFiles?.[0]?.contents;
    if (!output) throw new Error("esbuild produced no output");
    hwpxRecords.push({
      candidate: "browser-bundle",
      status: "pass",
      wallMs: 0,
      cpuMs: 0,
      rssMb: 0,
      bytes: output.byteLength,
      sha256: "",
      note: "esbuild platform=browser bundle; source scan has no node:/DOM/window/Buffer",
    });
  } catch (error) {
    hwpxRecords.push({
      candidate: "browser-bundle",
      status: "fail",
      wallMs: 0,
      cpuMs: 0,
      rssMb: 0,
      bytes: 0,
      sha256: "",
      note: error instanceof Error ? error.message : String(error),
    });
  }
}

async function measureCloudflare(fake: FakeGoServer): Promise<void> {
  const persistDir = join(OUT_DIR, "cf-state");
  applyDdl(persistDir, DDL_PATH);
  const port = await freePort();
  const dev = await startWranglerDev({ persistDir, fakeGoUrl: fake.url, port });
  try {
    await measureHttpCandidate(
      "cf-wrangler-d1",
      dev.url,
      dev.pid,
      fake,
      "wrangler dev --local (Workers + local D1 simulator); CPU/RSS from the wrangler/workerd process tree",
    );
    const response = await fetch(`${dev.url}/api/v1/_spike/contract`, {
      method: "POST",
      body: "{}",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(60000),
    });
    const text = await response.text();
    if (response.status !== 200) throw new Error(`D1 contract failed ${response.status}: ${text.slice(0, 500)}`);
    const parsed = JSON.parse(text) as { result: ContractResult };
    contractRecords.push({ candidate: "cf-wrangler-d1", result: parsed.result });
    metaRecords.push({
      metric: "cf_d1_sqlite_file",
      value: findD1Sqlite(persistDir) ? "present" : "missing",
      unit: "",
      note: "local D1 storage file (path not recorded)",
    });
    await measureHwpxCloudflare(dev, readFileSync(HWPX_REPORT_PATH, "utf8"));
  } finally {
    await dev.stop();
    cleanupDir(persistDir);
  }
}

async function runChildRuntime(
  command: string,
  args: string[],
  runtime: string,
  version: string,
  fake: FakeGoServer,
): Promise<void> {
  const started = performance.now();
  let peakRssKb = 0;
  let lastCpuMs = 0;
  const child = spawn(command, args, {
    cwd: WEB0_ROOT,
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
  const pid = child.pid ?? 0;
  const sampler = setInterval(() => {
    try {
      const stats = snapshotTree(pid);
      peakRssKb = Math.max(peakRssKb, stats.rssKb);
      lastCpuMs = Math.max(lastCpuMs, stats.cpuMs);
    } catch {
      // process may have exited
    }
  }, 100);
  const code = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(-1);
    }, 120000);
    child.once("exit", (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });
  clearInterval(sampler);
  const wallMs = performance.now() - started;
  const output = stdout.join("");
  const lines = output.trim().split("\n").filter(Boolean);
  let stats: RunStats | null = null;
  for (const line of lines.reverse()) {
    try {
      stats = JSON.parse(line) as RunStats;
      break;
    } catch {
      // skip non-JSON lines
    }
  }
  if (code === 0 && stats) {
    runtimeRecords.push({
      runtime,
      version,
      status: "pass",
      wallMs,
      cpuMs: lastCpuMs,
      rssMb: peakRssKb / 1024,
      newRows: stats.newRows,
      insertChangedRows: stats.insertChangedRows,
      dbWriteOps: stats.dbWriteOps,
      note: "same ts-core A round; fake Go requests=3",
    });
  } else {
    runtimeRecords.push({
      runtime,
      version,
      status: "fail",
      wallMs,
      cpuMs: lastCpuMs,
      rssMb: peakRssKb / 1024,
      newRows: 0,
      insertChangedRows: 0,
      dbWriteOps: 0,
      note: `exit=${String(code)} stderr=${stderr.join("").slice(-300)}`,
    });
  }
}

function csvEscape(value: unknown): string {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

function writeCsv(): void {
  const header = [
    "section",
    "candidate",
    "phase",
    "round",
    "wall_ms",
    "cpu_ms",
    "rss_mb",
    "db_write_ops",
    "db_rows_changed",
    "new_rows",
    "insert_changed_rows",
    "update_changed_rows",
    "subrequests",
    "request_bytes",
    "response_bytes",
    "metric",
    "value",
    "unit",
    "note",
  ];
  const rows: Record<string, unknown>[] = [];
  const push = (row: Record<string, unknown>) => rows.push(row);

  for (const record of roundRecords) {
    push({
      section: "round",
      candidate: record.candidate,
      phase: record.phase,
      round: record.round,
      wall_ms: record.wallMs.toFixed(2),
      cpu_ms: record.cpuMs.toFixed(2),
      rss_mb: record.rssMb.toFixed(2),
      db_write_ops: record.dbWriteOps,
      db_rows_changed: record.dbRowsChanged,
      new_rows: record.newRows,
      insert_changed_rows: record.insertChangedRows,
      update_changed_rows: record.updateChangedRows,
      subrequests: record.subrequests,
      request_bytes: record.requestBytes,
      response_bytes: record.responseBytes,
      note: `server_wall_ms=${record.serverWallMs.toFixed(2)}; ${record.note}`,
    });
  }

  const candidates = [...new Set(roundRecords.map((record) => record.candidate))];
  for (const candidate of candidates) {
    const measured = roundRecords.filter(
      (record) => record.candidate === candidate && record.phase === "measured",
    );
    const consecutive = roundRecords.filter(
      (record) => record.candidate === candidate && record.phase === "consecutive",
    );
    const metrics: [string, number, string][] = [
      ["wall_ms_median_measured", median(measured.map((record) => record.wallMs)), "ms"],
      ["cpu_ms_median_measured", median(measured.map((record) => record.cpuMs)), "ms"],
      ["rss_mb_median_measured", median(measured.map((record) => record.rssMb)), "MB"],
      ["wall_ms_median_consecutive", median(consecutive.map((record) => record.wallMs)), "ms"],
      ["cpu_ms_median_consecutive", median(consecutive.map((record) => record.cpuMs)), "ms"],
      ["new_rows_per_round", median(measured.map((record) => record.newRows)), ""],
      ["insert_changed_rows_per_round", median(measured.map((record) => record.insertChangedRows)), ""],
      ["update_changed_rows_per_round", median(measured.map((record) => record.updateChangedRows)), ""],
      ["db_write_ops_per_round", median(measured.map((record) => record.dbWriteOps)), ""],
      ["db_rows_changed_per_round", median(measured.map((record) => record.dbRowsChanged)), ""],
      ["subrequests_per_round", median(measured.map((record) => record.subrequests)), ""],
      ["measured_rounds", measured.length, ""],
      ["consecutive_rounds", consecutive.length, ""],
    ];
    for (const [metric, value, unit] of metrics) {
      push({
        section: "summary",
        candidate,
        phase: "measured",
        metric,
        value: value.toFixed(2),
        unit,
        note: "local proxy; not a platform verdict",
      });
    }
  }

  for (const contract of contractRecords) {
    for (const check of contract.result.checks) {
      push({
        section: "contract",
        candidate: contract.candidate,
        metric: check.name,
        value: check.status,
        note: check.detail.replaceAll("\n", " ").slice(0, 600),
      });
    }
    push({
      section: "contract",
      candidate: contract.candidate,
      metric: "table_count",
      value: String(contract.result.tables),
      unit: "tables",
      note: `unsupported_sql=${contract.result.unsupportedSql.length}`,
    });
  }

  for (const runtime of runtimeRecords) {
    push({
      section: "runtime",
      candidate: runtime.runtime,
      wall_ms: runtime.wallMs.toFixed(2),
      cpu_ms: runtime.cpuMs.toFixed(2),
      rss_mb: runtime.rssMb.toFixed(2),
      db_write_ops: runtime.dbWriteOps,
      new_rows: runtime.newRows,
      insert_changed_rows: runtime.insertChangedRows,
      metric: "same_core_round",
      value: runtime.status,
      note: `${runtime.version}; ${runtime.note}`,
    });
  }

  for (const hwpx of hwpxRecords) {
    push({
      section: "hwpx",
      candidate: hwpx.candidate,
      wall_ms: hwpx.wallMs.toFixed(2),
      cpu_ms: hwpx.cpuMs.toFixed(2),
      rss_mb: hwpx.rssMb.toFixed(2),
      metric: "hwpx_build",
      value: hwpx.status,
      note: `bytes=${hwpx.bytes}; sha256=${hwpx.sha256}; ${hwpx.note}`,
    });
  }

  for (const meta of metaRecords) {
    push({
      section: "meta",
      metric: meta.metric,
      value: meta.value,
      unit: meta.unit,
      note: meta.note,
    });
  }

  for (const error of errorRecords) {
    push({
      section: "error",
      candidate: error.candidate,
      metric: "candidate_error",
      value: "fail",
      note: error.message.replaceAll("\n", " ").slice(0, 800),
    });
  }

  const text =
    [header, ...rows.map((row) => header.map((key) => csvEscape(row[key])).join(","))].join("\n") +
    "\n";
  writeFileSync(CSV_PATH, text, "utf8");
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const fake = await startFakeGo();
  try {
  metaRecords.push(
    { metric: "date", value: new Date().toISOString().slice(0, 10), unit: "", note: "local measurement" },
    { metric: "core_hash", value: hashFiles(join(WEB0_ROOT, "ts-core"), (name) => CORE_FILES.has(name)), unit: "sha256", note: "business/contract core files only" },
    { metric: "fixture_hash", value: hashFiles(FIXTURE_DIR, (name) => name.endsWith(".json")), unit: "sha256", note: "38 api-v1 JSON files" },
    { metric: "node", value: process.version, unit: "", note: "measurement runner" },
    { metric: "platform", value: `${process.platform}-${process.arch}`, unit: "", note: "" },
    { metric: "fake_go_endpoint", value: "http://127.0.0.1:<ephemeral>/inference/v1/chat/completions", unit: "", note: "deterministic JSON; 8/16/12 KiB; fixed 200 ms; HTTP 200" },
    { metric: "wrangler", value: execFileSync(process.execPath, [join(WEB0_ROOT, "node_modules/wrangler/bin/wrangler.js"), "--version"], { encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } }).trim(), unit: "", note: "local only; metrics disabled" },
  );

  // SQLite contract (shared by VPS/VC local proxies).
  {
    const db = new SqliteDb(":memory:");
    try {
      await db.exec(readFileSync(DDL_PATH, "utf8"));
      const result = await runContractSuite(db);
      contractRecords.push({ candidate: "sqlite-node", result });
    } finally {
      db.close();
    }
  }

  try {
    await measureNode(fake);
    metaRecords.push({ metric: "vps_node_status", value: "pass", unit: "", note: "" });
  } catch (error) {
    errorRecords.push({ candidate: "vps-node", message: error instanceof Error ? error.message : String(error) });
  }

  try {
    await measureHwpxNode();
  } catch (error) {
    hwpxRecords.push({
      candidate: "node-hwpx",
      status: "fail",
      wallMs: 0,
      cpuMs: 0,
      rssMb: 0,
      bytes: 0,
      sha256: "",
      note: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    await measureVercelProxy(fake);
    metaRecords.push({ metric: "vercel_node_proxy_status", value: "pass", unit: "", note: "" });
  } catch (error) {
    errorRecords.push({
      candidate: "vercel-node-proxy",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    await measureCloudflare(fake);
    metaRecords.push({ metric: "cf_wrangler_d1_status", value: "pass", unit: "", note: "" });
  } catch (error) {
    errorRecords.push({
      candidate: "cf-wrangler-d1",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  // Bun and Deno: same ts-core, local platform binaries from npm devDependencies.
  for (const runtime of [
    { name: "bun", command: join(WEB0_ROOT, "node_modules/.bin/bun"), args: ["run", "ts-core/runtime-run.ts", fake.url, DDL_PATH] },
    { name: "deno", command: join(WEB0_ROOT, "node_modules/.bin/deno"), args: ["run", "--allow-read", "--allow-net", "--allow-env", "ts-core/runtime-run.ts", fake.url, DDL_PATH] },
  ]) {
    try {
      const version = execFileSync(runtime.command, ["--version"], { encoding: "utf8", cwd: WEB0_ROOT })
        .split("\n")[0]
        ?.trim() ?? "unknown";
      await runChildRuntime(runtime.command, runtime.args, runtime.name, version, fake);
    } catch (error) {
      runtimeRecords.push({
        runtime: runtime.name,
        version: "unknown",
        status: "fail",
        wallMs: 0,
        cpuMs: 0,
        rssMb: 0,
        newRows: 0,
        insertChangedRows: 0,
        dbWriteOps: 0,
        note: error instanceof Error ? error.message : String(error),
      });
    }
  }

  try {
    await measureHwpxBrowser();
  } catch (error) {
    hwpxRecords.push({
      candidate: "browser-bundle",
      status: "fail",
      wallMs: 0,
      cpuMs: 0,
      rssMb: 0,
      bytes: 0,
      sha256: "",
      note: error instanceof Error ? error.message : String(error),
    });
  }

  } catch (error) {
    errorRecords.push({
      candidate: "measure",
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await fake.stop().catch(() => undefined);
    writeCsv();
    const summary = {
      coreHash: metaRecords.find((record) => record.metric === "core_hash")?.value,
      fixtureHash: metaRecords.find((record) => record.metric === "fixture_hash")?.value,
      rounds: roundRecords,
      contracts: contractRecords,
      runtimes: runtimeRecords,
      hwpx: hwpxRecords,
      meta: metaRecords,
      errors: errorRecords,
    };
    writeFileSync(join(OUT_DIR, "measurements.json"), JSON.stringify(summary, null, 2), "utf8");

    const measuredCandidates = new Set(
      roundRecords.filter((record) => record.phase === "measured").map((record) => record.candidate),
    );
    const contractFailures = contractRecords.flatMap((contract) =>
      contract.result.checks
        .filter((check) => check.status === "fail")
        .map((check) => `${contract.candidate}:${check.name}`),
    );
    const tableFailures = contractRecords
      .filter((contract) => contract.result.tables !== 61)
      .map((contract) => `${contract.candidate}:tables=${contract.result.tables}`);
    const runtimeFailures = runtimeRecords
      .filter((runtime) => runtime.status !== "pass")
      .map((runtime) => runtime.runtime);
    const hwpxFailures = hwpxRecords
      .filter((record) => record.status !== "pass")
      .map((record) => record.candidate);
    const missingCandidates = ["vps-node", "vercel-node-proxy", "cf-wrangler-d1"].filter(
      (candidate) => !measuredCandidates.has(candidate),
    );
    const missingRuntimes = ["bun", "deno"].filter(
      (runtime) => !runtimeRecords.some((record) => record.runtime === runtime && record.status === "pass"),
    );
    const missingHwpx = ["node-hwpx", "cf-wrangler-d1", "browser-bundle"].filter(
      (candidate) => !hwpxRecords.some((record) => record.candidate === candidate && record.status === "pass"),
    );
    const failed =
      errorRecords.length > 0 ||
      contractFailures.length > 0 ||
      tableFailures.length > 0 ||
      runtimeFailures.length > 0 ||
      hwpxFailures.length > 0 ||
      missingCandidates.length > 0 ||
      missingRuntimes.length > 0 ||
      missingHwpx.length > 0;

    console.log(
      JSON.stringify(
        {
          csv: relative(WEB0_ROOT, CSV_PATH),
          records: roundRecords.length,
          errors: errorRecords,
          runtimes: runtimeRecords.map((runtime) => ({
            runtime: runtime.runtime,
            status: runtime.status,
          })),
          hwpx: hwpxRecords.map((record) => ({
            candidate: record.candidate,
            status: record.status,
            bytes: record.bytes,
          })),
          failures: {
            errorRecords: errorRecords.length,
            contractFailures,
            tableFailures,
            runtimeFailures,
            hwpxFailures,
            missingCandidates,
            missingRuntimes,
            missingHwpx,
          },
          exit_code: failed ? 1 : 0,
        },
        null,
        2,
      ),
    );
    if (failed) process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
