// tests/test_state.py (rounds, merge, approve, reopen, defects, snapshots) → TS (SEL-70, PR26a; table 8: test_state_transitions).
// The real 0.15 CLI, synthetic projects in an isolated home. Same inputs and assertions as the pytest file.
//
// The pytest xfail (strict) for the depth defect (SEL-12, "결함 후보 ②") is NOT a todo here: it is an explicit assertion of
// what 0.15 does today (D06 in the intended-difference table), so the day the new core fixes it, the table and this test change together.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";

import { KNOWN_DIFFS, STAGES, approve, edit_project, init_project, make_ctx, merge, pes, project_json, read_json } from "./helpers/compat_env.ts";
import { make_library, unique_name } from "./helpers/compat_state.ts";
import { use_home_guard } from "./helpers/home_guard.ts";

use_home_guard();

const ctx = make_ctx("pes-state-tr-");
after(() => ctx.cleanup());

const fresh = (source?: string): string => init_project(ctx, unique_name(), "합성 주제", source);

// ---------------------------------------------------------------- rounds
test("round-start increments the round, clears changes and keeps the history line of the previous round", () => {
  const project = fresh();
  const first = pes(ctx, "round-start", project, "plan");
  assert.equal(first.code, 0, first.out + first.err);
  assert.ok(first.out.includes("R1 시작"));
  const data = project_json(project);
  assert.equal(data.stages.plan.round, 1);
  assert.equal(data.stages.plan.status, "active");
  assert.deepEqual(data.stages.plan.changes, []);
  assert.equal(data.current, "plan");

  edit_project(project, (p) => {
    p.stages.plan.changes = ["조사: 합성 변경"];
  });
  const second = pes(ctx, "round-start", project, "plan");
  assert.equal(second.code, 0, second.out + second.err);
  const plan = project_json(project).stages.plan;
  assert.equal(plan.round, 2);
  assert.deepEqual(plan.changes, []);
  assert.equal(plan.history.length, 1);
  assert.ok(plan.history[0].includes("R1"));
  assert.ok(plan.history[0].includes("조사")); // only the part of `changes` before ':' is kept
  assert.ok(plan.history[0].includes("snapshots/plan-R1.json"));
});

// ---------------------------------------------------------------- merge
test("merge creates the item, dedupes sources, collects links; a second merge accumulates", () => {
  const project = fresh();
  pes(ctx, "round-start", project, "research");
  merge(ctx, project, "research", [
    {
      id: 1,
      title: "조사 항목",
      summary: "첫 요약",
      details: "첫 상세",
      sources: [
        { url: "https://example.test/a", title: "출처 A", method: "browser" },
        { url: "https://example.test/a", title: "중복 A", method: "browser" },
        { url: "https://example.test/b", title: "출처 B" },
      ],
      stats: [{ label: "합성 지표", value: 7, unit: "건" }],
      links: { plan: [1, 2] },
      open_questions: ["추가 확인 필요"],
    },
  ]);

  let item = project_json(project).stages.research.items[0];
  assert.deepEqual(item.sources.map((s: any) => s.url), ["https://example.test/a", "https://example.test/b"]);
  assert.equal(item.sources[0].title, "출처 A");
  assert.deepEqual(item.stats, [{ label: "합성 지표", value: 7, unit: "건", name: "합성 지표" }]);
  assert.deepEqual(item.links.plan, [1, 2]);
  assert.equal(item.status, "done");
  assert.equal(item.depth, 1);
  assert.equal(item.updated_round, 1);
  assert.ok(project_json(project).stages.research.suggestions.includes("[#1] 추가 확인 필요"));

  merge(ctx, project, "research", [
    {
      id: 1,
      title: "조사 항목",
      summary: "둘째 요약",
      sources: [
        { url: "https://example.test/a", title: "다시 A" },
        { url: "https://example.test/c", title: "출처 C" },
      ],
      links: { plan: [2, 3], research: [9] },
    },
  ]);
  const research = project_json(project).stages.research;
  item = research.items[0];
  assert.equal(research.items.length, 1);
  assert.equal(item.summary, "둘째 요약");
  assert.deepEqual(item.sources.map((s: any) => s.url), ["https://example.test/a", "https://example.test/b", "https://example.test/c"]);
  assert.equal(item.sources[0].title, "출처 A");
  assert.deepEqual(item.links.plan, [1, 2, 3]);
  assert.deepEqual(item.links.research, [9]);
});

test("merge assigns the next item id when the result has none", () => {
  const project = fresh();
  pes(ctx, "round-start", project, "research");
  merge(ctx, project, "research", [{ id: 4, title: "먼저 온 항목" }]);
  merge(ctx, project, "research", [{ title: "번호 없는 항목" }]);
  const items = project_json(project).stages.research.items;
  assert.deepEqual(items.map((i: any) => i.id), [4, 5]);
  assert.equal(items[1].title, "번호 없는 항목");
});

test("merge keeps the plan `reuse` field (PR17: skills hand merge the field, approve plan reuses the library with it)", () => {
  const project = fresh();
  merge(ctx, project, "plan", [{ id: 1, title: "주제", kind: "topic", reuse: 5 }]);
  assert.equal(project_json(project).stages.plan.items[0].reuse, 5);
});

test("merge of a write section replaces its sources and keeps their order (duplicates allowed in the first merge)", () => {
  const project = fresh();
  pes(ctx, "round-start", project, "write");
  merge(ctx, project, "write", [
    {
      id: 3,
      kind: "section",
      title: "첫 절",
      details: "본문.[^1] 둘째.[^2]",
      sources: [
        { url: "https://example.test/b", title: "B" },
        { url: "https://example.test/a", title: "A" },
        { url: "https://example.test/b", title: "B again" },
      ],
    },
  ]);
  let item = project_json(project).stages.write.items[0];
  assert.deepEqual(item.sources.map((s: any) => s.url), ["https://example.test/b", "https://example.test/a", "https://example.test/b"]);

  merge(ctx, project, "write", [
    {
      id: 3,
      kind: "section",
      title: "첫 절",
      sources: [
        { url: "https://example.test/c", title: "C" },
        { url: "https://example.test/a", title: "A" },
      ],
    },
  ]);
  item = project_json(project).stages.write.items[0];
  assert.deepEqual(item.sources.map((s: any) => s.url), ["https://example.test/c", "https://example.test/a"]);
});

// ---------------------------------------------------------------- approve
test("approve plan creates and reuses research items; approving again does not duplicate them", () => {
  const project = fresh(make_library(ctx));
  merge(ctx, project, "plan", [
    { id: 1, title: "재사용 주제", kind: "topic", question: "재사용 질문", reuse: 5 },
    { id: 2, title: "새 주제", kind: "topic", question: "새 질문" },
    { id: 3, title: "제외 주제", kind: "topic", status: "removed" },
    { id: 4, title: "쟁점", kind: "issue" },
  ]);
  // The skill writes the library id into topic.reuse; merge carries it (see the reuse test), and an explicit edit changes nothing.
  edit_project(project, (p) => {
    p.stages.plan.items[0].reuse = 5;
  });

  const out = approve(ctx, project, "plan");
  assert.ok(out.includes("조사 항목 2개 생성 (기존 조사 재사용 1개)"), out);
  const data = project_json(project);
  assert.equal(data.stages.plan.status, "approved");
  assert.ok(data.stages.plan.approved_at);
  assert.equal(data.stages.plan.stale, false);
  assert.equal(data.stages.research.status, "asking");
  assert.equal(data.current, "research");
  const research = data.stages.research.items;
  assert.deepEqual(research.map((i: any) => i.title), ["재사용 주제", "새 주제"]);
  const by_title = Object.fromEntries(research.map((i: any) => [i.title, i]));
  assert.deepEqual(by_title["재사용 주제"].links.plan, [1]);
  assert.deepEqual(by_title["새 주제"].links.plan, [2]);
  const reused = by_title["재사용 주제"];
  assert.equal(reused.status, "deepen");
  assert.deepEqual(reused.links.library, [5]);
  assert.equal(reused.summary, "기존 요약");
  assert.equal(reused.sources[0].url, "https://library.test/5");
  assert.ok(reused.request.includes("기존 조사(라이브러리 #5) 재사용"));

  approve(ctx, project, "plan");
  assert.deepEqual(project_json(project).stages.research.items.map((i: any) => i.title), ["재사용 주제", "새 주제"]);
});

test("approve moves to the next stage in `asking` state", () => {
  const project = fresh();
  approve(ctx, project, "plan");
  approve(ctx, project, "research");
  const data = project_json(project);
  assert.equal(data.current, "analyze");
  assert.equal(data.stages.research.status, "approved");
  assert.equal(data.stages.analyze.status, "asking");
  assert.equal(data.stages.write.status, "pending");
});

test("approving the last stage marks the project complete", () => {
  const project = fresh();
  for (const stage of STAGES) approve(ctx, project, stage);
  const data = project_json(project);
  assert.equal(data.complete, true);
  assert.equal(data.current, "publish");
  for (const stage of STAGES) assert.equal(data.stages[stage].status, "approved", stage);
  const status = pes(ctx, "status", project);
  assert.equal(status.code, 0, status.out + status.err);
  assert.ok(status.out.includes("전체 완료"));
});

// ---------------------------------------------------------------- reopen
test("reopen marks later stages stale and clears review / approval of the reopened one", () => {
  const project = fresh();
  approve(ctx, project, "plan");
  approve(ctx, project, "research");
  approve(ctx, project, "analyze");
  edit_project(project, (p) => {
    p.stages.research.review = { round: 1, questions: [{ id: "합성-점검" }] };
    p.stages.research.stale = true;
  });
  const before = project_json(project).stages.research;
  assert.notEqual(before.review, null);
  assert.equal(before.stale, true);

  const run = pes(ctx, "reopen", project, "research");
  assert.equal(run.code, 0, run.out + run.err);
  assert.ok(run.out.includes("조사 다시 열림"));
  const data = project_json(project);
  assert.equal(data.current, "research");
  const research = data.stages.research;
  assert.equal(research.status, "active");
  assert.equal(research.stale, false);
  assert.equal(research.approved_at, null);
  assert.equal(research.review, null);
  assert.equal(data.stages.analyze.stale, true);
  assert.equal(data.stages.write.stale, true);
  assert.equal(data.stages.verify.stale, false);
  assert.equal(data.stages.publish.stale, false);
});

test("reopening a completed project clears `complete`", () => {
  const project = fresh();
  for (const stage of STAGES) approve(ctx, project, stage);
  assert.equal(project_json(project).complete, true);
  const run = pes(ctx, "reopen", project, "plan");
  assert.equal(run.code, 0, run.out + run.err);
  const data = project_json(project);
  assert.equal(data.current, "plan");
  assert.equal(data.stages.plan.status, "active");
  assert.equal(data.stages.research.stale, true);
  assert.equal(data.complete, false);
});

// ---------------------------------------------------------------- 0.15 defects, pinned (D06 / D07)
test("0.15 defect ② (D06, SEL-12): sending the same merge twice raises `depth` again — pinned, the new core must not copy it", () => {
  assert.match(KNOWN_DIFFS.D06?.title ?? "", /depth/);
  const project = fresh();
  pes(ctx, "round-start", project, "research");
  const result = { id: 1, title: "같은 결과", summary: "같은 요약", sources: [{ url: "https://example.test/same", title: "같은 출처" }] };
  merge(ctx, project, "research", [result]);
  merge(ctx, project, "research", [result]);
  const item = project_json(project).stages.research.items[0];
  assert.equal(item.depth, 2, "0.15 today: depth 2 (the fixed behaviour would be 1)");
  assert.equal(item.sources.length, 1, "the source itself is not duplicated");
});

test("render in the same round does not overwrite the first snapshot of that round (D07: 0.15 already keeps it)", () => {
  const project = fresh();
  pes(ctx, "round-start", project, "plan");
  merge(ctx, project, "plan", [{ id: 1, title: "항목", summary: "초기 요약" }]);
  const first_render = pes(ctx, "render", project, "plan");
  assert.equal(first_render.code, 0, first_render.out + first_render.err);
  const snapshot = join(project, "snapshots", "plan-R1.json");
  const first = readFileSync(snapshot);
  assert.ok(first.includes(Buffer.from("초기", "utf8")));

  merge(ctx, project, "plan", [{ id: 1, title: "항목", summary: "바뀐 요약" }]);
  const second_render = pes(ctx, "render", project, "plan");
  assert.equal(second_render.code, 0, second_render.out + second_render.err);
  assert.deepEqual(readFileSync(snapshot), first);
});

test("later states of the same round go to snapshots/<stage>-R<n>/ and survive the next round", () => {
  const project = fresh();
  pes(ctx, "round-start", project, "plan");
  merge(ctx, project, "plan", [{ id: 1, title: "항목", summary: "처음 요약" }]);
  assert.equal(pes(ctx, "render", project, "plan").code, 0);

  merge(ctx, project, "plan", [{ id: 1, title: "항목", summary: "중간 요약" }]);
  assert.equal(pes(ctx, "render", project, "plan").code, 0);

  const base = join(project, "snapshots", "plan-R1.json");
  assert.ok(readFileSync(base, "utf8").includes("처음 요약"));
  const folder = join(project, "snapshots", "plan-R1");
  const versions = readdirSync(folder).filter((n) => n.endsWith(".json")).sort();
  assert.ok(versions.length > 0, "the changed state of the same round must be kept in a sub-folder snapshot");
  const states = (): any[] => readdirSync(folder).filter((n) => n.endsWith(".json")).sort().map((n) => read_json(join(folder, n)).state);
  assert.ok(states().some((s) => s.items[0].summary === "중간 요약"));

  pes(ctx, "round-start", project, "plan");
  merge(ctx, project, "plan", [{ id: 1, title: "항목", summary: "마지막 요약" }]);
  assert.equal(pes(ctx, "render", project, "plan").code, 0);
  assert.ok(states().some((s) => s.items[0].summary === "중간 요약"));
});
