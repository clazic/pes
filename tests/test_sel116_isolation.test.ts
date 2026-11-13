/**
 * SEL-116 — Worker isolation of the extraction (file_extract_isolated.ts + supervisor + extraction thread).
 * A hostile stand-in thread (tests/helpers/sel116_hostile_worker.ts) runs out of memory, spins, throws or exits; the caller must get
 * a failed outcome back, fast, with the process alive. The real extraction thread must give the same answers as extract_text.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { PARSED_FORMATS, extract_text } from "../scripts/pes_core/file_extract.ts";
import { extract_text_isolated, unfinished_extraction_threads } from "../scripts/pes_core/file_extract_isolated.ts";
import { make_docx } from "./helpers/sel116_env.ts";

const HOSTILE = new URL("./helpers/sel116_hostile_worker.ts", import.meta.url).href;
const BYTES = new TextEncoder().encode("hello");

function hostile(name: string, options: { heap_mb?: number; timeout_ms?: number; end_grace_ms?: number } = {}) {
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

test("isolation: every format that extract_text really parses is in PARSED_FORMATS (so it never runs inline in the server thread)", () => {
  const bytes = new TextEncoder().encode("PK\u0003\u0004 synthetic, long enough to be looked at");
  const names = ["txt", "md", "csv", "docx", "xlsx", "pptx", "hwpx", "hwp", "doc", "xls", "ppt", "pdf", "rtf", "odt", "ods", "odp", "epub", "html", "json", "xml", "zip", "xyz", ""];
  for (const ext of names) {
    const out = extract_text(ext === "" ? "noext" : `a.${ext.toUpperCase()}`, bytes);
    if (out.reason !== "unsupported_format") {
      assert.ok(PARSED_FORMATS.has(ext), `.${ext} is parsed by extract_text (${out.status}/${out.reason}) but is not in PARSED_FORMATS`);
    }
  }
  // and the other way: nothing listed there answers "unsupported"
  for (const ext of PARSED_FORMATS) assert.notEqual(extract_text(`a.${ext}`, bytes).reason, "unsupported_format", ext);
});

async function until_no_unfinished_threads(limit_ms: number): Promise<void> {
  const start = performance.now();
  while (unfinished_extraction_threads() > 0) {
    assert.ok(performance.now() - start < limit_ms, "the cut-off thread never ended");
    await new Promise((done) => setTimeout(done, 25));
  }
}

test("isolation: a thread that terminate() cannot cut is counted — the next extraction is extract_busy, and after the thread ends all works again", async () => {
  assert.equal(unfinished_extraction_threads(), 0);
  const first = hostile("native.txt", { timeout_ms: 1200, end_grace_ms: 100 });
  assert.equal(first.out.status, "failed");
  assert.equal(first.out.reason, "extract_timeout");
  assert.equal(unfinished_extraction_threads(), 1, "the stuck thread is counted");

  // no Worker is started while a thread is unfinished: both a hostile and a real extraction answer at once
  const busy = hostile("ok.txt");
  assert.equal(busy.out.status, "failed");
  assert.equal(busy.out.reason, "extract_busy");
  assert.equal(busy.out.text, null);
  assert.ok(busy.ms < 200, `extract_busy took ${busy.ms.toFixed(0)} ms`);
  const real = extract_text_isolated("a.txt", new TextEncoder().encode("a"));
  assert.equal(real.reason, "extract_busy");
  // a format that is not parsed needs no thread and is not blocked
  assert.equal(extract_text_isolated("a.pdf", BYTES).reason, "unsupported_format");

  await until_no_unfinished_threads(30_000);
  assert.equal(unfinished_extraction_threads(), 0);
  const after = extract_text_isolated("a.txt", new TextEncoder().encode("a\r\nb"));
  assert.equal(after.status, "extracted");
  assert.equal(after.text, "a\nb");
});

test("isolation: a thread that terminate() CAN cut is not counted (a normal time limit leaves nothing behind)", () => {
  const { out } = hostile("spin.txt", { timeout_ms: 300 });
  assert.equal(out.reason, "extract_timeout");
  assert.equal(unfinished_extraction_threads(), 0);
  assert.equal(hostile("ok.txt").out.status, "extracted");
});

test("isolation: where the process may not start workers (node --permission without --allow-worker) the answer is failed/worker_unavailable", () => {
  const script = fileURLToPath(new URL("./helpers/sel116_permission_child.ts", import.meta.url));
  const repo = fileURLToPath(new URL("../", import.meta.url));
  const read = (allow_worker: boolean): { status: string; reason: string | null } => {
    const args = ["--permission", `--allow-fs-read=${repo}`, `--allow-fs-read=${tmpdir()}`, ...(allow_worker ? ["--allow-worker"] : []), script];
    const out = execFileSync(process.execPath, args, { encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "1" } });
    return JSON.parse(out.trim().split("\n").at(-1) as string) as { status: string; reason: string | null };
  };
  assert.deepEqual(read(false), { status: "failed", reason: "worker_unavailable" });
  assert.deepEqual(read(true), { status: "extracted", reason: null });
});

test("isolation: a supervisor thread that throws while starting does not kill the process (its error event is heard)", async () => {
  // worker_url is not a URL: the supervisor throws at its very first line. The caller still gets a failed outcome (the main thread
  // cannot be woken by an error event while it waits, so this ends by its own time limit) and the process lives on.
  const out = extract_text_isolated("a.txt", BYTES, { worker_url: "not a url", timeout_ms: 300, end_grace_ms: 100 });
  assert.equal(out.status, "failed");
  assert.equal(out.reason, "extract_timeout");
  // let the event loop run: the supervisor's error event is delivered here
  await new Promise((done) => setTimeout(done, 300));
  assert.equal(unfinished_extraction_threads(), 0);
  assert.equal(extract_text_isolated("a.txt", BYTES).status, "extracted");
});
