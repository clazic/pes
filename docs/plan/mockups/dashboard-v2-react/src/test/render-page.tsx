import type { ComponentType } from "react";
import type { RouteObject } from "react-router";
import { renderRoutes } from "@/test/render-app";

/**
 * 시험 도구 — 연구 공간 틀(WorkspaceLayout) 안의 화면 하나를 그리거나, 틀 없는 관리 화면 하나를 그린다.
 * 합성 자료와 목 클라이언트만 쓴다(네트워크 없음).
 */
export async function renderWorkspacePage(Component: ComponentType, sub: string, url: string) {
  const { WorkspaceLayout } = await import("@/features/workspace/WorkspaceLayout");
  const routes: RouteObject[] = [{ path: "p/:slug", Component: WorkspaceLayout, children: [{ path: sub, Component }] }];
  return renderRoutes(routes, url);
}

export async function renderBarePage(Component: ComponentType, path: string, url: string) {
  return renderRoutes([{ path, Component }], url);
}
