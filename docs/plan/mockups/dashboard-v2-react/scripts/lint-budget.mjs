#!/usr/bin/env node
// lint-budget — oxlint 진단을 규칙별로 세어 예산을 검사한다.
//
// 사용: node scripts/lint-budget.mjs 'react(*)<=17' ['shadcn(no-restyle)=927' ...]
//   <규칙 글롭>=<수>   실제 수가 정확히 그 수
//   <규칙 글롭><=<수>  실제 수가 그 수 이하
//   글롭의 *는 아무 글자(0개 이상)와 맞는다. 예: 'react(*)'는 react(...) 규칙 전부.
// 진단은 이 폴더의 설정(.oxlintrc.json) 그대로 `npx oxlint src --format=json`으로 센다.
// 종료: 0 모두 지킴 · 1 하나라도 어김(또는 oxlint 결과를 읽지 못함) · 2 인자 형식 오류.

import { execSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const usage = "사용법: node scripts/lint-budget.mjs '<규칙 글롭>=<수>' ['<규칙 글롭><=<수>' ...]";

function invalidArgument(message) {
  console.error(message);
  console.error(usage);
  process.exit(2);
}

const args = process.argv.slice(2);
if (args.length === 0) invalidArgument("규칙 목표를 하나 이상 넘긴다.");

const checks = args.map((arg) => {
  const match = /^(.*?)(<=|=)(\d+)$/.exec(arg);
  if (!match || match[1] === "" || /[=<>]/.test(match[1])) {
    invalidArgument(`인자 형식이 틀렸다: ${arg}`);
  }
  return { glob: match[1], op: match[2], target: Number(match[3]) };
});

function globToRegExp(glob) {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

let output;
try {
  output = execSync("npx oxlint src --format=json", {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
} catch (error) {
  // oxlint는 오류 수준 진단이 있어도 JSON을 출력하고 종료 1을 낸다. 출력이 있으면 계속 센다.
  // 그 밖의 종료 코드(설정 오류 등)나 신호 종료는 예산을 확인할 수 없으므로 실패로 본다.
  const status = typeof error.status === "number" ? error.status : null;
  if (error.signal || (status !== 0 && status !== 1)) {
    console.error(
      `oxlint 실행이 비정상 종료했다(종료 코드 ${status ?? "없음"}${error.signal ? `, 신호 ${error.signal}` : ""}).`,
    );
    if (typeof error.stderr === "string" && error.stderr) process.stderr.write(error.stderr);
    process.exit(1);
  }
  output = typeof error.stdout === "string" ? error.stdout : "";
}

let parsed;
try {
  parsed = JSON.parse(output);
} catch {
  console.error("oxlint 결과(JSON)를 읽지 못했다.");
  process.exit(1);
}

if (!Array.isArray(parsed?.diagnostics)) {
  console.error("oxlint 결과에 diagnostics 배열이 없다.");
  process.exit(1);
}

const diagnostics = parsed.diagnostics;

const counts = new Map();
for (const diagnostic of diagnostics) {
  const code = diagnostic?.code ?? "";
  counts.set(code, (counts.get(code) ?? 0) + 1);
}

const failures = [];
for (const check of checks) {
  const pattern = globToRegExp(check.glob);
  let actual = 0;
  let matched = 0;
  for (const [code, count] of counts) {
    if (pattern.test(code)) {
      actual += count;
      matched += 1;
    }
  }
  if (matched === 0) {
    // 목표가 0인 규칙은 원래 진단이 없을 수 있으므로 실패가 아니라 경고만 낸다.
    console.error(`경고: '${check.glob}' 글롭과 맞는 규칙 코드가 없다.`);
  }
  const ok = check.op === "=" ? actual === check.target : actual <= check.target;
  if (!ok) failures.push({ ...check, actual });
}

if (failures.length > 0) {
  for (const failure of failures) {
    const target = failure.op === "=" ? `= ${failure.target}` : `<= ${failure.target}`;
    console.error(`린트 예산 위반: ${failure.glob} — 실제 ${failure.actual}, 목표 ${target}`);
  }
  process.exit(1);
}

console.log(`린트 예산 통과: ${checks.length}개 규칙 (진단 ${diagnostics.length}개)`);
