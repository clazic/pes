import * as React from "react";
import { useCommand } from "@/api/queries";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Callout } from "@/components/pes/blocks";
import { ActionButton } from "@/components/pes/controls";
import { Chip } from "@/components/pes/status";
import { cn } from "@/lib/utils";

/**
 * 확인 안 된 호출 정리(설계 4.12-6) — 사용량 화면과 연구 공간의 막힌 것 “AI 실행 멈춤”이 같은 대화 상자를 쓴다(5차).
 * 근거·이유 필수, 확인 불가는 예약·차단을 그대로 둔다(Codex F03). 정리는 API 연결 관리자(F04).
 */
export function SettleDialog({ id, open, onOpenChange, hint, onDone }: { id: string; open: boolean; onOpenChange: (o: boolean) => void; hint: string; onDone?: () => void }) {
  const [outcome, setOutcome] = React.useState<"processed" | "not_processed" | "unverifiable" | "">("");
  const [evidence, setEvidence] = React.useState("");
  const [reason, setReason] = React.useState("");
  const settle = useCommand("dispatch.settle");
  const opts = [
    { v: "processed", t: "처리됨으로 정리", h: "API 회사 화면에서 그 시각 요청·사용을 확인함 → 예약을 사용으로 확정" },
    { v: "not_processed", t: "처리 안 됨으로 정리", h: "API 회사 화면의 기록에서 그 요청이 없음을 확인함 → 예약 해제" },
    { v: "unverifiable", t: "확인 불가 — 그대로 둠", h: "확인할 수 없음 → 예약·차단을 그대로 둠(기록만 남김)" },
  ] as const;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>확인 안 된 호출 정리</DialogTitle>
          <DialogDescription>{hint} PES는 같은 호출을 자동으로 다시 하지 않습니다. 정리한 사람·시각·근거·이유·예약 처리는 지울 수 없는 기록으로 남고 같은 tx에서 바뀝니다.</DialogDescription>
        </DialogHeader>
        <RadioGroup value={outcome} onValueChange={(v) => setOutcome(v as typeof outcome)} className="gap-1.5" aria-label="정리 결과">
          {opts.map((o) => (
            <label key={o.v} htmlFor={`st-${o.v}`} className={cn("flex cursor-pointer items-start gap-2 rounded-lg border px-2.5 py-2", outcome === o.v ? "border-primary bg-primary-soft" : "border-line")}>
              <RadioGroupItem id={`st-${o.v}`} value={o.v} className="mt-1" />
              <span>
                <strong className="text-meta">{o.t}</strong>
                <span className="block text-caption text-muted-foreground">{o.h}</span>
              </span>
            </label>
          ))}
        </RadioGroup>
        <div>
          <Label htmlFor="st-ev" className="text-meta font-semibold">
            근거 <span className="font-medium text-bad">필수</span>
          </Label>
          <Input id="st-ev" className="mt-1" placeholder="예: API 회사 화면의 사용 내역 15:51 요청 없음(상관키 일치 없음)" value={evidence} onChange={(e) => setEvidence(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="st-why" className="text-meta font-semibold">
            이유 <span className="font-medium text-bad">필수</span>
          </Label>
          <Input id="st-why" className="mt-1" value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        {settle.phase === "done" ? <Callout tone="ok" role="status"><Chip shape="circle" tone="ok">정리됨</Chip> 접수 번호 {settle.receipt?.receipt_no}</Callout> : null}
        {settle.error ? <Callout tone="bad" role="alert">{settle.error.message}</Callout> : null}
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>{settle.phase === "done" ? "닫기" : "취소"}</Button>
          {settle.phase !== "done" ? (
            <ActionButton variant="default" blockedBy={!outcome ? "정리 결과를 골라 주세요." : !evidence.trim() || !reason.trim() ? "근거와 이유를 적어 주세요." : settle.pending ? "접수 확인 중입니다" : null} onClick={() => outcome && settle.run({ id, outcome, evidence, reason }, { onSuccess: () => onDone?.() })}>
              이대로 정리
            </ActionButton>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
