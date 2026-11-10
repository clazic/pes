# 2단계 Linear 이슈 원고 (승인 전)

## 요약

| 번호 | 제목 | 선행 | 크기 |
|---|---|---|---|
| PR1 | 스키마 001 + SQLite 연결 | 0단계 게이트, SEL-11·17 | L |
| PR2 | D1 호환 smoke | PR1 | S |
| PR3 | 새 형식 백업·export/import | PR1 | M |
| PR4 | 변경 명령 서비스 | PR1 | L |
| PR5 | run·lease·fence | PR4 | M |
| PR6 | 판·단계·라운드 명령 | PR4·5·9 | L |
| PR7 | 항목·버전·출처·연결 | PR4 | M |
| PR8 | 질문·답 | PR4·6 | M |
| PR9 | 결과물·객체 저장 | PR1·4·7 | M |
| PR10 | 행위자·토큰·전송 정책 | PR1·4 | M |
| PR11 | legacy importer | PR1·6·7·8·9·10, SEL-17 | L |
| PR12 | 이전 검증·되돌리기 | PR3·9·11 | M |
| PR13 | API: 맥락·claim·submit·complete | PR4·5·6·7·9·10 | L |
| PR14 | API: 질문·답·변경분·오류 | PR6·8·10·13 | L |
| PR15 | CLI 쓰기 전환 | PR4·5·6·7·8·9·10 | M |
| PR16 | CLI 읽기·보고서·doctor | PR7·9·15 | M |
| PR17 | 스킬 직접 편집 제거 | PR10·13·14·15·16 | L |
| PR18 | 로컬 화면 DB/API 전환 | PR8·10·13·14·15·16 | L |
| PR19 | A 내장 실행기 | PR5·10·13·14·17·18, SEL-18 | L |
| PR20a | 방식 B 어댑터 — Claude Code·Claude 앱 | PR5·10·13·14·17·18, SEL-19 | L |
| PR20b | 방식 B 어댑터 — Codex CLI·OpenCode TUI | PR20a, PR5·10·13·14·17·18, SEL-19 | M |
| PR20c | 방식 B 어댑터 — Codex 앱·OpenCode 앱 | PR20b, PR5·10·13·14·17·18, SEL-19 | M |
| PR21 | A·B 교차 계약 | PR18·19·20a·20b·20c, SEL-18·19 | M |
| PR22 | 전환 통합 검증·문서 | PR2·12·18·21·26, SEL-18·19 | L |
| PR26 | TypeScript 단일화·0.15 이전 | PR1·4·13·14·15·16·17·18·21 | L |

**나열 순서 ≠ 실행 순서(PR26 → PR22)**: 표의 PR22가 PR26보다 먼저 보여도 실제 실행은 PR26 다음 PR22다.

## 원고 정보

- 기준: [roadmap.md](../roadmap.md) 2절, [stage-2.md](../stage-2.md), [issues/stage-2.md](stage-2.md), 결정 [0013](../decisions/0013-mode-a-go-subscription-and-model-choice.md)·[0014](../decisions/0014-mode-b-codex-app-opencode-app.md)·[0016](../decisions/0016-core-language.md), 최신 검수 [2026-11-05-codex-review-2.md](../discussion/2026-11-05-codex-review-2.md)
- 상태: **승인 전 원고. Linear에 아직 등록하지 않았다.** 이 문서는 원고이며 코드·설정·다른 문서를 바꾸지 않는다.
- 범위: 2단계 **25개** — PR1~19, PR20a, PR20b, PR20c, PR21, PR22, PR26. 이슈 하나 = PR 하나.
- 공개 저장소 규칙: 실제 자료·실키·사용자 절대경로·세션 ID를 넣지 않는다. 아래 경로는 제품 설계상의 경로(`~/.pes`, `~/pes-projects`)일 뿐 실제 접근이 아니다.
- 붙여 넣는 방법: `## PRn: …` 한 블록이 이슈 하나다. 제목은 `##` 줄을 쓰고, 본문은 `+++ Agent notes` 앞까지 붙인다. 로드맵 6.3의 Linear 제목 규칙을 적용할 때는 `PRn:` 앞에 `[2단계 `와 `]`를 붙인다.
- 라벨: `ai-ready`는 아직 붙이지 않는다. 모든 이슈의 후보에 **`승인 후 ai-ready`**로 적었다.

## 머리말

### WEB0의 위치

**WEB0은 5단계 번호(WEB0~WEB15)지만 2단계 PR1 전에 실행한다.** 현재 언어 중립 JSON fixture와 최소 TS 구현으로 TS 계약·플랫폼 후보 3군을 시험하고, 결과를 0016·0005에 기록해 WEB1에 넘긴다. PR4·13·14 완료는 WEB0의 전제가 아니며, WEB0는 5단계 16개에 이미 포함되어 **새 이슈를 만들지 않는다.** PR1의 Linear 선행으로 걸지 않고, 2단계 착수 전 확인 항목으로 둔다.

### 0단계 게이트

S0 6절 게이트(SEL-11~19·31, `AGENTS.md`) 충족 전에는 PR1에 착수하지 않는다. PR1~18은 게이트 뒤 조건부로 진행하고, **PR19는 SEL-18, PR20a·20b·20c는 SEL-19, PR21·22는 SEL-18·19** 결과 뒤에 진행한다. 세부 선행은 각 이슈에 적었다.

### 용어

- **명령 서비스**: 모든 업무 쓰기가 지나는 하나의 닫힌 경로. 변경·사건·영수증을 같은 tx에 남긴다.
- **영수증**: 같은 키의 재요청을 재생하기 위한 기록. 권한·정책 검사 뒤에 재생한다.
- **lease·fence**: run이 프로젝트를 점유하는 임차와 세대 표시. 만료된 lease는 되살리지 않는다.
- **staging**: 실제 활성화 전에 사본을 적재하는 상태.
- **활성화**: 프로젝트 하나를 DB 상태의 원본으로 바꾸는 일. `project.json`은 읽기 전용이 된다.
- **legacy 읽기**: 아직 전환하지 않은 프로젝트를 `project.json`에서 읽기만 해 보여 주는 경로.

### 마일스톤 후보

| 마일스톤 | 묶음 |
|---|---|
| M1 스키마·명령 기반 | PR1~4 |
| M2 실행·판·내용 | PR5~10 |
| M3 이전 | PR11~12 |
| M4 API | PR13~14 |
| M5 CLI·스킬·화면 | PR15~18 |
| M6 A·B·교차 | PR19~21 |
| M7 언어 이전·출시 | PR26, PR22 |

---

## PR1: 스키마 001 + SQLite 연결

**설명**

상태의 원본을 `project.json`에서 SQLite로 옮기는 첫 조각이다. 61개 표를 마이그레이션으로 만들고, 임시 홈에서만 열어 실제 홈은 건드리지 않는다.

**완료 조건**

- [ ] 61표·FK·JSON 함수·SQLite 버전 검사를 임시 홈에서 통과한다.
- [ ] 대표 삽입·거부·rev 충돌이 전부 롤백된다.
- [ ] bootstrap(프로젝트·owner·초기 정책·첫 판)이 한 tx로 처리된다.
- [ ] SQL이 보장하는 것과 서비스가 보장하는 것(상태 전이·6단계·fence·불변 버전)을 문서에 구분한다.
- [ ] 실제 홈·실제 프로젝트에 접근하지 않는다.

**선행**: 0단계 게이트, SEL-11·SEL-17 완료

**라벨 후보**: `stage-2`, `type:impl`, `area:db`, `area:migration`, `승인 후 ai-ready`

**마일스톤 후보**: M1 스키마·명령 기반

+++ Agent notes
- 파일: `scripts/pes_core/{paths,db,ids,clock}.ts`, `scripts/pes_core/migrations/001_initial.sql`, `tests/fixtures/schema_seed.ts`
- 함수: `paths.pes_dir/db_path/objects_dir`, `db.connect`, `db.migrate`, `ids.new_id`, `clock.SystemClock/FakeClock`
- 시험: `tests/test_db_schema.test.ts`
- 테스트 공통 기반: **PR1에서 정할 TS fixture 헬퍼: `isolated_home`·`cli`·`synthetic_project` 대응**. Python `tests/conftest.py`는 PR26 이전 대상이다.
- 주의: DDL 원본은 `docs/plan/schemas/stage-1-ddl-draft.sql`. `db_meta` 초기 행(schema_version=1, database_instance_id, cursor_epoch=1). 트리거·FTS·ATTACH 없음. 3.5절은 표 자리만. 테스트 러너는 언어 시험 뒤 확정.
+++

## PR2: D1 호환 smoke

**설명**

같은 마이그레이션과 대표 명령이 로컬 D1에서도 같은 성공·실패 의미를 내는지 확인한다. 운영 D1은 건드리지 않는다.

**완료 조건**

- [ ] batch 원자성·deferred FK·부분 인덱스·JSON 함수·0행 실패를 로컬 D1에서 통과한다.
- [ ] 뒤늦은 실패가 전체 롤백된다.
- [ ] SQLite와 D1의 차이·실행 제한을 결정 기록에 남긴다.
- [ ] CI의 `d1-smoke`가 마이그레이션·DB 어댑터 변경 PR과 main에서 돈다.
- [ ] 운영 D1·Cloudflare 계정에 접근하지 않는다.

**선행**: PR1

**라벨 후보**: `stage-2`, `type:impl`, `area:db`, `area:ci`, `승인 후 ai-ready`

**마일스톤 후보**: M1 스키마·명령 기반

+++ Agent notes
- 파일: `tests/d1/wrangler.toml`, `tests/d1/package.json`, `scripts/pes_core/d1_smoke.ts`
- 함수: 마이그레이션 적용, batch 실행, 0행 실패 확인
- 시험: `tests/test_d1_smoke.test.ts`, CI job `d1-smoke`
- 주의: Node LTS·wrangler 버전 고정은 **D1 개발 도구 한정**이며 사용자 설치를 요구하지 않는다. **로컬 런타임은 0016 시험 뒤 정한다.** 로컬 D1만 사용. 0행을 성공으로 흘리지 않는다.
+++

## PR3: 새 형식 백업·export/import

**설명**

DB·객체·manifest·hash를 한 묶음으로 내보내고, 한 프로젝트만 다른 DB로 복원할 수 있게 한다.

**완료 조건**

- [ ] 프로젝트 2개 중 1개를 export해 새 DB로 import해도 다른 프로젝트·전역 설정이 그대로다.
- [ ] 손상 hash·누락 파일을 조용히 버리지 않고 보고한다.
- [ ] 복원 뒤 epoch가 올라가 옛 커서가 거부된다.
- [ ] 파일은 불투명 복사하고 ready·고아 규칙은 PR9·12에 맡긴다.
- [ ] 실행 중 DB를 동기화하지 않는다.

**선행**: PR1

**라벨 후보**: `stage-2`, `type:impl`, `area:db`, `area:backup`, `승인 후 ai-ready`

**마일스톤 후보**: M1 스키마·명령 기반

+++ Agent notes
- 파일: `scripts/pes_core/backup.ts`
- 함수: `export_project`, `verify_bundle`, `import_bundle`
- 시험: `tests/test_backup_export.test.ts`
- 주의: `manifest.json`에 `format_version`·`database_instance_id`·`cursor_epoch`·`project_id`·`files[{path,sha256,size}]`·표별 개수. **PR3는 export/import 골격 자체 시험을 갖고, 전체 복원 검증만 PR4·9·10 뒤 PR12와 통합한다.** 백업이 PES 홈·OneDrive 안이면 거부하는 검사는 PR12/22에서 완성.
+++

## PR4: 변경 명령 서비스

**설명**

모든 업무 쓰기를 하나의 닫힌 명령 서비스로 모은다. rev·멱등·사건·영수증을 같은 tx에 남긴다.

**완료 조건**

- [ ] 같은 키 같은 요청은 재생되고, 같은 키 다른 요청은 거부된다.
- [ ] 0행·늦은 실패가 전부 롤백되고 성공으로 보이지 않는다.
- [ ] 모든 변경에 사건과 영수증이 남고, 영수증은 장기 보존된다.
- [ ] 인증·권한·정책·목적지 검사가 영수증 재생보다 먼저다.
- [ ] OFF 전 완료 요청을 OFF 후 같은 키로 다시 보내도 금지된 결과가 재생되지 않는다.
- [ ] 언어 중립 JSON 계약 픽스처가 있다.
- [ ] 서비스 밖에서 업무 표를 직접 쓰는 코드가 0이다.

**선행**: PR1

**라벨 후보**: `stage-2`, `type:impl`, `area:core`, `area:command`, `승인 후 ai-ready`

**마일스톤 후보**: M1 스키마·명령 기반

+++ Agent notes
- 파일: `scripts/pes_core/errors.ts`, `scripts/pes_core/commands.ts`, `tests/fixtures/contracts/commands/*.json`
- 함수: `ApiError`, `error_envelope`, `CommandService.execute`, `COMMANDS`, `MutationContext`
- 시험: `tests/test_command_service.test.ts`
- 주의: 순서 = 인증·권한·현재 정책·목적지 → 영수증 재생 → rev/lease → 변경 → `events`·영수증. `PolicyChecker` 인터페이스만 PR4가 정의하고 구현은 PR10이 주입한다. 표 CRUD·임의 ops 없음.
+++

## PR5: run·lease·fence

**설명**

claim·heartbeat·wait·complete·인계를 원자적으로 만들고, 질문 대기 중에는 lease를 놓게 한다.

**완료 조건**

- [ ] 가상 시계로 만료·옛 fence 거부·대기 중 해제/재획득을 시험한다.
- [ ] 만료된 lease가 되살아나지 않는다.
- [ ] `applied`는 증거(`applied_tx_id`)가 있을 때만 인정된다.
- [ ] 인계 뒤 같은 입력이 중복 반영되지 않는다.
- [ ] TTL·heartbeat 기본값을 코드에 하드코딩하지 않는다.

**선행**: PR4

**라벨 후보**: `stage-2`, `type:impl`, `area:core`, `area:run`, `승인 후 ai-ready`

**마일스톤 후보**: M2 실행·판·내용

+++ Agent notes
- 파일: `scripts/pes_core/runs.ts`, `scripts/pes_core/config.ts`
- 함수: `claim`, `heartbeat`, `wait`, `complete`, `release`, `handoff`, `interrupt`, `record_receipt`
- 시험: `tests/test_runs_leases.test.ts`
- 주의: `wait`는 `waiting_human`+lease 해제+`events`+영수증을 한 tx. `project_leases`는 프로젝트당 활성 lease 하나, fence 증가. `complete`는 run 종료일 뿐 승인 아님.
+++

## PR6: 판·단계·라운드 명령

**설명**

봉인·승인·reopen·stale·이월·snapshot을 1판 흐름 그대로 구현한다. `complete`는 run 종료일 뿐 승인이 아니다.

**완료 조건**

- [ ] 합성 6단계 흐름이 돈다.
- [ ] reopen 뒤 stale·승인 유지와 실행 기반 무효화가 확인된다.
- [ ] `complete`·`seal`·`approve`가 서로 다른 사건으로 남는다.
- [ ] 승인 전 봉인과 허가된 에이전트 봉인은 성공하고, 에이전트 단계 승인은 거부된다.
- [ ] 여러 단계의 남은 QA 지적·미완료 요청이 승인·이전 뒤에도 남고 다음 R1에 보인다.
- [ ] snapshot/manifest가 정확한 버전을 가리킨다.

**선행**: PR4·5·9

**라벨 후보**: `stage-2`, `type:impl`, `area:core`, `area:edition`, `승인 후 ai-ready`

**마일스톤 후보**: M2 실행·판·내용

+++ Agent notes
- 파일: `scripts/pes_core/editions.ts`
- 함수: `create_edition`, `start_round`, `seal_round`, `approve_stage`, `reopen_stage`, `release_completion`, `carry_over`, `snapshot`
- 시험: `tests/test_editions_stages.test.ts`
- 주의: `carry_over`는 두 갈래다. (a) 조사 주제 파생 = `artifacts(kind='topic')`의 정확한 버전에서 새 조사 topic을 만들고 `origin_version_id`·`version_relations`로 연결. (b) 단계 미완료 작업 이월 = `followups`·`followup_versions(kind='next_round_task', target_stage_id, target_round_id)`에 원 요청·대상·출처·버전을 보존하고 다음 R1에서 조회. 4단계 판 비교·이월 마법사는 만들지 않는다.
+++

## PR7: 항목·버전·출처·연결

**설명**

항목·보고서·출처를 불변 버전으로 쌓고, 각주·연결·library를 보존한다.

**완료 조건**

- [ ] 과거 버전을 UPDATE/DELETE하는 경로가 없다.
- [ ] 현재 포인터는 자기 버전만 가리킨다.
- [ ] 각주 순서·같은 URL 다른 자료·옛 연결이 유지된다.
- [ ] 출처 확인 시점·발췌·위치·방법/판정이 저장된다.
- [ ] 못 읽은 자료에 발췌를 붙이지 않는다.
- [ ] `library.json`이 항목·출처로 옮겨지고 원본도 보존된다.

**선행**: PR4

**라벨 후보**: `stage-2`, `type:impl`, `area:core`, `area:content`, `승인 후 ai-ready`

**마일스톤 후보**: M2 실행·판·내용

+++ Agent notes
- 파일: `scripts/pes_core/content.ts`
- 함수: `create_object`, `append_version`, `set_current`, `add_artifact`, `add_source`, `add_citation`, `link_relation`, `import_library`
- 시험: `tests/test_content_sources.test.ts`
- 주의: 표 `objects`, `object_versions`, `artifacts`, `artifact_versions`, `artifact_components`, `version_relations`, `sources`, `source_versions`, `citations`. URL만으로 합치지 않는다. 참조 파일 저장은 PR9/11 경계.
+++

## PR8: 질문·답

**설명**

사람이 실제로 본 질문/폼 버전과 답·의견을 원자적으로 보존한다.

**완료 조건**

- [ ] 폼·질문 버전이 답에 고정된다.
- [ ] 새 질문 버전은 옛 답을 승계하지 않고 재확인을 요구한다.
- [ ] 덧붙임만으로 응답을 인정하지 않는다(`allow_comment_as_answer`).
- [ ] 기본값·추천을 자동 답으로 채우지 않는다.
- [ ] 묶음 제출이 전부 성공하거나 전부 실패한다.
- [ ] `__other`가 추천 동의로 바뀌지 않는다.

**선행**: PR4·6

**라벨 후보**: `stage-2`, `type:impl`, `area:core`, `area:question`, `승인 후 ai-ready`

**마일스톤 후보**: M2 실행·판·내용

+++ Agent notes
- 파일: `scripts/pes_core/questions.ts`
- 함수: `publish_set`, `revise_question`, `submit_answers`, `validate_submission`, `resume_ready`
- 시험: `tests/test_questions_answers.test.ts`
- 주의: `question_sets`, `question_set_members`, `questions`, `question_versions`, `submissions`, `answers`, `answer_versions`. `__other`는 `threads`/`messages` 최소 행. 서버 답 초안 API 없음. `resume_ready`는 PR5/14와 같은 함수·계약을 쓴다.
+++

## PR9: 결과물·객체 저장

**설명**

파일을 hash·ready로 채택하고, 보고서가 정확한 버전을 참조하게 한다.

**완료 조건**

- [ ] 경로·서명 URL을 ID로 쓰지 않는다.
- [ ] 손상 hash는 ready가 되지 않고, 다른 프로젝트 blob 접근이 차단된다.
- [ ] 같은 바이트는 중복 저장하지 않되 계보는 유지한다.
- [ ] 고아·격리 파일을 정리한다.
- [ ] 채택·저장·공유·인쇄 버전이 모두 보존된다.

**선행**: PR1·4·7

**라벨 후보**: `stage-2`, `type:impl`, `area:core`, `area:files`, `승인 후 ai-ready`

**마일스톤 후보**: M2 실행·판·내용

+++ Agent notes
- 파일: `scripts/pes_core/files.ts`
- 함수: `reserve_upload`, `store_blob`, `complete_upload`, `get_blob`, `gc_orphans`, `assert_project_access`
- 시험: `tests/test_blobs.test.ts`
- 주의: `blobs`, `version_files`; `storage_key`·`sha256`·`size`·`media_type`·`state(staging/ready/quarantined)`. staging→hash→ready. Go 파일 읽기 프록시는 PR10/19 경계. 테스트는 임시 HOME만.
+++

## PR10: 행위자·토큰·전송 정책

**설명**

실제 actor·프로젝트 토큰·Go ON/OFF 정책을 서버가 확정하고 감사한다. 토큰 원문은 한 번만 보여 준다.

**완료 조건**

- [ ] 토큰은 해시·범위·30일·회수로 관리되고 원문이 로그·DB에 남지 않는다.
- [ ] 정책 변경·재허용은 사람만 할 수 있다.
- [ ] OFF 뒤 `prepared`는 차단되고 `authorized` 미송신만 차단된다.
- [ ] `unknown`·`sent` 이력과 옛 lease 채택 차단이 남는다.
- [ ] 정책 손상·합성 자료도 우회하지 않는다.
- [ ] 정책 검사가 영수증 재생보다 먼저다.

**선행**: PR1·4

**라벨 후보**: `stage-2`, `type:impl`, `area:security`, `area:policy`, `승인 후 ai-ready`

**마일스톤 후보**: M2 실행·판·내용

+++ Agent notes
- 파일: `scripts/pes_core/actors.ts`, `scripts/pes_core/policy.ts`
- 함수: `resolve_actor`, `require_human_owner`, `issue_agent_token`, `verify_agent_token`, `revoke_agent_token`; `current_policy`, `set_policy`, `check_go_allowed`, `prepare_dispatch`, `authorize_dispatch`, `mark_sent`, `block_dispatch`
- 시험: `tests/test_actors_policy.test.ts`
- 주의: 표 `actors`, `agent_tokens`, `project_policy_versions`, `outbound_dispatches`. 실제 Go 네트워크 호출 없음(가짜 transport). 정책 기본값은 stage-0 7-1 그대로. 모르는 비용을 0으로 표시하지 않는다.
+++

## PR11: legacy importer

**설명**

기존 `project.json`과 부속 파일을 staging DB로 손실 없이 옮기고 매핑을 남긴다. 실제 프로젝트는 읽지 않는다.

**완료 조건**

- [ ] 깨진 fixture·2MB fixture·완전 합성 fixture에서 원본 hash가 변하지 않는다.
- [ ] 재실행이 멱등하고 중복이 0이다.
- [ ] 미지 필드·미처리 답·누락 파일을 보고서에 남긴다.
- [ ] 옛 승인은 `legacy_unknown`·사용자 NULL·`legacy_unverified`로 표시한다.
- [ ] 옛 carry_over가 `next_round_task`로 보존되고 다음 R1에 보인다.
- [ ] 새 정책 기본값을 과거 동의로 기록하지 않는다.

**선행**: PR1·6·7·8·9·10, SEL-17

**라벨 후보**: `stage-2`, `type:impl`, `area:migration`, `area:legacy`, `승인 후 ai-ready`

**마일스톤 후보**: M3 이전

+++ Agent notes
- 파일: `scripts/pes_core/legacy.ts`
- 함수: `scan_project`, `import_project`, `map_legacy`, `report_unknown`
- 시험: `tests/test_legacy_import.test.ts`
- 주의: 입력 `project.json`, `library.json`, `feedback/`, `feedback.log`, `snapshots/`, `reports/`, `out/`, `shots/`, `ask/`, `rounds/`, `library/`. `import_batches(state=staging)`·`legacy_mappings`. `migration-map.md:90`과 맞춘다. 원본 삭제 금지.
+++

## PR12: 이전 검증·되돌리기

**설명**

사본→staging→검증→활성화와 쓰기 전/후 복구를 합성 fixture로 증명한다.

**완료 조건**

- [ ] 사본→staging→검증→활성화가 프로젝트 하나에만 적용된다.
- [ ] 원본이 변하지 않는다.
- [ ] 쓰기 전에는 원본 JSON으로 다시 연결하고, 쓰기 후에는 프로젝트 단위로 DB+객체를 복구한다.
- [ ] 다른 프로젝트가 영향을 받지 않는다.
- [ ] 복원 손실 범위와 커서 초기화를 사용자에게 알린다.
- [ ] 실제 파일럿은 PR22로 분리한다.

**선행**: PR3·9·11

**라벨 후보**: `stage-2`, `type:impl`, `area:migration`, `area:restore`, `승인 후 ai-ready`

**마일스톤 후보**: M3 이전

+++ Agent notes
- 파일: `scripts/pes_core/migration.ts`
- 함수: `validate_import`, `activate_import`, `rollback_before_write`, `restore_project`
- 시험: `tests/test_migration_restore.test.ts`
- 주의: 검증은 개수·본문·ID·연결·파일 hash·미처리 답·보고서 재생성. `import_batches.state` 전이. 여러 프로젝트 DB 전체 되감기를 기본으로 하지 않는다. 실제 프로젝트 이전은 PR22 사용자 허용 전 금지.
+++

## PR13: API: 맥락·claim·submit·complete

**설명**

한 run의 최소 경로 `context→claim→submit→complete`를 HTTP/JSON 계약으로 만든다. 파일 HTTP와 `project.create`도 여기서 맡는다.

**완료 조건**

- [ ] OpenAPI·예제와 실제 응답이 일치한다.
- [ ] rev 충돌 시 부분 저장이 없다.
- [ ] long-poll이 tx를 잡지 않는다.
- [ ] 토큰 범위 위반은 403, 정책 차단은 자동 재시도하지 않는다.
- [ ] 파일 예약·업로드 완료·ready·Go OFF 읽기 차단이 시험된다.
- [ ] `project.create`가 owner·초기 정책·첫 판을 한 tx로 만든다.
- [ ] 10진 문자열·닫힌 명령·미지원 필드 거부가 시험된다.
- [ ] `capabilities`는 **PR13이 라우트를 열고 PR14가 완성 시험**을 맡는다. `GET P/operations/{id}`·`GET P/requests/{key}`의 PR13/14 귀속이 표에 맞는다.
- [ ] HTTP 표는 **HTTP 노출(PR13)**과 **코어 명령(PR5·6)**을 두 칸으로 구분한다.

**선행**: PR4·5·6·7·9·10

**라벨 후보**: `stage-2`, `type:impl`, `area:api`, `승인 후 ai-ready`

**마일스톤 후보**: M4 API

+++ Agent notes
- 파일: `scripts/pes_core/api.ts`, `scripts/serve.py`(얇은 경계), `docs/api/openapi-v1.yaml`
- 함수: `ApiApp`, `GET /api/v1/capabilities`, `GET /api/v1/projects/{id}/context`, `POST /api/v1/projects/{id}/runs`, `POST /api/v1/projects/{id}/claims`, `POST /api/v1/projects/{id}/runs/{r}/wait`, `/results`, `/complete`, uploads·files, `project.create`
- 시험: `tests/test_api_context.test.ts`, `tests/test_api_files_policy.test.ts`, `tests/test_api_project_create.test.ts`, `tests/fixtures/contracts/api/*.json`
- 주의: `P = /api/v1/projects/{id}`. canonical은 `POST P/claims`(`POST P/runs/{r}/claims` 아님). **HTTP 노출은 PR13, 코어 명령은 PR5·6**으로 표에 나눈다. `capabilities`는 PR13 라우트·PR14 완성 시험. 파일 HTTP는 PR13, 저장 코어는 PR9. `complete`≠승인. 서버 답 초안 없음.
+++

## PR14: API: 질문·답·변경분·오류

**설명**

질문 게시·수정, 답 제출, 변경분 커서, 사람 전용 승인·reopen, 오류 봉투를 완성한다.

**완료 조건**

- [ ] 사람 세션과 에이전트 토큰이 구분된다.
- [ ] 승인·reopen은 소유자 사람만 할 수 있고 에이전트는 403이다.
- [ ] 커서 epoch가 바뀌면 재동기화되고 미제출 답은 보존된다.
- [ ] long-poll·영수증·202 조회가 재시작 뒤에도 동작한다.
- [ ] `project.register`가 project token 없는 최초 등록을 기기 승인으로 처리한다.
- [ ] 한 라운드 전체가 PR13+14 합동 시험으로 통과한다.
- [ ] `capabilities` 완성 시험(PR13 라우트, 미지원·가짜 성공 없음)이 통과한다.
- [ ] 2단계 경로 누락이 0이다.

**선행**: PR6·8·10·13

**라벨 후보**: `stage-2`, `type:impl`, `area:api`, `승인 후 ai-ready`

**마일스톤 후보**: M4 API

+++ Agent notes
- 파일: `scripts/pes_core/api.ts`
- 함수: `POST P/questions`, `/revisions`, `POST P/submissions`, `GET P/changes`, `POST P/stages/{s}/approve`, `/reopen`, `POST P/runs/{r}/inputs`·`/input-receipts`, `/heartbeat`·`/release`·`/interrupt`·`/cancel`·`/handoffs`, `GET P/operations/{id}`·`GET P/requests/{key}`, `POST /api/v1/project-registrations`
- 시험: `tests/test_api_questions.test.ts`, `tests/test_api_project_register.test.ts`
- 주의: 단수 `/handoff`가 아니라 **`/handoffs`**. 202는 영속 접수만 뜻한다. 요청 제한·poll 간격·429 Retry-After. `capabilities`는 PR13 라우트·PR14 완성 시험으로 나눈다. **PR14는 `project-registrations` API를 만들고, PR20a가 빈 계정에서 그 API를 쓰는 B 최초 등록 종단 시험을 맡는다.**
+++

## PR15: CLI 쓰기 전환

**설명**

기존 쓰기 명령을 모두 명령 서비스로 바꾸고, `context/claim/submit/wait/complete` CLI를 붙인다.

**완료 조건**

- [ ] 기존 쓰기 19개와 신규 5개가 모두 명령 서비스를 지난다.
- [ ] `project.json` 직접 쓰기가 0이다.
- [ ] `pes home`이 DB·객체를 옮기지 않는다.
- [ ] 잠금 인계가 lease와 맞는다.
- [ ] 승인·권한 우회 동작을 승계하지 않는다.
- [ ] CLI가 actor·owner 자격을 확정하고 같은 권한 검사를 통과한다.

**선행**: PR4·5·6·7·8·9·10

**라벨 후보**: `stage-2`, `type:impl`, `area:cli`, `승인 후 ai-ready`

**마일스톤 후보**: M5 CLI·스킬·화면

+++ Agent notes
- 파일: `scripts/pes.py`(0.15 얇은 경계), `scripts/pes_core/commands.ts`
- 함수: `cmd_init`, `cmd_ask_prep`, `cmd_ask`, `cmd_round_start`, `cmd_merge`, `cmd_render`, `cmd_approve`, `cmd_reopen`, `cmd_mark`, `cmd_chat`, `cmd_note`, `cmd_qa_brief`, `cmd_qa`, `cmd_remote`, `cmd_serve`, `cmd_stop`, `cmd_home`, `cmd_lock`, `cmd_unlock`, `cmd_context`, `cmd_claim`, `cmd_submit`, `cmd_wait`, `cmd_complete`
- 시험: `tests/test_cli_write.test.ts`
- 주의: Python이 TS를 직접 import하지 않는다. 프로세스/HTTP/JSON 얇은 경계. CMDS 32개 배정은 `stage-2.md` 4.3. `pes home`은 프로젝트 폴더와 목록 화면만 옮긴다.
+++

## PR16: CLI 읽기·보고서·doctor

**설명**

읽기·보고서·진단을 DB에서 다시 만들고, 미전환 프로젝트는 읽기 전용 legacy로 제공한다.

**완료 조건**

- [ ] 보고서가 정확한 버전·각주로 재생성된다.
- [ ] doctor가 기본 진단과 `--fix`를 분리하고 임시 홈만 쓴다.
- [ ] legacy는 읽기만 하고 쓰기는 이전 안내로 막는다.
- [ ] `pes watch`가 같은 출력 형식이나 입력 long-poll로 유지된다.
- [ ] `report/assemble/web`의 쓰기가 PR9 경계를 지난다.
- [ ] PR12 `validate_import`의 보고서 재생성(`regeneration_format: "provisional"`)을 실제 생성기로 바꾸고 옛 보고서와의 불일치를 문제로 올린다.

**선행**: PR7·9·15

**라벨 후보**: `stage-2`, `type:impl`, `area:cli`, `area:report`, `승인 후 ai-ready`

**마일스톤 후보**: M5 CLI·스킬·화면

+++ Agent notes
- 파일: `scripts/pes.py`, `scripts/pes_core/content.ts`, `scripts/pes_core/files.ts`
- 함수: `cmd_status`, `cmd_pending`, `cmd_digest`, `cmd_show`, `cmd_list`, `cmd_hub`, `cmd_open`, `cmd_which`, `cmd_doctor`, `cmd_watch`, `cmd_assemble`, `cmd_report`, `cmd_web`
- 시험: `tests/test_cli_read.test.ts`
- 주의: 보고서 덮어쓰기 대신 새 버전. legacy는 `project.json` 읽기만. doctor는 소유 프로세스·포트·경로 quoting까지 진단.
+++

## PR17: 스킬 직접 편집 제거

**설명**

스킬·에이전트 지침에서 PES 업무 상태 직접 쓰기를 없애고, 중립 워크플로·어댑터 노트로 바꾼다.

**완료 조건**

- [ ] core+plan 파일럿이 합성 1회를 통과한 뒤 전체 스킬로 넓힌다.
- [ ] `project.json`·업무 표 직접 쓰기가 0이다.
- [ ] lint는 업무 상태를 직접 바꾸는 경로만 막고, 자식 제안 파일·합성 테스트·신뢰 서비스 SQL은 허용한다.
- [ ] 연구 절차·독립 검토·근거 확인이 유지된다.
- [ ] Claude 전용 표기는 어댑터 노트 예외 위치에만 둔다.
- [ ] 업무 경로별 검증 명령 사용을 확인한다(문자열 0건만이 아님).

**선행**: PR10·13·14·15·16

**라벨 후보**: `stage-2`, `type:impl`, `area:skills`, `area:lint`, `승인 후 ai-ready`

**마일스톤 후보**: M5 CLI·스킬·화면

+++ Agent notes
- 파일: `skills/core/SKILL.md`, `skills/{research,analyze,write,verify,publish}/SKILL.md`, `agents/*.md`, `commands/*.md`, `scripts/lint_skills.ts`, `docs/adapters/{opencode,claude-code,claude-app}.md`
- 함수: lint 규칙(`project.json` 쓰기, `sqlite3` 업무 표 쓰기, 파일 잠금 직접 조작 금지)
- 시험: `tests/test_skill_lint.test.ts`
- 주의: `skills/core/SKILL.md:62-84`의 Python 직접 편집 예제를 `pes context/submit/ask/...`로 바꾼다. 광범위 grep으로 정상 구현을 막지 않는다. `anthropic-skills:*` 이름만 바꿔 변환 지원을 주장하지 않는다.
+++

## PR18: 로컬 화면 DB/API 전환

**설명**

기존 화면을 같은 URL·같은 동작으로 DB/API에 연결한다. 새 디자인과 이중 쓰기는 넣지 않는다.

**완료 조건**

- [ ] 동등성 매트릭스가 통과한다.
- [ ] `__other`·`show_if`·필수·추천·원격 답·approve/reopen·단계/최종/eli5 보고서·인쇄·`ask-*` 딥링크가 유지된다.
- [ ] 입력 중 갱신·충돌·타임아웃·커서 무효에도 초안이 보존된다.
- [ ] 소유자 세션·CSRF·안전한 Markdown이 적용된다.
- [ ] Playwright 스모크가 Windows/Mac에서 통과하고, Windows CI는 브라우저 설치 실패 시 실패한다.
- [ ] Go in-flight/unknown·run 상태 최소 표시가 있다.
- [ ] 이중 쓰기가 0이다.

**선행**: PR8·10·13·14·15·16

**라벨 후보**: `stage-2`, `type:impl`, `area:ui`, `area:parity`, `승인 후 ai-ready`

**마일스톤 후보**: M5 CLI·스킬·화면

+++ Agent notes
- 파일: `scripts/pes.py`(`load`, `brief`, `build_index`, `build_hub`, `fill`), `scripts/serve.py`, `templates/{dashboard,ask,_questions,hub,stage-report,final-report,eli5}.html`
- 함수: 기존 0.15 동작과 같은 **`POST /<slug>/feedback`**(로컬 서버 기준)을 `CommandService` 제출로, `/version`을 DB 커서 기반으로. 새 API 답 제출 경로는 별도 표기한다.
- 시험: `tests/test_web_parity.test.ts`, `tests/e2e/workspace_smoke.spec.ts`
- 주의: `/api/v1`을 정적 서빙보다 먼저. 픽셀 기준선을 만들지 않고 알려진 차이는 PR18 문서에 남긴다. 실제 홈·실자료 금지.
+++

## PR19: A 내장 실행기

**설명**

PES가 OpenCode Go HTTP API를 직접 호출하고, 에이전트 루프·업무 도구·사용량 보호·모델 선택을 직접 맡는다. opencode serve·CLI·로컬 runner는 두지 않는다.

**완료 조건**

- [ ] 합성 1개가 6단계를 돈다(wait/resume/interrupt 포함).
- [ ] Go OFF가 호출마다 차단된다.
- [ ] 사용량 추정 문턱(기본 90%)·한도 오류·과금 표시·unknown fail-closed가 시험된다.
- [ ] Extra Usage OFF 확인·만료·확인 불가 차단이 시험된다.
- [ ] 호출 전 attempt/상관키·응답 유실 unknown·자동 재호출 금지·저장 재시도 분리가 시험된다.
- [ ] `blocked_usage`+사유/reset·lease 해제·사람 재개가 확인된다.
- [ ] 시작 때 고른 모델 하나로만 가고 폴백이 없다.
- [ ] Go API 주소·모델 목록·원시/내부 model ID·구독 적용 조건이 기록된다.
- [ ] 실제 자료를 쓰지 않는다.

**선행**: PR5·10·13·14·17·18, SEL-18

**라벨 후보**: `stage-2`, `type:impl`, `area:runtime`, `area:mode-a`, `blocked:SEL-18`, `승인 후 ai-ready`

**마일스톤 후보**: M6 A·B·교차

+++ Agent notes
- 파일: `scripts/pes_core/a_runtime/{go_client,loop,tools}.ts`, `docs/adapters/a-builtin.md`
- 함수: Go 호출(주소·모델 목록·원시/내부 ID·구독 조건 검증), 에이전트 루프, 도구 allowlist
- 시험: `tests/test_a_builtin.test.ts`(가짜 Go HTTP 서버)
- 주의: allowlist는 `context.get`, `result.submit`, `question.ask`, `assumption.propose`, `decision.propose`, `reflection.write`, `thread.reply`, `followup.propose`. 파일시스템·셸·임의 네트워크 없음. `runs.runtime=pes_builtin`, `runs.model`에 실제 ID. 호출 전 정책·사용량·Extra Usage OFF·키·모델 확인, 확인 불가면 차단. 모델 호출 재시도와 저장 재시도를 분리한다.
+++

## PR20a: 방식 B 어댑터 — Claude Code·Claude 앱

**설명**

Claude Code MCP·CLI와 Claude 앱 Desktop/명시적 전달이 같은 PES API로 작업하게 하고, 20b·20c가 쓸 공통 MCP bridge·adapter 계약을 만든다.

**완료 조건**

- [ ] Claude Code가 합성 6단계를 돈다.
- [ ] Claude 앱이 1단계 왕복·재접속을 통과한다. 안 되면 명시적 전달로 같은 의미를 확인한다.
- [ ] 복사≠제출, 중복 가져오기 0, 실제 제출 actor가 구분된다.
- [ ] **PR14의 `project-registrations` API를 사용해** 빈 계정/새 프로젝트에서 B 최초 `project.register`→run→결과가 통과한다.
- [ ] 진행·스케줄 이벤트가 같은 형식·멱등 키로 기록된다.
- [ ] `pes link`/`sync` 로컬 계약이 문서만 보고 재현된다.

**선행**: PR5·10·13·14·17·18, SEL-19

**라벨 후보**: `stage-2`, `type:impl`, `area:adapter`, `area:mode-b`, `blocked:SEL-19`, `승인 후 ai-ready`

**마일스톤 후보**: M6 A·B·교차

+++ Agent notes
- 파일: `scripts/pes_core/mcp_server.ts`, `scripts/pes_core/adapters/{claude_code,claude_app}.ts`, `docs/adapters/{adapter-contract,claude-code,claude-app}.md`
- 함수: MCP 도구 `pes_context/claim/submit/ask/wait/complete` + heartbeat·release·cancel·영수증
- 시험: `tests/test_adapter_b_claude.test.ts`
- 주의: 전달 묶음에 프로젝트·판·단계·라운드·기반 버전·요청 ID·manifest hash. **hash는 인증 증명이 아니다.** 복사 중 lease 없음. 앱 지속 heartbeat를 가정하지 않는다.
+++

## PR20b: 방식 B 어댑터 — Codex CLI·OpenCode TUI

**설명**

20a의 공통 MCP bridge·계약으로 Codex CLI·OpenCode TUI를 붙인다. A의 내장 실행기와 사람이 직접 켜는 OpenCode TUI를 구분한다.

**완료 조건**

- [ ] Codex CLI·OpenCode TUI가 각각 합성 1라운드+재개를 통과한다.
- [ ] actor/runtime이 정확하고 모델·사용량 미상은 `unknown`이다.
- [ ] 중복 제출·같은 키 다른 요청이 거부된다.
- [ ] A 내장 실행기와 서로 간섭하지 않는다.
- [ ] Go 경로 차단/한계를 표기한다.
- [ ] 노트만 보고 새 환경에서 연결 절차를 재현한다.

**선행**: PR20a, PR5·10·13·14·17·18, SEL-19

**라벨 후보**: `stage-2`, `type:impl`, `area:adapter`, `area:mode-b`, `blocked:SEL-19`, `승인 후 ai-ready`

**마일스톤 후보**: M6 A·B·교차

+++ Agent notes
- 파일: `scripts/pes_core/adapters/{codex_cli,opencode_tui}.ts`, `docs/adapters/{codex,opencode-tui}.md`
- 함수: 어댑터 진입, `runtime=codex_cli/opencode_tui`, `runs.mode=B`, `actors.kind=external_agent`
- 시험: `tests/test_adapter_b_codex.test.ts`, `tests/test_adapter_b_opencode_tui.test.ts`
- 주의: 토큰은 OS 키체인. 모델·사용량 미상은 `unknown`. 승인·reopen·정책·토큰·삭제·export 도구 없음. OpenCode TUI는 A 내장 실행기가 아니다.
+++

## PR20c: 방식 B 어댑터 — Codex 앱·OpenCode 앱

**설명**

20a 계약·20b 노트를 재사용해 Codex 앱·OpenCode 앱을 붙인다. 직접 연결이 안 되면 명시적 전달을 보장 경로로 둔다.

**완료 조건**

- [ ] Codex 앱·OpenCode 앱이 각각 합성 1라운드+재개를 통과한다.
- [ ] 직접 연결/전달 경로와 actor/runtime이 정확하다.
- [ ] 직접 인증 앱은 `external_agent`, 수동 전달은 `human`으로 기록된다.
- [ ] 중복 제출·같은 키 다른 요청·버전 오류가 거부된다.
- [ ] A 내장 실행기·OpenCode TUI와 간섭하지 않는다.
- [ ] 설정 공유는 시험 결과로만 적고 보장으로 쓰지 않는다.

**선행**: PR20b, PR5·10·13·14·17·18, SEL-19

**라벨 후보**: `stage-2`, `type:impl`, `area:adapter`, `area:mode-b`, `blocked:SEL-19`, `승인 후 ai-ready`

**마일스톤 후보**: M6 A·B·교차

+++ Agent notes
- 파일: `scripts/pes_core/adapters/{codex_app,opencode_app}.ts`, `docs/adapters/{codex-app,opencode-app}.md`
- 함수: `runtime=codex_app/opencode_app`, 명시적 전달(묶음 복사→가져오기)
- 시험: `tests/test_adapter_b_codex_app.test.ts`, `tests/test_adapter_b_opencode_app.test.ts`
- 주의: Codex 앱의 `~/.codex/config.toml` 공유, OpenCode 앱의 MCP 설정 공유는 **미확인**이며 시험 결과로 적는다. OpenCode 앱은 A의 프로필·서버를 재사용하거나 중단하지 않는다.
+++

## PR21: A·B 교차 계약

**설명**

A와 B가 같은 DB 상태에서 같은 의미·권한·오류를 내고, 인계·중복·충돌에서 유실이 없음을 자동 시험한다.

**완료 조건**

- [ ] 같은 DB 상태에서 같은 문구·권한이 나온다.
- [ ] 유실·중복이 0이고 옛 fence가 거부된다.
- [ ] A→B·B→A 인계 뒤 새 claim/fence가 선다.
- [ ] 지연 응답·프로세스 종료·Go OFF·사용량 문턱 인계가 시험된다.
- [ ] `unknown` 예약을 자동 해제하지 않는다.
- [ ] SQLite/D1이 같은 성공·충돌·부분 실패를 낸다.
- [ ] B는 6개 도구를 모두 포함한다.

**선행**: PR18·19·20a·20b·20c, SEL-18·19

**라벨 후보**: `stage-2`, `type:impl`, `area:test`, `area:contract`, `승인 후 ai-ready`

**마일스톤 후보**: M6 A·B·교차

+++ Agent notes
- 파일: `tests/test_cross_contract.test.ts`, `tests/fixtures/contracts/cross/*.json`, `docs/plan/decisions/<미사용 번호>-cross-contract.md`
- 함수: 가짜 A/B 런타임, 같은 결과·인계·지연·종료·OFF·중복 시나리오
- 주의: Go 실측은 PR19/20a·20b·20c가 맡고, 반복 계약은 가짜 런타임으로 돌린다. CI에서 유료 모델 호출 없음. B의 외부 비용을 PES가 집행했다고 표시하지 않는다.
+++

## PR22: 전환 통합 검증·문서

**설명**

Windows/Mac 설치·복구·백업·이전 runbook을 검증하고, TypeScript 단일 코드베이스에서 사용자 허용 시 실제 프로젝트 1개를 파일럿한다.

**완료 조건**

- [ ] CI가 매 PR·main에서 Windows/Mac으로 돌고 복원 훈련이 통과한다.
- [ ] 허용 시 실제 프로젝트 1개 파일럿에서 원본이 보존된다.
- [ ] 문서만 보고 설치·복구·이전을 재현한다.
- [ ] 공개 저장소에 민감 자료가 0이다.
- [ ] 실제 자료 사용 허용 기록(범위·목적지·기간·철회)이 로컬에 남고, 만료·철회 뒤 접근이 차단된다.
- [ ] 0.16.0을 한 번만 배포하고 이전 전 쓰기 제한을 먼저 알린다.
- [ ] 사용자 "3단계로 넘어가도 된다" 승인을 받는다.

**선행**: PR2·12·18·21·26, SEL-18·19

**라벨 후보**: `stage-2`, `type:release`, `area:docs`, `area:release`, `needs:user-decision`, `승인 후 ai-ready`

**마일스톤 후보**: M7 언어 이전·출시

+++ Agent notes
- 파일: `docs/guides/stage-2.md`, `docs/plan/decisions/<미사용 번호>-stage-2-release.md`, `README.md`, `tests/test_transition_docs.test.ts`
- 함수: 문서 링크·명령·경로 검사, 실제 자료 사용 허용 기록
- 시험: CI 매 PR·main Windows/Mac, Playwright, D1 smoke, 복원 훈련
- 주의: 실제 파일럿은 사용자 허용 slug 1개, **A 실행 없이** 답·승인·reopen·인쇄·기존 화면만. 실제 manifest·경로·보고서는 로컬에만. PR22 미실시 시 T1이 최초 기록을 만들고, 기록이 있으면 새 목적지만 추가한다. 플러그인 버전은 PR22 통과·승인 뒤 한 번만 올린다.
+++

## PR26: TypeScript 단일화·0.15 이전

**설명**

Python 0.15(`pes.py`·`serve.py`, pytest, 설치 스크립트, 스킬 호출)를 TS로 옮겨 0.16.0을 TypeScript 단일 코드베이스로 만든다. 새 기능은 만들지 않는다.

**완료 조건**

- [ ] 0.15를 동결하고 치명 수정만 한다.
- [ ] 같은 입력→같은 출력 동등성 매트릭스에서 차이 0이다.
- [ ] pytest 자산이 TS 테스트로 옮겨지고 차이 0 뒤 Python 테스트가 제거된다.
- [ ] `python3 scripts/pes.py` 호출이 0이다.
- [ ] 설치·업그레이드가 Windows/Mac에서 통과한다.
- [ ] legacy importer가 옛 데이터 형식만 읽고 Python을 실행하지 않는다.
- [ ] 설계 검사 계약이 TS 검사기로 옮겨진다.
- [ ] 외부 도구의 Python 요구는 경계로 표시한다.

**선행**: PR1·4·13·14·15·16·17·18·21

**라벨 후보**: `stage-2`, `type:impl`, `area:language`, `area:migration`, `승인 후 ai-ready`

**마일스톤 후보**: M7 언어 이전·출시

+++ Agent notes
- 파일: `scripts/pes.py`, `scripts/serve.py`, `install.sh`, `install.ps1`, `skills/`, `commands/`, `agents/`, `docs/plan/schemas/check_ddl.py`
- 함수: 기존 CLI·설치·bootstrap(`pes:setup`) 이전, 동등성 매트릭스(질문 화면·보고서·`project.json` 처리·CLI 출력)
- 시험: 0.15 pytest 자산을 옮긴 TS 테스트 + PR1~22의 TS 테스트
- 주의: **PR26에서 새 Python 코드·테스트를 만들지 않는다.** `check_ddl.py`는 PR26 전까지 한시 실행하고, PR26이 설계 검사 계약을 TS 검사기·실행 명령·기존 합성 사례 동등성으로 옮긴다. 이후 필수 검사는 그 TS 산출물을 쓴다.
+++

---

## 해결됨(2026-11-05)

기존 계획서·이슈 원고의 불일치 9개를 아래와 같이 정리했다. 10번은 검수 보고서 쪽 시점 차이였고, 현행 원고는 이미 61표다.

1. **공통 테스트 기반** — `issues/stage-2.md`와 이 원고 PR1에 **PR1에서 정할 TS fixture 헬퍼: `isolated_home`·`cli`·`synthetic_project` 대응**을 명시했다. Python `tests/conftest.py`는 PR26 이전 대상이다.
2. **SEL-18·19 선행** — `stage-2.md`와 이 원고를 **PR19=SEL-18, PR20a·b·c=SEL-19, PR21·22=SEL-18·19**로 통일했다.
3. **HTTP 표** — `stage-2.md` 4.2.1을 **HTTP 노출(PR13) / 코어 명령(PR5·6)** 두 칸으로 바꾸고, 이 원고 PR13 notes에도 같은 구분을 적었다.
4. **capabilities** — **PR13이 라우트를 열고 PR14가 완성 시험**을 맡는 것으로 `stage-2.md`, `issues/stage-2.md`, 이 원고 PR13·14에 통일했다.
5. **답 제출 경로** — 기존 0.15 동작에 맞춰 **`POST /<slug>/feedback`(로컬 서버 기준)**으로 통일하고, 새 API 답 제출은 별도 표기로 남겼다.
6. **나열 순서** — `stage-2.md`, `issues/stage-2.md`, 이 원고에 **나열 순서 ≠ 실행 순서(PR26 → PR22)** 한 줄을 넣었다.
7. **PR14/PR20a 역할** — **PR14=project-registrations API, PR20a=빈 계정 최초 등록 종단 시험**으로 나눴다.
8. **PR3** — **PR3는 export/import 골격 자체 시험**, 전체 복원 검증만 PR12로 넘긴다고 명시했다.
9. **PR2** — Node LTS·wrangler 고정은 **D1 개발 도구 한정**, 로컬 런타임은 **0016 시험 뒤**로 명시했다.
10. **61표** — 현행 `stage-2.md`·`issues/stage-2.md`는 **61표(현재 001 기준)**로 이미 맞다. 검수 보고서의 60표 지적은 옛 시점을 가리킨다.
