# 1단계 ② API 형식 — Claude 추천안 (Codex 검수용)

- 작성: 2026-11-04, Claude. 입력: `stage-1-api-codex.md`, `stage-1-api-opencode.md`, 확정 `stage-0.md`, 합의 `stage-1-db.md`, `schemas/stage-1-ddl-draft.sql`.
- 규칙: Claude 확인 → Codex 검수 → 합의안으로 진행. stage-0 7절·stage-1-db 2절은 다시 정하지 않는다.

## A. 두 의견이 같은 것 (그대로 채택)

1. **HTTP/JSON이 원본**, MCP·CLI·WebMCP·웹 화면은 같은 업무 명령을 부르는 얇은 층. 표 CRUD·임의 ops API는 없음 — 닫힌 업무 명령 목록(`result.submit`, `stage.approve` …)
2. **PES API(에이전트↔PES)와 OpenCode 서버 API(A 어댑터↔OpenCode)를 분리.** B는 OpenCode를 모름
3. 경로 `/api/v1/projects/{id}/…`, 봉투 `format_version: "1.0"`. DB schema_version·workflow_version과 별개. 요청의 모르는 필드는 거부
4. 모든 쓰기: `Idempotency-Key` 필수, `expected`(rev/control_rev/lease_id/fence) 검사, **0행이면 실패**, `mutation_commits`+`events` 같은 트랜잭션. 같은 키·같은 요청은 원래 결과 재생, 같은 키·다른 요청은 거부
5. rev·fence·event_seq는 **10진 문자열**로 전달(큰 정수 손실 방지)
6. context는 **digest + 대상 정확한 버전 manifest**, 본문은 선택 조회. 전체 프로젝트를 밀어 넣지 않음
7. claim = run 생성/재개 + lease 획득 한 묶음. 질문을 올리고 기다릴 땐 lease를 놓고 `waiting_human`. 답은 짧은 long-poll로 받음
8. submit은 **작은 원자 묶음**(결과·출처·입력 영수증 함께). `complete`는 run 종료일 뿐 **단계 승인이 아님**
9. 입력 영수증: seen/ignored는 따로, applied는 results와 함께
10. 중단·취소·인계 구분. DB에서 결과 채택 차단과 외부 프로세스 중단 확인을 따로 표시
11. **승인·reopen·판 시작·Go 정책 변경·토큰·멤버·삭제는 사람(소유자)만.** 에이전트 토큰·WebMCP 불가
12. 인증: **에이전트는 프로젝트 범위 Bearer 토큰, 사람은 로컬 세션**. actor·via는 서버가 확정(클라이언트 자기 신고 불신). 로그인 UI는 5단계
13. 변경분: `(database_instance_id, cursor_epoch, event_seq)`를 담은 불투명 커서. 복원·이전으로 epoch가 바뀌면 전체 재동기화. tx 묶음 단위로 적용
14. 큰 파일: 예약 → 업로드 → hash 확인 → complete(ready). 파일 읽기도 프로젝트·버전·Go 정책 검사
15. **Go OFF**: 새 A run·prompt·요약·첨부·재시도 403 `policy_blocked`, prepared/authorized → blocked, in-flight는 OpenCode `interrupt` 시도, sent/unknown은 "회수 보장 없음" 기록, run `interrupted`, 자동 재시작 없음, 재허용 후에도 사람이 새로 시작. 합성 자료도 우회 없음
16. WebMCP 노출: 읽기(요약·맥락·질문·스레드) / 답 **초안(브라우저 폼만)** / 첨언·답글 추가 / 사람→AI 질문 추가 / 할 일 제안만. 답 제출·해결·claim·submit·complete·export·승인류는 불가. `browser_agent` + `on_behalf_of_user_id` 기록
17. Linear·Notion: **PES가 원본, 사람이 고른 버전만 한 방향**, 왕복·인바운드 웹훅 없음. 6단계
18. **2단계 22개 PR 유지**(API는 기존 PR 4·5·9·10·13·14·18~22에 귀속). 새 PR은 3단계 WebMCP 1개, 6단계 외부 내보내기(1~2개)

## B. 세부 값·갈린 곳 — Claude 추천

| # | 항목 | Codex | OpenCode | Claude 추천 | 이유 |
|---|---|---|---|---|---|
| 1 | long-poll 최대 | 25초 이하 | 30초 | **25초**(capabilities로 공지) | 흔한 프록시·브라우저 기본 시간초과(30초)보다 짧게 |
| 2 | 토큰 만료 | — | 30일+회수 | **30일 + 회수**, 갱신은 소유자 | 로컬 1인 사용에 적당 |
| 3 | 멱등 키 보존 | — | 7일 | **7일**(영수증 행은 남기고 응답 본문만 정리) | 재시도 범위 충분, 감사는 영수증으로 |
| 4 | 요청 제한 | 256KiB·결과 20개/묶음·목록 100 | 60 req/min, 429 | **둘 다**: 본문 256KiB, 결과 20개/묶음, 목록 100, 에이전트 토큰당 60 req/min(사람 세션은 제한 완화). 값은 capabilities로 공지·2단계 시험으로 조정 | 폭주한 에이전트가 로컬 서버를 막지 않게 |
| 5 | 승인 역할 | — | 2단계 owner만 | **2단계 owner만**, editor는 5단계 검토 | 지금은 1인 |
| 6 | 오류 형식 | 안정된 error code | 코드 영어 + 문구 한국어 | **`error.code` 영어 고정 + `error.message` 한국어 + `retryable`·`target`** | 에이전트는 코드로, 사람은 문구로 |
| 7 | A 에이전트의 PES 접근 | E 토큰 | 세션 직접(어댑터는 수명만) | **A 세션도 PES API를 run 범위 토큰으로 직접 부름.** 어댑터는 세션 시작·중단·이벤트·권한·정책 검사만 | A·B가 같은 API를 쓰는 원칙(0단계 원칙) |
| 8 | 서버 답 초안 | `PUT answer-drafts` | 브라우저 폼만 | **2·3단계엔 서버 초안 API 없음 — 브라우저 저장소만**(③ 화면 합의와 같음). 필요해지면 DB 표와 함께 추가 | 현 DDL에 초안 표 없음 |
| 9 | 일부 답만 왔을 때 A 재개 | 유효한 제출 봉투 완성 뒤 | — | **유효한 제출(submission)이 들어온 뒤 재개**, 초안·댓글만으로는 재개하지 않음 | 반쯤 답한 상태로 AI가 달려 나가지 않게 |
| 10 | Claude 앱 연결 제한 시 | 직접 연결 우선, 안 되면 출처 명시 전달 | — | **같음.** 앱을 보장 대상에서 빼지 않음. 실제 방법은 SEL-24 | 사용자 결정(B 보장) 유지 |
| 11 | 외부 내보내기 영수증 | events + 후속 | 6단계 `export_receipts` 표 | **6단계에 `export_receipts` 표 추가**(그 전엔 없음) | 외부 ID·재시도·중복 방지에 필요 |
| 12 | 내부 이벤트 숨김 | — | `type` allowlist | **API가 이벤트 `type` allowlist로 공개 범위 결정**(DB 변경 없음) | DDL에 visibility 없음 |
| 13 | 202의 의미 | 요청 영속 저장일 뿐 | — | **같음** — 202는 "받아서 저장함", 외부 실행 완료 아님 | 상태 혼동 방지 |

## C. 이슈

2단계 새 이슈 0개(22개 유지). 3단계 WebMCP 1개, 6단계 Linear·Notion 내보내기 1개(목적지별 분리가 필요하면 2개). 5단계 로그인·원격 MCP·알림은 5단계 계획서에서.

## Codex에게 묻는 것

A(1~18), B(1~13), C 각각에 **동의 / 수정 / 반대**를 표로. 근거는 두 의견서 절·stage 문서·DDL 줄. stage-0 7절·stage-1-db 2절을 뒤집지 말 것.
