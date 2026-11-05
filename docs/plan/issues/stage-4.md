# 4단계 구현 이슈 초안 (Linear 등록 전 원고)

- 작성: 2026-11-05, OpenCode
- 부모: SEL-27, 근거: [stage-4.md](../stage-4.md) 4절·5절, [stage-1-db.md](../stage-1-db.md)·[stage-1-api.md](../stage-1-api.md)·[stage-1-ui.md](../stage-1-ui.md)·[stage-1-runners.md](../stage-1-runners.md), [DDL](../schemas/stage-1-ddl-draft.sql)
- 상태: **초안 — 사용자 승인 전.** Linear에 만들지 않았다.
- 규칙: 이슈 하나 = PR 하나. 모든 쓰기는 2단계의 검증된 명령 서비스(`src/core/commands.ts`)를 지나고, 화면·CLI·MCP가 DB를 직접 쓰지 않는다. 실제 `~/pes-projects`·`~/.pes/`는 읽지 않고 합성 fixture만 쓴다.
- 경로 전제: 2·3단계에서 파일명이 달라졌으면 같은 역할의 모듈로 매핑한다. 아래 함수·표 이름은 계약 이름으로 유지한다. 신규 화면은 3단계 U1의 `src/server/serve.ts`(서버 렌더·API 라우트)·`templates/workspace/`·`static/workspace/` 경계를 확장하고, 3단계에서 화면 모듈이 `src/web/workspace.ts`로 분리됐다면 그 모듈을 쓴다. W1·R1은 4단계 필수 전제가 아니고, T1은 채택했을 때만 U12 게이트 입력으로 쓴다.
- 공통 테스트: 각 PR은 **결정 뒤 확정할 TS 테스트 명령**(예: `tests/stage4/<이슈>.test.ts`)과 전체 TS 테스트 명령을 통과한다. Windows/macOS도 같은 TS 계약을 실행한다. 브라우저가 있는 PR은 3단계 Playwright 하네스로 `npx playwright test tests/e2e/stage4_<이슈>.spec.ts`를 실행하고, Windows CI에서 브라우저가 없으면 실패로 처리한다. 매 PR/main Windows+macOS를 유지한다. A·B의 같은 의미·같은 버전 결과는 PR 21의 교차 계약 하네스를 확장해 **각 PR에서** 시험하고 마지막에 몰아 하지 않는다. B는 **Claude Code·Claude 앱·Codex CLI·OpenCode TUI·Codex 앱·OpenCode 앱** 여섯 경로를 포함하고, PR 20은 20a·20b·20c로 나눈 계약을 쓴다.
- 설계 검사기: `docs/plan/schemas/check_ddl.py`는 **PR26 전까지 한시 실행하는 Python 보조 도구**다. **PR26이 설계 검사 계약을 TS 검사기·실행 명령·기존 합성 사례 동등성으로 옮기고, 4단계 이후 필수 검사는 그 TS 산출물을 쓴다.** 새 4단계 모듈·시험은 TS 계약으로 둔다.
- 공통 지킬 것: 실제 자료·키·기관명을 fixture·로그·스크린샷·PR에 넣지 않는다. 승인·reopen·판 시작·직접 편집 권한은 서버가 검사하고 UI 체크만으로 통과시키지 않는다. 실패한 변경은 부분 저장 없이 전체 롤백하고, 성공은 서버 영수증 뒤에만 표시한다. 새 표는 PR 23의 `edition_carryovers` 하나만, 새 열은 `editions.completed_snapshot_id`·`projects.settings_json`(PR 23)와 `run_targets.direct_edit_*`(PR 25)만 만든다(부족하면 별도 DB 설계로 회송).

## 1. [4단계] PR 23 — 판 완료·이월 기록

- **목표 한 줄**: 소유자 사람이 판을 완료·해제하고, 앞 판의 결정·가정·결과물·출처·후속을 유지/수정/제외로 골라 새 판에 원자적으로 이월하며, 그 선택을 `edition_carryovers`에 남긴다.
- **할 일**:
  - [ ] `docs/plan/schemas/stage-1-ddl-draft.sql`의 `editions`에 `completed_snapshot_id TEXT`(nullable, `snapshots(project_id,id)` FK)를 추가하고, `edition_carryovers` 표를 새 마이그레이션 `src/core/migrations/004_stage4_editions.sql`(신규)에 만든다. 열: `id`, `project_id`, `source_edition_id`, `target_edition_id`, `source_object_id`, `source_version_id`, `target_object_id`, `target_version_id`, `disposition(keep/modify/exclude)`, `basis_kind(sealed_round/approved_stage/as_of_manifest)`, `basis_snapshot_id`, `reason`, `actor_id`, `tx_id`, `created_at`. `exclude`는 대상 객체·버전 NULL 허용, 같은 대상 판·원본 버전·처리 구분 중복 금지. 이 004는 2단계 `db_meta.schema_version` 위의 4단계 마이그레이션 체인에 포함되고, 5단계 WEB1은 2~4단계 체인을 기준으로 초기화하며, WEB9·WEB10은 이월·완료·설정을 가진 합성 프로젝트의 이전·복원을 확인한다.
  - [ ] 같은 004에 `projects.settings_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(settings_json))`을 추가한다. U12의 `workspace_default`(`off/opt_in/default/legacy`)를 저장하며, 판별 설정인 `editions.settings_json`과 섞지 않는다.
  - [ ] `src/core/db.ts`의 마이그레이션 실행기에 004를 등록하고, `src/core/commands.ts`의 한 트랜잭션·멱등·`mutation_commits`·`events` 경로를 재사용한다.
  - [ ] `src/core/editions.ts`(신규)에 `complete_edition()`, `reopen_edition_completion()`, `archive_edition()`, `unarchive_edition()`, `start_edition()`, `preview_carryover()`, `apply_carryover()`를 구현한다. 완료 검사는 `runs.status IN ('queued','running','waiting_human')`, `project_leases`, `stages.status='approved'`·`stale_since_event_seq`, 필수 응답 미처리를 같은 tx에서 재검사한다.
  - [ ] `_copy_artifact()`, `_copy_source()`, `_copy_decision()`, `_copy_assumption()`, `_copy_followup()`를 구현한다. 결과물은 `objects`·`object_versions`·`artifacts`·`artifact_versions`·`artifact_components`·`citations`·`version_relations`·`version_files`, 결정은 `decisions.originated_from_version_id`, 후속은 `followups.origin_version_id`·`followup_versions.target_stage_id/target_round_id`를 쓴다. 가정·출처는 전용 계보 열이 없으므로 `edition_carryovers`로 원본/대상을 보장한다.
  - [ ] `carryover.preview`는 순수 조회, `carryover.apply`는 항목 묶음 원자 적용으로 만든다. 미리보기 뒤 기준 rev가 바뀌면 `basis_changed`로 거부하고, 같은 요청은 멱등 재생한다. `exclude`도 이유와 함께 기록한다.
  - [ ] `src/cli/pes.ts`에 `cmd_edition_complete`, `cmd_edition_reopen`, `cmd_edition_archive`, `cmd_edition_unarchive`, `cmd_edition_start`, `cmd_carryover_preview`, `cmd_carryover_apply`를 추가하고 `CMDS`·`main`에 등록한다. `src/api/v1.ts`에 `POST /api/v1/projects/{id}/editions/{e}/complete`, `/reopen-completion`, `/archive`, `/unarchive`, `POST /api/v1/projects/{id}/editions`, `GET .../carryover/preview`, `POST .../carryover/apply`를 추가한다.
  - [ ] 완료 시 `editions.status='completed'`, `completed_snapshot_id`(`snapshots.scope='edition'`, 같은 판), `projects.active_edition_id` 해제, `events`·영수증을 한 tx로 쓴다. 해제는 후속 판이 없을 때만 포인터를 풀고 승인·stale·현재 단계 포인터를 보존한다. `archive_edition()`은 미종결 run·lease가 없을 때만 `editions.status='archived'`로 바꾸고, 활성 판이면 `projects.active_edition_id`를 해제하며 `completed_snapshot_id`를 만들지 않는다. 보관 시 다음 판 기준 후보를 마지막 봉인 라운드→마지막 승인 단계→as-of manifest 순서로 계산해 두고, 다음 판 `apply_carryover()`가 `edition_carryovers.basis_kind`·`basis_snapshot_id`에 기록한다. `unarchive_edition()`은 소유자만, 후속 판이 없을 때만 `editions.status`를 되돌리고 필요하면 active 포인터를 복원한다.
  - [ ] `src/core/editions.ts`에 `archive_project()`·`reopen_project()`를 구현한다. `projects.status='archived'`는 미종결 run·lease가 없을 때만 허용하고, 미완료 보관은 `completed_snapshot_id`를 만들지 않는다. 이 명령은 `editions.status`·`projects.active_edition_id`를 바꾸지 않는다. `reopen_project()`는 소유자만이며 판 상태를 바꾸지 않는다. CLI `cmd_project_archive`·`cmd_project_reopen`, API `POST .../projects/{id}/archive`·`/reopen`을 추가한다.
  - [ ] `docs/plan/decisions/`에 새 표·열 결정(문제·선택지·채택·이유·영향·재검토 조건)을 남기고, **PR26 산출 TS 검사기**와 `stage-1-db.md` 3.2·3.5를 갱신한다.
- **선행 이슈**: PR 1(스키마·SQLite), PR 2(D1 smoke), PR 4(명령 서비스), PR 6(판·단계·라운드), PR 7(항목·버전·출처), PR 9(결과물·객체), PR 10(actor·정책), PR 14(API), U3·U4.
- **완료 기준**:
  - [ ] `결정 뒤 확정할 TS 테스트 명령 tests/stage4/editions.test.ts tests/stage4/carryover.test.ts` 통과.
  - [ ] 미종결 run·stale·필수 응답·실행 차단 상태가 있으면 완료가 거부되고 부분 저장이 없다. 정상 완료는 스냅숏·event·영수증이 한 tx에 남는다.
  - [ ] 유지/수정/제외가 모두 기록되고, `exclude` 대상 NULL·중복 적용·미리보기 뒤 변경·롤백이 시험된다. `components`·`citations`·`version_files`·`next_round_task` 이월이 확인된다.
  - [ ] legacy `legacy_unverified` 승인 1판을 현재 소유자가 완료→2판 시작하는 합성 fixture가 통과한다. **미완료 판 보관→다음 판 시작→프로젝트 열람→보관 해제**와 **프로젝트 보관/다시 열기**가 각각 통과하고, 미완료 보관은 완료 스냅숏을 만들지 않으며 두 보관의 `editions.status`·`projects.status`·`active_edition_id` 전이가 섞이지 않는다.
  - [ ] 새 마이그레이션의 D1 smoke와 export/import(PR 3) 복원 시험이 통과하고, `edition_carryovers`·`completed_snapshot_id`·`projects.settings_json`이 이전·복원에 포함된다. `결정 뒤 확정할 TS 테스트 명령` 전체 통과.
- **지킬 것**: 완료·해제·시작은 소유자 사람만. run 종료≠승인, 이월≠승인. 정책·토큰·run·lease·답·승인은 복사하지 않는다. 과거 run·승인·스냅숏을 삭제하지 않는다. 새 표·열은 이 PR의 마이그레이션에만 넣고, 화면에서 임의 표를 추가하지 않는다.

## 2. [4단계] PR 24 — 판 비교·이력 읽기 API

- **목표 한 줄**: 두 판·두 라운드의 차이와 이력을 실제 계보·스냅숏·사건 경계로 계산해 읽기 전용 API로 제공하고, 열린 판은 하나의 잠정 경계로 표시한다.
- **할 일**:
  - [ ] `src/core/compare.ts`(신규)에 `compare_editions()`, `compare_rounds()`, `edition_history()`, `list_carryovers()`를 구현한다. 읽기 전용이며 `src/core/commands.ts`를 쓰지 않는다.
  - [ ] 기준 선택: 완료 판은 `editions.completed_snapshot_id`, 라운드는 `rounds.sealed_snapshot_id`, 열린 라운드는 요청 시작 시 `(db_meta.database_instance_id, db_meta.cursor_epoch, events.event_seq)`를 고정한다. 페이지 사이에 같은 경계를 넘기고, epoch 변경·커서 무효면 처음부터 다시 읽는다.
  - [ ] 실제 계보만 조회한다: 결과물 `artifacts.origin_version_id`·`object_versions.based_on_version_id`, 결정 `decisions.originated_from_version_id`, 후속 `followups.origin_version_id`, 가정·출처는 `edition_carryovers`. 없는 열을 있는 것처럼 다루거나 유사도로 맞추지 않는다.
  - [ ] 구조화 diff DTO를 만든다: `basis`, `editions`, `decisions`, `assumptions`, `artifacts`, `sources`, `approvals`, `carryovers`, `timeline`. 결과물 diff는 `artifact_components`·`citations`·`version_files`를 포함하고, 표는 버전 단위 나란히 보기부터 제공한다(행 단위 diff는 약속하지 않음).
  - [ ] `src/api/v1.ts`에 `GET /api/v1/projects/{id}/editions/{e}/compare?with=&scope=`, `GET .../editions/{e}/history`, `GET .../editions/{e}/carryovers`, `GET .../rounds/{r}/compare?with=`를 추가한다. `src/cli/pes.ts`에는 읽기 전용 `cmd_edition_compare`, `cmd_edition_history`를 추가한다.
  - [ ] event 공개 allowlist와 project·actor·run_targets·현재 Go 정책 검사를 적용한다. 토큰 스트림·heartbeat·내부 실행 원문은 넣지 않는다. `approvals`는 과거 승인과 stale을 함께 표시한다.
  - [ ] `tests/fixtures/stage4/compare_fixture.ts`에 합성 2판(객체 200·버전 2,000·긴 본문 20·긴 한글 표)을 만든다.
- **선행 이슈**: PR 23, PR 14, PR 4, PR 6.
- **완료 기준**:
  - [ ] `결정 뒤 확정할 TS 테스트 명령 tests/stage4/compare.test.ts tests/stage4/history.test.ts` 통과.
  - [ ] 1↔2판·R1↔R2·열린 라운드 비교가 동작하고, 계보 없는 항목은 "새 항목/이월 제외"로 표시되며 유사 매칭이 없다.
  - [ ] epoch 변경·커서 무효 시 다른 시점을 섞지 않고 다시 읽는다. 잠정 표시가 API에 있다.
  - [ ] 합성 2판에서 첫 페이지 2초·추가 페이지 1초 목표를 기록한다(하드 게이트가 아니면 측정값을 PR에 남긴다). `결정 뒤 확정할 TS 테스트 명령` 전체 통과.
- **지킬 것**: 읽기 전용. 비교를 위해 스냅숏을 만들지 않는다. 프로젝트 전체 scope를 가정하지 않는다. 이력 표를 새로 만들지 않고 `events`+`snapshots`로 계산한다. 없는 계보를 추정하지 않는다.

## 3. [4단계] PR 25 — 직접 편집·제안 명령

- **목표 한 줄**: 사람의 직접 편집과 AI의 제안을 모두 새 버전으로 저장하고, 기준 버전 충돌·승인 후 stale·AI 권한 회수를 서버에서 강제한다.
- **할 일**:
  - [ ] `src/core/revisions.ts`(신규)에 `revise_artifact()`를 구현한다. 요청 필드: `artifact_id`, `base_version_id`, `mode(direct/proposal)`, `title`, `summary`, `body_md`, `run_id?`, `idempotency_key`. 응답: `new_version_id`, `tx_id`, `mode`, `proposal_id?`.
  - [ ] 직접 모드는 `objects.current_version_id`를 새 `object_versions`+`artifact_versions`로 갱신하고, 제안 모드는 `followups`+`followup_versions(kind='edit_text', base_artifact_version_id, proposed_artifact_version_id, state='proposed')`로 저장한다. `proposed_artifact_version_id`는 `status='draft'`로 두고 현재 포인터를 바꾸지 않는다.
  - [ ] 새 마이그레이션 `src/core/migrations/005_stage4_edit_permissions.sql`(신규)에 `run_targets.direct_edit_allowed INTEGER NOT NULL DEFAULT 0`, `granted_by_actor_id`, `granted_at`, `direct_edit_expires_at INTEGER`, `revoked_at`를 추가한다. `edit_permission.grant/revoke`는 이 열을 갱신하며 `run_targets` 존재만으로 허용하지 않는다. 005도 같은 4단계 마이그레이션 체인에 포함되고, edit permission 이력이 export/import·복원에 포함되며 5단계 WEB9·WEB10의 이전·복원 시험에 포함된다.
  - [ ] 기준 버전이 다르면 `409 base_conflict`와 expected/current를 반환하고 자동 병합하지 않는다. 승인된 단계는 `stages.approved_snapshot_id`를 해제하고 `stale_since_event_seq`를 기록하며 `approvals` 과거 행은 보존한다(PR 6 규칙). **고정 승인·게시 스냅숏 자체는 수정하지 않는다.**
  - [ ] 새 버전 뒤 U4의 앵커 재판정(`anchors`·`anchor_resolutions`)을 호출하고, 원래 앵커·인용문·원 버전을 보존한다. 옛 기반 제안은 충돌로 표시한다.
  - [ ] `src/api/v1.ts`에 `POST /api/v1/projects/{id}/artifacts/{a}/revisions`, `POST .../edit-permissions/grant`, `/revoke`, `POST .../proposals/{p}/accept`, `/reject`를 추가한다. `src/cli/pes.ts`에 `cmd_artifact_revise`, `cmd_edit_permission`, `cmd_proposal_accept`, `cmd_proposal_reject`를 추가한다.
  - [ ] `src/core/commands.ts`의 actor·run·객체·범위·회수 검사를 재사용하고, `result.submit` 계약은 바꾸지 않는다.
  - [ ] 직접 편집 허가는 run이 `running`이고 lease/fence가 유효하며 `direct_edit_expires_at` 전이고 `base_version_id`가 현재와 같을 때만 유효하다. run 종료·담당 상실·만료·기준 버전 변경·회수 뒤에는 403/409로 거부하고, `run_targets` 행 존재를 허가로 쓰지 않는다. 만료는 run 종료/담당 상실 또는 `direct_edit_expires_at` 중 먼저 오는 시점으로 한다.
- **선행 이슈**: PR 4, PR 6, PR 7, PR 9, PR 13, PR 14, U4.
- **완료 기준**:
  - [ ] `결정 뒤 확정할 TS 테스트 명령 tests/stage4/revisions.test.ts tests/stage4/edit_permissions.test.ts tests/stage4/anchor_revise.test.ts` 통과.
  - [ ] 직접 편집·제안 왕복, 기준 충돌, 승인 후 stale, AI opt-in·회수, **run 종료·담당 상실·만료·기준 버전 변경 뒤 거부**, 멱등·부분 실패 롤백이 통과한다.
  - [ ] 승인·게시본은 직접 편집되지 않고, 새 버전의 `based_on_version_id`·actor·tx가 맞는다. edit permission 이력이 export/import·복원에 포함된다. `결정 뒤 확정할 TS 테스트 명령` 전체 통과.
- **지킬 것**: 원문 덮어쓰기 금지, 자동 병합 금지, UI 체크만으로 권한 통과 금지. AI가 승인·게시본을 직접 고치지 않는다. `run_targets` 존재≠직접 편집 허가. 사람 제안을 AI가 자동 수락하지 않는다.

## 4. [4단계] U7 — 판 완료·이월 마법사

- **목표 한 줄**: 사용자가 완료/해제와 새 판 이월을 한 화면에서 검토하고, 항목별 유지·수정·제외를 이유와 함께 확정한다.
- **할 일**:
  - [ ] `src/web/workspace.ts`에 `render_edition_complete()`, `render_carryover_preview()`, `render_carryover_item()`, `post_edition_complete()`, `post_edition_reopen()`, `post_carryover_apply()`를 추가한다. 모두 `src/api/v1.ts`를 호출하고 DB를 직접 읽지 않는다.
  - [ ] `templates/workspace/edition_complete.html`(신규), `templates/workspace/carryover.html`(신규), `templates/workspace/_carryover_table.html`(신규), `static/workspace/edition.js`(신규)를 만든다. 완료 조건·차단 이유·열린 run·stale·필수 응답을 먼저 보여 주고, 완료/해제 버튼은 소유자에게만 보인다.
  - [ ] 항목별 유지/수정/제외, 종류·단계 일괄 선택, "전부/빈 판", 이유 입력, 원본 버전 고정 미리보기, `needs_review` 표시, 프로젝트 공통 결정의 고정 버전 표시를 구현한다. `exclude`는 대상 NULL·중복·롤백을 화면에서도 처리한다. **판 보관/보관 해제**와 **프로젝트 보관/보관 해제**를 별도 동작으로 보여 주고, `editions.status`·`projects.status`·`projects.active_edition_id`를 구분해 표시한다. 두 보관 모두 미종결 run·lease가 없을 때만 보이고, 미완료 보관을 완료로 표시하지 않는다.
  - [ ] 새 판 첫 `purpose='stage_start'` 질문 세트에 "무엇을 빼고·바꾸고·더할지"를 넣는다. `question_sets`·`question_versions`는 PR 8 명령으로 만들고 직접 INSERT하지 않는다.
  - [ ] 에이전트 context manifest에 이월 목록과 "이월=참고, 승인 아님"을 넣는다. `skills/core/SKILL.md`·`skills/plan/SKILL.md`의 2판 기획 절차를 PR 17 중립 워크플로에 맞춰 갱신한다.
  - [ ] `tests/stage4/workspace_edition.test.ts`와 `tests/e2e/stage4_edition.spec.ts`를 만든다.
- **선행 이슈**: PR 23, PR 17, U1, U3, U4.
- **완료 기준**:
  - [ ] `결정 뒤 확정할 TS 테스트 명령 tests/stage4/workspace_edition.test.ts` 통과. `npx playwright test tests/e2e/stage4_edition.spec.ts` 통과(Windows CI 포함).
  - [ ] 합성 프로젝트 2판에서 완료→이월→기획 시작이 왕복하고, 모든 선택·이유가 `edition_carryovers`에 남는다.
  - [ ] 자동 승인 없음, 제외 NULL·중복·미리보기 뒤 변경·롤백, `components`·`citations`·`version_files`·`next_round_task` 이월, A/B 2판 기획 한 라운드, Windows/Mac이 확인된다. **미완료 판 보관→다음 판 시작→보관 해제**와 **프로젝트 보관/다시 열기** 화면 흐름이 각각 통과하고, 두 보관의 상태 전이가 섞이지 않는다. `결정 뒤 확정할 TS 테스트 명령` 전체 통과.
- **지킬 것**: 완료·해제·이월 적용은 소유자 사람만. 화면에서 표를 새로 만들지 않고 PR 23 API만 쓴다. 이월을 승인으로 표시하지 않는다. 실제 프로젝트를 자동으로 열지 않는다.

## 5. [4단계] U8 — 판 비교·이력 화면

- **목표 한 줄**: 두 판·두 라운드의 구조화 diff와 이력을 읽고, 같은 계보의 상세 diff·이월 제외·승인 상태·작성자·이유를 확인한다.
- **할 일**:
  - [ ] `src/web/workspace.ts`에 `render_compare()`, `render_history()`, `render_diff_row()`, `load_compare_page()`를 추가한다. PR 24 API만 호출하고 DB를 직접 읽지 않는다.
  - [ ] `templates/workspace/compare.html`(신규), `templates/workspace/history.html`(신규), `templates/workspace/_diff_table.html`(신규), `static/workspace/compare.js`(신규)를 만든다. 판/라운드 선택, 잠정 표시, 이월 제외와 삭제 구분, 보관 객체·원 버전 링크, 작성자·채택자·근거·변경 이유를 표시한다.
  - [ ] 상세 diff는 같은 계보일 때만 열고, 계보가 없으면 "새 항목/이월 제외"로 표시한다. 표는 버전 단위 나란히 보기부터 제공한다.
  - [ ] 인쇄는 U6을 재사용한다. 비교 화면을 승인본·고정 인쇄본으로 오인시키지 않고, "이 판/라운드 인쇄"는 U6의 판별 manifest로 넘긴다.
  - [ ] `tests/stage4/workspace_compare.test.ts`와 `tests/e2e/stage4_compare.spec.ts`를 만든다.
- **선행 이슈**: PR 24, U7, U1.
- **완료 기준**:
  - [ ] `결정 뒤 확정할 TS 테스트 명령 tests/stage4/workspace_compare.test.ts` 통과. `npx playwright test tests/e2e/stage4_compare.spec.ts` 통과.
  - [ ] 1↔2판·R1↔R2·열린 라운드 비교, 잠정 표시, 끊긴 링크 없음(보관 객체·원 버전 포함), 작성자·채택자·이유, U6 인쇄 회귀가 확인된다. `결정 뒤 확정할 TS 테스트 명령` 전체 통과.
- **지킬 것**: 읽기 전용. 비교를 위해 봉인·스냅숏을 만들지 않는다. 유사 매칭·자동 후보 확정 금지. 비교 화면 인쇄를 승인본으로 표시하지 않는다.

## 6. [4단계] U9 — 갈림길 맛보기

- **목표 한 줄**: 같은 판에서 방향 2~3개를 제안 결정으로 만들고, 근거·가정·위험·비용을 비교해 소유자가 하나를 원자적으로 채택한다.
- **할 일**:
  - [ ] `src/core/directions.ts`(신규)에 `propose_directions()`, `adopt_direction()`, `_validate_bundle()`, `_revoke_others()`, `_create_next_round_task()`, `_budget_check()`를 구현한다. 묶음은 별도 표가 아니라 `mutation_commits.action='direction.propose'`의 `id`와 `result_json`(`bundle_id`, `base_version_id`, `candidate_version_ids`) + `events.payload`로 표현한다.
  - [ ] 후보는 `decisions(scope='edition')`·`decision_versions(state='proposed')`, 근거는 `version_relations`·`sources`·`source_versions`, 가정은 `assumptions`·`assumption_versions`, 토론은 `threads`·`messages`로 저장한다. 채택은 `adopted` 결정+이유, 나머지는 `revoked`+이유를 한 tx로 쓴다.
  - [ ] `src/api/v1.ts`에 `POST /api/v1/projects/{id}/directions`, `POST .../directions/{bundle}/adopt`, `GET .../directions/{bundle}`을 추가한다. `src/cli/pes.ts`에 `cmd_direction_propose`, `cmd_direction_adopt`를 추가한다.
  - [ ] `src/web/workspace.ts`·`templates/workspace/directions.html`(신규)·`static/workspace/directions.js`(신규)에 2~3개 카드, 고정 틀(방향명·의도·핵심 주장 3~5·정확한 출처 버전·가정·위험·비용/기간·포기 항목), 채택/철회를 만든다.
  - [ ] A는 이미 사람이 시작한 run 안에서는 새 run 없이 제안하고, 새 Go run은 실행 동작·현재 정책·**사용량 추정 문턱** 검사를 거친다. B는 **Claude Code·Claude 앱·Codex CLI·OpenCode TUI·Codex 앱·OpenCode 앱**의 프롬프트 복사·외부 제안을 같은 `proposed` 결정으로 가져오고, 여섯 경로 모두 `candidate_version_ids`·기반 버전·멱등 계약을 시험한다. `skills/*/SKILL.md`의 중립 워크플로에 방향 제안 절차를 넣는다.
  - [ ] `tests/stage4/directions.test.ts`와 `tests/e2e/stage4_directions.spec.ts`를 만든다.
- **선행 이슈**: U3, U4, PR 10, PR 14, PR 19, PR 20a·20b·20c.
- **완료 기준**:
  - [ ] `결정 뒤 확정할 TS 테스트 명령 tests/stage4/directions.test.ts` 통과. `npx playwright test tests/e2e/stage4_directions.spec.ts` 통과.
  - [ ] 묶음 ID·기반 버전·후보 목록이 기록되고, 하나 채택/나머지 철회가 원자적이며, 중복 클릭·후보 변경·부분 실패가 전체 거부된다.
  - [ ] 차이를 설명할 근거조차 없을 때만 생성하지 않고(미검증 가정·확인할 근거를 표시한 대안은 허용), **Go 사용량 문턱**·Go OFF·B 여섯 경로(Claude Code·Claude 앱·Codex CLI·OpenCode TUI·Codex 앱·OpenCode 앱)의 수동 가져오기·다음 할 일 연결이 확인된다. `결정 뒤 확정할 TS 테스트 명령` 전체 통과.
- **지킬 것**: 자동 판 생성·자동 run·자동 채택 금지. 방향은 완성 원고가 아니라 1쪽 이내 맛보기. 새 표를 만들지 않고 기존 결정·사건·영수증으로 묶음을 표현한다. AI가 채택하지 않는다. PR20a·20b·20c의 기존 여섯 자격·전송 계약을 재사용하고, Codex CLI·OpenCode TUI·Codex 앱·OpenCode 앱 지원을 6단계로 미루지 않는다.

## 7. [4단계] U10 — AI 반대 의견

- **목표 한 줄**: 작업 AI와 독립 reviewer가 근거에 어긋나는 요청·결과에 반대 의견을 내고, 사람이 확인하거나 이유를 남겨 override하며, 그 증거를 채택·승인 서버 가드가 검사한다.
- **할 일**:
  - [ ] `src/core/objections.ts`(신규)에 `raise_objection()`, `confirm_objection()`, `override_objection()`, `_validate_evidence()`, `_classify_review()`, `_check_approval_guard()`를 구현한다. 반대 의견은 `artifacts.kind='review'`+`artifact_versions.conflicts`(JSON)로 저장하고, 토론은 `threads.context_kind='general'`·`messages`를 쓴다.
  - [ ] `_validate_evidence()`는 정확한 `sources`/`source_versions` 버전+`quote` 또는 `decisions`/`assumptions`의 채택·확인 버전과의 충돌만 허용한다. 문체·취향은 거부하고, 못 읽은 자료는 "확인 불가"로 표시한다.
  - [ ] `src/core/commands.ts`의 `approve_stage()`와 채택 명령에 같은 tx 가드를 넣는다. 대상 요청·결과·출처·반대 의견의 정확한 버전에 확인을 고정하고, 새 근거·새 결과에 옛 확인을 승계하지 않는다. override는 `decisions` `adopted`+이유로 남긴다.
  - [ ] 작업 AI의 자기 점검과 독립 reviewer를 구분한다. 독립 검토는 PR 5·19·20a·20b·20c의 부모 반납·새 claim/fence를 재사용하고, Claude Code·Claude 앱·Codex CLI·OpenCode TUI·Codex 앱·OpenCode 앱 여섯 경로에서 같은 반대 의견 제출 계약을 시험한다. 같은 모델의 다른 세션을 "다른 모델 검증"이라 하지 않는다. 반대 의견만으로 단계를 자동 stale로 만들지 않는다.
  - [ ] `src/api/v1.ts`에 `POST /api/v1/projects/{id}/objections`, `POST .../objections/{o}/confirm`, `/override`, `GET .../objections`를 추가한다. `src/cli/pes.ts`에 `cmd_objection_raise`, `cmd_objection_confirm`, `cmd_objection_override`를 추가한다.
  - [ ] `src/web/workspace.ts`·`templates/workspace/objections.html`(신규)·`static/workspace/objections.js`(신규)에 배지, 출처 버전·발췌, 자기 점검/독립 검토 표시, 확인/override 대화를 만든다. `agents/reviewer.md`·`skills/*/SKILL.md`에 반대 의견 절차를 넣는다.
  - [ ] `tests/stage4/objections.test.ts`, `tests/stage4/approval_guard.test.ts`, `tests/e2e/stage4_objections.spec.ts`를 만든다.
- **선행 이슈**: U3, U4, PR 5, PR 6, PR 10, PR 14, PR 19, PR 20a·20b·20c.
- **완료 기준**:
  - [ ] `결정 뒤 확정할 TS 테스트 명령 tests/stage4/objections.test.ts tests/stage4/approval_guard.test.ts` 통과. `npx playwright test tests/e2e/stage4_objections.spec.ts` 통과.
  - [ ] 정확한 출처 인용, 자기 점검/독립 검토 구분, 확인 없이 승인 불가, override 대상 버전 고정, reviewer 실패·Go 사용량 문턱, 옛 확인 미승계가 확인된다. 여섯 경로에서 같은 반대 의견 계약이 통과한다. `결정 뒤 확정할 TS 테스트 명령` 전체 통과.
- **지킬 것**: AI 거부권 없음. 반대 의견만으로 자동 stale·자동 reopen 금지. 확인은 UI 체크가 아니라 서버 tx 가드. 반대 의견·override 기록을 삭제하지 않는다. 실제 자료를 로그·PR에 넣지 않는다. PR20a·20b·20c의 여섯 자격·전송 계약을 재사용하고 Codex CLI·OpenCode TUI·Codex 앱·OpenCode 앱을 6단계로 미루지 않는다.

## 8. [4단계] U11 — 직접 편집·제안 화면

- **목표 한 줄**: 결과 글을 Markdown+미리보기로 직접 고치거나 제안으로 남기고, 충돌·stale·재승인·앵커 재판정을 화면에서 안전하게 처리한다.
- **할 일**:
  - [ ] `src/web/workspace.ts`에 `render_editor()`, `render_suggestion()`, `post_revise()`, `post_proposal_accept()`, `post_proposal_reject()`, `show_conflict()`, `reresolve_anchors()`를 추가한다. PR 25 API만 호출한다.
  - [ ] `templates/workspace/editor.html`(신규), `templates/workspace/_editor_toolbar.html`(신규), `templates/workspace/_diff.html`(신규), `static/workspace/editor.js`(신규)를 만든다. 모드 전환(직접/제안), Markdown+미리보기, 표 원문 편집, 버전 비교, 충돌 대화, 제안 수락·거절+이유, stale·재승인 안내를 구현한다.
  - [ ] 새 버전 뒤 `anchors`·`anchor_resolutions` 재판정 결과(exact/moved/ambiguous/lost)를 표시하고, 원 앵커·인용문·원 버전은 보존한다. 옛 기반 제안은 충돌로 표시하고, 재기반은 사용자가 확인하는 새 요청으로 만든다.
  - [ ] **고정 승인·게시 스냅숏은 읽기 전용**으로 보이고, **현재 원고는 새 버전으로 편집**할 수 있다. 새 버전 저장 시 PR 6 규칙(현재 승인 포인터 해제·과거 승인 보존·해당/후속 단계 stale·재승인)을 화면에 안내하고, 완료 판은 완료 해제 또는 새 판 안내만 한다. 모바일은 새 편집 기능만 제한하고 기존 답·의견·오류 확인·인쇄 미리보기·복사 대안은 유지한다.
  - [ ] 초안·IME·초점을 보존하고, 409·타임아웃·응답 유실은 같은 키로 확인하며 성공은 서버 영수증 뒤에만 표시한다.
  - [ ] `tests/stage4/workspace_editor.test.ts`와 `tests/e2e/stage4_editor.spec.ts`를 만든다.
- **선행 이슈**: PR 25, U1, U4.
- **완료 기준**:
  - [ ] `결정 뒤 확정할 TS 테스트 명령 tests/stage4/workspace_editor.test.ts` 통과. `npx playwright test tests/e2e/stage4_editor.spec.ts` 통과.
  - [ ] 직접/제안 왕복, 원문 덮어쓰기 없음, 승인본 보호, 앵커 보존, 재기반, IME·409·응답 유실, 수락 결과 버전·tx가 제안 기반/대상과 일치, 기존 모바일 답 기능 회귀가 확인된다. **현재 원고의 새 버전 편집과 고정 승인/게시 스냅숏 읽기 전용이 구분**되고, 저장 시 현재 승인 포인터 해제·과거 승인 보존·해당/후속 단계 stale·재승인이 확인된다. `결정 뒤 확정할 TS 테스트 명령` 전체 통과.
- **지킬 것**: 완전한 WYSIWYG·실시간 공동 편집을 만들지 않는다. 직접 편집은 항상 새 버전. 승인본을 그 자리에서 고치지 않는다. 화면에서 DB를 직접 쓰지 않는다.

## 9. [4단계] U12 — 기존 화면 기본 대체·롤백

- **목표 한 줄**: 검증 게이트를 통과한 프로젝트부터 새 작업 공간을 기본 진입으로 켜고, `/legacy`·기존 ask 링크·고정 HTML·미전환 프로젝트 안내로 안전하게 되돌린다.
- **할 일**:
  - [ ] `src/cli/pes.ts`의 `cmd_serve`, `cmd_open`, `cmd_list`, `cmd_home`과 `src/server/serve.ts`의 `do_GET`을 수정해 루트·`/p/<slug>/...`는 작업 공간으로, `/legacy`는 기존 화면으로 보낸다. `pes serve --legacy`를 추가한다. 기존 `ask-<id>.html`은 당시 set/버전으로 리디렉션하고, 없으면 다른 버전으로 조용히 대체하지 않고 안내한다.
  - [ ] PR 23의 004에서 만든 `projects.settings_json`을 읽어 `workspace_default`(`off/opt_in/default/legacy`)를 저장·조회한다. 변경은 `src/core/commands.ts`를 통해 rev·영수증·사건과 함께 저장하고, `src/cli/pes.ts`·`src/server/serve.ts`가 DB를 직접 쓰지 않는다. U12는 새 마이그레이션을 만들지 않고, 화면 상태는 `opt_in`·`default`·`legacy` 세 가지로 표시한다.
  - [ ] `src/web/workspace.ts`에 `render_legacy_notice()`, `resolve_entry()`, `workspace_state()`를 추가하고, `templates/workspace/_legacy_notice.html`(신규)·`templates/hub.html`의 링크를 갱신한다. 미전환 프로젝트는 2단계 2.5의 legacy 읽기 경로로 안내하고 오류·빈 화면을 내지 않는다.
  - [ ] `tests/stage4/workspace_switch.test.ts`, `tests/stage4/legacy_links.test.ts`, `tests/e2e/stage4_switch.spec.ts`를 만든다.
- **선행 이슈**: PR 23, U1~U4, U6, PR 18, PR 21, U5. T1은 채택했을 때만 게이트 입력으로 쓴다.
- **완료 기준**:
  - [ ] `결정 뒤 확정할 TS 테스트 명령 tests/stage4/workspace_switch.test.ts tests/stage4/legacy_links.test.ts` 통과. `npx playwright test tests/e2e/stage4_switch.spec.ts` 통과.
  - [ ] 게이트 체크리스트(읽기·답·승인·reopen·인쇄·딥링크, Windows/Mac, 미제출 답·초안 보존)가 통과하고, opt-in→기본 전환·롤백이 동작한다. `workspace_default` 변경이 검증 명령의 rev·영수증·사건으로 남는다. 기존 화면 유지 기간(최소 한 마이너 버전)이 릴리스 문서에 적힌다.
  - [ ] `/legacy`는 같은 새 DB/API 위의 화면 복귀이고 데이터 되돌리기가 아님. 기존 ask 링크·고정 HTML·미전환 legacy 안내가 유지되고, 이중 쓰기가 없다. 세 상태가 같은 의미로 보인다. `결정 뒤 확정할 TS 테스트 명령` 전체 통과.
- **지킬 것**: `--legacy`를 데이터 복원으로 설명하지 않는다. 기존 화면은 4단계에 삭제하지 않고 최소 한 마이너 버전 유지한다(제거는 6단계 별도 결정). 실제 프로젝트 1개 확인을 숨은 필수 조건으로 만들지 않는다(T1 조건부). 고정 HTML 보존 약속을 해제하지 않는다. 두 화면이 같은 DB/API를 쓰고 이중 쓰기는 하지 않는다.
