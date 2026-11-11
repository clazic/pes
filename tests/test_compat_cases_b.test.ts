// E06·E07·E10~E12 (reports, reads, lock, moved copy, broken/large file) on the ts target (SEL-74): the ts record must equal the frozen 0.15 baseline (tests/fixtures/compat/baseline/<id>.json) but for the intended differences.
// (`target_from_env()` is ts — a py value is refused.)
import { test } from "node:test";

import { assert_case } from "./helpers/compat_cases.ts";
import { target_from_env } from "./helpers/compat_env.ts";
import { use_home_guard } from "./helpers/home_guard.ts";

use_home_guard();
const target = target_from_env();

for (const id of ["E06", "E07", "E10", "E11", "E12"]) {
  test(`${id} (${target})`, { timeout: 180_000 }, async () => {
    await assert_case(target, id);
  });
}
