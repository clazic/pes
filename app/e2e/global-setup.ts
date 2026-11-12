// SEL-122 — 앱 Playwright 시작 전 판정(playwright.config.ts 와 같은 판정). 실제 계정 홈에서 시작하면 스펙을 하나도 열지 않고 거절한다.
// 앱 e2e 는 홈 목록을 훑지 않으므로(루트 home_guard.ts 와 달리) 판정만 한다.
import { assert_temp_home_env } from "../../tests/helpers/temp_home_check.ts";

export default function globalSetup(): void {
  assert_temp_home_env();
}
