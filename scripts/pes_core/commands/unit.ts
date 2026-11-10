// One CLI call as one all-or-nothing unit (stage 2 PR15).
//
// Lives in commands/ because it executes transaction statements on the database;
// the CLI bridge (outside commands/) only calls unit() and never touches SQL.

import type { StatementSync } from "node:sqlite";

import type { Db, RunResult, SqlValue } from "../db.ts";
import { ApiError } from "../errors.ts";

/**
 * One CLI call is one all-or-nothing unit even when it takes several core
 * commands (merge, approve plan's hand-over, init + library). The core's own
 * tx() refuses nested transactions, so while a unit is open the commands'
 * BEGIN IMMEDIATE / COMMIT / ROLLBACK become SAVEPOINT / RELEASE / ROLLBACK TO
 * inside one outer transaction. Each command is still one service.execute with
 * its own receipt; a failure anywhere rolls back every command of the unit.
 */
export class UnitOfWorkDb implements Db {
  readonly path: string;
  readonly #inner: Db;
  readonly #savepoints: string[] = [];
  #open = false;
  #seq = 0;

  constructor(inner: Db) {
    this.path = inner.path;
    this.#inner = inner;
  }

  exec(sql: string): void {
    if (this.#open) {
      if (sql === "BEGIN IMMEDIATE") {
        const name = `pes_unit_${(this.#seq += 1)}`;
        this.#inner.exec(`SAVEPOINT ${name}`);
        this.#savepoints.push(name);
        return;
      }
      if (sql === "COMMIT") {
        const name = this.#savepoints.pop();
        if (name === undefined) throw new Error("no open savepoint");
        this.#inner.exec(`RELEASE ${name}`);
        return;
      }
      if (sql === "ROLLBACK") {
        const name = this.#savepoints.pop();
        if (name === undefined) throw new Error("no open savepoint");
        this.#inner.exec(`ROLLBACK TO ${name}`);
        this.#inner.exec(`RELEASE ${name}`);
        return;
      }
    }
    this.#inner.exec(sql);
  }

  prepare(sql: string): StatementSync {
    return this.#inner.prepare(sql);
  }

  run(sql: string, ...params: SqlValue[]): RunResult {
    return this.#inner.run(sql, ...params);
  }

  get<T = Record<string, SqlValue>>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.#inner.get<T>(sql, ...params);
  }

  all<T = Record<string, SqlValue>>(sql: string, ...params: SqlValue[]): T[] {
    return this.#inner.all<T>(sql, ...params);
  }

  close(): void {
    this.#inner.close();
  }

  /** Run fn as one unit: every command inside commits together or not at all. */
  async unit<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#open) return fn();
    this.#inner.exec("BEGIN IMMEDIATE");
    this.#open = true;
    try {
      const result = await fn();
      this.#open = false;
      this.#inner.exec("COMMIT");
      return result;
    } catch (error) {
      this.#open = false;
      this.#savepoints.length = 0;
      try {
        this.#inner.exec("ROLLBACK");
      } catch {
        // SQLite may already have rolled the transaction back; keep the first failure.
      }
      // A foreign key a command deferred (PRAGMA defer_foreign_keys) is only checked at
      // the outer COMMIT. Report it as the conflict it is, not as an internal error;
      // the whole unit has been rolled back above.
      if (!(error instanceof ApiError) && error instanceof Error && /FOREIGN KEY/i.test(error.message)) {
        throw new ApiError("conflict", "the change conflicts with the current state; nothing was written");
      }
      throw error;
    }
  }
}
