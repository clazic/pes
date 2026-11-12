// SEL-114 REF1b — HTTP 클라이언트가 참고 프로젝트 읽기 · 붙이기 · 다시 고정 · 떼기를 SEL-113(REF1a) 라우트로 잇는 매핑 (Vitest, fetch 는 가짜). 구현 전이라 실패가 정상.
// 서버 계약: SEL-113 tests/helpers/sel113_env.ts · tests/test_sel113_api.test.ts 머리말(git -C ~/hc-work/pes/SEL-113 show 081719e:<경로>). 클라이언트 모양: src/test/sel114.ts 머리말.
//
// ═══ 매핑 표 (P = /api/v1/projects/{id}; 모든 요청: 헤더 x-pes-session · credentials "omit"; 쓰기는 + idempotency-key) ═══
//  PesClient                                          요청                                                    결과
//  getReferences(slug, ed)                            GET  P/references                                        data.references[] → ReferenceRow[]   (404 · 모르는 slug → [], 요청 0)
//     ReferenceRow(15칸, sel114.ts REF_ROW_KEYS): 서버 칸을 그대로 — id · access · state · referenced_project_id · referenced_project_key · source_label · source_snapshot_id · source_snapshot_key · latest_snapshot_id
//                  · new_version_available · scope · ai_delivery{allowed, withheld_reason} · attached_at · refreshed_at · rev(10진 문자열 그대로).
//                  서버가 안 주는 칸(칸 없음 · 모르는 값)은 **null** — 권한 없는 줄(id · access · state 세 칸뿐)은 나머지 열두 칸이 모두 null.
//                  attached_by_actor_id 는 화면이 쓰지 않아 앱 행에 싣지 않는다. ai_delivery 가 없으면 null(allowed 로 간주하지 않는다). state 는 서버 값 그대로.
//  getReference(slug, ed, ref)                        GET  P/references/{ref}                                  data {reference, content} → 같은 모양. 404 → null · 403 → PesApiError forbidden
//     content = {items:[…]} | null.  항목: item · object_id · version_id · kind · title · summary · body_md · url · quote(서버가 그 종류에 안 준 칸은 null) · citation{reference_id, project_id, project_label, snapshot_id, object_id, version_id}
//  getReferenceCandidates(scope)                      서버에 읽는 길이 없다(후보 프로젝트 · 스냅숏 목록 라우트 없음) → NotConnectedError, 요청 0  (화면이 정직하게 알린다. 서버 쪽 읽기 라우트는 후속 — 보고서 참고)
//  attachReference(slug, ed, input, key)              POST P/references {referenced_project_id, source_snapshot_id, scope?(줄 때만), source_label?(비어 있지 않을 때만)} + idempotency-key  → 201 data.reference
//  refreshReference(slug, ed, ref, input, key)        POST P/references/{ref}/refresh {source_snapshot_id?, base_rev?}(준 것만)  → 200 data.reference
//  detachReference(slug, ed, ref, key)                POST P/references/{ref}/detach {}  → 200 data {reference_id, detached:true}
//     쓰기 결과 data: attach · refresh = {reference: 위 행 모양}, detach = 서버 data 그대로. receipt ← 성공 뒤 GET P/requests/{key} (SEL-92 · SEL-100 · SEL-117 과 같은 방식): {receipt_no(비어 있지 않음), tx_id, committed_at(ISO), idempotency_key, replayed: 본문 replayed === true}
//  거절: 서버 오류 봉투 그대로 PesApiError(.body.error.code · .details · .target 보존): 401 unauthenticated · 403 human_required/forbidden · 404 not_found · 409 conflict · 409 rev_conflict · 409 idempotency_key_reuse · 422 validation_failed · 400 invalid_payload
//  멱등 키 없음: 요청 0 으로 invalid_payload PesApiError(target "$.headers.idempotency-key"). 모르는 slug 쓰기: not_found PesApiError, 요청 0.
//  시간: 쓰기 한 번(요청 · 영수증 읽기 각각)에 timeoutMs 제한. 넘으면 name "TimeoutError" — 같은 키로 다시 보내면 서버가 재생한다.
import { describe, expect, it, vi } from "vitest";
import { WORKSPACE } from "@/api/fixture";
import { FORMAT_VERSION, NotConnectedError, PesApiError, type PesClient } from "@/api/types";
import { REF_ROW_KEYS, type ReferencesMethods } from "@/test/sel114";

type Opts = { session: string; projects: Record<string, string>; baseUrl?: string; fetch?: typeof fetch; timeoutMs?: number };
const modules = import.meta.glob<{ createHttpClient: (o: Opts) => PesClient }>("/src/api/http-client.{ts,tsx}");
const load = async () => {
  const loader = Object.values(modules)[0];
  if (!loader) throw new Error("src/api/http-client.ts 가 없다");
  return (await loader()).createHttpClient;
};

const SESSION = "synthetic-session-ref1b";
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
  credentials: string | undefined;
}
type Reply = { status: number; body?: unknown } | "hang";
function server(routes: Record<string, Reply | ((s: Seen) => Reply)>) {
  const seen: Seen[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input), "http://app.invalid");
    const body = init?.body;
    const s: Seen = { url, method: (init?.method ?? "GET").toUpperCase(), headers: new Headers(init?.headers), json: typeof body === "string" ? JSON.parse(body) : null, credentials: init?.credentials };
    seen.push(s);
    const hit = routes[`${s.method} ${url.pathname.replace(P, "")}`];
    const r = typeof hit === "function" ? hit(s) : (hit ?? { status: 404, body: fail("not_found") });
    if (r === "hang") return new Promise<Response>(() => {});
    return new Response(JSON.stringify(r.body), { status: r.status });
  });
  return { impl: impl as unknown as typeof fetch, seen };
}
const make = async (s: ReturnType<typeof server>, extra: Partial<Opts> = {}) => (await load())({ session: SESSION, projects: { [SLUG]: ID }, fetch: s.impl, ...extra }) as PesClient & ReferencesMethods;
const steps = (s: ReturnType<typeof server>) => s.seen.map((x) => `${x.method} ${x.url.pathname.replace(P, "")}`);

// ───────────── 서버 쪽 합성 값 (SEL-113 REF_KEYS 열여섯 칸) ─────────────
const sRef = (o: Record<string, unknown> = {}) => ({
  access: "ok", ai_delivery: { allowed: true, withheld_reason: null }, attached_at: "2026-11-10T09:00:00+09:00", attached_by_actor_id: "actor-1", id: "ref-1",
  latest_snapshot_id: "snap-2", new_version_available: true, referenced_project_id: "pj-src-1", referenced_project_key: "synthetic-src", refreshed_at: null, rev: "3",
  scope: ["final_report", "sources"], source_label: "합성 원본", source_snapshot_id: "snap-1", source_snapshot_key: "1판 완료본", state: "new_version", ...o,
});
const sNoPerm = { id: "ref-9", access: "no_permission", state: "no_permission" };
const LIST_OK = { status: 200, body: ok({ references: [sRef(), sNoPerm] }) };

const sItem = (kind: "final_report" | "sources", o: Record<string, unknown> = {}) =>
  kind === "final_report"
    ? { item: "final_report", object_id: "obj-1", version_id: "ver-1", kind: "report", title: "합성 보고서", summary: "합성 요약", body_md: "# 본문", citation: { reference_id: "ref-1", project_id: "pj-src-1", project_label: "합성 원본", snapshot_id: "snap-1", object_id: "obj-1", version_id: "ver-1" }, ...o }
    : { item: "sources", object_id: "obj-2", version_id: "ver-2", kind: "web", title: "합성 출처", url: "https://example.invalid/x", quote: "합성 발췌", citation: { reference_id: "ref-1", project_id: "pj-src-1", project_label: "합성 원본", snapshot_id: "snap-1", object_id: "obj-2", version_id: "ver-2" }, ...o };

describe("읽기 — GET P/references", () => {
  it("요청: GET P/references (세션 헤더 · 본문 없음 · 쓰기 헤더 없음 · credentials omit)", async () => {
    const s = server({ "GET /references": LIST_OK });
    const rows = await (await make(s)).getReferences(SLUG, ED);
    expect(rows).toHaveLength(2);
    expect(s.seen).toHaveLength(1);
    const r = s.seen[0]!;
    expect(r.method).toBe("GET");
    expect(r.url.pathname).toBe(`${P}/references`);
    expect(r.headers.get("x-pes-session")).toBe(SESSION);
    expect(r.headers.get("idempotency-key")).toBeNull();
    expect(r.json).toBeNull();
    expect(r.credentials).toBe("omit");
  });

  it("행 매핑: 서버 칸 그대로 · rev 는 문자열 · 앱 행의 키는 정한 열다섯 개뿐(attached_by_actor_id 등 안 싣는다)", async () => {
    const s = server({ "GET /references": LIST_OK });
    const [a] = await (await make(s)).getReferences(SLUG, ED);
    expect(Object.keys(a!).sort()).toEqual(REF_ROW_KEYS);
    expect(a).toEqual({
      access: "ok", ai_delivery: { allowed: true, withheld_reason: null }, attached_at: "2026-11-10T09:00:00+09:00", id: "ref-1", latest_snapshot_id: "snap-2", new_version_available: true,
      referenced_project_id: "pj-src-1", referenced_project_key: "synthetic-src", refreshed_at: null, rev: "3", scope: ["final_report", "sources"], source_label: "합성 원본",
      source_snapshot_id: "snap-1", source_snapshot_key: "1판 완료본", state: "new_version",
    });
    expect(typeof a!.rev).toBe("string");
  });

  it("권한 없는 줄(서버가 세 칸만 준다)은 나머지 열두 칸이 모두 null — 이름 · 키 · 버전을 지어내지 않는다", async () => {
    const s = server({ "GET /references": LIST_OK });
    const rows = await (await make(s)).getReferences(SLUG, ED);
    const n = rows[1]!;
    expect(Object.keys(n).sort()).toEqual(REF_ROW_KEYS);
    expect(n).toMatchObject({ id: "ref-9", access: "no_permission", state: "no_permission" });
    for (const k of REF_ROW_KEYS.filter((k) => !["id", "access", "state"].includes(k))) expect((n as unknown as Record<string, unknown>)[k], k).toBeNull();
  });

  it("원본 없음(tombstone): 서버가 준 label · key 를 그대로 싣고, 없는 project id · 스냅숏은 null", async () => {
    const gone = sRef({ id: "ref-3", state: "source_missing", referenced_project_id: null, source_snapshot_id: null, latest_snapshot_id: null, new_version_available: false, ai_delivery: { allowed: false, withheld_reason: "source_missing" } });
    const s = server({ "GET /references": { status: 200, body: ok({ references: [gone] }) } });
    const [a] = await (await make(s)).getReferences(SLUG, ED);
    expect(a).toMatchObject({ state: "source_missing", source_label: "합성 원본", referenced_project_key: "synthetic-src", source_snapshot_key: "1판 완료본", referenced_project_id: null, source_snapshot_id: null, latest_snapshot_id: null });
    expect(a!.ai_delivery).toEqual({ allowed: false, withheld_reason: "source_missing" });
  });

  it("AI 전달: withheld_reason 을 서버 값 그대로 싣는다. ai_delivery 칸이 없으면 null(allowed 로 간주하지 않는다)", async () => {
    const withheld = sRef({ id: "ref-2", ai_delivery: { allowed: false, withheld_reason: "project_go_off" } });
    const { ai_delivery: _drop, ...noDelivery } = sRef({ id: "ref-3" });
    const s = server({ "GET /references": { status: 200, body: ok({ references: [withheld, noDelivery] }) } });
    const [a, b] = await (await make(s)).getReferences(SLUG, ED);
    expect(a!.ai_delivery).toEqual({ allowed: false, withheld_reason: "project_go_off" });
    expect(b!.ai_delivery).toBeNull();
  });

  it("서버가 칸을 빠뜨리면 지어내지 않고 null (new_version_available · scope · latest_snapshot_id)", async () => {
    const { new_version_available: _a, scope: _b, latest_snapshot_id: _c, ...thin } = sRef();
    const s = server({ "GET /references": { status: 200, body: ok({ references: [thin] }) } });
    const [a] = await (await make(s)).getReferences(SLUG, ED);
    expect(a).toMatchObject({ new_version_available: null, scope: null, latest_snapshot_id: null });
  });

  it("404 는 [] , 모르는 slug 는 요청 없이 []", async () => {
    const s = server({});
    const c = await make(s);
    expect(await c.getReferences(SLUG, ED)).toEqual([]);
    const before = s.seen.length;
    expect(await c.getReferences("no-such-slug", ED)).toEqual([]);
    expect(s.seen).toHaveLength(before);
  });

  it("401 · 403 은 PesApiError 로 그대로 (빈 목록으로 삼키지 않는다)", async () => {
    for (const [status, code] of [[403, "forbidden"], [401, "unauthenticated"]] as const) {
      const s = server({ "GET /references": { status, body: fail(code) } });
      await expect((await make(s)).getReferences(SLUG, ED)).rejects.toMatchObject({ body: { error: { code } } });
    }
  });
});

describe("읽기 — getReference (GET P/references/{ref})", () => {
  const DETAIL = { status: 200, body: ok({ reference: sRef(), content: { items: [sItem("final_report"), sItem("sources")] } }) };

  it("요청 경로 · 매핑: reference 는 행 모양, 보고서 항목의 url · quote 와 출처 항목의 summary · body_md 는 null, 인용 칸은 서버 그대로", async () => {
    const s = server({ "GET /references/ref-1": DETAIL });
    const d = await (await make(s)).getReference(SLUG, ED, "ref-1");
    expect(steps(s)).toEqual(["GET /references/ref-1"]);
    expect(s.seen[0]!.headers.get("x-pes-session")).toBe(SESSION);
    expect(Object.keys(d!.reference).sort()).toEqual(REF_ROW_KEYS);
    expect(d!.content!.items).toHaveLength(2);
    const [rep, src] = d!.content!.items;
    expect(rep).toEqual({
      item: "final_report", object_id: "obj-1", version_id: "ver-1", kind: "report", title: "합성 보고서", summary: "합성 요약", body_md: "# 본문", url: null, quote: null,
      citation: { reference_id: "ref-1", project_id: "pj-src-1", project_label: "합성 원본", snapshot_id: "snap-1", object_id: "obj-1", version_id: "ver-1" },
    });
    expect(src).toEqual({
      item: "sources", object_id: "obj-2", version_id: "ver-2", kind: "web", title: "합성 출처", summary: null, body_md: null, url: "https://example.invalid/x", quote: "합성 발췌",
      citation: { reference_id: "ref-1", project_id: "pj-src-1", project_label: "합성 원본", snapshot_id: "snap-1", object_id: "obj-2", version_id: "ver-2" },
    });
  });

  it("content 가 null(원본 없음 · 접근 없음)이면 null 그대로 — 빈 목록으로 바꾸지 않는다", async () => {
    const s = server({ "GET /references/ref-1": { status: 200, body: ok({ reference: sRef({ state: "source_missing" }), content: null }) } });
    const d = await (await make(s)).getReference(SLUG, ED, "ref-1");
    expect(d!.content).toBeNull();
  });

  it("404 → null · 모르는 slug → 요청 0 으로 null · 403 → PesApiError forbidden", async () => {
    const s = server({});
    const c = await make(s);
    expect(await c.getReference(SLUG, ED, "ref-x")).toBeNull();
    const before = s.seen.length;
    expect(await c.getReference("no-such-slug", ED, "ref-1")).toBeNull();
    expect(s.seen).toHaveLength(before);
    const s2 = server({ "GET /references/ref-1": { status: 403, body: fail("forbidden") } });
    await expect((await make(s2)).getReference(SLUG, ED, "ref-1")).rejects.toMatchObject({ body: { error: { code: "forbidden" } } });
  });

  it("참고 id 는 경로에 안전하게 들어간다 (슬래시 · 물음표가 경로를 바꾸지 않는다)", async () => {
    const s = server({ "GET /references/ref%2F..%2Fx%3F": { status: 404, body: fail("not_found") } });
    await (await make(s)).getReference(SLUG, ED, "ref/../x?");
    expect(s.seen).toHaveLength(1);
    expect(s.seen[0]!.url.pathname).toBe(`${P}/references/ref%2F..%2Fx%3F`);
    expect(s.seen[0]!.url.search).toBe("");
  });
});

describe("후보 읽기 — getReferenceCandidates", () => {
  it("서버에 읽는 길이 없다: NotConnectedError, 요청 0 (후보를 지어내지 않는다) — 생성 화면(null)도 작업 중도 같다", async () => {
    const s = server({});
    const c = await make(s);
    await expect(c.getReferenceCandidates({ slug: SLUG, edition: ED })).rejects.toBeInstanceOf(NotConnectedError);
    await expect(c.getReferenceCandidates(null)).rejects.toBeInstanceOf(NotConnectedError);
    expect(s.seen).toHaveLength(0);
  });
});

describe("붙이기 — attachReference (POST P/references)", () => {
  const routes = (over: Record<string, Reply | ((s: Seen) => Reply)> = {}) => ({
    "POST /references": { status: 201, body: ok({ reference: sRef({ id: "ref-7", state: "pinned", new_version_available: false }) }, { replayed: false }) },
    "GET /requests/key-at": { status: 200, body: requestsRead("key-at", "reference.attached") },
    ...over,
  });

  it("순서 · 본문: POST 한 번(멱등 키) 뒤 영수증 읽기. 본문 {referenced_project_id, source_snapshot_id, scope}, 결과 data.reference 는 행 모양 + 영수증", async () => {
    const s = server(routes());
    const r = await (await make(s)).attachReference(SLUG, ED, { referenced_project_id: "pj-src-1", source_snapshot_id: "snap-1", scope: ["final_report"] }, "key-at");
    expect(steps(s)).toEqual(["POST /references", "GET /requests/key-at"]);
    const w = s.seen[0]!;
    expect(w.json).toEqual({ referenced_project_id: "pj-src-1", source_snapshot_id: "snap-1", scope: ["final_report"] });
    expect(w.headers.get("idempotency-key")).toBe("key-at");
    for (const q of s.seen) {
      expect(q.headers.get("x-pes-session")).toBe(SESSION);
      expect(q.credentials).toBe("omit");
    }
    expect(Object.keys(r.data.reference).sort()).toEqual(REF_ROW_KEYS);
    expect(r.data.reference).toMatchObject({ id: "ref-7", state: "pinned" });
    expect(r.receipt).toMatchObject({ idempotency_key: "key-at", tx_id: "tx-77", replayed: false });
    expect(r.receipt.receipt_no).toBeTruthy();
    expect(Number.isNaN(Date.parse(r.receipt.committed_at))).toBe(false);
  });

  it("scope · source_label 은 줄 때만(비어 있지 않을 때만) 본문에 싣는다 — 서버 기본 범위를 덮어쓰지 않는다", async () => {
    const s = server(routes());
    await (await make(s)).attachReference(SLUG, ED, { referenced_project_id: "pj-src-1", source_snapshot_id: "snap-1" }, "key-at");
    expect(Object.keys(s.seen[0]!.json!).sort()).toEqual(["referenced_project_id", "source_snapshot_id"]);
    const s2 = server(routes());
    await (await make(s2)).attachReference(SLUG, ED, { referenced_project_id: "pj-src-1", source_snapshot_id: "snap-1", source_label: "" }, "key-at");
    expect(Object.keys(s2.seen[0]!.json!)).not.toContain("source_label");
    const s3 = server(routes());
    await (await make(s3)).attachReference(SLUG, ED, { referenced_project_id: "pj-src-1", source_snapshot_id: "snap-1", source_label: "내가 붙인 이름" }, "key-at");
    expect(s3.seen[0]!.json).toMatchObject({ source_label: "내가 붙인 이름" });
  });

  it("같은 키 다시 = 서버가 replayed:true 를 주면 영수증 replayed:true", async () => {
    const s = server(routes({ "POST /references": { status: 201, body: ok({ reference: sRef({ id: "ref-7" }) }, { replayed: true }) } }));
    const r = await (await make(s)).attachReference(SLUG, ED, { referenced_project_id: "pj-src-1", source_snapshot_id: "snap-1" }, "key-at");
    expect(r.receipt.replayed).toBe(true);
  });

  it("멱등 키가 없으면 요청 0 으로 invalid_payload · 모르는 slug 는 요청 0 으로 not_found", async () => {
    const s = server(routes());
    const c = await make(s);
    const e1 = await c.attachReference(SLUG, ED, { referenced_project_id: "pj-src-1", source_snapshot_id: "snap-1" }, undefined).catch((e) => e);
    expect(e1).toBeInstanceOf(PesApiError);
    expect(e1.body.error.code).toBe("invalid_payload");
    expect(e1.body.error.target).toBe("$.headers.idempotency-key");
    const e2 = await c.attachReference("no-such-slug", ED, { referenced_project_id: "pj-src-1", source_snapshot_id: "snap-1" }, "key-at").catch((e) => e);
    expect(e2).toBeInstanceOf(PesApiError);
    expect(e2.body.error.code).toBe("not_found");
    expect(s.seen).toHaveLength(0);
  });

  it("거절은 서버 봉투 그대로 PesApiError (code · details · target 보존) — 영수증을 읽지 않는다", async () => {
    const cases: Array<[number, string, string]> = [
      [409, "conflict", "$.body.referenced_project_id"],
      [422, "validation_failed", "$.body.scope"],
      [403, "human_required", "$.headers"],
      [404, "not_found", "$.body.source_snapshot_id"],
      [409, "idempotency_key_reuse", "$.headers.idempotency-key"],
    ];
    for (const [status, code, target] of cases) {
      const s = server(routes({ "POST /references": { status, body: fail(code, { reason: "합성" }, target) } }));
      const err = await (await make(s)).attachReference(SLUG, ED, { referenced_project_id: "pj-src-1", source_snapshot_id: "snap-1" }, "key-at").catch((e) => e);
      expect(err, code).toBeInstanceOf(PesApiError);
      expect(err.body.error).toMatchObject({ code, target, details: { reason: "합성" } });
      expect(s.seen.some((x) => x.url.pathname.includes("/requests/"))).toBe(false);
    }
  });

  it("시간 초과: 요청이 안 끝나면 name TimeoutError, 같은 키로 다시 보내면 요청이 다시 나가 서버 재생 영수증을 받는다", async () => {
    let n = 0;
    const s = server(routes({ "POST /references": () => (++n === 1 ? "hang" : { status: 201, body: ok({ reference: sRef({ id: "ref-7" }) }, { replayed: true }) }) }));
    const c = await make(s, { timeoutMs: 30 });
    const err = await c.attachReference(SLUG, ED, { referenced_project_id: "pj-src-1", source_snapshot_id: "snap-1" }, "key-at").catch((e) => e);
    expect(err.name).toBe("TimeoutError");
    const r = await c.attachReference(SLUG, ED, { referenced_project_id: "pj-src-1", source_snapshot_id: "snap-1" }, "key-at");
    expect(r.receipt.replayed).toBe(true);
    expect(s.seen.filter((x) => x.method === "POST").map((x) => x.headers.get("idempotency-key"))).toEqual(["key-at", "key-at"]);
  });
});

describe("다시 고정 — refreshReference (POST P/references/{ref}/refresh)", () => {
  const routes = (over: Record<string, Reply | ((s: Seen) => Reply)> = {}) => ({
    "POST /references/ref-1/refresh": { status: 200, body: ok({ reference: sRef({ source_snapshot_id: "snap-2", source_snapshot_key: "2판 R1 승인본", state: "pinned", new_version_available: false, rev: "4" }) }, { replayed: false }) },
    "GET /requests/key-rf": { status: 200, body: requestsRead("key-rf", "reference.refreshed", "tx-88") },
    ...over,
  });

  it("요청: 경로의 참고 id · 본문 {source_snapshot_id, base_rev} · 멱등 키, 결과 data.reference 는 새 행 모양 + 영수증", async () => {
    const s = server(routes());
    const r = await (await make(s)).refreshReference(SLUG, ED, "ref-1", { source_snapshot_id: "snap-2", base_rev: "3" }, "key-rf");
    expect(steps(s)).toEqual(["POST /references/ref-1/refresh", "GET /requests/key-rf"]);
    const w = s.seen[0]!;
    expect(w.json).toEqual({ source_snapshot_id: "snap-2", base_rev: "3" });
    expect(w.headers.get("idempotency-key")).toBe("key-rf");
    expect(w.headers.get("x-pes-session")).toBe(SESSION);
    expect(w.credentials).toBe("omit");
    expect(r.data.reference).toMatchObject({ id: "ref-1", source_snapshot_id: "snap-2", source_snapshot_key: "2판 R1 승인본", state: "pinned", rev: "4" });
    expect(r.receipt).toMatchObject({ idempotency_key: "key-rf", tx_id: "tx-88", replayed: false });
  });

  it("source_snapshot_id · base_rev 는 준 것만 본문에 싣는다 (없으면 키 자체가 없다 — 서버가 가장 나중 스냅숏으로 정한다)", async () => {
    const s = server(routes());
    await (await make(s)).refreshReference(SLUG, ED, "ref-1", {}, "key-rf");
    expect(s.seen[0]!.json).toEqual({});
    const s2 = server(routes());
    await (await make(s2)).refreshReference(SLUG, ED, "ref-1", { base_rev: "3" }, "key-rf");
    expect(s2.seen[0]!.json).toEqual({ base_rev: "3" });
  });

  it("참고 id 는 경로에 안전하게 들어간다", async () => {
    const s = server({ "POST /references/ref%2F..%2Fx%3F/refresh": { status: 404, body: fail("not_found") } });
    await (await make(s)).refreshReference(SLUG, ED, "ref/../x?", { source_snapshot_id: "snap-2" }, "key-rf").catch(() => {});
    expect(s.seen).toHaveLength(1);
    expect(s.seen[0]!.url.pathname).toBe(`${P}/references/ref%2F..%2Fx%3F/refresh`);
    expect(s.seen[0]!.url.search).toBe("");
  });

  it("409 conflict(이미 그 버전 · 원본 없음) · 409 rev_conflict 는 서버 봉투 그대로 — 성공 영수증을 만들지 않는다", async () => {
    for (const code of ["conflict", "rev_conflict"]) {
      const s = server(routes({ "POST /references/ref-1/refresh": { status: 409, body: fail(code, { reason: "합성" }) } }));
      const err = await (await make(s)).refreshReference(SLUG, ED, "ref-1", { source_snapshot_id: "snap-2", base_rev: "3" }, "key-rf").catch((e) => e);
      expect(err, code).toBeInstanceOf(PesApiError);
      expect(err.body.error).toMatchObject({ code, details: { reason: "합성" } });
      expect(s.seen.some((x) => x.url.pathname.includes("/requests/"))).toBe(false);
    }
  });

  it("멱등 키가 없으면 요청 0 · 모르는 slug 는 요청 0 으로 not_found · replayed:true 는 영수증 replayed:true", async () => {
    const s = server(routes());
    const c = await make(s);
    const e1 = await c.refreshReference(SLUG, ED, "ref-1", { source_snapshot_id: "snap-2" }, undefined).catch((e) => e);
    expect(e1.body.error).toMatchObject({ code: "invalid_payload", target: "$.headers.idempotency-key" });
    const e2 = await c.refreshReference("no-such-slug", ED, "ref-1", { source_snapshot_id: "snap-2" }, "key-rf").catch((e) => e);
    expect(e2.body.error.code).toBe("not_found");
    expect(s.seen).toHaveLength(0);
    const s2 = server(routes({ "POST /references/ref-1/refresh": { status: 200, body: ok({ reference: sRef() }, { replayed: true }) } }));
    const r = await (await make(s2)).refreshReference(SLUG, ED, "ref-1", { source_snapshot_id: "snap-2" }, "key-rf");
    expect(r.receipt.replayed).toBe(true);
  });

  it("시간 초과: name TimeoutError", async () => {
    const s = server(routes({ "POST /references/ref-1/refresh": "hang" }));
    const err = await (await make(s, { timeoutMs: 30 })).refreshReference(SLUG, ED, "ref-1", { source_snapshot_id: "snap-2" }, "key-rf").catch((e) => e);
    expect(err.name).toBe("TimeoutError");
  });
});

describe("떼기 — detachReference (POST P/references/{ref}/detach)", () => {
  const routes = (over: Record<string, Reply | ((s: Seen) => Reply)> = {}) => ({
    "POST /references/ref-1/detach": { status: 200, body: ok({ reference_id: "ref-1", detached: true }, { replayed: false }) },
    "GET /requests/key-dt": { status: 200, body: requestsRead("key-dt", "reference.detached", "tx-99") },
    ...over,
  });

  it("요청: 경로의 참고 id · 빈 본문 · 멱등 키, 결과는 서버 data 그대로 + 영수증", async () => {
    const s = server(routes());
    const r = await (await make(s)).detachReference(SLUG, ED, "ref-1", "key-dt");
    expect(steps(s)).toEqual(["POST /references/ref-1/detach", "GET /requests/key-dt"]);
    const w = s.seen[0]!;
    expect(w.json ?? {}).toEqual({});
    expect(w.headers.get("idempotency-key")).toBe("key-dt");
    expect(w.headers.get("x-pes-session")).toBe(SESSION);
    expect(w.credentials).toBe("omit");
    expect(r.data).toEqual({ reference_id: "ref-1", detached: true });
    expect(r.receipt).toMatchObject({ idempotency_key: "key-dt", tx_id: "tx-99", replayed: false });
    expect(r.receipt.receipt_no).toBeTruthy();
  });

  it("멱등 키가 없으면 요청 0 · 모르는 slug 는 요청 0 으로 not_found · replayed:true 는 영수증 replayed:true", async () => {
    const s = server(routes());
    const c = await make(s);
    const e1 = await c.detachReference(SLUG, ED, "ref-1", undefined).catch((e) => e);
    expect(e1.body.error).toMatchObject({ code: "invalid_payload", target: "$.headers.idempotency-key" });
    const e2 = await c.detachReference("no-such-slug", ED, "ref-1", "key-dt").catch((e) => e);
    expect(e2.body.error.code).toBe("not_found");
    expect(s.seen).toHaveLength(0);
    const s2 = server(routes({ "POST /references/ref-1/detach": { status: 200, body: ok({ reference_id: "ref-1", detached: true }, { replayed: true }) } }));
    const r = await (await make(s2)).detachReference(SLUG, ED, "ref-1", "key-dt");
    expect(r.receipt.replayed).toBe(true);
  });

  it("거절: 403 human_required · 401 · 404 는 서버 봉투 그대로 PesApiError — 성공 영수증을 만들지 않는다", async () => {
    for (const [status, code] of [[403, "human_required"], [401, "unauthenticated"], [404, "not_found"]] as const) {
      const s = server(routes({ "POST /references/ref-1/detach": { status, body: fail(code) } }));
      const err = await (await make(s)).detachReference(SLUG, ED, "ref-1", "key-dt").catch((e) => e);
      expect(err).toBeInstanceOf(PesApiError);
      expect(err.body.error.code).toBe(code);
      expect(s.seen.some((x) => x.url.pathname.includes("/requests/"))).toBe(false);
    }
  });

  it("시간 초과: name TimeoutError, 같은 키로 다시 보내면 요청이 다시 나간다(재생은 서버가)", async () => {
    let n = 0;
    const s = server(routes({ "POST /references/ref-1/detach": () => (++n === 1 ? "hang" : { status: 200, body: ok({ reference_id: "ref-1", detached: true }, { replayed: true }) }) }));
    const c = await make(s, { timeoutMs: 30 });
    const err = await c.detachReference(SLUG, ED, "ref-1", "key-dt").catch((e) => e);
    expect(err.name).toBe("TimeoutError");
    const r = await c.detachReference(SLUG, ED, "ref-1", "key-dt");
    expect(r.receipt.replayed).toBe(true);
    expect(s.seen.filter((x) => x.method === "POST").map((x) => x.headers.get("idempotency-key"))).toEqual(["key-dt", "key-dt"]);
  });
});
