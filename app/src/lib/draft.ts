import * as React from "react";

/**
 * 같은 탭 초안(설계 12.5-6 · U1c) — sessionStorage. 서버에 보내지 않는다.
 *  - 논리 키 = draftKey(프로젝트 · 사용자 · 판 · 폼 버전 · 질문 · 질문 버전 + 칸). 질문이 새 버전이 되면 키가 바뀌어
 *    옛 초안이 몰래 옮겨 가지 않는다(옛 키 저장값은 그대로 — 사람이 검토해서 가져온다).
 *  - 실제 저장소 키 = `pes-draft:` + 논리 키.
 *  - 저장소를 못 쓰면(접근 자체가 예외) 모듈 수준 메모리에 둔다 — 같은 탭에서 화면을 옮겼다 돌아와도 남는다.
 *  - clearDraft(key): 확정(영수증) 성공 뒤 그 초안만 지운다. 떠 있는 훅도 빈 글로 돌아간다.
 */
const PREFIX = "pes-draft:";

export type DraftField = "answer" | "opinion";
export interface DraftParts {
  project: string;
  user: string;
  edition: number;
  form: number;
  question: string;
  version: number;
  field: DraftField;
}

/** 칸마다 이름표를 붙이고 글자는 인코딩해 칸 경계가 섞이지 않는다((판 1, 폼 12) ≠ (판 11, 폼 2)) */
export function draftKey(p: DraftParts): string {
  const enc = encodeURIComponent;
  return `p=${enc(p.project)}|u=${enc(p.user)}|e=${p.edition}|f=${p.form}|q=${enc(p.question)}|v=${p.version}|${p.field}`;
}

/** 저장소 대체 메모리(모듈 수준) — 저장소에 쓰지 못한 글만 둔다(저장소에 쓰면 그 키의 메모리 값은 지운다) */
const memory = new Map<string, string>();
const listeners = new Map<string, Set<() => void>>();

/** 저장소 접근 자체가 막혀 있던 중인가 — 다시 열리면 그 사이 메모리 글은 옛 것으로 보고 버린다(저장소 값과 섞여 이어 붙지 않게) */
let unavailable = false;

function storage(): Storage | null {
  try {
    const s = window.sessionStorage;
    if (unavailable) {
      unavailable = false;
      memory.clear();
    }
    return s;
  } catch {
    unavailable = true;
    return null;
  }
}

function readStored(storageKey: string): string {
  const s = storage();
  if (s) {
    try {
      // 저장소에 값이 없으면 메모리 대체도 본다(쓰기만 실패한 글 — 저장소에 쓰면 메모리 값은 지워져 섞이지 않는다)
      return s.getItem(storageKey) ?? memory.get(storageKey) ?? "";
    } catch {
      /* 읽기만 막힘 — 메모리로 */
    }
  }
  return memory.get(storageKey) ?? "";
}

function writeStored(storageKey: string, value: string) {
  try {
    const s = storage();
    if (!s) throw new Error("저장소 없음");
    if (value) s.setItem(storageKey, value);
    else s.removeItem(storageKey);
    memory.delete(storageKey);
  } catch {
    // 저장소를 못 쓰는 환경 — 메모리에만
    if (value) memory.set(storageKey, value);
    else memory.delete(storageKey);
  }
}

function notify(storageKey: string) {
  listeners.get(storageKey)?.forEach((fn) => fn());
}

/** 논리 키의 저장된 초안(없으면 빈 글) — 화면 밖에서 옛 버전 초안을 들여다볼 때 */
export function readDraft(key: string): string {
  return readStored(`${PREFIX}${key}`);
}

/** 확정(영수증) 성공 뒤 그 초안만 지운다 — 저장소 항목과 메모리 대체 값 모두. 없는 키도 조용히 */
export function clearDraft(key: string): void {
  const storageKey = `${PREFIX}${key}`;
  memory.delete(storageKey);
  writeStored(storageKey, "");
  notify(storageKey);
}

export interface DraftSetOptions {
  /** false 면 화면 값만 바꾸고 저장하지 않는다(한글 조합 중 — 조합이 끝나면 확정 값을 저장) */
  store?: boolean;
}

export function useDraft(key: string): [string, (v: string, options?: DraftSetOptions) => void] {
  const storageKey = `${PREFIX}${key}`;
  const [state, setState] = React.useState(() => ({ key: storageKey, value: readStored(storageKey) }));
  // 키가 바뀌면 그 그림에서 바로 새 키의 값을 쓴다(옛 키 글이 한 번도 보이지 않게)
  const current = state.key === storageKey ? state : { key: storageKey, value: readStored(storageKey) };
  if (current !== state) setState(current);

  // clearDraft 가 이 키를 지우면 빈 글로
  React.useEffect(() => {
    const fn = () => setState({ key: storageKey, value: readStored(storageKey) });
    let set = listeners.get(storageKey);
    if (!set) listeners.set(storageKey, (set = new Set()));
    set.add(fn);
    return () => {
      set.delete(fn);
      if (!set.size) listeners.delete(storageKey);
    };
  }, [storageKey]);

  const set = React.useCallback(
    (v: string, options?: DraftSetOptions) => {
      setState({ key: storageKey, value: v });
      if (options?.store !== false) writeStored(storageKey, v);
    },
    [storageKey],
  );
  return [current.value, set];
}

/**
 * 초안 키의 “폼 버전” 칸 — 질문 버전이 처음 이 탭에 보인 때의 폼 버전을 기억해 쓴다(U2b · F04).
 * 질문을 더하거나 순서를 바꿔 폼 버전이 올라가도 질문 버전이 같으면 같은 초안 키가 되어 쓰던 글이 남는다.
 * 질문이 새 버전이 되면 키가 바뀌어 옛 초안은 몰래 옮겨 가지 않는다(검토 영역에서 사람이 가져온다).
 * 기억은 저장소 항목 하나(JSON)에 모은다 — 초안 항목(`pes-draft:`)과 섞이지 않는다. write 가 false 면 기억만 읽는다(없으면 current).
 */
const FORMS_KEY = "pes-draft-forms";

export function originForm(parts: { project: string; user: string; edition: number; question: string; version: number }, current: number, write = true): number {
  const id = `${parts.project}|${parts.user}|${parts.edition}|${parts.question}|${parts.version}`;
  let map: Record<string, number> = {};
  try {
    const parsed: unknown = JSON.parse(readStored(FORMS_KEY) || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) map = parsed as Record<string, number>;
  } catch {
    /* 깨진 기억은 없는 것으로 */
  }
  const known = map[id];
  if (typeof known === "number" && Number.isInteger(known) && known > 0) return known;
  if (write) writeStored(FORMS_KEY, JSON.stringify({ ...map, [id]: current }));
  return current;
}
