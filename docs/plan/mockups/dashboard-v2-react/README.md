# PES 웹 대시보드 v2 — React 시안

- 기술: **React 19 + Vite 8 + TypeScript 7 + Tailwind CSS 4 + shadcn/ui(radix)** · 라우팅 React Router 8 · 서버 자료 TanStack Query 5 · 글꼴 Pretendard(자체 호스팅)
- **2차(2026-11-05, 테마 적용)**: 앱 셸 = shadcn 공식 **sidebar-07** 블록 · 머리줄 = **shadcn-admin** 구조 참고 · 목록·사용량 = **dashboard-01** 패턴 · 테마 = **tweakcn 4개**(머리줄 팔레트 단추로 바꿈) — 아래 [앱 셸·블록·테마](#앱-셸블록테마-2차)
- **3차(2026-11-05, 정보 밀도 정리)**: 사용자 의견(“화면을 설명하는 글이 너무 많고 복잡해 보여”)에 따라 화면마다 **제목 + 지금 할 일 1개 + 본문**만 첫눈에 두고, 근거·시각·도구 이름·규칙 설명·권한 안내는 지우지 않고 **한 단계 뒤**(자세히 · ⓘ 설명 · 접힌 묶음)로 옮겼다. 시안 설명 띠는 머리줄의 점선 “시안” 단추 하나로 접었다 — 규칙표는 [ui/dashboard-v2.md 14절](../../ui/dashboard-v2.md), 기록은 [논의 기록 9절](../../discussion/2026-11-05-dashboard-v2-react-notes.md)
- **4차(2026-11-05, 상태 이름 · 차례 표시기)**: 사용자 결정으로 화면 말을 바꿨다 — **내 차례 → 나의 할 일** · **AI 차례 → AI가 하는 중** · 목록의 “진행 중”(보관 제외 전체) → **내 프로젝트** · **AI에 자료전송: 허용/불허 → AI가 읽기: 허용/막음**. 그리고 지금 누가 움직일 차례인지 한눈에 보이는 **차례 표시기**(왼쪽 끝 사람 ↔ 오른쪽 끝 AI, 공이 있는 쪽이 차례)를 목록 표·카드 줄 · 작업 공간 지금 할 일 띠 · 사이드바 배지 · 휴대폰에 같은 모양으로 넣었다. 움직임은 근거(진행 소식)가 있을 때만이고 움직임 줄이기에서는 멈춘다. 시안 단추의 **“차례 바뀜 장면”** 으로 “AI 끝남 → 나의 할 일” 전환을 재생할 수 있다 — 규칙 [ui/dashboard-v2.md 15절](../../ui/dashboard-v2.md), 기록 [논의 기록 10절](../../discussion/2026-11-05-dashboard-v2-react-notes.md)
- **5차(2026-11-08, 관리 공간 / 연구 공간)**: 사용자 지적(“관리하는 것과 연구를 진행하는 것을 구분 — 한 프로젝트를 진행하고 문제를 해결하는 부분이 빠져 있다, 일에 집중할 수 있게”)에 따라 화면을 둘로 나눴다. **관리 공간**(목록 · 나의 할 일 · 내 컴퓨터 · 사용량 · 알림 · 새 프로젝트 — 어디로 갈지 고르는 곳)과 **연구 공간**(프로젝트 하나 — 연구 개요 · 지금 할 일(가운데에 한 가지) · 막힌 것·풀 것(원인 → 선택지(추천) → 한 번에 처리) · 결과 글 문제 표시 · AI 동료 · 집중 모드(J/K · Esc) · 이어서 하기). 연구 공간에는 관리용 전역 메뉴가 없고 “← 모든 프로젝트”와 프로젝트 전환만. 기존 기능은 지우지 않고 “더 보기”로 — 규칙 [ui/dashboard-v2.md 16절](../../ui/dashboard-v2.md), 기록 [논의 기록 11절](../../discussion/2026-11-05-dashboard-v2-react-notes.md)
- **6차(2026-11-08, UI/UX 점검 — ui-ux-pro-max)**: 새로 설치한 `ui-ux-pro-max` 스킬을 검토자로 써서 5차 화면을 점검하고, 집중 · 문제 해결에 분명히 도움이 되는 것만 고쳤다 — **화면마다 문서 제목** · **화면이 바뀌면 새 화면 제목으로 초점**(사이드바 · 명령 메뉴 · 단계 칩 · 마법사 칸) · **뒤로 가기 때 스크롤 위치 되살림** · **굵은 포인터(휴대폰 · 터치)에서 누르는 곳 44px**(예전 규칙이 유틸리티에 져서 28~32px였던 것) · 데스크톱 ⓘ · 작은 단추 24px · **글자 바닥 11px**(`text-xs` 10.5px였음) · 손가락 커서 · **못 누르는 단추의 이유**(해결 흐름은 늘, 그 밖에는 누르면 그 자리에) · AI 동료 “부탁할 말” 이름표 · 관리 공간 채운 단추 하나. 글자 크기(html 87.5%)와 데스크톱 밀도 · 테마 · 화면 말 · 두 공간은 그대로 — 규칙 [ui/dashboard-v2.md 17절](../../ui/dashboard-v2.md), 기록 [논의 기록 12절](../../discussion/2026-11-05-dashboard-v2-react-notes.md)
- 결정: [decisions/0017-dashboard-react-vite.md](../../decisions/0017-dashboard-react-vite.md) (채택 — 사용자 결정 2026-11-05, 영향 12 = 2차)
- 설계: [ui/dashboard-v2.md](../../ui/dashboard-v2.md) — 12절 “구현 기술”(12.9 앱 셸·블록·테마), 13절 “개정(검수·추가 결정 반영)”
- 논의: [discussion/2026-11-05-dashboard-v2-react-notes.md](../../discussion/2026-11-05-dashboard-v2-react-notes.md) — 8절 “테마 적용(2차)”
- 대체하는 것: 정적 HTML 시안 [mockups/dashboard-v2/](../dashboard-v2/index.html)(지우지 않고 남김)

**시안이다.** 데이터는 `src/mocks/`의 합성 예시뿐이고, **네트워크 호출이 없다**(실제 API·외부 CDN·외부 글꼴 없음). 실제 연구 자료·키·사용자 경로·세션 번호가 없다. 점선 상자(“시안 설명”)와 머리줄 오른쪽 끝의 점선 **“시안” 단추**는 제품 화면이 아니다. 3차 정리(2026-11-05)부터 시안 설명 상자는 **기본 숨김**이고, “시안” 단추의 판에서 켠다(내용은 그대로).

## 실행

Node 22.12 이상(26.13에서 확인). 이 폴더 안에서만 설치한다(전역 설치 없음).

```sh
npm install          # package-lock.json 고정 버전으로
npm run dev          # http://127.0.0.1:5173 (개발 서버)
npm run typecheck    # tsc --noEmit — 0 오류
npm run lint         # oxlint(기본 + react + jsx-a11y) + @shadcn/lint + oxlint-tailwindcss — 오류 0(경고는 정리 대상). 화면을 고칠 때마다 돌린다(사용자 지시 2026-11-10)
                     # jsx-a11y/prefer-tag-over-role은 끔: role="status"(화면 읽기 지원이 <output>보다 안정) · Card/SidebarGroup처럼 태그를 못 바꾸는 부품의 role이라 일부러 둠
npm run build        # typecheck + vite build → dist/
npm run preview      # http://127.0.0.1:4173 (dist 정적 서빙 확인)
```

`node_modules/`·`dist/`는 커밋하지 않는다(`.gitignore`). shadcn 컴포넌트·블록을 더하려면 이 폴더에서 `npx shadcn@4.23.0 add <이름>`(CLI는 생성할 때만 쓰고 의존성에서 뺐다). **이미 있는 파일을 덮어쓸지 물으면 “아니오”** — `button`·`sheet`·`tooltip`·`input`·`breadcrumb` 등은 PES 규칙(초점·`aria-disabled`·한국어)에 맞게 고친 것이다. 새 의존성이 caret(`^`)으로 들어오면 고정 버전으로 바꾼다.

## 앱 셸·블록·테마 (2차)

사용자 의견(“Claude가 디자인한 느낌 — 대시보드 테마를 쓰면?”)에 따라 **정보·문구·상태 표시·권한·흐름·접근성 규칙은 그대로 두고 틀과 겉모습만** 흔히 쓰는 shadcn 대시보드 구성으로 바꿨다.

### 블록 · 참고

| 무엇 | 실제 이름 · 출처 | 받은 방법 | 라이선스 | 쓴 곳 |
|---|---|---|---|---|
| 사이드바 | shadcn/ui 블록 **`sidebar-07`**(아이콘만 남기고 접힘, radix-vega) | `npx shadcn@4.23.0 add sidebar-07` — 덮어쓰기 질문 5개 모두 “아니오” | MIT | `src/components/app-sidebar.tsx` · `team-switcher`(→ 프로젝트 전환) · `nav-main`(→ 메뉴 묶음·단계·라운드 나무) · `nav-projects`(→ 작업 공간 묶음) · `nav-user`(→ 머리줄 사용자 메뉴) · `ui/sidebar` · `ui/dropdown-menu` · `ui/avatar` · `ui/skeleton` · `hooks/use-mobile` |
| 차트 | shadcn/ui **`chart`** + recharts 3.8.0 | `npx shadcn@4.23.0 add chart`(recharts는 고정 버전으로) | MIT | `src/features/usage/UsageTrendChart.tsx`(따로 불러오는 묶음) |
| 대시보드 배치 | shadcn/ui 블록 **`dashboard-01`** | **설치하지 않음** — 배치(요약 카드 줄 + 차트 + 표)만 따름 | MIT | 프로젝트 목록 · 사용량 · `src/components/pes/stat-card.tsx` |
| 머리줄 | **shadcn-admin**(satnaing) 레이아웃 | **구조만 참고**, 코드는 가져오지 않음 | MIT | `src/app/SiteHeader.tsx` · `ThemeMenu.tsx` |

- **사이드바**: 머리 = 프로젝트 전환(블록의 팀 전환 자리) · 전역 메뉴(프로젝트 · 나의 할 일 · 내 컴퓨터 · 사용량 · 알림 — 나의 할 일 배지는 ◆ + 수, 할 일이 없고 AI가 하는 중이면 도는 고리) · 작업 공간 안이면 작업 공간 묶음(지금 할 일 · 질문·답 · 결과물 · 자료 · 참고 프로젝트 · AI 작업 · 판 · 설정)과 단계·라운드 나무. **5차부터 두 벌**: 관리 공간은 전역 메뉴(“모아 보기” + 새 프로젝트)만, 연구 공간은 “← 모든 프로젝트” + 프로젝트 전환 → 연구 흐름(6단계 길) → 이 연구(연구 개요 · 지금 할 일 · 막힌 것·풀 것 · 결과 글 · 더 보기) — 전역 메뉴 없음(`data-space="manage|research"`). 접으면 48px 아이콘 줄(머리줄 단추 · Ctrl/Cmd+B · 가장자리), 현재 단계 아이콘은 라운드 드롭다운을 연다. 900px 미만은 왼쪽 Sheet. 처음에는 1280px 이상에서만 펼침, 사람이 바꾸면 그대로(블록 기본 쿠키 `sidebar_state`).
- **블록에서 고친 점**: 숨은 글자 한국어(“메뉴 접기·펴기 (Ctrl+B)”·“메뉴”) · 모바일 기준 768 → 900 · `SidebarInset`을 `div`로(본문 `<main>`은 하나) · Ctrl/Cmd+B 한글 조합 중 무시 · 초점 2px 실선 + 2px 간격 · 메뉴 링크는 사이드바 글자색(밑줄 없음) · 묶음마다 `role="navigation"` + 이름 · 수 배지는 눈에만, 같은 뜻을 링크 안 숨은 글로(“· 안 읽음 3건”).
- **머리줄**: 사이드바 단추 · 빵부스러기(현재 위치) · 명령 찾기(Ctrl/Cmd+K) · 갱신 칩(작업 공간 밖 — 안에서는 프로젝트 머리) · 알림(최근 4건 + 모두 보기) · 테마 · 사용자(이름 · 역할).
- **작업 공간**은 차트 없는 문서 중심: 위 지금 할 일 배너(+ AI 작업 · 내 컴퓨터/API 사용량 카드) → 가운데 결과 글(읽기 폭 46rem) · 오른쪽 질문 폼. 사이드바를 접으면 결과 글이 넓어진다.

### 테마

| 테마(tweakcn 이름) | 받은 곳 | 느낌 | PES 보정(대비 AA) |
|---|---|---|---|
| **Modern Minimal**(기본) | `https://tweakcn.com/r/themes/modern-minimal.json` | 흰 바탕 · 파랑 강조 | primary 흰 글자 3.68 → 5.17:1(같은 테마 chart-2) · 보조 글자 조금 진하게 · 어두운 모드 강조 글자 = dark chart-1 |
| **Vercel** | `https://tweakcn.com/r/themes/vercel.json` | 흑백 · 검정 강조 | 공통만 |
| **Graphite** | `https://tweakcn.com/r/themes/graphite.json` | 회색 바탕 · 짙은 회색 | 보조 글자(밝게 4.07 → 4.6+, 어둡게 4.13 → 5.6:1) |
| **Clean Slate** | `https://tweakcn.com/r/themes/clean-slate.json` | 푸른 회색 · 남보라 | primary 4.47 → 6.3:1(chart-2) · 보조 글자 · 어두운 모드 강조 글자 |

- **받는 방법**: 후보 4개 모두 `npx shadcn@4.23.0 view <주소>`로 받아 실제로 있음을 확인했다(대체 없음). `shadcn add <테마 주소>`는 `:root`·`.dark`와 `--font-sans`(Geist·Inter 등)를 덮어쓰므로 쓰지 않고, 받은 `cssVars.light`·`cssVars.dark`를 `src/themes/<이름>.css`의 **`.theme-<이름>`** · **`.theme-<이름>.dark`** 클래스로 그대로 옮겼다(각 파일 머리에 받은 곳·날짜·받지 않은 변수, 맨 아래 “PES 보정”에 바꾼 값과 받은 값).
- **받지 않은 것**: 글꼴(`font-sans`·`font-serif`·`font-mono` — **Pretendard 고정**) · 자간(`letter-spacing`·`tracking-*`, 한글 0) · 간격(`spacing`, Tailwind 기본 4px) · 그림자 재료 변수(합쳐진 `shadow-2xs`~`shadow-2xl`만 씀) · 테마의 `body { letter-spacing }`.
- **공통 보정**(모든 테마): `--destructive` = PES `bad`(받은 값은 카드 위 3.8~4.0:1) · `--input`(입력·체크 상자·라디오 테두리) = PES `control`(받은 값 1.2~1.9:1 → 3:1 이상).
- **바꾸는 법**: 머리줄 팔레트 단추 → 테마 4개 × 밝게 / 어둡게 / 시스템 따라. 메뉴를 닫지 않아 차례로 바꿔 볼 수 있다. 고른 값은 이 브라우저 `localStorage`(`pes-mock-theme`)에만 남고 서버에 보내지 않는다. 첫 그림 전에 `<html>` 클래스를 맞춰 깜박임이 없고, 인쇄할 때는 밝게 바꿨다가 되돌린다.
- **상태 색·방식 색은 테마마다 바꾸지 않는다**(같은 상태는 어디서나 같은 모양·글자·색). 밝게/어둡게 두 벌만 두고 옅은 바탕(`-soft`)·테두리(`-line`)만 테마 카드 색과 섞는다.
- **라이선스**: tweakcn(jnsahaj/tweakcn) **Apache License 2.0**(NOTICE 파일 없음) · shadcn/ui **MIT** · shadcn-admin **MIT**(참고만). 원문을 `public/licenses/tweakcn-Apache-2.0-LICENSE.txt` · `public/licenses/shadcn-ui-MIT-LICENSE.txt`로 함께 배포한다(빌드 뒤 `dist/licenses/`). 빌드는 CSS 주석을 모두 지우므로(Pretendard 고지도 같음) 고지는 원문 파일이 맡고, 출처는 `src/themes/*.css` 머리 주석에 남는다.

**대비 실측**(헤드리스 Edge, 변수 값을 실제로 그려 읽음, 2026-11-05):

| 테마 · 밝기 | 단추 글자 | 링크(카드 위) | 상태 칩 최소 | 입력 테두리 | 초점 | 계기 최소 | 글자 최소(11쌍) | 비텍스트 최소(10쌍) |
|---|---|---|---|---|---|---|---|---|
| Modern Minimal · 밝게 | 5.17 | 5.17 | 5.85 | 3.84 | 5.17 | 3.63 | 4.51 | 3.63 |
| Modern Minimal · 어둡게 | 5.17 | 5.95 | 6.26 | 3.58 | 7.05 | 4.02 | 5.17 | 3.58 |
| Vercel · 밝게 | 21.0 | 21.0 | 5.85 | 8.45 | 20.5 | 3.63 | 5.85 | 3.63 |
| Vercel · 어둡게 | 21.0 | 19.9 | 8.64 | 4.14 | 8.42 | 7.75 | 7.99 | 3.89 |
| Graphite · 밝게 | 6.29 | 5.77 | 5.39 | 3.72 | 5.52 | 3.40 | 4.99 | 3.37 |
| Graphite · 어둡게 | 6.66 | 6.23 | 6.72 | 3.39 | 6.66 | 4.22 | 5.05 | 3.39 |
| Clean Slate · 밝게 | 6.29 | 6.29 | 5.85 | 4.26 | 6.01 | 3.63 | 5.44 | 3.63 |
| Clean Slate · 어둡게 | 5.98 | 7.28 | 6.00 | 3.57 | 5.98 | 4.58 | 5.76 | 3.57 |

따로 28개 주소 × 8벌의 **화면 글자 전수 검사**(요소마다 실제 바탕을 찾아 계산)에서 4.5:1 미만 0건.

## 화면(라우트)

| 화면 | 주소 | 정적 시안 | 설계 |
|---|---|---|---|
| **관리 공간** — 프로젝트 목록 · 나의 할 일(요약 카드 + 표 · 줄마다 차례 표시기 · 막힌 것 수) | `/` | projects.html | 4.1 · 12.9 · 15 · 16.1 |
| 새 프로젝트 · 방식 고르기 | `/new` | new-project.html | 4.2 |
| 방식 A 만들기 6칸(AI 연결 추가 · 파일·폴더 담기) | `/new/a?step=1..6` | new-project.html #wizard | 4.3 · 13.2 · 13.3 |
| 방식 B 등록 안내 | `/new/b` | new-project.html #mode-b | 4.4 |
| 기기 승인 | `/device` | new-project.html #mode-b | 4.4 |
| **연구 공간** — 연구 개요(이어서 하기 · 연구 질문 · 핵심 발견 · 남은 문제 · 다음 마일스톤) | `/p/dolbom-insight` | (새 화면) | 16.2 · 16.5 |
| 연구 공간 — 지금 할 일(가운데에 한 가지: 질문 · 결과 글과 문제 표시 · 해결 흐름 · 승인) · 방식 B · 조사 R2 | `/p/dolbom-insight/e/1/s/research/r/2?t=answer\|review\|sync\|refs\|approve\|p-px-f5` | workspace.html | 4.7 · 16.3 · 16.4 |
| 연구 공간 — 막힌 것·풀 것(연구 내용 3 · 진행 3 · 해결 기록) | `/p/dolbom-insight/problems` | (새 화면) | 16.4 |
| 연구 공간 — 단계 결과(지난 단계 요약 · 아직) | `/p/<프로젝트>/s/<단계>` | (새 화면) | 16.2 |
| 연구 공간 — 방식 A · 사용량 멈춤(막힌 것 “AI 실행 멈춤”) | `/p/youth-housing/e/1/s/plan/r/1` | (새 장면) | 4.12 · 16.4 |
| 연구 공간 — 방식 A · 단계 시작 질문 | `/p/rural-care-access/e/1/s/plan/r/start` | (새 장면) | 4.5 · 16.3 |
| 연구 공간 — 방식 B · AI가 하는 중(소식 없음 · AI 접속 미확인) | `/p/ltc-survey/e/2/s/research/r/1` | (새 장면) | 4.11 · 15 · 16.3 |
| 연구 공간 · 더 보기 — AI 작업 기록(핵심 상태 + 실행 · 타임라인) | `/p/<프로젝트>/ai` | workspace.html #ai | 4.10 |
| 연구 공간 · 더 보기 — 자료(파일·폴더째 올리기, 폴더 단위 AI 참조) | `/p/<프로젝트>/files` | materials.html | 4.8 · 13.3 |
| 연구 공간 · 더 보기 — 참고 프로젝트 | `/p/<프로젝트>/references` | workspace.html #refs | 4.9 |
| 연구 공간 · 더 보기 — 프로젝트 설정(AI가 읽기 허용·막음 · AI 연결·모델) | `/p/<프로젝트>/settings` | (일부 usage.html) | 4.14 |
| 연구 공간 · 더 보기 — 내 컴퓨터 연결(이 프로젝트 · 동기화 표) | `/p/<프로젝트>/sync` | workspace.html #states | 4.11 |
| 관리 공간 — 사용량(요약 카드 · 추이 차트 · AI 연결별 사용량·한도) | `/usage` | usage.html | 4.12 · 13.2 · 12.9 |
| 관리 공간 — 내 컴퓨터(모든 기기) | `/computer` | workspace.html #states | 4.11 |
| 관리 공간 — 알림 | `/notifications` | mobile.html 1번 | 4.13 |
| 휴대폰 8화면 | `/mobile` | mobile.html | 4.16 |
| 상태 견본(빈·로딩·오류·권한 없음·끊김·충돌·차단·미상 + 차례 표시기 견본 5 + 상태 사전 전체) | `/states` | 각 시안의 상태 견본 | 3.6 · 6절 · 15 |
| 시안 안내(화면 목록 · 명령 대응) | `/guide` | index.html | — |

**시안 도구**(머리줄 오른쪽 끝 점선 “시안” 단추 → 오른쪽 판): 이 화면 설명 · 시안 안내/상태 견본/휴대폰 링크 · “시안 설명 상자 보이기”(기본 끔) · **시안 조작** — 보는 사람(소유자·편집자·읽기) · 네트워크(정상·느림·응답 유실·끊김) · 변경 알림 통로(실시간·느린 갱신) · 다음 제출 버전 충돌 · **차례 바뀜 장면(4차)** — 장기요양 2판이 AI가 하는 중(소식 있음, 점이 돎) → 6초 뒤 AI가 질문 2개를 올리고 나의 할 일로 바뀜(목록에서 재생 / 작업 공간에서 재생, 여러 번 재생 가능) · AI 새 질문 흉내 · 커서 무효 흉내 · 목 자료 처음으로. 불린 명령 이름도 보인다.

## 구조

```text
src/
  api/        types.ts(명령·읽기 이름 = stage-1-api) · mock-client.ts(메모리 목 서버) · queries.ts(TanStack Query) · policy.ts(목적지별 AI 제공 계산)
  mocks/      합성 자료(프로젝트 4 · 작업 공간 4장면 · 자료 · 사용량 + 추이 · AI 연결 2 · 알림) · research.ts(5차: 연구 질문 · 핵심 발견 · 연구 내용 문제 · AI 제안 · 지난 단계 요약 · 해결 기록)
  app/        router.tsx(경로 단위 코드 분할) · RootLayout(사이드바 + 머리줄 셸) · SiteHeader · ThemeMenu · CommandMenu(Ctrl/Cmd+K) · MockControls(“시안” 단추 = 시안 도구 판) · TurnAnnouncer(차례 전환 알림 — 앱에 하나)
  components/ app-sidebar · team-switcher · nav-main · nav-projects · nav-user (sidebar-07 블록 파일 — PES 내용)
              ui/(shadcn 생성본, PES에 맞게 고침) · pes/(상태 사전·칩·확인 대화 상자·계기·지금 할 일·요약 카드·단계 모양·차례 표시기 turn.tsx 등)
  features/   화면별 폴더 — research/(5차: 연구 개요 · 막힌 것·풀 것 · 해결 흐름 ResolveFlow · AI 동료 · 단계 결과 · 내 컴퓨터 연결 · place.ts 위치 이름)
  hooks/      use-mobile(사이드바 Sheet 기준 900px)
  themes/     pes.css(PES 공통 토큰·상태 색 — 밝게/어둡게) · modern-minimal.css · vercel.css · graphite.css · clean-slate.css(tweakcn) · themes.ts(목록)
  lib/        draft.ts(같은 탭 초안) · mock-settings.ts(시안 조작 · 화면 읽기 알림) · theme.ts(테마 고르기 · localStorage)
              research-ui.ts(5차: 집중 모드 · J/K · AI 동료 칸 · 마지막 위치 — 이 브라우저에만)
public/
  fonts/pretendard-OFL-1.1-LICENSE.txt · licenses/tweakcn-Apache-2.0-LICENSE.txt · licenses/shadcn-ui-MIT-LICENSE.txt
```

- **쓰기 경로 하나**: 모든 단추는 `COMMANDS`의 닫힌 명령 하나로만 바뀐다(`pes.command(name, input, { idempotencyKey })`). Server Actions 같은 두 번째 쓰기 경로가 없다. 테마 고르기는 브라우저 설정일 뿐 명령이 아니다.
- **멱등·영수증**: 같은 키 = 처음 결과 재생. “됨”은 영수증(접수 번호) 뒤에만. 1.2초 넘으면 “접수 확인 중”, 보낸 뒤 응답 유실은 “결과 미확인 → 같은 요청 번호로 확인”, 보내기 전 끊김은 “보내지 않음”.
- **변경 알림**: 목 서버가 번호만 실은 알림을 보내면 `GET changes` 흉내로 tx 묶음을 받아 바뀐 읽기 키만 무효화한다(폴링 없음, 탭 숨김 때 받지 않고 돌아오면 한 번). 커서 무효면 화면 자료만 다시 받고 초안·초점은 둔다. 사이드바·머리줄은 화면과 같은 읽기(목록·작업 공간·알림)를 나눠 쓴다(새 읽기 없음).
- **권한**: 단추를 숨기지 않고 `aria-disabled` + 이유 문장. 목 서버가 역할을 다시 검사한다. 정책 변경(끄기 포함)은 요청 한 건마다 본인 확인 단계를 거친다.

## 디자인 토큰

shadcn 변수(`--background`·`--card`·`--primary`·`--sidebar`·`--chart-*`·`--radius`·`--shadow-*` …)는 **테마 파일**이, PES 변수는 **`src/themes/pes.css`** 가 정한다. Tailwind 쪽 연결은 `src/index.css`의 `@theme inline`.

| 이름 | 값(어디서) | 쓰임 |
|---|---|---|
| `background` · `card` · `popover` · `foreground` · `muted(-foreground)` · `secondary` · `accent` · `border` · `ring` · `sidebar-*` · `chart-*` | 테마(tweakcn) + PES 보정 | 화면 바탕 · 카드 · 글자 · 보조 글자 · 고른 칸 · 장식 테두리 · 초점 · 사이드바 |
| `primary` / `primary-foreground` | 테마(+보정) | 채운 단추·배지 바탕 / 그 위 글자(4.5:1 이상) |
| `primary-ink` | 밝게 = `primary`, 어두운 모드는 테마별 보정 | 카드·바탕 위의 강조 글자 · 링크 · 작은 모양 |
| `primary-soft` / `primary-line` | `primary` 10%(어둡게 14%) / 40% + 카드 | 고른 줄 · 강조 꼬리표 / 그 테두리 |
| `surface` · `surface-soft` · `surface-sunk` | 카드 / `muted` 60% + 카드 / `secondary` 60% + 카드 | 카드 · 표 머리·지난 항목 / 못 누르는 단추 |
| `ink` · `ink-2` | `foreground` / `foreground` 70% + `muted-foreground` | 본문 / 보조 본문 |
| `line` · `line-strong` | `border` / `foreground` 22%(어둡게 26%) + `border` | 장식 테두리(정보 전달에 안 씀) / 조금 진한 테두리 |
| `control` · `input` | `foreground` 58%(어둡게 48%) + 카드 | 입력·스위치·체크 상자 테두리 — 카드·바탕·사이드바 위 3:1 이상 |
| 상태 `ok` | 밝게 `#1a6b43` · 어둡게 `oklch(0.8 0.13 155)` · 바탕/테두리 = `#2f9e66`(어둡게 oklch 0.65) 10%·45%(12%·50%) + 카드 | 됨 · 켜짐 · 허용 |
| 상태 `warn` | `#7a4f00` · `oklch(0.85 0.13 85)` · 바탕 = `#e0a800` 14%(어둡게 12%) + 카드 | 주의 · 부분 · 새 버전 |
| 상태 `bad` | `#9b2f2f` · `oklch(0.78 0.13 22)` · 바탕 = `#d64545` 10%(12%) + 카드 | 막힘 · 실패 · 충돌 · 차단 (= `destructive`) |
| 상태 `off` | `foreground` 75%(어둡게 60%) + `muted-foreground` · 바탕 `muted` 70% + 카드 | 꺼짐 · 금지 · 아직 |
| 상태 `unk`(미상) · `you`(사람 차례) · `run`(진행) | 점선 `control` 테두리 + 카드 / `primary` 채움 + `primary-foreground` / `primary-soft` + `primary-ink` | 미상 · 나의 할 일 · 진행 중 |
| 방식 A / B | `#8f4500` / `#553896`(어둡게 oklch 0.82) · 바탕 = 주황·보라 10%(12%) + 카드 | 방식 배지 |
| 계기 | 채움 `primary-ink` · 주의 `#a56c00` · 넘음 `#b42f2f`(어둡게 상태 글자색) / 바탕 = 같은 색상 18~28% + 카드 | 채움/바탕 3:1 이상, 문턱 선은 카드색 테두리 2px |
| `highlight` | `#ffd84d` 38%(어둡게 oklch 0.75 30%) + 카드 | 결과 글에서 고른 문장 |
| 모양 9가지 | 채운 원 · 고리 · 마름모 · 세모 · 채운 네모 · 빈 네모 · 점선 고리 · 두 줄 · 가로줄 | SVG `currentColor`(강제 색 모드에서도 남음), `aria-hidden` |
| 글꼴 `font-sans` | `"Pretendard Variable", Pretendard, system-ui, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif` — **테마가 바꾸지 않음** | 본문 14px(0.875rem) · 줄 1.6 · `word-break: keep-all` |
| 글꼴 `font-mono` | `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` | 코드·지문 |
| 글자 크기 · 굵기 | html 87.5%(rem 14px — 사용자 결정 2026-11-08): 쪽 제목 18px · 지금 할 일 제목 15.75px · 묶음 제목 14px · 결과 글 14.5px(줄 1.85) · 본문 12.25px · 작은 글 11.5~12px · 칩 · 표 머리 11px — **바닥 11px**(6차, `--text-xs: max(0.75rem, 11px)`) / 제목 600 · 이름표·단추·칩 500 · 본문 400 | 휴대폰 입력 16px(확대 방지) · 굵은 포인터 누르는 곳 44px(6차 — px 고정, 층 밖 규칙) |
| 숫자 | 표는 `tabular-nums`, 요약 카드의 큰 수는 비례 숫자 | 자릿수 맞춤 |
| 모서리 · 그림자 | 테마 `--radius`(Modern Minimal 6px · Vercel 8px · Graphite 5.6px · Clean Slate 8px)에서 sm −2 · md · lg +2 · xl +4px / 테마 `shadow-*` | 카드 `rounded-xl` · 단추 `rounded-lg` · 칩 999px |
| 배치 기준 | `tab` 900px · `desk` 1280px · `wide` 1440px | 사이드바 240px · 접으면 48px · 900 미만 Sheet / 작업 공간 1280+ 결과 글 + 질문 380px(1440+ 404px) · 1280 미만 한 열 + 보기 전환 · 휴대폰 = 900 미만 + 굵은 포인터(`phone:`) |
| 초점 | 2px 실선 `ring` + 간격 2px | 모든 컴포넌트·사이드바 같은 값 |
| 누르는 곳 | 굵은 포인터에서 단추 44px(작은 단추 40px) | |

## 글꼴 — Pretendard

- npm 패키지 `pretendard` **1.3.9(고정)** 의 `dist/web/variable/pretendardvariable-dynamic-subset.css`를 `src/main.tsx`에서 불러온다. Vite가 woff2 **92개 subset**을 `dist/assets/`에 넣고, 브라우저는 `unicode-range`로 화면에 나온 글자 묶음만 받는다. `font-display: swap`.
- **외부 CDN을 부르지 않는다** — 오프라인·로컬 PES 서버에서도 그대로 동작한다.
- **테마가 글꼴을 바꾸지 않는다**: tweakcn 테마의 `font-sans`(Inter·Geist 등)·`font-serif`·`font-mono`는 받지 않았고 `@theme inline`이 Pretendard를 직접 넣는다(8벌 모두 계산된 `font-family` 확인).
- 라이선스: **SIL Open Font License 1.1**. 원문을 `public/fonts/pretendard-OFL-1.1-LICENSE.txt`로 함께 배포한다(빌드 뒤 `dist/fonts/`).

## 사용한 shadcn/ui 컴포넌트·블록

생성(`radix-vega` 스타일, `radix-ui` 1.8.1): Alert · Avatar · Badge · Breadcrumb · Button · Card · Chart · Checkbox · Collapsible · Command(+InputGroup) · Dialog · DropdownMenu · Input · Label · **Popover**(3차 — `npx shadcn@4.23.0 view popover` 원본에서 `"use client"`만 뺌) · Progress · RadioGroup · ScrollArea · Select · Separator · Sheet · **Sidebar** · Skeleton · Sonner(토스트) · Switch · Table · Tabs · Textarea · Toggle · ToggleGroup · Tooltip. 3차 PES 부품 `components/pes/disclosure.tsx`: **More**(자세히 — Collapsible) · **InfoTip**(ⓘ 설명 — Popover, 터치·키보드로 열림) · **FoldCard**(제목 한 줄로 접힌 묶음 — h2 안의 단추, aria-expanded) · `blocks.tsx`의 **StatBar**(핵심 상태 3~4칸). 블록: **sidebar-07**(설치) · **dashboard-01**(배치만).

PES에 맞춰 고친 것: 초점 링(50% 투명 링 → 2px 실선 + 간격 2px, 대비 확보) · `aria-disabled` 스타일(못 누르는 단추도 초점을 받음) · Switch 모양(켜짐 초록·꺼짐 카드 바탕) · Table(가로 스크롤 영역을 `role="region"`+초점, 칸 줄바꿈, 캡션 위, 표 머리 옅게) · Dialog(긴 내용 스크롤) · Sonner(next-themes 의존 제거) · 숨은 영어 글자 한국어로(“닫기” 등) · `shadcn/tailwind.css`의 쓰는 변형만 옮겨 CLI 의존 제거. **2차**: Sidebar(위 “블록에서 고친 점”) · Toggle 고른 칸 = 바탕 + 굵기 + 테두리(색만으로 구분하지 않음) · Button outline/ghost 누름 바탕 = 테마 `accent`, 기본 단추 누름 = `primary/90` · Card·Table·Dialog 모서리·그림자·테두리 = 테마 값 · 굵기 shadcn 기본(600/500).

## 의존성(모두 고정 버전)

실행 12: react · react-dom 19.3.1, react-router 8.5.1, @tanstack/react-query 5.106.0, radix-ui 1.8.1, cmdk 1.1.1(명령 메뉴), sonner 2.0.8(토스트), lucide-react 1.68.0(단추·메뉴 아이콘), class-variance-authority 0.7.1, cn 0.5.2(클래스 병합), pretendard 1.3.9(글꼴), **recharts 3.8.0**(2차 — 사용량 추이 차트, 사용량 화면에서도 따로 불러오는 묶음). 개발 9: vite 8.3.5, @vitejs/plugin-react 6.2.1, typescript 7.0.2, tailwindcss · @tailwindcss/vite 4.3.4, tw-animate-css 1.4.0, @types/react · react-dom 19.3.0, @types/node 26.6.6. 사이드바·드롭다운·아바타는 이미 있던 `radix-ui`·`lucide-react`로 충분해 새 패키지가 없다.

## 빌드 결과(2026-11-05 2차, 이 폴더에서)

- **6차**: `npm run typecheck` 0 오류 · `npm run build` 성공(경고 없음) · 첫 묶음 JS 577 kB(gzip 174 kB — 5차와 거의 같음, 경로 초점 · 스크롤 되살림은 react-router 내장) · 연구 공간 틀 묶음 38 kB(gzip 13 kB) · CSS 197 kB(gzip 39 kB) · **새 의존성 없음**

- **5차**: `npm run typecheck` 0 오류 · `npm run build` 성공(경고 없음) · 첫 묶음 JS 576 kB(gzip 174 kB — 연구 공간 목 자료 · 막힌 것 계산 · 사이드바 두 벌) · **연구 공간 틀 묶음 38 kB(gzip 13 kB, 따로 불러옴)** · CSS 196 kB(gzip 39 kB) · 사용량 차트 묶음 372 kB 그대로

- **4차**: `npm run typecheck` 0 오류 · `npm run build` 성공(경고 없음) · 첫 묶음 JS 532 kB(gzip 161 kB — 3차 515/156, 차례 표시기·알림 부품) · CSS 193 kB(gzip 38 kB) · 사용량 차트 묶음 372 kB 그대로

- **3차**: `npm run typecheck` 0 오류 · `npm run build` 성공(경고 없음) · 첫 묶음 JS 515 kB(gzip 156 kB) + 공용 부품 묶음 `disclosure` 62 kB(gzip 22 kB — 지금 할 일·상태 줄·자세히·ⓘ·Popover) · CSS 192 kB(gzip 38 kB) · 사용량 차트 묶음 372 kB 그대로

- `npm run typecheck`: 0 오류 · `npm run build`: 성공(경고 없음)
- 첫 묶음 JS 568 kB(gzip 175 kB — 1차 490/151, 사이드바·드롭다운·테마 저장소 포함) + 화면별 묶음 0.3~31 kB + 공용 묶음 140 kB(1차에도 있음) · **사용량 차트 묶음 372 kB(gzip 108 kB) — `/usage`에서만 따로 불러옴** · CSS 190 kB(gzip 38 kB — 1차 142/31, 테마 4개 포함)
- 글꼴 woff2 92개 합계 약 3.0 MB — 한 화면은 쓰는 글자 묶음만 받는다
- 정적 서빙 확인: `npm run preview`로 모든 주소(깊은 주소 포함)가 열림

## 점검(헤드리스 브라우저, 합성 자료)

- **6차(UI/UX 점검 — ui-ux-pro-max)**: 시험 56가지 PASS — 5차 42가지는 **기대를 바꾸지 않고 그대로 통과**(N14의 시험 스크립트 경쟁 조건만 고침 — [논의 기록 12.5](../../discussion/2026-11-05-dashboard-v2-react-notes.md)) + 6차 새 시험 14가지(U1 문서 제목 · U2 화면이 바뀌면 제목으로 초점 · U2b 마법사 칸 · U3 휴대폰 판 · 명령 메뉴에서 옮긴 뒤 · U4 뒤로 가기 스크롤 · U4b 처음 불러올 때 `#조각`(개발 서버 StrictMode에서도) · U5 390 터치 44px(넓힌 누름 영역 포함) · U5b 데스크톱 크기 그대로(작은 단추 28 · ⓘ 24 · xs 24) · U6 해결 흐름 이유 늘 보임 · 다른 단추는 누르면 보임 · U6b 막힌 스위치 · U7 글자 11px 바닥(1440 · 390) · U8 커서 · U9 제목 단계 · “부탁할 말” 이름표 · U10 채운 단추 하나). 화면 점검 336번(5차와 같은 32개 주소·상태 × 8벌 × 1440 + 10개 × 8벌 × 390) — 글자 44,218개 대비 4.5:1 미만 0 · 가로 넘침 0 · ‘Go’ 0 · 콘솔 오류 0. 터치 태블릿 912 · 1024 · 1180 · 1366 × 13개 주소(굵은 포인터 44px가 데스크톱 배치에서 넘치지 않는지) · 중간 폭 1100 · 1280 · 1366 × 11개 · 휴대폰 320 · 360 · 390 × 13개 — 넘침 0, 머리줄 넘침 0. 넓힌 누름 영역(머리줄 아이콘 · ⓘ · 스위치 · 체크 상자)은 가운데에서 위아래 ±21px를 눌러 그 조작이 잡히는지 확인
- **5차(관리 공간 / 연구 공간)**: 시험 42가지 PASS — 지난 회차 시험(1차 · 3차 · 4차)을 새 구조에 맞춰 다시 쓴 24가지 + 5차 새 시험 16가지 + 전 주소 옛 말 · ‘Go’ · 넘침 2가지(바뀐 기대는 [논의 기록 11.5](../../discussion/2026-11-05-dashboard-v2-react-notes.md)). 화면 점검 336번(32개 주소·상태 × 8벌 × 1440 + 10개 × 8벌 × 390, 문제 표시·보드 카드·집중 모드·AI 동료 판 펼친 상태 포함) — 글자 44,130개 대비 4.5:1 미만 0 · 가로 넘침 0 · ‘Go’ 0 · 콘솔 오류 0. 중간 폭 1100·1280·1366, 휴대폰 390·320 넘침 0. 휴대폰 흉내의 넘침은 `innerWidth`가 아니라 기기 폭과 비교한다(내용이 넓으면 `innerWidth`도 늘어남 — 이 허점으로 숨어 있던 순서 줄 넘침을 고쳤다).
- **4차(상태 이름 · 차례 표시기)**: 29개 주소 × 8벌 × 1440 · 6화면 × 8벌 × 390 · 자세히·접힌 묶음을 모두 펼친 11화면 × 8벌 × 1440·390 · **차례 바뀜 장면 재생 중·뒤**(목록 · 장기요양 작업 공간) × 8벌 × 1440·390 — 520번 모두 가로 넘침 0 · 겹침 0 · 글자 대비 4.5:1 미만 0 · ‘Go’ 0 · 콘솔 오류 0(작은 트랙 56px로 넓힌 뒤 해당 화면 88번 다시 — 모두 0). 기존 시험 24가지 다시 PASS + 새 시험 10가지 PASS(줄마다 표시기 · 사이드바 배지 · 장면 재생 ①②③ · 작업 공간 띠 · 움직임 줄이기 · AI가 읽기 스위치 · 옛 말 0 · 콘솔 0). 차례 표시기 비텍스트 대비(8벌): 공·고리 대 트랙 최소 3.08:1 · 공 안 아이콘 5.17:1 · 도는 점 4.95:1. 시험 브라우저는 창 가림 판정을 끄고 돌렸다(가려진 헤드리스 창은 hidden으로 잡혀 앱이 설계대로 변경 알림을 미룸).
- **3차(정보 밀도)**: 29개 주소 × 8벌 × 1440 · 주요 4화면 × 8벌 × 390 · 자세히·접힌 묶음을 모두 펼친 10화면 × 8벌 × 1440·390 — 424번 모두 가로 넘침 0 · 겹침 0 · 글자 대비 4.5:1 미만 0 · ‘Go’ 0 · 콘솔 오류 0. 1차 동작 16가지 다시 PASS + 새 동작 8가지 PASS(자세히 Enter·Space · ⓘ 열기/Esc/초점 복귀 · 의견 남기기 · “시안” 단추와 시안 설명 상자 · 권한 문구는 그 역할에서만 · 접힌 묶음 · 콘솔 오류 0). 첫 화면 글자(1440): 작업 공간 1127 → 675 · 목록 725 → 498 · 사용량 811 → 362.
- **2차(테마)**: 28개 주소 × 테마 4 × 밝게/어둡게 × 1440 — 가로 넘침 0 · 단추·링크 겹침 0 · 글자 대비 4.5:1 미만 0 · ‘Go’ 0 · 콘솔 오류 0. 주요 4화면(목록 · 작업 공간 · 자료 · 사용량) × 8벌 × 390(터치)·320, 6화면 × 2벌 × 1280·1366·1100 같음. 테마 변수 대비 실측은 위 표. 상호작용: 휴대폰 Sheet · 접힌 줄 라운드 드롭다운 · 테마 메뉴(즉시 바뀜 · 새로고침 뒤 유지) · Ctrl+K · Ctrl+B · 첫 Tab 건너뛰기.
- 1차 동작 16가지(새 빌드에서 다시 돌려 모두 통과): 이 질문만 보내기 → 접수 번호 · 응답 유실 → 결과 미확인 → 같은 키 재확인 → 처음 영수증 재생 · 버전 충돌 → 아무것도 접수 안 함 · AI 참조 끄기(회수 불가 안내 → 본인 확인 → 접수 → 표 갱신) · 폴더째 올리기(미리 보기 → 진행 → 일부 실패 → 실패만 다시) · 확인 안 된 호출 정리(근거·이유 필수) · AI 연결 추가(쓴 만큼 과금은 상한 없으면 저장 막힘, 키 다시 안 보임) · 편집자 막힘(이유와 함께) · 첫 Tab = 건너뛰기 링크 · Ctrl+K · 한글 조합 중 단축키 무시 · 좁은 화면에서 링크가 보기 전환.
- 1차 폭 점검: 1440 · 1366 · 1100 · 390(터치) · 320 — 모든 주소에서 가로 넘침 0(넓은 표는 그 표 안에서만 가로 스크롤).
- 못 한 것: Windows 맑은 고딕·실제 한글 IME·NVDA/VoiceOver 낭독·Windows 고대비(강제 색) 테마별 확인·인쇄 쪽 나눔(stage-1-ui 6절 수동 시험 대상).
