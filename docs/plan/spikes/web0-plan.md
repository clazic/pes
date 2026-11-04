# 5단계 WEB0 — 웹 코어 언어 시험 계획

- 작성: 2026-11-05, Claude 종합
- Linear: 5단계 `WEB0`(번호만 5단계). **이 문서는 계획이며 Linear 이슈를 만들지 않았다.**
- 입력: [stage-5.md](../stage-5.md) 2.1·2.1.1·4절, [roadmap-opus-check.md](../discussion/roadmap-opus-check.md) R6·R8, [fixtures/api-v1/README.md](../fixtures/api-v1/README.md), [stage-2.md](../stage-2.md) PR4·13, [stage-1-api.md](../stage-1-api.md)
- 상태: **시험 계획 — 실행 전**
- 실행 시점: **2단계 PR4(변경 명령 서비스)와 PR13(API 맥락·claim·submit·complete)의 언어 중립 계약 픽스처가 나온 직후.** 5단계 착수까지 기다리지 않는다(`roadmap-opus-check.md:19` R6).
- 범위: 웹에서 2단계 Python 코어의 **같은 명령·오류·멱등·10진 문자열 계약**을 어느 언어/실행 환경에서 돌릴지 작은 시험으로 판정한다. 제품 코드·계획서는 이 시험에서 고치지 않는다.
- 자료: 합성 fixture만. 실제 `~/pes-projects`·`~/.pes/`, 실키, 기관 자료는 읽거나 쓰지 않는다.

## 1. 목적과 결정 질문

**결정 질문**: 5단계 Cloudflare Free에서 PES 코어(명령 서비스·API·D1 접근)를 (a) Python Workers로 그대로 돌릴 수 있는가, (b) TypeScript로 옮겨야 하는가, (c) Workers가 아닌 Python 서버가 필요한가.

이 시험의 목적은 "Python이 좋다/TS가 좋다"가 아니라 **2~4단계에서 만든 Python 코어를 웹에서 다시 만들지 않아도 되는지**를 PR4·13 계약 픽스처로 조기에 판정하는 것이다. 결과가 TS 이식이면 2~4단계 구현 언어를 그때 다시 정하고, 결과가 Workers 밖 Python이면 5단계 플랫폼 전제를 다시 검토한다(`stage-5.md:48`, `roadmap-opus-check.md:19`).

**비목표**: 전체 웹 UI·로그인·R2·알림·원격 MCP 구현, 운영 D1 배포, 유료 요금제 전환, 실제 프로젝트 이전. WEB0은 **코어 언어·실행 환경 판정**만 한다.

## 2. 시험할 선택지

### 2.1 A — Python Workers

- **방법**: 2단계 Python 코어(`scripts/pes_core`의 명령 서비스·D1 어댑터·오류 봉투)를 Cloudflare Python Workers(Pyodide 기반)에 올려 같은 계약 픽스처를 실행한다.
- **장점**: 코드 이식이 가장 작고, 2~4단계 Python 구현과 같은 로직·테스트를 유지할 수 있다. PR4·13의 계약을 그대로 웹에 쓸 수 있는지 직접 본다.
- **위험**: Python Workers의 **Free 포함 여부가 공식 페이지에 명시되지 않음**(`stage-5.md:48`, `:78`). Pyodide 패키지 제약(순수 Python·WASM 패키지, C 확장·큰 의존성), 콜드 스타트, D1 바인딩·`batch()` 접근, 10 ms CPU. Python Workers가 Free가 아니면 A는 비용 기준에서 즉시 불합격이다.
- **먼저 확인할 것**: 무료 계정에서 Python Worker 배포·실행, D1 바인딩, `env.DB.prepare/bind/all/run/batch`, `json`·`sqlite3` 대체 경로, 패키지 크기, 로그·관측.

### 2.2 B — TypeScript 이식

- **방법**: 명령 서비스·API·D1 어댑터를 TypeScript로 옮기고, **같은 `docs/plan/fixtures/api-v1/` 골든 픽스처**를 Python 구현과 TS 구현 양쪽에 돌려 같은 결과를 요구한다.
- **장점**: Workers 네이티브. CPU·메모리·콜드 스타트가 예측 가능하고, D1·Workers API를 정면으로 쓴다. Free 한도 안에서 가장 안전할 수 있다.
- **위험**: **코어 이중 구현**(Python 로컬 + TS 웹)이 가장 큰 위험이다(`roadmap-opus-check.md:21` R8). 2~4단계의 Python 서비스·테스트·CLI를 다시 옮겨야 하고, 계약이 갈라지면 픽스처가 곧 원본이 된다. 이 시험에서는 **최소 명령 경로만** TS로 만들어 판정하고, 전체 이식은 결과 승인 뒤 별도 계획으로 한다.
- **먼저 확인할 것**: TS 최소 구현이 `capabilities/context/claims/results/wait/complete`와 D1 batch·0행 실패·10진 문자열·오류 봉투를 같은 의미로 내는지.

### 2.3 C — 다른 방법

- **방법**: Workers 밖의 Python 서버(Cloudflare Containers·VPS·기존 로컬 서버)에서 코어를 돌리고, 웹은 프록시/UI만 두는 방식. 또는 Workers에서 Python을 WASM으로 직접 올리는 변형.
- **장점**: 기존 Python 코어를 거의 그대로 쓸 수 있고, Python 생태계·SQLite를 유지할 수 있다.
- **위험**: **Cloudflare Free 전제를 깨뜨린다**. Containers/VPS는 비용·운영·인바운드/아웃바운드·절전·보안 부담이 생기고, 5단계의 "무료 요금제" 결정과 충돌한다. Workers가 아닌 Python 서버를 쓰면 WEB1 플랫폼 전제를 다시 검토해야 한다(`stage-5.md:48` (c), `:7`).
- **판정**: A·B가 모두 실패했을 때만 조사한다. C를 쓰려면 사용자 결정(비용·운영)이 필요하다.

### 2.4 추천 순서

**A 먼저 → B 대안 → C는 마지막**. 이유: A가 통과하면 2~4단계 Python을 그대로 쓰고 가장 작은 변경으로 끝난다. A가 Free/CPU/패키지에서 실패하면 B의 최소 구현으로 같은 픽스처를 돌려 이식 비용을 측정한다. C는 무료 전제를 깨므로 A·B 모두 실패한 경우에만 사용자 결정으로 올린다.

## 3. 계약 픽스처로 무엇을 돌려 판정할까

### 3.1 픽스처 읽기

- 대상: `docs/plan/fixtures/api-v1/`의 **JSON 38개**(README 포함 아님). README의 규칙을 따른다(`fixtures/api-v1/README.md:3-6`, `:73-116`, `:148-153`).
- 이 폴더는 코드가 import하지 않는 **문서형 합성 계약**이다. WEB0 하네스는 파일을 **읽기 전용**으로 읽고, 픽스처를 고치지 않는다. 계약 자체가 틀렸다고 판명되면 별도 결정·수정 이슈로 분리한다.
- 정규화: `request_id`, 타임스탬프, 임의 ID는 비교에서 제외한다. 비교할 것은 status, `format_version`, 필수 키·타입, 오류 `code`/`retryable`/`target`/`next_action`, 10진 문자열 형식, `replayed` 플래그다.

### 3.2 1단계 — 38개 전부 parse/validate

후보 구현의 라우터·DTO·오류 봉투가 계약과 맞는지 **실행 없이** 검사한다.

- [ ] 38개 JSON이 유효하고 `operation`·`method`·`path`·`auth`가 있다.
- [ ] `normal`/`error`/`replay`의 요청·응답 모양, `format_version:"1.0"`, 상태 코드 집합(200/201/202/400/401/403/404/409/410/413/422)을 읽는다.
- [ ] 성공 응답은 `{format_version, data, meta:{request_id}}`, 오류 응답은 `{format_version, request_id, error}` 봉투인지 검사한다. `data` 안의 업무 payload와 `meta`를 섞지 않는다.
- [ ] `rev`·`control_rev`·`fence`·`event_seq`·`version_no`·`round_no`·`edition_no`가 **정규화 10진 문자열**인지 검사한다.
- [ ] 오류 봉투의 `code`(영어 snake_case)·`message`(한국어)·`retryable`·`target`·`details`·`next_action` 키가 있는지 검사한다.
- [ ] 요청의 모르는 필드 거부, 응답의 선택 필드 추가 허용, 모르는 정책·상태를 허용으로 해석하지 않는 규칙을 DTO 테스트로 확인한다.
- [ ] `files-content.json`은 `data.content_base64`·`media_type`·`sha256`·`size_bytes` 스키마만, `uploads-put.json`은 `body_base64` 스키마만 검사하고 실행 대상에서는 뺀다.

이 단계는 **아직 구현되지 않은 3·4·6단계 동작도 포함**한다. 실행하지 않고 계약 표면만 검사하므로, PR13 이후에도 전체 픽스처가 언어 중립적인지 확인할 수 있다.

### 3.3 2단계 — PR4·13 범위 core execute

PR4·13이 실제로 제공하는 최소 경로만 실행한다. **7개 필수**:

| 픽스처 | 판정할 것 |
|---|---|
| `capabilities.json` | `format_version`, 지원 동작, 한도·오류 코드 목록 |
| `context.json` | digest·manifest, `control_rev`·`event_seq` 10진 문자열, 일관 읽기 |
| `versions.json` | 정확한 버전 조회, 없는 버전 오류 |
| `claims.json` | claim=run 전이+lease 원자, `lease_held` 오류 |
| `results.json` | 작은 묶음 제출, `rev_conflict`, **멱등 replay** |
| `wait.json` | `waiting_human`+lease 해제, 질문 ID |
| `complete.json` | run 종료, `stage_approved:false`(승인 아님) |

`runs.json`(queued run 생성)은 PR13에 run 생성이 포함된 경우에만 실행하고, 아니면 parse/validate만 한다. PR14가 이미 병합된 경우 **확장 7개**를 추가 실행한다: `heartbeat`, `interrupt`, `cancel`, `handoffs`, `inputs`, `input-receipts`, `changes`. PR14 전이면 이 7개는 parse/validate만 한다. `runs`까지 포함한 최대 실행은 **15개**다.

추가로 D1에서 다음을 실행한다.

- [ ] `001_initial.sql` 적용, 54표, FK, `json_valid`/`json_type`, `db_meta`.
- [ ] 같은 원자 명령의 성공·rev 충돌·뒤늦은 실패 전체 롤백.
- [ ] `batch()` 원자성, 0행 CAS 실패, deferred FK, 부분 UNIQUE.
- [ ] 같은 키·같은 요청 replay, 같은 키·다른 요청 `idempotency_key_reused`.
- [ ] 10진 문자열이 JS `Number`로 변환되지 않고 응답·DB 왕복에서 보존됨.

### 3.4 판정 규칙

- **계약 불합격**: 38개 중 하나라도 parse/validate 실패, 7개 core 중 하나라도 normal/error/replay 의미 불일치, 10진 문자열 손실, 오류 봉투 불일치.
- **동등성 불합격**: Python 기준 구현과 후보 구현의 status·오류 code·필수 키·`replayed`가 다름. `request_id`·시간·임의 ID 차이는 허용.
- **D1 불합격**: 0행 실패를 성공으로 반환, 부분 저장, FK/부분 UNIQUE 위반 허용, `batch` 부분 성공.
- **언어 중립 불합격**: 후보가 Python 전용 타입·직렬화·예외를 계약에 노출해 다른 언어가 같은 픽스처를 통과할 수 없음.

## 4. Cloudflare 무료 한도와 측정법

### 4.1 시험 기준 한도 (2026-11-05 확인값)

`stage-5.md:60-78`의 무료 한도를 그대로 쓴다.

| 항목 | Free 한도 | WEB0에서 보는 것 |
|---|---|---|
| Workers 요청 | 100,000/일 | 합성 부하의 하루 환산이 80,000 이하인지 |
| Workers CPU | **10 ms/호출** | p95·p99·최대, 10 ms 초과 호출 수 |
| 메모리 | 128 MB | 최대 메모리, OOM |
| subrequest | 50/요청 | fetch·외부 호출 수 |
| D1 쿼리 | **50/호출** | 요청당 쿼리 수(p95·최대), batch 구성원 포함 |
| D1 읽기/쓰기 | 500만 행/일 · 10만 행/일 | 합성 1라운드의 rows read/written |
| D1 저장 | DB당 500 MB · 계정 5 GB | 시험 DB 크기(작음) |
| R2 | 10 GB-month | WEB0에서는 사용하지 않음 |
| Workflows | 3,000 step/일 | WEB0에서는 사용하지 않음 |

**미확인**: Python Workers의 Free 포함 여부. A의 첫 관문이며, 공식 문서만으로 통과를 가정하지 않는다(`stage-5.md:48`, `:78`).

### 4.2 CPU 10 ms 측정

- **로컬 `wrangler dev`는 판정에 쓰지 않는다.** 로컬은 CPU 제한을 강제하지 않고 런타임도 다르다. 로컬은 기능 스모크만, 판정은 **무료 Cloudflare 계정의 staging Worker(`*.workers.dev`)**에서 한다.
- 배포 후 경로별로 **웜 1,000회 + 콜드 10회**, 3회 반복한다. 동시성 1과 10을 모두 본다.
- 수집: Cloudflare 대시보드/GraphQL Analytics의 Workers CPU time p50/p95/p99, 가능하면 `wrangler tail --format json`의 호출별 CPU. `performance.now()`는 **wall time**으로만 기록하고 CPU로 부르지 않는다.
- 콜드 스타트는 첫 요청·새 isolate에서 따로 기록한다. CPU와 콜드 스타트를 섞지 않는다.
- **합격선**: p95 ≤ 8 ms, p99 ≤ 10 ms, 1,000회 중 10 ms 초과 **0회**. p95가 8~10 ms면 최적화 1회 뒤 재시험하고, 그 뒤에도 p95 > 8 ms 또는 10 ms 초과가 1회라도 있으면 A 불합격. 10 ms를 넘으면 Free에서 해당 요청은 실패(`exceededCpu`)할 수 있다.

### 4.3 D1 쿼리 수·행 수 측정

- `env.DB`를 얇은 래퍼로 감싸 `prepare/bind/first/all/run/batch` 호출을 센다. **batch는 구성원 statement를 각각 세고, batch 호출도 따로 기록**한다.
- 요청마다 시험용 로그/헤더에 `route`, `request_id`, `db_queries`, `db_batch_calls`, `db_rows_read`, `db_rows_written`을 남긴다. 운영 응답 헤더에 내보내지 않는다(시험 플래그에서만).
- D1 결과의 `meta.rows_read`·`meta.rows_written`을 합산하고, 대시보드 D1 metrics와 대조한다. 쿼리 수와 행 수를 섞지 않는다.
- **합격선**: 요청당 쿼리 **최대 50 이하**, core 경로 p95 **20 이하**. 전체 표 스캔·`SELECT *`·인덱스 없는 큰 정렬이 없어야 한다. 합성 1라운드의 rows read/write가 `stage-5.md:87-90`의 하루 추정(읽기 1.3만 행·쓰기 1,000행)을 크게 넘지 않아야 한다.
- 25초 long-poll은 WEB0의 판정 대상이 아니다. `wait`·`inputs`의 **CPU·쿼리**만 보고, 장기 대기 구현(DO/짧은 폴+ETag/SSE)은 WEB1에서 정한다(`stage-5.md:100`, `:155`).

### 4.4 메모리·subrequest·요청 예산

- 메모리 최대 128 MB, OOM 0. Python Workers의 패키지·콜드 스타트 메모리를 대시보드에서 확인한다.
- subrequest 최대 50/요청. WEB0 core 경로는 외부 fetch가 없어야 하며, 있으면 수를 센다.
- 합성 부하를 하루로 환산해 **80,000 요청/일 이하**면 통과(Free 100k의 80%). `stage-5.md:86`의 3초 폴링 위험을 WEB0이 해결하지 않으므로, 3초 기본 폴링을 전제로 한 부하를 통과로 치지 않는다.
- 비용: **$0/월, 무료 기능만**. Python Workers가 유료이거나 R2/Workers 유료 기능이 필요하면 A는 비용 기준 불합격이다.

### 4.5 부하·반복

- 합성 프로젝트 1개, 합성 사용자 2명, 1라운드. 실제 자료·실키·기관 자료 0.
- 경로별 1,000회, 3회 반복의 중앙값·p95·p99·최대를 기록한다. 네트워크 변동과 콜드 스타트를 분리한다.
- 원자료는 `docs/plan/spikes/web0-measurements.csv`(합성 ID만)로 남긴다. 공개 저장소에 비밀·실자료를 넣지 않는다.

## 5. 합격·불합격 기준

### 5.1 A — Python Workers

**합격**은 아래를 모두 만족할 때만이다.

- [ ] 무료 계정에서 Python Worker 배포·실행, D1 바인딩·batch 동작, **Python Workers가 Free 포함**.
- [ ] 38/38 parse/validate, 7/7 core execute(가능하면 15/15), normal/error/replay 의미 일치.
- [ ] D1 001·batch 원자성·0행 실패·FK/JSON·rev 충돌 전체 롤백 통과.
- [ ] CPU p95 ≤ 8 ms, p99 ≤ 10 ms, 10 ms 초과 0/1,000.
- [ ] 쿼리 최대 ≤ 50, core p95 ≤ 20; 전체 스캔 0.
- [ ] 메모리 ≤ 128 MB, subrequest ≤ 50, OOM 0.
- [ ] 하루 환산 요청 ≤ 80,000, 비용 $0.
- [ ] 콜드 스타트·패키지 크기·D1 접근 한계를 기록.

**조건부**: 계약·D1은 통과하지만 p95가 8~10 ms이면 최적화 1회(불필요한 JSON 파싱·ORM·큰 객체 제거, 경량 경로 분리) 후 재시험. 재시험에서도 p95 > 8 ms 또는 10 ms 초과가 있으면 불합격.

**불합격**: Free 미포함, Pyodide 패키지/ D1 바인딩 불가, 10 ms 초과, 50쿼리 초과, 메모리 OOM, 계약 불일치 중 하나.

### 5.2 B — TypeScript 이식

**합격**은 A와 같은 계약·D1·CPU·쿼리·메모리·비용 기준을 모두 만족할 때다. 추가로:

- [ ] Python 기준 구현과 TS 구현이 같은 38개 픽스처에서 같은 status·오류 code·필수 키·`replayed`를 낸다.
- [ ] 10진 문자열이 TS `number`로 손실되지 않는다(문자열 유지).
- [ ] TS 최소 구현의 코드량·이식 범위(명령 수, D1 어댑터, 오류 봉투)를 기록한다.
- [ ] 이중 구현 위험(같은 계약을 두 언어가 유지)과 2~4단계 재작업 규모를 기록한다.

**불합격**: 계약 불일치, CPU/쿼리/메모리 초과, 이식 범위가 2~4단계를 사실상 다시 쓰는 수준인데도 단일 원본·테스트 전략이 없음.

### 5.3 C — 다른 방법

A·B가 모두 불합격일 때만 조사한다. **Cloudflare Free 전제를 만족하면 합격**, 아니면 불합격이며 사용자 결정(유료/다른 호스트)으로 넘긴다. WEB0은 C를 구현하지 않고 비용·운영·보안·5단계 전제 영향만 비교한다.

### 5.4 판정과 결정

| 결과 | 결정 | 다음 |
|---|---|---|
| A 합격 | **Python 유지** | WEB1은 Python Workers·D1 어댑터로 진행. 2~4단계 언어 변경 없음 |
| A 불합격, B 합격 | **TS 이식 검토** | 2~4단계 구현 언어를 다시 정한다. WEB1은 TS 코어를 입력으로 받는다 |
| A·B 불합격, C 합격 | **Workers 밖 Python** | 5단계 플랫폼 전제(Free) 재검토, 사용자 비용 결정 |
| 모두 불합격 | **보류** | 5단계 착수 금지, 계약·플랫폼·범위를 다시 설계 |

결과는 `docs/plan/decisions/0006-web-core-language.md`에 문제·선택지·측정값·채택·이유·영향·재검토 조건·상태로 남긴다. **A가 합격해도 Python Workers의 Free 정책이 바뀌면 재검토**하고, B가 채택되면 Python/TS 이중 구현을 금지하는 단일 원본 규칙을 함께 적는다.

## 6. 실행 절차와 산출물

1. **전제 확인**: PR4·13 병합, `docs/plan/fixtures/api-v1/` 38개, PR2 D1 smoke, 무료 Cloudflare 계정. 0단계 게이트 미충족이면 시작하지 않는다.
2. **하네스**: `spikes/web0/`에 픽스처 읽기·정규화·비교·부하·측정 스크립트를 둔다(제품 코드 아님). 픽스처는 읽기 전용.
3. **A 구현**: Python 코어의 최소 경로를 Python Workers에 올리고, Free 포함·D1·계약을 확인한다.
4. **측정**: 38 parse, 7 core execute(가능하면 15), D1 원자성, CPU/쿼리/메모리/요청/콜드 스타트를 3회 반복한다.
5. **B 필요 시**: 같은 픽스처로 TS 최소 구현을 만들어 A와 같은 표를 채운다. 전체 이식은 하지 않는다.
6. **C 필요 시**: 비용·운영·5단계 전제만 비교하고 구현하지 않는다.
7. **산출물**: `docs/plan/spikes/web0-result.md`, `docs/plan/spikes/web0-measurements.csv`, `docs/plan/decisions/0006-web-core-language.md`. 결과를 2단계 PR4·13과 5단계 WEB1에 통지한다.

**시간 상자**: A 3일, B 최소 구현 2일, C 조사 1일. 넘기면 범위를 줄이고 중간 결과를 기록한다. 실제 프로젝트·유료 호출은 하지 않는다.

## 7. 결과가 2~4단계에 주는 영향

- **A 합격**: 2~4단계는 Python을 유지한다. PR4·13의 JSON 픽스처가 웹·로컬 공통 계약의 원본이 되고, WEB1은 Python Workers·D1 어댑터를 쓴다. 2단계 PR14~18, 3단계 U1~U6, 4단계 PR23~25는 언어를 바꾸지 않는다. 대신 Python Workers 제약(패키지·메모리·CPU)을 PR4·13·14의 완료 조건에 추가한다.
- **B 채택**: 2~4단계 구현 언어를 다시 정한다. 명령 서비스·API·D1 어댑터를 TS로 옮기면 PR5~18, 3단계 화면 서버, 4단계 판·비교 API의 일정·테스트를 재산정해야 한다. **Python 로컬과 TS 웹을 같은 기능으로 이중 구현하지 않는다**는 규칙을 먼저 정하고, 픽스처를 단일 계약 원본으로 삼는다. 이 시험은 전체 이식을 하지 않으므로, B 채택은 별도 결정·계획으로 넘긴다.
- **C 채택**: 2~4단계 로컬 Python은 그대로지만 5단계의 Cloudflare Free 전제가 깨진다. WEB1 플랫폼·비용·운영을 다시 설계하고, 사용자 결정(유료/다른 호스트)을 받는다. 2~4단계의 로컬 경로는 유지할 수 있다.
- **모두 불합격**: 5단계 착수 금지. 2~4단계는 로컬 Python으로 계속하고, 웹 코어 계약·플랫폼을 다시 설계한다.

## 8. 위험과 한계

- **Free 포함 미확인**: Python Workers가 Free가 아니면 A는 끝난다. 공식 문서만으로 통과를 가정하지 않는다.
- **측정 환경 차이**: 로컬·유료·다른 리전의 CPU는 Free 배포와 다르다. 판정은 Free staging만 쓴다.
- **픽스처 범위**: 38개는 6절 동작의 대표 예제이지 전체 오류·rate limit·TLS·HTTP/2를 덮지 않는다. WEB0은 코어 언어 판정만 하며, 전체 계약 시험은 PR21·WEB1·WEB14가 맡는다.
- **Pyodide 제약**: C 확장·큰 패키지·스레드·파일 시스템이 다를 수 있다. D1·JSON·암호화 경로를 실제로 확인한다.
- **이중 구현**: B를 택하면 Python/TS 두 구현이 생긴다. 단일 계약·한 원본·한 테스트 세트 없이는 채택하지 않는다.
- **실자료 금지**: 합성 ID·합성 문장만. 실제 `~/pes-projects`·`~/.pes/`는 읽지 않는다.

## 9. 근거

| 주장 | 근거 |
|---|---|
| WEB0은 번호만 5단계, 실행은 2단계 PR4·13 픽스처 직후 | `stage-5.md:48`, `:290`; `roadmap-opus-check.md:19` R6 |
| 선택지 (a) Python Workers (b) TS 이식 (c) Workers 밖 Python | `stage-5.md:48` |
| 무료 한도: 요청 100k/일, CPU 10 ms, 메모리 128 MB, subrequest 50 | `stage-5.md:64-65` |
| D1: 쿼리 50/호출, 읽기 500만·쓰기 10만 행/일, DB 500 MB·10개·5 GB | `stage-5.md:68-70` |
| Python Workers Free 포함 미확인 | `stage-5.md:48`, `:78`, `:371` |
| 3초 폴링·25초 대기의 한도 위험 | `stage-5.md:86`, `:100`, `:155` |
| 38개 픽스처의 봉투·10진 문자열·오류·replay 규칙 | `fixtures/api-v1/README.md:3-6`, `:73-116`, `:118-138`, `:148-153` |
| PR4·13 계약·멱등·0행 실패·D1 | `stage-2.md:183`, `:192`; `stage-1-api.md:18-23` |
| TS 이식 시 2~4단계 언어 재검토·이중 구현 위험 | `stage-5.md:48`; `roadmap-opus-check.md:19`, `:21` R8 |
