import * as React from "react";
import { Link, useMatch } from "react-router";
import { ArrowLeftIcon } from "lucide-react";
import { useWorkspace } from "@/api/queries";
import type { WorkspaceView } from "@/api/types";
import { StatusMark, TONE_TEXT, turnLabel } from "@/components/pes/status";
import { lookup } from "@/components/pes/status-registry";
import { RoundDot } from "@/components/pes/stage-mark";
import { Sidebar, SidebarContent, SidebarGroup, SidebarGroupLabel, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarMenuSub, SidebarMenuSubButton, SidebarMenuSubItem, useSidebar } from "@/components/ui/sidebar";
import { placeLabel, roundLabel, STAGE_LABEL } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { roundHref } from "@/features/workspace/paths";

const ALL_REASON = "모든 프로젝트(관리 공간) 화면은 아직 없어요. 프로젝트 목록 작업에서 열립니다.";
const PENDING_REASON = "아직 시작 전인 단계예요. 앞 단계가 승인되면 열립니다.";

/** 프로젝트 자리(sidebar-07 의 팀 전환 자리) — U1a 는 프로젝트가 하나라 전환 없이 이름 · 차례 · 방식 · 현재 진행만 */
function ProjectBlock({ ws }: { ws?: WorkspaceView }) {
  const sub = ws ? `${turnLabel(ws.turn)} · 방식 ${ws.mode} · ${placeLabel(ws.current.stage, ws.current.round_id)}` : "불러오는 중";
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <div className="flex min-h-12 items-center gap-2 rounded-md p-2 text-sidebar-foreground group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:p-0">
          <div aria-hidden="true" className="flex aspect-square size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary text-caption font-semibold tracking-wider text-sidebar-primary-foreground">
            PES
          </div>
          <div className="grid min-w-0 flex-1 text-left leading-tight group-data-[collapsible=icon]:sr-only">
            <span className="truncate text-meta font-semibold">{ws?.title ?? "연구 공간"}</span>
            <span className="truncate text-caption text-sidebar-foreground/75">{sub}</span>
          </div>
        </div>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

/** 막힌 링크 — 숨기지 않고 aria-disabled + 이유(설계 3.9 · 12.6 R05). 이유는 펼친 사이드바에서 보이고, 접혀도 화면 읽기에 읽힌다 */
function blockedLink(e: React.MouseEvent) {
  e.preventDefault();
}

/**
 * 연구 흐름 — 단계 아래 라운드 나무(설계 4.5 · 4.7 · 12.9 “왼쪽 탐색 열은 사이드바로”). 단계·라운드 탐색은 이 나무 하나뿐이다.
 *  - 단계 링크: 모양 + 상태 사전 이름(승인됨 · 현재 · 나의 할 일 · 시작 전). 그 단계의 가장 최근 라운드로 간다. 접혀도 이름은 남는다(아이콘 줄 · 툴팁).
 *  - 라운드: 현재 단계와 지금 보는 단계 아래에만 펼친다. 단계 시작은 round_id = NULL 이라 “단계 시작”(가짜 R0 없음).
 *    보는 라운드만 aria-current="page", 현재 진행 라운드는 늘 “현재 진행”(지난 라운드를 볼 때도 함께 보인다).
 *  - 휴대폰 판(Sheet)에서는 링크를 누르면 판을 닫는다(초점은 새 화면 제목 — arrival 이 맡음).
 */
function ResearchFlow({ ws }: { ws: WorkspaceView }) {
  const { setOpenMobile } = useSidebar();
  const m = useMatch("/p/:slug/e/:edition/s/:stage/r/:round");
  const viewStage = m?.params.stage;
  const viewRound = m?.params.round === "start" ? null : Number(m?.params.round);
  const close = () => setOpenMobile(false);
  return (
    <nav aria-label="연구 흐름">
      <SidebarGroup>
        <SidebarGroupLabel>연구 흐름 · {ws.edition}판</SidebarGroupLabel>
        <SidebarMenu>
          {ws.stages.map((s) => {
            const def = lookup("stage", s.view);
            const latest = s.rounds.at(-1);
            const here = viewStage === s.key;
            const expanded = s.rounds.length > 0 && (here || ws.current.stage === s.key);
            const reasonId = `sidebar-stage-${s.key}-reason`;
            // 과거 승인은 stale 이어도 남는 사실이다. 이전된 프로젝트의 승인은 “검증 안 됨”을 붙인다(U1d · F06)
            const pastNote = s.past_approval ? (s.past_approval.origin === "legacy_unverified" ? "검증 안 됨" : "과거 승인") : null;
            return (
              <SidebarMenuItem key={s.key}>
                <SidebarMenuButton asChild isActive={here} tooltip={`${STAGE_LABEL[s.key]} · ${def.label}${pastNote ? ` · ${pastNote}` : ""}`}>
                  <Link
                    to={latest ? roundHref(ws.slug, ws.edition, s.key, latest.round_id) : "#"}
                    aria-disabled={latest ? undefined : true}
                    aria-describedby={latest ? undefined : reasonId}
                    onClick={latest ? close : blockedLink}
                    className="no-underline aria-disabled:pointer-events-auto aria-disabled:opacity-100"
                  >
                    <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center">
                      <StatusMark shape={def.shape} className={cn("size-2.5!", TONE_TEXT[def.tone])} />
                    </span>
                    <span className="min-w-0 truncate font-medium">{STAGE_LABEL[s.key]}</span>
                    <span className={cn("ml-auto shrink-0 text-caption", def.tone === "you" ? "font-semibold" : "opacity-75")}>
                      <span className="sr-only"> · </span>
                      {def.label}
                      {pastNote ? ` · ${pastNote}` : null}
                    </span>
                  </Link>
                </SidebarMenuButton>
                {latest ? null : (
                  <span id={reasonId} className="sr-only">
                    {PENDING_REASON}
                  </span>
                )}
                {expanded ? (
                  <SidebarMenuSub className="mr-0 pr-0">
                    {s.rounds.map((r) => {
                      const viewing = here && viewRound === r.round_id;
                      const current = r.state === "current";
                      return (
                        <SidebarMenuSubItem key={r.round_id ?? "start"}>
                          <SidebarMenuSubButton asChild isActive={viewing} className="h-auto min-h-7 py-1 text-meta data-active:font-semibold">
                            <Link to={roundHref(ws.slug, ws.edition, s.key, r.round_id)} aria-current={viewing ? "page" : undefined} onClick={close}>
                              <RoundDot current={current} />
                              <span className="min-w-0 truncate">{roundLabel(r.round_id)}</span>
                              {current ? (
                                <span className="ml-auto shrink-0 rounded-sm border border-primary-line px-1.5 text-caption font-medium text-primary-ink">
                                  <span className="sr-only"> · </span>현재 진행
                                </span>
                              ) : viewing ? (
                                <span className="ml-auto shrink-0 text-caption opacity-75">
                                  <span className="sr-only"> · </span>보는 중
                                </span>
                              ) : null}
                            </Link>
                          </SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                      );
                    })}
                  </SidebarMenuSub>
                ) : null}
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarGroup>
    </nav>
  );
}

/**
 * 앱 셸 사이드바 — 승인 시안의 shadcn sidebar-07 블록(아이콘으로 접힘, collapsible="icon") 연구 공간판(설계 16.2).
 * 머리: “← 모든 프로젝트” · 프로젝트 자리 / 몸: 연구 흐름(단계 아래 라운드 나무). 900px 미만은 같은 내용이 왼쪽 판(Sheet)으로 열린다.
 * U1a 범위 밖인 것(프로젝트 전환 · 이 연구 메뉴 · 관리 공간)은 쓰는 이슈에서 시안 그대로 더한다.
 */
export function AppSidebar() {
  const m = useMatch("/p/:slug/e/:edition/*");
  const edition = Number(m?.params.edition ?? 0);
  const q = useWorkspace(m?.params.slug, edition);
  const ws = q.data ?? undefined;
  return (
    <Sidebar collapsible="icon" data-space="research">
      <SidebarHeader className="gap-1">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild size="sm" tooltip="모든 프로젝트 (아직 없음)" className="text-sidebar-foreground/80">
              <Link to="/" aria-disabled="true" aria-describedby="sidebar-all-reason" onClick={blockedLink} className="no-underline aria-disabled:pointer-events-auto aria-disabled:opacity-100">
                <ArrowLeftIcon aria-hidden="true" />
                <span>모든 프로젝트</span>
              </Link>
            </SidebarMenuButton>
            <span id="sidebar-all-reason" className="sr-only">
              {ALL_REASON}
            </span>
          </SidebarMenuItem>
        </SidebarMenu>
        <ProjectBlock ws={ws} />
      </SidebarHeader>
      <SidebarContent>{ws ? <ResearchFlow ws={ws} /> : null}</SidebarContent>
    </Sidebar>
  );
}
