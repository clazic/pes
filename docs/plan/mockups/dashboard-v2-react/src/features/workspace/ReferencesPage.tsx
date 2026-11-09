import * as React from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Anno, CardHead, Hint, SectionTitle, Tag } from "@/components/pes/bits";
import { EmptyState } from "@/components/pes/blocks";
import { ReferenceTable } from "@/features/new/reference-pick";
import { ReferenceCard } from "./ResultPanel";
import { useWs, WorkspaceFrame } from "./WorkspaceLayout";
import { cn } from "@/lib/utils";

/** 참고로 고를 수 있는 스냅숏 — 승인본은 추천 기본값일 뿐, 다른 고정 스냅숏도 고를 수 있다(Codex F12·B5) */
export const SNAPSHOTS = [
  { id: "s-ed1", label: "1판 완료본 · 11-01", note: "완료본 · 추천", approved: true },
  { id: "s-r1a", label: "2판 R1 승인본 · 11-04", note: "단계 승인본", approved: true },
  { id: "s-r1x", label: "2판 R1 진행 중 스냅숏 · 11-04 18:00", note: "승인되지 않은 내용 — 승인본처럼 보이지 않게 표시", approved: false },
];

export function SnapshotPick({ value, onChange, name }: { value: string; onChange: (v: string) => void; name: string }) {
  return (
    <fieldset>
      <legend className="mb-1.5 text-meta font-semibold">고정할 버전</legend>
      <RadioGroup value={value} onValueChange={onChange} aria-label={`${name} 고정할 버전`} className="gap-1.5">
        {SNAPSHOTS.map((s) => (
          <label key={s.id} htmlFor={`${name}-${s.id}`} className={cn("flex cursor-pointer items-start gap-2 rounded-lg border px-2.5 py-2 text-meta", value === s.id ? "border-primary bg-primary-soft" : "border-line")}>
            <RadioGroupItem id={`${name}-${s.id}`} value={s.id} className="mt-0.5" />
            <span>
              <strong>{s.label}</strong> {s.approved ? <Tag tone="ok">{s.note}</Tag> : <Tag tone="warn">승인 안 됨</Tag>}
              {!s.approved ? <span className="block text-xs text-muted-foreground">{s.note}</span> : null}
            </span>
          </label>
        ))}
      </RadioGroup>
      <Hint className="mt-1">원본에 새 버전이 생겨도 저절로 바뀌지 않음 — “새 버전 있음”으로 알림</Hint>
    </fieldset>
  );
}

export function ReferencesPage() {
  const { ws } = useWs();
  const [attaching, setAttaching] = React.useState(false);
  const [snap, setSnap] = React.useState("s-ed1");
  return (
    <WorkspaceFrame active="refs">
      <SectionTitle as="h2" title="참고 프로젝트" sub="다른 프로젝트의 고정 버전을 읽기 전용으로 가리킵니다" className="mt-6" right={<Button variant="default" onClick={() => setAttaching((a) => !a)}>참고 프로젝트 붙이기</Button>} />
      {attaching ? (
        <Card className="mb-3 gap-3 px-4" aria-labelledby="attach-t">
          <CardHead eyebrow="붙이기" title="장기요양 기관 실태 분석(가상)" titleId="attach-t" />
          <SnapshotPick value={snap} onChange={setSnap} name="attach" />
          <fieldset>
            <legend className="mb-1.5 text-meta font-semibold">붙일 범위</legend>
            <div className="grid grid-cols-1 gap-x-3 gap-y-1.5 tab:grid-cols-3">
              {["최종 보고서", "조사 출처", "단계 보고서", "결정 기록", "질문·답", "첨부 파일"].map((s, i) => (
                <div key={s} className="flex items-center gap-2 text-meta">
                  <Checkbox id={`sc-${i}`} defaultChecked={i < 2} />
                  <Label htmlFor={`sc-${i}`} className="font-normal">
                    {s}
                  </Label>
                </div>
              ))}
            </div>
          </fieldset>
          <ReferenceTable />
          <div className="flex justify-end gap-2">
            <Button onClick={() => setAttaching(false)}>취소</Button>
            <Button variant="default" onClick={() => setAttaching(false)}>
              붙이기
            </Button>
          </div>
        </Card>
      ) : null}
      {ws.references.length ? (
        <div className="space-y-3">
          {ws.references.map((r, i) => (
            <ReferenceCard key={r.id} r={r} slug={ws.slug} anchor={i === 0} />
          ))}
        </div>
      ) : (
        <EmptyState title="붙인 참고 프로젝트가 없습니다" body="이전 프로젝트의 특정 버전을 붙이면 AI가 허용된 범위 안에서 읽습니다." />
      )}
      <Anno>두 프로젝트 모두 권한이 있는 사람만 붙일 수 있습니다(원본의 읽기 멤버 허용 여부는 6단계 M1 전에 다시 봄 — 설계 G13). 최신 완료본·승인본은 추천 기본값이고, 다른 스냅숏도 고를 수 있습니다. 승인되지 않은 스냅숏은 “승인 안 됨”으로 표시합니다.</Anno>
    </WorkspaceFrame>
  );
}
