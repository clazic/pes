import { Navigate, useParams } from "react-router";
import { useProjects } from "@/api/queries";
import { roundHref } from "@/features/workspace/paths";
import { NotFound } from "./NotFound";

/** 짧은 프로젝트 주소(/p/<slug> · /p/<slug>/) — 그 프로젝트의 현재 진행 라운드로 보낸다. 없는 slug 는 주소를 둔 채 '찾을 수 없음' */
export function ProjectRedirect() {
  const { slug } = useParams();
  const q = useProjects();
  if (q.isPending) return <main id="main" tabIndex={-1} data-area="body" aria-busy="true" className="px-4 pt-10 text-meta text-muted-foreground">불러오는 중</main>;
  const p = q.data?.find((x) => x.slug === slug);
  if (!p) return <NotFound />;
  return <Navigate replace to={roundHref(p.slug, p.edition, p.current.stage, p.current.round_id)} />;
}
