import * as React from "react";
import { Link } from "react-router";
import { PesApiError, type Actor, type Link as SourceRef } from "@/api/types";
import { Button } from "@/components/ui/button";
import { formatAt } from "@/lib/labels";
import { cn } from "@/lib/utils";

/** 표 모양 — 기존 토큰만. 칸이 좁으면 표 안에서 옆으로 민다(문서 전체는 넘치지 않음) */
export const tableClass = "w-full min-w-[42rem] border-collapse text-meta";
export const thClass = "border-b border-line-strong px-3 py-2 text-left align-bottom text-caption font-medium text-muted-foreground";
export const tdClass = "border-b border-line px-3 py-3 align-top";
export const noteClass = "text-caption text-ink-2";

/** 표를 감싸는 가로 스크롤 칸 — 키보드로도 밀 수 있게 초점을 받는다 */
export function TableScroll({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex
    <div role="group" data-table-scroll="" aria-label={`${label} 표 — 옆으로 밀어 볼 수 있어요`} tabIndex={0} className="overflow-x-auto rounded-md outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
      {children}
    </div>
  );
}

export function ActorName({ actor }: { actor: Actor }) {
  return (
    <span>
      {actor.name}
      {actor.kind === "ai" ? <span className="text-ink-2"> (AI)</span> : null}
    </span>
  );
}

/** 같은 사이트 안 주소만 링크로 그린다 — `/`로 시작하고 `//`(다른 사이트) · `/\\` · 공백이 없는 것 */
export const isSafeHref = (href: string): boolean => /^\/(?![/\\])\S*$/.test(href);

/** 근거 링크 — 앱 안 주소(/p/…)는 라우터 링크, 보고서 · 산출물(/<slug>/reports · out)은 같은 탭 평범한 링크. 안전하지 않은 주소는 글자만 */
export function SourceLink({ link, className }: { link: SourceRef; className?: string }) {
  const cls = cn("text-primary-ink underline underline-offset-2 hover:decoration-2", className);
  if (!isSafeHref(link.href)) return <span className={className}>{link.label}</span>;
  return link.href.startsWith("/p/") ? (
    <Link to={link.href} className={cls}>
      {link.label}
    </Link>
  ) : (
    <a href={link.href} className={cls}>
      {link.label}
    </a>
  );
}

export function When({ at }: { at: string | null }) {
  return at ? (
    <time dateTime={at} className={noteClass}>
      {formatAt(at)}
    </time>
  ) : null;
}

/** 읽기 실패 말 — 서버가 아직 못 주는 것(not_supported)과 일시 실패를 가른다. 기록 없음이라고 하지 않는다 */
export function readFailureText(error: unknown): string {
  if (isNotSupported(error)) return "아직 서버에서 읽을 수 없어요.";
  return "불러오지 못했어요.";
}

/** 자료가 오기 전 자리 — 글자 없이 모양만(화면 읽기에는 aria-busy 가 맡는다) */
export function Skeleton() {
  return (
    <div aria-hidden="true" className="mt-3 space-y-2">
      <div className="h-4 w-2/3 animate-pulse rounded bg-surface-sunk" />
      <div className="h-4 w-1/2 animate-pulse rounded bg-surface-sunk" />
    </div>
  );
}

/** 서버가 아직 못 주는 것 — 고장이 아니다. 다시 읽어도 같으니 재시도 단추도 없다 */
export const isNotSupported = (error: unknown): boolean => error instanceof PesApiError && error.body.error.code === "not_supported";

export function ReadFailure({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  if (isNotSupported(error)) {
    return (
      <p data-read-state="not-supported" className="mt-3 rounded-md border border-dashed border-control bg-surface px-3 py-2 text-meta text-ink-2">
        {readFailureText(error)}
      </p>
    );
  }
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
      <p className="text-meta font-medium text-bad">{readFailureText(error)}</p>
      <div data-print="hide">
        <Button variant="outline" size="sm" onClick={onRetry}>
          다시 읽기
        </Button>
      </div>
    </div>
  );
}

export function EmptyNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-3 rounded-md border border-dashed border-control bg-surface px-3 py-3">
      <p className="text-meta font-medium text-ink">기록 없음</p>
      <p className="mt-0.5 text-caption text-ink-2">{children}</p>
    </div>
  );
}
