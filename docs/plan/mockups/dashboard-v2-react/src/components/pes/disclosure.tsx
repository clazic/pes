import * as React from "react";
import { ChevronDownIcon, InfoIcon } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/*
 * 정보 밀도 원칙(설계 14절, 3차 정리 2026-11-05): 첫 화면에는 제목 · 지금 할 일 · 본문만 두고,
 * 세부(근거 · 시각 · 도구 이름 · 규칙 설명 · 권한 안내)는 지우지 않고 “한 단계 뒤”로 보낸다.
 *  - More(자세히): 그 자리에서 펼침(Collapsible). 단추 = Enter·Space, aria-expanded · aria-controls는 radix가 붙인다.
 *  - InfoTip(ⓘ): 짧은 설명을 띄움(Popover). 누르거나 Enter로 열고 Esc로 닫으면 연 단추로 초점이 돌아간다.
 *    터치에서도 열리도록 HoverCard·Tooltip 대신 Popover를 쓴다(내용 안의 링크·글자를 고를 수 있음).
 */

/** “자세히” 묶음 — 단추와 내용을 따로 놓을 때 쓰는 뿌리(같은 줄 끝에 단추, 아래 줄 전체에 내용) */
export function MoreRoot({ className, ...props }: React.ComponentProps<typeof Collapsible>) {
  return <Collapsible data-more="" className={cn("group/more", className)} {...props} />;
}

/** name = 화면 읽기 이름(“지금 할 일 자세히”처럼 무엇의 자세히인지 — 보이는 글자를 포함해 쓴다, 2.5.3) */
export function MoreTrigger({ label = "자세히", className, openLabel, name }: { label?: React.ReactNode; openLabel?: React.ReactNode; className?: string; name?: string }) {
  return (
    <CollapsibleTrigger
      aria-label={name}
      className={cn(
        "inline-flex min-h-7 shrink-0 items-center gap-1 rounded-md px-1 text-caption font-medium text-muted-foreground hover:text-foreground coarse:min-h-[44px]",
        className,
      )}
    >
      <ChevronDownIcon className="size-3.5 transition-transform group-data-[state=open]/more:rotate-180" aria-hidden="true" />
      {openLabel ? (
        <>
          <span className="group-data-[state=open]/more:hidden">{label}</span>
          <span className="hidden group-data-[state=open]/more:inline">{openLabel}</span>
        </>
      ) : (
        label
      )}
    </CollapsibleTrigger>
  );
}

export function MoreContent({ className, children }: { className?: string; children: React.ReactNode }) {
  return <CollapsibleContent className={cn("text-caption leading-relaxed text-ink-2", className)}>{children}</CollapsibleContent>;
}

/** 자세히 — 단추 바로 아래에 펼친다 */
export function More({ label = "자세히", openLabel, children, className, contentClassName, defaultOpen, name }: { label?: React.ReactNode; openLabel?: React.ReactNode; children: React.ReactNode; className?: string; contentClassName?: string; defaultOpen?: boolean; name?: string }) {
  return (
    <MoreRoot defaultOpen={defaultOpen} className={className}>
      <MoreTrigger label={label} openLabel={openLabel} name={name} className="-ml-1" />
      <MoreContent className={cn("mt-1", contentClassName)}>{children}</MoreContent>
    </MoreRoot>
  );
}

/** 자세히 안의 짧은 줄 목록(이름 · 값) */
export function MoreList({ items, className }: { items: [React.ReactNode, React.ReactNode][]; className?: string }) {
  return (
    <dl className={cn("grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1", className)}>
      {items.map(([k, v], i) => (
        <React.Fragment key={i}>
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="m-0 min-w-0 text-ink-2">{v}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

/** ⓘ 설명 — 이름(label)은 화면 읽기와 툴팁 없이도 무엇을 여는지 알게 쓴다(예: “계속 설명”) */
export function InfoTip({ label, children, className, side = "bottom", align = "start", wide }: { label: string; children: React.ReactNode; className?: string; side?: "top" | "bottom" | "left" | "right"; align?: "start" | "center" | "end"; wide?: boolean }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className={cn(
            "inline-flex size-[24px] shrink-0 items-center justify-center rounded-full align-middle text-muted-foreground hover:bg-muted hover:text-foreground data-[state=open]:bg-muted data-[state=open]:text-foreground coarse:size-[32px]",
            className,
          )}
        >
          <InfoIcon className="size-[15px]" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent side={side} align={align} className={cn("gap-1.5 p-3 text-meta leading-relaxed", wide ? "w-[min(26rem,calc(100vw-2rem))]" : "w-[min(20rem,calc(100vw-2rem))]")}>
        {children}
      </PopoverContent>
    </Popover>
  );
}

/**
 * 접힌 묶음 카드 — 자주 보지 않는 묶음(흐름 설명 · 구성 · 견본)을 제목 한 줄로 접는다.
 * 제목(h2/h3) 안의 단추가 펼치고 접는다(아코디언 모양 — aria-expanded). 열어 둔 채 시작하려면 defaultOpen.
 */
export function FoldCard({ title, id, children, defaultOpen, className, as: As = "h2", meta }: { title: React.ReactNode; id?: string; children: React.ReactNode; defaultOpen?: boolean; className?: string; as?: "h2" | "h3"; meta?: React.ReactNode }) {
  return (
    <Collapsible id={id} defaultOpen={defaultOpen} className={cn("group/fold rounded-xl border bg-card text-card-foreground shadow-xs", className)}>
      <As className={As === "h2" ? "text-title" : "text-body"}>
        <CollapsibleTrigger className="flex w-full items-center justify-between gap-3 rounded-xl px-5 py-3.5 text-left font-semibold hover:bg-surface-soft">
          <span className="min-w-0">
            {title}
            {meta ? <span className="ml-2 text-caption font-normal text-muted-foreground">{meta}</span> : null}
          </span>
          <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/fold:rotate-180" aria-hidden="true" />
        </CollapsibleTrigger>
      </As>
      <CollapsibleContent className="px-5 pb-4">{children}</CollapsibleContent>
    </Collapsible>
  );
}
