import type { ProblemRecord, ProblemView, ProposalView, ResearchBrief, StageKey, StageSummary } from "@/api/types";

/**
 * 연구 공간(5차, 설계 16절)의 합성 자료 — 연구 개요 · 연구 내용 문제 · AI 제안 · 지난 단계 요약 · 해결 기록.
 * 모든 이름·수치·문장은 가상이다. 진행 문제(필수 질문 미응답 · AI 실행 멈춤 · 동기화 충돌 · 글자 뽑기 실패)는
 * 이미 있는 자료(질문 폼 · 실행 · 동기화 · 자료 표)에서 목 클라이언트가 계산한다 — 같은 사실을 두 곳에 적지 않는다.
 * 주소의 {round}는 그 프로젝트의 현재 라운드 주소로 바뀐다.
 */
export interface ResearchMock {
  brief: ResearchBrief;
  /** 연구 내용 문제(근거 부족 · 자료 어긋남 · 검증 실패) — 해결하면 problem.resolve가 기록으로 옮긴다 */
  content: ProblemView[];
  proposals: ProposalView[];
  stage_summaries: Partial<Record<StageKey, StageSummary>>;
  log: ProblemRecord[];
}

const dolbom: ResearchMock = {
  brief: {
    question: "가상의 A시·B군에서 돌봄 인력이 모자라는 까닭은 무엇이고, 어떤 지원이 돌봄 공백을 줄이는가?",
    scope: "요양보호사 중심 · 사례 지역 2곳 · 2022~2024년(모두 가상)",
    findings: [
      { id: "fd1", text: "요양보호사 1인당 이용자 수가 2022년보다 늘었다", basis: { domain: "claim", value: "supported" }, where: "문단 1 · 자료 시트 2 · 출처 3", href: "{round}?t=review#para-0" },
      { id: "fd2", text: "재가 돌봄의 빈 시간대가 저녁·주말에 몰린다", basis: { domain: "claim", value: "partial" }, where: "문단 1 · 출처 3", href: "{round}?t=review#para-0", problem_id: "p-v1" },
      { id: "fd3", text: "읍·면 지역일수록 신규 인력이 1년 안에 더 많이 그만둔다", basis: { domain: "claim", value: "weak" }, where: "문단 2 · 첨언 1", href: "{round}?t=review#para-1", problem_id: "p-w1" },
      { id: "fd4", text: "기관 내부 의견은 인력 부족을 임금보다 근무 형태의 문제로 본다", basis: { domain: "aiAccess", value: "used_before_off" }, where: "문단 4 · AI 참조를 끈 자료", href: "{round}?t=review#para-3" },
      { id: "fd5", text: "2023년 A시 요양보호사는 1,180명이다(공식 통계)", basis: { domain: "claim", value: "conflict" }, where: "문단 5 · 자료 시트 2 · 출처 5", href: "{round}?t=review#para-4", problem_id: "p-c1" },
    ],
    milestone: { title: "조사 단계 승인", note: "승인하면 분석·종합 단계가 열립니다. AI가 바로 시작하지는 않습니다." },
  },
  content: [
    {
      id: "p-w1",
      kind: "weak_evidence",
      state: "open",
      title: "‘1년 안에 그만두는 비율이 높았다’에 붙은 근거가 없습니다",
      cause: "이 문장에는 출처·자료 인용이 없습니다. 사례 지역 2곳 면담에서 나온 말로 보이며 표본 수는 미상입니다(첨언 1 · 박검토).",
      where: { label: "결과 글 문단 2 · 첨언 1", href: "{round}?t=review#para-1" },
      paragraph: 1,
      quote: "1년 안에 그만두는 비율이 높았다",
      found: "AI 점검 · 조사 R2 · 14:05 / 첨언 1 · 박검토 14:22",
      blocks: ["단계 승인"],
      options: [
        {
          id: "ai_find",
          label: "AI에게 근거 찾게 하기",
          effect: "면담 기록·출처에서 근거와 표본 수를 찾아 다음 결과 글에 붙이게 합니다. 못 찾으면 ‘찾지 못함’으로 알려 줍니다.",
          recommended: true,
          why: "면담 기록(현장 조사 2026 폴더)이 이미 올라와 있어 근거를 찾을 수 있을 수도 있습니다 — 찾을지는 확인 안 됨.",
          via: "problem.resolve",
          to_ai: true,
        },
        { id: "soften", label: "‘면담에서 나온 경향(추정)’으로 낮추기", effect: "‘…높은 경향이 보였다(사례 지역 2곳 면담 · 추정)’로 고치는 글 수정 제안을 만듭니다. 채택해야 결과 글이 바뀝니다.", via: "problem.resolve" },
        { id: "remove", label: "이 문장 빼기", effect: "빼는 글 수정 제안을 만듭니다. 채택 전까지 결과 글은 그대로입니다.", via: "problem.resolve" },
      ],
    },
    {
      id: "p-v1",
      kind: "verify_failed",
      state: "open",
      title: "‘저녁과 주말에 몰렸다’ — 출처 3은 저녁만 다룹니다",
      cause: "출처 3(가상 지역 돌봄 실태 보고)은 저녁 시간대 공백만 적었고 주말은 다루지 않습니다. 주장의 일부만 뒷받침합니다.",
      where: { label: "결과 글 문단 1 · 출처 3", href: "{round}?t=review#para-0" },
      paragraph: 0,
      quote: "재가 돌봄의 빈 시간대가 저녁과 주말에 몰렸다",
      found: "AI 점검 · 출처 대조 · 조사 R2 · 14:05",
      blocks: ["단계 승인"],
      options: [
        {
          id: "narrow",
          label: "주장을 출처 범위로 좁히기",
          effect: "‘빈 시간대가 저녁에 몰렸다’로 고치는 글 수정 제안을 만듭니다. 채택해야 결과 글이 바뀝니다.",
          recommended: true,
          why: "지금 있는 근거만으로 말할 수 있는 범위입니다. 주말 근거가 나오면 다시 넓힐 수 있습니다.",
          via: "problem.resolve",
        },
        { id: "find", label: "주말 근거를 AI가 찾게 하기", effect: "사람→AI 질문으로 접수합니다. 방식 B는 내 컴퓨터 AI가 받아야 시작합니다.", via: "problem.resolve", to_ai: true },
        { id: "keep", label: "그대로 두고 ‘확인 안 됨’ 남기기", effect: "결과 글은 그대로 두고, 핵심 발견에 ‘확인 안 됨’을 붙여 검증 단계에서 다시 봅니다.", via: "problem.resolve" },
      ],
    },
    {
      id: "p-c1",
      kind: "conflict_data",
      state: "open",
      title: "2023년 A시 요양보호사 수 — 두 자료가 다릅니다",
      cause: "자료(2024 지역별 돌봄 인력 현황 · 시트 2)는 1,180명, 출처 5(기관 보고서 · 가상)는 1,240명입니다. 집계 기준일이 다를 수 있습니다(확인 안 됨).",
      where: { label: "결과 글 문단 5 · 자료 시트 2 · 출처 5", href: "{round}?t=review#para-4" },
      paragraph: 4,
      quote: "1,180명",
      found: "AI 점검 · 조사 R2 · 14:05 · 사람→AI 질문 Q-24와 같은 일",
      blocks: ["단계 승인"],
      options: [
        {
          id: "official",
          label: "공식 통계 값(1,180명)으로 쓰고 차이는 각주로",
          effect: "결정을 기록하고(누가 · 근거) 각주를 더하는 글 수정 제안을 만듭니다.",
          recommended: true,
          why: "공식 통계는 집계 기준이 공개돼 있어 다른 표와 맞추기 쉽습니다.",
          via: "problem.resolve",
        },
        { id: "report", label: "기관 보고서 값(1,240명)으로 쓰기", effect: "결정을 기록하고 값을 바꾸는 글 수정 제안을 만듭니다.", via: "problem.resolve" },
        { id: "assume", label: "판단 미루기 — 두 값을 함께 적고 가정으로", effect: "가정(‘차이는 집계 기준일 차이로 봄’)을 기록하고 검증 단계에서 다시 봅니다.", via: "problem.resolve" },
      ],
    },
  ],
  proposals: [
    { id: "pp1", kind: "assumption", text: "사례 지역 2곳의 경향을 도 전체로 넓혀 말하지 않는다", basis: "조사 노트 v4 · 첨언 1(박검토)", by: "Claude Code(도구가 알린 이름)", at: "14:06", state: { domain: "proposal", value: "proposed" } },
    { id: "pp2", kind: "decision", text: "방문간호 인력은 사례 지역 2곳만 포함한다", basis: "Q-21 기본값 — 답이 오면 그 답을 따름", by: "Claude Code(도구가 알린 이름)", at: "14:05", state: { domain: "proposal", value: "proposed" } },
    { id: "pp3", kind: "decision", text: "통계 기준 연도를 2024년으로 통일한다", basis: "Q-23 답(박검토 14:20)", by: "Claude Code(도구가 알린 이름)", at: "14:21", state: { domain: "proposal", value: "accepted", label: "받아들임 · 박검토 14:20" } },
  ],
  stage_summaries: {
    plan: {
      approved: "11-03 · 김연구 승인",
      result: "연구 설계서 v2",
      points: ["연구 질문: 돌봄 인력이 모자라는 까닭과 공백을 줄이는 지원", "범위: 요양보호사 중심 · 사례 지역 2곳 · 2022~2024년(가상)", "기한 11-28 · 60쪽 안팎 · 읽는 사람: 정책 담당 공무원"],
      href: "/p/dolbom-insight/editions",
    },
  },
  log: [{ id: "rec-d1", kind: "conflict_data", title: "표 2의 기준 연도가 2022·2023으로 섞임", choice: "2024 기준으로 통일(Q-23 답)", by: "박검토", at: "14:20", receipt_no: "R2-S2" }],
};

const youth: ResearchMock = {
  brief: {
    question: "가상의 C시 청년 월세 지원은 주거비 부담을 얼마나 줄였는가?",
    scope: "C시 수급자 1,200명 · 지원 12개월 · 같은 소득 구간 미신청자와 비교(모두 가상)",
    findings: [],
    milestone: { title: "기획 단계 승인", note: "멈춘 실행을 풀고 결과물이 다 나오면 승인할 수 있습니다." },
  },
  content: [],
  proposals: [{ id: "py1", kind: "assumption", text: "지원 기간은 12개월로 본다(수급 기간이 다른 사람은 따로 표시)", basis: "연구 설계 초안 v1", by: "PES 실행기 · deepseek-v4.1-flash", at: "15:40", state: { domain: "proposal", value: "proposed" } }],
  stage_summaries: {},
  log: [],
};

const rural: ResearchMock = {
  brief: {
    question: "가상의 농촌 군 지역 주민이 병원에 가기 어려운 까닭은 무엇인가?",
    scope: "비교 지역·기간·분량은 기획 시작 질문에서 정함",
    findings: [],
    milestone: { title: "첫 AI 실행(기획 R1)", note: "필수 시작 질문에 답하고 API 회사 화면에서 본 숫자을 적으면 소유자가 시작합니다. 만들기는 AI를 실행하지 않았습니다." },
  },
  content: [],
  proposals: [],
  stage_summaries: {},
  log: [],
};

const ltc: ResearchMock = {
  brief: {
    question: "가상의 장기요양 기관 인력·서비스 실태는 1판 뒤 어떻게 바뀌었나(2판)?",
    scope: "1판 기관 12곳 + 기획을 다시 열며 넓힌 지역(모두 가상)",
    findings: [
      { id: "fl1", text: "기관 30%가 야간 인력 기준에 못 미친다(1판)", basis: { domain: "stage", value: "stale" }, where: "1판 완료본 · 3.2절", href: "/p/ltc-survey/s/plan" },
      { id: "fl2", text: "신규 인력 이직은 첫 해에 몰린다(1판)", basis: { domain: "stage", value: "stale" }, where: "1판 완료본 · 4.1절", href: "/p/ltc-survey/s/plan" },
      { id: "fl3", text: "새 범위에 맞는 출처를 다시 찾는 중", basis: { domain: "claim", value: "ai" }, where: "AI 작업 기록", href: "/p/ltc-survey/ai", problem_id: "p-l1" },
    ],
    milestone: { title: "조사 단계 다시 확인 → 승인", note: "기획을 다시 열어 조사 결과를 다시 봐야 합니다. 승인 기록은 지우지 않습니다." },
  },
  content: [
    {
      id: "p-l1",
      kind: "verify_failed",
      state: "ai",
      title: "1판 출처 7건 — 2판 범위를 뒷받침하는지 확인 안 됨",
      cause: "기획을 다시 열며 지역 범위가 넓어졌습니다. 1판 출처 22건 중 7건이 새 범위에도 맞는지 대조하지 않았습니다.",
      where: { label: "AI 작업 기록 · 새 출처 찾기", href: "/p/ltc-survey/ai" },
      found: "기획 다시 열기 · 11-04 17:50",
      blocks: ["단계 승인"],
      note: "11-04 17:55 김연구가 AI에게 맡김 — Codex CLI가 새 출처를 찾는 중(마지막 소식은 AI 동료 칸)",
      options: [
        { id: "find", label: "AI에게 새 출처 찾게 하기", effect: "사람→AI 질문으로 접수합니다. 내 컴퓨터 AI가 받아야 시작합니다.", recommended: true, why: "새 범위의 출처는 아직 없습니다.", via: "problem.resolve", to_ai: true },
        { id: "narrow", label: "2판 범위를 1판 지역으로 좁히기", effect: "기획 결정을 다시 여는 대신 조사 범위만 좁히는 결정 제안을 만듭니다.", via: "problem.resolve" },
        { id: "keep", label: "그대로 두고 검증 단계에서 보기", effect: "‘확인 안 됨’으로 남기고 검증 단계에서 대조합니다.", via: "problem.resolve" },
      ],
    },
  ],
  proposals: [{ id: "pl1", kind: "decision", text: "면담 대상은 1판과 같은 12곳으로 시작한다", basis: "기획서 2판 · 범위 변경", by: "Codex CLI(도구가 알린 이름)", at: "11-04 17:58", state: { domain: "proposal", value: "proposed" } }],
  stage_summaries: {
    plan: {
      approved: "11-04 · 김연구 다시 승인(2판)",
      result: "기획서 2판",
      points: ["1판 결론을 바탕으로 비교 지역을 넓힘", "면담 대상 기관 수는 조사 중 판단", "AI가 읽기: 막음 — 방식 B로만 진행"],
      href: "/p/ltc-survey/editions",
    },
  },
  log: [],
};

export const RESEARCH: Record<string, ResearchMock> = {
  "dolbom-insight": dolbom,
  "youth-housing": youth,
  "rural-care-access": rural,
  "ltc-survey": ltc,
};
