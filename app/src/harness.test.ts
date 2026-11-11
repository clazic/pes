// SEL-81 U1a — 앱 폴더 하네스·위생 (Vitest, node 기능 사용). lint·typecheck 명령, 고정 버전, 네트워크·실제 자료 위생.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const appDir = join(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(appDir, "package.json"), "utf8")) as { scripts: Record<string, string>; dependencies: Record<string, string>; devDependencies: Record<string, string> };

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const isProductSource = (p: string) => /\.(ts|tsx|css|html)$/.test(p) && !/\.test\.(ts|tsx)$/.test(p) && !relative(appDir, p).split(sep).includes("test") && !relative(appDir, p).startsWith(`e2e${sep}`) && !/(^|[\\/])(vite|vitest|playwright)\.config\.ts$|vitest\.setup\.ts$/.test(p);

describe("명령", () => {
  it("lint·typecheck·test·test:e2e·build 가 있다", () => {
    for (const k of ["lint", "typecheck", "test", "test:e2e", "build"]) expect(pkg.scripts[k], k).toBeTruthy();
    expect(pkg.scripts.lint).toMatch(/\bsrc\b/);
    expect(pkg.scripts.typecheck).toMatch(/tsc/);
    expect(pkg.scripts["test:e2e"]).toMatch(/playwright/);
  });
  it("스택: React 19 · Vite · TS · Tailwind 4 · React Router · TanStack Query · Vitest · Testing Library · Playwright, shadcn 바탕(radix-ui)", () => {
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const d of ["react", "react-dom", "vite", "typescript", "tailwindcss", "react-router", "@tanstack/react-query", "vitest", "@testing-library/react", "@playwright/test", "radix-ui", "class-variance-authority"]) expect(all[d], d).toBeTruthy();
    expect(all.react).toMatch(/^19\./);
    expect(all.tailwindcss).toMatch(/^4\./);
  });
  it("모든 의존성 버전이 정확히 고정이다(^ ~ * latest 없음)", () => {
    for (const [n, v] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) expect(v, n).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("위생", () => {
  const files = walk(join(appDir, "src")).filter(isProductSource);
  it("제품 소스가 있다(빈 골격이 아님)", () => {
    expect(files.some((f) => /app[\\/]routes\.tsx?$/.test(f))).toBe(true);
  });
  it("네트워크 호출 코드는 HTTP 클라이언트(src/api/http-client.ts) 한 곳에만 있다(U1b) — XMLHttpRequest·WebSocket·EventSource·sendBeacon 은 어디에도 없고, 외부 주소도 없다", () => {
    const ts = files.filter((p) => /\.(ts|tsx)$/.test(p));
    for (const f of ts) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toMatch(/XMLHttpRequest|new\s+WebSocket|new\s+EventSource|sendBeacon/);
      if (!/api[\\/]http-client\.tsx?$/.test(f)) expect(text, f).not.toMatch(/\bfetch\s*\(/);
    }
    for (const f of files) expect(readFileSync(f, "utf8"), f).not.toMatch(/https?:\/\/(?!www\.w3\.org|localhost|127\.0\.0\.1)/);
  });
  it("실제 홈·절대경로·세션 ID·키가 없다", () => {
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toMatch(/\/Users\/|\/home\/[a-z]|[A-Z]:\\\\?Users|~\/\.pes|pes-projects|sk-[A-Za-z0-9]{20}/);
    }
  });
});
