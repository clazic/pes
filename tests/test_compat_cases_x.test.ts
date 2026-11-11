// CLI contract cases X01~X04 (SEL-71) on the 0.15 target: the record must equal the pinned baseline (tests/fixtures/compat/baseline/X0n.json).
// The same cases run on the TS target in test_pes_ts_contract.test.ts (always, whatever PES_COMPAT_TARGET says).
import { test } from "node:test";

import { assert_case } from "./helpers/compat_cases.ts";
import { use_home_guard } from "./helpers/home_guard.ts";

use_home_guard();

for (const id of ["X01", "X02", "X03", "X04"]) {
  test(`${id} (py)`, { timeout: 180_000 }, async () => {
    await assert_case("py", id);
  });
}
