/**
 * SEL-50 PR17 — 스킬 문서 보강 시험 (tester, 보강 모드).
 *
 * (A) 문서의 pes 명령 예제가 pes.py 사용법(맨 위 설명)의 인자 형식과 맞는지 — 필수 인자 수·위치(<dir> 다음 <stage> 등)를 사용법에서 뽑아 검증한다.
 * (B) 문서 개편 뒤에도 절차 유지 시험이 의미 있게 잡는지 — 개편 이전(PR16 병합 36bc6a2) 문서의 명령·절 제목이 지금도 남아 있는지,
 *     그리고 절차 유지 시험의 줄 수 하한이 지금 문서 크기와 너무 멀어 무뎌지지 않았는지.
 * 순수 읽기 시험이라 Python 을 띄우지 않는다.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { code_segments, mentioned_commands, PES_USAGE, pes_cmds, read_text, REPO, repo_doc, target_docs } from "./helpers/skill_docs.ts";

const CMDS = pes_cmds();
const STAGE_WORD = /^(?:plan|research|analyze|write|verify|publish|resume|<[^>]*(?:stage|단계)[^>]*>|"?\$\{?(?:S|STAGE|STG|stage|st)\}?"?)$/;

// ---------------------------------------------------------------------------
// (A) 사용법 파싱

interface Spec {
  cmd: string;
  min: number; // 필수 위치 인자
  max: number; // 위치 인자 최대 (Infinity = 가변)
  second_is_stage: boolean;
  line: string;
}

/** pes.ts 사용법(scripts/pes_core/cli_usage.ts)의 `  명령 인자들   설명` 줄을 읽는다. 같은 명령이 여러 줄이면 모두 후보다. */
export function usage_specs(): Spec[] {
  const doc = PES_USAGE;
  const specs: Spec[] = [];
  for (const raw of doc.split("\n")) {
    const m = /^ {2}([a-z][a-z-]*)\s+(\S.*?)(?:\s{3,}\S.*)?$/.exec(raw);
    if (m === null || !CMDS.includes(m[1]!)) continue;
    const cmd = m[1]!;
    // 설명 앞까지만: 인자 부분은 첫 번째 '  ' 두 칸 이상 공백 전까지
    const args_part = raw.slice(2 + cmd.length).split(/\s{3,}/)[0]!.trim();
    let min = 0;
    let max = 0;
    let variadic = false;
    let second_is_stage = false;
    let depth = 0;
    let index = 0;
    for (const tok of args_part.match(/\[[^\]]*\]|<[^>]*>|"[^"]*"|--\S+(?:\s+(?![\[<-])\S+)?|\S+/g) ?? []) {
      if (tok.startsWith("--")) continue;
      if (!/^[<\["]/.test(tok)) break; // 사용법 인자 뒤에 오는 설명 낱말
      depth = tok.startsWith("[") ? 1 : 0;
      if (tok.includes("...") || tok.includes("…")) variadic = true;
      if (tok.startsWith("[") && /^\[--/.test(tok)) continue; // 선택 플래그
      index += 1;
      if (index === 2 && /stage/.test(tok)) second_is_stage = true;
      if (depth === 1) {
        max += tok.includes("|") ? 2 : 1;
      } else {
        min += 1;
        max += 1;
      }
    }
    specs.push({ cmd, min, max: variadic ? Infinity : max, second_is_stage, line: raw.trim().slice(0, 80) });
  }
  return specs;
}

const VALUE_FLAGS = new Set(["--topic", "--slug", "--import", "--file", "--round", "--fields", "--from"]);

/** 코드 조각 줄에서 `$PES <명령> …` 로 부른 (명령, 위치 인자들). */
export function calls_in(markdown: string): Array<{ cmd: string; args: string[]; where: string }> {
  const out: Array<{ cmd: string; args: string[]; where: string }> = [];
  for (const seg of code_segments(markdown)) {
    seg.text.split("\n").forEach((line, k) => {
      for (const m of line.matchAll(/(?:\$\{?PES\}?|\bpes\.py)\s+([a-z][a-z-]*)([^\n]*)/g)) {
        const name = m[1]!;
        if (!CMDS.includes(name)) continue;
        const toks = m[2]!.match(/"[^"]*"|'[^']*'|<[^>]*>|\S+/g) ?? [];
        const args: string[] = [];
        for (let i = 0; i < toks.length; i++) {
          let t = toks[i]!;
          if (["|", "||", "&&", ";", ">", ">>", "2>", "#", "<<"].includes(t) || t.startsWith("#") || t.startsWith("<<") || t.startsWith(">")) break;
          if (t.startsWith("[") || t === "…" || t === "..." || t.startsWith("(")) break; // 선택·생략 표기 — 여기까지만 센다
          t = t.replace(/\)+$/, "").replace(/[`;]+$/, "");
          if (t === "") break;
          if (t.startsWith("-") && t !== "-") {
            if (VALUE_FLAGS.has(t)) i += 1;
            continue;
          }
          args.push(t);
        }
        if (args.length === 0 && seg.kind === "inline") continue; // 인라인에 명령 이름만 적은 언급
        out.push({ cmd: name, args, where: `줄 ${seg.line + (seg.kind === "fence" ? k : 0)}` });
      }
    });
  }
  return out;
}

const SPECS = usage_specs();

test("사용법 파싱: 주요 명령의 필수 인자 수를 제대로 읽는다 (파서 자체 점검)", () => {
  const by = (c: string) => SPECS.filter((s) => s.cmd === c);
  const one = (c: string) => by(c)[0]!;
  assert.ok(SPECS.length >= 30, `사용법 명령 ${SPECS.length}개`);
  assert.equal(one("round-start").min, 2);
  assert.equal(one("merge").min, 3);
  assert.equal(one("merge").max, Infinity);
  assert.equal(one("note").min, 2);
  assert.equal(one("approve").min, 2);
  assert.equal(one("status").max, 1);
  assert.ok(by("set").some((s) => s.min === 4 && s.max === 4), "set 은 4개 (dir stage field file)");
  assert.ok(by("set").length >= 2, "set 사용법이 두 꼴");
  assert.equal(one("digest").min, 2);
  assert.ok(one("round-start").second_is_stage);
  assert.equal(one("ask-prep").min, 2);
});

test("문서의 `$PES <명령> …` 예제는 사용법의 인자 수에 맞는다 (필수 이상·최대 이하)", () => {
  const bad: string[] = [];
  let checked = 0;
  for (const rel of target_docs()) {
    for (const call of calls_in(repo_doc(rel))) {
      const specs = SPECS.filter((s) => s.cmd === call.cmd);
      if (specs.length === 0) continue;
      checked += 1;
      const n = call.args.length;
      if (!specs.some((s) => n >= s.min && n <= s.max)) {
        bad.push(`${rel} ${call.where}: ${call.cmd} 인자 ${n}개 [${call.args.join(" ")}] — 사용법 ${specs.map((s) => `${s.min}~${s.max === Infinity ? "∞" : s.max}`).join("|")}`);
      }
    }
  }
  assert.ok(checked >= 20, `검증한 예제 ${checked}개`);
  assert.deepEqual(bad, []);
});

test("문서의 `$PES <명령> <dir> <stage> …` 예제는 두 번째 인자 자리에 단계 이름(또는 자리표시)을 쓴다 — 순서 뒤바뀜 방지", () => {
  const stage_cmds = new Set(SPECS.filter((s) => s.second_is_stage).map((s) => s.cmd));
  const bad: string[] = [];
  for (const rel of target_docs()) {
    for (const call of calls_in(repo_doc(rel))) {
      if (!stage_cmds.has(call.cmd) || call.args.length < 2) continue;
      if (call.cmd === "ask-prep" || call.cmd === "set" || call.cmd === "render") {
        // ask-prep/set 은 stage|resume|project, render 는 [stage]
      }
      const second = call.args[1]!;
      if (call.cmd === "set" && second === "project") continue;
      if (!STAGE_WORD.test(second)) bad.push(`${rel} ${call.where}: ${call.cmd} 두 번째 인자 ${second}`);
    }
  }
  assert.deepEqual(bad, []);
});

test("문서의 `set` 예제: 필드가 사용법의 허용 필드이고 대상에 맞는 쪽이다 (project ↔ 단계)", () => {
  const stage_fields = ["summary", "changes", "carry_over", "settings", "review"];
  const project_fields = ["executive_summary", "conclusion"];
  const bad: string[] = [];
  for (const rel of target_docs()) {
    for (const call of calls_in(repo_doc(rel))) {
      if (call.cmd !== "set" || call.args.length < 3) continue;
      const [, target, field] = call.args as [string, string, string];
      const ok = target === "project" ? project_fields.includes(field) : stage_fields.includes(field);
      if (!ok) bad.push(`${rel} ${call.where}: set … ${target} ${field}`);
    }
  }
  assert.deepEqual(bad, []);
});

test("문서 안 인라인 예제 `명령 <dir> …` 도 사용법의 필수 인자 수 이상을 갖는다", () => {
  const bad: string[] = [];
  for (const rel of target_docs()) {
    for (const seg of code_segments(repo_doc(rel)).filter((s) => s.kind === "inline")) {
      const m = /^([a-z][a-z-]*)\s+(<dir>|"\$DIR"|\$DIR)\b(.*)$/.exec(seg.text.trim());
      if (m === null || !CMDS.includes(m[1]!)) continue;
      const specs = SPECS.filter((s) => s.cmd === m[1]);
      if (specs.length === 0) continue;
      const toks = (`${m[2]}${m[3]}`.match(/"[^"]*"|<[^>]*>|\S+/g) ?? []).filter((t) => !t.startsWith("-"));
      const cut = toks.findIndex((t) => t.startsWith("[") || t === "…" || t === "...");
      const n = cut < 0 ? toks.length : cut;
      if (!specs.some((s) => n >= s.min && (cut >= 0 || n <= s.max))) bad.push(`${rel}:${seg.line}: ${seg.text.slice(0, 70)} (인자 ${n}개)`);
    }
  }
  assert.deepEqual(bad, []);
});

test("예제 검증기 자체: 틀린 예제는 잡는다 (인자 부족·단계 자리에 다른 값)", () => {
  const md = ["```bash", '$PES merge "$DIR" plan', '$PES round-start plan "$DIR"', '$PES note "$DIR"', "```"].join("\n");
  const calls = calls_in(md);
  assert.equal(calls.length, 3);
  const merge = SPECS.filter((s) => s.cmd === "merge");
  assert.ok(!merge.some((s) => calls[0]!.args.length >= s.min), "merge 인자 부족을 못 잡으면 검증기가 무뎌진 것");
  assert.ok(!STAGE_WORD.test(calls[1]!.args[1]!), "round-start 순서 뒤바뀜을 못 잡는다");
  const note = SPECS.filter((s) => s.cmd === "note");
  assert.ok(!note.some((s) => calls[2]!.args.length >= s.min), "note 메모 빠짐을 못 잡는다");
});

// ---------------------------------------------------------------------------
// (B) 문서 개편 뒤에도 절차 유지 시험이 의미 있는가

const BASELINE = "36bc6a2"; // PR16 병합 시점: PR17 문서 개편 이전 (CI 는 fetch-depth: 0)

function baseline_doc(rel: string): string | null {
  const probe = spawnSync("git", ["cat-file", "-e", `${BASELINE}:${rel}`], { cwd: REPO });
  if (probe.status !== 0) return null;
  const res = spawnSync("git", ["show", `${BASELINE}:${rel}`], { cwd: REPO, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  assert.equal(res.status, 0, `git show ${rel}`);
  return (res.stdout ?? "").replace(/\r\n/g, "\n");
}

const strip_paren = (h: string) => h.replace(/\s*\([^)]*\)\s*$/, "").trim();

function headings(md: string): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const line of md.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (!fenced && /^#{2,3}\s+\S/.test(line)) out.push(strip_paren(line.replace(/^#+\s+/, "").trim()));
  }
  return out;
}

test("개편 전 기준 커밋을 읽을 수 있다 (얕은 clone 이면 CI fetch-depth: 0 이 필요하다)", () => {
  assert.notEqual(baseline_doc("skills/core/SKILL.md"), null, `${BASELINE} 를 찾을 수 없다`);
});

const REMOVED_ON_PURPOSE_HEADINGS = new Set(["project.json 편집"]); // 직접 편집 절 — 「상태 읽기와 검증된 제출」로 바뀜

test("개편 전 문서의 절 제목(##·###)은 지금도 남아 있다 (직접 편집 절만 의도적으로 사라짐)", () => {
  const missing: string[] = [];
  for (const rel of target_docs().filter((r) => !r.startsWith("docs/adapters/"))) {
    const old = baseline_doc(rel);
    if (old === null) continue;
    const now = new Set(headings(repo_doc(rel)));
    for (const h of headings(old)) if (!now.has(h) && !REMOVED_ON_PURPOSE_HEADINGS.has(h)) missing.push(`${rel}: "${h}"`);
  }
  assert.deepEqual(missing, [], "개편 중 사라진 절");
});

test("개편 전 문서가 소개한 pes 명령은 같은 문서에 지금도 소개돼 있다 (문서 단위 — 절차가 통째로 사라지지 않음)", () => {
  const lost: string[] = [];
  for (const rel of target_docs().filter((r) => !r.startsWith("docs/adapters/"))) {
    const old = baseline_doc(rel);
    if (old === null) continue;
    const before = mentioned_commands(old, CMDS);
    const now = mentioned_commands(repo_doc(rel), CMDS);
    for (const c of before) if (!now.has(c)) lost.push(`${rel}: ${c}`);
  }
  assert.deepEqual(lost, []);
});

test("개편 전 문서의 번호 목록 단계 수(1. 2. 3. …)는 줄지 않았다 — 단계 생명주기·승인 전 마무리 등", () => {
  const steps = (md: string) => md.split("\n").filter((l) => /^\s*\d+\.\s+\S/.test(l)).length;
  const shrunk: string[] = [];
  for (const rel of target_docs().filter((r) => !r.startsWith("docs/adapters/"))) {
    const old = baseline_doc(rel);
    if (old === null) continue;
    const a = steps(old);
    const b = steps(repo_doc(rel));
    if (b < a - 1) shrunk.push(`${rel}: ${a} → ${b}`);
  }
  assert.deepEqual(shrunk, []);
});

test("문서 크기 하한(절차 유지 시험의 MIN_LINES)은 개편 전 크기의 절반을 넘는다 — 하한이 너무 낮아 지워도 안 걸리는 상태를 막는다", () => {
  // 시험 파일의 표를 읽어 온다 (표는 test_skill_lint.test.ts 안의 MIN_LINES)
  const src = read_text(`${REPO}/tests/test_skill_lint.test.ts`);
  const block = src.slice(src.indexOf("const MIN_LINES"), src.indexOf("};", src.indexOf("const MIN_LINES")));
  const entries = [...block.matchAll(/"([^"]+)":\s*(\d+)/g)].map((m) => [m[1]!, Number(m[2])] as const);
  assert.ok(entries.length >= 10);
  const weak: string[] = [];
  for (const [rel, min] of entries) {
    const old = baseline_doc(rel);
    if (old === null) continue;
    const before = old.split("\n").filter((l) => l.trim() !== "").length;
    if (min < before * 0.45) weak.push(`${rel}: 하한 ${min} < 개편 전 ${before} 의 45%`);
  }
  assert.deepEqual(weak, []);
});
