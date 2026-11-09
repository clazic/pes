import * as React from "react";
import { Link } from "react-router";
import { ArrowRightIcon, CheckIcon, FingerprintIcon, MailIcon, MonitorIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { CommandPhase } from "@/api/queries";
import type { StepUp } from "@/api/mock-client";
import type { Receipt } from "@/api/types";
import { Chip } from "./status";
import { Callout } from "./blocks";

export interface ConfirmSpec {
  eyebrow?: string;
  title: string;
  changes: React.ReactNode[];
  unchanged: React.ReactNode[];
  /** 대상 고정본(스냅숏·rev) — 재인증이 이 요청 한 건에 묶인다 */
  target: string;
  verb: string;
  reasonLabel?: string;
  reasonRequired?: boolean;
  reasonDefault?: string;
  /** 정책 변경 등: 요청 한 건마다 재인증(stage-5 2.2 — 끄기도 생략하지 않음, Codex F01) */
  stepUp: boolean;
  /** 끄기처럼 엄격해지는 동작이면 true → 휴대폰에서도 하고 단계가 짧다. 느슨해지는 동작은 데스크톱 + 이유 필수 */
  tightening?: boolean;
  danger?: boolean;
  footnote?: React.ReactNode;
  /** 끝난 뒤 보일 말 — 무엇이 끝났고 무엇이 열렸는지 + 그리로 가는 단추(접수 번호는 작은 글자로) */
  done?: { title: string; body?: string; action?: { label: string; to: string } };
}

/**
 * 확인 대화 상자(설계 3.7): 무엇을 → 바뀌는 것 → 바뀌지 않는 것 → 대상 고정본 → 이유 → [취소] [동사 단추].
 * 단추에 “확인”·“예”를 쓰지 않는다. 실행 중에는 단추를 잠그고 “접수 확인 중”.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  spec,
  phase,
  receipt,
  errorText,
  onConfirm,
  onRecheck,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  spec: ConfirmSpec;
  phase: CommandPhase;
  receipt: Receipt | null;
  errorText?: string | null;
  onConfirm: (reason: string, stepUp: StepUp | undefined) => void;
  onRecheck?: () => void;
}) {
  const [reason, setReason] = React.useState(spec.reasonDefault ?? "");
  const [stage, setStage] = React.useState<"form" | "stepup">("form");
  const reasonRef = React.useRef<HTMLInputElement>(null);
  const id = React.useId();

  React.useEffect(() => {
    if (open) {
      setStage("form");
      setReason(spec.reasonDefault ?? "");
    }
  }, [open, spec.reasonDefault]);

  const busy = phase === "sending" || phase === "confirming";
  const reasonMissing = Boolean(spec.reasonRequired && !reason.trim());

  const submit = () => {
    if (reasonMissing) {
      reasonRef.current?.focus();
      return;
    }
    if (spec.stepUp && stage === "form") {
      setStage("stepup");
      return;
    }
    onConfirm(reason, undefined);
  };

  const confirmWith = (method: StepUp["method"]) => onConfirm(reason, { method, bound: spec.target });

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent
        onOpenAutoFocus={(e) => {
          // 열면 첫 입력에 초점(설계 3.7)
          if (reasonRef.current) {
            e.preventDefault();
            reasonRef.current.focus();
          }
        }}
      >
        <DialogHeader>
          {spec.eyebrow ? <p className="text-xs font-semibold text-muted-foreground">{spec.eyebrow}</p> : null}
          <DialogTitle>{spec.title}</DialogTitle>
          <DialogDescription>대상: {spec.target}</DialogDescription>
        </DialogHeader>

        {phase === "done" && receipt && spec.done ? (
          <div role="status" className="rounded-xl border border-ok-line bg-ok-soft px-3.5 py-3">
            <p className="flex items-center gap-2 text-title font-semibold">
              <span aria-hidden="true" className="grid size-6 place-items-center rounded-full border border-ok-line bg-card text-ok">
                <CheckIcon className="size-3.5" />
              </span>
              {spec.done.title}
            </p>
            {spec.done.body ? <p className="mt-1.5 text-body text-ink">{spec.done.body}</p> : null}
            <p className="mt-1.5 text-caption text-muted-foreground">
              접수 번호 {receipt.receipt_no} · {receipt.committed_at}
              {receipt.replayed ? " · 같은 요청이라 다시 처리하지 않음" : ""}
            </p>
          </div>
        ) : phase === "done" && receipt ? (
          <Callout tone="ok" role="status">
            <Chip shape="circle" tone="ok">
              접수됨 · {receipt.committed_at}
            </Chip>{" "}
            접수 번호 {receipt.receipt_no}
            {receipt.replayed ? " — 같은 요청이라 다시 처리하지 않고 처음 결과를 돌려받았습니다." : "."}
          </Callout>
        ) : stage === "form" ? (
          <>
            <div>
              <p className="text-meta font-semibold">바뀌는 것</p>
              <ul className="mt-1 ml-4.5 list-disc space-y-1 text-body">
                {spec.changes.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </div>
            <div>
              <p className="text-meta font-semibold">바뀌지 않는 것</p>
              <ul className="mt-1 ml-4.5 list-disc space-y-1 text-body">
                {spec.unchanged.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </div>
            <div>
              <Label htmlFor={`${id}-why`} className="text-meta font-semibold">
                {spec.reasonLabel ?? "이유"} <span className="font-normal text-muted-foreground">({spec.reasonRequired ? "필수" : "선택"} — 이력에 남음)</span>
              </Label>
              <Input
                ref={reasonRef}
                id={`${id}-why`}
                className="mt-1"
                value={reason}
                aria-invalid={reasonMissing || undefined}
                aria-describedby={reasonMissing ? `${id}-why-err` : undefined}
                onChange={(e) => setReason(e.target.value)}
              />
              {reasonMissing ? (
                <p id={`${id}-why-err`} className="mt-1 text-xs font-medium text-bad">
                  다시 켜는 동작은 이유를 적어야 합니다.
                </p>
              ) : null}
            </div>
            {spec.footnote ? <div className="text-caption text-muted-foreground">{spec.footnote}</div> : null}
          </>
        ) : (
          <div role="group" aria-labelledby={`${id}-su`} className="rounded-xl border border-line-strong bg-surface-soft p-3.5">
            <h3 id={`${id}-su`} className="text-meta">
              본인 확인이 필요합니다
            </h3>
            <p className="mt-1.5 text-body">
              이 확인은 <strong>이 요청 한 건</strong>에만 쓰입니다: {spec.target} · {spec.verb}. 내용이 그사이 바뀌면 적용하지 않습니다.
            </p>
            <div className="mt-3 flex flex-col gap-2">
              <Button variant="default" disabled={busy} onClick={() => confirmWith("passkey")}>
                <FingerprintIcon aria-hidden="true" />
                패스키로 확인
              </Button>
              <Button disabled={busy} onClick={() => confirmWith("email")}>
                <MailIcon aria-hidden="true" />
                메일 링크로 확인
              </Button>
              <Button disabled={busy} onClick={() => confirmWith("local_owner")}>
                <MonitorIcon aria-hidden="true" />
                이 컴퓨터에서 소유자로 확인
              </Button>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">5분 안에 끝내지 못하면 다시 묻습니다. 적은 이유는 지워지지 않습니다.</p>
          </div>
        )}

        {phase === "confirming" ? (
          <p role="status" className="text-meta">
            <Chip shape="ring" tone="run">
              접수 확인 중
            </Chip>{" "}
            응답이 늦어 같은 요청 번호로 확인하고 있습니다. 다시 눌러도 두 번 처리하지 않습니다.
          </p>
        ) : null}
        {phase === "unknown" ? (
          <Callout tone="warn" role="status">
            <Chip shape="dotring" tone="unk">
              결과 미확인
            </Chip>{" "}
            {errorText} {onRecheck ? <Button size="sm" className="mt-2" onClick={onRecheck}>같은 요청 번호로 확인</Button> : null}
          </Callout>
        ) : null}
        {phase === "error" && errorText ? (
          <Callout tone="bad" role="alert">
            <Chip shape="square" tone="bad">
              보내지 못함
            </Chip>{" "}
            {errorText}
          </Callout>
        ) : null}

        <DialogFooter>
          {phase === "done" ? (
            <>
              <Button variant={spec.done?.action ? "outline" : "default"} onClick={() => onOpenChange(false)}>
                닫기
              </Button>
              {spec.done?.action ? (
                <Button asChild variant="default">
                  <Link to={spec.done.action.to} onClick={() => onOpenChange(false)}>
                    {spec.done.action.label}
                    <ArrowRightIcon aria-hidden="true" />
                  </Link>
                </Button>
              ) : null}
            </>
          ) : (
            <>
              <Button disabled={busy} onClick={() => onOpenChange(false)}>
                취소
              </Button>
              {stage === "form" ? (
                <Button variant={spec.danger ? "destructive" : "default"} aria-disabled={busy || undefined} onClick={() => !busy && submit()}>
                  {spec.stepUp ? `${spec.verb} — 본인 확인으로` : spec.verb}
                </Button>
              ) : (
                <Button disabled={busy} onClick={() => setStage("form")}>
                  이전 단계로
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
