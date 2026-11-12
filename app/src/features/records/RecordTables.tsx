import * as React from "react";
import { Link } from "react-router";
import { useAssumptions, useDecisions } from "@/api/queries";
import type { AssumptionRow, DecisionRow } from "@/api/types";
import { StatusText } from "@/components/pes/status";
import { Button } from "@/components/ui/button";
import { actionOf, type JudgeSpec } from "./JudgeDialog";
import { assumptionNeedsJudging, assumptionWords, decisionWord, SCOPE_LABEL } from "./logic";
import { ActorName, EmptyNote, noteClass, ReadFailure, Skeleton, SourceLink, tableClass, TableScroll, tdClass, thClass, When } from "./parts";

export type OnJudge = (spec: JudgeSpec, opener: HTMLElement) => void;

function Judge({ describedBy, buttons, onJudge }: { describedBy: string; buttons: { label: string; spec: JudgeSpec }[]; onJudge: OnJudge }) {
  return (
    <div data-print="hide" role="group" aria-label="판단" className="mt-2.5 flex flex-wrap gap-1.5">
      {buttons.map((b) => (
        <Button key={actionOf(b.spec)} variant="outline" size="sm" aria-describedby={describedBy} onClick={(e) => onJudge(b.spec, e.currentTarget)}>
          {b.label}
        </Button>
      ))}
    </div>
  );
}

function AssumptionLine({ row, onJudge }: { row: AssumptionRow; onJudge: OnJudge }) {
  const { main, review } = assumptionWords(row);
  const sid = `as-${row.object_id}-st`;
  const human = row.assessed_by;
  return (
    <tr className="scroll-mt-24" id={`assumption-${row.object_id}`} data-assumption={row.object_id} data-state={row.state} data-needs-review={row.needs_review ? "true" : "false"}>
      <td className={tdClass}>
        <p id={sid} data-cell="statement" className="text-body text-ink">
          {row.statement}
        </p>
        <div data-cell="original" className="text-caption text-ink-2">
          {row.original ? (
            <p className="mt-1">
              고치기 전 원문: <span className="text-ink">{row.original.statement}</span>
            </p>
          ) : null}
        </div>
        <div data-cell="copied-from" className={noteClass}>
          {row.copied_from ? (
            <p className="mt-1">
              {row.copied_from.label} · {row.copied_from.edition}판
            </p>
          ) : null}
        </div>
        {assumptionNeedsJudging(row) ? (
          <Judge
            describedBy={sid}
            onJudge={onJudge}
            buttons={[
              { label: "확인", spec: { kind: "assess", verdict: "confirm", row } },
              { label: "틀림", spec: { kind: "assess", verdict: "reject", row } },
              { label: "고침", spec: { kind: "assess", verdict: "revise", row } },
            ]}
          />
        ) : null}
      </td>
      <td className={`${tdClass} whitespace-nowrap`}>
        <div data-cell="state" className="space-y-1">
          <p>
            <StatusText of="assumption" value={main} />
          </p>
          {review ? (
            <p>
              <StatusText of="assumption" value="review" />
            </p>
          ) : null}
        </div>
        <p data-cell="proposer" className={`mt-1 ${noteClass}`}>
          {row.proposed_by.kind === "ai" ? "AI 제안" : "사람 제안"} · {row.proposed_by.name}
        </p>
      </td>
      <td className={tdClass}>
        <div data-cell="judge">
          {human ? (
            <>
              <p className="text-ink">
                <ActorName actor={human} />
              </p>
              <When at={row.assessed_at} />
            </>
          ) : (
            <p className="text-ink-2">{row.state === "proposed" ? "아직 없음" : "이름 없음"}</p>
          )}
        </div>
      </td>
      <td className={`${tdClass} tabular-nums`}>
        <span data-cell="version">v{row.version}</span>
      </td>
      <td className={tdClass}>
        <p data-cell="rationale" className="text-ink">
          {row.rationale}
        </p>
        <p data-cell="source" className="mt-1">
          {row.source ? <SourceLink link={row.source} /> : <span className="text-ink-2">근거 없음</span>}
        </p>
      </td>
    </tr>
  );
}

function DecisionLine({ row, all, onJudge }: { row: DecisionRow; all: DecisionRow[]; onJudge: OnJudge }) {
  const word = decisionWord(row);
  const sid = `dc-${row.object_id}-st`;
  const successor = row.superseded_by ? all.find((x) => x.object_id === row.superseded_by) : undefined;
  const buttons: { label: string; spec: JudgeSpec }[] =
    row.state === "proposed"
      ? [{ label: "채택", spec: { kind: "adopt", row } }]
      : row.state === "adopted"
        ? [
            { label: "대체", spec: { kind: "supersede", row } },
            { label: "철회", spec: { kind: "revoke", row } },
          ]
        : [];
  return (
    <tr className="scroll-mt-24" id={`decision-${row.object_id}`} data-decision={row.object_id} data-state={row.state} data-scope={row.scope}>
      <td className={tdClass}>
        <p id={sid} data-cell="statement" className="text-body text-ink">
          {row.statement}
        </p>
        <div data-cell="supersedes" className={noteClass}>
          {row.supersedes ? (
            <p className="mt-1">
              대체한 옛 결정:{" "}
              <Link to={{ hash: `#decision-${row.supersedes.object_id}` }} className="text-primary-ink underline underline-offset-2">
                {row.supersedes.statement || row.supersedes.object_id}
              </Link>
            </p>
          ) : null}
        </div>
        <div data-cell="superseded-by" className={noteClass}>
          {row.superseded_by ? (
            <p className="mt-1">
              이어받은 새 결정:{" "}
              <Link to={{ hash: `#decision-${row.superseded_by}` }} className="text-primary-ink underline underline-offset-2">
                {successor?.statement ?? row.superseded_by}
              </Link>
            </p>
          ) : null}
        </div>
        {buttons.length ? <Judge describedBy={sid} onJudge={onJudge} buttons={buttons} /> : null}
      </td>
      <td className={`${tdClass} whitespace-nowrap`}>
        <p data-cell="state">
          <StatusText of="decision" value={word} />
        </p>
        <p data-cell="proposer" className={`mt-1 ${noteClass}`}>
          {row.proposed_by.kind === "ai" ? "AI 제안" : "사람 제안"} · {row.proposed_by.name}
        </p>
      </td>
      <td className={tdClass}>
        <p data-cell="scope" className="text-ink">
          {SCOPE_LABEL[row.scope]}
          {row.originated_from ? <span className={`block ${noteClass}`}>{row.originated_from.label} · 당시 버전 {row.originated_from.version}</span> : null}
        </p>
      </td>
      <td className={tdClass}>
        <div data-cell="judge">
          {row.decided_by ? (
            <p className="text-ink">
              <ActorName actor={row.decided_by} />
            </p>
          ) : (
            <p className="text-ink-2">{row.state === "proposed" ? "아직 없음" : "이름 없음"}</p>
          )}
        </div>
      </td>
      <td className={`${tdClass} tabular-nums`}>
        <span data-cell="version">v{row.version}</span>
      </td>
      <td className={tdClass}>
        <p data-cell="rationale" className="text-ink">
          {row.rationale}
        </p>
        <p data-cell="source" className="mt-1">
          {row.source ? <SourceLink link={row.source} /> : <span className="text-ink-2">근거 없음</span>}
        </p>
      </td>
    </tr>
  );
}

const Head = ({ cols }: { cols: string[] }) => (
  <thead>
    <tr>
      {cols.map((c) => (
        <th key={c} scope="col" className={thClass}>
          {c}
        </th>
      ))}
    </tr>
  </thead>
);

/** 영역 하나: 제목(영역 이름) · 읽는 중/실패/기록 없음/표 */
function Section({ id, title, aboutRows, busy, children }: { id: string; title: string; aboutRows?: string; busy: boolean; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} aria-busy={busy || undefined} className="mt-8 first:mt-0">
      <h2 id={id} className="text-title text-ink">
        {title}
      </h2>
      {aboutRows ? <p className="mt-0.5 text-caption text-ink-2">{aboutRows}</p> : null}
      {children}
    </section>
  );
}

export function AssumptionsSection({ slug, edition, onJudge }: { slug: string; edition: number; onJudge: OnJudge }) {
  const q = useAssumptions(slug, edition);
  const rows = q.data;
  return (
    <Section id="records-assumptions" title="가정" busy={q.isPending} aboutRows={rows && rows.length ? "AI가 낸 가정은 사람이 판단하기 전까지 ‘판단 전’이에요. 확인은 사람 판단이 있을 때만 쓰입니다." : undefined}>
      {q.isPending ? (
        <Skeleton />
      ) : q.isError ? (
        <ReadFailure error={q.error} onRetry={() => void q.refetch()} />
      ) : rows && rows.length ? (
        <div className="mt-3">
          <TableScroll label="가정">
            <table className={tableClass}>
              <caption className="sr-only">가정 — 내용 · 상태 · 판단자 · 버전 · 근거</caption>
              <Head cols={["가정", "상태", "판단자", "버전", "근거"]} />
              <tbody>
                {rows.map((r) => (
                  <AssumptionLine key={r.object_id} row={r} onJudge={onJudge} />
                ))}
              </tbody>
            </table>
          </TableScroll>
        </div>
      ) : (
        <EmptyNote>이 판에 남은 가정이 없어요.</EmptyNote>
      )}
    </Section>
  );
}

export function DecisionsSection({ slug, edition, onJudge }: { slug: string; edition: number; onJudge: OnJudge }) {
  const q = useDecisions(slug, edition);
  const rows = q.data;
  return (
    <Section id="records-decisions" title="결정" busy={q.isPending} aboutRows={rows && rows.length ? "대체해도 옛 결정은 지워지지 않고, 새 결정과 서로 이어져요." : undefined}>
      {q.isPending ? (
        <Skeleton />
      ) : q.isError ? (
        <ReadFailure error={q.error} onRetry={() => void q.refetch()} />
      ) : rows && rows.length ? (
        <div className="mt-3">
          <TableScroll label="결정">
            <table className={tableClass}>
              <caption className="sr-only">결정 — 내용 · 상태 · 범위 · 결정자 · 버전 · 근거</caption>
              <Head cols={["결정", "상태", "범위", "결정자", "버전", "근거"]} />
              <tbody>
                {rows.map((r) => (
                  <DecisionLine key={r.object_id} row={r} all={rows} onJudge={onJudge} />
                ))}
              </tbody>
            </table>
          </TableScroll>
        </div>
      ) : (
        <EmptyNote>이 판에 남은 결정이 없어요.</EmptyNote>
      )}
    </Section>
  );
}
