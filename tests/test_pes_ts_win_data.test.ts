// SEL-71, W1·W2 (decision 2026-11-11): the ts CLI stores report paths with `/` and writes generated text with LF on every OS, and it READS
// old data in both spellings — a 0.15 project.json written on Windows (backslash report paths, CRLF line ends, CRLF report files) gives the
// same result as the same project written on macOS / Linux. The fixture is made synthetic and OS-independent: a 0.15 project is built by
// the py CLI, then a Windows-style twin is derived from it by rewriting text only (so this runs the same on every runner).
import assert from "node:assert/strict";
import { cpSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { assert_posix_storage, d02_canon, norm_out } from "./helpers/compat_cases.ts";
import { dto_from_project_json, init_project, make_ctx, merge, pes, walk_files, type CompatCtx } from "./helpers/compat_env.ts";
import { PES_TS_FILE, answers_multiset, run_ts_cli, ts_seed_legacy, ts_view } from "./helpers/compat_ts.ts";
import { use_home_guard } from "./helpers/home_guard.ts";

use_home_guard();

const home_of = (ctx: CompatCtx) => ({ env: ctx.env, pes_home: ctx.pes_home, home_dir: ctx.home_dir });

function crlf(path: string): void {
  writeFileSync(path, readFileSync(path, "utf8").replace(/\r\n/g, "\n").replace(/\n/g, "\r\n"), "utf8");
}

/** The py-built project (LF, `/`) and a Windows-style twin: CRLF project.json + CRLF report files + backslash report paths. */
function twins(ctx: CompatCtx): { posix: string; windows: string } {
  const posix = init_project(ctx, "win-data", "합성 주제");
  assert.equal(pes(ctx, "round-start", posix, "plan").code, 0);
  merge(ctx, posix, "plan", [
    { id: 1, kind: "rq", title: "연구 질문", summary: "요약\n둘째 줄", sources: [{ url: "https://example.test/a", title: "출처 A" }] },
    { id: 2, kind: "topic", title: "범위", summary: "범위 요약", sources: [{ url: "https://example.test/b", title: "출처 B" }] },
  ]);
  assert.equal(pes(ctx, "report", posix, "plan").code, 0);
  // normalise what this OS's py wrote (on Windows py itself writes `\` and CRLF) into the POSIX form first
  const file = join(posix, "project.json");
  const data = JSON.parse(readFileSync(file, "utf8")) as any;
  for (const stage of Object.values<any>(data.stages)) for (const r of stage.reports ?? []) r.path = String(r.path).replace(/\\/g, "/");
  writeFileSync(file, JSON.stringify(data, null, 1), "utf8");
  for (const rel of walk_files(posix).filter((x) => /\.(md|html)$/.test(x) || x === "feedback.log")) {
    const full = join(posix, ...rel.split("/"));
    writeFileSync(full, readFileSync(full, "utf8").replace(/\r\n/g, "\n"), "utf8");
  }
  const windows = join(ctx.tmp, "win-data-win");
  cpSync(posix, windows, { recursive: true });
  const wfile = join(windows, "project.json");
  const wdata = JSON.parse(readFileSync(wfile, "utf8")) as any;
  let backslashed = 0;
  for (const stage of Object.values<any>(wdata.stages)) for (const r of stage.reports ?? []) (r.path = String(r.path).split("/").join("\\"), (backslashed += 1));
  assert.ok(backslashed >= 2, "the fixture has report paths to rewrite");
  writeFileSync(wfile, JSON.stringify(wdata, null, 1), "utf8");
  crlf(wfile);
  for (const rel of walk_files(windows).filter((x) => /\.(md|html)$/.test(x))) crlf(join(windows, ...rel.split("/")));
  assert.match(readFileSync(wfile, "utf8"), /\r\n/);
  assert.match(readFileSync(wfile, "utf8"), /reports\\\\plan\\\\report\.html/);
  return { posix, windows: windows };
}

test("fixture sanity: the Windows-style twin differs from the posix project only in line ends and report path separators", () => {
  const ctx = make_ctx("pes-win-fixture-");
  try {
    const { posix, windows } = twins(ctx);
    const a = readFileSync(join(posix, "project.json"), "utf8");
    const b = readFileSync(join(windows, "project.json"), "utf8");
    assert.notEqual(a, b);
    assert.equal(b.replace(/\r\n/g, "\n").split("\\\\").join("/"), a.split("\\\\").join("/"));
    assert.equal(walk_files(posix).join(), walk_files(windows).join());
  } finally {
    ctx.cleanup();
  }
});

test("old data: the importer reads the Windows-style twin into the same database state as the posix one (paths stored with `/`)", async () => {
  const ctx = make_ctx("pes-win-import-");
  const other = make_ctx("pes-win-import-b-");
  try {
    const { posix, windows } = twins(ctx);
    // two databases, two folders of the same name: the slug is the folder name
    const into_a = join(ctx.tmp, "a", "win-data");
    const into_b = join(other.tmp, "b", "win-data");
    cpSync(posix, into_a, { recursive: true });
    cpSync(windows, into_b, { recursive: true });
    await ts_seed_legacy(home_of(ctx), into_a);
    await ts_seed_legacy(home_of(other), into_b);
    const a = ts_view(home_of(ctx), "win-data");
    const b = ts_view(home_of(other), "win-data");
    assert.ok(a && b);
    const dto_a = d02_canon(dto_from_project_json(a.project, a.project.library ?? undefined));
    const dto_b = d02_canon(dto_from_project_json(b.project, b.project.library ?? undefined));
    assert.deepEqual(dto_b, dto_a, "backslash paths and CRLF read as the same project");
    for (const stage of Object.values<any>((dto_b as any).stages)) for (const r of stage.reports ?? []) assert.ok(!String(r.path).includes("\\"), `a report path read from old data must come out with "/": ${r.path}`);
    assert.deepEqual(answers_multiset(b.answers), answers_multiset(a.answers));
  } finally {
    ctx.cleanup();
    other.cleanup();
  }
});

/** The commands that only read: both twins must print the same thing (after the root names are normalised). */
const READS: string[][] = [["status"], ["digest", "plan"], ["show", "plan"], ["show", "plan", "1", "--fields", "title,summary,sources"], ["pending"]];

test("old data, read straight from the folder (no import): status / digest / show / pending print the same for the posix and the Windows-style twin, and as 0.15 does", () => {
  assert.ok(existsSync(PES_TS_FILE), "scripts/pes.ts does not exist yet — SEL-71 writes it");
  const ctx = make_ctx("pes-win-read-");
  try {
    const { posix, windows } = twins(ctx);
    for (const [command, ...rest] of READS) {
      const on = (folder: string, who: "ts" | "py") => {
        const args = [command as string, folder, ...rest];
        const run = who === "ts" ? run_ts_cli(ctx, args) : pes(ctx, ...args);
        const out = who === "ts" ? (run as ReturnType<typeof run_ts_cli>) : { status: (run as ReturnType<typeof pes>).code, stdout: (run as ReturnType<typeof pes>).out, stderr: (run as ReturnType<typeof pes>).err };
        assert.equal(out.status, 0, `${who} ${command}: ${out.stderr}`);
        return norm_out(out.stdout, { PROJECT: folder, HOME: ctx.home_dir, TMP: ctx.home.root });
      };
      const want = on(posix, "py");
      assert.deepEqual(on(posix, "ts"), want, `ts ${command} (posix twin) differs from 0.15`);
      assert.deepEqual(on(windows, "ts"), want, `ts ${command} (Windows-style twin) differs from the posix twin — old backslash/CRLF data must read the same`);
    }
  } finally {
    ctx.cleanup();
  }
});

test("old data → new writes: after reading the Windows-style project, ts `render`, `report`, `assemble`, `web` store `/` paths and write LF only (D10), on every OS", () => {
  assert.ok(existsSync(PES_TS_FILE), "scripts/pes.ts does not exist yet — SEL-71 writes it");
  const ctx = make_ctx("pes-win-write-");
  try {
    const { windows } = twins(ctx);
    for (const args of [["render", windows], ["report", windows, "plan"], ["assemble", windows], ["web", windows]]) {
      const run = run_ts_cli(ctx, args);
      assert.ok(run.status === 0 || args[0] === "assemble" || args[0] === "web", `${args[0]}: ${run.stderr}`);
    }
    // reports/plan/report.* and index.html are (re)generated by ts: LF, no CR
    for (const rel of ["reports/plan/report.md", "reports/plan/report.html"]) {
      const full = join(windows, ...rel.split("/"));
      assert.ok(existsSync(full) && statSync(full).size > 0, rel);
      assert.ok(!readFileSync(full, "utf8").includes("\r"), `${rel}: the ts CLI wrote CR`);
    }
    assert_posix_storage(windows, "win-data");
    const view = ts_view(home_of(ctx), "win-data");
    // a project that was never imported is served from its folder: the state may still be project.json — then its report paths must have become "/"
    const reports = view !== undefined ? Object.values<any>(view.project.stages).flatMap((s) => s.reports ?? []) : Object.values<any>((JSON.parse(readFileSync(join(windows, "project.json"), "utf8")) as any).stages).flatMap((s) => s.reports ?? []);
    assert.ok(reports.length >= 2);
    for (const r of reports) assert.ok(!String(r.path).includes("\\"), `stored report path: ${r.path}`);
    assert.ok(readdirSync(windows).includes("reports"));
  } finally {
    ctx.cleanup();
  }
});
