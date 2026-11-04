# 6단계 구현 이슈 동료 검토

- 대상: [stage-6.md](stage-6.md)
- 기준: [stage-6.md](../stage-6.md) 4~5절, [stage-1-db.md](../stage-1-db.md), [stage-1-api.md](../stage-1-api.md), [stage-1-ui.md](../stage-1-ui.md), [stage-1-runners.md](../stage-1-runners.md), [DDL 초안](../schemas/stage-1-ddl-draft.sql), 실제 `scripts/`·`templates/`
- 검토일: 2026-11-05
- 상태: 동료 검토 반영. 계획서와 코드는 고치지 않았고, 이슈 초안만 고쳤다.

## 1. 확인 요약

| 점검 | 결과 |
|---|---|
| 계획서의 6단계 이슈가 모두 있는가 | **11/11**. E1·E2, M1~M3, G1~G3, H1, X2, X1이 모두 있다. |
| 이슈 하나 = PR 하나인가 | **11/11**. 각 절이 이슈 하나이고, 표·테이블별 하위 이슈가 없다. E1·M1·X1은 큰 단일 PR이지만 계획서가 그렇게 정했다. |
| 선행이 있는가 | **11/11**. 모든 절에 `**선행**`이 있다. |
| 완료 기준과 테스트 명령이 있는가 | **11/11**. `pytest`, `check_ddl.py`, `doctor`, `git diff --check` 중 해당 명령이 있다. |
| 파일·표 이름이 실제와 맞는가 | **문제 17건 발견, 17건 고침**. 새 파일·새 표는 계획서에 없는 이름을 만들 때 "신규"임을 분명히 하고, 기존 파일과 혼동하지 않게 고쳤다. |

## 2. 문제 목록

| # | 위치 | 문제 | 근거 | 처리 |
|---|---|---|---|---|
| 1 | `stage-6.md` 8행 | 공통 선행이 `1단계 PR1~22·U1~U6`으로 적혀 있어 2단계 PR과 3단계 U를 1단계로 잘못 묶고, 4단계 S4 이슈가 빠져 있다. | stage-6 4절은 PR1~22·U1~U6·S4·WEB을 구분한다. | `2단계 PR1~22, 3단계 U1~U6, 4단계 S4-PR23~25·S4-U7~U12, 5단계 WEB0~WEB14`로 고쳤다. |
| 2 | `stage-6.md` 127행 | `templates/settings_members.html`·`templates/invite_accept.html`을 "추가/갱신"한다고 했지만 실제 `templates/`에 두 파일이 없다. | 실제 템플릿은 `_questions.html`, `ask.html`, `dashboard.html`, `eli5.html`, `final-report.html`, `hub.html`, `stage-report.html`뿐이다. | "추가"로 고치고, 새 파일임을 분명히 했다. |
| 3 | `stage-6.md` 84·127·164행 | 새 템플릿 이름이 `export_preview.html`·`settings_members.html`처럼 밑줄 표기다. 기존 템플릿은 `final-report.html`·`stage-report.html`처럼 하이픈을 쓴다. | 실제 `templates/`의 파일명 규칙. | `export-preview.html`, `export-status.html`, `settings-members.html`, `invite-accept.html`, `artifact-edit.html`, `artifact-conflict.html`로 통일했다. |
| 4 | `stage-6.md` 8행 | `scripts/api.py`·`scripts/command_service.py`가 실제 파일이거나 2단계에서 확정된 이름처럼 읽힌다. 현재 `scripts/`에는 `pes.py`·`serve.py`·`setup.py`와 설치 스크립트만 있고, 2단계 계획에도 이 이름이 없다. | 실제 `scripts/` 목록과 stage-2 계획서. | 두 이름은 2단계 PR4·13·14에서 정한 모듈 이름의 **예시**라고 명시했다. |
| 5 | `stage-6.md` 49행 | E1이 API `Idempotency-Key`와 외부 상관키 `correlation_key`를 구분하지 않고, 같은 키·같은 요청의 재생 조건이 없다. | stage-1 API 3절의 멱등 키·영수증 규칙. | `Idempotency-Key`와 `correlation_key`를 구분하고, 같은 키·같은 요청은 원래 작업·operation_id를 재생하며 같은 키·다른 payload는 409라고 추가했다. 완료 기준에도 넣었다. |
| 6 | `stage-6.md` 41·43행 | `export_jobs`에 `client_request_id`·`request_hash`가 없고, `UNIQUE(project_id, client_request_id)`·`UNIQUE(project_id, id)`도 없다. 복합 FK를 걸려면 `(project_id, id)` 유일성이 필요하다. | DDL의 `UNIQUE(project_id, id)` 관례와 stage-1 API의 멱등 규칙. | `client_request_id`·`request_hash` 열과 두 UNIQUE를 추가했다. |
| 7 | `stage-6.md` 27행(C15) | E1의 `exports/preview`·`retry`·`cancel`, M2의 객체 revision, M3의 adoption 경로가 1단계 API 6절·capabilities에 반영된다는 완료 조건이 없다. | stage-1 API 6절은 6단계 경로를 방향으로만 두고, 미지원은 capabilities에 표시한다. | C15에 "새 경로·명령은 1단계 API 6절·capabilities에 반영하고, 새 scope는 WEB4 목록·MCP 도구에도 반영"을 추가했다. |
| 8 | `stage-6.md` 83~85행 | E1의 `preview_export`/`mark_export_sending`/`finish_export_job`과 E2의 `build_export_preview`/`dispatch_export_job`/`classify_export_result`가 같은 전이를 두 곳에서 구현할 수 있다. | E1은 상태·영수증, E2는 목적지 어댑터라는 계획서의 역할 구분. | "상태·영수증 전이는 E1, 목적지 payload·호출·응답 분류는 E2"로 역할을 나누는 bullet을 추가했다. |
| 9 | `stage-6.md` 119행 | `project_policy_versions`의 `projects(id, owner_user_id)` FK를 제거하면서 기존 `(changed_by, changed_by_user_id, changed_by_kind) → actors` 복합 FK를 유지한다는 말이 빠져 있다. | 실제 DDL 127~131행. | 기존 actors 복합 FK를 유지한다고 명시했다. |
| 10 | `stage-6.md` 120~121행 | `ownership_transfers`·`question_assignments`에 `id` PK와 `UNIQUE(project_id, id)`가 없어 DDL의 표 관례와 맞지 않는다. | DDL의 모든 업무 표가 `id TEXT PRIMARY KEY`와 `UNIQUE(project_id, id)`를 쓴다. | 두 표에 `id TEXT PRIMARY KEY`와 `UNIQUE(project_id, id)`를 추가했다. |
| 11 | `stage-6.md` 117행 | `project_members`를 새 표로 교체하는데 `projects`가 `project_members`를 FK로 참조한다. 현재 순서만으로는 SQLite/D1에서 FK 제약 때문에 실패할 수 있다. | DDL 47~49행의 `projects` → `project_members` FK. | FK를 끄지 않고 가능한 순서인지 먼저 시험하고, 불가능하면 `projects`도 같은 마이그레이션에서 재생성한다고 조건을 추가했다. |
| 12 | `stage-6.md` 198~199행 | M3 child의 `proposal:write` scope가 5단계 WEB4의 scope 목록·capabilities·MCP 도구 목록에 없다. | 5단계 WEB4의 scope 목록과 stage-1 API 6절. | `proposal:write`를 WEB4 scope·capabilities·MCP 도구에 추가하는 bullet을 넣었다. |
| 13 | `stage-6.md` 195행 | `adoption_proposals`에 `UNIQUE(project_id, id)`, 프로젝트 복합 FK, 상태 CHECK가 없다. | DDL의 복합 키·FK 관례. | 세 제약을 명시했다. |
| 14 | `stage-6.md` 234행 | G1의 MCP 도구 목록에 `pes_projects`가 빠져 있다. | 5단계 WEB5의 실제 도구 목록과 stage-1 API MCP 목록. | `pes_projects`를 도구 목록 맨 앞에 추가했다. |
| 15 | `stage-6.md` 381행 | X2의 `doctor` 완료 명령이 `mktemp`·`HOME=`을 쓰는 POSIX 전용이라 Windows/Mac 공통 기준과 맞지 않는다. | C15의 Windows·macOS 요구. | macOS/Linux 명령과 Windows PowerShell 명령을 나눠 적었다. |
| 16 | `stage-6.md` 420행 | X1의 완료 명령이 `PES_HWPX_BIN=... /tmp/report.hwpx`로 POSIX 전용이다. | C15의 Windows·macOS 요구. | 출력 경로를 `<임시 폴더>/report.hwpx`로 바꾸고, Windows PowerShell은 `$env:PES_HWPX_BIN`·`$env:TEMP`를 쓴다고 적었다. |
| 17 | `stage-6.md` 24~28행 | 공통 회귀 명령도 `mktemp`·`HOME=`을 쓰는 POSIX 전용이다. | C15의 Windows·macOS 요구. | Windows PowerShell에서는 `HOME`·`USERPROFILE`·`PES_HOME`을 임시 폴더로 설정한다는 안내를 추가했다. |

## 3. 고치지 않은 것

- 계획서 [stage-6.md](../stage-6.md), 1단계 설계서, DDL, 코드, `scripts/`, `templates/`는 고치지 않았다.
- Linear에는 아무 이슈도 만들지 않았다.
- 실제 `~/pes-projects`·`~/.pes/`는 읽지 않았다.
- E1·M1·X1은 여전히 큰 단일 PR이다. 계획서가 "이슈 하나 = PR 하나"를 정했으므로 표·테이블별로 쪼개지 않았다.
