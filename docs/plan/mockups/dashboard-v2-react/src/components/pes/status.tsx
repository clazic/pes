import type { StatusDomain, StatusRef } from "@/api/types";
import { cn } from "@/lib/utils";
import { lookup, type Shape, type Tone } from "./status-registry";

/**
 * 상태 모양 9가지(설계 3.4). SVG를 currentColor로 그려 강제 색(고대비) 모드·흑백 인쇄에서도 남는다.
 * 뜻은 옆 글자가 전달하므로 모양은 aria-hidden.
 */
export function StatusMark({ shape, className }: { shape: Shape; className?: string }) {
  return (
    <svg
      viewBox="0 0 10 10"
      width="10"
      height="10"
      aria-hidden="true"
      focusable="false"
      className={cn("inline-block shrink-0 forced-color-adjust-auto", className)}
      fill="currentColor"
    >
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

const TONE_CHIP: Record<Tone, string> = {
  ok: "border-ok-line bg-ok-soft text-ok",
  run: "border-primary-line bg-primary-soft text-primary-ink",
  you: "border-primary bg-primary text-primary-foreground",
  warn: "border-warn-line bg-warn-soft text-warn",
  bad: "border-bad-line bg-bad-soft text-bad",
  off: "border-off-line bg-off-soft text-off",
  unk: "border-dashed border-control bg-surface text-ink-2",
};

export const TONE_TEXT: Record<Tone, string> = {
  ok: "text-ok",
  run: "text-primary-ink",
  you: "text-primary-ink",
  warn: "text-warn",
  bad: "text-bad",
  off: "text-off",
  unk: "text-ink-2",
};

export interface ChipProps {
  shape: Shape;
  tone: Tone;
  children: React.ReactNode;
  className?: string;
  /** 칸 안에서 늘어나지 않게 기본은 inline-flex + nowrap */
  wrap?: boolean;
  title?: string;
}

/** 상태 칩: 모양 + 글자 + 색. 글자는 언제나 있다(설계 3.4). */
export function Chip({ shape, tone, children, className, wrap, title }: ChipProps) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-full border py-px pr-2.5 pl-2 align-middle text-xs leading-[1.6] font-medium",
        wrap ? "whitespace-normal" : "whitespace-nowrap",
        TONE_CHIP[tone],
        className,
      )}
    >
      <StatusMark shape={shape} />
      <span className="min-w-0">{children}</span>
    </span>
  );
}

/** 상태 사전에서 찾아 그리는 칩. 같은 상태는 어디서나 같은 모양·글자·색. */
export function Status({
  of,
  value,
  label,
  className,
  wrap,
  short,
}: {
  of: StatusDomain;
  value: string;
  label?: string;
  className?: string;
  wrap?: boolean;
  /** 열 이름이 앞말을 이미 말할 때 사전의 짧은 글자(예: “AI가 읽기” 열의 “허용”·“막음”) */
  short?: boolean;
}) {
  const def = lookup(of, value);
  return (
    <Chip shape={def.shape} tone={def.tone} className={className} wrap={wrap}>
      {label ?? (short && def.short ? def.short : def.label)}
    </Chip>
  );
}

export function StatusFrom({ s, className, wrap, short }: { s: StatusRef; className?: string; wrap?: boolean; short?: boolean }) {
  return <Status of={s.domain} value={s.value} label={s.label} className={className} wrap={wrap} short={short} />;
}

/** 칩 없이 모양 + 글자만(목록 안 작은 표시) */
export function StatusText({ of, value, label, className }: { of: StatusDomain; value: string; label?: string; className?: string }) {
  const def = lookup(of, value);
  return (
    <span className={cn("inline-flex items-center gap-1.5 font-medium", TONE_TEXT[def.tone], className)}>
      <StatusMark shape={def.shape} />
      {label ?? def.label}
    </span>
  );
}
