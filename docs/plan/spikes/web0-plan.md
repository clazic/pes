# 5단계 WEB0 — 웹 플랫폼·TS 실행 환경 시험 계획

- 작성: 2026-11-05, Claude 종합(검수 반영)
- Linear: 5단계 `WEB0`(번호만 5단계). **이 문서는 계획이며 Linear 이슈를 만들지 않았다.**
- 입력: [stage-5.md](../stage-5.md) 2.1·2.4·2.5·4절, [decisions/0016-core-language.md](../decisions/0016-core-language.md), [decisions/0005-web-platform.md](../decisions/0005-web-platform.md), [fixtures/api-v1/README.md](../fixtures/api-v1/README.md)
- 상태: **시험 계획 — 실행 전**
- 실행 시점: **2단계 PR1 전.** 5단계 착수까지 기다리지 않고, PR4·13 산출물을 선행으로 요구하지 않는다.
- 범위: **TypeScript 단일 언어**로 만든 최소 코어를 후보 플랫폼·조합에서 돌려, 플랫폼과 TS 런타임을 고른다. 언어 선택(Python vs TS)은 0016에서 이미 TS로 확정됐으므로 다시 묻지 않는다.
- 자료: 합성 fixture만. 실제 `~/pes-projects`·`~/.pes/`, 실키, 기관 자료는 읽거나 쓰지 않는다.

## 1. 목적과 결정 질문

**결정 질문**: TypeScript 단일 코어를 5단계에서 어디에 두고 어떻게 실행할 것인가.

1. **플랫폼·조합**: Cloudflare 중심(X), VPS 중심(Y), Vercel+외부 무료(Z) 중 무엇이 A 한 라운드·B 연결·비용·운영 기준을 가장 잘 만족하는가.
2. **TS 런타임**: Node LTS·Bun·Deno 중 어느 것을 로컬·서버·VPS에서 쓸 것인가.
3. **A의 HWPX 경로**: 사용자 PC 상주 없이 서버측 변환 작업자·브라우저 변환 등으로 처리할 수 있는가.

**비목표**: 전체 웹 UI·로그인·R2·알림·원격 MCP 구현, 운영 배포, 유료 요금제 전환, 실제 프로젝트 이전. WEB0은 **플랫폼·런타임·A HWPX 경로 판정**만 한다.

## 2. 후보와 조합

| 후보 | 구성 | 확인할 것 |
|---|---|---|
| X. Cloudflare 중심 | Workers + D1 + R2 + DO + Workflows, 필요하면 Oracle VM을 계산 보조로 | TS 실행성, Workflows step CPU, D1 계약, DO WebSocket, R2 비용 노출 |
| Y. VPS 중심 | Oracle Always Free → 회수 시 Hetzner, Cloudflare Tunnel/CDN, R2 백업 | TS/Node/Bun 상시 실행, SQLite 파일, WebSocket, 월 총액·운영 부담 |
| Z. Vercel+외부 무료 | Vercel Functions + Turso + R2/Blob + DO/Supabase Realtime | 함수 300초, WS 최대 함수 시간, Turso/Blob 한도, 자료 분산 |

- **공통 계약**: 명령·오류·멱등·10진 문자열·SQLite 스키마·백업 형식은 후보와 무관하게 같다.
- **Cloudflare 기준 구현**: WEB1~14의 D1/R2/Workflows/10ms/Free 조건은 Cloudflare를 고른 경우의 기준 구현이다. Vercel/VPS를 고르면 같은 계약의 해당 부품으로 치환하고, Cloudflare 전용 한도를 일반 계약으로 쓰지 않는다.
- **유료 안**: 월 비용이 생기는 후보는 **비용 승인 뒤 그 예산으로** 시험한다. 승인 전에는 무료·기존 보유 자원만 쓴다.

## 3. PR1 전 최소 TS 구현

- 담당: WEB0. 제품 코드가 아니라 `spikes/web0/ts-core/`의 시험 구현이다.
- **현재 JSON fixture 사용**: `docs/plan/fixtures/api-v1/`의 38개 JSON을 읽기 전용으로 쓴다. PR4·13이 나중에 만들 픽스처를 기다리지 않는다. 픽스처가 바뀌면 별도 결정·수정 이슈로 분리한다.
- 최소 경로: `capabilities`·`context`·`versions`·`claims`·`results`·`wait`·`complete`. `runs`·`heartbeat`·`interrupt`·`cancel`·`handoffs`·`inputs`·`input-receipts`·`changes`는 픽스처가 있으면 parse/validate, 실행 가능하면 실행한다.
- 구현 경계: 라우터·DTO·오류 봉투·D1/SQLite 어댑터·10진 문자열. 제품 모듈 이름을 선점하지 않는다.
- `spikes/web0/package.json`에 `test`·`typecheck`·`measure` 스크립트를 둔다. `web/package.json`은 WEB1에서 만든다.

## 4. 계약 시험

### 4.1 38개 parse/validate

- [ ] 38개 JSON의 `operation`·`method`·`path`·`auth`, `normal`/`error`/`replay` 봉투, `format_version:"1.0"`, 상태 코드 집합을 검사한다.
- [ ] `rev`·`control_rev`·`fence`·`event_seq`·`version_no`·`round_no`·`edition_no`가 정규화 10진 문자열인지 검사한다.
- [ ] 오류 `code`·`message`·`retryable`·`target`·`details`·`next_action`, 모르는 필드 거부·선택 필드 추가 허용을 검사한다.
- [ ] `files-content`·`uploads-put`은 스키마만 검사하고 실행 대상에서 뺀다.

### 4.2 core execute

- [ ] 7개 필수 경로의 normal/error/replay 의미가 같다.
- [ ] Python 기준 구현이 없으므로 **픽스처가 기준**이다. 구현끼리 비교할 때는 같은 픽스처의 status·오류 code·필수 키·`replayed`를 비교한다.
- [ ] D1/SQLite에서 001 스키마·batch 원자성·0행 CAS·deferred FK·부분 UNIQUE·10진 문자열 왕복을 검사한다.

## 5. 플랫폼·런타임 측정

### 5.1 공통 측정

- 합성 프로젝트 1개, 사용자 2명, 1라운드. 경로별 웜 1,000회+콜드 10회, 3회 반복.
- CPU p50/p95/p99/최대, 메모리, 콜드 스타트, 요청 수, DB 쿼리·행 수, 파일 작업, WebSocket 재접속, 월 비용을 기록한다.
- 로컬 개발 서버는 기능 스모크만, 판정은 실제 후보 staging에서 한다.

### 5.2 Cloudflare

- Workers 100k/일, CPU 10ms/호출, 메모리 128MB, **subrequest는 Workflow instance당 50**.
- Workflows: step CPU 10ms, step 1,024/워크플로, 동시 인스턴스 100, 완료 보존 3일, 상태 100MB. **step 추가와 instance 교체를 구분**한다.
- **instance 교체가 Go 사용량·unknown·외부 호출 멱등을 초기화하지 않는다.** 새 instance는 새 claim/fence를 쓰고, 호출 전 영속 attempt·상관키·사용량 예약을 이어 받는다.
- DO: 요청 100k/일, SQL 5GB, 객체 1GB. **WebSocket incoming 20:1은 과금 계산용**이고 메트릭은 실제 메시지 수다. Free cap 실동작은 실측한다.
- R2: 무료 포함량 초과는 과금될 수 있다. $0 보장으로 쓰지 않는다.

### 5.3 Vercel

- Hobby 함수 300초, Active CPU 4 CPU-h/월, 메모리 2GB. **현재 문서 기준 모든 플랜에서 WebSocket을 제공하고 최대 함수 시간 뒤 연결이 종료**된다. ‘공개 베타’ 문구는 현재 문서·배포 계정으로 갱신한다.
- Turso/Blob 무료 한도·카드 등록·지역은 미확인으로 두고 실측한다.

### 5.4 VPS

- **Oracle Always Free 공식 수치(2026-11-05)**: **1,500 OCPU-h·9,000 GB-h/월 = 상시 2 OCPU·12GB**. 7일 CPU p95·네트워크·A1 메모리 각각 **20% 미만**이면 회수 대상이다. 지역 재고·계정별 실제 할당·카드 등록은 WEB0에서 확인한다.
- **Hetzner**: CX22 €4~5는 2차 자료이며, 지역·세금·IPv4·백업·트래픽 포함 **월 총액은 미확인**. WEB0 견적으로 남긴다. 미확인 총액을 확정 상한처럼 쓰지 않는다.
- VPS는 TS/Node/Bun 상시 실행·SQLite 파일·WebSocket을 그대로 쓸 수 있는지 본다.

### 5.5 A의 HWPX 경로

- A는 사용자 PC 없이 끝나야 한다. **서버측 변환 작업자**(VPS/Workflow/Container) 또는 **브라우저 변환**으로 `report.md`→`report.hwpx`를 만들 수 있는지 후보별로 확인한다.
- 외부 변환기는 도구 경계로 두고 PES 코어는 TS 단일 언어를 유지한다.
- 불가능하면 A의 HWPX 지원 범위를 줄이는 **사용자 결정**으로 올린다. 로컬 hwpx-uri만 전제로 통과시키지 않는다.

## 6. Go 주소·사용량·웹 사용량

- **Go 주소는 후보로 표시**한다. 공식 문서 기준 `/inference/openai/...`·`/anthropic/...`·`/google/...`, 모델 목록 `/inference/v1/models`를 우선 검증하고, `/inference/go/...`·`/go/v1/models`는 후보로만 둔다. provider=`opencode-go`, 폴백 금지는 유지한다.
- 원시 model ID↔내부 ID, 구독 적용 조건, `cost`·billing source·allowance를 구분한다. `cost=0`만으로 Go 구독이라고 판단하지 않는다.
- 시작 전 Extra Usage OFF 확인 증거·유효 기간을 남기고, 확인 불가면 차단한다. 계정/워크스페이스 사용률 기준점, 다음 호출 최대 출력·병렬 예약, unknown 영속 처리를 시험한다.
- 웹 쪽 사용량(요청·CPU·D1·R2·DO·KV·Workflows·메일)과 Go 사용량을 같은 계기에서 구분해 표시한다. 모르는 값은 0으로 두지 않는다.

## 7. 판정과 인계

| 결과 | 결정 | 다음 |
|---|---|---|
| X 우세 | Cloudflare 기준 구현 | WEB1~14를 D1/R2/Workflows/DO 기준으로 구체화 |
| Y 우세 | VPS 기준 구현 | 같은 계약을 Node/Bun 상시 프로세스·SQLite 파일로 구체화, 비용 승인 |
| Z 우세 | Vercel+외부 무료 | Turso/Blob/WS 한도·자료 분산·비용을 WEB1~14에 반영 |
| 모두 불합격 | 보류 | 플랫폼·계약·범위 재설계 |

- 결과는 `docs/plan/decisions/0005-web-platform.md`와 `0016-core-language.md`에 측정값·확인일·탈출 조건으로 남긴다.
- **WEB1~14는 WEB0 결과를 입력으로** 플랫폼별 부품을 구체화한다. Cloudflare 전용 10ms/Free 조건을 모든 후보에 일반화하지 않는다.
- 유료 안은 비용 승인 뒤 그 예산으로 시험하고, 승인 전 비용을 발생시키지 않는다.

## 8. 산출물·시간 상자

- `docs/plan/spikes/web0-result.md`, `web0-measurements.csv`, 결정 기록 갱신.
- 시간 상자: X 3일, Y 2일, Z 2일, A HWPX 경로 1일. 넘기면 범위를 줄이고 중간 결과를 기록한다.
- 실제 자료·유료 호출은 하지 않는다.
