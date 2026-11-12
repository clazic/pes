/**
 * SEL-102 — 정적 폴백(serve_static)의 HTML·SVG·XML 전체 sandbox, 모든 정적 응답 nosniff, GET /api/v1/projects/{p}/files/{b}/content 같은 규칙,
 * 앱 index CSP 좁히기 (tester, 작성 모드, 보안). 근거: SEL-86-final-review-1.md 권장 1·2, SEL-86-r1.md 권장 4.
 *
 * 왜: SEL-86 의 sandbox 는 그 응답 한 문서에만 걸린다. sandbox 된 보고서가 `location.href` 로 같은 탭을 sandbox 없는 같은 출처 HTML 로 옮기면
 * 그 페이지가 탭의 sessionStorage(앱 세션)를 읽는다. 폴더에 임의 HTML 을 쓸 수 있는 쪽(notes/x.html 등)이 하나라도 있으면 우회된다.
 *
 * 스스로 정한 해석:
 *  1 정적 폴백이 내는 content-type 이 text/html · image/svg+xml · text/xml · application/xml · application/xhtml+xml 인 응답은 폴더 위치와 상관없이
 *    (프로젝트 폴더 안 어디든 · 프로젝트 폴더 바로 아래 · 홈 루트 · DB 프로젝트든 옛 project.json 폴더든) `Content-Security-Policy: sandbox allow-scripts
 *    allow-popups allow-modals allow-downloads` — SEL-86 의 REPORT_HTML_CSP 와 같은 값(토큰 정확히 넷, allow-same-origin 없음). 확장자 대소문자(.HTML) 무관.
 *  2 예외는 같은 출처 fetch 가 필요한 옛 화면뿐: 프로젝트 폴더 **바로 아래**의 index.html(옛 대시보드)·ask-*.html(질문 폼), 홈 루트의 index.html(허브).
 *    하위 폴더의 index.html(notes/index.html, reports/…/index.html) 은 예외가 아니다.
 *  3 모든 정적 응답(200: HTML·SVG·PNG·PDF·md·json·js·css·알 수 없는 확장자, 예외 화면도)에 `X-Content-Type-Options: nosniff`. GET·HEAD 모두.
 *    sandbox 가 없어야 하는 형식(PNG·PDF·md·json·js·css)에는 sandbox 가 계속 없다 (Chromium PDF 뷰어, <img> 표시 보호).
 *  4 files/{b}/content: 저장된 media_type 이 html·svg·xml 류(매개변수·대소문자 포함)면 같은 sandbox, 어떤 media_type 이든 nosniff,
 *    본문 바이트·Content-Type 그대로. PNG·PDF·octet-stream 에는 sandbox 없음. Content-Disposition 은 구현 판단(여기서는 단언하지 않는다).
 *  5 앱 index(/p/<slug>/… 와 /_app/index.html)의 CSP: script-src 에서 `'self'`(출처 전체)가 빠지고 `/_app/` 경로로 좁혀진다(경로가 있는 출처만),
 *    unsafe-*·*·data:·blob:·http(s): 통째 없음, base-uri 'none', object-src 'none', sandbox 없음. 실제 집행은 tests/e2e/sel102_*.spec.ts.
 * 합성 fixture, 임시 HOME·USERPROFILE·PES_HOME. 기존 시험은 바꾸지 않는다 — 새 계약과 충돌하는 기존 단언은 보고서에 목록으로 적는다.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { connect_read_only } from "../scripts/pes_core/db.ts";
import { db_path } from "../scripts/pes_core/paths.ts";
import { TsServeProcess } from "./helpers/compat_ts_srv.ts";
import { use_home_guard } from "./helpers/home_guard.ts";
import { serve_fixture, type ServeFixture } from "./helpers/serve_ts_env.ts";

use_home_guard();

const SECRET = "synthetic-sel102-owner-session-0123456789abcdef";
const LEGACY = "legacy-one";
const WANTED = ["allow-downloads", "allow-modals", "allow-popups", "allow-scripts"];
const PAGE = "<!doctype html><title>합성</title><body><script>document.body.dataset.ok = '1'</script>합성 본문</body>";
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>try{window.parent.x=sessionStorage.length}catch(e){}</script><rect width="10" height="10"/></svg>`;
const XML = `<?xml version="1.0"?><doc><p xmlns="http://www.w3.org/1999/xhtml"><script>1</script></p></doc>`;
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const PDF = Buffer.from("%PDF-1.4\n% 합성\n", "utf8");

type Hdrs = Record<string, string>;

function directives(csp: string | undefined): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of (csp ?? "").split(";")) {
    const words = part.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    const name = (words[0] as string).toLowerCase();
    out.set(name, [...(out.get(name) ?? []), ...words.slice(1).map((w) => w.toLowerCase())]);
  }
  return out;
}

function assert_sandbox(headers: Hdrs, what: string): void {
  const csp = headers["content-security-policy"];
  assert.ok(csp !== undefined, `${what}: Content-Security-Policy 헤더가 있다`);
  const tokens = directives(csp).get("sandbox");
  assert.ok(tokens !== undefined, `${what}: sandbox 지시어가 있다 (${csp})`);
  assert.deepEqual([...new Set(tokens)].sort(), WANTED, `${what}: 토큰이 정확히 넷, allow-same-origin 없음 (${csp})`);
}

function assert_no_sandbox(headers: Hdrs, what: string): void {
  assert.equal(directives(headers["content-security-policy"]).has("sandbox"), false, `${what}: sandbox 가 없다 (${headers["content-security-policy"] ?? "CSP 없음"})`);
}

function assert_nosniff(headers: Hdrs, what: string): void {
  assert.equal((headers["x-content-type-options"] ?? "").toLowerCase(), "nosniff", `${what}: X-Content-Type-Options: nosniff`);
}

// ---------------------------------------------------------------- 1~3 정적 폴백

async function with_static(fn: (fx: ServeFixture) => Promise<void>): Promise<void> {
  const put = (rel: string, body: string | Buffer): [string, string | Buffer] => [rel, body];
  const files: Record<string, string | Buffer> = Object.fromEntries([
    // DB 프로젝트(synthetic)의 폴더: 정적 폴백이 내는 임의 파일
    put("synthetic/notes/x.html", PAGE),
    put("synthetic/notes/deep/er/x.html", PAGE),
    put("synthetic/notes/index.html", PAGE),
    put("synthetic/notes/y.svg", SVG),
    put("synthetic/notes/z.xml", XML),
    put("synthetic/notes/UP.HTML", PAGE),
    put("synthetic/notes/old.htm", PAGE),
    put("synthetic/notes/UP.SVG", SVG),
    put("synthetic/root.html", PAGE),
    put("synthetic/root.svg", SVG),
    put("synthetic/reports-old/x.html", PAGE),
    put("synthetic/notes/pic.png", PNG),
    put("synthetic/notes/doc.pdf", PDF),
    put("synthetic/notes/readme.md", "# 합성"),
    put("synthetic/notes/data.json", '{"a":1}'),
    put("synthetic/notes/x.js", "window.__x = 1"),
    put("synthetic/notes/s.css", "body{}"),
    put("synthetic/notes/blob.unknownext", "bytes"),
    // 옛 project.json 폴더
    put(`${LEGACY}/notes/x.html`, PAGE),
    put(`${LEGACY}/notes/y.svg`, SVG),
    put(`${LEGACY}/notes/z.xml`, XML),
    put(`${LEGACY}/root.html`, PAGE),
    put(`${LEGACY}/notes/index.html`, PAGE),
    put(`${LEGACY}/ask-plan-start.html`, PAGE),
    put(`${LEGACY}/notes/pic.png`, PNG),
    // 홈 루트(허브 옆)의 임의 파일
    put("x.html", PAGE),
    put("loose.svg", SVG),
    put("loose.xml", XML),
    put("loose.png", PNG),
    put("sub/x.html", PAGE),
  ]);
  const fx = await serve_fixture("sel102-static", { legacy_only: [LEGACY], files });
  try {
    await fn(fx);
  } finally {
    await fx.cleanup();
  }
}

test("T1 정적 폴백의 html·svg·xml 은 폴더 어디서든 sandbox (DB 프로젝트·옛 폴더·프로젝트 바로 아래·홈 루트, GET·HEAD·쿼리·대소문자 확장자), 본문 바이트는 그대로", { timeout: 180_000 }, async () => {
  await with_static(async ({ server }) => {
    const cases: Array<[string, string, string]> = [
      ["/synthetic/notes/x.html", "text/html", PAGE],
      ["/synthetic/notes/deep/er/x.html", "text/html", PAGE],
      ["/synthetic/notes/index.html", "text/html", PAGE],
      ["/synthetic/notes/", "text/html", PAGE],
      ["/synthetic/notes/old.htm", "text/html", PAGE],
      ["/synthetic/notes/UP.HTML", "text/html", PAGE],
      ["/synthetic/notes/y.svg", "image/svg+xml", SVG],
      ["/synthetic/notes/UP.SVG", "image/svg+xml", SVG],
      ["/synthetic/notes/z.xml", "text/xml", XML],
      ["/synthetic/root.html", "text/html", PAGE],
      ["/synthetic/root.svg", "image/svg+xml", SVG],
      ["/synthetic/reports-old/x.html", "text/html", PAGE],
      ["/synthetic/notes/x.html?a=1", "text/html", PAGE],
      ["/synthetic/notes/../notes/x.html", "text/html", PAGE],
      ["/synthetic//notes/./x.html", "text/html", PAGE],
      ["/synthetic%2fnotes%2fx.html", "text/html", PAGE],
      [`/${LEGACY}/notes/x.html`, "text/html", PAGE],
      [`/${LEGACY}/notes/y.svg`, "image/svg+xml", SVG],
      [`/${LEGACY}/notes/z.xml`, "text/xml", XML],
      [`/${LEGACY}/root.html`, "text/html", PAGE],
      [`/${LEGACY}/notes/index.html`, "text/html", PAGE],
      ["/x.html", "text/html", PAGE],
      ["/loose.svg", "image/svg+xml", SVG],
      ["/loose.xml", "text/xml", XML],
      ["/sub/x.html", "text/html", PAGE],
    ];
    for (const [path, type, body] of cases) {
      for (const method of ["GET", "HEAD"]) {
        const res = await server.request(path, { method });
        assert.equal(res.status, 200, `${method} ${path}`);
        assert.ok(res.headers["content-type"]?.startsWith(type), `${method} ${path}: Content-Type ${res.headers["content-type"]}`);
        assert_sandbox(res.headers, `${method} ${path}`);
        assert_nosniff(res.headers, `${method} ${path}`);
        if (method === "GET") assert.equal(res.text(), body, `${path}: 본문 바이트 그대로`);
      }
    }
  });
});

test("T2 예외: 옛 대시보드 index.html·ask-*.html·허브는 sandbox 없음(같은 출처 fetch 유지) — 그래도 nosniff", { timeout: 180_000 }, async () => {
  await with_static(async ({ server }) => {
    for (const path of [`/${LEGACY}/`, `/${LEGACY}/index.html`, `/${LEGACY}/ask-plan-start.html`, "/", "/synthetic/"]) {
      for (const method of ["GET", "HEAD"]) {
        const res = await server.request(path, { method });
        assert.equal(res.status, 200, `${method} ${path}`);
        assert.match(res.headers["content-type"] ?? "", /^text\/html/, `${method} ${path}`);
        assert_no_sandbox(res.headers, `${method} ${path}`);
        assert_nosniff(res.headers, `${method} ${path}`);
      }
    }
  });
});

test("T3 모든 정적 응답에 nosniff, 문서가 아닌 형식(PNG·PDF·md·json·js·css·알 수 없는 확장자)에는 sandbox 가 계속 없고 바이트·Content-Type 그대로", { timeout: 180_000 }, async () => {
  await with_static(async ({ server }) => {
    const plain: Array<[string, string, string | Buffer]> = [
      ["/synthetic/notes/pic.png", "image/png", PNG],
      ["/synthetic/notes/doc.pdf", "application/pdf", PDF],
      ["/synthetic/notes/readme.md", "text/plain", "# 합성"],
      ["/synthetic/notes/data.json", "application/json", '{"a":1}'],
      ["/synthetic/notes/x.js", "text/javascript", "window.__x = 1"],
      ["/synthetic/notes/s.css", "text/css", "body{}"],
      ["/synthetic/notes/blob.unknownext", "application/octet-stream", "bytes"],
      [`/${LEGACY}/notes/pic.png`, "image/png", PNG],
      ["/loose.png", "image/png", PNG],
    ];
    for (const [path, type, body] of plain) {
      for (const method of ["GET", "HEAD"]) {
        const res = await server.request(path, { method });
        assert.equal(res.status, 200, `${method} ${path}`);
        assert.ok(res.headers["content-type"]?.startsWith(type), `${method} ${path}: Content-Type ${res.headers["content-type"]}`);
        assert_nosniff(res.headers, `${method} ${path}`);
        assert_no_sandbox(res.headers, `${method} ${path}`);
        if (method === "GET") assert.ok(res.body.equals(Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8")), `${path}: 바이트 그대로`);
      }
    }
  });
});

test("G1 회귀 가드(이미 되는 동작): 예외 화면(옛 대시보드·ask 폼·허브)과 문서가 아닌 형식은 sandbox 없이 그대로 나온다", { timeout: 180_000 }, async () => {
  await with_static(async ({ server }) => {
    for (const path of [`/${LEGACY}/`, `/${LEGACY}/index.html`, `/${LEGACY}/ask-plan-start.html`, "/", "/synthetic/"]) {
      const res = await server.request(path);
      assert.equal(res.status, 200, path);
      assert.match(res.headers["content-type"] ?? "", /^text\/html/, path);
      assert_no_sandbox(res.headers, path);
    }
    for (const [path, body] of [["/synthetic/notes/pic.png", PNG], ["/synthetic/notes/doc.pdf", PDF], ["/synthetic/notes/x.js", Buffer.from("window.__x = 1")], ["/loose.png", PNG]] as const) {
      const res = await server.request(path);
      assert.equal(res.status, 200, path);
      assert_no_sandbox(res.headers, path);
      assert.ok(res.body.equals(body), `${path}: 바이트 그대로`);
    }
  });
});

// ---------------------------------------------------------------- 4 files/{b}/content

interface Api {
  fx: ServeFixture;
  server: TsServeProcess;
  project_id: string;
}

async function with_api(fn: (a: Api) => Promise<void>): Promise<void> {
  const fx = await serve_fixture("sel102-files", { no_start: true });
  const server = new TsServeProcess(fx.ctx, fx.root, { extra_env: { PES_LOCAL_SESSION_SECRET: SECRET } });
  try {
    await server.start();
    const db = connect_read_only(db_path(fx.ctx.env));
    let project_id: string;
    try {
      project_id = db.get<{ id: string }>("SELECT id FROM projects WHERE slug = 'synthetic'")!.id;
    } finally {
      db.close();
    }
    await fn({ fx, server, project_id });
  } finally {
    await server.stop();
    await fx.cleanup();
  }
}

/** reserve → PUT → complete over HTTP as the owner; returns the blob id. */
async function upload(a: Api, bytes: Buffer, media_type: string, n: number): Promise<string> {
  const base = `/api/v1/projects/${a.project_id}`;
  const auth = { "x-pes-session": SECRET };
  const sha = createHash("sha256").update(bytes).digest("hex");
  const reserved = await a.server.request(`${base}/uploads`, {
    method: "POST",
    body: JSON.stringify({ sha256: sha, size: bytes.byteLength, media_type, original_name: `합성-${n}.bin` }),
    headers: { ...auth, "content-type": "application/json", "idempotency-key": `sel102-r-${n}` },
  });
  assert.ok(reserved.status === 200 || reserved.status === 201, `reserve ${media_type}: ${reserved.status} ${reserved.text()}`);
  const data = reserved.json().data ?? reserved.json();
  const blob_id = (data.blob_id ?? reserved.json().blob_id) as string;
  assert.equal(typeof blob_id, "string", `blob_id (${reserved.text()})`);
  if (data.state !== "ready") {
    const put = await a.server.request(`${base}/uploads/${blob_id}`, { method: "PUT", body: bytes, headers: { ...auth, "content-type": "application/octet-stream", "idempotency-key": `sel102-p-${n}` } });
    assert.equal(put.status, 200, `put ${media_type}: ${put.text()}`);
    const done = await a.server.request(`${base}/uploads/${blob_id}/complete`, { method: "POST", body: "{}", headers: { ...auth, "content-type": "application/json", "idempotency-key": `sel102-c-${n}` } });
    assert.equal(done.status, 200, `complete ${media_type}: ${done.text()}`);
  }
  return blob_id;
}

test("F1 GET P/files/{b}/content: html·svg·xml 류 media_type(매개변수·대소문자 포함)은 sandbox, 모든 media_type 은 nosniff, 본문·Content-Type 그대로, PNG·PDF·octet-stream 에는 sandbox 없음", { timeout: 240_000 }, async () => {
  await with_api(async (a) => {
    const cases: Array<[string, Buffer, boolean]> = [
      ["text/html", Buffer.from(PAGE), true],
      ["text/html; charset=utf-8", Buffer.from(PAGE), true],
      ["Text/HTML", Buffer.from(PAGE), true],
      ["image/svg+xml", Buffer.from(SVG), true],
      ["IMAGE/SVG+XML; charset=utf-8", Buffer.from(SVG), true],
      ["text/xml", Buffer.from(XML), true],
      ["application/xml", Buffer.from(XML), true],
      ["application/xhtml+xml", Buffer.from(PAGE), true],
      ["image/png", PNG, false],
      ["application/pdf", PDF, false],
      ["text/plain", Buffer.from("합성 텍스트"), false],
      ["application/octet-stream", Buffer.from("합성 바이트"), false],
      ["application/json", Buffer.from('{"a":1}'), false],
    ];
    let n = 0;
    for (const [type, bytes, sandboxed] of cases) {
      n += 1;
      // 같은 바이트는 sha256 으로 합쳐지므로 케이스마다 꼬리를 달리한다
      const unique = Buffer.concat([bytes, Buffer.from(`\n${n}`)]);
      const blob_id = await upload(a, unique, type, n);
      const res = await a.server.request(`/api/v1/projects/${a.project_id}/files/${blob_id}/content`, { headers: { "x-pes-session": SECRET } });
      assert.equal(res.status, 200, `${type}: ${res.text().slice(0, 200)}`);
      assert.equal((res.headers["content-type"] ?? "").toLowerCase(), type.toLowerCase(), `${type}: Content-Type 그대로`);
      assert_nosniff(res.headers, type);
      if (sandboxed) assert_sandbox(res.headers, type);
      else assert_no_sandbox(res.headers, type);
      assert.ok(res.body.length > 0, `${type}: 본문이 있다`);
    }
  });
});

test("F2 files content 의 본문 바이트는 sandbox 를 달아도 변하지 않는다 (html)", { timeout: 240_000 }, async () => {
  await with_api(async (a) => {
    const blob_id = await upload(a, Buffer.from(PAGE), "text/html", 99);
    const res = await a.server.request(`/api/v1/projects/${a.project_id}/files/${blob_id}/content`, { headers: { "x-pes-session": SECRET } });
    assert.equal(res.status, 200);
    assert.equal(res.text(), PAGE, "바이트 동일");
    assert_sandbox(res.headers, "html blob");
    assert_nosniff(res.headers, "html blob");
  });
});

// ---------------------------------------------------------------- 5 앱 index CSP

test("C1 앱 index CSP: script-src 는 /_app/ 경로 출처만(‘self’ 전체 아님), base-uri 'none', object-src 'none', sandbox 없음, 위험 토큰 없음 — /p/<slug>/… 와 /_app/index.html", { timeout: 180_000 }, async () => {
  const fx = await serve_fixture("sel102-app", { no_start: true });
  // 서버 자식은 --permission 으로 저장소와 이 시험의 임시 루트만 읽는다 — 합성 빌드는 그 루트 아래에 둔다
  const dist = join(fx.ctx.home.root, "synthetic-app-dist");
  try {
    mkdirSync(join(dist, "assets"), { recursive: true });
    writeFileSync(join(dist, "index.html"), '<!doctype html><html><head><meta charset="utf-8"><script type="module" crossorigin src="/_app/assets/index-x.js"></script></head><body><div id="root"></div></body></html>');
    writeFileSync(join(dist, "assets", "index-x.js"), "export {}");
    const server = new TsServeProcess(fx.ctx, fx.root, { extra_env: { PES_LOCAL_SESSION_SECRET: SECRET, PES_APP_DIR: dist } });
    try {
      await server.start();
      for (const path of ["/p/synthetic/", "/p/synthetic/e/1/s/plan/r/1", "/_app/index.html"]) {
        for (const method of ["GET", "HEAD"]) {
          const res = await server.request(path, { method });
          assert.equal(res.status, 200, `${method} ${path}`);
          const csp = res.headers["content-security-policy"];
          assert.ok(csp !== undefined, `${method} ${path}: CSP 헤더`);
          const d = directives(csp);
          assert.equal(d.has("sandbox"), false, `${path}: 앱에는 sandbox 가 없다`);
          assert.deepEqual(d.get("base-uri"), ["'none'"], `${path}: base-uri 'none' (${csp})`);
          assert.deepEqual(d.get("object-src"), ["'none'"], `${path}: object-src 'none' (${csp})`);
          const src = d.get("script-src");
          assert.ok(src !== undefined && src.length > 0, `${path}: script-src 가 있다 (${csp})`);
          for (const bad of ["'unsafe-inline'", "'unsafe-eval'", "'unsafe-hashes'", "*", "data:", "blob:", "http:", "https:", "'self'", "'strict-dynamic'"]) {
            assert.ok(!src.includes(bad), `${path}: script-src 에 ${bad} 가 없다 — 폴더의 아무 .js 도 실을 수 없게 (${src.join(" ")})`);
          }
          for (const source of src) {
            assert.match(source, /\/_app\/$/, `${path}: script-src 출처는 /_app/ 경로로 끝난다 (${source})`);
          }
        }
      }
    } finally {
      await server.stop();
    }
  } finally {
    await fx.cleanup();
  }
});
