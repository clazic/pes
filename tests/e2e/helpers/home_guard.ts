// Playwright globalSetup: the run must not touch the home of the process that runs it (os.homedir()).
// It lists names / sizes / mtimes (never contents) of <home>/.pes and <home>/pes-projects down to depth 3 before the run;
// the returned teardown lists them again and fails when anything differs. A folder that does not exist stays "absent".
import { lstatSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
  return { ".pes": list(join(home, ".pes"), 3), "pes-projects": list(join(home, "pes-projects"), 3) };
}

export function snapshot_home(): Record<string, string[]> {
  return snapshot_of(homedir());
}

export default async function global_setup(): Promise<() => Promise<void>> {
  const before = JSON.stringify(snapshot_home());
  return async () => {
    const after = JSON.stringify(snapshot_home());
    if (after !== before) throw new Error(`the e2e run changed ${homedir()}/.pes or pes-projects (names, sizes or mtimes differ)\nbefore: ${before}\nafter:  ${after}`);
  };
}
