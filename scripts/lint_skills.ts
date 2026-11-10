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

/** 파일 이름 토큰: 앞뒤가 이름 문자·점·하이픈이 아닌 `project.json` (not-project.json, project.jsonl, project.json.tmp 는 제외). */
const PROJECT_JSON = /(?<![\w.-])project\.json(?![\w.])/;
const LOCK_FILE = /(?<![\w-])\.pes-lock(?![\w])/;

/** 쓰기·삭제·이동을 뜻하는 낱말 (프로젝트 JSON·잠금 파일 공통). */
const WRITE_VERB =
  /\.write_text\(|\.write_bytes\(|\bjson\.dump\(|\.unlink\(|\bos\.(?:remove|unlink|rename|replace)\(|\bshutil\.(?:move|copy\w*)\(|\bwriteFile(?:Sync)?\(|\bappendFile(?:Sync)?\(|\bcreateWriteStream\(|\brenameSync\(|\bunlinkSync\(|\brmSync\(|\bSet-Content\b|\bAdd-Content\b|\bOut-File\b|\bRemove-Item\b|\bMove-Item\b|\bCopy-Item\b|\bNew-Item\b|\bsed\s+(?:-[A-Za-z]*i|--in-place)|\btee\b|\btruncate\b|\bopen\(.*,\s*(?:mode\s*=\s*)?["'][wax+]b?\+?["']|\bmode\s*=\s*["'][wax+]/;

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
  return { cmd: words[0]!.replace(/^[$>]+/, ""), args: words.slice(1).filter((w) => !w.startsWith("-")) };
}

/** cp·mv·ln 의 도착지(마지막 인자)가 대상인지. mv 는 원본도 사라지므로 첫 인자도 본다. */
function destination_hits(line: string, named: Named): boolean {
  for (const piece of line.split(/&&|\|\||;|\|/)) {
    const c = command_words(piece);
    if (c === null || !/^(?:cp|mv|ln|install|rsync)$/.test(c.cmd)) continue;
    if (c.args.length >= 2 && named(c.args[c.args.length - 1]!)) return true;
    if (c.cmd === "mv" && c.args.length >= 1 && named(c.args[0]!)) return true;
  }
  return false;
}

/** rm·touch·unlink 같은 명령은 어느 인자든 대상이면 위반이다. */
function any_arg_hits(line: string, named: Named): boolean {
  for (const piece of line.split(/&&|\|\||;|\|/)) {
    const c = command_words(piece);
    if (c === null || !/^(?:rm|touch|unlink|truncate|shred)$/.test(c.cmd)) continue;
    if (c.args.some(named)) return true;
  }
  return false;
}

/** project.json 경로를 담은 변수 이름: 같은 조각에서 `f = ...project.json...` 처럼 읽기 없이 경로만 담은 것. */
function path_variables(text: string): Set<string> {
  const vars = new Set<string>();
  const READ = /\bread_text\(|\bread_bytes\(|\bjson\.loads?\(|\breadFile(?:Sync)?\(|\bGet-Content\b|\bcat\b|\bjq\b|\bopen\(/;
  for (const stmt of text.split(/[;\n]/)) {
    const m = /^\s*(?:export\s+|\$|local\s+|const\s+|let\s+|var\s+)?([A-Za-z_]\w*)\s*=(?!=)\s*(.+)$/.exec(stmt);
    if (m === null) continue;
    if (PROJECT_JSON.test(m[2]!) && !READ.test(m[2]!)) vars.add(m[1]!);
  }
  return vars;
}

function mentions_variable(line: string, vars: Set<string>): boolean {
  for (const v of vars) {
    if (new RegExp(`(?<![\\w.])\\$?\\{?${v}\\}?(?!\\w)`).test(line)) return true;
  }
  return false;
}

function check_project_json(seg: Segment, file: string, out: Violation[]): void {
  const vars = path_variables(seg.text);
  const named: Named = (word) => PROJECT_JSON.test(word) || mentions_variable(word, vars);
  seg.text.split("\n").forEach((line, k) => {
    if (!named(line)) return;
    let why: string | null = null;
    if (WRITE_VERB.test(line)) why = "쓰기·삭제·이동 명령";
    else if (redirect_hits(line, named)) why = "리다이렉트로 덮어쓰기";
    else if (destination_hits(line, named)) why = "cp/mv 의 도착지";
    else if (any_arg_hits(line, named)) why = "삭제·생성 명령";
    if (why === null) return;
    out.push({
      file,
      line: seg.line + (seg.kind === "fence" ? k : 0),
      rule: "project.json 직접 쓰기",
      message: `project.json 을 직접 바꾸는 예제 (${why}) — pes 명령(merge·submit·note 등)으로 바꾼다`,
      text: line.trim(),
    });
  });
}

/** 업무 표를 바꾸는 SQL. 조각 전체에서 찾아(여러 줄에 걸친 SQL 포함) 줄 번호를 계산한다. */
const SQL_WRITE =
  /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|REPLACE\s+INTO|UPDATE\s+(?:OR\s+\w+\s+)?[\w."`[\]]+\s+SET|DELETE\s+FROM|DROP\s+(?:TABLE|INDEX|VIEW|TRIGGER)|ALTER\s+TABLE|TRUNCATE\s+TABLE)\b/gi;

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

const is_lock: Named = (word) => LOCK_FILE.test(word);

function check_lock(seg: Segment, file: string, out: Violation[]): void {
  seg.text.split("\n").forEach((line, k) => {
    if (!LOCK_FILE.test(line)) return;
    const lineno = seg.line + (seg.kind === "fence" ? k : 0);
    const touches =
      WRITE_VERB.test(line) ||
      redirect_hits(line, is_lock) ||
      destination_hits(line, is_lock) ||
      any_arg_hits(line, is_lock) ||
      /\b(?:rm|mv|touch|unlink|remove)\b/.test(line);
    if (!touches) return;
    out.push({
      file,
      line: lineno,
      rule: "잠금 파일 직접 조작",
      message: "잠금 파일을 직접 만들거나 지우는 예제 — `lock`·`unlock` 명령이 다룬다",
      text: line.trim(),
    });
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
