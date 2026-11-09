import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/pes/blocks";

export function OutOfScope({ what, stage }: { what: string; stage: string }) {
  return (
    <div className="mt-4">
      <EmptyState eyebrow={stage} title={`${what} — 이 시안 밖`} body="설계 문서 9절의 구현 위치를 따릅니다. 이 시안에서는 화면 틀만 남겼습니다." action={<Button asChild><Link to="/guide">시안 안내로</Link></Button>} />
    </div>
  );
}

export function RouteLoading() {
  return (
    <p role="status" aria-busy="true" className="m-5 text-meta text-ink-2">
      화면을 불러오는 중…
    </p>
  );
}

export function NotFound() {
  return (
    <div className="mt-4">
      <h1 className="sr-only">없는 주소</h1>
      <EmptyState title="없는 주소입니다" body="주소가 바뀌었거나 볼 권한이 없습니다. 권한이 사라진 프로젝트는 목록에서 빠지고 알림으로 한 번 알립니다." action={<Button asChild variant="default"><Link to="/">프로젝트 목록으로</Link></Button>} />
    </div>
  );
}
