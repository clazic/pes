// SEL-103 — Codex final review 1/2 fixes for tests/helpers/temp_home_check.ts. Strings only: every "real home" below is a FAKE injected value, nothing real
// is opened (the checker never touches the file system; this file does not either).
//   F1  Windows namespace spellings of the real home (\\?\C:\…, \\.\C:\…, \??\C:\…, UNC admin share \\localhost\c$\…) are the SAME home — judged after normalising
//   F2  a path that is not absolute is refused: drive-relative (D: · D:foo) and, on Windows, root-relative (\srv\…) — the latter compared drive-agnostically
//   F3  the account-home SHAPE gets the same parent / protected-folder treatment as an explicit home
//   F4  the error message and the README run examples set one temp folder for HOME and USERPROFILE (bash expands $HOME before the assignment)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, win32 } from "node:path";
import { test } from "node:test";

import { assert_temp_home_env, real_home_problem } from "./helpers/temp_home_check.ts";
import { use_home_guard } from "./helpers/home_guard.ts";

use_home_guard();

const REPO = join(import.meta.dirname, "..");
const WIN_ACCT = ["C:\\Users\\hong"]; // fake account home, never opened
const win = (env: Record<string, string | undefined>, homes: readonly string[] = WIN_ACCT): string | undefined => real_home_problem(env, homes, "win32");
const posix = (env: Record<string, string | undefined>, homes: readonly string[] = ["/srv/acct/hong"]): string | undefined => real_home_problem(env, homes, "linux");

test("F1 a Windows namespace spelling of the account home (or of its parent / protected folders) is refused, with and without an injected home", () => {
  const same_home = [
    win32.toNamespacedPath("C:\\Users\\hong"), // \\?\C:\Users\hong
    "\\\\?\\c:\\users\\hong\\",
    "\\\\?\\C:\\Users\\hong\\..\\hong",
    "\\\\.\\C:\\Users\\hong",
    "\\??\\C:\\Users\\hong",
    "//?/C:/Users/hong",
    "\\\\?\\UNC\\localhost\\c$\\Users\\hong",
    "\\\\localhost\\c$\\Users\\hong",
    "\\\\127.0.0.1\\C$\\Users\\hong",
    "\\\\?\\UNC\\LOCALHOST\\C$\\Users\\hong\\",
  ];
  for (const spelling of same_home) {
    for (const homes of [WIN_ACCT, []]) {
      assert.match(String(win({ USERPROFILE: spelling }, homes)), /USERPROFILE/, `${spelling} (win32, ${homes.length} injected)`);
      assert.match(String(posix({ HOME: spelling }, homes)), /HOME/, `${spelling} (posix, ${homes.length} injected)`);
    }
  }
  for (const bad of ["\\\\?\\C:\\Users\\hong\\.pes", "\\\\?\\C:\\Users\\hong\\pes-projects\\p1", "\\\\localhost\\c$\\Users\\hong\\.claude", "\\\\?\\C:\\Users", "\\\\?\\C:\\"]) {
    assert.match(String(win({ USERPROFILE: bad })), /USERPROFILE/, bad);
  }
  // the account home itself may be handed in as a namespace path too
  assert.match(String(win({ USERPROFILE: "C:\\Users\\hong" }, [win32.toNamespacedPath("C:\\Users\\hong")])), /USERPROFILE/);
});

test("F1b namespace paths that cannot be read as a plain drive / folder are refused, not guessed", () => {
  for (const odd of ["\\\\?\\Volume{01234567-89ab-cdef-0123-456789abcdef}\\Users\\hong", "\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\Users\\hong", "\\\\.\\PhysicalDrive0", "\\\\?\\C:", "\\\\?\\"]) {
    assert.match(String(win({ USERPROFILE: odd })), /USERPROFILE/, odd);
  }
});

test("F1c ordinary temporary folders stay accepted in every spelling", () => {
  for (const ok of [
    "D:\\a\\_temp\\pes-test-home",
    "\\\\?\\D:\\a\\_temp\\pes-test-home",
    "\\\\localhost\\d$\\a\\_temp\\pes-test-home",
    "C:\\Users\\hong\\AppData\\Local\\Temp\\pes-test-home",
    "\\\\?\\C:\\Users\\hong\\AppData\\Local\\Temp\\pes-test-home",
    "\\\\fileserver\\share\\pes-test-home",
  ]) {
    assert.equal(win({ USERPROFILE: ok }), undefined, ok);
  }
  assert.equal(posix({ HOME: "/private/var/folders/ab/xyz/T/pes-test-home" }), undefined);
});

test("F2 a drive-relative path (D: · D:foo) is not absolute — refused, while D:\\Temp\\… stays accepted", () => {
  for (const relative of ["D:", "d:", "D:foo", "D:foo\\bar", "C:..\\x", "d:pes-test-home"]) {
    assert.match(String(win({ USERPROFILE: relative })), /USERPROFILE/, relative);
    assert.match(String(win({ USERPROFILE: relative }, [])), /USERPROFILE/, `${relative} (no injected home)`);
    assert.match(String(posix({ HOME: relative })), /HOME/, `${relative} (posix)`);
  }
  for (const ok of ["D:\\Temp\\pes-test-home", "D:/Temp/pes-test-home", "d:\\a\\_temp\\h"]) assert.equal(win({ USERPROFILE: ok }), undefined, ok);
});

test("F2b on Windows a root-relative path (no drive) is compared with the account homes without the drive — the real home cannot hide behind it", () => {
  const acct = ["C:\\srv\\acct\\hong"];
  for (const bad of ["\\srv\\acct\\hong", "/srv/acct/hong", "\\srv\\acct\\hong\\.pes", "\\srv\\acct", "\\srv\\acct\\hong\\pes-projects\\p"]) {
    assert.match(String(win({ USERPROFILE: bad }, acct)), /USERPROFILE/, bad);
  }
  assert.match(String(win({ USERPROFILE: "\\Users\\hong" }, [])), /USERPROFILE/, "the shape check needs no drive");
  assert.equal(win({ USERPROFILE: "\\srv\\acct\\other" }, acct), undefined);
});

test("F3 the account-home SHAPE protects its parents and its protected folders as an explicit home does", () => {
  for (const bad of [
    "/Users/alice/.pes",
    "/Users/alice/.pes/work",
    "/home/bob/.claude",
    "/home/bob/.claude/projects",
    "/root/.pes",
    "/Users/alice/pes-projects/p1",
    "/Users",
    "/home",
    "C:\\Users",
    "C:\\Users\\carol\\pes-projects",
    "D:\\Users\\dave\\.PES",
  ]) {
    assert.match(String(posix({ HOME: bad }, [])), /HOME/, bad);
    assert.match(String(win({ USERPROFILE: bad }, [])), /USERPROFILE/, bad);
  }
  for (const ok of [
    "/Users/alice/scratch/h",
    "/Users/alice/.pesx",
    "/Users/alice/pes-projects2",
    "/home/bob/.cache/pes-h",
    "/root/work/h",
    "C:\\Users\\carol\\AppData\\Local\\Temp\\pes-h",
    "/Users/runner/work/_temp/pes-test-home",
    "/var/folders/ab/xyz/T/pes-h",
    "D:\\a\\_temp\\pes-test-home",
  ]) {
    assert.equal(posix({ HOME: ok }, []), undefined, ok);
    assert.equal(win({ USERPROFILE: ok }, []), undefined, ok);
  }
});

test("F4 the error message and the README run examples use one temp folder for HOME and USERPROFILE (never USERPROFILE=\"$HOME\")", () => {
  let message = "";
  try {
    assert_temp_home_env({ HOME: "/srv/acct/hong" }, ["/srv/acct/hong"]);
  } catch (error) {
    message = String((error as Error).message);
  }
  assert.match(message, /임시 HOME/);
  assert.ok(!message.includes('USERPROFILE="$HOME"'), "bash would give USERPROFILE the HOME of BEFORE the assignment");
  assert.match(message, /test_home="\$\(mktemp -d\)"/);
  assert.match(message, /HOME="\$test_home" USERPROFILE="\$test_home" npm test/);

  for (const file of ["README.md", "tests/README.md", "AGENTS.md"]) {
    const text = readFileSync(join(REPO, file), "utf8");
    assert.ok(!text.includes('USERPROFILE="$HOME"'), `${file}: USERPROFILE="$HOME"`);
    for (const block of text.split("```").filter((_, index) => index % 2 === 1)) {
      if (!/^(?:sh|bash)\n/.test(block) || !/\bnpm test\b/.test(block)) continue;
      assert.match(block, /test_home=|tmp_home=|review_home=/, `${file}: a shell example runs npm test without a temp HOME:\n${block}`);
    }
  }
});
