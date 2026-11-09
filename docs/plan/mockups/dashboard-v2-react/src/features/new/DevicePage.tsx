import * as React from "react";
import { useCommand } from "@/api/queries";
import { Card } from "@/components/ui/card";
import { Anno, Eyebrow, KV, SectionTitle } from "@/components/pes/bits";
import { Callout } from "@/components/pes/blocks";
import { InfoTip } from "@/components/pes/disclosure";
import { ActionButton } from "@/components/pes/controls";
import { Status } from "@/components/pes/status";
import { useMockSettings } from "@/lib/mock-settings";

/** 기기 승인(설계 4.4): 코드가 같을 때만 승인 · 사람 자격 · 에이전트 키로 대행 불가 */
export function DevicePage() {
  const settings = useMockSettings();
  const cmd = useCommand("device.approve", { successText: (r) => `처리됨 · 접수 번호 ${r.receipt_no}` });
  const [decision, setDecision] = React.useState<"approve" | "deny" | null>(null);
  const why = settings.role !== "owner" ? "기기 승인은 로그인한 사람(등록하면 소유자)만 할 수 있습니다." : cmd.pending ? "접수 확인 중입니다" : null;
  const state = cmd.phase === "done" ? (decision === "approve" ? "approved" : "denied") : "waiting";
  return (
    <>
      <SectionTitle as="h1" title="기기 승인" sub="내 컴퓨터 화면의 코드와 같을 때만 승인하세요." />
      <div className="grid grid-cols-1 gap-3 desk:grid-cols-2">
        <Card className="gap-0 border-2 border-mode-b-line px-4" aria-labelledby="dev-t">
          <Eyebrow>기기 승인 · 10분 안에</Eyebrow>
          <h2 id="dev-t" className="flex flex-wrap items-center gap-2 text-title">
            이 기기가 프로젝트를 등록하려고 합니다 <Status of="device" value={state} />
          </h2>
          <p className="my-1 inline-block w-fit rounded-lg border border-line-strong bg-surface-soft px-3 py-1 font-mono text-[18px] font-semibold tracking-[0.12em]" aria-label="코드 K X R M 4 8 2 1">
            KXRM-4821
          </p>
          <KV
            className="mt-1.5"
            items={[
              ["기기", "연구실 노트북 (사람이 붙인 이름)"],
              ["도구", "Claude Code — 도구가 알린 이름"],
              ["프로젝트", "지역 돌봄 인력 수급 개선 연구(가상)"],
              ["요청 시각", "11-05 14:40"],
            ]}
          />
          <Callout tone="warn" className="mt-2.5">
            <span className="inline-flex flex-wrap items-center gap-1">
              코드가 다르면 <strong>거절</strong>하세요.
              <InfoTip label="기기 승인 설명">
                <p>이 승인은 사람 자격이며, 에이전트 키로는 할 수 없습니다. 5단계 웹에서는 승인 전에 본인 확인(재인증)을 받습니다.</p>
              </InfoTip>
            </span>
          </Callout>
          {cmd.phase === "done" ? (
            <Callout tone={decision === "approve" ? "ok" : "off"} role="status" className="mt-2.5">
              {decision === "approve" ? "등록됨 — 목록에 “방식 B · Claude Code” 카드가 생깁니다." : "거절함 — 이 요청은 더 쓰이지 않습니다."} 접수 번호 {cmd.receipt?.receipt_no}
            </Callout>
          ) : null}
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <ActionButton variant="destructive" blockedBy={why} onClick={() => { setDecision("deny"); cmd.run({ code: "KXRM-4821", decision: "deny" }); }}>
              거절
            </ActionButton>
            <ActionButton variant="default" blockedBy={why} onClick={() => { setDecision("approve"); cmd.run({ code: "KXRM-4821", decision: "approve" }); }}>
              코드가 같음 — 승인
            </ActionButton>
          </div>
        </Card>
        {/* 다른 상태 견본(시안) — 지금 장면이 아니므로 시안 설명 상자와 함께 숨김 */}
        <Card className="gap-0 px-5" aria-labelledby="dev-states" data-mock="note">
          <h2 id="dev-states" className="text-title">
            다른 상태
          </h2>
          <ul className="mt-2 space-y-2 text-meta">
            <li>
              <Status of="device" value="expired" /> 코드 만료 — “내 컴퓨터에서 다시 요청하세요”
            </li>
            <li>
              <Status of="generic" value="duplicate" label="이미 등록된 주소" /> — “그 프로젝트 열기”
            </li>
            <li>
              <Status of="device" value="denied" /> 다른 계정의 요청 — 승인할 수 없음
            </li>
            <li>
              <Status of="submission" value="pending" /> 응답이 늦어 같은 요청 번호로 확인 중
            </li>
            <li>
              <Status of="device" value="approved" /> 등록됨 — 기기 목록에 “연구실 노트북”
            </li>
          </ul>
        </Card>
      </div>
      <Anno>기기 승인은 WEB2(/auth/device/*), 등록은 PR14(POST /api/v1/project-registrations) · 종단 시험 PR20a · 화면 WEB3. 2~4단계 로컬은 같은 등록을 로컬 PES에 합니다.</Anno>
    </>
  );
}
