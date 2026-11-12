import { createFakeClient } from "./fake-client";
import { DEMO_WORKSPACE } from "./fixture";
import { createHttpClient } from "./http-client";
import type { PesClient } from "./types";

/**
 * 클라이언트 고르기(U1b) — `window.__PES_APP__ = { api: "http", session, projects }` 가 있으면 실제 HTTP 클라이언트:
 *  - api 가 "http" 인데 session·projects 가 모양이 틀리면 빈 설정의 실제 클라이언트(모든 slug 가 '찾을 수 없음' · 요청 0) — 서버 모드에서 합성 자료로 되돌아가지 않는다.
 *  - 설정이 없거나 api 가 "http" 가 아니면 가짜 클라이언트(합성 자료) — **production 빌드가 아닐 때만**(vite dev · vitest · `--mode e2e` 시험 빌드).
 *    production 빌드는 null 을 돌려주고, 화면은 `pes open <프로젝트> --app` 안내를 그린다(가짜 자료도 /api 요청도 없다). 빌드 때 상수로 접혀 가짜 클라이언트 코드가 production 번들에서 빠진다.
 * 세션 값은 이 설정으로만 들어온다(main.tsx 가 takeHandoff 로 채움). 서버는 앱 페이지에 세션을 심지 않는다.
 */
export function selectClient(win: unknown, fetchImpl?: typeof fetch): PesClient | null {
  const config = typeof win === "object" && win !== null ? (win as { __PES_APP__?: unknown }).__PES_APP__ : undefined;
  if (typeof config !== "object" || config === null || (config as { api?: unknown }).api !== "http") return import.meta.env.MODE !== "production" ? createFakeClient(DEMO_WORKSPACE) : null;
  const { session, projects } = config as { session?: unknown; projects?: unknown };
  const map: Record<string, string> = {};
  if (typeof projects === "object" && projects !== null && !Array.isArray(projects)) {
    for (const [slug, id] of Object.entries(projects)) if (typeof id === "string" && id !== "") map[slug] = id;
  }
  return createHttpClient({ session: typeof session === "string" ? session : "", projects: map, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
}
