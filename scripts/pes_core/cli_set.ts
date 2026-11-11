// pes.ts: `set <dir> <stage|project> <field> <file|->` — one field, replaced whole (SEL-71, the 0.15 whitelist command).
// The value is checked before anything is written; the read-modify-write of the database value is one short exclusive lock file
// `<project folder>/.project.json.lock` (SEL-75 contract: stale after 60 s, waited for 30 s, Windows retries a permission error,
// elsewhere a permission error without a lock file is a real "no permission" and ends at once with exit 2).

import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";

import { need_project } from "./cli_records.ts";
import { KEYS, LABEL, bridge, die, is_record, pdir, say } from "./cli_support.ts";

const SET_STAGE_FIELDS: Record<string, string> = { summary: "text", changes: "str_list", carry_over: "obj_list", settings: "object", review: "object" };
const SET_PROJECT_FIELDS: Record<string, string> = { executive_summary: "text", conclusion: "text" };
const SET_USAGE =
  `사용법: set <dir> <단계> <필드> <파일|->  (필드: ${Object.keys(SET_STAGE_FIELDS).join("·")})\n` +
  `        set <dir> project <필드> <파일|->  (필드: ${Object.keys(SET_PROJECT_FIELDS).join("·")})`;

/** The text Python's OSError prints, so the one line a person reads stays the same. */
function os_error_text(error: unknown, path: string): string {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return `[Errno 2] No such file or directory: '${path}'`;
  // Windows answers a file it may not read with EPERM: the same one line as EACCES
  if (code === "EACCES" || code === "EPERM") return `[Errno 13] Permission denied: '${path}'`;
  if (code === "EISDIR") return `[Errno 21] Is a directory: '${path}'`;
  if (code === "ENOTDIR") return `[Errno 20] Not a directory: '${path}'`;
  return `${code ?? "읽기 오류"}: '${path}'`;
}

function finite_numbers(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(finite_numbers);
  if (is_record(value)) return Object.values(value).every(finite_numbers);
  return true;
}

function set_parse_check(kind: string, field: string, raw: string): unknown {
  let value: unknown;
  if (kind === "text") {
    value = raw.replace(/\r\n/g, "\n").trimEnd();
    if (value === "") die(`set: ${field} 값이 비어 있습니다 — 텍스트를 담은 파일을 주세요`, 2);
  } else {
    try {
      value = JSON.parse(raw);
    } catch (error) {
      if (error instanceof RangeError) return die(`set: ${field} 값이 너무 깊게 중첩돼 있습니다`, 2);
      return die(`set: ${field} 값이 올바른 JSON 이 아닙니다 (${(error as Error).message})`, 2);
    }
    if (!finite_numbers(value)) die(`set: ${field} 값이 올바른 JSON 이 아닙니다 (너무 큰 수입니다)`, 2);
    const shape: Record<string, [string, (v: unknown) => boolean]> = {
      str_list: ["문자열 배열", (v) => Array.isArray(v) && v.every((x) => typeof x === "string")],
      obj_list: ["객체 배열", (v) => Array.isArray(v) && v.every(is_record)],
      object: ["JSON 객체", is_record],
    };
    const [name, ok] = shape[kind] as [string, (v: unknown) => boolean];
    if (!ok(value)) die(`set: ${field} 값은 ${name}이어야 합니다`, 2);
  }
  try {
    // it has to be storable as UTF-8 JSON: a lone surrogate or a structure too deep to write is refused before anything is written
    const text = JSON.stringify(value);
    if (text === undefined || !text.isWellFormed()) throw new Error("not storable");
  } catch {
    die(`set: ${field} 값을 UTF-8 JSON 으로 저장할 수 없습니다 (짝 없는 문자·너무 깊은 구조 등)`, 2);
  }
  return value;
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

function unlink_missing_ok(file: string): void {
  try {
    unlinkSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** The very short lock around one read-modify-write (not the session lock; the file is removed at the end). */
export async function with_short_write_lock<T>(d: string, work: () => Promise<T>): Promise<T> {
  const lock = join(d, ".project.json.lock");
  const deadline = Date.now() + 30_000;
  // whether this loop has really seen a lock file: after we cleared a stale one a following permission error is not mistaken for a real one
  let seen_lock = false;
  for (;;) {
    try {
      closeSync(openSync(lock, "wx"));
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        seen_lock = true;
      } else if (code === "EPERM" || code === "EACCES") {
        // Windows reports a permission error while another process is deleting the lock file: still held. Elsewhere, with no lock file
        // ever seen, the folder cannot be written — waiting would not help. (process.platform is read each time: a test flips it only for this moment)
        if (process.platform === "win32" || seen_lock || existsSync(lock)) seen_lock = true;
        else die("set: 프로젝트 폴더에 쓸 수 없습니다 (권한)", 2);
      } else {
        throw error;
      }
    }
    try {
      if (Date.now() - statSync(lock).mtimeMs > 60_000) {
        // left behind by a dead process
        seen_lock = true;
        unlink_missing_ok(lock);
        continue;
      }
      seen_lock = true;
    } catch {
      // the lock vanished or cannot be looked at right now: the next round decides
    }
    if (Date.now() > deadline) die("set: 다른 set 이 아직 저장 중입니다 — 잠시 뒤 다시 하세요", 3);
    await sleep(20);
  }
  try {
    return await work();
  } finally {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        unlink_missing_ok(lock);
        break;
      } catch {
        if (attempt === 49) break; // quiet: a lock that stays is cleared by the 60 s rule
        await sleep(20);
      }
    }
  }
}

export async function cmd_set(args: string[]): Promise<void> {
  if (args.length !== 4) die(`set: 인자가 맞지 않습니다\n${SET_USAGE}`, 2);
  const [dir_arg, target, field, src] = args as [string, string, string, string];
  const d = pdir(dir_arg);
  let kinds: Record<string, string>;
  if (target === "project") kinds = SET_PROJECT_FIELDS;
  else if (KEYS.includes(target)) kinds = SET_STAGE_FIELDS;
  else return die(`set: 대상은 단계 이름(${KEYS.join(", ")}) 또는 project 여야 합니다: '${target}'\n${SET_USAGE}`, 2);
  if (!(field in kinds)) die(`set: ${target} 에서 쓸 수 있는 필드는 ${Object.keys(kinds).join(", ")} 뿐입니다: '${field}'`, 2);
  let raw: string;
  try {
    const bytes = readFileSync(src === "-" ? 0 : src);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    raw = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // a BOM from a Windows tool is not part of the value
  } catch (error) {
    if (error instanceof TypeError) return die(`set: 값을 읽지 못했습니다 (${src}): 'utf-8' codec can't decode the bytes (UTF-8 이 아닙니다)`, 2);
    return die(`set: 값을 읽지 못했습니다 (${src}): ${os_error_text(error, src)}`, 2);
  }
  const value = set_parse_check(kinds[field] as string, field, raw);
  const slug = await need_project(d);
  mkdirSync(d, { recursive: true });
  await with_short_write_lock(d, async () => {
    await bridge("set_field", slug, { target, field, value, dir: d });
  });
  say(`${target === "project" ? "프로젝트" : LABEL[target]} ${field} 저장`);
}
