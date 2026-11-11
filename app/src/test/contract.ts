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

/**
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * SEL-83 U1c 시험 계약 — 입력 초안 보존 · 커서 갱신 · 명령 메뉴 (설계 dashboard-v2.md 3.9·4.15·12.5·12.6, 결정 0017, stage-3.md U1)
 * 이슈 문구(draft.js·cursor.js·command-menu.js 는 React 결정 전 표현 — 같은 역할을 app/src 훅·화면이 맡는다)에서 뽑은 해석이다.
 * 이름을 바꿔야 하면 구현이 아니라 이 머리말과 시험을 고치고 leader 에게 알린다. 구현 파일 위치는 제안일 뿐 — 시험은 화면(role·이름)과 아래 "모듈 계약"만 본다.
 *
 * [시험 심(seam) — 구현이 만들어야 하는 것]
 *   - `@/app/routes` 가 `routes` 외에 `createRoutes(options?: { client?: PesClient }): RouteObject[]` 도 내보낸다.
 *     `routes` === `createRoutes()` (기본은 가짜 클라이언트). client 를 주면 RootLayout 이 그것을 ClientContext 로 공급한다(가짜 클라이언트를 안 만든다).
 *   - 시험은 시간을 vitest 가짜 시계(setTimeout·setInterval·Date)로 움직인다 → 구현은 전역 setTimeout/clearTimeout/Date.now 만 쓴다(Web Worker·requestIdleCallback·performance 전용 타이머 금지).
 *   - 쓰기 열쇠는 이전과 같다: 읽기 호출은 PesClient 메서드만 지난다. 시험이 아는 읽기 메서드 = listProjects · getWorkspace · getRound · getChanges. 그 밖의 메서드 호출은 "다른 쓰기/전송"이다.
 *
 * [PesClient 확장 — 변경분 읽기 (types.ts 에 추가, U1b 가 같은 모양을 HTTP 로 채운다)]
 *   getChanges(slug: string, edition: number, cursor: string | null): Promise<ChangesRead>
 *     ChangesRead = { cursor: string; txs: { tx_id: string; touched: string[] }[] }
 *     - cursor: 서버가 주는 불투명 값. 화면은 해석하지 않고 다음 호출에 그대로 되돌려 준다(알림 번호를 커서로 쓰지 않는다 — 설계 12.5-2, R04).
 *       null = 처음(기준만 받는다 — txs 는 비어 있어도 된다).
 *       [R1 권장 3 — 약속] **null = 기준만 받음**: 서버는 지금까지의 변경을 되풀이하지 않고 "여기부터"라는 기준 커서만 돌려준다(실제 API 의 "cursor 없음 = seq 0 부터 전부"와 다르다).
 *       실제 API 클라이언트(U1b)가 이 약속을 맞춘다(null → 현재 끝 커서만 / has_more 를 따라 끝까지 훑지 않음). 이 약속이 없으면 첫 읽기와 기준 사이 변경을 놓친다.
 *     - txs: 공개 tx 묶음 단위(API 결정 13). 한 tx 가 읽기 키 여럿을 건드릴 수 있다. 숨은 사건이면 txs 가 비고 cursor 만 앞으로 간다.
 *     - touched 의 읽기 키 = 문자열 `"workspace"` | `"projects"` | `"round:<stage>/<round>"`(round = 숫자 또는 start. 예 "round:research/2").
 *       화면은 touched 에 든 읽기만 무효화한다(queryClient.invalidateQueries) — 그 밖의 읽기는 다시 받지 않는다. 같은 응답 안에서 같은 키는 한 번만.
 *     - 거절: PesApiError 의 body.error.code 가 "cursor_expired"(410, 만료) 또는 "cursor_invalid"(400). → 재동기화: 화면에 보이는 읽기(workspace + 지금 라운드)만 다시 받고
 *       다음 호출은 cursor=null 로 다시 시작한다. 전체 새로고침(location.reload)·주소 변경·질문 영역 다시 만들기(초안 사라짐) 없음.
 *     - 시간 초과: 던져진 Error 의 name 이 "TimeoutError". 오류와 같이 다루되 화면 자료를 지우지 않는다.
 *
 * [갱신 박자 — 가짜 시계로 본다]
 *   - [R1 권장 3] 첫 getChanges 는 화면이 붙자마자(마운트 즉시, 3초 기다리지 않음) cursor=null 로 부른다 — 첫 읽기와 기준 커서 사이에 틈을 두지 않는다.
 *     410/400 재동기화(읽기를 다시 받음) 뒤에도 3초를 기다리지 않고 곧바로(cursor=null) 기준을 다시 잡는다.
 *   - 활성(탭 보임 document.visibilityState === "visible"): 약 3초마다 getChanges 한 번(2~4초 사이 간격 허용). 응답이 오기 전에 다음 호출을 겹쳐 보내지 않는다(동시 1개).
 *   - 비활성(탭 숨김): 10초 동안 호출 0. 다시 보이면(visibilitychange) 곧바로(1초 안에) 한 번 받고 활성 박자로 돌아간다.
 *   - 오류·시간 초과 뒤: 다음 호출은 3.5초 안에 오지 않고(늦춤), 60초 안에는 다시 시도한다. 성공하면 3초 박자로 돌아간다. 오류로 화면 자료를 지우거나 질문 영역을 다시 만들지 않는다.
 *   - 갱신은 queryClient 읽기 무효화로만 한다(폴링으로 읽기를 직접 다시 부르지 않음 — 결정 0017).
 *
 * [초안 — `@/lib/draft` 모듈 계약]
 *   - `draftKey(parts: { project: string; user: string; edition: number; form: number; question: string; version: number; field: "answer" | "opinion" }): string`
 *     = useDraft 에 넘기는 논리 키. 여섯 칸(프로젝트·사용자·판·폼 버전·질문·질문 버전)과 field 중 하나라도 다르면 키가 다르고, 각 값이 키 글자에 그대로 들어 있다.
 *     실제 sessionStorage 키는 지금처럼 `pes-draft:` + 논리 키(끝이 논리 키로 끝난다).
 *   - 화면의 답/의견 칸은 사용자 칸에 `U1C.draftUser`("local" — 로그인 없는 이 컴퓨터 화면) 를 쓴다.
 *   - `clearDraft(key: string): void` — 확정(영수증) 성공 뒤 U2 의 보내기가 부를 지우개. sessionStorage 항목과 메모리 대체 값을 모두 지운다(다른 키는 그대로).
 *     U1c 에는 보내는 쓰기가 없어 화면 시험은 못 한다 — 모듈로만 본다.
 *   - 저장소를 못 쓰면(sessionStorage 접근 자체가 예외) 모듈 안 메모리에 둔다: 같은 탭(같은 JS 모듈) 안에서 훅이 사라졌다 다시 생겨도(화면 이동) 글이 남는다. 훅 하나가 아니라 모듈 수준이다.
 *   - 질문이 새 버전(version 2)이 되어 라운드를 다시 받으면: 옛 버전 초안을 새 칸으로 몰래 옮기지 않는다. 그 질문 항목 안에 `[data-draft-review="<질문 id>"]` 영역이 생기고
 *     (1) "새 버전" 안내 글 (2) 옛 초안 글(읽기 전용 — textbox 아님)을 보이며 (3) 단추 "이전 초안 가져오기"로 사람이 눈으로 본 뒤 새 칸에 채울 수 있다. 새 칸은 비어 있다. 옛 키 저장값은 지우지 않는다.
 *     그 영역에는 role=status 가 있어 안내가 읽힌다. 가져오기를 누르면 새 칸에 옛 글이 들어가고(새 키에 저장) 영역은 닫힌다.
 *
 * [입력 중 갱신에 대한 보존 — 같은 DOM 노드]
 *   - changes 로 라운드가 다시 읽혀 같은 질문(같은 id·같은 버전)이 다시 그려져도 답/의견 textarea 는 다시 만들어지지 않는다(같은 DOM 노드): 초점·선택 범위·값이 그대로.
 *   - 한글 조합(compositionstart ~ compositionend) 중 값은 갱신으로 덮이지 않는다. 조합이 끝나면 확정된 값이 초안으로 저장된다.
 *
 * [명령 메뉴]
 *   - [R1 필수 1] 검색 칸에서 한글 조합 중(KeyboardEvent.isComposing · keyCode 229 · compositionstart~end) Esc 는 대화 상자를 닫지 않고 검색어도 그대로 둔다(조합 취소용 Esc). 조합 밖 Esc 는 닫고 열기 전 요소로 초점을 돌린다.
 *   - [R1 권장 6] Ctrl/Cmd+K 는 한글 자판 상태의 `key: "ㅏ"` 라도 `code: "KeyK"` 이면 연다(조합 중은 여전히 무시).
 *   - [R1 권장 7] 메뉴가 열린 동안 화면이 동작 목록을 바꾸면(라운드 도착 등) 열린 목록이 새 목록으로 갱신되고, 고른 동작은 새 목록의 `run` 을 실행한다(옛 클로저 실행 금지).
 *   - [R1 권장 5] 열 때마다 대화 상자 세션(검색어·강조·AI 모드 초기화)은 한 번만 새로 시작한다(StrictMode 두 번 그림에도 한 번).
 *   - 머리줄 단추(이름 /명령 찾기/)는 이제 aria-disabled 가 아니다. 누르거나 Ctrl+K / Cmd+K 로 연다(한글 조합 중 — KeyboardEvent.isComposing 또는 keyCode 229 — 은 무시). aria-haspopup="dialog".
 *   - 열리면 `role=dialog` 이름 "명령 메뉴"(모달). 안에 검색 칸(role=combobox, 이름에 "명령" 또는 "동작")에 초점, 동작 목록은 role=listbox 안의 role=option.
 *     목록은 부분 글자(대소문자 무시) 일치로 걸러진다. 첫 항목이 처음부터 강조되어 Enter 로 실행된다. ↑↓ 로 강조를 옮긴다(aria-activedescendant).
 *   - 동작 목록은 하나다(`CMD.labels`). 같은 라벨이 명령 메뉴 option · 질문 맥락 메뉴 menuitem 에 쓰이며, 맥락 메뉴의 라벨은 모두 명령 메뉴 라벨의 부분 집합이다. 단축키가 있는 동작은 aria-keyshortcuts 로 알린다.
 *   - 맥락 메뉴: 질문 항목 안에서 contextmenu 이벤트 또는 키보드 ContextMenu 키(Shift+F10 도 같음)로 `role=menu` 이름 "질문 동작" 이 열린다. Esc 로 닫으면 열기 전 초점으로 돌아간다.
 *   - 동작을 고르면 메뉴가 닫히고 그 동작이 실행된다. 닫힌 뒤 초점: 화면 이동이 있으면 U1a 의 "화면 바뀜" 규칙을 따르고, 없으면 메뉴를 열기 전 요소(단추로 열었으면 그 단추)로 돌아간다.
 *   - 검색 결과가 없으면 `role=status` 에 "찾는 동작이 없습니다 …검색어를 AI에게 보내지 않습니다" 형태의 안내. Enter 를 눌러도 아무 일도 없다(AI 모드로 바꾸지 않고, 어떤 클라이언트 메서드도 부르지 않는다).
 *   - AI 모드는 명시적으로만: 대화 상자 안의 단추 "AI 모드"(aria-pressed). 누르면 true, 검색 칸 이름이 "AI에게 묻기"로, 동작 목록 대신 보낼 글 입력 + 단추 "AI에게 보내기". U1c 는 AI 연결이 없다 →
 *     "AI에게 보내기"는 ActionButton(aria-disabled + 이유 글)이고 눌러도 아무것도 보내지 않는다. AI 모드를 끄면 다시 동작 목록.
 *   - Tab 보조: 검색 칸에서 조합 중이 아닐 때 Tab 은 강조된 option 의 라벨을 검색 칸에 채운다(preventDefault). 조합 중(isComposing/keyCode 229)이면 아무것도 하지 않고 preventDefault 도 하지 않는다.
 *     (Tab 이 덫이 되지 않게: 칸이 이미 강조 항목의 라벨과 같거나 강조 항목이 없으면 평소 Tab 이동.)
 *
 * [미리보기 · 순서 넘김 틀]
 *   - 미리보기 대화 상자(role=dialog 이름 "미리보기", 비모달)에 단추 "이전 질문" · "다음 질문"(질문 영역의 질문 순서). 첫/마지막에서 해당 단추는 aria-disabled="true"(숨기지 않음).
 *     누르면 peek 쿼리만 옆 질문으로 바뀐다(replace). 다른 쿼리(view·focus)·경로(지난 라운드이면 그 지난 라운드)는 그대로 — 같은 화면 상태 유지. 초점은 대화 상자 안에 남는다.
 *   - 명령 메뉴에 질문마다 option "질문 N 미리보기"(N = 질문 번호)가 있고 열린 질문 · 지난 라운드 모두에서 같은 대화 상자를 연다.
 */
export const U1C = {
  draftUser: "local",
  /** 가짜 시계 박자(ms) */
  active: { every: 3000, minGap: 2000, maxGap: 4000 },
  inactiveQuietMs: 10_000,
  backoff: { notBeforeMs: 3500, retryWithinMs: 60_000 },
} as const;

export const CMD = {
  dialog: "명령 메뉴",
  combobox: /명령|동작/,
  aiToggle: "AI 모드",
  aiSend: "AI에게 보내기",
  noMatch: /찾는 동작이 없습니다/,
  contextMenu: "질문 동작",
  prevQ: "이전 질문",
  nextQ: "다음 질문",
  reviewButton: "이전 초안 가져오기",
  /** 명령 메뉴에 반드시 있는 동작 라벨(질문 미리보기는 `질문 N 미리보기`) */
  labels: { goAsk: "질문으로 가기", goBody: "본문으로 가기", print: "인쇄 미리보기 열기" },
  peek: (n: number) => `질문 ${n} 미리보기`,
} as const;
