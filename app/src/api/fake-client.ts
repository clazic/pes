import { ROUNDS, WORKSPACE } from "./fixture";
import { FORMAT_VERSION, PesApiError, type ApiError, type ApiErrorCode, type ChangeTx, type CommandResult, type CommentThreadView, type PesClient, type QuestionInput, type QuestionRevision, type QuestionView, type QuestionVersionView, type Receipt, type RoundView, type WorkspaceView } from "./types";

/**
 * 가짜 클라이언트(U1a) — 앱 안 메모리에서 합성 자료를 돌려준다. 네트워크를 쓰지 않는다.
 * 모양은 API 계약 그대로(types.ts): 쓰기는 멱등 키 필수 · CommandResult · 영수증 · 거절은 ApiError 봉투.
 * 앱(루트 레이아웃)마다 하나씩 만들어 상태(오류 확인 · 멱등 기록)가 시험 사이에 새지 않는다.
 * 돌려주는 값은 복사본이다(화면이 고쳐도 원본이 바뀌지 않음).
 * workspace 를 주면 그 작업 공간을 쓴다(앱은 U1d 칸이 있는 DEMO_WORKSPACE, 계약 시험은 WORKSPACE).
 */

/** 오류 문장 — 2단계 코어(scripts/pes_core/api_support.ts)의 문장·다음 할 일과 같다 */
const ERRORS: Record<ApiErrorCode, { message: string; next_action: string }> = {
  not_found: { message: "요청한 대상을 찾을 수 없습니다.", next_action: "reread_context" },
  invalid_payload: { message: "요청 내용이 올바르지 않습니다.", next_action: "fix_request" },
  idempotency_key_reuse: { message: "같은 Idempotency-Key로 다른 요청을 보냈습니다.", next_action: "use_new_key" },
  conflict: { message: "현재 상태에서는 처리할 수 없는 요청입니다.", next_action: "reread_context" },
  cursor_expired: { message: "변경 기록이 너무 오래되어 이어 받을 수 없습니다.", next_action: "reread_context" },
  cursor_invalid: { message: "변경 커서가 올바르지 않습니다.", next_action: "reread_context" },
};

export function createFakeClient(workspace: WorkspaceView = WORKSPACE): PesClient {
  const rounds: RoundView[] = structuredClone(ROUNDS);
  /** 멱등 기록: 키 → (요청 지문, 처음 결과) */
  const commits = new Map<string, { request: string; result: CommandResult<unknown> }>();
  /** 질문 버전 기록(U2b) — 질문 id → 최신이 먼저 */
  const history = new Map<string, QuestionVersionView[]>();
  let seq = 900;
  /** 공개 tx 기록(변경분 읽기) — 커서는 이 목록의 길이를 감싼 불투명 글자 */
  const txLog: ChangeTx[] = [];
  let req = 0;
  const copy = <T,>(v: T) => Promise.resolve(structuredClone(v));
  const find = (slug: string, edition: number) => (slug === workspace.slug && edition === workspace.edition ? workspace : null);
  const requestId = () => `req-${++req}`;
  const reject = (code: ApiErrorCode, target?: string) => {
    const body: ApiError = {
      format_version: FORMAT_VERSION,
      error: { code, message: ERRORS[code].message, retryable: false, ...(target ? { target } : {}), next_action: ERRORS[code].next_action },
      request_id: requestId(),
    };
    return Promise.reject(new PesApiError(body));
  };


  /* ───────────── 질문 쓰기(U2b) — 서버 계약 SEL-90(U2a)의 모양, 메모리 안에서만 ───────────── */
  const ownerOf = (questionId: string) => rounds.find((r) => r.questions.some((q) => q.id === questionId));
  const statusOf = (q: QuestionView) => q.status ?? "open";
  const bumpForm = (r: RoundView) => {
    r.form_version += 1;
  };
  /**
   * 질문 명령 하나 — 순서(API 결정 4): 요청 검사(멱등 키) → 완료 영수증 재생 → 대상 검사 · 변경.
   * 변경은 apply 안에서 하고, 거절은 reject 로 던진다(변경 없음).
   */
  function command<T>(method: string, slug: string, edition: number, key: string | undefined, parts: unknown[], apply: () => { data: T; round: RoundView }): Promise<CommandResult<T>> {
    if (!key) return reject("invalid_payload", "$.headers.idempotency-key");
    const request = JSON.stringify([method, slug, edition, parts]);
    const done = commits.get(key);
    if (done) {
      if (done.request !== request) return reject("idempotency_key_reuse", "$.headers.idempotency-key");
      return copy({ ...(done.result as CommandResult<T>), request_id: requestId(), receipt: { ...done.result.receipt, replayed: true } });
    }
    if (!find(slug, edition)) return reject("not_found", "$.project");
    let out: { data: T; round: RoundView };
    try {
      out = apply();
    } catch (e) {
      if (e instanceof PesApiError) return Promise.reject(e);
      throw e;
    }
    const n = String(++seq).padStart(4, "0");
    const receipt: Receipt = { receipt_no: n, tx_id: `tx-${n}`, committed_at: new Date().toISOString(), idempotency_key: key, replayed: false };
    txLog.push({ tx_id: receipt.tx_id, touched: [`round:${out.round.stage}/${out.round.round_id ?? "start"}`] });
    const result: CommandResult<T> = { format_version: FORMAT_VERSION, request_id: requestId(), receipt, data: out.data };
    commits.set(key, { request, result });
    return copy(result);
  }
  const rejectNow = (code: ApiErrorCode, target?: string): never => {
    throw new PesApiError({
      format_version: FORMAT_VERSION,
      error: { code, message: ERRORS[code].message, retryable: false, ...(target ? { target } : {}), next_action: ERRORS[code].next_action },
      request_id: requestId(),
    });
  };
  const target = (questionId: string) => {
    const r = ownerOf(questionId);
    const q = r?.questions.find((x) => x.id === questionId);
    if (!r || !q) return rejectNow("not_found", "$.question_id");
    return { r, q };
  };
  const snapshot = (q: QuestionView): QuestionVersionView => ({
    version: q.version,
    text: q.text,
    ...(q.importance ? { importance: q.importance } : {}),
    required: q.required,
    kind: q.kind ?? "free_text",
    created_at: new Date().toISOString(),
    ...(q.sent ? { answer: { answer: q.sent.answer, receipt_no: q.sent.receipt_no, committed_at: q.sent.committed_at } } : {}),
  });
  const labels = (options: { label: string }[] | undefined) => (options ?? []).map((o) => o.label);

  /* ───────────── 답 제출 · 질문별 의견(U2c) — 서버 계약 SEL-90(U2a)의 모양, 메모리 안에서만 ───────────── */
  const threads: CommentThreadView[] = [];
  /** 질문 id → 보낸 값(선택지 id / 글) — 조건(show_if) 판단용 */
  const rawValues = new Map<string, string | string[]>();
  let msgSeq = 0;
  const rejectDetail = (code: ApiErrorCode, message: string, details: Record<string, unknown>): never => {
    throw new PesApiError({ format_version: FORMAT_VERSION, error: { code, message, retryable: false, next_action: ERRORS[code].next_action, details }, request_id: requestId() });
  };
  const filled = (v: unknown) => (Array.isArray(v) ? v.length > 0 : typeof v === "string" ? v.trim() !== "" : false);
  const roundOf = (stage: string, round: string) => rounds.find((x) => x.stage === stage && (round === "start" ? x.round_id === null : String(x.round_id) === round));
  const answerText = (q: QuestionView, value: string | string[]) => {
    const one = (v: string) => q.options?.find((o) => o.id === v)?.label ?? v;
    return Array.isArray(value) ? value.map(one).join(", ") : one(value);
  };

  return {
    capabilities: { questionTools: true },
    listProjects: () => copy([{ slug: workspace.slug, edition: workspace.edition, current: workspace.current }]),
    getWorkspace: (slug, edition) => copy(find(slug, edition)),
    getRound(slug, edition, stage, round) {
      if (!find(slug, edition)) return copy(null);
      // 단계 시작은 "start"(round_id = null). 숫자는 1 이상의 정수만 — "0" · "01" · 그 밖은 없는 라운드
      const roundId = round === "start" ? null : /^[1-9]\d*$/.test(round) ? Number(round) : undefined;
      if (roundId === undefined) return copy(null);
      return copy(rounds.find((r) => r.stage === stage && r.round_id === roundId) ?? null);
    },
    acknowledgeAlert(slug, edition, alertId, idempotencyKey) {
      // 순서(API 결정 4): 요청 검사 → 완료 영수증 재생 → 대상 검사 · 변경
      if (!idempotencyKey) return reject("invalid_payload", "$.headers.idempotency-key");
      const request = JSON.stringify(["alert.acknowledge", slug, edition, alertId]);
      const done = commits.get(idempotencyKey);
      if (done) {
        if (done.request !== request) return reject("idempotency_key_reuse", "$.headers.idempotency-key");
        return copy({ ...(done.result as CommandResult<{ alert_id: string }>), request_id: requestId(), receipt: { ...done.result.receipt, replayed: true } });
      }
      const alert = find(slug, edition) ? rounds.flatMap((r) => r.alerts).find((a) => a.id === alertId) : undefined;
      if (!alert) return reject("not_found", "$.alert_id");
      const n = String(++seq).padStart(4, "0");
      const receipt: Receipt = { receipt_no: n, tx_id: `tx-${n}`, committed_at: new Date().toISOString(), idempotency_key: idempotencyKey, replayed: false };
      alert.acknowledged ??= { receipt_no: receipt.receipt_no, tx_id: receipt.tx_id, committed_at: receipt.committed_at };
      const owner = rounds.find((r) => r.alerts.includes(alert));
      txLog.push({ tx_id: receipt.tx_id, touched: owner ? [`round:${owner.stage}/${owner.round_id ?? "start"}`] : [] });
      const result: CommandResult<{ alert_id: string }> = { format_version: FORMAT_VERSION, request_id: requestId(), receipt, data: { alert_id: alertId } };
      commits.set(idempotencyKey, { request, result });
      return copy(result);
    },
    async getQuestionVersions(slug, edition, questionId) {
      if (!find(slug, edition)) return null;
      const q = ownerOf(questionId)?.questions.find((x) => x.id === questionId);
      if (!q) return null;
      return structuredClone(history.get(questionId) ?? [snapshot(q)]);
    },
    reviseQuestion(slug, edition, questionId, body: QuestionRevision, key) {
      return command("reviseQuestion", slug, edition, key, [questionId, body], () => {
        const { r, q } = target(questionId);
        if (statusOf(q) !== "open" || body.base_version !== q.version) rejectNow("conflict", "$.base_version");
        // 문장 · 유형 · 선택지가 바뀌면 의미가 바뀐 것 — 재확인 필요, 보낸 답은 옛 답으로 보존(새 답으로 옮기지 않음)
        const semantic = body.text !== q.text || body.kind !== (q.kind ?? "free_text") || JSON.stringify(labels(body.options)) !== JSON.stringify(labels(q.options));
        const before = history.get(questionId) ?? [snapshot(q)];
        const { base_version: _base, importance, help, ...rest } = body;
        Object.assign(q, rest, { version: q.version + 1 });
        if (importance) q.importance = importance;
        else delete q.importance;
        if (help) q.help = help;
        else delete q.help;
        if (semantic) {
          q.needs_recheck = true;
          if (q.sent) {
            q.previous_answer = { answer: q.sent.answer, version: q.version - 1, receipt_no: q.sent.receipt_no, committed_at: q.sent.committed_at };
            delete q.sent;
          }
        }
        history.set(questionId, [snapshot(q), ...before]);
        bumpForm(r);
        return { round: r, data: { question_id: questionId, version: q.version, needs_recheck: q.needs_recheck === true } };
      });
    },
    addQuestion(slug, edition, stage, round, body: QuestionInput, key) {
      return command("addQuestion", slug, edition, key, [stage, round, body], () => {
        const r = rounds.find((x) => x.stage === stage && (round === "start" ? x.round_id === null : String(x.round_id) === round));
        if (!r || r.state !== "current") rejectNow("not_found", "$.round");
        const rv = r as RoundView;
        const number = Math.max(30, ...rounds.flatMap((x) => x.questions.map((q) => q.number + 1)));
        const id = `q-${number}`;
        const { help, importance, ...rest } = body;
        rv.questions.push({ id, number, version: 1, source: "human", status: "open", needs_recheck: false, previous_answer: null, recommendation: null, ...rest, ...(importance ? { importance } : {}), ...(help ? { help } : {}) });
        bumpForm(rv);
        return { round: rv, data: { question_id: id, version: 1 } };
      });
    },
    withdrawQuestion(slug, edition, questionId, key) {
      return command("withdrawQuestion", slug, edition, key, [questionId], () => {
        const { r, q } = target(questionId);
        if (statusOf(q) !== "open") rejectNow("conflict", "$.question_id");
        q.status = "withdrawn";
        bumpForm(r);
        return { round: r, data: { question_id: questionId, status: "withdrawn" as const } };
      });
    },
    deferQuestion(slug, edition, questionId, key) {
      return command("deferQuestion", slug, edition, key, [questionId], () => {
        const { r, q } = target(questionId);
        if (statusOf(q) !== "open") rejectNow("conflict", "$.question_id");
        q.status = "deferred";
        bumpForm(r);
        return { round: r, data: { question_id: questionId, status: "deferred" as const } };
      });
    },
    mergeQuestion(slug, edition, questionId, intoQuestionId, key) {
      return command("mergeQuestion", slug, edition, key, [questionId, intoQuestionId], () => {
        const { r, q } = target(questionId);
        const into = r.questions.find((x) => x.id === intoQuestionId);
        if (!into || into.id === q.id || statusOf(into) !== "open" || statusOf(q) !== "open") rejectNow("conflict", "$.into_question_id");
        q.status = "merged";
        q.merged_into = intoQuestionId;
        bumpForm(r);
        return { round: r, data: { question_id: questionId, status: "merged" as const, merged_into: intoQuestionId } };
      });
    },
    reorderQuestions(slug, edition, stage, round, orderedIds, key) {
      return command("reorderQuestions", slug, edition, key, [stage, round, orderedIds], () => {
        const r = rounds.find((x) => x.stage === stage && (round === "start" ? x.round_id === null : String(x.round_id) === round));
        if (!r || r.state !== "current") rejectNow("not_found", "$.round");
        const rv = r as RoundView;
        const open = rv.questions.filter((q) => statusOf(q) === "open");
        if (orderedIds.length !== open.length || !open.every((q) => orderedIds.includes(q.id))) rejectNow("invalid_payload", "$.ordered_ids");
        const sorted = [...open].sort((a, b) => orderedIds.indexOf(a.id) - orderedIds.indexOf(b.id));
        rv.questions = [...sorted, ...rv.questions.filter((q) => statusOf(q) !== "open")];
        bumpForm(rv);
        return { round: rv, data: { form_version: rv.form_version } };
      });
    },
    submitAnswers(slug, edition, stage, round, input, key) {
      return command("submitAnswers", slug, edition, key, [stage, round, input], () => {
        const r = roundOf(stage, round);
        if (!r || r.state !== "current") return rejectNow("not_found", "$.round");
        const open = r.questions.filter((x) => statusOf(x) === "open");
        const items = new Map<string, { value: string | string[] | null; comment: string | null; used_default: boolean }>();
        if (input.mode === "single" && input.answers.length !== 1) rejectDetail("invalid_payload", "개별 제출에는 질문이 정확히 하나여야 해요.", { reason: "single_requires_one_item" });
        for (const a of input.answers) {
          const q = open.find((x) => x.id === a.question_id);
          if (!q) return rejectNow("conflict", "$.answers");
          if (a.question_version !== q.version) rejectDetail("conflict", "질문이 그 사이 바뀌었어요. 새 문구를 확인해 주세요.", { reason: "stale_question_version", question_ids: [q.id] });
          items.set(q.id, { value: a.value, comment: a.comment ?? null, used_default: a.used_default === true });
        }
        const valueOf = (q: QuestionView): string | string[] | undefined => (items.has(q.id) && filled(items.get(q.id)!.value) ? (items.get(q.id)!.value as string | string[]) : (rawValues.get(q.id) ?? q.sent?.answer));
        const applicable = (q: QuestionView) => {
          if (!q.show_if) return true;
          const cond = open.find((x) => x.id === q.show_if!.question_id);
          const v = cond ? valueOf(cond) : undefined;
          return Array.isArray(v) ? v.includes(q.show_if.equals) : v === q.show_if.equals;
        };
        const notApplicable = [...items.keys()].filter((id) => filled(items.get(id)!.value) && !applicable(open.find((x) => x.id === id)!));
        if (notApplicable.length) rejectDetail("invalid_payload", "지금은 답하지 않는 질문이에요.", { reason: "not_applicable", question_ids: notApplicable });
        const satisfied = (q: QuestionView) => {
          const it = items.get(q.id);
          if (it) return filled(it.value) || (q.allow_comment_as_answer === true && filled(it.comment));
          return !!q.sent;
        };
        const missingNow = open.filter((q) => q.required && applicable(q) && !satisfied(q)).map((q) => q.id);
        if (input.mode === "bundle" && missingNow.length) rejectDetail("invalid_payload", "필수 질문에 아직 답이 없어서 접수하지 않았습니다.", { reason: "required_missing", question_ids: missingNow });
        const no = String(seq + 1).padStart(4, "0");
        for (const [id, it] of items) {
          const q = open.find((x) => x.id === id)!;
          const sent = { receipt_no: no, tx_id: `tx-${no}`, committed_at: new Date().toISOString() };
          if (filled(it.value)) {
            q.sent = { answer: answerText(q, it.value as string | string[]), ...sent };
            rawValues.set(id, it.value as string | string[]);
            if (it.used_default) q.used_default = true;
            else delete q.used_default;
          } else if (filled(it.comment) && q.allow_comment_as_answer === true) q.sent = { answer: String(it.comment), ...sent };
          if (q.sent) q.needs_recheck = false;
        }
        const missing = open.filter((q) => q.required && applicable(q) && !q.sent).map((q) => q.id);
        return { round: r, data: { submission_id: `sub-${no}`, answers: [...items.keys()].map((question_id) => ({ question_id, state: "submitted" as const })), form_complete: missing.length === 0, missing_required: missing } };
      });
    },
    async getComments(slug, edition, stage, round) {
      if (!find(slug, edition)) return [];
      const r = roundOf(stage, round);
      if (!r) return [];
      const ids = new Set(r.questions.map((q) => q.id));
      return structuredClone(threads.filter((t) => ids.has(t.question_id)));
    },
    addComment(slug, edition, questionId, input, key) {
      return command("addComment", slug, edition, key, [questionId, input], () => {
        const { r } = target(questionId);
        if (!input.body_md.trim()) return rejectNow("invalid_payload", "$.body_md");
        let t = input.thread_id ? threads.find((x) => x.thread_id === input.thread_id && x.question_id === questionId) : undefined;
        if (input.thread_id && !t) return rejectNow("not_found", "$.thread_id");
        const created = !t;
        if (!t) {
          t = { thread_id: `th-${threads.length + 1}`, question_id: questionId, ...(input.question_version ? { question_version: input.question_version } : {}), messages: [] };
          threads.push(t);
        }
        const message_id = `msg-${++msgSeq}`;
        t.messages.push({ message_id, body_md: input.body_md, at: new Date().toISOString(), by: "human" });
        return { round: r, data: { thread_id: t.thread_id, message_id, thread_created: created } };
      });
    },
    getChanges(slug, edition, cursor) {
      if (!find(slug, edition)) return reject("not_found", "$.project");
      const head = `fake-${txLog.length}`;
      if (cursor === null) return copy({ cursor: head, txs: [] });
      const m = /^fake-(\d+)$/.exec(cursor);
      const at = m ? Number(m[1]) : NaN;
      if (!(at >= 0 && at <= txLog.length)) return reject("cursor_invalid", "$.cursor");
      return copy({ cursor: head, txs: txLog.slice(at) });
    },
  };
}
