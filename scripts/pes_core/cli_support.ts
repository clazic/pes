// Shared plumbing of the TypeScript CLI (`node scripts/pes.ts`, SEL-71 / PR26b): output, exit codes, the 0.15 path rules
// (`pdir`, `pes_home`), the PES config file, small helpers copied from scripts/pes.py so that the text the user sees is the same.
// No business SQL here: every state change goes through the core (cli_bridge.handle_request -> CommandService).

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { handle_request, type BridgeReply } from "./cli_bridge.ts";
import type { Environment } from "./paths.ts";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const TPL = join(ROOT, "templates");
export const QB = join(ROOT, "questions");
export const STAGES: ReadonlyArray<readonly [string, string]> = [
  ["plan", "기획"],
  ["research", "조사"],
  ["analyze", "분석·종합"],
  ["write", "집필"],
  ["verify", "검증"],
  ["publish", "산출·공유"],
];
export const KEYS: readonly string[] = STAGES.map(([key]) => key);
export const LABEL: Readonly<Record<string, string>> = Object.fromEntries(STAGES);

// ---------------------------------------------------------------- output and exit

/** A command ended with a message and an exit code (the `die()` of pes.py). */
export class Die extends Error {
  readonly exit_code: number;
  constructor(message: string, exit_code = 1) {
    super(message);
    this.exit_code = exit_code;
  }
}

export function die(message: string, exit_code = 1): never {
  throw new Die(message, exit_code);
}

/** What the command printed so far; flushed once at the end (stdout is UTF-8 on every OS, LF line ends). */
export class Output {
  readonly out: string[] = [];
  say(text = ""): void {
    this.out.push(`${text}\n`);
  }
  raw(text: string): void {
    this.out.push(text);
  }
}

export const output = new Output();
export const say = (text = ""): void => output.say(text);

// ---------------------------------------------------------------- environment, home, paths

export function env(): Environment {
  return process.env as Environment;
}

export function now(): string {
  const d = new Date();
  const two = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

export function home_dir(): string {
  return homedir();
}

export function config_path(): string {
  return join(home_dir(), ".pes", "config.json");
}

/** Python `Path(a).expanduser()`: a leading `~` or `~/` means this account's home. */
export function expanduser(path: string): string {
  if (path === "~") return home_dir();
  if (path.startsWith("~/") || path.startsWith(`~${sep}`)) return join(home_dir(), path.slice(2));
  return path;
}

/** Python `Path.resolve()` (non-strict): absolute, symbolic links resolved for the part that exists. */
export function resolve_path(path: string): string {
  const absolute = resolve(expanduser(path));
  let head = absolute;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync.native(head);
      return tail.length === 0 ? real : join(real, ...tail.reverse());
    } catch {
      const parent = dirname(head);
      if (parent === head) return absolute;
      tail.push(basename(head));
      head = parent;
    }
  }
}

export function read_config(): Record<string, unknown> {
  try {
    const data: unknown = JSON.parse(readFileSync(config_path(), "utf8"));
    return data !== null && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * The one writer of every text file the ts CLI generates (ask pages, index.html, briefs, logs, config): UTF-8 with LF line
 * ends on every OS (D10, W2). A Windows checkout (core.autocrlf) can give CRLF templates and question banks; the CR never
 * reaches a generated file.
 */
export function write_text(path: string, text: string): void {
  writeFileSync(path, text.replace(/\r\n?/g, "\n"), "utf8");
}

export function write_config(cfg: Record<string, unknown>): void {
  mkdirSync(dirname(config_path()), { recursive: true });
  write_text(config_path(), JSON.stringify(cfg, null, 1));
}

/** PES home: env PES_HOME > ~/.pes/config.json `home` > ~/pes-projects (pes.py `pes_home`). */
export function pes_home(): string {
  const given = process.env.PES_HOME;
  if (given !== undefined && given !== "") return resolve_path(given);
  const configured = read_config().home;
  if (typeof configured === "string" && configured !== "") return resolve_path(configured);
  return resolve_path(join(home_dir(), "pes-projects"));
}

/** pes.py `pdir`: a bare name is a project below the PES home, anything else is a path. */
export function pdir(arg: string): string {
  if (arg !== "" && !arg.includes("/") && !arg.includes("\\") && !arg.startsWith(".") && !arg.includes(":") && arg !== "~") {
    return join(pes_home(), arg);
  }
  return resolve_path(arg);
}

// ---------------------------------------------------------------- the core, in this process

export interface BridgeData {
  [key: string]: unknown;
}

function failure_text(reply: Extract<BridgeReply, { ok: false }>): string {
  return reply.message === "" ? "실패" : reply.message;
}

/** Calls the core once. A refusal ends the command with the core's exit code and message. */
export async function bridge(op: string, slug?: string | null, args?: Record<string, unknown>): Promise<BridgeData> {
  const reply = await handle_request(env(), {
    op,
    slug: slug ?? null,
    session: process.env.PES_OWNER === undefined || process.env.PES_OWNER === "" ? null : process.env.PES_OWNER,
    token: process.env.PES_TOKEN === undefined || process.env.PES_TOKEN === "" ? null : process.env.PES_TOKEN,
    args: args ?? {},
  });
  if (!reply.ok) {
    if (reply.code === "internal_error") {
      if (process.env.PES_DEBUG === "1" && reply.stack !== undefined) process.stderr.write(`${reply.stack}\n`);
      die("내부 오류 — 명령을 끝내지 못했습니다 (PES_DEBUG=1 로 다시 실행하면 자세한 내용이 나옵니다)", 1);
    }
    const exit_code = Number.isInteger(reply.exit) && reply.exit > 0 ? reply.exit : 1;
    die(failure_text(reply), exit_code);
  }
  const data = reply.data;
  if (data === null || typeof data !== "object" || Array.isArray(data)) die("코어가 올바른 답을 주지 않았습니다 (결과가 없음)", 1);
  return data as BridgeData;
}

/** Like `bridge`, but a refusal answers undefined instead of ending the command. */
export async function bridge_soft(op: string, slug?: string | null, args?: Record<string, unknown>): Promise<BridgeData | undefined> {
  try {
    return await bridge(op, slug, args);
  } catch (error) {
    if (error instanceof Die) return undefined;
    throw error;
  }
}

// ---------------------------------------------------------------- small text helpers

export function first_line(text: unknown, limit = 160): string {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/** Python `html.unescape` for the entities a result file uses, then `<br>` to a line break (pes.py `norm_text`). */
export function norm_text(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  const text = value.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    if (body.startsWith("#")) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    return named[body] ?? whole;
  });
  return text.replace(/<br\s*\/?>/gi, "\n");
}

export function html_escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
}

export function is_record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function stage_arg(stage: string | undefined): string {
  if (stage === undefined || !KEYS.includes(stage)) die(`단계 이름은 ${KEYS.join(", ")} 중 하나`, 1);
  return stage;
}

/** A command that needs more arguments than were given: 0.15 died with an IndexError traceback here (D11) — now one plain line. */
export function missing_args(command: string): never {
  return die(`${command}: 인자가 부족합니다 — 인자 없이 실행하면 사용법이 나옵니다`, 1);
}

export function arg_at(args: string[], index: number, command: string): string {
  const value = args[index];
  if (value === undefined) return missing_args(command);
  return value;
}

// ---------------------------------------------------------------- Python's json error text (what 0.15 printed for a broken file)

/**
 * The message Python's `json.loads` raises for `text`, or null when the text is valid JSON (Python also accepts NaN / Infinity).
 * Only the file's own bytes are read; doctor shows this text for a broken project.json, so it is the same one 0.15 showed.
 */
export function py_json_error(text: string): string | null {
  const chars = Array.from(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  const n = chars.length;
  class Fail extends Error {
    readonly at: number;
    readonly what: string;
    constructor(what: string, at: number) {
      super(what);
      this.what = what;
      this.at = at;
    }
  }
  const ws = (i: number): number => {
    let k = i;
    while (k < n && " \t\n\r".includes(chars[k] as string)) k += 1;
    return k;
  };
  const literal = (i: number, word: string): boolean => chars.slice(i, i + word.length).join("") === word;
  const string = (start: number): number => {
    let i = start + 1;
    for (;;) {
      if (i >= n) throw new Fail("Unterminated string starting at", start);
      const c = chars[i] as string;
      if (c === '"') return i + 1;
      if (c === "\\") {
        const e = chars[i + 1];
        if (e === undefined) throw new Fail("Unterminated string starting at", start);
        if (e === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(chars.slice(i + 2, i + 6).join(""))) throw new Fail("Invalid \\uXXXX escape", i + 1);
          i += 6;
        } else if ('"\\/bfnrt'.includes(e)) {
          i += 2;
        } else {
          throw new Fail(`Invalid \\escape: '${e}'`, i);
        }
      } else if (c.charCodeAt(0) < 0x20) {
        throw new Fail("Invalid control character at", i);
      } else {
        i += 1;
      }
    }
  };
  const value = (i: number): number => {
    const c = chars[i];
    if (c === '"') return string(i);
    if (c === "{") {
      let k = ws(i + 1);
      if (chars[k] === "}") return k + 1;
      for (;;) {
        if (chars[k] !== '"') throw new Fail("Expecting property name enclosed in double quotes", k);
        k = ws(string(k));
        if (chars[k] !== ":") throw new Fail("Expecting ':' delimiter", k);
        k = ws(value(ws(k + 1)));
        if (chars[k] === "}") return k + 1;
        if (chars[k] !== ",") throw new Fail("Expecting ',' delimiter", k);
        k = ws(k + 1);
      }
    }
    if (c === "[") {
      let k = ws(i + 1);
      if (chars[k] === "]") return k + 1;
      for (;;) {
        k = ws(value(k));
        if (chars[k] === "]") return k + 1;
        if (chars[k] !== ",") throw new Fail("Expecting ',' delimiter", k);
        k = ws(k + 1);
      }
    }
    if (c === "n" && literal(i, "null")) return i + 4;
    if (c === "t" && literal(i, "true")) return i + 4;
    if (c === "f" && literal(i, "false")) return i + 5;
    if (c === "N" && literal(i, "NaN")) return i + 3;
    if (c === "I" && literal(i, "Infinity")) return i + 8;
    if (c === "-" && literal(i, "-Infinity")) return i + 9;
    const number = chars.slice(i, i + 400).join("").match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][-+]?\d+)?/);
    if (number !== null) return i + Array.from(number[0]).length;
    throw new Fail("Expecting value", i);
  };
  try {
    const end = ws(value(ws(0)));
    if (end !== n) throw new Fail("Extra data", end);
    return null;
  } catch (error) {
    if (!(error instanceof Fail)) throw error;
    const before = chars.slice(0, error.at);
    const line = before.filter((c) => c === "\n").length + 1;
    const col = error.at - (before.lastIndexOf("\n") + 1) + 1;
    return `${error.what}: line ${line} column ${col} (char ${error.at})`;
  }
}
