/**
 * SEL-49 PR16 — Codex 최종 1/2 회귀 시험 (tester). 구현 전에는 실패하는 것이 정상이다. 자료는 모두 합성, HOME·USERPROFILE·PES_HOME 은 임시 폴더.
 *   F1  정상 스키마 DB 가 있고 객체 폴더가 없을 때 기본 doctor(플래그 켜짐, --json 포함)는 디스크를 하나도 바꾸지 않는다
 *       (객체 폴더 미생성, DB 파일 바이트·mtime, WAL/SHM 같은 곁가지 파일, PES 홈·~/.pes 트리)
 *   F2  조립본과 같은 바이트가 다른 original_name 으로 먼저 저장돼 있어도(PR9 는 sha256·크기로 blob 을 재사용하고 이름을 안 바꾼다)
 *       assemble 뒤 web 이 성공하고 올바른 파일을 쓴다
 *   S1  64자를 넘는 숫자 토큰 뒤의 필드가 사라지지 않고 v0.15 와 같은 보고서
 */

import assert from "node:assert/strict";
import { cpSync, existsSync, lstatSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

import { put_ready, disk_path } from "./helpers/blob_env.ts";
import { make_cli_env, SLUG, with_cli, type CliEnv } from "./helpers/cli_write_env.ts";
import { baseline_dir, ok, read_lf, run_py, WRITE_ITEMS, write_json, expect_staging } from "./helpers/cli_read_env.ts";
import { FIXTURES, legacy, sha256_of } from "./helpers/legacy_env.ts";
import { backup_dir_of, migration, owner_of, pes_home_of } from "./helpers/migration_env.ts";
import { assemble_manuscript } from "../scripts/pes_core/report.ts";
import { build_project_view } from "../scripts/pes_core/legacy_view.ts";

// ---------------------------------------------------------------------------
// F1

/** 폴더 트리의 모든 항목: 상대 경로·종류·크기·mtime·내용 해시. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const st = lstatSync(full);
      const rel = relative(root, full).split("\\").join("/");
      if (st.isDirectory()) {
        out[rel] = `dir`;
        walk(full);
      } else {
        out[rel] = `${st.size}:${st.mtimeMs}:${sha256_of(readFileSync(full))}`;
      }
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

async function quiet_db_env(mode: "wal" | "delete"): Promise<CliEnv> {
  const c = await make_cli_env();
  rmSync(c.env.objects, { recursive: true, force: true });
  if (mode === "delete") c.env.db.exec("PRAGMA journal_mode = DELETE");
  c.env.db.close(); // 마지막 연결이 닫히면 WAL 곁가지 파일(-wal·-shm)도 정리된다
  return c;
}

for (const mode of ["wal", "delete"] as const) {
  test(`F1 (${mode} 저널) 정상 DB·객체 폴더 없음: 기본 doctor 는 디스크를 바꾸지 않는다 — 객체 폴더·DB 바이트·mtime·곁가지 파일·PES 홈`, async () => {
    const c = await quiet_db_env(mode);
    try {
      const dot_pes = join(c.env.home.root, "home", ".pes");
      const pes_home = c.env.home.env.PES_HOME as string;
      const before = { pes: snapshot(dot_pes), home: snapshot(pes_home) };
      assert.ok(!existsSync(c.env.objects), "시작 상태: 객체 폴더 없음");
      assert.ok(existsSync(join(dot_pes, "pes.db")));
      assert.deepEqual(Object.keys(before.pes).filter((k) => /-(wal|shm|journal)$/.test(k)), [], "시작 상태: 곁가지 파일 없음");
      for (const args of [["doctor", "--json"], ["doctor"], ["doctor", SLUG, "--json"], ["doctor", SLUG]]) {
        const res = run_py(c, args);
        assert.doesNotMatch(res.stderr, /Traceback/, args.join(" "));
        assert.ok(res.stdout.length > 0, `${args.join(" ")}: 진단 출력`);
        assert.ok(!existsSync(c.env.objects), `${args.join(" ")}: 객체 폴더를 만들지 않는다`);
        assert.deepEqual(snapshot(dot_pes), before.pes, `${args.join(" ")}: ~/.pes (DB 바이트·mtime·곁가지 파일) 불변`);
        assert.deepEqual(snapshot(pes_home), before.home, `${args.join(" ")}: PES 홈 불변`);
      }
    } finally {
      c.env.home.cleanup();
    }
  });
}

// ---------------------------------------------------------------------------
// F2

test("F2 조립본·sources.json 과 같은 바이트가 다른 이름으로 먼저 저장돼 있어도 assemble 뒤 web 이 성공하고 그 파일들을 쓴다", () =>
  with_cli(async (c) => {
    ok(run_py(c, ["merge", SLUG, "write", write_json(c, "f2.json", WRITE_ITEMS)]), "merge write");
    // 리뷰의 재현: assemble 이 만들 바이트를 이름만 다르게('합성.bin') 먼저 올린다
    const asm = assemble_manuscript(build_project_view(c.env.db, c.env.p.project_id, c.env.objects).project);
    const md = new TextEncoder().encode(asm.markdown);
    const src = new TextEncoder().encode(JSON.stringify(asm.sources, null, 1));
    const pre_md = await put_ready(c.env, md, "f2-md");
    const pre_src = await put_ready(c.env, src, "f2-src");
    assert.equal(c.env.db.get<{ original_name: string }>("SELECT original_name FROM blobs WHERE id = ?", pre_md.blob_id)?.original_name, "합성.bin");

    const assembled = ok(run_py(c, ["assemble", SLUG]), "assemble");
    assert.match(assembled.stdout, /\(장·절 1개, 각주 2개\)/);
    const web = ok(run_py(c, ["web", SLUG]), "web (조립본 재사용)");
    assert.match(web.stdout, /\(출처 2개 · 확인됨 1개/, `출처 목록이 비지 않는다: ${web.stdout}`);

    const object = c.env.db.get<{ object_id: string }>("SELECT object_id FROM artifacts WHERE kind = 'output'")!.object_id;
    const versions = c.env.db.all<{ id: string }>("SELECT id FROM object_versions WHERE object_id = ? ORDER BY version_no", object).map((r) => r.id);
    assert.equal(versions.length, 2, "assemble 버전과 web 버전");
    const sha_of = (version_id: string) =>
      c.env.db.all<{ sha256: string; role: string }>("SELECT b.sha256 AS sha256, vf.role AS role FROM version_files vf JOIN blobs b ON b.id = vf.blob_id WHERE vf.version_id = ?", version_id);
    for (const [i, id] of versions.entries()) {
      const files = sha_of(id);
      assert.ok(files.every((f) => f.role === "rendered"));
      assert.ok(files.some((f) => f.sha256 === sha256_of(md)), `버전 ${i + 1}: 조립 마크다운 바이트가 붙어 있다`);
      assert.ok(files.some((f) => f.sha256 === sha256_of(src)), `버전 ${i + 1}: sources.json 바이트가 붙어 있다`);
    }
    // web 의 html 은 그 조립본을 그대로 담고, 출처가 비어 있지 않다
    const html_row = c.env.db.get<{ storage_key: string }>("SELECT b.storage_key AS storage_key FROM version_files vf JOIN blobs b ON b.id = vf.blob_id WHERE vf.version_id = ? AND b.sha256 NOT IN (?, ?)", versions[1]!, sha256_of(md), sha256_of(src))!;
    const html = readFileSync(disk_path(c.env, html_row), "utf8");
    assert.match(html, /합성 출처 A/);
    assert.match(html, /합성 출처 C/);
    assert.ok(pre_src.blob_id.length > 0);
  }));

// ---------------------------------------------------------------------------
// S1

function legacy_home_with_real_report(c: CliEnv, slug: string, edit: (text: string) => string, after: (text: string) => string = (t) => t): string {
  const base = baseline_dir();
  assert.notEqual(base, null, "기준 커밋 03fc81b 가 없다 (CI 는 fetch-depth: 0)");
  const dir = join(c.env.home.env.PES_HOME as string, slug);
  cpSync(join(FIXTURES, "full"), dir, { recursive: true });
  const json = join(dir, "project.json");
  writeFileSync(json, edit(readFileSync(json, "utf8").replace('"slug": "synthetic-legacy-full"', `"slug": "${slug}"`)), "utf8");
  const res = run_py(c, ["report", slug, "plan"], { flag: undefined, script: join(base!, "scripts", "pes.py") });
  assert.equal(res.status, 0, res.stderr + res.stdout);
  const md_path = join(dir, "reports", "plan", "report.md");
  const html_path = join(dir, "reports", "plan", "report.html");
  const md = readFileSync(md_path, "utf8");
  const stamp = md.match(/- 작성 (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) · PES/)?.[1];
  assert.ok(stamp);
  writeFileSync(md_path, md.split(stamp).join("2001-01-01 00:00"), "utf8");
  writeFileSync(html_path, readFileSync(html_path, "utf8").split(stamp).join("2001-01-01 00:00"), "utf8");
  // v0.15 의 report 는 project.json 을 다시 저장(json.dump)해 토큰 표기를 정리한다 — 원문 토큰은 보고서를 만든 뒤에 되돌려 넣는다
  writeFileSync(json, after(readFileSync(json, "utf8")), "utf8");
  return dir;
}

test("S1 64자가 넘는 숫자 토큰(1.2345000…e-20) 뒤의 필드가 사라지지 않는다: v0.15 와 같은 보고서·검증 일치·DB 보고서도 같은 줄", () =>
  with_cli(async (c) => {
    const short = "1.2345e-20";
    const long_token = `1.2345${"0".repeat(70)}e-20`; // 같은 값, 토큰 길이 > 64
    const dir = legacy_home_with_real_report(
      c,
      "s1-long-number",
      (text) => {
        const p = JSON.parse(text);
        p.stages.plan.items[0].stats = [
          { value: "__L1__", unit: "%", period: "2025", name: "긴 지수 지표", method: "추정" },
          { value: "__F1__", unit: "건", period: "2027", name: "뒤의 실수 지표", method: "추정" },
        ];
        // 긴 토큰 뒤의 다른 항목에도 정수형 실수가 있다
        p.stages.plan.items[1].stats = [{ value: "__F2__", unit: "명", period: "2028", name: "다음 항목 실수 지표", method: "추정" }];
        return JSON.stringify(p).replace('"__L1__"', short).replace('"__F1__"', "12.0").replace('"__F2__"', "7.0");
      },
      (text) => {
        assert.equal(text.split(short).length, 2, "v0.15 가 다시 저장한 project.json 에 짧은 토큰이 한 번 있다");
        const out = text.replace(short, long_token);
        JSON.parse(out); // 여전히 올바른 JSON
        assert.ok(out.includes(long_token) && long_token.length > 64);
        return out;
      },
    );
    const original = read_lf(join(dir, "reports", "plan", "report.md"));
    const line = (md: string, name: string) => md.split("\n").find((l) => l.startsWith(`| ${name} |`));
    const l1 = line(original, "긴 지수 지표");
    assert.match(l1 ?? "", /\| 1\.2345e-20 % \| 2025 \|/, "v0.15: 값 뒤의 unit·period 가 그대로");
    assert.match(line(original, "뒤의 실수 지표") ?? "", /\| 12\.0 건 \| 2027 \|/, "v0.15: 긴 토큰 뒤의 12.0");
    assert.match(line(original, "다음 항목 실수 지표") ?? "", /\| 7\.0 명 \| 2028 \|/);
    const api = await legacy();
    const mig = await migration();
    const imp = await api.import_project(c.env.service, dir, { owner_actor_id: owner_of(c.env) });
    expect_staging(imp, dir, "test_cli_read_final1.test.ts#1");
    assert.equal(imp.state, "staging");
    const val = await mig.validate_import(c.env.service, imp.batch_id, { owner_actor_id: owner_of(c.env), source_dir: dir });
    assert.equal(val.ok, true, JSON.stringify(val.report.problems));
    assert.equal(val.report.regenerated_reports.find((r) => r.path === "reports/plan/report.md")?.matches, true);
    assert.equal(val.report.regenerated_reports.find((r) => r.path === "reports/plan/report.html")?.matches, true);
    await mig.activate_import(c.env.service, imp.batch_id, { owner_actor_id: owner_of(c.env), backup_dir: backup_dir_of(c.env, "s1"), pes_home: pes_home_of(c.env) });
    ok(run_py(c, ["report", "s1-long-number", "plan"]), "report (DB)");
    const md = c.env.db
      .all<{ storage_key: string }>(
        `SELECT b.storage_key AS storage_key FROM version_files vf JOIN blobs b ON b.id = vf.blob_id
          JOIN artifacts a ON a.object_id = (SELECT object_id FROM object_versions WHERE id = vf.version_id)
         WHERE a.kind = 'report' AND b.original_name = 'report.md' ORDER BY vf.rowid DESC`,
      )
      .map((r) => readFileSync(disk_path(c.env, r), "utf8"))[0];
    assert.ok(md);
    for (const name of ["긴 지수 지표", "뒤의 실수 지표", "다음 항목 실수 지표"]) assert.equal(line(md, name), line(original, name), `${name}: DB 보고서의 같은 줄`);
  }));
