import { Navigate } from "react-router";
import { useProjects } from "@/api/queries";
import { roundHref } from "@/features/workspace/paths";
import { NotFound } from "./NotFound";

/** 첫 주소(/) — 프로젝트 목록 화면은 아직 없으므로(U1a 범위 밖) 첫 프로젝트의 현재 진행 라운드로 보낸다 */
export function HomeRedirect() {
  const q = useProjects();
  if (q.isPending) return <main id="main" tabIndex={-1} data-area="body" aria-busy="true" className="px-4 pt-10 text-meta text-muted-foreground">불러오는 중</main>;
  const p = q.data?.[0];
  if (!p) return <NotFound />;
  return <Navigate replace to={roundHref(p.slug, p.edition, p.current.stage, p.current.round_id)} />;
}
