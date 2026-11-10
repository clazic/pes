import { useSyncExternalStore } from "react";
import type { Role } from "@/api/types";

/**
 * 시안 조작(제품 기능이 아님): 검토하는 사람이 역할·네트워크·충돌·갱신 통로를 바꿔 상태를 직접 본다.
 * 같은 탭에만 남는다(sessionStorage).
 */
export interface MockSettings {
  role: Role;
  /** normal: 빠름 · slow: 응답이 늦어 “접수 확인 중” · lost: 서버는 처리했는데 응답이 유실(결과 미확인) · offline: 보내기 전 끊김 */
  network: "normal" | "slow" | "lost" | "offline";
  /** 다음 제출을 버전 충돌로 */
  nextSubmit: "ok" | "conflict";
  /** 변경 알림 통로: live(실시간) · slow(긴 대기 30초) */
  channel: "live" | "slow";
  /** 다음 변경분 읽기에서 커서 무효를 흉내 */
  resyncNext: boolean;
  /**
   * UI7-4b 시험용: 이 제안 id 의 decision.record(verdict accept) 한 건을 버전 충돌로 거절한다(저장소 불변).
   * null 이면 끔. reset() 은 null 로 되돌린다.
   */
  failAssumption: string | null;
  /**
   * 점선 “시안 설명” 상자 보이기. 3차 정리(정보 밀도)부터 기본은 숨김 — 머리줄 “시안” 단추의 판에서 켠다.
   * (예전 필드 notes: "show"|"hide"는 읽지 않는다 — 탭에 남은 옛 값이 새 기본을 덮지 않게)
   */
  showNotes: boolean;
}

const KEY = "pes-mock-settings";
const DEFAULTS: MockSettings = { role: "owner", network: "normal", nextSubmit: "ok", channel: "live", resyncNext: false, failAssumption: null, showNotes: false };

function read(): MockSettings {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<MockSettings>) };
  } catch {
    /* 저장소를 못 쓰면 기본값 */
  }
  return DEFAULTS;
}

let current: MockSettings = typeof sessionStorage === "undefined" ? DEFAULTS : read();
const listeners = new Set<() => void>();

export const mockSettings = {
  get: () => current,
  set(patch: Partial<MockSettings>) {
    current = { ...current, ...patch };
    try {
      sessionStorage.setItem(KEY, JSON.stringify(current));
    } catch {
      /* 무시 */
    }
    listeners.forEach((l) => l());
  },
  reset() {
    this.set(DEFAULTS);
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

export function useMockSettings(): MockSettings {
  return useSyncExternalStore(mockSettings.subscribe, mockSettings.get, mockSettings.get);
}

export const ROLE_LABEL: Record<Role, string> = { owner: "소유자", editor: "편집자", reader: "읽기 멤버" };
export const ROLE_PERSON: Record<Role, string> = { owner: "김연구", editor: "박검토", reader: "이열람" };

/* ───────── 화면 읽기 프로그램 알림(사람이 할 일이 생긴 사건만, polite) ───────── */

let liveText = "";
const liveListeners = new Set<() => void>();
export const live = {
  announce(text: string) {
    // 같은 문장을 다시 읽게 하려고 한 번 비운다
    liveText = "";
    liveListeners.forEach((l) => l());
    window.setTimeout(() => {
      liveText = text;
      liveListeners.forEach((l) => l());
    }, 60);
  },
  get: () => liveText,
  subscribe(l: () => void) {
    liveListeners.add(l);
    return () => liveListeners.delete(l);
  },
};
export function useLiveText() {
  return useSyncExternalStore(live.subscribe, live.get, live.get);
}

/**
 * 차례 전환 알림의 기준점(시안 전용). “목 자료 처음으로”는 차례를 한꺼번에 되돌리므로 그 변화를 전환으로 읽지 않게
 * 기준점 번호를 올린다(TurnAnnouncer가 번호가 바뀌면 알리지 않고 새 기준만 잡음).
 */
export const turnBaseline = {
  epoch: 0,
  bump() {
    this.epoch += 1;
  },
};
