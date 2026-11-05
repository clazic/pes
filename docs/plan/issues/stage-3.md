# 3단계 구현 이슈 초안

- 입력: [stage-3.md](../stage-3.md)(검수 반영본), [stage-1-db.md](../stage-1-db.md), [stage-1-api.md](../stage-1-api.md), [stage-1-ui.md](../stage-1-ui.md), [stage-1-runners.md](../stage-1-runners.md), [DDL 초안](../schemas/stage-1-ddl-draft.sql)
- 원칙: **이슈 하나 = PR 하나.** 11개(U1~U6, REF1, MAT1, W1, R1, T1). Linear에는 아직 만들지 않는다.
- 공통 전제: **2단계 25개 PR**(기존 22개 중 PR20을 20a·20b·20c로 분할하고 PR26 언어 이전을 더함, 결정 0012·0014·0016)과 0단계 게이트가 끝난 뒤. **REF1은 `project_references`, MAT1은 `file_policies.id`·`version_files.file_policy_id`·`file_ai_access_versions.file_policy_id`·`file_extractions.source_file_policy_id`/`text_file_policy_id`를 사용**하고, 그 밖에는 기존 표·읽기 모델·계산을 쓴다. 실제 `~/pes-projects`·`~/.pes`는 읽지 않고 합성 fixture만 쓴다.
- 공통 파일 경계: **새 3단계 모듈은 TS(`src/cli/*.ts`·`src/server/*.ts`·`src/web/*.ts`)로 둔다.** 기존 0.15의 `scripts/pes.py`·`serve.py`는 PR26 이전 대상이며 새 기능을 배정하지 않는다. `templates/workspace/`·`static/workspace/`·`tests/stage3/*.test.ts`·`tests/e2e/stage3_*.spec.ts`·`tests/fixtures/stage3/`는 3단계에서 새로 만든다.
- 공통 테스트: **TS 테스트 러너·실행 명령은 런타임 시험 뒤 확정**한다. `docs/plan/schemas/check_ddl.py`는 **설계 검사기로 PR26 전까지 한시 보존**하며 제품 테스트가 아니다. 아래 `결정 뒤 확정할 TS 테스트 명령`은 대상 계약을 가리키며, Windows/macOS CI에서 같은 계약을 실행한다. `-k`는 선택 필터 표시다. Playwright는 `tests/e2e/*.spec.ts`로 실행하고, 브라우저가 없으면 실패한다(건너뛰지 않음).
- 공통 완료 조건: 각 이슈에 접근성(대비·초점·키보드·200% 확대)·보안(권한·비밀·Markdown/외부 인용 렌더)·A/B 같은 상태→같은 문구 검증을 포함한다. **U2~U5·R1은 Codex CLI·OpenCode TUI·Codex 앱·OpenCode 앱의 최소 왕복·재개·상태 표시를 완료 조건에 포함하고, Claude Code 6단계 시험과 구분한다.**
- B 어댑터 공통: U2~U5·R1의 MCP/스킬 확장과 상태 표시는 **여섯 어댑터(Claude Code·Claude 앱·Codex CLI·OpenCode TUI·Codex 앱·OpenCode 앱)** 에 같은 계약으로 적용한다. `PR 20`은 20a·20b·20c의 집합 약칭이며, Claude Code의 PES 6단계 시험과 다른 어댑터의 **최소 왕복·재개** 검증 범위를 구분한다.

---

## U1 [3단계] 작업 공간 틀·URL·갱신·기존 화면 병행

**목표**: 질문 폼 페이지가 아닌 프로젝트 작업 공간 하나의 셸·URL·갱신·초안·기존 화면 연결을 만든다.

**할 일**
- [ ] `src/server/serve.ts`에 `/p/<slug>/e/<edition>/s/<stage>/r/<round>` GET 라우트와 `view`·`focus`·`peek`·`print` 쿼리 처리를 추가한다. 기존 `project_of`, `_json`, `do_GET`의 프로젝트 경계를 재사용한다.
- [ ] `src/server/serve.ts`에 `GET /api/v1/projects/{id}/workspace`, `GET /api/v1/projects/{id}/changes?cursor=`, `GET /api/v1/projects/{id}/objects/{o}/versions/{v}` 읽기 경로를 연결한다. 새 SQL은 읽기 모델 함수 하나로 모은다.
- [ ] 읽기 모델에 `projects`·`editions`·`stages`·`rounds`·`objects`·`object_versions`·`events`·`runs`·`run_input_receipts`·`db_meta`를 연결하고, 권한별 가능 동작/비활성 이유를 계산한다.
- [ ] `templates/workspace/shell.html`, `nav.html`, `context.html`을 만들고 3/2/1영역·고정 헤더·단계/라운드·과거/현재 구분·`round_id=NULL` 단계 시작 표시를 구현한다.
- [ ] `static/workspace/shell.js`에 URL 복원·뒤로/앞으로·딥링크·peek 열기/닫기, `static/workspace/cursor.js`에 tx 묶음 커서 갱신(활성 약 3초, 비활성·오류 시 늦춤)을 구현한다.
- [ ] `static/workspace/draft.js`에 sessionStorage 초안 키(`project/user/edition/form/question_version`)·메모리 fallback·확정 성공 뒤 해당 초안 삭제·새 버전 무검토 제출 금지를 구현한다.
- [ ] `static/workspace/command-menu.js`에 동작 목록 하나(메뉴·맥락 메뉴·단축키 공유), 명시적 AI 모드 버튼, Tab은 IME 조합 밖 보조, 검색 결과 없음→AI 자동 전송 금지를 구현한다.
- [ ] Go 칩·전송 스위치를 `templates/workspace/context.html`에 두고 `project_policy_versions`·`outbound_dispatches` 읽기와 정책 누락·손상 `차단 중`, 확정 전 `변경 중`, in-flight 취소 시도/unknown, 이미 나간 자료 회수 보장 없음, 재허용 뒤 자동 재시작 없음을 표시한다. B 화면도 같은 문구를 쓴다.
- [ ] 과거 승인과 stale을 함께 표시하고, 중단/취소/인계를 서로 다른 상태로 표시한다.
- [ ] 기존 `ask-<id>.html`을 당시 `question_sets`/버전으로 작업 공간에 연결하고, 내보낸 고정 HTML은 보존한다. 기존 대시보드·ask는 같은 DB/API로 병행한다.
- [ ] 외부 앱의 질문/권한을 `실행` 패널에 `실행 권한`으로 구분 표시한다.
- [ ] 모바일은 읽기·답·의견 응답·오류 확인·인쇄 미리보기·복사 대안만 허용하고, 데스크톱 편집·첨언 작성과 구분한다.
- [ ] 템플릿 공유 시험(상한 약 1주)을 수행한다. 실패하면 JSON+얇은 클라이언트 렌더로 후퇴하되 HTML은 포크하지 않는다. (분리하면 별도 PR)
- [ ] 명령 메뉴/AI 전환과 함께 미리보기·순서 넘김의 틀을 만든다.
- [ ] `GET P/workspace`는 1단계 API 6절에 아직 없으므로 U1에서 API 계약에 등록하고, 2단계 PR13/14의 읽기 계약과 충돌하지 않게 한다.
- [ ] 이전된 합성 프로젝트가 가정·결정·의견이 없을 때 `기록 없음`으로 보이게 한다.

**선행 이슈**: 2단계 PR 14·18, 2단계 사용자 승인, U1 착수 전 합성 자료 정적 시안(답→결과→첨언→후속) 검토.

**완료 기준**
- [ ] 1366·1440·200% 확대에서 3/2/1영역이 깨지지 않는다.
- [ ] 새로고침·뒤로/앞으로·딥링크가 같은 화면·같은 초점을 복원한다.
- [ ] 입력 중 갱신이 초안·초점·IME를 지우지 않고, 커서 무효·타임아웃에도 초안이 남는다.
- [ ] 기존 대시보드·ask 링크·인쇄·`pes watch` 답 알림이 계속 동작한다.
- [ ] 키보드만으로 단계·라운드·질문·명령 메뉴에 닿고, Tab 덫·초점 상실이 없다.
- [ ] 모바일에서 읽기·답·의견 응답·오류 확인·인쇄 미리보기·복사 대안이 동작하고, 데스크톱 편집·첨언 작성은 제한된다.
- [ ] Go 칩이 `켜짐/차단 중/변경 중/unknown`을 구분하고, 과거 승인·stale·중단/취소/인계가 같은 화면에서 구분된다.
- [ ] 템플릿 공유 시험 결과(성공/후퇴)가 기록되고, 후퇴 시 첫 표시·딥링크·인쇄를 재대조한다.
- [ ] 미리보기·순서 넘김이 열린 질문·과거 라운드에서 같은 화면 상태를 유지한다.
- [ ] 새 표를 추가하지 않았고 브라우저가 DB를 직접 읽지 않는다.
- [ ] `결정 뒤 확정할 TS 테스트 명령 tests/stage3/u1.test.ts tests/e2e/stage3_u1.spec.ts`
- [ ] `결정 뒤 확정할 TS 테스트 명령 tests/e2e/stage3_u1.spec.ts -k "keyboard or ime or deep_link"` (Playwright, Windows CI 필수)

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
- [ ] `src/server/serve.ts`에 `POST P/questions`, `P/questions/{q}/revisions`, `P/questions/{q}/withdraw|defer|merge`, `POST P/submissions`, `P/threads`·`P/threads/{t}/messages` 라우트를 연결한다. `withdraw|defer|merge`는 1단계 API 6절에 없으므로 U2에서 API 계약에 등록하고, 상태 값(`withdrawn`/`deferred`/`merged`)과 함께 검증한다.
- [ ] 명령 서비스에 `question_add`, `question_revise`, `question_withdraw`, `question_defer`, `question_merge`, `answer_submit`, `question_comment_add`를 추가한다. 질문 추가와 첫 버전은 한 트랜잭션이다.
- [ ] `question_sets`·`question_set_members`로 폼 버전을 만들고, 추가·제외·순서 변경마다 새 세트를 발행한다.
- [ ] `question_versions`의 `importance`·`required`를 독립으로 표시·수정한다(질문 객체는 `questions`). 기본값·추천을 미리 답으로 채우지 않는다. 기본값은 `default_value`를 로컬 초안에만 넣고, `answer_versions.used_default`는 제출 때 기록한다.
- [ ] `submissions`·`answers`·`answer_versions`로 묶음 제출을 원자 검증한다. `allow_comment_as_answer` 허용/불허 두 사례와 `__other` 의견만 있는 응답을 시험한다.
- [ ] 개별 답 제출 경로를 만들되, 다른 필수 질문이 끝났다고 주장하지 않게 한다.
- [ ] `threads`·`messages`·`message_versions`로 질문별 의견 최소 경로를 만들고 U4가 재사용하게 한다.
- [ ] 이전된 합성 프로젝트(중요도 없음·`legacy_unverified` 승인·`__other` 스레드·가정/결정 없음)가 깨지지 않게 한다.
- [ ] A·B 합성 라운드에서 에이전트가 질문을 게시하고 답을 읽는 경로(API 명령·B MCP·A 내장 실행기 도구·PR17 스킬)를 확인한다.

**선행 이슈**: U1, 2단계 PR 8·14.

**완료 기준**
- [ ] 질문을 고치면 새 버전·`재확인 필요`·옛 답 보존. 옛 답을 자동 승계하지 않는다.
- [ ] 기본값 채택은 초안에만 들어가고 제출 전에는 답이 아니다.
- [ ] 묶음 제출은 당시 폼/질문 버전으로 필수·조건부·의견 응답을 검증하고 충돌 시 부분 접수하지 않는다.
- [ ] 개별 제출은 다른 필수 질문 완료를 주장하지 않는다.
- [ ] `allow_comment_as_answer` 허용/불허, 새 문구 확인 뒤 재답변, 중요도/필수 독립 사례 2개가 통과한다.
- [ ] 질문별 의견과 답이 섞이지 않고, 추가·제외·순서가 새 폼 버전을 만든다.
- [ ] `결정 뒤 확정할 TS 테스트 명령 tests/stage3/u2.test.ts tests/e2e/stage3_u2.spec.ts`
- [ ] `결정 뒤 확정할 TS 테스트 명령 tests/stage3/u2.test.ts -k "batch or recheck or comment_as_answer or importance"`

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
- [ ] `src/server/serve.ts`에 `POST P/assumptions`, `P/decisions`, `P/reflections`와 읽기 경로를 연결한다.
- [ ] 명령 서비스에 `assumption_assess`(확인/틀림/고침), `decision_adopt`·`decision_supersede`·`decision_revoke`, `reflection_create`를 추가한다.
- [ ] `assumption_versions`의 `state(proposed/confirmed/rejected/revised)`·`assessment_actor_id`·`assessed_at`·`needs_review`·`rationale`를 표시·검증한다(`assumptions`는 객체 정체성·제안자). 고침은 새 버전이며 원문을 덮어쓰지 않는다.
- [ ] `decisions.scope(project/edition)`와 `decision_versions.state`·`decided_by`·`supersedes_decision_id`를 표시하고, 프로젝트/판 범위를 구분한다.
- [ ] `reflection_entries`의 `disposition(applied/partial/rejected/deferred)`·`rationale`·`result_version_id`·`followup_id`·`applied_tx_id`를 표시하고, `applied/partial`은 tx+결과/후속 의미 증거가 없으면 성공 표시하지 않는다.
- [ ] 가정·결정·반영 표에 버전·판단자·범위·근거 링크를 붙인다.
- [ ] `followups`·`followup_versions`와 연결해 반영 결과가 글 수정·다음 라운드 할 일·reopen 제안으로 이어지게 한다.
- [ ] 반영 내역을 다음 라운드 첫머리에 요약 막대+표로 두고 `미제출`과 `0건`을 구분한다.
- [ ] 이전된 합성 프로젝트에 가정·결정이 없으면 `기록 없음`으로 표시한다.
- [ ] A·B 합성 라운드에서 에이전트가 가정 제안·결정 제안·반영 내역을 실제로 만드는 경로를 확인한다. **A 도구 allowlist: `context.get`·`result.submit`·`question.ask`(공통)+`assumption.propose`·`decision.propose`·`reflection.write`(U3); B MCP/CLI는 같은 명령. `decision.propose`는 제안만이고 사람 채택과 구분. 파일·셸·임의 네트워크 도구 없음.**

**선행 이슈**: U1, 2단계 PR 14. 통합 완료 게이트는 U2·U4.

**완료 기준**
- [ ] AI 제안과 사람 확인/채택/고침이 구분되고, 고침은 `revised`+판단자+근거를 남긴다.
- [ ] `needs_review`가 새 판으로 복사돼도 자동 확인되지 않는다.
- [ ] 결정 대체가 과거를 덮어쓰지 않고 `supersedes_decision_id`로 이어진다.
- [ ] `applied/partial`은 tx+결과/후속 의미 증거가 없으면 성공 표시하지 않고, 서비스가 결과·후속·tx 일치를 검증한다.
- [ ] 반영 내역이 다음 라운드 첫머리에 보이고, 미제출과 0건이 다르게 보인다.
- [ ] 표에서 버전·판단자·범위·근거 링크로 원문·출처에 닿는다.
- [ ] `결정 뒤 확정할 TS 테스트 명령 tests/stage3/u3.test.ts tests/e2e/stage3_u3.spec.ts`
- [ ] `결정 뒤 확정할 TS 테스트 명령 tests/stage3/u3.test.ts -k "assumption or decision or reflection or applied"`

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
- [ ] `static/workspace/annotations.js`·`anchor.js`에 인용문·prefix/suffix·`start_cp`/`end_cp`·`text_format_version` 저장, code point ↔ JS UTF-16/DOM 변환, 표·한글·이모지·반복 인용 시험을 구현한다.
- [ ] `src/server/serve.ts`에 `POST P/threads`, `P/threads/{t}/messages`, `P/threads/{t}/resolutions`, `P/followups/{f}/apply` 라우트를 연결한다.
- [ ] 명령 서비스에 `annotation_create`, `annotation_reanchor`, `thread_message_add`, `thread_resolve`, `followup_create`, `followup_apply`, `edit_text_propose`를 추가한다.
- [ ] `threads`·`thread_versions`·`messages`·`message_versions`로 스레드·답글·결론 메시지·요약을 저장한다. `thread_versions`에 anchor 열이 있다고 가정하지 않는다.
- [ ] `anchors`·`anchor_resolutions`로 `exact/moved/ambiguous/lost`를 표시하고, ambiguous 후보 자동 선택·lost 삭제를 금지하며, 다시 붙이기는 새 판정으로 남긴다.
- [ ] `followup_versions`의 `kind`(edit_text/next_round_task/reopen_stage/none)와 `state`를 저장하고(`followups`는 원 스레드·원 버전 계보), `edit_text`는 기반 버전 대조 뒤 새 `artifact_versions`로 채택한다. 기반 충돌 시 실패하고 원문·제안을 보존한다.
- [ ] `해결됨`과 `반영됨`을 분리하고, reopen 적용은 사람만 하게 한다.
- [ ] 이전된 합성 프로젝트의 `__other` 스레드를 보존한다.
- [ ] A·B 합성 라운드에서 에이전트가 스레드 답글·`edit_text` 제안을 실제로 만드는 경로를 확인한다. **A 도구 allowlist: `context.get`·`result.submit`·`question.ask`(공통)+`thread.reply`·`followup.propose`(U4); B MCP/CLI는 같은 명령. 파일·셸·임의 네트워크 도구 없음.**

**선행 이슈**: U1·U2, 2단계 PR 4·6·7·9·14.

**완료 기준**
- [ ] 선택 도구가 글 선택에만 뜨고, 키보드만으로 열 수 있다.
- [ ] `exact/moved/ambiguous/lost`가 숨지 않고, ambiguous 후보 자동 선택·lost 삭제가 없다.
- [ ] 원래 앵커가 불변이고, 다시 붙이기가 새 `anchor_resolutions` 행으로 남는다.
- [ ] `edit_text` 제안이 기반 버전 대조를 거쳐 새 버전으로 채택되고 원문을 덮어쓰지 않는다.
- [ ] 기반 충돌 시 채택이 실패하고 원문·제안이 보존된다.
- [ ] 해결 결과 4종이 저장되고 `해결됨`과 `반영됨`이 분리된다.
- [ ] `결정 뒤 확정할 TS 테스트 명령 tests/stage3/u4.test.ts tests/e2e/stage3_u4.spec.ts`
- [ ] `결정 뒤 확정할 TS 테스트 명령 tests/stage3/u4.test.ts -k "anchor or ambiguous or lost or edit_text or resolution"`

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
- [ ] `src/server/serve.ts`에 `POST P/questions`, `GET P/runs/{r}/inputs`, `POST P/runs/{r}/input-receipts`를 연결한다. **`POST P/runs`·`POST P/claims`는 2단계 PR13/14의 기존 경로를 재사용하고 U5에서 새로 만들지 않는다.**
- [ ] `questions`·`question_versions`·`submissions`·`answers`·`runs`·`run_input_receipts`·`events`·`outbound_dispatches`를 프롬프트/대기 읽기 모델에 연결한다.
- [ ] 명령 서비스에 `human_question_create`, `input_receipt`, `prompt_build`를 추가한다. **`run_start`는 2단계 PR13/14 계약을 재사용한다.** `prompt_build`는 서버 상태를 쓰지 않는 조립 함수다.
- [ ] B MCP `pes_ask`·`pes_wait`와 A 내장 실행기 도구가 같은 질문/답/대기 명령을 쓰게 한다.
- [ ] 프롬프트에 선택 범위·정확한 버전·관련 가정/결정·제약·복귀 링크를 넣고, 포함·제외·경고 미리보기 UI를 `prompt.html`에 만든다. 미제출 초안은 `미제출 초안`, 로컬 경로·토큰·비밀은 제외한다.
- [ ] 접수/외부 수신/답 수신/읽음을 구분하고 경과 시간을 표시한다. 복사만으로 run/`waiting_human`을 만들지 않는다.
- [ ] A의 `AI에게 묻기`는 기존 `POST P/runs`+claim 경로로 시작하고, 복사 성공과 실행 성공을 같은 상태로 표시하지 않는다.
- [ ] 클립보드 실패 시 직접 선택 대안을 제공하고, 서버 답 초안 API를 만들지 않는다.
- [ ] B 여섯 어댑터(Claude Code·Claude 앱·Codex CLI·OpenCode TUI·Codex 앱·OpenCode 앱)의 공통 MCP/스킬 확장을 확인하고, 사람 붙여넣기는 actor=human, 도구/모델 주장은 미검증 출처로 기록한다. Claude Code 6단계와 다른 어댑터의 최소 왕복·재개 범위를 구분한다.

**선행 이슈**: U1·U2·U4, 2단계 PR 5·13·19·20(20a·20b·20c 집합 약칭).

**완료 기준**
- [ ] 복사는 B의 수동 전달 통로이며 Code MCP·앱 직접 연결을 대체하지 않는다.
- [ ] B에서 복사만으로 run/`waiting_human`을 만들지 않는다.
- [ ] 접수·수신·답 수신·읽음이 구분되고 경과 시간이 표시된다.
- [ ] A의 실행과 복사가 같은 성공으로 표시되지 않는다.
- [ ] 미제출 초안 표시, 포함/제외/경고 미리보기, 클립보드 실패 대안이 동작한다.
- [ ] 서버 답 초안 API가 없고, 로컬 경로·토큰·비밀이 프롬프트에 들어가지 않는다.
- [ ] `run_start`·`claim`은 2단계 PR13/14 경로를 재사용하고, U5가 같은 기능의 두 번째 경로를 만들지 않는다.
- [ ] Claude Code·Claude 앱·Codex CLI·OpenCode TUI·Codex 앱·OpenCode 앱의 최소 왕복·재개·actor 기록이 같은 계약으로 확인된다(Claude Code만 6단계 전체).
- [ ] `결정 뒤 확정할 TS 테스트 명령 tests/stage3/u5.test.ts tests/e2e/stage3_u5.spec.ts`
- [ ] `결정 뒤 확정할 TS 테스트 명령 tests/stage3/u5.test.ts -k "prompt or copy or waiting or actor"`

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
- [ ] `src/server/serve.ts`에 `GET P/print?scope=round|stage|edition&snapshot=`과 읽기 모델을 연결한다. **GET은 이미 저장된 고정본만 읽는 순수 조회**이며, 새 고정본·출력물 blob을 만들지 않는다. 이 경로는 1단계 API 6절에 없으므로 페이지 라우트로 둘지 API 계약에 등록할지 U6에서 명시한다.
- [ ] `src/cli/pes.ts`의 `cmd_report`·`cmd_assemble`·`cmd_web`가 쓰는 보고서 경계를 재사용하고, 인쇄용 HTML은 PR9의 버전·blob 경계를 지킨다.
- [ ] `snapshots`·`blobs`·`round_contents`·`artifact_versions`·`artifact_components`로 봉인·승인본 또는 출력 시점 고정 manifest를 만든다.
- [ ] **출력 시점 고정본 생성은 `print_prepare`/`print_commit`(또는 기존 PR9 저장 명령)으로 분리한다.** 프로젝트 읽기 권한을 가진 사람이 실행하고, 에이전트는 별도 허가가 있을 때만 허용한다. 멱등 키·사건/영수증·실패 시 전체 롤백을 지키고, 이후 GET 재열람은 저장된 고정본을 읽는다.
- [ ] 열린 라운드는 저장 버전·사건 경계·manifest를 고정하되 **라운드를 봉인하지 않는다**. 미제출 초안·토큰 스트림은 제외한다.
- [ ] 기본은 현재 라운드/현재 단계/현재 판 6단계, `모든 판`은 고급 옵션+분량 확인으로 둔다. DDL에 없는 프로젝트 전체 scope를 가정하지 않는다.
- [ ] 포함 항목(본문·표·각주·첨언·가정·결정·반영)을 고르는 UI와 manifest 목록을 만들고, 제외 항목을 manifest에 남긴다.
- [ ] 새 `templates/print.css`(기존 `templates/*.html`의 `@media print` 규칙을 공통화)에 A4·표 머리 반복·흑백 대비·각주·`lost` 첨언 상태·페이지 나눔 금지를 넣는다.
- [ ] 같은 manifest 재출력이 같은 내용이 되게 하고, 출력물 보존 위치를 기록한다.

**선행 이슈**: U1~U4, 2단계 PR 9·16. U5는 필수 선행이 아니다.

**완료 기준**
- [ ] 봉인·승인본은 그 스냅숏을 쓰고, 열린 라운드는 출력 시점 고정이며 봉인되지 않는다.
- [ ] `GET P/print`만으로 새 snapshot·출력물 blob이 생기지 않고, `print_commit`의 권한·멱등·사건/영수증·실패 롤백이 시험된다.
- [ ] 미제출 초안·토큰 스트림이 빠지고, `lost` 첨언 상태가 인쇄에서 숨지 않는다.
- [ ] 모든 판은 고급 옵션+분량 확인을 거치고, 프로젝트 전체 scope를 가정하지 않는다.
- [ ] 포함/제외 항목이 manifest에 기록되고, 같은 manifest 재출력에 그대로 쓰인다.
- [ ] A4·표 머리 반복·흑백·각주가 Windows Chrome/Edge에서 읽힌다.
- [ ] 같은 manifest 재출력이 같은 내용이다.
- [ ] `결정 뒤 확정할 TS 테스트 명령 tests/stage3/u6.test.ts tests/e2e/stage3_u6.spec.ts`
- [ ] `결정 뒤 확정할 TS 테스트 명령 tests/stage3/u6.test.ts -k "snapshot or manifest or print or lost or commit"`

**지킬 것**
- 인쇄 때문에 라운드를 봉인하지 않는다.
- 같은 manifest 없이 "같은 출력"이라고 주장하지 않는다.
- 실제 프로젝트 인쇄물·캡처를 저장소에 넣지 않는다.
- U5 프롬프트 복사와 인쇄를 같은 기능으로 합치지 않는다.

---

## REF1 [3단계] 이전 프로젝트 참고자료

- **목표**: 새 프로젝트를 만들 때 또는 만든 뒤 언제든, 사람이 이전 프로젝트(하나 이상)를 **특정 버전에 고정한 읽기 전용 참고자료**로 붙이고, A·B가 같은 의미로 활용한다.
- **할 일**:
  - [ ] 1단계 DDL 기준의 `project_references`(참조 프로젝트·`referenced_project_id?`·`referenced_project_key`·`source_snapshot_id?`·`source_snapshot_key`·`source_label`·`latest_snapshot_id?`·`scope_json`·`status`(source_missing 포함)·붙인 사람/시각·rev)를 사용한다. 원본 스냅숏 FK, 자기 참조 금지. 3단계에서 인덱스가 필요하면 새 마이그레이션으로 추가하고, **현재 61표 기준**과 일치시킨다.
  - [ ] 원본 스냅숏 삭제는 **FK 자동 SET NULL에 기대지 않는다.** 검증 명령의 **같은 tx**에서 `source_snapshot_id`·`latest_snapshot_id`를 **명시적으로 비우고** `status='source_missing'`·`source_snapshot_key`·`source_label`을 보존한다. 참조 행과 안정 key는 남기고, 독립 스냅숏 삭제·원본 없음 회귀를 시험한다.
  - [ ] **A만 이전/복원할 때 원본 프로젝트를 묵시적으로 export하지 않는다.** 참조 원본 미포함 상태를 표시하고, 원본 없음·권한 회수·A만 복원을 PR3/12·REF1·WEB9/10 시험에 연결한다.
  - [ ] `reference_attach`·`reference_detach`·`reference_refresh` 명령·API·영수증·사건. 붙임 항목은 최종 보고서/단계 보고서, 출처 목록, 결정 기록, 질문·답, 첨부 파일; 기본은 최종 보고서+출처.
  - [ ] 프로젝트 생성 화면과 작업 중 설정 화면에서 이전 프로젝트·버전·항목을 고르는 UI. "새 버전 있음"·"원본 없음"·"권한 없음" 표시.
  - [ ] 권한: **두 프로젝트 모두 접근 권한이 있는 사람만** 붙임. 참조 대상 권한이 없는 사람에게 내용 비노출.
  - [ ] 전송: 원본 프로젝트가 Go OFF이면 그 참고자료를 A 호출에 넣지 않는다(**엄격한 쪽 우선**). B 목적지에도 원본 허용 범위를 표시하고, 허용되지 않은 목적지로 보내지 않는다.
  - [ ] 맥락 조립: 참고자료 목록·요약을 넣고 본문은 필요할 때 읽기 도구로. 결과물 인용에 참조 프로젝트·버전 표시.
  - [ ] `/pes:start --import`·PR11 legacy importer(이전·옮기기)와 구분하고, 참조는 복사·이전이 아님을 문서화.
  - [ ] `tests/stage3/ref1.test.ts`·`tests/fixtures/stage3/references/`.
- **선행 이슈**: U1, PR 1·4·7·13·14.
- **완료 기준**:
  - [ ] `결정 뒤 확정할 TS 테스트 명령 tests/stage3/ref1.test.ts` 통과.
  - [ ] 붙임·떼기·갱신의 권한·멱등·tx/사건·영수증, 원본 버전 고정, 새 버전 고지·사람 갱신, 원본 삭제 뒤 **`source_missing` tombstone**과 "원본 없음" 표시.
  - [ ] 두 프로젝트 권한 없는 사용자에게 내용 비노출, Go OFF 원본 참고자료가 A 호출에 0건.
  - [ ] **A만 이전/복원할 때 참조 원본 미포함 표시**, 묵시적 export 0건, 권한 회수·원본 없음 회귀.
  - [ ] 결과물 인용의 프로젝트·버전 표시, 웹·로컬 같은 API, 이전·import와 혼동 없음.
- **지킬 것**: 원본을 수정·복사하지 않는다. 참조 때문에 원본 프로젝트 상태를 바꾸지 않는다. 권한 없는 내용을 요약·로그·오류에 넣지 않는다.

## MAT1 [3단계] 내 자료 올리기·글자 추출·AI 참조 스위치

- **목표**: hwp/hwpx/pdf/xlsx/xls/pptx/ppt/docx/doc/txt/md/csv 등을 올리고, AI가 읽을 글자·표를 추출하며, 파일마다 AI 참조 허용/금지를 실제로 지킨다.
- **할 일**:
  - [ ] `file_policies.id`(blob 단위 안정 ID)를 사용하고, `version_files.file_policy_id`·`file_ai_access_versions.file_policy_id`·`file_extractions.source_file_policy_id`/`text_file_policy_id`를 연결한다. 원본 blob hash·크기·형식·버전 기록.
  - [ ] `file_upload`·`file_extract`·`file_preview`·`file_ai_access_set` 명령·API·영수증·사건. 올리기는 프로젝트 생성 화면과 작업 중 자료 목록 양쪽.
  - [ ] 브라우저/로컬 추출 기본: txt/md/csv 그대로, docx/pptx/xlsx/hwpx XML, pdf 텍스트층. **hwp/doc/ppt/xls는 시험 후 결정**과 안내. OCR은 나중 선택.
  - [ ] 추출 텍스트·표를 별도 버전으로 저장하고, 사람이 미리보기로 확인. `partial`/`failed`/`unsupported` 경고를 숨기지 않는다.
  - [ ] 파일별 `allow`/`deny` 스위치 기본 **allow**, 소유자만 변경·불변 이력. 올리는 화면과 목록에서 즉시 변경.
  - [ ] 정책은 `(version_id, blob_id, role)`별로 따로 두지 않고 **`file_policies.id`**를 기준으로 한다. `version_files.file_policy_id`·`file_ai_access_versions.file_policy_id`는 같은 blob 정책을 가리키고, `file_extractions.source_file_policy_id`(원본 blob)와 `text_file_policy_id`(추출 텍스트 blob)는 **각자 정책**을 가진다. 서비스가 원본 deny를 함께 검사해 **엄격한 쪽(deny) 우선**을 적용한다. 같은 blob(hash)의 재첨부는 같은 정책, 다른 blob인 추출본은 원본 정책을 자동 상속하지 않는다. owner만 재허용, 정책 없는 이력·blob 불일치·중복 정책은 FK/유일성으로 거부한다.
  - [ ] **deny 파일을 A Go 맥락·PES API/MCP/WebMCP 도구 응답에서 제외**하는 필터를 모든 읽기 경로에 넣는다. 사람 화면 열람·직접 인용은 허용. **B의 PC 동기화 폴더·로컬 파일 직접 읽기는 MCP 필터 밖이므로, 사람 보관 영역/AI workspace·도우미 자격을 분리하고 파일·셸·업로드 권한 통제 범위를 시험한다.** 통제 불가 도구는 연결 시 제한을 표시하고 “A·B 모두 제외 보장”으로 쓰지 않는다.
  - [ ] Go OFF·참조 원본 파일 OFF는 엄격 우선. 금지 전에 만든 결과물에 표시, 이미 나간 내용은 회수 불가 표시.
  - [ ] 크기·개수 상한, R2/Blob 무료 한도 자기 제한, 결과물 인용에 파일·위치 표시.
  - [ ] `tests/stage3/mat1.test.ts`·`tests/fixtures/stage3/materials/`.
- **선행 이슈**: U1, PR 4·9·10·13·14.
- **완료 기준**:
  - [ ] `결정 뒤 확정할 TS 테스트 명령 tests/stage3/mat1.test.ts` 통과.
  - [ ] 올리기·버전/hash·미리보기·추출 상태·경고, allow/deny 이력·권한, **파일 정책 ID·엄격한 쪽·재첨부/추출본/참조 원본**.
  - [ ] deny 파일이 A 호출과 PES API/MCP/WebMCP 응답에 0건, 사람 화면에서는 열람·인용 가능. **B 여섯 도구의 로컬 직접 읽기·동기화 캐시·파일 OFF 뒤 재접속**을 시험하고, 통제 불가 경로는 “제외 보장”으로 표시하지 않음.
  - [ ] Go OFF·참조 원본 OFF 엄격 우선, 크기·개수·저장 한도, 옛 형식 시험 결과 기록.
- **지킬 것**: 원본을 덮어쓰지 않는다. deny 파일을 요약·로그·오류·프롬프트에 넣지 않는다. hwpx 입력과 hwpx 출력(6단계)을 섞지 않는다.

## W1 [3단계] WebMCP 실험

**목표**: 브라우저 에이전트에게 읽기·답 초안·첨언/답글만 노출하고, 승인류·제출류가 서버에서 거부됨을 증명한다.

**할 일**
- [ ] `static/workspace/webmcp.js` 한 파일에 `document.modelContext.registerTool` 래퍼를 모은다. `'modelContext' in document` 감지, 없으면 등록하지 않음.
- [ ] 도구 `pes.list_open_questions`, `pes.get_round_summary`, `pes.get_thread`, `pes.draft_answer`(브라우저 폼만), `pes.add_comment`, `pes.add_reply`를 등록한다.
- [ ] `src/server/serve.ts`의 읽기·`POST P/threads`·`P/threads/{t}/messages` 경로를 브라우저 에이전트 자격으로 호출하게 한다.
- [ ] `actors.kind=browser_agent`와 제한된 browser_actor 자격을 쓰고(`agent_tokens`를 쓸 경우 1단계 API 16의 browser_actor 자격과 대조해 범위를 확정), `on_behalf_of_user_id`를 사람 직접 작성·승인 증거로 쓰지 않는다.
- [ ] `actors`·(사용 시)`agent_tokens`·`threads`·`messages`·`objects`·`mutation_commits`·`events`를 browser_agent 경로에 연결한다.
- [ ] `readOnlyHint`·`untrustedContentHint`·`consequentialHint`를 붙이고 `toolautosubmit`을 쓰지 않는다.
- [ ] 답 제출·해결·claim/submit/complete·내보내기·승인·reopen·판 시작·정책·삭제 도구를 등록하지 않고, 제한 자격으로 직접 호출해도 서버가 거부하는지 시험한다.
- [ ] 미지원 capabilities에 가짜 성공을 넣지 않고, 플래그로 전체 도구를 끌 수 있게 한다.
- [ ] `discover_webmcp_tools` 결과와 실제 Chrome/Edge 수동 호출·권한 검증을 따로 기록한다. 지원 현황은 조사 당시 기록임을 남긴다.
- [ ] 불안정하면 3단계 종료 시 제거할 수 있게 등록 해제 경로를 둔다.

**선행 이슈**: U1·U2·U4, 2단계 PR 10·14. API 결정 16의 허용 목록 중 3단계 범위만.

**완료 기준**
- [ ] 등록 도구가 읽기·초안·첨언/답글 밖 상태를 바꾸지 못한다.
- [ ] `pes.draft_answer`가 네트워크 제출·서버 초안 저장 없이 브라우저 폼만 바꾼다.
- [ ] 금지 API를 제한 자격으로 직접 호출해도 서버가 거부한다.
- [ ] `on_behalf_of_user_id`가 사람 승인 증거로 쓰이지 않는다.
- [ ] 도구 없음/있음 모두 조용히 동작하고, 플래그로 철회할 수 있다.
- [ ] `discover_webmcp_tools`와 Chrome/Edge 수동 시험 결과가 남는다.
- [ ] `결정 뒤 확정할 TS 테스트 명령 tests/stage3/w1.test.ts`
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
- [ ] `src/server/serve.ts`에 자동 재개 조회·켜기/끄기와 `POST P/claims`·`GET P/runs/{r}/inputs`·`POST P/runs/{r}/input-receipts` 연결을 추가한다.
- [ ] `src/cli/pes.ts` 또는 새 `src/cli/resume.ts`에 `auto_resume_ready`, `auto_resume_schedule`, `auto_resume_cancel`을 추가한다. 준비 검사 자체는 2단계 PR 8/14의 것을 재사용한다.
- [ ] **opt-in 저장은 `project_policy_versions`의 새 열(예: `allow_auto_resume`)과 R1 소유 새 마이그레이션으로 한다.** 소유자만 변경하고 불변 이력·현재 정책 조회·멱등 키를 쓰며, `projects` 설정 열이나 `editions.settings_json` 기본값으로 대체하지 않는다. 기본 꺼짐, 새 판의 적용 규칙, 비소유자 변경 거부, 재시작 뒤 보존을 시험한다. DDL·**PR26이 옮긴 TS 설계 검사기**(0016)·기준 문서 갱신도 R1에 둔다.
- [ ] 현재 정책 조회·변경 명령(`policy_auto_resume_get`/`set` 또는 동등)을 두고, 소유자 step-up·멱등·불변 이력을 검사한다.
- [ ] `runs`·`project_leases`·`run_input_receipts`·`project_policy_versions`·`question_sets`·`questions`·`question_versions`·`answers`·`submissions`로 현재 질문/폼·조건부 필수·의견 응답·미루기·run 상태·Go 정책·기한/한도·새 claim을 검사한다.
- [ ] `실행 form 응답·질문 없는 후속`에는 연구 답 제출을 요구하지 않는다. 연속 제출·동시 클릭은 중복 예약하지 않는다.
- [ ] 자동 재개도 **토큰 추정·한도 오류 문턱(기본 90%)** 과 unknown을 지키고, 추정이 문턱을 넘거나 unknown이면 자동 재개를 시작하지 않는다.
- [ ] Go OFF→재허용만으로 자동 재개하지 않고, 재허용 뒤 첫 시작·재개는 사람이 명시하게 한다.
- [ ] 자동 재개도 새 claim/fence를 쓰고 이전 lease를 부활시키지 않는다. 자동 인계는 추가하지 않는다.
- [ ] 재시작 뒤 opt-in·중복 방지 상태를 보존하고, 모든 자동 재개를 `mutation_commits`·`events`에 남긴다.
- [ ] A/B 실제 재개 경로(PR 19·20a·20b·20c)와 같은 계약을 쓰는지 확인하고, Codex CLI·OpenCode TUI·Codex 앱·OpenCode 앱의 최소 재개 왕복도 포함한다.

**선행 이슈**: U1·U2, 2단계 PR 5·8·10·14·19·20. RUN C4.

**완료 기준**
- [ ] opt-in 기본 꺼짐, 수동 흐름이 그대로 동작한다.
- [ ] opt-in이 `project_policy_versions` 새 열·R1 새 마이그레이션·소유자만 변경·불변 이력으로 저장되고, 새 판 적용·재시작 보존·비소유자 변경 거부·멱등이 통과한다.
- [ ] 준비 검사는 2단계 몫이며 수동 재개에도 필요함을 확인한다.
- [ ] Go OFF→재허용만으로 자동 재개하지 않는다.
- [ ] 유효 제출만으로 자동 재개하지 않고 현재 질문/폼·조건부·의견·미루기·run·정책·기한/한도·새 claim을 검사한다.
- [ ] 실행 form 응답·질문 없는 후속에 연구 답 제출을 요구하지 않는다.
- [ ] 연속 제출·동시 클릭이 중복 예약하지 않고, 재시작 뒤 opt-in·중복 방지가 보존된다.
- [ ] 자동 재개도 새 claim/fence, 자동 인계 없음, 사건·영수증 기록.
- [ ] **토큰 추정·한도 오류 문턱(기본 90%)** 을 넘거나 unknown이면 자동 재개를 시작하지 않고, 예약·unknown을 자동 해제하지 않는다.
- [ ] Codex CLI·OpenCode TUI·Codex 앱·OpenCode 앱의 최소 재개 왕복이 Claude Code·Claude 앱과 같은 계약으로 확인된다.
- [ ] `결정 뒤 확정할 TS 테스트 명령 tests/stage3/r1.test.ts`
- [ ] `결정 뒤 확정할 TS 테스트 명령 tests/stage3/r1.test.ts -k "auto_resume or go_off or duplicate or restart or policy"`

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
- [ ] `src/cli/pes.ts`의 PR3 export/import와 PR12 쓰기 전/후 복구를 재사용해 분리 시험 홈/DB를 만든다.
- [ ] `import_batches`·`legacy_mappings`·`snapshots`·`blobs`·`mutation_commits`·`events`·`db_meta`를 시험·복원 확인에 쓴다.
- [ ] PR22 파일럿 프로젝트를 재사용할지 다른 프로젝트를 쓸지 정하고, PR22 runbook·백업을 재사용한다. **PR22가 실제 자료 허용 기록을 만들었다면 그 기록에 B 목적지를 추가하고, PR22 미실시면 T1에서 프로젝트·자료 범위·목적지·기간·철회를 담은 최초 기록을 만든다.** 로컬 이전 허용·B 외부 전달·A Go 전달을 구분하고, 기간 만료·철회 뒤 사용을 차단한다.
- [ ] B(Claude Code)를 먼저 시험한다. Go 반출이 없어 로컬 복구가 쉽다는 범위에서만 그렇고, B도 연구 내용을 외부로 보낼 수 있으며 이미 보낸 정보는 DB 복원으로 회수되지 않음을 기록한다. **B 전달 허용은 실제 시험할 어댑터(Claude Code·Claude 앱·Codex CLI·OpenCode TUI·Codex 앱·OpenCode 앱)와 목적지에 맞춰 범위를 명시하고, 허용되지 않은 어댑터로 보내지 않는다.**
- [ ] 시험 왕복: 작업 공간 열기 → 질문 고치기/더하기 → 묶음 답 → 수동 재개 → 결과 글 → 첨언 → AI에게 묻기(B 접수/복사) → 할 일로 → 반영 내역 → 인쇄 → 기존 대시보드/ask 링크 → 단계 승인/다시 열기(사본) → 재접속.
- [ ] 중단 기준: 자료 손실, 답 중복·유실, 잘못된 승인, 조용한 오부착·원문 인용/스레드 유실(정상 `lost`는 실패 아님), 인쇄 불일치, 접근성 차단.
- [ ] 차단 결함은 복구 후 수정·동일 시나리오 재시험 전 종료하지 않는다. 비차단 결함만 이월하고, 수정 규모가 크면 단일 목적 결함 PR로 분리한다.
- [ ] 공개 PR·fixture·스크린샷·로그에는 실제 본문·기관 자료·키를 넣지 않고, 공개 재현은 합성 자료로 한다. PR에는 익명 요약만 남긴다.
- [ ] 사용 안내(작업 공간·기존 화면 병행·프롬프트 복사·인쇄·복원 손실 범위)를 갱신한다.

**선행 이슈**: U1~U6·REF1·MAT1. W1·R1은 사용자가 켠 경우만 조건부 선행.

**완료 기준**
- [ ] 자료 손실 0, 답 중복·유실 0, 잘못된 승인 0, 조용한 오부착·원문 인용/스레드 유실 0, 인쇄 불일치 0.
- [ ] 복원 시험 성공, 사용자 확인, 차단 결함 수정·재시험 완료, 비차단 결함 목록·이월.
- [ ] 실제 사본·캡처가 저장소 밖에 있고, 공개 PR·fixture에 실제 자료·키가 없다.
- [ ] PR22 파일럿 재사용 여부·runbook·백업이 명시되고, 실제 자료 허용 기록(프로젝트·범위·목적지·기간·철회)과 사용 안내가 갱신됐다.
- [ ] 사용자 허용이 없으면 T1을 `미실시`로 기록하고, 허용 기록이 없으면 최초 기록을 만들거나 합성 검증으로 남기며, 단계 승인 때 검증 범위를 알린다.
- [ ] `결정 뒤 확정할 TS 테스트 명령 tests/stage3/t1.test.ts`
- [ ] 수동: `docs/plan/runbooks/stage-3-real-project.md` 체크리스트를 사용자 입회로 완료한다.

**지킬 것**
- 실제 원본을 바로 쓰지 않는다. 분리 시험 홈/DB·사본·전체 백업을 먼저 둔다.
- 실제 자료를 공개 저장소·CI·로그·스크린샷에 넣지 않는다.
- T1은 재현/시험 결과·문서 PR이며 코드 수정 PR이 아니다. 결함 수정은 별도 PR로 분리한다.
- T1에서 모든 결함을 고친다고 약속하지 않는다. 차단 결함만 종료 조건으로 둔다.
- 정상 `lost` 판정을 결함으로 오인하지 않는다.

---

## 이슈 수

**11개**: U1, U2, U3, U4, U5, U6, REF1, MAT1, W1, R1, T1. U4를 U4a/U4b로 나누면 12개, U1 템플릿 공유 시험을 앞 PR로 떼면 12~13개가 될 수 있다. 이 초안은 11개를 기본으로 한다.
