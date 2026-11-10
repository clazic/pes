import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { createMemoryRouter, RouterProvider, type RouteObject } from "react-router";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * 시험 도구 — 화면 폭 흉내 · 시안 화면을 메모리 라우터로 그리기. 합성 자료(src/mocks)와 목 클라이언트만 쓴다(네트워크 없음).
 */

/** jsdom에 없는 matchMedia를 폭 기준으로 흉내 낸다(min/max-width만 계산, 굵은 포인터는 늘 “아님”) */
export function setViewport(width: number) {
  const evaluate = (query: string) => {
    const conds = [...query.matchAll(/\((min|max)-width:\s*([\d.]+)px\)/g)];
    if (/pointer:\s*coarse/.test(query)) return false;
    return conds.every(([, kind, px]) => (kind === "min" ? width >= Number(px) : width <= Number(px)));
  };
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  window.matchMedia = (query: string) =>
    ({
      matches: evaluate(query),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

/** Radix 부품이 쓰는 브라우저 기능 중 jsdom에 없는 것 */
export function installDomStubs() {
  const g = globalThis as unknown as Record<string, unknown>;
  if (!g.ResizeObserver) {
    g.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.scrollIntoView ??= () => {};
  proto.hasPointerCapture ??= () => false;
  proto.releasePointerCapture ??= () => {};
  window.scrollTo = () => {};
}

/** 라우터 경로 → 시안 화면. 화면 묶음을 지연 불러오지 않고 바로 가져온다. */
export async function renderRoutes(routes: RouteObject[], url: string, extra?: ReactNode) {
  installDomStubs();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: 0 } } });
  const router = createMemoryRouter(routes, { initialEntries: [url] });
  const view = render(
    <QueryClientProvider client={client}>
      <TooltipProvider delayDuration={300}>
        <RouterProvider router={router} />
        {extra}
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return { ...view, router };
}

/** 연구 공간 화면 셋(개요 · 지금 할 일) */
export async function workspaceRoutes(): Promise<RouteObject[]> {
  const [{ WorkspaceLayout }, { OverviewPage }, { RoundPage }] = await Promise.all([
    import("@/features/workspace/WorkspaceLayout"),
    import("@/features/research/OverviewPage"),
    import("@/features/workspace/RoundPage"),
  ]);
  return [
    {
      path: "p/:slug",
      Component: WorkspaceLayout,
      children: [
        { index: true, Component: OverviewPage },
        { path: "e/:ed/s/:stage/r/:round", Component: RoundPage },
      ],
    },
  ];
}
