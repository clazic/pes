// SEL-82 U1b — 실제 HTTP 클라이언트(fetch + x-pes-session)가 가짜 클라이언트와 같은 PesClient 모양을 지킨다 (Vitest, fetch 는 가짜).
// 구현 전이라 `@/api/http-client` 가 없어 실패하는 것이 정상.
//
// 해석 (이슈 SEL-82 · docs/plan/stage-1-api.md · types.ts 머리 설명 — 구현을 추측하지 않음):
//   - `createHttpClient({ session, projects, baseUrl?, fetch? }): PesClient`  (named export, `@/api/http-client`)
//       session  : 소유자 세션 값 → 모든 요청에 헤더 `x-pes-session` 으로 보낸다(쿠키·Authorization 없음).
//       projects : { [slug]: 프로젝트 id } — 화면 주소의 slug 를 API 의 `P = /api/v1/projects/{id}` 로 푼다(types.ts "한계(U1b 에서 메움)").
//       baseUrl  : 기본 "" (같은 출처). fetch: 기본 globalThis.fetch (시험은 가짜를 넣는다).
//   - 모든 요청은 `/api/v1/` 로 시작하는 경로(같은 출처)이고 읽기는 GET 에 본문·Idempotency-Key 가 없다.
//   - getWorkspace(slug, edition): GET P/workspace → 응답 봉투 `{format_version, request_id, data}` 의 data 를 그대로(WorkspaceView + 서버가 더한 칸) 돌려준다.
//       모르는 slug 는 요청 없이 null(지어내지 않음). 서버 404 not_found 도 null. 판(edition)이 다르면 null(자료를 지어내지 않는다).
//       그 밖의 거절(401·403·410·500 …)과 네트워크 실패는 던진다: 거절은 PesApiError(`.body` 가 ApiError 봉투), 네트워크 실패는 그대로 reject — null 로 삼키지 않는다.
//   - listProjects(): projects 의 각 slug 에 대해 workspace 를 읽어 {slug, edition, current} 를 돌려준다.
//   - getRound(slug, edition, stage, round): 라운드 읽기 경로는 계획에 없다(types.ts READS.round "미정"). 해석: 작업 공간 읽기에 그 라운드가 있으면
//       {stage, round_id, state} 가 맞는 RoundView(questions·alerts 는 배열, result 는 null 또는 객체) 를, 없으면 null. "start" = round_id null 자리.
//   - acknowledgeAlert: 멱등 키 없으면 요청 없이 PesApiError(invalid_payload). 키가 있으면 POST `/api/v1/projects/{id}/…`, 헤더 `idempotency-key` = 그 키,
//       본문 JSON, 응답 봉투의 CommandResult 를 그대로 돌려준다. (경로 이름은 계획에 "(미정)" — 시험은 접두사만 본다.)
import { describe, expect, it, vi } from "vitest";
import { createFakeClient } from "@/api/fake-client";
import { WORKSPACE } from "@/api/fixture";
import { FORMAT_VERSION, PesApiError, type PesClient } from "@/api/types";

type Opts = { session: string; projects: Record<string, string>; baseUrl?: string; fetch?: typeof fetch };
type Factory = (o: Opts) => PesClient;
// import.meta.glob: 파일이 아직 없어도 파일 전체가 죽지 않고(typecheck 도 통과), 시험마다 아래 메시지로 실패한다
const modules = {
  http: import.meta.glob<{ createHttpClient: Factory }>("/src/api/http-client.{ts,tsx}"),
  select: import.meta.glob<{ selectClient: (win: unknown, fetchImpl?: typeof fetch) => PesClient }>("/src/api/select-client.{ts,tsx}"),
};
const only = async <T,>(found: Record<string, () => Promise<T>>, name: string): Promise<T> => {
  const loader = Object.values(found)[0];
  if (!loader) throw new Error(`src/api/${name} 가 없다 — 계약은 이 파일 머리말`);
  return loader();
};
const load = async (): Promise<Factory> => (await only(modules.http, "http-client.ts")).createHttpClient;

const SESSION = "synthetic-session-for-unit-test";
const ID = "pj-synthetic-1";
const SLUG = WORKSPACE.slug;
const ok = (data: unknown) => ({ format_version: FORMAT_VERSION, request_id: "req-1", data });
const err = (code: string, status: number) => ({ status, body: { format_version: FORMAT_VERSION, error: { code, message: "합성 오류 문장", retryable: false, target: null, details: null, next_action: "reread_context" }, request_id: "req-e" } });

interface Seen {
  url: URL;
  method: string;
  headers: Headers;
  body: string | null;
}
function fakeFetch(handler: (seen: Seen) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>) {
  const seen: Seen[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : null;
    const s: Seen = {
      url: new URL(String(req ? req.url : input), "http://app.invalid"),
      method: (init?.method ?? req?.method ?? "GET").toUpperCase(),
      headers: new Headers(init?.headers ?? req?.headers),
      body: typeof init?.body === "string" ? init.body : null,
    };
    seen.push(s);
    const r = await handler(s);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  });
  return { impl: impl as unknown as typeof fetch, seen, spy: impl };
}

const workspaceHandler = (s: Seen) => (s.url.pathname === `/api/v1/projects/${ID}/workspace` ? { status: 200, body: ok(WORKSPACE) } : err("not_found", 404));

describe("HTTP 클라이언트 — 읽기", () => {
  it("getWorkspace 는 GET P/workspace 를 x-pes-session 으로 부르고 data 를 그대로 돌려준다(가짜 클라이언트와 같은 값)", async () => {
    const { impl, seen } = fakeFetch(workspaceHandler);
    const client = (await load())({ session: SESSION, projects: { [SLUG]: ID }, fetch: impl });
    const ws = await client.getWorkspace(SLUG, 1);
    expect(ws).toEqual(WORKSPACE);
    expect(await createFakeClient().getWorkspace(SLUG, 1)).toEqual(ws);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe("GET");
    expect(seen[0]!.url.pathname).toBe(`/api/v1/projects/${ID}/workspace`);
    expect(seen[0]!.headers.get("x-pes-session")).toBe(SESSION);
    expect(seen[0]!.headers.get("idempotency-key")).toBeNull();
    expect(seen[0]!.body).toBeNull();
    expect(seen[0]!.headers.get("authorization")).toBeNull();
  });

  it("baseUrl 이 있으면 그 출처로, 없으면 같은 출처(상대 경로)로만 간다", async () => {
    const a = fakeFetch(workspaceHandler);
    await (await load())({ session: SESSION, projects: { [SLUG]: ID }, fetch: a.impl }).getWorkspace(SLUG, 1);
    expect(String(a.spy.mock.calls[0]![0])).toMatch(/^\/api\/v1\//);
    const b = fakeFetch(workspaceHandler);
    await (await load())({ session: SESSION, projects: { [SLUG]: ID }, baseUrl: "http://127.0.0.1:9", fetch: b.impl }).getWorkspace(SLUG, 1);
    expect(String(b.spy.mock.calls[0]![0])).toMatch(/^http:\/\/127\.0\.0\.1:9\/api\/v1\//);
  });

  it("모르는 slug 와 다른 판은 요청 없이 null — 자료를 지어내지 않는다", async () => {
    const { impl, spy } = fakeFetch(workspaceHandler);
    const client = (await load())({ session: SESSION, projects: { [SLUG]: ID }, fetch: impl });
    expect(await client.getWorkspace("no-such-project", 1)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    expect(await client.getWorkspace(SLUG, 99)).toBeNull();
  });

  it("서버 404 not_found 는 null, 401·403·410·500 은 PesApiError(.body 가 오류 봉투)로 던진다", async () => {
    const mk = async (res: { status: number; body: unknown }) => (await load())({ session: SESSION, projects: { [SLUG]: ID }, fetch: fakeFetch(() => res).impl });
    expect(await (await mk(err("not_found", 404))).getWorkspace(SLUG, 1)).toBeNull();
    for (const [code, status] of [["unauthenticated", 401], ["forbidden", 403], ["cursor_expired", 410], ["internal_error", 500]] as const) {
      const rejected = await (await mk(err(code, status))).getWorkspace(SLUG, 1).then(() => null, (e: unknown) => e);
      expect(rejected, `${status} ${code}`).toBeInstanceOf(PesApiError);
      expect((rejected as PesApiError).body.error.code).toBe(code);
      expect((rejected as PesApiError).body.format_version).toBe(FORMAT_VERSION);
    }
  });

  it("네트워크 실패는 null 로 삼키지 않고 그대로 reject 한다", async () => {
    const down = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const client = (await load())({ session: SESSION, projects: { [SLUG]: ID }, fetch: down });
    await expect(client.getWorkspace(SLUG, 1)).rejects.toThrow();
  });

  it("listProjects 는 projects 의 slug 마다 workspace 를 읽어 {slug, edition, current} 를 준다", async () => {
    const { impl } = fakeFetch(workspaceHandler);
    const client = (await load())({ session: SESSION, projects: { [SLUG]: ID }, fetch: impl });
    expect(await client.listProjects()).toEqual([{ slug: SLUG, edition: WORKSPACE.edition, current: WORKSPACE.current }]);
  });

  it("getRound: 작업 공간에 있는 라운드는 맞는 RoundView, 없는 것은 null, start 는 round_id null", async () => {
    const { impl } = fakeFetch(workspaceHandler);
    const client = (await load())({ session: SESSION, projects: { [SLUG]: ID }, fetch: impl });
    const r2 = await client.getRound(SLUG, 1, "research", "2");
    expect(r2).not.toBeNull();
    expect(r2).toMatchObject({ stage: "research", round_id: 2, state: "current" });
    expect(Array.isArray(r2!.questions)).toBe(true);
    expect(Array.isArray(r2!.alerts)).toBe(true);
    expect(await client.getRound(SLUG, 1, "research", "start")).toMatchObject({ stage: "research", round_id: null });
    expect(await client.getRound(SLUG, 1, "research", "7")).toBeNull();
    expect(await client.getRound(SLUG, 1, "research", "0")).toBeNull();
    expect(await client.getRound(SLUG, 1, "write", "1")).toBeNull();
    expect(await client.getRound("no-such-project", 1, "research", "2")).toBeNull();
  });
});

describe("HTTP 클라이언트 — 쓰기(오류 확인)", () => {
  it("멱등 키가 없으면 요청 없이 invalid_payload 로 거절한다", async () => {
    const { impl, spy } = fakeFetch(workspaceHandler);
    const client = (await load())({ session: SESSION, projects: { [SLUG]: ID }, fetch: impl });
    const rejected = await client.acknowledgeAlert(SLUG, 1, "alert-1", undefined).then(() => null, (e: unknown) => e);
    expect(rejected).toBeInstanceOf(PesApiError);
    expect((rejected as PesApiError).body.error.code).toBe("invalid_payload");
    expect(spy).not.toHaveBeenCalled();
  });

  it("키가 있으면 POST, idempotency-key·x-pes-session 헤더, 응답 CommandResult 를 그대로 돌려준다", async () => {
    const result = { format_version: FORMAT_VERSION, request_id: "req-w", receipt: { receipt_no: "0901", tx_id: "tx-0901", committed_at: "2026-11-12T01:00:00.000Z", idempotency_key: "key-1", replayed: false }, data: { alert_id: "alert-1" } };
    const { impl, seen } = fakeFetch(() => ({ status: 200, body: result }));
    const client = (await load())({ session: SESSION, projects: { [SLUG]: ID }, fetch: impl });
    const got = await client.acknowledgeAlert(SLUG, 1, "alert-1", "key-1");
    expect(got).toEqual(result);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.url.pathname.startsWith(`/api/v1/projects/${ID}/`)).toBe(true);
    expect(seen[0]!.headers.get("idempotency-key")).toBe("key-1");
    expect(seen[0]!.headers.get("x-pes-session")).toBe(SESSION);
    expect(seen[0]!.headers.get("content-type") ?? "").toMatch(/application\/json/);
    expect(() => JSON.parse(seen[0]!.body ?? "")).not.toThrow();
    expect(seen[0]!.body).toContain("alert-1");
  });

  it("서버 거절(409 conflict · 409 idempotency_key_reuse)은 PesApiError 로 던진다", async () => {
    for (const code of ["conflict", "idempotency_key_reuse"]) {
      const client = (await load())({ session: SESSION, projects: { [SLUG]: ID }, fetch: fakeFetch(() => err(code, 409)).impl });
      const rejected = await client.acknowledgeAlert(SLUG, 1, "alert-1", "k").then(() => null, (e: unknown) => e);
      expect(rejected).toBeInstanceOf(PesApiError);
      expect((rejected as PesApiError).body.error.code).toBe(code);
    }
  });
});

describe("클라이언트 고르기 — 가짜가 기본, 설정이 있을 때만 실제", () => {
  // 해석: `@/api/select-client` 의 `selectClient(win, fetchImpl?)` — win.__PES_APP__ = { api: "http", session, projects } 이면 HTTP, 아니면 가짜(합성 sample-study).
  const select = () => only(modules.select, "select-client.ts");

  it("설정이 없으면 가짜 클라이언트(요청 0)", async () => {
    const { impl, spy } = fakeFetch(workspaceHandler);
    const client = (await select()).selectClient({}, impl);
    expect((await client.getWorkspace(SLUG, 1))?.slug).toBe(SLUG);
    expect(spy).not.toHaveBeenCalled();
  });

  it("api:'http' 설정이면 실제 클라이언트가 fetch 로 읽는다(세션 헤더 포함)", async () => {
    const { impl, seen } = fakeFetch((s) => (s.url.pathname === "/api/v1/projects/pj-x/workspace" ? { status: 200, body: ok({ ...WORKSPACE, slug: "from-server", title: "서버에서 온 제목" }) } : err("not_found", 404)));
    const client = (await select()).selectClient({ __PES_APP__: { api: "http", session: SESSION, projects: { "from-server": "pj-x" } } }, impl);
    expect((await client.getWorkspace("from-server", 1))?.title).toBe("서버에서 온 제목");
    expect(seen[0]!.headers.get("x-pes-session")).toBe(SESSION);
  });

  it("api 가 'http' 가 아닌 값이면 가짜로 돌아간다(오타가 실제 요청이 되지 않는다)", async () => {
    const { impl, spy } = fakeFetch(workspaceHandler);
    const client = (await select()).selectClient({ __PES_APP__: { api: "htpp", session: SESSION, projects: {} } }, impl);
    await client.getWorkspace(SLUG, 1);
    expect(spy).not.toHaveBeenCalled();
  });
});
