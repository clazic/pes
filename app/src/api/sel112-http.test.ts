// SEL-112 U4b — HTTP 클라이언트가 첨언·후속 읽기 1개와 쓰기 6개를 SEL-99(U4a) 라우트로 연결하는 매핑 (Vitest, fetch 는 가짜). 구현 전이라 실패가 정상.
// 서버 계약: SEL-99 tests/test_sel99_thread_api.test.ts 머리말(git -C ~/hc-work/pes/SEL-99 show b44aa1c:tests/test_sel99_thread_api.test.ts). 앱 쪽 모양: src/test/sel112.ts 머리말.
//
// ═══ 매핑 표 (P = /api/v1/projects/{id}; 모든 요청: 헤더 x-pes-session · credentials "omit"; 쓰기는 + idempotency-key · JSON 본문 format_version "1.0") ═══
//  PesClient                                          요청                                                          본문 / 결과
//  getAnnotations(slug, ed, objectId)                 GET P/threads?target_object_id=<id>&context_kind=annotation  data.threads[] 각각 → GET P/threads/{t} (상세) · 후속은 GET P/followups (thread_id= 또는 전체)
//                                                     → AnnotationThreadView[]  (빈 목록이면 상세 요청 없음 · 404/모르는 slug → [])
//  createAnnotation(slug, ed, input, key)             POST P/threads                                                {target_object_id, target_version_id, context_kind:"annotation", anchor:{exact_quote, prefix, suffix, start_cp, end_cp}, initial_message:{body_md}}
//                                                     결과 data ← {thread_id: data.thread.id, message_id: data.message.id, anchor_id: data.thread.anchor_id, anchor_status: data.thread.anchor_status}
//  replyAnnotation(slug, ed, t, {body_md}, key)       POST P/threads/{t}/messages                                   {body_md}               결과 {thread_id: data.thread_id, message_id: data.message.id}
//  resolveAnnotation(slug, ed, t, {resolution, reason, target_stage?, base_version_id?}, key)
//                                                     POST P/threads/{t}/resolutions                                {resolution, reason, followup?: {kind, description, target_version_id? | target_stage_id?}} — none 은 followup 없음, 그 밖은 필수   결과 {thread_id: data.thread.id, state: data.thread.state, followup_id: data.followup?.id ?? null, applied: data.applied}
//  reanchorAnnotation(slug, ed, t, {version_id?, start_cp, end_cp}, key)
//                                                     POST P/threads/{t}/reanchor                                   {version_id?(있을 때만), start_cp, end_cp}   결과 {thread_id: data.thread_id, anchor_status: data.anchor.status}
//  proposeFollowup(slug, ed, {origin_thread_id, kind, description}, key)
//                                                     POST P/followups                                              {origin_thread_id, kind, description}        결과 {followup_id: data.followup.id, state: data.followup.state}
//  applyFollowup(slug, ed, f, {base_version_id, expected_rev}, key)
//                                                     POST P/followups/{f}/apply                                    {base_version_id, expected_rev}   결과 {followup_id: data.followup.id, state, result_version_id, applied_tx_id}
//  쓰기 영수증 ← 성공(2xx) 뒤 GET P/requests/{key} (SEL-92·SEL-100 과 같은 방식). 거절은 서버 오류 봉투 그대로 PesApiError(.body.error.code · .details 보존): 409 basis_changed · 409 thread_closed · 409 already_resolved · 403 human_required …
//  멱등 키 없음: 요청 없이 invalid_payload PesApiError(target "$.headers.idempotency-key"). 모르는 slug 읽기: [] · 쓰기: not_found PesApiError, 요청 0.
//  서버가 주지 않는 값은 null: 메시지 작성자 종류(by) = null(서버는 actor_id 만), anchor.current.confirmed_by_actor_id ← 서버 값 | null, 위치 없는 ambiguous·lost 의 start_cp/end_cp/text = null.
import { describe, expect, it, vi } from "vitest";
import { createFakeClient } from "@/api/fake-client";
import { WORKSPACE } from "@/api/fixture";
import { FORMAT_VERSION, PesApiError, type PesClient } from "@/api/types";

type Opts = { session: string; projects: Record<string, string>; baseUrl?: string; fetch?: typeof fetch; timeoutMs?: number };
const modules = import.meta.glob<{ createHttpClient: (o: Opts) => PesClient }>("/src/api/http-client.{ts,tsx}");
const load = async () => {
  const loader = Object.values(modules)[0];
  if (!loader) throw new Error("src/api/http-client.ts 가 없다");
  return (await loader()).createHttpClient;
};

// PesClient 확장(정한 인터페이스) — 구현의 types.ts 가 갖기 전에도 typecheck 가 되도록 느슨한 타입
interface U4Client {
  getAnnotations(slug: string, edition: number, objectId: string): Promise<any[]>;
  createAnnotation(slug: string, edition: number, input: any, key: string | undefined): Promise<any>;
  replyAnnotation(slug: string, edition: number, threadId: string, input: any, key: string | undefined): Promise<any>;
  resolveAnnotation(slug: string, edition: number, threadId: string, input: any, key: string | undefined): Promise<any>;
  reanchorAnnotation(slug: string, edition: number, threadId: string, input: any, key: string | undefined): Promise<any>;
  proposeFollowup(slug: string, edition: number, input: any, key: string | undefined): Promise<any>;
  applyFollowup(slug: string, edition: number, followupId: string, input: any, key: string | undefined): Promise<any>;
}

const SESSION = "synthetic-session-u4b";
const ID = "pj-synthetic-4";
const SLUG = WORKSPACE.slug;
const ED = WORKSPACE.edition;
const P = `/api/v1/projects/${ID}`;
const OBJ = "obj-r2-result";

const ok = (data: unknown, extra: Record<string, unknown> = {}) => ({ format_version: FORMAT_VERSION, request_id: "req-1", data, ...extra });
const fail = (code: string, details: unknown = null, target = "$.body", next = "reread_context") => ({ format_version: FORMAT_VERSION, request_id: "req-e", error: { code, message: "합성 거절 문장", retryable: false, target, details, next_action: next } });
const requestsRead = (key: string, action = "annotation.create", tx = "tx-77") => ok({ action, tx_id: tx, status: 201, run_id: null, key });

interface Seen {
  url: URL;
  method: string;
  headers: Headers;
  json: Record<string, unknown> | null;
  credentials: string | undefined;
}
type Reply = { status: number; body: unknown } | "hang";
function server(routes: Record<string, Reply | ((s: Seen) => Reply)>) {
  const seen: Seen[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input), "http://app.invalid");
    const s: Seen = { url, method: (init?.method ?? "GET").toUpperCase(), headers: new Headers(init?.headers), json: typeof init?.body === "string" ? JSON.parse(init.body) : null, credentials: init?.credentials };
    seen.push(s);
    const hit = routes[`${s.method} ${url.pathname.replace(P, "")}`];
    const r = typeof hit === "function" ? hit(s) : (hit ?? { status: 404, body: fail("not_found") });
    if (r === "hang") return new Promise<Response>(() => {});
    return new Response(JSON.stringify(r.body), { status: r.status });
  });
  const writes = () => seen.filter((s) => s.method === "POST");
  return { impl: impl as unknown as typeof fetch, seen, writes };
}
const make = async (s: ReturnType<typeof server>, extra: Partial<Opts> = {}) => (await load())({ session: SESSION, projects: { [SLUG]: ID }, fetch: s.impl, ...extra }) as unknown as U4Client;

// ───────────── 서버 쪽 합성 행 ─────────────
const sList = (o: Record<string, unknown> = {}) => ({ id: "th-1", context_kind: "annotation", state: "open", target_object_id: OBJ, target_version_id: "ver-1", message_count: 2, anchor_status: "exact", summary: "첨언 요약", ...o });
const sMsg = (o: Record<string, unknown> = {}) => ({ id: "m-1", version_id: "mv-1", body_md: "근거를 더 설명해 주세요.", state: "published", reply_to: null, actor_id: "act-h1", created_at: "2026-11-12T05:00:00Z", ...o });
const sAnchor = (status: string, current: Record<string, unknown> = {}, o: Record<string, unknown> = {}) => ({
  id: "anc-1", exact_quote: "정책 대안은 두 가지다.", prefix: "1장 ", suffix: " 첫째는", text_format_version: 1, start_cp: 4, end_cp: 17, target_version_id: "ver-1", status,
  current: { evaluated_version_id: "ver-3", status, start_cp: 4, end_cp: 17, text: "정책 대안은 두 가지다.", candidates: [], confirmed_by_actor_id: null, ...current },
  ...o,
});
const sDetail = (o: Record<string, unknown> = {}, anchor: unknown = sAnchor("exact"), messages: unknown[] = [sMsg()], followups: unknown[] = [], resolution: unknown = null) =>
  ok({ thread: { id: "th-1", context_kind: "annotation", state: "open", target_object_id: OBJ, target_version_id: "ver-1", summary: "요약", resolution, ...o }, anchor, messages, followups });
const sFollowup = (o: Record<string, unknown> = {}) => ({
  id: "fu-1", kind: "edit_text", state: "proposed", description: "근거를 한 문장 더한다", version_no: "2", origin_thread_id: "th-1", origin_version_id: "ver-1", base_version_id: "ver-3", proposed_version_id: "ver-p1",
  proposed_body_md: "제안 본문", result_version_id: null, applied_tx_id: null, confirmed_by_actor_id: null, target_stage_id: null, ...o,
});

describe("읽기 — getAnnotations", () => {
  const routes = () => ({
    "GET /threads": { status: 200, body: ok({ threads: [sList(), sList({ id: "th-2", anchor_status: "ambiguous", message_count: 1 }), sList({ id: "th-3", anchor_status: "lost", state: "resolved" })] }) },
    "GET /threads/th-1": { status: 200, body: sDetail({}, sAnchor("exact"), [sMsg(), sMsg({ id: "m-2", version_id: "mv-2", actor_id: "act-ai1", body_md: "답글입니다.", reply_to: "m-1" })], [{ id: "fu-1", kind: "edit_text", state: "proposed" }]) },
    "GET /threads/th-2": { status: 200, body: sDetail({ id: "th-2" }, sAnchor("ambiguous", { start_cp: null, end_cp: null, text: null, candidates: [{ start_cp: 10, end_cp: 23 }, { start_cp: 40, end_cp: 53 }] })) },
    "GET /threads/th-3": {
      status: 200,
      body: sDetail({ id: "th-3", state: "resolved" }, sAnchor("lost", { start_cp: null, end_cp: null, text: null, candidates: [] }), [sMsg({ id: "m-9" })], [], { resolution: "none", reason: "닫음", followup_id: null, message_version_id: "mv-9" }),
    },
    "GET /followups": { status: 200, body: ok({ followups: [sFollowup()] }) },
  });

  it("목록 요청: GET P/threads?target_object_id=<객체>&context_kind=annotation (세션 헤더 · 본문 없음 · 쓰기 헤더 없음)", async () => {
    const s = server(routes());
    const rows = await (await make(s)).getAnnotations(SLUG, ED, OBJ);
    expect(rows).toHaveLength(3);
    const first = s.seen[0]!;
    expect(first.method).toBe("GET");
    expect(first.url.pathname).toBe(`${P}/threads`);
    expect(first.url.searchParams.get("target_object_id")).toBe(OBJ);
    expect(first.url.searchParams.get("context_kind")).toBe("annotation");
    for (const r of s.seen) {
      expect(r.method).toBe("GET");
      expect(r.headers.get("x-pes-session")).toBe(SESSION);
      expect(r.headers.get("idempotency-key")).toBeNull();
      expect(r.credentials).toBe("omit");
    }
    expect(s.seen.map((r) => r.url.pathname.replace(P, ""))).toEqual(expect.arrayContaining(["/threads/th-1", "/threads/th-2", "/threads/th-3"]));
  });

  it("스레드 매핑(exact): 상태 · 인용 · 위치 · 판정(current) · 메시지 · 후속 상세", async () => {
    const s = server(routes());
    const [t1] = await (await make(s)).getAnnotations(SLUG, ED, OBJ);
    expect(t1).toMatchObject({
      thread_id: "th-1",
      state: "open",
      target_object_id: OBJ,
      target_version_id: "ver-1",
      resolution: null,
      anchor: {
        exact_quote: "정책 대안은 두 가지다.",
        prefix: "1장 ",
        suffix: " 첫째는",
        start_cp: 4,
        end_cp: 17,
        target_version_id: "ver-1",
        current: { evaluated_version_id: "ver-3", status: "exact", start_cp: 4, end_cp: 17, text: "정책 대안은 두 가지다.", candidates: [], confirmed_by_actor_id: null },
      },
    });
    expect(t1.messages).toHaveLength(2);
    expect(t1.messages[0]).toMatchObject({ message_id: "m-1", body_md: "근거를 더 설명해 주세요.", at: "2026-11-12T05:00:00Z", actor_id: "act-h1" });
    expect(t1.followups).toHaveLength(1);
    expect(t1.followups[0]).toEqual({
      id: "fu-1",
      kind: "edit_text",
      state: "proposed",
      description: "근거를 한 문장 더한다",
      version_no: "2",
      origin_thread_id: "th-1",
      base_version_id: "ver-3",
      proposed_body_md: "제안 본문",
      proposed_version_id: "ver-p1",
      result_version_id: null,
      applied_tx_id: null,
      confirmed_by_actor_id: null,
    });
  });

  it("서버가 안 주는 값은 null: 메시지 작성자 종류 by = null(지어내지 않는다)", async () => {
    const s = server(routes());
    const [t1] = await (await make(s)).getAnnotations(SLUG, ED, OBJ);
    for (const m of t1.messages) expect(m.by).toBeNull();
  });

  it("ambiguous: 위치 없음(null) + 후보 목록 그대로 — 서버가 하나를 고르지 않았으니 앱도 고르지 않는다", async () => {
    const s = server(routes());
    const rows = await (await make(s)).getAnnotations(SLUG, ED, OBJ);
    const t2 = rows.find((r) => r.thread_id === "th-2")!;
    expect(t2.anchor.current).toMatchObject({ status: "ambiguous", start_cp: null, end_cp: null, text: null, candidates: [{ start_cp: 10, end_cp: 23 }, { start_cp: 40, end_cp: 53 }] });
  });

  it("lost: 위치 · 글 null, 후보 [] — 스레드는 지워지지 않고(해결 기록도 그대로) 목록에 남는다", async () => {
    const s = server(routes());
    const rows = await (await make(s)).getAnnotations(SLUG, ED, OBJ);
    const t3 = rows.find((r) => r.thread_id === "th-3")!;
    expect(t3.state).toBe("resolved");
    expect(t3.anchor.exact_quote).toBe("정책 대안은 두 가지다.");
    expect(t3.anchor.current).toMatchObject({ status: "lost", start_cp: null, end_cp: null, text: null, candidates: [] });
    expect(t3.resolution).toEqual({ resolution: "none", reason: "닫음", followup_id: null });
  });

  it("후속 없는 스레드의 followups 는 []", async () => {
    const s = server(routes());
    const rows = await (await make(s)).getAnnotations(SLUG, ED, OBJ);
    expect(rows.find((r) => r.thread_id === "th-2")!.followups).toEqual([]);
  });

  it("annotation 이 아닌 스레드(question_comment)가 섞여 와도 첨언 목록에 넣지 않는다", async () => {
    const s = server({ ...routes(), "GET /threads": { status: 200, body: ok({ threads: [sList(), sList({ id: "th-q", context_kind: "question_comment", anchor_status: null })] }) } });
    const rows = await (await make(s)).getAnnotations(SLUG, ED, OBJ);
    expect(rows.map((r) => r.thread_id)).toEqual(["th-1"]);
    expect(s.seen.some((r) => r.url.pathname.endsWith("/threads/th-q"))).toBe(false);
  });

  it("빈 목록이면 상세·후속 요청 없이 [] · 서버 404 도 [] · 모르는 slug 는 요청 없이 []", async () => {
    const empty = server({ "GET /threads": { status: 200, body: ok({ threads: [] }) } });
    expect(await (await make(empty)).getAnnotations(SLUG, ED, OBJ)).toEqual([]);
    expect(empty.seen).toHaveLength(1);
    const none = server({});
    expect(await (await make(none)).getAnnotations(SLUG, ED, OBJ)).toEqual([]);
    const unknown = server({});
    expect(await (await make(unknown)).getAnnotations("no-such-slug", ED, OBJ)).toEqual([]);
    expect(unknown.seen).toHaveLength(0);
  });

  it("다른 오류(500)는 PesApiError 로 던진다(빈 목록으로 숨기지 않는다)", async () => {
    const s = server({ "GET /threads": { status: 500, body: fail("internal_error") } });
    await expect((await make(s)).getAnnotations(SLUG, ED, OBJ)).rejects.toBeInstanceOf(PesApiError);
  });
});

// ───────────── 쓰기 ─────────────
const done = (route: string, data: unknown, key: string, action: string, status = 201, extra: Record<string, unknown> = {}) => ({
  [`POST ${route}`]: { status, body: ok(data, extra) },
  [`GET /requests/${key}`]: { status: 200, body: requestsRead(key, action) },
});
// 실제 서버 run_thread_resolve 의 요청 모양 규칙(annotations.ts:838-853 · parse_followup_spec)을 흉내 낸 가짜 응답
const strictResolve = (s: Seen): { status: number; body: unknown } => {
  const b = s.json ?? {};
  const bad = (reason: string) => ({ status: 400, body: fail("invalid_payload", { reason }, "$.body") });
  const okBody = (followup: unknown) => ({ status: 201, body: ok({ thread: { id: "th-1", state: "resolved" }, followup, applied: false }) });
  if (Object.keys(b).some((k) => !["format_version", "thread_id", "resolution", "reason", "followup"].includes(k))) return bad("unknown_field");
  const resolution = b.resolution;
  if (typeof resolution !== "string" || !["edit_text", "next_round_task", "reopen_stage", "none"].includes(resolution)) return bad("resolution");
  if (typeof b.reason !== "string" || !b.reason.trim()) return bad("reason");
  const f = b.followup;
  if (resolution === "none") return f !== undefined && f !== null ? bad("followup_not_allowed") : okBody(null);
  if (typeof f !== "object" || f === null || Array.isArray(f)) return bad("followup_required");
  const fu = f as Record<string, unknown>;
  if (Object.keys(fu).some((k) => !["kind", "description", "proposed_body_md", "target_version_id", "target_stage_id", "target_round_id"].includes(k))) return bad("unknown_field");
  if (fu.kind !== resolution) return bad("followup_kind");
  if (resolution === "edit_text") return fu.target_stage_id !== undefined || fu.target_round_id !== undefined ? bad("stage_not_allowed") : okBody({ id: "fu-7", state: "proposed" });
  if (fu.target_version_id !== undefined || fu.proposed_body_md !== undefined) return bad("edit_text_only");
  if (typeof fu.target_stage_id !== "string" || !fu.target_stage_id) return bad("target_stage_required");
  return okBody({ id: "fu-7", state: "proposed" });
};
const commonWrite = (w: Seen, key: string) => {
  expect(w.headers.get("x-pes-session")).toBe(SESSION);
  expect(w.headers.get("idempotency-key")).toBe(key);
  expect(w.headers.get("content-type")).toContain("application/json");
  expect(w.headers.get("authorization")).toBeNull();
  expect(w.credentials).toBe("omit");
  expect(w.json!.format_version).toBe("1.0");
};
const receiptOk = (r: { receipt: { receipt_no: string; tx_id: string; idempotency_key: string; committed_at: string; replayed: boolean } }, key: string) => {
  expect(r.receipt).toMatchObject({ tx_id: "tx-77", idempotency_key: key, replayed: false });
  expect(r.receipt.receipt_no.length).toBeGreaterThan(0);
  expect(Number.isNaN(Date.parse(r.receipt.committed_at))).toBe(false);
};

describe("쓰기 — createAnnotation (POST P/threads)", () => {
  const input = {
    target_object_id: OBJ,
    target_version_id: "ver-1",
    anchor: { exact_quote: "같은 말이다.", prefix: "중간 설명이다. ", suffix: "", start_cp: 120, end_cp: 127 },
    body_md: "이 문장은 반복입니다.",
  };
  it("본문 · 헤더 · 결과 · 영수증", async () => {
    const s = server(done("/threads", { thread: { id: "th-9", state: "open", anchor_id: "anc-9", anchor_status: "exact" }, message: { id: "m-9", version_no: "1" } }, "key-c", "annotation.create"));
    const out = await (await make(s)).createAnnotation(SLUG, ED, input, "key-c");
    expect(s.writes()).toHaveLength(1);
    const w = s.writes()[0]!;
    expect(w.url.pathname).toBe(`${P}/threads`);
    commonWrite(w, "key-c");
    expect(w.json).toEqual({
      format_version: "1.0",
      target_object_id: OBJ,
      target_version_id: "ver-1",
      context_kind: "annotation",
      anchor: { exact_quote: "같은 말이다.", prefix: "중간 설명이다. ", suffix: "", start_cp: 120, end_cp: 127 },
      initial_message: { body_md: "이 문장은 반복입니다." },
    });
    expect(out.format_version).toBe(FORMAT_VERSION);
    expect(out.data).toEqual({ thread_id: "th-9", message_id: "m-9", anchor_id: "anc-9", anchor_status: "exact" });
    receiptOk(out, "key-c");
  });

  it("422 quote_not_found / ambiguous_quote 는 서버 봉투 그대로(.details.reason 보존)", async () => {
    const s = server({ "POST /threads": { status: 422, body: fail("validation_failed", { reason: "quote_not_found", target_version_id: "ver-1" }, "$.body.anchor.exact_quote", "choose_exact_quote") } });
    const err = await (await make(s)).createAnnotation(SLUG, ED, input, "key-q").catch((e) => e);
    expect(err).toBeInstanceOf(PesApiError);
    expect(err.body.error.code).toBe("validation_failed");
    expect(err.body.error.target).toBe("$.body.anchor.exact_quote");
    expect(err.body.error.details).toEqual({ reason: "quote_not_found", target_version_id: "ver-1" });
    expect(s.seen.some((r) => r.url.pathname.includes("/requests/"))).toBe(false);
  });
});

describe("쓰기 — 답글 · 해결 · 다시 붙이기 · 후속 제안/채택", () => {
  it("replyAnnotation: POST P/threads/{t}/messages {body_md}", async () => {
    const s = server(done("/threads/th-1/messages", { thread_id: "th-1", message: { id: "m-3", version_no: "1", author_actor_id: "act-h1" } }, "key-m", "thread.reply"));
    const out = await (await make(s)).replyAnnotation(SLUG, ED, "th-1", { body_md: "확인했습니다." }, "key-m");
    const w = s.writes()[0]!;
    expect(w.url.pathname).toBe(`${P}/threads/th-1/messages`);
    commonWrite(w, "key-m");
    expect(w.json).toEqual({ format_version: "1.0", body_md: "확인했습니다." });
    expect(out.data).toEqual({ thread_id: "th-1", message_id: "m-3" });
    receiptOk(out, "key-m");
  });

  it("replyAnnotation: 409 thread_closed 는 details(thread_id · state) 를 보존한다", async () => {
    const s = server({ "POST /threads/th-1/messages": { status: 409, body: fail("thread_closed", { thread_id: "th-1", state: "resolved" }, "$.path.thread_id", "open_new_thread") } });
    const err = await (await make(s)).replyAnnotation(SLUG, ED, "th-1", { body_md: "x" }, "key-m2").catch((e) => e);
    expect(err.body.error).toMatchObject({ code: "thread_closed", details: { thread_id: "th-1", state: "resolved" }, next_action: "open_new_thread" });
  });

  it("resolveAnnotation(none): POST P/threads/{t}/resolutions {resolution, reason} — followup 키 없음 · 결과에 applied:false 가 그대로(해결됨 ≠ 반영됨)", async () => {
    const s = server({ ...done("/threads/th-1/resolutions", { thread: { id: "th-1", state: "resolved" }, followup: null, applied: false, note: "해결됨과 반영됨은 다릅니다." }, "key-r", "thread.resolve"), "POST /threads/th-1/resolutions": strictResolve });
    const out = await (await make(s)).resolveAnnotation(SLUG, ED, "th-1", { resolution: "none", reason: "닫는다" }, "key-r");
    const w = s.writes()[0]!;
    expect(w.url.pathname).toBe(`${P}/threads/th-1/resolutions`);
    commonWrite(w, "key-r");
    expect(w.json).toEqual({ format_version: "1.0", resolution: "none", reason: "닫는다" });
    expect(out.data).toEqual({ thread_id: "th-1", state: "resolved", followup_id: null, applied: false });
    receiptOk(out, "key-r");
  });

  // 실제 서버(scripts/pes_core/commands/annotations.ts run_thread_resolve · OpenAPI ThreadResolutionBody)와 같은 규칙으로 거절하는 가짜 서버(strictResolve):
  // none 이 아니면 followup 객체 필수(followup_required) · kind 는 resolution 과 같아야 · next_round_task/reopen_stage 는 target_stage_id 필수 · edit_text 는 stage/round 금지 · none 은 followup 금지.
  it("resolveAnnotation(edit_text): body 에 followup:{kind, description:이유, target_version_id}를 싣는다 — 서버 followup_required 규칙을 통과한다", async () => {
    const s = server({ ...done("/threads/th-1/resolutions", { thread: { id: "th-1", state: "resolved" }, followup: { id: "fu-7", state: "proposed" }, applied: false }, "key-e", "thread.resolve"), "POST /threads/th-1/resolutions": strictResolve });
    const out = await (await make(s)).resolveAnnotation(SLUG, ED, "th-1", { resolution: "edit_text", reason: "근거를 더한다", base_version_id: "ver-3" }, "key-e");
    expect(s.writes()[0]!.json).toEqual({ format_version: "1.0", resolution: "edit_text", reason: "근거를 더한다", followup: { kind: "edit_text", description: "근거를 더한다", target_version_id: "ver-3" } });
    expect(out.data).toEqual({ thread_id: "th-1", state: "resolved", followup_id: "fu-7", applied: false });
  });

  it("resolveAnnotation(edit_text): base_version_id 가 없으면 target_version_id 키를 뺀다(서버가 현재 버전을 쓴다)", async () => {
    const s = server({ ...done("/threads/th-1/resolutions", { thread: { id: "th-1", state: "resolved" }, followup: { id: "fu-7", state: "proposed" }, applied: false }, "key-e2", "thread.resolve"), "POST /threads/th-1/resolutions": strictResolve });
    await (await make(s)).resolveAnnotation(SLUG, ED, "th-1", { resolution: "edit_text", reason: "고친다" }, "key-e2");
    expect(s.writes()[0]!.json).toEqual({ format_version: "1.0", resolution: "edit_text", reason: "고친다", followup: { kind: "edit_text", description: "고친다" } });
  });

  it.each([
    ["next_round_task", "research", "st-research"],
    ["reopen_stage", "plan", "st-plan"],
  ] as const)("resolveAnnotation(%s): GET P/context 로 단계 키 %s → 서버 단계 id 를 알아 followup.target_stage_id 로 싣는다", async (kind, stage, stageId) => {
    const s = server({
      ...done("/threads/th-1/resolutions", { thread: { id: "th-1", state: "resolved" }, followup: { id: "fu-7", state: "proposed" }, applied: false }, "key-s", "thread.resolve"),
      "POST /threads/th-1/resolutions": strictResolve,
      "GET /context": { status: 200, body: ok({ stages: [{ key: "plan", stage_id: "st-plan" }, { key: "research", stage_id: "st-research" }] }) },
    });
    const out = await (await make(s)).resolveAnnotation(SLUG, ED, "th-1", { resolution: kind, reason: "이유", target_stage: stage }, "key-s");
    commonWrite(s.writes()[0]!, "key-s");
    expect(s.writes()[0]!.json).toEqual({ format_version: "1.0", resolution: kind, reason: "이유", followup: { kind, description: "이유", target_stage_id: stageId } });
    expect(out.data).toEqual({ thread_id: "th-1", state: "resolved", followup_id: "fu-7", applied: false });
    receiptOk(out, "key-s");
  });

  it("resolveAnnotation(next_round_task · reopen_stage): 단계(target_stage)를 모르면 지어내지 않고 요청 0 으로 거절한다", async () => {
    for (const kind of ["next_round_task", "reopen_stage"] as const) {
      const s = server({ "POST /threads/th-1/resolutions": strictResolve });
      const err = await (await make(s)).resolveAnnotation(SLUG, ED, "th-1", { resolution: kind, reason: "이유" }, "key-n").catch((e) => e);
      expect(err).toBeInstanceOf(PesApiError);
      expect(err.body.error).toMatchObject({ code: "invalid_payload", target: "$.target_stage" });
      expect(s.seen).toHaveLength(0);
    }
  });

  it("가짜 서버 점검: followup 없는 옛 모양({resolution, reason}만)은 followup_required 로 거절된다 — 실제 서버와 같은 규칙", async () => {
    const s = server({ "POST /threads/th-1/resolutions": strictResolve });
    const res = await s.impl(`http://app.invalid${P}/threads/th-1/resolutions`, { method: "POST", body: JSON.stringify({ format_version: "1.0", resolution: "edit_text", reason: "x" }) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { details: unknown } }).error.details).toEqual({ reason: "followup_required" });
  });

  it("resolveAnnotation: 409 already_resolved 는 details 보존", async () => {
    const dup = server({ "POST /threads/th-1/resolutions": { status: 409, body: fail("already_resolved", { thread_id: "th-1", state: "resolved", resolution_id: "r-1" }, "$.path.thread_id", "reread_thread") } });
    const err = await (await make(dup)).resolveAnnotation(SLUG, ED, "th-1", { resolution: "none", reason: "x" }, "key-r3").catch((e) => e);
    expect(err.body.error.code).toBe("already_resolved");
    expect(err.body.error.details).toMatchObject({ resolution_id: "r-1" });
  });

  it("reanchorAnnotation: POST P/threads/{t}/reanchor {version_id, start_cp, end_cp} — version_id 없으면 키를 뺀다", async () => {
    const s = server(done("/threads/th-2/reanchor", { thread_id: "th-2", anchor: { id: "anc-2", status: "moved", start_cp: 40, end_cp: 53, candidates: [], evaluated_version_id: "ver-3", resolution_id: "ar-5", confirmed_by_actor_id: "act-h1" } }, "key-a", "annotation.reanchor"));
    const c = await make(s);
    const out = await c.reanchorAnnotation(SLUG, ED, "th-2", { version_id: "ver-3", start_cp: 40, end_cp: 53 }, "key-a");
    const w = s.writes()[0]!;
    expect(w.url.pathname).toBe(`${P}/threads/th-2/reanchor`);
    commonWrite(w, "key-a");
    expect(w.json).toEqual({ format_version: "1.0", version_id: "ver-3", start_cp: 40, end_cp: 53 });
    expect(out.data).toEqual({ thread_id: "th-2", anchor_status: "moved" });
    receiptOk(out, "key-a");
    const s2 = server(done("/threads/th-2/reanchor", { thread_id: "th-2", anchor: { id: "anc-2", status: "exact", start_cp: 1, end_cp: 2, candidates: [] } }, "key-a2", "annotation.reanchor"));
    await (await make(s2)).reanchorAnnotation(SLUG, ED, "th-2", { start_cp: 1, end_cp: 2 }, "key-a2");
    expect(s2.writes()[0]!.json).toEqual({ format_version: "1.0", start_cp: 1, end_cp: 2 });
  });

  it("proposeFollowup: POST P/followups {origin_thread_id, kind, description}", async () => {
    const s = server(done("/followups", { followup: { id: "fu-8", kind: "next_round_task", state: "proposed", version_no: "1", base_version_id: null } }, "key-p", "followup.propose"));
    const out = await (await make(s)).proposeFollowup(SLUG, ED, { origin_thread_id: "th-1", kind: "next_round_task", description: "근거 자료 더 찾기" }, "key-p");
    const w = s.writes()[0]!;
    expect(w.url.pathname).toBe(`${P}/followups`);
    commonWrite(w, "key-p");
    expect(w.json).toEqual({ format_version: "1.0", origin_thread_id: "th-1", kind: "next_round_task", description: "근거 자료 더 찾기" });
    expect(out.data).toEqual({ followup_id: "fu-8", state: "proposed" });
    receiptOk(out, "key-p");
  });

  it("applyFollowup: POST P/followups/{f}/apply {base_version_id, expected_rev(문자열 그대로)} → 결과 버전 · 적용 tx", async () => {
    const s = server(done("/followups/fu-1/apply", { followup: { id: "fu-1", state: "applied", applied_tx_id: "tx-77", result_version_id: "ver-4" }, thread: { id: "th-1", state: "open" } }, "key-f", "followup.apply", 200));
    const out = await (await make(s)).applyFollowup(SLUG, ED, "fu-1", { base_version_id: "ver-3", expected_rev: "2" }, "key-f");
    const w = s.writes()[0]!;
    expect(w.url.pathname).toBe(`${P}/followups/fu-1/apply`);
    commonWrite(w, "key-f");
    expect(w.json).toEqual({ format_version: "1.0", base_version_id: "ver-3", expected_rev: "2" });
    expect(out.data).toEqual({ followup_id: "fu-1", state: "applied", result_version_id: "ver-4", applied_tx_id: "tx-77" });
    receiptOk(out, "key-f");
  });

  it("applyFollowup: 409 basis_changed 는 PesApiError 로 — code · target · details(expected · current · current_rev) · next_action 보존, 영수증 읽기 없음", async () => {
    const s = server({ "POST /followups/fu-1/apply": { status: 409, body: fail("basis_changed", { expected: "ver-3", current: "ver-4", current_rev: "2" }, "$.body.base_version_id", "reread_followup") } });
    const err = await (await make(s)).applyFollowup(SLUG, ED, "fu-1", { base_version_id: "ver-3", expected_rev: "2" }, "key-f2").catch((e) => e);
    expect(err).toBeInstanceOf(PesApiError);
    expect(err.body.error).toMatchObject({ code: "basis_changed", target: "$.body.base_version_id", next_action: "reread_followup", details: { expected: "ver-3", current: "ver-4", current_rev: "2" } });
    expect(s.seen.some((r) => r.url.pathname.includes("/requests/"))).toBe(false);
  });

  it("403 human_required(사람만 하는 일을 토큰으로) 도 서버 봉투 그대로", async () => {
    const s = server({ "POST /threads/th-1/reanchor": { status: 403, body: fail("human_required") } });
    const err = await (await make(s)).reanchorAnnotation(SLUG, ED, "th-1", { start_cp: 1, end_cp: 2 }, "key-h").catch((e) => e);
    expect(err.body.error.code).toBe("human_required");
  });

  it("같은 키로 서버가 재생하면(replayed:true) 영수증 replayed:true", async () => {
    const s = server(done("/threads/th-1/messages", { thread_id: "th-1", message: { id: "m-3" } }, "key-rp", "thread.reply", 201, { replayed: true }));
    const out = await (await make(s)).replyAnnotation(SLUG, ED, "th-1", { body_md: "다시" }, "key-rp");
    expect(out.receipt.replayed).toBe(true);
  });
});

describe("쓰기 공통 — 멱등 키 · 모르는 slug", () => {
  const calls: Array<[string, (c: U4Client, key: string | undefined, slug?: string) => Promise<unknown>]> = [
    ["createAnnotation", (c, k, s = SLUG) => c.createAnnotation(s, ED, { target_object_id: OBJ, target_version_id: "v", anchor: { exact_quote: "a", prefix: "", suffix: "", start_cp: 0, end_cp: 1 }, body_md: "x" }, k)],
    ["replyAnnotation", (c, k, s = SLUG) => c.replyAnnotation(s, ED, "th-1", { body_md: "x" }, k)],
    ["resolveAnnotation", (c, k, s = SLUG) => c.resolveAnnotation(s, ED, "th-1", { resolution: "none", reason: "x" }, k)],
    ["reanchorAnnotation", (c, k, s = SLUG) => c.reanchorAnnotation(s, ED, "th-1", { start_cp: 0, end_cp: 1 }, k)],
    ["proposeFollowup", (c, k, s = SLUG) => c.proposeFollowup(s, ED, { origin_thread_id: "th-1", kind: "none", description: "x" }, k)],
    ["applyFollowup", (c, k, s = SLUG) => c.applyFollowup(s, ED, "fu-1", { base_version_id: "v", expected_rev: "1" }, k)],
  ];
  for (const [name, call] of calls) {
    it(`${name}: 멱등 키가 없으면 요청 없이 invalid_payload`, async () => {
      const s = server({});
      const err = (await call(await make(s), undefined).catch((e) => e)) as any;
      expect(err).toBeInstanceOf(PesApiError);
      expect(err.body.error.code).toBe("invalid_payload");
      expect(err.body.error.target).toBe("$.headers.idempotency-key");
      expect(s.seen).toHaveLength(0);
    });
    it(`${name}: 모르는 slug 는 요청 없이 not_found`, async () => {
      const s = server({});
      const err = (await call(await make(s), "key-x", "no-such-slug").catch((e) => e)) as any;
      expect(err).toBeInstanceOf(PesApiError);
      expect(err.body.error.code).toBe("not_found");
      expect(s.seen).toHaveLength(0);
    });
  }

  it("가짜 클라이언트(createFakeClient)도 같은 메서드 이름을 가진다 — 화면이 어느 클라이언트로 열려도 같은 모양", () => {
    const fake = createFakeClient() as unknown as Record<string, unknown>;
    for (const m of ["getAnnotations", "createAnnotation", "replyAnnotation", "resolveAnnotation", "reanchorAnnotation", "proposeFollowup", "applyFollowup"]) expect(typeof fake[m], m).toBe("function");
  });
});
