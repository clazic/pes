// SEL-117 MAT1c — HTTP 클라이언트가 내 자료 읽기 · 올리기 · AI 참조 · 미리보기를 SEL-115(MAT1a) 라우트로 잇는 매핑 (Vitest, fetch 는 가짜). 구현 전이라 실패가 정상.
// 서버 계약: SEL-115 tests/helpers/sel115_env.ts 머리말(git -C ~/hc-work/pes/SEL-115 show beee575:tests/helpers/sel115_env.ts). 클라이언트 모양: src/test/sel117.ts 머리말.
//
// ═══ 매핑 표 (P = /api/v1/projects/{id}; 모든 요청: 헤더 x-pes-session · credentials "omit"; 쓰기는 + idempotency-key) ═══
//  PesClient                                         요청                                                               결과
//  getMaterials(slug, ed)                            GET  P/materials                                                    data.materials[] → MaterialRow[]   (404 · 모르는 slug → [], 요청 0)
//     MaterialRow: object_id · version_id · version←Number(version_no) · blob_id · file_policy_id · role · title · original_name · media_type · size←Number · sha256
//                  · ai_access←그 칸이 allow|deny 일 때만, 없으면 **null**(allow 로 간주하지 않는다) · extraction←null (서버가 추출 상태를 안 준다 — 지어내지 않음)
//  uploadMaterial(slug, ed, {file, title?, object_id?}, key)
//                                                    1. POST P/uploads {sha256(파일 바이트 hex), size, media_type, original_name} → data {blob_id, state}
//                                                    2. state ≠ "ready" 면 PUT P/uploads/{blob_id} (원본 바이트 · content-type = 파일 형식) → POST P/uploads/{blob_id}/complete {}
//                                                       state 가 이미 "ready"(같은 바이트 dedup)면 2 는 건너뛴다
//                                                    3. POST P/materials {blob_id, title?(줄 때만), object_id?(줄 때만)} + idempotency-key = key   (Idempotency-Key 는 이 3번에만 의미가 있다)
//                                                    결과: data = 서버 data 그대로의 앱 모양 {object_id, version_id, version←Number(version_no), blob_id, file_policy_id, role, ai_access, original_name, media_type, size, sha256}
//                                                    receipt ← 성공(201) 뒤 GET P/requests/{key} 로 만든다(SEL-92 · SEL-100 과 같은 방식): {receipt_no(비어 있지 않음), tx_id, committed_at(ISO), idempotency_key, replayed: 본문 replayed === true}
//  setMaterialAiAccess(slug, ed, fp, {ai_access, reason?}, key)
//                                                    POST P/file-policies/{fp}/ai-access  {ai_access, reason(비어 있지 않을 때만)}  → 200 data {file_policy_id, blob_id, ai_access, rev, changed}
//                                                    receipt ← GET P/requests/{key}.  같은 값 = 서버가 changed:false 를 주고 클라이언트는 그대로 돌려준다(바꿔 말하지 않음)
//  getMaterialPreview(slug, ed, blob_id)             GET  P/files/{blob_id}/preview  → 200 원문 바이트  →  {blob_id, content_type←content-type 헤더, inline←content-disposition 이 inline 으로 시작,
//                                                                                                          sandbox←content-security-policy 헤더 값 | null, bytes: Uint8Array}
//  거절: 서버 오류 봉투 그대로 PesApiError(.body.error.code · .details 보존): 401 unauthenticated · 403 forbidden(agent 토큰 · 소유자 아님) · 404 not_found(쓰기 · 미리보기는 던진다) · 409 conflict(blob 이 ready 아님 · 바이트 변조) · 400 invalid_payload
//  멱등 키 없음: 요청 0 으로 invalid_payload PesApiError(target "$.headers.idempotency-key"). 모르는 slug 쓰기: not_found PesApiError, 요청 0.
//  시간: 쓰기 한 번(예약 · PUT · complete · POST · 영수증 읽기 각각)에 timeoutMs 제한. 넘으면 name "TimeoutError" — 같은 키로 다시 보내면 서버가 재생한다.
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { WORKSPACE } from "@/api/fixture";
import { FORMAT_VERSION, PesApiError, type PesClient } from "@/api/types";
import type { MaterialsMethods } from "@/test/sel117";

type Opts = { session: string; projects: Record<string, string>; baseUrl?: string; fetch?: typeof fetch; timeoutMs?: number };
const modules = import.meta.glob<{ createHttpClient: (o: Opts) => PesClient }>("/src/api/http-client.{ts,tsx}");
const load = async () => {
  const loader = Object.values(modules)[0];
  if (!loader) throw new Error("src/api/http-client.ts 가 없다");
  return (await loader()).createHttpClient;
};

const SESSION = "synthetic-session-mat1c";
const ID = "pj-synthetic-9";
const SLUG = WORKSPACE.slug;
const ED = WORKSPACE.edition;
const P = `/api/v1/projects/${ID}`;

const ok = (data: unknown, extra: Record<string, unknown> = {}) => ({ format_version: FORMAT_VERSION, request_id: "req-1", data, ...extra });
const fail = (code: string, details: unknown = null, target = "$.body") => ({ format_version: FORMAT_VERSION, request_id: "req-e", error: { code, message: "합성 거절 문장", retryable: false, target, details, next_action: "reread_context" } });
const requestsRead = (key: string, action: string, tx = "tx-77") => ok({ action, tx_id: tx, status: 201, run_id: null, key });

interface Seen {
  url: URL;
  method: string;
  headers: Headers;
  json: Record<string, unknown> | null;
  raw: Uint8Array | null;
  credentials: string | undefined;
}
type Reply = { status: number; body?: unknown; bytes?: Uint8Array; headers?: Record<string, string> } | "hang";
function server(routes: Record<string, Reply | ((s: Seen) => Reply)>) {
  const seen: Seen[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input), "http://app.invalid");
    const body = init?.body;
    const raw = body instanceof Uint8Array ? body : body instanceof ArrayBuffer ? new Uint8Array(body) : body instanceof Blob ? new Uint8Array(await body.arrayBuffer()) : null;
    const s: Seen = { url, method: (init?.method ?? "GET").toUpperCase(), headers: new Headers(init?.headers), json: typeof body === "string" ? JSON.parse(body) : null, raw, credentials: init?.credentials };
    seen.push(s);
    const hit = routes[`${s.method} ${url.pathname.replace(P, "")}`];
    const r = typeof hit === "function" ? hit(s) : (hit ?? { status: 404, body: fail("not_found") });
    if (r === "hang") return new Promise<Response>(() => {});
    if (r.bytes) return new Response(r.bytes as unknown as BodyInit, { status: r.status, headers: r.headers });
    return new Response(JSON.stringify(r.body), { status: r.status, headers: r.headers });
  });
  const writes = () => seen.filter((s) => s.method !== "GET");
  return { impl: impl as unknown as typeof fetch, seen, writes };
}
const make = async (s: ReturnType<typeof server>, extra: Partial<Opts> = {}) => (await load())({ session: SESSION, projects: { [SLUG]: ID }, fetch: s.impl, ...extra }) as PesClient & MaterialsMethods;

// ───────────── 서버 쪽 합성 값 ─────────────
const sMaterial = (o: Record<string, unknown> = {}) => ({
  object_id: "mat-1", version_id: "mv-1", version_no: 1, blob_id: "blob-1", file_policy_id: "fp-1", role: "attachment", title: "합성 자료 1",
  original_name: "synthetic-1.txt", media_type: "text/plain", size: 12, sha256: "a".repeat(64), ai_access: "allow", ...o,
});
const MATERIALS_OK = { status: 200, body: ok({ materials: [sMaterial(), sMaterial({ object_id: "mat-2", version_id: "mv-9", version_no: 3, blob_id: "blob-2", file_policy_id: "fp-2", title: "합성 보고서", original_name: "r.pdf", media_type: "application/pdf", size: 2048, ai_access: "deny" })] }) };

const bytes = new TextEncoder().encode("합성 업로드 본문\n");
const sha = createHash("sha256").update(bytes).digest("hex");
const theFile = () => new File([bytes], "upload-synthetic.txt", { type: "text/plain" });
const UPLOAD_RESULT = { object_id: "mat-7", version_id: "mv-70", version_no: 1, blob_id: "blob-7", file_policy_id: "fp-7", role: "attachment", ai_access: "allow", original_name: "upload-synthetic.txt", media_type: "text/plain", size: bytes.byteLength, sha256: sha };

describe("읽기 — GET P/materials", () => {
  it("요청: GET P/materials (세션 헤더 · 본문 없음 · 쓰기 헤더 없음 · credentials omit)", async () => {
    const s = server({ "GET /materials": MATERIALS_OK });
    const rows = await (await make(s)).getMaterials(SLUG, ED);
    expect(rows).toHaveLength(2);
    expect(s.seen).toHaveLength(1);
    const r = s.seen[0]!;
    expect(r.method).toBe("GET");
    expect(r.url.pathname).toBe(`${P}/materials`);
    expect(r.headers.get("x-pes-session")).toBe(SESSION);
    expect(r.headers.get("idempotency-key")).toBeNull();
    expect(r.json).toBeNull();
    expect(r.credentials).toBe("omit");
  });

  it("행 매핑: 버전·크기는 숫자, ai_access 는 서버 값 그대로, 추출 상태는 null(지어내지 않음)", async () => {
    const s = server({ "GET /materials": MATERIALS_OK });
    const [a, b] = await (await make(s)).getMaterials(SLUG, ED);
    expect(a).toEqual({
      object_id: "mat-1", version_id: "mv-1", version: 1, blob_id: "blob-1", file_policy_id: "fp-1", role: "attachment", title: "합성 자료 1",
      original_name: "synthetic-1.txt", media_type: "text/plain", size: 12, sha256: "a".repeat(64), ai_access: "allow", extraction: null,
    });
    expect(b).toMatchObject({ object_id: "mat-2", version: 3, size: 2048, ai_access: "deny", extraction: null });
  });

  it("문자열로 온 숫자(version_no “3” · size “2048”)도 숫자로 바꾼다", async () => {
    const s = server({ "GET /materials": { status: 200, body: ok({ materials: [sMaterial({ version_no: "3", size: "2048" })] }) } });
    const [a] = await (await make(s)).getMaterials(SLUG, ED);
    expect(a!.version).toBe(3);
    expect(a!.size).toBe(2048);
  });

  it("서버가 ai_access 를 안 주면(칸 없음) null — allow 로 간주하지 않는다. 모르는 값도 null", async () => {
    const { ai_access: _drop, ...noAccess } = sMaterial();
    const s = server({ "GET /materials": { status: 200, body: ok({ materials: [noAccess, sMaterial({ object_id: "mat-3", ai_access: "maybe" })] }) } });
    const [a, b] = await (await make(s)).getMaterials(SLUG, ED);
    expect(a!.ai_access).toBeNull();
    expect(b!.ai_access).toBeNull();
  });

  it("서버가 주지 않는 칸을 지어내지 않는다 — 앱 행의 키는 정한 목록뿐(올린 사람 · 시각 · 추출 결과 등 없음)", async () => {
    const s = server({ "GET /materials": MATERIALS_OK });
    const [a] = await (await make(s)).getMaterials(SLUG, ED);
    expect(Object.keys(a!).sort()).toEqual(["ai_access", "blob_id", "extraction", "file_policy_id", "media_type", "object_id", "original_name", "role", "sha256", "size", "title", "version", "version_id"]);
  });

  it("404 는 [] , 모르는 slug 는 요청 없이 []", async () => {
    const s = server({});
    const c = await make(s);
    expect(await c.getMaterials(SLUG, ED)).toEqual([]);
    const before = s.seen.length;
    expect(await c.getMaterials("no-such-slug", ED)).toEqual([]);
    expect(s.seen).toHaveLength(before);
  });

  it("403 · 401 은 PesApiError 로 그대로 (빈 목록으로 삼키지 않는다)", async () => {
    const s = server({ "GET /materials": { status: 403, body: fail("forbidden") } });
    await expect((await make(s)).getMaterials(SLUG, ED)).rejects.toMatchObject({ body: { error: { code: "forbidden" } } });
  });
});

describe("올리기 — uploadMaterial", () => {
  const routes = (over: Record<string, Reply | ((s: Seen) => Reply)> = {}) => ({
    "POST /uploads": { status: 201, body: ok({ blob_id: "blob-7", state: "staging" }) },
    "PUT /uploads/blob-7": { status: 200, body: ok({ blob_id: "blob-7" }) },
    "POST /uploads/blob-7/complete": { status: 200, body: ok({ blob_id: "blob-7", state: "ready" }) },
    "POST /materials": { status: 201, body: ok(UPLOAD_RESULT, { replayed: false }) },
    "GET /requests/key-up": { status: 200, body: requestsRead("key-up", "file.material_uploaded") },
    ...over,
  });

  it("순서: 예약 → PUT → complete → POST /materials(멱등 키) → 영수증 읽기. 예약 본문에 지문 · 크기 · 형식 · 원래 이름", async () => {
    const s = server(routes());
    const r = await (await make(s)).uploadMaterial(SLUG, ED, { file: theFile() }, "key-up");
    expect(s.seen.map((x) => `${x.method} ${x.url.pathname.replace(P, "")}`)).toEqual(["POST /uploads", "PUT /uploads/blob-7", "POST /uploads/blob-7/complete", "POST /materials", "GET /requests/key-up"]);
    expect(s.seen[0]!.json).toMatchObject({ sha256: sha, size: bytes.byteLength, media_type: "text/plain", original_name: "upload-synthetic.txt" });
    expect(Array.from(s.seen[1]!.raw ?? [])).toEqual(Array.from(bytes));
    expect(s.seen[1]!.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(s.seen[3]!.json).toMatchObject({ blob_id: "blob-7" });
    expect(s.seen[3]!.headers.get("idempotency-key")).toBe("key-up");
    for (const q of s.seen) {
      expect(q.headers.get("x-pes-session")).toBe(SESSION);
      expect(q.credentials).toBe("omit");
    }
    expect(r.data).toEqual({ ...UPLOAD_RESULT, version: 1, version_no: undefined });
    expect(r.receipt).toMatchObject({ idempotency_key: "key-up", tx_id: "tx-77", replayed: false });
    expect(r.receipt.receipt_no).toBeTruthy();
    expect(Number.isNaN(Date.parse(r.receipt.committed_at))).toBe(false);
  });

  it("title · object_id 는 줄 때만 본문에 싣는다 (새 버전 = object_id)", async () => {
    const s = server(routes());
    await (await make(s)).uploadMaterial(SLUG, ED, { file: theFile() }, "key-up");
    expect(Object.keys(s.seen[3]!.json!)).not.toContain("title");
    expect(Object.keys(s.seen[3]!.json!)).not.toContain("object_id");
    const s2 = server(routes());
    await (await make(s2)).uploadMaterial(SLUG, ED, { file: theFile(), title: "제목 글", object_id: "mat-1" }, "key-up");
    expect(s2.seen[3]!.json).toMatchObject({ blob_id: "blob-7", title: "제목 글", object_id: "mat-1" });
  });

  it("같은 바이트가 이미 ready 면(예약 응답 state ready) PUT · complete 를 건너뛴다", async () => {
    const s = server(routes({ "POST /uploads": { status: 200, body: ok({ blob_id: "blob-7", state: "ready" }) } }));
    await (await make(s)).uploadMaterial(SLUG, ED, { file: theFile() }, "key-up");
    expect(s.seen.map((x) => x.method)).toEqual(["POST", "POST", "GET"]);
    expect(s.seen.some((x) => x.method === "PUT")).toBe(false);
  });

  it("같은 키 다시 = 서버가 replayed:true 를 주면 영수증 replayed:true (두 번 처리하지 않는다)", async () => {
    const s = server(routes({ "POST /materials": { status: 201, body: ok(UPLOAD_RESULT, { replayed: true }) } }));
    const r = await (await make(s)).uploadMaterial(SLUG, ED, { file: theFile() }, "key-up");
    expect(r.receipt.replayed).toBe(true);
  });

  it("멱등 키가 없으면 요청 0 으로 invalid_payload", async () => {
    const s = server(routes());
    const err = await (await make(s)).uploadMaterial(SLUG, ED, { file: theFile() }, undefined).catch((e) => e);
    expect(err).toBeInstanceOf(PesApiError);
    expect(err.body.error.code).toBe("invalid_payload");
    expect(err.body.error.target).toBe("$.headers.idempotency-key");
    expect(s.seen).toHaveLength(0);
  });

  it("모르는 slug 는 요청 0 으로 not_found PesApiError", async () => {
    const s = server(routes());
    const err = await (await make(s)).uploadMaterial("no-such-slug", ED, { file: theFile() }, "key-up").catch((e) => e);
    expect(err).toBeInstanceOf(PesApiError);
    expect(err.body.error.code).toBe("not_found");
    expect(s.seen).toHaveLength(0);
  });

  it("예약이 거절되면 PesApiError 이고 /materials 는 부르지 않는다", async () => {
    const s = server(routes({ "POST /uploads": { status: 400, body: fail("invalid_payload", { reason: "too_large" }) } }));
    const err = await (await make(s)).uploadMaterial(SLUG, ED, { file: theFile() }, "key-up").catch((e) => e);
    expect(err).toBeInstanceOf(PesApiError);
    expect(err.body.error.details).toEqual({ reason: "too_large" });
    expect(s.seen.some((x) => x.url.pathname.endsWith("/materials"))).toBe(false);
  });

  it("blob 이 ready 가 아니라는 409 · 소유자 아님 403 은 서버 봉투 그대로 PesApiError", async () => {
    const s = server(routes({ "POST /materials": { status: 409, body: fail("conflict", { reason: "blob_not_ready" }) } }));
    await expect((await make(s)).uploadMaterial(SLUG, ED, { file: theFile() }, "key-up")).rejects.toMatchObject({ body: { error: { code: "conflict", details: { reason: "blob_not_ready" } } } });
    const s2 = server(routes({ "POST /materials": { status: 403, body: fail("forbidden") } }));
    await expect((await make(s2)).uploadMaterial(SLUG, ED, { file: theFile() }, "key-up")).rejects.toMatchObject({ body: { error: { code: "forbidden" } } });
  });

  it("시간 초과: 요청이 안 끝나면 name TimeoutError (화면이 “접수 확인 중”으로 보인다)", async () => {
    const s = server(routes({ "POST /materials": "hang" }));
    const err = await (await make(s, { timeoutMs: 30 })).uploadMaterial(SLUG, ED, { file: theFile() }, "key-up").catch((e) => e);
    expect(err.name).toBe("TimeoutError");
  });
});

describe("AI 참조 — setMaterialAiAccess (POST P/file-policies/{fp}/ai-access)", () => {
  const ACCESS = { file_policy_id: "fp-1", blob_id: "blob-1", ai_access: "deny", rev: 2, changed: true };
  const routes = (over: Record<string, Reply | ((s: Seen) => Reply)> = {}) => ({
    "POST /file-policies/fp-1/ai-access": { status: 200, body: ok(ACCESS, { replayed: false }) },
    "GET /requests/key-ac": { status: 200, body: requestsRead("key-ac", "file.ai_access_changed", "tx-88") },
    ...over,
  });

  it("요청: 경로의 정책 id · 본문 {ai_access, reason} · 멱등 키 · 세션 헤더, 결과는 서버 data 와 영수증", async () => {
    const s = server(routes());
    const r = await (await make(s)).setMaterialAiAccess(SLUG, ED, "fp-1", { ai_access: "deny", reason: "민감 자료" }, "key-ac");
    expect(s.seen.map((x) => `${x.method} ${x.url.pathname.replace(P, "")}`)).toEqual(["POST /file-policies/fp-1/ai-access", "GET /requests/key-ac"]);
    const w = s.seen[0]!;
    expect(w.json).toMatchObject({ ai_access: "deny", reason: "민감 자료" });
    expect(w.headers.get("idempotency-key")).toBe("key-ac");
    expect(w.headers.get("x-pes-session")).toBe(SESSION);
    expect(w.credentials).toBe("omit");
    expect(r.data).toEqual(ACCESS);
    expect(r.receipt).toMatchObject({ idempotency_key: "key-ac", tx_id: "tx-88", replayed: false });
    expect(r.receipt.receipt_no).toBeTruthy();
  });

  it("reason 이 비었거나 없으면 키 자체를 보내지 않는다", async () => {
    const s = server(routes());
    await (await make(s)).setMaterialAiAccess(SLUG, ED, "fp-1", { ai_access: "deny" }, "key-ac");
    expect(Object.keys(s.seen[0]!.json!)).not.toContain("reason");
    const s2 = server(routes());
    await (await make(s2)).setMaterialAiAccess(SLUG, ED, "fp-1", { ai_access: "deny", reason: "" }, "key-ac");
    expect(Object.keys(s2.seen[0]!.json!)).not.toContain("reason");
  });

  it("정책 id 는 경로에 안전하게 들어간다 (슬래시 · 물음표가 경로를 바꾸지 않는다)", async () => {
    const s = server({ "POST /file-policies/fp%2F..%2Fx%3F/ai-access": { status: 404, body: fail("not_found") } });
    await (await make(s)).setMaterialAiAccess(SLUG, ED, "fp/../x?", { ai_access: "deny" }, "key-ac").catch(() => {});
    expect(s.seen).toHaveLength(1);
    expect(s.seen[0]!.url.pathname).toBe(`${P}/file-policies/fp%2F..%2Fx%3F/ai-access`);
    expect(s.seen[0]!.url.search).toBe("");
  });

  it("같은 값이면 서버가 주는 changed:false · rev 를 그대로 돌려준다 (바뀐 척하지 않는다)", async () => {
    const same = { ...ACCESS, ai_access: "allow", rev: 1, changed: false };
    const s = server(routes({ "POST /file-policies/fp-1/ai-access": { status: 200, body: ok(same, { replayed: false }) } }));
    const r = await (await make(s)).setMaterialAiAccess(SLUG, ED, "fp-1", { ai_access: "allow" }, "key-ac");
    expect(r.data).toEqual(same);
    expect(r.data.changed).toBe(false);
  });

  it("replayed:true 는 영수증 replayed:true", async () => {
    const s = server(routes({ "POST /file-policies/fp-1/ai-access": { status: 200, body: ok(ACCESS, { replayed: true }) } }));
    const r = await (await make(s)).setMaterialAiAccess(SLUG, ED, "fp-1", { ai_access: "deny" }, "key-ac");
    expect(r.receipt.replayed).toBe(true);
  });

  it("멱등 키가 없으면 요청 0 으로 invalid_payload · 모르는 slug 는 요청 0 으로 not_found", async () => {
    const s = server(routes());
    const c = await make(s);
    const e1 = await c.setMaterialAiAccess(SLUG, ED, "fp-1", { ai_access: "deny" }, undefined).catch((e) => e);
    expect(e1).toBeInstanceOf(PesApiError);
    expect(e1.body.error.code).toBe("invalid_payload");
    expect(e1.body.error.target).toBe("$.headers.idempotency-key");
    const e2 = await c.setMaterialAiAccess("no-such-slug", ED, "fp-1", { ai_access: "deny" }, "key-ac").catch((e) => e);
    expect(e2.body.error.code).toBe("not_found");
    expect(s.seen).toHaveLength(0);
  });

  it("거절: 403(소유자 세션이 아님) · 401 · 404(모르는 정책)는 서버 봉투 그대로 PesApiError — 성공 영수증을 만들지 않는다", async () => {
    for (const [status, code] of [[403, "forbidden"], [401, "unauthenticated"], [404, "not_found"]] as const) {
      const s = server(routes({ "POST /file-policies/fp-1/ai-access": { status, body: fail(code) } }));
      const err = await (await make(s)).setMaterialAiAccess(SLUG, ED, "fp-1", { ai_access: "deny" }, "key-ac").catch((e) => e);
      expect(err).toBeInstanceOf(PesApiError);
      expect(err.body.error.code).toBe(code);
      expect(s.seen.some((x) => x.url.pathname.includes("/requests/"))).toBe(false);
    }
  });

  it("시간 초과: name TimeoutError, 같은 키로 다시 보내면 요청이 다시 나간다(재생은 서버가)", async () => {
    let n = 0;
    const s = server(routes({ "POST /file-policies/fp-1/ai-access": () => (++n === 1 ? "hang" : { status: 200, body: ok(ACCESS, { replayed: true }) }) }));
    const c = await make(s, { timeoutMs: 30 });
    const err = await c.setMaterialAiAccess(SLUG, ED, "fp-1", { ai_access: "deny" }, "key-ac").catch((e) => e);
    expect(err.name).toBe("TimeoutError");
    const r = await c.setMaterialAiAccess(SLUG, ED, "fp-1", { ai_access: "deny" }, "key-ac");
    expect(r.receipt.replayed).toBe(true);
    const posts = s.seen.filter((x) => x.method === "POST");
    expect(posts.map((x) => x.headers.get("idempotency-key"))).toEqual(["key-ac", "key-ac"]);
  });
});

describe("미리보기 — getMaterialPreview (GET P/files/{blob}/preview)", () => {
  const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

  it("요청: GET 에 세션 헤더 · credentials omit (그래서 주소 링크가 아니라 클라이언트가 바이트를 읽는다) · 본문 없음", async () => {
    const s = server({ "GET /files/blob-1/preview": { status: 200, bytes: bytes, headers: { "content-type": "text/plain", "content-disposition": "inline", "x-content-type-options": "nosniff" } } });
    await (await make(s)).getMaterialPreview(SLUG, ED, "blob-1");
    expect(s.seen).toHaveLength(1);
    const r = s.seen[0]!;
    expect(r.method).toBe("GET");
    expect(r.url.pathname).toBe(`${P}/files/blob-1/preview`);
    expect(r.headers.get("x-pes-session")).toBe(SESSION);
    expect(r.headers.get("idempotency-key")).toBeNull();
    expect(r.credentials).toBe("omit");
  });

  it("text/plain inline → 바이트 그대로 · inline true · sandbox null", async () => {
    const s = server({ "GET /files/blob-1/preview": { status: 200, bytes, headers: { "content-type": "text/plain; charset=utf-8", "content-disposition": "inline", "x-content-type-options": "nosniff" } } });
    const p = await (await make(s)).getMaterialPreview(SLUG, ED, "blob-1");
    expect(p).toMatchObject({ blob_id: "blob-1", content_type: "text/plain; charset=utf-8", inline: true, sandbox: null });
    expect(Array.from(p.bytes)).toEqual(Array.from(bytes));
  });

  it("image/png inline · 바이트가 깨지지 않는다 (텍스트로 읽지 않는다)", async () => {
    const s = server({ "GET /files/blob-5/preview": { status: 200, bytes: PNG, headers: { "content-type": "image/png", "content-disposition": "inline" } } });
    const p = await (await make(s)).getMaterialPreview(SLUG, ED, "blob-5");
    expect(p.content_type).toBe("image/png");
    expect(Array.from(p.bytes)).toEqual(Array.from(PNG));
  });

  it("attachment + octet-stream + CSP sandbox 헤더 → inline false · sandbox 값을 그대로 (열어 보여 줄 수 없다는 신호)", async () => {
    const s = server({ "GET /files/blob-2/preview": { status: 200, bytes, headers: { "content-type": "application/octet-stream", "content-disposition": "attachment", "content-security-policy": "sandbox", "x-content-type-options": "nosniff" } } });
    const p = await (await make(s)).getMaterialPreview(SLUG, ED, "blob-2");
    expect(p.inline).toBe(false);
    expect(p.sandbox).toBe("sandbox");
    expect(p.content_type).toBe("application/octet-stream");
  });

  it("content-disposition 이 없으면 inline 으로 간주하지 않는다 (모르면 열지 않는다)", async () => {
    const s = server({ "GET /files/blob-2/preview": { status: 200, bytes, headers: { "content-type": "application/pdf" } } });
    const p = await (await make(s)).getMaterialPreview(SLUG, ED, "blob-2");
    expect(p.inline).toBe(false);
  });

  it("거절: 409(staging · 바이트 변조) · 404(모르는 blob)는 PesApiError — 내용 없음, null 로 삼키지 않는다", async () => {
    for (const [status, code] of [[409, "conflict"], [404, "not_found"]] as const) {
      const s = server({ "GET /files/blob-3/preview": { status, body: fail(code) } });
      const err = await (await make(s)).getMaterialPreview(SLUG, ED, "blob-3").catch((e) => e);
      expect(err).toBeInstanceOf(PesApiError);
      expect(err.body.error.code).toBe(code);
    }
  });

  it("모르는 slug 는 요청 0 으로 not_found PesApiError", async () => {
    const s = server({});
    const err = await (await make(s)).getMaterialPreview("no-such-slug", ED, "blob-1").catch((e) => e);
    expect(err).toBeInstanceOf(PesApiError);
    expect(s.seen).toHaveLength(0);
  });
});

/* SEL-117 리뷰 권장 4 — 서버가 값을 안 주면 요청 값 · "allow" · NaN 을 지어내지 않고 null */
describe("리뷰 4 — 서버가 안 준 값은 null (지어내지 않음)", () => {
  it("setMaterialAiAccess: ai_access · rev 가 없으면 요청한 값 · NaN 이 아니라 null", async () => {
    const s = server({
      "POST /file-policies/fp-1/ai-access": { status: 200, body: ok({ file_policy_id: "fp-1", blob_id: "blob-1", changed: true }, { replayed: false }) },
      "GET /requests/key-ac": { status: 200, body: requestsRead("key-ac", "file.ai_access_changed", "tx-88") },
    });
    const r = await (await make(s)).setMaterialAiAccess(SLUG, ED, "fp-1", { ai_access: "deny" }, "key-ac");
    expect(r.data.ai_access).toBeNull();
    expect(r.data.rev).toBeNull();
    expect(r.data.ai_access).not.toBe("deny");
  });

  it("uploadMaterial: ai_access · version · size 가 없으면 “allow” · NaN 이 아니라 null", async () => {
    const { ai_access: _a, version_no: _v, size: _s, ...partial } = UPLOAD_RESULT as Record<string, unknown>;
    const s = server({
      "POST /uploads": { status: 201, body: ok({ blob_id: "blob-7", state: "staging" }) },
      "PUT /uploads/blob-7": { status: 200, body: ok({ blob_id: "blob-7" }) },
      "POST /uploads/blob-7/complete": { status: 200, body: ok({ blob_id: "blob-7", state: "ready" }) },
      "POST /materials": { status: 201, body: ok(partial, { replayed: false }) },
      "GET /requests/key-up": { status: 200, body: requestsRead("key-up", "file.material_uploaded") },
    });
    const r = await (await make(s)).uploadMaterial(SLUG, ED, { file: theFile() }, "key-up");
    expect(r.data.ai_access).toBeNull();
    expect(r.data.version).toBeNull();
    expect(r.data.size).toBeNull();
  });
});
