import * as React from "react";
import type { CommandResult, Receipt, StageKey } from "@/api/types";
import { PesApiError } from "@/api/types";
import { peekPending, useKeyedCommand } from "./question-command";

/**
 * 결과 글 첨언(U4b · SEL-112) 공통 도구 — 첨언 칸 안 모든 쓰기가 같은 상태 줄(role=status) · 같은 영수증 말 · 같은 다시 읽기 규칙을 쓴다.
 * 성공 말은 영수증을 받은 뒤에만 한다(F06). 보내는 동안 · 시간 초과는 모두 “접수 확인 중”이다(보냈는지 모른다).
 */

export type Note = { kind: "pending" } | { kind: "wait" } | { kind: "hint"; text: string } | { kind: "done"; receipt: Receipt; text: string } | null;

export interface AnnotationCtx {
  slug: string;
  edition: number;
  /** 지금 보는 라운드의 단계 — “할 일로” 의 목표 단계 */
  stage: StageKey;
  objectId: string;
  /** 지금 보는 글 버전 id · 본문(앵커 위치의 기준) */
  versionId: string;
  body: string;
  /** 쓰기를 막는 이유(휴대폰 · 지난 라운드). 없으면 쓸 수 있다 */
  readOnly?: string;
  say: (note: Note) => void;
  /** 고른 구간을 글에서 다시 선택 상태로 되돌린다(대화 상자를 취소한 뒤 · 도구로 초점이 갈 때 브라우저가 선택을 접어도 구간을 잃지 않게) */
  restoreSelection: () => void;
  /** 상태 줄로 초점을 옮긴다(대화 상자가 닫힌 뒤 초점이 body 로 떨어지지 않게) */
  focusStatus: () => void;
  /** 읽기를 다시 한다(영수증 뒤 · 409 뒤) */
  refresh: () => Promise<unknown>;
  /** 다시 붙이기 모드(글에서 새 구간을 고른다) — 대상 스레드 id */
  reanchoring: string | null;
  startReanchor: (threadId: string) => void;
  cancelReanchor: () => void;
}

export const AnnotationContext = React.createContext<AnnotationCtx | null>(null);

export function useAnnotationCtx(): AnnotationCtx {
  const c = React.useContext(AnnotationContext);
  if (!c) throw new Error("AnnotationContext 공급자가 없다 — 결과 글 첨언 안에서 쓴다");
  return c;
}

export const isTimeout = (e: unknown) => e instanceof Error && e.name === "TimeoutError";

/** 서버가 “지금 상태가 달라졌다”고 거절한 코드 — 화면은 서버 문장을 보이고 읽기를 다시 한다(자동 재시도는 하지 않는다) */
const REREAD = new Set(["basis_changed", "thread_closed", "already_resolved", "rev_conflict", "conflict"]);

/** 영수증 문구 — 서버가 번호를 주지 않았으면(numbered false) 번호를 지어내지 않고 “접수됨” */
export const receiptText = (r: Receipt): string => (r.numbered === false ? "접수됨" : `접수 ${r.receipt_no}`);

/**
 * 쓰기 하나 — 멱등 키 하나(같은 요청의 다시 보내기는 같은 키), 보내는 동안 한 번만, 성공은 영수증 뒤.
 * 반환 alert = 거절 문장(시간 초과는 거절이 아니다 — 상태 줄이 “접수 확인 중” 으로 말한다).
 */
export function useAnnotationWrite(ctx: AnnotationCtx, scope?: string) {
  const cmd = useKeyedCommand(scope);
  const { say, refresh } = ctx;
  const { run: runKeyed } = cmd;
  const run = React.useCallback(
    async <T,>(sig: string, call: (key: string) => Promise<CommandResult<T>>, done: string, keep?: unknown) => {
      say({ kind: "pending" });
      const r = await runKeyed(sig, (key) => call(key), keep);
      if (r.ok) {
        say({ kind: "done", receipt: r.value.receipt, text: done });
        void refresh();
      } else if (r.error === undefined) {
        // 이미 보내는 중이라 무시된 두 번째 누름 — 상태 줄은 그대로 둔다
      } else if (isTimeout(r.error)) {
        say({ kind: "wait" });
      } else {
        say(null);
        if (r.error instanceof PesApiError && REREAD.has(r.error.body.error.code)) void refresh();
      }
      return r;
    },
    [runKeyed, say, refresh],
  );
  const alert = cmd.error && !isTimeout(cmd.failure) ? cmd.error : null;
  return { run, pending: cmd.pending, alert };
}

/**
 * 첨언 쓰기의 확인 중 요청 칸(scope) — 프로젝트 · 판 · 글(object) · 작업별. 대화 상자를 닫았다 다시 열어도(컴포넌트가 사라져도) 같은 요청은 같은 멱등 키로 다시 확인한다.
 * (서버가 커밋하고 영수증만 잃은 경우 재생되어 첨언 · 할 일이 두 번 생기지 않는다)
 */
export const annotationScope = (ctx: Pick<AnnotationCtx, "slug" | "edition" | "objectId">, task: string): string => `annotation|${ctx.slug}|${ctx.edition}|${ctx.objectId}|${task}`;

/** 확인 중 요청이 처음 보낸 내용(keep) — 없으면 null */
export const pendingKeep = (scope: string): unknown => peekPending(scope)?.keep ?? null;

/** “할 일로” 두 단계 진행: 첨언 스레드는 만들었고 제안은 아직 확인 못 함 — 대화 상자 밖(sessionStorage, 못 쓰면 메모리)에 둔다 */
export interface TaskProgress {
  /** 고른 구간 서명(글 버전 · 위치) */
  anchor: string;
  thread_id: string;
  text: string;
}
const TASK_PREFIX = "pes-annotation-task:";
const taskMemory = new Map<string, TaskProgress | null>();
export function loadTaskProgress(scope: string): TaskProgress | null {
  if (taskMemory.has(scope)) return taskMemory.get(scope) ?? null;
  try {
    const raw = window.sessionStorage.getItem(TASK_PREFIX + scope);
    if (raw === null) return null;
    const v: unknown = JSON.parse(raw);
    if (v && typeof v === "object" && typeof (v as TaskProgress).anchor === "string" && typeof (v as TaskProgress).thread_id === "string" && typeof (v as TaskProgress).text === "string") return v as TaskProgress;
    return null;
  } catch {
    return null;
  }
}
export function saveTaskProgress(scope: string, value: TaskProgress | null) {
  try {
    if (value) window.sessionStorage.setItem(TASK_PREFIX + scope, JSON.stringify(value));
    else window.sessionStorage.removeItem(TASK_PREFIX + scope);
    taskMemory.delete(scope);
  } catch {
    taskMemory.set(scope, value);
  }
}

/** 글 상태 줄 — 모든 첨언 쓰기의 영수증 · 접수 확인 중 · 안내가 여기 모인다 */
export const StatusLine = React.forwardRef<HTMLParagraphElement, { note: Note }>(function StatusLine({ note }, ref) {
  let text = "";
  let tone = "text-ink-2";
  if (note?.kind === "pending") {
    text = "접수 확인 중 — 영수증이 올 때까지 기다리는 중이에요.";
    tone = "text-ink";
  } else if (note?.kind === "wait") {
    text = "접수 확인 중 — 서버 응답이 늦어요. 접수됐는지 아직 몰라요. 같은 단추를 다시 누르면 같은 요청으로 확인하고, 두 번 처리되지 않아요.";
    tone = "text-warn";
  } else if (note?.kind === "hint") {
    text = note.text;
  } else if (note?.kind === "done") {
    text = `${receiptText(note.receipt)} · ${note.text}`;
    tone = "text-ink";
  }
  return (
    <p ref={ref} role="status" tabIndex={-1} className={`min-h-6 rounded-sm text-meta outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${tone}`}>
      {text}
    </p>
  );
});

/** 거절 문장(서버 문장 그대로) */
export function ErrorLine({ id, children }: { id?: string; children: React.ReactNode }) {
  return (
    <p id={id} role="alert" className="rounded-md border border-bad-line bg-bad-soft px-3 py-2 text-meta text-bad">
      {children}
    </p>
  );
}

/** 인용문 — 따옴표 + 들여쓰기 없는 긴 글 줄바꿈 */
export function Quote({ children }: { children: React.ReactNode }) {
  return <blockquote className="max-h-32 overflow-y-auto rounded-md bg-surface-soft px-3 py-2 text-meta break-words whitespace-pre-wrap text-ink">“{children}”</blockquote>;
}

export const shortId = (id: string): string => (id.length > 12 ? `${id.slice(0, 8)}…` : id);
