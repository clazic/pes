import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join, sep } from "node:path";
import { test } from "node:test";

import { db_path, objects_dir, pes_dir } from "../scripts/pes_core/paths.ts";
import { run_node } from "./helpers/cli.ts";
import { isolated_home } from "./helpers/isolated_home.ts";

test("paths stay inside the isolated home and PES_HOME does not move the database", () => {
  const home = isolated_home();
  try {
    const home_dir = home.env.HOME ?? "";
    assert.equal(pes_dir(home.env), join(home_dir, ".pes"));
    assert.equal(db_path(home.env), join(home_dir, ".pes", "pes.db"));
    assert.equal(objects_dir(home.env), join(home_dir, ".pes", "objects"));

    assert.ok(db_path(home.env).startsWith(home.root + sep));
    assert.ok(objects_dir(home.env).startsWith(home.root + sep));
    assert.equal(existsSync(pes_dir(home.env)), false);

    const moved_projects = join(home.root, "other-projects");
    assert.equal(db_path({ ...home.env, PES_HOME: moved_projects }), db_path(home.env));
    assert.equal(objects_dir({ ...home.env, PES_HOME: moved_projects }), objects_dir(home.env));
  } finally {
    home.cleanup();
  }
  assert.equal(existsSync(home.root), false);
});

test("a missing or empty home variable is an error and never falls back to os.homedir", () => {
  const home = isolated_home();
  try {
    if (process.platform === "win32") {
      assert.throws(() => db_path({}), /USERPROFILE/);
      assert.throws(() => db_path({ HOME: home.env.HOME }), /USERPROFILE/);
      assert.throws(() => db_path({ USERPROFILE: "   " }), /USERPROFILE/);
    } else {
      assert.throws(() => db_path({}), /HOME/);
      assert.throws(() => db_path({ USERPROFILE: home.env.USERPROFILE }), /HOME/);
      assert.throws(() => db_path({ HOME: "   " }), /HOME/);
    }
  } finally {
    home.cleanup();
  }
});

test("child processes receive only the isolated environment", () => {
  const home = isolated_home();
  const before = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    PES_HOME: process.env.PES_HOME,
  };
  try {
    const result = run_node(home.env, [
      "-e",
      "console.log(process.env.HOME); console.log(process.env.PES_HOME);",
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split(/\r?\n/), [home.env.HOME, home.env.PES_HOME]);
    assert.equal(process.env.HOME, before.HOME);
    assert.equal(process.env.USERPROFILE, before.USERPROFILE);
    assert.equal(process.env.PES_HOME, before.PES_HOME);
  } finally {
    home.cleanup();
  }
});
