// SEL-81 U1a (R1 권장 11) — 쓰지 않는 의존성을 두지 않는다(공급망·크기). 쓰는 이슈에서 넣는다.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const appDir = join(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(appDir, "package.json"), "utf8")) as { dependencies: Record<string, string> };

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const product = walk(join(appDir, "src")).filter((p) => /\.(ts|tsx|css)$/.test(p) && !/\.test\.(ts|tsx)$/.test(p) && !/[\\/]test[\\/]/.test(p));
const text = product.map((p) => readFileSync(p, "utf8")).join("\n") + "\n" + readFileSync(join(appDir, "index.html"), "utf8");

describe("package.json dependencies", () => {
  for (const name of Object.keys(pkg.dependencies)) {
    it(`${name} 는 src 어딘가에서 쓰인다`, () => {
      const esc = name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
      expect(new RegExp(`["']${esc}(["'/])`).test(text), `${name} 를 가져오는 곳이 없다 — 쓰는 이슈(U1c 명령 찾기=cmdk · 토스트=sonner 등)에서 넣는다`).toBe(true);
    });
  }
});
