/**
 * SEL-49 PR16 — 1차 리뷰(r1-1) 회귀 시험 (tester). 구현 전에는 실패하는 것이 정상이다. 자료는 모두 합성, HOME·USERPROFILE·PES_HOME 은 임시 폴더.
 * 번호는 리뷰의 번호를 따른다.
 *   1  설정 표 라벨: v0.15 는 질문 은행 라벨만 쓴다(EXTRA 필드 client_city 등은 키 그대로)
 *   2  DB 판정 실패(읽을 수 없는·깨진 DB)는 legacy 로 넘어가지 않고 오류·0 아닌 종료. DB 파일 자체가 없으면 legacy
 *   3  CRLF 로 저장된 옛 보고서도 같다고 보고, 새 보고서 파일은 LF
 *   4  stats 값 12.0 이 v0.15 처럼 12.0 (검증·DB 보고서 모두)
 *   5  via 가 import 가 아닌 답(web·http)도 pending 에 보인다
 *   6  플래그 켜짐 + 홈 안 legacy(미전환·staging)에 doctor --fix 는 쓰기 0
 *   7  새 판이 active 가 되면 assemble 은 새 판의 output 객체에 쌓는다
 *   9  created 는 로컬 날짜 (TZ 고정)
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { create_edition } from "../scripts/pes_core/editions.ts";
import { disk_path } from "./helpers/blob_env.ts";
import { REPO, SLUG, with_cli, type CliEnv, type CliResult } from "./helpers/cli_write_env.ts";
import { legacy_home_with_real_report, read_lf, run_cli, write_legacy, type HomeLike, expect_staging } from "./helpers/cli_read_env.ts";
import { FIXTURES, legacy, tree_digest } from "./helpers/legacy_env.ts";
import { backup_dir_of, migration, owner_of, pes_home_of } from "./helpers/migration_env.ts";
import { isolated_home } from "./helpers/isolated_home.ts";

const WIN = process.platform === "win32";

function ok(res: CliResult, what: string): CliResult {
  assert.equal(res.status, 0, `${what}: exit ${res.status}\n${res.stderr}${res.stdout}`);
  assert.doesNotMatch(res.stderr, /Traceback/, what);
  return res;
}

function write_json(c: { env: { home: { root: string } } }, name: string, value: unknown): string {
  const file = join(c.env.home.root, name);
  writeFileSync(file, JSON.stringify(value), "utf8");
  return file;
}

// legacy_home_with_real_report(c, slug, edit): fixture `full` + 0.15(03fc81b) `report plan` 이 만든 보고서 기록 (tests/fixtures/legacy_reports — SEL-74: 0.15 코드는 없어 고정 기록을 쓴다)

async function import_validate(c: CliEnv, dir: string) {
  const api = await legacy();
  const mig = await migration();
  const imp = await api.import_project(c.env.service, dir, { owner_actor_id: owner_of(c.env) });
  expect_staging(imp, dir, "test_cli_read_review1.test.ts#1");
  assert.equal(imp.state, "staging");
  const val = await mig.validate_import(c.env.service, imp.batch_id, { owner_actor_id: owner_of(c.env), source_dir: dir });
  return { imp, val, mig };
}

function matches(val: { report: { regenerated_reports: Array<{ path: string; matches: boolean }> } }, path: string): boolean | undefined {
  return val.report.regenerated_reports.find((r) => r.path === path)?.matches;
}

// ---------------------------------------------------------------------------
// 1

test("R1 설정 표: EXTRA 필드(client_city·asof·official)는 v0.15 처럼 키 그대로 — 옛 보고서와 재생성본이 같고 이전이 막히지 않는다", () =>
  with_cli(async (c) => {
    const dir = legacy_home_with_real_report(c, "r1-settings", (text) => {
      const p = JSON.parse(text);
      p.stages.plan.settings = { client_city: "ulsan", asof: "2026-01-01", official: "self", seoul_station: "split" };
      return JSON.stringify(p);
    });
    const original = read_lf(join(dir, "reports", "plan", "report.md")); // Windows v0.15 파일은 CRLF
    assert.match(original, /^\| client_city \| ulsan \|$/m, "v0.15 는 EXTRA 라벨을 쓰지 않는다 (키 그대로)");
    assert.match(original, /^\| asof \| 2026-01-01 \|$/m);
    const { val } = await import_validate(c, dir);
    assert.equal(val.ok, true, JSON.stringify(val.report.problems));
    assert.equal(matches(val, "reports/plan/report.md"), true);
    assert.equal(matches(val, "reports/plan/report.html"), true);
  }));

// ---------------------------------------------------------------------------
// 2

const STALE_TOPIC = "합성 옛 주제";

test("R2 읽을 수 없는 DB 파일이면 status·pending·digest·show·list 가 낡은 project.json 을 보이지 않고 0 아닌 종료로 끝난다", { skip: WIN || process.getuid?.() === 0 }, () =>
  with_cli(async (c) => {
    chmodSync(c.env.db.path, 0o000);
    try {
      for (const args of [["status", SLUG], ["pending", SLUG], ["digest", SLUG, "plan"], ["show", SLUG, "plan"], ["list"]]) {
        const res = run_cli(c, args);
        assert.notEqual(res.status, 0, `${args[0]}: DB 를 못 읽으면 실패해야 한다 (stdout: ${res.stdout})`);
        assert.doesNotMatch(res.stdout + res.stderr, /Traceback/, args[0]);
        assert.ok(!res.stdout.includes(STALE_TOPIC), `${args[0]}: 낡은 project.json 의 주제를 현재 상태처럼 보이면 안 된다`);
        assert.ok(res.stderr.trim().length > 0, `${args[0]}: 이유를 알리는 메시지`);
      }
    } finally {
      chmodSync(c.env.db.path, 0o600);
    }
  }));

test("R2b 깨진 DB 파일이면 읽기 명령이 실패한다 (플랫폼 무관). DB 파일이 아예 없으면 legacy 읽기가 된다", () => {
  const home = isolated_home("pes-sel49-r2-");
  try {
    const like: HomeLike = { env: { home } };
    const pes_home = home.env.PES_HOME as string;
    write_legacy(join(pes_home, "alpha"), { pes: 1, topic: "낡은 주제", slug: "alpha", current: "plan", processed: [], notes: [], stages: {} });
    const db = join(home.root, "home", ".pes", "pes.db");
    // DB 없음: legacy
    const none = run_cli(like, ["status", "alpha"]);
    assert.equal(none.status, 0, none.stderr);
    assert.match(none.stdout, /주제: 낡은 주제/);
    assert.ok(!existsSync(db), "읽기는 DB 를 만들지 않는다");
    // 깨진 DB
    mkdirSync(join(home.root, "home", ".pes"), { recursive: true });
    writeFileSync(db, "이것은 SQLite 파일이 아니다 ".repeat(40), "utf8");
    const before = readFileSync(db);
    for (const args of [["status", "alpha"], ["pending", "alpha"], ["digest", "alpha", "plan"], ["show", "alpha", "plan"], ["list"]]) {
      const res = run_cli(like, args);
      assert.notEqual(res.status, 0, `${args[0]} (깨진 DB): ${res.stdout}`);
      assert.ok(!res.stdout.includes("낡은 주제"), `${args[0]}: 낡은 값을 보이지 않는다`);
      assert.doesNotMatch(res.stderr, /Traceback/);
    }
    assert.ok(readFileSync(db).equals(before), "DB 파일 불변");
  } finally {
    home.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 3

test("R3 옛 보고서가 CRLF 로 저장돼 있어도(Windows·autocrlf) 같다고 본다", () =>
  with_cli(async (c) => {
    const dir = legacy_home_with_real_report(c, "r3-crlf", (text) => text);
    for (const name of ["report.md", "report.html"]) {
      const file = join(dir, "reports", "plan", name);
      writeFileSync(file, readFileSync(file, "utf8").replace(/\r?\n/g, "\r\n"), "utf8");
    }
    assert.ok(readFileSync(join(dir, "reports", "plan", "report.md"), "utf8").includes("\r\n"));
    const { val } = await import_validate(c, dir);
    assert.equal(val.ok, true, JSON.stringify(val.report.problems));
    assert.equal(matches(val, "reports/plan/report.md"), true);
    assert.equal(matches(val, "reports/plan/report.html"), true);
  }));

test("R3b CRLF 와 LF 가 섞인 옛 보고서도 같고, 내용이 다른 CRLF 보고서는 여전히 문제다", () =>
  with_cli(async (c) => {
    const dir = legacy_home_with_real_report(c, "r3-mixed", (text) => text);
    const file = join(dir, "reports", "plan", "report.md");
    const lines = readFileSync(file, "utf8").split("\n");
    writeFileSync(file, lines.map((l, i) => (i % 2 === 0 ? `${l}\r` : l)).join("\n"), "utf8");
    const { val } = await import_validate(c, dir);
    assert.equal(val.ok, true, JSON.stringify(val.report.problems));
    const dir2 = legacy_home_with_real_report(c, "r3-edited", (text) => text);
    writeFileSync(join(dir2, "reports", "plan", "report.md"), "# 고친 보고서\r\n본문\r\n", "utf8");
    const second = await import_validate(c, dir2);
    assert.equal(second.val.ok, false, "줄바꿈만 무시하고 내용 차이는 잡는다");
  }));

test("R3c 새 보고서·assemble·web 파일은 LF 만 쓴다 (\\r 없음)", () =>
  with_cli(async (c) => {
    ok(run_cli(c, ["round-start", SLUG, "plan"]), "round-start");
    ok(run_cli(c, ["merge", SLUG, "plan", write_json(c, "r3c.json", [{ id: 1, kind: "topic", title: "항목", summary: "요약\n둘째 줄", sources: [{ title: "출처", url: "https://example.invalid/a", method: "law" }] }])]), "merge");
    ok(run_cli(c, ["merge", SLUG, "write", write_json(c, "r3c-w.json", [{ id: 1, kind: "section", title: "1장", status: "done", details: "본문\n줄 [^1]", sources: [{ title: "출처", url: "https://example.invalid/a", method: "law" }] }])]), "merge write");
    ok(run_cli(c, ["report", SLUG, "plan"]), "report");
    ok(run_cli(c, ["web", SLUG, "--assemble"]), "web");
    const rows = c.env.db.all<{ original_name: string; storage_key: string }>("SELECT DISTINCT b.original_name, b.storage_key FROM version_files vf JOIN blobs b ON b.id = vf.blob_id WHERE vf.role = 'rendered'");
    assert.ok(rows.length >= 4, `렌더 파일들: ${rows.map((r) => r.original_name)}`);
    for (const row of rows) assert.ok(!readFileSync(disk_path(c.env, row), "utf8").includes("\r"), `${row.original_name} 에 \\r 이 없다`);
  }));

// ---------------------------------------------------------------------------
// 4

test("R4 stats 값 12.0 은 v0.15 처럼 12.0 이다: 검증이 거짓 불일치를 올리지 않고 DB 보고서도 12.0 으로 보인다", () =>
  with_cli(async (c) => {
    const dir = legacy_home_with_real_report(c, "r4-float", (text) => {
      const p = JSON.parse(text);
      p.stages.plan.items[0].stats = [{ name: "합성 지표", value: "__F12__", unit: "%", period: "2025", method: "추정" }, { name: "정수 지표", value: "__F7__", unit: "개", period: "2025", method: "추정" }];
      return JSON.stringify(p).replace('"__F12__"', "12.0").replace('"__F7__"', "7");
    });
    const original = read_lf(join(dir, "reports", "plan", "report.md")); // Windows v0.15 파일은 CRLF
    assert.match(original, /^\| 합성 지표 \| 12\.0 % \|/m, "v0.15 는 12.0");
    assert.match(original, /^\| 정수 지표 \| 7 개 \|/m);
    const { imp, val, mig } = await import_validate(c, dir);
    assert.equal(val.ok, true, JSON.stringify(val.report.problems));
    assert.equal(matches(val, "reports/plan/report.md"), true);
    await mig.activate_import(c.env.service, imp.batch_id, { owner_actor_id: owner_of(c.env), backup_dir: backup_dir_of(c.env, "r4"), pes_home: pes_home_of(c.env) });
    ok(run_cli(c, ["report", "r4-float", "plan"]), "report (DB)");
    const md = c.env.db
      .all<{ original_name: string; storage_key: string }>(
        `SELECT b.original_name, b.storage_key FROM version_files vf JOIN blobs b ON b.id = vf.blob_id
          JOIN artifacts a ON a.object_id = (SELECT object_id FROM object_versions WHERE id = vf.version_id)
         WHERE a.kind = 'report' AND b.original_name = 'report.md' ORDER BY vf.rowid DESC`,
      )
      .map((r) => readFileSync(disk_path(c.env, r), "utf8"))[0];
    assert.ok(md, "DB 보고서 마크다운");
    assert.match(md, /^\| 합성 지표 \| 12\.0 % \|/m, "DB 보고서도 12.0");
    assert.match(md, /^\| 정수 지표 \| 7 개 \|/m);
  }));

// ---------------------------------------------------------------------------
// 5

test("R5 via 가 web·http 인 처리 안 한 답도 pending·status 에 보인다", () =>
  with_cli(async (c) => {
    const slug = "r5-via";
    const dir = join(c.env.home.env.PES_HOME as string, slug);
    cpSync(join(FIXTURES, "full"), dir, { recursive: true });
    writeFileSync(join(dir, "project.json"), readFileSync(join(dir, "project.json"), "utf8").replace('"slug": "synthetic-legacy-full"', `"slug": "${slug}"`), "utf8");
    const { imp, val, mig } = await import_validate(c, dir);
    assert.equal(val.ok, true, JSON.stringify(val.report.problems));
    await mig.activate_import(c.env.service, imp.batch_id, { owner_actor_id: owner_of(c.env), backup_dir: backup_dir_of(c.env, "r5"), pes_home: pes_home_of(c.env) });
    const names = () => ok(run_cli(c, ["pending", slug]), "pending").stdout.trim().split("\n").filter(Boolean).map((l) => l.trim().split(/[\\/]/).pop());
    const before = names();
    assert.equal(before.length, 2, `처리 안 한 답 2개: ${before}`);
    const subs = c.env.db.all<{ id: string }>("SELECT s.id FROM submissions s JOIN blobs b ON b.id = s.raw_blob_id WHERE s.via = 'import' AND b.original_name IN (?, ?)", before[0]!, before[1]!);
    assert.equal(subs.length, 2);
    for (const [i, via] of (["web", "http"] as const).entries()) c.env.db.run("UPDATE submissions SET via = ? WHERE id = ?", via, subs[i]!.id);
    assert.deepEqual(names(), before, "via 가 web·http 여도 같은 답이 처리 대기로 보인다");
    assert.match(ok(run_cli(c, ["status", slug]), "status").stdout, /처리 안 한 답: 2개/);
  }));

// ---------------------------------------------------------------------------
// 6

test("R6 홈 안 legacy: doctor --fix 는 폴더에 아무것도 쓰지 않는다 (미전환·staging 모두)", () =>
  with_cli(async (c) => {
    const home = c.env.home.env.PES_HOME as string;
    // 미전환: 고칠 수 있는 흔적이 전부 있는 폴더
    const plain = join(home, "r6-plain");
    write_legacy(plain, { pes: 1, topic: "합성", slug: "r6-plain", current: "research", processed: [], notes: [], stages: { plan: { status: "approved", round: 1, items: [], reports: [{ format: "md", label: "x", path: "reports/plan/report.md", round: 1 }] } } });
    writeFileSync(join(plain, "project.json.tmp"), "{", "utf8");
    writeFileSync(join(plain, ".pes-lock"), JSON.stringify({ owner: "sess-x", at: 1, since: "2020-01-01 00:00" }), "utf8");
    writeFileSync(join(plain, ".pes-port"), "1", "utf8");
    // staging: 가져오기만 한 프로젝트 (fixture 에 .tmp·잠금이 있다)
    const staged = join(home, "r6-staged");
    cpSync(join(FIXTURES, "full"), staged, { recursive: true });
    writeFileSync(join(staged, "project.json"), readFileSync(join(staged, "project.json"), "utf8").replace('"slug": "synthetic-legacy-full"', '"slug": "r6-staged"'), "utf8");
    const api = await legacy();
    const imp = await api.import_project(c.env.service, staged, { owner_actor_id: owner_of(c.env) });
    expect_staging(imp, staged, "test_cli_read_review1.test.ts#2");
    assert.equal(imp.state, "staging");
    const trees = [tree_digest(plain), tree_digest(staged)];
    const sigs = [c.sig(join(plain, "project.json")), c.sig(join(staged, "project.json"))];
    for (const args of [["doctor", "--fix", "--json"], ["doctor", "r6-plain", "--fix", "--json"], ["doctor", "r6-staged", "--fix", "--json"]]) {
      const res = run_cli(c, args);
      assert.doesNotMatch(res.stderr, /Traceback/);
      const rows = JSON.parse(res.stdout) as Array<{ group: string; fixed?: boolean }>;
      assert.ok(!rows.some((r) => (r.group === "r6-plain" || r.group === "r6-staged") && r.fixed === true), `${args.join(" ")}: legacy 행은 고치지 않는다`);
    }
    assert.deepEqual([tree_digest(plain), tree_digest(staged)], trees, "폴더 내용 불변");
    assert.deepEqual([c.sig(join(plain, "project.json")), c.sig(join(staged, "project.json"))], sigs, "project.json 바이트·mtime 불변");
    // (0.15 의 '--fix 가 legacy 폴더의 임시 파일을 지운다' 는 TS 에 없다: D14 — 옛 폴더는 읽기 전용, doctor --fix 도 쓰지 않는다. 위 단언이 그 보장이다.)
  }));

// ---------------------------------------------------------------------------
// 7

test("R7 새 판이 active 가 되면 assemble·web 은 새 판의 output 객체에 쌓고 옛 판의 객체는 그대로다", () =>
  with_cli(async (c) => {
    const item = (title: string) => [{ id: 1, kind: "section", title, status: "done", details: "본문 [^1]", sources: [{ title: "출처", url: "https://example.invalid/a", method: "law" }] }];
    ok(run_cli(c, ["merge", SLUG, "write", write_json(c, "r7a.json", item("옛 판 장"))]), "merge (판 1)");
    ok(run_cli(c, ["assemble", SLUG]), "assemble (판 1)");
    const outputs = () => c.env.db.all<{ object_id: string; edition_id: string; n: bigint }>(
      "SELECT a.object_id AS object_id, o.edition_id AS edition_id, (SELECT count(*) FROM object_versions WHERE object_id = a.object_id) AS n FROM artifacts a JOIN objects o ON o.id = a.object_id WHERE a.kind = 'output' ORDER BY a.rowid",
    );
    const first = outputs();
    assert.equal(first.length, 1);
    assert.equal(first[0]!.edition_id, c.env.p.edition_id);
    // 새 판을 만들어 active 로 올린다
    const created = (await create_edition(c.env.service, c.env.ctx("r7-ed2"), { parent_edition_id: c.env.p.edition_id })).result as { edition_id: string };
    c.env.db.run("UPDATE editions SET status = 'completed' WHERE id = ?", c.env.p.edition_id);
    c.env.db.run("UPDATE editions SET status = 'active' WHERE id = ?", created.edition_id);
    c.env.db.run("UPDATE projects SET active_edition_id = ? WHERE id = ?", created.edition_id, c.env.p.project_id);
    ok(run_cli(c, ["merge", SLUG, "write", write_json(c, "r7b.json", item("새 판 장"))]), "merge (판 2)");
    ok(run_cli(c, ["assemble", SLUG]), "assemble (판 2)");
    ok(run_cli(c, ["web", SLUG]), "web (판 2)");
    const after = outputs();
    assert.equal(after.length, 2, "새 판에는 새 output 객체");
    const old = after.find((o) => o.object_id === first[0]!.object_id)!;
    assert.equal(old.n, first[0]!.n, "옛 판의 산출물 객체에는 버전이 더해지지 않는다");
    assert.ok(after.some((o) => o.edition_id === created.edition_id && o.n >= 2n), "새 판 객체에 assemble·web 버전");
  }));

// ---------------------------------------------------------------------------
// 9

test("R9 DB 프로젝트의 created 는 로컬 날짜다 (TZ=Asia/Seoul, UTC 20시 = 서울 다음날 05시)", () =>
  with_cli(async (c) => {
    c.env.db.run("UPDATE projects SET created_at = ? WHERE id = ?", BigInt(Date.UTC(2026, 2, 1, 20, 0, 0)), c.env.p.project_id);
    const request = JSON.stringify({ op: "read_project", slug: SLUG, session: null, token: null, args: {} });
    const created_in = (tz: string): string => {
      const env: Record<string, string | undefined> = { ...c.env.home.env, TZ: tz };
      for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
      const res = spawnSync(process.execPath, ["--no-warnings", join(REPO, "scripts", "pes_core", "cli_bridge.ts")], { input: request, encoding: "utf8", env: env as NodeJS.ProcessEnv, cwd: c.env.home.root });
      const reply = JSON.parse(res.stdout.trim().split("\n").pop() as string) as { ok: boolean; data?: { project: { created: string } } };
      assert.ok(reply.ok, res.stdout + res.stderr);
      return reply.data!.project.created;
    };
    assert.equal(created_in("Asia/Seoul"), "2026-03-02", "서울의 로컬 날짜");
    assert.equal(created_in("UTC"), "2026-03-01");
    assert.equal(created_in("America/Los_Angeles"), "2026-03-01", "LA 는 12시 — 같은 날");
  }));

// ---------------------------------------------------------------------------
// 8 · 실패한 쓰기는 디스크에도 이번 실행의 파일을 남기지 않는다

test("R8 report·assemble·web 이 중간에 실패해도(DB 에서 attach 거부) DB 와 객체 폴더 모두 실행 전과 같다", () =>
  with_cli(async (c) => {
    const item = (summary: string) => [{ id: 1, kind: "topic", title: "항목", summary, status: "done", sources: [{ title: "출처", url: "https://example.invalid/a", method: "law" }] }];
    const section = (details: string) => [{ id: 1, kind: "section", title: "1장", status: "done", details, sources: [{ title: "출처", url: "https://example.invalid/a", method: "law" }] }];
    const counts = () => c.env.db.all<Record<string, unknown>>("SELECT (SELECT count(*) FROM blobs) AS blobs, (SELECT count(*) FROM object_versions) AS versions, (SELECT count(*) FROM mutation_commits) AS commits");
    ok(run_cli(c, ["round-start", SLUG, "plan"]), "round-start");
    ok(run_cli(c, ["merge", SLUG, "plan", write_json(c, "r8a.json", item("처음"))]), "merge");
    ok(run_cli(c, ["merge", SLUG, "write", write_json(c, "r8w.json", section("본문 [^1]"))]), "merge write");
    ok(run_cli(c, ["report", SLUG, "plan"]), "report (성공: 프로젝트 객체 폴더가 생긴다)");
    ok(run_cli(c, ["assemble", SLUG]), "assemble");
    c.env.db.exec("CREATE TRIGGER r8_fail BEFORE INSERT ON version_files BEGIN SELECT RAISE(ABORT, 'synthetic attach failure'); END");
    try {
      const cases: Array<[string[], () => void]> = [
        [["report", SLUG, "plan"], () => ok(run_cli(c, ["merge", SLUG, "plan", write_json(c, "r8b.json", item("바뀐 요약"))]), "merge 2")],
        [["assemble", SLUG], () => ok(run_cli(c, ["merge", SLUG, "write", write_json(c, "r8x.json", section("바뀐 본문 [^1]"))]), "merge write 2")],
        [["web", SLUG, "--assemble"], () => ok(run_cli(c, ["merge", SLUG, "write", write_json(c, "r8y.json", section("또 바뀐 본문 [^1]"))]), "merge write 3")],
      ];
      for (const [args, change] of cases) {
        change();
        const rows = counts();
        const files = tree_digest(c.env.objects);
        const res = run_cli(c, args);
        assert.notEqual(res.status, 0, `${args[0]}: attach 가 거부되면 실패`);
        assert.doesNotMatch(res.stderr, /Traceback/, args[0]);
        assert.deepEqual(counts(), rows, `${args[0]}: DB 행 불변`);
        assert.equal(tree_digest(c.env.objects), files, `${args[0]}: 객체 폴더에 이번 실행이 쓴 파일이 남지 않는다`);
      }
    } finally {
      c.env.db.exec("DROP TRIGGER r8_fail");
    }
    ok(run_cli(c, ["report", SLUG, "plan"]), "복구 뒤 다시 실행");
  }));

// ---------------------------------------------------------------------------
// 7 · web 재사용의 derived_from, 새 판

function output_versions(c: CliEnv, object_id: string): string[] {
  return c.env.db.all<{ id: string }>("SELECT id FROM object_versions WHERE object_id = ? ORDER BY version_no", object_id).map((r) => r.id);
}

function derived_of(c: CliEnv, version_id: string): string[] {
  return c.env.db.all<{ to_version_id: string }>("SELECT to_version_id FROM version_relations WHERE from_version_id = ? AND kind = 'derived_from'", version_id).map((r) => r.to_version_id);
}

test("R7b web 이 기존 조립본을 재사용하면 새 버전이 직전 조립 버전을 derived_from 으로 가리킨다 (추적이 끊기지 않음)", () =>
  with_cli(async (c) => {
    ok(run_cli(c, ["merge", SLUG, "write", write_json(c, "r7b.json", [{ id: 1, kind: "section", title: "1장", status: "done", details: "본문 [^1]", sources: [{ title: "출처", url: "https://example.invalid/a", method: "law" }] }])]), "merge write");
    ok(run_cli(c, ["assemble", SLUG]), "assemble");
    const object = c.env.db.get<{ object_id: string }>("SELECT object_id FROM artifacts WHERE kind = 'output'")!.object_id;
    const assembled = output_versions(c, object)[0]!;
    assert.ok(derived_of(c, assembled).length >= 1, "조립 버전은 장 항목의 현재 버전을 근거로 든다");
    ok(run_cli(c, ["web", SLUG]), "web (재사용)");
    const after = output_versions(c, object);
    assert.equal(after.length, 2);
    assert.ok(derived_of(c, after[1]!).includes(assembled), `web 새 버전이 직전 조립 버전을 가리킨다: [${derived_of(c, after[1]!)}]`);
    ok(run_cli(c, ["web", SLUG]), "web 한 번 더");
    const third = output_versions(c, object);
    assert.ok(derived_of(c, third[2]!).includes(third[1]!), "그다음 버전은 바로 앞 버전을 가리킨다");
  }));

test("R7c 새 판에서 조립 없이 web 을 하면 옛 판의 조립본을 재사용하지 않는다: 새 판 객체, derived_from 이 옛 판을 가리키지 않음", () =>
  with_cli(async (c) => {
    const section = (title: string) => [{ id: 1, kind: "section", title, status: "done", details: `${title} 본문 [^1]`, sources: [{ title: "출처", url: "https://example.invalid/a", method: "law" }] }];
    ok(run_cli(c, ["merge", SLUG, "write", write_json(c, "r7c-a.json", section("옛 판 장"))]), "merge (판 1)");
    ok(run_cli(c, ["assemble", SLUG]), "assemble (판 1)");
    const old_object = c.env.db.get<{ object_id: string }>("SELECT object_id FROM artifacts WHERE kind = 'output'")!.object_id;
    const old_versions = output_versions(c, old_object);
    const created = (await create_edition(c.env.service, c.env.ctx("r7c-ed2"), { parent_edition_id: c.env.p.edition_id })).result as { edition_id: string };
    c.env.db.run("UPDATE editions SET status = 'completed' WHERE id = ?", c.env.p.edition_id);
    c.env.db.run("UPDATE editions SET status = 'active' WHERE id = ?", created.edition_id);
    c.env.db.run("UPDATE projects SET active_edition_id = ? WHERE id = ?", created.edition_id, c.env.p.project_id);
    ok(run_cli(c, ["merge", SLUG, "write", write_json(c, "r7c-b.json", section("새 판 장"))]), "merge (판 2)");
    ok(run_cli(c, ["web", SLUG]), "web (판 2, 조립 없이)");
    assert.deepEqual(output_versions(c, old_object), old_versions, "옛 판 객체는 그대로");
    const fresh = c.env.db.all<{ object_id: string }>("SELECT a.object_id AS object_id FROM artifacts a JOIN objects o ON o.id = a.object_id WHERE a.kind = 'output' AND o.edition_id = ?", created.edition_id);
    assert.equal(fresh.length, 1, "새 판에는 새 output 객체");
    for (const v of output_versions(c, fresh[0]!.object_id)) {
      assert.ok(!derived_of(c, v).some((id) => old_versions.includes(id)), "새 판 버전이 옛 판의 조립 버전을 근거로 들지 않는다");
    }
    const md = c.env.db.all<{ storage_key: string }>("SELECT b.storage_key AS storage_key FROM version_files vf JOIN blobs b ON b.id = vf.blob_id WHERE vf.version_id IN (SELECT id FROM object_versions WHERE object_id = ?) AND b.original_name = 'report.md'", fresh[0]!.object_id);
    assert.ok(md.length >= 1);
    const text = readFileSync(disk_path(c.env, md[0]!), "utf8");
    assert.match(text, /새 판 장/);
    assert.doesNotMatch(text, /옛 판 장/, "옛 판의 조립본 내용이 섞이지 않는다");
  }));

// ---------------------------------------------------------------------------
// 4b · Python str(float) 표기

test("R4b stats 값 5e-05·1e16·-0.0·12.0 은 v0.15 표기와 같다: 검증 일치, DB 보고서도 같은 표기 (-0.0 만 DB 경유 시 0.0 — 8.13 알려진 한계)", () =>
  with_cli(async (c) => {
    const tokens = [["__A__", "5e-05", "작은 값"], ["__B__", "1e16", "큰 값"], ["__C__", "-0.0", "음의 영"], ["__D__", "12.0", "정수형 실수"], ["__E__", "0.1", "소수"]] as const;
    const dir = legacy_home_with_real_report(c, "r4b-floats", (text) => {
      const p = JSON.parse(text);
      p.stages.plan.items[0].stats = tokens.map(([ph, , name]) => ({ name, value: ph, unit: "%", period: "2025", method: "추정" }));
      let out = JSON.stringify(p);
      for (const [ph, raw] of tokens) out = out.replace(`"${ph}"`, raw);
      return out;
    });
    const original = read_lf(join(dir, "reports", "plan", "report.md")); // Windows v0.15 파일은 CRLF
    const line = (md: string, name: string) => md.split("\n").find((l) => l.startsWith(`| ${name} |`));
    const expected: Record<string, string> = {};
    for (const [, , name] of tokens) {
      const l = line(original, name);
      assert.ok(l, `v0.15 보고서의 ${name} 줄`);
      expected[name] = l;
    }
    assert.match(expected["작은 값"]!, /\| 5e-05 % \|/);
    assert.match(expected["큰 값"]!, /\| 1e\+16 % \|/, "v0.15: Python str(1e16) = 1e+16");
    assert.match(expected["음의 영"]!, /\| -0\.0 % \|/);
    assert.match(expected["정수형 실수"]!, /\| 12\.0 % \|/);
    const { imp, val, mig } = await import_validate(c, dir);
    assert.equal(val.ok, true, JSON.stringify(val.report.problems));
    assert.equal(matches(val, "reports/plan/report.md"), true);
    assert.equal(matches(val, "reports/plan/report.html"), true);
    await mig.activate_import(c.env.service, imp.batch_id, { owner_actor_id: owner_of(c.env), backup_dir: backup_dir_of(c.env, "r4b"), pes_home: pes_home_of(c.env) });
    ok(run_cli(c, ["report", "r4b-floats", "plan"]), "report (DB)");
    const md = c.env.db
      .all<{ storage_key: string }>(
        `SELECT b.storage_key AS storage_key FROM version_files vf JOIN blobs b ON b.id = vf.blob_id
          JOIN artifacts a ON a.object_id = (SELECT object_id FROM object_versions WHERE id = vf.version_id)
         WHERE a.kind = 'report' AND b.original_name = 'report.md' ORDER BY vf.rowid DESC`,
      )
      .map((r) => readFileSync(disk_path(c.env, r), "utf8"))[0];
    assert.ok(md, "DB 보고서 마크다운");
    for (const [, , name] of tokens) {
      const want = name === "음의 영" ? expected[name]!.replace("-0.0", "0.0") : expected[name]!;
      assert.equal(line(md, name), want, `${name}: DB 보고서 표기`);
    }
  }));

// ---------------------------------------------------------------------------
// 3d · CRLF 템플릿

test("R3d 템플릿이 CRLF 로 체크아웃돼 있어도(Windows autocrlf) DB 모드 렌더 파일(report.md·report.html·assemble·web)에 \\r 이 없다", () =>
  with_cli(async (c) => {
    // scripts·templates·questions 사본을 만들고 templates 를 CRLF 로 바꾼다. 사본의 pes.ts 가 사본의 코어(cli_bridge·report.ts)와 템플릿을 쓴다.
    const copy = join(c.env.home.root, "crlf-copy");
    for (const name of ["scripts", "templates", "questions"]) cpSync(join(REPO, name), join(copy, name), { recursive: true });
    cpSync(join(REPO, "package.json"), join(copy, "package.json"));
    const templates = join(copy, "templates");
    const crlf = readdirSync(templates).filter((f) => f.endsWith(".html"));
    assert.ok(crlf.length >= 5);
    for (const f of crlf) writeFileSync(join(templates, f), readFileSync(join(templates, f), "utf8").replace(/\r?\n/g, "\r\n"));
    assert.ok(readFileSync(join(templates, "stage-report.html"), "utf8").includes("\r\n"), "사본 템플릿은 CRLF");
    assert.ok(!readFileSync(join(REPO, "templates", "stage-report.html"), "utf8").includes("\r\n") || process.platform === "win32", "원본 저장소 템플릿은 건드리지 않았다");
    const script = join(copy, "scripts", "pes.ts");
    const run = (args: string[]) => ok(run_cli(c, args, { script }), args.join(" "));
    run(["round-start", SLUG, "plan"]);
    run(["merge", SLUG, "plan", write_json(c, "r3d-p.json", [{ id: 1, kind: "topic", title: "항목", summary: "요약\r\n둘째 줄", status: "done", sources: [{ title: "출처", url: "https://example.invalid/a", method: "law" }] }])]);
    run(["merge", SLUG, "write", write_json(c, "r3d-w.json", [{ id: 1, kind: "section", title: "1장", status: "done", details: "본문\r\n줄 [^1]", sources: [{ title: "출처", url: "https://example.invalid/a", method: "law" }] }])]);
    run(["report", SLUG, "plan"]);
    run(["web", SLUG, "--assemble"]);
    const rows = c.env.db.all<{ original_name: string; storage_key: string }>("SELECT DISTINCT b.original_name AS original_name, b.storage_key AS storage_key FROM version_files vf JOIN blobs b ON b.id = vf.blob_id WHERE vf.role = 'rendered'");
    const names = rows.map((r) => r.original_name).sort();
    assert.ok(names.includes("report.html") && names.includes("report.md") && names.includes("sources.json"), `렌더 파일: ${names}`);
    for (const row of rows) assert.ok(!readFileSync(disk_path(c.env, row), "utf8").includes("\r"), `${row.original_name}: CRLF 템플릿·입력에도 \\r 이 없다`);
  }));
