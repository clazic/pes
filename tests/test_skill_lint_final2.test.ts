/**
 * SEL-50 PR17 1차 리뷰 r1-5 권장 1·2·4 (tester, 작성 모드). 구현 전이면 실패하는 것이 정상이다. 전부 합성 문서.
 *
 * 해석 R8
 *   권장 1: 상태 파일을 **읽기만** 하는 변형(괄호 식 값, `<` 입력 리다이렉트, 이름 붙은 인자 순서 뒤집힘, 위치 인자)은 통과한다.
 *   권장 2: 별칭·체이닝 호출(fsp.*, require('fs').*, pathlib symlink_to/hardlink_to)로 상태 파일을 쓰면 막는다.
 *   권장 4: str.replace 계열(인자 2개)은 파일 교체가 아니므로 통과한다. 실제 문서는 계속 통과한다.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { doc, fence, make_tree, run_lint } from "./helpers/skill_docs.ts";
import { REPO } from "./helpers/skill_docs.ts";

interface Case {
  id: string;
  body: string;
}

function lint_cases(cases: Case[]): { out: string; status: number | null } {
  const files: Record<string, string> = {};
  for (const c of cases) files[`skills/${c.id}/SKILL.md`] = doc(c.body);
  const tree = make_tree(files);
  try {
    const res = run_lint(tree.root);
    assert.doesNotMatch(res.out, /Traceback|TypeError|ReferenceError|SyntaxError|RangeError/, "lint 가 죽지 않고 위반을 보고해야 한다");
    return res;
  } finally {
    tree.cleanup();
  }
}

const flagged = (out: string, id: string) => out.includes(`skills/${id}/SKILL.md`);

// 권장 1 — 읽기인데 막던 거짓 양성
const FALSE_POSITIVE: Case[] = [
  { id: "h01-setcontent-value-getcontent", body: fence("powershell", 'Set-Content -Path "$dir\\rounds\\b.json" -Value (Get-Content "$dir\\project.json")') },
  { id: "h02-setcontent-positional-getcontent", body: fence("powershell", 'Set-Content "$dir\\rounds\\b.json" (Get-Content "$dir\\project.json")') },
  { id: "h03-setcontent-positional-getcontent-bare", body: fence("powershell", "Set-Content rounds\\b.json (Get-Content project.json)") },
  { id: "h04-tee-stdin-redirect", body: fence("bash", 'tee "$DIR/rounds/x.json" < "$DIR/project.json" > /dev/null') },
  { id: "h05-copyitem-reversed-named", body: fence("powershell", 'Copy-Item -Destination "$dir\\rounds\\b.json" -Path "$dir\\project.json"') },
  { id: "h06-copyitem-positional-source-state", body: fence("powershell", 'Copy-Item "$dir\\project.json" "$dir\\rounds\\b.json"') },
  // 권장 4 — str.replace
  { id: "h10-str-replace-read-text", body: fence("python", 'Path(d, "project.json").read_text().replace("a", "b")') },
  { id: "h11-js-regex-replace", body: fence("js", 'p.replace(/project\\.json/g, "x")') },
  { id: "h12-str-replace-name", body: fence("python", 'name = "project.json".replace(".json", "")') },
  { id: "h13-js-path-replace-slashes", body: fence("js", "const q = path.join(d, 'project.json').replace(/\\\\/g, '/');") },
];

// 권장 2 — 별칭·체이닝 쓰기를 놓치던 것
const MISSED_ALIAS: Case[] = [
  { id: "a01-fsp-writefile", body: fence("js", "await fsp.writeFile(join(d, 'project.json'), '{}');") },
  { id: "a02-fsp-rename", body: fence("js", "await fsp.rename(tmp, join(d, 'project.json'));") },
  { id: "a03-fsp-copyfile", body: fence("js", "await fsp.copyFile(tmp, join(d, 'project.json'));") },
  { id: "a04-node-e-require-fs", body: fence("bash", `node -e "require('fs').writeFileSync('project.json','{}')"`) },
  { id: "a05-symlink-to", body: fence("python", "Path(d, 'project.json').symlink_to(src)") },
  { id: "a06-hardlink-to", body: fence("python", "Path(d, 'project.json').hardlink_to(src)") },
  { id: "a07-fsp-appendfile", body: fence("js", "await fsp.appendFile(join(d, 'project.json'), 'x');") },
  { id: "a08-fs-promises-writefile-lock", body: fence("js", "await fs.promises.writeFile(join(d, '.pes-lock'), '');") },
];

// 오탐을 줄이려다 놓치지 않는지 (이미 막던 것)
const STILL_BAD: Case[] = [
  { id: "s01-setcontent-state", body: fence("powershell", 'Set-Content -Path "$dir\\project.json" -Value (Get-Content "$dir\\rounds\\b.json")') },
  { id: "s02-tee-state-stdin", body: fence("bash", 'tee "$DIR/project.json" < "$DIR/rounds/x.json" > /dev/null') },
  { id: "s03-copyitem-reversed-dest-state", body: fence("powershell", 'Copy-Item -Destination "$dir\\project.json" -Path "$dir\\rounds\\b.json"') },
  { id: "s04-fsp-copyfile-from-state", body: fence("js", "await fsp.copyFile(join(d, 'project.json'), join(d, 'rounds', 'x.json'));") },
];
// s04 는 상태 파일이 원본이라 통과해야 한다 → 아래에서 분리
const STILL_BAD_REAL = STILL_BAD.filter((c) => c.id !== "s04-fsp-copyfile-from-state");
const ALIAS_READ_OK: Case[] = [
  STILL_BAD[3]!,
  { id: "s05-fsp-readfile-state", body: fence("js", "const t = await fsp.readFile(join(d, 'project.json'), 'utf8');") },
  { id: "s06-node-e-read", body: fence("bash", `node -e "console.log(require('fs').readFileSync('project.json','utf8'))"`) },
];

test("lint 거짓 양성: 읽기 변형·str.replace 계열 정상 예제는 통과한다 (한 번의 lint 실행)", () => {
  const res = lint_cases(FALSE_POSITIVE);
  const wrong = FALSE_POSITIVE.filter((c) => flagged(res.out, c.id)).map((c) => c.id);
  assert.deepEqual(wrong, [], `lint 가 잘못 막은 정상 문서 ${wrong.length}건\n${res.out}`);
  assert.equal(res.status, 0, res.out);
});

for (const c of [...FALSE_POSITIVE, ...ALIAS_READ_OK]) {
  test(`lint 정상 통과 [${c.id}]`, () => {
    const res = lint_cases([c]);
    assert.equal(res.status, 0, `정상 문서를 막았다:\n${c.body}\n${res.out}`);
  });
}

test("lint: 별칭·체이닝 쓰기(fsp.*, require('fs').*, symlink_to/hardlink_to)로 상태 파일을 쓰면 막는다 (한 번의 lint 실행)", () => {
  const res = lint_cases(MISSED_ALIAS);
  assert.notEqual(res.status, 0);
  const missed = MISSED_ALIAS.filter((c) => !flagged(res.out, c.id)).map((c) => c.id);
  assert.deepEqual(missed, [], `lint 가 놓친 별칭 쓰기 ${missed.length}건`);
});

for (const c of MISSED_ALIAS) {
  test(`lint 별칭 쓰기 [${c.id}]`, () => {
    const res = lint_cases([c]);
    assert.notEqual(res.status, 0, `lint 가 통과시켰다:\n${c.body}`);
    assert.ok(flagged(res.out, c.id), res.out);
  });
}

test("lint: 쓰기 대상이 상태 파일인 변형은 오탐 수정 뒤에도 막는다", () => {
  const res = lint_cases(STILL_BAD_REAL);
  assert.notEqual(res.status, 0);
  const missed = STILL_BAD_REAL.filter((c) => !flagged(res.out, c.id)).map((c) => c.id);
  assert.deepEqual(missed, [], `놓친 직접 쓰기 ${missed.length}건`);
});

test("lint: 실제 문서는 계속 통과한다", () => {
  const res = run_lint(REPO);
  assert.equal(res.status, 0, res.out);
});
