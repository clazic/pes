import { Link, useParams } from "react-router";
import { ArrowLeftIcon, DownloadIcon, PrinterIcon } from "lucide-react";
import { STAGE_LABEL, STAGES, type StageKey } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/pes/blocks";
import { Chip } from "@/components/pes/status";
import { useWs } from "@/features/workspace/WorkspaceLayout";
import { STAGE_REPORTS, type ReportBlock } from "@/mocks/stage-reports";

function Block({ b }: { b: ReportBlock }) {
  if (b.kind === "p") return <p className="text-body leading-relaxed">{b.text}</p>;
  if (b.kind === "note") return <p className="rounded-lg border border-line bg-surface-soft px-3 py-2 text-meta text-ink-2">{b.text}</p>;
  if (b.kind === "kv")
    return (
      <dl className="space-y-2.5 text-body">
        {b.items.map(([k, v]) => (
          <div key={k} className="sm:flex sm:gap-4">
            <dt className="shrink-0 font-medium text-ink-2 sm:w-32">{k}</dt>
            <dd className="leading-relaxed">{v}</dd>
          </div>
        ))}
      </dl>
    );
  if (b.kind === "list")
    return (
      <ul className="list-disc space-y-1.5 pl-5 text-body leading-relaxed">
        {b.items.map((i) => (
          <li key={i}>{i}</li>
        ))}
      </ul>
    );
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-meta">
        <thead>
          <tr>
            {b.head.map((h) => (
              <th key={h} scope="col" className="border-b border-line px-2 py-1.5 text-left text-caption font-medium text-muted-foreground">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {b.rows.map((r) => (
            <tr key={r.join("|")}>
              {r.map((c, i) => (
                <td key={`${i}-${c}`} className={i === 0 ? "border-b border-line p-2 align-top font-medium whitespace-nowrap" : "border-b border-line p-2 align-top"}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 단계 보고서 읽기 화면(설계 19절). 읽기 폭 46rem, 왼쪽 위 차례, 인쇄 · 내려받기. 승인 때 고정본 / 진행 중 초안. */
export function StageReportPage() {
  const { ws } = useWs();
  const { stage = "" } = useParams();
  const key = (STAGES as readonly string[]).includes(stage) ? (stage as StageKey) : undefined;
  const rep = key ? STAGE_REPORTS[ws.slug]?.[key] : undefined;
  const back = `/p/${ws.slug}/s/${stage}`;

  if (!key || !rep)
    return (
      <div className="mt-5">
        <EmptyState title="아직 보고서가 없습니다" body={key ? `${STAGE_LABEL[key]} 단계를 승인하면 단계 보고서가 생깁니다.` : "없는 단계입니다."} />
        <Button asChild variant="link">
          <Link to={back}>단계 결과로 돌아가기</Link>
        </Button>
      </div>
    );

  return (
    <div className="mt-5">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button asChild variant="ghost" size="sm">
          <Link to={back}>
            <ArrowLeftIcon aria-hidden="true" />
            {STAGE_LABEL[key]} 단계 결과
          </Link>
        </Button>
        <span className="flex-1" />
        <Button size="sm" variant="outline" onClick={() => window.print()}>
          <PrinterIcon aria-hidden="true" />
          인쇄
        </Button>
        <Button size="sm" variant="outline">
          <DownloadIcon aria-hidden="true" />
          내려받기
        </Button>
        <Button size="sm" variant="ghost">
          쉬운 설명 보기
        </Button>
      </div>
      <Card aria-labelledby="rep-h">
        <article className="mx-auto w-full max-w-3xl">
          <p className="text-caption text-muted-foreground">
            {ws.title} · {rep.version}
          </p>
          <h1 id="rep-h" className="mt-1 text-page font-semibold">
            {rep.name}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {rep.state === "fixed" ? (
              <Chip shape="circle" tone="ok">
                고정본
              </Chip>
            ) : (
              <Chip shape="tri" tone="warn">
                초안 · 승인 전
              </Chip>
            )}
            <span className="text-meta text-ink-2">{rep.stamp}</span>
          </div>

          {rep.meta ? (
            <dl className="mt-4 grid gap-x-4 gap-y-1.5 border-y border-line py-3 text-meta sm:grid-cols-2">
              {rep.meta.map(([k, v]) => (
                <div key={k} className="flex gap-3">
                  <dt className="w-20 shrink-0 text-muted-foreground">{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          ) : null}

          <section aria-labelledby="rep-sum" className="mt-5 rounded-xl bg-surface-soft p-4">
            <h2 id="rep-sum" className="text-title font-semibold">
              요약
            </h2>
            <p className="mt-1.5 text-body leading-relaxed">{rep.summary}</p>
            {rep.highlights ? (
              <ul className="mt-3 space-y-1.5 border-t border-line pt-3 text-body leading-relaxed">
                {rep.highlights.map((h) => (
                  <li key={h} className="flex gap-2">
                    <span aria-hidden="true" className="mt-2.5 size-1.5 shrink-0 rounded-full bg-primary" />
                    {h}
                  </li>
                ))}
              </ul>
            ) : null}
          </section>

          <nav aria-label="보고서 차례" className="mt-4">
            <ol className="flex flex-wrap gap-x-4 gap-y-1 text-meta">
              {rep.sections.map((s) => (
                <li key={s.id}>
                  <a href={`#${s.id}`}>{s.title}</a>
                </li>
              ))}
            </ol>
          </nav>

          {rep.sections.map((s) => (
            <section key={s.id} id={s.id} aria-labelledby={`${s.id}-h`} className="mt-6 scroll-mt-20 border-t border-line pt-4">
              <h2 id={`${s.id}-h`} className="mb-2.5 text-title font-semibold">
                {s.title}
              </h2>
              <div className="space-y-3">
                {s.blocks.map((b, i) => (
                  <Block key={`${s.id}-${i}`} b={b} />
                ))}
              </div>
            </section>
          ))}
        </article>
      </Card>
    </div>
  );
}
