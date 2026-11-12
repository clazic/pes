// SEL-122 — 앱 Vitest 시작 전 판정. 실제 계정 홈에서 시작하면 시험을 하나도 돌리지 않고 거절한다.
// 판정은 루트 tests/helpers/temp_home_check.ts 를 그대로 쓴다(문자열만 비교, 파일 시스템 접근 없음).
import { assert_temp_home_env } from "../tests/helpers/temp_home_check.ts";

export default function globalSetup(): void {
  assert_temp_home_env();
}
