# 1단계 ① DB 설계 — OpenCode 의견

- 작성: 2026-11-04, OpenCode (`opencode-go/deepseek-v4.1-flash`)
- Linear: **SEL-21**
- 입력: `docs/plan/00-brief.md`, `docs/plan/stage-0.md`(확정, 3·7·8절), `docs/plan/discussion/stage-0-opencode.md` 4.2절, `docs/plan/research/notion-linear.md`, `docs/plan/research/webmcp.md`
- 확인한 코드: `scripts/pes.py`(load/init/merge/approve/report), `scripts/serve.py`, `templates/_questions.html`, `questions/*.json`, 실제 프로젝트 2개의 구조(내용 아님)
- 범위: **DB·저장 설계 의견**이다. 코드·스키마를 구현하지 않는다. 2단계 구현 이슈를 만들지 않는다.
- 전제: hwpx 변환은 마지막으로 미룬다(`00-brief.md:45`). 0단계에서 API·스키마 세부는 1단계로 넘겼다(`stage-0.md:38-42`).

---

## 0. 한 장 요약

1. **현재값 표와 이력 표를 분리한다.** `project/edition/stage/round/item/question/answer/artifact`는 지금 화면이 읽는 현재값이고, `*_version`·`answer`·`change_log`는 덮어쓰지 않는 이력이다. 브리프의 "덮어쓰지 않고 쌓기"(`00-brief.md:31`)는 이 분리로 충족한다.
2. **질문은 "원문"과 "현재 문구"를 따로 가진다.** `question.original_text`는 최초 문구, `question_version`은 수정 이력, `answer.question_version_id`는 **그 답이 실제로 본 질문 버전**을 가리킨다. 질문을 고쳐도 옛 답의 의미가 조용히 바뀌지 않는다.
3. **첨언은 thread + anchor + message + resolution 네 층이다.** 인용문·앞뒤 문맥·오프셋을 저장하고, 글 버전이 바뀌면 `annotation_anchor`를 다시 계산해 `ok/moved/lost`로 표시한다. 결과는 글 수정·다음 라운드 할 일·앞 단계 다시 열기로 각각 남긴다.
4. **모든 행위자와 실행을 같은 모델로 묶는다.** 사람·내부 AI·외부 에이전트·브라우저 에이전트를 `actor`로, 실행을 `run`/`run_item`/`lease`로 둔다. 방식 A/B는 테이블을 나누지 않고 `run.mode`·`actor.kind`로 구분한다.
5. **사건 기록은 단조 증가 `seq` 하나로 통일한다.** `change_log(seq, project_id, entity, op, before/after, actor, tx)`가 화면 새로고침 커서·감사·"번호 붙은 변경 로그"를 모두 맡는다. Notion/Linear 분석의 `lastSyncId`·`updatedFrom` 아이디어를 PES에 맞게 줄인 것이다(`notion-linear.md:155-164`).
6. **큰 파일은 DB에 넣지 않는다.** `storage_object`(sha256, backend, object_key) + `artifact_version`/`item_asset` 포인터로 두고, 로컬은 파일, 웹은 R2를 쓴다. DB에는 메타데이터·해시·버전만 둔다.
7. **SQLite와 D1은 같은 SQL 파일로 간다.** SQLite 하위 호환 부분집합만 쓰고, `AUTOINCREMENT`·FTS5·트리거·`ATTACH`·복잡한 `PRAGMA`에 기대지 않는다. 마이그레이션은 번호 붙은 SQL 한 벌을 양쪽에 적용한다.
8. **기존 프로젝트는 사본에 먼저 이전한다.** `project.json` 원본은 건드리지 않고, 백업 → shadow DB → 검증 → 프로젝트별 전환 → 되돌리기 순서다. `project.json`과 DB를 장기간 이중 쓰지 않는다.
9. **OpenCode Go 자료 전송은 프로젝트별 정책으로 끈다.** `project_policy('ai_egress.opencode_go')`를 두고, 방식 A의 `run` 생성과 매 프롬프트 직전에 확인한다. 기본값은 **명시 동의 전 꺼짐**을 추천한다(사용자 결정 7-1, `stage-0.md:87`).
10. **2단계 구현 이슈는 약 46개(40~52)로 본다.** PR 단위로만 쪼개고, 테스트·문서를 각 PR에 포함한다. 0~6단계 전체를 합쳐도 Linear 260개 안에 들어간다(9.5절).

---

## 1. 설계 원칙

| 원칙 | 내용 | 이유 |
|---|---|---|
| 쓰기 경로 하나 | 웹·CLI·A·B 모두 같은 서비스 계층을 지나고, `change_log`를 같은 트랜잭션에 쓴다 | 지금은 CLI·스킬 직접 편집·`POST /feedback`이 상태를 각자 쓴다(`skills/core/SKILL.md:62-84`, `scripts/serve.py:111-152`, `stage-0.md:12-14`) |
| 현재값 + 이력 | 현재값은 빠른 조회용 projection, 이력은 append-only | "덮어쓰지 않고 쌓기"(`00-brief.md:31`), 되돌리기·비교·감사 |
| 프로젝트 스코프 | 모든 업무 테이블에 `project_id`를 둔다 | 로컬·D1 모두 한 DB에 여러 프로젝트를 담아도 격리·조회·내보내기가 쉽다 |
| 행위자 명시 | `created_by/asked_by/answered_by/decided_by`를 항상 actor로 | 사람/내부 AI/외부 에이전트/브라우저 에이전트 구분(`notion-linear.md:136`) |
| 방식 중립 | A/B 전용 테이블을 만들지 않는다 | "같은 데이터 모델과 같은 API"(`00-brief.md:39`) |
| 큰 파일 분리 | DB에는 메타데이터, 파일은 object store | D1 행 크기·비용·백업·R2 이전 |
| 하위 호환 | 현재 `project.json`의 미문서 필드도 보존 | 실제 프로젝트에 `edit_log`, `fixed_r2`, `reuse_all` 등이 있다(실측) |
| 검증 가능 | 스키마·마이그레이션·이전 결과를 자동 검증 | 0단계에서 테스트 기반을 만들었고, 2단계는 데이터 손실이 가장 큰 위험이다 |

---

## 2. 주제 목록

우선순위: **P0** = 1단계에서 반드시 확정, **P1** = 확정하고 2단계 초반에 구현, **P2** = 설계만 하고 뒤 단계로 미룸.

| # | 주제 | 우선순위 | 이 문서에서 정하는 것 |
|---|---|---|---|
| 1 | 범위·비목표 | P0 | DB가 맡는 것/파일이 남는 것, 2단계 경계 |
| 2 | 식별자·계층 | P0 | ULID+짧은 번호, project→edition→stage→round |
| 3 | 현재값·버전·스냅숏 | P0 | append-only 규칙, 스냅숏·되돌리기 |
| 4 | 항목·내용·연결 | P0 | item/item_version/source/stat/link/user_link |
| 5 | 질문 | P0 | 방향·출처·원문/수정·상태·중요도·기본값 |
| 6 | 답·질문별 의견 | P0 | 답 버전, `__other` 호환, 답-질문 버전 연결 |
| 7 | 가정 | P0 | 가정·확인/수정·근거 |
| 8 | 결정 기록 | P0 | "정해진 것" 살아 있는 기록, 판 범위 |
| 9 | 첨언·대화·결과 | P0 | 인용문·앵커·메시지·해결 결과 |
| 10 | 반영 내역 | P0 | 내 의견이 어떻게 반영됐는지 |
| 11 | 출처·검증 | P0 | 전역 출처 + 항목별 맥락, 원문 확인 |
| 12 | 결과물·버전·객체 저장 | P0 | artifact/artifact_version/storage_object |
| 13 | 사용자·에이전트·권한 | P0 | human/internal/external/browser, 토큰 |
| 14 | 실행·lease·rev·멱등 | P0 | run/run_item/lease/revision/idempotency |
| 15 | 사건 기록·동기화 | P0 | change_log seq, cursor, 감사 |
| 16 | 설정·AI 자료 전송 정책 | P0 | project_policy, OpenCode Go 끄기 |
| 17 | SQLite/D1 호환·성능 | P0 | 같은 SQL, 차이·제약·인덱스 |
| 18 | 기존 project.json 이전 | P0 | 사본·shadow·검증·전환·되돌리기 |
| 19 | API·읽기 모델·인덱스 | P1 | 화면·에이전트가 읽는 단위, N+1 방지 |
| 20 | 방식 A/B 차이 | P0 | DB에 주는 영향, 금지할 분기 |
| 21 | 보존·삭제·프라이버시 | P1 | soft delete, GC, 민감 자료, 감사 |
| 22 | 테스트·완료 기준·이슈 분해 | P0 | 1단계 완료, 2단계 착수, PR 단위 수 |

---

## 3. 주제별 논의

각 항목은 **정할 것 / 선택지 / 판단 기준 / 추천과 이유** 순서다.

### 3.1 범위·비목표 — P0

**정할 것**
- DB가 단일 진실 원천이 되는 범위: 상태·질문·답·첨언·결정·출처·결과물 메타데이터.
- 파일로 남길 것: 큰 원문·이미지·PDF·HWPX·R2 객체, `project.json` 내보내기, 정적 HTML(재생성).
- 2단계에서 하지 않을 것: 웹 UI 개편, 다중 사용자 로그인, hwpx 변환, 판 비교 화면.

**선택지**
1. `project.json`을 계속 원본으로 두고 DB는 캐시로만.
2. **DB를 원본으로 두고, `project.json`은 이전·백업·내보내기 형식으로 유지.**
3. 파일과 DB를 영구 이중 쓰기.

**판단 기준**
- 상태를 쓰는 경로가 하나로 줄어드는가.
- 기존 프로젝트를 잃지 않고 되돌릴 수 있는가.
- 웹(D1)과 로컬(SQLite)이 같은 설계를 쓰는가.
- 2단계 범위가 폭발하지 않는가.

**추천: 2번.**
- DB가 원본이다. `project.json`은 (a) 이전 전 원본, (b) 이전 후 읽기 전용 백업, (c) `pes export`의 휴대용 형식으로만 남긴다.
- 파일 저장소는 `storage_object`로 추상화하고, 로컬은 파일, 웹은 R2를 쓴다.
- 정적 HTML·`ask-*.html`은 원본이 아니라 렌더 결과다. 지금도 "상태는 `project.json`에 있다"(`skills/core/SKILL.md:18`)는 원칙이 있으므로 DB가 그 자리를 대신한다.
- 이유: 파일과 DB를 영구 이중 쓰면 충돌·유실·검증 비용이 두 배가 된다. 0단계의 "쓰기 경로 하나" 원칙(`stage-0.md:14`)과도 맞지 않는다.

---

### 3.2 식별자·계층 — P0

**정할 것**
- 내부 ID와 사람이 읽는 번호.
- `project → edition(판) → stage(단계) → round(라운드)`의 소유 관계.
- 항목·질문·첨언·결정·가정의 번호 체계.
- 한 프로젝트에 동시에 활성화할 수 있는 판 수.

**선택지**
1. 정수 auto-increment만 쓴다. 단순하지만 웹·여러 기기·가져오기에서 충돌한다.
2. **ULID(내부) + 프로젝트/단계별 짧은 번호(화면·대화용)**.
3. UUID v4만 쓴다. 정렬이 안 되고 디버깅이 불편하다.

**판단 기준**
- 웹·로컬·가져오기에서 ID가 충돌하지 않는가.
- 사람이 대화에서 `Q-12`, `C-7`, `D-3`, `A-5`로 부를 수 있는가.
- 정렬·커서·멱등 키로 쓰기 좋은가.
- ID가 URL·로그에 노출돼도 안전한가.

**추천: 2번.**
- 내부 PK는 **ULID**(26자, 시간순 정렬). 사람 번호는 `item.seq_no`(단계별 `#1`), `question.short_no`(`Q-12`), `annotation_thread.short_no`(`C-7`), `decision.short_no`(`D-3`), `assumption.short_no`(`A-5`). 둘 다 저장한다.
- `project.slug`는 URL·대화용 별칭이고, `project.id`는 불변이다. 지금은 slug가 폴더명이라 바꾸면 깨진다(`scripts/pes.py:206`).
- 판은 `edition_no`(1,2,3…), 프로젝트당 **활성 판 1개**를 기본으로 한다. 닫힌 판·일시정지 판은 여러 개 가능. 부분 유니크 인덱스가 D1에서 안 되면 `active_edition` 포인터 표로 대체한다.
- 이유: Linear의 `TEAM-123` + UUID, Notion의 UUID + 사람이 보는 제목(`notion-linear.md:164`)을 PES에 맞춘 것이다. ULID는 SQLite/D1 모두 `TEXT`로 저장되고, 생성은 애플리케이션이 한다.

---

### 3.3 현재값·버전·스냅숏 — P0

**정할 것**
- 어떤 변경을 버전으로 남기고, 어떤 변경은 현재값만 갱신하는가.
- 스냅숏을 어디에 저장하는가(DB/파일/R2).
- "되돌리기"가 새 버전을 만드는가, 과거 행을 되살리는가.
- 같은 라운드 재실행·같은 결과 재전송 시 중복을 어떻게 막는가.

**선택지**
1. 모든 변경을 `change_log`의 before/after만으로 남긴다.
2. **내용은 `*_version` 전체 스냅숏, 상태·관계는 `change_log` diff, 큰 스냅숏은 object store.**
3. 변경할 때마다 전체 프로젝트 JSON을 스냅숏으로 저장한다.

**판단 기준**
- 과거 라운드의 원고·질문·답을 그대로 재현할 수 있는가.
- 저장량이 2MB급 프로젝트에서 감당 가능한가.
- 특정 필드만 되돌리기 쉬운가.
- D1 행 크기·쿼리 성능을 넘지 않는가.

**추천: 2번.**
- `item_version`, `artifact_version`, `question_version`, `assumption_version`, `decision_version`은 **전체 내용 스냅숏**을 갖는다. `content_hash`로 중복을 줄인다.
- `answer`는 append-only이며 수정은 `supersedes_answer_id`로 새 행을 만든다.
- `change_log`는 필드 단위 `path` + 작은 `before_json/after_json` + 큰 내용은 `before_version_id/after_version_id`로 남긴다.
- 라운드 스냅숏은 `artifact(kind='snapshot')` + `artifact_version`으로 저장하고, `stage_round.snapshot_version_id`가 가리킨다. 지금의 `snapshots/<stage>-R<n>.json`(`scripts/pes.py:400-408`)을 그대로 이전한다.
- 되돌리기는 과거 행을 지우지 않고 **새 버전/새 결정**으로 남긴다(Notion의 가역 Restore, `notion-linear.md:57`).
- 이유: 상태 diff만으로는 본문 재현이 어렵고, 전체 프로젝트 스냅숏은 너무 크다. 내용 버전 + 필드 diff + 큰 객체 분리가 균형점이다.

---

### 3.4 항목·내용·연결 — P0

**정할 것**
- 현재 항목(`item`)과 내용 버전(`item_version`)의 분리.
- `summary/details/sources/stats/shots/confidence/conflicts/verify/links/user_links`를 정규화할 범위.
- 현재 `links`(plan/research/library)와 `user_links`의 관계 표현.
- 실제 프로젝트에만 있는 `edit_log`, `fixed_r2`, `reuse_all`, `model`, `pages` 같은 미문서 필드的处理.

**선택지**
1. 항목 전체를 JSON 한 열로 저장한다. 이전은 쉽지만 질의·연결·버전 비교가 어렵다.
2. **항목 현재값 + 내용 버전 + 출처/수치/연결은 정규화, 나머지는 `meta_json` 보존.**
3. 모든 필드를 완전 정규화한다. 스키마가 거대해지고 미문서 필드에서 깨진다.

**판단 기준**
- `digest`/`show`/대시보드가 필요한 조회를 인덱스로 처리할 수 있는가.
- 출처 중복 제거·원문 확인율 계산이 쉬운가.
- 미문서 필드를 잃지 않는가.
- 1.76MB·304항목 프로젝트를 이전·조회할 수 있는가.

**추천: 2번.**
- `item`은 식별·상태·번호·`current_version_id`를 갖고, `item_version`이 제목·질문·요약·본문·신뢰도·충돌·검증을 갖는다. 지금 `merge`가 항목 내용을 갱신할 때마다 버전이 하나 늘어난다(`scripts/pes.py:315-365`).
- `sources`는 전역 `source` + `item_source`(항목별 method·note·quote·검증)로 나눈다. 지금은 항목마다 출처 객체를 복사하고 URL로만 중복 제거한다(`scripts/pes.py:339-344`).
- `stats`는 `stat` 표로 정규화한다. `digest`가 수치를 바로 읽는다(`scripts/pes.py:603-606`).
- `links`는 `item_link(from_item_id, to_kind, to_id, relation)`로 푼다. `to_kind='item'`이면 plan/research 연결, `'library_item'`이면 참고자료 재사용이다.
- `user_links`, `shots`는 각각 `user_link`, `item_asset`으로 둔다.
- 미문서 필드는 `item.meta_json`/`item_version.meta_json`에 보존하고, `import_issue`에 "알려진 스키마 아님"으로 기록한다. `edit_log`처럼 화면에서 쓰는 필드는 2단계에서 승격 여부를 정한다.
- 이유: 지금 구조는 항목 JSON이 사실상 스키마이고, `load()`가 빠진 필드를 조용히 채운다(`scripts/pes.py:96-114`). 정규화하되 모든 것을 정규화하지 않아야 이전과 확장이 안전하다.

---

### 3.5 질문 — P0

**정할 것**
- 누가 물었는가(AI→사람, 사람→AI), 어디서 나왔는가(은행/점검/에이전트/사람/브라우저).
- 원문과 수정 문구, 수정 이력.
- 상태(open/answered/deferred/merged/closed), 중요도, 기본값, 필수 여부.
- 선택지·조건부 표시(`show_if`)·도움말.
- 질문을 고친 뒤 기존 답을 어떻게 다룰 것인가.

**선택지**
1. 질문을 한 행으로 두고 수정하면 덮어쓴다. 기존 답의 의미가 바뀐다.
2. **질문 현재값 + `question_version` 이력, 답은 답한 시점의 `question_version_id`에 묶는다.**
3. 질문을 수정할 수 없게 한다. 브리프의 "고치기 좋은 구조"(`00-brief.md:19-20`)와 어긋난다.

**판단 기준**
- 질문 문구를 고쳐도 옛 답이 조용히 다른 질문의 답이 되지 않는가.
- "원문 → 고친 문구"를 화면에서 보여 줄 수 있는가.
- 질문별 중요도·기본값을 라운드마다 바꿀 수 있는가.
- 방식 A/B가 같은 질문을 만들고 같은 답을 읽는가.

**추천: 2번.**
- `question`에 `direction`, `origin`, `origin_ref`, `asked_by_actor_id`, `assigned_to_actor_id`, `status`, `importance`, `default_value_json`, `required`, `original_text`, `current_version_id`를 둔다.
- `question_version`에 `label`, `body_md`, `help_md`, `type`, `required`, `importance`, `default_value_json`, `show_if_json`, `edited_by`, `edit_reason`을 둔다. 옵션은 `question_option`(value/label/desc/recommended/order)로 버전에 묶는다.
- `question.original_text`는 최초 label을 불변으로 보존한다. 화면은 `current_version`을 보여 주고, "원문 보기"는 `original_text`/v1을 보여 준다.
- 질문 수정 뒤 기존 답은 그대로 두되 `answer.status='stale'`로 표시하고, 새 버전에 대한 답을 받으면 `supersedes_answer_id`로 잇는다. **기존 답을 새 버전에 자동 매핑하지 않는다.**
- `deferred`는 `defer_until_round`/`defer_condition_json`을 둔다. Linear Triage의 "H 미루기"와 brief 8-3의 중요도·기본값을 수용한다(`notion-linear.md:94`, `notion-linear.md:133`).
- 이유: 질문/답이 PES의 핵심 소통 기록이다. 질문 문구가 바뀌면 답의 의미도 바뀌므로, 버전 연결 없이는 감사·재현이 불가능하다.

---

### 3.6 답·질문별 의견·`__other` — P0

**정할 것**
- 답의 값·질문별 의견·기타 텍스트를 어디에 둘 것인가.
- 답 수정·재답변·철회를 어떻게 표현할 것인가.
- 현재 웹 폼의 `answers[id]`, `answers[id+'__other']`와의 호환.
- 답을 처리 완료(`processed`)로 표시하는 시점.

**선택지**
1. 답을 한 행으로 두고 수정하면 덮어쓴다.
2. **답은 append-only, 수정은 `supersedes_answer_id`, `comment_md`·`other_text`를 별도 열로.**
3. 답 전체를 JSON으로만 저장한다.

**판단 기준**
- 누가 언제 어떤 채널로 답했는지 남는가.
- 기존 `feedback/*.json`을 잃지 않고 이전할 수 있는가.
- 답 처리 상태(미처리/처리)를 구분할 수 있는가.
- 방식 A/B가 같은 답을 만들 수 있는가.

**추천: 2번.**
- `answer`에 `answerer_actor_id`, `question_version_id`, `value_json`, `other_text`, `comment_md`, `channel(web|chat|api|import)`, `status(draft|submitted|superseded|stale|rejected)`, `supersedes_answer_id`, `idempotency_key`, `submitted_at`, `processed_at`을 둔다.
- `answer_option`은 single/multi 선택을 질문 옵션과 연결한다. `value_json`은 text/number/scale/file의 정본이다.
- 현재 `__other`는 `other_text`로 옮긴다. `templates/_questions.html:33-48`이 모든 질문에 "기타·덧붙일 말"을 붙이고, `:87-88`이 `answers[id+'__other']`로 모은다. 이 의미를 그대로 보존한다.
- `processed_at`은 지금 `processed` 파일명 목록(`scripts/pes.py:516-518`, `:556-563`)을 대체한다. 답 저장과 처리 완료를 분리한다.
- 긴 논의는 `annotation_thread(target_kind='answer')`로 보낸다. 답 한 행에 대화 전체를 넣지 않는다.
- 이유: 답은 "사용자의 의사"이므로 덮어쓰면 안 된다. `__other`는 이미 있는 기능이므로 마이그레이션에서 반드시 보존해야 한다(`00-brief.md:20`).

---

### 3.7 가정 — P0

**정할 것**
- AI가 깔고 있는 가정을 어떤 단위로 드러낼 것인가.
- 사람이 맞다/틀리다/고침을 어떻게 기록할 것인가.
- 가정과 근거·결정·질문의 연결.
- 가정이 틀렸을 때 영향받는 항목·라운드를 어떻게 찾을 것인가.

**선택지**
1. 가정을 `item`의 한 종류(`kind='assumption'`)로 둔다.
2. **독립 `assumption` + `assumption_version` + `evidence_link`.**
3. 질문의 답으로만 남긴다.

**판단 기준**
- "가정 목록"을 프로젝트 전체에서 한 번에 볼 수 있는가.
- 사람의 확인/수정이 이력으로 남는가.
- 가정 → 결정 → 항목의 추적이 되는가.
- 방식 A/B가 같은 가정을 만들 수 있는가.

**추천: 2번.**
- `assumption`에 `statement`, `status(open|confirmed|corrected|rejected)`, `confidence`, `confirmed_by`, `resolved_at`, `current_version_id`를 둔다. `assumption_version`이 문장·근거·신뢰도 이력을 갖는다.
- `evidence_link(subject_kind='assumption')`로 출처·항목과 연결한다.
- 화면은 "가정 A-3: … / 맞음 / 틀림 / 고침"으로 보여 주고, 고침은 새 버전 + `decision` 또는 `item`의 `revise`로 이어진다.
- 이유: 브리프 8-1이 "가정 목록을 드러내고 사람이 맞다/틀리다/고침"을 요구한다(`00-brief.md:24`). 항목에 섞으면 프로젝트 전체 가정 목록을 만들기 어렵다.

---

### 3.8 결정 기록 — P0

**정할 것**
- "정해진 것"의 범위(프로젝트 전체/판/단계).
- 결정의 상태(제안/결정/대체/다시 열림), 결정자, 근거.
- 2판이 1판의 결정을 이어받는 방식(공유/복사/재검토).
- 결정과 질문·첨언·가정의 연결.

**선택지**
1. `settings`의 한 키로 결정 목록을 JSON 저장한다.
2. **독립 `decision` + `decision_version` + `evidence_link`, `scope`로 프로젝트/판/단계 구분.**
3. 결정을 `item(kind='decision')`로 둔다.

**판단 기준**
- 프로젝트 전체의 살아 있는 결정 목록을 만들 수 있는가.
- 결정이 바뀐 이유와 이전 결정을 추적할 수 있는가.
- 2판에서 "이번 판에서는 이 결정을 빼겠다"를 명시할 수 있는가.
- 방식 A/B가 같은 결정 기록을 쓰는가.

**추천: 2번.**
- `decision`에 `scope(project|edition|stage)`, `edition_id`(프로젝트 범위면 NULL), `status(proposed|decided|superseded|reopened)`, `decided_by`, `decided_at`, `supersedes_decision_id`, `source_question_id`, `source_thread_id`, `tags_json`, `current_version_id`를 둔다.
- `decision_version`에 `decision_md`, `rationale_md`, `alternatives_json`을 둔다.
- 새 판은 프로젝트 범위 결정을 **참조**하고, 판 범위 결정은 `carried_from_decision_id`로 복사해 "이번 판에서도 유지/수정/제외"를 명시한다. 자동 공유하지 않는다.
- `evidence_link(subject_kind='decision')`로 근거를 붙인다.
- 이유: 브리프 8-6의 "살아 있는 결정 기록"(`00-brief.md:29`)은 화면 기능이 아니라 데이터 모델이다. `settings` JSON은 버전·결정자·대체 관계를 표현하기 어렵다.

---

### 3.9 첨언·대화·결과 — P0

**정할 것**
- 첨언 대상(원고·항목·질문·답·결정·메시지)과 위치 표현.
- 인용문·앞뒤 문맥·오프셋·대상 버전.
- 대화 메시지의 작성자(사람/AI/브라우저 에이전트)와 답글.
- 해결 결과(글 수정/다음 라운드 할 일/앞 단계 다시 열기/닫기)와 그 대상.
- 글 버전이 바뀌었을 때 앵커를 다시 찾는 규칙.

**선택지**
1. 첨언을 `artifact`의 한 종류로 두고 본문에 HTML 주석으로 심는다.
2. **`annotation_thread` + `annotation_anchor` + `annotation_message` + `annotation_resolution`.**
3. 댓글을 평면 목록으로 두고 위치는 저장하지 않는다.

**판단 기준**
- 인용문이 사라져도 "위치 잃음"을 알 수 있는가.
- 원고가 수정돼도 첨언이 어느 버전을 가리키는지 남는가.
- 대화 결과가 실제 변경(버전/할 일/reopen)으로 이어지는가.
- 브라우저 에이전트가 쓴 글도 같은 모델로 들어오는가.

**추천: 2번.**
- `annotation_thread`에 `target_kind`, `target_id`, `target_version_id`, `quote_text`, `context_before`, `context_after`, `status`, `resolved_by_message_id`, `resolution_summary_md`를 둔다. `short_no`로 `C-7`을 부여한다.
- `annotation_anchor`에 `target_version_id`, `start_offset`, `end_offset`, `prefix_hash`, `suffix_hash`, `status(ok|moved|lost|none)`를 둔다. 새 버전이 생기면 인용문+앞뒤 문맥으로 다시 찾고, 못 찾으면 `lost`로 남긴다. Linear의 `quotedText`+`inlineAnchorFrom/To`, Notion의 `discussion.context`+`anchored_runs`와 같은 원리다(`notion-linear.md:44-49`, `:96-102`).
- `annotation_message`는 `reply_to_id`로 스레드를 만들고, `author_actor_id`로 사람/AI/브라우저를 구분한다.
- `annotation_resolution`은 한 스레드에 여러 결과를 허용한다: `edit_artifact`(새 `artifact_version`/`item_version` 또는 `edit_proposal`), `next_round_task`(새 `item`/`notice`), `reopen_stage`(`stage_round`/`change_log`), `close_only`.
- `edit_proposal`은 3~4단계의 "제안 모드"를 위한 선택 테이블이다. 대상 버전·제안 본문·수락/거절 상태를 둔다.
- 이유: 브리프 6번의 첨언은 "글의 특정 부분 + 대화 + 결과" 세 가지가 모두 필요하다(`00-brief.md:21`). 평면 댓글로는 위치·버전·결과 추적이 안 된다.

---

### 3.10 반영 내역 — P0

**정할 것**
- 어떤 의견(답·첨언·결정·가정)이 어느 라운드에서 어떻게 반영됐는지.
- 반영/부분 반영/미반영/보류의 판정 기준.
- 실제 변경(버전·결정·할 일)과의 연결.
- 다음 라운드 첫머리에 무엇을 보여 줄 것인가.

**선택지**
1. `changes` 문자열에 "반영함"이라고 적는다.
2. **`reflection` 표에 source·disposition·summary·evidence를 남기고, 라운드 시작 시 조회한다.**
3. `change_log`에서 자동 추론한다.

**판단 기준**
- 사용자가 "내 의견이 어디에 반영됐는지" 한눈에 보는가.
- 반영하지 않은 것과 이유가 남는가.
- 답·첨언·결정·가정을 모두 같은 방식으로 다루는가.
- AI가 쓴 요약을 사람이 확인할 수 있는가.

**추천: 2번.**
- `reflection`에 `source_kind(answer|annotation|decision|assumption|qa)`, `source_id`, `disposition(reflected|partially|not_reflected|deferred)`, `summary_md`, `evidence_kind/evidence_id`, `status(proposed|confirmed)`, `created_by`를 둔다.
- 다음 라운드 첫머리(`stage_round` 시작)에 `reflection`을 source별로 묶어 보여 준다. `changes`는 라운드의 3~5줄 요약으로 남기고, 반영 내역은 별도 표가 맡는다.
- `change_log`만으로 자동 추론하지 않는다. "반영했다"는 판단은 사람이 확인할 수 있어야 하고, 부분 반영·보류는 diff로 표현되지 않는다.
- 이유: 브리프 8-2가 "내 의견이 어떻게 반영됐는지 다음 라운드 첫머리에"를 요구한다(`00-brief.md:25`). 이는 diff가 아니라 **판정과 요약**이다.

---

### 3.11 출처·검증 — P0

**정할 것**
- 출처를 항목마다 복사할 것인가, 전역으로 공유할 것인가.
- method(search/fetch/browser/kosis/law/vworld), 원문 확인, 기준일.
- 같은 URL의 중복 제거와 항목별 note 차이.
- 출처 원문·스크린샷 보관.

**선택지**
1. 지금처럼 항목의 `sources` 배열에 복사한다.
2. **전역 `source` + `item_source`(항목별 method/note/quote/검증) + `storage_object`(원문·스크린샷).**
3. 출처를 별도 프로젝트로 분리한다.

**판단 기준**
- 같은 출처를 여러 항목이 쓸 때 중복 저장·중복 확인을 피하는가.
- `digest`의 "출처 n개(원문 m)"를 정확히 계산하는가.
- 원문 확인 여부·기준일이 항목별로 남는가.
- R2로 옮길 때 원문·스크린샷이 함께 가는가.

**추천: 2번.**
- `source`에 `dedupe_key`(정규화 URL 또는 `title:…`), `title`, `publisher`, `published_at`, `first_seen_at`, `last_checked_at`, `content_hash`, `metadata_json`을 둔다. `UNIQUE(project_id, dedupe_key)`.
- `item_source`에 `item_version_id`, `source_id`, `role`, `method`, `quote`, `locator`, `note`, `verified`, `verified_at`, `verified_by`, `order_no`를 둔다. `UNIQUE(item_version_id, source_id, role)`.
- `verified`는 `method in (browser,kosis,law,vworld)`만 참으로 계산하지 않고, **명시적 확인 결과**로 저장한다. 지금 `VERIFIED` 집합은 method만 본다(`scripts/pes.py:64`, `:597`).
- 원문·스크린샷은 `storage_object` + `item_asset`/`source_asset`으로 둔다. 출처 원문을 저장할지 여부는 사용자 결정(9.3절)로 남긴다.
- 이유: 지금은 항목마다 출처 객체를 복사하고 URL로만 중복을 제거한다(`scripts/pes.py:339-344`). 전역 출처는 원문 확인·중복 확인·R2 이전을 단순하게 만든다.

---

### 3.12 결과물·버전·객체 저장 — P0

**정할 것**
- 보고서·eli5·최종 웹 보고서·스냅숏·내보내기의 논리 단위와 버전.
- 파일 본문을 DB에 둘지, object store에 둘지.
- 같은 파일을 다시 만들었을 때 덮어쓸지 새 버전을 만들지.
- "현재 버전"과 "과거 공유본"의 관계.

**선택지**
1. 지금처럼 `reports` 목록에 경로만 두고 파일을 덮어쓴다.
2. **`artifact`(논리 문서) + `artifact_version`(불변 버전) + `storage_object`(본문).**
3. 모든 보고서를 DB BLOB으로 저장한다.

**판단 기준**
- 같은 라운드 재생성·재승인에서 과거 보고서를 잃지 않는가.
- 인쇄·공유한 과거 버전을 다시 찾을 수 있는가.
- D1 행 크기·비용을 넘지 않는가.
- R2로 옮길 때 키·해시가 그대로인가.

**추천: 2번.**
- `artifact`에 `kind(report_md|report_html|eli5|stage_report|final_report|snapshot|export|executive_summary|conclusion)`, `title`, `format`, `status(current|superseded|archived)`, `current_version_id`를 둔다.
- `artifact_version`에 `version_no`, `object_id`(또는 작은 텍스트면 `inline_text`), `content_hash`, `bytes`, `mime`, `filename`, `base_version_id`, `source_round_id`, `created_by`, `run_id`를 둔다.
- `artifact_source`로 어떤 `item_version`을 인용했는지 남긴다.
- 지금 `reports` 목록은 `format/label/path/bytes/round`만 갖고, 같은 경로를 덮어쓴다(`scripts/pes.py:830-859`). 새 설계는 **매번 새 버전**을 만든다.
- 스냅숏도 artifact로 통일한다. `stage_round.snapshot_version_id`가 가리킨다.
- 이유: 브리프의 "덮어쓰지 않고 쌓기"는 보고서에도 적용된다. 특히 사용자가 공유·인쇄한 과거 보고서는 재생성으로 대체되면 안 된다.

---

### 3.13 사용자·에이전트·권한 — P0

**정할 것**
- 사람/내부 AI/외부 에이전트/브라우저 에이전트를 어떻게 구분하는가.
- 에이전트가 사람 대신 한 일(`on_behalf_of`)을 어떻게 표시하는가.
- API 토큰의 범위·저장·회전.
- 프로젝트 멤버·역할(5단계 대비).

**선택지**
1. `created_by`를 문자열(`"claude"`, `"user"`)로 둔다.
2. **`actor` 표 + `user` + `project_member` + `agent_token`.**
3. 에이전트별로 별도 표를 만든다.

**판단 기준**
- 모든 기록에서 "누가 했는지"를 같은 방식으로 조회하는가.
- 방식 A/B/브라우저 에이전트가 같은 `asked_by`/`created_by`를 쓰는가.
- 토큰 원문이 DB·로그에 남지 않는가.
- 5단계 로그인으로 확장되는가.

**추천: 2번.**
- `actor.kind`는 `human|agent_internal|agent_external|agent_browser|system`. `agent_name`(claude-code/codex/opencode/pes-internal), `provider`, `model`, `via`(web/tui/mcp/api/webmcp/cli/app), `owner_user_id`, `on_behalf_of_user_id`를 둔다.
- `agent_token`은 `token_hash`만 저장하고 `scopes_json`, `expires_at`, `revoked_at`을 둔다. URL·로그에 원문을 남기지 않는다.
- `project_member(project_id,user_id,role)`는 5단계에서 쓰지만, 스키마를 미리 두어 이전 비용을 줄인다.
- 브라우저 에이전트는 `actor.kind='agent_browser'`, `via='webmcp'`, `on_behalf_of_user_id`로 표시한다. WebMCP 연구의 "누가: 사람/내부 AI/외부 에이전트/브라우저 에이전트"를 그대로 수용한다(`webmcp.md:37`, `notion-linear.md:136`).
- 이유: Notion의 `created_by_table`, Linear의 `onBehalfOf{agent,model}`이 보여 주듯이 작성자 종류는 별도 열이어야 한다(`notion-linear.md:46`, `:106`). 문자열 `created_by`는 방식 A/B를 구분하지 못한다.

---

### 3.14 실행·lease·rev·멱등 — P0

**정할 것**
- 실행(run)의 단위: 프로젝트/단계/라운드/항목.
- 한 프로젝트에 동시에 쓸 수 있는 실행 수.
- lease 획득·갱신·만료·탈취, fence.
- 행/프로젝트 revision과 `If-Match`.
- 결과·피드백 재전송의 멱등 키.

**선택지**
1. 지금의 2시간 파일 잠금(`scripts/pes.py:117-144`)을 그대로 쓴다.
2. **`run` + `run_item` + `lease(heartbeat/fence)` + 행 `rev` + `api_idempotency` + `tx`.**
3. DB 트랜잭션만 믿고 애플리케이션 규칙을 두지 않는다.

**판단 기준**
- A와 B가 같은 프로젝트를 동시에 만져도 lost update가 없는가.
- 프로세스가 죽었을 때 lease가 만료되어 다른 실행이 이어받는가.
- 같은 결과를 두 번 보내도 한 번만 반영되는가.
- 사용자에게 "누가 쓰고 있는지" 보이는가.

**추천: 2번.**
- `run`은 `mode`, `status`, `actor_id`, `model/provider`, `external_ref_json`(OpenCode/Claude 세션), `input/output_tokens`, `cost_usd`를 갖는다. `run_item`은 한 run이 여러 항목을 맡을 때 항목별 상태·시도 횟수를 남긴다.
- `lease`는 `run_id`, `actor_id`, `heartbeat_at`, `expires_at`, `fence`, `status`. **활성 lease는 프로젝트당 하나**로 부분 유니크 인덱스(`WHERE status='active'`)를 두고, D1이 부분 인덱스를 거부하면 `active_lease` 포인터 표로 대체한다. heartbeat 30초, TTL 5분을 기본으로 하고, 만료 후 탈취는 `fence`로 옛 writer의 쓰기를 거부한다.
- 모든 업무 행에 `rev INTEGER`를 두고, 쓰기는 `If-Match`를 요구한다. `project.rev`는 프로젝트 전체 스냅숏·UI 갱신용으로 따로 증가시킨다.
- `api_idempotency(project_id, actor_id, key)`에 요청 해시·응답을 저장한다. `tx`는 한 번에 여러 연산을 묶는 단위이며 `client_tx_id`로 중복을 막는다.
- 이유: 방식 A/B를 동시에 개발하면 "TUI에서 사람이 답하는 동안 내부 에이전트가 같은 프로젝트를 쓰는" 상황이 반드시 생긴다. 전체 파일 저장(`scripts/pes.py:147-158`)으로는 lost update가 난다. 이건 기능이 아니라 정합성 문제다.

---

### 3.15 사건 기록·동기화 — P0

**정할 것**
- 사건의 단위·번호·보존 기간.
- 화면 새로고침·에이전트 동기화의 커서.
- before/after에 무엇을 남기고 무엇을 redaction할 것인가.
- `change_log`와 실행 로그(`execution_event`)의 역할 분리.

**선택지**
1. 지금의 `feedback.log` 한 줄 + `snapshots`로 충분하다고 본다.
2. **`change_log(seq)` 하나 + `tx` + `execution_event`(런타임).**
3. 모든 것을 이벤트 소싱으로 만들고 현재값 표를 없앤다.

**판단 기준**
- `GET /changes?since=`로 화면·에이전트가 바뀐 것만 받는가.
- "번호 붙은 변경 로그"를 사람이 읽을 수 있는가.
- 감사·되돌리기·디버깅에 충분한가.
- 이벤트 소싱의 복잡도를 2단계에 끌어들이지 않는가.

**추천: 2번.**
- `change_log`에 `seq INTEGER PRIMARY KEY`(단조 증가, 삭제 금지), `id`(ULID), `project_id`, `tx_id`, `entity_kind/id`, `op`, `path`, `summary`, `before_json/after_json`, `before_version_id/after_version_id`, `actor_id`, `run_id`, `visibility`, `created_at`을 둔다.
- `seq`는 전역이지만 `WHERE project_id=? AND seq>?`로 프로젝트별 커서로 쓴다. 지금의 `/version` 폴링(`scripts/serve.py:93-97`)을 대체한다.
- `execution_event`는 run 안의 도구 호출·권한 요청·비용·중간 메시지다. 상태 변경은 `change_log`에만 쓴다. 두 개를 섞으면 감사 로그가 지저분해진다.
- `before_json/after_json`은 작은 필드만. 본문은 `*_version_id`로 가리킨다. 민감 값은 `visibility='internal'`/redaction 규칙으로 숨긴다.
- 이유: Notion의 트랜잭션 연산 로그·Linear의 `lastSyncId`/`updatedFrom`이 주는 교훈은 "변경을 번호 붙여 한 줄로 남기고, 현재값은 따로 읽는다"이다(`notion-linear.md:38-41`, `:64-70`, `:155-164`). 완전한 이벤트 소싱은 2단계에 과하다.

---

### 3.16 설정·AI 자료 전송 정책 — P0

**정할 것**
- 설정을 `project/stage` JSON에 둘지, 키-값 표로 둘지.
- OpenCode Go 자료 전송을 프로젝트별로 끄는 표현.
- 기본값·동의 절차·철회·감사.
- 방식 A의 어느 지점에서 정책을 강제할 것인가.

**선택지**
1. `project.settings_json`/`stage.settings_json`에 모두 넣는다.
2. **일반 설정은 `setting(scope,key,value_json)`, 자료 전송은 `project_policy`로 분리.**
3. 전역 설정 하나로 모든 프로젝트를 제어한다.

**판단 기준**
- 특정 설정 키만 조회·변경·감사할 수 있는가.
- 자료 전송 동의를 일반 설정과 분리해 실수로 덮어쓰지 않는가.
- 프로젝트별 끄기(사용자 결정 7-1)가 즉시 작동하는가.
- 5단계 웹에서도 같은 정책을 쓸 수 있는가.

**추천: 2번.**
- `setting`은 `scope_kind(project|edition|stage)`, `scope_id`, `key`, `value_json`, `updated_by`, `rev`로 둔다. 지금 `settings`와 `stages.*.settings`를 그대로 옮긴다.
- `project_policy`는 `project_id`, `policy_key`, `allowed`, `value_json`, `set_by`, `set_at`, `note`, `rev`로 둔다. `policy_key='ai_egress.opencode_go'`.
- 기본값은 **꺼짐**을 추천한다. 최초 방식 A 실행 시 "이 프로젝트의 자료를 OpenCode Go로 보낼까요?"를 묻고, 동의하면 켠다. 이미 켠 프로젝트는 설정 화면에서 즉시 끌 수 있고, 진행 중 run은 다음 프롬프트부터 차단한다.
- 강제 지점: `POST /runs`(mode A) 생성 시, OpenCode 어댑터가 `prompt`를 보내기 직전, 재시도·후속 호출 직전. 정책이 꺼져 있으면 `policy_blocked` 오류와 안내를 내고 **부분 전송하지 않는다**.
- 감사: `project_policy` 변경은 `change_log`에 `policy.updated`로 남기고, 차단은 `execution_event(kind='policy_blocked')`로 남긴다.
- 합성·테스트 프로젝트는 `synthetic=1`로 표시해 정책과 무관하게 시험할 수 있게 한다(0단계 시험은 합성 자료만, `stage-0.md:87`).
- 이유: 자료 전송은 한 번 나가면 되돌릴 수 없다. 일반 설정 JSON에 섞으면 실수로 덮어쓰거나, 프로젝트 복제 시 딸려 갈 수 있다. 별도 정책 표가 안전하다.

---

### 3.17 SQLite/D1 호환·성능·마이그레이션 — P0

**정할 것**
- 로컬 DB 파일 위치와 단위(홈/프로젝트).
- SQLite와 D1의 공통 SQL 부분집합.
- 마이그레이션 파일·적용 순서·검증.
- 인덱스·조회 성능·2MB 프로젝트 예산.
- D1 제약(트랜잭션·크기·백업) 대응.

**선택지**
1. 로컬은 프로젝트별 SQLite, 웹은 프로젝트별 D1. 이전·백업은 쉽지만 DB 수가 많아진다.
2. **로컬은 기기당 SQLite 하나(`~/.pes/pes.db`), 웹은 환경당 D1 하나, 모든 표에 `project_id`.**
3. 로컬은 JSON 유지, 웹만 D1. 같은 설계가 아니다.

**판단 기준**
- 로컬과 웹이 같은 SQL·같은 코드 경로를 쓰는가.
- 프로젝트 하나를 백업·이전·삭제하기 쉬운가.
- OneDrive·여러 기기에서 DB가 깨지지 않는가.
- D1 바인딩·비용·한도가 감당 가능한가.

**추천: 2번.**
- 로컬 DB는 `~/.pes/pes.db`(기기 로컬, 동기화 폴더 밖)을 기본으로 하고, 프로젝트 폴더에는 `pes export` 스냅숏을 둔다. OneDrive에는 **살아 있는 SQLite를 두지 않는다.** 이전에는 `project.json` 폴더를 쓰던 사용자에게 "내보내기/가져오기"로 안내한다.
- 웹은 D1 하나에 `project_id`로 격리한다. 프로젝트별 D1은 바인딩·마이그레이션·비용이 커서 피한다.
- SQL 부분집합: `TEXT/INTEGER/REAL`, `PRIMARY KEY`, `FOREIGN KEY`, `UNIQUE`, `CHECK`(가벼운 것만), `INDEX`. `AUTOINCREMENT`는 쓰지 않고 `INTEGER PRIMARY KEY`(삭제 금지)로 `seq`를 만든다. FTS5·트리거·`ATTACH`·`VACUUM INTO`·복잡한 `PRAGMA`·생성 열·부분 인덱스에 의존하지 않는다(부분 인덱스가 필요하면 포인터 표로 대체).
- 시간은 애플리케이션이 만든 ISO 8601 UTC `TEXT`. 불리언은 `INTEGER 0/1`. JSON은 `TEXT`(앱 검증), 핵심 조회 열은 정규화한다. ID는 앱이 만든 ULID.
- 마이그레이션: `db/migrations/NNN-*.sql` 한 벌, `schema_migration(version,name,checksum,applied_at)`. SQLite는 `PRAGMA foreign_keys=ON`, WAL, `BEGIN IMMEDIATE`; D1은 요청 단위 트랜잭션과 짧은 쓰기를 전제로 한다.
- 성능 예산: 2MB/304항목 기준 `project load < 100ms`, `stage digest < 200ms`, `dashboard read model < 500ms`, `migration < 30s/project`. 인덱스는 4.12절.
- 이유: 기기당 DB 하나 + `project_id`가 로컬·D1 양쪽에서 가장 단순하다. 프로젝트별 DB는 "폴더 복사"에는 좋지만 웹 D1에서는 바인딩이 폭발한다. 살아 있는 SQLite를 OneDrive에 두면 동시 쓰기·충돌 사본 위험이 크다(`README.md:503-521`).

**확인 필요(2단계 스파이크)**
- D1의 `FOREIGN KEY` 강제, 부분 인덱스, `json_valid`, `RETURNING`, `UPSERT` 지원 범위.
- D1의 단일 SQL 문 크기·행 크기 한도(큰 INSERT는 배치로).
- Wrangler/miniflare로 같은 마이그레이션을 돌리는 CI 방법.

---

### 3.18 기존 project.json 이전·백업·되돌리기 — P0

**정할 것**
- 원본을 언제·어떻게 백업하는가.
- 한 번에 전체를 옮길지, 프로젝트별로 옮길지.
- 이전 중 `project.json`과 DB의 관계(이중 쓰기/읽기 전용/shadow).
- 검증 합격 기준과 되돌리기 절차.
- 미문서 필드·누락 파일·충돌 사본的处理.

**선택지**
1. 빅뱅: 모든 프로젝트를 한 번에 DB로 옮기고 파일을 지운다.
2. **프로젝트별 shadow 이전 → 검증 → 전환 → 원본은 읽기 전용 보관.**
3. 영구 이중 쓰기.

**판단 기준**
- 자료 손실 없이 되돌릴 수 있는가.
- 이전 중에도 기존 PES로 작업을 계속할 수 있는가.
- 검증이 개수·해시·화면 재생성까지 보는가.
- 사용자가 이전 시점을 통제할 수 있는가.

**추천: 2번.**
- 절차는 6절에 상세히 적는다. 핵심은 **(a) 원본 폴더 전체를 시각 붙은 사본으로 백업, (b) 별도 shadow DB에 이전, (c) 개수·해시·ID·연결·보고서 재생성 검증, (d) 프로젝트별 `storage_backend` 전환, (e) 원본 `project.json`은 읽기 전용 보관**이다.
- 이중 쓰기는 하지 않는다. 전환 후 문제가 생기면 `pes migrate --rollback`으로 파일 모드로 돌아가고, 그 사이 DB에 새로 쓴 것이 있으면 `pes export`로 파일에 반영한 뒤 되돌린다. **전환 직후 유예 기간**을 두고 rollback 가능성을 안내한다.
- 미문서 필드는 `legacy_json`/`meta_json`에 보존하고, `import_issue`에 기록한다. 버리지 않는다.
- 이유: 실제 프로젝트는 `project.json` 1.76MB, `verify` 항목 304개, `rounds/*` 103개 파일, `reports`·`shots`·`out`까지 있다(실측). 한 번에 지우는 빅뱅은 위험하다. 파일 단위 프로젝트 모델을 유지하면 사용자가 이전 시점을 고를 수 있다.

---

### 3.19 API·읽기 모델·인덱스 — P1

**정할 것**
- 화면·에이전트가 읽는 단위(프로젝트 요약/단계 digest/항목 상세/질문 목록/변경 커서).
- `project.json` 전체를 API로 내보내지 않는 원칙.
- N+1 쿼리를 피하는 읽기 모델/뷰.
- `If-Match`·커서·페이지 크기.

**선택지**
1. 화면이 필요한 모든 표를 직접 조인한다.
2. **읽기 모델(쿼리 함수/뷰)을 정하고, API는 그 단위로 반환한다.**
3. `project.json`을 그대로 반환하고 화면이 처리한다.

**판단 기준**
- 대시보드가 304항목에서도 빠른가.
- 에이전트가 전체 상태를 받지 않고 digest로 일하는가(`skills/core/SKILL.md:86-92`).
- 변경 커서로 바뀐 것만 받는가.
- API 응답이 방식 A/B에 공통인가.

**추천: 2번.**
- 읽기 모델:
  - `project_summary`: 프로젝트·현재 판·단계별 status/round/할 일 수/미답 질문 수/stale.
  - `stage_digest`: 항목별 제목·상태·요약 첫 줄·수치·충돌·신뢰도·출처 수/원문 수·연결.
  - `item_detail`: 현재 버전 + 출처 + 수치 + 연결 + 검증.
  - `question_inbox`: 열린 질문·중요도·기본값·마감·답 상태.
  - `changes_since(seq)`: 변경 로그.
- API는 `GET /projects/{id}/summary`, `GET /stages/{stage}/digest`, `GET /items/{id}`, `GET /questions?status=open`, `GET /changes?since=`, `GET /runs/{id}/context`로 나눈다.
- `If-Match`는 행 `rev`(항목/질문) 또는 `project.rev`(전체). 목록은 `limit`/`cursor`.
- 이유: 지금 `digest`/`show`가 토큰 절약의 핵심이다(`scripts/pes.py:587-640`). DB에서도 같은 원칙을 유지해야 API가 `project.json` 전체를 밀어 넣는 실수를 막는다.

---

### 3.20 방식 A/B 차이 — P0

**정할 것**
- A(내부 OpenCode Go, DeepSeek 하나로 6단계)와 B(Claude Code·Claude 앱)가 DB에 주는 차이.
- 공통 테이블과 모드 전용 필드의 경계.
- A의 실행 이벤트·권한·비용을 어디에 둘 것인가.
- B가 실행 이벤트를 안 보낼 때의 기본값.

**선택지**
1. A/B별로 테이블·API를 나눈다.
2. **같은 테이블, `run.mode`·`actor.kind`·`execution_event`로 구분한다.**
3. OpenCode 세션/메시지를 PES의 기본 모델로 삼는다.

**판단 기준**
- 같은 프로젝트를 A→B 또는 B→A로 이어갈 수 있는가.
- 공급자 변경이 자료 형식을 바꾸지 않는가.
- B의 TUI가 보내지 않는 정보를 필수로 요구하지 않는가.
- A의 권한·비용·중단을 충분히 기록하는가.

**추천: 2번.**
- A: `actor.kind='agent_internal'`, `agent_name='pes-internal'`, `provider='opencode-go'`, `model='deepseek-v4.1-flash'`(사용자 결정 7-2, `stage-0.md:88`). `run.mode='internal_opencode'`, `external_ref_json`에 OpenCode 세션 ID. `execution_event`에 권한·도구·비용을 남긴다. 자료 전송 정책을 강제한다.
- B: `actor.kind='agent_external'`, `agent_name='claude-code'|'claude-app'`, `provider='anthropic'`, 모델은 run마다 다를 수 있다. `run.mode='external_tui'|'external_app'`. `execution_event`는 선택(보내면 기록, 안 보내면 빈 상태).
- 공통: 질문·답·항목·버전·첨언·결정·결과물은 같은 표. A가 만든 질문과 B가 만든 질문이 같은 `question`에 쌓인다. A의 OpenCode form/permission은 연구 질문이 아니라 `execution_event(kind='permission_*'/'message')`로 둔다(`stage-0-opencode.md:880-899`).
- A는 `waiting_human` 상태에서 lease heartbeat를 유지하고, B는 TUI가 닫히면 heartbeat가 끊겨 lease가 만료된다. 같은 `lease` 규칙을 쓴다.
- 금지: `mode_a_*`/`mode_b_*` 테이블, `if mode == A` 분기가 리포지토리 곳곳에 퍼지는 것, B에 A의 이벤트를 강제하는 것.
- 이유: 브리프의 목표는 "같은 데이터 모델과 같은 API"(`00-brief.md:39`)다. 모드별 표를 만들면 같은 프로젝트를 이어갈 때 데이터 변환이 필요해진다.

---

### 3.21 보존·삭제·프라이버시 — P1

**정할 것**
- 삭제 정책(soft delete/GC/영구 보존).
- 첨부·원문·스크린샷 보관 기간.
- 민감 자료 표시와 접근 제어.
- 공개 저장소·fixture·로그에 실자료를 넣지 않는 규칙.
- 사용자 요청 시 프로젝트 전체 삭제.

**선택지**
1. 모든 것을 영구 보존한다. 저장량·프라이버시 부담이 커진다.
2. **soft delete + 명시적 GC + 프로젝트 단위 삭제/내보내기.**
3. 행을 바로 지운다. 이력·감사가 깨진다.

**판단 기준**
- 사용자가 "지워 달라"고 할 때 완전히 지울 수 있는가.
- 실수로 지운 것을 되살릴 수 있는가.
- 감사 로그·버전 참조가 깨지지 않는가.
- 공개 저장소에 민감 자료가 들어가지 않는가.

**추천: 2번.**
- 업무 행은 `archived_at`/`status='archived'`로 숨기고, `change_log`는 삭제하지 않는다. GC는 참조가 없는 `storage_object`만, 사용자 확인 후 실행한다.
- 프로젝트 삭제는 `project.status='deleted'` + object GC + 선택적 `hard_delete`(관리자/사용자 확인). 5단계 웹에서는 계정 삭제와 함께.
- 민감 자료: `source.untrusted`, `artifact_version.untrusted`, `annotation_message.untrusted` 플래그로 외부 유래 콘텐츠를 표시한다(WebMCP의 `untrustedContentHint`, `webmcp.md:7`). 프롬프트 주입 방지에 쓴다.
- 공개 저장소: `tests/fixtures`는 합성만, 로그·프롬프트·키는 커밋 금지(`stage-0.md:31`, `stage-0.md:87`).
- 이유: 연구 자료는 비공개·민감하고, 한 번 외부로 보내면 되돌릴 수 없다. 삭제·보존 정책은 DB 설계에 처음부터 있어야 한다.

---

### 3.22 테스트·완료 기준·이슈 분해 — P0

**정할 것**
- 스키마·마이그레이션·이전을 무엇으로 검증하는가.
- 1단계 설계 완료와 2단계 착수의 경계.
- 2단계 구현을 PR 단위 이슈로 몇 개로 쪼갤 것인가.
- Linear 260개 한도 안에서 단계별로 얼마를 배분할 것인가.

**선택지**
1. 설계 문서만 쓰고 검증은 2단계로 미룬다.
2. **DDL을 SQLite에서 실제로 돌려 보고, D1 호환 메모·이전 dry-run·계약 테스트까지 1단계에 포함한다.**
3. 2단계 구현까지 1단계에 넣는다.

**판단 기준**
- 설계가 실제 SQL로 성립하는가.
- 이전이 실제 프로젝트 사본에서 되는가.
- 2단계 이슈가 PR 단위로 쪼개지는가.
- 1단계가 2단계를 잠식하지 않는가.

**추천: 2번.** 상세 기준은 9절.
- 1단계에서는 **SQLite에서 DDL·대표 쿼리·이전 dry-run**까지 확인한다. D1은 호환 표·스파이크 목록까지만.
- 2단계 이슈는 40~52개(기준 46)로 추정한다. 각 이슈는 한 PR, 테스트 포함.
- 이유: 0단계에서 `baseline.md`·`schemas/project-v0.15.json`을 만들었으므로(`stage-0.md:62`), 1단계에서 SQL까지 검증하면 2단계의 재작업을 크게 줄인다. 반대로 2단계 구현을 1단계에 넣으면 설계가 끝나지 않는다.

---

## 4. 테이블 초안

> 아래는 **초안**이다. 실제 DDL은 2단계에서 마이그레이션 파일로 만들고, SQLite에서 먼저 검증한 뒤 D1 호환을 확인한다. 표 이름은 예약어 충돌을 피하기 위해 `stage_round`, `app_user`, `storage_object`, `tx`를 쓴다.

### 4.0 공통 규칙

| 규칙 | 내용 | 이유 |
|---|---|---|
| ID | 업무 PK는 `TEXT` ULID, 사람 번호는 `short_no`/`seq_no` | 정렬·가져오기·URL·대화 번호 |
| 시간 | `TEXT` ISO 8601 UTC, 앱이 생성 | SQLite/D1 함수 차이 회피, 타임존 혼란 방지 |
| 불리언 | `INTEGER 0/1` | SQLite/D1 공통 |
| JSON | `TEXT` + 앱 검증, 핵심 조회 열은 정규화 | D1 JSON 함수 의존 최소화 |
| `project_id` | 모든 업무 표에 둔다 | 한 DB에 여러 프로젝트, 격리·인덱스·내보내기 |
| `rev` | 변경 가능한 행에 `INTEGER NOT NULL DEFAULT 1` | 낙관적 동시성 `If-Match` |
| soft delete | `archived_at`/`status` | 이력·감사 보존 |
| 금액·토큰 | `INTEGER`/`REAL` | 비용 집계 |
| 비밀 | 토큰은 해시만, 원문 금지 | 공개 저장소·로그 |

> **DDL 순서 주의**: 아래 SQL 조각은 읽기 쉽게 영역별로 묶은 것이다. 실제 `001_init.sql`은 의존성 순서(`actor`/`app_user` → `project` → `edition` → `stage` → `stage_round` → `storage_object` → `item` …)로 정렬한다. `current_version_id`·`resolved_by_message_id`처럼 순환 참조가 있는 열은 **생성 시 NULL로 넣고 버전/메시지를 만든 뒤 UPDATE**하거나 FK를 생략한다. `source_thread_id`/`run_id`/`object_id`처럼 뒤에 정의되는 표를 가리키는 FK도 같은 이유로 실제 DDL에서 순서를 조정한다.
>
> **전부를 2단계에 만들지는 않는다**: 58개 표는 설계의 전체 그림이다. 2단계 핵심은 4.1~4.12이고, `source_asset`·`edit_proposal`은 3~4단계, `project_member`의 다중 사용자 부분은 5단계로 미룰 수 있다. 표를 미리 두는 이유는 나중에 마이그레이션을 다시 하지 않기 위해서다.
>
> **구문 검증**: 이 문서의 `CREATE TABLE` 58개와 인덱스 4개는 SQLite 메모리 DB에서 구문 검증했다(2026-11-04). 데이터 이전·제약·D1 호환은 2단계에서 검증한다.

### 4.1 프로젝트 → 판 → 단계 → 라운드

```sql
-- 프로젝트: 불변 ID + 표시용 slug
CREATE TABLE project (
  id                 TEXT PRIMARY KEY,              -- ULID
  slug               TEXT NOT NULL UNIQUE,          -- URL·대화용
  title              TEXT NOT NULL,                 -- 기존 topic
  status             TEXT NOT NULL DEFAULT 'active',-- active|paused|complete|archived|deleted
  schema_version     INTEGER NOT NULL DEFAULT 1,
  legacy_pes         TEXT,                          -- '0.15.6'
  legacy_slug        TEXT,
  current_edition_id TEXT,
  current_stage_key  TEXT,                          -- plan|research|… (기존 project.current)
  synthetic          INTEGER NOT NULL DEFAULT 0,    -- 합성/시험 자료
  legacy_json        TEXT,                          -- 미문서 필드 보존
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  rev                INTEGER NOT NULL DEFAULT 1,
  archived_at        TEXT
);

-- 판(edition): 같은 프로젝트 안의 1판·2판·3판
CREATE TABLE edition (
  id                   TEXT PRIMARY KEY,
  project_id           TEXT NOT NULL REFERENCES project(id),
  edition_no           INTEGER NOT NULL,            -- 1,2,3…
  title                TEXT,
  status               TEXT NOT NULL DEFAULT 'active', -- planned|active|paused|closed|archived
  based_on_edition_id  TEXT REFERENCES edition(id),
  goal_md              TEXT,
  started_at           TEXT,
  closed_at            TEXT,
  created_at           TEXT NOT NULL,
  created_by           TEXT NOT NULL REFERENCES actor(id),
  rev                  INTEGER NOT NULL DEFAULT 1,
  UNIQUE(project_id, edition_no)
);
-- 활성 판 1개: 부분 인덱스가 D1에서 안 되면 active_edition 포인터 표로 대체
CREATE UNIQUE INDEX ux_edition_active ON edition(project_id) WHERE status = 'active';

-- 단계: 판마다 6개
CREATE TABLE stage (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES project(id),
  edition_id        TEXT NOT NULL REFERENCES edition(id),
  stage_key         TEXT NOT NULL,                  -- plan|research|analyze|write|verify|publish
  status            TEXT NOT NULL DEFAULT 'pending',-- pending|asking|active|approved
  current_round     INTEGER NOT NULL DEFAULT 0,     -- projection of max(stage_round.round_no)
  summary_md        TEXT NOT NULL DEFAULT '',
  approved_at       TEXT,
  stale             INTEGER NOT NULL DEFAULT 0,
  reports_built_at  TEXT,
  legacy_json       TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  rev               INTEGER NOT NULL DEFAULT 1,
  UNIQUE(edition_id, stage_key)
);

-- 라운드: 정수 하나가 아니라 1급 행
CREATE TABLE stage_round (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES project(id),
  edition_id          TEXT NOT NULL REFERENCES edition(id),
  stage_id            TEXT NOT NULL REFERENCES stage(id),
  stage_key           TEXT NOT NULL,                -- denormalized immutable
  round_no            INTEGER NOT NULL,
  status              TEXT NOT NULL DEFAULT 'planned', -- planned|running|review|qa|waiting_human|approved|reopened|cancelled
  started_at          TEXT,
  ended_at            TEXT,
  review_summary_md   TEXT,
  qa_verdict           TEXT,                        -- pass|conditional|fail
  snapshot_version_id TEXT,                         -- artifact_version
  history_text        TEXT,                         -- 기존 history 한 줄
  created_at          TEXT NOT NULL,
  created_by          TEXT REFERENCES actor(id),
  rev                 INTEGER NOT NULL DEFAULT 1,
  UNIQUE(edition_id, stage_key, round_no)
);

-- 라운드 변경점: 기존 changes ["라벨: 내용", …]
CREATE TABLE round_change (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  round_id    TEXT NOT NULL REFERENCES stage_round(id),
  order_no    INTEGER NOT NULL,
  label       TEXT NOT NULL,
  body_md     TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  created_by  TEXT REFERENCES actor(id),
  UNIQUE(round_id, order_no)
);
```

**이유**
- `stage.current_round`는 화면·CLI가 빠르게 읽기 위한 projection이고, 실제 라운드는 `stage_round` 행이다. 지금은 `stages.<stage>.round` 정수와 `snapshots/` 파일이 흩어져 있다(`scripts/pes.py:290-305`, `:400-408`).
- `edition`을 별도 표로 두면 2판이 1판의 단계·항목을 섞지 않고, `based_on_edition_id`로 참조할 수 있다. 브리프의 판 요구(`00-brief.md:16`)를 데이터로 표현한다.
- `round_change`는 지금 `changes` 문자열 배열을 그대로 옮긴다. 대시보드 팝업의 "라벨/내용" 두 칸을 유지한다(`skills/core/SKILL.md:118`).

### 4.2 설정·정책

```sql
CREATE TABLE setting (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES project(id),
  scope_kind  TEXT NOT NULL,          -- project|edition|stage
  scope_id    TEXT NOT NULL,
  setting_key TEXT NOT NULL,
  value_json  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  updated_by  TEXT REFERENCES actor(id),
  rev         INTEGER NOT NULL DEFAULT 1,
  UNIQUE(project_id, scope_kind, scope_id, setting_key)
);

CREATE TABLE project_policy (
  project_id  TEXT NOT NULL REFERENCES project(id),
  policy_key  TEXT NOT NULL,          -- 'ai_egress.opencode_go'
  allowed     INTEGER NOT NULL DEFAULT 0,
  value_json  TEXT NOT NULL DEFAULT '{}',
  set_by      TEXT REFERENCES actor(id),
  set_at      TEXT NOT NULL,
  note        TEXT,
  rev         INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(project_id, policy_key)
);
```

**이유**
- `settings`는 `project`/`stage` 양쪽에 있고, `review_r1`처럼 중첩 JSON도 있다(실측). `scope_kind/scope_id/key`면 한 표로 모두 담고, 키 단위로 조회·감사할 수 있다.
- `project_policy`를 분리하는 이유는 7절. 일반 설정과 자료 전송 동의를 섞지 않는다.

### 4.3 항목·내용·출처·연결

```sql
-- 항목 현재값: 식별·상태·번호·현재 버전 포인터
CREATE TABLE item (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES project(id),
  edition_id         TEXT NOT NULL REFERENCES edition(id),
  stage_id           TEXT NOT NULL REFERENCES stage(id),
  stage_key          TEXT NOT NULL,
  seq_no             INTEGER NOT NULL,              -- 단계별 #1, #2…
  kind               TEXT NOT NULL DEFAULT '',      -- rq|chapter|topic|issue|table|insight|section|claim|output|schedule
  title              TEXT NOT NULL,
  question           TEXT NOT NULL DEFAULT '',
  status             TEXT NOT NULL DEFAULT 'new',   -- new|deepen|revise|browser|done|removed|failed
  request            TEXT NOT NULL DEFAULT '',
  depth              INTEGER NOT NULL DEFAULT 0,
  updated_round      INTEGER NOT NULL DEFAULT 0,
  confidence         TEXT,
  verdict            TEXT,
  order_no           INTEGER,
  path               TEXT,
  current_version_id TEXT,                          -- item_version
  meta_json          TEXT NOT NULL DEFAULT '{}',    -- edit_log/fixed_r2/reuse_all 등
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  rev                INTEGER NOT NULL DEFAULT 1,
  UNIQUE(edition_id, stage_key, seq_no)
);

-- 내용 버전: merge/수정마다 새 행
CREATE TABLE item_version (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES project(id),
  item_id         TEXT NOT NULL REFERENCES item(id),
  version_no      INTEGER NOT NULL,
  title           TEXT NOT NULL,
  question        TEXT NOT NULL DEFAULT '',
  summary_md      TEXT NOT NULL DEFAULT '',
  details_md      TEXT NOT NULL DEFAULT '',
  confidence      TEXT,
  verdict         TEXT,
  path            TEXT,
  conflicts_json  TEXT NOT NULL DEFAULT '[]',
  verify_json     TEXT NOT NULL DEFAULT 'null',
  meta_json       TEXT NOT NULL DEFAULT '{}',
  content_hash    TEXT NOT NULL,
  source_round_id TEXT REFERENCES stage_round(id),
  created_at      TEXT NOT NULL,
  created_by      TEXT REFERENCES actor(id),
  run_id          TEXT REFERENCES run(id),
  UNIQUE(item_id, version_no)
);

-- 출처: 프로젝트 전역
CREATE TABLE source (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES project(id),
  dedupe_key      TEXT NOT NULL,                    -- 정규화 URL 또는 'title:...'
  canonical_url   TEXT,
  title           TEXT NOT NULL DEFAULT '',
  publisher       TEXT,
  published_at    TEXT,
  first_seen_at   TEXT NOT NULL,
  last_checked_at TEXT,
  content_hash    TEXT,
  untrusted       INTEGER NOT NULL DEFAULT 0,
  metadata_json   TEXT NOT NULL DEFAULT '{}',
  created_by      TEXT REFERENCES actor(id),
  rev             INTEGER NOT NULL DEFAULT 1,
  UNIQUE(project_id, dedupe_key)
);

-- 항목별 출처 맥락
CREATE TABLE item_source (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES project(id),
  item_version_id TEXT NOT NULL REFERENCES item_version(id),
  source_id       TEXT NOT NULL REFERENCES source(id),
  role            TEXT NOT NULL DEFAULT 'evidence', -- evidence|background|user
  method          TEXT NOT NULL,                    -- search|fetch|browser|kosis|law|vworld
  quote           TEXT,
  locator         TEXT,
  note            TEXT,
  verified        INTEGER NOT NULL DEFAULT 0,
  verified_at     TEXT,
  verified_by     TEXT REFERENCES actor(id),
  order_no        INTEGER NOT NULL DEFAULT 0,
  UNIQUE(item_version_id, source_id, role)
);

CREATE TABLE stat (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL,
  item_version_id TEXT NOT NULL REFERENCES item_version(id),
  name            TEXT NOT NULL,
  value           TEXT,
  unit            TEXT,
  period          TEXT,
  org_id          TEXT,
  table_id        TEXT,
  method          TEXT,
  note            TEXT,
  order_no        INTEGER NOT NULL DEFAULT 0
);

-- 항목 연결: plan/research/library/evidence…
CREATE TABLE item_link (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL,
  from_item_id TEXT NOT NULL REFERENCES item(id),
  to_kind      TEXT NOT NULL,                       -- item|library_item|decision|annotation|source
  to_id        TEXT NOT NULL,
  relation     TEXT NOT NULL,                       -- plan|research|reuse|evidence|created_from…
  order_no     INTEGER NOT NULL DEFAULT 0,
  UNIQUE(from_item_id, to_kind, to_id, relation)
);

CREATE TABLE user_link (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  item_id     TEXT NOT NULL REFERENCES item(id),
  url_or_path TEXT NOT NULL,
  memo        TEXT,
  status      TEXT NOT NULL DEFAULT 'todo',          -- todo|done|failed
  added_at    TEXT NOT NULL,
  added_by    TEXT REFERENCES actor(id),
  checked_at  TEXT,
  note        TEXT
);

CREATE TABLE item_asset (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL,
  item_version_id TEXT NOT NULL REFERENCES item_version(id),
  object_id       TEXT NOT NULL REFERENCES storage_object(id),
  caption         TEXT,
  order_no        INTEGER NOT NULL DEFAULT 0
);

-- 출처 원문·스크린샷 보관(선택)
CREATE TABLE source_asset (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  source_id   TEXT NOT NULL REFERENCES source(id),
  object_id   TEXT NOT NULL REFERENCES storage_object(id),
  kind        TEXT NOT NULL,                        -- html|pdf|screenshot|text
  caption     TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE note (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  stage_key  TEXT,
  body_md    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT REFERENCES actor(id)
);

-- suggestions/warnings: 제안 K, 경고
CREATE TABLE notice (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  edition_id  TEXT REFERENCES edition(id),
  stage_key   TEXT,
  round_no    INTEGER,
  kind        TEXT NOT NULL,                        -- suggestion|warning
  body_md     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open',         -- open|accepted|dismissed
  item_id     TEXT REFERENCES item(id),
  created_at  TEXT NOT NULL,
  created_by  TEXT REFERENCES actor(id),
  resolved_at TEXT,
  resolved_by TEXT REFERENCES actor(id)
);

CREATE TABLE carry_over (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  from_stage  TEXT NOT NULL,
  to_stage    TEXT NOT NULL,
  item_id     TEXT,
  title       TEXT NOT NULL,
  request     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open',         -- open|done|dropped
  created_at  TEXT NOT NULL,
  created_by  TEXT REFERENCES actor(id)
);
```

**이유**
- `item`과 `item_version`을 나누면 "현재 항목"과 "그 항목이 라운드마다 어떻게 바뀌었는지"를 동시에 만족한다. 현재 `merge`는 한 행을 갱신하고 `depth`만 올린다(`scripts/pes.py:360-362`). 새 설계는 버전을 쌓는다.
- `source`를 전역으로 두면 같은 법령·통계를 여러 항목이 써도 한 번만 저장·확인한다. 항목별 `method`·`note`·`quote`는 `item_source`에 남겨 지금의 의미를 보존한다.
- `item_link`는 `links` JSON의 `plan`/`research`/`library`를 관계 표로 푼다. 지금은 `links`가 `{stage: [ids]}` 형태다(`skills/core/SKILL.md:83`).
- `notice`는 `suggestions`/`warnings`를, `carry_over`는 승인 시 남은 일을 옮긴다(`skills/core/SKILL.md:133`). `note`는 인계 메모다(`scripts/pes.py:643-648`).
- `meta_json`은 미문서 필드 보존용이다. 실제 프로젝트의 `edit_log`, `fixed_r2`, `reuse_all`, `model`, `pages`를 버리지 않는다.

### 4.4 검토(QA)·참고자료

```sql
-- 독립 검토(QC/QA): 한 라운드에 여러 번 가능
CREATE TABLE qa_review (
  id                        TEXT PRIMARY KEY,
  project_id                TEXT NOT NULL,
  edition_id                TEXT NOT NULL REFERENCES edition(id),
  stage_key                 TEXT NOT NULL,
  round_no                  INTEGER NOT NULL,
  review_no                 INTEGER NOT NULL DEFAULT 1,
  reviewer_actor_id         TEXT REFERENCES actor(id),
  verdict                   TEXT NOT NULL,          -- pass|conditional|fail
  summary_md                TEXT NOT NULL,
  missed_by_self_review_json TEXT NOT NULL DEFAULT '[]',
  evidence_gaps_json        TEXT NOT NULL DEFAULT '[]',
  spot_checks_json          TEXT NOT NULL DEFAULT '[]',
  raw_json                  TEXT NOT NULL DEFAULT '{}',
  recorded_at               TEXT NOT NULL,
  UNIQUE(edition_id, stage_key, round_no, review_no)
);

CREATE TABLE qa_finding (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL,
  qa_review_id     TEXT NOT NULL REFERENCES qa_review(id),
  kind             TEXT NOT NULL,                   -- qc|qa
  item_id          TEXT REFERENCES item(id),
  severity         TEXT NOT NULL,                   -- high|medium|low
  finding_md       TEXT NOT NULL,
  evidence_md      TEXT,
  recommendation_md TEXT,
  order_no         INTEGER NOT NULL DEFAULT 0
);

-- research-loop 가져오기
CREATE TABLE library_import (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES project(id),
  source_path    TEXT NOT NULL,
  source_version TEXT,
  topic          TEXT,
  source_round   INTEGER,
  imported_at    TEXT NOT NULL,
  imported_by    TEXT REFERENCES actor(id),
  raw_object_id  TEXT REFERENCES storage_object(id)  -- state.json 원본
);

CREATE TABLE library_item (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  import_id   TEXT NOT NULL REFERENCES library_import(id),
  seq_no      INTEGER NOT NULL,
  title       TEXT NOT NULL,
  summary_md  TEXT,
  details_md  TEXT,
  confidence  TEXT,
  status      TEXT,
  raw_json    TEXT NOT NULL DEFAULT '{}',
  UNIQUE(import_id, seq_no)
);

CREATE TABLE library_link (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL,
  item_id         TEXT NOT NULL REFERENCES item(id),
  library_item_id TEXT NOT NULL REFERENCES library_item(id),
  relation        TEXT NOT NULL DEFAULT 'reuse',
  UNIQUE(item_id, library_item_id, relation)
);
```

**이유**
- 현재 `qa` 배열은 `stage`, `round`, `reviewer`, `verdict`, `summary`, `qc[]`, `qa[]`, `spot_checks[]`, `missed_by_self_review[]`, `evidence_gaps[]`를 갖는다(실측). `qa_review` + `qa_finding`으로 나누고, 표본 대조·놓친 것·근거 빈칸은 JSON으로 보존한다.
- `library`는 13개 항목, `raw_json` 353KB(실측). 전부 정규화하지 않고 `library_item` 요약 + `raw_json`으로 두고, `item_link`/`library_link`로 재사용을 연결한다. 지금 `handoff_plan`이 `reuse` id로 항목을 복사한다(`scripts/pes.py:470-493`).

### 4.5 질문·답

```sql
CREATE TABLE question (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES project(id),
  edition_id         TEXT NOT NULL REFERENCES edition(id),
  stage_id           TEXT NOT NULL REFERENCES stage(id),
  stage_key          TEXT NOT NULL,
  round_no           INTEGER NOT NULL,
  short_no           INTEGER NOT NULL,              -- Q-12
  direction          TEXT NOT NULL,                 -- ai_to_human|human_to_ai
  origin             TEXT NOT NULL,                 -- bank|review|agent|human|browser_agent|legacy_feedback
  origin_ref         TEXT,                          -- bank id / gap id / run id
  asked_by_actor_id  TEXT NOT NULL REFERENCES actor(id),
  assigned_to_actor_id TEXT REFERENCES actor(id),
  run_id             TEXT REFERENCES run(id),       -- AI가 만든 질문이면 실행 연결
  status             TEXT NOT NULL DEFAULT 'open',  -- draft|open|answered|deferred|merged|closed
  importance         TEXT NOT NULL DEFAULT 'normal',-- high|normal|low
  default_value_json TEXT NOT NULL DEFAULT 'null',
  required           INTEGER NOT NULL DEFAULT 0,
  type               TEXT NOT NULL,                 -- single|multi|text|textarea|number|scale|file
  original_text      TEXT NOT NULL,                 -- 최초 문구(불변)
  current_version_id TEXT,                          -- question_version (생성 시 NULL → 버전 후 UPDATE)
  merged_into_question_id TEXT REFERENCES question(id),
  defer_until_round  INTEGER,
  defer_condition_json TEXT NOT NULL DEFAULT 'null',
  meta_json          TEXT NOT NULL DEFAULT '{}',    -- 이전·미문서 필드 보존
  closed_at          TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  rev                INTEGER NOT NULL DEFAULT 1,
  UNIQUE(project_id, short_no)
);

CREATE TABLE question_version (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL,
  question_id         TEXT NOT NULL REFERENCES question(id),
  version_no          INTEGER NOT NULL,
  label               TEXT NOT NULL,
  body_md             TEXT,
  help_md             TEXT,
  type                TEXT NOT NULL,
  required            INTEGER NOT NULL DEFAULT 0,
  importance          TEXT NOT NULL DEFAULT 'normal',
  default_value_json  TEXT NOT NULL DEFAULT 'null',
  show_if_json        TEXT NOT NULL DEFAULT 'null',
  edited_by_actor_id  TEXT REFERENCES actor(id),
  edit_reason         TEXT,
  created_at          TEXT NOT NULL,
  UNIQUE(question_id, version_no)
);

CREATE TABLE question_option (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL,
  question_version_id TEXT NOT NULL REFERENCES question_version(id),
  value               TEXT NOT NULL,
  label               TEXT NOT NULL,
  desc_md             TEXT,
  recommended         INTEGER NOT NULL DEFAULT 0,
  order_no            INTEGER NOT NULL DEFAULT 0,
  UNIQUE(question_version_id, value)
);

CREATE TABLE answer (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL,
  question_id         TEXT NOT NULL REFERENCES question(id),
  question_version_id TEXT NOT NULL REFERENCES question_version(id),
  answerer_actor_id   TEXT NOT NULL REFERENCES actor(id),
  run_id              TEXT REFERENCES run(id),       -- AI가 답한 경우 실행 연결
  value_json          TEXT NOT NULL DEFAULT 'null',
  other_text          TEXT,                         -- 기존 __other
  comment_md          TEXT,                         -- 질문별 의견
  channel             TEXT NOT NULL,                -- web|chat|api|import
  status              TEXT NOT NULL DEFAULT 'submitted', -- draft|submitted|superseded|stale|rejected
  supersedes_answer_id TEXT REFERENCES answer(id),
  idempotency_key     TEXT,
  submitted_at        TEXT,
  processed_at        TEXT,
  meta_json           TEXT NOT NULL DEFAULT '{}',   -- 기존 feedback text/kind 등 보존
  created_at          TEXT NOT NULL,
  rev                 INTEGER NOT NULL DEFAULT 1,
  UNIQUE(project_id, idempotency_key)
);

CREATE TABLE answer_option (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL,
  answer_id           TEXT NOT NULL REFERENCES answer(id),
  question_option_id  TEXT REFERENCES question_option(id),
  value               TEXT NOT NULL
);
```

**이유**
- `question.original_text` + `question_version` + `answer.question_version_id`가 이 설계의 핵심이다. 질문을 고쳐도 옛 답은 옛 버전에 묶이고, 새 버전에는 새 답을 받는다.
- `direction`/`origin`/`asked_by_actor_id`/`assigned_to_actor_id`로 "AI가 사람에게"와 "사람이 AI에게"를 같은 표에서 다룬다. 지금은 AI→사람만 있다(`skills/core/SKILL.md:114-135`).
- `importance`/`default_value_json`/`required`는 브리프 8-3(`00-brief.md:26`)을 데이터로 만든다. `show_if_json`은 지금 `templates/_questions.html:66-73`의 조건부 표시를 보존한다.
- `answer.other_text`는 `__other`, `comment_md`는 질문별 의견이다. 현재 폼은 둘을 한 칸(`qo`)으로 받지만(`templates/_questions.html:33-48`), DB에서는 의미를 나눠 둔다. 3단계에서 "질문별 의견"을 별도 입력으로 만들 때 그대로 쓴다.
- `status='deferred'` + `defer_until_round`는 Linear Triage의 H(미루기)를 수용한다(`notion-linear.md:94`).

### 4.6 가정·결정·근거

```sql
CREATE TABLE assumption (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL,
  edition_id          TEXT REFERENCES edition(id),
  stage_key           TEXT,
  round_no            INTEGER,
  short_no            INTEGER NOT NULL,             -- A-5
  status              TEXT NOT NULL DEFAULT 'open', -- open|confirmed|corrected|rejected
  current_version_id  TEXT,                         -- 생성 시 NULL → 버전 후 UPDATE
  carried_from_assumption_id TEXT REFERENCES assumption(id),
  created_by          TEXT NOT NULL REFERENCES actor(id),
  confirmed_by        TEXT REFERENCES actor(id),
  resolved_at         TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  rev                 INTEGER NOT NULL DEFAULT 1,
  UNIQUE(project_id, short_no)
);

CREATE TABLE assumption_version (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL,
  assumption_id   TEXT NOT NULL REFERENCES assumption(id),
  version_no      INTEGER NOT NULL,
  statement_md    TEXT NOT NULL,
  rationale_md    TEXT,
  confidence      TEXT,
  created_at      TEXT NOT NULL,
  created_by      TEXT REFERENCES actor(id),
  UNIQUE(assumption_id, version_no)
);

CREATE TABLE decision (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL,
  edition_id            TEXT REFERENCES edition(id), -- NULL = 프로젝트 전체
  scope                 TEXT NOT NULL,               -- project|edition|stage
  stage_key             TEXT,
  short_no              INTEGER NOT NULL,            -- D-3
  title                 TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'proposed', -- proposed|decided|superseded|reopened
  current_version_id    TEXT,                       -- 생성 시 NULL → 버전 후 UPDATE
  decided_by            TEXT REFERENCES actor(id),
  decided_at            TEXT,
  supersedes_decision_id TEXT REFERENCES decision(id),
  carried_from_decision_id TEXT REFERENCES decision(id),
  source_question_id    TEXT REFERENCES question(id),
  source_thread_id      TEXT REFERENCES annotation_thread(id),
  tags_json             TEXT NOT NULL DEFAULT '[]',
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  rev                   INTEGER NOT NULL DEFAULT 1,
  UNIQUE(project_id, short_no)
);

CREATE TABLE decision_version (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL,
  decision_id       TEXT NOT NULL REFERENCES decision(id),
  version_no        INTEGER NOT NULL,
  decision_md       TEXT NOT NULL,
  rationale_md      TEXT,
  alternatives_json TEXT NOT NULL DEFAULT '[]',
  created_at        TEXT NOT NULL,
  created_by        TEXT REFERENCES actor(id),
  UNIQUE(decision_id, version_no)
);

CREATE TABLE evidence_link (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL,
  subject_kind    TEXT NOT NULL,                    -- assumption|decision|item_version|answer|annotation
  subject_id      TEXT NOT NULL,
  source_id       TEXT REFERENCES source(id),
  item_version_id TEXT REFERENCES item_version(id),
  relation        TEXT NOT NULL,                    -- supports|contradicts|context
  quote           TEXT,
  note            TEXT,
  created_at      TEXT NOT NULL,
  created_by      TEXT REFERENCES actor(id)
);
```

**이유**
- 가정과 결정을 독립 표로 두면 "프로젝트 전체 가정 목록", "살아 있는 결정 기록"을 한 쿼리로 만들 수 있다.
- `decision.scope`/`edition_id`/`carried_from_decision_id`가 2판에서 "유지/수정/제외"를 명시한다.
- `evidence_link`는 가정·결정·답·첨언의 근거를 한 표로 모은다. 항목 출처는 `item_source`가 맡고, 판단·결정의 근거는 `evidence_link`가 맡는다.

### 4.7 첨언·대화·결과

```sql
CREATE TABLE annotation_thread (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL,
  edition_id            TEXT REFERENCES edition(id),
  short_no              INTEGER NOT NULL,           -- C-7
  target_kind           TEXT NOT NULL,              -- artifact_version|item_version|question|answer|decision|assumption|message|round|project
  target_id             TEXT NOT NULL,
  target_version_id     TEXT,                       -- 만들 때의 버전
  quote_text            TEXT,                       -- 인용문(있으면)
  context_before        TEXT,
  context_after         TEXT,
  status                TEXT NOT NULL DEFAULT 'open', -- open|resolved|archived
  resolved_by_message_id TEXT REFERENCES annotation_message(id),
  resolution_summary_md TEXT,
  created_by            TEXT NOT NULL REFERENCES actor(id),
  created_at            TEXT NOT NULL,
  resolved_at           TEXT,
  rev                   INTEGER NOT NULL DEFAULT 1,
  UNIQUE(project_id, short_no)
);

CREATE TABLE annotation_anchor (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL,
  thread_id         TEXT NOT NULL REFERENCES annotation_thread(id),
  target_version_id TEXT NOT NULL,
  start_offset      INTEGER,
  end_offset        INTEGER,
  prefix_hash       TEXT,
  suffix_hash       TEXT,
  status            TEXT NOT NULL DEFAULT 'ok',     -- ok|moved|lost|none
  created_at        TEXT NOT NULL
);

CREATE TABLE annotation_message (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL,
  thread_id     TEXT NOT NULL REFERENCES annotation_thread(id),
  reply_to_id   TEXT REFERENCES annotation_message(id),
  body_md       TEXT NOT NULL,
  author_actor_id TEXT NOT NULL REFERENCES actor(id),
  created_at    TEXT NOT NULL,
  edited_at     TEXT,
  deleted_at    TEXT,
  untrusted     INTEGER NOT NULL DEFAULT 0,
  meta_json     TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE annotation_resolution (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL,
  thread_id     TEXT NOT NULL REFERENCES annotation_thread(id),
  outcome_kind  TEXT NOT NULL,                      -- edit_artifact|next_round_task|reopen_stage|close_only
  target_kind   TEXT,
  target_id     TEXT,
  note_md       TEXT,
  created_by    TEXT NOT NULL REFERENCES actor(id),
  created_at    TEXT NOT NULL
);

-- 3~4단계 제안 모드(선택)
CREATE TABLE edit_proposal (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL,
  target_kind       TEXT NOT NULL,                  -- artifact_version|item_version
  target_id         TEXT NOT NULL,
  base_version_id   TEXT,
  proposed_text_md  TEXT,
  patch_json        TEXT,
  status            TEXT NOT NULL DEFAULT 'proposed', -- proposed|accepted|rejected
  created_by        TEXT NOT NULL REFERENCES actor(id),
  decided_by        TEXT REFERENCES actor(id),
  created_at        TEXT NOT NULL,
  decided_at        TEXT
);
```

**이유**
- `annotation_thread`는 "무엇에 대한 대화인가"를, `annotation_message`는 "누가 무슨 말을 했는가"를, `annotation_resolution`은 "그래서 무엇을 했는가"를 맡는다. 한 표에 다 넣으면 버전·위치·결과가 섞인다.
- `annotation_anchor`를 버전별로 두면 원고가 수정돼도 "이 인용문이 새 버전 어디에 있는지"를 다시 계산할 수 있다. `lost`면 사용자에게 "위치를 잃은 첨언"으로 보여 준다.
- `edit_proposal`은 지금 당장 필요하지 않지만, "글 수정" 결과가 곧바로 원본을 덮어쓰지 않게 하는 그릇이다. 3~4단계에서 켠다.

### 4.8 반영 내역

```sql
CREATE TABLE reflection (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL,
  edition_id    TEXT NOT NULL REFERENCES edition(id),
  stage_key     TEXT NOT NULL,
  round_no      INTEGER NOT NULL,
  source_kind   TEXT NOT NULL,                      -- answer|annotation|decision|assumption|qa
  source_id     TEXT NOT NULL,
  disposition   TEXT NOT NULL,                      -- reflected|partially|not_reflected|deferred
  summary_md    TEXT NOT NULL,
  evidence_kind TEXT,                               -- item_version|artifact_version|decision|round
  evidence_id   TEXT,
  status        TEXT NOT NULL DEFAULT 'proposed',   -- proposed|confirmed
  created_by    TEXT REFERENCES actor(id),
  created_at    TEXT NOT NULL
);
```

**이유**
- `changes`(라운드 3~5줄)와 별개로, "어떤 의견이 어떻게 반영됐는지"를 source 단위로 남긴다. 다음 라운드 첫머리에 이 표를 읽어 보여 준다.
- `disposition`은 diff로 자동 판정하지 않는다. AI가 제안하고 사람이 확인할 수 있게 `status`를 둔다.

### 4.9 결과물·객체 저장

```sql
CREATE TABLE artifact (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL,
  edition_id         TEXT REFERENCES edition(id),
  stage_key          TEXT,
  round_no           INTEGER,
  kind               TEXT NOT NULL,                 -- report_md|report_html|eli5|stage_report|final_report|snapshot|export|executive_summary|conclusion
  title              TEXT,
  format             TEXT,                          -- md|html|eli5|docx|hwpx|pdf|web|json
  status             TEXT NOT NULL DEFAULT 'current', -- current|superseded|archived
  current_version_id TEXT,
  created_at         TEXT NOT NULL,
  created_by         TEXT REFERENCES actor(id),
  rev                INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE artifact_version (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL,
  artifact_id       TEXT NOT NULL REFERENCES artifact(id),
  version_no        INTEGER NOT NULL,
  object_id         TEXT REFERENCES storage_object(id),
  inline_text       TEXT,                           -- 작은 텍스트(요약·결론)
  content_hash      TEXT NOT NULL,
  bytes             INTEGER,
  mime              TEXT,
  filename          TEXT,
  base_version_id   TEXT REFERENCES artifact_version(id),
  source_round_id   TEXT REFERENCES stage_round(id),
  untrusted         INTEGER NOT NULL DEFAULT 0,     -- 외부 원문·첨부 유래
  created_at        TEXT NOT NULL,
  created_by        TEXT REFERENCES actor(id),
  run_id            TEXT REFERENCES run(id),
  UNIQUE(artifact_id, version_no)
);

CREATE TABLE artifact_source (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL,
  artifact_version_id TEXT NOT NULL REFERENCES artifact_version(id),
  item_version_id     TEXT REFERENCES item_version(id),
  relation            TEXT NOT NULL DEFAULT 'cites'
);

CREATE TABLE storage_object (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES project(id),
  sha256      TEXT NOT NULL,
  bytes       INTEGER NOT NULL,
  mime        TEXT,
  backend     TEXT NOT NULL,                        -- local|r2
  object_key  TEXT NOT NULL,                        -- objects/<project>/<sha[:2]>/<sha>
  untrusted   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  last_ref_at TEXT,
  UNIQUE(project_id, sha256)
);
```

**이유**
- `artifact`는 "단계 보고서", `artifact_version`은 "그 보고서의 1판·2판"이다. 같은 경로를 덮어쓰지 않고 버전을 쌓는다.
- `storage_object`는 내용 주소(sha256)로 중복을 줄이고, 로컬/R2를 같은 키 규칙으로 쓴다. DB에는 `object_key`만 두어 D1 행 크기를 지킨다.
- `inline_text`는 요약·결론처럼 작은 텍스트를 파일 없이 담기 위한 예외다. 64KB를 넘으면 object로 보낸다.
- `artifact_source`는 "이 보고서가 어떤 항목 버전을 인용했는지"를 남겨, 나중에 항목이 바뀌면 영향받는 보고서를 찾을 수 있게 한다.

### 4.10 사용자·에이전트·토큰

```sql
CREATE TABLE app_user (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE,
  display_name  TEXT NOT NULL,
  auth_provider TEXT,                               -- local|cloudflare|…
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    TEXT NOT NULL
);

CREATE TABLE actor (
  id                  TEXT PRIMARY KEY,
  kind                TEXT NOT NULL,                -- human|agent_internal|agent_external|agent_browser|system
  display_name        TEXT NOT NULL,
  user_id             TEXT REFERENCES app_user(id),
  owner_user_id       TEXT REFERENCES app_user(id),
  on_behalf_of_user_id TEXT REFERENCES app_user(id),
  agent_name          TEXT,                         -- claude-code|codex|opencode|pes-internal
  provider            TEXT,                         -- anthropic|opencode-go|…
  model               TEXT,
  model_version       TEXT,
  via                 TEXT,                         -- web|tui|mcp|api|webmcp|cli|app
  created_at          TEXT NOT NULL,
  last_seen_at        TEXT,
  disabled_at         TEXT
);

CREATE TABLE project_member (
  project_id  TEXT NOT NULL REFERENCES project(id),
  user_id     TEXT NOT NULL REFERENCES app_user(id),
  role        TEXT NOT NULL,                        -- owner|editor|viewer
  created_at  TEXT NOT NULL,
  PRIMARY KEY(project_id, user_id)
);

CREATE TABLE agent_token (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES project(id),
  actor_id      TEXT NOT NULL REFERENCES actor(id),
  token_hash    TEXT NOT NULL,
  scopes_json   TEXT NOT NULL DEFAULT '[]',
  created_at    TEXT NOT NULL,
  expires_at    TEXT,
  revoked_at    TEXT,
  last_used_at  TEXT
);
```

**이유**
- `actor` 하나로 사람·내부 AI·외부 에이전트·브라우저 에이전트를 모두 표현한다. 모든 기록의 `created_by`/`asked_by`/`answered_by`가 이 표를 가리킨다.
- `on_behalf_of_user_id`는 브라우저 에이전트·에이전트 대리 작성을 위한 열이다. Notion `created_by_table`, Linear `onBehalfOf`에 해당한다(`notion-linear.md:46`, `:106`).
- `agent_token`은 해시만 저장한다. 토큰 원문은 발급 시 한 번만 보여 준다.

### 4.11 실행·lease·rev·멱등

```sql
CREATE TABLE run (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES project(id),
  edition_id        TEXT NOT NULL REFERENCES edition(id),
  stage_id          TEXT NOT NULL REFERENCES stage(id),
  stage_key         TEXT NOT NULL,
  round_no          INTEGER NOT NULL,
  actor_id          TEXT NOT NULL REFERENCES actor(id),
  mode              TEXT NOT NULL,                  -- internal_opencode|external_tui|external_app|browser|manual
  status            TEXT NOT NULL DEFAULT 'queued', -- queued|running|waiting_human|completed|failed|cancelled
  model             TEXT,
  provider          TEXT,
  input_tokens      INTEGER NOT NULL DEFAULT 0,
  output_tokens     INTEGER NOT NULL DEFAULT 0,
  cost_usd          REAL NOT NULL DEFAULT 0,
  external_ref_json TEXT NOT NULL DEFAULT '{}',    -- OpenCode/Claude 세션 ID 등
  error_code        TEXT,
  error_message     TEXT,
  parent_run_id     TEXT REFERENCES run(id),
  idempotency_key   TEXT,
  started_at        TEXT,
  ended_at          TEXT,
  created_at        TEXT NOT NULL,
  rev               INTEGER NOT NULL DEFAULT 1,
  UNIQUE(project_id, idempotency_key)
);

CREATE TABLE run_item (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  run_id      TEXT NOT NULL REFERENCES run(id),
  item_id     TEXT NOT NULL REFERENCES item(id),
  attempt     INTEGER NOT NULL DEFAULT 1,
  status      TEXT NOT NULL DEFAULT 'claimed',      -- claimed|working|submitted|failed|skipped
  started_at  TEXT,
  ended_at    TEXT,
  error       TEXT,
  UNIQUE(run_id, item_id, attempt)
);

CREATE TABLE lease (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES project(id),
  run_id       TEXT NOT NULL REFERENCES run(id),
  actor_id     TEXT NOT NULL REFERENCES actor(id),
  acquired_at  TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  released_at  TEXT,
  status       TEXT NOT NULL DEFAULT 'active',      -- active|released|expired
  fence        INTEGER NOT NULL
);
-- 활성 lease 1개. D1이 부분 인덱스를 거부하면 active_lease(project_id PK, lease_id UNIQUE)로 대체
CREATE UNIQUE INDEX ux_lease_active ON lease(project_id) WHERE status = 'active';

CREATE TABLE execution_event (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL,
  run_id       TEXT REFERENCES run(id),
  seq          INTEGER NOT NULL,
  kind         TEXT NOT NULL,                       -- permission_request|permission_reply|tool_call|tool_result|message|status|cost|policy_blocked|error
  payload_json TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  UNIQUE(run_id, seq)
);

CREATE TABLE api_idempotency (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL,
  actor_id        TEXT NOT NULL REFERENCES actor(id),
  idempotency_key TEXT NOT NULL,
  method          TEXT NOT NULL,
  path            TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  response_status INTEGER,
  response_json   TEXT,
  created_at      TEXT NOT NULL,
  expires_at      TEXT,
  UNIQUE(project_id, actor_id, idempotency_key)
);

CREATE TABLE tx (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL,
  actor_id      TEXT NOT NULL REFERENCES actor(id),
  client_tx_id  TEXT,
  status        TEXT NOT NULL DEFAULT 'open',       -- open|committed|rolled_back
  created_at    TEXT NOT NULL,
  committed_at  TEXT,
  UNIQUE(project_id, client_tx_id)
);
```

**이유**
- `run`은 "이번 라운드의 실행"이고, `run_item`은 "이 실행이 맡은 항목"이다. A는 항목별 실행이 많고, B는 라운드 단위 실행이 많을 수 있어 둘 다 필요하다.
- `lease`는 프로젝트 단위 쓰기 소유권이다. 지금 `.pes-lock` TTL 2시간(`scripts/pes.py:117-144`)을 heartbeat 30초/TTL 5분으로 바꾸고, `fence`로 옛 writer를 막는다.
- `execution_event`는 A의 OpenCode 도구·권한·비용을 기록하고, B는 보내는 만큼만 기록한다. 연구 질문(`question`)과 섞지 않는다.
- `api_idempotency`/`tx`는 재전송·중복 반영을 막는다. `client_tx_id`는 Notion/Linear의 트랜잭션 묶음 아이디어를 따른다(`notion-linear.md:160`).

### 4.12 사건 기록

```sql
CREATE TABLE change_log (
  seq               INTEGER PRIMARY KEY,            -- 단조 증가, 삭제 금지
  id                TEXT NOT NULL UNIQUE,           -- ULID
  project_id        TEXT NOT NULL REFERENCES project(id),
  tx_id             TEXT REFERENCES tx(id),
  entity_kind       TEXT NOT NULL,                  -- project|edition|stage|round|item|question|answer|annotation|decision|assumption|artifact|run|policy
  entity_id         TEXT NOT NULL,
  op                TEXT NOT NULL,                  -- create|update|archive|restore|approve|reopen|submit|resolve|policy_blocked
  path              TEXT,                           -- 바뀐 필드 경로
  summary           TEXT,                           -- 사람이 읽는 한 줄
  before_json       TEXT,
  after_json        TEXT,
  before_version_id TEXT,
  after_version_id  TEXT,
  actor_id          TEXT REFERENCES actor(id),
  run_id            TEXT REFERENCES run(id),
  visibility        TEXT NOT NULL DEFAULT 'project',-- project|internal
  created_at        TEXT NOT NULL
);
CREATE INDEX ix_change_project_seq ON change_log(project_id, seq);
CREATE INDEX ix_change_entity ON change_log(entity_kind, entity_id, seq);
```

**이유**
- `seq`가 `GET /changes?since=`의 커서이자 "변경 #123" 번호다. Linear `lastSyncId`, Notion 트랜잭션 로그의 축소판이다(`notion-linear.md:155-164`).
- `before_json/after_json`은 작은 필드용이다. 본문은 `*_version_id`로 가리켜 행 크기를 지킨다.
- `visibility='internal'`은 운영 로그·민감 이벤트를 사용자 화면에서 숨기는 데 쓴다. 감사 자체는 남긴다.

### 4.13 이전·운영

```sql
CREATE TABLE schema_migration (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  checksum   TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE import_run (
  id           TEXT PRIMARY KEY,
  project_id   TEXT REFERENCES project(id),
  source_path  TEXT NOT NULL,
  source_hash  TEXT,
  status       TEXT NOT NULL,                       -- running|verified|switched|failed|rolled_back
  report_json  TEXT,
  backup_path  TEXT,
  started_at   TEXT NOT NULL,
  finished_at  TEXT
);

CREATE TABLE import_issue (
  id            TEXT PRIMARY KEY,
  import_run_id TEXT NOT NULL REFERENCES import_run(id),
  severity      TEXT NOT NULL,                      -- info|warn|error
  entity_kind   TEXT,
  entity_id     TEXT,
  field         TEXT,
  detail        TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
```

**이유**
- `import_run`은 "언제 어떤 원본을 어떤 결과로 옮겼는지"를 남긴다. `backup_path`로 되돌리기 지점을 찾는다.
- `import_issue`는 미문서 필드·누락 파일·ID 충돌을 버리지 않고 기록한다. 이전 검증의 입력이 된다.

### 4.14 관계도

```text
project 1─n edition 1─n stage 1─n stage_round
   │           │          │
   │           ├─n item ──1─n item_version ──n item_source ──1 source
   │           │                 └─n stat
   │           ├─n question ──1─n question_version ──n question_option
   │           │        └─n answer ──n answer_option
   │           ├─n assumption ──1─n assumption_version
   │           ├─n decision ──1─n decision_version
   │           ├─n annotation_thread ──n annotation_anchor
   │           │        ├─n annotation_message
   │           │        └─n annotation_resolution
   │           ├─n reflection
   │           └─n artifact ──1─n artifact_version ──1 storage_object
   │
   ├─n run ──n run_item
   │    ├─n lease
   │    └─n execution_event
   ├─n change_log
   ├─n setting
   ├─n project_policy
   ├─n library_import ──n library_item
   └─n note / notice / carry_over / qa_review

actor 1─n (created_by/asked_by/answered_by/decided_by…)
app_user 1─n actor
```

### 4.15 주요 인덱스

| 인덱스 | 목적 |
|---|---|
| `change_log(project_id, seq)` | 변경 커서·타임라인 |
| `change_log(entity_kind, entity_id, seq)` | 항목·질문 이력 |
| `item(edition_id, stage_key, status)` | 단계별 할 일·항목 목록 |
| `item(project_id, updated_at)` | 최근 활동 |
| `question(project_id, stage_key, round_no, status)` | 라운드 질문함 |
| `question(assigned_to_actor_id, status)` | 내가 답할 질문 |
| `answer(question_id, submitted_at)` | 답 이력 |
| `answer(project_id, idempotency_key)` | 중복 제출 |
| `annotation_thread(target_kind, target_id, status)` | 글·항목별 첨언 |
| `annotation_message(thread_id, created_at)` | 대화 순서 |
| `run(project_id, status)` | 실행 중·대기 |
| `lease(project_id)` unique where active | 쓰기 소유권 |
| `artifact(project_id, kind, stage_key)` | 보고서 목록 |
| `artifact_version(artifact_id, version_no)` | 버전 |
| `source(project_id, dedupe_key)` | 출처 중복 |
| `setting(project_id, scope_kind, scope_id, setting_key)` | 설정 |
| `project_policy(project_id, policy_key)` | 자료 전송 |

---

## 5. 로컬 SQLite와 Cloudflare D1에서 같은 설계로 가는 방법

### 5.1 같은 것

- **같은 스키마 SQL**: `db/migrations/001_init.sql` … 한 벌. 로컬·D1 모두 같은 파일을 적용한다.
- **같은 ID·시간·JSON 규칙**: ULID는 앱 생성, 시간은 ISO 8601 UTC `TEXT`, 불리언은 `INTEGER 0/1`, JSON은 `TEXT`.
- **같은 서비스 계층**: `project_id`를 받는 리포지토리 함수. 로컬은 SQLite 연결, 웹은 D1 바인딩만 바꾼다.
- **같은 change_log**: seq·커서·before/after. 웹 대시보드와 로컬 대시보드가 같은 방식으로 새로고침한다.

### 5.2 다른 것(허용하는 차이)

| 항목 | 로컬 SQLite | Cloudflare D1 |
|---|---|---|
| 위치 | `~/.pes/pes.db` (기기 로컬) | 환경당 D1 1개 |
| 동시성 | WAL + `BEGIN IMMEDIATE` | 요청 단위, 짧은 쓰기 |
| 백업 | `VACUUM INTO`/파일 복사 | D1 export/Time Travel |
| 객체 | 로컬 파일 (`~/.pes/objects/…`) | R2 (`projects/<id>/objects/…`) |
| 인증 | 로컬 세션/토큰 | Cloudflare 로그인/토큰 |
| 마이그레이션 실행 | `pes db migrate` | `wrangler d1 migrations apply` 또는 같은 SQL 실행기 |

### 5.3 D1에서 피할 것

- `AUTOINCREMENT` 대신 `INTEGER PRIMARY KEY`(행 삭제 금지).
- FTS5, 트리거, `ATTACH`, `VACUUM INTO`, `LOAD_EXTENSION`, 복잡한 `PRAGMA`.
- 생성 열·부분 인덱스·표현식 인덱스에 핵심 로직을 의존하지 않는다. 필요하면 포인터 표/앱 검증으로 대체.
- `json_extract`에 핵심 조회를 의존하지 않는다. 핵심 열은 정규화한다.
- 큰 BLOB·긴 `INSERT` 한 문장. 객체는 R2, 대량 이전은 배치.

### 5.4 큰 파일은 R2/로컬 파일로

- `storage_object`가 유일한 포인터다. `sha256`으로 내용 주소를 만들고, 같은 내용은 한 번만 저장한다.
- 로컬 키: `objects/<project_id>/<sha256[:2]>/<sha256>` (예: `~/.pes/objects/01H…/ab/ab12…`).
- R2 키: `projects/<project_id>/objects/<sha256[:2]>/<sha256>`.
- DB에는 `bytes`, `mime`, `backend`, `key`, `content_hash`만. 원문·이미지·PDF·HWPX·스냅숏 JSON은 객체로.
- 웹은 서명 URL(짧은 만료)로 내려준다. 로컬은 `serve.py`가 프로젝트 범위를 확인하고 파일을 준다.
- GC: 참조(`artifact_version`, `item_asset`, `library_import.raw_object_id`)가 없고 `last_ref_at`이 오래된 객체만, 사용자 확인 후 삭제한다.

### 5.5 백업·복구

- 로컬: 쓰기 전 `VACUUM INTO ~/.pes/backups/pes-<ts>.db`, 또는 파일 복사. 마이그레이션 전에는 프로젝트 폴더 전체 사본.
- D1: 정기 export + R2 버전링. 마이그레이션 전 스냅숏 ID를 기록한다.
- 복구: 로컬은 DB 파일 교체, 웹은 D1 import. `schema_migration`으로 버전을 맞춘다.

### 5.6 성능 예산

| 작업 | 예산(2MB/304항목) | 근거 |
|---|---|---|
| 프로젝트 요약 | < 100ms | 인덱스 + 집계 |
| 단계 digest | < 200ms | 항목·출처 수 집계 |
| 대시보드 읽기 모델 | < 500ms | 페이지·인덱스 |
| 변경 커서 100건 | < 50ms | `change_log(project_id,seq)` |
| 프로젝트 이전 | < 30s | 1.76MB + 103 rounds 파일 |
| 보고서 버전 생성 | < 1s | 파일 복사·해시 |

---

## 6. 기존 `project.json` 프로젝트를 옮기는 경로

### 6.1 원칙

1. **원본을 직접 고치지 않는다.** 먼저 폴더 전체를 시각 붙은 사본으로 백업한다.
2. **shadow DB에 먼저 넣는다.** 프로젝트별로 별도 DB 파일/스키마에 이전하고 검증한다.
3. **검증 전에는 전환하지 않는다.** 개수·해시·ID·연결·보고서 재생성이 통과해야 한다.
4. **전환은 프로젝트별로.** 한 번에 모든 프로젝트를 옮기지 않는다.
5. **이중 쓰기하지 않는다.** 전환 후 `project.json`은 읽기 전용 보관. 문제가 있으면 rollback.
6. **모르는 필드는 버리지 않는다.** `legacy_json`/`meta_json`/`import_issue`.

### 6.2 절차

```text
0. 사전 점검
   - PES 버전·plugin.json 확인 (v0.15.6, .claude-plugin/plugin.json:3)
   - 디스크 여유, DB 스키마 버전, 기존 서버 종료
1. 백업
   - <project> → <project>.bak-YYYYMMDD-HHMMSS (폴더 전체)
   - project.json/library.json 해시 기록
2. shadow DB 생성
   - ~/.pes/import/<project_id>/pes.db (또는 임시 D1)
   - schema_migration 적용
3. 가져오기 (의존 순서)
   - project → edition(1) → stage(6) → stage_round
   - item → item_version → source/item_source/stat/item_link/user_link/item_asset
   - question/question_version/question_option → answer/answer_option
   - assumption/decision → evidence_link
   - annotation_thread/anchor/message/resolution
   - artifact/artifact_version/storage_object (reports/out/shots)
   - qa_review/qa_finding, notice, carry_over, note, setting
   - library_import/library_item
   - change_log(가져오기 이벤트), import_run/import_issue
4. 검증
   - 개수: 항목·출처·답·보고서·첨언·질문
   - 해시: 파일 본문 vs storage_object.sha256
   - 연결: links/plan/research/library, answer.question_version_id
   - 화면: 단계 보고서·최종 보고서 1개씩 재생성
   - 상태: status/round/approved_at/stale/complete
5. 전환
   - project.setting('storage_backend') = 'db'
   - project.json은 rename하지 않고 읽기 전용 표시
   - 서버 재시작, 대시보드가 DB 읽기 모델을 사용
6. 유예
   - N일간 rollback 가능. 그 뒤 project.json은 archive로.
```

### 6.3 필드 매핑

| 현재 | 새 위치 | 비고 |
|---|---|---|
| `project.pes` | `project.schema_version`/`legacy_pes` | `"pes":1`은 읽는 곳이 없었다(`scripts/pes.py:206`) |
| `project.topic` | `project.title` | |
| `project.slug`/`created` | `project.slug`/`created_at` | slug는 표시용, ID는 ULID |
| `project.current` | `project.current_stage_key` + 해당 `stage.status` | |
| `project.settings` | `setting(scope=project)` | 중첩 JSON은 `value_json` |
| `project.notes` | `note` | time/stage/text 보존 |
| `project.processed` | `answer.processed_at`/`import_issue` | 파일명 목록 |
| `project.complete` | `project.status='complete'` | |
| `project.executive_summary`/`conclusion` | `artifact(kind=executive_summary/conclusion, inline_text)` | 버전 1 |
| `project.summary_edit_log` | `change_log`/`import_issue` | 보존 |
| `stages.<stage>.status/round` | `stage.status`/`stage.current_round` | |
| `stages.<stage>.settings` | `setting(scope=stage)` | |
| `stages.<stage>.items` | `item`+`item_version` | 현재값 = v1 |
| `stages.<stage>.review` | `question(origin='review')` + `stage_round.review_summary_md` | |
| `stages.<stage>.review_log` | `question` 이력 + `legacy_json` | 과거 점검 |
| `stages.<stage>.qa` | `qa_review`+`qa_finding` | QC/QA/표본/놓친 것 |
| `stages.<stage>.suggestions` | `notice(kind='suggestion')` | |
| `stages.<stage>.warnings` | `notice(kind='warning')` | |
| `stages.<stage>.changes` | `round_change` | 라벨/내용 |
| `stages.<stage>.history` | `stage_round.history_text`/`change_log` | |
| `stages.<stage>.carry_over` | `carry_over` | |
| `stages.<stage>.summary` | `stage.summary_md` | |
| `stages.<stage>.approved_at/stale` | `stage.approved_at/stale` | |
| `stages.<stage>.reports`/`reports_built` | `artifact`/`artifact_version`/`stage.reports_built_at` | |
| `item.id/title/kind/...` | `item`+`item_version` | 미문서 필드는 `meta_json` |
| `item.sources[]` | `source`+`item_source` | URL/dedupe, method/note/quote |
| `item.stats[]` | `stat` | |
| `item.shots[]` | `storage_object`+`item_asset` | |
| `item.links{}` | `item_link` | plan/research/library |
| `item.user_links[]` | `user_link` | |
| `item.verify`/`conflicts` | `item_version.verify_json/conflicts_json` | |
| `library` | `library_import`+`library_item` | `raw_object_id`에 state.json |
| `feedback/*.json` | `answer`+`question(origin='legacy_feedback')` | `answers`, `__other`, `text` 보존 |
| `feedback.log` | `change_log`/`import_issue` | 수신 로그 |
| `ask/*.json` | `question`/`question_version` | 시작 질문 |
| `ask-*.html`/`index.html` | 이전하지 않음 | 재생성 |
| `snapshots/*.json` | `artifact(kind='snapshot')`+`item_version` | 라운드별 상태 |
| `rounds/*.json` | `item_version`+`artifact` | 서브에이전트 원본 |
| `reports/*` | `artifact`+`artifact_version` | 파일 본문은 object |
| `out/*` | `artifact(kind='final_report')` | |
| `shots/*` | `storage_object`+`item_asset` | |
| `.pes-lock` | 버림 | 새 lease |
| `project.json.tmp` | 버림/import_issue | |

**feedback 종류별 처리**
- `stage_start`·`review`·`feedback`·`resume`의 `answers`/`text`는 `answer`로 옮기고, 대응하는 `question`이 없으면 `origin='legacy_feedback'`인 질문을 만들어 붙인다.
- `approve`·`reopen`은 답이 아니라 **단계/라운드 상태 변경**이다. `change_log(op='approve'/'reopen')`와 `stage.approved_at`/`stage_round.status`로 옮기고, `answer`로 만들지 않는다.
- `processed` 파일명 목록은 대응하는 `answer.processed_at`으로 옮긴다. 대응이 없으면 `import_issue`에 남긴다.
- `feedback.log`의 `FEEDBACK <stage> R<n> <kind> <path>`는 `change_log`/`import_issue`에 수신 기록으로 남긴다.

### 6.4 사본·되돌리기

- **사본**: `<project>.bak-YYYYMMDD-HHMMSS`. 원본은 읽기 전용. `import_run.source_hash`에 원본 해시를 남긴다.
- **되돌리기**: `pes migrate --rollback <project>` → `storage_backend='file'`로 바꾸고 원본 폴더를 다시 사용. 전환 후 DB에 새 쓰기가 있으면 먼저 `pes export`로 파일에 반영한 뒤 rollback. rollback 불가능한 시점(유예 종료)을 사용자에게 알린다.
- **검증 실패**: 전환하지 않는다. `import_issue`와 `import_run.report_json`을 보여 주고 원본을 그대로 둔다.
- **충돌 사본**: OneDrive의 `project-<컴퓨터>.json` 등은 자동 병합하지 않는다. `import_issue`에 기록하고 사용자가 최신본을 고른 뒤 다시 이전한다(`README.md:515-521`).
- **부분 이전**: 프로젝트별로만. 단계별 부분 이전은 하지 않는다. 이유: 항목·질문·답·출처의 상호 참조가 많아 부분 이전은 정합성이 깨진다.

### 6.5 검증 합격 기준

- 항목 수·ID·상태·`updated_round`·`depth`가 원본과 대응한다.
- 출처 수·URL/dedupe·method·원문 확인 수가 대응한다.
- 답 수·`answers`/`__other`/`text`/`kind`/`round`/`processed`가 대응한다.
- 보고서·최종 보고서 파일 해시가 원본과 같다.
- 대표 단계 보고서 1개, 최종 보고서 1개를 재생성해 텍스트가 의미상 같다.
- `stage.status`/`round`/`approved_at`/`stale`/`complete`가 같다.
- `import_issue`의 error가 0. warn은 사용자 확인 목록으로.

---

## 7. 프로젝트별 'OpenCode Go에 자료 보내기' 끄기 설정

### 7.1 표현

```sql
-- project_policy
policy_key = 'ai_egress.opencode_go'
allowed    = 0|1
value_json = {"providers":["opencode-go"], "models":["deepseek-v4.1-flash"], "note":"..."}
set_by     = actor_id
set_at     = ISO8601
```

- 프로젝트 단위. 판·단계별로 나누지 않는다(사용자 결정 7-1, `stage-0.md:87`).
- `value_json`에 허용 제공자·모델·범위를 적어, 나중에 `ai_egress.anthropic` 등으로 확장한다.
- `synthetic=1` 프로젝트는 정책과 무관하게 시험할 수 있다(0단계 합성 자료, `stage-0.md:87`).

### 7.2 기본값과 동의

- **추천: 기본 꺼짐 + 최초 1회 명시 동의.**
  - 프로젝트 생성 시 `allowed=0`.
  - 방식 A를 처음 시작할 때 "이 프로젝트의 내용을 OpenCode Go(DeepSeek)로 보냅니다. 계속할까요?"를 묻고, 동의 시 `allowed=1`.
  - 이미 켠 프로젝트는 설정 화면에서 즉시 끌 수 있다.
- 대안: 사용자가 "보내는 방향"을 이미 결정했으므로 기본 켜짐으로 시작하고 눈에 띄는 끄기 스위치를 둔다. 이 경우에도 최초 실행 시 한 번 알린다.
- 이유: 연구 자료는 비공개·민감하고, 한 번 전송되면 되돌릴 수 없다. 기본 꺼짐이 사고를 줄인다. 사용자가 편의를 우선하면 기본 켜짐으로 바꿀 수 있다(9.3절 결정).

### 7.3 강제 지점

1. `POST /runs`에서 `mode='internal_opencode'`이면 `project_policy`를 확인. `allowed=0`이면 403 `policy_blocked`.
2. OpenCode 어댑터가 세션을 만들고 `prompt`를 보내기 직전에 다시 확인. 중간에 꺼졌으면 전송하지 않는다.
3. 재시도·후속 호출·백그라운드 요약도 같은 확인을 한다.
4. `execution_event(kind='policy_blocked')`와 `change_log`에 시도·이유를 남긴다. 단, 민감 본문은 로그에 남기지 않는다.
5. B(Claude Code/Claude 앱)에는 이 정책을 강제하지 않는다. 필요하면 `ai_egress.anthropic`을 별도 키로 추가한다(사용자 결정 7-3, `stage-0.md:89`).

### 7.4 화면·API

- 프로젝트 설정에 "AI 자료 전송" 섹션: 제공자·모델·켜짐/꺼짐·마지막 변경·변경자.
- 끄면 진행 중 A run에 "다음 호출부터 중단" 배너. 강제 종료는 `run.status='cancelled'`.
- API: `GET/PUT /projects/{id}/policies/ai_egress.opencode_go` (owner만).
- 감사: `change_log`에 `policy.updated`(before/after), `project_policy.rev`.

---

## 8. 방식 A/B가 DB에 주는 영향

### 8.1 공통

- 같은 `project/edition/stage/round/item/question/answer/annotation/decision/artifact` 표.
- 같은 `actor`(kind만 다름), 같은 `run`/`lease`/`change_log`.
- 같은 질문·답 API. A가 만든 질문과 B가 만든 질문이 같은 곳에 쌓인다.

### 8.2 차이

| 항목 | 방식 A (PES 내부) | 방식 B (외부 TUI/앱) | DB 처리 |
|---|---|---|---|
| 실행 주체 | `agent_internal`, `pes-internal` | `agent_external`, `claude-code`/`claude-app` | `actor.kind/agent_name` |
| 모델 | DeepSeek 하나로 6단계(`stage-0.md:88`) | Claude Code/앱의 모델, run마다 다름 | `run.model/provider` |
| 실행 단위 | 항목별 run이 많음 | 라운드/세션 단위가 많음 | `run`+`run_item` |
| 진행 이벤트 | OpenCode 이벤트·권한·도구·비용 | TUI가 보내는 만큼(없을 수 있음) | `execution_event`(선택) |
| 권한 | OpenCode permission API | TUI 권한 프롬프트 | `execution_event` kind permission_* |
| 자료 전송 | 프로젝트 정책 강제 | OpenCode Go 정책 대상 아님 | `project_policy` |
| 중단·재개 | `interrupt`·세션 재개 | TUI 종료·재시작 | `run.status`/`lease` |
| 비용 | usage API로 기록 | 선택 | `run.cost_usd/tokens` |
| 질문 | PES 질문 자동 생성/대기 | MCP/CLI로 질문 | 같은 `question` |
| 답 | PES 대시보드/API | PES 대시보드/API | 같은 `answer` |

### 8.3 DB에 주는 결론

- **모드 전용 테이블을 만들지 않는다.** `run.mode`·`actor.kind`·`execution_event.kind`로 충분하다.
- **A의 실행 수준 질문과 PES 연구 질문을 섞지 않는다.** OpenCode form/permission은 `execution_event`, 연구 질문은 `question`이다(`stage-0-opencode.md:880-899`).
- **B가 보내지 않는 정보를 필수로 만들지 않는다.** `execution_event`는 0건이어도 된다. `run.model`은 NULL 허용.
- **A의 비용·토큰은 `run`에, 도구 단위는 `execution_event`에.** B는 선택.
- **A의 자료 전송 정책은 `run` 생성 전에 강제.** B는 별도 정책 키가 생기기 전까지 강제하지 않는다.
- **A→B/B→A 전환**: 같은 프로젝트·판·단계·항목을 그대로 이어받는다. 다른 것은 `run` 기록과 `actor`뿐이다.

---

## 9. 완료 기준·사용자 결정·2단계 이슈 수

### 9.1 1단계 DB 설계 완료 기준

| # | 기준 | 확인 방법 |
|---|---|---|
| 1 | 4절의 모든 영역(프로젝트→판→단계→라운드, 항목·버전, 질문·답, 가정, 결정, 첨언, 반영, 출처, 결과물, 사용자·에이전트, 실행·lease·rev, 사건 기록)에 표·키·관계가 있다 | 이 문서 + 리뷰 |
| 2 | DDL이 SQLite에서 실제로 실행된다 | 임시 DB에서 `001_init.sql` 실행 |
| 3 | 대표 쿼리(요약·digest·질문함·변경 커서·항목 상세)가 인덱스를 탄다 | `EXPLAIN QUERY PLAN` |
| 4 | 실제 프로젝트 사본 1개를 dry-run 이전하고 검증한다 | `import_run.report_json` |
| 5 | 이전 검증 합격 기준(6.5절)을 통과한다 | 개수·해시·재생성 |
| 6 | 되돌리기 절차가 문서·시험으로 있다 | 사본에서 rollback 1회 |
| 7 | D1 호환 표(5.3절)와 스파이크 목록이 있다 | 리뷰 |
| 8 | OpenCode Go 정책의 기본값·강제 지점·감사가 정해졌다 | 7절 |
| 9 | A/B 차이가 DB 분기를 만들지 않는다 | 8절 리뷰 |
| 10 | 2단계 이슈가 PR 단위 40~52개로 쪼개졌다 | 9.4절 |
| 11 | 사용자 결정(9.3절)이 답해졌다 | 사용자 승인 |
| 12 | Claude/Codex 리뷰에서 치명적 반대가 없다 | 리뷰 기록 |

### 9.2 2단계 착수 기준

- `db/migrations/001_init.sql`이 저장소에 있고 SQLite 테스트가 green.
- D1 smoke(또는 최소 호환 lint)가 통과.
- `pes migrate --dry-run`이 실제 프로젝트 사본에서 통과하고, `--rollback`이 동작.
- API v1의 읽기/쓰기 계약과 가짜 A/B 어댑터 계약 테스트가 있다.
- `project.json` 원본 백업·복원 절차가 `AGENTS.md`/`docs/plan`에 있다.
- 공개 저장소에 실자료·키가 없다.

### 9.3 사용자 결정이 필요한 것

| # | 결정 | 선택지 | 내 추천 |
|---|---|---|---|
| 1 | OpenCode Go 전송 기본값 | (a) 기본 켜짐 + 끄기 (b) 기본 꺼짐 + 최초 동의 | **(b)** 사고 방지. 편의 우선이면 (a) |
| 2 | 로컬 DB 위치 | (a) `~/.pes/pes.db` 기기 로컬 (b) PES 홈 안 (c) 프로젝트별 | **(a)** + `pes export`. OneDrive에 live SQLite 금지 |
| 3 | `project.json` 유지 기간 | (a) 전환 즉시 삭제 (b) 읽기 전용 보관 (c) 영구 이중 쓰기 | **(b)**. 이중 쓰기 금지 |
| 4 | 판의 결정·가정 상속 | (a) 자동 공유 (b) 복사 후 유지/수정/제외 (c) 매번 새로 | **(b)**. 2판에서 "무엇을 뺐나"가 남는다 |
| 5 | 답한 질문을 고칠 때 | (a) 기존 답 유지·stale (b) 답 삭제 (c) 질문 수정 금지 | **(a)**. 원문·답 버전 보존 |
| 6 | 답 수정 | (a) 덮어쓰기 (b) 새 답 + supersedes (c) 수정 금지 | **(b)** |
| 7 | 첨언 위치를 잃었을 때 | (a) 삭제 (b) `lost`로 보존 (c) 첫 문단으로 이동 | **(b)**. 인용문은 남긴다 |
| 8 | 과거 결과물 보존 | (a) 최신만 (b) 모든 버전 (c) 최근 N개 | **(b)**. 공유·인쇄본 보존 |
| 9 | 출처 원문 저장 | (a) 링크만 (b) 원문 텍스트 (c) 원문+스크린샷 | **(c)**는 비용·저작권 확인. 최소 (b) |
| 10 | B의 자료 전송 정책 | (a) OpenCode Go만 (b) Anthropic도 별도 키 | **(a)**로 시작, 5단계에서 (b) |
| 11 | 인증 시점 | (a) 2단계 로컬 토큰 (b) 5단계까지 없음 | **(a)**. API가 열리는 순간 필요 |
| 12 | 이슈 예산 | (a) 2단계 40~52 (b) 더 잘게 (c) 더 굵게 | **(a)**. PR 단위 유지 |

### 9.4 2단계 구현 이슈 예상 수

이 문서는 **SEL-21(1단계 DB 설계)**의 의견이며, 아래 수치는 2단계에서 만들 이슈의 **예상**이다. 지금 이슈를 만들지 않는다.

전제: **2단계는 로컬 DB+API+기존 CLI/대시보드 전환**이고, 웹 UI 개편·다중 사용자 로그인·hwpx는 포함하지 않는다. 각 이슈는 **한 PR, 테스트 포함**.

| 묶음 | 이슈 수 | 내용 |
|---|---:|---|
| DB 기반 | 4 | 스키마/마이그레이션, SQLite 연결·WAL·트랜잭션, D1 호환 lint/smoke, 백업·export |
| 핵심 리포지토리 | 9 | project/edition/stage/round, item/version, source/stat/link, question/answer, assumption/decision, annotation/reflection, artifact/object, actor/token, setting/policy |
| 이전 | 4 | importer, verifier, rollback, 실제 사본 시험 |
| API v1 | 5 | context/claim/submit, questions/answers, events/changes, complete/run status, auth/error/idempotency |
| CLI 전환 | 7 | init/ask/round/merge/render, approve/reopen, status/pending/mark, report/assemble/web, digest/show/note, doctor/lock, export/import |
| 로컬 화면·서버 | 4 | dashboard 읽기 모델, 질문 폼/답 API, 허브/목록, 파일·객체 서빙 |
| 방식 A 어댑터 | 3 | OpenCode 세션/프롬프트, 이벤트/권한/중단, 정책·비용 |
| 방식 B 어댑터 | 3 | MCP/CLI 도구, 신원·lease, 기존 파일 호환 |
| 테스트·보안·성능 | 4 | 계약 테스트, 이전 테스트, 성능·인덱스, 경로/토큰/비밀 |
| 운영·문서 | 3 | backup/export/doctor, 관측성/로그, ADR/용어/이전 안내 |
| **합계** | **46** | 범위 40~52 |

- 46개는 "PR 단위" 기준이다. 설계 하위 결정(예: 인덱스 하나, 필드 이름)은 이슈로 만들지 않는다.
- 2단계에서 웹 UI를 같이 하면 +10~15, 다중 사용자 로그인을 같이 하면 +8~12가 붙는다. 2단계 범위를 지키면 46개다.

### 9.5 Linear 260개 예산

| 단계 | 예상 이슈 |
|---|---:|
| 0단계 | 11 (SEL-11~20, 31) |
| 1단계 설계 | 8~12 |
| 2단계 | 46 (40~52) |
| 3단계 | 30 |
| 4단계 | 18 |
| 5단계 | 25 |
| 6단계 | 20 |
| **합계** | **152~168** |

- 260 한도에서 **약 92~108개 여유**가 있다. 설계 변경·버그·보안 이슈를 넣어도 된다.
- 이슈는 PR 단위로만 만들고, 하위 작업은 PR 설명·체크리스트로 둔다. Linear sub-issue를 쓰더라도 "PR 하나 = 이슈 하나" 원칙은 유지한다.

---

## 10. 근거

### 계획·결정
- `docs/plan/00-brief.md:16-32` — 판, 웹+API, 질문, 첨언, 가정, 결정, DB, 한 저장소
- `docs/plan/00-brief.md:35-39` — 방식 A/B, 같은 데이터 모델·API
- `docs/plan/00-brief.md:45` — hwpx 마지막
- `docs/plan/stage-0.md:12-14` — 상태 쓰기 경로가 여러 개, 원칙 0
- `docs/plan/stage-0.md:20-34` — 기준선·테스트·스키마 기준선·보안·A/B 시험
- `docs/plan/stage-0.md:38-42` — API·스키마 계약을 1단계로 넘김
- `docs/plan/stage-0.md:44-49` — A/B 공통 시나리오·역할·차이·용어
- `docs/plan/stage-0.md:62` — `schemas/project-v0.15.json`
- `docs/plan/stage-0.md:85-92` — 사용자 결정 7-1~7-6
- `docs/plan/stage-0.md:94-99` — 1단계 입력(계약 초안·Notion/Linear·WebMCP·정책)

### 조사
- `docs/plan/research/notion-linear.md:38-41` — Notion 트랜잭션·연산
- `docs/plan/research/notion-linear.md:44-49` — discussion/comment, 인용·앵커
- `docs/plan/research/notion-linear.md:64-70` — Linear sync/bootstrap/delta, lastSyncId
- `docs/plan/research/notion-linear.md:96-102` — 댓글 모델, quotedText+anchor, resolvingComment
- `docs/plan/research/notion-linear.md:136` — 작성자 종류(사람/내부 AI/외부 에이전트/브라우저)
- `docs/plan/research/notion-linear.md:149` — PES가 원본, 외부는 내보내기만
- `docs/plan/research/notion-linear.md:155-164` — 공통 열, change_log, 현재값+기록, 첨언 표, 트랜잭션 API, ID
- `docs/plan/research/webmcp.md:19-25` — WebMCP 도구·위험도
- `docs/plan/research/webmcp.md:35-37` — 승인/reopen 비노출, 브라우저 에이전트 사건 기록

### 0단계 합의
- `docs/plan/discussion/stage-0-opencode.md:880-899` — Project/Stage/Item/Run/Question/Answer/Event 초안, `rev`·`lease_id`

### 현재 코드·화면
- `scripts/pes.py:96-114` — `load()`가 빠진 필드를 채움
- `scripts/pes.py:117-158` — 2시간 잠금, 전체 파일 저장, `library.json` 분리
- `scripts/pes.py:167-178` — 단계·항목 기본 구조
- `scripts/pes.py:186-216` — `init`, `"pes":1`, 폴더 구조
- `scripts/pes.py:219-239` — research-loop `state.json` 가져오기
- `scripts/pes.py:290-305` — 라운드 증가·history
- `scripts/pes.py:315-365` — merge, 출처 URL 중복 제거, depth 증가
- `scripts/pes.py:400-439` — 스냅숏·대시보드 렌더
- `scripts/pes.py:442-493` — approve, plan→research 인계·reuse
- `scripts/pes.py:496-512` — reopen·stale
- `scripts/pes.py:516-563` — pending/processed 파일 목록
- `scripts/pes.py:587-648` — digest/show/note
- `scripts/pes.py:830-859` — report, `reports`/`reports_built`
- `scripts/serve.py:111-152` — `POST /feedback`, `answers`, `kind`
- `templates/_questions.html:33-48` — 모든 질문의 `__other`, 기본 선택
- `templates/_questions.html:66-73` — `show_if`
- `templates/_questions.html:78-93` — `answers[id]`, `answers[id+'__other']`
- `questions/write.json:1-80` — 질문 은행 형식(옵션·추천·필수)
- `skills/core/SKILL.md:18` — `project.json` 단일 진실
- `skills/core/SKILL.md:62-84` — 직접 JSON 편집
- `skills/core/SKILL.md:86-92` — digest/show 토큰 절약
- `skills/core/SKILL.md:120-126` — 독립 검토
- `skills/core/SKILL.md:191-206` — 답 해석
- `README.md:343-360` — OneDrive 동기화 범위
- `README.md:503-521` — 한 번에 한 컴퓨터, 충돌 사본
- `README.md:548-563` — 프로젝트 폴더 구조
- `.claude-plugin/plugin.json:3` — v0.15.6

### 실측(2026-11-04, 내용 아님)
- `~/pes-projects/sample-project-2/project.json` 1,762,066 bytes, `verify` 항목 304개, `rounds/*` 103개 파일, `library.json` 353,656 bytes(13항목)
- `~/pes-projects/sample-project/project.json` 322,245 bytes
- 실제 `project.json`의 미문서 필드: `edit_log`, `fixed_r2`, `reuse_all`, `model`, `pages`, `title_before`; 단계 필드: `qa`, `review_log`, `reports_built`, `carry_over`, `settings.review_r1`

---

## 11. 마지막 의견

1단계 DB 설계에서 가장 중요한 것은 표 개수가 아니라 **"답·질문·첨언·결정이 어느 버전을 가리키는가"** 를 끝까지 명시하는 것이다. PES는 사람과 AI가 여러 라운드에 걸쳐 같은 글을 고치는 시스템이므로, `question_version_id`·`target_version_id`·`artifact_version_id` 없이는 나중에 "그때 그 답이 어느 문구에 대한 것이었나"를 복원할 수 없다.

두 번째는 **모드 중립성**이다. A와 B를 동시에 개발한다는 말은 테이블을 두 벌 만들라는 뜻이 아니라, 같은 `run`/`actor`/`question`/`answer`에 `mode`와 `kind`만 다르게 넣으라는 뜻이다. 이 원칙을 어기면 3단계 소통 기능에서 A/B 분기가 폭발한다.

세 번째는 **이전의 보수성**이다. 실제 프로젝트는 이미 1.76MB·304항목·103개 라운드 파일을 갖고 있다. `project.json`을 지우는 빅뱅 대신, 사본 → shadow → 검증 → 프로젝트별 전환 → rollback 유예를 택해야 한다. 이 절차를 1단계에서 문서로 고정하고, 2단계에서 실제 사본으로 한 번 돌려 보는 것이 완료 기준이다.
