// TS side of the Python audit hook of tests/conftest.py (SEL-70, PR26a).
//
// The Python guard stops a test from opening the real ~/.pes or ~/pes-projects. A Node test cannot hook file opens, so the same
// promise is kept in three layers:
//   1. assert_isolated_env(env)  — a child process may only start with HOME / USERPROFILE / PES_HOME inside one temp folder that
//                                  is not (and does not contain, and is not inside) the real home's protected folders.
//   2. use_home_guard()          — names / sizes / mtimes (never contents) of the real <home>/.pes and <home>/pes-projects are
//                                  taken before the file's tests and compared after them; any change fails the file. An absent
//                                  folder must stay absent.
//   3. assert_no_real_path(text) — a child's stdout / stderr / a produced file must not mention a protected real path.
// Layer 2 reuses the Playwright globalSetup listing (tests/e2e/helpers/home_guard.ts). All of it works with a *fake* "real home"
// too, so the guard itself is tested without touching anything real (tests/test_home_guard.test.ts).

import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { after, before } from "node:test";

import { snapshot_of } from "../e2e/helpers/home_guard.ts";

export const PROTECTED_NAMES = [".pes", "pes-projects"] as const;

/** realpath.native of the longest existing prefix (symlinks, junctions, Windows 8.3 names), the missing tail appended unchanged. */
function native(path: string): string {
  let current = resolve(path);
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync.native(current), ...[...tail].reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      tail.push(basename(current));
      current = parent;
    }
  }
}

function norm(path: string): string {
  const full = resolve(path);
  return process.platform === "win32" || process.platform === "darwin" ? full.toLowerCase() : full;
}

/** Every spelling of the protected folders of one home: as given, resolved (symlinks / 8.3 names), forward and doubled backslashes. */
export function protected_paths(real_home: string = homedir()): string[] {
  const bases = new Set([resolve(real_home), native(real_home)]);
  const out = new Set<string>();
  for (const base of bases) {
    for (const name of PROTECTED_NAMES) {
      const path = join(base, name);
      out.add(path);
      if (path.includes("\\")) {
        out.add(path.split("\\").join("/"));
        out.add(path.split("\\").join("\\\\"));
      }
    }
  }
  return [...out];
}

function inside(path: string, folder: string): boolean {
  const rel = relative(norm(folder), norm(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** True when `path` is, or lies below, a protected folder of `real_home`. A parent that contains one counts as unsafe too. */
export function touches_protected(path: string, real_home: string = homedir()): boolean {
  for (const base of new Set([resolve(real_home), native(real_home)])) {
    for (const name of PROTECTED_NAMES) {
      const folder = join(base, name);
      if (inside(path, folder) || inside(native(path), folder)) return true;
    }
  }
  return false;
}

export function assert_isolated_env(env: Record<string, string | undefined>, real_home: string = homedir()): void {
  for (const key of ["HOME", "USERPROFILE", "PES_HOME"] as const) {
    const value = env[key];
    assert.ok(typeof value === "string" && value !== "", `home guard: ${key} must be set to a temporary folder`);
    assert.ok(isAbsolute(value), `home guard: ${key} must be absolute`);
    assert.ok(!touches_protected(value, real_home), `home guard: ${key} points into the real PES home (${value})`);
  }
  assert.equal(env.HOME, env.USERPROFILE, "home guard: HOME and USERPROFILE must be the same folder");
  const real = new Set([resolve(real_home), native(real_home)].map(norm));
  assert.ok(!real.has(norm(env.HOME as string)), "home guard: HOME is the real home");
  assert.ok(!real.has(norm(env.PES_HOME as string)), "home guard: PES_HOME is the real home");
  for (const key of ["PES_OWNER", "PES_TOKEN", "PES_DB_CORE"] as const) {
    assert.equal(env[key], undefined, `home guard: ${key} must not leak into a compat child`);
  }
}

export function assert_no_real_path(text: string, what: string, real_home: string = homedir()): void {
  const flat = text.split("\\\\").join("\\");
  for (const path of protected_paths(real_home)) {
    assert.ok(!text.includes(path) && !flat.includes(path), `home guard: ${what} mentions the real path ${path}`);
  }
}

export interface HomeSnapshot {
  readonly home: string;
  readonly before: string;
  check(): void;
}

export function take_home_snapshot(real_home: string = homedir()): HomeSnapshot {
  const first = JSON.stringify(snapshot_of(real_home));
  return {
    home: real_home,
    before: first,
    check(): void {
      const second = JSON.stringify(snapshot_of(real_home));
      assert.equal(second, first, `home guard: ${real_home}/.pes or pes-projects changed (names, sizes or mtimes differ)`);
    },
  };
}

/** Call once at the top of a test file: compares the real home before / after the file's tests. */
export function use_home_guard(): void {
  let snapshot: HomeSnapshot | undefined;
  before(() => {
    snapshot = take_home_snapshot();
  });
  after(() => {
    snapshot?.check();
  });
}
