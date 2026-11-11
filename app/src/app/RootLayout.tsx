import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Outlet, ScrollRestoration } from "react-router";
import { ClientContext } from "@/api/queries";
import { selectClient } from "@/api/select-client";
import { readSidebarOpen, SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ArrivalContext, useArrivalRoot } from "./arrival";
import { AppSidebar } from "./AppSidebar";
import { SiteHeader } from "./SiteHeader";

/**
 * 서버 자료는 TanStack Query 가 맡는다(설계 12.5) — 폴링 없음 · 창 초점 재조회 없음 · 시간으로 다시 받지 않음.
 * 클라이언트는 selectClient 가 고른다 — 기본은 앱 안 가짜 클라이언트(합성 자료), window.__PES_APP__ 설정이 있으면 서버 HTTP 클라이언트(U1b). 루트마다 새로 만들어 상태가 새지 않는다.
 */
function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false, retry: 0 },
      mutations: { retry: 0 },
    },
  });
}

/** 사이드바 처음 상태: 사람이 접었거나 편 기록(이 브라우저의 localStorage)이 있으면 그대로, 없으면 1280px 이상에서만 펼침(승인 시안과 같음). 쿠키는 쓰지 않는다 */
function initialSidebarOpen() {
  return readSidebarOpen() ?? window.innerWidth >= 1280;
}

/**
 * 앱 셸(설계 12.9 · 결정 0017 영향 12, 승인 시안 RootLayout 그대로의 틀): 건너뛰기 링크(첫 Tab) · shadcn sidebar-07 사이드바 ·
 * 붙어 있는 머리줄 · 화면(Outlet = 연구 공간 틀). 본문 `<main>` 은 화면이 하나만 그린다(질문 영역 aside 는 main 밖 최상위 랜드마크).
 * 공급자(Query · 클라이언트 · 도착 초점)는 여기서 만든다 — routes 만으로 앱이 완결된다.
 */
export function RootLayout() {
  const [queryClient] = React.useState(makeQueryClient);
  const [client] = React.useState(() => selectClient(window));
  const arrival = useArrivalRoot();
  const [sidebarOpen] = React.useState(initialSidebarOpen);
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
          <TooltipProvider>
            <SidebarProvider defaultOpen={sidebarOpen}>
              <AppSidebar />
              <SidebarInset className="min-w-0">
                <SiteHeader />
                <Outlet />
              </SidebarInset>
            </SidebarProvider>
          </TooltipProvider>
          {/* 뒤로·앞으로 가기에서 스크롤 자리를 되살린다. 같은 화면의 검색어만 바꾸는 이동은 preventScrollReset 으로 건드리지 않는다 */}
          <ScrollRestoration />
        </ArrivalContext.Provider>
      </ClientContext.Provider>
    </QueryClientProvider>
  );
}
