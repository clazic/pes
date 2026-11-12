// SEL-129 — http 클라이언트가 서버 show_if {id, in:[a,b]} 의 모든 값을 읽고 쓴다 (Vitest, fetch 는 가짜, 합성 값만).
// 정한 인터페이스: src/api/sel129-show-if.test.ts 머리말 (ShowIf = {question_id, in: string[]} · QuestionView.show_if_unsupported · QuestionInput.show_if_unsupported).
//  읽기(getRound): raw.show_if {id, in:[…]} → show_if {question_id, in:[…모든 값]}. 앱이 못 다루는 모양이면 show_if_unsupported true.
//                  없는/null 이면 show_if null 이고 show_if_unsupported 는 true 가 아니다.
//  쓰기(addQuestion · reviseQuestion): show_if {question_id, in:[…]} → question.show_if {id, in:[…모든 값]} (값 하나로 줄이지 않는다).
//                  revise 에서 show_if null → show_if:null (지움). show_if_unsupported true 면 show_if 키를 싣지 않는다(서버의 모르는 조건을 건드리지 않는다). add 도 키를 싣지 않는다.
import { describe, expect, it, vi } from "vitest";
import { WORKSPACE } from "@/api/fixture";
import { FORMAT_VERSION, type PesClient } from "@/api/types";

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
  addQuestion(slug: string, edition: number, stage: string, round: string, body: Record<string, unknown>, key: string | undefined): W;
  reviseQuestion(slug: string, edition: number, id: string, body: Record<string, unknown>, key: string | undefined): W;
};

const SESSION = "synthetic-session-sel129";
const ID = "pj-synthetic-129";
const SLUG = WORKSPACE.slug;
const ED = WORKSPACE.edition;
const P = `/api/v1/projects/${ID}`;
const ok = (data: unknown, extra: Record<string, unknown> = {}) => ({ format_version: FORMAT_VERSION, request_id: "req-1", data, ...extra });
const RECEIPT = { receipt_no: "0129", tx_id: "tx-129", committed_at: "2026-11-13T09:30:00+09:00" };
const CONTEXT = ok({ project_id: ID, edition: { edition_no: String(ED) }, stages: [{ stage_id: "stg-plan", key: "plan" }, { stage_id: "stg-research", key: "research" }] });

interface Seen {
  url: URL;
  method: string;
  json: Record<string, any> | null;
}
function server(routes: Record<string, { status: number; body: unknown }>) {
  const seen: Seen[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input), "http://app.invalid");
    const s: Seen = { url, method: (init?.method ?? "GET").toUpperCase(), json: typeof init?.body === "string" ? JSON.parse(init.body) : null };
    seen.push(s);
    const r = routes[`${s.method} ${url.pathname.replace(P, "")}`] ?? { status: 404, body: { format_version: FORMAT_VERSION, request_id: "e", error: { code: "not_found", message: "x", retryable: false, target: null, details: null, next_action: "reread_context" } } };
    return new Response(JSON.stringify(r.body), { status: r.status });
  });
  return { impl: impl as unknown as typeof fetch, writes: () => seen.filter((s) => s.method === "POST") };
}
const make = async (s: ReturnType<typeof server>) => (await load())({ session: SESSION, projects: { [SLUG]: ID }, fetch: s.impl }) as unknown as C;

const qraw = (id: string, no: number, show_if: unknown, extra: Record<string, unknown> = {}) => ({
  id,
  version_id: `qvr-${id}`,
  version_no: "1",
  display_no: String(no),
  type: "single",
  state: "open",
  required: true,
  text: "합성 질문",
  options: [{ value: "a", label: "가" }, { value: "b", label: "나" }, { value: "c", label: "다" }],
  ...(show_if === undefined ? {} : { show_if }),
  ...extra,
});
const roundOf = (questions: unknown[]) => ({ stage: "research", round_id: 2, server_round_id: "rnd-2", state: "current", set_id: "qset-9", form_version: 4, questions });
const read = async (questions: unknown[]) => {
  const s = server({ "GET /stages/research/rounds/2": { status: 200, body: ok(roundOf(questions)) } });
  return (await (await make(s)).getRound(SLUG, ED, "research", "2"))!.questions as Record<string, any>[];
};

describe("[SEL-129] getRound — 서버 조건의 모든 값을 읽는다", () => {
  it("in:[a,b,c] → show_if.in 이 [a,b,c] (첫 값만 쓰지 않는다)", async () => {
    const [q] = await read([qraw("qst-2", 22, { id: "qst-1", in: ["a", "b", "c"] })]);
    expect(q!.show_if).toEqual({ question_id: "qst-1", in: ["a", "b", "c"] });
    expect(q!.show_if_unsupported).not.toBe(true);
    expect("equals" in q!.show_if).toBe(false);
  });

  it("in:[a] 도 배열 하나 (equals 가 아니라 in)", async () => {
    const [q] = await read([qraw("qst-2", 22, { id: "qst-1", in: ["a"] })]);
    expect(q!.show_if).toEqual({ question_id: "qst-1", in: ["a"] });
  });

  it("in:[] 은 빈 배열 그대로 (지원하는 모양 — 항상 숨김)", async () => {
    const [q] = await read([qraw("qst-2", 22, { id: "qst-1", in: [] })]);
    expect(q!.show_if).toEqual({ question_id: "qst-1", in: [] });
    expect(q!.show_if_unsupported).not.toBe(true);
  });

  it("조건 없음(null · 키 없음)은 show_if null 이고 지원 안 함이 아니다", async () => {
    const qs = await read([qraw("qst-1", 21, null), qraw("qst-2", 22, undefined)]);
    for (const q of qs) {
      expect(q.show_if).toBeNull();
      expect(q.show_if_unsupported).not.toBe(true);
    }
  });

  it.each([
    ["in 이 문자열", { id: "qst-1", in: "a" }],
    ["id 없음", { in: ["a"] }],
    ["문자열 조건", "a"],
    ["배열 조건", ["a"]],
  ])("앱이 못 다루는 모양(%s): show_if null + show_if_unsupported true — 조용히 값을 지어내지 않는다", async (_n, raw) => {
    const [q] = await read([qraw("qst-2", 22, raw)]);
    expect(q!.show_if).toBeNull();
    expect(q!.show_if_unsupported).toBe(true);
  });

  it("in 에 문자열 아닌 값이 섞이면 문자열 항목만 남기고 지원 안 함으로 표시한다", async () => {
    const [q] = await read([qraw("qst-2", 22, { id: "qst-1", in: ["a", 1, "b"] })]);
    expect(q!.show_if).toEqual({ question_id: "qst-1", in: ["a", "b"] });
    expect(q!.show_if_unsupported).toBe(true);
  });

  it("모르는 키가 더 있어도 id · in 은 읽고 지원 안 함으로 표시한다", async () => {
    const [q] = await read([qraw("qst-2", 22, { id: "qst-1", in: ["a"], not: ["b"] })]);
    expect(q!.show_if).toEqual({ question_id: "qst-1", in: ["a"] });
    expect(q!.show_if_unsupported).toBe(true);
  });

  it("한 라운드 안에서 질문마다 따로 판단한다 (하나가 지원 안 해도 다른 질문은 그대로)", async () => {
    const qs = await read([qraw("qst-2", 22, { id: "qst-1", in: ["a", "b"] }), qraw("qst-3", 23, "x"), qraw("qst-4", 24, { id: "qst-1", in: ["c"] })]);
    expect(qs.map((q) => [q.show_if, q.show_if_unsupported === true])).toEqual([[{ question_id: "qst-1", in: ["a", "b"] }, false], [null, true], [{ question_id: "qst-1", in: ["c"] }, false]]);
  });
});

const BASE = { text: "조건 질문", kind: "free_text", options: [], importance: "normal", required: false, default_value: null, help: null, direction: "ask_human" };

describe("[SEL-129] 쓰기 — 모든 값을 {id, in} 으로 보낸다", () => {
  it("addQuestion: show_if {question_id, in:[a,b]} → question.show_if {id, in:[a,b]}", async () => {
    const s = server({
      "GET /stages/research/rounds/2": { status: 200, body: ok(roundOf([])) },
      "GET /context": { status: 200, body: CONTEXT },
      "POST /questions": { status: 201, body: ok({ question_set_id: "qset-2", question: { id: "qst-9", version_id: "qvr-9", version_no: "1", state: "open" } }, { receipt: RECEIPT }) },
    });
    await (await make(s)).addQuestion(SLUG, ED, "research", "2", { ...BASE, show_if: { question_id: "qst-1", in: ["a", "b"] } }, "k-add");
    expect(s.writes()[0]!.json!.question.show_if).toEqual({ id: "qst-1", in: ["a", "b"] });
  });

  it("addQuestion: show_if null 이면 키를 싣지 않는다 (지금 규칙 그대로)", async () => {
    const s = server({
      "GET /stages/research/rounds/2": { status: 200, body: ok(roundOf([])) },
      "GET /context": { status: 200, body: CONTEXT },
      "POST /questions": { status: 201, body: ok({ question_set_id: "qset-2", question: { id: "qst-9", version_id: "qvr-9", version_no: "1", state: "open" } }, { receipt: RECEIPT }) },
    });
    await (await make(s)).addQuestion(SLUG, ED, "research", "2", { ...BASE, show_if: null }, "k-add");
    expect(s.writes()[0]!.json!.question).not.toHaveProperty("show_if");
  });

  const revise = async (body: Record<string, unknown>) => {
    const s = server({ "POST /questions/qst-2/revisions": { status: 201, body: ok({ question: { id: "qst-2", version_id: "qvr-2b", version_no: "2", state: "open" }, recheck_required: false }, { receipt: RECEIPT }) } });
    await (await make(s)).reviseQuestion(SLUG, ED, "qst-2", { ...BASE, base_version: 1, base_version_id: "qvr-2a", ...body }, "k-rev");
    return s.writes()[0]!.json!.question as Record<string, unknown>;
  };

  it("reviseQuestion: 여러 값 조건이 그대로 간다", async () => {
    expect((await revise({ show_if: { question_id: "qst-1", in: ["a", "b", "c"] } })).show_if).toEqual({ id: "qst-1", in: ["a", "b", "c"] });
  });

  it("reviseQuestion: 조건을 비우면 show_if:null 로 지운다 (지금 규칙 그대로)", async () => {
    expect(await revise({ show_if: null })).toHaveProperty("show_if", null);
  });

  it("reviseQuestion: 지원 안 하는 조건(show_if_unsupported)은 show_if 키를 싣지 않는다 — 서버의 조건을 null 로 지우지 않는다", async () => {
    expect(await revise({ show_if: null, show_if_unsupported: true })).not.toHaveProperty("show_if");
  });

  it("reviseQuestion: 지원 안 하는 조건이어도 다른 칸(문장)은 그대로 간다", async () => {
    const q = await revise({ text: "고친 문장", show_if: null, show_if_unsupported: true });
    expect(q.text).toBe("고친 문장");
    expect(q).not.toHaveProperty("show_if");
  });
});
