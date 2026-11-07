# 0018. 로컬 D1 호환 smoke는 miniflare 4 안정판을 직접 고정해 돌린다

- 날짜: 2026-11-08
- 담당: SEL-35 (2단계 PR2)
- 관련: [0016-core-language.md](0016-core-language.md)의 WEB0 로컬 D1 측정, [stage-2-linear.md](../issues/stage-2-linear.md) PR2

## 문제

2단계의 상태 원본은 로컬 SQLite(`node:sqlite`)지만, 같은 마이그레이션과 대표 명령이 Cloudflare D1에서도 같은 성공·실패 의미를 내는지 미리 확인해야 한다. 운영 D1·Cloudflare 계정·원격 접속은 쓰지 않고 로컬에서만 재현할 도구가 필요하다.

D1은 SQLite와 같은 SQL 엔진을 쓰지만 API·실행 경계에서 차이가 있다. 큰 정수를 `bigint`로 바인딩할 수 없고, `sqlite_version()` 같은 함수가 막혀 있으며, deferred FK 위반의 오류 모양이 다르고, `exec()`는 줄 단위로만 실행된다. 또 0행 변경을 조용히 성공으로 넘기면 batch 안의 앞선 변경까지 커밋되므로, 실패를 batch 안에서 만들어 전체를 롤백시켜야 한다. 한편 `wrangler` 최신판은 miniflare 5 베타를 끌고 와 재현성이 흔들린다.

## 선택지

1. **`wrangler`의 로컬 D1(`wrangler dev --local`)을 쓴다.** Cloudflare 공식 도구지만 `wrangler` 4.157.0이 miniflare 5 베타를 의존성으로 끌고 와, 안정판 4의 동작을 고정하기 어렵다.
2. **`miniflare` 4 안정판을 `tests/d1`의 개발 의존성으로 직접 고정하고, `getD1Database()`가 주는 D1 바인딩을 쓴다.** `wrangler` 없이 같은 로컬 workerd D1을 실행하고, 테스트가 설치 여부를 확인해 없으면 이유를 남기고 건너뛴다.
3. **운영 D1 또는 원격 preview D1에 시험한다.** 실제 계정·비밀값·네트워크가 필요하고, 시험이 운영 상태를 건드릴 수 있어 금지 범위다.
4. **`node:sqlite`만 시험하고 D1은 나중에 본다.** SQLite와 D1의 차이(바인딩·함수·오류·실행 단위)를 지금 잡지 못한다.

## 채택

**2번.**

- `tests/d1/package.json`에 `miniflare` **4.20260730.0**을 고정한다. `wrangler`는 넣지 않는다.
- `scripts/pes_core/d1_smoke.ts`는 miniflare를 import하지 않고 `prepare`·`bind`·`batch`만 있는 최소 `D1Like`를 받는다. 실제 D1 바인딩과 로컬 miniflare 바인딩이 같은 모양을 만족한다.
- 마이그레이션은 `split_sql`로 문장을 나눠 **한 번의 batch(=한 tx)** 로 적용한다. 대표 명령도 `run_batch`의 한 번의 batch로 실행하고, `require_change` 문장 뒤에는 같은 batch 안에 0행 가드를 붙인다.
- CI job `d1-smoke`는 `ubuntu-latest`·Node 26에서 루트와 `tests/d1`을 각각 `npm ci`한 뒤 `PES_D1_SMOKE=1 node --test tests/test_d1_smoke.test.ts`를 실행한다. 비밀값·Cloudflare 토큰은 쓰지 않는다.
- 같은 시나리오를 `node:sqlite`(참조 엔진)로도 돌려 성공·실패 의미가 같은지 비교한다.

## 이유

- **계정·네트워크 없이 로컬 D1을 그대로 쓴다.** miniflare는 로컬 workerd에서 D1 바인딩을 만들고, 테스트는 메모리 저장소만 쓴다(`persist` 없음). 운영 D1·Cloudflare 계정에 접근하지 않는다.
- **재현성이 높다.** `wrangler` 4.157.0은 miniflare 5 베타를 끌고 오므로, 안정판 4를 직접 고정해야 같은 마이그레이션·batch 의미를 반복 측정할 수 있다.
- **도구 경계가 좁다.** `d1_smoke.ts`가 miniflare를 모르므로 나중에 Worker의 실제 `D1Database`를 그대로 넣을 수 있고, 테스트 도구가 없는 환경에서는 D1 부분만 이유를 남기고 건너뛴다(`PES_D1_SMOKE=1`이면 실패).
- **0행을 성공으로 흘리지 않는다.** `changes()`와 고유 오류 표식을 쓰는 가드 문장을 같은 batch에 넣어, 0행이면 batch 자체가 실패하고 앞선 변경도 함께 롤백된다. 가드 판별은 오류 문구에 `bad JSON path: 'PES_D1_ZERO_ROWS_GUARD['` 모양이 있을 때만 하므로, 사용자 문장이 스스로 낸 정수 overflow를 0행 실패로 오보하지 않는다.

### SQLite와 D1의 차이·실행 제한 (2026-11-08 로컬 측정)

| 항목 | SQLite(`node:sqlite`) | 로컬 D1(miniflare 4.20260730.0) | PES 대응 |
|---|---|---|---|
| `bigint` 파라미터 | 그대로 바인딩 가능 | `D1_TYPE_ERROR: Type 'bigint' not supported for value '…'` | `run_batch`가 실행 전에 `TypeError`로 거부. 큰 정수는 10진 문자열로 넘긴다. |
| `sqlite_version()` | 사용 가능 | `D1_ERROR: not authorized to use function: sqlite_version` | D1 경로에서는 버전 함수 대신 `db_meta.schema_version`으로 판단한다. |
| deferred FK 누락 | `FOREIGN KEY constraint failed` | `Durable Object was reset and rolled back…` 형태의 내부 오류 | 오류 문구를 해석하지 않고 reject를 그대로 전달하며, 롤백은 표를 다시 읽어 확인한다. 0016의 WEB0에서는 `internal error; reference=…`로 관측됐다([0016-core-language.md](0016-core-language.md) WEB0 절). |
| 2^53 초과 INTEGER | `bigint`로 읽을 수 있음 | 원시 JS `number`로 읽으면 정밀도 손실 | 10진 문자열로 넣고 `CAST(… AS TEXT)`로 읽는다. |
| 여러 줄 DDL | `exec()`가 스크립트 전체를 실행 | `exec()`는 줄 단위라 여러 줄 DDL에 쓸 수 없음 | `split_sql`로 문장별 `prepare` 후 한 번의 `batch`로 적용한다. |
| 0행 확인 | `changes`를 반환 | batch 안에서 0행을 실패로 바꾸려면 별도 가드 필요 | `SELECT CASE WHEN changes() = 0 THEN json_extract('{}', 'PES_D1_ZERO_ROWS_GUARD[') ELSE 1 END`를 같은 batch에 붙인다. 0행일 때 `D1_ERROR: bad JSON path: 'PES_D1_ZERO_ROWS_GUARD[': SQLITE_ERROR`로 실패하고 전체가 롤백된다. 오류 문구에 `'PES_D1_ZERO_ROWS_GUARD['`(따옴표 포함)가 정확히 있을 때만 가드 실패로 판별하고, 그 밖의 오류(사용자 문장의 `integer overflow` 포함)는 원본 그대로 전달한다. |
| 도구 버전 | Node 26 내장 | `wrangler` 4.157.0은 miniflare 5 베타를 끌고 옴 | `miniflare` 4.20260730.0만 `tests/d1`에 고정한다. |

실행 제한:

- 로컬 D1만 쓴다. `wrangler login`·`deploy`·원격 D1·Cloudflare 계정은 사용하지 않는다.
- 테스트는 `tests/d1/node_modules`의 miniflare가 있을 때만 D1 부분을 돌린다. 없으면 이유를 남기고 건너뛰며, `PES_D1_SMOKE=1`이면 도구가 없다는 이유로 실패한다.
- CI의 `d1-smoke`는 `ubuntu-latest`에서만 돌린다. 사용자 설치를 요구하지 않고, 루트 `npm test`는 `node:sqlite` 참조 엔진 부분을 항상 돌린다.
- miniflare가 실행 위치에 만드는 `.wrangler/`는 저장소에 넣지 않는다(`.gitignore`).

## 영향

- 새 파일: `scripts/pes_core/d1_smoke.ts`, `.github/workflows/d1-smoke.yml`, 이 결정 기록.
- CI: 마이그레이션·DB 어댑터·`tests/d1`·이 workflow가 바뀌는 PR과 `main` push에서 `d1-smoke` job이 돈다.
- 테스트: `tests/test_d1_smoke.test.ts`가 같은 시나리오를 `node:sqlite`와 로컬 D1에서 비교한다. D1 도구는 `tests/d1`의 고정된 개발 의존성으로만 설치한다.
- 0행 가드 실패는 오류 문구에 `'PES_D1_ZERO_ROWS_GUARD['`(따옴표 포함)가 정확히 있을 때만 판별한다. 그 밖의 `integer overflow`는 원본 오류 그대로 전달한다. **한계: 사용자가 가드와 똑같은 `json_extract` 경로 식을 쓰면 가드 실패와 구분할 수 없다.**
- 앞으로 D1을 실제로 쓰는 코드(PR13 이후 API·Worker 경계)는 `bigint` 바인딩·`sqlite_version()`·`exec()` 다중 문장을 쓰지 않는다. 큰 정수는 10진 문자열로 주고받고, 스키마 버전은 `db_meta`로 확인한다.
- `tsconfig.json`은 중첩 `node_modules`를 제외해 `tests/d1` 도구 소스를 타입 검사 대상에서 뺀다.

## 재검토 조건

- 운영 D1 또는 preview D1을 실제로 연결하는 단계(PR13·PR21 이후)에서 로컬과 다른 바인딩·오류·트랜잭션 동작이 관측될 때.
- miniflare 5가 안정판이 되어 4와 같은 D1 의미를 내고 Node 26에서 검증될 때.
- D1이 `bigint` 바인딩을 지원하거나 `sqlite_version()`·`exec()` 제한을 바꿀 때.
- `node:sqlite`의 SQLite 버전·JSON 함수·트랜잭션 동작이 바뀌어 참조 엔진 비교가 성립하지 않을 때.
- 0행 가드가 `json_extract`의 잘못된 경로 오류 외의 방법을 요구하거나, D1이 가드 오류 문구에서 고유 표식을 지워 `ZeroRowsError` 판별이 깨질 때.

## 상태

채택 (2026-11-08)
