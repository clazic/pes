import * as React from "react";
import { Link } from "react-router";
import { Badge } from "@/components/ui/badge";
import type { Citation, Mode } from "@/api/types";
import { cn } from "@/lib/utils";

/** 방식 배지 — A: 웹에서 바로(PES가 등록된 AI 연결을 부름), B: 내 컴퓨터 AI */
export function ModeBadge({ mode, detail, className }: { mode: Mode; detail?: string; className?: string }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "h-auto rounded-md border px-2 py-px text-xs leading-[1.6] font-medium",
        mode === "A" ? "border-mode-a-line bg-mode-a-soft text-mode-a" : "border-mode-b-line bg-mode-b-soft text-mode-b",
        className,
      )}
    >
      {mode === "A" ? "방식 A" : "방식 B"}
      {detail ? ` · ${detail}` : ""}
    </Badge>
  );
}

type TagTone = "plain" | "acc" | "warn" | "bad" | "ok";
const TAG: Record<TagTone, string> = {
  plain: "border-border bg-surface-soft text-ink-2",
  acc: "border-primary-line bg-primary-soft text-primary-ink",
  warn: "border-warn-line bg-warn-soft text-warn",
  bad: "border-bad-line bg-bad-soft text-bad",
  ok: "border-ok-line bg-ok-soft text-ok",
};

/** 작은 꼬리표(필수·중요도·판 등). 상태 색은 상태에만 쓰므로 “필수”는 파랑(acc)으로 쓴다(설계 3.4). */
export function Tag({ children, tone = "plain", className }: { children: React.ReactNode; tone?: TagTone; className?: string }) {
  return (
    <Badge variant="outline" className={cn("h-auto rounded-md px-1.5 py-0 text-caption leading-[1.7] font-medium", TAG[tone], className)}>
      {children}
    </Badge>
  );
}

export function Eyebrow({ children, className }: { children: React.ReactNode; className?: string }) {
  return <p className={cn("mb-1 text-caption font-medium text-muted-foreground", className)}>{children}</p>;
}

export function Hint({ children, className, id }: { children: React.ReactNode; className?: string; id?: string }) {
  return (
    <p id={id} className={cn("text-caption text-muted-foreground", className)}>
      {children}
    </p>
  );
}

/** 시안 주석(제품 화면이 아님) — 점선 상자 */
export function Anno({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div data-mock="note" className={cn("mt-2.5 rounded-lg border border-dashed border-line-strong bg-muted/40 px-3 py-2 text-caption leading-relaxed text-ink-2", className)}>
      <span className="mr-1.5 inline-block rounded bg-off-soft px-1.5 align-[1px] text-caption font-semibold text-off">시안 설명</span>
      {children}
    </div>
  );
}

export function KV({ items, className }: { items: [React.ReactNode, React.ReactNode][]; className?: string }) {
  return (
    <dl className={cn("grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-meta", className)}>
      {items.map(([k, v], i) => (
        <React.Fragment key={i}>
          <dt className="font-medium text-muted-foreground">{k}</dt>
          <dd className="m-0 min-w-0">{v}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

/**
 * 쪽 머리(h1)와 묶음 제목(h2) — shadcn 대시보드처럼 제목 아래에 설명, 오른쪽에 동작.
 * h1: 22px 600 · h2: 17px 600. 설명은 보조 글자.
 */
export function SectionTitle({ title, sub, id, as: As = "h2", right, className, aside }: { title: React.ReactNode; sub?: React.ReactNode; id?: string; as?: "h1" | "h2"; right?: React.ReactNode; className?: string; aside?: React.ReactNode }) {
  const h1 = As === "h1";
  const heading = (
    <As id={id} className={h1 ? "text-page tracking-tight" : "text-title"}>
      {title}
    </As>
  );
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-x-4 gap-y-2", h1 ? "mb-5" : "mt-8 mb-3", className)}>
      <div className="min-w-0 flex-1">
        {aside ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {heading}
            {aside}
          </div>
        ) : (
          heading
        )}
        {sub ? <p className={cn("mt-1 text-muted-foreground", h1 ? "text-sm" : "text-meta")}>{sub}</p> : null}
      </div>
      {right ? <div className="flex flex-wrap items-center gap-2">{right}</div> : null}
    </div>
  );
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-sm border bg-muted px-1 font-sans text-caption leading-none font-medium text-muted-foreground">
      {children}
    </kbd>
  );
}

/**
 * 카드 머리: 왼쪽(작은 머리말·제목·설명) + 오른쪽(상태·단추).
 * aside = 제목 바로 옆에 붙는 ⓘ 설명 같은 것 — 제목(h) 밖에 두어 제목 이름·aria-labelledby에 섞이지 않게 한다.
 */
export function CardHead({ eyebrow, title, titleId, meta, right, as: As = "h2", size, aside }: { eyebrow?: React.ReactNode; title: React.ReactNode; titleId?: string; meta?: React.ReactNode; right?: React.ReactNode; as?: "h2" | "h3"; size?: "lg"; aside?: React.ReactNode }) {
  const heading = (
    <As id={titleId} className={size === "lg" ? "text-page tracking-tight" : As === "h2" ? "text-title" : "text-body"}>
      {title}
    </As>
  );
  return (
    <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : null}
        {aside ? (
          <div className="flex flex-wrap items-center gap-1">
            {heading}
            {aside}
          </div>
        ) : (
          heading
        )}
        {meta ? <div className="mt-1 text-caption text-muted-foreground">{meta}</div> : null}
      </div>
      {right ? <div className="flex flex-wrap items-center gap-2">{right}</div> : null}
    </div>
  );
}

const CITE: Record<Citation["kind"], string> = {
  source: "border-line-strong bg-surface-soft text-ink-2",
  file: "border-ok-line bg-ok-soft text-ok",
  ref: "border-mode-b-line bg-mode-b-soft text-mode-b",
  before_off: "border-warn-line bg-warn-soft text-warn",
};
const CITE_PREFIX: Record<Citation["kind"], string> = { source: "출처", file: "자료", ref: "참고", before_off: "자료" };

/** 인용 칩 3종(출처 · 자료 · 참고) + 끄기 전에 쓰인 근거(주의) — 설계 4.7 */
export function Cite({ c }: { c: Citation }) {
  return (
    <Link
      to={c.href}
      className={cn(
        "mx-0.5 inline rounded-md border px-1.5 text-xs leading-[1.9] font-medium no-underline [box-decoration-break:clone] hover:border-primary hover:text-primary-ink",
        CITE[c.kind],
      )}
    >
      <span className="sr-only">{CITE_PREFIX[c.kind]} 인용: </span>
      {c.kind === "source" ? c.label : `${CITE_PREFIX[c.kind]} · ${c.label}`}
    </Link>
  );
}

/** 표를 감싸는 카드 안 제목(caption과 같은 모양) */
export function BlockTitle({ children, id, className }: { children: React.ReactNode; id?: string; className?: string }) {
  return (
    <h3 id={id} className={cn("mb-2 text-sm font-semibold", className)}>
      {children}
    </h3>
  );
}
