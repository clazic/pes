// SEL-116 — run by tests/test_sel116_isolation.test.ts under `node --permission` (with and without --allow-worker): extracts a small
// txt through the isolated extractor and prints the outcome (status, reason) as one JSON line. Nothing else; no files are written.

import { extract_text_isolated } from "../../scripts/pes_core/file_extract_isolated.ts";

const out = extract_text_isolated("a.txt", new TextEncoder().encode("hello"));
process.stdout.write(`${JSON.stringify({ status: out.status, reason: out.reason ?? null })}\n`);
