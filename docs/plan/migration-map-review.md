# migration-map 동료 검토 — DDL·스키마·보존 규칙 대조

- 대상: [migration-map.md](migration-map.md)(검토 전 268줄)
- 대조: [stage-1-ddl-draft.sql](schemas/stage-1-ddl-draft.sql), [project-v0.15.json](schemas/project-v0.15.json), [stage-1-db.md](stage-1-db.md) 5절·11절
- 작성: 2026-11-05, 동료 검토. 실제 `~/pes-projects`·`~/.pes/`는 읽지 않았다.
- 결과: **문제 12, 고침 12.** 아래 표의 "고침"은 모두 [migration-map.md](migration-map.md)에 반영했다.

## 1. 문제와 고침

| # | 문제 | 위치 | 판정 | 고친 내용 | 근거 |
|---|---|---|---|---|---|
| 1 | `notes[].time`을 `artifact_versions.created_at`으로 보냈지만 그 열은 없다. 메모 시각이 사라지거나 적재가 실패한다. | 2절 `notes[]` | 틀림 | `object_versions.created_at`으로 고치고, 파싱 불가·없음은 `object_versions.created_at=0`으로 표시하게 했다. | `DDL:294-318`, `DDL:347-371` |
| 2 | `suggestions[]`를 `questions(origin='import', state='deferred')`로 적었다. `questions`에는 `state` 열이 없고 `state`는 `question_versions`에 있다. 단계·library 두 곳이 같은 오류다. | 3절 `suggestions[]`, 5절 `library.suggestions[]` | 틀림 | `questions(origin='import')` + `question_versions(state='deferred')`로 고쳤다. | `DDL:468-511` |
| 3 | 질문 공통 필드가 빠졌다. `required`·`default`·`other`·`placeholder`·`gap`과 `questions.direction`·`asked_by_actor_id`·`original_version_id`, `allow_comment_as_answer`가 `review.questions[]`·`ask/<id>.json`에서 설명되지 않았다. 필수 질문이 선택으로 바뀌거나 기본값·덧붙임이 사라질 수 있다. | 3절 `review.questions[]`, 6.1 `ask/<id>.json` | 빠짐 | **3.1 질문 공통 필드** 표를 새로 넣고 두 입력이 그 표를 따르게 했다. `required`→`question_versions.required`(0/1), `default`→`default_value`(JSON), `other`·`placeholder`·`gap`→`metadata_json.legacy_extra`, `direction`·`asked_by_actor_id`·`original_version_id`는 첫 버전과 같은 tx, `allow_comment_as_answer` 기본 1을 명시했다. | `P:550-620`, `DDL:468-511`, `DB:209` |
| 4 | `item.updated_round`를 `object_versions.created_in_round_id`로 보냈다. `updated_round`는 마지막 갱신 라운드이고 `created_in_round_id`는 버전 생성 라운드라 의미가 다르다. | 4절 `updated_round` | 틀림 | `metadata_json.legacy_extra.updated_round`에 원문을 보존하고, 생성 라운드와 같다는 증거가 있을 때만 `created_in_round_id`를 별도로 채우게 했다. | `P:410-414`, `DDL:294-318` |
| 5 | `carry_over[]`·`request`에서 `from`을 모르면 `target_stage_id=NULL`로 두라고 했지만, DDL은 `next_round_task`에 `target_stage_id`를 필수로 요구한다. 적재가 실패하거나 대상이 바뀐다. | 3절 `carry_over[]`, 4절 `request` | 틀림 | 대상 단계를 모르면 **`next_round_task` 행을 만들지 않고** 원문을 `legacy_extra`·이전 보고서에 보존하게 했다. | `DDL:764-796` |
| 6 | `feedback/*.json`의 `kind`·`who`·`stage`·`round`·`origin`·`via`·`spec`이 구조적으로 매핑되지 않았다. `raw_blob_id`만으로는 답 종류·응답자·질문 세트 연결을 재구성하기 어렵다. | 6.1 `feedback/*.json` | 빠짐 | `kind`→`legacy_extra.kind`+해당 `question_sets.purpose`, `stage`·`round`→세트 연결, `who`→확인된 사람만 human actor·아니면 `legacy_unknown`, `origin`·`via`·`spec`→`raw_blob_id`+`legacy_extra`로 보강했다. | `B:114`, `DDL:526-540`, `DB:208` |
| 7 | `source_versions.method`의 허용 값을 "7종"으로 적었지만 DDL은 `import`·`unknown`을 포함한 8종이다. | 4.1 `method` | 틀림 | 허용 8종(`search/fetch/browser/kosis/law/vworld/import/unknown`)으로 고쳤다. | `DDL:415` |
| 8 | `user_links[]`에서 `source_versions.title`(NOT NULL)과 `method`(NOT NULL)의 값을 정하지 않았다. | 4절 `user_links[]` | 빠짐 | `title`은 URL/`'(제목 없음)'`+표식, `method`는 원문 방법이 없으므로 `import`로 채우게 했다. | `P:803-831`, `DDL:406-427` |
| 9 | 이전 절차에 `projects.owner_user_id`·owner 멤버·초기 정책·`current_policy_id`·`active_edition_id`가 빠졌다. `projects`·`project_policy_versions`의 NOT NULL/FK를 채우지 못해 활성화가 실패하거나, 초기 정책이 과거 동의처럼 보일 수 있다. | 1절 식별자, 8절 4번 | 빠짐 | 1절에 "프로젝트 소유자·초기 정책" 행을 넣고, 8절 4번에서 같은 tx로 owner·초기 정책·활성 판 포인터를 만들게 했다. `complete=true`면 completed·포인터 NULL이다. | `DB:215`, `DDL:35-77`, `DDL:113-132` |
| 10 | `ask/<id>.json`에서 `question_sets.form_key`·`version_no`·`published_at`과 `question_set_members`의 순서·연결을 정하지 않았다. 세트를 만들 수 없다. | 6.1 `ask/<id>.json`, 3.1 | 빠짐 | `form_key=ask/<id>`(파일명), `version_no=1`, `published_at`=파일 시각, 질문 배열 순서→`question_set_members.position`으로 채우고 질문 필드는 3.1을 따르게 했다. | `DDL:451-466`, `DDL:513-524` |
| 11 | `qid__other`를 `threads(context_kind='question_comment')`로 보내면서 `target_object_id`·`target_version_id`·`messages.submission_id`를 정하지 않았다. 스레드 FK와 답 유래를 채울 수 없다. | 6.1 `qid__other` | 빠짐 | `target_object_id`=질문 객체, `target_version_id`=당시 질문 버전, `anchor_id=NULL`, `messages.submission_id`=같은 feedback의 submission으로 명시했다. | `DDL:682-698`, `DDL:716-730`, `DB:89` |
| 12 | `sources.kind`(NOT NULL, `web/file/stat/law`)를 매핑하지 않았다. `sources` 행을 만들 수 없다. | 4.1 `sources[]` | 빠짐 | `method=kosis`→`stat`, `law`→`law`, URL 없이 파일 경로→`file`, 그 밖 URL→`web`으로 채우고 원문 method를 보존하게 했다. | `DDL:396-404` |

## 2. 확인한 것·남긴 것

- `artifact_versions`에는 `created_at`이 없고 `object_versions`에만 있다. `notes[]`·`qa.recorded`·`approved_at`의 시각 기준을 각각 `object_versions.created_at`, event, `mutation_commits`/`events`로 구분했다.
- `questions`에는 `state`가 없고 `question_versions`에만 있다. `suggestions[]` 두 곳을 고쳤다.
- `followup_versions.kind='next_round_task'`는 `target_stage_id`가 필수다. 대상 불명은 행을 만들지 않고 원문 보존으로 바꿨다.
- `projects.owner_user_id`·`current_policy_id`·`active_edition_id`와 `project_policy_versions.changed_by_user_id`의 FK를 이전 절차에 넣었다. 초기 정책은 "이전 기본값"이며 과거 동의가 아니다.
- 실제 자료를 읽지 않았으므로 필드 값의 실제 분포·깨진 파일의 구체적 형태는 확인하지 않았다. 합성 fixture 시험은 2단계 PR11·12 범위다.
- DDL에 없는 새 표·열을 만들지 않았다. 새 열이 필요한 값은 계속 `legacy_extra`로 보낸다.
