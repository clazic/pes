// SEL-74 5단계 준비(시험 쪽) — `pes migrate` 보강: 검증이 실패한 뒤의 staging 프로젝트와 숨김 소유자 프로젝트.
//   1. validate 가 실패하면 아무것도 켜지지 않는다(종료 1, 한국어 한 줄). DB 에는 staging 프로젝트가 남는다 — 그것은 목록·상태·홈 화면에
//      **정상 프로젝트로 보이지 않는다**: 주제·차례·단계 요약 줄이 없고 `이전` 안내가 붙은 오류 줄로만 나온다. 같은 폴더를 또 이전하려다
//      실패해도 staging 행이 늘지 않는다.
//   2. 원인(손으로 고친 보고서)을 고친 뒤 다시 migrate 하면 성공한다: 그 슬러그의 프로젝트는 하나뿐(중복 없음), active, 목록에 정상 줄로 나온다.
//   3. 빈 DB 에서 첫 이전이 만드는 소유자 숨김 프로젝트(pes-local-owner)는 어떤 목록·화면에도 나오지 않는다.
// 합성 자료만, 임시 HOME·USERPROFILE·PES_HOME 에서 가드 아래 자식으로.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { free_port, type CompatCtx } from "./helpers/compat_env.ts";
import { use_home_guard } from "./helpers/home_guard.ts";
import { assert_one_line_error, bytes_digest, db_rows, legacy_folder, mtime_map, norm_root, pes_ts, project_row, with_ctx } from "./helpers/sel74_env.ts";
import { page_data } from "./helpers/web_env.ts";

use_home_guard();

const SLUG = "mig-staging";
const OWNER_SLUG = "pes-local-owner";
const TOPIC = "합성 도서관 운영 연구"; // the topic of the `full` fixture

/** A `full` folder whose plan report was edited by hand: validate refuses it (reports_regeneration). Returns the folder and the good report. */
function broken_folder(ctx: CompatCtx): { dir: string; report: string; good: string } {
  const dir = legacy_folder(ctx, SLUG, "full");
  const report = join(dir, "reports", "plan", "report.md");
  const good = readFileSync(report, "utf8");
  writeFileSync(report, "# 사람이 직접 고친 보고서\n", "utf8");
  return { dir, report, good };
}

/** the statuses of the projects with this slug (one entry per project row) */
function slug_rows(ctx: CompatCtx, slug: string): string[] {
  return db_rows<{ status: string }>(ctx, "SELECT status FROM projects WHERE slug = ?", slug).map((r) => r.status);
}

/** The home page `hub` builds, read through an injected single port (never 8760~8775); then `stop`. */
async function hub_data(ctx: CompatCtx): Promise<any> {
  const port = await free_port();
  const options = { env: { PES_HUB_PORTS: `${port}-${port}` }, allow_child_process: true, allow_hub_port: port };
  const started = pes_ts(ctx, ["hub"], options);
  assert.equal(started.status, 0, `hub: ${started.stderr}${started.stdout}`);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200, "GET / of the hub");
    return page_data(await res.text());
  } finally {
    pes_ts(ctx, ["stop"], options);
  }
}

test("M1: a failed validation activates nothing (exit 1, one Korean line naming the cause) and leaves the folder untouched — a staging project stays in the database", { timeout: 300_000 }, async () => {
  await with_ctx("pes-mig-staging1-", async (ctx) => {
    const { dir } = broken_folder(ctx);
    const bytes = bytes_digest(dir);
    const times = mtime_map(dir);
    const run = pes_ts(ctx, ["migrate", SLUG]);
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.equal(run.stdout, "", "nothing is reported as migrated");
    assert_one_line_error(run, "validate failure");
    assert.match(run.stderr, /reports_regeneration/, "names the cause");
    assert.match(run.stderr, /report\.md/, "names the file");
    assert.deepEqual(slug_rows(ctx, SLUG), ["staging"], "exactly one project row, still staging");
    assert.equal(bytes_digest(dir), bytes, "the folder's bytes are unchanged");
    assert.deepEqual(mtime_map(dir), times, "the folder's mtimes are unchanged");
  });
});

test("M2: the staging project is not shown as a project: `list` gives it only the 'migrate it' error row (no topic, no turn, no stage line), `status` refuses with one line, and the home page lists no normal row for it", { timeout: 300_000 }, async () => {
  await with_ctx("pes-mig-staging2-", async (ctx) => {
    broken_folder(ctx);
    assert.equal(pes_ts(ctx, ["migrate", SLUG]).status, 1);

    const list = pes_ts(ctx, ["list"]);
    assert.equal(list.status, 0, list.stderr);
    const out = norm_root(list.stdout, ctx.home.root);
    assert.match(out, new RegExp(`\\(${SLUG}\\)`), "the folder is still listed (the user must see what waits)");
    assert.match(out, /\[오류\]/, "as an error row");
    assert.match(out, /이전하세요/, "with the way out");
    assert.doesNotMatch(out, new RegExp(TOPIC), "the staging project's topic is not shown");
    assert.doesNotMatch(out, /\[(Claude|내 차례)\]/, "it has no turn (it is not a served project)");
    assert.doesNotMatch(out, /조사 R\d|기획 R\d|받은 답/, "no stage summary line");

    const status = pes_ts(ctx, ["status", SLUG]);
    assert.notEqual(status.status, 0, "status of a staging project is refused");
    assert.equal(status.stdout, "", "no state is printed");
    assert_one_line_error(status, "status of a staging project");
    assert.match(status.stderr, new RegExp(SLUG), "names the project");

    const hub = await hub_data(ctx);
    const rows = (hub.projects ?? []) as Array<{ slug: string; topic?: string; turn?: string; current?: string }>;
    const mine = rows.filter((p) => p.slug === SLUG);
    assert.ok(mine.every((p) => p.topic !== TOPIC && (p.turn === undefined || p.turn === "" || p.turn === "오류")), `the home page shows no normal row for the staging project: ${JSON.stringify(mine)}`);
  });
});

test("M3: failing again changes nothing — still ONE staging row, the folder untouched", { timeout: 300_000 }, async () => {
  await with_ctx("pes-mig-staging3-", async (ctx) => {
    const { dir } = broken_folder(ctx);
    assert.equal(pes_ts(ctx, ["migrate", SLUG]).status, 1);
    const before = db_rows<{ id: string }>(ctx, "SELECT id FROM projects WHERE slug = ?", SLUG);
    assert.equal(before.length, 1);
    const bytes = bytes_digest(dir);
    const again = pes_ts(ctx, ["migrate", SLUG]);
    assert.equal(again.status, 1, again.stdout + again.stderr);
    assert_one_line_error(again, "second failure");
    assert.deepEqual(db_rows<{ id: string }>(ctx, "SELECT id FROM projects WHERE slug = ?", SLUG).map((r) => r.id), before.map((r) => r.id), "the same single staging project row (no second one)");
    assert.deepEqual(slug_rows(ctx, SLUG), ["staging"]);
    assert.equal(bytes_digest(dir), bytes);
  });
});

test("M4: after the cause is fixed a new `migrate` succeeds — one project for the slug (no duplicate), active, a normal row in `list`, a normal `status`, a verified backup", { timeout: 300_000 }, async () => {
  await with_ctx("pes-mig-staging4-", async (ctx) => {
    const { report, good } = broken_folder(ctx);
    assert.equal(pes_ts(ctx, ["migrate", SLUG]).status, 1);
    writeFileSync(report, good, "utf8"); // fix the cause
    const run = pes_ts(ctx, ["migrate", SLUG]);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /이전했습니다/, run.stdout);
    assert.doesNotMatch(run.stdout, /이미 이전됨/);

    assert.deepEqual(slug_rows(ctx, SLUG), ["active"], "exactly one project for the slug, now active");
    const projects = db_rows<{ slug: string }>(ctx, "SELECT slug FROM projects").map((r) => r.slug).sort();
    assert.deepEqual(projects, [SLUG, OWNER_SLUG].sort(), "only the migrated project and the hidden owner project exist (no leftover staging row)");
    assert.equal(project_row(ctx, SLUG)?.status, "active");

    const list = norm_root(pes_ts(ctx, ["list"]).stdout, ctx.home.root);
    assert.match(list, new RegExp(`${TOPIC}\\s+\\(${SLUG}\\)`), "a normal row with the topic");
    assert.doesNotMatch(list, /\[오류\]/, "no error row any more");
    const status = pes_ts(ctx, ["status", SLUG]);
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, new RegExp(`주제: ${TOPIC}`));

    const again = pes_ts(ctx, ["migrate", SLUG]);
    assert.equal(again.status, 0);
    assert.match(again.stdout, /이미 이전됨/, "a third run is `이미 이전됨`");
    assert.deepEqual(slug_rows(ctx, SLUG), ["active"], "still one row");
  });
});

test("M5: the hidden owner project made on an empty database (pes-local-owner) is in no list and no home page", { timeout: 300_000 }, async () => {
  await with_ctx("pes-mig-owner-", async (ctx) => {
    legacy_folder(ctx, SLUG, "full");
    const run = pes_ts(ctx, ["migrate", SLUG]);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.ok(project_row(ctx, OWNER_SLUG) !== undefined, "the owner project exists in the database after the first migration");
    for (const args of [["list"], ["list", "--"]]) {
      const list = pes_ts(ctx, args);
      assert.doesNotMatch(norm_root(list.stdout, ctx.home.root), new RegExp(OWNER_SLUG), `${args.join(" ")}: no owner project row`);
    }
    // (`doctor` does name it — 'PES 로컬 소유자 (이전 도구가 만든 자리 — 지우지 마세요)' — on purpose: that line is the explanation, not a project row.)
    const hub = await hub_data(ctx);
    assert.ok(!JSON.stringify(hub).includes(OWNER_SLUG), "the home page does not list the owner project");
    const names = ((hub.projects ?? []) as Array<{ slug: string }>).map((p) => p.slug);
    assert.deepEqual(names, [SLUG], "the home page lists the migrated project only");
  });
});
