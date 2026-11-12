// SEL-112 최종 검토 1 필수 1 · 2 — HTTP 클라이언트가 실제 서버(U4a) 계약을 따르는지 (Vitest, fetch 는 가짜).
// 서버 근거(main): scripts/pes_core/commands/annotations.ts write_message — message_versions.state = 'published' 로 기록,
//   thread_reads.ts thread_detail — messages[].state 를 그대로 돌려준다. DB 제약: state IN ('published','edited','withdrawn') (migrations/001_initial.sql).
//   사건 이름: annotation.created · annotation.reanchored · thread.replied · thread.resolved · followup.proposed · followup.applied (annotations.ts).
// 합성 자료뿐(실제 자료·키·경로 없음).
import { describe, expect, it, vi } from "vitest";
import { WORKSPACE } from "@/api/fixture";
import { createHttpClient } from "@/api/http-client";
import { FORMAT_VERSION } from "@/api/types";

const SESSION = "synthetic-session-final";
const ID = "pj-synthetic-final";
const SLUG = WORKSPACE.slug;
const ED = WORKSPACE.edition;
const P = `/api/v1/projects/${ID}`;
const OBJ = "obj-r2-result";

const ok = (data: unknown) => ({ format_version: FORMAT_VERSION, request_id: "req-1", data });

function server(routes: Record<string, unknown>) {
  const impl = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input instanceof Request ? input.url : input), "http://app.invalid");
    const body = routes[url.pathname.replace(P, "")];
    if (body === undefined) return new Response(JSON.stringify({ format_version: FORMAT_VERSION, request_id: "e", error: { code: "not_found", message: "없음", retryable: false, next_action: "reread_context" } }), { status: 404 });
    return new Response(JSON.stringify(typeof body === "function" ? body(url) : body), { status: 200 });
  });
  return createHttpClient({ session: SESSION, projects: { [SLUG]: ID }, fetch: impl as unknown as typeof fetch });
}

/** 실제 thread_detail 모양의 메시지 한 줄 */
const msg = (id: string, state: string, body = `본문 ${id}`) => ({ id, version_id: `${id}-v`, body_md: body, state, reply_to: null, actor_id: "act-h1", created_at: "2026-11-12T05:00:00Z" });
const detail = (messages: unknown[]) =>
  ok({
    thread: { id: "th-1", context_kind: "annotation", state: "open", target_object_id: OBJ, target_version_id: "ver-1", summary: "요약", resolution: null },
    anchor: {
      id: "anc-1", exact_quote: "정책 대안은 두 가지다.", prefix: "1장 ", suffix: " 첫째는", text_format_version: 1, start_cp: 4, end_cp: 17, target_version_id: "ver-1", status: "exact",
      current: { evaluated_version_id: "ver-1", status: "exact", start_cp: 4, end_cp: 17, text: "정책 대안은 두 가지다.", candidates: [], confirmed_by_actor_id: null },
    },
    messages,
    followups: [],
  });

describe("필수 1 — 실제 서버의 메시지 상태(published · edited · withdrawn)", () => {
  const read = (messages: unknown[]) =>
    server({
      "/threads": ok({ threads: [{ id: "th-1", context_kind: "annotation", state: "open", target_object_id: OBJ, target_version_id: "ver-1", message_count: messages.length, anchor_status: "exact", summary: "요약" }] }),
      "/threads/th-1": detail(messages),
      "/followups": ok({ followups: [] }),
    }).getAnnotations(SLUG, ED, OBJ);

  it("서버가 쓴 그대로의 published 첨언 · 답글이 목록에 남는다", async () => {
    const [t] = await read([msg("m-1", "published", "근거를 더 설명해 주세요."), msg("m-2", "published", "답글입니다.")]);
    expect(t!.messages.map((m) => [m.message_id, m.body_md])).toEqual([
      ["m-1", "근거를 더 설명해 주세요."],
      ["m-2", "답글입니다."],
    ]);
  });

  it("edited(고친 메시지)도 지금 본문으로 보인다", async () => {
    const [t] = await read([msg("m-1", "edited", "고친 본문")]);
    expect(t!.messages.map((m) => m.body_md)).toEqual(["고친 본문"]);
  });

  it("withdrawn(거둔 메시지)의 본문은 보이지 않는다", async () => {
    const [t] = await read([msg("m-1", "published"), msg("m-2", "withdrawn", "거둔 본문")]);
    expect(t!.messages.map((m) => m.message_id)).toEqual(["m-1"]);
    expect(JSON.stringify(t)).not.toContain("거둔 본문");
  });
});

describe("필수 2 — 첨언 · 답글 · 해결 · 후속 사건이 라운드 읽기(첨언 포함)를 다시 읽게 한다", () => {
  const TYPES = ["annotation.created", "annotation.reanchored", "thread.replied", "thread.resolved", "followup.proposed", "followup.applied"];
  it.each(TYPES)("%s → touched 에 'round:*'", async (type) => {
    const client = server({ "/changes": ok({ events: [{ event_seq: "41", type, object_id: "obj-x", before_version_id: null, after_version_id: null, at: 1 }], next_cursor: "c-2", has_more: false, epoch: "1" }) });
    const out = await client.getChanges(SLUG, ED, "c-1");
    expect(out.txs).toHaveLength(1);
    expect(out.txs[0]!.touched).toContain("round:*");
    expect(out.txs[0]!.touched).toContain("workspace");
  });
});
