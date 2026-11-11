import { Palette } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/lib/theme";
import { MODE_LABEL, THEMES, type ColorMode, type ThemeId } from "@/themes/themes";

const MODES: ColorMode[] = ["light", "dark", "system"];

const itemClass =
  "flex min-h-8 cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-meta outline-none select-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground";

function Mark() {
  return (
    <DropdownMenu.ItemIndicator className="absolute left-2 inline-flex">
      <svg viewBox="0 0 12 12" aria-hidden="true" className="size-3">
        <circle cx="6" cy="6" r="4" fill="currentColor" />
      </svg>
    </DropdownMenu.ItemIndicator>
  );
}

/**
 * 테마 고르기(설계 12.9) — tweakcn 4개 × 밝게 / 어둡게 / 시스템 따라. 고른 값은 이 브라우저(localStorage)에만 남는다.
 * 메뉴를 닫지 않아 차례로 바꿔 볼 수 있다.
 */
export function ThemeMenu() {
  const { theme, mode, set } = useTheme();
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="테마">
          <Palette aria-hidden="true" />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={6} className="z-50 min-w-52 rounded-lg border bg-popover p-1 text-popover-foreground shadow-md">
          <DropdownMenu.Label className="px-2 pt-1 pb-0.5 text-caption text-muted-foreground">테마</DropdownMenu.Label>
          <DropdownMenu.RadioGroup value={theme} onValueChange={(v) => set({ theme: v as ThemeId })}>
            {THEMES.map((t) => (
              <DropdownMenu.RadioItem key={t.id} value={t.id} className={`relative pl-7 ${itemClass}`} onSelect={(e) => e.preventDefault()}>
                <Mark />
                <span>{t.name}</span>
                <span className="ml-auto text-caption text-muted-foreground">{t.note}</span>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          <DropdownMenu.Label className="px-2 pt-1 pb-0.5 text-caption text-muted-foreground">밝기</DropdownMenu.Label>
          <DropdownMenu.RadioGroup value={mode} onValueChange={(v) => set({ mode: v as ColorMode })}>
            {MODES.map((m) => (
              <DropdownMenu.RadioItem key={m} value={m} className={`relative pl-7 ${itemClass}`} onSelect={(e) => e.preventDefault()}>
                <Mark />
                {MODE_LABEL[m]}
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
