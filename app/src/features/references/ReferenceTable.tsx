import * as React from "react";
import type { ReferenceRow } from "@/api/types";
import { StatusText } from "@/components/pes/status";
import { Button } from "@/components/ui/button";
import { noteClass, tableClass, TableScroll, tdClass, thClass, When } from "@/features/records/parts";
import { aiDeliveryOf, hasLiveSource, nameOf, scopeWords } from "./logic";

export type RowAction = "view" | "refresh" | "detach";
export type OnRowAction = (action: RowAction, row: ReferenceRow, opener: HTMLElement) => void;

/** 고정한 버전이 저절로 바뀌지 않는다는 고지 — 새 버전 있음(state === new_version)일 때만 */
function NewVersionNote() {
  return <p className={`mt-1 ${noteClass}`}>고정한 버전은 그대로이고 저절로 바뀌지 않아요. 바꾸려면 사람이 다시 고정해요.</p>;
}

function Line({ row, onAction }: { row: ReferenceRow; onAction: OnRowAction }) {
  const denied = row.access === "no_permission";
  const name = nameOf(row);
  const ai = aiDeliveryOf(row);
  const live = hasLiveSource(row);
  const act = (a: RowAction) => (e: React.MouseEvent<HTMLButtonElement>) => onAction(a, row, e.currentTarget);
  return (
    <tr className="scroll-mt-24" data-reference={row.id} data-state={row.state} data-ai-delivery={ai.key}>
      <td className={tdClass}>
        <div data-cell="name">
          <p className="text-body font-medium break-words text-ink">{name}</p>
          {denied ? <p className={`mt-0.5 ${noteClass}`}>내용 비공개</p> : row.referenced_project_key ? <p className={`mt-0.5 break-all ${noteClass}`}>{row.referenced_project_key}</p> : null}
        </div>
      </td>
      <td className={tdClass}>
        <div data-cell="version">
          {denied ? (
            <p className="text-ink-2">비공개</p>
          ) : (
            <>
              <p className="text-ink">{row.source_snapshot_key ?? "버전 정보 없음"}</p>
              <p className={`mt-0.5 ${noteClass}`}>{scopeWords(row.scope)}</p>
              {row.attached_at ? (
                <p className="mt-0.5">
                  <span className={noteClass}>붙인 때 </span>
                  <When at={row.attached_at} />
                </p>
              ) : null}
            </>
          )}
        </div>
      </td>
      <td className={tdClass}>
        <div data-cell="state">
          <p className="whitespace-nowrap">
            <StatusText of="reference" value={row.state} />
          </p>
          {row.state === "new_version" ? <NewVersionNote /> : null}
        </div>
      </td>
      <td className={tdClass}>
        <div data-cell="ai-delivery">
          <p className="whitespace-nowrap">
            <StatusText of="reference_ai" value={ai.key} />
          </p>
          {ai.reason ? <p className={`mt-0.5 ${noteClass}`}>{ai.reason}</p> : null}
        </div>
      </td>
      <td className={tdClass}>
        <div data-cell="actions" data-print="hide" role="group" aria-label={`${name} 동작`} className="flex flex-wrap gap-1.5">
          {live ? (
            <Button variant="outline" size="sm" aria-label={`내용 보기: ${name}`} onClick={act("view")}>
              내용 보기
            </Button>
          ) : null}
          {live ? (
            <Button variant="outline" size="sm" aria-label={`다시 고정: ${name}`} onClick={act("refresh")}>
              다시 고정
            </Button>
          ) : null}
          <Button variant="outline" size="sm" aria-label={`떼기: ${name}`} onClick={act("detach")}>
            떼기
          </Button>
        </div>
      </td>
    </tr>
  );
}

/** 참고 프로젝트 표 하나 — caption 이 표 이름. 모든 칸에 낱말이 있어 색만으로 알리지 않는다 */
export function ReferenceTable({ rows, onAction }: { rows: ReferenceRow[]; onAction: OnRowAction }) {
  return (
    <TableScroll label="참고 프로젝트">
      <table className={tableClass}>
        <caption className="sr-only">참고 프로젝트</caption>
        <thead>
          <tr>
            {["참고 프로젝트", "고정한 버전", "상태", "AI 전달", "동작"].map((c) => (
              <th key={c} scope="col" className={thClass}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <Line key={r.id} row={r} onAction={onAction} />
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}
