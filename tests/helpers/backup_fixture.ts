// Fixtures for the backup/export/import tests (SEL-36). Everything here is
// synthetic: invented slugs, invented bytes, and paths under an isolated root.

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { BootstrapResult } from "../../scripts/pes_core/bootstrap.ts";
import { connect, migrate, type Db } from "../../scripts/pes_core/db.ts";
import { objects_dir as objects_dir_of, db_path } from "../../scripts/pes_core/paths.ts";
import { synthetic_project } from "./synthetic_project.ts";
import type { IsolatedHome } from "./isolated_home.ts";

export function sha256_hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Opaque bytes that must survive copying unchanged: NUL, CRLF, 0x1a, high bytes, invalid UTF-8. */
export const BINARY_BYTES = Uint8Array.from([0, 255, 254, 13, 10, 0x1a, 0x80, 0xc3, 0x28, 0, 13, 10, 1, 2, 3]);
export const TEXT_BYTES = new TextEncoder().encode("합성 본문: 이 내용은 해석되지 않는다.\n");
export const EMPTY_BYTES = new Uint8Array(0);

export interface BlobInfo {
  id: string;
  storage_key: string;
  sha256: string;
  size: number;
  bytes: Uint8Array;
}

/** Write one file under objects_dir and insert the matching blobs row (file bytes are opaque). */
export function add_blob(
  db: Db,
  objects_dir: string,
  project: BootstrapResult,
  name: string,
  bytes: Uint8Array,
): BlobInfo {
  const sha256 = sha256_hex(bytes);
  const storage_key = `${project.project_id}/${sha256}`;
  const target = join(objects_dir, ...storage_key.split("/"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
  const id = globalThis.crypto.randomUUID();
  db.run(
    `INSERT INTO blobs (id, project_id, storage_key, sha256, size, media_type, original_name, state, created_by)
     VALUES (?, ?, ?, ?, ?, 'application/octet-stream', ?, 'ready', ?)`,
    id,
    project.project_id,
    storage_key,
    sha256,
    bytes.byteLength,
    name,
    project.owner_actor_id,
  );
  return { id, storage_key, sha256, size: bytes.byteLength, bytes };
}

/** One display-numbered object so the project has rows beyond the bootstrap set. */
export function add_object(db: Db, project: BootstrapResult): void {
  db.run(
    `INSERT INTO objects (id, project_id, edition_id, kind, display_no)
     VALUES (?, ?, ?, 'artifact', 1)`,
    globalThis.crypto.randomUUID(),
    project.project_id,
    project.edition_id,
  );
  db.run(
    "UPDATE counters SET next_no = 2 WHERE project_id = ? AND namespace = 'artifact'",
    project.project_id,
  );
}

export interface World {
  home: IsolatedHome;
  src: Db;
  src_objects: string;
  a: BootstrapResult;
  a_blobs: BlobInfo[];
  b: BootstrapResult;
  b_blobs: BlobInfo[];
  tgt: Db;
  tgt_objects: string;
  c: BootstrapResult;
  c_blobs: BlobInfo[];
  bundles: string;
}

/**
 * Source DB with projects A (exported in tests) and B (must never leak), plus a
 * separate target DB that already holds its own project C. All under home.root.
 */
export function make_world(home: IsolatedHome): World {
  const src = connect(db_path(home.env));
  migrate(src);
  const src_objects = objects_dir_of(home.env);

  const a = synthetic_project(src, { slug: "synthetic-alpha", owner_display_name: "합성 사용자 가" }, 1_760_000_000_000).project;
  const b = synthetic_project(src, { slug: "synthetic-beta", owner_display_name: "합성 사용자 나" }, 1_760_000_100_000).project;
  const a_blobs = [
    add_blob(src, src_objects, a, "text.bin", TEXT_BYTES),
    add_blob(src, src_objects, a, "binary.bin", BINARY_BYTES),
    add_blob(src, src_objects, a, "empty.bin", EMPTY_BYTES),
  ];
  const b_blobs = [add_blob(src, src_objects, b, "other.bin", TEXT_BYTES)];
  add_object(src, a);
  add_object(src, b);

  const target_root = join(home.root, "target");
  const tgt = connect(join(target_root, "pes.db"));
  migrate(tgt);
  const tgt_objects = join(target_root, "objects");
  const c = synthetic_project(tgt, { slug: "synthetic-gamma", owner_display_name: "합성 사용자 다" }, 1_760_000_200_000).project;
  const c_blobs = [add_blob(tgt, tgt_objects, c, "gamma.bin", BINARY_BYTES)];

  return { home, src, src_objects, a, a_blobs, b, b_blobs, tgt, tgt_objects, c, c_blobs, bundles: join(home.root, "bundles") };
}

export function close_world(world: World): void {
  world.src.close();
  world.tgt.close();
}

/** Relative POSIX path -> sha256 for every file under dir. Missing dir -> empty. */
export function list_tree(dir: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (current: string, prefix: string): void => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(join(current, entry.name), rel);
      else result[rel] = sha256_hex(readFileSync(join(current, entry.name)));
    }
  };
  walk(dir, "");
  return Object.fromEntries(Object.entries(result).sort(([x], [y]) => (x < y ? -1 : 1)));
}

function bigint_replacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? `${value.toString()}n` : value;
}

/**
 * Every row that belongs to a project, per table, as sorted JSON strings:
 * tables with a project_id column, `projects` itself, and the users/actors the
 * project's owner points to. Row order is irrelevant (rowids differ after import).
 */
export function project_rows(db: Db, project_id: string, owner_user_id: string): Record<string, string[]> {
  const tables = db
    .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .map((row) => row.name);
  const out: Record<string, string[]> = {};
  const collect = (table: string, where: string, ...params: string[]): void => {
    const rows = db.all(`SELECT * FROM "${table}" WHERE ${where}`, ...params);
    out[table] = rows.map((row) => JSON.stringify(row, bigint_replacer)).sort();
  };
  for (const table of tables) {
    const columns = db.all<{ name: string }>(`PRAGMA table_info("${table}")`).map((row) => row.name);
    if (table === "projects") collect(table, "id = ?", project_id);
    else if (table === "users") collect(table, "id = ?", owner_user_id);
    else if (table === "actors") collect(table, "user_id = ?", owner_user_id);
    else if (columns.includes("project_id")) collect(table, "project_id = ?", project_id);
  }
  return out;
}

/** Full content of every table of a DB except db_meta, as sorted JSON strings per table. */
export function all_rows_except_meta(db: Db): Record<string, string[]> {
  const tables = db
    .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'db_meta' ORDER BY name")
    .map((row) => row.name);
  const out: Record<string, string[]> = {};
  for (const table of tables) {
    out[table] = db.all(`SELECT * FROM "${table}"`).map((row) => JSON.stringify(row, bigint_replacer)).sort();
  }
  return out;
}

export function meta_of(db: Db): { database_instance_id: string; cursor_epoch: bigint } {
  const row = db.get<{ database_instance_id: string; cursor_epoch: bigint }>(
    "SELECT database_instance_id, cursor_epoch FROM db_meta WHERE id = 1",
  );
  if (row === undefined) throw new Error("db_meta row missing");
  return row;
}
