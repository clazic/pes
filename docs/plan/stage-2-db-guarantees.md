# 2단계 DB 보장 범위 (PR1)

- 작성: 2026-11-05, SEL-34
- 입력: [stage-1-db.md](stage-1-db.md) 3·9절, [DDL 초안](schemas/stage-1-ddl-draft.sql), [check_ddl.py](schemas/check_ddl.py), [stage-2.md](stage-2.md) 2.6·2.7절
- 상태: PR1 구현·시험 기준. DDL 001은 `scripts/pes_core/migrations/001_initial.sql`이다.
- 범위: 로컬 SQLite(PR1). D1 동등성은 PR2가 같은 마이그레이션으로 확인한다.

## 1. 요약

DDL은 **참조·중복·형식**을 보장한다. **상태 전이·정확히 6단계·fence 단조 증가·불변 버전 append-only·인증·전송 정책·R2 원자성**은 DDL이 아니라 명령 서비스가 보장한다. DDL 머리 주석(6~10줄)이 이 경계를 그대로 적고 있다.

| 구분 | 보장 주체 | PR1 시험 |
|---|---|---|
| 프로젝트 범위 복합 FK, FK 존재·삭제 제한 | SQL | 예 |
| CHECK(enum·범위·JSON 형식·hash 길이), UNIQUE, 부분 UNIQUE | SQL | 예(대표) |
| NOT NULL·기본값(초기 정책 전송 허용 켜짐 등) | SQL + bootstrap | 예 |
| `db_meta` schema_version·cursor_epoch | SQL + migrate | 예 |
| 상태 전이 적법성, 정확히 6단계, fence 단조 증가 | 서비스 | 아니오(PR4~6) |
| 과거 버전 UPDATE/DELETE 금지(append-only) | 서비스(DDL은 막지 않음) | 아니오(PR4·7) |
| 인증·권한·전송 정책·목적지 검사 | 서비스 | 아니오(PR4·10·13) |
| rev 0행을 성공으로 흘리지 않기, tx 전체 롤백 | 서비스(단, `tx` 기본기는 PR1) | 기본기 예, 명령 서비스는 PR4 |
| R2/파일과 DB의 원자성, staging→hash→ready | 서비스 | 아니오(PR9) |

## 2. SQL(DDL 001)이 보장하는 것

DDL이 직접 거부하는 것:

- **다른 프로젝트 행 끼워 넣기**: 업무 표의 `(project_id, id)` 복합 FK와 `(project_id, ...)` 참조가 프로젝트 경계를 넘는 연결을 거부한다.
- **끊긴 참조**: FK가 없는 행·버전·단계·라운드를 가리키는 쓰기를 거부한다. 삭제는 기본 `RESTRICT`라 연구 기록을 함께 지우지 않는다.
- **형식 위반**: 상태 enum, 단계 `key`/`ordinal` 대응, `allow_opencode_go` 0/1, 사용량 문턱 50~100, JSON `json_valid`/`json_type` 모양, 64자 hash, 음수 rev/fence 등.
- **중복**: slug, 프로젝트별 표시 번호·버전 번호, `(project_id, policy_rev)`, `(project_id, actor_id, client_request_id)` 등.
- **부분 UNIQUE**: 프로젝트당 owner 하나, 활성 판 하나, 단계당 열린 라운드 하나.
- **초기값**: 정책 기본 전송 허용(`allow_opencode_go=1`), A 기본 모델(`opencode-go/deepseek-v4.1-flash`), 사용량 문턱 90, `db_meta` 형식.
- **사건 번호**: `events.event_seq`는 `AUTOINCREMENT`로 증가하며 `(project_id, event_seq)`·`(tx_id, tx_index)`가 유일하다. 연속 번호는 보장하지 않는다.

DDL이 **보장하지 않는** 것: 아래 3절.

## 3. 서비스(명령 계층)가 보장해야 하는 것

| 항목 | 내용 | 담당 |
|---|---|---|
| 상태 전이 | `stages`/`rounds`/`runs`/`approvals`의 허용된 전이만 수행. 예: 승인 전 봉인, 승인은 사람만, `complete`≠승인 | PR4·6 |
| 정확히 6단계 | 프로젝트 생성 뒤 항상 6단계가 존재. 새 판 생성·복사도 같은 tx에서 6단계를 만든다 | PR6(bootstrap 생성은 PR1 시험) |
| fence 단조 증가 | 인계마다 `fence` 증가, 만료 lease 부활 금지, 옛 fence 거부 | PR5 |
| 불변 버전 append-only | `*_versions`에 UPDATE/DELETE 경로를 두지 않는다. 현재 포인터는 자기 버전만 가리킨다 | PR4(lint)·7 |
| rev/control_rev CAS | 조건부 UPDATE가 0행이면 실패로 처리하고 tx 전체를 롤백한다. D1 batch에서도 같다 | PR4(기본기는 PR1) |
| 영수증·사건 | 모든 업무 변경과 같은 tx에 `mutation_commits`·`events`를 남기고, 같은 키 같은 요청만 재생한다 | PR4 |
| 인증·권한 | 프로젝트 범위 토큰, 사람 전용 승인·reopen·정책 변경, owner 확인 | PR10·13·14 |
| 전송 정책 | 인증·권한·현재 정책·목적지를 영수증 재생보다 먼저 검사한다. OFF 뒤 `prepared` 차단, in-flight는 `unknown` 보존 | PR4·10 |
| 파일·R2 원자성 | DB 행과 객체 저장의 순서·실패 롤백, staging→hash→ready, 다른 프로젝트 blob 접근 차단 | PR9 |
| 백업·복원 | `cursor_epoch` 무효화, 프로젝트 단위 복원, 손상·누락 보고 | PR3·12 |
| API 계약 | 10진 문자열(`rev`, `fence`, `event_seq` 등), 닫힌 명령, 미지원 필드 거부, 0행 실패를 성공으로 보이지 않기 | PR13·14 |
| D1 차이 | batch 원자성, deferred FK, 0행 실패, 부분 인덱스, JSON 함수 동등성 | PR2 |

## 4. PR1이 실제로 시험한 항목

`npm test`의 `tests/test_db_*.test.ts`가 아래를 확인한다. 모든 시험은 `tests/helpers/isolated_home.ts`의 임시 `HOME`·`USERPROFILE`·`PES_HOME`만 쓰고 `process.env`를 바꾸지 않는다.

| 항목 | 확인 내용 |
|---|---|
| 표 61개 | `sqlite_master` 이름 목록이 DDL의 `CREATE TABLE` 이름과 일치 |
| 마이그레이션 표류 | 001 SQL 문장(주석·공백 정규화)이 DDL 초안과 같고 `PRAGMA`·`BEGIN`·`TRIGGER`·FTS·`ATTACH`가 없음 |
| FK | `PRAGMA foreign_keys=1`, `foreign_key_check` 0건, `integrity_check=ok` |
| JSON·버전 | `json_valid`·`json_type` 동작, `sqlite_version()`이 최소 버전 이상, 순수 비교 함수가 낮은·잘못된 버전 문자열 거부 |
| `db_meta` | `id=1`, `schema_version=1`, `cursor_epoch=1`, UUID `database_instance_id`; 재실행 멱등(같은 instance id); 미래 `schema_version` 거부 |
| 동시 초기화 | 같은 파일 DB를 두 연결·두 자식 프로세스가 동시에 migrate해도 하나만 적용되고 나머지는 잠금 안 재검사 뒤 멱등 `applied:false` |
| 마이그레이션 롤백 | 뒤 마이그레이션 실패 시 표 0개로 롤백되고, 그 뒤 정상 migrate가 다시 성공 |
| 경로 | 경로가 임시 홈 아래로만 풀림, `PES_HOME`을 바꿔도 DB·객체 경로 불변, 홈 변수 누락·공백은 오류(`os.homedir` 폴백 없음) |
| 대표 삽입 | artifact·source·citation·question·answer·run·lease·event·blob·file_policy 등 대표 행 삽입 성공 |
| 거부 롤백 | FK·CHECK·UNIQUE·부분 UNIQUE·다른 프로젝트 참조 위반이 tx 롤백으로 **전후 서명 완전 일치** |
| rev 충돌 | 조건부 UPDATE 0행이면 앞선 version·payload·event까지 전부 롤백. 같은 본문이 현재 rev에서는 성공 |
| bootstrap | owner·초기 정책·첫 판·6단계·counters·포인터 한 tx; 중간 실패 주입 시 업무 표 0행 |
| bigint | `2^53+1`(`9007199254740993`)이 bigint로 왕복 |
| tx 규칙 | 중첩 tx 거부, native async 콜백은 `BEGIN` 전 거부, Promise 반환 콜백 롤백·오류, native Promise rejection만 삼킴, 사용자 정의 thenable은 `then()` 호출 없이 거부, 실패 뒤에도 다음 tx 정상 |
| 격리 | 자식 프로세스가 전달한 격리 env만 받고 부모 `process.env`는 불변 |

**PR1이 시험하지 않은 것**: D1(PR2), 명령 서비스·영수증·events(PR4), lease 만료·fence(PR5), 판·단계 전이(PR6), 버전 append-only 강제(PR7), 파일 정책·R2(PR9), 인증·전송 정책(PR10), API 계약(PR13·14), 복원(PR12).

## 5. SQLite 최소 버전과 근거

**최소 SQLite 3.38.0** (`SQLITE_MIN_VERSION`).

- DDL이 쓰는 **JSON 함수**(`json_valid`, `json_type`)는 SQLite 3.38.0(2022-02-22)부터 기본 빌드에 포함된다. 그 전에는 JSON1 확장이 빌드에 따라 빠질 수 있었다.
- DDL의 **부분 UNIQUE 인덱스**는 3.8.0부터, **DEFERRABLE INITIALLY DEFERRED FK**·`ON DELETE RESTRICT`·`AUTOINCREMENT`는 그보다 오래된 기능이라 3.38.0이 실질 하한을 결정한다.
- Node 26의 `node:sqlite`는 SQLite 3.54.1을 내장한다(2026-11-05 로컬 확인). CI의 Windows·macOS 잡이 실제 `sqlite_version()`을 출력한다.
- 런타임 버전만 보고 기능을 가정하지 않는다(stage-2 2.6 A). `connect()`가 **실제 `sqlite_version()`**과 **`json_valid`·`json_type` 실행 결과**를 확인하고, 아니면 연결을 닫고 명확한 오류를 낸다. 버전 비교는 `sqlite_version_at_least()` 순수 함수로 분리해 낮은 버전 문자열을 시험한다.

## 6. 연결·PRAGMA·정수 방침

- **드라이버**: `node:sqlite` `DatabaseSync`. 별도 드라이버 의존성 없음.
- **foreign_keys**: `PRAGMA foreign_keys=ON` 뒤 `PRAGMA foreign_keys`가 1인지 확인한다. 켜지지 않으면 연결 실패.
- **busy_timeout**: WAL 단계가 끝난 뒤 5000ms로 설정하고 실제 값을 확인한다. 짧은 tx(`BEGIN IMMEDIATE`)와 함께 쓴다.
- **WAL**: 파일 DB는 `busy_timeout`을 0으로 두고 현재 `journal_mode` 읽기와 필요 시 `PRAGMA journal_mode=WAL` 적용을 **한 루프·한 기한**에서 수행한다. 이미 `wal`이면 그대로 두고, 아니면 전환해 `wal`인지 확인한다. 읽기와 전환 모두 `SQLITE_BUSY`면 같은 10ms→최대 100ms 백오프로 `BUSY_TIMEOUT_MS`(또는 `wal_busy_timeout_ms`) 상한까지 재시도하고, 상한을 넘으면 원래 오류를 `cause`로 담은 오류로 연결을 닫는다. 경과 시간은 단조 시계(`performance.now()`)로 잰다. `:memory:`는 건너뛴다. WAL의 `-wal`/`-shm` 파일은 SQLite가 만드는 연결 부산물이다.
- **부모 폴더**: DB 파일의 부모 폴더만 `mkdir -p` 한다. 객체 폴더·세션·토큰·백업 등 다른 파일은 PR1이 만들지 않는다.
- **정수는 bigint**: 모든 prepared statement에 `setReadBigInts(true)`를 적용한다. SQLite INTEGER는 `number`로 읽지 않는다. 2^53 초과 값의 손실을 막기 위해 `2^53+1` 왕복을 시험한다. API의 10진 문자열 계약은 PR13이 이 위에 얹는다.
- **tx 콜백은 동기만**: native async 함수는 `BEGIN` 전에 거부하고, 동기 함수가 thenable을 반환하면 롤백·오류로 처리한다. 반환된 thenable은 실행하지 않으며, unhandled rejection 방어는 native `Promise`에만 내장 rejection 핸들러를 붙인다. tx는 동기 콜백 계약이며, 콜백이 스스로 시작한 비동기 작업(이미 생성된 Promise의 후속 실행)은 취소할 수 없다 — 타입(`never`)과 실행 전 async 거부로 막는다.
- **PES_HOME**: 프로젝트 폴더만 옮긴다. DB `~/.pes/pes.db`·객체 `~/.pes/objects/` 경로는 바뀌지 않는다(stage-2 2.7). `PES_DB`·`PES_OBJECTS` 우회 변수는 PR1에 없다.

## 7. bootstrap이 만드는 행과 만들지 않는 것

`bootstrap_project(db, input, deps)`는 **한 tx**에서 아래를 만든다. 어느 한 행이라도 실패하면 전부 롤백한다.

- `users` 1행(owner), `actors` 1행(`kind='human'`, owner user), `projects` 1행(`status='staging'`으로 시작해 마지막에 `active`), `project_members` 1행(`role='owner'`).
- `mutation_commits` 1행(영수증)과 `events` 1행. PR4부터 bootstrap은 명령 서비스를 지나며, `project_policy_versions.tx_id`가 참조하는 영수증과 사건을 같은 tx에 남긴다. 영수증 재생·멱등은 8절.
- `project_policy_versions` 1행(`policy_rev=1`, `allow_opencode_go=1`, 기본 모델·문턱 90, `changed_by_kind='human'`).
- `editions` 1행(`edition_no=1`, `status='active'`)과 `stages` 6행(`plan`~`publish`, `ordinal` 1~6, `status='pending'`).
- `counters` 9행(객체 kind별 `next_no=1`).
- 포인터: `editions.current_stage_id`=plan 단계, `projects.active_edition_id`, `projects.current_policy_id`, `projects.status='active'`.

만들지 않는 것: **열린 라운드**(PR6). 명령 서비스·`events`·영수증 재생은 PR4(8절)가 맡는다. `PR13`의 `project.create`가 이 기본기를 API 계약으로 감싼다.

## 8. 변경 명령 서비스(PR4)가 보장하는 것

PR4부터 모든 업무 쓰기는 `scripts/pes_core/commands.ts`의 `CommandService` 하나를 지난다. 외부 호출은 `execute()`(async 래퍼, 예외는 rejection)를 쓰고, 동기 호출자인 `bootstrap_project`는 같은 핵심인 `execute_sync()`를 쓴다. tx 안에는 `await`가 없어 명령 실행 중 이벤트 루프에 양보하지 않는다. `bootstrap.ts`는 `bootstrap_project` 시그니처만 유지하고 내부에서 `project.bootstrap` 명령을 서비스로 실행한다. 업무 표 INSERT/UPDATE/DELETE SQL은 `commands.ts`에만 있다.

- **실행 순서**: 닫힌 등록표(`COMMANDS`) → 프로젝트·행위자 확인(`forbidden`/`not_found`) → 현재 정책(`policy_denied`) → 영수증 재생(`client_request_id`+`request_hash`) → rev → 변경 → `events`+`mutation_commits`. 전부 한 tx다.
- **멱등**: 같은 키·같은 요청은 저장된 결과를 재생하고 아무것도 쓰지 않는다. 같은 키·다른 요청은 `idempotency_key_reuse`로 거부한다. `request_hash`는 명령과 payload만 덮고 `base_control_rev`는 덮지 않으므로, 낡은 base로 다시 보내도 재생이 rev 검사보다 먼저 동작한다.
- **영수증 장기 보존**: `mutation_commits`·`events`를 UPDATE/DELETE하는 경로가 없고, 재생은 시간이 지나도 유효하다.
- **정책 우선**: 인증·권한·현재 정책 검사가 영수증 재생보다 먼저다. OFF 뒤에는 OFF 전에 성공한 결과가 재생되지 않는다.
- **원자성**: 조건부 UPDATE가 0행이거나 events/영수증 INSERT가 실패하면 tx 전체를 롤백하고 성공으로 보이지 않는다. 실패한 시도는 영수증을 남기지 않으므로 같은 키로 다시 실행할 수 있다.
- **닫힌 표면**: 표 CRUD·임의 SQL·ops 명령은 등록표에 없다. 새 쓰기는 도메인 명령 하나로만 추가한다.
- **오류 번역**: SQLite UNIQUE·PRIMARY KEY 제약만 `ApiError("conflict", "UNIQUE constraint conflict")`로 바꾼다. 원문(표·열 이름)은 메시지·`details` 어디에도 넣지 않는다. FOREIGN KEY·NOT NULL·CHECK 등 다른 SQLite 오류는 tx 롤백 뒤 원래 오류를 그대로 던진다.

### 8.1 request_hash 정규화 (언어 중립)

영수증의 `request_hash`는 다음 규칙으로 계산한다. 다른 언어 구현도 같은 입력에서 같은 64자 hex를 내야 한다(영수증을 장기 보존하고 재생 판정에 쓰므로).

1. **입력 스냅샷**: 명령 진입 시 payload를 `JSON.stringify`→`JSON.parse` 한 번으로 고정한다. `JSON.stringify`는 `toJSON`을 적용하고 getter를 한 번 읽는다. 최상위 `undefined`·함수·심볼만 있는 payload는 `null`로 정규화한다. 순환 참조·BigInt는 `invalid_payload`다. 이후 해시·정책 사본·검증·실행은 모두 이 스냅샷만 쓴다.
2. **해시 대상 문자열**: `command + "\n" + canonical_json(snapshot)`을 UTF-8로 인코딩한 바이트.
3. **canonical_json**:
   - 객체 키는 **UTF-16 코드 유닛 순서**(JavaScript `Array.prototype.sort()` 기본)로 정렬한다. 키와 문자열 값은 ECMAScript `JSON.stringify` 규칙으로 인용·이스케이프한다.
   - 배열은 순서를 유지한다.
   - 숫자·불리언·`null`은 ECMAScript `JSON.stringify` 출력 그대로다. 스냅샷은 `JSON.parse` 결과이므로 NaN·Infinity는 없고, `-0`은 `0`으로 직렬화된다.
   - 공백·개행을 넣지 않는다.
4. **해시**: 위 문자열의 SHA-256, 소문자 16진수 64자.
5. **포함/제외**: `command`와 payload 스냅샷만 포함한다. `base_control_rev`·`project_id`·`actor_id`·`via`·`client_request_id`는 해시에 넣지 않는다. 영수증 조회 키는 `(project_id, actor_id, client_request_id)`이고 해시는 요청 본문 비교에만 쓴다.

예: command `project.set_topic`, payload `{"n":1,"topic":"가"}` → 해시 대상 `project.set_topic\n{"n":1,"topic":"가"}` → SHA-256 `54877204a50ae33ca4e175d46813a1f760859a78124c138ea3d66c83eb0fc3fa`.

### 8.2 후속 확장(예정)

- **PR10**: `PolicyChecker.check`가 tx 안의 읽기 전용 `db`(또는 정책 행 조회 함수)를 받도록 시그니처를 넓혀, `project_policy_versions` 현재 행을 같은 tx에서 읽는다.
- **PR5(반영)**: `EventDraft.run_id`와 영수증의 `run_id`·`lease_id`·`fence`를 더했다(8.3).
- **PR5 이전 검토**: 새 명령이 영수증을 빠뜨리지 않도록 `run()`이 action을 제외한 영수증 필드를 반환하고 서비스가 쓰는 구조(부트스트랩만 정책 FK 때문에 훅으로 예외)를 검토한다.

### 8.3 run·lease·fence(PR5)

`scripts/pes_core/commands/runs.ts`가 `run.claim`·`run.heartbeat`·`run.wait`·`run.complete`·`run.release`·`run.handoff`·`run.interrupt`·`run.record_receipt`를 정의하고, `scripts/pes_core/runs.ts`의 공개 함수는 각각 `CommandService.execute` 한 번만 호출한다. 모든 run 쓰기는 8절의 실행 순서(등록표 → 프로젝트·행위자 → 정책 → 영수증 재생 → rev/lease → 변경 → `events`+영수증)를 그대로 지나며 한 tx다.

- **claim**: 프로젝트에 활성·미만료 lease가 없을 때만 run을 만들거나 재개한다. run은 `running`, lease는 `active`, `fence`는 이전 값 + 1(첫 lease는 1)이다. `run_id` 재개는 `queued`·`waiting_human`·`blocked_usage`·`interrupted`에서만 되고 `succeeded`·`failed`·`cancelled`는 거부한다. 재개 payload에 `parent_run_id`나 `role`이 있으면 `invalid_payload`다. 만료된 lease를 대신할 때 그 lease의 run이 아직 `running`이면 같은 tx에서 `interrupted`로 끝내고(`ended_at` 설정) `events.run_id`가 그 옛 run인 interrupt 사건을 남긴다. 이미 끝난 run은 건드리지 않는다.
- **가드**: claim을 뺀 모든 run 명령은 `project_leases` 행이 그 프로젝트의 **활성·미만료**(`now < expires_at`) lease이고 `lease_id`·`fence`·`run_id`·소유 행위자가 정확히 같을 때만 통과한다. 아니면 `conflict`이고 아무것도 쓰지 않는다. 만료(`now >= expires_at`)·해제된 lease는 되살리지 않으며, 새 claim만 새 `lease_id`와 더 높은 `fence`를 만든다.
- **heartbeat**: `expires_at = now + lease_ttl_ms`로 연장하고 `fence`는 바꾸지 않는다. 만료 경계(`now == expires_at`)에서는 거부한다.
- **wait**: run을 `waiting_human`으로 바꾸고 lease를 `released`로 놓으며(가드의 `fence`는 보존), 같은 tx에 사건과 영수증을 남긴다. 대기 중에는 다른 run이 claim할 수 있고, 재개는 새 claim·새 `fence`다.
- **complete**: `succeeded`(기본) 또는 `failed`로 run을 끝내고 lease를 놓는다. 승인·봉인·단계 변경은 하지 않는다. `release`·`handoff`는 run을 `queued`, `interrupt`는 `interrupted`로 둔다.
- **입력 영수증**: `applied`는 같은 프로젝트의 `mutation_commits.id`인 `applied_tx_id`가 있을 때만 인정한다. 같은 run 또는 `parent_run_id` 사슬의 조상 run이 이미 `applied`한 입력은 다시 적용하지 않고 `already_applied: true`로 답하며 저장된 `applied_tx_id`를 바꾸지 않는다.
- **영수증·사건**: run 명령의 영수증은 `run_id`·`lease_id`·`fence`를, 사건은 `events.run_id`를 남긴다. 거부·검증 실패는 영수증도 사건도 남기지 않는다.
- **설정**: `lease_ttl_ms`·`heartbeat_interval_ms`는 `scripts/pes_core/config.ts`에만 있다. 서비스는 `process.env`를 읽지 않는다. API/CLI 같은 합성 지점이 `resolve_run_config(overrides, process.env)`로 env를 명시해 넘기고, 주입된 `RunConfig`가 없으면 서비스는 설정 기본값만 쓴다. 우선순위는 주입값 > env > 기본값이며, 양의 안전 정수만 받고 heartbeat가 TTL보다 짧아야 한다.
