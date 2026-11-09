import * as React from "react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * 요약 카드 — shadcn dashboard-01 블록의 SectionCards 모양(이름 · 큰 수 · 오른쪽 배지 · 아래 두 줄)을 PES 말로.
 * 큰 수는 비례 숫자(tabular-nums 쓰지 않음). 색은 배지(상태 칩: 모양+글자)만 쓰고 숫자는 글자 색 그대로.
 * 4장이 한 줄(본문 폭 1024px 이상) · 2장(576px 이상) · 1장.
 */
export function StatCard({
  id,
  label,
  value,
  unit,
  badge,
  lead,
  sub,
  footer,
  className,
  labelAside,
}: {
  id: string;
  label: React.ReactNode;
  /** 이름 옆 ⓘ 설명 — 제목(h3) 밖에 둔다 */
  labelAside?: React.ReactNode;
  value: React.ReactNode;
  unit?: string;
  badge?: React.ReactNode;
  lead?: React.ReactNode;
  sub?: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}) {
  return (
    <Card aria-labelledby={id} className={cn("@container/card gap-0 bg-linear-to-t from-primary/5 to-card py-0 dark:bg-card dark:bg-none", className)}>
      <div className="px-4 pt-3.5 @[15rem]/card:px-5 @[15rem]/card:pt-4">
        <div className="flex flex-wrap items-start justify-between gap-x-2 gap-y-1">
          <div className="flex min-w-0 items-center gap-1">
            <h3 id={id} className="min-w-0 text-meta font-normal text-muted-foreground">
              {label}
            </h3>
            {labelAside}
          </div>
          {badge ? <div className="flex shrink-0 flex-col items-end gap-1">{badge}</div> : null}
        </div>
        <p className="mt-2 text-[19px] leading-none font-semibold tracking-tight whitespace-nowrap @[15rem]/card:text-[23px]">
          {value}
          {unit ? <span className="ml-1 text-sm font-medium text-muted-foreground">{unit}</span> : null}
        </p>
      </div>
      <div className="mt-auto flex flex-col items-start gap-1 px-4 pt-2.5 pb-3.5 text-meta @[15rem]/card:px-5 @[15rem]/card:pt-3 @[15rem]/card:pb-4">
        {lead ? <div className="font-medium">{lead}</div> : null}
        {sub ? <div className="text-muted-foreground">{sub}</div> : null}
        {footer}
      </div>
    </Card>
  );
}

/**
 * 요약 카드 줄(본문 컨테이너 폭 기준). dense = 휴대폰에서도 두 장씩(숫자만 있는 요약 카드 — 첫 화면을 다 차지하지 않게)
 * headed = 쪽 제목(h1) 바로 아래에 올 때 화면 읽기용 h2를 둔다 — 카드 이름(h3)이 h1 다음에 바로 오지 않게(제목 단계 건너뛰기 없음, 6차)
 */
export function StatRow({ label, children, className, dense, headed }: { label: string; children: React.ReactNode; className?: string; dense?: boolean; headed?: boolean }) {
  const hid = React.useId();
  return (
    <section aria-label={headed ? undefined : label} aria-labelledby={headed ? hid : undefined} className={cn("grid gap-4 @5xl/main:grid-cols-4", dense ? "grid-cols-2 gap-3 @xl/main:gap-4" : "grid-cols-1 @xl/main:grid-cols-2", className)}>
      {headed ? (
        <h2 id={hid} className="sr-only">
          {label}
        </h2>
      ) : null}
      {children}
    </section>
  );
}
