// SEL-72 (PR26c): the compat cases whose ts side is scripts/serve.ts (E08 E09 E13) or scripts/setup.ts (E14), run on the TS target no
// matter what PES_COMPAT_TARGET says, against the pinned 0.15 baseline (tests/fixtures/compat/baseline/<id>.json).
//
// "Implemented" is the comparison of compat_cases.compare_ts_record: every step (stdout / status / content type / body), the produced
// answers (D03: read from the DB submissions, spelled like 0.15's feedback/*.json) and feedback.log must equal the baseline. The
// intended differences used here: D03 (answers are submissions; the answer's `v` cursor is extra), D09, D12 (setup.ts has no python row
// and names `node scripts/setup.ts`). E15 (doctor --json) is a pes.ts command: it stays not_yet and is SEL-77's.
//
// Until scripts/serve.ts and scripts/setup.ts exist these fail (the harness answers "not_yet" for an implemented case).
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { answer_count_record, assert_case, case_def, load_table, run_case } from "./helpers/compat_cases.ts";
import { n1_time } from "./helpers/compat_normalize.ts";
import { use_home_guard } from "./helpers/home_guard.ts";
import { serve_fixture, touch_at } from "./helpers/serve_ts_env.ts";
import { SEL72_DONE, SEL72_KIND, SEL72_LEFT_TO_LATER } from "./helpers/sel72_scope.ts";

use_home_guard();

test("the SEL-72 completion list is exactly E08 E09 E13 E14, all marked implemented in cases.json; E15 (doctor) moved to SEL-77", () => {
  assert.deepEqual([...SEL72_DONE], ["E08", "E09", "E13", "E14"]);
  for (const id of SEL72_DONE) {
    const def = case_def(id);
    assert.equal(def.ts.status, "implemented", `${id} must be implemented in cases.json`);
    assert.equal(def.kind, SEL72_KIND[id], `${id}: kind`);
  }
  for (const id of SEL72_LEFT_TO_LATER) assert.equal(case_def(id).ts.status, "implemented", `${id} is doctor (pes.ts) — SEL-77 turned it on (SEL77_DONE)`);
  // nothing outside this issue's list was turned on by it
  const implemented = load_table().cases.filter((c) => c.ts.status === "implemented").map((c) => c.id);
  for (const id of SEL72_DONE) assert.ok(implemented.includes(id), id);
});

for (const id of SEL72_DONE) {
  test(`${id} on the ts target equals the 0.15 baseline`, { timeout: 240_000 }, async () => {
    await assert_case("ts", id);
  });
}

test("E15 on the ts target is SEL-77's (doctor is a pes.ts command): it runs and equals the baseline up to D08", { timeout: 240_000 }, async () => {
  const outcome = await run_case("ts", "E15");
  assert.equal(outcome.kind, "ran");
  await assert_case("ts", "E15");
});

// SEL-72 R1-1: E09's "count" is the number of answers, whatever second each one was named in.
test("E09 count: a burst split by a second boundary still counts every answer (names differ only by time/suffix)", () => {
  const doc = { text: "x" };
  // 12 answers: 5 named in second T1 (suffixes -2..-5), 7 in T2; after n1_time every k=1 name would collapse to one key
  const mk = (stamp: string, n: number) => Array.from({ length: n }, (_x, k) => ({ name: `plan-R1-${stamp}${k === 0 ? "" : `-${k + 1}`}.json`, doc }));
  const answers = [...mk("20261111-120000", 5), ...mk("20261111-120001", 7)];
  assert.equal(answers.length, 12);
  assert.equal(new Set(answers.map((a) => n1_time(a.name))).size < 12, true, "the normalised keys do collapse (the old count would be wrong)");
  assert.deepEqual(answer_count_record(answers), { count: "12" });
  // the same 12 inside one second give the same record
  assert.deepEqual(answer_count_record(mk("20261111-120000", 12)), { count: "12" });
  // a raw name used twice (an overwrite) is still caught
  assert.throws(() => answer_count_record([...mk("20261111-120000", 2), ...mk("20261111-120000", 1)]), /unique raw names/);
});

// SEL-74 (leader decision 2026-11-12): E13 above compares the 0.15 static serving on OLD folders (cases.json `serve_legacy`, nothing in the DB;
// the baseline is unchanged). The same paths for a project the DB serves are the database's — held here with E13's own mtimes and paths.
test("E13 DB variant: the same paths for a project in the DB — whoami / ping / 404s equal the baseline, /version is the DB cursor (not the E13 mtimes), the page is built from the DB", { timeout: 240_000 }, async () => {
  const fx = await serve_fixture("pes-e13-db-");
  try {
    const { server, root } = fx;
    touch_at(join(root, "synthetic", "index.html"), 1_600_000_000);
    touch_at(join(root, "synthetic", "ask-plan.html"), 1_600_000_010);
    touch_at(join(root, "index.html"), 1_600_000_020);
    const base = (id: string, step: number) => (JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "compat", "baseline", `${id}.json`), "utf8")) as { steps: any[] }).steps[step];
    // unchanged by where the project lives: same status / content type / cache-control / body as the 0.15 record
    const same = async (path: string, step: number, body_of: (text: string) => unknown = (text) => text) => {
      const want = base("E13", step);
      assert.equal(want.step.path, path);
      const got = await server.request(path);
      assert.equal(got.status, want.status, path);
      assert.equal(got.headers["content-type"], want.content_type, path);
      assert.equal(got.headers["cache-control"], want.cache_control, path);
      return { got, want, body: body_of(got.text()) };
    };
    assert.deepEqual((await same("/ping", 1, (t) => JSON.parse(t))).body, { ok: true });
    assert.deepEqual((await same("/synthetic/ping", 2, (t) => JSON.parse(t))).body, { ok: true });
    for (const [path, step] of [["/synthetic/feedback/", 8], ["/nope/", 9], ["/..%2f..%2fetc/passwd", 10], ["/bad slug!/", 11]] as const) await same(path, step);
    // /version: an integer DB cursor, not the mtimes E13 sets for the folder (they are 0.15's answers on old folders)
    for (const [path, step, mtime] of [["/version", 3, 1_600_000_020], ["/synthetic/version", 4, 1_600_000_010]] as const) {
      const { got, want } = await same(path, step, (t) => JSON.parse(t));
      assert.equal(want.body.v, mtime, "the baseline is the 0.15 mtime value");
      assert.ok(Number.isInteger(got.json().v) && got.json().v >= 0, path);
      assert.notEqual(got.json().v, mtime, `${path}: a DB-serving project's cursor is not the file time`);
    }
    // /synthetic/: built from the DB, not the folder's index.html the baseline served
    const page = await server.request("/synthetic/");
    assert.equal(page.status, 200);
    assert.equal(page.headers["content-type"], "text/html; charset=utf-8");
    assert.notEqual(page.text(), base("E13", 6).body, "not the folder's index.html");
    // an ask form of the folder is still found at its address
    assert.equal((await server.request("/synthetic/ask-plan.html")).status, 200);
  } finally {
    await fx.cleanup();
  }
});
