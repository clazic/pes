// Cloudflare Workers entry for the WEB0 spike (local `wrangler dev` only).

import { D1Db, type D1DatabaseLike } from "../ts-core/db.ts";
import { handleCore, headersToRecord, parseJsonBody } from "../ts-core/http.ts";
import { runRound } from "../ts-core/scenario.ts";
import { runContractSuite } from "../ts-core/contract-suite.ts";

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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
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
