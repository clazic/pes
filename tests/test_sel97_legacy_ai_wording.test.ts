/**
 * SEL-97 (tester, 작성 모드) — 기존 화면(대시보드·ask 폼·허브 등)의 AI 연결 문구를 새 앱(app/src/components/pes/status-registry.ts)과 맞춘다.
 * 합성 DB · 임시 HOME 뿐.
 *
 * 정한 인터페이스:
 *   - 대시보드 페이지 데이터(`#data` JSON)에 `ai_connection: { policy }` 가 실린다. policy 는 작업 공간 읽기(GET P/workspace)와 같은 기계 값
 *     (allowed | denied | missing | corrupt). 서버가 모르면 칸이 없고 화면은 "알 수 없음"으로 보인다.
 *   - 화면 낱말은 새 앱 status-registry 의 ai 사전 그대로: 켜짐 · 차단 중 · 변경 중 · 알 수 없음. 낱말 'Go' 는 화면 글자에 없다("AI 연결"·"API").
 *   - 서버가 안 보내는 칸(policy=pending · cancel_state · external_stop · run_permissions)을 페이지 데이터·화면 글자에 지어내지 않는다.
 * 스스로 정한 해석:
 *   - 'Go 낱말 없음'은 화면에 나오는 글자(HTML·JS 주석 제외)에 대한 것이다. 코드 안 식별자·DB 값(opencode-go)은 대상이 아니다.
 *   - 화면에 다는 곳은 대시보드이고, ask 폼·허브·보고서 템플릿은 'Go' 낱말만 없으면 된다.
 *   - 실제 브라우저에서 보이는 모양은 tests/e2e/sel97_legacy_ai_wording.spec.ts 가 본다.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { SLUG } from "./helpers/cli_write_env.ts";
import { db_with_form, http, page_data, REPO, with_server } from "./helpers/web_env.ts";

const TPL = join(REPO, "templates");
const FILES = ["dashboard.html", "hub.html", "ask.html", "_questions.html", "stage-report.html", "final-report.html", "eli5.html", "db/overlay-dashboard.html", "db/overlay-ask.html"];

// 화면에 나오는 글자만: HTML 주석, 블록 주석, 줄 주석(주소의 :// 는 남김)을 뗀다.
function visible_source(file: string): string {
  return readFileSync(join(TPL, file), "utf8")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

const registry = readFileSync(join(REPO, "app", "src", "components", "pes", "status-registry.ts"), "utf8");
const ai_block = registry.match(/\n  ai: \{([\s\S]*?)\n  \},/)![1]!;
const LABEL = (key: string): string => ai_block.match(new RegExp(`${key}: d\\("([^"]+)"`))![1]!;

test("registry: 새 앱의 AI 연결 낱말 (기준값이 바뀌면 이 시험이 먼저 알린다)", () => {
  assert.deepEqual([LABEL("on"), LABEL("blocked"), LABEL("changing"), LABEL("unknown")], ["켜짐", "차단 중", "변경 중", "알 수 없음"]);
});

for (const file of FILES) {
  test(`${file}: 화면 글자에 낱말 'Go' 가 없다`, () => {
    assert.doesNotMatch(visible_source(file), /\bGo\b/, `${file} 에 'Go' 낱말이 남아 있다 — 'AI 연결'·'API' 로`);
  });
}

test("overlay-dashboard: AI 연결 줄이 새 앱과 같은 상태 이름을 쓴다", () => {
  const src = visible_source("db/overlay-dashboard.html");
  assert.match(src, /AI 연결/);
  for (const key of ["on", "blocked", "unknown"]) assert.ok(src.includes(LABEL(key)), `'${LABEL(key)}' 가 화면 낱말에 있어야 한다`);
});

test("overlay-dashboard: 서버가 안 보내는 칸을 지어내지 않는다", () => {
  const src = visible_source("db/overlay-dashboard.html");
  assert.doesNotMatch(src, /cancel_state|external_stop|run_permissions/);
  assert.doesNotMatch(src, /취소 시도|외부 앱/);
});

test("대시보드 페이지 데이터: ai_connection.policy 는 작업 공간 읽기와 같은 기계 값이고, 안 보내는 칸은 없다", async () => {
  const c = await db_with_form();
  try {
    await with_server(c, {}, async (s) => {
      const res = await http(s, `/${SLUG}/`);
      assert.equal(res.status, 200);
      const data = page_data(res.text);
      assert.ok(data.ai_connection, "페이지 데이터에 ai_connection 이 있다");
      assert.ok(["allowed", "denied", "missing", "corrupt"].includes(data.ai_connection.policy), `policy=${data.ai_connection.policy}`);
      assert.equal(data.ai_connection.policy, "allowed", "초기 정책은 허용");
      assert.notEqual(data.ai_connection.policy, "pending", "변경 중은 서버가 보내지 않는다");
      const text = JSON.stringify(data);
      assert.doesNotMatch(text, /cancel_state|external_stop|run_permissions/);
    });
  } finally {
    c.close();
  }
});
