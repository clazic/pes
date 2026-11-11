// SEL-73 (stage 2 PR26d): CI 필수 검사가 설계 검사의 TS 산출물(scripts/check_ddl.ts)을 쓴다.
// 결정 0016: "PR26이 설계 검사 계약을 TS 검사기·실행 명령·기존 합성 사례 동등성으로 옮기고, 이후 필수 검사는 그 TS 산출물을 쓴다."
// 지금은 package.json 에 실행 명령이 없고 워크플로가 설계 검사를 돌리지 않아 실패한다.
// 합성 입력 없음 — 저장소 파일을 읽기만 한다. CRLF 체크아웃도 LF 로 정규화해서 읽는다.

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const WORKFLOWS = join(REPO, ".github", "workflows");

function text(path: string): string {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

/** `jobs:` 아래 2칸 들여쓴 job 하나의 본문. */
function job_block(yaml: string, job: string): string {
  const lines = yaml.split("\n");
  const start = lines.findIndex((l) => l === `  ${job}:`);
  assert.ok(start >= 0, `job '${job}' exists in the workflow`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {2}[A-Za-z0-9_-]+:/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

const package_json = (): { scripts: Record<string, string> } => JSON.parse(text(join(REPO, "package.json")));

test("package.json has a TS design-check command: npm run check:ddl == node scripts/check_ddl.ts", () => {
  const scripts = package_json().scripts;
  assert.equal(scripts["check:ddl"], "node scripts/check_ddl.ts");
});

test("the TS design checker file exists where the command points", () => {
  assert.ok(existsSync(join(REPO, "scripts", "check_ddl.ts")), "scripts/check_ddl.ts");
});

test("no workflow and no package.json script calls check_ddl.py any more", () => {
  const offenders: string[] = [];
  for (const name of readdirSync(WORKFLOWS)) {
    if (!/\.ya?ml$/.test(name)) continue;
    if (/check_ddl\.py/.test(text(join(WORKFLOWS, name)))) offenders.push(`.github/workflows/${name}`);
  }
  for (const [key, value] of Object.entries(package_json().scripts)) {
    if (/check_ddl\.py/.test(value)) offenders.push(`package.json scripts.${key}`);
  }
  assert.deepEqual(offenders, []);
});

test("the CI TypeScript job runs the TS design check (npm run check:ddl) on Windows and macOS", () => {
  const ci = text(join(WORKFLOWS, "ci.yml"));
  const block = job_block(ci, "typescript");
  assert.match(block, /^\s+run: npm run check:ddl\s*$/m, "a step runs `npm run check:ddl`");
  assert.match(block, /windows-latest/);
  assert.match(block, /macos-latest/);
  // 설계 검사는 npm ci 뒤에 와야 한다(의존성 설치 뒤, 같은 job)
  assert.ok(block.indexOf("npm ci") >= 0 && block.indexOf("npm ci") < block.indexOf("npm run check:ddl"));
});

test("the design check step does not need Python (no python in the step itself)", () => {
  const ci = text(join(WORKFLOWS, "ci.yml"));
  const block = job_block(ci, "typescript");
  const lines = block.split("\n");
  const at = lines.findIndex((l) => /run: npm run check:ddl/.test(l));
  assert.ok(at >= 0);
  // 단계 하나(같은 `- name:` 묶음)만 본다
  let from = at;
  while (from > 0 && !/^\s+- name:/.test(lines[from]!)) from -= 1;
  let to = at + 1;
  while (to < lines.length && !/^\s+- name:/.test(lines[to]!)) to += 1;
  assert.doesNotMatch(lines.slice(from, to).join("\n"), /python/i);
});

// SEL-74: the Python job is gone entirely (0.15 removed). No job carries the old Python design check;
// the TS check runs only through `npm run check:ddl`.
test("no job carries the old Python design check (SEL-74: the Python job is removed)", () => {
  const ci = text(join(WORKFLOWS, "ci.yml"));
  assert.doesNotMatch(ci, /check_ddl\.py/);
  assert.doesNotMatch(ci, /^\s{2}test:\s*$/m, "the old Python test job is gone");
  assert.match(ci, /run: npm run check:ddl/);
});

test("developer docs name the TS command: AGENTS.md 검사 and docs/plan/README.md list `npm run check:ddl`", () => {
  const agents = text(join(REPO, "AGENTS.md"));
  assert.match(agents, /npm run check:ddl/);
  const plan_readme = text(join(REPO, "docs", "plan", "README.md"));
  const row = plan_readme.split("\n").find((l) => l.includes("check_ddl")) ?? "";
  assert.ok(row.includes("check_ddl.ts"), `docs/plan/README.md names the TS checker: ${row}`);
});
