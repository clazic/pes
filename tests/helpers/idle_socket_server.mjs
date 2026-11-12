// SEL-103 fixture (used by test_sel103_idle_socket.test.ts): a tiny HTTP/1.1 server on raw sockets. It sends no `Keep-Alive` hint (so fetch/undici keeps a
// socket for its default 4 s), optionally closes an idle connection (SEL103_IDLE_MS, default off), honours `connection: close`, answers /whoami like
// scripts/serve.ts (TsServeProcess' readiness probe), /_stats with its counters ({connections, requests, log}) and anything else with "ok".
// A second request on the SAME connection is answered with a reset (no response): what a client sees when it reuses a socket the server has already
// closed (the SEL-95 flake — whether the server's own idle timer wins that race depends on the machine's timing; here it is deterministic). `reused` in
// /_stats counts them. SEL103_RESET_ON_REUSE=0 turns that off.
// argv: <root> <port>. Synthetic; touches no file.
import net from "node:net";
const root = process.argv[2];
const port = Number(process.argv[3]);
const idle = Number(process.env.SEL103_IDLE_MS || "0"); // > 0: also close a connection after that many ms of silence
const reset_on_reuse = process.env.SEL103_RESET_ON_REUSE !== "0";
let connections = 0;
let requests = 0;
let reused = 0;
const log = [];
net.createServer((socket) => {
  connections += 1;
  let buf = Buffer.alloc(0);
  let served = 0;
  if (idle > 0) socket.setTimeout(idle, () => socket.destroy());
  socket.on("error", () => {});
  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      const head = buf.subarray(0, end).toString("latin1");
      const m = /content-length:\s*(\d+)/i.exec(head);
      const len = m ? Number(m[1]) : 0;
      if (buf.length < end + 4 + len) return;
      const [method, path] = head.split("\r\n")[0].split(" ");
      buf = buf.subarray(end + 4 + len);
      requests += 1;
      log.push(method + " " + path);
      served += 1;
      if (served > 1) {
        reused += 1;
        if (reset_on_reuse) {
          socket.resetAndDestroy();
          return;
        }
      }
      const close = /^connection:\s*close/im.test(head);
      let body = "ok";
      let type = "text/plain";
      if (path === "/whoami") { body = JSON.stringify({ single: true, root }); type = "application/json"; }
      if (path === "/_stats") { body = JSON.stringify({ connections, requests, reused, log }); type = "application/json"; }
      socket.write("HTTP/1.1 200 OK\r\ncontent-type: " + type + "\r\ncontent-length: " + Buffer.byteLength(body) + "\r\n" + (close ? "connection: close\r\n" : "") + "\r\n" + body);
      if (close) socket.end();
    }
  });
}).listen(port, "127.0.0.1");
