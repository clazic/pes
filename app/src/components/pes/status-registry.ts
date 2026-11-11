/**
 * 상태 사전 — 승인 시안(docs/plan/mockups/dashboard-v2-react/src/components/pes/status-registry.ts, 설계 3.4 · 6절)에서
 * U1a 가 쓰는 영역(단계 · 차례)만 그대로 옮겼다. 같은 상태는 어느 화면에서나 같은 모양·글자·색이다(설계 P2).
 * 화면은 이 사전 밖의 상태 이름을 만들지 않는다. 다른 영역은 쓰는 이슈에서 시안 그대로 옮긴다.
 */

export type Shape = "circle" | "ring" | "diamond" | "tri" | "square" | "hsquare" | "dotring" | "pause" | "dash";
export type Tone = "ok" | "run" | "you" | "warn" | "bad" | "off" | "unk";

export interface StatusDef {
  label: string;
  shape: Shape;
  tone: Tone;
  /** 근거(필드·사건). 영어 코드는 근거에만 쓴다 */
  basis?: string;
}

const d = (label: string, shape: Shape, tone: Tone, basis?: string): StatusDef => ({ label, shape, tone, basis });

export const STATUS = {
  stage: {
    pending: d("시작 전", "dash", "off", "stages.status = pending"),
    asking: d("시작 질문 중", "diamond", "you", "asking"),
    current_you: d("현재 · 나의 할 일", "diamond", "you", "active + 사람 차례"),
    current_ai: d("현재 · AI 작업 중", "ring", "run", "active + AI 쪽 차례(실행이 담당을 잡음)"),
    current_blocked: d("현재 · 막힘", "square", "bad", "active + 사용량 멈춤 등"),
    approved: d("승인됨", "circle", "ok", "approved"),
    stale: d("앞 단계 변경 — 확인 필요", "tri", "warn", "앞 단계 다시 열기(stale)"),
  },
  // 차례(설계 15절): 누가 움직일 차례인가
  turn: {
    you: d("나의 할 일", "diamond", "you", "지금 이 사람이 할 수 있는 일이 있음 — 서버가 사람·권한별로 셈"),
    ai: d("AI 작업 중", "ring", "run", "실행이 담당을 잡고 진행 + 진행 소식이 시험값 안"),
    ai_quiet: d("AI 작업 중 · 소식 없음", "dotring", "unk", "담당은 유효하지만 마지막 소식이 시험값을 넘음"),
    waiting: d("기다림", "pause", "off", "다른 사람이나 시각을 기다림 — 내 할 일 아님"),
    done: d("끝남", "circle", "ok", "판 완료 · 누구의 할 일도 없음"),
  },
} as const satisfies Record<string, Record<string, StatusDef>>;

export type StatusDomain = keyof typeof STATUS;

export function lookup(domain: StatusDomain, value: string): StatusDef {
  const def = (STATUS[domain] as Record<string, StatusDef>)[value];
  // 모르는 값은 ‘미상’(설계 P4: 모르면 모른다고). 허용·정상으로 해석하지 않는다
  return def ?? { label: `미상(${value})`, shape: "dotring", tone: "unk" };
}
