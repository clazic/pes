/**
 * SEL-48 PR15 — Codex 최종 리뷰 1/2 회귀 시험 (tester, 회귀 모드). 구현은 고치지 않는다.
 * 리뷰: logs/SEL-48-final-review-1.md. 자료는 모두 합성이고 HOME·USERPROFILE·PES_HOME 은 임시 폴더, PES_DB_CORE=1.
 *
 *   F1 approve plan 의 조사 항목 인계는 승인된 라운드의 봉인본(round_contents 버전) 기준
 *   F2 토큰을 준 init 은 거부 — 프로젝트·사람·판·정책·영수증 0 (토큰 없는 사람 init 은 그대로)
 *   F3 lock --force 의 새 claim 이 거부되면 기존 run·lease·영수증 전부 불변
 *   R1 세션 표지 없는 에이전트 lease 가 있으면 home 은 --force 없이 종료 3
 *   R2 단계 미지정(stage_id NULL) artifact 는 단계 봉인 manifest 에 들어가지 않는다
 *
 * 기존 시험 정정(R2): test_cli_write.test.ts 의 'render: 열린 라운드를 봉인' 이 단계 없는 artifact 로 봉인하고 있어
 *   기획 단계 항목(CLI merge)으로 바꿨다.
 */

import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { revoke_agent_token } from "../scripts/pes_core/actors.ts";
import { add_artifact, create_object } from "../scripts/pes_core/content.ts";
import { expect_rejected, json_out, SLUG, with_cli, type CliEnv, type CliResult } from "./helpers/cli_write_env.ts";
import { state_signature, table_counts } from "./helpers/state_signature.ts";

function write_json(c: CliEnv, name: string, value: unknown): string {
  const file = join(c.env.home.root, name);
  writeFileSync(file, JSON.stringify(value), "utf8");
  return file;
}

function ok(res: CliResult, what: string): CliResult {
  assert.equal(res.status, 0, `${what}: exit ${res.status}\n${res.stderr}${res.stdout}`);
  return res;
}

function no_crash(res: CliResult, what: string): void {
  assert.doesNotMatch(res.stderr + res.stdout, /Traceback|SyntaxError|ModuleNotFoundError/, `${what}: 스택 추적이 아니라 분명한 오류여야 한다\n${res.stderr}`);
}

function lease_row(c: CliEnv) {
  return c.env.db.get<{ lease_id: string; state: string; fence: bigint; run_id: string | null }>(
    "SELECT lease_id, state, fence, run_id FROM project_leases WHERE project_id = ?",
    c.env.p.project_id,
  );
}

interface ResearchTopic {
  title: string;
  question: string | null;
  plan_links: unknown[];
}

function research_topics(c: CliEnv): ResearchTopic[] {
  return c.env.db
    .all<{ title: string; question: string | null; meta: string }>(
      `SELECT v.title AS title, v.question AS question, v.metadata_json AS meta
         FROM objects o JOIN artifacts a ON a.project_id = o.project_id AND a.object_id = o.id
         JOIN artifact_versions v ON v.project_id = o.project_id AND v.version_id = o.current_version_id
        WHERE o.project_id = ? AND a.stage_id = ? AND a.kind = 'topic' AND o.archived_at IS NULL
        ORDER BY o.display_no`,
      c.env.p.project_id,
      c.stages.research,
    )
    .map((r) => ({ title: r.title, question: r.question, plan_links: (JSON.parse(r.meta).links?.plan ?? []) as unknown[] }));
}

// ---------------------------------------------------------------------------
// F1 · approve plan 인계는 봉인본 기준

test("F1 봉인 뒤 제목·질문을 고치고 새 topic 을 더해도 인계 결과는 봉인본과 같다 (조사 항목 1개, 원래 제목·질문)", () =>
  with_cli(async (c) => {
    ok(c.run(["round-start", SLUG, "plan"]), "round-start");
    ok(c.run(["merge", SLUG, "plan", write_json(c, "f1-a.json", [{ id: 1, kind: "topic", title: "approved topic", question: "approved question" }])]), "merge 1");
    ok(c.run(["render", SLUG, "plan"]), "render");
    // 새 라운드를 열지 않고 봉인 뒤 수정·추가
    ok(c.run(["merge", SLUG, "plan", write_json(c, "f1-b.json", [{ id: 1, title: "edited after seal", question: "edited question" }, { id: 2, kind: "topic", title: "never sealed", question: "never sealed q" }])]), "봉인 뒤 merge");
    const approved = ok(c.run(["approve", SLUG, "plan"]), "approve");
    assert.match(approved.stdout, /조사 항목 1개 생성/, `봉인본의 항목은 1개: ${approved.stdout}`);
    const topics = research_topics(c);
    assert.equal(topics.length, 1, `봉인되지 않은 #2 는 인계되지 않는다: ${JSON.stringify(topics)}`);
    assert.equal(topics[0]!.title, "approved topic", "봉인 당시 제목");
    assert.equal(topics[0]!.question, "approved question", "봉인 당시 질문");
    assert.ok(!topics.some((t) => t.title === "never sealed"), "봉인 뒤 새 topic 은 조사 단계에 없다");
  }));

test("F1 봉인 뒤 removed 로 바꿔도, 봉인 당시 removed 였던 것을 되살려도 인계는 봉인본 기준이다", () =>
  with_cli(async (c) => {
    ok(c.run(["round-start", SLUG, "plan"]), "round-start");
    ok(
      c.run([
        "merge", SLUG, "plan",
        write_json(c, "f1r-a.json", [
          { id: 1, kind: "topic", title: "keep-topic", question: "q1" },
          { id: 2, kind: "topic", title: "removed-before-seal", question: "q2", status: "removed" },
          { id: 3, kind: "topic", title: "removed-after-seal", question: "q3" },
        ]),
      ]),
      "merge",
    );
    ok(c.run(["render", SLUG, "plan"]), "render");
    ok(
      c.run([
        "merge", SLUG, "plan",
        write_json(c, "f1r-b.json", [
          { id: 2, status: "new" }, // 봉인 뒤 되살림 — 봉인본에서는 removed
          { id: 3, status: "removed" }, // 봉인 뒤 제거 — 봉인본에서는 살아 있음
        ]),
      ]),
      "봉인 뒤 status 변경",
    );
    const approved = ok(c.run(["approve", SLUG, "plan"]), "approve");
    assert.match(approved.stdout, /조사 항목 2개 생성/, `봉인본 기준 2개(#1·#3): ${approved.stdout}`);
    assert.deepEqual(research_topics(c).map((t) => t.title).sort(), ["keep-topic", "removed-after-seal"], "봉인본의 살아 있는 topic 만 인계");
  }));

// ---------------------------------------------------------------------------
// F2 · 토큰을 준 init 은 거부

function token_init_cases(c: CliEnv) {
  return (async () => {
    const readonly = await c.agent("f2-readonly", ["context:read"]);
    const full = await c.agent("f2-full");
    const expired = await c.agent("f2-expired");
    c.env.db.run("UPDATE agent_tokens SET created_at = 1, expires_at = 2 WHERE actor_id = ?", expired.actor_id);
    const revoked = await c.agent("f2-revoked");
    const token_id = c.env.db.get<{ id: string }>("SELECT id FROM agent_tokens WHERE actor_id = ?", revoked.actor_id)!.id;
    await revoke_agent_token(c.env.service, c.env.ctx("f2-revoke"), { token_id });
    return [
      ["invalid", "invalid-token"],
      ["expired", expired.token],
      ["revoked", revoked.token],
      ["context:read 만", readonly.token],
      ["다른 프로젝트(기존 프로젝트) 토큰", full.token],
    ] as const;
  })();
}

test("F2 init 에 토큰을 주면(invalid·expired·revoked·context:read 만·다른 프로젝트) 거부, 프로젝트·사람·판·정책·영수증 0, 폴더 없음", () =>
  with_cli(async (c) => {
    const cases = await token_init_cases(c);
    const sig = state_signature(c.env.db);
    const counts = table_counts(c.env.db);
    const n = c.commits().length;
    let i = 0;
    for (const [label, token] of cases) {
      i += 1;
      const slug = `f2-new-${i}`;
      const res = c.run(["init", slug, "--topic", "합성 토큰 init"], { PES_TOKEN: token });
      expect_rejected(res, `${label} 토큰 init`);
      no_crash(res, label);
      assert.equal(c.env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM projects WHERE slug = ?", slug)?.n, 0n, `${label}: 프로젝트 0`);
      assert.ok(!existsSync(join(c.env.home.env.PES_HOME as string, slug)), `${label}: 폴더를 만들지 않는다`);
    }
    assert.equal(c.commits().length, n, "영수증 0");
    const after = table_counts(c.env.db);
    for (const t of ["projects", "users", "actors", "editions", "stages", "policies", "mutation_commits"]) {
      if (t in counts) assert.equal(after[t], counts[t], `${t} 행 수 불변`);
    }
    assert.equal(state_signature(c.env.db), sig, "DB 전체 불변");
  }));

test("F2 토큰 없는 사람 init 은 그대로 동작한다 (토큰 거부가 사람 경로를 막지 않는다)", () =>
  with_cli(async (c) => {
    ok(c.run(["init", "f2-human", "--topic", "합성 사람 init"]), "init");
    assert.equal(c.env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM projects WHERE slug = 'f2-human'")?.n, 1n);
  }));

// ---------------------------------------------------------------------------
// F3 · lock --force 는 한 단위

test("F3 lock --force 의 새 claim 이 거부되면(PES_OWNER 201자) 기존 run·lease·영수증이 모두 그대로다", () =>
  with_cli(async (c) => {
    const A = "sess-final-a001";
    ok(c.run(["lock", SLUG], { PES_OWNER: A }), "lock");
    const held = lease_row(c)!;
    assert.equal(held.state, "active");
    const sig = state_signature(c.env.db);
    const n = c.commits().length;
    const run_before = c.env.db.get<{ status: string }>("SELECT status FROM runs WHERE id = ?", held.run_id);
    const res = c.run(["lock", SLUG, "--force"], { PES_OWNER: "x".repeat(201) });
    expect_rejected(res, "201자 PES_OWNER 의 lock --force");
    no_crash(res, "lock --force");
    assert.equal(c.commits().length, n, "run.interrupted 영수증이 남지 않는다");
    assert.equal(c.env.db.get<{ status: string }>("SELECT status FROM runs WHERE id = ?", held.run_id)?.status, run_before?.status, "기존 run 상태 불변");
    const after = lease_row(c)!;
    assert.equal(after.lease_id, held.lease_id, "같은 lease");
    assert.equal(after.state, "active", "lease 해제되지 않는다");
    assert.equal(after.fence, held.fence, "fence 불변");
    assert.equal(state_signature(c.env.db), sig, "DB 전체 불변");
    // 원래 세션은 계속 쓸 수 있다
    ok(c.run(["note", SLUG, "원래 세션"], { PES_OWNER: A }), "원래 세션의 쓰기");
  }));

// ---------------------------------------------------------------------------
// R1 · home 은 세션 표지 없는 에이전트 lease 도 사용 중으로 본다

test("R1 에이전트가 claim(세션 표지 없음)한 프로젝트가 있으면 home 은 --force 없이 종료 3, 폴더·DB 불변", () =>
  with_cli(async (c) => {
    const agent = await c.agent("r1-claimer");
    json_out(c.run(["claim", SLUG], { PES_TOKEN: agent.token }));
    const held = lease_row(c)!;
    assert.equal(held.state, "active");
    const target = join(c.env.home.root, "r1-target");
    const sig = state_signature(c.env.db);
    const res = c.run(["home", target]);
    assert.equal(res.status, 3, `종료 3 (실제 ${res.status}: ${res.stderr}${res.stdout})`);
    no_crash(res, "home");
    assert.ok(existsSync(c.folder), "프로젝트 폴더가 그대로 있다");
    assert.ok(existsSync(join(c.folder, "project.json")));
    assert.ok(!existsSync(join(target, SLUG)), "새 폴더로 옮기지 않았다");
    assert.equal(state_signature(c.env.db), sig, "DB 불변");
    assert.equal(lease_row(c)?.state, "active", "에이전트 lease 는 그대로 active");
  }));

test("R1 --force 면 옮기되 에이전트 lease·DB 는 그대로다", () =>
  with_cli(async (c) => {
    const agent = await c.agent("r1-forced");
    json_out(c.run(["claim", SLUG], { PES_TOKEN: agent.token }));
    const target = join(c.env.home.root, "r1-forced-target");
    const sig = state_signature(c.env.db);
    const forced = c.run(["home", target, "--force"]);
    assert.equal(forced.status, 0, forced.stderr);
    assert.ok(existsSync(join(target, SLUG, "project.json")), "옮겨졌다");
    assert.equal(state_signature(c.env.db), sig, "이동은 lease·행·영수증을 바꾸지 않는다");
  }));

// ---------------------------------------------------------------------------
// R2 · 단계 미지정 artifact 는 단계 봉인에 들어가지 않는다

test("R2 단계 미지정(stage_id NULL) topic 만 있고 기획 단계 항목이 없으면 render 는 그것을 봉인하지 않는다", () =>
  with_cli(async (c) => {
    // CLI merge 는 항상 stage_id 를 채운다 — 공개 코어 함수로 단계 미지정 artifact 를 직접 만든다.
    const obj = (await create_object(c.env.service, c.env.ctx("r2-o"), { kind: "artifact", edition_id: c.env.p.edition_id })).result as { object_id: string };
    await add_artifact(c.env.service, c.env.ctx("r2-v"), {
      object_id: obj.object_id,
      artifact_kind: "topic",
      title: "단계 미지정 항목",
      summary: "판 수준",
    });
    const unset = c.env.db.get<{ stage_id: string | null }>("SELECT stage_id FROM artifacts WHERE object_id = ?", obj.object_id);
    assert.equal(unset?.stage_id, null, "준비: stage_id 가 NULL 인 artifact");
    ok(c.run(["round-start", SLUG, "plan"]), "round-start");
    const res = c.run(["render", SLUG, "plan"]);
    no_crash(res, "render");
    const leaked = c.env.db.get<{ n: bigint }>(
      `SELECT count(*) AS n FROM round_contents rc JOIN artifacts a ON a.project_id = rc.project_id AND a.object_id = rc.object_id
        WHERE a.stage_id IS NULL`,
    );
    assert.equal(leaked?.n, 0n, `단계 미지정 항목이 봉인 manifest 에 들어갔다 (render 종료 ${res.status}: ${res.stdout})`);
    if (res.status === 0) {
      const sealed = c.env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM round_contents");
      assert.equal(sealed?.n, 0n, "성공했다면 빈 봉인이어야 한다 (v0.15 처럼 단계 항목만)");
    }
  }));

test("R2 단계 미지정 artifact 가 있어도 기획 단계 항목이 있으면 봉인은 그 항목만 담는다", () =>
  with_cli(async (c) => {
    const obj = (await create_object(c.env.service, c.env.ctx("r2b-o"), { kind: "artifact", edition_id: c.env.p.edition_id })).result as { object_id: string };
    await add_artifact(c.env.service, c.env.ctx("r2b-v"), { object_id: obj.object_id, artifact_kind: "topic", title: "단계 미지정", summary: "x" });
    ok(c.run(["round-start", SLUG, "plan"]), "round-start");
    ok(c.run(["merge", SLUG, "plan", write_json(c, "r2b.json", [{ id: 1, kind: "topic", title: "기획 항목", summary: "x" }])]), "merge");
    const rendered = ok(c.run(["render", SLUG, "plan"]), "render");
    // (pes.ts 의 render 출력은 0.15 처럼 대시보드 경로뿐이다 — 봉인 항목 수는 아래 DB 행이 지킨다)
    assert.match(rendered.stdout, /index\.html/, rendered.stdout);
    const rows = c.env.db.all<{ stage_id: string | null }>(
      `SELECT a.stage_id AS stage_id FROM round_contents rc JOIN artifacts a ON a.project_id = rc.project_id AND a.object_id = rc.object_id`,
    );
    assert.deepEqual(rows.map((r) => r.stage_id), [c.stages.plan]);
  }));
