import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { FORMAT_VERSION, PesApiError, type CommandResult, type PesClient, type Receipt, type RoundView, type WorkspaceView } from "@/api/types";
import { CURRENT } from "@/test/contract";
import { renderApp, type Env } from "@/test/render-app";
import { apiError, createScriptedClient } from "@/test/scripted-client";
import { ready } from "@/test/ui";

/**
 * SEL-91 U2b 시험 계약 — 질문 카드 · 필터 · 이동 · 인라인 고치기 · 재확인 경고 · 철회/보류/합치기/순서(앱, 가짜 클라이언트만).
 * 이슈 문구(stage-3.md U2 절, SEL-91, stage-1-ui.md F04·F06·F08, 승인 시안 QuestionPanel.tsx)에서 뽑은 해석이다. 구현을 추측해서 맞춘 것이 아니다.
 * 이름을 바꿔야 하면 구현이 아니라 이 파일(과 보고서의 해석)을 고치고 leader 에게 알린다. 합성 자료뿐(실제 자료·키·경로 없음).
 *
 * ═══ [정한 인터페이스] PesClient 에 더하는 읽기·쓰기 (types.ts 머리말에 그대로 옮긴다) ═══
 * 서버 계약은 SEL-90(U2a) 이다. 라우트: POST P/questions · POST P/questions/{q}/revisions · POST P/questions/{q}/withdraw|defer|merge.
 * 이번에는 가짜 클라이언트만 시험한다. http 클라이언트 매핑 시험은 U2a 병합 뒤.
 *
 *   type QuestionKind = "single_choice" | "multi_choice" | "free_text";
 *   type QuestionDirection = "ask_human" | "ask_ai";          // ask_human = AI 가 사람에게 묻는다 · ask_ai = 사람이 AI 에게(“내가 AI에게”)
 *   type QuestionStatus = "open" | "withdrawn" | "deferred" | "merged";
 *   interface QuestionOption { id: string; label: string }
 *   interface ShowIf { question_id: string; equals: string }  // equals = 그 질문의 선택지 id (또는 글 답 값)
 *   // QuestionView 에 더하는 칸(전부 optional — 이전된 합성 프로젝트는 아래 칸이 하나도 없어도 깨지지 않는다)
 *   interface QuestionViewU2b extends QuestionView {
 *     importance?: Importance;                 // 없음 = 미정(이전된 프로젝트)
 *     kind?: QuestionKind;                     // 없으면 free_text 로 본다
 *     options?: QuestionOption[];
 *     default_value?: string | null;           // 기본값 — 선택지 id 또는 글. 미리 답으로 채우지 않는다
 *     recommendation?: { value: string; reason: string } | null;   // AI 추천 — 기본값과 다르고 답도 아니다
 *     show_if?: ShowIf | null;
 *     direction?: QuestionDirection;           // 없으면 ask_human
 *     status?: QuestionStatus;                 // 없으면 open
 *     merged_into?: string;                    // status === "merged" 일 때 합쳐진 질문 id
 *     needs_recheck?: boolean;                 // 질문이 바뀌어 답을 다시 확인해야 함
 *     previous_answer?: { answer: string; version: number; receipt_no: string; committed_at: IsoTime } | null;  // 옛 버전의 답(보존, 승계 아님)
 *   }
 *   interface QuestionInput { text: string; kind: QuestionKind; options: QuestionOption[]; importance: Importance | null; required: boolean;
 *                             default_value: string | null; show_if: ShowIf | null; help: string | null; direction: QuestionDirection }
 *   interface QuestionRevision extends QuestionInput { base_version: number }      // 지금 보는 질문 버전 — 어긋나면 conflict
 *   interface QuestionVersionView { version: number; text: string; importance?: Importance; required: boolean; kind: QuestionKind; created_at: IsoTime;
 *                                   answer?: { answer: string; receipt_no: string; committed_at: IsoTime } }   // 최신이 먼저
 *   interface PesClient {
 *     getQuestionVersions(slug, edition, questionId): Promise<QuestionVersionView[] | null>;
 *     reviseQuestion(slug, edition, questionId, body: QuestionRevision, idempotencyKey: string | undefined): Promise<CommandResult<{ question_id: string; version: number; needs_recheck: boolean }>>;
 *     addQuestion(slug, edition, stage: string, round: string, body: QuestionInput, idempotencyKey: string | undefined): Promise<CommandResult<{ question_id: string; version: number }>>;
 *     withdrawQuestion(slug, edition, questionId, idempotencyKey): Promise<CommandResult<{ question_id: string; status: "withdrawn" }>>;
 *     deferQuestion(slug, edition, questionId, idempotencyKey): Promise<CommandResult<{ question_id: string; status: "deferred" }>>;
 *     mergeQuestion(slug, edition, questionId, intoQuestionId, idempotencyKey): Promise<CommandResult<{ question_id: string; status: "merged"; merged_into: string }>>;
 *     reorderQuestions(slug, edition, stage, round, orderedIds: string[], idempotencyKey): Promise<CommandResult<{ form_version: number }>>;
 *   }
 *   - 쓰기 모두 멱등 키 필수(없으면 invalid_payload) · 같은 키·같은 요청은 영수증 재생 · 거절은 PesApiError. 삭제(hard delete) 명령은 없다.
 *   - reorderQuestions 의 orderedIds 는 상태 open 질문 전부의 새 순서(닫힌 질문은 제외).
 *   - 질문 목록·폼 버전은 getRound 가 준다(RoundView.questions 가 위 칸을 가진다). 명령이 성공하면 화면은 getRound 를 다시 읽는다.
 *     추가·철회·보류·합치기·순서 바꾸기·고치기는 모두 새 폼 버전을 만든다(form_version 이 오른다).
 *
 * ═══ [화면 계약] (질문 영역 = aside "질문" 안) ═══
 *   질문 항목: `li[data-question="<id>"]`(tabindex=-1, 초점을 받는다). 열린 질문만 목록(ol)에 — 닫힌 질문(철회·보류·합쳐짐)은 region "정리된 질문" 의 같은 모양 항목
 *   `[data-question][data-status="withdrawn|deferred|merged"]`(답 칸 없음). 지우지 않는다. 답 칸 id=질문 id · 의견 칸 id=`<질문 id>-opinion`(U1c 그대로).
 *   카드 표식: `[data-chip="required"]`("필수") · `[data-chip="importance"]`("중요도 높음|보통|낮음", 없으면 "중요도 미정") — 둘은 별개 칩 ·
 *     `[data-chip="kind"]`("하나 고르기" | "여러 개 고르기" | "글로 답하기") · `[data-chip="direction"]`("내가 AI에게" | "AI가 나에게") · `[data-chip="version"]`("버전 N") ·
 *     `[data-badge="recheck"]`("재확인 필요") · `[data-badge="old-answer"]`("옛 답 있음").
 *   값 구분(서로 다른 노드, 서로 다른 말): `[data-field-kind="answer"]`(보낸 답) · `"opinion"`(의견 칸 묶음) · `"default"`("기본값") · `"recommendation"`("AI 추천" + 이유) · `"old-answer"`(“옛 답 보기” 단추로 펼침).
 *     기본값·추천은 선택지/글 칸을 미리 채우지 않는다(라디오 선택 0 · 답 칸 빈 값).
 *   show_if 가 있으면 카드에 `질문 21에서 ‘이어 보기’를 고르면 보임` 꼴 한 줄(정규식 /질문 \d+.*보임/).
 *   필터: radiogroup "질문 거르기" 안 라디오 넷 — 이름이 `전체 N` · `높음 N` · `재확인 N` · `내가 AI에게 N`(N = 열린 질문 중 해당 수). 기본 "전체". 고르면 맞지 않는 항목은 목록에서 빠진다.
 *   이동: `[data-position]` 텍스트 "n/m"(n = 지금 질문 위치 1부터, m = 보이는 열린 질문 수; 처음 1/m) · 단추 "이전 질문"(↑ K) · "다음 질문"(↓ J) · 가장자리에서는 aria-disabled="true" · 돌아 넘기지 않음.
 *     J/K 는 문서 어디서든(초점이 글 입력 칸·선택·열린 대화 상자 안이면 제외 · IME 조합 중 제외 · Ctrl/Alt/Meta 조합 제외) 다음/이전 질문 항목으로 초점을 옮기고 URL 의 focus 쿼리가 따라 바뀐다.
 *     처음(초점이 질문 밖)에서 J → 첫 질문, K → 첫 질문. 닫힌 질문은 건너뛴다.
 *   질문 하나의 도구(데스크톱만 켜짐; 휴대폰 = 폭<900 + 굵은 포인터에서는 aria-disabled="true" + aria-describedby 가 가리키는 “데스크톱” 이유 글; 지난 라운드는 없거나 aria-disabled):
 *     "질문 21 고치기" · "질문 21 위로 옮기기" · "질문 21 아래로 옮기기"(가장자리 aria-disabled) · "질문 21 정리"(aria-expanded; 열면 group "질문 21 정리" 안에 "철회" · "보류" · "합치기" 단추) · "질문 21 버전 기록"(펼침).
 *     목록 위 도구: "질문 더하기"(대화 상자 "질문 더하기" — 질문 문장·유형·방향·중요도·필수·도움말·선택지, 제출 "추가하기").
 *   철회/보류/합치기: dialog "질문 21 철회" | "질문 21 보류" | "질문 21 합치기"(지우지 않는다는 말 + 보낸 답은 남는다는 말) · 확정 단추 "철회 확정" | "보류 확정" | "합치기 확정" · 취소 단추 "취소".
 *     합치기 대화 상자에 select "합칠 질문"(자기 자신 제외 열린 질문). 확정하면 그 명령 한 번(멱등 키 하나), 취소하면 0번.
 *   인라인 고치기: form "질문 21 고치기"(항목 안에 펼침). 칸 이름(label): "질문 문장" · "유형"(select: 하나 고르기/여러 개 고르기/글로 답하기) · "선택지 1…n"(텍스트 칸, 선택지가 있는 유형만) ·
 *     "선택지 더하기" · "선택지 n 지우기" · "중요도"(select: 미정/높음/보통/낮음) · "필수"(checkbox) · "기본값"(select: 없음 + 선택지, 글 유형은 텍스트 칸) · "조건 질문"(select: 항상 보임 + 다른 열린 질문 “질문 N”) ·
 *     "조건 답"(select, 조건 질문을 골랐을 때만) · "도움말" · "방향"(select: AI가 사람에게 묻기 / 사람이 AI에게 묻기). 저장 "새 버전으로 저장" · 취소 "취소".
 *     열면 첫 칸("질문 문장")으로 초점. 취소/저장 뒤 초점은 “질문 21 고치기” 단추 또는 그 항목으로.
 *   재확인 경고(저장 전): 의미가 바뀌는 칸(문장 · 유형 · 선택지)을 고치면 form 안에 `[data-warning="recheck"]`(role=status) 가 “재확인 필요” 와 “옛 답은 보존/그대로 남” 안내를 띄운다. 원래 값으로 되돌리면 사라진다.
 *     중요도 · 필수 · 기본값 · 조건 · 도움말 · 방향만 고치면 경고도 배지도 없다.
 *   저장 = 새 버전 명령 한 번(멱등 키 하나, base_version = 지금 버전). 성공하면 role=status 에 “새 버전” + “접수 NNNN” + “옛 답” 보존 안내, 항목의 버전·배지가 새 읽기로 바뀐다.
 *     거절(conflict 등)이면 form 이 열린 채 입력이 남고 role=alert 에 오류 문장. 보내는 동안 저장 단추는 aria-disabled(두 번 눌러도 한 번). 실패 뒤 다시 누르면 같은 멱등 키.
 *   초안(F04): 갱신(changes → getRound 다시 읽기)·폼 버전 상승(순서·추가 등)이 와도 질문 버전이 같으면 답/의견 칸 노드·값·초점이 그대로, 열린 고치기 form 의 입력도 그대로.
 *   화면 글자에 낱말 'Go' 는 없다.
 */

export type Wire = Record<string, unknown>;
export const SLUG = "sample-study";
export const EDITION = 1;

const AT = "2026-11-10T10:00:00+09:00";

/** 열린 질문 4 + 닫힌 질문 3. 전체 4 · 높음 2(q-21, q-24) · 재확인 1(q-21) · 내가 AI에게 1(q-24) */
export const U2B_QUESTIONS: Wire[] = [
  {
    id: "q-21",
    number: 21,
    version: 2,
    required: true,
    importance: "high",
    source: "ai",
    text: "대출 수 자료의 정의가 2021년에 바뀌었어요. 그 앞뒤를 한 줄로 이어 볼까요, 따로 볼까요?",
    help: "이어 보면 흐름이 잘 보이지만, 정의 차이를 각주로 밝혀야 해요.",
    kind: "single_choice",
    options: [
      { id: "join", label: "이어 보기" },
      { id: "split", label: "따로 보기" },
      { id: "other", label: "기타" },
    ],
    default_value: "split",
    recommendation: { value: "join", reason: "추세를 한눈에 볼 수 있어서" },
    show_if: null,
    direction: "ask_human",
    status: "open",
    needs_recheck: true,
    previous_answer: { answer: "한 줄로 이어 주세요.", version: 1, receipt_no: "0501", committed_at: "2026-11-09T09:00:00+09:00" },
  },
  { id: "q-22", number: 22, version: 1, required: false, importance: "normal", source: "ai", text: "R1 에서 찾은 출처 중 더 깊이 볼 것이 있으면 알려 주세요.", kind: "free_text", options: [], default_value: null, recommendation: null, show_if: null, direction: "ask_human", status: "open", needs_recheck: false, previous_answer: null },
  {
    id: "q-23",
    number: 23,
    version: 1,
    required: false,
    importance: "low",
    source: "ai",
    text: "이어 보기로 정했다면 어떤 해석 주의 문구를 붙일까요?",
    kind: "multi_choice",
    options: [
      { id: "foot", label: "각주" },
      { id: "chart", label: "그림 설명" },
    ],
    default_value: null,
    recommendation: null,
    show_if: { question_id: "q-21", equals: "join" },
    direction: "ask_human",
    status: "open",
    needs_recheck: false,
    previous_answer: null,
  },
  { id: "q-24", number: 24, version: 1, required: true, importance: "high", source: "human", text: "AI 가 지금까지 가정한 것을 한 줄로 정리해 주세요.", kind: "free_text", options: [], default_value: null, recommendation: null, show_if: null, direction: "ask_ai", status: "open", needs_recheck: false, previous_answer: null },
  { id: "q-26", number: 26, version: 1, required: false, importance: "low", source: "ai", text: "철회된 합성 질문", kind: "free_text", options: [], status: "withdrawn", direction: "ask_human" },
  { id: "q-27", number: 27, version: 1, required: false, importance: "normal", source: "ai", text: "보류된 합성 질문", kind: "free_text", options: [], status: "deferred", direction: "ask_human" },
  { id: "q-28", number: 28, version: 1, required: false, importance: "normal", source: "ai", text: "합쳐진 합성 질문", kind: "free_text", options: [], status: "merged", merged_into: "q-22", direction: "ask_human" },
];
export const OPEN_IDS = ["q-21", "q-22", "q-23", "q-24"];

/** 이전된 합성 프로젝트의 질문 — 중요도·종류·선택지·방향·상태·버전 칸이 없다(U1a 모양 그대로) */
export const LEGACY_QUESTIONS: Wire[] = [
  { id: "q-21", number: 21, version: 1, required: true, source: "ai", text: "이전된 합성 질문 하나", sent: undefined },
  { id: "q-22", number: 22, version: 1, required: false, source: "ai", text: "이전된 합성 질문 둘" },
];

/* ───────────── 상태를 가진 시험용 클라이언트 ───────────── */

export interface U2bOptions {
  questions?: Wire[];
  workspace?: WorkspaceView;
}
type Rec = Wire & { id: string };

const receiptOf = (n: number, key: string, replayed = false): Receipt => ({ receipt_no: String(n).padStart(4, "0"), tx_id: `tx-${n}`, committed_at: AT, idempotency_key: key, replayed });

/**
 * 가짜 클라이언트(scripted) 위에 U2b 읽기·쓰기를 얹는다. 명령은 상태를 바꾸고, 화면이 getRound 를 다시 읽으면 바뀐 값이 온다.
 * 호출은 s.calls 에 같은 이름·인자로 쌓인다(method = 위 인터페이스 이름).
 */
export function createU2bClient(opts: U2bOptions = {}) {
  const s = createScriptedClient();
  let questions: Rec[] = structuredClone(opts.questions ?? U2B_QUESTIONS) as Rec[];
  let formVersion = 4;
  let seq = 600;
  let nextNumber = 30;
  const done = new Map<string, { req: string; result: CommandResult<unknown> }>();
  const failures: Error[] = [];
  const log = (method: string, args: unknown[]) => s.calls.push({ method, args, at: Date.now() });
  const versions = new Map<string, Wire[]>();

  const roundRead = async (slug: string, edition: number, stage: string, round: string): Promise<RoundView | null> => {
    const r = await s.client.getRound(slug, edition, stage, round);
    if (!r || stage !== "research" || round !== "2") return r;
    return { ...r, form_version: formVersion, questions: structuredClone(questions) as unknown as RoundView["questions"] };
  };

  async function command<T>(method: string, args: unknown[], key: string | undefined, req: unknown, apply: () => T): Promise<CommandResult<T>> {
    log(method, args);
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
    const result: CommandResult<T> = { format_version: FORMAT_VERSION, request_id: `req-${seq}`, receipt: receiptOf(++seq, key), data };
    done.set(key, { req: request, result });
    return result;
  }
  const find = (id: string) => {
    const q = questions.find((x) => x.id === id);
    if (!q) throw apiError("not_found", "질문을 찾을 수 없습니다");
    return q;
  };

  const client = {
    ...s.client,
    ...(opts.workspace ? { getWorkspace: async () => structuredClone(opts.workspace as WorkspaceView) } : {}),
    getRound: roundRead,
    async getQuestionVersions(_slug: string, _edition: number, id: string) {
      log("getQuestionVersions", [id]);
      const q = questions.find((x) => x.id === id);
      if (!q) return null;
      return structuredClone(versions.get(id) ?? [{ version: q.version, text: q.text, importance: q.importance, required: q.required, kind: q.kind ?? "free_text", created_at: AT }]);
    },
    reviseQuestion(slug: string, edition: number, id: string, body: Wire, key: string | undefined) {
      return command("reviseQuestion", [slug, edition, id, body, key], key, [id, body], () => {
        const q = find(id);
        if (body.base_version !== q.version) throw apiError("conflict", "다른 곳에서 이 질문이 먼저 바뀌었어요");
        const sameOptions = JSON.stringify(((q.options as Wire[]) ?? []).map((o) => o.label)) === JSON.stringify(((body.options as Wire[]) ?? []).map((o) => o.label));
        const semantic = body.text !== q.text || (body.kind ?? "free_text") !== (q.kind ?? "free_text") || !sameOptions;
        const history = versions.get(id) ?? [{ version: q.version, text: q.text, importance: q.importance, required: q.required, kind: q.kind ?? "free_text", created_at: AT, ...(q.sent ? { answer: { answer: (q.sent as Wire).answer, receipt_no: (q.sent as Wire).receipt_no, committed_at: (q.sent as Wire).committed_at } } : {}) }];
        const { base_version: _b, ...fields } = body;
        Object.assign(q, fields, { version: (q.version as number) + 1 });
        if (semantic) {
          q.needs_recheck = true;
          if (q.sent) {
            q.previous_answer = { answer: (q.sent as Wire).answer, version: (q.version as number) - 1, receipt_no: (q.sent as Wire).receipt_no, committed_at: (q.sent as Wire).committed_at };
            delete q.sent;
          }
        }
        versions.set(id, [{ version: q.version, text: q.text, importance: q.importance, required: q.required, kind: q.kind ?? "free_text", created_at: AT }, ...history]);
        formVersion++;
        return { question_id: id, version: q.version as number, needs_recheck: semantic || q.needs_recheck === true };
      });
    },
    addQuestion(slug: string, edition: number, stage: string, round: string, body: Wire, key: string | undefined) {
      return command("addQuestion", [slug, edition, stage, round, body, key], key, [stage, round, body], () => {
        const id = `q-${nextNumber}`;
        questions.push({ id, number: nextNumber++, version: 1, source: "human", status: "open", needs_recheck: false, previous_answer: null, recommendation: null, ...body } as Rec);
        formVersion++;
        return { question_id: id, version: 1 };
      });
    },
    withdrawQuestion(slug: string, edition: number, id: string, key: string | undefined) {
      return command("withdrawQuestion", [slug, edition, id, key], key, [id], () => ((find(id).status = "withdrawn"), formVersion++, { question_id: id, status: "withdrawn" as const }));
    },
    deferQuestion(slug: string, edition: number, id: string, key: string | undefined) {
      return command("deferQuestion", [slug, edition, id, key], key, [id], () => ((find(id).status = "deferred"), formVersion++, { question_id: id, status: "deferred" as const }));
    },
    mergeQuestion(slug: string, edition: number, id: string, into: string, key: string | undefined) {
      return command("mergeQuestion", [slug, edition, id, into, key], key, [id, into], () => {
        find(into);
        const q = find(id);
        q.status = "merged";
        q.merged_into = into;
        formVersion++;
        return { question_id: id, status: "merged" as const, merged_into: into };
      });
    },
    reorderQuestions(slug: string, edition: number, stage: string, round: string, ordered: string[], key: string | undefined) {
      return command("reorderQuestions", [slug, edition, stage, round, ordered, key], key, [stage, round, ordered], () => {
        const open = questions.filter((q) => (q.status ?? "open") === "open").map((q) => q.id);
        if (ordered.length !== open.length || !open.every((i) => ordered.includes(i))) throw apiError("invalid_payload", "열린 질문 전부의 순서가 필요합니다");
        const rank = (id: string) => ordered.indexOf(id);
        const openSorted = questions.filter((q) => (q.status ?? "open") === "open").sort((a, b) => rank(a.id) - rank(b.id));
        const closed = questions.filter((q) => (q.status ?? "open") !== "open");
        questions = [...openSorted, ...closed];
        formVersion++;
        return { form_version: formVersion };
      });
    },
  } as unknown as PesClient & Record<string, (...a: unknown[]) => Promise<unknown>>;

  const calls = (method: string) => s.calls.filter((c) => c.method === method);
  return {
    s,
    client: client as unknown as PesClient,
    calls,
    /** 다음 명령 하나를 이 오류로 거절한다(요청은 기록된다) */
    failNext: (e: Error) => void failures.push(e),
    /** 화면 밖에서 질문을 바꾼다(다른 사람이 고친 것처럼) — 이어서 s.queueChanges 로 갱신을 알린다 */
    mutate: (fn: (qs: Rec[]) => void) => {
      fn(questions);
      formVersion++;
    },
    questions: () => structuredClone(questions),
  };
}
export type U2bHarness = ReturnType<typeof createU2bClient>;

export const touchRound = (cursor = "c-u2b") => ({ cursor, txs: [{ tx_id: `tx-${cursor}`, touched: ["round:research/2"] }] });
export { PesApiError };

/* ───────────── 화면 찾기 ───────────── */

export const aside = () => screen.getByRole("complementary", { name: "질문" });
export const item = (id: string): HTMLElement => {
  const el = document.querySelector<HTMLElement>(`[data-question="${id}"]`);
  if (!el) throw new Error(`질문 항목 ${id} 이(가) 없다 — 계약: li[data-question="<id>"]`);
  return el;
};
export const maybeItem = (id: string) => document.querySelector<HTMLElement>(`[data-question="${id}"]`);
/** 열린 질문 항목 id 를 화면 순서대로 */
export const openOrder = () => [...aside().querySelectorAll<HTMLElement>("ol [data-question]")].filter((e) => !e.closest("[aria-label='정리된 질문'],[data-region='closed']")).map((e) => e.dataset.question as string);
export const closedPanel = () => screen.getByRole("region", { name: "정리된 질문" });
export const filterGroup = () => within(aside()).getByRole("radiogroup", { name: "질문 거르기" });
export const filterRadio = (label: string) => within(filterGroup()).getByRole("radio", { name: new RegExp(`^${label}(?:\\s|$)`) });
export const position = () => aside().querySelector<HTMLElement>("[data-position]");
export const editor = (n: number) => within(aside()).getByRole("form", { name: `질문 ${n} 고치기` });
export const chip = (id: string, kind: string) => item(id).querySelector<HTMLElement>(`[data-chip="${kind}"]`);
export const badge = (id: string, kind: string) => item(id).querySelector<HTMLElement>(`[data-badge="${kind}"]`);
export const activeItemId = () => (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-question]")?.dataset.question ?? null;
/** 보이는 글에 'undefined' · 'null' · 'NaN' 이 새지 않는다 */
export const leaks = (root: HTMLElement = document.body) => (root.textContent ?? "").match(/undefined|\bnull\b|NaN|\[object/g) ?? [];

/* ───────────── 시작 ───────────── */

export async function boot(opts: U2bOptions = {}, path = CURRENT, env: Env = {}) {
  const h = createU2bClient(opts);
  // 가짜 시계를 쓰는 시험 파일에서만 advanceTimers 를 넘긴다
  const user = userEvent.setup(vi.isFakeTimers() ? { advanceTimers: vi.advanceTimersByTime } : {});
  const app = await renderApp(path, { width: 1440, ...env }, { client: h.client });
  await ready();
  await screen.findByRole("radiogroup", { name: "질문 거르기" }).catch(() => undefined);
  return { ...h, user, ...app };
}
