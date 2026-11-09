import * as React from "react";
import { Link, useLocation, useParams, useSearchParams } from "react-router";
import { ArrowLeftIcon, ArrowRightIcon, CheckIcon } from "lucide-react";
import { useCommand } from "@/api/queries";
import { STAGES, STAGE_LABEL, type TaskStep, type WorkspaceView } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { CardHead, Eyebrow, KV, Tag } from "@/components/pes/bits";
import { EmptyState } from "@/components/pes/blocks";
import { ConfirmDialog } from "@/components/pes/confirm";
import { ActionButton } from "@/components/pes/controls";
import { InfoTip } from "@/components/pes/disclosure";
import { Status, StatusFrom, StatusMark } from "@/components/pes/status";
import { lookup } from "@/components/pes/status-registry";
import { TurnIndicator } from "@/components/pes/turn";
import { ResolveFlow } from "@/features/research/ResolveFlow";
import { useMockSettings } from "@/lib/mock-settings";
import { answersSent, approvalBlockers, useAnswersSent, type AnswersSent } from "@/lib/research-ui";
import { cn } from "@/lib/utils";
import { AiWork } from "./AiWork";
import { PhoneToolsToggle } from "./phone-tools";
import { QuestionPanel } from "./QuestionPanel";
import { ReferenceCard, ResultPanel } from "./ResultPanel";
import { useWs } from "./WorkspaceLayout";

/**
 * 옛 주소의 #조각 → 지금 할 일 단계(알림·목록·명령 메뉴의 링크가 그대로 동작하게).
 * #q-21 · #qpanel → 질문 답하기 / #result · #para-1 · #an-1 → 결과 글 / #sync → 동기화 / #refs → 참고 / #ap-t → 승인 / #ai → 계속(없으면 기다림)
 */
function stepForHash(hash: string, tasks: TaskStep[]): string | null {
  const h = hash.replace("#", "");
  if (!h) return null;
  if (h === "qpanel" || h === "q-title" || h.startsWith("q-") || h.startsWith("b-")) return "answer";
  if (h === "result" || h === "result-card" || h === "refl-title" || h.startsWith("an-") || h.startsWith("para-") || h.startsWith("pbx-")) return "review";
  if (h === "sync") return "sync";
  if (h === "refs") return "refs";
  if (h === "ap-t") return "approve";
  if (h === "ai") return tasks.some((t) => t.id === "resume") ? "resume" : "wait";
  return null;
}

const stepHref = (roundPath: string, id: string) => `${roundPath}?t=${encodeURIComponent(id)}`;

/** 단계 모양 — 나의 할 일(◆) · 풀 것(▲) · 아직(—) · 읽기(●)… 상태 사전 그대로(글자가 뜻을 전함) */
function StepMark({ s }: { s: TaskStep }) {
  const def = lookup(s.status.domain, s.status.value);
  return <StatusMark shape={def.shape} className={cn("size-2.5", def.tone === "you" || def.tone === "run" ? "text-primary-ink" : def.tone === "warn" ? "text-warn" : def.tone === "bad" ? "text-bad" : def.tone === "ok" ? "text-ok" : "text-ink-2")} />;
}

/** 단계마다 짧은 사실 한 줄(14절 — 설명 문장 대신 2~3개의 짧은 사실) */
function stepFacts(ws: WorkspaceView, s: TaskStep): string | null {
  switch (s.kind) {
    case "answer":
      return `답할 질문 ${ws.form.answerable}${ws.form.required_left ? ` · 필수 ${ws.form.required_left}개 남음` : " · 필수 답 모두 보냄"}${ws.now.kind === "answer" ? (ws.now.facts ?? []).filter((f) => f.startsWith("기한")).map((f) => ` · ${f}`).join("") : ""}`;
    case "review": {
      const n = ws.problems.filter((p) => p.paragraph !== undefined && p.state === "open").length;
      return `${ws.result?.meta_short ?? ws.result?.title ?? ""}${n ? ` · 문제 표시 ${n}곳` : ""}${ws.annotations.length ? ` · 첨언 ${ws.annotations.length}` : ""}`;
    }
    case "refs":
      return "새 버전이 생겨도 저절로 바꾸지 않습니다 — 비교하고 갱신하거나 지금 버전을 유지";
    case "resume":
      return ws.runs.mode_label;
    case "approve": {
      const n = approvalBlockers(ws).total;
      return n ? `승인을 막는 것 ${n}건` : "승인할 수 있습니다";
    }
    default:
      return null;
  }
}

/**
 * 지금 할 일 머리(설계 16.3) — 옛 “지금 할 일 띠”(NowCard)를 대신한다.
 * 지금 하는 일 한 가지(제목) · 순서(1/5) · 차례 표시기 · 다음 할 일. 순서 줄의 단계는 나의 할 일 목록과 같은 수를 센다.
 */
function StepHeader({ ws, tasks, cur, roundPath }: { ws: WorkspaceView; tasks: TaskStep[]; cur: TaskStep | null; roundPath: string }) {
  const i = cur ? tasks.findIndex((t) => t.id === cur.id) : -1;
  const prev = i > 0 ? tasks[i - 1] : undefined;
  const next = i >= 0 ? tasks[i + 1] : tasks[0];
  return (
    <section aria-labelledby="now-title" className="rounded-xl border border-primary-line bg-card px-5 py-4 shadow-xs">
      <div className="flex flex-col gap-3 tab:flex-row tab:items-start tab:justify-between tab:gap-6">
        <div className="min-w-0">
          <Eyebrow>
            지금 할 일{cur ? ` · ${i + 1}/${tasks.length}` : ""}
          </Eyebrow>
          <h2 id="now-title" tabIndex={-1} className="text-page tracking-tight outline-none">
            {cur ? cur.title : "이 일을 마쳤습니다"}
          </h2>
          {cur && stepFacts(ws, cur) ? <p className="mt-1 text-sm text-ink-2">{stepFacts(ws, cur)}</p> : null}
          {cur && !cur.counted ? <p className="mt-0.5 text-meta text-muted-foreground">{cur.kind === "approve" ? "다음 마일스톤 — 아직 세지 않는 단계" : cur.kind === "wait" ? "지금 내가 할 일은 없습니다" : "읽기 · 나의 할 일 수에 넣지 않는 단계"}</p> : null}
        </div>
        {ws.turn ? <TurnIndicator turn={ws.turn} size="lg" align="end" detail={ws.turn.side !== "you"} className="shrink-0" /> : null}
      </div>
      {/* relative: 안쪽 화면 읽기 전용 글(sr-only, absolute)이 이 줄의 가로 스크롤 밖으로 빠져 쪽 너비를 늘리지 않게 */}
      <nav aria-label="지금 할 일 순서" className="relative -mx-1 mt-3 overflow-x-auto px-1 pb-1">
        <ol className="flex w-max min-w-full gap-1.5">
          {tasks.map((t, n) => {
            const on = cur?.id === t.id;
            return (
              <li key={t.id}>
                <Link
                  to={stepHref(roundPath, t.id)}
                  aria-current={on ? "step" : undefined}
                  className={cn(
                    "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-meta font-medium whitespace-nowrap no-underline coarse:h-[44px]",
                    on ? "border-primary bg-primary-soft text-primary-ink" : "border-line bg-surface text-ink-2 hover:border-line-strong hover:text-foreground",
                    !t.counted && !on && "border-dashed",
                  )}
                >
                  <span className="tabular-nums text-muted-foreground">{n + 1}</span>
                  <StepMark s={t} />
                  {t.short}
                  <span className="sr-only"> — {lookup(t.status.domain, t.status.value).label}{t.counted ? "" : " · 세지 않음"}</span>
                </Link>
              </li>
            );
          })}
        </ol>
      </nav>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-2.5">
        {prev ? (
          <Button asChild size="sm" variant="ghost">
            <Link to={stepHref(roundPath, prev.id)}>
              <ArrowLeftIcon aria-hidden="true" />
              이전 · {prev.short}
            </Link>
          </Button>
        ) : (
          <span />
        )}
        {next ? (
          <Button asChild size="sm" variant={cur ? "outline" : "default"} data-jk-next="">
            <Link to={stepHref(roundPath, next.id)}>
              다음 할 일 · {next.short}
              <ArrowRightIcon aria-hidden="true" />
            </Link>
          </Button>
        ) : (
          <Button asChild size="sm" data-jk-next="">
            <Link to={`/p/${ws.slug}/problems`}>막힌 것·풀 것 보기</Link>
          </Button>
        )}
      </div>
    </section>
  );
}

/** 답을 보낸 바로 뒤 — 같은 자리에 “보냄” 확인. 초점은 이 제목으로, 다음 할 일은 사람이 고른다 */
function SentPanel({ ws, tasks, roundPath, note }: { ws: WorkspaceView; tasks: TaskStep[]; roundPath: string; note: AnswersSent }) {
  const next = tasks.find((t) => t.counted && t.id !== "answer") ?? tasks.find((t) => t.id !== "answer");
  const remaining = tasks.find((t) => t.id === "answer");
  const waitsContinue = tasks.some((t) => t.id === "resume");
  const ref = React.useRef<HTMLHeadingElement>(null);
  React.useEffect(() => {
    const t = window.setTimeout(() => ref.current?.focus(), 60);
    return () => window.clearTimeout(t);
  }, []);
  return (
    <Card className="mt-4 gap-2 border-ok-line px-5" aria-labelledby="sent-t">
      <div className="flex items-center gap-2">
        <span aria-hidden="true" className="grid size-6 place-items-center rounded-full border border-ok-line bg-ok-soft text-ok">
          <CheckIcon className="size-3.5" />
        </span>
        <h3 id="sent-t" ref={ref} tabIndex={-1} data-route-target="" className="text-title outline-none">
          보냄 · AI가 이어서 합니다
        </h3>
      </div>
      <p className="text-body text-ink-2">
        답 {note.count}개를 보냈습니다. {waitsContinue ? "소유자가 ‘계속’을 누르면 AI가 이어서 합니다." : ws.mode === "B" ? "내 컴퓨터 AI가 받으면 이어서 합니다." : "AI가 이어서 합니다."}
      </p>
      <p className="text-caption text-muted-foreground">접수 번호 {note.receipt_no}</p>
      <div className="flex flex-wrap gap-2">
        {next ? (
          <Button asChild variant="default" size="sm">
            <Link to={stepHref(roundPath, next.id)} data-jk-next="">
              다음 할 일 · {next.title}
              <ArrowRightIcon aria-hidden="true" />
            </Link>
          </Button>
        ) : null}
        {remaining ? (
          <Button size="sm" onClick={() => answersSent.set(null)}>
            남은 질문 {ws.form.answerable}개 보기
          </Button>
        ) : null}
      </div>
    </Card>
  );
}

/** 단계를 마치면 그 자리에 — 다음 할 일 단추로 초점(끝나면 다음 것으로 자연스럽게, 저절로 넘기지는 않음) */
function DonePanel({ ws, tasks, roundPath, doneTitle }: { ws: WorkspaceView; tasks: TaskStep[]; roundPath: string; doneTitle: string }) {
  const next = tasks.find((t) => t.counted) ?? tasks[0];
  const ref = React.useRef<HTMLAnchorElement>(null);
  React.useEffect(() => {
    const t = window.setTimeout(() => ref.current?.focus(), 60);
    return () => window.clearTimeout(t);
  }, []);
  return (
    <Card className="mt-4 gap-2 px-5" aria-labelledby="done-t">
      <p className="flex items-center gap-2">
        <span aria-hidden="true" className="grid size-6 place-items-center rounded-full border border-ok-line bg-ok-soft text-ok">
          <CheckIcon className="size-3.5" />
        </span>
        <span id="done-t" className="text-meta font-semibold">
          {doneTitle} — 마쳤습니다
        </span>
      </p>
      <p className="text-meta text-ink-2">기록은 해결 기록과 접수 번호로 남습니다. 저절로 넘어가지 않습니다 — 다음 일을 골라 주세요.</p>
      <div className="flex flex-wrap gap-2">
        {next ? (
          <Button asChild variant="default" size="sm">
            <Link ref={ref} to={stepHref(roundPath, next.id)} data-jk-next="">
              다음 할 일 · {next.title}
              <ArrowRightIcon aria-hidden="true" />
            </Link>
          </Button>
        ) : null}
        <Button asChild size="sm">
          <Link to={`/p/${ws.slug}`}>연구 개요로</Link>
        </Button>
      </div>
    </Card>
  );
}

/** 단계 승인(다음 마일스톤) — 승인할 고정본 · 함께 볼 것 · 아직 못 하는 이유. 소유자만, 본인 확인(5단계) */
function ApprovalStep({ ws }: { ws: WorkspaceView }) {
  const { role } = useMockSettings();
  const owner = role === "owner";
  const approve = useCommand("stage.approve", { successText: (r) => `승인됨 · 접수 번호 ${r.receipt_no}` });
  const [open, setOpen] = React.useState(false);
  const nextStage = STAGES[STAGES.indexOf(ws.current.stage as (typeof STAGES)[number]) + 1];
  const { reasons: approvalReasons, blocking, total: blockerTotal } = approvalBlockers(ws);
  // 18.3-4: 개요 · 지금 할 일 머리와 같은 수(total)와 같은 이름 “승인을 막는 것 n건”
  const reasons = [...approvalReasons, ...blocking.map((p) => p.title)];
  const why = !owner ? "단계 승인은 소유자만 할 수 있습니다." : blockerTotal ? `승인을 막는 것 ${blockerTotal}건: ${reasons.join(" · ")}` : approve.pending ? "접수 확인 중입니다" : null;
  return (
    <Card className="gap-0 px-5" aria-labelledby="ap-t">
      <CardHead eyebrow="다음 마일스톤 · 단계 승인" title={`${ws.approval.stage_label} 단계 승인`} titleId="ap-t" right={!owner ? <Tag>소유자만</Tag> : <StatusFrom s={reasons.length ? { domain: "generic", value: "notyet", label: "아직" } : { domain: "turn", value: "approve" }} />} />
      <KV
        items={[
          ["승인할 것", `${ws.current.label} 고정된 결과${ws.result ? ` · ${ws.result.title}` : " · 결과물 없음"}`],
          ["함께 볼 것", `열린 첨언 ${ws.annotations.length} · 막힌 것 ${ws.problems.length}${ws.reflection ? ` · 반영 ${ws.reflection.summary.label ?? ""}` : ""}`],
          ["승인하면", "다음 단계가 열립니다. AI가 바로 시작하지는 않습니다."],
        ]}
      />
      {reasons.length ? (
        <div className="mt-3 rounded-lg border border-line bg-surface-soft px-3 py-2.5">
          <p className="text-meta font-semibold">승인을 막는 것 {blockerTotal}건</p>
          <ul className="mt-1.5 space-y-1 text-meta">
            {approvalReasons.map((r) => (
              <li key={r} className="flex items-center gap-1.5">
                <Status of="check" value="notyet" />
                {r}
              </li>
            ))}
            {blocking.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-1.5">
                <Status of="problem" value={p.kind} />
                <Link to={`/p/${ws.slug}/problems#pb-${p.id}`} className="coarse:inline-flex coarse:min-h-[44px] coarse:items-center">
                  {p.title}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <ActionButton size="sm" variant={why ? "outline" : "default"} blockedBy={why} reasonId="ap-why" onClick={() => setOpen(true)}>
          승인 검토하기
        </ActionButton>
        <p id="ap-why" className="flex items-center gap-1 text-caption text-ink-2">
          {why ?? "승인할 수 있습니다"}
          <InfoTip label="단계 승인 설명">
            <p>{ws.approval.note}</p>
          </InfoTip>
        </p>
      </div>
      <ConfirmDialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) approve.reset();
        }}
        spec={{
          eyebrow: "소유자만",
          title: `${ws.approval.stage_label} 단계를 승인할까요?`,
          target: `${ws.title} · ${ws.current.label} 고정된 결과`,
          verb: "본인 확인하고 승인",
          changes: ["다음 단계가 열립니다.", "승인 기록(누가 · 언제 · 고정본)이 남습니다."],
          unchanged: ["AI가 바로 시작하지는 않습니다.", "그사이 내용이 바뀌면 승인하지 않습니다(새 버전)."],
          stepUp: true,
          done: nextStage
            ? {
                title: `${ws.approval.stage_label} 단계를 마쳤습니다 — ${STAGE_LABEL[nextStage]} 단계가 열렸습니다`,
                body: "AI는 아직 시작하지 않았습니다. 다음 단계에서 시작 질문에 답하면 이어집니다.",
                action: { label: `${STAGE_LABEL[nextStage]} 단계로 가기`, to: `/p/${ws.slug}/s/${nextStage}` },
              }
            : { title: `${ws.approval.stage_label} 단계를 마쳤습니다 — 모든 단계가 끝났습니다` },
        }}
        phase={approve.phase}
        receipt={approve.receipt}
        errorText={approve.error?.message}
        onRecheck={approve.recheck}
        onConfirm={(reason, stepUp) => approve.run({ slug: ws.slug, stage: ws.current.stage, snapshot: `${ws.current.label} 봉인본`, note: reason, step_up: stepUp })}
      />
    </Card>
  );
}

/** 할 일이 없을 때 — 지금은 AI 작업 중(또는 기다림). 진행 보기 = AI 작업(실행 · 타임라인) */
function WaitStep({ ws }: { ws: WorkspaceView }) {
  return (
    <div className="space-y-4">
      <Card className="gap-1.5 px-5" aria-labelledby="wait-t">
        <h3 id="wait-t" className="text-meta">
          {ws.turn?.side === "ai" ? "그동안 할 수 있는 일" : "지금 기다리는 것"}
        </h3>
        <p className="text-meta text-ink-2">{ws.turn?.side === "ai" ? "AI 결과가 오면 알림과 함께 이 자리에 할 일이 생깁니다. 그동안:" : ws.turn?.text}</p>
        <ul className="mt-1 flex flex-wrap gap-2 text-meta">
          <li>
            <Link to={`/p/${ws.slug}/problems`} className="coarse:inline-flex coarse:min-h-[44px] coarse:items-center">
              막힌 것·풀 것 보기
            </Link>
          </li>
          <li>
            <Link to={`/p/${ws.slug}/files`} className="coarse:inline-flex coarse:min-h-[44px] coarse:items-center">
              자료 정리
            </Link>
          </li>
          <li>
            <Link to={`/p/${ws.slug}`} className="coarse:inline-flex coarse:min-h-[44px] coarse:items-center">
              연구 개요
            </Link>
          </li>
        </ul>
      </Card>
      <AiWork ws={ws} />
    </div>
  );
}

/** 문제 하나가 한 단계(동기화 충돌 · 실행 멈춤 · 자료 문제) — 해결 흐름이 가운데를 차지한다 */
function ProblemStep({ ws, step, onResolved }: { ws: WorkspaceView; step: TaskStep; onResolved: () => void }) {
  const p = ws.problems.find((x) => x.id === step.problem_id);
  if (!p) return <EmptyState title="이 문제는 이미 풀렸습니다" body="해결 기록에서 고른 것과 접수 번호를 볼 수 있습니다." action={<Button asChild size="sm"><Link to={`/p/${ws.slug}/problems#pb-log`}>해결 기록</Link></Button>} />;
  return (
    <Card id={step.kind === "sync" ? "sync" : undefined} className="gap-0 px-5" aria-labelledby={`ps-${p.id}`}>
      <ResolveFlow ws={ws} p={p} headingAs="h3" headingId={`ps-${p.id}`} onResolved={onResolved} />
    </Card>
  );
}

/**
 * 연구 공간의 “지금 할 일”(설계 16.3) — 가운데에 지금 하는 일 한 가지만:
 * 답할 질문이면 질문 폼, 읽고 고칠 결과면 결과 글(문제 표시 · 첨언), 문제 하나면 해결 흐름, 승인이면 승인 검토.
 * 다음 할 일은 하나씩 이어진다(순서 줄 · 다음 단추 · 집중 모드의 J/K). 주소 ?t=단계(옛 #조각도 그 단계로).
 */
export function RoundPage() {
  const { ws, roundPath } = useWs();
  const { round } = useParams();
  const location = useLocation();
  const [sp] = useSearchParams();
  const viewingPast = round !== undefined && round !== ws.current.round;
  const tasks = ws.tasks;
  const want = sp.get("t") ?? stepForHash(location.hash, tasks);
  // 이 탭에서 본 단계 — 있던 단계가 사라지면(풀림) “마쳤습니다”를 보인다
  const seen = React.useRef(new Map<string, string>());
  tasks.forEach((t) => seen.current.set(t.id, t.title));
  const found = want ? tasks.find((t) => t.id === want) : undefined;
  const finished = Boolean(want && !found && seen.current.has(want));
  const cur = found ?? (finished ? null : (tasks.find((t) => t.counted) ?? tasks[0] ?? null));
  // 방금 보낸 답 확인 — 질문 단계를 떠나면 지운다
  const sent = useAnswersSent();
  const sentHere = sent && sent.slug === ws.slug && want === "answer" ? sent : null;
  const prevWant = React.useRef(want);
  React.useEffect(() => {
    if (prevWant.current === "answer" && want !== "answer" && answersSent.get()) answersSent.set(null);
    prevWant.current = want;
  }, [want]);

  const focusNext = () => {
    window.setTimeout(() => document.querySelector<HTMLElement>("#main [data-jk-next]")?.focus(), 500);
  };

  if (viewingPast) {
    return (
      <div className="mt-3">
        <EmptyState
          eyebrow={`보는 중 ${round === "start" ? "단계 시작" : `R${round}`} · 현재 진행 ${ws.current.label}`}
          title="지난 라운드(고정된 결과)는 읽기 전용입니다"
          body="답·첨언은 현재 라운드에서 합니다. 지난 결과는 반영 내역과 결과물 버전 기록에 있습니다."
          action={
            <Button asChild variant="default">
              <Link to={roundPath}>현재 진행으로 — {ws.current.label}</Link>
            </Button>
          }
        />
      </div>
    );
  }

  let body: React.ReactNode = null;
  if (cur) {
    switch (cur.kind) {
      case "answer":
        body = (
          <section id="qpanel" aria-labelledby="q-title" tabIndex={-1} className="outline-none">
            <QuestionPanel ws={ws} />
          </section>
        );
        break;
      case "review":
        body = (
          <div id="result" tabIndex={-1} className="outline-none">
            <ResultPanel ws={ws} />
          </div>
        );
        break;
      case "refs":
        body = (
          <div className="space-y-3">
            {ws.references.map((r, i) => (
              <ReferenceCard key={r.id} r={r} slug={ws.slug} anchor={i === 0} />
            ))}
          </div>
        );
        break;
      case "resume":
        body = <AiWork ws={ws} />;
        break;
      case "approve":
        body = <ApprovalStep ws={ws} />;
        break;
      case "wait":
        body = <WaitStep ws={ws} />;
        break;
      default:
        body = <ProblemStep ws={ws} step={cur} onResolved={focusNext} />;
    }
  }

  return (
    <>
      <StepHeader ws={ws} tasks={tasks} cur={cur} roundPath={roundPath} />
      <div className="mt-2 flex justify-end desk:hidden">
        <PhoneToolsToggle />
      </div>
      {sentHere ? <SentPanel ws={ws} tasks={tasks} roundPath={roundPath} note={sentHere} /> : finished ? <DonePanel ws={ws} tasks={tasks} roundPath={roundPath} doneTitle={seen.current.get(want!) ?? "이 일"} /> : <div className="mt-4 min-w-0">{body}</div>}
    </>
  );
}
