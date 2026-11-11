/**
 * 작업 공간 읽기 묶음의 모양(U1a) — 서버 API 계약(`GET P/workspace` · 라운드 읽기)을 본뜬 DTO.
 * U1a 는 앱 안 가짜 클라이언트(합성 자료)만 쓴다. U1b 에서 같은 모양을 HTTP 클라이언트가 채운다.
 * 화면은 받은 값을 그리기만 한다 — 상태·차례·순서를 화면이 추측하지 않는다(설계 12.5).
 */

export type StageKey = "plan" | "research" | "analyze" | "write" | "verify" | "publish";

/** 단계 상태: 승인됨 · 현재 · 아직(안 열림) */
export type StageState = "approved" | "current" | "pending";

/** 라운드 하나. 단계 시작 질문은 round_id = null(가짜 R0 을 만들지 않는다) */
export interface RoundRef {
  round_id: number | null;
  /** 화면 이름: "단계 시작" · "R1" · "R2" */
  label: string;
  state: "closed" | "current";
}

export interface StageView {
  key: StageKey;
  /** 화면 이름: 기획 · 조사 · 분석 */
  label: string;
  state: StageState;
  rounds: RoundRef[];
}

export interface WorkspaceView {
  slug: string;
  title: string;
  edition: number;
  mode: "A" | "B";
  current: { stage: StageKey; round_id: number | null };
  stages: StageView[];
  /** 차례(서버 계산) — 나의 할 일 수와 먼저 할 일 한 줄 */
  turn: { side: "you" | "ai" | "waiting" | "done"; count: number; text: string };
}

export interface SentAnswer {
  answer: string;
  at: string;
  receipt_no: string;
}

export interface QuestionView {
  /** 화면 요소 id 이기도 하다(`q-21`) — 주소의 focus·peek 가 가리킨다 */
  id: string;
  number: number;
  version: number;
  required: boolean;
  importance: "높음" | "보통" | "낮음";
  source_label: string;
  text: string;
  help?: string;
  sent?: SentAnswer;
}

export interface AlertView {
  id: string;
  severity: "bad" | "warn";
  title: string;
  detail: string;
  at: string;
  acknowledged?: { at: string; receipt_no: string };
}

export interface RoundView {
  stage: StageKey;
  stage_label: string;
  round_id: number | null;
  label: string;
  state: "closed" | "current";
  form_version: number;
  questions: QuestionView[];
  result: { title: string; meta: string; paragraphs: string[] } | null;
  alerts: AlertView[];
  /** 프롬프트 복사(복사 대안)에 쓰는 글 */
  prompt: string;
}

export interface ProjectRef {
  slug: string;
  edition: number;
  current: { stage: StageKey; round_id: number | null };
}

export interface Receipt {
  receipt_no: string;
  at: string;
}

/** 가짜 클라이언트와 (U1b) HTTP 클라이언트가 같이 지키는 모양 */
export interface PesClient {
  listProjects(): Promise<ProjectRef[]>;
  getWorkspace(slug: string, edition: number): Promise<WorkspaceView | null>;
  /** round: 숫자 또는 "start"(단계 시작). 없으면 null */
  getRound(slug: string, edition: number, stage: string, round: string): Promise<RoundView | null>;
  acknowledgeAlert(slug: string, edition: number, alertId: string): Promise<Receipt>;
}
