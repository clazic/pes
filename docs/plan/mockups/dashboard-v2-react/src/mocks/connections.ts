import type { AiConnection } from "@/api/types";

/**
 * 합성 AI 연결 2개(사용자 결정 2026-11-05: AI 연결 수동 등록, 특정 서비스 비의존).
 * 주소는 예시 도메인(example.com·example.org)만, 키는 끝 4자리 가짜 값만 둔다. 실제 키·계정 없음.
 */
export const CONNECTIONS: AiConnection[] = [
  {
    id: "conn-sub",
    name: "연구실 구독 API",
    kind: "subscription",
    endpoint: "https://api.example.com/v1",
    key: { last4: "a1b2", storage: "os_keychain", set_at: "11-01 09:00", set_by: "김연구" },
    billing: "subscription",
    owner: "김연구",
    models_source: "loaded",
    models_listed_at: "11-05 09:00",
    models: [
      { id: "deepseek-v4.1-flash", available: true, weight_known: true, is_default: true },
      { id: "example-model-b", available: true, weight_known: false },
      { id: "example-model-c", available: false },
    ],
    test: { state: "ok", at: "11-05 09:00", message: "모델 목록 3개를 받았습니다." },
    subscription: {
      stop_percent: 90,
      windows: [
        { key: "h5", estimated_percent: 91, t0_console: 62, pes_since_t0: 24, reserved: 5, pes_runs: 3, resets: { at: "16:40", basis: "estimate", text: "16:40 PES 추정 — 5시간 전 사용분이 빠지는 시각" } },
        { key: "week", estimated_percent: 64, t0_console: 58, pes_since_t0: 4, reserved: 2, pes_runs: 9, resets: { at: null, basis: "unknown", text: "확인 안 됨 — API가 알려 주지 않음" } },
        { key: "month", estimated_percent: 38, t0_console: 35, pes_since_t0: 2, reserved: 1, pes_runs: 21, resets: { at: "12-01", basis: "human", text: "12-01 — 구독 주기(사람이 입력)" } },
      ],
      extra_usage: { applicable: true, state: "confirmed", last: "11-05 09:10", by: "김연구", valid_until: "11-12 09:10" },
      baseline: { state: "entered", t0: "11-05 15:30", h5: 62, week: 58, month: 35, no_other_use_after_t0: false },
    },
    used_by: ["청년 주거 지원 효과(가상)", "농촌 의료 접근성 개선 연구(가상)"],
  },
  {
    id: "conn-metered",
    name: "종량제 API(예시)",
    kind: "openai_compatible",
    endpoint: "https://api.example.org/v1",
    key: { last4: "9f3c", storage: "os_keychain", set_at: "11-04 17:20", set_by: "김연구" },
    billing: "metered",
    owner: "김연구",
    models_source: "manual",
    models_listed_at: null,
    models: [
      { id: "example-chat-large", available: true, is_default: true, price: { source: "human", text: "단가 사람이 입력 · 입력 100만 토큰당 1,200원 · 출력 4,800원(예시값)" } },
      { id: "example-chat-small", available: true, price: { source: "unknown", text: "단가 모름 — 이 모델로는 시작하지 않음" } },
    ],
    test: { state: "ok", at: "11-04 17:21", message: "응답 확인. 모델 목록을 주지 않아 직접 입력했습니다." },
    metered: {
      cap: { amount: 50000, currency: "KRW", period: "month", set_by: "김연구", set_at: "11-04 17:22" },
      spent_estimate: { amount: 12400, as_of: "16:10" },
      state: "set",
    },
    used_by: [],
  },
];

export const KIND_LABEL: Record<AiConnection["kind"], string> = {
  subscription: "구독형 API",
  openai_compatible: "OpenAI 호환 API",
  anthropic: "Anthropic API",
  google: "Google API",
  custom: "직접 입력(내 컴퓨터·로컬 모델 등)",
};

export const BILLING_LABEL: Record<AiConnection["billing"], string> = {
  subscription: "구독 한도 안",
  metered: "쓴 만큼 과금",
};

export const STORAGE_LABEL: Record<AiConnection["key"]["storage"], string> = {
  os_keychain: "이 컴퓨터의 키체인(로컬 PES — Windows 자격 증명 관리자 · macOS 키체인)",
  server_secret: "PES 서버의 비밀 저장소(웹 PES, 5단계)",
};

export function won(n: number) {
  return `${n.toLocaleString("ko-KR")}원`;
}
