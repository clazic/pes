import type { Actor, AssumptionRow, DecisionRow, ReflectionEntry, ReflectionView, RoundView, WorkspaceView } from "./types";

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

/**
 * 앱 기본(가짜 클라이언트) 작업 공간 — U1d 칸(ai_connection)까지 있는 합성 자료.
 * WORKSPACE 는 “서버가 주는 최소 모양”을 지키는 계약 fixture 라 여기에 AI 연결 칸을 더하지 않는다.
 * (http-client.test.ts 가 `가짜 클라이언트의 getWorkspace = 서버 fixture WORKSPACE` 를 지킨다)
 */
export const DEMO_WORKSPACE: WorkspaceView = { ...WORKSPACE, ai_connection: { policy: "allowed" } };

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

/**
 * 가정 · 결정 · 반영 합성 자료(U3b) — 앱 기본 가짜 클라이언트용. 개발 · 시험 전용(production 번들에는 가짜 클라이언트와 함께 들어가지 않는다).
 * 실제 연구 · 사람 · 경로가 없다. 판단자 이름 “검토자 하늘” 은 합성 이름이다.
 */
const AI_ACTOR: Actor = { id: "act-ai", kind: "ai", name: "조사 AI" };
export const DEMO_HUMAN: Actor = { id: "act-h1", kind: "human", name: "검토자 하늘" };
const STAMP = "2026-11-05T14:03:00+09:00";
const R1_RESULT_HREF = "/p/sample-study/e/1/s/research/r/1";
const R2_RESULT_HREF = "/p/sample-study/e/1/s/research/r/2";

export interface U3Data {
  assumptions: AssumptionRow[];
  decisions: DecisionRow[];
  /** 키 = "<stage>/<round>" */
  reflections: Record<string, ReflectionView | null>;
}

const asm = (id: string, over: Partial<AssumptionRow>): AssumptionRow => ({
  object_id: id,
  version_id: `${id}-v1`,
  version: 1,
  statement: `가정 ${id}`,
  state: "proposed",
  proposed_by: AI_ACTOR,
  assessed_by: null,
  assessed_at: null,
  needs_review: false,
  rationale: "",
  original: null,
  copied_from: null,
  source: null,
  ...over,
});
const dec = (id: string, over: Partial<DecisionRow>): DecisionRow => ({
  object_id: id,
  version_id: `${id}-v1`,
  version: 1,
  statement: `결정 ${id}`,
  state: "proposed",
  scope: "project",
  proposed_by: AI_ACTOR,
  decided_by: null,
  rationale: "",
  supersedes: null,
  superseded_by: null,
  originated_from: null,
  source: null,
  ...over,
});
const entry = (id: string, over: Partial<ReflectionEntry>): ReflectionEntry => ({
  id,
  opinion: `의견 ${id}`,
  source: null,
  disposition: "applied",
  rationale: "",
  actor: DEMO_HUMAN,
  applied_tx_id: null,
  result_version: null,
  followup: null,
  ...over,
});

/** 함수로 둔다 — 호출하지 않는 production 번들에서 합성 자료가 통째로 빠지게(상수로 만들면 호출 부수효과가 남는다) */
export const demoU3 = (): U3Data => ({
  assumptions: [
    asm("as-1", { statement: "도서관 방문 수의 정의는 2019년부터 같다고 본다", source: { label: "조사 R1 결과 글 v1", href: R1_RESULT_HREF } }),
    asm("as-2", { statement: "공개 통계의 대출 수는 도서 반납분을 뺀 값이다", state: "confirmed", version: 2, assessed_by: DEMO_HUMAN, assessed_at: STAMP, rationale: "공개 통계 정의서와 대조했다" }),
  ],
  decisions: [
    dec("dec-1", { statement: "비교 기간은 2019년부터 지금까지로 한다", state: "superseded", decided_by: DEMO_HUMAN, rationale: "처음 범위", superseded_by: "dec-2" }),
    dec("dec-2", {
      statement: "비교 기간은 2021년부터 지금까지로 한다",
      state: "adopted",
      decided_by: DEMO_HUMAN,
      version: 2,
      rationale: "집계 정의가 2021년에 바뀜",
      supersedes: { object_id: "dec-1", statement: "비교 기간은 2019년부터 지금까지로 한다" },
    }),
    dec("dec-3", { statement: "어린이와 노년층은 따로 묶어 본다", state: "adopted", scope: "edition", decided_by: DEMO_HUMAN, originated_from: { label: "1판 결정", version: 2 } }),
    dec("dec-4", { statement: "기관 내부 자료는 쓰지 않는다", state: "proposed", source: { label: "조사 R1 결과 글 v1", href: R1_RESULT_HREF } }),
  ],
  reflections: {
    "research/2": {
      submission: "submitted",
      sent_count: 3,
      entries: [
        entry("rf-1", {
          opinion: "표에 연도별 합계를 넣어 주세요",
          disposition: "applied",
          rationale: "합계 줄을 더했다",
          applied_tx_id: "tx-0901",
          result_version: { label: "조사 결과 글 v3", href: R2_RESULT_HREF },
          source: { label: "첨언 12", href: R1_RESULT_HREF },
        }),
        entry("rf-2", { opinion: "시군구별로 나눠 주세요", disposition: "deferred", rationale: "자료가 없어 다음 판으로" }),
        entry("rf-3", { opinion: "민간 통계를 섞어 주세요", disposition: "rejected", rationale: "연구 범위 밖" }),
      ],
    },
  },
});
