import * as React from "react";
import { Link, useLocation, useMatch, useNavigate } from "react-router";
import { BellIcon, SearchIcon } from "lucide-react";
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
import { cn } from "@/lib/utils";
import { MockDock } from "./MockControls";
import { ThemeMenu } from "./ThemeMenu";

export function RefreshChip() {
  const s = useRefreshState();
  const label = { live: "갱신: 실시간", slow: "갱신: 느린 갱신 · 30초", paused: "갱신 쉼", offline: "끊김 · 다시 연결 중", resync: "다시 받는 중" }[s];
  return <Status of="refresh" value={s} label={label} />;
}

type Crumb = { label: string; to?: string };

const PAGE_NAME: Record<string, string> = {
  files: "자료",
  references: "참고 프로젝트",
  ai: "AI 작업",
  settings: "설정",
  editions: "판",
};

/** 지금 주소 → 빵부스러기(프로젝트 › 작업 공간 › 화면). 작업 공간 이름은 이미 받은 읽기에서. */
function useCrumbs(): Crumb[] {
  const { pathname } = useLocation();
  const pm = useMatch("/p/:slug/*");
  const rm = useMatch("/p/:slug/e/:ed/s/:stage/r/:round");
  const ws = useWorkspace(pm?.params.slug ?? "").data;
  if (pm) {
    const slug = pm.params.slug ?? "";
    const title = ws && ws.slug === slug ? `${ws.title}(가상)` : "작업 공간";
    const roundPath = ws ? `/p/${ws.slug}/e/${ws.edition}/s/${ws.current.stage}/r/${ws.current.round}` : `/p/${slug}`;
    const page = pm.params["*"]?.split("/")[0] ?? "";
    let last = PAGE_NAME[page];
    if (!last && rm && ws) {
      const r = rm.params.round;
      last = r !== ws.current.round ? `보는 중 ${r === "start" ? "단계 시작" : `R${r}`}` : ws.current.label;
    }
    return [{ label: "프로젝트", to: "/" }, { label: title, to: roundPath }, { label: last ?? ws?.current.label ?? "" }];
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

function NotificationsMenu() {
  const notes = useNotifications();
  const navigate = useNavigate();
  const list = notes.data ?? [];
  const unread = list.filter((n) => n.unread).length;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label={`알림 · 안 읽음 ${unread}건`}>
          <BellIcon aria-hidden="true" />
          {unread ? (
            <span aria-hidden="true" className="absolute top-1 right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] leading-none font-semibold text-primary-foreground tabular-nums">
              {unread}
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={6} className="w-80">
        <DropdownMenuLabel className="flex items-center justify-between text-xs text-muted-foreground">
          <span>알림 · 안 읽음 {unread}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
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
        <DropdownMenuItem onSelect={() => navigate("/notifications")} className="justify-center font-medium">
          알림 모두 보기
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * 머리줄 — shadcn-admin 레이아웃의 머리줄 구조를 참고해 새로 썼다(코드는 가져오지 않음, MIT 저장소).
 * 왼쪽: 사이드바 접기 · 빵부스러기 / 오른쪽: 검색(명령 메뉴 Ctrl/Cmd+K) · 갱신 칩(작업 공간 밖) · 알림 · 테마 · 사용자.
 */
export function SiteHeader({ onSearch }: { onSearch: () => void }) {
  const crumbs = useCrumbs();
  const inProject = useLocation().pathname.startsWith("/p/");
  return (
    <header
      aria-label="PES 전역 머리줄"
      className="site-header sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b bg-background/95 px-3 backdrop-blur-sm tab:px-4"
    >
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-1 data-vertical:h-4 data-vertical:self-auto" />
      <Breadcrumb aria-label="현재 위치" className="min-w-0 flex-1">
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
        {/* 작업 공간 안에서는 프로젝트 머리에 갱신 칩이 있다(설계 3.2) */}
        {inProject ? null : (
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
