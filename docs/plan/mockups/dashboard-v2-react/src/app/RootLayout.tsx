import * as React from "react";
import { Outlet, ScrollRestoration, useLocation, useNavigationType } from "react-router";
import { Toaster } from "@/components/ui/sonner";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { useChangeFeed, useRefreshState } from "@/api/queries";
import { OfflineBanner } from "@/components/pes/blocks";
import { useLiveText, useMockSettings } from "@/lib/mock-settings";
import { CommandMenu, useCommandMenu } from "./CommandMenu";
import { FocusModeSync } from "./FocusModeSync";
import { SiteHeader } from "./SiteHeader";
import { TurnAnnouncer } from "./TurnAnnouncer";

export type { MockHandle } from "./MockControls";

/** 화면이 바뀐 뒤 초점을 둘 제목: 화면이 정한 자리(data-route-target · 마법사 칸 제목) → 지금 할 일 단계 제목 → (연구 개요는 프로젝트 제목) → 연구 공간 화면의 첫 제목 → 쪽 제목(h1) */
function routeFocusTarget(pathname: string): HTMLElement | null {
  const main = document.getElementById("main");
  if (!main) return null;
  const now = main.querySelector<HTMLElement>("[data-route-target]") ?? main.querySelector<HTMLElement>("#now-title");
  if (now) return now;
  if (/^\/p\/[^/]+\/?$/.test(pathname)) return main.querySelector<HTMLElement>("#ptitle");
  // 화면이 이미 정해 둔 초점 자리(제목 안 tabIndex=-1, 예: 막힌 것 보드의 #pb-title)가 있으면 그것
  const h = main.querySelector<HTMLElement>("[data-page] :is(h2, h3)");
  return h?.querySelector<HTMLElement>('[tabindex="-1"]') ?? h ?? main.querySelector<HTMLElement>("h1");
}

/**
 * 주소가 바뀔 때(6차 — 탐색 · 접근성):
 *  - #조각: 자료가 늦게 오면 잠시 기다렸다가 그 자리로 옮기고 초점도 옮긴다(키보드 사용자) — 처음 불러올 때와 앞으로 갈 때.
 *  - 다른 화면(경로) · 지금 할 일 단계(?t=) · 마법사 칸(?step=)으로 옮기면: 초점을 새 화면 제목으로(누른 링크 · 명령 메뉴에 남지 않게).
 *    열린 판·대화 상자(휴대폰 사이드바 · 명령 메뉴)가 닫히며 초점을 되돌린 뒤에 옮긴다. 처음 불러올 때는 옮기지 않는다(첫 Tab = 건너뛰기 링크).
 *  - 스크롤: 앞으로 가면 맨 위, 뒤로·앞으로 가기(POP)는 ScrollRestoration이 그 자리를 되살린다.
 */
function useRouteArrival() {
  const { hash, pathname, search, key } = useLocation();
  const navType = useNavigationType();
  // 처음 불러온 기록 칸(key)에 머무는 동안은 “처음”으로 본다 — 개발 모드(StrictMode)에서 효과가 두 번 돌아도 같은 판단
  const firstKey = React.useRef(key);
  const moved = React.useRef(false);
  const prev = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (key !== firstKey.current) moved.current = true;
    const initial = !moved.current;
    // 화면 = 경로 + 지금 할 일 단계(?t=) + 마법사 칸(?step=). 그 밖의 검색어는 같은 화면으로 본다
    const sp = new URLSearchParams(search);
    const page = `${pathname}?t=${sp.get("t") ?? ""}&step=${sp.get("step") ?? ""}`;
    const changed = prev.current !== null && prev.current !== page;
    prev.current = page;
    let tries = 0;
    let clear = 0;
    let t = 0;
    if (hash) {
      if (!initial && navType === "POP") return;
      const id = decodeURIComponent(hash.slice(1));
      t = window.setInterval(() => {
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
    }
    if (initial || !changed) return;
    t = window.setInterval(() => {
      tries += 1;
      // 판·대화 상자가 닫히며 연 단추로 초점을 되돌린 다음에 옮긴다(닫힌 뒤 한 번 더 기다림 — radix가 초점을 돌려주는 때)
      clear = document.querySelector('[role="dialog"], [role="alertdialog"]') ? 0 : clear + 1;
      const el = clear < 2 ? null : routeFocusTarget(pathname);
      if (el) {
        window.clearInterval(t);
        if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
        el.setAttribute("data-route-focus", "");
        el.focus({ preventScroll: true });
      } else if (tries > 40) {
        window.clearInterval(t);
      }
    }, 60);
    return () => window.clearInterval(t);
  }, [hash, pathname, search, navType, key]);
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
  useRouteArrival();
  React.useEffect(() => {
    document.documentElement.dataset.mockNotes = s.showNotes ? "show" : "hide";
  }, [s.showNotes]);

  return (
    <>
      <a
        href="#main"
        className="skip-link absolute top-[-60px] left-3 z-100 rounded-md border-2 border-primary bg-background px-3 py-2 font-semibold text-primary-ink no-underline focus:top-3"
      >
        본문으로 건너뛰기
      </a>
      <SidebarProvider defaultOpen={defaultOpen}>
        <FocusModeSync />
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
      {/* 뒤로·앞으로 가기에서 스크롤 위치를 되살린다(6차 — 긴 보드·결과 글에서 자리를 잃지 않게). 앞으로 가면 맨 위 */}
      <ScrollRestoration />
    </>
  );
}
