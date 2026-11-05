# 2단계 구현 이슈 초안

- 입력: [stage-2.md](../stage-2.md)(Codex·Opus 검수 반영), [stage-1-db.md](../stage-1-db.md)·[stage-1-api.md](../stage-1-api.md)·[stage-1-ui.md](../stage-1-ui.md)·[stage-1-runners.md](../stage-1-runners.md), [stage-1-ddl-draft.sql](../schemas/stage-1-ddl-draft.sql)
- 상태: **초안 — Linear 등록 전**. 이 문서는 원고이며 Linear에 이슈를 만들지 않았다.
- 규칙: **이슈 하나 = PR 하나.** `stage-1-db.md:176-199`의 PR 번호를 기준으로 하되 **PR20을 20a(Claude Code·앱)·20b(Codex CLI·OpenCode TUI)·20c(Codex 앱·OpenCode 앱)로 나누고 PR26(TypeScript 단일화)을 더한다.** 2단계는 25개이며, 누적은 `roadmap.md` 2절 참고. 하위 이슈를 만들지 않고 각 PR은 자기 테스트를 포함한다.
- 테스트 명령: **0016 TypeScript 단일 언어 결정**에 따라 **새 코드·시험은 처음부터 TS 모듈/시험 계약**이다. 런타임·테스트 러너는 아직 미정이므로 아래 `결정 뒤 확정할 TS 테스트 명령`은 런타임 결정 뒤 실제 명령으로 바꾼다. 0.15 Python/pytest는 PR26이 이전·동결하는 기존 자산이며 새 코드에 쓰지 않는다.
- 공통 금지: 실제 `~/pes-projects`·`~/.pes/` 접근, 실키·기관 자료·실제 프로젝트 내용, `project.json`·DB 직접 쓰기(스킬·CLI 모두), 이 단계에서 플러그인 버전 올리기. 테스트 공통 기반은 **PR1에서 정할 TS fixture 헬퍼: `isolated_home`·`cli`·`synthetic_project` 대응**을 쓴다. Python `tests/conftest.py`는 PR26 이전 대상이다.
- **PR15·16 경계**: 0.15 Python CLI는 PR26 전까지 동결하고, 새 로직은 TS 코어에 둔다. Python이 TS 모듈을 직접 import하지 않고, CLI는 같은 명령 서비스를 호출하는 얇은 경계만 유지한다.
- **나열 순서 ≠ 실행 순서(PR26 → PR22)**: 이 문서의 PR22가 PR26보다 먼저 보여도 실제 실행은 PR26 다음 PR22다.
- **2단계 공통 인계(WEB0)**: **2단계 PR1 전에** 현재 언어 중립 JSON fixture와 최소 TS 시험 구현으로 5단계 WEB0를 실행해 TS 계약·플랫폼 후보 3군 결과를 기록하고, WEB1에 넘긴다. **PR14 완료는 WEB0의 필수 전제가 아니다.** WEB0는 5단계 16개에 포함되므로 새 이슈를 만들지 않는다.

## PR 1 — [2단계] 스키마 001 + SQLite 연결

- **목표**: 검증한 DDL **61표(현재 001 기준)**를 SQLite 마이그레이션으로 만들고, 임시 홈에서 안전하게 열고 닫는 DB 기반을 만든다.
- **할 일**:
  - [ ] `scripts/pes_core/__init__.ts`·`paths.ts`·`db.ts`·`ids.ts`·`clock.ts`를 만든다.
  - [ ] `paths.ts`: `pes_dir()`=`~/.pes`, `db_path()`=`~/.pes/pes.db`, `objects_dir()`=`~/.pes/objects`; `HOME`/`USERPROFILE` 기준. `PES_HOME`은 프로젝트 위치(루트)만 바꾸고 DB·객체 경로는 바꾸지 않는다.
  - [ ] `scripts/pes_core/migrations/001_initial.sql`: `docs/plan/schemas/stage-1-ddl-draft.sql`를 옮기고 `db_meta` 초기 행(`schema_version=1`, `database_instance_id`, `cursor_epoch=1`)을 넣는다. 트리거·FTS·ATTACH 없음.
  - [ ] `db.connect(path)`: `PRAGMA foreign_keys=ON`, `busy_timeout`, 짧은 트랜잭션, `WAL`은 로컬 한정. `db.migrate(conn)`은 `db_meta`를 읽고 001을 한 tx로 적용한다.
  - [ ] `ids.new_id(kind)`는 `uuid4().hex` 등 외부 의존 없는 ID. `clock.SystemClock`·`FakeClock`.
  - [ ] `tests/test_db_schema.test.ts`: 임시 `HOME`에서 **61표(현재 001 기준)**, FK 위반 거부, 대표 삽입, `json_valid`/`json_type`, `sqlite3.sqlite_version` 검사, 0행 rev 충돌 전체 롤백.
  - [ ] `tests/fixtures/schema_seed.ts`: users/actors/projects/editions/stages/rounds/objects 최소 합성 행.
  - [ ] **TS fixture 헬퍼**: `isolated_home`·`cli`·`synthetic_project`에 대응하는 TS 헬퍼의 이름·위치를 PR1에서 정하고, 이후 모든 PR이 같은 헬퍼를 쓴다. Python `tests/conftest.py`는 PR26 이전 대상이다.
- **선행**: SEL-11·SEL-17 완료, S0 6절 게이트. (없으면 착수 금지)
- **완료 기준**:
  - [ ] `결정 뒤 확정할 TS 테스트 명령 — tests/test_db_schema.test.ts` 통과.
  - [ ] 실제 `~/.pes`·`~/pes-projects` 미접촉(감사 훅), DDL **61표(현재 001 기준)**·FK·JSON 함수 확인.
  - [ ] bootstrap(프로젝트·owner·초기 정책·NULL 포인터)가 한 tx로 롤백 가능.
  - [ ] SQL이 보장하는 것(참조·중복·부분 UNIQUE)과 서비스가 보장하는 것(상태 전이·6단계·fence·불변 버전)을 문서에 구분.
- **지킬 것**: 3.5절은 표 자리만. 실제 홈·실자료 금지. D1과 같은 문법만 쓰고 트리거에 기대지 않는다.

## PR 2 — [2단계] D1 호환 smoke

- **목표**: 같은 마이그레이션과 대표 원자 명령이 로컬 D1에서도 성공·실패 의미가 같음을 증명한다.
- **할 일**:
  - [ ] `tests/d1/wrangler.toml`·`package.json`·`package-lock.json`: **D1 개발 도구 한정**으로 Node LTS·wrangler 버전을 고정하고 로컬 D1 바인딩을 둔다. 로컬 런타임 선택은 0016 시험 뒤 정한다.
  - [ ] `scripts/pes_core/d1_smoke.ts`: `001_initial.sql` 적용, batch 명령, 대표 SELECT/INSERT/UPDATE, 0행 실패.
  - [ ] `tests/test_d1_smoke.test.ts`: batch 원자성, deferred FK, 부분 인덱스, `json_valid`/`json_type`, 0행 실패, 뒤늦은 실패 전체 롤백.
  - [ ] `docs/plan/decisions/<미사용 번호>-d1-compat.md`: SQLite와 D1의 차이·실행 제한·재검토 조건. 기존 0002~0004와 예약 0006을 재사용하지 않고, 등록 시 `decisions/README.md` 색인에서 빈 번호를 확인한다.
  - [ ] CI job `d1-smoke`: 마이그레이션·DB 어댑터 변경 PR과 `main`에서 필수. 사용자 설치를 요구하지 않는다.
- **선행**: PR 1.
- **완료 기준**:
  - [ ] `결정 뒤 확정할 TS 테스트 명령 — tests/test_d1_smoke.test.ts` 통과(로컬 도구 없으면 명확한 skip, CI에서는 필수).
  - [ ] `wrangler d1 execute --local`로 같은 001과 대표 성공·실패 통과.
  - [ ] 운영 D1·Cloudflare 계정 미접촉, 차이 문서화.
- **지킬 것**: 로컬 D1만. Node/wrangler는 개발 전용. 0행을 성공으로 흘리지 않는다.

## PR 3 — [2단계] 새 형식 백업·export/import

- **목표**: DB·객체·manifest·hash를 한 묶음으로 내보내고, 한 프로젝트만 다른 DB로 복원할 수 있게 한다.
- **할 일**:
  - [ ] `scripts/pes_core/backup.ts`: `export_project(conn, project_id, dest)`, `verify_bundle(path)`, `import_bundle(path, staging_db)`.
  - [ ] `manifest.json` 스키마: `format_version`, `database_instance_id`, `cursor_epoch`, `project_id`, `files[{path,sha256,size}]`, 표별 개수.
  - [ ] `db_meta` 커서 무효화: import 시 새 `database_instance_id` 또는 `cursor_epoch` 증가.
  - [ ] 파일은 불투명 복사; `ready`·고아 규칙은 PR9·12에 맡긴다.
  - [ ] `tests/test_backup_export.test.ts`: 프로젝트 2개 중 1개 export→fresh DB import, 다른 프로젝트·전역 설정 무영향, 손상 hash·누락 파일 보고.
- **선행**: PR 1. **PR3는 export/import 골격 자체 시험을 갖고, 전체 복원 검증만 PR4·9·10 뒤 PR12와 통합한다.**
- **완료 기준**:
  - [ ] `결정 뒤 확정할 TS 테스트 명령 — tests/test_backup_export.test.ts` 통과.
  - [ ] 한 프로젝트 복원이 다른 프로젝트를 바꾸지 않음, 복원 뒤 epoch로 옛 커서 거부.
  - [ ] 손상·누락·미지 파일을 조용히 버리지 않고 보고.
- **지킬 것**: 실행 중 DB 동기화 금지. 실제 자료는 테스트에 넣지 않는다. 백업이 PES 홈·OneDrive 안이면 거부하는 검사는 PR12/22에서 완성.

## PR 4 — [2단계] 변경 명령 서비스

- **목표**: 모든 업무 쓰기를 하나의 닫힌 명령 서비스로 모아 rev·멱등·사건·영수증을 같은 tx에 남긴다.
- **할 일**:
  - [ ] `scripts/pes_core/errors.ts`: `ApiError(code, message, retryable, target, details, next_action)`, `error_envelope()`.
  - [ ] `scripts/pes_core/commands.ts`: `CommandService.execute(name, payload, ctx)`, 닫힌 `COMMANDS` 레지스트리, `MutationContext(actor, via, idempotency_key, base_control_rev, lease_id, fence)`.
  - [ ] 순서: 인증·권한·**현재 정책·목적지 검사** → `mutation_commits` 영수증 재생 → rev/lease 검사 → 변경 → `events`·영수증 같은 tx. 0행 CAS는 실패, 전부 롤백.
  - [ ] PR4는 정책 검사 인터페이스(예: `PolicyChecker`)를 정의하고, PR10이 구현을 주입한다. PR4 단독 시험은 가짜 정책 검사기로 하고, 실제 정책 연결은 PR10에서 검증한다. **OFF 전 완료한 요청을 OFF 후 같은 키로 재요청해도 금지된 결과·전송 경로가 재생되지 않아야 한다.**
  - [ ] `mutation_commits`의 `request_hash`, `action`, `result_json`; `events`의 `tx_id/tx_index/tx_size`; `counters.next_no`; actor/via는 서버가 확정.
  - [ ] `tests/fixtures/contracts/commands/*.json`: 언어 중립 요청·응답·오류 예제.
  - [ ] `tests/test_command_service.test.ts`: 같은 키 같은 요청 재생, 같은 키 다른 요청 거부, 0행/늦은 실패 롤백, 모든 변경에 사건·영수증, system/채택 actor 정합성, **정책 검사→영수증 재생 순서와 OFF 전/후 같은 키 재생 거부**.
- **선행**: PR 1.
- **완료 기준**:
  - [ ] `결정 뒤 확정할 TS 테스트 명령 — tests/test_command_service.test.ts` 통과.
  - [ ] 영수증 장기 보존(큰 응답만 정리) 계약이 테스트에 있음.
  - [ ] 정책·목적지 검사가 영수증 재생보다 앞서고, OFF 전 완료 요청의 재생이 금지된다.
  - [ ] 서비스 밖에서 업무 표를 직접 쓰는 코드 0.
  - [ ] WEB0(PR1 전 실행) 결과의 TS 계약·플랫폼 판정을 입력으로 받아 반영한다.
- **지킬 것**: 표 CRUD·임의 ops 없음. SQLite/D1 같은 실패 의미. 영수증 재생을 권한·정책 검사 뒤에 둔다.

## PR 5 — [2단계] run·lease·fence

- **목표**: claim·heartbeat·wait·complete·인계를 원자적으로 만들고, 질문 대기 중 lease를 놓게 한다.
- **할 일**:
  - [ ] `scripts/pes_core/runs.ts`: `claim`, `heartbeat`, `wait`, `complete`, `release`, `handoff`, `interrupt`, `record_receipt`.
  - [ ] `project_leases`: 프로젝트당 활성 lease 하나, fence 증가, 만료 부활 금지; `runs.status` 전이.
  - [ ] `wait`: `waiting_human`+lease 해제+`events`+영수증을 한 tx. `seen/ignored/applied` 구분, `applied`는 `applied_tx_id` 필수.
  - [ ] `scripts/pes_core/config.ts`: TTL·heartbeat·무진행·중단 유예를 환경/설정으로. 기본값은 **비확정**, SEL-18·19 뒤 `docs/plan/decisions/`에서 확정.
  - [ ] `tests/test_runs_leases.test.ts`: 가상 시계 만료, 옛 fence 거부, 대기 중 해제/재획득, 인계 뒤 같은 입력 중복 반영 방지.
- **선행**: PR 4.
- **완료 기준**:
  - [ ] `결정 뒤 확정할 TS 테스트 명령 — tests/test_runs_leases.test.ts` 통과.
  - [ ] 만료 lease 부활 0, `applied` 증거 없는 성공 0, 인계 뒤 중복 반영 0.
  - [ ] TTL 기본값이 코드에 하드코딩되지 않음.
- **지킬 것**: `complete`는 run 종료일 뿐 승인 아님. 사람 답·첨언을 lease로 막지 않는다. 자동 재개 없음.

## PR 6 — [2단계] 판·단계·라운드 명령

- **목표**: 봉인·승인·reopen·stale·carry_over·snapshot을 1판 흐름 그대로 구현한다.
- **할 일**:
  - [ ] `scripts/pes_core/editions.ts`: `create_edition`, `start_round`, `seal_round`, `approve_stage`, `reopen_stage`, `release_completion`, `carry_over`, `snapshot`.
  - [ ] `snapshots`·`round_contents`·`approvals`·`stages.stale_since_event_seq`·`rounds.state`를 서비스가 검증.
  - [ ] reopen 뒤 실행 기반 무효화(`base_control_rev`·`run_targets`), `complete_run`≠`approve_stage`, 승인 snapshot/manifest.
  - [ ] carry_over를 두 갈래로 분리한다. **(a) 조사 주제 파생**은 기획 `artifacts`(kind='topic')의 정확한 버전에서 조사 `artifacts`(kind='topic')를 만들고 `origin_version_id`·`version_relations`로 연결한다. **(b) 단계 미완료 작업 이월**은 어느 단계든 승인 때 남은 QA 지적·할 일의 `item/title/request/from`을 `followups`·`followup_versions(kind='next_round_task', target_stage_id, target_round_id)`에 원 요청·대상·출처·버전과 함께 보존하고 다음 단계 R1에서 조회한다. 4단계 판 비교·이월 마법사는 만들지 않는다.
  - [ ] `tests/test_editions_stages.test.ts`: 합성 6단계, reopen 뒤 stale·승인 유지, 승인 snapshot, complete≠approve, **승인 전 봉인 성공·허가된 에이전트 봉인 성공·에이전트 단계 승인 거부**, **여러 단계의 남은 QA 지적이 승인·이전 뒤에도 남고 다음 R1에 보임**.
- **선행**: PR 4·5·9.
- **완료 기준**:
  - [ ] `결정 뒤 확정할 TS 테스트 명령 — tests/test_editions_stages.test.ts` 통과.
  - [ ] 활성 판 하나, **정확한 스냅샷/manifest 없는 봉인 0**, reopen 뒤 옛 run 채택 거부. 승인 전 봉인과 허가된 에이전트 봉인은 성공하고, 에이전트 단계 승인은 거부된다.
  - [ ] snapshot/manifest가 정확한 버전을 가리키며 complete·seal·approve가 별개다. 미완료 QA 지적·할 일이 승인·이전 뒤에도 보존되고 다음 R1에 조회된다.
- **지킬 것**: 1판 흐름 보존. 4단계 판 기능을 앞당기지 않는다. 승인은 사람만(PR10/14와 공동). 봉인은 승인과 별개다.

## PR 7 — [2단계] 항목·버전·출처·연결

- **목표**: 항목·보고서·출처를 불변 버전으로 쌓고, 각주·연결·library를 보존한다.
- **할 일**:
  - [ ] `scripts/pes_core/content.ts`: `create_object`, `append_version`, `set_current`, `add_artifact`, `add_source`, `add_citation`, `link_relation`, `import_library`.
  - [ ] 표: `objects`, `object_versions`, `artifacts`, `artifact_versions`, `artifact_components`, `version_relations`, `sources`, `source_versions`, `citations`.
  - [ ] 출처: `retrieved_at`·`method`·`verification_state`·`quote`·`evidence_blob_id`; 못 읽은 자료는 발췌 금지. 같은 URL도 다른 자료로 둔다.
  - [ ] `library.json`을 항목·출처로 옮기고 원본도 보존. QA·verify·`links`를 버전에 연결.
  - [ ] `tests/test_content_sources.test.ts`: 버전 불변·현재 포인터, 각주 순서, 같은 URL 다른 자료, 옛 연결 유지, library 이전.
- **선행**: PR 4.
- **완료 기준**:
  - [ ] `결정 뒤 확정할 TS 테스트 명령 — tests/test_content_sources.test.ts` 통과.
  - [ ] 과거 버전 UPDATE/DELETE 경로 0, 현재 포인터는 자기 버전만.
  - [ ] 출처 확인 시점·발췌·위치·방법/판정이 저장됨.
- **지킬 것**: URL만으로 합치지 않음. 본문 덮어쓰기 없음. 참조 파일 저장은 PR9/11 경계.

## PR 8 — [2단계] 질문·답

- **목표**: 사람이 실제로 본 질문/폼 버전과 답·의견을 원자적으로 보존한다.
- **할 일**:
  - [ ] `scripts/pes_core/questions.ts`: `publish_set`, `revise_question`, `submit_answers`, `validate_submission`, `resume_ready`.
  - [ ] 표: `question_sets`, `question_set_members`, `questions`, `question_versions`, `submissions`, `answers`, `answer_versions`; `__other`는 `threads`/`messages` 최소 행으로.
  - [ ] `allow_comment_as_answer`, `show_if`, `required`, `default_value`; 기본값·추천을 자동 답으로 채우지 않음. 묶음 제출 전체 원자성.
  - [ ] 새 질문 버전은 옛 답을 승계하지 않고 `재확인 필요`; 조건부 필수·명시적 미루기·자유 의견.
  - [ ] `tests/test_questions_answers.test.ts`: 폼/질문 버전 고정, 옛 답 보존, 덧붙임만 응답 인정, 중복 제출 방지, 충돌 시 부분 접수 0.
- **선행**: PR 4·6.
- **완료 기준**:
  - [ ] `결정 뒤 확정할 TS 테스트 명령 — tests/test_questions_answers.test.ts` 통과.
  - [ ] `__other`가 답 선택을 추천 동의로 바꾸지 않음, `allow_comment_as_answer=0`이면 의견만으로 필수 충족 안 됨.
  - [ ] 재개 준비 검사는 PR5/14와 같은 함수·계약을 쓴다.
- **지킬 것**: 서버 답 초안 API 없음. U2의 새 의견 기능(3단계)과 최소 thread를 구분. 답은 그때 본 질문 버전에 묶는다.

## PR 9 — [2단계] 결과물·객체 저장

- **목표**: 파일을 hash·ready로 채택하고, 보고서가 정확한 버전을 참조하게 한다.
- **할 일**:
  - [ ] `scripts/pes_core/files.ts`: `reserve_upload`, `store_blob`, `complete_upload`, `get_blob`, `gc_orphans`, `assert_project_access`.
  - [ ] 표: `blobs`, `version_files`; `storage_key`·`sha256`·`size`·`media_type`·`state(staging/ready/quarantined)`.
  - [ ] staging→hash→ready, 손상 hash 거부, 같은 바이트 중복 저장 방지(계보 유지), 고아·격리 정리.
  - [ ] `artifact_versions.body_blob_id`, `snapshots.manifest_blob_id`, `artifact_components`로 보고서 정확한 버전 참조.
  - [ ] `tests/test_blobs.test.ts`: hash 불일치, 다른 프로젝트 접근 차단, 고아 정리, 중복 바이트, ready 채택.
- **선행**: PR 1·4·7.
- **완료 기준**:
  - [ ] `결정 뒤 확정할 TS 테스트 명령 — tests/test_blobs.test.ts` 통과.
  - [ ] 경로·서명 URL을 ID로 쓰지 않음, 손상 파일 ready 0, 다른 프로젝트 blob 접근 0.
  - [ ] 채택·저장·공유·인쇄 버전이 모두 보존됨.
- **지킬 것**: 실제 객체 폴더 접근 금지(테스트는 임시 HOME). Go 파일 읽기 프록시는 PR10/19 경계.

## PR 10 — [2단계] 행위자·토큰·전송 정책

- **목표**: 실제 actor·프로젝트 토큰·Go ON/OFF 정책을 서버가 확정하고 감사한다.
- **할 일**:
  - [ ] `scripts/pes_core/actors.ts`: `resolve_actor`, `require_human_owner`, `issue_agent_token`, `verify_agent_token`, `revoke_agent_token`.
  - [ ] `scripts/pes_core/policy.ts`: `current_policy`, `set_policy`, `check_go_allowed`, `prepare_dispatch`, `authorize_dispatch`, `mark_sent`, `block_dispatch`.
  - [ ] 표: `actors`, `agent_tokens`, `project_policy_versions`, `outbound_dispatches`; 토큰은 해시·범위·30일·회수, 원문 1회 표시.
  - [ ] 기본 ON 표시, 정책 손상 시 차단, 합성 자료도 우회 금지, OFF 뒤 prepared 차단·authorized 미송신만 차단, in-flight 취소/unknown·sent 이력.
  - [ ] 소유자 세션·CSRF 귀속, 사람만 정책 변경·재허용, 재허용 뒤 자동 재시작 없음, 옛 lease 채택 차단.
  - [ ] `tests/test_actors_policy.test.ts`: 토큰 범위·회수, 정책 변경 사람만, OFF 차단, unknown 예약, 옛 lease 거부, **정책 검사→영수증 재생 순서와 OFF 전 완료 요청의 재생 차단**.
- **선행**: PR 1·4.
- **완료 기준**:
  - [ ] `결정 뒤 확정할 TS 테스트 명령 — tests/test_actors_policy.test.ts` 통과.
  - [ ] 에이전트가 승인·reopen·정책·토큰·삭제 불가; 토큰 원문이 로그·DB에 0.
  - [ ] `outbound_dispatches` 상태 전이와 감사 사건이 남음.
- **지킬 것**: 실제 Go 네트워크 호출 없음(합성·가짜 transport). 정책 기본값은 stage-0 7-1 그대로. 모르는 비용을 0으로 표시하지 않는다.

## PR 11 — [2단계] legacy importer

- **목표**: 기존 `project.json`·부속 파일을 staging DB로 손실 없이 옮기고 매핑을 남긴다.
- **할 일**:
  - [ ] `scripts/pes_core/legacy.ts`: `scan_project`, `import_project`, `map_legacy`, `report_unknown`.
  - [ ] 입력: `project.json`, `library.json`, `feedback/`, `feedback.log`, `snapshots/`, `reports/`, `out/`, `shots/`, `ask/`, `rounds/`, `library/`.
  - [ ] 표: `import_batches`(state=staging), `legacy_mappings`; 옛 승인은 `legacy_unknown` actor·사용자 NULL·`legacy_unverified`.
  - [ ] 그때 본 질문/폼 버전, `__other`/자유 의견, 미처리 답, 새 정책 기본값을 과거 동의로 기록하지 않음.
  - [ ] 옛 단계 `carry_over`를 `followups`·`followup_versions(kind='next_round_task')`로 옮겨 `item/title/request/from`과 원 요청·대상·출처·버전을 보존하고, `migration-map.md:90`과 맞춘다. 조사 주제 파생과 미완료 작업 이월을 섞지 않는다.
  - [ ] `tests/test_legacy_import.test.ts`: `synthetic_project("broken")`·`"large"`·완전 합성, 재실행 멱등, 원본 hash 불변, 미지 필드 보고, **여러 단계의 남은 carry_over가 다음 R1 후속으로 보존**.
- **선행**: PR 1·6·7·8·9·10, SEL-17.
- **완료 기준**:
  - [ ] `결정 뒤 확정할 TS 테스트 명령 — tests/test_legacy_import.test.ts` 통과.
  - [ ] 깨진/2MB fixture에서 원본 무변경, 재실행 중복 0.
  - [ ] 옛 carry_over가 `next_round_task`로 보존되고 다음 R1에서 조회된다. `migration-map.md:90`과 일치한다.
  - [ ] 실제 manifest·경로·이전 보고서는 로컬에만; PR 산출물은 합성·익명.
- **지킬 것**: 실제 `~/pes-projects` 읽기 금지. 기본값 보완을 과거 결정처럼 꾸미지 않는다. 원본 삭제 금지.

## PR 12 — [2단계] 이전 검증·되돌리기

- **목표**: 사본→staging→검증→활성화와 쓰기 전/후 복구를 합성 fixture로 증명한다.
- **할 일**:
  - [ ] `scripts/pes_core/migration.ts`: `validate_import`, `activate_import`, `rollback_before_write`, `restore_project`.
  - [ ] 검증: 개수·본문·ID·연결·파일 hash·미처리 답·보고서 재생성. `import_batches.state` 전이.
  - [ ] 쓰기 전: staging 행 버리고 원본 JSON 재연결. 쓰기 후: 프로젝트 단위 DB+객체 복구, 손실 범위·커서 초기화 고지.
  - [ ] `tests/test_migration_restore.test.ts`: 프로젝트 2개, 하나만 활성화·복구, 다른 프로젝트 무영향, 복원 손실 범위.
- **선행**: PR 3·9·11.
- **완료 기준**:
  - [ ] `결정 뒤 확정할 TS 테스트 명령 — tests/test_migration_restore.test.ts` 통과.
  - [ ] 원본 무변경, 쓰기 전/후 복구 구분, 복원 뒤 옛 커서 거부.
  - [ ] 실제 파일럿은 PR22로 분리; 합성 실패를 실제 실패로 보지 않음.
- **지킬 것**: 실제 프로젝트 이전 금지(PR22 사용자 허용 전). 여러 프로젝트 DB 전체 되감기를 기본으로 하지 않는다.

## PR 13 — [2단계] API: 맥락·claim·submit·complete

- **목표**: 한 run의 최소 경로 `context→claim→submit→complete`를 HTTP/JSON 계약으로 만든다.
- **할 일**:
  - [ ] `scripts/pes_core/api.ts`: `ApiApp`, 라우트 `GET /api/v1/capabilities`(**PR13이 라우트를 열고 PR14가 완성 시험**), `GET /api/v1/projects/{id}/context`, `POST /api/v1/projects/{id}/runs`, `POST /api/v1/projects/{id}/claims`, `POST /api/v1/projects/{id}/runs/{r}/wait`, `POST /api/v1/projects/{id}/runs/{r}/results`, `POST /api/v1/projects/{id}/runs/{r}/complete`.
  - [ ] **파일 HTTP는 PR13이 맡는다**: `POST P/uploads`(예약) → `PUT P/uploads/{u}` → `POST P/uploads/{u}/complete`(ready), `GET P/files/{b}/content`(Go OFF 정책 검사 읽기). 저장 코어는 PR9다.
  - [ ] **project.create bootstrap**: `POST /api/v1/projects`가 owner·초기 정책·첫 판을 한 tx로 만들고, 중복 slug·멱등 키·재생을 검사한다. 일반 에이전트 토큰은 owner 생성·정책 변경을 할 수 없다.
  - [ ] **2단계 HTTP 담당표**를 OpenAPI에 반영한다: `POST P/runs`(H, HTTP PR13, 코어 PR6, `test_api_runs`), `POST P/claims`(E, HTTP PR13, 코어 PR5, `test_api_claim`), `POST P/runs/{r}/wait`(E, HTTP PR13, 코어 PR5, `test_api_wait`), `POST P/runs/{r}/results`(E, HTTP PR13, 코어 PR5, `test_api_results`), `POST P/runs/{r}/complete`(E, HTTP PR13, 코어 PR5, `test_api_complete`), `GET P/objects/{o}/versions/{v}`(H/E/W, PR7, `test_api_version`), `GET P/runs/{r}/inputs`·`POST P/runs/{r}/input-receipts`(E, PR5/14, `test_api_inputs`), `POST P/uploads`→`PUT P/uploads/{u}`→`POST P/uploads/{u}/complete`·`GET P/files/{b}/content`(H/E, **PR13**, `test_api_files_policy`), `POST P/stages/{s}/rounds`·`POST P/rounds/{r}/seal`(H/E, PR6/14, `test_api_rounds`), `POST P/policies/opencode-go/revisions`(H, PR10/14, `test_api_policy`), `POST P/runs/{r}/handoffs`(H/E, PR5/14, `test_api_handoff`), `POST P/runs/{r}/release`(E/H, PR14, `test_api_release`), `GET P/operations/{id}`·`GET P/requests/{key}`(E/H, PR14, `test_api_operation`), `GET P/changes`(H/E/W, PR14, `test_api_changes`). **3단계 U5는 이 run_start를 새로 만들지 않고 재사용한다.** **HTTP 노출/코어 명령 분리**: run·claim·wait·results·complete는 HTTP PR13/코어 PR5·6, 파일 HTTP는 PR13/저장 코어 PR9, 라운드·정책·질문·답은 HTTP PR14/코어 PR6·8·10이다.
  - [ ] `scripts/serve.py`: `/api/v1`를 정적 서빙보다 먼저, loopback·Origin·소유자 세션·CSRF, Bearer 토큰.
  - [ ] 봉투 `format_version:"1.0"`, 오류 코드, `Idempotency-Key`, 10진 문자열 rev/fence/event_seq, 모르는 필드 거부.
  - [ ] context digest+manifest, claim=run 전이+lease 원자, submit 작은 묶음, long-poll이 tx를 잡지 않음, `complete`≠승인.
  - [ ] `docs/api/openapi-v1.yaml`, `tests/fixtures/contracts/api/*.json`, `tests/test_api_context.test.ts`.
- **선행**: PR 4·5·6·7·9·10.
- **완료 기준**:
  - [ ] `결정 뒤 확정할 TS 테스트 명령 — tests/test_api_context.test.ts` 통과.
  - [ ] rev 충돌 부분 저장 0, 토큰 범위 위반 403, `policy_blocked` 자동 재시도 금지, **OFF 전 완료 요청을 OFF 후 같은 키로 재요청해도 재생되지 않음**.
  - [ ] 한 run 최소 경로가 OpenAPI 예제와 일치. 한 라운드 전체는 PR14와 함께.
  - [ ] A/B HTTP 왕복(run 시작→claim→wait→답→재개)과 파일 ready·Go OFF 읽기 차단이 `test_api_files_policy`에 포함된다.
  - [ ] `project.create`가 owner·초기 정책·첫 판을 한 tx로 만들고 중복 slug·멱등·재생을 시험한다(`test_api_project_create`).
  - [ ] API fixture를 TS 계약 시험에 넣는다.
- **지킬 것**: 표 CRUD·임의 ops 없음. 에이전트가 승인·reopen 불가. 응답의 선택 필드 추가만 허용.

## PR 14 — [2단계] API: 질문·답·변경분·오류

- **목표**: 질문 게시·수정, 답 제출, 변경분 커서, 사람 전용 승인·reopen, 오류 봉투를 완성한다.
- **할 일**:
  - [ ] `scripts/pes_core/api.ts`에 `P = /api/v1/projects/{id}` 기준으로 `POST P/questions`, `POST P/questions/{q}/revisions`, `POST P/submissions`, `GET P/changes?cursor=`, `POST P/stages/{s}/approve`, `POST P/stages/{s}/reopen`을 추가한다. **PR13의 2단계 HTTP 담당표**를 그대로 따르고, 여기서 새 명령 이름을 만들지 않는다.
  - [ ] **capabilities 완성 시험**(PR13 라우트, PR14가 미지원·가짜 성공 없음 검사), `GET P/runs/{r}/inputs?wait_ms=`, `POST P/runs/{r}/input-receipts`, `P/runs/{r}/heartbeat`·`/release`·`/interrupt`·`/cancel`·`/handoffs`, `GET P/operations/{id}`·`GET P/requests/{key}`, 202 operation 조회.
  - [ ] **project.register API**: `POST /api/v1/project-registrations`가 project token 없는 B 최초 등록을 **사람의 기기 승인/제한 등록 자격**으로 처리한다. 중복·재생을 거부하고, 일반 에이전트 토큰에 owner 생성·정책 변경 권한을 주지 않는다. **PR14는 API를 만들고, PR20a가 빈 계정/새 프로젝트에서 쓰는 종단 시험을 맡는다.**
  - [ ] 사람 세션과 에이전트 토큰 구분; 승인·reopen은 소유자 사람만. 커서 epoch 재동기화, 공개 tx 단위, 숨긴 사건 스캔.
  - [ ] 요청 제한·poll 최소 간격·429 Retry-After, 서버 답 초안 없음, 가짜 성공 없음.
  - [ ] `tests/test_api_questions.test.ts`: 사람/에이전트 구분, 승인 거부, 커서 무효, long-poll, 202 조회.
- **선행**: PR 6·8·10·13.
- **완료 기준**:
  - [ ] `결정 뒤 확정할 TS 테스트 명령 — tests/test_api_questions.test.ts` 통과.
  - [ ] 한 라운드 `context→...→wait→답→재개`가 PR13+14 합동 시험으로 통과.
  - [ ] `project.register`가 project token 없는 B 최초 등록을 기기 승인으로 처리하고 중복·재생·빈 계정 시험을 통과한다(`test_api_project_register`).
  - [ ] WEB0는 **PR1 전**에 현재 JSON fixture로 실행하며, PR4·13·14 완료는 전제가 아니다.
  - [ ] 승인·reopen 에이전트 403, 커서 무효에도 미제출 답 보존(화면은 PR18).
- **지킬 것**: 사람만 승인·reopen. WebMCP·에이전트 토큰에 승인 도구 없음. `202`는 영속 접수만 뜻한다.

## PR 15 — [2단계] CLI 쓰기 전환

- **목표**: 기존 쓰기 명령을 모두 명령 서비스로 바꾸고, `context/claim/submit/wait/complete` CLI를 붙인다.
- **할 일**:
  - [ ] 0.15 Python CLI가 TS 코어를 직접 import하지 않도록, 같은 명령 서비스를 호출하는 얇은 경계(프로세스/HTTP/JSON)로 바꾼다. `cmd_init`, `cmd_ask_prep`, `cmd_ask`, `cmd_round_start`, `cmd_merge`, `cmd_render`, `cmd_approve`, `cmd_reopen`, `cmd_mark`, `cmd_chat`, `cmd_note`, `cmd_qa_brief`, `cmd_qa`, `cmd_remote`, `cmd_serve`, `cmd_stop`, `cmd_home`, `cmd_lock`, `cmd_unlock`을 서비스 경유로 바꾼다.
  - [ ] `cmd_context`, `cmd_claim`, `cmd_submit`, `cmd_wait`, `cmd_complete` 추가; 기존 `CMDS` 32개 배정표(`stage-2.md` 4.3) 전수 + 신규 5개를 등록한다.
  - [ ] `cmd_home`: 프로젝트 폴더만 이동, DB·객체는 `~/.pes`에 그대로 출력. `cmd_lock`/`unlock`은 DB lease와 정합.
  - [ ] `tests/test_cli_write.test.ts`: 기존 명령 의미 보존(합성), 직접 JSON 쓰기 0, 잠금 인계, `home` DB 미이동.
- **선행**: PR 4·5·6·7·8·9·10.
- **완료 기준**:
  - [ ] `결정 뒤 확정할 TS 테스트 명령 — tests/test_cli_write.test.ts` 통과.
  - [ ] 기존 `CMDS` 32개(쓰기 19·읽기 13) 중 쓰기 19개와 신규 5개가 모두 서비스 경유; 승인·권한 우회 동작 미승계.
  - [ ] `pes home`이 DB·객체를 옮기지 않음, 실제 홈 미접촉.
- **지킬 것**: `project.json` 직접 쓰기 0. 플러그인 버전 올리지 않음. legacy 읽기는 PR16 경계.

## PR 16 — [2단계] CLI 읽기·보고서·doctor

- **목표**: 읽기·보고서·진단을 DB에서 다시 만들고, 미전환 프로젝트는 읽기 전용 legacy로 제공한다.
- **할 일**:
  - [ ] `scripts/pes.py`: `cmd_status`, `cmd_pending`, `cmd_digest`, `cmd_show`, `cmd_list`, `cmd_hub`, `cmd_open`, `cmd_which`, `cmd_doctor`, `cmd_watch`, `cmd_assemble`, `cmd_report`, `cmd_web`을 DB/서비스로.
  - [ ] `cmd_report`는 `scripts/pes_core/files.ts`·`content.ts` 경계로 정확한 버전·각주를 참조; `assemble`/`web`도 같은 버전.
  - [ ] `cmd_doctor`: 기본 진단과 `--fix` 분리, 임시 HOME만, 소유 프로세스·포트·경로 quoting. `cmd_watch`는 같은 출력 형식 또는 입력 long-poll.
  - [ ] 미전환 프로젝트: `project.json` 읽기 전용 `status`/`list`/기존 화면, 쓰기는 이전 안내.
  - [ ] `tests/test_cli_read.test.ts`: 보고서 재생성, doctor 격리, legacy 읽기, `watch` 형식.
- **선행**: PR 7·9·15.
- **완료 기준**:
  - [ ] `결정 뒤 확정할 TS 테스트 명령 — tests/test_cli_read.test.ts` 통과.
  - [ ] 보고서가 정확한 버전·각주로 재생성되고, doctor가 실제 홈을 건드리지 않음.
  - [ ] `report/assemble/web`의 쓰기가 PR9 경계를 지남.
- **지킬 것**: 실제 홈 미접촉. legacy는 읽기만. 보고서 덮어쓰기 대신 새 버전.

## PR 17 — [2단계] 스킬 직접 편집 제거

- **목표**: 스킬·에이전트 지침에서 PES 업무 상태 직접 쓰기를 없애고, 중립 워크플로·어댑터 노트로 바꾼다.
- **할 일**:
  - [ ] `skills/core/SKILL.md:62-84`의 `project.json` Python 직접 편집 예제를 제거하고 `pes context/submit/ask/...`로 바꾼다.
  - [ ] core+plan 파일럿 후 `skills/{research,analyze,write,verify,publish}/SKILL.md`, `agents/*.md`, `commands/*.md`를 중립 명령으로 바꾼다.
  - [ ] `scripts/lint_skills.ts`: 업무 상태를 직접 바꾸는 경로(`project.json` 쓰기, `sqlite3` 업무 표 쓰기, 파일 잠금 직접 조작)만 금지. 자식 제안 파일·합성 테스트·신뢰 서비스 SQL은 허용.
  - [ ] `docs/adapters/opencode.md`·`claude-code.md`·`claude-app.md`에 어댑터 노트(진입·도구·권한·세션·모델·한계).
  - [ ] `tests/test_skill_lint.test.ts`; core+plan 합성 1회. reviewer 독립 판단 유지.
- **선행**: PR 10·13·14·15·16.
- **완료 기준**:
  - [ ] `결정 뒤 확정할 TS 테스트 명령 — tests/test_skill_lint.test.ts` 통과.
  - [ ] 업무 경로별 검증 명령 사용 확인(문자열 0건만이 아님), core+plan 합성 1회 통과.
  - [ ] 연구 절차·독립 검토·근거 확인 유지, Claude 전용 표기는 예외 위치.
- **지킬 것**: 광범위 grep으로 정상 구현을 막지 않는다. `anthropic-skills:*` 이름만 바꿔 변환 지원을 주장하지 않는다. PR19 선행 계약.

## PR 18 — [2단계] 로컬 화면 DB/API 전환

- **목표**: 기존 화면을 같은 URL·같은 동작으로 DB/API에 연결하고, 새 디자인은 넣지 않는다.
- **할 일**:
  - [ ] `scripts/pes.py`: `load`, `brief`, `build_index`, `build_hub`를 DB 읽기 모델로 바꾸고, `fill`은 템플릿 렌더러로 유지한다. `templates/dashboard.html`·`ask.html`·`_questions.html`·`hub.html`·`stage-report.html`·`final-report.html`·`eli5.html`의 데이터 키를 맞춘다.
  - [ ] `scripts/serve.py`: `/api/v1` 라우팅, `/version`을 DB 커서 기반으로, **기존 0.15 동작과 같은 `POST /<slug>/feedback`**(로컬 서버 기준)을 `CommandService` 제출로. 새 API 답 제출 경로는 별도 표기한다. loopback·Origin·소유자 세션·CSRF.
  - [ ] 동등성: 홈 목록, 대시보드 전체 보기·단계 탭·AI 점검·타임라인·항목×라운드·승인·보고서, `__other`·`show_if`·필수·추천, 원격 답, approve/reopen, 단계·최종·eli5, 인쇄, `ask-*` 딥링크, `pes watch`.
  - [ ] 입력 중 갱신·충돌·타임아웃·커서 무효에도 초안 보존; 안전한 Markdown/외부 인용; 서버 영수증 뒤 성공 표시; Go in-flight/unknown·run 상태 최소 표시.
  - [ ] `tests/test_web_parity.test.ts` + `tests/e2e/workspace_smoke.spec.ts`(Playwright, 개발 전용). Windows CI는 브라우저 설치 실패 시 실패.
- **선행**: PR 8·10·13·14·15·16.
- **완료 기준**:
  - [ ] `결정 뒤 확정할 TS 테스트 명령 — tests/test_web_parity.test.ts` 통과.
  - [ ] Playwright 스모크가 Windows/Mac에서 통과, 같은 URL·딥링크·인쇄·원격 답 유지.
  - [ ] 이중 쓰기 0, 미제출 답 보존, 새 디자인 0.
- **지킬 것**: 실제 홈·실자료 금지. 기존 화면 병행(3단계)과 혼동하지 않는다. 픽셀 기준선을 만들지 않는다.

## PR 19 — [2단계] A 내장 실행기(Go API 직접 호출)

- **목표**: PES가 OpenCode Go HTTP API를 직접 호출하고, 에이전트 루프·업무 도구·사용량 보호·모델 선택을 직접 맡아 **사용자가 고른 `opencode-go` 모델 하나(기본 DeepSeek)**로 합성 6단계를 돌린다. opencode serve·CLI·로컬 runner를 두지 않는다.
- **할 일**:
  - [ ] `scripts/pes_core/a_runtime/go_client.ts`: **PR19에서 검증해 고정할 Go API 주소**를 쓴다. 2026-11-05 공식 문서([Inference API](https://opencode.ai/v2/docs/console/api/inference/))는 `/inference/openai/...`·`/inference/anthropic/...`·`/inference/google/...`, 모델 목록 `/inference/v1/models`를 안내하며 기존 `/inference/go/...`·`/inference/go/v1/models`는 후보로 둔다. 원시 model ID↔내부 ID·구독 적용 조건을 기록하고, 모델별 요청 형식·PES user agent·`x-opencode-session`(라우팅·캐시용)을 쓴다.
  - [ ] **호출 시도·멱등**: 호출 전 영속 attempt/상관키와 `prepared/sent/response/adopted/unknown`을 남긴다. 응답 유실·타임아웃·DB 저장 실패는 unknown으로 보존하고 자동 재호출하지 않는다. **모델 호출 재시도와 로컬 결과 저장 재시도를 분리**하고, 저장 재시도는 Go를 다시 호출하지 않는다. 가짜 Go 서버로 호출 횟수·예약·unknown을 시험한다.
  - [ ] `scripts/pes_core/a_runtime/loop.ts`: 맥락 조립 → 모델 호출 → 구조화 결과(JSON) 스키마 검증 → 기존 업무 명령 저장 → `ask`/`waiting_human` → 답이 와도 C4/R1 준비·정책·새 claim 검사를 거쳐 사람이 재개하며 자동 진행하지 않음. run당 활성 루프 하나, 단계 상태를 DB에 남겨 재시작 뒤 이어 감.
  - [ ] `scripts/pes_core/a_runtime/tools.ts`: 모델 도구는 **0013의 allowlist만**: `context.get`·`result.submit`·`question.ask`(공통), `assumption.propose`·`decision.propose`·`reflection.write`(U3), `thread.reply`·`followup.propose`(U4). `decision.propose`는 stage-5 `pes_decision`·stage-3 A 결정 제안과 같은 명령이며 사람만 채택한다. 파일시스템·셸·임의 네트워크 도구 없음. 연구 자료 속 지시를 따르지 않고, 결과 저장은 기존 명령 서비스·권한 검사를 지난다.
  - [ ] 최초 claim 단일화, 첫 Go 호출 전 run·claim·현재 Go 정책·**사용량 기준점/추정·Extra Usage OFF 확인 증거**·키 존재·모델 확인. 확인 불가·증거 만료면 차단하고, 콘솔에서 OFF를 확인해 시각을 입력하는 **수동 확인 경로**를 둔다. Go 키는 OS 키체인에서 읽고 로그·프롬프트·응답에 넣지 않는다.
  - [ ] **사용량 보호**([Go 사용량·Extra Usage](https://opencode.ai/v2/docs/console/go/)): 계정/워크스페이스 기준점·확인된 allowance/가중치를 쓰고, 외부 사용량을 모르면 0으로 두지 않고 차단/추가 확인한다. 호출별 토큰을 집계해 월·주·5시간 한도(100%·50%·20%) 대비 추정 사용률을 계산하고 90% 문턱에서 새 호출을 막는다. **다음 호출 상한을 최대 출력·가중치로 예약·정산**하고 병렬·재시도·인계·재시작 누적·unknown 예약 미해제를 지킨다. **한도 초과 오류**는 즉시 멈추고 `resetsAt`(없으면 미확인) 표시, 과금 표시·cost≠0이면 중단, unknown이면 fail-closed. **cost=0만으로 Go 구독 판단 금지**, `billing_source`·`allowance`·필드 누락 시험. Extra Usage는 끄도록 안내하고 OFF 확인 시각·유효 기간을 기록한다.
  - [ ] **사용량 차단 상태**: **`runs.status='blocked_usage'` + `go_block_reason`·`go_blocked_at`·`go_block_reset_at`**을 쓰고, `waiting_human`은 질문·입력 대기 의미로 유지한다. **차단 사유·`resetsAt`·lease 해제·재개 주체(사람)** 계약을 구현하고, 응답 도착만으로 자동 진행하지 않는다.
  - [ ] **모델 선택**: 프로젝트 정책·run 시작 시 검증된 모델 목록의 active `opencode-go/*`에서 고른 하나를 `runs.model`에 기록, 원시/내부 ID·구독 적용 조건 기록, run 중 폴백 없음.
  - [ ] Go OFF를 **호출마다** 검사(맥락·요약·첨부·재시도·자식 포함), 4역할·6단계, 이벤트는 `execution.*` 저빈도만.
  - [ ] `docs/adapters/a-builtin.md`, `tests/test_a_builtin.test.ts`(가짜 Go HTTP 서버), SEL-18의 cost=0 확인 기록은 근거로만 인용.
- **선행**: PR 5·10·13·14·17·18 + SEL-18.
- **완료 기준**:
  - [ ] `결정 뒤 확정할 TS 테스트 명령 — tests/test_a_builtin.test.ts` 통과.
  - [ ] 합성 1개 6단계, wait/resume/interrupt, Go OFF **호출별** 차단, **사용량 추정 문턱·한도 오류·과금 표시·unknown fail-closed**, 실제 자료 0.
  - [ ] **Go API 주소·모델 목록·원시/내부 model ID·구독 적용 조건·billing_source·allowance**와 **Extra Usage OFF 확인/만료/확인 불가 차단**이 시험된다.
  - [ ] **호출 전 attempt/상관키·응답 유실 unknown·자동 재호출 금지·모델 호출/저장 재시도 분리·가짜 서버 호출 횟수**가 시험된다. **`blocked_usage`+사유/reset·lease 해제·사람 재개**가 확인된다.
  - [ ] **A/B 합성 U3**에서 A는 `decision.propose`, B는 `decision:propose`/MCP `pes_decision`으로 같은 결정 제안을 만들고, 채택은 사람만 한다.
  - [ ] JSON 스키마 위반 거부, 프롬프트 주입 무시, 재시작 뒤 같은 run 이어 감·중복 제출 0, 모델·키가 로그에 0건, 자식 waiting_human 전파.
- **지킬 것**: opencode serve·CLI·로컬 runner를 A에 넣지 않는다. 모델 폴백·자동 B 전환 없음. 이미 나간 자료 회수 보장 없음. Extra Usage를 켜지 않는다.

## PR 20a — [2단계] 방식 B 어댑터 — Claude Code·Claude 앱

- **목표**: Claude Code MCP·CLI와 Claude 앱 Desktop/명시적 전달이 같은 PES API로 작업하게 하고, 20b가 쓸 공통 MCP bridge·adapter 계약을 만든다.
- **할 일**:
  - [ ] `scripts/pes_core/mcp_server.ts`: stdio MCP→로컬 PES HTTP, 도구 `pes_context/claim/submit/ask/wait/complete`+heartbeat·release·cancel·영수증.
  - [ ] `scripts/pes_core/adapters/claude_code.ts`: `/pes:run` 진입점, CLI 대안, 토큰 주입, 같은 오류·멱등.
  - [ ] `scripts/pes_core/adapters/claude_app.ts`: Desktop 로컬 확장 실제 설치·도구 왕복·종료/재접속, 안 되면 명시적 전달(묶음 복사→가져오기).
  - [ ] 전달 묶음: 프로젝트·판·단계·라운드·기반 버전·요청 ID·manifest hash(인증 증명 아님); 복사 중 lease 없음; 중복 가져오기 방지; 사람이 붙여 넣은 결과는 human actor.
  - [ ] **B 최초 project.register 종단 시험**: PR14의 `project-registrations` API를 사용해 project token 없이 사람의 기기 승인/제한 등록 자격으로 빈 계정/새 프로젝트를 등록한다. 일반 에이전트 토큰에 owner 생성·정책 변경 권한을 주지 않고 중복·재생을 거부한다.
  - [ ] `docs/adapters/adapter-contract.md`(공통)와 `claude-code.md`·`claude-app.md`, **진행 이벤트(`execution.progress.*`)·스케줄 표준 형식**, `pes link`/`sync` 로컬 동기화 계약, `tests/test_adapter_b_claude.test.ts`, SEL-19 기록.
- **선행**: PR 5·10·13·14·17·18 + SEL-19.
- **완료 기준**:
  - [ ] `결정 뒤 확정할 TS 테스트 명령 — tests/test_adapter_b_claude.test.ts` 통과.
  - [ ] Code로 합성 6단계, 앱 1단계 왕복·재접속, 복사≠제출, 중복 가져오기 0.
  - [ ] **빈 계정/새 프로젝트에서 B 최초 project.register→run→결과**가 통과하고, owner·초기 정책 우회가 0이다.
  - [ ] 실제 제출 actor 구분, 다른/오래된/중복 묶음·첨부 누락 거부. **진행·스케줄 이벤트가 같은 형식·멱등 키로 기록되고, `pes link`/`sync` 로컬 계약이 문서만 보고 재현됨.**
- **지킬 것**: 앱 지속 heartbeat 가정 없음. "연결됨"을 과장하지 않음. 붙여넣기 결과를 실행·승인으로 표시하지 않는다.

## PR 20b — [2단계] 방식 B 어댑터 — Codex CLI·OpenCode TUI

- **목표**: 20a의 공통 MCP bridge·계약으로 Codex CLI와 OpenCode TUI를 붙이고, 각각 합성 1라운드+재개를 통과한다. **A의 내장 실행기**와 **사람이 직접 켜는 OpenCode TUI**를 구분한다.
- **할 일**:
  - [ ] `docs/adapters/adapter-contract.md`를 재사용하고, D4 어댑터 노트에 `docs/adapters/codex.md`·`opencode-tui.md`를 추가한다. 진입 명령, MCP/HTTP 경로, 토큰 보관(OS 키체인), 권한, 세션·재개, 모델/사용량, 알려진 한계, 고정 버전을 적는다.
  - [ ] `scripts/pes_core/adapters/codex_cli.ts`: `runtime=codex_cli`, `runs.mode=B`, `actors.kind=external_agent`, 모델 미상은 `unknown`; `docs/adapters` 노트와 같은 계약.
  - [ ] `scripts/pes_core/adapters/opencode_tui.ts`: `runtime=opencode_tui`, 사람이 직접 켜는 세션·재개, A의 서버·프로세스·supervisor를 재사용하거나 중단하지 않음.
  - [ ] Go 목적지로 보내는 맥락·요약·파일·재시도·child 경로를 시험하고, 막을 수 없는 경로는 "Go OFF 보장"으로 쓰지 않는다. 승인·reopen·정책·토큰·삭제·export 도구는 넣지 않는다.
  - [ ] Codex CLI·OpenCode TUI 각각 합성 1라운드+재개, Codex↔OpenCode TUI 인계, 중복 제출·같은 키 다른 요청·버전 오류. `tests/test_adapter_b_codex.test.ts`·`tests/test_adapter_b_opencode_tui.test.ts`.
- **선행**: PR 20a, 5·10·13·14·17·18 + SEL-19.
- **완료 기준**:
  - [ ] `결정 뒤 확정할 TS 테스트 명령 — tests/test_adapter_b_codex.test.ts tests/test_adapter_b_opencode_tui.test.ts` 통과.
  - [ ] **Codex CLI와 OpenCode TUI 각각** 합성 1라운드+재개, actor/runtime 정확, 모델·사용량 미상은 `unknown`.
  - [ ] 중복 제출·같은 키 다른 요청 거부, A 내장 실행기 비간섭, Go 경로 차단/한계 표기.
  - [ ] 노트만 보고 새 환경에서 연결 절차를 재현할 수 있다.
- **지킬 것**: Codex·OpenCode TUI 전용 업무 의미·오류를 만들지 않는다. OpenCode TUI는 A 내장 실행기가 아니다. 승인·reopen·정책·토큰·삭제·외부 export 불가.

## PR 20c — [2단계] 방식 B 어댑터 — Codex 앱·OpenCode 앱

- **목표**: 20a 계약·20b 노트를 재사용해 **Codex 앱·OpenCode 앱**을 붙이고, 각각 합성 1라운드+재개를 통과한다. 직접 연결이 안 되면 명시적 전달을 보장 경로로 둔다.
- **할 일**:
  - [ ] `docs/adapters/adapter-contract.md`를 재사용하고 D4 노트에 `codex-app.md`·`opencode-app.md`를 추가한다. 설정 공유는 **미확인**이며, 실제 설정 경로·MCP 공유 여부를 시험 결과로 적는다.
  - [ ] `scripts/pes_core/adapters/codex_app.ts`: `runtime=codex_app`, `runs.mode=B`, `actors.kind=external_agent`; CLI와 설정 공유가 안 되면 명시적 전달(묶음 복사→가져오기)로 같은 의미.
  - [ ] `scripts/pes_core/adapters/opencode_app.ts`: `runtime=opencode_app`, 사람이 직접 켜는 앱 세션·재개. **A의 전용 opencode 프로필·서버를 재사용하거나 중단하지 않는다.**
  - [ ] 직접 연결·전달 경로 모두 실제 제출 actor를 구분한다. 전달은 human actor, 도구·모델 주장은 미검증 출처. 중복 제출·같은 키 다른 요청·버전 오류를 시험한다.
  - [ ] `tests/test_adapter_b_codex_app.test.ts`·`tests/test_adapter_b_opencode_app.test.ts`.
- **선행**: PR 20b, 5·10·13·14·17·18 + SEL-19.
- **완료 기준**:
  - [ ] `결정 뒤 확정할 TS 테스트 명령 — tests/test_adapter_b_codex_app.test.ts tests/test_adapter_b_opencode_app.test.ts` 통과.
  - [ ] **Codex 앱·OpenCode 앱 각각** 합성 1라운드+재개, 직접 연결/전달 경로, actor/runtime 정확.
  - [ ] 중복 제출·같은 키 다른 요청·버전 오류, A 내장 실행기·OpenCode TUI 비간섭.
  - [ ] 직접 연결이 안 되면 전달 경로로 같은 의미를 확인한다. **직접 인증 앱은 `external_agent`, 사람이 붙여 넣은 수동 전달만 `human`**으로 기록한다.
- **지킬 것**: 앱 설정 공유를 확인 전에 보장으로 쓰지 않는다. OpenCode 앱은 A 내장 실행기가 아니다. 승인·reopen·정책·토큰·삭제·외부 export 불가.

## PR 21 — [2단계] A·B 교차 계약

- **목표**: A와 B가 같은 DB 상태에서 같은 의미·권한·오류를 내고, 인계·중복·충돌에서 유실이 없음을 자동 시험한다.
- **할 일**:
  - [ ] `tests/test_cross_contract.test.ts`: 가짜 A/B 런타임으로 같은 프로젝트·같은 결과, A→B·B→A 인계, 지연 응답, 프로세스 종료, Go OFF, Go 사용량, 중복/충돌. **B는 Claude Code·Claude 앱·Codex CLI·OpenCode TUI·Codex 앱·OpenCode 앱을 포함**한다.
  - [ ] `tests/fixtures/contracts/cross/*.json`: seen/applied 중복, 사람 시작 인계, 권한 응답 지연 거부, Go 사용량 문턱 인계 유지, unknown 예약 미해제.
  - [ ] SQLite/D1 같은 성공·충돌·부분 실패; Go 실측은 PR19/20a·20b·20c, 반복 계약은 가짜 런타임.
  - [ ] `docs/plan/decisions/<미사용 번호>-cross-contract.md`: 공통 의미·차이·재검토 조건. 기존 0002~0004와 예약 0006을 재사용하지 않고, 등록 시 색인에서 빈 번호를 확인한다.
- **선행**: PR 18·19·20a·20b·20c + SEL-18·19.
- **완료 기준**:
  - [ ] `결정 뒤 확정할 TS 테스트 명령 — tests/test_cross_contract.test.ts` 통과.
  - [ ] 같은 DB 상태에서 같은 문구·권한, 유실·중복 0, 옛 fence 거부.
  - [ ] A↔B 인계 뒤 새 claim/fence, unknown 예약 자동 해제 0.
- **지킬 것**: CI에서 유료 모델 호출 없음. B의 외부 비용을 PES가 집행했다고 표시하지 않는다.

## PR 22 — [2단계] 전환 통합 검증·문서

- **목표**: Windows/Mac 설치·복구·백업·이전 runbook을 검증하고, **TypeScript 단일 코드베이스**에서 사용자 허용 시 실제 프로젝트 1개 파일럿을 한다.
- **할 일**:
  - [ ] `docs/guides/stage-2.md`: 설치·업그레이드·다운그레이드, DB·객체 위치, `pes home`, 백업/복원, legacy 읽기, 삭제 정책, **Codex CLI·OpenCode TUI·Codex 앱·OpenCode 앱 연결·재개·전달 경로·A 내장 실행기와의 구분**, 알려진 한계.
  - [ ] `docs/plan/decisions/<미사용 번호>-stage-2-release.md`: 0.16.0 배포 조건, 새 DB 경로 개발 플래그 해제, 되돌리기·손실 범위. 기존 0002~0004와 예약 0006을 재사용하지 않고, 등록 시 색인에서 빈 번호를 확인한다.
  - [ ] `tests/test_transition_docs.test.ts`: 문서 링크·명령·경로 검사; CI 매 PR·main Windows/Mac, Playwright, D1 smoke.
  - [ ] 실제 파일럿: 사용자 허용 slug 1개, 사본/백업, A 실행 없이 답·승인·reopen·인쇄·기존 화면, 원본 보존. 실제 manifest·경로·보고서는 로컬에만.
  - [ ] **실제 자료 사용 허용 기록**: 프로젝트·자료 범위·목적지(B Code·앱·Codex·OpenCode, A Go)·기간·철회를 로컬에 기록하고 실제 접근 전 사용자 확인을 받는다. PR22 미실시면 T1이 최초 기록을 만들고, 기록이 있으면 새 목적지만 추가한다. 로컬 이전 허용과 B 외부 전달·A Go 전달을 구분하고 기간 만료·철회 뒤 사용 차단을 확인한다. 허용이 없으면 합성 검증/미실시로 남긴다.
  - [ ] `README.md` 사용자 안내 갱신, 플러그인 버전은 PR22 통과·사용자 승인 뒤 한 번만 올린다.
- **선행**: PR 2·12·18·21·26 + SEL-18·19.
- **완료 기준**:
  - [ ] `결정 뒤 확정할 TS 테스트 명령 — tests/test_transition_docs.test.ts` 통과.
  - [ ] CI 매 PR·main Windows/Mac, 복원 훈련, 실제 파일럿(허용 시) 원본 보존.
  - [ ] 실제 자료 허용 기록이 로컬에 있고, PR22 미실시 시 T1 최초 기록 인계가 확인된다. 기간 만료·철회 뒤 접근 차단.
  - [ ] 문서만 보고 재현, 공개 저장소 민감 자료 0, 사용자 "3단계로 넘어가도 된다" 승인.
- **지킬 것**: 실제 프로젝트 이전은 사용자 허용 전 금지. 2단계 PR에서 버전 올리지 않음. 실제 자료는 PR·로그·문서에 넣지 않는다.

## PR 26 — [2단계] TypeScript 단일화·0.15 Python 이전

- **목표**: Python 0.15(`scripts/pes.py`·`serve.py`, pytest, 설치 스크립트, skills/commands의 `python3 scripts/pes.py ...`)를 TS로 옮겨 0.16.0을 **TypeScript 단일 코드베이스**로 만든다. **새 코어·기능·시험은 PR1~22에서 이미 TS로 작성하며, PR26은 기존 0.15 자산의 이전·동등성·설치·제거만 맡는다.**
- **할 일**:
  - [ ] 0.15 Python을 **동결(치명 결함 수정만)** 하고, 새 TS 코어(PR1·4·13·14·15·16·17)와 같은 명령·출력 계약을 맞춘다.
  - [ ] 동등성 매트릭스: 질문 화면·보고서·`project.json` 처리·CLI 출력·입력→출력. 같은 합성 픽스처로 양쪽 차이 0.
  - [ ] 0.15 pytest 자산을 TS 테스트로 이전하고, 같은 fixture로 차이 0 확인 뒤 Python 테스트를 제거한다. **새 TS 코어 시험은 PR1~22에서 이미 TS로 작성하며 PR26에서 새 Python 테스트를 만들지 않는다.**
  - [ ] `install.sh`/`install.ps1`·bootstrap·`pes:setup`을 새 런타임 기준으로 바꾸고 Windows/Mac 시험.
  - [ ] `skills/`·`commands/`·`agents/`의 `python3 scripts/pes.py ...` 호출을 새 CLI로 바꾼다(PR17과 연결).
  - [ ] legacy importer(PR11)는 옛 **데이터 형식**만 읽고 Python 코드를 실행하지 않음을 확인.
  - [ ] 외부 도구(kosis·vworld·korean-law 등)가 Python을 요구하면 **외부 도구 경계**로 표시하고 PES 코드에 다른 언어를 두지 않는다.
- **선행**: PR 1·4·13·14·15·16·17·18·21.
- **완료 기준**:
  - [ ] 0.15 이전 TS 테스트와 PR1~22의 새 TS 테스트 전체가 통과하고, 같은 합성 fixture에서 0.15와 출력 차이 0.
  - [ ] `python3 scripts/pes.py` 호출 0, 설치·업그레이드 Windows/Mac 통과.
  - [ ] 0.16.0이 TS 단일 코드베이스, Python 제거, 외부 도구 경계 문서화.
- **지킬 것**: 이전 중 0.15 기능을 새로 늘리지 않는다. Python과 TS를 오래 이중 유지하지 않는다. 실제 자료를 fixture·로그에 넣지 않는다.
