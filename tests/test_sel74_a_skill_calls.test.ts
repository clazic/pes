// SEL-74 A — skills · commands · agents (and README / AGENTS) call the TypeScript tools, never Python.
//   * no `python3 …/pes.py`, `setup.py`, `py -3`, `python3 -I -` call anywhere in skills/ commands/ agents/ docs/adapters/ (and no
//     `.py` file name at all in those documents), and no call of that shape in README.md / AGENTS.md / CLAUDE.md
//   * the executable form is `node ${CLAUDE_PLUGIN_ROOT}/scripts/pes.ts <명령>` and `node …/scripts/setup.ts <명령>`
//   * lint_skills.ts has a rule "Python 호출" that stops the old form (code blocks and inline commands; prose is not looked at)
//   * the D14 flow is in the documents: a refusal "먼저 이전하세요" → ask the user → `migrate`
// Written before the edit: these fail until the documents are switched.
import assert from "node:assert/strict";
import { test } from "node:test";

import { code_segments, doc, fence, make_tree, pes_cmds, read_text, repo_doc, REPO, run_lint, target_docs, unknown_invocations } from "./helpers/skill_docs.ts";
import { repo_files } from "./helpers/sel74_env.ts";

const DOC_DIRS = ["skills", "commands", "agents", "docs/adapters"];
const doc_files = (): string[] => DOC_DIRS.flatMap((d) => repo_files(d)).filter((f) => f.endsWith(".md"));

// a call = an interpreter followed (after options) by a .py file, or `py -3`, or python reading its program from stdin
const PY_CALL = /\b(?:python3?|py)\b(?:\s+-\S+)*\s+\S*\.py\b|\bpy\s+-3\b|\bpython3?\s+-I\s+-(?:\s|$)|\bpython3?\s+-\s*<</;

test("A1: skills/ commands/ agents/ docs/adapters/ — no Python call and no `.py` file name anywhere in the documents", () => {
  const bad: string[] = [];
  for (const rel of doc_files()) {
    const lines = read_text(`${REPO}/${rel}`).split("\n");
    lines.forEach((line, i) => {
      if (PY_CALL.test(line)) bad.push(`${rel}:${i + 1}: call  ${line.trim().slice(0, 100)}`);
      else if (/\b(?:pes|serve|setup|check_ddl)\.py\b/.test(line)) bad.push(`${rel}:${i + 1}: .py ${line.trim().slice(0, 100)}`);
    });
  }
  assert.deepEqual(bad, [], `Python still named in the documents:\n${bad.join("\n")}`);
});

test("A2: README.md · AGENTS.md · CLAUDE.md — no Python call line (a history sentence that names pes.py is fine, a command to run is not)", () => {
  const bad: string[] = [];
  for (const rel of ["README.md", "AGENTS.md", "CLAUDE.md"]) {
    read_text(`${REPO}/${rel}`).split("\n").forEach((line, i) => {
      if (PY_CALL.test(line) || /\bpython3?\s+-m\s+(?:pytest|venv)\b/.test(line) || /\.venv[\\/](?:bin|Scripts)[\\/]/.test(line)) bad.push(`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`);
    });
  }
  assert.deepEqual(bad, [], `Python calls in the top-level documents:\n${bad.join("\n")}`);
});

test("A3: README says what is needed — Node.js 26 is a requirement, Python is not a requirement row any more; bootstrap text does not install Python", () => {
  const readme = repo_doc("README.md");
  assert.match(readme, /\|\s*Node(?:\.js)?\s*\|[^\n]*26[^\n]*\|\s*필수\s*\|/, "a requirement row for Node.js 26");
  assert.doesNotMatch(readme, /\|\s*Python\s*\|[^\n]*\|\s*필수\s*\|/, "no required-Python row");
  assert.doesNotMatch(readme, /Git[^\n]*·\s*Python\s*3\s*·\s*Node/, "the one-line install text no longer installs Python 3");
});

test("A4: skills/core/SKILL.md defines PES as `node ${CLAUDE_PLUGIN_ROOT}/scripts/pes.ts` (with the Skill-directory fallback) and lists setup.ts, not setup.py", () => {
  const core = repo_doc("skills/core/SKILL.md");
  assert.match(core, /PES="node \$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/pes\.ts"/, "the PES variable");
  assert.match(core, /\.\.\/\.\.\/scripts\/pes\.ts/, "the fallback when CLAUDE_PLUGIN_ROOT is empty");
  assert.match(core, /`setup\.ts check/, "the helper table names setup.ts");
  assert.doesNotMatch(core, /python3|py -3|PES_OWNER=<ID> python/, "no Python interpreter in the core skill");
  // the session label example uses the new PES form
  assert.match(core, /PES_OWNER=<ID> node [^\n]*pes\.ts/, "the PES_OWNER example runs node");
});

test("A5: commands/setup.md runs setup.ts (check · install missing · upgrade all · keys · mark) and pes.ts (doctor --net · which); no Python install step", () => {
  const text = repo_doc("commands/setup.md");
  for (const sub of ["check", "install missing", "upgrade all", "keys", "mark"]) {
    assert.match(text, new RegExp(`node\\s+\\S*scripts/setup\\.ts\\s+${sub}\\b`), `setup.ts ${sub}`);
  }
  assert.match(text, /node\s+\S*scripts\/pes\.ts\s+doctor --net/);
  assert.match(text, /node\s+\S*scripts\/pes\.ts\s+which ego-browser/);
  const front = text.split("\n---")[0] as string;
  assert.doesNotMatch(front, /Python/, "the description no longer promises Python");
  assert.doesNotMatch(text, /PYTHON <명령>|→ 이후 `PY`/, "bootstrap's last line is no longer a Python command");
  assert.match(text, /Node(?:\.js)?\s*26/, "Node 26 is what bootstrap checks");
});

test("A6: commands/run.md and commands/start.md check `node …/scripts/setup.ts needed`", () => {
  for (const rel of ["commands/run.md", "commands/start.md"]) {
    assert.match(repo_doc(rel), /node\s+\S*scripts\/setup\.ts\s+needed\b/, rel);
  }
});

test("A7: agents call `node …/scripts/pes.ts which <도구>` (researcher · verifier · reviewer) and reviewer reads items with `pes.ts show`", () => {
  for (const rel of ["agents/researcher.md", "agents/verifier.md", "agents/reviewer.md"]) {
    assert.match(repo_doc(rel), /node\s+\S*pes\.ts\s+which\b/, `${rel}: which`);
  }
  assert.match(repo_doc("agents/reviewer.md"), /node\s+\S*pes\.ts\s+show\b/);
});

test("A8: commands/doctor.md no longer lists Python among what doctor checks (D08: doctor has a Node row, not a Python row)", () => {
  const front = (repo_doc("commands/doctor.md").split("\n---")[0] as string);
  assert.doesNotMatch(front, /Python/);
});

test("A9: every `$PES <명령>` / `node …pes.ts <명령>` the documents call exists in the TypeScript command table", () => {
  const known = pes_cmds();
  for (const rel of target_docs()) {
    assert.deepEqual(unknown_invocations(repo_doc(rel), known), [], `${rel}: unknown pes command`);
  }
  for (const name of ["context", "claim", "submit", "wait", "complete", "migrate"]) assert.ok(known.includes(name), `${name} is in the table`);
});

test("A10: the documents that show a pes call use the node form in their code blocks (at least one such call in core · run · setup)", () => {
  let found = 0;
  for (const rel of ["skills/core/SKILL.md", "commands/run.md", "commands/setup.md"]) {
    for (const seg of code_segments(repo_doc(rel))) if (/\bnode\s+\S*scripts\/(?:pes|setup)\.ts\b/.test(seg.text)) found += 1;
  }
  assert.ok(found >= 3, `node-form calls found: ${found}`);
});

// ---------------------------------------------------------------------------
// lint_skills.ts: the rule "Python 호출"

const OLD_FORMS: Array<[string, string]> = [
  ["python3 pes.py", fence("bash", 'python3 -I ${CLAUDE_PLUGIN_ROOT}/scripts/pes.py status "$DIR"')],
  ["py -3 setup.py", fence("bash", "py -3 -I ${CLAUDE_PLUGIN_ROOT}/scripts/setup.py needed")],
  ["python3 -I - heredoc", fence("bash", "python3 -I - <<'EOF'", "print(1)", "EOF")],
  ["inline code", "먼저 `python3 -I ${CLAUDE_PLUGIN_ROOT}/scripts/setup.py needed` 를 실행한다."],
  ["python -X utf8", fence("sh", "python -X utf8 -I scripts/serve.py ~/pes-projects 8760")],
];

test("A11: lint_skills flags the old Python forms — exit 1, `경로:줄: [Python 호출]`, in skills · commands · agents · adapters alike", () => {
  for (const [name, body] of OLD_FORMS) {
    for (const rel of ["skills/core/SKILL.md", "commands/run.md", "agents/researcher.md", "docs/adapters/claude-code.md"]) {
      const tree = make_tree({ [rel]: doc(body) });
      try {
        const res = run_lint(tree.root);
        assert.equal(res.status, 1, `${name} in ${rel}: ${res.out}`);
        assert.match(res.out, new RegExp(`${rel.replace(/[./]/g, "\\$&")}:\\d+: \\[Python 호출\\]`), `${name} in ${rel}: ${res.out}`);
      } finally {
        tree.cleanup();
      }
    }
  }
});

test("A12: lint_skills accepts the node forms and prose that talks about Python (prose is not looked at)", () => {
  const tree = make_tree({
    "skills/core/SKILL.md": doc(
      "예전에는 Python 이 필요했지만 지금은 필요 없다. `python3` 라는 단어는 산문이다.",
      fence("bash", 'PES="node ${CLAUDE_PLUGIN_ROOT}/scripts/pes.ts"', '$PES status "$DIR"', "node ${CLAUDE_PLUGIN_ROOT}/scripts/setup.ts needed"),
      "명령은 `node ${CLAUDE_PLUGIN_ROOT}/scripts/pes.ts which kosis` 처럼 부른다.",
    ),
    "commands/run.md": doc("1. `node ${CLAUDE_PLUGIN_ROOT}/scripts/setup.ts needed`"),
  });
  try {
    const res = run_lint(tree.root);
    assert.equal(res.status, 0, res.out);
  } finally {
    tree.cleanup();
  }
});

test("A13: lint_skills still stops the old rules (project.json writes) in the same run — the Python rule adds, it does not replace", () => {
  const tree = make_tree({
    "skills/core/SKILL.md": doc(fence("bash", "echo '{}' > project.json", "python3 -I x/pes.py status d")),
  });
  try {
    const res = run_lint(tree.root);
    assert.equal(res.status, 1);
    assert.match(res.out, /\[Python 호출\]/);
    assert.match(res.out, /\[project\.json 직접 쓰기\]/);
  } finally {
    tree.cleanup();
  }
});

test("A14: the real documents of this repository pass lint_skills (with the new rule)", () => {
  const res = run_lint(REPO);
  assert.equal(res.status, 0, res.out);
});

// ---------------------------------------------------------------------------
// C — the D14 flow in the documents

test("C21: skills/core/SKILL.md tells the flow for a not-migrated folder: the refusal \"먼저 이전하세요\" → ask the user → `migrate` (one folder) / `migrate --all`", () => {
  const core = repo_doc("skills/core/SKILL.md");
  assert.match(core, /먼저 이전하세요/, "names the refusal");
  assert.match(core, /\$PES migrate\s/, "runs migrate through $PES");
  assert.match(core, /migrate --all/, "mentions --all");
  const around = core.split("\n").filter((l) => /migrate/.test(l)).join("\n");
  assert.match(around, /사용자/, "asks the user before it migrates");
  assert.match(around, /묻|확인|동의/, "the asking is explicit");
});

test("C22: commands/run.md and commands/start.md point to the same flow (migrate after the user agrees)", () => {
  for (const rel of ["commands/run.md", "commands/start.md"]) {
    const text = repo_doc(rel);
    assert.match(text, /migrate/, `${rel}: names migrate`);
    assert.match(text, /이전/, `${rel}: says 이전`);
  }
});

test("C23: the stage skills do not tell the agent to migrate on its own (only core owns the flow); no skill runs `migrate` without the user's yes", () => {
  for (const stage of ["plan", "research", "analyze", "write", "verify", "publish"]) {
    const text = repo_doc(`skills/${stage}/SKILL.md`);
    for (const seg of code_segments(text)) assert.doesNotMatch(seg.text, /\bmigrate\b/, `skills/${stage}: no migrate command of its own`);
  }
});
