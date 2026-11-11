/**
 * 시안에서 바꿔 볼 수 있는 테마 4개 — 모두 tweakcn 공개 테마 레지스트리에서 shadcn CLI(`view`)로 받은 것.
 * CSS는 같은 폴더의 <id>.css(테마별 클래스 `.theme-<id>`, 어두운 모드 `.theme-<id>.dark`).
 * 글꼴은 테마와 상관없이 Pretendard. 상태 색·방식 색은 pes.css 한 곳(테마마다 바꾸지 않음).
 */
export type ThemeId = "modern-minimal" | "vercel" | "graphite" | "clean-slate";
export type ColorMode = "light" | "dark" | "system";

export interface ThemeInfo {
  id: ThemeId;
  /** tweakcn 레지스트리의 이름 그대로 */
  name: string;
  /** 한 줄 느낌(메뉴에 보임) */
  note: string;
  source: string;
}

export const THEMES: ThemeInfo[] = [
  { id: "modern-minimal", name: "Modern Minimal", note: "흰 바탕 · 파랑 강조", source: "tweakcn.com/r/themes/modern-minimal.json" },
  { id: "vercel", name: "Vercel", note: "흑백 · 검정 강조", source: "tweakcn.com/r/themes/vercel.json" },
  { id: "graphite", name: "Graphite", note: "회색 바탕 · 짙은 회색 강조", source: "tweakcn.com/r/themes/graphite.json" },
  { id: "clean-slate", name: "Clean Slate", note: "푸른 회색 · 남보라 강조", source: "tweakcn.com/r/themes/clean-slate.json" },
];

export const THEME_SOURCE_NOTE = "테마 출처 tweakcn(Apache-2.0) · 글꼴 Pretendard 고정";
export const DEFAULT_THEME: ThemeId = "modern-minimal";
export const MODE_LABEL: Record<ColorMode, string> = { light: "밝게", dark: "어둡게", system: "시스템 따라" };
