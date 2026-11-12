import * as React from "react";
import { useParams } from "react-router";
import { useMaterials, useWorkspace } from "@/api/queries";
import type { MaterialRow } from "@/api/types";
import { useArrival } from "@/app/arrival";
import { NotFound } from "@/app/NotFound";
import { Button } from "@/components/ui/button";
import { readFailureText, Skeleton, TableScroll, tableClass, tdClass, thClass } from "@/features/records/parts";
import { cn } from "@/lib/utils";
import { AccessDialog, switchId, type AccessDone } from "./AccessDialog";
import { AiSwitch } from "./AiSwitch";
import { FilePicker } from "./FilePicker";
import { ACCESS_WORD, accessState, collapseSameFile, formatWord, sizeWord } from "./format";
import { DenyNotice } from "./notice";
import { PreviewPane } from "./PreviewPane";
import { useUploads, type UploadItem } from "./use-uploads";

/** 표 칸 — 서버가 안 주는 추출 상태는 지어내지 않는다(SEL-116 계약 뒤에 이 칸이 채워진다) */
const NO_EXTRACTION = "추출 상태 정보 없음";

function Line({ row, onToggle, onPreview, onNewVersion }: { row: MaterialRow; onToggle: (row: MaterialRow, opener: HTMLElement) => void; onPreview: (row: MaterialRow, opener: HTMLElement) => void; onNewVersion: (row: MaterialRow, files: File[]) => void }) {
  const state = accessState(row.ai_access);
  return (
    <tr data-material={row.object_id} data-ai-access={state}>
      <td data-cell="name" className={tdClass}>
        <p className="text-body font-medium break-words text-ink">{row.title}</p>
        <p className="text-caption break-all text-ink-2">{row.original_name}</p>
      </td>
      <td data-cell="format" className={`${tdClass} whitespace-nowrap`}>
        {formatWord(row)}
      </td>
      <td data-cell="size" className={`${tdClass} whitespace-nowrap tabular-nums`}>
        {sizeWord(row.size)}
      </td>
      <td data-cell="version" className={`${tdClass} whitespace-nowrap tabular-nums`}>
        v{row.version}
      </td>
      <td data-cell="extraction" className={`${tdClass} text-ink-2`}>
        {NO_EXTRACTION}
      </td>
      <td data-cell="ai-access" className={tdClass}>
        {row.ai_access === null ? (
          <span className="text-ink-2">AI 참조 상태 정보 없음</span>
        ) : (
          <span className="flex items-center gap-2">
            <AiSwitch id={switchId(row.object_id)} on={row.ai_access === "allow"} label={`AI 참조: ${row.title}`} onClick={(e) => onToggle(row, e.currentTarget)} />
            <span className={cn("whitespace-nowrap", state === "deny" ? "font-medium text-ink" : "text-ink-2")}>{ACCESS_WORD[row.ai_access]}</span>
          </span>
        )}
      </td>
      <td data-cell="actions" className={tdClass}>
        <div data-print="hide" className="relative flex flex-wrap items-center gap-1.5">
          <Button variant="outline" size="sm" onClick={(e) => onPreview(row, e.currentTarget)}>
            미리보기<span className="sr-only">: {row.title}</span>
          </Button>
          <FilePicker
            compact
            multiple={false}
            label={
              <span>
                새 버전 올리기<span className="sr-only">: {row.title}</span>
              </span>
            }
            onPick={(files) => onNewVersion(row, files)}
          />
        </div>
      </td>
    </tr>
  );
}

/** 읽기 실패 — 빈 목록으로 위장하지 않는다(role=alert). 다시 읽기 단추가 있다 */
function LoadError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <p role="alert" className="text-meta font-medium text-bad">
        내 자료 목록을 {readFailureText(error)}
      </p>
      <div data-print="hide">
        <Button variant="outline" size="sm" onClick={onRetry}>
          다시 읽기
        </Button>
      </div>
    </div>
  );
}

function UploadLines({ items }: { items: UploadItem[] }) {
  const rejected = items.filter((x): x is Extract<UploadItem, { phase: "rejected" }> => x.phase === "rejected");
  const done = items.filter((x): x is Extract<UploadItem, { phase: "done" }> => x.phase === "done");
  const sending = items.filter((x) => x.phase === "sending").length;
  const unknown = items.filter((x) => x.phase === "unknown").length;
  return (
    <>
      <div role="status" className="text-meta text-ink">
        {/* 영수증 전에는 성공 말도 파일 이름도 보이지 않는다 — 보내기 전·보내는 중은 올리는 중, 처리 여부를 모를 때만 접수 확인 중 */}
        {sending ? <p className="mt-1">올리는 중 — 파일 {sending}개를 서버에 보내고 있어요.</p> : null}
        {unknown ? <p className="mt-1">접수 확인 중 — 파일 {unknown}개: 답이 오지 않았어요. 실패한 것이 아닐 수 있어요. 같은 파일을 다시 고르면 중복 없이 확인해요.</p> : null}
        {done.map((x) => (
          <p key={x.id} className="mt-1">
            {x.numbered ? `접수 ${x.receiptNo}` : "접수됨"} · {x.name}을(를) 올렸어요.{x.replayed ? " (이미 처리된 요청이라 처음 접수를 다시 보여요.)" : ""}
          </p>
        ))}
      </div>
      {rejected.length ? (
        <div role="alert" className="mt-1 text-meta font-medium text-bad">
          {rejected.map((x) => (
            <p key={x.id}>
              올리지 못했어요 — {x.name}: {x.message}
            </p>
          ))}
        </div>
      ) : null}
    </>
  );
}

/**
 * 내 자료 화면(MAT1c) — `/p/:slug/e/:edition/files`. 작업 중 자료 목록 · 올리기 · 파일별 AI 참조 스위치 · 미리보기.
 * 사람 화면이라 AI 참조를 금지한 파일도 목록에 보인다. 서버가 안 주는 값(추출 상태 · 스위치 상태)은 지어내지 않고 “정보 없음”으로 둔다.
 * 쓰기(올리기 · 스위치)는 영수증을 받은 뒤에만 성공을 말하고, 그 뒤 목록을 다시 읽는다.
 */
export function MaterialsScreen() {
  const params = useParams();
  const slug = params.slug ?? "";
  const edition = /^[1-9]\d*$/.test(params.edition ?? "") ? Number(params.edition) : 0;
  const ws = useWorkspace(slug, edition);
  const w = ws.data;
  useArrival(!!w);
  const list = useMaterials(slug, edition);
  const uploads = useUploads(slug, edition);

  const [access, setAccess] = React.useState<{ row: MaterialRow } | null>(null);
  const [preview, setPreview] = React.useState<{ row: MaterialRow; opener: HTMLElement } | null>(null);
  const [notice, setNotice] = React.useState("");

  React.useEffect(() => {
    if (w) document.title = `내 자료 · ${w.title} · PES`;
  }, [w]);

  const onAccessDone = React.useCallback((d: AccessDone) => {
    const { row, result } = d;
    // 화면 말은 서버가 준 값만 쓴다 — 값이 없으면 요청한 값으로 지어내지 않고 “정보 없음”
    const served = result.data.ai_access;
    const servedWord = served ? ACCESS_WORD[served] : "정보 없음";
    setNotice(
      result.data.changed
        ? `${result.receipt.numbered === false ? "접수됨" : `접수 ${result.receipt.receipt_no}`} · ‘${row.title}’의 AI 참조: ${served ? `${servedWord}(으)로 기록했어요.` : "바뀐 값은 서버가 알려 주지 않았어요(정보 없음)."}${result.receipt.replayed ? " (이미 처리된 요청이라 처음 접수를 다시 보여요.)" : ""}`
        : `바뀐 것 없음 — ‘${row.title}’은(는) 서버에 이미 ${servedWord} 상태로 있어요.`,
    );
    setAccess(null);
  }, []);

  if (ws.isPending) {
    return (
      <main id="main" tabIndex={-1} aria-busy="true" className="min-w-0">
        <p className="px-4 pt-5 pb-3 text-meta text-muted-foreground tab:px-6">불러오는 중</p>
      </main>
    );
  }
  if (!w) return <NotFound />;

  const rows = collapseSameFile(list.data ?? []);
  return (
    <main id="main" tabIndex={-1} className="min-w-0">
      <div className="border-b px-4 pt-4 pb-3 tab:px-6">
        <h1 data-screen-title="" tabIndex={-1} className="text-page text-ink">
          내 자료
        </h1>
        <p className="mt-1 text-meta text-muted-foreground">
          {w.title} · {w.edition}판 · 올린 자료와, 파일마다 AI 가 참조해도 되는지를 정해요.
        </p>
      </div>
      <div className="w-full max-w-5xl px-4 pt-5 pb-16 tab:px-6">
        <div data-print="hide">
          <FilePicker label="자료 파일 고르기" onPick={(files) => uploads.start(files)} hint="파일을 여기에 끌어 놓아도 돼요. 파일마다 따로 접수하고, 접수 번호를 받은 뒤에 목록에 나타나요." />
        </div>
        <div className="mt-2 min-h-5">
          <UploadLines items={uploads.items} />
          <p role="status" className="mt-1 text-meta font-medium text-ink">
            {notice}
          </p>
        </div>

        <DenyNotice className="mt-4" />

        <section aria-label="내 자료 목록" className="mt-5" aria-busy={list.isPending || undefined}>
          {list.isPending ? (
            <>
              <p className="text-meta text-muted-foreground">불러오는 중</p>
              <Skeleton />
            </>
          ) : list.isError && !list.data ? (
            <LoadError error={list.error} onRetry={() => void list.refetch()} />
          ) : rows.length === 0 ? (
            <div className="rounded-md border border-dashed border-control bg-surface px-3 py-4">
              <p className="text-meta font-medium text-ink">올린 자료가 없습니다</p>
              <p className="mt-0.5 text-caption text-ink-2">위에서 파일을 골라 올리면 이 목록에 나타나요.</p>
            </div>
          ) : (
            <>
              {list.isError ? <LoadError error={list.error} onRetry={() => void list.refetch()} /> : null}
              <p className="mb-2 text-caption text-ink-2">자료 {rows.length}개 · AI 참조 허용 {rows.filter((r) => r.ai_access === "allow").length}개 · 금지 {rows.filter((r) => r.ai_access === "deny").length}개</p>
              <TableScroll label="내 자료">
                <table className={cn(tableClass, "min-w-[56rem]")}>
                  <caption className="sr-only">내 자료</caption>
                  <thead>
                    <tr>
                      {["자료", "형식", "크기", "버전", "글자 뽑기", "AI 참조", "동작"].map((h) => (
                        <th key={h} scope="col" className={thClass}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <Line
                        key={row.object_id}
                        row={row}
                        onToggle={(r) => setAccess({ row: r })}
                        onPreview={(r, opener) => setPreview({ row: r, opener })}
                        onNewVersion={(r, files) => uploads.start(files, r.object_id)}
                      />
                    ))}
                  </tbody>
                </table>
              </TableScroll>
            </>
          )}
        </section>

        {preview ? (
          <PreviewPane
            key={preview.row.blob_id}
            row={preview.row}
            slug={slug}
            edition={edition}
            onClose={() => {
              const opener = preview.opener;
              setPreview(null);
              opener.focus();
            }}
          />
        ) : null}
      </div>
      {access ? <AccessDialog row={access.row} slug={slug} edition={edition} onClose={() => setAccess(null)} onDone={onAccessDone} /> : null}
    </main>
  );
}
