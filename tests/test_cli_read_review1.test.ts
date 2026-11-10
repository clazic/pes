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
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { create_edition } from "../scripts/pes_core/editions.ts";
import { disk_path } from "./helpers/blob_env.ts";
import { REPO, SLUG, with_cli, type CliEnv, type CliResult } from "./helpers/cli_write_env.ts";
import { baseline_dir, run_py, write_legacy, type HomeLike } from "./helpers/cli_read_env.ts";
import { FIXTURES, legacy, tree_digest } from "./helpers/legacy_env.ts";
import { backup_dir_of, migration, owner_of, pes_home_of } from "./helpers/migration_env.ts";
import { isolated_home } from "./helpers/isolated_home.ts";

const OFF = { flag: undefined } as const;
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

/** fixture `full` 을 PES 홈 안에 복사하고, project.json 을 text 수준에서 고친 뒤, v0.15(03fc81b) `report plan` 으로 원본 보고서를 만든다. */
function legacy_home_with_real_report(c: CliEnv, slug: string, edit: (text: string) => string): string {
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
  return dir;
}

async function import_validate(c: CliEnv, dir: string) {
  const api = await legacy();
  const mig = await migration();
  const imp = await api.import_project(c.env.service, dir, { owner_actor_id: owner_of(c.env) });
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
    const original = readFileSync(join(dir, "reports", "plan", "report.md"), "utf8");
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
        const res = run_py(c, args);
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
    const none = run_py(like, ["status", "alpha"]);
    assert.equal(none.status, 0, none.stderr);
    assert.match(none.stdout, /주제: 낡은 주제/);
    assert.ok(!existsSync(db), "읽기는 DB 를 만들지 않는다");
    // 깨진 DB
    mkdirSync(join(home.root, "home", ".pes"), { recursive: true });
    writeFileSync(db, "이것은 SQLite 파일이 아니다 ".repeat(40), "utf8");
    const before = readFileSync(db);
    for (const args of [["status", "alpha"], ["pending", "alpha"], ["digest", "alpha", "plan"], ["show", "alpha", "plan"], ["list"]]) {
      const res = run_py(like, args);
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
    ok(run_py(c, ["round-start", SLUG, "plan"]), "round-start");
    ok(run_py(c, ["merge", SLUG, "plan", write_json(c, "r3c.json", [{ id: 1, kind: "topic", title: "항목", summary: "요약\n둘째 줄", sources: [{ title: "출처", url: "https://example.invalid/a", method: "law" }] }])]), "merge");
    ok(run_py(c, ["merge", SLUG, "write", write_json(c, "r3c-w.json", [{ id: 1, kind: "section", title: "1장", status: "done", details: "본문\n줄 [^1]", sources: [{ title: "출처", url: "https://example.invalid/a", method: "law" }] }])]), "merge write");
    ok(run_py(c, ["report", SLUG, "plan"]), "report");
    ok(run_py(c, ["web", SLUG, "--assemble"]), "web");
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
    const original = readFileSync(join(dir, "reports", "plan", "report.md"), "utf8");
    assert.match(original, /^\| 합성 지표 \| 12\.0 % \|/m, "v0.15 는 12.0");
    assert.match(original, /^\| 정수 지표 \| 7 개 \|/m);
    const { imp, val, mig } = await import_validate(c, dir);
    assert.equal(val.ok, true, JSON.stringify(val.report.problems));
    assert.equal(matches(val, "reports/plan/report.md"), true);
    await mig.activate_import(c.env.service, imp.batch_id, { owner_actor_id: owner_of(c.env), backup_dir: backup_dir_of(c.env, "r4"), pes_home: pes_home_of(c.env) });
    ok(run_py(c, ["report", "r4-float", "plan"]), "report (DB)");
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
    const names = () => ok(run_py(c, ["pending", slug]), "pending").stdout.trim().split("\n").filter(Boolean).map((l) => l.trim().split(/[\\/]/).pop());
    const before = names();
    assert.equal(before.length, 2, `처리 안 한 답 2개: ${before}`);
    const subs = c.env.db.all<{ id: string }>("SELECT s.id FROM submissions s JOIN blobs b ON b.id = s.raw_blob_id WHERE s.via = 'import' AND b.original_name IN (?, ?)", before[0]!, before[1]!);
    assert.equal(subs.length, 2);
    for (const [i, via] of (["web", "http"] as const).entries()) c.env.db.run("UPDATE submissions SET via = ? WHERE id = ?", via, subs[i]!.id);
    assert.deepEqual(names(), before, "via 가 web·http 여도 같은 답이 처리 대기로 보인다");
    assert.match(ok(run_py(c, ["status", slug]), "status").stdout, /처리 안 한 답: 2개/);
  }));

// ---------------------------------------------------------------------------
// 6

test("R6 플래그 켜짐 + 홈 안 legacy: doctor --fix 는 폴더에 아무것도 쓰지 않는다 (미전환·staging 모두)", () =>
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
    assert.equal(imp.state, "staging");
    const trees = [tree_digest(plain), tree_digest(staged)];
    const sigs = [c.sig(join(plain, "project.json")), c.sig(join(staged, "project.json"))];
    for (const args of [["doctor", "--fix", "--json"], ["doctor", "r6-plain", "--fix", "--json"], ["doctor", "r6-staged", "--fix", "--json"]]) {
      const res = run_py(c, args);
      assert.doesNotMatch(res.stderr, /Traceback/);
      const rows = JSON.parse(res.stdout) as Array<{ group: string; fixed?: boolean }>;
      assert.ok(!rows.some((r) => (r.group === "r6-plain" || r.group === "r6-staged") && r.fixed === true), `${args.join(" ")}: legacy 행은 고치지 않는다`);
    }
    assert.deepEqual([tree_digest(plain), tree_digest(staged)], trees, "폴더 내용 불변");
    assert.deepEqual([c.sig(join(plain, "project.json")), c.sig(join(staged, "project.json"))], sigs, "project.json 바이트·mtime 불변");
    // 플래그 없는 v0.15 는 그대로 고친다 (이 PR 이 바꾸지 않는다)
    run_py(c, ["doctor", "r6-plain", "--fix", "--json"], { ...OFF });
    assert.ok(!existsSync(join(plain, "project.json.tmp")), "v0.15: 임시 파일을 지운다");
  }));

// ---------------------------------------------------------------------------
// 7

test("R7 새 판이 active 가 되면 assemble·web 은 새 판의 output 객체에 쌓고 옛 판의 객체는 그대로다", () =>
  with_cli(async (c) => {
    const item = (title: string) => [{ id: 1, kind: "section", title, status: "done", details: "본문 [^1]", sources: [{ title: "출처", url: "https://example.invalid/a", method: "law" }] }];
    ok(run_py(c, ["merge", SLUG, "write", write_json(c, "r7a.json", item("옛 판 장"))]), "merge (판 1)");
    ok(run_py(c, ["assemble", SLUG]), "assemble (판 1)");
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
    ok(run_py(c, ["merge", SLUG, "write", write_json(c, "r7b.json", item("새 판 장"))]), "merge (판 2)");
    ok(run_py(c, ["assemble", SLUG]), "assemble (판 2)");
    ok(run_py(c, ["web", SLUG]), "web (판 2)");
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
      const env: Record<string, string | undefined> = { ...c.env.home.env, PES_DB_CORE: "1", TZ: tz };
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
