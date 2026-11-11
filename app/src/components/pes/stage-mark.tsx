import type { StageState } from "@/api/types";
import { cn } from "@/lib/utils";

/**
 * 단계 모양(설계 3.4 · 18.5) — 색만으로 구분하지 않는다: 모양 + 옆 글자(승인 · 현재 · 아직)가 같은 뜻을 전한다.
 * 승인 = 채운 원 + 체크 · 현재 = 반쯤 채운 원 · 아직 = 점선 빈 원. 모양은 장식(aria-hidden), 뜻은 글자가 맡는다.
 */
export function StageMark({ state, className }: { state: StageState; className?: string }) {
  const tone = state === "approved" ? "text-ok" : state === "current" ? "text-primary-ink" : "text-off";
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={cn("size-4 shrink-0", tone, className)}>
      {state === "approved" ? (
        <>
          <circle cx="8" cy="8" r="7" fill="currentColor" />
          <path d="M4.8 8.2l2.1 2.1 4.3-4.6" fill="none" stroke="var(--card)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </>
      ) : state === "current" ? (
        <>
          <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M8 1.75a6.25 6.25 0 0 1 0 12.5z" fill="currentColor" />
        </>
      ) : (
        <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2.2 2" />
      )}
    </svg>
  );
}

/** 라운드 점 — 현재 진행은 채운 점, 지난 라운드는 빈 점 */
export function RoundDot({ current }: { current: boolean }) {
  return (
    <svg viewBox="0 0 8 8" aria-hidden="true" className={cn("size-2 shrink-0", current ? "text-primary-ink" : "text-off")}>
      {current ? <circle cx="4" cy="4" r="3.5" fill="currentColor" /> : <circle cx="4" cy="4" r="3" fill="none" stroke="currentColor" strokeWidth="1.2" />}
    </svg>
  );
}
