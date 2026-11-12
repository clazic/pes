// SEL-92 U2c 최종 리뷰 2/2(CHANGES) 수정 — http 클라이언트 질문 고치기(revisions) (Vitest, jsdom, fetch 가짜).
// 필수 3: 선택형 → free_text 로 바꾸는 수정은 options:[] 를 명시해 서버의 옛 선택지를 지운다(수정은 부분 수정이라 키가 없으면 옛 값이 남는다).
//         새 질문 생성(addQuestion)은 그대로 options 를 싣지 않는다.
import { describe, expect, it, vi } from "vitest";
import { WORKSPACE } from "@/api/fixture";
import { FORMAT_VERSION, type PesClient, type QuestionRevision } from "@/api/types";

type Opts = { session: string; projects: Record<string, string>; baseUrl?: string; fetch?: typeof fetch; timeoutMs?: number };
const modules = import.meta.glob<{ createHttpClient: (o: Opts) => PesClient }>("/src/api/http-client.{ts,tsx}");
const load = async () => {
  const loader = Object.values(modules)[0];
  if (!loader) throw new Error("src/api/http-client.ts 가 없다");
  return (await loader()).createHttpClient;
};

const ID = "pj-synthetic-1";
const SLUG = WORKSPACE.slug;
const ED = WORKSPACE.edition;
const P = `/api/v1/projects/${ID}`;
const ok = (data: unknown) => ({ format_version: FORMAT_VERSION, request_id: "req-1", data });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const revised = ok({ question: { id: "qst-1", version_id: "v3", version_no: "3", state: "open" }, recheck_required: false });
const reqRead = ok({ key: "k", state: "completed", action: "question.revised", status: 200, tx_id: "5d2e1c0a-7b3f-4e21-9a55-0f2b3c4d5e06", run_id: null, receipt_no: "0007" });

function setup() {
  const seen: { method: string; path: string; body: Record<string, unknown> | null }[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://app.invalid");
    const method = (init?.method ?? "GET").toUpperCase();
    seen.push({ method, path: url.pathname.replace(P, ""), body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null });
    if (method === "POST") return json(201, revised);
    return url.pathname.includes("/requests/") ? json(200, reqRead) : json(404, {});
  });
  return { impl: impl as unknown as typeof fetch, seen, posts: () => seen.filter((s) => s.method === "POST") };
}
const make = async (f: ReturnType<typeof setup>) => (await load())({ session: "s", projects: { [SLUG]: ID }, fetch: f.impl });

const base = (over: Partial<QuestionRevision> = {}): QuestionRevision => ({
  text: "범위를 어디까지 잡을까요?",
  kind: "free_text",
  options: [],
  importance: "normal",
  required: true,
  default_value: null,
  show_if: null,
  help: null,
  direction: "ask_human",
  base_version: 2,
  base_version_id: "synthetic-v2",
  ...over,
});

describe("질문 고치기 — 선택형을 글로 바꾸면 옛 선택지를 지운다 (필수 3)", () => {
  it("free_text 로 고치면 type text + options:[] 를 명시해 보낸다(키를 빼지 않는다)", async () => {
    const f = setup();
    await (await make(f)).reviseQuestion(SLUG, ED, "qst-1", base(), "k1");
    const [post] = f.posts();
    expect(post.path).toBe("/questions/qst-1/revisions");
    const question = post.body?.question as Record<string, unknown>;
    expect(question.type).toBe("text");
    expect(Object.prototype.hasOwnProperty.call(question, "options"), "options 키").toBe(true);
    expect(question.options).toEqual([]);
  });

  it("선택형으로 고치면 선택지를 그대로 보낸다", async () => {
    const f = setup();
    await (await make(f)).reviseQuestion(SLUG, ED, "qst-1", base({ kind: "single_choice", options: [{ id: "yes", label: "예" }, { id: "no", label: "아니오" }] }), "k2");
    const question = f.posts()[0].body?.question as Record<string, unknown>;
    expect(question.type).toBe("single");
    expect(question.options).toEqual([{ value: "yes", label: "예" }, { value: "no", label: "아니오" }]);
  });

  it("질문을 새로 더할 때(addQuestion)는 글 질문에 options 키를 싣지 않는다(기존 동작 그대로)", async () => {
    const f = setup();
    const ctx = ok({ stages: [{ key: "plan", stage_id: "stg-1" }] });
    const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://app.invalid");
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET" && url.pathname.endsWith("/context")) return json(200, ctx);
      if (method === "GET" && url.pathname.endsWith("/workspace")) return json(200, ok({ edition: ED }));
      return f.impl(input, init);
    });
    const client = (await load())({ session: "s", projects: { [SLUG]: ID }, fetch: impl as unknown as typeof fetch });
    await client.addQuestion(SLUG, ED, "plan", "start", { ...base(), base_version: undefined, base_version_id: undefined } as never, "k3");
    const question = f.posts()[0]?.body?.question as Record<string, unknown> | undefined;
    expect(question).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(question, "options")).toBe(false);
  });
});
