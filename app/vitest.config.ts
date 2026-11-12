// SEL-122: 설정 평가 단계에서 거절한다 — globalSetup 은 시험 파일 탐색 뒤라 늦다(리뷰 필수 1). 루트 판정을 그대로 쓴다(문자열만 비교).
import { assert_temp_home_env } from "../tests/helpers/temp_home_check.ts";
import { mergeConfig } from "vite";
import { defineConfig } from "vitest/config";
import viteConfig from "./vite.config";

assert_temp_home_env();

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: "jsdom",
      // 이중 안전: 설정 평가 때 이미 거절했다
      globalSetup: ["./vitest.global-setup.ts"],
      setupFiles: ["./vitest.setup.ts"],
      include: ["src/**/*.test.{ts,tsx}"],
      // 한 파일이 macOS 에서 30초를 넘기지 않는다(Windows 는 3~10배 느림)
      testTimeout: 20_000,
    },
  }),
);
