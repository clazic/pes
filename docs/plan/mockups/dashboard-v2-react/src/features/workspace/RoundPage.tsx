import * as React from "react";
import { Link, useLocation, useParams } from "react-router";
import type { WorkspaceView } from "@/api/types";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Button } from "@/components/ui/button";
import { EmptyState, NowCard, StatBar } from "@/components/pes/blocks";
import { MoreContent, MoreList, MoreRoot, MoreTrigger } from "@/components/pes/disclosure";
import { StatusFrom } from "@/components/pes/status";
import { cn } from "@/lib/utils";
import { AiWork } from "./AiWork";
import { PhoneToolsToggle } from "./phone-tools";
import { QuestionPanel } from "./QuestionPanel";
import { ResultPanel } from "./ResultPanel";
import { SyncPanel } from "./SyncPanel";
import { useWs, WorkspaceNav } from "./WorkspaceLayout";

type View = "q" | "result" | "nav";

/** #조각이 가리키는 곳이 숨은 보기 안에 있으면 그 보기로 바꾼다(좁은 화면, Codex F10) */
function viewForHash(hash: string): View | null {
  const h = hash.replace("#", "");
  if (!h) return null;
  if (h === "qpanel" || h.startsWith("q-") || h.startsWith("b-") || h === "q-title" || h === "ap-t") return "q";
  if (h === "result" || h === "refs" || h.startsWith("an-") || h === "result-card" || h === "refl-title") return "result";
  if (h === "nav") return "nav";
  return null;
}

const stripValue = (ws: WorkspaceView, k: string) => ws.strip.find((c) => c.k === k)?.v ?? "—";

/**
 * 핵심 상태 줄(설계 3.2 상태 줄 6칸 · 3.8 카드 줄을 합침) — 정보 밀도 원칙(14절):
 * 첫눈에는 4칸(실행 · 답 제출 · 단계 승인 · 내 컴퓨터/API 사용량). AI가 읽기는 프로젝트 머리 칩이 이미 말하고,
 * 반영 완료는 결과물 위에 있다. 나머지 칸과 AI 작업·내 컴퓨터 카드의 세부 줄은 “상태 자세히”에 둔다(지우지 않음).
 */
function KeyStats({ ws }: { ws: WorkspaceView }) {
  const t = ws.third_card;
  const fourth =
    t.kind === "computer"
      ? { k: "내 컴퓨터", v: <span className="inline-flex flex-wrap items-center gap-x-1.5"><StatusFrom s={t.status} />{t.short ? <span className="text-[12.5px] font-normal text-muted-foreground">{t.short}</span> : null}</span>, to: "#sync" }
      : { k: "API 사용량", v: <span className="inline-flex flex-wrap items-center gap-x-1.5"><StatusFrom s={t.status} />{t.short ? <span className="text-[12.5px] font-normal text-muted-foreground">{t.short}</span> : null}</span>, to: "/usage" };
  const others = ws.strip.filter((c) => !["실행", "답 제출", "단계 승인", "내 컴퓨터", "API 사용량"].includes(c.k));
  return (
    <MoreRoot className="mt-3">
      <StatBar
        label="핵심 상태 — 서로 다른 사실을 나눠 보여 줌"
        cells={[
          { k: "실행", v: <StatusFrom s={ws.ai_card.status} wrap />, to: "#ai" },
          { k: "답 제출", v: stripValue(ws, "답 제출"), to: "#qpanel" },
          { k: "단계 승인", v: stripValue(ws, "단계 승인"), to: "#ap-t" },
          fourth,
        ]}
        trailing={<MoreTrigger label="자세히" name="핵심 상태 자세히" />}
      />
      <MoreContent className="mt-2 rounded-xl border bg-card px-4 py-3">
        <div className="grid grid-cols-1 gap-x-8 gap-y-3 tab:grid-cols-2">
          <MoreList
            items={[
              ...others.map((c) => [c.k, c.v] as [string, string]),
              ["구성원", ws.members],
              ["실행", `${ws.ai_card.title} — ${ws.ai_card.line}`],
              ["작업", ws.ai_card.foot],
            ]}
          />
          {t.kind === "computer" ? (
            <MoreList
              items={[
                ["내 컴퓨터", `${t.device} · ${t.checked}`],
                ...t.observations.map((o) => [o.k, o.v] as [string, string]),
                ["동기화", t.foot],
              ]}
            />
          ) : (
            <MoreList
              items={[
                ["AI 연결", t.connection],
                ["사용량", t.line],
                ["재개·확인", t.foot],
              ]}
            />
          )}
        </div>
      </MoreContent>
    </MoreRoot>
  );
}

export function RoundPage() {
  const { ws, roundPath } = useWs();
  const { round } = useParams();
  const location = useLocation();
  const [view, setView] = React.useState<View>("q");
  const viewingPast = round !== undefined && round !== ws.current.round;

  React.useEffect(() => {
    const v = viewForHash(location.hash);
    if (v) setView(v);
  }, [location.hash]);

  if (viewingPast) {
    return (
      <div className="mt-3">
        <EmptyState
          eyebrow={`보는 중 ${round === "start" ? "단계 시작" : `R${round}`} · 현재 진행 ${ws.current.label}`}
          title="지난 라운드(봉인본)는 읽기 전용입니다"
          body="답·첨언은 현재 라운드에서 합니다. 지난 결과는 반영 내역과 결과물 버전 기록에 있습니다."
          action={
            <Button asChild variant="default">
              <Link to={roundPath}>현재 진행으로 — {ws.current.label}</Link>
            </Button>
          }
        />
      </div>
    );
  }

  const panel = (v: View) => cn(view !== v && "max-desk:hidden");

  return (
    <>
      {/* 정보 밀도(14절): 제목 → 지금 할 일 1개 → 핵심 상태 4칸 → 본문(결과 글 · 질문 폼) */}
      <NowCard now={ws.now} turn={ws.turn} titleId="now-title" className="mt-4" />
      <KeyStats ws={ws} />

      {/* 1280 미만: 한 열 + 보기 전환(열린 질문이 기본). 라디오 묶음이라 화살표로 옮긴다(설계 C12). */}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 desk:hidden">
        <RadioGroup value={view} onValueChange={(v) => setView(v as View)} aria-label="좁은 화면에서 보기 전환" className="flex flex-wrap gap-1 border-b border-line">
          {(
            [
              ["q", `질문·답${ws.nav_counts.questions ? ` ${ws.nav_counts.questions}` : ""}`],
              ["result", "결과물"],
              ["nav", "단계·탐색"],
            ] as [View, string][]
          ).map(([v, label]) => (
            <label key={v} htmlFor={`view-${v}`} className={cn("-mb-px inline-flex min-h-10 cursor-pointer items-center gap-1.5 rounded-t-lg border border-b-0 px-3.5 text-[13px] font-semibold has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring", view === v ? "border-line bg-surface text-primary-ink" : "border-transparent text-ink-2")}>
              <RadioGroupItem id={`view-${v}`} value={v} className="sr-only" />
              {label}
            </label>
          ))}
        </RadioGroup>
        <PhoneToolsToggle />
      </div>

      {/*
        문서 중심 배치(설계 12.9): 가운데 결과 글 · 오른쪽 질문 폼. 작업 공간 안 이동·단계·라운드는 앱 사이드바에 있어
        사이드바를 접으면 결과 글이 넓어진다. 1280 미만은 한 열 + 보기 전환(질문·답 / 결과물 / 단계·탐색).
      */}
      <div className="mt-4 grid grid-cols-1 items-start gap-5 desk:mt-5 desk:grid-cols-[minmax(0,1fr)_380px] wide:grid-cols-[minmax(0,1fr)_404px]">
        <div className={cn("min-w-0", panel("result"))} id="result" tabIndex={-1}>
          <ResultPanel ws={ws} />
        </div>
        <section className={cn("min-w-0", panel("q"))} id="qpanel" aria-labelledby="q-title" tabIndex={-1}>
          <QuestionPanel ws={ws} />
        </section>
        <WorkspaceNav ws={ws} roundPath={roundPath} className={cn("desk:hidden", view !== "nav" && "hidden")} onPick={(k) => (k === "q" ? setView("q") : k === "result" ? setView("result") : null)} />
      </div>

      <AiWork ws={ws} />
      <SyncPanel ws={ws} />
    </>
  );
}
