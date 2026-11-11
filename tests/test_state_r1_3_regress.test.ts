/**
 * SEL-50 PR17 r1-3 회귀 (tester, 작성 모드). 구현 전이면 실패하는 것이 정상이다. 전부 합성 자료, HOME·USERPROFILE·PES_HOME 은 임시 폴더.
 *
 * 해석 R4
 *   (1) 필수 1 — v0.15 project.json 을 import→validate→activate 한 DB 모드에서, 이전된 research 항목(번호는 legacy_extra.legacy_id)을
 *       merge 가 찾는다.
 *       (가) 이전된 번호로 status·request 만 담은 merge 는 거부되지 않고 그 항목의 status/request 를 바꾼다(depth 불변).
 *       (나) 같은 번호로 내용(summary 등)이 있는 merge 는 새 항목을 만들지 않고 그 항목을 갱신한다(항목 수 불변, 번호 중복 없음, depth +1).
 *       (다) show 가 보여 준 번호와 merge 가 가리키는 항목이 같다: 번호는 하나씩만 나오고, 합성 번호 그대로(2, 7) 남는다.
 *   (2) 권장 1 — 이전된 research 항목이 이미 있는 프로젝트에서 approve plan 이 번호 충돌·중복 없이 새 조사 항목을 만든다:
 *       기획 topic 중 이미 연결(links.plan)된 것은 건너뛰고, 새 번호는 이전된 최대 번호 + 1 이다.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { make_cli_env, type CliEnv, type CliResult } from "./helpers/cli_write_env.ts";
import { expect_staging, ok as ok_read, run_cli, write_json, write_legacy } from "./helpers/cli_read_env.ts";
import { backup_dir_of, migration, owner_of, pes_home_of } from "./helpers/migration_env.ts";
import { legacy } from "./helpers/legacy_env.ts";

const lf = (s: string) => s.replace(/\r\n/g, "\n");

function research_item(id: number, title: string, plan_link: number): Record<string, unknown> {
  return {
    id,
    title,
    kind: "topic",
    status: "done",
    question: `${title} 질문`,
    summary: `${title} 요약`,
    details: `${title} 본문`,
    confidence: "중간",
    depth: 1,
    links: { plan: [plan_link] },
    sources: [{ title: "합성 출처", url: `https://r13.example.test/${id}`, method: "search" }],
    updated_round: 1,
  };
}

/** 기획은 승인됐고 조사 단계에 이전된 항목 #2·#7 이 있는 v0.15 프로젝트. */
function legacy_research(slug: string): Record<string, unknown> {
  return {
    pes: 1,
    topic: "합성 조사 이전 주제",
    slug,
    created: "2026-02-01",
    current: "research",
    processed: [],
    notes: [],
    stages: {
      plan: {
        status: "approved",
        round: 1,
        approved_at: "2026-02-02 10:00",
        summary: "합성 기획 요약",
        items: [
          { id: 1, title: "연구 질문", kind: "rq", status: "done", summary: "왜", updated_round: 1 },
          { id: 2, title: "주제 둘", kind: "topic", status: "done", question: "둘", links: { plan: [1] }, updated_round: 1 },
          { id: 3, title: "주제 셋", kind: "topic", status: "done", question: "셋", links: { plan: [1] }, updated_round: 1 },
        ],
      },
      research: {
        status: "active",
        round: 1,
        approved_at: null,
        summary: "",
        items: [research_item(2, "이전된 조사 둘", 2), research_item(7, "이전된 조사 일곱", 1)],
      },
    },
  };
}

/** 가져오기→검증→활성화까지 한 뒤 DB 모드(PES_DB_CORE=1) 실행기를 돌려준다. */
async function activated(c: CliEnv, slug: string, value: Record<string, unknown>, tag: string): Promise<(args: string[]) => CliResult> {
  const dir = join(c.env.home.env.PES_HOME as string, slug);
  write_legacy(dir, value);
  const api = await legacy();
  const mig = await migration();
  const imp = await api.import_project(c.env.service, dir, { owner_actor_id: owner_of(c.env) });
  expect_staging(imp, dir, `test_state_r1_3_regress.test.ts#${tag}`);
  const val = await mig.validate_import(c.env.service, imp.batch_id, { owner_actor_id: owner_of(c.env), source_dir: dir });
  assert.equal(val.ok, true, JSON.stringify(val.report.problems));
  await mig.activate_import(c.env.service, imp.batch_id, { owner_actor_id: owner_of(c.env), backup_dir: backup_dir_of(c.env, `r1-3-${tag}`), pes_home: pes_home_of(c.env) });
  return (args) => {
    const r = run_cli(c, args, { extra: { PES_OWNER: `sess-r13-${tag}` } });
    return { status: r.status, stdout: lf(r.stdout), stderr: lf(r.stderr) };
  };
}

function rows(py: (a: string[]) => CliResult, slug: string, stage: string, fields: string): any[] {
  const r = ok_read(py(["show", slug, stage, "--fields", fields]), `show ${stage}`);
  const v = JSON.parse(r.stdout);
  return Array.isArray(v) ? v : v.items;
}

const FIELDS = "id,title,status,request,depth,summary";

test("이전된 research 항목에 status·request 만 담은 merge 는 거부되지 않고 그 항목을 고친다 (depth 불변)", async () => {
  const c = await make_cli_env();
  try {
    const slug = "r13-control";
    const py = await activated(c, slug, legacy_research(slug), "ctl");
    const before = rows(py, slug, "research", FIELDS);
    assert.deepEqual(before.map((x) => x.id).sort(), [2, 7], `show 가 이전된 번호를 보여 준다 (${before.map((x) => x.id)})`);
    const b7 = before.find((x) => x.id === 7);

    const res = py(["merge", slug, "research", write_json(c, "ctl.json", { id: 7, status: "deepen", request: "더 깊게" })]);
    assert.equal(res.status, 0, `이전된 #7 은 show 가 보여 준 번호라 거부되면 안 된다\n${res.stderr}${res.stdout}`);
    assert.doesNotMatch(res.stderr, /Traceback/);

    const after = rows(py, slug, "research", FIELDS);
    assert.equal(after.length, 2, "항목 수 불변");
    assert.deepEqual(after.map((x) => x.id).sort(), [2, 7], "번호 중복·유령 항목 없음");
    const a7 = after.find((x) => x.id === 7);
    assert.equal(a7.status, "deepen", "status 가 바뀐다");
    assert.equal(a7.request, "더 깊게", "request 가 바뀐다");
    assert.equal(a7.depth, b7.depth, "제어 전용이라 depth 불변");
    assert.equal(a7.title, b7.title, "제목 그대로");
    assert.equal(a7.summary, b7.summary, "요약 그대로");
    const a2 = after.find((x) => x.id === 2);
    assert.equal(a2.status, before.find((x) => x.id === 2).status, "다른 항목은 그대로");
  } finally {
    c.close();
  }
});

test("이전된 research 항목에 내용 merge 는 새 항목을 만들지 않고 그 항목에 새 판을 쌓는다 (항목 수 불변)", async () => {
  const c = await make_cli_env();
  try {
    const slug = "r13-content";
    const py = await activated(c, slug, legacy_research(slug), "cnt");
    const before = rows(py, slug, "research", FIELDS);
    const b7 = before.find((x) => x.id === 7);
    const b2 = before.find((x) => x.id === 2);

    const res = py(["merge", slug, "research", write_json(c, "cnt.json", { id: 7, summary: "보완된 요약", details: "보완된 본문" })]);
    assert.equal(res.status, 0, `${res.stderr}${res.stdout}`);
    assert.doesNotMatch(res.stderr, /Traceback/);

    const after = rows(py, slug, "research", FIELDS);
    assert.equal(after.length, before.length, `항목 수 불변 (실제 번호: ${after.map((x) => x.id)}, 제목: ${after.map((x) => x.title)})`);
    assert.equal(after.filter((x) => x.id === 7).length, 1, "번호 7 은 하나뿐");
    assert.ok(!after.some((x) => x.title === "항목 7"), "제목이 '항목 7' 인 유령 항목이 없다");
    const a7 = after.find((x) => x.id === 7);
    assert.equal(a7.summary, "보완된 요약", "요약이 새 판으로 바뀐다");
    assert.equal(a7.title, b7.title, "제목은 이어받는다");
    assert.equal(a7.depth, b7.depth + 1, "내용 merge 는 depth +1 (새 판)");
    assert.deepEqual(after.find((x) => x.id === 2), b2, "다른 항목은 그대로");

    // 한 번 더: 같은 번호에 다시 쌓아도 항목은 늘지 않는다
    ok_read(py(["merge", slug, "research", write_json(c, "cnt2.json", { id: 7, summary: "다시 보완" })]), "두 번째 merge");
    const again = rows(py, slug, "research", FIELDS);
    assert.equal(again.length, before.length, "두 번째에도 항목 수 불변");
    assert.equal(again.find((x) => x.id === 7).depth, b7.depth + 2, "판이 하나 더 쌓인다");
  } finally {
    c.close();
  }
});

test("show 와 merge 가 같은 항목을 가리킨다: 이전된 번호 목록의 모든 번호가 merge 로 닿고, 목록 안 제어·내용 제안이 섞여도 된다", async () => {
  const c = await make_cli_env();
  try {
    const slug = "r13-same";
    const py = await activated(c, slug, legacy_research(slug), "same");
    const shown = rows(py, slug, "research", "id,title").map((x) => x.id as number);
    assert.deepEqual([...shown].sort(), [2, 7]);

    // show 가 보여 준 모든 번호에 제어 전용 제안이 닿는다 (한 번에 목록으로)
    const res = py(["merge", slug, "research", write_json(c, "both.json", shown.map((id) => ({ id, request: `요청 ${id}` })))]);
    assert.equal(res.status, 0, `${res.stderr}${res.stdout}`);
    const after = rows(py, slug, "research", "id,title,request");
    assert.equal(after.length, 2);
    for (const id of shown) assert.equal(after.find((x) => x.id === id)?.request, `요청 ${id}`, `#${id} 요청이 그 항목에 들어갔다`);

    // 제어 전용 + 내용 제안이 한 목록에 섞여도 항목은 늘지 않는다
    const mixed = py(["merge", slug, "research", write_json(c, "mix.json", [{ id: 2, status: "deepen" }, { id: 7, summary: "섞인 보완" }])]);
    assert.equal(mixed.status, 0, `${mixed.stderr}${mixed.stdout}`);
    const fin = rows(py, slug, "research", "id,title,status,summary");
    assert.equal(fin.length, 2, "섞어도 항목 수 불변");
    assert.deepEqual(fin.map((x) => x.id).sort(), [2, 7]);
    assert.equal(fin.find((x) => x.id === 2).status, "deepen");
    assert.equal(fin.find((x) => x.id === 7).summary, "섞인 보완");

    // 진짜 없는 번호는 여전히 제어 전용을 거부한다 (r1-2 규칙 유지)
    const ghost = py(["merge", slug, "research", write_json(c, "ghost.json", { id: 9, status: "deepen", request: "r" })]);
    assert.notEqual(ghost.status, 0, "없는 #9 의 제어 전용 제안은 거부");
    assert.equal(rows(py, slug, "research", "id").length, 2, "유령 항목 없음");
  } finally {
    c.close();
  }
});

test("이전된 research 항목이 이미 있어도 approve plan 은 번호 충돌·중복 없이 새 조사 항목만 만든다", async () => {
  const c = await make_cli_env();
  try {
    const slug = "r13-approve";
    const value = legacy_research(slug);
    // 기획은 아직 진행 중(승인 전): topic 2 는 research #2 와 이미 연결, topic 3 은 새 것
    const stages = value.stages as any;
    stages.plan.status = "active";
    stages.plan.approved_at = null;
    value.current = "plan";
    const py = await activated(c, slug, value, "apv");
    const before = rows(py, slug, "research", "id,title");
    assert.deepEqual(before.map((x) => x.id).sort(), [2, 7]);

    ok_read(py(["render", slug, "plan"]), "render plan");
    const approved = ok_read(py(["approve", slug, "plan"]), "approve plan");
    assert.doesNotMatch(approved.stderr, /Traceback/);

    const after = rows(py, slug, "research", "id,title,links,status");
    const ids = after.map((x) => x.id as number);
    assert.equal(new Set(ids).size, ids.length, `번호 중복 없음 (${ids})`);
    assert.equal(after.length, 3, `새 조사 항목은 연결 안 된 topic 3 하나뿐 (실제: ${after.map((x) => x.title)})`);
    for (const old of before) assert.ok(ids.includes(old.id), `이전된 #${old.id} 가 그대로 있다`);
    const created = after.find((x) => !before.some((b) => b.id === x.id));
    assert.ok(created, "새 항목이 하나 있다");
    assert.equal(created.id, 8, "새 번호는 이전된 최대 번호(7) + 1");
    assert.equal(created.title, "주제 셋");
    assert.ok((created.links?.plan ?? []).includes(3), "links.plan 에 기획 항목 3");
    assert.equal(after.filter((x) => x.title === "주제 둘").length, 0, "이미 연결된 topic 2 는 다시 만들지 않는다");
  } finally {
    c.close();
  }
});
