import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * AI 참조 스위치 — role=switch 단추. 켜짐(허용)과 꺼짐(금지)은 색만으로 알리지 않는다: 곁의 글(“AI 참조 허용/금지”)이 함께 있다.
 * 굵은 포인터(손가락)에서는 누를 자리를 키운다.
 */
export function AiSwitch({ id, on, label, onClick }: { id?: string; on: boolean; label: string; onClick: (e: React.MouseEvent<HTMLButtonElement>) => void }) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onClick}
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border outline-none transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring coarse:h-8 coarse:w-14",
        on ? "border-primary bg-primary" : "border-line-strong bg-surface-sunk",
      )}
    >
      <span aria-hidden="true" className={cn("pointer-events-none block size-4 rounded-full shadow-xs transition-transform coarse:size-6", on ? "translate-x-6 bg-primary-foreground coarse:translate-x-7" : "translate-x-1 bg-ink-2")} />
    </button>
  );
}
