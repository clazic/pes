import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "react-router/dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import { router } from "@/app/router";
import { initTheme } from "@/lib/theme";
// 글꼴: Pretendard Variable(동적 subset woff2) — npm 패키지 pretendard(버전 고정)를 이 앱과 함께 번들해 자체 호스팅한다.
// 외부 CDN을 부르지 않는다(오프라인·로컬 PES 서버에서도 동작). 라이선스: SIL Open Font License 1.1(public/fonts/).
import "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css";
import "./index.css";

// 테마(시안에서 고르기 — localStorage): 첫 그림 전에 <html> 클래스를 맞춘다(깜박임 없음).
initTheme();

/**
 * 서버 자료는 TanStack Query가 맡는다.
 * - 폴링 없음(refetchInterval 없음), 창 초점 때 다시 받지 않음 — 갱신은 변경 알림 → 바뀐 것만
 * - 실패한 읽기는 자동으로 한 번만 다시(끊김은 화면에 “끊김”)
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: true, retry: 1 },
    mutations: { retry: 0 },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={300}>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
);
