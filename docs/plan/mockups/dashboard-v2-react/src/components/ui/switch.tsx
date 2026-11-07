"use client"

import * as React from "react"
import { cn } from "cn"
import { Switch as SwitchPrimitive } from "radix-ui"

// PES 시안: 켜짐 = 초록 바탕 + 흰 손잡이, 꺼짐 = 흰 바탕 + 회색 테두리·손잡이(정적 시안과 같은 모양).
// 스위치 옆에는 언제나 글자(허용/금지, 켜짐/꺼짐)를 함께 둔다 — StateSwitch 참고.
function Switch({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer group/switch relative inline-flex h-[22px] w-[40px] shrink-0 items-center rounded-full border-2 transition-colors outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring data-checked:border-ok data-checked:bg-ok data-unchecked:border-control data-unchecked:bg-surface data-disabled:cursor-not-allowed data-disabled:border-dashed aria-disabled:border-dashed",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block size-[14px] rounded-full transition-transform data-checked:translate-x-[20px] data-checked:bg-card data-unchecked:translate-x-[2px] data-unchecked:bg-control"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
