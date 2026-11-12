import type { RunPermissionView, RunView, WorkspaceView } from "@/api/types";
import { StatusText } from "@/components/pes/status";
import { STAGE_LABEL } from "@/lib/labels";

/**
 * 실행 · 실행 권한 · 기록(U1d) — 본문 안, 결과 글 아래.
 *  - 실행: 중단됨 · 취소됨 · 인계됨은 서로 다른 낱말이고 각 실행은 자기 낱말만 쓴다(UI 44·49·104).
 *    외부에서 멈춘 결과가 unknown 이면 “중단 확인됨”이라 하지 않는다(연결 끊김 ≠ 취소).
 *  - 실행 권한: 외부 앱·PES 도구의 질문·권한은 여기에만 둔다 — PES 연구 질문(질문 영역)과 섞지 않는다(RUN A9 · B0).
 *  - 기록: 가정·결정·의견의 개수. 0 이면 “기록 없음”. 서버가 칸을 아직 주지 않았으면 0건이라 단정하지 않는다.
 * 칸이 없는 오늘 서버 모양에서도 패널은 남고 “정보 없음”이라고 정직하게 쓴다(지어내지 않음).
 */

const STOP_LABEL: Record<string, string> = {
  pending: "멈춤 요청 처리 중",
  confirmed: "멈춤 확인됨",
  failed: "멈춤 요청 실패",
  unknown: "멈춤 결과 알 수 없음",
};

const PERMISSION_SOURCE: Record<string, string> = { external_app: "외부 앱", pes_tool: "PES" };
const PERMISSION_KIND: Record<string, string> = { question: "질문", permission: "권한" };
const PERMISSION_STATE: Record<string, string> = { waiting: "기다리는 중", answered: "답함" };

function RunRow({ run }: { run: RunView }) {
  return (
    <li data-run={run.id} data-status={run.status} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-t py-1.5 first:border-t-0 first:pt-0">
      <StatusText of="run" value={run.status} />
      <span className="text-caption text-muted-foreground">
        방식 {run.mode} · {STAGE_LABEL[run.stage]}
      </span>
      {run.external_stop ? <span className="text-caption text-ink-2">{STOP_LABEL[run.external_stop] ?? "알 수 없음"}</span> : null}
    </li>
  );
}

function PermissionRow({ permission }: { permission: RunPermissionView }) {
  return (
    <li data-permission={permission.id} className="rounded-md border bg-background px-2.5 py-1.5">
      <p className="text-meta text-ink">{permission.text}</p>
      <p className="mt-0.5 text-caption text-muted-foreground">
        {PERMISSION_SOURCE[permission.source] ?? "출처 알 수 없음"} · {PERMISSION_KIND[permission.kind] ?? "종류 알 수 없음"} ·{" "}
        {PERMISSION_STATE[permission.state] ?? "상태 알 수 없음"}
      </p>
    </li>
  );
}

export function RunPanel({ ws }: { ws: WorkspaceView }) {
  const permissions = ws.run_permissions;
  return (
    <section aria-label="실행" data-print="hide" className="mt-8 rounded-lg border bg-surface-soft px-3 py-3">
      <h2 className="text-title text-ink">실행</h2>
      {ws.runs === undefined ? (
        <p className="mt-1 text-meta text-ink-2">정보 없음 — 서버가 실행 정보를 아직 보내지 않았습니다.</p>
      ) : ws.runs.length === 0 ? (
        <p className="mt-1 text-meta text-ink-2">실행 기록이 없습니다.</p>
      ) : (
        <ul className="mt-1.5">
          {ws.runs.map((run) => (
            <RunRow key={run.id} run={run} />
          ))}
        </ul>
      )}
      <div role="group" aria-label="실행 권한" className="mt-3 border-t pt-2.5">
        <h3 className="text-meta font-semibold text-ink">실행 권한</h3>
        {permissions === undefined ? (
          <p className="mt-1 text-meta text-ink-2">정보 없음 — 서버가 실행 권한 정보를 아직 보내지 않았습니다.</p>
        ) : permissions.length === 0 ? (
          <p className="mt-1 text-meta text-ink-2">기다리는 질문·권한이 없습니다.</p>
        ) : (
          <ul className="mt-1.5 space-y-1.5">
            {permissions.map((permission) => (
              <PermissionRow key={permission.id} permission={permission} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

const RECORD_LABEL = { assumptions: "가정", decisions: "결정", comments: "의견" } as const;

export function RecordsPanel({ ws }: { ws: WorkspaceView }) {
  const records = ws.records;
  return (
    <section aria-label="기록" data-print="hide" className="mt-4 rounded-lg border bg-surface-soft px-3 py-3">
      <h2 className="text-title text-ink">기록</h2>
      {records ? (
        <dl className="mt-1.5 space-y-1">
          {(["assumptions", "decisions", "comments"] as const).map((key) => (
            <div key={key} data-record={key} className="flex flex-wrap items-baseline gap-x-2 text-meta">
              <dt className="text-ink-2">{RECORD_LABEL[key]}</dt>
              <dd className="text-ink">{records[key].count === 0 ? "기록 없음" : `${records[key].count}건`}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="mt-1 text-meta text-ink-2">정보 없음 — 서버가 기록 정보를 아직 보내지 않았습니다.</p>
      )}
    </section>
  );
}
