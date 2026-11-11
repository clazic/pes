// 설정이 만든 임시 홈(playwright.config.ts)을 지운다 — 시험 실행마다 폴더가 쌓이지 않게
import { rmSync } from "node:fs";

export default function globalTeardown() {
  const home = process.env.PES_APP_E2E_HOME;
  if (home && /pes-app-e2e-/.test(home)) rmSync(home, { recursive: true, force: true });
}
