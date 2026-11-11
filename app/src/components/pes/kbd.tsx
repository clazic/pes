import * as React from "react";
import { cn } from "@/lib/utils";

/** 키 표시(승인 시안 bits.tsx 의 Kbd 와 같은 모양) — 화면 장식이므로 읽기 이름에는 aria-keyshortcuts 를 쓴다 */
export function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-sm border bg-muted px-1 font-sans text-caption leading-none font-medium text-muted-foreground",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
