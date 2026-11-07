import { useNavigate } from "react-router"
import { ChevronsUpDownIcon, LayoutGridIcon, PlusIcon } from "lucide-react"

import { useProjects } from "@/api/queries"
import type { WorkspaceView } from "@/api/types"
import { TurnMark, turnLabel } from "@/components/pes/turn"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"

/**
 * sidebar-07 블록의 “팀 전환” 자리 → PES 프로젝트 전환.
 * 작업 공간 안이면 그 프로젝트, 밖이면 “PES 연구 작업대”. 목록은 프로젝트 목록 읽기를 그대로 쓴다(새 읽기 없음).
 * 단축키(⌘1…)는 두지 않는다 — 한글 입력·화면 읽기 프로그램 단축키와 부딪히지 않게.
 */
export function TeamSwitcher({ ws }: { ws?: WorkspaceView }) {
  const { isMobile, setOpenMobile } = useSidebar()
  const projects = useProjects()
  const navigate = useNavigate()
  const active = projects.data?.active ?? []
  const title = ws ? ws.title : "PES 연구 작업대"
  // 작업 공간 안이면 그 프로젝트의 차례를 맨 앞에(4차) — 사이드바 맨 위에서도 지금 누가 움직일 차례인지 보인다
  const sub = ws ? `${ws.turn ? `${turnLabel(ws.turn)} · ` : ""}방식 ${ws.mode} · ${ws.current.label}` : `내 프로젝트 ${active.length}개`
  const go = (to: string) => {
    setOpenMobile(false)
    navigate(to)
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              tooltip={`프로젝트 전환 — ${title}`}
              aria-label={`프로젝트 전환. 지금: ${title}, ${sub}`}
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <div
                aria-hidden="true"
                className="flex aspect-square size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary text-[10.5px] font-semibold tracking-wider text-sidebar-primary-foreground"
              >
                PES
              </div>
              <div className="grid min-w-0 flex-1 text-left text-sm leading-tight">
                <span className="truncate font-semibold">{title}</span>
                <span className="flex min-w-0 items-center gap-1 text-xs">
                  {ws?.turn ? <TurnMark turn={ws.turn} className="size-2.5" /> : null}
                  <span className="truncate">{sub}</span>
                </span>
              </div>
              <ChevronsUpDownIcon className="ml-auto" aria-hidden="true" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-72"
            align="start"
            side={isMobile ? "bottom" : "right"}
            sideOffset={4}
          >
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              프로젝트 전환 · 내 프로젝트 {active.length}
            </DropdownMenuLabel>
            {active.map((p) => (
              <DropdownMenuItem key={p.slug} onSelect={() => go(p.href)} className="gap-2 p-2">
                <span
                  aria-hidden="true"
                  className="flex size-6 shrink-0 items-center justify-center rounded-md border text-[11px] font-semibold"
                >
                  {p.mode}
                </span>
                <span className="grid min-w-0 flex-1 leading-tight">
                  <span className="truncate">{p.title}</span>
                  <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                    {p.turn ? <TurnMark turn={p.turn} className="size-2.5 text-ink-2" /> : null}
                    <span className="truncate">
                      {p.turn ? `${turnLabel(p.turn)} · ` : ""}방식 {p.mode} · {p.current}
                    </span>
                  </span>
                </span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => go("/")} className="gap-2 p-2">
              <span aria-hidden="true" className="flex size-6 items-center justify-center rounded-md border">
                <LayoutGridIcon className="size-4" />
              </span>
              모든 프로젝트 보기
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => go("/new")} className="gap-2 p-2">
              <span aria-hidden="true" className="flex size-6 items-center justify-center rounded-md border">
                <PlusIcon className="size-4" />
              </span>
              새 프로젝트
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
