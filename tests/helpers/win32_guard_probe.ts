// SEL-103 probe, run only as a CHILD of test_sel103_final_review2 (`node --experimental-vm-modules tests/helpers/win32_guard_probe.ts`; not a *.test.ts, so
// `npm test` never collects it). It loads the REAL helper sources (home_guard.ts · temp_home_check.ts, types stripped, bodies unchanged) in a vm module graph
// where `node:path` is the win32 implementation and `node:fs` is a recording FAKE — so layer 4's Windows path judgement is exercised on any OS, and nothing
// real is opened: the "account home" is a FAKE string (PROBE_ACCOUNT), the fake fs only records the paths it is called with.
//
// Input (env): PROBE_ACCOUNT — the fake account home as os.userInfo().homedir answers it (any spelling); PROBE_HOME — the temporary HOME (os.homedir());
//              PROBE_PATHS — JSON array of the paths to statSync through the guard.
// Output (stdout, one JSON line): { results: [{ path, outcome: "refused" | "reached", violations }], reached: [paths the fake fs saw] }.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const account = process.env.PROBE_ACCOUNT ?? "";
const home = process.env.PROBE_HOME ?? "";
const paths = JSON.parse(process.env.PROBE_PATHS ?? "[]") as string[];
if (account === "" || home === "") throw new Error("win32_guard_probe: PROBE_ACCOUNT and PROBE_HOME are required");

const HELPERS = import.meta.dirname;
const reached: string[] = [];
const passthrough = Object.assign((p: string) => p, { native: (p: string) => p });
const fake_fs: Record<string, unknown> = {
  realpathSync: passthrough,
  realpath: Object.assign((p: string) => p, { native: (p: string) => p }),
  statSync: (p: string) => {
    reached.push(p);
    return "reached";
  },
  promises: {},
};

const VM = vm as any;
const modules = new Map<string, any>();
function synthetic(identifier: string, exports: Record<string, unknown>): void {
  const names = Object.keys(exports);
  modules.set(
    identifier,
    new VM.SyntheticModule(names, function (this: any) {
      for (const name of names) this.setExport(name, exports[name]);
    }, { identifier }),
  );
}
synthetic("node:os", { homedir: () => home, userInfo: () => ({ homedir: account }) });
synthetic("node:path", { ...win32 });
synthetic("node:assert/strict", { default: assert });
synthetic("node:module", { createRequire: () => () => fake_fs, syncBuiltinESMExports: () => undefined });
synthetic("node:url", { fileURLToPath });
synthetic("node:test", { before: () => undefined, after: () => undefined });
synthetic("./require_temp_home.ts", {});
synthetic("../e2e/helpers/home_guard.ts", { snapshot_of: () => ({}) });
function source(identifier: string, file: string): any {
  const module = new VM.SourceTextModule(stripTypeScriptTypes(readFileSync(join(HELPERS, file), "utf8")), {
    identifier,
    initializeImportMeta: (meta: { url: string }) => {
      meta.url = "file:///synthetic/home_guard.ts";
    },
  });
  modules.set(identifier, module);
  return module;
}
source("./temp_home_check.ts", "temp_home_check.ts");
const guard_module = source("home_guard.ts", "home_guard.ts");
await guard_module.link((specifier: string) => {
  const module = modules.get(specifier);
  if (module === undefined) throw new Error(`win32_guard_probe: unexpected import ${specifier}`);
  return module;
});
await guard_module.evaluate();

const results: Array<{ path: string; outcome: string; violations: number }> = [];
for (const path of paths) {
  const guard = guard_module.namespace.guard_process_fs();
  let outcome = "reached";
  try {
    (fake_fs.statSync as (p: string) => unknown)(path);
  } catch (error) {
    outcome = String((error as Error).message).startsWith("PESHomeAccessViolation") ? "refused" : `error ${(error as Error).message}`;
  }
  const violations = guard.violations.length;
  try {
    guard.release();
  } catch {
    // a recorded violation makes release() fail — counted above
  }
  results.push({ path, outcome, violations });
}
console.log(JSON.stringify({ results, reached }));
