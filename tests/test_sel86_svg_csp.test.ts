/**
 * SEL-86 U1b 후속 B (추가 3) — reports·out 의 SVG(image/svg+xml)에도 같은 CSP sandbox.
 * SVG 를 주소로 직접 열면 같은 출처 문서로 스크립트가 돈다(AI 가 만든 SVG 가 sessionStorage 를 읽을 수 있다). <img> 로 넣는 표시는 문서가 아니므로 그대로 동작한다
 * (그 e2e 확인은 tests/e2e/sel86_svg_sandbox.spec.ts). PDF·래스터 이미지는 sandbox 가 없다(Chromium PDF 뷰어는 sandbox 된 문서에서 막힌다).
 *
 *  V1 DB 프로젝트(옛 프로젝트를 이전한 보고서): reports/plan/diagram.svg → Content-Type image/svg+xml, sandbox 네 토큰(allow-same-origin 없음), 바이트 그대로, GET·HEAD·쿼리.
 *     같은 보고서 폴더의 PDF 에는 sandbox 가 없다.
 *  V2 옛 project.json 폴더(정적 서빙): reports/·out/ 의 .svg(대소문자 .SVG·%2f·Reports/·링크 포함)는 sandbox, 그 밖의 폴더·루트의 .svg 와 PNG 는 아니다.
 * 합성 fixture, 임시 HOME·USERPROFILE·PES_HOME.
 */

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { backup_dir_of, owner_of, pes_home_of, with_migration } from "./helpers/migration_env.ts";
import { copy_fixture, project_row, run_import } from "./helpers/legacy_env.ts";
import { make_cli_env } from "./helpers/cli_write_env.ts";
import { folder_of, plain_legacy, write_legacy } from "./helpers/cli_read_env.ts";
import { raw } from "./helpers/web_raw.ts";
import { start_server, with_server } from "./helpers/web_env.ts";

const WANTED = ["allow-downloads", "allow-modals", "allow-popups", "allow-scripts"];
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

test("V1 DB 프로젝트의 reports/…/*.svg: image/svg+xml 그대로, sandbox 네 토큰(allow-same-origin 없음), 바이트 그대로 · PDF 는 sandbox 없음", { timeout: 180_000 }, async () => {
  await with_migration(async (env, legacy, mig) => {
    // "full" 합성 fixture 를 복사해 기획 보고서에 SVG 한 건을 더 등록한다(project.json 의 reports 목록 + 파일)
    const dir = copy_fixture(env, "full");
    writeFileSync(join(dir, "reports", "plan", "diagram.svg"), SVG, "utf8");
    const file = join(dir, "project.json");
    const pj = JSON.parse(readFileSync(file, "utf8"));
    pj.stages.plan.reports.push({ format: "svg", label: "합성 도해", path: "reports/plan/diagram.svg", bytes: Buffer.byteLength(SVG), round: 1 });
    writeFileSync(file, JSON.stringify(pj, null, 1), "utf8");
    const imp = await run_import(env, legacy, dir);
    assert.equal(imp.state, "staging");
    const val = await mig.validate_import(env.service, imp.batch_id, { owner_actor_id: owner_of(env), source_dir: dir });
    assert.equal(val.ok, true, JSON.stringify(val.report.problems));
    const act = await mig.activate_import(env.service, imp.batch_id, { owner_actor_id: owner_of(env), backup_dir: backup_dir_of(env, "sel86-svg"), pes_home: pes_home_of(env) });
    assert.equal(act.state, "activated");
    const slug = project_row(env.db, imp.project_id).slug;
    assert.ok(slug);
    await with_server({ env: { home: env.home } }, {}, async (s) => {
      for (const suffix of ["", "?x=1", "?print=1"]) {
        for (const method of ["GET", "HEAD"]) {
          const res = await raw(s, { method, path: `/${slug}/reports/plan/diagram.svg${suffix}` });
          assert.equal(res.status, 200, `${method} diagram.svg${suffix}`);
          assert.match(String(res.headers["content-type"]), /^image\/svg\+xml/, "Content-Type image/svg+xml");
          assert_sandbox(csp_of(res.headers), `${method} diagram.svg${suffix}`);
          if (method === "GET") assert.equal(res.text, SVG, "SVG 바이트 그대로");
        }
      }
      const pdf = await raw(s, { path: `/${slug}/reports/plan/report.pdf` });
      assert.equal(pdf.status, 200);
      assert.equal(csp_of(pdf.headers), undefined, "PDF 에는 CSP 가 없다");
    });
  });
});

test("V2 옛 project.json 폴더: reports/·out/ 의 .svg 만 sandbox (변형·링크 포함), 다른 폴더·루트의 svg 와 PNG 는 CSP 없음", { timeout: 180_000 }, async () => {
  const legacy = "synthetic-legacy-svg";
  const c = await make_cli_env();
  try {
    const dir = folder_of(c, legacy);
    write_legacy(dir, { ...plain_legacy(legacy), topic: "합성 옛 SVG" });
    for (const sub of ["reports/plan", "out", "notes"]) mkdirSync(join(dir, sub), { recursive: true });
    const put = (rel: string, body: string | Buffer): void => writeFileSync(join(dir, rel), body);
    put("reports/plan/d.svg", SVG);
    put("reports/plan/UP.SVG", SVG);
    put("reports/plan/p.png", PNG);
    put("out/d.svg", SVG);
    put("out/p.png", PNG);
    put("notes/d.svg", SVG);
    put("root.svg", SVG);
    let links = true;
    try {
      symlinkSync(join(dir, "reports", "plan", "d.svg"), join(dir, "link.svg"));
    } catch {
      links = false;
    }
    const s = await start_server(c);
    try {
      const sandboxed = [
        `/${legacy}/reports/plan/d.svg`,
        `/${legacy}/reports/plan/UP.SVG`,
        `/${legacy}/out/d.svg`,
        `/${legacy}/out/d.svg?x=1`,
        `/${legacy}/reports%2fplan%2fd.svg`,
        `/${legacy}/notes/../out/d.svg`,
        ...(links ? [`/${legacy}/link.svg`] : []),
      ];
      for (const path of sandboxed) {
        for (const method of ["GET", "HEAD"]) {
          const res = await raw(s, { method, path });
          assert.equal(res.status, 200, `${method} ${path}`);
          assert.match(String(res.headers["content-type"]), /^image\/svg\+xml/, `${method} ${path}`);
          assert_sandbox(csp_of(res.headers), `${method} ${path}`);
          if (method === "GET") assert.equal(res.text, SVG, `${path}: 바이트 그대로`);
        }
      }
      const upper = await raw(s, { path: `/${legacy}/Reports/plan/d.svg` });
      if (upper.status === 200) assert_sandbox(csp_of(upper.headers), "대소문자 디스크의 Reports/");
      // SEL-102: 다른 폴더·루트의 svg 도 sandbox (PNG 는 계속 CSP 없음)
      for (const path of [`/${legacy}/notes/d.svg`, `/${legacy}/root.svg`]) {
        const res = await raw(s, { path });
        assert.equal(res.status, 200, path);
        assert_sandbox(csp_of(res.headers), path);
      }
      for (const path of [`/${legacy}/reports/plan/p.png`, `/${legacy}/out/p.png`]) {
        const res = await raw(s, { path });
        assert.equal(res.status, 200, path);
        assert.equal(csp_of(res.headers), undefined, `${path}: CSP 가 없다`);
      }
      assert.ok((await raw(s, { path: `/${legacy}/reports/plan/p.png` })).body.equals(PNG), "PNG 바이트 그대로");
    } finally {
      await s.stop();
    }
  } finally {
    c.close();
  }
});
