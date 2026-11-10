# legacy → 1단계 DDL 필드 대응표 (2단계 PR 11)

현행 `project.json`·`library.json`·프로젝트 폴더 파일을 [stage-1-ddl-draft.sql](schemas/stage-1-ddl-draft.sql)의 표·열로 옮길 때의 필드 대응이다. 2단계 PR 11(legacy importer)의 입력이며, [stage-1-db.md](stage-1-db.md) 5절(128–134행)의 절차와 [baseline.md](baseline.md) 4절(106–141행)의 보존 파일 목록을 따른다.

- 이 문서는 **코드가 아니라 이전 계약**이다. DDL 초안이 바뀌면 이 표도 같이 고친다.
- 실제 `~/pes-projects`·`~/.pes/`는 읽지 않았다. 예시는 합성 자료 기준이다.
- 새 표·열을 만들지 않는다. 새 열이 필요한 값은 `legacy_extra`(JSON)나 이전 보고서에 남긴다.
- 기본값 보완을 과거의 명시 결정처럼 꾸미지 않는다([stage-1-db.md](stage-1-db.md):129).

## 0. 근거 약어와 `legacy_extra` 규칙

| 약어 | 문서 |
|---|---|
| `P:` | [schemas/project-v0.15.json](schemas/project-v0.15.json) |
| `B:` | [baseline.md](baseline.md) |
| `DB:` | [stage-1-db.md](stage-1-db.md) |
| `DDL:` | [schemas/stage-1-ddl-draft.sql](schemas/stage-1-ddl-draft.sql) |
| `S2:` | [stage-2.md](stage-2.md) |
| `I2:` | [issues/stage-2.md](issues/stage-2.md) |
| `X:` | [discussion/stage-1-db-codex.md](discussion/stage-1-db-codex.md) |

`legacy_extra`는 **미지원 필드를 버리지 않기 위한 JSON 보관소**다. 새 업무 로직의 허용 필드로 자동 승격하지 않는다(`X:307`). 저장 위치는 다음으로 고정한다.

| 대상 | `legacy_extra` 위치 |
|---|---|
| 항목·보고서·리뷰·메모 등 객체 | `artifact_versions.metadata_json.legacy_extra` |
| 출처 | `source_versions.locator.legacy_extra` |
| 단계 | `stages.settings_json.legacy_extra` |
| 판·프로젝트 수준 | `editions.settings_json.legacy_extra` (`projects`에 JSON 열이 없으므로 1판에 둔다) |
| 라운드·스냅숏 | 스냅숏 manifest blob의 JSON |
| 파일 단위(피드백·ask·rounds·보고서) | 원문 blob + `import_batches.report_blob_id` 보고서 |

공통 표식은 `legacy_extra.legacy_unverified = true`다. DDL의 `legacy_unverified`는 `approvals.assurance`에만 있으므로, 그 밖의 값은 이 표식과 `original`(원문 값)을 함께 남겨 화면이 "이전 값·확인 불가"로 표시하게 한다. 원문 값은 `original`, 원래 경로는 `source_path`에 둔다.

## 1. 이전 단위와 식별자

| 항목 | 규칙 | 근거 |
|---|---|---|
| 이전 단위 | 프로젝트 폴더 하나 = `import_batches` 하나. `source_fingerprint`는 폴더 manifest(경로·크기·sha256)의 hash | `DB:115`, `X:393` |
| 재실행 | 같은 `source_fingerprint`는 기존 배치를 돌려주고 새 객체를 만들지 않는다. 원본이 바뀌면 새 배치 | `X:393` |
| 프로젝트 ID | 새 UUID. `projects.slug`는 원본 `slug`. 다른 프로젝트와 slug가 겹치면 덮어쓰지 않고 배치를 `failed`로 두고 보고 | `DDL:35-55`, `P:37-40` |
| 프로젝트 소유자·초기 정책 | 이전을 실행·승인한 **현재 owner human**을 `projects.owner_user_id`·`project_members(role='owner')`에 넣고, 같은 tx에서 `project_policy_versions(allow_opencode_go=1, changed_by=owner actor, changed_by_kind='human', reason='legacy default', tx_id=import tx)`·`projects.current_policy_id`를 만든다. 확인할 수 없으면 `staging`에 두고 활성화하지 않는다. 초기 정책은 "이전 기본값" 새 버전이며 과거 동의로 표시하지 않는다. 원문 표식은 `editions.settings_json.legacy_extra.policy_default`에 둔다 | `DB:215`, `DDL:35-77`, `DDL:113-132` |
| 항목 번호 | 옛 `items[].id`는 단계 안에서만 유일하므로 `objects.display_no`로 재사용하지 않는다. 새 번호는 `counters`로 발급하고, 옛 번호는 `legacy_mappings.legacy_key`와 `metadata_json.legacy_extra.legacy_id`에 남긴다 | `P:355-358`, `DDL:134-139` |
| 질문 ID | 새 UUID. 옛 문자열 id는 `questions.bank_key`와 `legacy_mappings(legacy_kind='question', legacy_scope=<stage>, legacy_key=<id>)`에 남긴다 | `P:550-553`, `DDL:468-484` |
| 피드백 파일 | 파일명은 `legacy_mappings(legacy_kind='feedback_file', legacy_key=<파일명>)`에, 새 `submissions.id`는 `new_row_id`에 남긴다 | `B:114`, `DDL:526-540` |
| content hash | 옛 레코드의 canonical JSON(키 정렬, UTF-8) sha256. 같은 키·다른 내용을 구분한다 | `DDL:971-988` |

## 2. `project.json` 최상위

| 옛 경로 | 새 표.열 | 변환 규칙 | `legacy_extra` 보존 | 모르는 값 처리 | 근거 |
|---|---|---|---|---|---|
| `pes` | 없음 | 열을 만들지 않는다. 값 `1`은 호환성 증거가 아니다 | `editions.settings_json.legacy_extra.pes` | `1`이 아니어도 읽기를 막지 않고 보고서에 남긴다 | `P:29-32`, `X:307` |
| `topic` | `projects.topic` | 문자열 그대로 | 없음 | 없거나 비면 `'(주제 없음)'` + `legacy_unverified` | `P:33-36`, `DDL:35-55` |
| `slug` | `projects.slug` | 문자열 그대로. 서버 경로·폴더 이름과 충돌하면 배치 실패 | 원본 폴더명이 다르면 `legacy_extra.folder_name` | 빈 값·중복은 실패로 처리 | `P:37-40`, `B:112` |
| `created` | `projects.created_at` | `YYYY-MM-DD`를 UTC epoch ms로. 날짜만 있으면 00:00 UTC로 두되 **원문과 정밀도를 남긴다** | `legacy_extra.created_original` | 파싱 불가·없음은 `created_at=0`(센티널) + `legacy_unverified`; 이전 시각으로 바꾸지 않는다 | `P:41-45`, `X:416` |
| `current` | `editions.current_stage_id` | `stages.key`가 같은 행의 id를 넣는다 | `legacy_extra.current_original` | 단계 키가 아니면 NULL + 보고. 임의로 plan을 넣지 않는다 | `P:46-56`, `DDL:141-158` |
| `settings` | `editions.settings_json` | 객체를 그대로. `stage_reports`도 여기 | `settings_json.legacy_extra` | 알 수 없는 키는 `legacy_extra`로. 시작 질문 답은 ask/feedback 증거가 있을 때만 `answers`로 승격 | `P:57-61`, `DB:129` |
| `processed` | `events`(type=`legacy.processed`) + `legacy_mappings` | 파일명 하나당 event 하나. 대응하는 `submissions`가 있으면 `legacy_mappings.new_row_id`에 그 id | `legacy_extra.files` | 대응 파일이 없으면 event와 보고서에만 남긴다(버리지 않음) | `P:62-68`, `B:114` |
| `complete` | `approvals` + `editions.status` | `true`면 publish 단계 승인 행(`origin='legacy'`, `assurance='legacy_unverified'`, actor `legacy_unknown`, `human_user_id=NULL`)과 `editions.status='completed'` | `legacy_extra.complete_original` | `false`·없음은 완료로 만들지 않는다. `true`인데 승인 시각·스냅숏이 없으면 센티널·합성 스냅숏 + 표식 | `P:69-72`, `DB:208`, `DDL:252-273` |
| `executive_summary` | 최종 보고서 `artifact_versions.summary` | edition 범위 `artifacts.kind='report'` 하나에 넣는다 | `metadata_json.legacy_extra.executive_summary` | 없으면 NULL. 다른 보고서 요약과 섞지 않는다 | `P:73-76` |
| `conclusion` | 최종 보고서 `artifact_versions.metadata_json.conclusion` | 본문과 분리해 보존. `body_md` 재구성 시 뒤에 붙인다 | `legacy_extra.conclusion` | 없으면 NULL | `P:77-80` |
| `notes[]` | `artifacts.kind='note'` + `artifact_versions` | 메모 하나 = 객체 하나. `text`→`body_md`, `time`→`object_versions.created_at`, `stage`→`artifacts.stage_id` | `metadata_json.legacy_extra.note` | `time` 파싱 불가·없음은 `object_versions.created_at=0` + 표식. `stage` 불명은 NULL | `P:81-87`, `DDL:333-371` |
| `stages` | `stages` 6행 | `plan`…`publish`를 `ordinal` 1…6으로. 빠진 단계는 `pending` 기본값으로 채우되 **보완 사실을 표시** | `settings_json.legacy_extra.stage_defaults` | 단계 키가 6개 밖이면 `legacy_extra` + 보고. 새 단계를 만들지 않는다 | `P:88-120`, `DDL:161-188` |
| `library` (project.json 안) | `library.json`과 같은 규칙 | 4절을 따른다. 정상 저장 파일에는 없으므로 있으면 구버전 흔적으로 본다 | `editions.settings_json.legacy_extra.inline_library` | 없으면 무시 | `P:121-124`, `B:113` |
| 그 밖의 최상위 키 | 없음 | 열을 만들지 않는다 | `editions.settings_json.legacy_extra.<key>` | 전부 보존하고 새 로직의 허용 필드로 쓰지 않는다 | `P:126`, `X:307` |

## 3. `stages.<stage>`

`stages` 6행은 항상 만든다. `status`·`approved_at`·`stale`은 서로 모순될 수 있으므로 **증거가 있는 쪽을 우선**하고, 보완한 값은 `legacy_unverified`로 표시한다.

| 옛 경로 | 새 표.열 | 변환 규칙 | `legacy_extra` 보존 | 모르는 값 처리 | 근거 |
|---|---|---|---|---|---|
| `status` | `stages.status` | `pending/asking/active/approved`는 그대로 | `settings_json.legacy_extra.status_original` | 값이 다르면 `approved_at`·`round`·답 존재로 유도하고, 유도 불가면 `pending` + `legacy_unverified` | `P:205-213`, `DDL:161-188` |
| `round` | `rounds.round_no` + `stages.current_round_id` | 1…N 라운드를 만든다. 현재 라운드는 `state='open'`, 지난 라운드는 `sealed` | `settings_json.legacy_extra.round_original` | `0`이면 라운드 없음. 스냅숏 파일이 없는 지난 라운드는 **빈 manifest + `legacy_unverified` 스냅숏**으로 봉인하고 `round_contents`는 만들지 않는다 | `P:214-218`, `DDL:190-210` |
| `settings` | `stages.settings_json` | 객체 그대로. 시작 질문 답도 여기 | `settings_json.legacy_extra` | ask/feedback 증거가 없으면 `answers`로 승격하지 않는다(U2 미확인) | `P:219-223`, `B:150` |
| `review.round` | `object_versions.created_in_round_id` | 해당 `round_no`의 라운드 id | `metadata_json.legacy_extra.review_round` | 라운드가 없으면 NULL + 보고 | `P:523-527` |
| `review.summary` | `artifact_versions.summary` | `kind='review'` 객체의 요약 | `metadata_json.legacy_extra.review` | 없으면 빈 문자열 | `P:528-531` |
| `review.questions[]` | `questions` + `question_versions` + `question_sets(purpose='review')` | 질문 하나 = 객체 하나. **공통 필드는 3.1을 따른다.** `origin='review'`, `purpose='review'` | `metadata_json.legacy_extra.review_question` | 3.1과 같다 | `P:532-539`, `DDL:451-524` |
| `suggestions[]` | `questions(origin='import')` + `question_versions(state='deferred')` 또는 `threads/messages` | `[#id] 질문` 꼴이면 질문, 그 밖의 제안은 일반 스레드 메시지 | `metadata_json.legacy_extra.suggestion` | 질문 id를 찾지 못하면 `bank_key`에 원문 id + `legacy_unverified` | `P:251-257` |
| `warnings[]` | `events(type='legacy.warning')` | 경고 하나 = event 하나. `payload`에 원문 | `legacy_extra.warnings` | 항목 모양 미확인(P:258-262)이므로 원문 그대로 | `P:258-262`, `DDL:903-928` |
| `changes[]` | `events(type='legacy.change')` | 줄 하나 = event 하나. `payload.line` | `legacy_extra.changes` | 없으면 만들지 않는다 | `P:263-269` |
| `history[]` | `events(type='legacy.history')` | 줄 하나 = event 하나. 파싱 가능한 라운드·승인·reopen 정보는 `payload`에 구조화 | `legacy_extra.history` | 해석 불가는 원문만. 의미 event를 중복 생성하지 않는다 | `P:270-276` |
| `summary` | 단계 보고서 `artifact_versions.summary` | `kind='report'`, `stage_id` 있는 객체 하나에 넣는다 | `metadata_json.legacy_extra.stage_summary` | 없으면 빈 문자열 | `P:277-280` |
| `approved_at` | `approvals` + import `mutation_commits.created_at`/`events.created_at` | 승인 행의 tx를 import tx로 두고 시각을 event에 남긴다. `stages.approved_snapshot_id`도 채운다 | `legacy_extra.approved_at_original` | 시각이 없으면 0 센티널 + 표식. `status='approved'`인데 승인 행이 없으면 **승인 상태는 보존**하되 `legacy_unverified` | `P:281-287`, `DDL:252-273` |
| `stale` | `stages.stale_since_event_seq` | `true`면 reopen event(없으면 import event)의 `event_seq` | `legacy_extra.stale_original` | `false`·없음은 NULL | `P:288-291`, `DDL:161-188` |
| `reports[]` | `artifacts.kind='report'` + `version_files(role='rendered')` | `format`→`metadata_json.format`+`blobs.media_type`, `label`→`metadata_json.label`, `path`→blob, `bytes`→`blobs.size`, `round`→`created_in_round_id` | `metadata_json.legacy_extra.report` | 파일이 없으면 blob 없이 보고서에만 남긴다. 경로를 식별자로 쓰지 않는다 | `P:292-298`, `B:124-127`, `DDL:212-224` |
| `reports_built` | `artifact_versions.metadata_json.reports_built` | 문자열 그대로 | `legacy_extra.reports_built` | 없으면 NULL | `P:299-302` |
| `qa[]` | `artifacts.kind='review'` + `metadata_json.qa` | QA 객체 전체를 보존. `round`→`created_in_round_id`, `recorded`→event 시각 | `metadata_json.qa` | 하위 모양이 미확인이므로 열로 쪼개지 않는다 | `P:303-309`, `P:832-889` |
| `review_log[]` | `artifacts.kind='review'`의 버전 | 항목 하나 = review 버전 하나 | `metadata_json.review_log` | 없으면 만들지 않는다 | `P:310-316` |
| `carry_over[]` | `followups(kind='next_round_task')` + `followup_versions` | `request`→`description`, `target_stage_id`=**담은 단계의 다음 단계**(plan→research→analyze→write→verify→publish), `item`→`legacy_mappings`로 찾은 **담은 단계 항목**의 `base_artifact_version_id` | `stages.settings_json.legacy_extra.carry_over` (원문 `from` 포함) | **`from`은 target이 아니다.** 스키마는 `from` 의미를 정의하지 않았고, 스킬은 승인한 단계에 carry_over를 두고 "다음 단계 R1에서 먼저 처리"한다(`skills/core/SKILL.md:133`, `scripts/pes.py:852`). 다음 단계가 없으면(publish) 행을 만들지 않고 원문을 `legacy_extra`·보고서에 보존한다. 과거 수락을 증명할 수 없으므로 `state='proposed'` + 표식 | `P:317-342`, `DDL:748-796`, `skills/core/SKILL.md:133`, `scripts/pes.py:852` |
| 그 밖의 단계 키 | 없음 | 열을 만들지 않는다 | `stages.settings_json.legacy_extra.<key>` | 전부 보존, 자동 승격 금지 | `P:344`, `X:307` |

### 3.1 질문 공통 필드 (`ask/<id>.json`, `review.questions[]`)

두 입력은 같은 `question` 모양을 쓰므로 한 표로 옮긴다. `review`는 `origin='review'`·`question_sets.purpose='review'`, `ask`는 `origin='bank'`(편집 흔적이 있으면 `import`)·`purpose='stage_start'` 또는 `'resume'`이다.

| 옛 경로 | 새 표.열 | 변환 규칙 | `legacy_extra` 보존 | 모르는 값 처리 | 근거 |
|---|---|---|---|---|---|
| `id` | `questions.bank_key` + `legacy_mappings` | 문자열 그대로. `bank_key`는 질문 은행 키에만 쓰고, 충돌·비은행 질문은 `legacy_mappings(legacy_kind='question')`로 찾는다 | `metadata_json.legacy_extra.question_id` | 없으면 새 ID + `legacy_unverified` | `P:550-553`, `DDL:468-484` |
| (없음) | `questions.direction`·`asked_by_actor_id`·`original_version_id` | 질문 은행·리뷰 질문은 `direction='agent_to_human'`, 작성자는 `legacy_unknown`, `original_version_id`는 첫 `question_versions`와 한 tx로 채운다 | `legacy_extra.direction_original` | 없으면 위 기본값 + 표식. `human_to_agent`로 추측하지 않는다 | `DDL:468-484` |
| `label` | `question_versions.text` | 문자열 그대로. 빈 값은 `'(질문 없음)'` + 표식 | `legacy_extra.label_original` | 없거나 비면 센티널 + 표식 | `P:554-557`, `DDL:486-511` |
| `help` | `question_versions.help` | 문자열 그대로 | `legacy_extra.help` | 없으면 NULL | `P:558-561`, `DDL:500` |
| `placeholder` | `metadata_json.legacy_extra.placeholder` | 열이 없으므로 원문만 보존. 화면 힌트로 자동 승격하지 않는다 | `legacy_extra.placeholder` | 없으면 NULL | `P:562-565` |
| `type` | `question_versions.type` | `single/multi/text/textarea`는 그대로. DDL의 `number/scale/file`은 이전 값에 없으므로 추측하지 않는다 | `legacy_extra.type_original` | 허용 밖이면 `text` + `legacy_unverified` | `P:566-574`, `DDL:492` |
| `required` | `question_versions.required` | `true`→1, `false`→0. 필수 응답을 선택으로 낮추지 않는다 | `legacy_extra.required_original` | 없으면 0 + `legacy_unverified`(필수였다고 추측하지 않음) | `P:575-578`, `DDL:495` |
| `default` | `question_versions.default_value` | 값을 JSON으로 직렬화. 기본값은 답으로 자동 제출하지 않는다 | `legacy_extra.default_original` | 없으면 `'null'` | `P:579-581`, `DDL:497` |
| `other` | `metadata_json.legacy_extra.other` | 덧붙임 칸 안내·허용 표시. `allow_comment_as_answer`와 섞지 않는다 | `legacy_extra.other` | 없으면 NULL | `P:582-588`, `DDL:496` |
| (없음) | `question_versions.allow_comment_as_answer` | 현행 호환 질문은 덧붙임만으로도 응답을 인정하므로 1을 기본으로 둔다. 이를 과거의 명시 동의로 꾸미지 않는다 | `legacy_extra.allow_comment_original` | 없으면 1 + 표식 | `DB:209`, `DDL:496` |
| `options` | `question_versions.options` | 배열 전체를 그대로. `recommended`를 미리 답으로 바꾸지 않는다 | `legacy_extra.options` | 없으면 `[]` | `P:589-595`, `DDL:498` |
| `show_if` | `question_versions.show_if` | 객체 그대로. 조건부 질문을 항상 표시로 바꾸지 않는다 | `legacy_extra.show_if` | 없으면 `'null'` | `P:600-619`, `DDL:499` |
| `gap` | `metadata_json.legacy_extra.gap` | `review` 질문의 부족한 점. 열이 없으므로 원문만 보존 | `legacy_extra.gap` | 없으면 NULL | `P:596-599`, `P:644-670` |
| `state` | `question_versions.state` | `ask`는 `open`, `suggestions`에서 온 것은 `deferred`. `questions`에는 `state` 열이 없다 | `legacy_extra.state_original` | 없으면 `open` | `DDL:493` |
| 질문 순서·멤버 | `question_set_members.position` | `ask`·`review`의 질문 배열 순서를 0부터 넣고 `set_id`·`question_version_id`를 연결한다 | `legacy_extra.question_order` | 순서가 없으면 원문 배열 순서 | `DDL:513-524` |

## 4. `items[]` (단계·library 공통)

library 항목은 `edition_id=NULL`(프로젝트 공통)로 두고, 나머지는 같은 규칙을 쓴다. 재사용은 새 판의 새 객체 + `origin_version_id`다(`DB:76`).

| 옛 경로 | 새 표.열 | 변환 규칙 | `legacy_extra` 보존 | 모르는 값 처리 | 근거 |
|---|---|---|---|---|---|
| `id` | `objects.display_no` (새 번호) | `counters(namespace='artifact:<kind>')`로 발급. 옛 id는 매핑에만 | `metadata_json.legacy_extra.legacy_id` | 번호 충돌은 정상. 옛 번호를 그대로 쓰지 않는다 | `P:355-358`, `DDL:134-139` |
| `title` | `artifact_versions.title` | 문자열 그대로. 없으면 `'(제목 없음)'` | `legacy_extra.title_original` | 빈 값은 센티널 + 표식 | `P:359-361` |
| `kind` | `artifacts.kind` | 현행 9종은 그대로(`rq/chapter/topic/issue/table/insight/section/claim/output`) | `metadata_json.legacy_extra.kind_original` | 허용 밖이면 `note` + `legacy_unverified`(중립 보관). 의미를 추측해 승격하지 않는다 | `P:362-376`, `DDL:333-345` |
| `question` | `artifact_versions.question` | 문자열 그대로 | `legacy_extra.question` | 없으면 NULL | `P:377-380` |
| `reuse` | `version_relations(kind='reuses')` | `from`=새 항목 버전, `to`=`legacy_mappings`로 찾은 library 항목 버전 | `legacy_extra.reuse_original` | 대상이 없으면 관계를 만들지 않고 보고 | `P:381-384`, `DDL:385-394` |
| `model` | `metadata_json.legacy_extra.model` (원칙) | 대응하는 `runs` 행이 있으면 `runs.model`도 채운다. 없으면 가짜 run을 만들지 않는다 | `legacy_extra.model` | 허용 값 집합 미확인이므로 원문 보존 | `P:385-388` |
| `status` | `artifact_versions.status` | 7종은 그대로. `removed`는 지우지 않고 `objects.archived_at`도 채운다 | `metadata_json.legacy_extra.status_original` | 허용 밖이면 `new` + `legacy_unverified` | `P:389-400`, `DDL:347-371` |
| `request` | `followups(kind='next_round_task')` + `followup_versions.description` | 대상 단계·라운드를 알 수 있으면 채운다 | `metadata_json.legacy_extra.request` | 대상 단계를 알 수 없으면 **`next_round_task` 행을 만들지 않고** 원문을 `legacy_extra`·보고서에 보존한다. 적용 증거가 없으므로 `state='proposed'` + 표식 | `P:401-404`, `DDL:748-796` |
| `depth` | 없음 | 열을 만들지 않는다. 버전 수와 같다고 단정하지 않는다 | `metadata_json.legacy_extra.depth` | 없으면 NULL | `P:405-409` |
| `updated_round` | `metadata_json.legacy_extra.updated_round` | **생성 라운드가 아니다.** 마지막 갱신 라운드 원문을 보존하고, 그 라운드가 현재 버전의 생성 라운드와 같다는 증거가 있을 때만 `object_versions.created_in_round_id`를 별도로 채운다 | `legacy_extra.updated_round` | 없으면 NULL. 생성 라운드로 추측하지 않는다 | `P:410-414` |
| `summary` | `artifact_versions.summary` | 문자열 그대로 | `legacy_extra.summary` | 없으면 빈 문자열 | `P:415-418` |
| `details` | `artifact_versions.body_md` | 마크다운 그대로. 큰 본문은 blob으로 바꾸지 않는다 | `legacy_extra.details` | 없으면 NULL | `P:419-422` |
| `sources[]` | `sources`/`source_versions`/`citations` | 아래 4.1. URL로 합치지 않는다 | `locator.legacy_extra` | 아래 4.1 | `P:423-429`, `DB:155` |
| `stats[]` | `artifact_versions.stats` (JSON) | 배열 그대로. `name/label` 정규화는 값 보존 범위에서만 | 각 stat 객체 안에 원문 키 보존 | 객체가 아니면 문자열로 감싸 보존 + 표식 | `P:430-436` |
| `shots[]` | `blobs` + `version_files(role='image')` | 경로→파일 hash·크기·media type. 경로는 식별자로 쓰지 않는다 | `legacy_extra.shots` | 파일이 없으면 blob 없이 보고서·`legacy_extra.missing_paths`에 남긴다 | `P:437-443`, `B:122-123` |
| `confidence` | `artifact_versions.confidence` | `high/medium/low` 그대로 | `legacy_extra.confidence_original` | 빈 문자열 `''`는 NULL + 원문 `''` 보존. 임의로 `medium`을 넣지 않는다 | `P:444-452` |
| `conflicts[]` | `artifact_versions.conflicts` (JSON) | 문자열·객체 그대로 | 배열 안에 원문 | 없으면 `[]` | `P:453-462` |
| `verify` | `artifact_versions.verify` (JSON) | 객체 그대로. `claims[]`는 아래 4.2 | `verify.legacy_extra` | JSON이 아니면 `verify='null'` + 원문을 `legacy_extra`에 | `P:463-482` |
| `links` | `version_relations(kind='supports')` | `from`=항목 버전, `to`=대상 항목 버전. 원래 키(단계/library)는 매핑에 | `legacy_extra.links` | 대상이 없으면 관계를 만들지 않고 보고 | `P:483-492`, `DDL:385-394` |
| `user_links[]` | `sources`/`source_versions` | `url`→`url`, `memo`→`locator.memo`, `added`→`locator.added`, `status`→`locator.user_status`. `sources.kind`는 URL이면 `web`, 파일 경로면 `file`. `title`이 없으면 URL/`'(제목 없음)'` + 표식, `method`는 원문 방법이 없으므로 `import` | `locator.legacy_extra` | `todo`→`unverified`, `failed`→`unreachable`, `done`도 출처 검증은 `unverified`(사용자 확인과 원문 검증은 다름) | `P:493-499`, `P:803-831` |
| `verdict` | `metadata_json.legacy_extra.verdict` | 문자열 그대로. `verify.claims`와 섞지 않는다 | `legacy_extra.verdict` | 없으면 NULL | `P:500-503` |
| `order` | `round_contents.position` | 그 라운드에 보인 항목이면 위치를 넣는다 | `metadata_json.legacy_extra.order` | 라운드 증거가 없으면 metadata에만 | `P:504-507`, `DDL:320-331` |
| `path` | `blobs` + `version_files(role='rendered')` | 산출물 파일 hash·크기·media type | `legacy_extra.path` | 파일이 없으면 보고. 경로 문자열을 식별자로 쓰지 않는다 | `P:508-511`, `DDL:441-449` |
| 그 밖의 항목 키 | 없음 | 열을 만들지 않는다 | `metadata_json.legacy_extra.<key>` | 전부 보존, 자동 승격 금지 | `P:513`, `X:307` |

### 4.1 `sources[]`

| 옛 경로 | 새 표.열 | 변환 규칙 | `legacy_extra` 보존 | 모르는 값 처리 | 근거 |
|---|---|---|---|---|---|
| `title` | `source_versions.title` | 문자열 그대로 | `locator.legacy_extra.title` | 없으면 `'(제목 없음)'` + 표식 | `P:676-678` |
| `url` | `source_versions.url` + `sources.canonical_locator` | URL 그대로. **같은 URL이라도 합치지 않는다** | `locator.legacy_extra.url_original` | URL이 없으면 `url=NULL`, `canonical_locator`는 제목·파일 경로 | `P:679-681`, `DB:155` |
| (없음) | `sources.kind` | `method=kosis`→`stat`, `law`→`law`, URL 없이 파일 경로→`file`, 그 밖 URL→`web`. 원문 method는 보존 | `locator.legacy_extra.kind_original` | 판단 불가면 URL 유무로 `web`/`file` + `legacy_unverified` | `DDL:396-404` |
| `method` | `source_versions.method` | 허용 8종(`search/fetch/browser/kosis/law/vworld/import/unknown`)은 그대로 | `locator.legacy_extra.method_original` | 허용 밖이면 `unknown` + 원문 | `P:682-693`, `DDL:415` |
| `date` | `source_versions.locator.date` | 자료 기준일은 `retrieved_at`이 아니다. 원문을 `locator`에 둔다 | `locator.date` | 검색 시각이 명확할 때만 `retrieved_at`을 채운다. 아니면 NULL | `P:694-697`, `X:416` |
| `note` | `source_versions.locator.note` | 문자열 그대로 | `locator.note` | 없으면 NULL | `P:698-700` |
| `orgId` | `source_versions.locator.orgId` | 문자열 그대로 | `locator.orgId` | 없으면 NULL | `P:701-704` |
| `tblId` | `source_versions.locator.tblId` | 문자열 그대로 | `locator.tblId` | 없으면 NULL | `P:705-708` |
| (없음) | `source_versions.verification_state` | 이전 자료는 `legacy_unknown` | `locator.legacy_extra.verification` | 원문에 검증 표시가 있으면 그 값, 없으면 `legacy_unknown` | `DDL:406-427`, `DB:208` |
| (없음) | `citations` | `citation_no` = `sources[]`의 1부터 시작하는 순서. 각주 번호를 보존한다 | `locator.legacy_extra.citation` | 순서가 깨진 입력은 원문 순서를 보고서에 남긴다 | `P:423-429`, `DDL:429-439` |

### 4.2 `verify.claims[]`와 `stats[]` 하위

`verify`는 `artifact_versions.verify` JSON 안에, `stats`는 `artifact_versions.stats` JSON 안에 그대로 둔다. 별도 열을 만들지 않는다.

| 옛 경로 | 새 위치 | 변환 규칙 | 모르는 값 처리 | 근거 |
|---|---|---|---|---|
| `verify.claims[].claim` | `verify.claims[].claim` | 그대로 | 없으면 NULL | `P:943-974` |
| `verify.claims[].verdict` | `verify.claims[].verdict` | `supported/partial/unsupported` 그대로 | 허용 밖이면 `partial` + `legacy_unverified` | `P:952-959` |
| `verify.claims[].evidence` | `verify.claims[].evidence` | 그대로 | 없으면 NULL | `P:960-963` |
| `verify.claims[].source` | `verify.claims[].source` | 그대로 | 없으면 NULL | `P:964-967` |
| `verify.claims[].fix` | `verify.claims[].fix` | 그대로 | 없으면 NULL | `P:968-971` |
| `stats[].name` | `stats[].name` | 그대로 | 없으면 `label`로 보완하고 원문 유지 | `P:717-719` |
| `stats[].label` | `stats[].label` | 그대로 | 없으면 `name`으로 보완 | `P:720-722` |
| `stats[].value` | `stats[].value` | 문자열·숫자 그대로 | 객체·배열이면 문자열화 + 표식 | `P:723-728` |
| `stats[].unit` | `stats[].unit` | 그대로 | 없으면 NULL | `P:729-731` |
| `stats[].period` | `stats[].period` | 그대로 | 없으면 NULL | `P:732-735` |
| `stats[].method` | `stats[].method` | 그대로 | 없으면 NULL | `P:736-739` |
| `stats[].orgId` | `stats[].orgId` | 그대로 | 없으면 NULL | `P:740-742` |
| `stats[].tblId` | `stats[].tblId` | 그대로 | 없으면 NULL | `P:743-745` |

## 5. `library.json`

library 항목은 프로젝트 공통 참고자료이므로 `objects.edition_id=NULL`로 둔다. 항목·출처는 4절과 4.1을 그대로 적용한다. 원본 `library.json`도 blob으로 보존한다(`DB:76`).

| 옛 경로 | 새 표.열 | 변환 규칙 | `legacy_extra` 보존 | 모르는 값 처리 | 근거 |
|---|---|---|---|---|---|
| `source` | `import_batches` + 보고서 | 원천 폴더 경로는 식별자가 아니다. `source_fingerprint`는 manifest hash | `editions.settings_json.legacy_extra.library.source` | 경로가 없으면 빈 문자열 + 표식 | `P:138-141`, `B:113` |
| `imported` | import `events.created_at` | 시각 문자열을 파싱해 event에. `import_batches`에는 시각 열이 없다 | `legacy_extra.library.imported_original` | 파싱 불가·없음은 0 센티널 + 표식 | `P:142-145` |
| `round` | 없음 | 원천 조사의 라운드. 새 라운드로 만들지 않는다 | `legacy_extra.library.round` | NULL 허용 | `P:146-152` |
| `topic` | 없음 | 원천 조사 주제. 프로젝트 `topic`과 섞지 않는다 | `legacy_extra.library.topic` | NULL 허용 | `P:153-159` |
| `settings` | 없음 | 원천 설정. 새 업무 설정으로 승격하지 않는다 | `legacy_extra.library.settings` | 객체 그대로 | `P:160-164` |
| `items[]` | 4절과 동일 | `status='removed'`도 **버리지 않고** `status='removed'` + `archived_at`으로 보존한다. 현행 importer가 removed를 빼는 동작(P:167)과 다르므로 보고서에 차이를 적는다 | 4절 | 4절 | `P:165-171`, `B:113` |
| `suggestions[]` | `questions(origin='import')` + `question_versions(state='deferred')` 또는 `threads/messages` | 단계가 없으므로 `question_sets` 없이 질문만 만들 수 있다. `state`는 `question_versions`에 둔다 | `legacy_extra.library.suggestion` | 질문으로 볼 수 없으면 메시지 | `P:172-176` |
| `warnings[]` | `events(type='legacy.warning')` | 원문 그대로 | `legacy_extra.library.warnings` | 모양 미확인(P:177-181) | `P:177-181` |
| 그 밖의 키 | 없음 | 열을 만들지 않는다 | `legacy_extra.library.<key>` | 전부 보존 | `P:183`, `X:307` |

## 6. 프로젝트 폴더 파일

### 6.1 원본으로 옮기는 파일

| 옛 경로 | 새 표.열 | 변환 규칙 | `legacy_extra` 보존 | 모르는 값 처리 | 근거 |
|---|---|---|---|---|---|
| `feedback/*.json` | `submissions` + `answers`/`answer_versions` | 파일 하나 = submission 하나. `kind`→`legacy_extra.kind`에 보존하고, `review`·`stage_start`·`resume`만 해당 `question_sets.purpose`에 연결한다(`approve`/`reopen`은 아래 행). `stage`·`round`→세트 연결, `who`→확인된 사람만 human actor·아니면 `legacy_unknown`(가짜 사람 금지), `origin`·`via`·`spec`→`raw_blob_id`+`legacy_extra`. `via='import'`, `received_at`은 파일 시각 또는 `feedback.log`에서. 답 키는 `legacy_mappings`로 질문에 연결 | `raw_blob_id` + `legacy_extra.feedback` | 답 키의 질문을 못 찾으면 질문을 `origin='import'`로 만들고 `legacy_unverified`. 답 자체는 버리지 않는다 | `B:114`, `DDL:526-576` |
| `feedback`의 `qid__other` | `threads(context_kind='question_comment')` + `messages`/`message_versions` | 선택 없이 덧붙임만 있던 입력도 메시지로 보존. 답으로 바꾸지 않는다. `target_object_id`=질문 객체, `target_version_id`=당시 질문 버전, `anchor_id=NULL`, `messages.submission_id`=같은 feedback의 submission | `legacy_extra.other` | 질문이 없으면 `origin='import'` 질문 생성 + 표식 | `DB:89`, `P:552` |
| `feedback`의 approve/reopen | `approvals`/`events` | 승인·reopen 요청은 event로 남기고, 승인은 `origin='legacy'`, `assurance='legacy_unverified'` | `legacy_extra.approval` | 요청만 있고 승인 증거가 없으면 승인으로 만들지 않는다 | `DB:208`, `DDL:252-273` |
| `feedback.log` | `events(type='legacy.feedback_log')` | 줄 하나 = event 하나. 시각·순서를 보존 | `legacy_extra.feedback_log` | 해석 불가 줄은 원문만. 재생성 가능하지만 원문을 남긴다 | `B:115` |
| `ask/<id>.json` | `questions`/`question_versions`/`question_sets`/`question_set_members` | 파일 하나 = 질문 세트 하나. **질문 필드는 3.1을 따른다.** `form_key`=`ask/<id>`(파일명), `version_no=1`, `published_at`=파일 시각, `purpose`는 `stage_start` 또는 `resume`. `origin='bank'`, 편집 흔적이 있으면 `origin='import'` | `metadata_json.legacy_extra.ask` | 3.1과 같다. 질문 은행 원본과 다른 부분을 보고 | `B:116`, `DDL:451-524` |
| `snapshots/<stage>-R<n>.json` | `snapshots(scope='round')` + `round_contents` | 스냅숏 파일의 항목·버전을 그대로. `manifest_blob_id`=파일 blob, `content_hash`=canonical hash | manifest JSON의 `legacy_extra` | 파일이 없거나 깨졌으면 빈 manifest + `legacy_unverified`. 내용을 추측해 채우지 않는다 | `B:118`, `DDL:226-250` |
| `rounds/<stage>-R<n>/<id>.json` | `blobs` + `version_files(role='source')` | merge된 결과와 hash가 맞으면 해당 `object_version`에 붙인다. 맞지 않으면 원문 blob만 보존 | `legacy_extra.round_result` | 대응 버전을 못 찾으면 새 버전을 만들지 않고 보고 | `B:119`, `DDL:441-449` |
| `rounds/<stage>-R<n>/qa.json` | `artifacts.kind='review'` + `metadata_json.qa` | QA 객체 전체 보존. `round`→`created_in_round_id` | `metadata_json.qa` | 모양 미확인이므로 열로 쪼개지 않는다 | `B:121`, `P:832-889` |
| `shots/*` | `blobs` + `version_files(role='image')` | 파일 hash·크기·media type. 항목 `shots[]`와 연결 | `legacy_extra.shot` | 누락 파일은 보고서에 남긴다 | `B:122`, `DDL:212-224` |
| `library/shots/*` | `blobs` + `version_files(role='image')` | library 항목 버전에 연결. 경로 앞 `library/`는 storage key에만 반영 | `legacy_extra.library_shot` | 누락 파일은 보고서 | `B:123` |
| `reports/<stage>/eli5.json` | `blobs` + `metadata_json.format='eli5'` | 손으로 쓴 그림 설명이므로 원문 보존 | `metadata_json.legacy_extra.eli5` | 깨진 JSON은 blob만 + 보고 | `B:126` |
| `reports/<stage>/report.docx`·`.hwpx`·`.pdf`·`.pptx` | `blobs` + `version_files(role='rendered')` | 변환물은 원본으로 취급. hash·크기·media type | `metadata_json.legacy_extra.report_file` | 파일이 없으면 보고 | `B:127` |
| `out/report.md`·`out/sources.json` | `blobs` (+ 필요 시 report 버전) | 재생성 가능하지만 원문과 재생성 결과가 다르면 원문 blob을 보존 | `legacy_extra.out` | `sources.json`에만 있는 출처는 버리지 않고 보고 | `B:128` |
| `out/cover.json` | `blobs` + `metadata_json.cover` | 표지 정보(연구진·기관·발주처)는 손 저작물이므로 원문 보존 | `metadata_json.cover` | 깨진 JSON은 blob만 | `B:130` |
| `out/appendix.md` | `blobs` + `metadata_json.appendix` | 작성 경로가 미확인(U6)이므로 원문 보존. `out/report.md`에 자동 병합하지 않는다 | `metadata_json.appendix` | 없으면 만들지 않는다 | `B:131`, `B:154` |
| `out/appendix-sources.md` | `blobs` + `metadata_json.appendix_sources` | 부록 출처 원고. `web`이 읽지 않는 결함 후보 23을 기록 | `metadata_json.appendix_sources` | 없으면 만들지 않는다 | `B:132` |
| `out/report.hwpx`·`.docx`·`.pdf`·`.pptx`, `out/slides.pptx`, `out/report-uri.md` | `blobs` + `version_files(role='rendered')` | 최종 산출물·변환 사본. hash·크기·media type | `metadata_json.legacy_extra.output` | 파일이 없으면 보고 | `B:133` |

### 6.2 재생성·휘발이라 옮기지 않는 파일

아래 파일은 표에 넣지 않는다. 폴더 manifest에 hash만 남기고, 원문과 재생성 결과가 다르면 blob으로 보존한다. 차이는 이전 보고서에 적는다.

| 옛 경로 | 처리 | 근거 |
|---|---|---|
| `ask-*.html` | 재생성. `ask/<id>.json`과 템플릿에서 다시 만든다 | `B:117` |
| `rounds/<stage>-R<n>/qa-brief.md`, `digest.txt`, `self-review.json` | 재생성. `self-review.json`이 현재 상태와 다르면 blob 보존 | `B:120` |
| `reports/<stage>/report.md`, `report.html` | 재생성. 원문 hash가 다르면 blob 보존 | `B:124` |
| `reports/<stage>/eli5.html` | `eli5.json`에서 재생성 | `B:125` |
| `out/report.html` | 재생성 | `B:129` |
| `index.html` | `project.json`에서 재생성 | `B:134` |
| `.pes-lock` | 휘발. 옮기지 않는다 | `B:135` |
| `project.json.tmp` | 휘발 후보. 내용이 본 파일과 다르면 **quarantine blob** + 보고. 자동으로 최신 상태로 채택하지 않는다 | `B:136` |
| `.pes-port`, `.pes-server` | 휘발. 옮기지 않는다 | `B:137` |
| 홈 수준 `index.html`, `.pes-hub*` | 프로젝트 밖. 이전 대상이 아니다 | `B:139` |

## 7. 모르는 값·미확인 값 처리

| 상황 | 처리 | 근거 |
|---|---|---|
| 작성자 불명 | `actors.kind='legacy_unknown'`, `user_id=NULL`. 가짜 사람을 만들지 않는다 | `DB:208`, `DDL:20-33` |
| 옛 승인 | `approvals.origin='legacy'`, `assurance='legacy_unverified'`, `actor_kind='legacy_unknown'`, `human_user_id=NULL`. 새 승인과 같은 인증으로 표시하지 않는다 | `DB:208`, `DDL:252-273` |
| 출처 검증 상태 불명 | `source_versions.verification_state='legacy_unknown'` | `DDL:406-427` |
| 출처 method 불명 | `method='unknown'` + 원문 | `DDL:406-427` |
| enum 값이 허용 밖 | 가장 중립적인 허용 값 + `legacy_unverified` + `original`. 의미를 추측해 승격하지 않는다 | `X:307`, `DB:129` |
| 날짜·시각 파싱 불가 | `0` 센티널 + 원문·정밀도·시간대 불확실성 기록. 이전 시각으로 바꾸지 않는다 | `X:416` |
| 빈 `confidence` | NULL + 원문 `''`. `medium`을 임의로 넣지 않는다 | `P:444-452` |
| 파일 누락 | blob을 만들지 않고 `legacy_extra.missing_paths` + 이전 보고서에 남긴다 | `DB:129` |
| 깨진 JSON | 프로젝트 `project.json`이 깨지면 배치 `failed`(진행 불가). 그 밖의 파일은 원문 blob + 보고로 계속 | `DB:129`, `B:153` |
| `pes: 1` | 정규화·호환성 증거로 쓰지 않는다 | `P:29-32`, `X:307` |
| `load()`가 채운 기본값 | `legacy_extra.stage_defaults` 등에 "보완됨"으로 표시. 과거의 명시 결정처럼 꾸미지 않는다 | `P:5`, `DB:129` |
| 같은 URL의 출처 | 합치지 않는다. 각각 `sources` 객체 | `DB:155` |
| `processed`에만 있는 파일명 | event·보고서에 남긴다. 대응 답을 모르면 `answers`로 만들지 않는다 | `P:62-68` |

## 8. 이전 절차 (DB 5절)

1. **원본 고정**: 폴더 manifest(경로·크기·sha256)와 폴더 hash를 기록한다. 원본은 읽기만 한다(`DB:128`).
2. **배치 시작**: `import_batches(state='staging', source_schema, importer_version, source_manifest_blob_id, source_fingerprint)`를 만든다. 같은 fingerprint면 기존 배치를 돌려준다(`X:393`).
3. **이전 주체**: `legacy_unknown` actor와 import `mutation_commits(via='import')`/`events` tx를 만든다. 모든 이전 행의 actor·tx가 이 값을 가리킨다.
4. **판·단계**: `projects(status='staging')` → `editions` 1판 → `stages` 6행 → `rounds`·`snapshots`. 순환 FK는 staging + NULL 포인터로 시작해 같은 트랜잭션에서 채운다(`DB:215`). 같은 tx에서 `projects.owner_user_id`·owner 멤버·초기 정책을 만들고, `complete=true`가 아니면 `editions.status='active'`·`projects.active_edition_id`=1판으로 둔다. `complete=true`면 `editions.status='completed'`·활성 판 포인터 NULL로 둔다.
5. **내용**: `objects`/`object_versions`/`artifacts`/`artifact_versions`/`sources`/`citations`/`blobs`/`version_files`.
6. **질문·답**: `questions`/`question_versions`/`question_sets`/`submissions`/`answers`/`threads`/`messages`. `__other`와 자유 의견을 보존한다(`DB:89`).
7. **승인**: 옛 승인은 `legacy_unverified`로. 승인 스냅숏이 없으면 현재 상태에서 합성하고 `legacy_unverified` 표식을 manifest에 남긴다.
8. **검증**: 9절. 통과 전에는 `activated`로 바꾸지 않는다.
9. **활성화**: `import_batches.state='validated'` → `'activated'`, `projects.status='active'`. 이후 원본 JSON은 읽기 전용(`DB:131`).
10. **되돌리기**: 새 쓰기 전에는 원본 재연결, 새 쓰기 뒤에는 DB 백업에서 복구. 옛 JSON으로 무손실 복귀를 보장하지 않는다(`DB:132`). 구현(PR12)은 `docs/plan/stage-2-db-guarantees.md` 8.10: 새 쓰기 전은 `rollback_before_write`(배치 `failed`·프로젝트 `archived`), 새 쓰기 뒤는 `restore_project`(번들 시점으로 복귀, 손실 범위·`cursor_epoch + 1` 보고).
11. **범위**: 실제 프로젝트 이전은 사용자가 따로 허용한 범위에서만. 2단계 시험은 합성 fixture(`DB:134`).

## 9. 검증과 이전 보고서

이전 보고서(`import_batches.report_blob_id`)에 최소한 다음을 남긴다.

| 검증 | 방법 | 근거 |
|---|---|---|
| 개수 | 단계별 `items` 수 = `objects`/`artifacts` 수, `sources` 수 = `source_versions` 수, `shots` 수 = `version_files(role='image')` 수, `reports` 수 = report `version_files` 수 | `DB:130` |
| 본문 | `summary`·`details`·`report` 본문이 원문과 같은지 hash 비교 | `DB:130` |
| ID·연결 | `legacy_mappings`의 모든 옛 id가 새 객체·버전으로 풀리는지. 끊긴 연결은 보고서에 | `DB:130` |
| 각주 | `citations.citation_no`가 `sources[]` 순서와 같은지 | `DDL:429-439` |
| 파일 | `blobs.sha256`·`size`가 원본 파일과 같은지, 원본 폴더 hash가 안 바뀌었는지 | `DB:128-130` |
| 미처리 답 | `processed`에 없는 `feedback/*.json`이 `submissions`/`answers`에 모두 있는지 | `P:62-68`, `DB:130` |
| 보고서 재생성 | `project.json`에서 다시 만든 `report.md`/`report.html`과 원문의 차이를 보고 | `DB:130`, `B:124` |
| 정직성 | `legacy_unknown`·`legacy_unverified`·`legacy_extra` 표식이 빠진 행이 없는지. 기본값 보완이 명시 결정처럼 보이지 않는지 | `DB:129`, `DB:208` |
| 재실행 | 같은 원본을 두 번 이전해도 객체가 늘지 않는지. 원본이 바뀌면 새 배치인지 | `X:393` |
| 실패 | 깨진 JSON·2MB fixture·누락 이미지에서 배치가 `failed` 또는 `validated`로 끝나고, 원본이 변하지 않는지 | `S2:190`, `I2:180` |

## 10. 하지 않는 것

- DDL에 없는 열을 만들지 않는다. 새 열이 필요하면 이 문서가 아니라 DDL 논의로 올린다.
- `library.json` 원본과 `project.json` 원본을 삭제·수정하지 않는다.
- 실제 `~/pes-projects`·`~/.pes/`를 읽지 않는다. 시험은 합성 fixture만 쓴다.
- Linear 이슈를 만들지 않는다. PR 11의 범위는 `S2:190`·`I2:180`을 따른다.
