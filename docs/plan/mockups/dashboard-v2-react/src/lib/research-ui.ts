import * as React from "react";
import type { WorkspaceView } from "@/api/types";

/**
 * 단계 승인을 막는 것 — 개요 · 지금 할 일 · 승인 카드가 같은 수를 보이도록 한곳에서 센다.
 * 막힌 것 “필수 질문 미응답”이 있으면 승인 사유의 “필수 답 … 없음”은 같은 일이라 한 번만 센다.
 */
export function approvalBlockers(ws: WorkspaceView) {
  const blocking = ws.problems.filter((p) => p.blocks.includes("단계 승인"));
  const hasRequired = blocking.some((p) => p.kind === "required_question");
  const reasons = ws.approval.reasons.filter((r) => !(hasRequired && r.startsWith("필수")));
  return { reasons, blocking, total: reasons.length + blocking.length };
}

/**
 * 연구 공간(5차, 설계 16절)의 화면 설정 — 사람마다의 편의라 이 브라우저에만 남는다(서버에 보내지 않음).
 * - 집중 모드: 이 탭에만(sessionStorage) — 다음에 열 때 뜻밖에 사이드 칸이 접혀 있지 않게
 * - 한 글자 단축키(J/K) 켜기 · 넓은 화면의 AI 동료 칸 보이기: 이 브라우저(localStorage)
 * 저장소를 못 쓰면(사생활 보호 창 등) 기본값으로 동작한다.
 */
export interface ResearchUi {
  /** 집중 모드 — 사이드 칸을 접고 가운데 한 가지 일만 */
  focus: boolean;
  /** J/K 한 글자 단축키 — 집중 모드에서만 동작하고 끌 수 있다(WCAG 2.1.4) */
  jk: boolean;
  /** 넓은 화면(1280px 이상)에서 오른쪽 AI 동료 칸을 보인다 */
  aiPanel: boolean;
  /** 지금 할 일(라운드) 화면에서는 AI 동료 칸을 접어 두고 한 줄 요약만 — 펼치면 이 탭에서는 계속 펼침(sessionStorage) */
  aiOnRound: boolean;
}

const SESSION_KEY = "pes-research-focus";
const SESSION_AI_ROUND = "pes-research-ai-round";
const LOCAL_KEY = "pes-research-ui";
const DEFAULTS: ResearchUi = { focus: false, jk: true, aiPanel: true, aiOnRound: false };

function read(): ResearchUi {
  let v = { ...DEFAULTS };
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<ResearchUi>;
      v = { ...v, jk: p.jk ?? v.jk, aiPanel: p.aiPanel ?? v.aiPanel };
    }
  } catch {
    /* 기본값 */
  }
  try {
    v.focus = sessionStorage.getItem(SESSION_KEY) === "1";
    v.aiOnRound = sessionStorage.getItem(SESSION_AI_ROUND) === "1";
  } catch {
    /* 기본값 */
  }
  return v;
}

let current: ResearchUi = typeof window === "undefined" ? DEFAULTS : read();
const listeners = new Set<() => void>();

export const researchUi = {
  get: () => current,
  set(patch: Partial<ResearchUi>) {
    current = { ...current, ...patch };
    try {
      localStorage.setItem(LOCAL_KEY, JSON.stringify({ jk: current.jk, aiPanel: current.aiPanel }));
    } catch {
      /* 무시 */
    }
    try {
      sessionStorage.setItem(SESSION_KEY, current.focus ? "1" : "0");
      sessionStorage.setItem(SESSION_AI_ROUND, current.aiOnRound ? "1" : "0");
    } catch {
      /* 무시 */
    }
    listeners.forEach((l) => l());
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

export function useResearchUi(): ResearchUi {
  return React.useSyncExternalStore(researchUi.subscribe, researchUi.get, researchUi.get);
}

/* ───────── 좁은 화면(1280px 미만)의 AI 동료 판 · 결과 글에서 고른 곳 ───────── */

interface AiSheet {
  open: boolean;
  /** 결과 글에서 고른 곳(“문단 2”) — AI 동료의 “부탁할 곳” 기본값 */
  target: string | null;
  /** 바꿀 때마다 올라가는 번호(같은 곳을 다시 골라도 칸이 다시 받게) */
  nonce: number;
}
let sheet: AiSheet = { open: false, target: null, nonce: 0 };
/** AI 동료 칸이 이미 받아 처리한 nonce — 칸이 접혀 있다가 “AI에게 부탁”으로 새로 그려져도 그 부탁을 받게(18.2, F1) */
let handledNonce = 0;
const sheetListeners = new Set<() => void>();
export const aiSheet = {
  get: () => sheet,
  set(patch: Partial<AiSheet>) {
    sheet = { ...sheet, ...patch };
    sheetListeners.forEach((l) => l());
  },
  /** 결과 글에서 “AI에게 부탁”을 누름 — 넓은 화면은 칸을 보이고, 좁은 화면은 판을 연다 */
  ask(target: string | null) {
    const wide = typeof window !== "undefined" && window.matchMedia("(min-width: 1280px)").matches;
    // 넓은 화면: 칸을 보이고, 지금 할 일 · 단계 결과에서 접혀 있으면 펼친다(이 탭 기억도 펼침으로 — 18.2)
    if (wide) researchUi.set({ aiPanel: true, focus: false, aiOnRound: true });
    sheet = { open: !wide, target, nonce: sheet.nonce + 1 };
    sheetListeners.forEach((l) => l());
  },
  /** 아직 처리하지 않은 부탁인가 */
  pending: (nonce: number) => nonce > handledNonce,
  /** 처리한 것으로 표시(초점을 실제로 준 뒤에 — 개발 모드의 effect 두 번 실행에도 한 번은 초점이 가게) */
  done(nonce: number) {
    if (nonce > handledNonce) handledNonce = nonce;
  },
  subscribe(l: () => void) {
    sheetListeners.add(l);
    return () => sheetListeners.delete(l);
  },
};
export function useAiSheet(): AiSheet {
  return React.useSyncExternalStore(aiSheet.subscribe, aiSheet.get, aiSheet.get);
}

/**
 * 방금 보낸 답 — 보낸 뒤 화면이 다른 단계로 슬쩍 바뀌지 않게, 같은 자리에 “보냄” 확인을 보이는 데 쓴다.
 * 다른 단계로 옮기면 지운다(이 탭에서만, 저장하지 않음).
 */
export interface AnswersSent {
  slug: string;
  receipt_no: string;
  count: number;
}
let sentNote: AnswersSent | null = null;
const sentListeners = new Set<() => void>();
export const answersSent = {
  get: () => sentNote,
  set(v: AnswersSent | null) {
    sentNote = v;
    sentListeners.forEach((l) => l());
  },
  subscribe(l: () => void) {
    sentListeners.add(l);
    return () => sentListeners.delete(l);
  },
};
export function useAnswersSent(): AnswersSent | null {
  return React.useSyncExternalStore(answersSent.subscribe, answersSent.get, answersSent.get);
}

/** 1280px 이상(설계 3.8 desk) — 오른쪽 AI 동료 칸을 둘 수 있는 폭 */
export function useIsDesk() {
  const q = "(min-width: 1280px)";
  const [m, setM] = React.useState(() => typeof window !== "undefined" && window.matchMedia(q).matches);
  React.useEffect(() => {
    const mq = window.matchMedia(q);
    const on = () => setM(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return m;
}

/* ───────── 마지막 위치(프로젝트마다) — “이어서 하기” ───────── */

export interface LastLocation {
  path: string;
  label: string;
  /** 사람이 읽는 시각(hh:mm) */
  at: string;
}
const lastKey = (slug: string) => `pes-last-location:${slug}`;
const lastListeners = new Set<() => void>();
const lastCache = new Map<string, LastLocation | null>();

export function readLastLocation(slug: string): LastLocation | null {
  if (lastCache.has(slug)) return lastCache.get(slug) ?? null;
  let v: LastLocation | null = null;
  try {
    const raw = localStorage.getItem(lastKey(slug));
    if (raw) v = JSON.parse(raw) as LastLocation;
  } catch {
    v = null;
  }
  lastCache.set(slug, v);
  return v;
}

export function saveLastLocation(slug: string, loc: Omit<LastLocation, "at">) {
  const d = new Date();
  const at = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const prev = readLastLocation(slug);
  if (prev && prev.path === loc.path && prev.label === loc.label) return;
  const v = { ...loc, at };
  lastCache.set(slug, v);
  try {
    localStorage.setItem(lastKey(slug), JSON.stringify(v));
  } catch {
    /* 이 탭에서만 기억 */
  }
  lastListeners.forEach((l) => l());
}

export function useLastLocation(slug: string): LastLocation | null {
  return React.useSyncExternalStore(
    (l) => {
      lastListeners.add(l);
      return () => lastListeners.delete(l);
    },
    () => readLastLocation(slug),
    () => readLastLocation(slug),
  );
}

/* ───────── 키보드: J/K(다음·이전 항목) · Esc(집중 모드 끝내기) ───────── */

const TYPING = "input, textarea, select, [contenteditable='true'], [role='textbox'], [role='combobox']";
const OVERLAY = "[role='dialog'][data-state='open'], [role='alertdialog'][data-state='open'], [role='menu'][data-state='open'], [role='listbox'][data-state='open'], [data-slot='popover-content'][data-state='open']";

function visible(el: HTMLElement) {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
}

/** 가운데 칸의 항목(data-jk) 사이를 옮긴다. 끝에서 J를 누르면 “다음 할 일” 단추(data-jk-next)로 */
export function moveJk(dir: 1 | -1) {
  const items = [...document.querySelectorAll<HTMLElement>("#main [data-jk]")].filter(visible);
  const nextBtn = document.querySelector<HTMLElement>("#main [data-jk-next]");
  if (!items.length && !nextBtn) return;
  const cur = document.activeElement as HTMLElement | null;
  const i = items.findIndex((el) => el === cur || (cur ? el.contains(cur) : false));
  let target: HTMLElement | undefined;
  if (i < 0) target = dir === 1 ? (items[0] ?? nextBtn ?? undefined) : (items[items.length - 1] ?? undefined);
  else if (i + dir >= items.length) target = nextBtn ?? items[items.length - 1];
  else target = items[Math.max(0, i + dir)];
  if (!target) return;
  if (!target.matches("a[href], button, input, textarea, select, [tabindex]")) target.setAttribute("tabindex", "-1");
  target.focus({ preventScroll: true });
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  target.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
}

/**
 * 연구 공간에서만 켠다. J/K는 집중 모드 + 한 글자 단축키 켜짐일 때만, 입력 중 · 한글 조합 중 · 대화 상자·메뉴가 열렸을 때는 무시한다.
 * Esc는 열린 것이 없을 때만 집중 모드를 끝낸다(대화 상자의 Esc를 가로채지 않음).
 */
export function useResearchKeys(active: boolean) {
  React.useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229 || e.defaultPrevented) return;
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const t = e.target as HTMLElement | null;
      const typing = Boolean(t?.closest?.(TYPING));
      const overlay = Boolean(document.querySelector(OVERLAY));
      const ui = researchUi.get();
      if (e.key === "Escape") {
        if (!ui.focus || typing || overlay) return;
        e.preventDefault();
        researchUi.set({ focus: false });
        return;
      }
      if (!ui.focus || !ui.jk || typing || overlay || e.shiftKey) return;
      // 한글 자판 상태에서도 같은 자리(KeyJ · KeyK)로 동작
      if (e.code !== "KeyJ" && e.code !== "KeyK") return;
      e.preventDefault();
      moveJk(e.code === "KeyJ" ? 1 : -1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);
}

