/**
 * SEL-50 PR17 최종 리뷰 1/2 권장 1 회귀 (tester, 작성 모드). 구현 전이면 실패하는 것이 정상이다. 전부 합성 자료.
 *
 * 해석 R9: v0.15 프로젝트 전체 이전(import→validate→activate)에서 library 항목의 옛 confidence(공식 열거형 밖 값 "중간" 포함)는
 * `confidence_original` 에 보관된다. 그 library 를 reuse 한 topic 의 `approve plan` 재사용 항목은 같은 값을 이어받는다
 * (v0.15 handoff_plan 과 init --import 경로는 이미 보존).
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { make_cli_env, type CliResult } from "./helpers/cli_write_env.ts";
import { expect_staging, ok as ok_read, run_cli, write_legacy } from "./helpers/cli_read_env.ts";
import { backup_dir_of, migration, owner_of, pes_home_of } from "./helpers/migration_env.ts";
import { legacy } from "./helpers/legacy_env.ts";

const lf = (s: string) => s.replace(/\r\n/g, "\n");

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

test("이전된 library 의 옛 confidence(\"중간\")가 approve plan 재사용 항목에 보존된다", async () => {
  const c = await make_cli_env();
  try {
    const slug = "legacy-conf-synth";
    const dir = join(c.env.home.env.PES_HOME as string, slug);
    write_legacy(dir, legacy_with_reuse(slug));
    const api = await legacy();
    const mig = await migration();
    const imp = await api.import_project(c.env.service, dir, { owner_actor_id: owner_of(c.env) });
    expect_staging(imp, dir, "test_state_final1_regress.test.ts#1");
    const val = await mig.validate_import(c.env.service, imp.batch_id, { owner_actor_id: owner_of(c.env), source_dir: dir });
    assert.equal(val.ok, true, JSON.stringify(val.report.problems));
    await mig.activate_import(c.env.service, imp.batch_id, { owner_actor_id: owner_of(c.env), backup_dir: backup_dir_of(c.env, "final1-conf"), pes_home: pes_home_of(c.env) });

    const py = (args: string[]): CliResult => {
      const r = run_cli(c, args, { extra: { PES_OWNER: "sess-final1-conf" } });
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
    assert.equal(reused.confidence, "중간", "library 의 옛 신뢰도(열거형 밖 값)를 이어받는다");
    assert.notEqual(fresh.status, "deepen", "reuse 없는 topic 은 재사용하지 않는다");
    assert.equal((fresh.links?.library ?? []).length, 0);
    assert.equal(fresh.summary ?? "", "");
  } finally {
    c.close();
  }
});

