import * as React from "react";
import { DEFAULT_THEME, THEMES, type ColorMode, type ThemeId } from "@/themes/themes";

/**
 * 테마 고르기(시안) — 고른 값은 이 브라우저의 localStorage에만 남는다(서버에 보내지 않음).
 * <html>에 `theme-<id>` 클래스와 어두운 모드면 `dark` 클래스를 붙인다. 첫 그림 전에 main.tsx가 한 번 적용한다.
 * 인쇄할 때는 잠시 밝은 모드로 바꿨다가 되돌린다(흰 종이에 밝은 글자가 나가지 않게).
 */
const KEY = "pes-mock-theme";

export interface ThemeChoice {
  theme: ThemeId;
  mode: ColorMode;
}

const isTheme = (v: unknown): v is ThemeId => THEMES.some((t) => t.id === v);
const isMode = (v: unknown): v is ColorMode => v === "light" || v === "dark" || v === "system";

function read(): ThemeChoice {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<ThemeChoice> | null;
    return { theme: isTheme(raw?.theme) ? raw.theme : DEFAULT_THEME, mode: isMode(raw?.mode) ? raw.mode : "light" };
  } catch {
    return { theme: DEFAULT_THEME, mode: "light" };
  }
}

const darkQuery = () => window.matchMedia("(prefers-color-scheme: dark)");
let current: ThemeChoice = { theme: DEFAULT_THEME, mode: "light" };
let printing = false;
const listeners = new Set<() => void>();

export function resolvedDark(c: ThemeChoice = current) {
  return c.mode === "dark" || (c.mode === "system" && darkQuery().matches);
}

function apply() {
  const html = document.documentElement;
  for (const t of THEMES) html.classList.toggle(`theme-${t.id}`, t.id === current.theme);
  html.classList.toggle("dark", !printing && resolvedDark());
  html.dataset.theme = current.theme;
  html.dataset.mode = current.mode;
}

function emit() {
  for (const l of listeners) l();
}

export const themeStore = {
  get: () => current,
  set(p: Partial<ThemeChoice>) {
    current = { ...current, ...p };
    try {
      localStorage.setItem(KEY, JSON.stringify(current));
    } catch {
      /* 저장 못 해도 이 탭에서는 바뀜 */
    }
    apply();
    emit();
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

/** 첫 그림 전에 한 번 — 저장된 테마 적용 · 시스템 모드 변화 · 인쇄 */
export function initTheme() {
  current = read();
  apply();
  darkQuery().addEventListener("change", () => {
    if (current.mode === "system") {
      apply();
      emit();
    }
  });
  window.addEventListener("beforeprint", () => {
    printing = true;
    apply();
  });
  window.addEventListener("afterprint", () => {
    printing = false;
    apply();
  });
  // 다른 탭에서 바꾸면 따라간다
  window.addEventListener("storage", (e) => {
    if (e.key === KEY) {
      current = read();
      apply();
      emit();
    }
  });
}

export function useTheme() {
  const choice = React.useSyncExternalStore(themeStore.subscribe, themeStore.get, themeStore.get);
  return { ...choice, dark: resolvedDark(choice), set: themeStore.set };
}
