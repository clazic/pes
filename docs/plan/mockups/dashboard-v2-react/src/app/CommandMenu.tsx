import * as React from "react";
import { useMatch, useNavigate } from "react-router";
import { useWorkspace } from "@/api/queries";
import { Kbd } from "@/components/pes/bits";
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { aiSheet, researchUi, useResearchUi } from "@/lib/research-ui";

/**
 * 명령 메뉴(Ctrl/Cmd+K) — 하나의 동작 목록(stage-1-ui 결정 5, 설계 4.15).
 * 한글 조합 중에는 단축키를 무시한다. 사람 권한 동작은 메뉴를 거쳐도 서버가 다시 검사한다.
 * 검색 결과 없음을 AI 전송으로 바꾸지 않는다.
 */
type Action = { group: string; label: string; to?: string; run?: () => void; owner?: boolean };
const ACTIONS: Action[] = [
  { group: "전체", label: "모든 프로젝트(관리 공간)", to: "/" },
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

/** 연구 공간 안이면 그 연구의 동작을 맨 앞에(5차 — 설계 16.5) */
function useResearchActions(): Action[] {
  const slug = useMatch("/p/:slug/*")?.params.slug ?? "";
  const ws = useWorkspace(slug).data;
  const ui = useResearchUi();
  if (!ws || ws.slug !== slug) return [];
  const round = `/p/${slug}/e/${ws.edition}/s/${ws.current.stage}/r/${ws.current.round}`;
  return [
    { group: "이 연구", label: "연구 개요 — 이어서 하기", to: `/p/${slug}` },
    { group: "이 연구", label: "지금 할 일", to: round },
    { group: "이 연구", label: "막힌 것·풀 것", to: `/p/${slug}/problems` },
    ...(ws.result ? [{ group: "이 연구", label: "결과 글 — 문제 표시 보기", to: `${round}?t=review` }] : []),
    { group: "이 연구", label: ui.focus ? "집중 모드 끝내기" : "집중 모드 켜기", run: () => researchUi.set({ focus: !ui.focus }) },
    { group: "이 연구", label: "AI 동료에게 부탁하기", run: () => aiSheet.ask(null) },
  ];
}

export function CommandMenu({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const navigate = useNavigate();
  const research = useResearchActions();
  const all = [...research, ...ACTIONS];
  const groups = [...new Set(all.map((a) => a.group))];
  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <Command>
      <CommandInput placeholder="동작 이름으로 찾기 (예: 자료 올리기)" />
      <CommandList>
        <CommandEmpty>찾는 동작이 없습니다. 검색어를 AI에게 보내지 않습니다.</CommandEmpty>
        {groups.map((g) => (
          <CommandGroup key={g} heading={g}>
            {all.filter((a) => a.group === g).map((a) => (
              <CommandItem
                key={a.label}
                onSelect={() => {
                  onOpenChange(false);
                  if (a.run) a.run();
                  else if (a.to) navigate(a.to);
                }}
              >
                <span className="min-w-0 flex-1">{a.label}</span>
                {a.owner ? <span className="text-xs font-medium text-muted-foreground">소유자</span> : null}
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
      {/* 단축키 도움말 — 같은 표를 설계 18.10 · 16.5의 집중 보조와 맞춘다 */}
      <div className="border-t border-line px-3 py-2.5 text-caption text-ink-2">
        <p className="flex flex-wrap items-center gap-1">
          <Kbd>1</Kbd>~<Kbd>4</Kbd> 선택지 고르기 · 질문 카드 안에서
        </p>
        <p className="mt-1 flex flex-wrap items-center gap-1">
          <Kbd>⌘</Kbd>/<Kbd>Ctrl</Kbd>+<Kbd>Enter</Kbd> 답 검토 후 보내기
        </p>
      </div>
      </Command>
    </CommandDialog>
  );
}
