import type { TurnView } from "@/api/types";
import { cn } from "@/lib/utils";
import { lookup, type Shape, type StatusDomain, type Tone } from "./status-registry";

/**
 * 상태 모양 9가지(설계 3.4, 승인 시안 components/pes/status.tsx 그대로). currentColor 로 그려 강제 색·흑백 인쇄에서도 남는다.
 * 뜻은 옆 글자가 전하므로 모양은 aria-hidden.
 */
export function StatusMark({ shape, className }: { shape: Shape; className?: string }) {
  return (
    <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true" focusable="false" className={cn("inline-block shrink-0 forced-color-adjust-auto", className)} fill="currentColor">
      {shape === "circle" && <circle cx="5" cy="5" r="4.5" />}
      {shape === "ring" && <circle cx="5" cy="5" r="3.6" fill="none" stroke="currentColor" strokeWidth="1.9" />}
      {shape === "diamond" && <rect x="1.9" y="1.9" width="6.2" height="6.2" transform="rotate(45 5 5)" />}
      {shape === "tri" && <polygon points="5,0.6 9.7,9.4 0.3,9.4" />}
      {shape === "square" && <rect x="0.6" y="0.6" width="8.8" height="8.8" rx="1" />}
      {shape === "hsquare" && <rect x="1.3" y="1.3" width="7.4" height="7.4" rx="0.8" fill="none" stroke="currentColor" strokeWidth="1.9" />}
      {shape === "dotring" && <circle cx="5" cy="5" r="3.8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeDasharray="1.5 1.4" />}
      {shape === "pause" && (
        <>
          <rect x="1.4" y="0.6" width="2.6" height="8.8" />
          <rect x="6" y="0.6" width="2.6" height="8.8" />
        </>
      )}
      {shape === "dash" && <rect x="0.2" y="4" width="9.6" height="2" />}
    </svg>
  );
}

export const TONE_TEXT: Record<Tone, string> = {
  ok: "text-ok",
  run: "text-primary-ink",
  you: "text-primary-ink",
  warn: "text-warn",
  bad: "text-bad",
  off: "text-off",
  unk: "text-ink-2",
};

const TONE_CHIP: Record<Tone, string> = {
  ok: "border-ok-line bg-ok-soft text-ok",
  run: "border-primary-line bg-primary-soft text-primary-ink",
  you: "border-primary bg-primary text-primary-foreground",
  warn: "border-warn-line bg-warn-soft text-warn",
  bad: "border-bad-line bg-bad-soft text-bad",
  off: "border-off-line bg-off-soft text-off",
  unk: "border-dashed border-control bg-surface text-ink-2",
};

/** 상태 칩: 모양 + 글자 + 색. 글자는 언제나 있다(설계 3.4) */
export function Status({ of, value, label, className }: { of: StatusDomain; value: string; label?: string; className?: string }) {
  const def = lookup(of, value);
  return (
    <span className={cn("inline-flex max-w-full items-center gap-1.5 rounded-full border py-px pr-2.5 pl-2 align-middle text-caption leading-[1.6] font-medium whitespace-nowrap", TONE_CHIP[def.tone], className)}>
      <StatusMark shape={def.shape} />
      <span className="min-w-0">{label ?? def.label}</span>
    </span>
  );
}

/** 칩 없이 모양 + 글자만(목록 안 작은 표시) */
export function StatusText({ of, value, className }: { of: StatusDomain; value: string; className?: string }) {
  const def = lookup(of, value);
  return (
    <span className={cn("inline-flex items-center gap-1.5 font-medium", TONE_TEXT[def.tone], className)}>
      <StatusMark shape={def.shape} />
      {def.label}
    </span>
  );
}

/** 차례 키 — ai 는 소식이 시험값 안일 때만 움직임 */
export const turnKey = (t: TurnView) => (t.side === "ai" ? (t.fresh ? "ai" : "ai_quiet") : t.side);

/** 차례 말 = 사전 이름(+ 나의 할 일이면 수). 예: “나의 할 일 1건” */
export function turnLabel(t: TurnView): string {
  const k = turnKey(t);
  const def = lookup("turn", k);
  return k === "you" && t.count ? `${def.label} ${t.count}건` : def.label;
}
