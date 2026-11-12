// SEL-101 — 개발 서버 주소 `/` → vite base 로 `/_app/` · 짧은 프로젝트 주소 `/p/<slug>/` 가 '찾을 수 없음'이 아니라 현재 위치로 간다 (Vitest, jsdom, 작성 모드).
//
// 해석 (이슈 완료 조건 — 구현을 추측하지 않고 요구사항에서 뽑았다):
//   - 브라우저 주소가 `/_app/` 또는 `/_app`(vite base 에서 온 첫 주소)이면 앱 라우터가 `/` 와 똑같이 HomeRedirect 처럼 현재 위치로 보낸다.
//   - 브라우저 주소가 `/p/<slug>` 또는 `/p/<slug>/`(판·단계·라운드 없음)이면 그 프로젝트(slug)의 현재 위치로 보낸다. 현재 위치 = 클라이언트가 돌려주는 listProjects()[slug].current.
//   - 이동은 replace(뒤로 가기에 빈 주소를 남기지 않는다). 쿼리·조각은 요구사항에 없어 시험하지 않는다.
//   - 없는 slug 는 지금처럼 '찾을 수 없음' 안내(가짜 현재 위치를 지어내지 않는다). 모르는 주소도 그대로 '찾을 수 없음'.
//   - 이미 있는 딥링크(`/p/<slug>/e/<판>/s/<단계>/r/<라운드>`, `/p/<slug>/e/<판>/records`)와 `/` 는 그대로(회귀 가드).
// 새 인터페이스 이름은 없다 — `@/app/routes` 의 routes · createRoutes({ client }) 그대로.
import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createFakeClient } from "@/api/fake-client";
import type { PesClient, ProjectRef } from "@/api/types";
import { renderApp } from "@/test/render-app";
import { CURRENT, EDITION, SLUG, STAGE_START, url } from "@/test/contract";

const title = async () => {
  const main = await screen.findByRole("main");
  await waitFor(() => expect(main.querySelector("[data-screen-title]")).not.toBeNull());
  return main.querySelector("[data-screen-title]") as HTMLElement;
};

/** 위치로 도착했는지: 주소가 정확히 expected 이고 화면 제목이 그 라운드 */
async function expectArrived(router: { state: { location: { pathname: string }; historyAction: string } }, expected: string, heading: RegExp) {
  await waitFor(() => expect(router.state.location.pathname).toBe(expected));
  expect((await title()).textContent).toMatch(heading);
  expect(screen.queryByText(/찾을 수 없/)).toBeNull();
}

describe("회귀 가드 — 이미 되는 주소", () => {
  it("`/` 는 현재 위치(조사 R2)로 간다", async () => {
    const { router } = await renderApp("/");
    await expectArrived(router, CURRENT, /조사 R2/);
  });

  it("딥링크 · records 주소는 그대로 열린다", async () => {
    const a = await renderApp(CURRENT);
    expect((await title()).textContent).toMatch(/조사 R2/);
    a.unmount();
    const b = await renderApp(STAGE_START);
    expect((await title()).textContent).toMatch(/조사 단계 시작/);
    b.unmount();
    const { router } = await renderApp(`/p/${SLUG}/e/${EDITION}/records`);
    await waitFor(() => expect(router.state.location.pathname).toBe(`/p/${SLUG}/e/${EDITION}/records`));
    expect(screen.queryByText(/찾을 수 없/)).toBeNull();
  });

  it("모르는 주소 · 없는 라운드는 '찾을 수 없음'", async () => {
    const a = await renderApp("/nope/zzz");
    expect(await screen.findByText(/찾을 수 없/)).toBeInTheDocument();
    a.unmount();
    await renderApp(url("research", 0));
    expect(await screen.findByText(/찾을 수 없/)).toBeInTheDocument();
  });

  it("`/p/`(slug 없음)와 `/p/<slug>/e/<판>`(단계·라운드 없음)은 새 계약 밖이라 지금처럼 '찾을 수 없음'", async () => {
    const a = await renderApp("/p/");
    expect(await screen.findByText(/찾을 수 없/)).toBeInTheDocument();
    a.unmount();
    await renderApp(`/p/${SLUG}/e/${EDITION}`);
    expect(await screen.findByText(/찾을 수 없/)).toBeInTheDocument();
  });
});

describe("`/_app/` (vite base) = `/` 와 같이 현재 위치로", () => {
  for (const path of ["/_app/", "/_app"]) {
    it(`${path} → 현재 위치 조사 R2 (replace)`, async () => {
      const { router } = await renderApp(path);
      await expectArrived(router, CURRENT, /조사 R2/);
      expect(router.state.historyAction).toBe("REPLACE");
    });
  }
});

describe("`/p/<slug>/` (판·단계·라운드 없음) = 그 프로젝트의 현재 위치로", () => {
  for (const path of [`/p/${SLUG}/`, `/p/${SLUG}`]) {
    it(`${path} → 현재 위치 조사 R2 (replace)`, async () => {
      const { router } = await renderApp(path);
      await expectArrived(router, CURRENT, /조사 R2/);
      expect(router.state.historyAction).toBe("REPLACE");
    });
  }

  it("현재 위치는 프로젝트의 판·단계·라운드 그대로다 — 클라이언트가 단계 시작(round_id=null)을 주면 r/start", async () => {
    const base = createFakeClient();
    const client: PesClient = {
      ...base,
      listProjects: async (): Promise<ProjectRef[]> => [{ slug: SLUG, edition: Number(EDITION), current: { stage: "research", round_id: null } }],
    };
    const { router } = await renderApp(`/p/${SLUG}/`, {}, { client });
    await expectArrived(router, STAGE_START, /조사 단계 시작/);
  });

  it("프로젝트가 여럿이면 `/` 가 아니라 주소의 slug 의 프로젝트로 간다", async () => {
    const base = createFakeClient();
    const second: ProjectRef = { slug: "other-study", edition: 3, current: { stage: "plan", round_id: 4 } };
    const client: PesClient = {
      ...base,
      listProjects: async (): Promise<ProjectRef[]> => [...(await base.listProjects()), second],
    };
    const { router } = await renderApp("/p/other-study/", {}, { client });
    await waitFor(() => expect(router.state.location.pathname).toBe("/p/other-study/e/3/s/plan/r/4"));
  });

  it("없는 slug 는 '찾을 수 없음' 안내이고 주소는 그대로(다른 프로젝트로 보내지 않는다)", async () => {
    const { router } = await renderApp("/p/no-such-study/");
    expect(await screen.findByText(/찾을 수 없/)).toBeInTheDocument();
    expect(router.state.location.pathname).toMatch(/^\/p\/no-such-study\/?$/);
    expect(document.body.textContent).not.toMatch(/조사 R2/);
  });
});
