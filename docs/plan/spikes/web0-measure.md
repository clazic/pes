# WEB0 측정표 초안 — 플랫폼 후보 3군

- 작성: 2026-11-05
- 상태: **측정표 초안 — 실행 전.** 이 문서는 계획·기록 양식이며 코드·설정·플랫폼 계정을 만들지 않는다.
- 전제: `decisions/0016-core-language.md`의 **TypeScript 단일 언어**, `decisions/0013-...`의 **PES 내장 A 실행기(Go HTTP 직접 호출, 로컬 runner·opencode 없음)**, `decisions/0005-web-platform.md`의 후보 3군, `spikes/web0-plan.md`의 **WEB0(번호는 5단계, 실행은 2단계 PR1 전)**을 따른다.
- 최신 기준: `roadmap.md`, `stage-2.md`, `issues/stage-2.md`, `decisions/0013`·`0014`·`0016`, `discussion/2026-11-05-codex-review-2.md`.
- 범위: **플랫폼 비교만**. 전체 웹 UI·로그인·R2·알림·원격 MCP·운영 배포·실제 프로젝트 이전은 WEB0 범위가 아니다.
- 안전: 합성 fixture만 쓴다. 실제 프로젝트 홈·PES 상태 디렉터리, 실키, 기관 자료, 실제 세션 ID·계정 ID·사용자 절대경로는 읽거나 기록하지 않는다. 유료 호출은 사용자 비용 승인 범위 안에서만 한다.

### 0.1 공통 입력

| 항목 | CF | VC | VPS |
|---|---|---|---|
| 계정·지역 | 없음(로컬 `wrangler dev`만) | 없음(로컬 Node 함수 핸들러) | 없음(로컬 Node) |
| 런타임·버전 | Node 26.13.0 / wrangler 4.157.0 / 로컬 D1 | Node 26.13.0 / Bun 1.4.4·Deno 2.9.6 보조 | Node 26.13.0 / `node:sqlite` |
| TS 코어 hash | `de7f7c8c…`(커밋 전 작업 트리, 세 후보 동일) | 같음 | 같음 |
| fixture hash | `02a4111b…`(38개) | 같음 | 같음 |
| 가짜 Go endpoint(마스킹) | `http://127.0.0.1:<ephemeral>/inference/v1/chat/completions` | 같음 | 같음 |
| 측정일·담당 | 2026-11-05, WEB0 worker | 같음 | 같음 |

## 1. 고정 합성 시나리오 — A 한 라운드

모든 후보에 **같은 fixture·같은 TS 코어·같은 가짜 Go 응답**을 쓴다. 후보별로 시나리오를 바꾸지 않는다.

| 항목 | 고정값 | 비고 |
|---|---|---|
| 프로젝트/판/단계/라운드 | 1 / 1 / 1 / 1 | 합성 프로젝트 1개 |
| run | 1개(worker만, reviewer 제외) | reviewer는 별도 run이므로 이 표에서 제외 |
| 모델 호출 | **3회** | ① 기획·개요 ② 결과 초안 ③ 답 반영·수정 |
| 요청 크기 | 12 KiB + 24 KiB + 28 KiB = **64 KiB** | 시스템·맥락·이전 결과 포함 |
| 응답 크기 | 8 KiB + 16 KiB + 12 KiB = **36 KiB** | 구조화 JSON, 스트리밍 제외 |
| 결과 제출 | 2회 | 초안 1회 + 답 반영 수정 1회 |
| 질문/답 | **1회 / 1회** | `question.ask` 1개, 사람 답 1개 |
| wait/resume/complete | 1 / 1 / 1 | 질문 뒤 `waiting_human`, 답 뒤 새 claim으로 재개 |
| 파일 | 0 bytes | 기준 시나리오는 첨부 없음. 1 MiB 첨부는 별도 변형 |
| DB 읽기 | 약 **500행** | 맥락·버전·질문·답·영수증 |
| DB 쓰기 | 약 **51행** | 아래 표. ±10% 허용 |

### 1.1 호출·저장 세부

| 구간 | 쓰는 표 | 행 수(대략) |
|---|---|---:|
| run 시작·claim | `runs`, `project_leases`, `mutation_commits`, `events` | 5 |
| Go 시도 3회 | `outbound_dispatches`(prepared→sent→adopted), `mutation_commits`, `events` | 9 |
| 결과 초안 제출 | `objects`, `object_versions`, `artifacts`, `artifact_versions`, `mutation_commits`, `events` | 7 |
| 질문 1회 | `objects`, `object_versions`, `questions`, `question_versions`, `question_sets`, `question_set_members`, `mutation_commits`, `events` | 9 |
| 답 1회 | `submissions`, `answers`, `answer_versions`, `mutation_commits`, `events` | 5 |
| 결과 수정 제출 | `objects`, `object_versions`, `artifacts`, `artifact_versions`, `mutation_commits`, `events` | 7 |
| wait·입력 영수증 | `runs`(상태), `project_leases`(해제), `run_input_receipts`, `mutation_commits`, `events` | 6 |
| complete | `runs`, `mutation_commits`, `events` | 3 |
| **합계** | | **51** |

- `events`는 한 변경에 1~2행으로 잡는다. 실제 스키마·서비스 구현이 다르면 **같은 시나리오의 행 수를 후보별로 같게 맞춘 뒤** 차이를 기록한다.
- 기준 시나리오는 **파일 없음**이다. 파일 경로·R2/Blob·멀티파트는 별도 `1 MiB 첨부` 변형에서만 잰다.
- Go OFF·unknown·한도 초과는 플랫폼 비교가 아니라 기능 시험이므로 이 표에서 제외한다. WEB7/WEB12에서 따로 시험한다.

### 1.2 가짜 Go와 실제 Go의 구분

| 구분 | 호출 수 | 대상 | 무엇을 재나 | 반복 |
|---|---:|---|---|---|
| 가짜 Go | 회차당 3회 | 고정 합성 endpoint(`fake-go.example.invalid` 같은 placeholder, 실제 주소는 기록 시 마스킹) | 플랫폼 CPU·요청·subrequest·DB·저장·WebSocket·월 사용량 | 워밍업 1회 + 측정 3회 + 10라운드 연속 |
| 실제 Go | **전체 1~2회** | OpenCode Go HTTP API 직접 호출(0013) | 실제 지연·토큰·응답 헤더·billing source/allowance·오류 형식 | 후보 1~2개에서 각 1회. 재시도 금지 |

- 가짜 Go는 **결정적 JSON**을 돌려준다. 호출 1은 8 KiB 개요, 호출 2는 16 KiB 결과 JSON, 호출 3은 12 KiB 수정 JSON. 고정 지연 200 ms, HTTP 200, 요청 수·바이트·헤더를 기록한다.
- 실제 Go는 **가짜 시험이 끝난 뒤** 사용자 비용 승인을 받아 1~2회만 호출한다. 합성 prompt만 쓰고 실제 자료를 넣지 않는다. `cost=0`만으로 Go 구독이라고 판단하지 않고 `billing_source`·`allowance`·오류/스트림 필드를 함께 기록한다. 응답 유실·타임아웃은 unknown으로 남기고 자동 재호출하지 않는다.
- 실제 Go 호출은 **플랫폼 한도·CPU·월 사용량 산정에 쓰지 않는다**. 그 값은 가짜 Go 반복 측정으로만 낸다. 실제 호출은 계약·과금 필드 확인용이다.
- 실제 Go 호출 전 Extra Usage OFF 확인 증거·유효 기간을 확인하고, 확인 불가면 호출하지 않는다. 비용 상한·호출 수는 사용자 승인 범위를 넘지 않는다.

**실제 Go 승인·기록**

| 항목 | 값 |
|---|---|
| 승인일 | 미해당(호출 없음) |
| 승인 호출 수(≤2) | 0 |
| 승인 비용 상한 | 미승인 |
| Extra Usage OFF 확인 시각·유효 기간 | 미확인 |
| 실제 호출 후보·횟수 | 없음 |
| 응답 상태·지연·토큰 | 미측정 |
| billing_source·allowance·cost | 미측정 |
| unknown/중단 사유 | 실제 Go 호출을 하지 않았다(사용자 비용 승인 필요) |

## 2. 후보 3군과 공식 한도

| 후보 | 구성 | TS 실행 | DB/파일 | 실시간 | 전제 |
|---|---|---|---|---|---|
| **CF. Cloudflare 무료** | Workers + Workflows + D1 + R2 + DO(선택) | Workers(TS) | D1 / R2 | DO WebSocket | 기본 후보. Cloudflare 전용 한도를 공통 계약으로 쓰지 않음 |
| **VC. Vercel Hobby + Turso** | Vercel Functions + Turso(libSQL) + Blob | Node/TS | Turso / Vercel Blob | Functions WebSocket(최대 함수 시간) | 동등 후보. Hobby personal·비상업 조건은 배포 주체 확인 |
| **VPS. Oracle Always Free→Hetzner** | Oracle A1→회수 시 Hetzner CX22, Cloudflare Tunnel/CDN | Node/Bun(TS) | SQLite 파일 / 로컬 디스크 | 직접 WebSocket | 대안. 월 총액은 WEB0 견적·사용자 승인 |

### 2.1 공식 한도·출처·확인일

> 값은 계획서가 2026-11-05 확인한 공식 페이지를 전재한 것이다. WEB0에서 **같은 계정·같은 지역**으로 다시 확인하고, 계정별 실제 할당·과금은 기록표에 적는다. `미확인`은 추정값으로 채우지 않는다.

| 후보/자원 | 값 | 단위 | 출처 | 확인일 | 상태 |
|---|---|---|---|---|---|
| CF Workers 요청 | 100,000 | 요청/일 | `developers.cloudflare.com/workers/platform/limits/` | 2026-11-05 | 확인 |
| CF Workers CPU | 10 | ms/호출 | 같은 문서 | 2026-11-05 | 확인 |
| CF Workers 메모리 | 128 | MB | 같은 문서 | 2026-11-05 | 확인 |
| CF Workers subrequest | 50 | 요청/호출 | 같은 문서 | 2026-11-05 | 확인 |
| CF 정적 자산 | 20,000 / 25 | 파일/버전, MiB/파일 | 같은 문서·pricing | 2026-11-05 | 확인 |
| CF Cron | 5 | 개/계정 | 같은 문서·cron-triggers | 2026-11-05 | 확인 |
| CF Workflows step CPU | 10 | ms/step | `developers.cloudflare.com/workflows/reference/limits` | 2026-11-05 | 확인 |
| CF Workflows step | 1,024 / 3,000 | step/워크플로, step/일 | Workflows limits·Workers pricing | 2026-11-05 | 확인 |
| CF Workflows 동시 인스턴스 | 100 | 개 | Workflows limits | 2026-11-05 | 확인 |
| CF Workflows instance subrequest | 50 | 요청/인스턴스 전체 | Workflows limits | 2026-11-05 | 확인 |
| CF Workflows 보존/상태 | 3일 / 100 MB | 기간 / 상태 | Workflows limits | 2026-11-05 | 확인 |
| CF D1 DB 크기 | 500 | MB/DB | `developers.cloudflare.com/d1/platform/limits/` | 2026-11-05 | 확인 |
| CF D1 DB 수·계정 저장 | 10 / 5 | 개/계정, GB/계정 | 같은 문서 | 2026-11-05 | 확인 |
| CF D1 읽기/쓰기 | 5,000,000 / 100,000 | 행/일 | D1 limits·pricing | 2026-11-05 | 확인 |
| CF D1 쿼리/행/SQL/바인딩 | 50 / 2 MB / 100 KB / 100 | 개/호출, MB, KB, 개 | D1 limits | 2026-11-05 | 확인 |
| CF D1 Time Travel | 7 | 일 | D1 limits | 2026-11-05 | 확인 |
| CF D1 import | 5 | GB | D1 limits | 2026-11-05 | **미확인**(문서 표기 불명확) |
| CF R2 저장 | 10 | GB-month/월 | `developers.cloudflare.com/r2/pricing/` | 2026-11-05 | 확인 |
| CF R2 작업 | Class A 1,000,000 / Class B 10,000,000 | 회/월 | R2 pricing | 2026-11-05 | 확인 |
| CF R2 객체/업로드 | 5 TiB / 5 GiB / 100,000 | 객체, 단일 업로드, 버킷 | R2 limits | 2026-11-05 | 확인 |
| CF DO | 100,000 요청/일, 5 GB 저장, 1 GB/객체 | — | stage-5 2.5.1·DO pricing | 2026-11-05 | **Free 포함량·과금 WEB0 실측** |
| CF KV(OAuth 선택) | 100,000 읽기/일, 1,000 쓰기/일, 1 GB | — | `developers.cloudflare.com/kv/platform/limits/` | 2026-11-05 | 확인 |
| CF Queues | 10,000 / 24시간 | ops/일, 보존 | Workers pricing | 2026-11-05 | 확인 |
| VC Functions 실행 | 300 | 초/호출 | `vercel.com/pricing`·docs limits | 2026-11-05 | 확인 |
| VC Hobby Active CPU | 4 | CPU-h/월 | Vercel pricing | 2026-11-05 | 확인 |
| VC Hobby 메모리 | 2 | GB | Vercel pricing | 2026-11-05 | 확인 |
| VC WebSocket | 모든 플랜 제공, 최대 함수 시간 뒤 종료 | — | Vercel docs(2026-11-05) | 2026-11-05 | 확인 |
| VC Hobby personal | 개인·비상업 조건 | — | Vercel 약관 | 2026-11-05 | **배포 주체 조건 WEB0 확인** |
| VC Turso DB | — | — | Turso pricing | 2026-11-05 | **미확인** |
| VC Blob | — | — | Vercel Blob pricing | 2026-11-05 | **미확인** |
| VC cron/큐/호출 체인 | — | — | Vercel docs | 2026-11-05 | **미확인** |
| VPS Oracle Always Free | 1,500 OCPU-h + 9,000 GB-h/월 = 상시 2 OCPU·12 GB | — | `oracle.com/cloud/free/` | 2026-11-05 | 확인 |
| VPS Oracle 회수 | 7일 CPU p95·네트워크·A1 메모리 각 20% 미만 | — | Oracle Always Free 문서 | 2026-11-05 | 확인 |
| VPS Oracle 지역/할당/카드 | 지역 재고·계정별 할당·카드 | — | Oracle 문서·계정 | 2026-11-05 | **WEB0 확인** |
| VPS Hetzner CX22 | €4~5(2차 자료) + IPv4·백업·트래픽·세금 | 월 총액 | Hetzner pricing | 2026-11-05 | **2차 자료·WEB0 견적** |

- Cloudflare R2는 **무료 포함량 초과분이 종량 과금**될 수 있다. 80% 경보·90% 완화만으로 $0을 보장하지 않는다.
- Vercel/Turso/Blob의 무료 한도·카드·긴 작업 이어가기는 **미확인**이다. 모르는 값을 0으로 채우지 않는다.
- Oracle/Hetzner는 월 총액이 확정되지 않았으면 "무료"로 단정하지 않는다.

## 3. 판정 기준별 측정표

각 기준은 **후보별 통과/탈락만** 기록한다. 점수·가중치·평균은 쓰지 않는다.

### ① A 한 라운드가 무료/저비용 한도 안

| 후보 | 무엇을(단위) | 어떻게(절차·도구·반복) | 통과 기준 | 실패 시 다음 행동 |
|---|---|---|---|---|
| CF | 회차별 CPU p95(ms/step), subrequest 수, Workflows step, D1 읽기/쓰기 행, 오류 코드 | 같은 fixture로 워밍업 1 + 측정 3회 + 10라운드 연속. Workflows/Workers 로그·`wrangler tail`·D1 계측 | 3/3 완주, 10라운드 무오류, p95 ≤8 ms, subrequest <50/instance, step <1,024, D1 쓰기 <1,000행/라운드 | step 분할·맥락 축소. CPU 10 ms를 계속 넘으면 VPS로 이동 |
| VC | 함수 실행 시간(s), Active CPU(ms/라운드), 메모리(MB), timeout 수 | 같은 fixture로 1+3회, 10라운드 연속. Vercel 로그·함수 계측 | 3/3 <300초, 10라운드 timeout 0, 메모리 <2 GB, 30라운드/월 Active CPU <2 CPU-h(4h의 50%) | 함수 분할·호출 체인. 300초/CPU를 넘으면 VPS/CF |
| VPS | 라운드 벽시계(s), CPU(2 OCPU 대비 %), RSS(MB), OOM/재시작 수 | 같은 fixture로 1+3회, 10라운드 연속, 24시간 soak. Node/Bun 프로세스·`/proc`·cgroup | 3/3 <60초, 10라운드 OOM/재시작 0, CPU <50%, RSS <4 GB | 프로세스 튜닝. 2 OCPU를 넘으면 Hetzner/CF |

**기록표 — ①**

| 후보 | 1회 | 2회 | 3회 | 중앙값 | 판정 | 비고 |
|---|---|---|---|---|---|---|
| CF | 695.55 ms | 688.46 ms | 696.43 ms | **695.55 ms** | 미판정(로컬 대리) | 벽시계. CPU는 wrangler+workerd 프로세스 대리 110 ms. subrequest 3, 신규 53행·변경 85행, 10/10 오류 0 |
| VC | 642.73 ms | 642.05 ms | 639.26 ms | **642.05 ms** | 미판정(로컬 대리) | 벽시계. CPU는 함수 서버 프로세스 대리 40 ms. subrequest 3, 신규 53행·변경 85행, 10/10 오류 0 |
| VPS | 635.10 ms | 621.00 ms | 625.59 ms | **625.59 ms** | 미판정(로컬 대리) | 벽시계. CPU는 Node 프로세스 25 ms(가짜 Go 포함). subrequest 3, 신규 53행·변경 85행, 10/10 오류 0 |

### ② TS 같은 코드 재사용

| 후보 | 무엇을(단위) | 어떻게(절차·도구·반복) | 통과 기준 | 실패 시 다음 행동 |
|---|---|---|---|---|
| CF | 코어 commit, 공유 모듈 LOC/%, 플랫폼 adapter LOC, 계약 시험 통과 수 | 같은 TS 코어를 Workers에 배포, `tests/contracts` 38개 fixture 실행. 3회 반복 | 같은 코어 commit, adapter만 플랫폼별, 38/38 통과, 업무 로직 포크 0 | adapter·compatibility 조정. 업무 로직 포크가 필요하면 탈락 |
| VC | 같은 항목, Node 실행 | 같은 코어를 Vercel Node/Functions에 배포, 38개 실행 | 같은 코어 commit, 38/38, 포크 0 | Node adapter 조정. 포크 필요 시 탈락 |
| VPS | 같은 항목, Node/Bun 실행 | 같은 코어를 Node LTS·Bun에 배포, 38개 실행 | 같은 코어 commit, 38/38, 포크 0 | 런타임 교체. 포크 필요 시 탈락 |

**기록표 — ②**

| 후보 | 코어 commit | 계약 38/38 | adapter LOC | 런타임·버전 | 판정 | 비고 |
|---|---|---|---|---|---|---|
| CF | `de7f7c8c…` | 38/38 + D1 16 pass | 125줄(`db.ts` D1 + `worker/index.ts`) | Node 26.13.0 / wrangler 4.157.0 | 로컬 통과(배포 미측정) | 같은 업무 로직, 업무 분기 0. 7경로 normal/error/replay 실행 |
| VC | 같음 | 38/38 + SQLite 16 pass | 206줄(`db.ts` + `sqlite-adapter.ts` + `vc-handler.ts`) | Node 26.13.0 | 로컬 통과(배포 미측정) | Vercel형 Node 핸들러로 실행. Turso 자체는 미측정 |
| VPS | 같음 | 38/38 + SQLite 16 pass | 58줄(`sqlite-adapter.ts`, 공통 `Db` 인터페이스 별도) | Node 26.13.0 / Bun 1.4.4 / Deno 2.9.6 | 로컬 통과 | 세 런타임 모두 같은 A 라운드 신규 53행 |

### ③ SQLite 계약 유지

| 후보 | 무엇을(단위) | 어떻게(절차·도구·반복) | 통과 기준 | 실패 시 다음 행동 |
|---|---|---|---|---|
| CF | 61표 migration, FK/CHECK/부분 UNIQUE/JSON 함수, 0행 CAS, batch 원자성, 10진 문자열 | D1 로컬/스테이징에 같은 001 migration, 대표 명령·거부 사례 3회 | 61표·제약·0행 실패·롤백·10진 왕복 통과, SQL 재작성은 adapter에 한정 | D1 미지원 SQL이면 해당 부품 교체 또는 탈락 |
| VC | 같은 항목, Turso/libSQL | Turso에 같은 migration·대표 명령 3회 | 같은 기준 통과, SQLite 호환 유지 | libSQL 차이를 adapter에 못 가두면 탈락 |
| VPS | 같은 항목, SQLite 파일 | 로컬 SQLite에 같은 migration·대표 명령 3회 | 같은 기준 통과, 파일 잠금·WAL·복구 통과 | 파일 DB가 계약을 못 지키면 탈락 |

**기록표 — ③**

| 후보 | 61표 | 제약·0행·롤백 | 10진 왕복 | 미지원 SQL 수 | 판정 | 비고 |
|---|---|---|---|---|---|---|
| CF | 61/61 | 16 pass(1 info) | `CAST AS TEXT` 정확 | 0 | 로컬 통과 / 원격 미측정 | deferred FK 누락 거부가 `internal error; reference=…`로 반환됨(거부는 됨). 원시 INTEGER `number` 읽기는 정밀도 손실 |
| VC | 61/61 | 16 pass(1 info) | `CAST AS TEXT` 정확 | 0 | 로컬 통과 / Turso 미측정 | 로컬 SQLite를 Turso/libSQL 대리로 사용. Turso 클라이언트·계정은 시험하지 않음 |
| VPS | 61/61 | 16 pass(1 info) | `CAST AS TEXT` 정확 | 0 | 로컬 통과 | `node:sqlite`. 원시 2^53+1 읽기는 `ERR_OUT_OF_RANGE` |

### ④ 월 사용량 대비 여유

기준 사용량: **사용자 1명·프로젝트 3개(활성 1개)·A 30라운드/월·페이지 100회/일·API 1,000회/일·에이전트 2개·활성 8시간/일**. 25~30초 long poll, 탭 숨김 중지, 3초 기본값 없음.

| 후보 | 무엇을(단위) | 어떻게(절차·도구·반복) | 통과 기준 | 실패 시 다음 행동 |
|---|---|---|---|---|
| CF | 요청·Workflows step·subrequest·D1 읽기/쓰기/저장·R2·DO·KV 사용률(%) | 10라운드 연속 + 8시간 하루 시뮬레이션, 3회. 30일로 선형 투영 | 각 알려진 한도 <50%, D1 저장 <350 MB(3프로젝트), R2 <8 GB, DO/KV 미확인 값은 실측 전 통과로 쓰지 않음 | 폴링·보존·아카이브 축소. 350 MB/500 MB 또는 90% 신호면 유료/중단 |
| VC | Active CPU·함수 호출·Turso/Blob 사용률(%) | 같은 10라운드 + 8시간, 3회. 30일 투영 | 알려진 한도 <50%, 30라운드/월 Active CPU <2 CPU-h, Turso/Blob 미확인은 실측 전 통과로 쓰지 않음 | CPU·호출 축소. 4 CPU-h 초과면 유료/탈락 |
| VPS | 7일 CPU p95·네트워크·메모리(%), 디스크·RSS | 7일 연속 soak, 10라운드/일, 3회 반복 가능한 항목은 3회 | 각 지표 <20%(Oracle 회수 기준), 디스크 <50%, OOM 0 | 리사이즈·Hetzner 견적. 20% 근접 시 CF/VPS 재검토 |

**기록표 — ④**

| 후보 | 요청/step % | CPU % | D1/Turso 저장 % | R2/Blob % | 30일 투영 | 판정 | 비고 |
|---|---|---|---|---|---|---|---|
| CF | subrequest 3/50(6%)/라운드 | 미측정 | 미측정 | 미측정 | 30라운드/월 선형: subrequest 90, 신규 1,590행·변경 2,550행(쓰기 문 3,150) | **미판정** | 8시간/일·페이지·API 부하 미측정. 실제 계정 한도 아님 |
| VC | subrequest 3/라운드 | 로컬 40 ms/라운드(계측 아님) | 미측정(Turso) | 미측정(Blob) | 30라운드/월: Active CPU 약 1.2 CPU-s(4 CPU-h의 <1%, 선형 계산) | **미판정** | Vercel Active CPU 계측 아님. Turso/Blob 한도 미확인 |
| VPS | subrequest 3/라운드 | 로컬 23~40 ms/라운드(2 OCPU 대비 <1% 계산) | 미측정(파일 크기) | 해당 없음(로컬 디스크) | 30라운드/월 CPU 약 1.2초(벽시계 약 19초) | **미판정** | 7일 soak·디스크·네트워크 미측정 |

### ⑤ 카드 등록

| 후보 | 무엇을(단위) | 어떻게(절차·도구·반복) | 통과 기준 | 실패 시 다음 행동 |
|---|---|---|---|---|
| CF | 카드 필요 여부·단계·금액(USD) | 계정 생성→Workers/D1→R2/DO 순으로 활성화 시도. 1회, 화면 문구 기록 | 카드 불필요 또는 사용자 명시 승인 | 사용자 거부 시 이 경로 탈락 |
| VC | 카드 필요 여부·단계·금액(USD) | Hobby 가입→Turso/Blob 활성화. 1회 | 카드 불필요 또는 사용자 승인, Hobby personal 조건 충족 | 거부/조건 불충족 시 탈락 |
| VPS | 카드 필요 여부·단계·금액(USD) | Oracle 가입·A1 할당→Hetzner 견적. 1회 | 카드 불필요 또는 사용자 승인, 월 총액 승인 | 거부/견적 불가 시 탈락 |

**기록표 — ⑤**

| 후보 | 카드 필요? | 필요 단계 | 금액·조건 | 사용자 승인 | 판정 | 비고 |
|---|---|---|---|---|---|---|
| CF | **미확인** | 계정 생성 → Workers/D1/R2/DO 활성화 | R2 무료 포함량 초과는 과금 가능 | 없음 | **사용자 결정 필요** | 계정을 만들지 않음 |
| VC | **미확인** | Hobby 가입 → Turso/Blob 활성화 | Hobby personal·비상업, Turso/Blob 카드 미확인 | 없음 | **사용자 결정 필요** | 계정을 만들지 않음 |
| VPS | **미확인** | Oracle 가입·A1 할당 → Hetzner 견적 | Oracle 지역·할당·카드, Hetzner 월 총액 미확인 | 없음 | **사용자 결정 필요** | 계정·견적 없음 |

### ⑥ 상시 양방향 통로(웹소켓/SSE)

⑥은 **B의 PC 연결 도우미↔웹 PES 통로**를 뜻하며, A의 Go 호출과 별개다. WebSocket이 막히면 SSE(웹→PC)+HTTP(PC→웹)로 같은 이벤트·커서를 유지한다.

| 후보 | 무엇을(단위) | 어떻게(절차·도구·반복) | 통과 기준 | 실패 시 다음 행동 |
|---|---|---|---|---|
| CF | 8시간 유휴 연결 유지, 재접속 시간(s), 메시지 유실·중복, RTT(ms) | DO WebSocket에 1메시지/5분, 100메시지, 8시간 soak. hibernation·재접속 3회 | 8시간 유지 또는 재접속 <5초, 유실 0(커서), 중복 0(멱등), RTT p95 <500 ms | SSE+HTTP로 대체. 계속 실패하면 VPS |
| VC | 최대 연결 시간(s), 재접속(s), 유실·중복 | Functions WebSocket 8시간 시도, 300초 경계·재접속 3회 | 8시간 상시는 어려우면 **SSE+HTTP 대체**로 5초 재접속·유실 0. 상시 통로는 "대체 경로"로만 표시 | 대체 불가면 상시 기준 탈락(중간 후보로만) |
| VPS | 8시간 유지, 재접속(s), 유실·중복 | 직접 WebSocket 8시간 soak, 재접속 3회 | 8시간 유지 또는 재접속 <5초, 유실 0 | 프로세스·프록시 조정. 실패 시 CF |

**기록표 — ⑥**

| 후보 | 8시간 유지 | 재접속(s) | 유실/중복 | RTT p95 | 대체 경로 | 판정 |
|---|---|---|---|---|---|---|
| CF | 미측정(시간 상자 밖) | 미측정 | 미측정 | 미측정 | SSE+HTTP 후보 | **미판정** |
| VC | 미측정(시간 상자 밖) | 미측정 | 미측정 | 미측정 | SSE+HTTP 후보 | **미판정** |
| VPS | 미측정(시간 상자 밖) | 미측정 | 미측정 | 미측정 | 직접 WebSocket | **미판정** |

### ⑦ 운영 부담

| 후보 | 무엇을(단위) | 어떻게(절차·도구·반복) | 통과 기준 | 실패 시 다음 행동 |
|---|---|---|---|---|
| CF | 초기 설정 시간, 월 운영 시간, 수동 단계 수, 배포·복구 훈련 | 계정 구성→배포→마이그레이션→백업/복구를 1회, 4주 운영 일지 | 월 ≤8시간, 매일 수동 단계 0, runbook만으로 복구 1회 | 자동화. 계속 >8시간이면 추천 제외 |
| VC | 같은 항목 + Turso/Blob 분리 운영 | 같은 1회+4주 일지 | 월 ≤8시간, 매일 수동 0, 이중 부품 복구 1회 | 자동화. >8시간이면 추천 제외 |
| VPS | 같은 항목 + OS 패치·TLS·터널·감시 | 같은 1회+4주 일지 | 월 ≤8시간, 매일 수동 0, 패치·복구 runbook 1회 | 컨테이너·자동 업데이트. >8시간이면 CF/VC |

**기록표 — ⑦**

| 후보 | 초기 설정(h) | 월 운영(h) | 수동 단계/일 | 복구 훈련 | 판정 | 비고 |
|---|---|---|---|---|---|---|
| CF | 미측정 | 미측정 | 미측정 | 미측정 | **미판정** | 4주 운영 일지 없음 |
| VC | 미측정 | 미측정 | 미측정 | 미측정 | **미판정** | 4주 운영 일지 없음 |
| VPS | 미측정 | 미측정 | 미측정 | 미측정 | **미판정** | 4주 운영 일지 없음 |

### ⑧ 월 총비용

| 후보 | 무엇을(단위) | 어떻게(절차·도구·반복) | 통과 기준 | 실패 시 다음 행동 |
|---|---|---|---|---|
| CF | USD/월(도메인 별도), R2 초과 예비 | 청구 예상·무료 한도 대비 30일 투영, R2 8GB 시나리오 | 무료 경로 $0 또는 사용자 승인 상한 이하, R2 초과 위험 표시 | 초과 시 R2 예약·차단. 상한 초과면 유료 승인/탈락 |
| VC | USD/월(도메인·Turso·Blob 포함) | Hobby+Turso/Blob 견적, 30일 투영 | 사용자 승인 상한 이하, 미확인 항목 0 | 미확인/초과면 탈락 또는 유료 승인 |
| VPS | USD/월(Oracle $0 또는 Hetzner 견적+IPv4·백업·트래픽·세금) | Oracle 무료 확인 + Hetzner 견적, 30일 | 사용자 승인 상한 이하, 총액 확정 | 총액 미확정/초과면 탈락 |

**기록표 — ⑧**

| 후보 | 플랫폼 | DB/파일 | 도메인 | 월 총액 | 상한 대비 | 판정 | 비고 |
|---|---|---|---|---|---|---|---|
| CF | Free 하드 캡(Workers 100k/일·D1 5M/10만 행/일·Workflows 3,000 step/일) | D1 500 MB/DB·R2 10 GB-month | 별도 | **0 USD(한도 내) + R2 초과 위험** | 미확인 | **사용자 결정 필요** | 공식 수치 전재. R2는 $0 보장 아님 |
| VC | Hobby 300초·4 CPU-h/월·2 GB | Turso·Blob **미확인** | 별도 | **미확인** | 미확인 | **사용자 결정 필요** | Turso/Blob 카드·한도·지역 미확인 |
| VPS | Oracle Always Free 1,500 OCPU-h+9,000 GB-h/월 | SQLite 파일·로컬 디스크 | 별도 | Oracle 0 USD(조건부), Hetzner **미확인** | 미확인 | **사용자 결정 필요** | 지역·할당·카드·월 총액(IPv4·백업·트래픽·세금) 미확인 |

### ⑨ A HWPX 경로(최소 실행 가능성)

합성 `report.md`(제목·문단 2개·표 1개)를 순수 TypeScript + fflate로 `report.hwpx`로 변환했다. 네이티브 바이너리·외부 변환기·사용자 PC는 쓰지 않는다.

| 경로 | 결과 | 벽시계(ms) | CPU(ms) | RSS(MB) | 결과 크기 | 비고 |
|---|---|---:|---:|---:|---:|---|
| Node 26(VPS/VC 대리) | 통과 | 1.61 | 5.55 | 54.41 | 3,061 B | 기준 sha256 |
| `wrangler dev` 로컬 workerd(CF 대리) | 통과 | 2.58 | 0.00(표본 하한) | 393.98 | 3,061 B | Node와 **동일 sha256** |
| 브라우저 번들(esbuild `platform=browser`) | 통과 | — | — | — | 26,625 B 번들 | `node:`/DOM API 없음 |

- 구조 검증: `mimetype` 첫 항목·무압축, `version.xml`, `META-INF/container.xml`, `Contents/content.hpf`, `Contents/header.xml`, `Contents/section0.xml`, `hp:tbl`/`hp:tr`/`hp:tc`.
- **사용자 확인 필요(한글에서 열기)**: 한글 프로그램 실제 열기·서식 충실도는 확인할 수 없다.
- 한계: `hwpx-uri` 대비 출력 차이·호환성은 비교하지 않았다. 최소 골격 시험이며 제품 경로는 6단계 X1에서 확정한다.
- 생성 파일은 `spikes/web0/out/hwpx/report.hwpx`(gitignore)에만 두고 커밋하지 않는다.

## 4. 공통 실행 절차

1. **준비**: 같은 fixture hash, 같은 TS 코어 commit, 같은 가짜 Go endpoint, 같은 모델 ID(`opencode-go/deepseek-v4.1-flash`)를 기록한다. 후보별 계정·지역·런타임 버전을 적는다.
2. **워밍업**: 후보마다 콜드 1회 + 워밍업 1회. 워밍업 값은 판정에 쓰지 않는다.
3. **A 라운드**: 측정 3회. 각 회차는 새 run·새 프로젝트 상태에서 시작한다. 같은 fixture를 재사용하되 이전 run의 캐시·lease를 물려받지 않는다.
4. **연속 부하**: 10라운드 연속. 1027/1102/timeout/step/subrequest/OOM/429가 하나라도 나오면 그 후보의 ①은 실패다.
5. **월 투영**: 10라운드와 8시간 하루 사용량을 30일로 선형 투영한다. 선형 투영이 부적절한 항목(이벤트 로그 누적, R2 백업)은 별도 산식으로 적는다.
6. **WebSocket**: 8시간 soak. 1메시지/5분 + 100메시지 버스트. 재접속 3회. 유실은 커서로, 중복은 멱등 키로 확인한다.
7. **VPS 7일**: Oracle 회수 기준을 보려면 7일 연속 soak가 필요하다. 시간 상자 때문에 단축하면 "7일 미측정"으로 표시하고 Oracle 회수 가능성을 통과로 쓰지 않는다.
8. **운영 일지**: 4주. 설정·배포·백업·복구·패치·장애 대응 시간을 기록한다.
9. **실제 Go**: 가짜 시험 통과 후, 사용자 승인 범위에서 1~2회. 합성 prompt만. 응답 유실·타임아웃은 unknown으로 남기고 재호출하지 않는다.
10. **정리**: 합성 fixture·가짜 endpoint·계정 리소스를 삭제하고, 실제 자료·키·세션 ID가 기록에 없는지 확인한다.

## 5. 결과 판정 규칙 — 가중치 없음

### 5.1 탈락 조건 먼저

| 게이트 | 탈락 조건 | 예외 |
|---|---|---|
| G1 TS 재사용 | 같은 TS 코어를 못 쓰고 업무 로직 포크가 필요함, 계약 38/38 실패 | 없음 |
| G2 SQLite 계약 | 61표·FK/CHECK/부분 UNIQUE/0행 CAS/롤백/10진 왕복 실패, SQL 재작성이 adapter 밖으로 번짐 | 없음 |
| G3 A 라운드 | 3회 중 1회라도 hard limit·timeout·subrequest/step 초과로 완주 실패 | 없음 |
| G4 월 여유 | 알려진 한도 50% 초과 또는 D1 350MB/R2 8GB 초과, VPS Oracle 20% 초과 | 사용자 승인 유료 상한이 있으면 별도 |
| G5 카드 | 카드 필요 + 사용자 거부, Hobby personal 조건 불충족 | 없음 |
| G6 상시 통로 | 8시간 유지·5초 재접속·유실 0을 못 맞추고 SSE+HTTP 대체도 실패 | Vercel은 "중간 후보"로만 남길 수 있음 |
| G7 운영 | 월 8시간 초과 또는 매일 수동 단계 필요 | 다른 후보가 모두 탈락하고 사용자가 수용할 때만 |
| G8 비용 | 월 총액이 승인 상한 초과, 또는 미확인 항목이 남아 총액을 확정 못 함 | 사용자 유료 승인 전에는 미확정을 통과로 쓰지 않음 |

- **한 기준의 강한 점수가 다른 기준의 탈락을 상쇄하지 않는다.** 점수 합산·가중 평균·정성 보정은 쓰지 않는다.
- G1~G5·G8 중 하나라도 실패하면 그 후보는 **탈락**이다. G6 실패는 "상시 후보"에서 탈락하고, Vercel은 SSE+HTTP 중간 후보로만 남긴다. G7 실패는 "추천 제외"이며, 다른 후보가 모두 탈락할 때만 사용자 판단으로 예외를 둔다.

### 5.2 추천 순서

1. **CF가 모든 게이트 통과** → CF 추천. 무료·운영 부담·TS/Workflows/DO가 한곳.
2. CF가 G1/G2/G3/G6 중 하나로 탈락하고 **VPS가 통과** → VPS 추천. 단, 월 총액·카드·운영 G7/G8 승인 필요.
3. CF·VPS가 탈락하고 **VC가 통과(또는 G6를 SSE+HTTP로 대체)** → VC를 중간 후보로 추천. 300초 연결 종료·Turso/Blob 미확인·부품 분산을 명시.
4. 모두 탈락 또는 G8 미확정 → **보류**. 플랫폼·계약·범위를 재설계하고, 유료 전제로 조용히 넘어가지 않는다.

- 동점 개념을 만들지 않는다. 위 순서는 **탈락 뒤 남은 후보의 우선순위**이며, 점수 합계가 아니다.
- 최종 결정은 `decisions/0005-web-platform.md`와 `0016-core-language.md`에 측정값·확인일·탈출 조건으로 기록한다. 이 파일은 측정표 초안이며 결정 기록을 대체하지 않는다.

## 6. 판정 요약표

| 후보 | G1 TS | G2 SQLite | G3 A 라운드 | G4 월 여유 | G5 카드 | G6 상시 통로 | G7 운영 | G8 비용 | 판정 | 탈락 사유 |
|---|---|---|---|---|---|---|---|---|---|---|
| CF | 로컬 통과(38/38) | 로컬 통과(61표·16 pass) | 로컬 3/3+10/10 | 미측정(계정·8시간·30일) | **사용자 결정 필요** | 미측정(시간 상자 밖) | 미측정(4주) | **사용자 결정 필요** | **보류** | 없음(로컬) |
| VC | 로컬 통과(38/38) | 로컬 SQLite 통과 / Turso 미측정 | 로컬 3/3+10/10 | 미측정(Active CPU 계측 아님) | **사용자 결정 필요** | 미측정(문서상 300초) | 미측정(4주) | **사용자 결정 필요** | **보류** | 없음(로컬) |
| VPS | 로컬 통과(38/38) | 로컬 통과(61표·16 pass) | 로컬 3/3+10/10 | 미측정(7일 soak) | **사용자 결정 필요** | 미측정(시간 상자 밖) | 미측정(4주) | **사용자 결정 필요** | **보류** | 없음(로컬) |

- 이 표의 "통과"는 **로컬 스파이크/대리값**이다. G4~G8은 계정·카드·비용·시간 상자 때문에 측정하지 않았으므로 **통과로 쓰지 않는다**.
- 로컬 시험에서 탈락한 후보는 없다. 그러나 이것은 최종 판정이 아니다. **최종 플랫폼은 계정·카드·비용 사용자 결정 뒤에 정한다.** 유료 후보를 1순위로 올리지 않는다.

## 7. 기록 시 금지

- 실제 프로젝트 내용·기관 자료·실키·토큰·세션 ID·계정 ID·사용자 절대경로를 적지 않는다.
- 실제 Go 호출은 사용자 비용 승인 범위 밖에서 하지 않는다. `cost=0`만으로 구독이라고 쓰지 않는다.
- 미확인 한도를 0이나 무제한으로 채우지 않는다. "미확인"과 "실측 완료"를 구분한다.
- 유료 후보를 사용자 승인 없이 추천 1순위로 올리지 않는다.
