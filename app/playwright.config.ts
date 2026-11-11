// SEL-81 U1a — 앱 e2e (루트 playwright.config.ts 와 별개: 루트 CI 의 `npx playwright test` 는 tests/e2e 만 돈다).
// 실행: cd app && npm ci && npx playwright install chromium && npm run test:e2e
// 빌드한 앱(vite preview)을 127.0.0.1:4173 에 띄운다. 이 e2e 는 가짜 클라이언트(합성 자료)를 기본으로 쓰는 "시험 모드" 빌드(--mode e2e)를 별도 폴더(dist-e2e)에 만들어 연다 —
// production 빌드(app/dist)는 세션 조각이 없으면 가짜 자료 대신 `pes open` 안내만 그린다(SEL-82 R1 필수 1, 루트 tests/e2e/app_real_api.spec.ts 가 그쪽을 못 박는다).
// 폴더를 나누는 이유: 루트 시험이 읽는 app/dist(production)를 이 e2e 가 시험 모드 빌드로 덮어쓰지 않게. 실제 홈·실제 자료는 읽지 않는다(앱은 가짜 클라이언트만 쓴다) —
// 그래도 자식 프로세스의 HOME·USERPROFILE·PES_HOME 은 임시 폴더로 바꿔 둔다.
// 브라우저가 없으면 건너뛰지 않고 실패한다(CI 계약).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

// 임시 홈은 주 프로세스에서 한 번만 만든다(워커·설정 재로드는 환경변수로 물려받음) — 끝나면 globalTeardown 이 지운다
process.env.PES_APP_E2E_HOME ??= mkdtempSync(join(tmpdir(), "pes-app-e2e-"));
const home = process.env.PES_APP_E2E_HOME;

export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.spec.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  reporter: [["list"]],
  webServer: {
    command: "npm run build -- --mode e2e --outDir dist-e2e && npm run preview -- --outDir dist-e2e",
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
