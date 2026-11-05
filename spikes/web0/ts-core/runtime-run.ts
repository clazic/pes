// Same TS core on Bun/Deno. Reads the DDL path and fake Go URL from argv.
// Used only by the WEB0 measurement; not product code.

import { readFileSync } from "node:fs";
import { SqliteDb } from "./sqlite-adapter.ts";
import { runRound } from "./scenario.ts";

const fakeGoUrl = process.argv[2];
const ddlPath = process.argv[3];
if (!fakeGoUrl || !ddlPath) {
  console.error("usage: runtime-run.ts <fake-go-url> <ddl-path>");
  process.exit(2);
}
const ddl = readFileSync(ddlPath, "utf8");
const db = new SqliteDb(":memory:");
await db.exec(ddl);
const stats = await runRound(db, { fakeGoUrl });
db.close();
console.log(JSON.stringify(stats));
