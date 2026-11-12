import * as React from "react";
import { useParams } from "react-router";
import { useReferences, useWorkspace } from "@/api/queries";
import type { CommandResult } from "@/api/types";
import { useArrival } from "@/app/arrival";
import { NotFound } from "@/app/NotFound";
import { Button } from "@/components/ui/button";
import { ReadFailure, Skeleton } from "@/features/records/parts";
import { ContentPane } from "./ContentPane";
import { AttachDialog, DetachDialog, RefreshDialog } from "./Dialogs";
import { receiptWord } from "./logic";
import { ReferenceTable, type RowAction } from "./ReferenceTable";

type Open = { kind: "attach"; opener: HTMLElement } | { kind: "refresh" | "detach"; refId: string; opener: HTMLElement };

/**
 * 참고 프로젝트 화면 — `/p/:slug/e/:edition/references`. 이전 프로젝트의 고정한 버전을 읽기 전용으로 가리키는 줄의 목록(REF1b · 설계 4.9 · 5.4).
 * 고정한 버전은 저절로 바뀌지 않는다 — 새 버전은 “새 버전 있음”으로만 알리고 사람이 다시 고른다.
 * 쓰기(붙이기 · 다시 고정 · 떼기)는 대화 상자에서, 성공은 영수증을 받은 뒤에만 “접수 …”로 알린다(F06). 그 줄은 처음부터 자리에 있어 대화 상자가 닫히면 초점을 받는다.
 */
export function ReferencesScreen() {
  const params = useParams();
  const slug = params.slug ?? "";
  const edition = /^[1-9]\d*$/.test(params.edition ?? "") ? Number(params.edition) : 0;
  const ws = useWorkspace(slug, edition);
  const w = ws.data;
  const refs = useReferences(slug, edition);
  useArrival(!!w);

  const [dialog, setDialog] = React.useState<Open | null>(null);
  const [viewing, setViewing] = React.useState<{ refId: string; opener: HTMLElement } | null>(null);
  const [receipt, setReceipt] = React.useState("");
  const receiptRef = React.useRef<HTMLParagraphElement>(null);

  React.useEffect(() => {
    if (w) document.title = `참고 프로젝트 · ${w.title} · PES`;
  }, [w]);

  /** 성공 — 영수증을 받은 뒤. 단추가 사라질 수 있어 접수 줄이 그려진 다음 초점을 둔다 */
  const done = (what: string) => (r: CommandResult<unknown>) => {
    setReceipt(`${receiptWord(r.receipt)} · ${what}${r.receipt.replayed ? " (이미 처리된 요청이라 처음 접수를 다시 보여요.)" : ""}`);
    setDialog(null);
    window.setTimeout(() => receiptRef.current?.focus(), 0);
  };

  const onAction = (action: RowAction, row: { id: string }, opener: HTMLElement) => {
    if (action === "view") setViewing({ refId: row.id, opener });
    else setDialog({ kind: action, refId: row.id, opener });
  };

  if (ws.isPending) {
    return (
      <main id="main" tabIndex={-1} aria-busy="true" className="min-w-0">
        <p className="px-4 pt-5 pb-3 text-meta text-muted-foreground tab:px-6">불러오는 중</p>
      </main>
    );
  }
  if (!w) return <NotFound />;

  const rows = refs.data;
  const detach = dialog?.kind === "detach" ? rows?.find((x) => x.id === dialog.refId) : undefined;
  const view = viewing ? rows?.find((x) => x.id === viewing.refId) : undefined;
  return (
    <main id="main" tabIndex={-1} className="min-w-0">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3 border-b px-4 pt-4 pb-3 tab:px-6">
        <div className="min-w-0">
          <h1 data-screen-title="" tabIndex={-1} className="text-page text-ink">
            참고 프로젝트
          </h1>
          <p className="mt-1 text-meta text-muted-foreground">
            {w.title} · {w.edition}판 · 이전 프로젝트의 고정한 버전을 읽기 전용으로 가리켜요.
          </p>
        </div>
        <div data-print="hide">
          <Button variant="default" onClick={(e) => setDialog({ kind: "attach", opener: e.currentTarget })}>
            참고 프로젝트 붙이기
          </Button>
        </div>
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
        <p data-ai-notice="" className="max-w-[70ch] text-meta text-ink-2">
          AI 전달이 안 되는 참고 프로젝트도 이 화면에서는 계속 보입니다. 사람에게 보이는 것과 AI 에게 가는 것은 따로 정해져요.
        </p>

        {refs.isPending ? (
          <div aria-busy="true">
            <Skeleton />
          </div>
        ) : refs.isError ? (
          <div role="alert">
            <ReadFailure error={refs.error} onRetry={() => void refs.refetch()} />
          </div>
        ) : rows && rows.length === 0 ? (
          <div className="mt-4 rounded-md border border-dashed border-control bg-surface px-3 py-3">
            <p className="text-meta font-medium text-ink">붙인 참고 프로젝트가 없습니다</p>
            <p className="mt-0.5 text-caption text-ink-2">이전 프로젝트의 한 버전을 붙이면 사람이 이 화면에서 읽을 수 있고, 허용된 범위 안에서 AI 도 읽어요.</p>
          </div>
        ) : (
          <div className="mt-4">
            <ReferenceTable rows={rows ?? []} onAction={onAction} />
          </div>
        )}

        {viewing && view ? (
          <ContentPane
            key={viewing.refId}
            slug={w.slug}
            edition={w.edition}
            row={view}
            onClose={() => {
              const opener = viewing.opener;
              setViewing(null);
              window.setTimeout(() => (opener.isConnected ? opener : receiptRef.current)?.focus(), 0);
            }}
          />
        ) : null}
      </div>

      {dialog?.kind === "attach" ? <AttachDialog slug={w.slug} edition={w.edition} opener={dialog.opener} onClose={() => setDialog(null)} onDone={done("참고 프로젝트를 붙였어요.")} /> : null}
      {dialog?.kind === "refresh" ? <RefreshDialog slug={w.slug} edition={w.edition} refId={dialog.refId} opener={dialog.opener} onClose={() => setDialog(null)} onDone={done("다른 버전으로 다시 고정했어요.")} /> : null}
      {dialog?.kind === "detach" && detach ? <DetachDialog slug={w.slug} edition={w.edition} row={detach} opener={dialog.opener} onClose={() => setDialog(null)} onDone={done("참고 프로젝트를 뗐어요.")} /> : null}
    </main>
  );
}
