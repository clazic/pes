// Test-only (SEL-74 G2), loaded with `--import` (compat_ts `imports`). In a process whose script is serve.ts, `http.Server.listen` does
// nothing: the server child starts, stays alive, and never answers /whoami — "a child that does not answer". Its pid goes to
// PES_TEST_HANG_PID_FILE (one line per child) so the test can see whether the product ended it. In any other process (pes.ts itself) this
// module does nothing.
import http from "node:http";
import { appendFileSync } from "node:fs";

const script = (process.argv[1] ?? "").replace(/\\/g, "/");
if (script.endsWith("/serve.ts") || script === "serve.ts") {
  const file = process.env.PES_TEST_HANG_PID_FILE ?? "";
  if (file !== "") appendFileSync(file, `${process.pid}\n`);
  (http.Server.prototype as unknown as { listen: (...args: unknown[]) => unknown }).listen = function listen(this: unknown): unknown {
    return this;
  };
  setInterval(() => undefined, 1000);
}
