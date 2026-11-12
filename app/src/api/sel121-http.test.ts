// SEL-121 — SEL-98 리뷰 후속 (Vitest, fetch 는 가짜). 기존 시험 파일의 단언은 바꾸지 않고, 여기서 새 경계만 확인한다.
//  1. addQuestion 시작 자리(start): 요청한 판과 서버 활성 판이 다르면 PesApiError 404, 쓰기 0 (번호 라운드와 같은 규칙)
//  2. reorderQuestions 메모: 확정 거절(4xx, 429 제외)만 지우고, 5xx · 429 · 시간 초과 · 끊김은 같은 세트 id 를 보존한다

import { describe, expect, it, vi } from "vitest";
import { WORKSPACE } from "@/api/fixture";
import { FORMAT_VERSION, PesApiError, type PesClient } from "@/api/types";

type Opts = { session: string; projects: Record<string, string>; baseUrl?: string; fetch?: typeof fetch };
const modules = import.meta.glob<{ createHttpClient: (o: Opts) => PesClient }>("/src/api/http-client.{ts,tsx}");
const load = async () => {
  const loader = Object.values(modules)[0];
  if (!loader) throw new Error("src/api/http-client.ts 가 없다");
  return (await loader()).createHttpClient;
};
type W = Promise<{ data: Record<string, unknown>; receipt: Record<string, unknown> }>;
type C = {
  addQuestion(slug: string, edition: number, stage: string, round: string, body: Record<string, unknown>, key: string | undefined): W;
  reorderQuestions(slug: string, edition: number, stage: string, round: string, ids: string[], key: string | undefined): W;
};

const SESSION = "synthetic-session-sel121";
const ID = "pj-synthetic-121";
const SLUG = WORKSPACE.slug;
const ED = WORKSPACE.edition;
const NEXT = ED + 1;
const P = `/api/v1/projects/${ID}`;
const ok = (data: unknown, extra: Record<string, unknown> = {}) => ({ format_version: FORMAT_VERSION, request_id: "req-1", data, ...extra });
const fail = (code: string, retryable = false) => ({ format_version: FORMAT_VERSION, request_id: "req-e", error: { code, message: "합성 거절", retryable, target: null, details: null, next_action: "reread_context" } });
const RECEIPT = { receipt_no: "0123", tx_id: "tx-121", committed_at: "2026-11-12T09:30:00+09:00" };
const CONTEXT = ok({ project_id: ID, stages: [{ stage_id: "stg-plan", key: "plan" }, { stage_id: "stg-research", key: "research" }] });
const SPEC = { text: "새 질문", kind: "free_text", options: [], importance: "normal", required: false, default_value: null, show_if: null, direction: "ask_human" };
const ADDED = { status: 201, body: ok({ question_set_id: "qset-11", question: { id: "qst-9", version_id: "qvr-9", version_no: "1", state: "open" } }, { receipt: RECEIPT }) };

interface Seen {
  url: URL;
  method: string;
  headers: Headers;
  json: Record<string, any> | null;
}
type Route = { status: number; body: unknown } | ((s: Seen) => { status: number; body: unknown });
function server(routes: Record<string, Route>) {
  const seen: Seen[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input), "http://app.invalid");
    const s: Seen = { url, method: (init?.method ?? "GET").toUpperCase(), headers: new Headers(init?.headers), json: typeof init?.body === "string" ? JSON.parse(init.body) : null };
    seen.push(s);
    const hit = routes[`${s.method} ${url.pathname.replace(P, "")}`];
    const r = typeof hit === "function" ? hit(s) : (hit ?? { status: 404, body: fail("not_found") });
    return new Response(JSON.stringify(r.body), { status: r.status });
  });
  return {
    impl: impl as unknown as typeof fetch,
    seen,
    writes: () => seen.filter((s) => s.method === "POST"),
    gets: (part: string) => seen.filter((s) => s.method === "GET" && s.url.pathname.includes(part)),
  };
}
const make = async (s: ReturnType<typeof server>) => (await load())({ session: SESSION, projects: { [SLUG]: ID }, fetch: s.impl }) as unknown as C;

const roundData = (extra: Record<string, unknown> = {}) => ({ stage: "research", round_id: 2, server_round_id: "rnd-2", state: "current", set_id: "qset-9", form_version: 4, questions: [], ...extra });

describe("[SEL-121 1] addQuestion 시작 자리 — 판(edition) 확인 (번호 라운드와 같은 규칙)", () => {
  it("요청한 판과 서버 활성 판이 다르면 PesApiError 404, 쓰기 0 (옛 판 화면에서 새 판에 질문을 더하지 않는다)", async () => {
    const s = server({
      "GET /stages/research/rounds/start": { status: 200, body: ok(roundData({ round_id: null, server_round_id: null, set_id: null, edition: NEXT })) },
      "GET /context": { status: 200, body: CONTEXT },
      "POST /questions": ADDED,
    });
    const e = await (await make(s)).addQuestion(SLUG, ED, "research", "start", SPEC, "k-start-ed").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PesApiError);
    expect((e as PesApiError).body.error.code).toBe("not_found");
    expect(s.writes()).toHaveLength(0);
  });

  it("판이 같으면 한 번 쓴다 (round_id null · purpose stage_start 는 그대로)", async () => {
    const s = server({
      "GET /stages/research/rounds/start": { status: 200, body: ok(roundData({ round_id: null, server_round_id: null, set_id: null, edition: ED })) },
      "GET /context": { status: 200, body: CONTEXT },
      "POST /questions": ADDED,
    });
    await (await make(s)).addQuestion(SLUG, ED, "research", "start", SPEC, "k-start-same");
    expect(s.writes()).toHaveLength(1);
    expect(s.writes()[0]!.json).toMatchObject({ purpose: "stage_start", round_id: null, stage_id: "stg-research" });
  });

  it("시작 자리 읽기가 404 면 판을 가릴 자료가 없으니 예전처럼 쓴다 (round_id 는 보내지 않으므로 지어내는 값이 없다)", async () => {
    const s = server({ "GET /context": { status: 200, body: CONTEXT }, "POST /questions": ADDED });
    await (await make(s)).addQuestion(SLUG, ED, "research", "start", SPEC, "k-start-404");
    expect(s.writes()).toHaveLength(1);
  });
});

describe("[SEL-121 2] reorderQuestions 메모 — 확정 거절만 지우고, 처리 여부 불명은 보존", () => {
  const roundRoute = (set: () => string) => ({ "GET /stages/research/rounds/2": () => ({ status: 200, body: ok(roundData({ set_id: set(), edition: ED })) }) });
  const ORDER_OK = { status: 201, body: ok({ set: { id: "qset-10", version_no: 5, form_key: "main" }, members: [] }, { receipt: RECEIPT }) };

  it.each([
    ["500 내부 오류", 500, fail("internal_error", true)],
    ["503 잠시 불가", 503, fail("unavailable", true)],
    ["429 너무 많은 요청", 429, fail("rate_limited", true)],
  ])("%s 이면 같은 키 재시도가 처음 알아낸 세트 id(qset-old)를 그대로 쓴다 — 라운드를 다시 읽지 않는다", async (_name, status, body) => {
    let reads = 0;
    let posts = 0;
    const s = server({
      ...roundRoute(() => (reads++ === 0 ? "qset-old" : "qset-new")),
      // 첫 요청은 처리 여부 불명 오류, 같은 키 재시도는 처리된 것으로 응답한다
      "POST /question-sets/qset-old/order": () => (posts++ === 0 ? { status, body } : ORDER_OK),
      "POST /question-sets/qset-new/order": ORDER_OK,
    });
    const c = await make(s);
    const e = await c.reorderQuestions(SLUG, ED, "research", "2", ["qst-1"], "k-keep").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PesApiError);
    await c.reorderQuestions(SLUG, ED, "research", "2", ["qst-1"], "k-keep");
    expect(s.writes().map((w) => w.url.pathname.replace(P, ""))).toEqual(["/question-sets/qset-old/order", "/question-sets/qset-old/order"]);
    expect(s.gets("/rounds/2")).toHaveLength(1);
  });

  it("409 확정 거절이면 메모를 지워, 같은 키로 다시 누르면 세트 id 를 새로 읽는다 (기존 동작 그대로)", async () => {
    let reads = 0;
    const s = server({
      ...roundRoute(() => (reads++ === 0 ? "qset-old" : "qset-new")),
      "POST /question-sets/qset-old/order": { status: 409, body: fail("conflict") },
      "POST /question-sets/qset-new/order": ORDER_OK,
    });
    const c = await make(s);
    await c.reorderQuestions(SLUG, ED, "research", "2", ["qst-1"], "k-clear").catch(() => undefined);
    await c.reorderQuestions(SLUG, ED, "research", "2", ["qst-1"], "k-clear");
    expect(s.writes().map((w) => w.url.pathname.replace(P, ""))).toEqual(["/question-sets/qset-old/order", "/question-sets/qset-new/order"]);
  });
});
