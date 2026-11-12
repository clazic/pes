/**
 * SEL-86 U1b 후속 B (추가) — 옛 project.json 폴더의 정적 서빙(serve_static)으로 나가는 /<slug>/reports/… · /<slug>/out/… 의 text/html 에도 같은 CSP sandbox.
 *
 * 판정 (leader 지시):
 *  - 슬러그 바로 아래 첫 단어가 reports 또는 out 인 경로의 text/html(GET·HEAD, 쿼리 포함) → `Content-Security-Policy: sandbox allow-scripts allow-popups allow-modals allow-downloads`
 *    (allow-same-origin 없음). PDF·이미지·md 에는 sandbox 가 없다.
 *  - 옛 대시보드 index.html·ask-*.html·그 밖의 폴더의 HTML 은 같은 출처 fetch 가 필요하므로 CSP 가 없다.
 *  - 변형(대소문자 Reports/·%2f·./ ..//·디렉터리 index)도 같은 판정. 심볼릭 링크는 실제 위치가 reports/·out/ 이면 sandbox.
 * 합성 fixture, 임시 HOME·USERPROFILE·PES_HOME. 옛 폴더는 이전(migrate)하지 않는다.
 */

import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { make_cli_env } from "./helpers/cli_write_env.ts";
import { folder_of, plain_legacy, write_legacy } from "./helpers/cli_read_env.ts";
import { raw } from "./helpers/web_raw.ts";
import { start_server } from "./helpers/web_env.ts";

const LEGACY = "synthetic-legacy-csp";
const WANTED = ["allow-downloads", "allow-modals", "allow-popups", "allow-scripts"];
const PAGE = "<!doctype html><title>합성</title><body><script>document.body.dataset.ok = '1'</script>합성 본문</body>";
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const PDF = Buffer.from("%PDF-1.4\n% 합성\n", "utf8");

function csp_of(headers: Record<string, string | string[] | undefined>): string | undefined {
  const v = headers["content-security-policy"];
  return Array.isArray(v) ? v.join(", ") : v;
}

function assert_sandbox(csp: string | undefined, what: string): void {
  assert.ok(csp !== undefined, `${what}: Content-Security-Policy 헤더가 있다`);
  const d = csp.split(";").map((p) => p.trim().split(/\s+/).filter(Boolean)).find((w) => w[0]?.toLowerCase() === "sandbox");
  assert.ok(d !== undefined, `${what}: sandbox 지시어가 있다 (${csp})`);
  assert.deepEqual([...new Set(d.slice(1).map((t) => t.toLowerCase()))].sort(), WANTED, `${what}: 토큰이 정확히 네 개 (${csp})`);
}

test("L1 옛 project.json 폴더: reports/·out/ 의 HTML 만 sandbox, PDF·이미지·md·옛 대시보드·ask 폼·다른 폴더 HTML 은 CSP 없음, 변형·링크 경로도 같은 판정", { timeout: 180_000 }, async () => {
  const c = await make_cli_env();
  try {
    const dir = folder_of(c, LEGACY);
    write_legacy(dir, { ...plain_legacy(LEGACY), topic: "합성 옛 CSP" });
    for (const sub of ["reports/plan", "reports/plan/deep", "out", "notes"]) mkdirSync(join(dir, sub), { recursive: true });
    const put = (rel: string, body: string | Buffer): void => writeFileSync(join(dir, rel), body);
    put("index.html", PAGE);
    put("ask-plan-start.html", PAGE);
    put("notes/free.html", PAGE);
    put("reports/plan/report.html", PAGE);
    put("reports/plan/eli5.html", PAGE);
    put("reports/plan/old.htm", PAGE);
    put("reports/plan/deep/index.html", PAGE);
    put("reports/plan/report.pdf", PDF);
    put("reports/plan/pic.png", PNG);
    put("reports/plan/report.md", "# 합성");
    put("out/report.html", PAGE);
    put("out/index.html", PAGE);
    put("out/pic.png", PNG);
    // 링크: 실제 위치가 reports/ 안이면 sandbox, 밖(notes/)을 가리키면 아니다
    let links = true;
    try {
      symlinkSync(join(dir, "reports", "plan", "report.html"), join(dir, "link-to-report.html"));
      symlinkSync(join(dir, "notes", "free.html"), join(dir, "reports", "plan", "link-to-notes.html"));
    } catch {
      links = false; // 링크를 만들 수 없는 환경(Windows 권한)
    }
    const s = await start_server(c);
    try {
      const get = async (path: string, method = "GET") => raw(s, { method, path });

      // 1 sandbox 가 있어야 하는 주소: 정상·쿼리·HEAD·변형
      const sandboxed = [
        `/${LEGACY}/reports/plan/report.html`,
        `/${LEGACY}/reports/plan/eli5.html`,
        `/${LEGACY}/reports/plan/old.htm`,
        `/${LEGACY}/out/report.html`,
        `/${LEGACY}/reports/plan/report.html?print=1`,
        `/${LEGACY}/out/report.html?x=1`,
        `/${LEGACY}/reports/plan/deep/`,
        `/${LEGACY}/out/`,
        `/${LEGACY}/Reports/plan/report.html`,
        `/${LEGACY}/OUT/report.html`,
        `/${LEGACY}/reports%2fplan%2freport.html`,
        `/${LEGACY}/out%2Freport.html`,
        `/${LEGACY}%2freports/plan/report.html`,
        `/${LEGACY}/./out/report.html`,
        `/${LEGACY}//out/report.html`,
        `/${LEGACY}/notes/../out/report.html`,
        `/${LEGACY}/%72eports/plan/report.html`,
        ...(links ? [`/${LEGACY}/link-to-report.html`] : []),
      ];
      for (const path of sandboxed) {
        for (const method of ["GET", "HEAD"]) {
          const res = await get(path, method);
          // 대소문자 구분 디스크에서 Reports/ 는 404 일 수 있다 — 200 이면 반드시 sandbox
          if (res.status === 404 && /\/(Reports|OUT)\//.test(path)) continue;
          assert.equal(res.status, 200, `${method} ${path}`);
          assert.match(String(res.headers["content-type"]), /^text\/html/, `${method} ${path}: Content-Type 그대로`);
          assert_sandbox(csp_of(res.headers), `${method} ${path}`);
          if (method === "GET") assert.equal(res.text, PAGE, `${path}: 본문 그대로`);
        }
      }

      // 2 CSP 가 없어야 하는 주소: PDF·이미지·md, 옛 대시보드·ask 폼·다른 폴더, 그리고 reports/·out/ 밖을 가리키는 링크 아닌 일반 경로
      const plain = [
        `/${LEGACY}/reports/plan/report.pdf`,
        `/${LEGACY}/reports/plan/pic.png`,
        `/${LEGACY}/reports/plan/report.md`,
        `/${LEGACY}/out/pic.png`,
        `/${LEGACY}/`,
        `/${LEGACY}/index.html`,
        `/${LEGACY}/ask-plan-start.html`,
        `/${LEGACY}/notes/../index.html`,
      ];
      for (const path of plain) {
        for (const method of ["GET", "HEAD"]) {
          const res = await get(path, method);
          assert.equal(res.status, 200, `${method} ${path}`);
          assert.equal(csp_of(res.headers), undefined, `${method} ${path}: CSP 헤더가 없다`);
        }
      }
      // SEL-102: 다른 폴더의 HTML 도 sandbox (예외 화면은 index.html·ask-*.html 뿐)
      for (const method of ["GET", "HEAD"]) {
        const res = await get(`/${LEGACY}/notes/free.html`, method);
        assert.equal(res.status, 200, `${method} notes/free.html`);
        assert_sandbox(csp_of(res.headers), `${method} notes/free.html`);
      }
      const pdf = await get(`/${LEGACY}/reports/plan/report.pdf`);
      assert.ok(pdf.body.equals(PDF), "PDF 바이트 그대로");
      const png = await get(`/${LEGACY}/reports/plan/pic.png`);
      assert.ok(png.body.equals(PNG), "이미지 바이트 그대로");
      assert.match(String(png.headers["content-type"]), /^image\/png/);

      // 3 이름이 비슷할 뿐인 폴더는 아니다 (reports-old/·outbox/ 는 첫 단어가 reports·out 이 아니다)
      mkdirSync(join(dir, "reports-old"), { recursive: true });
      mkdirSync(join(dir, "outbox"), { recursive: true });
      writeFileSync(join(dir, "reports-old", "x.html"), PAGE);
      writeFileSync(join(dir, "outbox", "x.html"), PAGE);
      for (const path of [`/${LEGACY}/reports-old/x.html`, `/${LEGACY}/outbox/x.html`]) {
        const res = await get(path);
        assert.equal(res.status, 200, path);
        assert_sandbox(csp_of(res.headers), `${path}: SEL-102 이름만 비슷한 폴더의 HTML 도 sandbox`);
      }

      // 4 reports/ 밖의 링크가 reports/ 안으로 들어와도(주소가 reports/) 주소 기준으로 sandbox — 안으로 숨길 수 없다
      if (links) {
        const res = await get(`/${LEGACY}/reports/plan/link-to-notes.html`);
        assert.equal(res.status, 200);
        assert_sandbox(csp_of(res.headers), "reports/ 주소의 링크");
      }
    } finally {
      await s.stop();
    }
  } finally {
    c.close();
  }
});
