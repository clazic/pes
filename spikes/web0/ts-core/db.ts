// The only platform difference in the spike: how SQL is executed.
// Business logic (service.ts, scenario.ts) sees this interface only.
// node:sqlite lives in sqlite-adapter.ts so the Worker bundle never imports it.

export type SqlValue = string | number | null | Uint8Array;

export interface SqlStatement {
  sql: string;
  params?: SqlValue[];
}

export interface Db {
  all<T = Record<string, unknown>>(sql: string, params?: SqlValue[]): Promise<T[]>;
  run(sql: string, params?: SqlValue[]): Promise<number>; // rows changed
  /** Atomic batch. Any failure rolls the whole batch back. */
  batch(statements: SqlStatement[]): Promise<number[]>;
}

// Structural subset of the Workers D1 API (no @cloudflare/workers-types dependency).
export interface D1RunResultLike {
  meta?: { changes?: number };
}

export interface D1StatementLike {
  bind(...values: SqlValue[]): D1StatementLike;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
  run(): Promise<D1RunResultLike>;
}

export interface D1DatabaseLike {
  prepare(sql: string): D1StatementLike;
  batch(statements: D1StatementLike[]): Promise<D1RunResultLike[]>;
}

export class D1Db implements Db {
  readonly #db: D1DatabaseLike;

  constructor(db: D1DatabaseLike) {
    this.#db = db;
  }

  async all<T = Record<string, unknown>>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    const result = await this.#db
      .prepare(sql)
      .bind(...params)
      .all<T>();
    return result.results ?? [];
  }

  async run(sql: string, params: SqlValue[] = []): Promise<number> {
    const result = await this.#db
      .prepare(sql)
      .bind(...params)
      .run();
    return Number(result.meta?.changes ?? 0);
  }

  async batch(statements: SqlStatement[]): Promise<number[]> {
    const prepared = statements.map((statement) =>
      this.#db.prepare(statement.sql).bind(...(statement.params ?? [])),
    );
    const results = await this.#db.batch(prepared);
    return results.map((result) => Number(result.meta?.changes ?? 0));
  }
}
