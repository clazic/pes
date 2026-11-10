// SEL-50 (stage 2 PR17) 시험 공용 준비물: 스킬·에이전트·명령 문서를 읽고, 코드 조각과 pes 명령을 뽑고,
// lint(scripts/lint_skills.ts)를 자식 프로세스로 돌린다. 전부 합성 입력이며 실제 ~/pes-projects·~/.pes 는 건드리지 않는다.
//
// Windows 점검표: 문서는 CRLF → LF 로 정규화해서 읽고, 자식 Node/Python 은 UTF-8 로 띄우고(-X utf8),
// 경로는 node:path 로만 만들며, `which`·sh·tar 에 기대지 않는다.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, "..", "..");
export const PES_PY = join(REPO, "scripts", "pes.py");
export const LINT_TS = join(REPO, "scripts", "lint_skills.ts");

export const STAGES = ["plan", "research", "analyze", "write", "verify", "publish"] as const;

/** LF 로 정규화해서 읽는다 (Windows 체크아웃의 CRLF 대비). */
export function read_text(path: string): string {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

export function repo_doc(rel: string): string {
  return read_text(join(REPO, ...rel.split("/")));
}

/** 저장소 안의 lint 대상 문서 상대 경로(POSIX 표기). docs/adapters 는 아직 없을 수 있다. */
export function target_docs(root = REPO): string[] {
  const out: string[] = [];
  const add = (dir: string) => {
    const abs = join(root, ...dir.split("/"));
    if (!existsSync(abs)) return;
    for (const name of readdirSync(abs).sort()) if (name.endsWith(".md")) out.push(`${dir}/${name}`);
  };
  const skills = join(root, "skills");
  for (const skill of existsSync(skills) ? readdirSync(skills).sort() : []) {
    if (existsSync(join(skills, skill, "SKILL.md"))) out.push(`skills/${skill}/SKILL.md`);
  }
  add("agents");
  add("commands");
  add("docs/adapters");
  return out;
}

// ---------------------------------------------------------------------------
// 마크다운 코드 조각

export interface Segment {
  kind: "fence" | "inline";
  lang: string;
  text: string;
  line: number; // 1부터, 조각이 시작하는 줄
}

/** 펜스 코드 블록과 한 줄 안의 `인라인 코드`를 뽑는다 (펜스 안은 인라인으로 다시 보지 않는다). */
export function code_segments(markdown: string): Segment[] {
  const out: Segment[] = [];
  const lines = markdown.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const open = /^\s*(`{3,}|~{3,})\s*([\w+-]*)/.exec(line);
    if (open !== null) {
      const fence_mark = open[1]!;
      const body: string[] = [];
      const start = i + 1;
      i += 1;
      while (i < lines.length && !lines[i]!.trimStart().startsWith(fence_mark)) {
        body.push(lines[i]!);
        i += 1;
      }
      i += 1;
      out.push({ kind: "fence", lang: open[2] ?? "", text: body.join("\n"), line: start + 1 });
      continue;
    }
    for (const m of line.matchAll(/`([^`\n]+)`/g)) out.push({ kind: "inline", lang: "", text: m[1]!, line: i + 1 });
    i += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// pes 명령

/** scripts/pes.py 의 CMDS 사전에 있는 명령 이름 (v0.15 + 새 5개). */
export function pes_cmds(): string[] {
  const src = read_text(PES_PY);
  const start = src.indexOf("\nCMDS = {");
  if (start < 0) throw new Error("scripts/pes.py 에 CMDS 사전이 없다");
  const end = src.indexOf("}", start);
  const names = [...src.slice(start, end).matchAll(/"([a-z][a-z-]*)"\s*:/g)].map((m) => m[1]!);
  if (names.length < 30) throw new Error(`CMDS 파싱 결과가 너무 적다: ${names.length}`);
  return names;
}

const PREFIX = /^(?:\$\{?PES\}?|pes(?:\.py)?|(?:python3?|py(?:\s+-3)?)\s+(?:-X\s+utf8\s+)?-I\s+\S*pes\.py|\S*\/pes\.py)\s+([a-z][a-z-]*)\b/;

/** 코드 조각 한 줄에서 `$PES <명령>` 꼴로 부른 명령 이름 (없으면 null). */
export function explicit_command(line: string): string | null {
  const trimmed = line.trim().replace(/^[$>]\s+/, "").replace(/^\w+=\S+\s+/, "");
  const m = PREFIX.exec(trimmed);
  return m === null ? null : m[1]!;
}

/** 문서가 부르거나 소개하는 pes 명령 집합: `$PES x ...` 호출 + 코드 조각이 `x <dir> ...` 처럼 명령으로 시작하는 꼴. */
export function mentioned_commands(markdown: string, known: readonly string[]): Set<string> {
  const found = new Set<string>();
  const known_set = new Set(known);
  for (const seg of code_segments(markdown)) {
    for (const raw of seg.text.split("\n")) {
      for (const piece of raw.split(/&&|\|\||;/)) {
        const explicit = explicit_command(piece);
        if (explicit !== null) found.add(explicit);
        const first = /^\s*(?:\$\{?PES\}?\s+)?([a-z][a-z-]*)(?=\s|$)/.exec(piece);
        if (first !== null && known_set.has(first[1]!)) found.add(first[1]!);
      }
    }
  }
  return found;
}

/** 문서 안에서 `$PES <이름>` 으로 부른 이름 중 pes.py 에 없는 것. */
export function unknown_invocations(markdown: string, known: readonly string[]): string[] {
  const known_set = new Set(known);
  const bad = new Set<string>();
  for (const seg of code_segments(markdown)) {
    for (const raw of seg.text.split("\n")) {
      for (const piece of raw.split(/&&|\|\||;|\|/)) {
        const name = explicit_command(piece);
        if (name !== null && !known_set.has(name)) bad.add(name);
      }
    }
  }
  return [...bad].sort();
}

// ---------------------------------------------------------------------------
// 합성 트리 + lint 실행

export interface Tree {
  root: string;
  write(rel: string, text: string): void;
  cleanup(): void;
}

export function make_tree(files: Record<string, string> = {}): Tree {
  const root = resolve(realpathSync.native(mkdtempSync(join(tmpdir(), "pes-sel50-lint-"))));
  const tree: Tree = {
    root,
    write(rel, text) {
      const abs = join(root, ...rel.split("/"));
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, text, "utf8");
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
  for (const [rel, text] of Object.entries(files)) tree.write(rel, text);
  return tree;
}

export interface LintRun {
  status: number | null;
  out: string; // stdout + stderr, LF 정규화
}

/** `node scripts/lint_skills.ts <root>` — lint 의 바깥 계약만 쓴다: 위반이 있으면 종료 코드 != 0, 출력에 위반 파일 경로. */
export function run_lint(root: string): LintRun {
  const res = spawnSync(process.execPath, [LINT_TS, root], {
    env: { ...process.env, PYTHONUTF8: "1" } as NodeJS.ProcessEnv,
    encoding: "utf8",
    timeout: 60_000,
  });
  if (res.error !== undefined) throw res.error;
  return { status: res.status, out: `${res.stdout ?? ""}${res.stderr ?? ""}`.replace(/\r\n/g, "\n") };
}

export function fence(lang: string, ...body: string[]): string {
  return ["```" + lang, ...body, "```"].join("\n");
}

/** 정상 문서 한 편: 제목 + 설명 + 본문 조각. */
export function doc(...parts: string[]): string {
  return ["# 합성 문서", "", "설명 문장이다.", "", ...parts, ""].join("\n");
}
