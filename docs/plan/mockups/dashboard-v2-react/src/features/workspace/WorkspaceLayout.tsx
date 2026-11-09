import * as React from "react";
import { Outlet, useLocation, useNavigate, useOutletContext, useParams } from "react-router";
import { BookOpenIcon, EllipsisIcon, PrinterIcon } from "lucide-react";
import { setFocusProject, useWorkspace } from "@/api/queries";
import type { WorkspaceView } from "@/api/types";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Kbd, ModeBadge, Tag } from "@/components/pes/bits";
import { LoadError, QuietLoading } from "@/components/pes/blocks";
import { StatusFrom } from "@/components/pes/status";
import { RefreshChip } from "@/app/SiteHeader";
import { AiPartner } from "@/features/research/AiPartner";
import { researchPlaceLabel } from "@/features/research/place";
import { aiSheet, researchUi, saveLastLocation, useAiSheet, useIsDesk, useResearchKeys, useResearchUi } from "@/lib/research-ui";
import { cn } from "@/lib/utils";

export interface WsContext {
  ws: WorkspaceView;
  roundPath: string;
}

export function useWs() {
  return useOutletContext<WsContext>();
}

/** 작업 공간(연구 공간) 틀(설계 4.5 → 16.2): 프로젝트 머리 + 가운데 한 가지 일 + 오른쪽 AI 동료. */
export function WorkspaceLayout() {
  const { slug = "" } = useParams();
  const q = useWorkspace(slug);
  if (q.isPending) return <QuietLoading what="연구 공간" />;
  if (q.isError || !q.data) return <LoadError what="연구 공간" lastReceived="—" code="W-0404" onRetry={() => q.refetch()} />;
  const ws = q.data;
  const roundPath = `/p/${slug}/e/${ws.edition}/s/${ws.current.stage}/r/${ws.current.round}`;
  return <ResearchShell ws={ws} roundPath={roundPath} />;
}

/** 집중 모드 띠 — 무엇이 접혔는지 · 단축키 · 끝내기. 한 글자 단축키(J/K)는 여기서 끌 수 있다(WCAG 2.1.4). */
function FocusBar() {
  const ui = useResearchUi();
  return (
    <section aria-label="집중 모드" className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-primary-line bg-primary-soft px-3 py-2 text-meta text-ink">
      <strong className="font-semibold text-primary-ink">집중 모드</strong>
      <span>사이드 칸을 접었습니다</span>
      {ui.jk ? (
        <span className="inline-flex items-center gap-1">
          <Kbd>J</Kbd> 다음 · <Kbd>K</Kbd> 이전 항목
        </span>
      ) : (
        <span>한 글자 단축키 꺼짐</span>
      )}
      <span className="inline-flex items-center gap-1">
        <Kbd>Esc</Kbd> 끝내기
      </span>
      <span className="ml-auto flex flex-wrap items-center gap-3">
        <span className="inline-flex items-center gap-1.5">
          <Switch id="jk-keys" checked={ui.jk} onCheckedChange={(c) => researchUi.set({ jk: c })} />
          <Label htmlFor="jk-keys" className="text-meta font-medium">
            J/K 단축키
          </Label>
        </span>
        <Button size="xs" onClick={() => researchUi.set({ focus: false })}>
          집중 모드 끝내기
        </Button>
      </span>
    </section>
  );
}

/**
 * 연구 공간(집중) — 5차, 설계 16.2.
 * - 가운데: 지금 하는 일 한 가지(아래 화면) · 오른쪽: AI 동료(1280px 이상 칸, 그 아래는 머리줄 단추로 여는 판)
 * - 집중 모드: 사이드 칸 둘을 접고 가운데만(J/K · Esc). 나가면(모든 프로젝트로) 원래대로 되돌린다.
 * - 방해 줄이기: 이 프로젝트의 알림만(머리줄 종 · 토스트 · 화면 읽기 알림)
 * - 마지막 위치를 이 브라우저에 남겨 연구 개요의 “이어서 하기”가 그곳으로 간다.
 */
function ResearchShell({ ws, roundPath }: { ws: WorkspaceView; roundPath: string }) {
  const ui = useResearchUi();
  const desk = useIsDesk();
  const sheet = useAiSheet();
  const { pathname, search, hash } = useLocation();
  useResearchKeys(true);

  // 방해 줄이기: 이 프로젝트의 사건만 알린다
  React.useEffect(() => {
    setFocusProject(ws.slug);
    return () => setFocusProject(null);
  }, [ws.slug]);

  // 마지막 위치(이어서 하기)
  const label = researchPlaceLabel(ws, pathname, search, hash);
  React.useEffect(() => {
    if (label) saveLastLocation(ws.slug, { path: `${pathname}${search}${hash}`, label });
  }, [ws.slug, label, pathname, search, hash]);
  // J/K·Tab으로 옮긴 항목도 위치로 기억(주소는 바꾸지 않음)
  React.useEffect(() => {
    const onFocus = (e: FocusEvent) => {
      const el = (e.target as HTMLElement | null)?.closest?.("[data-jk]");
      const id = el ? (el.id || el.closest("[id]")?.id) : null;
      if (!id || id === "main") return;
      const h = `#${id}`;
      const l = researchPlaceLabel(ws, window.location.pathname, window.location.search, h);
      if (l) saveLastLocation(ws.slug, { path: `${window.location.pathname}${window.location.search}${h}`, label: l });
    };
    const main = document.getElementById("main");
    main?.addEventListener("focusin", onFocus);
    return () => main?.removeEventListener("focusin", onFocus);
  }, [ws]);

  // 집중 모드 ↔ 왼쪽 칸 접기 · 연구 공간을 떠나면 끝내기는 앱 셸(FocusModeSync)이 맡는다 — 이 틀이 사라져도 되돌릴 수 있게

  // 지금 할 일(라운드) · 단계 결과 화면: 가운데에 집중하도록 AI 동료 칸은 접어 두고 한 줄 요약만(펼치면 이 탭에서 유지).
  // 단계 결과는 지난 단계를 다시 보는 곳이라 현재 라운드 이야기인 AI 동료 칸이 맞지 않는다.
  const onRound = /\/e\/[^/]+\/s\/[^/]+\/r\/[^/]+/.test(pathname) || /^\/p\/[^/]+\/s\/[^/]+\/?$/.test(pathname);
  const roundCollapsed = desk && ui.aiPanel && !ui.focus && onRound && !ui.aiOnRound;
  const showPanel = desk && ui.aiPanel && !ui.focus && !roundCollapsed;
  return (
    <>
      <ProjectHead ws={ws} />
      {ui.focus ? <FocusBar /> : null}
      {roundCollapsed ? <AiSummaryLine ws={ws} /> : null}
      <div className={cn("mt-4 grid grid-cols-1 items-start gap-5", showPanel && "desk:grid-cols-[minmax(0,1fr)_320px] wide:grid-cols-[minmax(0,1fr)_368px] xwide:grid-cols-[minmax(0,1fr)_400px]")}>
        {/* data-page: 화면이 바뀌면 이 안의 첫 제목으로 초점이 간다(RootLayout 경로 초점 — 프로젝트 머리 h1은 화면마다 같으므로) */}
        <div data-page="" className={cn("min-w-0", ui.focus && "mx-auto w-full max-w-[60rem]")}>
          <Outlet context={{ ws, roundPath } satisfies WsContext} />
        </div>
        {showPanel ? (
          <aside aria-label="AI 동료 칸" className="min-w-0 desk:sticky desk:top-16 desk:max-h-[calc(100svh-5rem)] desk:overflow-y-auto">
            <AiPartner ws={ws} onCollapse={onRound ? () => researchUi.set({ aiOnRound: false }) : undefined} />
          </aside>
        ) : null}
      </div>
      {!desk ? (
        <Sheet open={sheet.open} onOpenChange={(o) => aiSheet.set({ open: o })}>
          <SheetContent
            side="right"
            className="w-[min(100%,24rem)] gap-0 overflow-y-auto p-0"
            onOpenAutoFocus={(e) => {
              // 결과 글에서 “AI에게 부탁”으로 열었으면 부탁할 말 칸으로 바로
              const el = document.getElementById("aips-text");
              if (el && aiSheet.get().target) {
                e.preventDefault();
                el.focus();
              }
            }}
          >
            <SheetHeader className="sr-only">
              <SheetTitle>AI 동료</SheetTitle>
              <SheetDescription>AI가 지금 하는 일 · AI에게 부탁하기 · AI가 남긴 가정·결정 제안</SheetDescription>
            </SheetHeader>
            <AiPartner ws={ws} idPrefix="aips" className="rounded-none border-0 shadow-none" />
          </SheetContent>
        </Sheet>
      ) : null}
    </>
  );
}

/** 접힌 AI 동료 — 지금 AI 상태 한 줄 + 펼치기(지금 할 일 화면에서만) */
function AiSummaryLine({ ws }: { ws: WorkspaceView }) {
  const pending = ws.proposals.filter((p) => p.state.value === "proposed").length;
  return (
    <section aria-label="AI 동료 요약" className="mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-lg border border-line bg-surface-soft px-3 py-2 text-meta text-ink">
      <strong className="font-semibold">AI 동료</strong>
      <StatusFrom s={ws.ai_card.status} />
      <span className="min-w-0 flex-[1_1_16rem] text-ink-2">
        {ws.ai_card.line}
        {pending ? ` · 판단 전 가정·제안 ${pending}개` : ""}
      </span>
      <Button size="xs" variant="outline" className="coarse:min-h-[44px]" aria-expanded="false" onClick={() => researchUi.set({ aiOnRound: true })}>
        AI 동료 펼치기
      </Button>
    </section>
  );
}

/**
 * 프로젝트 머리(설계 3.2) — 쪽 머리 h1. 정보 밀도(14절): 제목 · 판 · 현재 진행 · 방식 한 줄 + 오른쪽에 AI가 읽기 · 갱신 칩.
 * 차례는 지금 할 일 머리의 차례 표시기(15절). 결정 기록 · 인쇄는 “더 보기” 메뉴.
 */
function ProjectHead({ ws }: { ws: WorkspaceView }) {
  const { round } = useParams();
  const navigate = useNavigate();
  const ui = useResearchUi();
  const viewingPast = round !== undefined && round !== ws.current.round;
  return (
    <section aria-labelledby="ptitle" className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
      {/* 왼쪽은 최소 20rem — 좁은 화면에서 오른쪽 칩이 제목을 누르지 않고 다음 줄로 내려간다 */}
      <div className="min-w-0 flex-[1_1_20rem]">
        <h1 id="ptitle" className={cn("flex flex-wrap items-center gap-x-2 gap-y-1.5 tracking-tight", ui.focus ? "text-title" : "text-page")}>
          {ws.title} <Tag>{ws.edition}판</Tag>
          <span data-mock="note">
            <Tag>가상 프로젝트</Tag>
          </span>
        </h1>
        <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-meta text-muted-foreground">
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

export type NavKey = string;

/** 자료·참고·AI 작업 기록·설정 화면의 본문 틀 — 연구 공간 틀이 머리·AI 동료를 맡으므로 본문만 둔다. */
export function WorkspaceFrame({ children }: { active?: NavKey; children: React.ReactNode }) {
  return <div className="mt-5 min-w-0">{children}</div>;
}
