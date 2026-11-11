/**
 * SEL-51 PR18 — 화면 서버: 답·원격 Origin·CSRF·세션·버전·알림 (tester, 작성 모드). 구현 전이므로 새 시험은 실패하는 것이 정상이다.
 * 해석 번호는 tests/test_web_parity.test.ts 머리말과 같다. 시험 방식·하니스는 tests/helpers/web_env.ts.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { make_cli_env, SLUG, type CliEnv } from "./helpers/cli_write_env.ts";
import { tree_digest } from "./helpers/legacy_env.ts";
import { folder_of, normalize, plain_legacy, read_lf, run_cli, seed, write_legacy, write_json, ok } from "./helpers/cli_read_env.ts";
import {
  ASK_SPEC,
  build_db,
  commit_count,
  db_with_form,
  expect_same_screen,
  feedback_body,
  feedback_files,
  http,
  normalize_data,
  page_data,
  pages,
  pending_names,
  post_feedback,
  REPO,
  rm_default_json,
  roots_of,
  SESSION_SECRET,
  start_server,
  step,
  sub_count,
  with_server,
  write_spec,
} from "./helpers/web_env.ts";


test("W3a POST /<slug>/feedback(DB): 한 번의 사람 제출로 DB 에만 쓰고, 응답 file 이 pending 이름이다 — 이중 쓰기 0 (해석 4·5)", async () => {
  const c = await db_with_form();
  try {
    await with_server(c, {}, async (s) => {
      const commits = commit_count(c);
      const subs = sub_count(c);
      const res = await post_feedback(s, SLUG, feedback_body());
      assert.equal(res.status, 200, res.text);
      assert.equal(res.json.ok, true);
      assert.equal(typeof res.json.file, "string", "v0.15 와 같은 응답 모양: file");
      assert.equal(commit_count(c) - commits, 1, "CommandService 제출 정확히 한 번");
      const made = c.commits().slice(commits)[0]!;
      // 영수증 action 은 명령 이름이 아니라 사건 이름이다(answer.submit → answer.submitted, input.record_chat → input.chat_recorded).
      assert.ok(["answer.submitted", "input.chat_recorded"].includes(made.action), `제출 영수증: ${made.action}`);
      assert.equal(sub_count(c) - subs, 1, "시작 질문 답은 제출(submission) 한 건");
      assert.deepEqual(feedback_files(c), [], "feedback/*.json 을 쓰지 않는다");
      assert.ok(!existsSync(c.project_json), "project.json 을 만들거나 쓰지 않는다");
      assert.deepEqual(pending_names(c), [res.json.file], "pes.py pending 의 이름 = 응답의 file");
      const lines = read_lf(join(c.folder, "feedback.log")).trim().split("\n").filter(Boolean);
      assert.equal(lines.length, 1, "pes watch 가 보는 알림 줄이 한 줄 늘었다");
      assert.match(lines[0]!, /^FEEDBACK plan R0 stage_start /);
      assert.equal(lines[0]!.split(" ").slice(4).join(" ").split(/[\\/]/).pop(), res.json.file, "알림 줄의 경로 = 처리 대기 이름");
      assert.ok(!lines[0]!.includes("합성 메모"), "알림 줄에 답 내용을 싣지 않는다");
    });
  } finally {
    c.close();
  }
});

test("W3b approve·reopen·feedback·review kind: 각각 처리 대기 한 건, 단계 상태는 그대로 (해석 6)", async () => {
  const c = await db_with_form();
  try {
    await with_server(c, {}, async (s) => {
      const status_before = step(c, ["status", SLUG]);
      let expected = 0;
      for (const kind of ["approve", "reopen", "feedback", "resume"]) {
        const text = kind === "approve" ? "기획 단계 승인" : kind === "reopen" ? "기획 단계 다시 열기\n합성 사유" : `합성 ${kind}`;
        const answers = kind === "approve" ? { approve: true, note: "" } : kind === "reopen" ? { reopen: true, note: "합성 사유" } : {};
        const before = commit_count(c);
        const res = await post_feedback(s, SLUG, { stage: "plan", round: 1, kind, text, answers });
        assert.equal(res.status, 200, `${kind}: ${res.text}`);
        expected += 1;
        assert.equal(commit_count(c) - before, 1, `${kind}: 제출 한 번`);
        assert.equal(pending_names(c).length, expected, `${kind}: 처리 대기 +1`);
      }
      const after = step(c, ["status", SLUG]).replace(/받은 답[^\n]*\n?/g, "");
      assert.equal(after.split("\n")[0], status_before.split("\n")[0], "상태 첫 줄(단계)이 그대로");
      assert.deepEqual(feedback_files(c), []);
    });
  } finally {
    c.close();
  }
});

test("W3c 검증 오류는 v0.15 와 같은 상태·본문이고 DB 에 아무것도 남기지 않는다 (해석 7)", async () => {
  const c = await db_with_form();
  try {
    await with_server(c, {}, async (s) => {
      const before = commit_count(c);
      const expect_no_write = () => assert.equal(commit_count(c), before, "아무 쓰기도 없었다");
      const bad_kind = await post_feedback(s, SLUG, feedback_body({ kind: "bogus" }));
      assert.deepEqual([bad_kind.status, bad_kind.json], [400, { ok: false, error: "kind" }]);
      const empty = await post_feedback(s, SLUG, feedback_body({ text: "", answers: {} }));
      assert.deepEqual([empty.status, empty.json], [400, { ok: false, error: "empty" }]);
      const broken = await post_feedback(s, SLUG, "{not json");
      assert.deepEqual([broken.status, broken.json?.ok], [400, false]);
      const big = await post_feedback(s, SLUG, JSON.stringify({ text: "x".repeat(300 * 1024) }));
      assert.equal(big.status, 413);
      const none = await post_feedback(s, "no-such-project", feedback_body());
      assert.equal(none.status, 404);
      expect_no_write();
      assert.deepEqual(feedback_files(c), []);
    });
  } finally {
    c.close();
  }
});

test("W3d 원격 Origin·CSRF: 허용 안 된 Origin(없음 포함)은 403 + 힌트, 신뢰한 원격 Origin 은 받는다 (해석 7)", async () => {
  const c = await db_with_form();
  try {
    await with_server(c, {}, async (s) => {
      const before = commit_count(c);
      const evil = "http://evil.example";
      const rejected = [
        await post_feedback(s, SLUG, feedback_body(), { origin: evil }),
        await post_feedback(s, SLUG, feedback_body(), { origin: null }),
        await post_feedback(s, SLUG, feedback_body(), { origin: evil, headers: { "Content-Type": "text/plain" } }), // 단순 요청 CSRF
        await post_feedback(s, SLUG, feedback_body(), { origin: `http://127.0.0.1:${s.port + 1}` }), // 다른 포트
      ];
      for (const r of rejected) {
        assert.equal(r.status, 403, r.text);
        assert.equal(r.json.ok, false);
        assert.equal(r.json.error, "origin");
      }
      assert.equal(rejected[0]!.json.hint, `pes remote add ${evil}`);
      assert.equal(commit_count(c), before, "거부된 요청은 DB 에 아무것도 남기지 않는다");
      // (세션 비밀이 있어도 다른 출처의 /api/v1 쓰기는 거부 — 지웠다: scripts/serve.ts 에는 /api/v1 통과 길이 없다. tests/README.md 처리표 '서버 갭')
      // 신뢰한 원격 출처(~/.pes/config.json trusted_origins, 예: Tailscale 주소)
      const remote = "https://pes-box.example.ts.net";
      const config = join(c.env.home.env.HOME as string, ".pes", "config.json");
      mkdirSync(join(config, ".."), { recursive: true });
      writeFileSync(config, JSON.stringify({ trusted_origins: [remote] }), "utf8");
      const accepted = await post_feedback(s, SLUG, feedback_body(), { origin: remote });
      assert.equal(accepted.status, 200, accepted.text);
      assert.equal(commit_count(c) - before, 1, "원격 답도 사람 제출 한 번");
      assert.deepEqual(feedback_files(c), []);
    });
  } finally {
    c.close();
  }
});

test("W3e 소유자 세션 비밀은 어떤 정적 응답에도 실리지 않는다 (해석 10)", async () => {
  const c = await db_with_form();
  try {
    step(c, ["report", SLUG, "plan"]);
    await with_server(c, {}, async (s) => {
      for (const path of ["/", `/${SLUG}/`, `/${SLUG}/index.html`, `/${SLUG}/ask-plan-start.html`, `/${SLUG}/version`, "/whoami", "/ping", `/${SLUG}/reports/plan/report.html`]) {
        const r = await http(s, path);
        assert.ok(!r.text.includes(SESSION_SECRET), `${path}: 세션 비밀이 응답에 있다`);
        assert.ok(!JSON.stringify([...r.headers]).includes(SESSION_SECRET), `${path}: 세션 비밀이 헤더에 있다`);
      }
      // (세션 없이 /api/v1 은 401 봉투 — 지웠다: serve.ts 에 /api/v1 이 없다)
    });
  } finally {
    c.close();
  }
});

// W3f (/api/v1 은 정적 서빙보다 먼저다)·W3g (/version 은 DB 변경 커서) — 지웠다: scripts/serve.ts 는 /api/v1 통과 길과 DB 커서 /version 을 두지 않는다
// (SEL-77 이후 몫, docs/plan/migration-ts-equivalence.md 4.3). ts 의 /version 은 index.html·ask-*.html 의 시각(0.15 와 같은 계약)이고 test_serve_ts_cases·test_serve_ts_static 이 지킨다.

test("W3h 이전 판 폼에서 온 답: 그 판에 붙거나 409 로 거절한다 — 새 판에 몰래 붙이지 않는다 (해석 11)", async () => {
  const c = await db_with_form();
  try {
    const sets = () => c.env.db.all<{ id: string; version_no: number }>("SELECT id, version_no FROM question_sets WHERE form_key = 'plan-start' ORDER BY version_no");
    const old_sets = sets();
    assert.ok(old_sets.length >= 1);
    const old_set = old_sets[old_sets.length - 1]!.id;
    // 질문이 바뀐 새 판을 올린다 (같은 폼 키)
    const changed = { ...ASK_SPEC, questions: ASK_SPEC.questions.map((q) => (q.id === "scope" ? { ...q, label: "범위는? (개정)" } : q)) };
    step(c, ["ask", SLUG, write_spec(c, changed, "ask-v2.json")]);
    const now_sets = sets();
    assert.ok(now_sets.length > old_sets.length, "새 판이 올라갔다");
    await with_server(c, {}, async (s) => {
      const subs = sub_count(c);
      const res = await post_feedback(s, SLUG, feedback_body());
      if (res.status === 200) {
        const row = c.env.db.get<{ set_id: string }>("SELECT set_id FROM submissions ORDER BY rowid DESC LIMIT 1")!;
        assert.equal(sub_count(c), subs + 1);
        assert.equal(row.set_id, old_set, "화면을 열었을 때의 판에 붙었다(새 판이 아니다)");
      } else {
        assert.equal(res.status, 409, `409 가 아니면 안 된다: ${res.status} ${res.text}`);
        assert.equal(sub_count(c), subs, "거절하면 아무것도 저장하지 않는다");
        assert.equal(res.json?.ok, false);
      }
    });
  } finally {
    c.close();
  }
});


test("W5 pes watch: 알림 줄 형식은 v0.15 와 같고, 화면에서 보낸 답마다 한 줄이 느는 것을 tail 없이 파일로 확인한다 (해석 5)", async () => {
  const c = await db_with_form();
  try {
    const watch = step(c, ["watch", SLUG]).trim();
    assert.match(watch, /^tail -n0 -F .*feedback\.log.* \| grep --line-buffered FEEDBACK$/);
    await with_server(c, {}, async (s) => {
      for (let i = 1; i <= 3; i += 1) {
        const res = await post_feedback(s, SLUG, feedback_body({ text: `합성 답 ${i}`, answers: { memo: `합성 ${i}` } }));
        assert.equal(res.status, 200);
        const lines = read_lf(join(c.folder, "feedback.log")).trim().split("\n").filter(Boolean);
        assert.equal(lines.length, i, `답 ${i}개 -> 알림 ${i}줄`);
        assert.match(lines[lines.length - 1]!, /^FEEDBACK plan R0 stage_start \S/);
      }
      assert.equal(pending_names(c).length, 3);
    });
  } finally {
    c.close();
  }
});


test("W7 미전환 프로젝트(DB 에 없음): 같은 서버가 옛 폴더를 서빙하지만 답은 받지 않는다 — 404, DB·폴더 불변 (D14: TS 는 project.json 을 쓰지 않는다)", async () => {
  // (0.15·PR18 은 이 답을 옛 폴더의 feedback/ 에 파일로 썼다. serve.ts 는 DB 에 없는 폴더의 답을 404 로 거절한다 — scripts/serve.ts 머리말.)
  const c = await make_cli_env();
  try {
    const other = "synthetic-legacy-only";
    const dir = folder_of(c, other);
    write_legacy(dir, { ...plain_legacy(other), topic: "합성 미전환 주제" });
    step(c, ["status", other]);
    const tree = tree_digest(dir);
    await with_server(c, {}, async (s) => {
      const page = await http(s, `/${other}/ping`);
      assert.equal(page.json?.ok, true, "옛 프로젝트도 같은 서버가 서빙한다");
      const before = commit_count(c);
      const res = await post_feedback(s, other, { stage: "plan", round: 0, kind: "feedback", text: "합성 답", answers: {} });
      assert.equal(res.status, 404, res.text);
      assert.equal(commit_count(c), before, "DB 에 없는 프로젝트의 답은 DB 에 쓰지 않는다");
      assert.equal(tree_digest(dir), tree, "옛 폴더에도 쓰지 않는다 (feedback/ 도 만들지 않는다)");
    });
  } finally {
    c.close();
  }
});
