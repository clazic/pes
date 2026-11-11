/**
 * SEL-51 PR18 — 1차 리뷰(r1-1) 회귀 시험 (tester, 보강 모드). 구현 전에는 실패하는 것이 정상이다.
 *   R1 필수1  답 POST·쓰기 명령 뒤 /<slug>/index.html 과 /index.html 이 /<slug>/ · / 와 같은 최신 DB 화면이다(낡은 정적 파일이 아니다).
 *   R2 권장1  받은 답 원문을 읽는 CLI 명령(이름·형식은 구현이 정한다 — 후보 이름을 시험이 차례로 시도하는 '해석'): 두 모드에서 같은 명령,
 *             DB 모드의 pending 출력과 feedback.log 줄이 없는 파일 경로가 아니라 읽을 수 있는 대상을 가리키고, 그 명령으로 답 전문(여러 줄·answers)을 얻는다.
 *   R3 권장3  input.chat_recorded 사건·영수증이 일반(pes chat)·web(화면 답) 두 경로에서 공통 필드(stage·round_no·kind)를 갖고 web 표지가 있다.
 * (필수2·권장2 는 브라우저 시험: tests/e2e/workspace_hardening.spec.ts)
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { make_cli_env, SLUG } from "./helpers/cli_write_env.ts";
import { plain_legacy, read_lf, run_cli, write_json, write_legacy } from "./helpers/cli_read_env.ts";
import { db_with_form, feedback_body, http, normalize_data, page_data, post_feedback, step, with_server } from "./helpers/web_env.ts";
import { raw } from "./helpers/web_raw.ts";

const MARK = "STALE-PROBE-마커";

// R1 필수1 (/<slug>/index.html·/index.html 을 요청 때 DB 에서 짓는다: 답·쓰기 명령 뒤 즉시 반영) — 지웠다: PR18 의 DB 서버 기능이다.
// scripts/serve.ts 는 render 가 짓는 정적 index.html 을 서빙한다('DB-built dashboard and hub pages' 는 serve.ts 머리말에서 SEL-77 이후로 미룸).
// 쓰기 뒤 화면이 바뀌려면 render 가 필요하다 — 이 흐름은 test_web_screens W2f·W6 과 test_serve_ts_cases 가 지킨다. (처리표 '서버 갭')

// ---------------------------------------------------------------------------
// R2 받은 답 읽기

const ANSWER_TEXT = "[단계 시작 질문 · 기획]\n둘째 줄 MARK-LINE2\n셋째 줄";
const ANSWER_ANS = { scope: "wide", memo: "메모 MARK-ANS", "why-wide": "이유 MARK-WHY" };
// 구현이 정한다: 아래 후보 중 처음으로 답 전문을 내는 것을 '읽기 명령'으로 본다. 두 모드에서 같은 후보여야 한다.
const READERS: Array<[string, (slug: string, name: string) => string[]]> = [
  ["answer <slug> <이름>", (slug, name) => ["answer", slug, name]],
  ["answers <slug> <이름>", (slug, name) => ["answers", slug, name]],
  ["show-answer <slug> <이름>", (slug, name) => ["show-answer", slug, name]],
  ["read-answer <slug> <이름>", (slug, name) => ["read-answer", slug, name]],
  ["feedback <slug> <이름>", (slug, name) => ["feedback", slug, name]],
  ["pending <slug> --show", (slug) => ["pending", slug, "--show"]],
  ["pending <slug> --full", (slug) => ["pending", slug, "--full"]],
  ["pending <slug> --cat", (slug) => ["pending", slug, "--cat"]],
];

function reader_finds_full(c: Parameters<typeof run_cli>[0], name: string): string | null {
  for (const [label, args] of READERS) {
    const res = run_cli(c, args(SLUG, name));
    if (res.status !== 0) continue;
    const out = res.stdout.replace(/\r\n/g, "\n");
    if (out.includes("MARK-LINE2") && out.includes("MARK-ANS") && out.includes("MARK-WHY") && out.includes("셋째 줄")) return label;
  }
  return null;
}

/** pending 출력·알림 줄이 가리키는 대상: 존재하는 파일이거나, 읽기 명령이 받는 이름(디렉터리 없는 한 토큰)이어야 한다. */
function assert_readable_target(target: string, c: Parameters<typeof run_cli>[0], label: string, what: string): void {
  if (existsSync(target)) {
    const doc = readFileSync(target, "utf8");
    assert.ok(doc.includes("MARK-LINE2") && doc.includes("MARK-ANS"), `${what}: 가리키는 파일에 답 전문이 있다`);
    return;
  }
  assert.ok(!/[\\/]/.test(target), `${what}: 존재하지 않는 파일 경로를 가리킨다 (${target.slice(-60)}) — 읽을 수 있는 대상(파일 또는 읽기 명령이 받는 이름)이어야 한다`);
  assert.notEqual(reader_finds_full(c, target), null, `${what}: 이름 ${target} 을 읽기 명령(${label})이 받아 전문을 내야 한다`);
}

test("R2 권장1 받은 답 원문 읽기: 두 모드 같은 명령, DB 모드의 pending·feedback.log 가 읽을 수 있는 대상을 가리키고 전문(여러 줄·answers)을 얻는다", async () => {
  const db = await db_with_form();
  try {
    // (0.15 로 같은 답을 받아 읽어 보는 비교 — 'v0.15 모드: 읽기 명령이 있고 전문을 낸다' — 는 지웠다: 0.15 서버가 없다. 그 명령 이름들은 아래 READERS 표다.)

    const db_name = await with_server(db, {}, async (s) => {
      const r = await post_feedback(s, SLUG, feedback_body({ text: ANSWER_TEXT, answers: ANSWER_ANS }));
      assert.equal(r.status, 200, r.text);
      return r.json.file as string;
    });
    const db_label = reader_finds_full(db, db_name);
    assert.notEqual(db_label, null, "DB 모드: 같은 읽기 명령이 답 전문(여러 줄·answers)을 낸다 — feedback/ 파일이 없어도");

    const pending = step(db, ["pending", SLUG]).replace(/\r\n/g, "\n").split("\n").map((x) => x.trim()).filter(Boolean);
    const mine = pending.find((x) => x.endsWith(db_name));
    assert.ok(mine !== undefined, "pending 에 그 답이 있다");
    assert_readable_target(mine!, db, db_label!, "pending 출력");
    const log = read_lf(join(db.folder, "feedback.log")).trim().split("\n").filter(Boolean).pop()!;
    const target = log.split(" ").slice(4).join(" ");
    assert_readable_target(target, db, db_label!, "feedback.log 줄");
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// R3 사건 모양

test("R3 권장3 input.chat_recorded: 일반(pes chat)·web(화면 답) 두 경로의 영수증·사건이 공통 필드(stage·round_no·kind)를 갖고 web 표지가 있다", async () => {
  const c = await db_with_form();
  try {
    step(c, ["chat", SLUG, "plan", "합성 일반 채팅", "feedback"]);
    await with_server(c, {}, async (s) => {
      const r = await post_feedback(s, SLUG, feedback_body({ text: "합성 화면 답", answers: { memo: "화면" } }));
      assert.equal(r.status, 200, r.text);
    });
    const commits = c.env.db.all<{ via: string; result_json: string; id: string }>("SELECT via, result_json, id FROM mutation_commits WHERE action = 'input.chat_recorded' ORDER BY rowid");
    assert.ok(commits.length >= 2, `두 경로의 영수증이 있다 (${commits.length})`);
    const general = commits.find((x) => x.via === "cli");
    const web = commits.find((x) => x.via === "web");
    assert.ok(general !== undefined && web !== undefined, `일반(cli)·web 영수증: ${commits.map((x) => x.via).join(",")}`);
    const events_of = (tx: string): Array<Record<string, unknown>> =>
      c.env.db.all<{ payload: string }>("SELECT payload FROM events WHERE tx_id = ? AND type = 'input.chat_recorded' ORDER BY tx_index", tx).map((e) => JSON.parse(e.payload));
    for (const [name, commit] of [["일반", general!], ["web", web!]] as const) {
      const result = JSON.parse(commit.result_json) as Record<string, unknown>;
      assert.ok("round_no" in result && "kind" in result, `${name} 영수증: round_no·kind (${Object.keys(result).join(",")})`);
      assert.ok("stage" in result || "stage_id" in result, `${name} 영수증: stage`);
      const events = events_of(commit.id);
      assert.equal(events.length, 1, `${name}: 사건 하나`);
      for (const key of ["stage", "round_no", "kind"]) assert.ok(key in events[0]!, `${name} 사건 payload 에 ${key} 가 있다 (${Object.keys(events[0]!).join(",")})`);
    }
    const marked = (commit: { result_json: string; id: string }): boolean => JSON.parse(commit.result_json).web === true || events_of(commit.id)[0]!.web === true;
    assert.equal(marked(web!), true, "web 경로는 web: true 표지가 영수증 또는 사건에 있다");
    assert.equal(marked(general!), false, "일반 경로에는 web 표지가 없다");
  } finally {
    c.close();
  }
});
