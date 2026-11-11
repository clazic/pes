// SEL-74 최종 리뷰 1/2 반영 시험 (logs: SEL-74-final-review-1).
//   필수 1. 빈(0 바이트)·옛 스키마(projects 표 없음) pes.db 는 읽기에서 '없음'과 같다 — 0.15 폴더의 status·pending·digest·list·hub 가 된다.
//           doctor 는 실행할 수 있는 안내를 주고, --fix 는 0 바이트 파일만 치운다. migrate 는 그 DB 를 최신으로 올린다.
//   필수 2. 숨김 소유자 프로젝트(pes-local-owner)는 doctor·doctor --fix·status·list·hub 어디에도 나오지 않는다(폴더 생성 0).
//   권장 1. '다른 PES 가 쓰는 중' 탐지는 파일을 바꾸지 않는다(이름·바이트 그대로, 쓰기·이름 바꾸기 사건 0) — Windows 방식도.
//   권장 2. Node 26 미만이면 pes.ts·setup.ts·serve.ts 가 한국어 한 줄로 exit 1.
//   권장 3. stop 이 옛 서버를 끄지 못하면 사실대로(exit 1, 끄는 방법) 알린다.
//   권장 7. DB 가 없는 홈에 자격 없는 /api/v1 GET 은 401 이고 DB 를 만들지 않는다.
// 합성 자료만, 임시 HOME·USERPROFILE·PES_HOME 에서 가드 아래 자식으로.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, watch, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { held_elsewhere } from "../scripts/pes_core/cli_doctor.ts";
import { connect, load_migrations, migrate } from "../scripts/pes_core/db.ts";
import { db_path } from "../scripts/pes_core/paths.ts";
import { free_port, SETUP_TS, SERVE_TS, type CompatCtx } from "./helpers/compat_env.ts";
import { run_ts_cli } from "./helpers/compat_ts.ts";
import { TsServeProcess } from "./helpers/compat_ts_srv.ts";
import { use_home_guard } from "./helpers/home_guard.ts";
import { assert_one_line_error, bytes_digest, db_rows, legacy_folder, pes_ts, pes_ts_async, with_ctx } from "./helpers/sel74_env.ts";

use_home_guard();

const SLUG = "demo-a";
const OWNER_SLUG = "pes-local-owner";
const NOT_CURRENT = /최신이 아닙니다/;

function db_file(ctx: CompatCtx): string {
  return db_path(ctx.env);
}

function empty_db(ctx: CompatCtx): string {
  const file = db_file(ctx);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "");
  return file;
}

/** A database file of some other (old) shape: a valid SQLite file without the projects table. */
function tableless_db(ctx: CompatCtx): string {
  const file = db_file(ctx);
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE old_thing (a TEXT); INSERT INTO old_thing VALUES ('x');");
  db.close();
  return file;
}

/** The read commands of a 0.15 folder: none may fail because of the database. */
function assert_reads_work(ctx: CompatCtx, what: string): void {
  for (const args of [["status", SLUG], ["pending", SLUG], ["digest", SLUG, "plan"], ["list"]]) {
    const run = pes_ts(ctx, args);
    assert.equal(run.status, 0, `${what}: ${args.join(" ")} → ${run.stderr}${run.stdout}`);
    assert.doesNotMatch(run.stdout + run.stderr, NOT_CURRENT, `${what}: ${args.join(" ")}`);
  }
}

/** `hub` through an injected single port (never 8760~8775), then `stop`; returns the home page text. */
async function hub_text(ctx: CompatCtx): Promise<string> {
  const port = await free_port();
  const options = { env: { PES_HUB_PORTS: `${port}-${port}` }, allow_child_process: true, allow_hub_port: port };
  const started = pes_ts(ctx, ["hub"], options);
  assert.equal(started.status, 0, `hub: ${started.stderr}${started.stdout}`);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200, "GET / of the hub");
    return await res.text();
  } finally {
    pes_ts(ctx, ["stop"], options);
  }
}

async function doctor(ctx: CompatCtx, fix: boolean): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const port = await free_port();
  return pes_ts(ctx, fix ? ["doctor", "--fix"] : ["doctor"], { env: { PES_HUB_PORTS: `${port}-${port}` }, allow_child_process: true, allow_hub_port: port });
}

// ---------------------------------------------------------------- 필수 1

test("필수 1: a 0-byte pes.db reads like no database — status·pending·digest·list·hub of a 0.15 folder work; doctor says what to do; doctor --fix removes only the empty file", { timeout: 300_000 }, async () => {
  await with_ctx("pes-final1-empty-", async (ctx) => {
    legacy_folder(ctx, SLUG, "full");
    const file = empty_db(ctx);
    assert_reads_work(ctx, "0-byte db");
    assert.match(await hub_text(ctx), new RegExp(SLUG), "the hub lists the 0.15 folder");
    assert.equal(statSync(file).size, 0, "reading leaves the empty file as it is");

    const diag = await doctor(ctx, false);
    assert.match(diag.stdout, /빈 데이터베이스 파일 \(0 바이트\)/, diag.stdout);
    assert.match(diag.stdout, /--fix 로 고칠 수 있음/, "the row is fixable");
    assert.ok(existsSync(file), "the default diagnosis changes nothing");

    const fixed = await doctor(ctx, true);
    assert.match(fixed.stdout, /빈 데이터베이스 파일[^\n]*→ 고침/, fixed.stdout);
    assert.ok(!existsSync(file), "--fix removed the empty file");
    assert_reads_work(ctx, "after --fix");
  });
});

test("필수 1: a SQLite file without the projects table (not made by PES) reads like no database; doctor says so; migrate refuses it in one Korean line and leaves it as it is", { timeout: 300_000 }, async () => {
  await with_ctx("pes-final1-foreign-", async (ctx) => {
    const dir = legacy_folder(ctx, SLUG, "full");
    const file = tableless_db(ctx);
    const bytes = readFileSync(file).toString("hex");
    assert_reads_work(ctx, "table-less db");
    const diag = await doctor(ctx, false);
    assert.match(diag.stdout, /PES 데이터베이스가 아닌 파일[^\n]*다른 이름으로 옮겨/, diag.stdout);
    const before = bytes_digest(dir);
    const run = pes_ts(ctx, ["migrate", SLUG]);
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert_one_line_error(run, "migrate onto a foreign file");
    assert.match(run.stderr, /PES 데이터베이스가 아닌 파일입니다/);
    assert.equal(readFileSync(file).toString("hex"), bytes, "the file is unchanged");
    assert.equal(bytes_digest(dir), before, "the folder is unchanged");
    assert_reads_work(ctx, "after the refusal");
  });
});

test("필수 1: an older PES schema with no project reads like no database; doctor names `pes migrate`; migrate brings it up to date and the project is served", { timeout: 300_000 }, async () => {
  await with_ctx("pes-final1-old-", async (ctx) => {
    const dir = legacy_folder(ctx, SLUG, "full");
    const file = db_file(ctx);
    mkdirSync(dirname(file), { recursive: true });
    const all = load_migrations();
    assert.ok(all.length >= 2, "there is an older schema to build");
    const old = connect(file);
    migrate(old, { migrations: all.slice(0, all.length - 1) });
    old.close();
    assert_reads_work(ctx, "older schema");
    const diag = await doctor(ctx, false);
    assert.match(diag.stdout, /데이터베이스 스키마가 최신이 아님[^\n]*pes migrate/, diag.stdout);

    const before = bytes_digest(dir);
    const run = pes_ts(ctx, ["migrate", SLUG]);
    assert.equal(run.status, 0, run.stderr + run.stdout);
    assert.equal(bytes_digest(dir), before, "the folder is only read");
    assert.deepEqual(db_rows<{ status: string }>(ctx, "SELECT status FROM projects WHERE slug = ?", SLUG).map((r) => r.status), ["active"]);
    assert.ok(statSync(file).size > 0);
    assert_reads_work(ctx, "after migrate");
  });
});

test("필수 1: migrate on a 0-byte pes.db makes the normal schema", { timeout: 300_000 }, async () => {
  await with_ctx("pes-final1-empty-mig-", async (ctx) => {
    legacy_folder(ctx, SLUG, "full");
    empty_db(ctx);
    const run = pes_ts(ctx, ["migrate", SLUG]);
    assert.equal(run.status, 0, run.stderr + run.stdout);
    assert.equal(db_rows<{ status: string }>(ctx, "SELECT status FROM projects WHERE slug = ?", SLUG)[0]?.status, "active");
    const status = pes_ts(ctx, ["status", SLUG]);
    assert.equal(status.status, 0, status.stderr);
  });
});

// ---------------------------------------------------------------- 필수 2

test("필수 2: the hidden owner project shows nowhere — doctor, doctor --fix (no folder made), status, list, hub", { timeout: 300_000 }, async () => {
  await with_ctx("pes-final1-owner-", async (ctx) => {
    legacy_folder(ctx, SLUG, "full");
    assert.equal(pes_ts(ctx, ["migrate", SLUG]).status, 0);
    assert.equal(db_rows(ctx, "SELECT 1 FROM projects WHERE slug = ?", OWNER_SLUG).length, 1, "the first migrate made the owner project");

    const diag = await doctor(ctx, false);
    assert.doesNotMatch(diag.stdout, new RegExp(OWNER_SLUG), diag.stdout);
    assert.match(diag.stdout, new RegExp(`■ ${SLUG}`), "the real project has its group");
    const fixed = await doctor(ctx, true);
    assert.doesNotMatch(fixed.stdout, new RegExp(OWNER_SLUG), fixed.stdout);
    assert.ok(!existsSync(join(ctx.pes_home, OWNER_SLUG)), "doctor --fix made no folder for it");

    const status = pes_ts(ctx, ["status", OWNER_SLUG]);
    assert.notEqual(status.status, 0, "status does not answer for it");
    assert.doesNotMatch(status.stdout, /PES 로컬 소유자/);
    const list = pes_ts(ctx, ["list"]);
    assert.equal(list.status, 0, list.stderr);
    assert.doesNotMatch(list.stdout, new RegExp(OWNER_SLUG));
    assert.doesNotMatch(await hub_text(ctx), new RegExp(OWNER_SLUG));
    assert.ok(!existsSync(join(ctx.pes_home, OWNER_SLUG)), "still no folder");
  });
});

// ---------------------------------------------------------------- 권장 1

test("권장 1: the 'held by another PES' probe changes no file — no write, no rename (Windows way included); names and bytes stay", { timeout: 60_000 }, async () => {
  await with_ctx("pes-final1-probe-", async (ctx) => {
    const dir = join(ctx.tmp, "probe");
    mkdirSync(dir, { recursive: true });
    const files = { journal: join(dir, "pes.db-journal"), shm: join(dir, "pes.db-shm") };
    writeFileSync(files.journal, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
    writeFileSync(files.shm, Buffer.alloc(32768, 7));
    const names = readdirSync(dir).sort();
    const bytes = Object.fromEntries(Object.entries(files).map(([k, f]) => [k, readFileSync(f).toString("hex")]));
    const times = Object.fromEntries(Object.entries(files).map(([k, f]) => [k, statSync(f).mtimeMs]));
    const events: string[] = [];
    const watcher = watch(dir, (kind, name) => events.push(`${kind}:${String(name)}`));
    try {
      // macOS FSEvents may still report the files written above a moment later: let them settle, then count only what the probe does
      await new Promise((r) => setTimeout(r, 1500));
      events.length = 0;
      for (const file of Object.values(files)) {
        for (const platform of ["win32", process.platform] as NodeJS.Platform[]) {
          const answer = held_elsewhere(file, platform);
          assert.ok(["held", "free", "unknown"].includes(answer), `${platform}: ${answer}`);
          assert.notEqual(answer, "held", `${platform}: nobody holds ${file}`);
        }
      }
      await new Promise((r) => setTimeout(r, 500));
    } finally {
      watcher.close();
    }
    assert.deepEqual(events, [], "no write / rename event in the folder");
    assert.deepEqual(readdirSync(dir).sort(), names, "the same names (no .probe left)");
    for (const [k, f] of Object.entries(files)) {
      assert.equal(readFileSync(f).toString("hex"), bytes[k], `${k}: same bytes`);
      assert.equal(statSync(f).mtimeMs, times[k], `${k}: same mtime`);
    }
  });
});

test("권장 1: the default doctor with a -journal and -shm next to the database leaves both as they are (names and bytes)", { timeout: 120_000 }, async () => {
  await with_ctx("pes-final1-residue-", async (ctx) => {
    legacy_folder(ctx, SLUG, "full");
    assert.equal(pes_ts(ctx, ["migrate", SLUG]).status, 0);
    const file = db_file(ctx);
    const pes_dir = dirname(file);
    writeFileSync(`${file}-journal`, Buffer.from("not a real journal"));
    writeFileSync(`${file}-shm`, Buffer.alloc(32768, 3));
    const names = readdirSync(pes_dir).sort();
    const sides = [file, `${file}-journal`, `${file}-shm`].map((f) => readFileSync(f).toString("hex"));
    const diag = await doctor(ctx, false);
    assert.match(diag.stdout, /pes\.db-journal/, "the residue row names the journal");
    assert.deepEqual(readdirSync(pes_dir).sort(), names, "no file renamed, added or removed");
    assert.deepEqual([file, `${file}-journal`, `${file}-shm`].map((f) => readFileSync(f).toString("hex")), sides, "same bytes");
  });
});

// ---------------------------------------------------------------- 권장 2

function old_node_preload(ctx: CompatCtx): string {
  const file = join(ctx.tmp, "old-node.mjs");
  writeFileSync(file, 'Object.defineProperty(process.versions, "node", { value: "24.1.0" });\n', "utf8");
  return realpathSync.native(file); // the loader resolves the real spelling (macOS /var → /private/var is outside the allow list)
}

test("권장 2: under Node 24 the entry points end with one Korean line and exit 1 — pes.ts, setup.ts (needed too), serve.ts", { timeout: 180_000 }, async () => {
  await with_ctx("pes-final1-node-", async (ctx) => {
    const imports = [old_node_preload(ctx)];
    const port = await free_port();
    const runs: Array<[string, ReturnType<typeof run_ts_cli>]> = [
      ["pes.ts status", pes_ts(ctx, ["status", SLUG], { imports })],
      ["pes.ts list", pes_ts(ctx, ["list"], { imports })],
      ["setup.ts needed", run_ts_cli(ctx, ["needed"], { imports, script: SETUP_TS, timeout_ms: 60_000 })],
      ["serve.ts", run_ts_cli(ctx, [ctx.pes_home, String(port)], { imports, script: SERVE_TS, timeout_ms: 30_000 })],
    ];
    for (const [what, run] of runs) {
      assert.equal(run.status, 1, `${what}: exit 1 — ${run.stderr}${run.stdout}`);
      assert_one_line_error(run, what);
      assert.match(run.stderr, /Node\.js 26 이상이 필요합니다 \(지금 24\.1\.0\)/, what);
    }
    assert.ok(!existsSync(db_file(ctx)), "nothing was created");
  });
});

// ---------------------------------------------------------------- 권장 3

test("권장 3: stop that cannot end an older server (no pid in /whoami) says so — the port and how to end it (exit 0 as 0.15); never '서버 종료'", { timeout: 120_000 }, async () => {
  await with_ctx("pes-final1-stop-", async (ctx) => {
    const port = await free_port();
    const roots = new Set<string>();
    const server: Server = createServer((req, res) => {
      const body = req.url === "/whoami" ? JSON.stringify({ root: [...roots][0], single: true }) : JSON.stringify({ ok: true });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(body);
    });
    await new Promise<void>((done) => server.listen(port, "127.0.0.1", done));
    try {
      // the root this CLI computes for its home (the same spelling `pes home` prints)
      const home = pes_ts(ctx, ["home"]);
      assert.equal(home.status, 0, home.stderr);
      const root = (home.stdout.match(/(\/[^\s]+|[A-Za-z]:\\[^\s]+)/)?.[1] ?? ctx.pes_home).trim();
      roots.add(root);
      const run = await pes_ts_async(ctx, ["stop"], { env: { PES_HUB_PORTS: `${port}-${port}` }, allow_hub_port: port });
      // exit 0 as in 0.15 (test_sel74_g_server_safety G1 keeps that contract); the one stdout line tells the truth instead of 서버 종료
      assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
      assert.doesNotMatch(run.stdout, /서버 종료/);
      const lines = run.stdout.replace(/\r\n/g, "\n").trimEnd().split("\n");
      assert.equal(lines.length, 1, run.stdout);
      assert.match(run.stdout, /서버를 끄지 못했습니다/);
      assert.match(run.stdout, new RegExp(`포트 ${port}`));
      assert.match(run.stdout, process.platform === "win32" ? /Stop-Process/ : /kill/);
      assert.ok(server.listening, "the stand-in is still there (nothing was killed)");
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});

// ---------------------------------------------------------------- 권장 7

test("권장 7: GET /api/v1 without a credential on a home without a database is 401 and creates no database (the owner's session still may)", { timeout: 120_000 }, async () => {
  await with_ctx("pes-final1-api-", async (ctx) => {
    legacy_folder(ctx, SLUG, "full");
    const srv = await new TsServeProcess(ctx, ctx.pes_home).start();
    try {
      for (const path of ["/api/v1/projects", "/api/v1/me"]) {
        const res = await srv.request(path);
        assert.equal(res.status, 401, `${path}: ${res.text()}`);
        assert.equal(res.json().error.code, "unauthenticated");
        const bearer = await srv.request(path, { headers: { authorization: "Bearer pes_not_a_real_token_0123456789" } });
        assert.equal(bearer.status, 401, `${path} with a token: ${bearer.text()}`);
        const wrong = await srv.request(path, { headers: { "x-pes-session": "x".repeat(43) } });
        assert.equal(wrong.status, 401, `${path} with a wrong session: ${wrong.text()}`);
      }
      assert.ok(!existsSync(db_file(ctx)), "no database was created");
      const status = pes_ts(ctx, ["status", SLUG]);
      assert.equal(status.status, 0, "the home still reads like 0.15");
    } finally {
      await srv.stop();
    }
  });
});
