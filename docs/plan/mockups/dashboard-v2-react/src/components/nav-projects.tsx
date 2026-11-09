import {
  CircleAlertIcon,
  CompassIcon,
  EllipsisIcon,
  FileTextIcon,
  TargetIcon,
} from "lucide-react"

import { useLocation, useMatch } from "react-router"

import { STAGE_LABEL, type WorkspaceView } from "@/api/types"
import { NavMain, type NavItem } from "@/components/nav-main"
import { roundKey, STAGE_MARK } from "@/components/pes/stage"
import { StatusMark } from "@/components/pes/status"
import { lookup } from "@/components/pes/status-registry"
import { TurnMark, turnKey, turnLabel } from "@/components/pes/turn"

export type WorkspaceNavKey = "overview" | "now" | "problems" | "result" | "files" | "refs" | "ai" | "editions" | "settings" | "sync"

/**
 * 연구 공간 사이드바(5차, 설계 16.2) — sidebar-07 블록의 NavProjects 자리.
 * “이 연구”: 연구 개요 · 지금 할 일(이 프로젝트의 차례) · 막힌 것·풀 것 · 결과 글.
 * “더 보기”: 자료 · 참고 프로젝트 · AI 작업 기록 · 판 · 설정 · 내 컴퓨터 연결(B) — 기존 기능은 지우지 않고 보조 메뉴로 내렸다.
 * 아이콘만 남긴 사이드바에서도 숨기지 않는다(이름은 툴팁·화면 읽기 이름, 더 보기는 드롭다운).
 */
export function ResearchNav({ ws, roundPath, ariaLabel = "이 연구 안 이동" }: { ws: WorkspaceView; roundPath: string; ariaLabel?: string }) {
  const { pathname, search } = useLocation()
  const base = `/p/${ws.slug}`
  const rest = pathname.slice(base.length)
  const inRound = rest.startsWith("/e/")
  const t = new URLSearchParams(search).get("t")
  const page = rest.split("/")[1] ?? ""
  // 이 프로젝트의 차례(4차): 나의 할 일이면 ◆ + 수(강한 색), AI 작업 중이면 도는 고리(소식 없으면 점선 고리), 기다림이면 두 줄
  const turn = ws.turn
  const nowBadge: NavItem["badge"] = turn
    ? turnKey(turn) === "you"
      ? { text: String(turn.count ?? 1), icon: <StatusMark shape="diamond" className="size-2" /> }
      : { icon: <TurnMark turn={turn} className="size-2.5" />, quiet: true }
    : undefined
  const open = ws.problems.filter((p) => p.state === "open").length
  const items: NavItem[] = [
    { key: "overview", title: "연구 개요", to: base, icon: <CompassIcon aria-hidden="true" />, current: rest === "" || rest === "/" ? "page" : undefined },
    {
      key: "now",
      title: "지금 할 일",
      to: roundPath,
      icon: <TargetIcon aria-hidden="true" />,
      badge: nowBadge,
      srText: turn ? ` · ${turnLabel(turn)}` : undefined,
      current: inRound && t !== "review" ? "page" : undefined,
    },
    {
      key: "problems",
      title: "막힌 것·풀 것",
      to: `${base}/problems`,
      icon: <CircleAlertIcon aria-hidden="true" />,
      badge: ws.problems.length ? { text: String(ws.problems.length), quiet: true } : undefined,
      srText: ` · ${lookup("problemState", "open").label} ${open}건 · 전체 ${ws.problems.length}건`,
      current: page === "problems" ? "page" : undefined,
    },
    ...(ws.result
      ? [{ key: "result", title: "결과 글", to: `${roundPath}?t=review`, icon: <FileTextIcon aria-hidden="true" />, current: inRound && t === "review" ? ("page" as const) : undefined }]
      : []),
  ]
  const moreKeys = ["files", "references", "ai", "editions", "settings", "sync"]
  const more: NavItem = {
    key: "more",
    title: "더 보기",
    icon: <EllipsisIcon aria-hidden="true" />,
    subNoun: "메뉴",
    open: moreKeys.includes(page),
    tooltip: "더 보기 — 자료 · 참고 프로젝트 · AI 작업 기록 · 판 · 설정",
    items: [
      { key: "files", title: "자료", to: `${base}/files`, meta: String(ws.nav_counts.files), active: page === "files" },
      { key: "refs", title: "참고 프로젝트", to: `${base}/references`, meta: ws.nav_counts.refs_new ? "새 버전" : undefined, active: page === "references" },
      { key: "ai", title: "AI 작업 기록", to: `${base}/ai`, active: page === "ai" },
      { key: "editions", title: "판", to: `${base}/editions`, active: page === "editions" },
      { key: "settings", title: "설정", to: `${base}/settings`, active: page === "settings" },
      ...(ws.mode === "B" ? [{ key: "sync", title: "내 컴퓨터 연결", to: `${base}/sync`, active: page === "sync" }] : []),
    ],
  }
  return <NavMain label="이 연구" ariaLabel={ariaLabel} items={[...items, more]} />
}

/**
 * 연구 흐름 — 6단계 길(설계 16.2): 지금 단계는 라운드(단계 시작 · R1 · R2 …)를 펼치고,
 * 지난 단계는 결과 요약으로(/p/…/s/<단계>), 앞 단계 변경 — 다시 확인은 세모 + 글자. 아직 단계도 무엇을 하는지 볼 수 있다.
 */
export function useStageItems(ws: WorkspaceView | undefined): NavItem[] {
  const roundMatch = useMatch("/p/:slug/e/:ed/s/:stage/r/:round")
  const stageMatch = useMatch("/p/:slug/s/:stage")
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
    if (!st.rounds) return { ...base, to: `/p/${ws.slug}/s/${st.key}`, current: stageMatch?.params.stage === st.key ? ("page" as const) : undefined }
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
