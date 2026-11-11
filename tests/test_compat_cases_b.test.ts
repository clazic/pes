// E06·E07·E10~E12 (reports, reads, lock, moved copy, broken/large file) on the 0.15 target: the record must equal the pinned baseline (tests/fixtures/compat/baseline/<id>.json).
// PES_COMPAT_TARGET=ts runs the same cases on the TS target (not_yet today — see test_compat_harness.test.ts).
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
