import { Navigate, useLocation, useParams } from "react-router";
import { useProjects } from "@/api/queries";
import { ReadFailure } from "@/features/records/parts";
import { roundHref } from "@/features/workspace/paths";
import { NotFound } from "./NotFound";

/**
 * 짧은 프로젝트 주소(/p/<slug> · /p/<slug>/) — 그 프로젝트의 현재 진행 라운드로 보낸다. 검색어(view · focus · peek · print)는 그대로 가져간다.
 * 없는 slug 는 주소를 둔 채 '찾을 수 없음' — 목록을 받았는데 slug 가 없을 때만. 목록을 읽지 못한 것(오류)은 '없음'이 아니라 읽기 실패 안내와 다시 읽기.
 */
export function ProjectRedirect() {
  const { slug } = useParams();
  const { search } = useLocation();
  const q = useProjects();
  if (q.isPending) return <main id="main" tabIndex={-1} data-area="body" aria-busy="true" className="px-4 pt-10 text-meta text-muted-foreground">불러오는 중</main>;
  if (q.isError) {
    return (
      <main id="main" tabIndex={-1} data-area="body" className="mx-auto w-full max-w-2xl px-4 pt-10 pb-16">
        <ReadFailure error={q.error} onRetry={() => void q.refetch()} />
      </main>
    );
  }
  const p = q.data?.find((x) => x.slug === slug);
  if (!p) return <NotFound />;
  return <Navigate replace to={{ pathname: roundHref(p.slug, p.edition, p.current.stage, p.current.round_id), search }} />;
}
