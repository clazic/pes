import * as React from "react";
import { FingerprintIcon, MonitorIcon, PlugZapIcon, RefreshCwIcon } from "lucide-react";
import { useCommand } from "@/api/queries";
import type { AiConnection } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { Hint } from "@/components/pes/bits";
import { Callout } from "@/components/pes/blocks";
import { InfoTip } from "@/components/pes/disclosure";
import { ActionButton } from "@/components/pes/controls";
import { Chip, Status } from "@/components/pes/status";
import { BILLING_LABEL, KIND_LABEL, STORAGE_LABEL } from "@/mocks/connections";
import { useMockSettings } from "@/lib/mock-settings";
import { cn } from "@/lib/utils";

/**
 * AI 연결 추가(사용자 결정 2026-11-05: AI를 수동으로 등록, 특정 서비스에 묶지 않음 — 결정 0013 일부 변경 필요).
 * - 키는 입력 뒤 다시 보이지 않는다(끝 4자리만). 화면·기록·AI 프롬프트에 남기지 않는다. 저장 위치를 보인다.
 * - 연결 시험·모델 목록은 PES 서버가 한다. 브라우저가 외부 API를 직접 부르지 않는다.
 * - 쓴 만큼 과금은 비용 상한이 없으면 저장하지 않는다(상한이 없으면 실행을 시작하지 않음).
 * - 등록·변경은 소유자만, 요청 한 건마다 본인 확인.
 */

const KINDS: AiConnection["kind"][] = ["subscription", "openai_compatible", "anthropic", "google", "custom"];
const PLACEHOLDER: Record<AiConnection["kind"], string> = {
  subscription: "https://api.example.com/v1",
  openai_compatible: "https://api.example.org/v1",
  anthropic: "https://api.example.net/v1",
  google: "https://api.example.net/v1beta",
  custom: "http://127.0.0.1:8000/v1 (내 컴퓨터 모델 — 로컬 PES에서만)",
};

export function AddConnectionDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated?: (id: string, models: string[]) => void }) {
  const settings = useMockSettings();
  const owner = settings.role === "owner";
  const [kind, setKind] = React.useState<AiConnection["kind"]>("openai_compatible");
  const [name, setName] = React.useState("");
  const [endpoint, setEndpoint] = React.useState("");
  const [key, setKey] = React.useState("");
  const [billing, setBilling] = React.useState<AiConnection["billing"]>("metered");
  const [modelsText, setModelsText] = React.useState("");
  const [stop, setStop] = React.useState(90);
  const [extra, setExtra] = React.useState(true);
  const [cap, setCap] = React.useState("");
  const [stage, setStage] = React.useState<"form" | "stepup" | "done">("form");
  const [modelNote, setModelNote] = React.useState("");
  const test = useCommand("ai_connection.test", { silent: true });
  const models = useCommand("ai_connection.models.refresh", { silent: true });
  const create = useCommand("ai_connection.create");
  const keyId = React.useId();

  React.useEffect(() => {
    if (open) {
      setStage("form");
      setKey("");
      test.reset();
      models.reset();
      create.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const modelList = modelsText
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const capNum = Number(cap.replace(/[^\d]/g, ""));
  const missing: string[] = [];
  if (!name.trim()) missing.push("이름");
  if (!endpoint.trim()) missing.push("주소");
  if (kind !== "custom" && !key) missing.push("API 키");
  if (modelList.length === 0) missing.push("모델(불러오기 또는 직접 입력)");
  if (billing === "metered" && !(capNum > 0)) missing.push("월 비용 상한(쓴 만큼 과금은 필수)");
  if (test.phase !== "done") missing.push("연결 시험 통과");
  const blocked = !owner ? "AI 연결 등록은 소유자(연결 관리자)만 할 수 있습니다." : missing.length ? `아직 필요한 것: ${missing.join(", ")}` : null;

  const doTest = () => test.run({ kind, endpoint, key_present: key.length > 0, key_length: key.length });
  const loadModels = () =>
    models.runAsync({ kind, endpoint }).then((r) => {
      const d = r.data as { models: string[]; note: string };
      if (d.models.length) setModelsText(d.models.join("\n"));
      setModelNote(d.note);
    });

  const save = (method: "passkey" | "local_owner") =>
    create.runAsync({ name, kind, endpoint, key, billing, models: modelList, stop_percent: stop, extra_usage_applicable: extra, cap: billing === "metered" ? { amount: capNum, currency: "KRW" } : null, step_up: { method, bound: `AI 연결 등록 · ${name}` } }).then((r) => {
      setKey(""); // 키는 곧바로 버린다
      setStage("done");
      const d = r.data as { id: string };
      onCreated?.(d.id, modelList);
    });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>AI 연결 추가</DialogTitle>
          <DialogDescription>쓸 AI의 API 주소와 키를 직접 등록합니다. 특정 서비스에 묶지 않고, 프로젝트마다 연결과 모델을 고릅니다.</DialogDescription>
        </DialogHeader>

        {stage === "done" ? (
          <Callout tone="ok" role="status">
            <Chip shape="circle" tone="ok">
              등록됨
            </Chip>{" "}
            접수 번호 {create.receipt?.receipt_no}. 키는 저장 위치({STORAGE_LABEL.os_keychain})에만 있고 이 화면에는 다시 보이지 않습니다. 끝 4자리만 보입니다.
          </Callout>
        ) : stage === "stepup" ? (
          <div className="rounded-xl border border-line-strong bg-surface-soft p-3.5">
            <h3 className="text-[15px]">본인 확인이 필요합니다</h3>
            <p className="mt-1.5 text-[13px]">이 확인은 이 요청 한 건에만 쓰입니다: AI 연결 등록 · {name} · {BILLING_LABEL[billing]}.</p>
            <div className="mt-3 flex flex-col gap-2">
              <Button variant="default" disabled={create.pending} onClick={() => void save("passkey")}>
                <FingerprintIcon aria-hidden="true" />
                패스키로 확인(5단계 웹)
              </Button>
              <Button disabled={create.pending} onClick={() => void save("local_owner")}>
                <MonitorIcon aria-hidden="true" />
                이 컴퓨터의 소유자 세션으로 확인(2~4단계 로컬)
              </Button>
            </div>
            {create.phase === "confirming" ? <p role="status" className="mt-2 text-[13px]"><Status of="submission" value="pending" /> 같은 요청 번호로 확인 중입니다.</p> : null}
            {create.error ? <p role="alert" className="mt-2 text-[13px] font-medium text-bad">{create.error.message}</p> : null}
          </div>
        ) : (
          <div className="space-y-3">
            <fieldset>
              <legend className="mb-1.5 text-[13px] font-semibold">종류</legend>
              <RadioGroup value={kind} onValueChange={(v) => setKind(v as AiConnection["kind"])} className="grid grid-cols-1 gap-1.5 tab:grid-cols-2" aria-label="AI 연결 종류">
                {KINDS.map((k) => (
                  <label key={k} htmlFor={`kind-${k}`} className={cn("flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-2 text-[13px]", kind === k ? "border-primary bg-primary-soft" : "border-line")}>
                    <RadioGroupItem id={`kind-${k}`} value={k} />
                    {KIND_LABEL[k]}
                  </label>
                ))}
              </RadioGroup>
            </fieldset>
            <div className="grid grid-cols-1 gap-3 tab:grid-cols-2">
              <div>
                <Label htmlFor="cn-name" className="text-[13px] font-semibold">
                  이름 <span className="font-normal text-muted-foreground">(사람이 알아보는 이름)</span>
                </Label>
                <Input id="cn-name" className="mt-1" placeholder="예: 연구실 종량제 API" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="cn-url" className="text-[13px] font-semibold">
                  주소(endpoint)
                </Label>
                <Input id="cn-url" className="mt-1" placeholder={PLACEHOLDER[kind]} value={endpoint} onChange={(e) => setEndpoint(e.target.value)} />
              </div>
            </div>
            <div>
              <Label htmlFor={keyId} className="text-[13px] font-semibold">
                API 키 {kind === "custom" ? <span className="font-normal text-muted-foreground">(없으면 비워 둠)</span> : null}
              </Label>
              <Input id={keyId} className="mt-1" type="password" autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} aria-describedby={`${keyId}-h`} />
              <p className="mt-1 flex flex-wrap items-center gap-1 text-[12.5px] text-muted-foreground">
                <span id={`${keyId}-h`}>저장하면 다시 보이지 않습니다(끝 4자리만).</span>
                <InfoTip label="API 키 저장 설명" wide>
                  <p>저장 위치: {STORAGE_LABEL.os_keychain} / 웹에서는 {STORAGE_LABEL.server_secret}. 키는 로그·화면·AI 프롬프트·기록에 남기지 않고, 브라우저에 두지 않습니다.</p>
                </InfoTip>
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={doTest} aria-disabled={!endpoint || test.pending || undefined}>
                <PlugZapIcon aria-hidden="true" />
                연결 시험
              </Button>
              <span role="status">
                {test.phase === "done" ? <Status of="connTest" value="ok" label={`연결됨 · ${test.receipt?.committed_at}`} /> : test.phase === "error" ? <Status of="connTest" value="failed" /> : test.pending ? <Status of="connTest" value="testing" /> : <Status of="connTest" value="never" />}
              </span>
              {test.error ? (
                <span className="text-xs font-medium text-bad">{test.error.message}</span>
              ) : (
                <InfoTip label="연결 시험 설명">
                  <p>PES 서버가 시험합니다 — 브라우저가 외부 API를 직접 부르지 않습니다.</p>
                </InfoTip>
              )}
            </div>
            <div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Label htmlFor="cn-models" className="text-[13px] font-semibold">
                  모델 <span className="font-normal text-muted-foreground">(한 줄에 하나 · 첫 줄이 기본)</span>
                </Label>
                <Button size="sm" onClick={() => void loadModels()} aria-disabled={!endpoint || undefined}>
                  <RefreshCwIcon aria-hidden="true" />
                  모델 목록 불러오기
                </Button>
              </div>
              <Textarea id="cn-models" className="mt-1" rows={3} placeholder="목록을 주지 않는 주소면 직접 입력" value={modelsText} onChange={(e) => setModelsText(e.target.value)} />
              {modelNote ? <Hint className="mt-1">{modelNote}</Hint> : null}
            </div>
            <fieldset>
              <legend className="mb-1.5 text-[13px] font-semibold">과금 방식</legend>
              <RadioGroup value={billing} onValueChange={(v) => setBilling(v as AiConnection["billing"])} className="grid grid-cols-1 gap-1.5 tab:grid-cols-2" aria-label="과금 방식">
                {(["subscription", "metered"] as const).map((b) => (
                  <label key={b} htmlFor={`bill-${b}`} className={cn("flex cursor-pointer items-start gap-2 rounded-lg border px-2.5 py-2 text-[13px]", billing === b ? "border-primary bg-primary-soft" : "border-line")}>
                    <RadioGroupItem id={`bill-${b}`} value={b} className="mt-0.5" />
                    <span>
                      <strong>{BILLING_LABEL[b]}</strong>
                      <span className="block text-xs text-muted-foreground">{b === "subscription" ? "구독 사용량 안에서만 · 멈춤 문턱에서 멈춤" : "쓴 만큼 돈이 나감 · 월 비용 상한 필수"}</span>
                    </span>
                  </label>
                ))}
              </RadioGroup>
            </fieldset>
            {billing === "subscription" ? (
              <div className="grid grid-cols-1 gap-3 tab:grid-cols-2">
                <div>
                  <Label htmlFor="cn-stop" className="text-[13px] font-semibold">
                    멈춤 문턱(%)
                  </Label>
                  <Input id="cn-stop" type="number" min={50} max={100} step={5} className="mt-1 max-w-[120px]" value={stop} onChange={(e) => setStop(Number(e.target.value))} />
                  <Hint className="mt-1">이 값에 닿기 전에 새 호출을 멈춤 · 기본 90%</Hint>
                </div>
                <div className="flex items-start gap-2 pt-6 text-[13px]">
                  <Checkbox id="cn-extra" checked={extra} onCheckedChange={(c) => setExtra(c === true)} className="mt-0.5" />
                  <Label htmlFor="cn-extra" className="block leading-snug font-normal">
                    이 구독은 한도를 넘으면 추가 요금(Extra Usage)으로 이어질 수 있음 — 꺼짐 확인을 받은 뒤에만 시작
                  </Label>
                </div>
              </div>
            ) : (
              <div>
                <Label htmlFor="cn-cap" className="text-[13px] font-semibold">
                  월 비용 상한(원) <span className="font-medium text-bad">필수</span>
                </Label>
                <Input id="cn-cap" inputMode="numeric" className="mt-1 max-w-[200px]" placeholder="예: 50000" value={cap} onChange={(e) => setCap(e.target.value)} aria-invalid={billing === "metered" && !(capNum > 0) ? true : undefined} />
                <p className="mt-1 flex flex-wrap items-center gap-1 text-[12.5px] text-muted-foreground">
                  상한에 닿기 전에 멈춤 · 단가를 모르는 모델로는 시작하지 않음
                  <InfoTip label="비용 상한 설명" wide>
                    <p>추정 비용이 상한에 닿기 전에 다음 호출을 보내지 않고 멈춥니다. 모델 단가를 모르면 비용을 셀 수 없어 그 모델로는 시작하지 않습니다(0으로 두지 않음).</p>
                    <p>제공사 콘솔에서도 한도를 걸어 두세요 — PES는 제공사의 과금을 막을 수 없습니다. 같은 키를 다른 곳에서 쓰면 그 비용은 PES가 모릅니다.</p>
                  </InfoTip>
                </p>
              </div>
            )}
            <Callout tone="off">
              <span className="inline-flex flex-wrap items-center gap-1">
                <strong>AI가 읽기</strong>·<strong>AI 참조</strong> 스위치가 이 연결에도 똑같이 적용됩니다.
                <InfoTip label="스위치 적용 설명">
                  <p>내 컴퓨터·로컬 모델이어도 같은 스위치를 따릅니다(웹 PES에서는 내 컴퓨터 주소에 닿을 수 없음).</p>
                </InfoTip>
              </span>
            </Callout>
          </div>
        )}

        <DialogFooter>
          {stage === "done" ? (
            <Button variant="default" onClick={() => onOpenChange(false)}>
              닫기
            </Button>
          ) : (
            <>
              <Button onClick={() => (stage === "stepup" ? setStage("form") : onOpenChange(false))}>{stage === "stepup" ? "이전 단계로" : "취소"}</Button>
              {stage === "form" ? (
                <ActionButton variant="default" blockedBy={blocked} onClick={() => setStage("stepup")}>
                  저장 — 본인 확인으로
                </ActionButton>
              ) : null}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
