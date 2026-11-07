import * as React from "react";

/**
 * 초안 — 같은 탭에만(sessionStorage, 새로고침 보존). 서버 초안 API는 없다(stage-1-ui 결정 13, F04).
 * 키에 폼 버전을 넣어, 질문이 새 버전이 되면 옛 초안이 새 버전으로 옮겨 가지 않게 한다(재확인 필요).
 */
export interface AnswerDraft {
  option?: string;
  other?: string;
  comment?: string;
  commentAsAnswer?: boolean;
  usedDefault?: boolean;
}

const PREFIX = "pes-draft:";

export function draftKey(slug: string, formVersion: number, questionId: string, questionVersion: number) {
  return `${PREFIX}${slug}:f${formVersion}:${questionId}:v${questionVersion}`;
}

function readDraft(key: string): AnswerDraft | null {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as AnswerDraft) : null;
  } catch {
    return null;
  }
}

const bus = new EventTarget();

export function useDraft(key: string) {
  const [draft, setDraftState] = React.useState<AnswerDraft | null>(() => readDraft(key));
  React.useEffect(() => {
    setDraftState(readDraft(key));
    const on = (e: Event) => {
      if ((e as CustomEvent<string>).detail === key) setDraftState(readDraft(key));
    };
    bus.addEventListener("change", on);
    return () => bus.removeEventListener("change", on);
  }, [key]);

  const setDraft = React.useCallback(
    (patch: Partial<AnswerDraft> | null) => {
      const next = patch === null ? null : { ...(readDraft(key) ?? {}), ...patch };
      try {
        if (next === null || Object.values(next).every((v) => v === undefined || v === "" || v === false)) sessionStorage.removeItem(key);
        else sessionStorage.setItem(key, JSON.stringify(next));
      } catch {
        /* 저장소를 못 쓰면 이 화면에서만 */
      }
      setDraftState(next && Object.values(next).some((v) => v !== undefined && v !== "" && v !== false) ? next : null);
      bus.dispatchEvent(new CustomEvent("change", { detail: key }));
    },
    [key],
  );

  return [draft, setDraft] as const;
}

export function readDraftNow(key: string) {
  return readDraft(key);
}

export function clearDraft(key: string) {
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* 무시 */
  }
  bus.dispatchEvent(new CustomEvent("change", { detail: key }));
}

/** 답 초안을 화면에 보일 한 줄 답으로 */
export function draftToAnswerText(d: AnswerDraft | null, options: { id: string; label: string }[]): string | null {
  if (!d) return null;
  const opt = options.find((o) => o.id === d.option);
  if (opt) {
    if (opt.label.startsWith("기타") && d.other) return `기타: ${d.other}`;
    return opt.label + (d.usedDefault ? " (기본값을 골랐음)" : "");
  }
  if (d.commentAsAnswer && d.comment) return `의견으로 답함: “${d.comment.length > 30 ? `${d.comment.slice(0, 30)}…` : d.comment}”`;
  if (d.comment && options.length === 0) return d.comment;
  return null;
}
