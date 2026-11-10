/**
 * SEL-49 PR16 — 보강 시험 (tester, 보강 모드). 구현을 깨뜨리는 것이 목표다. 자료는 모두 합성, HOME·USERPROFILE·PES_HOME 은 임시 폴더.
 *
 *   H1  legacy↔DB 경계: staging·failed(archived)·activated·다시 rollback 된 프로젝트의 읽기/쓰기 경로
 *   H2  보고서 동등성: DB 에서 만든 단계 보고서·assemble·sources.json 이 같은 자료의 v0.15 결과와 같다 (제거 항목·같은 URL·URL 없는 출처·수치·충돌·연결)
 *   H3  report 동시 실행·부분 실패: staging blob 잔여 없음, 버전 번호 중복 없음
 *   H4  doctor --fix 는 PES 홈 밖(심볼릭 링크 너머)을 건드리지 않는다
 *   H5  watch quoting: 어떤 폴더 이름이든 셸이 한 단어로 읽는다
 *   H6  절대 경로·다른 폴더의 같은 슬러그는 DB 가 아니라 그 폴더의 project.json 을 읽는다
 *   H7  토큰 에이전트가 자기 lease 로 report 를 한다
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { disk_path } from "./helpers/blob_env.ts";
import { expect_rejected, make_cli_env, PES_PY, SLUG, with_cli, type CliEnv, type CliResult } from "./helpers/cli_write_env.ts";
import { normalize, PY, plain_json_legacy, read_lf, run_py, shell_words, write_legacy } from "./helpers/cli_read_env.ts";
import { FIXTURES, legacy, tree_digest } from "./helpers/legacy_env.ts";
import { backup_dir_of, migration, owner_of, pes_home_of } from "./helpers/migration_env.ts";
import { state_signature } from "./helpers/state_signature.ts";

const OFF = { flag: undefined } as const;

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

const WIN = process.platform === "win32";

// ---------------------------------------------------------------------------
// H1

async function import_full(c: CliEnv, slug = "synthetic-legacy-full") {
  const dir = join(c.env.home.env.PES_HOME as string, slug);
  cpSync(join(FIXTURES, "full"), dir, { recursive: true });
  if (slug !== "synthetic-legacy-full") {
    const file = join(dir, "project.json");
    writeFileSync(file, readFileSync(file, "utf8").replace('"slug": "synthetic-legacy-full"', `"slug": "${slug}"`), "utf8"); // 다른 슬러그·지문 = 다른 프로젝트
  }
  const api = await legacy();
  const mig = await migration();
  const imp = await api.import_project(c.env.service, dir, { owner_actor_id: owner_of(c.env) });
  assert.equal(imp.state, "staging");
  return { dir, imp, mig, slug };
}

function reads_equal_legacy(c: CliEnv, slug: string, what: string): void {
  const roots = [c.env.home.root, `/private${c.env.home.root}`];
  for (const args of [["status", slug], ["pending", slug], ["digest", slug, "research"], ["show", slug, "plan"], ["show", slug, "plan", "1"]]) {
    const on = run_py(c, args);
    const off = run_py(c, args, { ...OFF });
    assert.equal(on.status, off.status, `${what}: ${args.join(" ")} 종료 코드`);
    assert.equal(normalize(on.stdout, roots), normalize(off.stdout, roots), `${what}: ${args.join(" ")} 은 project.json 을 읽는다`);
  }
}

function writes_refused(c: CliEnv, slug: string, dir: string, what: string): void {
  const sig = c.sig(join(dir, "project.json"));
  const tree = tree_digest(dir);
  const signature = state_signature(c.env.db);
  for (const args of [["note", slug, "x"], ["round-start", slug, "research"], ["report", slug, "plan"], ["assemble", slug], ["web", slug]]) {
    const res = run_py(c, args);
    expect_rejected(res, `${what}: ${args[0]}`);
    assert.match(res.stderr, /이전/, `${what}: ${args[0]} 는 이전 안내`);
  }
  assert.deepEqual(c.sig(join(dir, "project.json")), sig);
  assert.equal(tree_digest(dir), tree, `${what}: 폴더 불변`);
  assert.equal(state_signature(c.env.db), signature, `${what}: DB 불변`);
}

test("H1 staging → validated → activated → rollback(failed/archived): 읽기 경로가 상태를 따라 바뀌고 쓰기는 active 만 된다", () =>
  with_cli(async (c) => {
    const { dir, imp, mig, slug } = await import_full(c);
    reads_equal_legacy(c, slug, "staging");
    writes_refused(c, slug, dir, "staging");

    const val = await mig.validate_import(c.env.service, imp.batch_id, { owner_actor_id: owner_of(c.env), source_dir: dir });
    assert.equal(val.ok, true, JSON.stringify(val.report.problems));
    reads_equal_legacy(c, slug, "validated");
    writes_refused(c, slug, dir, "validated");

    await mig.activate_import(c.env.service, imp.batch_id, { owner_actor_id: owner_of(c.env), backup_dir: backup_dir_of(c.env, "h1"), pes_home: pes_home_of(c.env) });
    const json_sig = c.sig(join(dir, "project.json"));
    ok(run_py(c, ["note", slug, "활성화 뒤 메모"]), "note (active)");
    assert.deepEqual(c.sig(join(dir, "project.json")), json_sig, "active: 쓰기는 DB 로, project.json 불변");
    assert.match(ok(run_py(c, ["status", slug]), "status").stdout, /활성화 뒤 메모/, "active: 읽기는 DB (방금 쓴 메모가 보인다)");
    assert.doesNotMatch(ok(run_py(c, ["status", slug], { ...OFF }), "status off").stdout, /활성화 뒤 메모/);

    // 새 쓰기가 있으면 rollback 은 거부된다 → restore 가 아닌 한 failed 로 갈 수 없다. 새 쓰기 없는 두 번째 프로젝트로 rollback 을 본다.
    const second = await import_full(c, "synthetic-legacy-two");
    const val2 = await mig.validate_import(c.env.service, second.imp.batch_id, { owner_actor_id: owner_of(c.env), source_dir: second.dir });
    assert.equal(val2.ok, true, JSON.stringify(val2.report.problems));
    await mig.activate_import(c.env.service, second.imp.batch_id, { owner_actor_id: owner_of(c.env), backup_dir: backup_dir_of(c.env, "h1b"), pes_home: pes_home_of(c.env) });
    await mig.rollback_before_write(c.env.service, second.imp.batch_id, { owner_actor_id: owner_of(c.env) });
    reads_equal_legacy(c, second.slug, "rolled back (archived)");
    writes_refused(c, second.slug, second.dir, "rolled back (archived)");
  }));

test("H1b list: staging·archived 프로젝트는 project.json 으로 한 번씩, active DB 프로젝트는 DB 주제로 한 번만 나온다", () =>
  with_cli(async (c) => {
    const { slug } = await import_full(c);
    const out = ok(run_py(c, ["list"]), "list").stdout;
    const count = (s: string) => out.split("\n").filter((l) => l.includes(`(${s})`)).length;
    assert.equal(count(slug), 1, out);
    assert.equal(count(SLUG), 1);
    assert.match(out, /합성 도서관 운영 연구/);
  }));

// ---------------------------------------------------------------------------
// H2 · 보고서 동등성 (v0.15 와 나란히)

const RICH_PLAN = [
  {
    id: 1,
    kind: "topic",
    title: "첫 항목",
    question: "무엇이 문제인가?",
    summary: "첫 요약",
    details: "첫 본문입니다. 요약과 다릅니다.",
    confidence: "medium",
    status: "done",
    verdict: "일부 사실",
    sources: [
      { title: "출처 가", url: "https://example.invalid/ka", method: "kosis", date: "2026-01-01" },
      { title: "제목만 있는 출처", method: "search" },
    ],
    stats: [{ name: "지표 하나", value: "12.5", unit: "%", period: "2025", orgId: "101", tblId: "DT_1" }, { label: "라벨 이름", value: "3", unit: "개", method: "추정" }],
    conflicts: ["서로 다른 두 값", { a: 1 }],
    links: { research: [1, 2] },
  },
  { id: 2, kind: "issue", title: "둘째 항목", summary: "둘째 요약", status: "done", sources: [{ title: "출처 가 (다른 제목)", url: "https://example.invalid/ka", method: "law" }, { title: "제목만 있는 출처", method: "browser" }] },
  { id: 3, kind: "topic", title: "지워진 항목", summary: "보이면 안 됨", status: "removed", sources: [{ title: "지워진 항목의 출처", url: "https://example.invalid/gone", method: "law" }] },
  { id: 4, kind: "rq", title: "연구 질문", summary: "질문 요약", status: "deepen" },
];

const RICH_WRITE = [
  { id: 1, kind: "section", title: "1장", order: 2, status: "done", details: "둘째로 놓일 장 [^1] [^3] [^9]", sources: [{ title: "출처 가", url: "https://example.invalid/ka", method: "law" }, { title: "출처 나", url: "https://example.invalid/kb", method: "search" }, { title: "출처 다", method: "browser" }] },
  { id: 2, kind: "section", title: "2장", order: 1, status: "done", details: "첫째로 놓일 장 [^2] [^1]", sources: [{ title: "출처 나", url: "https://example.invalid/kb", method: "search" }, { title: "출처 가", url: "https://example.invalid/ka", method: "law" }] },
  { id: 3, kind: "section", title: "빠진 장", status: "removed", details: "보이면 안 됨 [^1]", sources: [{ title: "빠진", url: "https://example.invalid/x", method: "law" }] },
];

function strip_written(text: string): string {
  return text.replace(/- 작성 \d{4}-\d{2}-\d{2} \d{2}:\d{2} · PES(?: \(버전 \d+\))?/g, "- 작성 <시각> · PES");
}

function latest_files(c: CliEnv, kind: "report" | "output", stage: "plan" | null): Map<string, string> {
  const obj = c.env.db.get<{ object_id: string; current_version_id: string }>(
    "SELECT a.object_id AS object_id, o.current_version_id AS current_version_id FROM artifacts a JOIN objects o ON o.id = a.object_id WHERE a.project_id = ? AND a.kind = ? AND (? IS NULL OR a.stage_id = ?) ORDER BY a.rowid",
    c.env.p.project_id,
    kind,
    stage === null ? null : c.stages[stage],
    stage === null ? null : c.stages[stage],
  );
  assert.ok(obj, `${kind} 객체`);
  const rows = c.env.db.all<{ original_name: string; storage_key: string }>(
    "SELECT b.original_name, b.storage_key FROM version_files vf JOIN blobs b ON b.id = vf.blob_id WHERE vf.version_id = ?",
    obj.current_version_id,
  );
  return new Map(rows.map((r) => [r.original_name, readFileSync(disk_path(c.env, r), "utf8")]));
}

test("H2 같은 자료의 DB 보고서·assemble·sources.json 이 v0.15 결과와 같다 (제거 항목·같은 URL·URL 없는 출처·수치·충돌·연결·각주 범위 밖)", async () => {
  const now = await make_cli_env();
  const old = await make_cli_env();
  try {
    write_legacy(old.folder, plain_json_legacy(SLUG));
    for (const [c, flag] of [[now, "1"], [old, undefined]] as const) {
      ok(run_py(c, ["round-start", SLUG, "plan"], { flag }), "round-start");
      ok(run_py(c, ["merge", SLUG, "plan", write_json(c, "h2-plan.json", RICH_PLAN)], { flag }), "merge plan");
      ok(run_py(c, ["merge", SLUG, "write", write_json(c, "h2-write.json", RICH_WRITE)], { flag }), "merge write");
      ok(run_py(c, ["report", SLUG, "plan"], { flag }), "report");
      ok(run_py(c, ["assemble", SLUG], { flag }), "assemble");
    }
    const md_db = latest_files(now, "report", "plan").get("report.md");
    const md_old = read_lf(join(old.folder, "reports", "plan", "report.md")) /* Windows v0.15 파일은 CRLF — 줄바꿈만 정규화 */;
    assert.ok(md_db);
    assert.equal(strip_written(md_db), strip_written(md_old), "단계 보고서 마크다운");
    const out = latest_files(now, "output", null);
    assert.equal(out.get("report.md"), read_lf(join(old.folder, "out", "report.md")), "assemble 마크다운(각주 재매김·범위 밖 번호 유지)");
    assert.equal(out.get("sources.json"), read_lf(join(old.folder, "out", "sources.json")), "sources.json");
    assert.doesNotMatch(out.get("report.md")!, /보이면 안 됨/);
  } finally {
    now.close();
    old.close();
  }
});

// ---------------------------------------------------------------------------
// H3 · 동시 실행·부분 실패

function run_async(c: CliEnv, args: string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const env: Record<string, string | undefined> = { ...c.env.home.env, PES_DB_CORE: "1", PES_OWNER: undefined, PES_TOKEN: undefined };
    for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
    const child = spawn(PY, ["-I", "-X", "utf8", PES_PY, ...args], { env: env as NodeJS.ProcessEnv, cwd: c.env.home.root });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function staging_blobs(c: CliEnv): number {
  return Number(c.env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM blobs WHERE state <> 'ready'")?.n ?? 0n);
}

test("H3 report 를 동시에 4번 실행해도 버전 번호가 겹치지 않고 staging blob 이 남지 않으며 실패한 쪽은 분명한 오류다", () =>
  with_cli(async (c) => {
    ok(run_py(c, ["round-start", SLUG, "plan"]), "round-start");
    ok(run_py(c, ["merge", SLUG, "plan", write_json(c, "h3.json", RICH_PLAN)]), "merge");
    const results = await Promise.all([1, 2, 3, 4].map(() => run_async(c, ["report", SLUG, "plan"])));
    for (const r of results) assert.doesNotMatch(r.stderr, /Traceback/, r.stderr);
    const done = results.filter((r) => r.status === 0).length;
    assert.ok(done >= 1, `적어도 하나는 성공: ${results.map((r) => r.status)}`);
    const versions = c.env.db.all<{ version_no: bigint }>(
      "SELECT ov.version_no FROM object_versions ov JOIN artifacts a ON a.object_id = ov.object_id WHERE a.kind = 'report' ORDER BY ov.version_no",
    );
    assert.equal(versions.length, done, "성공한 만큼만 버전이 생긴다");
    assert.deepEqual(versions.map((v) => Number(v.version_no)), versions.map((_, i) => i + 1), "버전 번호는 1..n 연속");
    assert.equal(staging_blobs(c), 0, "끝난 뒤 staging/quarantined blob 이 남지 않는다");
    const objects = c.env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM artifacts WHERE kind = 'report'")?.n;
    assert.equal(objects, 1n, "보고서 객체는 하나");
  }));

test("H3b 객체 저장소에 쓸 수 없어 report 가 실패하면 버전·영수증·blob 이 하나도 남지 않는다 (고아 staging 없음)", { skip: WIN || process.getuid?.() === 0 }, () =>
  with_cli(async (c) => {
    ok(run_py(c, ["round-start", SLUG, "plan"]), "round-start");
    ok(run_py(c, ["merge", SLUG, "plan", write_json(c, "h3b.json", RICH_PLAN)]), "merge");
    ok(run_py(c, ["report", SLUG, "plan"]), "report 1 (프로젝트 객체 폴더를 만든다)");
    const signature = state_signature(c.env.db);
    const folder = join(c.env.objects, c.env.p.project_id);
    ok(run_py(c, ["merge", SLUG, "plan", write_json(c, "h3b2.json", [{ id: 4, summary: "바뀐 요약" }])]), "merge 2");
    const before = state_signature(c.env.db);
    chmodSync(folder, 0o500);
    try {
      const res = run_py(c, ["report", SLUG, "plan"]);
      expect_rejected(res, "쓸 수 없는 객체 저장소");
      assert.doesNotMatch(res.stderr, /Traceback/);
    } finally {
      chmodSync(folder, 0o700);
    }
    assert.equal(state_signature(c.env.db), before, "실패한 report 는 DB 에 아무것도 남기지 않는다");
    assert.notEqual(signature, before);
    assert.equal(staging_blobs(c), 0);
    ok(run_py(c, ["report", SLUG, "plan"]), "복구 뒤 다시 실행");
  }));

// ---------------------------------------------------------------------------
// H4 · doctor --fix 는 PES 홈 밖을 건드리지 않는다

test("H4 doctor --fix: PES 홈 안의 심볼릭 링크 너머(홈 밖) 폴더의 임시 파일·잠금·서버 기록은 지우지 않는다", { skip: WIN }, () =>
  with_cli(async (c) => {
    const outside = join(c.env.home.root, "outside-project");
    write_legacy(outside, plain_json_legacy("outside"));
    const tmp = join(outside, "project.json.tmp");
    writeFileSync(tmp, "{", "utf8");
    writeFileSync(join(outside, ".pes-lock"), JSON.stringify({ owner: "sess-x", at: 1, since: "2020-01-01 00:00" }), "utf8");
    writeFileSync(join(outside, ".pes-port"), "1", "utf8");
    symlinkSync(outside, join(c.env.home.env.PES_HOME as string, "linked"), "dir");
    const tree = tree_digest(outside);
    const res = run_py(c, ["doctor", "--fix", "--json"]);
    assert.doesNotMatch(res.stderr, /Traceback/);
    assert.equal(tree_digest(outside), tree, "홈 밖 폴더가 바뀌지 않는다");
    assert.ok(existsSync(tmp));
  }));

test("H4b doctor --fix 는 DB 파일·객체 저장소·DB 프로젝트 폴더를 바꾸지 않는다", () =>
  with_cli(async (c) => {
    ok(run_py(c, ["round-start", SLUG, "plan"]), "round-start");
    ok(run_py(c, ["merge", SLUG, "plan", write_json(c, "h4b.json", RICH_PLAN)]), "merge");
    ok(run_py(c, ["report", SLUG, "plan"]), "report");
    const signature = state_signature(c.env.db);
    const objects = tree_digest(c.env.objects);
    const rows = JSON.parse(run_py(c, ["doctor", "--fix", "--json"]).stdout) as Array<{ group: string; level: string }>;
    assert.ok(Array.isArray(rows));
    assert.equal(state_signature(c.env.db), signature, "DB 불변");
    assert.equal(tree_digest(c.env.objects), objects, "객체 저장소 불변");
  }));

// ---------------------------------------------------------------------------
// H5 · watch quoting

const NAMES = ["plain-name", "with space", "it's", 'dq"uote', "$HOME", "`tick`", "semi;colon", "amp&er", "star*", "hash#tag", "paren(s)", "한글 이름", "tilde~x", "back\\slash", "pipe|bar", "new\nline"];

test("H5 watch: 폴더 이름에 셸 특수문자가 있어도 한 단어로 읽히고, 안전한 이름은 v0.15 와 같은 출력이다", () =>
  with_cli(async (c) => {
    for (const name of NAMES) {
      if (WIN && /[\\"*|\n]/.test(name)) continue; // Windows 폴더 이름에 쓸 수 없는 문자
      const home = join(c.env.home.root, `h_${name}`);
      const flagged = run_py(c, ["watch", "p"], { extra: { PES_HOME: home } });
      const off = run_py(c, ["watch", "p"], { ...OFF, extra: { PES_HOME: home } });
      assert.equal(flagged.stdout, off.stdout, `${JSON.stringify(name)}: 플래그와 무관하게 같은 출력`);
      const words = shell_words(flagged.stdout.replace(/\n$/, ""));
      assert.deepEqual(words.slice(0, 3), ["tail", "-n0", "-F"], JSON.stringify(name));
      const got = words[3]!;
      const want = `h_${name}/p/feedback.log`;
      assert.ok(got.split("\\").join("/").endsWith(want.split("\\").join("/")) && (WIN || got.endsWith(want)), `${JSON.stringify(name)} 한 단어로 원래 경로: ${JSON.stringify(got)} <- ${flagged.stdout}`);
      assert.deepEqual(words.slice(4), ["|", "grep", "--line-buffered", "FEEDBACK"], JSON.stringify(name));
    }
  }));

// ---------------------------------------------------------------------------
// H6 · 경로로 부르기

test("H6 절대 경로로 DB 프로젝트를 불러도 DB 를 읽고, 다른 폴더의 같은 이름 project.json 은 그 폴더 것을 읽는다", () =>
  with_cli(async (c) => {
    const by_slug = ok(run_py(c, ["digest", SLUG, "plan"]), "slug").stdout;
    const by_path = ok(run_py(c, ["digest", c.folder, "plan"]), "path").stdout;
    assert.equal(by_path, by_slug, "절대 경로도 같은 DB 프로젝트");
    const other = join(c.env.home.root, "elsewhere", SLUG);
    write_legacy(other, { ...plain_json_legacy(SLUG), topic: "다른 곳의 같은 이름" });
    const status = ok(run_py(c, ["status", other]), "other folder").stdout;
    assert.match(status, /주제: 다른 곳의 같은 이름/, "홈 밖 폴더는 DB 슬러그와 같은 이름이어도 그 폴더의 project.json");
    const write = run_py(c, ["note", other, "x"]);
    expect_rejected(write, "홈 밖 폴더 쓰기");
    assert.equal(JSON.parse(readFileSync(join(other, "project.json"), "utf8")).notes.length, 0, "홈 밖 옛 폴더는 쓰이지 않는다");
  }));

// ---------------------------------------------------------------------------
// H7

test("H7 토큰 에이전트가 claim 한 뒤에는 report 를 할 수 있고 영수증 actor 는 에이전트다", () =>
  with_cli(async (c) => {
    const agent = await c.agent("report-agent");
    ok(run_py(c, ["round-start", SLUG, "plan"]), "round-start");
    ok(run_py(c, ["merge", SLUG, "plan", write_json(c, "h7.json", RICH_PLAN)]), "merge");
    const bare = run_py(c, ["report", SLUG, "plan"], { extra: { PES_TOKEN: agent.token } });
    expect_rejected(bare, "claim 전");
    ok(run_py(c, ["claim", SLUG], { extra: { PES_TOKEN: agent.token } }), "claim");
    const n = c.commits().length;
    ok(run_py(c, ["report", SLUG, "plan"], { extra: { PES_TOKEN: agent.token } }), "report (agent)");
    const added = c.commits_since(n);
    assert.ok(added.length >= 3);
    assert.ok(added.every((m) => m.actor_id === agent.actor_id && m.via === "cli"), "모든 영수증의 actor 는 에이전트");
    assert.equal(staging_blobs(c), 0);
  }));
