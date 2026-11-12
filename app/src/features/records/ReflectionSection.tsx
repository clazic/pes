import { useReflections } from "@/api/queries";
import type { ReflectionEntry, ReflectionView } from "@/api/types";
import { StatusMark, StatusText, TONE_TEXT } from "@/components/pes/status";
import { lookup } from "@/components/pes/status-registry";
import { cn } from "@/lib/utils";
import { countByWord, evidenceOf, FOLLOWUP_KIND, FOLLOWUP_STATE, reflectionCase, reflectionWord, SEG_ORDER } from "./logic";
import { ActorName, EmptyNote, ReadFailure, Skeleton, SourceLink, tableClass, TableScroll, tdClass, thClass } from "./parts";

const TRACK_TONE = { ok: "bg-ok", warn: "bg-warn", off: "bg-off", bad: "bg-bad", run: "bg-primary", you: "bg-primary", unk: "bg-ink-2" } as const;

/** 요약 막대 — 칸마다 낱말 + 개수가 글자로 있다(색만으로 알리지 않음). 증거 없는 줄은 적용 · 부분에 세지 않는다 */
function Bar({ entries }: { entries: ReflectionEntry[] }) {
  const counts = countByWord(entries);
  const segs = SEG_ORDER.filter((s) => counts[s.word] > 0);
  return (
    <div data-reflection-bar="" className="mt-3">
      <div aria-hidden="true" className="flex h-2 gap-px overflow-hidden rounded-full bg-meter-track">
        {segs.map((s) => (
          <div key={s.seg} style={{ flexGrow: counts[s.word] }} className={cn("min-w-1", TRACK_TONE[lookup("reflection", s.word).tone])} />
        ))}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {segs.map((s) => {
          const def = lookup("reflection", s.word);
          return (
            <li key={s.seg} data-seg={s.seg} className={cn("inline-flex items-center gap-1.5 text-meta font-medium", TONE_TEXT[def.tone])}>
              <StatusMark shape={def.shape} />
              <span>
                {def.label} <span className="tabular-nums">{counts[s.word]}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Evidence({ e }: { e: ReflectionEntry }) {
  const ev = evidenceOf(e);
  const f = e.followup;
  return (
    <div data-cell="evidence" className="space-y-1">
      {ev === "missing" ? <p className="text-bad">적용 기록이 모자라 성공으로 세지 않았어요.</p> : null}
      {e.applied_tx_id ? <p className="tabular-nums">처리 기록 {e.applied_tx_id}</p> : null}
      {e.result_version ? (
        <p>
          결과 버전: <SourceLink link={e.result_version} />
        </p>
      ) : null}
      {f ? (
        <p>
          {FOLLOWUP_KIND[f.kind]} · {FOLLOWUP_STATE[f.state]} — {f.label}
          {f.result_version ? (
            <>
              {" "}
              (<SourceLink link={f.result_version} />)
            </>
          ) : null}
        </p>
      ) : null}
      {ev !== "missing" && !e.applied_tx_id && !e.result_version && !f ? <p className="text-ink-2">—</p> : null}
    </div>
  );
}

function EntryLine({ e }: { e: ReflectionEntry }) {
  const ev = evidenceOf(e);
  return (
    <tr data-reflection={e.id} data-disposition={e.disposition} data-evidence={ev}>
      <td className={tdClass}>
        <p data-cell="opinion" className="text-ink">
          {e.opinion}
        </p>
        <p data-cell="source" className="mt-1 text-caption">
          {e.source ? <SourceLink link={e.source} /> : null}
        </p>
      </td>
      <td className={`${tdClass} whitespace-nowrap`}>
        <p data-cell="state">
          <StatusText of="reflection" value={reflectionWord(e)} />
        </p>
      </td>
      <td className={tdClass}>
        <p data-cell="rationale" className="text-ink">
          {e.rationale}
        </p>
      </td>
      <td className={tdClass}>
        <p data-cell="judge" className="text-ink">
          {e.actor ? <ActorName actor={e.actor} /> : <span className="text-ink-2">이름 없음</span>}
        </p>
      </td>
      <td className={tdClass}>
        <Evidence e={e} />
      </td>
    </tr>
  );
}

function Body({ view }: { view: ReflectionView | null }) {
  switch (reflectionCase(view)) {
    case "unavailable":
      return <EmptyNote>서버가 이 라운드의 반영 자료를 주지 않았어요. 이전된 프로젝트일 수 있어요.</EmptyNote>;
    case "not_submitted":
      return (
        <div className="mt-3">
          <p className="text-meta font-medium text-ink">미제출</p>
          <p className="mt-0.5 text-caption text-ink-2">지난 라운드에 보낸 반영 의견이 없어요.</p>
        </div>
      );
    case "none_processed":
      return (
        <div className="mt-3">
          <p className="text-meta font-medium text-ink">처리 0건</p>
          <p className="mt-0.5 text-caption text-ink-2">지난 라운드에 의견을 제출했지만 아직 처리된 줄이 없어요.</p>
        </div>
      );
    default: {
      const entries = view!.entries;
      const hasMissing = entries.some((e) => reflectionWord(e) === "missing");
      return (
        <>
          <p className="mt-0.5 text-caption text-ink-2">
            {entries.length}줄이 처리됐어요.
            {hasMissing ? " 적용 기록이 모자란 줄은 ‘적용’이나 ‘부분’으로 세지 않아요." : ""}
          </p>
          <Bar entries={entries} />
          <div className="mt-3">
            <TableScroll label="반영 내역">
              <table className={tableClass}>
                <caption className="sr-only">반영 내역 — 지난 의견 · 처리 · 근거 · 판단자 · 증거</caption>
                <thead>
                  <tr>
                    {["지난 의견", "처리", "근거", "판단자", "증거"].map((c) => (
                      <th key={c} scope="col" className={thClass}>
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e) => (
                    <EntryLine key={e.id} e={e} />
                  ))}
                </tbody>
              </table>
            </TableScroll>
          </div>
        </>
      );
    }
  }
}

/** 반영 내역 — 라운드 첫머리와 기록 화면이 같이 쓴다. round: 숫자 문자열 또는 "start" */
export function ReflectionSection({ slug, edition, stage, round, className }: { slug: string; edition: number; stage: string; round: string; className?: string }) {
  const q = useReflections(slug, edition, stage, round);
  return (
    <section aria-label="반영 내역" aria-busy={q.isPending || undefined} className={className}>
      <h2 className="text-title text-ink">
        반영 내역
      </h2>
      {q.isPending ? <Skeleton /> : q.isError ? <ReadFailure error={q.error} onRetry={() => void q.refetch()} /> : <Body view={q.data ?? null} />}
    </section>
  );
}
