import * as React from "react"
import { useLocation, useMatch } from "react-router"
import { BellIcon, FolderKanbanIcon, GaugeIcon, InboxIcon, LaptopIcon } from "lucide-react"

import { useNotifications, useProjects, useWorkspace } from "@/api/queries"
import { NavMain, type NavItem } from "@/components/nav-main"
import { NavProjects, useStageItems, type WorkspaceNavKey } from "@/components/nav-projects"
import { StatusMark } from "@/components/pes/status"
import { TurnMark, turnDef } from "@/components/pes/turn"
import { TeamSwitcher } from "@/components/team-switcher"
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarRail,
} from "@/components/ui/sidebar"

const WS_PAGE: Record<string, WorkspaceNavKey> = { files: "files", references: "refs", ai: "ai", settings: "settings", editions: "editions" }

/**
 * 앱 셸 사이드바 — shadcn 공식 sidebar-07 블록(아이콘만 남기고 접힘, collapsible="icon")을 CLI로 설치해 PES 내용으로 채웠다.
 * 머리: 프로젝트 전환 · 몸: 전역 메뉴(설계 3.1) → 작업 공간 안이면 작업 공간 묶음 + 단계·라운드 나무(설계 D4) (시안 링크는 본문 위 “시안” 띠에).
 * 휴대폰·좁은 창(900px 미만)에서는 같은 내용이 왼쪽 Sheet로 열린다.
 */
export function AppSidebar(props: React.ComponentProps<typeof Sidebar>) {
  const { pathname } = useLocation()
  const projectMatch = useMatch("/p/:slug/*")
  const slug = projectMatch?.params.slug ?? ""
  const ws = useWorkspace(slug).data
  const projects = useProjects()
  const notes = useNotifications()

  const turns = projects.data?.turns.length ?? 0
  const unread = notes.data?.filter((n) => n.unread).length ?? 0
  // 차례 배지(4차): 나의 할 일이 있으면 ◆ + 수(정지된 강한 색). 없으면 AI가 하는 중인 프로젝트를 도는 고리로(조용한 색)
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
  ]

  const inWs = ws && ws.slug === slug
  const roundPath = inWs ? `/p/${ws.slug}/e/${ws.edition}/s/${ws.current.stage}/r/${ws.current.round}` : ""
  const page = projectMatch?.params["*"]?.split("/")[0] ?? ""
  const activeWs = WS_PAGE[page]

  const stages = useStageItems(inWs ? ws : undefined)

  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <TeamSwitcher ws={inWs ? ws : undefined} />
      </SidebarHeader>
      <SidebarContent>
        <NavMain label="전체" ariaLabel="전역 메뉴" items={global} />
        {inWs ? (
          <>
            <NavProjects ws={ws} roundPath={roundPath} active={activeWs} />
            <NavMain label={`단계·라운드 · ${ws.edition}판`} ariaLabel="단계·라운드" items={stages} />
          </>
        ) : null}
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  )
}
