// SEL-73 (stage 2 PR26d): legacy importer 는 옛 데이터 형식만 읽고 Python 을 실행하지 않는다 — 시험으로 고정한다.
//   (a) 정적: importer 모듈(legacy.ts·commands/legacy.ts)과 그것이 실제로 불러오는 모듈에 child_process 가 없다.
//   (b) 실행: 시험 전용 훅(tests/helpers/fs_cp_spy.ts)으로 가져오기 한 번(scan·import·map·report) 동안
//       child_process 실행 호출 0 (spawn/exec/execFile/fork 와 Sync 판), 원본 폴더 쓰기 0,
//       원본 폴더 안에서는 옛 형식이 정의한 이름·실제 파일 목록만 열고, 원본·임시 루트·scripts·node_modules 밖 경로 접근 0.
// 지금 구현이 이미 만족할 수 있다 — 이 시험은 이후 회귀(PR26 정리 중 Python 호출이 새는 것)를 막는 고정 장치다.
// 합성 자료만(tests/fixtures/legacy/**), 임시 HOME/PES_HOME, 시계는 FakeClock. 원본은 시험마다 사본.

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { spawnSync as named_spawn_sync } from "node:child_process";

import { canon, rel_under, start_spy, under, type Spy } from "./helpers/fs_cp_spy.ts";
import {
  copy_fixture,
  make_broken_project,
  run_import,
  tree_entries,
  with_legacy,
  type LegacyApi,
} from "./helpers/legacy_env.ts";
import type { Env } from "./helpers/blob_env.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const CORE = join(REPO, "scripts", "pes_core");

/** 0.15 형식이 정의한 이름(최상위 파일 + 폴더). 원본 폴더 안에서 이것과 실제 파일 목록 밖은 열지 않는다. */
const LEGACY_FORMAT_NAMES = new Set([
  "project.json",
  "project.json.tmp",
  "library.json",
  "feedback.log",
  "feedback",
  "ask",
  "snapshots",
  "rounds",
  "reports",
  "out",
  "shots",
  "library",
]);

// ---------------------------------------------------------------------------
// (a) 정적

function runtime_imports(file: string): string[] {
  const text = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const out: string[] = [];
  const re = /(?:^|\n)\s*(?:import|export)\s+(?!type\b)[^;]*?from\s+"([^"]+)"/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) out.push(m[1]!);
  const re2 = /(?:^|\n)\s*import\s+"([^"]+)"/g;
  for (let m = re2.exec(text); m !== null; m = re2.exec(text)) out.push(m[1]!);
  return out;
}

function closure(entries: string[]): string[] {
  const seen = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const spec of runtime_imports(file)) {
      if (!spec.startsWith(".")) continue;
      const target = resolve(dirname(file), spec);
      if (existsSync(target)) visit(target);
    }
  };
  for (const entry of entries) visit(entry);
  return [...seen].sort();
}

const IMPORTER_ENTRIES = [join(CORE, "legacy.ts"), join(CORE, "commands", "legacy.ts")];

test("legacy importer modules and everything they load at runtime never import child_process", () => {
  const files = closure(IMPORTER_ENTRIES);
  assert.ok(files.length >= 2, "the closure was computed");
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(text, /child_process/, `${file} must not use child_process`);
    assert.doesNotMatch(text, /\bworker_threads\b/, `${file} must not start workers`);
  }
});

test("legacy importer sources name no Python entry point (pes.py, serve.py, python executables)", () => {
  for (const file of IMPORTER_ENTRIES) {
    const code = readFileSync(file, "utf8")
      .replace(/\r\n/g, "\n")
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");
    assert.doesNotMatch(code, /pes\.py|serve\.py|setup\.py/, `${file} calls a Python script`);
    assert.doesNotMatch(code, /["'`]python3?(\.exe)?["'`]/, `${file} names a Python executable`);
  }
});

// ---------------------------------------------------------------------------
// (b) 실행

interface Observed {
  spy: Spy;
  source: string;
  files: Set<string>;
}

async function with_import_spy(
  env: Env,
  api: LegacyApi,
  source: string,
  fn: (observed: Observed, imported: Awaited<ReturnType<typeof run_import>>) => void,
): Promise<void> {
  const source_canon = canon(source);
  const files = new Set(tree_entries(source).map((e) => e.path));
  const spy = start_spy();
  let result: Awaited<ReturnType<typeof run_import>>;
  try {
    api.scan_project(source);
    result = await run_import(env, api, source);
    api.map_legacy(env.db, result.batch_id);
    api.report_unknown(env.db, result.batch_id);
  } finally {
    spy.stop();
  }
  fn({ spy, source: source_canon, files }, result);
}

function check_observed({ spy, source, files }: Observed, env: Env): void {
  assert.deepEqual(spy.process_calls, [], "the importer starts no process (no Python, no shell, no git)");

  const roots = [source, canon(env.home.root), canon(join(REPO, "scripts")), canon(join(REPO, "node_modules"))];
  const dirs = new Set<string>([""]);
  for (const f of files) {
    const parts = f.split("/");
    for (let i = 1; i < parts.length; i += 1) dirs.add(parts.slice(0, i).join("/"));
  }
  const outside: string[] = [];
  const unknown_in_source: string[] = [];
  const writes_in_source: string[] = [];
  for (const call of spy.fs_calls) {
    const rel = rel_under(call.path, source);
    if (rel !== null) {
      if (call.write) writes_in_source.push(`${call.op} ${rel}`);
      const top = rel.split("/")[0]!;
      const known = rel === "" || files.has(rel) || dirs.has(rel) || LEGACY_FORMAT_NAMES.has(top);
      if (!known) unknown_in_source.push(`${call.op} ${rel}`);
      continue;
    }
    if (!roots.some((root) => under(call.path, root))) outside.push(`${call.op} ${call.path}`);
  }
  assert.deepEqual(writes_in_source, [], "the importer never writes into the source folder");
  assert.deepEqual(unknown_in_source, [], "inside the source folder only old-format names / listed files are opened");
  assert.deepEqual(outside, [], "no path outside source / temp root / scripts / node_modules is touched");

  const real_pes = [join(homedir(), ".pes"), join(homedir(), "pes-projects")].map((p) => p.toLowerCase());
  for (const call of spy.fs_calls) {
    const lower = call.path.toLowerCase();
    assert.ok(!real_pes.some((p) => lower === p || lower.startsWith(p + "/") || lower.startsWith(p + "\\")), `real PES folder touched: ${call.path}`);
  }
  assert.ok(spy.fs_calls.some((c) => rel_under(c.path, source) === "project.json" || files.size === 0), "the importer did read the source (spy sees it)");
}

for (const name of ["full", "complete", "broken-parts"]) {
  test(`importing fixture '${name}': 0 child processes, only old-format reads, 0 writes into the source`, async () => {
    await with_legacy(async (env, api) => {
      const dir = copy_fixture(env, name);
      await with_import_spy(env, api, dir, (observed, result) => {
        assert.equal(result.state, "staging");
        check_observed(observed, env);
      });
    });
  });
}

test("importing a damaged project.json (failed batch) also starts no process and reads only the source", async () => {
  await with_legacy(async (env, api) => {
    const dir = make_broken_project(env);
    await with_import_spy(env, api, dir, (observed, result) => {
      assert.equal(result.state, "failed");
      check_observed(observed, env);
    });
  });
});

test("a replayed import (same fingerprint) starts no process either", async () => {
  await with_legacy(async (env, api) => {
    const dir = copy_fixture(env, "full");
    await run_import(env, api, dir);
    await with_import_spy(env, api, dir, (observed, result) => {
      assert.equal(result.replayed, true);
      check_observed(observed, env);
    });
  });
});

// ---------------------------------------------------------------------------
// 훅 자체가 먹는지(양성 대조): 막지 않으면 위 시험은 아무것도 증명하지 못한다

test("spy self-check: a spawn through a named ESM import is blocked and recorded; the original is restored afterwards", () => {
  const spy = start_spy();
  let thrown: unknown;
  try {
    named_spawn_sync(process.execPath, ["-e", "0"]);
  } catch (error) {
    thrown = error;
  } finally {
    spy.stop();
  }
  assert.ok(thrown instanceof Error, "the blocked spawn throws");
  assert.deepEqual(spy.process_calls.map((c) => c.fn), ["spawnSync"]);
  const after = named_spawn_sync(process.execPath, ["-e", "0"]);
  assert.equal(after.status, 0, "stop() restores child_process");
});

test("spy self-check: fs reads and writes are recorded with normalized paths", async () => {
  await with_legacy(async (env) => {
    const dir = copy_fixture(env, "complete");
    const spy = start_spy();
    try {
      readdirSync(dir);
      readFileSync(join(dir, "project.json"));
    } finally {
      spy.stop();
    }
    const rels = spy.fs_calls.map((c) => rel_under(c.path, canon(dir)));
    assert.ok(rels.includes("") && rels.includes("project.json"), JSON.stringify(rels));
  });
});
