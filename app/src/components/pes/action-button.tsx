import * as React from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Props = React.ComponentProps<typeof Button> & {
  /** 못 누르는 이유. 있으면 aria-disabled + aria-describedby 로 이유를 읽히고, 누르거나 Enter·Space 를 눌러도 동작하지 않는다 */
  blockedReason?: string;
  reasonId: string;
  reasonClassName?: string;
};

/**
 * 못 누르는 단추도 숨기지 않는다(설계 3.9 · 12.6 R05) — disabled 대신 aria-disabled 로 초점을 받고, 바로 아래 이유 글을 보인다.
 */
export function ActionButton({ blockedReason, reasonId, reasonClassName, onClick, children, ...rest }: Props) {
  const blocked = !!blockedReason;
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Button
        {...rest}
        aria-disabled={blocked || undefined}
        aria-describedby={blocked ? reasonId : undefined}
        onClick={(e) => {
          if (blocked) {
            e.preventDefault();
            return;
          }
          onClick?.(e);
        }}
      >
        {children}
      </Button>
      {blocked ? (
        <span id={reasonId} className={cn("text-caption text-muted-foreground", reasonClassName)}>
          {blockedReason}
        </span>
      ) : null}
    </span>
  );
}
