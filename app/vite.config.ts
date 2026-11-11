import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * 서버(scripts/serve.ts)는 앱 화면 주소 `/p/<slug>/…` 에서 앱의 index.html 을 내주고, 빌드 파일은 `/app/…` 에서 내준다 → base "/app/".
 * 개발·미리보기 서버도 같게 `/p/…` 를 앱 index.html 로 되돌린다(주소창의 `/p/…` 는 그대로 — 앱 라우터가 읽는다).
 */
const appAddress = (): Plugin => {
  const rewrite = (req: { url?: string; method?: string }, _res: unknown, next: () => void) => {
    if ((req.method === "GET" || req.method === "HEAD") && /^\/p\//.test(req.url ?? "")) req.url = "/app/index.html";
    next();
  };
  return {
    name: "pes-app-address",
    configureServer: (server) => void server.middlewares.use(rewrite),
    configurePreviewServer: (server) => void server.middlewares.use(rewrite),
  };
};

// 자료는 기본이 앱 안 가짜 클라이언트(합성 fixture)다. window.__PES_APP__ 설정이 있을 때만 서버 API 를 읽는다(U1b, src/api/select-client.ts).
export default defineConfig({
  base: "/app/",
  plugins: [react(), tailwindcss(), appAddress()],
  resolve: { alias: { "@": path.resolve(here, "./src") } },
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
  preview: { host: "127.0.0.1", port: 4173, strictPort: true },
  build: { sourcemap: false, chunkSizeWarningLimit: 900 },
});
