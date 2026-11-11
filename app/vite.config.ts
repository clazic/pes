import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));

// 자료는 앱 안 가짜 클라이언트(합성 fixture)뿐이다 — 네트워크 호출 없음(U1a). 서버 연결은 U1b.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(here, "./src") } },
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
  preview: { host: "127.0.0.1", port: 4173, strictPort: true },
  build: { sourcemap: false, chunkSizeWarningLimit: 900 },
});
