import { ChevronDownIcon } from "lucide-react";
import { CartesianGrid, ComposedChart, Area, Line, ReferenceDot, ReferenceLine, XAxis, YAxis } from "recharts";
import type { UsageView } from "@/api/types";
import { Card } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CardHead, Tag } from "@/components/pes/bits";

type Trend = UsageView["trend"];
type Point = Trend["points"][number] & { m: number };

const toMin = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

// 한 계열(추정)과 그 계열의 예상 구간 — 색은 테마 강조 글자색 하나. 예상은 점선으로만 다르게(색으로 나누지 않음).
const config = {
  est: { label: "추정", color: "var(--primary-ink)" },
  proj: { label: "예상", color: "var(--primary-ink)" },
} satisfies ChartConfig;

function TrendTooltip({ active, payload }: { active?: boolean; payload?: { payload: Point }[] }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  const v = p.est ?? p.proj;
  const kind = p.est != null ? "추정" : "예상";
  return (
    <div className="grid max-w-[240px] gap-1 rounded-lg border bg-popover px-2.5 py-2 text-xs text-popover-foreground shadow-lg">
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-semibold tabular-nums">{v}%</span>
        <span className="text-muted-foreground">
          {kind} · {p.t}
        </span>
      </div>
      {p.note ? <div className="leading-snug text-ink-2">{p.note}</div> : null}
    </div>
  );
}

/**
 * API 사용량 추이 — dashboard-01의 차트 카드 자리. 화면에 차트는 이것 하나.
 * 시간 축은 실제 분(分) 간격(15:51 → 15:52 한 칸이 15분처럼 늘어나지 않게). 격자는 실선 실선 한 줄, 문턱만 점선 + 글.
 * 화면 읽기: 그림 전체를 요약한 이름(role=img) + 같은 숫자의 표(“표로 보기”). 툴팁은 숫자를 먼저, 이름을 뒤에.
 */
export function UsageTrendChart({ trend }: { trend: Trend }) {
  const pts: Point[] = trend.points.map((p) => ({ ...p, m: toMin(p.t) }));
  const first = pts[0];
  const stop = pts.find((p) => p.est != null && p.est >= trend.stop_percent)!;
  const now = pts.find((p) => p.est != null && p.proj != null)!;
  const last = pts[pts.length - 1];
  const t0 = pts.find((p) => p.note?.includes("t0"));
  const min = first.m;
  const max = last.m;
  const ticks: number[] = [];
  for (let m = Math.ceil(min / 30) * 30; m <= max; m += 30) ticks.push(m);
  const summary = `${trend.connection} 5시간 구간 추정 사용률 추이(합성 예시). ${first.t} ${first.est}%${t0 ? `, ${t0.t} 콘솔 기준값 입력으로 ${t0.est}%에 맞춤` : ""}, ${stop.t} ${stop.est}%로 멈춤 문턱 ${trend.stop_percent}% 이상이 되어 보내기 전에 멈춤. 지금 ${now.t} ${now.est}%, 재개 가능 시각 ${last.t}에 ${last.proj}% 예상. 같은 숫자를 아래 표로 볼 수 있습니다.`;

  return (
    <Card className="mt-6 gap-0 px-5" aria-labelledby="trend-t" id="trend">
      <CardHead
        eyebrow={`사용량 추이 · ${trend.connection}`}
        title="5시간 구간 추정 사용률 · 오늘"
        titleId="trend-t"
        right={
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground" aria-hidden="true">
            <span className="inline-flex items-center gap-1.5">
              <svg width="18" height="6" className="text-primary-ink">
                <line x1="0" y1="3" x2="18" y2="3" stroke="currentColor" strokeWidth="2" />
              </svg>
              추정
            </span>
            <span className="inline-flex items-center gap-1.5">
              <svg width="18" height="6" className="text-primary-ink">
                <line x1="0" y1="3" x2="18" y2="3" stroke="currentColor" strokeWidth="2" strokeDasharray="4 3" />
              </svg>
              예상
            </span>
            <span className="inline-flex items-center gap-1.5">
              <svg width="18" height="6" className="text-foreground">
                <line x1="0" y1="3" x2="18" y2="3" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2 2" />
              </svg>
              멈춤 문턱 {trend.stop_percent}%
            </span>
            <span data-mock="note">
              <Tag>합성 예시</Tag>
            </span>
          </div>
        }
      />
      <figure role="img" aria-label={summary} className="m-0">
        <ChartContainer config={config} className="aspect-auto h-[260px] w-full">
          <ComposedChart data={pts} margin={{ top: 26, right: 12, left: 4, bottom: 0 }} accessibilityLayer={false}>
            <defs>
              <linearGradient id="fill-est" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--color-est)" stopOpacity={0.14} />
                <stop offset="100%" stopColor="var(--color-est)" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} stroke="var(--border)" />
            <XAxis dataKey="m" type="number" domain={[min, max]} ticks={ticks} tickFormatter={hhmm} tickLine={false} axisLine={false} tickMargin={8} />
            <YAxis domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tickFormatter={(v: number) => `${v}%`} tickLine={false} axisLine={false} width={40} />
            <ReferenceLine
              y={trend.stop_percent}
              stroke="var(--foreground)"
              strokeOpacity={0.7}
              strokeDasharray="3 3"
              label={{ value: `멈춤 문턱 ${trend.stop_percent}%`, position: "insideTopLeft", fill: "var(--muted-foreground)", fontSize: 12, dy: -16 }}
            />
            <ChartTooltip cursor={{ stroke: "var(--muted-foreground)", strokeWidth: 1 }} content={<TrendTooltip />} />
            <Area dataKey="est" type="linear" stroke="var(--color-est)" strokeWidth={2} fill="url(#fill-est)" dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--card)", fill: "var(--color-est)" }} isAnimationActive={false} connectNulls={false} />
            <Line dataKey="proj" type="linear" stroke="var(--color-proj)" strokeWidth={2} strokeDasharray="5 4" dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--card)", fill: "var(--color-proj)" }} isAnimationActive={false} connectNulls={false} />
            <ReferenceDot
              x={stop.m}
              y={stop.est}
              r={4}
              fill="var(--color-est)"
              stroke="var(--card)"
              strokeWidth={2}
              label={{ value: `${stop.t} 멈춤 ${stop.est}%`, position: "top", fill: "var(--foreground)", fontSize: 12, fontWeight: 600 }}
            />
            <ReferenceDot
              x={last.m}
              y={last.proj}
              r={4}
              fill="var(--card)"
              stroke="var(--color-proj)"
              strokeWidth={2}
              label={{ value: `${last.t} ${last.proj}% 예상`, position: "bottom", textAnchor: "end", dx: 6, dy: 4, fill: "var(--foreground)", fontSize: 12 }}
            />
          </ComposedChart>
        </ChartContainer>
      </figure>
      <Collapsible className="mt-2 border-t border-line pt-2">
        <CollapsibleTrigger className="group inline-flex min-h-8 items-center gap-1.5 text-[13px] font-semibold">
          <ChevronDownIcon className="size-4 transition-transform group-data-[state=open]:rotate-180" aria-hidden="true" />
          표로 보기 — 그래프와 같은 숫자
        </CollapsibleTrigger>
        <CollapsibleContent>
          <Table regionLabel="5시간 구간 추정 사용률 추이 표" containerClassName="mt-2" className="min-w-[560px]">
            <TableCaption className="sr-only">5시간 구간 추정 사용률 추이 — {trend.connection}</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col" className="w-[80px]">시각</TableHead>
                <TableHead scope="col" className="w-[90px] text-right">추정</TableHead>
                <TableHead scope="col" className="w-[90px] text-right">예상</TableHead>
                <TableHead scope="col">무슨 일</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pts.map((p) => (
                <TableRow key={p.t}>
                  <TableHead scope="row" className="tabular-nums">{p.t}</TableHead>
                  <TableCell className="text-right tabular-nums">{p.est != null ? `${p.est}%` : "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{p.proj != null ? `${p.proj}%` : "—"}</TableCell>
                  <TableCell>{p.note ?? ""}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
