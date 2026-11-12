/**
 * SEL-102 — 1차 리뷰(SEL-102-r1.md) 수정 시험 (mid-worker, 보안). 기존 단언은 바꾸지 않는다.
 *
 *  S 필수 1: 홈 자체가 한 프로젝트(루트에 project.json)일 때 `reports/`·`out/`·`notes/` 같은 프로젝트 안의 하위 폴더는 "프로젝트 폴더 바로 아래"가 아니다.
 *    그 안의 index.html·ask-*.html 도 sandbox. 예외는 홈 루트(= 그 프로젝트 폴더)의 index.html·ask-*.html 뿐.
 *  F 권장 1: files/{b}/content — 문서를 돌릴 수 있는 형식을 목록으로 잡으면 목록 밖(text/xsl …)이 샌다. 안전한 형식(이미지·PDF·텍스트·JSON·미디어·글꼴)
 *    밖은 모두 sandbox. 정적 폴백도 같은 판정 함수.
 *  A 권장 4: API 응답에도 X-Content-Type-Options: nosniff.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { connect_read_only } from "../scripts/pes_core/db.ts";
import { needs_document_sandbox } from "../scripts/pes_core/document_sandbox.ts";
import { db_path } from "../scripts/pes_core/paths.ts";
import { TsServeProcess } from "./helpers/compat_ts_srv.ts";
import { use_home_guard } from "./helpers/home_guard.ts";
import { serve_fixture, type ServeFixture } from "./helpers/serve_ts_env.ts";

use_home_guard();

const SECRET = "synthetic-sel102-fix-session-0123456789abcdef";
const WANTED = ["allow-downloads", "allow-modals", "allow-popups", "allow-scripts"];
const PAGE = "<!doctype html><title>합성</title><body><script>document.body.dataset.ok = '1'</script>합성 본문</body>";
const XSL_DOC = `<html xmlns="http://www.w3.org/1999/xhtml"><body><script>window.__ran = location.origin</script></body></html>`;

type Hdrs = Record<string, string>;

function sandbox_tokens(headers: Hdrs): string[] | undefined {
  for (const part of (headers["content-security-policy"] ?? "").split(";")) {
    const words = part.trim().split(/\s+/).filter(Boolean);
    if ((words[0] ?? "").toLowerCase() === "sandbox") return words.slice(1).map((w) => w.toLowerCase());
  }
  return undefined;
}

function assert_sandbox(headers: Hdrs, what: string): void {
  const tokens = sandbox_tokens(headers);
  assert.ok(tokens !== undefined, `${what}: sandbox 지시어가 있다 (${headers["content-security-policy"] ?? "CSP 없음"})`);
  assert.deepEqual([...new Set(tokens)].sort(), WANTED, `${what}: 토큰이 정확히 넷`);
}

function assert_no_sandbox(headers: Hdrs, what: string): void {
  assert.equal(sandbox_tokens(headers), undefined, `${what}: sandbox 가 없다 (${headers["content-security-policy"] ?? "CSP 없음"})`);
}

// ---------------------------------------------------------------- S 단일 프로젝트 홈

async function with_single_project_home(fn: (fx: ServeFixture) => Promise<void>): Promise<void> {
  const files: Record<string, string | Buffer> = {
    "project.json": JSON.stringify({ pes: 1, topic: "합성 주제", stages: {} }),
    "index.html": PAGE,
    "ask-top.html": PAGE,
    "reports/index.html": PAGE,
    "reports/ask-x.html": PAGE,
    "reports/plan/index.html": PAGE,
    "out/index.html": PAGE,
    "notes/index.html": PAGE,
    "notes/ask-y.html": PAGE,
    "notes/x.html": PAGE,
    "sub/index.html": PAGE,
  };
  const fx = await serve_fixture("sel102-single", { no_db: true, files });
  try {
    await fn(fx);
  } finally {
    await fx.cleanup();
  }
}

test("S1 단일 프로젝트 홈: reports/·out/·notes/·sub/ 아래의 index.html·ask-*.html 과 그 폴더 요청은 모두 sandbox (프로젝트 폴더 = 홈 루트)", { timeout: 180_000 }, async () => {
  await with_single_project_home(async ({ server }) => {
    for (const path of ["/reports/index.html", "/out/index.html", "/notes/index.html", "/reports/ask-x.html", "/notes/ask-y.html", "/sub/index.html", "/reports/", "/out/", "/notes/", "/reports/plan/index.html", "/notes/x.html"]) {
      for (const method of ["GET", "HEAD"]) {
        const res = await server.request(path, { method });
        assert.equal(res.status, 200, `${method} ${path}`);
        assert_sandbox(res.headers, `${method} ${path}`);
      }
    }
  });
});

test("S2 단일 프로젝트 홈: 예외는 홈 루트(= 프로젝트 폴더)의 index.html·ask-*.html 뿐 — sandbox 없음", { timeout: 180_000 }, async () => {
  await with_single_project_home(async ({ server }) => {
    for (const path of ["/", "/index.html", "/ask-top.html"]) {
      for (const method of ["GET", "HEAD"]) {
        const res = await server.request(path, { method });
        assert.equal(res.status, 200, `${method} ${path}`);
        assert_no_sandbox(res.headers, `${method} ${path}`);
      }
    }
  });
});

// ---------------------------------------------------------------- F 형식 판정 함수 · files content

test("F0 판정 함수: 안전한 형식 밖은 모두 sandbox (text/xsl · */xml · *+xml · 모르는 형식 포함), 안전한 형식은 아니다", () => {
  const sandboxed = [
    "text/html", "TEXT/HTML; charset=utf-8", "image/svg+xml", "IMAGE/SVG+XML; charset=utf-8", "text/xml", "application/xml", "application/xhtml+xml",
    "text/xsl", "TEXT/XSL; charset=utf-8", "text/xslt", "application/xslt+xml", "application/rss+xml", "application/atom+xml", "application/mathml+xml",
    "application/vnd.foo+xml", "application/foo", "text/foo", "", "  text/html  ", "application/x-unknown",
  ];
  for (const type of sandboxed) assert.equal(needs_document_sandbox(type), true, `${JSON.stringify(type)} → sandbox`);
  const safe = [
    "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp", "IMAGE/PNG; x=y", "application/pdf", "application/octet-stream",
    "text/plain", "text/plain; charset=utf-8", "text/csv", "text/markdown", "application/json", "application/json; charset=utf-8",
    "audio/mpeg", "video/mp4", "font/woff2", "text/css", "text/javascript; charset=utf-8", "application/wasm",
  ];
  for (const type of safe) assert.equal(needs_document_sandbox(type), false, `${JSON.stringify(type)} → sandbox 없음`);
});

interface Api {
  fx: ServeFixture;
  server: TsServeProcess;
  project_id: string;
}

async function with_api(fn: (a: Api) => Promise<void>): Promise<void> {
  const fx = await serve_fixture("sel102-fixfiles", { no_start: true });
  const server = new TsServeProcess(fx.ctx, fx.root, { extra_env: { PES_LOCAL_SESSION_SECRET: SECRET } });
  try {
    await server.start();
    const db = connect_read_only(db_path(fx.ctx.env));
    let project_id: string;
    try {
      project_id = db.get<{ id: string }>("SELECT id FROM projects WHERE slug = 'synthetic'")!.id;
    } finally {
      db.close();
    }
    await fn({ fx, server, project_id });
  } finally {
    await server.stop();
    await fx.cleanup();
  }
}

async function upload(a: Api, bytes: Buffer, media_type: string, n: number): Promise<string> {
  const base = `/api/v1/projects/${a.project_id}`;
  const auth = { "x-pes-session": SECRET };
  const sha = createHash("sha256").update(bytes).digest("hex");
  const reserved = await a.server.request(`${base}/uploads`, {
    method: "POST",
    body: JSON.stringify({ sha256: sha, size: bytes.byteLength, media_type, original_name: `합성-${n}.bin` }),
    headers: { ...auth, "content-type": "application/json", "idempotency-key": `sel102-fr-${n}` },
  });
  assert.ok(reserved.status === 200 || reserved.status === 201, `reserve ${media_type}: ${reserved.status} ${reserved.text()}`);
  const data = reserved.json().data ?? reserved.json();
  const blob_id = (data.blob_id ?? reserved.json().blob_id) as string;
  if (data.state !== "ready") {
    const put = await a.server.request(`${base}/uploads/${blob_id}`, { method: "PUT", body: bytes, headers: { ...auth, "content-type": "application/octet-stream", "idempotency-key": `sel102-fp-${n}` } });
    assert.equal(put.status, 200, `put ${media_type}: ${put.text()}`);
    const done = await a.server.request(`${base}/uploads/${blob_id}/complete`, { method: "POST", body: "{}", headers: { ...auth, "content-type": "application/json", "idempotency-key": `sel102-fc-${n}` } });
    assert.equal(done.status, 200, `complete ${media_type}: ${done.text()}`);
  }
  return blob_id;
}

test("F3 files content: 목록 밖의 문서형 media_type(text/xsl · +xml · 모르는 형식)도 sandbox, 안전한 형식은 그대로, 모두 nosniff", { timeout: 240_000 }, async () => {
  await with_api(async (a) => {
    const cases: Array<[string, boolean]> = [
      ["text/xsl", true],
      ["TEXT/XSL; charset=utf-8", true],
      ["text/xslt", true],
      ["application/xslt+xml", true],
      ["application/rss+xml", true],
      ["application/vnd.x+xml", true],
      ["application/mathml+xml", true],
      ["application/foo", true],
      ["image/jpeg", false],
      ["text/csv", false],
      ["text/markdown", false],
      ["audio/mpeg", false],
      ["font/woff2", false],
    ];
    let n = 100;
    for (const [type, sandboxed] of cases) {
      n += 1;
      const blob_id = await upload(a, Buffer.from(`${XSL_DOC}\n${n}`), type, n);
      const res = await a.server.request(`/api/v1/projects/${a.project_id}/files/${blob_id}/content`, { headers: { "x-pes-session": SECRET } });
      assert.equal(res.status, 200, `${type}: ${res.text().slice(0, 200)}`);
      assert.equal((res.headers["content-type"] ?? "").toLowerCase(), type.toLowerCase(), `${type}: Content-Type 그대로`);
      assert.equal((res.headers["x-content-type-options"] ?? "").toLowerCase(), "nosniff", `${type}: nosniff`);
      if (sandboxed) assert_sandbox(res.headers, type);
      else assert_no_sandbox(res.headers, type);
    }
  });
});

// ---------------------------------------------------------------- A API 응답 nosniff

test("A1 API JSON 응답(성공·실패)에도 X-Content-Type-Options: nosniff", { timeout: 180_000 }, async () => {
  await with_api(async (a) => {
    const ok = await a.server.request("/api/v1/capabilities", { headers: { "x-pes-session": SECRET } });
    assert.equal(ok.status, 200, ok.text().slice(0, 200));
    assert.equal((ok.headers["x-content-type-options"] ?? "").toLowerCase(), "nosniff", "성공 응답");
    const bad = await a.server.request("/api/v1/projects/no-such-project/files/x/content", { headers: { "x-pes-session": SECRET } });
    assert.ok(bad.status >= 400, `실패 응답 ${bad.status}`);
    assert.equal((bad.headers["x-content-type-options"] ?? "").toLowerCase(), "nosniff", "실패 응답");
    const denied = await a.server.request(`/api/v1/projects/${a.project_id}/files/x/content`);
    assert.ok(denied.status >= 400, `세션 없음 ${denied.status}`);
    assert.equal((denied.headers["x-content-type-options"] ?? "").toLowerCase(), "nosniff", "거절 응답");
  });
});
