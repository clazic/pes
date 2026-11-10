/**
 * SEL-50 PR17 r1-1 필수 2 — `merge` 가 기획 항목의 `reuse`·`model`·`user_links` 를 보존한다 (tester, 작성 모드 회귀).
 *
 * 문서(plan)는 topic 에 `"reuse": <library id>` 를 달게 하고, research 는 `model` 필드·`user_links` 상태 추적을 말한다. 옛 문서는 항목에 직접 썼고
 * 새 문서는 merge 로 넘기므로, merge 가 이 필드를 받지 않으면 `approve plan` 의 참고자료 재사용(handoff_plan)이 조용히 사라진다.
 *
 * 해석 R2 (leader 결정 2)
 *   (가) merge 는 reuse·model 을 제안에 있을 때만 덮어쓴다(없는 제안은 보존). 항목 읽기는 `show … --fields reuse,model,user_links`.
 *   (나) user_links 는 "목록 추가": 새 url 은 뒤에 붙고 기존 줄은 남는다. url 이 같은 줄은 중복을 만들지 않고 주어진 칸(예 status)만 고친다
 *        — 그래야 "병합 후 user_links 의 status 를 done/failed 로" 절차가 목록을 늘리지 않고 상태를 추적한다.
 *   (다) plan → merge(reuse) → approve plan 은 library 재사용 항목을 만든다: research 항목이 library 의 summary·details·sources·confidence 를 받고,
 *        status=deepen, request 에 "라이브러리 #<id>", links.library=[id], links.plan 에 기획 항목 id. reuse 없는 topic 은 재사용하지 않는다.
 *   (라) 플래그 없음(v0.15)과 PES_DB_CORE=1 은 같은 결과다.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { make_library_source, ok, with_mode, type Mode } from "./helpers/state_modes.ts";

const U1 = "https://user1.example.test/page";
const U2 = "https://user2.example.test/doc";

async function open_reuse_project(m: Mode): Promise<string> {
  const slug = "reuse-synth";
  const lib = make_library_source(m);
  ok(m.py(["init", slug, "--topic", "합성 재사용 주제", "--import", lib]), "init --import");
  ok(m.py(["round-start", slug, "plan"]), "round-start plan");
  return slug;
}

async function fields_scenario(m: Mode): Promise<void> {
  const slug = await open_reuse_project(m);
  const show = (id: number, f: string) => {
    const res = ok(m.py(["show", slug, "plan", String(id), "--fields", f]), `show plan ${id}`);
    return JSON.parse(res.stdout)[0];
  };
  ok(
    m.py(["merge", slug, "plan", m.json("t1.json", { id: 2, kind: "topic", title: "재사용 주제 T", question: "무엇을 조사하나", reuse: 1, model: "opus", user_links: [{ url: U1, memo: "첫 링크" }] })]),
    "merge reuse·model·user_links",
  );
  const a = show(2, "reuse,model,user_links,question");
  assert.equal(a.reuse, 1, "reuse 가 남는다");
  assert.equal(a.model, "opus", "model 이 남는다");
  assert.equal(a.question, "무엇을 조사하나");
  assert.equal(a.user_links.length, 1);
  assert.equal(a.user_links[0].url, U1);
  assert.equal(a.user_links[0].memo, "첫 링크");

  // reuse·model 이 없는 제안(요약만)은 보존한다
  ok(m.py(["merge", slug, "plan", m.json("t2.json", { id: 2, summary: "요약만 고침" })]), "merge 요약만");
  const b = show(2, "reuse,model,user_links,summary");
  assert.equal(b.reuse, 1, "reuse 없는 제안은 reuse 를 지우지 않는다");
  assert.equal(b.model, "opus", "model 없는 제안은 model 을 지우지 않는다");
  assert.equal(b.summary, "요약만 고침");
  assert.equal(b.user_links.length, 1, "user_links 없는 제안은 목록을 지우지 않는다");

  // user_links 는 목록 추가
  ok(m.py(["merge", slug, "plan", m.json("t3.json", { id: 2, user_links: [{ url: U2, memo: "둘째" }] })]), "merge user_links 추가");
  const c = show(2, "user_links");
  assert.deepEqual(c.user_links.map((x: any) => x.url), [U1, U2], "새 링크는 뒤에 붙고 기존 줄은 남는다");

  // 같은 url + status: 중복 없이 그 줄의 상태가 바뀐다 (상태 추적 절차)
  ok(m.py(["merge", slug, "plan", m.json("t4.json", { id: 2, user_links: [{ url: U1, status: "done" }] })]), "merge user_links 상태");
  const d = show(2, "user_links,depth");
  assert.equal(d.user_links.length, 2, "같은 url 은 줄을 늘리지 않는다");
  const u1 = d.user_links.find((x: any) => x.url === U1);
  assert.equal(u1.status, "done", "병합 후 user_links 의 status 를 done 으로 추적한다");
  assert.equal(u1.memo, "첫 링크", "상태만 준 제안은 메모를 지우지 않는다");
  ok(m.py(["merge", slug, "plan", m.json("t5.json", { id: 2, user_links: [{ url: U2, status: "failed" }] })]), "merge user_links failed");
  const e = show(2, "user_links");
  assert.equal(e.user_links.find((x: any) => x.url === U2).status, "failed");
  assert.equal(e.user_links.find((x: any) => x.url === U1).status, "done", "다른 줄의 상태는 그대로");
}

async function reuse_scenario(m: Mode): Promise<void> {
  const slug = await open_reuse_project(m);
  // 기획: rq 하나 + 재사용 topic 하나 + 재사용 없는 topic 하나
  ok(
    m.py([
      "merge",
      slug,
      "plan",
      m.json("plan.json", [
        { id: 1, kind: "rq", title: "연구 질문", summary: "왜", status: "done" },
        { id: 2, kind: "topic", title: "재사용 주제 T", question: "기존 조사를 보완", reuse: 1, links: { plan: [1] } },
        { id: 3, kind: "topic", title: "새 주제 N", question: "새로 조사", links: { plan: [1] } },
      ]),
    ]),
    "merge 기획 항목",
  );
  ok(m.py(["render", slug, "plan"]), "render");
  const approved = ok(m.py(["approve", slug, "plan"]), "approve plan");
  if (m.name === "off") assert.match(approved.stdout, /조사 항목 2개 생성.*재사용 1개/, "approve 가 재사용 1개를 알린다");

  const res = ok(m.py(["show", slug, "research", "--fields", "title,kind,status,request,links,summary,details,sources,confidence"]), "show research");
  const items: any[] = JSON.parse(res.stdout);
  assert.equal(items.length, 2, `research 항목 2개 (실제: ${items.map((x) => x.title).join(",")})`);
  const reused = items.find((x) => x.title === "재사용 주제 T");
  const fresh = items.find((x) => x.title === "새 주제 N");
  assert.ok(reused && fresh, "두 항목이 모두 만들어진다");

  assert.equal(reused.status, "deepen", "재사용 항목은 보완(deepen) 상태");
  assert.match(reused.request, /라이브러리 #1/, "request 에 재사용한 library id");
  assert.deepEqual(reused.links.library, [1], "links.library");
  assert.ok(reused.links.plan.includes(2), "links.plan 에 기획 항목 id");
  assert.equal(reused.summary, "기존 조사 요약", "library 요약을 복사");
  assert.equal(reused.details, "기존 조사 본문", "library 본문을 복사");
  assert.equal(reused.confidence, "중간");
  assert.equal(reused.sources.length, 1, "library 출처를 복사");
  assert.equal(reused.sources[0].url, "https://lib.example.test/a");

  assert.notEqual(fresh.status, "deepen", "reuse 없는 topic 은 재사용하지 않는다");
  assert.equal(fresh.summary ?? "", "", "reuse 없는 topic 은 library 내용이 없다");
  assert.equal((fresh.links?.library ?? []).length, 0);
}

test("merge: reuse·model 보존, user_links 목록 추가와 url 별 상태 추적 [플래그 없음]", async () => {
  await with_mode("off", fields_scenario);
});

test("merge: reuse·model 보존, user_links 목록 추가와 url 별 상태 추적 [PES_DB_CORE=1]", async () => {
  await with_mode("on", fields_scenario);
});

test("plan → merge(reuse) → approve plan 이 library 재사용 항목을 만든다 [플래그 없음]", async () => {
  await with_mode("off", reuse_scenario);
});

test("plan → merge(reuse) → approve plan 이 library 재사용 항목을 만든다 [PES_DB_CORE=1]", async () => {
  await with_mode("on", reuse_scenario);
});

test("플래그 없음: reuse·model·user_links 는 항목에 옛 직접 편집과 같은 모양(값 그대로, user_links 는 객체 배열)으로 남는다", async () => {
  await with_mode("off", async (m) => {
    const slug = await open_reuse_project(m);
    ok(m.py(["merge", slug, "plan", m.json("t.json", { id: 7, kind: "topic", title: "T7", question: "q", reuse: 1, model: "sonnet", user_links: [{ url: U1, memo: "m" }] })]), "merge");
    const res = ok(m.py(["show", slug, "plan", "7"]), "show plan 7 전체");
    const it = JSON.parse(res.stdout)[0];
    assert.equal(it.reuse, 1);
    assert.equal(it.model, "sonnet");
    assert.ok(Array.isArray(it.user_links) && it.user_links[0].url === U1 && it.user_links[0].memo === "m", "user_links 는 객체 배열");
  });
});
