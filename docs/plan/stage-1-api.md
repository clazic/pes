# 1단계 ② API 형식 설계서

- 작성: 2026-11-04, Claude 종합. Linear: SEL-22
- 입력: [stage-1-api-codex.md](discussion/stage-1-api-codex.md), [stage-1-api-opencode.md](discussion/stage-1-api-opencode.md), Claude 추천안 [stage-1-api-claude-recs.md](discussion/stage-1-api-claude-recs.md), Codex 검수 [stage-1-api-codex-review.md](discussion/stage-1-api-codex-review.md)(A·B·C 32항목: 동의 18·수정 14·반대 0), Codex 최종 대조 [stage-1-api-final-check.md](discussion/stage-1-api-final-check.md), 합의 [stage-1-db.md](stage-1-db.md)
- 상태: **확정 — 사용자 승인 2026-11-05.** **합의안(Claude·Codex)** — 최종 대조 지적 13건 반영

## 1. 목표

웹 PES와 에이전트가 주고받는 **하나의 약속**을 정한다. HTTP/JSON이 원본이고 MCP·CLI·WebMCP·웹 화면은 같은 업무 명령을 부르는 얇은 층이다. 방식 A·B가 같은 API를 쓴다.

## 2. 합의된 결정

| # | 주제 | 결정 |
|---|---|---|
| 1 | 원본 | HTTP/JSON. **닫힌 업무 명령 목록**(`result.submit`, `stage.approve` …), 표 CRUD·임의 ops 없음. 통로마다 별도 검증·직접 DB 쓰기 없음(로컬 CLI가 반드시 자기 HTTP를 거칠 필요는 없지만 같은 명령 서비스를 씀) |
| 2 | 두 API 분리 | **PES API**(에이전트↔PES)와 **OpenCode 서버 API**(A 어댑터↔OpenCode). B는 OpenCode 세션 ID·DTO를 모름 |
| 3 | 버전 | 경로 `/api/v1/projects/{id}/…`, 봉투 `format_version:"1.0"`(DB·workflow 버전과 별개). 요청의 모르는 필드는 거부, 응답의 선택 필드 추가는 허용, 모르는 정책·상태를 허용으로 해석하지 않음 |
| 4 | 쓰기 안전 | `Idempotency-Key` 필수. **전제(expected)는 명령별로 필수 항목을 정함**(사람 답·첨언엔 lease 불필요, 최초 claim엔 기존 lease 없음). 순서: 인증·권한·정책 → 완료 영수증 재생 → rev/lease 검사. 1행 변경을 요구하는 CAS·가드가 0행이면 실패, 전부 롤백(빈 조회·정상 재생은 실패 아님). **모든 DB 변경 명령(결과·질문·답·정책·중단 등)은 변경·`mutation_commits` 영수증·`events`를 한 트랜잭션에**, 파일 바이트 전송은 별도 단계. 같은 키·같은 요청은 원래 결과 재생, 다른 요청은 거부 |
| 5 | 숫자 | rev·control_rev·fence·event_seq는 **정규화한 10진 문자열**. 문자열 사전식 비교·JS Number 변환 금지 |
| 6 | 맥락 | **digest + 대상의 정확한 버전 manifest**, 본문은 선택 조회(같은 권한 검사). 정책·rev·커서의 일관된 읽기 경계 |
| 7 | 실행 | queued run 등록은 별도 가능. **claim·재개 = run 전이 + lease 획득 원자적.** 결과·질문을 저장한 뒤 **명시적 `wait` 명령**으로 `waiting_human` + lease 해제. 입력 조회(long-poll)는 순수 읽기(ack·heartbeat·전이 없음). 재개는 새 claim·새 fence |
| 8 | 제출 | **작은 원자 묶음**(결과·정확한 출처 버전·입력 영수증·사건). `complete`는 run 종료일 뿐 봉인·승인·다음 단계 전이가 아님 |
| 9 | 입력 영수증 | seen/ignored는 따로. **applied는 실제 결과 버전 또는 적용된 후속 조치 증거와 같은 트랜잭션**에서만. 인계 뒤 새 run에 같은 입력이 다시 보여도 **기존 적용 여부를 확인해 중복 반영하지 않음** |
| 10 | 중단·인계 | DB 채택 차단은 즉시 확정, 외부 중단은 pending/confirmed/failed/unknown으로 추적. 연결 끊김 ≠ 취소. 인계는 parent_run_id를 둔 새 run, 강제 인계는 사람만 |
| 11 | 사람만 | 승인·reopen·판 시작·Go 정책·토큰·멤버·삭제는 **소유자 사람 세션**. 본문의 human_id·via·WebMCP 주석은 증거가 아님 |
| 12 | 인증 | 에이전트 = **프로젝트 범위 Bearer 토큰(30일 + 회수)**, 사람 = 로컬 세션. actor·via는 서버가 확정. Origin 검사는 유지하되 인증을 대신하지 않음. 2단계에도 로컬 소유자 경로·CSRF 경계 필요. 로그인 UI는 5단계 |
| 13 | 변경분 | 커서 = `(database_instance_id, cursor_epoch, event_seq)` + **project_id·권한 범위·스캔 상한**을 묶은 서버 검증 불투명 값. epoch가 바뀌면 허용된 snapshot부터 다시 읽음(전체 본문 반환 아님). 공개 tx 단위로 적용, 숨긴 사건도 스캔 커서엔 반영. **커서 무효·재동기화 때도 화면의 미제출 답은 버리지 않음** |
| 14 | 파일 | 예약 → 업로드 → hash → complete(ready). **Go 쪽 파일 읽기는 매번 정책을 검사하는 PES 프록시 경로**(OFF 뒤 R2 다운로드 URL로 우회 불가). 파일 참조 버전·프로젝트도 검사 |
| 15 | Go OFF | 기본 켜짐·프로젝트별 끄기(사용자 결정) 그대로. OFF 커밋 뒤 새 송신 승인 금지. **새 A run 시작·prompt·요약·첨부·재시도는 `403 policy_blocked`.** **prepared → blocked, authorized는 미송신이 확인될 때만 blocked**, 이미 승인된 건은 송신 여부·취소 시도·unknown 기록, sent 이력 보존. 영향받는 run의 옛 lease 제출 차단(이미 끝난 run은 그대로). Go 목적지로 가는 context·changes·inputs·파일·재시도도 차단. **이미 나간 자료는 회수 보장 없음**, **합성 자료도 우회 없음**. 재허용 뒤에도 사람이 명시적으로 시작/재개 + 새 claim |
| 16 | WebMCP | 읽기 / 답 **초안은 브라우저 폼만** / 첨언·답글·사람→AI 질문·**할 일 제안 기록 추가**(run·다음 라운드·reopen 실행 아님) — 이 추가들은 **중간 위험 쓰기**. 제출·해결·claim·submit·complete·export·승인류 불가. 제한된 browser_actor 자격으로 접근하고 기록은 `actors.kind=browser_agent`, on_behalf_of_user_id는 위임 관계일 뿐 사람의 직접 작성·승인 증거가 아님 |
| 17 | 외부 내보내기 | PES가 원본, 사람이 고른 정확한 버전·목적지·payload만 한 방향. Go ON ≠ 외부 내보내기 동의. 6단계 |
| 18 | 이슈 | **2단계 22개 PR 유지**, API는 기존 PR에 귀속. 3단계 WebMCP 1개, 6단계 내보내기 1~2개 |

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

- A 세션의 **도구가 공통 PES API로 제출**. 토큰은 모델 프롬프트에 넣지 않고 신뢰하는 HTTP/MCP 도구가 주입
- 등록된 run에만 claim 가능한 자격을 발급(또는 시작/claim용 서버 자격과 claim 후 실행 자격을 분리)해 최초 claim 순환 문제를 풀고, **허용 run을 서버가 검사**(본문의 run_id 선언을 믿지 않음)
- 어댑터 책임: 세션 시작·중단, heartbeat·재접속, 중단 요청 재처리, 전송 영수증 추적, 정책 검사

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
| 답·의견 제출 | `POST P/submissions` | H(E는 자기에게 온 질문만) | 불가(초안은 브라우저 폼) |
| 입력 기다리기 / 영수증 | `GET P/runs/{r}/inputs?cursor=&wait_ms=` / `POST P/runs/{r}/input-receipts` | E | 불가 |
| 변경분 | `GET P/changes?cursor=` | H/E/W | 선택 범위 읽기 |
| 파일 | `POST P/uploads` → `PUT` → `POST P/uploads/{u}/complete`, `GET P/files/{b}/content` | H/E | 불가 |
| 첨언·답글 | `POST P/threads`, `P/threads/{t}/messages` | H/E/W | 가능 |
| 해결·후속 적용 | `POST P/threads/{t}/resolutions`, `P/followups/{f}/apply` | H/허가된 E(reopen 적용은 H) | 불가 |
| 가정·결정·반영 | `POST P/assumptions`·`/decisions`·`/reflections` | H/E(역할별) | 불가 |
| 라운드 시작·봉인 | `POST P/stages/{s}/rounds`, `P/rounds/{r}/seal` | H/허가된 E | 불가 |
| **단계 승인·reopen·판 시작·Go 정책·토큰·삭제** | `POST P/stages/{s}/approve`·`/reopen`, `P/editions`, `P/policies/opencode-go/revisions`, `P/agent-tokens` … | **H만** | **금지** |
| 외부 내보내기 | `POST P/exports` | H | 불가 |

3·4·5·6단계 기능의 경로는 방향만 정함. 아직 없는 동작은 capabilities에 미지원으로 표시하고 가짜 성공을 돌려주지 않음.

## 7. Claude 앱 (방식 B)

- **직접 연결 우선**(Desktop 로컬 확장 등, ④에서 실제 시험), 제한되면 **명시적 전달**(묶음 복사 → 결과 가져오기)을 대안으로. 앱을 보장 대상에서 빼지 않음
- 직접 인증한 앱의 제출은 `external_agent`. **사람이 결과를 붙여 넣은 경우 실제 제출자는 human**, `claude_app(미검증)`은 별도 출처로만 기록
- **복사만으로 실행·제출 완료로 표시하지 않음.** 전달 경로의 사람도 같은 검증·짧은 claim·제출 명령을 씀(H의 claim·submit 권한은 이 경로에 한정)

## 8. MCP·이벤트 공개

- 방식 B MCP 도구: `pes_context / pes_claim / pes_submit / pes_ask / pes_wait / pes_complete` + heartbeat·release·cancel·영수증 조회. 인자의 `idempotency_key`를 헤더로 매핑, 같은 오류 코드
- 이벤트 공개: `type` allowlist는 필요조건일 뿐 — project·actor 범위·run_targets·현행 Go 정책을 검사한 뒤 payload를 공개 DTO로 제한. DB visibility 열은 지금 추가하지 않음

## 9. 다음으로 넘기는 것

- **DB**: 6단계 외부 내보내기 영수증(전송 전 영속 작업·payload hash·시도·목적지 상관키·unknown), supervisor 동작의 system actor 기록(④)
- **③ 화면**: 승인 시 snapshot/rev 표시, 충돌·`lease_lost`·커서 무효 복구, 중단/취소/인계 구분, Go in-flight/unknown 표시, 외부 전송 미리보기
- **④ 실행 구조**: TTL·heartbeat(시험), OpenCode 버전·기능 감지, 중단 작업 재처리·재시작 복구, Claude 앱 연결
- **2단계**: [검수 C절](discussion/stage-1-api-codex-review.md)의 기존 PR별 귀속을 그대로 승계(PR 1·2·3·4·5·6·7·8·9·10·11·12·13·14·15~17·18·19·20·21·22). **PR 10(토큰·정책)은 13·14·19·20의 선행.** 각 PR에서 자기 범위를 검사하고 21번(교차 계약)까지 미루지 않음. SQLite·D1에서 같은 원자 명령의 성공·충돌·부분 실패는 PR 2·4·21
- **5단계**: 로그인, 원격 MCP, 알림

## 10. 완료 기준 (SEL-22)

- [x] 2~7절의 계약 방향과 값, Claude·Codex 합의
- [x] Codex 최종 대조(지적 13건 반영)
- (2단계) 기계 명세(OpenAPI 등)와 합성 예제는 PR 13·14에서
