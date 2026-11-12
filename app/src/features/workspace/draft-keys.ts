import { draftKey, originForm, type DraftField } from "@/lib/draft";

/** 로그인 없는 이 컴퓨터 화면의 사용자 칸(초안 키) — 로그인이 생기면 사용자 id 로 바뀐다 */
export const DRAFT_USER = "local";

export type DraftScope = { project: string; edition: number; form: number };

/** 초안 키 — 폼 버전 칸은 그 질문 버전이 이 탭에 처음 보인 때의 것(폼이 올라가도 질문 버전이 같으면 같은 키) */
export const keyFor = (scope: DraftScope, question: string, version: number, field: DraftField, write = true) =>
  draftKey({ project: scope.project, user: DRAFT_USER, edition: scope.edition, form: originForm({ project: scope.project, user: DRAFT_USER, edition: scope.edition, question, version }, scope.form, write), question, version, field });
