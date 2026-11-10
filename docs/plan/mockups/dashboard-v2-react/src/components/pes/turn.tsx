import * as React from "react";
import { Link } from "react-router";
import { ArrowRightIcon, BotIcon, CheckIcon, PauseIcon, UserRoundIcon } from "lucide-react";
import type { TurnView } from "@/api/types";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { STATUS, type StatusDef } from "./status-registry";
import { Chip, StatusMark } from "./status";

/**
 * 차례 표시기(설계 15절 — 4차 사용자 결정 2026-11-05): 지금 누가 움직일 차례인지 한눈에.
 *
 * - 트랙: 왼쪽 끝 = 사람(나), 오른쪽 끝 = AI. 공(동그라미)이 차례인 쪽에 있다. 차례가 바뀌면 공이 부드럽게 옮겨 간다.
 *   기다림(다른 사람·시각)과 끝남은 가운데. 트랙은 눈으로 보는 그림일 뿐이라 aria-hidden — 뜻은 옆 칩의 글자가 전한다.
 * - 칩: 상태 사전(turn)의 모양 + 글자 + 색 그대로(나의 할 일 · AI 작업 중 · AI 작업 중 · 소식 없음 · 기다림 · 끝남).
 * - 움직임은 두 가지뿐: (1) AI 작업 중이고 소식이 시험값 안(fresh)일 때 공 둘레를 도는 점, (2) 나의 할 일로 바뀌는 순간 한 번 퍼지는 고리.
 *   소식이 오래되면 점이 멈추고 점선 고리 + “마지막 소식 n분 전”(stage-3 2.6 — 답이 없으면 없다고). 번쩍임·반복 깜박임 없음.
 * - 움직임 줄이기(prefers-reduced-motion)에서는 index.css가 움직임을 모두 끈다 — 모양·글자만으로 같은 뜻.
 * - 전환 알림은 화면 읽기 프로그램에 한 곳(TurnAnnouncer, polite)에서만 — 표시기가 여러 개 있어도 겹쳐 읽지 않는다.
 */

export type TurnKey = "you" | "ai" | "ai_quiet" | "waiting" | "done";

export function turnKey(t: TurnView): TurnKey {
  if (t.side === "ai") return t.fresh ? "ai" : "ai_quiet";
  return t.side;
}

export function turnDef(k: TurnKey): StatusDef {
  return STATUS.turn[k]!;
}

/** 칩 글자 = 사전 이름(+ 나의 할 일이면 수) — 이름은 상태 사전 한 곳에서만 온다 */
export function turnLabel(t: TurnView): string {
  const k = turnKey(t);
  const def = turnDef(k);
  return k === "you" && t.count ? `${def.label} ${t.count}건` : def.label;
}

/* ───────── 경과 시간: 15초마다 다시 그림(글자만 바뀜 — 움직임 아님) ───────── */

let ticker: number | undefined;
const tickListeners = new Set<() => void>();
function subscribeNow(cb: () => void) {
  tickListeners.add(cb);
  if (ticker === undefined) {
    ticker = window.setInterval(() => {
      clock = Date.now();
      tickListeners.forEach((l) => l());
    }, 15000);
  }
  return () => {
    tickListeners.delete(cb);
    if (tickListeners.size === 0 && ticker !== undefined) {
      window.clearInterval(ticker);
      ticker = undefined;
    }
  };
}
/**
 * 그릴 때의 지금 시각(밀리초 보존) — 바깥(시계)에서 읽는 값이라 useSyncExternalStore로 읽는다.
 * 스냅숏 값은 저장해 두고 15초 틱마다 새로 잡는다(매 getSnapshot 호출에서 Date.now를 부르지 않는다).
 * 새 입력(자료가 바뀜)이 오면 effect에서 그때의 정확한 시각을 한 번 저장하고 구독자에게 알린다.
 * 시계 알림 때문에 다시 그려질 때는 입력이 그대로라 effect가 다시 돌지 않는다(멱등, 렌더 중 외부 값 변경 없음).
 */
let clock = Date.now();
function clockSnapshot() {
  return clock;
}
export function useNow(input?: string) {
  const now = React.useSyncExternalStore(subscribeNow, clockSnapshot, clockSnapshot);
  // 첫 그림 전에 그때의 시각으로 맞춘다(그림 뒤 effect면 한 프레임 옛 시각이 보인다)
  React.useLayoutEffect(() => {
    clock = Date.now();
    tickListeners.forEach((l) => l());
  }, [input]);
  return now;
}

function minutesBetween(fromIso: string, now: number) {
  return Math.max(0, Math.floor((now - Date.parse(fromIso)) / 60000));
}
function hm(m: number) {
  const h = Math.floor(m / 60);
  const r = m % 60;
  return h ? (r ? `${h}시간 ${r}분` : `${h}시간`) : `${m}분`;
}
/** 차례가 AI로 넘어간 뒤 흐른 시간: “방금 시작” · “3분째” · “1시간 5분째” */
export function elapsedText(fromIso: string, now: number) {
  const m = minutesBetween(fromIso, now);
  return m < 1 ? "방금 시작" : `${hm(m)}째`;
}
/** 마지막 소식: “방금” · “18분 전” */
export function agoText(iso: string, now: number) {
  const m = minutesBetween(iso, now);
  return m < 1 ? "방금" : `${hm(m)} 전`;
}
function signalText(t: TurnView, now: number) {
  if (!t.last_signal) return null;
  const ago = agoText(t.last_signal, now);
  if (!t.fresh) return `마지막 소식 ${ago}`;
  return ago === "방금" ? "방금 소식" : `소식 ${ago}`;
}

/* ───────── 트랙(그림) ───────── */

/** sm 56px: 공이 가운데(기다림·끝남)일 때도 양 끝 아이콘과 겹치지 않는 가장 좁은 폭 */
const GEO = {
  sm: { w: 56, h: 24, t: 20, icon: "size-3" },
  lg: { w: 116, h: 32, t: 28, icon: "size-4" },
} as const;

const THUMB: Record<TurnKey, string> = {
  // 정지된 강한 색(채운 강조색 + 흰 글자 색) — 번쩍이지 않는다
  you: "border-primary bg-primary text-primary-foreground shadow-xs",
  ai: "border-primary-ink bg-card text-primary-ink",
  ai_quiet: "border-dashed border-control bg-card text-ink-2",
  waiting: "border-control bg-off-soft text-off",
  done: "border-ok bg-ok-soft text-ok",
};
const THUMB_ICON: Record<TurnKey, typeof UserRoundIcon> = { you: UserRoundIcon, ai: BotIcon, ai_quiet: BotIcon, waiting: PauseIcon, done: CheckIcon };

/** 공이 사람 쪽 · AI 쪽 · 가운데 중 어디에 있는가 */
function place(k: TurnKey) {
  return k === "you" ? "left" : k === "ai" || k === "ai_quiet" ? "right" : "center";
}

export function TurnTrack({ turn, size = "sm", className }: { turn: TurnView; size?: "sm" | "lg"; className?: string }) {
  const k = turnKey(turn);
  const g = GEO[size];
  const inner = g.w - 2; // 테두리 1px 안쪽 폭
  const top = (g.h - 2 - g.t) / 2;
  const at = place(k);
  const x = at === "left" ? 1 : at === "right" ? inner - 1 - g.t : (inner - g.t) / 2;

  // 나의 할 일로 바뀌는 순간에만 한 번 퍼지는 고리(처음 그릴 때는 없음)
  const prev = React.useRef<TurnKey | null>(null);
  const [arrived, setArrived] = React.useState(false);
  React.useEffect(() => {
    const was = prev.current;
    prev.current = k;
    if (was !== null && was !== k && k === "you") {
      setArrived(true);
      const t = window.setTimeout(() => setArrived(false), 1000);
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, [k]);

  const Icon = THUMB_ICON[k];
  return (
    <span
      aria-hidden="true"
      data-turn-track={k}
      className={cn("relative inline-block shrink-0 rounded-full border border-line-strong bg-surface-soft align-middle forced-colors:border-[CanvasText]", className)}
      style={{ width: g.w, height: g.h }}
    >
      {size === "lg" ? <span className="absolute top-1/2 border-t border-dashed border-line-strong" style={{ left: 1 + g.t, right: 1 + g.t }} /> : null}
      <span className="absolute grid place-items-center text-muted-foreground" style={{ left: 1, top, width: g.t, height: g.t }}>
        <UserRoundIcon className={g.icon} />
      </span>
      <span className="absolute grid place-items-center text-muted-foreground" style={{ right: 1, top, width: g.t, height: g.t }}>
        <BotIcon className={g.icon} />
      </span>
      <span
        data-turn-thumb={at}
        className={cn("pes-turn-thumb absolute left-0 grid place-items-center rounded-full border-[1.5px] forced-colors:border-[CanvasText]", THUMB[k])}
        style={{ top, width: g.t, height: g.t, transform: `translateX(${x}px)` }}
      >
        <Icon className={g.icon} strokeWidth={2.25} />
        {k === "ai" ? (
          <span className="pes-turn-orbit absolute inset-[2px] rounded-full">
            <span className="absolute top-0 left-1/2 size-[5px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary-ink ring-2 ring-card" />
          </span>
        ) : null}
        {arrived ? <span className="pes-turn-arrive absolute inset-[-3px] rounded-full border-2 border-primary" /> : null}
      </span>
    </span>
  );
}

/**
 * 사이드바 배지·좁은 자리용 작은 표시(10px). AI 작업 중(소식 있음)이면 고리 위를 점이 돈다.
 * 크기는 바깥 span이 정하고 안의 모양은 size-full!로 따른다 — 사이드바 메뉴 단추의 “안의 svg는 모두 16px” 규칙에 커지지 않게.
 */
export function TurnMark({ turn, className }: { turn: TurnView; className?: string }) {
  const k = turnKey(turn);
  if (k === "ai") {
    return (
      <span aria-hidden="true" data-turn-mark={k} className={cn("relative inline-block size-2.5 shrink-0", className)}>
        <StatusMark shape="ring" className="absolute inset-0 size-full!" />
        <span className="pes-turn-orbit absolute -inset-px rounded-full">
          <span className="absolute top-0 left-1/2 size-[4px] -translate-x-1/2 rounded-full bg-current" />
        </span>
      </span>
    );
  }
  return (
    <span aria-hidden="true" data-turn-mark={k} className={cn("inline-flex size-2.5 shrink-0", className)}>
      <StatusMark shape={turnDef(k).shape} className="size-full!" />
    </span>
  );
}

/**
 * 차례 표시기 한 덩어리:
 *   [트랙] [칩(모양+글자 · 나의 할 일이면 수)]
 *   한 줄 — 먼저 할 일(나의 할 일) · 지금 하는 일(AI 작업 중) · 기다리는 것(기다림)
 *   경과 · 소식 — AI 작업 중일 때만(“30분째 · 마지막 소식 18분 전”)
 *   [바로 가기] — 나의 할 일일 때만(서버가 준 먼저 할 일의 동작)
 * - size sm: 목록 표·카드·휴대폰 · lg: 작업 공간 지금 할 일 띠
 * - detail=false면 한 줄을 빼고(제목이 이미 말할 때) 경과·소식만 남긴다
 */
export function TurnIndicator({
  turn,
  size = "sm",
  detail = true,
  action = false,
  align = "start",
  className,
}: {
  turn: TurnView;
  size?: "sm" | "lg";
  detail?: boolean;
  action?: boolean;
  /** end: 넓은 화면에서 오른쪽 맞춤(지금 할 일 띠의 오른쪽 칸) */
  align?: "start" | "end";
  className?: string;
}) {
  const k = turnKey(turn);
  const def = turnDef(k);
  // 경과·소식에 쓰는 입력이 바뀔 때마다 그 정확한 시각으로 다시 센다(같은 입력이면 15초 틱만)
  const now = useNow(`${turn.side}|${turn.since ?? ""}|${turn.last_signal ?? ""}|${turn.fresh ? "1" : "0"}`);
  const meta = turn.side === "ai" ? [turn.since ? elapsedText(turn.since, now) : null, signalText(turn, now)].filter(Boolean).join(" · ") : "";
  const right = align === "end" && "tab:text-right";
  return (
    <div data-turn={k} className={cn("flex min-w-0 flex-col gap-0.5", align === "end" && "tab:items-end", className)}>
      <div className={cn("mb-0.5 flex flex-wrap items-center gap-x-2 gap-y-1", align === "end" && "tab:justify-end")}>
        <TurnTrack turn={turn} size={size} />
        <Chip shape={def.shape} tone={def.tone} className={size === "lg" ? "py-0.5 text-meta" : undefined}>
          {turnLabel(turn)}
        </Chip>
      </div>
      {detail && turn.text ? <p className={cn("min-w-0 text-caption text-ink", right)}>{turn.text}</p> : null}
      {meta ? <p className={cn("min-w-0 text-xs text-muted-foreground tabular-nums", right)}>{meta}</p> : null}
      {action && k === "you" && turn.action ? (
        <Button asChild size="sm" variant="outline" className="mt-1 self-start">
          <Link to={turn.action.href}>
            {turn.action.label}
            <ArrowRightIcon aria-hidden="true" />
          </Link>
        </Button>
      ) : null}
    </div>
  );
}
