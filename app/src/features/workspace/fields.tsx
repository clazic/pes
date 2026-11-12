import * as React from "react";
import { cn } from "@/lib/utils";

/** 글 · 선택 칸 공통 모양 (AskPane 의 답 칸과 같은 토큰) */
export const controlClass =
  "block w-full rounded-md border border-control bg-background px-2.5 py-1.5 text-body text-ink shadow-xs outline-none coarse:min-h-[44px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/** 이름 있는 칸 하나 — label 은 항상 보인다(placeholder 로 대신하지 않음) */
export function Field({ id, label, className, children }: { id: string; label: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={cn("min-w-0", className)}>
      <label htmlFor={id} className="block text-meta font-medium text-ink">
        {label}
      </label>
      <div className="mt-1">{children}</div>
    </div>
  );
}
