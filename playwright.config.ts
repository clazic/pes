// Playwright smoke for the local screens (stage 2 PR18, SEL-51). Only tests/e2e/*.spec.ts run here;
// `npm test` (node --test "tests/**/*.test.ts") never sees them.
//
// A missing browser must FAIL the run, never skip it (CI contract; Windows CI installs it):
//   npx playwright install chromium   (Linux CI: add --with-deps)
//   npx playwright test
import { defineConfig } from "@playwright/test";

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
