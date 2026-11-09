import { Link } from "react-router";
import type { WorkspaceView } from "@/api/types";
import { StatBar } from "@/components/pes/blocks";
import { MoreContent, MoreList, MoreRoot, MoreTrigger } from "@/components/pes/disclosure";
import { StatusFrom } from "@/components/pes/status";
import { AiWork } from "./AiWork";
import { useWs, WorkspaceFrame } from "./WorkspaceLayout";

const stripValue = (ws: WorkspaceView, k: string) => ws.strip.find((c) => c.k === k)?.v ?? "—";

/**
 * 핵심 상태 줄(설계 3.2 상태 줄 6칸) — 5차부터 작업 기록 화면 맨 위(연구 공간의 “지금 할 일”은 한 가지 일만 둔다).
 * 첫눈에 4칸(실행 · 답 제출 · 단계 승인 · 내 컴퓨터/API 사용량), 나머지 칸과 관측 셋은 “자세히”(지우지 않음).
 */
function KeyStats({ ws }: { ws: WorkspaceView }) {
  const t = ws.third_card;
  const fourth = {
    k: t.kind === "computer" ? "내 컴퓨터" : "API 사용량",
    v: (
      <span className="inline-flex flex-wrap items-center gap-x-1.5">
        <StatusFrom s={t.status} />
        {t.short ? <span className="text-caption font-normal text-muted-foreground">{t.short}</span> : null}
      </span>
    ),
    to: t.kind === "computer" ? `/p/${ws.slug}/sync` : "/usage",
  };
  const others = ws.strip.filter((c) => !["실행", "답 제출", "단계 승인", "내 컴퓨터", "API 사용량"].includes(c.k));
  const roundPath = `/p/${ws.slug}/e/${ws.edition}/s/${ws.current.stage}/r/${ws.current.round}`;
  return (
    <MoreRoot>
      <StatBar
        label="핵심 상태 — 서로 다른 사실을 나눠 보여 줌"
        cells={[
          { k: "실행", v: <StatusFrom s={ws.ai_card.status} wrap />, to: "#ai-full" },
          { k: "답 제출", v: stripValue(ws, "답 제출"), to: `${roundPath}?t=answer` },
          { k: "단계 승인", v: stripValue(ws, "단계 승인"), to: `${roundPath}?t=approve` },
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
            <MoreList items={[["내 컴퓨터", `${t.device} · ${t.checked}`], ...t.observations.map((o) => [o.k, o.v] as [string, string]), ["동기화", t.foot]]} />
          ) : (
            <MoreList items={[["AI 연결", t.connection], ["사용량", t.line], ["재개·확인", t.foot]]} />
          )}
        </div>
      </MoreContent>
    </MoreRoot>
  );
}

/** /p/<프로젝트>/ai — 연구 공간 “더 보기” → AI 작업 기록: 핵심 상태 · 실행 · 작업 타임라인 · AI에게 묻는 질문 */
export function AiPage() {
  const { ws } = useWs();
  return (
    <WorkspaceFrame active="ai">
      <KeyStats ws={ws} />
      <AiWork ws={ws} id="ai-full" />
      {ws.sync ? (
        <p className="mt-3 text-meta text-ink-2">
          동기화 표는 <Link to={`/p/${ws.slug}/sync`}>내 컴퓨터 연결</Link>로 옮겼습니다.
        </p>
      ) : null}
    </WorkspaceFrame>
  );
}
