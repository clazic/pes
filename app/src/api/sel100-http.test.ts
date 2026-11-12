// SEL-100 U3c — HTTP 클라이언트가 가정·결정·반영 읽기 3개와 쓰기 4개를 SEL-93 라우트로 실제 연결하는 매핑 (Vitest, fetch 는 가짜). 구현 전이라 실패가 정상.
// SEL-94 때는 이 7개가 `not_supported` PesApiError 였다(요청 0). 이 파일은 그것을 서버 라우트로 바꾼 뒤의 계약이다.
// 서버 계약: tests/test_sel100_reads.test.ts 머리말의 "필드 대응표"(서버 읽기에 새 키) · tests/test_sel93_api.test.ts(쓰기 본문·오류) · docs/api/openapi-v1.yaml.
//
// ═══ 매핑 표 (P = /api/v1/projects/{id}; 모든 요청: 헤더 x-pes-session · credentials "omit"; 쓰기는 + idempotency-key · JSON 본문 format_version "1.0") ═══
//  PesClient                                      요청                                                     본문 / 결과
//  getAssumptions(slug, ed)                       GET  P/assumptions?edition=<ed>                          data.assumptions[] → AssumptionRow[]  (본문·키 없음)
//  getDecisions(slug, ed)                         GET  P/decisions?edition=<ed>                            data.decisions[] → DecisionRow[]
//  getReflections(slug, ed, stage, "<n>")         GET  P/reflections?edition=<ed>&stage=<stage>&round_no=<n>   data → ReflectionView | (404 → null)
//  getReflections(slug, ed, stage, "start")       요청 없음 → null   (단계 시작에는 라운드가 없어 반영도 없다)
//  assessAssumption(…, id, {verdict, base_version_id, rationale, statement?}, key)
//                                                 POST P/assumptions                                       {assumption_id: id, base_version_id, state: confirm→"confirmed" · reject→"rejected" · revise→"revised",
//                                                                                                           rationale(비어 있지 않을 때만), statement(revise 일 때만 — confirm·reject 는 있어도 보내지 않는다)}
//  adoptDecision(…, id, {base_version_id, rationale}, key)
//                                                 GET P/decisions?edition=<ed>  (사전 읽기: 그 결정의 scope 를 알아낸다; 목록에 없으면 요청(POST) 없이 not_found PesApiError)
//                                                 POST P/decisions                                         {scope: 사전 읽기의 scope, state: "adopted", decision_id: id, base_version_id, rationale(비어 있지 않을 때만)}   statement 키는 보내지 않는다
//  supersedeDecision(…, id, {base_version_id, statement, rationale}, key)
//                                                 (사전 읽기 같음) POST P/decisions                         {scope: 옛 결정의 scope, state: "adopted", supersedes: id, base_version_id, statement, rationale}   decision_id 키 없음
//  revokeDecision(…, id, {base_version_id, rationale}, key)
//                                                 (사전 읽기 같음) POST P/decisions                         {scope, state: "revoked", decision_id: id, base_version_id, rationale}   statement 키 없음
//  쓰기 결과: CommandResult{format_version, request_id, receipt, data:{object_id, version_id}}
//     data.object_id/version_id ← 가정: data.assumption.{id, version_id} · 결정: data.decision.{id, version_id}  (대체는 **새** 결정 id)
//     receipt ← 성공(201) 뒤 GET P/requests/{key} 로 만든다(SEL-92 와 같은 방식): {receipt_no: 비어 있지 않은 글, tx_id, committed_at: ISO, idempotency_key, replayed: 본문 replayed === true}
//  거절: 서버 오류 봉투 그대로 PesApiError(.body.error.code · .details 보존): 409 rev_conflict · 409 conflict(details.reason edition_closed) · 409 supersedes_conflict(details.target_state) · 422 validation_failed(scope_mismatch) · 403 human_required …
//  멱등 키 없음: 요청 없이 invalid_payload PesApiError(target "$.headers.idempotency-key"). 모르는 slug 읽기: [] / null, 쓰기: not_found PesApiError, 요청 0.
//  시간: 쓰기 한 번(사전 읽기 · POST · 영수증 읽기 각각)에 timeoutMs 제한. 넘으면 name "TimeoutError" — 화면이 “접수 확인 중”으로 보이고 **같은 키**로 다시 보내면 서버가 재생한다.
//  읽기 404(없는 판) → 가짜 클라이언트처럼 [] (가정·결정) / null (반영). 다른 오류는 PesApiError.
//  읽기 행 → 앱 행 (필드 대응표, 서버 키는 tests/test_sel100_reads.test.ts):
//     AssumptionRow: object_id←id, version←Number(version_no), proposed_by←proposed_by, assessed_by←assessed_by, original←{version_id: revised_from_version_id, statement: revised_from_statement}|null, copied_from←null, source←null
//     DecisionRow:   proposed_by, decided_by, supersedes←{object_id: supersedes_decision_id, statement: 같은 목록 그 결정의 statement}|null, superseded_by, originated_from←{label(판 번호가 든 글), version: Number(originated_from_version_no)}|null, source←null
//     ReflectionView: submission←submitted?"submitted":"none", sent_count←entries.length;  ReflectionEntry: opinion←source_text ?? "", actor←actor, source←링크(source_version_id), result_version←링크(result_version_id)|null,
//                    followup←{id, kind, state, label←description, result_version←링크|null}|null    링크 = {label: 비어 있지 않은 글, href: "/p/<slug>/e/<ed>/" 로 시작하고 그 버전 id 가 든 앱 안 주소}
import { describe, expect, it, vi } from "vitest";
import { createFakeClient } from "@/api/fake-client";
import { WORKSPACE } from "@/api/fixture";
import { FORMAT_VERSION, PesApiError, type PesClient } from "@/api/types";
import { R_PARTIAL } from "@/test/u3b";

type Opts = { session: string; projects: Record<string, string>; baseUrl?: string; fetch?: typeof fetch; timeoutMs?: number };
const modules = import.meta.glob<{ createHttpClient: (o: Opts) => PesClient }>("/src/api/http-client.{ts,tsx}");
const load = async () => {
  const loader = Object.values(modules)[0];
  if (!loader) throw new Error("src/api/http-client.ts 가 없다");
  return (await loader()).createHttpClient;
};

const SESSION = "synthetic-session-u3c";
const ID = "pj-synthetic-3";
const SLUG = WORKSPACE.slug;
const ED = WORKSPACE.edition;
const P = `/api/v1/projects/${ID}`;

const ok = (data: unknown, extra: Record<string, unknown> = {}) => ({ format_version: FORMAT_VERSION, request_id: "req-1", data, ...extra });
const fail = (code: string, details: unknown = null, target = "$.body") => ({ format_version: FORMAT_VERSION, request_id: "req-e", error: { code, message: "합성 거절 문장", retryable: false, target, details, next_action: "reread_context" } });
const requestsRead = (key: string, tx = "tx-88") => ok({ action: "assumption.assessed", tx_id: tx, status: 201, run_id: null, key });

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
    const key = `${s.method} ${url.pathname.replace(P, "")}`;
    const hit = routes[key];
    const r = typeof hit === "function" ? hit(s) : (hit ?? { status: 404, body: fail("not_found") });
    if (r === "hang") return new Promise<Response>(() => {});
    return new Response(JSON.stringify(r.body), { status: r.status });
  });
  const writes = () => seen.filter((s) => s.method === "POST");
  return { impl: impl as unknown as typeof fetch, seen, writes };
}
const make = async (s: ReturnType<typeof server>, extra: Partial<Opts> = {}) => (await load())({ session: SESSION, projects: { [SLUG]: ID }, fetch: s.impl, ...extra });

// ───────────── 서버 쪽 합성 행 ─────────────
const human = { id: "act-h1", kind: "human", name: "검토자 하늘" };
const agent = { id: "act-a1", kind: "ai", name: "합성 조사 에이전트" };

const sAssumption = (o: Record<string, unknown> = {}) => ({
  id: "as-1", version_id: "av-3", version_no: "3", statement: "정책 대상은 광역시 거주자로 한정한다.", state: "proposed", needs_review: true,
  proposed_by_actor_id: agent.id, proposed_by: agent, assessed_by_actor_id: null, assessed_by: null, assessed_at: null, rationale: "",
  revised_from_version_id: null, revised_from_statement: null, ...o,
});
const sDecision = (o: Record<string, unknown> = {}) => ({
  id: "dec-2", version_id: "dv-5", version_no: "5", statement: "2판은 대안 B 로 간다.", state: "adopted", scope: "edition", decided_by_actor_id: human.id, decided_by: human, rationale: "근거 문장",
  supersedes_decision_id: null, proposed_by: agent, superseded_by: null, originated_from_version_id: null, originated_from_version_no: null, originated_from_edition_no: null, ...o,
});
const sEntry = (o: Record<string, unknown> = {}) => ({
  id: "rf-1", source_version_id: "mv-12", disposition: "applied", rationale: "합계 줄을 더했다", result_version_id: "rv-9", followup_id: null, applied_tx_id: "tx-0901", actor_id: agent.id, actor: agent,
  source_text: "표에 연도별 합계를 넣어 주세요", followup: null, ...o,
});
const sReflection = (entries: unknown[], o: Record<string, unknown> = {}) => ({ round_id: "rd-2", stage: "research", round_no: 2, submitted: true, counts: { applied: 1, partial: 0, rejected: 0, deferred: 0 }, entries, ...o });

const ASSUMPTIONS_OK = { status: 200, body: ok({ edition: ED, assumptions: [sAssumption(), sAssumption({ id: "as-2", version_id: "av-7", version_no: "7", state: "revised", needs_review: false, statement: "고친 문장", assessed_by: human, assessed_by_actor_id: human.id, assessed_at: "2026-11-12T01:02:03Z", rationale: "범위 축소", revised_from_version_id: "av-6", revised_from_statement: "옛 문장" })] }) };
const DECISIONS_OK = {
  status: 200,
  body: ok({
    edition: ED,
    decisions: [
      sDecision({ id: "dec-1", version_id: "dv-4", version_no: "4", state: "superseded", statement: "옛 결정", superseded_by: "dec-2" }),
      sDecision({ supersedes_decision_id: "dec-1", originated_from_version_id: "dv-1", originated_from_version_no: "2", originated_from_edition_no: 1 }),
      sDecision({ id: "dec-4", version_id: "dv-8", version_no: "8", state: "proposed", scope: "project", decided_by: null, decided_by_actor_id: null }),
    ],
  }),
};

describe("읽기 — 가정·결정 (GET P/assumptions · P/decisions ?edition=)", () => {
  it("getAssumptions: GET P/assumptions?edition=<판> (세션 헤더 · 본문 없음 · 쓰기 헤더 없음)", async () => {
    const s = server({ "GET /assumptions": ASSUMPTIONS_OK });
    const rows = await (await make(s)).getAssumptions(SLUG, ED);
    expect(rows).toHaveLength(2);
    expect(s.seen).toHaveLength(1);
    const r = s.seen[0]!;
    expect(r.method).toBe("GET");
    expect(r.url.pathname).toBe(`${P}/assumptions`);
    expect(r.url.searchParams.get("edition")).toBe(String(ED));
    expect(r.headers.get("x-pes-session")).toBe(SESSION);
    expect(r.headers.get("idempotency-key")).toBeNull();
    expect(r.json).toBeNull();
    expect(r.credentials).toBe("omit");
  });

  it("가정 행 매핑: 기계 값을 그대로 · 버전은 숫자 · 행위자는 {id,kind,name} · 고침은 원문 보존 · 서버에 없는 칸(copied_from · source)은 null", async () => {
    const s = server({ "GET /assumptions": ASSUMPTIONS_OK });
    const [a, b] = await (await make(s)).getAssumptions(SLUG, ED);
    expect(a).toEqual({
      object_id: "as-1", version_id: "av-3", version: 3, statement: "정책 대상은 광역시 거주자로 한정한다.", state: "proposed", proposed_by: agent, assessed_by: null, assessed_at: null,
      needs_review: true, rationale: "", original: null, copied_from: null, source: null,
    });
    expect(b).toMatchObject({ object_id: "as-2", version_id: "av-7", version: 7, state: "revised", needs_review: false, statement: "고친 문장", assessed_by: human, assessed_at: "2026-11-12T01:02:03Z", rationale: "범위 축소", original: { version_id: "av-6", statement: "옛 문장" } });
  });

  it("getDecisions: GET P/decisions?edition=<판> 이고 행이 앱 모양으로 바뀐다 (대체 · 대체됨 · 당시 버전 · 제안자 · 결정자)", async () => {
    const s = server({ "GET /decisions": DECISIONS_OK });
    const rows = await (await make(s)).getDecisions(SLUG, ED);
    expect(s.seen[0]!.url.pathname).toBe(`${P}/decisions`);
    expect(s.seen[0]!.url.searchParams.get("edition")).toBe(String(ED));
    expect(rows.map((r) => r.object_id)).toEqual(["dec-1", "dec-2", "dec-4"]);
    const [old, cur, proposed] = rows;
    expect(old).toMatchObject({ object_id: "dec-1", state: "superseded", version: 4, superseded_by: "dec-2", supersedes: null, originated_from: null, proposed_by: agent, decided_by: human, source: null });
    expect(cur).toMatchObject({ object_id: "dec-2", state: "adopted", version: 5, scope: "edition", rationale: "근거 문장", superseded_by: null, proposed_by: agent, decided_by: human });
    expect(cur!.supersedes).toEqual({ object_id: "dec-1", statement: "옛 결정" });
    expect(cur!.originated_from?.version).toBe(2);
    expect(cur!.originated_from?.label).toMatch(/1/);
    expect(proposed).toMatchObject({ object_id: "dec-4", state: "proposed", scope: "project", decided_by: null });
  });

  it("읽기 404(없는 판) 는 가짜 클라이언트처럼 [] · 모르는 slug 는 요청 없이 [] · 그 밖의 오류는 PesApiError", async () => {
    const s = server({});
    const c = await make(s);
    expect(await c.getAssumptions(SLUG, 9)).toEqual([]);
    expect(await c.getDecisions(SLUG, 9)).toEqual([]);
    const before = s.seen.length;
    expect(await c.getAssumptions("no-such-slug", ED)).toEqual([]);
    expect(await c.getDecisions("no-such-slug", ED)).toEqual([]);
    expect(s.seen.length).toBe(before);
    const broken = server({ "GET /assumptions": { status: 500, body: fail("internal_error") }, "GET /decisions": { status: 403, body: fail("forbidden") } });
    const c2 = await make(broken);
    await expect(c2.getAssumptions(SLUG, ED)).rejects.toBeInstanceOf(PesApiError);
    await expect(c2.getDecisions(SLUG, ED)).rejects.toMatchObject({ body: { error: { code: "forbidden" } } });
  });
});

describe("읽기 — 반영 (GET P/reflections?edition=&stage=&round_no=)", () => {
  const FULL = sReflection([
    sEntry(),
    sEntry({ id: "rf-2", disposition: "partial", result_version_id: null, followup_id: "fu-2", source_version_id: "mv-13", source_text: "노년층 자료를 더 찾아 주세요", followup: { id: "fu-2", kind: "next_round_task", state: "applied", description: "R3 에서 노년층 자료 더 찾기", result_version_id: "rv-10" } }),
    sEntry({ id: "rf-3", disposition: "rejected", result_version_id: null, applied_tx_id: null, rationale: "연구 범위 밖", source_text: null }),
  ]);

  it("라운드 번호 → 서버 쿼리: 판 · 단계 키 · round_no (round_id 를 앱이 지어내지 않는다)", async () => {
    const s = server({ "GET /reflections": { status: 200, body: ok(FULL) } });
    const view = await (await make(s)).getReflections(SLUG, ED, "research", "2");
    const r = s.seen[0]!;
    expect(r.method).toBe("GET");
    expect(r.url.pathname).toBe(`${P}/reflections`);
    expect(r.url.searchParams.get("edition")).toBe(String(ED));
    expect(r.url.searchParams.get("stage")).toBe("research");
    expect(r.url.searchParams.get("round_no")).toBe("2");
    expect(r.url.searchParams.has("round_id")).toBe(false);
    expect(view?.submission).toBe("submitted");
    expect(view?.sent_count).toBe(3);
    expect(view?.entries).toHaveLength(3);
  });

  it("줄 매핑: 의견 글 · 처리 · 행위자 · 처리 기록 · 결과/원문 링크 · 후속 보기", async () => {
    const s = server({ "GET /reflections": { status: 200, body: ok(FULL) } });
    const view = await (await make(s)).getReflections(SLUG, ED, "research", "2");
    const [applied, partial, rejected] = view!.entries;
    expect(applied).toMatchObject({ id: "rf-1", opinion: "표에 연도별 합계를 넣어 주세요", disposition: "applied", rationale: "합계 줄을 더했다", actor: agent, applied_tx_id: "tx-0901", followup: null });
    const link = (l: { label: string; href: string } | null, id: string) => {
      expect(l).not.toBeNull();
      expect(l!.label.length).toBeGreaterThan(0);
      expect(l!.href.startsWith(`/p/${SLUG}/e/${ED}/`)).toBe(true);
      expect(l!.href).toContain(id);
    };
    link(applied!.result_version, "rv-9");
    link(applied!.source, "mv-12");
    expect(partial).toMatchObject({ id: "rf-2", disposition: "partial", result_version: null, followup: { id: "fu-2", kind: "next_round_task", state: "applied", label: "R3 에서 노년층 자료 더 찾기" } });
    link(partial!.followup!.result_version, "rv-10");
    expect(rejected).toMatchObject({ id: "rf-3", disposition: "rejected", opinion: "", applied_tx_id: null, result_version: null, followup: null });
  });

  it("미제출(submitted:false) 은 submission:'none' · 0건 제출은 submitted + 빈 목록 — 서로 다르다", async () => {
    const none = server({ "GET /reflections": { status: 200, body: ok(sReflection([], { submitted: false })) } });
    expect(await (await make(none)).getReflections(SLUG, ED, "research", "2")).toMatchObject({ submission: "none", sent_count: 0, entries: [] });
    const zero = server({ "GET /reflections": { status: 200, body: ok(sReflection([], { submitted: true })) } });
    expect(await (await make(zero)).getReflections(SLUG, ED, "research", "2")).toMatchObject({ submission: "submitted", sent_count: 0, entries: [] });
  });

  it("'start' · 숫자가 아닌 라운드 · 모르는 slug 는 요청 없이 null, 서버 404 도 null, 다른 오류는 PesApiError", async () => {
    const s = server({});
    const c = await make(s);
    expect(await c.getReflections(SLUG, ED, "research", "start")).toBeNull();
    expect(await c.getReflections(SLUG, ED, "research", "x2")).toBeNull();
    expect(await c.getReflections("no-such-slug", ED, "research", "2")).toBeNull();
    expect(s.seen).toHaveLength(0);
    expect(await c.getReflections(SLUG, ED, "research", "9")).toBeNull();
    expect(s.seen).toHaveLength(1);
    const broken = server({ "GET /reflections": { status: 500, body: fail("internal_error") } });
    await expect((await make(broken)).getReflections(SLUG, ED, "research", "2")).rejects.toBeInstanceOf(PesApiError);
  });
});

// ───────────── 쓰기 ─────────────
const judged = (route: string, data: unknown, key: string, status = 201, extra: Record<string, unknown> = {}) => ({
  [`POST ${route}`]: { status, body: ok(data, extra) },
  [`GET /requests/${key}`]: { status: 200, body: requestsRead(key) },
});
const ASSUMPTION_DONE = (id = "as-1", version_id = "av-9") => ({ assumption: { id, version_id, state: "confirmed", needs_review: false, assessed_by_actor_id: human.id } });
const DECISION_DONE = (id = "dec-2", version_id = "dv-9", state = "adopted") => ({ decision: { id, version_id, state, scope: "edition" } });
const PRE = { "GET /decisions": DECISIONS_OK };

describe("쓰기 — assessAssumption (POST P/assumptions)", () => {
  const cases: Array<[string, "confirm" | "reject" | "revise", string]> = [
    ["확인", "confirm", "confirmed"],
    ["틀림", "reject", "rejected"],
    ["고침", "revise", "revised"],
  ];
  for (const [word, verdict, state] of cases) {
    it(`verdict ${verdict} → state ${state}: 본문 · 헤더 · 결과 · 영수증 (${word})`, async () => {
      const s = server(judged("/assumptions", ASSUMPTION_DONE(), "key-a"));
      const input = { verdict, base_version_id: "av-3", rationale: "근거를 적었다", ...(verdict === "revise" ? { statement: "고친 가정 문장" } : {}) };
      const out = await (await make(s)).assessAssumption(SLUG, ED, "as-1", input, "key-a");
      const w = s.writes()[0]!;
      expect(s.writes()).toHaveLength(1);
      expect(w.url.pathname).toBe(`${P}/assumptions`);
      expect(w.headers.get("x-pes-session")).toBe(SESSION);
      expect(w.headers.get("idempotency-key")).toBe("key-a");
      expect(w.headers.get("content-type")).toContain("application/json");
      expect(w.headers.get("authorization")).toBeNull();
      expect(w.credentials).toBe("omit");
      expect(w.json).toEqual({ format_version: "1.0", assumption_id: "as-1", base_version_id: "av-3", state, rationale: "근거를 적었다", ...(verdict === "revise" ? { statement: "고친 가정 문장" } : {}) });
      expect(out.format_version).toBe(FORMAT_VERSION);
      expect(out.data).toEqual({ object_id: "as-1", version_id: "av-9" });
      expect(out.receipt).toMatchObject({ tx_id: "tx-88", idempotency_key: "key-a", replayed: false });
      expect(out.receipt.receipt_no.length).toBeGreaterThan(0);
      expect(Number.isNaN(Date.parse(out.receipt.committed_at))).toBe(false);
    });
  }

  it("확인·틀림에는 statement 를 보내지 않고(서버는 revised_only 로 거절한다), 비어 있는 근거는 키를 뺀다", async () => {
    const s = server(judged("/assumptions", ASSUMPTION_DONE(), "key-b"));
    await (await make(s)).assessAssumption(SLUG, ED, "as-1", { verdict: "confirm", base_version_id: "av-3", rationale: "", statement: "남은 글" }, "key-b");
    const body = s.writes()[0]!.json!;
    expect(body).not.toHaveProperty("statement");
    expect(body).not.toHaveProperty("rationale");
    expect(body.state).toBe("confirmed");
  });

  it("본문 replayed:true → 영수증 replayed:true, 같은 키는 그대로 다시 보낸다", async () => {
    const s = server(judged("/assumptions", ASSUMPTION_DONE(), "key-r", 201, { replayed: true }));
    const out = await (await make(s)).assessAssumption(SLUG, ED, "as-1", { verdict: "confirm", base_version_id: "av-3", rationale: "" }, "key-r");
    expect(out.receipt.replayed).toBe(true);
  });
});

describe("쓰기 — 결정 (POST P/decisions, 사전 읽기로 scope 를 알아낸다)", () => {
  it("adoptDecision: 사전 읽기 → POST {scope, state:'adopted', decision_id, base_version_id, rationale} — statement · supersedes 없음", async () => {
    const s = server({ ...PRE, ...judged("/decisions", DECISION_DONE("dec-4", "dv-9"), "key-d") });
    const out = await (await make(s)).adoptDecision(SLUG, ED, "dec-4", { base_version_id: "dv-8", rationale: "채택 이유" }, "key-d");
    expect(s.seen.map((x) => `${x.method} ${x.url.pathname.replace(P, "")}`)).toEqual(["GET /decisions", "POST /decisions", "GET /requests/key-d"]);
    expect(s.seen[0]!.url.searchParams.get("edition")).toBe(String(ED));
    const body = s.writes()[0]!.json!;
    expect(body).toEqual({ format_version: "1.0", scope: "project", state: "adopted", decision_id: "dec-4", base_version_id: "dv-8", rationale: "채택 이유" });
    expect(s.writes()[0]!.headers.get("idempotency-key")).toBe("key-d");
    expect(out.data).toEqual({ object_id: "dec-4", version_id: "dv-9" });
    expect(out.receipt).toMatchObject({ tx_id: "tx-88", idempotency_key: "key-d", replayed: false });
  });

  it("adoptDecision: 근거가 비면 rationale 키를 뺀다 (채택의 근거는 선택)", async () => {
    const s = server({ ...PRE, ...judged("/decisions", DECISION_DONE("dec-4", "dv-9"), "key-d2") });
    await (await make(s)).adoptDecision(SLUG, ED, "dec-4", { base_version_id: "dv-8", rationale: "" }, "key-d2");
    expect(s.writes()[0]!.json).not.toHaveProperty("rationale");
  });

  it("supersedeDecision: POST {scope: 옛 결정의 scope, state:'adopted', supersedes: id, base_version_id, statement, rationale} — decision_id 없음, 결과는 새 결정 id", async () => {
    const s = server({ ...PRE, ...judged("/decisions", DECISION_DONE("dec-9", "dv-20"), "key-s") });
    const out = await (await make(s)).supersedeDecision(SLUG, ED, "dec-2", { base_version_id: "dv-5", statement: "새 결정 문장", rationale: "바꾼다" }, "key-s");
    expect(s.writes()[0]!.json).toEqual({ format_version: "1.0", scope: "edition", state: "adopted", supersedes: "dec-2", base_version_id: "dv-5", statement: "새 결정 문장", rationale: "바꾼다" });
    expect(out.data).toEqual({ object_id: "dec-9", version_id: "dv-20" });
  });

  it("revokeDecision: POST {scope, state:'revoked', decision_id, base_version_id, rationale} — statement · supersedes 값 없음", async () => {
    const s = server({ ...PRE, ...judged("/decisions", DECISION_DONE("dec-2", "dv-21", "revoked"), "key-v") });
    const out = await (await make(s)).revokeDecision(SLUG, ED, "dec-2", { base_version_id: "dv-5", rationale: "전제가 무너짐" }, "key-v");
    const body = s.writes()[0]!.json!;
    expect(body).toMatchObject({ format_version: "1.0", scope: "edition", state: "revoked", decision_id: "dec-2", base_version_id: "dv-5", rationale: "전제가 무너짐" });
    expect(body).not.toHaveProperty("statement");
    expect(body.supersedes ?? null).toBeNull();
    expect(out.data).toEqual({ object_id: "dec-2", version_id: "dv-21" });
  });

  it("사전 읽기 목록에 그 결정이 없으면 POST 없이 not_found PesApiError", async () => {
    const s = server({ ...PRE, ...judged("/decisions", DECISION_DONE(), "key-x") });
    const c = await make(s);
    for (const call of [
      () => c.adoptDecision(SLUG, ED, "dec-none", { base_version_id: "v", rationale: "" }, "key-x"),
      () => c.supersedeDecision(SLUG, ED, "dec-none", { base_version_id: "v", statement: "문장", rationale: "이유" }, "key-x"),
      () => c.revokeDecision(SLUG, ED, "dec-none", { base_version_id: "v", rationale: "이유" }, "key-x"),
    ]) {
      await expect(call()).rejects.toMatchObject({ body: { error: { code: "not_found" } } });
    }
    expect(s.writes()).toHaveLength(0);
  });
});

describe("쓰기 공통 — 멱등 키 · 모르는 slug · 오류 봉투 · 시간 제한", () => {
  const sevenCalls = (c: PesClient, slug: string, key: string | undefined) => [
    () => c.assessAssumption(slug, ED, "as-1", { verdict: "confirm", base_version_id: "av-3", rationale: "" }, key),
    () => c.adoptDecision(slug, ED, "dec-4", { base_version_id: "dv-8", rationale: "" }, key),
    () => c.supersedeDecision(slug, ED, "dec-2", { base_version_id: "dv-5", statement: "문장", rationale: "이유" }, key),
    () => c.revokeDecision(slug, ED, "dec-2", { base_version_id: "dv-5", rationale: "이유" }, key),
  ];

  it("멱등 키가 없으면 어떤 쓰기든 요청 없이 invalid_payload (target $.headers.idempotency-key)", async () => {
    const s = server({ ...PRE });
    for (const call of sevenCalls(await make(s), SLUG, undefined)) {
      await expect(call()).rejects.toMatchObject({ body: { error: { code: "invalid_payload", target: "$.headers.idempotency-key" } } });
    }
    expect(s.seen).toHaveLength(0);
  });

  it("모르는 slug 의 쓰기는 요청 없이 not_found PesApiError", async () => {
    const s = server({});
    for (const call of sevenCalls(await make(s), "no-such-slug", "k")) await expect(call()).rejects.toMatchObject({ body: { error: { code: "not_found" } } });
    expect(s.seen).toHaveLength(0);
  });

  it("서버 오류 봉투가 그대로 PesApiError(.body) 로 나온다 — rev_conflict · edition_closed · supersedes_conflict · scope_mismatch · human_required (details 보존)", async () => {
    const table: Array<[number, string, unknown, string]> = [
      [409, "rev_conflict", null, "$.body.base_version_id"],
      [409, "conflict", { reason: "edition_closed" }, "$.body"],
      [409, "supersedes_conflict", { target_state: "revoked", current_decision_id: null }, "$.body.supersedes"],
      [422, "validation_failed", { reason: "scope_mismatch" }, "$.body.scope"],
      [403, "human_required", null, "$.body"],
    ];
    for (const [status, code, details, target] of table) {
      const s = server({ ...PRE, "POST /assumptions": { status, body: fail(code, details, target) }, "POST /decisions": { status, body: fail(code, details, target) } });
      const c = await make(s);
      const e = await c.assessAssumption(SLUG, ED, "as-1", { verdict: "confirm", base_version_id: "av-3", rationale: "" }, "k1").then(() => null, (x: unknown) => x);
      expect(e).toBeInstanceOf(PesApiError);
      expect((e as PesApiError).body.error.code).toBe(code);
      expect((e as PesApiError).body.error.details).toEqual(details);
      expect((e as PesApiError).body.error.target).toBe(target);
      const e2 = await c.supersedeDecision(SLUG, ED, "dec-2", { base_version_id: "dv-5", statement: "문장", rationale: "이유" }, "k2").then(() => null, (x: unknown) => x);
      expect((e2 as PesApiError).body.error.code).toBe(code);
    }
  });

  it("쓰기가 거절되면 영수증을 읽지 않는다", async () => {
    const s = server({ "POST /assumptions": { status: 409, body: fail("rev_conflict") } });
    await expect((await make(s)).assessAssumption(SLUG, ED, "as-1", { verdict: "confirm", base_version_id: "old", rationale: "" }, "k")).rejects.toBeInstanceOf(PesApiError);
    expect(s.seen.filter((x) => x.url.pathname.includes("/requests/"))).toHaveLength(0);
  });

  it("서버가 늦으면 TimeoutError(접수 확인 중) — 같은 키로 다시 보내면 같은 키가 다시 간다 (assess · supersede 둘 다)", async () => {
    const s = server({ ...PRE, "POST /assumptions": "hang", "POST /decisions": "hang" });
    const c = await make(s, { timeoutMs: 20 });
    for (const call of [
      () => c.assessAssumption(SLUG, ED, "as-1", { verdict: "reject", base_version_id: "av-3", rationale: "이유" }, "key-t"),
      () => c.supersedeDecision(SLUG, ED, "dec-2", { base_version_id: "dv-5", statement: "문장", rationale: "이유" }, "key-t"),
    ]) {
      await expect(call()).rejects.toMatchObject({ name: "TimeoutError" });
      await expect(call()).rejects.toMatchObject({ name: "TimeoutError" });
    }
    const keys = s.writes().map((w) => w.headers.get("idempotency-key"));
    expect(keys).toEqual(["key-t", "key-t", "key-t", "key-t"]);
  });

  it("쓰기는 됐는데 영수증을 못 읽으면(GET requests 실패) 성공으로 보이지 않고 TimeoutError", async () => {
    const s = server({ "POST /assumptions": { status: 201, body: ok(ASSUMPTION_DONE()) }, "GET /requests/key-n": { status: 500, body: fail("internal_error") } });
    await expect((await make(s)).assessAssumption(SLUG, ED, "as-1", { verdict: "confirm", base_version_id: "av-3", rationale: "" }, "key-n")).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("네트워크 실패는 삼키지 않고 그대로 reject", async () => {
    const boom = vi.fn(async () => {
      throw new TypeError("network down");
    }) as unknown as typeof fetch;
    const c = (await load())({ session: SESSION, projects: { [SLUG]: ID }, fetch: boom });
    await expect(c.getAssumptions(SLUG, ED)).rejects.toThrow("network down");
    await expect(c.assessAssumption(SLUG, ED, "as-1", { verdict: "confirm", base_version_id: "v", rationale: "" }, "k")).rejects.toThrow("network down");
  });
});

describe("가짜 클라이언트와 같은 wire 모양 (키 집합이 같다)", () => {
  const keys = (v: unknown) => Object.keys(v as object).sort();

  it("AssumptionRow · DecisionRow · ReflectionView · ReflectionEntry · FollowupView 의 키 집합이 같다", async () => {
    const fake = createFakeClient();
    const fa = await fake.getAssumptions(SLUG, ED);
    const fd = await fake.getDecisions(SLUG, ED);
    const fr = await fake.getReflections(SLUG, ED, "research", "2");
    expect(fa.length).toBeGreaterThan(0);
    expect(fd.length).toBeGreaterThan(0);
    expect(fr).not.toBeNull();
    const s = server({
      "GET /assumptions": ASSUMPTIONS_OK,
      "GET /decisions": DECISIONS_OK,
      "GET /reflections": { status: 200, body: ok(sReflection([sEntry({ followup_id: "fu-2", followup: { id: "fu-2", kind: "edit_text", state: "applied", description: "글 수정", result_version_id: "rv-10" } })])) },
    });
    const http = await make(s);
    const [ha] = await http.getAssumptions(SLUG, ED);
    const [, hd] = await http.getDecisions(SLUG, ED);
    const hr = await http.getReflections(SLUG, ED, "research", "2");
    expect(keys(ha)).toEqual(keys(fa[0]));
    expect(keys(hd)).toEqual(keys(fd[0]));
    expect(keys(hr)).toEqual(keys(fr));
    expect(keys(hr!.entries[0])).toEqual(keys(fr!.entries[0]));
    // 앱 기본 가짜 자료에는 후속이 없어 화면 시험 자료(u3b.ts)의 후속 보기와 견준다
    expect(R_PARTIAL.followup).not.toBeNull();
    expect(keys(hr!.entries[0]!.followup)).toEqual(keys(R_PARTIAL.followup));
    expect(keys(ha!.proposed_by)).toEqual(keys(fa[0]!.proposed_by));
  });

  it("쓰기 결과(CommandResult · receipt · data)의 키 집합이 같다", async () => {
    const fake = createFakeClient();
    const proposed = (await fake.getAssumptions(SLUG, ED)).find((a) => a.state === "proposed")!;
    const fout = await fake.assessAssumption(SLUG, ED, proposed.object_id, { verdict: "confirm", base_version_id: proposed.version_id, rationale: "" }, "fake-k");
    const s = server(judged("/assumptions", ASSUMPTION_DONE(), "key-w"));
    const hout = await (await make(s)).assessAssumption(SLUG, ED, "as-1", { verdict: "confirm", base_version_id: "av-3", rationale: "" }, "key-w");
    expect(keys(hout)).toEqual(keys(fout));
    expect(keys(hout.receipt)).toEqual(keys(fout.receipt));
    expect(keys(hout.data)).toEqual(keys(fout.data));
  });

  it("not_supported 로 거절하던 7개는 더 이상 not_supported 가 아니다 (요청이 나간다)", async () => {
    const s = server({});
    const c = await make(s);
    const e = await c.getAssumptions(SLUG, ED).then(() => null, (x: unknown) => x);
    expect(e === null || (e as PesApiError).body.error.code !== ("not_supported" as never)).toBe(true);
    expect(s.seen.length).toBeGreaterThan(0);
  });
});
