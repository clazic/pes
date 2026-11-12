import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { WORKSPACE } from "@/api/fixture";
import { FORMAT_VERSION, type PesClient, type WorkspaceView } from "@/api/types";
import { renderApp, type Env } from "@/test/render-app";
import { createScriptedClient } from "@/test/scripted-client";
import { CURRENT } from "@/test/contract";
import { ready } from "@/test/ui";

/**
 * SEL-84 U1d 시험 계약 — AI 연결 칩 · 상태 구분(과거 승인 · stale · 중단/취소/인계 · 실행 권한 · 기록 없음).
 * 이슈 문구(stage-3.md U1 체크리스트, stage-1-ui.md F06·F07·69행, stage-3.md 62·78·90행)에서 뽑은 해석이다. 구현을 추측해서 맞춘 것이 아니다.
 * 이름을 바꿔야 하면 구현이 아니라 이 파일(과 보고서의 해석)을 고치고 leader 에게 알린다. 합성 자료뿐(실제 자료·키·경로 없음).
 *
 * [읽기 모양 — WorkspaceView 의 선택 칸(전부 optional). 가짜 클라이언트와 HTTP 클라이언트가 같은 모양을 돌려준다(기계 값만, 화면 글자는 앱이 만든다)]
 *   ai_connection?: { policy, dispatches? }
 *     policy: "allowed" | "denied" | "missing" | "corrupt" | "pending"   (project_policy_versions 읽기 — 확정 전 = pending)
 *     dispatches[]: { id, run_id, state: "sent" | "cancel_requested" | "cancelled" | "unknown" }   (outbound_dispatches 읽기)
 *   stages[].past_approval?: { at: IsoTime | null, origin: "verified" | "legacy_unverified" }   (view 는 "stale" 이어도 과거 승인이 따로 실린다)
 *   runs?: { id, stage, mode: "A" | "B", status: "running" | "queued" | "waiting_human" | "interrupted" | "cancelled" | "handed_off" | "failed" | "succeeded",
 *            external_stop?: "pending" | "confirmed" | "failed" | "unknown" }[]
 *   run_permissions?: { id, run_id, source: "pes_tool" | "external_app", kind: "question" | "permission", text, state: "waiting" | "answered" }[]
 *   records?: { assumptions: {count}, decisions: {count}, comments: {count}, empty: boolean }   (서버 작업 공간 읽기에 이미 있다)
 *
 * [화면 계약]
 *   - AI 연결 칩: 문서에 정확히 하나, <button> 이름이 "AI 연결"로 시작하고 상태 낱말이 든다(색만으로 알리지 않음): 켜짐 | 차단 중 | 변경 중 | unknown(또는 "알 수 없음").
 *     data-state = on | blocked | changing | unknown. aria-expanded + aria-controls → 누르면(Enter · Space) region "AI 연결 상태" 가 열리고 Esc 로 닫으면 초점이 칩으로 돌아온다.
 *     화면 문구에 낱말 'Go' 는 없다(보이는 글 · aria-label · title 모두) — 'API' · 'AI 연결'로 쓴다.
 *     매핑: allowed → 켜짐 · denied/missing/corrupt → 차단 중 · pending → 변경 중 · ai_connection 없음 또는 모르는 값 → unknown (모르면 켜짐이라 하지 않는다 — 설계 P4).
 *   - region "AI 연결 상태": 차단 중이거나 보낸 자료가 있으면 "이미 나간 자료는 회수 보장 없음" 과 "재허용 뒤 자동 재시작 없음" 안내. 방식 B 는 "AI 연결로 보내지 않음" 설명.
 *     진행 중 전송 목록: 항목 [data-dispatch="<id>"][data-state]. cancel_requested → "취소 시도", unknown → "unknown"(또는 "알 수 없음"), 서로 다른 글.
 *   - region "실행": 실행 목록 항목 [data-run="<id>"][data-status]. 중단됨 · 취소됨 · 인계됨 은 서로 다른 낱말이고 각 실행은 자기 낱말만 쓴다.
 *     그 안의 group "실행 권한": 외부 앱의 질문/권한([data-permission="<id>"], source 별 "외부 앱" / "PES"). 연구 질문(질문 영역 aside)과 서로 섞이지 않는다.
 *   - region "기록": 행 [data-record="assumptions|decisions|comments"] — 개수 0 이면 "기록 없음", 있으면 개수(그리고 "기록 없음" 아님).
 *   - 단계 링크(사이드바 "연구 흐름"): 승인된 뒤 stale 이면 "과거 승인"과 "앞 단계 변경"(상태 사전 stale 이름)이 함께. origin legacy_unverified 는 "검증 안 됨"이 붙는다.
 */

export type Wire = Record<string, unknown>;

const stamp = "2026-11-01T09:00:00+09:00";

/** 합성 작업 공간 + 덧씌움 */
export const ws = (patch: Wire = {}): WorkspaceView => ({ ...structuredClone(WORKSPACE), ...patch }) as unknown as WorkspaceView;

export const aiOn = { policy: "allowed" };
export const withAi = (ai: Wire | undefined, extra: Wire = {}) => ws({ ...(ai ? { ai_connection: ai } : {}), ...extra });

/** 과거 승인 + stale: 기획(plan) 단계가 승인된 뒤 앞 단계 변경으로 stale */
export function staleAfterApproval(origin: "verified" | "legacy_unverified" = "verified"): WorkspaceView {
  const base = structuredClone(WORKSPACE);
  const stages = base.stages.map((s) => (s.key === "plan" ? { ...s, view: "stale" as const, past_approval: { at: stamp, origin } } : s));
  return { ...base, stages, ai_connection: aiOn } as unknown as WorkspaceView;
}

/** 이전된 합성 프로젝트: 가정·결정·의견 없음, legacy_unverified 승인 */
export function migratedSynthetic(): WorkspaceView {
  const base = structuredClone(WORKSPACE);
  const stages = base.stages.map((s) => (s.key === "plan" ? { ...s, past_approval: { at: null, origin: "legacy_unverified" } } : s));
  return {
    ...base,
    stages,
    ai_connection: { policy: "allowed" },
    records: { assumptions: { count: 0 }, decisions: { count: 0 }, comments: { count: 0 }, empty: true },
  } as unknown as WorkspaceView;
}

export const RUNS = [
  { id: "run-int", stage: "research", mode: "A", status: "interrupted", external_stop: "unknown" },
  { id: "run-can", stage: "research", mode: "A", status: "cancelled", external_stop: "confirmed" },
  { id: "run-hand", stage: "research", mode: "A", status: "handed_off" },
];

export const PERMISSIONS = [
  { id: "perm-ext-q", run_id: "run-b1", source: "external_app", kind: "question", text: "외부 앱이 합성 폴더를 읽어도 되는지 묻습니다", state: "waiting" },
  { id: "perm-ext-p", run_id: "run-b1", source: "external_app", kind: "permission", text: "외부 앱이 합성 명령 실행 권한을 요청합니다", state: "waiting" },
  { id: "perm-pes", run_id: "run-a1", source: "pes_tool", kind: "permission", text: "PES 업무 도구 승인을 기다립니다", state: "waiting" },
];

/* ───────────── 화면 찾기 ───────────── */

export const chipButton = () => screen.getByRole("button", { name: /^AI 연결/ });
export const chipState = () => chipButton().getAttribute("data-state");
export const statePanel = () => screen.queryByRole("region", { name: "AI 연결 상태" });
export const runPanel = () => screen.getByRole("region", { name: "실행" });
export const recordPanel = () => screen.getByRole("region", { name: "기록" });
export const stageLink = (name: RegExp) => within(screen.getByRole("navigation", { name: /연구 흐름/ })).getAllByRole("link").find((a) => name.test(a.textContent ?? "") || name.test(a.getAttribute("aria-label") ?? ""));

export const UNKNOWN = /unknown|알 수 없음/i;
export const RECALL = /이미 나간 자료.*회수.*보장 없음/;
export const NO_RESTART = /재허용.*자동 재시작.*없/;

/** 보이는 글 · aria-label · title 에 낱말 'Go' 가 없다 */
export function goWordsIn(root: HTMLElement = document.body): string[] {
  const found: string[] = [];
  const texts = [root.textContent ?? "", ...[...root.querySelectorAll("[aria-label],[title],[alt]")].flatMap((e) => [e.getAttribute("aria-label"), e.getAttribute("title"), e.getAttribute("alt")])];
  for (const t of texts) if (t && /\bGo\b/.test(t)) found.push(t);
  return found;
}

/* ───────────── 클라이언트 둘 ───────────── */

/** 가짜 클라이언트 경로: 작업 공간 읽기만 시험 값으로 바꿔 끼운다(나머지는 가짜 클라이언트 그대로). current() 로 값을 바꾸면 다음 읽기에 반영 */
export function fakeBoot(initial: WorkspaceView) {
  let current = initial;
  const s = createScriptedClient();
  const client = { ...s.client, getWorkspace: async () => structuredClone(current) } as unknown as PesClient;
  return {
    s,
    client,
    set: (next: WorkspaceView) => void (current = next),
    async open(path = CURRENT, env: Env = {}) {
      // 가짜 시계를 쓰는 시험 파일에서만 advanceTimers 를 넘긴다. 실제 시계인 파일(parity)에서
      // user-event 가 vi.advanceTimersByTime 을 부르면 "timers APIs are not mocked" 로 죽는다(시험 도구 버그)
      const user = userEvent.setup(vi.isFakeTimers() ? { advanceTimers: vi.advanceTimersByTime } : {});
      const app = await renderApp(path, { width: 1440, ...env }, { client });
      await ready();
      return { user, ...app };
    },
  };
}

const SLUG = "sample-study";
const ID = "pj-u1d-1";

/** HTTP 클라이언트 경로: 서버가 같은 모양을 준다(fetch 는 가짜 서버). 서버 현재 모양(칸 없음)도 이렇게 시험한다 */
export function stubServerWith(data: WorkspaceView | Wire) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input instanceof Request ? input.url : input), window.location.href);
      if (url.pathname === `/api/v1/projects/${ID}/workspace`) return new Response(JSON.stringify({ format_version: FORMAT_VERSION, request_id: "r1", data }), { status: 200 });
      return new Response(JSON.stringify({ format_version: FORMAT_VERSION, error: { code: "not_found", message: "없음", retryable: false, target: null, details: null, next_action: "reread_context" }, request_id: "r2" }), { status: 404 });
    }),
  );
  (window as unknown as Record<string, unknown>).__PES_APP__ = { api: "http", session: "synthetic-session-u1d", projects: { [SLUG]: ID } };
}
export function unstubServer() {
  vi.unstubAllGlobals();
  delete (window as unknown as Record<string, unknown>).__PES_APP__;
}
export async function httpBoot(data: WorkspaceView | Wire, path = CURRENT, env: Env = {}) {
  stubServerWith(data);
  const app = await renderApp(path, { width: 1440, ...env });
  await ready();
  return { user: userEvent.setup(), ...app };
}

export const settle = (fn: () => void) => waitFor(fn);
