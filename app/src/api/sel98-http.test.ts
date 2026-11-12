// SEL-98 U2d — HTTP 클라이언트가 SEL-92 의 정직 거절(NotConnected·invalid_payload)을 실제 서버 매핑으로 바꾼다 (Vitest, fetch 는 가짜). 구현 전이라 실패가 정상.
// 서버 계약: tests/test_sel98_reads.test.ts · test_sel98_order_rules.test.ts · test_sel98_receipt.test.ts 머리말.
//
// ═══ 매핑 표 (P = /api/v1/projects/{id}; 읽기는 GET 에 본문·Idempotency-Key 없음, 쓰기는 U2c 표와 같은 헤더) ═══
//  PesClient                                  요청                                                   응답 → 앱 모양
//  getRound(slug, ed, stage, round)           GET P/stages/{stage}/rounds/{start|번호}                data → RoundView:
//                                                                                                       {stage, round_id: data.round_id, state, form_version: data.form_version ?? 0, set_id: data.set_id(null 이면 칸 없음),
//                                                                                                        questions[], result: null, alerts: [], prompt: ""}
//     질문 → QuestionView: id, number: display_no, version: Number(version_no), version_id, required, importance(null 이면 칸 없음), source "ai", text, help(null 이면 칸 없음),
//            kind: single→single_choice · multi→multi_choice · 그 밖(text 등)→free_text, options(선택지 유형만): [{id: value, label}], default_value(null 이면 null),
//            show_if: {question_id: show_if.id, equals: show_if.in[0]} (없으면 null), direction "ask_human", status: state, merged_into(merged 일 때), allow_comment_as_answer.
//            답: answer 가 있고 그 질문 버전이 현재 버전이면 sent = {answer: 선택지는 label(여럿은 ", "), 글은 그대로, receipt_no, tx_id, committed_at}, used_default = answer.used_default.
//                answer.question_version_id 가 현재 version_id 와 다르면 needs_recheck: true + sent 없음 + previous_answer = {answer(같은 글), receipt_no, committed_at}. (version 칸은 서버가 안 줘서 단언하지 않는다)
//     서버 404 → null. (옛 서버 호환: 라운드 경로가 404 이고 작업 공간에 그 자리가 있으면 질문 없는 빈 뷰를 돌려줘도 된다 — 기존 http-client.test.ts 의 getRound 단언이 그대로 통과하도록.)
//  getComments(slug, ed, stage, round)        GET P/stages/{stage}/rounds/{start|번호}/threads        data.threads → [{thread_id, question_id("__other" 그대로), question_version?: 숫자(null 이면 칸 없음), messages:[{message_id, body_md, at, by, receipt_no?}]}]; 404 → []
//  reorderQuestions(slug, ed, stage, round, ids, key)   (1) GET P/stages/{stage}/rounds/{round} 로 set_id (2) POST P/question-sets/{set_id}/order {question_ids: ids}
//                                                                                                       → data {form_version: Number(data.set.version_no)}. 라운드가 없으면(404) PesApiError not_found, 쓰기 0.
//  addQuestion(…, stage, "<번호>", body, key)  (1) GET P/stages/{stage}/rounds/{번호} 로 server_round_id (2) GET P/context 로 stage_id (3) POST P/questions {stage_id, round_id: server_round_id, form_key "main", direction "agent_to_human", question: spec}
//  ask_ai(addQuestion · reviseQuestion)       서버는 계속 받지 않는다 → 요청 없이 NotConnectedError (SEL-98 서버 결정, 회귀)
//  쓰기 응답의 영수증                          성공 본문 body.receipt {receipt_no, tx_id, committed_at} 를 그대로 Receipt 로(+ idempotency_key · replayed). 이때 GET P/requests/{key} 를 부르지 않는다.
//                                             receipt_no 는 서버 글 그대로이고 numbered:false 칸이 없다. (body.receipt 가 없는 옛 서버면 지금처럼 GET P/requests/{key} 로 읽어도 된다 — 기존 시험 호환; 이 파일은 그 경우를 단언하지 않는다.)
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
type W = Promise<{ data: Record<string, unknown>; receipt: Record<string, unknown> }>;
type C = {
  getRound(slug: string, edition: number, stage: string, round: string): Promise<Record<string, any> | null>;
  getComments(slug: string, edition: number, stage: string, round: string): Promise<Record<string, any>[]>;
  reorderQuestions(slug: string, edition: number, stage: string, round: string, ids: string[], key: string | undefined): W;
  addQuestion(slug: string, edition: number, stage: string, round: string, body: Record<string, unknown>, key: string | undefined): W;
  reviseQuestion(slug: string, edition: number, id: string, body: Record<string, unknown>, key: string | undefined): W;
  withdrawQuestion(slug: string, edition: number, id: string, key: string | undefined): W;
  submitAnswers(slug: string, edition: number, stage: string, round: string, input: Record<string, unknown>, key: string | undefined): W;
  addComment(slug: string, edition: number, qid: string, input: Record<string, unknown>, key: string | undefined): W;
};

const SESSION = "synthetic-session-sel98";
const ID = "pj-synthetic-98";
const SLUG = WORKSPACE.slug;
const ED = WORKSPACE.edition;
const P = `/api/v1/projects/${ID}`;
const ok = (data: unknown, extra: Record<string, unknown> = {}) => ({ format_version: FORMAT_VERSION, request_id: "req-1", data, ...extra });
const fail = (code: string) => ({ format_version: FORMAT_VERSION, request_id: "req-e", error: { code, message: "합성 거절", retryable: false, target: null, details: null, next_action: "reread_context" } });
const RECEIPT = { receipt_no: "0123", tx_id: "tx-98", committed_at: "2026-11-12T09:30:00+09:00" };
const CONTEXT = ok({ project_id: ID, stages: [{ stage_id: "stg-plan", key: "plan" }, { stage_id: "stg-research", key: "research" }] });

interface Seen {
  url: URL;
  method: string;
  headers: Headers;
  json: Record<string, any> | null;
}
function server(routes: Record<string, { status: number; body: unknown } | ((s: Seen) => { status: number; body: unknown })>) {
  const seen: Seen[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input), "http://app.invalid");
    const s: Seen = { url, method: (init?.method ?? "GET").toUpperCase(), headers: new Headers(init?.headers), json: typeof init?.body === "string" ? JSON.parse(init.body) : null };
    seen.push(s);
    const hit = routes[`${s.method} ${url.pathname.replace(P, "")}`];
    const r = typeof hit === "function" ? hit(s) : (hit ?? { status: 404, body: fail("not_found") });
    return new Response(JSON.stringify(r.body), { status: r.status });
  });
  return { impl: impl as unknown as typeof fetch, seen, writes: () => seen.filter((s) => s.method === "POST"), gets: (part: string) => seen.filter((s) => s.method === "GET" && s.url.pathname.includes(part)) };
}
const make = async (s: ReturnType<typeof server>) => (await load())({ session: SESSION, projects: { [SLUG]: ID }, fetch: s.impl }) as unknown as C;

/* ───────────── 서버 라운드 읽기 합성 자료 ───────────── */
const Q1 = {
  id: "qst-1", version_id: "qvr-1b", version_no: "2", display_no: 21, state: "open", type: "single", text: "정의 변경 앞뒤를 이어 볼까요?", required: true, allow_comment_as_answer: false,
  importance: "high", help: "각주가 필요해요", default_value: "split", options: [{ value: "join", label: "이어 보기", recommended: true }, { value: "split", label: "따로 보기" }], show_if: null, merged_into_question_id: null,
  answer: { version_id: "ans-1", value: "join", question_version_id: "qvr-1b", used_default: false, state: "submitted", tx_id: "tx-50", receipt_no: "0050", committed_at: "2026-11-12T08:00:00+09:00" },
};
const Q2 = {
  id: "qst-2", version_id: "qvr-2a", version_no: "1", display_no: 22, state: "open", type: "text", text: "더 볼 출처가 있나요?", required: false, allow_comment_as_answer: true,
  importance: null, help: null, default_value: null, options: [], show_if: { id: "qst-1", in: ["join"] }, merged_into_question_id: null, answer: null,
};
const Q3 = {
  id: "qst-3", version_id: "qvr-3b", version_no: "3", display_no: 23, state: "open", type: "multi", text: "주의 문구는요?", required: true, allow_comment_as_answer: false,
  importance: "normal", help: null, default_value: null, options: [{ value: "foot", label: "각주" }, { value: "chart", label: "그림 설명" }], show_if: null, merged_into_question_id: null,
  answer: { version_id: "ans-3", value: ["foot", "chart"], question_version_id: "qvr-3a", used_default: false, state: "submitted", tx_id: "tx-31", receipt_no: "0031", committed_at: "2026-11-11T08:00:00+09:00" },
};
const roundData = (extra: Record<string, unknown> = {}) => ({ stage: "research", round_id: 2, server_round_id: "rnd-2", state: "current", set_id: "qset-9", form_version: 4, questions: [Q1, Q2, Q3], ...extra });

describe("getRound — 서버 라운드 읽기 매핑", () => {
  it("GET P/stages/{stage}/rounds/{번호} 한 번으로 set_id · form_version · 질문(version_id 포함)을 채운다", async () => {
    const s = server({ "GET /stages/research/rounds/2": { status: 200, body: ok(roundData()) } });
    const r = await (await make(s)).getRound(SLUG, ED, "research", "2");
    const reads = s.gets("/stages/research/rounds/2");
    expect(reads).toHaveLength(1);
    expect(reads[0]!.headers.get("x-pes-session")).toBe(SESSION);
    expect(reads[0]!.headers.get("idempotency-key")).toBeNull();
    expect(reads[0]!.json).toBeNull();
    expect(r).toMatchObject({ stage: "research", round_id: 2, state: "current", form_version: 4, set_id: "qset-9", result: null, alerts: [], prompt: "" });
    expect(r!.questions.map((q: any) => [q.id, q.number, q.version, q.version_id])).toEqual([["qst-1", 21, 2, "qvr-1b"], ["qst-2", 22, 1, "qvr-2a"], ["qst-3", 23, 3, "qvr-3b"]]);
  });

  it("질문 칸: 종류 · 선택지 · 기본값 · 조건 · 도움말 · 중요도 · 필수 · 의견만으로 답 가능", async () => {
    const s = server({ "GET /stages/research/rounds/2": { status: 200, body: ok(roundData()) } });
    const [q1, q2, q3] = (await (await make(s)).getRound(SLUG, ED, "research", "2"))!.questions;
    expect(q1).toMatchObject({ kind: "single_choice", required: true, importance: "high", help: "각주가 필요해요", default_value: "split", show_if: null, direction: "ask_human", status: "open" });
    expect(q1.options).toEqual([{ id: "join", label: "이어 보기" }, { id: "split", label: "따로 보기" }]);
    expect(q2).toMatchObject({ kind: "free_text", required: false, allow_comment_as_answer: true, show_if: { question_id: "qst-1", equals: "join" } });
    expect("importance" in q2).toBe(false);
    expect("help" in q2).toBe(false);
    expect(q3).toMatchObject({ kind: "multi_choice", allow_comment_as_answer: false });
    expect(q3.options.map((o: any) => o.id)).toEqual(["foot", "chart"]);
  });

  it("현재 버전의 답은 보낸 답(sent: 선택지 label · 영수증)이 되고, 기본값 채택 여부가 실린다", async () => {
    const s = server({ "GET /stages/research/rounds/2": { status: 200, body: ok(roundData({ questions: [{ ...Q1, answer: { ...Q1.answer, used_default: true } }] })) } });
    const [q1] = (await (await make(s)).getRound(SLUG, ED, "research", "2"))!.questions;
    expect(q1.sent).toMatchObject({ answer: "이어 보기", receipt_no: "0050", tx_id: "tx-50", committed_at: "2026-11-12T08:00:00+09:00" });
    expect(q1.used_default).toBe(true);
    expect(q1.needs_recheck ?? false).toBe(false);
  });

  it("질문 버전이 답보다 새로우면 재확인: sent 없음 + needs_recheck + previous_answer(여러 선택은 label 을 ', ' 로)", async () => {
    const s = server({ "GET /stages/research/rounds/2": { status: 200, body: ok(roundData()) } });
    const q3 = (await (await make(s)).getRound(SLUG, ED, "research", "2"))!.questions[2];
    expect(q3.needs_recheck).toBe(true);
    expect(q3.sent ?? null).toBeNull();
    expect(q3.previous_answer).toMatchObject({ answer: "각주, 그림 설명", receipt_no: "0031", committed_at: "2026-11-11T08:00:00+09:00" });
  });

  it("글 답은 그대로, 철회·보류·합침 상태와 합쳐진 대상이 실린다", async () => {
    const text = { ...Q2, answer: { version_id: "ans-2", value: "추가 출처 없음", question_version_id: "qvr-2a", used_default: false, state: "submitted", tx_id: "tx-60", receipt_no: "0060", committed_at: "2026-11-12T08:10:00+09:00" } };
    const merged = { ...Q1, id: "qst-7", state: "merged", merged_into_question_id: "qst-1", answer: null };
    const s = server({ "GET /stages/research/rounds/2": { status: 200, body: ok(roundData({ questions: [text, merged] })) } });
    const [t, m] = (await (await make(s)).getRound(SLUG, ED, "research", "2"))!.questions;
    expect(t.sent.answer).toBe("추가 출처 없음");
    expect(m).toMatchObject({ status: "merged", merged_into: "qst-1" });
  });

  it("start 자리는 round_id null, 서버 404 는 null, 폼이 없으면(set_id null) 칸 없이 빈 질문", async () => {
    const s = server({
      "GET /stages/plan/rounds/start": { status: 200, body: ok({ stage: "plan", round_id: null, server_round_id: null, state: "current", set_id: null, form_version: null, questions: [] }) },
    });
    const c = await make(s);
    const start = await c.getRound(SLUG, ED, "plan", "start");
    expect(start).toMatchObject({ stage: "plan", round_id: null, questions: [] });
    expect(start!.set_id ?? null).toBeNull();
    expect(typeof start!.form_version).toBe("number");
    expect(await c.getRound(SLUG, ED, "plan", "9")).toBeNull();
    expect(await (await make(server({}))).getRound("no-such-project", ED, "plan", "start")).toBeNull();
  });

  it("읽은 값이 그대로 쓰기에 쓰인다: version_id → 고치기 base_version_id · set_id + version_id → 묶음 제출 (단추 사전 차단이 필요 없다)", async () => {
    const s = server({
      "GET /stages/research/rounds/2": { status: 200, body: ok(roundData()) },
      "POST /questions/qst-1/revisions": { status: 201, body: ok({ question: { id: "qst-1", version_id: "qvr-1c", version_no: "3", state: "open" }, recheck_required: true }, { receipt: RECEIPT }) },
      "POST /submissions": { status: 201, body: ok({ submission: { id: "sub-1" }, answers: [{ question_id: "qst-1" }], form_complete: true, missing_required: [] }, { receipt: RECEIPT }) },
    });
    const c = await make(s);
    const round = (await c.getRound(SLUG, ED, "research", "2"))!;
    const q1 = round.questions[0];
    await c.reviseQuestion(SLUG, ED, "qst-1", { text: "고친 문구", kind: "single_choice", options: q1.options, importance: "high", required: true, default_value: null, show_if: null, direction: "ask_human", base_version: q1.version, base_version_id: q1.version_id }, "k-rev");
    await c.submitAnswers(SLUG, ED, "research", "2", { mode: "bundle", form_version: round.form_version, set_id: round.set_id, answers: [{ question_id: "qst-1", question_version: q1.version, question_version_id: q1.version_id, value: "split" }] }, "k-sub");
    const [rev, sub] = s.writes();
    expect(rev!.json).toMatchObject({ base_version_id: "qvr-1b" });
    expect(sub!.json).toMatchObject({ set_id: "qset-9", mode: "bundle", answers: [{ question_id: "qst-1", question_version_id: "qvr-1b", value: "split" }] });
  });
});

describe("getComments — 의견 목록 읽기", () => {
  it("GET P/stages/{stage}/rounds/{round}/threads 를 앱 모양으로: __other 그대로 · 메시지 순서 · 질문 버전", async () => {
    const threads = [
      { thread_id: "th-1", question_id: "qst-1", question_version_id: "qvr-1b", question_version: 2, messages: [{ message_id: "m-1", body_md: "범위가 모호합니다", at: "2026-11-12T09:00:00+09:00", by: "human" }, { message_id: "m-2", body_md: "각주로 밝히면 됩니다", at: "2026-11-12T09:05:00+09:00", by: "ai", receipt_no: "0071" }] },
      { thread_id: "th-old", question_id: "__other", question_version_id: null, question_version: null, messages: [{ message_id: "m-9", body_md: "옛 의견", at: "2026-11-01T09:00:00+09:00", by: "human" }] },
    ];
    const s = server({ "GET /stages/research/rounds/2/threads": { status: 200, body: ok({ threads }) } });
    const got = await (await make(s)).getComments(SLUG, ED, "research", "2");
    expect(s.gets("/threads")).toHaveLength(1);
    expect(s.writes()).toHaveLength(0);
    expect(got).toHaveLength(2);
    expect(got[0]).toMatchObject({ thread_id: "th-1", question_id: "qst-1", question_version: 2 });
    expect(got[0]!.messages.map((m: any) => [m.message_id, m.body_md, m.by])).toEqual([["m-1", "범위가 모호합니다", "human"], ["m-2", "각주로 밝히면 됩니다", "ai"]]);
    expect(got[0]!.messages[1].receipt_no).toBe("0071");
    expect(got[1]).toMatchObject({ thread_id: "th-old", question_id: "__other" });
    expect("question_version" in got[1]! && got[1]!.question_version !== undefined).toBe(false);
  });

  it("스레드가 없으면 빈 목록, 라운드를 못 찾으면(404) 빈 목록, 그 밖의 거절은 PesApiError", async () => {
    expect(await (await make(server({ "GET /stages/research/rounds/2/threads": { status: 200, body: ok({ threads: [] }) } }))).getComments(SLUG, ED, "research", "2")).toEqual([]);
    expect(await (await make(server({}))).getComments(SLUG, ED, "research", "2")).toEqual([]);
    const e = await (await make(server({ "GET /stages/research/rounds/2/threads": { status: 403, body: fail("forbidden") } }))).getComments(SLUG, ED, "research", "2").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PesApiError);
  });
});

describe("reorderQuestions — 질문 순서 바꾸기", () => {
  it("라운드 읽기로 set_id 를 알고 POST P/question-sets/{set_id}/order 로 보낸다, 결과는 새 폼 버전", async () => {
    const s = server({
      "GET /stages/research/rounds/2": { status: 200, body: ok(roundData()) },
      "POST /question-sets/qset-9/order": { status: 201, body: ok({ set: { id: "qset-10", version_no: 5, form_key: "main" }, members: [] }, { receipt: RECEIPT }) },
    });
    const out = await (await make(s)).reorderQuestions(SLUG, ED, "research", "2", ["qst-3", "qst-1", "qst-2"], "k-ord");
    const w = s.writes();
    expect(w).toHaveLength(1);
    expect(w[0]!.headers.get("idempotency-key")).toBe("k-ord");
    expect(w[0]!.headers.get("x-pes-session")).toBe(SESSION);
    expect(w[0]!.json).toMatchObject({ format_version: "1.0", question_ids: ["qst-3", "qst-1", "qst-2"] });
    expect(out.data).toEqual({ form_version: 5 });
    expect(out.receipt).toMatchObject({ receipt_no: "0123", tx_id: "tx-98", idempotency_key: "k-ord", replayed: false });
  });

  it("거절(옛 세트 409 · 순열 아님 422)은 PesApiError 로 보존하고, 키가 없으면 요청 없이 invalid_payload, 라운드가 없으면 쓰기 0", async () => {
    const stale = server({ "GET /stages/research/rounds/2": { status: 200, body: ok(roundData()) }, "POST /question-sets/qset-9/order": { status: 409, body: fail("conflict") } });
    const e = await (await make(stale)).reorderQuestions(SLUG, ED, "research", "2", ["qst-1"], "k").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PesApiError);
    expect((e as PesApiError).body.error.code).toBe("conflict");
    const none = server({});
    const nokey = await (await make(none)).reorderQuestions(SLUG, ED, "research", "2", ["qst-1"], undefined).catch((x: unknown) => x);
    expect((nokey as PesApiError).body.error.code).toBe("invalid_payload");
    expect(none.seen).toHaveLength(0);
    const gone = server({});
    const e2 = await (await make(gone)).reorderQuestions(SLUG, ED, "research", "2", ["qst-1"], "k").catch((x: unknown) => x);
    expect(e2).toBeInstanceOf(PesApiError);
    expect(gone.writes()).toHaveLength(0);
  });
});

describe("번호 라운드에 질문 더하기 · ask_ai", () => {
  it("addQuestion(번호 라운드): 라운드 읽기의 server_round_id 를 POST P/questions 의 round_id 로 보낸다", async () => {
    const s = server({
      "GET /stages/research/rounds/2": { status: 200, body: ok(roundData()) },
      "GET /context": { status: 200, body: CONTEXT },
      "POST /questions": { status: 201, body: ok({ question_set_id: "qset-11", question: { id: "qst-9", version_id: "qvr-9", version_no: "1", state: "open" } }, { receipt: RECEIPT }) },
    });
    const out = await (await make(s)).addQuestion(SLUG, ED, "research", "2", { text: "새 질문", kind: "free_text", options: [], importance: "normal", required: false, default_value: null, show_if: null, direction: "ask_human" }, "k-add2");
    const w = s.writes();
    expect(w).toHaveLength(1);
    expect(w[0]!.json).toMatchObject({ stage_id: "stg-research", round_id: "rnd-2", form_key: "main", direction: "agent_to_human", question: { text: "새 질문", type: "text" } });
    expect(["stage_start", "review", "resume"]).toContain(w[0]!.json!.purpose);
    expect(out.data).toEqual({ question_id: "qst-9", version: 1 });
  });

  it("[회귀] 없는 번호 라운드는 쓰기 0 으로 거절한다(지어낸 round_id 를 보내지 않는다)", async () => {
    const s = server({ "GET /context": { status: 200, body: CONTEXT } });
    const e = await (await make(s)).addQuestion(SLUG, ED, "research", "7", { text: "x", kind: "free_text", options: [], importance: null, required: false, default_value: null, show_if: null, direction: "ask_human" }, "k").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Error);
    expect(s.writes()).toHaveLength(0);
  });

  it("[회귀] ask_ai 는 서버가 계속 받지 않는다 → addQuestion · reviseQuestion 모두 요청 없이 NotConnectedError", async () => {
    const s = server({});
    const c = await make(s);
    const body = { text: "AI 에게", kind: "free_text", options: [], importance: "normal", required: false, default_value: null, show_if: null, direction: "ask_ai" };
    await expect(c.addQuestion(SLUG, ED, "research", "start", body, "k1")).rejects.toBeInstanceOf(NotConnectedError);
    await expect(c.addQuestion(SLUG, ED, "research", "2", body, "k2")).rejects.toBeInstanceOf(NotConnectedError);
    await expect(c.reviseQuestion(SLUG, ED, "qst-1", { ...body, base_version: 1, base_version_id: "qvr-1" }, "k3")).rejects.toBeInstanceOf(NotConnectedError);
    expect(s.seen).toHaveLength(0);
  });
});

describe("쓰기 응답의 영수증 — 추가 조회 없음", () => {
  const writes: { name: string; routes: Record<string, { status: number; body: unknown }>; run: (c: C) => W }[] = [
    { name: "withdraw", routes: { "POST /questions/qst-1/withdraw": { status: 201, body: ok({ question: { id: "qst-1", state: "withdrawn" } }, { receipt: RECEIPT }) } }, run: (c) => c.withdrawQuestion(SLUG, ED, "qst-1", "k-w") },
    {
      name: "submit",
      routes: { "POST /submissions": { status: 201, body: ok({ submission: { id: "sub-1" }, answers: [], form_complete: false, missing_required: [] }, { receipt: RECEIPT }) } },
      run: (c) => c.submitAnswers(SLUG, ED, "research", "2", { mode: "single", form_version: 1, set_id: "qset-9", answers: [{ question_id: "qst-1", question_version: 1, value: "a" }] }, "k-w"),
    },
    {
      name: "comment",
      routes: { "POST /threads": { status: 201, body: ok({ thread: { id: "th-1" }, message: { id: "m-1" } }, { receipt: RECEIPT }) } },
      run: (c) => c.addComment(SLUG, ED, "qst-1", { body_md: "의견" }, "k-w"),
    },
  ];
  it.each(writes)("$name: body.receipt 가 Receipt 가 되고 GET P/requests/{key} 는 부르지 않는다 (번호는 서버 글 그대로, numbered:false 아님)", async ({ routes, run }) => {
    const s = server(routes);
    const out = await run(await make(s));
    expect(s.gets("/requests/")).toHaveLength(0);
    expect(s.seen).toHaveLength(1);
    expect(out.receipt).toMatchObject({ receipt_no: "0123", tx_id: "tx-98", committed_at: "2026-11-12T09:30:00+09:00", idempotency_key: "k-w", replayed: false });
    expect("numbered" in out.receipt).toBe(false);
  });

  it("재생(replayed:true)이면 receipt.replayed 가 true 이고 영수증 값은 서버 것 그대로", async () => {
    const s = server({ "POST /questions/qst-1/withdraw": { status: 201, body: ok({ question: { id: "qst-1", state: "withdrawn" } }, { receipt: RECEIPT, replayed: true }) } });
    const out = await (await make(s)).withdrawQuestion(SLUG, ED, "qst-1", "k-w");
    expect(out.receipt).toMatchObject({ receipt_no: "0123", tx_id: "tx-98", replayed: true });
    expect(s.gets("/requests/")).toHaveLength(0);
  });
});

describe("판(edition) 확인 — 라운드 경로는 서버의 활성 판을 읽으므로, 앱이 보는 판과 다르면 그 자료를 쓰지 않는다 (SEL-98 1차 리뷰 필수 1)", () => {
  const NEXT = ED + 1;
  const sameEdition = { "GET /stages/research/rounds/2": { status: 200, body: ok(roundData({ edition: ED })) } };
  const newerEdition = { "GET /stages/research/rounds/2": { status: 200, body: ok(roundData({ edition: NEXT })) } };

  it("getRound: 판 번호가 같으면 그대로, 다르면 null (활성 판 자료를 옛 판 화면에 얹지 않는다)", async () => {
    const same = await (await make(server(sameEdition))).getRound(SLUG, ED, "research", "2");
    expect(same).toMatchObject({ round_id: 2, set_id: "qset-9" });
    expect(await (await make(server(newerEdition))).getRound(SLUG, ED, "research", "2")).toBeNull();
  });

  it("getComments: 응답 판이 다르면 빈 목록, 같으면 그대로", async () => {
    const threads = [{ thread_id: "th-1", question_id: "qst-1", question_version_id: "qvr-1b", question_version: 2, messages: [] }];
    const route = (edition: number) => ({ "GET /stages/research/rounds/2/threads": { status: 200, body: ok({ edition, threads }) } });
    expect(await (await make(server(route(ED)))).getComments(SLUG, ED, "research", "2")).toHaveLength(1);
    expect(await (await make(server(route(NEXT)))).getComments(SLUG, ED, "research", "2")).toEqual([]);
  });

  it("reorderQuestions: 판이 다르면 쓰기 0 으로 거절(그 세트 id 로 새 판에 쓰지 않는다), 같으면 보낸다", async () => {
    const order = { "POST /question-sets/qset-9/order": { status: 201, body: ok({ set: { id: "qset-10", version_no: 5, form_key: "main" }, members: [] }, { receipt: RECEIPT }) } };
    const ok1 = server({ ...sameEdition, ...order });
    await (await make(ok1)).reorderQuestions(SLUG, ED, "research", "2", ["qst-1"], "k-ed1");
    expect(ok1.writes()).toHaveLength(1);
    const bad = server({ ...newerEdition, ...order });
    const e = await (await make(bad)).reorderQuestions(SLUG, ED, "research", "2", ["qst-1"], "k-ed2").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PesApiError);
    expect(bad.writes()).toHaveLength(0);
  });

  it("addQuestion(번호 라운드): 판이 다르면 쓰기 0 으로 거절(새 판의 server_round_id 를 쓰지 않는다)", async () => {
    const spec = { text: "새 질문", kind: "free_text", options: [], importance: "normal", required: false, default_value: null, show_if: null, direction: "ask_human" };
    const add = { "GET /context": { status: 200, body: CONTEXT }, "POST /questions": { status: 201, body: ok({ question_set_id: "qset-11", question: { id: "qst-9", version_id: "qvr-9", version_no: "1", state: "open" } }, { receipt: RECEIPT }) } };
    const same = server({ ...sameEdition, ...add });
    await (await make(same)).addQuestion(SLUG, ED, "research", "2", spec, "k-ed3");
    expect(same.writes()).toHaveLength(1);
    const bad = server({ ...newerEdition, ...add });
    const e = await (await make(bad)).addQuestion(SLUG, ED, "research", "2", spec, "k-ed4").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PesApiError);
    expect(bad.writes()).toHaveLength(0);
  });
});

describe("1차 리뷰 권장 — 질문 더하기 purpose · 순서 바꾸기 재시도 메모", () => {
  const spec = { text: "새 질문", kind: "free_text", options: [], importance: "normal", required: false, default_value: null, show_if: null, direction: "ask_human" };
  const added = { status: 201, body: ok({ question_set_id: "qset-11", question: { id: "qst-9", version_id: "qvr-9", version_no: "1", state: "open" } }, { receipt: RECEIPT }) };

  it("번호 라운드 질문 더하기는 purpose review, 단계 시작 자리는 stage_start", async () => {
    const numbered = server({ "GET /stages/research/rounds/2": { status: 200, body: ok(roundData()) }, "GET /context": { status: 200, body: CONTEXT }, "POST /questions": added });
    await (await make(numbered)).addQuestion(SLUG, ED, "research", "2", spec, "k-p1");
    expect(numbered.writes()[0]!.json).toMatchObject({ purpose: "review", round_id: "rnd-2" });
    const start = server({ "GET /workspace": { status: 200, body: ok({ edition: ED }) }, "GET /context": { status: 200, body: CONTEXT }, "POST /questions": added });
    await (await make(start)).addQuestion(SLUG, ED, "research", "start", spec, "k-p2");
    expect(start.writes()[0]!.json).toMatchObject({ purpose: "stage_start", round_id: null });
  });

  it("순서 바꾸기: 서버가 확정적으로 거절(409 stale_set)하면 같은 키로 다시 눌러도 세트 id 를 새로 읽는다 (옛 세트로 영영 거절되지 않는다)", async () => {
    let round = 0;
    const s = server({
      "GET /stages/research/rounds/2": () => ({ status: 200, body: ok(roundData({ set_id: round++ === 0 ? "qset-old" : "qset-new" })) }),
      "POST /question-sets/qset-old/order": { status: 409, body: fail("conflict") },
      "POST /question-sets/qset-new/order": { status: 201, body: ok({ set: { id: "qset-n2", version_no: 6, form_key: "main" }, members: [] }, { receipt: RECEIPT }) },
    });
    const c = await make(s);
    const e = await c.reorderQuestions(SLUG, ED, "research", "2", ["qst-1"], "k-same").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PesApiError);
    const out = await c.reorderQuestions(SLUG, ED, "research", "2", ["qst-1"], "k-same");
    expect(out.data).toEqual({ form_version: 6 });
    expect(s.writes().map((w) => w.url.pathname.replace(P, ""))).toEqual(["/question-sets/qset-old/order", "/question-sets/qset-new/order"]);
  });

  it("순서 바꾸기: 시간 초과(확인 중)면 같은 키 재시도가 처음 알아낸 세트 id 를 그대로 쓴다", async () => {
    let posts = 0;
    let reads = 0;
    const s = server({
      "GET /stages/research/rounds/2": () => ({ status: 200, body: ok(roundData({ set_id: reads++ === 0 ? "qset-9" : "qset-moved" })) }),
      "POST /question-sets/qset-9/order": () => {
        posts += 1;
        if (posts === 1) throw new TypeError("network");
        return { status: 201, body: ok({ set: { id: "qset-10", version_no: 5, form_key: "main" }, members: [] }, { receipt: RECEIPT, replayed: true }) };
      },
    });
    const c = await make(s);
    await c.reorderQuestions(SLUG, ED, "research", "2", ["qst-1"], "k-net").catch(() => undefined);
    const out = await c.reorderQuestions(SLUG, ED, "research", "2", ["qst-1"], "k-net");
    expect(out.receipt.replayed).toBe(true);
    expect(s.gets("/rounds/2")).toHaveLength(1);
  });
});
