/**
 * SEL-81 U1a 시험 계약 — 시험(Vitest·Playwright)이 구현에게 요구하는 "바깥에서 보이는 이름" 한 곳.
 * 구현을 추측해서 맞춘 것이 아니라 이슈 완료 조건·설계서(dashboard-v2.md 4.5·4.7·4.16·12.3)에서 뽑은 해석이다.
 * 이름을 바꿔야 하면 구현이 아니라 이 파일(과 보고서의 해석)을 고치고 leader 에게 알린다.
 *
 * 합성 자료(앱 안 가짜 클라이언트가 가져야 하는 최소 fixture — 실제 자료·경로·키 없음):
 *   프로젝트 slug `sample-study`, 판 1. 단계 `plan`(기획·승인됨) · `research`(조사·현재) · `analyze`(분석·아직).
 *   기획: 단계 시작(round_id=NULL, 주소 `r/start`) · R1.  조사: 단계 시작 · R1 · R2(현재 진행).
 *   조사 R2 질문 둘: `q-21`(필수) · `q-22`. 조사 R2 에 확인할 수 있는 오류 알림 하나.
 *
 * 화면 이름(접근 가능한 이름은 한국어):
 *   - 건너뛰기 링크 "본문으로 건너뛰기" · 머리줄 `<header>` 하나 · 본문 `<main>` 하나.
 *   - 3영역 = 단계·라운드(`nav` 이름 "단계와 라운드", data-area="nav") · 본문(`main`, data-area="body") · 질문(`aside` 이름 "질문", data-area="ask").
 *     ≥1280px 3영역 · 900~1279px 2영역(단계·라운드 + view 가 ask 면 질문, 아니면 본문) · <900px 1영역(view 가 고른 하나).
 *   - view 쿼리: `nav` | `body`(기본) | `ask`. 모르는 값은 무시(기본). 좁은 화면 전환은 radiogroup "보기"(라디오 "단계·라운드" · "본문" · "질문").
 *   - focus 쿼리: 초점을 둘 요소 id(예 `q-22`). 화면을 불러오거나 되돌아올 때 그 요소가 document.activeElement. 질문 영역 안에서 초점을 옮기면 URL 의 focus 가 따라 바뀐다(replace).
 *   - peek 쿼리: 미리볼 질문 id(예 `q-21`). 열리면 `role=dialog`(비모달) 이름 "미리보기". Esc·닫기로 닫으면 peek 가 지워지고 초점이 연 단추로.
 *   - print 쿼리: `1` 이면 region "인쇄 미리보기"(자동으로 window.print 를 부르지 않는다).
 *   - 화면 제목 `[data-screen-title]`(h1, tabindex=-1): "조사 R2" · "기획 R1" · "조사 단계 시작". 화면이 바뀌면(처음 불러올 때 제외) 초점이 여기로.
 *   - 단계·라운드 탐색: 단계 링크(이름에 기획/조사/분석), 라운드 링크(이름에 "R1"·"R2"·"단계 시작"). 현재 보는 라운드 링크 aria-current="page".
 *     과거 단계는 글자 "승인", 현재 진행 라운드는 "현재 진행", 아직 안 열린 단계는 "아직". 단계 시작에 가짜 "R0" 을 쓰지 않는다.
 *     지난 라운드를 볼 때 본문에 "지난 라운드" · "보는 중", 탐색에 "현재 진행"이 함께 있다.
 *   - 편집 도구: 단추 "질문 고치기" · "첨언 쓰기". 휴대폰에서는 aria-disabled="true" + aria-describedby 가 가리키는 이유 글(“데스크톱” 포함), 누르면 동작하지 않는다.
 *   - 휴대폰에서도 되는 것. 질문 영역(aside)에 답 칸(textbox 이름에 "답") · 의견 칸(이름에 "의견") · 단추 "질문 고치기".
 *     본문(main)에 단추 "인쇄 미리보기" · "프롬프트 복사" · "오류 확인" · "첨언 쓰기". 미리보기 대화 상자를 여는 단추는 질문 영역에 질문마다 하나, 이름 "질문 21 미리보기"(정규식 NAMES.peekOpener).
 *   - 휴대폰 판단 = 폭 < 900px 이고 굵은 포인터(pointer: coarse). 폭만으로 숨기지 않는다(200% 확대 F08) — 683px·거친 포인터 아님이면 편집 도구가 켜져 있다.
 *   - 모르는 주소·없는 라운드(`r/0`)는 "찾을 수 없음" 화면(role=alert 아님, 제목 포함)이고 단계 시작으로 오해하지 않는다.
 *   - 앱은 `@/app/routes` 에서 `routes: RouteObject[]` 를 내보내고, routes 만으로 완결이다(QueryClientProvider 등 공급자는 루트 레이아웃이 만든다).
 *   - 가짜 클라이언트 밖 네트워크 요청 0: fetch·XMLHttpRequest·WebSocket·sendBeacon·EventSource 호출 0, 다른 출처 요청 0.
 */
export const SLUG = "sample-study";
export const EDITION = "1";
export const base = `/p/${SLUG}/e/${EDITION}`;
export const url = (stage: string, round: string | number, query = ""): string =>
  `${base}/s/${stage}/r/${round}${query ? (query.startsWith("?") ? query : `?${query}`) : ""}`;

export const CURRENT = url("research", 2);
export const PAST = url("plan", 1);
export const STAGE_START = url("research", "start");

/** 폭 기준(px) — 3영역 ≥1280 · 2영역 900~1279 · 1영역 <900 */
export const WIDTHS = { wide1366: 1366, wide1440: 1440, mid: 1100, zoom200of1366: 683, zoom200of1440: 720, phone: 390 } as const;

export const NAMES = {
  skip: "본문으로 건너뛰기",
  nav: "단계와 라운드",
  ask: "질문",
  viewGroup: "보기",
  viewNav: "단계·라운드",
  viewBody: "본문",
  viewAsk: "질문",
  peek: "미리보기",
  peekOpener: /^질문 \d+ 미리보기$/,
  print: "인쇄 미리보기",
  edit: "질문 고치기",
  annotate: "첨언 쓰기",
  copy: "프롬프트 복사",
  ackError: "오류 확인",
} as const;

/**
 * 1차 리뷰(R1) 반영 — 앱 셸 계약(승인 시안: shadcn sidebar-07 앱 셸 + 머리줄 + 연구 공간 틀, 설계 12.9·결정 0017 영향 12).
 *   - 머리줄 `header`(banner) 하나: 사이드바 접기 단추(이름에 "사이드바", aria-expanded) · 빵부스러기 `nav` "현재 위치"(현재 곳 aria-current="page", 프로젝트 이름 포함)
 *     · 명령 찾기 · 알림(둘 다 U1c·U1d 몫이라 U1a 에서는 자리만: aria-disabled="true" + aria-describedby 이유 글) · 테마 단추("테마") · 사용자 단추(이름에 "사용자").
 *   - 사이드바: `nav` 이름에 "연구 흐름"(단계 링크 + 상태 글자 — 상태 사전 이름 그대로: "승인됨" · "현재 · 나의 할 일" · "시작 전") · 링크 "모든 프로젝트".
 *     폭 ≥1280 에서 펼침, 그 아래는 아이콘 줄, <900 에서는 접힌 채 단추로 여는 대화 상자(Sheet). Ctrl/Cmd+B 로 접고 펴기(한글 조합 중 무시), 쿠키 `sidebar_state`.
 *   - 랜드마크: banner 1 · main 1. `complementary`(질문 영역)는 main 안에 있지 않다(최상위 랜드마크).
 *   - 작업 공간 3/2/1영역은 이 틀의 본문 안. 가운데 영역 위 "지금 할 일" 줄에 차례 말("나의 할 일 1건")이 상태 사전 이름 그대로 나온다.
 *   - 2영역(900~1279)의 보기 전환에는 "단계·라운드"가 없다(두 영역이 이미 함께 보임) — 본문 · 질문 둘.
 *   - 쓰기(오류 확인)는 멱등 키 하나를 받는다: `client.acknowledgeAlert(slug, edition, alertId, idempotencyKey)`.
 */
export const SHELL = {
  banner: "PES 전역 머리줄",
  sidebarToggle: /사이드바/,
  crumbs: "현재 위치",
  sidebarNav: /연구 흐름/,
  backToAll: /모든 프로젝트/,
  command: /명령 찾기/,
  notifications: /^알림/,
  theme: "테마",
  user: /사용자/,
  turnYou: "나의 할 일 1건",
  stageStates: { approved: "승인됨", currentYou: "현재 · 나의 할 일", pending: "시작 전" },
} as const;

export const AREAS = ["nav", "body", "ask"] as const;
