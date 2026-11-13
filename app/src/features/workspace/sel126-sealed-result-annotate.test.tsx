// SEL-126 최종 2/2 필수 1 — 활성 판의 봉인(closed) 라운드 결과 글에서도 첨언 · 선택 도구가 켜진다. 막는 기준은 '활성 판인가'(지난 판은 계속 읽기 전용).
// 실제 HTTP 클라이언트의 getRound 매핑(가짜 fetch · 서버 봉인 응답 state:"closed" + result)을 WorkspaceScreen 에 그대로 통과시킨다. 나머지 읽기·쓰기는 U4 가짜 클라이언트.
import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpClient } from "@/api/http-client";
import { WORKSPACE } from "@/api/fixture";
import { FORMAT_VERSION, type PesClient } from "@/api/types";
import { BODY, OBJ, QUOTE_A, VER1, R2, blockWith, blocks, clearSelection, createU4Client, selectText, toolbar } from "@/test/sel112";
import { renderApp, type Env } from "@/test/render-app";
import { ready } from "@/test/ui";

afterEach(() => {
  cleanup();
  clearSelection();
});

const ID = "pj-synthetic-126f2";
const P = `/api/v1/projects/${ID}`;
const SLUG = WORKSPACE.slug;
const ED = WORKSPACE.edition;

/** 서버 봉인 응답 모양 — 봉인한 라운드는 state:"closed", result 는 봉인 때 담긴 글 */
const roundBody = (state: "closed" | "current") => ({
  format_version: FORMAT_VERSION,
  request_id: "req-126f2",
  data: { edition: ED, stage: "research", round_id: 2, server_round_id: "rnd-2", state, set_id: null, form_version: null, questions: [], result: { object_id: OBJ, version_id: VER1, body_md: BODY } },
});

/** 실제 HTTP getRound(가짜 fetch) + 나머지는 U4 가짜. editionOverride = listProjects 가 말하는 활성 판 번호 */
function boot(state: "closed" | "current", opts: { activeEdition?: number; env?: Env } = {}) {
  const u4 = createU4Client();
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input), "http://app.invalid");
    const key = `${(init?.method ?? "GET").toUpperCase()} ${url.pathname.replace(P, "")}`;
    if (key === "GET /stages/research/rounds/2") return new Response(JSON.stringify(roundBody(state)), { status: 200 });
    return new Response("{}", { status: 404 });
  });
  const http = createHttpClient({ session: "synthetic-session-126f2", projects: { [SLUG]: ID }, fetch: fetchImpl as unknown as typeof fetch });
  const client: PesClient = {
    ...u4.client,
    getRound: http.getRound,
    ...(opts.activeEdition === undefined ? {} : { listProjects: async () => [{ slug: SLUG, edition: opts.activeEdition!, current: WORKSPACE.current }] }),
  };
  return renderApp(R2, { width: 1440, ...opts.env }, { client }).then(async (app) => {
    await ready();
    return { app, u4, fetchImpl };
  });
}

const annotateButton = () => screen.getByRole("button", { name: "첨언 쓰기" });

describe("활성 판의 봉인 라운드 — 첨언·선택 도구 허용", () => {
  it("state:'closed' + result(활성 판) → '첨언 쓰기'가 켜지고 본문을 고르면 도구줄이 뜬다", async () => {
    await boot("closed");
    await blocks();
    expect(annotateButton()).not.toHaveAttribute("aria-disabled", "true");
    selectText(blockWith(QUOTE_A), QUOTE_A);
    await waitFor(() => expect(toolbar()).not.toBeNull());
  });

  it("지난 라운드 안내(읽기 전용 · 질문 고치기 막힘)는 그대로 — 첨언만 판 기준", async () => {
    await boot("closed");
    await blocks();
    expect(screen.getByText(/지난 라운드 · 보는 중/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "질문 고치기" })).toHaveAttribute("aria-disabled", "true");
  });

  it("지난 판(활성 판 번호가 더 큼) → closed 여도 current 여도 계속 차단 — 도구줄 없음", async () => {
    for (const state of ["closed", "current"] as const) {
      await boot(state, { activeEdition: ED + 1 });
      await blocks();
      expect(annotateButton()).toHaveAttribute("aria-disabled", "true");
      selectText(blockWith(QUOTE_A), QUOTE_A);
      expect(toolbar()).toBeNull();
      cleanup();
      clearSelection();
    }
  });

  it("대조군: state:'current'(활성 판) → 켜짐 유지", async () => {
    await boot("current");
    await blocks();
    expect(annotateButton()).not.toHaveAttribute("aria-disabled", "true");
    selectText(blockWith(QUOTE_A), QUOTE_A);
    await waitFor(() => expect(toolbar()).not.toBeNull());
  });

  it("휴대폰은 활성 판이어도 계속 차단", async () => {
    await boot("closed", { env: { width: 390, coarse: true } });
    await blocks();
    expect(annotateButton()).toHaveAttribute("aria-disabled", "true");
    selectText(blockWith(QUOTE_A), QUOTE_A);
    expect(toolbar()).toBeNull();
  });
});
