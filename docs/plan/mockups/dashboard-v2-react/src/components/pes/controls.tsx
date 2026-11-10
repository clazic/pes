import * as React from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

type ButtonProps = React.ComponentProps<typeof Button>;

/**
 * 못 누르는 단추: disabled 대신 aria-disabled + aria-describedby(초점을 받아 이유를 읽음).
 * 단추를 숨기지 않고 이유 한 줄을 둔다(설계 P8 · 14.4). 서버가 매번 다시 검사한다(7절).
 * 이유 문장이 화면에 따로 없으면(reasonId 없음): 고르는 곳(해결 흐름처럼 showReason)은 단추 옆에 늘 보이고,
 * 그 밖에는 화면 읽기에만 두었다가 **누르면 그 자리에 보인다**(6차 — 회색 단추를 눌러도 아무 일 없던 것을 고침).
 */
export function ActionButton({
  blockedBy,
  reasonId,
  showReason,
  onClick,
  ...props
}: ButtonProps & {
  /** 못 누르는 이유(있으면 막힘) */
  blockedBy?: string | null;
  /** 이유 문장이 이미 화면에 있으면 그 요소 id */
  reasonId?: string;
  /** 이유를 누르기 전부터 단추 옆에 보인다 */
  showReason?: boolean;
}) {
  const autoId = React.useId();
  const blocked = Boolean(blockedBy);
  const describedId = blocked ? (reasonId ?? `${autoId}-why`) : undefined;
  const [tried, setTried] = React.useState(false);
  // 막힘이 풀리면 이유를 다시 숨긴 채로 시작한다 — effect가 아니라 그리기 중 이전 값과 비교해 맞춘다
  const [wasBlocked, setWasBlocked] = React.useState(blocked);
  if (wasBlocked !== blocked) {
    setWasBlocked(blocked);
    if (!blocked) setTried(false);
  }
  const visible = showReason || tried;
  return (
    <>
      <Button
        {...props}
        aria-disabled={blocked || undefined}
        aria-describedby={cn(props["aria-describedby"], describedId) || undefined}
        onClick={(e) => {
          if (blocked) {
            e.preventDefault();
            setTried(true);
            return;
          }
          onClick?.(e);
        }}
      />
      {blocked && !reasonId ? (
        <span id={describedId} data-reason={visible ? "" : undefined} className={visible ? "text-caption leading-snug text-ink-2" : "sr-only"}>
          {blockedBy}
        </span>
      ) : null}
    </>
  );
}

/**
 * 글자를 함께 쓰는 스위치(role="switch" + 이름 + 상태 글자).
 * 끄기는 바로, 다시 켜기는 확인·재인증(설계 P9)이므로 바꾸기 전에 onRequest로 부모가 확인 대화 상자를 연다.
 */
export function StateSwitch({
  checked,
  onLabel,
  offLabel,
  name,
  onRequest,
  blockedBy,
  describedBy,
  pending,
  className,
}: {
  checked: boolean;
  onLabel: string;
  offLabel: string;
  /** 접근 가능한 이름(예: “AI 참조: 2024 지역별 돌봄 인력 현황”) */
  name: string;
  onRequest?: (next: boolean) => void;
  blockedBy?: string | null;
  describedBy?: string;
  pending?: boolean;
  className?: string;
}) {
  const id = React.useId();
  const whyId = `${id}-why`;
  const blocked = Boolean(blockedBy);
  // 막힌 스위치를 누르면 이유를 그 자리에 보인다(ActionButton과 같음 — 6차)
  const [tried, setTried] = React.useState(false);
  const [wasBlocked, setWasBlocked] = React.useState(blocked);
  if (wasBlocked !== blocked) {
    setWasBlocked(blocked);
    if (!blocked) setTried(false);
  }
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-x-2 gap-y-1", className)}>
      <Switch
        id={id}
        checked={checked}
        aria-label={name}
        aria-disabled={blocked || undefined}
        aria-describedby={cn(describedBy, blocked && whyId) || undefined}
        aria-busy={pending || undefined}
        className={cn(blocked && "border-dashed")}
        onCheckedChange={(next) => {
          if (blocked) setTried(true);
          if (blocked || pending) return;
          onRequest?.(next);
        }}
      />
      <Label htmlFor={id} className={cn("min-w-[2.5em] text-meta font-semibold", blocked ? "text-muted-foreground" : "text-ink")}>
        {pending ? "바꾸는 중" : checked ? onLabel : offLabel}
      </Label>
      {blocked ? (
        <span id={whyId} data-reason={tried ? "" : undefined} className={tried ? "text-caption leading-snug font-normal text-ink-2" : "sr-only"}>
          {blockedBy}
        </span>
      ) : null}
    </span>
  );
}

/** 사용량 계기(설계 4.12): 채움 색 + 문턱 선 + 이름표. 숫자를 담은 이름(role="img")과 표 보기를 함께 둔다. */
export function Meter({
  percent,
  threshold,
  label,
  className,
  compact,
}: {
  percent: number;
  threshold?: number;
  label: string;
  className?: string;
  compact?: boolean;
}) {
  const level = threshold == null ? "ok" : percent >= threshold ? "over" : percent >= threshold - 10 ? "warn" : "ok";
  const track = level === "over" ? "bg-meter-bad-track" : level === "warn" ? "bg-meter-warn-track" : "bg-meter-track";
  const fill = level === "over" ? "bg-meter-bad-fill" : level === "warn" ? "bg-meter-warn-fill" : "bg-meter-fill";
  return (
    <div role="img" aria-label={label} className={cn("relative rounded-full", compact ? "mt-1 h-2" : "mt-3.5 mb-[26px] h-3", track, className)}>
      <span className={cn("absolute inset-y-0 left-0 rounded-full", fill)} style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
      {threshold != null && !compact ? (
        <>
          {/* 빨간 채움 위에서 문턱 선 대비가 2.65:1이라 흰 테두리 2px로 떨어뜨린다(설계 11절) */}
          <span className="absolute -top-1.5 -bottom-1.5 -ml-px w-0.5 bg-ink shadow-[0_0_0_2px_var(--surface)]" style={{ left: `${threshold}%` }} />
          <span className="absolute top-full mt-2 -translate-x-1/2 text-caption font-medium whitespace-nowrap text-ink-2" style={{ left: `${threshold}%` }}>
            문턱 {threshold}%
          </span>
        </>
      ) : null}
    </div>
  );
}

export function meterLevel(percent: number, threshold: number): "ok" | "warn" | "over" {
  return percent >= threshold ? "over" : percent >= threshold - 10 ? "warn" : "ok";
}
