import * as React from "react";
import { Link, useMatches, useNavigate } from "react-router";
import { FlaskConicalIcon, PlayIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { playTurnDemo, resetMockData, simulateAiQuestion } from "@/api/queries";
import { pes } from "@/api/mock-client";
import { mockSettings, useMockSettings, type MockSettings } from "@/lib/mock-settings";

export interface MockHandle {
  mock: { title: string; desc: string; statics?: string[] };
}

function Radios<T extends string>({ legend, value, options, onChange }: { legend: string; value: T; options: { v: T; label: string; hint?: string }[]; onChange: (v: T) => void }) {
  const id = React.useId();
  return (
    <fieldset className="mt-3">
      <legend className="mb-1.5 text-[13px] font-semibold">{legend}</legend>
      <RadioGroup value={value} onValueChange={(v) => onChange(v as T)} className="gap-1.5">
        {options.map((o) => (
          <div key={o.v} className="flex items-start gap-2">
            <RadioGroupItem value={o.v} id={`${id}-${o.v}`} className="mt-1" />
            <Label htmlFor={`${id}-${o.v}`} className="flex-col items-start gap-0 text-[13px] font-medium">
              {o.label}
              {o.hint ? <span className="text-xs font-normal text-muted-foreground">{o.hint}</span> : null}
            </Label>
          </div>
        ))}
      </RadioGroup>
    </fieldset>
  );
}

/**
 * 시안 도구(제품 화면이 아님) — 3차 정리: 본문 맨 위 “시안 설명 띠”를 머리줄의 작은 단추 하나로 접었다.
 * 단추 → 오른쪽 판: 이 화면 설명 · 시안 안내/상태 견본/휴대폰 · “시안 설명 상자” 켜기(기본 끔) · 시안 조작(역할·네트워크·충돌·갱신 통로).
 */
export function MockDock() {
  const s = useMockSettings();
  const set = (p: Partial<MockSettings>) => mockSettings.set(p);
  const [, force] = React.useReducer((x: number) => x + 1, 0);
  const [open, setOpen] = React.useState(false);
  const navigate = useNavigate();
  const matches = useMatches();
  const play = (to: string) => {
    playTurnDemo();
    setOpen(false);
    navigate(to);
  };
  const handle = [...matches].reverse().find((m) => (m.handle as MockHandle | undefined)?.mock)?.handle as MockHandle | undefined;
  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        force();
      }}
    >
      <SheetTrigger asChild>
        <Button size="sm" variant="outline" data-mock="controls" aria-label="시안 도구 — 화면 설명 · 시안 조작" className="h-8 gap-1.5 border-dashed px-2 font-normal text-muted-foreground shadow-none max-tab:w-8 max-tab:px-0">
          <FlaskConicalIcon aria-hidden="true" />
          <span className="hidden tab:inline">시안</span>
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="w-[min(100%,380px)] overflow-y-auto p-4" data-mock="controls">
        <SheetHeader className="p-0">
          <SheetTitle>시안 도구 — 제품 기능이 아님</SheetTitle>
          <SheetDescription>합성 예시만 씁니다. 네트워크 호출이 없습니다. 바꾼 값은 이 탭에만 남습니다.</SheetDescription>
        </SheetHeader>

        <section aria-labelledby="mock-screen" className="mt-3 rounded-lg border border-dashed border-line-strong bg-muted/40 px-3 py-2 text-[12.5px] text-ink-2">
          <h3 id="mock-screen" className="text-[13px] font-semibold text-foreground">
            {handle?.mock.title ?? "시안"}
          </h3>
          {handle?.mock.desc ? <p className="mt-0.5">{handle.mock.desc}</p> : null}
          {handle?.mock.statics?.length ? <p className="mt-0.5 text-muted-foreground">정적 시안: {handle.mock.statics.join(" · ")}</p> : null}
          <nav aria-label="시안 이동" className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 font-medium">
            <Link to="/guide" onClick={() => setOpen(false)}>
              시안 안내
            </Link>
            <Link to="/states" onClick={() => setOpen(false)}>
              상태 견본
            </Link>
            <Link to="/mobile" onClick={() => setOpen(false)}>
              휴대폰
            </Link>
          </nav>
        </section>

        <div className="mt-3 flex items-center justify-between gap-2">
          <Label htmlFor="mock-notes" className="flex-col items-start gap-0 text-[13px] font-medium">
            시안 설명 상자 보이기
            <span className="text-xs font-normal text-muted-foreground">점선 상자(설계 근거·결정 번호). 기본은 숨김</span>
          </Label>
          <Switch id="mock-notes" checked={s.showNotes} onCheckedChange={(c) => set({ showNotes: c })} />
        </div>

        <Separator className="my-3" />
        <p className="text-[13px] font-semibold">시안 조작</p>
        <Radios
          legend="보는 사람(역할)"
          value={s.role}
          onChange={(v) => set({ role: v })}
          options={[
            { v: "owner", label: "소유자 · 김연구" },
            { v: "editor", label: "편집자 · 박검토", hint: "AI 참조·승인·계속은 이유와 함께 못 누름" },
            { v: "reader", label: "읽기 멤버 · 이열람", hint: "답 칸 대신 안내" },
          ]}
        />
        <Radios
          legend="네트워크"
          value={s.network}
          onChange={(v) => set({ network: v })}
          options={[
            { v: "normal", label: "정상" },
            { v: "slow", label: "느림", hint: "1.2초 뒤 “접수 확인 중”, 다시 눌러도 같은 요청 번호" },
            { v: "lost", label: "다음 응답 유실(서버는 처리)", hint: "“결과 미확인” → 같은 요청 번호로 확인 → 처음 영수증 재생" },
            { v: "offline", label: "끊김(보내기 전)", hint: "“보내지 않음”, 연결되면 같은 요청 번호로 다시" },
          ]}
        />
        <Radios
          legend="변경 알림 통로"
          value={s.channel}
          onChange={(v) => set({ channel: v })}
          options={[
            { v: "live", label: "실시간(웹소켓/SSE)" },
            { v: "slow", label: "느린 갱신 · 30초(긴 대기로 내려감)" },
          ]}
        />
        <div className="mt-3 flex items-center justify-between gap-2">
          <Label htmlFor="mc-conflict" className="text-[13px] font-medium">
            다음 제출을 버전 충돌로
          </Label>
          <Switch id="mc-conflict" checked={s.nextSubmit === "conflict"} onCheckedChange={(c) => set({ nextSubmit: c ? "conflict" : "ok" })} />
        </div>
        <Separator className="my-3" />
        <section aria-labelledby="mock-turn" className="rounded-lg border border-dashed border-line-strong px-3 py-2.5">
          <h3 id="mock-turn" className="text-[13px] font-semibold">
            차례 바뀜 장면 — AI 끝남 → 나의 할 일
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">장기요양 2판(방식 B): 도우미가 방금 진행을 알려 AI가 하는 중(점이 돎) → 6초 뒤 AI가 질문 2개를 올림 → 나의 할 일로 바뀜. 여러 번 재생할 수 있습니다.</p>
          <div className="mt-2 flex flex-col gap-1.5">
            <Button size="sm" onClick={() => play("/")}>
              <PlayIcon aria-hidden="true" />
              목록에서 재생
            </Button>
            <Button size="sm" onClick={() => play("/p/ltc-survey/e/2/s/research/r/1")}>
              <PlayIcon aria-hidden="true" />
              작업 공간에서 재생
            </Button>
          </div>
        </section>
        <div className="mt-3 flex flex-col gap-2">
          <Button size="sm" onClick={() => simulateAiQuestion("dolbom-insight")}>
            AI가 새 질문을 올림(지역 돌봄)
          </Button>
          <Button size="sm" onClick={() => set({ resyncNext: true })}>
            다음 변경에 커서 무효 흉내
          </Button>
          <Button size="sm" variant="destructive" onClick={() => resetMockData()}>
            목 자료 처음으로
          </Button>
        </div>
        <Separator className="my-3" />
        <p className="text-[13px] font-semibold">불린 명령(최근 8)</p>
        <ul className="mt-1 text-xs text-ink-2">
          {pes.calls.slice(-8).reverse().map((c, i) => (
            <li key={i} className="font-mono">
              {c.at} {c.name}
              {c.replayed ? " · 재생" : ""}
            </li>
          ))}
          {pes.calls.length === 0 ? <li>아직 없음</li> : null}
        </ul>
      </SheetContent>
    </Sheet>
  );
}
