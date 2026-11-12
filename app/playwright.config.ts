// SEL-81 U1a — 앱 e2e (루트 playwright.config.ts 와 별개: 루트 CI 의 `npx playwright test` 는 tests/e2e 만 돈다).
// 실행: cd app && npm ci && npx playwright install chromium && npm run test:e2e
// SEL-122: 실제 계정 홈에서는 거절한다. 임시 HOME·USERPROFILE 과 HOME 밖 브라우저 폴더로 돌린다(<브라우저 폴더> 는 고정 폴더 경로로 바꾼다):
//   export PLAYWRIGHT_BROWSERS_PATH="<브라우저 폴더>"   # 처음 한 번: npx playwright install chromium
//   tmp_home="$(mktemp -d)"; HOME="$tmp_home" USERPROFILE="$tmp_home" npm run test:e2e
// 앱 Vitest 도 같은 방식: HOME="$tmp_home" USERPROFILE="$tmp_home" npx vitest run
// 빌드한 앱(vite preview)을 127.0.0.1:<PES_E2E_PORT> 에 띄운다(env 가 없으면 빈 포트를 한 번 골라 env 에 넣는다 — 워커·설정 재로드가 같은 값을 물려받고, worktree 둘이 동시에 돌아도 부딪히지 않는다). 이 e2e 는 가짜 클라이언트(합성 자료)를 기본으로 쓰는 "시험 모드" 빌드(--mode e2e)를 별도 폴더(dist-e2e)에 만들어 연다 —
// production 빌드(app/dist)는 세션 조각이 없으면 가짜 자료 대신 `pes open` 안내만 그린다(SEL-82 R1 필수 1, 루트 tests/e2e/app_real_api.spec.ts 가 그쪽을 못 박는다).
// 폴더를 나누는 이유: 루트 시험이 읽는 app/dist(production)를 이 e2e 가 시험 모드 빌드로 덮어쓰지 않게. 실제 홈·실제 자료는 읽지 않는다(앱은 가짜 클라이언트만 쓴다) —
// 그래도 자식 프로세스의 HOME·USERPROFILE·PES_HOME 은 임시 폴더로 바꿔 둔다.
// 브라우저가 없으면 건너뛰지 않고 실패한다(CI 계약).
import { assert_temp_home_env } from "../tests/helpers/temp_home_check.ts";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

// SEL-122: 실제 계정 홈에서 시작하면 설정을 읽은 바로 뒤, 빈 포트를 고르거나 임시 폴더를 만들기 전에 거절한다(문자열만 비교 — 루트 playwright.config.ts 와 같다)
assert_temp_home_env();

// 임시 홈은 주 프로세스에서 한 번만 만든다(워커·설정 재로드는 환경변수로 물려받음) — 끝나면 globalTeardown 이 지운다
process.env.PES_APP_E2E_HOME ??= mkdtempSync(join(tmpdir(), "pes-app-e2e-"));
const home = process.env.PES_APP_E2E_HOME;

// 포트: PES_E2E_PORT 가 있으면 그 값, 없으면 OS 가 비워 둔 빈 포트를 한 번 골라 PES_E2E_PORT 에 넣는다(주 프로세스가 워커보다 먼저 평가되므로 모두 같은 값을 본다).
// 설정은 동기로 평가돼야 해서 빈 포트 조회는 자식 node 로 한다(vite preview 가 같은 env 를 읽는다 — vite.config.ts).
function pickFreePort(): string {
  const r = spawnSync(
    process.execPath,
    ["-e", "const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close()})"],
    { encoding: "utf8", timeout: 10_000 },
  );
  const port = r.stdout.trim();
  if (!/^\d+$/.test(port)) throw new Error(`빈 포트를 고르지 못했다: ${r.stderr || r.error || r.status}`);
  return port;
}
const given = process.env.PES_E2E_PORT;
if (given !== undefined && given !== "" && !(/^\d+$/.test(given) && Number(given) >= 1 && Number(given) <= 65535)) {
  throw new Error(`PES_E2E_PORT 는 1~65535 정수여야 한다: ${given}`);
}
// 정수로 정규화한다("056349" → "56349"): vite 는 Number(env) 로 바인딩하고 "Local: http://127.0.0.1:56349/" 로 찍으므로, 앞자리 0 이 있는 문자열을
// wait.stdout·baseURL·env 에 그대로 쓰면 준비 완료 줄을 영원히 못 찾아 240초 뒤 시간 초과가 난다(SEL-96 최종 리뷰 2/2). 모두 같은 정규화 값을 쓴다.
process.env.PES_E2E_PORT = given ? String(Number(given)) : pickFreePort();
const port = process.env.PES_E2E_PORT;
const origin = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.spec.ts",
  globalSetup: "./e2e/global-setup.ts",
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
    // 준비 완료는 URL 응답이 아니라 "이번에 띄운 vite preview 가 이 포트에 바인딩했다고 찍는 줄"로만 판단한다(SEL-96 최종 리뷰 1/2).
    // URL 응답을 쓰면 빌드 중에 다른 프로세스가 그 포트를 잡았을 때 그 서버의 200 을 받아 엉뚱한 서버를 시험하고 성공한다.
    // vite preview 는 strictPort 라 포트가 이미 쓰이면 바인딩에 실패하고 종료하므로 Playwright 가 "not able to start" 로 실패한다.
    // (url 이 없으면 시작 전 포트 점검도 없다 — 이미 쓰는 포트는 위 바인딩 실패가 같은 결과로 잡는다.)
    wait: { stdout: new RegExp(`Local:\\s+http://127\\.0\\.0\\.1:${port}/`) },
    timeout: 240_000,
    env: { HOME: home, USERPROFILE: home, PES_HOME: join(home, "pes-projects"), PES_E2E_PORT: port },
  },
  use: {
    baseURL: origin,
    browserName: "chromium",
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    trace: "off",
    screenshot: "off",
    video: "off",
  },
});
