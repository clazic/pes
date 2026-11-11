import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Outlet, ScrollRestoration, useMatch } from "react-router";
import { createFakeClient } from "@/api/fake-client";
import { ClientContext, useWorkspace } from "@/api/queries";
import { ArrivalContext, useArrivalRoot } from "./arrival";
import { ThemeMenu } from "./ThemeMenu";

/**
 * 서버 자료는 TanStack Query 가 맡는다(설계 12.5) — 폴링 없음 · 창 초점 재조회 없음 · 시간으로 다시 받지 않음.
 * U1a 의 클라이언트는 앱 안 가짜 클라이언트(합성 자료)다. 루트마다 새로 만들어 상태가 새지 않는다.
 */
function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false, retry: 0 },
      mutations: { retry: 0 },
    },
  });
}

function SiteHeader() {
  const m = useMatch("/p/:slug/e/:edition/*");
  const edition = Number(m?.params.edition ?? 0);
  const ws = useWorkspace(m?.params.slug, edition).data;
  return (
    <header className="app-header sticky top-0 z-30 flex h-14 items-center gap-3 border-b bg-background/95 px-3 backdrop-blur-sm tab:px-5">
      <span className="shrink-0 text-meta font-bold tracking-wide text-ink">PES</span>
      {ws ? (
        <>
          <span aria-hidden="true" className="h-5 w-px shrink-0 bg-border" />
          <p className="min-w-0 truncate text-meta">
            <span className="font-semibold text-ink">{ws.title}</span>
            <span className="text-muted-foreground"> · 판 {ws.edition}</span>
          </p>
        </>
      ) : null}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <ThemeMenu />
      </div>
    </header>
  );
}

/**
 * 앱 셸(설계 12.9): 건너뛰기 링크(첫 Tab) · 붙어 있는 머리줄 · 화면(Outlet). 본문 `<main>` 은 화면이 하나만 그린다.
 * 공급자(Query · 클라이언트 · 도착 초점)는 여기서 만든다 — routes 만으로 앱이 완결된다.
 */
export function RootLayout() {
  const [queryClient] = React.useState(makeQueryClient);
  const [client] = React.useState(createFakeClient);
  const arrival = useArrivalRoot();
  return (
    <QueryClientProvider client={queryClient}>
      <ClientContext.Provider value={client}>
        <ArrivalContext.Provider value={arrival}>
          <a
            href="#main"
            className="skip-link absolute -top-16 left-3 z-50 rounded-md border-2 border-primary bg-background px-3 py-2 font-semibold text-primary-ink no-underline focus:top-3"
            onClick={(e) => {
              e.preventDefault();
              document.getElementById("main")?.focus();
            }}
          >
            본문으로 건너뛰기
          </a>
          <SiteHeader />
          <Outlet />
          <ScrollRestoration />
        </ArrivalContext.Provider>
      </ClientContext.Provider>
    </QueryClientProvider>
  );
}
