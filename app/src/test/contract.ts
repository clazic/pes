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
 *   - [최종 리뷰 1/2 반영 — 설계 12.9 "왼쪽 탐색 열은 사이드바로 옮겨"] 작업 공간 안에 "단계와 라운드" 열은 없다. 단계·라운드는 사이드바 `연구 흐름` 나무(단계 아래 라운드) 하나뿐.
 *     영역 = 본문(`main`, data-area="body") · 질문(`aside` 이름 "질문", data-area="ask") 둘. data-area="nav" 는 없다.
 *     ≥1280px: 사이드바 | 본문 | 질문(380, ≥1440 은 404) 3열. <1280px: 한 열 + 보기 전환(본문/질문) — 2영역(탐색 열 + 본문) 없음.
 *     사이드바를 접으면 본문이 넓어진다. 사이드바 펼침 1280 에서도 본문(main)이 결과 글 읽기 폭 46rem 아래로 좁아지지 않는다(MAIN_MIN_REM).
 *   - view 쿼리: `body`(기본) | `ask`. 모르는 값은 무시(기본). `nav` 는 더 이상 값이 아니다 — 모르는 값처럼 무시되어 본문으로 그린다(해석: 사이드바가 항상 단계 입구라
 *     "사이드바 초점" 값을 따로 두지 않는다). 좁은 화면 전환은 radiogroup "보기"(라디오 "본문" · "질문" 둘).
 *   - focus 쿼리: 초점을 둘 요소 id(예 `q-22`). 화면을 불러오거나 되돌아올 때 그 요소가 document.activeElement. 질문 영역 안에서 초점을 옮기면 URL 의 focus 가 따라 바뀐다(replace).
 *   - peek 쿼리: 미리볼 질문 id(예 `q-21`). 열리면 `role=dialog`(비모달) 이름 "미리보기". Esc·닫기로 닫으면 peek 가 지워지고 초점이 연 단추로.
 *   - print 쿼리: `1` 이면 region "인쇄 미리보기"(자동으로 window.print 를 부르지 않는다).
 *   - 화면 제목 `[data-screen-title]`(h1, tabindex=-1): "조사 R2" · "기획 R1" · "조사 단계 시작". 화면이 바뀌면(처음 불러올 때 제외) 초점이 여기로.
 *   - 단계·라운드 탐색 = 사이드바 nav(이름 /연구 흐름/ — 문서에 정확히 하나) 안의 나무: 단계 링크(이름에 기획/조사/분석, 상태는 상태 사전 이름) 아래 라운드 링크(이름에 "R1"·"R2"·"단계 시작").
 *     라운드는 현재 단계와 지금 보는 단계 아래에 펼쳐진다. 현재 보는 라운드 링크 aria-current="page"(사이드바 안에 정확히 하나).
 *     과거 단계는 "승인됨", 아직 안 열린 단계는 "시작 전"(옛 "아직"은 상태 사전 이름으로 바뀜), 현재 진행 라운드는 "현재 진행". 단계 시작에 가짜 "R0" 을 쓰지 않는다.
 *     지난 라운드를 볼 때 본문에 "지난 라운드" · "보는 중", 사이드바 나무에 "현재 진행"이 함께 있다.
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

/** 폭 기준(px) — ≥1280 사이드바|본문|질문 3열 · <1280 한 열 + 보기 전환(본문/질문) · <900 은 사이드바도 Sheet */
export const WIDTHS = { wide1366: 1366, wide1440: 1440, mid: 1100, zoom200of1366: 683, zoom200of1440: 720, phone: 390 } as const;

export const NAMES = {
  skip: "본문으로 건너뛰기",
  ask: "질문",
  viewGroup: "보기",
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
 *     폭 ≥1280 에서 펼침, 그 아래는 아이콘 줄, <900 에서는 접힌 채 단추로 여는 대화 상자(Sheet). Ctrl/Cmd+B 로 접고 펴기(한글 조합 중 무시).
 *     접힘 상태는 이 브라우저의 localStorage 에만(키 이름에 'sidebar' 가 들어감 — SIDEBAR_STORAGE_KEY). 서버가 읽지 않으므로 쿠키는 하나도 만들지 않는다(COOKIE-FREE).
 *     테마(사용자 결정 2026-11-12): 4종 유지 · localStorage `pes-theme` 에만 저장 · 기본 Modern Minimal · 쿠키·서버 저장 없음.
 *   - 랜드마크: banner 1 · main 1. `complementary`(질문 영역)는 main 안에 있지 않다(최상위 랜드마크).
 *   - 작업 공간 3/2/1영역은 이 틀의 본문 안. 가운데 영역 위 "지금 할 일" 줄에 차례 말("나의 할 일 1건")이 상태 사전 이름 그대로 나온다.
 *   - 보기 전환(<1280)은 폭과 상관없이 본문 · 질문 둘이다.
 *   - 쓰기(오류 확인)는 멱등 키 하나를 받는다: `client.acknowledgeAlert(slug, edition, alertId, idempotencyKey)`.
 *   - 오류 확인(최종 리뷰 필수 2): 보내는 동안 단추는 `disabled` 가 아니라 `aria-disabled="true"` + 핸들러 무시(초점 유지). 성공 뒤 초점은 BODY 가 아니라 알림 영역 안의
 *     tabindex="-1" 요소(결과 줄 "확인함 · 접수 NNNN" 또는 알림 제목)로 가고, 알림 영역의 role=status 가 "오류를 확인했습니다"를 읽힌다.
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

/** 작업 공간 영역(data-area) — 단계·라운드 열이 사라져 둘뿐이다(설계 12.9) */
export const AREAS = ["body", "ask"] as const;

/** 지워진 옛 이름 — 이 이름의 navigation / data-area="nav" / "단계·라운드" 라디오는 더 이상 없어야 한다 */
export const REMOVED = { navName: "단계와 라운드", navArea: "nav", viewRadio: "단계·라운드" } as const;

/** 사이드바 접힘 저장소 — localStorage 항목 중 키 이름에 이 패턴이 든 것(쿠키 아님) */
export const SIDEBAR_STORAGE_KEY = /sidebar/i;

/** 결과 글 읽기 폭(rem) — 설계 12.9. 사이드바 펼침 ≥1280 에서 본문(main) 폭의 하한: 1280 − 사이드바(≤240, 12.9 "사이드바 240px") − 질문 380 = 660 ≥ 46rem(14px 루트에서 644px) */
export const MAIN_MIN_REM = 46;

/** 질문 영역 폭(px): 1280~1439 는 380, 1440 이상은 404 (설계 12.9 2차) */
export const ASK_WIDTH = { at1280: 380, at1440: 404 } as const;
