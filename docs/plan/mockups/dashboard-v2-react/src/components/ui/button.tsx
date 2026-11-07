import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { Slot } from "radix-ui"

// PES 시안: shadcn 기본 단추를 PES 토큰으로 바꿨다.
// - 못 누르는 단추는 disabled 대신 aria-disabled(초점을 받아 이유를 읽음, 설계 3.9) → 아래 aria-disabled 스타일
// - 초점: 2px 실선 + 2px 간격
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium leading-tight whitespace-nowrap no-underline transition-colors outline-none select-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 aria-disabled:border-line aria-disabled:bg-surface-sunk aria-disabled:text-muted-foreground aria-disabled:shadow-none aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "border-primary bg-primary text-primary-foreground shadow-xs hover:border-primary/90 hover:bg-primary/90 hover:text-primary-foreground aria-disabled:hover:bg-surface-sunk",
        outline:
          "border-border bg-background text-foreground shadow-xs hover:bg-accent hover:text-accent-foreground aria-expanded:bg-accent aria-expanded:text-accent-foreground aria-disabled:hover:bg-surface-sunk aria-disabled:hover:text-muted-foreground",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost:
          "text-foreground hover:bg-accent hover:text-accent-foreground aria-expanded:bg-accent aria-expanded:text-accent-foreground",
        destructive:
          "border-bad bg-surface text-bad hover:bg-bad-soft hover:text-bad",
        link: "h-auto border-0 px-0.5 py-0.5 text-[13px] text-primary-ink underline underline-offset-3 hover:decoration-2 aria-disabled:bg-transparent aria-disabled:text-muted-foreground",
      },
      size: {
        default: "min-h-9 gap-1.5 px-3.5 py-1.5",
        xs: "min-h-6 gap-1 px-2 text-xs [&_svg:not([class*='size-'])]:size-3",
        sm: "min-h-8 gap-1 px-2.5 py-1 text-[13px]",
        lg: "min-h-12 gap-2 px-4 text-[15px]",
        icon: "size-9",
        "icon-xs": "size-6 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    compoundVariants: [{ variant: "link", className: "min-h-0" }],
    defaultVariants: {
      variant: "outline",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "outline",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...(asChild ? {} : { type: props.type ?? "button" })}
      {...props}
    />
  )
}

export { Button, buttonVariants }
