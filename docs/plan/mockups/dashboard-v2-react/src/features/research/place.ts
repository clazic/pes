import type { WorkspaceView } from "@/api/types";

/* 연구 공간에서 지금 보는 곳의 이름 — 머리줄 위치 · 이어서 하기(마지막 위치)가 같은 말을 쓴다(5차). 첫 묶음에 들어가므로 가볍게 둔다. */

const PAGE_LABEL: Record<string, string> = {
  problems: "막힌 것·풀 것",
  files: "자료",
  references: "참고 프로젝트",
  ai: "AI 작업 기록",
  settings: "설정",
  editions: "판",
  sync: "내 컴퓨터 연결",
};

/** 지금 보는 곳의 이름(이어서 하기 · 머리줄 위치에 같은 말). 연구 개요는 null(이어서 하기 대상이 아님) */
export function researchPlaceLabel(ws: WorkspaceView, pathname: string, search: string, hash: string): string | null {
  const base = `/p/${ws.slug}`;
  const rest = pathname.slice(base.length);
  if (rest === "" || rest === "/") return null;
  if (rest.startsWith("/e/")) {
    const t = new URLSearchParams(search).get("t");
    const step = ws.tasks.find((x) => x.id === t) ?? ws.tasks.find((x) => x.counted) ?? ws.tasks[0];
    const h = hash.replace("#", "");
    const q = h.startsWith("q-") || h.startsWith("b-") ? ws.form.questions.find((x) => x.id === h)?.number : null;
    const para = h.startsWith("para-") ? `문단 ${Number(h.slice(5)) + 1}` : null;
    return `지금 할 일 · ${step?.title ?? ws.current.label}${q ? ` · ${q}` : para ? ` · ${para}` : ""}`;
  }
  const page = rest.split("/")[1] ?? "";
  if (page === "s") {
    const st = rest.split("/")[2] ?? "";
    const stage = ws.stages.find((x) => x.key === st);
    return stage ? `단계 결과 · ${({ plan: "기획", research: "조사", analyze: "분석·종합", write: "집필", verify: "검증", publish: "산출·공유" } as Record<string, string>)[stage.key]}` : "단계 결과";
  }
  if (page === "problems" && hash.startsWith("#pb-")) {
    const p = ws.problems.find((x) => `#pb-${x.id}` === hash);
    if (p) return `막힌 것·풀 것 · ${p.title}`;
  }
  return PAGE_LABEL[page] ?? null;
}

