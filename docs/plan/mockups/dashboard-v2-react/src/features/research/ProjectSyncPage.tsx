import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { CardHead, SectionTitle } from "@/components/pes/bits";
import { EmptyState } from "@/components/pes/blocks";
import { MoreList } from "@/components/pes/disclosure";
import { StatusFrom } from "@/components/pes/status";
import { SyncPanel } from "@/features/workspace/SyncPanel";
import { useWs } from "@/features/workspace/WorkspaceLayout";

/**
 * 연구 공간 “더 보기” → 내 컴퓨터 연결(이 프로젝트) — 방식 B의 기기 · 관측 셋(도우미 · AI 도구 · 업무 실행) · 동기화 표.
 * 모든 기기·승인 기록은 관리 공간의 “내 컴퓨터”(/computer). 방식 A는 이 칸이 없다.
 */
export function ProjectSyncPage() {
  const { ws } = useWs();
  const t = ws.third_card;
  if (t.kind !== "computer") {
    return (
      <div className="mt-5">
        <EmptyState
          title="이 프로젝트는 방식 A — 내 컴퓨터 연결을 쓰지 않습니다"
          body="AI 연결·모델은 설정에서, API 사용량은 모든 프로젝트의 사용량에서 봅니다. 사용량이 연구를 막으면 막힌 것·풀 것에 올라옵니다."
          action={
            <>
              <Button asChild size="sm">
                <Link to={`/p/${ws.slug}/settings`}>설정</Link>
              </Button>
              <Button asChild size="sm">
                <Link to={`/p/${ws.slug}/problems`}>막힌 것·풀 것</Link>
              </Button>
            </>
          }
        />
      </div>
    );
  }
  return (
    <div className="mt-5">
      <SectionTitle title="내 컴퓨터 연결" sub="이 프로젝트의 기기 · 도우미 · AI 도구 · 동기화" className="mt-0" right={<Button asChild size="sm"><Link to="/computer">모든 기기(관리 공간)</Link></Button>} />
      <Card className="gap-0 px-5" aria-labelledby="pc-t">
        <CardHead eyebrow="기기" title={t.device} titleId="pc-t" right={<StatusFrom s={t.status} />} meta={t.checked} />
        <MoreList className="text-meta" items={t.observations.map((o) => [o.k, o.v] as [string, string])} />
      </Card>
      <SyncPanel ws={ws} />
    </div>
  );
}
