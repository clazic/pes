// SEL-116 R1-2 — runs ONE extraction in its own process, so a test can start it with a small heap
// (`node --max-old-space-size=…`) and see whether the extractor stays inside its limits instead of taking the
// whole test process down. Pure: reads one file, prints one JSON line, touches nothing else (no HOME, no database).
//
//   node --max-old-space-size=256 tests/helpers/sel116_extract_child.ts <zip path> <original name>

import { readFileSync } from "node:fs";

import { extract_text } from "../../scripts/pes_core/file_extract.ts";

const [path, name] = process.argv.slice(2);
if (path === undefined || name === undefined) {
  process.stderr.write("usage: sel116_extract_child.ts <file> <original name>\n");
  process.exit(2);
}
const bytes = new Uint8Array(readFileSync(path));
const start = performance.now();
const out = extract_text(name, bytes);
const ms = Math.round(performance.now() - start);
process.stdout.write(
  `${JSON.stringify({
    status: out.status,
    reason: out.reason,
    text_length: out.text === null ? null : out.text.length,
    text_head: out.text === null ? null : out.text.slice(0, 200),
    warnings: out.warnings.length,
    warning_codes: [...new Set(out.warnings.map((w) => w.code))],
    ms,
  })}\n`,
);
