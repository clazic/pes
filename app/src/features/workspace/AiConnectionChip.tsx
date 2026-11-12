import * as React from "react";
import type { AiConnectionView, Mode } from "@/api/types";
import { StatusMark, TONE_TEXT } from "@/components/pes/status";
import { lookup } from "@/components/pes/status-registry";
import { cn } from "@/lib/utils";

/**
 * AI 연결 칩(U1d · F07 · stage-3.md 2.2) — 언제나 보이는 단추 하나.
 *  - 상태는 이름에 낱말로 있다(색만으로 알리지 않음): 켜짐 · 차단 중 · 변경 중 · 알 수 없음.
 *  - 정책이 없거나 모르는 값이면 켜짐이라 하지 않는다(설계 P4). 서버가 칸을 아직 주지 않는 오늘은 unknown 이다.
 *  - 누르면 “AI 연결 상태” 영역이 열린다(aria-expanded · aria-controls). Esc 로 닫으면 초점이 칩으로 돌아온다.
 *  - 이미 나간 자료는 회수 보장이 없고, 재허용해도 자동 재시작이 없다는 안내를 숨기지 않는다.
 *  - 화면 글자에 ‘Go’ 를 쓰지 않는다(“AI 연결” · “API” — 사용자 결정 2026-11-05).
 */

type ChipState = "on" | "blocked" | "changing" | "unknown";

/** 정책 기계 값 → 칩 상태. 모르는 값·없음은 unknown(허용으로 해석하지 않음) */
export function chipStateOf(policy: string | undefined): ChipState {
  switch (policy) {
    case "allowed":
      return "on";
    case "denied":
    case "missing":
    case "corrupt":
      return "blocked";
    case "pending":
      return "changing";
    default:
      return "unknown";
  }
}

const EXPLAIN: Record<ChipState, string> = {
  on: "AI 연결이 켜져 있어 이 프로젝트 자료를 AI가 읽을 수 있습니다.",
  blocked: "AI 연결이 막혀 있어 이 프로젝트 자료를 AI로 보내지 않습니다. 정책을 확인할 수 없을 때도 허용으로 보지 않습니다.",
  changing: "AI 연결 설정을 바꾸는 중입니다. 확정 전에는 새로 보내지 않습니다.",
  unknown: "서버가 AI 연결 정보를 보내지 않아 상태를 알 수 없음으로 표시합니다. 켜짐으로 보지 않습니다. 이미 나간 자료가 있는지도 알 수 없습니다.",
};

const CHIP_TONE: Record<ChipState, string> = {
  on: "border-ok-line bg-ok-soft text-ok",
  blocked: "border-bad-line bg-bad-soft text-bad",
  changing: "border-warn-line bg-warn-soft text-warn",
  unknown: "border-dashed border-control bg-surface text-ink-2",
};

/** 나간 전송의 상태 낱말 — 취소 시도(끝나지 않음)와 결과를 모르는 것(unknown)을 뭉개지 않는다 */
function dispatchLabel(state: string): string {
  switch (state) {
    case "sent":
      return lookup("dispatch", "sent").label;
    case "cancel_requested":
      return lookup("dispatch", "cancel_requested").label;
    case "cancelled":
      return lookup("dispatch", "cancelled").label;
    default:
      return lookup("dispatch", "unknown").label;
  }
}

const PANEL_ID = "ai-connection-panel";

export function AiConnectionChip({ ai, mode }: { ai?: AiConnectionView; mode: Mode }) {
  const [open, setOpen] = React.useState(false);
  const chip = React.useRef<HTMLButtonElement>(null);
  const state = chipStateOf(ai?.policy);
  const def = lookup("ai", state);
  const dispatches = ai?.dispatches ?? [];
  /** 켜짐이 아니거나(차단 중 · 변경 중 · 알 수 없음) 이미 보낸 자료가 있으면 회수·재시작 안내를 숨기지 않는다 — 모르면 나간 자료가 없다고 단정하지 않는다(설계 P4) */
  const warn = state !== "on" || dispatches.length > 0;
  /** 화면 읽기 알림 — 처음 그릴 때는 비우고, 상태가 바뀐 뒤에만 한 줄을 넣는다(polite) */
  const [announce, setAnnounce] = React.useState("");
  const prevState = React.useRef(state);
  React.useEffect(() => {
    if (prevState.current === state) return;
    prevState.current = state;
    setAnnounce(`AI 연결 ${def.label}`);
  }, [state, def.label]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // 메뉴·대화 상자 같은 다른 층이 먼저 Esc 를 받았으면(defaultPrevented) 넘긴다
      if (e.key !== "Escape" || e.isComposing || e.defaultPrevented) return;
      e.preventDefault();
      setOpen(false);
      // 초점이 칩이나 이 칸 안에 있을 때만 칩으로 돌려준다 — 답 칸 같은 다른 곳에서 글을 쓰던 중이면 입력 초점을 빼앗지 않는다
      const active = document.activeElement;
      const panel = document.getElementById(PANEL_ID);
      if (active === chip.current || (active && panel?.contains(active))) chip.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <button
        ref={chip}
        type="button"
        data-state={state}
        data-print="hide"
        aria-label={`AI 연결 ${def.label}`}
        aria-expanded={open}
        aria-controls={open ? PANEL_ID : undefined}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "ml-auto inline-flex min-h-8 coarse:min-h-[44px] coarse:min-w-[44px] items-center gap-1.5 rounded-full border px-2.5 align-middle text-caption leading-[1.6] font-medium whitespace-nowrap outline-none forced-color-adjust-auto focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          CHIP_TONE[state],
        )}
      >
        <StatusMark shape={def.shape} />
        <span>AI 연결</span>
        <span>{def.label}</span>
      </button>
      <span role="status" aria-live="polite" className="sr-only" data-print="hide">
        {announce}
      </span>
      {open ? (
        <section id={PANEL_ID} aria-label="AI 연결 상태" data-print="hide" className="order-last w-full basis-full rounded-lg border bg-surface-soft px-3 py-2.5 text-left">
          <p className="text-meta font-semibold text-ink">
            AI 연결 · <span className={TONE_TEXT[def.tone]}>{def.label}</span>
          </p>
          <p className="mt-1 text-meta text-ink-2">{EXPLAIN[state]}</p>
          {mode === "B" ? (
            <p className="mt-1 text-meta text-ink-2">방식 B는 이 프로젝트 자료를 AI 연결로 보내지 않음 — 내 컴퓨터의 AI가 PES를 거쳐 읽습니다.</p>
          ) : null}
          {warn ? (
            <div className="mt-2 space-y-1 rounded-md border border-warn-line bg-warn-soft px-3 py-2 text-meta text-ink">
              <p>이미 나간 자료는 회수 보장 없음 — AI가 이미 읽은 자료는 되돌릴 수 없습니다.</p>
              <p>재허용해도 자동 재시작 없음 — 사람이 직접 다시 시작해야 합니다.</p>
            </div>
          ) : null}
          {dispatches.length ? (
            <div className="mt-2">
              <p className="text-caption font-medium text-ink-2">나간 전송</p>
              <ul className="mt-1 space-y-0.5">
                {dispatches.map((d) => (
                  <li key={d.id} data-dispatch={d.id} data-state={d.state} className="text-meta text-ink">
                    전송 {d.id} · {dispatchLabel(d.state)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}
    </>
  );
}
