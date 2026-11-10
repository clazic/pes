// Short read-only transaction for multi-SELECT reads (API context, version).
//
// A deferred BEGIN takes its snapshot at the first SELECT and holds it until
// COMMIT, so every read inside sees one database state while other
// connections may keep committing (WAL). It never takes the write lock. The
// callback must be synchronous: no waiting and no file I/O inside.

import type { Db } from "../db.ts";

export function read_tx<T>(db: Db, fn: () => T extends PromiseLike<unknown> ? never : T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // keep the original failure
    }
    throw error;
  }
}
