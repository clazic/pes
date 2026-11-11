// pes.ts: the five commands an agent uses with PES_TOKEN — context, claim, submit, wait, complete (SEL-74 B / PR26e).
// 0.15's pes.py had them only on its PES_DB_CORE=1 path; here they need no flag. Same arguments, one JSON line on stdout, same exit codes
// (2 for argument errors). Credentials: no PES_TOKEN = the human owner of the local database, PES_TOKEN=<agent token> = that agent.
// PES_OWNER is a lock label, never a credential. Every write is one core call; nothing here touches project.json.

import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";

import { bridge, die, missing_args, pdir, pes_home, say, unmigrated_notice } from "./cli_support.ts";
import { py_json } from "./report.ts";

/** The slug of a project argument: a folder below the PES home (0.15 `db_name`); a folder anywhere else is not a project the database serves. */
function db_name(arg: string): string {
  const d = pdir(arg);
  if (dirname(d) !== pes_home()) return die(unmigrated_notice("쓰기", basename(d)), 2);
  return basename(d);
}

/** `--name value` pairs (0.15 `_opts`); a name outside `names`, or a value-less name, ends the command with exit 2. */
function opts(args: string[], names: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const rest = [...args];
  while (rest.length > 0) {
    const k = rest.shift() as string;
    if (k.startsWith("--") && names.includes(k.slice(2)) && rest.length > 0) out[k.slice(2)] = rest.shift() as string;
    else die(`알 수 없는 인자: ${k}`, 2);
  }
  return out;
}

/** run + lease + fence of a claim (0.15 `_guard`). `int()` accepts surrounding blanks and a sign; anything else is "not an integer". */
function guard(opt: Record<string, string>): { run_id: string; lease_id: string; fence: number } {
  for (const k of ["run", "lease", "fence"]) {
    if (!(k in opt)) die(`--${k} 필요 (claim 결과의 run_id·lease_id·fence)`, 2);
  }
  const text = (opt.fence as string).trim();
  if (!/^[+-]?\d+$/.test(text)) die("--fence 는 정수여야 합니다", 2);
  return { run_id: opt.run as string, lease_id: opt.lease as string, fence: Number(text) };
}

function print_json(data: unknown): void {
  say(py_json(data));
}

/** 0.15 `read_json_file` on this path: a plain Korean line and exit 2. */
function read_results_file(path: string): unknown {
  const what = "결과 파일";
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return die(`${what}이 없습니다: ${path}`, 2);
    return die(`${what}을 읽지 못했습니다: ${path} (${code ?? "읽기 오류"})`, 2);
  }
  try {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (error) {
    return die(`${what}이 올바른 JSON이 아닙니다: ${path} (${(error as Error).message})`, 2);
  }
}

export async function cmd_context(args: string[]): Promise<void> {
  const slug = db_name(args[0] ?? missing_args("context"));
  print_json(await bridge("context", slug));
}

export async function cmd_claim(args: string[]): Promise<void> {
  const slug = db_name(args[0] ?? missing_args("claim"));
  const opt = opts(args.slice(1), ["run", "mode", "runtime", "provider", "model"]);
  let a: Record<string, unknown> = {};
  for (const k of ["mode", "runtime", "provider", "model"]) if (k in opt) a[k] = opt[k];
  if ("run" in opt) a = { run_id: opt.run };
  print_json(await bridge("claim", slug, a));
}

export async function cmd_submit(args: string[]): Promise<void> {
  const slug = db_name(args[0] ?? missing_args("submit"));
  const opt = opts(args.slice(1), ["run", "lease", "fence", "file"]);
  if (!("file" in opt)) die("--file <결과.json> 필요", 2);
  const raw = read_results_file(opt.file as string);
  const results = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>).results : raw;
  const a: Record<string, unknown> = { ...guard(opt), results };
  print_json(await bridge("submit", slug, a));
}

export async function cmd_wait(args: string[]): Promise<void> {
  const slug = db_name(args[0] ?? missing_args("wait"));
  const opt = opts(args.slice(1), ["run", "lease", "fence", "reason"]);
  const a: Record<string, unknown> = { ...guard(opt) };
  if (opt.reason !== undefined && opt.reason !== "") a.reason = opt.reason;
  print_json(await bridge("wait", slug, a));
}

export async function cmd_complete(args: string[]): Promise<void> {
  const slug = db_name(args[0] ?? missing_args("complete"));
  const opt = opts(args.slice(1), ["run", "lease", "fence", "status"]);
  const a: Record<string, unknown> = { ...guard(opt) };
  if (opt.status !== undefined && opt.status !== "") a.status = opt.status;
  print_json(await bridge("complete", slug, a));
}
