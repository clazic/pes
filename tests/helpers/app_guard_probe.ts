// SEL-122 probe, CHILD only (tests/test_sel122_app_home_guard.test.ts): runs one of the app's start guards (PES_APP_GUARD_FILE) the way the runner calls it,
// then prints PROBE-RAN. Not a *.test.ts, so `npm test` never collects it.
import { pathToFileURL } from "node:url";

const file = process.env.PES_APP_GUARD_FILE ?? "";
if (file === "") throw new Error("app_guard_probe: PES_APP_GUARD_FILE is required");
const mod = (await import(pathToFileURL(file).href)) as { default: () => unknown };
await mod.default();
console.log("PROBE-RAN");
