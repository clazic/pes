// 스킬·에이전트·명령 문서 lint (stage 2 PR17).
//
// 사용: node scripts/lint_skills.ts [루트]      (npm run lint:skills)
//
// 막는 것은 두 가지뿐이다.
//   1. 업무 상태를 직접 바꾸는 경로 — 코드 블록·인라인 코드(명령 예제) 안의
//      project.json 쓰기, 업무 표(sqlite) 쓰기 SQL, 잠금 파일(.pes-lock) 조작.
//      산문 문장은 보지 않는다("project.json 을 직접 고치지 않는다" 같은 정상 문장을 막지 않기 위해).
//      자식 제안 파일(rounds/ 아래 결과 JSON 등)·읽기·이름만 적은 언급은 허용한다.
//   2. Claude 전용 표기(anthropic-skills:*, AskUserQuestion, Agent/Task 도구 호출 표기)가
//      docs/adapters/* 밖에 있는 것 — 산문 포함 전체 텍스트를 본다. 어댑터 노트는 이 규칙만 예외다.
//
// 검사 대상(루트 기준): skills/*/SKILL.md, agents/*.md, commands/*.md, docs/adapters/*.md.
// 위반이 있으면 `경로:줄: [규칙] 설명` 을 한 줄씩 찍고 종료 코드 1, 없으면 0.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface Violation {
  file: string; // 루트 기준 POSIX 경로
  line: number; // 1부터
  rule: string;
  message: string;
  text: string;
}

interface Segment {
  kind: "fence" | "inline";
  text: string;
  line: number; // 1부터, 조각이 시작하는 줄
}

// ---------------------------------------------------------------------------
// 대상 파일

export function target_files(root: string): string[] {
  const out: string[] = [];
  const add_dir = (dir: string, only?: (name: string) => boolean): void => {
    const abs = join(root, ...dir.split("/"));
    if (!existsSync(abs)) return;
    for (const name of readdirSync(abs).sort()) {
      if (!name.endsWith(".md")) continue;
      if (only !== undefined && !only(name)) continue;
      out.push(`${dir}/${name}`);
    }
  };
  const skills = join(root, "skills");
  if (existsSync(skills)) {
    for (const name of readdirSync(skills).sort()) {
      if (existsSync(join(skills, name, "SKILL.md"))) out.push(`skills/${name}/SKILL.md`);
    }
  }
  add_dir("agents");
  add_dir("commands");
  add_dir("docs/adapters");
  return out;
}

// ---------------------------------------------------------------------------
// 마크다운 코드 조각

/** 펜스 코드 블록과 한 줄 안의 `인라인 코드`를 뽑는다 (펜스 안은 인라인으로 다시 보지 않는다). */
export function code_segments(markdown: string): Segment[] {
  const out: Segment[] = [];
  const lines = markdown.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const open = /^\s*(`{3,}|~{3,})/.exec(line);
    if (open !== null) {
      const mark = open[1]!;
      const body: string[] = [];
      const start = i + 1;
      i += 1;
      while (i < lines.length && !lines[i]!.trimStart().startsWith(mark)) {
        body.push(lines[i]!);
        i += 1;
      }
      i += 1;
      out.push({ kind: "fence", text: body.join("\n"), line: start + 1 });
      continue;
    }
    for (const m of line.matchAll(/`([^`\n]+)`/g)) out.push({ kind: "inline", text: m[1]!, line: i + 1 });
    i += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 규칙 1 — 업무 상태 직접 쓰기

/** 파일 이름 토큰: 앞뒤가 이름 문자·점·하이픈이 아닌 `project.json` (not-project.json, project.jsonl, project.json.tmp 는 제외). 대소문자는 구분하지 않는다(Windows). */
const PROJECT_JSON = /(?<![\w.-])project\.json(?![\w.])/i;
const LOCK_FILE = /(?<![\w-])\.pes-lock(?![\w])/i;

/** 쓰기 모드 문자열 ("w"·"a"·"x"·"r+"·"wb"…). 읽기 모드("r"·"rb")는 아니다. */
const WRITE_MODE = /^\s*(?:mode\s*=\s*)?["'](?:[wax+][bt]?\+?|r[bt]?\+[bt]?)["']\s*$/i;

type Named = (word: string) => boolean;

/** 쉘 리다이렉트(`>`, `>>`) — `<dir>` 의 `>` 와 구분하려고 앞이 공백·숫자·`&`·줄 처음일 때만 센다. */
function redirect_hits(line: string, named: Named): boolean {
  for (const m of line.matchAll(/(?:^|[\s\d&])>>?\s*(["']?)([^\s|;&<>"']+)\1/g)) {
    if (named(m[2]!)) return true;
  }
  return false;
}

function command_words(piece: string): { cmd: string; args: string[] } | null {
  const words = piece.trim().match(/"[^"]*"|'[^']*'|\S+/g);
  if (words === null) return null;
  const is_flag = (w: string) => w.startsWith("-") || /^\/[A-Za-z](?::\S*)?$/.test(w);
  return { cmd: words[0]!.replace(/^[$>]+/, "").toLowerCase(), args: words.slice(1).filter((w) => !is_flag(w)) };
}

const MOVE_LIKE = /^(?:mv|move|move-item|ren|rename)$/;
const COPY_LIKE = /^(?:cp|ln|install|rsync|copy|xcopy|robocopy|copy-item)$/;

/** cp·mv·copy·Copy-Item 같은 명령의 도착지(마지막 인자)가 대상인지. 이동은 원본도 사라지므로 첫 인자도 본다. */
function destination_hits(line: string, named: Named): boolean {
  for (const piece of line.split(/&&|\|\||;|\|/)) {
    const c = command_words(piece);
    if (c === null || !(MOVE_LIKE.test(c.cmd) || COPY_LIKE.test(c.cmd))) continue;
    if (c.args.length >= 2 && named(c.args[c.args.length - 1]!)) return true;
    if (MOVE_LIKE.test(c.cmd) && c.args.length >= 1 && named(c.args[0]!)) return true;
  }
  return false;
}

/** rm·touch·del 같은 명령은 어느 인자든 대상이면 위반이다. */
function any_arg_hits(line: string, named: Named): boolean {
  for (const piece of line.split(/&&|\|\||;|\|/)) {
    const c = command_words(piece);
    if (c === null || !/^(?:rm|touch|unlink|truncate|shred|del|erase)$/.test(c.cmd)) continue;
    if (c.args.some(named)) return true;
  }
  return false;
}

/** 여는 괄호 `(` 위치에서 짝이 맞는 `)` 까지의 인자를 최상위 쉼표로 나눈다. */
function call_args(text: string, open: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = "";
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quote !== null) {
      cur += ch;
      if (ch === quote && text[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === "(" || ch === "[" || ch === "{") {
      depth += 1;
      if (depth > 1) cur += ch;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      depth -= 1;
      if (depth === 0) {
        args.push(cur.trim());
        return args;
      }
      cur += ch;
    } else if (ch === "," && depth === 1) {
      args.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  args.push(cur.trim());
  return args;
}

/** Python 의 shutil.copy*(원본, 도착지)·shutil.move·os.rename·os.replace: 복사는 도착지만, 이동은 둘 다 본다. */
function call_dest_hits(text: string, named: Named): boolean {
  const CALLS =
    /(?<![\w.])(shutil\.(?:copy2?|copyfile|copyfileobj|copytree|move)|os\.(?:rename|replace|renames|link|symlink)|(?:fs\.(?:promises\.)?)?(?:copyFile(?:Sync)?|cpSync|cp|renameSync|rename|linkSync|symlinkSync)|(?:\[(?:System\.)?IO\.File\]::)(?:Copy|Move|Replace))\(/g;
  for (const m of text.matchAll(CALLS)) {
    const args = call_args(text, m.index! + m[0].length - 1);
    const move = /move|rename|replace|Move|Replace/.test(m[1]!);
    if (args.length >= 2 && (named(args[1]!) || (move && named(args[0]!)))) return true;
  }
  return false;
}

/** 경로를 담은 변수 이름: 같은 조각에서 `f = ...project.json...` 처럼 읽기 없이 경로만 담은 것. */
function path_variables(statements: string[], name: RegExp): Set<string> {
  const vars = new Set<string>();
  const READ = /\bread_text\(|\bread_bytes\(|\bjson\.loads?\(|\breadFile(?:Sync)?\(|\bGet-Content\b|\bcat\b|\bjq\b|\bopen\(/;
  for (const stmt of statements.flatMap((x) => x.split(";"))) {
    const m = /^\s*(?:export\s+|\$|local\s+|const\s+|let\s+|var\s+)?([A-Za-z_]\w*)\s*=(?!=)\s*(.+)$/.exec(stmt);
    if (m === null) continue;
    if (name.test(m[2]!) && !READ.test(m[2]!)) vars.add(m[1]!);
  }
  return vars;
}

function mentions_variable(line: string, vars: Set<string>): boolean {
  for (const v of vars) {
    if (new RegExp(`(?<![\\w.])\\$?\\{?${v}\\}?(?!\\w)`).test(line)) return true;
  }
  return false;
}

interface Statement {
  text: string;
  line: number; // 1부터, 문장이 시작하는 줄
}

/** 줄 나눔을 한 문장으로 합친다: 백슬래시 이음, 줄 끝/줄 처음의 파이프·&&·||, `.메서드` 이어 쓰기, 열린 괄호. 최대 8줄. */
function statements(seg: Segment): Statement[] {
  const lines = seg.text.split("\n");
  const out: Statement[] = [];
  const depth = (s: string) => (s.match(/\(/g)?.length ?? 0) - (s.match(/\)/g)?.length ?? 0);
  let i = 0;
  while (i < lines.length) {
    const start = i;
    let cur = lines[i]!;
    let joined = 0;
    while (i + 1 < lines.length && joined < 8) {
      const tail = cur.trimEnd();
      const next = lines[i + 1]!.trim();
      if (tail.endsWith("\\")) cur = `${tail.slice(0, -1)} ${next}`;
      else if (/(?:\|\||&&|\|)$/.test(tail) || /^(?:\|\||&&|\||\.[A-Za-z_])/.test(next) || depth(tail) > 0) cur = `${tail} ${next}`;
      else break;
      i += 1;
      joined += 1;
    }
    out.push({ text: cur, line: seg.line + (seg.kind === "fence" ? start : 0) });
    i += 1;
  }
  return out;
}

/** `.메서드(` 앞의 수신 식(점 이음·괄호·문자열 포함)을 뒤로 걸어가며 꺼낸다: `Path(d, "x").write_text` → `Path(d, "x")`. */
function receiver(text: string, dot: number): string {
  let i = dot - 1;
  while (i >= 0 && /\s/.test(text[i]!)) i -= 1; // 줄을 나눈 `.메서드` 이어 쓰기
  const end = i + 1;
  while (i >= 0) {
    const ch = text[i]!;
    if (ch === ")" || ch === "]") {
      let depth = 0;
      let quote: string | null = null;
      for (; i >= 0; i -= 1) {
        const c = text[i]!;
        if (quote !== null) {
          if (c === quote) quote = null;
          continue;
        }
        if (c === '"' || c === "'") quote = c;
        else if (c === ")" || c === "]") depth += 1;
        else if (c === "(" || c === "[") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      i -= 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i -= 1;
      while (i >= 0 && text[i] !== ch) i -= 1;
      i -= 1;
      continue;
    }
    if (/[\w.$]/.test(ch)) {
      i -= 1;
      continue;
    }
    break;
  }
  return text.slice(i + 1, end);
}

/**
 * 쓰기 대상만 본다(읽기 인자에 나오는 이름은 위반이 아니다).
 *  - 메서드: 수신 객체가 대상인 `.write_text(`·`.write_bytes(`·`.unlink(`·`.touch(`·`.open(<쓰기 모드>)`,
 *    pathlib `.replace(도착지)`·`.rename(도착지)`(인자 하나 — 원본도 사라지므로 수신·도착지 둘 다)
 *  - 함수: `open(경로, <쓰기 모드>)`, `json.dump(값, 파일)`의 파일, Node `writeFile*`·`appendFile*`·`createWriteStream`·
 *    `unlink*`·`rm*`·`truncate*`, Python `os.remove`·`os.unlink`·`os.truncate`, .NET `WriteAll*`·`AppendAll*`의 첫 인자
 */
function write_call_hits(text: string, named: Named): boolean {
  for (const m of text.matchAll(/\.(write_text|write_bytes|unlink|touch|open|replace|rename)\(/g)) {
    const open = m.index! + m[0].length - 1;
    const args = call_args(text, open);
    const recv = receiver(text, m.index!);
    const method = m[1]!;
    if (method === "open") {
      if (recv !== "" && !/^(?:os|io|codecs|builtins)$/.test(recv) && named(recv) && args.some((a) => WRITE_MODE.test(a))) return true;
      continue;
    }
    if (method === "replace" || method === "rename") {
      if (args.length === 1 && args[0] !== "" && (named(recv) || named(args[0]!))) return true;
      continue;
    }
    if (named(recv)) return true;
  }
  for (const m of text.matchAll(/(?<![\w.])(?:io\.|codecs\.|builtins\.)?open\(/g)) {
    const args = call_args(text, m.index! + m[0].length - 1);
    if (args.length >= 2 && named(args[0]!) && args.slice(1).some((a) => WRITE_MODE.test(a))) return true;
  }
  for (const m of text.matchAll(/\bjson\.dump\(/g)) {
    const args = call_args(text, m.index! + m[0].length - 1);
    if (args.length >= 2 && named(args[1]!)) return true;
  }
  const FIRST_ARG =
    /(?<![\w])(?:fs\.(?:promises\.)?)?(?:writeFile(?:Sync)?|appendFile(?:Sync)?|createWriteStream|unlink(?:Sync)?|rm(?:Sync)?|truncate(?:Sync)?|os\.(?:remove|unlink|truncate)|(?:\[(?:System\.)?IO\.File\]::)?(?:WriteAll(?:Text|Bytes|Lines)|AppendAll(?:Text|Lines)))\(/g;
  for (const m of text.matchAll(FIRST_ARG)) {
    if (text[m.index! - 1] === ".") continue; // pathlib .unlink( 은 위에서 수신 객체로 본다
    const args = call_args(text, m.index! + m[0].length - 1);
    if (args.length >= 1 && named(args[0]!)) return true;
  }
  return false;
}

/** 쉘·PowerShell 명령 조각에서 쓰기 대상 인자만 본다 (파이프 앞의 읽기 명령은 다른 조각이다). */
function shell_write_hits(text: string, named: Named): boolean {
  for (const piece of text.split(/&&|\|\||;|\|/)) {
    const words = piece.trim().match(/"[^"]*"|'[^']*'|\S+/g);
    if (words === null) continue;
    const cmd = words[0]!.replace(/^[$>]+/, "").toLowerCase();
    const rest = words.slice(1);
    const plain = rest.filter((w) => !w.startsWith("-"));
    if (/^(?:tee|sponge|truncate)$/.test(cmd) && plain.some(named)) return true;
    if (cmd === "sed" && rest.some((w) => /^-[A-Za-z]*i|^--in-place/.test(w)) && plain.some(named)) return true;
    if (cmd === "perl" && rest.some((w) => /^-[A-Za-z]*i/.test(w)) && plain.some(named)) return true;
    if (cmd === "dd" && rest.some((w) => w.startsWith("of=") && named(w.slice(3)))) return true;
    if (cmd === "curl" || cmd === "wget") {
      rest.forEach((w, k) => {
        if (/^(?:-o|-O|--output|--output-document)$/.test(w) && rest[k + 1] !== undefined && named(rest[k + 1]!)) throw HIT;
        if (/^--output(?:-document)?=/.test(w) && named(w.slice(w.indexOf("=") + 1))) throw HIT;
      });
    }
    if (/^(?:set-content|add-content|clear-content|out-file|remove-item|rename-item|new-item)$/.test(cmd)) {
      // -Value 뒤의 값은 쓰는 내용이지 대상이 아니다
      const targets = rest.filter((w, k) => !w.startsWith("-") && !/^-(?:value|encoding|itemtype|newname)$/i.test(rest[k - 1] ?? ""));
      if (targets.some(named)) return true;
      if (cmd === "rename-item" || cmd === "move-item") continue;
    }
  }
  return false;
}

const HIT = new Error("hit");

function touch_reason(text: string, named: Named): string | null {
  if (write_call_hits(text, named)) return "쓰기·삭제 명령";
  try {
    if (shell_write_hits(text, named)) return "쓰기·삭제 명령";
  } catch (e) {
    if (e === HIT) return "쓰기·삭제 명령";
    throw e;
  }
  if (redirect_hits(text, named)) return "리다이렉트로 덮어쓰기";
  if (destination_hits(text, named) || call_dest_hits(text, named)) return "복사·이동의 도착지";
  if (any_arg_hits(text, named)) return "삭제·생성 명령";
  return null;
}

interface PathRule {
  name: RegExp;
  rule: string;
  message: (why: string) => string;
  /** 이름이 든 문장에서 이 낱말이 보이면 위반(잠금 파일의 rm·mv 등). */
  loose?: RegExp;
}

function check_paths(seg: Segment, file: string, out: Violation[], r: PathRule): void {
  const stmts = statements(seg);
  const vars = path_variables(stmts.map((x) => x.text), r.name);
  const named: Named = (word) => r.name.test(word) || mentions_variable(word, vars);
  for (const st of stmts) {
    if (!named(st.text)) continue;
    const why = touch_reason(st.text, named) ?? (r.loose?.test(st.text) === true ? "삭제·이동 명령" : null);
    if (why === null) continue;
    out.push({ file, line: st.line, rule: r.rule, message: r.message(why), text: st.text.trim().slice(0, 140) });
  }
}

function check_project_json(seg: Segment, file: string, out: Violation[]): void {
  check_paths(seg, file, out, {
    name: PROJECT_JSON,
    rule: "project.json 직접 쓰기",
    message: (why) => `project.json 을 직접 바꾸는 예제 (${why}) — pes 명령(merge·submit·set·note 등)으로 바꾼다`,
  });
}

/** 업무 표를 바꾸는 SQL. 조각 전체에서 찾아(여러 줄에 걸친 SQL 포함) 줄 번호를 계산한다. */
const SQL_WRITE =
  /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|REPLACE\s+INTO|UPDATE\s+(?:OR\s+\w+\s+)?[\w."`[\]]+\s+SET|DELETE\s+FROM|DROP\s+(?:TABLE|INDEX|VIEW|TRIGGER)|ALTER\s+TABLE|TRUNCATE\s+TABLE|CREATE\s+(?:TEMP(?:ORARY)?\s+)?(?:TABLE|INDEX|VIEW|TRIGGER))\b|(?<![\w.])\.import\s+\S/gi;

function check_sql(seg: Segment, file: string, out: Violation[]): void {
  for (const m of seg.text.matchAll(SQL_WRITE)) {
    const before = seg.text.slice(0, m.index);
    const k = before.split("\n").length - 1;
    const lineno = seg.line + (seg.kind === "fence" ? k : 0);
    const line = seg.text.split("\n")[k] ?? m[0];
    out.push({
      file,
      line: lineno,
      rule: "업무 표 쓰기 SQL",
      message: "업무 표를 SQL 로 바꾸는 예제 — 모든 쓰기는 pes 명령(신뢰 서비스)만 지난다. 읽기(SELECT)만 허용",
      text: line.trim(),
    });
  }
}

function check_lock(seg: Segment, file: string, out: Violation[]): void {
  check_paths(seg, file, out, {
    name: LOCK_FILE,
    rule: "잠금 파일 직접 조작",
    message: (why) => `잠금 파일을 직접 만들거나 지우는 예제 (${why}) — \`lock\`·\`unlock\` 명령이 다룬다`,
    loose: /\b(?:rm|mv|touch|unlink|remove)\b/i,
  });
}

// ---------------------------------------------------------------------------
// 규칙 2 — Claude 전용 표기는 어댑터 노트에만

const CLAUDE_ONLY: { re: RegExp; what: string }[] = [
  { re: /anthropic-skills:/, what: "anthropic-skills:* (변환 스킬 이름)" },
  { re: /AskUserQuestion/, what: "AskUserQuestion (사용자에게 고르게 하는 Claude 도구)" },
  { re: /\(Agent[,)]/, what: "(Agent, …) 서브에이전트 호출 표기" },
  { re: /\bAgent\s*(?:도구|tool\b)/, what: "Agent 도구" },
  { re: /\bTask\s*(?:도구|tool\b)/, what: "Task 도구" },
  { re: /`(?:Agent|Task)`/, what: "`Agent`·`Task` 도구 이름" },
  { re: /\bTask\(/, what: "Task( 호출 꼴" },
];

function check_claude_marks(text: string, file: string, out: Violation[]): void {
  text.split("\n").forEach((line, k) => {
    for (const { re, what } of CLAUDE_ONLY) {
      if (!re.test(line)) continue;
      out.push({
        file,
        line: k + 1,
        rule: "Claude 전용 표기",
        message: `${what} — 중립 문서에는 두지 않는다. docs/adapters/ 의 어댑터 노트로 옮긴다`,
        text: line.trim().slice(0, 120),
      });
    }
  });
}

// ---------------------------------------------------------------------------
// 실행

export function lint(root: string): { files: number; violations: Violation[] } {
  const files = target_files(root);
  const violations: Violation[] = [];
  for (const rel of files) {
    const text = readFileSync(join(root, ...rel.split("/")), "utf8").replace(/\r\n/g, "\n");
    for (const seg of code_segments(text)) {
      check_project_json(seg, rel, violations);
      check_sql(seg, rel, violations);
      check_lock(seg, rel, violations);
    }
    if (!rel.startsWith("docs/adapters/")) check_claude_marks(text, rel, violations);
  }
  violations.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
  return { files: files.length, violations };
}

function main(): number {
  const here = dirname(fileURLToPath(import.meta.url));
  const arg = process.argv[2];
  const root = arg !== undefined && arg !== "" ? resolve(arg) : resolve(here, "..");
  const { files, violations } = lint(root);
  if (violations.length === 0) {
    process.stdout.write(`lint:skills 통과 (문서 ${files}개)\n`);
    return 0;
  }
  const lines = violations.map((v) => `${v.file}:${v.line}: [${v.rule}] ${v.message}\n    ${v.text}`);
  process.stderr.write(`${lines.join("\n")}\nlint:skills 실패 — 위반 ${violations.length}건 (문서 ${files}개 검사)\n`);
  return 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
