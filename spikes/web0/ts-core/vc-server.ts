// Local stand-in for a Vercel Node function process. Binds 127.0.0.1 only.

import { createServer } from "node:http";
import { closePool, preparePool, handler } from "./vc-handler.ts";

const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (key && value) args.set(key, value);
}

const ddlPath = args.get("--ddl");
const fakeGoUrl = args.get("--fake-go");
const poolSize = Number(args.get("--pool") ?? "20");
if (!ddlPath || !fakeGoUrl) {
  console.error("usage: vc-server.ts --ddl <path> --fake-go <url> [--pool N]");
  process.exit(2);
}

const state = await preparePool(poolSize, ddlPath);
state.fakeGoUrl = fakeGoUrl;
const server = createServer((request, response) => {
  void handler(state)(request, response);
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") {
    console.error("listen failed");
    process.exit(1);
  }
  console.log(JSON.stringify({ ready: true, port: address.port }));
});

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  await closePool(state).catch(() => undefined);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
