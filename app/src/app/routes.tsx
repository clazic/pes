import type { RouteObject } from "react-router";
import type { PesClient } from "@/api/types";
import { RecordsScreen } from "@/features/records/RecordsScreen";
import { WorkspaceScreen } from "@/features/workspace/WorkspaceScreen";
import { HomeRedirect } from "./HomeRedirect";
import { NotFound } from "./NotFound";
import { RootLayout } from "./RootLayout";

/**
 * 라우트(설계 12.3) — 주소가 상태다. 공급자는 RootLayout 이 만들어 routes 만으로 앱이 완결된다.
 *  /p/:slug/e/:edition/records  가정·결정·반영(U3b) — 표 셋 + 사람 판단 단추
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
        { path: "p/:slug/e/:edition/s/:stage/r/:round", element: <WorkspaceScreen /> },
        { path: "p/:slug/e/:edition/records", element: <RecordsScreen /> },
        { path: "*", element: <NotFound /> },
      ],
    },
  ];
}

/** 기본 앱(가짜 클라이언트) — createRoutes() 와 같다 */
export const routes: RouteObject[] = createRoutes();
