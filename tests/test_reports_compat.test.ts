// tests/test_state.py (stage report, assemble, web) → TS (SEL-70, PR26a; table 8: test_reports_compat).
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";

import { edit_project, init_project, make_ctx, merge, pes, project_json, read_json } from "./helpers/compat_env.ts";
import { unique_name } from "./helpers/compat_state.ts";
import { use_home_guard } from "./helpers/home_guard.ts";

use_home_guard();

const ctx = make_ctx("pes-reports-");
after(() => ctx.cleanup());

const fresh = (): string => init_project(ctx, unique_name(), "합성 주제");
const text = (path: string): string => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

test("report writes report.md and report.html, orders sources by first appearance, and registers both files", () => {
  const project = fresh();
  pes(ctx, "round-start", project, "plan");
  merge(ctx, project, "plan", [
    {
      id: 1,
      kind: "rq",
      title: "연구 질문",
      summary: "질문 요약",
      sources: [
        { url: "https://example.test/b", title: "출처 B" },
        { url: "https://example.test/a", title: "출처 A" },
        { url: "https://example.test/b", title: "출처 B 중복" },
      ],
    },
    { id: 2, kind: "topic", title: "조사 범위", summary: "범위 요약", sources: [{ url: "https://example.test/c", title: "출처 C" }] },
  ]);

  const run = pes(ctx, "report", project, "plan");
  assert.equal(run.code, 0, run.out + run.err);
  const dir = join(project, "reports", "plan");
  const md = text(join(dir, "report.md"));
  assert.ok(md.startsWith("# 합성 주제 — 기획보고서\n"));
  assert.ok(md.includes("- 단계: 기획 · 라운드 1회"));
  assert.ok(md.includes("- 항목 2개 · 출처 3개 (원문 확인 0개)"));
  assert.ok(md.indexOf("#### #1 연구 질문") < md.indexOf("#### #2 조사 범위"));
  const at = (needle: string): number => md.indexOf(needle);
  assert.ok(at("1. 출처 B — https://example.test/b") >= 0);
  assert.ok(at("1. 출처 B — https://example.test/b") < at("2. 출처 A — https://example.test/a"));
  assert.ok(at("2. 출처 A — https://example.test/a") < at("3. 출처 C — https://example.test/c"));
  assert.ok(!md.includes("출처 B 중복"));

  const html = text(join(dir, "report.html"));
  assert.ok(html.includes("합성 주제"));
  assert.ok(html.includes("기획보고서"));

  const data = project_json(project).stages.plan;
  assert.ok(data.reports_built);
  const formats = Object.fromEntries(data.reports.map((entry: any) => [entry.format, entry]));
  assert.equal(String(formats.md.path).split("\\").join("/"), "reports/plan/report.md");
  assert.equal(String(formats.html.path).split("\\").join("/"), "reports/plan/report.html");
});

test("assemble orders sections by `order`, renumbers footnotes, and writes sources.json with `verified`", () => {
  const project = fresh();
  pes(ctx, "round-start", project, "write");
  merge(ctx, project, "write", [
    {
      id: 10,
      order: 2,
      kind: "section",
      title: "둘째 장",
      details: "둘째 본문.[^1] 셋째 출처.[^2]",
      sources: [
        { url: "https://example.test/a", title: "출처 A", method: "browser" },
        { url: "https://example.test/c", title: "출처 C" },
      ],
    },
    {
      id: 20,
      order: 1,
      kind: "section",
      title: "첫째 장",
      details: "첫째 본문.[^1] 둘째 출처.[^2]",
      sources: [
        { url: "https://example.test/a", title: "출처 A", method: "browser" },
        { url: "https://example.test/b", title: "출처 B" },
      ],
    },
  ]);
  edit_project(project, (p) => {
    p.executive_summary = "합성 요약";
    p.conclusion = "합성 결론";
  });

  const run = pes(ctx, "assemble", project);
  assert.equal(run.code, 0, run.out + run.err);
  const md = text(join(project, "out", "report.md"));
  const at = (needle: string): number => {
    const index = md.indexOf(needle);
    assert.ok(index >= 0, `missing: ${needle}`);
    return index;
  };
  assert.ok(at("# 합성 주제") < at("## 요약"));
  assert.ok(at("## 요약") < at("첫째 본문."));
  assert.ok(at("첫째 본문.") < at("둘째 본문."));
  assert.ok(at("둘째 본문.") < at("## 결론"));
  assert.ok(at("## 결론") < at("[^1]: 출처 A"));
  assert.ok(md.includes("첫째 본문.[^1] 둘째 출처.[^2]"));
  assert.ok(md.includes("둘째 본문.[^1] 셋째 출처.[^3]"));
  assert.ok(md.includes("[^1]: 출처 A, https://example.test/a"));
  assert.ok(md.includes("[^2]: 출처 B, https://example.test/b"));
  assert.ok(md.includes("[^3]: 출처 C, https://example.test/c"));

  const sources = read_json(join(project, "out", "sources.json"));
  assert.deepEqual(sources.map((s: any) => [s.n, s.title, s.url]), [
    [1, "출처 A", "https://example.test/a"],
    [2, "출처 B", "https://example.test/b"],
    [3, "출처 C", "https://example.test/c"],
  ]);
  assert.deepEqual(sources.map((s: any) => s.verified), [true, false, false]);
});

test("web --assemble builds the web report from the markdown and the sources", () => {
  const project = fresh();
  pes(ctx, "round-start", project, "write");
  merge(ctx, project, "write", [{ id: 1, kind: "section", title: "장", details: "웹 본문.[^1]", sources: [{ url: "https://example.test/web", title: "웹 출처" }] }]);
  const run = pes(ctx, "web", project, "--assemble");
  assert.equal(run.code, 0, run.out + run.err);
  assert.ok(existsSync(join(project, "out", "report.md")));
  assert.ok(existsSync(join(project, "out", "report.html")));
  const html = text(join(project, "out", "report.html"));
  assert.ok(html.includes("합성 주제"));
  assert.ok(html.includes("웹 본문."));
  assert.ok(html.includes("https://example.test/web"));
  assert.ok(run.out.includes("출처 1개"));
});
