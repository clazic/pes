import * as React from "react";
import { useParams } from "react-router";
import { useWorkspace } from "@/api/queries";
import type { JudgeResult } from "@/api/types";
import { useArrival } from "@/app/arrival";
import { NotFound } from "@/app/NotFound";
import { placeLabel } from "@/lib/labels";
import { JudgeDialog, TITLE, actionOf, type JudgeSpec } from "./JudgeDialog";
import { AssumptionsSection, DecisionsSection } from "./RecordTables";
import { ReflectionSection } from "./ReflectionSection";

/**
 * 가정·결정·반영 화면(U3b · F04 · F06) — `/p/:slug/e/:edition/records`. 연구 공간 틀(사이드바 · 머리줄) 안의 본문 하나.
 * 세 영역(가정 · 결정 · 반영 내역)은 각각 표 하나다. 사람 판단 단추는 모두 인쇄에서 빠지는 묶음 안에 있다(인쇄에는 표만).
 * 판단 성공은 영수증을 받은 뒤에만 “접수 …”로 알린다. 그 줄은 처음부터 자리에 있어(화면 읽기 알림) 대화 상자가 닫히면 초점을 받는다.
 */
export function RecordsScreen() {
  const params = useParams();
  const slug = params.slug ?? "";
  const edition = /^[1-9]\d*$/.test(params.edition ?? "") ? Number(params.edition) : 0;
  const ws = useWorkspace(slug, edition);
  const w = ws.data;
  useArrival(!!w);

  const [dialog, setDialog] = React.useState<{ spec: JudgeSpec; opener: HTMLElement } | null>(null);
  const [receipt, setReceipt] = React.useState("");
  const receiptRef = React.useRef<HTMLParagraphElement>(null);

  React.useEffect(() => {
    if (w) document.title = `가정·결정·반영 · ${w.title} · PES`;
  }, [w]);

  const onDone = React.useCallback((spec: JudgeSpec, r: JudgeResult) => {
    setReceipt(`접수 ${r.receipt.receipt_no} · ${TITLE[actionOf(spec)]}을(를) 기록했어요.${r.receipt.replayed ? " (이미 처리된 요청이라 처음 접수를 다시 보여요.)" : ""}`);
    setDialog(null);
    // 단추가 사라질 수 있다 — 접수 줄이 그려진 다음 초점을 둔다
    window.setTimeout(() => receiptRef.current?.focus(), 0);
  }, []);

  const onStale = React.useCallback(() => {
    setReceipt("다른 곳에서 바뀌어 다시 읽었어요. 바뀐 내용을 보고 다시 판단해 주세요.");
    setDialog(null);
    window.setTimeout(() => receiptRef.current?.focus(), 0);
  }, []);

  if (ws.isPending) {
    return (
      <main id="main" tabIndex={-1} aria-busy="true" className="min-w-0">
        <p className="px-4 pt-5 pb-3 text-meta text-muted-foreground tab:px-6">불러오는 중</p>
      </main>
    );
  }
  if (!w) return <NotFound />;

  const round = w.current.round_id === null ? "start" : String(w.current.round_id);
  return (
    <main id="main" tabIndex={-1} className="min-w-0">
      <div className="border-b px-4 pt-4 pb-3 tab:px-6">
        <h1 data-screen-title="" tabIndex={-1} className="text-page text-ink">
          가정·결정·반영
        </h1>
        <p className="mt-1 text-meta text-muted-foreground">
          {w.title} · {w.edition}판 · 사람이 판단한 것만 확인·채택으로 남아요.
        </p>
      </div>
      <div className="w-full max-w-5xl px-4 pt-5 pb-16 tab:px-6">
        <p
          ref={receiptRef}
          role="status"
          tabIndex={-1}
          data-print="hide"
          className={`rounded-sm text-meta font-medium text-ink outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${receipt ? "mb-4" : ""}`}
        >
          {receipt}
        </p>
        <AssumptionsSection slug={w.slug} edition={w.edition} onJudge={(spec, opener) => setDialog({ spec, opener })} />
        <DecisionsSection slug={w.slug} edition={w.edition} onJudge={(spec, opener) => setDialog({ spec, opener })} />
        <div className="mt-8">
          <p className="mb-1 text-caption text-muted-foreground">{placeLabel(w.current.stage, w.current.round_id)} 첫머리에 보이는 내용</p>
          <ReflectionSection slug={w.slug} edition={w.edition} stage={w.current.stage} round={round} />
        </div>
      </div>
      {dialog ? <JudgeDialog spec={dialog.spec} slug={w.slug} edition={w.edition} opener={dialog.opener} onClose={() => setDialog(null)} onDone={(r) => onDone(dialog.spec, r)} onStale={onStale} /> : null}
    </main>
  );
}
