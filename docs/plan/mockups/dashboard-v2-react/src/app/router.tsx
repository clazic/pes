import { createBrowserRouter } from "react-router";
import { RootLayout } from "./RootLayout";
import { NotFound, OutOfScope, RouteLoading } from "./misc";

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
      { index: true, lazy: async () => ({ Component: (await import("@/features/projects/ProjectsPage")).ProjectsPage }), handle: m("시안 · 관리 공간 · 프로젝트 목록", "관리 공간(모아 보기) — 어디로 갈지 고르는 곳. 모든 프로젝트의 나의 할 일을 우선순위로, 줄마다 차례 표시기와 막힌 것 수. 프로젝트를 누르면 연구 공간(집중)으로 들어간다(5차).", ["projects.html"]) },
      { path: "guide", lazy: async () => ({ Component: (await import("@/features/guide/GuidePage")).GuidePage }), handle: m("시안 안내", "화면 목록, 정적 HTML 시안과의 대응, 화면이 부르는 PES 명령.", ["index.html"]) },
      { path: "new", lazy: async () => ({ Component: (await import("@/features/new/NewProjectPage")).NewProjectPage }), handle: m("시안 · 새 프로젝트", "처음 만드는 방법(방식 A·B)을 고릅니다.", ["new-project.html"]) },
      { path: "new/a", lazy: async () => ({ Component: (await import("@/features/new/WizardPage")).WizardPage }), handle: m("시안 · 방식 A 만들기 6칸", "만들기 전에는 서버에 아무것도 저장하지 않습니다. 2칸에서 AI 연결을 직접 등록할 수 있습니다(사용자 결정 2026-11-05).", ["new-project.html"]) },
      { path: "new/b", lazy: async () => ({ Component: (await import("@/features/new/RegisterBPage")).RegisterBPage }), handle: m("시안 · 방식 B 등록 안내", "내 컴퓨터 AI 도구로 만든 프로젝트를 웹에 등록합니다.", ["new-project.html#mode-b"]) },
      { path: "device", lazy: async () => ({ Component: (await import("@/features/new/DevicePage")).DevicePage }), handle: m("시안 · 기기 승인", "내 컴퓨터의 코드와 같을 때만 승인합니다. 사람 자격이며 에이전트 키로 대행할 수 없습니다.", ["new-project.html#mode-b"]) },
      {
        // 연구 공간(집중, 5차 — 설계 16절): 프로젝트 하나에 들어가면 관리용 전역 메뉴 대신 연구 흐름 · 지금 할 일 · 막힌 것 · AI 동료
        path: "p/:slug",
        // 연구 공간 틀(AI 동료 칸 포함)은 따로 불러온다 — 관리 공간 첫 묶음을 무겁게 하지 않게
        lazy: async () => ({ Component: (await import("@/features/workspace/WorkspaceLayout")).WorkspaceLayout }),
        children: [
          { index: true, lazy: async () => ({ Component: (await import("@/features/research/OverviewPage")).OverviewPage }), handle: m("시안 · 연구 공간 · 연구 개요", "연구 공간의 첫 화면 — 이어서 하기(마지막 위치) · 연구 질문 · 지금 어디까지(6단계) · 핵심 발견 · 남은 문제 · 다음 마일스톤. 관리 지표는 AI 동료 칸 아래 한 줄.") },
          { path: "e/:ed/s/:stage/r/:round", lazy: async () => ({ Component: (await import("@/features/workspace/RoundPage")).RoundPage }), handle: m("시안 · 연구 공간 · 지금 할 일", "가운데에 지금 하는 일 한 가지(질문 폼 · 결과 글과 문제 표시 · 해결 흐름 · 승인 검토), 순서 줄과 다음 할 일. 오른쪽 AI 동료. 집중 모드(J/K · Esc).", ["workspace.html"]) },
          { path: "problems", lazy: async () => ({ Component: (await import("@/features/research/ProblemsPage")).ProblemsPage }), handle: m("시안 · 연구 공간 · 막힌 것·풀 것", "연구를 막는 것을 한곳에 — 원인 한 줄 → 선택지 2~3개(추천) → 한 번에 처리. 풀리면 사라지고 해결 기록에 남음.") },
          { path: "s/:stage", lazy: async () => ({ Component: (await import("@/features/research/StagePage")).StagePage }), handle: m("시안 · 연구 공간 · 단계 결과", "지난 단계의 결과 요약(승인본) · 앞 단계 변경 — 다시 확인 · 아직 열리지 않은 단계.") },
          { path: "s/:stage/report", lazy: async () => ({ Component: (await import("@/features/research/StageReportPage")).StageReportPage }), handle: m("시안 · 연구 공간 · 단계 보고서", "단계 마지막에 정리한 보고서(기획보고서 · 조사보고서 …). 승인 때 고정본, 진행 중이면 초안(설계 19절).") },
          { path: "sync", lazy: async () => ({ Component: (await import("@/features/research/ProjectSyncPage")).ProjectSyncPage }), handle: m("시안 · 연구 공간 · 내 컴퓨터 연결", "이 프로젝트의 기기 · 관측 셋 · 동기화 표(방식 B). 모든 기기는 관리 공간의 내 컴퓨터.", ["workspace.html#states"]) },
          { path: "ai", lazy: async () => ({ Component: (await import("@/features/workspace/AiPage")).AiPage }), handle: m("시안 · 연구 공간 · AI 작업 기록", "핵심 상태 · 실행 · 작업 타임라인 · AI에게 묻는 질문 · 내 컴퓨터에서 확인할 일(더 보기).", ["workspace.html#ai"]) },
          { path: "files", lazy: async () => ({ Component: (await import("@/features/materials/MaterialsPage")).MaterialsPage }), handle: m("시안 · 연구 공간 · 자료", "자료 목록, 파일·폴더째 올리기, 글자 뽑기 미리보기, 파일·폴더별 AI 참조 스위치와 실제 효과, 참고 프로젝트에서 온 자료(더 보기).", ["materials.html"]) },
          { path: "references", lazy: async () => ({ Component: (await import("@/features/workspace/ReferencesPage")).ReferencesPage }), handle: m("시안 · 연구 공간 · 참고 프로젝트", "고정한 버전 · 새 버전 · 붙인 범위 · AI 제공. 자동 갱신 없음(더 보기).", ["workspace.html#refs", "new-project.html#s5"]) },
          { path: "settings", lazy: async () => ({ Component: (await import("@/features/workspace/SettingsPage")).SettingsPage }), handle: m("시안 · 연구 공간 · 프로젝트 설정", "AI 연결·모델, AI가 읽기(막기·다시 허용 모두 요청 한 건마다 본인 확인)(더 보기).", ["usage.html"]) },
          { path: "editions", element: <OutOfScope what="판(완료 · 이월 · 비교)" stage="4단계 U7·U8" />, handle: m("시안 · 판", "4단계 범위라 이 시안 밖입니다.") },
        ],
      },
      { path: "computer", lazy: async () => ({ Component: (await import("@/features/computer/ComputerPage")).ComputerPage }), handle: m("시안 · 관리 공간 · 내 컴퓨터", "기기 · 도우미 · AI 도구 · 동기화 폴더 · 연결 상태.", ["workspace.html#states"]) },
      { path: "usage", lazy: async () => ({ Component: (await import("@/features/usage/UsagePage")).UsagePage }), handle: m("시안 · 관리 공간 · 사용량", "방식 A 실행이 API 사용량 문턱(90%)에 걸려 멈춘 뒤(16:12). AI 연결별 사용량·한도, 추가 요금 꺼짐 확인, API 회사 화면에서 본 숫자, 재개 준비 검사, 확인 안 된 호출, 웹 운영 한도.", ["usage.html"]) },
      { path: "notifications", lazy: async () => ({ Component: (await import("@/features/notifications/NotificationsPage")).NotificationsPage }), handle: m("시안 · 관리 공간 · 알림", "기본 문구에는 프로젝트 이름·질문 문구·파일 이름을 싣지 않습니다.", ["mobile.html"]) },
      { path: "mobile", lazy: async () => ({ Component: (await import("@/features/mobile/MobilePage")).MobilePage }), handle: m("시안 · 휴대폰", "알림 → 답 → 검토 후 보내기 → 단계 승인(재인증) → 멈춘 실행 계속. 휴대폰 폭에서는 한 열로 보입니다.", ["mobile.html"]) },
      { path: "states", lazy: async () => ({ Component: (await import("@/features/states/StatesPage")).StatesPage }), handle: m("시안 · 상태 견본", "빈 · 로딩 · 오류 · 권한 없음 · 끊김 · 충돌 · 차단 · 미상을 한곳에서. 상태 사전 전체 표.", ["workspace.html#states", "materials.html", "usage.html#states"]) },
      { path: "*", element: <NotFound /> },
    ],
  },
]);
