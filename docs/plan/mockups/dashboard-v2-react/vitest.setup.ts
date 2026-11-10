// Vitest에서 jest-dom matcher(`toBeInTheDocument` 등)를 등록한다.
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// vitest `globals`를 켜지 않으므로 Testing Library의 자동 정리를 직접 건다.
afterEach(() => {
  cleanup();
});
