# 3단계 구현 이슈 초안 검토

- 대상: `docs/plan/issues/stage-3.md`
- 대조 기준: `docs/plan/stage-3.md`(검수 반영본), `docs/plan/stage-1-db.md`·`stage-1-api.md`·`stage-1-ui.md`·`stage-1-runners.md`, `docs/plan/schemas/stage-1-ddl-draft.sql`, 실제 `scripts/`·`templates/`·`tests/` 구조
- 확인: 계획서 이슈 9개(U1~U6·W1·R1·T1)가 모두 있는가, 이슈 하나=PR 하나인가, 선행·완료 기준(테스트 명령)이 있는가, 파일·표·열 이름이 실제와 맞는가.
- 제약: 실제 `~/pes-projects`·`~/.pes/`는 읽지 않았다. Linear 이슈는 만들지 않았다. `stage-3.md`만 고쳤고 다른 계획서는 고치지 않았다.

## 요약

| 항목 | 결과 |
|---|---|
| 계획서 이슈 | **9/9 있음** — U1~U6, W1, R1, T1 |
| 이슈 하나=PR 하나 | **9개 이슈 = 9개 PR 기본**. U1 템플릿 공유 시험은 U1에 포함하되, 분리 시 별도 PR로 명시 |
| 선행·완료 기준 | **9/9 있음**. 테스트 명령은 공통 1개 + 이슈별 1~2개 |
| 파일·표·API 이름 | 실제와 다른 이름·소유 10건 발견·고침 |
| **문제·고침** | **문제 22, 고침 22** |

## 문제와 고침

| # | 위치 | 문제 | 고칠 방향 | 상태 |
|---|---|---|---|---|
| 1 | U1 할 일·완료 기준 | 계획서 U1 범위의 **템플릿 공유 시험(약 1주)**, **모바일 읽기·답·의견 응답·인쇄 미리보기·복사 대안**, **미리보기·순서 넘김의 틀**이 이슈에 없다. | U1 할 일·완료 기준에 세 항목을 추가하고, 템플릿 공유 시험을 분리하면 별도 PR임을 적는다. | 고침 |
| 2 | U1 `scripts/serve.py` 할 일 | `GET /api/v1/projects/{id}/workspace`는 1단계 API 6절(닫힌 명령 목록)에 없는 경로다. | U1에서 API 계약에 등록하는 변경을 함께 기록하고, 2단계 PR13/14 읽기 계약과 충돌하지 않게 한다. | 고침 |
| 3 | 공통 파일 경계 | `templates/workspace/`·`static/workspace/`를 "2단계에서 만든 모듈 이름"처럼 적었지만, 실제 저장소에 `static/`이 없고 2단계 이슈도 이 디렉터리를 만들지 않는다. | 2단계 경계(`scripts/pes.py`·`scripts/serve.py`)와 3단계에서 새로 만드는 경계(`templates/workspace/`·`static/workspace/`)를 분리해 적는다. | 고침 |
| 4 | U2 할 일 | 계획서 U2 범위의 **개별 답 제출**과 **추천값을 미리 답으로 채우지 않기**가 할 일에 없다(완료 기준에만 개별 제출이 있음). | 개별 제출 태스크를 추가하고, 기본값·추천을 미리 채우지 않는다는 문장을 넣는다. | 고침 |
| 5 | U2 `scripts/serve.py` 할 일 | `P/questions/{q}/withdraw|defer|merge`는 1단계 API 6절에 없는 경로다. | U2에서 API 계약에 등록하고, `withdrawn`/`deferred`/`merged` 상태 값과 함께 검증한다고 명시한다. | 고침 |
| 6 | U2 테이블·열 | `questions`·`question_versions`의 `importance`·`required`처럼 적었지만 두 열은 `question_versions`에만 있다. `used_default`도 `answers`가 아니라 `answer_versions`에만 있다. | `question_versions.importance/required`, `answer_versions.used_default`로 소유를 바로잡는다. | 고침 |
| 7 | U3 테이블·열 | `assumptions`·`assumption_versions`의 `state`·`assessment_actor_id`·`assessed_at`·`needs_review`·`rationale`처럼 적었지만 모두 `assumption_versions`에 있다. `decisions`·`decision_versions`의 `scope`·`state`·`decided_by`·`supersedes`도 소유가 섞였고, 실제 열 이름은 `supersedes_decision_id`다. | `assumption_versions`와 `decisions.scope`/`decision_versions.*`로 나누고, `supersedes`를 `supersedes_decision_id`로 고친다. | 고침 |
| 8 | U4 앵커·후속 | 앵커 열을 `start/end`로 적었지만 DDL은 `start_cp`/`end_cp`다. `followups`·`followup_versions`의 `kind`·`state`도 `followup_versions`에만 있다. | `start_cp`/`end_cp`로 고치고, `kind`·`state`는 `followup_versions`, `followups`는 원 스레드·원 버전 계보로 적는다. | 고침 |
| 9 | U5 할 일 | 완료 기준에는 포함·제외·경고 미리보기가 있지만, 할 일에는 미리보기 UI를 만드는 항목이 없다. | `prompt.html`에 포함·제외·경고 미리보기 UI를 만드는 태스크를 추가한다. | 고침 |
| 10 | U6 API·CSS | `GET P/print`는 1단계 API 6절에 없고, `templates/print.css`도 실제 저장소에 없다(인쇄 CSS는 `templates/*.html`의 `@media print`에 인라인). | `GET P/print`를 페이지 라우트로 둘지 API 계약에 등록할지 명시하고, `templates/print.css`는 기존 인라인 규칙을 공통화한 새 파일로 적는다. | 고침 |
| 11 | W1 브라우저 자격 | `agent_tokens`를 browser_agent 자격으로 단정했지만, 1단계 API 16은 "제한된 browser_actor 자격"만 정하고 `agent_tokens` 사용을 명시하지 않는다. | `agent_tokens`를 쓸 경우 1단계 API 16의 browser_actor 자격과 대조해 범위를 확정한다고 조건부로 적는다. | 고침 |
| 12 | W1 완료 기준 | `pes.draft_answer`가 네트워크 제출·서버 초안 저장 없이 브라우저 폼만 바꾼다는 계획서 조건이 완료 기준에 없다. | 해당 완료 기준을 추가한다. | 고침 |
| 13 | R1 opt-in 저장 | 계획서는 **프로젝트별 opt-in**인데, 초안은 `editions.settings_json`의 `auto_resume`을 우선 쓰라고 한다(판별 설정). | `projects`의 설정 열(PR4 마이그레이션)을 우선 쓰고, `editions.settings_json`은 판별 기본값으로만 쓴다. | 고침 |
| 14 | R1 준비 검사 테이블 | `runs`·`project_leases`·`run_input_receipts`·`project_policy_versions`만으로 "현재 질문/폼·조건부 필수·의견 응답·미루기"를 검사한다고 적었다. 질문·답 테이블이 빠졌다. | `question_sets`·`questions`·`question_versions`·`answers`·`submissions`를 검사 목록에 추가한다. | 고침 |
| 15 | R1 비용 상한 | 계획서 R1 범위의 "감사·비용 상한"이 태스크·완료 기준에 없다. unknown 예약만 언급한다. | 누적 비용 상한과 unknown 예약을 지키고, 상한이 없으면 유료 자동 재개를 하지 않는다는 태스크·완료 기준을 추가한다. | 고침 |
| 16 | T1 완료 기준 | 계획서는 사용자 허용이 없으면 T1을 "미실시"로 기록하고 단계 승인 때 검증 범위를 알린다고 했지만, 초안 완료 기준에 없다. | "미실시" 기록·승인 때 범위 고지 완료 기준을 추가한다. | 고침 |
| 17 | T1 지킬 것 | 계획서는 T1이 **재현/시험 결과·문서 PR이며 코드 수정 PR이 아니다**라고 했지만, 초안은 결함 PR 분리만 말한다. | "T1은 코드 수정 PR이 아니다"를 지킬 것에 명시한다. | 고침 |
| 18 | 공통 테스트 | 모든 명령이 `python -m pytest`라 macOS/Linux에서 `python`이 없으면 실패할 수 있다. 2단계 이슈 초안은 `python3`/`python`을 구분한다. | 공통 테스트에 macOS/Linux `python3`, Windows `python`을 명시한다. | 고침 |
| 19 | 공통 완료 조건 | 계획서 공통의 접근성(대비·초점·키보드·200%)·보안(권한·비밀·Markdown 렌더)·A/B 같은 상태→같은 문구가 이슈별 완료 조건에 일관되게 없다. | 공통 완료 조건 한 줄을 추가해 각 이슈가 같은 기준을 포함하게 한다. | 고침 |
| 20 | U1 상태 표시 | 계획서 U1의 Go 칩 세부 상태(`차단 중`/`변경 중`/in-flight/unknown/회수 없음/재허용 뒤 자동 재시작 없음), 과거 승인·stale 병기, 중단/취소/인계 구분, 모바일 오류 확인이 이슈에 없다. | U1 할 일·완료 기준에 Go 칩 상태, 과거 승인/stale, 중단/취소/인계, 모바일 오류 확인을 추가한다. | 고침 |
| 21 | U3 표시 | 계획서 U3의 "표시(버전·판단자·범위·근거 링크)" 중 버전·근거 링크가 이슈에 없다. | 가정·결정·반영 표에 버전·판단자·범위·근거 링크를 붙이는 태스크·완료 기준을 추가한다. | 고침 |
| 22 | U6 포함 항목 | 계획서 U6의 "포함 항목" 선택이 이슈에 없다. 현재는 scope·manifest만 있고, 본문·표·각주·첨언·가정·결정·반영의 포함/제외 UI가 빠졌다. | 포함 항목 선택 UI·manifest 목록을 만들고, 제외 항목을 manifest에 남기는 태스크·완료 기준을 추가한다. | 고침 |

## 실제로 고친 내용 (`stage-3.md`)

1. 공통 파일 경계를 2단계 경계와 3단계 신규 경계로 나누고, `static/`이 현재 없다는 점을 명시했다.
2. 공통 테스트 명령을 macOS/Linux `python3`, Windows `python`으로 구분하고, 공통 접근성·보안·A/B 완료 조건을 추가했다.
3. U1에 템플릿 공유 시험·모바일 제한·미리보기/순서 넘김 태스크와 완료 기준을 추가하고, `GET P/workspace`의 API 계약 등록을 명시했다.
4. U2에 개별 답 제출 태스크, 추천값 미리 채우기 금지, `withdraw/defer/merge`의 API 계약 등록, `question_versions.importance/required`·`answer_versions.used_default` 소유를 반영했다.
5. U3의 `assumption_versions`·`decisions.scope`·`decision_versions.*` 소유와 `supersedes_decision_id` 열 이름을 바로잡았다.
6. U4의 `start_cp`/`end_cp` 열 이름과 `followup_versions`의 `kind`/`state` 소유를 바로잡았다.
7. U5에 포함·제외·경고 미리보기 UI 태스크를 추가했다.
8. U6의 `GET P/print` API/페이지 라우트 선택과 `templates/print.css` 신규 파일(기존 인라인 `@media print` 공통화)을 명시했다.
9. W1의 browser_actor 자격을 `agent_tokens` 단정 없이 조건부로 적고, `pes.draft_answer`의 네트워크/서버 초안 금지 완료 기준을 추가했다.
10. R1의 opt-in을 `projects` 설정으로 바로잡고, 질문·답 테이블과 비용 상한/unknown 예약을 태스크·완료 기준에 추가했다.
11. T1에 "사용자 허용 없으면 미실시"와 "코드 수정 PR 아님"을 추가했다.
12. U1의 Go 칩 상태(차단 중/변경 중/unknown/회수 없음/재허용 뒤 자동 재시작 없음), 과거 승인·stale 병기, 중단/취소/인계 구분, 모바일 오류 확인을 추가했다.
13. U3의 표시 항목에 버전·판단자·범위·근거 링크를 추가했다.
14. U6에 포함 항목 선택 UI와 manifest 기록·재출력 태스크를 추가했다.

## 문제 없음으로 확인한 것

- 계획서 9개 이슈(U1~U6·W1·R1·T1)가 모두 있다.
- 9개 이슈가 기본 9개 PR로 나뉘어 있고, U1 템플릿 공유 시험·U4a/U4b 분리는 별도 PR로 뺄 수 있게 적혀 있다.
- 9개 이슈 모두 선행 이슈와 완료 기준(테스트 명령 또는 수동 시험)이 있다.
- `scripts/pes.py`의 `cmd_report`·`cmd_assemble`·`cmd_web`, `scripts/serve.py`의 `project_of`·`_json`·`do_GET`은 실제로 있다.
- DDL의 `assumption_versions.assessed_at/needs_review`, `decision_versions.supersedes_decision_id`, `anchors.start_cp/end_cp`, `answer_versions.used_default`, `reflection_entries.*`, `followup_versions.kind/state`는 실제 열과 맞다.
- `tests/e2e/`는 2단계 이슈 초안이 이미 쓰는 경계라 3단계에서 새로 만드는 것으로 맞다.
