import * as React from "react";
import type { DraftSetOptions } from "@/lib/draft";
import { cn } from "@/lib/utils";

export const fieldClass =
  "mt-1 block w-full resize-y rounded-md border border-control bg-background px-2.5 py-2 text-body text-ink shadow-xs outline-none coarse:min-h-[44px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/**
 * 초안 칸 — 같은 DOM 노드를 유지한다(갱신이 와도 다시 만들지 않음 → 초점 · 선택 범위 · 값 그대로).
 * 한글 조합 중(compositionstart ~ end)에는 화면 값만 바꾸고 저장하지 않으며, 조합이 끝나면 확정된 값을 저장한다.
 */
export function DraftTextarea({ id, rows, draft, className }: { id: string; rows: number; draft: [string, (v: string, o?: DraftSetOptions) => void]; className?: string }) {
  const [value, setValue] = draft;
  const composing = React.useRef(false);
  return (
    <textarea
      id={id}
      rows={rows}
      className={cn(fieldClass, className)}
      value={value}
      onCompositionStart={() => {
        composing.current = true;
      }}
      onCompositionEnd={(e) => {
        composing.current = false;
        setValue(e.currentTarget.value);
      }}
      onChange={(e) => setValue(e.target.value, { store: !composing.current })}
    />
  );
}
