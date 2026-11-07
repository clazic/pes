# 0017. 웹 대시보드 화면은 React + Vite + TypeScript + Tailwind CSS + shadcn/ui로 만든다

- 날짜: 2026-11-05
- 담당: 3단계 U1(틀) · U2~U6 · REF1 · MAT1, 5단계 WEB1 · WEB3 · WEB14. 기록: Claude(Opus 5.5)
- 상태: **채택(사용자 결정 2026-11-05)**
- 시안: [mockups/dashboard-v2-react/](../mockups/dashboard-v2-react/README.md) · 설계: [ui/dashboard-v2.md](../ui/dashboard-v2.md) 12절 · 논의: [discussion/2026-11-05-dashboard-v2-react-notes.md](../discussion/2026-11-05-dashboard-v2-react-notes.md)

## 문제

웹 대시보드 v2(화면 16개·흐름 5개)는 질문 폼·첨언 앵커·초안·변경 알림·확인 대화 상자·휴대폰 흐름처럼 상태가 많은 화면이다. 확정 계획([stage-1-ui.md](../stage-1-ui.md) 4절, [stage-3.md](../stage-3.md) U1, [stage-5.md](../stage-5.md) WEB1)은 **서버 렌더 + ES 모듈 섬**을 기술로 적고, 로컬 TS·웹(Workers) 템플릿 공유를 U1에서 약 1주 시험하기로 했다. 그러나

- 화면 대부분이 상호작용이라 “섬”이 화면 전체가 되고, 서버 HTML과 클라이언트 상태를 두 번 맞추는 비용이 크다.
- Cloudflare 무료의 요청당 CPU 10 ms에서 서버 렌더는 가장 큰 위험이다(stage-5 2.1 “SSR·인증 10–20 ms 출처 미확인”). 정적 자산 요청은 무료·무제한으로 표기돼 있다.
- 로컬 PES 서버(2~4단계)와 웹(5단계) 모두에서 같은 화면을 내야 하고, 플랫폼(0005)은 아직 후보 3군이다.
- 원칙 0(“검증된 쓰기 경로 하나”)을 지키려면 화면이 PES API 말고 다른 쓰기 경로를 가지면 안 된다.

## 선택지

1. **React + Vite + TypeScript + Tailwind CSS + shadcn/ui** — 정적 빌드(SPA), 화면은 PES HTTP API만 부름. 라우팅 React Router(또는 TanStack Router), 서버 자료 TanStack Query.
2. **Next.js**(App Router·서버 컴포넌트·Server Actions) — 서버 렌더와 상호작용을 한 틀에서.
3. **서버 렌더 HTML 유지 + ES 모듈 섬**(확정 계획) — TS 템플릿을 로컬·웹이 공유, 상호작용 부분만 JS.

## 채택

**1번.**

- 화면 앱은 Vite로 **정적 빌드**하고, 로컬 PES 서버와 5단계 웹이 같은 `dist/`를 정적 자산으로 내준다. 화면은 `/api/v1/…`만 부른다.
- 라우팅은 **React Router**(데이터 라우터, 경로 단위 코드 분할), 서버 자료는 **TanStack Query**(폴링 없음 — 변경 알림 → 바뀐 읽기만 무효화). 대안 TanStack Router는 U1에서 바꿀 근거가 생길 때만 본다.
- UI 부품은 **shadcn/ui(radix)** 를 저장소 안 코드로 생성해 PES 토큰·접근성 규칙(2px 초점, `aria-disabled`+이유, 한국어 숨은 글자)에 맞춰 고쳐 쓴다.
- 글꼴은 **Pretendard Variable**(npm `pretendard` 고정 버전, 동적 subset woff2)을 앱과 함께 번들해 **자체 호스팅**한다. 외부 CDN을 부르지 않는다(2026-11-05 사용자 추가 결정).

## 이유

- **정적 빌드를 로컬 PES 서버가 그대로 내줄 수 있다.** 사용자는 화면 빌드 서버를 따로 돌리지 않는다(stage-1-ui 4절의 “별도 화면 빌드 서버를 요구하지 않음”은 그대로 지켜짐 — 빌드는 배포 때 한 번).
- **Cloudflare 무료와 맞다.** 정적 자산은 무료·무제한(표기), 서버 렌더 CPU 10 ms 위험을 화면에서 없앤다. Worker는 API·인증만 맡는다.
- **플랫폼을 갈아타기 쉽다.** 정적 파일 + HTTP API라 Cloudflare·Vercel·VPS(0005 후보 3군) 어디서나 같다.
- **쓰기 경로가 하나로 남는다.** Server Actions 같은 두 번째 쓰기 경로가 없고, 모든 변경이 PES의 닫힌 명령(멱등 키·영수증·같은 tx 사건)을 지난다.
- TypeScript 단일 언어(0016)와 같은 언어라 API 타입·DTO·검증·글자 뽑기 코드를 공유한다.
- **Next.js를 버린 이유**: 서버 렌더 런타임이 필요해 Workers CPU 10 ms·플랫폼 결합 위험이 다시 생기고, Server Actions는 원칙 0의 두 번째 쓰기 경로가 된다. 로컬 PES 서버가 Next 서버를 품어야 해 설치·실행도 무거워진다.
- **서버 렌더 HTML 유지를 버린 이유**: 상호작용이 화면 대부분이라 템플릿(서버)과 상태(클라이언트)를 이중으로 맞춰야 하고, 웹에서는 렌더가 Worker CPU를 쓴다. 템플릿 공유 시험(U1 약 1주)의 목적도 이 결정으로 사라진다.

## 영향

계획 문서(stage-*.md·roadmap)는 이 기록에서 고치지 않는다. 어긋나는 곳은 아래와 논의 기록에 적고, 해당 이슈를 시작할 때 문서를 맞춘다.

1. **시작 시점 — 3단계 U1부터.** 2단계 PR18은 계획 그대로 **기존 화면의 DB/API 동등 전환**(새 디자인 없음, TS 서버 렌더 테스트 + Playwright 스모크)이다. 새 대시보드 앱은 U1이 틀(셸·라우트·딥링크·갱신·초안)을 세우고 U2~U6·REF1·MAT1이 화면을 채운다. 기존 화면과의 병행(stage-1-ui 결정 12)·4단계 기본 전환(U12)도 그대로다.
2. **어긋나는 계획 문장(고치지 않음, 이슈 착수 때 맞춤)**: stage-1-ui 4절 “서버 렌더 + ES 모듈 섬”·“로컬 TS/웹 템플릿 공유 U1 시험”, stage-3 U1 범위의 “템플릿 공유 시험(상한 약 1주)”·기술 경계 문장, stage-5 WEB1 “Worker 앱(서버 렌더 + ES 모듈)”, stage-1-ui 6절·stage-3 공통의 “TS 테스트(서버 렌더 HTML·상태 전이)”, dashboard-v2 3.6 “첫 표시 = 서버가 그린 화면”. 대신: **첫 표시 = 정적 셸 + 첫 읽기 묶음 한 번**(0.3초 넘을 때만 조용한 “불러오는 중” 한 줄, 뼈대 깜박임 없음), 딥링크는 정적 서버의 **SPA 되돌림**(모든 앱 주소 → `index.html`)으로 같은 화면을 복원.
3. **로컬 PES 서버**: 빌드 산출물(`dist/`)을 정적으로 내주고, `/api/v1/`이 아닌 앱 주소는 `index.html`로 되돌린다. 기존 ask 링크(`/<slug>/ask-…`)는 새 주소로 넘긴다. **빌드는 배포하는 쪽이 한다** — 플러그인은 git 태그로 배포되므로 릴리스 때 만든 `dist/`를 배포물에 넣는다(사용자 PC에서 `npm install`·빌드하지 않음). 넣는 방법(태그 커밋 · 릴리스 묶음)은 PR26·U1에서 정한다.
4. **5단계 웹**: 화면은 **정적 자산**(Cloudflare Workers Assets 등, 0005 후보 공통)으로 배포하고 Worker는 API·인증·변경 알림만 맡는다. stage-5 WEB1의 “서버 렌더 + ES 모듈”은 “정적 앱 + API Worker”로 읽는다. 정적 자산 요청이 100k/일 집계에 드는지는 계획대로 WEB0·WEB1에서 실측한다(미확인).
5. **읽기 경로가 더 필요하다.** 서버 렌더는 화면마다 서버가 자료를 모아 그렸지만, SPA는 화면마다 **JSON 읽기 경로**가 있어야 한다: 프로젝트 목록(G24 — 2단계 닫힌 목록에 없음), 사용량 요약, AI 연결 목록, 내 컴퓨터 요약, 알림. 각 읽기는 쓰기와 같은 권한·정책 검사를 거친다. 담당: PR14(목록) · U1(작업 공간 읽기 묶음) · PR19/WEB7/WEB12(사용량) · WEB15 · WEB8.
6. **보고서·인쇄용 HTML은 서버 생성을 유지한다(추천).** 단계 보고서·최종 보고서·eli5·범위 인쇄(U6)는 “출력 시점의 버전·manifest 고정·같은 manifest 재출력·출력물 보존”(stage-1-ui 결정 10)이 핵심이라, 서버(TS 템플릿)가 고정본에서 자기완결 HTML을 만들고 React 앱은 **범위 고르기·미리보기 틀(새 탭/iframe)** 만 맡는다. 같은 TS 렌더 코드를 쓰므로 언어는 하나다. U6에서 확정한다.
7. **브라우저 쪽 글자 뽑기 라이브러리(MAT1)의 자리**: `packages/extract`(가칭) 같은 **공용 TS 모듈**로 두고, 브라우저에서는 **자료 화면·마법사 4칸에서만 동적으로 불러오는 Web Worker 묶음**으로 돌린다(첫 화면 묶음에 넣지 않음, 메인 스레드·IME 방해 없음). 같은 모듈을 로컬 CLI(Node)·도우미가 쓴다. WEB0에서 hwpx 최소 변환기(순수 TS + fflate)가 Node·workerd·브라우저 번들에서 같은 결과를 낸 것과 같은 방식이다. 라이브러리 선정(pdf.js·SheetJS·mammoth·hwpx XML 등)·성숙도 확인은 MAT1.
8. **시험**: 0016의 잠정 추천(Node 26 + `node:test` + `tsc`)은 코어용이다. 화면은 **Playwright 스모크(Windows CI 필수, stage-1-ui 6절 유지)** 를 그대로 쓰고, 컴포넌트 시험이 필요하면 U1에서 러너(`node:test`+가벼운 DOM 또는 Vitest)를 정한다 — 러너를 하나 더 들이면 0016 재검토 조건과 함께 본다.
9. **글꼴 Pretendard**: npm `pretendard` 1.3.9(고정)를 번들, 동적 subset woff2 92개(합계 약 3.0 MB, 한 화면은 쓰는 묶음만 받음), `font-display: swap`, 대체 `system-ui · Apple SD Gothic Neo · Malgun Gothic`. **라이선스 SIL Open Font License 1.1** — 배포물에 원문(`fonts/pretendard-OFL-1.1-LICENSE.txt`)을 함께 넣는다. 인쇄·보고서 HTML(서버 생성)에도 같은 글꼴을 쓸지는 U6·6단계 hwpx와 함께 본다.
10. **의존성·공급망**: 버전을 모두 고정하고 lockfile을 둔다. shadcn CLI는 생성 때만 쓰고 의존성에 남기지 않는다(부품 코드는 저장소에 있음). 업데이트는 PR 하나에 목적 하나로.
11. **이슈 수**: 새 이슈를 만들지 않는다. U1이 앱 틀·빌드·정적 서빙을, PR26/U1이 배포물에 `dist/` 넣기를, WEB1이 정적 자산 배포를 맡는다(각 이슈 완료 조건에 추가).
12. **앱 셸·블록·테마(2차, 2026-11-05 사용자 요청 “대시보드 테마를 이용하면?”)** — 화면 말·상태 표시·권한·흐름은 그대로, 틀과 겉모습만 바꿨다(설계 12.9).
    - **앱 셸**: shadcn/ui 공식 블록 **sidebar-07**(아이콘만 남기고 접힘)을 shadcn CLI로 설치해 PES 내용(프로젝트 전환 · 전역 메뉴 · 작업 공간 묶음 · 단계·라운드 나무)으로 채웠다. 머리줄은 **shadcn-admin**(satnaing) 레이아웃의 **구조만 참고**해 새로 썼다(코드 가져오지 않음). 900px 미만은 Sheet.
    - **화면 패턴**: 프로젝트 목록·사용량 = shadcn **dashboard-01** 블록의 배치(요약 카드 줄 + 표, 사용량 추이 차트 하나 — 블록 파일은 설치하지 않음). 작업 공간 = 문서 중심(가운데 결과 글, 오른쪽 질문 폼, 위 지금 할 일).
    - **테마**: tweakcn 공개 테마 레지스트리의 **Modern Minimal(기본) · Vercel · Graphite · Clean Slate**를 shadcn CLI `view`로 받아(이름 4개 모두 실제로 있음 — 대체 없음) `src/themes/<이름>.css`의 테마별 클래스로 옮겼다. 밝게/어둡게 각각, 머리줄 “테마” 메뉴에서 바꾸고 고른 값은 브라우저 `localStorage`에만. **글꼴은 테마와 상관없이 Pretendard**(테마의 font 변수는 받지 않음). 상태 색·방식 색은 테마마다 바꾸지 않는다. 대비 AA를 넘기려고 바꾼 값(primary·보조 글자·destructive·입력 테두리)은 각 테마 파일 “PES 보정”에 받은 값과 함께 적었다.
    - **라이선스**: tweakcn **Apache License 2.0**(jnsahaj/tweakcn — NOTICE 파일 없음) · shadcn/ui(블록·부품) **MIT** · shadcn-admin **MIT**(참고만). 배포물에 원문을 함께 넣는다(`licenses/tweakcn-Apache-2.0-LICENSE.txt` · `licenses/shadcn-ui-MIT-LICENSE.txt` — 빌드가 CSS 주석을 지우므로 고지는 원문 파일이 맡는다). Pretendard OFL 1.1은 9번 그대로.
    - **의존성 추가**: `recharts` 3.8.0(고정, shadcn chart가 씀) — 사용량 화면에서만, 그중에서도 따로 불러오는 묶음(약 372 kB · gzip 108 kB). 사이드바·드롭다운·아바타는 이미 있는 `radix-ui`·`lucide-react`로 충분해 새 패키지가 없다. 첫 묶음 JS는 490 → 568 kB(gzip 151 → 175 kB), CSS 142 → 190 kB(gzip 31 → 38 kB). shadcn CLI는 10번처럼 생성·받기 때만 썼다(PES가 고친 부품은 덮어쓰지 않음).
    - **U1에서 정할 것**: 테마 고르기를 제품 기능으로 둘지(사용자 설정 서버 저장 / 브라우저만 / 기본 하나만), 사이드바 접힘 상태를 쿠키(shadcn 기본)로 둘지 — 논의 기록 N13·N14.

## 재검토 조건

- 정적 셸 + 첫 읽기 묶음이 첫 표시·딥링크·인쇄 요구(stage-1-ui 결정 10·12, F04)를 못 지킬 때.
- 배포물에 `dist/`를 넣는 방식이 플러그인 설치(Windows·macOS)를 깨거나 저장소를 지나치게 키울 때.
- Workers Assets(또는 고른 플랫폼)의 정적 자산이 무료 한도에 들어가 비용이 생길 때.
- React·Vite·shadcn/radix의 주요 판이 바뀌어 접근성·IME 동작이 달라질 때, 또는 Pretendard 라이선스·배포 조건이 바뀔 때.
- 서버 렌더가 꼭 필요한 화면(검색 노출 등)이 생길 때 — PES 화면은 로그인 뒤라 지금은 해당 없음.
- 받은 테마(tweakcn)의 라이선스·레지스트리 주소가 바뀌거나, 테마를 새 판으로 바꿀 때 “PES 보정”으로도 대비 AA(글자 4.5:1 · 테두리 3:1)를 맞출 수 없을 때(영향 12).

## 상태

채택(사용자 결정 2026-11-05)
