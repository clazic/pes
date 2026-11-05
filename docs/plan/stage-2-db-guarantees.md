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
- **busy_timeout**: 5000ms로 두고 실제 값을 확인한다. 짧은 tx(`BEGIN IMMEDIATE`)와 함께 쓴다.
- **WAL**: 파일 DB는 `PRAGMA journal_mode=WAL`을 적용하고 `wal`인지 확인한다. `:memory:`는 건너뛴다. WAL의 `-wal`/`-shm` 파일은 SQLite가 만드는 연결 부산물이다.
- **부모 폴더**: DB 파일의 부모 폴더만 `mkdir -p` 한다. 객체 폴더·세션·토큰·백업 등 다른 파일은 PR1이 만들지 않는다.
- **정수는 bigint**: 모든 prepared statement에 `setReadBigInts(true)`를 적용한다. SQLite INTEGER는 `number`로 읽지 않는다. 2^53 초과 값의 손실을 막기 위해 `2^53+1` 왕복을 시험한다. API의 10진 문자열 계약은 PR13이 이 위에 얹는다.
- **tx 콜백은 동기만**: native async 함수는 `BEGIN` 전에 거부하고, 동기 함수가 thenable을 반환하면 롤백·오류로 처리한다. 반환된 thenable은 실행하지 않으며, unhandled rejection 방어는 native `Promise`에만 내장 rejection 핸들러를 붙인다. tx는 동기 콜백 계약이며, 콜백이 스스로 시작한 비동기 작업(이미 생성된 Promise의 후속 실행)은 취소할 수 없다 — 타입(`never`)과 실행 전 async 거부로 막는다.
- **PES_HOME**: 프로젝트 폴더만 옮긴다. DB `~/.pes/pes.db`·객체 `~/.pes/objects/` 경로는 바뀌지 않는다(stage-2 2.7). `PES_DB`·`PES_OBJECTS` 우회 변수는 PR1에 없다.

## 7. bootstrap이 만드는 행과 만들지 않는 것

`bootstrap_project(db, input, deps)`는 **한 tx**에서 아래를 만든다. 어느 한 행이라도 실패하면 전부 롤백한다.

- `users` 1행(owner), `actors` 1행(`kind='human'`, owner user), `projects` 1행(`status='staging'`으로 시작해 마지막에 `active`), `project_members` 1행(`role='owner'`).
- `mutation_commits` 1행. `project_policy_versions.tx_id`가 NOT NULL FK라 최소 행이 필요하다. **영수증 재생·멱등·events·명령 서비스는 PR4 범위**이며 여기서 구현하지 않는다.
- `project_policy_versions` 1행(`policy_rev=1`, `allow_opencode_go=1`, 기본 모델·문턱 90, `changed_by_kind='human'`).
- `editions` 1행(`edition_no=1`, `status='active'`)과 `stages` 6행(`plan`~`publish`, `ordinal` 1~6, `status='pending'`).
- `counters` 9행(객체 kind별 `next_no=1`).
- 포인터: `editions.current_stage_id`=plan 단계, `projects.active_edition_id`, `projects.current_policy_id`, `projects.status='active'`.

만들지 않는 것: **열린 라운드**(PR6), **events**, **영수증 재생**, **명령 서비스**. `PR13`의 `project.create`가 이 기본기를 API 계약으로 감싼다.
