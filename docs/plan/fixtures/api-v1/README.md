# PES API v1 계약 시험용 JSON 예제

- 근거: [stage-1-api.md](../../stage-1-api.md) 3절(오류 봉투)·6절(동작 표)
- 범위: 6절 동작마다 **정상 요청·응답 1개**와 **대표 오류 1개**. 결과 제출에는 멱등 재생 사례를 추가로 둔다.
- 이 폴더는 **합성 계약 픽스처**다. 실제 코드·서버·DB에 연결하지 않고, 어떤 코드도 이 파일을 import하지 않는다.
- 실제 `~/pes-projects`·`~/.pes/` 자료, 실키, 기관 자료는 넣지 않았다. 모든 ID·문장·파일은 합성이다.

## 1. 파일 구조

파일 하나가 동작 하나다. 파일명은 사람이 읽기 쉬운 이름이고, `operation`은 계약상의 동작 이름이다.

```json
{
  "operation": "results.submit",
  "method": "POST",
  "path": "/api/v1/projects/{project_id}/runs/{run_id}/results",
  "auth": "agent_token",
  "normal": {
    "request": {
      "path_params": { "project_id": "prj_...", "run_id": "run_..." },
      "headers": { "Authorization": "Bearer ${PES_AGENT_TOKEN}", "Idempotency-Key": "idem_..." },
      "body": {}
    },
    "response": {
      "status": 201,
      "headers": { "Content-Type": "application/json" },
      "body": {
        "format_version": "1.0",
        "request_id": "req_...",
        "data": {}
      }
    }
  },
  "error": {
    "request": { "path_params": {}, "headers": {}, "body": {} },
    "response": {
      "status": 409,
      "headers": { "Content-Type": "application/json" },
      "body": {
        "format_version": "1.0",
        "request_id": "req_...",
        "error": {
          "code": "rev_conflict",
          "message": "요청한 기반 버전이 현재 버전과 다릅니다.",
          "retryable": false,
          "target": "$.body.results[0].base_version_id",
          "details": {},
          "next_action": "reread_context"
        }
      }
    }
  },
  "replay": {
    "request": { "headers": { "Idempotency-Key": "idem_..." }, "body": {} },
    "response": {
      "status": 201,
      "body": {
        "format_version": "1.0",
        "request_id": "req_...",
        "data": {},
        "replayed": true
      }
    }
  }
}
```

- `replay`는 결과 제출처럼 멱등 키를 쓰는 동작에만 둔다. 같은 키·같은 요청은 원래 응답을 재생하고 `replayed: true`를 붙인다.
- `request.query`는 GET의 쿼리, `request.path_params`는 경로 변수다. 해당 없는 항목은 생략한다.
- `response.headers`는 계약에 영향을 주는 헤더만 적는다. 실제 전송 헤더 전체 목록이 아니다.
- `files-content.json`의 정상 응답은 실제 HTTP에서 파일 바이트다. 이 JSON 묶음에서는 언어 중립 시험을 위해 `data.content_base64`에 바이트를 담고, `data`에 `media_type`·`sha256`·`size_bytes`를 함께 둔다.
- `uploads-put.json`의 요청 본문도 바이트이므로 `body_base64`를 쓴다.

## 2. 봉투·값 규칙

1. 모든 JSON 응답 본문 맨 위에 `"format_version": "1.0"`을 둔다. DB·workflow 버전과 별개다. 요청 본문의 `format_version`은 **모든 경로**가 선택으로 받는다(`"1.0"` 외의 값은 400 `$.body.format_version`, 2026-11-10 SEL-47 S7).
   - 성공 응답은 `{ "format_version": "1.0", "request_id": "req_...", "data": {...}, "replayed": true }` 모양이다. 오류 봉투처럼 `request_id`는 맨 위에 두고, `replayed`는 POST를 재생했을 때만 붙는다. 실제 업무 payload는 `data`에 둔다.
2. 요청의 모르는 필드는 거부한다. 응답의 선택 필드 추가는 허용한다. 모르는 정책·상태를 허용으로 해석하지 않는다.
3. `rev`, `control_rev`, `fence`, `event_seq`, `version_no`, `round_no`, `edition_no` 같은 번호는 **정규화한 10진 문자열**이다. 문자열 사전식 비교나 JavaScript `Number` 변환을 하지 않는다.
4. 오류 봉투는 다음 모양을 따른다.

   ```json
   {
     "format_version": "1.0",
     "request_id": "req_...",
     "error": {
       "code": "policy_blocked",
       "message": "한국어 설명",
       "retryable": false,
       "target": "$.body.mode",
       "details": {},
       "next_action": "owner_enable_policy"
     }
   }
   ```

   - `code`는 영어 고정 snake_case, `message`는 한국어다.
   - `retryable`은 **같은 요청을 자동 재시도할 수 있는지**다. 충돌·정책 차단·사람 전용 위반은 `false`다.
   - `target`은 문제 필드의 JSON 경로다. `details`를 대체하지 않는다.
   - `target`·`details` 키는 늘 있다. 한 필드를 가리킬 수 없으면 `target`은 `null`, 기계가 읽을 값이 없으면 `details`는 `null`이다.
   - `details`는 `expected`/`current`(rev_conflict), 상태 이름(`stage_not_active`·`already_sealed`·`stale_stage`), 410의 `next_cursor`·`snapshot` 같은 기계가 읽을 값만 담는다. 다른 실행의 lease 보유자(`holder_run_id`)처럼 남의 정보는 알리지 않는다.
   - `next_action`은 stage-1-api 3절의 오류 봉투를 따른다.
5. 쓰기 요청은 `Idempotency-Key`를 필수로 둔다. 같은 키·같은 요청은 원래 결과를 재생하고, 같은 키·다른 요청은 `idempotency_key_reuse`로 거부한다.
6. 인증은 자리표시자만 쓴다. `${PES_AGENT_TOKEN}`, `${PES_SESSION}`, `${PES_CSRF}`는 실제 값이 아니다.
7. `auth` 값의 뜻:
   - `any`: 인증 전에도 읽을 수 있는 capability
   - `agent_token`: 프로젝트 범위 에이전트 토큰
   - `human`: 사람 세션(소유자·편집자 구분은 명령이 검사)
   - `human_owner`: 소유자 사람만
   - `human_or_agent`: 사람 또는 프로젝트 에이전트
   - `human_or_permitted_agent`: 사람 또는 허가된 에이전트
   - `human_or_agent_self`: 사람 또는 자기 담당 run의 에이전트
   - `human_or_current_agent`: 사람 또는 현재 lease 보유 에이전트
   - `agent_or_human`: 질문 게시처럼 양쪽이 가능한 동작
   - `human_or_agent_or_browser`: 첨언·답글처럼 browser_agent도 가능한 동작
8. 경로는 6절의 `P`를 `/api/v1/projects/{project_id}`로 펼쳤다. 6절에 경로가 약칭(`…`)으로만 있는 삭제는 소유자 전용 `DELETE /api/v1/projects/{project_id}`, 업로드 PUT은 구현된 경로 `PUT /api/v1/projects/{project_id}/uploads/{blob_id}`(프로젝트 에이전트·소유자 자격)로 적었다. 예약 요청은 `{sha256(접두 없는 소문자 hex 64자), size, media_type, original_name}`, 응답은 `project_id`·`blob_id`·`state`·`deduplicated`다. 업로드 완료 요청 본문은 빈 객체 `{}`다. `GET …/files/{blob_id}/content`는 JSON 봉투가 아니라 **원시 바이트**를 돌려주므로 정상 사례는 `body` 대신 `body_base64`에 둔다.
9. 상태 코드는 `200`(조회·명령 성공), `201`(생성), `202`(영속 접수), `400`(잘못된 커서·요청), `401`(인증), `403`(권한·정책), `404`(없음), `409`(충돌·상태), `410`(만료), `413`(크기), `422`(검증)을 쓴다.
10. PR13 경로의 요청 본문은 코드가 기준이다(2026-11-10 SEL-47 R2): `runs`는 `{actor_id, mode, runtime, provider, model}`(mode A 장면의 `actor_id` 자리표시자 `act_…`는 `internal_ai` actor다 — mode A run은 internal_ai만 받는다, SEL-68), `claims`는 `{run_id, expected_control_rev?}` 또는 `{mode, runtime, provider, model, expected_control_rev?}`, `results`는 `{lease_id, fence, expected_control_rev?, results:[{op:"append_version", object_id, based_on_version_id, title, …}]}`, `wait`는 `{lease_id, fence, reason?, wait_ms?}`, `complete`는 `{lease_id, fence, status}`. 질문의 `type`은 코어 이름(`single`·`multi`·`text`·`textarea`·`number`·`scale`·`file`; 기타 입력은 답 항목의 `other` 필드), `importance`는 `high|normal|low`다. 라운드 봉인은 ready 상태의 manifest blob(`manifest_blob_id`)과 `versions`가 필수다. 에이전트가 질문을 게시할 때는 담당 run의 `run_id`·`lease_id`·`fence`를 함께 보낸다(없으면 403).
11. 받기만 하고 저장하지 않는 필드: `submissions`의 `submitted_via`·`client_request_id`(멱등 키는 헤더가 진짜). 저장하지 않으면 결과가 달라지는 값 — `questions`의 `direction: "human_to_agent"`, `rounds`의 `purpose`·`question_set_id` — 은 400으로 거부한다. `heartbeat`의 `progress`(`{phase, observed_at?}`)는 영수증·`run.heartbeat` 사건에 저장하고, 응답에는 저장된 값이 `data.progress`로 실린다(재전송이면 처음 값, 2026-11-11 PR20a). `GET /requests/{key}` 응답에는 영수증의 `run_id`가 실린다. `runs`는 소유자 세션 전용 본문 `{import:{results, request_id, stage_id?, round_id?, claimed_tool?, claimed_model?, expected_control_rev?}}`도 받는다(명시적 전달 가져오기, `via=import`; 멱등 키는 `import-<request_id>`여야 하고, 승인된 단계·봉인된 라운드는 409 `conflict`, 같은 자료를 둘 이상 말하면 400 `invalid_payload`). `results` 경로는 에이전트 토큰 전용이라 소유자 세션은 403이다.
12. 인계(`handoffs.json`)는 같은 run을 `queued`로 되돌린다. `target_actor_id`·`target_mode`는 생략하거나 그 run의 actor·mode와 같아야 하며(정상 사례의 `act_…`는 그 run의 actor 자리표시자), 다르면 400 `invalid_payload`다. 입력(`inputs.json`) 항목의 `object_id`는 답 object이고 답 본문은 `versions.json` 경로(`/objects/{object_id}/versions/{input_version_id}`)의 `content`(`question_version_id`·`value`·`state`·`comment`)로 읽는다.
13. `normal`·`error` 밖의 장면은 최상위 `scenes: {"<이름>": {request, response}}`에 둔다(모양은 `normal`과 같다). `versions.json`의 `scenes.answer`·`scenes.question`은 답·질문 버전의 실제 `content` 예이고, `handoffs.json`의 `scenes.target_mismatch`는 다른 actor로 인계 → 400 `invalid_payload`(`target: $.body.target_actor_id`, 쓰기 0)다. 계약 시험이 각 장면을 실제 앱에 보내 같은 응답인지 본다.

## 3. 6절 동작별 파일

| 6절 동작 | 파일 | 대표 오류 |
|---|---|---|
| capability·맥락·버전 읽기 | `capabilities.json`, `context.json`, `versions.json` | —, `unauthenticated`(남의 프로젝트 id: 인증 먼저), `not_found` |
| 실행 시작 | `runs.json` | `policy_blocked` |
| claim·heartbeat·wait·complete | `claims.json`, `heartbeat.json`, `wait.json`, `complete.json` | `conflict`(살아 있는 lease·보유자 아님·complete 뒤 재요청), `lease_lost`(heartbeat·release·영수증), `run_terminal`(cancel·interrupt) |
| 중단·취소 | `interrupt.json`, `cancel.json` | `forbidden`, `run_terminal` |
| 인계 | `handoffs.json` | `forbidden` |
| 결과 제출 | `results.json` (+ 멱등 재생) | `rev_conflict` |
| 질문 게시·수정 | `questions.json`, `question-revisions.json` | `validation_failed`, `rev_conflict` |
| 답·의견 제출 | `submissions.json` | `question_version_changed` |
| 입력 기다리기·영수증 | `inputs.json`, `input-receipts.json` | `cursor_invalid`, `input_not_visible` |
| 변경분 | `changes.json` | `cursor_expired` |
| 파일 | `uploads.json`, `uploads-put.json`, `uploads-complete.json`, `files-content.json` | `invalid_payload`(`sha256:` 접두), `invalid_payload`(해시 불일치), `conflict`(아직 안 올림), `policy_blocked` |
| 첨언·답글 | `threads.json`, `thread-messages.json` | `validation_failed`, `thread_closed` |
| 해결·후속 적용 | `thread-resolutions.json`, `followup-apply.json` | `already_resolved`, `basis_changed` |
| 가정·결정·반영 | `assumptions.json`, `decisions.json`, `reflections.json` | `validation_failed`, `supersedes_conflict`, `evidence_required` |
| 라운드 시작·봉인 | `rounds.json`, `round-seal.json` | `stage_not_active`, `already_sealed` |
| 단계 승인·reopen·판 시작·Go 정책·토큰·삭제 | `stage-approve.json`, `stage-reopen.json`, `editions.json`, `policy-revisions.json`, `agent-tokens.json`, `project-deletion.json` | `stale_stage`, `human_required`, `active_edition_exists`, `owner_required`, `confirmation_mismatch` |
| 외부 내보내기 | `exports.json` | `preview_required` |

## 4. 이 묶음이 다루지 않는 것

- 실제 HTTP 헤더 전체, TLS·HTTP/2·프록시 동작, rate limit의 모든 429 사례
- OpenAPI 기계 명세(2단계 PR 13·14에서 작성)
- 실제 DB 행·파일 내용·모델 호출·OpenCode 세션
- 같은 키·다른 요청의 `idempotency_key_reuse` 픽스처(규칙만 2절 5번에 둔다)
- 삭제의 실제 경로·보존 기간 정책(6절에 경로가 약칭으로만 있어 예시 경로를 썼다)

## 5. 사용 규칙

- 계약을 바꾸면 이 파일을 먼저 고치고, 서로 다른 언어의 구현이 같은 파일로 같은 결과를 내는지 시험한다.
- 한 파일 안의 `normal`·`error`·`replay`는 서로 독립된 사례다. 오류 사례의 요청을 정상 응답과 섞어 쓰지 않는다.
- 픽스처에 실제 프로젝트 ID·경로·토큰·기관 자료를 넣지 않는다. 새 사례도 합성 자료로만 만든다.
- `python3 docs/plan/fixtures/check_fixtures.py`로 문법·봉투·오류·번호 문자열·6절 경로/이름을 검사한다.

## 6. 검사 후 고친 것 (2026-11-05)

`docs/plan/fixtures/check_fixtures.py`를 만들어 실행했다. 첫 검사에서 38개 파일 모두 성공 봉투가 `data`·`meta`가 아니어서 실패했고, 다음을 고쳤다.

- 38개 JSON의 정상 응답을 `{format_version, data, meta}`로 통일했다. 기존 최상위 payload는 `data`로, `request_id`는 `meta.request_id`로 옮겼다. **(2026-11-10 D1로 뒤집음: 지금은 `request_id`를 맨 위에 두고 `meta`를 쓰지 않는다 — 2절 1번.)** `results.json`의 `replay.response`도 같게 고쳤다.
- `files-content.json`의 정상 응답을 바이트 `body_base64`에서 JSON 봉투로 바꾸고, `data.content_base64`·`media_type`·`sha256`·`size_bytes`를 두었다. **(2026-11-10 SEL-47로 되돌림: 구현은 원시 바이트를 주므로 `body_base64`.)**
- 검사기에서 `wait`·`complete`의 6절 경로 조각을 표기(`/wait`, `/complete`)에 맞췄다. 예제 파일의 경로 자체는 바꾸지 않았다.
- 수정한 예제 파일은 38개 JSON 전부다. README와 검사기 외의 코드·계획서는 고치지 않았다.
- 최종 검사 결과: `python3 docs/plan/fixtures/check_fixtures.py` → `검사 통과 38/38`.

## 7. 구현과 맞춘 것 (2026-11-10, SEL-47 R2)

`tests/test_api_fixture_contract.test.ts`가 이 폴더의 모든 요청을 실제 `ApiApp`에 보내 상태·오류 코드·`next_action`·`retryable`·`target`·응답 모양을 대조한다. 원칙: PR13에서 병합된 경로·동작은 코드가 기준(픽스처를 고침), PR14 새 경로는 코드를 픽스처에 맞춤(코어와 부딪히면 코어).

- **픽스처를 코드에 맞춤(PR13)**: `capabilities`(실제 operations 전체, `webmcp` 없음, `limits` 두 모양) · `context`(실제 응답 모양, 오류는 남의 프로젝트 id → 401) · `versions`(평평한 응답, 404 `reread_context`) · `runs`(요청 필드) · `claims`(`lease_ttl_ms` 삭제, 오류 `conflict`/`details:null`) · `wait`(`question_ids` 삭제) · `results`(`expected_control_rev`, `op:"append_version"` 항목, `input_receipts` 삭제) · `complete`(`result_version_ids`·`summary` 삭제) · `uploads`(`original_name`·`size`·접두 없는 hex) · `uploads-put`(해시 불일치 400) · `uploads-complete`(빈 본문, 409 `conflict`) · `files-content`(원시 바이트, 403 `target:null`).
- **픽스처를 코어에 맞춤(PR14, 코어 우선)**: `questions`·`question-revisions`(`type:"single"`, `importance:"normal"`, `intended_actor_id:null`, 게시자는 소유자 세션 예시) · `rounds`(`purpose`·`question_set_id` 삭제 — 저장하지 않으므로 400) · `round-seal`(`manifest_blob_id`·`versions` 추가) · `stage-approve` 오류(rev 불일치 → `target:$.body.expected_stage_rev`) · `changes` 410 `details`(`reason`·`next_cursor`·`snapshot`·`keep_unsubmitted_answers`).
- **코드를 픽스처에 맞춤(PR14)**: `rounds` 오류 — 앞 단계가 승인되지 않은 단계에서 라운드를 시작하면 일반 `conflict` 대신 409 `stage_not_active`(`target:$.path.stage_id`, `details{stage_id, stage_status}`).
- 검사기: 오류 `target`·`details`의 `null`과 원시 바이트 정상 응답(`body_base64`)을 받도록 고쳤다.
