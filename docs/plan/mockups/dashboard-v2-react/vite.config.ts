import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { liveEdit } from "./live-edit/plugin";

const here = path.dirname(fileURLToPath(import.meta.url));

// 시안 전용 설정. 실제 PES에서는 로컬 PES 서버(또는 5단계 웹)가 dist/를 정적으로 내준다.
// 이 시안은 네트워크 호출이 없다(목 클라이언트만).
export default defineConfig({
  // liveEdit: 개발 서버 전용(화면에서 눌러 고칠 곳을 적으면 Claude가 고친다). 빌드에는 들어가지 않는다.
  plugins: [react(), tailwindcss(), liveEdit(here)],
  resolve: {
    alias: { "@": path.resolve(here, "./src") },
  },
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
  preview: { host: "127.0.0.1" },
  build: { sourcemap: false, chunkSizeWarningLimit: 900 },
});
