import { cn } from "@/lib/utils";

/** 라운드 점 — 현재 진행은 채운 점, 지난 라운드는 빈 점 */
export function RoundDot({ current }: { current: boolean }) {
  return (
    <svg viewBox="0 0 8 8" aria-hidden="true" className={cn("size-2 shrink-0", current ? "text-primary-ink" : "text-off")}>
      {current ? <circle cx="4" cy="4" r="3.5" fill="currentColor" /> : <circle cx="4" cy="4" r="3" fill="none" stroke="currentColor" strokeWidth="1.2" />}
    </svg>
  );
}
