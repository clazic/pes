import * as React from "react"
import { cn } from "@/lib/utils"

// PES 시안: 넓은 표만 가로로 스크롤하고, 그 영역은 키보드 초점을 받는다(설계 3.8). regionLabel을 주면 role="region".
function Table({
  className,
  regionLabel,
  containerClassName,
  ...props
}: React.ComponentProps<"table"> & { regionLabel?: string; containerClassName?: string }) {
  return (
    <div
      data-slot="table-container"
      className={cn("relative w-full overflow-x-auto", containerClassName)}
      {...(regionLabel ? { role: "region", "aria-label": regionLabel, tabIndex: 0 } : {})}
    >
      <table
        data-slot="table"
        className={cn("w-full caption-top border-collapse text-meta", className)}
        {...props}
      />
    </div>
  )
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      data-slot="table-header"
      className={cn("[&_tr]:border-b", className)}
      {...props}
    />
  )
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  )
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn(
        "border-t bg-muted/50 font-medium [&>tr]:last:border-b-0",
        className
      )}
      {...props}
    />
  )
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "border-b border-line transition-colors hover:bg-muted/40 data-[state=selected]:bg-primary-soft [thead_&]:hover:bg-transparent",
        className
      )}
      {...props}
    />
  )
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "px-2.5 py-2 text-left align-top font-medium text-foreground [thead_&]:h-9 [thead_&]:bg-muted/50 [thead_&]:align-middle [thead_&]:text-xs [thead_&]:font-medium [thead_&]:text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "px-2.5 py-2 align-top",
        className
      )}
      {...props}
    />
  )
}

function TableCaption({
  className,
  ...props
}: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("pb-2 text-left text-sm font-semibold text-foreground", className)}
      {...props}
    />
  )
}

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
}
