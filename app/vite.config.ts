import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * 서버(scripts/serve.ts)는 앱 화면 주소 `/p/<slug>/…` 에서 앱의 index.html 을 내주고, 빌드 파일은 `/_app/…` 에서 내준다 → base "/_app/"(프로젝트 이름은 `_` 로 시작할 수 없어 어떤 프로젝트 쪽도 가리지 않는다).
 * 새 프로젝트 화면 `/new`(끝 / 있든 없든, 그 아래는 아님)도 같다(SEL-114 — 서버는 `new` 프로젝트가 따로 있으면 그쪽을 우선한다).
 * 개발·미리보기 서버도 같게 `/p/…` · `/new` 를 앱 index.html 로 되돌린다(주소창의 주소는 그대로 — 앱 라우터가 읽는다).
 */
const appAddress = (): Plugin => {
  const rewrite = (req: { url?: string; method?: string }, _res: unknown, next: () => void) => {
    if ((req.method === "GET" || req.method === "HEAD") && /^(\/p\/|\/new\/?(\?|#|$))/.test(req.url ?? "")) req.url = "/_app/index.html";
    next();
  };
  return {
    name: "pes-app-address",
    configureServer: (server) => void server.middlewares.use(rewrite),
    configurePreviewServer: (server) => void server.middlewares.use(rewrite),
  };
};

// window.__PES_APP__ 설정(열어 준 쪽이 넘긴 세션)이 있을 때만 서버 API 를 읽는다. 앱 안 가짜 클라이언트(합성 fixture)는 production 이 아닌 모드(dev·vitest·--mode e2e)만(U1b, src/api/select-client.ts).
export default defineConfig({
  base: "/_app/",
  plugins: [react(), tailwindcss(), appAddress()],
  resolve: { alias: { "@": path.resolve(here, "./src") } },
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
  // PES_E2E_PORT: 앱 e2e(playwright.config.ts)가 고른 빈 포트. 없으면 4173(손으로 `npm run preview` 할 때)
  preview: { host: "127.0.0.1", port: Number(process.env.PES_E2E_PORT) || 4173, strictPort: true },
  build: { sourcemap: false, chunkSizeWarningLimit: 900 },
});
