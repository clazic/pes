import * as React from "react";
import { Link } from "react-router";
import { useNotifications, useWorkspace } from "@/api/queries";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Anno, CardHead, SectionTitle } from "@/components/pes/bits";
import { InfoTip, More } from "@/components/pes/disclosure";
import { LoadError, QuietLoading } from "@/components/pes/blocks";
import { Status, StatusFrom } from "@/components/pes/status";

const EVENTS = ["답 대기", "승인 대기", "새 질문", "실행 실패·중단", "실행 멈춤 · 사용량", "재개 준비됨", "동기화 충돌", "추가 요금 확인 만료 임박", "토큰 만료 임박", "백업 실패", "이전 완료"];

/** 알림 /notifications(설계 4.13, WEB8) */
export function NotificationsPage() {
  const q = useNotifications();
  const ws = useWorkspace("dolbom-insight");
  const conflictResolved = ws.data?.sync?.rows.find((r) => r.item.startsWith("현장 면담"))?.status.value === "synced";
  const [detail, setDetail] = React.useState(false);
  if (q.isPending) return <div className="mt-3"><QuietLoading what="알림" /></div>;
  if (q.isError || !q.data) return <div className="mt-3"><LoadError what="알림" lastReceived="—" code="N-0001" onRetry={() => q.refetch()} /></div>;
  return (
    <>
      <SectionTitle
        as="h1"
        title="알림"
        sub={
          <span className="inline-flex flex-wrap items-center gap-1">
            사람이 행동할 사건만
            <InfoTip label="알림 문구 설명">
              <p>기본 문구에는 프로젝트 이름·질문 문구·파일 이름을 싣지 않습니다. 누르면 로그인 뒤 정확한 버전으로 갑니다. 이미 처리된 사건은 지금 할 일로 되살리지 않습니다(R04).</p>
            </InfoTip>
          </span>
        }
      />
      <div className="grid grid-cols-1 items-start gap-3 desk:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Card className="gap-0 px-5" aria-labelledby="nt-list">
          <CardHead title="알림 목록" titleId="nt-list" />
          <ul className="divide-y divide-line">
            {q.data.map((n) => {
              const resolved = n.id === "n4" && conflictResolved;
              return (
                <li key={n.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-meta">
                  <span className="min-w-0">
                    {n.unread ? <span className="sr-only">안 읽음: </span> : null}
                    <Link to={n.href} className={n.unread ? "font-semibold" : ""}>
                      {n.title}
                    </Link>
                    <span className="block text-xs text-muted-foreground">
                      {n.at} · {n.channel}
                    </span>
                  </span>
                  <span className="flex flex-wrap gap-1.5">
                    {/* 보냄(정상)은 표시하지 않고, 확인 안 됨 같은 예외만 칩으로(정보 밀도 14절) */}
                    {n.delivery.value !== "sent" || n.delivery.label ? <StatusFrom s={n.delivery} /> : null}
                    {resolved ? <Status of="generic" value="done" label="이미 처리됨 · 지금 할 일 아님" /> : null}
                  </span>
                </li>
              );
            })}
          </ul>
        </Card>
        <Card className="gap-0 px-5" aria-labelledby="nt-set">
          <CardHead
            title="알림 설정"
            titleId="nt-set"
            aside={
              <InfoTip label="알림 설정 설명">
                <p>사람마다 따로 정합니다. 보내기 직전에 권한을 다시 검사합니다. 아이폰 푸시는 홈 화면에 추가해야 받습니다.</p>
              </InfoTip>
            }
          />
          <div className="space-y-2.5 text-meta">
            <div className="flex items-center justify-between gap-2 coarse:min-h-[44px]">
              <Label htmlFor="nt-mail" className="font-medium">메일(기본)</Label>
              <Switch id="nt-mail" defaultChecked />
            </div>
            <div className="flex items-center justify-between gap-2 coarse:min-h-[44px]">
              <Label htmlFor="nt-push" className="font-medium">푸시</Label>
              <Switch id="nt-push" defaultChecked />
            </div>
            <div className="flex items-center justify-between gap-2 coarse:min-h-[44px]">
              <Label htmlFor="nt-detail" className="font-medium">상세 제목(프로젝트 이름 등)</Label>
              <Switch id="nt-detail" checked={detail} onCheckedChange={setDetail} />
            </div>
            <p className="text-ink-2">조용한 시간 22:00~08:00 · 실패·보안만</p>
            <More label={`사건별 설정 ${EVENTS.length}`}>
            <fieldset>
              <legend className="sr-only">사건별</legend>
              <ul className="space-y-1.5 text-meta text-ink">
                {EVENTS.map((e, i) => (
                  <li key={e} className="flex items-center justify-between gap-2 coarse:min-h-[44px]">
                    <Label htmlFor={`ev-${i}`} className="font-normal">
                      {e}
                    </Label>
                    <Switch id={`ev-${i}`} defaultChecked={i < 8} />
                  </li>
                ))}
              </ul>
            </fieldset>
            </More>
          </div>
        </Card>
      </div>
      <Anno>B의 “AI 미접속”은 알림을 보내지 않고 화면에만 보입니다(소음 방지). 추가 사건(실행 멈춤 · 재개 준비됨 · 동기화 충돌 · 추가 요금 확인 만료 임박)은 WEB8에서 정하고, 메일 하루 100통 안인지 WEB8·WEB12에서 계측합니다(설계 G21).</Anno>
    </>
  );
}
