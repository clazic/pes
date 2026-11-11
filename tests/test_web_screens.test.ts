/**
 * SEL-51 PR18 — 프로젝트 폴더 없는 DB 프로젝트·받은 답·보고서·안전한 데이터 (tester, 작성 모드). 구현 전이므로 새 시험은 실패하는 것이 정상이다.
 * 해석 번호는 tests/test_web_parity.test.ts 머리말과 같다. 시험 방식·하니스는 tests/helpers/web_env.ts.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { make_cli_env, SLUG, type CliEnv } from "./helpers/cli_write_env.ts";
import { folder_of, golden, normalize, plain_legacy, read_lf, run_cli, seed, write_legacy, write_json, ok } from "./helpers/cli_read_env.ts";
import {
  ASK_SPEC,
  build_db,
  commit_count,
  db_with_form,
  expect_same_screen,
  feedback_body,
  feedback_files,
  http,
  hub_page_data,
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


test("W2e project.json 이 없는 DB 프로젝트(pes.py init 이 만든 폴더): 허브·대시보드를 짓고 serve.py 가 /<slug>/ 로 서빙한다 (해석 3)", async () => {
  const c = await make_cli_env();
  try {
    rm_default_json(c);
    step(c, ["ask", SLUG, write_spec(c)]);
    seed(c);
    writeFileSync(join(c.folder, "..", ".pes-hub"), "1", "utf8");
    step(c, ["render", SLUG, "plan"]);
    assert.ok(!existsSync(c.project_json), "프로젝트 폴더에 project.json 을 만들지 않는다");
    // 홈 목록: pes.ts 의 hub 가 짓는다(주입한 단일 포트에서 서빙 — 실제 허브 포트는 안 쓴다)
    assert.ok((await hub_page_data(c)).projects.some((p: any) => p.slug === SLUG), "홈 목록에 DB 프로젝트가 있다");
    await with_server(c, {}, async (s) => {
      const redirect = await http(s, `/${SLUG}`);
      assert.equal(redirect.status, 301, "슬래시 없는 주소는 /<slug>/ 로 보낸다 (0.15 의 SimpleHTTPRequestHandler 와 같은 301 — PR18 의 DB 서버는 302 였다)");
      assert.equal(redirect.headers.get("location"), `/${SLUG}/`);
      const page = await http(s, `/${SLUG}/`);
      assert.equal(page.status, 200, "대시보드");
      assert.equal(page_data(page.text).project.topic, "합성 파일 주제");
      assert.equal((await http(s, `/${SLUG}/ping`)).json?.ok, true);
      assert.equal((await http(s, `/${SLUG}/ask-plan-start.html`)).status, 200, "ask-* 딥링크");
      assert.equal((await http(s, "/no-such-project/")).status, 404, "모르는 프로젝트는 그대로 404");
      assert.equal((await post_feedback(s, "no-such-project", feedback_body())).status, 404);
    });
  } finally {
    c.close();
  }
});

test("W2f 받은 답: 화면에서 보낸 답이 대시보드의 '받은 답'(처리 대기)으로 보인다 — v0.15(feedback 파일)와 같은 사실 (해석 2·4)", async () => {
  const a = golden<any[]>("web-v015-feedback"); // 0.15 가 같은 두 답을 받은 뒤 렌더한 화면의 feedback (고정 기록)
  const db = await build_db();
  try {
    const sent = async (c: CliEnv) =>
      with_server(c, {}, async (s) => {
        for (const body of [feedback_body(), { stage: "plan", round: 1, kind: "feedback", text: "합성 자유 의견", answers: {} }]) {
          const r = await post_feedback(s, SLUG, body);
          assert.equal(r.status, 200, r.text);
        }
        step(c, ["render", SLUG]); // pes.ts 는 대시보드 파일을 render 가 짓는다 (0.15 도 같았다)
        return page_data((await http(s, `/${SLUG}/`)).text); // 보낸 직후 새로 받은 화면에 보여야 한다
      });
    const b = normalize_data(await sent(db), roots_of(db)) as any;
    assert.equal(a.length, 2);
    expect_same_screen(a, b.feedback, "D.feedback (stage·round·kind·text·via·processed)");
    assert.ok(b.feedback.every((f: any) => f.processed === false));
  } finally {
    db.close();
  }
});

test("W4 보고서·eli5·최종 보고서: DB 에서 같은 URL 로 서빙하고, 대시보드 데이터가 같은 경로를 가리킨다 — 폴더에는 쓰지 않는다 (해석 9)", async () => {
  const c = await db_with_form();
  try {
    mkdirSync(join(c.folder, "reports", "plan"), { recursive: true });
    const eli5 = { title: "합성 그림 설명", lead: "합성 한 줄", scenes: [{ step: "그림 1", big: "합성 장면", emoji: "🔍", say: "합성 말" }], takeaway: "합성 끝" };
    writeFileSync(join(c.folder, "reports", "plan", "eli5.json"), JSON.stringify(eli5), "utf8");
    step(c, ["report", SLUG, "plan"]);
    step(c, ["web", SLUG, "--assemble"]);
    // (SEL-74: PR18 의 DB 서버는 폴더에 쓰지 않고 DB 에서 서빙했다. pes.ts 는 0.15 호환으로 폴더에도 같은 파일을 두고 serve.ts 가 그 파일을 서빙한다 — D02.)
    assert.ok(existsSync(join(c.folder, "reports", "plan", "report.html")), "폴더 reports/ 에 보고서가 있다");
    assert.ok(existsSync(join(c.folder, "out", "report.html")), "폴더 out/ 에 최종 보고서가 있다");
    step(c, ["render", SLUG]); // 대시보드 파일은 render 가 다시 짓는다 — 방금 만든 보고서·산출물이 실린다
    const dash = await with_server(c, {}, async (s) => page_data((await http(s, `/${SLUG}/`)).text));
    const paths = (dash.project.stages.plan.reports as Array<{ format: string; path: string }>).map((r) => r.path).sort();
    for (const want of ["reports/plan/report.html", "reports/plan/report.md", "reports/plan/eli5.html"]) assert.ok(paths.includes(want), `대시보드가 ${want} 를 가리킨다 (${paths.join(", ")})`);
    assert.ok((dash.outputs as string[]).includes("out/report.html"), "산출물 목록에 최종 웹 보고서");
    await with_server(c, {}, async (s) => {
      const html = await http(s, `/${SLUG}/reports/plan/report.html`);
      assert.equal(html.status, 200);
      assert.match(html.headers.get("content-type") ?? "", /^text\/html/);
      assert.ok(page_data(html.text).md.includes("합성 기획 항목 하나"), "단계 보고서 본문에 DB 항목");
      const md = await http(s, `/${SLUG}/reports/plan/report.md`);
      assert.equal(md.status, 200);
      assert.match(md.headers.get("content-type") ?? "", /^text\/plain/);
      assert.ok(md.text.includes("합성 기획 항목 하나"));
      const e = await http(s, `/${SLUG}/reports/plan/eli5.html`);
      assert.equal(e.status, 200);
      assert.equal(page_data(e.text).title, "합성 그림 설명");
      const out = await http(s, `/${SLUG}/out/report.html`);
      assert.equal(out.status, 200);
      assert.ok(page_data(out.text).md.includes("첫 장 본문입니다"), "최종 보고서 본문");
      assert.equal((await http(s, `/${SLUG}/out/sources.json`)).status, 200);
      assert.equal((await http(s, `/${SLUG}/reports/research/report.html`)).status, 404, "만들지 않은 보고서는 404");
      assert.equal((await http(s, `/${SLUG}/reports/plan/..%2f..%2fproject.json`)).status === 200, false, "경로 이탈 없음");
    });
  } finally {
    c.close();
  }
});


test("W6 악성 입력을 담은 항목도 DB 렌더가 깨지지 않는다: 데이터는 JSON 안에 안전하게 실린다(</script> 로 닫히지 않는다) (해석 2)", async () => {
  const c = await db_with_form();
  try {
    const evil = "</script><script>window.__pwned=1</script> [x](javascript:alert(1)) <img src=x onerror=window.__pwned=1>";
    step(c, ["merge", SLUG, "plan", write_json(c, "evil.json", [{ id: 9, kind: "topic", title: "악성 항목", summary: evil, details: evil, status: "done" }])]);
    step(c, ["render", SLUG]); // pes.ts 는 대시보드 파일을 render 가 짓는다
    const html = await with_server(c, {}, async (s) => (await http(s, `/${SLUG}/`)).text);
    const data = page_data(html);
    const item = data.project.stages.plan.items.find((i: any) => i.title === "악성 항목");
    assert.equal(item.summary, evil, "원문은 그대로 보존된다");
    const body = html.slice(html.indexOf('<script id="data"'));
    const embedded = body.slice(0, body.indexOf("</script>"));
    assert.ok(!embedded.includes("</script"), "데이터 블록 안에 </script 가 그대로 있으면 안 된다");
    step(c, ["report", SLUG, "plan"]);
    await with_server(c, {}, async (s) => {
      const r = await http(s, `/${SLUG}/reports/plan/report.html`);
      assert.equal(r.status, 200);
      assert.ok(!r.text.slice(r.text.indexOf('<script id="data"')).split("</script>")[0]!.includes("</script"));
    });
  } finally {
    c.close();
  }
});
