import {
  BotIcon,
  FileTextIcon,
  FilesIcon,
  LayersIcon,
  Link2Icon,
  MessageCircleQuestionIcon,
  SettingsIcon,
  TargetIcon,
} from "lucide-react"

import { useMatch } from "react-router"

import { STAGE_LABEL, type WorkspaceView } from "@/api/types"
import { NavMain, type NavItem } from "@/components/nav-main"
import { Tag } from "@/components/pes/bits"
import { roundKey, STAGE_MARK } from "@/components/pes/stage"
import { StatusMark } from "@/components/pes/status"
import { lookup } from "@/components/pes/status-registry"
import { TurnMark, turnKey, turnLabel } from "@/components/pes/turn"

export type WorkspaceNavKey = "now" | "q" | "result" | "files" | "refs" | "ai" | "editions" | "settings"

/**
 * sidebar-07 블록의 NavProjects 자리 → PES “작업 공간” 묶음(설계 D4 위쪽 묶음).
 * 지금 할 일 · 질문·답 · 결과물은 라운드 화면 안의 자리(#조각), 나머지는 화면 주소.
 * 아이콘만 남긴 사이드바에서도 숨기지 않는다(이름은 툴팁·화면 읽기 이름으로 남음).
 */
export function NavProjects({
  ws,
  roundPath,
  active,
  onPick,
  expanded,
  ariaLabel = "프로젝트 안 이동",
}: {
  ws: WorkspaceView
  roundPath: string
  active?: WorkspaceNavKey
  onPick?: (k: WorkspaceNavKey) => void
  expanded?: boolean
  ariaLabel?: string
}) {
  const base = `/p/${ws.slug}`
  const q = ws.nav_counts.questions
  const item = (k: WorkspaceNavKey, rest: Omit<NavItem, "key" | "current" | "onPick">): NavItem => ({
    key: k,
    current: active === k ? "page" : undefined,
    onPick: onPick ? () => onPick(k) : undefined,
    ...rest,
  })
  // 이 프로젝트의 차례(4차): 나의 할 일이면 ◆ + 수(강한 색), AI가 하는 중이면 도는 고리(소식 없으면 점선 고리), 기다림이면 두 줄
  const t = ws.turn
  const nowBadge: NavItem["badge"] = t
    ? turnKey(t) === "you"
      ? { text: String(t.count ?? 1), icon: <StatusMark shape="diamond" className="size-2" /> }
      : { icon: <TurnMark turn={t} className="size-2.5" />, quiet: true }
    : undefined
  const items: NavItem[] = [
    item("now", { title: "지금 할 일", to: `${roundPath}#now-title`, icon: <TargetIcon aria-hidden="true" />, badge: nowBadge, srText: t ? ` · ${turnLabel(t)}` : undefined }),
    item("q", {
      title: "질문·답",
      to: `${roundPath}#qpanel`,
      icon: <MessageCircleQuestionIcon aria-hidden="true" />,
      badge: q ? { text: String(q) } : undefined,
      srText: q ? ` · 남은 질문 ${q}개` : undefined,
    }),
    item("result", { title: "결과물", to: `${roundPath}#result`, icon: <FileTextIcon aria-hidden="true" /> }),
    item("files", {
      title: "자료",
      to: `${base}/files`,
      icon: <FilesIcon aria-hidden="true" />,
      badge: { text: String(ws.nav_counts.files), quiet: true },
      srText: ` · ${ws.nav_counts.files}개`,
    }),
    item("refs", {
      title: "참고 프로젝트",
      to: `${base}/references`,
      icon: <Link2Icon aria-hidden="true" />,
      tag: ws.nav_counts.refs_new ? <Tag tone="warn">새 버전</Tag> : undefined,
      tooltip: ws.nav_counts.refs_new ? "참고 프로젝트 · 새 버전 있음" : undefined,
    }),
    item("ai", { title: "AI 작업", to: `${base}/ai`, icon: <BotIcon aria-hidden="true" /> }),
    item("editions", { title: "판", to: `${base}/editions`, icon: <LayersIcon aria-hidden="true" /> }),
    item("settings", { title: "설정", to: `${base}/settings`, icon: <SettingsIcon aria-hidden="true" /> }),
  ]
  return <NavMain label="작업 공간" ariaLabel={ariaLabel} items={items} expanded={expanded} />
}

/**
 * 단계·라운드 나무(설계 D4 아래쪽 묶음) — 사이드바와 좁은 화면 “단계·탐색” 보기가 같은 항목을 쓴다.
 * 현재 단계만 라운드(단계 시작 · R1 · R2 …)를 펼친다. 다른 단계는 판 화면으로(4단계 범위).
 */
export function useStageItems(ws: WorkspaceView | undefined): NavItem[] {
  const roundMatch = useMatch("/p/:slug/e/:ed/s/:stage/r/:round")
  if (!ws) return []
  return ws.stages.map((st) => {
    const mark = STAGE_MARK[st.view]
    const icon = (
      <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center">
        <StatusMark shape={mark.shape} className={`size-2.5! ${mark.cls}`} />
      </span>
    )
    // 차례 말(현재 · 나의 할 일 등)은 상태 사전에서 — 읽기 묶음이 따로 준 글(승인(2판) 등)이 있으면 그것
    const text = st.state_text ?? lookup("stage", st.view).label
    const base: NavItem = { key: st.key, title: STAGE_LABEL[st.key], icon, meta: text, tooltip: `${STAGE_LABEL[st.key]} · ${text}` }
    if (!st.rounds) return { ...base, to: `/p/${ws.slug}/editions` }
    return {
      ...base,
      current: "step" as const,
      items: st.rounds.map((r) => {
        const rk = roundKey(r.label)
        return {
          key: r.label,
          title: r.label,
          meta: r.state,
          to: `/p/${ws.slug}/e/${ws.edition}/s/${st.key}/r/${rk}`,
          active: roundMatch?.params.stage === st.key && roundMatch?.params.round === rk,
        }
      }),
    }
  })
}
