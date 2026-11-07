import * as React from "react";
import { useNavigate } from "react-router";
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";

/**
 * 명령 메뉴(Ctrl/Cmd+K) — 하나의 동작 목록(stage-1-ui 결정 5, 설계 4.15).
 * 한글 조합 중에는 단축키를 무시한다. 사람 권한 동작은 메뉴를 거쳐도 서버가 다시 검사한다.
 * 검색 결과 없음을 AI 전송으로 바꾸지 않는다.
 */
const ACTIONS: { group: string; label: string; to: string; owner?: boolean }[] = [
  { group: "작업 공간", label: "질문으로 가기 — 지역 돌봄 · 조사 R2", to: "/p/dolbom-insight/e/1/s/research/r/2#q-21" },
  { group: "작업 공간", label: "AI 작업 보기", to: "/p/dolbom-insight/ai" },
  { group: "작업 공간", label: "AI 실행 시작 · 계속", to: "/p/dolbom-insight/e/1/s/research/r/2#ai", owner: true },
  { group: "자료", label: "자료 올리기(파일·폴더)", to: "/p/dolbom-insight/files#upload" },
  { group: "자료", label: "참고 프로젝트 붙이기", to: "/p/dolbom-insight/references", owner: true },
  { group: "자료", label: "AI가 읽기 막기", to: "/p/dolbom-insight/settings", owner: true },
  { group: "전체", label: "사용량 보기", to: "/usage" },
  { group: "전체", label: "AI 연결 추가", to: "/usage#connections", owner: true },
  { group: "전체", label: "내 컴퓨터 보기", to: "/computer" },
  { group: "전체", label: "새 프로젝트", to: "/new" },
  { group: "시안", label: "상태 견본", to: "/states" },
  { group: "시안", label: "휴대폰 화면", to: "/mobile" },
  { group: "시안", label: "시안 안내 · 화면 목록", to: "/guide" },
];

export function useCommandMenu() {
  const [open, setOpen] = React.useState(false);
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return; // 한글 조합 중
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return { open, setOpen };
}

export function CommandMenu({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const navigate = useNavigate();
  const groups = [...new Set(ACTIONS.map((a) => a.group))];
  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <Command>
      <CommandInput placeholder="동작 이름으로 찾기 (예: 자료 올리기)" />
      <CommandList>
        <CommandEmpty>찾는 동작이 없습니다. 검색어를 AI에게 보내지 않습니다.</CommandEmpty>
        {groups.map((g) => (
          <CommandGroup key={g} heading={g}>
            {ACTIONS.filter((a) => a.group === g).map((a) => (
              <CommandItem
                key={a.label}
                onSelect={() => {
                  onOpenChange(false);
                  navigate(a.to);
                }}
              >
                <span className="min-w-0 flex-1">{a.label}</span>
                {a.owner ? <span className="text-xs font-medium text-muted-foreground">소유자</span> : null}
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
      </Command>
    </CommandDialog>
  );
}
