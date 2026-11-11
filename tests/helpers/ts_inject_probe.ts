// Stub child for the injection self-test (tests/test_pes_ts_guard.test.ts): exercises ts_inject_fs.ts without scripts/pes.ts.
//   lock-open <dir> <n>   n times: openSync(<dir>/.project.json.lock, "wx"); prints each outcome, then the platform seen in the catch
//   lock-stat <dir>       statSync / unlinkSync of the lock; prints outcomes
//   sleep <ms>            setTimeout, timers/promises and Atomics.wait; prints how much Date.now moved and the real time spent
//   other <dir>           open / stat of a file that is NOT the lock (must pass through)
import { closeSync, openSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { setTimeout as sleep_p } from "node:timers/promises";
import { join } from "node:path";

const [op, a, b] = process.argv.slice(2) as [string, string, string?];
const say = (t: string): void => void process.stdout.write(`${t}\n`);
const code = (error: unknown): string => `${(error as NodeJS.ErrnoException).code ?? String(error)}@${process.platform}`;

if (op === "lock-open") {
  for (let i = 0; i < Number(b); i += 1) {
    try {
      closeSync(openSync(join(a, ".project.json.lock"), "wx"));
      say("opened");
      unlinkSync(join(a, ".project.json.lock"));
    } catch (error) {
      say(`open ${code(error)}`);
    }
  }
  say(`after ${process.platform}`);
} else if (op === "lock-stat") {
  writeFileSync(join(a, ".project.json.lock"), "");
  for (const step of ["stat", "unlink", "unlink"] as const) {
    try {
      if (step === "stat") statSync(join(a, ".project.json.lock"));
      else unlinkSync(join(a, ".project.json.lock"));
      say(`${step} ok`);
    } catch (error) {
      say(`${step} ${code(error)}`);
    }
  }
} else if (op === "sleep") {
  const t0 = Date.now();
  const r0 = process.hrtime.bigint();
  await new Promise<void>((done) => setTimeout(done, Number(a)));
  await sleep_p(Number(a));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(a));
  say(`moved ${Date.now() - t0 >= 3 * Number(a)} real_ms_small ${Number(process.hrtime.bigint() - r0) / 1e6 < 3 * Number(a) / 2}`);
} else if (op === "other") {
  writeFileSync(join(a, "other.lock"), "");
  closeSync(openSync(join(a, "other.lock"), "r"));
  statSync(join(a, "other.lock"));
  say("other ok");
}
