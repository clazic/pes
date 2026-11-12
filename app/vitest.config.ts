import { mergeConfig } from "vite";
import { defineConfig } from "vitest/config";
import viteConfig from "./vite.config";

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: "jsdom",
      // SEL-122: 실제 계정 홈에서 시작하면 시험 전에 거절(루트와 같은 판정)
      globalSetup: ["./vitest.global-setup.ts"],
      setupFiles: ["./vitest.setup.ts"],
      include: ["src/**/*.test.{ts,tsx}"],
      // 한 파일이 macOS 에서 30초를 넘기지 않는다(Windows 는 3~10배 느림)
      testTimeout: 20_000,
    },
  }),
);
