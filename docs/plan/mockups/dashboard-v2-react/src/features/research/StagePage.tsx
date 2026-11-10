import { Link, useParams } from "react-router";
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
    </div>
  );
}
