/**
 * SEL-49 PR16 — CLI 읽기·보고서·doctor — watch·doctor (tester). 원래 tests/test_cli_read.test.ts 하나였고 Windows CI 조각 상한(10분) 때문에 주제별로 나눴다. 해석 번호는 test_cli_read_v015.test.ts 머리말 참고. 구현 전이므로 새 시험은 실패하는 것이 정상이다.
 *
 * 시험 방식은 PR15와 같다: `python3 -I -X utf8 scripts/pes.py ...`를 subprocess로 실행하고 HOME·USERPROFILE·PES_HOME은
 * 모두 임시 폴더다(tests/helpers/cli_write_env.ts 의 하니스 + cli_read_env.ts). 자료는 모두 합성이다.
 * 개발 플래그 PES_DB_CORE=1 일 때만 DB 읽기 경로가 켜진다. 플래그가 없으면 v0.15 출력·종료 코드·파일이 그대로다.
 *
 * 이 시험이 고정하는 해석(보고서의 '해석 n'과 번호가 같다):
 *   해석 1  읽기가 DB를 쓰는지는 PR12 `serving_path`와 같다: 프로젝트가 DB에 있고 active 이면 DB, 그 밖(DB에 없음·staging·
 *           failed·archived)은 project.json 을 읽는 legacy 다. legacy 읽기 출력은 v0.15 와 바이트가 같고 mtime 도 안 바뀐다.
 *   해석 2  v0.15 기준본은 03fc81b(PR15 머지 시점: 읽기 명령이 아직 project.json 만 읽는 main)의 `git archive`다.
 *   해석 3  DB `pending` 의 식별자는 옛 feedback 파일 이름 모양을 유지한다(이전해 온 답은 그 이름 그대로). 새로 생긴 답의 이름
 *           형식은 PR14 API 쪽 결정이라 여기서 고정하지 않는다.
 *   해석 4  `report <slug> <stage>`: 단계마다 artifact(kind 'report') 한 객체. 실행할 때마다 content.append_version 으로 새 버전을
 *           쌓고(덮어쓰기 없음), 렌더 파일 report.md·report.html 을 file.reserve_upload→complete_upload→attach_version(role
 *           'rendered')으로 붙인다. '정확한 버전' = 새 보고서 버전이 그때 쓴 항목들의 현재 버전을 derived_from 으로 가리킴.
 *           '각주' = 마크다운 「출처」 절 번호(처음 나온 순서·중복 제거, v0.15 와 같음).
 *   해석 5  새 코어 명령은 없다(EXPECTED_COMMAND_NAMES 불변). report/assemble/web 의 쓰기는 기존 content.*·file.* 명령만 지난다.
 *   해석 6  `assemble`/`web` 은 artifact(kind 'output') 한 객체에 새 버전을 쌓는다. 파일 이름은 report.md·sources.json·report.html.
 *           내용이 같은 재실행도 새 버전이다(leader 결정).
 *   해석 7  report/output artifact 는 render 봉인 목록과 approve plan 인계에 들어가지 않는다.
 *   해석 8  `watch` 는 같은 출력 형식(`tail -n0 -F <따옴표 처리한 경로>/feedback.log | grep --line-buffered FEEDBACK` 한 줄)을
 *           유지한다. 입력 long-poll 은 PR18 몫이라 여기서는 고정하지 않는다(이슈: '같은 출력 형식이나 long-poll').
 *   해석 9  doctor 의 `--json` 행은 {group, level, title, detail, fixable}. DB 상태 그룹은 "데이터베이스", 서버 그룹은 "서버"
 *           (점유 포트 행: 제목에 ":<포트>", 상세에 소유 프로세스 pid), 경로 quoting 경고는 그룹 "환경"·level "warn"·제목에
 *           "경로"와 (공백|따옴표|괄호|특수).
 *   해석 10 validate_import: 재생성 보고서가 옛 보고서와 다르면 문제(check "reports_regeneration", path)이고 ok=false.
 *           '작성 …' 시각 줄은 비교에서 무시한다. html 도 같은 규칙(시각 정규화 뒤 같아야 함). `regeneration_format` 은 더는
 *           "provisional" 이 아니다. 이 시험은 기존 S4b(provisional 단언)·'손으로 고친 보고서도 validated'·`full` 픽스처의
 *           손글씨 reports/plan/report.md 와 부딪친다 — 구현 PR 에서 그 시험·픽스처를 함께 바꿔야 한다(leader 결정).
 *   해석 11 DB 모드는 프로젝트 폴더 reports/·out/ 에 쓰지 않는다. 출력에 새 버전 id 와 파일 이름·blob id 를 보인다.
 *   해석 12 `hub`·`open` 은 서버·브라우저를 띄우므로 이 시험에서 실행하지 않는다.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { COMMANDS } from "../scripts/pes_core/commands.ts";
import { EXPECTED_COMMAND_NAMES } from "./helpers/command_names.ts";
import { disk_path } from "./helpers/blob_env.ts";
import { expect_rejected, make_cli_env, SLUG, with_cli, type CliEnv, type CliResult, LEGACY_JSON } from "./helpers/cli_write_env.ts";
import { baseline_dir, normalize, OFF, ok, plain_legacy, folder_of, PLAN_ITEMS, WRITE_ITEMS, read_lf, rich_legacy, RICH_TOPIC, run_py, seed, shell_words, write_json, write_legacy, write_pending_answer, type HomeLike } from "./helpers/cli_read_env.ts";
import { FIXTURES, legacy, tree_digest } from "./helpers/legacy_env.ts";
import { copy_fixture, has_problem, migration, with_migration, owner_of, pes_home_of, backup_dir_of, batch_row } from "./helpers/migration_env.ts";
import { isolated_home } from "./helpers/isolated_home.ts";
import { state_signature } from "./helpers/state_signature.ts";

// ---------------------------------------------------------------------------
// 6 · watch: 같은 출력 형식, 따옴표 처리

test("watch: 한 줄 `tail -n0 -F <경로>/feedback.log | grep --line-buffered FEEDBACK` 형식 유지, 공백·따옴표 경로도 한 단어로 묶인다", () =>
  with_cli(async (c) => {
    const parent = "pes home (공백)'s";
    const home = join(c.env.home.root, parent);
    const signature = state_signature(c.env.db);
    for (const flag of ["1", undefined]) {
      const res = ok(run_py(c, ["watch", "some-project"], { flag, extra: { PES_HOME: home } }), `watch (flag ${flag})`);
      assert.equal(res.stdout.trim().split("\n").length, 1, "한 줄");
      const words = shell_words(res.stdout.trim());
      const expected = join(realpathSync.native(c.env.home.root), parent, "some-project", "feedback.log");
      assert.deepEqual(words.slice(0, 3), ["tail", "-n0", "-F"], `flag ${flag}`);
      assert.equal(words[3]!.split("\\").join("/"), expected.split("\\").join("/"), `경로가 따옴표로 한 단어: ${res.stdout}`);
      assert.deepEqual(words.slice(4), ["|", "grep", "--line-buffered", "FEEDBACK"]);
    }
    assert.ok(!existsSync(home), "watch 는 아무것도 만들지 않는다");
    assert.equal(state_signature(c.env.db), signature);
  }));

test("watch: DB 에만 있고 project.json 이 없는 프로젝트(init 으로 만든)도 같은 형식으로 출력한다", () =>
  with_cli(async (c) => {
    ok(run_py(c, ["init", "synthetic-init", "--topic", "합성 새 주제"]), "init");
    const res = ok(run_py(c, ["watch", "synthetic-init"]), "watch");
    const words = shell_words(res.stdout.trim());
    assert.deepEqual([words[0], words[1], words[2]], ["tail", "-n0", "-F"]);
    assert.match(words[3]!.split("\\").join("/"), /\/synthetic-init\/feedback\.log$/);
    assert.deepEqual(words.slice(4), ["|", "grep", "--line-buffered", "FEEDBACK"]);
  }));

// ---------------------------------------------------------------------------
// 7 · doctor: 기본 진단과 --fix 분리, 임시 홈만, DB·포트·경로 quoting

interface Row {
  group: string;
  level: "ok" | "info" | "warn" | "bad";
  title: string;
  detail: string;
  fixable?: boolean;
  fixed?: boolean;
}

function doctor_rows(res: CliResult, what: string): Row[] {
  assert.doesNotMatch(res.stderr, /Traceback/, `${what}: 스택 추적 없음`);
  try {
    return JSON.parse(res.stdout) as Row[];
  } catch {
    assert.fail(`${what}: doctor --json 은 JSON 배열이어야 한다\n${res.stdout}\n${res.stderr}`);
  }
}

test("doctor 기본 진단은 아무것도 고치지 않고, --fix 만 고친다: 임시 홈 안에서만", () =>
  with_cli(async (c) => {
    const folder = folder_of(c, "doc-legacy");
    const json = write_legacy(folder, plain_legacy("doc-legacy"));
    const tmp = join(folder, "project.json.tmp");
    writeFileSync(tmp, "{", "utf8");
    const fresh = join(c.env.home.root, "fresh pes home");
    const sig = c.sig(json);
    const signature = state_signature(c.env.db);
    const roots = [c.env.home.root, `/private${c.env.home.root}`];
    for (const flag of ["1", undefined]) {
      const plain = run_py(c, ["doctor", "--json"], { flag, extra: { PES_HOME: fresh } });
      const rows = doctor_rows(plain, `doctor (flag ${flag})`);
      assert.ok(!existsSync(fresh), `기본 진단은 PES 홈을 만들지 않는다 (flag ${flag})`);
      assert.ok(rows.some((r) => r.fixable === true), "고칠 수 있는 항목은 fixable 로 알린다");
      assert.ok(rows.every((r) => r.fixed !== true), "기본 진단은 고치지 않는다");
      const shown = normalize(plain.stdout + plain.stderr, roots);
      for (const real of [join(homedir(), ".pes"), join(homedir(), "pes-projects")]) {
        assert.equal(shown.includes(real), false, `실제 ${real} 를 읽거나 보이지 않는다 (임시 HOME·PES_HOME 만)`);
      }
    }
    const folder_rows = doctor_rows(run_py(c, ["doctor", "doc-legacy", "--json"]), "doctor doc-legacy");
    assert.ok(folder_rows.some((r) => r.title.includes("임시 파일") && r.fixable === true));
    assert.ok(existsSync(tmp), "기본 진단 뒤에도 임시 파일이 그대로");
    assert.deepEqual(c.sig(json), sig);
    assert.equal(state_signature(c.env.db), signature, "기본 진단은 DB 에 쓰지 않는다");

    // 플래그 켜짐 + 홈 안 legacy(미전환) 프로젝트: --fix 도 쓰지 않는다(legacy 는 읽기만 — r1-1 권장 6 결정, review1 R6).
    run_py(c, ["doctor", "doc-legacy", "--fix", "--json"]);
    assert.ok(existsSync(tmp), "플래그 켜짐: legacy 폴더의 임시 파일은 --fix 로도 그대로");
    assert.deepEqual(c.sig(json), sig);
    // 플래그 없음(v0.15): --fix 가 임시 파일을 지운다.
    const fixed = doctor_rows(run_py(c, ["doctor", "doc-legacy", "--fix", "--json"], { flag: undefined }), "doctor --fix (v0.15)");
    assert.ok(fixed.some((r) => r.title.includes("임시 파일") && r.fixed === true), "--fix 가 고친 항목을 알린다");
    assert.ok(!existsSync(tmp), "--fix 는 임시 파일을 지운다");
    assert.deepEqual(c.sig(json), sig, "--fix 도 project.json 은 건드리지 않는다");
    assert.equal(state_signature(c.env.db), signature, "--fix 도 DB 업무 행을 건드리지 않는다");

    const home_fix = run_py(c, ["doctor", "--fix", "--json"], { extra: { PES_HOME: fresh } });
    doctor_rows(home_fix, "doctor --fix (홈 없음)");
    assert.ok(existsSync(fresh), "--fix 는 (임시 홈 안의) PES 홈을 만든다");
  }));

test("doctor: DB 프로젝트(project.json 없음)를 '문제'로 보지 않고 데이터베이스 상태를 알린다", () =>
  with_cli(async (c) => {
    ok(run_py(c, ["init", "synthetic-init", "--topic", "합성 새 주제"]), "init");
    assert.ok(!existsSync(join(folder_of(c, "synthetic-init"), "project.json")));
    const signature = state_signature(c.env.db);
    const one = run_py(c, ["doctor", "synthetic-init", "--json"]);
    const rows = doctor_rows(one, "doctor synthetic-init");
    assert.ok(!rows.some((r) => r.group === "synthetic-init" && r.level === "bad"), `project.json 없음을 문제로 올리면 안 된다: ${JSON.stringify(rows.filter((r) => r.level === "bad"))}`);
    assert.ok(rows.some((r) => r.group === "synthetic-init" && r.level === "ok"), "DB 프로젝트 정상 행");
    const all = doctor_rows(run_py(c, ["doctor", "--json"]), "doctor");
    assert.ok(all.some((r) => r.group === "데이터베이스" && r.level === "ok"), "데이터베이스 그룹의 정상 행");
    assert.ok(all.some((r) => r.group === SLUG), "DB 에 있는 프로젝트가 진단 대상에 든다 (project.json 이 없어도)");
    assert.ok(all.some((r) => r.group === "synthetic-init"));
    assert.equal(state_signature(c.env.db), signature, "doctor 는 DB 를 읽기만 한다");
  }));

test("doctor: 깨진 DB 는 문제로 알리고(스택 추적 없음) --fix 로도 DB 를 건드리지 않는다", () => {
  const home = isolated_home("pes-sel49-doc-");
  try {
    const like: HomeLike = { env: { home } };
    const db = join(home.root, "home", ".pes", "pes.db");
    mkdirSync(join(home.root, "home", ".pes"), { recursive: true });
    writeFileSync(db, "이것은 SQLite 파일이 아니다 ".repeat(40), "utf8");
    const before = readFileSync(db);
    for (const args of [["doctor", "--json"], ["doctor", "--fix", "--json"]]) {
      const res = run_py(like, args);
      const rows = doctor_rows(res, args.join(" "));
      assert.equal(res.status, 1, "문제가 있으면 종료 1");
      assert.ok(rows.some((r) => r.group === "데이터베이스" && r.level === "bad"), `데이터베이스 문제 행: ${res.stdout}`);
      assert.ok(rows.every((r) => !(r.group === "데이터베이스" && r.fixable === true)), "DB 는 doctor 가 스스로 고치지 않는다");
      assert.ok(readFileSync(db).equals(before), "DB 파일 바이트 불변");
    }
  } finally {
    home.cleanup();
  }
});

test("doctor: 서버 포트를 PES 가 아닌 프로그램이 쥐고 있으면 소유 프로세스(pid)와 함께 알린다", async (t) => {
  const holder = spawn(
    process.execPath,
    [
      "-e",
      `const net=require("node:net");const held=[];let left=5;const done=()=>{if(--left===0)console.log("HELD "+JSON.stringify(held));};
for(const p of [8760,8761,8762,8763,8764]){const s=net.createServer(k=>{k.on("error",()=>{});k.end("not http\\r\\n");});s.once("error",done);s.listen(p,"127.0.0.1",()=>{held.push(p);done();});}
setInterval(()=>{},1000);`,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const tool = process.platform === "darwin" ? ["lsof", ["-v"]] : process.platform === "win32" ? ["netstat", ["-h"]] : ["ss", ["--version"]];
  const probe = spawnSync(tool[0] as string, tool[1] as string[], { encoding: "utf8" });
  const owner_tool_missing = probe.error !== undefined && (probe.error as NodeJS.ErrnoException).code === "ENOENT";
  const c = await make_cli_env();
  try {
    const held: number[] = await new Promise((resolve, reject) => {
      let buf = "";
      holder.stdout!.on("data", (d: Buffer) => {
        buf += d.toString();
        const m = buf.match(/HELD (\[.*\])/);
        if (m) resolve(JSON.parse(m[1]!) as number[]);
      });
      holder.once("error", reject);
      setTimeout(() => reject(new Error("포트 점유 도우미가 응답하지 않음")), 15_000);
    });
    if (held.length === 0) {
      t.skip("8760~8764 가 모두 이미 쓰이고 있어 시험용 점유를 만들 수 없다");
      return;
    }
    const rows = doctor_rows(run_py(c, ["doctor", "--json"], { timeout: 120_000 }), "doctor");
    for (const port of held) {
      const row = rows.find((r) => r.group === "서버" && r.title.includes(`:${port}`));
      assert.ok(row, `포트 ${port} 점유 행: ${JSON.stringify(rows.filter((r) => r.group === "서버"))}`);
      assert.equal(row.level, "warn", "PES 가 아닌 프로그램이 쥔 포트는 주의");
      if (owner_tool_missing) assert.ok(row.detail.includes(String(holder.pid)) || row.detail.includes("확인 불가"), `소유 도구가 없으면 '확인 불가' 허용: ${row.detail}`);
      else assert.ok(row.detail.includes(String(holder.pid)), `소유 프로세스 pid ${holder.pid} 를 알린다: ${row.detail}`);
    }
  } finally {
    holder.kill();
    c.close();
  }
});

test("doctor: 공백·따옴표·괄호가 든 PES 홈 경로는 명령 quoting 위험으로 알리고, 깨끗한 경로는 알리지 않는다", () =>
  with_cli(async (c) => {
    const risky = join(c.env.home.root, "pes home (공백)'s");
    mkdirSync(risky, { recursive: true });
    const rows = doctor_rows(run_py(c, ["doctor", "--json"], { extra: { PES_HOME: risky } }), "doctor (위험한 경로)");
    const hit = rows.find((r) => r.group === "환경" && /경로/.test(r.title) && /공백|따옴표|괄호|특수/.test(r.title));
    assert.ok(hit, `경로 quoting 경고 행: ${JSON.stringify(rows.filter((r) => r.group === "환경").map((r) => r.title))}`);
    assert.equal(hit.level, "warn");
    assert.ok(hit.fixable !== true, "경로는 doctor --fix 가 바꾸지 않는다");
    const clean = doctor_rows(run_py(c, ["doctor", "--json"]), "doctor (깨끗한 경로)");
    assert.ok(!clean.some((r) => r.group === "환경" && /경로/.test(r.title) && /공백|따옴표|괄호|특수/.test(r.title)), "깨끗한 경로에는 경고가 없다");
  }));

