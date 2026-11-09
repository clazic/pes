/**
 * SEL-37 PR4 — regression: the read-only COMMANDS registry must not leak the
 * internal command table through any callback argument or iterator.
 * (Final review 1: forEach passed the real Map as the third callback argument.)
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { FakeClock } from "../scripts/pes_core/clock.ts";
import { connect, migrate, type Db } from "../scripts/pes_core/db.ts";
import { COMMANDS, CommandService, type MutationContext } from "../scripts/pes_core/commands.ts";
import { db_path } from "../scripts/pes_core/paths.ts";
import { EXPECTED_COMMAND_NAMES } from "./helpers/command_names.ts";
import { isolated_home } from "./helpers/isolated_home.ts";

const REAL_NAMES = [...EXPECTED_COMMAND_NAMES];
const INJECTED = "synthetic.injected";

function registry_names(): string[] {
  return [...COMMANDS.keys()].sort();
}

/** Remove anything a leaked Map would have gained, so one failure does not cascade. */
function cleanup_leak(leaked: unknown): void {
  try {
    (leaked as Map<string, unknown>).delete(INJECTED);
  } catch {
    // not a mutable map: nothing to clean
  }
}

test("forEach: third callback argument is COMMANDS itself, not the internal Map", () => {
  const seen: unknown[] = [];
  COMMANDS.forEach((_d, _n, map) => {
    seen.push(map);
  });
  assert.equal(seen.length, EXPECTED_COMMAND_NAMES.length);
  for (const map of seen) {
    try {
      assert.strictEqual(map, COMMANDS, "third argument must be the public read-only view");
    } finally {
      if (map !== COMMANDS) cleanup_leak(map);
    }
  }
});

test("forEach: thisArg is preserved", () => {
  const marker = { tag: "this-arg" };
  const thises: unknown[] = [];
  COMMANDS.forEach(function (this: unknown) {
    thises.push(this);
  }, marker);
  assert.equal(thises.length, EXPECTED_COMMAND_NAMES.length);
  for (const t of thises) assert.strictEqual(t, marker);
});

test("forEach: callback arguments are (definition, name, registry) in registry order", () => {
  const rows: Array<[string, unknown]> = [];
  COMMANDS.forEach((definition, name) => {
    rows.push([name, definition]);
  });
  assert.deepEqual(rows.map((r) => r[0]), [...COMMANDS.keys()]);
  for (const [name, definition] of rows) assert.strictEqual(definition, COMMANDS.get(name));
});

test("forEach: the callback argument cannot set/delete/clear, and the registry stays unchanged", () => {
  const before = registry_names();
  const evil = COMMANDS.get("project.set_topic");
  COMMANDS.forEach((_d, _n, map) => {
    const m = map as unknown as Map<string, unknown>;
    try {
      assert.throws(() => m.set(INJECTED, evil), TypeError, "set must not be callable");
      assert.throws(() => m.delete("project.set_topic"), TypeError, "delete must not be callable");
      assert.throws(() => m.clear(), TypeError, "clear must not be callable");
      assert.throws(() => Map.prototype.set.call(m, INJECTED, evil), TypeError);
    } finally {
      cleanup_leak(m);
    }
  });
  assert.equal(COMMANDS.has(INJECTED), false);
  assert.equal(COMMANDS.size, EXPECTED_COMMAND_NAMES.length);
  assert.deepEqual(registry_names(), before);
  assert.deepEqual(before, REAL_NAMES);
  assert.equal(Object.keys(COMMANDS).length, COMMANDS.size, "own keys and size must agree");
});

test("forEach: an injection attempt through the callback argument leaves the service rejecting the name", async () => {
  const home = isolated_home("pes-sel37-leak-");
  const db: Db = connect(db_path(home.env));
  try {
    migrate(db);
    const service = new CommandService(db, {
      clock: new FakeClock(1_760_000_000_000),
      policy: { check: () => ({ allowed: true }) },
    });
    const out = await service.execute(
      { project_id: null, actor_id: null, via: "cli", client_request_id: "leak-setup" },
      "project.bootstrap",
      { slug: "synthetic-leak", topic: "합성 주제", owner_display_name: "합성 소유자" },
    );
    const r = out.result as { project_id: string; owner_actor_id: string };
    const rev = Number(
      db.get<{ control_rev: bigint }>("SELECT control_rev FROM projects WHERE id = ?", r.project_id)?.control_rev,
    );

    let leaked_map: unknown;
    COMMANDS.forEach((definition, name, map) => {
      leaked_map = map;
      if (name !== "project.set_topic") return;
      try {
        (map as unknown as Map<string, unknown>).set(INJECTED, definition);
      } catch {
        // refusing is the correct behavior
      }
    });

    const ctx: MutationContext = {
      project_id: r.project_id,
      actor_id: r.owner_actor_id,
      via: "cli",
      client_request_id: "leak-1",
      base_control_rev: rev,
    };
    try {
      await assert.rejects(
        () => service.execute(ctx, INJECTED, { topic: "injected" }),
        (e: unknown) => (e as { code?: string }).code === "unknown_command",
      );
      assert.notEqual(
        db.get<{ topic: string }>("SELECT topic FROM projects WHERE id = ?", r.project_id)?.topic,
        "injected",
      );
    } finally {
      cleanup_leak(leaked_map);
    }
  } finally {
    db.close();
    home.cleanup();
  }
});

test("other paths: entries/values/Symbol.iterator/keys hand out only definitions, names and own iterators", () => {
  const is_map_like = (x: unknown) => x instanceof Map || x instanceof Set;

  for (const [name, definition] of COMMANDS.entries()) {
    assert.equal(typeof name, "string");
    assert.equal(is_map_like(definition), false);
  }
  for (const [name, definition] of COMMANDS) {
    assert.equal(is_map_like(definition), false);
    assert.strictEqual(definition, COMMANDS.get(name));
  }
  for (const key of COMMANDS.keys()) assert.equal(typeof key, "string");

  // Iterators carry no mutator and no back-reference to the table.
  for (const it of [COMMANDS.keys(), COMMANDS.values(), COMMANDS.entries(), COMMANDS[Symbol.iterator]()]) {
    const bag = it as unknown as Record<string, unknown>;
    for (const m of ["set", "delete", "clear", "add"]) assert.equal(bag[m], undefined, `iterator.${m}`);
    assert.equal(is_map_like(it), false);
  }
});

test("other paths: every definition handed out is frozen (entries, values, iteration, get)", () => {
  const defs = new Set<unknown>([
    ...[...COMMANDS.entries()].map((e) => e[1]),
    ...COMMANDS.values(),
    ...[...COMMANDS].map((e) => e[1]),
    ...REAL_NAMES.map((n) => COMMANDS.get(n)),
  ]);
  assert.equal(defs.size, EXPECTED_COMMAND_NAMES.length, "all paths must hand out the same definition objects");
  for (const d of defs) {
    assert.equal(Object.isFrozen(d), true, "definition must be frozen");
    assert.throws(() => {
      (d as { action: string }).action = "hijacked";
    }, TypeError);
    assert.throws(() => {
      (d as { run: unknown }).run = () => ({});
    }, TypeError);
  }
});

test("other paths: the registry object itself is frozen and has no mutators or table accessors", () => {
  assert.equal(Object.isFrozen(COMMANDS), true);
  const bag = COMMANDS as unknown as Record<string, unknown>;
  for (const m of ["set", "delete", "clear"]) assert.equal(bag[m], undefined, m);
  assert.throws(() => {
    bag["synthetic.direct"] = 1;
  }, TypeError);
  assert.equal(COMMANDS.has("synthetic.direct"), false);
  assert.deepEqual(Object.getOwnPropertyNames(COMMANDS).sort(), REAL_NAMES);
  assert.deepEqual(Object.getOwnPropertySymbols(COMMANDS), []);
  assert.equal(Object.getPrototypeOf(COMMANDS) === Map.prototype, false, "must not inherit Map mutators");
});

test("other paths: a derived Map copy is detached from the registry", () => {
  const copy = new Map(COMMANDS);
  copy.set(INJECTED, COMMANDS.get("project.set_topic")!);
  copy.delete("project.bootstrap");
  assert.equal(COMMANDS.has(INJECTED), false);
  assert.equal(COMMANDS.has("project.bootstrap"), true);
  assert.deepEqual(registry_names(), REAL_NAMES);
});
