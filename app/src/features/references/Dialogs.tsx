import * as React from "react";
import { useClient, useReferenceCandidates, useReferences } from "@/api/queries";
import { NotConnectedError, type CommandResult, type ReferenceRow } from "@/api/types";
import { Button } from "@/components/ui/button";
import { defaultSnapshot, nameOf, SCOPE_KEYS } from "./logic";
import { ProjectPick, ScopePick, SnapshotPick } from "./pickers";
import { DialogShell, SendStatus, useReferenceSend } from "./send";

interface Common {
  slug: string;
  edition: number;
  /** 연 단추 — 닫을 때 초점이 돌아온다 */
  opener: HTMLElement | null;
  onClose: () => void;
}

const alertClass = "mt-3 text-meta font-medium text-bad";

/** 후보를 못 읽은 이유 — 서버에 읽는 길이 없는 것(NotConnectedError)과 일시 실패를 가른다. 후보를 지어내지 않는다 */
function CandidatesFailure({ error }: { error: unknown }) {
  return (
    <p role="alert" className={alertClass}>
      {error instanceof NotConnectedError ? `${error.message} 지금은 고를 프로젝트를 불러올 수 없어요.` : "프로젝트 목록을 읽지 못했어요. 잠시 뒤 다시 열어 주세요."}
    </p>
  );
}

function Actions({ children }: { children: React.ReactNode }) {
  return <div className="mt-5 flex flex-wrap justify-end gap-2">{children}</div>;
}

/** 참고 프로젝트 붙이기(작업 중) — 프로젝트 → 고정할 버전(추천이 기본) → 붙일 범위. 고르지 않은 채 붙일 수 없다 */
export function AttachDialog({ slug, edition, opener, onClose, onDone }: Common & { onDone: (r: CommandResult<{ reference: ReferenceRow }>) => void }) {
  const client = useClient();
  const candidates = useReferenceCandidates({ slug, edition });
  const [projectId, setProjectId] = React.useState<string | null>(null);
  const [snapshotId, setSnapshotId] = React.useState<string | null>(null);
  const [scope, setScope] = React.useState<string[]>([...SCOPE_KEYS]);
  const picked = candidates.data?.find((c) => c.project_id === projectId);
  const ready = !!picked && !!snapshotId && scope.length > 0;
  const { submit, sending, rejected, unknown, done } = useReferenceSend({
    slug,
    edition,
    run: (key) => client.attachReference(slug, edition, { referenced_project_id: projectId ?? "", source_snapshot_id: snapshotId ?? "", scope }, key),
    onDone,
  });
  const reasonId = React.useId();
  const blocked = !ready || sending;
  return (
    <DialogShell title="참고 프로젝트 붙이기" hint="이전 프로젝트의 한 버전을 읽기 전용으로 붙여요. 고른 버전은 저절로 바뀌지 않아요." opener={opener} sending={sending} done={done} onClose={onClose} wide>
      {candidates.isPending ? (
        <p aria-busy="true" className="mt-4 text-meta text-ink-2">
          후보를 불러오는 중
        </p>
      ) : candidates.isError ? (
        <CandidatesFailure error={candidates.error} />
      ) : candidates.data.length === 0 ? (
        <p className="mt-4 text-meta text-ink-2">붙일 수 있는 프로젝트가 없어요.</p>
      ) : (
        <div className="mt-4 grid gap-4">
          <ProjectPick
            candidates={candidates.data}
            value={projectId}
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
        </div>
      )}

      <SendStatus sending={sending} unknown={unknown} />
      {rejected ? (
        <p role="alert" className={alertClass}>
          붙이지 못했어요. {rejected.message} 고른 값은 그대로 있어요.
        </p>
      ) : null}
      {!ready && !sending && candidates.isSuccess && candidates.data.length > 0 ? (
        <p id={reasonId} className="mt-3 text-caption text-ink-2">
          {!picked ? "붙일 프로젝트를 고르면 붙일 수 있어요." : !snapshotId ? "고정할 버전을 골라 주세요." : "붙일 범위를 하나 이상 켜 주세요."}
        </p>
      ) : null}
      <Actions>
        <Button type="button" variant="ghost" onClick={() => !sending && onClose()} aria-disabled={sending || undefined}>
          취소
        </Button>
        <Button type="button" variant="default" aria-disabled={blocked || undefined} aria-describedby={!ready && !sending ? reasonId : undefined} onClick={() => !blocked && submit(JSON.stringify([projectId, snapshotId, scope]))}>
          붙이기
        </Button>
      </Actions>
    </DialogShell>
  );
}

/**
 * 다른 버전으로 다시 고정 — 그 프로젝트의 스냅숏 중에서 고른다. 새 버전 있음이면 가장 나중 스냅숏이 기본, 아니면 지금 고정된 것.
 * 보낼 때 그 행의 지금 rev 를 base_rev 로 싣는다. 목록은 다시 읽히므로(409 뒤 포함) 다시 누르면 새 rev 로 나간다.
 */
export function RefreshDialog({ slug, edition, refId, opener, onClose, onDone }: Common & { refId: string; onDone: (r: CommandResult<{ reference: ReferenceRow }>) => void }) {
  const client = useClient();
  const rows = useReferences(slug, edition);
  const row = rows.data?.find((x) => x.id === refId);
  const candidates = useReferenceCandidates({ slug, edition });
  const cand = candidates.data?.find((c) => c.project_id === row?.referenced_project_id);
  const [picked, setPicked] = React.useState<string | null>(null);
  const fallback = row ? (row.state === "new_version" && row.latest_snapshot_id ? row.latest_snapshot_id : row.source_snapshot_id) : null;
  const value = picked ?? fallback;
  const same = !!row && value === row.source_snapshot_id;
  const { submit, sending, rejected, unknown, done } = useReferenceSend({
    slug,
    edition,
    run: (key) => client.refreshReference(slug, edition, refId, { source_snapshot_id: value ?? "", ...(row?.rev ? { base_rev: row.rev } : {}) }, key),
    onDone,
  });
  const ready = !!row && !!cand && !!value && !same;
  const blocked = !ready || sending;
  const reasonId = React.useId();
  return (
    <DialogShell
      title="다른 버전으로 다시 고정"
      hint={`${row ? nameOf(row) : "이 참고 프로젝트"} — 가리키는 버전을 사람이 골라 바꿔요. 이미 쓴 인용은 옛 버전 그대로 남아요.`}
      opener={opener}
      sending={sending}
      done={done}
      onClose={onClose}
      wide
    >
      {candidates.isPending || rows.isPending ? (
        <p aria-busy="true" className="mt-4 text-meta text-ink-2">
          버전을 불러오는 중
        </p>
      ) : candidates.isError ? (
        <CandidatesFailure error={candidates.error} />
      ) : !row ? (
        <p role="alert" className={alertClass}>
          이 참고 프로젝트를 더는 찾을 수 없어요. 목록이 바뀌었을 수 있어요.
        </p>
      ) : !cand ? (
        <p role="alert" className={alertClass}>
          이 프로젝트의 버전 목록을 읽을 수 없어요.
        </p>
      ) : (
        <div className="mt-4">
          <SnapshotPick snapshots={cand.snapshots} value={value} onChange={setPicked} current={row.source_snapshot_id} />
        </div>
      )}

      <SendStatus sending={sending} unknown={unknown} />
      {rejected ? (
        <p role="alert" className={alertClass}>
          다시 고정하지 못했어요. {rejected.message}
        </p>
      ) : null}
      {same && !sending ? (
        <p id={reasonId} className="mt-3 text-caption text-ink-2">
          지금 고정된 버전이에요. 다른 버전을 골라 주세요.
        </p>
      ) : null}
      <Actions>
        <Button type="button" variant="ghost" onClick={() => !sending && onClose()} aria-disabled={sending || undefined}>
          취소
        </Button>
        <Button type="button" variant="default" aria-disabled={blocked || undefined} aria-describedby={same && !sending ? reasonId : undefined} onClick={() => !blocked && submit(JSON.stringify([value, row?.rev]))}>
          다시 고정
        </Button>
      </Actions>
    </DialogShell>
  );
}

/** 참고 프로젝트 떼기 — 원본은 그대로이고, 이미 쓴 인용은 옛 버전 그대로임을 말한다 */
export function DetachDialog({ slug, edition, row, opener, onClose, onDone }: Common & { row: ReferenceRow; onDone: (r: CommandResult<{ reference_id: string; detached: true }>) => void }) {
  const client = useClient();
  const { submit, sending, rejected, unknown, done } = useReferenceSend({ slug, edition, run: (key) => client.detachReference(slug, edition, row.id, key), onDone });
  return (
    <DialogShell title="참고 프로젝트 떼기" hint={`${nameOf(row)} — 이 프로젝트에서 떼요. 원본 프로젝트는 그대로 있고, 이미 쓴 인용도 옛 버전 그대로 남아요. 다시 쓰려면 처음부터 붙여야 해요.`} opener={opener} sending={sending} done={done} onClose={onClose}>
      <SendStatus sending={sending} unknown={unknown} />
      {rejected ? (
        <p role="alert" className={alertClass}>
          떼지 못했어요. {rejected.message}
        </p>
      ) : null}
      <Actions>
        <Button type="button" variant="ghost" onClick={() => !sending && onClose()} aria-disabled={sending || undefined}>
          취소
        </Button>
        <Button type="button" variant="destructive" aria-disabled={sending || undefined} onClick={() => !sending && submit(JSON.stringify([row.id]))}>
          떼기
        </Button>
      </Actions>
    </DialogShell>
  );
}
