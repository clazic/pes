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
  // AI 연결(U1d · F07): project_policy_versions 읽기. 모르는 값은 켜짐(허용)으로 읽지 않는다(설계 P4)
  ai: {
    on: d("켜짐", "circle", "ok", "정책 = 허용"),
    blocked: d("차단 중", "square", "bad", "정책 막음·누락·손상 — 보내지 않음"),
    changing: d("변경 중", "tri", "warn", "정책 확정 전 — 새 전송 없음"),
    unknown: d("알 수 없음", "dotring", "unk", "서버가 AI 연결 칸을 보내지 않음 — 허용으로 해석하지 않음"),
  },
  // 질문(U2b): 닫힌 질문은 지우지 않고 이름으로 남는다 — 철회 · 보류 · 합침은 서로 다른 말(시안 question 영역, 화면 글자는 “~됨”으로 통일)
  question: {
    recheck: d("재확인 필요", "tri", "warn", "새 질문 버전 · 옛 답 자동 승계 없음"),
    deferred: d("보류됨", "pause", "off", "status = deferred"),
    merged: d("합쳐짐", "hsquare", "off", "status = merged"),
    withdrawn: d("철회됨", "hsquare", "off", "status = withdrawn"),
  },
  // 실행(U1d): 중단 · 취소 · 인계는 서로 다른 사실이다(UI 44·49·104)
  run: {
    running: d("실행 중", "ring", "run", "runs.status = running"),
    queued: d("대기", "dash", "off", "runs.status = queued"),
    waiting_human: d("사람 답 기다림", "pause", "warn", "runs.status = waiting_human"),
    blocked_usage: d("사용량 멈춤", "square", "warn", "runs.status = blocked_usage"),
    interrupted: d("중단됨", "square", "bad", "runs.status = interrupted"),
    cancelled: d("취소됨", "hsquare", "off", "runs.status = cancelled"),
    handed_off: d("인계됨", "tri", "unk", "runs.status = handed_off"),
    failed: d("실패", "square", "bad", "runs.status = failed"),
    succeeded: d("완료", "circle", "ok", "runs.status = succeeded"),
  },
  // 나간 전송(outbound_dispatches) — 취소 시도와 결과를 모르는 것은 같은 말로 뭉개지 않는다
  dispatch: {
    prepared: d("준비됨", "dash", "off", "outbound_dispatches.state = prepared"),
    authorized: d("허가됨", "hsquare", "run", "outbound_dispatches.state = authorized"),
    sent: d("보냄", "circle", "ok", "outbound_dispatches.state = sent"),
    response: d("응답 받음", "ring", "run", "outbound_dispatches.state = response"),
    adopted: d("반영됨", "circle", "ok", "outbound_dispatches.state = adopted"),
    blocked: d("막힘", "square", "warn", "outbound_dispatches.state = blocked"),
    failed: d("실패", "square", "bad", "outbound_dispatches.state = failed"),
    unknown: d("알 수 없음", "dotring", "unk", "outbound_dispatches.state = unknown — 결과를 모름"),
    // 아래 둘은 서버가 보내지 않는 옛 값 — 사전이 계속 읽는다(취소 시도는 별도 칸 cancel_state 로 온다)
    cancel_requested: d("취소 시도", "tri", "warn", "취소를 요청했지만 끝난 것은 아님"),
    cancelled: d("취소됨", "hsquare", "off", "취소가 끝남 — 이미 읽힌 자료의 회수를 뜻하지 않는다"),
  },
  // 가정 · 결정 · 반영(U3b · F06): 사람 판단이 있어야 확인 · 채택이다. AI 제안(판단 전)은 확인처럼 보이지 않는다
  assumption: {
    proposed: d("판단 전", "dotring", "unk", "assumptions.state = proposed — AI·사람이 남긴 제안, 아직 사람이 판단하지 않음"),
    confirmed: d("확인", "circle", "ok", "confirmed + 사람 판단자"),
    rejected: d("틀림", "hsquare", "off", "rejected — 기록은 남음"),
    revised: d("고침", "tri", "warn", "revised — 원문 보존 + 판단자 + 근거"),
    review: d("재확인 필요", "tri", "warn", "needs_review = true — 새 판 복사본 등, 자동 확인처럼 보이지 않음"),
    no_human: d("사람 판단 없음", "dotring", "unk", "confirmed 인데 판단자가 없거나 AI — 확인으로 보이지 않음"),
  },
  decision: {
    proposed: d("제안", "dotring", "unk", "decisions.state = proposed"),
    adopted: d("채택", "circle", "ok", "adopted + 사람 결정자"),
    superseded: d("대체됨", "dash", "off", "superseded — 새 결정이 이어받음, 문장은 그대로"),
    revoked: d("철회", "hsquare", "off", "revoked — 기록은 남음"),
    no_human: d("사람 판단 없음", "dotring", "unk", "adopted 인데 결정자가 없거나 AI — 채택으로 보이지 않음"),
  },
  // 반영 내역: 적용 · 부분은 의미 증거(적용 tx + 결과 버전 또는 적용된 후속)가 있을 때만. 모자라면 증거 없음
  reflection: {
    applied: d("적용", "circle", "ok", "적용 tx + 결과 버전·적용된 후속의 증거"),
    partial: d("부분", "tri", "warn", "적용 tx + 적용된 후속의 증거"),
    deferred: d("유예", "pause", "off", "reflection_entries.disposition = deferred"),
    rejected: d("거절", "hsquare", "off", "rejected"),
    missing: d("증거 없음", "square", "bad", "applied·partial 인데 증거가 모자람 — 성공으로 보이지 않음"),
  },
} as const satisfies Record<string, Record<string, StatusDef>>;

export type StatusDomain = keyof typeof STATUS;

export function lookup(domain: StatusDomain, value: string): StatusDef {
  const def = (STATUS[domain] as Record<string, StatusDef>)[value];
  // 모르는 값은 ‘미상’(설계 P4: 모르면 모른다고). 허용·정상으로 해석하지 않는다
  return def ?? { label: `미상(${value})`, shape: "dotring", tone: "unk" };
}
