// SEL-106 — 1차 리뷰(CHANGES) 반영 시험. 기존 test_sel106_run_tests 의 단언은 그대로 두고 여기에 더한다.
//   R1  (필수) 기호 링크로 연 실행기도 진입으로 판정된다 — 이전에는 main() 이 안 돌고 종료 0(가짜 통과). 진입 판정이 틀린 채 이름이 run_tests.ts 면 1 로 실패한다
//   R2  (권장 2) 신호(SIGTERM)를 받으면 node --test 자식과 그 손자 프로세스가 고아로 남지 않는다
//   R3  (권장 3) 자식은 저장소 루트를 cwd 로 시작한다(실행기를 다른 폴더에서 불러도 glob 이 같다)
//   R4  (권장 5) main 은 build_node_args 결과를 process.execPath 로 넘기고, 잘못된 값이면 실행기를 부르지 않고 2 로 끝난다(C1 의 간접 단언을 직접으로)
//   R5  (권장 4) tests/README.md 가 `npm test -- <파일>` 은 전체 glob 과 합집합이라 전체가 돈다고 적는다
// 전체 시험은 여기서 시작하지 않는다(가짜 자식·가짜 실행기만 쓴다).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";

import { use_home_guard } from "./helpers/home_guard.ts";
import { isolated_home } from "./helpers/isolated_home.ts";
import { build_node_args, is_entry, main } from "../scripts/run_tests.ts";

use_home_guard();

const REPO = join(import.meta.dirname, "..");
const RUNNER = join(REPO, "scripts", "run_tests.ts");
const home = isolated_home("pes-sel106-fix-");
after(() => home.cleanup());

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function wait_for(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
}

test("R1a symlinked runner: bad value still exits 2 (was: silent exit 0, main never ran)", { skip: process.platform === "win32" }, () => {
  const dir = join(home.root, "r1a");
  mkdirSync(dir, { recursive: true });
  const link = join(dir, "rt.ts");
  symlinkSync(RUNNER, link);
  for (const via of [link, join(dir, "run_tests.ts")]) {
    if (via !== link) symlinkSync(RUNNER, via);
    const run = spawnSync(process.execPath, [via], { cwd: dir, env: { ...home.env, PES_TEST_CONCURRENCY: "0" }, encoding: "utf8", timeout: 20000 });
    assert.equal(run.status, 2, `${via}: ${run.stderr}`);
    assert.match(run.stderr, /PES_TEST_CONCURRENCY/);
  }
});

test("R1b symlinked DIRECTORY holding the repo: bad value still exits 2", { skip: process.platform === "win32" }, () => {
  const dir = join(home.root, "r1b");
  mkdirSync(dir, { recursive: true });
  const repo_link = join(dir, "repo");
  symlinkSync(REPO, repo_link);
  const run = spawnSync(process.execPath, [join(repo_link, "scripts", "run_tests.ts")], { cwd: dir, env: { ...home.env, PES_TEST_CONCURRENCY: "abc" }, encoding: "utf8", timeout: 20000 });
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stderr, /PES_TEST_CONCURRENCY/);
});

test("R1c is_entry: realpath equal → true; a different file, undefined or a vanished path → false", () => {
  const url = new URL("file://" + RUNNER).href;
  assert.equal(is_entry(url, RUNNER), true);
  assert.equal(is_entry(url, undefined), false);
  assert.equal(is_entry(url, join(REPO, "scripts", "no_such_file.ts")), false);
  assert.equal(is_entry(url, join(REPO, "package.json")), false);
  if (process.platform !== "win32") {
    const dir = join(home.root, "r1c");
    mkdirSync(dir, { recursive: true });
    const link = join(dir, "x.ts");
    symlinkSync(RUNNER, link);
    assert.equal(is_entry(url, link), true);
    assert.equal(realpathSync(link), realpathSync(RUNNER));
  }
});

test("R2 SIGTERM to the runner takes the node child AND its grandchild down (no orphans)", { skip: process.platform === "win32" }, async () => {
  const dir = join(home.root, "r2");
  mkdirSync(dir, { recursive: true });
  const pid_file = join(dir, "grand.pid");
  const child_pid_file = join(dir, "child.pid");
  // fake "node --test": starts a grandchild (like a test-file process) and waits; it does NOT forward signals itself
  writeFileSync(
    join(dir, "fake_child.mjs"),
    [
      `import { spawn } from "node:child_process";`,
      `import { writeFileSync } from "node:fs";`,
      `const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });`,
      `writeFileSync(${JSON.stringify(pid_file)}, String(g.pid));`,
      `writeFileSync(${JSON.stringify(child_pid_file)}, String(process.pid));`,
      `setInterval(() => {}, 1000);`,
    ].join("\n"),
  );
  writeFileSync(
    join(dir, "driver.ts"),
    [
      `import { run_node } from ${JSON.stringify(RUNNER)};`,
      `process.exit(await run_node(process.execPath, [${JSON.stringify(join(dir, "fake_child.mjs"))}]));`,
    ].join("\n"),
  );
  const driver = spawn(process.execPath, [join(dir, "driver.ts")], { cwd: dir, env: home.env, stdio: ["ignore", "ignore", "pipe"] });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => driver.on("close", (code, signal) => resolve({ code, signal })));
  assert.ok(await wait_for(() => existsSync(pid_file) && existsSync(child_pid_file), 15000), "fake child did not start");
  const grand = Number(readFileSync(pid_file, "utf8"));
  const child = Number(readFileSync(child_pid_file, "utf8"));
  assert.ok(alive(grand) && alive(child), "both alive before the signal");
  driver.kill("SIGTERM");
  const result = await exited;
  assert.ok(result.code !== 0, `runner must not end with 0 after a signal (got ${JSON.stringify(result)})`);
  assert.ok(await wait_for(() => !alive(child) && !alive(grand), 10000), `orphan left: child alive=${alive(child)} grandchild alive=${alive(grand)}`);
  for (const pid of [child, grand]) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
});

test("R3 the child starts with the repo root as cwd, whatever the caller's cwd", async () => {
  const dir = join(home.root, "r3");
  mkdirSync(dir, { recursive: true });
  const out = join(dir, "cwd.txt");
  writeFileSync(join(dir, "fake_child.mjs"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(out)}, process.cwd());`);
  writeFileSync(
    join(dir, "driver.ts"),
    [`import { run_node } from ${JSON.stringify(RUNNER)};`, `process.exit(await run_node(process.execPath, [${JSON.stringify(join(dir, "fake_child.mjs"))}]));`].join("\n"),
  );
  const run = spawnSync(process.execPath, [join(dir, "driver.ts")], { cwd: dir, env: home.env, encoding: "utf8", timeout: 20000 });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(realpathSync(readFileSync(out, "utf8")), realpathSync(REPO));
});

test("R4a main hands process.execPath + build_node_args(...) to the runner and returns its code", async () => {
  const calls: Array<{ exe: string; args: readonly string[] }> = [];
  const code = await main(["--test-name-pattern", "W0"], { PES_TEST_CONCURRENCY: "3" }, 10, async (exe, args) => {
    calls.push({ exe, args });
    return 7;
  });
  assert.equal(code, 7);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.exe, process.execPath);
  assert.deepEqual(calls[0]!.args, build_node_args({ PES_TEST_CONCURRENCY: "3" }, ["--test-name-pattern", "W0"], 10));
});

test("R4b main with a bad value never calls the runner and returns 2", async () => {
  let called = 0;
  const code = await main([], { PES_TEST_CONCURRENCY: "0" }, 10, async () => {
    called++;
    return 0;
  });
  assert.equal(code, 2);
  assert.equal(called, 0);
});

test("R5 tests/README.md says `npm test -- <file>` runs everything (union with the full glob)", () => {
  const readme = readFileSync(join(REPO, "tests", "README.md"), "utf8");
  assert.match(readme, /npm test -- <파일>[^\n]*(합집합|전체)/);
  assert.match(readme, /합집합/);
});
