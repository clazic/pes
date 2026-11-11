import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import { takeHandoff } from "@/api/handoff";
import { routes } from "@/app/routes";
import { initTheme } from "@/lib/theme";
// 글꼴: Pretendard Variable(동적 subset woff2) — npm 패키지 pretendard(버전 고정)를 앱과 함께 번들해 자체 호스팅한다.
// 외부 CDN 을 부르지 않는다. 라이선스: SIL Open Font License 1.1(public/fonts/).
import "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css";
import "./index.css";

// 테마: 첫 그림 전에 <html> 클래스를 맞춘다(깜박임 없음)
initTheme();

// 열어 주는 쪽(`pes open <slug> --app`)이 주소 조각으로 넘긴 세션을 렌더·라우터 전에 받고 주소에서 지운다(src/api/handoff.ts)
takeHandoff(window);

const router = createBrowserRouter(routes);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
