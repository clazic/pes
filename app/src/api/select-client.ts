import { createFakeClient } from "./fake-client";
import { createHttpClient } from "./http-client";
import type { PesClient } from "./types";

/**
 * 클라이언트 고르기(U1b) — 가짜가 기본이다. `window.__PES_APP__ = { api: "http", session, projects }` 가 있을 때만 실제 HTTP 클라이언트:
 *  - api 가 정확히 "http" 가 아니면 가짜(오타가 실제 요청이 되지 않는다).
 *  - api 가 "http" 인데 session·projects 가 모양이 틀리면 빈 설정의 실제 클라이언트(모든 slug 가 '찾을 수 없음' · 요청 0) — 서버 모드에서 합성 자료로 되돌아가지 않는다.
 * 세션 값은 이 설정으로만 들어온다. 서버는 앱 페이지에 세션을 심지 않는다(다른 출처로 새지 않게) — 앱을 여는 쪽이 넘긴다.
 */
export function selectClient(win: unknown, fetchImpl?: typeof fetch): PesClient {
  const config = typeof win === "object" && win !== null ? (win as { __PES_APP__?: unknown }).__PES_APP__ : undefined;
  if (typeof config !== "object" || config === null || (config as { api?: unknown }).api !== "http") return createFakeClient();
  const { session, projects } = config as { session?: unknown; projects?: unknown };
  const map: Record<string, string> = {};
  if (typeof projects === "object" && projects !== null && !Array.isArray(projects)) {
    for (const [slug, id] of Object.entries(projects)) if (typeof id === "string" && id !== "") map[slug] = id;
  }
  return createHttpClient({ session: typeof session === "string" ? session : "", projects: map, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
}
