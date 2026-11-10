// SEL-43 PR10 final-review 2/2 recommendation 2 (writing mode). Everything is synthetic.
//
// The policy checker gets a read-only view of the transaction. Two layers protect it:
//   (a) SQLite PRAGMA query_only=ON while the checker runs, and
//   (b) a statement check that only lets one SELECT / WITH statement through.
// The statement check alone is NOT read-only: "WITH x AS (SELECT 1) UPDATE ..." starts with WITH.
// So when the Db adapter cannot report or set query_only, the protection would silently be gone.
//
// Required behaviour (the current implementation does not have it yet, so these tests fail):
//   A. If PRAGMA query_only cannot be read (throws / returns no row) or cannot be set (throws /
//      is ignored), the checker is NOT run and the command fails closed: no receipt, no event, no
//      row of any kind is written.
//   B. The statement check itself refuses WITH ... UPDATE / INSERT / DELETE / REPLACE (any case,
//      comments, whitespace) and still accepts WITH ... SELECT.
//
// (A) uses a synthetic Db that wraps a real SqliteDb and breaks only the query_only PRAGMA.
// (B) calls the exported assert_single_read_statement directly, so it does not depend on (A).

import assert from "node:assert/strict";
import { test } from "node:test";

import { FakeClock } from "../scripts/pes_core/clock.ts";
import { connect, migrate, type Db, type SqlValue } from "../scripts/pes_core/db.ts";
import {
  CommandService,
  type MutationContext,
  type PolicyChecker,
  type PolicyDecision,
} from "../scripts/pes_core/commands.ts";
import { assert_single_read_statement } from "../scripts/pes_core/commands/shared.ts";
import type { RunConfig } from "../scripts/pes_core/config.ts";
import { issue_agent_token } from "../scripts/pes_core/actors.ts";
import { DbPolicyChecker } from "../scripts/pes_core/policy.ts";
import { db_path } from "../scripts/pes_core/paths.ts";
import { isolated_home, type IsolatedHome } from "./helpers/isolated_home.ts";
import { state_signature } from "./helpers/state_signature.ts";

const START_MS = 1_760_000_000_000;
const TEST_CONFIG: RunConfig = { lease_ttl_ms: 60_000, heartbeat_interval_ms: 20_000 };
const QUERY_ONLY_PRAGMA = /^\s*PRAGMA\s+query_only\s*(=\s*\w+\s*)?;?\s*$/i;

// ---------------------------------------------------------------------------
// A synthetic Db adapter that breaks only the query_only PRAGMA

type Sabotage =
  | "none" // control: a plain pass-through must keep working
  | "get_throws" // PRAGMA query_only (read) throws
  | "get_empty" // PRAGMA query_only (read) returns no row
  | "set_throws" // PRAGMA query_only = ... (write) throws
  | "set_ignored"; // PRAGMA query_only = ... (write) is accepted but does nothing

function broken_adapter(db: Db, sabotage: Sabotage): Db {
  const is_read = (sql: string) => QUERY_ONLY_PRAGMA.test(sql) && !sql.includes("=");
  const is_write = (sql: string) => QUERY_ONLY_PRAGMA.test(sql) && sql.includes("=");
  return {
    path: db.path,
    prepare: (sql) => db.prepare(sql),
    run: (sql, ...params: SqlValue[]) => db.run(sql, ...params),
    close: () => db.close(),
    exec: (sql) => {
      if (is_write(sql)) {
        if (sabotage === "set_throws") throw new Error("synthetic adapter: PRAGMA query_only cannot be set");
        if (sabotage === "set_ignored") return;
      }
      db.exec(sql);
    },
    get: <T>(sql: string, ...params: SqlValue[]) => {
      if (is_read(sql)) {
        if (sabotage === "get_throws") throw new Error("synthetic adapter: PRAGMA is not supported");
        if (sabotage === "get_empty") return undefined;
      }
      return db.get<T>(sql, ...params);
    },
    all: <T>(sql: string, ...params: SqlValue[]) => db.all<T>(sql, ...params),
  };
}

// ---------------------------------------------------------------------------
// Harness

interface Env {
  home: IsolatedHome;
  db: Db; // the real SqliteDb, for looking at the truth
  service: CommandService; // runs on the broken adapter
  project_id: string;
  owner_actor_id: string;
  ctx(key: string): MutationContext;
  close(): void;
}

let seq = 0;

async function make_env(sabotage: Sabotage, policy: PolicyChecker): Promise<Env> {
  seq += 1;
  const home = isolated_home("pes-sel43r-");
  const db = connect(db_path(home.env));
  migrate(db);
  const clock = new FakeClock(START_MS);
  // Bootstrap runs on the real db with the real checker; the broken adapter comes after.
  const boot = new CommandService(db, { clock, policy: new DbPolicyChecker(), run_config: TEST_CONFIG });
  const out = await boot.execute(
    { project_id: null, actor_id: null, via: "cli", client_request_id: "setup-p" },
    "project.bootstrap",
    { slug: `synthetic-readonly-${seq}`, topic: "합성 읽기 전용 주제", owner_display_name: "합성 소유자" },
  );
  const r = out.result as { project_id: string; owner_actor_id: string; owner_user_id: string };
  db.run(
    "INSERT INTO actors (id, kind, user_id, display_name) VALUES ('agent-ro', 'external_agent', ?, '합성 에이전트')",
    r.owner_user_id,
  );
  const service = new CommandService(broken_adapter(db, sabotage), { clock, policy, run_config: TEST_CONFIG });
  return {
    home,
    db,
    service,
    project_id: r.project_id,
    owner_actor_id: r.owner_actor_id,
    ctx: (key) => ({ project_id: r.project_id, actor_id: r.owner_actor_id, via: "cli", client_request_id: key }),
    close() {
      db.close();
      home.cleanup();
    },
  };
}

function topic_of(env: Env): string {
  const row = env.db.get<{ topic: string }>("SELECT topic FROM projects WHERE id = ?", env.project_id);
  assert.ok(row);
  return row.topic;
}

/** Allows everything, counts its calls and, when it runs, tries the WITH ... UPDATE write of the review. */
class WritingChecker implements PolicyChecker {
  calls = 0;
  readonly project_id: () => string;

  constructor(project_id: () => string) {
    this.project_id = project_id;
  }

  check(
    _ctx: MutationContext,
    command: string,
    _payload: unknown,
    db: Pick<Db, "get" | "all">,
  ): PolicyDecision {
    if (command !== "token.issue") return { allowed: true };
    this.calls += 1;
    try {
      db.get(
        "WITH x AS (SELECT 1) UPDATE projects SET topic = 'synthetic fallback write' WHERE id = ? RETURNING topic",
        this.project_id(),
      );
    } catch {
      // a closed door is fine; the test looks at the data
    }
    return { allowed: true };
  }
}

// ---------------------------------------------------------------------------
// A. Fail closed when query_only cannot be read or set

test("A0 control: a pass-through adapter runs the checker and the command succeeds", async () => {
  let id = "";
  const checker = new WritingChecker(() => id);
  const env = await make_env("none", checker);
  try {
    id = env.project_id;
    const topic = topic_of(env);
    const out = await issue_agent_token(env.service, env.ctx("a0-issue"), { actor_id: "agent-ro", scopes: ["run"] });
    assert.ok(out);
    assert.equal(checker.calls, 1, "the checker ran once");
    // with a working query_only the WITH ... UPDATE could not write
    assert.equal(topic_of(env), topic);
    assert.ok(env.db.get("SELECT 1 FROM agent_tokens WHERE actor_id = 'agent-ro'"));
  } finally {
    env.close();
  }
});

const BROKEN: Array<[Sabotage, string]> = [
  ["get_throws", "reading PRAGMA query_only throws"],
  ["get_empty", "reading PRAGMA query_only returns no row"],
  ["set_throws", "setting PRAGMA query_only throws"],
  ["set_ignored", "setting PRAGMA query_only is silently ignored"],
];

for (const [sabotage, label] of BROKEN) {
  test(`A1 (${sabotage}) ${label}: the checker does not run, the command fails, nothing is written`, async () => {
    let id = "";
    const checker = new WritingChecker(() => id);
    const env = await make_env(sabotage, checker);
    try {
      id = env.project_id;
      const topic = topic_of(env);
      const before = state_signature(env.db);

      await assert.rejects(
        issue_agent_token(env.service, env.ctx(`a1-${sabotage}`), { actor_id: "agent-ro", scopes: ["run"] }),
        /./,
        "the command must fail when the read-only protection cannot be established",
      );

      assert.equal(checker.calls, 0, "the policy checker must not run without a read-only protection");
      assert.equal(topic_of(env), topic, "the topic is unchanged (WITH ... UPDATE did not get through)");
      assert.equal(env.db.get("SELECT 1 FROM agent_tokens WHERE actor_id = 'agent-ro'"), undefined, "no token row");
      assert.equal(
        env.db.get("SELECT 1 FROM mutation_commits WHERE project_id = ? AND client_request_id = ?", env.project_id, `a1-${sabotage}`),
        undefined,
        "no receipt",
      );
      assert.equal(state_signature(env.db), before, "no receipt, no event, no row of any table changed");
    } finally {
      env.close();
    }
  });

  test(`A2 (${sabotage}) the real DbPolicyChecker fails closed too: ${label}`, async () => {
    const env = await make_env(sabotage, new DbPolicyChecker());
    try {
      const before = state_signature(env.db);
      await assert.rejects(
        issue_agent_token(env.service, env.ctx(`a2-${sabotage}`), { actor_id: "agent-ro", scopes: ["run"] }),
      );
      assert.equal(state_signature(env.db), before, "nothing was written");
    } finally {
      env.close();
    }
  });
}

test("A3 a failed command on a broken adapter can be retried once the adapter works (no stuck receipt or state)", async () => {
  // The same database, first through a broken adapter, then through a healthy one.
  let id = "";
  const checker = new WritingChecker(() => id);
  const env = await make_env("get_throws", checker);
  try {
    id = env.project_id;
    await assert.rejects(issue_agent_token(env.service, env.ctx("a3-key"), { actor_id: "agent-ro", scopes: ["run"] }));
    assert.equal(checker.calls, 0);

    const healthy = new CommandService(env.db, {
      clock: new FakeClock(START_MS),
      policy: new DbPolicyChecker(),
      run_config: TEST_CONFIG,
    });
    const out = await issue_agent_token(healthy, env.ctx("a3-key"), { actor_id: "agent-ro", scopes: ["run"] });
    assert.ok(out);
    assert.ok(env.db.get("SELECT 1 FROM agent_tokens WHERE actor_id = 'agent-ro'"));
  } finally {
    env.close();
  }
});

// ---------------------------------------------------------------------------
// B. The statement check on its own

const WRITE = {
  update: "UPDATE projects SET topic = 'synthetic' WHERE id = 'p'",
  insert: "INSERT INTO users (id, display_name, created_at) VALUES ('u', 'u', 0)",
  insert_or_replace: "INSERT OR REPLACE INTO users (id, display_name, created_at) VALUES ('u', 'u', 0)",
  replace: "REPLACE INTO users (id, display_name, created_at) VALUES ('u', 'u', 0)",
  delete: "DELETE FROM users WHERE id = 'u'",
};

const REJECTED: Array<[string, string]> = [];
for (const [kind, stmt] of Object.entries(WRITE)) {
  REJECTED.push(
    [`WITH ... ${kind}`, `WITH x AS (SELECT 1) ${stmt}`],
    [`lowercase with ... ${kind}`, `with x as (select 1) ${stmt.toLowerCase()}`],
    [`mixed case With ... ${kind}`, `With x As (Select 1) ${stmt}`],
    [`leading block comment ${kind}`, `/* c */ WITH x AS (SELECT 1) ${stmt}`],
    [`comment between CTE and ${kind}`, `WITH x AS (SELECT 1) /* c */ ${stmt}`],
    [`comment inside WITH ${kind}`, `WITH /* c */ x /* d */ AS /* e */ (SELECT 1) ${stmt}`],
    [`line comments ${kind}`, `-- c\nWITH x AS (SELECT 1) -- d\n${stmt}`],
    [`tabs and newlines ${kind}`, `\n\t WITH\n\tx\tAS\n(SELECT 1)\n\t${stmt}`],
    [`two CTEs ${kind}`, `WITH a AS (SELECT 1), b AS (SELECT 2) ${stmt}`],
    [`RECURSIVE ${kind}`, `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3) ${stmt}`],
    [`nested parens ${kind}`, `WITH x AS (SELECT (1 + (2 * 3)) WHERE (1 = 1)) ${stmt}`],
    [`returning ${kind}`, `WITH x AS (SELECT 1) ${stmt} RETURNING 1`],
  );
}

for (const [label, sql] of REJECTED) {
  test(`B1 statement check refuses: ${label}`, () => {
    assert.throws(() => assert_single_read_statement(sql), /./, sql);
  });
}

const ACCEPTED: Array<[string, string]> = [
  ["select", "SELECT id FROM projects WHERE id = ?"],
  ["lowercase select", "select id from projects where id = ?"],
  ["with select", "WITH p AS (SELECT id FROM projects) SELECT id FROM p"],
  ["lowercase with select", "with p as (select id from projects) select id from p"],
  ["mixed case with select", "With p As (Select 1 As one) Select one From p"],
  ["leading comments", "/* c */ -- d\nWITH p AS (SELECT 1 AS one) SELECT one FROM p"],
  ["comment between CTE and SELECT", "WITH p AS (SELECT 1 AS one) /* c */ SELECT one FROM p"],
  ["tabs and newlines", "\n\t WITH\n\tp\tAS\n(SELECT 1 AS one)\n\tSELECT one FROM p"],
  ["two CTEs", "WITH a AS (SELECT 1 AS n), b AS (SELECT 2 AS n) SELECT a.n + b.n FROM a, b"],
  ["recursive", "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3) SELECT i FROM n"],
  ["write keywords inside string literals", "WITH x AS (SELECT 'UPDATE users SET a = 1' AS s) SELECT s FROM x"],
  ["write keywords inside a comment", "WITH x AS (SELECT 1 AS one) /* DELETE FROM users */ SELECT one FROM x"],
  ["write keywords inside quoted identifiers", 'WITH x AS (SELECT 1 AS "update", 2 AS "delete") SELECT "update", "delete" FROM x'],
  ["replace() function is not REPLACE INTO", "WITH x AS (SELECT replace('abc', 'b', 'c') AS r) SELECT r FROM x"],
  ["trailing semicolon", "WITH x AS (SELECT 1 AS one) SELECT one FROM x;"],
];

for (const [label, sql] of ACCEPTED) {
  test(`B2 statement check accepts: ${label}`, () => {
    assert.doesNotThrow(() => assert_single_read_statement(sql), sql);
  });
}
