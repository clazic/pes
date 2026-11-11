/**
 * SEL-48 PR15 — CLI 쓰기 전환 보강 시험 (tester, 보강 모드). 구현(scripts/pes_core/cli_*.ts, cli_bridge.ts)을
 * 읽고 빈틈을 채운다. (SEL-74: pes.ts 로 돈다. 0.15 와의 나란히 비교 A·플래그·node 브리지 고장 C1~C3 은 지웠다 — tests/README.md 처리표.) 모든 자료는 합성이고 HOME·USERPROFILE·PES_HOME은 임시 폴더다.
 *
 * 묶음:
 *   (A. 플래그 없음 v0.15 비교 — 삭제: 0.15 동작은 baseline E01~E15·X01~X11 이 고정한다)
 *   B. 모든 쓰기 명령에서 project.json·.pes-lock·library.json 쓰기 0
 *   (C1~C3. node 브리지 고장 — 삭제: pes.ts 는 코어를 같은 프로세스에서 돌린다. C4 는 남는다)
 *   D. 인증: 만료·회수·다른 프로젝트·범위 부족·공백 토큰
 *   E. lock/unlock ↔ lease
 *   F. 새 5개 명령의 guard 위반·재생
 *   G. pes home 격리
 *   H. 문서에 적힌 한계가 v0.15 의미와 충돌하는 곳 (실패하면 "결함 후보")
 *
 * 결함 후보는 시험 이름에 `[결함 후보]`를 붙였다. 구현을 고치지 않고 실패한 채로 남긴다.
 */

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { revoke_agent_token } from "../scripts/pes_core/actors.ts";
import { new_artifact } from "./helpers/blob_env.ts";
import { expect_rejected, json_out, make_cli_env, REPO, SLUG, with_cli, type CliEnv, type CliResult } from "./helpers/cli_write_env.ts";
import { make_content, seal, start } from "./helpers/editions_env.ts";
import { state_signature, table_counts } from "./helpers/state_signature.ts";

// ---------------------------------------------------------------------------
// 공통 도구

interface Snap {
  db: string;
  json: ReturnType<CliEnv["sig"]>;
  files: string[];
}

function snap(c: CliEnv): Snap {
  return { db: state_signature(c.env.db), json: c.sig(c.project_json), files: c.listing(c.folder) };
}

function assert_untouched(c: CliEnv, before: Snap, what: string): void {
  assert.equal(state_signature(c.env.db), before.db, `${what}: DB 불변`);
  assert.deepEqual(c.sig(c.project_json), before.json, `${what}: project.json 불변`);
  assert.deepEqual(c.listing(c.folder), before.files, `${what}: 폴더에 새 파일 없음`);
}

function no_crash(res: CliResult, what: string): void {
  assert.doesNotMatch(res.stderr + res.stdout, /Traceback|SyntaxError|ModuleNotFoundError/, `${what}: 스택 추적이 아니라 분명한 오류여야 한다\n${res.stderr}`);
}

/** pes.ts 실행기 (하니스의 run()): PES_OWNER·PES_TOKEN 은 extra 로만 준다. */
function run_with(c: CliEnv, args: string[], extra: Record<string, string | undefined> = {}): CliResult {
  return c.run(args, extra);
}

function write_json(c: CliEnv, name: string, value: unknown): string {
  const file = join(c.env.home.root, name);
  writeFileSync(file, JSON.stringify(value), "utf8");
  return file;
}

function lease(c: CliEnv) {
  return c.env.db.get<{ lease_id: string; state: string; fence: bigint; run_id: string | null; owner_actor_id: string | null; heartbeat_at: bigint; expires_at: bigint }>(
    "SELECT lease_id, state, fence, run_id, owner_actor_id, heartbeat_at, expires_at FROM project_leases WHERE project_id = ?",
    c.env.p.project_id,
  );
}

function token_id_of(c: CliEnv, actor_id: string): string {
  const row = c.env.db.get<{ id: string }>("SELECT id FROM agent_tokens WHERE actor_id = ?", actor_id);
  assert.ok(row, "token row");
  return row.id;
}

interface Guard {
  run_id: string;
  lease_id: string;
  fence: string;
  flags: string[];
}

function claim_as(c: CliEnv, token: string): Guard {
  const out = json_out(c.run(["claim", SLUG], { PES_TOKEN: token }));
  return {
    run_id: out.run_id,
    lease_id: out.lease_id,
    fence: String(out.fence),
    flags: ["--run", out.run_id, "--lease", out.lease_id, "--fence", String(out.fence)],
  };
}

async function open_plan_round(c: CliEnv, tag: string) {
  return start(c.env, c.stages.plan, tag);
}

// ---------------------------------------------------------------------------
// B. 플래그 켜짐: project.json·.pes-lock·library.json 쓰기 0

test("B1 모든 쓰기 명령 한 바퀴: project.json·.pes-lock·library.json·project.json.tmp 를 만들거나 바꾸지 않는다", () =>
  with_cli(async (c) => {
    const sess = { PES_OWNER: "sess-b1111111" };
    const merge_file = write_json(c, "b1-merge.json", [{ id: 1, title: "합성 항목", summary: "요약", sources: [{ url: "https://a.example/1", title: "A" }] }]);
    const qa_file = write_json(c, "b1-qa.json", { verdict: "pass", qc: [], qa: [], spot_checks: [], missed_by_self_review: [] });
    const spec = join(c.env.home.root, "b1-ask.json");
    writeFileSync(spec, readFileSync(join(REPO, "questions", "plan.json")), "utf8");
    const steps: string[][] = [
      ["lock", SLUG],
      ["round-start", SLUG, "plan"],
      ["ask-prep", SLUG, "plan"],
      ["ask", SLUG, spec],
      ["merge", SLUG, "plan", merge_file],
      ["note", SLUG, "합성 메모"],
      ["chat", SLUG, "plan", "합성 채팅"],
      ["mark", SLUG, "feedback/a.json"],
      ["qa-brief", SLUG, "plan"],
      ["qa", SLUG, "plan", "--file", qa_file],
      ["render", SLUG, "plan"],
      ["approve", SLUG, "plan"],
      ["reopen", SLUG, "plan"],
      ["unlock", SLUG],
    ];
    const before = c.sig(c.project_json);
    for (const args of steps) {
      const res = c.run(args, sess);
      // qa-brief·qa 의 성공 여부는 B3 에서 따로 본다 (여기서는 파일 불변만)
      if (args[0] !== "qa-brief" && args[0] !== "qa") assert.equal(res.status, 0, `${args[0]}: ${res.stderr}${res.stdout}`);
      assert.deepEqual(c.sig(c.project_json), before, `${args[0]}: project.json 불변`);
      const files = c.listing(c.folder);
      for (const bad of [".pes-lock", "project.json.tmp", "library.json"]) {
        assert.ok(!files.includes(bad), `${args[0]}: ${bad} 가 생기면 안 된다 (${files})`);
      }
    }
  }));

test("B3 [결함 후보] 병합한 항목이 있는 라운드에서 qa-brief·qa 가 동작한다 (지금은 BigInt 직렬화 오류로 죽는다)", () =>
  with_cli(async (c) => {
    await open_plan_round(c, "b3");
    const merge_file = write_json(c, "b3-merge.json", [{ id: 1, title: "합성 항목", summary: "요약", sources: [{ url: "https://a.example/1", title: "A" }] }]);
    assert.equal(c.run(["merge", SLUG, "plan", merge_file]).status, 0);
    const brief = c.run(["qa-brief", SLUG, "plan"]);
    assert.equal(brief.status, 0, `항목이 있는 라운드의 qa-brief: ${brief.stderr}${brief.stdout}`);
    no_crash(brief, "qa-brief");
    const qa_file = write_json(c, "b3-qa.json", { verdict: "pass", qc: [], qa: [], spot_checks: [], missed_by_self_review: [] });
    const qa = c.run(["qa", SLUG, "plan", "--file", qa_file]);
    assert.equal(qa.status, 0, `항목이 있는 라운드의 qa: ${qa.stderr}${qa.stdout}`);
  }));

test("B2 거부된 쓰기(종료 코드 비0)는 어떤 파일도·DB도 바꾸지 않는다: 잠긴 프로젝트에 다른 세션", () =>
  with_cli(async (c) => {
    assert.equal(c.run(["lock", SLUG], { PES_OWNER: "sess-owner001" }).status, 0);
    // 라운드가 열려 있어야 render 가 봉인(쓰기)을 한다 — 열린 라운드가 없으면 0.15 처럼 render 는 아무것도 하지 않는다(종료 0)
    assert.equal(c.run(["round-start", SLUG, "plan"], { PES_OWNER: "sess-owner001" }).status, 0);
    const before = snap(c);
    const merge_file = write_json(c, "b2-merge.json", [{ id: 1, title: "x" }]);
    for (const args of [
      ["round-start", SLUG, "plan"],
      ["render", SLUG, "plan"],
      ["approve", SLUG, "plan"],
      ["reopen", SLUG, "plan"],
      ["note", SLUG, "x"],
      ["chat", SLUG, "plan", "x"],
      ["mark", SLUG, "a.json"],
      ["ask-prep", SLUG, "plan"],
      ["qa-brief", SLUG, "plan"],
      ["merge", SLUG, "plan", merge_file],
      ["unlock", SLUG],
      ["lock", SLUG],
    ]) {
      const res = c.run(args, { PES_OWNER: "sess-other002" });
      assert.equal(res.status, 3, `${args[0]}: 다른 세션은 종료 3 (실제 ${res.status}: ${res.stderr})`);
      assert_untouched(c, before, args[0]!);
    }
  }));

// ---------------------------------------------------------------------------
// C. (C1~C3 node 브리지 고장 시험은 지웠다 — pes.ts 에 별도 브리지 프로세스가 없다)

test("C4 [결함 후보] init --import 가 DB 에서 거부돼도 참고자료 폴더(library/shots)를 이미 복사해 둔다 — 부분 쓰기", () =>
  with_cli(async (c) => {
    // DB 에는 있고 폴더만 project.json 이 없는 프로젝트
    assert.equal(c.run(["init", "synthetic-dup", "--topic", "첫"]).status, 0);
    const folder = join(c.env.home.env.PES_HOME as string, "synthetic-dup");
    const before_listing = c.listing(folder);
    const lib = join(c.env.home.root, "lib-src");
    mkdirSync(join(lib, "shots"), { recursive: true });
    writeFileSync(join(lib, "shots", "a.png"), "x", "utf8");
    writeFileSync(join(lib, "state.json"), JSON.stringify({ round: 1, topic: "합성", items: [{ id: 1, title: "t", shots: ["a.png"] }] }), "utf8");
    const signature = state_signature(c.env.db);
    const res = c.run(["init", "synthetic-dup", "--topic", "둘째", "--import", lib]);
    expect_rejected(res, "중복 init --import");
    assert.equal(state_signature(c.env.db), signature, "DB 불변");
    assert.deepEqual(c.listing(folder), before_listing, "거부된 init 이 폴더에 library/ 를 남기면 안 된다");
  }));

// ---------------------------------------------------------------------------
// D. 인증

test("D1 만료된 토큰: 모든 쓰기와 새 명령이 거부되고 아무것도 안 바뀐다", () =>
  with_cli(async (c) => {
    const agent = await c.agent("expired");
    c.env.db.run("UPDATE agent_tokens SET created_at = 1, expires_at = 2 WHERE actor_id = ?", agent.actor_id);
    const before = snap(c);
    for (const args of [["note", SLUG, "x"], ["round-start", SLUG, "plan"], ["chat", SLUG, "plan", "x"], ["claim", SLUG], ["context", SLUG], ["lock", SLUG]]) {
      const res = c.run(args, { PES_TOKEN: agent.token, PES_OWNER: "sess-d1111111" });
      expect_rejected(res, `만료 토큰 ${args[0]}`);
      no_crash(res, args[0]!);
    }
    assert_untouched(c, before, "만료 토큰");
  }));

test("D2 회수된 토큰: 회수 직후부터 거부, 다른 토큰은 영향 없음", () =>
  with_cli(async (c) => {
    const a = await c.agent("revoked");
    const b = await c.agent("kept");
    // 에이전트 쓰기는 자기 lease 가 있어야 한다(r1 결정 ③) — 먼저 claim.
    assert.equal(c.run(["claim", SLUG], { PES_TOKEN: a.token }).status, 0, "회수 전에는 claim 된다");
    assert.equal(c.run(["note", SLUG, "회수 전"], { PES_TOKEN: a.token }).status, 0, "회수 전에는 쓴다");
    await revoke_agent_token(c.env.service, c.env.ctx("revoke-a"), { token_id: token_id_of(c, a.actor_id) });
    const before = snap(c);
    for (const args of [["note", SLUG, "x"], ["claim", SLUG], ["context", SLUG], ["chat", SLUG, "plan", "x"]]) {
      expect_rejected(c.run(args, { PES_TOKEN: a.token }), `회수 토큰 ${args[0]}`);
    }
    assert_untouched(c, before, "회수 토큰");
    // 다른 토큰은 영향이 없다: 프로젝트의 lease 는 하나(a 가 쥠)라 b 는 읽기로 확인한다.
    assert.equal(c.run(["context", SLUG], { PES_TOKEN: b.token }).status, 0, "다른 토큰은 계속 쓸 수 있다(인증 통과)");
  }));

test("D3 다른 프로젝트 토큰: 두 번째 프로젝트의 쓰기·읽기·claim 모두 거부", () =>
  with_cli(async (c) => {
    const agent = await c.agent("other-project");
    assert.equal(c.run(["init", "synthetic-other", "--topic", "다른 프로젝트"]).status, 0);
    const before = state_signature(c.env.db);
    for (const args of [["note", "synthetic-other", "x"], ["round-start", "synthetic-other", "plan"], ["claim", "synthetic-other"], ["context", "synthetic-other"], ["chat", "synthetic-other", "plan", "x"]]) {
      const res = c.run(args, { PES_TOKEN: agent.token });
      expect_rejected(res, `다른 프로젝트 ${args[0]}`);
      no_crash(res, args[0]!);
    }
    assert.equal(state_signature(c.env.db), before);
    // 같은 토큰은 자기 프로젝트에서는 된다(쓰기는 자기 lease 가 있어야 한다 — r1 결정 ③)
    assert.equal(c.run(["claim", SLUG], { PES_TOKEN: agent.token }).status, 0);
    assert.equal(c.run(["note", SLUG, "자기 프로젝트"], { PES_TOKEN: agent.token }).status, 0);
  }));

test("D4 범위 부족: 쓰기 명령 전부 run:submit 이 필요하다 (context:read·run:claim 만으로는 못 쓴다)", () =>
  with_cli(async (c) => {
    const reader = await c.agent("reader-only", ["context:read"]);
    const claimer = await c.agent("claimer-only", ["run:claim"]);
    await open_plan_round(c, "d4");
    const merge_file = write_json(c, "d4-merge.json", [{ id: 1, title: "x" }]);
    const before = snap(c);
    for (const who of [reader, claimer]) {
      for (const args of [
        ["note", SLUG, "x"],
        ["chat", SLUG, "plan", "x"],
        ["mark", SLUG, "a.json"],
        ["ask-prep", SLUG, "plan"],
        ["qa-brief", SLUG, "plan"],
        ["merge", SLUG, "plan", merge_file],
        ["render", SLUG, "plan"],
        ["round-start", SLUG, "research"],
        ["unlock", SLUG],
      ]) {
        const res = c.run(args, { PES_TOKEN: who.token });
        expect_rejected(res, `${who.actor_id} ${args[0]}`);
      }
    }
    assert_untouched(c, before, "범위 부족");
    // run:claim 만 있으면 claim 은 되고, context:read 가 없으니 context 는 안 된다
    expect_rejected(c.run(["context", SLUG], { PES_TOKEN: claimer.token }), "context:read 없는 context");
  }));

test("D5 공백·이상한 토큰 값은 사람으로 격상되지 않는다 (빈 문자열만 '토큰 없음')", () =>
  with_cli(async (c) => {
    await open_plan_round(c, "d5");
    const before = snap(c);
    for (const bad of [" ", "\n", "x", "Bearer abc", "0".repeat(200)]) {
      const res = c.run(["approve", SLUG, "plan"], { PES_TOKEN: bad });
      expect_rejected(res, `토큰 ${JSON.stringify(bad)}`);
      const res2 = c.run(["note", SLUG, "x"], { PES_TOKEN: bad });
      expect_rejected(res2, `토큰 ${JSON.stringify(bad)} note`);
    }
    assert_untouched(c, before, "이상한 토큰");
  }));

test("D6 토큰 보유자는 reopen·approve·lock --force·unlock --force 모두 못 한다, 영수증·lease 불변", () =>
  with_cli(async (c) => {
    const agent = await c.agent("human-only");
    const round = await start(c.env, c.stages.plan, "d6-start");
    const content = await make_content(c.env, "d6-content");
    await seal(c.env, round.round_id, [{ object_id: content.object_id, version_id: content.version_id }], "d6-seal");
    assert.equal(c.run(["lock", SLUG], { PES_OWNER: "sess-human001" }).status, 0);
    const held = lease(c)!;
    const before = state_signature(c.env.db);
    for (const args of [["approve", SLUG, "plan"], ["reopen", SLUG, "plan"], ["lock", SLUG, "--force"], ["unlock", SLUG, "--force"]]) {
      expect_rejected(c.run(args, { PES_TOKEN: agent.token, PES_OWNER: "sess-agent001" }), `토큰의 ${args.join(" ")}`);
    }
    assert.equal(state_signature(c.env.db), before, "아무것도 안 바뀐다");
    assert.equal(lease(c)!.lease_id, held.lease_id);
  }));

// ---------------------------------------------------------------------------
// E. lock/unlock ↔ lease

test("E1 만료된 lease 는 --force 없이도 다른 세션이 가져간다 (fence +1), 옛 세션은 이후 거부", () =>
  with_cli(async (c) => {
    assert.equal(c.run(["lock", SLUG], { PES_OWNER: "sess-old00001" }).status, 0);
    const l1 = lease(c)!;
    const t = BigInt(Date.now());
    c.env.db.run("UPDATE project_leases SET acquired_at = ?, heartbeat_at = ?, expires_at = ? WHERE project_id = ?", t - 10_800_000n, t - 10_800_000n, t - 3_600_000n, c.env.p.project_id);
    const res = c.run(["lock", SLUG], { PES_OWNER: "sess-new00002" });
    assert.equal(res.status, 0, `만료된 잠금은 그냥 가져간다: ${res.stderr}`);
    const l2 = lease(c)!;
    assert.notEqual(l2.lease_id, l1.lease_id);
    assert.ok(l2.fence > l1.fence, `fence 는 오른다 (${l1.fence} → ${l2.fence})`);
    assert.equal(c.run(["note", SLUG, "옛 세션"], { PES_OWNER: "sess-old00001" }).status, 3);
    assert.equal(c.run(["note", SLUG, "새 세션"], { PES_OWNER: "sess-new00002" }).status, 0);
  }));

test("E2 같은 세션 쓰기는 마지막 기록이 30분보다 오래되면 lease 를 늘린다 (같은 lease·fence)", () =>
  with_cli(async (c) => {
    const S = { PES_OWNER: "sess-hb000001" };
    assert.equal(c.run(["lock", SLUG], S).status, 0);
    const l1 = lease(c)!;
    const t = BigInt(Date.now());
    c.env.db.run("UPDATE project_leases SET acquired_at = ?, heartbeat_at = ?, expires_at = ? WHERE project_id = ?", t - 2_400_000n, t - 2_400_000n, t + 3_600_000n, c.env.p.project_id);
    const n = c.commits().length;
    assert.equal(c.run(["note", SLUG, "하트비트"], S).status, 0);
    const l2 = lease(c)!;
    assert.equal(l2.lease_id, l1.lease_id);
    assert.equal(l2.fence, l1.fence);
    assert.ok(l2.heartbeat_at > t - 60_000n, "마지막 기록이 갱신됐다");
    assert.ok(c.commits_since(n).some((m) => m.action.startsWith("run.")), "heartbeat 영수증");
  }));

test("E3 unlock 뒤 옛 guard(run·lease·fence)로는 쓸 수 없다, 새 claim 은 fence 가 더 크다", () =>
  with_cli(async (c) => {
    const agent = await c.agent("after-unlock");
    assert.equal(c.run(["lock", SLUG], { PES_OWNER: "sess-un000001" }).status, 0);
    const old = lease(c)!;
    assert.equal(c.run(["unlock", SLUG], { PES_OWNER: "sess-un000001" }).status, 0);
    const art = await new_artifact(c.env, "e3-art");
    const results = write_json(c, "e3.json", [{ op: "append_version", object_id: art.object_id, title: "옛 guard" }]);
    const before = state_signature(c.env.db);
    const guard = ["--run", old.run_id!, "--lease", old.lease_id, "--fence", String(old.fence)];
    expect_rejected(c.run(["submit", SLUG, ...guard, "--file", results], { PES_TOKEN: agent.token }), "unlock 뒤 옛 guard submit");
    expect_rejected(c.run(["complete", SLUG, ...guard], { PES_TOKEN: agent.token }), "unlock 뒤 옛 guard complete");
    assert.equal(state_signature(c.env.db), before);
    const fresh = claim_as(c, agent.token);
    assert.ok(BigInt(fresh.fence) > old.fence, "새 claim 의 fence 는 더 크다");
  }));

test("E4 에이전트가 lease 를 쥐고 있으면 사람 CLI 쓰기는 종료 3, 에이전트 자신의 쓰기는 통과", () =>
  with_cli(async (c) => {
    const agent = await c.agent("holder");
    const g = claim_as(c, agent.token);
    const before = state_signature(c.env.db);
    for (const args of [["note", SLUG, "사람 메모"], ["round-start", SLUG, "plan"], ["unlock", SLUG]]) {
      const res = c.run(args, {});
      assert.equal(res.status, 3, `${args[0]}: 에이전트 lease 중 사람 쓰기는 종료 3 (실제 ${res.status}: ${res.stderr})`);
    }
    assert.equal(state_signature(c.env.db), before);
    assert.equal(c.run(["note", SLUG, "에이전트 메모"], { PES_TOKEN: agent.token }).status, 0);
    assert.equal(g.run_id, lease(c)!.run_id);
  }));

test("E5 다른 세션이 잠근 프로젝트에서 에이전트 claim·context 쓰기는 거부(claim), 읽기(context)는 된다", () =>
  with_cli(async (c) => {
    const agent = await c.agent("blocked-claim");
    assert.equal(c.run(["lock", SLUG], { PES_OWNER: "sess-lk000001" }).status, 0);
    const l = lease(c)!;
    const before = state_signature(c.env.db);
    expect_rejected(c.run(["claim", SLUG], { PES_TOKEN: agent.token }), "잠금 중 claim");
    assert.equal(state_signature(c.env.db), before);
    assert.equal(lease(c)!.lease_id, l.lease_id);
    const ctx = json_out(c.run(["context", SLUG], { PES_TOKEN: agent.token }));
    assert.ok(ctx.lease !== undefined);
  }));

test("E6 lock 인자 오류: 세션 ID 없음(종료 2)·run:claim 없는 토큰 모두 lease 를 만들지 않는다", () =>
  with_cli(async (c) => {
    const submit_only = await c.agent("no-claim", ["run:submit", "context:read"]);
    const full = await c.agent("full-lock");
    const before = state_signature(c.env.db);
    assert.equal(c.run(["lock", SLUG], { PES_TOKEN: full.token }).status, 2, "세션 ID 없는 lock 은 종료 2");
    expect_rejected(c.run(["lock", SLUG], { PES_TOKEN: submit_only.token, PES_OWNER: "sess-nc000001" }), "run:claim 없는 lock");
    assert.equal(state_signature(c.env.db), before);
    assert.equal(lease(c), undefined);
  }));

test("E7 잠금 없을 때 unlock 은 성공하지만 영수증을 남기지 않는다", () =>
  with_cli(async (c) => {
    const n = c.commits().length;
    const res = c.run(["unlock", SLUG], { PES_OWNER: "sess-nolock01" });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(c.commits().length, n);
  }));

test("E8 [결함 후보] 사람 소유자의 lock --force 는 에이전트가 쥔 lease 도 가져올 수 있어야 한다 (옛 CLI: 누구의 잠금이든 --force 로 가져옴, 문서: '사람 소유자만')", () =>
  with_cli(async (c) => {
    const agent = await c.agent("stuck-agent");
    const g = claim_as(c, agent.token);
    const res = c.run(["lock", SLUG, "--force"], { PES_OWNER: "sess-human-take" });
    assert.equal(res.status, 0, `사람 소유자는 멈춘 에이전트의 lease 를 --force 로 가져올 수 있어야 한다 (지금은: ${res.stderr.trim()})`);
    assert.ok(lease(c)!.fence > BigInt(g.fence));
  }));

// ---------------------------------------------------------------------------
// F. 새 5개: guard 위반·재생

test("F1 guard 가 틀리면 submit·wait·complete 모두 거부: 다른 run·lease, fence 어긋남·0·음수·소수·문자", () =>
  with_cli(async (c) => {
    const agent = await c.agent("guard");
    const art = await new_artifact(c.env, "f1-art");
    const g = claim_as(c, agent.token);
    const results = write_json(c, "f1.json", [{ op: "append_version", object_id: art.object_id, title: "x" }]);
    const bad_guards: Array<[string, string[]]> = [
      ["run 다름", ["--run", "no-such-run", "--lease", g.lease_id, "--fence", g.fence]],
      ["lease 다름", ["--run", g.run_id, "--lease", "no-such-lease", "--fence", g.fence]],
      ["fence +1", ["--run", g.run_id, "--lease", g.lease_id, "--fence", String(BigInt(g.fence) + 1n)]],
      ["fence 0", ["--run", g.run_id, "--lease", g.lease_id, "--fence", "0"]],
      ["fence 음수", ["--run", g.run_id, "--lease", g.lease_id, "--fence", "-1"]],
      ["fence 소수", ["--run", g.run_id, "--lease", g.lease_id, "--fence", "1.5"]],
      ["fence 문자", ["--run", g.run_id, "--lease", g.lease_id, "--fence", "abc"]],
      ["fence 거대", ["--run", g.run_id, "--lease", g.lease_id, "--fence", "99999999999999999999"]],
      ["--run 없음", ["--lease", g.lease_id, "--fence", g.fence]],
      ["--lease 없음", ["--run", g.run_id, "--fence", g.fence]],
      ["--fence 없음", ["--run", g.run_id, "--lease", g.lease_id]],
    ];
    const before = state_signature(c.env.db);
    for (const [name, guard] of bad_guards) {
      for (const cmd of [["submit", "--file", results], ["wait"], ["complete"]]) {
        const res = c.run([cmd[0]!, SLUG, ...guard, ...cmd.slice(1)], { PES_TOKEN: agent.token });
        expect_rejected(res, `${cmd[0]} / guard ${name}`);
        no_crash(res, `${cmd[0]} / guard ${name}`);
      }
    }
    assert.equal(state_signature(c.env.db), before, "guard 위반은 영수증도 사건도 남기지 않는다");
    // 올바른 guard 는 된다 (시험 자체가 약하지 않음을 확인)
    assert.equal(c.run(["complete", SLUG, ...g.flags], { PES_TOKEN: agent.token }).status, 0);
  }));

test("F2 다른 에이전트의 토큰으로는 남의 guard 를 쓸 수 없다", () =>
  with_cli(async (c) => {
    const owner = await c.agent("lease-owner");
    const thief = await c.agent("lease-thief");
    const g = claim_as(c, owner.token);
    const art = await new_artifact(c.env, "f2-art");
    const results = write_json(c, "f2.json", [{ op: "append_version", object_id: art.object_id, title: "x" }]);
    const before = state_signature(c.env.db);
    expect_rejected(c.run(["submit", SLUG, ...g.flags, "--file", results], { PES_TOKEN: thief.token }), "남의 guard submit");
    expect_rejected(c.run(["wait", SLUG, ...g.flags], { PES_TOKEN: thief.token }), "남의 guard wait");
    expect_rejected(c.run(["complete", SLUG, ...g.flags], { PES_TOKEN: thief.token }), "남의 guard complete");
    // 사람 CLI 도 토큰 없이 에이전트의 guard 로 submit 하면 소유 actor 가 다르다
    expect_rejected(c.run(["complete", SLUG, ...g.flags], {}), "사람의 에이전트 guard complete");
    assert.equal(state_signature(c.env.db), before);
  }));

test("F3 재생: 같은 guard 로 complete·wait·submit 을 다시 보내면 거부되고 영수증이 늘지 않는다", () =>
  with_cli(async (c) => {
    const agent = await c.agent("replay");
    const art = await new_artifact(c.env, "f3-art");
    const results = write_json(c, "f3.json", [{ op: "append_version", object_id: art.object_id, title: "첫" }]);
    const g = claim_as(c, agent.token);
    json_out(c.run(["submit", SLUG, ...g.flags, "--file", results], { PES_TOKEN: agent.token }));
    assert.equal(c.run(["wait", SLUG, ...g.flags], { PES_TOKEN: agent.token }).status, 0);
    const after_wait = state_signature(c.env.db);
    expect_rejected(c.run(["wait", SLUG, ...g.flags], { PES_TOKEN: agent.token }), "wait 재생");
    expect_rejected(c.run(["complete", SLUG, ...g.flags], { PES_TOKEN: agent.token }), "wait 뒤 옛 guard complete");
    expect_rejected(c.run(["submit", SLUG, ...g.flags, "--file", results], { PES_TOKEN: agent.token }), "wait 뒤 submit");
    assert.equal(state_signature(c.env.db), after_wait, "재생은 아무것도 바꾸지 않는다");

    const g2_out = json_out(c.run(["claim", SLUG, "--run", g.run_id], { PES_TOKEN: agent.token }));
    const g2 = ["--run", g2_out.run_id, "--lease", g2_out.lease_id, "--fence", String(g2_out.fence)];
    assert.equal(c.run(["complete", SLUG, ...g2], { PES_TOKEN: agent.token }).status, 0);
    const done = state_signature(c.env.db);
    expect_rejected(c.run(["complete", SLUG, ...g2], { PES_TOKEN: agent.token }), "complete 재생");
    expect_rejected(c.run(["submit", SLUG, ...g2, "--file", results], { PES_TOKEN: agent.token }), "complete 뒤 submit");
    expect_rejected(c.run(["claim", SLUG, "--run", g.run_id], { PES_TOKEN: agent.token }), "끝난 run 재개");
    assert.equal(state_signature(c.env.db), done);
  }));

test("F4 submit 입력 오류(없는 파일·깨진 JSON·배열 아님·빈 배열·알 수 없는 op)는 스택 추적 없이 거부, 영수증 0", () =>
  with_cli(async (c) => {
    const agent = await c.agent("submit-input");
    const g = claim_as(c, agent.token);
    const before = state_signature(c.env.db);
    const broken = join(c.env.home.root, "broken.json");
    writeFileSync(broken, "{not json", "utf8");
    const not_array = write_json(c, "not-array.json", { results: "oops" });
    const unknown_op = write_json(c, "unknown-op.json", [{ op: "drop_table", object_id: "x" }]);
    const scalar = write_json(c, "scalar.json", 7);
    for (const [name, file] of [["results 가 문자열", not_array], ["모르는 op", unknown_op], ["숫자", scalar]] as const) {
      const res = c.run(["submit", SLUG, ...g.flags, "--file", file], { PES_TOKEN: agent.token });
      expect_rejected(res, `submit ${name}`);
      no_crash(res, `submit ${name}`);
    }
    for (const [name, args] of [["알 수 없는 옵션", ["wait", SLUG, ...g.flags, "--bogus", "1"]], ["complete 잘못된 status", ["complete", SLUG, ...g.flags, "--status", "bogus"]], ["claim 잘못된 mode", ["claim", SLUG, "--mode", "Z"]]] as const) {
      const res = c.run([...args], { PES_TOKEN: agent.token });
      expect_rejected(res, name);
      no_crash(res, name);
    }
    assert.equal(state_signature(c.env.db), before);
  }));

test("F4b [결함 후보·낮음] submit --file 이 없는 파일·깨진 JSON 이면 스택 추적이 아니라 분명한 오류", () =>
  with_cli(async (c) => {
    const agent = await c.agent("submit-missing");
    const g = claim_as(c, agent.token);
    const broken = join(c.env.home.root, "f4b-broken.json");
    writeFileSync(broken, "{not json", "utf8");
    for (const [name, file] of [["없는 파일", join(c.env.home.root, "missing.json")], ["깨진 JSON", broken]] as const) {
      const res = c.run(["submit", SLUG, ...g.flags, "--file", file], { PES_TOKEN: agent.token });
      expect_rejected(res, `submit ${name}`);
      no_crash(res, `submit ${name}`);
    }
  }));

test("F5 claim: 이미 lease 가 있으면 다른 에이전트의 claim 은 거부, 없는 run 재개도 거부", () =>
  with_cli(async (c) => {
    const a = await c.agent("claim-a");
    const b = await c.agent("claim-b");
    const ga = claim_as(c, a.token);
    const before = state_signature(c.env.db);
    expect_rejected(c.run(["claim", SLUG], { PES_TOKEN: b.token }), "활성 lease 중 두 번째 claim");
    expect_rejected(c.run(["claim", SLUG, "--run", "no-such-run"], { PES_TOKEN: b.token }), "없는 run 재개");
    expect_rejected(c.run(["claim", SLUG, "--run", ga.run_id], { PES_TOKEN: b.token }), "남의 run 재개");
    assert.equal(state_signature(c.env.db), before);
    assert.equal(lease(c)!.lease_id, ga.lease_id);
  }));

test("F6 context 는 읽기: 어떤 토큰으로든 영수증·행을 만들지 않고, DB에 없는 프로젝트는 거부", () =>
  with_cli(async (c) => {
    const agent = await c.agent("ctx");
    const before = state_signature(c.env.db);
    for (let i = 0; i < 3; i += 1) assert.match(json_out(c.run(["context", SLUG], { PES_TOKEN: agent.token })).digest, /^[0-9a-f]{64}$/);
    expect_rejected(c.run(["context", "no-such-project"], { PES_TOKEN: agent.token }), "없는 프로젝트 context");
    assert.equal(state_signature(c.env.db), before, "읽기는 DB를 바꾸지 않는다");
  }));

// ---------------------------------------------------------------------------
// G. pes home

test("G1 home: 새 폴더에 같은 이름이 있으면 아무것도 옮기지 않는다 (DB·옛 JSON 불변)", () =>
  with_cli(async (c) => {
    assert.equal(c.run(["init", "synthetic-clash", "--topic", "t"]).status, 0);
    const target = join(c.env.home.root, "clash-target");
    mkdirSync(join(target, "synthetic-clash"), { recursive: true });
    const before = snap(c);
    const sigs = state_signature(c.env.db);
    const res = c.run(["home", target]);
    expect_rejected(res, "이름 충돌 home");
    assert.deepEqual(c.sig(c.project_json), before.json);
    assert.ok(existsSync(c.folder));
    assert.equal(state_signature(c.env.db), sigs);
  }));

test("G2 home: 다른 세션이 잠근 프로젝트가 있으면 종료 3, --force 면 옮기되 DB(lease 포함)는 그대로", () =>
  with_cli(async (c) => {
    assert.equal(c.run(["lock", SLUG], { PES_OWNER: "sess-home0001" }).status, 0);
    const target = join(c.env.home.root, "busy-target");
    const sigs = state_signature(c.env.db);
    const res = c.run(["home", target], { PES_OWNER: "sess-home0002" });
    assert.equal(res.status, 3, res.stderr);
    assert.ok(existsSync(c.folder), "아무것도 안 옮겼다");
    assert.ok(!existsSync(target) || c.listing(target).length === 0);
    const forced = c.run(["home", target, "--force"], { PES_OWNER: "sess-home0002" });
    assert.equal(forced.status, 0, forced.stderr);
    assert.ok(existsSync(join(target, SLUG, "project.json")));
    assert.equal(state_signature(c.env.db), sigs, "이동은 lease·영수증·행을 바꾸지 않는다");
    // 옮긴 뒤에도 같은 DB 를 쓰므로 원래 세션의 잠금은 그대로 유효하다
    const env2 = { PES_OWNER: "sess-home0001", PES_HOME: target };
    assert.equal(c.run(["note", SLUG, "이동 뒤"], env2).status, 0);
  }));

test("G3 home: 서로 안에 들어 있는 폴더·같은 폴더는 옮기지 않는다", () =>
  with_cli(async (c) => {
    const sigs = state_signature(c.env.db);
    const inside = join(c.env.home.env.PES_HOME as string, "nested-home");
    expect_rejected(c.run(["home", inside]), "새 폴더가 옛 폴더 안");
    expect_rejected(c.run(["home", c.env.home.root]), "새 폴더가 옛 폴더를 품음");
    const same = c.run(["home", c.env.home.env.PES_HOME as string]);
    assert.equal(same.status, 0);
    assert.match(same.stdout, /이미 PES 홈/);
    assert.ok(existsSync(c.folder));
    assert.equal(state_signature(c.env.db), sigs);
  }));

test("G4 home: project.json 도 DB 행도 없는 낯선 폴더는 옮기지 않는다", () =>
  with_cli(async (c) => {
    const stray = join(c.env.home.env.PES_HOME as string, "stray-folder");
    mkdirSync(stray, { recursive: true });
    writeFileSync(join(stray, "keep.txt"), "x", "utf8");
    const target = join(c.env.home.root, "stray-target");
    const res = c.run(["home", target]);
    assert.equal(res.status, 0, res.stderr);
    assert.ok(existsSync(join(stray, "keep.txt")), "낯선 폴더는 그 자리에 남는다");
    assert.ok(!existsSync(join(target, "stray-folder")));
  }));

test("G5 모든 명령의 출력·설정 파일이 임시 HOME 밖(실제 ~/.pes·~/pes-projects)을 가리키지 않는다", () =>
  with_cli(async (c) => {
    const real_home = process.env.HOME;
    const sess = { PES_OWNER: "sess-iso00001" };
    const outputs: string[] = [];
    const merge_file = write_json(c, "g5-merge.json", [{ id: 1, title: "x" }]);
    for (const args of [
      ["lock", SLUG], ["round-start", SLUG, "plan"], ["note", SLUG, "x"], ["chat", SLUG, "plan", "x"], ["ask-prep", SLUG, "plan"],
      ["qa-brief", SLUG, "plan"], ["merge", SLUG, "plan", merge_file], ["render", SLUG, "plan"], ["approve", SLUG, "plan"], ["unlock", SLUG],
      ["init", "synthetic-iso", "--topic", "t"], ["remote", "add", "https://m5.example.ts.net"], ["home"], ["stop", "--", "synthetic-iso"],
    ]) {
      const res = c.run(args, sess);
      outputs.push(res.stdout, res.stderr);
    }
    const shown = c.run(["home"], { PES_HOME: undefined });
    outputs.push(shown.stdout);
    assert.match(shown.stdout, new RegExp(c.env.home.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "PES_HOME 없이도 기본 홈은 임시 HOME 밑이다");
    if (real_home !== undefined && real_home !== "" && !c.env.home.root.startsWith(real_home)) {
      for (const text of outputs) assert.ok(!text.includes(`${real_home}/.pes`) && !text.includes(`${real_home}/pes-projects`), `실제 홈 경로가 새어 나왔다: ${text.slice(0, 200)}`);
    }
    const cfg = join(c.env.home.env.HOME as string, ".pes", "config.json");
    if (existsSync(cfg)) {
      const config = JSON.parse(readFileSync(cfg, "utf8")) as Record<string, unknown>;
      for (const value of Object.values(config)) {
        if (typeof value === "string" && value.startsWith("/")) assert.ok(value.startsWith(c.env.home.root) || value.startsWith(`/private${c.env.home.root}`), `설정 파일의 경로가 임시 폴더 안이다: ${value}`);
      }
    }
  }));

// ---------------------------------------------------------------------------
// H. 문서가 적은 한계 ↔ v0.15 의미

test("H1 [결함 후보] approve plan 이 조사 항목을 만든다 (v0.15 handoff_plan: 기획의 topic 항목 → 조사 단계 항목) — 문서는 '자동 생성 없음'이라 적었다", () =>
  with_cli(async (c) => {
    await open_plan_round(c, "h1");
    const topics = write_json(c, "h1-plan.json", [
      { id: 1, kind: "topic", title: "합성 조사 질문 하나", question: "무엇인가?" },
      { id: 2, kind: "topic", title: "합성 조사 질문 둘", question: "왜인가?" },
    ]);
    assert.equal(c.run(["merge", SLUG, "plan", topics]).status, 0);
    assert.equal(c.run(["render", SLUG, "plan"]).status, 0);
    const research_before = c.env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM artifacts WHERE stage_id = ?", c.stages.research)?.n ?? 0n;
    const approved = c.run(["approve", SLUG, "plan"]);
    assert.equal(approved.status, 0, approved.stderr);
    const research_after = c.env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM artifacts WHERE stage_id = ?", c.stages.research)?.n ?? 0n;
    assert.ok(research_after >= research_before + 2n, `기획의 조사 질문 2개가 조사 단계 항목으로 넘어가야 한다 (전 ${research_before} → 후 ${research_after})`);
  }));

test("H2 [결함 후보] merge 가 한 항목에서 거부되면 앞 항목의 쓰기도 남지 않아야 한다 (여러 tx 로 나뉘어 부분 쓰기)", () =>
  with_cli(async (c) => {
    await open_plan_round(c, "h2");
    const first = write_json(c, "h2-first.json", [{ id: 1, kind: "section", title: "원고", sources: [{ url: "https://a.example/1", title: "A" }] }]);
    assert.equal(c.run(["merge", SLUG, "plan", first]).status, 0);
    // 새 항목(성공) + 출처 목록을 교체하려는 기존 원고(구현이 거부)
    const mixed = write_json(c, "h2-mixed.json", [
      { id: 7, title: "새 항목 — 같이 거부돼야 한다" },
      { id: 1, kind: "section", title: "원고", sources: [{ url: "https://b.example/2", title: "B" }] },
    ]);
    const signature = state_signature(c.env.db);
    const res = c.run(["merge", SLUG, "plan", mixed]);
    if (res.status !== 0) {
      assert.equal(state_signature(c.env.db), signature, "거부된 merge 는 앞 항목을 이미 기록해 두면 안 된다 (부분 쓰기)");
    }
  }));

test("H3 [결함 후보] 집필 원고(section)의 출처 목록 교체: v0.15 처럼 통째로 바뀌어야 한다 (구현은 거부)", () =>
  with_cli(async (c) => {
    await open_plan_round(c, "h3");
    const first = write_json(c, "h3-first.json", [{ id: 1, kind: "section", title: "원고", sources: [{ url: "https://a.example/1", title: "A" }, { url: "https://a.example/2", title: "A2" }] }]);
    assert.equal(c.run(["merge", SLUG, "plan", first]).status, 0);
    const replace = write_json(c, "h3-replace.json", [{ id: 1, kind: "section", sources: [{ url: "https://b.example/9", title: "B" }] }]);
    const res = c.run(["merge", SLUG, "plan", replace]);
    assert.equal(res.status, 0, `출처 목록을 새로 주면 원고의 출처가 그 목록으로 바뀐다 (v0.15): ${res.stderr.trim()}`);
    const urls = c.env.db
      .all<{ url: string }>(
        `SELECT sv.url AS url FROM objects o JOIN citations ci ON ci.artifact_version_id = o.current_version_id
           JOIN source_versions sv ON sv.project_id = ci.project_id AND sv.version_id = ci.source_version_id
          WHERE o.project_id = ? AND o.kind = 'artifact' ORDER BY ci.citation_no`,
        c.env.p.project_id,
      )
      .map((r) => r.url);
    assert.deepEqual(urls, ["https://b.example/9"], "교체된 출처 목록만 남는다");
  }));

test("H4 [결함 후보] 같은 항목을 두 번째 병합하면 그 새 판이 항목의 현재 판이 된다 (render 가 봉인하는 것·세 번째 병합의 기준)", () =>
  with_cli(async (c) => {
    await open_plan_round(c, "h4");
    const a = write_json(c, "h4-a.json", [{ id: 1, title: "항목", summary: "첫", sources: [{ url: "https://a.example/1", title: "A" }] }]);
    const b = write_json(c, "h4-b.json", [{ id: 1, summary: "둘", sources: [{ url: "https://a.example/1", title: "A" }, { url: "https://b.example/2", title: "B" }] }]);
    const d = write_json(c, "h4-d.json", [{ id: 1, summary: "셋" }]);
    const current = () =>
      c.env.db.get<{ summary: string; meta: string; cites: bigint }>(
        `SELECT v.summary AS summary, v.metadata_json AS meta,
                (SELECT count(*) FROM citations ci WHERE ci.artifact_version_id = v.version_id) AS cites
           FROM objects o JOIN artifact_versions v ON v.project_id = o.project_id AND v.version_id = o.current_version_id
          WHERE o.project_id = ? AND o.kind = 'artifact'`,
        c.env.p.project_id,
      );
    assert.equal(c.run(["merge", SLUG, "plan", a]).status, 0);
    assert.equal(current()?.summary, "첫");
    assert.equal(c.run(["merge", SLUG, "plan", b]).status, 0);
    const second = current();
    assert.equal(second?.summary, "둘", "두 번째 병합의 판이 현재 판이어야 한다 (지금은 첫 판에 머문다)");
    assert.equal(second?.cites, 2n, "A(중복 없이)·B 두 출처");
    assert.equal(c.run(["merge", SLUG, "plan", d]).status, 0);
    const third = current();
    assert.equal(third?.summary, "셋");
    assert.equal(third?.cites, 2n, "출처는 라운드를 지나며 누적된다");
    assert.equal(JSON.parse(third!.meta).depth, 3, "깊이는 병합 횟수만큼 쌓인다");
    const objects = c.env.db.get<{ n: bigint }>("SELECT count(*) AS n FROM objects WHERE project_id = ? AND kind = 'artifact'", c.env.p.project_id)?.n;
    assert.equal(objects, 1n, "항목은 새로 생기지 않고 판만 는다");
  }));

test("H5 [결함 후보·낮음] merge 입력 오류(없는 파일·깨진 JSON·객체 아닌 항목)는 스택 추적이 아니라 분명한 오류, 아무것도 쓰지 않는다", () =>
  with_cli(async (c) => {
    await open_plan_round(c, "h5");
    const signature = state_signature(c.env.db);
    const broken = join(c.env.home.root, "h5-broken.json");
    writeFileSync(broken, "[{", "utf8");
    const scalar_item = write_json(c, "h5-scalar.json", [{ id: 1, title: "x" }, 5]);
    for (const [name, file] of [["없는 파일", join(c.env.home.root, "h5-missing.json")], ["깨진 JSON", broken], ["객체 아닌 항목", scalar_item]] as const) {
      const res = c.run(["merge", SLUG, "plan", file]);
      expect_rejected(res, `merge ${name}`);
      no_crash(res, `merge ${name}`);
    }
    assert.equal(state_signature(c.env.db), signature);
  }));
