// SEL-116 — run by tests/test_sel116_transient.test.ts under `node --permission` WITHOUT --allow-worker: the real POST /file-extractions
// in a computer that allows no worker thread. Prints one JSON line: the HTTP status, error code/reason/retryable, and the row counts
// (extractions, commits, events) before and after. Everything is written to the temporary directory only.

import { with_api } from "./api_env.ts";
import { count, extract, material_of } from "./sel116_env.ts";

await with_api(async (env) => {
  const m = await material_of(env, "허용안함.txt", new TextEncoder().encode("hello\n"));
  const tables = ["file_extractions", "mutation_commits", "events"];
  const counts = (): number[] => tables.map((table) => count(env.db, table));
  const before = counts();
  const res = await extract(env, m, "owner", "permission-key-1");
  const res2 = await extract(env, m, "owner", "permission-key-2");
  const error = res.json.error ?? null;
  process.stdout.write(
    `${JSON.stringify({
      status: res.status,
      status2: res2.status,
      code: error?.code ?? null,
      reason: error?.details?.reason ?? null,
      retryable: error?.retryable ?? null,
      before,
      after: counts(),
    })}\n`,
  );
});
