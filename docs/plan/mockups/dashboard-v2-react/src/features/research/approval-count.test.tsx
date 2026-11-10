import { screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { pes } from "@/api/mock-client";
import { mockSettings } from "@/lib/mock-settings";
import { approvalBlockers, researchUi } from "@/lib/research-ui";
import { renderRoutes, setViewport, workspaceRoutes } from "@/test/render-app";

/** F2 (설계 18.3-4) — 개요 · 지금 할 일 머리 · 승인 카드가 같은 수 · 같은 이름 “승인을 막는 것 n건” */

const SLUGS = ["dolbom-insight", "youth-housing", "rural-care-access", "ltc-survey"];

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  mockSettings.reset();
  researchUi.set({ focus: false, aiPanel: false, aiOnRound: false });
  setViewport(1440);
});

/** 합성 프로젝트가 서버 읽기로 받는 값에서 기대 수를 센다 */
async function expectedTotal(slug: string) {
  return approvalBlockers(await pes.getWorkspace(slug)).total;
}

describe("F2 — 승인을 막는 것 n건", () => {
  it("전제: 합성 프로젝트에 승인을 막는 것이 1건 이상인 곳이 있다", async () => {
    const totals = await Promise.all(SLUGS.map(expectedTotal));
    expect(Math.max(...totals)).toBeGreaterThan(0);
  });

  it("개요 · 지금 할 일 머리 · 승인 카드가 모두 같은 수와 같은 이름을 쓴다(돌봄 프로젝트)", async () => {
    const n = await expectedTotal("dolbom-insight");
    expect(n).toBeGreaterThan(0);
    const label = `승인을 막는 것 ${n}건`;

    // 1) 개요
    const overview = await renderRoutes(await workspaceRoutes(), "/p/dolbom-insight");
    const list = await screen.findByRole("list", { name: label }, { timeout: 4000 });
    expect(list).toBeInTheDocument();
    expect(screen.getByText(label, { selector: "p" })).toBeInTheDocument();
    overview.unmount();

    // 2) 지금 할 일 머리(승인 단계 보는 중) + 3) 승인 카드 — 같은 화면 안에서
    await renderRoutes(await workspaceRoutes(), "/p/dolbom-insight/e/1/s/research/r/2?t=approve");
    await screen.findAllByRole("heading", { name: /단계 승인/, level: 2 }, { timeout: 4000 });
    const head = document.querySelector("section[aria-labelledby='now-title']") as HTMLElement;
    const card = document.querySelector("[aria-labelledby='ap-t']") as HTMLElement;
    expect(head).not.toBeNull();
    expect(card).not.toBeNull();
    expect(within(head).getByText(label)).toBeInTheDocument();
    expect(within(card).getByText(label, { selector: "p" })).toBeInTheDocument();
  });

  it.each(SLUGS)("%s — 세 화면의 수가 approvalBlockers().total과 같다", async (slug) => {
    const n = await expectedTotal(slug);
    const label = `승인을 막는 것 ${n}건`;
    const ws = await pes.getWorkspace(slug);
    const round = `/p/${slug}/e/${ws.edition}/s/${ws.current.stage}/r/${ws.current.round}`;

    const overview = await renderRoutes(await workspaceRoutes(), `/p/${slug}`);
    await screen.findByRole("heading", { level: 1 }, { timeout: 4000 });
    if (n) expect(await screen.findByText(label, { selector: "p" })).toBeInTheDocument();
    else expect(screen.queryByText(/승인을 막는 것/)).not.toBeInTheDocument();
    overview.unmount();

    await renderRoutes(await workspaceRoutes(), `${round}?t=approve`);
    await screen.findByRole("heading", { level: 1 }, { timeout: 4000 });
    if (n) {
      expect(await screen.findAllByText(label)).not.toHaveLength(0);
    } else {
      expect(screen.queryByText(/승인을 막는 것/)).not.toBeInTheDocument();
    }
  });

  it("화면 어디에도 옛 말 “이유 n가지”가 승인 수로 쓰이지 않는다", async () => {
    await renderRoutes(await workspaceRoutes(), "/p/dolbom-insight/e/1/s/research/r/2?t=approve");
    await screen.findAllByRole("heading", { name: /단계 승인/, level: 2 }, { timeout: 4000 });
    expect(document.body.textContent).not.toMatch(/이유\s*\d+\s*가지/);
  });
});
