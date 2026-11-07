import * as React from "react";
import { Outlet, useLocation } from "react-router";
import { Toaster } from "@/components/ui/sonner";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { useChangeFeed, useRefreshState } from "@/api/queries";
import { OfflineBanner } from "@/components/pes/blocks";
import { useLiveText, useMockSettings } from "@/lib/mock-settings";
import { CommandMenu, useCommandMenu } from "./CommandMenu";
import { SiteHeader } from "./SiteHeader";
import { TurnAnnouncer } from "./TurnAnnouncer";

export type { MockHandle } from "./MockControls";

/** 주소의 #조각으로 이동: 자료가 늦게 오면 잠시 기다렸다가 찾고, 초점도 옮긴다(키보드 사용자). */
function useScrollToHash() {
  const { hash, pathname } = useLocation();
  React.useEffect(() => {
    if (!hash) {
      window.scrollTo({ top: 0 });
      return;
    }
    const id = decodeURIComponent(hash.slice(1));
    let tries = 0;
    const t = window.setInterval(() => {
      const el = document.getElementById(id);
      tries += 1;
      if (el) {
        window.clearInterval(t);
        el.scrollIntoView({ block: "start" });
        if (!el.hasAttribute("tabindex") && !/^(A|BUTTON|INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) el.setAttribute("tabindex", "-1");
        el.focus({ preventScroll: true });
      } else if (tries > 30) {
        window.clearInterval(t);
      }
    }, 60);
    return () => window.clearInterval(t);
  }, [hash, pathname]);
}

/** 사이드바 처음 상태: 사용자가 접었거나 편 기록(shadcn sidebar 쿠키)이 있으면 그대로, 없으면 1280px 이상에서만 펼침. */
function initialSidebarOpen() {
  const m = document.cookie.match(/(?:^|; )sidebar_state=(true|false)/);
  if (m) return m[1] === "true";
  return window.innerWidth >= 1280;
}

/**
 * 앱 셸(설계 12.9): shadcn sidebar-07 블록(아이콘으로 접힘) + shadcn-admin 구조를 참고한 머리줄.
 * 첫 Tab은 “본문으로 건너뛰기”. 본문 <main>은 하나(SidebarInset은 div로 고침).
 * 3차 정리: 본문 맨 위 “시안 설명 띠”를 없애고 머리줄의 작은 “시안” 단추(MockDock) 하나로 접었다.
 */
export function RootLayout() {
  const liveText = useLiveText();
  const refresh = useRefreshState();
  const cmd = useCommandMenu();
  const s = useMockSettings();
  const [defaultOpen] = React.useState(initialSidebarOpen);
  useChangeFeed("*");
  useScrollToHash();
  React.useEffect(() => {
    document.documentElement.dataset.mockNotes = s.showNotes ? "show" : "hide";
  }, [s.showNotes]);

  return (
    <>
      <a
        href="#main"
        className="skip-link absolute top-[-60px] left-3 z-[100] rounded-md border-2 border-primary bg-background px-3 py-2 font-semibold text-primary-ink no-underline focus:top-3"
      >
        본문으로 건너뛰기
      </a>
      <SidebarProvider defaultOpen={defaultOpen}>
        <AppSidebar />
        <SidebarInset className="min-w-0">
          <SiteHeader onSearch={() => cmd.setOpen(true)} />
          {refresh === "offline" ? <OfflineBanner className="mx-3 mt-3 tab:mx-6" /> : null}
          <main id="main" tabIndex={-1} className="@container/main mx-auto w-full max-w-[1600px] min-w-0 flex-1 px-3 pt-4 pb-12 outline-none tab:px-6 tab:pt-5">
            {/* 사람이 할 일이 생긴 사건만 조용히 알린다(설계 3.5) */}
            <p className="sr-only" role="status" aria-live="polite">
              {liveText}
            </p>
            {/* 차례 전환(→ 나의 할 일 · 끝남)만 한 번 알린다(설계 15.4) — 표시기가 여러 개여도 여기 한 곳 */}
            <TurnAnnouncer />
            <Outlet />
          </main>
        </SidebarInset>
      </SidebarProvider>
      <CommandMenu open={cmd.open} onOpenChange={cmd.setOpen} />
      <Toaster position="bottom-right" />
    </>
  );
}
