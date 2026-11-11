import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
  try {
    window.sessionStorage.clear();
  } catch {
    /* 저장소를 못 쓰는 환경 */
  }
});
