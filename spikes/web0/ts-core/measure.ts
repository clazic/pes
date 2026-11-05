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
import { measureTree, snapshotTree } from "./process-stats.ts";
import { applyDdl, findD1Sqlite, freePort, startWranglerDev, WEB0_ROOT } from "./wrangler.ts";

const DDL_PATH = fileURLToPath(new URL("../../../docs/plan/schemas/stage-1-ddl-draft.sql", import.meta.url));
const FIXTURE_DIR = fileURLToPath(new URL("../../../docs/plan/fixtures/api-v1/", import.meta.url));
const OUT_DIR = fileURLToPath(new URL("./out/", import.meta.url));
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
  insertedRows: number;
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
  insertedRows: number;
  dbWriteOps: number;
  note: string;
}

interface NamedContract {
  candidate: string;
  result: ContractResult;
}

interface RoundPayload {
  stats: RunStats;
  serverWallMs: number;
}

const roundRecords: RoundRecord[] = [];
const contractRecords: NamedContract[] = [];
const runtimeRecords: RuntimeRecord[] = [];
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
    insertedRows: payload.stats.insertedRows,
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
  db.close();
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
    const timeout = setTimeout(() => reject(new Error("vc server start timeout")), 30000);
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
  });
  return { child, url };
}

async function postRound(url: string): Promise<RoundPayload> {
  const response = await fetch(`${url}/api/v1/_spike/round`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
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
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 5000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
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
  } finally {
    await dev.stop();
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
      insertedRows: stats.insertedRows,
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
      insertedRows: 0,
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
    "inserted_rows",
    "subrequests",
    "request_bytes",
    "response_bytes",
    "metric",
    "value",
    "unit",
    "note",
  ];
  const rows: string[][] = [];
  for (const record of roundRecords) {
    rows.push([
      "round",
      record.candidate,
      record.phase,
      String(record.round),
      record.wallMs.toFixed(2),
      record.cpuMs.toFixed(2),
      record.rssMb.toFixed(2),
      String(record.dbWriteOps),
      String(record.dbRowsChanged),
      String(record.insertedRows),
      String(record.subrequests),
      String(record.requestBytes),
      String(record.responseBytes),
      "",
      "",
      "",
      `server_wall_ms=${record.serverWallMs.toFixed(2)}; ${record.note}`,
    ]);
  }
  const candidates = [...new Set(roundRecords.map((record) => record.candidate))];
  for (const candidate of candidates) {
    const measured = roundRecords.filter(
      (record) => record.candidate === candidate && record.phase === "measured",
    );
    const consecutive = roundRecords.filter(
      (record) => record.candidate === candidate && record.phase === "consecutive",
    );
    for (const [metric, value] of [
      ["wall_ms_median_measured", median(measured.map((record) => record.wallMs))],
      ["cpu_ms_median_measured", median(measured.map((record) => record.cpuMs))],
      ["rss_mb_median_measured", median(measured.map((record) => record.rssMb))],
      ["wall_ms_median_consecutive", median(consecutive.map((record) => record.wallMs))],
      ["cpu_ms_median_consecutive", median(consecutive.map((record) => record.cpuMs))],
      ["inserted_rows_per_round", median(measured.map((record) => record.insertedRows))],
      ["db_write_ops_per_round", median(measured.map((record) => record.dbWriteOps))],
      ["subrequests_per_round", median(measured.map((record) => record.subrequests))],
      ["measured_rounds", measured.length],
      ["consecutive_rounds", consecutive.length],
    ] as [string, number][]) {
      rows.push([
        "summary",
        candidate,
        "measured",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        metric,
        value.toFixed(2),
        metric.includes("rss") ? "MB" : metric.includes("wall") || metric.includes("cpu") ? "ms" : "",
        "local proxy; not a platform verdict",
      ]);
    }
  }
  for (const contract of contractRecords) {
    for (const check of contract.result.checks) {
      rows.push([
        "contract",
        contract.candidate,
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        check.name,
        check.status,
        "",
        check.detail.replaceAll("\n", " ").slice(0, 600),
      ]);
    }
    rows.push([
      "contract",
      contract.candidate,
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "table_count",
      String(contract.result.tables),
      "tables",
      `unsupported_sql=${contract.result.unsupportedSql.length}`,
    ]);
  }
  for (const runtime of runtimeRecords) {
    rows.push([
      "runtime",
      runtime.runtime,
      "",
      "",
      runtime.wallMs.toFixed(2),
      runtime.cpuMs.toFixed(2),
      runtime.rssMb.toFixed(2),
      String(runtime.dbWriteOps),
      "",
      String(runtime.insertedRows),
      "",
      "",
      "",
      "same_core_round",
      runtime.status,
      "",
      `${runtime.version}; ${runtime.note}`,
    ]);
  }
  for (const meta of metaRecords) {
    rows.push([
      "meta",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      meta.metric,
      meta.value,
      meta.unit,
      meta.note,
    ]);
  }
  for (const error of errorRecords) {
    rows.push([
      "error",
      error.candidate,
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "candidate_error",
      "fail",
      "",
      error.message.replaceAll("\n", " ").slice(0, 800),
    ]);
  }
  const text = [header, ...rows].map((row) => row.map(csvEscape).join(",")).join("\n") + "\n";
  writeFileSync(CSV_PATH, text, "utf8");
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const fake = await startFakeGo();
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
    await db.exec(readFileSync(DDL_PATH, "utf8"));
    const result = await runContractSuite(db);
    db.close();
    contractRecords.push({ candidate: "sqlite-node", result });
  }

  try {
    await measureNode(fake);
    metaRecords.push({ metric: "vps_node_status", value: "pass", unit: "", note: "" });
  } catch (error) {
    errorRecords.push({ candidate: "vps-node", message: error instanceof Error ? error.message : String(error) });
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
        insertedRows: 0,
        dbWriteOps: 0,
        note: error instanceof Error ? error.message : String(error),
      });
    }
  }

  await fake.stop();
  writeCsv();
  const summary = {
    coreHash: metaRecords.find((record) => record.metric === "core_hash")?.value,
    fixtureHash: metaRecords.find((record) => record.metric === "fixture_hash")?.value,
    rounds: roundRecords,
    contracts: contractRecords,
    runtimes: runtimeRecords,
    meta: metaRecords,
    errors: errorRecords,
  };
  writeFileSync(join(OUT_DIR, "measurements.json"), JSON.stringify(summary, null, 2), "utf8");
  console.log(JSON.stringify({ csv: relative(WEB0_ROOT, CSV_PATH), records: roundRecords.length, errors: errorRecords, runtimes: runtimeRecords.map((runtime) => ({ runtime: runtime.runtime, status: runtime.status })) }, null, 2));
}

await main();
