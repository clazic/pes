/**
 * SEL-50 PR17 — lint 보강 (tester, 보강 모드). 구현을 깨뜨리는 것이 목표다.
 *
 * 한 번의 lint 실행에 문서 여러 편을 넣는다(스킬 폴더 하나에 사례 하나). 위반 사례는 출력에 그 문서 경로가 있어야 하고,
 * 거짓 양성 사례는 출력에 그 문서 경로가 없어야 한다. 노드를 사례마다 띄우지 않아 Windows 에서도 빠르다.
 * 출력은 CRLF→LF 로 정규화한다(helpers/skill_docs.run_lint).
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

// ---------------------------------------------------------------------------
// 우회: 막아야 하는데 놓치는 쓰기

const BYPASS: Case[] = [
  { id: "b01-continuation-redirect", body: fence("bash", 'echo "$JSON" > \\', '  "$DIR/project.json"') },
  { id: "b02-continuation-pipe", body: fence("bash", 'jq ".current=\\"write\\"" "$DIR/project.json" \\', '  | sponge "$DIR/project.json"') },
  { id: "b03-split-python-open", body: fence("python", "fh = open(", '    "project.json",', '    "w",', '    encoding="utf-8")') },
  { id: "b04-split-path-write", body: fence("python", 'Path(d, "project.json")', "    .write_text(text)") },
  { id: "b05-heredoc-python", body: fence("bash", `python3 -I - "$DIR" <<'EOF'`, "import sys, pathlib", 'pathlib.Path(sys.argv[1], "project.json").write_text("{}")', "EOF") },
  { id: "b06-heredoc-var", body: fence("bash", `python3 -I - "$DIR" <<'EOF'`, "import sys, pathlib", 'f = pathlib.Path(sys.argv[1]) / "project.json"', "f.write_text('{}')", "EOF") },
  { id: "b07-powershell-setcontent", body: fence("powershell", 'Set-Content -Path (Join-Path $Dir "project.json") -Value $json -Encoding UTF8') },
  { id: "b08-powershell-var", body: fence("powershell", '$f = Join-Path $Dir "project.json"', "Set-Content $f $json") },
  { id: "b09-powershell-writealltext", body: fence("powershell", '[System.IO.File]::WriteAllText("$Dir\\project.json", $json)') },
  { id: "b10-powershell-redirect", body: fence("powershell", '$json > "$Dir\\project.json"') },
  { id: "b11-node-writefilesync", body: fence("js", 'import fs from "node:fs";', 'fs.writeFileSync(`${dir}/project.json`, JSON.stringify(p));') },
  { id: "b12-node-promises", body: fence("js", 'await fs.promises.writeFile(path.join(dir, "project.json"), text);') },
  { id: "b13-node-var", body: fence("js", 'const file = path.join(dir, "project.json");', "fs.writeFileSync(file, text);") },
  { id: "b14-relative-dot", body: fence("bash", 'cd "$DIR" && echo "$J" > ./project.json') },
  { id: "b15-relative-dotdot-win", body: fence("bat", "echo %J% > ..\\project.json") },
  { id: "b16-env-path-var", body: fence("bash", 'NAME=project.json', 'echo "$J" > "$DIR/$NAME"') },
  { id: "b17-env-path-var-py", body: fence("python", 'name = "project.json"', 'open(os.path.join(d, name), "w").write(text)') },
  { id: "b18-uppercase-win", body: fence("bash", 'echo "$J" > "$DIR/PROJECT.JSON"') },
  { id: "b19-mixedcase-win", body: fence("powershell", 'Set-Content "$Dir\\Project.Json" $json') },
  { id: "b20-lock-uppercase", body: fence("bash", 'rm -f "$DIR/.PES-LOCK"') },
  { id: "b21-no-lang-tag", body: ["```", 'echo "$J" > "$DIR/project.json"', "```"].join("\n") },
  { id: "b22-tilde-fence", body: ["~~~bash", 'echo "$J" > "$DIR/project.json"', "~~~"].join("\n") },
  { id: "b23-tilde-fence-no-lang", body: ["~~~", 'sed -i "s/a/b/" "$DIR/project.json"', "~~~"].join("\n") },
  { id: "b24-fence-4ticks", body: ["````md", "```", 'echo "$J" > "$DIR/project.json"', "```", "````"].join("\n") },
  { id: "b25-fence-indented", body: ["- 절차:", "", "    ```bash", '    echo "$J" > "$DIR/project.json"', "    ```"].join("\n") },
  { id: "b26-fence-info-string", body: ["```bash title=\"x\" {1,2}", 'echo "$J" > "$DIR/project.json"', "```"].join("\n") },
  { id: "b27-inline-command", body: '- 직접 `echo "$J" > "$DIR/project.json"` 로 쓴다.' },
  { id: "b28-perl-inplace", body: fence("bash", `perl -pi -e 's/plan/write/' "$DIR/project.json"`) },
  { id: "b29-dd-of", body: fence("bash", 'dd if=new.json of="$DIR/project.json"') },
  { id: "b30-rename-item", body: fence("powershell", 'Rename-Item new.json project.json -Force') },
  { id: "b31-copy-cmd", body: fence("bat", "copy /Y new.json project.json") },
  { id: "b32-curl-output", body: fence("bash", 'curl -o "$DIR/project.json" https://example.invalid/p.json') },
  { id: "b33-python-shutil-move-var", body: fence("python", 'dst = Path(d) / "project.json"', "shutil.move(tmp, dst)") },
  { id: "b34-sql-multiline-lower", body: fence("sql", "update", "  stages", "set status = 'approved';") },
  { id: "b35-sql-insert-spaces", body: fence("bash", `sqlite3 pes.db "insert   into   approvals (id) values ('x')"`) },
  { id: "b36-sql-python-triple", body: fence("python", 'conn.executescript("""', "DELETE FROM rounds;", '""")') },
  { id: "b37-sql-replace-into", body: fence("sql", "REPLACE INTO artifacts (id) VALUES ('a');") },
  { id: "b38-lock-powershell-ni", body: fence("powershell", 'New-Item -ItemType File "$Dir\\.pes-lock"') },
  { id: "b39-lock-python-var", body: fence("python", 'lock = Path(d) / ".pes-lock"', "lock.unlink()") },
  { id: "b40-lock-node", body: fence("js", 'fs.rmSync(path.join(dir, ".pes-lock"));') },
  { id: "b41-project-json-truncate", body: fence("bash", ': > "$DIR/project.json"') },
  { id: "b42-project-json-append-printf-win-path", body: fence("bash", 'printf "%s" "$J" >> "C:\\\\Users\\\\a\\\\pes-projects\\\\x\\\\project.json"') },
  { id: "b43-claude-mark-in-prose", body: "서브에이전트는 AskUserQuestion 으로 묻는다." },
  { id: "b44-claude-mark-agent-tool", body: "Agent 도구로 reviewer 를 띄운다." },
];

// 구현이 지금 놓치는 것은 아래 loop 의 개별 시험이 BUG 로 드러낸다.
test("lint 우회 사례: 막아야 하는 것을 모두 막는다 (문서 하나에 사례 하나 — 한 번의 lint 실행)", () => {
  const res = lint_cases(BYPASS);
  assert.notEqual(res.status, 0);
  const missed = BYPASS.filter((c) => !flagged(res.out, c.id)).map((c) => c.id);
  assert.deepEqual(missed, [], `lint 가 놓친 우회 ${missed.length}건 (id 의 앞 글자는 아래 분류)`);
});

for (const c of BYPASS) {
  test(`lint 우회 [${c.id}]`, () => {
    const res = lint_cases([c]);
    assert.notEqual(res.status, 0, `lint 가 통과시켰다:\n${c.body}`);
    assert.ok(flagged(res.out, c.id), res.out);
  });
}

// ---------------------------------------------------------------------------
// 거짓 양성: 막으면 안 되는 것

const BENIGN: Case[] = [
  { id: "f01-prose", body: "project.json 을 직접 고치지 않는다. .pes-lock 파일도 만지지 않는다. UPDATE stages SET 같은 SQL 도 쓰지 않는다." },
  { id: "f02-read-cat", body: fence("bash", 'cat "$DIR/project.json"', 'jq .stages.plan "$DIR/project.json"') },
  { id: "f03-read-python", body: fence("python", 'p = json.loads(Path(d, "project.json").read_text(encoding="utf-8"))', "print(p['current'])") },
  { id: "f04-read-open", body: fence("python", 'with open("project.json", encoding="utf-8") as fh:', "    p = json.load(fh)", 'open("project.json", "r").read()', 'open("project.json", "rb").read()') },
  { id: "f05-read-node", body: fence("js", 'const p = JSON.parse(fs.readFileSync(path.join(dir, "project.json"), "utf8"));') },
  { id: "f06-read-powershell", body: fence("powershell", 'Get-Content "$Dir\\project.json" -Raw | ConvertFrom-Json') },
  { id: "f07-rounds-proposal-write", body: fence("bash", `cat > "$DIR/rounds/plan-R1/1.json" <<'EOF'`, '{"id": 1, "summary": "x"}', "EOF") },
  { id: "f08-rounds-proposal-python", body: fence("python", 'Path(d, "rounds", "research-R1", "3.json").write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")') },
  { id: "f09-rounds-node", body: fence("js", 'fs.writeFileSync(path.join(dir, "rounds", "write-R1", "2.json"), JSON.stringify(item));') },
  { id: "f10-powershell-proposal", body: fence("powershell", 'Set-Content -Path "$Dir\\rounds\\plan-R1\\1.json" -Value $json -Encoding UTF8') },
  { id: "f11-similar-names", body: fence("bash", 'echo x > "$DIR/not-project.json"', 'echo x > "$DIR/project.jsonl"', 'echo x > "$DIR/myproject.json"', 'echo x > "$DIR/out/cover.json"') },
  { id: "f12-lock-read", body: fence("bash", 'ls -la "$DIR/.pes-lock"', 'cat "$DIR/.pes-lock"') },
  { id: "f13-pes-commands", body: fence("bash", '$PES lock "$DIR"', '$PES set "$DIR" plan summary "$DIR/rounds/plan-R1/summary.txt"', '$PES note "$DIR" "project.json 은 pes 명령으로만 바꾼다"') },
  { id: "f14-sql-select", body: fence("bash", `sqlite3 -readonly ~/.pes/pes.db "SELECT id, updated_at FROM rounds WHERE state = 'open'"`) },
  { id: "f15-sql-select-multiline", body: fence("sql", "SELECT r.id,", "       r.state", "  FROM rounds r", " WHERE r.updated_at > 0", " ORDER BY r.id;") },
  { id: "f16-copy-from-project-json", body: fence("bash", 'cp "$DIR/project.json" "$DIR/backup/before.json"') },
  { id: "f17-copy-from-project-json-py", body: fence("python", 'src = Path(d) / "project.json"', 'shutil.copy(src, Path(d) / "backup" / "before.json")') },
  { id: "f18-redirect-other-from-project-json", body: fence("bash", `jq '.stages.plan.items' "$DIR/project.json" > "$DIR/rounds/plan-R1/items-copy.json"`) },
  { id: "f19-tilde-fence-read", body: ["~~~bash", 'grep -c "plan" "$DIR/project.json"', "~~~"].join("\n") },
  { id: "f20-inline-read", body: "- 상태는 `cat project.json` 이 아니라 `$PES status` 로 읽는다." },
  { id: "f21-taskspace-words", body: "TaskSpace 하나를 쓰고 서브에이전트는 task 단위로 나눈다. agents/ 폴더의 지침을 읽는다." },
  { id: "f22-lowercase-update-word", body: fence("bash", 'echo "update the summary, then set the status"') },
  { id: "f23-html-angle", body: fence("bash", '$PES show <dir> <stage> 1 2 --fields summary,details > "$DIR/rounds/x/view.txt"') },
  { id: "f24-crlf-benign", body: ["```bash", 'cat "$DIR/project.json"', "```"].join("\r\n") },
  { id: "f25-variable-reuse-name-p", body: fence("python", 'f = Path(d) / "project.json"', "p = json.loads(f.read_text())", 'Path(d, "rounds", "x.json").write_text(json.dumps(p["stages"]["plan"]["items"]))') },
];

test("lint 거짓 양성: 정상 산문·읽기 예제·rounds 제안 파일 쓰기는 막지 않는다 (한 번의 lint 실행)", () => {
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

test("lint 는 위반 줄 번호가 여러 줄 사례에서도 정확하다 (펜스 안 몇 번째 줄인지)", () => {
  const body = fence("bash", "echo 하나", "echo 둘", 'echo "$J" > "$DIR/project.json"', "echo 넷");
  const tree = make_tree({ "skills/core/SKILL.md": ["# 제목", "", "설명 문장이다.", "", body, ""].join("\n") });
  try {
    const res = run_lint(tree.root);
    assert.notEqual(res.status, 0);
    // 문서 6번째 줄이 'echo 하나', 8번째 줄이 위반
    assert.match(res.out, /skills\/core\/SKILL\.md:8\b/, res.out);
  } finally {
    tree.cleanup();
  }
});

test("lint 는 BOM 으로 시작하는 문서와 빈 파일에서도 죽지 않는다", () => {
  const tree = make_tree({
    "skills/core/SKILL.md": "\uFEFF# 제목\n\n설명.\n",
    "skills/plan/SKILL.md": "",
    "agents/empty.md": "\n",
  });
  try {
    const res = run_lint(tree.root);
    assert.equal(res.status, 0, res.out);
  } finally {
    tree.cleanup();
  }
});
