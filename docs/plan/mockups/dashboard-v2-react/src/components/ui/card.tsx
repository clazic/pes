import * as React from "react"
import { cn } from "@/lib/utils"

type CardSize = "default" | "sm" | "compact" | "flush"
type CardTone = "default" | "primary" | "ok" | "warn" | "bad"
type CardVariant = "default" | "metric"

type CardProps = React.ComponentProps<"div"> & {
  /** compact = 지금 화면의 gap-0 px-5 · flush = 안쪽 여백을 내용이 직접 잡는 카드(요약 카드) */
  size?: CardSize
  tone?: CardTone
  variant?: CardVariant
}

/** 색 변형 — 화면마다 Card 클래스를 덮어쓰지 않고 뜻으로 고른다. */
const CARD_TONE: Record<CardTone, string> = {
  default: "",
  primary: "border-primary-line bg-primary-soft",
  ok: "border-ok-line bg-ok-soft",
  warn: "border-warn-line bg-warn-soft",
  bad: "border-bad-line bg-bad-soft",
}

/** 표면 변형 — 요약 카드의 옅은 위쪽 그라데이션. */
const CARD_VARIANT: Record<CardVariant, string> = {
  default: "",
  metric: "bg-linear-to-t from-primary/5 to-card dark:bg-card dark:bg-none",
}

function Card({ className, size = "default", tone = "default", variant = "default", ...props }: CardProps) {
  return (
    <div
      data-slot="card"
      data-size={size}
      data-tone={tone}
      data-variant={variant}
      className={cn(
        "group/card flex min-w-0 flex-col gap-(--card-spacing) rounded-xl border bg-card py-(--card-spacing) text-sm text-card-foreground shadow-xs [--card-spacing:--spacing(4)] has-[>img:first-child]:pt-0 data-[size=sm]:[--card-spacing:--spacing(3)] data-[size=compact]:gap-0 data-[size=compact]:px-5 data-[size=flush]:gap-0 data-[size=flush]:py-0 data-[size=flush]:@container/card *:[img:first-child]:rounded-t-xl *:[img:last-child]:rounded-b-xl",
        CARD_TONE[tone],
        CARD_VARIANT[variant],
        className
      )}
      {...props}
    />
  )
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "group/card-header @container/card-header grid auto-rows-min items-start gap-1 rounded-t-xl px-(--card-spacing) has-data-[slot=card-action]:grid-cols-[1fr_auto] has-data-[slot=card-description]:grid-rows-[auto_auto] [.border-b]:pb-(--card-spacing)",
        className
      )}
      {...props}
    />
  )
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      className={cn(
        "font-heading text-base leading-snug font-semibold group-data-[size=sm]/card:text-sm",
        className
      )}
      {...props}
    />
  )
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn(
        "col-start-2 row-span-2 row-start-1 self-start justify-self-end",
        className
      )}
      {...props}
    />
  )
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-content"
      className={cn("flex flex-col gap-3 px-(--card-spacing)", className)}
      {...props}
    />
  )
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn(
        "flex items-center rounded-b-xl px-(--card-spacing) [.border-t]:pt-(--card-spacing)",
        className
      )}
      {...props}
    />
  )
}

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardAction,
  CardDescription,
  CardContent,
}
