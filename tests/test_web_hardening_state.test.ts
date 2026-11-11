/**
 * SEL-51 PR18 — 화면 서버 보강 시험 2/2 (tester, 보강 모드): 동시 제출 경합·submission 유일성, 옛 판 폼 409 경계, /version 커서,
 * 플래그 없음 회귀, DB 보고서 URL(없는 보고서·다른 프로젝트), 이중 쓰기 0(feedback 폴더·project.json·feedback.log 형식).
 * 모두 합성 자료. 서버는 임시 HOME·USERPROFILE·PES_HOME 에서만 뜬다. 준비물(DB 프로젝트·시작 질문 폼)은 파일 안에서 같이 쓴다 —
 * 그래서 폼을 개정하는 시험(H4)은 파일 끝에 둔다.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";

import type { CliEnv } from "./helpers/cli_write_env.ts";
import { folder_of, plain_legacy, read_lf, root_forms, write_json, write_legacy } from "./helpers/cli_read_env.ts";
import {
  ASK_SPEC,
  commit_count,
  db_with_form,
  feedback_body,
  http,
  pending_names,
  post_feedback,
  SLUG,
  start_server,
  step,
  sub_count,
  with_server,
  write_spec,
  type Server,
} from "./helpers/web_env.ts";
import { raw, tree } from "./helpers/web_raw.ts";

let c: CliEnv;
let s: Server;
let pes_home: string;
let objects: string;
const OTHER = "synthetic-other-db";
const OTHER_SECRET = "다른-프로젝트-비밀-제목-ZZ9";

before(async () => {
  c = await db_with_form();
  pes_home = c.env.home.env.PES_HOME as string;
  objects = join(c.env.home.env.HOME as string, ".pes", "objects");
  s = await start_server(c);
});

after(async () => {
  await s?.stop();
  c?.close();
});

const log_lines = (): string[] => (existsSync(join(c.folder, "feedback.log")) ? read_lf(join(c.folder, "feedback.log")).split("\n").filter(Boolean) : []);
const version = async (slug?: string): Promise<number> => {
  const r = await http(s, slug === undefined ? "/version" : `/${slug}/version`);
  assert.equal(r.status, 200, r.text);
  assert.ok(Number.isInteger(r.json.v) && r.json.v >= 0, r.text);
  return r.json.v as number;
};
const snapshot = () => ({ commits: commit_count(c), subs: sub_count(c), files: tree(pes_home), objects: tree(objects), log: log_lines() });

// ---------------------------------------------------------------------------
// 이중 쓰기 0 — 성공과 실패 모두

test("H10a 성공한 답 한 번의 흔적은 정확히 셋: DB 커밋 하나·object 파일 하나·feedback.log 한 줄 — feedback/ 폴더·project.json·그 밖의 파일은 없다", async () => {
  const before_state = snapshot();
  assert.ok(!existsSync(c.project_json), "시작부터 project.json 이 없다");
  const r = await post_feedback(s, SLUG, feedback_body({ text: "합성 흔적 시험", answers: { memo: "흔적" } }));
  assert.equal(r.status, 200, r.text);
  const now = snapshot();
  assert.equal(now.commits - before_state.commits, 1);
  assert.equal(now.subs - before_state.subs, 1);
  assert.deepEqual(now.objects.filter((f) => !before_state.objects.includes(f)).length, 1, "object 저장소에 새 파일 하나(답의 원본)");
  const added = now.files.filter((f) => !before_state.files.includes(f));
  assert.deepEqual(added, before_state.log.length === 0 ? [`${SLUG}/feedback.log`] : [], "PES 홈의 새 파일은 (처음이면) feedback.log 뿐");
  assert.ok(!existsSync(join(c.folder, "feedback")), "feedback/ 폴더를 만들지 않는다");
  assert.ok(!existsSync(c.project_json), "project.json 을 만들지 않는다");
  assert.equal(now.log.length - before_state.log.length, 1);
  const line = now.log[now.log.length - 1]!;
  const m = line.match(/^FEEDBACK (\S+) R(-?\d+) (\S+) (.+)$/);
  assert.ok(m, `v0.15 와 같은 줄 형식: ${line}`);
  assert.deepEqual([m![1], m![2], m![3]], ["plan", "0", "stage_start"]);
  const target = m![4]!;
  assert.equal(target.split(/[\\/]/).pop(), r.json.file);
  assert.ok(!existsSync(target), "알림 줄이 가리키는 feedback/<이름>.json 은 파일로 없다 — 이름만 처리 대기 이름이다");
  assert.ok(pending_names(c).includes(r.json.file), "pes pending 에 그 이름이 있다");
});

test("H10b 실패한 답은 흔적 0: 400·403·404·409·413 어느 쪽이든 DB·object 저장소·PES 홈·알림 줄이 그대로다 (고아 object 없음)", async () => {
  const sets = c.env.db.all<{ id: string }>("SELECT id FROM question_sets WHERE form_key = 'plan-start' ORDER BY version_no");
  const before_state = snapshot();
  const attempts: Array<[string, () => Promise<{ status: number }>, number[]]> = [
    ["빈 답", () => post_feedback(s, SLUG, feedback_body({ text: "", answers: {} })), [400]],
    ["없는 kind", () => post_feedback(s, SLUG, feedback_body({ kind: "bogus" })), [400]],
    ["깨진 JSON", () => post_feedback(s, SLUG, "{nope"), [400]],
    ["다른 출처", () => post_feedback(s, SLUG, feedback_body(), { origin: "http://evil.example" }), [403]],
    ["없는 프로젝트", () => post_feedback(s, "no-such-project", feedback_body()), [404]],
    ["없는 판 id", () => post_feedback(s, SLUG, feedback_body({ set_id: "no-such-set" })), [404, 409]],
    ["너무 큼", () => post_feedback(s, SLUG, JSON.stringify({ text: "x".repeat(300 * 1024) })), [413]],
  ];
  assert.ok(sets.length >= 1);
  for (const [what, send, want] of attempts) {
    const r = await send();
    assert.ok(want.includes(r.status), `${what}: ${r.status} (기대 ${want.join("/")})`);
  }
  const now = snapshot();
  assert.deepEqual(
    { commits: now.commits, subs: now.subs, files: now.files, objects: now.objects, log: now.log },
    { commits: before_state.commits, subs: before_state.subs, files: before_state.files, objects: before_state.objects, log: before_state.log },
    "실패한 요청이 어디에도 흔적을 남기지 않았다",
  );
});

test("H10c round 가 거대한 정수여도 알림 줄·처리 대기 이름·DB 가 같은 round 를 말한다 (한쪽만 R0 으로 바뀌면 pes watch 알림이 가리키는 답을 못 찾는다)", async () => {
  for (const round of [-1, 7, 2 ** 53, 10 ** 20]) {
    const one = snapshot();
    const r = await post_feedback(s, SLUG, `{"round":${typeof round === "number" && Number.isSafeInteger(round) ? round : BigInt(round).toString()},"kind":"feedback","stage":"plan","text":"합성 라운드 ${String(round)}","answers":{}}`);
    assert.ok([200, 400].includes(r.status), `round ${String(round)}: ${r.status} ${r.text}`);
    if (r.status !== 200) {
      // 거부(400)면 흔적 0
      const now = snapshot();
      assert.deepEqual([now.commits, now.subs, now.files, now.objects, now.log], [one.commits, one.subs, one.files, one.objects, one.log], `round ${String(round)}: 거부했는데 흔적이 남았다`);
      continue;
    }
    const line = log_lines().pop()!;
    const log_round = line.match(/^FEEDBACK \S+ R(-?\d+) /)![1]!;
    const name_round = (r.json.file as string).match(/-R(-?\d+)-/)![1]!;
    const stored = c.env.db.get<{ original_name: string; storage_key: string }>(
      "SELECT b.original_name, b.storage_key FROM submissions s JOIN blobs b ON b.project_id = s.project_id AND b.id = s.raw_blob_id ORDER BY s.rowid DESC LIMIT 1",
    )!;
    assert.equal(stored.original_name, r.json.file, `round ${String(round)}: DB 의 답 원본 이름 = 응답의 file`);
    const doc = JSON.parse(readFileSync(join(objects, ...stored.storage_key.split("/")), "utf8"));
    assert.equal(String(doc.round), name_round, `round ${String(round)}: DB 에 저장된 답의 round 가 이름·알림 줄과 같다`);
    assert.equal(log_round, name_round, `round ${String(round)}: 알림 줄 R${log_round} 와 처리 대기 이름 ${r.json.file} 가 다르다`);
  }
});

// ---------------------------------------------------------------------------
// 동시 제출 경합

/** 동시성 시험 하나를 자기만의 DB 프로젝트·서버·포트로 돌린다 — 앞 시험이 남긴 연결·파일이 섞이지 않게. */
async function isolated<T>(fn: (c: CliEnv, s: Server, snap: () => { commits: number; subs: number; log: string[] }) => Promise<T>): Promise<T> {
  const own = await db_with_form();
  try {
    const log = (): string[] => (existsSync(join(own.folder, "feedback.log")) ? read_lf(join(own.folder, "feedback.log")).split("\n").filter(Boolean) : []);
    return await with_server(own, {}, (srv) => fn(own, srv, () => ({ commits: commit_count(own), subs: sub_count(own), log: log() })));
  } finally {
    own.close();
  }
}

/** 모든 요청이 끝난 뒤에 판정한다(하나가 먼저 거절돼도 나머지가 끝나기 전에 서버·DB 를 치우지 않는다). */
async function settled_all<T>(jobs: Array<Promise<T>>): Promise<T[]> {
  const out = await Promise.allSettled(jobs);
  const failed = out.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason));
  assert.deepEqual(failed, [], "요청이 연결 단계에서 실패하지 않았다");
  return out.map((r) => (r as PromiseFulfilledResult<T>).value);
}

test("H3a 같은 폼을 두 탭(여러 요청)에서 같은 순간에 보낸다: 모두 받고, 제출은 요청마다 하나·이름은 서로 다르다 (같은 초 경합이 409/중복이 되면 안 된다)", async () => {
  await isolated(async (c3, s3, snap) => {
    const before_state = snap();
    const N = 8;
    const results = await settled_all(Array.from({ length: N }, (_, i) => post_feedback(s3, SLUG, feedback_body({ text: `합성 동시 ${i}`, answers: { memo: `동시 ${i}` } }))));
    const statuses = results.map((r) => r.status);
    assert.deepEqual(statuses, Array(N).fill(200), `동시 ${N}건: ${JSON.stringify(results.map((r) => [r.status, r.json?.error ?? r.json?.file]))}`);
    const names = results.map((r) => r.json.file as string);
    assert.equal(new Set(names).size, N, `처리 대기 이름이 서로 다르다: ${names.join(", ")}`);
    const now = snap();
    assert.equal(now.commits - before_state.commits, N, "제출마다 커밋 하나");
    assert.equal(now.subs - before_state.subs, N);
    assert.equal(now.log.length - before_state.log.length, N, "알림 줄도 정확히 N 줄 (섞이거나 빠지지 않는다)");
    const pending = pending_names(c3);
    for (const name of names) assert.ok(pending.includes(name), `${name} 이 처리 대기에 있다`);
    // 줄이 섞이지 않았다: 새 줄 모두 한 줄 형식
    for (const line of now.log.slice(before_state.log.length)) assert.match(line, /^FEEDBACK plan R0 stage_start \S+$/);
    // 같은 이름의 원본 파일(blob original_name)이 둘 이상 없다
    const dup = c3.env.db.all<{ original_name: string; n: number | bigint }>(
      "SELECT original_name, count(*) AS n FROM blobs WHERE original_name LIKE 'plan-R0-%' GROUP BY original_name HAVING count(*) > 1",
    );
    assert.deepEqual(dup, [], "같은 이름의 원본이 두 번 저장되지 않았다");
  });
});

test("H3b 같은 본문(바이트까지 같은 답)을 연달아 두 번 보내도 두 건으로 남는다 — 더블클릭이 한 건으로 합쳐져 사라지지도, 한 건이 두 번 처리되지도 않는다", async () => {
  await isolated(async (_c3, s3, snap) => {
    const before_state = snap();
    const body = JSON.stringify(feedback_body({ text: "합성 더블클릭", answers: { memo: "같은 본문" } }));
    const [a, b] = (await settled_all([post_feedback(s3, SLUG, body), post_feedback(s3, SLUG, body)])) as [Awaited<ReturnType<typeof post_feedback>>, Awaited<ReturnType<typeof post_feedback>>];
    assert.deepEqual([a.status, b.status], [200, 200], `${a.text} / ${b.text}`);
    assert.notEqual(a.json.file, b.json.file);
    const now = snap();
    assert.equal(now.subs - before_state.subs, 2, "v0.15 는 두 파일이었다 — 두 제출");
    assert.equal(now.log.length - before_state.log.length, 2);
  });
});

// ---------------------------------------------------------------------------
// /version 커서

// 되살림 (SEL-74 시험 쪽): 83bc0b3 의 H5a 그대로 — scripts/serve.ts 의 서버 갭 S2 (tests/README.md).
test("H5a /version: 읽기(대시보드·보고서·ping·실패한 POST)는 값을 올리지 않고, 다른 프로젝트의 쓰기는 이 프로젝트 값을 올리지 않으며 홈 값만 올린다", async () => {
  step(c, ["init", OTHER, "--topic", "합성 다른 주제"]);
  step(c, ["round-start", OTHER, "plan"]);
  const v0 = await version(SLUG);
  const home0 = await version();
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await http(s, `/${SLUG}/`)).status, 200);
    await http(s, `/${SLUG}/ping`);
    await http(s, "/");
    await http(s, `/${SLUG}/reports/plan/report.html`);
  }
  await post_feedback(s, SLUG, feedback_body({ kind: "bogus" })); // 실패
  await post_feedback(s, SLUG, feedback_body(), { origin: "http://evil.example" }); // 거부
  assert.equal(await version(SLUG), v0, "읽기·실패는 값을 올리지 않는다");
  assert.equal(await version(), home0);
  step(c, ["note", OTHER, "합성 다른 프로젝트 메모"]);
  assert.equal(await version(SLUG), v0, "다른 프로젝트의 쓰기는 이 프로젝트의 값을 올리지 않는다");
  assert.ok((await version()) > home0, "홈 목록 값은 어느 프로젝트의 변경이든 올라간다");
  assert.ok((await version(OTHER)) > 0);
});

// 되살림 (SEL-74 시험 쪽): 83bc0b3 의 H5b 그대로 — scripts/serve.ts 의 서버 갭 S2 (tests/README.md).
test("H5b /version 은 쿼리·끝 슬래시·긴 대기 요청 같은 잡음에도 정수 하나를 바로 돌려주고, 쓸 때마다 단조 증가한다", async () => {
  const started = Date.now();
  for (const path of [`/${SLUG}/version?cursor=garbage`, `/${SLUG}/version?wait_ms=600000`, `/${SLUG}/version/`, `/${SLUG}/version?cursor=%ff%fe`, `/${SLUG}/version?${"a=1&".repeat(500)}`]) {
    const r = await http(s, path);
    assert.equal(r.status, 200, `${path.slice(0, 60)}: ${r.status} ${r.text.slice(0, 80)}`);
    assert.ok(Number.isInteger(r.json?.v), `${path.slice(0, 60)}: v 는 정수`);
    assert.match(r.headers.get("cache-control") ?? "", /no-store/);
  }
  assert.ok(Date.now() - started < 20_000, "대기하지 않고 바로 답한다");
  let last = await version(SLUG);
  for (let i = 0; i < 3; i += 1) {
    const r = await post_feedback(s, SLUG, feedback_body({ text: `합성 증가 ${i}`, answers: { memo: `증가 ${i}` } }));
    assert.equal(r.status, 200);
    const now = await version(SLUG);
    assert.ok(now > last, `쓰기 ${i}: ${last} -> ${now}`);
    last = now;
  }
});

// ---------------------------------------------------------------------------
// DB 보고서 URL

// 되살림 (SEL-74 시험 쪽): 83bc0b3 의 H9 그대로 — scripts/serve.ts 의 서버 갭 S4 (tests/README.md).
test("H9 DB 보고서 URL: 만들지 않은 보고서·없는 파일·쿼리의 가짜 버전은 이 프로젝트 것만 보이고, 다른 프로젝트 보고서·blob 은 어떤 철자로도 나오지 않는다", async () => {
  // 다른 프로젝트: 항목 하나 + 보고서. 이 프로젝트(SLUG)는 plan 보고서를 아직 만들지 않았다.
  step(c, ["merge", OTHER, "plan", write_json(c, "other-items.json", [{ id: 1, kind: "topic", title: OTHER_SECRET, summary: "다른 프로젝트 요약", status: "done" }])]);
  step(c, ["render", OTHER, "plan"]);
  step(c, ["report", OTHER, "plan"]);
  const other = await http(s, `/${OTHER}/reports/plan/report.html`);
  assert.equal(other.status, 200, "다른 프로젝트의 보고서는 그 주소로 열린다");
  assert.ok(other.text.includes(OTHER_SECRET));

  const mine_before = await http(s, `/${SLUG}/reports/plan/report.html`);
  assert.equal(mine_before.status, 404, "이 프로젝트가 만들지 않은 보고서는 다른 프로젝트 것을 대신 내주지 않고 404");
  assert.ok(!mine_before.text.includes(OTHER_SECRET));

  step(c, ["report", SLUG, "plan"]);
  const mine = await http(s, `/${SLUG}/reports/plan/report.html`);
  assert.equal(mine.status, 200);
  assert.ok(!mine.text.includes(OTHER_SECRET), "내 보고서에 다른 프로젝트 내용이 없다");
  assert.ok(mine.text.includes("합성 기획 항목 하나"));

  // 없는 버전·가짜 버전 쿼리: 무시하거나 404, 다른 프로젝트·5xx 는 안 된다
  for (const q of ["?v=999", "?version=1", "?version=../" + OTHER, "?project=" + OTHER, "?slug=" + OTHER, "?edition=none", "#frag"]) {
    const r = await http(s, `/${SLUG}/reports/plan/report.html${q}`);
    assert.ok([200, 404].includes(r.status), `${q}: ${r.status}`);
    assert.ok(!r.text.includes(OTHER_SECRET), `${q}: 다른 프로젝트 내용`);
  }

  // blob 이름·저장 키·다른 프로젝트 철자로 파고들기
  const blobs = c.env.db.all<{ sha256: string; storage_key: string; original_name: string }>(
    "SELECT b.sha256, b.storage_key, b.original_name FROM blobs b JOIN projects p ON p.id = b.project_id WHERE p.slug = ?",
    OTHER,
  );
  assert.ok(blobs.length > 0, "다른 프로젝트에 blob 이 있다");
  const spellings = [
    `/${SLUG}/reports/plan/..%2f..%2f${OTHER}%2freports%2fplan%2freport.html`,
    `/${SLUG}/reports/plan/../../${OTHER}/reports/plan/report.html`,
    `/${SLUG}/reports/${OTHER}/report.html`,
    `/${SLUG}/reports/plan/report.html/../../../${OTHER}/reports/plan/report.html`,
    `/${SLUG}/out/..%2f${OTHER}%2freports%2fplan%2freport.html`,
    ...blobs.flatMap((b) => [
      `/${SLUG}/reports/plan/${b.sha256}`,
      `/${SLUG}/reports/plan/${encodeURIComponent(b.storage_key)}`,
      `/${SLUG}/out/${b.sha256}`,
      `/${SLUG}/out/${b.original_name}`,
      `/${SLUG}/reports/plan/${b.original_name}`,
    ]),
  ];
  for (const path of spellings) {
    const r = await raw(s, { path });
    assert.ok(!r.text.includes(OTHER_SECRET), `${path.slice(0, 90)}: 다른 프로젝트 내용이 나갔다 (${r.status})`);
    assert.ok(r.status !== 500 && r.status !== 0, `${path.slice(0, 90)}: ${r.status}`);
  }
  // 경로 모양이 틀린 보고서 주소는 404 (500·디렉터리 목록 아님)
  for (const path of [`/${SLUG}/reports`, `/${SLUG}/reports/`, `/${SLUG}/reports/plan`, `/${SLUG}/reports/plan/`, `/${SLUG}/reports/bogus/report.html`, `/${SLUG}/reports/PLAN/report.html`, `/${SLUG}/out`, `/${SLUG}/out/`, `/${SLUG}/reports/plan/report.html/extra`, `/${SLUG}/reports/plan/eli5.html`]) {
    const r = await raw(s, { path });
    assert.ok([404, 302].includes(r.status) || (r.status === 200 && path.endsWith("/")), `${path}: ${r.status}`);
    assert.ok(!r.text.includes("Directory listing"), `${path}: 폴더 목록을 보이지 않는다`);
  }
});

// ---------------------------------------------------------------------------
// 플래그 없음·다른 값 회귀

// 되살림 (SEL-74 시험 쪽): 83bc0b3 의 H8a 를 ts 대상으로 번역 — 서버 갭 S3, tests/README.md.
test("H8a PES_DB_CORE 는 서버에 아무 영향이 없다 (ts 번역): 값이 무엇이든(0·true·빈 값·\" 1\"·01·yes·1) DB 프로젝트의 화면은 요청 때 DB 에서 짓고, 답은 DB 에 쓰며, 폴더의 낡은 정적 파일을 내주지 않는다", async () => {
  // 0.15 는 값이 정확히 "1" 이 아니면 DB 를 쓰지 않고 폴더 파일을 정적으로 내줬다(이 시험의 원본, 83bc0b3). TS 에는 그 플래그가 없다 —
  // 옛 환경 변수가 남아 있어도(어떤 값이든) 서버가 달라지면 안 된다. 서버 갭 S3(요청 때 DB 로 짓는 화면), tests/README.md.
  const index = join(c.folder, "index.html");
  const hub = join(pes_home, "index.html");
  const STALE = "STALE-FILE-MUST-NOT-BE-SERVED-h8a";
  for (const flag of ["0", "true", "", " 1", "01", "yes", "1 ", "1"]) {
    step(c, ["note", SLUG, `합성 플래그 ${JSON.stringify(flag)} 메모 FLAG-NOTE-${flag.trim() || "empty"}`]);
    writeFileSync(index, STALE, "utf8"); // 낡은 정적 파일: DB 에서 짓는 화면이 이 파일을 내주면 안 된다
    writeFileSync(hub, STALE, "utf8");
    await with_server(c, { extra: { PES_DB_CORE: flag } }, async (srv) => {
      const before_state = snapshot();
      for (const path of [`/${SLUG}/`, "/"]) {
        const r = await raw(srv, { path });
        assert.equal(r.status, 200, `flag=${JSON.stringify(flag)} ${path}: ${r.status}`);
        assert.ok(!r.body.toString("utf8").includes(STALE), `flag=${JSON.stringify(flag)} ${path}: 폴더의 낡은 정적 파일을 내줬다 — DB 에서 새로 짓지 않았다`);
        assert.ok(r.body.toString("utf8").includes(SLUG) || path === "/", `flag=${JSON.stringify(flag)} ${path}: 프로젝트 화면이 아니다`);
      }
      const dash = await http(srv, `/${SLUG}/`);
      assert.ok(dash.text.includes("FLAG-NOTE-"), `flag=${JSON.stringify(flag)}: 쓰기 명령(note)만 했는데 화면에 보이지 않는다`);
      const post = await post_feedback(srv, SLUG, feedback_body({ text: `합성 플래그 답 ${JSON.stringify(flag)}`, answers: { memo: "플래그" } }));
      assert.equal(post.status, 200, `flag=${JSON.stringify(flag)}: DB 프로젝트의 답을 받아야 한다 — ${post.text}`);
      assert.equal(snapshot().commits - before_state.commits, 1, `flag=${JSON.stringify(flag)}: 답은 DB 에 한 번 쓴다`);
      const rep = await http(srv, `/${SLUG}/reports/plan/report.html`);
      assert.ok([200, 404].includes(rep.status), `flag=${JSON.stringify(flag)}: 보고서 길 ${rep.status}`);
    });
  }
});

// 되살림 (SEL-74 시험 쪽): 83bc0b3 의 H8b 를 ts 대상으로 번역 — 서버 갭 S3, tests/README.md.
test("H8b 옛 project.json 프로젝트: 이전(migrate) 전에는 답을 받지 않고(404, 폴더 불변), 이전한 뒤에는 DB 로 받아 응답 file 이 처리 대기 이름이고 알림 줄 형식이 v0.15 와 같다 (ts 번역)", async () => {
  // 0.15 는 플래그 켜진 서버가 옛 폴더의 답을 feedback/ 파일로 썼다(83bc0b3 의 원본). TS 는 옛 폴더에 쓰지 않는다(D14) — 이전하면 DB 길이다.
  const legacy = "synthetic-legacy-fmt";
  const dir = folder_of(c, legacy);
  write_legacy(dir, { ...plain_legacy(legacy), topic: "합성 옛 형식" });
  await with_server(c, {}, async (srv) => {
    const body = { stage: "plan", round: 2, kind: "feedback", text: "합성 옛 답", answers: { a: 1 }, spec: "x".repeat(200) };
    const refused = await post_feedback(srv, legacy, body);
    assert.equal(refused.status, 404, `이전 전: ${refused.text}`);
    assert.ok(!existsSync(join(dir, "feedback")), "이전 전: 옛 폴더에 feedback/ 를 만들지 않는다");
    step(c, ["migrate", legacy]);
    const r = await post_feedback(srv, legacy, body);
    assert.equal(r.status, 200, r.text);
    assert.ok(pending_names_of(legacy).includes(r.json.file), "응답의 file 은 처리 대기 이름");
    assert.ok(!existsSync(join(dir, "feedback", r.json.file)), "DB 로 간 프로젝트는 feedback/ 파일을 만들지 않는다");
    const lines = read_lf(join(dir, "feedback.log")).split("\n").filter(Boolean);
    assert.equal(lines.length, 1);
    const m = lines[0]!.match(/^FEEDBACK plan R2 feedback (.+)$/);
    assert.ok(m, `알림 줄 형식: ${lines[0]}`);
    assert.equal(m![1]!.split(/[\\/]/).pop(), r.json.file, "알림 줄이 가리키는 이름 = 응답의 file");
  });
});

function pending_names_of(slug: string): string[] {
  const out = step(c, ["pending", slug]);
  return out.split("\n").map((x) => x.trim()).filter(Boolean).map((x) => x.split(/[\\/]/).pop()!);
}

// ---------------------------------------------------------------------------
// 옛 판 폼 409 경계 (폼을 개정하므로 파일 끝)

test("H4 판 경계: 옛 판 set_id 는 409, 최신 판은 200 으로 그 판에 붙고, 모르는 판·다른 폼의 판은 404 — 거절은 흔적 0, 받은 것은 정확히 한 건", async () => {
  const sets = () => c.env.db.all<{ id: string; version_no: number }>("SELECT id, version_no FROM question_sets WHERE form_key = 'plan-start' ORDER BY version_no");
  const v1 = sets();
  const old_set = v1[v1.length - 1]!.id;
  // 다른 폼(같은 단계)도 하나 만든다 — 그 판 id 를 plan-start 답에 실어 보내는 공격/버그용
  step(c, ["ask", SLUG, write_spec(c, { ...ASK_SPEC, id: "plan-extra", title: "다른 폼" }, "ask-extra.json")]);
  const extra = c.env.db.get<{ id: string }>("SELECT id FROM question_sets WHERE form_key = 'plan-extra' ORDER BY version_no DESC LIMIT 1");
  assert.ok(extra !== undefined, "다른 폼의 판");
  // plan-start 의 새 판
  const changed = { ...ASK_SPEC, questions: ASK_SPEC.questions.map((q) => (q.id === "scope" ? { ...q, label: "범위는? (개정)" } : q)) };
  step(c, ["ask", SLUG, write_spec(c, changed, "ask-v2.json")]);
  const v2 = sets();
  assert.ok(v2.length > v1.length, "새 판이 올라갔다");
  const newest = v2[v2.length - 1]!.id;
  assert.notEqual(newest, old_set);

  const old_count = c.env.db.all("SELECT 1 FROM submissions WHERE set_id = ?", old_set).length;
  const before_state = snapshot();
  const send = (extra_fields: Record<string, unknown>) => post_feedback(s, SLUG, feedback_body(extra_fields));

  const stale = await send({ set_id: old_set });
  assert.equal(stale.status, 409, `옛 판: ${stale.status} ${stale.text}`);
  assert.equal(stale.json?.ok, false);
  assert.equal(stale.json?.error, "conflict");
  const unknown = await send({ set_id: "no-such-set" });
  assert.equal(unknown.status, 404, `모르는 판: ${unknown.status} ${unknown.text}`);
  const other_form = await send({ set_id: extra!.id });
  assert.equal(other_form.status, 404, `다른 폼의 판 id 로 plan-start 답을 보낼 수 없다: ${other_form.status} ${other_form.text}`);
  const numeric = await send({ set_id: 12345 }); // 문자열이 아닌 판 id = 판을 말하지 않은 것: 판이 여럿이면 어느 판인지 모르니 409
  assert.equal(numeric.status, 409, `판을 말하지 않음: ${numeric.status} ${numeric.text}`);
  const none = await send({});
  assert.equal(none.status, 409, `판 id 없음(판이 여럿): ${none.status} ${none.text}`);
  assert.deepEqual(
    { ...snapshot(), files: undefined }.commits,
    before_state.commits,
    "거절은 DB 에 쓰지 않는다",
  );
  const refused = snapshot();
  assert.deepEqual([refused.subs, refused.objects, refused.log, refused.files], [before_state.subs, before_state.objects, before_state.log, before_state.files], "거절은 흔적 0");

  const fresh = await send({ set_id: newest });
  assert.equal(fresh.status, 200, fresh.text);
  const row = c.env.db.get<{ set_id: string }>("SELECT set_id FROM submissions ORDER BY rowid DESC LIMIT 1")!;
  assert.equal(row.set_id, newest, "최신 판에 붙었다");
  assert.equal(snapshot().subs - before_state.subs, 1);

  // 두 탭: 하나는 옛 판 화면, 하나는 최신 판 화면에서 동시에 보낸다 — 최신만 받고 옛 것은 409 (몰래 새 판에 붙지 않는다)
  const [a, b] = await Promise.all([send({ set_id: old_set, text: "합성 옛 탭" }), send({ set_id: newest, text: "합성 새 탭" })]);
  assert.deepEqual([a.status, b.status], [409, 200], `${a.text} / ${b.text}`);
  const on_old = (): number => c.env.db.all("SELECT 1 FROM submissions WHERE set_id = ?", old_set).length;
  assert.equal(on_old(), old_count, "옛 판에는 새로 붙은 제출이 없다");

  // 승인·다시 열기·일반 의견은 폼 답이 아니다: 판이 개정돼도 막지 않는다
  for (const kind of ["approve", "reopen", "feedback"]) {
    const r = await send({ kind, set_id: old_set, text: `합성 ${kind}`, answers: kind === "approve" ? { approve: true } : {} });
    assert.equal(r.status, 200, `${kind}: ${r.status} ${r.text}`);
  }
  assert.ok(sub_count(c) > 0);
  void writeFileSync;
  void readdirSync;
});
