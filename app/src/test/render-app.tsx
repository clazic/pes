import { render } from "@testing-library/react";
import { createMemoryRouter, RouterProvider, type RouteObject } from "react-router";

/**
 * 시험 도구 — 화면 폭·굵은 포인터 흉내 + 메모리 라우터로 앱 전체(routes)를 그린다.
 * routes 는 `@/app/routes` 가 내보낸다(계약: src/test/contract.ts). 네트워크는 쓰지 않는다.
 */

export interface Env {
  width?: number;
  coarse?: boolean;
}

export function setEnv({ width = 1440, coarse = false }: Env = {}) {
  const evaluate = (query: string) => {
    if (/pointer:\s*coarse/.test(query)) return coarse;
    if (/pointer:\s*fine/.test(query)) return !coarse;
    if (/hover:\s*none/.test(query)) return coarse;
    const conds = [...query.matchAll(/\((min|max)-width:\s*([\d.]+)px\)/g)];
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

  const g = globalThis as unknown as Record<string, unknown>;
  g.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.scrollIntoView ??= () => {};
  proto.hasPointerCapture ??= () => false;
  proto.releasePointerCapture ??= () => {};
  window.scrollTo = () => {};
}

export async function renderApp(url: string, env: Env = {}) {
  setEnv(env);
  // import.meta.glob: 파일이 아직 없어도 파일 전체가 죽지 않고, 시험마다 아래 메시지로 실패한다
  const found = import.meta.glob<{ routes: RouteObject[] }>("/src/app/routes.{ts,tsx}");
  const loader = Object.values(found)[0];
  if (!loader) throw new Error("src/app/routes.tsx 가 없다 — 계약: `routes: RouteObject[]` 를 내보낸다(src/test/contract.ts)");
  const { routes } = await loader();
  const router = createMemoryRouter(routes, { initialEntries: [url] });
  const view = render(<RouterProvider router={router} />);
  return { ...view, router };
}

/** 현재 주소의 쿼리 */
export const query = (router: { state: { location: { search: string } } }) => new URLSearchParams(router.state.location.search);
