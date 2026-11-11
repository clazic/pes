// E01~E15 case runner (SEL-70, PR26a): cases.json (the table) → a normalised record on one target → compared with the stored
// 0.15 baseline (tests/fixtures/compat/baseline/<id>.json).
//
//   record = { steps: [...], dto?, files }       everything already through N1~N8, so equal records mean equal behaviour
//
// Baseline update is explicit: PES_COMPAT_UPDATE=1 rewrites the baseline files of the cases that ran (and only those). A normal run
// never writes them. `assert_case(target, id)` is the one call a test makes.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

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
import { dropped_digests, lines, n1_json, n1_time, n10_apply, n10_checks, n10_files, n10_override, n2_paths, n3_json, n6_html, n7_text, n8_console, n9_text_hash, stderr_kind, type Roots } from "./compat_normalize.ts";

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
}

export interface CaseTable {
  doc: string;
  ts_not_yet_reason: string;
  cases: CaseDef[];
}

export function load_table(): CaseTable {
  return JSON.parse(readFileSync(join(FIXTURES, "cases.json"), "utf8")) as CaseTable;
}

export function case_def(id: string): CaseDef {
  const found = load_table().cases.find((c) => c.id === id);
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

function norm_out(text: string, roots: Roots): string[] {
  return lines(versions(ports(n8_console(text, roots))));
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
    // 도구 rows: per PC. 서버 rows (the 서버 group and a project's "… 서버 …" rows): they report the state of ports 8760~8764, which a
    // developer PC may occupy — only their place in the list and `fixable` are compared (os_notes of E15).
    const server_row = (row: any): boolean => row.group === "서버" || /서버/.test(String(row.title));
    const stable = data
      .filter((row) => row.group !== "도구")
      .map((row) =>
        server_row(row)
          ? { group: row.group, level: "<STATE>", title: "<서버 상태>", fixable: row.fixable }
          : { group: row.group, level: row.level, title: n1_time(n2_paths(String(row.title), roots)).replace(/Python \d+\.\d+\.\d+/, "Python <VER>"), fixable: row.fixable },
      );
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

function file_digest(rel: string, bytes: Buffer, roots: Roots): string {
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
    return n9_text_hash(n3_json({ title: view.title, data: view.data ?? null, text: view.text }), roots);
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
async function run_cli_like(target: Target, def: CaseDef, ctx: CompatCtx): Promise<CaseOutcome> {
  const steps: unknown[] = [];
  const roots = (): Roots => ctx.roots(def.project === null ? undefined : substitute(def.project, ctx));
  let merge_n = 0;
  for (const raw of def.steps) {
    if (raw.write_json !== undefined) {
      write_json(substitute(raw.write_json, ctx), sub_deep(raw.json, ctx), raw.indent === null ? undefined : 1);
      continue;
    }
    if (raw.synthetic !== undefined) {
      const made = synthetic_project(ctx, raw.synthetic);
      const target_dir = substitute(raw.as, ctx);
      move_dir(made, target_dir);
      continue;
    }
    if (raw.patch_project !== undefined) {
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
      const lock = join(substitute(raw.project, ctx), ".pes-lock");
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
      move_dir(substitute(raw.move_project.from, ctx), substitute(raw.move_project.to, ctx));
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
    } else if (raw.setup !== undefined) {
      args = raw.setup as string[];
      label = ["setup.py", ...args];
    } else {
      throw new Error(`unknown step ${JSON.stringify(raw)}`);
    }
    const options = { env: raw.env as Record<string, string | undefined> | undefined, narrow_path: raw.narrow_path === true };
    const run = raw.setup !== undefined ? run_setup(target, ctx, args, options) : run_pes(target, ctx, args, options);
    if (run.kind === "not_yet") return { kind: "not_yet", reason: run.reason };
    steps.push({
      step: label,
      env: raw.env ?? undefined,
      exit: run.status,
      stdout: post_process(raw.post, run.stdout, roots()),
      stderr: stderr_kind(run.stderr, roots()),
    });
  }
  const project = def.project === null ? undefined : substitute(def.project, ctx);
  const dto_run = project !== undefined && existsSync(join(project, "project.json")) && safe_json(join(project, "project.json")) ? read_state_dto(target, ctx, project) : undefined;
  if (dto_run?.kind === "not_yet") return { kind: "not_yet", reason: dto_run.reason };
  return {
    kind: "ran",
    record: {
      id: def.id,
      steps,
      dto: dto_run === undefined ? null : normalized_dto(dto_run.dto, roots()),
      files: project === undefined ? {} : collect_files(project, roots()),
    },
  };
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
          body = text.length <= 400 ? n7_text(text) : `<${text.length} bytes sha:${n9_text_hash(text, roots)}>`;
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
export function compare_ts_record(def: CaseDef, got: CaseRecord, base: CaseRecord): void {
  const id = def.id;
  const diffs = def.diffs;
  assert.deepEqual(got.steps, base.steps, `${id}: stdout / stderr kind / exit differ`);
  assert.deepEqual(
    n10_apply(got.dto, diffs, KNOWN_DIFFS),
    n10_apply(n10_override(base.dto, id, diffs, KNOWN_DIFFS), diffs, KNOWN_DIFFS),
    `${id}: state DTO differs beyond ${diffs.join(",") || "no"} intended differences`,
  );
  assert.deepEqual(n10_checks(got.dto, base.dto, diffs, KNOWN_DIFFS), [], `${id}: an intended difference's own check failed`);
  assert.deepEqual(n10_files(got.files, diffs, KNOWN_DIFFS), n10_files(base.files, diffs, KNOWN_DIFFS), `${id}: produced files differ (names or normalised contents) beyond ${diffs.join(",") || "no"} intended differences`);
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
    assert.deepEqual(roundtrip(outcome.record), read_baseline(id), `${id}: 0.15 behaviour differs from the pinned baseline`);
    return;
  }
  if (def.ts.status === "not_yet") {
    assert.equal(outcome.kind, "not_yet", `${id}: marked not_yet in cases.json but the ts target ran — set ts.status to "implemented" and remove it from the not-yet list`);
    return;
  }
  assert.equal(outcome.kind, "ran", `${id}: marked implemented but the ts target answered not_yet`);
  if (outcome.kind !== "ran") return;
  compare_ts_record(def, roundtrip(outcome.record), read_baseline(id));
}

export function not_yet_ids(): string[] {
  return load_table()
    .cases.filter((c) => c.ts.status === "not_yet")
    .map((c) => c.id);
}

export { dto_from_project_json, project_json };
