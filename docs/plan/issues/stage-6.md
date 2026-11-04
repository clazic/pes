# 6단계 구현 이슈 초안

- 원본: [stage-6.md](../stage-6.md) 4절 구현 이슈 표
- 입력 계약: [stage-1-db.md](../stage-1-db.md), [stage-1-api.md](../stage-1-api.md), [stage-1-ui.md](../stage-1-ui.md), [stage-1-runners.md](../stage-1-runners.md), [stage-1-ddl-draft.sql](../schemas/stage-1-ddl-draft.sql)
- 상태: **초안 — 사용자 승인 뒤 Linear 등록**. 이 문서는 원고이며 Linear에 아직 만들지 않았다.
- 구성: **11개**(E1·E2, M1·M2·M3, G1·G2·G3, H1, X2, X1). 각 절이 이슈 하나다.
- 규칙: **이슈 하나 = PR 하나.** 아래 각 절을 그대로 이슈 하나로 옮긴다. 표·테이블별 하위 이슈를 만들지 않는다.
- 공통 선행: 1단계 PR1~22·U1~U6, 5단계 WEB0~WEB14가 끝난 상태를 전제로 한다. 4단계 이슈는 `S4-` 접두어로만 가리킨다. 마이그레이션 경로 `migrations/`와 번호 체계는 2단계 PR1이 만든 것을 쓰고, 아래 `006~008`은 **예시 번호**다.
- 공통 자료: 시험은 합성 fixture만 쓴다. 실제 `~/pes-projects`·`~/.pes/`를 읽거나 쓰지 않고, 실제 프로젝트·토큰·캡처·payload를 저장소·로그·CI artifact에 넣지 않는다.

## 공통 완료 기준 (C15)

모든 이슈의 완료 조건에 아래를 포함한다.

- [ ] 성공·거부·충돌·부분 실패를 각각 자동 시험한다. 해피 패스만으로 끝내지 않는다.
- [ ] 새 마이그레이션이면 SQLite와 D1에서 같은 의미로 통과한다. D1은 `db.batch()` 원자성, 0행 CAS 실패, deferred FK, 부분 인덱스를 확인한다.
- [ ] 매 PR과 main에서 Windows·macOS `python -m pytest -q`/`python3 -m pytest -q`가 통과한다.
- [ ] 화면이 있으면 Playwright 스모크, 한글 IME, 200% 확대, 키보드·초점·접근성을 확인한다. Windows 필수 브라우저 시험을 건너뛰지 않는다.
- [ ] 테스트는 임시 `HOME`·`PES_HOME`으로 격리한다. 실제 홈을 읽지 않았음을 시험 로그에 남긴다.
- [ ] PR 본문에 실제 자료·토큰·비밀·외부 계정 식별자가 0건임을 확인한다.

공통 회귀 명령:

```sh
python3 -m pytest -q
review_home="$(mktemp -d)"
HOME="$review_home" PES_HOME="$review_home/pes-projects" python3 scripts/pes.py doctor
```

---

## E1. [6단계] 외부 내보내기 영수증·명령·API

**목표**: PES가 원본인 한 방향 내보내기의 작업·시도·영수증·상관키를 DB와 API에 먼저 고정해, 목적지 어댑터가 붙기 전에도 중복·unknown·부분 실패를 정직하게 기록한다.

**선행**: PR4·10·14, WEB2·3·4·11.

**할 일**

- [ ] `docs/plan/schemas/stage-1-ddl-draft.sql`에 `export_jobs`·`export_attempts` 설계를 추가하고, 새 마이그레이션 `migrations/006_stage6_export.sql`을 만든다(번호는 2단계 PR1의 마지막 번호 다음).
  - `export_jobs`: `id`, `project_id`, `requested_by_user_id`, `destination`(`linear`/`notion`), `destination_account_ref`, `destination_scope`, `source_kind`(`dev_issue`/`report_version`), `source_object_id`, `source_version_id`, `manifest_blob_id`, `payload_hash`(64자), `correlation_key`, `status`(`queued`/`sending`/`sent`/`partial`/`failed`/`unknown`/`cancelled`), `attempt_count`, `external_id?`, `external_url?`, `last_error_code?`, `created_at`, `updated_at`.
  - `export_attempts`: `id`, `project_id`, `job_id`, `attempt_no`, `state`(`prepared`/`sending`/`sent`/`partial`/`failed`/`unknown`), `request_hash`, `response_hash?`, `external_id?`, `external_url?`, `error_code?`, `started_at`, `ended_at`.
  - 제약: `UNIQUE(project_id, correlation_key)`, `UNIQUE(project_id, job_id, attempt_no)`, 프로젝트 복합 FK, 상태 CHECK, `source_version_id`·`manifest_blob_id` FK. `outbound_dispatches`를 재사용하지 않는다.
- [ ] `docs/plan/schemas/check_ddl.py`에 `export_jobs`/`export_attempts` 양성 적재와 거부 사례를 추가한다: 같은 상관키 중복, 같은 키·다른 payload, 다른 프로젝트 버전 참조, 잘못된 상태 전이, 0행 갱신.
- [ ] 2단계 PR4의 공통 명령 서비스(예: `scripts/command_service.py`)에 `preview_export()`, `create_export_job()`, `mark_export_sending()`, `record_export_attempt()`, `finish_export_job()`, `retry_export_job()`, `get_export_job()`을 추가한다.
- [ ] `scripts/api.py`(2단계 PR13·14 라우터)에 `POST /api/v1/projects/{project_id}/exports/preview`, `POST .../exports`, `GET .../exports/{job_id}`, `POST .../exports/{job_id}/retry`, `POST .../exports/{job_id}/cancel`을 추가한다. 생성은 `202` 영속 접수와 `operation_id`를 반환한다.
- [ ] 생성·시도·사건·`mutation_commits` 영수증을 **같은 DB tx**에 쓰고, 네트워크 호출은 커밋 뒤에만 한다.
- [ ] 사람 step-up(5단계 WEB2), **owner만 실행**, WebMCP·에이전트 토큰·OAuth 위임 거부를 서버에서 검사한다. approver에게 export 권한을 주지 않는다.
- [ ] 자격정보는 서버 secret/OS 키체인에만 두고 `export_jobs`·`export_attempts`·로그·에러·프롬프트에 넣지 않는다.
- [ ] `sending`에서 프로세스가 죽어도 재시작 뒤 `GET`으로 상태를 조회하고, `unknown`을 `sent`로 바꾸지 않는 복구 경로를 넣는다.

**완료 기준**

- [ ] `python3 docs/plan/schemas/check_ddl.py`
- [ ] `python3 -m pytest -q tests/test_stage6_export_core.py tests/test_stage6_export_api.py`
- [ ] `python3 -m pytest -q tests/test_stage6_export_d1.py` (2단계 PR2 D1 smoke 하네스)
- [ ] `python3 -m pytest -q`
- [ ] owner만 export를 만들 수 있고, approver·editor·에이전트·WebMCP는 403이다.
- [ ] 같은 `correlation_key`·다른 payload가 409, 다른 프로젝트 자원 참조가 403/404, 0행 CAS가 실패로 롤백된다.
- [ ] `202` 응답 뒤 프로세스를 재시작해도 `export_jobs`/`export_attempts`가 조회되고 `sending` 복구가 동작한다.
- [ ] `unknown`이 성공·`sent`로 표시된 경우가 0건이고, 자격정보가 DB·로그에 0건이다.

**지킬 것**

- PES가 원본이고 **한 방향**이다. 왕복 동기화·외부 수정 반영을 넣지 않는다.
- `outbound_dispatches`(Go 정책)와 `export_jobs`를 섞지 않는다. **Go ON ≠ export 동의**다.
- `202`는 완료가 아니라 영속 접수다. 외부 생성 멱등을 확인할 수 없으면 `unknown` 유지·자동 재전송 금지.
- 승인·정책·토큰·삭제 권한을 export 명령에 섞지 않는다.

---

## E2. [6단계] Linear·Notion 한 방향 어댑터·미리보기

**목표**: Linear에는 PES 개발 할 일만, Notion에는 사람이 고른 보고서 버전 사본만 보내고, 미리보기·상관키·시도·unknown·부분 생성을 E1 영수증 위에서 구현한다.

**선행**: E1, PR9, U4·U5, S4-U8, WEB4·11.

**할 일**

- [ ] `scripts/exporters/base.py`에 `ExportAdapter` 프로토콜(`build_payload`, `send`, `classify_response`, `verify_external`)을 만든다.
- [ ] `scripts/exporters/linear.py`에 `build_linear_payload()`·`send_linear()`를 만든다. payload는 **PES 개발 이슈 제목 + 사람이 쓴 요약**만이고, 연구 내용·질문·답·파일은 자동 포함하지 않는다.
- [ ] `scripts/exporters/notion.py`에 `build_notion_payload()`·`send_notion()`을 만든다. `S4-U8` 버전 선택에서 고른 **정확한 보고서 버전 사본**만 보내고, Notion 편집을 PES로 되돌리는 동기화는 만들지 않는다.
- [ ] `scripts/export_service.py`에 `build_export_preview()`, `dispatch_export_job()`, `classify_export_result()`, `verify_export_result()`를 추가한다. 목적지 상태 `미설정`/`미지원`/`활성`을 구분하고, 비활성 이유를 UI에 보여 준다.
- [ ] `templates/export_preview.html`·`templates/export_status.html`을 추가한다. 포함/제외, 목적지 계정·워크스페이스, 민감 내용 경고, `Go ON ≠ export 동의` 문구, 외부 ID·URL, 시도·unknown·재시도 결과를 표시한다.
- [ ] 보고서/비교 화면(S4-U8)에서 "내보내기" 진입을 추가하되, 기본 "할 일로"는 PES 다음 라운드 할 일로 유지한다.
- [ ] 부분 생성(Notion 페이지/블록 다중 요청)은 `partial`과 외부 ID·재개 지점을 남기고 `sent`와 구분한다.
- [ ] `unknown` 뒤 자동 재전송을 금지하고, 사용자가 재전송을 눌러도 이미 생성됐을 가능성과 확인 방법을 보여 준다.
- [ ] Linear·Notion 각각의 rate limit·오류 코드·재시도 가능/불가를 `classify_response()`에 매핑하고, 자격정보는 요청 로그에 남기지 않는다.
- [ ] 합성 payload로만 실제 왕복을 시험한다. 실제 계정 시험은 사용자 허용 뒤 별도 증거로 분리한다.

**완료 기준**

- [ ] `python3 -m pytest -q tests/test_stage6_export_linear.py tests/test_stage6_export_notion.py`
- [ ] `python3 -m pytest -q tests/test_stage6_export_preview.py`
- [ ] `python3 -m pytest -q`
- [ ] 가짜 서버에서 성공·중복·`unknown`·재시도·부분 생성이 모두 재현되고, `unknown`이 성공으로 표시되지 않는다.
- [ ] 정확한 버전만 전송되고, 연구 내용 자동 전송이 0건이다. WebMCP·에이전트 토큰·OAuth 위임이 export를 실행하면 403이다.
- [ ] 미리보기에서 목적지·포함 범위·민감 경고·비활성 이유가 보이고, 승인 뒤 payload/목적지가 바뀌면 다시 확인을 요구한다.

**지킬 것**

- Linear는 **PES 개발 할 일**만, Notion은 **사람이 고른 보고서 사본**만. 연구 할 일을 자동으로 Linear 이슈로 만들지 않는다.
- 외부 완료 ≠ PES 적용·승인. 왕복 동기화·외부 편집 반영을 넣지 않는다.
- `outbound_dispatches`를 재사용하지 않는다. Go 전송 기록과 export 영수증은 별개다.
- 자격정보는 서버 secret/OS 키체인에만 둔다. 미리보기·에러·로그에 넣지 않는다.

---

## M1. [6단계] 역할·멤버·승인·초대

**목표**: `approver`를 승인·reopen에 한정해 추가하고, owner 이전·마지막 owner 보호·질문 배정 이력·초대 시 외부 AI 경로를 서버 검증과 감사까지 일관되게 구현한다.

**선행**: WEB2·3, PR4·10·14, PR8·U2.

**할 일**

- [ ] 새 마이그레이션 `migrations/007_stage6_roles.sql`에서 `project_members.role` CHECK를 `owner`/`approver`/`editor`/`reader`로 재작성한다. SQLite는 CHECK를 직접 바꿀 수 없으므로 **새 표 → 데이터 복사 → 교체 → `projects` owner FK·`one_project_owner` 인덱스 재생성** 순서로 한다. D1에서도 같은 결과를 확인한다.
- [ ] `projects`에 `allow_member_external_agents INTEGER NOT NULL DEFAULT 0 CHECK (... IN (0,1))`를 추가한다. 기본값은 **불허**다.
- [ ] `project_policy_versions`의 `(project_id, changed_by_user_id) → projects(id, owner_user_id)` FK를 제거하고 `changed_by_user_id → users(id)`로 바꾼다. **과거 정책 작성자를 새 owner로 덮어쓰지 않고**, 현재 owner만 정책을 바꿀 수 있는 검사는 명령 서비스에서 한다. 이 표도 SQLite/D1에서 table rebuild로 FK를 교체한다.
- [ ] `ownership_transfers`(project_id, from_user_id, to_user_id, tx_id, created_at)를 추가해 소유권 이전을 감사한다. `projects.owner_user_id`·`project_members`의 owner 행을 **한 tx**로 바꾸고, 이전 전후 FK·권한을 시험한다.
- [ ] `question_assignments`(project_id, question_id, from_actor_id?, to_actor_id, changed_by_user_id, tx_id, created_at)를 추가하고, `objects.rev` 증가·`events` `question.assigned`·`mutation_commits` 영수증을 같은 tx에 남긴다.
- [ ] `scripts/command_service.py`에 `approve_stage()`, `reopen_stage()`, `change_member_role()`, `transfer_project_owner()`, `assign_question()`, `set_member_external_ai()`를 추가한다.
- [ ] `approve_stage()`/`reopen_stage()`는 owner 또는 `project_members.role='approver'`인 **사람**만 허용하고, 현재 멤버·5분 step-up·`snapshot_id`/rev를 서버에서 검증한다. `assurance=verified` 문자열만으로 통과시키지 않는다.
- [ ] `scripts/api.py`의 `POST P/stages/{s}/approve`·`/reopen`·멤버·초대·질문 배정 경로에 위 검사를 연결하고, `/api/v1/capabilities`와 UI 권한 표에 `approver` 범위를 추가한다.
- [ ] `templates/settings_members.html`·`templates/invite_accept.html`을 추가/갱신한다. 초대는 owner만, 7일 1회, 기본 reader, 공개 링크 없음. 초대 수락 화면에 현재 Go 전송 허용과 연결된 외부 에이전트를 보여 주고, owner가 프로젝트별 멤버 외부 AI 연결을 켜고 끈다.
- [ ] editor의 승인·reopen·정책·토큰·삭제·멤버·판 시작을 모두 403으로 만들고, approver도 승인·reopen 밖의 동작은 할 수 없게 한다.
- [ ] 마지막 owner 제거·owner 없는 상태·owner 2명을 모두 거부한다.
- [ ] PR 검토 순서를 **승인 위임 계약 확정 → 소유권·배정 기록 → 화면·회귀**로 잡고, 표별로 쪼개지 않는다. 독립 배포·되돌리기가 필요하면 근거와 예산을 본문에 적는다.

**완료 기준**

- [ ] `python3 docs/plan/schemas/check_ddl.py`
- [ ] `python3 -m pytest -q tests/test_stage6_roles.py tests/test_stage6_owner_transfer.py tests/test_stage6_question_assignment.py`
- [ ] `python3 -m pytest -q tests/test_stage6_invites.py`
- [ ] `python3 -m pytest -q`
- [ ] owner/approver/editor/reader 권한 매트릭스 전 항목이 통과하고, editor·에이전트·WebMCP 승인이 403이다.
- [ ] owner 이전 전후 `project_policy_versions.changed_by_user_id`가 보존되고, 과거 정책 행이 FK 오류 없이 남는다.
- [ ] 초대 수락 화면에 외부 AI 경로가 보이고, 기본 불허에서 멤버 연결이 차단된다.
- [ ] 배정 변경 전 제출·옛 응답자 제출·동시 제출이 각각 보존/거부되며, 과거 답은 당시 질문/폼·응답자에 남는다.

**지킬 것**

- owner는 항상 승인 가능하고, 프로젝트당 owner는 최대 1명이다. ownerless 상태를 만들지 않는다.
- `approver`는 **승인·reopen만** 확장한다. 정족수·조직 역할·SSO/SCIM은 넣지 않는다.
- 승인은 사람의 직접 행위다. 에이전트 토큰·OAuth 위임·WebMCP·`human_id` 선언으로 대체하지 않는다.
- 과거 정책 작성자·과거 답·과거 배정을 새 값으로 덮어쓰지 않는다. 삭제 대신 이력 보존.
- 초대·외부 AI 연결은 자료 노출 경계다. 기본 불허, owner만 변경, 실제 계정 정보는 저장소에 넣지 않는다.

---

## M2. [6단계] 동시 편집·충돌

**목표**: 모든 편집을 새 버전으로 남기고 `base_version_id`/rev 낙관적 동시성으로 덮어쓰기를 막으며, 409 충돌에서 양쪽 버전과 초안을 보존한다.

**선행**: M1, S4-PR25, S4-U11, PR4·14.

**할 일**

- [ ] `scripts/command_service.py`에 `assert_base_version()`, `revise_object()`, `resolve_edit_conflict()`를 추가한다. 요청 `base_version_id`와 현재 `objects.current_version_id`/`objects.rev`를 비교하고, 불일치면 409를 낸다.
- [ ] 새 `object_versions`는 항상 `based_on_version_id`를 기록하고, `actor_id`·`run_id`·`tx_id`·`content_hash`를 같은 tx에 넣는다. 실패한 tx를 성공 버전으로 부분 저장하지 않는다.
- [ ] 409 오류 봉투 `details`에 `expected_version_id`, `current_version_id`, `current_rev`, `base_version_id`를 넣는다. 자동 병합·자동 재기반을 하지 않는다.
- [ ] `templates/artifact_edit.html`에 Markdown+미리보기, 현재/기대 버전, 충돌 대화(한쪽 선택·새 버전에 다시 적용), 승인·게시본 보호 안내를 추가한다.
- [ ] `templates/artifact_conflict.html`을 추가하고, `sessionStorage` 초안 키(프로젝트·사용자·판·객체·기반 버전)를 유지한다. 409·타임아웃·응답 유실에서 초안을 지우지 않고, 서버 영수증 뒤에만 성공 표시한다.
- [ ] 승인·게시 스냅숏은 수정하지 않는다. 수정하려면 새 버전 + stale + 재승인 흐름을 안내한다.
- [ ] "누가 편집 중" 표시는 선택 기능으로 두고 문서 잠금으로 쓰지 않는다. CRDT/OT를 넣지 않는다.
- [ ] `scripts/api.py`의 `POST P/objects/{o}/revisions`(또는 4단계 PR25 명령)에 `base_version_id` 필수·409·멱등 키를 연결한다.
- [ ] 두 사람·사람 대 worker·재접속·권한 회수 뒤 편집을 각각 시험한다.

**완료 기준**

- [ ] `python3 -m pytest -q tests/test_stage6_conflict.py tests/test_stage6_conflict_ui.py`
- [ ] `python3 -m pytest -q`
- [ ] 두 사람이 같은 기준 버전에서 편집하면 한쪽만 성공하고 다른 쪽은 409이며, **양쪽 초안·버전이 보존**된다.
- [ ] 409 뒤 새 버전에 다시 적용하면 `based_on_version_id`가 새 기준과 맞고, 승인 스냅숏은 변하지 않는다.
- [ ] 사람 대 worker, 재접속, 권한 회수 뒤 편집에서 덮어쓰기 0건이다.
- [ ] Windows/Mac에서 IME·초안·409 화면이 유지되고, 200% 확대·키보드 초점이 통과한다.

**지킬 것**

- 원문 덮어쓰기 금지. 모든 편집은 새 버전 + `based_on_version_id`.
- 409를 자동 병합·자동 재시도로 숨기지 않는다. 실패한 tx를 부분 성공으로 저장하지 않는다.
- 승인·게시본은 불변. stale·재승인 규칙을 우회하지 않는다.
- 초안은 서버 답 초안 API가 아니라 브라우저 저장소에 둔다. 기기 간 복구를 보장하지 않는다.

---

## M3. [6단계] 다중 worker 제안·채택

**목표**: 프로젝트당 에이전트 채택자 하나를 유지하면서, 여러 child worker가 최소 권한으로 제안하고 부모가 대상별로 직렬·원자 채택하게 한다.

**선행**: PR1·2·4·5·7·9·10·13·21, WEB4·6·7·12.

**할 일**

- [ ] 새 마이그레이션 `migrations/008_stage6_adoption.sql`에 `adoption_proposals`를 추가한다: `id`, `project_id`, `parent_run_id`, `child_run_id`, `object_id`, `base_version_id`, `proposed_version_id`, `proposal_hash`, `state`(`pending`/`accepted`/`rejected`/`conflict`/`withdrawn`), `created_at`, `decided_at?`, `decided_by_run_id?`.
- [ ] `runs`에 `parent_relation TEXT CHECK (parent_relation IN ('worker_child','handoff','reviewer'))`를 추가해 `parent_run_id`의 관계 종류를 구분한다. 기존 행은 마이그레이션에서 안전한 기본값/널로 처리한다.
- [ ] `scripts/adoption_service.py`에 `submit_adoption_proposal()`, `adopt_proposals_batch()`, `assert_parent_fence()`, `propagate_parent_state()`를 추가한다.
- [ ] child 자격은 `proposal:write`만 가진 최소 권한 통로로 만든다. claim·채택·결과 제출·승인 권한을 주지 않고, `parent_run_id`만으로 권한 분리가 됐다고 보지 않는다.
- [ ] `scripts/api.py`에 `POST P/runs/{run_id}/adoption-proposals`, `POST P/runs/{run_id}/adoptions`, `GET P/runs/{run_id}/adoptions`를 추가한다.
- [ ] 채택 tx에서 `object_versions.actor_id`는 **부모 run/actor**, `mutation_commits`·`events`도 같은 actor로 맞춘다. child의 task·역할·세션·제안 hash·모델·근거는 `adoption_proposals`/`events`에 별도 출처로 남긴다.
- [ ] 다른 객체를 한 tx에 채택하는 batch는 전체 롤백한다. 같은 객체에 두 제안이 오면 409로 한쪽만 채택하고 자동 병합하지 않는다.
- [ ] 부모 OFF·만료·중단·`waiting_human`·담당 반납을 child 반출·제출에 전파한다. 재개는 부모의 새 claim·현재 정책·잔여 예산 확인 뒤에만 한다.
- [ ] child·reviewer·재시도·인계가 누적 예산을 초기화하지 않게 예약·정산을 연결하고, 최대 병렬 수는 측정값으로 제한한다.
- [ ] reviewer는 부모가 lease를 놓은 뒤 별도 run/새 claim으로 실행하고, 메인 결론을 주지 않는다.

**완료 기준**

- [ ] `python3 docs/plan/schemas/check_ddl.py`
- [ ] `python3 -m pytest -q tests/test_stage6_adoption.py tests/test_stage6_adoption_budget.py`
- [ ] `python3 -m pytest -q tests/test_stage6_adoption_fence.py`
- [ ] `python3 -m pytest -q`
- [ ] 동시 제안 뒤 직렬 채택되고, 같은 대상은 하나만 성공·나머지 409, 다른 대상 batch는 성공한다.
- [ ] 부모 만료/인계/OFF 뒤 지연 제안이 거부되고, 옛 fence 제출이 0건 채택된다.
- [ ] child 제안 채택 뒤 `object_versions.actor_id`·`mutation_commits.actor_id`가 부모와 일치하고, child 출처가 보존된다.
- [ ] 예산이 child/reviewer/재시도/인계에서 초기화되지 않고 unknown 예약이 유지된다.

**지킬 것**

- 프로젝트당 **에이전트 채택자 하나**. 사람의 답·첨언·허가된 직접 편집을 lease로 막지 않는다.
- child는 제안만. claim·채택·결과 제출·승인 권한을 상속하지 않는다.
- `parent_run_id`만으로 작성자·권한을 증명하지 않는다. actor·run·tx·출처를 모두 대조한다.
- 동시 채택은 **동시 제안 후 직렬 채택**이다. 여러 독립 채택자가 같은 프로젝트를 동시에 쓰는 것을 허용하지 않는다.

---

## G1. [6단계] 에이전트 어댑터 계약 + Codex CLI

**목표**: Codex CLI가 Claude Code와 같은 PES MCP/HTTP 계약·자격·오류 의미로 합성 1라운드를 완주하고, 어댑터 계약과 Codex 노트를 남긴다.

**선행**: PR13·14·17·20·21, WEB5.

**할 일**

- [ ] `docs/agents/adapter-contract.md`를 새로 만든다. 공통 진입점(`/mcp`, `/api/v1`), 도구 목록(`pes_context`·`pes_claim`·`pes_submit`·`pes_ask`·`pes_wait`·`pes_complete`·heartbeat·release·cancel·영수증), 오류 봉투, `Idempotency-Key`, 프로젝트 토큰/사람 기기 토큰 분리, 승인 불가, 세션·재개, 모델/사용량 기록 규칙을 적는다.
- [ ] `docs/agents/codex.md`를 새로 만든다. 설치·진입 명령, MCP/HTTP 경로, 고정 버전, 토큰 보관(OS 키체인), 재개, 알려진 한계, `runtime=codex_cli`·`provider`/`model`(모르면 `unknown`) 표기를 적는다.
- [ ] `docs/agents/README.md`에 계약·Codex·OpenCode TUI 노트의 읽는 순서와 "노트와 bridge 구현은 별도 산출물"임을 적는다.
- [ ] `scripts/agents/mcp_client.py`에 `load_agent_config()`, `call_pes_tool()`, `classify_pes_error()`를 만든다. 토큰은 프롬프트에 넣지 않고 신뢰하는 도구가 헤더에 주입한다.
- [ ] `scripts/agents/codex_bridge.py`에 `register_codex_run()`, `claim_codex_run()`, `submit_codex_result()`, `record_codex_usage()`를 만든다. `actors.kind=external_agent`, `runs.mode=B`, `runtime=codex_cli`로 기록하고 사람 actor를 사칭하지 않는다.
- [ ] Codex CLI가 승인·reopen·정책·토큰·삭제·외부 export 도구를 호출하지 못하게 도구 목록에서 제외한다.
- [ ] `tests/test_stage6_codex_adapter.py`와 `tests/fixtures/agents/` 합성 프로젝트로 1라운드·재접속·만료/회수·중복 제출·같은 키 다른 요청·버전 오류를 시험한다.

**완료 기준**

- [ ] `python3 -m pytest -q tests/test_stage6_codex_adapter.py`
- [ ] `python3 -m pytest -q`
- [ ] Codex CLI로 합성 프로젝트 1라운드가 완주되고, actor/runtime이 정확하며 `model` 미상이 `unknown`으로 정직하게 남는다.
- [ ] 재접속·만료·회수 뒤 새 요청이 401/403이고, 같은 키·같은 요청은 원래 결과를 재생하며 같은 키·다른 요청은 거부된다.
- [ ] 잘못된 버전·중복 제출이 409/영수증으로 처리되고, 직접 DB/`project.json` 쓰기가 0건이다.
- [ ] 노트만 보고 새 환경에서 연결 절차를 재현할 수 있다.

**지킬 것**

- 같은 API·같은 자격 체계·같은 오류 의미. 에이전트별 코어 분기를 만들지 않는다.
- "같은 토큰"은 같은 자격 체계라는 뜻이지 원문 토큰 하나를 공유한다는 뜻이 아니다.
- 승인·reopen·정책·토큰·삭제·외부 export는 도구 목록에 넣지 않는다.
- 모델·사용량을 모르면 `unknown`으로 남긴다. 추정값을 실제 값처럼 쓰지 않는다.

---

## G2. [6단계] OpenCode TUI 어댑터

**목표**: OpenCode TUI가 같은 계약으로 1라운드를 완주하고, 세션·재개·모델/사용량·Go 반출 경로의 한계를 실제로 시험해 노트에 남긴다.

**선행**: G1, PR13·14·17·21, WEB5.

**할 일**

- [ ] `docs/agents/opencode-tui.md`를 새로 만든다. 진입 명령, MCP/HTTP 경로, 고정 버전, 토큰 보관, 세션 재개, 모델/사용량 표기, Go 반출 경로, 알려진 한계를 적는다.
- [ ] `scripts/agents/opencode_tui_bridge.py`에 `start_tui_session()`, `resume_tui_session()`, `classify_tui_event()`, `record_tui_usage()`를 만든다. `runtime=opencode_tui`, `runs.mode=B`로 기록한다.
- [ ] A의 서버·프로세스·supervisor를 재사용하거나 중단하지 않는다. TUI는 별도 세션·별도 설정으로 띄우고, A의 실행 상태를 건드리지 않는다.
- [ ] Go 목적지로 보내는 맥락·요약·파일·재시도·child 경로를 합성 자료로 실제 시험한다. 막을 수 없는 경로는 "Go OFF 보장"이라고 쓰지 않고 노트에 한계로 남긴다.
- [ ] Codex↔OpenCode TUI 인계를 시험한다. 새 claim·새 fence·미처리 입력·옛 결과 거부를 확인한다.
- [ ] `tests/test_stage6_opencode_tui.py`에 세션 재개·중복 제출·권한 오류·Go 경로 차단·A 비간섭 시험을 넣는다.

**완료 기준**

- [ ] `python3 -m pytest -q tests/test_stage6_opencode_tui.py`
- [ ] `python3 -m pytest -q`
- [ ] OpenCode TUI로 합성 1라운드가 완주되고, Codex↔OpenCode 인계 뒤 중복·유실이 0건이다.
- [ ] 같은 오류 코드·권한 의미가 Codex/Claude Code와 일치한다.
- [ ] Go 경로 시험 결과가 노트에 "차단됨/막을 수 없음"으로 구분되고, 막을 수 없는 경로를 보장으로 표기하지 않는다.
- [ ] A 서버·프로세스가 시험 전후로 동일하게 살아 있고, TUI가 A 상태를 바꾸지 않는다.

**지킬 것**

- G1 계약을 그대로 쓴다. TUI 전용 업무 의미·오류를 만들지 않는다.
- A의 서버·프로세스를 재사용·중단하지 않는다. TUI는 외부 에이전트 경로다.
- Go OFF 보장을 통합 경로 전체로 일반화하지 않는다. 실제로 막은 경로만 보장으로 쓴다.
- 모델·사용량 미상은 `unknown`으로 남긴다.

---

## G3. [6단계] 다중 에이전트 교차 계약

**목표**: Codex CLI·OpenCode TUI·Claude Code·Claude 앱이 같은 DB 상태에서 같은 의미로 동작하고, M1·M3·E2와 A 회귀까지 교차 검증한다.

**선행**: G1·G2, PR21.

**할 일**

- [ ] `tests/test_stage6_agent_cross.py`를 새로 만들고, PR21 교차 계약 하네스를 확장한다. 공통 하네스는 `tests/test_cross_contract.py`가 있으면 재사용하고 새로 만들지 않는다.
- [ ] 네 에이전트(Codex CLI·OpenCode TUI·Claude Code·Claude 앱)의 같은 명령·같은 오류·같은 actor 규칙을 표로 시험한다.
- [ ] M3 다중 worker 채택, E2 내보내기, M1 승인·초대를 교차 시나리오에 넣는다: 에이전트가 제안하고 사람이 채택/승인, 다른 에이전트가 이어받기.
- [ ] Claude 앱 직접 연결·명시적 전달을 모두 시험한다. 앱이 붙여넣은 결과의 실제 제출자는 `human`이고, `claude_app(미검증)`은 출처로만 남긴다.
- [ ] 인계·중복·충돌·OFF 유실 0건을 확인한다. 앱은 새 claim·기반 버전 대조·중복 방지를 거친다.
- [ ] A(OpenCode/DeepSeek) 회귀를 포함해 A/B가 같은 버전 결과를 내는지 확인한다.
- [ ] `docs/agents/adapter-matrix.md`에 지원 수준·알려진 한계·시험 결과를 표로 남긴다.

**완료 기준**

- [ ] `python3 -m pytest -q tests/test_stage6_agent_cross.py`
- [ ] `python3 -m pytest -q`
- [ ] 네 에이전트가 같은 합성 프로젝트에서 같은 명령 의미·오류 코드·actor 규칙을 보인다.
- [ ] M3 제안→사람 채택, E2 미리보기→사람 전송, M1 승인→감사 흐름이 교차 시나리오에서 통과한다.
- [ ] 앱 직접 연결·명시적 전달 모두 실제 제출자와 출처가 정확하고, 중복 가져오기 0건이다.
- [ ] 인계·OFF·경합·유실 시나리오에서 자동 재시도로 중복 실행되지 않는다.

**지킬 것**

- G3는 교차·통합 시험이며 개별 PR의 자체 검증을 대신하지 않는다.
- 앱의 "연결됨"을 실제 생존·완료로 과장하지 않는다. 마지막 확인 시각과 미상을 구분한다.
- 사람이 붙여넣은 결과를 에이전트 제출로 바꾸지 않는다. 실제 actor를 기록한다.
- 새 어댑터도 승인·정책·토큰·삭제·외부 export 권한을 얻지 않는다.

---

## H1. [6단계] hc-team 운영 평가·규칙 갱신 (문서 PR)

**목표**: hc-team을 새로 도입하는 것이 아니라, 지금까지의 PES 개발 운영 결과를 평가해 적용·제외·중단 규칙을 갱신한다.

**선행**: 시작 조건으로 hc-team 스킬 버전·권한·CI를 확인한다. G1·G2는 평가 대상 중 하나일 수 있지만 H1 완료 조건으로 묶지 않는다.

**할 일**

- [ ] `docs/plan/reviews/hc-team-evaluation.md`를 새로 만든다. `ai/SEL-*` 이슈의 주기, 테스트·CI 통과, 독립 리뷰 지적, 사람 재작업, worktree 격리, 공개 저장소 자료 경계, 중단·전환 사례를 익명 요약으로 적는다.
- [ ] `docs/agents/hc-team-operating.md`를 새로 만든다. 어떤 이슈를 hc-team에 맡기는지, 제외 경계(사람 자격·마이그레이션·외부 자격 변경·보안), 이슈 하나=PR 하나, 사람이 병합, gate 실패·범위 팽창·실자료 유입 시 중단과 일반 개발 전환, 실패 기록을 규칙으로 적는다.
- [ ] `AGENTS.md`의 개발 규칙에 hc-team 운영 문서 링크와 "실제 자료·토큰은 저장소 밖" 경계를 추가한다.
- [ ] `docs/plan/decisions/0006-hc-team-scope.md`에 적용 범위·제외·재검토 조건·상태를 기록한다.
- [ ] 평가에 쓴 실제 PR 번호·로그·캡처는 저장소 밖에 두고, 문서에는 익명 요약·집계만 남긴다.
- [ ] "PR 2개 성공"만을 종료 조건으로 쓰지 않는다. 중단·전환 사례와 사람 재작업을 함께 본다.

**완료 기준**

- [ ] `python3 -m pytest -q` (문서 PR이지만 기존 회귀를 깨지 않는다)
- [ ] `git diff --check`
- [ ] 평가 보고서와 규칙 갱신 PR이 병합되고, `AGENTS.md`에서 새 규칙을 찾을 수 있다.
- [ ] main 직접 쓰기 0건, 실제 자료·토큰·캡처 0건, 사람이 병합했다는 기록이 있다.
- [ ] 적용/제외/중단 기준과 실패 시 일반 개발 전환 절차가 문서에 있다.

**지킬 것**

- hc-team은 이미 쓰고 있다. "6단계 파일럿"으로 새로 포장하지 않는다.
- G1·G2를 hc-team 파일럿 대상으로 묶지 않는다. 평가 대상 중 하나일 수만 있다.
- 실제 사본·토큰·캡처·payload는 저장소 밖. PR에는 익명 요약만.
- 이슈 하나=PR 하나, 사람이 병합, gate 실패 시 중단.

---

## X2. [6단계] 통합·문서 (hwpx 제외)

**목표**: hwpx를 제외한 6단계 전 기능을 합성 자료로 종단 검증하고, 새 표 백업·복구·unknown 런북·사용 안내·잔여 백로그를 남긴다.

**선행**: E1·E2·M1~M3·G1~G3·H1.

**할 일**

- [ ] `tests/test_stage6_integration.py`에 합성 프로젝트 종단 시나리오를 만든다: 초대→승인→동시 편집→다중 worker 제안·채택→Linear/Notion 미리보기·전송→unknown→재시도.
- [ ] `tests/test_stage6_backup_export.py`에 `export_jobs`·`export_attempts`·`ownership_transfers`·`question_assignments`·`adoption_proposals`가 포함된 백업·복구·마이그레이션 되돌리기를 넣는다.
- [ ] `docs/runbooks/export-unknown.md`를 새로 만든다. `unknown`을 DB 롤백으로 지우지 않고, 외부 ID 확인·사용자 재전송·중복 가능성·부분 생성 재개 절차를 적는다.
- [ ] `docs/runbooks/stage6-operations.md`를 새로 만든다. 새 표 백업/복구, 권한·감사, 비용, Windows/Mac, 장애 훈련, 잔여 백로그를 적는다.
- [ ] `README.md`와 `docs/agents/README.md`에 사용 안내를 추가한다: 초대·approver·충돌·다중 worker·내보내기·어댑터·hc-team. 실제 계정·자료 예시는 넣지 않는다.
- [ ] 기존 화면 제거 여부를 결정하고, 제거를 미루면 운영 백로그에 명시한다. 기존 고정 HTML·ask 링크 보존 약속을 깨지 않는다.
- [ ] `scripts/pes.py doctor`에 새 표·마이그레이션·외부 내보내기 설정·에이전트 토큰 존재 여부를 진단하는 항목을 추가한다(비밀값은 표시하지 않음).
- [ ] Windows/Mac에서 설치·복구·알림·내보내기 안내를 재현한다.

**완료 기준**

- [ ] `python3 -m pytest -q tests/test_stage6_integration.py tests/test_stage6_backup_export.py`
- [ ] `python3 docs/plan/schemas/check_ddl.py`
- [ ] `python3 -m pytest -q`
- [ ] `review_home="$(mktemp -d)" && HOME="$review_home" PES_HOME="$review_home/pes-projects" python3 scripts/pes.py doctor`
- [ ] 5절 게이트 중 hwpx 제외 전부 통과하고, 문서만 보고 새 환경에서 재현할 수 있다.
- [ ] 새 표가 백업·복구되고, unknown을 DB 롤백으로 지우지 않는 절차가 시험된다.
- [ ] 공개 저장소에 실제 자료·토큰·계정 식별자 0건, Windows/Mac 시험 기록이 있다.

**지킬 것**

- 실제 자료·토큰·캡처는 저장소·CI artifact에 넣지 않는다. 합성 fixture만 쓴다.
- `unknown`을 성공으로 바꾸거나 DB 롤백으로 숨기지 않는다.
- 기존 화면 제거는 근거와 사용자 확인 뒤에만. 고정 HTML·딥링크 보존 약속을 유지한다.
- X2는 개별 PR의 검증을 대신하지 않는다. 실패한 하위 이슈를 통합에서 통과로 덮지 않는다.

---

## X1. [6단계] hwpx 변환 최종 확인·릴리스

**목표**: 로컬 명령 래퍼로 `report.md`→`report-uri.md`→`report.hwpx`를 만들고, Windows 한글에서 표·그림·각주·긴 한글을 확인하며 실패를 숨기지 않는다.

**선행**: X2, PR9·16, WEB9, E1·E2·M1~M3·G1~G3, H1.

**할 일**

- [ ] `scripts/hwpx_convert.py`를 새로 만든다. `resolve_hwpx_binary()`는 `PES_HWPX_BIN`/설치 경로를 찾고, 없으면 명시적 오류를 낸다.
- [ ] `convert_markdown_to_hwpx(input_md, output_hwpx, images_dir)`를 구현한다. `hwpx-uri` 스킬 설명의 Go 단일 바이너리 인터페이스를 **X1 시작 시 확인**하고, 인자·OS 지원이 다르면 노트에 실제 값을 적는다.
- [ ] `scripts/pes.py`에 `hwpx` 하위 명령을 추가한다. `python3 scripts/pes.py hwpx --input <report.md> --output <report.hwpx> --images <dir>`로 어느 런타임에서도 호출 가능하게 한다.
- [ ] `skills/publish/SKILL.md`의 hwpx 절차를 "스킬 로드"가 아니라 이 로컬 명령 호출로 바꾼다. 스킬이 없거나 바이너리가 없을 때의 한계를 적는다.
- [ ] `record_hwpx_artifact()`로 기반 보고서 버전·변환기 버전·입력/이미지 hash·출력 hash·실행 시각을 남긴다. `report-uri.md`는 승인 원고와 다른 **파생본**으로 보존한다.
- [ ] 업로드 `ready`와 보고서 버전 등록을 구분한다. 변환 실패는 정식 산출물로 등록하지 않는다.
- [ ] 재실행은 같은 파일명 덮어쓰기가 아니라 보존/멱등 계약을 따른다.
- [ ] `tests/test_stage6_hwpx.py`와 `tests/fixtures/hwpx/`에 합성 한국어 보고서(표 3개 이상, 그림/이미지, 각주, 긴 제목, 출처 부록)를 넣고 zip/XML·이미지 참조·스타일·각주 번호를 자동 검사한다.
- [ ] 실패 경로(바이너리 없음, 깨진 md, 누락 이미지, 지원하지 않는 차트)를 시험하고, docx/PDF로 조용히 대체하지 않는다.
- [ ] Windows 한글에서 표 머리·그림·각주·쪽 나눔을 수동 확인하고, Mac은 가능한 범위에서 같은 파일을 연다.
- [ ] 증거를 **합성 자동 / Windows 수동 / 실자료 허용·미허용 / 도구 미설치·실패** 네 가지로 분리 기록한다.
- [ ] 사용자가 허용한 실제 보고서 사본 1개로 최종 확인하되, 저장소 밖에서만 다룬다.

**완료 기준**

- [ ] `python3 -m pytest -q tests/test_stage6_hwpx.py`
- [ ] `python3 -m pytest -q`
- [ ] `PES_HWPX_BIN=<합성 환경 경로> python3 scripts/pes.py hwpx --input tests/fixtures/hwpx/report.md --output /tmp/report.hwpx --images tests/fixtures/hwpx/images`
- [ ] 합성 보고서가 구조 검사를 통과하고, Windows 한글에서 표·그림·각주·긴 한글·쪽 나눔이 확인된다.
- [ ] 바이너리 없음·깨진 md·누락 이미지·미지원 차트에서 명시적 오류가 나고 산출물이 등록되지 않는다.
- [ ] 네 가지 증거가 분리 기록되고, 실자료 미허용을 자동 허용으로 간주하지 않는다.
- [ ] 영향받은 통합·보안·회귀 시험이 다시 통과하고, 사용자가 최종 승인한다.

**지킬 것**

- PES는 변환기를 다시 구현하지 않는다. 설치된 로컬 `hwpx-uri` 바이너리를 호출한다.
- 실패를 숨기지 않는다. docx/PDF 안내는 "HWPX 미완료"와 구분하고 조용한 대체 성공으로 표시하지 않는다.
- 실제 보고서 사본·경로·수신자·로그는 저장소 밖. 합성 자료만 커밋한다.
- 기반 보고서 버전·변환기 버전·hash 없는 hwpx를 정식 산출물로 등록하지 않는다.
