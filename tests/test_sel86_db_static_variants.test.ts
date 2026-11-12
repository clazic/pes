/**
 * SEL-86 1차 리뷰 필수 1 — DB 프로젝트(이전이 끝나 폴더에 project.json 이 없다)의 폴더에 있는 reports/·out/ 의 HTML·SVG·XML 이 변형 철자
 * (Reports/ · OUT/ · ./ · x/../ · %2e/ · %2f · //)로 열려도 정적 폴백(serve_static)에서 같은 CSP sandbox 를 받는다.
 * 정확한 소문자 철자는 DB 경로(handle_db_get)가 소유하므로(없는 파일이면 404) 여기서는 변형만 본다. 200 이면 반드시 sandbox, 404 도 통과(대소문자 구분 디스크).
 * 그 밖의 폴더(notes/)·PDF·PNG·md 는 CSP 가 없다.
 * 합성 fixture, 임시 HOME·USERPROFILE·PES_HOME.
 */

import assert from "node:assert/strict";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { make_cli_env, SLUG } from "./helpers/cli_write_env.ts";
import { ASK_SPEC, start_server, step, write_spec } from "./helpers/web_env.ts";
import { raw } from "./helpers/web_raw.ts";

const WANTED = ["allow-downloads", "allow-modals", "allow-popups", "allow-scripts"];
const PAGE = "<!doctype html><title>합성</title><body><script>document.body.dataset.ok = '1'</script>합성 본문</body>";
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>try{window.parent.x=sessionStorage.length}catch(e){}</script><rect width="10" height="10"/></svg>`;
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

const csp_of = (headers: Record<string, string | string[] | undefined>): string | undefined => {
  const v = headers["content-security-policy"];
  return Array.isArray(v) ? v.join(", ") : v;
};

function assert_sandbox(csp: string | undefined, what: string): void {
  assert.ok(csp !== undefined, `${what}: Content-Security-Policy 헤더가 있다`);
  const d = csp.split(";").map((p) => p.trim().split(/\s+/).filter(Boolean)).find((w) => w[0]?.toLowerCase() === "sandbox");
  assert.ok(d !== undefined, `${what}: sandbox 지시어가 있다 (${csp})`);
  assert.deepEqual([...new Set(d.slice(1).map((t) => t.toLowerCase()))].sort(), WANTED, `${what}: 토큰이 정확히 네 개 (${csp})`);
}

test("D1 DB 프로젝트(project.json 없음) 폴더의 reports/·out/ HTML·SVG: 변형 철자도 200 이면 sandbox, 밖의 폴더·PDF·PNG 는 CSP 없음", { timeout: 180_000 }, async () => {
  const c = await make_cli_env();
  try {
    unlinkSync(c.project_json);
    step(c, ["ask", SLUG, write_spec(c, ASK_SPEC)]);
    const dir = c.folder;
    for (const sub of ["reports/plan", "out", "notes"]) mkdirSync(join(dir, sub), { recursive: true });
    const put = (rel: string, body: string | Buffer): void => writeFileSync(join(dir, rel), body);
    put("reports/plan/x.html", PAGE);
    put("reports/plan/x.svg", SVG);
    put("out/x.html", PAGE);
    put("out/x.svg", SVG);
    put("reports/plan/x.pdf", "%PDF-1.4\n% 합성\n");
    put("reports/plan/x.png", PNG);
    put("notes/free.html", PAGE);
    const s = await start_server(c);
    try {
      const sandboxed: string[] = [];
      for (const [zone, file] of [["reports/plan", "x.html"], ["reports/plan", "x.svg"], ["out", "x.html"], ["out", "x.svg"]] as const) {
        const head = zone.split("/")[0] as string;
        const tail = zone.includes("/") ? `/${zone.split("/")[1]}` : "";
        sandboxed.push(
          `/${SLUG}/${head[0]?.toUpperCase()}${head.slice(1)}${tail}/${file}`, // Reports/ · Out/
          `/${SLUG}/${head.toUpperCase()}${tail}/${file}`, // REPORTS/ · OUT/
          `/${SLUG}/./${head}${tail}/${file}`,
          `/${SLUG}/x/../${head}${tail}/${file}`,
          `/${SLUG}/%2e/${head}${tail}/${file}`,
          `/${SLUG}//${head}${tail}/${file}`,
          `/${SLUG}/${head}${tail.replace("/", "%2f")}%2f${file}`,
          `/${SLUG}/%72${head.slice(1)}${tail}/${file}`, // %72eports/ · %6frut 은 아래에서 따로
          `/${SLUG}/notes/../${head}${tail}/${file}?x=1`,
        );
      }
      let seen_200 = 0;
      for (const path of sandboxed) {
        for (const method of ["GET", "HEAD"]) {
          const res = await raw(s, { method, path });
          if (res.status === 404) continue; // DB 가 소유하거나 디스크가 대소문자를 구분하면 404 — 그래도 CSP 없는 200 은 아니다
          assert.equal(res.status, 200, `${method} ${path}`);
          seen_200 += 1;
          assert_sandbox(csp_of(res.headers), `${method} ${path}`);
        }
      }
      assert.ok(seen_200 > 0, "변형 주소 중 하나는 정적 폴백으로 200 이어야 시험이 의미가 있다 (./ · x/../ · %2e/ 는 디스크 대소문자와 무관)");
      // 디스크 대소문자와 무관한 변형은 반드시 200
      for (const path of [`/${SLUG}/./reports/plan/x.html`, `/${SLUG}/x/../out/x.html`, `/${SLUG}/%2e/out/x.svg`]) {
        const res = await raw(s, { method: "GET", path });
        assert.equal(res.status, 200, path);
        assert_sandbox(csp_of(res.headers), path);
      }

      // 밖은 CSP 없음
      for (const path of [`/${SLUG}/./notes/free.html`, `/${SLUG}/./reports/plan/x.pdf`, `/${SLUG}/./reports/plan/x.png`]) {
        const res = await raw(s, { method: "GET", path });
        assert.equal(res.status, 200, path);
        assert.equal(csp_of(res.headers), undefined, `${path}: CSP 헤더가 없다`);
      }
    } finally {
      await s.stop();
    }
  } finally {
    c.close();
  }
});

test("D2 reports/·out/ 의 .xml(text/xml, XHTML 네임스페이스면 스크립트가 돈다)도 정적 폴백에서 sandbox, 밖의 .xml 은 CSP 없음", { timeout: 180_000 }, async () => {
  const c = await make_cli_env();
  try {
    unlinkSync(c.project_json);
    step(c, ["ask", SLUG, write_spec(c, ASK_SPEC)]);
    const xml = `<html xmlns="http://www.w3.org/1999/xhtml"><body><script>1</script></body></html>`;
    for (const sub of ["reports/plan", "notes"]) mkdirSync(join(c.folder, sub), { recursive: true });
    writeFileSync(join(c.folder, "reports/plan/a.xml"), xml);
    writeFileSync(join(c.folder, "notes/a.xml"), xml);
    const s = await start_server(c);
    try {
      const inside = await raw(s, { method: "GET", path: `/${SLUG}/./reports/plan/a.xml` });
      assert.equal(inside.status, 200);
      assert.match(String(inside.headers["content-type"]), /^text\/xml/);
      assert_sandbox(csp_of(inside.headers), "reports/ 의 .xml");
      const outside = await raw(s, { method: "GET", path: `/${SLUG}/notes/a.xml` });
      assert.equal(outside.status, 200);
      assert.equal(csp_of(outside.headers), undefined);
    } finally {
      await s.stop();
    }
  } finally {
    c.close();
  }
});
