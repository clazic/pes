# 1단계 DB 설계서 최종 대조·DDL 초안 검증

작성일: 2026-11-04. 대상은 [stage-1-db.md](../stage-1-db.md), 대조 기준은 [Claude 추천안](stage-1-db-claude-recs.md)과 [Codex 검수 보완](stage-1-db-codex-review.md)이다. **판정: 보완 필요.** 큰 방향과 약 22개 PR 분해는 반영됐으나 아래 누락·구체화가 남아 있어 「빠짐없이 반영됨」에는 아직 동의하지 않는다. 원 설계서는 수정하지 않았다.

실제 `~/pes-projects`·`~/.pes/`는 읽지 않았고 제품 코드는 수정하거나 실행하지 않았다. 근거 확인은 저장소 파일 범위로 한정했다. 이번 실행은 이 저장소의 SQL 초안과 합성 값만 사용한 `:memory:` SQLite 검사다. stage-0 7절의 전송 방향·DeepSeek 한 모델의 6단계·Claude Code/Claude 앱·공개/CI 결정은 변경하지 않았다.

## 1. 합의 대조에서 발견한 사항

표의 「구체화」는 기존 합의를 SQL로 옮길 때 필요한 명시 사항이며, 축약된 주요 열 목록이 모든 추가 열을 금지한다는 뜻은 아니다.

| 번호 | 구분·대상 | 틀리거나 빠진 점 | 반영할 보완 | 근거 |
|---|---|---|---|---|
| 1 | 누락 — 공개 저장소 정리 B | 설계서는 두 검수 문서를 입력으로만 링크하고 **B의 정리 범위·별도 인계**를 기록하지 않았다 | DB 구현과 섞지 말고 SEL-16 또는 별도 정리 문서로 인계함을 명시한다. 아카이브의 경로뿐 아니라 slug/topic/link, build 대상 전체, 조사 세션 경로/UUID, README의 일관된 가상 예시, 의견서 본문 반복 노출·맞춤 설정의 정리까지 포함한다. 일반 소속 소개는 기관 연구자료 공개 허용과 구분한다. 정리 완료 여부는 별도 증거가 필요하다 | [추천안:26–33](stage-1-db-claude-recs.md#L26-L33), [검수:B 전체·B1–4, 40–48](stage-1-db-codex-review.md#L40-L48). 설계서 [4행](../stage-1-db.md#L4), [158–163행](../stage-1-db.md#L158-L163)에는 인계가 없음 |
| 2 | 구체화 — 과거 승인 | `origin(new/legacy)`는 있으나 `human_user_id`에 NULL 표시가 없고, **legacy_unverified와 새 인증 승인의 차이**가 빠졌다 | 새 승인은 human actor·연결된 사용자 필수, 작성자를 모르는 옛 승인은 `legacy_unknown`, 사용자 NULL·검증 수준 `legacy_unverified`로 보존한다. 기존 승인 상태를 모두 지우거나 가짜 사람을 배정하지 않는다. DDL에 이 분기를 추가했다 | 설계서 [61행](../stage-1-db.md#L61), [129행](../stage-1-db.md#L129). 합의의 이전 범위 [검수:C11, 68행](stage-1-db-codex-review.md#L68), 상세 입력 [Codex:199행](stage-1-db-codex.md#L199), [416–418행](stage-1-db-codex.md#L416-L418) |
| 3 | 구체화 — 의견만 있는 필수 질문 | `__other`의 이전 보존은 적었지만 **선택값 없이 의견만 있을 때 필수 답의 유효성**은 적지 않았다 | 현행 호환 질문은 덧붙임으로 응답할 수 있음을 명시한다. 더 엄격한 새 질문은 `allow_comment_as_answer`로 구분한다. 의견을 추천 선택지 동의로 바꾸지 않는다. DDL은 이 열을 0/1로 두고 호환 기본값 1을 사용했다. 옵션의 의미·타입·조건부 질문 순환 검사는 명령 계층에 남는다 | 설계서 [84–89행](../stage-1-db.md#L84-L89), [검수:C8, 65행](stage-1-db-codex-review.md#L65), [Codex:249–251](stage-1-db-codex.md#L249-L251), 현행 [_questions.html:85–88](../../../templates/_questions.html#L85-L88) |
| 4 | 누락 — 가정 계승의 재확인 | 판 범위 복사·유지/수정/제외는 반영됐으나 **가정의 확인 시점·새 판에서의 재검토 필요**는 빠졌다 | 가정 버전에 판단자뿐 아니라 `assessed_at`, `needs_review`를 남기거나 동등한 버전/사건으로 표현한다고 명시한다. DDL에는 두 열을 추가했다. 이전 판에서 맞았다는 이유로 현행성까지 자동 확인하지 않는다 | 설계서 [23행](../stage-1-db.md#L23), [95행](../stage-1-db.md#L95), [검수:A6, 29행](stage-1-db-codex-review.md#L29) |
| 5 | 구체화 — 대화·후속 적용·반영 연결 | 스레드 상태·후속 결과 종류만 요약되어 **어느 답글이 결론인지, 어느 글/라운드/단계를 바꿀지, 실제 적용 증거**의 키가 생략됐다 | thread 버전에 결론 메시지 버전·요약, followup 버전에 대상 단계/라운드·기반/제안/결과 버전·적용 tx, reflection에 후속 작업/적용 tx를 명시한다. `applied`는 결과 버전 또는 실제 후속 적용 기록을 요구한다. 스레드 해결과 적용 완료는 계속 구분한다. DDL에 연결·최소 CHECK를 구체화했다 | 설계서 [97–101행](../stage-1-db.md#L97-L101), [검수:A8, 31행](stage-1-db-codex-review.md#L31), [검수:C6, 63행](stage-1-db-codex-review.md#L63), 상세 입력 [Codex:263–275](stage-1-db-codex.md#L263-L275) |
| 6 | 구체화 — 실행 중 Go OFF | 차단 대상은 반영됐지만 **이미 승인·전송 중인 요청의 경계**와 실제 목적지 기준 검사는 생략됐다 | API/실행 구조 인계에 「OFF 커밋 뒤 새 전송 승인 금지, prepared 차단, in-flight 취소 시도·상태 기록, 이미 나간 자료 회수 보장 없음」을 적는다. mode 문자열만 믿지 않고 Go 목적지·요약·파일·재시도를 검사한다. DDL의 정책 참조·dispatch 상태만으로 자동 반출 차단이 완성된 것은 아니다 | 설계서 [18행](../stage-1-db.md#L18), [113행](../stage-1-db.md#L113), [142행](../stage-1-db.md#L142). [검수:A1, 24행](stage-1-db-codex-review.md#L24), [검수:C10·19, 67·76행](stage-1-db-codex-review.md#L67-L76), 그 근거 [Codex:438–458](stage-1-db-codex.md#L438-L458) |
| 7 | 누락 — doctor와 입력 보존 | PR16의 보고서 쓰기 경계와 PR18의 쓰기 연결은 반영했지만 **doctor 기본 진단/fix 분리·임시 홈 검사**, **입력 중 갱신 시 미제출 답 보존**이 빠졌다 | PR16·18의 완료 조건에 각각 추가한다. 이번 검사기는 PES/doctor를 import하지 않아 실제 설정 접근 자체를 피했다 | 설계서 [192–194행](../stage-1-db.md#L192-L194), [검수:C16·18, 73–75행](stage-1-db-codex-review.md#L73-L75) |
| 8 | 구체화 — run 정보·앱 재개 조건 | run 주요 열에 **작성/독립 검토 역할·워크플로 버전·선택적 사용량**이 없고, 앱의 지속 연결/heartbeat를 가정하지 않는다는 조건이 축약됐다 | run에 role·workflow_version·nullable usage를 두고 모르는 모델/사용량은 unknown/NULL로 둔다. 앱 연결은 SEL-24로 넘기되 끊긴 뒤 재접속·입력 반영을 어떻게 확인할지 완료 조건을 남긴다. DDL은 A에 고른 DeepSeek만 허용하고 B의 실제 모델은 임의 추정하지 않는다 | 설계서 [107행](../stage-1-db.md#L107), [143행](../stage-1-db.md#L143), [162행](../stage-1-db.md#L162), [196행](../stage-1-db.md#L196). [검수:C19·20, 76–77행](stage-1-db-codex-review.md#L76-L77), [Codex:464–473](stage-1-db-codex.md#L464-L473) |
| 9 | 구체화 — 생성 순환 참조·DB 보장 범위 | `projects.current_policy_id`에 생성 중 NULL/원자적 확정 설명이 없고, current/original version·snapshot 참조의 순환 생성 방법도 생략됐다. 9절은 상태 전이까지 체크됐다고 표시한다 | 프로젝트는 staging+NULL 포인터로 생성하고 소유자 membership·초기 정책을 같은 트랜잭션에서 만든 뒤 활성화한다. 질문 원문 FK는 첫 버전과 한 트랜잭션에서 완성한다. SQL로 보장하는 참조/중복과 서비스가 보장할 상태 전이·불변성·정확히 6단계·fence 증가를 나눠 적는다. DDL에는 생성 순서·deferred FK·제약의 한계를 주석으로 남겼다 | 설계서 [38행](../stage-1-db.md#L38), [48–49행](../stage-1-db.md#L48-L49), [68행](../stage-1-db.md#L68), [83행](../stage-1-db.md#L83), [167행](../stage-1-db.md#L167). [검수:C1·4·6, 58–63행](stage-1-db-codex-review.md#L58-L63), [Codex:184–186](stage-1-db-codex.md#L184-L186) |

## 2. DDL 초안의 범위와 구체화

- [stage-1-ddl-draft.sql](../schemas/stage-1-ddl-draft.sql): 3절의 그룹별 표를 **54개 CREATE TABLE**로 풀었다. 프로젝트 경계는 복합 FK, 객체 종류/자기 버전/답의 질문 버전은 추가 식별 열·복합 UNIQUE/FK로 제한한다. 활성 판·열린 라운드·소유자 한 명은 부분 UNIQUE로 제한한다. 트리거·FTS·ATTACH는 사용하지 않았다.
- [check_ddl.py](../schemas/check_ddl.py): import는 표준 라이브러리 `sqlite3` 하나뿐이다. 스크립트 옆 SQL 파일만 읽고 `:memory:`만 연결한다. 실제 파일 객체를 생성하거나 모델·PES·설정·네트워크에 접속하지 않는다. blob 행도 **합성 메타데이터**이며 파일 저장 성공을 시험한 것은 아니다.
- nullable 생성 포인터·옛 승인 불확실성·질문별 덧붙임 규칙·결론 메시지/적용 tx·run 역할 등은 위 표와 앞 의견의 상세를 바탕으로 한 **초안 구체화**다. 제품 마이그레이션이나 최종 열 이름의 자동 승인으로 간주하지 않는다.
- 시간은 INTEGER epoch ms, ID는 TEXT, JSON은 TEXT+`json_valid`로 검사한다. actor는 전역 신원 표, project_members 이하 업무 관계는 project_id로 범위를 제한한다. `db_meta`는 설치 범위라 project_id를 두지 않는다.
- 현재 lease 행은 교체되므로 과거 mutation의 lease_id/fence는 역사적 값으로 저장하고 현재 lease 행에 FK로 묶지 않는다. 그러지 않으면 인계 때 과거 기록이 새 lease 값으로 바뀌거나 인계 자체가 막힌다.

## 3. 검증 결과의 의미와 아직 남는 서비스 검사

| 확인한 것 | 이번 결과의 범위 |
|---|---|
| DDL·참조 무결성 | FK를 켠 SQLite 메모리 DB에서 생성·54개 표 합성 적재·foreign_key_check·integrity_check 통과 |
| 허용할 데이터 | 비활성 판과 활성 판 공존, 같은 URL의 서로 다른 출처, 신원 미확인 옛 승인, Go 허용 초기값을 표현 가능 |
| 거부할 데이터 | 최종 실행에서 50개 거부 사례 확인. 프로젝트를 바꿔 끼우는 포인터/질문/답/출처/파일/run/lease/사건/정책, 잘못된 종류·JSON·상태·중복·두 활성 판 등을 포함 |
| 대표 조회 | 프로젝트의 여섯 단계·라운드, 수정 전 질문에 대한 답+질문별 의견, 프로젝트별 사건 커서의 세 조회. 변경 커서는 EXPLAIN QUERY PLAN에서 인덱스 검색 확인 |
| 0행 rev 충돌 | 새 버전·본문·사건·mutation 영수증을 먼저 쓴 뒤 조건부 UPDATE가 0행이면 Python에서 예외를 내고 **트랜잭션 전체**를 rollback. 포인터·rev·모든 관련 행 수가 이전과 동일함을 확인 |
| 뒤늦은 SQL 실패 | 유효한 CAS로 포인터까지 바꾼 뒤 CHECK 실패를 내도 전체 rollback됨을 확인 |
| 정상 변경 | 새 버전·포인터·사건·영수증은 함께 commit, 과거 버전 본문은 유지 |
| fence·Go OFF | SQL 가드 예제로 오래된 fence·합성 프로젝트의 OFF를 CHECK 실패로 거부. **제품 어댑터나 D1 batch의 실제 강제 검증은 아님** |

SQL의 rowcount가 0인 것 자체는 예외가 아니므로 검사기의 [조건부 UPDATE](../schemas/check_ddl.py#L434-L445)와 [명시적 예외·rollback](../schemas/check_ddl.py#L447-L464)을 구분했다. D1에 Python의 인터랙티브 트랜잭션을 그대로 옮기면 안 되며, 같은 batch 안에서 충돌을 SQL 실패로 만드는 검증이 별도로 필요하다.

트리거를 쓰지 않으므로 다음은 **통과했다고 주장하지 않는다**: 과거 버전에 대한 임의 SQL UPDATE/DELETE 방지, 상태 전이의 적법성, 활성 포인터와 상태의 완전한 일치, 생성 명령마다 정확히 여섯 단계 확보, 객체 세부 버전의 완전성, 판 scope/편집 허용 범위의 모든 조합, 답의 타입·선택지·show_if 의미 검증, 관계 그래프 순환 검사, fence 단조 증가, 실제 인증·caller 귀속, R2 ready 파일의 실재·hash, 전송 중 취소·반출 방지, importer/복원 제품 동작. 이들은 단일 명령 서비스·어댑터·후속 통합 검사에서 보장해야 한다.

## 4. D1에서 아직 확인하지 못한 점

| 항목 | 후속 확인 |
|---|---|
| 공통 DDL 적용 | 같은 SQL의 forward FK·복합 FK·CHECK·부분 UNIQUE·AUTOINCREMENT·JSON 함수·정확한 제약 오류를 로컬 D1에서 실행. SQLite 3.54.1 통과를 D1 통과로 바꾸어 적지 않음 |
| 순환 생성 | `DEFERRABLE INITIALLY DEFERRED`로 묶은 소유자 membership·질문 원문 생성이 D1의 한 batch 끝에서 검사되는지, 실패가 모두 rollback되는지 확인 |
| 원자적 변경 | rev/lease/fence/정책 가드와 버전·포인터·사건·영수증을 같은 batch로 수행. 0행 UPDATE 뒤 다른 INSERT만 남지 않는지 확인. 응답 유실·중복 요청·동시 claim 시험도 필요 |
| 조회·커서 | D1 쿼리 계획, primary/Sessions/bookmark 동작, 복원 후 cursor_epoch 갱신과 다시 받기 확인 |
| 배포·제한 | 번호 붙은 마이그레이션 실행기, 제약 재구성·rollback, 바인드/본문/실행 시간 제한·대량 이전 분할. 이 초안은 운영 마이그레이션이 아님 |
| 파일·Go | D1+R2는 별도 저장 작업임. 업로드/검증/ready 채택 실패·고아 파일·파일 권한과 Go 전송 직전 정책 검사·OFF/in-flight 경합은 미검증 |

## 5. 실제 실행 기록

실행 명령: `python3 docs/plan/schemas/check_ddl.py`. 종료 코드: **0**. 제품 코드 변경 없음. stdout은 다음과 같다.

```text
SQLite 3.54.1; foreign_keys=ON; database=:memory:
PASS DDL execution; no triggers or external databases
PASS synthetic hierarchy: 2 projects, 12 stages, all 54 tables populated
PASS allowed cases: inactive edition, duplicate URL sources, uncertain legacy approval, Go initialized ON
PASS constraints: 48 invalid/reference/cross-project/duplicate writes rejected
PASS partial UNIQUE: second active edition and second open round rejected
PASS representative queries: hierarchy, historical answer + comment, scoped change cursor (indexed)
PASS zero-row CAS: explicit failure; version, payload, pointer, event, receipt all rolled back
PASS late SQL failure: successful CAS and all other writes rolled back
PASS successful command: new version + pointer + event + idempotency receipt committed; old version retained
PASS SQL guard examples: stale fence and synthetic Go OFF rejected (SQLite only)
PASS foreign_key_check and integrity_check
RESULT PASS; rejected cases=50; representative queries=3
D1 NOT TESTED: batch/guard, deferred FKs, partial indexes, JSON functions, migrations, runtime limits
```
