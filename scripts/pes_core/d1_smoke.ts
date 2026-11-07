// D1-compatible smoke helpers (stage 2 PR2).
//
// This module is deliberately independent of miniflare and workerd. It accepts
// the small subset of the Cloudflare D1 API that the real binding also exposes,
// so the same helpers can run against local D1 in tests and against a Worker
// binding later. Everything here executes only the SQL it is given: no business
// table names are hardcoded.
//
// Behavior that differs from node:sqlite (measured on local D1, see decision
// 0018): D1 rejects bigint parameters, blocks sqlite_version(), reports a
// deferred FK violation as an internal/reset error, executes exec() line by
// line, and needs a guard statement to turn "0 rows changed" into a batch
// failure so the whole transaction rolls back.

export type D1Param = string | number | null;

export interface D1ResultLike {
  meta: { changes: number };
}

export interface D1PreparedLike {
  bind(...values: D1Param[]): D1PreparedLike;
}

export interface D1Like {
  prepare(sql: string): D1PreparedLike;
  batch(statements: D1PreparedLike[]): Promise<D1ResultLike[]>;
}

export interface BatchStatement {
  sql: string;
  params?: readonly D1Param[];
  /** When true, changing 0 rows fails the whole batch (and rolls it back). */
  require_change?: boolean;
}

export class ZeroRowsError extends Error {
  override name = "ZeroRowsError";

  constructor(message = "statement changed 0 rows") {
    super(message);
  }
}

/** Throws ZeroRowsError when a statement that must change rows changed none. */
export function assert_changed(changes: number, what: string): void {
  if (changes === 0) {
    throw new ZeroRowsError(`${what} changed 0 rows`);
  }
}

function is_space(character: string): boolean {
  return /\s/.test(character);
}

function push_part(parts: string[], text: string): void {
  const trimmed = text.trim();
  if (trimmed.length > 0) parts.push(trimmed);
}

/**
 * Split SQL text into single statements without cutting semicolons inside
 * string literals ('...', "...", `...`, [...]) or comments (-- line, block).
 * Whitespace and comment-only fragments are dropped, and each returned
 * statement has no leading/trailing whitespace or trailing semicolon.
 */
export function split_sql(sql: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let has_content = false;
  let index = 0;

  while (index < sql.length) {
    const character = sql[index];

    if (character === "'" || character === '"' || character === "`") {
      has_content = true;
      const quote = character;
      index += 1;
      while (index < sql.length) {
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }

    if (character === "[") {
      has_content = true;
      index += 1;
      while (index < sql.length && sql[index] !== "]") index += 1;
      if (index < sql.length) index += 1;
      continue;
    }

    if (character === "-" && sql[index + 1] === "-") {
      index += 2;
      while (index < sql.length && sql[index] !== "\n" && sql[index] !== "\r") index += 1;
      continue;
    }

    if (character === "/" && sql[index + 1] === "*") {
      index += 2;
      while (index < sql.length && !(sql[index] === "*" && sql[index + 1] === "/")) index += 1;
      index = Math.min(index + 2, sql.length);
      continue;
    }

    if (character === ";") {
      if (has_content) push_part(parts, sql.slice(start, index));
      index += 1;
      start = index;
      has_content = false;
      continue;
    }

    if (!is_space(character)) has_content = true;
    index += 1;
  }

  if (has_content) push_part(parts, sql.slice(start));
  return parts;
}

/**
 * Apply a migration SQL script in one D1 batch (one transaction). An empty
 * script never calls D1. A failure halfway through leaves nothing behind.
 */
export async function apply_migrations(
  d1: D1Like,
  sql: string,
): Promise<{ statements: number }> {
  const statements = split_sql(sql);
  if (statements.length === 0) return { statements: 0 };
  await d1.batch(statements.map((statement) => d1.prepare(statement)));
  return { statements: statements.length };
}

// changes() reports the row count of the previous DML statement. The CASE
// branch is evaluated only when that count is 0; abs() of the smallest 64-bit
// integer overflows and fails the batch, so earlier statements roll back.
const ZERO_ROWS_GUARD =
  "SELECT CASE WHEN changes() = 0 THEN abs(-9223372036854775808) ELSE 1 END";

function is_integer_overflow(error: unknown): boolean {
  return error instanceof Error && /integer overflow/i.test(error.message);
}

function bind_statement(d1: D1Like, statement: BatchStatement): D1PreparedLike {
  const prepared = d1.prepare(statement.sql);
  if (statement.params === undefined) return prepared;
  return prepared.bind(...statement.params);
}

/**
 * Run statements in one D1 batch (one transaction), returning the changed-row
 * count for each input statement in order. A `require_change` statement gets a
 * guard statement in the same batch so a 0-row result fails the batch and
 * rolls back everything; that failure is reported as ZeroRowsError. Params
 * containing a bigint are rejected before any SQL runs because D1 cannot bind
 * them (pass large integers as decimal strings). An empty list never calls D1.
 */
export async function run_batch(
  d1: D1Like,
  statements: readonly BatchStatement[],
): Promise<{ changes: number[] }> {
  if (statements.length === 0) return { changes: [] };

  for (const statement of statements) {
    for (const value of statement.params ?? []) {
      if (typeof value === "bigint") {
        throw new TypeError(
          `bigint parameter is not supported by D1: ${String(value)}. Pass large integers as decimal strings.`,
        );
      }
    }
  }

  const prepared: D1PreparedLike[] = [];
  const change_indexes: number[] = [];
  let guards = 0;

  for (const statement of statements) {
    change_indexes.push(prepared.length);
    prepared.push(bind_statement(d1, statement));
    if (statement.require_change === true) {
      prepared.push(d1.prepare(ZERO_ROWS_GUARD));
      guards += 1;
    }
  }

  let results: D1ResultLike[];
  try {
    results = await d1.batch(prepared);
  } catch (error) {
    if (guards > 0 && is_integer_overflow(error)) {
      throw new ZeroRowsError("a require_change statement changed 0 rows; the batch was rolled back");
    }
    throw error;
  }

  const changes = change_indexes.map((result_index) => {
    const meta = results[result_index]?.meta;
    if (meta === undefined || typeof meta.changes !== "number") {
      throw new Error("D1 batch result is missing meta.changes");
    }
    return meta.changes;
  });

  return { changes };
}
