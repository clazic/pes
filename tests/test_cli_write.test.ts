/**
 * SEL-48 PR15 — CLI 쓰기 전환 (tester, 작성 모드). 구현 전이므로 실패하는 것이 정상이다.
 *
 * 시험 방식: CLI는 Python이므로 `python3 -I scripts/pes.py ...`를 subprocess로 실행한다. HOME·USERPROFILE·
 * PES_HOME을 모두 임시 폴더로 바꾸고(tests/helpers/cli_write_env.ts), DB(HOME/.pes/pes.db)는 시험이 명령 서비스로
 * 만들어 둔다. 결과는 DB의 mutation_commits·approvals·project_leases와 파일(project.json 바이트·mtime)로 확인한다.
 * 구현 내부(브리지 모양)는 고정하지 않는다 — CLI 바깥 동작만 본다.
 *
 * 플래그: 새 DB 쓰기 경로는 환경 변수 PES_DB_CORE=1 일 때만 켜진다(하니스가 기본으로 켬). 꺼져 있으면 v0.15 그대로.
 *
 * 이 시험이 고정하는 해석(보고서에도 적음):
 *   - 인증: PES_TOKEN 없음 = 이 컴퓨터 DB의 사람 소유자(via "cli"), PES_TOKEN=<에이전트 토큰> = 그 에이전트 actor.
 *   - 새 5개 명령은 JSON 한 개를 stdout에 내고, 가드는 `--run <id> --lease <id> --fence <n>`로 받는다.
 *   - 프로젝트 상태를 바꾸는 쓰기는 mutation_commits(via="cli")를 남긴다. serve/stop/home/remote는 기계 단위 설정이라
 *     프로젝트 상태 쓰기가 아니다(home은 DB·객체를 그대로 둔다).
 *   - 옛 CLI의 우회(근거 없는 approve, 한 번도 안 연 단계 reopen, 두 번째 approve, 토큰 보유자의 approve·reopen·
 *     lock --force)는 거부한다.
 *   - 새 코어 명령 6개: input.mark_processed(mark) input.record_chat(chat) project.add_note(note)
 *     qa.record(qa) qa.record_brief(qa-brief) question.prepare_draft(ask-prep). 영수증 action은 `<네임스페이스>.…`.
 */

import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { COMMANDS } from "../scripts/pes_core/commands.ts";
import { EXPECTED_COMMAND_NAMES } from "./helpers/command_names.ts";
import { expect_rejected, json_out, make_cli_env, PES_PY, REPO, SLUG, with_cli, type CliEnv, type CliResult, type Commit } from "./helpers/cli_write_env.ts";
import { new_artifact } from "./helpers/blob_env.ts";
import { approvals_of, drive_stage, make_content, round_row, seal, stage_row, start, type SealResult } from "./helpers/editions_env.ts";
import { state_signature, table_counts } from "./helpers/state_signature.ts";

// ---------------------------------------------------------------------------
// 4.3 배정표 (docs/plan/stage-2.md 245행~)

const WRITE_19 = ["init", "ask-prep", "ask", "round-start", "merge", "render", "approve", "reopen", "mark", "chat", "note", "qa-brief", "qa", "remote", "serve", "stop", "home", "lock", "unlock"];
const READ_13 = ["status", "pending", "digest", "show", "list", "hub", "open", "which", "doctor", "watch", "assemble", "report", "web"];
const NEW_5 = ["context", "claim", "submit", "wait", "complete"];

/** CLI 명령 -> 영수증 action (정확한 값 또는 `접두어.` 네임스페이스). */
const RECEIPT: Record<string, string> = {
  init: "project.created",
  "ask-prep": "question.",
  ask: "question.set_published",
  "round-start": "round.started",
  render: "round.sealed",
  approve: "stage.approved",
  reopen: "stage.reopened",
  mark: "input.",
  chat: "input.",
  note: "project.note_added",
  "qa-brief": "qa.",
  qa: "qa.",
  lock: "run.claimed",
  claim: "run.claimed",
  submit: "result.submitted",
  wait: "run.waiting_human",
  complete: "run.completed",
};

function matches_receipt(cli_command: string, commit: Commit): boolean {
  const want = RECEIPT[cli_command];
  return want.endsWith(".") ? commit.action.startsWith(want) : commit.action === want;
}

function doc_commands(row_label: string): string[] {
  const doc = readFileSync(join(REPO, "docs", "plan", "stage-2.md"), "utf8");
  const line = doc.split("\n").find((l) => l.startsWith(`| ${row_label}`));
  assert.ok(line, `4.3 table row "${row_label}" exists`);
  // Only the "명령" column; the third column mentions commands and flags again in prose.
  const cell = line.split("|")[2] ?? "";
  return [...cell.matchAll(/`([a-z-]+)`/g)].map((m) => m[1]!);
}

test("4.3 배정표: 쓰기 19 + 읽기 13 = 32, pes.py CMDS와 같고 새 5개가 더해진다", () => {
  assert.equal(WRITE_19.length, 19);
  assert.equal(READ_13.length, 13);
  assert.deepEqual([...doc_commands("15 쓰기")].sort(), [...WRITE_19].sort(), "문서 4.3의 PR15 칸");
  assert.deepEqual([...doc_commands("16 읽기")].sort(), [...READ_13].sort(), "문서 4.3의 PR16 칸 (읽기는 PR16 몫)");
  const source = readFileSync(PES_PY, "utf8");
  const block = source.slice(source.indexOf("CMDS = {"), source.indexOf("def main("));
  const cmds = [...block.matchAll(/"([a-z-]+)":\s*cmd_/g)].map((m) => m[1]!).sort();
  assert.deepEqual(cmds, [...WRITE_19, ...READ_13, ...NEW_5].sort(), "CMDS는 32개 + context·claim·submit·wait·complete");
  // 읽기 13개는 PR16 몫: 이 PR의 영수증 표에 없다.
  for (const name of READ_13) assert.equal(RECEIPT[name], undefined, `${name}은 PR16 몫`);
});

test("새 코어 명령 6개가 등록 기대 목록에 있다", () => {
  for (const name of ["input.mark_processed", "input.record_chat", "project.add_note", "qa.record", "qa.record_brief", "question.prepare_draft"]) {
    assert.ok(EXPECTED_COMMAND_NAMES.includes(name), `${name} in command_names.ts`);
    assert.ok(COMMANDS.has(name), `${name} is registered in the command service`);
  }
});

// ---------------------------------------------------------------------------
// 공통: 한 번 실행해서 project.json 불변·영수증 확인

interface Ran {
  res: CliResult;
  commits: Commit[];
}

function run_write(c: CliEnv, args: string[], extra: Record<string, string | undefined> = {}): Ran {
  const before_sig = c.sig(c.project_json);
  const before_listing = c.listing(c.folder);
  const n = c.commits().length;
  const res = c.run(args, extra);
  const after_sig = c.sig(c.project_json);
  assert.deepEqual(after_sig, before_sig, `${args[0]}: project.json 바이트·mtime 불변`);
  const added = c.listing(c.folder).filter((f) => !before_listing.includes(f));
  assert.ok(!added.includes("project.json.tmp") && !added.includes("library.json"), `${args[0]}: 직접 쓰기 흔적 없음 (${added})`);
  return { res, commits: c.commits_since(n) };
}

function expect_cli_commit(c: CliEnv, command: string, ran: Ran): Commit {
  assert.equal(ran.res.status, 0, `${command}: exit ${ran.res.status}\n${ran.res.stderr}${ran.res.stdout}`);
  const hit = ran.commits.find((m) => matches_receipt(command, m));
  assert.ok(hit, `${command}: 영수증 ${RECEIPT[command]} 필요, 실제 [${ran.commits.map((m) => m.action)}]`);
  assert.equal(hit.via, "cli");
  assert.equal(hit.actor_id, c.env.p.actor_id, "사람 CLI의 actor는 프로젝트 소유자");
  const row = c.env.db.get<{ on_behalf_of_user_id: string | null }>("SELECT on_behalf_of_user_id FROM mutation_commits WHERE id = ?", hit.id);
  const owner = c.env.db.get<{ owner_user_id: string }>("SELECT owner_user_id FROM projects WHERE id = ?", c.env.p.project_id);
  assert.equal(row?.on_behalf_of_user_id ?? owner?.owner_user_id, owner?.owner_user_id, "소유자 귀속");
  const events = c.env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM events WHERE tx_id = ?", hit.id);
  assert.ok((events?.n ?? 0n) >= 1n, "같은 tx에 사건이 남는다");
  return hit;
}

// ---------------------------------------------------------------------------
// 1 · 쓰기 명령이 모두 명령 서비스를 지난다 (의미 보존: 옛 출력 문구)

test("round-start: R1 시작, round.started 영수증", () =>
  with_cli(async (c) => {
    const ran = run_write(c, ["round-start", SLUG, "plan"]);
    expect_cli_commit(c, "round-start", ran);
    assert.match(ran.res.stdout, /기획 R1 시작/);
    const rounds = c.env.db.all<{ round_no: bigint; state: string }>("SELECT round_no, state FROM rounds WHERE stage_id = ?", c.stages.plan);
    assert.deepEqual(rounds.map((r) => [Number(r.round_no), r.state]), [[1, "open"]]);
  }));

test("render: 열린 라운드를 봉인(스냅샷), round.sealed 영수증", () =>
  with_cli(async (c) => {
    const round = await start(c.env, c.stages.plan, "r-start");
    // 정정(최종 리뷰 1 R2): 단계 미지정(stage_id NULL) artifact 는 단계 봉인에 들어가지 않는다 — 기획 단계 항목을 CLI merge 로 만든다.
    const items = join(c.env.home.root, "render-items.json");
    writeFileSync(items, JSON.stringify([{ id: 1, kind: "topic", title: "합성 기획 항목", summary: "x" }]), "utf8");
    assert.equal(c.run(["merge", SLUG, "plan", items]).status, 0, "기획 항목 merge");
    const ran = run_write(c, ["render", SLUG, "plan"]);
    expect_cli_commit(c, "render", ran);
    assert.equal(round_row(c.env.db, round.round_id).state, "sealed");
  }));

test("approve: 봉인된 라운드를 사람 소유자가 승인, 옛 출력 문구 보존", () =>
  with_cli(async (c) => {
    const round = await start(c.env, c.stages.plan, "a-start");
    const content = await make_content(c.env, "a-content");
    const versions = [{ object_id: content.object_id, version_id: content.version_id }];
    const sealed = (await seal(c.env, round.round_id, versions, "a-seal")).result as SealResult;
    const ran = run_write(c, ["approve", SLUG, "plan"]);
    expect_cli_commit(c, "approve", ran);
    assert.match(ran.res.stdout, /기획 승인/);
    assert.match(ran.res.stdout, /다음 단계: 조사/);
    const rows = approvals_of(c.env.db, c.stages.plan);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.snapshot_id, sealed.snapshot_id);
    assert.equal(rows[0]!.actor_kind, "human");
    assert.equal(stage_row(c.env.db, c.stages.plan).status, "approved");
  }));

test("reopen: 승인한 단계를 다시 연다, 옛 출력 문구 보존", () =>
  with_cli(async (c) => {
    await drive_stage(c.env, c.stages.plan, "o");
    const ran = run_write(c, ["reopen", SLUG, "plan"]);
    expect_cli_commit(c, "reopen", ran);
    assert.match(ran.res.stdout, /기획 다시 열림/);
    assert.notEqual(stage_row(c.env.db, c.stages.plan).status, "approved");
  }));

test("note: 인계 메모 N개 (N은 DB의 메모 수), project.add_note", () =>
  with_cli(async (c) => {
    const first = run_write(c, ["note", SLUG, "첫 합성 메모"]);
    expect_cli_commit(c, "note", first);
    assert.match(first.res.stdout, /인계 메모 1개/);
    const second = run_write(c, ["note", SLUG, "둘째", "합성", "메모"]);
    expect_cli_commit(c, "note", second);
    assert.match(second.res.stdout, /인계 메모 2개/);
  }));

test("mark·chat: 처리 완료 표시와 채팅 기록이 input.* 영수증을 남긴다", () =>
  with_cli(async (c) => {
    const chat = run_write(c, ["chat", SLUG, "plan", "합성 채팅 지시"]);
    expect_cli_commit(c, "chat", chat);
    const marked = run_write(c, ["mark", SLUG, "feedback/plan-R1-a.json", "feedback/plan-R1-b.json"]);
    expect_cli_commit(c, "mark", marked);
    assert.match(marked.res.stdout, /처리 완료 표시 2개/);
  }));

test("ask-prep·ask: 질문 초안과 게시가 question.* 영수증을 남긴다", () =>
  with_cli(async (c) => {
    await start(c.env, c.stages.plan, "q-start");
    const prep = run_write(c, ["ask-prep", SLUG, "plan"]);
    expect_cli_commit(c, "ask-prep", prep);
    const spec = join(c.env.home.root, "ask-spec.json");
    copyFileSync(join(REPO, "questions", "plan.json"), spec);
    const ask = run_write(c, ["ask", SLUG, spec]);
    expect_cli_commit(c, "ask", ask);
    const sets = c.env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM question_sets WHERE project_id = ?", c.env.p.project_id);
    assert.equal(sets?.n, 1n);
  }));

test("merge: 서브에이전트 결과 병합이 content·result 영수증을 남긴다", () =>
  with_cli(async (c) => {
    await start(c.env, c.stages.plan, "m-start");
    const file = join(c.env.home.root, "result.json");
    writeFileSync(file, JSON.stringify([{ id: 1, title: "합성 항목", summary: "합성 요약" }]), "utf8");
    const ran = run_write(c, ["merge", SLUG, "plan", file]);
    assert.equal(ran.res.status, 0, ran.res.stderr);
    assert.ok(ran.commits.length >= 1 && ran.commits.every((m) => m.via === "cli"));
    assert.ok(ran.commits.some((m) => /^(content|result)\./.test(m.action)), `[${ran.commits.map((m) => m.action)}]`);
  }));

test("qa-brief·qa: 독립 검토 지시문과 결과가 qa.* 영수증을 남긴다", () =>
  with_cli(async (c) => {
    await start(c.env, c.stages.plan, "qa-start");
    const brief = run_write(c, ["qa-brief", SLUG, "plan"]);
    expect_cli_commit(c, "qa-brief", brief);
    const file = join(c.env.home.root, "qa.json");
    writeFileSync(file, JSON.stringify({ verdict: "pass", qc: [], qa: [], spot_checks: [], missed_by_self_review: [] }), "utf8");
    const qa = run_write(c, ["qa", SLUG, "plan", "--file", file]);
    expect_cli_commit(c, "qa", qa);
    assert.match(qa.res.stdout, /독립 검토: pass/);
  }));

test("init: 새 프로젝트는 project.bootstrap으로 만들고 project.json을 만들지 않는다", () =>
  with_cli(async (c) => {
    const projects_before = table_counts(c.env.db).projects;
    const n = c.commits().length;
    const res = c.run(["init", "synthetic-init", "--topic", "합성 새 주제"]);
    assert.equal(res.status, 0, res.stderr + res.stdout);
    const added = c.commits_since(n);
    const created = added.find((m) => m.action === "project.created");
    assert.ok(created, `[${added.map((m) => m.action)}]`);
    assert.equal(created.via, "cli");
    assert.equal(table_counts(c.env.db).projects, (projects_before ?? 0n) + 1n);
    const row = c.env.db.get<{ topic: string }>("SELECT topic FROM projects WHERE slug = 'synthetic-init'");
    assert.equal(row?.topic, "합성 새 주제");
    const folder = join(c.env.home.env.PES_HOME as string, "synthetic-init");
    assert.ok(!existsSync(join(folder, "project.json")), "init이 project.json을 쓰지 않는다");
    // 같은 이름 다시 init은 거부 (옛 CLI: 이미 프로젝트가 있습니다, 종료 2)
    const again = c.run(["init", "synthetic-init", "--topic", "또"]);
    expect_rejected(again, "중복 init");
    assert.equal(table_counts(c.env.db).projects, (projects_before ?? 0n) + 1n);
  }));

// ---------------------------------------------------------------------------
// 2 · project.json 직접 쓰기 0 / 미전환(legacy) 프로젝트

test("DB에 없는 옛 프로젝트의 쓰기는 project.json을 건드리지 않고 거부된다", () =>
  with_cli(async (c) => {
    const folder = join(c.env.home.env.PES_HOME as string, "legacy-only");
    mkdirSync(folder, { recursive: true });
    const json = join(folder, "project.json");
    writeFileSync(json, '{"pes":1,"topic":"합성 옛","slug":"legacy-only","stages":{}}', "utf8");
    const sig = c.sig(json);
    const signature = state_signature(c.env.db);
    for (const args of [["note", "legacy-only", "x"], ["round-start", "legacy-only", "plan"], ["approve", "legacy-only", "plan"], ["chat", "legacy-only", "plan", "x"]]) {
      expect_rejected(c.run(args), args[0]!);
      assert.deepEqual(c.sig(json), sig, `${args[0]}: project.json 불변`);
    }
    assert.equal(state_signature(c.env.db), signature, "DB도 불변");
  }));

// ---------------------------------------------------------------------------
// 3 · pes home

test("pes home은 프로젝트 폴더만 옮기고 DB·객체는 그대로 둔다", () =>
  with_cli(async (c) => {
    await drive_stage(c.env, c.stages.plan, "h");
    assert.equal(c.run(["init", "synthetic-second", "--topic", "합성 둘째"]).status, 0);
    const signature = state_signature(c.env.db);
    const objects = c.listing(c.env.objects);
    const db_file = c.env.db.path;
    const json_sha = c.sig(c.project_json).sha;
    const target = join(c.env.home.root, "moved-projects");
    const res = c.run(["home", target]);
    assert.equal(res.status, 0, res.stderr + res.stdout);
    assert.match(res.stdout, /PES 홈 변경/);
    assert.equal(c.sig(join(target, SLUG, "project.json")).sha, json_sha, "옛 JSON은 그대로 따라 옮겨진다");
    assert.ok(!existsSync(c.folder), "옛 폴더는 비었다");
    assert.ok(existsSync(join(target, "synthetic-second")), "project.json 없는 새 프로젝트 폴더도 옮긴다");
    assert.equal(state_signature(c.env.db), signature, "DB 내용 불변(영수증·사건·행 하나도 안 늘고 안 바뀜)");
    assert.deepEqual(c.listing(c.env.objects), objects, "객체 폴더 불변");
    assert.equal(c.env.db.path, db_file);
    const config = JSON.parse(readFileSync(join(c.env.home.env.HOME as string, ".pes", "config.json"), "utf8"));
    assert.equal(realpathSync(config.home), realpathSync(target));
    const shown = c.run(["home"], { PES_HOME: undefined });
    assert.equal(shown.status, 0);
    assert.match(shown.stdout, /PES 홈:/);
  }));

test("remote: 허용 주소 목록은 설정 파일만 바꾸고 DB·project.json은 그대로", () =>
  with_cli(async (c) => {
    const signature = state_signature(c.env.db);
    const res = c.run(["remote", "add", "https://m5.example.ts.net"]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /답을 보낼 수 있는 다른 주소: https:\/\/m5\.example\.ts\.net/);
    const config = JSON.parse(readFileSync(join(c.env.home.env.HOME as string, ".pes", "config.json"), "utf8"));
    assert.deepEqual(config.trusted_origins, ["https://m5.example.ts.net"]);
    assert.equal(state_signature(c.env.db), signature);
    assert.deepEqual(c.sig(c.project_json), c.sig(c.project_json));
    expect_rejected(c.run(["remote", "add", "not-a-url"]), "잘못된 주소");
  }));

// ---------------------------------------------------------------------------
// 4 · 잠금 인계 = run lease

function lease(c: CliEnv) {
  return c.env.db.get<{ lease_id: string; state: string; fence: bigint; run_id: string | null }>(
    "SELECT lease_id, state, fence, run_id FROM project_leases WHERE project_id = ?",
    c.env.p.project_id,
  );
}

function session_of(c: CliEnv, run_id: string | null): string | null {
  if (run_id === null) return null;
  return c.env.db.get<{ external_session_ref: string | null }>("SELECT external_session_ref FROM runs WHERE id = ?", run_id)?.external_session_ref ?? null;
}

test("lock·unlock은 run lease로 옮겨진다: 같은 세션 갱신, 다른 세션 거부(종료 3), --force 인계, 해제", () =>
  with_cli(async (c) => {
    const A = "sess-aaaa1111";
    const B = "sess-bbbb2222";
    // 세션 ID 없이는 잠글 수 없다 (종료 2)
    const no_owner = c.run(["lock", SLUG]);
    assert.equal(no_owner.status, 2);
    assert.equal(lease(c), undefined);

    const first = run_write(c, ["lock", SLUG], { PES_OWNER: A });
    expect_cli_commit(c, "lock", first);
    assert.match(first.res.stdout, /잠금: synthetic-files \(세션 sess-aaa/);
    const l1 = lease(c)!;
    assert.equal(l1.state, "active");
    assert.equal(l1.fence, 1n);
    assert.equal(session_of(c, l1.run_id), A);
    assert.ok(!existsSync(join(c.folder, ".pes-lock")), "옛 .pes-lock 파일이 아니라 lease가 잠금의 원본");

    // 같은 세션이 다시 잠그면 세대(fence)가 그대로다
    assert.equal(c.run(["lock", SLUG], { PES_OWNER: A }).status, 0);
    assert.equal(lease(c)!.lease_id, l1.lease_id);
    assert.equal(lease(c)!.fence, 1n);

    // 다른 세션: lock·쓰기·unlock 모두 종료 3, 아무것도 안 바뀐다
    const n = c.commits().length;
    assert.equal(c.run(["lock", SLUG], { PES_OWNER: B }).status, 3);
    assert.equal(c.run(["note", SLUG, "남의 메모"], { PES_OWNER: B }).status, 3);
    assert.equal(c.run(["unlock", SLUG], { PES_OWNER: B }).status, 3);
    assert.equal(c.commits().length, n, "거부된 호출은 영수증을 남기지 않는다");
    assert.equal(lease(c)!.lease_id, l1.lease_id);

    // 같은 세션의 쓰기는 통과한다
    assert.equal(c.run(["note", SLUG, "내 메모"], { PES_OWNER: A }).status, 0);

    // --force 인계: 세대가 오르고 옛 세션은 더 쓸 수 없다
    const forced = run_write(c, ["lock", SLUG, "--force"], { PES_OWNER: B });
    expect_cli_commit(c, "lock", forced);
    const l2 = lease(c)!;
    assert.equal(l2.state, "active");
    assert.equal(l2.fence, 2n, "인계는 새 claim — fence +1");
    assert.notEqual(l2.lease_id, l1.lease_id);
    assert.equal(session_of(c, l2.run_id), B);
    const old = c.env.db.get<{ status: string }>("SELECT status FROM runs WHERE id = ?", l1.run_id);
    assert.notEqual(old?.status, "running", "인계된 옛 run은 더 돌지 않는다");
    assert.equal(c.run(["note", SLUG, "옛 세션"], { PES_OWNER: A }).status, 3);

    // 해제
    const released = run_write(c, ["unlock", SLUG], { PES_OWNER: B });
    assert.equal(released.res.status, 0);
    assert.match(released.res.stdout, /잠금 해제/);
    assert.ok(released.commits.some((m) => m.action.startsWith("run.")));
    assert.notEqual(lease(c)?.state, "active");
    assert.equal(c.run(["note", SLUG, "이제 누구나"], { PES_OWNER: A }).status, 0);
  }));

test("lock --force를 에이전트 토큰으로는 할 수 없다 (옛 CLI는 누구나 가능)", () =>
  with_cli(async (c) => {
    const agent = await c.agent("lock-bypass");
    assert.equal(c.run(["lock", SLUG], { PES_OWNER: "sess-owner001" }).status, 0);
    const before = lease(c)!;
    expect_rejected(c.run(["lock", SLUG, "--force"], { PES_OWNER: "sess-agent002", PES_TOKEN: agent.token }), "토큰의 --force");
    assert.equal(lease(c)!.lease_id, before.lease_id);
  }));

// ---------------------------------------------------------------------------
// 5 · 승인·권한 우회를 승계하지 않는다

test("봉인 없는 approve는 거부된다 (옛 CLI는 아무 때나 승인)", () =>
  with_cli(async (c) => {
    await start(c.env, c.stages.plan, "b-start");
    const n = c.commits().length;
    expect_rejected(run_write(c, ["approve", SLUG, "plan"]).res, "봉인 없는 approve");
    assert.equal(approvals_of(c.env.db, c.stages.plan).length, 0);
    assert.notEqual(stage_row(c.env.db, c.stages.plan).status, "approved");
    assert.equal(c.commits().length, n);
  }));

test("같은 단계 두 번째 approve는 거부된다 (승인 기록이 쌓이지 않음)", () =>
  with_cli(async (c) => {
    await drive_stage(c.env, c.stages.plan, "twice");
    const n = approvals_of(c.env.db, c.stages.plan).length;
    expect_rejected(run_write(c, ["approve", SLUG, "plan"]).res, "두 번째 approve");
    assert.equal(approvals_of(c.env.db, c.stages.plan).length, n);
  }));

test("열어 본 적 없는 단계의 reopen은 거부된다", () =>
  with_cli(async (c) => {
    const n = c.commits().length;
    expect_rejected(run_write(c, ["reopen", SLUG, "research"]).res, "미시작 단계 reopen");
    assert.equal(c.commits().length, n);
  }));

test("에이전트 토큰은 approve·reopen을 할 수 없다 (사람 전용)", () =>
  with_cli(async (c) => {
    const agent = await c.agent("no-approve");
    const round = await start(c.env, c.stages.plan, "t-start");
    const content = await make_content(c.env, "t-content");
    const versions = [{ object_id: content.object_id, version_id: content.version_id }];
    await seal(c.env, round.round_id, versions, "t-seal");
    const n = c.commits().length;
    expect_rejected(run_write(c, ["approve", SLUG, "plan"], { PES_TOKEN: agent.token }).res, "토큰 approve");
    assert.equal(approvals_of(c.env.db, c.stages.plan).length, 0);
    assert.equal(c.run(["approve", SLUG, "plan"]).status, 0, "같은 상태에서 사람 소유자는 승인된다");
    expect_rejected(run_write(c, ["reopen", SLUG, "plan"], { PES_TOKEN: agent.token }).res, "토큰 reopen");
    assert.equal(stage_row(c.env.db, c.stages.plan).status, "approved");
    assert.ok(c.commits().length > n);
    expect_rejected(c.run(["approve", SLUG, "plan"], { PES_TOKEN: "garbage-token" }), "엉터리 토큰");
  }));

// ---------------------------------------------------------------------------
// 6 · 새 5개: context·claim·submit·wait·complete — actor·권한 확정

test("context·claim·submit·wait·complete: 에이전트 토큰으로 한 라운드, 모두 cli 영수증과 에이전트 actor", () =>
  with_cli(async (c) => {
    const agent = await c.agent("worker");
    await start(c.env, c.stages.plan, "f-start");
    const art = await new_artifact(c.env, "f-artifact");
    const tok = { PES_TOKEN: agent.token };

    const ctx = run_write(c, ["context", SLUG], tok);
    assert.equal(ctx.res.status, 0, ctx.res.stderr);
    const context = JSON.parse(ctx.res.stdout.trim());
    assert.match(context.digest, /^[0-9a-f]{64}$/);
    assert.equal(context.lease, null);
    assert.equal(ctx.commits.length, 0, "context는 읽기 — 영수증 없음");
    expect_rejected(c.run(["context", SLUG], { PES_TOKEN: "garbage-token" }), "엉터리 토큰 context");

    const claim = run_write(c, ["claim", SLUG], tok);
    const claimed = json_out(claim.res);
    assert.match(claimed.fence, /^[1-9][0-9]*$/);
    const claim_commit = claim.commits.find((m) => m.action === "run.claimed");
    assert.ok(claim_commit, `[${claim.commits.map((m) => m.action)}]`);
    assert.equal(claim_commit.via, "cli");
    assert.equal(claim_commit.actor_id, agent.actor_id, "토큰 보유자는 소유자가 아니라 에이전트 actor");
    assert.notEqual(claim_commit.actor_id, c.env.p.actor_id);
    const guard = ["--run", claimed.run_id, "--lease", claimed.lease_id, "--fence", String(claimed.fence)];

    const results = join(c.env.home.root, "results.json");
    writeFileSync(results, JSON.stringify([{ op: "append_version", object_id: art.object_id, title: "CLI 결과" }]), "utf8");
    const submit = run_write(c, ["submit", SLUG, ...guard, "--file", results], tok);
    json_out(submit.res);
    const sc = submit.commits.find((m) => m.action === "result.submitted");
    assert.ok(sc, `[${submit.commits.map((m) => m.action)}]`);
    assert.equal(sc.actor_id, agent.actor_id);
    assert.equal(sc.run_id, claimed.run_id);
    assert.equal(sc.lease_id, claimed.lease_id);
    assert.equal(String(sc.fence), String(claimed.fence));

    const waited = json_out(run_write(c, ["wait", SLUG, ...guard], tok).res);
    assert.equal(waited.status, "waiting_human");
    assert.notEqual(lease(c)?.state, "active", "wait은 lease를 놓는다");

    const claim2 = json_out(run_write(c, ["claim", SLUG, "--run", claimed.run_id], tok).res);
    assert.equal(String(claim2.fence), String(BigInt(claimed.fence) + 1n), "재개는 새 claim — fence +1");
    const n = c.commits().length;
    expect_rejected(run_write(c, ["submit", SLUG, ...guard, "--file", results], tok).res, "옛 fence submit");
    assert.equal(c.commits().length, n, "옛 lease의 쓰기는 영수증이 없다");

    const guard2 = ["--run", claim2.run_id, "--lease", claim2.lease_id, "--fence", String(claim2.fence)];
    const done = run_write(c, ["complete", SLUG, ...guard2, "--status", "succeeded"], tok);
    assert.equal(json_out(done.res).status, "succeeded");
    assert.ok(done.commits.some((m) => m.action === "run.completed" && m.actor_id === agent.actor_id));
    assert.notEqual(stage_row(c.env.db, c.stages.plan).status, "approved", "complete는 승인이 아니다");
    assert.equal(approvals_of(c.env.db, c.stages.plan).length, 0);
  }));

test("범위가 모자란 토큰은 claim을 못 하고 run이 생기지 않는다", () =>
  with_cli(async (c) => {
    const reader = await c.agent("reader", ["context:read"]);
    await start(c.env, c.stages.plan, "s-start");
    const runs = table_counts(c.env.db).runs;
    const res = run_write(c, ["claim", SLUG], { PES_TOKEN: reader.token });
    expect_rejected(res.res, "범위 없는 claim");
    assert.equal(res.commits.length, 0);
    assert.equal(table_counts(c.env.db).runs, runs);
    assert.equal(json_out(c.run(["context", SLUG], { PES_TOKEN: reader.token })).lease, null, "읽기 범위는 context를 본다");
  }));

test("사람 CLI와 토큰 CLI의 actor는 서로 바뀌지 않는다: PES_OWNER 세션 ID는 자격이 아니다", () =>
  with_cli(async (c) => {
    const agent = await c.agent("who");
    await start(c.env, c.stages.plan, "w-start");
    // r1 필수 3: claim 한 적 없는 토큰 에이전트는 lease 가 없으므로 쓸 수 없다 — forbidden, 영수증 0 (어느 쪽이든 통과가 아니다).
    const bare = run_write(c, ["note", SLUG, "토큰 메모"], { PES_TOKEN: agent.token });
    expect_rejected(bare.res, "claim 안 한 토큰의 note");
    assert.equal(bare.commits.length, 0, "거부된 쓰기는 영수증이 없다");
    // PES_OWNER 를 붙여도 자격이 되지 않는다: 소유자 이름으로 쓰지 않고, 에이전트가 메모를 남기지도 못한다.
    const sess = run_write(c, ["note", SLUG, "토큰 메모 둘"], { PES_TOKEN: agent.token, PES_OWNER: "sess-who00001" });
    assert.ok(!sess.commits.some((m) => m.actor_id === c.env.p.actor_id), "소유자 이름으로 쓰지 않는다");
    assert.ok(!sess.commits.some((m) => m.action === "project.note_added"), "lease 없는 토큰 에이전트의 메모는 기록되지 않는다");
    // claim 한 뒤에는 자기 lease 로 쓸 수 있고, 그 영수증의 actor 는 에이전트다.
    json_out(run_write(c, ["claim", SLUG], { PES_TOKEN: agent.token }).res);
    const owned = run_write(c, ["note", SLUG, "토큰 메모 셋"], { PES_TOKEN: agent.token });
    assert.equal(owned.res.status, 0, owned.res.stderr);
    const receipt = owned.commits.find((m) => m.action === "project.note_added");
    assert.ok(receipt, "자기 lease 가 있으면 허용");
    assert.equal(receipt.actor_id, agent.actor_id);
  }));

// ---------------------------------------------------------------------------
// 플래그: PES_DB_CORE 없이는 v0.15 동작 그대로 (project.json을 쓰고 DB를 건드리지 않는다)

const OFF = { PES_DB_CORE: undefined } as const;

test("플래그 없음: init은 예전처럼 project.json을 만들고 DB는 그대로", () =>
  with_cli(async (c) => {
    const signature = state_signature(c.env.db);
    const res = c.run(["init", "synthetic-off", "--topic", "합성 옛 방식"], OFF);
    assert.equal(res.status, 0, res.stderr + res.stdout);
    const json = join(c.env.home.env.PES_HOME as string, "synthetic-off", "project.json");
    assert.ok(existsSync(json), "project.json 을 직접 쓴다");
    assert.equal(JSON.parse(readFileSync(json, "utf8")).topic, "합성 옛 방식");
    assert.equal(state_signature(c.env.db), signature, "DB 불변 — 영수증·프로젝트 행 없음");
    assert.equal(c.env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM projects WHERE slug = 'synthetic-off'")?.n, 0n);
  }));

test("플래그 없음: round-start·approve·reopen·note·lock이 project.json을 바꾸고 DB는 그대로", () =>
  with_cli(async (c) => {
    const signature = state_signature(c.env.db);
    const read = () => JSON.parse(readFileSync(c.project_json, "utf8"));
    for (const [args, extra] of [
      [["round-start", SLUG, "plan"], {}],
      [["approve", SLUG, "plan"], {}],
      [["reopen", SLUG, "plan"], {}],
      [["note", SLUG, "합성 옛 메모"], {}],
      [["lock", SLUG], { PES_OWNER: "sess-off00001" }],
    ] as const) {
      const before = c.sig(c.project_json).sha;
      const res = c.run([...args], { ...OFF, ...extra });
      assert.equal(res.status, 0, `${args[0]}: ${res.stderr}${res.stdout}`);
      if (args[0] !== "lock") assert.notEqual(c.sig(c.project_json).sha, before, `${args[0]}: project.json 갱신`);
    }
    assert.equal(read().notes.length, 1);
    assert.ok(existsSync(join(c.folder, ".pes-lock")), "옛 잠금 파일");
    assert.equal(state_signature(c.env.db), signature, "DB 불변");
  }));

test("플래그 없음: 토큰·새 5개 명령은 쓸 수 없고 아무것도 만들지 않는다", () =>
  with_cli(async (c) => {
    const signature = state_signature(c.env.db);
    for (const name of ["claim", "submit", "wait", "complete"]) {
      expect_rejected(c.run([name, SLUG], OFF), `${name} (플래그 없음)`);
    }
    assert.equal(state_signature(c.env.db), signature);
  }));
