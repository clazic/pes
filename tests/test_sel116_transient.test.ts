/**
 * SEL-116 (4회차 R2) — a failed extraction that says something about the MOMENT (time limit, unexpected error, a thread that is still
 * running, workers not allowed) is recorded but never answers a later request for the same file: the file is tried again.
 * A failure about the FILE (too_large and the damaged-file reasons) stays the final answer, exactly as before.
 * Uses the real path: POST /file-extractions -> file.extract -> extract_text_isolated (in this very process).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { TRANSIENT_REASONS } from "../scripts/pes_core/file_extract.ts";
import { extract_text_isolated, unfinished_extraction_threads } from "../scripts/pes_core/file_extract_isolated.ts";
import { assert_ok, with_api } from "./helpers/api_env.ts";
import { count, events_of, extract, extraction_rows, material_of, receipts_of } from "./helpers/sel116_env.ts";

const HOSTILE = new URL("./helpers/sel116_hostile_worker.ts", import.meta.url).href;
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

async function until_no_unfinished_threads(): Promise<void> {
  const start = performance.now();
  while (unfinished_extraction_threads() > 0) {
    assert.ok(performance.now() - start < 30_000, "the cut-off thread never ended");
    await new Promise((done) => setTimeout(done, 25));
  }
}

test("the transient reasons are exactly the four about the moment — too_large and damaged-file reasons are not among them", () => {
  assert.deepEqual([...TRANSIENT_REASONS].sort(), ["extract_busy", "extract_error", "extract_timeout", "worker_unavailable"]);
});

test("extract_busy is recorded as an attempt, and asking again after the thread ended tries again (a new row), then is idempotent", async () => {
  await with_api(async (env) => {
    const m = await material_of(env, "다시.txt", bytes("첫 줄\n둘째 줄\n"));

    // a thread that terminate() cannot cut keeps this process busy: the real file.extract answers failed/extract_busy
    const stuck = extract_text_isolated("native.txt", bytes("x"), { worker_url: HOSTILE, timeout_ms: 400, end_grace_ms: 100 });
    assert.equal(stuck.reason, "extract_timeout");
    assert.equal(unfinished_extraction_threads(), 1);
    const busy = assert_ok(await extract(env, m), 201);
    assert.equal(busy.status, "failed");
    assert.equal(busy.reason, "extract_busy");
    assert.equal(busy.changed, true);
    assert.equal(busy.text_blob_id, null);
    assert.equal(extraction_rows(env.db, env.p.project_id).length, 1);
    assert.equal(extraction_rows(env.db, env.p.project_id)[0]?.status, "failed");

    // asking again while it is still busy: another attempt, another record (the old one did not answer)
    const busy_again = assert_ok(await extract(env, m), 201);
    assert.equal(busy_again.reason, "extract_busy");
    assert.notEqual(busy_again.extraction_id, busy.extraction_id);
    assert.equal(busy_again.changed, true);

    await until_no_unfinished_threads();
    const ok = assert_ok(await extract(env, m), 201);
    assert.equal(ok.status, "extracted");
    assert.equal(ok.reason, null);
    assert.equal(ok.changed, true);
    assert.notEqual(ok.extraction_id, busy.extraction_id);
    assert.equal(extraction_rows(env.db, env.p.project_id).length, 3);
    assert.equal(receipts_of(env.db, "file.extracted"), 3);
    assert.equal(events_of(env.db, "file.extracted").length, 3);

    // a final answer is final: the same request again changes nothing and says so
    const rows = extraction_rows(env.db, env.p.project_id).length;
    const again = assert_ok(await extract(env, m), 201);
    assert.equal(again.changed, false);
    assert.equal(again.extraction_id, ok.extraction_id);
    assert.equal(again.status, "extracted");
    assert.equal(extraction_rows(env.db, env.p.project_id).length, rows);
    assert.equal(count(env.db, "file_extractions"), rows);
  });
});

test("every transient reason is tried again; too_large and a damaged-file failure keep answering (a stored failure row, edited to each reason)", async () => {
  await with_api(async (env) => {
    const reasons = [...TRANSIENT_REASONS, "too_large", "invalid_container", "invalid_document", "invalid_encoding"];
    for (const [i, code] of reasons.entries()) {
      const m = await material_of(env, `사유${i}.txt`, bytes(`본문 ${i}\n`));
      const first = assert_ok(await extract(env, m), 201);
      assert.equal(first.status, "extracted", code);
      // the row the command writes for a failure: status failed, no text, the reason as the first warning
      const edited = env.db.run(
        "UPDATE file_extractions SET status = 'failed', text_blob_id = NULL, text_file_policy_id = NULL, text_hash = NULL, warnings_json = ? WHERE id = ?",
        JSON.stringify([{ code, message: "synthetic" }]),
        first.extraction_id,
      );
      assert.equal(edited.changes, 1n);
      const rows = extraction_rows(env.db, env.p.project_id).length;
      const again = assert_ok(await extract(env, m), 201);
      if ((TRANSIENT_REASONS as readonly string[]).includes(code)) {
        assert.equal(again.changed, true, `${code} is tried again`);
        assert.equal(again.status, "extracted", code);
        assert.notEqual(again.extraction_id, first.extraction_id, code);
        assert.equal(extraction_rows(env.db, env.p.project_id).length, rows + 1, code);
      } else {
        assert.equal(again.changed, false, `${code} stays final`);
        assert.equal(again.status, "failed", code);
        assert.equal(again.reason, code);
        assert.equal(again.extraction_id, first.extraction_id, code);
        assert.equal(extraction_rows(env.db, env.p.project_id).length, rows, code);
      }
    }
  });
});
