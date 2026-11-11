// tests/test_questions.py → TS (SEL-70, PR26a; table 8: test_questions_html + test_question_bank).
// Question screens: the data JSON of ask-*.html, escaping, the shared question module, file-name sanitising.
// The HTML is inspected as text and JSON only (no browser). Same synthetic specs as the pytest file.
import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";

import { REPO, make_ctx, pes, synthetic_project, write_json } from "./helpers/compat_env.ts";
import { use_home_guard } from "./helpers/home_guard.ts";
import { html_unescape } from "./helpers/compat_normalize.ts";

use_home_guard();

const ctx = make_ctx("pes-questions-");
after(() => ctx.cleanup());

/** Windows writes text files with CRLF (and a checkout may too): N7 compares LF. */
const read_lf = (path: string): string => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

const DATA_OPEN = '<script id="data" type="application/json">';

/** The rule of cmd_ask's strip_private: keys that start with an underscore are not rendered. */
function public_view(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(public_view);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as object).filter(([key]) => !key.startsWith("_")).map(([key, item]) => [key, public_view(item)]));
  }
  return value;
}

function data_of(html: string): { blob: string; data: any } {
  const start = html.indexOf(DATA_OPEN) + DATA_OPEN.length;
  assert.ok(start >= DATA_OPEN.length, "data script present");
  const end = html.indexOf("</script>", start);
  const blob = html.slice(start, end);
  return { blob, data: JSON.parse(blob) };
}

function ask(project: string, spec: unknown, name = "spec.json"): string {
  const spec_path = write_json(join(ctx.tmp, name), spec, undefined);
  const run = pes(ctx, "ask", project, spec_path);
  assert.equal(run.code, 0, run.out + run.err);
  return run.out.trim();
}

/** The hand-written old project.json of tests/fixtures/generate.py ("legacy": no stage status yet) — the input the pytest file used. */
function legacy_project(): string {
  return synthetic_project(ctx, "legacy");
}

test("ask embeds the question data, escapes HTML in the title, and keeps </script> inside the data harmless", () => {
  const title = "합성 <질문> & \"제목\" '따옴표'";
  const spec = {
    id: "sel-13-ask",
    stage: "plan",
    kind: "stage_start",
    stage_label: "기획",
    round: 2,
    title,
    intro: "합성 소개",
    inherited: [{ label: "발주처", value: "합성 기관" }],
    questions: [
      { id: "q1", label: "필수 <b>질문</b>", type: "single", required: true, other: true, options: [{ value: "a", label: "A </script><script>alert(1)</script>", recommended: true }, { value: "b", label: "B" }] },
      { id: "q2", label: "조건부", type: "text", show_if: { id: "q1", in: ["a"] }, other: "직접 적기" },
      { id: "q3", label: "글쓰기", type: "textarea" },
      { id: "q4", label: "여러 개", type: "multi", required: true, options: [{ value: "x", label: "X" }, { value: "y", label: "Y" }] },
      { id: "q5", label: "비공개 조건", type: "text", _when: { id: "q1", in: ["b"] } },
    ],
    _note: "렌더하지 않는 내부 메모",
  };
  const project = legacy_project();
  const rendered = ask(project, spec);
  assert.equal(rendered, join(realpathSync.native(project), "ask-sel-13-ask.html"));
  const html = read_lf(rendered);

  const { blob, data } = data_of(html);
  assert.deepEqual(data.spec, public_view(spec));
  assert.equal(data.spec._note, undefined);
  assert.equal(data.spec.questions[4]._when, undefined);
  assert.equal(data.topic, "합성 주제");
  assert.deepEqual(data.stages.map((s: any) => s.key), ["plan", "research", "analyze", "write", "verify", "publish"]);
  assert.equal(data.stages[0].status, "asking"); // the legacy input has no status: `ask` is what moves it to asking

  // A </script> inside the data is escaped, so the data script cannot be ended early.
  assert.ok(!blob.includes("</script>"));
  assert.ok(blob.includes("<\\/"));
  assert.equal(data.spec.questions[0].options[0].label, "A </script><script>alert(1)</script>");

  // The title is HTML-escaped and never appears raw.
  assert.ok(html.includes(`<title>${html_escape(title)}</title>`));
  assert.ok(!html.includes(`<title>${title}</title>`));
  assert.ok(!html.includes("/*__DATA__*/null"));
  assert.ok(!html.includes("<!--__QUESTIONS__-->"));
});

/** Python html.escape(quote=True) */
function html_escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
}

test("html_escape port agrees with the unescape helper", () => {
  assert.equal(html_unescape(html_escape("a<b>&\"c'")), "a<b>&\"c'");
});

test("ask keeps the definitions of the real plan question bank (questions/plan.json) intact", () => {
  const project = legacy_project();
  const bank = join(REPO, "questions", "plan.json");
  const source = JSON.parse(read_lf(bank));
  const run = pes(ctx, "ask", project, bank);
  assert.equal(run.code, 0, run.out + run.err);
  const rendered = run.out.trim();
  assert.ok(rendered.endsWith("ask-plan-start.html"), rendered);
  const { data } = data_of(read_lf(rendered));
  assert.deepEqual(data.spec, public_view(source));
  const questions = Object.fromEntries(data.spec.questions.map((q: any) => [q.id, q]));
  assert.equal(questions.topic.required, true);
  assert.equal(questions.purpose.other, true);
  assert.deepEqual(questions.research_type.show_if, { id: "format", in: ["hwpx"] });
  assert.deepEqual(questions.policy.show_if, { id: "purpose", in: ["report", "decision"] });
  assert.equal(questions.stage_reports.type, "multi");
});

test("the shared question module is inserted once and keeps the other / required / conditional UI", () => {
  const project = legacy_project();
  const run = pes(ctx, "ask", project, join(REPO, "questions", "plan.json"));
  assert.equal(run.code, 0, run.out + run.err);
  const html = read_lf(run.out.trim());
  const module = read_lf(join(REPO, "templates", "_questions.html"));

  assert.equal(html.split(module).length - 1, 1, "the module is embedded exactly once");
  assert.ok(module.includes("data-qo="));
  assert.ok(module.includes("q.id + '__other'"));
  assert.ok(module.includes("typeof q.other === 'string'"));
  assert.ok(module.includes('class="req">*'));
  assert.ok(module.includes("q.show_if"));
  assert.ok(module.includes("classList.toggle('hidden'"));

  const { data } = data_of(html);
  const by_id = Object.fromEntries(data.spec.questions.map((q: any) => [q.id, q]));
  assert.equal(by_id.topic.required, true);
  assert.equal(by_id.purpose.other, true);
  assert.equal(by_id.research_type.show_if.id, "format");
  assert.deepEqual(by_id.policy.show_if.in, ["report", "decision"]);
});

test("the ask id is sanitised into the output file name (test_question_bank: file-name cleaning)", () => {
  const project = legacy_project();
  const rendered = ask(project, { id: "My Ask / 1", stage: "plan", kind: "stage_start", title: "합성", questions: [] });
  const normalized = rendered.split("\\").join("/");
  assert.equal(normalized.slice(normalized.lastIndexOf("/") + 1), "ask-my-ask---1.html");
  assert.equal(normalized.slice(0, normalized.lastIndexOf("/")), realpathSync.native(project).split("\\").join("/"), "written next to project.json");
});

test("every question bank file renders (questions/*.json) and survives the data round trip", () => {
  const project = legacy_project();
  for (const stage of ["plan", "research", "analyze", "write", "verify", "publish", "resume"]) {
    const prep = pes(ctx, "ask-prep", project, stage);
    assert.equal(prep.code, 0, `${stage}: ${prep.out}${prep.err}`);
    const prepared = prep.out.trim();
    const source = JSON.parse(read_lf(prepared));
    const run = pes(ctx, "ask", project, prepared);
    assert.equal(run.code, 0, `${stage}: ${run.out}${run.err}`);
    const { data } = data_of(read_lf(run.out.trim()));
    assert.deepEqual(data.spec, public_view(source), stage);
  }
});
