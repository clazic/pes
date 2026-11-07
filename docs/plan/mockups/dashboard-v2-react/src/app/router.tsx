import { createBrowserRouter, Navigate, useParams } from "react-router";
import { useWorkspace } from "@/api/queries";
import { RootLayout } from "./RootLayout";
import { NotFound, OutOfScope, RouteLoading } from "./misc";
import { WorkspaceLayout } from "@/features/workspace/WorkspaceLayout";

/** /p/:slug → 현재 진행 라운드로(주소는 U1의 /p/<프로젝트>/e/<판>/s/<단계>/r/<라운드>) */
function CurrentRound() {
  const { slug = "" } = useParams();
  const ws = useWorkspace(slug);
  if (!ws.data) return null;
  const w = ws.data;
  return <Navigate replace to={`/p/${slug}/e/${w.edition}/s/${w.current.stage}/r/${w.current.round}`} />;
}

const m = (title: string, desc: string, statics?: string[]) => ({ mock: { title, desc, statics } });

/*
 * 화면마다 따로 불러온다(경로 단위 코드 분할). 글자 뽑기 라이브러리처럼 무거운 것은 그 화면 묶음에만 들어간다(0017).
 * 정적 서버는 /p/… 같은 깊은 주소도 index.html로 돌려줘야 한다(SPA 되돌림) — 로컬 PES 서버·5단계 정적 자산 설정의 몫.
 */
export const router = createBrowserRouter([
  {
    path: "/",
    element: <RootLayout />,
    // 화면 묶음을 처음 불러오는 동안(경로 단위 분할): 뼈대 깜박임 대신 조용한 한 줄
    hydrateFallbackElement: <RouteLoading />,
    children: [
      { index: true, lazy: async () => ({ Component: (await import("@/features/projects/ProjectsPage")).ProjectsPage }), handle: m("시안 · 프로젝트 목록", "로그인 뒤 첫 화면. 모든 프로젝트의 지금 할 일을 우선순위로 모은 나의 할 일, 줄마다 차례 표시기(사람 ↔ AI), 같은 크기 카드·표 보기, 빈 상태·옛 형식·불러오기 실패.", ["projects.html"]) },
      { path: "guide", lazy: async () => ({ Component: (await import("@/features/guide/GuidePage")).GuidePage }), handle: m("시안 안내", "화면 목록, 정적 HTML 시안과의 대응, 화면이 부르는 PES 명령.", ["index.html"]) },
      { path: "new", lazy: async () => ({ Component: (await import("@/features/new/NewProjectPage")).NewProjectPage }), handle: m("시안 · 새 프로젝트", "처음 만드는 방법(방식 A·B)을 고릅니다.", ["new-project.html"]) },
      { path: "new/a", lazy: async () => ({ Component: (await import("@/features/new/WizardPage")).WizardPage }), handle: m("시안 · 방식 A 만들기 6칸", "만들기 전에는 서버에 아무것도 저장하지 않습니다. 2칸에서 AI 연결을 직접 등록할 수 있습니다(사용자 결정 2026-11-05).", ["new-project.html"]) },
      { path: "new/b", lazy: async () => ({ Component: (await import("@/features/new/RegisterBPage")).RegisterBPage }), handle: m("시안 · 방식 B 등록 안내", "내 컴퓨터 AI 도구로 만든 프로젝트를 웹에 등록합니다.", ["new-project.html#mode-b"]) },
      { path: "device", lazy: async () => ({ Component: (await import("@/features/new/DevicePage")).DevicePage }), handle: m("시안 · 기기 승인", "내 컴퓨터의 코드와 같을 때만 승인합니다. 사람 자격이며 에이전트 키로 대행할 수 없습니다.", ["new-project.html#mode-b"]) },
      {
        path: "p/:slug",
        element: <WorkspaceLayout />,
        children: [
          { index: true, element: <CurrentRound /> },
          { path: "e/:ed/s/:stage/r/:round", lazy: async () => ({ Component: (await import("@/features/workspace/RoundPage")).RoundPage }), handle: m("시안 · 작업 공간", "지금 할 일, 질문 폼(고치기·더하기·빼기·묶음 보내기), 반영 내역, 결과물·인용·첨언, 참고 프로젝트, AI 작업 타임라인, 내 컴퓨터, 동기화 충돌.", ["workspace.html"]) },
          { path: "ai", lazy: async () => ({ Component: (await import("@/features/workspace/AiPage")).AiPage }), handle: m("시안 · AI 작업", "실행 · 작업 타임라인 · AI에게 묻는 질문 · 내 컴퓨터에서 확인할 일.", ["workspace.html#ai"]) },
          { path: "files", lazy: async () => ({ Component: (await import("@/features/materials/MaterialsPage")).MaterialsPage }), handle: m("시안 · 자료", "자료 목록, 파일·폴더째 올리기, 글자 뽑기 미리보기, 파일·폴더별 AI 참조 스위치와 실제 효과, 참고 프로젝트에서 온 자료.", ["materials.html"]) },
          { path: "references", lazy: async () => ({ Component: (await import("@/features/workspace/ReferencesPage")).ReferencesPage }), handle: m("시안 · 참고 프로젝트", "고정한 버전 · 새 버전 · 붙인 범위 · AI 제공. 자동 갱신 없음.", ["workspace.html#refs", "new-project.html#s5"]) },
          { path: "settings", lazy: async () => ({ Component: (await import("@/features/workspace/SettingsPage")).SettingsPage }), handle: m("시안 · 프로젝트 설정", "AI 연결·모델, AI가 읽기(막기·다시 허용 모두 요청 한 건마다 본인 확인).", ["usage.html"]) },
          { path: "editions", element: <OutOfScope what="판(완료 · 이월 · 비교)" stage="4단계 U7·U8" />, handle: m("시안 · 판", "4단계 범위라 이 시안 밖입니다.") },
        ],
      },
      { path: "computer", lazy: async () => ({ Component: (await import("@/features/computer/ComputerPage")).ComputerPage }), handle: m("시안 · 내 컴퓨터", "기기 · 도우미 · AI 도구 · 동기화 폴더 · 연결 상태.", ["workspace.html#states"]) },
      { path: "usage", lazy: async () => ({ Component: (await import("@/features/usage/UsagePage")).UsagePage }), handle: m("시안 · 사용량", "방식 A 실행이 API 사용량 문턱(90%)에 걸려 멈춘 뒤(16:12). AI 연결별 사용량·한도, 추가 요금 꺼짐 확인, 콘솔 기준값, 재개 준비 검사, 확인 안 된 호출, 웹 운영 한도.", ["usage.html"]) },
      { path: "notifications", lazy: async () => ({ Component: (await import("@/features/notifications/NotificationsPage")).NotificationsPage }), handle: m("시안 · 알림", "기본 문구에는 프로젝트 이름·질문 문구·파일 이름을 싣지 않습니다.", ["mobile.html"]) },
      { path: "mobile", lazy: async () => ({ Component: (await import("@/features/mobile/MobilePage")).MobilePage }), handle: m("시안 · 휴대폰", "알림 → 답 → 검토 후 보내기 → 단계 승인(재인증) → 멈춘 실행 계속. 휴대폰 폭에서는 한 열로 보입니다.", ["mobile.html"]) },
      { path: "states", lazy: async () => ({ Component: (await import("@/features/states/StatesPage")).StatesPage }), handle: m("시안 · 상태 견본", "빈 · 로딩 · 오류 · 권한 없음 · 끊김 · 충돌 · 차단 · 미상을 한곳에서. 상태 사전 전체 표.", ["workspace.html#states", "materials.html", "usage.html#states"]) },
      { path: "*", element: <NotFound /> },
    ],
  },
]);
