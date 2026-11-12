/**
 * SEL-116 — Worker isolation of the extraction (file_extract_isolated.ts + supervisor + extraction thread).
 * A hostile stand-in thread (tests/helpers/sel116_hostile_worker.ts) runs out of memory, spins, throws or exits; the caller must get
 * a failed outcome back, fast, with the process alive. The real extraction thread must give the same answers as extract_text.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { extract_text } from "../scripts/pes_core/file_extract.ts";
import { extract_text_isolated } from "../scripts/pes_core/file_extract_isolated.ts";
import { make_docx } from "./helpers/sel116_env.ts";

const HOSTILE = new URL("./helpers/sel116_hostile_worker.ts", import.meta.url).href;
const BYTES = new TextEncoder().encode("hello");

function hostile(name: string, options: { heap_mb?: number; timeout_ms?: number } = {}) {
  const start = performance.now();
  const out = extract_text_isolated(name, BYTES, { worker_url: HOSTILE, ...options });
  return { out, ms: performance.now() - start };
}

test("isolation: a thread that runs out of memory ends as failed/too_large — quickly, the process keeps running", () => {
  const { out, ms } = hostile("oom.txt", { heap_mb: 64 });
  assert.equal(out.status, "failed");
  assert.equal(out.reason, "too_large");
  assert.equal(out.text, null);
  assert.ok(ms < 10_000, `took ${ms.toFixed(0)} ms`);
});

test("isolation: a thread that never ends is stopped at the time limit — failed/extract_timeout", () => {
  const { out, ms } = hostile("spin.txt", { timeout_ms: 700 });
  assert.equal(out.status, "failed");
  assert.equal(out.reason, "extract_timeout");
  assert.ok(ms >= 600 && ms < 6_000, `took ${ms.toFixed(0)} ms`);
});

test("isolation: a thread that throws or exits without an answer is failed/extract_error", () => {
  for (const name of ["throw.txt", "exit.txt"]) {
    const { out, ms } = hostile(name);
    assert.equal(out.status, "failed", name);
    assert.equal(out.reason, "extract_error", name);
    assert.ok(ms < 10_000, `${name} took ${ms.toFixed(0)} ms`);
  }
});

test("isolation: a thread that answers is believed, and the next extraction after a hostile one still works", () => {
  hostile("oom.txt", { heap_mb: 64 });
  const { out } = hostile("ok.txt");
  assert.equal(out.status, "extracted");
  assert.equal(out.text, "ok");
  const real = extract_text_isolated("a.txt", new TextEncoder().encode("a\r\nb"));
  assert.equal(real.text, "a\nb");
});

test("isolation: the real thread answers exactly like extract_text (docx table, txt, empty file) and leaves the caller's bytes usable", () => {
  const docx = make_docx(["제목", [["a", "b|c"], ["1", "2"]]]);
  const before = Buffer.from(docx).toString("hex");
  assert.deepEqual(extract_text_isolated("표.docx", docx), extract_text("표.docx", docx));
  assert.equal(Buffer.from(docx).toString("hex"), before);
  const txt = new TextEncoder().encode("﻿한글\r\n둘째\r셋째");
  assert.deepEqual(extract_text_isolated("가.txt", txt), extract_text("가.txt", txt));
  assert.deepEqual(extract_text_isolated("빈.md", new Uint8Array(0)), extract_text("빈.md", new Uint8Array(0)));
});

test("isolation: unsupported formats and broken files answer in the same words as extract_text", () => {
  const pdf = new TextEncoder().encode("%PDF-1.4 synthetic");
  assert.deepEqual(extract_text_isolated("a.pdf", pdf), extract_text("a.pdf", pdf));
  const broken = new TextEncoder().encode("not a zip at all, long enough to be looked at");
  assert.deepEqual(extract_text_isolated("a.docx", broken), extract_text("a.docx", broken));
  const bad = new Uint8Array([0xff, 0xfe, 0x41]);
  assert.deepEqual(extract_text_isolated("a.txt", bad), extract_text("a.txt", bad));
});

test("isolation: a source over the size limit is refused before any thread is started", () => {
  const out = extract_text_isolated("a.txt", new Uint8Array(32 * 1024 * 1024 + 1));
  assert.equal(out.status, "failed");
  assert.equal(out.reason, "too_large");
});
