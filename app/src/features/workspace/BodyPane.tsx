import * as React from "react";
import { Link } from "react-router";
import { ArrowRight, CircleAlert, Copy, MessageSquarePlus, Printer } from "lucide-react";
import { useAcknowledgeAlert } from "@/api/queries";
import type { AlertView, RoundView, WorkspaceView } from "@/api/types";
import { ActionButton } from "@/components/pes/action-button";
import { Button } from "@/components/ui/button";
import { roundHref } from "./paths";

function AlertCard({ alert, slug, edition }: { alert: AlertView; slug: string; edition: number }) {
  const ack = useAcknowledgeAlert(slug, edition);
  const titleId = `${alert.id}-title`;
  return (
    <section aria-labelledby={titleId} className="mt-5 flex gap-3 rounded-lg border border-bad-line bg-bad-soft px-4 py-3" data-print="hide">
      <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-bad" />
      <div className="min-w-0 flex-1">
        <h2 id={titleId} className="text-meta font-semibold text-bad">
          {alert.title}
        </h2>
        <p className="mt-0.5 text-meta text-ink">{alert.detail}</p>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-caption text-ink-2">{alert.at}</span>
          {alert.acknowledged ? (
            <span className="text-caption font-medium text-ink-2">
              확인함 · {alert.acknowledged.receipt_no}
            </span>
          ) : (
            <Button variant="outline" size="sm" disabled={ack.isPending} onClick={() => ack.mutate(alert.id)}>
              오류 확인
            </Button>
          )}
          <span role="status" className="sr-only">
            {alert.acknowledged ? "오류를 확인했습니다" : ""}
          </span>
        </div>
      </div>
    </section>
  );
}

/** 프롬프트 복사 — 클립보드를 못 쓰면(휴대폰·권한) 고를 수 있는 글 칸을 대안으로 펼친다 */
function useCopy(text: string) {
  const [state, setState] = React.useState<"idle" | "copied" | "fallback">("idle");
  const copy = React.useCallback(() => {
    const clip = navigator.clipboard;
    if (!clip?.writeText) {
      setState("fallback");
      return;
    }
    clip.writeText(text).then(
      () => setState("copied"),
      () => setState("fallback"),
    );
  }, [text]);
  return { state, copy, close: () => setState("idle") };
}

/**
 * 본문 영역(설계 4.7 · 14절 정보 밀도): 화면 제목 · (지난 라운드면 읽기 전용 안내) · 나의 할 일 하나 · 도구 · 오류 알림 · 결과 글.
 */
export function BodyPane({
  ws,
  round,
  annotateBlocked,
  onPrint,
  onGoToQuestions,
}: {
  ws: WorkspaceView;
  round: RoundView;
  annotateBlocked?: string;
  onPrint: () => void;
  onGoToQuestions: () => void;
}) {
  const past = round.state !== "current";
  const isStart = round.round_id === null;
  const currentStage = ws.stages.find((s) => s.key === ws.current.stage);
  const currentRound = currentStage?.rounds.find((r) => r.round_id === ws.current.round_id);
  const currentName = currentStage && currentRound ? `${currentStage.label} ${currentRound.round_id === null ? "단계 시작" : currentRound.label}` : "";
  const copy = useCopy(round.prompt);
  const [annotating, setAnnotating] = React.useState(false);
  const open = round.questions.filter((q) => !q.sent);

  return (
    <div className="mx-auto w-full max-w-[46rem] px-4 pt-5 pb-16 tab:px-6">
      {past ? (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border bg-surface-soft px-3 py-2 text-meta text-ink-2">
          <span className="font-semibold text-ink">{isStart ? "지난 단계 시작" : "지난 라운드"} · 보는 중</span>
          <span>읽기 전용입니다.</span>
          {currentName ? (
            <Link to={roundHref(ws.slug, ws.edition, ws.current.stage, ws.current.round_id)} className="ml-auto">
              현재 진행 {currentName}로
            </Link>
          ) : null}
        </p>
      ) : ws.turn.side === "you" && open.length ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-primary-line bg-primary-soft px-4 py-3">
          <p className="min-w-0 flex-1 text-body text-ink">
            <span className="mr-2 rounded-sm bg-primary px-1.5 py-0.5 text-caption font-semibold text-primary-foreground">나의 할 일</span>
            {ws.turn.text}
          </p>
          <Button variant="default" size="sm" onClick={onGoToQuestions}>
            질문으로 가기
            <ArrowRight aria-hidden="true" />
          </Button>
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap items-start gap-2" data-print="hide">
        <Button id="tool-print" variant="outline" size="sm" onClick={onPrint}>
          <Printer aria-hidden="true" />
          인쇄 미리보기
        </Button>
        <Button variant="outline" size="sm" onClick={copy.copy} aria-expanded={copy.state === "fallback"} aria-controls="copy-fallback">
          <Copy aria-hidden="true" />
          프롬프트 복사
        </Button>
        <ActionButton
          variant="outline"
          size="sm"
          blockedReason={annotateBlocked}
          reasonId="annotate-reason"
          reasonClassName="max-w-56"
          aria-expanded={annotateBlocked ? undefined : annotating}
          aria-controls={annotateBlocked ? undefined : "annotate-panel"}
          onClick={() => setAnnotating((v) => !v)}
        >
          <MessageSquarePlus aria-hidden="true" />
          첨언 쓰기
        </ActionButton>
        <span role="status" className="self-center text-caption text-ink-2">
          {copy.state === "copied" ? "프롬프트를 복사했어요" : ""}
        </span>
      </div>

      {copy.state === "fallback" ? (
        <div id="copy-fallback" className="mt-3 rounded-md border bg-surface-soft p-3">
          <label htmlFor="copy-text" className="block text-meta font-medium text-ink">
            프롬프트 — 길게 누르거나 모두 골라 복사하세요
          </label>
          <textarea id="copy-text" readOnly rows={5} value={round.prompt} onFocus={(e) => e.currentTarget.select()} className="mt-1 block w-full rounded-md border border-control bg-background px-2.5 py-2 font-mono text-meta text-ink" />
          <Button variant="ghost" size="sm" className="mt-2" onClick={copy.close}>
            닫기
          </Button>
        </div>
      ) : null}

      {!annotateBlocked && annotating ? (
        <div id="annotate-panel" className="mt-3 rounded-md border bg-surface-soft p-3">
          <label htmlFor="annotate-text" className="block text-meta font-medium text-ink">
            첨언
          </label>
          <textarea id="annotate-text" rows={3} className="mt-1 block w-full rounded-md border border-control bg-background px-2.5 py-2 text-body text-ink" />
          <p className="mt-1 text-caption text-muted-foreground">합성 자료 화면이라 첨언을 보내지 않습니다. 결과 글 첨언은 U4에서 연결됩니다.</p>
        </div>
      ) : null}

      {round.alerts.map((a) => (
        <AlertCard key={a.id} alert={a} slug={ws.slug} edition={ws.edition} />
      ))}

      <article className="mt-8" aria-labelledby="result-title">
        {round.result ? (
          <>
            <h2 id="result-title" className="text-title text-ink">
              {round.result.title}
            </h2>
            <p className="mt-0.5 text-caption text-muted-foreground">{round.result.meta}</p>
            <div className="mt-3 space-y-4">
              {round.result.paragraphs.map((p) => (
                <p key={p} className="text-body text-ink">
                  {p}
                </p>
              ))}
            </div>
          </>
        ) : (
          <>
            <h2 id="result-title" className="text-title text-ink">
              결과 글
            </h2>
            <p className="mt-2 text-body text-ink-2">단계 시작에는 결과 글이 없습니다. 이 단계를 시작하며 받은 질문과 답만 있어요.</p>
          </>
        )}
      </article>
    </div>
  );
}
