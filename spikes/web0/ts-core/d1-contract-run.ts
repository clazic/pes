// `npm run test:d1`: run the shared contract suite against local D1 (wrangler dev).
// Local only; no Cloudflare account or deploy.

import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { applyDdl, cleanupDir, freePort, startWranglerDev } from "./wrangler.ts";
import type { ContractResult } from "./contract-suite.ts";

const DDL_PATH = fileURLToPath(
  new URL("../../../docs/plan/schemas/stage-1-ddl-draft.sql", import.meta.url),
);
const OUT = fileURLToPath(new URL("./out/", import.meta.url));
const persistDir = join(OUT, "d1-contract-state");

mkdirSync(OUT, { recursive: true });
applyDdl(persistDir, DDL_PATH);
const port = await freePort();
const dev = await startWranglerDev({ persistDir, fakeGoUrl: "http://127.0.0.1:9/disabled", port });
try {
  const response = await fetch(`${dev.url}/api/v1/_spike/contract`, {
    method: "POST",
    body: "{}",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(60000),
  });
  const text = await response.text();
  if (response.status !== 200) throw new Error(`contract failed ${response.status}: ${text.slice(0, 500)}`);
  const parsed = JSON.parse(text) as { result: ContractResult };
  const failures = parsed.result.checks.filter((check) => check.status === "fail");
  console.log(
    JSON.stringify(
      {
        tables: parsed.result.tables,
        checks: parsed.result.checks.length,
        failures,
        unsupportedSql: parsed.result.unsupportedSql,
        ddlBytes: readFileSync(DDL_PATH).byteLength,
      },
      null,
      2,
    ),
  );
  process.exitCode = failures.length === 0 && parsed.result.tables === 61 ? 0 : 1;
} finally {
  await dev.stop();
  cleanupDir(persistDir);
}
