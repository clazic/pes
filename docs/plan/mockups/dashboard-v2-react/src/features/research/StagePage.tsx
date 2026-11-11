import { Link, useParams } from "react-router";
import { DownloadIcon, FileTextIcon, PrinterIcon } from "lucide-react";
import { Chip } from "@/components/pes/status";
import { STAGE_LABEL, STAGES, type StageKey } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { CardHead, KV } from "@/components/pes/bits";
import { EmptyState } from "@/components/pes/blocks";
import { Status } from "@/components/pes/status";
import { useWs } from "@/features/workspace/WorkspaceLayout";

/** 단계마다 하는 일 — 아직 열리지 않은 단계에서 무엇이 올지 한 줄로 */
const DOES: Record<StageKey, string> = {
  plan: "연구 질문·범위·기한·분량을 정합니다.",
  research: "출처와 자료를 찾고 확인해 조사 노트를 만듭니다.",
  analyze: "쟁점과 표를 만들어 무엇을 말할지 정합니다.",
  write: "장마다 원고를 쓰고 각주를 답니다.",
  verify: "주장을 출처 원문과 대조합니다.",
  publish: "보고서와 공유본을 만듭니다.",
};

/** 단계 보고서(설계 19절 · 사용자 2026-11-12 "모든 단계의 마지막에 정리해서 보고서") — 지금 `pes report <단계>`가 만드는 단계 보고서 */
const REPORT: Record<StageKey, { name: string; parts: string[] }> = {
  plan: { name: "기획보고서", parts: ["연구 기획서(한 줄 정의 · 연구 질문 · 목표 · 범위 · 완료 기준)", "목차와 조사 항목", "일정", "정한 것과 근거"] },
  research: { name: "조사보고서", parts: ["조사 항목별 찾은 것", "출처 목록과 확인 상태", "자료 시트", "못 찾은 것 · 다음 단계로 넘길 것"] },
  analyze: { name: "분석보고서", parts: ["쟁점과 판단", "표와 그림", "가정 · 결정 기록", "집필에 넘길 주장"] },
  write: { name: "집필보고서", parts: ["장별 원고 상태", "각주 · 근거 연결", "첨언 처리 결과"] },
  verify: { name: "검증보고서", parts: ["주장별 대조 결과(맞음 · 부분 · 근거 없음)", "고친 곳", "남은 위험"] },
  publish: { name: "최종 보고서", parts: ["완성 보고서", "공유본 · 인쇄본", "쉬운 설명"] },
};

function StageReport({ stageKey, approved, current, to }: { stageKey: StageKey; approved?: string; current: boolean; to: string }) {
  const r = REPORT[stageKey];
  const label = STAGE_LABEL[stageKey];
  return (
    <Card size="compact" aria-labelledby="rep-t">
      <CardHead
        eyebrow="단계 보고서"
        title={r.name}
        titleId="rep-t"
        right={
          approved ? (
            <Chip shape="circle" tone="ok">
              만듦 · {approved.split(" · ")[0]}
            </Chip>
          ) : current ? (
            <Chip shape="dash" tone="off">
              승인하면 만듦
            </Chip>
          ) : (
            <Chip shape="dash" tone="off">
              시작 전
            </Chip>
          )
        }
      />
      <p className="text-meta text-ink-2">
        {approved
          ? `${label} 단계를 승인할 때 이 단계에서 한 일을 정리해 만든 보고서입니다. 승인한 내용 그대로 고정돼 있습니다.`
          : current
            ? `${label} 단계를 승인하면 AI가 이 단계에서 한 일을 정리해 ${r.name}를 만듭니다. 지금까지의 초안을 미리 볼 수 있습니다.`
            : `${label} 단계를 마치면 ${r.name}가 여기 생깁니다.`}
      </p>
      <ul className="mt-2 grid gap-1 text-meta sm:grid-cols-2">
        {r.parts.map((p) => (
          <li key={p} className="flex items-start gap-1.5">
            <FileTextIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            {p}
          </li>
        ))}
      </ul>
      {approved || current ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button asChild size="sm">
            <Link to={to}>{approved ? `${r.name} 열기` : "초안 미리 보기"}</Link>
          </Button>
          {approved ? (
            <>
              <Button size="sm" variant="outline">
                <PrinterIcon aria-hidden="true" />
                인쇄
              </Button>
              <Button size="sm" variant="outline">
                <DownloadIcon aria-hidden="true" />
                내려받기
              </Button>
              <Button size="sm" variant="ghost">
                쉬운 설명 보기
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

/**
 * 단계 결과 요약(설계 16.2 — 단계 길에서 지난 단계를 다시 보기). 승인본 요약 · 앞 단계 변경 — 다시 확인 · 아직.
 * 지금 단계는 “지금 할 일”로 보낸다. 전체 원문·비교는 판 화면(4단계).
 */
export function StagePage() {
  const { ws, roundPath } = useWs();
  const { stage = "" } = useParams();
  const st = ws.stages.find((s) => s.key === stage);
  if (!st) return <div className="mt-5"><EmptyState title="없는 단계입니다" body="단계는 기획 · 조사 · 분석·종합 · 집필 · 검증 · 산출·공유 여섯입니다." /></div>;
  const key = st.key;
  const summary = ws.stage_summaries[key];
  const idx = STAGES.indexOf(key);
  const prev = idx > 0 ? STAGES[idx - 1] : undefined;

  return (
    <div className="mt-5 space-y-4">
      <Card size="compact" aria-labelledby="stg-t">
        <CardHead eyebrow="단계 결과" title={`${STAGE_LABEL[key]} 단계`} titleId="stg-t" right={<Status of="stage" value={st.view} label={st.state_text} />} />
        {st.view === "stale" ? (
          <p className="mb-3 rounded-lg border border-warn-line bg-warn-soft px-3 py-2 text-meta">
            앞 단계를 다시 열어 이 단계의 결과를 다시 봐야 합니다. 승인 기록은 지우지 않습니다.
          </p>
        ) : null}
        {summary ? (
          <>
            <KV items={[["승인", summary.approved], ["대표 결과물", summary.result]]} />
            <ul className="mt-3 list-disc space-y-1 pl-5 text-meta leading-relaxed">
              {summary.points.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button asChild size="sm">
                <Link to={summary.href}>판 화면에서 전체 보기</Link>
              </Button>
            </div>
          </>
        ) : st.rounds ? (
          <p className="text-meta text-ink-2">지금 진행 중인 단계입니다 — {DOES[key]}</p>
        ) : (
          <p className="text-meta text-ink-2">
            아직 열리지 않았습니다{prev ? ` — ${STAGE_LABEL[prev]} 단계 승인 뒤에 열립니다` : ""}. 이 단계에서는 {DOES[key]}
          </p>
        )}
        {st.rounds ? (
          <div className="mt-3">
            <Button asChild variant="default" size="sm">
              <Link to={roundPath}>지금 할 일로</Link>
            </Button>
          </div>
        ) : null}
      </Card>
      <StageReport stageKey={key} approved={summary?.approved} current={Boolean(st.rounds) && !summary} to={`/p/${ws.slug}/s/${key}/report`} />
    </div>
  );
}
