import { Link } from "react-router";
import { ArrowRightIcon } from "lucide-react";
import { PROBLEM_GROUP, STAGE_LABEL } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Anno, CardHead, Eyebrow } from "@/components/pes/bits";
import { InfoTip } from "@/components/pes/disclosure";
import { STAGE_MARK } from "@/components/pes/stage";
import { Status, StatusFrom, StatusMark } from "@/components/pes/status";
import { lookup } from "@/components/pes/status-registry";
import { TurnIndicator } from "@/components/pes/turn";
import { useWs } from "@/features/workspace/WorkspaceLayout";
import { approvalBlockers, useLastLocation } from "@/lib/research-ui";
import { cn } from "@/lib/utils";

/**
 * 연구 개요(설계 16.2 · 16.5) — 연구 공간의 첫 화면: “이 연구가 지금 어디까지 왔나”.
 * 첫눈에는 이어서 하기(지금 할 일 1개) → 연구 질문 · 지금 어디까지 · 핵심 발견 · 남은 문제 · 다음 마일스톤.
 * 사용량·연결 같은 관리 지표는 여기 두지 않는다(AI 동료 칸 아래 한 줄, 문제가 되면 막힌 것·풀 것).
 */
export function OverviewPage() {
  const { ws, roundPath } = useWs();
  const last = useLastLocation(ws.slug);
  const first = ws.tasks.find((t) => t.counted) ?? ws.tasks[0];
  const probs = ws.problems;
  const by = (s: string) => probs.filter((p) => p.state === s).length;
  const content = probs.filter((p) => PROBLEM_GROUP[p.kind] === "content").length;
  const { reasons: approvalReasons, blocking, total: blockerTotal } = approvalBlockers(ws);
  const resumeTo = last?.path ?? (first ? `${roundPath}?t=${first.id}` : roundPath);

  return (
    <div className="mt-5 space-y-4">
      {/* 이어서 하기 — 이 화면의 “지금 할 일 1개”(14절) */}
      <Card className="gap-0 border-primary-line bg-primary-soft px-5 py-4" aria-labelledby="ov-resume">
        <div className="flex flex-col gap-3 tab:flex-row tab:items-start tab:justify-between tab:gap-6">
          <div className="min-w-0">
            <Eyebrow>{last ? "이어서 하기 · 마지막 위치" : "이어서 하기"}</Eyebrow>
            <h2 id="ov-resume" className="text-page tracking-tight">
              {last ? last.label : first ? first.title : "지금 할 일이 없습니다"}
            </h2>
            <p className="mt-1 text-sm text-ink-2">
              {last ? `${last.at}에 멈춘 곳 · ` : ""}막힌 것 {probs.length}건 · 다음 마일스톤 {ws.brief.milestone.title}
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-stretch gap-2 tab:max-w-[22rem] tab:items-end">
            {ws.turn ? <TurnIndicator turn={ws.turn} size="lg" align="end" detail={ws.turn.side !== "you"} /> : null}
            <div className="flex flex-wrap gap-2 tab:justify-end">
              <Button asChild variant="default">
                <Link to={resumeTo}>
                  이어서 하기
                  <ArrowRightIcon aria-hidden="true" />
                </Link>
              </Button>
              {last && first ? (
                <Button asChild>
                  <Link to={`${roundPath}?t=${first.id}`}>지금 할 일 순서대로</Link>
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-1 items-start gap-4 tab:grid-cols-2">
        <Card className="gap-0 px-5" aria-labelledby="ov-q">
          <CardHead eyebrow="연구 질문" title={<span className="text-body font-semibold">{ws.brief.question}</span>} titleId="ov-q" />
          <p className="-mt-1 text-meta text-ink-2">{ws.brief.scope}</p>
        </Card>

        <Card className="gap-0 px-5" aria-labelledby="ov-where">
          <CardHead eyebrow="지금 어디까지" title={`${ws.current.label} · ${ws.edition}판`} titleId="ov-where" />
          <ol aria-label="연구 흐름 6단계" className="grid grid-cols-3 gap-1.5 tab:grid-cols-6">
            {ws.stages.map((s) => {
              const m = STAGE_MARK[s.view];
              const text = s.state_text ?? lookup("stage", s.view).label;
              const current = Boolean(s.rounds);
              return (
                <li key={s.key} className="min-w-0">
                  <Link
                    to={current ? roundPath : `/p/${ws.slug}/s/${s.key}`}
                    aria-current={current ? "step" : undefined}
                    className={cn("flex h-full flex-col items-center gap-0.5 rounded-lg border px-1 pt-1.5 pb-1 text-center no-underline hover:border-line-strong", current ? "border-primary-line bg-primary-soft" : "border-line bg-surface-soft")}
                  >
                    <StatusMark shape={m.shape} className={m.cls} />
                    <span className="text-meta font-semibold text-ink">{STAGE_LABEL[s.key]}</span>
                    <span className="text-caption leading-tight text-ink-2">{text}</span>
                  </Link>
                </li>
              );
            })}
          </ol>
          <p className="mt-2 text-caption text-muted-foreground">지난 단계를 누르면 결과 요약을 다시 봅니다.</p>
        </Card>

        <Card className="gap-0 px-5 tab:col-span-2" aria-labelledby="ov-find">
          <CardHead
            eyebrow="핵심 발견"
            title={ws.brief.findings.length ? `지금까지 ${ws.brief.findings.length}가지` : "아직 발견이 없습니다"}
            titleId="ov-find"
            aside={
              <InfoTip label="핵심 발견 설명">
                <p>결과 글에서 뽑은 주장과 그 근거 상태입니다. 막힌 것과 이어진 발견은 그 문제가 풀리면 근거 칩이 바뀝니다. 근거를 모르면 “확인 안 됨”으로 둡니다.</p>
              </InfoTip>
            }
          />
          {ws.brief.findings.length ? (
            <ol className="divide-y divide-line">
              {ws.brief.findings.map((f, i) => (
                <li key={f.id} className="flex flex-col gap-1 py-2.5 first:pt-0 last:pb-0 tab:flex-row tab:items-start tab:justify-between tab:gap-4">
                  <p className="min-w-0 text-meta leading-relaxed">
                    <span className="mr-1.5 text-xs font-semibold text-muted-foreground tabular-nums">{i + 1}</span>
                    {f.text}
                    <Link to={f.href} className="ml-1.5 text-caption">
                      {f.where}
                    </Link>
                  </p>
                  <span className="shrink-0">
                    <StatusFrom s={f.basis} />
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-meta text-ink-2">{ws.current.stage === "plan" ? "기획 단계라 아직 결과 글에서 뽑은 발견이 없습니다 — 조사 단계부터 생깁니다." : "결과 글이 나오면 여기에 정리됩니다."}</p>
          )}
        </Card>

        <Card className="gap-0 px-5" aria-labelledby="ov-prob">
          <CardHead eyebrow="남은 문제" title={probs.length ? `막힌 것·풀 것 ${probs.length}건` : "막힌 것이 없습니다"} titleId="ov-prob" />
          {probs.length ? (
            <>
              <p className="text-meta text-ink-2">
                {lookup("problemState", "open").label} {by("open")} · {lookup("problemState", "ai").label} {by("ai")} · {lookup("problemState", "waiting").label} {by("waiting")} — 연구 내용 {content} · 진행 {probs.length - content}
              </p>
              <ul className="mt-2 space-y-1.5">
                {probs.slice(0, 3).map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-meta">
                    <Status of="problem" value={p.kind} />
                    <Link to={`/p/${ws.slug}/problems#pb-${p.id}`} className="min-w-0 coarse:inline-flex coarse:min-h-[44px] coarse:items-center">
                      {p.title}
                    </Link>
                  </li>
                ))}
              </ul>
              <Button asChild size="sm" className="mt-3">
                <Link to={`/p/${ws.slug}/problems`}>막힌 것·풀 것 보기</Link>
              </Button>
            </>
          ) : (
            <p className="text-meta text-ink-2">문제가 생기면 여기와 막힌 것·풀 것에 올라옵니다.</p>
          )}
        </Card>

        <Card className="gap-0 px-5" aria-labelledby="ov-mile">
          <CardHead eyebrow="다음 마일스톤" title={ws.brief.milestone.title} titleId="ov-mile" />
          <p className="-mt-1 text-meta text-ink-2">{ws.brief.milestone.note}</p>
          {blockerTotal ? (
            <>
              {/* 18.3-4: 개요 · 지금 할 일 머리 · 승인 카드가 같은 수(approvalBlockers().total)와 같은 이름 */}
              <p className="mt-2 text-meta font-semibold">승인을 막는 것 {blockerTotal}건</p>
              <ul className="mt-1 space-y-1 text-meta" aria-label={`승인을 막는 것 ${blockerTotal}건`}>
                {approvalReasons.map((r) => (
                  <li key={r} className="flex items-center gap-1.5">
                    <Status of="check" value="notyet" />
                    {r}
                  </li>
                ))}
                {blocking.map((p) => (
                  <li key={p.id} className="flex items-center gap-1.5">
                    <Status of="problem" value={p.kind} />
                    {p.title}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="mt-2 text-meta">
              <Status of="check" value="pass" label="남은 것 없음" />
            </p>
          )}
          <Button asChild size="sm" className="mt-3">
            <Link to={`${roundPath}?t=approve`}>승인 단계 보기</Link>
          </Button>
        </Card>
      </div>
      <Anno>
        연구 공간(5차, 설계 16절)의 첫 화면. 들어오면 이 연구에만 집중하도록 관리용 전역 메뉴·다른 프로젝트·전역 사용량 계기를 빼고, 왼쪽 위의 “모든 프로젝트”와 프로젝트 전환만 남겼다. 이어서 하기는 이 브라우저에 남긴 마지막 위치(없으면 첫 할 일)로 간다. 핵심 발견의 근거 칩은 막힌 것과 같은 계산이다.
      </Anno>
    </div>
  );
}
