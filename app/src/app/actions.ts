/**
 * 동작 목록 하나(설계 4.15 · stage-1-ui 결정 5 · U1c) — 명령 메뉴의 option 과 질문 맥락 메뉴의 menuitem 이 같은 동작 객체를 쓴다.
 * 라벨 · 단축키(aria-keyshortcuts)는 여기서만 정한다. 맥락 메뉴는 이 목록의 부분 집합이다.
 */
export type ActionGroup = "이동" | "보기" | "질문";

export interface PesAction {
  id: string;
  label: string;
  group: ActionGroup;
  /** aria-keyshortcuts 값(있을 때만) */
  keys?: string;
  /** 화면에 보일 키 이름(장식) */
  keyHint?: string[];
  run: () => void;
}

export const ACTION_LABELS = {
  goAsk: "질문으로 가기",
  goBody: "본문으로 가기",
  print: "인쇄 미리보기 열기",
  sidebar: "사이드바 접기 · 펴기",
  peek: (n: number) => `질문 ${n} 미리보기`,
} as const;

export const ACTION_GROUPS: ActionGroup[] = ["이동", "보기", "질문"];

/** 작업 공간이 내놓는 동작(질문마다 미리보기 하나) */
export function workspaceActions(opts: {
  questions: { id: string; number: number }[];
  goAsk: () => void;
  goBody: () => void;
  print: () => void;
  peek: (id: string) => void;
}): PesAction[] {
  return [
    { id: "go-ask", label: ACTION_LABELS.goAsk, group: "이동", run: opts.goAsk },
    { id: "go-body", label: ACTION_LABELS.goBody, group: "이동", run: opts.goBody },
    { id: "print", label: ACTION_LABELS.print, group: "보기", run: opts.print },
    ...opts.questions.map((q) => ({ id: `peek:${q.id}`, label: ACTION_LABELS.peek(q.number), group: "질문" as const, run: () => opts.peek(q.id) })),
  ];
}

/** 질문 하나의 맥락 메뉴 — 같은 목록에서 그 질문의 미리보기와 본문으로 가기만 고른다 */
export function questionActions(all: PesAction[], questionId: string): PesAction[] {
  const pick = (id: string) => all.filter((a) => a.id === id);
  return [...pick(`peek:${questionId}`), ...pick("go-body")];
}

/** 부분 글자(대소문자 무시) 거르기 — 공백은 무시하고 비교한다(“인쇄미리보기”도 찾힘) */
export function filterActions(all: PesAction[], query: string): PesAction[] {
  const norm = (s: string) => s.toLocaleLowerCase("ko").replace(/[\s·]+/g, "");
  const q = norm(query);
  return q ? all.filter((a) => norm(a.label).includes(q)) : all;
}
