# WEB0 결과 — TypeScript 코어·플랫폼 후보 로컬 실측

- 작성: 2026-11-05, WEB0 worker (관리 AI 지시)
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
| `worker/index.ts`, `wrangler.toml` | `wrangler dev --local` Workers + 로컬 D1 진입 |
| `ts-core/vc-handler.ts`·`vc-server.ts` | Vercel Node 함수 형태의 로컬 핸들러 + 로컬 SQLite |
| `test/` | `node:test` 67개 |

### 1.1 실행 명령과 러너 결정

- 테스트 러너: **`node:test`**를 우선 시도해 채택했다. Node 26이 TypeScript를 타입 제거로 바로 실행하고, 추가 러너 의존성이 없으며, 67개 테스트가 통과했다. `tsc --noEmit`은 `typescript` devDependency로 돌린다.
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

### 2.2 7개 필수 경로 실행

각 경로를 새 SQLite 상태에서 실제로 실행하고 픽스처의 status·오류 code·필수 키·`replayed`와 비교했다.

| 경로 | normal | error | replay |
|---|---|---|---|
| `capabilities.get` | 200, `server`·`api_version`·`capabilities` | 401 `unauthorized` | 해당 없음 |
| `context.get` | 200, 8개 키 | 404 `project_not_found` | 해당 없음 |
| `object.version.get` | 200, `object`·`version`·`artifact`·`files` | 404 `version_not_found` | 해당 없음 |
| `runs.claim` | 201, `run`·`lease`·`context_cursor`, fence `3` | 409 `lease_held`(retryable) | 같은 키 재호출 → `replayed:true`(보조 시험) |
| `results.submit` | 201, `object_versions`·`mutation_id`·`event_seq`, `version_no:"4"` | 409 `rev_conflict`(expected/current) | 같은 키·같은 본문 → `replayed:true`, 동일 data |
| `runs.wait` | 200, `run`·`lease`·`waiting`, `waiting_human` | 409 `not_lease_holder` | 해당 없음(픽스처 없음) |
| `runs.complete` | 200, `run`·`stage_approved`·`note` | 409 `run_terminal` | 같은 키 재호출 → `replayed:true`(보조 시험) |

**픽스처 불일치 3건(고치지 않고 기록):**

1. `capabilities`는 `auth:"any"`인데 error 예제는 인증 없이 401 `unauthorized`를 기대한다. 시험 하네스에서 그 오류 사례만 "인증 필수 모드"로 실행해 봉투를 비교했고, 정상 모드는 인증 없이 200임을 함께 확인했다.
2. `complete` error 예제에는 `Idempotency-Key`가 없다. 계약 2절 5번은 쓰기 요청에 키를 필수로 두므로, 시험 하네스가 합성 키를 넣어 상태 오류(`run_terminal`)까지 도달시켰다. 키 누락 자체는 별도 시험에서 422로 확인했다.
3. `wait`는 쓰기 동작이지만 픽스처에 `Idempotency-Key`가 없다. 이 스파이크는 픽스처를 따라 키 없이 실행하고, 멱등 재생은 시험하지 않았다(픽스처에 replay 없음).

이 3건은 **픽스처/계약 정합성 검토 대상**이며, 이 이슈에서는 fixture를 수정하지 않았다(읽기 전용).

### 2.3 SQLite·D1 계약 — 13 pass + 1 info, 미지원 SQL 0

같은 `runContractSuite`를 `node:sqlite`와 `wrangler dev --local` D1에 적용했다.

| 항목 | node:sqlite | 로컬 D1 |
|---|---|---|
| 표 수 | 61 | 61 |
| FK 강제 | 통과 | 통과 |
| CHECK | 통과 | 통과 |
| 부분 UNIQUE(`one_project_owner`·`one_active_edition`·`one_open_round`) | 통과 | 통과 |
| 0행 CAS | `changes=0` | `changes=0` |
| batch 원자성(롤백) | 첫 행 0 | 첫 행 0 |
| deferred FK(project→project_members) | 같은 batch 통과, 누락 시 거부 | 같은 batch 통과, 누락 시 거부 |
| JSON `json_valid`·`json_type` CHECK | 통과 | 통과 |
| 10진 왕복 `9007199254740993` | `CAST(... AS TEXT)` 정확 | `CAST(... AS TEXT)` 정확 |
| 미지원 SQL | 0 | 0 |

**D1 로컬에서 확인한 차이(어댑터 안에서 흡수):**

- **10진 정밀도**: D1의 원시 INTEGER를 JS `number`로 읽으면 `9007199254740993` → `9007199254740992`로 손실된다. `CAST(... AS TEXT)`로 읽어야 한다. `node:sqlite`는 같은 값을 `number`로 읽을 때 `ERR_OUT_OF_RANGE`를 던졌다. 두 경우 모두 어댑터가 항상 TEXT로 읽어야 함을 확인했다.
- **deferred FK 위반 오류 모양**: 로컬 D1은 누락 member를 거부했지만 `SQLITE_CONSTRAINT` 대신 `internal error; reference=...`를 반환했다. 거부 자체는 통과지만, 운영에서 오류 code 매핑을 별도로 확인해야 한다.
- 그 밖의 미지원 SQL은 없었다. DDL을 고치지 않고 그대로 적용했다.

## 3. A 한 라운드 로컬 측정

고정 시나리오: 모델 호출 3회(요청 12+24+28 KiB, 응답 8+16+12 KiB), 결과 제출 2회, 질문/답 1/1, wait/resume/complete 1/1/1, 파일 0바이트. 워밍업 1 + 측정 3 + 연속 10회. 모든 후보가 **같은 `ts-core` 코어 해시 `6e01e236…`**와 같은 가짜 Go를 썼다.

| 후보(로컬 대리) | 측정 3회 벽시계(ms) | 중앙값 | CPU 중앙값(ms) | RSS 중앙값(MB) | 연속 10회 중앙값 | 10회 오류 |
|---|---|---|---|---|---|---|
| VPS 대리: Node 26 + `node:sqlite` | 633.14 / 635.80 / 627.18 | **633.14** | 33.70 | 53.19 | 626.44 ms | 0 |
| VC 대리: Node 함수 핸들러 + 로컬 SQLite | 639.75 / 636.26 / 638.14 | **638.14** | 40.00 | 102.55 | 631.34 ms | 0 |
| CF 대리: `wrangler dev --local` + 로컬 D1 | 669.46 / 667.55 / 667.89 | **667.89** | 70.00 | 511.52 | 668.04 ms | 0 |

- 세 후보 모두 **라운드당 INSERT 55행, 쓰기 문 77개(변경 행 77)**, subrequest 3, 요청 64 KiB·응답 36 KiB로 같았다.
- 계획 표의 "약 51행"과의 차이: 이 구현은 **resume claim 4행**을 추가로 남겨 55행이다(+7.8%, 계획의 ±10% 안). 77은 UPDATE를 포함한 쓰기 문/변경 행 수다. 같은 코어라 후보별 차이는 없다.
- VPS 대리 CPU/RSS는 Node 프로세스 전체(가짜 Go 클라이언트 포함) 값이다. CF 대리는 `wrangler`+`workerd` 프로세스 트리 전체 값이므로 **Workers 요청당 CPU나 128 MB 메모리 한도와 비교할 수 없다**. VC 대리는 함수 서버 프로세스 트리 값이다.
- `wrangler dev` 로컬은 Cloudflare의 실제 CPU 계측을 노출하지 않는다. 따라서 **CF Free 10 ms/호출 판정은 하지 않았다**.

### 3.1 Bun·Deno — 같은 코어 실행 성공

npm devDependency의 로컬 바이너리로 같은 `ts-core` A 라운드를 `node:sqlite` 위에서 실행했다.

| 런타임 | 버전 | 결과 | 벽시계(ms) | CPU(ms) | RSS(MB) | INSERT |
|---|---|---|---:|---:|---:|---:|
| Node | 26.13.0 | 통과(기준) | 633.14(중앙값) | 33.70 | 53.19 | 55 |
| Bun | 1.4.4 | 통과 | 656.83 | 30.00 | 27.89 | 55 |
| Deno | 2.9.6 | 통과 | 757.86 | 90.00 | 50.17 | 55 |

- 세 런타임 모두 `node:sqlite`가 동작했고, 같은 시나리오가 같은 55행을 썼다.
- Bun/Deno는 1회 실행 값이며, 3회·10회 반복과 플랫폼 배포는 measured 범위 밖이다.

## 4. 판정 기준별 상태

| 기준 | 로컬에서 확인 | 아직 아닌 것 |
|---|---|---|
| ① A 한 라운드 | 3/3 + 10/10 완주, 오류 0, subrequest 3/라운드 | 실제 staging CPU·한도, 콜드 스타트, 8시간/30일 |
| ② TS 재사용 | 같은 코어를 Node·Bun·Deno·D1·Node 함수에서 실행, 계약 38/38 | 실제 배포 후 같은 commit 재현 |
| ③ SQLite 계약 | 61표·FK/CHECK/부분 UNIQUE/0행/batch/deferred FK/10진 왕복 통과 | Turso 자체, D1 원격, 운영 크기·잠금 |
| ④ 월 여유 | 라운드당 사용량 고정(3 subrequest, 55 INSERT) | 계정 한도·8시간 하루·30일 투영·R2/DO/KV |
| ⑤ 카드 | 계정을 만들지 않음 | **사용자 결정 필요**: CF/Vercel/Oracle/Hetzner 가입·카드 |
| ⑥ 상시 통로 | 미실행 | **사용자 결정 필요**: 배포 계정 뒤 8시간 WebSocket/SSE soak |
| ⑦ 운영 | 미실행 | **미측정(시간 상자 밖)**: 4주 운영 일지 |
| ⑧ 월 비용 | 공식 수치만 전재 | **사용자 결정 필요**: Turso/Blob 한도, Oracle 지역·할당, Hetzner 월 총액 |

### 4.1 사용자 결정 필요 목록(계정·카드·비용)

- **Cloudflare**: 계정 생성·Workers/D1/R2/DO 활성화에 카드가 필요한지, R2 무료 포함량 초과 위험. 이번 스파이크는 계정 없이 `wrangler dev --local`만 썼다.
- **Vercel**: Hobby 가입·personal/비상업 조건 확인, Turso/Blob 무료 한도와 카드, 함수 WebSocket 최대 연결 시간.
- **Oracle Always Free**: 지역 재고·계정별 A1 할당·카드 등록. 공식 수치(1,500 OCPU-h·9,000 GB-h/월=상시 2 OCPU·12 GB)는 계획서 전재이며 이번에 새로 확인하지 않았다.
- **Hetzner CX22**: €4~5는 2차 자료다. IPv4·백업·트래픽·세금 포함 **월 총액은 미확인**이며 견적·승인이 필요하다.
- **실제 OpenCode Go 호출**: 하지 않았다. 유료 호출은 사용자 비용 승인 뒤 1~2회만, Extra Usage OFF 증거와 함께 별도로 한다.

### 4.2 미측정(시간 상자 밖)

- 8시간 soak, 7일 VPS soak, 4주 운영 일지, 월 30일 사용량 투영의 실제 계정 값
- 실제 WebSocket/SSE 연결·재접속·유실/중복
- 실제 D1 원격·Turso·R2·Blob·DO·KV·Workflows·Queues 동작과 과금
- A의 HWPX 서버측 변환 경로(이 이슈의 만든 것 목록에 없어 실행하지 않음) — **후속 WEB0 항목으로 남김**

## 5. 재현

```sh
cd spikes/web0
npm ci
npm test
npm run typecheck
npm run test:d1   # 로컬 D1 계약(127.0.0.1만)
npm run measure   # CSV 갱신
```

- `npm run measure`는 `127.0.0.1`에만 바인딩하고, 끝나면 `wrangler`/`workerd`/VC 서버를 종료한다. 실행 후 남은 프로세스가 없는지 확인했다.
- 가짜 Go 주소는 문서에 실제 포트 대신 `http://127.0.0.1:<ephemeral>/inference/v1/chat/completions`로만 적었다.
- 개인 절대경로·계정 ID·토큰·세션 ID·이메일은 기록하지 않았다.

## 6. 결론(잠정)

- **TypeScript 단일 코어는 로컬에서 후보 3군 모두에서 같은 업무 로직으로 실행됐다.** 플랫폼 차이는 `db.ts` 어댑터와 진입점에만 있었다.
- **Node 26 + `node:test` + `tsc`를 런타임·테스트 러너 잠정 추천**으로 0016에 적었다. Bun은 보조 런타임 후보로만 두고, Deno는 이번 범위에서 채택 근거가 약하다.
- **플랫폼 최종 판정은 하지 않는다.** 로컬 시뮬레이터는 G1·G2·G3의 로컬 부분만 확인했고, G4~G8은 계정·카드·비용·시간 상자 때문에 미측정이다. 0005의 상태를 "최종 판정은 계정·카드·비용 사용자 결정 뒤"로 갱신했다.
