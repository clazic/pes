import * as React from "react";
import { flushSync } from "react-dom";
import { Dialog as DialogPrimitive } from "radix-ui";
import { ArrowDownIcon, ArrowUpIcon, SearchIcon, SparklesIcon } from "lucide-react";
import { ActionButton } from "@/components/pes/action-button";
import { Kbd } from "@/components/pes/kbd";
import { cn } from "@/lib/utils";
import { ACTION_GROUPS, filterActions, type PesAction } from "./actions";

/**
 * 명령 메뉴(Ctrl/Cmd+K · 설계 4.15 · 12.6 · U1c) — 동작 목록 하나(actions.ts)를 찾고 실행한다.
 *  - 모달 대화 상자 "명령 메뉴": 검색 칸(combobox) → 동작 목록(listbox/option). 첫 항목이 처음부터 강조, ↑↓ 로 옮기고 Enter 로 실행.
 *  - 한글 조합 중(isComposing · keyCode 229 · compositionstart~end)에는 단축키 · Enter · Tab 보조가 아무것도 하지 않는다.
 *  - 결과가 없으면 안내만 — 검색어를 AI에게 보내지 않는다. AI 모드는 단추 "AI 모드"로만 켠다(U1c 는 AI 연결 없음 → 보내기는 막힌 자리).
 *  - 닫힌 뒤 초점: 동작이 화면 안 다른 곳으로 초점을 옮기면 그 동작이 맡고, 아니면 열기 전 요소(단추 · 글 칸)로 돌아간다.
 * 동작은 지금 화면(작업 공간)이 등록한다 — 작은 저장소(useSyncExternalStore)에 두고, 열려 있는 대화 상자만 구독한다.
 *   내용(id · 이름 · 묶음 · run)이 그대로면 알리지 않아 화면이 다시 그려질 때마다 메뉴를 다시 그리지 않고, 열어 둔 사이 바뀐 목록(새 run 포함)은 곧바로 반영된다.
 */
interface CommandMenuApi {
  open: () => void;
  /** 화면이 내놓는 동작을 등록한다(마지막 등록이 이긴다) */
  setActions: (list: PesAction[]) => void;
}

/** 등록된 동작 목록 저장소 — 내용이 같은 목록으로 다시 등록해도 알리지 않는다 */
function createActionStore() {
  let list: PesAction[] = [];
  const listeners = new Set<() => void>();
  const same = (a: PesAction[], b: PesAction[]) => a.length === b.length && a.every((x, i) => x.id === b[i]!.id && x.label === b[i]!.label && x.group === b[i]!.group && x.keys === b[i]!.keys && x.run === b[i]!.run);
  return {
    get: () => list,
    set(next: PesAction[]) {
      if (same(list, next)) return;
      list = next;
      listeners.forEach((fn) => fn());
    },
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
  };
}
type ActionStore = ReturnType<typeof createActionStore>;

const CommandMenuContext = React.createContext<CommandMenuApi | null>(null);

export function useCommandMenu(): CommandMenuApi {
  const api = React.useContext(CommandMenuContext);
  if (!api) throw new Error("CommandMenuProvider 안에서 쓴다");
  return api;
}

/** 화면이 동작을 등록한다(그릴 때마다 최신 동작으로, 사라지면 비운다) */
export function useRegisterActions(list: PesAction[]) {
  const { setActions } = useCommandMenu();
  React.useLayoutEffect(() => {
    setActions(list);
  });
  React.useEffect(() => () => setActions([]), [setActions]);
}

/** 한글 조합 중인가 — 이벤트 표시와, 문서에서 본 compositionstart ~ compositionend 둘 다 본다 */
const composingKey = (e: KeyboardEvent | React.KeyboardEvent, composing: boolean) => {
  const native = "nativeEvent" in e ? e.nativeEvent : e;
  return composing || native.isComposing || native.keyCode === 229;
};

export function CommandMenuProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  /** 열 때마다 하나씩 — 대화 상자 안 상태(검색어 · 강조 · AI 모드)를 처음으로 */
  const [session, setSession] = React.useState(0);
  const [store] = React.useState(createActionStore);
  /** 열려 있는가 — openMenu 가 상태 업데이터 밖에서 한 번만 세션을 올리도록 */
  const isOpen = React.useRef(false);
  /** 열기 전 초점(단추 · 글 칸) — 동작 없이 닫히면 곧바로 여기로 돌려준다 */
  const returnTo = React.useRef<HTMLElement | null>(null);
  const openMenu = React.useCallback(() => {
    if (isOpen.current) return;
    isOpen.current = true;
    returnTo.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    setSession((n) => n + 1);
    setOpen(true);
  }, []);
  /** 닫기: 동작을 고른 경우(handOff)는 동작이 초점을 맡고, 아니면 가두기를 걷어 낸 뒤 열기 전 요소로 */
  const close = React.useCallback((handOff: boolean) => {
    isOpen.current = false;
    flushSync(() => setOpen(false));
    if (!handOff) returnTo.current?.focus();
    returnTo.current = null;
  }, []);
  const composing = React.useRef(false);

  React.useEffect(() => {
    const onStart = () => {
      composing.current = true;
    };
    const onEnd = () => {
      composing.current = false;
    };
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      // 한글 자판에서는 key 가 'ㅏ' 로 올 수 있다 — 같은 자리(KeyK)도 본다
      if (e.key.toLowerCase() !== "k" && e.code !== "KeyK") return;
      if (composingKey(e, composing.current)) return; // 조합 확정용 키를 빼앗지 않는다
      e.preventDefault();
      openMenu();
    };
    document.addEventListener("compositionstart", onStart, true);
    document.addEventListener("compositionend", onEnd, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("compositionstart", onStart, true);
      document.removeEventListener("compositionend", onEnd, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [openMenu]);

  const api = React.useMemo<CommandMenuApi>(
    () => ({
      open: openMenu,
      setActions: store.set,
    }),
    [openMenu, store],
  );
  return (
    <CommandMenuContext.Provider value={api}>
      {children}
      <CommandMenuDialog key={session} open={open} onClose={close} store={store} />
    </CommandMenuContext.Provider>
  );
}

const LIST_ID = "command-menu-list";
const optionId = (a: PesAction) => `command-option-${a.id.replace(/[^\w-]/g, "-")}`;

function CommandMenuDialog({ open, onClose, store }: { open: boolean; onClose: (handOff: boolean) => void; store: ActionStore }) {
  const [query, setQuery] = React.useState("");
  const [active, setActive] = React.useState(0);
  const [ai, setAi] = React.useState(false);
  /** AI 모드 글은 검색어와 따로 둔다 — 모드를 바꿔도 서로 섞이지 않는다 */
  const [aiText, setAiText] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement>(null);
  const composing = React.useRef(false);

  const registered = React.useSyncExternalStore(store.subscribe, store.get);
  const all = open ? registered : [];
  const shown = ai ? [] : filterActions(all, query);
  const current = shown[Math.min(active, shown.length - 1)];

  React.useEffect(() => {
    if (current) document.getElementById(optionId(current))?.scrollIntoView({ block: "nearest" });
  }, [current]);

  const run = (a: PesAction) => {
    // 대화 상자(초점 가두기)를 먼저 걷어 낸 뒤 실행 — 동작이 옮기는 초점을 가두기가 되돌리지 않게
    onClose(true);
    a.run();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (composingKey(e, composing.current)) return;
    if (ai) {
      if (e.key === "Enter") e.preventDefault(); // AI 연결이 없다 — 아무것도 보내지 않는다
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!shown.length) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((i) => (Math.min(i, shown.length - 1) + step + shown.length) % shown.length);
    } else if (e.key === "Home" && e.ctrlKey) {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End" && e.ctrlKey) {
      e.preventDefault();
      setActive(shown.length - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (current) run(current); // 결과 없음: 아무 일도 없다
    } else if (e.key === "Tab" && !e.shiftKey) {
      // Tab 보조: 강조된 동작 이름으로 채운다. 이미 같거나 강조가 없으면 평소 Tab(덫이 되지 않게)
      if (current && query !== current.label) {
        e.preventDefault();
        setQuery(current.label);
        setActive(0);
      }
    }
  };

  const groups = ACTION_GROUPS.map((g) => ({ g, items: shown.filter((a) => a.group === g) })).filter((x) => x.items.length);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => !o && onClose(false)}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/15 data-open:animate-in data-open:fade-in-0 data-open:duration-150" />
        <DialogPrimitive.Content
          aria-describedby="command-menu-help"
          className="fixed top-[12vh] left-1/2 z-50 flex max-h-[76vh] w-[min(36rem,calc(100vw-2rem))] -translate-x-1/2 flex-col overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-[0_12px_32px_-12px_rgb(0_0_0/0.28),0_2px_6px_-2px_rgb(0_0_0/0.12)] outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-[0.98] data-open:duration-150 data-open:ease-out"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            inputRef.current?.focus();
          }}
          // 한글 조합 중 Esc 는 조합을 취소하는 키다 — 메뉴를 닫지 않는다(조합 밖 Esc 만 닫고 초점 복귀)
          onEscapeKeyDown={(e) => {
            if (composingKey(e, composing.current)) e.preventDefault();
          }}
          // 초점 복귀는 닫는 쪽(close)이 곧바로 한다 — radix 의 늦은 복귀가 동작이 옮긴 초점을 빼앗지 않게
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <DialogPrimitive.Title className="sr-only">명령 메뉴</DialogPrimitive.Title>
          <p id="command-menu-help" className="sr-only">
            {ai ? "AI 모드입니다. 지금은 AI 연결이 없어 쓴 글을 보내지 않습니다." : "동작 이름을 쓰면 목록이 걸러집니다. 위아래 화살표로 고르고 Enter 로 실행합니다."}
          </p>
          <div className="flex items-center gap-2 border-b px-3">
            {ai ? <SparklesIcon aria-hidden="true" className="size-4 shrink-0 text-primary-ink" /> : <SearchIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />}
            <input
              ref={inputRef}
              role="combobox"
              aria-label={ai ? "AI에게 묻기" : "명령 · 동작 찾기"}
              aria-expanded={!ai}
              aria-controls={ai ? undefined : LIST_ID}
              aria-autocomplete={ai ? undefined : "list"}
              aria-activedescendant={!ai && current ? optionId(current) : undefined}
              autoComplete="off"
              spellCheck={false}
              placeholder={ai ? "AI에게 물을 글 (지금은 보내지 않아요)" : "동작 이름으로 찾기 (예: 인쇄)"}
              value={ai ? aiText : query}
              onChange={(e) => {
                if (ai) return setAiText(e.target.value);
                setQuery(e.target.value);
                setActive(0);
              }}
              onCompositionStart={() => {
                composing.current = true;
              }}
              onCompositionEnd={() => {
                composing.current = false;
              }}
              onKeyDown={onKeyDown}
              className="h-12 min-w-0 flex-1 bg-transparent text-body text-ink outline-none placeholder:text-muted-foreground"
            />
            <button
              type="button"
              aria-pressed={ai}
              onClick={() => {
                setAi((v) => !v);
                setActive(0);
                inputRef.current?.focus(); // 바뀐 칸에 바로 쓰도록
              }}
              className={cn(
                "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2 text-caption font-medium outline-none transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                ai ? "border-primary-line bg-primary-soft text-primary-ink" : "border-line text-ink-2 hover:bg-muted hover:text-ink",
              )}
            >
              <SparklesIcon aria-hidden="true" className="size-3.5" />
              AI 모드
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5">
            {ai ? (
              <div className="space-y-3 px-2.5 py-3">
                <p className="text-meta text-ink-2">AI 모드에서는 동작을 찾지 않고, 쓴 글을 AI에게 묻는 글로 다룹니다.</p>
                <ActionButton variant="default" size="sm" blockedReason="AI 연결이 아직 없어 보내지 않습니다. 연결은 다음 작업에서 열립니다." reasonId="command-ai-reason">
                  AI에게 보내기
                </ActionButton>
              </div>
            ) : (
              <div id={LIST_ID} role="listbox" aria-label="동작" className={cn(!shown.length && "hidden")}>
                {groups.map(({ g, items }) => (
                  <div key={g} role="group" aria-labelledby={`command-group-${g}`} className="pb-1 last:pb-0">
                    <p id={`command-group-${g}`} className="px-2.5 pt-2 pb-1 text-caption font-medium text-muted-foreground">
                      {g}
                    </p>
                    {items.map((a) => {
                      const selected = a === current;
                      return (
                        // 키보드는 검색 칸(aria-activedescendant)이 맡는다 — option 은 초점을 받지 않고 누르기만 받는다
                        // oxlint-disable-next-line jsx-a11y/click-events-have-key-events
                        <div
                          key={a.id}
                          id={optionId(a)}
                          role="option"
                          tabIndex={-1}
                          aria-selected={selected}
                          aria-keyshortcuts={a.keys}
                          data-kbd={a.keyHint?.join(" ")}
                          onMouseDown={(e) => e.preventDefault()}
                          onMouseMove={() => {
                            const i = shown.indexOf(a);
                            if (i !== active) setActive(i);
                          }}
                          onClick={() => run(a)}
                          className={cn(
                            "flex min-h-9 cursor-default items-center rounded-md px-2.5 text-meta text-ink select-none",
                            "data-[kbd]:after:ml-auto data-[kbd]:after:text-caption data-[kbd]:after:text-muted-foreground data-[kbd]:after:content-[attr(data-kbd)]",
                            selected && "bg-accent text-accent-foreground",
                          )}
                        >
                          {a.label}
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            )}
            <p role="status" className={cn("px-2.5 text-meta text-ink-2", !ai && !shown.length ? "py-6 text-center" : "sr-only")}>
              {!ai && !shown.length ? (all.length ? "찾는 동작이 없습니다. 검색어를 AI에게 보내지 않습니다 — AI에게 물으려면 AI 모드 단추를 켜 주세요." : "찾는 동작이 없습니다. 이 화면에는 아직 동작이 없어요 — 검색어를 AI에게 보내지 않습니다.") : ""}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t bg-surface-soft px-3 py-2 text-caption text-ink-2" aria-hidden="true">
            {ai ? null : (
              <>
                <span className="inline-flex items-center gap-1">
                  <Kbd>
                    <ArrowUpIcon className="size-3" />
                  </Kbd>
                  <Kbd>
                    <ArrowDownIcon className="size-3" />
                  </Kbd>
                  옮기기
                </span>
                <span className="inline-flex items-center gap-1">
                  <Kbd>Enter</Kbd> 실행
                </span>
                <span className="inline-flex items-center gap-1">
                  <Kbd>Tab</Kbd> 이름 채우기
                </span>
              </>
            )}
            <span className="inline-flex items-center gap-1">
              <Kbd>Esc</Kbd> 닫기
            </span>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
