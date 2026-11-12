// SEL-92 U2c — HTTP 클라이언트가 질문 쓰기·답 제출·의견을 U2a(SEL-90) 라우트로 보내는 매핑 (Vitest, fetch 는 가짜). 구현 전이라 실패가 정상.
// 서버 계약: `git show ai/SEL-90:docs/api/openapi-v1.yaml` · tests/test_sel90_forms_submit.test.ts · test_sel90_comments.test.ts · docs/plan/fixtures/api-v1/*.json.
//
// ═══ 매핑 표 (P = /api/v1/projects/{id}; 모든 쓰기: POST · 헤더 x-pes-session · idempotency-key · content-type: application/json · credentials "omit" · 본문에 format_version "1.0") ═══
//  PesClient                         요청                                          본문(앱 → 서버)
//  addQuestion(…,"research","start",in)  POST P/questions                         {stage_id: GET P/context 의 stages[key==stage].stage_id, round_id: null, purpose: "stage_start", form_key: "main",
//                                                                                   direction: "agent_to_human", question: spec(in)}
//  reviseQuestion(…, qid, body)       POST P/questions/{qid}/revisions            {base_version_id: body.base_version_id, question: spec(body)}      (base_version_id 가 없으면 요청 없이 invalid_payload)
//  withdrawQuestion(…, qid)           POST P/questions/{qid}/withdraw             {}                                                                (base_version_id 는 선택이라 앱이 모르면 보내지 않는다)
//  deferQuestion(…, qid)              POST P/questions/{qid}/defer                {}
//  mergeQuestion(…, qid, into)        POST P/questions/{qid}/merge                {merged_into_question_id: into}
//  submitAnswers(…, input)            POST P/submissions                          {set_id: input.set_id, mode, answers:[{question_id, question_version_id?, value?, comment?, used_default?}]}
//                                                                                   (value 가 null 이면 키를 빼고 comment 만 — U2a 의 의견만 있는 항목 · set_id 가 없으면 요청 없이 invalid_payload)
//  addComment(…, qid, {body_md})      POST P/threads                              {target_object_id: qid, target_version_id?: input.question_version_id, context_kind: "question_comment", initial_message: {body_md}}
//  addComment(…, qid, {body_md, thread_id})  POST P/threads/{thread_id}/messages  {body_md}
//  spec(q): {text, type: single_choice→"single" · multi_choice→"multi" · free_text→"text", required, importance(null 이면 키 없음), default_value(null 이면 키 없음),
//            options: [{value: 선택지 id, label}] (선택지 유형만), show_if: {id: 조건 질문 id, in: [equals]} (없으면 키 없음), help}
//  spec 이 못 담는 것: direction "ask_ai" → 서버는 agent_to_human 만 받는다 → 요청 없이 NotConnectedError. 번호 라운드(예 "2") → 서버 round_id 를 앱이 아직 모른다 → 요청 없이 NotConnectedError.
//  이어지지 않은 것(U2a 에 길이 없다): reorderQuestions(순서 바꾸기 라우트 없음) · getQuestionVersions · getComments(목록 라우트 없음) → NotConnectedError, 요청 0.
//  응답 → 앱 모양: 서버 본문 {format_version, request_id, data, replayed?} 에는 영수증이 없다. 클라이언트가 쓰기 성공(201) 뒤 `GET P/requests/{key}`(data {action, tx_id, …})로 영수증을 만든다:
//     receipt = {receipt_no: 비어 있지 않은 글, tx_id: 그 tx_id, committed_at: ISO 시각, idempotency_key: 보낸 키, replayed: 본문 replayed === true}.
//     data 매핑: revise → {question_id: question.id, version: Number(question.version_no), needs_recheck: recheck_required === true} · add → {question_id, version} ·
//               withdraw/defer → {question_id, status} · merge → {…, merged_into: question.merged_into_question_id} ·
//               submit → {submission_id: submission.id, answers:[{question_id, state}], form_complete, missing_required} ·
//               addComment → {thread_id, message_id, thread_created: 새 스레드면 true}.
//  거절: 오류 봉투는 PesApiError(.body = 서버 봉투, details 보존). 400/409/422 모두. 네트워크 실패는 그대로 reject. 멱등 키가 없으면 요청 없이 invalid_payload.
//  capabilities.questionTools 는 false 가 아니다(질문 도구가 켜진다).
import { describe, expect, it, vi } from "vitest";
import { WORKSPACE } from "@/api/fixture";
import { FORMAT_VERSION, NotConnectedError, PesApiError, type PesClient } from "@/api/types";

type Opts = { session: string; projects: Record<string, string>; baseUrl?: string; fetch?: typeof fetch };
const modules = import.meta.glob<{ createHttpClient: (o: Opts) => PesClient }>("/src/api/http-client.{ts,tsx}");
const load = async () => {
  const loader = Object.values(modules)[0];
  if (!loader) throw new Error("src/api/http-client.ts 가 없다");
  return (await loader()).createHttpClient;
};
/** 아직 types.ts 에 없는 U2c 메서드를 좁은 타입으로 부른다(구현 뒤 PesClient 가 갖는다) */
type U2cClient = {
  capabilities?: { questionTools?: boolean };
  addQuestion(slug: string, edition: number, stage: string, round: string, body: Record<string, unknown>, key: string | undefined): Promise<{ data: Record<string, unknown>; receipt: Record<string, unknown> }>;
  reviseQuestion(slug: string, edition: number, id: string, body: Record<string, unknown>, key: string | undefined): Promise<{ data: Record<string, unknown>; receipt: Record<string, unknown> }>;
  withdrawQuestion(slug: string, edition: number, id: string, key: string | undefined): Promise<{ data: Record<string, unknown>; receipt: Record<string, unknown> }>;
  deferQuestion(slug: string, edition: number, id: string, key: string | undefined): Promise<{ data: Record<string, unknown>; receipt: Record<string, unknown> }>;
  mergeQuestion(slug: string, edition: number, id: string, into: string, key: string | undefined): Promise<{ data: Record<string, unknown>; receipt: Record<string, unknown> }>;
  reorderQuestions(slug: string, edition: number, stage: string, round: string, ids: string[], key: string | undefined): Promise<unknown>;
  getQuestionVersions(slug: string, edition: number, id: string): Promise<unknown>;
  submitAnswers(slug: string, edition: number, stage: string, round: string, input: Record<string, unknown>, key: string | undefined): Promise<{ data: Record<string, unknown>; receipt: Record<string, unknown> }>;
  getComments(slug: string, edition: number, stage: string, round: string): Promise<unknown>;
  addComment(slug: string, edition: number, qid: string, input: Record<string, unknown>, key: string | undefined): Promise<{ data: Record<string, unknown>; receipt: Record<string, unknown> }>;
};

const SESSION = "synthetic-session-u2c";
const ID = "pj-synthetic-1";
const SLUG = WORKSPACE.slug;
const ED = WORKSPACE.edition;
const P = `/api/v1/projects/${ID}`;

const ok = (data: unknown, extra: Record<string, unknown> = {}) => ({ format_version: FORMAT_VERSION, request_id: "req-1", data, ...extra });
const fail = (code: string, details: unknown = null) => ({ format_version: FORMAT_VERSION, request_id: "req-e", error: { code, message: "합성 거절 문장", retryable: false, target: "$.body", details, next_action: "reread_context" } });
const CONTEXT = ok({ project_id: ID, stages: [{ stage_id: "stg-plan", key: "plan" }, { stage_id: "stg-research", key: "research" }] });
const requestsRead = (key: string, tx = "tx-77") => ok({ action: "question.published", tx_id: tx, status: 201, run_id: null, key });

interface Seen {
  url: URL;
  method: string;
  headers: Headers;
  json: Record<string, unknown> | null;
  credentials: string | undefined;
}
/** routes: "METHOD /path-suffix"(P 뒤) → 응답. 안 적은 길은 404 not_found */
function server(routes: Record<string, { status: number; body: unknown } | ((s: Seen) => { status: number; body: unknown })>) {
  const seen: Seen[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input), "http://app.invalid");
    const s: Seen = { url, method: (init?.method ?? "GET").toUpperCase(), headers: new Headers(init?.headers), json: typeof init?.body === "string" ? JSON.parse(init.body) : null, credentials: init?.credentials };
    seen.push(s);
    const key = `${s.method} ${url.pathname.replace(P, "")}`;
    const hit = routes[key];
    const r = typeof hit === "function" ? hit(s) : (hit ?? { status: 404, body: fail("not_found") });
    return new Response(JSON.stringify(r.body), { status: r.status });
  });
  const writes = () => seen.filter((s) => s.method === "POST");
  return { impl: impl as unknown as typeof fetch, seen, writes };
}
const make = async (s: ReturnType<typeof server>) => (await load())({ session: SESSION, projects: { [SLUG]: ID }, fetch: s.impl }) as unknown as U2cClient;

const questionData = (extra: Record<string, unknown> = {}) => ({ question: { id: "qst-1", version_id: "qvr-2", version_no: "2", state: "open", ...extra } });
const base = { text: "정의 변경 앞뒤를 이어 볼까요?", kind: "single_choice", options: [{ id: "join", label: "이어 보기" }, { id: "split", label: "따로 보기" }], importance: "high", required: true, default_value: "split", show_if: { question_id: "q-9", equals: "yes" }, help: "각주가 필요해요", direction: "ask_human" };

describe("공통: 헤더 · 키 · 오류", () => {
  it("모든 쓰기는 x-pes-session · idempotency-key · JSON 본문(format_version 1.0)이고 쿠키·Authorization·credentials 가 없다", async () => {
    const s = server({ "POST /questions/qst-1/withdraw": { status: 201, body: ok({ question: { id: "qst-1", version_id: "v", version_no: "2", state: "withdrawn" }, previous_answers_preserved: true }) }, "GET /requests/key-w": { status: 200, body: requestsRead("key-w") } });
    await (await make(s)).withdrawQuestion(SLUG, ED, "qst-1", "key-w");
    const w = s.writes()[0]!;
    expect(w.headers.get("x-pes-session")).toBe(SESSION);
    expect(w.headers.get("idempotency-key")).toBe("key-w");
    expect(w.headers.get("content-type")).toContain("application/json");
    expect(w.headers.get("authorization")).toBeNull();
    expect(w.headers.get("cookie")).toBeNull();
    expect(w.credentials).toBe("omit");
    expect(w.json).toMatchObject({ format_version: "1.0" });
    expect(w.url.pathname.startsWith("/api/v1/")).toBe(true);
  });

  it("멱등 키가 없으면 어떤 쓰기든 요청 없이 invalid_payload (PesApiError)", async () => {
    const s = server({});
    const c = await make(s);
    const calls: (() => Promise<unknown>)[] = [
      () => c.addQuestion(SLUG, ED, "research", "start", base, undefined),
      () => c.reviseQuestion(SLUG, ED, "qst-1", { ...base, base_version: 1, base_version_id: "qvr-1" }, undefined),
      () => c.withdrawQuestion(SLUG, ED, "qst-1", undefined),
      () => c.deferQuestion(SLUG, ED, "qst-1", undefined),
      () => c.mergeQuestion(SLUG, ED, "qst-1", "qst-2", undefined),
      () => c.submitAnswers(SLUG, ED, "research", "start", { mode: "single", form_version: 1, set_id: "qset-1", answers: [{ question_id: "qst-1", question_version: 1, value: "a" }] }, undefined),
      () => c.addComment(SLUG, ED, "qst-1", { body_md: "의견" }, undefined),
    ];
    for (const call of calls) {
      const e = await call().then(
        () => null,
        (x: unknown) => x,
      );
      expect(e).toBeInstanceOf(PesApiError);
      expect((e as PesApiError).body.error.code).toBe("invalid_payload");
    }
    expect(s.seen).toHaveLength(0);
  });

  it("모르는 slug 는 요청 없이 not_found PesApiError", async () => {
    const s = server({});
    const e = await (await make(s)).withdrawQuestion("nope", 1, "qst-1", "k").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PesApiError);
    expect((e as PesApiError).body.error.code).toBe("not_found");
    expect(s.seen).toHaveLength(0);
  });

  it("서버 거절(409 conflict · 422 · 400)은 PesApiError 로, 봉투와 details 가 그대로 보존된다", async () => {
    const details = { reason: "required_missing", question_ids: ["qst-3"] };
    for (const [status, code] of [[409, "conflict"], [422, "validation_failed"], [400, "invalid_payload"]] as const) {
      const s = server({ "POST /submissions": { status, body: fail(code, details) } });
      const e = await (await make(s)).submitAnswers(SLUG, ED, "research", "start", { mode: "bundle", form_version: 1, set_id: "qset-1", answers: [{ question_id: "qst-3", question_version: 1, value: "a" }] }, "k-rej").catch((x: unknown) => x);
      expect(e).toBeInstanceOf(PesApiError);
      expect((e as PesApiError).body.error.code).toBe(code);
      expect(((e as PesApiError).body.error as unknown as { details: unknown }).details).toEqual(details);
      // 거절이면 영수증 조회도 하지 않는다
      expect(s.seen.filter((x) => x.url.pathname.includes("/requests/"))).toHaveLength(0);
    }
  });

  it("네트워크 실패는 삼키지 않고 그대로 reject 한다 (영수증 조회도 하지 않는다)", async () => {
    const boom = new TypeError("Failed to fetch");
    const impl = vi.fn(async () => {
      throw boom;
    }) as unknown as typeof fetch;
    const c = (await (await load())({ session: SESSION, projects: { [SLUG]: ID }, fetch: impl })) as unknown as U2cClient;
    await expect(c.withdrawQuestion(SLUG, ED, "qst-1", "k")).rejects.toBe(boom);
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it("질문 도구가 켜진다: capabilities.questionTools 는 false 가 아니다", async () => {
    expect((await make(server({}))).capabilities?.questionTools).not.toBe(false);
  });
});

describe("질문 쓰기 매핑", () => {
  it("addQuestion(start): GET P/context 로 stage_id 를 풀고 POST P/questions 로 spec 을 보낸다", async () => {
    const s = server({
      "GET /context": { status: 200, body: CONTEXT },
      "POST /questions": { status: 201, body: ok({ question_set_id: "qset-2", question: { id: "qst-9", version_id: "qvr-9", version_no: "1", state: "open" } }) },
      "GET /requests/k-add": { status: 200, body: requestsRead("k-add") },
    });
    const out = await (await make(s)).addQuestion(SLUG, ED, "research", "start", base, "k-add");
    const w = s.writes();
    expect(w).toHaveLength(1);
    expect(w[0]!.url.pathname).toBe(`${P}/questions`);
    expect(w[0]!.json).toMatchObject({
      stage_id: "stg-research",
      round_id: null,
      purpose: "stage_start",
      direction: "agent_to_human",
      question: {
        text: base.text,
        type: "single",
        required: true,
        importance: "high",
        default_value: "split",
        options: [{ value: "join", label: "이어 보기" }, { value: "split", label: "따로 보기" }],
        show_if: { id: "q-9", in: ["yes"] },
        help: "각주가 필요해요",
      },
    });
    expect(out.data).toEqual({ question_id: "qst-9", version: 1 });
    expect(out.receipt).toMatchObject({ tx_id: "tx-77", idempotency_key: "k-add", replayed: false });
    expect(typeof out.receipt.receipt_no).toBe("string");
    expect(String(out.receipt.receipt_no).length).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(String(out.receipt.committed_at)))).toBe(false);
  });

  it.each([
    ["free_text", "text"],
    ["multi_choice", "multi"],
  ])("유형 %s → 서버 type %s, 중요도 null · 기본값 null · 조건 없음은 키를 보내지 않는다", async (kind, type) => {
    const s = server({
      "GET /context": { status: 200, body: CONTEXT },
      "POST /questions": { status: 201, body: ok({ question_set_id: "qset-2", question: { id: "qst-9", version_id: "v", version_no: "1", state: "open" } }) },
      "GET /requests/k-t": { status: 200, body: requestsRead("k-t") },
    });
    await (await make(s)).addQuestion(SLUG, ED, "research", "start", { ...base, kind, options: kind === "free_text" ? [] : base.options, importance: null, default_value: null, show_if: null, help: null }, "k-t");
    const q = (s.writes()[0]!.json as { question: Record<string, unknown> }).question;
    expect(q.type).toBe(type);
    expect(q).not.toHaveProperty("importance");
    expect(q).not.toHaveProperty("default_value");
    expect(q).not.toHaveProperty("show_if");
    if (kind === "free_text") expect(q).not.toHaveProperty("options");
  });

  it("addQuestion: 방향 ask_ai 는 서버가 받지 않는다 → NotConnectedError, 요청 0", async () => {
    const s = server({});
    await expect((await make(s)).addQuestion(SLUG, ED, "research", "start", { ...base, direction: "ask_ai" }, "k")).rejects.toBeInstanceOf(NotConnectedError);
    expect(s.seen).toHaveLength(0);
  });

  it("addQuestion: 번호 라운드는 서버 round_id 를 모른다 → NotConnectedError, 쓰기 0", async () => {
    const s = server({ "GET /context": { status: 200, body: CONTEXT } });
    await expect((await make(s)).addQuestion(SLUG, ED, "research", "2", base, "k")).rejects.toBeInstanceOf(NotConnectedError);
    expect(s.writes()).toHaveLength(0);
  });

  it("addQuestion: context 에 그 단계가 없으면 not_found PesApiError, 쓰기 0", async () => {
    const s = server({ "GET /context": { status: 200, body: ok({ project_id: ID, stages: [{ stage_id: "stg-plan", key: "plan" }] }) } });
    const e = await (await make(s)).addQuestion(SLUG, ED, "research", "start", base, "k").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PesApiError);
    expect((e as PesApiError).body.error.code).toBe("not_found");
    expect(s.writes()).toHaveLength(0);
  });

  it("reviseQuestion: POST P/questions/{q}/revisions, base_version_id 와 spec, 결과 needs_recheck 는 recheck_required", async () => {
    const s = server({
      "POST /questions/qst-1/revisions": { status: 201, body: ok({ ...questionData(), recheck_required: true, previous_answers_preserved: true }) },
      "GET /requests/k-rev": { status: 200, body: requestsRead("k-rev") },
    });
    const out = await (await make(s)).reviseQuestion(SLUG, ED, "qst-1", { ...base, base_version: 1, base_version_id: "qvr-1" }, "k-rev");
    const w = s.writes()[0]!;
    expect(w.url.pathname).toBe(`${P}/questions/qst-1/revisions`);
    expect(w.json).toMatchObject({ base_version_id: "qvr-1", question: { text: base.text, type: "single", required: true } });
    expect(w.json).not.toHaveProperty("base_version");
    expect(out.data).toEqual({ question_id: "qst-1", version: 2, needs_recheck: true });
  });

  it("reviseQuestion: recheck_required 가 false 면 needs_recheck false", async () => {
    const s = server({
      "POST /questions/qst-1/revisions": { status: 201, body: ok({ ...questionData(), recheck_required: false }) },
      "GET /requests/k-rev2": { status: 200, body: requestsRead("k-rev2") },
    });
    const out = await (await make(s)).reviseQuestion(SLUG, ED, "qst-1", { ...base, base_version: 1, base_version_id: "qvr-1" }, "k-rev2");
    expect(out.data.needs_recheck).toBe(false);
  });

  it("reviseQuestion: base_version_id 가 없으면 서버 버전 id 를 지어내지 않고 요청 없이 invalid_payload", async () => {
    const s = server({});
    const e = await (await make(s)).reviseQuestion(SLUG, ED, "qst-1", { ...base, base_version: 1 }, "k").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PesApiError);
    expect((e as PesApiError).body.error.code).toBe("invalid_payload");
    expect(s.seen).toHaveLength(0);
  });

  it("withdraw · defer · merge 는 각자 길로, 본문은 최소(merge 만 merged_into_question_id)", async () => {
    const s = server({
      "POST /questions/qst-1/withdraw": { status: 201, body: ok({ question: { id: "qst-1", version_id: "v", version_no: "2", state: "withdrawn" }, previous_answers_preserved: true }) },
      "POST /questions/qst-1/defer": { status: 201, body: ok({ question: { id: "qst-1", version_id: "v", version_no: "2", state: "deferred" }, previous_answers_preserved: true }) },
      "POST /questions/qst-1/merge": { status: 201, body: ok({ question: { id: "qst-1", version_id: "v", version_no: "2", state: "merged", merged_into_question_id: "qst-2" }, previous_answers_preserved: true }) },
      "GET /requests/k-w": { status: 200, body: requestsRead("k-w") },
      "GET /requests/k-d": { status: 200, body: requestsRead("k-d") },
      "GET /requests/k-m": { status: 200, body: requestsRead("k-m") },
    });
    const c = await make(s);
    expect((await c.withdrawQuestion(SLUG, ED, "qst-1", "k-w")).data).toEqual({ question_id: "qst-1", status: "withdrawn" });
    expect((await c.deferQuestion(SLUG, ED, "qst-1", "k-d")).data).toEqual({ question_id: "qst-1", status: "deferred" });
    expect((await c.mergeQuestion(SLUG, ED, "qst-1", "qst-2", "k-m")).data).toEqual({ question_id: "qst-1", status: "merged", merged_into: "qst-2" });
    const w = s.writes();
    expect(w.map((x) => x.url.pathname)).toEqual([`${P}/questions/qst-1/withdraw`, `${P}/questions/qst-1/defer`, `${P}/questions/qst-1/merge`]);
    expect(w.map((x) => x.headers.get("idempotency-key"))).toEqual(["k-w", "k-d", "k-m"]);
    expect(w[0]!.json).toEqual({ format_version: "1.0" });
    expect(w[1]!.json).toEqual({ format_version: "1.0" });
    expect(w[2]!.json).toEqual({ format_version: "1.0", merged_into_question_id: "qst-2" });
  });

  it("질문 id 의 특수문자는 경로에서 인코딩된다", async () => {
    const s = server({ "POST /questions/q%2F1%3F/withdraw": { status: 201, body: ok({ question: { id: "q/1?", version_id: "v", version_no: "2", state: "withdrawn" } }) }, "GET /requests/k-e": { status: 200, body: requestsRead("k-e") } });
    await (await make(s)).withdrawQuestion(SLUG, ED, "q/1?", "k-e");
    expect(s.writes()[0]!.url.pathname).toBe(`${P}/questions/q%2F1%3F/withdraw`);
  });

  it("서버가 replayed:true 로 답하면 영수증 replayed 도 true, 같은 키라 새 쓰기를 만들지 않는다", async () => {
    const s = server({
      "POST /questions/qst-1/withdraw": { status: 201, body: ok({ question: { id: "qst-1", version_id: "v", version_no: "2", state: "withdrawn" } }, { replayed: true }) },
      "GET /requests/k-w": { status: 200, body: requestsRead("k-w") },
    });
    const out = await (await make(s)).withdrawQuestion(SLUG, ED, "qst-1", "k-w");
    expect(out.receipt.replayed).toBe(true);
    expect(out.receipt.idempotency_key).toBe("k-w");
  });
});

describe("U2a 에 길이 없는 것은 정직하게 거절한다 (요청 0)", () => {
  it("reorderQuestions · getQuestionVersions · getComments → NotConnectedError, 네트워크 0", async () => {
    const s = server({});
    const c = await make(s);
    await expect(c.reorderQuestions(SLUG, ED, "research", "start", ["a", "b"], "k")).rejects.toBeInstanceOf(NotConnectedError);
    await expect(c.getQuestionVersions(SLUG, ED, "qst-1")).rejects.toBeInstanceOf(NotConnectedError);
    await expect(c.getComments(SLUG, ED, "research", "start")).rejects.toBeInstanceOf(NotConnectedError);
    expect(s.seen).toHaveLength(0);
  });
});

describe("답 제출 매핑", () => {
  const body = (extra: Record<string, unknown> = {}) => ({
    mode: "bundle",
    form_version: 4,
    set_id: "qset-4",
    answers: [
      { question_id: "qst-1", question_version: 2, question_version_id: "qvr-2", value: "join", comment: "의견 하나", used_default: false },
      { question_id: "qst-2", question_version: 1, value: ["foot", "chart"], used_default: true },
      { question_id: "qst-3", question_version: 1, value: null, comment: "의견만" },
    ],
    ...extra,
  });
  const submitted = {
    submission: { id: "sub-1", received_at: 1762312000000, state: "accepted" },
    answers: [{ question_id: "qst-1", answer_version_id: "av-1", state: "submitted" }],
    form_complete: false,
    missing_required: ["qst-5"],
  };

  it("묶음: POST P/submissions, set_id · mode · 항목(value 없는 의견만 항목은 value 키 없이)이 U2a 모양으로 간다", async () => {
    const s = server({ "POST /submissions": { status: 201, body: ok(submitted) }, "GET /requests/k-sub": { status: 200, body: requestsRead("k-sub", "tx-90") } });
    const out = await (await make(s)).submitAnswers(SLUG, ED, "research", "start", body(), "k-sub");
    const w = s.writes();
    expect(w).toHaveLength(1);
    expect(w[0]!.url.pathname).toBe(`${P}/submissions`);
    const sent = w[0]!.json as { set_id: string; mode: string; answers: Record<string, unknown>[] };
    expect(sent).toMatchObject({ format_version: "1.0", set_id: "qset-4", mode: "bundle" });
    expect(sent.answers).toHaveLength(3);
    expect(sent.answers[0]).toEqual({ question_id: "qst-1", question_version_id: "qvr-2", value: "join", comment: "의견 하나", used_default: false });
    expect(sent.answers[1]).toEqual({ question_id: "qst-2", value: ["foot", "chart"], used_default: true });
    expect(sent.answers[2]).toEqual({ question_id: "qst-3", comment: "의견만" });
    // 앱 쪽 전용 값(question_version 숫자 · form_version)은 서버에 보내지 않는다
    expect(JSON.stringify(sent)).not.toContain("question_version\"");
    expect(sent).not.toHaveProperty("form_version");
    expect(out.data).toEqual({ submission_id: "sub-1", answers: [{ question_id: "qst-1", state: "submitted" }], form_complete: false, missing_required: ["qst-5"] });
    expect(out.receipt).toMatchObject({ tx_id: "tx-90", idempotency_key: "k-sub", replayed: false });
  });

  it("개별: mode single 로 항목 하나, form_complete=false 를 그대로 돌려준다", async () => {
    const s = server({ "POST /submissions": { status: 201, body: ok(submitted) }, "GET /requests/k-one": { status: 200, body: requestsRead("k-one") } });
    const out = await (await make(s)).submitAnswers(SLUG, ED, "research", "start", body({ mode: "single", answers: [{ question_id: "qst-1", question_version: 2, value: "join" }] }), "k-one");
    expect((s.writes()[0]!.json as { mode: string; answers: unknown[] }).mode).toBe("single");
    expect((s.writes()[0]!.json as { answers: unknown[] }).answers).toHaveLength(1);
    expect(out.data.form_complete).toBe(false);
  });

  it("set_id 가 없으면 서버 폼 세트를 지어내지 않고 요청 없이 invalid_payload", async () => {
    const s = server({});
    const input = body();
    delete (input as Record<string, unknown>).set_id;
    const e = await (await make(s)).submitAnswers(SLUG, ED, "research", "start", input, "k").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PesApiError);
    expect((e as PesApiError).body.error.code).toBe("invalid_payload");
    expect(s.seen).toHaveLength(0);
  });

  it("같은 키로 다시 보내면 같은 본문이 가고 서버가 replayed 로 답하면 영수증도 replayed", async () => {
    let n = 0;
    const s = server({
      "POST /submissions": () => ({ status: 201, body: ok(submitted, n++ ? { replayed: true } : {}) }),
      "GET /requests/k-r": { status: 200, body: requestsRead("k-r") },
    });
    const c = await make(s);
    const first = await c.submitAnswers(SLUG, ED, "research", "start", body(), "k-r");
    const again = await c.submitAnswers(SLUG, ED, "research", "start", body(), "k-r");
    const w = s.writes();
    expect(w[1]!.json).toEqual(w[0]!.json);
    expect(w[1]!.headers.get("idempotency-key")).toBe("k-r");
    expect(first.receipt.replayed).toBe(false);
    expect(again.receipt.replayed).toBe(true);
  });
});

describe("의견(스레드) 매핑", () => {
  it("새 스레드: POST P/threads, context_kind question_comment, 첫 메시지 본문 · thread_created true", async () => {
    const s = server({
      "POST /threads": { status: 201, body: ok({ thread: { id: "thr-1", state: "open" }, message: { id: "msg-1", version_no: "1" } }) },
      "GET /requests/k-th": { status: 200, body: requestsRead("k-th") },
    });
    const out = await (await make(s)).addComment(SLUG, ED, "qst-1", { body_md: "범위가 모호해요", question_version_id: "qvr-2" }, "k-th");
    const w = s.writes()[0]!;
    expect(w.url.pathname).toBe(`${P}/threads`);
    expect(w.json).toEqual({ format_version: "1.0", target_object_id: "qst-1", target_version_id: "qvr-2", context_kind: "question_comment", initial_message: { body_md: "범위가 모호해요" } });
    expect(out.data).toEqual({ thread_id: "thr-1", message_id: "msg-1", thread_created: true });
  });

  it("버전 id 를 모르면 target_version_id 를 보내지 않는다(서버가 현재 버전)", async () => {
    const s = server({
      "POST /threads": { status: 201, body: ok({ thread: { id: "thr-1", state: "open" }, message: { id: "msg-1", version_no: "1" } }) },
      "GET /requests/k-th2": { status: 200, body: requestsRead("k-th2") },
    });
    await (await make(s)).addComment(SLUG, ED, "qst-1", { body_md: "글" }, "k-th2");
    expect(s.writes()[0]!.json).not.toHaveProperty("target_version_id");
    expect(s.writes()[0]!.json).not.toHaveProperty("anchor");
  });

  it("기존 스레드: POST P/threads/{t}/messages, 본문은 body_md 만 · thread_created false", async () => {
    const s = server({
      "POST /threads/thr-1/messages": { status: 201, body: ok({ message: { id: "msg-2", version_no: "1", thread_id: "thr-1" } }) },
      "GET /requests/k-msg": { status: 200, body: requestsRead("k-msg") },
    });
    const out = await (await make(s)).addComment(SLUG, ED, "qst-1", { body_md: "알겠습니다", thread_id: "thr-1" }, "k-msg");
    const w = s.writes()[0]!;
    expect(w.url.pathname).toBe(`${P}/threads/thr-1/messages`);
    expect(w.json).toEqual({ format_version: "1.0", body_md: "알겠습니다" });
    expect(out.data).toEqual({ thread_id: "thr-1", message_id: "msg-2", thread_created: false });
  });

  it("빈 글(공백만)은 요청 없이 invalid_payload — 의견은 답을 만들지 않는다(submissions 로도 가지 않는다)", async () => {
    const s = server({});
    const e = await (await make(s)).addComment(SLUG, ED, "qst-1", { body_md: "   " }, "k").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PesApiError);
    expect((e as PesApiError).body.error.code).toBe("invalid_payload");
    expect(s.seen).toHaveLength(0);
  });

  it("annotation 은 보내지 않는다: 어떤 의견 요청이든 context_kind 는 question_comment", async () => {
    const s = server({
      "POST /threads": { status: 201, body: ok({ thread: { id: "thr-1", state: "open" }, message: { id: "msg-1", version_no: "1" } }) },
      "GET /requests/k-q": { status: 200, body: requestsRead("k-q") },
    });
    await (await make(s)).addComment(SLUG, ED, "qst-1", { body_md: "글", context_kind: "annotation" }, "k-q");
    expect((s.writes()[0]!.json as { context_kind: string }).context_kind).toBe("question_comment");
  });
});
