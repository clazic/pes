import type { RouteObject } from "react-router";
import type { PesClient } from "@/api/types";
import { NewScreen } from "@/features/references/NewScreen";
import { ReferencesScreen } from "@/features/references/ReferencesScreen";
import { RecordsScreen } from "@/features/records/RecordsScreen";
import { WorkspaceScreen } from "@/features/workspace/WorkspaceScreen";
import { HomeRedirect } from "./HomeRedirect";
import { NotFound } from "./NotFound";
import { ProjectRedirect } from "./ProjectRedirect";
import { RootLayout } from "./RootLayout";

/**
 * 라우트(설계 12.3) — 주소가 상태다.
 *  /  · /_app/(vite base 의 첫 주소)  첫 프로젝트의 현재 위치로 · /p/:slug(끝 / 있든 없든)  그 프로젝트의 현재 위치로 — 모두 replace
 * 공급자는 RootLayout 이 만들어 routes 만으로 앱이 완결된다.
 *  /p/:slug/e/:edition/records  가정·결정·반영(U3b) — 표 셋 + 사람 판단 단추
 *  /p/:slug/e/:edition/references  이전 프로젝트 참고자료(REF1b) — 목록 · 붙이기 · 다시 고정 · 떼기 · 내용 보기
 *  /new  새 프로젝트 — “참고 프로젝트” 칸(담기만, 서버에 붙이지 않음)
 *  /p/:slug/e/:edition/s/:stage/r/:round  작업 공간(round = 1·2… 또는 start = 단계 시작, round_id NULL)
 *    ?view=body|ask  좁은 화면 보기 · ?focus=<요소 id>  초점 복원 · ?peek=<질문 id>  미리보기 · ?print=1  인쇄 미리보기
 * createRoutes({ client }) 는 시험 · 다른 클라이언트(U1b HTTP)를 주입하는 심이다.
 */
export function createRoutes(options: { client?: PesClient } = {}): RouteObject[] {
  return [
    {
      path: "/",
      element: <RootLayout client={options.client} />,
      children: [
        { index: true, element: <HomeRedirect /> },
        { path: "_app", element: <HomeRedirect /> },
        { path: "p/:slug", element: <ProjectRedirect /> },
        { path: "p/:slug/e/:edition/s/:stage/r/:round", element: <WorkspaceScreen /> },
        { path: "p/:slug/e/:edition/records", element: <RecordsScreen /> },
        { path: "p/:slug/e/:edition/references", element: <ReferencesScreen /> },
        { path: "new", element: <NewScreen /> },
        { path: "*", element: <NotFound /> },
      ],
    },
  ];
}

/** 기본 앱(가짜 클라이언트) — createRoutes() 와 같다 */
export const routes: RouteObject[] = createRoutes();
