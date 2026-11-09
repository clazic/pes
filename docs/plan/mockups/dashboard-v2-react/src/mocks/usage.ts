import type { ComputerView, NotificationItem, UsageView } from "@/api/types";
import { CONNECTIONS } from "./connections";

/** 사용량 — 정적 시안 usage.html 장면(16:12). “Go”를 쓰지 않고 연결 이름·‘API’로 쓴다. 수치는 합성. */
export const USAGE: UsageView = {
  scene_time: "16:12",
  now: {
    rank: 1,
    kind: "blocked",
    title: "방식 A 실행 1건이 API 사용량 때문에 멈췄습니다",
    facts: ["청년 주거 · 기획 R1", "5시간 91% · 문턱 90%", "재개 16:40(PES 추정)"],
    detail: "15:52에 다음 호출의 예약을 더하면 문턱을 넘어 보내기 전에 멈췄습니다. 재개 전에 확인 안 된 호출 1건을 정리해 주세요. 멈춘 동안에도 답·첨언·자료 올리기는 됩니다.",
    action: { label: "확인 안 된 호출 정리", href: "#unknown" },
    then: [
      { label: "추가 요금 꺼짐 확인 · 11-12 만료", href: "#extra" },
      { label: "멈춘 동안 답·첨언", href: "/p/youth-housing/e/1/s/plan/r/1" },
    ],
  },
  connections: CONNECTIONS,
  blocked: {
    project: "청년 주거 지원 효과(가상)",
    run: "R1-2",
    where: "기획 R1",
    stopped: "15:52 · 담당을 놓음(다른 실행이 대신 잡지 않음)",
    reason: "사용량 문턱 — 다음 호출의 예약을 더하면 연구실 구독 API 5시간 구간 추정 91% ≥ 90%라 보내기 전에 멈춤",
    model: "deepseek-v4.1-flash",
    connection: "연구실 구독 API",
    reset: "16:40 PES 추정 · 지나도 저절로 다시 시작하지 않음",
    checks: [
      { item: "AI가 읽기", detail: "허용 · 정책 3번", pass: true },
      { item: "추가 요금 꺼짐 확인", detail: "11-12 09:10까지 유효", pass: true },
      { item: "API 회사 화면에서 본 숫자", detail: "15:30 입력 · 계정 전체 사용률 · 확인한 시각 이후 PES 증분만 더함", pass: true },
      { item: "추정 사용량", detail: "5시간 91% — 문턱 90% 아래로 내려가야 함 · 16:40 예상 84%", pass: false },
      { item: "확인 안 된 호출", detail: "1건 — 사람이 정리해야 함", pass: false },
      { item: "AI 연결 · 모델", detail: "연구실 구독 API · deepseek-v4.1-flash · 목록에 있음 · 연결 시험 09:00", pass: true },
      { item: "필요한 답(서버 판단)", detail: "필수 답·의견 응답 조건 충족 — PR8 resume_ready가 16:10에 계산", pass: true },
      { item: "기한 · 실행 기반", detail: "기한 없음 · 결과와 질문이 멈춘 때 그대로", pass: true },
      { item: "새 담당(claim) 가능", detail: "옛 담당 해제됨 · 계속 접수 뒤 실행기가 새 담당·fence를 잡음", pass: true },
    ],
  },
  unknown_calls: [
    {
      id: "u1",
      run: "R1-2 · 기획 R1",
      at: "15:51",
      what: "응답을 받기 전에 연결이 끊겼습니다. API가 처리했는지 알 수 없습니다.",
      reserve: "최대 출력 8,000토큰 예약 유지(5시간 구간 5%p)",
      evidence_hint: "API 회사 화면의 사용 내역에서 15:51 전후 요청이 있는지 봅니다(요청 상관키 pes-r1-2-c31).",
    },
  ],
  flow: [
    { time: "14:30", title: "실행 시작", body: "김연구 · 추정 62%", state: "past" },
    { time: "15:51", title: "응답 유실", body: "확인 안 된 호출 1 · 예약 유지", state: "past" },
    { time: "15:52", title: "보내기 전에 멈춤", body: "다음 호출의 예약을 더하면 91% ≥ 90% → 보내지 않고 멈춤 · 담당 놓음 · 알림", state: "past" },
    { time: "지금", title: "사람이 정리", body: "확인 안 된 호출 정리하기", state: "now" },
    { time: "16:40", title: "재개 가능 시각", body: "추정 84% 예상", state: "next" },
    { time: "그 뒤", title: "준비 검사 통과", body: "“재개 준비됨” 알림", state: "next" },
    { time: "사람이 누름", title: "계속", body: "서버 재검사 · 새 담당", state: "next" },
  ],
  rank: [
    { label: "API 회사 화면에서 본 숫자(15:30)", value: 58, tip: "확인한 시각에 API 회사 화면에서 본 계정 전체 사용률 — 다른 앱 + 확인한 시각 이전 PES 사용 포함 · PES가 나눌 수 없음", external: true },
    { label: "청년 주거 · R1-2 (멈춤) · 확인한 시각 이후", value: 3, tip: "기획 R1 · 확인한 시각 이후 호출 9회 · 확인 안 된 호출 예약 포함" },
    { label: "청년 주거 · 검토 R1-r · 확인한 시각 이후", value: 1, tip: "독립 검토 실행 · 같은 모델" },
    { label: "예약(정산 전)", value: 2, tip: "확인 안 된 호출 1건의 최대 출력 예약" },
  ],
  projects: [
    { title: "청년 주거 지원 효과(가상)", mode: "A", connection: "연구실 구독 API", model: "deepseek-v4.1-flash", limit: "문턱 90%", status: { domain: "run", value: "blocked_usage", label: "실행 멈춤 1" } },
    { title: "농촌 의료 접근성 개선 연구(가상)", mode: "A", connection: "연구실 구독 API", model: "deepseek-v4.1-flash", limit: "문턱 90%", status: { domain: "run", value: "queued", label: "실행 없음" } },
    { title: "지역 돌봄 인력 수급 개선 연구(가상)", mode: "B", connection: "—", model: "도구에서 고름", limit: "—", status: null, note: "B 비용은 PES가 막지 못함" },
  ],
  ops: [
    { resource: "요청(하루)", used: "4,380", limit: "100,000", percent: 4, status: { domain: "meter", value: "ok" } },
    { resource: "DB 읽기(하루)", used: "13,200행", limit: "5,000,000행", percent: 0.3, status: { domain: "meter", value: "ok" } },
    { resource: "DB 쓰기(하루)", used: "1,050행", limit: "100,000행", percent: 1, status: { domain: "meter", value: "ok" } },
    { resource: "DB 크기", used: "182MB", limit: "350MB 안전선", percent: 52, status: { domain: "meter", value: "ok" } },
    { resource: "파일 저장(달)", used: "7.1GB", limit: "10GB", percent: 71, status: { domain: "meter", value: "ok", label: "여유 · 초과분은 과금" } },
    { resource: "실행 단계(하루)", used: "980", limit: "3,000", percent: 33, status: { domain: "meter", value: "ok" } },
    { resource: "알림 메일(하루)", used: "41", limit: "100", percent: 41, status: { domain: "meter", value: "ok" } },
    { resource: "실시간 연결 요청", used: "미확인", limit: "미확인", percent: null, status: { domain: "notify", value: "unknown", label: "미확인 · 0으로 쓰지 않음" } },
  ],
  // 합성 추이: 14:30 실행 시작 62% → 15:30 API 회사 화면에서 본 숫자 입력으로 계정 전체 62%에 맞춤 → 15:51 86%(+예약 5%p) → 15:52 91% 멈춤 → 16:40 84% 예상
  trend: {
    connection: "연구실 구독 API",
    window: "h5",
    stop_percent: 90,
    points: [
      { t: "14:30", est: 62, note: "실행 시작(김연구)" },
      { t: "14:45", est: 64 },
      { t: "15:00", est: 66 },
      { t: "15:15", est: 66 },
      { t: "15:30", est: 62, note: "API 회사 화면에서 본 숫자 입력 — PES 추정 66%를 계정 전체 62%로 맞춤" },
      { t: "15:40", est: 74 },
      { t: "15:51", est: 86, note: "응답 유실 — 확인 안 된 호출 1건, 예약 5%p 유지" },
      { t: "15:52", est: 91, note: "다음 호출 예약을 더하면 91% ≥ 90% → 보내기 전에 멈춤" },
      { t: "16:00", est: 91 },
      { t: "16:12", est: 91, proj: 91, note: "지금 — 멈춘 뒤 새 호출 없음" },
      { t: "16:20", proj: 89 },
      { t: "16:30", proj: 87 },
      { t: "16:40", proj: 84, note: "재개 가능 시각(PES 추정) — 지나도 저절로 다시 시작하지 않음" },
    ],
  },
};

export const COMPUTER: ComputerView = {
  devices: [
    { name: "연구실 노트북", helper: "pes link 0.16(예시)", status: { domain: "computer", value: "connected" }, checked: "14:12 (1분 전)", projects: 1 },
    { name: "집 데스크톱", helper: "pes link 0.16(예시)", status: { domain: "computer", value: "ai_absent" }, checked: "18:19", projects: 1 },
    { name: "예전 노트북", helper: "—", status: { domain: "computer", value: "revoked" }, checked: "10-28", projects: 0 },
  ],
  links: [
    { project: "지역 돌봄 인력 수급 개선 연구(가상)", folder: "돌봄 연구 폴더", tool: "Claude Code", scope: { domain: "generic", value: "limited" }, scope_note: "폴더 직접 읽기 가능" },
    { project: "장기요양 기관 실태 분석(가상)", folder: "장기요양 2판 폴더", tool: "Codex CLI", scope: { domain: "generic", value: "limited" }, scope_note: "폴더 직접 읽기 가능" },
  ],
  approvals: [
    { at: "11-05 14:40", device: "연구실 노트북 · Claude Code", result: { domain: "device", value: "approved" } },
    { at: "11-04 09:02", device: "알 수 없는 기기 · 코드 다름", result: { domain: "device", value: "denied" } },
    { at: "11-03 21:15", device: "집 데스크톱", result: { domain: "device", value: "expired" } },
  ],
};

/** 기본 알림 문구에는 프로젝트 이름·질문 문구·파일 이름을 싣지 않는다(설계 4.13). */
export const NOTIFICATIONS: NotificationItem[] = [
  { id: "n1", title: "AI 실행이 멈췄습니다", at: "20분 전", channel: "푸시", delivery: { domain: "notify", value: "sent" }, href: "/p/youth-housing/e/1/s/plan/r/1?t=blocked", unread: true, slug: "youth-housing" },
  { id: "n2", title: "시작 질문이 있습니다", at: "1시간 전", channel: "메일", delivery: { domain: "notify", value: "sent" }, href: "/p/rural-care-access/e/1/s/plan/r/start", unread: true, slug: "rural-care-access" },
  { id: "n3", title: "답할 질문이 있습니다", at: "2시간 전", channel: "메일과 푸시", delivery: { domain: "notify", value: "unknown", label: "푸시 확인 안 됨 · 메일 보냄" }, href: "/p/dolbom-insight/e/1/s/research/r/2#q-21", unread: true, slug: "dolbom-insight" },
  { id: "n4", title: "동기화 충돌이 있습니다", at: "어제", channel: "메일", delivery: { domain: "notify", value: "sent" }, href: "/p/dolbom-insight/e/1/s/research/r/2#sync", unread: false, slug: "dolbom-insight" },
];
