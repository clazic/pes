import * as React from "react";
import { pes, PesApiError } from "@/api/mock-client";
import type { ProposalView } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/**
 * UI7-4b 판단 전 가정 일괄 받아들이기(설계 18.10).
 * - 가정마다 decision.record(verdict accept)를 따로 보낸다 — 서버에 묶음 명령이 없으므로 원자성을 약속하지 않는다.
 * - 성공·실패·이미 판단됨을 각각 세고, 실패한 것만 다시 보낼 수 있다.
 */

type RowState = "waiting" | "running" | "accepted" | "failed" | "already";
type Row = { id: string; text: string; basis: string; state: RowState; reason?: string };

const firstLine = (text: string) => text.split("\n")[0];

function newKey() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `k-${Date.now()}-${Math.random()}`;
}

function failureReason(err: unknown) {
  if (err instanceof PesApiError) {
    if (err.code === "permission_denied") return "권한 — 소유자만 가정을 확인할 수 있습니다.";
    if (err.code === "version_conflict") return "버전 충돌 — 판단 전 그대로 두었습니다.";
    if (err.code === "network_unreachable") return "연결 끊김 — 보내지 못했습니다.";
  }
  return "확인하지 못함 — 잠시 뒤 다시 시도해 주세요.";
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
  const [rows, setRows] = React.useState<Row[]>(() => assumptions.map((p) => ({ id: p.id, text: p.text, basis: p.basis, state: "waiting" })));
  const [running, setRunning] = React.useState(false);
  const [finished, setFinished] = React.useState(false);
  const [receipts, setReceipts] = React.useState<string[]>([]);

  const total = rows.length;
  const accepted = rows.filter((r) => r.state === "accepted").length;
  const failedRows = rows.filter((r) => r.state === "failed");
  const already = rows.filter((r) => r.state === "already").length;
  const canClose = !running;

  const send = async (targets: Row[]) => {
    if (running || targets.length === 0) return;
    setRunning(true);
    setFinished(false);
    setRows((prev) => prev.map((r) => (targets.some((t) => t.id === r.id) ? { ...r, state: "waiting", reason: undefined } : r)));
    const newReceipts: string[] = [];
    for (const target of targets) {
      setRows((prev) => prev.map((r) => (r.id === target.id ? { ...r, state: "running" } : r)));
      try {
        const res = await pes.command("decision.record", { slug, proposal_id: target.id, verdict: "accept" }, { idempotencyKey: newKey() });
        newReceipts.push(res.receipt.receipt_no);
        setRows((prev) => prev.map((r) => (r.id === target.id ? { ...r, state: "accepted" } : r)));
      } catch (err) {
        const judged = err instanceof PesApiError && err.code === "already_judged";
        setRows((prev) => prev.map((r) => (r.id === target.id ? { ...r, state: judged ? "already" : "failed", reason: judged ? undefined : failureReason(err) } : r)));
      }
    }
    if (newReceipts.length) setReceipts((prev) => [...prev, ...newReceipts]);
    setRunning(false);
    setFinished(true);
  };

  const retry = () => send(failedRows);

  return (
    <Dialog open={open} onOpenChange={(next) => (canClose ? onOpenChange(next) : undefined)}>
      <DialogContent showCloseButton={false} aria-busy={running || undefined}>
        <DialogHeader>
          <DialogTitle>판단 전 가정 {total}개 받아들이기</DialogTitle>
          {!finished ? (
            <DialogDescription>{total}개를 확인으로 기록합니다 — 판단자: 나</DialogDescription>
          ) : (
            <DialogDescription>받아들인 가정은 기록되고, 실패한 가정은 판단 전 그대로입니다.</DialogDescription>
          )}
        </DialogHeader>

        {!finished ? (
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
        ) : (
          <div className="space-y-2">
            <p className="text-body font-medium text-ink">
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
            {receipts.length ? (
              <p className="text-caption text-muted-foreground">묶음 접수 번호 {receipts[0]}</p>
            ) : null}
          </div>
        )}

        <DialogFooter>
          {!finished ? (
            <>
              <Button
                aria-disabled={running || undefined}
                onClick={() => {
                  if (!running) void send(rows);
                }}
              >
                {running ? `${total}개 받아들이는 중…` : `${total}개 받아들이기`}
              </Button>
              <Button
                variant="ghost"
                aria-disabled={running || undefined}
                onClick={() => {
                  if (!running) onOpenChange(false);
                }}
              >
                취소
              </Button>
            </>
          ) : (
            <>
              {failedRows.length ? (
                <Button variant="outline" onClick={() => void retry()} disabled={running}>
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
