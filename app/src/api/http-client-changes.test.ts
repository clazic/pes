// SEL-82 U1b (leader 추가 범위) — HTTP 클라이언트의 getChanges(SEL-83 PesClient 약속)를 실제 API changes 위에 구현한다 (Vitest, fetch 는 가짜).
// SEL-83(U1c)이 먼저 병합되면 PesClient 에 getChanges 가 생긴다; 이 브랜치의 types.ts 에는 아직 없어 호출을 좁은 타입으로 부른다(rebase 뒤 캐스트 제거). 구현 전이라 실패가 정상.
//
// 해석 (SEL-83 types.ts ChangesRead 머리말 + GET P/changes 실제 응답 {events,next_cursor,has_more,epoch}; 서버 events 에는 tx_id·stage·round 가 없다 — 구현을 추측하지 않음):
//   getChanges(slug, edition, cursor): Promise<{ cursor: string; txs: { tx_id: string; touched: string[] }[] }>
//   (1) cursor=null = '기준만 받음' (leader 결정): 요청 하나 `GET P/changes?cursor=head` (서버가 사건을 읽지 않고 지금 머리 커서만 준다: {events:[], next_cursor, has_more:false}).
//       돌려주는 값 = { cursor: 그 next_cursor, txs: [] }. 쪽을 따라가지 않는다(큰 프로젝트에서 전체 사건을 읽지 않는다).
//   (2) cursor=문자열: 한 번만 `GET P/changes?cursor=<그대로>` (읽기 GET, x-pes-session, 본문 없음). 돌려주는 cursor = 응답 next_cursor(해석 없이 그대로).
//       events 는 tx_id 가 없으므로 **사건 하나가 tx 하나**이고 tx_id = event_seq 문자열(서버는 whole-tx 쪽만 주므로 쪽이 tx 를 가르지 않는다).
//       touched 규칙(type 으로만 정한다 — events 에 stage/round 가 없어 'round:<stage>/<round>' 를 만들 수 없다; 해석: 라운드에 닿는 사건은 모든 라운드를 가리키는 "round:*"):
//         모든 사건            → "workspace"
//         project.* · edition.* · policy.changed → 위에 더해 "projects"
//         round.* · question.* · answer.* · result.* · stage.* · run.* · input.* → 위에 더해 "round:*"
//         그 밖(content.* · file.* · dispatch.* …)  → "workspace" 만
//       touched 는 중복 없이 위 순서(workspace, projects, round:*). 보이지 않는 사건이라 events 가 비면 txs 가 비고 cursor 만 앞으로 간다.
//       has_more=true 여도 이번 호출은 한 쪽만(화면이 다음 호출에서 이어 받는다).
//   (3) 400 cursor_invalid · 410 cursor_expired → PesApiError(.body.error.code 그대로, details 보존). 다른 거절(401·403)도 PesApiError, 네트워크 실패는 그대로 reject.
//       모르는 slug → 요청 없이 PesApiError(not_found).
import { describe, expect, it, vi } from "vitest";
import { WORKSPACE } from "@/api/fixture";
import { FORMAT_VERSION, PesApiError } from "@/api/types";

type Tx = { tx_id: string; touched: string[] };
type ChangesClient = { getChanges(slug: string, edition: number, cursor: string | null): Promise<{ cursor: string; txs: Tx[] }> };
type Opts = { session: string; projects: Record<string, string>; fetch?: typeof fetch };
const modules = import.meta.glob<{ createHttpClient: (o: Opts) => ChangesClient }>("/src/api/http-client.{ts,tsx}");
const load = async () => {
  const loader = Object.values(modules)[0];
  if (!loader) throw new Error("src/api/http-client.ts 가 없다");
  return (await loader()).createHttpClient;
};

const SESSION = "synthetic-session-changes";
const ID = "pj-synthetic-1";
const SLUG = WORKSPACE.slug;
const errBody = (code: string, details: unknown = null) => ({ format_version: FORMAT_VERSION, error: { code, message: "합성 오류", retryable: false, target: "$.query.cursor", details, next_action: "reread_context" }, request_id: "r-e" });
const ev = (seq: number, type: string) => ({ event_seq: String(seq), type, object_id: `obj-${seq}`, before_version_id: null, after_version_id: null, at: 1762312005000 + seq });
const page = (events: unknown[], next: string, more = false) => ({ status: 200, body: { format_version: FORMAT_VERSION, request_id: "r1", data: { events, next_cursor: next, has_more: more, epoch: "1" } } });

function server(handler: (cursor: string | null, n: number) => { status: number; body: unknown }) {
  const seen: { url: URL; method: string; headers: Headers; body: string | null }[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input), "http://app.invalid");
    seen.push({ url, method: (init?.method ?? "GET").toUpperCase(), headers: new Headers(init?.headers), body: typeof init?.body === "string" ? init.body : null });
    const r = handler(url.searchParams.get("cursor"), seen.length);
    return new Response(JSON.stringify(r.body), { status: r.status });
  });
  return { impl: impl as unknown as typeof fetch, seen };
}
const make = async (s: ReturnType<typeof server>) => (await load())({ session: SESSION, projects: { [SLUG]: ID }, fetch: s.impl });

describe("getChanges — 기준만 받기 (cursor=null)", () => {
  it("요청 하나 ?cursor=head 로 머리 커서만 받고 txs 는 비어 있다(전체 사건을 읽지 않는다)", async () => {
    const s = server((cursor) => (cursor === "head" ? page([], "c-head", false) : page([ev(1, "project.created")], "c-wrong", true)));
    const out = await (await make(s)).getChanges(SLUG, 1, null);
    expect(out).toEqual({ cursor: "c-head", txs: [] });
    expect(s.seen).toHaveLength(1);
    expect(s.seen[0]!.url.pathname).toBe(`/api/v1/projects/${ID}/changes`);
    expect(s.seen[0]!.url.searchParams.get("cursor")).toBe("head");
    expect(s.seen[0]!.method).toBe("GET");
    expect(s.seen[0]!.headers.get("x-pes-session")).toBe(SESSION);
    expect(s.seen[0]!.headers.get("idempotency-key")).toBeNull();
    expect(s.seen[0]!.body).toBeNull();
  });
  it("서버가 (이상하게) 사건을 실어 보내도 txs 는 비어 있고 커서는 응답 next_cursor 이다", async () => {
    const s = server(() => page([ev(1, "round.started")], "c-only", true));
    expect(await (await make(s)).getChanges(SLUG, 1, null)).toEqual({ cursor: "c-only", txs: [] });
    expect(s.seen).toHaveLength(1);
  });
  it("문자열 커서 'head' 가 아닌 보통 커서는 cursor=head 로 바뀌지 않는다", async () => {
    const s = server(() => page([], "c2"));
    await (await make(s)).getChanges(SLUG, 1, "c1");
    expect(s.seen[0]!.url.searchParams.get("cursor")).toBe("c1");
  });
});

describe("getChanges — 커서 다음 (cursor=문자열)", () => {
  it("한 번만 부르고 커서를 그대로 보내며, 응답 next_cursor 를 그대로 돌려준다(has_more 여도 한 쪽)", async () => {
    const s = server(() => page([ev(5, "content.object_created")], "c-next", true));
    const out = await (await make(s)).getChanges(SLUG, 1, "c-given");
    expect(s.seen).toHaveLength(1);
    expect(s.seen[0]!.url.searchParams.get("cursor")).toBe("c-given");
    expect(out.cursor).toBe("c-next");
    expect(out.txs).toEqual([{ tx_id: "5", touched: ["workspace"] }]);
  });
  it("사건 하나 = tx 하나(tx_id = event_seq), 순서는 event_seq 순", async () => {
    const s = server(() => page([ev(7, "round.started"), ev(8, "content.version_appended"), ev(9, "project.topic_set")], "c9"));
    const out = await (await make(s)).getChanges(SLUG, 1, "c6");
    expect(out.txs.map((t) => t.tx_id)).toEqual(["7", "8", "9"]);
  });
  it("touched 규칙: 모든 사건 workspace, project·edition·policy 는 + projects, 라운드에 닿는 사건은 + round:*, 그 밖은 workspace 만 — 중복 없음", async () => {
    const table: [string, string[]][] = [
      ["project.created", ["workspace", "projects"]],
      ["project.topic_set", ["workspace", "projects"]],
      ["edition.created", ["workspace", "projects"]],
      ["policy.changed", ["workspace", "projects"]],
      ["round.started", ["workspace", "round:*"]],
      ["round.sealed", ["workspace", "round:*"]],
      ["question.set_published", ["workspace", "round:*"]],
      ["question.revised", ["workspace", "round:*"]],
      ["answer.submitted", ["workspace", "round:*"]],
      ["result.submitted", ["workspace", "round:*"]],
      ["stage.approved", ["workspace", "round:*"]],
      ["stage.reopened", ["workspace", "round:*"]],
      ["run.claimed", ["workspace", "round:*"]],
      ["input.chat_recorded", ["workspace", "round:*"]],
      ["content.version_appended", ["workspace"]],
      ["file.version_attached", ["workspace"]],
      ["dispatch.sent", ["workspace"]],
      ["some.unknown_type", ["workspace"]],
    ];
    const s = server(() => page(table.map(([type], i) => ev(i + 1, type)), "c-end"));
    const out = await (await make(s)).getChanges(SLUG, 1, "c0");
    expect(out.txs.map((t) => t.touched)).toEqual(table.map(([, want]) => want));
  });
  it("보이지 않는 사건이라 events 가 비면 txs 는 비고 커서만 앞으로 간다", async () => {
    const s = server(() => page([], "c-moved"));
    expect(await (await make(s)).getChanges(SLUG, 1, "c-old")).toEqual({ cursor: "c-moved", txs: [] });
  });
});

describe("getChanges — 거절", () => {
  it("400 cursor_invalid · 410 cursor_expired 는 PesApiError 이고 코드·details(새 커서 포함)가 그대로 남는다", async () => {
    const client = await make(server((c) => (c === "bad" ? { status: 400, body: errBody("cursor_invalid") } : { status: 410, body: errBody("cursor_expired", { next_cursor: "c-fresh", keep_unsubmitted_answers: true }) })));
    const invalid = await client.getChanges(SLUG, 1, "bad").catch((e) => e);
    expect(invalid).toBeInstanceOf(PesApiError);
    expect(invalid.body.error.code).toBe("cursor_invalid");
    const expired = await client.getChanges(SLUG, 1, "old").catch((e) => e);
    expect(expired).toBeInstanceOf(PesApiError);
    expect(expired.body.error.code).toBe("cursor_expired");
    expect(expired.body.error.details).toMatchObject({ next_cursor: "c-fresh", keep_unsubmitted_answers: true });
  });
  it("401 은 PesApiError, 네트워크 실패는 그대로 reject, 모르는 slug 는 요청 없이 PesApiError(not_found)", async () => {
    const unauth = await make(server(() => ({ status: 401, body: errBody("unauthenticated") })));
    expect(await unauth.getChanges(SLUG, 1, "c").catch((e) => e)).toBeInstanceOf(PesApiError);
    const down = (await load())({ session: SESSION, projects: { [SLUG]: ID }, fetch: (async () => { throw new TypeError("network down"); }) as unknown as typeof fetch });
    await expect(down.getChanges(SLUG, 1, "c")).rejects.toThrow("network down");
    const s = server(() => page([], "c"));
    const unknown = await (await make(s)).getChanges("no-such-slug", 1, "c").catch((e) => e);
    expect(unknown).toBeInstanceOf(PesApiError);
    expect(unknown.body.error.code).toBe("not_found");
    expect(s.seen).toEqual([]);
  });
});
