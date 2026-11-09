import { MonitorIcon, MoonIcon, PaletteIcon, SunIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { MODE_LABEL, THEME_SOURCE_NOTE, THEMES, type ColorMode, type ThemeId } from "@/themes/themes";

const MODE_ICON: Record<ColorMode, typeof SunIcon> = { light: SunIcon, dark: MoonIcon, system: MonitorIcon };

/** 테마 견본: 그 테마의 클래스를 견본 칸에 직접 붙여 그 테마 변수로 그린다(바탕 · 카드 · 강조 · 글자). */
function Swatch({ id, dark }: { id: ThemeId; dark: boolean }) {
  return (
    <span aria-hidden="true" className={cn(`theme-${id}`, dark && "dark", "flex h-5 w-9 shrink-0 overflow-hidden rounded-md border border-(--border)")}>
      <span className="h-full w-1/4 bg-background" />
      <span className="h-full w-1/4 bg-card" />
      <span className="h-full w-1/4 bg-primary" />
      <span className="h-full w-1/4 bg-foreground" />
    </span>
  );
}

/**
 * 머리줄 “테마” 메뉴(시안) — tweakcn 테마 4개 × 밝게/어둡게/시스템 따라. 고른 값은 이 브라우저(localStorage)에만 남는다.
 * 고를 때 메뉴를 닫지 않아 차례로 바꿔 볼 수 있다. 글꼴은 어느 테마든 Pretendard.
 */
export function ThemeMenu() {
  const t = useTheme();
  const current = THEMES.find((x) => x.id === t.theme)!;
  const ModeIcon = MODE_ICON[t.mode];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={`테마: ${current.name} · ${MODE_LABEL[t.mode]}`} title="테마">
          <PaletteIcon aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={6} className="w-72">
        <DropdownMenuLabel className="text-xs text-muted-foreground">테마 · 시안에서 바꿔 보기</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={t.theme} onValueChange={(v) => t.set({ theme: v as ThemeId })}>
          {THEMES.map((x) => (
            <DropdownMenuRadioItem key={x.id} value={x.id} onSelect={(e) => e.preventDefault()} className="gap-2.5 py-1.5">
              <Swatch id={x.id} dark={t.dark} />
              <span className="grid min-w-0 leading-tight">
                <span className="font-medium">{x.name}</span>
                <span className="text-xs text-muted-foreground">{x.note}</span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <ModeIcon className="size-3.5" aria-hidden="true" />
          밝기
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup value={t.mode} onValueChange={(v) => t.set({ mode: v as ColorMode })}>
          {(["light", "dark", "system"] as const).map((m) => {
            const Icon = MODE_ICON[m];
            return (
              <DropdownMenuRadioItem key={m} value={m} onSelect={(e) => e.preventDefault()} className="gap-2">
                <Icon aria-hidden="true" />
                {MODE_LABEL[m]}
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <p className="px-2 py-1.5 text-xs text-muted-foreground">{THEME_SOURCE_NOTE}. 고른 값은 이 브라우저에만 남습니다.</p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
