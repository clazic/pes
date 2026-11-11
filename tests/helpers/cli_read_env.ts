// Harness for the CLI read / report / doctor tests (stage 2 PR16, SEL-49). Everything is synthetic.
//
// Builds on cli_write_env.ts (same isolated HOME / USERPROFILE / PES_HOME, same DB bootstrap) and adds:
//   - run_cli(): runs `node scripts/pes.ts` (behind the TS child guard) in the isolated HOME — SEL-74: the 0.15 Python CLI is gone
//   - normalize(): output normalisation (roots in every spelling, timestamps, epoch, uuid)
//   - RICH_LEGACY: a legacy project.json with items, sources, notes, a write stage and unprocessed answers
//   - shell_words(): a tiny POSIX-style word splitter, so a printed shell command can be checked without a shell
//     (works the same on Windows CI, where no `sh` can be assumed)

import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

import { SLUG, type CliEnv, type CliResult } from "./cli_write_env.ts";
import { run_ts_cli, run_ts_cli_async } from "./compat_ts.ts";
import { FIXTURES } from "./legacy_env.ts";

/** Folder of the recorded 0.15 reports (tests/fixtures/legacy_reports/README.md): what `pes.py report` of 0.15 made from the `full` fixture, frozen. */
export const LEGACY_REPORTS = join(FIXTURES, "..", "legacy_reports");

/**
 * Lays the 0.15 record `name` over a folder that is a copy of the `full` fixture: the project.json 0.15 saved after its `report` run and
 * the two report files it made (`작성 …` time line fixed to 2001-01-01 00:00). The 0.15 code that made them is gone (SEL-74); the record is frozen.
 */
export function overlay_real_report(dir: string, name: string): void {
  const rec = join(LEGACY_REPORTS, name);
  cpSync(join(rec, "project.json"), join(dir, "project.json"));
  cpSync(join(rec, "reports"), join(dir, "reports"), { recursive: true });
}

/**
 * `full` fixture copied into the PES home of `c` as `slug`, project.json edited at text level by `edit` (the same edit the record was made
 * with — asserted against the record's input.project.json, so a changed edit fails loudly instead of testing something else), then the
 * 0.15 report record laid over it.
 */
export function legacy_home_with_real_report(c: { env: { home: { env: Record<string, string | undefined> } } }, slug: string, edit: (text: string) => string): string {
  const dir = join(c.env.home.env.PES_HOME as string, slug);
  cpSync(join(FIXTURES, "full"), dir, { recursive: true });
  const json = join(dir, "project.json");
  const edited = edit(readFileSync(json, "utf8").replace('"slug": "synthetic-legacy-full"', `"slug": "${slug}"`));
  const input = readFileSync(join(LEGACY_REPORTS, slug, "input.project.json"), "utf8");
  assert.deepEqual(JSON.parse(edited), JSON.parse(input), `${slug}: the edit no longer makes the project.json the 0.15 record was made from (tests/fixtures/legacy_reports/README.md)`);
  overlay_real_report(dir, slug);
  return dir;
}

/** One recorded 0.15 output (tests/fixtures/golden/README.md): `{ "<label>": value }`. */
export function golden<T = Record<string, { status: number | null; stdout: string; stderr_last: string }>>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, "..", "golden", `${name}.json`), "utf8")) as T;
}

/**
 * Runs `args` and checks exit code, normalised stdout (LF, roots → <ROOT>) and the last stderr line against the recorded 0.15 output `rec`.
 * A stack trace is never an answer. `rec` = golden(...)[label].
 */
export function expect_same_as_015(c: HomeLike, args: string[], rec: { status: number | null; stdout: string; stderr_last: string } | undefined, label: string, opts: RunOptions = {}): CliResult {
  assert.ok(rec !== undefined, `${label}: no 0.15 record for ${JSON.stringify(args)}`);
  const roots = [c.env.home.root];
  const res = run_cli(c, args, opts);
  assert.equal(res.status, rec.status, `${label}: exit code`);
  assert.equal(normalize(res.stdout.replace(/\r\n/g, "\n"), roots), rec.stdout, `${label}: stdout`);
  const last = normalize(res.stderr, roots).trim().split("\n").pop() ?? "";
  assert.equal(last, rec.stderr_last, `${label}: last stderr line`);
  return res;
}

/** Every spelling of one root: as is, the Windows long name (8.3 RUNNER~1), and the doubled-backslash python repr. */
export function root_forms(root: string): string[] {
  const forms = new Set([root]);
  try {
    forms.add(realpathSync.native(root));
  } catch {
    // a path that does not exist keeps only its own spelling
  }
  for (const form of [...forms]) if (form.includes("\\")) forms.add(form.split("\\").join("\\\\"));
  return [...forms];
}

export function normalize(text: string, roots: string[]): string {
  let out = text;
  const all = roots.flatMap(root_forms);
  for (const root of all.sort((x, y) => y.length - x.length)) out = out.split(root).join("<ROOT>");
  // a path under a root is printed with the native separator (Windows: '\\'); the 0.15 records were made on macOS ('/').
  // Only the part right after <ROOT> is folded — the same path, written two ways (PR #58 windows run 43091570453).
  out = out.replace(/<ROOT>[^\s"'`,)\]]*/g, (path) => path.replace(/\\\\?/g, "/"));
  return out
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?/g, "<TS>")
    .replace(/\d{8}-\d{6}/g, "<STAMP>")
    .replace(/\b1[0-9]{9}(\.[0-9]+)?\b/g, "<EPOCH>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<UUID>");
}

export interface RunOptions {
  extra?: Record<string, string | undefined>;
  cwd?: string;
  timeout?: number;
  /** Text sent to the child's stdin (UTF-8). Default: nothing. */
  input?: string;
  /** Exact PATH for the child. `doctor` defaults to doctor_path() (a narrow PATH, see below) unless this is given. */
  path?: string;
  /** hub-block exceptions: ports of stand-ins the TEST started itself (everything else in 8760~8775 stays blocked) */
  allow_hub_ports?: number[];
  /** the command starts a process (hub · serve · open): the permission model must let it */
  allow_child?: boolean;
  /** another pes.ts (a copy of the scripts folder below the isolated home, e.g. with CRLF templates) */
  script?: string;
}

/** A file named `name` (plus PATHEXT extensions on Windows) in the caller's real PATH; no `which`, no shell. */
export function find_on_path(name: string): string | undefined {
  const raw = process.env.PATH ?? process.env.Path ?? "";
  const exts = process.platform === "win32" ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT").toLowerCase().split(";").filter(Boolean)] : [""];
  for (const dir of raw.split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const file = join(dir, name + ext);
      if (existsSync(file)) return file;
    }
  }
  return undefined;
}

let narrow_cache: string | undefined;

/**
 * The PATH the doctor tests run with: the folders of node, tail and grep (doctor needs them) and of the
 * owner-lookup tool (lsof on macOS, ss on Linux, netstat on Windows) — and nothing else. External CLIs the doctor probes
 * (ego-browser, kosis, vworld, korean-law) are therefore "not installed", so a doctor run starts no slow tool processes.
 * The rows for those tools keep their form; only their value (missing) is fixed by this PATH.
 */
export function doctor_path(): string {
  if (narrow_cache !== undefined) return narrow_cache;
  const tools = [process.platform === "darwin" ? "lsof" : process.platform === "win32" ? "netstat" : "ss", "tail", "grep"];
  const dirs = new Set<string>([dirname(process.execPath)]);
  for (const tool of tools) {
    const found = find_on_path(tool);
    if (found !== undefined) dirs.add(dirname(found));
  }
  narrow_cache = [...dirs].join(delimiter);
  return narrow_cache;
}

/** Anything that carries an isolated home: a CliEnv, or `{ env: { home } }` around a bare isolated_home(). */
export interface HomeLike {
  env: { home: { readonly root: string; readonly env: Record<string, string | undefined> } };
}

/** `node scripts/pes.ts ...` (guarded) in the isolated HOME of `c`. PES_OWNER / PES_TOKEN never leak in from the caller; `opts.extra` may name them. */
export function run_cli(c: HomeLike, args: string[], opts: RunOptions = {}): CliResult {
  const root = c.env.home.root;
  const narrow_bin = join(root, "bin");
  mkdirSync(narrow_bin, { recursive: true });
  const base: Record<string, string | undefined> = { ...c.env.home.env, PES_OWNER: undefined, PES_TOKEN: undefined };
  for (const key of ["PES_TOKEN", "PES_DB_CORE", "PES_HUB_PORTS", "PES_LOCAL_SESSION_SECRET"]) delete base[key];
  assert.equal(base.HOME, c.env.home.env.HOME, "the CLI runs in the isolated HOME");
  assert.equal(base.USERPROFILE, c.env.home.env.HOME);
  assert.ok(base.PES_HOME !== undefined && base.PES_HOME.length > 0, "PES_HOME is set (isolated)");
  const { PES_DB_CORE: _flag, ...extra } = opts.extra ?? {};
  const narrow = opts.path ?? (args[0] === "doctor" ? doctor_path() : undefined);
  const env: Record<string, string | undefined> = { ...extra };
  if (narrow !== undefined) {
    for (const key of Object.keys(base)) if (key.toLowerCase() === "path") delete base[key]; // Windows: Path / PATH
    env.PATH = narrow;
  }
  const run = run_ts_cli({ home: { root }, env: base, narrow_bin }, args, {
    env,
    cwd: opts.cwd ?? root,
    timeout_ms: opts.timeout ?? 120_000,
    input: opts.input,
    allow_hub_port: opts.allow_hub_ports,
    // doctor looks for external tools and for the owner of a held port (child processes) in the narrowed PATH
    ...(narrow !== undefined ? { extra_read: narrow.split(delimiter).filter((x) => x !== ""), allow_child_process: true } : {}),
    ...(opts.allow_child === true ? { allow_child_process: true } : {}),
    // the permission model resolves the main script by its real path (macOS /var → /private/var)
    ...(opts.script !== undefined ? { script: realpathSync.native(opts.script) } : {}),
  });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

/** The async twin of run_cli: genuinely concurrent children (the same guard, the same isolated HOME). */
export async function run_cli_async(c: HomeLike, args: string[], opts: Pick<RunOptions, "extra" | "timeout"> = {}): Promise<CliResult> {
  const root = c.env.home.root;
  const narrow_bin = join(root, "bin");
  mkdirSync(narrow_bin, { recursive: true });
  const base: Record<string, string | undefined> = { ...c.env.home.env, PES_OWNER: undefined, PES_TOKEN: undefined };
  for (const key of ["PES_TOKEN", "PES_DB_CORE", "PES_HUB_PORTS", "PES_LOCAL_SESSION_SECRET"]) delete base[key];
  const { PES_DB_CORE: _flag, ...extra } = opts.extra ?? {};
  const run = await run_ts_cli_async({ home: { root }, env: base, narrow_bin }, args, { env: extra, cwd: root, timeout_ms: opts.timeout ?? 120_000 });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

/** The same synthetic legacy project.json for every comparison (topic equals the DB project's topic). */
export const RICH_TOPIC = "합성 파일 주제";

export function rich_legacy(slug: string): Record<string, unknown> {
  return {
    pes: 1,
    topic: RICH_TOPIC,
    slug,
    created: "2026-02-01",
    current: "plan",
    processed: ["plan-R1-20260201-100000.json"],
    executive_summary: "합성 요약문",
    conclusion: "합성 결론",
    notes: [
      { time: "2026-02-02 09:00", stage: "plan", text: "합성 인계 메모 하나" },
      { time: "2026-02-02 09:30", stage: "plan", text: "합성 인계 메모 둘" },
    ],
    stages: {
      plan: {
        status: "active",
        round: 1,
        approved_at: null,
        summary: "합성 기획 요약",
        items: [
          {
            id: 1,
            title: "합성 기획 항목 하나",
            kind: "topic",
            status: "done",
            summary: "합성 요약 하나",
            confidence: "high",
            updated_round: 1,
            sources: [
              { title: "합성 출처 A", url: "https://example.invalid/a", method: "law", date: "2026-01-02" },
              { title: "합성 출처 B", url: "https://example.invalid/b", method: "search" },
            ],
          },
          { id: 2, title: "합성 기획 항목 둘", kind: "topic", status: "deepen", summary: "합성 요약 둘", updated_round: 1 },
        ],
      },
      write: {
        status: "active",
        round: 1,
        items: [
          {
            id: 1,
            title: "1장",
            kind: "section",
            status: "done",
            order: 1,
            details: "첫 장 본문입니다 [^1] 그리고 [^2] 끝.",
            sources: [
              { title: "합성 출처 A", url: "https://example.invalid/a", method: "law", date: "2026-01-02" },
              { title: "합성 출처 C", url: "https://example.invalid/c", method: "search" },
            ],
          },
        ],
      },
    },
  };
}

export function write_legacy(folder: string, value: unknown): string {
  mkdirSync(folder, { recursive: true });
  const file = join(folder, "project.json");
  writeFileSync(file, JSON.stringify(value, null, 1), "utf8");
  return file;
}

/** One unprocessed answer file (v0.15 `pending` lists it). */
export function write_pending_answer(folder: string, name: string): string {
  const dir = join(folder, "feedback");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, JSON.stringify({ stage: "plan", round: 1, kind: "feedback", text: "합성 답 한 줄", answers: {} }), "utf8");
  return file;
}

/** POSIX-ish word splitting: plain words, 'single', "double" quotes and backslash escapes. */
export function shell_words(line: string): string[] {
  const words: string[] = [];
  let cur = "";
  let open = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else cur += ch;
    } else if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "\\" && i + 1 < line.length && '"\\$`'.includes(line[i + 1]!)) cur += line[++i]!;
      else cur += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      open = true;
    } else if (ch === "\\" && i + 1 < line.length) {
      cur += line[++i]!;
      open = true;
    } else if (/\s/.test(ch)) {
      if (open || cur.length > 0) words.push(cur);
      cur = "";
      open = false;
    } else if (ch === "|") {
      if (open || cur.length > 0) words.push(cur);
      words.push("|");
      cur = "";
      open = false;
    } else {
      cur += ch;
      open = true;
    }
  }
  assert.equal(quote, null, `unbalanced quote in: ${line}`);
  if (open || cur.length > 0) words.push(cur);
  return words;
}

export function parent_of(path: string): string {
  return dirname(path);
}

/** Minimal legacy project.json with the DB project's topic (for side-by-side runs). */
export function plain_json_legacy(slug: string): Record<string, unknown> {
  return { pes: 1, topic: RICH_TOPIC, slug, current: "plan", processed: [], notes: [], stages: {} };
}

// ---------------------------------------------------------------------------
// Shared by the test_cli_read_*.test.ts files

/** Read a v0.15-written file with CRLF (Windows text mode) normalised to LF. Only the line ending is normalised. */
export function read_lf(path: string): string {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}


export function ok(res: CliResult, what: string): CliResult {
  assert.equal(res.status, 0, `${what}: exit ${res.status}\n${res.stderr}${res.stdout}`);
  assert.doesNotMatch(res.stderr, /Traceback/, `${what}: 스택 추적이 아니라 분명한 메시지여야 한다`);
  return res;
}

export function write_json(c: { env: { home: { root: string } } }, name: string, value: unknown): string {
  const file = join(c.env.home.root, name);
  writeFileSync(file, JSON.stringify(value), "utf8");
  return file;
}

export const PLAN_ITEMS = [
  {
    id: 1,
    kind: "topic",
    title: "합성 기획 항목 하나",
    summary: "합성 요약 하나",
    confidence: "high",
    status: "done",
    sources: [
      { title: "합성 출처 A", url: "https://example.invalid/a", method: "law", date: "2026-01-02" },
      { title: "합성 출처 B", url: "https://example.invalid/b", method: "search" },
    ],
  },
  { id: 2, kind: "topic", title: "합성 기획 항목 둘", summary: "합성 요약 둘", status: "deepen" },
];

export const WRITE_ITEMS = [
  {
    id: 1,
    kind: "section",
    title: "1장",
    order: 1,
    status: "done",
    details: "첫 장 본문입니다 [^1] 그리고 [^2] 끝.",
    sources: [
      { title: "합성 출처 A", url: "https://example.invalid/a", method: "law", date: "2026-01-02" },
      { title: "합성 출처 C", url: "https://example.invalid/c", method: "search" },
    ],
  },
];

/** 같은 합성 쓰기를 한 환경(DB)에 한다. */
export function seed(c: CliEnv): void {
  const run = (args: string[]) => ok(run_cli(c, args), args.join(" "));
  run(["round-start", SLUG, "plan"]);
  run(["merge", SLUG, "plan", write_json(c, "seed-plan.json", PLAN_ITEMS)]);
  run(["merge", SLUG, "write", write_json(c, "seed-write.json", WRITE_ITEMS)]);
  run(["note", SLUG, "합성 인계 메모 하나"]);
  run(["note", SLUG, "합성 인계 메모 둘"]);
}

export function plain_legacy(slug: string): Record<string, unknown> {
  return { pes: 1, topic: RICH_TOPIC, slug, current: "plan", processed: [], notes: [], stages: {} };
}

export function folder_of(c: CliEnv, slug: string): string {
  return join(c.env.home.env.PES_HOME as string, slug);
}

/**
 * import 직후 배치가 staging 이어야 한다. 아니면(Windows CI 에서 간헐로 failed 배치가 났다) 원인 추적용으로 배치 보고서(문제 항목·parse 오류)와
 * project.json 의 크기·앞 300바이트를 메시지에 담는다. 단언 자체는 그대로 imp.state === "staging" 이다.
 */
export function expect_staging(imp: { state: string; batch_id: string; report: { entries: Array<{ category: string; path: string; key?: string; detail?: unknown }> } }, dir: string, what: string): void {
  if (imp.state === "staging") return;
  let head = "(project.json 을 읽지 못함)";
  try {
    const bytes = readFileSync(join(dir, "project.json"));
    head = `크기 ${bytes.byteLength}바이트, 앞 300바이트: ${JSON.stringify(bytes.subarray(0, 300).toString("utf8"))}`;
  } catch (error) {
    head = `project.json 읽기 오류: ${String(error)}`;
  }
  const entries = imp.report.entries.filter((e) => ["parse_error", "missing_file", "quarantined", "unmapped_input"].includes(e.category));
  assert.equal(
    imp.state,
    "staging",
    `${what}: import 가 staging 이 아니라 ${imp.state} (배치 ${imp.batch_id})\n배치 보고서 항목 ${imp.report.entries.length}개, 문제 항목: ${JSON.stringify(entries, null, 1)}\n${head}`,
  );
}
