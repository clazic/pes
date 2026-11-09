import * as React from "react"
import { Link } from "react-router"
import { ChevronRightIcon } from "lucide-react"

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from "@/components/ui/sidebar"
import { cn } from "@/lib/utils"

export interface NavSubItem {
  key: string
  title: string
  to: string
  meta?: string
  active?: boolean
}

export interface NavItem {
  key: string
  title: string
  /** 링크(하위 항목이 없을 때) */
  to?: string
  icon?: React.ReactNode
  /** aria-current — 지금 화면(page) · 지금 단계(step) */
  current?: "page" | "step"
  /** 보이는 수 배지(화면 읽기에는 srText로). icon = 차례 모양(◆ 나의 할 일 · 도는 고리 AI 작업 중 …) */
  badge?: { text?: string; quiet?: boolean; icon?: React.ReactNode }
  /** 보이는 꼬리표(예: 새 버전) */
  tag?: React.ReactNode
  /** 화면 읽기 프로그램에만 붙는 말(“· 안 읽음 3건”) */
  srText?: string
  /** 오른쪽 작은 글(상태) */
  meta?: string
  items?: NavSubItem[]
  /** 하위 항목의 이름(화면 읽기 “— 라운드 펼치기”의 “라운드”) — 기본 라운드 */
  subNoun?: string
  /** 하위 항목을 펼친 채 시작(기본 펼침) */
  open?: boolean
  tooltip?: string
  onPick?: () => void
}

/**
 * sidebar-07 블록의 NavMain을 PES 탐색 묶음으로 고쳐 쓴다.
 * - 수 배지는 눈에만(aria-hidden), 같은 뜻을 링크 안 sr-only 글로 읽는다(설계 3.1 “안 읽음 2건”).
 * - 하위 항목(라운드)이 있으면 펼침 목록. 아이콘만 남기고 접힌 사이드바에서는 같은 항목을 드롭다운으로 연다
 *   — 접혀도 라운드 입구가 남는다(Codex F10, 설계 3.8의 88px 줄을 대신함).
 */
export function NavMain({
  label,
  ariaLabel,
  items,
  className,
  expanded = false,
}: {
  label: string
  ariaLabel: string
  items: NavItem[]
  className?: string
  /** 사이드바 밖(좁은 화면 본문의 “단계·탐색” 보기)에서는 접힘 상태와 상관없이 펼쳐 그린다 */
  expanded?: boolean
}) {
  const { state, isMobile, setOpenMobile } = useSidebar()
  const collapsed = !expanded && state === "collapsed" && !isMobile
  const close = () => setOpenMobile(false)

  return (
    <SidebarGroup role="navigation" aria-label={ariaLabel} className={className}>
      <SidebarGroupLabel>{label}</SidebarGroupLabel>
      <SidebarMenu>
        {items.map((item) =>
          item.items?.length ? (
            collapsed ? (
              <SidebarMenuItem key={item.key}>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <SidebarMenuButton
                      aria-current={item.current}
                      aria-label={`${item.title}${item.meta ? ` · ${item.meta}` : ""} — ${item.subNoun ?? "라운드"} 열기`}
                    >
                      {item.icon}
                      <span>{item.title}</span>
                    </SidebarMenuButton>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent side="right" align="start" sideOffset={6} className="w-60">
                    <DropdownMenuLabel className="text-xs text-muted-foreground">
                      {item.title}
                      {item.meta ? ` · ${item.meta}` : ""}
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    {item.items.map((sub) => (
                      <DropdownMenuItem key={sub.key} asChild>
                        <Link
                          to={sub.to}
                          aria-current={sub.active ? "page" : undefined}
                          className={cn("text-popover-foreground no-underline", sub.active && "font-semibold")}
                        >
                          <span>{sub.title}</span>
                          {sub.meta ? <span className="ml-auto text-xs text-muted-foreground">{sub.meta}</span> : null}
                        </Link>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </SidebarMenuItem>
            ) : (
              <Collapsible key={item.key} asChild defaultOpen={item.open ?? true} className="group/collapsible">
                <SidebarMenuItem>
                  <CollapsibleTrigger asChild>
                    <SidebarMenuButton
                      tooltip={item.tooltip ?? item.title}
                      aria-current={item.current}
                      aria-label={`${item.title}${item.meta ? ` · ${item.meta}` : ""} — ${item.subNoun ?? "라운드"} 펼치기`}
                    >
                      {item.icon}
                      <span className="min-w-0 truncate">{item.title}</span>
                      {item.meta ? <span className="ml-auto shrink-0 text-xs">{item.meta}</span> : null}
                      <ChevronRightIcon
                        aria-hidden="true"
                        className={cn(
                          "transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90",
                          !item.meta && "ml-auto"
                        )}
                      />
                    </SidebarMenuButton>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <SidebarMenuSub aria-label={`${item.title} ${item.subNoun ?? "라운드"}`}>
                      {item.items.map((sub) => (
                        <SidebarMenuSubItem key={sub.key}>
                          <SidebarMenuSubButton asChild isActive={sub.active}>
                            <Link
                              to={sub.to}
                              onClick={close}
                              aria-current={sub.active ? "page" : undefined}
                              className="no-underline"
                            >
                              <span className="min-w-0 truncate">{sub.title}</span>
                              {sub.meta ? <span className="ml-auto shrink-0 text-xs">{sub.meta}</span> : null}
                            </Link>
                          </SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                      ))}
                    </SidebarMenuSub>
                  </CollapsibleContent>
                </SidebarMenuItem>
              </Collapsible>
            )
          ) : (
            <SidebarMenuItem key={item.key}>
              <SidebarMenuButton asChild isActive={item.current === "page"} tooltip={item.tooltip ?? item.title}>
                <Link
                  to={item.to ?? "#"}
                  aria-current={item.current}
                  onClick={() => {
                    item.onPick?.()
                    close()
                  }}
                  className="no-underline"
                >
                  {item.icon}
                  <span className="min-w-0 truncate">{item.title}</span>
                  {item.meta ? <span className="ml-auto shrink-0 text-xs">{item.meta}</span> : null}
                  {item.tag ? <span className="ml-auto shrink-0 group-data-[collapsible=icon]:hidden">{item.tag}</span> : null}
                  {item.srText ? <span className="sr-only">{item.srText}</span> : null}
                </Link>
              </SidebarMenuButton>
              {item.badge ? (
                <SidebarMenuBadge
                  aria-hidden="true"
                  data-badge={item.key}
                  className={cn(
                    "gap-1 rounded-full px-1.5",
                    item.badge.quiet
                      ? "bg-sidebar-accent text-sidebar-accent-foreground"
                      : "bg-sidebar-primary text-sidebar-primary-foreground peer-hover/menu-button:text-sidebar-primary-foreground peer-data-active/menu-button:text-sidebar-primary-foreground"
                  )}
                >
                  {item.badge.icon}
                  {item.badge.text}
                </SidebarMenuBadge>
              ) : null}
            </SidebarMenuItem>
          )
        )}
      </SidebarMenu>
    </SidebarGroup>
  )
}
