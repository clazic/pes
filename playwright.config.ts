// Playwright smoke for the local screens (stage 2 PR18, SEL-51). Only tests/e2e/*.spec.ts run here;
// `npm test` (node --test "tests/**/*.test.ts") never sees them.
//
// A missing browser must FAIL the run, never skip it (CI contract; Windows CI installs it):
//   npx playwright install chromium   (Linux CI: add --with-deps)
//   npx playwright test
import { defineConfig } from "@playwright/test";

import { assert_temp_home_env } from "./tests/helpers/temp_home_check.ts";

// SEL-103: a run that starts in the real account home is refused before any spec is loaded (and before the globalSetup lists anything) — strings only, no fs
// call on the home. Run it with a temporary HOME / USERPROFILE (see tests/README.md); the browser cache then needs PLAYWRIGHT_BROWSERS_PATH.
assert_temp_home_env();

export default defineConfig({
  testDir: "tests/e2e",
  globalSetup: "./tests/e2e/helpers/home_guard.ts",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  reporter: [["list"]],
  use: {
    browserName: "chromium",
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    trace: "off",
    screenshot: "off",
    video: "off",
  },
});
