// SEL-116 — runs ONE hostile file through the real server path (upload -> POST /file-extractions -> file.extract command ->
// database), in its own process, so a test can start it with a small heap (`node --max-old-space-size=256`) and see whether the
// server survives. After the hostile file it extracts an ordinary docx with the same server: it must still answer.
// Everything is synthetic (temporary HOME made by the test; an in-memory-style project from tests/helpers). Prints one JSON line.
//
//   node --max-old-space-size=256 --import ./tests/helpers/require_temp_home.ts tests/helpers/sel116_server_child.ts <file> <original name>

import { readFileSync } from "node:fs";

import { with_api } from "./api_env.ts";
import { count, extract, make_docx, material_of, text_of } from "./sel116_env.ts";

const [path, name] = process.argv.slice(2);
if (path === undefined || name === undefined) {
  process.stderr.write("usage: sel116_server_child.ts <file> <original name>\n");
  process.exit(2);
}
const bytes = new Uint8Array(readFileSync(path));

await with_api(async (env) => {
  const m = await material_of(env, name, bytes);
  const blobs = count(env.db, "blobs");
  const start = performance.now();
  const res = await extract(env, m);
  const ms = Math.round(performance.now() - start);
  const data = res.json?.data ?? null;
  const new_blobs = count(env.db, "blobs") - blobs;
  const text = data?.text_blob_id ? await text_of(env, data) : null;
  const after = await material_of(env, "뒤.docx", make_docx(["서버는 살아 있다"]));
  const next = await extract(env, after);
  process.stdout.write(
    `${JSON.stringify({
      http: res.status,
      status: data?.status ?? null,
      reason: data?.reason ?? null,
      text_length: text === null ? null : text.length,
      text_head: text === null ? null : text.slice(0, 120),
      new_blobs,
      ms,
      next_status: next.json?.data?.status ?? null,
      rows: count(env.db, "file_extractions"),
    })}\n`,
  );
});
