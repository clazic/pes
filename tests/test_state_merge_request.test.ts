/**
 * SEL-50 PR17 r1-1 필수 1 — `merge` 가 `request` 를 저장한다 (tester, 작성 모드 회귀).
 *
 * 문서(core·research·verify)는 "항목의 status·request 를 제안 파일에 담아 merge" 라고 지시한다("N번 심화/수정: …", 사용자 제공 링크, verify 의 이유).
 * 옛 직접 편집은 request 를 썼다. 그러므로 merge 는 request 를 받아야 한다.
 *
 * 해석 R1 (leader 결정 1)
 *   (가) request 는 제안에 있을 때만 덮어쓴다 — request 가 없는 제안(요약만 고치는 병합 등)은 기존 request 를 지우지 않는다.
 *   (나) request 를 빈 문자열("")로 주면 비운다(None·null 은 "없음"이라 건드리지 않는다).
 *   (다) status·request(·id·user_links) 만 있는 제안은 depth·updated_round 를 올리지 않는다. 내용(summary 등)이 함께 있으면 올린다.
 *   (라) 상태만 바꾸는 제안의 status 는 주어진 값으로 바뀌고, status 를 생략하면 그대로다(내용 병합은 생략 시 done).
 *   (마) 플래그 없음(v0.15)과 PES_DB_CORE=1 은 같은 결과다. 항목 읽기는 `show <dir> <단계> <id> --fields …`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { item_fields, ok, with_mode, type Mode } from "./helpers/state_modes.ts";

const REQ = "더 깊게: 합성 지시문 사본 (원문 확인 포함)";

async function scenario(m: Mode): Promise<void> {
  ok(m.py(["round-start", m.slug, "plan"]), "round-start");
  ok(m.py(["merge", m.slug, "plan", m.json("p1.json", { id: 1, title: "RQ1", kind: "rq", status: "new" })]), "merge 새 항목");
  const first = item_fields(m, "plan", 1, "status,request,depth,updated_round,summary");
  assert.equal(first.status, "new");
  assert.equal(first.request, "", "처음 request 는 비어 있다");
  const depth0 = first.depth as number;
  assert.ok(depth0 >= 1, "내용 병합은 depth 를 올린다");

  // (본문) 필수 1 재현: status + request 만 있는 제안
  ok(m.py(["merge", m.slug, "plan", m.json("p2.json", { id: 1, status: "deepen", request: REQ })]), "merge status+request");
  const after = item_fields(m, "plan", 1, "status,request,depth,updated_round");
  assert.equal(after.status, "deepen");
  assert.equal(after.request, REQ, "request 가 저장돼야 한다 (버려지면 다음 라운드 조사원 지시가 비어 있다)");
  assert.equal(after.depth, depth0, "status·request 만 있는 제안은 depth 를 올리지 않는다");
  assert.equal(after.updated_round, first.updated_round, "updated_round 도 그대로");

  // (가) request 없는 제안은 기존 request 를 지우지 않는다. 내용이 있으니 depth 가 오르고 status 는 생략 시 done.
  ok(m.py(["merge", m.slug, "plan", m.json("p3.json", { id: 1, summary: "새 요약" })]), "merge 내용만");
  const kept = item_fields(m, "plan", 1, "status,request,depth,summary");
  assert.equal(kept.request, REQ, "request 가 없는 제안은 request 를 그대로 둔다");
  assert.equal(kept.summary, "새 요약");
  assert.equal(kept.status, "done");
  assert.equal(kept.depth, depth0 + 1, "내용 병합은 depth 를 올린다");

  // (다) request 만 바꿈 → depth 불변, status 불변
  ok(m.py(["merge", m.slug, "plan", m.json("p4.json", { id: 1, request: "수정: 다른 지시" })]), "merge request 만");
  const only = item_fields(m, "plan", 1, "status,request,depth,summary");
  assert.equal(only.request, "수정: 다른 지시");
  assert.equal(only.depth, kept.depth, "request 만 있는 제안은 depth 를 올리지 않는다");
  assert.equal(only.status, "done", "status 를 생략한 상태·요청 제안은 status 를 그대로 둔다");
  assert.equal(only.summary, "새 요약", "다른 필드는 그대로");

  // (나) 빈 문자열로 비운다
  ok(m.py(["merge", m.slug, "plan", m.json("p5.json", { id: 1, request: "" })]), "merge request 비움");
  const cleared = item_fields(m, "plan", 1, "status,request,depth");
  assert.equal(cleared.request, "", "빈 문자열은 request 를 비운다");
  assert.equal(cleared.depth, only.depth, "비우기도 depth 를 올리지 않는다");

  // 내용 + request 를 함께: 둘 다 저장, depth 는 오른다
  ok(m.py(["merge", m.slug, "plan", m.json("p6.json", { id: 1, summary: "또 새 요약", request: "함께 온 지시" })]), "merge 내용+request");
  const both = item_fields(m, "plan", 1, "request,depth,summary");
  assert.equal(both.request, "함께 온 지시");
  assert.equal(both.summary, "또 새 요약");
  assert.equal(both.depth, cleared.depth + 1);

  // 여러 항목을 한 파일로: 항목별로 따로 적용된다
  ok(m.py(["merge", m.slug, "plan", m.json("p7.json", [{ id: 2, title: "RQ2", kind: "rq" }, { id: 3, title: "RQ3", kind: "rq", status: "done" }])]), "merge 두 항목");
  ok(
    m.py(["merge", m.slug, "plan", m.json("p8.json", [{ id: 2, status: "revise", request: "2번만 고침" }, { id: 3, request: "3번 요청" }])]),
    "merge 두 제안",
  );
  const two = item_fields(m, "plan", 2, "status,request,depth");
  const three = item_fields(m, "plan", 3, "status,request,depth");
  assert.deepEqual([two.status, two.request], ["revise", "2번만 고침"]);
  assert.deepEqual([three.status, three.request], ["done", "3번 요청"]);
  assert.equal(two.depth, 1, "새로 만든 항목의 depth 는 상태 지시로 오르지 않는다");
  assert.equal(three.depth, 1);
}

test("merge 가 request 를 저장한다 — 있을 때만 덮어쓰고, 빈 문자열로 비우고, 상태·요청만 있는 제안은 depth 를 올리지 않는다 [플래그 없음]", async () => {
  await with_mode("off", scenario);
});

test("merge 가 request 를 저장한다 — 같은 결과 [PES_DB_CORE=1]", async () => {
  await with_mode("on", scenario);
});

test("플래그 없음: request 는 project.json 의 항목에 그대로 남고 다른 항목·단계는 변하지 않는다", async () => {
  await with_mode("off", async (m) => {
    ok(m.py(["round-start", m.slug, "plan"]), "round-start");
    ok(m.py(["merge", m.slug, "plan", m.json("a.json", [{ id: 1, title: "A", kind: "rq" }, { id: 2, title: "B", kind: "rq" }])]), "merge");
    const before = m.state();
    ok(m.py(["merge", m.slug, "plan", m.json("b.json", { id: 1, status: "deepen", request: REQ })]), "request merge");
    const after = m.state();
    const a = after.stages.plan.items.find((x: any) => x.id === 1);
    assert.equal(a.request, REQ);
    assert.equal(a.status, "deepen");
    // 항목 2·다른 단계·최상위 키는 그대로
    assert.deepEqual(after.stages.plan.items.find((x: any) => x.id === 2), before.stages.plan.items.find((x: any) => x.id === 2));
    assert.deepEqual(after.stages.research, before.stages.research);
    assert.deepEqual(after.settings, before.settings);
    assert.deepEqual(after.notes, before.notes);
  });
});
