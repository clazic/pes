// SEL-103 — the first thing every test-file process runs: `node --import ./tests/helpers/require_temp_home.ts --test …` (package.json "test", the CI test step).
// A run that starts in the real account home fails here, before any module of the tests is loaded and before the home guard lists anything.
// The same check is the first import of home_guard.ts, so a file started by hand without --import is covered too. Strings only — see temp_home_check.ts.
import { assert_temp_home_env } from "./temp_home_check.ts";

assert_temp_home_env();
