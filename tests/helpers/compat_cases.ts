// E01~E15 case runner (SEL-70, PR26a): cases.json (the table) → a normalised record on one target → compared with the stored
// 0.15 baseline (tests/fixtures/compat/baseline/<id>.json).
//
//   record = { steps: [...], dto?, files }       everything already through N1~N8, so equal records mean equal behaviour
//
// Baseline update is explicit: PES_COMPAT_UPDATE=1 rewrites the baseline files of the cases that ran (and only those). A normal run
// never writes them. `assert_case(target, id)` is the one call a test makes.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  FIXTURES,
  KNOWN_DIFFS,
  REPO,
  ServeProcess,
  copy_dir,
  dto_from_project_json,
  make_ctx,
  make_serve_home,
  move_dir,
  normalized_dto,
  project_json,
  read_json,
  read_state_dto,
  run_pes,
  run_setup,
  ts_gate,
  synthetic_project,
  touch,
  walk_files,
  write_json,
  type CompatCtx,
  type Target,
} from "./compat_env.ts";
import { answers_multiset, ts_age_lease, ts_cli_exists, ts_seed_feedback, ts_seed_legacy, ts_rename_slug, ts_view } from "./compat_ts.ts";
import { dropped_digests, lines, n1_json, n1_time, n10_apply, n10_checks, n10_files, n10_override, n12_stdlib_error_page, n2_paths, n3_json, n6_html, n7_text, n8_console, n9_text_hash, stderr_kind, type Roots } from "./compat_normalize.ts";

export interface CaseDef {
  id: string;
  title: string;
  section: string;
  group: "A" | "B" | "C";
  kind: "cli" | "http" | "setup";
  criteria: string;
  diffs: string[];
  ts: { status: "not_yet" | "implemented" };
  steps: Record<string, any>[];
  project: string | null;
  /** "count": only the number of produced answer files is recorded (their names carry a race-dependent suffix) */
  files?: "count";
  /** parts of the 7.4 row that are deliberately not run automatically, with the reason */
  excluded?: { what: string; why: string }[];
  /** what still differs between OSes / PCs for this case and how the single baseline copes (normalised, excluded, or moved to the temp HOME) */
  os_notes?: { what: string; handling: string; why: string }[];
  /**
   * Windows (or other OS) values that 0.15 really stores or prints differently — kept, not normalised away (tests/README.md,
   * "Windows 0.15 차이"). Keyed by `process.platform`; each entry replaces values of the baseline record on that OS only.
   */
  os_overrides?: Record<string, OsOverride>;
}

export interface OsOverride {
  /** README list item this belongs to */
  item: string;
  what: string;
  why: string;
  edits: OsEdit[];
}

/** `at`: path into the record. `value` replaces what is there; `json_set` (the target is a JSON text) sets keys inside it. */
export type OsEdit = { at: (string | number)[]; value: unknown } | { at: (string | number)[]; json_set: Record<string, unknown> };

export interface CaseTable {
  doc: string;
  ts_not_yet_reason: string;
  cases: CaseDef[];
}

/** The 7.4 table E01~E15. */
export function load_table(): CaseTable {
  return JSON.parse(readFileSync(join(FIXTURES, "cases.json"), "utf8")) as CaseTable;
}

/**
 * The CLI contract table X01~X05 (SEL-71): the 38 command names, argument counts, missing project, bad stage / file / JSON, the
 * commands that need no project. Same runner, same normalisers, own baselines (baseline/X0n.json, made by the 0.15 target).
 */
export function load_contract_table(): CaseTable {
  return JSON.parse(readFileSync(join(FIXTURES, "contract.json"), "utf8")) as CaseTable;
}

export function all_cases(): CaseDef[] {
  return [...load_table().cases, ...load_contract_table().cases];
}

export function case_def(id: string): CaseDef {
  const found = all_cases().find((c) => c.id === id);
  assert.ok(found, `unknown case ${id}`);
  return found;
}

export function baseline_path(id: string): string {
  return join(FIXTURES, "baseline", `${id}.json`);
}

export interface CaseRecord {
  id: string;
  steps: unknown[];
  dto: unknown;
  files: Record<string, string>;
  /** D03 cases only: the answers as a sorted multiset of {stage, round, kind, text} */
  answers?: unknown[];
}

export type CaseOutcome = { kind: "ran"; record: CaseRecord } | { kind: "not_yet"; reason: string };

// ---------------------------------------------------------------- placeholders and normalisation helpers
function substitute(value: string, ctx: CompatCtx): string {
  return value.replace(/\{P\}/g, ctx.project()).replace(/\{T\}/g, ctx.tmp).replace(/\{R\}/g, ctx.pes_home).replace(/\{PES\}/g, REPO);
}

function sub_deep(value: unknown, ctx: CompatCtx): unknown {
  if (typeof value === "string") return substitute(value, ctx);
  if (Array.isArray(value)) return value.map((v) => sub_deep(v, ctx));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value as object).map(([k, v]) => [k, sub_deep(v, ctx)]));
  return value;
}

function ports(text: string): string {
  return text.replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:<PORT>").replace(/localhost:\d+/g, "localhost:<PORT>");
}

/** `(PES 0.15.6)` in `setup mark` is the plugin version: it moves with every release, so the comparison must not pin it. */
function versions(text: string): string {
  return text.replace(/\(PES \d+\.\d+\.\d+(?:[-+][\w.]+)?\)/g, "(PES <VER>)");
}

/**
 * The usage text names how the CLI is started (`python3 -I pes.py <명령> …` on 0.15, `node scripts/pes.ts <명령> …` on ts). That one
 * word is the only intended difference of the usage page — the rest, every command line, must be equal.
 */
function runner(text: string): string {
  return text.replace(/^사용: (?:python3 -I pes\.py|node scripts\/pes\.ts) </gm, "사용: <RUN> <");
}

export function norm_out(text: string, roots: Roots): string[] {
  return lines(runner(versions(ports(n8_console(text, roots)))));
}

// A python `repr` doubles backslashes; N2 handles it. Python-only wording that is part of the 0.15 contract stays as is.

function post_process(post: string | undefined, stdout: string, roots: Roots): string[] {
  if (post === undefined) return norm_out(stdout, roots);
  const data = JSON.parse(stdout) as any[];
  if (post === "setup_stable") {
    // Only rows that no machine can change. ego-browser is NOT one of them: find_tool also looks in /opt/homebrew/bin and
    // /usr/local/bin (macOS) and below %LOCALAPPDATA% (Windows), outside the narrowed PATH. git / node / the CLIs are likewise
    // per machine. `python` is the interpreter running the child; the three keys come from the isolated, empty ~/.pes.
    const STABLE = ["python", "key-kosis", "key-vworld", "key-law"];
    const valid = new Set(["ok", "missing", "user", "optional", "key"]);
    assert.ok(data.every((row) => valid.has(row.state)), "setup check: unknown state name");
    return [
      n3_json({
        names: data.map((row) => row.name),
        groups: data.map((row) => row.group),
        keys_per_row: [...new Set(data.flatMap((row) => Object.keys(row)))].sort(),
        stable: Object.fromEntries(data.filter((row) => STABLE.includes(row.name)).map((row) => [row.name, row.state])),
      }),
    ];
  }
  if (post === "doctor_schema") {
    const levels = new Set(["ok", "info", "warn", "bad"]);
    assert.ok(data.every((row) => levels.has(row.level)), "doctor: unknown level");
    // 도구 rows: per PC (not compared). Every other row — environment, server, project — is compared whole: group, level, title,
    // detail, fixable. The server rows are the same on every PC because the child cannot reach ports 8760~8775 (HUB_BLOCK, applied to every pes.py child).
    const text = (value: unknown): string => n1_time(n2_paths(String(value ?? ""), roots)).replace(/Python \d+\.\d+\.\d+/, "Python <VER>");
    const stable = data
      .filter((row) => row.group !== "도구")
      .map((row) => ({ group: row.group, level: row.level, title: text(row.title), detail: text(row.detail), fixable: row.fixable }));
    return [
      n3_json({
        keys_per_row: [...new Set(data.flatMap((row) => Object.keys(row)))].sort(),
        groups: [...new Set(data.map((row) => row.group))],
        stable,
      }),
    ];
  }
  throw new Error(`unknown post-processor ${post}`);
}

export function file_digest(rel: string, bytes: Buffer, roots: Roots): string {
  const text = bytes.toString("utf8");
  if (rel.endsWith(".json") || rel.endsWith(".pes-lock")) {
    try {
      return n9_text_hash(n3_json(n1_json(JSON.parse(text), roots)), roots);
    } catch {
      return `invalid-json:${n9_text_hash(text, roots)}`;
    }
  }
  if (rel.endsWith(".html")) {
    const view = n6_html(text, roots);
    return n9_text_hash(n3_json({ title: view.title, raw_title: view.raw_title, blocks: view.blocks, data: view.data ?? null, text: view.text }), roots);
  }
  return n9_text_hash(ports(text), roots);
}

function collect_files(dir: string, roots: Roots): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  for (const rel of walk_files(dir)) {
    const name = n1_time(rel);
    out[name] = file_digest(rel, readFileSync(join(dir, ...rel.split("/"))), roots);
  }
  return out;
}

// ---------------------------------------------------------------- runners
type Answer = { stage: string; round: number; kind: string; text: string };

/** 0.15 side of D04: who holds `.pes-lock` right now (a lock older than the TTL does not count), or null. */
function py_lock(project: string): { owner: string } | null {
  const file = join(project, ".pes-lock");
  if (!existsSync(file)) return null;
  try {
    const info = JSON.parse(readFileSync(file, "utf8")) as { owner?: string; at?: number };
    return Date.now() / 1000 - Number(info.at ?? 0) < 7200 ? { owner: String(info.owner) } : null;
  } catch {
    return null;
  }
}

/** 0.15 side of D03: every `feedback/*.json` as {stage, round, kind, text}. */
function py_answers(project: string): Answer[] {
  const dir = join(project, "feedback");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const record = read_json(join(dir, name));
      return { stage: String(record.stage), round: Number(record.round), kind: String(record.kind ?? "feedback"), text: String(record.text ?? "") };
    });
}

/** D03: the answer-name lines are DB-assigned on ts, so only what is common is compared (a path's last segment; one line for chat). */
export function d03_stdout(label: unknown, stdout: string[]): string[] {
  const head = Array.isArray(label) ? String(label[0] ?? "") : "";
  if (head === "chat") return stdout.length === 1 ? ["<답 기록됨>"] : stdout;
  if (head === "pending") return stdout.map((line) => line.split(/[\\/]/).pop() as string);
  return stdout;
}

async function run_cli_like(target: Target, def: CaseDef, ctx: CompatCtx): Promise<CaseOutcome> {
  const steps: unknown[] = [];
  const roots = (): Roots => ctx.roots(def.project === null ? undefined : substitute(def.project, ctx));
  const ts_home = { env: ctx.env, pes_home: ctx.pes_home, home_dir: ctx.home_dir };
  const d03 = def.diffs.includes("D03");
  const d04 = def.diffs.includes("D04");
  let merge_n = 0;
  let last_pending: string[] = [];
  for (const raw of def.steps) {
    if (raw.ts_import !== undefined) {
      // ts only: a 0.15 folder the case wrote is put into the DB the way the user's migration does it (PR11/PR12); py has no DB
      if (target === "ts") await ts_seed_legacy(ts_home, substitute(raw.ts_import, ctx));
      continue;
    }
    if (raw.write_json !== undefined) {
      const path = substitute(raw.write_json, ctx);
      write_json(path, sub_deep(raw.json, ctx), raw.indent === null ? undefined : 1);
      // a pending answer dropped into a served project's feedback/ is, on ts, a web submission (D03): same stage/round/kind/text
      if (target === "ts" && /[\\/]feedback[\\/][^\\/]+\.json$/.test(path)) {
        const folder = dirname(dirname(path));
        const a = read_json(path) as Answer;
        ts_seed_feedback(ctx, basename(folder), { stage: a.stage, round: a.round, kind: a.kind, text: a.text });
      }
      continue;
    }
    if (raw.synthetic !== undefined) {
      const made = synthetic_project(ctx, raw.synthetic);
      const target_dir = substitute(raw.as, ctx);
      move_dir(made, target_dir);
      continue;
    }
    if (raw.patch_project !== undefined) {
      if (target === "ts") {
        // the project is in the DB: the only fields a case patches (executive_summary / conclusion) go in through `pes set project …`
        for (const [field, value] of Object.entries<any>(raw.patch_project)) {
          const file = join(ctx.tmp, `patch-${field}.txt`);
          writeFileSync(file, String(value), "utf8");
          const done = run_pes("ts", ctx, ["set", ctx.project(), "project", field, file]);
          assert.ok(done.kind === "ran" && done.status === 0, `ts: patch_project via set failed: ${done.kind === "ran" ? done.stderr : done.reason}`);
        }
        continue;
      }
      const file = join(ctx.project(), "project.json");
      const data = read_json(file);
      for (const [path, value] of Object.entries<any>(raw.patch_project)) {
        const parts = path.split(".");
        let cursor = data;
        for (const part of parts.slice(0, -1)) cursor = cursor[part];
        cursor[parts[parts.length - 1] as string] = value;
      }
      write_json(file, data);
      continue;
    }
    if (raw.age_lock !== undefined) {
      const folder = substitute(raw.project, ctx);
      if (target === "ts") {
        ts_age_lease(ts_home, basename(folder), raw.age_lock);
        continue;
      }
      const lock = join(folder, ".pes-lock");
      const data = read_json(lock);
      data.at = Date.now() / 1000 - raw.age_lock;
      writeFileSync(lock, JSON.stringify(data), "utf8");
      continue;
    }
    if (raw.snapshot !== undefined) {
      steps.push({ step: { snapshot: raw.name }, files: collect_files(substitute(raw.snapshot, ctx), roots()) });
      continue;
    }
    if (raw.move_project !== undefined) {
      const from = substitute(raw.move_project.from, ctx);
      const to = substitute(raw.move_project.to, ctx);
      move_dir(from, to);
      // ts: the project folder moved and its name changed — the DB project follows the folder name (the 0.15 `pdir` rule)
      if (target === "ts") ts_rename_slug(ts_home, basename(from), basename(to));
      continue;
    }
    if (raw.copy_project !== undefined) {
      copy_dir(substitute(raw.copy_project.from, ctx), substitute(raw.copy_project.to, ctx));
      continue;
    }
    let args: string[];
    let label: unknown;
    if (raw.merge !== undefined) {
      merge_n += 1;
      const files = (raw.merge.results as unknown[]).map((result, index) => write_json(join(ctx.tmp, "results", `merge-${merge_n}`, `${index}.json`), sub_deep(result, ctx)));
      args = ["merge", ctx.project(), raw.merge.stage, ...files];
      label = ["merge", "{P}", raw.merge.stage, `<${files.length} result file(s)>`];
    } else if (raw.run !== undefined) {
      args = (raw.run as string[]).map((a) => substitute(a, ctx));
      label = raw.run;
      // D03 on ts: `mark` names the answer by the name the DB gave it (the last `pending` listing), not by the 0.15 file name
      if (target === "ts" && d03 && args[0] === "mark" && last_pending.length > 0) args = ["mark", args[1] as string, ...last_pending.slice(0, args.length - 2)];
    } else if (raw.setup !== undefined) {
      args = raw.setup as string[];
      label = ["setup.py", ...args];
    } else {
      throw new Error(`unknown step ${JSON.stringify(raw)}`);
    }
    const options = { env: raw.env as Record<string, string | undefined> | undefined, narrow_path: raw.narrow_path === true };
    const run = raw.setup !== undefined ? run_setup(target, ctx, args, options) : run_pes(target, ctx, args, options);
    if (run.kind === "not_yet") return { kind: "not_yet", reason: run.reason };
    let stdout = post_process(raw.post, run.stdout, roots());
    if (target === "ts" && d03 && args[0] === "pending") last_pending = run.stdout.split("\n").filter((x) => x !== "").map((x) => x.split(/[\\/]/).pop() as string);
    if (d03) stdout = d03_stdout(label, stdout);
    const entry: Record<string, unknown> = {
      step: label,
      env: raw.env ?? undefined,
      exit: run.status,
      stdout,
      stderr: stderr_kind(run.stderr, roots()),
    };
    if (d04 && def.project !== null) {
      const folder = substitute(def.project, ctx);
      entry.lock = target === "ts" ? (ts_view(ts_home, basename(folder))?.lock ?? null) : py_lock(folder);
    }
    steps.push(entry);
  }
  const project = def.project === null ? undefined : substitute(def.project, ctx);
  const dto_run = project !== undefined && has_state(target, ctx, project) ? read_state_dto(target, ctx, project) : undefined;
  if (dto_run?.kind === "not_yet") return { kind: "not_yet", reason: dto_run.reason };
  const record: CaseRecord = {
    id: def.id,
    steps,
    dto: dto_run === undefined ? null : normalized_dto(dto_run.dto, roots()),
    files: project === undefined ? {} : collect_files(project, roots()),
  };
  if (d03 && project !== undefined) {
    const found = target === "ts" ? (ts_view(ts_home, basename(project))?.answers ?? []) : py_answers(project);
    record.answers = answers_multiset(found).map((x) => JSON.parse(x) as unknown);
  }
  if (target === "ts" && def.diffs.includes("D10") && project !== undefined) assert_posix_storage(project, def.id);
  return { kind: "ran", record };
}

/** Does the project exist in a form a DTO can be read from — project.json (py) / the DB or an old project.json (ts)? */
function has_state(target: Target, ctx: CompatCtx, project: string): boolean {
  if (target === "py") return existsSync(join(project, "project.json")) && safe_json(join(project, "project.json"));
  if (!ts_cli_exists()) return true; // read_state_dto answers not_yet
  const ts_home = { env: ctx.env, pes_home: ctx.pes_home, home_dir: ctx.home_dir };
  if (ts_view(ts_home, basename(project)) !== undefined) return true;
  return existsSync(join(project, "project.json")) && safe_json(join(project, "project.json"));
}

/** D10 (W1·W2): nothing the ts CLI generated in the project folder has a CR, and no stored path of a report has a backslash. */
export function assert_posix_storage(project: string, id: string): void {
  for (const rel of walk_files(project)) {
    if (!/\.(md|html|json|log|txt)$/.test(rel)) continue;
    const text = readFileSync(join(project, ...rel.split("/")), "utf8");
    assert.ok(!text.includes("\r"), `${id}: ${rel} has CR — the ts CLI writes LF on every OS (D10, W2)`);
    if (rel === "project.json") assert.ok(!/"path":\s*"[^"]*\\\\/.test(text), `${id}: project.json stores a backslash path — ts stores "/" on every OS (D10, W1)`);
  }
}

function safe_json(path: string): boolean {
  try {
    JSON.parse(readFileSync(path, "utf8"));
    return true;
  } catch {
    return false;
  }
}

async function run_http(target: Target, def: CaseDef, ctx: CompatCtx): Promise<CaseOutcome> {
  if (target === "ts") return ts_gate("http");
  const root = make_serve_home(ctx);
  const server = new ServeProcess(ctx, root);
  const steps: unknown[] = [];
  const roots = ctx.roots(join(root, "synthetic"));
  try {
    for (const raw of def.steps) {
      if (raw.config !== undefined) {
        write_json(join(ctx.home_dir, ".pes", "config.json"), raw.config);
      } else if (raw.set_mtimes !== undefined) {
        for (const entry of raw.set_mtimes) touch(substitute(entry.path, ctx), entry.epoch);
      } else if (raw.start !== undefined) {
        await server.start();
      } else if (raw.http !== undefined) {
        const h = raw.http;
        const origin: string | null = h.origin === "self" ? server.origin() : (h.origin ?? null);
        const response =
          h.method === "GET"
            ? await server.request(h.path)
            : await server.post(
                h.path,
                h.json !== undefined ? h.json : Buffer.from(h.raw !== undefined ? String(h.raw) : "x".repeat(h.raw_size as number) , "utf8"),
                origin,
              );
        const text = response.text();
        let body: unknown;
        try {
          body = n1_json(JSON.parse(text), roots);
          if (typeof body === "object" && body !== null) body = JSON.parse(ports(JSON.stringify(body)));
        } catch {
          // N12: the stdlib's own error page is the interpreter's text (length differs by Python version), not PES's.
          body = n12_stdlib_error_page(response.status, text) ?? (text.length <= 400 ? n7_text(text) : `<${text.length} bytes sha:${n9_text_hash(text, roots)}>`);
        }
        steps.push({
          step: { method: h.method, path: h.path, origin: h.origin ?? null },
          status: response.status,
          content_type: response.headers["content-type"] ?? null,
          cache_control: response.headers["cache-control"] ?? null,
          body,
        });
      } else if (raw.burst !== undefined) {
        const b = raw.burst;
        const answers = await Promise.all(
          Array.from({ length: b.count as number }, (_x, index) => server.post(b.path, { stage: b.stage, round: b.round, kind: "feedback", text: `${b.text_prefix}${index}` })),
        );
        const dir = join(root, "synthetic", "feedback");
        const names = existsSync(dir) ? readdirSync(dir).sort() : [];
        const texts = names.map((name) => read_json(join(dir, name)).text).sort();
        steps.push({
          step: { burst: b.count },
          statuses: [...new Set(answers.map((a) => a.status))],
          all_ok: answers.every((a) => a.json().ok === true),
          files: names.length,
          distinct_texts: new Set(texts).size,
          lost: (b.count as number) - new Set(texts).size,
        });
      } else {
        throw new Error(`unknown step ${JSON.stringify(raw)}`);
      }
    }
  } finally {
    await server.stop();
  }
  return { kind: "ran", record: { id: def.id, steps, dto: null, files: def.files === "count" ? { count: String(Object.keys(http_files(join(root, "synthetic"), roots)).filter((name) => name.startsWith("feedback/")).length) } : http_files(join(root, "synthetic"), roots) } };
}

function http_files(project: string, roots: Roots): Record<string, string> {
  const out: Record<string, string> = {};
  const feedback = join(project, "feedback");
  if (existsSync(feedback)) {
    for (const name of readdirSync(feedback).sort()) {
      const record = n1_json(read_json(join(feedback, name)), roots) as Record<string, unknown>;
      if (typeof record.origin === "string") record.origin = ports(record.origin);
      out[`feedback/${n1_time(name)}`] = n9_text_hash(n3_json(record), roots);
    }
  }
  const log = join(project, "feedback.log");
  if (existsSync(log) && statSync(log).size > 0) {
    // one line per answer: the file name carries a time (N1) and the path a root (N2)
    out["feedback.log"] = n9_text_hash(lines(ports(n8_console(readFileSync(log, "utf8"), roots))).sort().join("\n"), roots);
  } else {
    out["feedback.log"] = "empty";
  }
  return out;
}

/** Runs one case on one target. The caller owns neither the ctx nor the servers: both are gone when this returns. */
export async function run_case(target: Target, id: string): Promise<CaseOutcome> {
  const def = case_def(id);
  // The ratchet is per case (SEL-71): a case marked not_yet is never run on ts — even when scripts/pes.ts exists — it answers not_yet.
  if (target === "ts" && def.ts.status === "not_yet") return { kind: "not_yet", reason: load_table().ts_not_yet_reason };
  const ctx = make_ctx(`pes-compat-${id.toLowerCase()}-`);
  try {
    return def.kind === "http" ? await run_http(target, def, ctx) : await run_cli_like(target, def, ctx);
  } finally {
    ctx.cleanup();
  }
}

export function read_baseline(id: string): CaseRecord {
  const path = baseline_path(id);
  assert.ok(existsSync(path), `no 0.15 baseline for ${id}: run PES_COMPAT_UPDATE=1 node --test on the case file once, review the diff`);
  return JSON.parse(readFileSync(path, "utf8")) as CaseRecord;
}

/**
 * The baseline for one OS: the single stored record plus that OS's `os_overrides` edits. A path that does not exist in the record
 * throws (an override must not silently stop matching when the baseline changes). `platform` is injectable for the unit test.
 */
export function baseline_for(id: string, platform: string = process.platform, base: CaseRecord = read_baseline(id)): CaseRecord {
  const override = case_def(id).os_overrides?.[platform];
  const out = JSON.parse(JSON.stringify(base)) as CaseRecord;
  if (override === undefined) return out;
  for (const edit of override.edits) {
    const parent = edit.at.slice(0, -1).reduce<any>((node, key) => node?.[key], out);
    const last = edit.at[edit.at.length - 1]!;
    assert.ok(parent !== undefined && parent !== null && last in parent, `${id}: os_overrides[${platform}] path ${JSON.stringify(edit.at)} is not in the baseline`);
    if ("value" in edit) {
      parent[last] = edit.value;
    } else {
      assert.equal(typeof parent[last], "string", `${id}: os_overrides json_set target is not a JSON text`);
      parent[last] = n3_json({ ...JSON.parse(parent[last] as string), ...edit.json_set });
    }
  }
  return out;
}

/**
 * The pinned 0.15 record the ts target is held to: the single stored baseline WITHOUT any os_overrides, on every OS. The win32
 * overrides are 0.15's Windows data (W1 backslash paths, W2 CRLF sizes); ts stores `/` and LF everywhere (D10), so on Windows it must
 * equal the macOS/Linux record — that is stronger than ignoring the difference.
 */
export function ts_baseline(id: string): CaseRecord {
  return JSON.parse(JSON.stringify(read_baseline(id))) as CaseRecord;
}

export function write_baseline(record: CaseRecord): void {
  const path = baseline_path(record.id);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 1)}\n`, "utf8");
}

function roundtrip(record: CaseRecord): CaseRecord {
  return JSON.parse(JSON.stringify(record)) as CaseRecord;
}

/**
 * What "a ts case is implemented" means, in one place (and testable with an injected record): the ts record must equal the pinned
 * 0.15 baseline in every part the py side compares — steps (stdout / stderr kind / exit), the state DTO and the produced files —
 * except what the listed intended differences (7.5) remove, and each of those removals has its own assertion:
 *   D01 ids_distinct, D03 processed_count, D06 override (the fixed value, not "anything"), D07 snapshot contents (names ignored,
 *   no content lost).
 *
 * PR26b hook: when the ts DTO / file builders exist, N5 (`n5_ids`: new UUID / tx / event ids → <ID:n> by first appearance) and N4
 * (`n4_order` / `n4_multiset` for event / answer tables) are applied to the ts side here, before the comparison. They are not
 * applied today because both sides are Python (integer ids, file order), and they are only unit-tested in test_compat_harness.
 */
/**
 * D02 device, the one place the DB shape differs from a 0.15 project.json beyond the intended id/processed differences: the DB read
 * model always carries `executive_summary` / `conclusion` ("") and each stage's `qa` / `review_log` ([]) while 0.15 adds the key with
 * the first write. An empty value and an absent key are the same state, so both sides drop the empty ones (a non-empty value stays).
 */
export function d02_canon(dto: unknown): unknown {
  if (dto === null || typeof dto !== "object") return dto;
  const copy = JSON.parse(JSON.stringify(dto)) as any;
  for (const key of ["executive_summary", "conclusion"]) if (copy[key] === "") delete copy[key];
  for (const stage of Object.values<any>(copy.stages ?? {})) for (const key of ["qa", "review_log"]) if (Array.isArray(stage[key]) && stage[key].length === 0) delete stage[key];
  return copy;
}

export function compare_ts_record(def: CaseDef, got: CaseRecord, base: CaseRecord): void {
  const id = def.id;
  const diffs = def.diffs;
  const canon = diffs.includes("D02") ? d02_canon : (x: unknown) => x;
  compare_steps(def, got.steps, base.steps);
  assert.deepEqual(
    n10_apply(canon(got.dto), diffs, KNOWN_DIFFS),
    n10_apply(canon(n10_override(base.dto, id, diffs, KNOWN_DIFFS)), diffs, KNOWN_DIFFS),
    `${id}: state DTO differs beyond ${diffs.join(",") || "no"} intended differences`,
  );
  assert.deepEqual(n10_checks(got.dto, base.dto, diffs, KNOWN_DIFFS), [], `${id}: an intended difference's own check failed`);
  assert.deepEqual(n10_files(got.files, diffs, KNOWN_DIFFS), n10_files(base.files, diffs, KNOWN_DIFFS), `${id}: produced files differ (names or normalised contents) beyond ${diffs.join(",") || "no"} intended differences`);
  if (diffs.some((d) => KNOWN_DIFFS[d]?.answers_check === true) && base.answers !== undefined) {
    // D03: the answers are a multiset of {stage, round, kind, text}; file names, times and the number of files are not part of it
    assert.ok(got.answers !== undefined, `${id}: the ts record carries no answers (D03)`);
    assert.deepEqual([...got.answers].map((x) => JSON.stringify(x)).sort(), [...base.answers].map((x) => JSON.stringify(x)).sort(), `${id}: answers differ (D03: ${"{stage, round, kind, text}"} multiset)`);
  }
  if (diffs.some((d) => KNOWN_DIFFS[d]?.files_check === "snapshot_contents")) {
    // D07: where the snapshots live is not compared, but none of their contents may be lost (the first state and every later one).
    const have = dropped_digests(got.files, diffs, KNOWN_DIFFS);
    for (const digest of dropped_digests(base.files, diffs, KNOWN_DIFFS)) {
      const at = have.indexOf(digest);
      assert.ok(at >= 0, `${id}: a snapshot state of 0.15 (${digest}) is missing — the first state or a later one was lost`);
      have.splice(at, 1);
    }
  }
}

/** A step ended in a Python traceback on 0.15 (stderr kind "traceback: …"). */
function is_traceback_step(step: any): boolean {
  return Array.isArray(step?.stderr) && step.stderr.some((line: string) => line.startsWith("traceback:"));
}

/** What a ts stderr must not look like: a Python or Node stack trace. */
export function looks_like_stack_trace(lines_: string[]): boolean {
  return lines_.some((line) => /^traceback:|Traceback \(most recent|^\s+at .+[(:]|node:internal|ERR_[A-Z_]+|\bat file:\/\//.test(line));
}

/**
 * Steps: equal, except the D03 name lines (already reduced by d03_stdout on both sides) and D11 — a 0.15 traceback step passes when ts
 * gives the same exit and a plain Korean message without a stack trace (or, for a `fixable` step, succeeds with exit 0 and no stack trace).
 */
export function compare_steps(def: CaseDef, got: unknown[], base: unknown[]): void {
  const id = def.id;
  assert.equal(got.length, base.length, `${id}: the number of recorded steps differs`);
  const d11 = def.diffs.includes("D11");
  base.forEach((expected: any, index) => {
    const actual: any = got[index];
    if (!(d11 && is_traceback_step(expected))) {
      assert.deepEqual(actual, expected, `${id}: step ${index} (${JSON.stringify(expected.step)}) — stdout / stderr kind / exit${def.diffs.includes("D04") ? " / lock owner" : ""} differ`);
      return;
    }
    assert.deepEqual(actual.step, expected.step, `${id}: step ${index} is another command`);
    const fixable = (KNOWN_DIFFS.D11?.traceback_fix?.fixable?.[id] ?? []).some((label) => JSON.stringify(label) === JSON.stringify(expected.step));
    assert.ok(!looks_like_stack_trace(actual.stderr), `${id}: step ${JSON.stringify(expected.step)} still ends in a stack trace (D11): ${JSON.stringify(actual.stderr)}`);
    if (fixable && actual.exit === 0) return;
    assert.equal(actual.exit, expected.exit, `${id}: step ${JSON.stringify(expected.step)} (a 0.15 traceback, D11) must end with the same exit code`);
    assert.ok(actual.stderr.length >= 1 && actual.stderr.every((line: string) => line.trim() !== "") && /[가-힣]/.test(actual.stderr.join("\n")), `${id}: step ${JSON.stringify(expected.step)} needs a plain Korean error message on stderr (D11), got ${JSON.stringify(actual.stderr)}`);
  });
}

/**
 * The one call a case test makes.
 *  py: the record must equal the stored 0.15 baseline.
 *  ts: a case marked not_yet in cases.json must answer not_yet (an explicit, counted absence); a case marked implemented must
 *      pass `compare_ts_record` against the same baseline.
 */
export async function assert_case(target: Target, id: string): Promise<void> {
  const def = case_def(id);
  const outcome = await run_case(target, id);
  if (target === "py") {
    assert.equal(outcome.kind, "ran", `${id}: the 0.15 target must run`);
    if (outcome.kind !== "ran") return;
    if (process.env.PES_COMPAT_UPDATE === "1") {
      write_baseline(outcome.record);
      return;
    }
    const expected = baseline_for(id);
    const actual = roundtrip(outcome.record);
    if (process.env.PES_COMPAT_DUMP === "1" && !isDeepStrictEqual(actual, expected)) {
      // Diagnostic mode (CI only, to collect the values of another OS): print the record instead of failing. Without the variable
      // a difference always fails below.
      console.log(`COMPAT_DUMP ${id} ${process.platform}\n${JSON.stringify(actual)}\nCOMPAT_DUMP_END ${id}`);
      return;
    }
    assert.deepEqual(actual, expected, `${id}: 0.15 behaviour differs from the pinned baseline`);
    return;
  }
  if (def.ts.status === "not_yet") {
    assert.equal(outcome.kind, "not_yet", `${id}: marked not_yet in cases.json but the ts target ran — set ts.status to "implemented" and remove it from the not-yet list`);
    return;
  }
  assert.equal(outcome.kind, "ran", `${id}: marked implemented but the ts target answered not_yet (${outcome.kind === "not_yet" ? outcome.reason : ""})`);
  if (outcome.kind !== "ran") return;
  compare_ts_record(def, roundtrip(outcome.record), ts_baseline(id));
}

export function not_yet_ids(): string[] {
  return load_table()
    .cases.filter((c) => c.ts.status === "not_yet")
    .map((c) => c.id);
}

/** Ids of the contract table (X01~X05) and the 7.4 table (E01~E15) the ts target must run today. */
export function implemented_ids(): string[] {
  return all_cases()
    .filter((c) => c.ts.status === "implemented")
    .map((c) => c.id);
}

export { dto_from_project_json, project_json };
