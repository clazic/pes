import * as React from "react";
import type { ReferenceCandidate, ReferenceSnapshot } from "@/api/types";
import { cn } from "@/lib/utils";
import { SCOPE_KEYS, scopeLabel } from "./logic";

const optionClass = "flex items-start gap-2.5 rounded-md border px-3 py-2 text-meta has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring";
const inputClass = "mt-1 size-4 shrink-0 accent-primary";

/** 고르는 칸의 이름 줄 — 화면 읽기에는 radiogroup · group 의 이름이 된다 */
function GroupLabel({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <p id={id} className="mb-1.5 text-meta font-semibold text-ink">
      {children}
    </p>
  );
}

/**
 * 참고할 프로젝트 고르기 — 이미 붙였거나 담은 프로젝트는 목록에 남되 “이미 붙임” · “담음” 글과 함께 고를 수 없다(숨기지 않는다).
 * 글자 뜻은 라벨 안에만 두어 radio 이름이 곧 프로젝트 이름이다.
 */
export function ProjectPick({ candidates, value, onChange, taken = [], takenWord = "이미 붙임" }: { candidates: ReferenceCandidate[]; value: string | null; onChange: (id: string) => void; taken?: string[]; takenWord?: string }) {
  const ids = React.useId();
  return (
    <div>
      <GroupLabel id={`${ids}-label`}>참고할 프로젝트</GroupLabel>
      <div role="radiogroup" aria-labelledby={`${ids}-label`} className="grid gap-1.5">
        {candidates.map((c) => {
          const blocked = c.attached || taken.includes(c.project_id);
          return (
            <label key={c.project_id} className={cn(optionClass, value === c.project_id ? "border-primary bg-primary-soft" : "border-line", blocked && "bg-surface-sunk text-ink-2")}>
              <input type="radio" name={`${ids}-project`} className={inputClass} checked={value === c.project_id} disabled={blocked} onChange={() => onChange(c.project_id)} />
              <span className="min-w-0">
                <span className="font-medium break-words text-ink">{c.label}</span> <span className="text-caption break-all text-ink-2">{c.key}</span>
                {blocked ? <> <span className="ml-2 text-caption font-medium text-ink">{c.attached ? "이미 붙임" : takenWord}</span></> : null}
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

/**
 * 고정할 버전 고르기 — 승인본은 추천 기본값일 뿐 다른 스냅숏도 고를 수 있다. 승인 안 된 것은 “승인 안 됨” 글(승인본처럼 보이지 않게).
 * current = 지금 고정된 스냅숏 id(다시 고정에서) — “지금 고정됨” 글을 붙인다.
 * locked = 영수증을 받지 못한 요청의 값이라 바꿀 수 없다(고른 값을 보이기만 한다).
 */
export function SnapshotPick({ snapshots, value, onChange, current, locked = false }: { snapshots: ReferenceSnapshot[]; value: string | null; onChange: (id: string) => void; current?: string | null; locked?: boolean }) {
  const ids = React.useId();
  return (
    <div>
      <GroupLabel id={`${ids}-label`}>고정할 버전</GroupLabel>
      <div role="radiogroup" aria-labelledby={`${ids}-label`} className="grid gap-1.5">
        {snapshots.map((s) => (
          <label key={s.id} className={cn(optionClass, value === s.id ? "border-primary bg-primary-soft" : "border-line")}>
            <input type="radio" name={`${ids}-snapshot`} className={inputClass} checked={value === s.id} disabled={locked && value !== s.id} onChange={() => onChange(s.id)} />
            <span className="min-w-0 font-medium break-words text-ink">
              {s.label}
              {s.recommended ? <> <span className="ml-2 text-caption font-medium text-primary-ink">추천</span></> : null}
              {current === s.id ? <> <span className="ml-2 text-caption font-medium text-ink">지금 고정됨</span></> : null}
              {!s.approved ? <> <span className="ml-2 rounded-full border border-warn-line bg-warn-soft px-2 py-px text-caption font-medium whitespace-nowrap text-warn">승인 안 됨</span></> : null}
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}

/** 붙일 범위 — 둘 다 기본 켜짐(서버 기본). 라벨은 이름만(체크박스 이름 = 범위 이름) */
export function ScopePick({ value, onChange }: { value: string[]; onChange: (next: string[]) => void }) {
  const ids = React.useId();
  const toggle = (key: string) => onChange(SCOPE_KEYS.filter((k) => (k === key ? !value.includes(k) : value.includes(k))));
  return (
    <div role="group" aria-labelledby={`${ids}-label`}>
      <GroupLabel id={`${ids}-label`}>붙일 범위</GroupLabel>
      <div className="flex flex-wrap gap-x-5 gap-y-1.5">
        {SCOPE_KEYS.map((k) => (
          <label key={k} className="flex min-h-8 items-center gap-2 text-meta text-ink has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring">
            <input type="checkbox" className="size-4 accent-primary" checked={value.includes(k)} onChange={() => toggle(k)} />
            {scopeLabel(k)}
          </label>
        ))}
      </div>
      {value.length === 0 ? <p className="mt-1 text-caption text-ink-2">범위를 하나 이상 켜야 해요.</p> : null}
    </div>
  );
}
