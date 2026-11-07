import * as React from "react";
import { Outlet, useNavigate, useOutletContext, useParams } from "react-router";
import { BookOpenIcon, EllipsisIcon, PrinterIcon } from "lucide-react";
import { useWorkspace } from "@/api/queries";
import type { WorkspaceView } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { NavMain } from "@/components/nav-main";
import { NavProjects, useStageItems, type WorkspaceNavKey } from "@/components/nav-projects";
import { ModeBadge, Tag } from "@/components/pes/bits";
import { LoadError, QuietLoading } from "@/components/pes/blocks";
import { StatusFrom } from "@/components/pes/status";
import { RefreshChip } from "@/app/SiteHeader";
import { cn } from "@/lib/utils";

export interface WsContext {
  ws: WorkspaceView;
  roundPath: string;
}

export function useWs() {
  return useOutletContext<WsContext>();
}

/** 작업 공간 틀(설계 4.5): 프로젝트 머리 + 아래 화면. 작업 공간 안 이동·단계·라운드 나무는 앱 사이드바에 있다. */
export function WorkspaceLayout() {
  const { slug = "" } = useParams();
  const q = useWorkspace(slug);
  if (q.isPending) return <QuietLoading what="작업 공간" />;
  if (q.isError || !q.data) return <LoadError what="작업 공간" lastReceived="—" code="W-0404" onRetry={() => q.refetch()} />;
  const ws = q.data;
  const roundPath = `/p/${slug}/e/${ws.edition}/s/${ws.current.stage}/r/${ws.current.round}`;
  return (
    <>
      <ProjectHead ws={ws} />
      <Outlet context={{ ws, roundPath } satisfies WsContext} />
    </>
  );
}

/**
 * 프로젝트 머리(설계 3.2) — 카드 대신 쪽 머리. 빵부스러기(현재 위치)는 머리줄로 옮겼다.
 * 정보 밀도(14절): 제목 · 판 · 현재 진행 · 방식 한 줄 + 오른쪽에 AI가 읽기 · 갱신 칩. 차례는 바로 아래 지금 할 일 띠의 차례 표시기(15절).
 * 결정 기록 · 인쇄는 “더 보기” 메뉴로, 구성원은 핵심 상태의 “상태 자세히”로 옮겼다.
 */
function ProjectHead({ ws }: { ws: WorkspaceView }) {
  const { round } = useParams();
  const navigate = useNavigate();
  const viewingPast = round !== undefined && round !== ws.current.round;
  return (
    <section aria-labelledby="ptitle" className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
      {/* 왼쪽은 최소 20rem — 좁은 화면에서 오른쪽 칩이 제목을 누르지 않고 다음 줄로 내려간다 */}
      <div className="min-w-0 flex-[1_1_20rem]">
        <h1 id="ptitle" className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[22px] tracking-tight">
          {ws.title} <Tag>{ws.edition}판</Tag>
          <span data-mock="note">
            <Tag>가상 프로젝트</Tag>
          </span>
        </h1>
        <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px] text-muted-foreground">
          {viewingPast ? (
            <>
              <strong className="font-semibold text-foreground">보는 중 R{round}</strong> · 현재 진행 <strong className="font-semibold text-foreground">{ws.current.label}</strong>
            </>
          ) : (
            <>
              <span className="sr-only">현재 진행: </span>
              <strong className="font-semibold text-foreground">{ws.current.label}</strong>
            </>
          )}
          <span aria-hidden="true">·</span>
          <ModeBadge mode={ws.mode} detail={ws.mode === "A" ? "웹에서 바로" : "내 컴퓨터 AI"} />
          <span>{ws.runner_label}</span>
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <StatusFrom s={ws.api_transfer} />
        <RefreshChip />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon-sm" variant="outline" aria-label="더 보기 — 결정 기록 · 인쇄">
              <EllipsisIcon aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={6} className="w-44">
            <DropdownMenuItem onSelect={() => navigate("/guide#decisions")}>
              <BookOpenIcon aria-hidden="true" />
              결정 기록
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => window.print()}>
              <PrinterIcon aria-hidden="true" />
              인쇄
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </section>
  );
}

export type NavKey = WorkspaceNavKey;

/**
 * 좁은 화면(1280 미만) 라운드 화면의 “단계·탐색” 보기 — 사이드바와 같은 항목을 본문 안에 펼쳐 그린다.
 * 사이드바가 아이콘으로 접혀 있거나 Sheet로 숨어 있어도 라운드 입구가 본문에 남는다(Codex F10).
 */
export function WorkspaceNav({ ws, roundPath, active, className, onPick }: { ws: WorkspaceView; roundPath: string; active?: NavKey; className?: string; onPick?: (k: NavKey) => void }) {
  const stages = useStageItems(ws);
  return (
    <Card className={cn("gap-0 px-1 py-1", className)} id="nav">
      <NavProjects ws={ws} roundPath={roundPath} active={active} onPick={onPick} expanded ariaLabel="프로젝트 안 이동(본문)" />
      <NavMain label={`단계·라운드 · ${ws.edition}판`} ariaLabel="단계·라운드(본문)" items={stages} expanded />
    </Card>
  );
}

/** 자료·참고·AI 작업·설정 화면의 본문 틀 — 탐색은 사이드바에 있으므로 본문만 둔다. */
export function WorkspaceFrame({ children }: { active?: NavKey; children: React.ReactNode }) {
  return <div className="mt-5 min-w-0">{children}</div>;
}
