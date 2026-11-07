import { AiWork } from "./AiWork";
import { SyncPanel } from "./SyncPanel";
import { useWs, WorkspaceFrame } from "./WorkspaceLayout";

/** /p/<프로젝트>/ai — 실행 · 작업 타임라인 · AI에게 묻기 · 내 컴퓨터(B) */
export function AiPage() {
  const { ws } = useWs();
  return (
    <WorkspaceFrame active="ai">
      <AiWork ws={ws} id="ai-full" />
      <SyncPanel ws={ws} />
    </WorkspaceFrame>
  );
}
