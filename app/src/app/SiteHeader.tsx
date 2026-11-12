import * as React from "react";
import { Link, useMatch } from "react-router";
import { BellIcon, SearchIcon, UserRoundIcon } from "lucide-react";
import { useWorkspace } from "@/api/queries";
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { roundHref } from "@/features/workspace/paths";
import { placeLabel } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { Kbd } from "@/components/pes/kbd";
import { useCommandMenu } from "./CommandMenu";
import { ThemeMenu } from "./ThemeMenu";

/** 기능 없는 자리의 이유(U1a) — 단추는 숨기지 않고 aria-disabled + 이유 글(설계 3.9 · 12.6 R05) */
const REASON = {
  notifications: "알림은 아직 없어요. 다음 작업(U1d)에서 열립니다.",
  user: "로그인·사용자 메뉴는 아직 없어요. 이 컴퓨터에서만 쓰는 화면입니다.",
};

/** 막힌 자리 단추 — 초점은 받고(이유를 읽힘) 눌러도 아무것도 열지 않는다 */
function PlaceholderButton({ reasonId, reason, className, children, ...rest }: React.ComponentProps<typeof Button> & { reasonId: string; reason: string }) {
  return (
    <>
      <Button {...rest} aria-disabled="true" aria-describedby={reasonId} onClick={(e) => e.preventDefault()} className={cn("text-muted-foreground", className)}>
        {children}
      </Button>
      <span id={reasonId} className="sr-only">
        {reason}
      </span>
    </>
  );
}

type Crumb = { label: string; to?: string };

/** 지금 주소 → 빵부스러기(연구 공간: “이 연구 › 지금 보는 곳”). 이름은 이미 받은 읽기에서. 브라우저 탭 이름도 같은 계산 */
function useCrumbs(): Crumb[] {
  const m = useMatch("/p/:slug/e/:edition/s/:stage/r/:round");
  const pm = useMatch("/p/:slug/e/:edition/*");
  const rec = useMatch("/p/:slug/e/:edition/records");
  const refs = useMatch("/p/:slug/e/:edition/references");
  const files = useMatch("/p/:slug/e/:edition/files");
  const edition = Number(pm?.params.edition ?? 0);
  const ws = useWorkspace(pm?.params.slug, edition).data;
  if (!pm) return [{ label: "PES" }];
  if (!ws) return [{ label: "연구 공간" }];
  const home = { label: ws.title, to: roundHref(ws.slug, ws.edition, ws.current.stage, ws.current.round_id) };
  if (rec) return [home, { label: "가정·결정·반영" }];
  if (refs) return [home, { label: "참고 프로젝트" }];
  if (files) return [home, { label: "내 자료" }];
  const stage = ws.stages.find((s) => s.key === m?.params.stage);
  const round = m?.params.round === "start" ? null : Number(m?.params.round);
  if (!stage || (round !== null && !stage.rounds.some((r) => r.round_id === round))) return [home, { label: "없는 주소" }];
  const past = !(ws.current.stage === stage.key && ws.current.round_id === round);
  return [home, { label: `${past ? "보는 중 " : ""}${placeLabel(stage.key, round)}` }];
}

/**
 * 머리줄 — 승인 시안의 SiteHeader(shadcn-admin 머리줄 구조 참고) 그대로의 자리:
 * 왼쪽: 사이드바 접기 · 빵부스러기 / 오른쪽: 명령 찾기(명령 메뉴 — U1c) · 알림 · 테마 · 사용자. 알림 · 사용자는 아직 자리만.
 */
export function SiteHeader() {
  const crumbs = useCrumbs();
  const command = useCommandMenu();
  return (
    <header aria-label="PES 전역 머리줄" className="site-header sticky top-0 z-20 flex h-(--header-h) shrink-0 items-center gap-2 border-b bg-background/95 px-3 backdrop-blur-sm tab:px-4">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-1 data-vertical:h-4 data-vertical:self-auto" />
      <Breadcrumb aria-label="현재 위치" className="min-w-0 flex-1">
        <BreadcrumbList className="flex-nowrap gap-1.5 text-meta tab:gap-2">
          {crumbs.map((c, i) => {
            const last = i === crumbs.length - 1;
            return (
              <React.Fragment key={i}>
                <BreadcrumbItem className={cn("min-w-0", !last && "max-tab:sr-only")}>
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
          onClick={command.open}
          aria-haspopup="dialog"
          aria-keyshortcuts="Control+K Meta+K"
          aria-label="명령 찾기 (Ctrl+K)"
          className="h-9 gap-2 px-2.5 font-normal text-muted-foreground shadow-none max-tab:w-9 max-tab:px-0 tab:w-48 tab:justify-start desk:w-56"
        >
          <SearchIcon aria-hidden="true" />
          <span className="hidden tab:inline">명령 찾기 · 이동</span>
          <span className="ml-auto hidden items-center gap-0.5 tab:inline-flex" aria-hidden="true">
            <Kbd>Ctrl</Kbd>
            <Kbd>K</Kbd>
          </span>
        </Button>
        <PlaceholderButton variant="ghost" size="icon" reasonId="header-notifications-reason" reason={REASON.notifications}>
          <BellIcon aria-hidden="true" />
          <span className="sr-only">알림</span>
        </PlaceholderButton>
        <ThemeMenu />
        <PlaceholderButton variant="ghost" size="icon" reasonId="header-user-reason" reason={REASON.user} className="rounded-full">
          <UserRoundIcon aria-hidden="true" />
          <span className="sr-only">사용자 메뉴</span>
        </PlaceholderButton>
      </div>
    </header>
  );
}
