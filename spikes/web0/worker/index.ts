// Cloudflare Workers entry for the WEB0 spike (local `wrangler dev` only).

import { D1Db, type D1DatabaseLike } from "../ts-core/db.ts";
import { handleCore, headersToRecord, parseJsonBody } from "../ts-core/http.ts";
import { runRound } from "../ts-core/scenario.ts";
import { runContractSuite } from "../ts-core/contract-suite.ts";
import { buildHwpxFromMarkdown } from "../ts-core/hwpx.ts";

export interface Env {
  DB: D1DatabaseLike;
  FAKE_GO_URL: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function sha256BytesHex(bytes: Uint8Array): Promise<string> {
  const input = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", input);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/v1/_spike/hwpx" && request.method === "POST") {
      try {
        const markdown = await request.text();
        const result = buildHwpxFromMarkdown(markdown);
        return json({
          ok: true,
          bytes: result.bytes.byteLength,
          sha256: await sha256BytesHex(result.bytes),
          entries: result.entries,
        });
      } catch (error) {
        return json(
          { ok: false, error: error instanceof Error ? error.message : String(error) },
          500,
        );
      }
    }
    if (url.pathname === "/api/v1/_spike/round" && request.method === "POST") {
      try {
        const db = new D1Db(env.DB);
        const stats = await runRound(db, { fakeGoUrl: env.FAKE_GO_URL });
        return json({ ok: true, stats });
      } catch (error) {
        return json(
          { ok: false, error: error instanceof Error ? error.message : String(error) },
          500,
        );
      }
    }
    if (url.pathname === "/api/v1/_spike/contract" && request.method === "POST") {
      try {
        const db = new D1Db(env.DB);
        const result = await runContractSuite(db);
        return json({ ok: true, result });
      } catch (error) {
        return json(
          { ok: false, error: error instanceof Error ? error.message : String(error) },
          500,
        );
      }
    }
    const text = await request.text();
    const body = text.length > 0 ? parseJsonBody(text) : undefined;
    const result = await handleCore(
      { db: new D1Db(env.DB) },
      {
        method: request.method,
        pathname: url.pathname,
        headers: headersToRecord(request.headers),
        body,
      },
    );
    return json(result.envelope, result.status);
  },
};
