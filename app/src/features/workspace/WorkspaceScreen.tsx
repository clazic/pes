import * as React from "react";
import { useParams, useSearchParams } from "react-router";
import { ArrowRight } from "lucide-react";
import { useProjects, useRound, useWorkspace } from "@/api/queries";
import type { RoundView, WorkspaceView } from "@/api/types";
import { workspaceActions } from "@/app/actions";
import { useArrival } from "@/app/arrival";
import { useRegisterActions } from "@/app/CommandMenu";
import { NotFound } from "@/app/NotFound";
import { Status, turnKey, turnLabel } from "@/components/pes/status";
import { Button } from "@/components/ui/button";
import { placeLabel } from "@/lib/labels";
import { useIsPhone } from "@/lib/media";
import { AskPane } from "./AskPane";
import { AiConnectionChip } from "./AiConnectionChip";
import { BodyPane } from "./BodyPane";
import { PeekDialog, PrintPreview, ViewSwitch } from "./Overlays";
import { parseView, roundHref, type View } from "./paths";

const PHONE_REASON = {
  edit: "휴대폰에서는 질문을 고칠 수 없어요 — 데스크톱에서 해 주세요.",
  annotate: "휴대폰에서는 첨언을 쓸 수 없어요 — 데스크톱에서 써 주세요.",
};
const PAST_REASON = {
  edit: "지난 라운드는 읽기 전용이라 질문을 고칠 수 없어요.",
};
/** 첨언은 라운드가 아니라 판 기준이다 — 활성 판의 봉인(closed) 라운드 결과 글에는 쓸 수 있고, 지난 판만 읽기 전용 */
const PAST_EDITION_REASON = { annotate: "지난 판은 읽기 전용이라 첨언을 쓸 수 없어요." };

/** 초점이 사라진 요소와 함께 빠졌는가(닫힌 대화 상자 · 미리보기 안에 있던 초점) */
const focusLost = () => !document.activeElement || document.activeElement === document.body;

/**
 * 작업 공간 — 연구 공간 틀(사이드바 · 머리줄) 안의 본문 · 질문(설계 3.8 · 4.5 · 4.7 · 12.3 · 12.9). 단계·라운드 탐색은 사이드바 나무가 맡는다.
 * ≥1280 본문 | 질문 나란히, <1280 한 열 + 보기 전환(본문/질문). 주소가 상태다:
 * 경로 = 단계·라운드, view = 좁은 화면 보기, focus = 초점 자리, peek = 미리보기, print = 인쇄 미리보기.
 * 랜드마크: 본문 `main`(화면 제목 · 지금 할 일 · 본문 영역) · 질문 `aside` 가 서로 형제다(aside 는 최상위 랜드마크).
 *
 * 초점 규칙: 주소를 바꾼 뒤 초점을 옮겨야 하면(질문으로 가기 · 인쇄 미리보기 열기/닫기) “그 주소가 그려진 다음”에 옮긴다 —
 * 좁은 화면에서는 주소가 바뀌어야 그 영역이 보이므로(display:none 인 동안 focus() 는 듣지 않는다).
 * 같은 화면에서 검색어만 바꾸는 이동은 preventScrollReset — 스크롤 복원이 화면을 맨 위로 되돌려 초점을 화면 밖에 두지 않게.
 */
export function WorkspaceScreen() {
  const params = useParams();
  const slug = params.slug ?? "";
  const edition = /^[1-9]\d*$/.test(params.edition ?? "") ? Number(params.edition) : 0;
  const stage = params.stage ?? "";
  const roundParam = params.round ?? "";
  const [sp, setSp] = useSearchParams();
  const ws = useWorkspace(slug, edition);
  const projects = useProjects();
  const rq = useRound(slug, edition, stage, roundParam);
  // 질문별 의견은 부차 읽기다 — 첫 표시를 기다리지 않는다(AskPane 이 읽고, 스레드 칸만 “불러오는 중”을 보인다)
  const phone = useIsPhone();
  const ready = !!ws.data && !!rq.data && !rq.isPlaceholderData;
  useArrival(ready);

  const view = parseView(sp.get("view"));
  const print = sp.get("print") === "1";
  const peekParam = sp.get("peek");
  const search = sp.toString();
  /** 미리보기 대화 상자로 초점을 옮길 차례(여는 동작마다 하나씩 늘어난다 — 딥링크로 열린 것은 0) */
  const [peekFocus, setPeekFocus] = React.useState(0);
  const askRef = React.useRef<HTMLElement>(null);

  // 주소 검색어 바꾸기. 한 번의 동작에서 여러 번 바꿔도 앞의 변경을 잃지 않게 마지막 값을 따로 들고 있는다
  const latest = React.useRef(sp);
  React.useLayoutEffect(() => {
    latest.current = sp;
  }, [sp]);
  /** 바꾼 뒤 그려지면 초점을 둘 곳(그 주소가 그려진 다음에 한 번) */
  const pendingFocus = React.useRef<{ search: string; get: () => HTMLElement | null | undefined } | null>(null);
  const setParams = React.useCallback(
    (change: Record<string, string | null>, replace: boolean, focusAfter?: () => HTMLElement | null | undefined) => {
      const next = new URLSearchParams(latest.current);
      for (const [k, v] of Object.entries(change)) {
        if (v === null) next.delete(k);
        else next.set(k, v);
      }
      const same = next.toString() === latest.current.toString();
      latest.current = next;
      pendingFocus.current = null;
      if (same) {
        // 주소가 그대로면 화면도 그대로 — 바로 옮긴다
        focusAfter?.()?.focus();
        return;
      }
      if (focusAfter) pendingFocus.current = { search: next.toString(), get: focusAfter };
      setSp(next, { replace, preventScrollReset: true });
    },
    [setSp],
  );

  // 주소가 그려진 다음 — 맡겨 둔 초점을 옮긴다
  React.useEffect(() => {
    const p = pendingFocus.current;
    if (!p || p.search !== search || !ready) return;
    pendingFocus.current = null;
    p.get()?.focus();
  }, [search, ready]);

  // 미리보기 · 인쇄 미리보기가 어떤 길로든(닫기 · Esc · 뒤로 가기) 닫혀 초점이 빠졌으면 연 단추로 돌려준다
  const prev = React.useRef({ peek: peekParam, print });
  React.useEffect(() => {
    const was = prev.current;
    prev.current = { peek: peekParam, print };
    if (!ready) return;
    if (was.peek && !peekParam && focusLost()) document.getElementById(`peek-${was.peek}`)?.focus();
    if (was.print && !print && focusLost()) document.getElementById("tool-print")?.focus();
  }, [peekParam, print, ready]);

  const closePeek = React.useCallback(() => {
    setPeekFocus(0);
    setParams({ peek: null }, true);
  }, [setParams]);

  // 질문 영역 안에서 초점을 옮기면 주소의 focus 가 따라간다(기록 칸을 쌓지 않음 — replace, 스크롤 그대로)
  const focusParam = sp.get("focus");
  React.useEffect(() => {
    const el = askRef.current;
    if (!el) return;
    const onFocusIn = (e: FocusEvent) => {
      // 질문 칸(q-…)과 질문 항목 자체(J/K 이동)만 따라간다 — 미리보기 단추 같은 도구는 초점 자리로 남기지 않는다
      const t = e.target as HTMLElement;
      const id = t.id.startsWith("q-") ? t.id : (t.dataset.question ?? "");
      // 빠르게 연달아 눌러도 앞 변경을 놓치지 않게, 그려진 주소(focusParam)가 아니라 마지막으로 정한 값(latest)과 견준다
      if (id && id !== latest.current.get("focus")) setParams({ focus: id }, true);
    };
    el.addEventListener("focusin", onFocusIn);
    return () => el.removeEventListener("focusin", onFocusIn);
  }, [focusParam, setParams, ready]);

  const w = ws.data;
  const round = rq.data;
  const title = round ? placeLabel(round.stage, round.round_id) : "";
  const past = !!round && round.state !== "current";
  const openQs = round?.questions.filter((q) => (q.status ?? "open") === "open") ?? [];
  const firstOpen = openQs.find((q) => !q.sent && q.required) ?? openQs.find((q) => !q.sent);

  const onView = (v: View) => setParams({ view: v }, true);
  const onPeek = (id: string) => {
    setPeekFocus((n) => n + 1);
    setParams({ peek: id }, false);
  };
  /** 미리보기 순서 넘김 — peek 만 바꾼다(기록을 쌓지 않음 · 다른 검색어와 경로 그대로 · 초점은 대화 상자 안에 남음) */
  const onPagePeek = (id: string) => setParams({ peek: id }, true);
  const onPrint = () => setParams({ print: "1" }, false, () => document.getElementById("print-title"));
  const onClosePrint = () => setParams({ print: null }, true, () => document.getElementById("tool-print"));
  /** J/K · 이전/다음 — 질문 영역이 CSS 로 숨은 좁은 본문 보기(<1280 이고 view≠ask)면 질문 보기로 바꾼 뒤 그려지면 초점(display:none 인 동안 focus() 는 듣지 않는다) */
  const goToQuestion = React.useCallback(
    (id: string) => {
      const item = () => document.querySelector<HTMLElement>(`[data-question="${CSS.escape(id)}"]`);
      const wide = window.matchMedia("(min-width: 1280px)").matches;
      if (wide || latest.current.get("view") === "ask") item()?.focus();
      else setParams({ view: "ask", focus: id }, true, item);
    },
    [setParams],
  );
  const onGoToQuestions = firstOpen && !past ? () => setParams({ view: "ask", focus: firstOpen.id }, true, () => document.getElementById(firstOpen.id)) : undefined;
  // 동작 목록 하나(명령 메뉴 · 질문 맥락 메뉴가 같이 쓴다). 동작은 실행할 때만 ref(latest)를 읽는다 — 그리는 동안 읽지 않음
  const actions = round
    ? // oxlint-disable-next-line react/refs
      workspaceActions({
        questions: openQs,
        goAsk: () =>
          setParams({ view: "ask" }, true, () =>
            firstOpen && !past ? document.getElementById(firstOpen.id) : (document.getElementById(`peek-${openQs[0]?.id}`) ?? document.getElementById("ask-title")),
          ),
        goBody: () => setParams({ view: null }, true, () => document.querySelector<HTMLElement>("main [data-screen-title]")),
        print: onPrint,
        peek: onPeek,
      })
    : [];
  useRegisterActions(actions);
  React.useEffect(() => {
    if (ready && w) document.title = `${title} · ${w.title} · PES`;
  }, [ready, title, w]);

  // 불러오는 동안에도 같은 틀(영역 셋 · 하나의 <main>)을 그린다 — 자료가 오면 그 안만 바뀐다
  if (ws.isPending || (rq.isPending && !rq.data)) {
    return (
      <div className="ws-frame">
        <ViewSwitch view={view} onChange={() => {}} />
        <div className="ws-grid" data-view={view}>
          <main id="main" tabIndex={-1} aria-busy="true" className="ws-main">
            <p className="px-4 pt-5 pb-3 text-meta text-muted-foreground tab:px-6">불러오는 중</p>
            <div data-area="body" />
          </main>
          <aside aria-label="질문" data-area="ask" />
        </div>
      </div>
    );
  }
  if (!w || !round) {
    const back = w ? { href: roundHref(w.slug, w.edition, w.current.stage, w.current.round_id), label: "현재 진행 라운드로 가기" } : undefined;
    return <NotFound back={back} />;
  }

  const editBlocked = past ? PAST_REASON.edit : phone ? PHONE_REASON.edit : undefined;
  // 첨언 차단: 서버의 활성 판이 아닌 판(지난 판)만. 봉인된 라운드(round.state "closed")여도 활성 판이면 쓸 수 있다. 활성 판을 모르면(목록 없음) 판 기준으로 막지 않는다 — 서버가 지난 판 쓰기를 거절한다
  const activeEdition = projects.data?.find((p) => p.slug === w.slug)?.edition;
  const pastEdition = activeEdition !== undefined && activeEdition !== w.edition;
  const annotateBlocked = pastEdition ? PAST_EDITION_REASON.annotate : phone ? PHONE_REASON.annotate : undefined;
  const peekQ = peekParam ? openQs.find((q) => q.id === peekParam) : undefined;

  return (
    <div className="ws-frame">
      <ViewSwitch view={view} onChange={onView} />
      <div className="ws-grid" data-view={view} data-printing={print ? "" : undefined}>
        <main id="main" tabIndex={-1} className="ws-main">
          <ScreenHead ws={w} round={round} title={title} past={past} onGoToQuestions={onGoToQuestions} />
          {print ? <PrintPreview round={round} title={`${w.title} — ${title}`} onClose={onClosePrint} /> : null}
          <div data-area="body" className="min-w-0">
            <BodyPane ws={w} round={round} annotateBlocked={annotateBlocked} onPrint={onPrint} />
          </div>
        </main>
        <aside ref={askRef} aria-label="질문" data-area="ask">
          {peekQ ? <PeekDialog q={peekQ} questions={openQs} focusToken={peekFocus} onPage={onPagePeek} onClose={closePeek} /> : null}
          <AskPane round={round} project={w.slug} edition={w.edition} actions={actions} editBlocked={editBlocked} peekId={peekQ?.id ?? null} onPeek={onPeek} onGoTo={goToQuestion} />
        </aside>
      </div>
    </div>
  );
}

/**
 * 화면 머리(가운데 영역 위) — 화면 제목(화면이 바뀌면 초점이 여기로, data-screen-title) · 판 · 현재/지난 ·
 * “지금 할 일” 줄: 차례 말(상태 사전 그대로 — “나의 할 일 1건”) · 먼저 할 일 한 줄 · 질문으로 가기.
 */
function ScreenHead({ ws, round, title, past, onGoToQuestions }: { ws: WorkspaceView; round: RoundView; title: string; past: boolean; onGoToQuestions?: () => void }) {
  const asked = round.questions.filter((q) => (q.status ?? "open") === "open");
  const open = asked.filter((q) => !q.sent).length;
  return (
    <div className="border-b px-4 pt-4 pb-3 tab:px-6">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 data-screen-title="" tabIndex={-1} className="text-page text-ink">
          {title}
        </h1>
        <p className="text-meta text-muted-foreground">
          {ws.edition}판 · {past ? "지난 라운드" : "현재 진행"} · 질문 {asked.length}개{past ? "" : ` · 답할 질문 ${open}개`}
        </p>
        <AiConnectionChip ai={ws.ai_connection} mode={ws.mode} />
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-2" data-print="hide">
        <Status of="turn" value={turnKey(ws.turn)} label={turnLabel(ws.turn)} />
        {ws.turn.text ? <p className="min-w-0 flex-[1_1_14rem] text-meta text-ink">{ws.turn.text}</p> : null}
        {onGoToQuestions && ws.turn.side === "you" ? (
          <Button variant="default" size="sm" onClick={onGoToQuestions}>
            질문으로 가기
            <ArrowRight aria-hidden="true" />
          </Button>
        ) : null}
      </div>
    </div>
  );
}
