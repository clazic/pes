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

- **PR10(반영)**: `PolicyChecker.check`가 tx 안의 읽기 전용 `db`(또는 정책 행 조회 함수)를 받도록 시그니처를 넓혀, `project_policy_versions` 현재 행을 같은 tx에서 읽는다(8.5).
- **PR5(반영)**: `EventDraft.run_id`와 영수증의 `run_id`·`lease_id`·`fence`를 더했다(8.3).
- **PR5 이전 검토**: 새 명령이 영수증을 빠뜨리지 않도록 `run()`이 action을 제외한 영수증 필드를 반환하고 서비스가 쓰는 구조(부트스트랩만 정책 FK 때문에 훅으로 예외)를 검토한다.

### 8.3 run·lease·fence(PR5)

`scripts/pes_core/commands/runs.ts`가 `run.create`·`run.claim`·`run.heartbeat`·`run.wait`·`run.complete`·`run.release`·`run.handoff`·`run.interrupt`·`run.record_receipt`를 정의하고, `scripts/pes_core/runs.ts`의 공개 함수는 각각 `CommandService.execute` 한 번만 호출한다. 모든 run 쓰기는 8절의 실행 순서(등록표 → 프로젝트·행위자 → 정책 → 영수증 재생 → rev/lease → 변경 → `events`+영수증)를 그대로 지나며 한 tx다.

- **create(PR13)**: `run.create`는 사람 owner만 실행한다. 입력은 `{actor_id, mode, runtime, provider, model}`뿐이고, 대상 actor는 그 프로젝트의 활성 멤버여야 한다. `runs` 행은 `status='queued'`, `role='worker'`, `started_at=NULL`로 만들고 **lease를 만들거나 fence를 바꾸지 않는다**. 따라서 이 run의 첫 `run.claim`은 fence 1이다. 영수증·사건은 `run.created`이고 사건은 `run_id`를 담는다. 영수증의 `run_id`는 비워 둔다: `mutation_commits`의 `(project_id, run_id, actor_id)` FK는 run 소유 actor를 요구하는데 이 명령의 actor는 owner이므로, run 식별은 결과와 사건이 담당한다.
- **claim**: `ctx.base_control_rev`가 주어지면 영수증 재생 **뒤**, 같은 tx 안에서 저장된 `projects.control_rev`와 BigInt로 비교한다(정규화 10진 문자열은 2^53·int64 초과도 그대로 비교, 불일치는 `rev_conflict`). 따라서 같은 키·같은 요청은 그사이 rev가 바뀌어도 원래 결과를 재생한다. 프로젝트에 활성·미만료 lease가 없을 때만 run을 만들거나 재개한다. run은 `running`, lease는 `active`, `fence`는 이전 값 + 1(첫 lease는 1)이다. `run_id` 재개는 `queued`·`waiting_human`·`blocked_usage`·`interrupted`에서만 되고 `succeeded`·`failed`·`cancelled`는 거부한다. `blocked_usage`를 재개하면 `go_block_reason`·`go_blocked_at`·`go_block_reset_at`을 함께 지운다(DDL의 `go_block_reason IS NULL OR status = 'blocked_usage'` 제약). 재개 payload에 `parent_run_id`나 `role`이 있으면 `invalid_payload`다. 만료된 lease를 대신할 때 그 lease의 run이 아직 `running`이면 같은 tx에서 `interrupted`로 끝내고(`ended_at` 설정) `events.run_id`가 그 옛 run인 interrupt 사건을 남긴다. 이미 끝난 run은 건드리지 않는다. 다음 `fence`가 `Number.MAX_SAFE_INTEGER`를 넘으면 쓰기 전에 `conflict`로 거부한다.
- **가드**: claim을 뺀 모든 run 명령은 `project_leases` 행이 그 프로젝트의 **활성·미만료**(`now < expires_at`) lease이고 `lease_id`·`fence`·`run_id`·소유 행위자가 정확히 같을 때만 통과한다. 아니면 `conflict`이고 아무것도 쓰지 않는다. 만료(`now >= expires_at`)·해제된 lease는 되살리지 않으며, 새 claim만 새 `lease_id`와 더 높은 `fence`를 만든다.
- **heartbeat**: `expires_at = now + lease_ttl_ms`로 연장하고 `fence`는 바꾸지 않는다. 만료 경계(`now == expires_at`)에서는 거부한다.
- **wait**: run을 `waiting_human`으로 바꾸고 lease를 `released`로 놓으며(가드의 `fence`는 보존), 같은 tx에 사건과 영수증을 남긴다. 대기 중에는 다른 run이 claim할 수 있고, 재개는 새 claim·새 `fence`다.
- **complete**: `succeeded`(기본) 또는 `failed`로 run을 끝내고 lease를 놓는다. 승인·봉인·단계 변경은 하지 않는다. `release`·`handoff`는 run을 `queued`, `interrupt`는 `interrupted`로 둔다.
- **입력 영수증**: `applied`는 같은 프로젝트의 `mutation_commits.id`인 `applied_tx_id`가 있을 때만 인정한다. 중복 반영 방지 범위는 **같은 인계 흐름**이다. `parent_run_id` 사슬을 거슬러 뿌리 run을 찾고, 그 뿌리에서 파생된 모든 run(조상·후손·형제)이 이미 `applied`한 입력은 다시 적용하지 않고 `already_applied: true`로 답하며 저장된 `applied_tx_id`를 바꾸지 않는다. 뿌리가 다른 독립 run은 서로 막지 않는다. 인계 뒤 원본 run을 재개하거나 형제 run을 파생해도 같은 흐름에서는 한 번만 반영된다.
- **영수증·사건**: run 명령의 영수증은 `run_id`·`lease_id`·`fence`를, 사건은 `events.run_id`를 남긴다. 거부·검증 실패는 영수증도 사건도 남기지 않는다.
- **설정**: `lease_ttl_ms`·`heartbeat_interval_ms`는 `scripts/pes_core/config.ts`에만 있다. 서비스는 `process.env`를 읽지 않는다. API/CLI 같은 합성 지점이 `resolve_run_config(overrides, process.env)`로 env를 명시해 넘기고, 주입된 `RunConfig`가 없으면 서비스는 설정 기본값만 쓴다. 주입값도 생성자에서 `resolve_run_config(overrides, {})`로 검증·복사·동결하며, 잘못된 값은 생성 시점에 거부한다. 우선순위는 주입값 > env > 기본값이며, 양의 안전 정수만 받고 heartbeat가 TTL보다 짧아야 한다.

### 8.4 내용 버전·출처·연결(PR7)

`scripts/pes_core/commands/content.ts`가 `content.*` 8개 명령을 정의하고, `scripts/pes_core/content.ts`의 공개 함수는 각각 `CommandService.execute` 한 번만 호출한다. 모든 명령은 8절 실행 순서를 그대로 지나며 한 tx다. 같은 파일이 `result.submit`(PR13)도 정의하되 `RESULT_COMMAND_ENTRIES`라는 별도 동결 묶음으로 내보내고, 공개 래퍼 `submit_results`는 `scripts/pes_core/results.ts`에 두어 `content.ts`에서 재수출한다(기존 content 명령 8개 표면을 그대로 유지).

- **결과 묶음(PR13)**: `result.submit` 입력은 `{run_id, lease_id, fence, results:[{op:'append_version', ...}]}`이고 항목은 1~20개다. 각 항목의 `op`는 `append_version`뿐이며 그 밖의 키는 `content.append_version`이 허용하는 필드로 제한한다. 현재 활성·미만료 lease(정확한 `run_id`·`lease_id`·`fence`·소유 actor)를 요구하고, `ctx.base_control_rev`가 있으면 항목 검증 뒤·lease 검사 전에 현재 `projects.control_rev`와 BigInt로 비교한다(낡으면 `rev_conflict`, 아무것도 쓰지 않음). 빈 결과 목록은 rev 검사보다 먼저 `invalid_payload`다. 같은 키·같은 요청은 rev가 바뀌어도 영수증 재생이 우선한다. 모든 항목의 버전 id·번호를 먼저 계획한 뒤 영수증 1행을 쓰고, 같은 tx에서 버전 행들을 쓴다(`object_versions.tx_id`가 그 영수증을 참조하므로 순서가 고정된다). 한 항목이라도 실패하면 영수증·버전·사건이 모두 롤백되고, 성공하면 `result.submitted` 영수증 1행과 항목별 `result.submitted` 사건(`run_id` 포함)을 남긴다. 같은 키·같은 입력은 저장된 결과를 재생하고 같은 키·다른 입력은 `idempotency_key_reuse`다.
- **append-only**: `object_versions`·`artifact_versions`·`source_versions`·`citations`·`version_relations`·`artifact_components`를 UPDATE/DELETE하는 경로가 없다. 새 내용은 `content.append_version`으로만 쌓고 과거 행은 그대로 둔다.
- **현재 포인터**: `objects.current_version_id`는 `content.set_current`로만 옮기며 그 객체 자신의 버전만 가리킨다(다른 객체·다른 프로젝트 버전은 `conflict`/`not_found`). 포인터를 옮겨도 `objects.rev`만 1 증가하고 버전 행은 변하지 않는다.
- **각주**: `citations`는 artifact 버전별 1..n으로 번호를 매기고, 가장 최근 버전(최고 `version_no`)만 새 각주를 받는다. 오래된 버전은 sealed라 `conflict`다. 같은 URL이라도 출처 객체를 합치지 않는다.
- **출처 사실**: `source_versions`에 확인 시점·발췌·위치·방법·판정·확인 행위자를 저장한다. `verified_by_actor_id`는 그 프로젝트 소속이며 비활성화되지 않은(`actors.disabled_at`·`users.disabled_at` NULL) 행위자여야 한다(아니면 `not_found`). `verification_state='unreachable'`인 버전에는 발췌를 붙일 수 없다(`invalid_payload`).
- **연결**: `version_relations`의 from 버전은 그 객체의 최신 버전이어야 하고, 같은 (from,to,kind)는 한 번만 둔다.
- **library**: `content.import_library`는 한 tx에서 항목·출처·각주를 만들고 원본 JSON을 같은 tx의 `content.library_imported` 사건 payload `original`에 보존한다. 같은 library를 다시 가져오면(`library_hash` 동일) 업무 행을 만들지 않고 첫 결과를 돌려준다. 같은 library 정체성(항목 목록을 뺀 메타데이터가 동일) 안에서는 `legacy_id` 기준으로 이미 가져온 항목을 항목별로 건너뛰고 새 항목만 추가한다(부분집합·부분겹침·상위집합 모두). 항목 목록 밖 메타데이터가 다른 library는 별도 가져오기다. `legacy_id`·`kind_original`은 가져오기 고유 필드로 item의 같은 이름 키에 덮이지 않으며, item의 `__proto__` 같은 own 키도 데이터로 보존한다. library의 모든 문자열에 외톨이 서로게이트가 있으면 `invalid_payload`로 아무것도 쓰지 않는다. 파일 바이트 저장은 PR9/11 경계다.
  - **항목 id·비교 키**: 항목 `id`는 0 이상의 안전 정수 또는 비어 있지 않은 문자열이다(실제 library의 id는 정수). 중복·재가져오기 비교는 타입을 붙인 키(`number:5` / `string:5`)로 해서 5와 "5"는 다른 항목이다. `legacy_extra.legacy_id`와 결과 `items`는 원래 값(정수는 정수 그대로)이다.
  - **library 정체성**: 항목 목록과 휘발 키(`imported`·`round`)를 뺀 최상위 메타데이터다. 해시(`shell_hash`)와 항목 비교 키 목록(`item_keys`)을 사건 payload에 따로 두므로 재가져오기 판정은 `original`을 파싱하지 않는다.
  - **건너뛴 가져오기**: 같은 정체성·같은 id지만 내용이 바뀐 파일은 구조 행에 반영하지 않고(옛 내용 유지) 건너뛰되, `content.library_import_skipped` 사건에 그 파일의 `original`과 `library_hash`를 남긴다. 정확히 같은 파일의 반복은 `library_hash`만 남긴다.
  - **제목**: 제목이 없거나 문자열이 아니면 `(제목 없음)`으로 저장하고 원래 값(없었으면 null)을 `legacy_extra.title_original`에 둔다.
  - **`archived_at`**: library 가져오기에서 `status:"removed"`인 항목에만 찍는 가져오기 전용 표시다. `append_version`/`add_artifact`로 status를 바꿔도 `archived_at`은 바뀌지 않는다. 버전 상태가 기준이다.
  - **예정**: library 원본을 사건 payload에 두는 것은 D1 행 2MB 한도 때문에 PR9/11의 blob 경계로 옮길 예정이다.

### 8.5 행위자·토큰·전송 정책(PR10)

`scripts/pes_core/commands/actors.ts`·`commands/policy.ts`가 `token.issue`·`token.revoke`·`policy.set`·`dispatch.prepare`·`dispatch.authorize`·`dispatch.mark_sent`·`dispatch.block` 7개 명령을 정의하고, `scripts/pes_core/actors.ts`·`policy.ts`의 공개 함수는 각각 `CommandService.execute` 한 번만 호출한다. `PolicyChecker.check`는 tx 안의 읽기 전용 `get`/`all` 핸들을 4번째 인자로 받고, 정책 검사는 영수증 재생보다 먼저다. 핸들은 SELECT 또는 최종 문장이 SELECT인 WITH 단일 문장만 받으며(WITH … UPDATE/INSERT/DELETE/REPLACE는 거부, PRAGMA·ATTACH·DETACH·BEGIN/COMMIT/ROLLBACK/SAVEPOINT/RELEASE·여러 문장은 거부), SQLite 연결에서는 검사 동안 `PRAGMA query_only=ON`을 걸었다가 끝나면(예외에도) 원래 값으로 되돌리고, `check`가 끝난 뒤 그 핸들의 `get`/`all`은 예외다. `query_only`를 읽거나 켤 수 없거나 켠 뒤에도 ON이 아니면(어댑터가 무시) 검사기를 실행하지 않고 `policy_denied`로 명령이 실패한다(fail-closed, 영수증·사건 없음).

- **토큰**: `token.issue`는 그 프로젝트의 사람 owner만 실행하고, 대상 행위자는 검증과 같은 자격 규칙(`read_credential_actor`: 활성 행위자·존재하는 활성 사용자)과 그 프로젝트 멤버십을 만족해야 한다(아니면 거부, 행 없음). 원문 비밀은 첫 응답에만 있고, 표·사건·영수증(재생 결과 포함)·오류 메시지에는 SHA-256 해시만 남는다. 범위는 프로젝트, 만료는 생성 시각 + 30일이며 `now >= expires_at`이면 만료다. `token.revoke`는 `revoked_at`만 채우고 행을 지우지 않는다. `verify_agent_token`의 어떤 실패든 원문을 되풀이하지 않는 `forbidden`이다.
- **정책**: `policy.set`은 사람 owner만 실행하고 `project_policy_versions`에 새 행(`policy_rev` + 1)을 append한 뒤 `projects.current_policy_id`를 옮긴다. 이전 정책 행은 바꾸지 않는다. 새 행이 `allow_opencode_go = 0`이면 같은 tx에서 (1) 활성 lease가 mode A(Go) run의 것이면 lease를 `released`로 바꾸고(fence 유지) 그 run이 `running`이면 `interrupted`로 바꾸며 `run.interrupted` 사건(`run_id` 포함, 이유 `policy_off`)을 남긴다. mode B run·끝난 run·이미 해제된 lease는 그대로다. 옛 guard는 OFF 중에도 다시 ON 뒤에도 거부되고, 새 `run.claim`(새 fence) 뒤에만 진행한다. (2) `prepared`·`authorized` 전송을 `blocked`로 바꾸고 `policy.changed` 사건 뒤에 `dispatch.blocked` 사건을 하나씩 남긴다. 단 `authorized`이면서 `sent_at` 또는 `external_request_id`가 있는 행은 이미 나갔을 수 있으므로 `blocked` 대신 `unknown`(증거 보존, `unknown_at`·`unknown_reason` 기록, `dispatch.unknown` 사건)으로 두며 결과의 `blocked_dispatch_ids`·`dispatch.blocked` 사건에 넣지 않는다. `dispatch.block`도 같은 판정이고, 선택과 조건부 UPDATE에 같은 조건을 쓴다. `sent`·`response`·`adopted`·`failed`·`unknown`·`blocked` 이력은 지우거나 고치지 않으며, 다시 허용해도 차단된 전송은 되살아나지 않는다.
- **전송**: `dispatch.prepare`·`authorize`·`mark_sent`는 run 명령과 같은 활성·미만료 lease guard(`run_id`·`lease_id`·`fence`)를 지나고, `dispatch.block`만 guard가 없다. `dispatch.mark_sent`는 `sent`와 `sent_at`만 기록하며 `usage_json`·`cost_json`은 NULL로 둔다(모르는 비용을 0으로 저장하지 않는다). 실제 Go 네트워크 호출은 없다.
- **fail-closed**: 프로젝트 포인터가 NULL이거나 없는 행·다른 프로젝트 행을 가리키거나, 그 프로젝트의 최고 `policy_rev`가 아니거나, `allow_opencode_go`가 정확히 0/1이 아니거나, `mode_a_model`이 `opencode-go/`로 시작하지 않거나, `go_usage_stop_percent`가 50~100 밖이거나, `changed_by_kind`가 `human`이 아니면 정책은 손상이다. `check_go_allowed`는 손상에서도 예외를 던지지 않고 허용하지 않으며, `current_policy`는 `policy_denied`다. Go가 꺼졌거나 정책이 손상되면 `dispatch.prepare`·`authorize`·`mark_sent`는 `policy_denied`이고, `dispatch.block`·`token.*`·`project.*`·`run.*`는 Go 정책에 막히지 않는다. 정상적으로 꺼진 정책에서는 `policy.set`도 실행되지만, **정책이 손상된 경우 `policy.set`도 현재 정책을 먼저 읽기 때문에 `policy_denied`(fail-closed)다.** 손상 복구 절차(사람 전용 복구 명령 등)는 이 PR에 없고 수동 조치·후속 결정으로 남긴다.
- **운영 조립(후속 필수)**: 정책 checker(`DbPolicyChecker`)·토큰 인증(`verify_agent_token`/`resolve_actor`)·scope 집행의 운영 조립은 후속 API/CLI PR에서 필수로 연결한다. 이 PR은 부품과 계약만 제공한다.
- **기본값**: stage-0 7-1 그대로 `policy_rev` 1, `allow_opencode_go` 켜짐, `mode_a_model` `opencode-go/deepseek-v4.1-flash`, `go_usage_stop_percent` 90이다.

### 8.6 결과물·객체 저장(PR9)

`scripts/pes_core/commands/files.ts`가 `file.reserve_upload`·`file.complete_upload`·`file.attach_version`·`file.quarantine`·`file.gc_orphans` 5개 명령을 정의하고, `scripts/pes_core/files.ts`의 공개 함수가 각각 `CommandService.execute` 한 번만 호출한다. `blobs`·`file_policies`·`version_files`의 INSERT/UPDATE/DELETE는 `commands/files.ts`에만 있다.

- **id와 경로**: 공개 결과의 blob 식별자는 서버가 만든 id 하나뿐이다. `storage_key`는 `project_id/sha256`으로 서버가 계산하며, 호출자가 경로·서명 URL·storage_key를 id 대신 넘기면 `invalid_payload`/`not_found`다. 경로는 결과·사건·영수증에 남기지 않는다.
- **정식 저장소 하나**: 저장소는 `CommandServiceOptions.objects_dir`로 생성 때 받은 폴더 하나다. 같은 DB에 다른 폴더로 두 번째 `CommandService`를 만들면 생성이 `conflict`로 실패하고(같은 폴더·같은 경로 표기는 허용), `complete_upload`·`get_blob`·`store_blob`·`gc_orphans`에 넘긴 `store.objects_dir`가 그 폴더와 다르면 아무것도 읽거나 쓰지 않고 `conflict`로 거부한다. `file.gc_orphans` payload는 `{grace_ms}`뿐이며 `objects_dir` 필드는 `invalid_payload`다. 명령은 주입된 저장소만 스캔한다.
- **staging → ready**: `reserve_upload`는 같은 프로젝트에서 `(sha256, size)`가 같은 기존 행을 재사용하고(다른 프로젝트면 별도 행·별도 파일), `complete_upload` 명령은 주입된 저장소에서 그 blob의 실제 바이트를 다시 읽어 sha256·size를 계산해 예약값과 비교한다. 저장소가 주입되지 않았거나 바이트를 읽을 수 없으면 ready가 되지 않고(거부), 예약값과 다르면 `quarantined`다. 호출자가 직접 보낸 `sha256`·`size`는 신뢰하지 않는 주장으로, 예약값과 다를 때만 `quarantined`를 부를 수 있고 ready의 근거가 되지 않는다. 공개 `complete_upload`는 `{blob_id}`만 보낸다. `store_blob`은 `staging` blob에 쓰고, 파일이 없는 `ready` blob은 예약값과 같은 바이트로만 복구하며, 길이·sha256이 예약값과 다르면 쓰기 전에 거부한다. 임시 파일+rename으로 실패 잔여물을 남기지 않는다.
- **계보와 정책**: `attach_version`은 `ready` blob만 받아 `version_files`에 (version, blob, role) 한 행을 만든다. blob마다 `file_policies` 한 행을 만들어 모든 버전·role이 공유하며, 같은 (version, blob, role)은 `conflict`다.
- **격리·gc**: "연결됨"은 `blobs`를 참조하는 모든 FK 표를 뜻한다 — `version_files`, `file_policies`, `snapshots`, `artifact_versions`, `source_versions`, `file_extractions`(blob_id·text_blob_id), `sync_items`, `submissions`, `outbound_dispatches`(manifest·response), `import_batches`(source_manifest·report). 연결된 blob은 격리·삭제하지 않는다. `gc_orphans`는 한 tx에서 참조 없는 `staging`/`quarantined` 행(마지막 예약 시각 기준 grace 초과)을 지우고, 참조 없는 오래된 파일과 그 blob 파일은 tx 커밋 뒤에 지운다. 삭제 직전 같은 동기 구간에서 `storage_key`를 다시 조회해 행이 생겼으면 지우지 않는다(고아 파일도 파일마다 확인). 파일 스캔과 삭제는 objects 루트와 프로젝트 폴더를 삭제 전에 `lstat`해 symlink면 아무것도 지우지 않는다. tx가 실패하면 디스크를 건드리지 않고, 삭제가 실패하면 다음 gc가 DB와 디스크를 맞춘다. 파일이 없는 `ready` blob은 지우지 않고 `missing_file_blob_ids`로 보고한다.
- **경로 안전**: `storage_key`는 objects 폴더 아래 이 프로젝트 폴더로만 풀린다. 절대 경로·`..`·드라이브 문자·역슬래시와 objects 폴더·프로젝트 폴더·대상 파일의 symlink는 읽기·쓰기 모두 거부한다. `EACCES`·`ENOENT` 같은 파일 시스템 오류는 절대 경로나 저장소 폴더를 담지 않는 고정 문구의 `ApiError("conflict")`로 바꾼다.

### 8.7 판·단계·라운드(PR6)

`scripts/pes_core/commands/editions.ts`가 `edition.create`·`round.start`·`round.seal`·`stage.approve`·`stage.reopen`·`edition.release_completion`·`edition.carry_over`·`edition.snapshot` 8개 명령을 정의하고, `scripts/pes_core/editions.ts`의 공개 함수는 각각 `CommandService.execute` 한 번만 호출한다. 예외는 읽기 전용 `open_tasks_for_round(db, project_id, round_id)` 하나이며 쓰지 않는다. 판·단계·라운드·스냅숏·승인·이월 표의 INSERT/UPDATE는 `commands/editions.ts`에만 있다.

- **사람 규칙(PR10)**: `edition.create`·`stage.approve`·`stage.reopen`·`edition.release_completion`·`edition.carry_over`는 `read_credential_actor` 기준 `kind='human'`이면서 `project_members.role='owner'`인 행위자만 실행한다. owner의 user를 공유하는 에이전트도 `forbidden`이다. `round.seal`·`edition.snapshot`은 사람 멤버면 되고, 에이전트는 `run_id`·`lease_id`·`fence`가 그 프로젝트의 활성·미만료 lease와 정확히 같을 때만 된다(없으면 `forbidden`, 낡은 fence·해제된 lease는 `conflict`). 에이전트의 `round.seal`은 guard의 run이 그 라운드에 속할 때만(아직 조준하지 않은 run — `stage_id`·`round_id`가 NULL — 은 첫 봉인 때 같은 tx에서 그 단계·라운드에 묶이고, 이후 다른 단계·라운드 봉인은 `forbidden`이며 아무것도 쓰지 않는다), `edition.snapshot`은 `scope='stage'`면 그 단계, `scope='edition'`이면 그 판에 속할 때만 된다(아니면 `forbidden`). 가드가 있는 호출의 영수증은 `run_id`·`lease_id`·`fence`를, 사건은 `run_id`를 남긴다.
- **판·라운드**: `edition.create`는 `edition_no = max+1`, `status='draft'`, 정확히 6개 `pending` 단계(plan~publish, ordinal 1~6)를 만들고 `current_stage_id`만 plan으로 두며 활성 판을 바꾸지 않는다. `round.start`는 활성 판의 단계만 받고, ordinal이 더 작은 모든 단계가 `approved`이면서 `stale_since_event_seq`가 NULL이어야 하며(하나라도 아니면 `conflict`), 단계당 열린 라운드는 하나다. `round_no = max+1`, `base_snapshot_id`는 그 단계의 최신 봉인 스냅숏(없으면 NULL), 단계는 `active`가 된다. 승인된 단계라도 자기 `stale_since_event_seq`가 있으면 새 라운드를 시작할 수 있고, 신선한 승인은 `conflict`다.
- **봉인**: `round.seal`은 승인 전에도 가능하다. 판이 `active`이고 라운드가 `open`이며 manifest blob이 그 프로젝트의 `ready` blob이고 모든 `(object_id, version_id)`가 그 객체의 실제 버전일 때 한 tx로 `rounds.state='sealed'`·`sealed_snapshot_id`, `snapshots(scope='round')`, `round_contents(position 순서, role='result')`를 쓴다. `versions`는 비어 있을 수 없고(빈 목록은 `invalid_payload`), `content_hash`는 정확한 버전 목록과 순서의 함수라 같은 목록은 같은 해시, 다른 버전은 다른 해시다. 봉인은 승인이 아니다.
- **승인·reopen**: `stage.approve`는 판이 `active`이고 ordinal이 더 작은 모든 단계가 `approved`이면서 stale이 아니며, 그 단계의 현재 라운드가 봉인되었고 `sealed_snapshot_id`가 인자와 같을 때만 `approvals(origin='new', assurance='verified', actor_kind='human', tx_id=영수증)`를 남기고 단계를 `approved`로 만든다. 단계가 reopen되었거나 앞 단계 reopen으로 stale이면, 그 무효화 사건 이후에 봉인된 스냅숏만 승인에 쓸 수 있다(`snapshots.through_event_seq`가 무효화 `event_seq` 이상). 옛 봉인 스냅숏은 `conflict`이고 승인 행도 쓰지 않는다. 다음 단계가 `pending`이면 `asking`으로 열고 `editions.current_stage_id`를 옮기며, 마지막 단계면 판을 `completed`로 끝낸다. `stage.reopen`은 `active` 또는 `completed` 판의 `approved` 단계만 받아 그 단계를 `active`로 되돌리고, 뒤 단계 중 `pending`이 아닌 모든 단계의 `stale_since_event_seq`를 이 명령의 `stage.reopened` 사건 번호로 바꾼다. 승인 행과 뒤 단계의 `approved_snapshot_id`는 유지한다. 뒤 단계의 `queued`·`waiting_human`·`blocked_usage`·`interrupted` run은 `cancelled`(ended_at=now)로 끝내고 run마다 `run.invalidated` 사건을 남긴다. 뒤 단계의 `running` run도 `cancelled`(ended_at=now)로 끝내 `claim({run_id})`로 옛 기반에서 재개할 수 없게 하고, 그 run이 프로젝트의 활성·미만료 lease를 쥐고 있으면 같은 tx에서 lease를 `released`로 놓으며 `run.invalidated` 사건(run_id 포함)을 남긴다. 끝난 run은 그대로 둔다. 완료된 판은 같은 tx에서 `active`로 돌아간다. stale이 자기 사건을 가리키도록 이 tx에서만 `PRAGMA defer_foreign_keys=ON`을 쓰고, 사건은 서비스가 COMMIT 전에 쓴다.
- **완료 해제·스냅숏**: `edition.release_completion`은 `completed` 판만 `active`로 되돌리며, 완료가 아니거나 다른 활성 판이 있으면 `conflict`다. `edition.snapshot`은 `scope='edition'|'stage'` 스냅숏을 만들고, manifest blob·버전 검사와 해시는 봉인과 같다(빈 `versions`는 `invalid_payload`). `through_event_seq`는 그 명령이 실행될 때 존재하던 마지막 사건 번호, `control_rev`는 `projects.control_rev`다. 스냅숏 행은 나중에 새 버전이 생겨도 바뀌지 않는다.
- **이월 두 갈래**: `edition.carry_over`의 `kind='topic'`은 `artifacts(kind='topic')`의 정확한 `source_version_id`에서 새 artifact 객체·버전 1·`artifacts(origin_version_id=source_version_id)`·`version_relations(derived_from)`를 만든다. 원본과 그 뒤 버전은 바뀌지 않는다. `kind='tasks'`는 같은 판 안에서 `from_stage`보다 뒤 단계로만 이월하며(다른 판이면 `conflict`), 현재 버전이 `next_round_task`이고 `target_stage_id=from_stage`이며 상태가 `proposed`·`accepted`·`running`·`deferred`인 follow-up마다 `version_no+1`, `based_on_version_id=옛 버전`, 같은 kind/state/description/base/proposed, `target_stage_id=to_stage`, `target_round_id=NULL`인 새 버전을 붙이고 객체의 현재 포인터를 옮긴다. `applied`·`rejected`·`cancelled`는 이월하지 않고, `followups.origin_*`는 건드리지 않는다. 다음 라운드의 R1 목록은 `open_tasks_for_round`가 읽는다.
- **세 사건의 분리**: `run.complete`는 `run.completed`, `round.seal`은 `round.sealed`, `stage.approve`는 `stage.approved`를 남기며 서로의 상태를 바꾸지 않는다. 거부·검증 실패는 영수증도 사건도 남기지 않고, 모든 성공 명령은 영수증과 사건을 같은 tx에 남긴다.

### 8.8 질문·답(PR8)

`scripts/pes_core/commands/questions.ts`가 `question.publish_set`·`question.revise`·`answer.submit` 3개 명령을 정의하고, `scripts/pes_core/questions.ts`의 공개 함수는 각각 `CommandService.execute` 한 번만 호출한다. 읽기 전용 `validate_submission`·`resume_ready`는 직접 SQL을 읽기만 하며 쓰지 않는다. 질문·답 표의 INSERT/UPDATE는 `commands/questions.ts`에만 있다.

- **본 버전 고정**: 제출은 그 폼(`question_sets`)의 구성원과 사람이 실제로 본 질문 버전(`question_set_members.question_version_id`)에 고정된다. 질문이 그 뒤 개정되어 구성원 버전이 현재 버전과 다르면 낡은 폼으로 보고 `conflict`로 거부한다(아무것도 쓰지 않음).
- **개정·재확인**: `question.revise`는 새 질문 버전을 append하고 `objects.current_version_id`만 옮긴다. 옛 버전 행·옛 답·옛 폼 구성은 그대로 두며, 새 버전은 옛 답을 승계하지 않는다. `resume_ready`는 현재 답 버전이 `submitted`이면서 질문의 현재 버전에 고정된 경우에만 충족으로 본다. 옛 버전에만 답이 있으면 `needs_reconfirmation`, 답이 없으면 `unanswered`다.
- **덧붙임**: `other`(레거시 `__other`)는 답 값이 아니다. `allow_comment_as_answer=1`인 질문에서만 덧붙임만으로 답 버전(`value` JSON null)을 만들고, 아니면 답 없이 최소 `threads`/`messages`/`message_versions` 행으로만 보존한다. 새 질문 스펙에서 이 필드를 생략하면 0(덧붙임만으로는 답이 아님)이다. `__other`가 추천 선택지 동의로 바뀌지 않는다.
- **기본값·추천**: 서버는 답 초안을 만들지 않는다. `used_default`는 사람이 기본값을 골랐고 제출 값이 그 기본값과 같을 때만 1이며, 보내지 않으면 0이다. 추천 선택지는 평범한 선택일 뿐 자동 답이 되지 않는다.
- **묶음 원자성**: 한 제출의 제출 행·답 버전·의견 스레드는 한 tx다. 한 항목이라도 잘못되면 제출·답·의견·영수증·사건이 모두 롤백된다. 같은 키의 재요청은 저장된 결과를 재생하고, 실패한 시도는 영수증을 남기지 않아 같은 키로 다시 실행할 수 있다.
- **판·라운드 경계**: 게시는 stage의 판이 `active`이고 프로젝트의 활성 판과 같으며 라운드가 `open`일 때만, 제출은 세트의 판이 `active`이고 세트 라운드가 봉인되지 않았으며 그 `(stage_id, form_key)`의 최신 세트일 때만 된다. 아니면 `conflict`다.
- **필수 답**: `required=1` 질문에 빈 문자열·공백뿐인 문자열·빈 배열을 보내면 `invalid_payload`이고 묶음 전체를 거부한다.
- **읽기 함수 계약**: `resume_ready`·`validate_submission`은 행위자·멤버십을 스스로 확인하지 않는 읽기 함수다. 이들을 노출하는 API/CLI 층이 프로젝트 멤버십과 행위자를 먼저 확인해야 한다.
- **stage_start 세트**: `round_id`가 NULL인 stage_start 세트는 어느 라운드에도 속하지 않으므로 `resume_ready`의 라운드 재개 판정 밖이다.
- **행위자**: `question.publish_set`·`question.revise`는 사람 멤버 또는 활성 lease guard(`run_id`·`lease_id`·`fence`)를 가진 에이전트만, `answer.submit`은 사람만 실행한다. 에이전트는 lease가 있어도 답할 수 없다.

### 8.9 legacy 이전(PR11)

`scripts/pes_core/commands/legacy.ts`가 `legacy.import_project` 하나를 정의하고, `scripts/pes_core/legacy.ts`의 `scan_project`·`import_project`·`map_legacy`·`report_unknown`이 공개 경계다. 이전 폴더는 **읽기만** 하며, 원본 삭제·수정·잠금 파일 생성 경로가 없다.

- **단일 tx·닫힌 명령**: `legacy.import_project`는 프로젝트가 아직 없는 `owner` 범위 명령이다. 실행자는 존재하는 사람 owner actor여야 하고(아니면 `forbidden`, 행 없음), `via='import'`와 한 tx로 프로젝트·owner 멤버·초기 정책(`policy_rev=1`, `reason='legacy default'`)·1판·6단계·라운드·스냅숏·승인·객체·버전·출처·질문·답·제출·스레드·이월·blob·`import_batches`·`legacy_mappings`·사건·영수증을 남긴다. 그 밖의 업무 표 쓰기 SQL은 이 명령 파일에만 있다(blob·`file_policies`·`version_files`는 아래 파일 항목처럼 PR9 정의를 재사용한다).
- **멱등**: `source_fingerprint`(폴더 manifest의 sha256)가 같으면 기존 배치를 그대로 돌려주고 새 행을 쓰지 않는다. 같은 요청 키의 재실행은 서비스 영수증 재생으로 끝나며, 실패 배치도 `failed`로 재생된다. 원본이 바뀌면 새 지문·새 배치다.
- **활성화 없음**: 배치는 항상 `staging`(또는 `failed`)이고 프로젝트도 `staging`이다. `complete=true`는 1판을 `completed`로 끝내고 활성 판 포인터를 NULL로 둘 뿐, 프로젝트를 활성화하지 않는다. 검증·활성화는 PR12가 맡는다. `complete=true`인데 publish 단계가 `approved`가 아니면 승인 행을 만들지 않고 판만 `completed`로 두며 `edition.settings_json.legacy_extra.legacy_unverified`로 표시한다(시험 4l 해석, map 59행과 차이).
- **정직한 표식**: 옛 승인은 `origin='legacy'`·`assurance='legacy_unverified'`·`actor_kind='legacy_unknown'`·`human_user_id=NULL`이고, 모든 이전 객체 버전은 `legacy_unknown` actor가 쓴다. `feedback.who`에서 가짜 사람을 만들지 않으며, 초기 정책 기본값을 과거 동의(결정·가정·답·`new` 승인)로 기록하지 않는다. 미지 값은 `legacy_extra`/`report_blob_id` 보고서에 남긴다.
- **파일**: blob·`file_policies`·`version_files` 쓰기는 PR9 `commands/files.ts` 명령 정의를 같은 tx 안에서 재사용한다. 예약→저장→완료 순서로 저장소 바이트를 다시 읽어 측정하고, 측정이 예약과 다르면 ready가 아니라 `quarantined`다. `project.json.tmp`는 본 파일과 다르면 격리하고 채택하지 않는다. `.pes-lock`·`.pes-port`·`.pes-server`와 재생성 파일은 manifest의 경로·sha256에만 두고 blob으로 만들지 않으며 fingerprint에서도 제외한다. tx가 늦게 실패해 남은 고아 객체 파일은 `file.gc_orphans`로 정리한다. `map_legacy`·`report_unknown`은 `get`/`all`과 blob 읽기만 하는 읽기 전용이며, 이전 폴더의 절대 경로는 결과·사건·보고서에 남지 않는다.
- **이월**: `carry_over[]`는 `next_round_task`·`state='proposed'`·`target_round_id=NULL`로 보존한다. `target_stage_id`는 `from`이 아니라 **담은 단계의 다음 단계**(plan→research→analyze→write→verify→publish)이고, `base_artifact_version_id`는 담은 단계 항목의 이전 버전이다. `from` 원문은 `stages.settings_json.legacy_extra.carry_over`에 남긴다. publish처럼 다음 단계가 없으면 행을 만들지 않고 원문을 보고서에 남긴다. 다음 R1 조회는 PR6 `open_tasks_for_round`가 읽는다.
- **스냅숏·질문·라운드 파일(최종 리뷰 1/2)**:
  - 정상 스냅숏의 `state.items`는 당시 항목 버전으로 옮기고 그 라운드 `round_contents`가 정확한 버전을 가리킨다. 현재 항목과 canonical record가 같으면 현재 버전을 재사용하고, 다르면 같은 객체의 과거 버전(`version_no` 앞쪽, 현재가 마지막)으로 두며 출처·연결도 그 버전에 붙인다. 깨진 스냅숏은 추측하지 않는다.
  - 질문 내부 키는 폼·발생 위치로 구분한다. 같은 단계·id·record의 질문만 명시 재사용하고, 내용이 다르면 별도 객체다. 세트 구성원과 `legacy_mappings`는 각 폼의 정확한 버전이다. `review.questions`도 폼으로 색인해 `feedback`의 kind·spec·stage·round로 실제 본 세트를 찾아 답·`__other` 덧붙임을 연결하고 제출에 그 세트를 단다. 찾지 못할 때만 import placeholder를 만든다.
  - `items[].path`는 안전한 상대 경로만 읽어 `rendered`로 연결하고, 없거나 안전하지 않으면 `missing_file`과 `legacy_extra.missing_paths`로 남긴다(안전하지 않은 경로는 중립화).
  - `rounds/<stage>-R<n>/qa.json`은 그 라운드 review artifact(`metadata.qa`)다. 결과 JSON은 canonical hash가 항목 record와 같을 때만 `source`로 연결하고, 아니면 원문 blob만 두고 `unmapped_input`으로 보고한다.
  - 출처·`user_links`의 미지 하위 필드는 `locator.legacy_extra`에 보존하고 JSON 포인터로 `unknown_field`를 남긴다.

### 8.10 이전 검증·활성화·되돌리기(PR12)

`scripts/pes_core/migration.ts`가 공개 경계(`validate_import`·`activate_import`·`rollback_before_write`·`restore_project`·읽기 전용 `serving_path`)이고, 쓰기 SQL은 `scripts/pes_core/commands/migration.ts`의 닫힌 명령 4개(`legacy.validate_import`·`legacy.activate_import`·`legacy.rollback_before_write`·`legacy.restore_project`)에만 있다. 모두 `owner` 범위 명령이며 실행자는 **그 프로젝트의 사람 owner**여야 한다(에이전트·옛 작성자·다른 프로젝트의 사람·모르는 actor는 `forbidden`, 행 없음). 한 단계 = `service.execute` 1회 = 한 tx. 호출마다 새 요청 키를 쓰므로(검증은 다시 돌릴 수 있어야 한다) 영수증 재생에 기대지 않고, 상태 전이표가 중복 실행을 `conflict`로 막는다.

- **상태 전이**(스키마 값만 쓴다, `rolled_back` 없음):

  | 명령 | 배치 상태 → | 프로젝트 |
  |---|---|---|
  | validate (문제 없음) | staging·validated → validated | staging |
  | validate (문제 있음) | staging → staging, validated → **staging**(더는 믿을 수 없다) | staging |
  | activate | validated → activated | active |
  | rollback_before_write | staging·validated·activated(새 쓰기 없음) → **failed** | **archived** |
  | restore_project | 번들 시점의 상태로 | 번들 시점의 상태로 |
  | 그 밖 | `conflict`, 아무것도 안 바뀐다 | |

  failed·activated 배치의 validate, staging 배치의 activate, failed 배치의 rollback은 `conflict`다. 같은 원본을 다시 가져오면(PR11) 영수증 재생이 옛 결과(staging)를 돌려주므로, `import_project`가 `CommandService.read`(SELECT 전용 핸들, 내부 전용 — HTTP로 노출하지 않는다)로 **현재 배치 상태**(`staging`·`validated`·`activated`·`failed`)를 읽어 알린다. rollback된 배치는 `failed`이며 되살리지 않는다. 되돌린 프로젝트는 slug를 그대로 쥐고 있어 **같은 slug로는 다시 가져오지 못한다**(새 배치가 `slug_conflict`로 `failed`) — 고친 원본을 다시 가져오는 흐름은 PR22 전에 정한다.
- **validate_import**: `import_batches.source_fingerprint`가 지금 원본 폴더의 지문과 같을 때만 비교한다(다르면 `source_changed` 문제만 나열). 같으면 원본에서 다시 만든 계획(`build_validation_plan`, 읽기 전용)을 DB와 맞춘다. `counts`(표·단계별·역할별 개수, 프로젝트 전체 `blobs`와 `submissions` 개수 — 계획에 없는 blob·제출이 더 있으면 문제)·`bodies`(제목·요약·본문·질문·답·메시지·이월 설명을 hash로, 버전 `content_hash`)·`ids`(계획의 모든 `legacy_mappings`가 같은 자리로 풀리는지, 배치의 모든 mapping 행이 실제 행으로 풀리는지)·`links`(관계·인용·라운드 내용·이월·스레드·세트 구성원이 같은 프로젝트의 행을 가리키는지)·`footnotes`(`citation_no`)·`files`(blob 행 ↔ 원본 바이트 sha256/크기, 디스크 파일 바이트, 첨부 행)·`unprocessed_answers`(`processed`에 없는 `feedback/*.json`의 제출·답 개수)·`reports_regeneration`(`reports/<단계>/report.md·html`을 다시 만들어 비교; **보고만, 문제가 아니다**)·`source_changed`. 문제가 있어도 던지지 않고 `ok=false`와 문제 목록(최대 500)을 돌려주며 사건 `legacy.import_validation_failed`를 남긴다. 사건·결과에는 원본의 절대 경로를 넣지 않는다. 보고서 재생성은 PR16 TS 보고서 생성기 전까지 같은 계획에서 만든 구조만 같은 최소 형태라 옛 보고서와는 대개 다르다(`matches=false`). 그래서 결과에 `regeneration_format: "provisional"`을 붙여 임시 형식의 비교임을 알리고, PR16이 실제 생성기로 바꿀 때 불일치를 문제로 올린다.
- **activate_import**: 검증을 통과한(validated) 배치만. 직전 `legacy.validate_import` 영수증 뒤에 `legacy.*`가 아닌 업무 쓰기가 그 프로젝트에 있으면(project 명령은 프로젝트 상태를 보지 않으므로 staging 프로젝트에도 쓰기가 들어갈 수 있다) `conflict`이며 다시 검증하라고 안내한다. 백업 폴더가 PES 홈 안·그 부모, OneDrive 폴더(경로 마디가 `OneDrive…`), 객체 저장소 안이면 `invalid_payload`이고 아무것도 쓰지 않는다. 같은 tx 안에서 **그 프로젝트 하나**를 PR3 번들로 내보내(`export_project_in_tx`, 상태를 바꾸기 전 모습) `verify_bundle`로 확인한 뒤에야 상태를 바꾼다. 번들을 못 쓰면 활성화되지 않는다. 경로는 모두 인자로 받고 환경 변수·`~/`·실제 홈은 읽지 않는다.
- **rollback_before_write**: 활성화 뒤 새 쓰기(영수증 `legacy.*`가 아닌 `mutation_commits`)가 하나라도 있으면 `conflict`이며 `restore_project`를 안내한다. 이전 증거(`legacy_mappings`·staging 행)는 지우지 않고 보관한다. 원본 폴더는 건드리지 않는다.
- **restore_project**: 프로젝트 하나를 PR3 번들의 상태로 되돌린다. 번들은 `verify_bundle`·manifest·행·blob 행↔객체 파일 대조를 통과해야 하고(다른 프로젝트의 번들·다른 DB의 번들·손상·없는 번들은 거부), 한 tx 안에서 그 프로젝트의 행만 지우고 번들 행을 넣는다(다른 프로젝트는 그대로, `users`·`actors`는 비교도 교체도 하지 않고 지금 행 그대로 둔다 — 이름이 바뀌거나 비활성화돼도 복원이 막히지 않고, 없는 행만 더한다. `database_instance_id` 유지, `cursor_epoch + 1`). 전부 아니면 전무: 외래 키가 깨지면 파일을 만지기 전에 거부한다. 객체 파일은 PR9 helper로 번들 바이트에 맞춘다: ① 다른 파일을 모두 같은 폴더의 임시 파일에 먼저 쓴다(tx 안 — 하나라도 실패하면 임시 파일을 지우고 행도 롤백하므로 원래 파일은 그대로) ② 행이 커밋된 뒤에만 rename으로 바꾸고 번들에 없는 파일을 지운다. 커밋 뒤 rename이 실패하면 `conflict`로 알리며 `details`에 `rows_restored: true`, `failed_files`와 함께 `lost_writes`·`reverted_steps`·`cursor_epoch_before`·`cursor_epoch_after`를 담는다(사건 `legacy.project_restored`에도 `lost_writes`가 남는다). 같은 번들로 복원을 다시 하면 파일을 마저 맞춘다(그때 결과의 `lost_writes`는 첫 복원에서 이미 사라졌으므로 비어 있다). **전제**: 복원은 `pes stop`(서버·CLI가 DB를 열고 있지 않은 상태) 뒤에 한다. 행 커밋과 파일 교체 사이에 중단되면 행은 번들, 파일은 옛것인 채로 남으므로 같은 복원을 다시 실행한다. 결과는 번들 뒤에 있던 업무 쓰기(`lost_writes`, 오래된 순)와 함께 되돌려진 이전 단계(`reverted_steps`, 예 `legacy.activate_import`), 커서 세대 전후(10진 문자열)를 알린다. 번들 뒤의 감사 기록(영수증·사건)은 번들의 것으로 바뀌므로 복원 사건 `legacy.project_restored`에 손실 목록을 함께 남긴다. 활성화 직전 번들로 돌아가면 파일럿 이후 기록이 사라진다.
