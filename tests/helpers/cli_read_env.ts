// Harness for the CLI read / report / doctor tests (stage 2 PR16, SEL-49). Everything is synthetic.
//
// Builds on cli_write_env.ts (same isolated HOME / USERPROFILE / PES_HOME, same DB bootstrap) and adds:
//   - run_py(): runs a given pes.py (this repo's or a baseline checkout) with `python3 -I -X utf8`, so Korean
//     output survives Windows pipes (python -I ignores PYTHONIOENCODING, -X utf8 does not)
//   - baseline_dir(): a `git archive` of the last v0.15 read implementation, to compare outputs against
//   - normalize(): output normalisation (roots in every spelling, timestamps, epoch, uuid)
//   - RICH_LEGACY: a legacy project.json with items, sources, notes, a write stage and unprocessed answers
//   - shell_words(): a tiny POSIX-style word splitter, so a printed shell command can be checked without a shell
//     (works the same on Windows CI, where no `sh` can be assumed)

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { PES_PY, REPO, type CliResult } from "./cli_write_env.ts";

/** The last main commit whose read commands are pure v0.15 (project.json readers). */
export const READ_BASELINE_REF = "03fc81b";

export const PY: string =
  spawnSync("python3", ["-I", "-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).stdout.trim() || "python3";

export function baseline_dir(ref: string = READ_BASELINE_REF): string | null {
  const probe = spawnSync("git", ["cat-file", "-e", `${ref}:scripts/pes.py`], { cwd: REPO });
  if (probe.status !== 0) return null; // shallow clone: the caller fails loudly (CI uses fetch-depth: 0)
  const dir = mkdtempSync(join(tmpdir(), "pes-sel49-base-"));
  const archive = spawnSync("sh", ["-c", `git archive ${ref} scripts templates questions | tar -x -C "${dir}"`], { cwd: REPO });
  assert.equal(archive.status, 0, "baseline extract");
  return dir;
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
  return out
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?/g, "<TS>")
    .replace(/\d{8}-\d{6}/g, "<STAMP>")
    .replace(/\b1[0-9]{9}(\.[0-9]+)?\b/g, "<EPOCH>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<UUID>");
}

export interface RunOptions {
  /** Another pes.py (a baseline checkout). Default: this repository's. */
  script?: string;
  /** PES_DB_CORE value; "1" by default. undefined runs the CLI as v0.15. */
  flag?: string | undefined;
  extra?: Record<string, string | undefined>;
  cwd?: string;
  timeout?: number;
}

/** Anything that carries an isolated home: a CliEnv, or `{ env: { home } }` around a bare isolated_home(). */
export interface HomeLike {
  env: { home: { readonly root: string; readonly env: Record<string, string | undefined> } };
}

/** `python3 -I -X utf8 pes.py ...` in the isolated HOME of `c`. PES_OWNER / PES_TOKEN never leak in from the caller. */
export function run_py(c: HomeLike, args: string[], opts: RunOptions = {}): CliResult {
  const child: Record<string, string | undefined> = {
    ...c.env.home.env,
    PES_OWNER: undefined,
    PES_TOKEN: undefined,
    PES_DB_CORE: "flag" in opts ? opts.flag : "1",
    ...opts.extra,
  };
  for (const key of Object.keys(child)) if (child[key] === undefined) delete child[key];
  assert.equal(child.HOME, c.env.home.env.HOME, "the CLI runs in the isolated HOME");
  assert.equal(child.USERPROFILE, c.env.home.env.HOME);
  assert.ok(child.PES_HOME !== undefined && child.PES_HOME.length > 0, "PES_HOME is set (isolated)");
  const result = spawnSync(PY, ["-I", "-X", "utf8", opts.script ?? PES_PY, ...args], {
    env: child as NodeJS.ProcessEnv,
    cwd: opts.cwd ?? c.env.home.root,
    encoding: "utf8",
    timeout: opts.timeout ?? 60_000,
  });
  if (result.error !== undefined) throw result.error;
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
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
