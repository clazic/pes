// SEL-120 REF1c — HTTP 클라이언트 getReferenceCandidates 매핑 (Vitest, fetch 는 가짜). 합성 값만.
// 서버 계약: tests/test_sel120_candidates.test.ts 머리말 — GET P/reference-candidates(소유자 세션만)
//   200 data={candidates:[{project_id, key, label, attached, snapshots:[{id, key, label:null, approved, recommended}]}]}
// scope=null(생성 화면, 프로젝트가 아직 없음)은 서버에 길이 없어 NotConnectedError, 요청 0.
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

const SESSION = "synthetic-session-ref1c";
const ID = "pj-synthetic-3";
const SLUG = WORKSPACE.slug;
const ED = WORKSPACE.edition;
const PATH = `/api/v1/projects/${ID}/reference-candidates`;

const ok = (data: unknown) => ({ format_version: FORMAT_VERSION, request_id: "req-1", data });
const fail = (code: string) => ({ format_version: FORMAT_VERSION, request_id: "req-e", error: { code, message: "합성 거절 문장", retryable: false, target: "$.session", details: null, next_action: "reread_context" } });

function server(status: number, body: unknown) {
  const seen: { url: URL; method: string; headers: Headers; credentials: string | undefined }[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: new URL(String(input instanceof Request ? input.url : input), "http://app.invalid"), method: (init?.method ?? "GET").toUpperCase(), headers: new Headers(init?.headers), credentials: init?.credentials });
    return new Response(JSON.stringify(body), { status });
  });
  return { impl: impl as unknown as typeof fetch, seen };
}
const make = async (s: ReturnType<typeof server>) => (await load())({ session: SESSION, projects: { [SLUG]: ID }, fetch: s.impl });

describe("getReferenceCandidates", () => {
  it("정상: 서버 칸을 그대로 옮기고 스냅숏 이름이 없으면 null (지어내지 않는다)", async () => {
    const s = server(
      200,
      ok({
        candidates: [
          {
            project_id: "pj-a",
            key: "pj-a",
            label: "합성 주제 A",
            attached: true,
            snapshots: [
              { id: "sn-2", key: "sn-2", label: null, approved: true, recommended: true },
              { id: "sn-1", key: "sn-1", label: null, approved: false, recommended: false },
            ],
          },
          { project_id: "pj-b", key: "pj-b", label: "합성 주제 B", attached: false, snapshots: [] },
        ],
      }),
    );
    const got = await (await make(s)).getReferenceCandidates({ slug: SLUG, edition: ED });
    expect(got).toEqual([
      {
        project_id: "pj-a",
        key: "pj-a",
        label: "합성 주제 A",
        attached: true,
        snapshots: [
          { id: "sn-2", key: "sn-2", label: null, approved: true, recommended: true },
          { id: "sn-1", key: "sn-1", label: null, approved: false, recommended: false },
        ],
      },
      { project_id: "pj-b", key: "pj-b", label: "합성 주제 B", attached: false, snapshots: [] },
    ]);
    expect(s.seen).toHaveLength(1);
    expect(s.seen[0]!.method).toBe("GET");
    expect(s.seen[0]!.url.pathname).toBe(PATH);
    expect(s.seen[0]!.url.search).toBe("");
  });

  it("서버가 안 준 칸은 지어내지 않는다: attached 없음 → false, approved · recommended 없음 → false, label 빈 값 → null", async () => {
    const s = server(200, ok({ candidates: [{ project_id: "pj-c", key: "pj-c", label: "합성 C", snapshots: [{ id: "sn-9", key: "sn-9", label: "" }] }] }));
    const got = await (await make(s)).getReferenceCandidates({ slug: SLUG, edition: ED });
    expect(got).toEqual([{ project_id: "pj-c", key: "pj-c", label: "합성 C", attached: false, snapshots: [{ id: "sn-9", key: "sn-9", label: null, approved: false, recommended: false }] }]);
  });

  it("알 수 없는 모양은 버린다: id 없는 후보 · 객체가 아닌 줄 · id 없는 스냅숏", async () => {
    const s = server(
      200,
      ok({
        candidates: [
          "문자열",
          { key: "x", label: "id 없음", snapshots: [] },
          { project_id: "pj-d", key: "pj-d", label: "합성 D", attached: false, snapshots: [7, { key: "no-id" }, { id: "sn-4", key: "sn-4", label: null, approved: true, recommended: true }] },
        ],
      }),
    );
    const got = await (await make(s)).getReferenceCandidates({ slug: SLUG, edition: ED });
    expect(got.map((c) => c.project_id)).toEqual(["pj-d"]);
    expect(got[0]!.snapshots.map((x) => x.id)).toEqual(["sn-4"]);
  });

  it("candidates 가 배열이 아니면 PesApiError (빈 목록으로 삼키지 않는다)", async () => {
    const s = server(200, ok({ candidates: "x" }));
    await expect((await make(s)).getReferenceCandidates({ slug: SLUG, edition: ED })).rejects.toBeInstanceOf(PesApiError);
  });

  it.each([
    [401, "unauthenticated"],
    [403, "human_required"],
  ])("오류 봉투 전달: %i %s → PesApiError, 코드 보존", async (status, code) => {
    const s = server(status, fail(code));
    const err = await (await make(s)).getReferenceCandidates({ slug: SLUG, edition: ED }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PesApiError);
    expect((err as PesApiError).body.error.code).toBe(code);
  });

  it("서버 404 · 모르는 slug 는 [] (모르는 slug 는 요청 0)", async () => {
    const s = server(404, fail("not_found"));
    const c = await make(s);
    expect(await c.getReferenceCandidates({ slug: SLUG, edition: ED })).toEqual([]);
    const before = s.seen.length;
    expect(await c.getReferenceCandidates({ slug: "no-such-slug", edition: ED })).toEqual([]);
    expect(s.seen).toHaveLength(before);
  });

  it("scope=null(생성 화면): NotConnectedError, 요청 0", async () => {
    const s = server(200, ok({ candidates: [] }));
    await expect((await make(s)).getReferenceCandidates(null)).rejects.toBeInstanceOf(NotConnectedError);
    expect(s.seen).toHaveLength(0);
  });

  it("세션 헤더 x-pes-session · credentials omit", async () => {
    const s = server(200, ok({ candidates: [] }));
    await (await make(s)).getReferenceCandidates({ slug: SLUG, edition: ED });
    expect(s.seen[0]!.headers.get("x-pes-session")).toBe(SESSION);
    expect(s.seen[0]!.credentials).toBe("omit");
  });
});
