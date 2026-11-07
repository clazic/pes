import * as React from "react";
import { Link, useSearchParams } from "react-router";
import { FolderOpenIcon, PlusIcon, UploadIcon } from "lucide-react";
import { useCommand, useUsage } from "@/api/queries";
import type { UploadCandidate } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Anno, Hint, KV, ModeBadge, SectionTitle, Tag } from "@/components/pes/bits";
import { Callout } from "@/components/pes/blocks";
import { ActionButton, StateSwitch } from "@/components/pes/controls";
import { InfoTip } from "@/components/pes/disclosure";
import { Chip, Status } from "@/components/pes/status";
import { STATUS } from "@/components/pes/status-registry";
import { BILLING_LABEL, KIND_LABEL, won } from "@/mocks/connections";
import { cn } from "@/lib/utils";
import { UploadDialog } from "@/features/materials/UploadDialog";
import { SnapshotPick } from "@/features/workspace/ReferencesPage";
import { AddConnectionDialog } from "@/features/usage/AddConnectionDialog";
import { ReferenceTable } from "./reference-pick";

interface Draft {
  name: string;
  slug: string;
  goal: string;
  connection: string;
  model: string;
  transfer: boolean;
  stop: number;
  files: UploadCandidate[];
  filesRoot: string;
  /** 새로고침 뒤에는 파일 내용을 다시 골라야 한다(R02) */
  filesNeedRepick: boolean;
  refOn: boolean;
  refSnap: string;
}

const KEY = "pes-wizard-a";
const INIT: Draft = { name: "농촌 의료 접근성 개선 연구", slug: "rural-care-access-2", goal: "농촌 주민의 의료 접근성 격차와 개선 방안을 찾는다. (가상)", connection: "conn-sub", model: "deepseek-v4.1-flash", transfer: true, stop: 90, files: [], filesRoot: "", filesNeedRepick: false, refOn: true, refSnap: "s-ed1" };
const TAKEN = ["dolbom-insight", "youth-housing", "rural-care-access", "ltc-survey"];

function load(): Draft {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw) {
      const d = JSON.parse(raw) as Draft;
      return { ...INIT, ...d, filesNeedRepick: d.files.length > 0 };
    }
  } catch {
    /* 무시 */
  }
  return INIT;
}

const STEPS = ["기본 정보", "AI 연결·모델", "AI가 읽기·사용량", "내 자료", "참고 프로젝트", "확인하고 만들기"];
/** 스위치 글자는 상태 사전(transfer)의 짧은 글자 — 허용 / 막음(4차 사용자 결정) */
const ALLOW = STATUS.transfer.on!.short!;
const BLOCK = STATUS.transfer.off!.short!;

export function WizardPage() {
  const [params, setParams] = useSearchParams();
  const step = params.get("step") === "done" ? 7 : Math.min(6, Math.max(1, Number(params.get("step") ?? "1")));
  const [d, setD] = React.useState<Draft>(load);
  const usage = useUsage();
  const [adding, setAdding] = React.useState(false);
  const [picking, setPicking] = React.useState<null | "files" | "folder">(null);
  const create = useCommand("project.create", { successText: (r) => `프로젝트 만들기 접수됨 · 접수 번호 ${r.receipt_no}` });

  React.useEffect(() => {
    try {
      sessionStorage.setItem(KEY, JSON.stringify({ ...d, filesNeedRepick: false }));
    } catch {
      /* 무시 */
    }
  }, [d]);

  const go = (n: number | "done") => setParams({ step: String(n) });
  const set = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));
  const conns = usage.data?.connections ?? [];
  const conn = conns.find((c) => c.id === d.connection);
  const model = conn?.models.find((m) => m.id === d.model);
  const slugTaken = TAKEN.includes(d.slug);
  const connWhy = !conn ? "AI 연결을 고르거나 추가하세요." : conn.billing === "metered" && !conn.metered?.cap ? "쓴 만큼 과금 연결에 비용 상한이 없습니다 — 상한이 없으면 시작할 수 없습니다." : !model?.available ? "고른 모델이 지금 목록에 없습니다." : model.price?.source === "unknown" ? "이 모델은 단가를 몰라 비용을 셀 수 없습니다." : null;
  const allowN = d.files.filter((f) => f.access === "allow").length;

  const stepState = (i: number) => (i + 1 < step ? "done" : i + 1 === step ? "cur" : "todo");

  return (
    <>
      <SectionTitle
        as="h1"
        title="방식 A로 만들기"
        sub={
          <span className="inline-flex flex-wrap items-center gap-1">
            만들기 전에는 아무것도 저장하지 않습니다
            <InfoTip label="초안 저장 설명">
              <p>글자·설정은 이 탭에만 있고 새로고침해도 남습니다. 고른 파일은 새로고침하면 다시 골라야 합니다.</p>
            </InfoTip>
          </span>
        }
        right={<ModeBadge mode="A" detail="웹에서 바로" />}
      />
      <div className="mt-3.5 grid grid-cols-1 items-start gap-4 desk:grid-cols-[232px_minmax(0,1fr)]">
        <Card className="gap-0 px-3 desk:sticky desk:top-3" role="navigation" aria-label="방식 A 만들기 단계">
          <p className="mb-1 px-1 text-xs font-semibold text-muted-foreground">방식 A로 만들기 · 6칸</p>
          <ol className="flex flex-wrap gap-1 desk:block">
            {STEPS.map((s, i) => {
              const st = stepState(i);
              return (
                <li key={s}>
                  <button
                    type="button"
                    onClick={() => step <= 6 && go(i + 1)}
                    aria-current={st === "cur" ? "step" : undefined}
                    className={cn("flex min-h-10 w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-[13px] font-medium text-ink-2 hover:bg-surface-soft", st === "cur" && "bg-primary-soft text-primary-ink")}
                  >
                    <span aria-hidden="true" className={cn("inline-flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold", st === "done" ? "bg-ok text-background" : st === "cur" ? "bg-primary text-primary-foreground" : "bg-off-soft text-off")}>
                      {i + 1}
                    </span>
                    {s}
                    <span className="ml-auto text-[11.5px] font-normal text-muted-foreground max-desk:hidden">{st === "done" ? "완료" : st === "cur" ? "지금" : i === 3 || i === 4 ? "선택" : ""}</span>
                    <span className="sr-only">{st === "done" ? "(완료)" : st === "cur" ? "(지금)" : ""}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </Card>

        <div className="min-w-0 space-y-3.5">
          {step === 1 ? (
            <StepCard n={1} title="기본 정보">
              <div className="grid grid-cols-1 gap-3 tab:grid-cols-2">
                <div>
                  <Label htmlFor="w-name" className="text-[13px] font-semibold">
                    프로젝트 이름
                  </Label>
                  <Input id="w-name" className="mt-1" value={d.name} onChange={(e) => set({ name: e.target.value })} />
                </div>
                <div>
                  <Label htmlFor="w-slug" className="text-[13px] font-semibold">
                    주소
                  </Label>
                  <Input id="w-slug" className="mt-1" value={d.slug} aria-describedby="w-slug-h" aria-invalid={slugTaken || undefined} onChange={(e) => set({ slug: e.target.value.replace(/[^a-z0-9-]/g, "") })} />
                  <p id="w-slug-h" className="mt-1 text-[12.5px] text-muted-foreground">
                    {slugTaken ? <Status of="generic" value="duplicate" /> : <Status of="generic" value="available" />} /p/{d.slug}
                  </p>
                </div>
              </div>
              <Label htmlFor="w-goal" className="mt-3 block text-[13px] font-semibold">
                한 줄 목적
              </Label>
              <Textarea id="w-goal" className="mt-1" rows={2} value={d.goal} onChange={(e) => set({ goal: e.target.value })} />
              <Hint className="mt-1">기간·발주처·분량은 시작 질문에서 묻습니다.</Hint>
              <Nav next={() => go(2)} nextBlocked={slugTaken ? "같은 주소가 있습니다. 주소를 바꾸세요." : !d.name.trim() ? "이름을 적어 주세요." : null} />
            </StepCard>
          ) : null}

          {step === 2 ? (
            <StepCard n={2} title="AI 연결·모델">
              <fieldset>
                <legend className="mb-1.5 text-[13px] font-semibold">쓸 AI 연결</legend>
                <RadioGroup value={d.connection} onValueChange={(v) => set({ connection: v, model: conns.find((c) => c.id === v)?.models.find((m) => m.is_default)?.id ?? "" })} className="gap-2" aria-label="쓸 AI 연결">
                  {conns.map((c) => (
                    <label key={c.id} htmlFor={`w-c-${c.id}`} className={cn("flex cursor-pointer items-start gap-2.5 rounded-xl border px-3 py-2.5", d.connection === c.id ? "border-2 border-primary bg-primary-soft px-[11px] py-[9px]" : "border-line")}>
                      <RadioGroupItem id={`w-c-${c.id}`} value={c.id} className="mt-1" />
                      <span className="min-w-0">
                        <strong className="text-[13.5px]">{c.name}</strong> <Tag>{KIND_LABEL[c.kind]}</Tag> <Tag tone={c.billing === "metered" ? "warn" : "plain"}>{BILLING_LABEL[c.billing]}</Tag>
                        <span className="mt-1 flex flex-wrap gap-x-2.5 gap-y-1 text-[12.5px] text-ink-2">
                          <Status of="connTest" value={c.test.state} label={c.test.at ? `연결 시험 ${c.test.at}` : undefined} />
                          <span>{c.billing === "metered" ? (c.metered?.cap ? `월 비용 상한 ${won(c.metered.cap.amount)}` : "비용 상한 없음 — 시작 못 함") : `멈춤 문턱 기본 ${c.subscription?.stop_percent}%`}</span>
                          <span>모델 {c.models.length}개</span>
                        </span>
                      </span>
                    </label>
                  ))}
                </RadioGroup>
              </fieldset>
              <Button className="mt-2 self-start" onClick={() => setAdding(true)}>
                <PlusIcon aria-hidden="true" />
                AI 연결 추가
              </Button>
              <div className="mt-3">
                <Label htmlFor="w-model" className="text-[13px] font-semibold">
                  모델
                </Label>
                <Select value={d.model} onValueChange={(v) => set({ model: v })}>
                  <SelectTrigger id="w-model" className="mt-1 w-full">
                    <SelectValue placeholder="모델 고르기" />
                  </SelectTrigger>
                  <SelectContent>
                    {conn?.models.map((m) => (
                      <SelectItem key={m.id} value={m.id} disabled={!m.available}>
                        {m.id}
                        {m.is_default ? " · 기본" : ""}
                        {!m.available ? " — 지금 목록에 없음" : m.weight_known === false ? " — 사용량 가중치 미확인" : m.price?.source === "unknown" ? " — 단가 모름" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {model?.weight_known === false ? <Hint className="mt-1"><Status of="generic" value="weight_unknown" /> 추정 사용률이 덜 정확할 수 있습니다.</Hint> : null}
                {model?.price ? <Hint className="mt-1">{model.price.text}</Hint> : null}
              </div>
              <p className="mt-2.5 flex flex-wrap items-center gap-1 text-[13px] text-ink-2">
                실행 하나는 모델 하나 — 실패해도 <strong className="text-ink">자동으로 바꾸지 않음</strong>
                <InfoTip label="모델 고르기 설명" wide>
                  <p>바꾸면 다음 실행부터 적용되고, 프로젝트 설정에서 소유자만 바꿀 수 있습니다. 모델 목록을 받지 못하면 기본 모델로 만들 수 있고, 첫 실행 전에 다시 확인합니다{conn?.models_listed_at ? `(목록 확인 ${conn.models_listed_at})` : ""}. 브라우저가 외부 API를 직접 부르지 않습니다.</p>
                </InfoTip>
              </p>
              <Nav prev={() => go(1)} next={() => go(3)} nextBlocked={connWhy} />
            </StepCard>
          ) : null}

          {step === 3 ? (
            <StepCard n={3} title="AI가 읽기·사용량">
              <div className="grid grid-cols-1 gap-3 tab:grid-cols-2">
                <div>
                  <p className="mb-1.5 flex items-center gap-1 text-[13px] font-semibold">
                    AI가 읽기
                    <InfoTip label="AI가 읽기 설명" wide>
                      <p>등록된 AI 연결(API)이 이 프로젝트 자료를 읽게 할지 정합니다. 이 프로젝트의 모든 AI 연결에 같게 적용됩니다. 읽는 것: 질문·답, 결과물, AI 참조를 허용한 자료의 뽑은 글자, 허용된 참고자료.</p>
                      <p>막으면 방식 A를 쓸 수 없고 방식 B나 사람 작업으로 갑니다. 내 컴퓨터 AI 도구(방식 B)가 PES를 거쳐 읽는 것은 파일별 AI 참조를 따릅니다. 이미 보낸 자료는 막아도 회수되지 않습니다.</p>
                    </InfoTip>
                  </p>
                  <StateSwitch checked={d.transfer} onLabel={ALLOW} offLabel={BLOCK} name="AI가 읽기" onRequest={(v) => set({ transfer: v })} />
                  <Hint className="mt-1.5">막으면 방식 A를 쓸 수 없음 · 보낸 자료는 회수되지 않음</Hint>
                </div>
                <div>
                  {conn?.billing === "subscription" ? (
                    <>
                      <Label htmlFor="w-stop" className="text-[13px] font-semibold">
                        멈춤 문턱(이 프로젝트)
                      </Label>
                      <Input id="w-stop" type="number" min={50} max={100} step={5} className="mt-1 max-w-[120px]" value={d.stop} onChange={(e) => set({ stop: Number(e.target.value) })} aria-describedby="w-stop-h" />
                      <Hint id="w-stop-h" className="mt-1">이 값에 닿기 전에 새 호출을 멈춤 · 기본 90%(50~100)</Hint>
                    </>
                  ) : conn ? (
                    <Callout tone="warn">
                      <strong>쓴 만큼 과금 · 월 비용 상한 {conn.metered?.cap ? won(conn.metered.cap.amount) : "없음"}</strong> — 다음 호출의 예약을 더하면 상한을 넘을 때 보내기 전에 멈춥니다. 상한은 연결 관리에서 바꿉니다(소유자·재인증).
                    </Callout>
                  ) : null}
                </div>
              </div>
              {conn?.subscription ? (
                <ul className="mt-3 divide-y divide-line rounded-xl border border-line text-[13px]" aria-label="시작 전 확인">
                  <li className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2">
                    <strong>추가 요금(Extra Usage) 꺼짐 확인</strong>
                    <Status of="extraUsage" value={conn.subscription.extra_usage.state} />
                    {conn.subscription.extra_usage.valid_until ? <span className="text-muted-foreground">{conn.subscription.extra_usage.valid_until}까지</span> : null}
                    <InfoTip label="추가 요금 꺼짐 확인 설명" wide>
                      <p>{conn.subscription.extra_usage.last ? `${conn.subscription.extra_usage.last} ${conn.subscription.extra_usage.by} 확인 · 유효 7일(예시값, 사용자 결정 질문 1). ` : ""}{conn.name} 연결 단위 기록입니다(이 프로젝트만의 기록이 아님). 확인이 없거나 지나면 방식 A를 시작하지 않습니다.</p>
                    </InfoTip>
                  </li>
                  <li className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2">
                    <strong>콘솔 기준값(t0)</strong>
                    <Status of="baseline" value={conn.subscription.baseline.state} />
                    <InfoTip label="콘솔 기준값 설명" wide>
                      <p>PES는 같은 구독의 다른 앱 사용량을 볼 수 없습니다. 콘솔에서 본 계정 전체 사용률을 적습니다. 비어 있으면 첫 실행 전에 다시 묻고, 그때도 모르면 시작하지 않습니다.</p>
                    </InfoTip>
                    <Link to="/usage#base" className="ml-auto">
                      사용량 화면에서 적기
                    </Link>
                  </li>
                </ul>
              ) : null}
              <Nav prev={() => go(2)} next={() => go(4)} />
            </StepCard>
          ) : null}

          {step === 4 ? (
            <StepCard n={4} title="내 자료" optional>
              <div className="flex flex-wrap items-center justify-center gap-2.5 rounded-xl border-2 border-dashed border-control bg-surface-soft p-4 text-center">
                <p className="w-full font-semibold">파일이나 폴더 고르기 — 아직 올리지 않음</p>
                <Button onClick={() => setPicking("files")}>
                  <UploadIcon aria-hidden="true" />
                  파일 고르기
                </Button>
                <Button onClick={() => setPicking("folder")}>
                  <FolderOpenIcon aria-hidden="true" />
                  폴더 고르기
                </Button>
                <Hint className="w-full">글자 뽑기는 이 브라우저에서 · 상한은 예시값</Hint>
              </div>
              {d.filesNeedRepick ? (
                <Callout tone="warn" className="mt-2.5">
                  <strong>파일을 다시 골라야 합니다.</strong> 새로고침하면 이 브라우저는 파일 내용을 따로 보관하지 않아 목록 이름만 남았습니다(R02). 이름·AI 참조 설정은 그대로입니다.
                </Callout>
              ) : null}
              {d.files.length ? (
                <div className="mt-3 rounded-xl border border-line">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-surface-soft px-3 py-2 text-[12.5px]">
                    <strong>
                      고른 파일 {d.files.length}개{d.filesRoot ? ` · 폴더 “${d.filesRoot}”` : ""} — 아직 올리지 않음
                    </strong>
                    <span>
                      AI 참조 허용 {allowN} · 금지 {d.files.length - allowN}
                    </span>
                  </div>
                  <ul className="divide-y divide-line text-[13px]">
                    {d.files.map((f) => (
                      <li key={f.path} className="grid grid-cols-1 items-center gap-x-3 gap-y-1 px-3 py-2 tab:grid-cols-[minmax(0,1fr)_auto_auto]">
                        <span className="min-w-0 break-all">{f.path}</span>
                        <span>{f.verdict === "unsupported" ? <Status of="generic" value="unsupported_fmt" /> : f.verdict === "same_name" ? <Status of="generic" value="new_version" /> : f.verdict === "same_content" ? <Status of="generic" value="same_content" /> : <Status of="extract" value="ready" label="뽑을 수 있음" />}</span>
                        <StateSwitch checked={f.access === "allow"} onLabel="허용" offLabel="금지" name={`AI 참조: ${f.path}`} onRequest={(v) => set({ files: d.files.map((x) => (x.path === f.path ? { ...x, access: v ? "allow" : "deny" } : x)) })} />
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <Anno>AI 참조는 파일마다 기본 “허용”입니다. “금지”로 고르면 처음부터 금지 정책으로 저장해 허용 구간이 생기지 않게 합니다(준비됨 공개와 처음 정책을 같은 tx — Codex F11·G11). 지원 안 함·실패·일부만은 숨기지 않습니다.</Anno>
              <Nav prev={() => go(3)} next={() => go(5)} nextLabel="다음: 참고 프로젝트" />
            </StepCard>
          ) : null}

          {step === 5 ? (
            <StepCard n={5} title="참고 프로젝트" optional>
              {/* legend는 fieldset의 첫 자식으로 두고, 묶음 이름은 글자 부분만(aria-labelledby) — ⓘ 단추 이름이 섞이지 않게 */}
              <fieldset aria-labelledby="w-ref-legend">
                <legend className="mb-1.5 flex items-center gap-1 text-[13px] font-semibold">
                  <span id="w-ref-legend">읽기 전용으로 붙일 이전 프로젝트</span>
                  <InfoTip label="참고 프로젝트 설명">
                    <p>두 프로젝트 모두 권한이 있는 프로젝트만 보입니다. 복사·이전이 아니라 원본의 고정 버전을 가리킵니다.</p>
                  </InfoTip>
                </legend>
                <label htmlFor="w-r1" className={cn("flex cursor-pointer items-start gap-2.5 rounded-xl border px-3 py-2.5", d.refOn ? "border-2 border-primary bg-primary-soft" : "border-line")}>
                  <Checkbox id="w-r1" checked={d.refOn} onCheckedChange={(c) => set({ refOn: c === true })} className="mt-0.5" />
                  <span>
                    <strong>장기요양 기관 실태 분석(가상)</strong> <Tag>1판 완료</Tag>
                    <span className="block text-xs text-muted-foreground">소유자 김연구 · 마지막 승인 11-04</span>
                  </span>
                </label>
                <label htmlFor="w-r2" className="mt-2 flex cursor-pointer items-start gap-2.5 rounded-xl border border-line px-3 py-2.5">
                  <Checkbox id="w-r2" className="mt-0.5" />
                  <span>
                    <strong>청년 주거 지원 효과(가상)</strong> <Tag>기획 R1 진행 중</Tag>
                    <span className="block text-xs text-muted-foreground">승인본 없음 · 스냅숏은 “승인 안 됨”으로 표시</span>
                  </span>
                </label>
              </fieldset>
              {d.refOn ? (
                <div className="mt-3 space-y-3">
                  <SnapshotPick value={d.refSnap} onChange={(v) => set({ refSnap: v })} name="wz" />
                  <ReferenceTable />
                </div>
              ) : null}
              <Anno>참고는 복사·이전이 아니라 원본의 고정 버전을 가리키는 읽기 전용 연결입니다. 원본을 고치지 않습니다. 원본이 지워지면 “원본 없음”, 권한이 사라지면 “권한 없음”으로 바뀌고 내용은 보이지 않습니다.</Anno>
              <Nav prev={() => go(4)} next={() => go(6)} />
            </StepCard>
          ) : null}

          {step === 6 ? (
            <StepCard n={6} title="확인하고 만들기">
              <div className="grid grid-cols-1 gap-3 tab:grid-cols-2">
                <KV
                  items={[
                    ["이름", d.name],
                    ["방식", <ModeBadge key="m" mode="A" detail="웹에서 바로" />],
                    ["AI 연결", `${conn?.name ?? "—"} · ${conn ? BILLING_LABEL[conn.billing] : ""}`],
                    ["모델", <code key="c">{d.model}</code>],
                    ["AI가 읽기", `${d.transfer ? ALLOW : BLOCK}${conn?.billing === "subscription" ? ` · 멈춤 문턱 ${d.stop}%` : conn?.metered?.cap ? ` · 월 비용 상한 ${won(conn.metered.cap.amount)}` : ""}`],
                    ["내 자료", d.files.length ? `${d.files.length}개 · AI 참조 허용 ${allowN} · 금지 ${d.files.length - allowN}` : "없음(나중에 올림)"],
                    ["참고 프로젝트", d.refOn ? "1개 · 고정 버전 선택함 · API 목적지는 원본 정책상 제외" : "없음"],
                    ["첫 단계", "기획 — 시작 질문 6개"],
                  ]}
                />
                <Callout tone="warn">
                  <p>
                    <strong>첫 AI 실행 전에 할 일</strong>
                  </p>
                  <ul className="mt-1 ml-4.5 list-disc text-[12.5px]">
                    {conn?.subscription ? <li>콘솔 기준값(t0) — {conn.subscription.baseline.state === "entered" ? `있음 · ${conn.subscription.baseline.t0}` : "비어 있음"}</li> : null}
                    {conn?.subscription?.extra_usage.applicable ? <li>추가 요금(Extra Usage) 꺼짐 확인 — {conn.subscription.extra_usage.state === "confirmed" ? `됨(${conn.subscription.extra_usage.valid_until}까지)` : "필요"}</li> : null}
                    {conn?.billing === "metered" ? <li>비용 상한 — {conn.metered?.cap ? "있음" : "없음 — 시작 못 함"}</li> : null}
                  </ul>
                  <p className="mt-1.5 text-[12.5px]">만들기는 AI를 실행하지 않습니다.</p>
                </Callout>
              </div>
              {create.phase === "confirming" ? (
                <p role="status" className="mt-2.5 text-[13px]">
                  <Status of="submission" value="pending" /> 응답이 늦어 같은 요청 번호로 확인 중입니다. 다시 눌러도 두 번 만들지 않습니다.
                </p>
              ) : null}
              {create.phase === "unknown" ? (
                <Callout tone="warn" role="status" className="mt-2.5">
                  <Status of="generic" value="result_unknown" /> {create.error?.message} <Button size="sm" onClick={create.recheck}>같은 요청 번호로 확인</Button>
                </Callout>
              ) : null}
              {create.error && create.phase === "error" ? <Callout tone="bad" role="alert" className="mt-2.5">{create.error.message}</Callout> : null}
              <Nav
                prev={() => go(5)}
                nextLabel="만들기"
                nextBlocked={create.pending ? "접수 확인 중입니다" : connWhy}
                next={() => create.run({ name: d.name, slug: d.slug, connection_id: d.connection, model: d.model, files: d.files.length, refs: d.refOn ? 1 : 0 }, { onSuccess: () => go("done") })}
              />
            </StepCard>
          ) : null}

          {step === 7 ? <AfterCreate d={d} receipt={create.receipt?.receipt_no ?? "—"} /> : null}

          {step <= 6 ? (
            <section aria-label="만들기 상태 견본" data-mock="note" className="grid grid-cols-1 gap-3 tab:grid-cols-3">
              <Callout>
                <p><Status of="submission" value="pending" /></p>
                <p className="text-[12.5px]">응답이 늦어 같은 요청 번호로 확인 중입니다. 다시 눌러도 두 번 만들지 않습니다.</p>
              </Callout>
              <Callout tone="bad">
                <p><Status of="generic" value="duplicate" /></p>
                <p className="text-[12.5px]">/p/rural-care-access는 이미 있습니다. 주소를 바꾸세요. 입력은 그대로 있습니다.</p>
              </Callout>
              <Callout tone="bad">
                <p><Status of="generic" value="session_over" /></p>
                <p className="text-[12.5px]">다시 로그인하면 이 화면으로 돌아옵니다. 글자·설정은 이 탭에 남아 있고, 파일은 다시 골라야 합니다.</p>
              </Callout>
            </section>
          ) : null}
        </div>
      </div>
      <AddConnectionDialog open={adding} onOpenChange={setAdding} onCreated={(id, ms) => set({ connection: id, model: ms[0] ?? "" })} />
      <UploadDialog
        open={picking !== null}
        onOpenChange={(o) => !o && setPicking(null)}
        slug="(새 프로젝트)"
        existing={[]}
        startMode={picking ?? undefined}
        onCollect={(items, root) => set({ files: items, filesRoot: root, filesNeedRepick: false })}
      />
    </>
  );
}

/** 칸 카드 — “지금 하는 칸” 표시는 왼쪽 칸 목록이 이미 한다(같은 말 반복 없음). status는 지금 칸이 아닌 상태를 보일 때만 그린다. */
function StepCard({ n, title, status, optional, children }: { n: number; title: string; status?: React.ReactNode; optional?: boolean; children: React.ReactNode }) {
  return (
    <Card className="gap-0 border-2 border-primary px-4" aria-labelledby={`s${n}-t`}>
      <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
        <h2 id={`s${n}-t`} className="flex items-center gap-2 text-[17px]">
          <span className="text-[13px] font-semibold text-muted-foreground">{n}/6</span>
          {title}
          {optional ? <span className="text-[12.5px] font-normal text-muted-foreground">(건너뛸 수 있음)</span> : null}
        </h2>
        {status}
      </div>
      {children}
    </Card>
  );
}

function Nav({ prev, next, nextLabel = "다음", nextBlocked }: { prev?: () => void; next: () => void; nextLabel?: string; nextBlocked?: string | null }) {
  return (
    <div className="mt-3.5 flex flex-wrap items-center justify-end gap-2">
      {prev ? <Button onClick={prev}>이전</Button> : null}
      <ActionButton variant="default" blockedBy={nextBlocked} onClick={next}>
        {nextLabel}
      </ActionButton>
      {nextBlocked ? <span className="w-full text-right text-xs text-muted-foreground">{nextBlocked}</span> : null}
    </div>
  );
}

function AfterCreate({ d, receipt }: { d: Draft; receipt: string }) {
  const [retried, setRetried] = React.useState(false);
  const failed = d.files.length > 1 && !retried;
  return (
    <Card className="gap-0 px-5" aria-labelledby="done-t">
      <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
        <h2 id="done-t" className="text-[17px]">
          만들기를 누른 뒤
        </h2>
        {failed ? <Status of="generic" value="retry_needed" label="1개 다시 시도 필요" /> : <Status of="generic" value="done" label="모두 끝남" />}
      </div>
      <ol className="divide-y divide-line">
        <li className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 py-2.5">
          <div>
            <strong>① 프로젝트 만들기</strong>
            <span className="block text-xs text-muted-foreground">소유자·처음 정책·1판을 한 번에 — 하나라도 실패하면 아무것도 안 만듦</span>
          </div>
          <Status of="generic" value="received" label={`접수됨 · ${receipt}`} />
        </li>
        <li className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 py-2.5">
          <div>
            <strong>② 자료 {d.files.length}개 올리기</strong>
            <span className="block text-xs text-muted-foreground">{d.files.length === 0 ? "고른 자료 없음" : failed ? `${d.files[1]?.path} — 연결이 끊겨 올리지 못했습니다. 프로젝트는 이미 만들어졌습니다.` : "파일마다 예약 → 올리기 → 완료"}</span>
          </div>
          {d.files.length === 0 ? (
            <Status of="generic" value="notyet" label="해당 없음" />
          ) : failed ? (
            <span className="flex flex-wrap items-center gap-2">
              <Chip shape="tri" tone="warn">
                {d.files.length - 1} / {d.files.length}
              </Chip>
              <Button size="sm" onClick={() => setRetried(true)}>
                다시 올리기
              </Button>
            </span>
          ) : (
            <Status of="upload" value="ready" label={`${d.files.length} / ${d.files.length}`} />
          )}
        </li>
        <li className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 py-2.5">
          <div>
            <strong>③ 참고 프로젝트 붙이기</strong>
            <span className="block text-xs text-muted-foreground">{d.refOn ? "장기요양 기관 실태 분석(가상) · 고른 버전" : "붙이지 않음"}</span>
          </div>
          {d.refOn ? <Status of="generic" value="attached" /> : <Status of="generic" value="notyet" label="해당 없음" />}
        </li>
        <li className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 py-2.5">
          <div>
            <strong>④ 기획 시작 질문 준비</strong>
            <span className="block text-xs text-muted-foreground">질문 은행에서 6개 · 단계 시작(라운드 전)</span>
          </div>
          <Status of="extract" value="ready" label="준비됨" />
        </li>
      </ol>
      <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
        <Button asChild variant="default">
          <Link to="/p/rural-care-access/e/1/s/plan/r/start">작업 공간 열기 — 시작 질문에 답하기</Link>
        </Button>
      </div>
      <Anno>①만 원자이고 ②③은 각자의 명령이라 일부 실패를 줄마다 보이고 프로젝트 안에서 다시 시도합니다. 이 시안에서는 “농촌 의료 접근성”(방식 A, 기획 단계 시작) 장면으로 이어집니다 — 방식 B 조사 R2 장면과 섞이지 않게 했습니다(R06).</Anno>
    </Card>
  );
}
