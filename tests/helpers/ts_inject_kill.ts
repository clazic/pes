// Test-only recorder for TypeScript children (SEL-77 R1): loaded with `--import` (compat_ts `imports`). No file under scripts/ changes.
//
// `process.kill(pid, signal)` is replaced: a call with a real signal is NOT sent — it is appended to PES_TEST_KILL_LOG as one JSON line
// {"pid": <the value as passed>, "signal": <as passed>} and answers `true`, so a bad pid in a record file (null → 0, -1, 1 …) can never
// reach a real process of the machine, while the test reads exactly what the product tried. Signal 0 (the liveness probe of
// `pid_alive`) and `undefined` pass through to the real call: it signals nothing.
import { appendFileSync } from "node:fs";

const log = process.env.PES_TEST_KILL_LOG ?? "";
const real_kill = process.kill.bind(process);

process.kill = ((pid: number, signal?: string | number): true => {
  if (signal === undefined || signal === 0 || signal === "0") return real_kill(pid, signal as number) as true;
  if (log !== "") appendFileSync(log, `${JSON.stringify({ pid, signal })}\n`);
  return true;
}) as typeof process.kill;
