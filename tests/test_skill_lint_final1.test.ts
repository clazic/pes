/**
 * SEL-50 PR17 최종 리뷰 1/2 필수 2·3 회귀 (tester, 작성 모드). 구현 전이면 실패하는 것이 정상이다. 전부 합성 문서.
 *
 * 해석 R7
 *   필수 2: 상태 파일(project.json)을 **읽기만** 하고 다른 곳(rounds/ 제안 파일 등)에 쓰는 정상 예제는 lint 를 통과한다.
 *           한 문장에 상태 파일 이름과 쓰기 낱말이 같이 있다는 이유만으로 막지 않는다. 쓰기 대상이 상태 파일이면 여전히 막는다.
 *   필수 3: pathlib Path.replace/rename·os.replace·shutil.move·Node fs.copyFile(Sync)·fs.renameSync·PowerShell Copy-Item/Move-Item 으로
 *           project.json·.pes-lock 을 덮어쓰는 예제는 막는다. 같은 파일이 **원본**인 복사(읽기 목적)는 통과한다.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { doc, fence, make_tree, run_lint } from "./helpers/skill_docs.ts";

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

// 필수 2 — 읽기 + 제안 파일 쓰기 (모두 정상)
const READ_PROPOSE: Case[] = [
  {
    id: "g01-review-example-1",
    body: fence("python", 'Path(d, "rounds", "research-R1", "1.json").write_text(json.dumps(json.loads(Path(d, "project.json").read_text())["stages"]["research"]["items"]))'),
  },
  { id: "g02-review-example-2", body: fence("bash", 'cat "$DIR/project.json" | tee "$DIR/rounds/backup.json"') },
  { id: "g03-jq-redirect", body: fence("bash", `jq '.stages.research.items' "$DIR/project.json" > "$DIR/rounds/research-R1/1.json"`) },
  { id: "g04-jq-pipe-tee", body: fence("bash", `cat "$DIR/project.json" | jq '.stages' | tee "$DIR/rounds/stages.json"`) },
  { id: "g05-python-c-redirect", body: fence("bash", `python3 -c "import json; print(json.dumps(json.load(open('$DIR/project.json'))['stages']))" > "$DIR/rounds/proposal.json"`) },
  { id: "g06-write-text-read-text", body: fence("python", 'Path(d, "rounds", "a.json").write_text(Path(d, "project.json").read_text())') },
  { id: "g07-json-dump-to-rounds", body: fence("python", 'data = json.load(open(Path(d, "project.json")))', 'json.dump(data["stages"], open(Path(d, "rounds", "x.json"), "w"))') },
  { id: "g08-js-write-from-read", body: fence("js", 'writeFileSync(join(d, "rounds", "p.json"), JSON.stringify(JSON.parse(readFileSync(join(d, "project.json"), "utf8")).stages));') },
  { id: "g09-powershell-pipe", body: fence("powershell", 'Get-Content "$dir/project.json" | Set-Content "$dir/rounds/backup.json"') },
  { id: "g10-one-sentence-inline", body: "`project.json` 에서 항목을 읽어 `Path(d, 'rounds', 'p.json').write_text(text)` 로 제안 파일에 쓴다." },
  { id: "g11-tee-append-rounds", body: fence("bash", 'cat "$DIR/project.json" | tee -a "$DIR/rounds/log.json" > /dev/null') },
  // 필수 3 의 정상 쪽: 상태 파일이 원본인 복사는 읽기 목적
  { id: "g12-copyfile-source-state", body: fence("js", 'copyFileSync("project.json", "rounds/snapshot.json")') },
  { id: "g13-copy-item-source-state", body: fence("powershell", 'Copy-Item project.json rounds\\snapshot.json') },
  { id: "g14-path-replace-other-files", body: fence("python", 'Path(d, "rounds", "tmp.json").replace(Path(d, "rounds", "final.json"))') },
  { id: "g15-js-rename-other-files", body: fence("js", 'renameSync("rounds/tmp.json", "rounds/final.json")') },
];

// 쓰기 대상이 상태 파일이면 여전히 막는다 (오탐을 줄이려다 놓치지 않는지)
const STILL_BAD: Case[] = [
  { id: "v01-write-text-state", body: fence("python", 'Path(d, "project.json").write_text(Path(d, "rounds", "x.json").read_text())') },
  { id: "v02-tee-state", body: fence("bash", 'cat "$DIR/rounds/x.json" | tee "$DIR/project.json"') },
  { id: "v03-redirect-state", body: fence("bash", `jq '.a' "$DIR/rounds/x.json" > "$DIR/project.json"`) },
];

// 필수 3 — 파일 교체 API 로 상태·잠금 덮어쓰기
const REPLACE_BAD: Case[] = [
  { id: "v10-path-replace-state", body: fence("python", 'Path(d, "proposal.json").replace(Path(d, "project.json"))') },
  { id: "v11-path-rename-state", body: fence("python", 'Path(d, "proposal.json").rename(Path(d) / "project.json")') },
  { id: "v12-path-replace-lock", body: fence("python", 'Path(d, "x.tmp").replace(Path(d, ".pes-lock"))') },
  { id: "v13-os-replace-state-joined", body: fence("python", 'os.replace(tmp, os.path.join(d, "project.json"))') },
  { id: "v14-os-replace-lock", body: fence("python", 'os.replace(tmp, os.path.join(d, ".pes-lock"))') },
  { id: "v15-shutil-move-state", body: fence("python", 'shutil.move("tmp.json", "project.json")') },
  { id: "v16-path-replace-var", body: fence("python", 'target = Path(d) / "project.json"', 'Path(d, "proposal.json").replace(target)') },
  { id: "v17-copyfilesync-state", body: fence("javascript", 'copyFileSync("proposal.json", "project.json")') },
  { id: "v18-fs-copyfilesync-state", body: fence("javascript", 'fs.copyFileSync("proposal.json", path.join(d, "project.json"))') },
  { id: "v19-fs-copyfile-state", body: fence("javascript", 'fs.copyFile("proposal.json", "project.json", cb)') },
  { id: "v20-fs-renamesync-state", body: fence("javascript", 'fs.renameSync(tmp, path.join(d, "project.json"))') },
  { id: "v21-renamesync-lock", body: fence("javascript", 'renameSync(tmp, ".pes-lock")') },
  { id: "v22-copyfilesync-lock", body: fence("javascript", 'fs.copyFileSync(tmp, path.join(d, ".pes-lock"))') },
  { id: "v23-copy-item-state", body: fence("powershell", 'Copy-Item proposal.json project.json') },
  { id: "v24-copy-item-named-state", body: fence("powershell", 'Copy-Item -Path proposal.json -Destination "$dir\\project.json" -Force') },
  { id: "v25-move-item-state", body: fence("powershell", 'Move-Item -Force $tmp "$dir\\project.json"') },
  { id: "v26-move-item-lock", body: fence("powershell", 'Move-Item $tmp "$dir\\.pes-lock"') },
];

test("lint 거짓 양성: 상태 파일을 읽기만 하고 제안 파일에 쓰는 정상 예제 15건은 통과한다 (한 번의 lint 실행)", () => {
  const res = lint_cases(READ_PROPOSE);
  const wrong = READ_PROPOSE.filter((c) => flagged(res.out, c.id)).map((c) => c.id);
  assert.deepEqual(wrong, [], `lint 가 잘못 막은 정상 문서 ${wrong.length}건\n${res.out}`);
  assert.equal(res.status, 0, res.out);
});

for (const c of READ_PROPOSE) {
  test(`lint 거짓 양성 [${c.id}]`, () => {
    const res = lint_cases([c]);
    assert.equal(res.status, 0, `정상 문서를 막았다:\n${c.body}\n${res.out}`);
  });
}

test("lint: 쓰기 대상이 상태 파일이면 여전히 막는다", () => {
  const res = lint_cases(STILL_BAD);
  assert.notEqual(res.status, 0);
  const missed = STILL_BAD.filter((c) => !flagged(res.out, c.id)).map((c) => c.id);
  assert.deepEqual(missed, [], `놓친 직접 쓰기 ${missed.length}건`);
});

test("lint: Path.replace·os.replace·shutil.move·fs.copyFile(Sync)·fs.renameSync·Copy-Item·Move-Item 으로 project.json·.pes-lock 덮어쓰기를 막는다 (한 번의 lint 실행)", () => {
  const res = lint_cases(REPLACE_BAD);
  assert.notEqual(res.status, 0);
  const missed = REPLACE_BAD.filter((c) => !flagged(res.out, c.id)).map((c) => c.id);
  assert.deepEqual(missed, [], `lint 가 놓친 덮어쓰기 ${missed.length}건`);
});

for (const c of REPLACE_BAD) {
  test(`lint 덮어쓰기 [${c.id}]`, () => {
    const res = lint_cases([c]);
    assert.notEqual(res.status, 0, `lint 가 통과시켰다:\n${c.body}`);
    assert.ok(flagged(res.out, c.id), res.out);
  });
}
