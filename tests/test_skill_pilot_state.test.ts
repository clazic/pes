/**
 * SEL-50 PR17 r1-1 권장 4 — 파일럿이 "명령은 성공하는데 상태가 옛 직접 편집과 다른" 경우를 잡는다 (tester, 작성 모드 회귀).
 *
 * test_skill_pilot_run 은 문서가 말한 명령 열이 성공하는지만 본다. 필수 1~5 는 모두 명령은 성공하지만 상태가 달라지는 종류였다.
 * 이 시험은 core·plan·research 문서의 기획 한 바퀴(참고자료 가져오기 → 라운드 → 병합(request·reuse·model·user_links) → 변경점 읽고 다시 쓰기 →
 * 설정 → 독립 검토 → 승인)를 같은 합성 프로젝트에 돌리고 **남은 상태**를 단언한다.
 *
 * 해석 R7: 플래그 없음(v0.15)은 전체 열. PES_DB_CORE=1 은 `set`(설정·변경점)이 코어에 없어 분명히 거부되므로(8.14) 그 두 단계를 뺀 열 — 병합 상태 보존과
 *         approve plan 의 참고자료 재사용은 두 모드에서 같다. 개별 계약은 test_state_merge_request·test_state_merge_reuse·test_state_settings_changes.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { make_library_source, ok, with_mode, type Mode } from "./helpers/state_modes.ts";

const SLUG = "pilot-state";
const U1 = "https://pilot-user.example.test/page";
const SETTINGS = { stage_reports: ["docx", "md"], audience: "합성 독자" };
const QA = { verdict: "pass", summary: "합성 검토", qc: [], qa: [], spot_checks: [], missed_by_self_review: [], evidence_gaps: [] };

async function drive(m: Mode): Promise<void> {
  const lib = make_library_source(m, "pilot-lib");
  ok(m.py(["init", SLUG, "--topic", "합성 파일럿 상태 주제", "--import", lib]), "init --import");
  ok(m.py(["round-start", SLUG, "plan"]), "round-start");

  // 1) 기획 항목: rq + 재사용 topic(model·user_links 포함) + 새 topic
  ok(
    m.py([
      "merge",
      SLUG,
      "plan",
      m.json("items.json", [
        { id: 1, kind: "rq", title: "연구 질문", summary: "왜 필요한가", status: "done" },
        { id: 2, kind: "topic", title: "재사용 주제", question: "기존 조사를 보완", reuse: 1, model: "opus", user_links: [{ url: U1, memo: "사용자 제공" }], links: { plan: [1] } },
        { id: 3, kind: "topic", title: "새 주제", question: "새로 조사", links: { plan: [1] } },
      ]),
    ]),
    "merge 기획 항목",
  );
  // 2) 사용자의 '심화' 지시 = status + request 만 있는 제안 (depth 불변)
  const d_before = JSON.parse(ok(m.py(["show", SLUG, "plan", "3", "--fields", "depth"]), "show depth").stdout)[0].depth;
  ok(m.py(["merge", SLUG, "plan", m.json("deepen.json", { id: 3, status: "deepen", request: "3번 더 깊게: 합성 지시문" })]), "merge 심화 지시");
  const three = JSON.parse(ok(m.py(["show", SLUG, "plan", "3", "--fields", "status,request,depth"]), "show 3").stdout)[0];
  assert.deepEqual([three.status, three.request, three.depth], ["deepen", "3번 더 깊게: 합성 지시문", d_before], "심화 지시가 request 로 남고 depth 는 그대로");
  // 상태를 done 으로 돌려 두고(처리했다는 뜻) request 는 비운다
  ok(m.py(["merge", SLUG, "plan", m.json("done.json", { id: 3, status: "done", request: "" })]), "merge 처리 끝");
  assert.equal(JSON.parse(ok(m.py(["show", SLUG, "plan", "3", "--fields", "request,status"]), "show 3 다시").stdout)[0].request, "");

  // 3) 설정·변경점 (플래그 없음에서만): set → 읽기 → 전체 배열 다시 쓰기
  if (m.name === "off") {
    ok(m.py(["set", SLUG, "plan", "settings", m.json("settings.json", SETTINGS)]), "set plan settings");
    ok(m.py(["set", SLUG, "plan", "changes", m.json("c1.json", ["항목: 3개 만듦", "재사용: 1개 표시"])]), "set changes");
    const cur = ok(m.py(["show", SLUG, "plan", "--fields", "changes"]), "show changes").stdout;
    assert.ok(cur.includes("항목: 3개 만듦") && cur.includes("재사용: 1개 표시"), "지금 changes 를 읽을 수 있다");
    ok(m.py(["set", SLUG, "plan", "changes", m.json("c2.json", ["항목: 3개 만듦", "재사용: 1개 표시", "독립 검토 반영: 없음"])]), "전체 배열 다시 쓰기");
    const p = m.state(SLUG); // DB 읽기 모델(옛 project.json 모양) — pes.ts 는 project.json 을 쓰지 않는다
    assert.deepEqual(p.stages.plan.changes, ["항목: 3개 만듦", "재사용: 1개 표시", "독립 검토 반영: 없음"], "앞 줄을 잃지 않았다");
    assert.deepEqual(p.settings, SETTINGS, "최상위 settings (보고서 형식·qa-brief 의 기획 답)");
  }

  // 4) 화면 → 독립 검토 → 승인
  ok(m.py(["render", SLUG, "plan"]), "render");
  const qa = m.json("qa.json", QA);
  if (m.name === "off") {
    const brief = readFileSync(ok(m.py(["qa-brief", SLUG, "plan"]), "qa-brief").stdout.trim(), "utf8").replace(/\r\n/g, "\n");
    assert.match(brief, /- 기획 답\(사용자\): .*audience=합성 독자/, "독립 검토가 기획 답을 읽는다");
    assert.match(brief, /독립 검토 반영: 없음/, "qa-brief 의 변경점");
  } else ok(m.py(["qa-brief", SLUG, "plan"]), "qa-brief");
  ok(m.py(["qa", SLUG, "plan", "--file", qa]), "qa");
  const approved = ok(m.py(["approve", SLUG, "plan"]), "approve plan");
  if (m.name === "off") {
    assert.match(approved.stdout, /조사 항목 2개 생성.*재사용 1개/, "approve plan 이 재사용 1개를 만든다");
    assert.match(approved.stdout, /형식: docx, md/, "사용자가 고른 보고서 형식");
  }

  // 5) 조사 단계에 넘어간 상태
  const items: any[] = JSON.parse(ok(m.py(["show", SLUG, "research", "--fields", "title,status,request,links,summary"]), "show research").stdout);
  assert.equal(items.length, 2, "topic 둘이 조사 항목이 된다");
  const reused = items.find((x) => x.title === "재사용 주제");
  assert.ok(reused, "재사용 항목");
  assert.equal(reused.status, "deepen");
  assert.match(reused.request, /라이브러리 #1/);
  assert.deepEqual(reused.links.library, [1]);
  assert.equal(reused.summary, "기존 조사 요약");
  const fresh = items.find((x) => x.title === "새 주제");
  assert.ok(fresh && (fresh.links?.library ?? []).length === 0, "reuse 없는 topic 은 재사용하지 않는다");

  // 기획 항목 쪽 보존: model·user_links 는 approve 뒤에도 남아 있다
  const t2 = JSON.parse(ok(m.py(["show", SLUG, "plan", "2", "--fields", "reuse,model,user_links"]), "show plan 2").stdout)[0];
  assert.equal(t2.reuse, 1);
  assert.equal(t2.model, "opus");
  assert.equal(t2.user_links[0].url, U1);
}

test("파일럿 상태 보존: 기획 한 바퀴가 request·reuse·model·user_links·settings·changes 를 옛 직접 편집처럼 남긴다 [플래그 없음]", async () => {
  await with_mode("off", drive);
});

test("파일럿 상태 보존: 같은 병합 상태·참고자료 재사용이 DB 경로에서도 남는다 [PES_DB_CORE=1]", async () => {
  await with_mode("on", drive);
});
