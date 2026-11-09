// 라이브 편집 — 개발 서버에서만 켜진다(`vite build`에는 들어가지 않는다).
// 화면에서 요소를 누르고 "어떻게 바꿀지" 적으면 요청이 파일 한 줄(JSON)로 쌓이고,
// Claude가 그 파일을 지켜보다가 소스를 고친다. 고친 결과는 HMR로 바로 보인다.
// 요청 파일: node_modules/.live-edit/requests.jsonl (git에 들어가지 않음)
// 반영 표시: node_modules/.live-edit/done.jsonl 에 {"id": n, "note": "..."} 한 줄
import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

export function liveEdit(root: string): Plugin {
  const dir = path.join(root, "node_modules", ".live-edit");
  const reqFile = path.join(dir, "requests.jsonl");
  const doneFile = path.join(dir, "done.jsonl");
  const clientFile = path.join(root, "live-edit", "client.js");

  const readLines = (f: string) =>
    fs.existsSync(f)
      ? fs
          .readFileSync(f, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => {
            try {
              return JSON.parse(l);
            } catch {
              return null;
            }
          })
          .filter(Boolean)
      : [];

  return {
    name: "pes-live-edit",
    apply: "serve",
    configureServer(server) {
      fs.mkdirSync(dir, { recursive: true });
      server.middlewares.use("/__live-edit", (req, res) => {
        if (req.method === "POST") {
          let body = "";
          req.on("data", (c) => (body += c));
          req.on("end", () => {
            try {
              const data = JSON.parse(body);
              const id = readLines(reqFile).length + 1;
              const line = { id, at: new Date().toISOString(), ...data };
              fs.appendFileSync(reqFile, JSON.stringify(line) + "\n");
              server.config.logger.info(`[live-edit] #${id} ${String(data.note).slice(0, 60)}`);
              res.setHeader("content-type", "application/json");
              res.end(JSON.stringify({ id }));
            } catch {
              res.statusCode = 400;
              res.end("bad request");
            }
          });
          return;
        }
        // GET: 요청과 반영 상태
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            requests: readLines(reqFile).map((r: { id: number; note: string }) => ({ id: r.id, note: r.note })),
            done: readLines(doneFile),
          }),
        );
      });
    },
    transformIndexHtml() {
      return [
        {
          tag: "script",
          attrs: { type: "module" },
          children: fs.readFileSync(clientFile, "utf8"),
          injectTo: "body",
        },
      ];
    },
  };
}
