import * as React from "react";
import { useParams, useSearchParams } from "react-router";
import { useRound, useWorkspace } from "@/api/queries";
import { useArrival } from "@/app/arrival";
import { NotFound } from "@/app/NotFound";
import { useIsPhone } from "@/lib/media";
import { AskPane } from "./AskPane";
import { BodyPane } from "./BodyPane";
import { PeekDialog, PrintPreview, ViewSwitch } from "./Overlays";
import { parseView, roundHref, type View } from "./paths";
import { StageNav } from "./StageNav";

const PHONE_REASON = {
  edit: "휴대폰에서는 질문을 고칠 수 없어요 — 데스크톱에서 해 주세요.",
  annotate: "휴대폰에서는 첨언을 쓸 수 없어요 — 데스크톱에서 써 주세요.",
};
const PAST_REASON = {
  edit: "지난 라운드는 읽기 전용이라 질문을 고칠 수 없어요.",
  annotate: "지난 라운드는 읽기 전용이라 첨언을 쓸 수 없어요.",
};

/** 다음 그림 뒤에 그 요소로 초점(주소를 바꾼 뒤 화면이 따라 그려진 다음) */
const focusSoon = (get: () => HTMLElement | null | undefined) => window.setTimeout(() => get()?.focus(), 0);

/**
 * 작업 공간 — 3/2/1영역(설계 3.8 · 4.5 · 4.7 · 12.3). 주소가 상태다:
 * 경로 = 단계·라운드, view = 좁은 화면 보기, focus = 초점 자리, peek = 미리보기, print = 인쇄 미리보기.
 */
export function WorkspaceScreen() {
  const params = useParams();
  const slug = params.slug ?? "";
  const edition = /^[1-9]\d*$/.test(params.edition ?? "") ? Number(params.edition) : 0;
  const stage = params.stage ?? "";
  const roundParam = params.round ?? "";
  const [sp, setSp] = useSearchParams();
  const ws = useWorkspace(slug, edition);
  const rq = useRound(slug, edition, stage, roundParam);
  const phone = useIsPhone();
  const ready = !!ws.data && !!rq.data && !rq.isPlaceholderData;
  useArrival(ready);

  const view = parseView(sp.get("view"));
  const print = sp.get("print") === "1";
  const peekParam = sp.get("peek");
  const [peekFocus, setPeekFocus] = React.useState(false);
  const askRef = React.useRef<HTMLElement>(null);
  const printHeading = React.useRef<HTMLHeadingElement>(null);

  // 주소 검색어 바꾸기. 한 번의 동작에서 여러 번 바꿔도(닫기 → 초점 따라가기) 앞의 변경을 잃지 않게 마지막 값을 따로 들고 있는다
  const latest = React.useRef(sp);
  React.useLayoutEffect(() => {
    latest.current = sp;
  }, [sp]);
  const setParams = React.useCallback(
    (change: Record<string, string | null>, replace: boolean) => {
      const next = new URLSearchParams(latest.current);
      for (const [k, v] of Object.entries(change)) {
        if (v === null) next.delete(k);
        else next.set(k, v);
      }
      latest.current = next;
      setSp(next, { replace });
    },
    [setSp],
  );

  const w = ws.data;
  const round = rq.data;
  const title = round ? (round.round_id === null ? `${round.stage_label} 단계 시작` : `${round.stage_label} ${round.label}`) : "";
  React.useEffect(() => {
    if (ready && w) document.title = `${title} · ${w.title} · PES`;
  }, [ready, title, w]);

  const closePeek = React.useCallback(() => {
    const id = peekParam;
    setPeekFocus(false);
    setParams({ peek: null }, true);
    focusSoon(() => (id ? document.getElementById(`peek-${id}`) : null));
  }, [peekParam, setParams]);

  // 질문 영역 안에서 초점을 옮기면 주소의 focus 가 따라간다(기록 칸을 쌓지 않음 — replace)
  const focusParam = sp.get("focus");
  React.useEffect(() => {
    const el = askRef.current;
    if (!el) return;
    const onFocusIn = (e: FocusEvent) => {
      // 질문 칸(q-…)만 따라간다 — 미리보기 단추 같은 도구는 초점 자리로 남기지 않는다
      const id = (e.target as HTMLElement).id;
      if (id.startsWith("q-") && id !== focusParam) setParams({ focus: id }, true);
    };
    el.addEventListener("focusin", onFocusIn);
    return () => el.removeEventListener("focusin", onFocusIn);
  }, [focusParam, setParams, ready]);

  // 불러오는 동안에도 같은 틀(영역 셋 · 하나의 <main>)을 그린다 — 자료가 오면 그 안만 바뀐다
  if (ws.isPending || (rq.isPending && !rq.data)) {
    return (
      <>
        <main id="main" tabIndex={-1} aria-busy="true" className="min-w-0">
          <div className="px-4 pt-5 pb-3 text-meta text-muted-foreground tab:px-6">불러오는 중</div>
          <ViewSwitch view={view} onChange={() => {}} />
          {null}
          <div className="ws-grid" data-view={view}>
            <nav aria-label="단계와 라운드" data-area="nav" />
            <div data-area="body" />
            <aside aria-label="질문" data-area="ask" />
          </div>
        </main>
        {null}
      </>
    );
  }
  if (!w || !round) {
    const back = w ? { href: roundHref(w.slug, w.edition, w.current.stage, w.current.round_id), label: "현재 진행 라운드로 가기" } : undefined;
    return <NotFound back={back} />;
  }

  const past = round.state !== "current";
  const editBlocked = past ? PAST_REASON.edit : phone ? PHONE_REASON.edit : undefined;
  const annotateBlocked = past ? PAST_REASON.annotate : phone ? PHONE_REASON.annotate : undefined;
  const peekQ = peekParam ? round.questions.find((q) => q.id === peekParam) : undefined;
  const draftScope = `${w.slug}:${w.edition}:${round.stage}:${round.round_id ?? "start"}:f${round.form_version}`;

  const onView = (v: View) => setParams({ view: v }, true);
  const onPeek = (id: string) => {
    setPeekFocus(true);
    setParams({ peek: id }, false);
  };
  const onPrint = () => {
    setParams({ print: "1" }, false);
    focusSoon(() => printHeading.current);
  };
  const onClosePrint = () => {
    setParams({ print: null }, true);
    focusSoon(() => document.getElementById("tool-print"));
  };
  const onGoToQuestions = () => {
    const first = round.questions.find((q) => !q.sent && q.required) ?? round.questions.find((q) => !q.sent);
    setParams({ view: "ask", focus: first?.id ?? null }, true);
    focusSoon(() => (first ? document.getElementById(first.id) : null));
  };

  return (
    <>
      <main id="main" tabIndex={-1} className="min-w-0">
        <ScreenTitle title={title} edition={w.edition} past={past} count={round.questions.length} />
        <ViewSwitch view={view} onChange={onView} />
        {print ? <PrintPreview round={round} title={`${w.title} — ${title}`} headingRef={printHeading} onClose={onClosePrint} /> : null}
        <div className="ws-grid" data-view={view}>
          <nav aria-label="단계와 라운드" data-area="nav">
            <StageNav ws={w} viewing={{ stage: round.stage, round_id: round.round_id }} />
          </nav>
          <div data-area="body" className="min-w-0">
            <BodyPane ws={w} round={round} annotateBlocked={annotateBlocked} onPrint={onPrint} onGoToQuestions={onGoToQuestions} />
          </div>
          <aside ref={askRef} aria-label="질문" data-area="ask">
            <AskPane round={round} draftScope={draftScope} editBlocked={editBlocked} peekId={peekQ?.id ?? null} onPeek={onPeek} />
          </aside>
        </div>
      </main>
      {peekQ ? <PeekDialog q={peekQ} focusOnOpen={peekFocus} onClose={closePeek} /> : null}
    </>
  );
}

/** 화면 제목 줄 — 세 영역 위에 걸쳐 어느 보기에서나 보인다. 화면이 바뀌면 초점이 이 제목으로 온다(data-screen-title) */
function ScreenTitle({ title, edition, past, count }: { title: string; edition: number; past: boolean; count: number }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b px-4 pt-4 pb-3 tab:px-6">
      <h1 data-screen-title="" tabIndex={-1} className="text-page text-ink">
        {title}
      </h1>
      <p className="text-meta text-muted-foreground">
        판 {edition} · {past ? "지난 라운드" : "현재 진행"} · 질문 {count}개
      </p>
    </div>
  );
}
