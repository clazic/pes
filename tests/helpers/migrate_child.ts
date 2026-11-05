// Child-process entry point for concurrent migrate tests. It uses only the
// isolated environment it is given and prints one JSON result line.

import { connect, migrate } from "../../scripts/pes_core/db.ts";
import { db_path } from "../../scripts/pes_core/paths.ts";

let db: ReturnType<typeof connect> | undefined;
try {
  db = connect(db_path(process.env));
  const result = migrate(db);
  process.stdout.write(
    `${JSON.stringify({
      applied: result.applied,
      schema_version: result.schema_version.toString(),
    })}\n`,
  );
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`,
  );
  process.exitCode = 1;
} finally {
  db?.close();
}
