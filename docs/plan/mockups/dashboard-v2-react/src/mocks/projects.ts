import type { ProjectsView } from "@/api/types";

/**
 * 프로젝트 목록 — 정적 시안 projects.html과 같은 장면(16:12). 모든 이름·수치는 합성 예시.
 * 차례(나의 할 일 · AI가 하는 중 · 기다림 · 끝남)는 목 클라이언트가 읽을 때 이 목록(turns · waiting)과 AI 진행 소식으로 계산해 카드마다 붙인다(4차).
 */
export const PROJECTS: ProjectsView = {
  scene_time: "16:12",
  turns: [
    {
      id: "t1",
      slug: "youth-housing",
      rank: 1,
      status: { domain: "turn", value: "blocked" },
      project_title: "청년 주거 지원 효과(가상)",
      where: "기획 R1 · 방식 A",
      short: "확인 안 된 호출 정리",
      text: "실행 멈춤 · 사용량 — 확인 안 된 호출 1건 정리 필요",
      since: "15:52부터",
      action: { label: "정리하기", href: "/usage#unknown", primary: true },
    },
    {
      id: "t2",
      slug: "dolbom-insight",
      rank: 2,
      status: { domain: "turn", value: "answer", label: "답할 질문 2" },
      project_title: "지역 돌봄 인력 수급 개선 연구(가상)",
      where: "조사 R2 · 방식 B",
      short: "조사 R2 질문 2",
      text: "필수 1개 남음 · AI는 답을 기다림",
      since: "기한 11-07",
      action: { label: "답하기", href: "/p/dolbom-insight/e/1/s/research/r/2#q-21" },
    },
    {
      id: "t3",
      slug: "rural-care-access",
      rank: 2,
      status: { domain: "turn", value: "start_q", label: "시작 질문 6" },
      project_title: "농촌 의료 접근성 개선 연구(가상)",
      where: "기획 시작 · 방식 A",
      short: "기획 시작 질문 6",
      text: "답하면 첫 실행 가능 · 먼저 콘솔 기준값 적기",
      since: "기한 없음",
      action: { label: "답하기", href: "/p/rural-care-access/e/1/s/plan/r/start" },
    },
    {
      id: "t4",
      slug: "dolbom-insight",
      rank: 5,
      status: { domain: "turn", value: "check" },
      project_title: "지역 돌봄 인력 수급 개선 연구(가상)",
      where: "내 컴퓨터 동기화",
      short: "동기화 충돌 1건",
      text: "충돌 1건 — 어느 쪽을 쓸지 고르기",
      since: "14:05부터",
      action: { label: "고르기", href: "/p/dolbom-insight/e/1/s/research/r/2#sync" },
    },
    {
      // 작업 공간 지금 할 일의 “그다음”과 같은 일 — 목록·작업 공간·사이드바가 같은 수를 세게(4차)
      id: "t5",
      slug: "dolbom-insight",
      rank: 5,
      status: { domain: "turn", value: "check" },
      project_title: "지역 돌봄 인력 수급 개선 연구(가상)",
      where: "참고 프로젝트",
      short: "참고 프로젝트 새 버전",
      text: "장기요양 기관 실태 분석(가상) 2판 R1 승인본 — 갱신하거나 지금 버전 유지",
      since: "11-04부터",
      action: { label: "보기", href: "/p/dolbom-insight/references" },
    },
  ],
  waiting: [],
  active: [
    {
      slug: "dolbom-insight",
      title: "지역 돌봄 인력 수급 개선 연구(가상)",
      edition: 1,
      mode: "B",
      runner_label: "Claude Code",
      api_transfer: { domain: "transfer", value: "on" },
      stages: [
        { key: "plan", view: "approved" },
        { key: "research", view: "current_you" },
        { key: "analyze", view: "pending" },
        { key: "write", view: "pending" },
        { key: "verify", view: "pending" },
        { key: "publish", view: "pending" },
      ],
      lines: [
        { label: "AI", text: "내 답 기다림" },
        { label: "내 컴퓨터", status: { domain: "computer", value: "connected" }, text: "14:12" },
      ],
      foot: ["마지막 활동 14:22 · 박검토", "알림 1"],
      current: "조사 R2",
      table: { ai: "내 답 기다림 · 연결됨 14:12", last: "14:22" },
      href: "/p/dolbom-insight/e/1/s/research/r/2",
    },
    {
      slug: "youth-housing",
      title: "청년 주거 지원 효과(가상)",
      edition: 1,
      mode: "A",
      runner_label: "deepseek-v4.1-flash",
      api_transfer: { domain: "transfer", value: "on" },
      stages: [
        { key: "plan", view: "current_blocked" },
        { key: "research", view: "pending" },
        { key: "analyze", view: "pending" },
        { key: "write", view: "pending" },
        { key: "verify", view: "pending" },
        { key: "publish", view: "pending" },
      ],
      lines: [
        { label: "AI", text: "실행 멈춤 · 사용량 문턱 · 재개 가능 16:40" },
        { label: "사용량", text: "연구실 구독 API · 5시간 추정 91% · 문턱 90%" },
      ],
      foot: ["마지막 활동 15:52 · 실행기", "알림 1"],
      current: "기획 R1",
      table: { ai: "실행 멈춤 · 사용량 문턱", last: "15:52" },
      href: "/p/youth-housing/e/1/s/plan/r/1",
    },
    {
      slug: "rural-care-access",
      title: "농촌 의료 접근성 개선 연구(가상)",
      edition: 1,
      mode: "A",
      runner_label: "deepseek-v4.1-flash",
      api_transfer: { domain: "transfer", value: "on" },
      stages: [
        { key: "plan", view: "current_you" },
        { key: "research", view: "pending" },
        { key: "analyze", view: "pending" },
        { key: "write", view: "pending" },
        { key: "verify", view: "pending" },
        { key: "publish", view: "pending" },
      ],
      lines: [
        { label: "AI", text: "실행 없음" },
        { label: "참고", text: "장기요양 기관 실태 분석(가상) 1판 완료본" },
      ],
      foot: ["만든 날 11-05 14:31", "자료 4"],
      current: "기획 시작",
      table: { ai: "실행 없음", last: "14:31" },
      href: "/p/rural-care-access/e/1/s/plan/r/start",
    },
    {
      slug: "ltc-survey",
      title: "장기요양 기관 실태 분석(가상)",
      edition: 2,
      mode: "B",
      runner_label: "Codex CLI",
      api_transfer: { domain: "transfer", value: "off" },
      stages: [
        { key: "plan", view: "approved" },
        { key: "research", view: "stale" },
        { key: "analyze", view: "pending" },
        { key: "write", view: "pending" },
        { key: "verify", view: "pending" },
        { key: "publish", view: "pending" },
      ],
      lines: [
        { label: "조사", text: "기획을 다시 열어 “앞 단계 변경 — 다시 확인”" },
        { label: "1판", text: "완료 · 다른 프로젝트 2곳이 참고 중" },
      ],
      foot: ["마지막 활동 11-04", "참고됨 2"],
      current: "2판 조사 R1",
      table: { ai: "진행 중 · 방식 A 불가", last: "11-04" },
      href: "/p/ltc-survey/e/2/s/research/r/1",
    },
  ],
  archived_count: 2,
  legacy: [{ title: "2024 지역 축제 효과 분석(가상)", note: "0.15 프로젝트 — 읽기만 됩니다. 답·승인은 새 DB로 옮긴 뒤에." }],
  failed_cards: [{ code: "R-5521", last_received: "16:10" }],
};

/**
 * AI 진행 소식(서버가 실행 담당·사건·도우미 보고로 계산) — 차례 표시기의 “AI가 하는 중”.
 * 시각은 장면 시각에서 몇 분 전인지로 적고, 목 클라이언트가 시안을 연 시각 기준으로 바꾼다(경과 시간이 실제로 흐르게).
 * ltc-survey: 실행 2-R1-1이 17:50부터 진행(장면 18:20 → 30분째), Codex CLI 마지막 호출 18:02(18분 전) — 시험값을 넘어 “소식 없음”(F09).
 */
export const AI_ACTIVITY: Record<string, { text: string; since_min: number; signal_min: number; fresh: boolean }> = {
  "ltc-survey": { text: "2판 조사 R1 · 새 출처 찾기", since_min: 30, signal_min: 18, fresh: false },
};
