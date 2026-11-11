import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import { routes } from "@/app/routes";
import { initTheme } from "@/lib/theme";
// 글꼴: Pretendard Variable(동적 subset woff2) — npm 패키지 pretendard(버전 고정)를 앱과 함께 번들해 자체 호스팅한다.
// 외부 CDN 을 부르지 않는다. 라이선스: SIL Open Font License 1.1(public/fonts/).
import "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css";
import "./index.css";

// 테마: 첫 그림 전에 <html> 클래스를 맞춘다(깜박임 없음)
initTheme();

const router = createBrowserRouter(routes);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
