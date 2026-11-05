# 1단계 ① DB 설계서

- 작성: 2026-11-04, Claude 종합. Linear: SEL-21
- 입력: [stage-1-db-codex.md](discussion/stage-1-db-codex.md), [stage-1-db-opencode.md](discussion/stage-1-db-opencode.md), Claude 추천안 [stage-1-db-claude-recs.md](discussion/stage-1-db-claude-recs.md), Codex 검수 [stage-1-db-codex-review.md](discussion/stage-1-db-codex-review.md), 확정 [stage-0.md](stage-0.md)
- 진행 규칙(사용자 지시 2026-11-04): Claude 확인 → Codex 검수 → **합의안으로 진행**. 사용자가 이미 정한 stage-0 7절은 다시 정하지 않는다.
- 상태: **확정 — 사용자 승인 2026-11-05.** **합의안(Claude·Codex) — 최종 대조 보완 반영, DDL 초안 실행 통과.** Codex 최종 대조: [stage-1-db-final-check.md](discussion/stage-1-db-final-check.md)

## 1. 목표

PES의 모든 상태를 **덮어쓰지 않고 쌓는** 관계형 DB 하나로 옮길 설계를 정한다. 로컬(SQLite)과 웹(Cloudflare D1)이 같은 설계를 쓰고, 방식 A·B가 같은 표를 쓴다. 1단계는 설계만 한다. 구현은 2단계.

> 한 줄 요약: **관계형 업무 모델 + 덧붙이는 버전 + 현재 버전 포인터 + 같은 트랜잭션의 번호 붙은 사건 기록.** 쓰기는 PES의 검증된 명령 하나로만(원칙 0).

## 2. 합의된 결정

| # | 주제 | 결정 |
|---|---|---|
| 1 | OpenCode Go 전송 | **기본 켜짐 + 프로젝트별 끄기**(stage-0 7-1). 생성할 때 허용 상태를 화면에 보여 줌. 허용 ≠ 자동 실행. 끄면 맥락·요약·첨부·재시도까지 막고, 정책이 없거나 손상되면 거부. 합성 자료라고 우회하지 않음 |
| 2 | 여러 컴퓨터 | 실행 중 DB 파일을 동기화·공유하지 않음(동시 수정·불완전 인계 위험). 옮길 땐 **DB 사본+참조 파일+manifest 묶음**으로 export/import. 한 프로젝트의 쓰기 원본은 하나. 웹 전환 후엔 D1이 원본 |
| 3 | 저장 위치 | DB `~/.pes/pes.db`, 원본 파일(객체) `~/.pes/objects/` — 둘 다 **기기 로컬**. PES 홈은 기존 JSON 보존본·내보내기 묶음 자리. `pes home` 이동이 DB·객체를 어떻게 다루는지 2단계에서 명시 |
| 4 | 전환 후 `project.json` | 읽기 전용 보관, 이중 쓰기 금지. 삭제 시점은 나중에. **새 DB 쓰기가 생긴 뒤의 되돌리기는 원본 재연결과 다름**(새 대화·버전을 옛 JSON으로 무손실 되돌릴 보장 없음) |
| 5 | 판 | 프로젝트마다 **활성 판 하나**(부분 UNIQUE + 명령 검증). 과거 판은 읽기·선택 재사용 |
| 6 | 다음 판으로 넘기기 | **판 범위 결정·가정은 원본 버전을 고정해 새 판에 복사**하고 유지/수정/제외를 기록. 프로젝트 공통 결정은 참조하되 새 판 기준 스냅샷에 당시 버전 고정. 전송 정책은 판 복사로 바뀌지 않음 |
| 7 | 질문을 고치면 | 옛 답은 **그때 본 질문 버전**에 묶어 보존. 새 버전엔 "재확인 필요", 자동 승계 없음. 기본값·추천값을 제출된 답으로 바꾸지 않음 |
| 8 | 첨언 위치 | 인용문+앞뒤 문맥 불변 보존. 다시 찾은 결과는 **exact / moved / ambiguous / lost**. 사람이 다시 붙이면 원래 앵커를 고치지 않고 새 판정을 덧붙임 |
| 9 | 버전 보존 | **채택·저장한 결과 버전과 공유·인쇄본은 모두 보존.** 키 입력·토큰 스트림은 버전으로 만들지 않음. 같은 내용 바이트는 중복 저장 안 함(계보는 유지) |
| 10 | 출처 | 링크 + 실제 확인 시점 + **짧은 근거 발췌·위치·확인 방법/판정**. 못 읽은 자료는 발췌를 만들지 않음. 기존 캡처 보존, 전체 원문·캡처 자동 수집은 안 함. 어느 단계의 근거 파일이든 같은 첨부 모델로 연결 |
| 11 | 삭제 | 기본은 보관(복구 가능). 영구 삭제는 소유자만 별도 명령. 논리 삭제 / 참조 없는 파일 정리 / 프로젝트 영구 삭제를 구분하고, 본문·파일·사건 기록·백업 각각의 처리 범위를 정함(2단계 정책, 구현은 그 뒤) |
| 12 | 전송 재허용 | **소유자만.** 사람을 대리하는 에이전트는 못 켬. 켜도 멈춘 실행을 자동 재시작하지 않음 |
| 13 | 인증 | 2단계부터 **프로젝트 범위 에이전트 토큰**(해시·범위·실제 actor·만료·회수). 사람 로그인 UI는 5단계. **에이전트 토큰으로 승인·reopen·전송 재허용 불가** |
| 14 | 브라우저 에이전트 | 사람 권한으로 한 일도 사람 승인으로 치지 않음. 승인·reopen·판 시작은 WebMCP에 노출 금지 |
| 15 | 실행 담당 | 프로젝트마다 **실행 담당 하나**(lease+fence). lease는 에이전트의 결과 채택만 제한하고 사람의 답·첨언은 막지 않음. 질문 대기 중엔 lease를 놓고 run은 `waiting_human` |
| 16 | 2단계 규모 | **2단계 25개 PR**(20a·20b·20c 분할, PR26 포함). 표·테스트별 이슈는 만들지 않는다(10절). 누적·잔여는 `roadmap.md` 2절 참조 |
| 17 | 1단계 완료 | 이 설계서 + **DDL 초안을 임시 SQLite에서 실행**(FK 켜고 합성 행 삽입, 잘못된 참조·중복 거부, 대표 조회, rev 충돌 시 부분 저장 없음). 실제 프로젝트 이전 시험은 2단계 |

## 3. 표 설계

공통 규칙: 모든 업무 표에 `project_id`, `(project_id,id)` 복합 키로 **다른 프로젝트 것을 끼워 넣지 못하게**. 시각은 UTC epoch ms, 상태는 TEXT+CHECK, 작은 배열·조건은 검사한 JSON TEXT. 불변 버전 표엔 UPDATE·DELETE 경로 없음. 삭제는 기본 RESTRICT(연구 기록에 CASCADE 안 함). ID는 서버가 만들고 화면 번호는 `counters`로.

### 3.1 사람·에이전트·프로젝트

| 표 | 주요 열 | 이유 |
|---|---|---|
| `users` | id, display_name, auth_subject?, disabled_at? | 로컬 한 명이어도 고정 사용자 |
| `actors` | id, kind(human/internal_ai/external_agent/browser_agent/system/legacy_unknown), user_id?, runtime?, provider? | 실제 작성자. 모델은 run에 기록 |
| `project_members` | (project_id,user_id), role(owner/editor/reader) | 여러 사람 대비, 소유자 없는 상태 금지 |
| `project_references` | id, project_id, referenced_project_id?, **referenced_project_key**, source_snapshot_id?, **source_snapshot_key**, source_label, latest_snapshot_id?, scope_json, status(active/source_missing/source_archived), attached_by_*, attached_at, rev | 이전 프로젝트를 **특정 버전에 고정한 읽기 전용 참고자료**로 붙임. 3단계 REF1. 원본 수정·복사 없음. **승인·봉인 스냅숏은 영구 보존**하고, 삭제 가능한 원본/초안 스냅숏만 명시적 해제로 `source_snapshot_id`·`latest_snapshot_id`를 NULL로 만들고 `status='source_missing'`으로 남긴 뒤 삭제한다(복합 FK SET NULL 금지). 원본 프로젝트가 목적지에 없으면 `referenced_project_id=NULL`·`referenced_project_key`로 표시하며 원본 자료를 묵시적으로 함께 export하지 않는다. 권한·전송 OFF는 엄격한 쪽 우선 |
| `agent_tokens` | id, project_id, actor_id, scopes, token_hash, expires_at?, revoked_at? | 결정 13. 원문은 한 번만 전달 |
| `projects` | id, slug UQ, topic, owner_user_id, active_edition_id?, status, control_rev, current_policy_id | 프로젝트 제어점 |
| `project_policy_versions` | id, project_id, policy_rev, allow_opencode_go(0/1), mode_a_model, go_usage_stop_percent, changed_by, reason, tx_id | 전송 허용·A 모델·사용량 문턱의 불변 이력(결정 1·12·0013) |
| `counters` | (project_id,namespace), next_no | 표시 번호, 재사용 안 함 |

### 3.2 프로젝트 → 판 → 단계 → 라운드, 승인

| 표 | 주요 열 | 이유 |
|---|---|---|
| `editions` | id, project_id, edition_no, parent_edition_id?, base_snapshot_id?, status(draft/active/completed/archived), current_stage_id?, rev | 판마다 단계·설정 분리, 부모판·기준 스냅샷 고정 |
| `stages` | id, edition_id, key(plan…publish), ordinal, status(pending/asking/active/approved), current_round_id?, approved_snapshot_id?, stale_since_event_seq?, rev | stale은 승인을 지우지 않고 원인을 가리킴 |
| `rounds` | id, stage_id, round_no, state(open/sealed), base/sealed_snapshot_id?, rev | 한 라운드에 여러 run 가능. 시작 질문은 round 없음 |
| `round_contents` | (round_id,object_id), version_id, position, role | 그 라운드에 보였던 **정확한 버전 목록** |
| `snapshots` | id, edition_id, stage_id?, round_id?, scope, manifest_blob_id, through_event_seq, content_hash | 라운드·승인·판 기준 고정본 |
| `approvals` | id, stage_id, snapshot_id, actor_id, human_user_id?, origin(new/legacy), assurance(verified/legacy_unverified), tx_id | 누가 무엇을 승인했나. reopen은 현재 승인 포인터만 해제 |

### 3.3 내용·결과물·출처·파일

| 표 | 주요 열 | 이유 |
|---|---|---|
| `objects` | id, project_id, edition_id?, kind, display_no, current_version_id?, rev, archived_at? | 모든 내용의 공통 정체성(첨언·근거가 가리킬 대상) |
| `object_versions` | id, object_id, version_no, based_on_version_id?, created_in_round_id?, actor_id, run_id?, tx_id, content_hash | 불변 버전 등록부. 현재 포인터는 자기 버전만 |
| `artifacts` / `artifact_versions` | kind(rq/chapter/topic/issue/table/section/claim/report/review/note…), title, summary, body_md 또는 body_blob_id, status, stats, verify | 현행 item·보고서를 포괄 |
| `artifact_components` | (parent_version_id,position), child_version_id | 보고서가 쓴 장·절의 정확한 버전과 순서 |
| `version_relations` | (from,to,kind: derived_from/supports/supersedes/reuses/related) | 근거 연결, 새 버전에도 옛 연결 유지 |
| `sources` / `source_versions` | kind(web/file/stat/law…), url?, locator, retrieved_at, method, verification_state, quote?, evidence_blob_id? | 결정 10. **URL만으로 합치지 않음** |
| `citations` | (artifact_version_id,citation_no), source_version_id | 원고 버전별 각주 순서 |
| `blobs` / `version_files` | storage_key UQ, sha256, size, media_type, state(staging/ready/quarantined) / (version_id,blob_id,role), **file_policy_id** | 로컬 폴더·R2 공통 파일 정보. 경로·서명 URL을 식별자로 안 씀. 파일 정책은 blob 단위 한 행으로 두어 같은 바이트를 쓰는 모든 버전·role이 같은 정책을 공유한다(role 우회 없음) |
| `file_policies` | id, project_id, blob_id, ai_access(allow/deny), rev, changed_by_actor_id, changed_by_user_id, changed_at, reason, tx_id | **파일 정책의 안정 ID와 현재값**. `(project_id,blob_id)` 하나. 같은 hash 재사용·새 버전 재첨부가 같은 정책을 가리킨다. 재허용은 owner만, 변경은 같은 tx의 이력과 함께 |
| `file_ai_access_versions` | id, project_id, **file_policy_id**, ai_access, changed_by_*, changed_at, reason, rev, tx_id | 파일 정책 변경의 불변 이력. `(project_id,file_policy_id,rev)` 고유. 존재하지 않는 정책·연결을 FK로 거부 |
| `file_extractions` | id, project_id, version_id, blob_id, **source_file_policy_id**, source_format, extractor/version, status, text_blob_id?, **text_file_policy_id**, page/table 수, warnings_json, tx_id | 원본에서 뽑은 글자·표 버전과 실패·부분 손실 표시. 원본과 추출 텍스트가 각자의 blob 정책을 가지며, 서비스가 원본 deny를 추출 텍스트에도 적용해 우회를 막는다 |
| `sync_links` | id, project_id, device_id, link_kind(bridge/mcp), **credential_kind(human_device/helper_device)**, **helper_actor_id?**, status, last_seen_at, last_cursor, created_by_user_id, revoked_at, rev | B 연결 도우미·MCP의 연결 상태와 커서. **사람/기기 링크 자격과 AI 도구 MCP/API 자격을 분리**하고, helper_device는 helper actor가 필수다. 5차 |
| `sync_items` | id, project_id, link_id, direction(up/down), version/blob, local_label, hash, state(synced/conflict/…), conflict_json, rev, **tx_id** | 양방향 동기화 항목·충돌 표시. 조용한 덮어쓰기 금지. 변경은 같은 tx의 사건·영수증을 남긴다. 5차 |
| `agent_schedules` | id, project_id, link_id?, run_id?, title, status, seq, planned/started/ended, summary, changed_files_json, rev, **tx_id** | 내 컴퓨터 작업 현황·앞으로의 스케줄. 변경은 같은 tx의 사건·영수증을 남긴다. 5차 |

재사용은 **새 판의 새 객체 + origin_version_id**. `library.json`은 항목·출처로 옮기고 원본도 보존.

### 3.4 질문·답

| 표 | 주요 열 | 이유 |
|---|---|---|
| `question_sets` / `question_set_members` | stage_id, round_id?, purpose(stage_start/review/resume), version_no / (set_id,question_id), question_version_id, position | 사람이 실제로 본 폼의 버전. 추가·제외·순서 변경도 새 set |
| `questions` | asked_by_actor_id, intended_actor_id?, direction(agent_to_human/human_to_agent), origin(bank/review/manual/import), original_version_id | 누가 누구에게 물었나, 원문 보존 |
| `question_versions` | text, type, state(draft/open/deferred/merged/withdrawn/closed), importance, required, default_value, options, show_if | 고친 문구·선택지·중요도·기본값 |
| `submissions` | actor_id, drafted_by_actor_id?, set_id?, received_at, via, raw_blob_id? | 제출 봉투. 초안 쓴 에이전트와 제출자 구분, 중복 방지 |
| `answers` / `answer_versions` | question_id, respondent_actor_id, submission_id / question_version_id, value, state(submitted/skipped/withdrawn), used_default | 답 수정도 새 버전 |
| 질문별 의견 | `threads`(context_kind=question_comment) | 답 없이 의견만, 여러 답글 가능 |

이전 시 `answers[qid+'__other']`는 질문 스레드 메시지로, 선택 없이 덧붙임만 있던 입력도 보존.

### 3.5 가정·결정·첨언·대화·반영 (표 자리는 2단계, 기능은 3단계)

| 표 | 주요 열 | 이유 |
|---|---|---|
| `assumptions` / `_versions` | statement, state(proposed/confirmed/rejected/revised), assessment_actor_id, rationale | 맞다/틀리다/고침과 판단자 |
| `decisions` / `_versions` | scope(project/edition), statement, state(proposed/adopted/superseded/revoked), decided_by | 살아 있는 결정 목록 + 과거 결정 |
| `threads` / `_versions` | target_object_id, target_version_id?, context_kind(annotation/question_comment/general), anchor_id?, state(open/resolved/archived) | 첨언·질문 의견·일반 대화 공통 |
| `anchors` / `anchor_resolutions` | target_version_id, exact_quote, prefix, suffix, start_cp?, end_cp? / status(exact/moved/ambiguous/lost) | 결정 8 |
| `messages` / `_versions` | thread_id, reply_to?, body_md | 대화와 편집 이력 |
| `followups` / `_versions` | kind(edit_text/next_round_task/reopen_stage/none), state(proposed/accepted/running/applied/…) | 대화 결과를 셋으로. 해결 버튼 ≠ 적용 완료 |
| `reflection_entries` | source_version_id, target_round_id, disposition(applied/partial/rejected/deferred), rationale, result_version_id? | 다음 라운드 첫머리의 "반영 내역" |

### 3.6 실행·변경·사건·전송

| 표 | 주요 열 | 이유 |
|---|---|---|
| `runs` | edition/stage/round, actor_id, mode(A/B), runtime, provider, model, role(worker/reviewer/…), workflow_version, usage?, status(queued/running/waiting_human/**blocked_usage**/succeeded/failed/cancelled/interrupted), **go_block_reason?, go_blocked_at?, go_block_reset_at?**, retry_of?, external_session_ref?, base_control_rev | 실행과 재시도. 당시 모델·도구 기록. Go 사용량/Extra Usage 차단은 `waiting_human`이 아니라 `blocked_usage`로 두고, lease 해제·동시 호출 중단·reset 시각 미확인(NULL)을 표시한다. 재개는 응답 도착만으로 자동 진행하지 않고 C4/R1 준비·정책·새 claim을 따른다 |
| `run_targets` | (run_id,object_id), base_version_id, base_rev | 담당 범위 밖 수정 금지 |
| `project_leases` | project_id PK, lease_id, run_id?, fence, heartbeat_at, expires_at | 결정 15. 인계마다 fence 증가 |
| `run_input_receipts` | (run_id,input_version_id), state(seen/applied/ignored) | 받은 답을 읽음/반영으로 구분 |
| `mutation_commits` | actor_id, on_behalf_of_user_id?, via(web/cli/http/mcp/webmcp/import), client_request_id, request_hash, action, base_control_rev, fence | 검증된 변경 단위·멱등 영수증. 같은 키·다른 요청은 거부 |
| `events` | event_seq, tx_id, tx_index, tx_size, type, object_id?, before/after_version_id, payload(작게) | 번호 붙은 변경 기록, 화면 증분 갱신 |
| `outbound_dispatches` | id(attempt), run_id, provider, policy_version_id, manifest_blob_id, payload_hash, state(prepared/authorized/sent/response/adopted/blocked/failed/unknown), request_key(상관키), external_request_id?, response_blob_id?/response_hash?/response_at?, adopted_version_id?/adopted_at?, usage_json?, billing_source?, allowance_json?, cost_json?, unknown_at?/unknown_reason? | 어떤 자료가 어떤 허용 판단으로 Go에 나갔나. **호출 전 prepared 행(id=attempt)·상관키(request_key)를 영속**하고, 송신→응답→채택 상태를 남긴다. 응답 유실·외부 멱등 확인 불가는 `unknown`으로 보존하며 자동 재호출하지 않는다. `response`는 응답 hash, `adopted`는 채택 버전이 필수다 |
| `db_meta` | schema_version, database_instance_id, cursor_epoch | 복원·이동 후 커서 무효화 |
| `import_batches` / `legacy_mappings` | source_fingerprint UQ, state(staging/validated/activated/failed) / 옛 ID ↔ 새 ID | 사본 이전의 재개·중복 방지·증거 |

rev는 집합별(객체·판·단계·라운드·`projects.control_rev`). heartbeat는 rev를 바꾸지 않음. 사건 번호는 한 DB 안의 커밋 순서이며 연속을 보장하지 않음.

## 4. SQLite ↔ D1, 파일 저장소

- **같은 것**: 업무 모델, 번호 붙은 마이그레이션 SQL 한 벌, 검사. SQLite와 D1 둘 다 되는 문법만(트리거·FTS·ATTACH·복잡한 PRAGMA에 기대지 않음).
- **다른 것**: 접근 어댑터. D1에선 한 변경 명령을 원자적 묶음(batch)으로 보내고, **조건부 UPDATE가 0행이면 실패로 처리**(그냥 성공으로 흘리지 않음).
- **파일**: 로컬 `~/.pes/objects/`, 웹 R2. 올리기 → hash 확인 → `ready`로 채택. 미완료·고아 파일 정리 규칙 둠. 프로젝트별 접근 검사.
- **D1 확인**: 2단계에서 로컬 D1 smoke(같은 마이그레이션·대표 성공/실패). 운영 D1은 5단계.

## 5. 기존 `project.json` 옮기기

1. 원본 폴더 hash·manifest 기록(원본은 건드리지 않음)
2. staging DB로 프로젝트별 이전(`import_batches`, `legacy_mappings`). 알 수 없는 필드·깨진 파일·누락 이미지도 버리지 않고 보고서에 남김. 기본값 보완을 과거의 명시 결정처럼 꾸미지 않음
3. 검증: 개수·본문·ID·연결·파일 hash·미처리 답·보고서 재생성
4. 프로젝트별 활성화 → JSON은 읽기 전용
5. 되돌리기: **새 쓰기 전**엔 원본 재연결, **새 쓰기 후**엔 DB 백업에서 복구(옛 JSON으로 무손실 복귀 보장 안 함)

**교차 프로젝트 참조**: A가 B를 `project_references`로 참조할 때 A만 번들로 이전·복원하면 B는 목적지에 없을 수 있다. 이때 B 자료를 자동으로 함께 export하지 않고, `referenced_project_id=NULL`·`referenced_project_key`·`status='source_missing'`으로 남긴다. B가 나중에 이전되면 key로 다시 연결하고, 권한·전송 정책은 A·B 중 엄격한 쪽을 따른다. 원본 스냅숏을 지우는 경우에는 먼저 `source_snapshot_id`/`latest_snapshot_id`를 명시적으로 NULL로 만들고 `source_snapshot_key`와 `status='source_missing'`을 남긴 뒤 삭제한다(복합 FK `SET NULL`이 NOT NULL 열을 지우는 경로 금지).

2단계 시험은 합성 fixture로. 실제 프로젝트 이전은 사용자가 따로 허용한 범위에서만.

## 6. 방식 A·B가 DB에 주는 영향

| | 방식 A (PES 내장 실행기 + Go 구독) | 방식 B (Claude Code·Claude 앱·Codex CLI·OpenCode TUI·Codex 앱·OpenCode 앱) |
|---|---|---|
| 표 | 같음 | 같음 |
| 구분 | `runs.mode=A`, `runtime=pes_builtin`, model=`opencode-go/<model-id>`(사용자 선택, 기본 `opencode-go/deepseek-v4.1-flash`, 폴백 없음) | `runs.mode=B`, runtime=claude_code/claude_app/codex_cli/codex_app/opencode_tui/opencode_app |
| 전송 기록 | PES가 Go API를 직접 호출하므로 `outbound_dispatches` 필수, **호출마다** 정책 검사 | Go로 보내지 않음(다른 공급자 정책은 5단계) |
| 대기·재개 | PES가 run·단계 상태를 DB에 남기고 같은 run을 이어 감(`external_session_ref`에 의존하지 않음) | 에이전트가 껐다 켜도 `run_input_receipts`로 이어 감 |
| 질문 | PES 질문이 원본. 모델 질문은 PES `ask`로 만든다 | 같음 |

## 7. 의견이 갈렸던 곳과 합의

| 주제 | Codex | OpenCode | 합의 |
|---|---|---|---|
| 2단계 규모 | 12 PR | 46 PR | 약 22 PR(2026-11-04 시점. 현행 25개는 10절·`roadmap.md` 2절) |
| Go 기본값 | 끄기 제공 | 기본 꺼짐 | 기본 켜짐(사용자 결정) |
| 첨부 위치 | — | 기기 로컬 | 기기 로컬 `~/.pes/objects/` |
| 판 결정 계승 | 판 범위 | 프로젝트 참조·판 복사 | 판 범위 복사 + 프로젝트 공통은 참조·고정 |
| 1단계 완료 | 문서 | 실제 사본 이전까지 | 문서 + 합성 DDL 실행. 실제 이전은 2단계 |
| URL 중복 제거 | 안 함 | 함 | 안 함(같은 URL도 다른 자료일 수 있음) |
| 인증 시점 | 5단계 | 2단계 | 2단계 최소 토큰, 로그인은 5단계 |

## 8. 다음으로 넘기는 것

- **② API(SEL-22)**: 변경 명령·멱등·0행 실패·actor 확정, 승인·reopen은 사람만, 에이전트 토큰 범위, 변경분 커서, WebMCP 노출 표
- **③ 화면(SEL-23)**: 전송 허용 표시·끄기 스위치, 재확인 필요 표시, ambiguous/lost 첨언, 반영 내역 자리
- **④ 실행 구조(SEL-24)**: lease TTL·heartbeat(0단계 SEL-18·19 결과로), 질문 대기 중 lease 해제, Claude 앱 실제 연결 경로
- **2단계**: 10절 이슈, `pes home`과 DB·객체 위치, 삭제 정책 세부

## 9. 완료 기준 (SEL-21)

- [x] 표·키·관계·상태 전이(3절), 결정(2절), SQLite/D1(4절), 이전(5절), A·B(6절)
- [x] Claude·Codex 합의(7절)
- [x] **DDL 초안**([stage-1-ddl-draft.sql](schemas/stage-1-ddl-draft.sql), 61개 표)을 임시 SQLite에서 실행([check_ddl.py](schemas/check_ddl.py)): DDL 실행, 61개 표 합성 적재, 거부 사례 64개, 활성 판·열린 라운드 중복 거부, 대표 조회 3개(변경 커서 인덱스 사용), 0행 rev 충돌·뒤늦은 실패 시 전체 롤백 — **모두 통과**(SQLite 3.54.1, Codex 실행 + Claude 재실행)
- [ ] D1 미검증(2단계 PR 2): batch 원자성·deferred FK·부분 인덱스·JSON 함수·마이그레이션·실행 제한. 트리거를 쓰지 않으므로 상태 전이 적법성·정확히 6단계·fence 단조 증가·과거 버전 UPDATE 방지 등은 **명령 서비스가 보장**(PR 4~6)

## 10. 2단계 구현 이슈 예상 (25개, PR 하나씩)

번호는 순서가 아님. 의존 관계는 이슈 본문에. **각 PR에 테스트 포함**(21번까지 미루지 않음).

| # | PR | 핵심 |
|---|---|---|
| 1 | 스키마 001 + SQLite 연결 | 검증한 DDL, FK, 임시 홈 주입, 짧은 트랜잭션. 3.5절은 표 자리만 |
| 2 | D1 호환 smoke | 로컬 D1에서 같은 마이그레이션·대표 성공/실패 |
| 3 | 새 형식 백업·export/import | DB+파일+manifest+hash, 한 프로젝트 복원이 다른 프로젝트에 영향 없음. **A만 이전/복원할 때 B 참조는 `source_missing`으로 남기고 B 자료를 자동 복사하지 않음** |
| 4 | 변경 명령 서비스 | rev·멱등·사건 같은 트랜잭션, 0행 실패, actor·권한 |
| 5 | run·lease·fence | 인계·옛 fence 거부·질문 대기 중 해제/재획득·입력 영수증. **Go 사용량 차단은 `blocked_usage`+사유/reset 시각, lease 해제·사람 재개** |
| 6 | 판·단계·라운드 명령 | 봉인·승인·reopen·stale·완료 해제·이월(1판 흐름 보존) |
| 7 | 항목·버전·출처·연결 | 출처 버전·각주 순서, URL로 안 합침, QA·verify·library |
| 8 | 질문·답 | 질문/폼 버전, `__other`·자유 의견 보존 |
| 9 | 결과물·객체 저장 | hash·ready 채택·고아 파일·접근 검사, 보고서가 정확한 버전 참조. **blob 단위 `file_policies`·불변 이력·추출본 정책·같은 hash 재사용, owner만 재허용** |
| 10 | 행위자·토큰·전송 정책 | 결정 1·12·13, 13·14·19·20a·20b·20c의 선행 |
| 11 | legacy importer | 옛 JSON → staging, 매핑·중복 방지 |
| 12 | 이전 검증·되돌리기 | 합성 fixture, 쓰기 전/후 복구 구분. **A만 이전/복원하는 교차 프로젝트 참조 시험** |
| 13 | API: 맥락·claim·submit·complete | complete는 run 종료일 뿐 승인 아님 |
| 14 | API: 질문·답·변경분·오류 | 사람 승인·reopen 통로(에이전트·WebMCP 불가) |
| 15 | CLI 쓰기 전환 | approve/reopen/mark/note·잠금 인계, serve/stop/home 범위 |
| 16 | CLI 읽기·보고서·doctor | 보고서 쓰기는 9번 경계로 |
| 17 | 스킬 직접 편집 제거 | project.json·DB 직접 쓰기 모두 금지 |
| 18 | 로컬 화면 DB/API 전환 | 읽기 + 답·승인·reopen 쓰기 + 전송 스위치(새 디자인 없음) |
| 19 | 방식 A 내장 실행기 | Go HTTP 직접 호출·에이전트 루프·업무 도구, 사용자가 고른 Go 모델 하나, Go 사용량 추정·한도 오류, **`blocked_usage`·사유/reset 시각·사람 재개**, 대기·재개·중단·정책 |
| 20a | 방식 B 어댑터 — Claude Code·Claude 앱 | Claude Code stdio MCP·CLI, Claude 앱 Desktop 확장·명시적 전달, 공통 MCP bridge·adapter 계약 |
| 20b | 방식 B 어댑터 — Codex CLI·OpenCode TUI | 20a 계약 재사용, 두 어댑터 각각 합성 1라운드·재개, A 내장 실행기와 구분 |
| 20c | 방식 B 어댑터 — Codex 앱·OpenCode 앱 | 20a·20b 재사용, 직접 연결/명시적 전달, 실제 제출 actor=human |
| 21 | A·B 교차 계약 테스트 | 같은 결과·인계·경쟁·유실·중복, Go OFF 검사. 선행 18·19·20a·20b·20c |
| 26 | TypeScript 단일화·0.15 Python 이전 | 0.15 자산 이전·동등성·설치·제거, 0.16.0 단일 코드베이스. 선행 21, PR22 전 |
| 22 | 전환 통합 검증·문서 | Windows/Mac·복원·사용 안내. 선행 2·12·18·21·26 |

예산: 0단계 11 + 계획 11 + 2단계 25. 누적·잔여는 `roadmap.md` 2절 참조. "2단계 ~15"는 2026-11-04 시점 기록이다.

## 11. 최종 대조 보완 (Codex 지적 9건, 합의)

| # | 보완 |
|---|---|
| 1 | 공개 저장소 정리는 DB 구현과 별개로 처리 완료(커밋 `683ed8b`). 남은 점검은 SEL-16 |
| 2 | 옛 승인은 작성자 모르면 `legacy_unknown` actor, 사용자 NULL, `legacy_unverified`로 보존. 새 승인은 human actor·사용자 필수. 가짜 사람을 만들지 않음 |
| 3 | `question_versions.allow_comment_as_answer`: 현행 호환 질문은 덧붙임만으로도 응답 인정(기본 1). 의견을 추천 선택지 동의로 바꾸지 않음 |
| 4 | 가정 버전에 `assessed_at`, `needs_review`. 새 판으로 복사돼도 현행성을 자동 확인하지 않음 |
| 5 | thread 버전에 결론 메시지·요약, followup 버전에 대상 단계/라운드·기반/제안/결과 버전·적용 tx, reflection에 후속·적용 tx. `applied`는 실제 결과 증거 필수. 해결 ≠ 적용 |
| 6 | Go OFF 커밋 뒤: 새 전송 승인 금지, prepared 차단, in-flight는 취소 시도·상태 기록, **이미 나간 자료는 회수 보장 없음**. mode 문자열이 아니라 실제 목적지·요약·파일·재시도를 검사(SEL-22·24로) |
| 7 | PR 16: doctor 기본 진단과 `--fix` 분리, 테스트는 임시 홈만. PR 18: 입력 중 화면 갱신에도 미제출 답 보존 |
| 8 | run에 role·workflow_version·usage(모르면 NULL). Claude 앱은 지속 연결·heartbeat를 가정하지 않고, 끊긴 뒤 재접속·입력 반영 확인 방법을 SEL-24 완료 조건에 |
| 9 | 생성 순환 참조: 프로젝트는 staging + NULL 포인터로 만들고 소유자·초기 정책을 같은 트랜잭션에서 만든 뒤 활성화. 질문 원문 FK는 첫 버전과 한 트랜잭션. **SQL이 보장하는 것(참조·중복·부분 UNIQUE)과 서비스가 보장하는 것(상태 전이·6단계·fence·불변성)을 구분** |
