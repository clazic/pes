import assert from "node:assert/strict";
import { test } from "node:test";

import {
  bootstrap_project,
  OBJECT_KINDS,
  STAGE_KEYS,
} from "../scripts/pes_core/bootstrap.ts";
import { FakeClock } from "../scripts/pes_core/clock.ts";
import { connect, migrate, type Db, type SqlValue } from "../scripts/pes_core/db.ts";
import { new_id } from "../scripts/pes_core/ids.ts";
import { db_path } from "../scripts/pes_core/paths.ts";
import { isolated_home, type IsolatedHome } from "./helpers/isolated_home.ts";
import { state_signature, table_counts } from "./helpers/state_signature.ts";

const START_MS = 1_760_000_000_000;

function open_migrated(home: IsolatedHome) {
  const db = connect(db_path(home.env));
  migrate(db);
  return db;
}

/** Counts real SQL writes so a failure test can prove writes happened first. */
function count_runs(db: Db): { db: Db; run_calls(): number } {
  let calls = 0;
  return {
    db: {
      path: db.path,
      exec: (sql) => db.exec(sql),
      prepare: (sql) => db.prepare(sql),
      run: (sql, ...params) => {
        calls += 1;
        return db.run(sql, ...params);
      },
      get: <T>(sql: string, ...params: SqlValue[]) => db.get<T>(sql, ...params),
      all: <T>(sql: string, ...params: SqlValue[]) => db.all<T>(sql, ...params),
      close: () => db.close(),
    },
    run_calls: () => calls,
  };
}

test("bootstrap creates owner, initial policy, edition, six stages, counters, and pointers", () => {
  const home = isolated_home();
  const db = open_migrated(home);
  const clock = new FakeClock(START_MS);
  try {
    const result = bootstrap_project(
      db,
      { slug: "synthetic-alpha", topic: "합성 정책 연구", owner_display_name: "합성 사용자" },
      { clock, new_id },
    );

    assert.deepEqual(db.all("PRAGMA foreign_key_check"), []);

    const user = db.get<{ id: string; display_name: string; created_at: bigint }>(
      "SELECT id, display_name, created_at FROM users",
    );
    assert.equal(user?.id, result.owner_user_id);
    assert.equal(user?.display_name, "합성 사용자");
    assert.equal(user?.created_at, BigInt(START_MS));

    const actor = db.get<{ kind: string; user_id: string; display_name: string }>(
      "SELECT kind, user_id, display_name FROM actors",
    );
    assert.equal(actor?.kind, "human");
    assert.equal(actor?.user_id, result.owner_user_id);
    assert.equal(actor?.display_name, "합성 사용자");

    const project = db.get<{
      slug: string;
      topic: string;
      owner_user_id: string;
      owner_role: string;
      active_edition_id: string;
      current_policy_id: string;
      status: string;
      control_rev: bigint;
      created_at: bigint;
    }>("SELECT * FROM projects");
    assert.equal(project?.slug, "synthetic-alpha");
    assert.equal(project?.topic, "합성 정책 연구");
    assert.equal(project?.owner_user_id, result.owner_user_id);
    assert.equal(project?.owner_role, "owner");
    assert.equal(project?.active_edition_id, result.edition_id);
    assert.equal(project?.current_policy_id, result.policy_id);
    assert.equal(project?.status, "active");
    assert.equal(project?.control_rev, 0n);
    assert.equal(project?.created_at, BigInt(START_MS));

    const member = db.get<{ user_id: string; role: string }>(
      "SELECT user_id, role FROM project_members",
    );
    assert.equal(member?.user_id, result.owner_user_id);
    assert.equal(member?.role, "owner");

    const policy = db.get<{
      policy_rev: bigint;
      allow_opencode_go: bigint;
      mode_a_model: string;
      go_usage_stop_percent: bigint;
      changed_by: string;
      changed_by_user_id: string;
      changed_by_kind: string;
      tx_id: string;
      created_at: bigint;
    }>("SELECT * FROM project_policy_versions");
    assert.equal(policy?.policy_rev, 1n);
    assert.equal(policy?.allow_opencode_go, 1n);
    assert.equal(policy?.mode_a_model, "opencode-go/deepseek-v4.1-flash");
    assert.equal(policy?.go_usage_stop_percent, 90n);
    assert.equal(policy?.changed_by, result.owner_actor_id);
    assert.equal(policy?.changed_by_user_id, result.owner_user_id);
    assert.equal(policy?.changed_by_kind, "human");
    assert.equal(policy?.tx_id, result.tx_id);
    assert.equal(policy?.created_at, BigInt(START_MS));

    const commit = db.get<{
      id: string;
      via: string;
      action: string;
      request_hash: string;
      base_control_rev: bigint;
    }>("SELECT id, via, action, request_hash, base_control_rev FROM mutation_commits");
    assert.equal(commit?.id, result.tx_id);
    assert.equal(commit?.via, "cli");
    assert.equal(commit?.action, "project.created");
    assert.match(commit?.request_hash ?? "", /^[0-9a-f]{64}$/);

    const edition = db.get<{ status: string; edition_no: bigint; current_stage_id: string }>(
      "SELECT status, edition_no, current_stage_id FROM editions",
    );
    assert.equal(edition?.status, "active");
    assert.equal(edition?.edition_no, 1n);
    assert.equal(edition?.current_stage_id, result.stage_ids.plan);

    const stages = db.all<{ id: string; key: string; ordinal: bigint; status: string }>(
      "SELECT id, key, ordinal, status FROM stages ORDER BY ordinal",
    );
    assert.equal(stages.length, 6);
    assert.deepEqual(
      stages.map((stage) => [stage.key, stage.ordinal]),
      STAGE_KEYS.map((key, index) => [key, BigInt(index + 1)]),
    );
    for (const stage of stages) {
      assert.equal(stage.status, "pending");
      assert.equal(stage.id, result.stage_ids[stage.key as (typeof STAGE_KEYS)[number]]);
    }

    const counters = db.all<{ namespace: string; next_no: bigint }>(
      "SELECT namespace, next_no FROM counters ORDER BY namespace",
    );
    assert.deepEqual(
      counters.map((counter) => counter.namespace),
      [...OBJECT_KINDS].sort(),
    );
    assert.ok(counters.every((counter) => counter.next_no === 1n));

    assert.equal(
      db.get<{ count: bigint }>("SELECT count(*) AS count FROM events")?.count,
      0n,
    );
    assert.equal(
      db.get<{ count: bigint }>("SELECT count(*) AS count FROM db_meta")?.count,
      1n,
    );
  } finally {
    db.close();
    home.cleanup();
  }
});

test("a failing bootstrap row rolls back every earlier row", () => {
  const home = isolated_home();
  const db = open_migrated(home);
  try {
    const clock = new FakeClock(START_MS);
    bootstrap_project(
      db,
      { slug: "synthetic-alpha", topic: "합성 정책 연구", owner_display_name: "합성 사용자" },
      { clock, new_id },
    );
    const before = state_signature(db);

    assert.throws(
      () =>
        bootstrap_project(
          db,
          {
            slug: "synthetic-alpha",
            topic: "다른 합성 연구",
            owner_display_name: "합성 사용자 둘",
          },
          { clock, new_id },
        ),
      /UNIQUE/,
    );
    assert.equal(state_signature(db), before);

    const counts = table_counts(db);
    assert.equal(counts.users, 1n);
    assert.equal(counts.actors, 1n);
    assert.equal(counts.projects, 1n);
    assert.equal(counts.mutation_commits, 1n);
    assert.equal(counts.project_policy_versions, 1n);
  } finally {
    db.close();
    home.cleanup();
  }
});

test("a failure injected mid-bootstrap after real writes leaves zero business rows", () => {
  const home = isolated_home();
  const real = open_migrated(home);
  const counted = count_runs(real);
  const clock = new FakeClock(START_MS);
  const before = state_signature(real);
  try {
    let calls = 0;
    let runs_at_failure = 0;
    let projects_at_failure = 0n;
    let stages_at_failure = 0n;
    const failing_ids = (): string => {
      calls += 1;
      if (calls === 10) {
        // Six ids are allocated before the first INSERT, then stages call
        // new_id once each. Failing on the fourth stage id means the first
        // three stages (and every earlier row) were really written already.
        runs_at_failure = counted.run_calls();
        projects_at_failure =
          real.get<{ count: bigint }>("SELECT count(*) AS count FROM projects")?.count ?? 0n;
        stages_at_failure =
          real.get<{ count: bigint }>("SELECT count(*) AS count FROM stages")?.count ?? 0n;
        throw new Error("injected new_id failure");
      }
      return new_id();
    };

    assert.throws(
      () =>
        bootstrap_project(
          counted.db,
          { slug: "synthetic-gamma", topic: "합성 주입 연구", owner_display_name: "합성 사용자" },
          { clock, new_id: failing_ids },
        ),
      /injected new_id failure/,
    );

    assert.ok(runs_at_failure > 0, "the injected failure must happen after real SQL writes");
    assert.equal(projects_at_failure, 1n);
    assert.equal(stages_at_failure, 3n);
    assert.equal(state_signature(real), before);

    const counts = table_counts(real);
    for (const [table, rows] of Object.entries(counts)) {
      if (table === "db_meta") continue;
      assert.equal(rows, 0n, `${table} must stay empty after rollback`);
    }
    assert.equal(
      real.get<{ count: bigint }>("SELECT count(*) AS count FROM db_meta")?.count,
      1n,
    );

    // Rollback leaves a usable database: a clean bootstrap now succeeds.
    const retry = bootstrap_project(
      real,
      { slug: "synthetic-gamma-retry", topic: "합성 재시도 연구", owner_display_name: "합성 사용자" },
      { clock, new_id },
    );
    assert.equal(
      real.get<{ count: bigint }>("SELECT count(*) AS count FROM stages WHERE project_id = ?", retry.project_id)
        ?.count,
      6n,
    );
  } finally {
    real.close();
    home.cleanup();
  }
});

test("bootstrap rejects empty input before writing", () => {
  const home = isolated_home();
  const db = open_migrated(home);
  const clock = new FakeClock(START_MS);
  try {
    assert.throws(
      () =>
        bootstrap_project(
          db,
          { slug: "  ", topic: "합성 연구", owner_display_name: "합성 사용자" },
          { clock, new_id },
        ),
      /slug/,
    );
    assert.equal(
      db.get<{ count: bigint }>("SELECT count(*) AS count FROM projects")?.count,
      0n,
    );
  } finally {
    db.close();
    home.cleanup();
  }
});
