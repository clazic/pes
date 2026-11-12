/**
 * SEL-86 U1b 후속 B — 보고서·산출물 HTML 에 CSP sandbox, 앱 index 에 script-src 'self' (tester, 작성 모드). 구현 전에는 실패하는 것이 정상.
 *
 * 스스로 정한 해석 (이슈 SEL-86 · SEL-82-final-review-1.md 권장 B — 구현을 추측하지 않음):
 *  1 보고서·산출물 주소 /<slug>/reports/<단계>/<이름>, /<slug>/out/<이름> 중 content-type 이 text/html 인 응답(GET·HEAD, 쿼리 ?print=1 포함)은
 *    `Content-Security-Policy: sandbox allow-scripts allow-popups allow-modals allow-downloads` 를 단 하나의 sandbox 지시어로 가진다.
 *    토큰 집합이 정확히 이 넷 — allow-same-origin(불투명 출처의 핵심)·allow-top-navigation*·allow-forms·allow-popups-to-escape-sandbox 등은 없다.
 *    (다른 지시어를 ; 로 덧붙이는 것은 구현 판단이라 막지 않는다. 헤더가 둘이면 둘 다 합쳐서 본다.)
 *  2 HTML 이 아닌 파일(PDF·PNG·md·json·octet-stream)은 내용 바이트·Content-Type 이 그대로이고, PDF·이미지에는 sandbox 지시어가 없다
 *    (Chromium 의 PDF 뷰어는 sandbox 된 문서에서 막힌다). md·json 의 헤더는 구현 판단.
 *  3 앱 index (/p/<slug>/… 와 /_app/index.html): 응답 헤더나 그 안의 <meta http-equiv=Content-Security-Policy> 중 어느 쪽이든 script-src 가 'self' 를
 *    허용하고 'unsafe-inline'·'unsafe-eval'·* 가 없다. sandbox 지시어는 없다(앱은 sessionStorage 가 필요). 앱 원본(app/index.html)과 빌드(app/dist/index.html)
 *    모두 인라인 <script> 와 on*= 속성이 없다. 시험은 실제 빌드 app/dist 를 PES_APP_DIR 로 가리킨다(없으면 건너뛰지 않고 실패 — cd app && npm ci && npm run build).
 *  4 서버가 만든 페이지(대시보드 /<slug>/, ask 폼, 허브 /)는 기존대로 200 text/html. CSP 를 넣을지는 구현 판단이되, 넣으면 sandbox 는 allow-same-origin 을
 *    함께 가져야 하고(그렇지 않으면 feedback POST 가 죽는다) script-src 가 있으면 인라인 스크립트(대시보드 데이터 JSON 아님)를 막지 않아야 한다.
 *  5 보고서가 CSP 를 얻어도 다른 응답 헤더·본문은 그대로다(바이트 동일).
 * 합성 fixture(tests/fixtures/legacy/full), 임시 HOME·USERPROFILE·PES_HOME.
 */

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { activated, with_migration } from "./helpers/migration_env.ts";
import { project_row } from "./helpers/legacy_env.ts";
import { SLUG, type CliEnv } from "./helpers/cli_write_env.ts";
import { seed, write_json } from "./helpers/cli_read_env.ts";
import { ASK_SPEC, step, with_server, write_spec } from "./helpers/web_env.ts";

const REPO = join(import.meta.dirname, "..");

const WANTED_TOKENS = ["allow-downloads", "allow-modals", "allow-popups", "allow-scripts"];

/** 모든 content-security-policy 헤더 값을 ; 로 나눈 지시어 표 { 이름 → 토큰들 } (같은 이름은 합친다) */
function directives(policies: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const policy of policies) {
    for (const part of policy.split(";")) {
      const words = part.trim().split(/\s+/).filter((w) => w !== "");
      if (words.length === 0) continue;
      const name = (words[0] as string).toLowerCase();
      out.set(name, [...(out.get(name) ?? []), ...words.slice(1).map((w) => w.toLowerCase())]);
    }
  }
  return out;
}

function header_policies(headers: Headers): string[] {
  const raw = headers.get("content-security-policy");
  return raw === null ? [] : [raw];
}

function meta_policies(html: string): string[] {
  const out: string[] = [];
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if (!/http-equiv\s*=\s*["']?content-security-policy["']?/i.test(tag)) continue;
    const m = /content\s*=\s*"([^"]*)"|content\s*=\s*'([^']*)'/i.exec(tag);
    if (m !== null) out.push((m[1] ?? m[2]) as string);
  }
  return out;
}

function assert_report_sandbox(headers: Headers, what: string): void {
  const raw = headers.get("content-security-policy");
  assert.ok(raw !== null, `${what}: Content-Security-Policy 헤더가 있다`);
  const d = directives(header_policies(headers));
  const tokens = d.get("sandbox");
  assert.ok(tokens !== undefined, `${what}: sandbox 지시어가 있다 (${raw})`);
  assert.deepEqual([...new Set(tokens)].sort(), WANTED_TOKENS, `${what}: sandbox 토큰이 정확히 allow-scripts allow-popups allow-modals allow-downloads (${raw})`);
  assert.ok(!tokens.includes("allow-same-origin"), `${what}: allow-same-origin 이 없다 — 있으면 sandbox 가 sessionStorage·같은 출처 API 를 못 막는다`);
}

function assert_no_inline_script(html: string, what: string): void {
  for (const tag of html.match(/<script\b[^>]*>/gi) ?? []) assert.match(tag, /\bsrc\s*=/i, `${what}: 인라인 <script> 가 없다 (${tag})`);
  for (const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) assert.equal((m[1] as string).trim(), "", `${what}: <script> 본문이 비어 있다`);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, `${what}: on*= 이벤트 속성이 없다`);
  assert.doesNotMatch(html, /href\s*=\s*["']\s*javascript:/i, `${what}: javascript: 링크가 없다`);
}

function assert_app_script_policy(headers: Headers, html: string, what: string): void {
  const d = directives([...header_policies(headers), ...meta_policies(html)]);
  const src = d.get("script-src") ?? d.get("default-src");
  assert.ok(src !== undefined, `${what}: 헤더나 meta CSP 에 script-src 가 있다`);
  // SEL-102: 'self'(출처 전체) 대신 /_app/ 경로 출처만 — 폴더의 아무 .js 도 싣지 못한다
  assert.ok(src.length > 0 && src.every((x) => /\/_app\/$/.test(x)), `${what}: script-src 는 /_app/ 경로 출처만 (${src.join(" ")})`);
  for (const bad of ["'self'", "'unsafe-inline'", "'unsafe-eval'", "*", "data:", "blob:", "http:", "https:"]) assert.ok(!src.includes(bad), `${what}: script-src 에 ${bad} 가 없다`);
  assert.deepEqual(d.get("base-uri"), ["'none'"], `${what}: base-uri 'none'`);
  assert.deepEqual(d.get("object-src"), ["'none'"], `${what}: object-src 'none'`);
  assert.ok(!d.has("sandbox"), `${what}: 앱에는 sandbox 가 없다 (앱은 같은 출처 sessionStorage 가 필요)`);
}


/**
 * DB 프로젝트(project.json 없음) + 시작 질문 폼 + 기획 라운드 + 단계 보고서(report.html·eli5.html·report.md) + 최종 보고서(out/report.html·report.md).
 * tests/e2e/helpers/seed_workspace.ts 와 같은 순서(합성 자료). 주소는 /<SLUG>/reports/plan/…, /<SLUG>/out/….
 */
async function with_reports(fn: (c: CliEnv, slug: string) => Promise<void>): Promise<void> {
  const { make_cli_env } = await import("./helpers/cli_write_env.ts");
  const c = await make_cli_env();
  try {
    rmSync_project_json(c);
    step(c, ["ask", SLUG, write_spec(c, ASK_SPEC)]);
    seed(c);
    step(c, ["merge", SLUG, "plan", write_json(c, "hostile.json", [{ id: 9, kind: "topic", title: "합성 항목", summary: "합성 요약", details: "합성 상세", status: "done" }])]);
    writeFileSync(join(c.folder, "..", ".pes-hub"), "1", "utf8");
    step(c, ["render", SLUG, "plan"]);
    mkdirSync(join(c.folder, "reports", "plan"), { recursive: true });
    writeFileSync(
      join(c.folder, "reports", "plan", "eli5.json"),
      JSON.stringify({ title: "합성 그림 설명", lead: "합성 한 줄", scenes: [{ step: "그림 1", big: "합성 장면", emoji: "🔍", say: "합성 말" }], takeaway: "합성 끝" }),
      "utf8",
    );
    step(c, ["report", SLUG, "plan"]);
    step(c, ["web", SLUG, "--assemble"]);
    step(c, ["render", SLUG]);
    await fn(c, SLUG);
  } finally {
    c.close();
  }
}
function rmSync_project_json(c: CliEnv): void {
  unlinkSync(c.project_json);
}

const sha_equal = (a: Uint8Array, b: Uint8Array): boolean => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

test("S1 보고서·산출물 HTML: GET·HEAD·?print=1 모두 CSP sandbox(정확한 네 토큰, allow-same-origin 없음), 본문·Content-Type 그대로", { timeout: 180_000 }, async () => {
  await with_reports(async (c, slug) => {
    await with_server(c, {}, async (s) => {
      for (const path of ["reports/plan/report.html", "reports/plan/eli5.html", "out/report.html"]) {
        const plain = await fetch(`${s.url}/${slug}/${path}`);
        const plain_body = Buffer.from(await plain.arrayBuffer());
        assert.equal(plain.status, 200, path);
        assert.match(plain.headers.get("content-type") ?? "", /^text\/html/, `${path}: Content-Type 그대로`);
        assert.ok(plain_body.toString("utf8").includes("<script"), `${path}: 본문은 스크립트를 품은 HTML 그대로`);
        assert_report_sandbox(plain.headers, `GET ${path}`);
        // 인쇄 쿼리(?print=1)·다른 쿼리도 같은 바이트·같은 헤더
        for (const suffix of ["?print=1", "?x=1"]) {
          const res = await fetch(`${s.url}/${slug}/${path}${suffix}`);
          assert.equal(res.status, 200, `${path}${suffix}`);
          assert.ok(sha_equal(Buffer.from(await res.arrayBuffer()), plain_body), `${path}${suffix}: 같은 바이트`);
          assert_report_sandbox(res.headers, `GET ${path}${suffix}`);
        }
        const head = await fetch(`${s.url}/${slug}/${path}`, { method: "HEAD" });
        assert.equal(head.status, 200);
        assert_report_sandbox(head.headers, `HEAD ${path}`);
        assert.equal(head.headers.get("content-type"), plain.headers.get("content-type"), `${path}: HEAD 와 GET 의 Content-Type 이 같다`);
      }
    });
  });
});

test("S2a HTML 이 아닌 보고서·산출물(md·json): 200·Content-Type 그대로 · 본문 비어 있지 않음; 없는 주소·밖으로 나가는 주소는 404", { timeout: 180_000 }, async () => {
  await with_reports(async (c, slug) => {
    await with_server(c, {}, async (s) => {
      const md = await fetch(`${s.url}/${slug}/reports/plan/report.md`);
      assert.equal(md.status, 200);
      assert.match(md.headers.get("content-type") ?? "", /^text\/plain/);
      assert.ok((await md.text()).length > 0);
      const out_md = await fetch(`${s.url}/${slug}/out/report.md`);
      assert.equal(out_md.status, 200);
      assert.match(out_md.headers.get("content-type") ?? "", /^text\/plain/);
      const eli5 = await fetch(`${s.url}/${slug}/reports/plan/eli5.json`);
      if (eli5.status === 200) assert.match(eli5.headers.get("content-type") ?? "", /^application\/json/);
      for (const bad of ["reports/plan/nope.html", "out/nope.html", "reports/nostage/report.html", "reports/plan/..%2Fproject.json"]) {
        assert.equal((await fetch(`${s.url}/${slug}/${bad}`)).status, 404, bad);
      }
    });
  });
});

test("S2b 이전한 PDF·이미지 보고서: 바이트·Content-Type 그대로, sandbox 지시어 없음", { timeout: 180_000 }, async () => {
  await with_migration(async (env, legacy, mig) => {
    const a = await activated(env, legacy, mig, "full", "sel86-binary");
    const slug = project_row(env.db, a.imp.project_id).slug;
    assert.ok(slug);
    await with_server({ env: { home: env.home } }, {}, async (s) => {
      const pdf = await fetch(`${s.url}/${slug}/reports/plan/report.pdf`);
      assert.equal(pdf.status, 200);
      assert.ok(sha_equal(Buffer.from(await pdf.arrayBuffer()), readFileSync(join(a.dir, "reports", "plan", "report.pdf"))), "PDF 바이트 그대로");
      assert.ok(!directives(header_policies(pdf.headers)).has("sandbox"), "PDF 에는 sandbox 지시어가 없다 (Chromium PDF 뷰어가 막힌다)");
      assert.doesNotMatch(pdf.headers.get("content-type") ?? "", /^text\/html/);
      // 광고된 HTML 아닌 파일 전부(이미지 등): 200 이고 이미지·PDF 에는 sandbox 가 없다
      const dash = await (await fetch(`${s.url}/${slug}/`)).text();
      const m = /<script id="data" type="application\/json">([\s\S]*?)<\/script>/.exec(dash);
      assert.ok(m, "대시보드가 자료를 품는다");
      const data = JSON.parse(m[1] as string);
      const advertised = new Set<string>(((data.outputs ?? []) as unknown[]).filter((o): o is string => typeof o === "string"));
      for (const st of Object.values((data.project?.stages ?? data.stages ?? {}) as Record<string, any>)) for (const r of (st.reports ?? []) as Array<{ path?: string }>) if (typeof r.path === "string") advertised.add(r.path);
      for (const path of advertised) {
        if (/\.html?$/i.test(path)) continue;
        const res = await fetch(`${s.url}/${slug}/${path}`);
        assert.equal(res.status, 200, `광고한 ${path} 는 200`);
        await res.arrayBuffer();
        if (/\.(pdf|png|jpe?g|gif|webp)$/i.test(path)) assert.ok(!directives(header_policies(res.headers)).has("sandbox"), `${path}: 이미지·PDF 에는 sandbox 가 없다`);
      }
    });
  });
});

test("S3 앱 index: /p/<slug>/… 와 /_app/index.html 의 script-src 'self'(헤더나 meta), 인라인 스크립트 없음, sandbox 없음 — 원본(app/index.html)과 합성 빌드", { timeout: 180_000 }, async () => {
  // 실제 빌드(app/dist)는 Node 시험 잡에 없다 — 그것은 tests/e2e/sel86_app_build_csp.spec.ts (Playwright 잡이 앱을 빌드한다)가 같은 단언으로 본다.
  const source = readFileSync(join(REPO, "app", "index.html"), "utf8");
  assert_no_inline_script(source, "app/index.html 원본");
  await with_reports(async (c, slug) => {
    // 서버 자식은 --permission 으로 저장소와 이 시험의 임시 루트만 읽는다 — 합성 빌드는 그 루트 아래에 둔다
    const dist = join(c.env.home.root, "synthetic-app-dist");
    mkdirSync(join(dist, "assets"), { recursive: true });
    writeFileSync(join(dist, "assets", "x.js"), "export {};\n", "utf8");
    writeFileSync(join(dist, "assets", "x.css"), "body{margin:0}\n", "utf8");
    writeFileSync(
      join(dist, "index.html"),
      '<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>합성 앱</title><script type="module" crossorigin src="/_app/assets/x.js"></script><link rel="stylesheet" crossorigin href="/_app/assets/x.css"></head><body><div id="root"></div></body></html>\n',
      "utf8",
    );
    const built = readFileSync(join(dist, "index.html"), "utf8");
    assert_no_inline_script(built, "합성 빌드 index.html");
    await with_server(c, { extra: { PES_APP_DIR: dist } }, async (s) => {
      for (const path of [`/p/${slug}/e/1/s/plan/r/1`, `/p/${slug}/`, `/p/${slug}/e/1/s/plan/r/start?print=1`, "/_app/index.html"]) {
        const res = await fetch(`${s.url}${path}`);
        assert.equal(res.status, 200, path);
        assert.match(res.headers.get("content-type") ?? "", /^text\/html/, path);
        const html = await res.text();
        assert_no_inline_script(html, path);
        assert_app_script_policy(res.headers, html, path);
      }
      // 앱 자산(JS·CSS)은 sandbox 가 없고 그대로 나온다
      const assets = [...built.matchAll(/(?:src|href)="(\/_app\/assets\/[^"]+)"/g)].map((m) => m[1] as string);
      assert.ok(assets.length >= 2, "빌드 index 가 자산(JS·CSS)을 가리킨다");
      for (const asset of assets) {
        const res = await fetch(`${s.url}${asset}`);
        assert.equal(res.status, 200, asset);
        await res.arrayBuffer();
        assert.ok(!directives(header_policies(res.headers)).has("sandbox"), `${asset}: 자산에는 sandbox 가 없다`);
      }
    });
  });
});

test("S4 서버가 만든 페이지(대시보드·ask 폼·허브)는 그대로 200 text/html 이고, CSP 를 넣었다면 allow-same-origin 없는 sandbox 가 아니다", { timeout: 180_000 }, async () => {
  await with_reports(async (c, slug) => {
    await with_server(c, {}, async (s) => {
      for (const path of [`/${slug}/`, `/${slug}/index.html`, `/${slug}/ask-plan-start.html`, "/"]) {
        const res = await fetch(`${s.url}${path}`);
        const html = await res.text();
        assert.equal(res.status, 200, path);
        assert.match(res.headers.get("content-type") ?? "", /^text\/html/, path);
        assert.match(html, /<script id="data" type="application\/json">/, `${path}: 자료 JSON 을 품는다`);
        const d = directives([...header_policies(res.headers), ...meta_policies(html)]);
        const sandbox = d.get("sandbox");
        if (sandbox !== undefined) assert.ok(sandbox.includes("allow-same-origin"), `${path}: sandbox 를 넣었다면 allow-same-origin 이 있어야 feedback POST·sessionStorage 가 산다`);
        const script_src = d.get("script-src");
        if (script_src !== undefined) assert.ok(script_src.includes("'unsafe-inline'"), `${path}: 이 페이지는 인라인 스크립트로 그려지므로 script-src 가 그것을 막으면 안 된다`);
      }
      assert.equal((await fetch(`${s.url}/ping`)).status, 200);
      assert.equal((await fetch(`${s.url}/${slug}/version`)).status, 200);
    });
  });
});
