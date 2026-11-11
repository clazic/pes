import type { RoundView, WorkspaceView } from "./types";

/**
 * 합성 자료(U1a) — 실제 연구·기관·사람·경로·키가 없다. 시험 계약(src/test/contract.ts)의 최소 fixture:
 * 프로젝트 `sample-study` 판 1 · 기획(승인) · 조사(현재, R2 진행) · 분석(아직),
 * 조사 R2 질문 q-21(필수) · q-22, 조사 R2 오류 알림 하나.
 */
export const WORKSPACE: WorkspaceView = {
  slug: "sample-study",
  title: "예시 연구 — 동네 도서관 이용 변화",
  edition: 1,
  mode: "A",
  current: { stage: "research", round_id: 2 },
  stages: [
    {
      key: "plan",
      view: "approved",
      rounds: [
        { round_id: null, state: "closed" },
        { round_id: 1, state: "closed" },
      ],
    },
    {
      key: "research",
      view: "current_you",
      rounds: [
        { round_id: null, state: "closed" },
        { round_id: 1, state: "closed" },
        { round_id: 2, state: "current" },
      ],
    },
    { key: "analyze", view: "pending", rounds: [] },
  ],
  turn: { side: "you", count: 1, text: "조사 R2 질문 2개에 답해 주세요" },
};

/** 보낸 답 + 영수증(합성). 시각은 ISO(한국 시각 +09:00) */
const sent = (answer: string, committed_at: string, n: string) => ({
  answer,
  receipt_no: n,
  tx_id: `tx-${n}`,
  committed_at,
  idempotency_key: `key-${n}`,
});

export const ROUNDS: RoundView[] = [
  {
    stage: "plan",
    round_id: null,
    state: "closed",
    form_version: 1,
    questions: [
      {
        id: "q-01",
        number: 1,
        version: 1,
        required: true,
        importance: "high",
        source: "bank",
        text: "이 연구로 무엇을 알고 싶나요?",
        sent: sent("동네 도서관을 찾는 사람이 최근 몇 해 동안 어떻게 바뀌었는지 알고 싶습니다.", "2026-11-02T10:12:00+09:00", "0101"),
      },
    ],
    result: null,
    alerts: [],
    prompt: "기획 단계 시작 질문과 답(합성 자료)",
  },
  {
    stage: "plan",
    round_id: 1,
    state: "closed",
    form_version: 1,
    questions: [
      {
        id: "q-11",
        number: 11,
        version: 1,
        required: true,
        importance: "high",
        source: "ai",
        text: "비교할 기간을 정해 주세요.",
        help: "기간이 길면 자료가 늘지만 정의가 바뀐 해가 섞일 수 있어요.",
        sent: sent("2019년부터 지금까지로 해 주세요.", "2026-11-03T09:40:00+09:00", "0112"),
      },
      {
        id: "q-12",
        number: 12,
        version: 1,
        required: false,
        importance: "normal",
        source: "ai",
        text: "꼭 넣어야 할 이용자 무리가 있나요?",
        sent: sent("어린이와 노년층은 따로 보고 싶어요.", "2026-11-03T09:41:00+09:00", "0113"),
      },
    ],
    result: {
      title: "기획서",
      version: 1,
      status: "adopted",
      updated_at: "2026-11-04T17:30:00+09:00",
      paragraphs: [
        "이 연구는 2019년부터 지금까지 동네 도서관 이용이 어떻게 바뀌었는지 본다. 방문 수와 대출 수를 따로 세고, 어린이와 노년층은 별도 묶음으로 나눈다.",
        "공개 통계와 공공 자료만 쓴다. 기관 내부 자료는 쓰지 않는다.",
      ],
    },
    alerts: [],
    prompt: "기획 R1 질문·답과 기획서 요약(합성 자료)",
  },
  {
    stage: "research",
    round_id: null,
    state: "closed",
    form_version: 1,
    questions: [
      {
        id: "q-s1",
        number: 1,
        version: 1,
        required: true,
        importance: "high",
        source: "bank",
        text: "먼저 볼 자료의 종류를 골라 주세요.",
        sent: sent("공개 통계 표를 먼저 봐 주세요.", "2026-11-05T14:02:00+09:00", "0201"),
      },
    ],
    result: null,
    alerts: [],
    prompt: "조사 단계 시작 질문과 답(합성 자료)",
  },
  {
    stage: "research",
    round_id: 1,
    state: "closed",
    form_version: 1,
    questions: [
      {
        id: "q-15",
        number: 15,
        version: 1,
        required: true,
        importance: "high",
        source: "ai",
        text: "방문 수와 대출 수 중 무엇을 먼저 볼까요?",
        sent: sent("방문 수를 먼저 봐 주세요.", "2026-11-07T11:20:00+09:00", "0215"),
      },
    ],
    result: {
      title: "조사 결과 R1",
      version: 1,
      status: "adopted",
      updated_at: "2026-11-08T15:10:00+09:00",
      paragraphs: [
        "공개 통계 표 세 개에서 방문 수를 모았다. 2020년에 크게 줄었다가 2023년부터 다시 늘었다.",
        "대출 수는 다음 라운드에서 같은 기간으로 맞춰 본다.",
      ],
    },
    alerts: [],
    prompt: "조사 R1 결과 요약(합성 자료)",
  },
  {
    stage: "research",
    round_id: 2,
    state: "current",
    form_version: 2,
    questions: [
      {
        id: "q-21",
        number: 21,
        version: 1,
        required: true,
        importance: "high",
        source: "ai",
        text: "대출 수 자료의 정의가 2021년에 바뀌었어요. 그 앞뒤를 한 줄로 이어 볼까요, 따로 볼까요?",
        help: "이어 보면 흐름이 잘 보이지만, 정의 차이를 각주로 밝혀야 해요.",
      },
      {
        id: "q-22",
        number: 22,
        version: 1,
        required: false,
        importance: "normal",
        source: "ai",
        text: "R1 에서 찾은 출처 중 더 깊이 볼 것이 있으면 알려 주세요.",
      },
    ],
    result: {
      title: "조사 결과 R2",
      version: 2,
      status: "draft",
      updated_at: "2026-11-11T16:20:00+09:00",
      paragraphs: [
        "대출 수는 2019년 대비 2020년에 절반 가까이 줄었고, 2022년부터 회복했다. 다만 2021년부터 전자책 대출을 함께 세기 시작해 앞뒤를 바로 비교하기 어렵다.",
        "어린이 대출은 회복이 빨랐고, 노년층 방문은 아직 2019년 수준에 못 미친다.",
        "출처 하나(지역 통계 표)는 이번 실행에서 읽지 못해 빼고 썼다. 오류 알림을 확인해 주세요.",
      ],
    },
    alerts: [
      {
        id: "al-1",
        severity: "bad",
        title: "출처 1건을 읽지 못했어요",
        detail: "지역 통계 표 하나가 응답하지 않아 R2 결과 초안에서 뺐습니다. 다음 실행에서 다시 읽습니다.",
        raised_at: "2026-11-11T16:05:00+09:00",
      },
    ],
    prompt:
      "조사 R2 질문에 답하기 전에 볼 요약(합성 자료)\n- 대출 수 정의가 2021년에 바뀜(전자책 포함)\n- 어린이 대출 회복 빠름, 노년층 방문 회복 느림\n- 지역 통계 표 1건 읽지 못함",
  },
];
