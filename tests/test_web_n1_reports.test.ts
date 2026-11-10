/**
 * SEL-51 PR18 — 최종 리뷰 2/2 필수 1 회귀 시험 (tester, 작성 모드). 구현 전에는 실패하는 것이 정상이다.
 *   N1 tests/fixtures/legacy/full 사본을 import→validate→activate 한 뒤 DB 모드 서버에서, 대시보드가 광고하는 등록 보고서 URL 이
 *      200 이고 바이트가 DB ready blob·원본과 같다. 없는 경로·다른 프로젝트의 blob 은 여전히 404.
 * 합성 자료, 임시 HOME·USERPROFILE·PES_HOME.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { activated, with_migration } from "./helpers/migration_env.ts";
import { copy_fixture, project_row, run_import } from "./helpers/legacy_env.ts";
import { http, page_data, with_server } from "./helpers/web_env.ts";

const sha = (bytes: Uint8Array | Buffer): string => createHash("sha256").update(bytes).digest("hex");

async function bytes_of(s: { url: string }, path: string): Promise<{ status: number; sha: string; length: number }> {
  const res = await fetch(`${s.url}${path}`, { redirect: "manual" });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, sha: sha(buf), length: buf.length };
}

test("N1 이전·활성화한 프로젝트: 대시보드가 광고하는 등록 보고서 URL 이 200 이고 바이트가 원본·DB ready blob 과 같다; 없는 경로·다른 프로젝트 blob 은 404", async () => {
  await with_migration(async (env, legacy, mig) => {
    const a = await activated(env, legacy, mig, "full", "n1-activate");
    const pid = a.imp.project_id;
    const slug = project_row(env.db, pid).slug;
    assert.ok(slug, "프로젝트에 slug 가 있다");
    // 다른 프로젝트(활성화하지 않은 두 번째 이전)의 blob: 이름이 같든 다르든 이 프로젝트의 URL 로는 나오지 않는다
    const other_dir = copy_fixture(env, "full");
    writeFileSync(join(other_dir, "reports", "plan", "only-other.pdf"), "synthetic bytes that exist only in the other project\n", "utf8");
    const other = { imp: await run_import(env, legacy, other_dir) };
    const foreign = env.db.all<{ original_name: string }>("SELECT DISTINCT original_name FROM blobs WHERE project_id = ? AND state = 'ready' AND original_name IS NOT NULL", other.imp.project_id).map((r) => r.original_name);
    assert.ok(foreign.includes("only-other.pdf"), `다른 프로젝트에만 있는 blob 이 준비됐다: ${foreign.join(", ")}`);
    const c = { env: { home: env.home } };
    await with_server(c, {}, async (s) => {
      const dash = page_data((await http(s, `/${slug}/`)).text);
      // 대시보드가 광고하는 모든 보고서 URL: 단계별 stages.<s>.reports[].path 와 D.outputs(out/<이름>)
      const advertised: string[] = [];
      for (const [key, st] of Object.entries(dash.project.stages as Record<string, any>)) {
        for (const r of (st.reports ?? []) as Array<{ path?: string }>) if (typeof r.path === "string") advertised.push(r.path);
        void key;
      }
      for (const o of ((dash.outputs ?? dash.project.outputs ?? []) as unknown[])) if (typeof o === "string") advertised.push(o);
      assert.ok(advertised.some((p) => p.endsWith("reports/plan/report.pdf")), `plan 의 report.pdf 를 광고한다: ${advertised.join(", ")}`);
      const original = readFileSync(join(a.dir, "reports", "plan", "report.pdf"));
      // DB 쪽 ready blob 도 원본과 같다
      const blob = env.db.get<{ sha256: string }>(
        "SELECT sha256 FROM blobs WHERE project_id = ? AND original_name = 'report.pdf' AND state = 'ready' ORDER BY rowid LIMIT 1",
        pid,
      );
      assert.ok(blob, "DB 에 report.pdf ready blob 이 있다");
      assert.equal(blob.sha256, sha(original), "DB ready blob = 원본");
      // 광고한 URL 은 모두 200 — 404 인 것을 광고하지 않는다. 원본이 있는 것은 바이트도 같다
      for (const path of advertised) {
        const got = await bytes_of(s, `/${slug}/${path}`);
        assert.equal(got.status, 200, `광고한 URL ${path} 는 200 (${got.status})`);
        let orig: Buffer | undefined;
        try {
          orig = readFileSync(join(a.dir, path));
        } catch {
          orig = undefined; // pes report 가 다시 만드는 파일(md/html)은 원본과 바이트가 다를 수 있다
        }
        if (orig !== undefined && !/\.(md|html)$/.test(path)) assert.equal(got.sha, sha(orig), `${path} 바이트가 원본과 같다`);
      }
      const pdf = await bytes_of(s, `/${slug}/reports/plan/report.pdf`);
      assert.equal(pdf.status, 200);
      assert.equal(pdf.sha, sha(original));
      // 경계: 광고하지 않은·없는 경로는 404
      const own_names = new Set(advertised.map((p) => p.split("/").pop()));
      const only_foreign = foreign.filter((n) => !own_names.has(n));
      for (const name of only_foreign) {
        for (const prefix of ["reports/plan/", "out/"]) assert.equal((await bytes_of(s, `/${slug}/${prefix}${name}`)).status, 404, `다른 프로젝트의 ${name} 은 404`);
      }
      for (const bad of ["reports/plan/nope.pdf", "reports/research/report.pdf", "reports/plan/..%2Fproject.json", "reports/nostage/report.pdf", "out/nope.md"]) {
        const r = await bytes_of(s, `/${slug}/${bad}`);
        assert.equal(r.status, 404, `${bad} 는 404 (${r.status})`);
      }
    });
  });
});
