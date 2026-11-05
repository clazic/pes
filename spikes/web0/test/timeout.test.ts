import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { SqliteDb } from "../ts-core/sqlite-adapter.ts";
import { runRound } from "../ts-core/scenario.ts";
import { DDL } from "./helpers.ts";

async function hangingServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(() => {
    // Accept the request and never write a response.
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listen failed");
  return {
    url: `http://127.0.0.1:${address.port}/inference/v1/chat/completions`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("scenario Go call has a finite timeout and releases the DB/server", async () => {
  const hanging = await hangingServer();
  const db = new SqliteDb(":memory:");
  try {
    await db.exec(DDL);
    await assert.rejects(
      runRound(db, { fakeGoUrl: hanging.url, goTimeoutMs: 100 }),
      (error: unknown) => /timeout|abort/i.test(String(error)),
    );
  } finally {
    db.close();
    await hanging.close();
  }
});
