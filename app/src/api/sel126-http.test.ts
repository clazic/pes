// SEL-126 — HTTP 클라이언트 getRound 가 서버 라운드 읽기의 result 를 RoundView.result 로 옮긴다 (Vitest, fetch 는 가짜). 구현 전이라 실패가 정상.
// 서버 계약: tests/test_sel126_round_result.test.ts 머리말.
//
// ═══ 매핑 (GET P/stages/{stage}/rounds/{start|번호}) ═══
//  서버 data.result = { object_id, version_id, body_md }  →  RoundView.result 에 object_id · version_id · body_md 를 그대로 싣는다(첨언 도구의 기준 — AnnotatedResult · isAnnotatable).
//  서버 data.result = null, 또는 칸이 없는 옛 응답, 또는 모양이 깨진 값(문자열 아닌 칸) → RoundView.result = null (지어내지 않는다).
//  판 번호가 앱이 보는 판과 다른 응답은 기존대로 통째로 쓰지 않는다(null).
//  결과를 싣기 위해 요청을 더 보내지 않는다(라운드 읽기 한 번).
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
type C = { getRound(slug: string, edition: number, stage: string, round: string): Promise<Record<string, any> | null> };

const SESSION = "synthetic-session-sel126";
const ID = "pj-synthetic-126";
const SLUG = WORKSPACE.slug;
const ED = WORKSPACE.edition;
const P = `/api/v1/projects/${ID}`;
const ok = (data: unknown) => ({ format_version: FORMAT_VERSION, request_id: "req-126", data });
const BODY = "# 합성 결과 글\n\n첫 문단 MARK-R126.\r\n\r\n둘째 문단 (공백  두 칸)";
const RESULT = { object_id: "obj-res-1", version_id: "ver-res-3", body_md: BODY };
const roundData = (extra: Record<string, unknown> = {}) => ({ edition: ED, stage: "research", round_id: 2, server_round_id: "rnd-2", state: "closed", set_id: null, form_version: null, questions: [], ...extra });

function server(routes: Record<string, { status: number; body: unknown }>) {
  const seen: string[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input), "http://app.invalid");
    const key = `${(init?.method ?? "GET").toUpperCase()} ${url.pathname.replace(P, "")}`;
    seen.push(key);
    const r = routes[key] ?? { status: 404, body: { format_version: FORMAT_VERSION, request_id: "r", error: { code: "not_found", message: "합성", retryable: false, target: null, details: null, next_action: "reread_context" } } };
    return new Response(JSON.stringify(r.body), { status: r.status });
  });
  return { impl: impl as unknown as typeof fetch, seen };
}
const make = async (s: ReturnType<typeof server>) => (await load())({ session: SESSION, projects: { [SLUG]: ID }, fetch: s.impl }) as unknown as C;
const read = async (data: Record<string, unknown>) => {
  const s = server({ "GET /stages/research/rounds/2": { status: 200, body: ok(data) } });
  return { s, view: await (await make(s)).getRound(SLUG, ED, "research", "2") };
};

describe("getRound — 서버 result 를 RoundView.result 로 잇는다", () => {
  it("서버 result{object_id, version_id, body_md} 를 그대로 옮기고 요청은 라운드 읽기 한 번뿐이다", async () => {
    const { s, view } = await read(roundData({ result: RESULT }));
    expect(view).not.toBeNull();
    expect(view!.result).not.toBeNull();
    expect(view!.result).toMatchObject({ object_id: "obj-res-1", version_id: "ver-res-3", body_md: BODY });
    expect(view!.result!.body_md).toBe(BODY); // 정규화 없음(CRLF · 연속 공백 그대로)
    expect(s.seen).toEqual(["GET /stages/research/rounds/2"]);
  });

  it("다른 칸은 그대로 — 질문 · 상태 · 라운드 번호", async () => {
    const { view } = await read(roundData({ result: RESULT, state: "closed" }));
    expect(view).toMatchObject({ stage: "research", round_id: 2, state: "closed", form_version: 0 });
    expect(view!.questions).toEqual([]);
  });

  it("서버 result 가 null 이면 RoundView.result 는 null", async () => {
    const { view } = await read(roundData({ result: null }));
    expect(view).not.toBeNull();
    expect(view!.result).toBeNull();
  });

  it("result 칸이 없는 옛 응답도 null — 지어내지 않는다", async () => {
    const { view } = await read(roundData());
    expect(view).not.toBeNull();
    expect(view!.result).toBeNull();
  });

  it("모양이 깨진 result(칸이 문자열이 아님 · 일부 없음)는 첨언 도구를 켜지 않도록 null", async () => {
    for (const bad of [{ object_id: "o", version_id: "v" }, { object_id: "o", version_id: 3, body_md: "x" }, { version_id: "v", body_md: "x" }, "text", 7]) {
      const { view } = await read(roundData({ result: bad }));
      expect(view!.result, JSON.stringify(bad)).toBeNull();
    }
  });

  it("본문이 빈 글(body_md \"\")도 서버가 준 그대로 옮긴다(빈 문자열은 지어낸 값이 아니다)", async () => {
    const { view } = await read(roundData({ result: { object_id: "obj-e", version_id: "ver-e", body_md: "" } }));
    expect(view!.result).toMatchObject({ object_id: "obj-e", version_id: "ver-e", body_md: "" });
  });

  it("start 자리도 같은 규칙 — result 없으면 null", async () => {
    const s = server({ "GET /stages/plan/rounds/start": { status: 200, body: ok(roundData({ stage: "plan", round_id: null, server_round_id: null, state: "current" })) } });
    const view = await (await make(s)).getRound(SLUG, ED, "plan", "start");
    expect(view).not.toBeNull();
    expect(view!.result).toBeNull();
  });

  it("다른 판의 응답(edition 불일치)은 result 까지 통째로 쓰지 않는다(null)", async () => {
    const { view } = await read(roundData({ edition: ED + 1, result: RESULT }));
    expect(view).toBeNull();
  });
});
