/**
 * SEL-50 PR17 r1-1 권장 1 — lint 가 pathlib `.open("w")`·sqlite `.import`·`CREATE TABLE` 도 막는다 (tester, 작성 모드 회귀).
 *
 * 1차 리뷰: `f = (Path(d) / "project.json").open("w"); f.write("{}")` 는 통과했고(`.open(mode="w")` 만 잡힘), SQL 쪽도
 * `sqlite3 db ".import x.csv items"`·`CREATE TABLE … AS` 가 빠져 있었다. 요구는 "직접 쓰기를 막는다"이다.
 *
 * 한 번의 lint 실행에 문서 여러 편을 넣는다(스킬 폴더 하나에 사례 하나). 위반은 출력에 그 문서 경로가 있어야 하고, 정상 사례는 없어야 한다.
 * 해석 R6: 읽기 모드(`r`·`rb`·모드 생략)의 `.open` 과 Python/JS 의 `import` 문은 막지 않는다. 쓰기 모드 판정은 `w`·`a`·`x`·`+` 가 들어간 모드 문자열.
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

const VIOLATIONS: Case[] = [
  { id: "v01-pathlib-open-w", body: fence("python", 'f = (Path(d) / "project.json").open("w")', 'f.write("{}")') },
  { id: "v02-pathlib-open-w-single-quote", body: fence("python", "f = Path(d, 'project.json').open('w')", "f.write(text)") },
  { id: "v03-pathlib-open-a", body: fence("python", 'with Path(d, "project.json").open("a") as fh:', "    fh.write(line)") },
  { id: "v04-pathlib-open-rplus", body: fence("python", 'with (Path(d) / "project.json").open("r+") as fh:', "    fh.write(text)") },
  { id: "v05-pathlib-open-wb", body: fence("python", 'with (Path(d) / "project.json").open("wb") as fh:', "    fh.write(data)") },
  { id: "v06-pathlib-open-x", body: fence("python", 'fh = (Path(d) / "project.json").open("x")', "fh.write(text)") },
  { id: "v07-pathlib-open-w-encoding", body: fence("python", 'with Path(d, "project.json").open("w", encoding="utf-8") as fh:', "    fh.write(text)") },
  { id: "v08-pathlib-open-var", body: fence("python", 'target = Path(d) / "project.json"', 'with target.open("w", encoding="utf-8") as fh:', "    fh.write(text)") },
  { id: "v09-pathlib-open-lock", body: fence("python", 'lock = (Path(d) / ".pes-lock").open("w")', "lock.write(owner)") },
  { id: "v10-pathlib-open-wplus-split", body: fence("python", 'fh = Path(d, "project.json").open(', '    "w+",', '    encoding="utf-8")') },
  { id: "v11-sqlite-import-bash", body: fence("bash", `sqlite3 ~/.pes/pes.db ".import x.csv items"`) },
  { id: "v12-sqlite-import-sql-fence", body: fence("sql", ".import data.csv approvals") },
  { id: "v13-sqlite-import-mode-csv", body: fence("bash", `sqlite3 pes.db <<'EOF'`, ".mode csv", ".import rows.csv rounds", "EOF") },
  { id: "v14-create-table", body: fence("sql", "CREATE TABLE evil (id TEXT);") },
  { id: "v15-create-table-lower-if-not-exists", body: fence("bash", `sqlite3 pes.db "create table if not exists notes (id integer)"`) },
  { id: "v16-create-table-as-select", body: fence("sql", "CREATE TABLE copy_of_items AS SELECT * FROM stages;") },
  { id: "v17-create-table-multiline", body: fence("sql", "create", "  table", "  hidden (x);") },
  { id: "v18-create-table-python-exec", body: fence("python", 'conn.execute("CREATE TABLE tmp_state (id INTEGER)")') },
];

// 막으면 안 되는 것: 읽기 모드 open, import 문, 비슷한 이름
const BENIGN: Case[] = [
  { id: "g01-pathlib-open-read", body: fence("python", 'with (Path(d) / "project.json").open("r", encoding="utf-8") as fh:', "    p = json.load(fh)") },
  { id: "g02-pathlib-open-default", body: fence("python", 'with Path(d, "project.json").open() as fh:', "    p = json.load(fh)") },
  { id: "g03-pathlib-open-rb", body: fence("python", 'data = Path(d, "project.json").open("rb").read()') },
  { id: "g04-pathlib-open-write-other-file", body: fence("python", 'with Path(d, "rounds", "plan-R1", "1.json").open("w", encoding="utf-8") as fh:', "    fh.write(json.dumps(item))") },
  { id: "g05-python-import-statements", body: fence("python", "import json", "from pathlib import Path", "import importlib", 'mod = importlib.import_module("json")') },
  { id: "g06-js-dynamic-import", body: fence("js", 'const mod = await import("node:fs");', "export { mod };") },
  { id: "g07-sqlite-dot-commands-read", body: fence("bash", `sqlite3 -readonly pes.db ".tables"`, `sqlite3 -readonly pes.db ".schema rounds"`, `sqlite3 -readonly pes.db ".mode json" "SELECT id FROM rounds"`) },
  { id: "g08-prose-create-table", body: "CREATE TABLE 이나 .import 로 표를 만들거나 가져오지 않는다. 읽기(SELECT)만 한다." },
  { id: "g09-words-table-create", body: fence("bash", 'echo "how to create a table in the report: use the table kind"', 'echo "import the library with --import"') },
  { id: "g10-pes-import-flag", body: fence("bash", '$PES init "$SLUG" --topic "주제" --import "$OLD_DIR"') },
];

test("lint: pathlib .open 쓰기 모드·sqlite .import·CREATE TABLE 도 직접 쓰기로 막는다 (한 번의 lint 실행)", () => {
  const res = lint_cases(VIOLATIONS);
  assert.notEqual(res.status, 0);
  const missed = VIOLATIONS.filter((c) => !flagged(res.out, c.id)).map((c) => c.id);
  assert.deepEqual(missed, [], `lint 가 놓친 직접 쓰기 ${missed.length}건`);
});

for (const c of VIOLATIONS) {
  test(`lint 직접 쓰기 [${c.id}]`, () => {
    const res = lint_cases([c]);
    assert.notEqual(res.status, 0, `lint 가 통과시켰다:\n${c.body}`);
    assert.ok(flagged(res.out, c.id), res.out);
  });
}

test("lint 거짓 양성: 읽기 모드 open·import 문·읽기 전용 sqlite 점 명령은 막지 않는다 (한 번의 lint 실행)", () => {
  const res = lint_cases(BENIGN);
  const wrong = BENIGN.filter((c) => flagged(res.out, c.id)).map((c) => c.id);
  assert.deepEqual(wrong, [], `lint 가 잘못 막은 정상 문서 ${wrong.length}건\n${res.out}`);
  assert.equal(res.status, 0, res.out);
});

for (const c of BENIGN) {
  test(`lint 거짓 양성 [${c.id}]`, () => {
    const res = lint_cases([c]);
    assert.equal(res.status, 0, `정상 문서를 막았다:\n${c.body}\n${res.out}`);
  });
}
