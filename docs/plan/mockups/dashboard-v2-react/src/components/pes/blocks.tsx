import * as React from "react";
import { Link } from "react-router";
import { RotateCcwIcon, WifiOffIcon } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { NowItem, Role, TurnView } from "@/api/types";
import { useMockSettings } from "@/lib/mock-settings";
import { cn } from "@/lib/utils";
import { Eyebrow } from "./bits";
import { MoreContent, MoreRoot, MoreTrigger } from "./disclosure";
import { Chip } from "./status";
import { TurnIndicator } from "./turn";

const RANK_NAME: Record<NowItem["kind"], string> = {
  blocked: "막힘",
  answer: "내 답",
  approve: "승인",
  resume: "계속",
  check: "확인",
  wait: "기다림",
};
const RANK_EDGE: Record<NowItem["kind"], string> = {
  blocked: "border-bad-line",
  answer: "border-primary-line",
  approve: "border-primary-line",
  resume: "border-primary-line",
  check: "border-warn-line",
  wait: "border-ok-line",
};
/** 배너 바탕: 순위 색을 옅은 바탕 한 면으로 깐다(왼쪽 굵은 띠·번짐 없음 — impeccable side-tab 지적, 11-10). 순위 이름은 머리글 글자로도 보인다. */
const RANK_BG: Record<NowItem["kind"], string> = {
  blocked: "bg-bad-soft",
  answer: "bg-primary-soft",
  approve: "bg-primary-soft",
  resume: "bg-primary-soft",
  check: "bg-warn-soft",
  wait: "bg-ok-soft",
};

/** 이 역할이 이 순위의 일을 직접 할 수 없는가(시안 — 실제로는 서버가 사람·권한별로 계산한 지금 할 일을 준다) */
function lacksPermission(kind: NowItem["kind"], role: Role) {
  if (role === "owner") return false;
  if (role === "reader") return kind !== "wait";
  return kind === "blocked" || kind === "approve" || kind === "resume";
}

/**
 * 지금 할 일(설계 3.3): 가장 중요한 일 1개 + 주 단추 1개 + “그다음” 2개까지.
 * 서버 읽기 묶음이 계산한 것을 그대로 그린다(A·B 같은 문구, PR21 교차 계약).
 * 정보 밀도(설계 14절): 첫눈에는 종류 · 제목 · 짧은 사실(facts) · 주 단추 · 그다음만. 설명 문장(detail)·알림(hint)·순위 번호는 “자세히”.
 * 권한이 없는 사람용 문장(for_others)은 그 역할로 볼 때만 보인다(모두에게 회색 글로 깔지 않음).
 * 차례(turn, 4차): 작업 공간에서는 오른쪽 칸 맨 위에 차례 표시기(사람 ↔ AI, 지금 공이 어느 쪽인지) — 그 아래 주 단추가 “바로 가기”.
 */
export function NowCard({ now, context, titleId, className, extraAction, turn }: { now: NowItem; context?: string; titleId: string; className?: string; extraAction?: React.ReactNode; turn?: TurnView }) {
  const { role } = useMockSettings();
  const others = now.for_others && lacksPermission(now.kind, role) ? now.for_others : null;
  const hasMore = Boolean(now.detail || now.hint);
  return (
    <Card className={cn("gap-0 px-5 py-4", RANK_EDGE[now.kind], RANK_BG[now.kind], className)} aria-labelledby={titleId}>
      <MoreRoot>
        <div className="flex flex-col gap-3 tab:flex-row tab:items-start tab:justify-between tab:gap-6">
          <div className="min-w-0">
            <Eyebrow>
              지금 할 일{context ? ` · ${context}` : ""} · {RANK_NAME[now.kind]}
            </Eyebrow>
            <h2 id={titleId} className="text-title tracking-tight">
              {now.title}
            </h2>
            {now.facts?.length ? <p className="mt-1 text-sm text-ink-2">{now.facts.join(" · ")}</p> : null}
            {others ? (
              <p className="mt-2">
                <Chip shape="hsquare" tone="off" wrap>
                  {others}
                </Chip>
              </p>
            ) : null}
          </div>
          <div className="flex shrink-0 flex-col items-stretch gap-2 tab:max-w-[22rem] tab:items-end">
            {/* 나의 할 일의 “먼저 할 일” 한 줄은 이 띠의 제목이 이미 말한다 — AI·기다림일 때만 한 줄 */}
            {turn ? <TurnIndicator turn={turn} size="lg" align="end" detail={turn.side !== "you"} /> : null}
            <Button asChild variant="default">
              <Link to={now.action.href}>{now.action.label}</Link>
            </Button>
            {extraAction}
          </div>
        </div>
        {now.then.length > 0 || hasMore ? (
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line pt-2 text-meta">
            {now.then.length > 0 ? <span className="font-medium text-muted-foreground">그다음</span> : null}
            {now.then.map((t) => (
              <Link key={t.label} to={t.href}>
                {t.label}
              </Link>
            ))}
            {hasMore ? <MoreTrigger className="ml-auto" name="지금 할 일 자세히" /> : null}
          </div>
        ) : null}
        {hasMore ? (
          <MoreContent className="mt-1.5 space-y-0.5">
            {now.detail ? <p>{now.detail}</p> : null}
            {now.hint ? <p>{now.hint}</p> : null}
            <p className="text-muted-foreground">
              우선순위 {now.rank} · {RANK_NAME[now.kind]}
            </p>
          </MoreContent>
        ) : null}
      </MoreRoot>
    </Card>
  );
}

/**
 * 핵심 상태 줄 — 서로 다른 사실을 칸으로 나눈다(설계 3.2, 결정 9). 정보 밀도(14절): 첫눈에는 핵심 3~4칸,
 * 나머지 칸은 부르는 쪽이 “자세히”에 둔다. 칸을 누르면 그 사실이 있는 곳으로 간다.
 */
const STAT_COLS: Record<number, string> = { 2: "tab:grid-cols-2", 3: "tab:grid-cols-3", 4: "tab:grid-cols-4" };
/** 끝에 좁은 칸(“자세히” 단추 등)이 붙을 때 */
const STAT_COLS_TRAIL: Record<number, string> = { 2: "tab:grid-cols-[repeat(2,minmax(0,1fr))_auto]", 3: "tab:grid-cols-[repeat(3,minmax(0,1fr))_auto]", 4: "tab:grid-cols-[repeat(4,minmax(0,1fr))_auto]" };

export function StatBar({ cells, label, className, trailing }: { cells: { k: string; v: React.ReactNode; to?: string }[]; label: string; className?: string; trailing?: React.ReactNode }) {
  const body = (c: { k: string; v: React.ReactNode }) => (
    <>
      <span className="block text-caption text-muted-foreground">{c.k}</span>
      <span className="mt-0.5 block text-sm font-semibold text-ink">{c.v}</span>
    </>
  );
  return (
    <ul aria-label={label} className={cn("grid gap-px overflow-hidden rounded-xl border bg-line shadow-xs", cells.length % 2 === 0 ? "grid-cols-2" : "grid-cols-1", trailing ? STAT_COLS_TRAIL[cells.length] : STAT_COLS[cells.length], className)}>
      {cells.map((c) => (
        <li key={c.k} className="min-w-0 bg-card">
          {c.to ? (
            <Link to={c.to} className="block h-full px-4 py-2.5 no-underline hover:bg-surface-soft">
              {body(c)}
            </Link>
          ) : (
            <div className="h-full px-4 py-2.5">{body(c)}</div>
          )}
        </li>
      ))}
      {trailing ? <li className="col-span-full flex items-center justify-end bg-card px-2 py-1 tab:col-span-1 tab:px-3">{trailing}</li> : null}
    </ul>
  );
}

/* ───────────── 공통 화면 상태(설계 3.6) ───────────── */

export function EmptyState({ title, body, action, eyebrow }: { title: string; body: string; action?: React.ReactNode; eyebrow?: string }) {
  return (
    <div className="rounded-xl border bg-card p-5 shadow-xs">
      {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : null}
      <h3 className="text-title">{title}</h3>
      <p className="mt-1.5 text-meta text-ink-2">{body}</p>
      {action ? <div className="mt-2.5 flex flex-wrap gap-2">{action}</div> : null}
    </div>
  );
}

export function LoadError({ what, lastReceived, code, onRetry }: { what: string; lastReceived: string; code: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="rounded-xl border border-bad-line bg-bad-soft p-4 text-meta">
      <p>
        <Chip shape="square" tone="bad">
          불러오지 못함
        </Chip>{" "}
        <strong>{what}</strong>
      </p>
      <p className="mt-1 text-ink-2">
        다른 영역은 그대로 쓸 수 있습니다. 마지막으로 받은 시각 {lastReceived} · 오류 번호 {code}. 입력 중인 초안은 지우지 않습니다.
      </p>
      {onRetry ? (
        <Button size="sm" className="mt-2" onClick={onRetry}>
          <RotateCcwIcon aria-hidden="true" />
          다시 시도
        </Button>
      ) : null}
    </div>
  );
}

/** 끊김 띠(설계 3.6) — 보내기는 “보내지 못함”, 자동 재전송 없음 */
export function OfflineBanner({ className }: { className?: string }) {
  return (
    <p role="status" className={cn("flex items-center gap-2 rounded-lg bg-foreground px-3 py-2 text-meta font-medium text-background", className)}>
      <WifiOffIcon className="size-4" aria-hidden="true" />
      연결 끊김 — 다시 연결 중. 입력은 이 탭에 남아 있습니다. 끊긴 동안 보낸 것은 자동으로 다시 보내지 않습니다.
    </p>
  );
}

/** 처음 불러오는 동안: 뼈대 깜박임 대신 조용한 한 줄(0.3초 넘을 때만) */
export function QuietLoading({ what }: { what: string }) {
  const [show, setShow] = React.useState(false);
  React.useEffect(() => {
    const t = window.setTimeout(() => setShow(true), 300);
    return () => window.clearTimeout(t);
  }, []);
  if (!show) return <div aria-busy="true" />;
  return (
    <p role="status" aria-busy="true" className="rounded-lg border bg-card px-3 py-2 text-meta text-ink-2">
      {what} 불러오는 중… 첫 표시는 서버가 계산한 읽기 묶음 하나로 그립니다.
    </p>
  );
}

export function Callout({ tone = "info", children, className, role }: { tone?: "info" | "ok" | "warn" | "bad" | "off"; children: React.ReactNode; className?: string; role?: string }) {
  const toneCls = {
    info: "border-line bg-surface",
    ok: "border-ok-line bg-ok-soft",
    warn: "border-warn-line bg-warn-soft",
    bad: "border-bad-line bg-bad-soft",
    off: "border-line bg-surface-soft",
  }[tone];
  // shadcn Alert 위에 PES 색을 입힌다. 기본 role은 note(조용함) — 알려야 할 때만 부르는 쪽이 status/alert를 준다.
  return (
    <Alert role={role ?? "note"} className={cn("block rounded-lg border px-3 py-2.5 text-meta text-ink [&_strong]:text-ink", toneCls, className)}>
      {children}
    </Alert>
  );
}
