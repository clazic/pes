/**
 * SEL-116 (4회차 R2, 5회차 R-a) — a failed extraction that says something about the MOMENT is never the answer to a later request for
 * the same file: the file is tried again. Time limit and unexpected error are recorded (row, receipt, event); a thread that is still
 * running (extract_busy) and workers not allowed (worker_unavailable) are refused with 409 conflict and write nothing.
 * A failure about the FILE (too_large and the damaged-file reasons) stays the final answer, exactly as before.
 * Uses the real path: POST /file-extractions -> file.extract -> extract_text_isolated (in this very process).
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { TRANSIENT_REASONS } from "../scripts/pes_core/file_extract.ts";
import { extract_text_isolated, unfinished_extraction_threads } from "../scripts/pes_core/file_extract_isolated.ts";
import { assert_error, assert_ok, with_api } from "./helpers/api_env.ts";
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

test("extract_busy is refused (409 conflict, retryable) and writes nothing; after the thread ended the file is extracted, then idempotent", async () => {
  await with_api(async (env) => {
    const m = await material_of(env, "다시.txt", bytes("첫 줄\n둘째 줄\n"));
    const before = { rows: count(env.db, "file_extractions"), receipts: count(env.db, "mutation_commits"), events: count(env.db, "events") };

    // a thread that terminate() cannot cut keeps this process busy: file.extract refuses at once and records nothing
    const stuck = extract_text_isolated("native.txt", bytes("x"), { worker_url: HOSTILE, timeout_ms: 1200, end_grace_ms: 100 });
    assert.equal(stuck.reason, "extract_timeout");
    assert.equal(unfinished_extraction_threads(), 1);
    // many requests with different keys: still no row, receipt or event
    for (let i = 0; i < 5; i += 1) {
      const res = await extract(env, m, "owner", `busy-key-${i}`);
      const error = assert_error(res, 409, "conflict");
      assert.deepEqual(error.details, { reason: "extract_busy" });
      assert.equal(error.retryable, true);
      assert.equal(error.next_action, "retry_later");
      assert.equal(count(env.db, "file_extractions"), before.rows);
      assert.equal(count(env.db, "mutation_commits"), before.receipts);
      assert.equal(count(env.db, "events"), before.events);
    }

    await until_no_unfinished_threads();
    // a NEW key tries again (the old keys left no commit, so they would also go through)
    const ok = assert_ok(await extract(env, m, "owner", "after-busy"), 201);
    assert.equal(ok.status, "extracted");
    assert.equal(ok.reason, null);
    assert.equal(ok.changed, true);
    assert.equal(extraction_rows(env.db, env.p.project_id).length, 1);
    assert.equal(receipts_of(env.db, "file.extracted"), 1);
    assert.equal(events_of(env.db, "file.extracted").length, 1);

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

test("extract_timeout is still recorded as an attempt and the next request tries again (a new row, receipt and event)", async () => {
  await with_api(async (env) => {
    const m = await material_of(env, "시간.txt", bytes("첫 줄\n"));
    // a stored extract_timeout row (what a time limit leaves) does not answer a later request
    const done = assert_ok(await extract(env, m, "owner", "k1"), 201);
    assert.equal(done.status, "extracted");
    const edited = env.db.run(
      "UPDATE file_extractions SET status = 'failed', text_blob_id = NULL, text_file_policy_id = NULL, text_hash = NULL, warnings_json = ? WHERE id = ?",
      JSON.stringify([{ code: "extract_timeout", message: "synthetic" }]),
      done.extraction_id,
    );
    assert.equal(edited.changes, 1n);
    const again = assert_ok(await extract(env, m, "owner", "k2"), 201);
    assert.equal(again.changed, true);
    assert.equal(again.status, "extracted");
    assert.equal(extraction_rows(env.db, env.p.project_id).length, 2);
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

test("where workers are not allowed (node --permission) file.extract refuses with 409 conflict/worker_unavailable and writes nothing", () => {
  const script = fileURLToPath(new URL("./helpers/sel116_permission_api_child.ts", import.meta.url));
  const repo = fileURLToPath(new URL("../", import.meta.url));
  const args = ["--permission", `--allow-fs-read=${repo}`, `--allow-fs-read=${tmpdir()}`, `--allow-fs-write=${tmpdir()}`, script];
  const out = execFileSync(process.execPath, args, { encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "1" } });
  const seen = JSON.parse(out.trim().split("\n").at(-1) as string) as Record<string, unknown>;
  assert.equal(seen.status, 409);
  assert.equal(seen.status2, 409);
  assert.equal(seen.code, "conflict");
  assert.equal(seen.reason, "worker_unavailable");
  assert.equal(seen.retryable, true);
  assert.deepEqual(seen.after, seen.before, "no extraction row, commit or event was written");
});
