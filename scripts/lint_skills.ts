// 스킬·에이전트·명령 문서 lint (stage 2 PR17).
//
// 사용: node scripts/lint_skills.ts [루트]      (npm run lint:skills)
//
// 막는 것은 네 가지뿐이다.
//   1. 업무 상태를 직접 바꾸는 경로 — 코드 블록·인라인 코드(명령 예제) 안의
//      project.json 쓰기, 업무 표(sqlite) 쓰기 SQL, 잠금 파일(.pes-lock) 조작.
//      산문 문장은 보지 않는다("project.json 을 직접 고치지 않는다" 같은 정상 문장을 막지 않기 위해).
//   3. Python 호출 — 코드 블록·인라인 코드 안에서 파이썬 인터프리터로 파이썬 파일을 부르는 꼴·Windows 런처·표준입력 프로그램 (SEL-74: PES 도구는 `node …/scripts/pes.ts`·`setup.ts`).
//      산문에서 Python 이라는 낱말을 말하는 것은 막지 않는다.
//      자식 제안 파일(rounds/ 아래 결과 JSON 등)·읽기·이름만 적은 언급은 허용한다.
//   4. 앱 열기 호출 (SEL-85) — 코드 블록·인라인 코드 안의 `pes open … --app`. 이 명령은 소유자 세션을 1회용 코드로 바꿔 브라우저 주소에 싣는
//      사람 전용 명령이다. 에이전트·스킬이 부르면 안 된다(open 하위 명령과 --app 옵션이 한 명령에 같이 있는 꼴, 옵션 위치·경로·변수 slug 불문).
//      산문 문장("… --app 을 부르지 않는다")은 보지 않는다.
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

/** 쉘 명령 구분자(`&&`·`||`·`;`·`|`)로 나눈다. 괄호 묶음 `( … )` 안의 구분자는 나누지 않는다(괄호가 안 맞으면 단순 분리). */
function split_pieces(text: string): string[] {
  const pieces: string[] = [];
  let cur = "";
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === "(") depth += 1;
    else if (ch === ")" && depth > 0) depth -= 1;
    if (depth === 0) {
      if (ch === ";" || ch === "|") {
        pieces.push(cur);
        cur = "";
        if (ch === "|" && text[i + 1] === "|") i += 1;
        continue;
      }
      if (ch === "&" && text[i + 1] === "&") {
        pieces.push(cur);
        cur = "";
        i += 1;
        continue;
      }
    }
    cur += ch;
  }
  if (depth !== 0) return text.split(/&&|\|\||;|\|/);
  pieces.push(cur);
  return pieces;
}

/** 명령 조각 목록. `( … )` 로 묶은 하위 쉘이 조각 전체이면 그 안을 다시 나눈다. */
function pieces_of(text: string): string[] {
  const out: string[] = [];
  for (const p of split_pieces(text)) {
    const t = p.trim();
    if (t.startsWith("(") && t.endsWith(")")) out.push(...pieces_of(t.slice(1, -1)));
    else out.push(p);
  }
  return out;
}

/** 쉘 낱말 나누기: 따옴표와 괄호 묶음(`(Get-Content "x")`, `$(…)`)은 한 낱말이다. 따옴표가 닫히지 않으면 단순 분리. */
function shell_words(piece: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let depth = 0;
  for (const ch of piece) {
    if (quote !== null) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")" && depth > 0) depth -= 1;
    if (depth === 0 && /\s/.test(ch)) {
      if (cur !== "") out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (quote !== null) return piece.trim().match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  if (cur !== "") out.push(cur);
  return out;
}

/** 입력 리다이렉트(`< 파일`, `<파일`, `<< 표지`, `<<< 문자열`, `<(…)`)와 그 파일은 읽기이므로 낱말에서 뺀다. `<dir>` 같은 자리표시자는 남긴다. */
function without_input_redirects(words: string[]): string[] {
  const out: string[] = [];
  for (let k = 0; k < words.length; k += 1) {
    const w = words[k]!;
    if (/^\d*<{1,3}-?$/.test(w)) {
      k += 1;
      continue;
    }
    if (/^\d*<(?:\(|[^<>(]*$)/.test(w) && w !== "<") continue;
    out.push(w);
  }
  return out;
}

function command_words(piece: string): { cmd: string; args: string[]; raw: string[] } | null {
  const words = without_input_redirects(shell_words(piece));
  if (words.length === 0) return null;
  const is_flag = (w: string) => w.startsWith("-") || /^\/[A-Za-z](?::\S*)?$/.test(w);
  const raw = words.slice(1);
  return { cmd: words[0]!.replace(/^[$>]+/, "").toLowerCase(), args: raw.filter((w) => !is_flag(w)), raw };
}

const MOVE_LIKE = /^(?:mv|move|move-item|ren|rename)$/;
const COPY_LIKE = /^(?:cp|ln|install|rsync|copy|xcopy|robocopy|copy-item)$/;

/**
 * PowerShell 의 Copy-Item·Move-Item 식 이름 붙은 인자: `-Path`(원본)·`-Destination`(도착지), 이름 없는 낱말은 남은 자리에 차례로 들어간다.
 * 이름 붙은 인자가 하나도 없으면 null (일반 cp·mv 규칙을 쓴다).
 */
function ps_copy_args(raw: string[]): { src?: string; dest?: string } | null {
  let src: string | undefined;
  let dest: string | undefined;
  let named_seen = false;
  const positional: string[] = [];
  for (let k = 0; k < raw.length; k += 1) {
    const w = raw[k]!;
    const m = /^-([A-Za-z]+)(?::(.*))?$/.exec(w);
    if (m === null) {
      if (!w.startsWith("-")) positional.push(w);
      continue;
    }
    const name = m[1]!.toLowerCase();
    const kind = /^(?:path|literalpath|pspath)$/.test(name)
      ? "src"
      : name.length >= 4 && "destination".startsWith(name)
        ? "dest"
        : /^(?:filter|include|exclude|credential|fromsession|tosession|stream)$/.test(name)
          ? "skip"
          : null;
    if (kind === null) continue;
    let value = m[2];
    if (value === undefined) {
      value = raw[k + 1];
      k += 1;
    }
    if (value === undefined) continue;
    if (kind === "src") {
      src = value;
      named_seen = true;
    } else if (kind === "dest") {
      dest = value;
      named_seen = true;
    }
  }
  if (!named_seen) return null;
  for (const w of positional) {
    if (src === undefined) src = w;
    else if (dest === undefined) dest = w;
  }
  return { src, dest };
}

/** cp·mv·copy·Copy-Item 같은 명령의 도착지(마지막 인자)가 대상인지. 이동은 원본도 사라지므로 첫 인자도 본다. */
function destination_hits(line: string, named: Named): boolean {
  for (const piece of pieces_of(line)) {
    const c = command_words(piece);
    if (c === null || !(MOVE_LIKE.test(c.cmd) || COPY_LIKE.test(c.cmd))) continue;
    const move = MOVE_LIKE.test(c.cmd);
    const ps = ps_copy_args(c.raw);
    if (ps !== null) {
      if (ps.dest !== undefined && named(ps.dest)) return true;
      if (move && ps.src !== undefined && named(ps.src)) return true;
      continue;
    }
    if (c.args.length >= 2 && named(c.args[c.args.length - 1]!)) return true;
    if (move && c.args.length >= 1 && named(c.args[0]!)) return true;
  }
  return false;
}

/** rm·touch·del 같은 명령은 어느 인자든 대상이면 위반이다. */
function any_arg_hits(line: string, named: Named): boolean {
  for (const piece of pieces_of(line)) {
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

/** Node 의 fs 모듈을 가리키는 수신 식: `fs`·`fsp`·`fsPromises`·`fs.promises`·`require(...)`(+`.promises`). */
const NODE_RECV = /^(?:(?:fs|fsp|fsPromises|fse|promises)(?:\.promises)?|require\([^()]*\)(?:\.promises)?)$/;

/** Python 의 shutil.copy*(원본, 도착지)·shutil.move·os.rename·os.replace, Node 의 copyFile*·cp*·rename*·link*·symlink*: 복사는 도착지만, 이동은 둘 다 본다. */
function call_dest_hits(text: string, named: Named): boolean {
  const CALLS =
    /(?<![\w.])(shutil\.(?:copy2?|copyfile|copyfileobj|copytree|move)|os\.(?:rename|replace|renames|link|symlink)|(?:\[(?:System\.)?IO\.File\]::)(?:Copy|Move|Replace))\(/g;
  for (const m of text.matchAll(CALLS)) {
    const args = call_args(text, m.index! + m[0].length - 1);
    const move = /move|rename|replace|Move|Replace/.test(m[1]!);
    if (args.length >= 2 && (named(args[1]!) || (move && named(args[0]!)))) return true;
  }
  // Node: 맨 함수(`import { rename }`)이거나 수신이 fs 모듈일 때만 (그 밖의 `.rename(` 은 pathlib 이라 따로 본다)
  const NODE_CALLS = /(?<![\w$])(copyFile(?:Sync)?|cpSync|cp|renameSync|rename|linkSync|link|symlinkSync|symlink)\(/g;
  for (const m of text.matchAll(NODE_CALLS)) {
    if (text[m.index! - 1] === "." && !NODE_RECV.test(receiver(text, m.index! - 1))) continue;
    const args = call_args(text, m.index! + m[0].length - 1);
    const move = /^rename/.test(m[1]!);
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
  let after_word = false; // 직전에 이름 문자를 걸었으면 그 앞의 따옴표는 바깥 문자열의 여는 따옴표다
  while (i >= 0) {
    const ch = text[i]!;
    if (ch === ")" || ch === "]") {
      after_word = false;
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
      if (after_word) break;
      const open = text.lastIndexOf(ch, i - 1);
      if (open < 0) break;
      i = open - 1;
      continue;
    }
    if (/[\w.$]/.test(ch)) {
      after_word = true;
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
  for (const m of text.matchAll(/\.(write_text|write_bytes|unlink|touch|open|replace|rename|symlink_to|hardlink_to)\(/g)) {
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
    /(?<![\w])(?:writeFile(?:Sync)?|appendFile(?:Sync)?|createWriteStream|unlink(?:Sync)?|rm(?:Sync)?|truncate(?:Sync)?|os\.(?:remove|unlink|truncate)|(?:\[(?:System\.)?IO\.File\]::)?(?:WriteAll(?:Text|Bytes|Lines)|AppendAll(?:Text|Lines)))\(/g;
  for (const m of text.matchAll(FIRST_ARG)) {
    // 앞이 점이면 수신이 fs 모듈일 때만 Node 호출이다 (pathlib .unlink( 은 위에서 수신 객체로 본다)
    if (text[m.index! - 1] === "." && !NODE_RECV.test(receiver(text, m.index! - 1))) continue;
    const args = call_args(text, m.index! + m[0].length - 1);
    if (args.length >= 1 && named(args[0]!)) return true;
  }
  return false;
}

/** PowerShell 쓰기 cmdlet 의 이름 없는 인자 자리 (t = 대상 경로, o = 내용·인코딩·새 이름 등 대상이 아닌 값). */
const PS_SLOTS = new Map<string, ("t" | "o")[]>([
  ["set-content", ["t", "o"]],
  ["add-content", ["t", "o"]],
  ["clear-content", ["t"]],
  ["out-file", ["t", "o"]],
  ["remove-item", ["t"]],
  ["rename-item", ["t", "t"]], // 새 이름도 만들어지는 파일 이름이다
  ["new-item", ["t", "t"]],
]);

/**
 * PowerShell cmdlet 의 쓰기 대상만 골라낸다: 이름 붙은 `-Path`·`-LiteralPath`·`-FilePath`·`-Name` 의 값,
 * 이름 없는 낱말은 남은 자리에 차례로(`Set-Content 경로 값`). `-Value (…)`·두 번째 위치 인자·`(…)` 괄호 식 값은 쓰는 내용이지 대상이 아니다.
 */
function ps_targets(cmd: string, rest: string[]): string[] {
  const order = [...PS_SLOTS.get(cmd)!];
  const targets: string[] = [];
  const positional: string[] = [];
  for (let k = 0; k < rest.length; k += 1) {
    const w = rest[k]!;
    const m = /^-([A-Za-z]+)(?::(.*))?$/.exec(w);
    if (m === null) {
      if (!w.startsWith("-")) positional.push(w);
      continue;
    }
    const name = m[1]!.toLowerCase();
    const slot = /^(?:path|literalpath|filepath|pspath|name|newname)$/.test(name)
      ? "t"
      : /^(?:value|encoding|itemtype|inputobject)$/.test(name)
        ? "o"
        : /^(?:filter|include|exclude|stream|width|credential|delimiter)$/.test(name)
          ? "skip"
          : null;
    if (slot === null) continue; // -Force·-Append·-NoNewline 같은 스위치
    if (m[2] === undefined) k += 1;
    if (slot === "skip") continue;
    const value = m[2] ?? rest[k] ?? "";
    const at = order.indexOf(slot);
    if (at >= 0) order.splice(at, 1);
    if (slot === "t") targets.push(value);
  }
  const fallback = cmd === "remove-item" || cmd === "clear-content" ? "t" : "o";
  positional.forEach((w, k) => {
    if ((order[k] ?? fallback) === "t") targets.push(w);
  });
  return targets;
}

/** 쉘·PowerShell 명령 조각에서 쓰기 대상 인자만 본다 (파이프 앞의 읽기 명령은 다른 조각이다). */
function shell_write_hits(text: string, named: Named): boolean {
  for (const piece of pieces_of(text)) {
    const words = without_input_redirects(shell_words(piece));
    if (words.length === 0) continue;
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
    if (PS_SLOTS.has(cmd) && ps_targets(cmd, rest).some(named)) return true;
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
// 규칙 3 — Python 호출 (SEL-74)

/** 인터프리터 + (옵션 `-I`·`-X utf8` …) + 파이썬 파일, Windows 런처의 3 버전 옵션, 표준입력으로 프로그램을 읽는 `python3 -I -`·`python3 - <<` (`-` 바로 뒤가 줄 끝이나 `<`; 인자가 붙은 읽기 전용 히어독은 잡지 않는다). */
const PYTHON_CALL = /\b(?:python3?|py)(?:\.exe)?\b(?:\s+(?:-\S+|utf8))*\s+\S*\.py\b|\bpy\s+-3\b|\bpython3?(?:\.exe)?\s+(?:-I\s+)?-\s*(?:<|$)/i;

function check_python(seg: Segment, file: string, out: Violation[]): void {
  seg.text.split("\n").forEach((line, k) => {
    if (!PYTHON_CALL.test(line)) return;
    out.push({
      file,
      line: seg.line + (seg.kind === "fence" ? k : 0),
      rule: "Python 호출",
      message: "Python 으로 PES 도구를 부르는 예제 — `node ${CLAUDE_PLUGIN_ROOT}/scripts/pes.ts`·`setup.ts` 로 부른다",
      text: line.trim().slice(0, 140),
    });
  });
}

// ---------------------------------------------------------------------------
// 규칙 4 — `pes open … --app` 거절 (SEL-85)

const unquote = (word: string): string => word.replace(/^["']+|["']+$/g, "");

/** 한 명령 조각이 `<pes 실행 파일> open … --app …` 인가: `open` 바로 앞 낱말이 pes / pes.ts (경로·따옴표 붙어도) 이고 뒤에 `--app` 낱말이 있다. */
function is_open_app(piece: string): boolean {
  const words = shell_words(piece).map(unquote);
  for (let i = 1; i < words.length; i += 1) {
    if (words[i] !== "open" || !/(?:^|[\\/])pes(?:\.ts)?$/.test(words[i - 1]!)) continue;
    if (words.slice(i + 1).includes("--app")) return true;
  }
  return false;
}

function check_open_app(seg: Segment, file: string, out: Violation[]): void {
  for (const st of statements(seg)) {
    if (!pieces_of(st.text).some(is_open_app)) continue;
    out.push({
      file,
      line: st.line,
      rule: "앱 열기 호출",
      message: "`pes open … --app` 는 사람이 터미널에서 직접 여는 명령이다(소유자 세션을 코드로 바꿔 주소에 싣는다) — 에이전트·스킬·명령 문서가 부르지 않는다",
      text: st.text.trim().slice(0, 140),
    });
  }
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
      check_python(seg, rel, violations);
      check_open_app(seg, rel, violations);
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
