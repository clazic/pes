// Unit tests of tests/helpers/path_compare.ts with Windows-shaped strings (they run on every OS; CI windows-latest only proves the real thing).
import assert from "node:assert/strict";
import { test } from "node:test";

import { is_at_or_below, path_key } from "./helpers/path_compare.ts";
import { use_home_guard } from "./helpers/home_guard.ts";

use_home_guard();

test("path_key: separators, repeated slashes, the permission `\\*` tail and a trailing slash fold; case folds only when asked (win32)", () => {
  assert.equal(path_key("C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\pes-x\\*", true), "c:/users/runner~1/appdata/local/temp/pes-x");
  assert.equal(path_key("C:/Users/runneradmin/Temp//pes-x/", true), "c:/users/runneradmin/temp/pes-x");
  assert.equal(path_key("/var/folders/ab/T/pes-x/*", false), "/var/folders/ab/T/pes-x");
  assert.equal(path_key("/Var/Folders", false), "/Var/Folders", "POSIX stays case-sensitive");
  assert.equal(path_key("/", false), "/");
});

test("is_at_or_below: a Windows long/short, upper/lower, back/forward-slash spelling of the same folder matches; a sibling does not", () => {
  const root = "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\pes-compat-e01-abc";
  assert.ok(is_at_or_below("c:/users/runneradmin/appdata/local/temp/PES-COMPAT-E01-ABC", root, true));
  assert.ok(is_at_or_below("C:\\Users\\runneradmin\\AppData\\Local\\Temp\\pes-compat-e01-abc\\*", root, true), "the `\\*` flag value");
  assert.ok(is_at_or_below("C:\\Users\\runneradmin\\AppData\\Local\\Temp\\pes-compat-e01-abc\\work\\x.json", root, true));
  assert.ok(!is_at_or_below("C:\\Users\\runneradmin\\AppData\\Local\\Temp\\pes-compat-e01-abcd", root, true), "a name that only starts the same is a sibling");
  assert.ok(!is_at_or_below("C:\\Users\\runneradmin\\.pes", root, true));
  assert.ok(!is_at_or_below("/Tmp/Pes-X/y", "/tmp/pes-x", false), "POSIX: case matters");
  assert.ok(is_at_or_below("/tmp/pes-x/y/*", "/tmp/pes-x", false));
});
