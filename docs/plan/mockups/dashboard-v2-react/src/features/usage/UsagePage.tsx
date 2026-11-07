import * as React from "react";
import { Link, useLocation } from "react-router";
import { ChevronDownIcon, PlusIcon } from "lucide-react";
import { useCommand, useUsage } from "@/api/queries";
import type { AiConnection, UsageView, UsageWindow } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Anno, CardHead, Hint, KV, ModeBadge, SectionTitle, Tag } from "@/components/pes/bits";
import { FoldCard, InfoTip, More, MoreList } from "@/components/pes/disclosure";
import { Callout, LoadError, NowCard, QuietLoading } from "@/components/pes/blocks";
import { ActionButton, Meter, meterLevel } from "@/components/pes/controls";
import { Chip, Status, StatusFrom } from "@/components/pes/status";
import { STATUS } from "@/components/pes/status-registry";
import { BILLING_LABEL, KIND_LABEL, STORAGE_LABEL, won } from "@/mocks/connections";
import { useMockSettings } from "@/lib/mock-settings";
import { cn } from "@/lib/utils";
import { StatCard, StatRow } from "@/components/pes/stat-card";
import { AddConnectionDialog } from "./AddConnectionDialog";
// 차트(recharts)는 이 화면에서만 쓰고, 그중에서도 따로 불러온다 — 사용량 숫자·계기는 차트 묶음을 기다리지 않고 먼저 그린다.
const UsageTrendChart = React.lazy(() => import("./UsageTrendChart").then((m) => ({ default: m.UsageTrendChart })));

const WIN_LABEL: Record<UsageWindow["key"], string> = { h5: "5시간 구간", week: "주간", month: "월간" };
const MANAGER_WHY = "AI 연결 관리자(김연구)만 할 수 있습니다. 프로젝트 소유자라는 이유만으로 연결 전체 기록을 바꾸지 않습니다(Codex F04).";

const RESET_LABEL = (w: UsageWindow) => (w.key === "h5" ? "재개 가능" : "다시 채워짐");

/** 계기 카드 — 정보 밀도(14절): 이름 · 큰 수 · 상태 · 막대 + 한 줄(재개 시각). t0·증분·예약은 “구간별 근거” 표에 */
function Gauge({ w, stop }: { w: UsageWindow; stop: number }) {
  const lv = meterLevel(w.estimated_percent, stop);
  return (
    <StatCard
      id={`g-${w.key}`}
      label={
        <>
          {WIN_LABEL[w.key]} · <Tag>추정</Tag>
        </>
      }
      value={`${w.estimated_percent}%`}
      badge={<Status of="meter" value={lv} />}
      footer={
        <div className="w-full">
          <Meter percent={w.estimated_percent} threshold={stop} label={`${WIN_LABEL[w.key]} 추정 사용률 ${w.estimated_percent}%, 멈춤 문턱 ${stop}%. 콘솔 기준값 ${w.t0_console ?? "없음"}%, t0 이후 PES 증분 ${w.pes_since_t0}%p, 예약 ${w.reserved}%p`} className="mt-1" />
          <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12.5px] text-ink-2">
            <span className="text-muted-foreground">{RESET_LABEL(w)}</span>
            {w.resets.at ? <span className="font-medium text-ink">{w.resets.at}</span> : null}
            <StatusFrom s={{ domain: "resetBasis", value: w.resets.basis === "human" ? "estimate" : w.resets.basis, label: w.resets.basis === "human" ? "사람이 입력" : undefined }} />
          </p>
        </div>
      }
    />
  );
}

/** 쓴 만큼 과금 연결의 요약 카드(자세한 근거는 아래 AI 연결 카드의 “비용 근거”) */
function MeteredSummary({ c }: { c: AiConnection }) {
  const m = c.metered!;
  const pct = m.cap ? Math.round((m.spent_estimate.amount / m.cap.amount) * 100) : 0;
  return (
    <StatCard
      id={`ms-${c.id}`}
      label={
        <>
          {c.name} · 이번 달 · <Tag>추정</Tag>
        </>
      }
      value={won(m.spent_estimate.amount)}
      badge={<Status of="costCap" value={m.state} />}
      footer={
        <div className="w-full">
          <Meter percent={pct} label={`이번 달 추정 비용 ${won(m.spent_estimate.amount)}, 월 비용 상한 ${m.cap ? won(m.cap.amount) : "없음"}, ${pct}%`} compact className="mt-1 mb-2" />
          <p className="text-[12.5px] text-ink-2">{m.cap ? `상한 ${won(m.cap.amount)} 중 ${pct}%` : "비용 상한 없음 — 시작하지 않음"}</p>
        </div>
      }
    />
  );
}

/** AI 연결 카드 — 첫눈에는 상태 · 주소 · 한도 · 모델 3줄. 키·저장 위치·관리자·쓰는 프로젝트·비용 근거는 “자세히” */
function ConnectionCard({ c, manager }: { c: AiConnection; manager: boolean }) {
  const test = useCommand("ai_connection.test", { successText: () => "연결 시험 통과" });
  const m = c.metered;
  return (
    <Card id={`cn-${c.id}-card`} className="gap-0 px-5" aria-labelledby={`cn-${c.id}`}>
      <CardHead eyebrow={`${KIND_LABEL[c.kind]} · ${BILLING_LABEL[c.billing]}`} title={c.name} titleId={`cn-${c.id}`} right={<StatusFrom s={{ domain: "connTest", value: c.test.state }} />} />
      <KV
        items={[
          ["주소", <code key="e" className="text-xs break-all">{c.endpoint}</code>],
          ["한도", c.billing === "metered" ? (m?.cap ? `월 비용 상한 ${won(m.cap.amount)}` : "비용 상한 없음 — 시작 못 함") : `멈춤 문턱 ${c.subscription?.stop_percent}%`],
          ["모델", `${c.models.filter((x) => x.available).length}개 사용 가능`],
        ]}
      />
      <div className="mt-2.5 flex flex-wrap gap-2">
        <ActionButton size="sm" blockedBy={manager ? null : MANAGER_WHY} onClick={() => test.run({ kind: c.kind, endpoint: c.endpoint, key_present: true, key_length: 12 })}>
          연결 시험
        </ActionButton>
        <ActionButton size="sm" blockedBy={manager ? null : MANAGER_WHY}>
          키 바꾸기
        </ActionButton>
        <ActionButton size="sm" blockedBy={manager ? null : MANAGER_WHY}>
          한도 바꾸기
        </ActionButton>
      </div>
      <More className="mt-2" label={m ? "자세히 · 비용 근거" : "자세히"} name={`${c.name} 자세히${m ? " · 비용 근거" : ""}`}>
        <MoreList
          items={[
            ["API 키", `끝 4자리 …${c.key.last4} · ${c.key.set_by} ${c.key.set_at} · 다시 보이지 않음`],
            ["키 저장 위치", STORAGE_LABEL[c.key.storage]],
            ["모델 목록", c.models_source === "loaded" ? `불러옴 ${c.models_listed_at}` : "직접 입력"],
            ["관리자", manager ? c.owner : `${c.owner} · 등록·변경·정산은 관리자만`],
            ["쓰는 프로젝트", manager ? (c.used_by.length ? c.used_by.join(", ") : "아직 없음") : `${c.used_by.length}개(내 프로젝트 밖은 이름 비공개)`],
            ...(m
              ? ([
                  ["이번 달 비용", `${won(m.spent_estimate.amount)} · 추정 · ${m.spent_estimate.as_of} 기준`],
                  ["월 비용 상한", m.cap ? `${won(m.cap.amount)} · ${m.cap.set_by} ${m.cap.set_at}` : "없음 — 실행을 시작하지 않음"],
                  ["계산", "PES가 센 토큰 × 모델 단가"],
                  ["단가 근거", c.models.map((x) => `${x.id}: ${x.price?.text ?? "모름"}`).join(" / ")],
                  ["멈춤", "다음 호출의 예약을 더하면 상한을 넘을 때 보내기 전에 멈춤"],
                  ["주의", "PES는 제공사 과금을 막을 수 없습니다. 콘솔에서도 한도를 걸고, 이 키는 PES 전용으로 만드세요."],
                ] as [string, string][])
              : []),
          ]}
        />
      </More>
    </Card>
  );
}

function SettleDialog({ id, open, onOpenChange, hint }: { id: string; open: boolean; onOpenChange: (o: boolean) => void; hint: string }) {
  const [outcome, setOutcome] = React.useState<"processed" | "not_processed" | "unverifiable" | "">("");
  const [evidence, setEvidence] = React.useState("");
  const [reason, setReason] = React.useState("");
  const settle = useCommand("dispatch.settle");
  const opts = [
    { v: "processed", t: "처리됨으로 정리", h: "콘솔에서 그 시각 요청·사용을 확인함 → 예약을 사용으로 확정" },
    { v: "not_processed", t: "처리 안 됨으로 정리", h: "콘솔 기록에서 그 요청이 없음을 확인함 → 예약 해제" },
    { v: "unverifiable", t: "확인 불가 — 그대로 둠", h: "확인할 수 없음 → 예약·차단을 그대로 둠(기록만 남김)" },
  ] as const;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>확인 안 된 호출 정리</DialogTitle>
          <DialogDescription>{hint} PES는 같은 호출을 자동으로 다시 하지 않습니다. 정리한 사람·시각·근거·이유·예약 처리는 지울 수 없는 기록으로 남고 같은 tx에서 바뀝니다.</DialogDescription>
        </DialogHeader>
        <RadioGroup value={outcome} onValueChange={(v) => setOutcome(v as typeof outcome)} className="gap-1.5" aria-label="정리 결과">
          {opts.map((o) => (
            <label key={o.v} htmlFor={`st-${o.v}`} className={cn("flex cursor-pointer items-start gap-2 rounded-lg border px-2.5 py-2", outcome === o.v ? "border-primary bg-primary-soft" : "border-line")}>
              <RadioGroupItem id={`st-${o.v}`} value={o.v} className="mt-1" />
              <span>
                <strong className="text-[13.5px]">{o.t}</strong>
                <span className="block text-[12.5px] text-muted-foreground">{o.h}</span>
              </span>
            </label>
          ))}
        </RadioGroup>
        <div>
          <Label htmlFor="st-ev" className="text-[13px] font-semibold">
            근거 <span className="font-medium text-bad">필수</span>
          </Label>
          <Input id="st-ev" className="mt-1" placeholder="예: 콘솔 사용 내역 15:51 요청 없음(상관키 일치 없음)" value={evidence} onChange={(e) => setEvidence(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="st-why" className="text-[13px] font-semibold">
            이유 <span className="font-medium text-bad">필수</span>
          </Label>
          <Input id="st-why" className="mt-1" value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        {settle.phase === "done" ? <Callout tone="ok" role="status"><Chip shape="circle" tone="ok">정리됨</Chip> 접수 번호 {settle.receipt?.receipt_no}</Callout> : null}
        {settle.error ? <Callout tone="bad" role="alert">{settle.error.message}</Callout> : null}
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>{settle.phase === "done" ? "닫기" : "취소"}</Button>
          {settle.phase !== "done" ? (
            <ActionButton variant="default" blockedBy={!outcome ? "정리 결과를 골라 주세요." : !evidence.trim() || !reason.trim() ? "근거와 이유를 적어 주세요." : settle.pending ? "접수 확인 중입니다" : null} onClick={() => outcome && settle.run({ id, outcome, evidence, reason })}>
              이대로 정리
            </ActionButton>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ExtraAndBaseline({ c, manager }: { c: AiConnection; manager: boolean }) {
  const s = c.subscription!;
  const confirm = useCommand("usage.extra_usage.confirm", { successText: (r) => `추가 요금(Extra Usage) 꺼짐 확인 기록 · 접수 번호 ${r.receipt_no}` });
  const base = useCommand("usage.baseline.set", { successText: (r) => `콘솔 기준값 저장 · 접수 번호 ${r.receipt_no}` });
  const [v, setV] = React.useState({ h5: String(s.baseline.h5 ?? ""), week: String(s.baseline.week ?? ""), month: String(s.baseline.month ?? "") });
  const [t0, setT0] = React.useState("2026-11-05T15:30");
  const [noOther, setNoOther] = React.useState(s.baseline.no_other_use_after_t0);
  const num = (x: string) => (x.trim() === "" ? null : Number(x));
  const anyMissing = [v.h5, v.week, v.month].some((x) => x.trim() === "");
  return (
    <div className="mt-5 grid grid-cols-1 items-stretch gap-3 desk:grid-cols-2">
      {s.extra_usage.applicable ? (
        <Card id="extra" className="gap-0 px-5" aria-labelledby="ex-t">
          <CardHead
            eyebrow={`방식 A 시작 전 확인 · ${c.name}`}
            title="추가 요금(Extra Usage) 꺼짐 확인"
            aside={
              <InfoTip label="추가 요금 꺼짐 확인 설명" wide>
                <p>PES는 제공사 콘솔 설정을 직접 볼 수 없습니다. 콘솔에서 추가 요금(종량제 잔액)이 꺼져 있는 것을 본 뒤 눌러 주세요. 확인이 없거나 지나면 방식 A를 시작하지 않습니다. 응답에 과금 표시가 보이면 즉시 멈춥니다.</p>
                <p className="text-muted-foreground">유효 7일은 예시값(사용자 결정 질문 1) · 범위: {c.name} 연결 1개(구독 계정 표시 이름만 저장)</p>
              </InfoTip>
            }
            titleId="ex-t"
            right={<Status of="extraUsage" value={s.extra_usage.state} />}
          />
          <p className="text-sm text-ink-2">{s.extra_usage.last ? `마지막 확인 ${s.extra_usage.last} · ${s.extra_usage.by} · ${s.extra_usage.valid_until}까지` : "확인 기록 없음"}</p>
          <div className="mt-2.5 flex flex-wrap gap-2">
            <ActionButton variant="default" blockedBy={manager ? null : MANAGER_WHY} onClick={() => confirm.run({ connection_id: c.id })}>
              콘솔에서 다시 확인함
            </ActionButton>
            <Button>확인 방법 보기</Button>
          </div>
        </Card>
      ) : null}
      <Card id="base" className="gap-0 px-5" aria-labelledby="bs-t">
        <CardHead
          eyebrow="PES가 못 보는 사용량"
          title="콘솔 기준값(t0)"
          aside={
            <InfoTip label="콘솔 기준값 설명" wide>
              <p>확인한 시각(t0)에 제공사 콘솔에서 본 계정 전체 사용률을 적습니다. 추정 = t0 값 + t0 이후 PES가 센 증분 + 예약. t0 이전 PES 사용은 이미 콘솔 값에 들어 있어 다시 더하지 않습니다.</p>
              <p className="text-muted-foreground">비어 있거나 오래되면 방식 A를 시작하지 않습니다. 모르는 값은 0으로 두지 않습니다.</p>
            </InfoTip>
          }
          titleId="bs-t"
          right={<Status of="baseline" value={s.baseline.state} label={s.baseline.t0 ? `${STATUS.baseline[s.baseline.state]!.label} · ${s.baseline.t0}` : undefined} />}
        />
        <div className="grid grid-cols-2 gap-2 tab:grid-cols-4">
          <div className="col-span-2 tab:col-span-1">
            <Label htmlFor="b-t0" className="text-[13px] font-semibold">
              확인 시각(t0)
            </Label>
            <Input id="b-t0" type="datetime-local" className="mt-1" value={t0} onChange={(e) => setT0(e.target.value)} />
          </div>
          {(["h5", "week", "month"] as const).map((k) => (
            <div key={k}>
              <Label htmlFor={`b-${k}`} className="text-[13px] font-semibold">
                {WIN_LABEL[k]} %
              </Label>
              <Input id={`b-${k}`} type="number" min={0} max={100} className="mt-1 text-right" value={v[k]} onChange={(e) => setV((p) => ({ ...p, [k]: e.target.value }))} />
            </div>
          ))}
        </div>
        <div className="mt-2 flex items-start gap-2 text-[13px]">
          <Checkbox id="b-none" checked={noOther} onCheckedChange={(x) => setNoOther(x === true)} className="mt-0.5" />
          <Label htmlFor="b-none" className="block leading-snug font-normal">
            t0 이후 이 구독을 다른 앱에서 쓰지 않음(선언)
          </Label>
          <InfoTip label="선언 설명">
            <p>과거 사용의 0 증거가 아닙니다. 0은 콘솔이 그 구간에서 0을 보여 줄 때만 적습니다. 선언이 없으면 기준값을 더 자주 묻습니다(사용자 결정 질문 1).</p>
          </InfoTip>
        </div>
        <div className="mt-2.5">
          <ActionButton blockedBy={!manager ? MANAGER_WHY : anyMissing ? "세 구간 값을 모두 적어 주세요. 모르는 값은 0으로 두지 않습니다." : null} onClick={() => base.run({ connection_id: c.id, t0: t0.replace("T", " ").slice(5), h5: num(v.h5), week: num(v.week), month: num(v.month), no_other_use_after_t0: noOther })}>
            기준값 저장
          </ActionButton>
        </div>
      </Card>
    </div>
  );
}

/** 멈춘 실행 — 첫눈에는 무엇이·언제·언제 재개 + 남은 검사만. 사유·모델·통과한 검사 전체는 “자세히” */
function Blocked({ u, manager }: { u: UsageView; manager: boolean }) {
  const b = u.blocked!;
  const resume = useCommand("run.resume", { successText: (r) => `계속 접수됨 · 접수 번호 ${r.receipt_no} — 실행기가 새 담당을 잡습니다` });
  const all = b.checks.every((c) => c.pass);
  const passed = b.checks.filter((c) => c.pass).length;
  const left = b.checks.filter((c) => !c.pass);
  const settings = useMockSettings();
  const owner = settings.role === "owner";
  const why = !owner ? "계속은 이 프로젝트의 소유자만 누를 수 있습니다." : !all ? "재개 준비 검사를 모두 통과해야 켜집니다." : null;
  return (
    <Card id="blocked" className="mt-5 gap-0 px-5" aria-labelledby="bl-t">
      <CardHead eyebrow="멈춘 실행" title={`${b.project} · ${b.where} · 실행 ${b.run}`} titleId="bl-t" right={<Status of="run" value="blocked_usage" label="실행 멈춤 · 사용량 문턱" />} />
      <KV
        items={[
          ["멈춘 시각", b.stopped.split(" · ")[0]],
          ["재개 가능", b.reset],
        ]}
      />
      <div className="mt-3">
        <h3 className="text-sm">
          재개 준비 검사 <span className="font-normal text-muted-foreground">· 통과 {passed} / {b.checks.length}</span>
        </h3>
        {left.length ? (
          <ul className="mt-1">
            {left.map((c) => (
              <li key={c.item} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-line py-1.5 text-[13px] last:border-b-0">
                <Status of="check" value="notyet" />
                <span className="font-semibold">{c.item}</span>
                <span className="text-ink-2">{c.detail}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-[13px]">
            <Status of="check" value="pass" label="모두 통과" />
          </p>
        )}
      </div>
      <div className="mt-2.5 flex flex-wrap gap-2">
        <ActionButton variant="default" blockedBy={why} reasonId="bl-why" onClick={() => resume.run({ slug: "youth-housing", run_id: b.run })}>
          계속
        </ActionButton>
        <ActionButton blockedBy={!owner ? "소유자만" : null}>다른 방식으로 넘기기</ActionButton>
        <ActionButton blockedBy={!owner ? "소유자만" : null}>실행 취소</ActionButton>
      </div>
      <Hint id="bl-why" className="mt-1.5">
        {why ?? "계속할 수 있습니다."}
        {!manager ? " 확인 안 된 호출 정리·기준값은 API 연결 관리자가 합니다." : ""}
      </Hint>
      <More className="mt-1.5" label="자세히 · 사유 · 모든 검사">
        <MoreList
          items={[
            ["멈춘 시각", b.stopped],
            ["사유", b.reason],
            ["AI 연결 · 모델", `${b.model} · ${b.connection} · 재개해도 같은 모델(다른 모델로 바꾸지 않음)`],
            ["계속을 누르면", "“계속 접수됨” 뒤 실행기가 새 담당(claim·fence)을 잡아야 진행 · 이미 저장된 결과는 다시 만들지 않음 · 누를 때 서버가 최신 정책·질문·폼·기한·한도·rev·담당을 다시 검사"],
          ]}
        />
        <ul className="mt-2">
          {b.checks.map((c) => (
            <li key={c.item} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 border-b border-line py-1.5 last:border-b-0 desk:grid-cols-[230px_minmax(0,1fr)_auto]">
              <span className="font-semibold text-ink">{c.item}</span>
              <span className="col-span-2 row-start-2 desk:col-span-1 desk:row-start-auto">{c.detail}</span>
              <span className="col-start-2 row-start-1 justify-self-end desk:col-start-auto desk:row-start-auto">{c.pass ? <Status of="check" value={c.item.includes("서버 판단") ? "server_pass" : "pass"} /> : <Status of="check" value="notyet" />}</span>
            </li>
          ))}
        </ul>
      </More>
    </Card>
  );
}

export function UsagePage() {
  const q = useUsage();
  const settings = useMockSettings();
  const manager = settings.role === "owner";
  const [adding, setAdding] = React.useState(false);
  // 정리 대화 상자는 연 순간의 호출을 붙잡아 둔다(정리 뒤 목록에서 빠져도 영수증을 보여 주려고)
  const [settling, setSettling] = React.useState<UsageView["unknown_calls"][number] | null>(null);
  const { hash } = useLocation();
  const [tab, setTab] = React.useState(hash === "#ops" ? "ops" : "api");
  React.useEffect(() => {
    if (hash === "#ops") setTab("ops");
    else if (hash) setTab("api");
  }, [hash]);

  if (q.isPending) return <div className="mt-3"><QuietLoading what="사용량" /></div>;
  if (q.isError || !q.data) return <div className="mt-3"><LoadError what="사용량" lastReceived="—" code="U-0001" onRetry={() => q.refetch()} /></div>;
  const u = q.data;
  const sub = u.connections.find((c) => c.billing === "subscription" && c.id === "conn-sub") ?? u.connections.find((c) => c.billing === "subscription");
  const metered = u.connections.filter((c) => c.billing === "metered");

  return (
    <>
      <SectionTitle as="h1" title="사용량" sub={`AI 연결 ${u.connections.length}개 · 모든 수치는 PES 추정`} />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList variant="line" aria-label="사용량 보기">
          <TabsTrigger value="api">API 사용량</TabsTrigger>
          <TabsTrigger value="ops">웹 운영 한도 · 관리자</TabsTrigger>
        </TabsList>
        <TabsContent value="api">
          <NowCard now={u.now} titleId="use-now" className="mt-4" />
          {!manager ? (
            <Callout tone="off" className="mt-3">
              읽기만 — 연결 전체의 확인·기준값·정산은 API 연결 관리자가 합니다. 내 프로젝트 밖의 실행은 이름 없이 합계로만 보입니다(Codex F04).
            </Callout>
          ) : null}
          {sub?.subscription ? (
            <section aria-labelledby="g-title">
              <SectionTitle
                id="g-title"
                title={`${sub.name} · 구독형`}
                aside={
                  <InfoTip label="사용량 추정 방법" wide>
                    <p>추정 = t0 콘솔 기준값 + t0 이후 PES 증분 + 예약. 세 구간 중 하나라도 문턱에 닿기 전에 새 호출을 멈춥니다.</p>
                    <p className="text-muted-foreground">제공사의 공식 사용량 조회 방법은 연결마다 다르고 확인되지 않았을 수 있습니다(PR19). 모르는 값은 0으로 쓰지 않고, 주의 색은 문턱 10%p 아래부터 표시만 합니다.</p>
                  </InfoTip>
                }
              />
              <StatRow label="API 사용량 계기">
                {sub.subscription.windows.map((w) => (
                  <Gauge key={w.key} w={w} stop={sub.subscription!.stop_percent} />
                ))}
                {metered.map((c) => (
                  <MeteredSummary key={c.id} c={c} />
                ))}
              </StatRow>
              <Collapsible className="mt-3 rounded-xl border bg-card px-4 py-2 shadow-xs">
                <CollapsibleTrigger className="group inline-flex items-center gap-1.5 text-[13px] font-semibold">
                  <ChevronDownIcon className="size-4 transition-transform group-data-[state=open]:rotate-180" aria-hidden="true" />
                  구간별 근거 — 표로 보기
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <Table regionLabel="API 사용량 추정 표" containerClassName="mt-2" className="min-w-[640px]">
                    <TableCaption className="sr-only">API 사용량 추정 표</TableCaption>
                    <TableHeader>
                      <TableRow>
                        <TableHead scope="col">구간</TableHead>
                        <TableHead scope="col" className="text-right">추정</TableHead>
                        <TableHead scope="col" className="text-right">콘솔 기준값(t0)</TableHead>
                        <TableHead scope="col" className="text-right">t0 이후 PES</TableHead>
                        <TableHead scope="col" className="text-right">예약</TableHead>
                        <TableHead scope="col" className="text-right">문턱</TableHead>
                        <TableHead scope="col">재개·재설정</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {sub.subscription.windows.map((w) => (
                        <TableRow key={w.key}>
                          <TableHead scope="row">{WIN_LABEL[w.key]}</TableHead>
                          <TableCell className="text-right tabular-nums">{w.estimated_percent}%</TableCell>
                          <TableCell className="text-right tabular-nums">{w.t0_console ?? "없음"}%</TableCell>
                          <TableCell className="text-right tabular-nums">{w.pes_since_t0}%p · 실행 {w.pes_runs}</TableCell>
                          <TableCell className="text-right tabular-nums">{w.reserved}%p</TableCell>
                          <TableCell className="text-right tabular-nums">{sub.subscription!.stop_percent}%</TableCell>
                          <TableCell>{w.resets.text}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CollapsibleContent>
              </Collapsible>
            </section>
          ) : null}
          <React.Suspense
            fallback={
              <Card className="mt-6 h-[360px] justify-center px-5" aria-busy="true">
                <p role="status" className="text-[13px] text-ink-2">
                  사용량 추이 그래프를 불러오는 중… 같은 숫자는 위 계기와 “표로 보기”에 있습니다.
                </p>
              </Card>
            }
          >
            <UsageTrendChart trend={u.trend} />
          </React.Suspense>
          <Anno>제공사의 공식 사용량 조회 방법은 연결마다 다르고 확인되지 않았을 수 있습니다(PR19 확인 대상). 그래서 PES가 호출마다 센 토큰으로 한도 대비 사용률을 추정하고, PES가 못 보는 사용은 사람이 적은 콘솔 기준값(t0)으로만 더합니다. 모르는 값은 0으로 쓰지 않습니다. 주의 색은 문턱 10%p 아래부터이며 표시만 합니다.</Anno>
          {u.blocked ? <Blocked u={u} manager={manager} /> : null}
          <Card id="unknown" className="mt-5 gap-0 px-5" aria-labelledby="uk-t">
            <CardHead
              eyebrow={`확인 안 된 호출 ${u.unknown_calls.length}`}
              title="API가 처리했는지 모르는 호출"
              aside={
                <InfoTip label="확인 안 된 호출 설명" wide>
                  <p>PES는 같은 호출을 자동으로 다시 하지 않습니다. 콘솔 사용 내역을 보고 정리해 주세요. 정리 전까지 예약은 사용량에 남아 있고, 확인할 수 없으면 예약·차단을 그대로 둡니다. 정리는 API 연결 관리자가 합니다.</p>
                </InfoTip>
              }
              titleId="uk-t"
              right={u.unknown_calls.length ? <Status of="run" value="unconfirmed_call" label="확인 안 됨" /> : <Status of="check" value="pass" label="없음" />}
            />
            {u.unknown_calls.length ? (
              <Table regionLabel="확인 안 된 호출" className="min-w-[640px]">
                <TableCaption className="sr-only">확인 안 된 호출 목록</TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">실행</TableHead>
                    <TableHead scope="col">시각</TableHead>
                    <TableHead scope="col">무슨 일</TableHead>
                    <TableHead scope="col">사용량 예약</TableHead>
                    <TableHead scope="col">정리</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {u.unknown_calls.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell>{c.run}</TableCell>
                      <TableCell className="tabular-nums">{c.at}</TableCell>
                      <TableCell>{c.what}</TableCell>
                      <TableCell>{c.reserve}</TableCell>
                      <TableCell>
                        <ActionButton size="sm" variant={manager ? "default" : "outline"} blockedBy={manager ? null : MANAGER_WHY} onClick={() => setSettling(c)}>
                          정리하기
                        </ActionButton>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className="text-[13px] text-ink-2">정리할 호출이 없습니다.</p>
            )}
          </Card>
          {sub ? <ExtraAndBaseline c={sub} manager={manager} /> : null}
          <SectionTitle id="connections" title="AI 연결" sub="직접 등록한 API 연결 · 특정 서비스에 묶지 않음" right={<ActionButton variant="default" blockedBy={manager ? null : "AI 연결 추가는 소유자(연결 관리자)만 할 수 있습니다."} onClick={() => setAdding(true)}><PlusIcon aria-hidden="true" />AI 연결 추가</ActionButton>} />
          <div className="grid grid-cols-1 gap-4 desk:grid-cols-2">
            {u.connections.map((c) => (
              <ConnectionCard key={c.id} c={c} manager={manager} />
            ))}
          </div>

          {/* 자주 보지 않는 묶음은 제목 한 줄로 접는다(정보 밀도 14절) — 내용은 그대로 */}
          <div className="mt-5 space-y-3">
            <FoldCard id="flow" title="멈춤에서 재개까지" meta={`지금 ${u.scene_time} · ${u.flow.length}단계`}>
              <ol className="grid grid-cols-1 gap-2 tab:grid-cols-2 desk:grid-cols-7">
                {u.flow.map((f) => (
                  <li key={f.title} aria-current={f.state === "now" ? "step" : undefined} className={cn("min-w-0 rounded-lg border px-2.5 py-2 text-[12.5px]", f.state === "past" && "border-line bg-surface-soft", f.state === "now" && "border-2 border-primary", f.state === "next" && "border-line bg-surface")}>
                    <span className="block font-semibold text-muted-foreground">{f.time}</span>
                    <span className="my-0.5 block font-semibold text-ink">{f.title}</span>
                    {f.body}
                  </li>
                ))}
              </ol>
              <Anno>사용량 멈춤은 “내 답 기다림”과 다른 상태입니다. 멈춘 동안에도 사람은 답·첨언·자료 올리기를 할 수 있습니다. 재개 가능 시각이 지나거나 사용량이 줄어도 PES는 저절로 다시 시작하지 않습니다 — 기본은 사람이 계속, 자동 재개 옵션(R1)도 사용량 멈춤에는 쓰지 않습니다.</Anno>
            </FoldCard>
            <FoldCard title="이번 주 사용량 구성" meta={`주간 추정 ${sub?.subscription?.windows[1]?.estimated_percent ?? "—"}%`}>
              <ol aria-label="사용량 구성">
                {u.rank.map((r) => (
                  <li key={r.label} className="grid grid-cols-[minmax(0,1fr)_56px] items-center gap-x-2.5 gap-y-1 py-1.5 text-[13px] tab:grid-cols-[260px_minmax(0,1fr)_56px]">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span tabIndex={0} className="min-w-0 rounded underline decoration-dotted underline-offset-2">
                          {manager || r.external || r.label.startsWith("예약") ? r.label : "다른 프로젝트(이름 비공개)"}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>{r.tip}</TooltipContent>
                    </Tooltip>
                    <span aria-hidden="true" className="relative col-span-2 row-start-2 h-3.5 tab:col-span-1 tab:row-start-auto">
                      <span className={cn("absolute inset-y-0 left-0 rounded-r", r.external ? "bg-control" : "bg-meter-fill")} style={{ width: `${Math.max(2, (r.value / 64) * 100)}%` }} />
                    </span>
                    <span className="text-right font-semibold tabular-nums">{r.value}%p</span>
                  </li>
                ))}
              </ol>
              <Hint className="mt-1.5">파란 막대 = t0 이후 PES가 센 실행 · 회색 = 콘솔 기준값(다른 앱 + t0 이전 PES 포함). 값은 막대 끝 숫자.</Hint>
            </FoldCard>
            <FoldCard title="프로젝트별 설정" meta={manager ? undefined : "소유자만 바꿈"}>
              <Table regionLabel="프로젝트별 방식 A 설정" className="min-w-[560px]">
                <TableCaption className="sr-only">프로젝트별 방식 A 설정</TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">프로젝트</TableHead>
                    <TableHead scope="col">방식</TableHead>
                    <TableHead scope="col">AI 연결 · 모델</TableHead>
                    <TableHead scope="col">한도</TableHead>
                    <TableHead scope="col">상태</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {u.projects.map((p) => (
                    <TableRow key={p.title}>
                      <TableCell>{p.title}</TableCell>
                      <TableCell>
                        <ModeBadge mode={p.mode} />
                      </TableCell>
                      <TableCell>
                        {p.connection} · <code className="text-xs">{p.model}</code>
                      </TableCell>
                      <TableCell>{p.limit}</TableCell>
                      <TableCell>{p.status ? <StatusFrom s={p.status} /> : p.note}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <Hint className="mt-1.5">문턱은 연결마다 정합니다. 한 프로젝트의 문턱이 다른 프로젝트를 전역으로 막지 않게, 계기에는 연결의 문턱을 그립니다(Codex G14).</Hint>
            </FoldCard>
          </div>

          {/* 상태 견본(시안) — 시안 설명 상자와 함께 숨김. 상태 사전 전체는 /states */}
          <section data-mock="note" aria-labelledby="states">
            <SectionTitle id="states" title="상태 견본" sub="사용량 관련 상태는 근거와 함께 보입니다." />
            <div className="grid grid-cols-1 gap-4 desk:grid-cols-3">
              {(["resetBasis", "extraUsage", "baseline", "costCap", "meter", "connTest"] as const).map((dom) => (
                <Card key={dom} className="gap-0 px-5">
                  <Table>
                    <TableCaption>{{ resetBasis: "재개 가능 시각의 근거", extraUsage: "추가 요금(Extra Usage) 꺼짐 확인", baseline: "콘솔 기준값", costCap: "비용 상한(쓴 만큼 과금)", meter: "계기 3구간", connTest: "AI 연결 시험" }[dom]}</TableCaption>
                    <TableBody>
                      {Object.entries(STATUS[dom]).map(([val, d]) => (
                        <TableRow key={val}>
                          <TableCell className="w-[48%]">
                            <Status of={dom} value={val} wrap />
                          </TableCell>
                          <TableCell>{d.basis}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </Card>
              ))}
            </div>
          </section>
        </TabsContent>

        <TabsContent value="ops">
          <Card id="ops" className="mt-3 gap-0 px-5" aria-labelledby="ops-t">
            <CardHead eyebrow="웹 운영 한도 · 배포 관리자 · 5단계(WEB12)" title="무료 요금제 사용률" titleId="ops-t" right={<Status of="meter" value="ok" label="모두 80% 아래" />} />
            <Table regionLabel="웹 운영 한도" className="min-w-[600px]">
              <TableCaption className="sr-only">웹 운영 한도 사용률</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">자원</TableHead>
                  <TableHead scope="col" className="text-right">사용</TableHead>
                  <TableHead scope="col" className="text-right">무료 한도</TableHead>
                  <TableHead scope="col" className="w-[24%]">사용률</TableHead>
                  <TableHead scope="col">상태</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {u.ops.map((o) => (
                  <TableRow key={o.resource}>
                    <TableHead scope="row">{o.resource}</TableHead>
                    <TableCell className="text-right tabular-nums">{o.used}</TableCell>
                    <TableCell className="text-right tabular-nums">{o.limit}</TableCell>
                    <TableCell>
                      {o.percent == null ? "—" : (
                        <>
                          {o.percent}%
                          <Meter percent={o.percent} label={`${o.resource} ${o.percent}%`} compact />
                        </>
                      )}
                    </TableCell>
                    <TableCell>
                      <StatusFrom s={o.status} wrap />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Anno>80%에서 알리고 90%에서 줄입니다(갱신 간격 늘리기·급하지 않은 알림·백업 미루기·새 실행 막기). “새 실행 막기”는 한도를 지켰다는 증명이 아닙니다. 파일 저장은 무료량을 넘으면 과금되므로 실제 비용이 생기기 전에 사용자에게 묻습니다. 정적 화면(대시보드 앱)은 정적 자산으로 내보내 요청·CPU 한도에 거의 들지 않습니다(0017). 플랫폼 이름과 한도는 WEB0 실측 뒤 확정합니다.</Anno>
          </Card>
        </TabsContent>
      </Tabs>

      <AddConnectionDialog open={adding} onOpenChange={setAdding} />
      {settling ? <SettleDialog id={settling.id} open onOpenChange={(o) => !o && setSettling(null)} hint={settling.evidence_hint} /> : null}
      <p data-mock="note" className="mt-6 text-[12.5px] text-muted-foreground">
        이 화면의 연결 이름·주소·수치는 모두 합성 예시입니다. <Link to="/guide">시안 안내</Link>
      </p>
    </>
  );
}
