import type { RouteObject } from "react-router";
import { WorkspaceScreen } from "@/features/workspace/WorkspaceScreen";
import { HomeRedirect } from "./HomeRedirect";
import { NotFound } from "./NotFound";
import { RootLayout } from "./RootLayout";

/**
 * 라우트(설계 12.3) — 주소가 상태다. 공급자는 RootLayout 이 만들어 routes 만으로 앱이 완결된다.
 *  /p/:slug/e/:edition/s/:stage/r/:round  작업 공간(round = 1·2… 또는 start = 단계 시작, round_id NULL)
 *    ?view=nav|body|ask  좁은 화면 보기 · ?focus=<요소 id>  초점 복원 · ?peek=<질문 id>  미리보기 · ?print=1  인쇄 미리보기
 */
export const routes: RouteObject[] = [
  {
    path: "/",
    element: <RootLayout />,
    children: [
      { index: true, element: <HomeRedirect /> },
      { path: "p/:slug/e/:edition/s/:stage/r/:round", element: <WorkspaceScreen /> },
      { path: "*", element: <NotFound /> },
    ],
  },
];
