// SEL-103 probe, run only as a CHILD of test_sel103_no_account_listing (`node --test tests/helpers/listing_probe.ts`; not a *.test.ts). An ordinary guarded test
// file with the DEFAULT homes (use_home_guard() with no argument): before the test it lists the homes it lists by default, and installs the fs guard (layer 4).
import { test } from "node:test";

import { use_home_guard } from "./home_guard.ts";

use_home_guard();

test("probe", () => {
  console.log("PROBE-RAN");
});
