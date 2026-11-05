// node:sqlite adapter used by the VPS proxy and by local tests.

import { DatabaseSync } from "node:sqlite";
import type { Db, SqlStatement, SqlValue } from "./db.ts";

export interface MigratableDb extends Db {
  exec(sql: string): Promise<void>;
  close(): void;
}

export class SqliteDb implements MigratableDb {
  readonly #db: DatabaseSync;

  constructor(filename = ":memory:") {
    this.#db = new DatabaseSync(filename);
    this.#db.exec("PRAGMA foreign_keys = ON");
    this.#db.exec("PRAGMA busy_timeout = 5000");
    if (filename !== ":memory:") this.#db.exec("PRAGMA journal_mode = WAL");
  }

  async exec(sql: string): Promise<void> {
    this.#db.exec(sql);
  }

  async all<T = Record<string, unknown>>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    return this.#db.prepare(sql).all(...params) as T[];
  }

  async run(sql: string, params: SqlValue[] = []): Promise<number> {
    const result = this.#db.prepare(sql).run(...params);
    return Number(result.changes);
  }

  async batch(statements: SqlStatement[]): Promise<number[]> {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const changes: number[] = [];
      for (const [index, statement] of statements.entries()) {
        try {
          const result = this.#db.prepare(statement.sql).run(...(statement.params ?? []));
          changes.push(Number(result.changes));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`${message} (batch index ${index}: ${statement.sql.slice(0, 80)})`);
        }
      }
      this.#db.exec("COMMIT");
      return changes;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.#db.close();
  }
}
