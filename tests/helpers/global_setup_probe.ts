// SEL-103 probe, run only as a CHILD of test_sel103_no_account_listing (`node tests/helpers/global_setup_probe.ts`): runs the Playwright globalSetup (and its
// teardown) of tests/e2e/helpers/home_guard.ts by hand.
import global_setup from "../e2e/helpers/home_guard.ts";

const teardown = await global_setup();
await teardown();
console.log("SETUP-RAN");
