import assert from "node:assert/strict";
import { test } from "node:test";

import type { BootstrapResult } from "../scripts/pes_core/bootstrap.ts";
import type { FakeClock } from "../scripts/pes_core/clock.ts";
import { connect, migrate, tx, type Db } from "../scripts/pes_core/db.ts";
import { new_id } from "../scripts/pes_core/ids.ts";
import { db_path } from "../scripts/pes_core/paths.ts";
import {
  seed_representative_graph,
  type SeededGraph,
} from "./fixtures/schema_seed.ts";
import { isolated_home, type IsolatedHome } from "./helpers/isolated_home.ts";
import { state_signature } from "./helpers/state_signature.ts";
import { synthetic_project } from "./helpers/synthetic_project.ts";

interface Fixture {
  home: IsolatedHome;
  db: Db;
  project: BootstrapResult;
  clock: FakeClock;
  seeded: SeededGraph;
}

function setup(): Fixture {
  const home = isolated_home();
  const db = connect(db_path(home.env));
  migrate(db);
  const { project, clock } = synthetic_project(db);
  const seeded = tx(db, () => seed_representative_graph(db, project, clock));
  return { home, db, project, clock, seeded };
}

function close(fixture: Fixture): void {
  fixture.db.close();
  fixture.home.cleanup();
}

function count(db: Db, table: string): bigint {
  return db.get<{ count: bigint }>(`SELECT count(*) AS count FROM "${table}"`)?.count ?? 0n;
}

function assert_rolls_back(db: Db, action: () => void, pattern?: RegExp): void {
  const before = state_signature(db);
  if (pattern === undefined) {
    assert.throws(() => tx(db, action));
  } else {
    assert.throws(() => tx(db, action), pattern);
  }
  assert.equal(state_signature(db), before);
}

test("representative synthetic rows can be inserted in one transaction", () => {
  const fixture = setup();
  try {
    assert.deepEqual(fixture.db.all("PRAGMA foreign_key_check"), []);
    assert.equal(count(fixture.db, "objects"), 4n);
    assert.equal(count(fixture.db, "object_versions"), 4n);
    assert.equal(count(fixture.db, "artifact_versions"), 1n);
    assert.equal(count(fixture.db, "sources"), 1n);
    assert.equal(count(fixture.db, "source_versions"), 1n);
    assert.equal(count(fixture.db, "citations"), 1n);
    assert.equal(count(fixture.db, "questions"), 1n);
    assert.equal(count(fixture.db, "question_versions"), 1n);
    assert.equal(count(fixture.db, "question_sets"), 1n);
    assert.equal(count(fixture.db, "submissions"), 1n);
    assert.equal(count(fixture.db, "answers"), 1n);
    assert.equal(count(fixture.db, "answer_versions"), 1n);
    assert.equal(count(fixture.db, "runs"), 1n);
    assert.equal(count(fixture.db, "project_leases"), 1n);
    assert.equal(count(fixture.db, "events"), 1n);
    assert.equal(count(fixture.db, "blobs"), 1n);
    assert.equal(count(fixture.db, "file_policies"), 1n);
    assert.equal(count(fixture.db, "version_files"), 1n);

    const artifact = fixture.db.get<{ title: string }>(
      "SELECT title FROM artifact_versions WHERE project_id = ? AND version_id = ?",
      fixture.project.project_id,
      fixture.seeded.artifact_version_id,
    );
    assert.equal(artifact?.title, "합성 결과");
    assert.equal(
      fixture.db.get<{ current_version_id: string }>(
        "SELECT current_version_id FROM objects WHERE project_id = ? AND id = ?",
        fixture.project.project_id,
        fixture.seeded.artifact_object_id,
      )?.current_version_id,
      fixture.seeded.artifact_version_id,
    );
  } finally {
    close(fixture);
  }
});

test("a foreign key violation rolls back the whole transaction", () => {
  const fixture = setup();
  try {
    assert_rolls_back(
      fixture.db,
      () => {
        fixture.db.run(
          `INSERT INTO citations (project_id, artifact_version_id, citation_no, source_version_id)
           VALUES (?, ?, 2, ?)`,
          fixture.project.project_id,
          "missing-artifact-version",
          fixture.seeded.source_version_id,
        );
      },
      /FOREIGN KEY/,
    );
  } finally {
    close(fixture);
  }
});

test("a CHECK violation rolls back the whole transaction", () => {
  const fixture = setup();
  try {
    assert_rolls_back(
      fixture.db,
      () => {
        fixture.db.run(
          "UPDATE stages SET ordinal = 7 WHERE project_id = ? AND id = ?",
          fixture.project.project_id,
          fixture.project.stage_ids.plan,
        );
      },
      /CHECK/,
    );
  } finally {
    close(fixture);
  }
});

test("UNIQUE and partial UNIQUE violations roll back the whole transaction", () => {
  const fixture = setup();
  try {
    assert_rolls_back(
      fixture.db,
      () => {
        fixture.db.run(
          "INSERT INTO editions (id, project_id, edition_no, status) VALUES (?, ?, 1, 'draft')",
          new_id(),
          fixture.project.project_id,
        );
      },
      /UNIQUE/,
    );

    assert_rolls_back(
      fixture.db,
      () => {
        fixture.db.run(
          "INSERT INTO editions (id, project_id, edition_no, status) VALUES (?, ?, 2, 'active')",
          new_id(),
          fixture.project.project_id,
        );
      },
      /UNIQUE/,
    );
  } finally {
    close(fixture);
  }
});

test("cross-project references are rejected and rolled back", () => {
  const fixture = setup();
  try {
    const second = synthetic_project(fixture.db, {
      slug: "synthetic-beta",
      owner_display_name: "합성 사용자 2",
    });
    const second_seed = tx(fixture.db, () =>
      seed_representative_graph(fixture.db, second.project, second.clock),
    );

    // A version from project 2 may not become project 1's current version.
    assert_rolls_back(
      fixture.db,
      () => {
        fixture.db.run(
          "UPDATE objects SET current_version_id = ? WHERE project_id = ? AND id = ?",
          second_seed.artifact_version_id,
          fixture.project.project_id,
          fixture.seeded.artifact_object_id,
        );
      },
      /FOREIGN KEY/,
    );

    // Nor may a project 1 citation point at a project 2 source version.
    assert_rolls_back(
      fixture.db,
      () => {
        fixture.db.run(
          `INSERT INTO citations (project_id, artifact_version_id, citation_no, source_version_id)
           VALUES (?, ?, 2, ?)`,
          fixture.project.project_id,
          fixture.seeded.artifact_version_id,
          second_seed.source_version_id,
        );
      },
      /FOREIGN KEY/,
    );
  } finally {
    close(fixture);
  }
});

test("a zero-row rev guard fails the transaction and discards earlier inserts", () => {
  const fixture = setup();
  try {
    const before = state_signature(fixture.db);
    const current = fixture.db.get<{ rev: bigint }>(
      "SELECT rev FROM objects WHERE project_id = ? AND id = ?",
      fixture.project.project_id,
      fixture.seeded.artifact_object_id,
    );
    assert.equal(current?.rev, 1n);

    const conflict_tx = new_id();
    const conflict_version = new_id();
    const conflict_event = new_id();
    assert.throws(
      () =>
        tx(fixture.db, () => {
          fixture.db.run(
            `INSERT INTO mutation_commits
               (id, project_id, actor_id, via, client_request_id, request_hash, action,
                base_control_rev, result_json, created_at)
             VALUES (?, ?, ?, 'http', 'rev-conflict', ?, 'result.submit', 0, '{}', ?)`,
            conflict_tx,
            fixture.project.project_id,
            fixture.project.owner_actor_id,
            "f".repeat(64),
            fixture.clock.now_ms(),
          );
          fixture.db.run(
            `INSERT INTO object_versions
               (id, project_id, object_id, kind, version_no, actor_id, tx_id, content_hash, created_at)
             VALUES (?, ?, ?, 'artifact', 2, ?, ?, ?, ?)`,
            conflict_version,
            fixture.project.project_id,
            fixture.seeded.artifact_object_id,
            fixture.project.owner_actor_id,
            conflict_tx,
            "c".repeat(64),
            fixture.clock.now_ms(),
          );
          fixture.db.run(
            `INSERT INTO artifact_versions
               (project_id, version_id, object_id, title, body_md, status)
             VALUES (?, ?, ?, '합성 커밋 후보', '새 합성 본문', 'done')`,
            fixture.project.project_id,
            conflict_version,
            fixture.seeded.artifact_object_id,
          );
          fixture.db.run(
            `INSERT INTO events
               (id, project_id, run_id, tx_id, tx_index, tx_size, type, object_id,
                after_version_id, created_at)
             VALUES (?, ?, ?, ?, 0, 1, 'result.submitted', ?, ?, ?)`,
            conflict_event,
            fixture.project.project_id,
            fixture.seeded.run_id,
            conflict_tx,
            fixture.seeded.artifact_object_id,
            conflict_version,
            fixture.clock.now_ms(),
          );
          const changed = fixture.db.run(
            `UPDATE objects SET current_version_id = ?, rev = rev + 1
             WHERE project_id = ? AND id = ? AND rev = ?`,
            conflict_version,
            fixture.project.project_id,
            fixture.seeded.artifact_object_id,
            (current?.rev ?? 0n) - 1n,
          );
          if (changed.changes !== 1n) {
            throw new Error("revision conflict: conditional UPDATE changed zero rows");
          }
        }),
      /revision conflict/,
    );
    assert.equal(state_signature(fixture.db), before);

    // The same transaction body succeeds with the current revision.
    const success_version = new_id();
    tx(fixture.db, () => {
      const success_tx = new_id();
      fixture.db.run(
        `INSERT INTO mutation_commits
           (id, project_id, actor_id, via, client_request_id, request_hash, action,
            base_control_rev, result_json, created_at)
         VALUES (?, ?, ?, 'http', 'rev-success', ?, 'result.submit', 0, '{}', ?)`,
        success_tx,
        fixture.project.project_id,
        fixture.project.owner_actor_id,
        "e".repeat(64),
        fixture.clock.now_ms(),
      );
      fixture.db.run(
        `INSERT INTO object_versions
           (id, project_id, object_id, kind, version_no, actor_id, tx_id, content_hash, created_at)
         VALUES (?, ?, ?, 'artifact', 2, ?, ?, ?, ?)`,
        success_version,
        fixture.project.project_id,
        fixture.seeded.artifact_object_id,
        fixture.project.owner_actor_id,
        success_tx,
        "d".repeat(64),
        fixture.clock.now_ms(),
      );
      fixture.db.run(
        `INSERT INTO artifact_versions
           (project_id, version_id, object_id, title, body_md, status)
         VALUES (?, ?, ?, '합성 커밋 후보', '새 합성 본문', 'done')`,
        fixture.project.project_id,
        success_version,
        fixture.seeded.artifact_object_id,
      );
      fixture.db.run(
        `INSERT INTO events
           (id, project_id, run_id, tx_id, tx_index, tx_size, type, object_id,
            after_version_id, created_at)
         VALUES (?, ?, ?, ?, 0, 1, 'result.submitted', ?, ?, ?)`,
        new_id(),
        fixture.project.project_id,
        fixture.seeded.run_id,
        success_tx,
        fixture.seeded.artifact_object_id,
        success_version,
        fixture.clock.now_ms(),
      );
      const changed = fixture.db.run(
        `UPDATE objects SET current_version_id = ?, rev = rev + 1
         WHERE project_id = ? AND id = ? AND rev = ?`,
        success_version,
        fixture.project.project_id,
        fixture.seeded.artifact_object_id,
        current?.rev ?? 0n,
      );
      assert.equal(changed.changes, 1n);
    });

    const updated = fixture.db.get<{ current_version_id: string; rev: bigint }>(
      "SELECT current_version_id, rev FROM objects WHERE project_id = ? AND id = ?",
      fixture.project.project_id,
      fixture.seeded.artifact_object_id,
    );
    assert.equal(updated?.current_version_id, success_version);
    assert.equal(updated?.rev, 2n);
    assert.equal(
      fixture.db.get<{ title: string }>(
        "SELECT title FROM artifact_versions WHERE version_id = ?",
        fixture.seeded.artifact_version_id,
      )?.title,
      "합성 결과",
    );
  } finally {
    close(fixture);
  }
});

test("integers above 2^53 round trip as bigint", () => {
  const fixture = setup();
  try {
    const large = 9007199254740993n;
    fixture.db.run("UPDATE db_meta SET cursor_epoch = ? WHERE id = 1", large);
    assert.equal(
      fixture.db.get<{ cursor_epoch: bigint }>("SELECT cursor_epoch FROM db_meta WHERE id = 1")
        ?.cursor_epoch,
      large,
    );
    assert.equal(
      fixture.db.get<{ value: bigint }>("SELECT 9007199254740993 AS value")?.value,
      large,
    );
  } finally {
    close(fixture);
  }
});

test("nested transactions and async callbacks are rejected without leaving rows", () => {
  const fixture = setup();
  try {
    const before = state_signature(fixture.db);

    assert.throws(
      () =>
        tx(fixture.db, () => {
          fixture.db.run("UPDATE db_meta SET cursor_epoch = 42 WHERE id = 1");
          tx(fixture.db, () => {
            fixture.db.run("UPDATE db_meta SET cursor_epoch = 43 WHERE id = 1");
          });
        }),
      /nested tx\(\) is not allowed/,
    );
    assert.equal(state_signature(fixture.db), before);

    assert.throws(
      () =>
        tx(fixture.db, () => {
          fixture.db.run("UPDATE db_meta SET cursor_epoch = 44 WHERE id = 1");
          return Promise.resolve(1);
        }),
      /must be synchronous/,
    );
    assert.equal(state_signature(fixture.db), before);

    const value = tx(fixture.db, () =>
      fixture.db.get<{ cursor_epoch: bigint }>("SELECT cursor_epoch FROM db_meta WHERE id = 1"),
    );
    assert.equal(value?.cursor_epoch, 1n);
  } finally {
    close(fixture);
  }
});
