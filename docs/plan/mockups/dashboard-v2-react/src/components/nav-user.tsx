import { useNavigate } from "react-router"
import { BellIcon, BookOpenIcon, GaugeIcon, LaptopIcon } from "lucide-react"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ROLE_LABEL, ROLE_PERSON, useMockSettings } from "@/lib/mock-settings"

/**
 * sidebar-07 블록의 NavUser를 머리줄 오른쪽 사용자 메뉴로 옮겨 쓴다(shadcn-admin 머리줄 구조 참고 — 코드는 가져오지 않음).
 * 사람 이름 · 역할(설계 3.1 전역 머리줄의 “사람”). 보는 사람 바꾸기는 시안 조작에서 한다(제품 기능 아님).
 */
export function NavUser() {
  const settings = useMockSettings()
  const navigate = useNavigate()
  const name = ROLE_PERSON[settings.role]
  const role = ROLE_LABEL[settings.role]
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="rounded-full" aria-label={`사용자 메뉴 — ${name} · ${role}`}>
          <Avatar className="size-8">
            <AvatarFallback className="bg-primary-soft text-meta font-semibold text-primary-ink">{name.slice(0, 1)}</AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-64" align="end" sideOffset={6}>
        <DropdownMenuLabel className="p-0 font-normal">
          <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
            <Avatar className="size-8">
              <AvatarFallback className="bg-primary-soft text-meta font-semibold text-primary-ink">{name.slice(0, 1)}</AvatarFallback>
            </Avatar>
            <div className="grid flex-1 text-left leading-tight">
              <span className="truncate font-semibold text-foreground">{name}</span>
              <span className="truncate text-xs text-muted-foreground">{role} · 보는 사람은 ‘시안 조작’에서 바꿈</span>
            </div>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem onSelect={() => navigate("/computer")}>
            <LaptopIcon aria-hidden="true" />
            내 컴퓨터
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => navigate("/usage#connections")}>
            <GaugeIcon aria-hidden="true" />
            사용량 · AI 연결
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => navigate("/notifications")}>
            <BellIcon aria-hidden="true" />
            알림
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate("/guide")}>
          <BookOpenIcon aria-hidden="true" />
          시안 안내 · 화면 목록
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
