// Playwright globalSetup: the run must not touch the home of the process that runs it (os.homedir()).
// It lists names / sizes / mtimes (never contents) of <home>/.pes and <home>/pes-projects down to depth 3 before the run;
// the returned teardown lists them again and fails when anything differs. A folder that does not exist stays "absent".
//
// SEL-103: that listing (lstat · readdir) is itself a look at the folder, so it only ever happens in a TEMPORARY home. A run that starts in the real account
// home is refused first (assert_temp_home_env — strings only, same as `npm test`'s --import entry), and snapshot_of() answers "(not listed)" for an account home
// without an fs call, whoever calls it. The real home is protected by that start check and, for the test files, by layer 4 of tests/helpers/home_guard.ts.
import { lstatSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { assert_temp_home_env, is_account_home } from "../../helpers/temp_home_check.ts";

function list(dir: string, depth: number): string[] {
  let stat;
  try {
    stat = lstatSync(dir);
  } catch {
    return ["(absent)"];
  }
  const out = [`${stat.isDirectory() ? "d" : "f"} ${stat.size} ${Math.trunc(stat.mtimeMs)}`];
  if (!stat.isDirectory() || depth === 0) return out;
  for (const name of readdirSync(dir).sort()) {
    for (const line of list(join(dir, name), depth - 1)) out.push(`${name}/ ${line}`);
  }
  return out;
}

/** The two protected folders of a given home (names / sizes / mtimes, depth 3). SEL-70 reuses this for the compat harness. */
export function snapshot_of(home: string): Record<string, string[]> {
  if (is_account_home(home)) return { ".pes": ["(not listed: account home)"], "pes-projects": ["(not listed: account home)"] };
  return { ".pes": list(join(home, ".pes"), 3), "pes-projects": list(join(home, "pes-projects"), 3) };
}

export function snapshot_home(): Record<string, string[]> {
  return snapshot_of(homedir());
}

export default async function global_setup(): Promise<() => Promise<void>> {
  assert_temp_home_env(); // before the first lstat: a run in the real account home fails here (also at config load — playwright.config.ts)
  const before = JSON.stringify(snapshot_home());
  return async () => {
    const after = JSON.stringify(snapshot_home());
    if (after !== before) throw new Error(`the e2e run changed ${homedir()}/.pes or pes-projects (names, sizes or mtimes differ)\nbefore: ${before}\nafter:  ${after}`);
  };
}
