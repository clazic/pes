"use client"

import * as React from "react"
import { Dialog as DialogPrimitive } from "radix-ui"
import { cn } from "@/lib/utils"

// PES: shadcn dialog 를 PES 토큰으로. Portal 이 body 아래로 나가 질문 영역 인쇄 제외 규칙이 닿지 않으므로 덮개와 내용 둘 다 data-print=hide(미제출 입력 · 덮개는 인쇄하지 않는다). 닫힐 때 바로 사라진다(퇴장 애니메이션 없음 — 닫히는 동안 초점 가두기가 되돌려 놓는 일이 없게). 닫기 단추는 화면(대화 상자 쓰는 쪽)이 "취소"로 직접 둔다 — 글자 있는 단추가 아이콘보다 읽힌다.
function Dialog({ ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content>) {
  return (
    <DialogPrimitive.Portal data-slot="dialog-portal">
      <DialogPrimitive.Overlay
        data-slot="dialog-overlay"
        data-print="hide"
        className="fixed inset-0 z-50 bg-black/20 duration-100 data-open:animate-in data-open:fade-in-0"
      />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        data-print="hide"
        className={cn(
          "fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-lg border bg-popover p-5 text-popover-foreground shadow-lg outline-none duration-150 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-[0.98]",
          className
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="dialog-header" className={cn("flex flex-col gap-1.5", className)} {...props} />
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="dialog-footer" className={cn("flex flex-wrap justify-end gap-2", className)} {...props} />
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title data-slot="dialog-title" className={cn("text-title text-ink", className)} {...props} />
}

function DialogDescription({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return <DialogPrimitive.Description data-slot="dialog-description" className={cn("text-meta text-ink-2", className)} {...props} />
}

export { Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription }
