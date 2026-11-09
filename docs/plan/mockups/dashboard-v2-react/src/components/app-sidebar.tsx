import * as React from "react"
import { Link, useLocation, useMatch } from "react-router"
import { ArrowLeftIcon, BellIcon, FolderKanbanIcon, GaugeIcon, InboxIcon, LaptopIcon, PlusIcon } from "lucide-react"

import { useNotifications, useProjects, useWorkspace } from "@/api/queries"
import { NavMain, type NavItem } from "@/components/nav-main"
import { ResearchNav, useStageItems } from "@/components/nav-projects"
import { StatusMark } from "@/components/pes/status"
import { TurnMark, turnDef } from "@/components/pes/turn"
import { TeamSwitcher } from "@/components/team-switcher"
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar"

/**
 * 관리 공간(모아 보기) 사이드바 — 어디로 갈지 고르는 곳(설계 16.1).
 * 머리: 프로젝트 전환(들어가면 연구 공간) · 몸: 전역 메뉴(프로젝트 · 나의 할 일 · 내 컴퓨터 · 사용량 · 알림) + 새 프로젝트.
 */
function ManageSidebar(props: React.ComponentProps<typeof Sidebar>) {
  const { pathname } = useLocation()
  const projects = useProjects()
  const notes = useNotifications()

  const turns = projects.data?.turns.length ?? 0
  const unread = notes.data?.filter((n) => n.unread).length ?? 0
  // 차례 배지(4차): 나의 할 일이 있으면 ◆ + 수(정지된 강한 색). 없으면 AI 작업 중인 프로젝트를 도는 고리로(조용한 색)
  const aiTurns = (projects.data?.active ?? []).flatMap((p) => (p.turn?.side === "ai" ? [p.turn] : []))
  const aiShown = aiTurns.find((t) => t.fresh) ?? aiTurns[0]
  const turnBadge: NavItem["badge"] = turns
    ? { text: String(turns), icon: <StatusMark shape="diamond" className="size-2" /> }
    : aiShown
      ? { text: String(aiTurns.length), icon: <TurnMark turn={aiShown} className="size-2.5" />, quiet: true }
      : undefined
  const turnSr = turns ? ` · ${turns}건` : aiShown ? ` · 없음 · ${turnDef("ai").label} ${aiTurns.length}개` : " · 없음"
  const global: NavItem[] = [
    { key: "projects", title: "프로젝트", to: "/", icon: <FolderKanbanIcon aria-hidden="true" />, current: pathname === "/" ? "page" : undefined },
    { key: "turns", title: turnDef("you").label, to: "/#turns", icon: <InboxIcon aria-hidden="true" />, badge: turnBadge, srText: turnSr },
    { key: "computer", title: "내 컴퓨터", to: "/computer", icon: <LaptopIcon aria-hidden="true" />, current: pathname === "/computer" ? "page" : undefined },
    { key: "usage", title: "사용량", to: "/usage", icon: <GaugeIcon aria-hidden="true" />, current: pathname === "/usage" ? "page" : undefined },
    {
      key: "notifications",
      title: "알림",
      to: "/notifications",
      icon: <BellIcon aria-hidden="true" />,
      current: pathname === "/notifications" ? "page" : undefined,
      badge: unread ? { text: String(unread) } : undefined,
      srText: ` · 안 읽음 ${unread}건`,
    },
    { key: "new", title: "새 프로젝트", to: "/new", icon: <PlusIcon aria-hidden="true" />, current: pathname.startsWith("/new") ? "page" : undefined },
  ]
  return (
    <Sidebar collapsible="icon" data-space="manage" {...props}>
      <SidebarHeader>
        <TeamSwitcher />
      </SidebarHeader>
      <SidebarContent>
        <NavMain label="모아 보기" ariaLabel="전역 메뉴" items={global} />
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  )
}

/**
 * 연구 공간(집중) 사이드바(설계 16.2) — 관리용 전역 메뉴 · 다른 프로젝트 · 전역 사용량은 빠진다.
 * 왼쪽 위: “← 모든 프로젝트” 하나와 프로젝트 전환만. 몸: 연구 흐름(6단계 길) → 이 연구(개요 · 지금 할 일 · 막힌 것 · 결과 글 · 더 보기).
 */
function ResearchSidebar({ slug, ...props }: React.ComponentProps<typeof Sidebar> & { slug: string }) {
  const q = useWorkspace(slug)
  const ws = q.data && q.data.slug === slug ? q.data : undefined
  const { setOpenMobile } = useSidebar()
  const stages = useStageItems(ws)
  const roundPath = ws ? `/p/${ws.slug}/e/${ws.edition}/s/${ws.current.stage}/r/${ws.current.round}` : `/p/${slug}`
  return (
    <Sidebar collapsible="icon" data-space="research" {...props}>
      <SidebarHeader className="gap-1">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild size="sm" tooltip="모든 프로젝트" className="text-sidebar-foreground/80 hover:text-sidebar-foreground">
              <Link to="/" className="no-underline" onClick={() => setOpenMobile(false)} data-back="">
                <ArrowLeftIcon aria-hidden="true" />
                <span>모든 프로젝트</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <TeamSwitcher ws={ws} />
      </SidebarHeader>
      <SidebarContent>
        {ws ? (
          <>
            <NavMain label={`연구 흐름 · ${ws.edition}판`} ariaLabel="연구 흐름 — 6단계 길" items={stages} />
            <ResearchNav ws={ws} roundPath={roundPath} />
          </>
        ) : null}
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  )
}

/**
 * 앱 셸 사이드바 — shadcn 공식 sidebar-07 블록(아이콘만 남기고 접힘, collapsible="icon")을 PES 내용으로 채웠다.
 * 5차(2026-11-08): 두 공간으로 나눴다 — 관리 공간(모아 보기)과 연구 공간(프로젝트 하나에 집중). 설계 16절.
 * 휴대폰·좁은 창(900px 미만)에서는 같은 내용이 왼쪽 Sheet로 열린다.
 */
export function AppSidebar(props: React.ComponentProps<typeof Sidebar>) {
  const projectMatch = useMatch("/p/:slug/*")
  const slug = projectMatch?.params.slug ?? ""
  return slug ? <ResearchSidebar key="research" slug={slug} {...props} /> : <ManageSidebar key="manage" {...props} />
}
