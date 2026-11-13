import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, vi } from "vitest";
import { FORMAT_VERSION, PesApiError, type ApiErrorCode, type CommandResult, type PesClient, type Receipt } from "@/api/types";
import { CURRENT } from "@/test/contract";
import { renderApp, type Env } from "@/test/render-app";
import { apiError } from "@/test/scripted-client";
import { ready } from "@/test/ui";
import { aside, createU2bClient, item, U2B_QUESTIONS, type U2bOptions, type Wire } from "@/test/u2b";

/**
 * SEL-92 U2c 시험 계약 — 답 초안 · 기본값 · 묶음/개별 제출 · 질문별 의견(앱, 가짜 클라이언트) + http 매핑.
 * 이슈 문구(stage-3.md U2 절, SEL-92, stage-1-ui.md F04·F06·F08, 승인 시안 QuestionPanel·AI 도우미 대화)와 U2a 서버 계약(SEL-90: tests/test_sel90_forms_submit.test.ts ·
 * test_sel90_comments.test.ts 머리말, docs/api/openapi-v1.yaml)에서 뽑은 해석이다. 구현을 추측해서 맞춘 것이 아니다.
 * 이름을 바꿔야 하면 구현이 아니라 이 파일(과 보고서의 해석)을 고치고 leader 에게 알린다. 합성 자료뿐(실제 자료·키·경로 없음).
 *
 * ═══ [정한 인터페이스] PesClient 에 더하는 쓰기·읽기 (types.ts 머리말에 그대로 옮긴다) ═══
 *   interface AnswerItemInput {
 *     question_id: string;
 *     question_version: number;                 // 이 답이 가리키는 질문 버전(화면이 보고 있던 버전) — 어긋나면 conflict(부분 접수 0)
 *     question_version_id?: string;             // 서버 버전 id(QuestionView.version_id 가 있을 때만) — http 는 그대로 AnswerItem.question_version_id 로
 *     value: string | string[] | null;          // 하나 고르기 = 선택지 id · 여러 개 = 선택지 id 배열 · 글 = 글 · 의견만 있으면 null
 *     comment?: string | null;                  // 그 질문의 “의견 칸” 글(제출에 붙는 의견; 스레드 의견과 다르다)
 *     used_default?: boolean;                   // 기본값 쓰기로 채운 뒤 바꾸지 않은 답일 때만 true — 제출 때만 기록된다
 *   }
 *   interface SubmitInput { mode: "bundle" | "single"; form_version: number; set_id?: string; answers: AnswerItemInput[] }
 *   interface SubmitResult { submission_id: string; answers: { question_id: string; state: "submitted" }[]; form_complete: boolean; missing_required: string[] }
 *   PesClient.submitAnswers(slug, edition, stage: string, round: string, input: SubmitInput, idempotencyKey: string | undefined): Promise<CommandResult<SubmitResult>>
 *     - 멱등 키 필수(없으면 invalid_payload) · 같은 키·같은 요청은 영수증 재생(replayed) · 거절은 PesApiError — 거절이면 아무것도 접수되지 않는다(부분 접수 0).
 *     - 거절 오류의 error.details: { reason: "required_missing", question_ids: string[] } | { reason: "not_applicable", question_ids } | { reason: "single_requires_one_item" }
 *       (U2a: invalid_payload) · 질문 버전이 어긋나면 conflict.  ApiError.error.details 는 types.ts 에 optional 로 더한다(서버 봉투는 이미 가진다).
 *     - mode "bundle": 이 제출 + 이미 낸 현재 답으로 폼의 “적용되는 필수 질문”이 모두 채워져야 한다. “적용된다” = show_if 없음, 또는 조건 질문의 답(이 제출 우선, 없으면 현재 답)이 in 의 값 중 하나(SEL-129: equals → in:[…]).
 *       의견(value null + comment)만 있는 항목은 질문의 allow_comment_as_answer 가 true 일 때만 필수를 채운다.
 *     - mode "single": 항목이 정확히 1개. 결과 form_complete 는 폼 전체가 채워졌는지, missing_required 는 아직 빈 적용 필수 질문 id 들.
 *   QuestionView 에 더하는 칸: allow_comment_as_answer?: boolean (없으면 false) · version_id?: string(서버 질문 버전 id; 가짜 클라이언트는 없어도 된다) · used_default?: boolean(보낸 답이 기본값 채택이었음; 읽기 전용)
 *   RoundView 에 더하는 칸: set_id?: string(서버 폼 세트 id; 없어도 된다)
 *
 *   interface CommentMessageView { message_id: string; body_md: string; at: IsoTime; by: "human" | "ai"; receipt_no?: string }
 *   interface CommentThreadView   { thread_id: string; question_id: string | "__other"; question_version?: number; messages: CommentMessageView[] }
 *   PesClient.getComments(slug, edition, stage, round): Promise<CommentThreadView[]>   // 이 라운드의 모든 스레드. “__other” = 이전된 프로젝트의 질문에 묶이지 않은 의견
 *   PesClient.addComment(slug, edition, questionId, input: { body_md: string; thread_id?: string; question_version?: number }, idempotencyKey: string | undefined):
 *       Promise<CommandResult<{ thread_id: string; message_id: string; thread_created: boolean }>>
 *     - thread_id 없으면 새 스레드(context_kind question_comment) + 첫 메시지, 있으면 그 스레드에 메시지만. 답·제출은 만들지 않는다. 멱등 키 필수.
 *
 * ═══ [화면 계약] (질문 영역 = aside "질문" 안; U2b 계약 위에 더함) ═══
 *   기본값·추천(카드 안, 서로 다른 단추):  단추 “질문 21 기본값 쓰기”(기본값이 있을 때만) · “질문 21 추천 쓰기”(추천이 있을 때만). 누르면 답 초안만 채운다(선택지 id / 글) — 쓰기 호출 0.
 *     누르기 전에는 답 칸이 비어 있고(라디오 0 · 글 ''), 눌러도 `[data-field-kind="answer"]`(보낸 답)는 생기지 않는다. 초안을 사람이 바꾸면 “기본값을 쓴 답”이 아니다(used_default=false).
 *   개별 제출: 단추 “질문 21 이 답만 보내기” — 그 질문 하나만 mode "single". 초안(답·의견)이 모두 비면 aria-disabled(눌러도 호출 0).
 *   재확인 필요(needs_recheck && 보낸 답 없음) 질문: 체크박스 “질문 21 새 문구를 확인했어요”. 체크 전에는 이 질문의 개별 제출·묶음 제출에서 빠지고 단추는 aria-disabled. 체크하면 제출된다.
 *   묶음 제출: 질문 영역 아래 단추 “답 검토 후 보내기”(U1c 자리 그대로; 보낼 초안이 하나도 없으면 aria-disabled) → dialog “답 검토” (모달; 제목은 접근 가능한 이름).
 *     dialog 안: 보낼 질문마다 `[data-review-item="<질문 id>"]`(답 요약 글), 기본값 그대로 보내는 항목에는 `[data-used-default]`, 아직 비어 있는 적용 필수 질문마다 `[data-missing="<질문 id>"]`(“질문 N”),
 *     확정 단추 “묶음으로 보내기”(필수가 비어 있으면 aria-disabled · 호출 0), 취소 “취소”(호출 0 · 초안 그대로). 보내는 동안 두 번 눌러도 호출 1번.
 *     show_if 가 안 맞는 질문(적용되지 않음)은 li 에 `data-applicable="false"`, 필수 취급·묶음 항목에서 모두 빠진다(초안은 지우지 않고 남긴다). 맞게 되면 다시 `data-applicable` 없음/"true".
 *   결과 알림(질문 영역 role=status): 성공은 영수증을 받은 뒤에만 — “접수 NNNN” 이 있고 그 전(보내는 중)에는 보낸 답 노드(`[data-field-kind="answer"]`)도 “접수” 글도 없다(F06).
 *     묶음 성공: “묶음” 글 + 접수 번호. 개별 성공: “이 답만” 글 + 접수 번호 + form_complete=false 이면 “필수 N개가 남았어요” — 폼 전체가 끝났다는 말(‘모두’ ‘완료’ ‘끝’)은 쓰지 않는다.
 *     성공한 질문의 초안만 지우고(보낸 것만) 나머지 초안은 남는다. 성공하면 라운드를 다시 읽는다(보낸 답이 `[data-field-kind="answer"]` 로 보임; 재확인 배지는 사라지고 옛 답은 `[data-badge="old-answer"]` 로 남는다).
 *   거절(부분 접수 0): 질문 영역 role=alert — 서버 문장 + “아무것도 접수되지 않았어요”. required_missing 이면 빠진 질문마다 단추/링크 “질문 N로 가기”(누르면 그 질문 항목에 초점).
 *     거절 뒤 초안은 그대로, 보낸 답 노드 없음. 같은 요청을 다시 누르면 같은 멱등 키, 초안을 바꾸면 새 키.
 *   시간 초과(TimeoutError): role=status 에 “접수 확인 중” — 보낸 답 노드 없음. 단추 “접수 다시 확인” → 같은 요청·같은 멱등 키로 다시 보낸다(영수증 재생이면 그대로 성공 처리).
 *
 *   질문별 의견(스레드): 카드 단추 “질문 21 의견 스레드”(aria-expanded; 펼침) → 그 카드 안 `[data-comments="<질문 id>"]`: 메시지 `li[data-message]`(글은 `[data-field-kind="comment"]`),
 *     textarea “질문 21 스레드 의견 쓰기”(요소 id 는 `<질문 id>-comment`), 단추 “스레드에 남기기”(글이 비면 aria-disabled · 호출 0). 의견은 답·기본값·추천·의견 칸(제출에 붙는 의견)과 다른 노드/말이다.
 *     남기면 addComment 한 번(스레드 없으면 thread_id 없이, 있으면 그 thread_id) + 영수증 뒤 role=status “접수 NNNN” + 메시지가 라운드/스레드 다시 읽기로 보임. 답 칸·보낸 답 노드는 그대로, submitAnswers 0.
 *     초안은 `pes-draft:` 저장소 항목(칸 이름 comment)으로 남아 접기/펴기·갱신·폼 버전 상승에도 유지되고, 한글 조합 중에는 저장하지 않으며, 성공한 뒤에만 지운다.
 *   “__other” 스레드(이전된 프로젝트): region “질문에 묶이지 않은 의견” 안에 메시지가 보이고 아무 것도 깨지지 않는다. 질문 칸이 하나도 없는 합성 질문(LEGACY)도 그대로 그려진다.
 *   화면 글자에 낱말 'Go' 는 없다. 'undefined' · 'null' · 'NaN' 이 새지 않는다.
 *
 * ═══ [http 매핑 계약] (app/src/api/u2c-http.test.ts) — createHttpClient 가 위 PesClient 쓰기를 U2a 라우트로 보낸다 ═══
 *   표는 그 시험 파일 머리말에 있다.
 */

export type { Wire };
export { aside, item, U2B_QUESTIONS };
export const SLUG = "sample-study";
export const EDITION = 1;
const AT = "2026-11-10T10:00:00+09:00";

/* ───────────── 합성 질문 ───────────── */

const base = { source: "ai", status: "open", direction: "ask_human", needs_recheck: false, previous_answer: null, recommendation: null, show_if: null, default_value: null, options: [] } as const;

/** 조사 R2 의 질문 — 하나 고르기(필수·기본값·추천) · 글(선택·기본값) · 조건부 · 의견만으로 답 가능 · 조건부 필수 · 재확인 */
export const U2C_QUESTIONS: Wire[] = [
  {
    ...base,
    id: "q-21",
    number: 21,
    version: 1,
    required: true,
    importance: "high",
    text: "대출 수 자료의 정의가 2021년에 바뀌었어요. 그 앞뒤를 한 줄로 이어 볼까요, 따로 볼까요?",
    kind: "single_choice",
    options: [
      { id: "join", label: "이어 보기" },
      { id: "split", label: "따로 보기" },
    ],
    default_value: "split",
    recommendation: { value: "join", reason: "추세를 한눈에 볼 수 있어서" },
  },
  { ...base, id: "q-22", number: 22, version: 1, required: false, importance: "normal", text: "더 깊이 볼 출처가 있으면 알려 주세요.", kind: "free_text", default_value: "추가 출처 없음" },
  {
    ...base,
    id: "q-23",
    number: 23,
    version: 1,
    required: false,
    importance: "low",
    text: "이어 보기로 정했다면 어떤 해석 주의 문구를 붙일까요?",
    kind: "multi_choice",
    options: [
      { id: "foot", label: "각주" },
      { id: "chart", label: "그림 설명" },
    ],
    show_if: { question_id: "q-21", in: ["join"] },
  },
  { ...base, id: "q-24", number: 24, version: 1, required: true, importance: "high", text: "AI 가 지금까지 가정한 것을 한 줄로 정리해 주세요.", kind: "free_text", allow_comment_as_answer: true },
  { ...base, id: "q-25", number: 25, version: 1, required: true, importance: "normal", text: "따로 본다면 두 구간의 경계 해를 적어 주세요.", kind: "free_text", allow_comment_as_answer: false, show_if: { question_id: "q-21", in: ["split"] } },
  {
    ...base,
    id: "q-26",
    number: 26,
    version: 3,
    required: true,
    importance: "normal",
    text: "새로 바뀐 문구: 전자책 대출을 합쳐 셀까요?",
    kind: "single_choice",
    options: [
      { id: "yes", label: "합쳐 세기" },
      { id: "no", label: "따로 세기" },
    ],
    needs_recheck: true,
    previous_answer: { answer: "따로 세기", version: 2, receipt_no: "0480", committed_at: "2026-11-09T09:00:00+09:00" },
  },
];

/** id 로 골라 순서대로 */
export const pick = (...ids: string[]): Wire[] => ids.map((id) => structuredClone(U2C_QUESTIONS.find((q) => q.id === id)!));
export const withFields = (q: Wire, extra: Wire): Wire => ({ ...q, ...extra });

/* ───────────── 오류 ───────────── */

export function errorWithDetails(code: string, details: Record<string, unknown> | null, message = "시험용 오류") {
  return new PesApiError({
    format_version: FORMAT_VERSION,
    error: { code: code as unknown as ApiErrorCode, message, retryable: false, target: "$.body", details, next_action: "reread_context" },
    request_id: "req-u2c",
  } as never);
}
export const requiredMissing = (ids: string[]) => errorWithDetails("invalid_payload", { reason: "required_missing", question_ids: ids }, "필수 질문에 아직 답이 없어서 접수하지 않았습니다.");
export const timeoutError = () => Object.assign(new Error("시간 초과"), { name: "TimeoutError" });

/* ───────────── 상태를 가진 시험용 클라이언트 ───────────── */

export interface CommentSeed {
  thread_id: string;
  question_id: string;
  question_version?: number;
  messages: { message_id: string; body_md: string; at?: string; by?: "human" | "ai" }[];
}
export interface U2cOptions extends U2bOptions {
  threads?: CommentSeed[];
  /** getComments 가 이 오류로 거절한다(서버에 목록 길이 없을 때 — 화면이 정직하게 알리고 깨지지 않아야 한다) */
  commentsError?: Error;
}
export interface SubmittedRecord {
  mode: string;
  question_id: string;
  question_version: number;
  question_version_id?: string;
  value: unknown;
  comment?: string | null;
  used_default?: boolean;
  key: string;
}

type Q = Wire & { id: string };
const labelsOf = (q: Q, value: unknown): string => {
  const opts = (q.options as { id: string; label: string }[]) ?? [];
  const one = (v: unknown) => opts.find((o) => o.id === v)?.label ?? String(v);
  return Array.isArray(value) ? value.map(one).join(", ") : one(value);
};
const filled = (v: unknown) => (Array.isArray(v) ? v.length > 0 : typeof v === "string" ? v.trim() !== "" : v !== null && v !== undefined);

export function createU2cClient(opts: U2cOptions = {}) {
  const h = createU2bClient({ ...opts, questions: opts.questions ?? U2C_QUESTIONS });
  const log = (method: string, args: unknown[]) => h.s.calls.push({ method, args, at: Date.now() });
  const done = new Map<string, { req: string; result: CommandResult<unknown> }>();
  const failures: Error[] = [];
  const raw = new Map<string, unknown>(); // 질문 id → 보낸 값(선택지 id / 글) — 조건 판단용
  const submitted: SubmittedRecord[] = [];
  const threads: CommentSeed[] = structuredClone(opts.threads ?? []);
  let gate: Promise<void> | null = null;
  let seq = 700;
  let msgSeq = 0;

  const receipt = (key: string, replayed = false): Receipt => {
    const n = ++seq;
    return { receipt_no: String(n).padStart(4, "0"), tx_id: `tx-${n}`, committed_at: AT, idempotency_key: key, replayed };
  };
  async function command<T>(method: string, args: unknown[], key: string | undefined, req: unknown, apply: () => T): Promise<CommandResult<T>> {
    log(method, args);
    if (gate) await gate;
    const fail = failures.shift();
    if (fail) throw fail;
    if (!key) throw apiError("invalid_payload", "멱등 키가 없습니다");
    const request = JSON.stringify([method, req]);
    const seen = done.get(key);
    if (seen) {
      if (seen.req !== request) throw apiError("idempotency_key_reuse");
      return { ...(seen.result as CommandResult<T>), receipt: { ...(seen.result as CommandResult<T>).receipt, replayed: true } };
    }
    const data = apply();
    const result: CommandResult<T> = { format_version: FORMAT_VERSION, request_id: `req-${seq}`, receipt: receipt(key), data };
    done.set(key, { req: request, result });
    return result;
  }

  const open = () => h.questions().filter((q) => ((q.status as string) ?? "open") === "open") as Q[];
  const valueOf = (id: string, items: Map<string, { value: unknown }>) => (items.has(id) ? items.get(id)!.value : raw.get(id));
  const applicable = (q: Q, items: Map<string, { value: unknown }>) => {
    const s = q.show_if as { question_id: string; in: string[] } | null | undefined;
    if (!s) return true;
    const v = valueOf(s.question_id, items);
    return (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v as string]).some((x) => s.in.includes(x));
  };
  const satisfied = (q: Q, items: Map<string, { value: unknown; comment?: string | null }>) => {
    if (items.has(q.id)) {
      const it = items.get(q.id)!;
      if (filled(it.value)) return true;
      return q.allow_comment_as_answer === true && filled(it.comment);
    }
    return q.sent !== undefined && q.sent !== null;
  };

  const client = {
    ...h.client,
    submitAnswers(slug: string, edition: number, stage: string, round: string, input: Wire, key: string | undefined) {
      return command("submitAnswers", [slug, edition, stage, round, input, key], key, [stage, round, input], () => {
        const answers = (input.answers as Wire[]) ?? [];
        const mode = input.mode as string;
        if (mode === "single" && answers.length !== 1) throw errorWithDetails("invalid_payload", { reason: "single_requires_one_item" });
        const qs = open();
        const items = new Map<string, { value: unknown; comment?: string | null; used_default?: boolean; version: number }>();
        for (const a of answers) {
          const q = qs.find((x) => x.id === a.question_id);
          if (!q) throw apiError("conflict", "닫혔거나 없는 질문이에요");
          if (a.question_version !== q.version) throw errorWithDetails("conflict", { reason: "stale_question_version", question_ids: [q.id] }, "질문이 그 사이 바뀌었어요. 새 문구를 확인해 주세요.");
          items.set(q.id, { value: a.value, comment: a.comment as string | null | undefined, used_default: a.used_default as boolean | undefined, version: a.question_version as number });
        }
        const bad = answers.filter((a) => filled(a.value) && !applicable(qs.find((x) => x.id === a.question_id)!, items)).map((a) => a.question_id as string);
        if (bad.length) throw errorWithDetails("invalid_payload", { reason: "not_applicable", question_ids: bad }, "지금은 답하지 않는 질문이에요.");
        const missingNow = qs.filter((q) => q.required === true && applicable(q, items) && !satisfied(q, items)).map((q) => q.id);
        if (mode === "bundle" && missingNow.length) throw errorWithDetails("invalid_payload", { reason: "required_missing", question_ids: missingNow }, "필수 질문에 아직 답이 없어서 접수하지 않았습니다.");
        const sub = `sub-${seq + 1}`;
        h.mutate((all) => {
          for (const [id, it] of items) {
            const q = all.find((x) => x.id === id)!;
            if (filled(it.value)) {
              q.sent = { answer: labelsOf(q as Q, it.value), receipt_no: String(seq + 1).padStart(4, "0"), tx_id: `tx-${seq + 1}`, committed_at: AT };
              raw.set(id, it.value);
              q.used_default = it.used_default === true;
            } else if (filled(it.comment) && q.allow_comment_as_answer === true) {
              q.sent = { answer: String(it.comment), receipt_no: String(seq + 1).padStart(4, "0"), tx_id: `tx-${seq + 1}`, committed_at: AT };
            }
            if (q.sent) q.needs_recheck = false;
          }
        });
        for (const a of answers) {
          submitted.push({ mode, question_id: a.question_id as string, question_version: a.question_version as number, question_version_id: a.question_version_id as string | undefined, value: a.value, comment: a.comment as string | null | undefined, used_default: a.used_default as boolean | undefined, key: key! });
        }
        const after = open();
        const missing = after.filter((q) => q.required === true && applicable(q, new Map()) && !(q.sent !== undefined && q.sent !== null)).map((q) => q.id);
        return { submission_id: sub, answers: answers.map((a) => ({ question_id: a.question_id as string, state: "submitted" as const })), form_complete: missing.length === 0, missing_required: missing };
      });
    },
    async getComments(_slug: string, _edition: number, _stage: string, _round: string) {
      log("getComments", []);
      if (opts.commentsError) throw opts.commentsError;
      return structuredClone(threads.map((t) => ({ ...t, messages: t.messages.map((m) => ({ at: AT, by: "human", ...m })) })));
    },
    addComment(slug: string, edition: number, questionId: string, input: Wire, key: string | undefined) {
      return command("addComment", [slug, edition, questionId, input, key], key, [questionId, input], () => {
        const body = String(input.body_md ?? "");
        if (!body.trim()) throw apiError("invalid_payload", "의견이 비었어요");
        let t = input.thread_id ? threads.find((x) => x.thread_id === input.thread_id) : undefined;
        if (input.thread_id && !t) throw apiError("not_found", "스레드를 찾을 수 없어요");
        const created = !t;
        if (!t) {
          t = { thread_id: `th-${threads.length + 1}`, question_id: questionId, ...(input.question_version ? { question_version: input.question_version as number } : {}), messages: [] };
          threads.push(t);
        }
        const message_id = `msg-${++msgSeq}`;
        t.messages.push({ message_id, body_md: body, at: AT, by: "human" });
        return { thread_id: t.thread_id, message_id, thread_created: created };
      });
    },
  } as unknown as PesClient;

  const calls = (method: string) => h.s.calls.filter((c) => c.method === method);
  return {
    ...h,
    client,
    calls,
    /** 보낸 항목 기록(서버가 받아들인 것만) */
    submitted: () => structuredClone(submitted),
    /** 다음 submitAnswers/addComment 하나를 이 오류로 거절한다(요청은 기록된다) */
    failNextWrite: (e: Error) => void failures.push(e),
    /** 다음 쓰기들을 release() 를 부를 때까지 붙잡아 둔다(영수증 전 화면을 본다) */
    hold: () => {
      let release!: () => void;
      gate = new Promise<void>((r) => (release = r));
      return () => {
        gate = null;
        release();
      };
    },
    threads: () => structuredClone(threads),
  };
}
export type U2cHarness = ReturnType<typeof createU2cClient>;

/* ───────────── 시작 ───────────── */

export async function boot(opts: U2cOptions = {}, path = CURRENT, env: Env = {}) {
  const h = createU2cClient(opts);
  const user = userEvent.setup(vi.isFakeTimers() ? { advanceTimers: vi.advanceTimersByTime } : {});
  const app = await renderApp(path, { width: 1440, ...env }, { client: h.client });
  await ready();
  await screen.findByRole("radiogroup", { name: "질문 거르기" }).catch(() => undefined);
  return { ...h, user, ...app };
}

/* ───────────── 화면 찾기 ───────────── */

export const btn = (name: string | RegExp) => within(aside()).getByRole("button", { name });
export const maybeBtn = (name: string | RegExp) => within(aside()).queryByRole("button", { name });
export const field = (qid: string) => document.getElementById(qid) as HTMLTextAreaElement;
export const opinion = (qid: string) => document.getElementById(`${qid}-opinion`) as HTMLTextAreaElement;
export const sentNode = (qid: string) => item(qid).querySelector<HTMLElement>('[data-field-kind="answer"]');
export const isDisabled = (el: HTMLElement) => el.getAttribute("aria-disabled") === "true" || (el as HTMLButtonElement).disabled === true;
export const notice = () => within(aside()).getAllByRole("status").map((e) => e.textContent ?? "").join(" ");
export const alertText = () => within(aside()).queryAllByRole("alert").map((e) => e.textContent ?? "").join(" ");
export const reviewDialog = () => screen.findByRole("dialog", { name: "답 검토" });
export const checkedIn = (qid: string) => [...item(qid).querySelectorAll<HTMLInputElement>('input[type="radio"]:checked, input[type="checkbox"]:checked')].map((i) => i.closest("label")?.textContent?.trim() ?? i.value);
export const waitSent = (qid: string) => waitFor(() => expect(sentNode(qid)).not.toBeNull());
export const activeQuestion = () => (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-question]")?.dataset.question ?? null;
/** 'Go' · undefined 새기 */
export const leaks = (root: HTMLElement = document.body) => (root.textContent ?? "").match(/\bGo\b|undefined|\bnull\b|NaN|\[object/g) ?? [];

