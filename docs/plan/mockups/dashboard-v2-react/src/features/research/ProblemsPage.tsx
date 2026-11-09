import * as React from "react";
import { Link, useLocation } from "react-router";
import { ChevronDownIcon } from "lucide-react";
import { PROBLEM_GROUP, type ProblemView, type WorkspaceView } from "@/api/types";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Anno, SectionTitle } from "@/components/pes/bits";
import { EmptyState, StatBar } from "@/components/pes/blocks";
import { FoldCard, InfoTip } from "@/components/pes/disclosure";
import { Status } from "@/components/pes/status";
import { lookup } from "@/components/pes/status-registry";
import { useWs } from "@/features/workspace/WorkspaceLayout";
import { cn } from "@/lib/utils";
import { ResolveFlow } from "./ResolveFlow";

type Filter = "all" | "content" | "progress";

/** 막힌 것 카드 하나 — 원인 한 줄 · 관련 위치 · 추천. “풀기”를 누르면 그 자리에서 해결 흐름이 펼쳐진다. */
export function ProblemCard({ ws, p, open, onOpenChange, onResolved, lead }: { ws: WorkspaceView; p: ProblemView; open: boolean; onOpenChange: (o: boolean) => void; onResolved: (p: ProblemView) => void; lead?: boolean }) {
  const rec = p.options.find((o) => o.recommended);
  const titleId = `pb-${p.id}-t`;
  const tone = lookup("problem", p.kind).tone;
  return (
    <article id={`pb-${p.id}`} aria-labelledby={titleId} className={cn("rounded-xl border bg-card px-4 py-3.5 shadow-xs", p.state !== "open" ? "border-line" : tone === "bad" ? "border-bad-line" : "border-warn-line")}>
      <Collapsible open={open} onOpenChange={onOpenChange}>
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <Status of="problem" value={p.kind} />
              {p.state !== "open" ? <Status of="problemState" value={p.state} /> : null}
              <span className="text-xs text-muted-foreground">{PROBLEM_GROUP[p.kind] === "content" ? "연구 내용" : "진행"}</span>
            </div>
            <h3 id={titleId} className="text-meta">
              {p.title}
            </h3>
            {!open ? (
              <>
                <p className="text-meta text-ink-2">
                  <span className="mr-1 font-semibold text-ink">원인</span>
                  {p.cause}
                </p>
                <p className="text-caption text-muted-foreground">
                  관련: <Link to={p.where.href}>{p.where.label}</Link>
                  {p.state === "open" && rec ? ` · 추천: ${rec.label}` : p.note ? ` · ${p.note}` : ""}
                </p>
              </>
            ) : null}
          </div>
          <CollapsibleTrigger
            data-jk=""
            aria-label={`${p.title} — ${open ? "해결 흐름 접기" : p.state === "open" ? "풀기" : "자세히"}`}
            className={cn(
              "inline-flex h-8 shrink-0 items-center gap-1 rounded-lg border px-3 text-meta font-medium coarse:min-h-[44px]",
              // 줄마다 채운 단추면 파란 벽이 된다 — 맨 앞 하나만 채움(4차 목록 규칙과 같음)
              p.state === "open" && !open && lead ? "border-primary bg-primary text-primary-foreground hover:bg-primary/90" : "border-border bg-background hover:bg-accent",
            )}
          >
            {open ? "접기" : p.state === "open" ? "풀기" : "자세히"}
            <ChevronDownIcon aria-hidden="true" className={cn("size-3.5 transition-transform", open && "rotate-180")} />
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent className="mt-2.5 border-t border-line pt-3">
          <ResolveFlow ws={ws} p={p} showTitle={false} onResolved={() => onResolved(p)} />
        </CollapsibleContent>
      </Collapsible>
    </article>
  );
}

function Section({ sid, title, sub, items, ws, openId, setOpenId, onResolved, empty }: { sid: string; title: string; sub?: string; items: ProblemView[]; ws: WorkspaceView; openId: string | null; setOpenId: (id: string | null) => void; onResolved: (p: ProblemView) => void; empty?: string }) {
  if (!items.length && !empty) return null;
  const id = `pbs-${sid}`;
  return (
    <section aria-labelledby={id} className="mt-5">
      <h3 id={id} className="flex flex-wrap items-baseline gap-x-2 text-sm">
        {title} <span className="font-normal text-muted-foreground tabular-nums">{items.length}</span>
        {sub ? <span className="text-caption font-normal text-muted-foreground">{sub}</span> : null}
      </h3>
      {items.length ? (
        <div className="mt-2 space-y-2.5">
          {items.map((p, i) => (
            <ProblemCard key={p.id} ws={ws} p={p} lead={i === 0} open={openId === p.id} onOpenChange={(o) => setOpenId(o ? p.id : null)} onResolved={onResolved} />
          ))}
        </div>
      ) : (
        <p className="mt-1.5 text-meta text-muted-foreground">{empty}</p>
      )}
    </section>
  );
}

/**
 * 막힌 것·풀 것 보드(설계 16.4) — 연구를 막는 것을 한곳에. 연구 내용(근거 부족 · 자료 어긋남 · 검증 실패)과
 * 진행(필수 질문 미응답 · AI 실행 멈춤 · 동기화 충돌 · 글자 뽑기 실패)을 같은 흐름(원인 → 선택지 → 한 번에 처리)으로 푼다.
 * 풀린 것은 사라지고 해결 기록(지우지 않음)에 남는다. 관리 지표(사용량·연결)는 문제가 될 때만 여기에 올라온다.
 */
export function ProblemsPage() {
  const { ws } = useWs();
  const { hash } = useLocation();
  const [filter, setFilter] = React.useState<Filter>("all");
  const fromHash = hash.startsWith("#pb-") ? decodeURIComponent(hash.slice(4)) : null;
  const [openId, setOpenId] = React.useState<string | null>(fromHash);
  React.useEffect(() => {
    if (fromHash) setOpenId(fromHash);
  }, [fromHash]);

  const shown = ws.problems.filter((p) => filter === "all" || PROBLEM_GROUP[p.kind] === filter);
  const mine = shown.filter((p) => p.state === "open");
  const ai = shown.filter((p) => p.state === "ai");
  const waiting = shown.filter((p) => p.state === "waiting");
  const count = (g: Filter) => ws.problems.filter((p) => g === "all" || PROBLEM_GROUP[p.kind] === g).length;

  // 풀고 나면 그 카드는 사라진다 — 초점을 다음 카드의 단추(없으면 제목)로 옮겨 키보드 위치를 잃지 않게
  const onResolved = (p: ProblemView) => {
    const list = ws.problems.filter((x) => x.state === "open");
    const i = list.findIndex((x) => x.id === p.id);
    const next = list[i + 1] ?? list[i - 1];
    setOpenId(null);
    window.setTimeout(() => {
      const el = (next && document.querySelector<HTMLElement>(`#pb-${CSS.escape(next.id)} [data-jk]`)) || document.getElementById("pb-title");
      el?.focus();
    }, 450);
  };

  return (
    <div className="mt-5">
      <SectionTitle
        title={<span id="pb-title" tabIndex={-1} className="outline-none">막힌 것·풀 것</span>}
        sub="연구를 막는 것을 한곳에 — 원인 한 줄 → 선택지(추천 표시) → 한 번에 처리"
        className="mt-0"
        aside={
          <InfoTip label="막힌 것·풀 것 설명" wide>
            <p>AI 점검 · 출처 대조 · 사람 첨언 · 질문 폼 · 실행 · 동기화 · 자료 표에서 서버가 계산합니다. 같은 사실을 두 곳에 적지 않습니다.</p>
            <p>“나의 할 일”은 지금 내가 고를 수 있는 것만 셉니다. 소유자만 고를 수 있는 것은 다른 역할에게 “기다림”으로 보입니다.</p>
            <p>사용량·연결 같은 관리 지표는 문제가 될 때만 여기에 올라옵니다.</p>
          </InfoTip>
        }
      />
      <StatBar
        label="막힌 것·풀 것 요약"
        cells={[
          { k: lookup("problemState", "open").label, v: <span className="tabular-nums">{ws.problems.filter((p) => p.state === "open").length}건</span>, to: "#pbs-open" },
          { k: lookup("problemState", "ai").label, v: <span className="tabular-nums">{ws.problems.filter((p) => p.state === "ai").length}건</span> },
          { k: lookup("problemState", "waiting").label, v: <span className="tabular-nums">{ws.problems.filter((p) => p.state === "waiting").length}건</span> },
          { k: "해결 기록", v: <span className="tabular-nums">{ws.problem_log.length}건</span>, to: "#pb-log" },
        ]}
      />
      <div className="mt-4">
        <Tabs value={filter} onValueChange={(v) => setFilter(v as Filter)}>
          <TabsList variant="line" aria-label="막힌 것 거르기">
            <TabsTrigger value="all">전체 {count("all")}</TabsTrigger>
            <TabsTrigger value="content">연구 내용 {count("content")}</TabsTrigger>
            <TabsTrigger value="progress">진행 {count("progress")}</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      {shown.length === 0 ? (
        <div className="mt-4">
          <EmptyState title="지금 막힌 것이 없습니다" body="AI 점검·출처 대조·동기화에서 문제가 생기면 여기에 올라오고, 알림으로도 알려 드립니다." />
        </div>
      ) : (
        <>
          <Section sid="open" title={lookup("problemState", "open").label} sub="지금 내가 고를 수 있는 것" items={mine} ws={ws} openId={openId} setOpenId={setOpenId} onResolved={onResolved} empty="지금 내가 고를 것은 없습니다." />
          <Section sid="ai" title={lookup("problemState", "ai").label} sub="내가 AI에게 맡긴 것 — 결과는 다음 결과 글에" items={ai} ws={ws} openId={openId} setOpenId={setOpenId} onResolved={onResolved} />
          <Section sid="waiting" title={lookup("problemState", "waiting").label} sub="다른 사람이나 시각을 기다림 — 내 할 일 아님" items={waiting} ws={ws} openId={openId} setOpenId={setOpenId} onResolved={onResolved} />
        </>
      )}

      <FoldCard id="pb-log" title={`해결 기록 ${ws.problem_log.length}`} meta="지우지 않음 · 최근 것부터" className="mt-6" defaultOpen={hash === "#pb-log"}>
        {ws.problem_log.length ? (
          <Table regionLabel="해결 기록" className="min-w-[640px]">
            <TableCaption className="sr-only">해결 기록 — 고른 것 · 누가 · 언제 · 접수 번호</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col" className="w-[64px]">
                  시각
                </TableHead>
                <TableHead scope="col">문제</TableHead>
                <TableHead scope="col">고른 것</TableHead>
                <TableHead scope="col" className="w-[72px]">
                  누가
                </TableHead>
                <TableHead scope="col" className="w-[84px]">
                  접수 번호
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ws.problem_log.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="tabular-nums">{r.at}</TableCell>
                  <TableHead scope="row" className="font-normal">
                    <span className="mb-1 block">
                      <Status of="problem" value={r.kind} />
                    </span>
                    {r.title}
                  </TableHead>
                  <TableCell>
                    {r.choice}
                    {r.note ? <span className="mt-0.5 block text-xs text-muted-foreground">{r.note}</span> : null}
                  </TableCell>
                  <TableCell>{r.by}</TableCell>
                  <TableCell className="tabular-nums">{r.receipt_no}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="text-meta text-muted-foreground">아직 해결 기록이 없습니다.</p>
        )}
      </FoldCard>
      <Anno>
        문제 하나 = 원인 한 줄 + 선택지 2~3개(추천 하나, 미리 고르지 않음) + 한 번에 처리. 처리는 닫힌 명령 하나(problem.resolve 또는 그 일의 원래 명령)라 영수증 뒤에만 “정함”이 보이고, 같은 요청 번호로 다시 보내도 두 번 처리하지 않습니다. 풀리면 목록에서 빠지고 해결 기록에 남습니다. 결과 글의 문제 문단에도 같은 흐름이 붙습니다(설계 16.4).
      </Anno>
    </div>
  );
}
