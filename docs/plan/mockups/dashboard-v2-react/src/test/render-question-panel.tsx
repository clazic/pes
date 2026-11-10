import type { QuestionView, WorkspaceView } from "@/api/types";
import { QuestionPanel } from "@/features/workspace/QuestionPanel";
import { WORKSPACES } from "@/mocks/workspaces";
import { renderRoutes } from "@/test/render-app";

/**
 * 시험 도구 — 합성 질문 목록으로 QuestionPanel 하나만 그린다(연구 공간 틀 없이).
 * 선택지 5개 이상 같은 목 자료에 없는 모양을 시험할 때 쓴다. 합성 자료만.
 */
export const SYNTH_SLUG = "dolbom-insight";

/** 선택지가 n개인 합성 질문 — 선택지 id는 o1..on, 기본값 없음 */
export function synthQuestion(id: string, n: number): QuestionView {
  return {
    id,
    number: id.toUpperCase(),
    version: 1,
    source: "ai",
    source_label: "AI가 물음",
    importance: "보통",
    required: false,
    meta: `${id} · 합성`,
    text: `합성 질문 ${id}`,
    options: Array.from({ length: n }, (_, i) => ({ id: `o${i + 1}`, label: `선택지 ${i + 1}번` })),
    allow_comment_as_answer: false,
  } as QuestionView;
}

export async function renderQuestionPanel(questions: QuestionView[]) {
  const base = WORKSPACES[SYNTH_SLUG];
  const ws = {
    ...base,
    form: { ...base.form, questions, answerable: questions.length, total: questions.length, required_left: 0 },
  } as unknown as WorkspaceView;
  return renderRoutes([{ path: "*", element: <QuestionPanel ws={ws} /> }], "/");
}
