import { mergeConfig } from "vite";
import { defineConfig } from "vitest/config";
import viteConfig from "./vite.config";

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: "jsdom",
      setupFiles: ["./vitest.setup.ts"],
      include: ["src/**/*.test.{ts,tsx}"],
      // 한 파일이 macOS 에서 30초를 넘기지 않는다(Windows 는 3~10배 느림)
      testTimeout: 20_000,
    },
  }),
);
