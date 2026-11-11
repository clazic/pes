/**
 * SEL-50 PR17 r1-2 권장 3건 회귀 (tester, 작성 모드). 구현 전이면 실패하는 것이 정상이다. 전부 합성 자료, HOME·USERPROFILE·PES_HOME 은 임시 폴더.
 *
 * 해석 R3
 *   (1) v0.15 project.json 의 기획 topic 에 `reuse: <library id>` 가 있고 프로젝트를 DB 로 가져와(import→validate→activate) 활성화한 뒤
 *       DB 모드 `approve plan` 을 하면, 옛 handoff_plan 처럼 library 재사용 항목이 만들어진다: 요약·본문·출처 복사, status=deepen,
 *       request 에 "라이브러리 #<id>", links.library=[id], links.plan 에 기획 항목 id. reuse 없는 topic 은 재사용하지 않는다.
 *   (2) 없는 id 에 status·request·user_links 만 담은 merge 는 새 항목을 만들지 않는다. 구현 선택은 둘 다 받아들인다:
 *       거부(0 아닌 종료 + 한국어 메시지 + 아무것도 안 바뀜) 이거나, 경고를 내고 건너뛰기(항목 수 불변). 어느 쪽이든 항목 수는 그대로다.
 *       플래그 없음(v0.15)과 PES_DB_CORE=1 둘 다.
 *   (3) user_links 가 null·문자열·객체이면 스택 없이 한국어 거부, 상태 불변(플래그 없음·켜짐 둘 다). 항목에 저장된 user_links 가 null 이어도
 *       (손으로 고친 project.json) merge 가 스택으로 죽지 않는다.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { make_cli_env, type CliResult } from "./helpers/cli_write_env.ts";
import { expect_staging, ok as ok_read, run_cli, write_legacy } from "./helpers/cli_read_env.ts";
import { backup_dir_of, migration, owner_of, pes_home_of } from "./helpers/migration_env.ts";
import { legacy } from "./helpers/legacy_env.ts";
import { item_fields, ok, with_mode, type Mode } from "./helpers/state_modes.ts";

const lf = (s: string) => s.replace(/\r\n/g, "\n");
const HANGUL = /[가-힣]/;

// ---------------------------------------------------------------------------
// (1) v0.15 에서 가져온 기획 topic 의 reuse

function legacy_with_reuse(slug: string): Record<string, unknown> {
  return {
    pes: 1,
    topic: "합성 재사용 가져오기 주제",
    slug,
    created: "2026-02-01",
    current: "plan",
    processed: [],
    notes: [],
    library: {
      source: "synthetic-lib",
      imported: "2026-02-01 09:00",
      round: 2,
      topic: "합성 참고 주제",
      settings: {},
      suggestions: [],
      warnings: [],
      items: [
        {
          id: 1,
          title: "합성 기존 조사",
          kind: "topic",
          status: "done",
          summary: "기존 조사 요약",
          details: "기존 조사 본문",
          confidence: "중간",
          sources: [{ title: "기존 출처", url: "https://lib.example.test/a", method: "search" }],
          shots: [],
        },
      ],
    },
    stages: {
      plan: {
        status: "active",
        round: 1,
        approved_at: null,
        summary: "합성 기획 요약",
        items: [
          { id: 1, title: "연구 질문", kind: "rq", status: "done", summary: "왜", updated_round: 1 },
          { id: 2, title: "재사용 주제 T", kind: "topic", status: "done", question: "기존 조사를 보완", reuse: 1, links: { plan: [1] }, updated_round: 1 },
          { id: 3, title: "새 주제 N", kind: "topic", status: "done", question: "새로 조사", links: { plan: [1] }, updated_round: 1 },
        ],
      },
    },
  };
}

test("v0.15 가져온 기획 topic 의 reuse: 활성화 뒤 DB 모드 approve plan 이 library 재사용 항목을 만든다", async () => {
  const c = await make_cli_env();
  try {
    const slug = "legacy-reuse-synth";
    const dir = join(c.env.home.env.PES_HOME as string, slug);
    write_legacy(dir, legacy_with_reuse(slug));
    const api = await legacy();
    const mig = await migration();
    const imp = await api.import_project(c.env.service, dir, { owner_actor_id: owner_of(c.env) });
    expect_staging(imp, dir, "test_state_r1_2_regress.test.ts#1");
    const val = await mig.validate_import(c.env.service, imp.batch_id, { owner_actor_id: owner_of(c.env), source_dir: dir });
    assert.equal(val.ok, true, JSON.stringify(val.report.problems));
    await mig.activate_import(c.env.service, imp.batch_id, { owner_actor_id: owner_of(c.env), backup_dir: backup_dir_of(c.env, "r1-2-reuse"), pes_home: pes_home_of(c.env) });

    const py = (args: string[]): CliResult => {
      const r = run_cli(c, args, { extra: { PES_OWNER: "sess-r12-reuse" } });
      return { status: r.status, stdout: lf(r.stdout), stderr: lf(r.stderr) };
    };
    const shown = ok_read(py(["show", slug, "plan", "--fields", "title,kind,reuse"]), "show plan");
    assert.doesNotMatch(shown.stderr, /Traceback/);
    ok_read(py(["render", slug, "plan"]), "render plan");
    const approved = ok_read(py(["approve", slug, "plan"]), "approve plan");
    assert.doesNotMatch(approved.stderr, /Traceback/);

    const res = ok_read(py(["show", slug, "research", "--fields", "title,kind,status,request,links,summary,details,sources,confidence"]), "show research");
    const items: any[] = JSON.parse(res.stdout);
    assert.equal(items.length, 2, `research 항목 2개 (실제: ${items.map((x) => x.title).join(",")})`);
    const reused = items.find((x) => x.title === "재사용 주제 T");
    const fresh = items.find((x) => x.title === "새 주제 N");
    assert.ok(reused && fresh, "두 topic 이 모두 research 항목이 된다");
    assert.equal(reused.status, "deepen", "재사용 항목은 보완(deepen) 상태");
    assert.match(reused.request, /라이브러리 #1/, "request 에 재사용한 library id");
    assert.deepEqual(reused.links.library, [1], "links.library");
    assert.ok(reused.links.plan.includes(2), "links.plan 에 기획 항목 id");
    assert.equal(reused.summary, "기존 조사 요약", "library 요약 복사");
    assert.equal(reused.details, "기존 조사 본문", "library 본문 복사");
    assert.equal(reused.sources.length, 1, "library 출처 복사");
    assert.equal(reused.sources[0].url, "https://lib.example.test/a");
    assert.notEqual(fresh.status, "deepen", "reuse 없는 topic 은 재사용하지 않는다");
    assert.equal((fresh.links?.library ?? []).length, 0);
    assert.equal(fresh.summary ?? "", "");
  } finally {
    c.close();
  }
});

// ---------------------------------------------------------------------------
// (2) 없는 id + 제어 전용 제안

const CONTROL_ONLY: Array<[string, Record<string, unknown>]> = [
  ["status 만", { id: 9, status: "deepen" }],
  ["status+request", { id: 9, status: "deepen", request: "r" }],
  ["request 만", { id: 9, request: "r" }],
  ["user_links 만", { id: 9, user_links: [{ url: "https://u.example.test/x" }] }],
  ["status+request+user_links", { id: 9, status: "removed", request: "r", user_links: [{ url: "https://u.example.test/y", status: "done" }] }],
];

function ids_and_count(m: Mode, stage: string): { n: number; ids: unknown[] } {
  const arr = JSON.parse(ok(m.py(["show", m.slug, stage, "--fields", "id,title,status"]), `show ${stage}`).stdout);
  const items: any[] = Array.isArray(arr) ? arr : arr.items;
  return { n: items.length, ids: items.map((x) => x.id) };
}

async function ghost_scenario(m: Mode): Promise<void> {
  ok(m.py(["round-start", m.slug, "plan"]), "round-start");
  ok(m.py(["merge", m.slug, "plan", m.json("seed.json", [{ id: 1, kind: "topic", title: "씨앗 항목", question: "q", summary: "s" }])]), "seed merge");
  const before = ids_and_count(m, "plan");
  assert.equal(before.n, 1);
  const state_before = m.name === "off" ? m.state() : undefined;
  let k = 0;
  for (const [label, proposal] of CONTROL_ONLY) {
    k += 1;
    const res = m.py(["merge", m.slug, "plan", m.json(`ghost${k}.json`, proposal)]);
    const text = res.stderr + res.stdout;
    assert.doesNotMatch(res.stderr, /Traceback|TypeError|KeyError/, `${label}: 스택 없이`);
    const after = ids_and_count(m, "plan");
    assert.equal(after.n, 1, `${label}: 없는 id 에 제어 전용 제안을 해도 항목이 생기지 않는다 (실제 id: ${after.ids.join(",")})`);
    assert.ok(!after.ids.includes(9), `${label}: #9 유령 항목 없음`);
    if (res.status !== 0) assert.match(text, HANGUL, `${label}: 거부는 한국어 메시지`);
    else assert.match(text, HANGUL, `${label}: 건너뛰기라면 한국어 경고를 낸다`);
    if (m.name === "off") assert.deepEqual(m.state(), state_before, `${label}: project.json 불변`);
  }
  // 목록 안에 정상 제안과 섞여 있어도 유령 항목은 없다
  const mixed = m.py(["merge", m.slug, "plan", m.json("mixed.json", [{ id: 1, summary: "정상 수정" }, { id: 9, status: "deepen", request: "r" }])]);
  assert.doesNotMatch(mixed.stderr, /Traceback/);
  assert.ok(!ids_and_count(m, "plan").ids.includes(9), "섞여 있어도 #9 유령 항목 없음");
  // 내용이 있는 제안(title 등)은 여전히 새 항목을 만든다 — 제어 전용만 막는다
  ok(m.py(["merge", m.slug, "plan", m.json("real.json", { id: 5, kind: "topic", title: "진짜 새 항목", question: "q" })]), "새 항목은 만들어진다");
  assert.ok(ids_and_count(m, "plan").ids.includes(5), "title 이 있는 제안은 새 항목을 만든다");
}

test("없는 id 에 상태·요청·user_links 만 담은 merge 는 새 항목을 만들지 않는다 [플래그 없음]", async () => {
  await with_mode("off", ghost_scenario);
});

test("없는 id 에 상태·요청·user_links 만 담은 merge 는 새 항목을 만들지 않는다 [PES_DB_CORE=1]", async () => {
  await with_mode("on", ghost_scenario);
});

// ---------------------------------------------------------------------------
// (3) user_links 모양 검사

const BAD_LINKS: Array<[string, unknown]> = [
  ["null", null],
  ["문자열", "https://u.example.test/z"],
  ["객체", { url: "https://u.example.test/z" }],
  ["숫자", 7],
];

async function bad_links_scenario(m: Mode): Promise<void> {
  ok(m.py(["round-start", m.slug, "plan"]), "round-start");
  ok(m.py(["merge", m.slug, "plan", m.json("seed.json", { id: 1, kind: "topic", title: "링크 항목", question: "q", user_links: [{ url: "https://u.example.test/a", memo: "a" }] })]), "seed");
  const before = item_fields(m, "plan", 1, "title,user_links,depth,status,question");
  const state_before = m.name === "off" ? m.state() : undefined;
  let k = 0;
  for (const [label, bad] of BAD_LINKS) {
    for (const [shape, proposal] of [
      ["id 있음", { id: 1, user_links: bad }],
      ["id 있음+요약", { id: 1, summary: "함께 온 요약", user_links: bad }],
    ] as Array<[string, Record<string, unknown>]>) {
      k += 1;
      const res = m.py(["merge", m.slug, "plan", m.json(`bad${k}.json`, proposal)]);
      const where = `user_links=${label} (${shape})`;
      assert.notEqual(res.status, 0, `${where}: 0 아닌 종료`);
      assert.doesNotMatch(res.stderr, /Traceback|TypeError|AttributeError/, `${where}: 스택 없이`);
      assert.match(res.stderr + res.stdout, HANGUL, `${where}: 한국어 거부`);
      assert.deepEqual(item_fields(m, "plan", 1, "title,user_links,depth,status,question"), before, `${where}: 항목 불변(함께 온 요약도 적용 안 됨)`);
      if (m.name === "off") assert.deepEqual(m.state(), state_before, `${where}: project.json 불변`);
    }
  }
  // 목록 안의 한 제안만 나빠도 전체가 거부되고 앞의 정상 제안도 적용되지 않는다
  const res = m.py(["merge", m.slug, "plan", m.json("batch.json", [{ id: 1, summary: "앞의 정상 제안" }, { id: 1, user_links: "x" }])]);
  assert.notEqual(res.status, 0, "목록 중 하나가 나쁘면 거부");
  assert.doesNotMatch(res.stderr, /Traceback/);
  assert.equal(item_fields(m, "plan", 1, "summary").summary ?? "", before.summary ?? "", "앞의 정상 제안도 적용되지 않았다");
}

test("user_links 가 null·문자열·객체·숫자이면 스택 없이 한국어로 거부하고 아무것도 바꾸지 않는다 [플래그 없음]", async () => {
  await with_mode("off", bad_links_scenario);
});

test("user_links 가 null·문자열·객체·숫자이면 스택 없이 한국어로 거부하고 아무것도 바꾸지 않는다 [PES_DB_CORE=1]", async () => {
  await with_mode("on", bad_links_scenario);
});

// (the test "항목에 저장된 user_links 가 null 이어도(손으로 고친 project.json) merge 가 스택으로 죽지 않는다" is gone: a hand-edited project.json that the CLI then writes into does not exist for pes.ts — the state is the database, and a null user_links of an OLD project.json is read by the importer: test_legacy_import_final1·test_legacy_import_r1.)
