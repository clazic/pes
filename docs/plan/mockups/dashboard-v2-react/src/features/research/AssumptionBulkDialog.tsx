import * as React from "react";
import { pes, PesApiError } from "@/api/mock-client";
import type { ProposalView } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/**
 * UI7-4b 판단 전 가정 일괄 받아들이기(설계 18.10).
 * - 가정마다 decision.record(verdict accept)를 따로 보낸다 — 서버에 묶음 명령이 없으므로 원자성을 약속하지 않는다.
 * - 성공·실패·이미 판단됨을 각각 세고, 실패한 것만 다시 보낼 수 있다.
 * - 다시 보낼 때는 실패한 행만 보여 주고, 행마다 처음 만든 멱등 키를 그대로 쓴다.
 */

type Phase = "confirm" | "running" | "done";
type RunKind = "first" | "retry";
type RowState = "waiting" | "running" | "accepted" | "failed" | "already";
type Row = { id: string; text: string; basis: string; key: string; state: RowState; reason?: string };

const firstLine = (text: string) => text.split("\n")[0];

function newKey() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `k-${Date.now()}-${Math.random()}`;
}

function failureReason(err: unknown) {
  if (err instanceof PesApiError) {
    if (err.code === "permission_denied") return "권한 — 소유자만 가정을 확인할 수 있습니다.";
    if (err.code === "version_conflict") return "버전 충돌 — 판단 전 그대로 두었습니다.";
    if (err.code === "result_unknown") return "결과 불명 — 접수됐는지 확인하지 못했습니다. 같은 요청 번호로 다시 보냅니다.";
    if (err.code === "network_unreachable") return "연결 끊김 — 보내지 못했습니다.";
  }
  return "확인하지 못함 — 잠시 뒤 다시 시도해 주세요.";
}

function rowStateText(state: RowState) {
  if (state === "running") return "보내는 중";
  if (state === "accepted") return "받아들임";
  if (state === "failed") return "실패";
  if (state === "already") return "이미 판단됨";
  return "기다리는 중";
}

export function AssumptionBulkDialog({
  slug,
  assumptions,
  open,
  onOpenChange,
}: {
  slug: string;
  /** 대화 상자를 연 순간의 판단 전 가정 — 보내는 동안 목록이 줄어도 이 묶음은 그대로 둔다 */
  assumptions: ProposalView[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [rows, setRows] = React.useState<Row[]>(() => assumptions.map((p) => ({ id: p.id, text: p.text, basis: p.basis, key: newKey(), state: "waiting" })));
  const [phase, setPhase] = React.useState<Phase>("confirm");
  const [runKind, setRunKind] = React.useState<RunKind>("first");
  const [runIds, setRunIds] = React.useState<string[]>([]);
  const [receipts, setReceipts] = React.useState<string[]>([]);
  const busyRef = React.useRef(false);
  const resultRef = React.useRef<HTMLParagraphElement>(null);

  const total = rows.length;
  const accepted = rows.filter((r) => r.state === "accepted").length;
  const failedRows = rows.filter((r) => r.state === "failed");
  const already = rows.filter((r) => r.state === "already").length;
  const runRows = rows.filter((r) => runIds.includes(r.id));
  const runCount = runRows.length;
  const canClose = phase !== "running";

  // 결과 문단으로 초점을 옮긴다 — 누른 단추가 사라질 때 초점이 대화 상자 밖으로 새지 않게(리뷰 2)
  React.useEffect(() => {
    if (phase === "done") resultRef.current?.focus();
  }, [phase]);

  const send = async (targets: Row[]) => {
    if (busyRef.current || targets.length === 0) return;
    busyRef.current = true;
    setRunIds(targets.map((t) => t.id));
    setPhase("running");
    setRows((prev) => prev.map((r) => (targets.some((t) => t.id === r.id) ? { ...r, state: "waiting", reason: undefined } : r)));
    const newReceipts: string[] = [];
    for (const target of targets) {
      setRows((prev) => prev.map((r) => (r.id === target.id ? { ...r, state: "running" } : r)));
      try {
        // 행에 처음 만든 멱등 키를 그대로 쓴다 — 결과 불명 뒤 다시 보내도 두 번 처리되지 않는다.
        const res = await pes.command("decision.record", { slug, proposal_id: target.id, verdict: "accept" }, { idempotencyKey: target.key });
        newReceipts.push(res.receipt.receipt_no);
        setRows((prev) => prev.map((r) => (r.id === target.id ? { ...r, state: "accepted" } : r)));
      } catch (err) {
        const judged = err instanceof PesApiError && err.code === "already_judged";
        setRows((prev) => prev.map((r) => (r.id === target.id ? { ...r, state: judged ? "already" : "failed", reason: judged ? undefined : failureReason(err) } : r)));
      }
    }
    if (newReceipts.length) setReceipts((prev) => [...prev, ...newReceipts]);
    busyRef.current = false;
    setPhase("done");
  };

  const start = () => {
    setRunKind("first");
    void send(rows);
  };
  const retry = () => {
    setRunKind("retry");
    void send(failedRows);
  };

  const title =
    phase === "running" && runKind === "retry"
      ? `실패한 가정 ${runCount}개 다시 보내기`
      : phase === "done"
        ? "가정 확인 결과"
        : `판단 전 가정 ${total}개 받아들이기`;

  return (
    <Dialog open={open} onOpenChange={(next) => (canClose ? onOpenChange(next) : undefined)}>
      <DialogContent showCloseButton={false} aria-busy={phase === "running" || undefined}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {phase === "confirm" ? (
            <DialogDescription>{total}개를 확인으로 기록합니다 — 판단자: 나</DialogDescription>
          ) : phase === "running" ? (
            <DialogDescription>
              {runKind === "retry" ? `실패한 가정 ${runCount}개를 다시 보냅니다 — 판단자: 나` : `${runCount}개를 확인으로 기록합니다 — 판단자: 나`}
            </DialogDescription>
          ) : (
            <DialogDescription>받아들인 가정은 기록되고, 실패한 가정은 판단 전 그대로입니다.</DialogDescription>
          )}
        </DialogHeader>

        {phase === "confirm" ? (
          <ol aria-label="받아들일 가정" className="max-h-64 space-y-1.5 overflow-y-auto pr-1">
            {rows.map((row, i) => (
              <li key={row.id} className="flex gap-2 rounded-lg border border-line px-2.5 py-2 text-meta">
                <span className="shrink-0 tabular-nums text-muted-foreground">{i + 1}.</span>
                <span className="min-w-0">
                  <span className="block text-ink">{firstLine(row.text)}</span>
                  <span className="mt-0.5 block text-caption text-muted-foreground">근거: {row.basis}</span>
                </span>
              </li>
            ))}
          </ol>
        ) : phase === "running" ? (
          <ol aria-label={runKind === "retry" ? "다시 보낼 가정" : "받아들일 가정"} className="max-h-64 space-y-1.5 overflow-y-auto pr-1">
            {runRows.map((row, i) => (
              <li key={row.id} className="flex gap-2 rounded-lg border border-line px-2.5 py-2 text-meta">
                <span className="shrink-0 tabular-nums text-muted-foreground">{i + 1}.</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-ink">{firstLine(row.text)}</span>
                  <span className="mt-0.5 block text-caption text-muted-foreground">근거: {row.basis}</span>
                </span>
                <span className="shrink-0 text-caption text-muted-foreground">{rowStateText(row.state)}</span>
              </li>
            ))}
          </ol>
        ) : (
          <div className="space-y-2">
            <p ref={resultRef} role="status" tabIndex={-1} className="text-body font-medium text-ink">
              {total}개 중 {accepted}개 받아들임 · {failedRows.length}개 실패
            </p>
            {already > 0 ? <p className="text-meta text-ink-2">이미 판단됨 {already}개</p> : null}
            {failedRows.length ? (
              <ul aria-label="실패한 가정" className="space-y-1.5">
                {failedRows.map((row) => (
                  <li key={row.id} className="rounded-lg border border-line px-2.5 py-2 text-meta">
                    <span className="block text-ink">{firstLine(row.text)}</span>
                    <span className="mt-0.5 block text-caption text-muted-foreground">{row.reason}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            {receipts.length ? <p className="text-caption text-muted-foreground">묶음 접수 번호 {receipts[0]}</p> : null}
          </div>
        )}

        <DialogFooter>
          {phase === "confirm" ? (
            <>
              <Button onClick={start}>{total}개 받아들이기</Button>
              <Button
                variant="ghost"
                onClick={() => {
                  onOpenChange(false);
                }}
              >
                취소
              </Button>
            </>
          ) : phase === "running" ? (
            <>
              <Button aria-disabled="true" onClick={(e) => e.preventDefault()}>
                {runKind === "retry" ? `${runCount}개 다시 보내는 중…` : `${runCount}개 받아들이는 중…`}
              </Button>
              <Button variant="ghost" aria-disabled="true" onClick={(e) => e.preventDefault()}>
                취소
              </Button>
            </>
          ) : (
            <>
              {failedRows.length ? (
                <Button variant="outline" onClick={retry}>
                  실패한 것만 다시
                </Button>
              ) : null}
              <Button onClick={() => onOpenChange(false)}>닫기</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
