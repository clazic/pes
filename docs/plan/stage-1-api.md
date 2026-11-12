# 1단계 ② API 형식 설계서

- 작성: 2026-11-04, Claude 종합. Linear: SEL-22
- 입력: [stage-1-api-codex.md](discussion/stage-1-api-codex.md), [stage-1-api-opencode.md](discussion/stage-1-api-opencode.md), Claude 추천안 [stage-1-api-claude-recs.md](discussion/stage-1-api-claude-recs.md), Codex 검수 [stage-1-api-codex-review.md](discussion/stage-1-api-codex-review.md)(A·B·C 32항목: 동의 18·수정 14·반대 0), Codex 최종 대조 [stage-1-api-final-check.md](discussion/stage-1-api-final-check.md), 합의 [stage-1-db.md](stage-1-db.md)
- 상태: **확정 — 사용자 승인 2026-11-05. 2026-11-05 개정** — 사용자 정의 정정(방식 A 내장 실행기·TS·WEB15 등) 반영. **합의안(Claude·Codex)** — 최종 대조 지적 13건 반영

## 1. 목표

웹 PES와 에이전트가 주고받는 **하나의 약속**을 정한다. HTTP/JSON이 원본이고 MCP·CLI·WebMCP·웹 화면은 같은 업무 명령을 부르는 얇은 층이다. 방식 A·B가 같은 API를 쓴다.

## 2. 합의된 결정

| # | 주제 | 결정 |
|---|---|---|
| 1 | 원본 | HTTP/JSON. **닫힌 업무 명령 목록**(`result.submit`, `stage.approve` …), 표 CRUD·임의 ops 없음. 통로마다 별도 검증·직접 DB 쓰기 없음(로컬 CLI가 반드시 자기 HTTP를 거칠 필요는 없지만 같은 명령 서비스를 씀) |
| 2 | 두 API 분리 | **PES API**(에이전트·내장 실행기↔PES)와 **OpenCode Go API**(PES 내장 실행기→Go). B는 OpenCode 세션 ID·DTO를 모름 |
| 3 | 버전 | 경로 `/api/v1/projects/{id}/…`, 봉투 `format_version:"1.0"`(DB·workflow 버전과 별개). 요청의 모르는 필드는 거부, 응답의 선택 필드 추가는 허용, 모르는 정책·상태를 허용으로 해석하지 않음 |
| 4 | 쓰기 안전 | `Idempotency-Key` 필수. **전제(expected)는 명령별로 필수 항목을 정함**(사람 답·첨언엔 lease 불필요, 최초 claim엔 기존 lease 없음). 순서: 인증·권한·정책 → 완료 영수증 재생 → rev/lease 검사. 1행 변경을 요구하는 CAS·가드가 0행이면 실패, 전부 롤백(빈 조회·정상 재생은 실패 아님). **모든 DB 변경 명령(결과·질문·답·정책·중단 등)은 변경·`mutation_commits` 영수증·`events`를 한 트랜잭션에**, 파일 바이트 전송은 별도 단계. 같은 키·같은 요청은 원래 결과 재생, 다른 요청은 거부 |
| 5 | 숫자 | rev·control_rev·fence·event_seq는 **정규화한 10진 문자열**. 문자열 사전식 비교·JS Number 변환 금지 |
| 6 | 맥락 | **digest + 대상의 정확한 버전 manifest**, 본문은 선택 조회(같은 권한 검사). 정책·rev·커서의 일관된 읽기 경계 |
| 7 | 실행 | queued run 등록은 별도 가능. **claim·재개 = run 전이 + lease 획득 원자적.** 결과·질문을 저장한 뒤 **명시적 `wait` 명령**으로 `waiting_human` + lease 해제. 입력 조회(long-poll)는 순수 읽기(ack·heartbeat·전이 없음). 재개는 새 claim·새 fence |
| 8 | 제출 | **작은 원자 묶음**(결과·정확한 출처 버전·입력 영수증·사건). `complete`는 run 종료일 뿐 봉인·승인·다음 단계 전이가 아님 |
| 9 | 입력 영수증 | seen/ignored는 따로. **applied는 실제 결과 버전 또는 적용된 후속 조치 증거와 같은 트랜잭션**에서만. 인계 뒤 새 run에 같은 입력이 다시 보여도 **기존 적용 여부를 확인해 중복 반영하지 않음** |
| 10 | 중단·인계 | DB 채택 차단은 즉시 확정, 외부 중단은 pending/confirmed/failed/unknown으로 추적. 연결 끊김 ≠ 취소. **HTTP 인계(`handoffs`)는 같은 run을 `queued`로 반납할 뿐 새 run을 만들지 않는다**(2026-11-10 SEL-47 결정, 코어 `run.handoff`). 이어받기는 다음 claim이 하고, `parent_run_id`를 둔 새 run은 코어 claim 경로에만 남는다. 강제 인계는 사람만 |
| 11 | 사람만 | 승인·reopen·판 시작·Go 정책·토큰·멤버·삭제는 **소유자 사람 세션**. 본문의 human_id·via·WebMCP 주석은 증거가 아님 |
| 12 | 인증 | 에이전트 = **프로젝트 범위 Bearer 토큰(30일 + 회수)**, 사람 = 로컬 세션. actor·via는 서버가 확정. Origin 검사는 유지하되 인증을 대신하지 않음. 2단계에도 로컬 소유자 경로·CSRF 경계 필요. 로그인 UI는 5단계 |
| 13 | 변경분 | 커서 = `(database_instance_id, cursor_epoch, event_seq)` + **project_id·권한 범위·스캔 상한**을 묶은 서버 검증 불투명 값. epoch가 바뀌면 허용된 snapshot부터 다시 읽음(전체 본문 반환 아님). 공개 tx 단위로 적용, 숨긴 사건도 스캔 커서엔 반영. **커서 무효·재동기화 때도 화면의 미제출 답은 버리지 않음** |
| 14 | 파일 | 예약 → 업로드 → hash → complete(ready). **Go 쪽 파일 읽기는 매번 정책을 검사하는 PES 프록시 경로**(OFF 뒤 R2 다운로드 URL로 우회 불가). 파일 참조 버전·프로젝트도 검사 |
| 15 | Go OFF | 기본 켜짐·프로젝트별 끄기(사용자 결정) 그대로. OFF 커밋 뒤 새 송신 승인 금지. **새 A run 시작·prompt·요약·첨부·재시도는 `403 policy_blocked`.** **prepared → blocked, authorized는 미송신이 확인될 때만 blocked**, 이미 승인된 건은 송신 여부·취소 시도·unknown 기록, sent 이력 보존. 영향받는 run의 옛 lease 제출 차단(이미 끝난 run은 그대로). Go 목적지로 가는 context·changes·inputs·파일·재시도도 차단. **이미 나간 자료는 회수 보장 없음**, **합성 자료도 우회 없음**. 재허용 뒤에도 사람이 명시적으로 시작/재개 + 새 claim |
| 16 | WebMCP | 읽기 / 답 **초안은 브라우저 폼만** / 첨언·답글·사람→AI 질문·**할 일 제안 기록 추가**(run·다음 라운드·reopen 실행 아님) — 이 추가들은 **중간 위험 쓰기**. 제출·해결·claim·submit·complete·export·승인류 불가. 제한된 browser_actor 자격으로 접근하고 기록은 `actors.kind=browser_agent`, on_behalf_of_user_id는 위임 관계일 뿐 사람의 직접 작성·승인 증거가 아님 |
| 17 | 외부 내보내기 | PES가 원본, 사람이 고른 정확한 버전·목적지·payload만 한 방향. Go ON ≠ 외부 내보내기 동의. 6단계 |
| 18 | 이슈 | **현행 2단계 25개(PR1~19·20a·20b·20c·21·22·26)는 `roadmap.md` 2절을 따른다.** API는 기존 PR에 귀속. **2026-11-04 당시 2단계 22개로 승인한 기록은 그 시점의 이력으로 보존**한다. 3단계 WebMCP 1개, 6단계 내보내기 1~2개 |

## 3. 세부 값 (초기값 — capabilities로 공지, 시험으로 조정)

| 항목 | 값 |
|---|---|
| long-poll 최대 | 25초. 대기 중 DB 트랜잭션·잠금을 잡지 않음 |
| 토큰 만료 | 30일 + 회수, 매 요청 검사, heartbeat는 만료를 늘리지 않음 |
| 멱등 키 | **성공 키는 프로젝트 기록 보존 기간 동안 재사용 금지.** key·request_hash·원래 tx/결과 ID·최소 result_json은 계속 보존, 큰 응답 본문만 7일 뒤 정리(정리 뒤에도 재실행·빈 성공 반환 금지) |
| 요청 제한 | 본문 256KiB, 결과 20개/묶음, 목록 100개, 에이전트 토큰당 60 req/min. **heartbeat·중단·상태 확인은 별도 예산**. 과도한 poll엔 **최소 조회 간격**(capabilities로 공지, 분당 총량과 별개)과 429 + Retry-After. 사람 세션도 완화된 제한. 파일 업로드 한도는 별도 |
| 승인 역할 | 2단계 owner만, editor는 5단계 역할 설계에서 |
| 오류 봉투 | `{format_version, error:{code(영어 고정), message(한국어), retryable, target, details, next_action}, request_id}`. `details`엔 필요 시 expected/current rev, `target`은 문제 필드의 **JSON 경로**(details를 대체하지 않음). retryable = 같은 요청 자동 재시도 가능 여부. 충돌 → 맥락 새로 읽기, 429/503 → 같은 키로 대기 후 재시도, 403 `policy_blocked` → 자동 재시도 금지 |
| 서버 초안 | **2·3단계엔 서버 답 초안 API 없음** — 브라우저 저장소에만 보존. capabilities·MCP·WebMCP 목록에도 싣지 않음. Codex 의견 2.2절 표의 `PUT P/answer-drafts` 행은 **승계하지 않음** |
| 202 | "영속 접수"만 뜻함. operation_id·조회 경로·DB 채택 차단 상태·외부 실행 상태 반환, 재시작 뒤에도 조회 가능 |

## 4. 방식 A의 PES 접근

- A 내장 실행기의 **도구가 공통 PES API로 제출**. Go 키는 모델 프롬프트에 넣지 않고 서버(로컬 키체인·웹 Worker secret)의 호출 계층이 주입
- 등록된 run에만 claim 가능한 자격을 발급(또는 시작/claim용 서버 자격과 claim 후 실행 자격을 분리)해 최초 claim 순환 문제를 풀고, **허용 run을 서버가 검사**(본문의 run_id 선언을 믿지 않음)
- 실행기 책임: 루프 시작·중단, heartbeat·재시작 복구, 중단 요청 재처리, Go 호출 영수증 추적, 호출마다 정책 검사

## 5. 재개 조건 (④ 실행 구조와 공통)

- "유효한 제출" = **당시 질문/폼 버전의 제출 검증 통과**. `allow_comment_as_answer=1` 질문의 덧붙임만 있는 답도 유효, 추천값 선택을 강제하지 않음
- 독립 댓글·초안은 재개 신호가 아니지만 입력으로 보존
- 재개 때 최신 control_rev·정책·새 lease/fence 검사, Go OFF면 재개하지 않음. 연속 제출은 중복 실행 없이 예약
- 재개를 사람이 누를지 자동으로 할지는 **④ 실행 구조에서 확정**(추천안 B5: 초기엔 사람이 "계속", 자동 재개는 3단계 옵션)

## 6. 동작 표 (요약)

H = 사람(소유자), E = 프로젝트 토큰의 에이전트(내부 A·외부 B), W = 브라우저 에이전트. P = `/api/v1/projects/{id}`. 전체 표는 [Codex 의견 2.2절](discussion/stage-1-api-codex.md).

| 동작 | 경로(초안) | 누가 | WebMCP |
|---|---|---|---|
| capability·맥락·버전 읽기 | `GET /api/v1/capabilities`, `GET P/context`, `GET P/objects/{o}/versions/{v}` | H/E/W | 읽기 가능 |
| 실행 시작 | `POST P/runs` | H | 불가 |
| claim·heartbeat·wait·complete | `POST P/claims`, `P/runs/{r}/heartbeat`·`/wait`·`/complete` | 담당 E | 불가 |
| 중단·취소 | `POST P/runs/{r}/interrupt`·`/cancel` | **H 또는 자기 담당 run의 E** | 불가 |
| 인계 | `POST P/runs/{r}/handoffs` | 현재 담당 E 또는 H(강제 인계는 H만) | 불가 |
| 결과 제출 | `POST P/runs/{r}/results` | 담당 E | 불가 |
| 질문 게시 / 수정 | `POST P/questions` / `P/questions/{q}/revisions` | 게시: E(담당 run)·H·**W(제한, 사람→AI 질문만)** / 수정: H·허가된 E | 게시만 가능(중간 위험), 수정 불가 |
| 질문 철회·보류·합치기 | `POST P/questions/{q}/withdraw`·`P/questions/{q}/defer`·`P/questions/{q}/merge` | H·허가된 E(수정과 같음: 에이전트는 리스를 쥔 동안만) | 불가 — 3단계 U2a(SEL-90). 질문의 **새 버전**(state `withdrawn`·`deferred`·`merged`)을 쓴다: 옛 버전·옛 답은 그대로, 지우지 않는다. 폼의 최신 세트에 있으면 같은 tx 에서 그 질문만 뺀 새 세트가 발행된다. 전이: `open`→셋 다, `deferred`→`withdrawn`·`merged`, 나머지 409 `conflict`. 낡은 `base_version_id` 는 409 `rev_conflict`. merge 대상은 같은 프로젝트의 열린(`open`) 다른 질문(자기 자신 422, 없음·다른 프로젝트 404, 열려 있지 않음 409). 응답 201 `{question:{id,version_id,version_no,state[,merged_into_question_id]}, previous_answers_preserved:true}`. 멱등 키 필수 |
| 답·의견 제출 | `POST P/submissions` | **H만**(에이전트는 403 `human_required`, 2026-11-10 SEL-47 결정. 에이전트는 답을 `inputs`로 읽기만 한다). 3단계 U2a(SEL-90): 닫힌 선택 필드 `mode`(`bundle`·`single`, 없으면 이전 동작=부분 제출 허용). `bundle`=적용되는 필수 질문이 모두 차야 접수(아니면 422 `validation_failed` `details.reason=required_missing`·`question_ids`, 조건 `show_if` 가 거짓인 질문에 답을 보내면 `not_applicable`), `single`=항목 정확히 1개. 응답에 `form_complete`·`missing_required`(질문 id 배열) 가 더해진다 | 불가(초안은 브라우저 폼) |
| 입력 기다리기 / 영수증 | `GET P/runs/{r}/inputs?cursor=&wait_ms=` / `POST P/runs/{r}/input-receipts` | E | 불가 |
| 변경분 | `GET P/changes?cursor=` | H/E/W | 선택 범위 읽기 |
| 작업 공간 읽기 | `GET P/workspace` | H/E/W | 읽기 가능 — 3단계 U1b(SEL-82)에서 등록. 현재 단계·라운드·단계별 보기·차례·**권한별 가능 동작(+비활성 이유, 서버 검사 대체 아님)**·기록 개수(가정·결정·의견, 없으면 `empty`). **SEL-87:** `ai_connection{policy(allowed·denied·missing·corrupt — `allow_opencode_go` 비트와 정책 포인터만 따름, pending 없음), dispatches[{id,run_id,state(DB 8값 그대로),resolution?}]}`, `runs[{id,stage|null,mode,status(DB 8값, 사람 소유자가 만든 앱 인계 가져오기 run — runtime `*_app_handoff` + 사람 actor + `succeeded` 세 가지가 모두 맞을 때만 `handed_off`; 에이전트가 같은 이름의 runtime 으로 claim 한 run 은 DB 상태 그대로)}]`, 승인한 단계의 `stages[].past_approval{at|null,origin}`. dispatches·runs 는 각각 **최근 50건**만(그 안에서는 오래된 것부터)이다. **runs 만 활성 판 것**(`runs.edition_id`)이고, **dispatches 는 판과 무관한 프로젝트 전체 최근 50건**이다(전송·청구·회수는 프로젝트 단위 사실이라 판을 새로 만들어도 이전 판에서 나간 `sent`·`unknown` 전송이 칩·회수 안내·청구 미정에 계속 보여야 한다. `dispatches[].run_id` 는 `runs[]` 에 없는 이전 판 run 을 가리킬 수 있다). 승인 시각이 손상돼 날짜로 못 바꾸면 `past_approval.at` 은 `null`(오류 아님). **안 보내는 칸(DB 근거 없음):** `run_permissions`(외부 앱 질문·권한을 담는 저장소 없음), `cancel_state`(취소 시도 열·사건 없음), `external_stop`(연결 끊김 ≠ 취소), `pending`(확정 전 정책 저장소 없음) — 앱은 '정보 없음·알 수 없음'으로 그린다. 기계 값만(화면 글자는 앱이 만든다), 읽기 전용·새 표 없음, `context:read` |
| 변경 머리 커서 | `GET P/changes?cursor=head` | H/E/W | 사건을 읽지 않고 지금 머리 커서만 — `{events:[], next_cursor, has_more:false, epoch}`. 앱 `getChanges(null)` 의 기준 받기(SEL-82). 보통 changes 와 같은 인증·자격 묶음, 읽기 전용 |
| 앱 세션 넘기기 | CLI `pes open <slug> --app` + `POST /api/v1/app-session/codes`(CLI→서버, 소유자 세션 헤더) + `POST /api/v1/app-session`(앱→서버, 코드) — capabilities·라우트 표에는 올리지 않는다(HTTP 서버 층의 두 길, OpenAPI 의 `x-app-session` 절) | CLI·앱(사람 전용) | 서버는 앱 페이지에 세션을 심지 않는다. 세션은 **주소에 없다**(SEL-85, SEL-82 의 `#pes=<세션>` 조각을 대체): CLI 가 이미 켜진 서버에 `POST /api/v1/app-session/codes` {projects:{slug:id}} 를 `x-pes-session`(소유자 세션)으로 부르면 서버가 1회용 코드를 만들고(201 `{data:{code}}`, 세션 없이는 401 — 무인증 발급 없음, 분당 60회), CLI 가 `http://127.0.0.1:<port>/p/<slug>/e/<판>/s/<단계>/r/<라운드>#code=<코드>` 를 연다(`PES_NO_BROWSER=1` 이면 그 한 줄만 찍는다). 코드 = 암호학적 무작위 32바이트(base64url 43자), 호출마다 다름, **서버 프로세스 메모리에만** 둔다(디스크·DB·로그 0, SHA-256 해시 키 조회), 수명 기본 60초(`PES_APP_CODE_TTL_MS`, ms), 읽는 순간 지워져 **한 번만** 통하고(동시에 보내도 하나만 성공) 서버가 꺼지면 사라진다. 앱은 렌더 전에 조각을 `history.replaceState` 로 지운 뒤(요청보다 먼저) `POST /api/v1/app-session` {code} 를 한 번(세션 헤더 없음·credentials omit·재시도 없음·5초 제한 — 서버가 답이 없으면 끊고 안내를 그린다) 보내 `200 {data:{session, projects:{slug:id}}}` 를 받아 같은 탭 sessionStorage 에 둔다(같은 세션이면 projects 합침). 교환은 인증 없이 열리지만 **정확히 `http://127.0.0.1:<port>` 인 Origin** 만 받고(다른 Origin·`localhost`·Origin 없음 = 403, trusted_origins 도 안 통함), POST 만(GET·쿼리로는 교환 불가), **실패한 시도**(모양 틀린·모르는·쓴·만료된 코드)만 분당 120회 예산을 쓰고 다 쓰면 429 `rate_limited` 다 — 맞는 코드의 교환은 세지 않고 예산 때문에 막히지도 않는다(같은 PC 의 다른 프로그램이 Origin 을 흉내 내 실패를 쏟아도 사용자 자신의 교환은 막지 못한다. 코드는 256비트라 추측은 어차피 안 되고 이 예산은 소음만 막는다). 쓰이지 않은 유효 코드는 동시에 64개까지(기본 수명·발급 예산에서는 닿지 않는다) — 가득 차면 새 발급이 429 `rate_limited`(+`Retry-After` = 가장 먼저 만료되는 코드까지)이고 **유효 코드를 밀어내 버리지 않는다**. 쓴·만료된·모르는 코드는 모두 같은 401, 모양 틀림 400, 큰 본문 413. 모든 응답 `Cache-Control: no-store`. 앱 빌드 자산은 `/_app/`(프로젝트 이름은 `_` 로 시작할 수 없다). **알려진 한계:** 코드는 60초 안에 한 번만 통하므로 브라우저 기록·북마크·터미널 로그에 남은 주소는 쓸 수 없다 — 그러나 코드가 만들어진 뒤 쓰이기 전 60초 동안 같은 PC 의 다른 프로그램이 주소를 보면 먼저 쓸 수 있다(그러면 사용자의 탭이 안내를 그린다 — 조용히 당하지는 않는다). 교환된 세션은 같은 탭 sessionStorage 에 남고 세션 값 자체의 회전은 `local_session_secret` 파일 삭제다. **에이전트·스킬은 `pes open --app` 을 부르지 않는다**(`npm run lint:skills` 가 스킬·에이전트·명령 문서의 `open`+`--app` 코드 예제를 거절한다). 같은 출처 보고서·산출물 HTML 의 sessionStorage 접근은 막음(SEL-86: DB 프로젝트와 옛 project.json 폴더 모두 `/<slug>/reports/…`·`/<slug>/out/…` 의 text/html·image/svg+xml 응답에 `Content-Security-Policy: sandbox allow-scripts allow-popups allow-modals allow-downloads`(allow-same-origin 없음, PDF·래스터 이미지 제외, <img> 표시는 그대로; 옛 폴더의 index.html·ask-*.html 은 제외), 앱 index 에 `script-src 'self'`). 옛 정적 경로는 `text/xml`·`application/xml`·`application/xhtml+xml` 에도 붙고, 홈 자체가 한 프로젝트일 때의 `/reports/…`·`/out/…` 도 같다. **단, sandbox 는 그 문서 하나에만 걸린다 — 보고서 스크립트가 같은 탭을 sandbox 없는 같은 출처 HTML 로 옮기면 그 페이지는 탭의 sessionStorage 를 읽는다. 그래서 같은 출처에 sandbox 없는 AI 작성 HTML 이 없어야 하며, 정적 폴백 전체의 sandbox·nosniff 는 SEL-102 에서 한다. 앱은 보고서를 같은 탭 또는 `rel=noopener` 새 탭으로만 연다(`window.open` 의 opener 를 넘기지 않는다).** |
| 파일 | `POST P/uploads` → `PUT` → `POST P/uploads/{u}/complete`, `GET P/files/{b}/content` | H/E | 불가 |
| 첨언·답글 | `POST P/threads`, `P/threads/{t}/messages` | H/E/W | 가능 — 3단계 U2a(SEL-90)는 **질문 의견**(`context_kind=question_comment`, 대상은 질문)만 켠다: `P/threads` 201 `{thread:{id,state:"open"}, message:{id,version_no:"1",thread_id}}`, `P/threads/{t}/messages` 201 `{message:{id,version_no:"1",thread_id}}`. 의견은 답이 아니다(답·제출을 만들지 않고 필수를 채우지 않는다). 쓰는 쪽은 사람 소유자 또는 리스를 쥔 에이전트(`run:submit`). 앵커 문맥 `annotation` 은 U4a 까지 501 `not_supported` |
| 해결·후속 적용 | `POST P/threads/{t}/resolutions`, `P/followups/{f}/apply` | H/허가된 E(reopen 적용은 H) | 불가 |
| 가정·결정·반영 | `POST P/assumptions`·`/decisions`·`/reflections`, `GET P/assumptions`·`/decisions`·`/reflections?round_id=` | H/E(역할별) | 불가 — 3단계 U3a(SEL-93). **제안은 E도 쓰지만 판단·채택·대체·폐기는 H만**(토큰은 403 `human_required`). 모든 쓰기는 새 버전(원문·옛 버전 보존)이고 멱등 키가 필수다. ① `POST P/assumptions` 본문 `{statement, state, rationale?, scope?}`: `proposed`=새 가정(`needs_review`), `confirmed`·`rejected`·`revised`+`assumption_id`·`base_version_id`=사람 판단(`rejected`·`revised`는 근거, `revised`는 새 문장). 응답 201 `{assumption:{id,version_id,state,needs_review,assessed_by_actor_id}}`. ② `POST P/decisions` 본문 `{scope(project·edition), statement, state, supersedes\|null, rationale?, decision_id?, base_version_id?}`: `proposed`=제안(채택 아님), `adopted`+`decision_id`·`base_version_id`=채택, `adopted`+`supersedes`·`base_version_id`·근거=대체(새 결정+옛 결정의 `superseded` 새 버전), `revoked`+`decision_id`·`base_version_id`·근거=폐기. 응답 201 `{decision:{id,version_id,state,scope}}`. 대체 대상이 adopted 가 아니면 409 `supersedes_conflict`(target `$.body.supersedes`, next_action `reread_decisions`, details `{target_state, current_decision_id}`). 그 밖의 오류: 토큰이 `supersedes` 를 보내면 대상을 보기 전에 바로 403 `human_required`, 채택·폐기의 `scope` 가 결정의 실제 scope 와 다르면 422 `validation_failed`(target `$.body.scope`, reason `scope_mismatch`, 아무것도 안 씀), 대체 요청에 `decision_id` 를 같이 보내면 400 `invalid_payload`, 지난 판(completed·archived)의 가정·판 범위 결정을 판단하면 409 `conflict`(details.reason `edition_closed`; draft 판·프로젝트 범위 결정은 해당 없음). 대체로 만든 새 결정은 옛 결정이 속한 판에 들어간다. 같은 키·같은 본문의 대체 요청은 대상 상태를 보기 전에 첫 응답을 재생(`replayed:true`)하고 같은 키·다른 본문은 409 `idempotency_key_reuse`. ③ `POST P/reflections` 본문 `{target_round_id, entries:[{source_version_id, disposition(applied·partial·rejected·deferred), rationale, result_version_id?, followup_id?, evidence_tx_id?}]}`: applied·partial 은 증거(`evidence_tx_id`가 결과 버전을 만든 tx 이고 결과≠원문, 후속은 그 tx 로 applied)가 없으면 422 `evidence_required`(target `$.body.entries[i].result_version_id`, next_action `add_evidence`), 안 맞으면 422 `validation_failed`(target `$.body.entries[i].evidence_tx_id`). 이미 대체된 항목을 다시 대체하면(다른 호출이든 같은 호출 안이든) 409 `conflict`(details.reason `entry_replaced`, 아무것도 안 씀). 빈 `entries` 는 "0건 제출"이다. 응답 201 `{reflection:{id,target_round_id,applied_count,partial_count}}`. 읽기는 객체마다 현재 버전 한 줄(`context:read`); `GET P/reflections?round_id=`는 `{round_id, submitted, counts, entries}`로 "미제출"(false)과 "0건"(true, entries [])을 가른다 |
| 라운드 시작·봉인 | `POST P/stages/{s}/rounds`, `P/rounds/{r}/seal` | H/허가된 E | 불가 |
| **단계 승인·reopen·판 시작·Go 정책·토큰·삭제** | `POST P/stages/{s}/approve`·`/reopen`, `P/editions`, `P/policies/opencode-go/revisions`, `P/agent-tokens` … | **H만** | **금지** |
| 외부 내보내기 | `POST P/exports` | H | 불가 |

3·4·5·6단계 기능의 경로는 방향만 정함. 아직 없는 동작은 capabilities에 미지원으로 표시하고 가짜 성공을 돌려주지 않음.

### 6.1 WEB15 양방향 연결 명령 (2026-11-05 개정 초안)

WEB15의 WebSocket/HTTP 메시지는 자유 형식이 아니라 아래 **닫힌 PES 명령**으로만 매핑한다. 연결 도우미는 사람/기기 링크 자격, AI 도구는 MCP/API 자격을 쓰며 서로 대체하지 않는다. 매 메시지·재접속마다 현재 `project_members`·scope·프로젝트·정책을 검사하고, expected rev·멱등 키·사건/영수증을 같은 tx에 남긴다. 권한 회수·교차 기기/프로젝트 메시지·가짜 완료는 거부한다. 파일 바이트는 WebSocket이 아니라 HTTP 업로드/다운로드로 보내고, WebSocket은 알림·상태·작은 메타데이터만 다룬다.

| 명령(초안) | 경로(초안) | actor·scope | expected·멱등 |
|---|---|---|---|
| `sync.link.create` | `POST P/sync-links` | H(owner), `sync:link` | 기기 승인·1회 링크, 멱등 키 |
| `sync.link.revoke` | `DELETE P/sync-links/{l}` | H(owner) 또는 같은 기기, `sync:link` | 즉시 회수, 다음 메시지 401 |
| `sync.link.heartbeat` | `POST P/sync-links/{l}/heartbeat` | 도우미 기기 링크, `sync:link` | 마지막 확인·커서, rev 불변 |
| `sync.push` | `POST P/sync-links/{l}/items` | 도우미 기기 링크, `sync:write` | base_rev/hash, 멱등 키, 충돌 409 |
| `sync.pull` | `GET P/sync-links/{l}/items?cursor=` | 도우미 기기 링크, `sync:read` | 커서, 권한·deny 필터 |
| `sync.conflict.resolve` | `POST P/sync-links/{l}/conflicts/{c}/resolve` | H(사람), `sync:resolve` | expected rev, 선택·이유 |
| `schedule.report` | `POST P/agent-schedules/{s}/reports` | 도우미 기기 링크, `schedule:write` | expected rev, 멱등 키 |
| `progress.report` | `POST P/agent-schedules/{s}/progress` | 도우미 기기 링크, `progress:write` | expected rev, `events.execution.progress.*`와 같은 tx |

명령 이름·경로는 WEB15 구현 전 확정하되, 위 actor·scope·expected·멱등·tx 경계는 계약으로 유지한다. AI 도구는 이 표의 sync 명령을 쓰지 않고 기존 MCP/API 명령을 쓴다.

## 7. Claude 앱 (방식 B)

- **직접 연결 우선**(Desktop 로컬 확장 등, ④에서 실제 시험), 제한되면 **명시적 전달**(묶음 복사 → 결과 가져오기)을 대안으로. 앱을 보장 대상에서 빼지 않음
- 직접 인증한 앱의 제출은 `external_agent`. **사람이 결과를 붙여 넣은 경우 실제 제출자는 human**, `claude_app(미검증)`은 별도 출처로만 기록
- **복사만으로 실행·제출 완료로 표시하지 않음.** 전달 경로의 사람도 같은 검증·짧은 claim·제출 명령을 씀(H의 claim·submit 권한은 이 경로에 한정)

## 8. MCP·이벤트 공개

- 방식 B MCP 도구: `pes_context / pes_claim / pes_submit / pes_ask / pes_wait / pes_complete` + heartbeat·release·cancel·영수증 조회. 인자의 `idempotency_key`를 헤더로 매핑, 같은 오류 코드
- 이벤트 공개: `type` allowlist는 필요조건일 뿐 — project·actor 범위·run_targets·현행 Go 정책을 검사한 뒤 payload를 공개 DTO로 제한. DB visibility 열은 지금 추가하지 않음

## 9. 다음으로 넘기는 것

- **DB**: 6단계 외부 내보내기 영수증(전송 전 영속 작업·payload hash·시도·목적지 상관키·unknown), A 실행기 동작의 system actor 기록(④)
- **③ 화면**: 승인 시 snapshot/rev 표시, 충돌·`lease_lost`·커서 무효 복구, 중단/취소/인계 구분, Go in-flight/unknown 표시, 외부 전송 미리보기
- **④ 실행 구조**: TTL·heartbeat(시험), Go API **주소·모델 목록·원시 model ID↔내부 ID·구독 적용 조건·billing source·allowance·오류/스트림 필드** 후보 검증, 사용량 추정, 중단 작업 재처리·재시작 복구, Claude 앱 연결
- **2단계**: [검수 C절](discussion/stage-1-api-codex-review.md)의 기존 PR별 귀속을 승계하되, 현행 번호는 `roadmap.md` 2절의 PR1~19·20a·20b·20c·21·22·26(25개)을 따른다. **PR 10(토큰·정책)은 13·14·19·20a·20b·20c의 선행.** 각 PR에서 자기 범위를 검사하고 21번(교차 계약)까지 미루지 않음. SQLite·D1에서 같은 원자 명령의 성공·충돌·부분 실패는 PR 2·4·21
- **5단계**: 로그인, 원격 MCP, 알림

## 10. 완료 기준 (SEL-22)

- [x] 2~7절의 계약 방향과 값, Claude·Codex 합의
- [x] Codex 최종 대조(지적 13건 반영)
- (2단계) 기계 명세(OpenAPI 등)와 합성 예제는 PR 13·14에서
