import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FORMAT_VERSION, PesApiError, type CommandResult, type PesClient, type RoundView, type StageKey } from "@/api/types";
import { renderApp, type Env } from "@/test/render-app";
import { createScriptedClient } from "@/test/scripted-client";
import { url } from "@/test/contract";
import { ready } from "@/test/ui";

/**
 * SEL-112 U4b 시험 계약 — 결과 글 선택 도구(첨언 / AI에게 묻기 / 할 일로) · 앵커 4상태 · edit_text 제안 채택 · 해결과 반영 구분(앱).
 * 근거: 이슈 SEL-112 · 부모 SEL-107, 설계 dashboard-v2.md 352~356행 · 611행(첨언 앵커 4상태) · 1061행(첨언 "해결" 4갈래), 승인 시안 ResultPanel.tsx(선택 도구 · 첨언 카드 · 해결 메뉴) · status-registry 의 anchor,
 * 서버 계약 SEL-99(U4a) 머리말 표(tests/test_sel99_annotation.test.ts · test_sel99_thread_api.test.ts · _anchor_status · _followup).
 * 구현을 추측해서 맞춘 것이 아니다. 이름을 바꿔야 하면 구현이 아니라 이 파일(과 보고서의 해석)을 고치고 leader 에게 알린다. 합성 자료뿐(실제 자료·키·경로 없음).
 *
 * ═══ 스스로 정한 인터페이스 ═══
 *
 * [순수 함수 — `@/lib/anchor-text` (src/lib/anchor-text.ts)] 위치 단위는 서버와 같은 code point(유니코드 스칼라). 정규화·줄바꿈 변환 없음(NFD 한글 = 3, CRLF = 2).
 *   cpLength(text): number
 *   cpToUtf16(text, cp): number         0 ≤ cp ≤ cpLength 정수가 아니면 RangeError
 *   utf16ToCp(text, index): number      0 ≤ index ≤ text.length 정수가 아니거나 서로게이트 쌍 한가운데면 RangeError
 *   sliceCp(text, startCp, endCp): string
 *   snapUtf16Range(text, start, end): { start, end }   쌍 한가운데에서 시작/끝난 DOM 위치를 쌍 바깥으로 넓힌다(서버가 외톨이 서로게이트를 거절하므로)
 *   findQuote(text, quote): { start_cp, end_cp }[]     글자 그대로 나오는 모든 자리(겹쳐도 센다). 빈 인용문 → []
 *
 * [PesClient 확장 — types.ts 에 추가. HTTP 매핑은 sel112-http.test.ts]
 *   RoundView.result 에 선택 칸 3개: object_id?: string · version_id?: string · body_md?: string. 셋이 모두 있어야 선택 도구가 켜진다(서버가 안 주면 없다 — 지어내지 않는다).
 *     body_md 는 서버 글 버전 본문 그대로(앵커 위치의 기준). paragraphs 는 기존 그대로(없는 곳과 같은 화면 호환).
 *   읽기:  getAnnotations(slug, edition, objectId): Promise<AnnotationThreadView[]>        그 글(object) 의 첨언 스레드 전부(열림 · 해결됨), 없으면 [] · 모르는 판 []
 *   쓰기(멱등 키 필수, 거절은 PesApiError, 모두 CommandResult):
 *     createAnnotation(slug, edition, input: AnnotationInput, key)  → { thread_id, message_id, anchor_id, anchor_status: "exact" | "moved" }
 *     replyAnnotation(slug, edition, threadId, { body_md }, key)    → { thread_id, message_id }
 *     resolveAnnotation(slug, edition, threadId, { resolution, reason, target_stage?, base_version_id? }, key)  → { thread_id, state: "resolved", followup_id: string | null, applied: false }   사람만
 *     reanchorAnnotation(slug, edition, threadId, { version_id?, start_cp, end_cp }, key) → { thread_id, anchor_status }   다시 붙이기(사람만)
 *     proposeFollowup(slug, edition, input: { origin_thread_id, kind, description, target_stage? }, key) → { followup_id, state: "proposed" }   ("할 일로" 는 next_round_task 제안만 — 바로 적용하지 않는다)
 *     applyFollowup(slug, edition, followupId, { base_version_id, expected_rev }, key) → { followup_id, state, result_version_id: string | null, applied_tx_id: string | null }   사람만
 *       base_version_id = 후속이 제안된 기반 버전(FollowupDetail.base_version_id) · expected_rev = FollowupDetail.version_no (10진 문자열, 서버 그대로)
 *   ApiErrorCode 에 "basis_changed" · "thread_closed" · "already_resolved" · "human_required" · "forbidden" · "validation_failed" 를 더한다(서버 닫힌 목록).
 *
 * [AnnotationInput] { target_object_id, target_version_id, anchor: { exact_quote, prefix, suffix, start_cp, end_cp }, body_md }
 *   화면은 항상 start_cp/end_cp 를 싣는다(반복 인용을 서버가 못 가를 때를 피함). prefix/suffix 는 body_md 에서 그 자리 바로 앞/뒤 글(문단 경계 포함, 길이는 구현 몫 — 반복 인용이면 비어 있지 않다).
 *
 * [AnnotationThreadView] (서버 GET P/threads/{t} 모양을 평평하게)
 *   { thread_id, state: "open" | "resolved" | "archived", target_object_id, target_version_id,
 *     anchor: { exact_quote, prefix, suffix, start_cp, end_cp, target_version_id,
 *               current: { evaluated_version_id, status: "exact"|"moved"|"ambiguous"|"lost", start_cp: number|null, end_cp: number|null, text: string|null,
 *                          candidates: {start_cp,end_cp}[], confirmed_by_actor_id: string|null } },
 *     messages: { message_id, body_md, at, actor_id, by: "human"|"ai"|null }[],        by = null: 서버가 행위자 종류를 주지 않는다(HTTP). 화면은 null 이면 사람/AI 라고 쓰지 않는다
 *     resolution: { resolution: "edit_text"|"next_round_task"|"reopen_stage"|"none", reason, followup_id: string|null } | null,
 *     followups: FollowupDetail[] }
 *   표시 상태는 anchor.current.status(글의 현재 버전 기준 판정)다. 위치(start_cp/end_cp)는 current 가 있을 때 current 것, 없으면(ambiguous·lost) null.
 * [FollowupDetail] { id, kind, state: "proposed"|"accepted"|"running"|"applied"|"deferred"|"rejected"|"cancelled", description, version_no: string, origin_thread_id,
 *                    base_version_id: string|null, proposed_body_md: string|null, proposed_version_id: string|null, result_version_id: string|null, applied_tx_id: string|null, confirmed_by_actor_id: string|null }
 *
 * ═══ 화면 계약 ═══
 *  - 결과 글(조사 R2 본문 article) 은 body_md 가 있으면 블록으로 그린다: 문단 <p data-cp-start="N">, 표는 role=table 의 <th>/<td data-cp-start="N">. N = 그 블록 글이 body_md 에서 시작하는 code point 위치,
 *    블록 textContent 는 body_md 의 [N, N+길이) 와 글자 그대로 같다(표 칸은 앞뒤 공백 뺀 글). 파이프·구분줄은 보이지 않는다.
 *  - 선택 도구: role=toolbar 이름 "선택한 글 도구", 단추 "첨언" · "AI에게 묻기" · "할 일로". 접히지 않은 선택이 한 블록 안에 있을 때만 있다(선택 없음 · 접힘 · 블록을 넘나듦 · 결과 글 밖 · 휴대폰 → 없음).
 *    Alt+M(e.code === "KeyM", 맥의 Option+M 은 key 가 "µ") = 선택이 있으면 도구의 첫 단추로 초점을 옮긴다(선택은 유지). 선택이 없으면 아무 일 없음(도구도 안 생김). Esc = 도구를 닫는다.
 *  - 첨언: 대화 상자 "첨언 달기"(인용 표시, textbox "첨언", 단추 "첨언 달기" · "취소"). 빈 글이면 호출 없이 textbox aria-invalid="true". 보내는 동안 aria-disabled(초점 유지)·한 번만.
 *    성공 = role=status "접수 <receipt_no>" · 대화 상자 닫힘 · 목록은 영수증 뒤 다시 읽어 나타난다(낙관적 갱신 없음). 영수증 오기 전에는 "접수 확인 중".
 *  - 첨언 목록: region 이름 "첨언", 스레드 하나 = [data-thread="<id>"][data-anchor-status=…][data-state=open|resolved|archived]. 인용(“…”)은 늘 보인다.
 *    앵커 상태 낱말(상태 사전 anchor): exact "그대로" · moved "위치 바뀜" · ambiguous "후보 여럿" · lost "원문 없음" (색만으로 알리지 않는다).
 *    exact·moved 인 스레드는 결과 글의 그 자리(current 위치)에 <mark data-thread="<id>"> 로 표시된다. ambiguous·lost 는 글에 표시하지 않는다(추측 금지) — 목록에는 그대로 있다.
 *    ambiguous: radiogroup "후보" 의 radio 가 후보 수만큼(아무것도 미리 고르지 않음), 단추 "이 후보로 붙이기" 는 고르기 전 aria-disabled. 고르고 누르면 reanchorAnnotation(후보 위치). 자동 선택·자동 호출 없음.
 *    lost: 인용·메시지 그대로 + 단추 "다시 붙이기" → 상태 글 "새 구간을 고르세요" · 글에서 선택하면 도구가 "이 구간에 붙이기" 하나로 바뀌고 누르면 reanchorAnnotation(선택 위치).
 *  - 후속(edit_text 제안): 스레드 안 [data-followup="<id>"][data-state=…], 제안 글 전체 표시, 단추 "채택" → 대화 상자 "글 수정 채택"(단추 "새 버전으로 채택" · "취소").
 *    지금 글 버전(round.result.version_id) ≠ 후속 base_version_id 이면 "채택" 은 aria-disabled + 이유 글("기반" 포함)이고 호출 0. 같으면 base_version_id = 후속 base, expected_rev = version_no 로 보낸다.
 *    409 basis_changed → role=alert 에 서버 문장, 대화 상자와 글 그대로, 자동 재시도 없음, 읽기를 다시 한다. 성공 표시("접수 …" · 후속 data-state=applied · 글이 새 본문)는 영수증 뒤에만.
 *  - 해결 ≠ 반영: 해결 = 단추 "해결"(메뉴 항목 "글 수정" · "다음 라운드 할 일" · "앞 단계 다시 열기" · "그냥 닫기") → 대화 상자 "첨언 해결"(textbox "해결 이유" 필수, 단추 "해결 기록" · "취소").
 *    해결된 스레드는 낱말 "해결됨". "반영됨"이라는 낱말은 어디에도 쓰지 않고, 후속이 applied 일 때만 "적용"이라 쓴다. 해결됨 + 후속 제안 상태는 "반영 전"(아직 반영 안 됨)이라고 쓴다.
 *    해결된 스레드의 "답글" 은 aria-disabled + 이유("해결"), "해결" 메뉴는 없다.
 *  - "AI에게 묻기" = U5 자리: 클라이언트 쓰기 0 · 클립보드 0 · 프롬프트 복사 단추와 별개. 눌러도 상태 글(role=status)에 "아직" 이 든 안내만 나온다.
 *  - "할 일로": 대화 상자 "다음 라운드 할 일"(인용 표시, textbox "할 일", 단추 "할 일로 남기기" · "취소") → createAnnotation 뒤 proposeFollowup(kind next_round_task, origin_thread_id = 방금 만든 스레드, description = 글). 적용(applyFollowup)은 하지 않는다.
 */

/* ───────────── 타입(정한 인터페이스) ───────────── */

export interface Cand {
  start_cp: number;
  end_cp: number;
}
export type AnchorStatus = "exact" | "moved" | "ambiguous" | "lost";
export type FollowupKind = "edit_text" | "next_round_task" | "reopen_stage" | "none";
export interface FollowupDetail {
  id: string;
  kind: FollowupKind;
  state: "proposed" | "accepted" | "running" | "applied" | "deferred" | "rejected" | "cancelled";
  description: string;
  version_no: string;
  origin_thread_id: string;
  base_version_id: string | null;
  proposed_body_md: string | null;
  proposed_version_id: string | null;
  result_version_id: string | null;
  applied_tx_id: string | null;
  confirmed_by_actor_id: string | null;
}
export interface AnnotationThreadView {
  thread_id: string;
  state: "open" | "resolved" | "archived";
  target_object_id: string;
  target_version_id: string;
  anchor: {
    exact_quote: string;
    prefix: string;
    suffix: string;
    start_cp: number;
    end_cp: number;
    target_version_id: string;
    current: { evaluated_version_id: string; status: AnchorStatus; start_cp: number | null; end_cp: number | null; text: string | null; candidates: Cand[]; confirmed_by_actor_id: string | null };
  };
  messages: { message_id: string; body_md: string; at: string; actor_id: string; by: "human" | "ai" | null }[];
  resolution: { resolution: FollowupKind; reason: string; followup_id: string | null } | null;
  followups: FollowupDetail[];
}
export interface AnnotationInput {
  target_object_id: string;
  target_version_id: string;
  anchor: { exact_quote: string; prefix: string; suffix: string; start_cp: number; end_cp: number };
  body_md: string;
}

/* ───────────── 합성 글 · 위치 계산(구현과 무관한 독립 계산) ───────────── */

export const OBJ = "obj-r2-result";
export const VER1 = "ver-r2-1";
export const VER2 = "ver-r2-2";
export const VER3 = "ver-r2-3";

export const FAMILY = "\u{1F468}‍\u{1F469}"; // 👨‍👩 — code point 3 · UTF-16 5
export const GRIN = "\u{1F600}"; // 😀 — code point 1 · UTF-16 2

export const P_HANGUL = "1장 정책 대안은 두 가지다. 첫째는 현행 유지다.";
export const P_EMOJI = `${GRIN} 이모지 뒤 문장이다. ${FAMILY} 가족 문장이다.`;
export const TABLE = ["| 항목 | 값 |", "|---|---|", "| 가 | 1 |", `| 나 | ${GRIN}2 |`].join("\n");
export const P_REPEAT = "같은 말이다. 중간 설명이다. 같은 말이다.";
export const BODY = [P_HANGUL, P_EMOJI, TABLE, P_REPEAT].join("\n\n");
/** 다른 사람이 낸 새 글 버전 — 제안(NEW_BODY)과 다른 문장을 고쳤다 */
export const BODY_V2 = BODY.replace("중간 설명이다.", "중간 설명을 고쳤다.");
export const NEW_BODY = [P_HANGUL.replace("첫째는 현행 유지다.", "첫째는 현행 유지이고 근거는 부록 A 에 있다."), P_EMOJI, TABLE, P_REPEAT].join("\n\n");

export const cps = (s: string): string[] => Array.from(s);
export const cpLen = (s: string): number => cps(s).length;
/** text 안에서 needle 의 nth(0부터) 번째 자리 — code point 위치 */
export function cpAt(text: string, needle: string, nth = 0): Cand {
  const all = cps(text);
  const n = cps(needle);
  let seen = -1;
  for (let i = 0; i + n.length <= all.length; i++) {
    if (all.slice(i, i + n.length).join("") === needle && ++seen === nth) return { start_cp: i, end_cp: i + n.length };
  }
  throw new Error(`시험 준비 오류: "${needle}" ${nth}번째가 본문에 없다`);
}
export const sliceBy = (text: string, c: Cand): string => cps(text).slice(c.start_cp, c.end_cp).join("");
export const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/* ───────────── 합성 스레드 ───────────── */

const HUMAN_ID = "act-h1";
const stamp = "2026-11-12T14:00:00+09:00";

export const QUOTE_A = "정책 대안은 두 가지다.";
export const QUOTE_REPEAT = "같은 말이다.";

export function thread(id: string, over: Partial<AnnotationThreadView> & { status?: AnchorStatus; at?: Cand | null; candidates?: Cand[]; quote?: string; body?: string } = {}): AnnotationThreadView {
  const quote = over.quote ?? QUOTE_A;
  const status = over.status ?? "exact";
  // 옛 버전에는 있었지만 지금 본문에는 없는 인용(lost)이면 옛 위치를 0 부터로 둔다
  const orig = BODY.includes(quote) ? cpAt(BODY, quote) : { start_cp: 0, end_cp: cpLen(quote) };
  const at = over.at === undefined ? (status === "ambiguous" || status === "lost" ? null : orig) : over.at;
  const { status: _s, at: _a, candidates, quote: _q, body, ...rest } = over;
  return {
    thread_id: id,
    state: "open",
    target_object_id: OBJ,
    target_version_id: VER1,
    anchor: {
      exact_quote: quote,
      prefix: "1장 ",
      suffix: " 첫째는 현행 유지다.",
      start_cp: orig.start_cp,
      end_cp: orig.end_cp,
      target_version_id: VER1,
      current: { evaluated_version_id: VER1, status, start_cp: at?.start_cp ?? null, end_cp: at?.end_cp ?? null, text: at ? quote : null, candidates: candidates ?? [], confirmed_by_actor_id: null },
    },
    messages: [{ message_id: `${id}-m1`, body_md: body ?? `첨언 ${id}: 이 문장의 근거를 더 설명해 주세요.`, at: stamp, actor_id: HUMAN_ID, by: "human" }],
    resolution: null,
    followups: [],
    ...rest,
  };
}

export const followup = (id: string, threadId: string, over: Partial<FollowupDetail> = {}): FollowupDetail => ({
  id,
  kind: "edit_text",
  state: "proposed",
  description: "근거를 한 문장 더한다",
  version_no: "1",
  origin_thread_id: threadId,
  base_version_id: VER1,
  proposed_body_md: NEW_BODY,
  proposed_version_id: "ver-proposed-1",
  result_version_id: null,
  applied_tx_id: null,
  confirmed_by_actor_id: null,
  ...over,
});

/* ───────────── 가짜 U4 클라이언트 ───────────── */

export interface U4Call {
  method: string;
  slug: string;
  id?: string;
  input: Record<string, unknown>;
  key: string | undefined;
}
export interface U4Init {
  threads?: AnnotationThreadView[];
  /** 글에 body_md · object_id · version_id 를 싣지 않는다(서버가 안 주는 경우) */
  withoutBody?: boolean;
  version?: string;
  body?: string;
}

export function apiFail(code: string, message = "시험용 거절 문장", details: Record<string, unknown> | null = null) {
  return new PesApiError({ format_version: FORMAT_VERSION, error: { code: code as never, message, retryable: false, next_action: "reread_context", details }, request_id: "req-u4b" });
}

export function createU4Client(init: U4Init = {}) {
  const s = createScriptedClient();
  const threads = structuredClone(init.threads ?? []);
  const state = { version: init.version ?? VER1, body: init.body ?? BODY, versionNo: 1 };
  const calls: U4Call[] = [];
  const reads: { method: string; args: unknown[] }[] = [];
  const done = new Map<string, CommandResult<unknown>>();
  let seq = 1200;
  let gate: Promise<void> | null = null;
  let open: () => void = () => {};
  let failure: Error | null = null;
  let next = 1;

  const result = <T,>(data: T, key: string | undefined): CommandResult<T> => {
    const n = String(++seq).padStart(4, "0");
    return { format_version: FORMAT_VERSION, request_id: `req-${n}`, receipt: { receipt_no: n, tx_id: `tx-${n}`, committed_at: new Date().toISOString(), idempotency_key: key ?? "", replayed: false }, data };
  };

  s.patchRound("research/2", (r: RoundView): RoundView => {
    if (init.withoutBody) return r;
    const base = r.result ?? { title: "조사 결과 R2", status: "draft" as const, updated_at: stamp, paragraphs: [] };
    const result = { ...base, version: state.versionNo, object_id: OBJ, version_id: state.version, body_md: state.body, paragraphs: state.body.split("\n\n") };
    return { ...r, result };
  });

  const findThread = (id: string) => {
    const t = threads.find((x) => x.thread_id === id);
    if (!t) throw apiFail("not_found", "스레드를 찾을 수 없습니다.");
    return t;
  };
  const findFollowup = (id: string) => {
    for (const t of threads) {
      const f = t.followups.find((x) => x.id === id);
      if (f) return f;
    }
    throw apiFail("not_found", "후속을 찾을 수 없습니다.");
  };

  async function command<T>(method: string, slug: string, id: string | undefined, input: Record<string, unknown>, key: string | undefined, apply: () => T): Promise<CommandResult<T>> {
    calls.push({ method, slug, id, input: structuredClone(input), key });
    if (gate) await gate;
    if (failure) {
      const f = failure;
      failure = null;
      throw f;
    }
    if (key && done.has(key)) return { ...(structuredClone(done.get(key)!) as CommandResult<T>), receipt: { ...done.get(key)!.receipt, replayed: true } };
    const r = result(apply(), key);
    if (key) done.set(key, r);
    return r;
  }

  const u4 = {
    async getAnnotations(slug: string, edition: number, objectId: string) {
      reads.push({ method: "getAnnotations", args: [slug, edition, objectId] });
      return structuredClone(threads.filter((t) => t.target_object_id === objectId));
    },
    createAnnotation: (slug: string, _e: number, input: AnnotationInput, key: string | undefined) =>
      command("createAnnotation", slug, undefined, { ...input }, key, () => {
        const id = `th-new-${next++}`;
        const c = { start_cp: input.anchor.start_cp, end_cp: input.anchor.end_cp };
        const t = thread(id, { quote: input.anchor.exact_quote, at: c, body: input.body_md });
        t.anchor.start_cp = c.start_cp;
        t.anchor.end_cp = c.end_cp;
        t.anchor.prefix = input.anchor.prefix;
        t.anchor.suffix = input.anchor.suffix;
        threads.push(t);
        return { thread_id: id, message_id: `${id}-m1`, anchor_id: `${id}-anc`, anchor_status: "exact" as const };
      }),
    replyAnnotation: (slug: string, _e: number, threadId: string, input: { body_md: string }, key: string | undefined) =>
      command("replyAnnotation", slug, threadId, { ...input }, key, () => {
        const t = findThread(threadId);
        if (t.state !== "open") throw apiFail("thread_closed", "닫힌 스레드에는 답글을 달 수 없습니다. 새 첨언을 열어 주세요.", { thread_id: threadId, state: t.state });
        const m = { message_id: `${threadId}-m${t.messages.length + 1}`, body_md: input.body_md, at: stamp, actor_id: HUMAN_ID, by: "human" as const };
        t.messages.push(m);
        return { thread_id: threadId, message_id: m.message_id };
      }),
    resolveAnnotation: (slug: string, _e: number, threadId: string, input: { resolution: FollowupKind; reason: string; target_stage?: StageKey; base_version_id?: string }, key: string | undefined) =>
      command("resolveAnnotation", slug, threadId, { ...input }, key, () => {
        const t = findThread(threadId);
        if (t.state !== "open") throw apiFail("already_resolved", "이미 해결된 첨언입니다.", { thread_id: threadId, state: t.state });
        // 실제 서버 규칙: 단계가 필요한 갈래(next_round_task · reopen_stage)는 followup.target_stage_id 없이는 거절, none 이 아니면 후속이 같이 만들어진다
        if ((input.resolution === "next_round_task" || input.resolution === "reopen_stage") && !input.target_stage) throw apiFail("invalid_payload", "단계를 알 수 없어 해결을 보낼 수 없습니다.", { reason: "target_stage_required" });
        let followupId: string | null = null;
        if (input.resolution !== "none") {
          const f = followup(`fu-new-${next++}`, t.thread_id, { kind: input.resolution, description: input.reason, proposed_body_md: null, proposed_version_id: null, base_version_id: null });
          t.followups.push(f);
          followupId = f.id;
        }
        t.state = "resolved";
        t.resolution = { resolution: input.resolution, reason: input.reason, followup_id: followupId };
        return { thread_id: threadId, state: "resolved" as const, followup_id: followupId, applied: false as const };
      }),
    reanchorAnnotation: (slug: string, _e: number, threadId: string, input: { version_id?: string; start_cp: number; end_cp: number }, key: string | undefined) =>
      command("reanchorAnnotation", slug, threadId, { ...input }, key, () => {
        const t = findThread(threadId);
        const c = { start_cp: input.start_cp, end_cp: input.end_cp };
        const same = sliceBy(state.body, c) === t.anchor.exact_quote;
        t.anchor.current = { evaluated_version_id: state.version, status: same ? "moved" : "moved", start_cp: c.start_cp, end_cp: c.end_cp, text: sliceBy(state.body, c), candidates: [], confirmed_by_actor_id: HUMAN_ID };
        return { thread_id: threadId, anchor_status: "moved" as const };
      }),
    proposeFollowup: (slug: string, _e: number, input: { origin_thread_id: string; kind: FollowupKind; description: string }, key: string | undefined) =>
      command("proposeFollowup", slug, input.origin_thread_id, { ...input }, key, () => {
        const t = findThread(input.origin_thread_id);
        const f = followup(`fu-new-${next++}`, t.thread_id, { kind: input.kind, description: input.description, proposed_body_md: null, proposed_version_id: null, base_version_id: null });
        t.followups.push(f);
        return { followup_id: f.id, state: "proposed" as const };
      }),
    applyFollowup: (slug: string, _e: number, followupId: string, input: { base_version_id: string; expected_rev: string }, key: string | undefined) =>
      command("applyFollowup", slug, followupId, { ...input }, key, () => {
        const f = findFollowup(followupId);
        if (input.base_version_id !== state.version) throw apiFail("basis_changed", "그사이 결과 글이 바뀌었습니다. 새 버전 기준으로 다시 확인해 주세요.", { expected: input.base_version_id, current: state.version, current_rev: f.version_no });
        if (input.expected_rev !== f.version_no) throw apiFail("rev_conflict", "후속이 그사이 바뀌었습니다.");
        state.version = VER2;
        state.versionNo += 1;
        state.body = f.proposed_body_md ?? state.body;
        f.state = "applied";
        f.result_version_id = VER2;
        f.applied_tx_id = `tx-ap-${seq + 1}`;
        f.version_no = String(Number(f.version_no) + 1);
        return { followup_id: followupId, state: "applied" as const, result_version_id: VER2, applied_tx_id: f.applied_tx_id };
      }),
  };

  const client = { ...s.client, ...u4 } as unknown as PesClient;
  return {
    s,
    client,
    threads,
    state,
    calls,
    reads,
    callsOf: (method: string) => calls.filter((c) => c.method === method),
    /** 클라이언트가 받은 쓰기 전부(읽기 제외) */
    writes: () => calls,
    /** 다음 쓰기를 release() 까지 붙잡는다 */
    hold() {
      gate = new Promise<void>((res) => (open = res));
      return () => {
        gate = null;
        open();
      };
    },
    failNext: (err: Error) => void (failure = err),
    /** 서버에서 글이 그사이 새 버전으로 바뀐 것처럼 */
    bumpVersion(to = VER3, body = BODY_V2) {
      state.version = to;
      state.body = body;
      state.versionNo += 1;
    },
  };
}
export type U4Client = ReturnType<typeof createU4Client>;

/* ───────────── 화면 열기 · 찾기 ───────────── */

export const R2 = url("research", 2);

export async function boot(init: U4Init = {}, env: Env = {}, path = R2) {
  const u4 = createU4Client(init);
  const user = userEvent.setup();
  const app = await renderApp(path, { width: 1440, ...env }, { client: u4.client });
  await ready();
  return { u4, user, ...app };
}

export const article = () => screen.getByRole("main").querySelector<HTMLElement>("article")!;
export const toolbar = () => screen.queryByRole("toolbar", { name: "선택한 글 도구" });
export const annotationRegion = () => screen.getByRole("region", { name: "첨언" });
export const threadEl = (id: string) => document.querySelector<HTMLElement>(`[data-thread="${id}"]:not(mark)`);
export const threadOf = async (id: string): Promise<HTMLElement> =>
  waitFor(() => {
    const el = threadEl(id);
    if (!el) throw new Error(`스레드 ${id} 가 아직 없다`);
    return el;
  });
/** body_md 블록(문단 · 표 칸) 중 글이 text 를 포함하는 것 */
export function blockWith(text: string, nth = 0): HTMLElement {
  const hits = [...article().querySelectorAll<HTMLElement>("[data-cp-start]")].filter((el) => (el.textContent ?? "").includes(text));
  const el = hits[nth];
  if (!el) throw new Error(`글 블록에 "${text}" 가 없다(블록 ${hits.length}개 일치)`);
  return el;
}
export async function blocks(): Promise<HTMLElement[]> {
  return waitFor(() => {
    const els = [...article().querySelectorAll<HTMLElement>("[data-cp-start]")];
    if (!els.length) throw new Error("글 블록(data-cp-start)이 아직 없다");
    return els;
  });
}

/** 블록 안의 글에서 needle 의 nth 번째를 DOM 선택으로 만든다(UTF-16 위치 그대로 — 서로게이트 쌍 한가운데도 줄 수 있다). 선택 사건은 세 길로 모두 알린다 */
export function selectRange(block: HTMLElement, startUtf16: number, endUtf16: number) {
  const nodes: { node: Text; from: number }[] = [];
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let total = 0;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push({ node: n as Text, from: total });
    total += (n as Text).data.length;
  }
  const at = (pos: number) => {
    const hit = nodes.find((x) => pos >= x.from && pos <= x.from + x.node.data.length);
    if (!hit) throw new Error(`시험 준비 오류: 블록 글(${total}자)에 위치 ${pos} 가 없다`);
    return { node: hit.node, offset: pos - hit.from };
  };
  const a = at(startUtf16);
  const b = at(endUtf16);
  const range = document.createRange();
  range.setStart(a.node, a.offset);
  range.setEnd(b.node, b.offset);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
  fireEvent.mouseUp(block);
  fireEvent.keyUp(block, { key: "Shift" });
}
export function selectText(block: HTMLElement, needle: string, nth = 0) {
  const text = block.textContent ?? "";
  let at = -1;
  for (let i = 0; i <= nth; i++) {
    at = text.indexOf(needle, at + 1);
    if (at < 0) throw new Error(`시험 준비 오류: 블록에 "${needle}" ${nth}번째가 없다`);
  }
  selectRange(block, at, at + needle.length);
}
export function clearSelection() {
  window.getSelection()?.removeAllRanges();
  document.dispatchEvent(new Event("selectionchange"));
}

export const altM = (target: Element = document.body, key = "m") => fireEvent.keyDown(target, { key, code: "KeyM", altKey: true });

/** 도구 단추 */
export const toolButton = (name: string | RegExp) => within(screen.getByRole("toolbar", { name: "선택한 글 도구" })).getByRole("button", { name });
export const toolText = () => screen.queryByRole("toolbar", { name: "선택한 글 도구" })?.textContent ?? "";

/** 영수증이 오기 전에는 보이지 않는 성공 말 */
export const statusTexts = (): string => [...document.querySelectorAll('[role="status"]')].map((n) => n.textContent ?? "").join(" | ");
export const alertText = (): string => [...document.querySelectorAll('[role="alert"]')].map((n) => n.textContent ?? "").join(" | ");
