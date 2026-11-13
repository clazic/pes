/**
 * SEL-50 PR17 — 스킬 직접 편집 제거 (tester, 작성 모드). 구현 전이므로 새 시험은 실패하는 것이 정상이다.
 *
 * 이 파일이 고정하는 것:
 *   1. lint(scripts/lint_skills.ts)가 "업무 상태를 직접 바꾸는 경로"만 막는다 — project.json 쓰기, 업무 표 쓰기 SQL, 잠금 파일 조작.
 *      막아야 할 것(위반 사례)과 막으면 안 되는 것(거짓 양성 0 사례)을 둘 다 못 박는다.
 *   2. Claude 전용 표기(Task/Agent 도구, anthropic-skills:*, AskUserQuestion)는 docs/adapters/* 에서만 허용한다.
 *   3. 저장소의 실제 문서가 lint 를 통과하고, 같은 내용을 lint 와 따로 확인하는 독립 점검도 통과한다.
 *   4. 연구 절차·독립 검토·근거 확인 절차가 문서에 남아 있다 (현재 문서에서 뽑은 필수 절차 목록).
 *   5. 업무 경로마다 문서가 지시하는 pes 명령이 pes.py CMDS 에 있다. (그 명령 열을 실제로 돌리는 합성 1회는
 *      tests/test_skill_pilot_run.test.ts — CLI 를 띄우는 시험이라 느려서 파일을 나눴다.)
 *   6. 어댑터 노트(docs/adapters/{opencode,claude-code,claude-app}.md)가 있고, 이름만 바꿔 변환 지원을 주장하지 않는다.
 *
 * lint 의 바깥 계약(구현이 지킬 것 — 보고서의 '해석'에도 적음):
 *   - `node scripts/lint_skills.ts [루트]` 로 실행한다(루트 생략 시 저장소 루트). `npm run lint:skills` 로도 돈다.
 *   - 검사 대상(루트 기준): skills/*\/SKILL.md, agents/*.md, commands/*.md, docs/adapters/*.md. 그 밖(tests/, scripts/, docs/plan/ …)은 보지 않는다.
 *   - 위반이 있으면 종료 코드 != 0, 출력에 위반 파일의 루트 기준 경로(POSIX)와 `경로:줄` 을 적는다. 없으면 종료 코드 0.
 *   - 직접 쓰기 규칙은 코드 블록과 명령 예제(인라인 코드 안의 명령 포함)만 본다 — 산문 문장은 보지 않는다.
 *     Claude 전용 표기 규칙은 어댑터 노트 밖 문서의 전체 텍스트(산문 포함)를 본다.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  code_segments,
  doc,
  fence,
  make_tree,
  mentioned_commands,
  pes_cmds,
  read_text,
  repo_doc,
  REPO,
  run_lint,
  STAGES,
  target_docs,
  unknown_invocations,
} from "./helpers/skill_docs.ts";

// ---------------------------------------------------------------------------
// 0 · 계약

test("lint 파일과 npm script 가 있다", () => {
  assert.ok(existsSync(join(REPO, "scripts", "lint_skills.ts")), "scripts/lint_skills.ts");
  const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { scripts?: Record<string, string> };
  const script = pkg.scripts?.["lint:skills"];
  assert.ok(script !== undefined, "package.json scripts 에 lint:skills");
  assert.match(script, /lint_skills\.ts/, "lint:skills 는 scripts/lint_skills.ts 를 실행한다");
});

test("위반 없는 합성 트리는 종료 코드 0, 출력에 위반이 없다", () => {
  const tree = make_tree({
    "skills/core/SKILL.md": doc("project.json 은 직접 고치지 않는다.", fence("bash", '$PES status "$DIR"')),
    "agents/reviewer.md": doc("판단만 기록한다."),
    "commands/run.md": doc("1. `status` 를 본다."),
    "docs/adapters/claude-code.md": doc("Claude Code 어댑터 노트."),
  });
  try {
    const res = run_lint(tree.root);
    assert.equal(res.status, 0, res.out);
  } finally {
    tree.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 1 · 막아야 할 것: 업무 상태를 직접 바꾸는 경로

const OLD_CORE_EXAMPLE = fence(
  "bash",
  `python3 -I - "$DIR" <<'EOF'`,
  "import json, sys; from pathlib import Path",
  'f = Path(sys.argv[1]) / "project.json"; p = json.loads(f.read_text())',
  'st = p["stages"]["plan"]',
  "# … 수정 …",
  "f.write_text(json.dumps(p, ensure_ascii=False, indent=1))",
  "EOF",
);

interface Case {
  name: string;
  body: string;
}

const PROJECT_JSON_WRITES: Case[] = [
  { name: "지금 core 스킬의 Python 직접 편집 예제(그대로)", body: OLD_CORE_EXAMPLE },
  { name: "open(..., 'w') + json.dump", body: fence("python", 'with open("project.json", "w", encoding="utf-8") as fh:', "    json.dump(p, fh, ensure_ascii=False)") },
  { name: "os.path.join 경로를 쓰기 모드로 열기", body: fence("python", 'open(os.path.join(d, "project.json"), "w", encoding="utf-8").write(text)') },
  { name: "Path(...).write_text", body: fence("python", 'Path(d, "project.json").write_text(text, encoding="utf-8")') },
  { name: "변수에 담은 경로로 json.dump", body: fence("python", 'f = Path(d) / "project.json"', 'json.dump(p, open(f, "w"))') },
  { name: "한 줄 python -c 로 쓰기", body: fence("bash", `python3 -c "import json; json.dump({}, open('project.json','w'))"`) },
  { name: "jq 결과를 임시 파일로 받아 덮어쓰기", body: fence("bash", `jq '.current = "write"' "$DIR/project.json" > "$DIR/project.json.tmp" && mv "$DIR/project.json.tmp" "$DIR/project.json"`) },
  { name: "echo 리다이렉트", body: fence("bash", `echo '{}' > "$DIR/project.json"`) },
  { name: "append 리다이렉트", body: fence("bash", `printf '%s' "$J" >> "$DIR/project.json"`) },
  { name: "cat 히어독 쓰기", body: fence("bash", `cat > "$DIR/project.json" <<'EOF'`, "{}", "EOF") },
  { name: "sed -i", body: fence("bash", `sed -i 's/"plan"/"research"/' "$DIR/project.json"`) },
  { name: "tee", body: fence("bash", `tee "$DIR/project.json" < new.json`) },
  { name: "다른 파일을 project.json 으로 복사", body: fence("bash", `cp backup.json "$DIR/project.json"`) },
  { name: "mv 로 project.json 자리에 놓기", body: fence("bash", `mv project.json.new project.json`) },
  { name: "Node writeFileSync", body: fence("js", 'fs.writeFileSync(join(dir, "project.json"), JSON.stringify(p));') },
  { name: "PowerShell Set-Content", body: fence("powershell", 'Set-Content -Path "$Dir\\project.json" -Value $text') },
  { name: "PowerShell Out-File", body: fence("powershell", '$json | Out-File -FilePath "$Dir\\project.json" -Encoding utf8') },
];

const SQL_WRITES: Case[] = [
  { name: "sqlite3 UPDATE stages", body: fence("bash", `sqlite3 ~/.pes/pes.db "UPDATE stages SET status='approved' WHERE key='plan'"`) },
  { name: "sqlite3 INSERT INTO approvals", body: fence("bash", `sqlite3 "$HOME/.pes/pes.db" "INSERT INTO approvals (id) VALUES ('x')"`) },
  { name: "sql 블록 DELETE FROM rounds", body: fence("sql", "DELETE FROM rounds WHERE state = 'open';") },
  { name: "소문자 update project_leases", body: fence("sql", "update project_leases set fence = fence + 1;") },
  { name: "INSERT OR REPLACE INTO artifacts", body: fence("bash", `sqlite3 pes.db <<'SQL'`, "INSERT OR REPLACE INTO artifacts (id) VALUES ('a');", "SQL") },
  { name: "영수증 표 지우기", body: fence("sql", "DELETE FROM mutation_commits;") },
  { name: "표 지우기 DROP TABLE answers", body: fence("bash", `sqlite3 pes.db "DROP TABLE answers"`) },
  { name: "Python sqlite3 execute UPDATE", body: fence("python", "conn = sqlite3.connect(db)", `conn.execute("UPDATE rounds SET state = 'sealed'")`, "conn.commit()") },
  { name: "Node DatabaseSync exec", body: fence("js", `db.exec("UPDATE stages SET status = 'active'");`) },
  { name: "문장 속 인라인 명령 예제", body: `- 상태를 맞추려면 \`sqlite3 pes.db "UPDATE stages SET status='active'"\` 를 실행한다.` },
];

const LOCK_WRITES: Case[] = [
  { name: "rm 으로 잠금 파일 지우기", body: fence("bash", `rm -f "$DIR/.pes-lock"`) },
  { name: "echo 로 잠금 파일 만들기", body: fence("bash", `echo "$OWNER" > "$DIR/.pes-lock"`) },
  { name: "touch", body: fence("bash", `touch "$DIR/.pes-lock"`) },
  { name: "mv", body: fence("bash", `mv "$DIR/.pes-lock" /tmp/`) },
  { name: "Python unlink", body: fence("python", '(Path(d) / ".pes-lock").unlink()') },
  { name: "Python write_text", body: fence("python", 'Path(d, ".pes-lock").write_text(json.dumps({"owner": o}))') },
  { name: "os.remove", body: fence("python", 'os.remove(os.path.join(d, ".pes-lock"))') },
  { name: "PowerShell Remove-Item", body: fence("powershell", 'Remove-Item "$Dir\\.pes-lock"') },
  { name: "인라인 명령 예제 rm", body: "- 막히면 `rm .pes-lock` 으로 푼다." },
];

function violation_test(prefix: string, c: Case, path = "skills/core/SKILL.md"): void {
  test(`${prefix}: ${c.name} → 막는다`, () => {
    const tree = make_tree({ [path]: doc(c.body) });
    try {
      const res = run_lint(tree.root);
      assert.notEqual(res.status, 0, `lint 가 통과시켰다:\n${c.body}`);
      assert.ok(res.out.includes(path), `출력에 위반 파일 경로 ${path} 가 있어야 한다:\n${res.out}`);
      assert.doesNotMatch(res.out, /Traceback|TypeError|ReferenceError|SyntaxError/, "lint 가 죽은 것이 아니라 위반을 보고해야 한다");
    } finally {
      tree.cleanup();
    }
  });
}

for (const c of PROJECT_JSON_WRITES) violation_test("project.json 쓰기", c);
for (const c of SQL_WRITES) violation_test("업무 표 쓰기 SQL", c);
for (const c of LOCK_WRITES) violation_test("잠금 파일 조작", c);

test("검사 대상 파일 어디서나 막는다 (skills/*, agents, commands, docs/adapters, 새 스킬 폴더)", () => {
  const paths = [
    "skills/plan/SKILL.md",
    "skills/research/SKILL.md",
    "skills/analyze/SKILL.md",
    "skills/write/SKILL.md",
    "skills/verify/SKILL.md",
    "skills/publish/SKILL.md",
    "skills/extra-new/SKILL.md",
    "agents/researcher.md",
    "agents/writer.md",
    "commands/run.md",
    "commands/setup.md",
    "docs/adapters/opencode.md",
    "docs/adapters/claude-code.md",
    "docs/adapters/claude-app.md",
  ];
  for (const path of paths) {
    const tree = make_tree({ "skills/core/SKILL.md": doc("깨끗하다."), [path]: doc(OLD_CORE_EXAMPLE) });
    try {
      const res = run_lint(tree.root);
      assert.notEqual(res.status, 0, `${path}: 통과하면 안 된다`);
      assert.ok(res.out.includes(path), `${path}: 출력에 경로\n${res.out}`);
    } finally {
      tree.cleanup();
    }
  }
});

test("여러 파일의 위반을 모두 보고한다 (첫 위반에서 멈추지 않는다)", () => {
  const tree = make_tree({
    "skills/core/SKILL.md": doc(OLD_CORE_EXAMPLE),
    "skills/plan/SKILL.md": doc(fence("sql", "DELETE FROM rounds;")),
    "commands/run.md": doc(fence("bash", `rm "$DIR/.pes-lock"`)),
    "agents/writer.md": doc("깨끗하다."),
  });
  try {
    const res = run_lint(tree.root);
    assert.notEqual(res.status, 0);
    for (const path of ["skills/core/SKILL.md", "skills/plan/SKILL.md", "commands/run.md"]) assert.ok(res.out.includes(path), `${path}\n${res.out}`);
    assert.ok(!res.out.includes("agents/writer.md"), "깨끗한 파일은 보고하지 않는다");
  } finally {
    tree.cleanup();
  }
});

test("출력에 위반 줄 번호(경로:줄)가 있다", () => {
  const text = doc(fence("bash", "$PES status x", `echo '{}' > "$DIR/project.json"`));
  const at = text.split("\n").findIndex((l) => l.includes("project.json")) + 1; // 1부터
  const tree = make_tree({ "skills/core/SKILL.md": text });
  try {
    const res = run_lint(tree.root);
    assert.notEqual(res.status, 0);
    assert.match(res.out, new RegExp(`skills/core/SKILL\\.md:${at}\\b`), `경로:줄(${at})\n${res.out}`);
  } finally {
    tree.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 2 · 막으면 안 되는 것 (거짓 양성 0)

const ALLOWED: Case[] = [
  // 산문 — 직접 쓰기를 금지한다고 말하는 정상 문장
  { name: "산문: project.json 을 직접 고치지 않는다", body: "project.json 을 직접 고치지 않는다. 모든 변경은 pes 명령으로 한다." },
  { name: "산문: SQL 로 업무 표를 바꾸지 않는다", body: "UPDATE·INSERT·DELETE 같은 SQL 로 업무 표를 바꾸지 않는다. sqlite3 로 읽기만 한다." },
  { name: "산문: 잠금 파일은 pes lock 이 다룬다", body: "잠금 파일(.pes-lock)은 `pes lock`·`pes unlock` 이 다룬다. 사람이 지우지 않는다." },
  { name: "인라인 코드 이름만", body: "`project.json` 은 옛 형식 파일이고, `sqlite3` 와 `.pes-lock` 은 이름만 적었다." },
  // 자식 제안 파일 (서브에이전트 결과 → pes merge/submit)
  {
    name: "서브에이전트 결과 JSON 을 임시 파일로 쓰고 merge 로 넘긴다 (heredoc)",
    body: fence("bash", `cat > "$DIR/rounds/research-R1/3.json" <<'EOF'`, '{"id": 3, "summary": "요약"}', "EOF", `$PES merge "$DIR" research "$DIR"/rounds/research-R1/*.json`),
  },
  { name: "Python 으로 결과 JSON 파일 쓰기 (rounds/ 경로)", body: fence("python", 'out = Path(d) / "rounds" / "research-R1" / "3.json"', "out.write_text(json.dumps(result, ensure_ascii=False), encoding='utf-8')") },
  { name: "임시 경로에 json.dump", body: fence("python", 'json.dump(result, open("/tmp/result.json", "w"))') },
  { name: "보고서 보조 파일 eli5.json·cover.json 쓰기", body: fence("bash", `cat > "$DIR/reports/plan/eli5.json" <<'EOF'`, "{}", "EOF", `echo '{"subtitle": "x"}' > "$DIR/out/cover.json"`) },
  { name: "질문 명세 파일 쓰기", body: fence("bash", `cp questions/plan.json "$DIR/ask/plan-start.json"`) },
  { name: "결과 폴더 정리", body: fence("bash", `rm "$DIR"/rounds/research-R1/*.json`) },
  // 읽기
  { name: "project.json 읽기 (python -c)", body: fence("bash", `python3 -I -c "import json; print(json.load(open('project.json'))['current'])"`) },
  { name: "project.json 읽기 (jq, cat)", body: fence("bash", `jq .current "$DIR/project.json"`, `cat "$DIR/project.json" | head`) },
  { name: "project.json 읽기 (Path.read_text, open 'r')", body: fence("python", 'p = json.loads((Path(d) / "project.json").read_text())', 'q = json.load(open("project.json", "r", encoding="utf-8"))') },
  { name: "project.json 을 다른 곳으로 복사(읽기)", body: fence("bash", `cp "$DIR/project.json" /tmp/backup.json`) },
  { name: "읽기 전용 Python 히어독", body: fence("bash", `python3 -I - "$DIR" <<'EOF'`, "import json, sys; from pathlib import Path", 'p = json.loads((Path(sys.argv[1]) / "project.json").read_text())', 'print(p["current"])', "EOF") },
  { name: "SELECT 만 하는 sqlite3", body: fence("bash", `sqlite3 ~/.pes/pes.db "SELECT count(*) FROM rounds"`, `sqlite3 ~/.pes/pes.db ".schema stages"`, `sqlite3 ~/.pes/pes.db "PRAGMA table_info(stages)"`) },
  { name: "Python 에서 SELECT", body: fence("python", 'rows = conn.execute("SELECT * FROM stages").fetchall()') },
  { name: "잠금 파일 읽기·목록", body: fence("bash", `cat "$DIR/.pes-lock"`, `ls -a "$DIR"`) },
  // 이름이 비슷한 것
  { name: "이름이 다른 json 파일에 쓰기 (not-project.json, project.jsonl)", body: fence("bash", `echo '{}' > "$DIR/not-project.json"`, `echo '{}' >> "$DIR/project.jsonl"`) },
  { name: "pes 명령으로 잠금·승인", body: fence("bash", `$PES lock "$DIR"`, `$PES lock "$DIR" --force`, `$PES unlock "$DIR"`, `$PES approve "$DIR" plan`) },
  { name: "표의 명령 소개 줄", body: "| `lock <dir> [--force]` · `unlock <dir>` | 세션 표시 (PES_OWNER) |" },
  // SQL 낱말이 우연히 든 것
  { name: "JSON 필드 updated_round·status", body: fence("json", '{"id": 1, "status": "deepen", "updated_round": 2, "request": "update 가 아니라 심화"}') },
  { name: "영어 산문 속 낱말", body: "Insert the answer, then update the summary and delete nothing." },
  // 프로젝트 폴더 배치도 (core 스킬에 있는 블록 그대로)
  {
    name: "프로젝트 폴더 배치도 코드 블록",
    body: fence(
      "",
      "project.json      단일 진실 원천 (stages.<단계>.items/review/settings/…, library, processed)",
      "index.html        대시보드",
      "ask-<id>.html     질문 폼 / ask/<id>.json 질문 명세",
      "feedback/<stage>-R<n>-<시각>.json   받은 답 (kind·text·answers)     feedback.log  수신 로그",
      "snapshots/<stage>-R<n>.json          라운드 스냅샷                  shots/ out/ library/",
    ),
  },
  { name: "새 에이전트 경로 명령", body: fence("bash", `$PES context "$DIR"`, `$PES claim "$DIR" --mode work`, `$PES submit "$DIR" --run "$RUN" --lease "$LEASE" --fence "$FENCE" --file result.json`) },
];

for (const c of ALLOWED) {
  test(`거짓 양성 0: ${c.name} → 통과`, () => {
    const tree = make_tree({ "skills/core/SKILL.md": doc(c.body), "agents/reviewer.md": doc(c.body) });
    try {
      const res = run_lint(tree.root);
      assert.equal(res.status, 0, `정상 사례를 막았다:\n${c.body}\n---\n${res.out}`);
    } finally {
      tree.cleanup();
    }
  });
}

test("검사 대상 밖(tests·scripts·docs/plan·README)은 보지 않는다 — 합성 시험·신뢰 서비스 SQL 허용", () => {
  const bad = [OLD_CORE_EXAMPLE, fence("sql", "INSERT INTO rounds (id) VALUES ('r');", "UPDATE stages SET status = 'approved';"), fence("bash", `rm "$DIR/.pes-lock"`)].join("\n\n");
  const tree = make_tree({
    "skills/core/SKILL.md": doc("깨끗하다."),
    "tests/test_synthetic.test.ts": `// 합성 시험\nwriteFileSync("project.json", "{}");\ndb.exec("INSERT INTO rounds (id) VALUES ('r')");\n`,
    "tests/helpers/seed.ts": `db.run("UPDATE stages SET status = 'approved'");\n`,
    "scripts/pes_core/commands.ts": `db.run("INSERT INTO approvals (id) VALUES (?)", id);\n`,
    "scripts/pes_core/editions.ts": `db.run("UPDATE rounds SET state = 'sealed'");\n`,
    "scripts/pes.py": `(d / ".pes-lock").write_text("x")\nPath("project.json").write_text("{}")\n`,
    "docs/plan/issues/old.md": doc(bad),
    "docs/plan/stage-2.md": doc(bad),
    "README.md": doc(bad),
    "templates/note.md": doc(bad),
  });
  try {
    const res = run_lint(tree.root);
    assert.equal(res.status, 0, `대상 밖 파일을 막았다:\n${res.out}`);
  } finally {
    tree.cleanup();
  }
});

test("CRLF 줄바꿈 문서도 같게 판정한다 (Windows 체크아웃)", () => {
  const bad = doc(OLD_CORE_EXAMPLE).replace(/\n/g, "\r\n");
  const good = doc(fence("bash", `$PES merge "$DIR" research "$DIR"/rounds/research-R1/*.json`), "project.json 을 직접 고치지 않는다.").replace(/\n/g, "\r\n");
  const t1 = make_tree({ "skills/core/SKILL.md": bad });
  const t2 = make_tree({ "skills/core/SKILL.md": good });
  try {
    assert.notEqual(run_lint(t1.root).status, 0, "CRLF 위반도 막는다");
    assert.equal(run_lint(t2.root).status, 0, "CRLF 정상 문서는 통과한다");
  } finally {
    t1.cleanup();
    t2.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 3 · Claude 전용 표기는 docs/adapters/* 에서만

const CLAUDE_MARKS: Case[] = [
  { name: "anthropic-skills:docx", body: "docx 로 바꿀 때는 `anthropic-skills:docx` 스킬을 쓴다." },
  { name: "anthropic-skills:hwpx-uri (코드 블록)", body: fence("text", "anthropic-skills:hwpx-uri") },
  { name: "(Agent, model opus) — 지금 core 의 표기", body: "`pes:reviewer` 서브에이전트(Agent, model opus) 1개: 지시문 파일을 읽고 따르라만 넘긴다." },
  { name: "Agent 도구", body: "Agent 도구로 서브에이전트를 한 번에 최대 5개 띄운다." },
  { name: "Task 도구", body: "Task 도구로 병렬 조사를 맡긴다." },
  { name: "백틱 `Task`", body: "서브에이전트는 `Task` 로 띄운다." },
  { name: "Task( 호출 꼴", body: fence("text", 'Task(subagent_type="pes:researcher")') },
  { name: "AskUserQuestion", body: "여럿이면 AskUserQuestion 으로 고르게 한다." },
];

for (const c of CLAUDE_MARKS) {
  for (const path of ["skills/core/SKILL.md", "skills/publish/SKILL.md", "agents/verifier.md", "commands/start.md"]) {
    test(`Claude 전용 표기 [${c.name}] → ${path} 에서는 막는다`, () => {
      const tree = make_tree({ [path]: doc(c.body) });
      try {
        const res = run_lint(tree.root);
        assert.notEqual(res.status, 0, `통과하면 안 된다:\n${c.body}`);
        assert.ok(res.out.includes(path), res.out);
      } finally {
        tree.cleanup();
      }
    });
  }
  for (const path of ["docs/adapters/claude-code.md", "docs/adapters/claude-app.md", "docs/adapters/opencode.md"]) {
    test(`Claude 전용 표기 [${c.name}] → ${path} 에서는 허용한다`, () => {
      const tree = make_tree({ [path]: doc(c.body) });
      try {
        const res = run_lint(tree.root);
        assert.equal(res.status, 0, `어댑터 노트 예외인데 막았다:\n${res.out}`);
      } finally {
        tree.cleanup();
      }
    });
  }
}

test("Claude 전용 표기 규칙의 거짓 양성 0 — TaskSpace·서브에이전트·agents/·task 낱말", () => {
  const body = [
    "ego-browser 의 TaskSpace 하나만 만들고 끝나면 `listTaskSpaces()` 로 남은 Space 를 닫는다.",
    "서브에이전트는 `agents/researcher.md` 지침을 따른다. 이 task 는 항목 하나만 맡는다.",
    "작업(task)과 에이전트(agent)라는 일반 낱말은 쓸 수 있다.",
    fence("bash", "ls agents/ commands/", `$PES status "$DIR"`),
  ].join("\n\n");
  const tree = make_tree({ "skills/research/SKILL.md": doc(body), "agents/researcher.md": doc(body) });
  try {
    const res = run_lint(tree.root);
    assert.equal(res.status, 0, res.out);
  } finally {
    tree.cleanup();
  }
});

test("어댑터 노트의 예외는 Claude 전용 표기만이다 — 직접 쓰기는 어댑터에서도 막는다", () => {
  const tree = make_tree({ "docs/adapters/claude-code.md": doc("`anthropic-skills:docx` 와 Agent 도구.", OLD_CORE_EXAMPLE) });
  try {
    const res = run_lint(tree.root);
    assert.notEqual(res.status, 0);
    assert.ok(res.out.includes("docs/adapters/claude-code.md"), res.out);
  } finally {
    tree.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 4 · 저장소의 실제 문서

test("저장소 문서가 lint 를 통과한다 (project.json·업무 표·잠금 직접 쓰기 0, Claude 표기는 어댑터에만)", () => {
  const res = run_lint(REPO);
  assert.equal(res.status, 0, `lint 위반:\n${res.out}`);
});

/** lint 와 따로 하는 독립 점검: 코드 조각에서 project.json 을 쓰는 줄·업무 표를 바꾸는 SQL·잠금 파일을 만지는 줄이 0 이다. */
const WRITE_VERBS = /write_text|write_bytes|json\.dump\b|writeFile|Set-Content|Out-File|>\s*["']?[^\s|]*project\.json\b|\bsed\s+-i\b|\btee\b|mode\s*=\s*["']w|open\([^)]*,\s*["'][wax]/;
const SQL_WRITE = /\b(INSERT\s+(OR\s+\w+\s+)?INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|DROP\s+TABLE|ALTER\s+TABLE|REPLACE\s+INTO)\b/i;
const LOCK_TOUCH = /\b(rm|mv|touch|unlink|remove|write_text|Remove-Item)\b[^\n]*\.pes-lock|\.pes-lock[^\n]*(write_text|unlink|\.write\()|>\s*["']?[^\s]*\.pes-lock/;

test("독립 점검: 대상 문서 코드 조각에 project.json·업무 표·잠금 직접 쓰기가 0이다", () => {
  const hits: string[] = [];
  for (const rel of target_docs()) {
    const text = repo_doc(rel);
    for (const seg of code_segments(text)) {
      const lines = seg.text.split("\n");
      const block_mentions_project_json = lines.some((l) => /(^|[^\w.-])project\.json(?![\w.])/.test(l));
      lines.forEach((l, k) => {
        const where = `${rel}:${seg.line + (seg.kind === "fence" ? k : 0)}`;
        if (block_mentions_project_json && WRITE_VERBS.test(l)) hits.push(`${where}: project.json 쓰기 의심 — ${l.trim()}`);
        if (SQL_WRITE.test(l)) hits.push(`${where}: 업무 표 쓰기 SQL — ${l.trim()}`);
        if (LOCK_TOUCH.test(l)) hits.push(`${where}: 잠금 파일 조작 — ${l.trim()}`);
      });
    }
  }
  assert.deepEqual(hits, [], hits.join("\n"));
});

const CLAUDE_ONLY = /anthropic-skills:|AskUserQuestion|\(Agent[,)]|\bAgent\s*(도구|tool\b)|\bTask\s*(도구|tool\b)|`(Agent|Task)`|\bTask\(/;

test("독립 점검: Claude 전용 표기는 docs/adapters/* 밖에 0이다", () => {
  const hits: string[] = [];
  for (const rel of target_docs()) {
    if (rel.startsWith("docs/adapters/")) continue;
    repo_doc(rel)
      .split("\n")
      .forEach((l, k) => {
        if (CLAUDE_ONLY.test(l)) hits.push(`${rel}:${k + 1}: ${l.trim().slice(0, 100)}`);
      });
  }
  assert.deepEqual(hits, [], hits.join("\n"));
});

// ---------------------------------------------------------------------------
// 5 · 연구 절차·독립 검토·근거 확인이 남아 있다 (지금 문서에서 뽑은 필수 절차 목록)
//
// 정규식은 낱말 하나에 묶지 않고, 절차의 뼈대(누가·무엇을·어떻게)를 잡는다. 문장을 다듬거나 pes 명령으로 바꿔도 통과하고,
// 절차 자체를 지우면 실패한다.

interface Need {
  file: string;
  id: string;
  re: RegExp;
  /** 있으면 이 제목(## / ###)의 절 안에서만 찾는다 — 같은 낱말이 다른 절에도 있어서 한 줄을 지워도 안 걸리는 것을 막는다. */
  sec?: RegExp;
}

/** 제목 줄이 heading 에 맞는 절: 그 제목 줄부터 같은 단계 이하(#의 수가 같거나 적은) 다음 제목 앞까지. 없으면 빈 문자열. */
function section_of(markdown: string, heading: RegExp): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((l) => heading.test(l));
  if (start < 0) return "";
  const level = /^(#+)/.exec(lines[start]!)![1]!.length;
  let end = lines.length;
  let fenced = false;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i]!)) fenced = !fenced;
    const h = fenced ? null : /^(#+)\s/.exec(lines[i]!);
    if (h !== null && h[1]!.length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

const NEEDS: Need[] = [
  // --- 독립 검토 (core) ---
  { file: "skills/core/SKILL.md", id: "독립 검토는 모든 단계·모든 라운드, 생략하지 않는다", re: /^###\s+독립 검토[^\n]*(모든 단계|모든 라운드)[^\n]*생략하지 않는다/m, sec: /^###\s+독립 검토/ },
  { file: "skills/core/SKILL.md", id: "자체 점검만으로 끝내지 않고 다른 에이전트가 다시 본다", re: /다른 에이전트가 다시 본다|자체 점검[^\n]{0,20}(만으로|끝내지)/ },
  { file: "skills/core/SKILL.md", id: "검토 지시문 만들기 qa-brief", re: /qa-brief <dir>/, sec: /^###\s+독립 검토/ },
  { file: "skills/core/SKILL.md", id: "검토원은 reviewer 서브에이전트", re: /reviewer 역할/, sec: /^###\s+독립 검토/ },
  { file: "skills/core/SKILL.md", id: "메인의 결론·기대를 검토원에 넘기지 않는다", re: /결론[·과 ]*기대를[^\n]{0,20}(쓰지|넘기지|주지) ?않/ },
  { file: "skills/core/SKILL.md", id: "검토 결과 기록 qa", re: /`qa <dir> <stage>`|\bqa\b[^\n]{0,30}기록/, sec: /^###\s+독립 검토/ },
  { file: "skills/core/SKILL.md", id: "high 지적과 놓친 것은 점검 질문에 반영", re: /missed_by_self_review/ },
  { file: "skills/core/SKILL.md", id: "판정 fail 이면 승인을 권하지 않는다", re: /fail[^\n]{0,30}승인을 권하지 않는다/ },
  // --- 근거 기록 (core) ---
  { file: "skills/core/SKILL.md", id: "사실·수치는 sources 에 있어야 한다", re: /sources[^\n]{0,30}있어야 한다/ },
  // 0022: 추측 금지 — 모르면 먼저 찾고, 못 찾으면 "확인하지 못함"
  { file: "skills/core/SKILL.md", id: "모르면 먼저 찾는다", re: /모르면 먼저 찾는다/, sec: /^###\s+근거 기록/ },
  { file: "skills/core/SKILL.md", id: "찾지 못하면 확인하지 못함", re: /확인하지 못함/, sec: /^###\s+근거 기록/ },
  { file: "skills/core/SKILL.md", id: "추측하지 않는다 · (추정) 금지", re: /추측하지 않는다[^\n]*"\(추정\)" 문장을 쓰지 않는다/, sec: /^###\s+근거 기록/ },
  { file: "skills/core/SKILL.md", id: "요약 줄마다 근거 항목 표기", re: /\(근거: 조사 #/, sec: /^###\s+근거 기록/ },
  { file: "skills/core/SKILL.md", id: "원문 확인으로 치는 method (browser·kosis·law·vworld)", re: /browser[·, ]*kosis[·, ]*law[·, ]*vworld/ },
  // --- 점검·해석·보고서 (core) ---
  { file: "skills/core/SKILL.md", id: "AI 점검 gap.kind 6종", re: /conflict[\s\S]{0,400}weak[\s\S]{0,400}blank[\s\S]{0,400}stale[\s\S]{0,400}decide[\s\S]{0,400}scope/ },
  { file: "skills/core/SKILL.md", id: "모호한 답은 점검 질문으로 되묻는다", re: /모호할 때만/ },
  { file: "skills/core/SKILL.md", id: "서브에이전트 결과는 파일에 쓰고 한 줄만 돌려준다", re: /rounds\/<단계>-R<n>\/<id>\.json[^\n]{0,40}한 줄/ },
  { file: "skills/core/SKILL.md", id: "통째로 읽지 않고 digest·show 로 본다", re: /digest[\s\S]{0,60}show/, sec: /^##\s+토큰 절약/ },
  { file: "skills/core/SKILL.md", id: "단계 보고서 report (md·html·eli5)", re: /report <dir> <단계>/ },
  { file: "skills/core/SKILL.md", id: "승인 전 남은 일은 carry_over 로 넘기고 지우지 않는다", re: /`set <dir> <단계> carry_over/, sec: /^###\s+근거 기록/ },
  { file: "skills/core/SKILL.md", id: "다른 세션 잠금은 억지로 풀지 않는다", re: /억지로 풀지/ },
  { file: "skills/core/SKILL.md", id: "HWP 출처도 열어 읽는다", re: /HWP/ },
  { file: "skills/core/SKILL.md", id: "CAPTCHA 는 풀지 않는다", re: /보안문자/ },
  // --- plan ---
  { file: "skills/plan/SKILL.md", id: "연구 질문·목차·조사 항목·일정 종류", re: /`rq`[\s\S]{0,300}`chapter`[\s\S]{0,300}`topic`[\s\S]{0,300}`schedule`/ },
  { file: "skills/plan/SKILL.md", id: "topic 은 chapter 와 연결, chapter 마다 근거 topic", re: /최소 한 chapter[\s\S]{0,80}근거가 될 topic/ },
  { file: "skills/plan/SKILL.md", id: "기존 조사(reuse) 대조", re: /"reuse": <library id>/, sec: /^##\s+R1에 만드는 것/ },
  { file: "skills/plan/SKILL.md", id: "기획 단계에서는 새 조사를 하지 않는다", re: /새 조사를 하지 않는다/ },
  { file: "skills/plan/SKILL.md", id: "승인 전 독립 검토 확인", re: /독립 검토/ },
  { file: "skills/plan/SKILL.md", id: "승인 approve <dir> plan", re: /approve <dir> plan/ },
  // --- research ---
  { file: "skills/research/SKILL.md", id: "항목당 researcher 서브에이전트 병렬, 최대 5개", re: /researcher[\s\S]{0,60}(최대 5개|5개)/ },
  { file: "skills/research/SKILL.md", id: "서브에이전트 지시문에 이미 확인한 출처·범위 밖·도구 규칙", re: /\[이미 확인한 출처\][\s\S]{0,1500}\[범위 밖\][\s\S]{0,600}\[도구 규칙\]/, sec: /^###\s+서브에이전트 지시문/ },
  { file: "skills/research/SKILL.md", id: "사용자 제공 링크는 반드시 열어 읽는다", re: /반드시 열어 읽/, sec: /^##\s+사용자 제공 링크·자료/ },
  { file: "skills/research/SKILL.md", id: "병합 뒤 digest 로 항목 사이 충돌을 찾아 conflicts 에 기록", re: /digest[\s\S]{0,120}충돌[\s\S]{0,60}conflicts/ },
  { file: "skills/research/SKILL.md", id: "법령은 인용 조문 검증(verify_citations)", re: /verify_citations/, sec: /^###\s+법령/ },
  { file: "skills/research/SKILL.md", id: "parallel=max 면 승인 전 verifier", re: /max[\s\S]{0,40}verifier/, sec: /^##\s+라운드/ },
  { file: "skills/research/SKILL.md", id: "남은 conflicts·원문 미확인 비율을 정직하게 적는다", re: /원문 미확인 비율[\s\S]{0,40}정직하게/ },
  { file: "skills/research/SKILL.md", id: "국내 자료는 브라우저로 원문 대조", re: /원문 대조/ },
  { file: "skills/research/SKILL.md", id: "KOSIS 가공은 AI 가공을 conflicts 에 남긴다", re: /AI 가공/, sec: /^##\s+도구 규칙/ },
  { file: "skills/research/SKILL.md", id: "승인 approve <dir> research", re: /approve <dir> research/ },
  // --- analyze ---
  { file: "skills/analyze/SKILL.md", id: "새 사실을 만들지 않는다", re: /새 사실을 만들지 않는다/ },
  { file: "skills/analyze/SKILL.md", id: "쟁점·비교표는 links.research 로 근거 연결", re: /`issue`[^\n]*links\.research[^\n]*\n[^\n]*`table`[^\n]*links\.research/, sec: /^##\s+라운드에서 만드는 것/ },
  { file: "skills/analyze/SKILL.md", id: "연구 질문마다 issue 하나 이상", re: /연구 질문\(rq\)마다 최소 하나의 issue/ },
  { file: "skills/analyze/SKILL.md", id: "통계 가공은 계산 방법을 적는다", re: /계산 방법을 적/ },
  { file: "skills/analyze/SKILL.md", id: "승인 전 독립 검토 확인", re: /독립 검토/ },
  { file: "skills/analyze/SKILL.md", id: "승인 approve <dir> analyze", re: /approve <dir> analyze/ },
  // --- write ---
  { file: "skills/write/SKILL.md", id: "문장마다 각주 [^k] 로 출처 연결", re: /\[\^k\]/ },
  { file: "skills/write/SKILL.md", id: "수치·조문은 근거 항목에 있는 값만", re: /근거 항목에 있는 값/ },
  { file: "skills/write/SKILL.md", id: "장마다 writer 서브에이전트", re: /writer/ },
  { file: "skills/write/SKILL.md", id: "원고 조립 assemble", re: /assemble <dir>/, sec: /^##\s+라운드/ },
  { file: "skills/write/SKILL.md", id: "모든 chapter 에 section, section 에 links.analyze·sources", re: /links\.analyze[\s\S]{0,20}sources/ },
  { file: "skills/write/SKILL.md", id: "승인 전 독립 검토 확인", re: /독립 검토/ },
  { file: "skills/write/SKILL.md", id: "승인 approve <dir> write", re: /approve <dir> write/ },
  // --- verify ---
  { file: "skills/verify/SKILL.md", id: "주장 claim 항목을 뽑는다", re: /kind=`claim`/, sec: /^##\s+주장 항목/ },
  { file: "skills/verify/SKILL.md", id: "verifier 서브에이전트에 결론·기대를 주지 않는다", re: /verifier[\s\S]{0,200}결론이나 기대하는 답을 주지 않는다/ },
  { file: "skills/verify/SKILL.md", id: "판정 supported/partial/unsupported", re: /supported[\s\S]{0,30}partial[\s\S]{0,30}unsupported/, sec: /^##\s+주장 항목/ },
  { file: "skills/verify/SKILL.md", id: "법령 인용 verify_citations", re: /verify_citations/ },
  { file: "skills/verify/SKILL.md", id: "unsupported 는 재조사·완화·삭제를 점검 질문으로", re: /재조사[\s\S]{0,20}완화[\s\S]{0,20}삭제/, sec: /^##\s+처리/ },
  { file: "skills/verify/SKILL.md", id: "승인 전 독립 검토 확인", re: /독립 검토/ },
  { file: "skills/verify/SKILL.md", id: "승인 approve <dir> verify", re: /approve <dir> verify/ },
  // --- publish ---
  { file: "skills/publish/SKILL.md", id: "먼저 assemble 로 최신 원고", re: /assemble/ },
  { file: "skills/publish/SKILL.md", id: "형식 hwpx·docx·pdf·web·slides", re: /hwpx[\s\S]{0,1200}docx[\s\S]{0,400}pdf[\s\S]{0,800}web[\s\S]{0,1200}slides/ },
  { file: "skills/publish/SKILL.md", id: "웹 보고서는 HTML 을 직접 쓰지 않고 web 명령", re: /HTML을 직접 쓰지 않는다/ },
  { file: "skills/publish/SKILL.md", id: "부록: 출처 확인됨/미확인 구분", re: /appendix-sources\.md[^\n]*확인됨\/미확인/, sec: /^##\s+라운드/ },
  { file: "skills/publish/SKILL.md", id: "산출물마다 output 항목", re: /`output`/ },
  { file: "skills/publish/SKILL.md", id: "승인 전 독립 검토로 승인된 원고와 같은지 확인", re: /독립 검토[\s\S]{0,120}승인된 원고와 같은지/ },
  { file: "skills/publish/SKILL.md", id: "최종 승인 approve <dir> publish", re: /approve <dir> publish/ },
  // --- 서브에이전트 지침 ---
  { file: "agents/researcher.md", id: "한 항목만 조사한다", re: /한 항목만/ },
  { file: "agents/researcher.md", id: "이미 확인한 출처는 다시 확인하지 않는다", re: /이미 확인한 출처[^\n]{0,30}다시 확인하지 않는다/ },
  { file: "agents/researcher.md", id: "찾지 못한 것은 open_questions 에 남긴다", re: /찾지 못함/ },
  { file: "agents/researcher.md", id: "출처 method 구분 (search 는 원문 미확인, browser 는 원문 확인)", re: /검색 결과 요약만 봤으면 search[\s\S]{0,200}fetch[\s\S]{0,200}browser[\s\S]{0,200}kosis[\s\S]{0,100}law[\s\S]{0,100}vworld/ },
  { file: "agents/researcher.md", id: "스크립트 계산은 AI 가공 표시", re: /AI 가공/ },
  { file: "agents/researcher.md", id: "사용자 제공 링크는 모두 열어 읽는다", re: /모두 열어 읽는다/ },
  { file: "agents/researcher.md", id: "결과는 지정 파일에 쓰고 한 줄만 반환", re: /결과 파일[\s\S]{0,400}한 줄/ },
  { file: "agents/researcher.md", id: "보안문자는 풀지 않고 건너뛴다", re: /보안문자[^\n]{0,30}(풀지 말고|풀지 않)/ },
  { file: "agents/reviewer.md", id: "독립 검토원: 메인 결론에 맞춰 주지 않는다", re: /맞춰 주지 않는다/ },
  { file: "agents/reviewer.md", id: "QC 와 QA 를 나눠 본다", re: /### QC[\s\S]{0,1200}### QA/, sec: /^##\s+보는 것/ },
  { file: "agents/reviewer.md", id: "자체 점검 초안은 마지막에 읽는다", re: /마지막에\*\* 읽는다|마지막에 읽는다/ },
  { file: "agents/reviewer.md", id: "핵심 주장 3~5개는 출처 원문을 직접 연다 (표본 대조)", re: /3~5개[\s\S]{0,60}원문을 직접 연다/ },
  { file: "agents/reviewer.md", id: "표본 결과 match/differ/unreachable", re: /match[\s\S]{0,20}differ[\s\S]{0,20}unreachable/, sec: /^###\s+표본 대조/ },
  { file: "agents/reviewer.md", id: "판정 pass/pass_with_issues/fail", re: /pass[\s\S]{0,10}pass_with_issues[\s\S]{0,10}fail/ },
  { file: "agents/reviewer.md", id: "놓친 것·근거 없는 문장 기록", re: /missed_by_self_review[\s\S]{0,200}evidence_gaps/ },
  { file: "agents/reviewer.md", id: "항목 본문을 고치지 않고 판단만 기록", re: /고치지 않는다[^\n]{0,20}판단만/ },
  { file: "agents/reviewer.md", id: "추측은 쓰지 않는다(evidence 칸 필수)", re: /evidence 칸은 반드시 채운다/ },
  { file: "agents/verifier.md", id: "출처를 직접 열어 확인한다", re: /출처 원문을 직접 열어 확인한다[\s\S]*출처를 직접 연다/ },
  { file: "agents/verifier.md", id: "판정 supported/partial/unsupported", re: /판정: supported[\s\S]{0,60}partial[\s\S]{0,80}unsupported/ },
  { file: "agents/verifier.md", id: "추측하지 않는다", re: /추측하지 않는다/ },
  { file: "agents/verifier.md", id: "보안문자는 partial + 열람 불가 표기", re: /열람 불가\(보안문자\)/ },
  { file: "agents/writer.md", id: "근거 자료에 있는 사실·수치만, 새 검색 없음", re: /근거 자료에 있는 사실·수치만[\s\S]{0,40}새 검색은 하지 않는다/ },
  { file: "agents/writer.md", id: "근거 없음은 open_questions 에", re: /근거 없음/ },
  { file: "agents/writer.md", id: "각주 [^k] 는 실제로 인용한 출처만", re: /\[\^k\][\s\S]{0,120}실제로 인용한 출처만/ },
];

test("필수 절차 목록이 지금 문서에서 뽑은 것임을 확인한다 (목록이 문서와 어긋나면 알린다)", () => {
  // 이 시험은 구현 전에도 통과해야 한다 — 목록 자체가 현재 문서의 사실이어야 기준으로 쓸 수 있다.
  assert.ok(NEEDS.length >= 80, `필수 절차 ${NEEDS.length}개`);
});

for (const need of NEEDS) {
  test(`절차 유지: ${need.file} — ${need.id}`, () => {
    const text = need.sec === undefined ? repo_doc(need.file) : section_of(repo_doc(need.file), need.sec);
    assert.match(text, need.re, `${need.file} 에서 절차가 사라졌다${need.sec === undefined ? "" : ` (절 ${need.sec})`}: ${need.id}`);
  });
}

// 모든 필수 절차: 일치한 구간의 첫 줄(또는 끝 줄)을 지우면 반드시 실패해야 한다 — 같은 낱말이 다른 곳에도 있어서 지워도 통과하는 정규식을 막는다.
// (그런 것은 sec 로 절을 좁히거나 정규식을 그 한 줄에 맞게 좁힌다. 좁히기는 약화가 아니다 — 새 정규식·절은 원래보다 같거나 더 구체적이다.)
for (const need of NEEDS) {
  test(`절차 유지 날카로움: ${need.file} — ${need.id} (일치한 줄을 지우면 실패한다)`, () => {
    const text = need.sec === undefined ? repo_doc(need.file) : section_of(repo_doc(need.file), need.sec);
    const hit = need.re.exec(text);
    assert.ok(hit !== null, "지금 문서에서 통과해야 한다");
    const flags = need.re.flags.replace("g", "");
    const re = new RegExp(need.re.source, flags);
    const first_from = text.lastIndexOf("\n", hit.index) + 1;
    const last_pos = hit.index + Math.max(hit[0].length - 1, 0);
    const last_from = text.lastIndexOf("\n", last_pos) + 1;
    const cut_line = (from: number): string => {
      let to = text.indexOf("\n", from);
      if (to < 0) to = text.length;
      return text.slice(0, from) + text.slice(to);
    };
    assert.ok(!re.test(cut_line(first_from)), `일치 구간의 첫 줄을 지워도 통과한다 — 같은 절차를 다른 줄도 만족시킨다: ${need.id}`);
    assert.ok(!re.test(cut_line(last_from)), `일치 구간의 끝 줄을 지워도 통과한다: ${need.id}`);
  });
}

test("절차 유지: 각 단계 스킬은 시작 질문 → 라운드 → 독립 검토 확인 → 승인 → 단계 보고서의 뼈대를 모두 갖는다", () => {
  for (const stage of STAGES) {
    const text = repo_doc(`skills/${stage}/SKILL.md`);
    assert.match(text, new RegExp(`ask-prep <dir> ${stage}`), `${stage}: 시작 질문`);
    assert.match(text, new RegExp(`approve <dir> ${stage}`), `${stage}: 승인`);
    assert.match(text, /독립 검토/, `${stage}: 독립 검토 확인`);
    assert.match(text, new RegExp(`report <dir> ${stage}`), `${stage}: 단계 보고서`);
  }
});

test("절차 유지: 단계 스킬과 에이전트는 문서 줄 수가 절반 아래로 줄지 않는다 (절차를 통째로 지운 것 방지)", () => {
  const MIN_LINES: Record<string, number> = {
    "skills/core/SKILL.md": 100,
    "skills/plan/SKILL.md": 25,
    "skills/research/SKILL.md": 55,
    "skills/analyze/SKILL.md": 22,
    "skills/write/SKILL.md": 26,
    "skills/verify/SKILL.md": 24,
    "skills/publish/SKILL.md": 18,
    "agents/researcher.md": 12,
    "agents/reviewer.md": 25,
    "agents/verifier.md": 10,
    "agents/writer.md": 10,
  };
  for (const [file, min] of Object.entries(MIN_LINES)) {
    const n = repo_doc(file).split("\n").filter((l) => l.trim() !== "").length;
    assert.ok(n >= min, `${file}: 비어 있지 않은 줄 ${n}개 < ${min}`);
  }
});

// ---------------------------------------------------------------------------
// 6 · 업무 경로별 검증 명령 (문자열 0건만이 아니다)

const CMDS = pes_cmds();

test("새 에이전트 경로 명령이 pes.py CMDS 에 있다 (context·claim·submit·wait·complete)", () => {
  for (const name of ["context", "claim", "submit", "wait", "complete"]) assert.ok(CMDS.includes(name), name);
});

test("문서가 `$PES <이름>` 으로 부르는 명령은 모두 pes.py CMDS 에 있다", () => {
  for (const rel of target_docs()) {
    const bad = unknown_invocations(repo_doc(rel), CMDS);
    assert.deepEqual(bad, [], `${rel}: pes.py 에 없는 명령 ${bad.join(", ")}`);
  }
});

test("core 스킬 명령표(첫 칸)의 명령은 모두 pes.py CMDS 에 있다", () => {
  const core_all = repo_doc("skills/core/SKILL.md");
  const from = core_all.indexOf("## CLI");
  const to = core_all.indexOf("## 프로젝트 폴더");
  assert.ok(from >= 0 && to > from, "core 스킬에 'CLI' 절과 '프로젝트 폴더' 절이 있다");
  const rows = core_all.slice(from, to).split("\n").filter((l) => /^\|\s*`/.test(l));
  assert.ok(rows.length >= 15, `명령표 줄 ${rows.length}개`);
  const bad: string[] = [];
  for (const row of rows) {
    const first_cell = row.split("|")[1] ?? "";
    for (const m of first_cell.matchAll(/`([^`]+)`/g)) {
      const word = m[1]!.trim().split(/\s+/)[0]!;
      if (word === "setup.py") continue;
      if (!CMDS.includes(word)) bad.push(`${word} (${row.slice(0, 40)})`);
    }
  }
  assert.deepEqual(bad, []);
});

interface Route {
  route: string;
  files: string[];
  /** 모든 파일에서 합쳐 이 명령들을 소개해야 한다. */
  all: string[];
  /** 파일마다 이 중 하나 이상을 소개해야 한다. */
  each_any?: string[];
}

const ROUTES: Route[] = [
  { route: "프로젝트 시작", files: ["commands/start.md"], all: ["init", "ask-prep", "ask", "serve", "open", "watch", "lock"] },
  { route: "이어서 진행", files: ["commands/run.md"], all: ["lock", "status", "pending", "mark", "serve"] },
  { route: "라운드 시작", files: ["skills/core/SKILL.md"], all: ["round-start"] },
  { route: "결과 병합(서브에이전트 결과 → 상태)", files: ["skills/core/SKILL.md"], all: ["merge"] },
  { route: "단계 시작 질문", files: ["skills/core/SKILL.md"], all: ["ask-prep", "ask"] },
  { route: "답 받기·처리 표시", files: ["skills/core/SKILL.md"], all: ["pending", "mark", "chat", "watch", "serve", "open"] },
  { route: "독립 검토", files: ["skills/core/SKILL.md"], all: ["qa-brief", "qa"] },
  { route: "화면·스냅샷", files: ["skills/core/SKILL.md"], all: ["render"] },
  { route: "승인·다시 열기", files: ["skills/core/SKILL.md"], all: ["approve", "reopen"] },
  { route: "단계 보고서", files: ["skills/core/SKILL.md"], all: ["report"] },
  { route: "인계 메모·상태", files: ["skills/core/SKILL.md"], all: ["note", "status", "digest", "show"] },
  { route: "세션 잠금", files: ["skills/core/SKILL.md"], all: ["lock", "unlock"] },
  { route: "에이전트 작업 경로(context→claim→submit)", files: ["skills/core/SKILL.md"], all: ["context", "claim", "submit"] },
  // SEL-50: 요약·변경점·남은 일·설정·점검·최종 요약/결론은 전용 명령 set (note·section 우회 금지)
  { route: "단계 요약·변경점·남은 일·설정·점검 쓰기(set)", files: ["skills/core/SKILL.md"], all: ["set"] },
  { route: "기획 요약(set)", files: ["skills/plan/SKILL.md"], all: ["set"] },
  { route: "조사 요약(set)", files: ["skills/research/SKILL.md"], all: ["set"] },
  { route: "분석 요약(set)", files: ["skills/analyze/SKILL.md"], all: ["set"] },
  { route: "집필 요약(set)", files: ["skills/write/SKILL.md"], all: ["set"] },
  { route: "검증 요약(set)", files: ["skills/verify/SKILL.md"], all: ["set"] },
  // 단계별: 결과를 상태로 넘기는 길 — 직접 쓰기 대신 merge 또는 submit
  { route: "기획 항목 입력", files: ["skills/plan/SKILL.md"], all: ["ask-prep", "approve"], each_any: ["merge", "submit"] },
  { route: "조사 결과 병합", files: ["skills/research/SKILL.md"], all: ["ask-prep", "merge", "digest", "approve"] },
  { route: "분석 항목 입력", files: ["skills/analyze/SKILL.md"], all: ["ask-prep", "approve"], each_any: ["merge", "submit"] },
  { route: "집필 병합·조립", files: ["skills/write/SKILL.md"], all: ["ask-prep", "merge", "assemble", "digest", "approve"] },
  { route: "검증 병합", files: ["skills/verify/SKILL.md"], all: ["ask-prep", "merge", "assemble", "digest", "approve", "render"] },
  { route: "산출", files: ["skills/publish/SKILL.md"], all: ["ask-prep", "assemble", "web", "approve"] },
];

for (const r of ROUTES) {
  test(`업무 경로 [${r.route}]: 문서가 지시하는 pes 명령이 CMDS 에 있다`, () => {
    const seen = new Set<string>();
    for (const file of r.files) {
      const here = mentioned_commands(repo_doc(file), CMDS);
      for (const name of here) seen.add(name);
      if (r.each_any !== undefined) assert.ok(r.each_any.some((n) => here.has(n)), `${file}: ${r.each_any.join(" 또는 ")} 중 하나를 지시해야 한다 (직접 편집 대신)`);
    }
    for (const name of r.all) {
      assert.ok(CMDS.includes(name), `pes.py CMDS 에 ${name} 이 없다`);
      assert.ok(seen.has(name), `${r.files.join(", ")} 가 ${name} 명령을 지시하지 않는다 (지시 명령: ${[...seen].sort().join(" ")})`);
    }
  });
}

test("업무 경로: 결과를 상태로 넘기는 모든 문서가 직접 편집 대신 merge/submit 을 말한다 (직접 편집 문구 0)", () => {
  // 지금 core 의 'project.json 편집' 절과 plan 의 'Python 으로 stages.plan.items 에 직접 쓴다' 가 바뀌었는지.
  const core = repo_doc("skills/core/SKILL.md");
  assert.doesNotMatch(core, /^##\s*project\.json 편집/m, "core: 'project.json 편집' 절이 남아 있다");
  assert.doesNotMatch(core, /Python으로 읽고 써서/, "core: Python 으로 읽고 써서 편집하라는 문구");
  const plan = repo_doc("skills/plan/SKILL.md");
  assert.doesNotMatch(plan, /Python으로 `stages\.plan\.items`에 직접 쓴다/, "plan: 항목을 Python 으로 직접 쓰라는 문구");
  for (const rel of target_docs()) {
    if (rel.startsWith("docs/adapters/")) continue;
    const text = repo_doc(rel);
    assert.doesNotMatch(text, /직접 (쓴다|고친다|수정한다)[^\n]{0,20}(project\.json|stages\.)|(project\.json|stages\.[a-z<>]+\.[a-z]+)[^\n]{0,30}에 직접 (쓴다|고친다)/, `${rel}: 상태를 직접 쓰라는 문장`);
  }
});

test("업무 경로: 서브에이전트 지침이 부르는 pes 명령(show 등)도 CMDS 에 있다", () => {
  const known = new Set(CMDS);
  for (const rel of target_docs().filter((p) => p.startsWith("agents/"))) {
    for (const name of mentioned_commands(repo_doc(rel), CMDS)) assert.ok(known.has(name), `${rel}: ${name}`);
  }
});

// ---------------------------------------------------------------------------
// 7 · 어댑터 노트

const ADAPTERS = ["opencode", "claude-code", "claude-app"] as const;

for (const name of ADAPTERS) {
  test(`어댑터 노트 docs/adapters/${name}.md 가 있고 비어 있지 않다`, () => {
    const path = join(REPO, "docs", "adapters", `${name}.md`);
    assert.ok(existsSync(path), `docs/adapters/${name}.md`);
    const text = read_text(path);
    assert.match(text, /^#\s+\S/m, "제목이 있다");
    assert.ok(text.replace(/\s+/g, "").length >= 200, "내용이 있다 (제목만 있는 껍데기가 아니다)");
    assert.match(text, name === "opencode" ? /opencode/i : /Claude/, "어느 환경의 노트인지 적혀 있다");
  });
}

test("claude-code 어댑터 노트가 중립 문서에서 뺀 Claude 전용 표기의 대응을 기록한다 (정보를 잃지 않는다)", () => {
  const text = read_text(join(REPO, "docs", "adapters", "claude-code.md"));
  assert.match(text, /anthropic-skills:/, "변환 스킬 이름 anthropic-skills:*");
  assert.match(text, /AskUserQuestion/, "사용자에게 고르게 하는 도구");
  assert.match(text, /\bAgent\b|\bTask\b/, "서브에이전트를 띄우는 도구 이름");
  assert.match(text, /reviewer|researcher|verifier|writer/, "서브에이전트 지침과의 연결");
});

test("어댑터 노트는 이름만 바꿔 변환 지원을 주장하지 않는다 — 한계를 적고, 긍정 주장은 없다", () => {
  const CLAIM = /(자동\s*변환|변환(을|이)?\s*지원|완전\s*호환|그대로\s*(동작|작동|쓸 수)|모두\s*지원|전부\s*지원|fully\s+supported|drop-in)/i;
  const NEGATED = /(않|없|못|미지원|아니|제외|필요하다|직접|수동)/;
  const LIMIT = /(지원하지 않|미지원|하지 않는다|아직|제한|한계|못한다|수동|직접 (옮|바꿔|맞))/;
  let any_limit = false;
  for (const name of ADAPTERS) {
    const text = read_text(join(REPO, "docs", "adapters", `${name}.md`));
    if (LIMIT.test(text)) any_limit = true;
    for (const sentence of text.split(/(?<=[.!?。다])\s+|\n/)) {
      if (CLAIM.test(sentence)) assert.match(sentence, NEGATED, `${name}: 부정 없는 지원 주장 — ${sentence.trim()}`);
    }
  }
  assert.ok(any_limit, "어댑터 노트 중 한 곳 이상이 지원하지 않는 것·한계를 적는다");
  const opencode = read_text(join(REPO, "docs", "adapters", "opencode.md"));
  assert.match(opencode, LIMIT, "opencode 노트는 무엇이 아직 안 되는지(변환 미지원 등)를 적는다");
});

test("어댑터 노트에도 직접 쓰기 예제가 없다 (lint 와 별개로 한 번 더)", () => {
  for (const name of ADAPTERS) {
    const rel = `docs/adapters/${name}.md`;
    if (!existsSync(join(REPO, rel))) continue;
    for (const seg of code_segments(repo_doc(rel))) {
      for (const l of seg.text.split("\n")) assert.ok(!SQL_WRITE.test(l) && !LOCK_TOUCH.test(l), `${rel}: ${l}`);
    }
  }
});
