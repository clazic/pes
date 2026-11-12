// SEL-92 U2c 1차 리뷰(CHANGES) 수정 — http 클라이언트: 영수증을 지어내지 않는다 · 쓰기 요청에 시간 제한이 있다 (Vitest, jsdom, fetch 가짜).
// 기존 시험(u2c-http.test.ts)의 단언은 그대로 두고, 고친 동작만 새로 지킨다.
import { describe, expect, it, vi } from "vitest";
import { WORKSPACE } from "@/api/fixture";
import { FORMAT_VERSION, PesApiError, type PesClient } from "@/api/types";

type Opts = { session: string; projects: Record<string, string>; baseUrl?: string; fetch?: typeof fetch; timeoutMs?: number };
const modules = import.meta.glob<{ createHttpClient: (o: Opts) => PesClient }>("/src/api/http-client.{ts,tsx}");
const load = async () => {
  const loader = Object.values(modules)[0];
  if (!loader) throw new Error("src/api/http-client.ts 가 없다");
  return (await loader()).createHttpClient;
};
type Out = { data: Record<string, unknown>; receipt: Record<string, unknown> };
type Writer = { withdrawQuestion(slug: string, edition: number, id: string, key: string | undefined): Promise<Out> };

const ID = "pj-synthetic-1";
const SLUG = WORKSPACE.slug;
const ED = WORKSPACE.edition;
const P = `/api/v1/projects/${ID}`;
const ok = (data: unknown, extra: Record<string, unknown> = {}) => ({ format_version: FORMAT_VERSION, request_id: "req-1", data, ...extra });
const withdrawn = ok({ question: { id: "qst-1", version_id: "v", version_no: "2", state: "withdrawn" } });
const reqRead = (extra: Record<string, unknown> = {}) => ok({ key: "k", state: "completed", action: "question.withdrawn", status: 200, tx_id: "5d2e1c0a-7b3f-4e21-9a55-0f2b3c4d5e06", run_id: null, ...extra });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

type Handler = (url: URL, init: RequestInit | undefined) => Promise<Response> | Response;
function fake(handler: Handler) {
  const seen: { method: string; path: string; key: string | null; signal: AbortSignal | null | undefined }[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://app.invalid");
    seen.push({ method: (init?.method ?? "GET").toUpperCase(), path: url.pathname.replace(P, ""), key: new Headers(init?.headers).get("idempotency-key"), signal: init?.signal });
    return handler(url, init);
  });
  return { impl: impl as unknown as typeof fetch, seen, posts: () => seen.filter((s) => s.method === "POST") };
}
const make = async (f: ReturnType<typeof fake>, timeoutMs?: number) =>
  (await load())({ session: "s", projects: { [SLUG]: ID }, fetch: f.impl, ...(timeoutMs ? { timeoutMs } : {}) }) as unknown as Writer;
const route = (read: () => Promise<Response> | Response) => (url: URL, init: RequestInit | undefined) =>
  (init?.method ?? "GET").toUpperCase() === "POST" ? json(201, withdrawn) : url.pathname.includes("/requests/") ? read() : json(404, {});

describe("영수증 — 서버가 준 값만 쓴다 (필수 1)", () => {
  it("서버 requests 응답에 receipt_no 가 있으면 그것을 그대로 쓴다", async () => {
    const f = fake(route(() => json(200, reqRead({ receipt_no: "0042" }))));
    const out = await (await make(f)).withdrawQuestion(SLUG, ED, "qst-1", "k");
    expect(out.receipt.receipt_no).toBe("0042");
    expect(out.receipt.numbered).not.toBe(false);
  });

  it("receipt_no 가 없으면 tx_id 끝 숫자로 번호를 만들지 않는다 — tx_id 는 그대로, 번호 없음 표시", async () => {
    const tx = "5d2e1c0a-7b3f-4e21-9a55-0f2b3c4d5e06"; // 끝이 06 으로 끝나는 UUID — 옛 구현은 "0006" 을 지어냈다
    const f = fake(route(() => json(200, reqRead({ tx_id: tx }))));
    const out = await (await make(f)).withdrawQuestion(SLUG, ED, "qst-1", "k");
    expect(out.receipt.tx_id).toBe(tx);
    expect(out.receipt.numbered).toBe(false);
    expect(out.receipt.receipt_no).not.toMatch(/^0+\d{1,3}$/);
  });

  it("서로 다른 접수가 같은 번호로 보이지 않는다", async () => {
    const mk = async (tx: string) => (await make(fake(route(() => json(200, reqRead({ tx_id: tx })))))).withdrawQuestion(SLUG, ED, "qst-1", "k");
    const a = await mk("aaaaaaaa-0000-4000-8000-000000000006");
    const b = await mk("bbbbbbbb-1111-4111-8111-000000000006");
    expect(a.receipt.receipt_no).not.toBe(b.receipt.receipt_no);
  });

  it("서버가 committed_at 을 주면 그 시각을 쓴다", async () => {
    const f = fake(route(() => json(200, reqRead({ committed_at: "2026-11-12T03:04:05.000Z" }))));
    const out = await (await make(f)).withdrawQuestion(SLUG, ED, "qst-1", "k");
    expect(out.receipt.committed_at).toBe("2026-11-12T03:04:05.000Z");
  });
});

describe("영수증 조회가 실패하면 성공으로 보이지 않는다 — 접수 확인 중 + 같은 키 (필수 1)", () => {
  it.each([
    ["500 응답", () => json(500, { error: { code: "internal_error" } })],
    ["404 응답", () => json(404, { error: { code: "not_found" } })],
    ["본문이 JSON 이 아님", () => new Response("<html>", { status: 200 })],
    ["tx_id 없음", () => json(200, ok({ key: "k" }))],
  ])("%s → TimeoutError(접수 확인 중), POST 는 한 번", async (_name, read) => {
    const f = fake(route(read));
    const err = await (await make(f)).withdrawQuestion(SLUG, ED, "qst-1", "k").then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("TimeoutError");
    expect(err).not.toBeInstanceOf(PesApiError);
    expect(f.posts()).toHaveLength(1);
  });

  it("네트워크가 끊겨도 TimeoutError — 같은 멱등 키로 다시 보내면 서버가 재생한다", async () => {
    let down = true;
    const f = fake((_url, init) => {
      if ((init?.method ?? "GET").toUpperCase() === "POST") return json(201, withdrawn);
      if (down) throw new TypeError("Failed to fetch");
      return json(200, reqRead({ receipt_no: "0007" }));
    });
    const client = await make(f);
    await expect(client.withdrawQuestion(SLUG, ED, "qst-1", "key-same")).rejects.toMatchObject({ name: "TimeoutError" });
    down = false;
    const again = await client.withdrawQuestion(SLUG, ED, "qst-1", "key-same");
    expect(again.receipt.receipt_no).toBe("0007");
    expect(f.posts().map((p) => p.key)).toEqual(["key-same", "key-same"]);
  });
});

describe("쓰기 요청 시간 제한 (필수 2)", () => {
  it("POST 응답이 멈추면 시간 초과 뒤 TimeoutError 로 끝나고, 요청에 중단 신호를 단다", async () => {
    const f = fake((_u, init) => (init?.method === "POST" ? new Promise<Response>(() => undefined) : json(404, {})));
    const err = await (await make(f, 30)).withdrawQuestion(SLUG, ED, "qst-1", "key-t").then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as Error).name).toBe("TimeoutError");
    const post = f.posts()[0]!;
    expect(post.key).toBe("key-t");
    expect(post.signal).toBeInstanceOf(AbortSignal);
    expect(post.signal!.aborted).toBe(true);
  });

  it("시간 초과 뒤 같은 키로 다시 보내면 같은 멱등 키가 간다", async () => {
    let hang = true;
    const f = fake((u, init) => {
      if (init?.method === "POST") return hang ? new Promise<Response>(() => undefined) : json(201, withdrawn);
      return u.pathname.includes("/requests/") ? json(200, reqRead({ receipt_no: "0009" })) : json(404, {});
    });
    const client = await make(f, 30);
    await expect(client.withdrawQuestion(SLUG, ED, "qst-1", "key-r")).rejects.toMatchObject({ name: "TimeoutError" });
    hang = false;
    const out = await client.withdrawQuestion(SLUG, ED, "qst-1", "key-r");
    expect(out.receipt.receipt_no).toBe("0009");
    expect(f.posts().map((p) => p.key)).toEqual(["key-r", "key-r"]);
  });

  it("영수증 GET 이 멈춰도 TimeoutError — 성공으로 말하지 않는다", async () => {
    const f = fake(route(() => new Promise<Response>(() => undefined)));
    await expect((await make(f, 30)).withdrawQuestion(SLUG, ED, "qst-1", "k")).rejects.toMatchObject({ name: "TimeoutError" });
    expect(f.posts()).toHaveLength(1);
  });

  it("제때 오는 응답은 시간 제한에 걸리지 않는다", async () => {
    const f = fake(route(() => json(200, reqRead({ receipt_no: "0010" }))));
    const out = await (await make(f, 5000)).withdrawQuestion(SLUG, ED, "qst-1", "k");
    expect(out.receipt.receipt_no).toBe("0010");
  });
});
