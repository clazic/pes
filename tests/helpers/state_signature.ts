// Full-content signature used to prove that a failed transaction left no rows
// behind. Every user table is read in rowid order and serialized; bigint values
// are rendered with an "n" suffix so two states compare exactly.

import type { Db } from "../../scripts/pes_core/db.ts";

function bigint_replacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? `${value.toString()}n` : value;
}

export function state_signature(db: Db): string {
  const tables = db
    .all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .map((row) => row.name);

  return tables
    .map((table) => {
      const rows = db.all(`SELECT * FROM "${table}" ORDER BY rowid`);
      return `${table}:${JSON.stringify(rows, bigint_replacer)}`;
    })
    .join("\n");
}

export function table_counts(db: Db): Record<string, bigint> {
  const tables = db
    .all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .map((row) => row.name);
  const counts: Record<string, bigint> = {};
  for (const table of tables) {
    const row = db.get<{ count: bigint }>(`SELECT count(*) AS count FROM "${table}"`);
    counts[table] = row?.count ?? 0n;
  }
  return counts;
}
