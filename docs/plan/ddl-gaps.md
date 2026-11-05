# DDL 누락 대조 — 2~6단계

- 기준 DDL: [schemas/stage-1-ddl-draft.sql](schemas/stage-1-ddl-draft.sql) (2026-11-05 현재 61개 표)
- 대조 대상: [stage-2.md](stage-2.md) ~ [stage-6.md](stage-6.md)의 표·열·상태 값 요구
- 작성: 2026-11-05, OpenCode. 계획서·DDL은 고치지 않았다. 실제 `~/pes-projects`·`~/.pes/`는 읽지 않았고, 공개 문서만 근거로 썼다.
- 판정: **33항목** — 추가·변경 필요 30(조건부 R1 포함)·확인 필요 1·기존 표로 해결 2. **2단계는 누락 0**이다.
- 표기: `3-R1`은 3단계 R1, `5-WEB8`은 5단계 WEB8, `6-E1`은 6단계 E1을 뜻한다. `제안`은 계획서에 열/표 이름이 확정되지 않아 구현 PR에서 이름을 정할 수 있는 항목이다.

| 단계 | 이슈 번호 | 표.열 | 이유 | 기존 표로 해결 가능한지 | 추가 마이그레이션 |
|---|---|---|---|---|---|
| 3 | 3-R1 | `projects.auto_resume_enabled`(제안) | 자동 재개는 프로젝트별 opt-in이고 기본 꺼짐이며 재시작 뒤에도 유지되어야 한다. 현재 `projects`에 프로젝트 단위 설정 열이 없다. | 불가. `editions.settings_json`은 판 단위라 프로젝트 opt-in을 담기 어렵다. | **3-R1(실시 시)** |
| 4 | 4-PR23 | `edition_carryovers` | 새 판 이월의 원본/대상 판·객체·버전, 유지/수정/제외, 이유, actor, tx를 항목별로 조회하고 중복 적용을 막아야 한다. `events`/JSON만으로는 항목별 유일성·조회 계약을 만들기 어렵다. | 불가. `version_relations`는 버전 관계만, `events`는 자유 payload라 이월 항목의 정규화된 키가 없다. | **4-PR23** |
| 4 | 4-PR23 | `editions.completed_snapshot_id` | 판 완료가 어느 스냅숏을 가리키는지 저장해야 하고, 완료 해제는 이 포인터만 해제해야 한다. 현재 `editions`에는 `base_snapshot_id`만 있다. | 불가. `snapshots.scope='edition'` 행은 있지만 "현재 완료 포인터"를 판에 고정하는 열이 없다. | **4-PR23** |
| 4 | 4-PR25 | `edit_permissions` | AI 직접 편집을 run·객체별로 허용/회수하고, `run_targets` 존재만으로 허용 증거로 삼지 않아야 한다. 현재 허용·회수 기록을 담을 표가 없다. | 불가. `run_targets`는 담당 범위이고, 4단계가 명시적으로 허용 증거로 쓰지 말라고 한 표다. | **4-PR25** |
| 4 | 4-U9 | `decision_bundles`·`decision_bundle_members`(제안) | 갈림길 방향 2~3개를 묶음 ID·기반 버전·후보 버전 목록으로 저장하고, 하나 채택/나머지 철회를 한 tx로 처리해야 한다. 현재 결정 표에는 묶음 개념이 없다. | **부분/확인 필요.** `mutation_commits.result_json`+`events`로 임시 표현은 가능하지만 후보 목록·중복 채택·묶음 조회의 정규화된 자리가 없다. 4-U9에서 먼저 기존 metadata/manifest 대체 가능성을 검토한다. | **4-U9(전용 표가 필요할 때)** |
| 5 | 5-WEB2 | `auth_sessions`(Better Auth 채택 표) | 세션 수명 14일/유휴 7일, 기기 목록, 전체 로그아웃, 로그인·권한 변경 시 회전을 저장해야 한다. 현재 `users`만으로는 세션을 표현할 수 없다. | 불가. `users.auth_subject`는 신원 매핑일 뿐 세션·기기 상태가 아니다. | **5-WEB2** |
| 5 | 5-WEB2 | `auth_accounts`(Better Auth 채택 표) | 매직링크·패스키·외부 인증 제공자와 PES `users`를 매핑해야 한다. | 불가. `users.auth_subject` 하나로 다중 인증 수단·제공자 계정을 표현할 수 없다. | **5-WEB2** |
| 5 | 5-WEB2 | `auth_passkeys`(Better Auth 채택 표) | 패스키 credential·공개키·서명 카운터·등록 시각을 저장해야 한다. | 불가. 현재 사용자 표에 패스키 필드가 없다. | **5-WEB2** |
| 5 | 5-WEB2 | `auth_verifications`(Better Auth 채택 표) | 매직링크·이메일 인증·초대 확인용 1회 토큰의 hash·purpose·만료·소비를 저장해야 한다. | 불가. `agent_tokens`는 에이전트 자격이고 사람 인증 토큰과 분리해야 한다. | **5-WEB2** |
| 5 | 5-WEB2 | `recovery_codes` | 가입 때 10개를 발급하고 1회 사용·재사용 거부·소진 상태를 남겨야 한다. | **부분.** `auth_verifications`에 purpose를 붙일 수 있으나, 10개 묶음·소진 상태를 별도로 관리하는 편이 안전하다. | **5-WEB2** |
| 5 | 5-WEB2 | `device_authorizations`·`device_tokens` | CLI `pes login`의 브라우저 기기 승인 코드와 30일 기기 토큰, 기기별 회수를 저장해야 한다. | 불가. `auth_sessions`는 브라우저 세션이고, 기기 승인·장기 토큰의 pending/승인/회수 상태를 담지 않는다. | **5-WEB2** |
| 5 | 5-WEB3 | `project_invites` | owner가 발급하는 7일 1회 초대, 역할(기본 reader), 수락/철회 상태를 저장해야 한다. | 불가. `project_members`는 수락 전 초대를 표현하지 못하고, 공개 링크를 만들지 않는 1회 토큰 자리도 없다. | **5-WEB3** |
| 5 | 5-WEB4 | `agent_tokens.label`·`token_prefix`·`last_used_at`·`last_used_ip`·`created_by_user_id`·`pepper_version` | 키 목록 표시, 마지막 사용, 발급자, pepper 버전·회전을 저장해야 한다. 현재는 `token_hash`·`revoked_at` 중심이다. | 불가. 기존 열만으로 표시·회전 메타를 만들 수 없다. nullable ADD COLUMN으로 충분하다. | **5-WEB4** |
| 5 | 5-WEB5 | `oauth_clients` | 원격 MCP OAuth의 client_id·redirect URI 허용 목록·metadata·등록 상태를 저장해야 한다. | **부분.** Workers OAuth Provider가 KV에 일부 저장할 수 있으나, PES의 허용 목록·감사·회수 계약을 D1에서 확인할 자리가 필요하다. | **5-WEB5** |
| 5 | 5-WEB5 | `oauth_consents` | 사용자·client·프로젝트 범위의 동의와 철회를 저장하고 "연결된 앱" 화면에 보여 줘야 한다. | 불가. 현재 동의·프로젝트 범위를 저장하는 표가 없다. | **5-WEB5** |
| 5 | 5-WEB5 | `oauth_tokens`(jti·회수) | 액세스/리프레시 토큰의 hash·jti·만료·회전·재사용 거부·회수를 D1에서 매 요청 검사해야 한다. | **부분.** Provider KV가 토큰을 보관하더라도, 5단계가 요구한 D1 jti 검사·즉시 회수 기록은 별도다. | **5-WEB5** |
| 5 | 5-WEB4 | `agent_devices` | 여러 프로젝트를 쓰는 CLI·B 에이전트의 기기 목록·마지막 확인·회수 표시를 위한 보조 표가 필요하다. 권한은 `agent_tokens`가 결정한다. | 불가. `agent_tokens`는 자격이고 기기 표시/회수 목록이 아니다. | **5-WEB4** |
| 5 | 5-WEB8 | `notification_outbox` | 업무 tx와 같은 tx에 알림 사건을 기록하고, dedupe key·상태·시도·unknown을 저장해야 한다. 시스템 경보는 `project_id`가 없을 수 있다. | 불가. `events`에는 발송 시도·영수증·unknown 상태가 없다. | **5-WEB8** |
| 5 | 5-WEB8 | `notification_endpoints` | 메일 주소·Web Push endpoint·VAPID key·기기/사용자·회수를 저장해야 한다. | 불가. 현재 사용자/기기 연락처 표가 없다. | **5-WEB8** |
| 5 | 5-WEB8 | `notification_preferences` | 사용자·프로젝트별 채널, 조용한 시간, 상세 제목 opt-in을 저장해야 한다. | 불가. `projects`/`users`에 알림 설정 자리가 없다. | **5-WEB8** |
| 5 | 5-WEB8 | `notification_deliveries` | 발송 시도별 provider 접수 ID·상태·오류·재시도·unknown을 저장해야 한다. | 불가. `notification_outbox`만으로 시도 이력을 남길 수 없다. | **5-WEB8** |
| 5 | 5-WEB9 | `import_tokens`(또는 1회 토큰 표) | owner가 발급하는 1시간·1회 import 토큰의 hash·만료·사용·프로젝트를 저장해야 한다. | 불가. `agent_tokens`는 에이전트 자격이고, 5단계는 agent key로 import할 수 없다고 정했다. | **5-WEB9** |
| 5 | 5-WEB9 | `projects.status='exported_readonly'`(또는 `projects.exported_readonly_at`) | 웹으로 옮긴 프로젝트의 로컬 DB가 읽기 전용 스냅숏임을 표시해야 한다. 현재 `projects.status` CHECK는 `staging`/`active`/`archived`뿐이고 `archived_at`은 의미가 다르다. | 불가. 기존 상태 값으로 "웹 이전 완료·로컬 읽기 전용"을 구분할 수 없다. | **5-WEB9** |
| 5 | 5-WEB2·WEB11 | `security_events`(제안) | 로그인·토큰·정책·백업·복구 같은 운영 감사를 프로젝트와 무관하게 남겨야 한다. | 불가. `events.project_id`가 `NOT NULL`이라 프로젝트 없는 로그인/전역 감사를 넣을 수 없다. | **5-WEB2(초기)·WEB11(확장)** |
| 6 | 6-E1 | `export_jobs` | 목적지·요청자·정확한 버전/manifest·payload hash·전송 전 상관키·상태·외부 ID/URL·시도 횟수를 저장해야 한다. | 불가. `outbound_dispatches`는 Go 정책 FK·run 전용이며, 6단계가 재사용을 금지했다. | **6-E1** |
| 6 | 6-E1 | `export_attempts` | 시도별 prepared/sending/sent/partial/failed/unknown, request/response hash, 외부 ID, 오류를 저장해야 한다. | 불가. `export_jobs`만으로 재시도·부분 생성·unknown 이력을 남길 수 없다. | **6-E1** |
| 6 | 6-M1 | `project_members.role='approver'` | 승인·reopen만 허용하는 새 역할 값이 필요하다. 현재 CHECK는 `owner`/`editor`/`reader`뿐이다. | 불가. `editor` 승인 금지·owner만 승인을 유지하면서 위임할 역할 값이 없다. | **6-M1** |
| 6 | 6-M1 | `projects.allow_member_external_agents`(제안) | owner가 프로젝트별로 멤버의 외부 AI 연결을 허용/불허하고 기본 불허를 저장해야 한다. | 불가. `projects`에 프로젝트 단위 외부 AI 설정 열이 없다. | **6-M1** |
| 6 | 6-M1 | `project_policy_versions.changed_by_user_id` FK 교체 | 현재 FK가 `projects(id, owner_user_id)`를 가리켜, owner를 바꾸면 과거 정책 행이 FK 위반이 된다. 과거 작성자를 보존해야 한다. | **기존 열은 있으나 제약이 막는다.** `users(id)` FK로 바꾸고 현재 owner 검사는 명령 서비스가 맡아야 한다. | **6-M1** |
| 6 | 6-M1 | `ownership_transfers`(선택) | 소유권 이전의 from/to·tx·시각을 별도 표로 조회할 수 있다. | **가능.** `events` payload(`owner.transferred`)+`mutation_commits`로 기록·조회할 수 있다. 전용 표는 감사 조회 편의를 위한 선택이다. | **없음(전용 표를 둘 때만 6-M1)** |
| 6 | 6-M1 | `question_assignments`(선택) | 질문 배정 변경의 from/to·tx·시각을 이력으로 조회할 수 있다. | **가능.** `questions.intended_actor_id` 현재값 + `events`(`question.assigned`) payload + `objects.rev`로 이력을 남길 수 있다. 전용 표는 조회 편의를 위한 선택이다. | **없음(전용 표를 둘 때만 6-M1)** |
| 6 | 6-M3 | `adoption_proposals` | child 제안의 부모/자식 run, 대상 객체, 기반/제안 버전, 제안 hash, pending/accepted/rejected/conflict 상태를 저장해야 한다. | 불가. `runs.parent_run_id`만으로 제안·채택 상태와 대상 버전을 표현할 수 없다. | **6-M3** |
| 6 | 6-M3 | `runs.parent_relation` | `parent_run_id`가 worker child·handoff·reviewer 중 무엇인지 구분해야 한다. | 불가. 현재 `parent_run_id` 하나로 관계 종류를 구분할 수 없다. | **6-M3** |

## 2단계 메모

2단계는 기존 DDL로 충족한다. `db_meta`, `import_batches`(staging/validated/activated/failed), `legacy_mappings`, `blobs`(staging/ready/quarantined), `version_files`, `runs`, `run_targets`, `project_leases`, `run_input_receipts`, `mutation_commits`, `events`, `outbound_dispatches`가 2단계 요구를 덮는다. 삭제 정책의 `alive`는 2단계가 "필요하면 새 마이그레이션"으로 둔 조건부이며, 현재는 `archived_at`으로 논리 보관을 표현할 수 있어 누락으로 세지 않았다.

## 3단계 메모

U1~U6은 "새 표 없음" 원칙대로 기존 표로 간다. **REF1은 `project_references`, MAT1은 `version_files` 확장·`file_ai_access_versions`·`file_extractions`로 예외다.** `needs_review`, `importance`/`required`, `allow_comment_as_answer`, `text_format_version`, `anchor_resolutions`, `artifact_versions.conflicts`, `reflection_entries`는 이미 DDL에 있다. 3단계에서 실제로 빠진 것은 R1의 프로젝트 단위 opt-in, REF1 참조 표, MAT1 파일 스위치·추출 표다.

## 4단계 메모

`edition_carryovers`·`editions.completed_snapshot_id`는 PR23이 명시한 신규 스키마다. `edit_permissions`는 PR25의 AI 직접 편집 opt-in/회수를 담을 표가 없어 필요하다. `decision_bundles`는 U9가 "기존 metadata·manifest로 표현 가능한지 먼저 검토"라고 했으므로 **확인 필요**로 두었다. `artifact_versions.conflicts`(JSON)·`review` kind·`decisions`·`events`는 반대 의견 기록에 재사용할 수 있어 새 표로 세지 않았다.
