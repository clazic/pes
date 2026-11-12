// SEL-101 최종 리뷰 1/2 수정 — /p/<slug>/ 짧은 주소 리다이렉트 (Vitest, jsdom).
//   - 필수: 프로젝트 목록 조회 실패(503·네트워크 오류)를 '프로젝트 없음'으로 단정하지 않는다. 조회 실패는 앱의 기존 읽기 실패 표시(불러오지 못했어요 · 다시 읽기)로,
//     '찾을 수 없음'은 목록을 받았는데 slug 가 없을 때만. 다시 읽기가 성공하면 현재 위치로 replace 이동.
//   - 권장: 리다이렉트가 검색어(view · focus · peek · print)를 버리지 않는다.
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createFakeClient } from "@/api/fake-client";
import type { PesClient, ProjectRef } from "@/api/types";
import { renderApp } from "@/test/render-app";
import { CURRENT, SLUG } from "@/test/contract";

describe("프로젝트 목록 조회 실패는 '찾을 수 없음'이 아니다", () => {
  it("reject → 읽기 실패 안내 + 다시 읽기 → 성공하면 현재 위치로 replace 이동", async () => {
    const base = createFakeClient();
    let calls = 0;
    const client: PesClient = {
      ...base,
      listProjects: async (): Promise<ProjectRef[]> => {
        calls += 1;
        if (calls === 1) throw new Error("503");
        return base.listProjects();
      },
    };
    const { router } = await renderApp(`/p/${SLUG}/`, {}, { client });
    expect(await screen.findByText("불러오지 못했어요.")).toBeInTheDocument();
    expect(screen.queryByText(/찾을 수 없/)).toBeNull();
    expect(screen.queryByText(/라운드 번호나 단계 이름/)).toBeNull();
    expect(router.state.location.pathname).toMatch(/^\/p\/[^/]+\/?$/);

    fireEvent.click(screen.getByRole("button", { name: "다시 읽기" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(CURRENT));
    expect(router.state.historyAction).toBe("REPLACE");
    expect(screen.queryByText("불러오지 못했어요.")).toBeNull();
  });

  it("목록은 받았는데 slug 가 없으면 여전히 '찾을 수 없음'(읽기 실패 안내 아님)", async () => {
    await renderApp("/p/no-such-study/");
    expect(await screen.findByText(/찾을 수 없/)).toBeInTheDocument();
    expect(screen.queryByText("불러오지 못했어요.")).toBeNull();
  });
});

describe("짧은 주소의 검색어는 목적지까지 간다", () => {
  it("view · focus · peek · print 를 그대로 가져간다", async () => {
    const { router } = await renderApp(`/p/${SLUG}/?view=ask&focus=tool-print&peek=q1&print=1`);
    await waitFor(() => expect(router.state.location.pathname).toBe(CURRENT));
    const sp = new URLSearchParams(router.state.location.search);
    expect(sp.get("view")).toBe("ask");
    expect(sp.get("focus")).toBe("tool-print");
    expect(sp.get("peek")).toBe("q1");
    expect(sp.get("print")).toBe("1");
    expect(router.state.historyAction).toBe("REPLACE");
  });

  it("slug 뒤 슬래시가 없는 주소도 검색어를 가져간다", async () => {
    const { router } = await renderApp(`/p/${SLUG}?view=ask`);
    await waitFor(() => expect(router.state.location.pathname).toBe(CURRENT));
    expect(router.state.location.search).toBe("?view=ask");
  });
});
