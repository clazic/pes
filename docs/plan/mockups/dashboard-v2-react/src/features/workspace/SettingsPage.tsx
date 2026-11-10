import * as React from "react";
import { Link } from "react-router";
import { useCommand, useUsage } from "@/api/queries";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Anno, CardHead, Hint, SectionTitle, Tag } from "@/components/pes/bits";
import { Callout } from "@/components/pes/blocks";
import { ConfirmDialog, type ConfirmSpec } from "@/components/pes/confirm";
import { ActionButton, StateSwitch } from "@/components/pes/controls";
import { FoldCard, InfoTip } from "@/components/pes/disclosure";
import { Status } from "@/components/pes/status";
import { STATUS } from "@/components/pes/status-registry";
import { BILLING_LABEL, KIND_LABEL, won } from "@/mocks/connections";
import { useMockSettings } from "@/lib/mock-settings";
import { cn } from "@/lib/utils";
import { useWs, WorkspaceFrame } from "./WorkspaceLayout";

function useIsPhone() {
  const q = "(max-width: 899.98px) and (pointer: coarse)";
  const [m, setM] = React.useState(() => window.matchMedia(q).matches);
  React.useEffect(() => {
    const mq = window.matchMedia(q);
    const on = () => setM(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return m;
}

export function SettingsPage() {
  const { ws } = useWs();
  const usage = useUsage();
  const settings = useMockSettings();
  const owner = settings.role === "owner";
  const phone = useIsPhone();
  const transfer = useCommand("policy.api_transfer.revise");
  const setConn = useCommand("project.ai_connection.set");
  const [dialog, setDialog] = React.useState<null | "off" | "on" | "model">(null);
  const isOn = ws.api_transfer.value === "on";
  // 스위치 글자는 상태 사전(transfer)의 짧은 글자 — 허용 / 막음(4차 사용자 결정)
  const ALLOW = STATUS.transfer.on!.short!;
  const BLOCK = STATUS.transfer.off!.short!;

  const conns = usage.data?.connections ?? [];
  const [connId, setConnId] = React.useState("conn-sub");
  const conn = conns.find((c) => c.id === connId);
  const [model, setModel] = React.useState("deepseek-v4.1-flash");
  React.useEffect(() => {
    const def = conn?.models.find((m) => m.is_default && m.available);
    if (def) setModel(def.id);
  }, [connId, conn]);
  const modelDef = conn?.models.find((m) => m.id === model);
  const modelWhy = !conn ? "연결을 고르세요." : conn.billing === "metered" && !conn.metered?.cap ? "이 연결에는 비용 상한이 없어 시작할 수 없습니다." : modelDef?.price?.source === "unknown" ? "이 모델은 단가를 몰라 비용을 셀 수 없습니다 — 단가를 적어야 고를 수 있습니다." : !modelDef?.available ? "지금 목록에 없는 모델입니다." : null;

  const offSpec: ConfirmSpec = {
    eyebrow: "소유자만",
    title: "이 프로젝트의 AI가 읽기를 막을까요?",
    target: `${ws.title} · AI가 읽기 정책 3번(rev 3)`,
    verb: "AI가 읽기 막기",
    changes: ["지금부터 모든 AI 연결(API)이 이 프로젝트 자료를 읽지 못합니다 — 방식 A 실행·재시도·요약이 막힙니다.", "B 도구가 API 목적지로 보내는 읽기도 막습니다(그 밖의 B 도구는 파일 AI 참조만 따름).", "막는 동안 나가던 전송은 결과를 확인해 “확인 안 된 전송”으로 남깁니다."],
    unchanged: [<strong key="a">이미 보낸 자료는 회수되지 않습니다.</strong>, "사람의 답·첨언·자료 올리기는 계속됩니다.", "다시 켜도 멈춘 실행은 저절로 다시 시작하지 않습니다."],
    stepUp: true,
    tightening: true,
    danger: true,
    footnote: "막기는 휴대폰에서도 됩니다. 정책 변경이므로 이 요청 한 건에 대한 본인 확인은 생략하지 않습니다(Codex F01).",
  };
  const onSpec: ConfirmSpec = {
    eyebrow: "소유자만 · 데스크톱에서",
    title: "이 프로젝트의 AI가 읽기를 다시 허용할까요?",
    target: `${ws.title} · AI가 읽기 정책 4번 만들기(rev 4)`,
    verb: "AI가 읽기 다시 허용",
    changes: ["허용된 자료를 다시 AI 연결(API)이 읽을 수 있게 됩니다(AI 참조 금지 파일은 계속 빠짐)."],
    unchanged: ["멈춘 실행은 저절로 다시 시작하지 않습니다 — 사람이 ‘계속’을 누릅니다.", "확인 안 된 전송 기록은 그대로 남습니다."],
    reasonRequired: true,
    stepUp: true,
  };
  const modelSpec: ConfirmSpec = {
    eyebrow: "소유자만",
    title: `방식 A 연결·모델을 ${conn?.name ?? "?"} · ${model}(으)로 바꿀까요?`,
    target: `${ws.title} · 정책 rev 3 → rev 4`,
    verb: "연결·모델 바꾸기",
    changes: ["다음 실행부터 이 연결·모델로 시작합니다.", conn?.billing === "metered" ? `쓴 만큼 과금 — 월 비용 상한 ${conn.metered?.cap ? won(conn.metered.cap.amount) : "없음"}에서 멈춥니다.` : `구독 한도 안 — 멈춤 문턱 ${conn?.subscription?.stop_percent ?? 90}%에서 멈춥니다.`],
    unchanged: ["진행 중이거나 멈춘 실행은 시작할 때 고른 모델 그대로 갑니다(실패해도 다른 모델로 자동으로 바꾸지 않음).", "AI가 읽기와 파일 AI 참조는 모든 AI 연결에 똑같이 적용됩니다."],
    stepUp: true,
  };

  const reqOff = () => setDialog("off");
  const reqOn = () => setDialog("on");

  return (
    <WorkspaceFrame active="settings">
      <SectionTitle as="h2" title="프로젝트 설정" sub={owner ? undefined : "읽기만 — 바꾸기는 소유자"} className="mt-6" />
      <div className="grid grid-cols-1 gap-3 wide:grid-cols-2">
        <Card size="compact" aria-labelledby="st-transfer">
          <CardHead
            eyebrow="자료 보내기"
            title="AI가 읽기"
            aside={
              <InfoTip label="AI가 읽기 설명" wide>
                <p>등록된 AI 연결(API)이 이 프로젝트 자료를 읽게 할지 정합니다. 읽는 것: 질문·답, 결과물, AI 참조를 허용한 자료의 뽑은 글자, 허용된 참고자료.</p>
                <p>막으면 방식 A를 쓸 수 없고 방식 B나 사람 작업으로 갑니다. 내 컴퓨터 AI 도구(방식 B)가 PES를 거쳐 읽는 것은 파일별 AI 참조를 따릅니다. 바꿀 때마다 이유 · 지울 수 없는 이력 · 영수증이 남습니다.</p>
              </InfoTip>
            }
            titleId="st-transfer"
          />
          <div className="flex flex-wrap items-center gap-3">
            <StateSwitch
              checked={isOn}
              onLabel={ALLOW}
              offLabel={BLOCK}
              name="AI가 읽기"
              pending={transfer.pending}
              blockedBy={!owner ? "AI가 읽기는 소유자만 바꿀 수 있습니다." : !isOn && phone ? "다시 허용은 데스크톱에서 합니다(느슨해지는 동작)." : null}
              onRequest={(next) => (next ? reqOn() : reqOff())}
            />
          </div>
          <Hint className="mt-2">모든 AI 연결에 똑같이 적용 · 이미 보낸 자료는 회수되지 않음</Hint>
          {!owner ? <Hint className="mt-2">지금 상태는 볼 수 있습니다. 바꿔야 하면 첨언으로 소유자에게 알리세요.</Hint> : null}
        </Card>

        <Card size="compact" aria-labelledby="st-model">
          <CardHead eyebrow="방식 A" title="AI 연결 · 모델" titleId="st-model" right={<Tag>지금: {ws.runner_label}</Tag>} />
          {ws.mode === "B" ? (
            <Callout tone="off">
              방식 B — 모델은 내 컴퓨터 도구에서 고릅니다. <strong>B 비용은 PES가 막지 못합니다.</strong> 방식 A로 넘길 때 여기서 고릅니다.
            </Callout>
          ) : null}
          <fieldset className="mt-2">
            <legend className="mb-1.5 text-meta font-semibold">쓸 AI 연결</legend>
            <RadioGroup value={connId} onValueChange={setConnId} className="gap-1.5" aria-label="쓸 AI 연결">
              {conns.map((c) => (
                <label key={c.id} htmlFor={`sc-${c.id}`} className={cn("flex cursor-pointer items-start gap-2 rounded-lg border px-2.5 py-2 text-meta", connId === c.id ? "border-primary bg-primary-soft" : "border-line")}>
                  <RadioGroupItem id={`sc-${c.id}`} value={c.id} className="mt-0.5" />
                  <span className="min-w-0">
                    <strong>{c.name}</strong> <Tag>{KIND_LABEL[c.kind]}</Tag> <Tag tone={c.billing === "metered" ? "warn" : "plain"}>{BILLING_LABEL[c.billing]}</Tag>
                    <span className="block text-xs text-muted-foreground">
                      {c.billing === "metered" ? `월 비용 상한 ${c.metered?.cap ? won(c.metered.cap.amount) : "없음 — 시작 못 함"}` : `멈춤 문턱 ${c.subscription?.stop_percent}%`} · 연결 시험 {c.test.at ?? "안 함"}
                    </span>
                  </span>
                </label>
              ))}
            </RadioGroup>
          </fieldset>
          <div className="mt-2.5">
            <Label htmlFor="st-model-pick" className="text-meta font-semibold">
              모델
            </Label>
            <Select value={model} onValueChange={setModel}>
              <SelectTrigger id="st-model-pick" className="mt-1 w-full">
                <SelectValue placeholder="모델 고르기" />
              </SelectTrigger>
              <SelectContent>
                {conn?.models.map((m) => (
                  <SelectItem key={m.id} value={m.id} disabled={!m.available}>
                    {m.id}
                    {!m.available ? " — 지금 목록에 없음" : m.price?.source === "unknown" ? " — 단가 모름" : m.weight_known === false ? " — 사용량 가중치 미확인" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {modelDef?.price ? <Hint className="mt-1">{modelDef.price.text}</Hint> : null}
          </div>
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <ActionButton variant="default" blockedBy={!owner ? "AI 연결·모델은 소유자만 바꿀 수 있습니다." : modelWhy} onClick={() => setDialog("model")}>
              바꾸기
            </ActionButton>
            <Button asChild size="sm">
              <Link to="/usage#connections">AI 연결 관리 · 추가</Link>
            </Button>
            <InfoTip label="연결·모델 바꾸기 설명">
              <p>실행 하나는 시작할 때 고른 모델 하나로만 갑니다. 실패해도 다른 모델로 자동으로 바꾸지 않습니다. 바꾸면 다음 실행부터 적용됩니다.</p>
            </InfoTip>
          </div>
        </Card>
      </div>

      <FoldCard className="mt-3" title="정책 이력" meta="3건 · 지울 수 없음">
        <Table regionLabel="정책 이력" className="min-w-[600px]">
          <TableCaption className="sr-only">정책 이력 (지울 수 없음)</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">번호</TableHead>
              <TableHead scope="col">AI가 읽기</TableHead>
              <TableHead scope="col">연결 · 모델</TableHead>
              <TableHead scope="col">바꾼 사람 · 시각</TableHead>
              <TableHead scope="col">이유</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>1</TableCell>
              <TableCell><Status of="transfer" value="on" short /></TableCell>
              <TableCell>연구실 구독 API · deepseek-v4.1-flash</TableCell>
              <TableCell>김연구 · 11-01 09:00</TableCell>
              <TableCell>만들 때 처음 정책</TableCell>
            </TableRow>
            <TableRow>
              <TableCell>2</TableCell>
              <TableCell><Status of="transfer" value="off" short /></TableCell>
              <TableCell>—</TableCell>
              <TableCell>김연구 · 11-03 10:00</TableCell>
              <TableCell>기관 자료 확인 전 잠시 막음</TableCell>
            </TableRow>
            <TableRow>
              <TableCell>3</TableCell>
              <TableCell><Status of="transfer" value="on" short /></TableCell>
              <TableCell>—</TableCell>
              <TableCell>김연구 · 11-03 16:20(재인증)</TableCell>
              <TableCell>확인 끝 — 다시 허용</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </FoldCard>
      <Anno>멤버 · 에이전트 키 · 연결된 앱(5단계), 판·보관(4단계)은 이 시안 밖입니다. 자동 재개 옵션(R1, 기본 꺼짐)은 사람이 답한 뒤에만 쓰이고, 사용량 때문에 멈춘 실행은 언제나 사람이 계속을 누릅니다.</Anno>

      <ConfirmDialog
        open={dialog === "off" || dialog === "on"}
        onOpenChange={(o) => {
          if (!o) {
            setDialog(null);
            transfer.reset();
          }
        }}
        spec={dialog === "on" ? onSpec : offSpec}
        phase={transfer.phase}
        receipt={transfer.receipt}
        errorText={transfer.error?.message}
        onRecheck={transfer.recheck}
        onConfirm={(reason, stepUp) => transfer.run({ slug: ws.slug, allow: dialog === "on", reason, step_up: stepUp })}
      />
      <ConfirmDialog
        open={dialog === "model"}
        onOpenChange={(o) => {
          if (!o) {
            setDialog(null);
            setConn.reset();
          }
        }}
        spec={modelSpec}
        phase={setConn.phase}
        receipt={setConn.receipt}
        errorText={setConn.error?.message}
        onRecheck={setConn.recheck}
        onConfirm={(_reason, stepUp) => setConn.run({ slug: ws.slug, connection_id: connId, model, step_up: stepUp })}
      />
    </WorkspaceFrame>
  );
}
