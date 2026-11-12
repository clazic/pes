import * as React from "react";
import { Link } from "react-router";
import { CircleAlert, Copy, MessageSquarePlus, Printer } from "lucide-react";
import { newIdempotencyKey, useAcknowledgeAlert } from "@/api/queries";
import type { AlertView, RoundView, WorkspaceView } from "@/api/types";
import { ActionButton } from "@/components/pes/action-button";
import { Button } from "@/components/ui/button";
import { ReflectionSection } from "@/features/records/ReflectionSection";
import { formatAt, placeLabel } from "@/lib/labels";
import { roundHref } from "./paths";
import { RecordsPanel, RunPanel } from "./StatusPanels";

function AlertCard({ alert, slug, edition }: { alert: AlertView; slug: string; edition: number }) {
  const ack = useAcknowledgeAlert(slug, edition);
  // 한 번 누름에 멱등 키 하나 — 응답을 못 받아 다시 누르면 같은 키로 다시 보낸다(두 번 처리되지 않음)
  const key = React.useRef<string | null>(null);
  // 사람이 이 단추로 확인했으면, 단추가 결과 줄로 바뀌는 그 순간 결과 줄로 초점을 옮긴다(BODY 로 떨어지지 않게)
  const wantFocus = React.useRef(false);
  const resultRef = React.useRef<HTMLSpanElement>(null);
  const sending = ack.isPending;
  const onAck = (e: React.MouseEvent) => {
    // 보내는 동안은 disabled 대신 aria-disabled + 무시 — disabled 는 초점을 빼앗는다(설계 12.6 R05)
    if (sending) {
      e.preventDefault();
      return;
    }
    key.current ??= newIdempotencyKey();
    wantFocus.current = true;
    ack.mutate({ alertId: alert.id, key: key.current });
  };
  const acknowledged = !!alert.acknowledged;
  React.useLayoutEffect(() => {
    if (acknowledged && wantFocus.current) {
      wantFocus.current = false;
      resultRef.current?.focus();
    }
  }, [acknowledged]);
  const titleId = `${alert.id}-title`;
  const sendingId = `${alert.id}-sending`;
  return (
    <section aria-labelledby={titleId} className="mt-5 flex gap-3 rounded-lg border border-bad-line bg-bad-soft px-4 py-3" data-print="hide">
      <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-bad" />
      <div className="min-w-0 flex-1">
        <h2 id={titleId} className="text-meta font-semibold text-bad">
          {alert.title}
        </h2>
        <p className="mt-0.5 text-meta text-ink">{alert.detail}</p>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-caption text-ink-2">
            <time dateTime={alert.raised_at}>{formatAt(alert.raised_at)}</time>
          </span>
          {alert.acknowledged ? (
            <span ref={resultRef} tabIndex={-1} className="rounded-sm text-caption font-medium text-ink-2 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
              확인함 · 접수 {alert.acknowledged.receipt_no}
            </span>
          ) : (
            <>
              <Button variant="outline" size="sm" aria-disabled={sending || undefined} aria-describedby={sending ? sendingId : undefined} onClick={onAck}>
                오류 확인
              </Button>
              {sending ? (
                <span id={sendingId} className="text-caption text-ink-2">
                  보내는 중…
                </span>
              ) : null}
            </>
          )}
          <span role="status" className="sr-only">
            {alert.acknowledged ? "오류를 확인했습니다" : ""}
          </span>
          {ack.isError ? (
            <span role="alert" className="text-caption font-medium text-bad">
              확인하지 못했어요. {ack.error.message} 다시 눌러 주세요.
            </span>
          ) : null}
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
 * 본문 영역(설계 4.7 · 14절 정보 밀도): (지난 라운드면 읽기 전용 안내) · 도구 · 오류 알림 · 결과 글. 화면 제목 · 지금 할 일은 화면 머리(main 위쪽)가 맡는다.
 */
export function BodyPane({
  ws,
  round,
  annotateBlocked,
  onPrint,
}: {
  ws: WorkspaceView;
  round: RoundView;
  annotateBlocked?: string;
  onPrint: () => void;
}) {
  const past = round.state !== "current";
  const isStart = round.round_id === null;
  const currentName = placeLabel(ws.current.stage, ws.current.round_id);
  const copy = useCopy(round.prompt);
  const [annotating, setAnnotating] = React.useState(false);

  return (
    <div className="mx-auto w-full max-w-[46rem] px-4 pt-5 pb-16 tab:px-6">
      {/* 다음 라운드 첫머리 — 지난 라운드 의견이 어떻게 반영됐는지(U3b). 본문 맨 위, 기록 영역보다 앞 */}
      <ReflectionSection slug={ws.slug} edition={ws.edition} stage={round.stage} round={isStart ? "start" : String(round.round_id)} className="mb-6 border-b pb-6" />
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
      ) : null}

      <div className="mt-4 flex flex-wrap items-start gap-2 first:mt-0" data-print="hide">
        <Button id="tool-print" variant="outline" size="sm" onClick={onPrint}>
          <Printer aria-hidden="true" />
          인쇄 미리보기
        </Button>
        <Button variant="outline" size="sm" onClick={copy.copy} aria-expanded={copy.state === "fallback"} aria-controls={copy.state === "fallback" ? "copy-fallback" : undefined}>
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
          aria-controls={!annotateBlocked && annotating ? "annotate-panel" : undefined}
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
            <p className="mt-0.5 text-caption text-muted-foreground">
              v{round.result.version} · {round.result.status === "adopted" ? "채택본" : "초안"} · <time dateTime={round.result.updated_at}>{formatAt(round.result.updated_at, false)}</time>
            </p>
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

      <RunPanel ws={ws} />
      <RecordsPanel ws={ws} />
    </div>
  );
}
