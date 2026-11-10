/**
 * SEL-51 PR18 — 로컬 화면 DB/API 전환 (tester, 작성 모드). 구현 전이므로 새 시험은 실패하는 것이 정상이다.
 *
 * 시험 방식: `python3 -I -X utf8 scripts/pes.py ...` 와 `scripts/serve.py` 를 subprocess 로 띄우고 HTTP 로 본다. HOME·USERPROFILE·PES_HOME 은
 * 모두 임시 폴더, 자료는 모두 합성이다(tests/helpers/cli_write_env.ts · cli_read_env.ts · web_env.ts). 픽셀 기준선은 없다 —
 * 같은 합성 자료를 v0.15(플래그 없음, project.json)와 DB(PES_DB_CORE=1)로 각각 렌더해 페이지가 품은 데이터(JSON)를 의미로 비교한다.
 * 브라우저가 필요한 동작(질문 폼의 입력 상호작용·초안 보존·안전한 Markdown·인쇄 CSS·run 표시)은 tests/e2e/workspace_smoke.spec.ts 다.
 *
 * 이 시험이 고정하는 해석(보고서의 '해석 n'과 번호가 같다):
 *   해석 1  플래그(PES_DB_CORE=1)가 없으면 render·ask·hub·serve.py 의 파일·응답이 36bc6a2(PR16 머지, 화면이 아직 v0.15)와 같다(바이트, 시각만 정규화).
 *   해석 2  "같은 화면" = v0.15 가 페이지에 품은 JSON 의 모든 사실이 DB 쪽에도 같은 값으로 있다(DB 쪽이 더 가져도 된다). 시각·파일 이름·경로는 제외.
 *   해석 3  DB 로 서비스하는 프로젝트(폴더에 project.json 이 없어도 된다 — `pes.py init` 이 만든 폴더가 그렇다)는 serve.py 가 `/<slug>/` 로 서빙한다.
 *           render(DB) 는 index.html 을 폴더에 쓴다(화면 파일은 상태가 아니다). project.json 은 읽기만 한다(바이트·mtime 불변).
 *   해석 4  `POST /<slug>/feedback`(DB): 보낸 내용은 CommandService 의 사람 제출 한 번(answer.submit 또는 input.record_chat)으로 DB 에만 간다 —
 *           feedback/*.json 0, project.json 쓰기 0. 응답은 v0.15 처럼 {ok:true, file:<처리 대기 이름>} 이고 그 이름이 `pes.py pending` 의 이름과 같다.
 *   해석 5  `pes watch` 알림: DB 모드도 feedback.log 에 `FEEDBACK <stage> R<round> <kind> <처리 대기 경로>` 한 줄을 더한다(내용은 싣지 않는다 — 알림 줄일 뿐 상태가 아니다).
 *   해석 6  kind approve/reopen/resume 은 v0.15 처럼 '사람이 한 요청'으로 처리 대기에만 쌓이고 단계 상태는 `pes.py approve/reopen` 이 바꾼다.
 *   해석 7  검증 오류는 v0.15 와 같은 상태·본문: 잘못된 kind 400 {error:"kind"}, 빈 내용 400 {error:"empty"}, 깨진 JSON 400, 큰 본문 413,
 *           없는 프로젝트 404, 허용 안 된 Origin(없음 포함) 403 {error:"origin", hint:"pes remote add <origin>"}. 모두 DB 에 아무것도 남기지 않는다.
 *   해석 8  `GET /<slug>/version` 은 DB 변경 커서에서 온다: 변경이 없으면 같은 값, DB 쓰기가 있으면 커진다, 파일 mtime 과 무관. 형식은 {"v": 정수}.
 *   해석 9  DB 모드의 보고서·최종 보고서·eli5 는 폴더 파일이 아니라 DB(blob)에서 같은 URL(`/<slug>/reports/<단계>/report.{md,html}`, `eli5.html`,
 *           `/<slug>/out/report.{md,html}`)로 서빙한다. 대시보드 데이터의 stages.<단계>.reports 에 같은 경로가 실린다.
 *   해석 10 소유자 세션은 페이지에 실리지 않는다: 어떤 정적 응답에도 PES_LOCAL_SESSION_SECRET 값이 없다. 화면의 쓰기는 같은 출처(Origin 검사)의
 *           `POST /<slug>/feedback` 한 길이고, /api/v1 은 정적 서빙보다 먼저다(폴더 이름이 api 여도).
 *   해석 11 이전 판 질문 폼에서 온 답: 새 판이 올라온 뒤에도 (a) 200 이고 제출의 set_id 가 그 폼을 열었을 때의 판이거나 (b) 409 이고 아무것도 저장하지 않는다 —
 *           새 판에 몰래 붙이지 않는다.
 *   해석 12 Playwright: @playwright/test 는 package.json devDependencies 에 정확한 버전(1.65.0, ^·~ 없음)으로 고정, playwright.config.ts 는 tests/e2e 의 *.spec.ts 만 돈다.
 *           npm test(node --test "tests/**\/*.test.ts")에는 e2e 가 섞이지 않는다.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { make_cli_env, SLUG, type CliEnv } from "./helpers/cli_write_env.ts";
import { baseline_dir, folder_of, normalize, plain_legacy, read_lf, run_py, seed, write_legacy, write_json, ok, OFF } from "./helpers/cli_read_env.ts";
import {
  ASK_SPEC,
  build_db,
  build_old,
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
  url_fix_diffs,
  WEB_BASELINE_REF,
} from "./helpers/web_env.ts";

function norm_html(text: string, roots: string[]): string {
  return normalize(text.replace(/\r\n/g, "\n"), roots).replace(/"built(_date)?": ?"[^"]*"/g, '"built": "<B>"');
}


test("W0 Playwright: devDependency 정확한 버전 고정, config 는 e2e *.spec.ts 만, npm test 에 섞이지 않는다 (해석 12)", () => {
  const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
  const version: string = pkg.devDependencies?.["@playwright/test"] ?? "";
  assert.match(version, /^\d+\.\d+\.\d+$/, `@playwright/test 는 정확한 버전이어야 한다 (받은 값: ${version || "없음"})`);
  assert.equal(pkg.dependencies?.["@playwright/test"], undefined, "devDependency 이지 dependency 가 아니다");
  const lock = JSON.parse(readFileSync(join(REPO, "package-lock.json"), "utf8"));
  assert.equal(lock.packages?.["node_modules/@playwright/test"]?.version, version, "lock 파일의 버전이 같다");
  const config = join(REPO, "playwright.config.ts");
  assert.ok(existsSync(config), "playwright.config.ts");
  const text = readFileSync(config, "utf8");
  assert.match(text, /tests\/e2e|testDir/, "e2e 폴더만 본다");
  assert.ok(existsSync(join(REPO, "tests", "e2e", "workspace_smoke.spec.ts")), "스모크 파일");
  assert.equal(pkg.scripts.test, 'node --test "tests/**/*.test.ts"', "npm test 는 *.test.ts 만 (e2e 는 *.spec.ts)");
});

test("W1a 플래그 없음: render·ask·hub 가 만든 파일이 36bc6a2(v0.15)와 바이트까지 같다 (해석 1)", async () => {
  const base = baseline_dir(WEB_BASELINE_REF);
  assert.notEqual(base, null, `기준 커밋 ${WEB_BASELINE_REF} 가 없다 (얕은 복제? fetch-depth: 0 필요)`);
  if (base === null) return;
  const now = await make_cli_env();
  const old = await make_cli_env();
  try {
    const old_py = join(base, "scripts", "pes.py");
    for (const [c, script] of [[now, undefined], [old, old_py]] as const) {
      write_legacy(c.folder, plain_legacy(SLUG));
      writeFileSync(join(folder_of(c, SLUG), "..", ".pes-hub"), "1", "utf8"); // render 가 홈 허브도 다시 짓게 한다
      const run = (args: string[]) => ok(run_py(c, args, { ...OFF, ...(script !== undefined ? { script } : {}) }), args.join(" "));
      run(["ask", SLUG, write_spec(c)]);
      run(["round-start", SLUG, "plan"]);
      run(["merge", SLUG, "plan", write_json(c, "m.json", [{ id: 1, kind: "topic", title: "합성 항목", summary: "요약", status: "done" }])]);
      run(["note", SLUG, "합성 메모"]);
      run(["render", SLUG, "plan"]);
      run(["report", SLUG, "plan"]);
      run(["web", SLUG, "--assemble"]);
    }
    const files = (c: CliEnv) => [
      join(c.folder, "index.html"),
      join(c.folder, "ask-plan-start.html"),
      join(c.folder, "..", "index.html"),
      join(c.folder, "reports", "plan", "report.html"),
      join(c.folder, "reports", "plan", "report.md"),
      join(c.folder, "out", "report.html"),
    ];
    const a = files(now);
    const b = files(old);
    for (let i = 0; i < a.length; i += 1) {
      assert.ok(existsSync(a[i]!), `새 코드가 ${a[i]} 를 만든다`);
      const mine = norm_html(readFileSync(a[i]!, "utf8"), roots_of(now));
      const theirs = norm_html(readFileSync(b[i]!, "utf8"), roots_of(old, [base, `/private${base}`]));
      const label = `플래그 없음: ${a[i]!.split(/[\\/]/).slice(-2).join("/")} 가 v0.15 와 같다`;
      if (a[i]!.endsWith(join(SLUG, "index.html"))) assert.deepEqual(url_fix_diffs(theirs, mine), [], `${label} (path·shots 링크 safeUrl 수정만 허용)`);
      else assert.equal(mine, theirs, label);
    }
  } finally {
    now.close();
    old.close();
  }
});

test("W1b 플래그 없음: serve.py 의 정적 서빙·/version·/ping·POST feedback 이 36bc6a2 와 같다 (해석 1)", async () => {
  const base = baseline_dir(WEB_BASELINE_REF);
  assert.notEqual(base, null, `기준 커밋 ${WEB_BASELINE_REF} 가 없다`);
  if (base === null) return;
  const now = await make_cli_env();
  const old = await make_cli_env();
  try {
    for (const c of [now, old]) {
      write_legacy(c.folder, plain_legacy(SLUG));
      step(c, undefined, ["ask", SLUG, write_spec(c)]);
      step(c, undefined, ["render", SLUG, "plan"]);
    }
    const seen: Array<Array<[number, string]>> = [];
    for (const [c, script] of [[now, undefined], [old, join(base, "scripts", "serve.py")]] as const) {
      const rows: Array<[number, string]> = [];
      await with_server(c, { flag: undefined, ...(script !== undefined ? { script } : {}) }, async (s) => {
        const get = async (p: string) => {
          const r = await http(s, p);
          rows.push([r.status, `${p} ${r.headers.get("content-type") ?? ""} ${r.headers.get("location") ?? ""}`]);
          return r;
        };
        await get("/ping");
        await get(`/${SLUG}/ping`);
        await get(`/${SLUG}`);
        await get(`/${SLUG}/`);
        await get(`/${SLUG}/ask-plan-start.html`);
        await get(`/${SLUG}/no-such-file.html`);
        await get(`/no-such-project/`);
        const ver = await get(`/${SLUG}/version`);
        rows.push([ver.status, Object.keys(ver.json ?? {}).join(",")]);
        const who = await get("/whoami");
        rows.push([who.status, Object.keys(who.json ?? {}).join(",")]);
        const cases: Array<[string, Record<string, unknown> | string, { origin?: string | null }]> = [
          ["ok", feedback_body(), {}],
          ["kind", feedback_body({ kind: "bogus" }), {}],
          ["empty", feedback_body({ text: "", answers: {} }), {}],
          ["broken", "{not json", {}],
          ["no-origin", feedback_body(), { origin: null }],
          ["evil-origin", feedback_body(), { origin: "http://evil.example" }],
        ];
        for (const [name, body, o] of cases) {
          const r = await post_feedback(s, SLUG, body, o);
          const shape = r.json === null ? "" : Object.keys(r.json).sort().join(",") + JSON.stringify(r.json.error ?? "");
          rows.push([r.status, `${name} ${shape}`]);
        }
        const big = await post_feedback(s, SLUG, JSON.stringify({ text: "x".repeat(300 * 1024) }));
        rows.push([big.status, "oversize"]);
        const none = await post_feedback(s, "no-such-project", feedback_body());
        rows.push([none.status, "unknown-project"]);
      });
      seen.push(rows);
    }
    assert.deepEqual(seen[0], seen[1], "플래그 없음: 응답 상태와 모양이 v0.15 와 같다");
    // 파일 쪽: 같은 한 건이 feedback/ 에 json 으로, feedback.log 에 한 줄로 남는다.
    assert.equal(feedback_files(now).length, 1, "ok 한 건만 feedback/ 에 json 으로 쓰였다");
    const log = read_lf(join(now.folder, "feedback.log")).trim().split("\n");
    assert.equal(log.length, 1);
    assert.match(log[0]!, /^FEEDBACK plan R0 stage_start .*plan-R0-\d{8}-\d{6}(-\d+)?\.json$/);
    const rec = JSON.parse(read_lf(join(now.folder, "feedback", feedback_files(now)[0]!)));
    assert.equal(rec.via, "html");
    assert.deepEqual(rec.answers, feedback_body().answers);
  } finally {
    now.close();
    old.close();
  }
});


test("W2a 대시보드: DB 로 렌더한 데이터가 v0.15 데이터의 모든 사실을 담는다 — 전체·단계 탭·타임라인·항목×라운드 (해석 2·3)", async () => {
  const old = await build_old();
  const db = await build_db();
  try {
    const sig = db.sig(db.project_json);
    const a = normalize_data((await pages(old, undefined)).dash, roots_of(old)) as any;
    const b = normalize_data((await pages(db, "1")).dash, roots_of(db)) as any;
    // 주제는 DB 의 것이다(폴더의 옛 project.json 은 다른 주제).
    assert.equal(b.project.topic, a.project.topic, "화면의 주제 = DB 의 주제, 폴더에 남은 옛 project.json 이 아니다");
    for (const key of ["project", "stages", "snapshots", "asks", "outputs", "qlabels"]) expect_same_screen(a[key], b[key], `D.${key}`);
    expect_same_screen(a.feedback, b.feedback, "D.feedback (아직 답 없음)");
    assert.ok(b.snapshots.length >= 1, "단계 봉인(스냅샷)이 타임라인·항목×라운드의 자료로 실린다");
    assert.deepEqual(db.sig(db.project_json), sig, "project.json 은 읽기만 한다 (바이트·mtime 불변)");
  } finally {
    old.close();
    db.close();
  }
});

test("W2b 시작 질문 폼: __other·show_if·필수·추천이 같은 spec 으로 유지된다 — ask 페이지 데이터 동등 (해석 2)", async () => {
  const old = await build_old();
  const db = await build_db();
  try {
    const a = normalize_data((await pages(old, undefined)).ask, roots_of(old)) as any;
    const b = normalize_data((await pages(db, "1")).ask, roots_of(db)) as any;
    expect_same_screen(a.spec, b.spec, "D.spec (질문 id·옵션·추천·required·show_if·other)");
    expect_same_screen(a.stages, b.stages, "D.stages (파이프라인 표시)");
    assert.equal(b.topic, a.topic);
    const q = (b.spec.questions as any[]).find((x) => x.id === "scope");
    assert.equal(q.options.find((o: any) => o.recommended).value, "narrow", "추천이 유지된다");
    assert.deepEqual((b.spec.questions as any[]).find((x) => x.id === "why-wide").show_if, { id: "scope", in: ["wide"] });
  } finally {
    old.close();
    db.close();
  }
});

test("W2c AI 점검: 라운드 점검 질문이 같은 질문·옵션·필수로 대시보드에 실린다 (질문 id 는 달라도 된다) (해석 2)", async () => {
  const old = await build_old();
  const db = await build_db();
  try {
    const review = [
      {
        id: "chk",
        type: "single",
        label: "점검 질문 하나",
        required: true,
        options: [
          { value: "ok", label: "맞음", recommended: true },
          { value: "no", label: "아님" },
        ],
      },
    ];
    // v0.15: AI 가 project.json 의 stages.plan.review 에 직접 쓰던 것. DB: 점검 질문 세트를 올린다(ask kind=review).
    const json = JSON.parse(readFileSync(old.project_json, "utf8"));
    json.stages.plan.review = { round: 1, questions: review };
    writeFileSync(old.project_json, JSON.stringify(json), "utf8");
    step(db, "1", ["ask", SLUG, write_spec(db, { id: "plan-review-r1", stage: "plan", kind: "review", round: 1, title: "점검", questions: review }, "review.json")]);
    const shape = (r: { round: number; questions: any[] }) => ({
      round: r.round,
      questions: r.questions.map((q) => ({ label: q.label, type: q.type, required: !!q.required, options: q.options })),
    });
    step(old, undefined, ["render", SLUG]); // v0.15 화면(index.html)은 render 가 다시 지어야 바뀐 review 가 실린다
    const a = (await pages(old, undefined)).dash.project.stages.plan.review as { round: number; questions: any[] } | null;
    const b = (await pages(db, "1")).dash.project.stages.plan.review as { round: number; questions: any[] } | null;
    assert.ok(a && b, "두 화면 모두 점검 질문이 있다");
    expect_same_screen(shape(a!), shape(b!), "stages.plan.review");
  } finally {
    old.close();
    db.close();
  }
});

test("W2d 홈 목록(허브): 프로젝트 줄이 같다 — 주제·현재 단계·차례·처리 대기 수·단계 상태 (해석 2)", async () => {
  const old = await build_old();
  const db = await build_db();
  try {
    const a = normalize_data((await pages(old, undefined)).hub, roots_of(old)) as any;
    const b = normalize_data((await pages(db, "1")).hub, roots_of(db)) as any;
    assert.equal(b.projects.length, 1);
    // v0.15 의 합성 project.json 에는 created 가 없어 '' 이고, DB 프로젝트는 만든 날짜를 가진다 — 그 값만 비교에서 빼고 형식을 따로 본다.
    const drop_created = (ps: any[]) => ps.map(({ created, ...rest }) => rest);
    expect_same_screen(drop_created(a.projects), drop_created(b.projects), "D.projects");
    assert.match(String(b.projects[0].created), /^\d{4}-\d{2}-\d{2}/, "DB 프로젝트의 created 는 날짜");
    expect_same_screen(a.stages, b.stages, "D.stages");
    assert.equal(b.projects[0].topic, a.projects[0].topic);
  } finally {
    old.close();
    db.close();
  }
});

test("W1c 허용 차이 판정기 자체: safeUrl 줄 수정만 통과하고, 그 밖의 한 줄 차이는 실패한다", () => {
  const base = ["a", "<a href=\"${esc(it.path)}\">", "b", "<img src=\"${esc(p)}\"> shots", "c"].join("\n");
  const fixed = ["a", "<a href=\"${esc(safeUrl(it.path))}\">", "b", "<img src=\"${esc(safeUrl(p))}\"> shots", "c"].join("\n");
  assert.deepEqual(url_fix_diffs(base, fixed), []);
  assert.notDeepEqual(url_fix_diffs(base, base.replace("\nb\n", "\nB\n")), []);
  assert.notDeepEqual(url_fix_diffs(fixed.replace("\nc", "\nC"), fixed), []);
  assert.notDeepEqual(url_fix_diffs(base, base.replace("it.path", "it.path2")), [], "safeUrl 없는 변경은 안 된다");
});
