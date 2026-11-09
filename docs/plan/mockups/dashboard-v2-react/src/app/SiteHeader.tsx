import * as React from "react";
import { Link, useLocation, useMatch, useNavigate } from "react-router";
import { ArrowLeftIcon, BellIcon, BotIcon, FocusIcon, SearchIcon } from "lucide-react";
import { useNotifications, useRefreshState, useWorkspace } from "@/api/queries";
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { NavUser } from "@/components/nav-user";
import { Kbd } from "@/components/pes/bits";
import { Status, StatusFrom } from "@/components/pes/status";
import { researchPlaceLabel } from "@/features/research/place";
import { aiSheet, researchUi, useAiSheet, useIsDesk, useResearchUi } from "@/lib/research-ui";
import { cn } from "@/lib/utils";
import { MockDock } from "./MockControls";
import { ThemeMenu } from "./ThemeMenu";

export function RefreshChip() {
  const s = useRefreshState();
  const label = { live: "갱신: 실시간", slow: "갱신: 느린 갱신 · 30초", paused: "갱신 쉼", offline: "끊김 · 다시 연결 중", resync: "다시 받는 중" }[s];
  return <Status of="refresh" value={s} label={label} />;
}

type Crumb = { label: string; to?: string };

/**
 * 브라우저 탭 · 방문 기록의 이름 = 지금 보는 곳(빵부스러기와 같은 계산). 예: “막힌 것·풀 것 · 지역 돌봄 …(가상) · PES”.
 * 6차 — 모든 화면이 같은 이름이라 탭·뒤로 가기 목록·화면 읽기에서 구별되지 않던 것을 고침(WCAG 2.4.2).
 */
function useDocumentTitle(crumbs: Crumb[], inProject: boolean) {
  const last = crumbs[crumbs.length - 1]?.label ?? "";
  const project = inProject && crumbs.length > 1 ? crumbs[0].label : "";
  const title = [last, project, "PES"].filter(Boolean).join(" · ");
  React.useEffect(() => {
    document.title = title;
  }, [title]);
}


/**
 * 지금 주소 → 빵부스러기. 관리 공간은 “프로젝트 › 화면”, 연구 공간은 “이 연구 › 지금 보는 곳”(관리 화면 이름을 섞지 않음 — 5차).
 * 이름은 이미 받은 읽기에서.
 */
function useCrumbs(): Crumb[] {
  const { pathname, search, hash } = useLocation();
  const pm = useMatch("/p/:slug/*");
  const ws = useWorkspace(pm?.params.slug ?? "").data;
  if (pm) {
    const slug = pm.params.slug ?? "";
    if (!ws || ws.slug !== slug) return [{ label: "연구 공간" }];
    const place = researchPlaceLabel(ws, pathname, search, hash) ?? "연구 개요";
    const rm = pathname.match(/\/r\/([^/]+)$/);
    const past = rm && rm[1] !== ws.current.round ? `보는 중 ${rm[1] === "start" ? "단계 시작" : `R${rm[1]}`}` : null;
    return [{ label: `${ws.title}(가상)`, to: `/p/${slug}` }, { label: past ?? place }];
  }
  const fixed: Record<string, Crumb[]> = {
    "/": [{ label: "프로젝트" }],
    "/usage": [{ label: "사용량" }],
    "/computer": [{ label: "내 컴퓨터" }],
    "/notifications": [{ label: "알림" }],
    "/new": [{ label: "프로젝트", to: "/" }, { label: "새 프로젝트" }],
    "/new/a": [{ label: "프로젝트", to: "/" }, { label: "새 프로젝트", to: "/new" }, { label: "방식 A 만들기" }],
    "/new/b": [{ label: "프로젝트", to: "/" }, { label: "새 프로젝트", to: "/new" }, { label: "방식 B 등록 안내" }],
    "/device": [{ label: "내 컴퓨터", to: "/computer" }, { label: "기기 승인" }],
    "/guide": [{ label: "시안 안내" }],
    "/states": [{ label: "상태 견본" }],
    "/mobile": [{ label: "휴대폰 화면" }],
  };
  return fixed[pathname] ?? [{ label: "없는 주소" }];
}

/**
 * 알림 미리 보기. 연구 공간에서는 그 프로젝트 알림만(방해 줄이기 — 설계 16.5). 다른 프로젝트 알림은 수만 알리고 모든 알림에서 본다.
 * 알림 문구 자체에는 프로젝트 이름을 싣지 않는다(4.13) — 거르기는 서버가 준 프로젝트 표시로.
 */
function NotificationsMenu() {
  const notes = useNotifications();
  const navigate = useNavigate();
  const slug = useMatch("/p/:slug/*")?.params.slug ?? null;
  const all = notes.data ?? [];
  const list = slug ? all.filter((n) => n.slug === slug) : all;
  const others = slug ? all.filter((n) => n.slug !== slug && n.unread).length : 0;
  const unread = list.filter((n) => n.unread).length;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label={`알림${slug ? "(이 프로젝트)" : ""} · 안 읽음 ${unread}건`}>
          <BellIcon aria-hidden="true" />
          {unread ? (
            <span aria-hidden="true" className="absolute top-1 right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-caption leading-none font-semibold text-primary-foreground tabular-nums">
              {unread}
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={6} className="w-80">
        <DropdownMenuLabel className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{slug ? "이 프로젝트 알림만" : "알림"} · 안 읽음 {unread}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {list.length === 0 ? <p className="text-xs text-muted-foreground p-2">이 프로젝트의 알림이 없습니다.</p> : null}
        {list.slice(0, 4).map((n) => (
          <DropdownMenuItem key={n.id} onSelect={() => navigate(n.href)} className="items-start gap-2 py-2">
            <span aria-hidden="true" className={cn("mt-1.5 size-2 shrink-0 rounded-full", n.unread ? "bg-primary" : "border border-control")} />
            <span className="grid min-w-0 flex-1 gap-0.5">
              <span className={cn("leading-snug", n.unread && "font-semibold")}>
                {n.title}
                {n.unread ? <span className="sr-only"> (안 읽음)</span> : null}
              </span>
              <span className="text-xs text-muted-foreground">
                {n.at} · {n.channel}
              </span>
              {n.delivery.value !== "sent" || n.delivery.label ? (
                <span>
                  <StatusFrom s={n.delivery} wrap />
                </span>
              ) : null}
            </span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        {slug && others ? <p className="px-2 pb-1 text-xs text-muted-foreground">다른 프로젝트 안 읽음 {others}건 — 모든 알림에서</p> : null}
        <DropdownMenuItem onSelect={() => navigate("/notifications")} className="justify-center font-medium">
          알림 모두 보기{slug ? "(관리 공간)" : ""}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * 머리줄 — shadcn-admin 레이아웃의 머리줄 구조를 참고해 새로 썼다(코드는 가져오지 않음, MIT 저장소).
 * 왼쪽: 사이드바 접기 · 빵부스러기 / 오른쪽: 검색(명령 메뉴 Ctrl/Cmd+K) · 갱신 칩(작업 공간 밖) · 알림 · 테마 · 사용자.
 */
/** 집중 모드 단추(연구 공간) — 사이드 칸 둘을 접고 가운데만. Esc로 끝낸다. 좁은 화면(900px 미만)에는 두지 않는다. */
function FocusToggle() {
  const ui = useResearchUi();
  return (
    <Button
      variant={ui.focus ? "default" : "ghost"}
      size="sm"
      aria-pressed={ui.focus}
      aria-keyshortcuts="Escape"
      onClick={() => researchUi.set({ focus: !ui.focus })}
      className="hidden h-9 gap-1.5 px-2.5 tab:inline-flex"
    >
      <FocusIcon aria-hidden="true" />
      <span className="hidden desk:inline">집중 모드</span>
      <span className="sr-only desk:hidden">집중 모드</span>
    </Button>
  );
}

/** AI 동료 단추 — 넓은 화면은 오른쪽 칸 보이기/숨기기, 좁은 화면은 오른쪽 판 열기 */
function AiPartnerToggle() {
  const ui = useResearchUi();
  const desk = useIsDesk();
  const sheet = useAiSheet();
  if (desk) {
    const on = ui.aiPanel && !ui.focus;
    return (
      <Button variant="ghost" size="sm" aria-pressed={on} onClick={() => researchUi.set(ui.focus ? { focus: false, aiPanel: true } : { aiPanel: !ui.aiPanel })} className="h-9 gap-1.5 px-2.5">
        <BotIcon aria-hidden="true" />
        <span className="hidden wide:inline">AI 동료</span>
        <span className="sr-only wide:hidden">AI 동료</span>
      </Button>
    );
  }
  return (
    <Button variant="ghost" size="icon" aria-haspopup="dialog" aria-expanded={sheet.open} aria-label="AI 동료 열기" onClick={() => aiSheet.set({ open: true })}>
      <BotIcon aria-hidden="true" />
    </Button>
  );
}

export function SiteHeader({ onSearch }: { onSearch: () => void }) {
  const crumbs = useCrumbs();
  const inProject = useLocation().pathname.startsWith("/p/");
  useDocumentTitle(crumbs, inProject);
  return (
    <header
      aria-label="PES 전역 머리줄"
      className="site-header sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b bg-background/95 px-3 backdrop-blur-sm tab:px-4"
    >
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-1 data-vertical:h-4 data-vertical:self-auto" />
      {/* 연구 공간 · 좁은 화면: 사이드바가 판으로 숨으므로 “모든 프로젝트”를 머리줄 왼쪽에 하나 둔다(설계 16.2) */}
      {inProject ? (
        <Link to="/" className="inline-flex h-9 shrink-0 items-center gap-1 rounded-md px-1.5 text-meta font-medium text-muted-foreground no-underline hover:bg-accent hover:text-foreground tab:hidden" aria-label="모든 프로젝트로 — 관리 공간">
          <ArrowLeftIcon className="size-4" aria-hidden="true" />
          <span className="max-[370px]:sr-only">모든 프로젝트</span>
        </Link>
      ) : null}
      <Breadcrumb aria-label="현재 위치" className={cn("min-w-0 flex-1", inProject && "max-tab:invisible max-tab:w-0")}>
        <BreadcrumbList className="flex-nowrap gap-1.5 tab:gap-2">
          {crumbs.map((c, i) => {
            const last = i === crumbs.length - 1;
            return (
              <React.Fragment key={i}>
                <BreadcrumbItem className={cn("min-w-0", !last && "hidden tab:inline-flex")}>
                  {last || !c.to ? (
                    <BreadcrumbPage className="truncate font-medium">{c.label}</BreadcrumbPage>
                  ) : (
                    <BreadcrumbLink asChild className="truncate text-muted-foreground no-underline hover:text-foreground hover:underline">
                      <Link to={c.to}>{c.label}</Link>
                    </BreadcrumbLink>
                  )}
                </BreadcrumbItem>
                {last ? null : <BreadcrumbSeparator className="hidden tab:inline-flex" />}
              </React.Fragment>
            );
          })}
        </BreadcrumbList>
      </Breadcrumb>
      <div className="flex shrink-0 items-center gap-1 tab:gap-1.5">
        <Button
          variant="outline"
          onClick={onSearch}
          aria-keyshortcuts="Control+K Meta+K"
          aria-label="명령 찾기 (Ctrl+K)"
          className="h-9 gap-2 px-2.5 font-normal text-muted-foreground shadow-none max-tab:w-9 max-tab:px-0 tab:w-52 tab:justify-start desk:w-64"
        >
          <SearchIcon aria-hidden="true" />
          <span className="hidden tab:inline">명령 찾기 · 이동</span>
          <span className="ml-auto hidden items-center gap-0.5 tab:inline-flex" aria-hidden="true">
            <Kbd>Ctrl</Kbd>
            <Kbd>K</Kbd>
          </span>
        </Button>
        {/* 작업 공간 안에서는 프로젝트 머리에 갱신 칩이 있다(설계 3.2). 연구 공간: 집중 모드 · AI 동료(5차) */}
        {inProject ? (
          <>
            <FocusToggle />
            <AiPartnerToggle />
          </>
        ) : (
          <span className="hidden desk:inline-flex">
            <RefreshChip />
          </span>
        )}
        <NotificationsMenu />
        <ThemeMenu />
        <NavUser />
        {/* 시안 도구(제품 아님) — 점선 단추 하나. 화면 설명·시안 조작은 이 단추의 판에만 있다. */}
        <MockDock />
      </div>
    </header>
  );
}
