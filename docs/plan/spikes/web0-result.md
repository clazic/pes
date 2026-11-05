# WEB0 결과 — TypeScript 코어·플랫폼 후보 로컬 실측

- 작성: 2026-11-05, WEB0 worker (관리 AI 지시·Codex 리뷰 반영)
- 입력: [web0-plan.md](web0-plan.md), [web0-measure.md](web0-measure.md), [stage-5.md](../stage-5.md) 2.1, [stage-1-api.md](../stage-1-api.md) 3·6, [DDL 초안](../schemas/stage-1-ddl-draft.sql), [fixtures/api-v1](../fixtures/api-v1/README.md)
- 산출물: `spikes/web0/`, [web0-measurements.csv](web0-measurements.csv), 이 문서, 결정 기록 0016·0005 갱신
- 상태: **로컬 시뮬레이터 스파이크 완료. 플랫폼 최종 판정 아님.** 계정·카드·비용이 필요한 항목은 "사용자 결정 필요"로 남겼다.

> **판정 아님 — 스모크/대리값.** 아래 CPU·RSS·벽시계는 이 PC의 로컬 시뮬레이터에서 잰 값이다. Cloudflare Workers의 10 ms CPU, Vercel Active CPU, Oracle 회수 기준, 실제 네트워크·콜드 스타트·지역·과금을 대표하지 않는다. 실제 후보 staging 측정은 계정과 비용 승인 뒤에만 한다.

## 1. 무엇을 만들었나

`spikes/web0/`는 제품 코드가 아닌 최소 시험 구현이다. 제품 모듈 이름(`web/src/...`)을 선점하지 않는다.

| 경로 | 내용 |
|---|---|
| `ts-core/contract.ts`·`dto.ts`·`decimal.ts` | 봉투·오류 6필드·정규화 10진 문자열·요청 DTO(모르는 필드 거부) |
| `ts-core/service.ts` | 라우터와 명령 서비스. `capabilities`·`context`·`versions`·`claims`·`results`·`wait`·`complete` |
| `ts-core/db.ts` | `Db` 인터페이스 + D1 어댑터(업무 로직과 분리) |
| `ts-core/sqlite-adapter.ts` | `node:sqlite` 어댑터(같은 인터페이스) |
| `ts-core/scenario.ts` | A 한 라운드 시나리오(모델 3회, 결과 2회, 질문/답 1회, wait/resume/complete) |
| `ts-core/fake-go.ts` | 결정적 가짜 Go(8/16/12 KiB, 고정 200 ms, HTTP 200) |
| `ts-core/hwpx.ts` | 합성 report.md → report.hwpx 최소 변환기(순수 TS + fflate) |
| `worker/index.ts`, `wrangler.toml` | `wrangler dev --local` Workers + 로컬 D1 진입 |
| `ts-core/vc-handler.ts`·`vc-server.ts` | Vercel Node 함수 형태의 로컬 핸들러 + 로컬 SQLite |
| `test/` | `node:test` 82개(계약 비교기·10진 큰 값·CAS·만료·HWPX 포함) |

### 1.1 실행 명령과 러너 결정

- 테스트 러너: **`node:test`**를 우선 시도해 채택했다. Node 26이 TypeScript를 타입 제거로 바로 실행하고, 추가 러너 의존성이 없으며, 82개 테스트가 통과했다. `tsc --noEmit`은 `typescript` devDependency로 돌린다.
- `npm ci`는 npm 레지스트리의 devDependency만 쓴다. Bun 1.4.4·Deno 2.9.6은 npm 패키지의 플랫폼 바이너리로 `node_modules/.bin`에 설치되며 전역 설치가 아니다.
- 이 개발 PC의 npm 레지스트리 인증서 체인이 Node 기본 신뢰 저장소와 맞지 않아 `NODE_EXTRA_CA_CERTS`가 필요할 수 있었다. 캐시가 있으면 `npm ci`는 그대로 통과한다. 이는 환경 문제이며 저장소 설정을 바꾸지 않았다(`spikes/web0/README.md` 참고).

## 2. 계약 시험 결과

### 2.1 38개 fixture parse/validate — 38/38

`docs/plan/fixtures/api-v1/`의 38개 JSON을 읽기 전용으로 검사했다.

- `operation`·`method`·`path`·`auth` 존재와 값
- `normal`/`error` 봉투, `format_version:"1.0"`, 상태 코드 집합
- 성공 봉투 `{format_version,data,meta.request_id}`, 오류 봉투 `code`·`message`·`retryable`·`target`·`details`·`next_action`
- `rev`·`control_rev`·`fence`·`event_seq`·`version_no`·`round_no`·`edition_no`가 정규화 10진 문자열인지 재귀 검사
- `replay`는 `results.json` 1개에만 있고 `replayed:true`를 확인
- `files-content`·`uploads-put`은 스키마 검사만 하고 실행 대상에서 뺐다.

### 2.2 7개 필수 경로 실행 — fixture 응답을 기준으로 비교

`test/comparator.ts`가 fixture의 `normal`/`error`/`replay.response`에서 **status·error.code·필수 키·replayed**를 읽어 실제 실행 결과와 비교한다. 테스트에 기대 status·code·키를 하드코딩하지 않는다.

- status와 `error.code`는 정확히 비교한다.
- fixture 응답의 모든 키를 재귀적으로 요구한다. 구현이 추가 선택 필드를 넣는 것은 허용한다.
- 배열은 키/타입을 검사하고, 실제 배열이 비어 있으면 허용한다(파일 없는 A 시나리오).
- `request_id`·`*_id`·`digest`·`cursor`·`created_at`·`expires_at` 등 동적 값은 `normalizeDynamic()`으로 명시 정규화한다.
- 음성 검사: 필수 키를 지운 합성 실제 응답과 오류 code를 바꾼 기대값이 **실패**하는지 시험한다.
- `capabilities`의 `exports.create`처럼 fixture에 있는 키가 구현에 없던 곳은 구현을 fixture에 맞췄다(fixture는 수정하지 않음).

| 경로 | normal | error | replay |
|---|---|---|---|
| `capabilities.get` | fixture status·키 일치 | fixture 401 `unauthorized` | 해당 없음 |
| `context.get` | fixture status·키 일치 | fixture 404 `project_not_found` | 해당 없음 |
| `object.version.get` | fixture status·키 일치 | fixture 404 `version_not_found` | 해당 없음 |
| `runs.claim` | fixture 201·키 일치 | fixture 409 `lease_held` | 같은 키 재호출 → `replayed:true` |
| `results.submit` | fixture 201·키 일치 | fixture 409 `rev_conflict` | fixture replay → `replayed:true` |
| `runs.wait` | fixture 200·키 일치 | fixture 409 `not_lease_holder` | 해당 없음(픽스처 없음) |
| `runs.complete` | fixture 200·키 일치 | fixture 409 `run_terminal` | 같은 키 재호출 → `replayed:true` |

**픽스처 불일치 3건(고치지 않고 기록):**

1. `capabilities`는 `auth:"any"`인데 error 예제는 인증 없이 401 `unauthorized`를 기대한다. 시험 하네스에서 그 오류 사례만 "인증 필수 모드"로 실행해 봉투를 비교했고, 정상 모드는 인증 없이 200임을 함께 확인했다.
2. `complete` error 예제에는 `Idempotency-Key`가 없다. 계약 2절 5번은 쓰기 요청에 키를 필수로 두므로, 시험 하네스가 합성 키를 넣어 상태 오류(`run_terminal`)까지 도달시켰다. 키 누락 자체는 별도 시험에서 422로 확인했다.
3. `wait`는 쓰기 동작이지만 픽스처에 `Idempotency-Key`가 없다. 이 스파이크는 픽스처를 따라 키 없이 실행하고, 멱등 재생은 시험하지 않았다(픽스처에 replay 없음).

이 3건은 **픽스처/계약 정합성 검토 대상**이며, 이 이슈에서는 fixture를 수정하지 않았다(읽기 전용).

### 2.3 SQLite·D1 계약 — 16 pass + 1 info, 미지원 SQL 0

같은 `runContractSuite`를 `node:sqlite`와 `wrangler dev --local` D1에 적용했다.

| 항목 | node:sqlite | 로컬 D1 |
|---|---|---|
| 표 수 | 61 | 61 |
| FK 강제 | 통과 | 통과 |
| CHECK | 통과 | 통과 |
| 부분 UNIQUE(`one_project_owner`·`one_active_edition`·`one_open_round`) | 통과 | 통과 |
| 0행 CAS | `changes=0` | `changes=0` |
| CAS guard(0행이면 영수증까지 롤백) | 통과 | 통과 |
| batch 원자성(롤백) | 첫 행 0 | 첫 행 0 |
| deferred FK(project→project_members) | 같은 batch 통과, 누락 시 거부 | 같은 batch 통과, 누락 시 거부 |
| JSON `json_valid`·`json_type` CHECK | 통과 | 통과 |
| 10진 왕복 `9007199254740993` | `CAST(... AS TEXT)` 정확 | `CAST(... AS TEXT)` 정확 |
| 미지원 SQL | 0 | 0 |

**D1 로컬에서 확인한 차이(어댑터 안에서 흡수):**

- **10진 정밀도**: D1의 원시 INTEGER를 JS `number`로 읽으면 `9007199254740993` → `9007199254740992`로 손실된다. `CAST(... AS TEXT)`로 읽어야 한다. `node:sqlite`는 같은 값을 `number`로 읽을 때 `ERR_OUT_OF_RANGE`를 던졌다. 두 경우 모두 어댑터가 항상 TEXT로 읽어야 함을 확인했다.
- **`lastInsertRowid`**: `events.event_seq`가 2^53을 넘으면 `node:sqlite`의 `run()`이 `lastInsertRowid`를 Number로 변환하다 실패한다. 쓰기 statement에 `setReadBigInts(true)`를 적용해 `changes`만 Number로 좁혔다.
- **deferred FK 위반 오류 모양**: 로컬 D1은 누락 member를 거부했지만 `SQLITE_CONSTRAINT` 대신 `internal error; reference=...`를 반환했다. 거부 자체는 통과지만, 운영에서 오류 code 매핑을 별도로 확인해야 한다.
- 그 밖의 미지원 SQL은 없었다. DDL을 고치지 않고 그대로 적용했다.

### 2.4 10진 문자열 — Number 변환 제거

- `fence`·`rev`·`control_rev`·`version_no`·`event_seq`를 SQL 바인딩·`mutation_commits` 영수증·응답까지 **문자열로 유지**한다. DB에는 INTEGER affinity/`CAST`로 저장·조회한다.
- 2^53 이상 값으로 `claim → results → complete`를 실행하는 테스트를 추가했다.
  - claim fence `9007199254740993`(시드 fence 2^53 + 1), control_rev `9007199254740993`
  - results version_no/object rev `9007199254740993`, event_seq는 2^53 이상
  - 응답·DB `CAST` 값·mutation 영수증의 base_control_rev/fence가 모두 일치
- 이 테스트를 위해 시드 이벤트를 2^53에 두고, `node:sqlite` 쓰기 statement의 `lastInsertRowid` 문제를 어댑터에서 흡수했다.

### 2.5 원자 CAS·만료·base_control_rev

- **원자 경계**: claim/results/wait/complete의 전제 검사와 변경을 같은 batch에 넣고, 조건부 UPDATE/UPSERT가 0행이면 `mutation_commits.guard_ok=0` INSERT가 CHECK로 실패해 **영수증·events까지 전부 롤백**한다. 001 DDL만 쓰고 별도 표를 만들지 않는다.
- **동시 claim**: 다른 키 2개를 `Promise.all`로 실행하면 **하나만 201**, 다른 하나는 `lease_held`. 같은 키 2개는 **하나의 claim + 하나의 replay**로 수렴하고 lease/fence가 같다. 두 경우 모두 claim 영수증 1개, `run.claimed` events 2개만 남는다.
- **lease 만료**: `expires_at <= now`면 results/wait/complete는 `lease_lost`. `expires_at - 1`은 성공, `expires_at`·`expires_at + 1`은 거부하는 경계값 시험을 세 경로에 넣었다. 만료 뒤에도 원래 완료 영수증의 재생은 허용된다.
- **results base_control_rev**: 요청값을 현재 project.control_rev와 비교하고, 불일치면 `rev_conflict`(target `$.body.base_control_rev`). 이 검사를 CAS guard에도 넣었고, 거부 시 객체 버전·영수증·events가 생기지 않는지 시험했다. 영수증에는 현재값이 아니라 **요청값**을 기록한다.

## 3. A 한 라운드 로컬 측정

고정 시나리오: 모델 호출 3회(요청 12+24+28 KiB, 응답 8+16+12 KiB), 결과 제출 2회, 질문/답 1/1, wait/resume/complete 1/1/1, 파일 0바이트. 워밍업 1 + 측정 3 + 연속 10회. 모든 후보가 **같은 `ts-core` 코어 해시 `ce81ec7a…`**와 같은 가짜 Go를 썼다.

| 후보(로컬 대리) | 측정 3회 벽시계(ms) | 중앙값 | CPU 중앙값(ms) | RSS 중앙값(MB) | 연속 10회 중앙값 | 10회 오류 |
|---|---|---|---|---|---|---|
| VPS 대리: Node 26 + `node:sqlite` | 635.22 / 634.59 / 629.82 | **634.59** | 37.12 | 62.89 | 628.90 ms | 0 |
| VC 대리: Node 함수 핸들러 + 로컬 SQLite | 635.06 / 644.94 / 638.97 | **638.97** | 40.00 | 107.44 | 639.32 ms | 0 |
| CF 대리: `wrangler dev --local` + 로컬 D1 | 698.49 / 697.25 / 692.44 | **697.25** | 100.00 | 521.61 | 693.78 ms | 0 |

- 세 후보 모두 **라운드당 신규 행 53, INSERT/UPSERT 변경 행 57, UPDATE 변경 행 22, 전체 변경 행 79, 쓰기 문 93**, subrequest 3, 요청 64 KiB·응답 36 KiB로 같았다.
- 계획 표의 "약 51행"은 UPDATE를 포함한 논리 행 수다. 이 구현의 **물리 신규 행은 53**(+3.9%, ±10% 안), 변경 행 79, 쓰기 문 93이다. 차이는 CAS guard·upsert·UPDATE 계수 방식에서 나며, 같은 코어라 후보별 차이는 없다. 이전 문서의 UPSERT 변경을 신규 행으로 잘못 센 값은 정정했다.
- VPS 대리 CPU/RSS는 Node 프로세스 전체(가짜 Go 클라이언트 포함) 값이다. CF 대리는 `wrangler`+`workerd` 프로세스 트리 전체 값이므로 **Workers 요청당 CPU나 128 MB 메모리 한도와 비교할 수 없다**. VC 대리는 함수 서버 프로세스 트리 값이다.
- `wrangler dev` 로컬은 Cloudflare의 실제 CPU 계측을 노출하지 않는다. 따라서 **CF Free 10 ms/호출 판정은 하지 않았다**.

### 3.1 Bun·Deno — 같은 코어 실행 성공

npm devDependency의 로컬 바이너리로 같은 `ts-core` A 라운드를 `node:sqlite` 위에서 실행했다.

| 런타임 | 버전 | 결과 | 벽시계(ms) | CPU(ms) | RSS(MB) | 신규 행 |
|---|---|---|---:|---:|---:|---:|
| Node | 26.13.0 | 통과(기준) | 634.59(중앙값) | 37.12 | 62.89 | 53 |
| Bun | 1.4.4 | 통과 | 659.80 | 30.00 | 27.64 | 53 |
| Deno | 2.9.6 | 통과 | 697.28 | 60.00 | 50.95 | 53 |

- 세 런타임 모두 `node:sqlite`가 동작했고, 같은 시나리오가 같은 53행을 썼다.
- Bun/Deno는 1회 실행 값이며, 3회·10회 반복과 플랫폼 배포는 measured 범위 밖이다.

## 4. A HWPX 경로 — 최소 실행 가능성

합성 `report.md`(제목·문단 2개·표 1개)를 **순수 TypeScript + fflate**로 `report.hwpx`로 변환했다. 네이티브 바이너리·외부 변환기·사용자 PC를 쓰지 않는다.

| 경로 | 결과 | 벽시계(ms) | CPU(ms) | RSS(MB) | 결과 크기 | sha256 일치 |
|---|---|---:|---:|---:|---:|---|
| Node 26(= VPS/VC 대리) | 통과 | 1.21 | 4.22 | 53.49 | 3,061 B | 기준 |
| `wrangler dev` 로컬 workerd(= CF 대리) | 통과 | 2.39 | 0.00(표본 하한) | 572.52 | 3,061 B | **Node와 동일** |
| 브라우저 번들(esbuild `platform=browser`) | 통과 | — | — | — | 26,625 B 번들 | — |

- 산출 구조를 테스트로 검증했다: `mimetype`이 **첫 zip 항목·무압축**, `version.xml`, `META-INF/container.xml`, `Contents/content.hpf`, `Contents/header.xml`, `Contents/section0.xml`, 표의 `hp:tbl`/`hp:tr`/`hp:tc`, 제목·문단·표 텍스트.
- 변환기 소스에 `node:` import·`Buffer`·`document`·`window`·`require()`가 없음을 검사하고, esbuild로 브라우저 번들을 만든다.
- 생성 파일은 `spikes/web0/out/hwpx/report.hwpx`(gitignore)에만 두고 커밋하지 않는다.

**한계:**

- **한글 프로그램에서 실제로 열리는지는 확인할 수 없다.** "사용자 확인 필요(한글에서 열기)"로 남긴다.
- 서식 충실도(글꼴·문단 모양·표 너비·페이지 설정)는 최소값이며, `hwpx-uri`(기존 로컬 변환기)와의 출력 차이·호환성은 비교하지 않았다.
- 정식 HWPX 스키마 전체를 구현한 것이 아니라, OPC/OWPML 골격과 표 구조를 갖춘 **최소 실행 가능성** 시험이다. 실제 제품 경로는 6단계 X1에서 별도로 확정한다.

## 5. 판정 기준별 상태

| 기준 | 로컬에서 확인 | 아직 아닌 것 |
|---|---|---|
| ① A 한 라운드 | 3/3 + 10/10 완주, 오류 0, subrequest 3/라운드 | 실제 staging CPU·한도, 콜드 스타트, 8시간/30일 |
| ② TS 재사용 | 같은 코어를 Node·Bun·Deno·D1·Node 함수에서 실행, 계약 38/38 | 실제 배포 후 같은 commit 재현 |
| ③ SQLite 계약 | 61표·FK/CHECK/부분 UNIQUE/0행/batch/deferred FK/10진 왕복 통과 | Turso 자체, D1 원격, 운영 크기·잠금 |
| ④ 월 여유 | 라운드당 사용량 고정(3 subrequest, 신규 53행, 변경 79행) | 계정 한도·8시간 하루·30일 투영·R2/DO/KV |
| ⑤ 카드 | 계정을 만들지 않음 | **사용자 결정 필요**: CF/Vercel/Oracle/Hetzner 가입·카드 |
| ⑥ 상시 통로 | 미실행 | **사용자 결정 필요**: 배포 계정 뒤 8시간 WebSocket/SSE soak |
| ⑦ 운영 | 미실행 | **미측정(시간 상자 밖)**: 4주 운영 일지 |
| ⑧ 월 비용 | 공식 수치만 전재 | **사용자 결정 필요**: Turso/Blob 한도, Oracle 지역·할당, Hetzner 월 총액 |
| ⑨ A HWPX | Node/workerd에서 같은 바이트 생성, 브라우저 번들 통과 | **사용자 확인 필요**: 한글에서 열기, 서식 충실도·hwpx-uri 차이 |

### 5.1 사용자 결정 필요 목록(계정·카드·비용)

- **Cloudflare**: 계정 생성·Workers/D1/R2/DO 활성화에 카드가 필요한지, R2 무료 포함량 초과 위험. 이번 스파이크는 계정 없이 `wrangler dev --local`만 썼다.
- **Vercel**: Hobby 가입·personal/비상업 조건 확인, Turso/Blob 무료 한도와 카드, 함수 WebSocket 최대 연결 시간.
- **Oracle Always Free**: 지역 재고·계정별 A1 할당·카드 등록. 공식 수치(1,500 OCPU-h·9,000 GB-h/월=상시 2 OCPU·12 GB)는 계획서 전재이며 이번에 새로 확인하지 않았다.
- **Hetzner CX22**: €4~5는 2차 자료다. IPv4·백업·트래픽·세금 포함 **월 총액은 미확인**이며 견적·승인이 필요하다.
- **실제 OpenCode Go 호출**: 하지 않았다. 유료 호출은 사용자 비용 승인 뒤 1~2회만, Extra Usage OFF 증거와 함께 별도로 한다.
- **HWPX**: 한글 프로그램에서 실제 열기·서식 확인은 사용자 확인이 필요하다.

### 5.2 미측정(시간 상자 밖)

- 8시간 soak, 7일 VPS soak, 4주 운영 일지, 월 30일 사용량 투영의 실제 계정 값
- 실제 WebSocket/SSE 연결·재접속·유실/중복
- 실제 D1 원격·Turso·R2·Blob·DO·KV·Workflows·Queues 동작과 과금
- HWPX 서식 충실도·hwpx-uri 대비 차이·한글 호환성

## 6. 재현

```sh
cd spikes/web0
npm ci
npm test
npm run typecheck
npm run test:d1   # 로컬 D1 계약(127.0.0.1만)
npm run measure   # CSV 갱신 + HWPX out/ 생성
```

- `npm run measure`는 `127.0.0.1`에만 바인딩하고, 끝나면 `wrangler`/`workerd`/VC 서버를 종료한다. 실행 후 남은 프로세스가 없는지 확인했다.
- 실패한 후보·런타임·계약·HWPX가 있으면 `measure`는 CSV/JSON을 남기고 **nonzero exit**으로 끝난다.
- 가짜 Go 주소는 문서에 실제 포트 대신 `http://127.0.0.1:<ephemeral>/inference/v1/chat/completions`로만 적었다.
- 개인 절대경로·계정 ID·토큰·세션 ID·이메일은 기록하지 않았다.

## 7. 결론(잠정)

- **TypeScript 단일 코어는 로컬에서 후보 3군 모두에서 같은 업무 로직으로 실행됐다.** 플랫폼 차이는 `db.ts` 어댑터와 진입점에만 있었다.
- **Node 26 + `node:test` + `tsc`를 런타임·테스트 러너 잠정 추천**으로 0016에 적었다. Bun은 보조 런타임 후보로만 두고, Deno는 이번 범위에서 채택 근거가 약하다.
- **A HWPX는 순수 TS로 Node/workerd에서 같은 바이트를 만들었다.** 한글 열기·서식 충실도는 사용자 확인이 필요하다.
- **플랫폼 최종 판정은 하지 않는다.** 로컬 시뮬레이터는 G1·G2·G3의 로컬 부분만 확인했고, G4~G8은 계정·카드·비용·시간 상자 때문에 미측정이다. 0005의 상태를 "최종 판정은 계정·카드·비용 사용자 결정 뒤"로 갱신했다.
