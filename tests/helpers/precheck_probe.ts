// SEL-103 probe, run only as a CHILD of test_sel103_real_home_precheck (`node --test tests/helpers/precheck_probe.ts`; not a *.test.ts, so `npm test` never
// collects it). It is an ordinary guarded test file: it imports home_guard.ts and calls use_home_guard(), which — when the start was allowed — lists
// <home>/.pes and <home>/pes-projects (lstat · readdir). The homes are given explicitly (PES_PROBE_HOMES = the FAKE account home), so the real account
// home is never looked at; without them the probe refuses to run.
import { delimiter } from "node:path";
import { test } from "node:test";

import { use_home_guard } from "./home_guard.ts";

const homes = (process.env.PES_PROBE_HOMES ?? "").split(delimiter).filter((home) => home !== "");
if (homes.length === 0) throw new Error("precheck_probe: PES_PROBE_HOMES (the fake account home) is required");

use_home_guard(homes);

test("probe", () => {
  console.log("PROBE-RAN");
});
