// SEL-81 U1a — 앱 e2e (루트 playwright.config.ts 와 별개: 루트 CI 의 `npx playwright test` 는 tests/e2e 만 돈다).
// 실행: cd app && npm ci && npx playwright install chromium && npm run test:e2e
// 빌드한 앱(vite preview)을 127.0.0.1:4173 에 띄운다. 실제 홈·실제 자료는 읽지 않는다(앱은 가짜 클라이언트만 쓴다) —
// 그래도 자식 프로세스의 HOME·USERPROFILE·PES_HOME 은 임시 폴더로 바꿔 둔다.
// 브라우저가 없으면 건너뛰지 않고 실패한다(CI 계약).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

const home = mkdtempSync(join(tmpdir(), "pes-app-e2e-"));

export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  reporter: [["list"]],
  webServer: {
    command: "npm run build && npm run preview",
    url: "http://127.0.0.1:4173/",
    reuseExistingServer: false,
    timeout: 240_000,
    env: { HOME: home, USERPROFILE: home, PES_HOME: join(home, "pes-projects") },
  },
  use: {
    baseURL: "http://127.0.0.1:4173",
    browserName: "chromium",
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    trace: "off",
    screenshot: "off",
    video: "off",
  },
});
