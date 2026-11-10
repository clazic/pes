// SEL-44 (stage 2 PR11) regression tests for the first re-check (logs/SEL-44-r1-3.md).
// Everything is synthetic, built in a temporary folder inside the test's isolated HOME.
//
//   M1 (필수 1)  an item that exists only in a snapshot (not in the current project.json) becomes an
//                ARCHIVED object (archived_at set); round_contents of that snapshot's round point at
//                the past version; it is not in the current (active) lists.
//   A  (권장 A)  a rounds/<stage>-R<n>/<id>.json whose canonical hash equals a PAST (snapshot)
//                version record is linked as `source` to that past version, not unmapped_input.
//   B  (권장 B)  unknown sub-fields never overwrite the importer's own locator.legacy_extra marks
//                (legacy_unverified, method_original); a "__proto__" key is kept as an own key.
//   C  (권장 C)  past -> current versions of one object chain through based_on_version_id
//                (the first version is NULL).
//
// Interpretation: the same as test_legacy_import_final1.test.ts. Where the importer renames a
// colliding key is not fixed here (only "the importer's mark is not overwritten and the original
// value is still somewhere in legacy_extra" is).
//
// No earlier test contradicts these; none was changed.

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  json_of,
  rounds_of,
  run_import,
  sha256_of,
  stage_of,
  with_legacy,
  type Env,
  type LegacyApi,
  type MappingRow,
  type UnknownReport,
} from "./helpers/legacy_env.ts";

let dir_counter = 0;

function new_source(env: Env, label: string): string {
  dir_counter += 1;
  const dir = join(env.home.root, `r13-${label}-${dir_counter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function write_file(dir: string, rel: string, body: unknown): void {
  const full = join(dir, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, typeof body === "string" ? body : JSON.stringify(body), "utf8");
}

function base_project(slug: string, round: number, items: unknown[]): Record<string, unknown> {
  return {
    pes: 1,
    topic: "합성 r1-3 프로젝트",
    slug,
    created: "2026-03-01",
    current: "plan",
    settings: {},
    processed: [],
    complete: false,
    stages: { plan: { status: "active", round, items } },
  };
}

function snapshot(round: number, items: unknown[]): Record<string, unknown> {
  return {
    stage: "plan",
    round,
    time: "2026-03-01 10:00",
    state: { status: "active", round, items },
  };
}

async function import_body(
  env: Env,
  api: LegacyApi,
  label: string,
  body: Record<string, unknown>,
  files: Record<string, unknown> = {},
) {
  const dir = new_source(env, label);
  write_file(dir, "project.json", body);
  for (const [rel, content] of Object.entries(files)) write_file(dir, rel, content);
  const result = await run_import(env, api, dir);
  assert.equal(result.state, "staging", `${label}: the import itself must not fail`);
  return { result, mappings: api.map_legacy(env.db, result.batch_id), pid: result.project_id };
}

function item_rows(mappings: MappingRow[], key: string): MappingRow[] {
  return mappings.filter(
    (m) => m.legacy_kind === "item" && m.legacy_scope === "plan" && m.legacy_key === key && m.new_object_id && m.new_version_id,
  );
}

function object_of_item(mappings: MappingRow[], key: string): string {
  const rows = item_rows(mappings, key);
  assert.ok(rows.length > 0, `mapping for item ${key}`);
  return rows[0]!.new_object_id!;
}

interface Ver {
  version_id: string;
  title: string;
  version_no: number;
  based_on: string | null;
}

function versions_of(env: Env, object_id: string): Ver[] {
  return env.db
    .all<{ version_id: string; title: string; version_no: bigint; based_on: string | null }>(
      `SELECT av.version_id AS version_id, av.title AS title, ov.version_no AS version_no,
              ov.based_on_version_id AS based_on
         FROM artifact_versions av JOIN object_versions ov ON ov.id = av.version_id
        WHERE av.object_id = ? ORDER BY ov.version_no`,
      object_id,
    )
    .map((r) => ({ version_id: r.version_id, title: r.title, version_no: Number(r.version_no), based_on: r.based_on }));
}

function source_files(env: Env, version_id: string): string[] {
  return env.db
    .all<{ sha256: string }>(
      `SELECT b.sha256 AS sha256 FROM version_files vf JOIN blobs b ON b.id = vf.blob_id
        WHERE vf.version_id = ? AND vf.role = 'source'`,
      version_id,
    )
    .map((r) => r.sha256);
}

function has_report(report: UnknownReport, category: string, path: string, key?: string): boolean {
  return report.entries.some((e) => e.category === category && e.path === path && (key === undefined || e.key === key));
}

// ===========================================================================
// M1: item only in a snapshot -> archived object
// ===========================================================================

const KEEP = { id: 1, title: "kept item", kind: "rq", status: "new", summary: "in both" };
const GHOST = { id: 9, title: "ghost only in snapshot", kind: "rq", status: "new", summary: "removed later" };

test("M1a: an item only in a snapshot becomes an archived object whose round_contents point at its past version", async () => {
  await with_legacy(async (env, api) => {
    const body = base_project("synthetic-r13-ghost", 2, [KEEP]);
    const { pid, mappings } = await import_body(env, api, "m1a", body, {
      "snapshots/plan-R1.json": snapshot(1, [KEEP, GHOST]),
    });
    const ghost_object = object_of_item(mappings, "9");
    const obj = env.db.get<{ archived_at: bigint | null }>("SELECT archived_at FROM objects WHERE id = ?", ghost_object);
    assert.ok(obj, "the ghost object exists");
    assert.notEqual(obj.archived_at, null, "archived_at is set: the person removed it from project.json");

    const versions = versions_of(env, ghost_object);
    assert.deepEqual(versions.map((v) => v.title), ["ghost only in snapshot"], "only its past version exists");

    const round1 = rounds_of(env.db, stage_of(env.db, pid, "plan").id)[0]!;
    const row = env.db.get<{ version_id: string }>(
      "SELECT version_id FROM round_contents WHERE round_id = ? AND object_id = ?",
      round1.id,
      ghost_object,
    );
    assert.equal(row?.version_id, versions[0]!.version_id, "round 1 still shows it, at that past version");
  });
});

test("M1b: the archived ghost is not in the current lists; the kept item stays active", async () => {
  await with_legacy(async (env, api) => {
    const body = base_project("synthetic-r13-ghost-list", 2, [KEEP]);
    const { pid, mappings } = await import_body(env, api, "m1b", body, {
      "snapshots/plan-R1.json": snapshot(1, [KEEP, GHOST]),
    });
    const active = env.db.all<{ title: string }>(
      `SELECT av.title AS title FROM objects o
         JOIN artifact_versions av ON av.version_id = o.current_version_id
        WHERE o.project_id = ? AND o.kind = 'artifact' AND o.archived_at IS NULL`,
      pid,
    );
    const titles = active.map((r) => r.title);
    assert.ok(!titles.includes("ghost only in snapshot"), "an archived item is not an active item");
    assert.ok(titles.includes("kept item"), "an item that is in project.json stays active");
    const kept = env.db.get<{ archived_at: bigint | null }>(
      "SELECT archived_at FROM objects WHERE id = ?",
      object_of_item(mappings, "1"),
    );
    assert.equal(kept?.archived_at, null);
  });
});

test("M1c: re-importing the same folder does not revive the ghost or make a second ghost object", async () => {
  await with_legacy(async (env, api) => {
    const body = base_project("synthetic-r13-ghost-twice", 2, [KEEP]);
    const files = { "snapshots/plan-R1.json": snapshot(1, [KEEP, GHOST]) };
    const first = await import_body(env, api, "m1c1", body, files);
    const second = await import_body(env, api, "m1c2", body, files);
    for (const { pid } of [first, second]) {
      const rows = env.db.all<{ archived_at: bigint | null }>(
        `SELECT o.archived_at AS archived_at FROM objects o JOIN artifact_versions av ON av.object_id = o.id
          WHERE o.project_id = ? AND av.title = 'ghost only in snapshot'`,
        pid,
      );
      assert.ok(rows.length >= 1);
      assert.ok(rows.every((r) => r.archived_at !== null), "every ghost object is archived");
    }
  });
});

// ===========================================================================
// A: result JSON equal to a past version -> source of that past version
// ===========================================================================

const X = { id: 1, title: "x first", kind: "rq", status: "new", summary: "round 1 text" };
const Y = { id: 1, title: "y second", kind: "rq", status: "new", summary: "round 2 text" };
const Z = { id: 1, title: "z current", kind: "rq", status: "done", summary: "now" };

test("A: a rounds result JSON equal to a past (snapshot) version is linked as source to that version, not unmapped_input", async () => {
  await with_legacy(async (env, api) => {
    const body = base_project("synthetic-r13-past-result", 3, [Z]);
    const { mappings, result } = await import_body(env, api, "a", body, {
      "snapshots/plan-R1.json": snapshot(1, [X]),
      "snapshots/plan-R2.json": snapshot(2, [Y]),
      "rounds/plan-R1/1.json": X,
      "rounds/plan-R2/1.json": Y,
    });
    const versions = versions_of(env, object_of_item(mappings, "1"));
    assert.deepEqual(versions.map((v) => v.title), ["x first", "y second", "z current"]);
    assert.deepEqual(source_files(env, versions[0]!.version_id), [sha256_of(JSON.stringify(X))], "R1 file -> version X");
    assert.deepEqual(source_files(env, versions[1]!.version_id), [sha256_of(JSON.stringify(Y))], "R2 file -> version Y");
    assert.deepEqual(source_files(env, versions[2]!.version_id), [], "the current version got neither");
    assert.ok(!has_report(result.report, "unmapped_input", "rounds/plan-R1/1.json"));
    assert.ok(!has_report(result.report, "unmapped_input", "rounds/plan-R2/1.json"));
  });
});

test("A2: a result JSON that matches no version of its item is still raw blob + unmapped_input", async () => {
  await with_legacy(async (env, api) => {
    const body = base_project("synthetic-r13-nomatch", 3, [Z]);
    const stray = { ...X, title: "x but edited" };
    const { mappings, result } = await import_body(env, api, "a2", body, {
      "snapshots/plan-R1.json": snapshot(1, [X]),
      "rounds/plan-R1/1.json": stray,
    });
    assert.ok(has_report(result.report, "unmapped_input", "rounds/plan-R1/1.json"));
    for (const v of versions_of(env, object_of_item(mappings, "1"))) {
      assert.ok(!source_files(env, v.version_id).includes(sha256_of(JSON.stringify(stray))));
    }
  });
});

// ===========================================================================
// B: unknown sub-fields must not overwrite importer marks
// ===========================================================================

test("B: unknown source keys named like importer marks do not overwrite them; __proto__ is kept as its own key and reported", async () => {
  await with_legacy(async (env, api) => {
    // the source JSON is written as raw text so "__proto__" is a real key in the file
    const raw_source =
      '{"title":"marked source","url":"https://example.invalid/b","method":"weird-method",' +
      '"legacy_unverified":false,"method_original":"forged","__proto__":{"polluted":"yes"},"plain_extra":"keep me"}';
    const raw_project =
      '{"pes":1,"topic":"합성 r1-3 프로젝트","slug":"synthetic-r13-marks","created":"2026-03-01","current":"plan",' +
      '"settings":{},"processed":[],"complete":false,"stages":{"plan":{"status":"active","round":1,"items":[' +
      '{"id":1,"title":"item","kind":"rq","status":"new","sources":[' +
      raw_source +
      "]}]}}}";
    const dir = new_source(env, "b");
    write_file(dir, "project.json", raw_project);
    const result = await run_import(env, api, dir);
    assert.equal(result.state, "staging");
    const row = env.db.get<{ locator: string }>(
      "SELECT locator FROM source_versions WHERE project_id = ? AND title = ?",
      result.project_id,
      "marked source",
    );
    assert.ok(row, "the source version exists");
    const locator = json_of(row.locator);
    const extra = locator.legacy_extra as Record<string, unknown>;
    assert.equal(extra.legacy_unverified, true, "the importer's mark (unknown method) is not overwritten by the file's false");
    assert.equal(extra.method_original, "weird-method", "the original method is not overwritten by the file's forged value");
    assert.equal(extra.plain_extra, "keep me");
    assert.ok(!("polluted" in {}), "Object.prototype is not polluted");

    // __proto__ is preserved verbatim (as an own key somewhere in legacy_extra) and the forged values are not lost
    const text = row.locator;
    assert.ok(text.includes("polluted"), "the __proto__ value is kept");
    assert.ok(text.includes("forged"), "the colliding method_original value is kept somewhere");
    assert.ok(Object.hasOwn(extra, "__proto__"), "the key stays '__proto__', as written in the file");
    assert.deepEqual(extra["__proto__"], { polluted: "yes" });

    const base = "/stages/plan/items/0/sources/0";
    for (const key of ["__proto__", "legacy_unverified", "method_original", "plain_extra"]) {
      assert.ok(
        has_report(result.report, "unknown_field", "project.json", `${base}/${key}`),
        `${key} is reported (original text preserved)`,
      );
    }
  });
});

// ===========================================================================
// C: version chain through based_on_version_id
// ===========================================================================

test("C: past -> current versions of one object chain through based_on_version_id; only the first is NULL", async () => {
  await with_legacy(async (env, api) => {
    const body = base_project("synthetic-r13-chain", 3, [Z]);
    const { mappings } = await import_body(env, api, "c", body, {
      "snapshots/plan-R1.json": snapshot(1, [X]),
      "snapshots/plan-R2.json": snapshot(2, [Y]),
    });
    const versions = versions_of(env, object_of_item(mappings, "1"));
    assert.deepEqual(versions.map((v) => v.title), ["x first", "y second", "z current"]);
    assert.equal(versions[0]!.based_on, null, "the first version has no base");
    assert.equal(versions[1]!.based_on, versions[0]!.version_id, "Y is based on X");
    assert.equal(versions[2]!.based_on, versions[1]!.version_id, "Z (current) is based on Y");
  });
});

test("C2: an object with a single version keeps based_on_version_id NULL", async () => {
  await with_legacy(async (env, api) => {
    const body = base_project("synthetic-r13-chain-one", 1, [KEEP]);
    const { mappings } = await import_body(env, api, "c2", body);
    const versions = versions_of(env, object_of_item(mappings, "1"));
    assert.equal(versions.length, 1);
    assert.equal(versions[0]!.based_on, null);
  });
});
