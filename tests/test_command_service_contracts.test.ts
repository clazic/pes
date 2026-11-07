/**
 * SEL-37 PR4 — contract hardening (tester, 보강 모드 3차).
 *
 * Pins c424cb6: (1) the language-neutral request_hash vectors in
 * tests/fixtures/contracts/request_hash/*.json, compared with the receipt's
 * request_hash column written by the service; (2) the conflict translation
 * exposes no table/column names; (3) FOREIGN KEY / NOT NULL / CHECK violations
 * are not turned into "conflict" and roll back completely.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { FakeClock } from "../scripts/pes_core/clock.ts";
import { connect, migrate, type Db } from "../scripts/pes_core/db.ts";
import { ApiError, error_envelope } from "../scripts/pes_core/errors.ts";
import {
  CommandService,
  type MutationContext,
  type PolicyChecker,
  type PolicyDecision,
} from "../scripts/pes_core/commands.ts";
import { db_path } from "../scripts/pes_core/paths.ts";
import { isolated_home, type IsolatedHome } from "./helpers/isolated_home.ts";
import { state_signature } from "./helpers/state_signature.ts";

const START_MS = 1_760_000_000_000;
const HERE = dirname(fileURLToPath(import.meta.url));
const VECTOR_DIR = resolve(HERE, "fixtures", "contracts", "request_hash");

class AllowPolicy implements PolicyChecker {
  check(): PolicyDecision {
    return { allowed: true };
  }
}

interface Env {
  home: IsolatedHome;
  db: Db;
  service: CommandService;
  project_id: string;
  actor_id: string;
  close(): void;
}

const BOOT = (key: string): MutationContext => ({
  project_id: null,
  actor_id: null,
  via: "cli",
  client_request_id: key,
});

async function make_env(new_id?: () => string): Promise<Env> {
  const home = isolated_home("pes-sel37-contract-");
  const db = connect(db_path(home.env));
  migrate(db);
  const service = new CommandService(db, {
    clock: new FakeClock(START_MS),
    policy: new AllowPolicy(),
    ...(new_id === undefined ? {} : { new_id }),
  });
  const out = await service.execute(BOOT("setup"), "project.bootstrap", {
    slug: "synthetic-contract",
    topic: "합성 주제",
    owner_display_name: "합성 소유자",
  });
  const r = out.result as { project_id: string; owner_actor_id: string };
  return {
    home,
    db,
    service,
    project_id: r.project_id,
    actor_id: r.owner_actor_id,
    close() {
      db.close();
      home.cleanup();
    },
  };
}

async function with_env(fn: (env: Env) => Promise<void> | void): Promise<void> {
  const env = await make_env();
  try {
    await fn(env);
  } finally {
    env.close();
  }
}

function assert_no_open_tx(db: Db): void {
  db.exec("BEGIN IMMEDIATE");
  db.exec("ROLLBACK");
}

// ---------------------------------------------------------------------------
// request_hash vectors

interface Vector {
  name: string;
  command: string;
  ctx: { via: MutationContext["via"]; client_request_id: string; base_control_rev: number };
  payload: unknown;
  canonical: string;
  sha256: string;
}

const vector_files = readdirSync(VECTOR_DIR)
  .filter((f) => f.endsWith(".json"))
  .sort();

test("request_hash fixtures exist and include the documented example", () => {
  assert.ok(vector_files.length >= 6, "expected a set of request_hash vectors");
  const spec = JSON.parse(readFileSync(join(VECTOR_DIR, "spec_example.json"), "utf8")) as Vector;
  assert.equal(spec.command, "project.set_topic");
  assert.equal(spec.sha256, "54877204a50ae33ca4e175d46813a1f760859a78124c138ea3d66c83eb0fc3fa");
});

for (const file of vector_files) {
  const vector = JSON.parse(readFileSync(join(VECTOR_DIR, file), "utf8")) as Vector;

  test(`request_hash vector ${vector.name}: sha256 of command\\ncanonical matches the fixture`, () => {
    const digest = createHash("sha256").update(`${vector.command}\n${vector.canonical}`, "utf8").digest("hex");
    assert.equal(digest, vector.sha256);
    assert.match(vector.sha256, /^[0-9a-f]{64}$/);
  });

  test(`request_hash vector ${vector.name}: the service's receipt request_hash equals the fixture`, async () => {
    await with_env(async (env) => {
      const out = await env.service.execute(
        {
          project_id: env.project_id,
          actor_id: env.actor_id,
          via: vector.ctx.via,
          client_request_id: vector.ctx.client_request_id,
          base_control_rev: vector.ctx.base_control_rev,
        },
        vector.command,
        vector.payload,
      );
      assert.equal(out.replayed, false);
      const row = env.db.get<{ request_hash: string }>(
        "SELECT request_hash FROM mutation_commits WHERE project_id = ? AND client_request_id = ?",
        env.project_id,
        vector.ctx.client_request_id,
      );
      assert.equal(row?.request_hash, vector.sha256);
    });
  });
}

test("request_hash: vectors with the same command and payload but different ctx share one hash", () => {
  const a = JSON.parse(readFileSync(join(VECTOR_DIR, "spec_example.json"), "utf8")) as Vector;
  const b = JSON.parse(readFileSync(join(VECTOR_DIR, "ctx_via_web_ignored.json"), "utf8")) as Vector;
  assert.notEqual(a.ctx.via, b.ctx.via);
  assert.deepEqual(a.payload, b.payload);
  assert.equal(a.sha256, b.sha256);
});

test("request_hash: the same-key replay of a vector with a reordered payload is a replay, a changed value is a key reuse", async () => {
  await with_env(async (env) => {
    const ctx = (): MutationContext => ({
      project_id: env.project_id,
      actor_id: env.actor_id,
      via: "cli",
      client_request_id: "vec-replay",
      base_control_rev: 0,
    });
    const first = await env.service.execute(ctx(), "project.set_topic", { n: 1, topic: "가" });
    assert.equal(first.replayed, false);
    const reordered = await env.service.execute(ctx(), "project.set_topic", { topic: "가", n: 1 });
    assert.equal(reordered.replayed, true);
    await assert.rejects(
      env.service.execute(ctx(), "project.set_topic", { n: 2, topic: "가" }),
      (e: unknown) => e instanceof ApiError && e.code === "idempotency_key_reuse",
    );
  });
});

// ---------------------------------------------------------------------------
// conflict message does not leak schema names

const LEAK_WORDS = [
  "projects",
  "users",
  "actors",
  "slug",
  "owner_user_id",
  "mutation_commits",
  "events",
  "constraint failed",
  "sqlite",
  "SQLITE",
  "projects.id",
  "projects.slug",
];

function assert_no_leak(error: ApiError): void {
  const serialized = JSON.stringify({ message: error.message, details: error.details, envelope: error_envelope(error) });
  for (const word of LEAK_WORDS) {
    assert.ok(!serialized.toLowerCase().includes(word.toLowerCase()), `conflict output leaks "${word}": ${serialized}`);
  }
}

test("conflict (UNIQUE slug): fixed wording, no table/column names in message, details or envelope", async () => {
  await with_env(async (env) => {
    const before = state_signature(env.db);
    let caught: unknown;
    try {
      await env.service.execute(BOOT("dup-slug"), "project.bootstrap", {
        slug: "synthetic-contract",
        topic: "x",
        owner_display_name: "y",
      });
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof ApiError, "expected ApiError");
    assert.equal(caught.code, "conflict");
    assert.equal(caught.message, "UNIQUE constraint conflict");
    assert_no_leak(caught);
    assert.equal(state_signature(env.db), before);
    assert_no_open_tx(env.db);
  });
});

test("conflict (PRIMARY KEY id collision): same fixed wording and no leak", async () => {
  const env = await make_env();
  try {
    const constant = new CommandService(env.db, {
      clock: new FakeClock(START_MS),
      policy: new AllowPolicy(),
      new_id: () => "same-id",
    });
    // every generated id is "same-id", so the second INSERT hits a PRIMARY KEY/UNIQUE collision
    const before = state_signature(env.db);
    let caught: unknown;
    try {
      await constant.execute(BOOT("pk-1"), "project.bootstrap", { slug: "pk-b", topic: "t", owner_display_name: "o" });
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof ApiError);
    assert.equal(caught.code, "conflict");
    assert.equal(caught.message, "UNIQUE constraint conflict");
    assert_no_leak(caught);
    assert.equal(state_signature(env.db), before);
    assert_no_open_tx(env.db);
  } finally {
    env.close();
  }
});

// ---------------------------------------------------------------------------
// FK / NOT NULL / CHECK are not conflicts and roll back

const VIOLATIONS: Array<{ name: string; sql: string; pattern: RegExp }> = [
  {
    name: "FOREIGN KEY",
    sql: "INSERT INTO project_members (project_id, user_id, role) VALUES ('no-such-project', 'no-such-user', 'reader')",
    pattern: /FOREIGN KEY/i,
  },
  {
    name: "NOT NULL",
    sql: "INSERT INTO users (id, display_name, created_at) VALUES ('trigger-user', NULL, 0)",
    pattern: /NOT NULL/i,
  },
  {
    name: "CHECK",
    sql: "INSERT INTO users (id, display_name, created_at) VALUES ('trigger-user', '', 0)",
    pattern: /CHECK/i,
  },
];

for (const violation of VIOLATIONS) {
  test(`${violation.name} violation inside a command is not translated to conflict and rolls back; the key is reusable`, async () => {
    await with_env(async (env) => {
      env.db.exec(
        `CREATE TEMP TRIGGER test_violation AFTER UPDATE OF topic ON projects
         BEGIN ${violation.sql}; END`,
      );
      const ctx = (): MutationContext => ({
        project_id: env.project_id,
        actor_id: env.actor_id,
        via: "cli",
        client_request_id: "viol-key",
        base_control_rev: 0,
      });
      const before = state_signature(env.db);
      let caught: unknown;
      try {
        await env.service.execute(ctx(), "project.set_topic", { topic: "새 주제" });
      } catch (e) {
        caught = e;
      }
      assert.ok(caught instanceof Error, "expected the command to fail");
      assert.ok(!(caught instanceof ApiError && caught.code === "conflict"), `${violation.name} became a conflict`);
      assert.match((caught as Error).message, violation.pattern, "the original SQLite error is rethrown");
      assert.equal(state_signature(env.db), before, "topic, rev, events and receipts all rolled back");
      assert_no_open_tx(env.db);
      assert.deepEqual(env.db.all("PRAGMA foreign_key_check"), []);

      env.db.exec("DROP TRIGGER test_violation");
      const ok = await env.service.execute(ctx(), "project.set_topic", { topic: "새 주제" });
      assert.equal(ok.replayed, false, "a failed attempt leaves no receipt, so the same key runs fresh");
      assert.equal(
        env.db.get<{ topic: string }>("SELECT topic FROM projects WHERE id = ?", env.project_id)?.topic,
        "새 주제",
      );
    });
  });
}
