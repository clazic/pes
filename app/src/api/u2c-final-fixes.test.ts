// SEL-92 U2c 최종 리뷰 1/2(CHANGES) 수정 — http 클라이언트 질문 고치기(revisions) (Vitest, jsdom, fetch 가짜).
// 필수 3: 지우기는 명시적 null 로 보낸다(키를 빼면 서버가 옛 값을 유지) · 서버가 표현 못 하는 변경은 요청 없이 거절.
// 필수 4: ask_ai 방향은 요청 없이 정직 거절(addQuestion 과 같게).
import { describe, expect, it, vi } from "vitest";
import { WORKSPACE } from "@/api/fixture";
import { FORMAT_VERSION, NotConnectedError, type PesClient, type QuestionRevision } from "@/api/types";

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
  kind: "single_choice",
  options: [
    { id: "yes", label: "예" },
    { id: "no", label: "아니오" },
  ],
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

describe("질문 고치기 — 지우기는 명시적 null (필수 3)", () => {
  it("기본값 · 조건 · 도움말을 비우면 세 키를 null 로 보낸다(키를 빼지 않는다)", async () => {
    const f = setup();
    await (await make(f)).reviseQuestion(SLUG, ED, "qst-1", base(), "k1");
    const [post] = f.posts();
    expect(post.path).toBe("/questions/qst-1/revisions");
    const question = post.body?.question as Record<string, unknown>;
    for (const name of ["default_value", "show_if", "help"]) {
      expect(Object.prototype.hasOwnProperty.call(question, name), `${name} 키`).toBe(true);
      expect(question[name], name).toBeNull();
    }
  });

  it("값이 있으면 그 값을 보낸다", async () => {
    const f = setup();
    await (await make(f)).reviseQuestion(SLUG, ED, "qst-1", base({ default_value: "yes", show_if: { question_id: "q-21", equals: "split" }, help: "참고" }), "k2");
    const question = f.posts()[0].body?.question as Record<string, unknown>;
    expect(question.default_value).toBe("yes");
    expect(question.show_if).toEqual({ id: "q-21", in: ["split"] });
    expect(question.help).toBe("참고");
  });

  it("질문을 새로 더할 때(addQuestion)는 비운 칸의 키를 보내지 않는다(기존 동작 그대로)", async () => {
    const f = setup();
    const ctx = ok({ edition: { edition_no: String(ED) }, stages: [{ key: "plan", stage_id: "stg-1" }] });
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
    expect(Object.prototype.hasOwnProperty.call(question, "show_if")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(question, "help")).toBe(false);
  });

  it("서버가 표현하지 못하는 중요도 지우기(null)는 요청 없이 거절한다 — 조용히 누락해 성공시키지 않는다", async () => {
    const f = setup();
    await expect((await make(f)).reviseQuestion(SLUG, ED, "qst-1", base({ importance: null }), "k4")).rejects.toBeInstanceOf(NotConnectedError);
    expect(f.seen).toHaveLength(0);
  });
});

describe("질문 고치기 — ask_ai 방향은 요청 없이 거절 (필수 4)", () => {
  it("direction ask_ai 면 NotConnectedError, 요청 0", async () => {
    const f = setup();
    await expect((await make(f)).reviseQuestion(SLUG, ED, "qst-1", base({ direction: "ask_ai" }), "k5")).rejects.toBeInstanceOf(NotConnectedError);
    expect(f.seen).toHaveLength(0);
  });

  it("방향이 ask_human 이면 그대로 접수된다", async () => {
    const f = setup();
    const out = await (await make(f)).reviseQuestion(SLUG, ED, "qst-1", base(), "k6");
    expect(f.posts()).toHaveLength(1);
    expect(out.data.version).toBe(3);
  });
});
