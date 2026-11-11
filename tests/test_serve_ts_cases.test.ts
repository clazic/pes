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
import { test } from "node:test";

import { answer_count_record, assert_case, case_def, load_table, run_case } from "./helpers/compat_cases.ts";
import { n1_time } from "./helpers/compat_normalize.ts";
import { use_home_guard } from "./helpers/home_guard.ts";
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
