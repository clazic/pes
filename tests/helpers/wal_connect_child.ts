// Child-process entry point for the WAL-switch busy tests. It uses only the
// isolated environment it is given, connects with an optional retry budget
// (argv[2]), and prints one JSON result line.

import { connect } from "../../scripts/pes_core/db.ts";
import { db_path } from "../../scripts/pes_core/paths.ts";

const budget_argument = process.argv[2];
const options =
  budget_argument === undefined ? {} : { wal_busy_timeout_ms: Number(budget_argument) };

let db: ReturnType<typeof connect> | undefined;
const started = Date.now();
try {
  db = connect(db_path(process.env), options);
  const row = db.get<{ journal_mode: string }>("PRAGMA journal_mode");
  process.stdout.write(
    `${JSON.stringify({ journal_mode: row?.journal_mode, waited_ms: Date.now() - started })}\n`,
  );
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
      cause:
        error instanceof Error && error.cause instanceof Error ? error.cause.message : undefined,
      waited_ms: Date.now() - started,
    })}\n`,
  );
  process.exitCode = 1;
} finally {
  db?.close();
}
