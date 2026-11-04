# 3단계 구현 이슈 초안

- 입력: [stage-3.md](../stage-3.md)(검수 반영본), [stage-1-db.md](../stage-1-db.md), [stage-1-api.md](../stage-1-api.md), [stage-1-ui.md](../stage-1-ui.md), [stage-1-runners.md](../stage-1-runners.md), [DDL 초안](../schemas/stage-1-ddl-draft.sql)
- 원칙: **이슈 하나 = PR 하나.** 9개(U1~U6, W1, R1, T1). Linear에는 아직 만들지 않는다.
- 공통 전제: 2단계 22개 PR과 0단계 게이트가 끝난 뒤. 새 표를 만들지 않고 기존 54개 표·읽기 모델·계산을 쓴다. 실제 `~/pes-projects`·`~/.pes`는 읽지 않고 합성 fixture만 쓴다.
- 공통 파일 경계(2단계에서 만든 모듈 이름을 따른다): `scripts/pes.py`(CLI·명령 서비스 진입), `scripts/serve.py`(로컬 HTTP·API 라우트), `templates/workspace/`(서버 렌더 HTML), `static/workspace/`(ES 모듈 섬), `tests/test_stage3_*.py`, `tests/e2e/test_stage3_*.py`, `tests/fixtures/stage3/`.
- 공통 테스트: `python -m pytest -q tests/test_stage3_<id>.py tests/e2e/test_stage3_<id>.py`. Playwright가 없는 환경은 CI에서 설치하며, 브라우저가 없으면 실패한다(건너뛰지 않음).

---

## U1 [3단계] 작업 공간 틀·URL·갱신·기존 화면 병행

**목표**: 질문 폼 페이지가 아닌 프로젝트 작업 공간 하나의 셸·URL·갱신·초안·기존 화면 연결을 만든다.

**할 일**
- [ ] `scripts/serve.py`에 `/p/<slug>/e/<edition>/s/<stage>/r/<round>` GET 라우트와 `view`·`focus`·`peek`·`print` 쿼리 처리를 추가한다. 기존 `project_of`, `_json`, `do_GET`의 프로젝트 경계를 재사용한다.
- [ ] `scripts/serve.py`에 `GET /api/v1/projects/{id}/workspace`, `GET /api/v1/projects/{id}/changes?cursor=`, `GET /api/v1/projects/{id}/objects/{o}/versions/{v}` 읽기 경로를 연결한다. 새 SQL은 읽기 모델 함수 하나로 모은다.
- [ ] 읽기 모델에 `projects`·`editions`·`stages`·`rounds`·`objects`·`object_versions`·`events`·`runs`·`run_input_receipts`·`db_meta`를 연결하고, 권한별 가능 동작/비활성 이유를 계산한다.
- [ ] `templates/workspace/shell.html`, `nav.html`, `context.html`을 만들고 3/2/1영역·고정 헤더·단계/라운드·과거/현재 구분·`round_id=NULL` 단계 시작 표시를 구현한다.
- [ ] `static/workspace/shell.js`에 URL 복원·뒤로/앞으로·딥링크·peek 열기/닫기, `static/workspace/cursor.js`에 tx 묶음 커서 갱신(활성 약 3초, 비활성·오류 시 늦춤)을 구현한다.
- [ ] `static/workspace/draft.js`에 sessionStorage 초안 키(`project/user/edition/form/question_version`)·메모리 fallback·확정 성공 뒤 해당 초안 삭제·새 버전 무검토 제출 금지를 구현한다.
- [ ] `static/workspace/command-menu.js`에 동작 목록 하나(메뉴·맥락 메뉴·단축키 공유), 명시적 AI 모드 버튼, Tab은 IME 조합 밖 보조, 검색 결과 없음→AI 자동 전송 금지를 구현한다.
- [ ] Go 칩·전송 스위치를 `templates/workspace/context.html`에 두고 `project_policy_versions`·`outbound_dispatches` 읽기와 정책 누락/손상 차단 표시를 연결한다.
- [ ] 기존 `ask-<id>.html`을 당시 `question_sets`/버전으로 작업 공간에 연결하고, 내보낸 고정 HTML은 보존한다. 기존 대시보드·ask는 같은 DB/API로 병행한다.
- [ ] OpenCode form/permission을 `실행` 패널에 `실행 권한`으로 구분 표시한다.
- [ ] 이전된 합성 프로젝트가 가정·결정·의견이 없을 때 `기록 없음`으로 보이게 한다.

**선행 이슈**: 2단계 PR 14·18, 2단계 사용자 승인, U1 착수 전 합성 자료 정적 시안(답→결과→첨언→후속) 검토.

**완료 기준**
- [ ] 1366·1440·200% 확대에서 3/2/1영역이 깨지지 않는다.
- [ ] 새로고침·뒤로/앞으로·딥링크가 같은 화면·같은 초점을 복원한다.
- [ ] 입력 중 갱신이 초안·초점·IME를 지우지 않고, 커서 무효·타임아웃에도 초안이 남는다.
- [ ] 기존 대시보드·ask 링크·인쇄·`pes watch` 답 알림이 계속 동작한다.
- [ ] 키보드만으로 단계·라운드·질문·명령 메뉴에 닿고, Tab 덫·초점 상실이 없다.
- [ ] 새 표를 추가하지 않았고 브라우저가 DB를 직접 읽지 않는다.
- [ ] `python -m pytest -q tests/test_stage3_u1.py tests/e2e/test_stage3_u1.py`
- [ ] `python -m pytest -q tests/e2e/test_stage3_u1.py -k "keyboard or ime or deep_link"` (Playwright, Windows CI 필수)

**지킬 것**
- 기존 화면을 3단계에 없애지 않는다. 기본 진입 전환은 4단계다.
- 3/2/1영역·peek·명령 메뉴는 새 디자인이 아니라 기존 화면 동등성 위의 셸이다.
- 승인·reopen·정책 변경은 화면에서도 서버 권한 검사를 통과해야 한다.
- 실제 자료·실키·기관 자료를 fixture·로그·스크린샷에 넣지 않는다.

---

## U2 [3단계] 질문 작업면

**목표**: 질문을 고치고 더하고 빼고, 중요도·기본값·재확인을 다루며, 묶음 답 제출과 질문별 의견을 한 화면에서 처리한다.

**할 일**
- [ ] `templates/workspace/questions.html`과 `static/workspace/questions.js`에 질문 카드·필터(전체/높음/재확인/내가 AI에게)·`3/12 ↑↓`·`J/K` 이동을 구현한다.
- [ ] `static/workspace/question-editor.js`에 인라인 고치기(문장·유형·선택지·중요도·필수·기본값·`show_if`·도움말·방향)와 저장 전 `재확인 필요` 경고를 구현한다.
- [ ] `scripts/serve.py`에 `POST P/questions`, `P/questions/{q}/revisions`, `P/questions/{q}/withdraw|defer|merge`, `POST P/submissions`, `P/threads`·`P/threads/{t}/messages` 라우트를 연결한다.
- [ ] 명령 서비스에 `question_add`, `question_revise`, `question_withdraw`, `question_defer`, `question_merge`, `answer_submit`, `question_comment_add`를 추가한다. 질문 추가와 첫 버전은 한 트랜잭션이다.
- [ ] `question_sets`·`question_set_members`로 폼 버전을 만들고, 추가·제외·순서 변경마다 새 세트를 발행한다.
- [ ] `questions`·`question_versions`의 `importance`·`required`를 독립으로 표시·수정한다. 기본값은 `default_value`를 로컬 초안에만 넣고 `used_default`는 제출 때 기록한다.
- [ ] `submissions`·`answers`·`answer_versions`로 묶음 제출을 원자 검증한다. `allow_comment_as_answer` 허용/불허 두 사례와 `__other` 의견만 있는 응답을 시험한다.
- [ ] `threads`·`messages`·`message_versions`로 질문별 의견 최소 경로를 만들고 U4가 재사용하게 한다.
- [ ] 이전된 합성 프로젝트(중요도 없음·`legacy_unverified` 승인·`__other` 스레드·가정/결정 없음)가 깨지지 않게 한다.
- [ ] A·B 합성 라운드에서 에이전트가 질문을 게시하고 답을 읽는 경로(API 명령·B MCP·A 세션 도구·PR17 스킬)를 확인한다.

**선행 이슈**: U1, 2단계 PR 8·14.

**완료 기준**
- [ ] 질문을 고치면 새 버전·`재확인 필요`·옛 답 보존. 옛 답을 자동 승계하지 않는다.
- [ ] 기본값 채택은 초안에만 들어가고 제출 전에는 답이 아니다.
- [ ] 묶음 제출은 당시 폼/질문 버전으로 필수·조건부·의견 응답을 검증하고 충돌 시 부분 접수하지 않는다.
- [ ] 개별 제출은 다른 필수 질문 완료를 주장하지 않는다.
- [ ] `allow_comment_as_answer` 허용/불허, 새 문구 확인 뒤 재답변, 중요도/필수 독립 사례 2개가 통과한다.
- [ ] 질문별 의견과 답이 섞이지 않고, 추가·제외·순서가 새 폼 버전을 만든다.
- [ ] `python -m pytest -q tests/test_stage3_u2.py tests/e2e/test_stage3_u2.py`
- [ ] `python -m pytest -q tests/test_stage3_u2.py -k "batch or recheck or comment_as_answer or importance"`

**지킬 것**
- 질문 삭제는 hard delete가 아니라 철회/보류/합치기다.
- 답·의견·기본값·추천을 같은 것으로 표시하지 않는다.
- `project.json`·DB 직접 쓰기 없이 명령 서비스만 쓴다.
- U2가 만드는 thread/message 최소 경로를 U4가 재사용하며, 별도 저장소를 만들지 않는다.

---

## U3 [3단계] 가정·결정·반영

**목표**: AI가 깔고 있는 가정을 사람이 판단하고, 살아 있는 결정과 다음 라운드 반영 내역을 증거와 함께 보여 준다.

**할 일**
- [ ] `templates/workspace/assumptions.html`·`decisions.html`·`reflection.html`, `static/workspace/assumptions.js`·`decisions.js`·`reflection.js`를 만든다.
- [ ] `scripts/serve.py`에 `POST P/assumptions`, `P/decisions`, `P/reflections`와 읽기 경로를 연결한다.
- [ ] 명령 서비스에 `assumption_assess`(확인/틀림/고침), `decision_adopt`·`decision_supersede`·`decision_revoke`, `reflection_create`를 추가한다.
- [ ] `assumptions`·`assumption_versions`의 `state(proposed/confirmed/rejected/revised)`·`assessment_actor_id`·`assessed_at`·`needs_review`·`rationale`를 표시·검증한다. 고침은 새 버전이며 원문을 덮어쓰지 않는다.
- [ ] `decisions`·`decision_versions`의 `scope(project/edition)`·`state`·`decided_by`·`supersedes`를 표시하고, 프로젝트/판 범위를 구분한다.
- [ ] `reflection_entries`의 `disposition(applied/partial/rejected/deferred)`·`rationale`·`result_version_id`·`followup_id`·`applied_tx_id`를 표시하고, `applied/partial`은 tx+결과/후속 의미 증거가 없으면 성공 표시하지 않는다.
- [ ] `followups`·`followup_versions`와 연결해 반영 결과가 글 수정·다음 라운드 할 일·reopen 제안으로 이어지게 한다.
- [ ] 반영 내역을 다음 라운드 첫머리에 요약 막대+표로 두고 `미제출`과 `0건`을 구분한다.
- [ ] 이전된 합성 프로젝트에 가정·결정이 없으면 `기록 없음`으로 표시한다.
- [ ] A·B 합성 라운드에서 에이전트가 가정 제안·반영 내역을 실제로 만드는 경로를 확인한다.

**선행 이슈**: U1, 2단계 PR 14. 통합 완료 게이트는 U2·U4.

**완료 기준**
- [ ] AI 제안과 사람 확인/채택/고침이 구분되고, 고침은 `revised`+판단자+근거를 남긴다.
- [ ] `needs_review`가 새 판으로 복사돼도 자동 확인되지 않는다.
- [ ] 결정 대체가 과거를 덮어쓰지 않고 `supersedes`로 이어진다.
- [ ] `applied/partial`은 tx+결과/후속 의미 증거가 없으면 성공 표시하지 않고, 서비스가 결과·후속·tx 일치를 검증한다.
- [ ] 반영 내역이 다음 라운드 첫머리에 보이고, 미제출과 0건이 다르게 보인다.
- [ ] `python -m pytest -q tests/test_stage3_u3.py tests/e2e/test_stage3_u3.py`
- [ ] `python -m pytest -q tests/test_stage3_u3.py -k "assumption or decision or reflection or applied"`

**지킬 것**
- 가정과 결정을 합치지 않는다. 가정이 틀렸다와 결정을 바꿨다는 다르다.
- `applied`를 FK 존재나 `proposed` 상태만으로 통과시키지 않는다.
- 사람 확인·채택 없이 AI가 확정하지 않는다.
- 새 표를 만들지 않고 `assumptions`·`decisions`·`reflection_entries`를 쓴다.

---

## U4 [3단계] 첨언·후속

**목표**: 결과 글의 선택 구간에 첨언하고, 앵커 상태를 숨기지 않으며, 대화 결과를 글 수정·다음 라운드 할 일·reopen으로 잇는다.

**할 일**
- [ ] `templates/workspace/result.html`에 읽기 전용 결과 글·버전 선택기·본문·표·각주를 렌더한다.
- [ ] `static/workspace/selection-toolbar.js`에 `첨언 / AI에게 묻기 / 할 일로` 선택 도구와 `Alt+M` 키보드 입구를 구현한다.
- [ ] `static/workspace/annotations.js`·`anchor.js`에 인용문·prefix/suffix·start/end·`text_format_version` 저장, code point ↔ JS UTF-16/DOM 변환, 표·한글·이모지·반복 인용 시험을 구현한다.
- [ ] `scripts/serve.py`에 `POST P/threads`, `P/threads/{t}/messages`, `P/threads/{t}/resolutions`, `P/followups/{f}/apply` 라우트를 연결한다.
- [ ] 명령 서비스에 `annotation_create`, `annotation_reanchor`, `thread_message_add`, `thread_resolve`, `followup_create`, `followup_apply`, `edit_text_propose`를 추가한다.
- [ ] `threads`·`thread_versions`·`messages`·`message_versions`로 스레드·답글·결론 메시지·요약을 저장한다. `thread_versions`에 anchor 열이 있다고 가정하지 않는다.
- [ ] `anchors`·`anchor_resolutions`로 `exact/moved/ambiguous/lost`를 표시하고, ambiguous 후보 자동 선택·lost 삭제를 금지하며, 다시 붙이기는 새 판정으로 남긴다.
- [ ] `followups`·`followup_versions`로 `edit_text`·`next_round_task`·`reopen_stage`·`none`을 저장하고, `edit_text`는 기반 버전 대조 뒤 새 `artifact_versions`로 채택한다. 기반 충돌 시 실패하고 원문·제안을 보존한다.
- [ ] `해결됨`과 `반영됨`을 분리하고, reopen 적용은 사람만 하게 한다.
- [ ] 이전된 합성 프로젝트의 `__other` 스레드를 보존한다.
- [ ] A·B 합성 라운드에서 에이전트가 스레드 답글·`edit_text` 제안을 실제로 만드는 경로를 확인한다.

**선행 이슈**: U1·U2, 2단계 PR 4·6·7·9·14.

**완료 기준**
- [ ] 선택 도구가 글 선택에만 뜨고, 키보드만으로 열 수 있다.
- [ ] `exact/moved/ambiguous/lost`가 숨지 않고, ambiguous 후보 자동 선택·lost 삭제가 없다.
- [ ] 원래 앵커가 불변이고, 다시 붙이기가 새 `anchor_resolutions` 행으로 남는다.
- [ ] `edit_text` 제안이 기반 버전 대조를 거쳐 새 버전으로 채택되고 원문을 덮어쓰지 않는다.
- [ ] 기반 충돌 시 채택이 실패하고 원문·제안이 보존된다.
- [ ] 해결 결과 4종이 저장되고 `해결됨`과 `반영됨`이 분리된다.
- [ ] `python -m pytest -q tests/test_stage3_u4.py tests/e2e/test_stage3_u4.py`
- [ ] `python -m pytest -q tests/test_stage3_u4.py -k "anchor or ambiguous or lost or edit_text or resolution"`

**지킬 것**
- 결과 글을 직접 덮어쓰지 않는다. 직접 편집·제안 모드는 4단계다.
- `lost`는 첨언 삭제가 아니다. 인용문·스레드를 보존한다.
- `thread_versions`에 없는 anchor 열을 가정하지 않는다.
- reopen 적용은 사람만 하고, 에이전트 토큰으로 우회하지 않는다.

---

## U5 [3단계] 프롬프트 복사·B 대기

**목표**: 방식 B에서 사람→AI 질문을 접수하고 상태를 조회하며, 포함 범위를 미리 보여 주는 프롬프트 복사를 제공한다. A는 명시적 run으로 둔다.

**할 일**
- [ ] `templates/workspace/prompt.html`, `static/workspace/prompt.js`, `static/workspace/context-actions.js`를 만든다.
- [ ] `scripts/serve.py`에 `POST P/questions`, `POST P/runs`, `POST P/claims`, `GET P/runs/{r}/inputs`, `POST P/runs/{r}/input-receipts` 라우트를 연결한다.
- [ ] `questions`·`question_versions`·`submissions`·`answers`·`runs`·`run_input_receipts`·`events`·`outbound_dispatches`를 프롬프트/대기 읽기 모델에 연결한다.
- [ ] 명령 서비스에 `human_question_create`, `run_start`, `input_receipt`, `prompt_build`를 추가한다. `prompt_build`는 서버 상태를 쓰지 않는 조립 함수다.
- [ ] B MCP `pes_ask`·`pes_wait`와 A 세션 도구가 같은 질문/답/대기 명령을 쓰게 한다.
- [ ] 프롬프트에 선택 범위·정확한 버전·관련 가정/결정·제약·복귀 링크를 넣고, 미제출 초안은 `미제출 초안`, 로컬 경로·토큰·비밀은 제외한다.
- [ ] 접수/외부 수신/답 수신/읽음을 구분하고 경과 시간을 표시한다. 복사만으로 run/`waiting_human`을 만들지 않는다.
- [ ] A의 `AI에게 묻기`는 `POST P/runs`+claim으로 시작하고, 복사 성공과 실행 성공을 같은 상태로 표시하지 않는다.
- [ ] 클립보드 실패 시 직접 선택 대안을 제공하고, 서버 답 초안 API를 만들지 않는다.
- [ ] B Code와 Claude 앱 양쪽 경로를 확인하고, 사람 붙여넣기는 actor=human, 도구/모델 주장은 미검증 출처로 기록한다.

**선행 이슈**: U1·U2·U4, 2단계 PR 5·13·19·20.

**완료 기준**
- [ ] 복사는 B의 수동 전달 통로이며 Code MCP·앱 직접 연결을 대체하지 않는다.
- [ ] B에서 복사만으로 run/`waiting_human`을 만들지 않는다.
- [ ] 접수·수신·답 수신·읽음이 구분되고 경과 시간이 표시된다.
- [ ] A의 실행과 복사가 같은 성공으로 표시되지 않는다.
- [ ] 미제출 초안 표시, 포함/제외/경고 미리보기, 클립보드 실패 대안이 동작한다.
- [ ] 서버 답 초안 API가 없고, 로컬 경로·토큰·비밀이 프롬프트에 들어가지 않는다.
- [ ] `python -m pytest -q tests/test_stage3_u5.py tests/e2e/test_stage3_u5.py`
- [ ] `python -m pytest -q tests/test_stage3_u5.py -k "prompt or copy or waiting or actor"`

**지킬 것**
- "복사됨"은 접수·수신·실행·반영이 아니다.
- B에서 "AI 답변 중" 애니메이션·가짜 답변을 만들지 않는다.
- Claude 앱의 지속 연결·heartbeat를 가정하지 않는다.
- 연구 내용을 Linear·외부로 자동 전송하지 않는다.

---

## U6 [3단계] 범위 인쇄

**목표**: 라운드/단계/현재 판을 골라, 버전이 고정된 인쇄물을 만들고 같은 manifest로 다시 출력한다.

**할 일**
- [ ] `templates/workspace/print.html`(또는 `templates/print/workspace.html`)과 `static/workspace/print.js`를 만든다.
- [ ] `scripts/serve.py`에 `GET P/print?scope=round|stage|edition&snapshot=`과 읽기 모델을 연결한다.
- [ ] `scripts/pes.py`의 `cmd_report`·`cmd_assemble`·`cmd_web`가 쓰는 보고서 경계를 재사용하고, 인쇄용 HTML은 PR9의 버전·blob 경계를 지킨다.
- [ ] `snapshots`·`blobs`·`round_contents`·`artifact_versions`·`artifact_components`로 봉인·승인본 또는 출력 시점 고정 manifest를 만든다.
- [ ] 열린 라운드는 저장 버전·사건 경계·manifest를 고정하되 **라운드를 봉인하지 않는다**. 미제출 초안·토큰 스트림은 제외한다.
- [ ] 기본은 현재 라운드/현재 단계/현재 판 6단계, `모든 판`은 고급 옵션+분량 확인으로 둔다. DDL에 없는 프로젝트 전체 scope를 가정하지 않는다.
- [ ] `templates/print.css`에 A4·표 머리 반복·흑백 대비·각주·`lost` 첨언 상태·페이지 나눔 금지를 넣는다.
- [ ] 같은 manifest 재출력이 같은 내용이 되게 하고, 출력물 보존 위치를 기록한다.

**선행 이슈**: U1~U4, 2단계 PR 9·16. U5는 필수 선행이 아니다.

**완료 기준**
- [ ] 봉인·승인본은 그 스냅숏을 쓰고, 열린 라운드는 출력 시점 고정이며 봉인되지 않는다.
- [ ] 미제출 초안·토큰 스트림이 빠지고, `lost` 첨언 상태가 인쇄에서 숨지 않는다.
- [ ] 모든 판은 고급 옵션+분량 확인을 거치고, 프로젝트 전체 scope를 가정하지 않는다.
- [ ] A4·표 머리 반복·흑백·각주가 Windows Chrome/Edge에서 읽힌다.
- [ ] 같은 manifest 재출력이 같은 내용이다.
- [ ] `python -m pytest -q tests/test_stage3_u6.py tests/e2e/test_stage3_u6.py`
- [ ] `python -m pytest -q tests/test_stage3_u6.py -k "snapshot or manifest or print or lost"`

**지킬 것**
- 인쇄 때문에 라운드를 봉인하지 않는다.
- 같은 manifest 없이 "같은 출력"이라고 주장하지 않는다.
- 실제 프로젝트 인쇄물·캡처를 저장소에 넣지 않는다.
- U5 프롬프트 복사와 인쇄를 같은 기능으로 합치지 않는다.

---

## W1 [3단계] WebMCP 실험

**목표**: 브라우저 에이전트에게 읽기·답 초안·첨언/답글만 노출하고, 승인류·제출류가 서버에서 거부됨을 증명한다.

**할 일**
- [ ] `static/workspace/webmcp.js` 한 파일에 `document.modelContext.registerTool` 래퍼를 모은다. `'modelContext' in document` 감지, 없으면 등록하지 않음.
- [ ] 도구 `pes.list_open_questions`, `pes.get_round_summary`, `pes.get_thread`, `pes.draft_answer`(브라우저 폼만), `pes.add_comment`, `pes.add_reply`를 등록한다.
- [ ] `scripts/serve.py`의 읽기·`POST P/threads`·`P/threads/{t}/messages` 경로를 브라우저 에이전트 자격으로 호출하게 한다.
- [ ] `actors.kind=browser_agent`·제한된 `agent_tokens` 범위를 쓰고, `on_behalf_of_user_id`를 사람 직접 작성·승인 증거로 쓰지 않는다.
- [ ] `actors`·`agent_tokens`·`threads`·`messages`·`objects`·`mutation_commits`·`events`를 browser_agent 경로에 연결한다.
- [ ] `readOnlyHint`·`untrustedContentHint`·`consequentialHint`를 붙이고 `toolautosubmit`을 쓰지 않는다.
- [ ] 답 제출·해결·claim/submit/complete·내보내기·승인·reopen·판 시작·정책·삭제 도구를 등록하지 않고, 제한 자격으로 직접 호출해도 서버가 거부하는지 시험한다.
- [ ] 미지원 capabilities에 가짜 성공을 넣지 않고, 플래그로 전체 도구를 끌 수 있게 한다.
- [ ] `discover_webmcp_tools` 결과와 실제 Chrome/Edge 수동 호출·권한 검증을 따로 기록한다. 지원 현황은 조사 당시 기록임을 남긴다.
- [ ] 불안정하면 3단계 종료 시 제거할 수 있게 등록 해제 경로를 둔다.

**선행 이슈**: U1·U2·U4, 2단계 PR 10·14. API 결정 16의 허용 목록 중 3단계 범위만.

**완료 기준**
- [ ] 등록 도구가 읽기·초안·첨언/답글 밖 상태를 바꾸지 못한다.
- [ ] 금지 API를 제한 자격으로 직접 호출해도 서버가 거부한다.
- [ ] `on_behalf_of_user_id`가 사람 승인 증거로 쓰이지 않는다.
- [ ] 도구 없음/있음 모두 조용히 동작하고, 플래그로 철회할 수 있다.
- [ ] `discover_webmcp_tools`와 Chrome/Edge 수동 시험 결과가 남는다.
- [ ] `python -m pytest -q tests/test_stage3_w1.py`
- [ ] 수동: Chrome/Edge에서 도구 목록·읽기·초안·첨언/답글·금지 호출 거부를 확인한다.

**지킬 것**
- 승인·reopen·판 시작·정책·삭제·제출·해결은 절대 노출하지 않는다.
- 브라우저 에이전트의 작업을 사람의 직접 작성·승인으로 표시하지 않는다.
- WebMCP는 PES API의 얇은 층이며 별도 로직·별도 저장소를 만들지 않는다.
- origin trial 불안정성을 이유로 기본 경로로 만들지 않는다.

---

## R1 [3단계] 자동 재개 옵션

**목표**: 기본 수동 재개를 유지하면서, 프로젝트별 opt-in과 서버 준비 검사를 통과한 경우에만 자동 예약·실행한다.

**할 일**
- [ ] `templates/workspace/run.html`, `static/workspace/resume.js`에 `준비됨/차단 이유`·opt-in·경과·중복 방지 상태를 표시한다.
- [ ] `scripts/serve.py`에 자동 재개 조회·켜기/끄기와 `POST P/runs/{r}/claims`·`GET P/runs/{r}/inputs`·`POST P/runs/{r}/input-receipts` 연결을 추가한다.
- [ ] `scripts/pes.py` 또는 새 `scripts/resume.py`에 `auto_resume_ready`, `auto_resume_schedule`, `auto_resume_cancel`을 추가한다. 준비 검사 자체는 2단계 PR 8/14의 것을 재사용한다.
- [ ] opt-in 저장 위치를 정한다. `editions.settings_json`의 `auto_resume` 키를 우선 쓰고, 프로젝트 공통이 필요하면 새 표가 아니라 PR4 마이그레이션으로 `projects` 열을 추가한다.
- [ ] `runs`·`project_leases`·`run_input_receipts`·`project_policy_versions`로 현재 질문/폼·조건부 필수·의견 응답·미루기·run 상태·Go 정책·기한/한도·새 claim을 검사한다.
- [ ] `실행 form 응답·질문 없는 후속`에는 연구 답 제출을 요구하지 않는다. 연속 제출·동시 클릭은 중복 예약하지 않는다.
- [ ] Go OFF→재허용만으로 자동 재개하지 않고, 재허용 뒤 첫 시작·재개는 사람이 명시하게 한다.
- [ ] 자동 재개도 새 claim/fence를 쓰고 이전 lease를 부활시키지 않는다. 자동 인계는 추가하지 않는다.
- [ ] 재시작 뒤 opt-in·중복 방지 상태를 보존하고, 모든 자동 재개를 `mutation_commits`·`events`에 남긴다.
- [ ] A/B 실제 재개 경로(PR 19·20)와 같은 계약을 쓰는지 확인한다.

**선행 이슈**: U1·U2, 2단계 PR 5·8·10·14·19·20. RUN C4.

**완료 기준**
- [ ] opt-in 기본 꺼짐, 수동 흐름이 그대로 동작한다.
- [ ] 준비 검사는 2단계 몫이며 수동 재개에도 필요함을 확인한다.
- [ ] Go OFF→재허용만으로 자동 재개하지 않는다.
- [ ] 유효 제출만으로 자동 재개하지 않고 현재 질문/폼·조건부·의견·미루기·run·정책·기한/한도·새 claim을 검사한다.
- [ ] 실행 form 응답·질문 없는 후속에 연구 답 제출을 요구하지 않는다.
- [ ] 연속 제출·동시 클릭이 중복 예약하지 않고, 재시작 뒤 opt-in·중복 방지가 보존된다.
- [ ] 자동 재개도 새 claim/fence, 자동 인계 없음, 사건·영수증 기록.
- [ ] `python -m pytest -q tests/test_stage3_r1.py`
- [ ] `python -m pytest -q tests/test_stage3_r1.py -k "auto_resume or go_off or duplicate or restart"`

**지킬 것**
- 자동 재개를 기본값으로 두지 않는다.
- 준비 검사를 R1에서 새로 만들지 않는다. 2단계 계약을 재사용한다.
- 미상 비용을 무료로 표시하거나 unknown 예약을 자동 해제하지 않는다.
- 자동 인계·자동 승인·자동 정책 변경을 추가하지 않는다.

---

## T1 [3단계] 실제 프로젝트 시험·문서

**목표**: 합성 통과 뒤 사용자 허용 1개를 분리된 시험 홈/DB에서 끝까지 왕복하고, 결과·결함·복원을 문서로 남긴다.

**할 일**
- [ ] `docs/plan/runbooks/stage-3-real-project.md`에 시험 절차·중단 기준·복원 절차·공개 범위를 쓴다.
- [ ] `tests/fixtures/stage3/t1/`에 공개 가능한 합성 재현 자료를 두고, 실제 사본·export/import·백업·인쇄물·캡처는 저장소 밖에 둔다.
- [ ] `scripts/pes.py`의 PR3 export/import와 PR12 쓰기 전/후 복구를 재사용해 분리 시험 홈/DB를 만든다.
- [ ] `import_batches`·`legacy_mappings`·`snapshots`·`blobs`·`mutation_commits`·`events`·`db_meta`를 시험·복원 확인에 쓴다.
- [ ] PR22 파일럿 프로젝트를 재사용할지 다른 프로젝트를 쓸지 정하고, PR22 runbook·백업을 재사용한다.
- [ ] B(Claude Code)를 먼저 시험한다. Go 반출이 없어 로컬 복구가 쉽다는 범위에서만 그렇고, B도 연구 내용을 외부로 보낼 수 있으며 이미 보낸 정보는 DB 복원으로 회수되지 않음을 기록한다.
- [ ] 시험 왕복: 작업 공간 열기 → 질문 고치기/더하기 → 묶음 답 → 수동 재개 → 결과 글 → 첨언 → AI에게 묻기(B 접수/복사) → 할 일로 → 반영 내역 → 인쇄 → 기존 대시보드/ask 링크 → 단계 승인/다시 열기(사본) → 재접속.
- [ ] 중단 기준: 자료 손실, 답 중복·유실, 잘못된 승인, 조용한 오부착·원문 인용/스레드 유실(정상 `lost`는 실패 아님), 인쇄 불일치, 접근성 차단.
- [ ] 차단 결함은 복구 후 수정·동일 시나리오 재시험 전 종료하지 않는다. 비차단 결함만 이월하고, 수정 규모가 크면 단일 목적 결함 PR로 분리한다.
- [ ] 공개 PR·fixture·스크린샷·로그에는 실제 본문·기관 자료·키를 넣지 않고, 공개 재현은 합성 자료로 한다. PR에는 익명 요약만 남긴다.
- [ ] 사용 안내(작업 공간·기존 화면 병행·프롬프트 복사·인쇄·복원 손실 범위)를 갱신한다.

**선행 이슈**: U1~U6. W1·R1은 사용자가 켠 경우만 조건부 선행.

**완료 기준**
- [ ] 자료 손실 0, 답 중복·유실 0, 잘못된 승인 0, 조용한 오부착·원문 인용/스레드 유실 0, 인쇄 불일치 0.
- [ ] 복원 시험 성공, 사용자 확인, 차단 결함 수정·재시험 완료, 비차단 결함 목록·이월.
- [ ] 실제 사본·캡처가 저장소 밖에 있고, 공개 PR·fixture에 실제 자료·키가 없다.
- [ ] PR22 파일럿 재사용 여부·runbook·백업이 명시되고, 사용 안내가 갱신됐다.
- [ ] `python -m pytest -q tests/test_stage3_t1.py`
- [ ] 수동: `docs/plan/runbooks/stage-3-real-project.md` 체크리스트를 사용자 입회로 완료한다.

**지킬 것**
- 실제 원본을 바로 쓰지 않는다. 분리 시험 홈/DB·사본·전체 백업을 먼저 둔다.
- 실제 자료를 공개 저장소·CI·로그·스크린샷에 넣지 않는다.
- T1에서 모든 결함을 고친다고 약속하지 않는다. 차단 결함만 종료 조건으로 둔다.
- 정상 `lost` 판정을 결함으로 오인하지 않는다.

---

## 이슈 수

**9개**: U1, U2, U3, U4, U5, U6, W1, R1, T1. U4를 U4a/U4b로 나누면 10개, U1 템플릿 공유 시험을 앞 PR로 떼면 10~11개가 될 수 있다. 이 초안은 9개를 기본으로 한다.
