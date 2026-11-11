/**
 * SEL-48 PR15 — 1차 리뷰(r1-1) 회귀 시험 (tester, 회귀 모드). 구현은 고치지 않는다.
 * 리뷰: logs/SEL-48-r1-1.md, leader 결정: ledger 'SEL-48 r1 CHANGES' 줄. 자료는 모두 합성이고 HOME·USERPROFILE·PES_HOME은 임시 폴더다.
 *
 * 번호는 리뷰·지시의 번호를 따른다.
 *   ① render 봉인 manifest 는 현재 단계의 항목만 (다른 단계 항목이 섞이지 않는다)
 *   ② merge 의 conflicts·links·shots 는 v0.15 처럼 누적되고, 재승인해도 조사 항목이 중복 인계되지 않는다
 *   ③ claim 하지 않은 토큰 에이전트의 내용 쓰기는 forbidden·영수증 0, 자기 lease 가 있으면 허용, 남의 lease 면 거부,
 *      사람 소유자(토큰 없음)는 lease 없이도 허용
 *   4  PES_OWNER 가 있는 쓰기는 lease 가 없으면 잡는다 (v0.15 암묵 잠금)
 *   5  approve plan 출력의 '조사 항목 N개 생성 (기존 조사 재사용 M개)' 줄
 *   6  render 의 seal 이 거부되면 manifest blob·영수증이 남지 않는다
 *   7  init --slug 가 폴더명과 다르면 종료 2
 *   8  merge 의 모르는 status·confidence 는 종료 2, 쓰기 0
 *   10 너무 큰 qa 는 거부
 *   12 단위 안 FK 오류는 internal_error 가 아니라 conflict
 *   9  시험 품질(A1 시각 정규화·기준 커밋 필수·CI fetch-depth: 0)은 hardening 시험과 ci.yml 에서 고정한다.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { ApiError } from "../scripts/pes_core/errors.ts";
import { UnitOfWorkDb } from "../scripts/pes_core/commands/unit.ts";
import { new_artifact } from "./helpers/blob_env.ts";
import { expect_rejected, json_out, REPO, SLUG, with_cli, type CliEnv, type CliResult } from "./helpers/cli_write_env.ts";
import { start } from "./helpers/editions_env.ts";
import { state_signature, table_counts } from "./helpers/state_signature.ts";

function write_json(c: CliEnv, name: string, value: unknown): string {
  const file = join(c.env.home.root, name);
  writeFileSync(file, JSON.stringify(value), "utf8");
  return file;
}

function no_crash(res: CliResult, what: string): void {
  assert.doesNotMatch(res.stderr + res.stdout, /Traceback|SyntaxError|ModuleNotFoundError/, `${what}: 스택 추적이 아니라 분명한 오류여야 한다\n${res.stderr}`);
}

function ok(res: CliResult, what: string): CliResult {
  assert.equal(res.status, 0, `${what}: exit ${res.status}\n${res.stderr}${res.stdout}`);
  return res;
}

function lease_row(c: CliEnv) {
  return c.env.db.get<{ lease_id: string; state: string; fence: bigint; run_id: string | null; owner_actor_id: string | null }>(
    "SELECT lease_id, state, fence, run_id, owner_actor_id FROM project_leases WHERE project_id = ?",
    c.env.p.project_id,
  );
}

function claim_as(c: CliEnv, token: string): void {
  json_out(c.run(["claim", SLUG], { PES_TOKEN: token }));
}

// ---------------------------------------------------------------------------
// ① render 봉인 manifest — 활성 판·현재 단계 항목만

test("① render: 기획 R1 봉인 manifest 에 조사 단계 항목이 섞이지 않는다 (리뷰 재현: 항목 2개가 되던 것)", () =>
  with_cli(async (c) => {
    ok(c.run(["round-start", SLUG, "plan"]), "round-start plan");
    ok(c.run(["merge", SLUG, "plan", write_json(c, "m1-plan.json", [{ id: 1, kind: "topic", title: "기획 항목", summary: "기획" }])]), "merge plan");
    ok(c.run(["merge", SLUG, "research", write_json(c, "m1-research.json", [{ id: 1, kind: "topic", title: "조사 항목", summary: "조사", sources: [{ url: "https://r.example/1", title: "R" }] }])]), "merge research");
    const rendered = ok(c.run(["render", SLUG, "plan"]), "render plan");
    // (pes.ts 의 render 출력은 0.15 처럼 대시보드 경로뿐이다 — 봉인 항목은 아래 DB 행으로 본다)
    assert.match(rendered.stdout, /index\.html/, rendered.stdout);

    const sealed = c.env.db.get<{ id: string; sealed_snapshot_id: string }>(
      "SELECT id, sealed_snapshot_id FROM rounds WHERE stage_id = ? AND state = 'sealed'",
      c.stages.plan,
    );
    assert.ok(sealed, "기획 R1 이 봉인되었다");
    const stages = c.env.db
      .all<{ stage_id: string | null }>(
        `SELECT a.stage_id AS stage_id
           FROM round_contents rc JOIN artifacts a ON a.project_id = rc.project_id AND a.object_id = rc.object_id
          WHERE rc.round_id = ?`,
        sealed.id,
      )
      .map((r) => r.stage_id);
    assert.deepEqual(stages, [c.stages.plan], "봉인된 artifact 는 기획 단계 것뿐이다");
    const research = c.env.db.get<{ n: bigint }>(
      `SELECT count(*) AS n FROM round_contents rc JOIN artifacts a ON a.project_id = rc.project_id AND a.object_id = rc.object_id
        WHERE rc.round_id = ? AND a.stage_id = ?`,
      sealed.id,
      c.stages.research,
    );
    assert.equal(research?.n, 0n, "조사 항목은 기획 스냅숏에 없다");
    const objects = c.env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM round_contents WHERE round_id = ?", sealed.id);
    assert.equal(objects?.n, 1n, "round_contents 도 한 개");
  }));

test("① render: 조사 항목이 있어도 승인 스냅숏에 들어가지 않고, 승인은 기획 항목만 인계한다", () =>
  with_cli(async (c) => {
    ok(c.run(["round-start", SLUG, "plan"]), "round-start");
    ok(c.run(["merge", SLUG, "plan", write_json(c, "m1b-plan.json", [{ id: 1, kind: "topic", title: "기획 항목", summary: "기획" }])]), "merge plan");
    ok(c.run(["merge", SLUG, "research", write_json(c, "m1b-research.json", [{ id: 7, kind: "topic", title: "미리 만든 조사", summary: "x" }])]), "merge research");
    ok(c.run(["render", SLUG, "plan"]), "render");
    const snap = c.env.db.get<{ sealed_snapshot_id: string }>("SELECT sealed_snapshot_id FROM rounds WHERE stage_id = ? AND state = 'sealed'", c.stages.plan);
    ok(c.run(["approve", SLUG, "plan"]), "approve");
    const approval = c.env.db.get<{ snapshot_id: string }>("SELECT snapshot_id FROM approvals WHERE stage_id = ?", c.stages.plan);
    assert.equal(approval?.snapshot_id, snap?.sealed_snapshot_id, "승인은 방금 봉인한 스냅숏을 승인한다");
    const leaked = c.env.db.get<{ n: bigint }>(
      `SELECT count(*) AS n FROM round_contents rc JOIN artifacts a ON a.project_id = rc.project_id AND a.object_id = rc.object_id
        WHERE rc.round_id = (SELECT round_id FROM snapshots WHERE id = ?) AND a.stage_id <> ?`,
      approval!.snapshot_id,
      c.stages.plan,
    );
    assert.equal(leaked?.n, 0n);
  }));

// ---------------------------------------------------------------------------
// ② merge 누적 — v0.15 와 나란히

interface Accum {
  conflicts: unknown[];
  links: Record<string, unknown[]>;
  shots: unknown[];
}

const MERGE_1 = { id: 1, kind: "topic", title: "누적 항목", conflicts: [{ a: 1 }], links: { plan: [7] }, shots: ["s1.png"] };
const MERGE_2 = { id: 1, conflicts: [{ b: 2 }, { a: 1 }], links: { plan: [8, 7], other: [1] }, shots: ["s2.png", "s1.png"] };
const MERGE_3 = { id: 1, conflicts: [{ a: 1 }], links: { plan: 9, other: [1] }, shots: ["s1.png"] };

function accum_from_db(c: CliEnv): Accum {
  const row = c.env.db.get<{ conflicts: string; meta: string }>(
    `SELECT v.conflicts AS conflicts, v.metadata_json AS meta
       FROM objects o JOIN artifacts a ON a.project_id = o.project_id AND a.object_id = o.id
       JOIN artifact_versions v ON v.project_id = o.project_id AND v.version_id = o.current_version_id
      WHERE o.project_id = ? AND a.stage_id = ? AND o.kind = 'artifact' ORDER BY o.display_no LIMIT 1`,
    c.env.p.project_id,
    c.stages.plan,
  );
  assert.ok(row, "기획 항목이 있다");
  const meta = JSON.parse(row.meta) as { links?: Record<string, unknown[]>; shots?: unknown[] };
  return { conflicts: JSON.parse(row.conflicts), links: meta.links ?? {}, shots: meta.shots ?? [] };
}

test("② merge 를 두 번·세 번 하면 conflicts·links·shots 가 합집합(순서 유지)으로 쌓인다 — 0.15 가 같은 입력에서 낸 값과 같다", () =>
  with_cli(async (c) => {
    // expected_* 는 0.15 가 같은 병합 두 번·세 번 뒤에 project.json 에 남긴 값이다 (이 시험을 처음 쓸 때 0.15 로 확인한 기준값 — SEL-74: 0.15 는 이제 없다)
    ok(c.run(["round-start", SLUG, "plan"]), "round-start");
    for (const [n, payload] of [MERGE_1, MERGE_2].entries()) {
      ok(c.run(["merge", SLUG, "plan", write_json(c, `acc-${n}.json`, [payload])]), `merge ${n + 1}`);
    }
    const expected_two: Accum = { conflicts: [{ a: 1 }, { b: 2 }], links: { plan: [7, 8], other: [1] }, shots: ["s1.png", "s2.png"] };
    assert.deepEqual(accum_from_db(c), expected_two, "두 번 병합: 앞의 값이 사라지지 않고 합집합이다");
    ok(c.run(["merge", SLUG, "plan", write_json(c, "acc-3.json", [MERGE_3])]), "merge 3");
    const expected_three: Accum = { conflicts: [{ a: 1 }, { b: 2 }], links: { plan: [7, 8, 9], other: [1] }, shots: ["s1.png", "s2.png"] };
    assert.deepEqual(accum_from_db(c), expected_three, "세 번째 병합: 중복 없이 쌓이고, 스칼라 링크도 목록에 더해진다");
  }));

test("② links.plan 이 누적된 뒤 기획을 다시 승인해도 조사 항목이 중복 인계되지 않는다", () =>
  with_cli(async (c) => {
    ok(c.run(["round-start", SLUG, "plan"]), "round-start plan");
    ok(c.run(["merge", SLUG, "plan", write_json(c, "re-plan.json", [{ id: 1, kind: "topic", title: "인계될 질문", question: "무엇인가?" }])]), "merge plan");
    ok(c.run(["render", SLUG, "plan"]), "render");
    ok(c.run(["approve", SLUG, "plan"]), "approve (1차)");
    const research_topics = () =>
      c.env.db.get<{ n: bigint }>(
        `SELECT count(*) AS n FROM objects o JOIN artifacts a ON a.project_id = o.project_id AND a.object_id = o.id
          WHERE o.project_id = ? AND a.stage_id = ? AND a.kind = 'topic' AND o.archived_at IS NULL`,
        c.env.p.project_id,
        c.stages.research,
      )?.n;
    assert.equal(research_topics(), 1n, "1차 승인: 조사 항목 하나가 만들어졌다");
    const created = c.env.db.get<{ meta: string }>(
      `SELECT v.metadata_json AS meta FROM objects o JOIN artifacts a ON a.project_id = o.project_id AND a.object_id = o.id
         JOIN artifact_versions v ON v.project_id = o.project_id AND v.version_id = o.current_version_id
        WHERE o.project_id = ? AND a.stage_id = ?`,
      c.env.p.project_id,
      c.stages.research,
    );
    const legacy_id = JSON.parse(created!.meta).legacy_id as number;
    // 조사 항목에 다른 plan 링크를 병합 — 누적이면 [1, 8], 교체면 [8] 이 되어 1번 질문이 '아직 안 넘긴 것'으로 보인다
    ok(c.run(["round-start", SLUG, "research"]), "round-start research");
    ok(c.run(["merge", SLUG, "research", write_json(c, "re-research.json", [{ id: legacy_id, links: { plan: [8] }, summary: "조사함" }])]), "merge research");
    ok(c.run(["reopen", SLUG, "plan"]), "reopen plan");
    ok(c.run(["round-start", SLUG, "plan"]), "round-start plan (R2)");
    ok(c.run(["merge", SLUG, "plan", write_json(c, "re-plan2.json", [{ id: 1, summary: "보강" }])]), "merge plan R2");
    ok(c.run(["render", SLUG, "plan"]), "render R2");
    const again = ok(c.run(["approve", SLUG, "plan"]), "approve (재승인)");
    assert.ok(again.stdout.length > 0);
    assert.equal(research_topics(), 1n, "조사 항목이 중복 생성되지 않았다");
  }));

// ---------------------------------------------------------------------------
// ③ 토큰 에이전트의 내용 쓰기 — 자기 lease 가 있을 때만

interface ContentCase {
  name: string;
  /** 사람 소유자로 미리 만들어 둘 것(라운드·항목)과 인자 */
  prepare(c: CliEnv): string[];
}

function open_round_with_item(c: CliEnv, tag: string): void {
  ok(c.run(["round-start", SLUG, "plan"]), `${tag}: round-start`);
  ok(c.run(["merge", SLUG, "plan", write_json(c, `${tag}-seed.json`, [{ id: 1, kind: "topic", title: "시드 항목", summary: "시드" }])]), `${tag}: 시드 merge`);
}

const CONTENT_CASES: ContentCase[] = [
  { name: "merge", prepare: (c) => (open_round_with_item(c, "mg"), ["merge", SLUG, "plan", write_json(c, "mg-in.json", [{ id: 2, title: "에이전트 항목", summary: "x" }])]) },
  { name: "note", prepare: () => ["note", SLUG, "에이전트 메모"] },
  { name: "chat", prepare: () => ["chat", SLUG, "plan", "에이전트 채팅"] },
  { name: "mark", prepare: () => ["mark", SLUG, "feedback/agent-a.json"] },
  {
    name: "qa",
    prepare: (c) => (open_round_with_item(c, "qa"), ["qa", SLUG, "plan", "--file", write_json(c, "qa-in.json", { verdict: "pass", qc: [], qa: [], spot_checks: [], missed_by_self_review: [] })]),
  },
  { name: "qa-brief", prepare: (c) => (open_round_with_item(c, "qb"), ["qa-brief", SLUG, "plan"]) },
  {
    name: "ask",
    prepare: (c) => {
      const spec = join(c.env.home.root, "ask-in.json");
      writeFileSync(spec, readFileSync(join(REPO, "questions", "plan.json")), "utf8");
      return ["ask", SLUG, spec];
    },
  },
  { name: "ask-prep", prepare: () => ["ask-prep", SLUG, "plan"] },
  { name: "round-start", prepare: () => ["round-start", SLUG, "plan"] },
];

for (const spec of CONTENT_CASES) {
  test(`③ ${spec.name}: claim 안 한 토큰은 forbidden(영수증 0), 자기 lease 가 있으면 허용, 남의 lease 로는 거부`, () =>
    with_cli(async (c) => {
      const holder = await c.agent("holder");
      const other = await c.agent("other");
      const args = spec.prepare(c);

      // (a) lease 가 없는 토큰 에이전트 — 거부, 아무것도 안 남는다
      const sig0 = state_signature(c.env.db);
      const n0 = c.commits().length;
      const bare = c.run(args, { PES_TOKEN: holder.token });
      expect_rejected(bare, `${spec.name}: claim 안 한 토큰`);
      no_crash(bare, spec.name);
      assert.equal(c.commits().length, n0, `${spec.name}: 영수증 0`);
      assert.equal(state_signature(c.env.db), sig0, `${spec.name}: DB 불변`);
      assert.equal(lease_row(c), undefined, `${spec.name}: 거부가 lease 를 만들지 않는다`);

      // (b) holder 가 claim 하면 남의 토큰(other)은 거부된다
      claim_as(c, holder.token);
      const sig1 = state_signature(c.env.db);
      const n1 = c.commits().length;
      const foreign = c.run(args, { PES_TOKEN: other.token });
      expect_rejected(foreign, `${spec.name}: 남의 lease`);
      assert.equal(c.commits().length, n1, `${spec.name}: 남의 lease 로는 영수증 0`);
      assert.equal(state_signature(c.env.db), sig1);

      // (c) 자기 lease 로는 허용되고, 영수증의 actor 는 그 에이전트다
      const mine = c.run(args, { PES_TOKEN: holder.token });
      assert.equal(mine.status, 0, `${spec.name}: 자기 lease 로는 허용: ${mine.stderr}${mine.stdout}`);
      const added = c.commits().slice(n1);
      if (spec.name !== "mark") assert.ok(added.length > 0, `${spec.name}: 영수증이 남는다`);
      for (const m of added) assert.equal(m.actor_id, holder.actor_id, `${spec.name}: actor 는 에이전트 (${m.action})`);
    }));

  test(`③ ${spec.name}: 사람 소유자(토큰 없음)는 lease 없이도 허용된다`, () =>
    with_cli(async (c) => {
      const args = spec.prepare(c);
      const n0 = c.commits().length;
      const res = c.run(args);
      assert.equal(res.status, 0, `${spec.name}: ${res.stderr}${res.stdout}`);
      const added = c.commits().slice(n0);
      for (const m of added) assert.equal(m.actor_id, c.env.p.actor_id, `${spec.name}: 소유자 actor`);
      assert.equal(lease_row(c), undefined, `${spec.name}: PES_OWNER 없는 사람 쓰기는 lease 를 만들지 않는다`);
    }));
}

// ---------------------------------------------------------------------------
// 4 · PES_OWNER 암묵 잠금

test("4 PES_OWNER 가 있는 첫 쓰기는 lease 를 잡고, 다른 PES_OWNER 세션의 쓰기는 종료 3, 같은 세션은 계속 쓴다", () =>
  with_cli(async (c) => {
    assert.equal(lease_row(c), undefined, "처음엔 lease 가 없다");
    ok(c.run(["note", SLUG, "첫 쓰기"], { PES_OWNER: "sess-impl0001" }), "첫 쓰기");
    const held = lease_row(c);
    assert.ok(held, "lock 을 부르지 않았어도 PES_OWNER 쓰기가 lease 를 잡는다 (v0.15 암묵 잠금)");
    assert.equal(held.state, "active");
    assert.equal(held.owner_actor_id, c.env.p.actor_id);

    const n = c.commits().length;
    const sig = state_signature(c.env.db);
    const other = c.run(["note", SLUG, "다른 세션"], { PES_OWNER: "sess-impl0002" });
    assert.equal(other.status, 3, `다른 PES_OWNER 세션은 종료 3 (실제 ${other.status}: ${other.stderr})`);
    assert.equal(c.commits().length, n);
    assert.equal(state_signature(c.env.db), sig);

    ok(c.run(["note", SLUG, "같은 세션 둘째"], { PES_OWNER: "sess-impl0001" }), "같은 세션");
    const again = lease_row(c);
    assert.equal(again?.lease_id, held.lease_id, "같은 세션은 같은 lease 를 쓴다");
    assert.equal(again?.fence, held.fence, "fence 도 그대로");
    const notes = c.env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM mutation_commits WHERE action = 'project.note_added'");
    assert.equal(notes?.n, 2n, "두 번 모두 기록되었다");
  }));

test("4 PES_OWNER 없는 사람 쓰기는 lease 를 잡지 않는다 (v0.15: 세션 없으면 잠금 안 함)", () =>
  with_cli(async (c) => {
    ok(c.run(["note", SLUG, "세션 없음"]), "note");
    assert.equal(lease_row(c), undefined);
  }));

// ---------------------------------------------------------------------------
// 5 · approve plan 출력

test("5 approve plan 은 '조사 항목 N개 생성 (기존 조사 재사용 M개)' 줄을 출력한다 — 0.15 와 같은 문구", () =>
  with_cli(async (c) => {
    const topics = [
      { id: 1, kind: "topic", title: "질문 하나", question: "무엇인가?" },
      { id: 2, kind: "topic", title: "질문 둘", question: "왜인가?" },
      { id: 3, kind: "topic", title: "빼기로 한 질문", question: "?", status: "removed" },
    ];
    ok(c.run(["round-start", SLUG, "plan"]), "round-start");
    ok(c.run(["merge", SLUG, "plan", write_json(c, "ap-topics.json", topics)]), "merge");
    ok(c.run(["render", SLUG, "plan"]), "render");
    const approved = ok(c.run(["approve", SLUG, "plan"]), "approve");
    const line = approved.stdout.split("\n").find((l) => l.includes("조사 항목"));
    assert.ok(line, `조사 항목 줄이 있다:\n${approved.stdout}`);
    assert.equal(line.trim(), "조사 항목 2개 생성 (기존 조사 재사용 0개)", "0.15 문구");
  }));

test("5 approve plan 에 기획 항목이 없으면 '조사 항목 0개 생성' 으로 알린다", () =>
  with_cli(async (c) => {
    ok(c.run(["round-start", SLUG, "plan"]), "round-start");
    ok(c.run(["merge", SLUG, "plan", write_json(c, "ap0.json", [{ id: 1, kind: "note", title: "주제 아님", summary: "x" }])]), "merge");
    ok(c.run(["render", SLUG, "plan"]), "render");
    const approved = ok(c.run(["approve", SLUG, "plan"]), "approve");
    assert.match(approved.stdout, /조사 항목 0개 생성 \(기존 조사 재사용 0개\)/);
  }));

// ---------------------------------------------------------------------------
// 6 · render 는 한 단위 — seal 이 거부되면 blob·영수증이 남지 않는다

test("6 render 의 seal 이 거부되면 manifest blob 과 영수증이 남지 않는다 (DB 전체 불변)", () =>
  with_cli(async (c) => {
    open_round_with_item(c, "r6");
    const sig = state_signature(c.env.db);
    const counts = table_counts(c.env.db);
    const n = c.commits().length;
    // 시험 DB 에만 거는 장치: 스냅숏을 쓰려는 순간(= seal 단계) 거부시킨다.
    c.env.db.exec("CREATE TRIGGER regress_block_snapshot BEFORE INSERT ON snapshots BEGIN SELECT RAISE(ABORT, 'regress: seal refused'); END");
    const trigger_sig = state_signature(c.env.db);
    assert.equal(trigger_sig, sig, "트리거 설치는 행을 바꾸지 않는다");
    const res = c.run(["render", SLUG, "plan"]);
    expect_rejected(res, "seal 이 거부되는 render");
    assert.equal(c.commits().length, n, "blob 예약·완료 영수증이 남지 않는다");
    const after = table_counts(c.env.db);
    assert.equal(after.blobs, counts.blobs, "ready 상태의 manifest blob 행이 남지 않는다");
    assert.equal(after.mutation_commits, counts.mutation_commits);
    assert.equal(state_signature(c.env.db), sig, "거부된 render 는 DB 를 하나도 바꾸지 않는다");
    const round = c.env.db.get<{ state: string }>("SELECT state FROM rounds WHERE stage_id = ? ORDER BY round_no DESC", c.stages.plan);
    assert.equal(round?.state, "open", "라운드는 열린 채로 남는다");
  }));

// ---------------------------------------------------------------------------
// 7 · init --slug

test("7 init --slug 가 폴더 이름과 다르면 종료 2, 프로젝트도 폴더도 만들지 않는다", () =>
  with_cli(async (c) => {
    const sig = state_signature(c.env.db);
    const res = c.run(["init", "regress-folder", "--topic", "합성", "--slug", "regress-other"]);
    assert.equal(res.status, 2, `종료 2 (실제 ${res.status}: ${res.stderr}${res.stdout})`);
    no_crash(res, "init --slug 불일치");
    assert.equal(state_signature(c.env.db), sig, "DB 불변");
    const home = c.env.home.env.PES_HOME as string;
    assert.ok(!existsSync(join(home, "regress-folder")), "폴더를 만들지 않았다");
    assert.equal(c.env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM projects WHERE slug = 'regress-other'")?.n, 0n);
  }));

test("7 init --slug 가 폴더 이름과 같으면 정상이고 이후 명령이 그 프로젝트를 찾는다", () =>
  with_cli(async (c) => {
    ok(c.run(["init", "regress-same", "--topic", "합성", "--slug", "regress-same"]), "init");
    ok(c.run(["round-start", "regress-same", "plan"]), "이어지는 명령이 프로젝트를 찾는다");
  }));

// ---------------------------------------------------------------------------
// 8 · merge 의 모르는 status·confidence

for (const [label, bad] of [
  ["status", { id: 1, title: "x", status: "bogus-status" }],
  ["confidence", { id: 1, title: "x", confidence: "bogus-confidence" }],
] as const) {
  test(`8 merge 의 모르는 ${label} 는 종료 2, 쓰기 0 (같은 파일의 앞 항목도 남지 않는다)`, () =>
    with_cli(async (c) => {
      ok(c.run(["round-start", SLUG, "plan"]), "round-start");
      const sig = state_signature(c.env.db);
      const json_before = c.sig(c.project_json);
      const file = write_json(c, `m8-${label}.json`, [{ id: 5, title: "앞 항목 — 함께 거부돼야 한다" }, bad]);
      const res = c.run(["merge", SLUG, "plan", file]);
      assert.equal(res.status, 2, `종료 2 (실제 ${res.status}: ${res.stderr}${res.stdout})`);
      no_crash(res, `merge 모르는 ${label}`);
      assert.equal(state_signature(c.env.db), sig, "쓰기 0");
      assert.deepEqual(c.sig(c.project_json), json_before);
    }));
}

test("8 merge 는 아는 status·confidence 값은 그대로 받는다", () =>
  with_cli(async (c) => {
    ok(c.run(["round-start", SLUG, "plan"]), "round-start");
    const items = ["new", "deepen", "revise", "browser", "done", "removed", "failed"].map((status, i) => ({ id: i + 1, title: `항목 ${status}`, status, confidence: (["high", "medium", "low"] as const)[i % 3] }));
    ok(c.run(["merge", SLUG, "plan", write_json(c, "m8-ok.json", items)]), "아는 값");
  }));

// ---------------------------------------------------------------------------
// 10 · 너무 큰 qa

test("10 너무 큰 qa 는 거부되고 아무것도 남지 않으며, 보통 크기의 qa 는 받는다", () =>
  with_cli(async (c) => {
    open_round_with_item(c, "q10");
    const sig = state_signature(c.env.db);
    const n = c.commits().length;
    const huge = write_json(c, "q10-huge.json", { verdict: "pass", qc: [], qa: [], spot_checks: [], missed_by_self_review: [], note: "가".repeat(400_000) });
    const res = c.run(["qa", SLUG, "plan", "--file", huge]);
    expect_rejected(res, "너무 큰 qa");
    no_crash(res, "너무 큰 qa");
    assert.equal(c.commits().length, n, "영수증 0");
    assert.equal(state_signature(c.env.db), sig, "DB 불변");
    const small = write_json(c, "q10-small.json", { verdict: "pass", qc: [], qa: [], spot_checks: [], missed_by_self_review: [], note: "가".repeat(2_000) });
    ok(c.run(["qa", SLUG, "plan", "--file", small]), "보통 크기의 qa");
  }));

// ---------------------------------------------------------------------------
// 12 · 단위 COMMIT 의 FK 오류

test("12 단위(unit) 안에서 미룬 FK 가 바깥 COMMIT 에서 깨지면 internal_error 가 아니라 conflict, 전체 롤백", () =>
  with_cli(async (c) => {
    const art = await new_artifact(c.env, "u12");
    const db = new UnitOfWorkDb(c.env.db);
    const before = state_signature(c.env.db);
    let caught: unknown;
    try {
      await db.unit(async () => {
        // approve plan 처럼 편집 명령이 FK 를 미룬 단위: 그 뒤의 쓰기가 외래 키를 어기면 바깥 COMMIT 에서 드러난다.
        db.exec("PRAGMA defer_foreign_keys = ON");
        db.run("UPDATE objects SET current_version_id = 'no-such-version' WHERE id = ?", art.object_id);
      });
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof ApiError, `ApiError(conflict) 여야 한다 — 실제: ${String(caught)}`);
    assert.equal((caught as ApiError).code, "conflict", "FK 위반은 conflict 로 번역된다");
    assert.equal(state_signature(c.env.db), before, "단위 전체가 롤백된다");
    // 롤백 뒤에도 연결은 계속 쓸 수 있다
    assert.equal(c.env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM objects")?.n !== undefined, true);
  }));

// ---------------------------------------------------------------------------
// 9 · CI 설정

test("9 CI 의 actions/checkout 은 전체 이력(fetch-depth: 0)을 받는다 — A1 의 기준 커밋 비교가 CI 에서 비지 않게", () => {
  const ci = readFileSync(join(REPO, ".github", "workflows", "ci.yml"), "utf8");
  const lines = ci.split(/\r?\n/);
  const checkouts = lines.flatMap((line, i) => (/uses:\s*actions\/checkout@/.test(line) ? [lines.slice(i + 1, i + 4).join("\n")] : []));
  assert.ok(checkouts.length >= 2, "checkout 단계가 있다");
  for (const following of checkouts) assert.match(following, /fetch-depth:\s*0\b/, "모든 checkout 에 fetch-depth: 0");
});
