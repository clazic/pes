import * as React from "react";
import { XIcon } from "lucide-react";
import { useReferenceCandidates } from "@/api/queries";
import { NotConnectedError, type ReferenceCandidate } from "@/api/types";
import { Button } from "@/components/ui/button";
import { noteClass } from "@/features/records/parts";
import { defaultSnapshot, scopeWords, SCOPE_KEYS } from "./logic";
import { ProjectPick, ScopePick, SnapshotPick } from "./pickers";

interface Staged {
  project: ReferenceCandidate;
  snapshotId: string;
  scope: string[];
}

/**
 * 새 프로젝트 화면의 “참고 프로젝트” 칸(REF1b · 설계 마법사 5칸째) — **담기만** 한다.
 * 프로젝트가 아직 없어 서버에 아무것도 붙이지 않는다(붙이기 · 목록 읽기 호출 0, 후보 읽기만 한 번). 프로젝트를 만든 뒤 붙이는 일은 이어지는 작업이다.
 * 고를 때 고정할 버전을 함께 정한다(추천이 기본, 승인 안 된 것은 “승인 안 됨”). 담은 것은 이 탭의 메모리에만 있다 — 새로고침하면 다시 골라야 한다.
 * 후보를 못 읽으면(서버에 읽는 길이 없음 등) 칸 안에 이유를 알리고, 다른 칸은 그대로 쓸 수 있다.
 */
export function NewReferencesSection() {
  const headingId = React.useId();
  const candidates = useReferenceCandidates(null);
  const [projectId, setProjectId] = React.useState<string | null>(null);
  const [snapshotId, setSnapshotId] = React.useState<string | null>(null);
  const [scope, setScope] = React.useState<string[]>([...SCOPE_KEYS]);
  const [staged, setStaged] = React.useState<Staged[]>([]);
  const picked = candidates.data?.find((c) => c.project_id === projectId);
  const ready = !!picked && !!snapshotId && scope.length > 0;

  const add = () => {
    if (!picked || !snapshotId || scope.length === 0) return;
    setStaged((cur) => [...cur, { project: picked, snapshotId, scope }]);
    setProjectId(null);
    setSnapshotId(null);
    setScope([...SCOPE_KEYS]);
  };

  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId} className="text-title text-ink">
        참고 프로젝트
      </h2>
      <p className="mt-1 max-w-[70ch] text-meta text-ink-2">이전 프로젝트의 한 버전을 읽기 전용 참고로 담아 두세요. 건너뛰어도 돼요. 담기만 하고 아직 프로젝트에 붙이지 않아요. 담은 것은 이 탭에만 있어서 새로고침하면 다시 골라야 해요.</p>

      {candidates.isPending ? (
        <p aria-busy="true" className="mt-4 text-meta text-ink-2">
          후보를 불러오는 중
        </p>
      ) : candidates.isError ? (
        <p role="alert" className="mt-4 text-meta font-medium text-bad">
          {candidates.error instanceof NotConnectedError ? `${candidates.error.message} 지금은 고를 프로젝트를 불러올 수 없어요. 건너뛰고 이어가도 돼요.` : "참고할 프로젝트 목록을 읽지 못했어요. 건너뛰고 이어가도 돼요."}
        </p>
      ) : candidates.data.length === 0 ? (
        <p className="mt-4 text-meta text-ink-2">담을 수 있는 프로젝트가 없어요.</p>
      ) : (
        <div className="mt-4 grid max-w-xl gap-4">
          <ProjectPick
            candidates={candidates.data}
            value={projectId}
            taken={staged.map((s) => s.project.project_id)}
            takenWord="담음"
            onChange={(id) => {
              setProjectId(id);
              setSnapshotId(defaultSnapshot(candidates.data.find((c) => c.project_id === id)?.snapshots ?? []));
            }}
          />
          {picked ? (
            <>
              <SnapshotPick snapshots={picked.snapshots} value={snapshotId} onChange={setSnapshotId} />
              <ScopePick value={scope} onChange={setScope} />
            </>
          ) : null}
          <div>
            <Button type="button" variant="default" aria-disabled={!ready || undefined} onClick={() => ready && add()}>
              담기
            </Button>
            {!ready ? <p className="mt-1 text-caption text-ink-2">{!picked ? "담을 프로젝트를 고르면 담을 수 있어요." : !snapshotId ? "고정할 버전을 골라 주세요." : "붙일 범위를 하나 이상 켜 주세요."}</p> : null}
          </div>
        </div>
      )}

      {staged.length > 0 ? (
        <ul aria-label="담은 참고 프로젝트" className="mt-5 divide-y divide-line border-y border-line">
          {staged.map((s) => {
            const snap = s.project.snapshots.find((x) => x.id === s.snapshotId);
            return (
              <li key={s.project.project_id} data-staged={s.project.project_id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
                <div className="min-w-0 flex-1 basis-56">
                  <p className="text-body font-medium break-words text-ink">{s.project.label}</p>
                  <p className={noteClass}>
                    {snap?.label ?? "고정할 버전 정보 없음"}
                    {snap && !snap.approved ? " · 승인 안 됨" : ""} · {scopeWords(s.scope)} · 아직 붙이지 않았어요
                  </p>
                </div>
                <Button type="button" variant="ghost" size="sm" aria-label={`빼기: ${s.project.label}`} onClick={() => setStaged((cur) => cur.filter((x) => x.project.project_id !== s.project.project_id))}>
                  <XIcon aria-hidden="true" />
                  빼기
                </Button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
