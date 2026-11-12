// SEL-106 — 최종 리뷰 F1 반영 시험. 기존 test_sel106_run_tests·test_sel106_review_fixes 의 단언은 그대로 두고 여기에 더한다.
//   F1  (필수) 생성 모듈의 import 지정자는 pathToFileURL(...).href — Windows 드라이브 경로(C:\…)도 file:/// URL 이 된다(ERR_UNSUPPORTED_ESM_URL_SCHEME 방지)
//   F2  (권장 2) SIGTERM 을 무시하는 자식이 있어도 실행기는 끝난다 — 첫 신호 뒤 제한 시간(주입 가능)이 지나면 그룹에 SIGKILL, 두 번째 신호면 곧바로 SIGKILL
// 전체 시험은 여기서 시작하지 않는다(가짜 자식·가짜 실행기만 쓴다).
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";

import { use_home_guard } from "./helpers/home_guard.ts";
import { isolated_home } from "./helpers/isolated_home.ts";

use_home_guard();

const REPO = join(import.meta.dirname, "..");
const RUNNER = join(REPO, "scripts", "run_tests.ts");
const home = isolated_home("pes-sel106-final-");
after(() => home.cleanup());

/** 생성 모듈 import 에 넣을 지정자(따옴표 포함) — 경로가 아니라 file URL. Windows 의 `C:\\…` 를 그대로 넣으면 'c:' 스킴으로 읽힌다. */
function module_specifier(path: string, options?: { windows?: boolean }): string {
  return JSON.stringify(pathToFileURL(path, options).href);
}

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

type Exit = { code: number | null; signal: NodeJS.Signals | null };

/** 기한 안에 끝나면 종료 결과, 아니면 undefined. */
function exit_within(proc: ChildProcess, ms: number): Promise<Exit | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    proc.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function kill_quietly(target: number, signal: NodeJS.Signals = "SIGKILL"): void {
  try {
    process.kill(target, signal);
  } catch {
    /* already gone */
  }
}

test("F1a module_specifier turns a Windows drive path into a file:/// URL (not a 'c:' scheme)", () => {
  const spec = module_specifier("C:\\work\\pes\\scripts\\run_tests.ts", { windows: true });
  assert.equal(spec, JSON.stringify("file:///C:/work/pes/scripts/run_tests.ts"));
  assert.ok(JSON.parse(spec).startsWith("file:///"), spec);
  assert.doesNotMatch(spec, /\\/);
  const posix = module_specifier("/work/pes/scripts/run_tests.ts", { windows: false });
  assert.equal(posix, JSON.stringify("file:///work/pes/scripts/run_tests.ts"));
});

test("F1b module_specifier on this platform is a file:/// URL that imports the real runner", async () => {
  const spec = module_specifier(RUNNER);
  assert.ok(JSON.parse(spec).startsWith("file:///"), spec);
  const mod = (await import(JSON.parse(spec))) as { run_node?: unknown };
  assert.equal(typeof mod.run_node, "function");
});

/** SIGTERM 을 무시하는 가짜 "node --test" 를 실행기(run_node)로 띄운다. 정리는 바로 t.after 에 등록. */
async function start_stubborn(t: { after: (fn: () => void) => void }, name: string, kill_after_ms: number) {
  const dir = join(home.root, name);
  mkdirSync(dir, { recursive: true });
  const child_pid_file = join(dir, "child.pid");
  writeFileSync(
    join(dir, "stubborn.mjs"),
    [
      `import { writeFileSync } from "node:fs";`,
      `for (const s of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(s, () => {});`,
      `writeFileSync(${JSON.stringify(child_pid_file)}, String(process.pid));`,
      `setInterval(() => {}, 1000);`,
    ].join("\n"),
  );
  writeFileSync(
    join(dir, "driver.ts"),
    [
      `import { run_node } from ${module_specifier(RUNNER)};`,
      `process.exit(await run_node(process.execPath, [${JSON.stringify(join(dir, "stubborn.mjs"))}], { kill_after_ms: ${kill_after_ms} }));`,
    ].join("\n"),
  );
  const driver = spawn(process.execPath, [join(dir, "driver.ts")], { cwd: dir, env: home.env, stdio: ["ignore", "ignore", "pipe"] });
  let child: number | undefined;
  t.after(() => {
    if (child !== undefined) kill_quietly(-child); // 자식 그룹(POSIX: 자식 pid = 그룹 id)
    if (child !== undefined) kill_quietly(child);
    if (driver.pid !== undefined) kill_quietly(driver.pid);
  });
  const exited = exit_within(driver, 30000);
  assert.ok(await wait_for(() => existsSync(child_pid_file), 15000), "stubborn child did not start");
  child = Number(readFileSync(child_pid_file, "utf8"));
  assert.ok(alive(child), "child alive before the signal");
  return { driver, exited, child };
}

test("F2a a child that ignores SIGTERM is SIGKILLed after kill_after_ms; the runner ends with 143", { skip: process.platform === "win32", timeout: 60000 }, async (t) => {
  const { driver, exited, child } = await start_stubborn(t, "f2a", 300);
  driver.kill("SIGTERM");
  const result = await exited;
  assert.ok(result, "runner still waiting 30s after SIGTERM (no escalation to SIGKILL)");
  assert.equal(result.code, 143, JSON.stringify(result));
  assert.ok(await wait_for(() => !alive(child), 10000), "stubborn child still alive");
});

test("F2b a second signal escalates to SIGKILL at once (kill_after_ms far away)", { skip: process.platform === "win32", timeout: 60000 }, async (t) => {
  const { driver, exited, child } = await start_stubborn(t, "f2b", 600000);
  driver.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 500));
  assert.ok(alive(child), "first SIGTERM is ignored by the child, which is the point of this test");
  driver.kill("SIGTERM");
  const result = await exited;
  assert.ok(result, "runner still waiting 30s after the second SIGTERM");
  assert.equal(result.code, 143, JSON.stringify(result));
  assert.ok(await wait_for(() => !alive(child), 10000), "stubborn child still alive");
});
