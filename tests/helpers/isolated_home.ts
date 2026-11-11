// Temporary HOME/USERPROFILE/PES_HOME for tests. process.env is never mutated:
// callers pass this env object to path helpers and child processes explicitly.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface IsolatedHome {
  readonly root: string;
  readonly env: Record<string, string | undefined>;
  cleanup(): void;
}

export function isolated_home(prefix = "pes-sel34-"): IsolatedHome {
  const root = resolve(mkdtempSync(join(tmpdir(), prefix)));
  const home = join(root, "home");
  const projects = join(root, "pes-projects");
  mkdirSync(home, { recursive: true });
  mkdirSync(projects, { recursive: true });

  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    PES_HOME: projects,
  };
  // SEL-74 G3: a hub port range of the developer's shell must never reach a child (it would point the server probes somewhere real).
  // A test that wants a range passes it explicitly in the options of the run.
  delete env.PES_HUB_PORTS;

  let cleaned = false;
  return {
    root,
    env,
    cleanup(): void {
      if (cleaned) return;
      cleaned = true;
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}
