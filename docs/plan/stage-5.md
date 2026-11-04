# 5단계 웹으로 옮기기 — 계획서

- 작성: 2026-11-05, OpenCode(`opencode-go/deepseek-v4.1-flash`)
- Linear: SEL-28 ("웹으로 옮기기")
- 입력: [00-brief.md](00-brief.md), 확정 [stage-0.md](stage-0.md), 합의 [stage-1-db.md](stage-1-db.md)·[stage-1-api.md](stage-1-api.md)·[stage-1-ui.md](stage-1-ui.md)·[stage-1-runners.md](stage-1-runners.md), [DDL 초안](schemas/stage-1-ddl-draft.sql), [webmcp.md](research/webmcp.md)
- 상태: **Codex·Opus 검수와 Codex 최종 검수 반영 — 사용자 승인 대기** (2026-11-05)
- 전제: stage-0 7절과 1단계 설계서의 합의 결정은 다시 정하지 않는다. 이 문서는 그 결정 위에서 **웹에서 어디에 두고 어떻게 운영할지**만 정한다. 2026-11-05 사용자 결정에 따라 **Cloudflare 무료 요금제(Workers Free·D1 Free·R2 무료 구간)** 를 전제로 설계하고, 유료 전환은 9절에만 둔다. 승인되면 4절의 WEB0~WEB14를 Linear 이슈로 만든다.

## 1. 목표

PES를 **공개 HTTPS 웹**으로 옮긴다. 사람은 어느 기기에서든 로그인해 답·승인·첨언을 하고, 에이전트는 지금과 같은 PES API로 작업한다. 웹은 실행기가 아니라 **원본과 조정자**다. 방식 A의 실제 실행은 사용자의 컴퓨터에서, 방식 B는 Claude 앱·Claude Code에서 일어난다.

이 단계가 끝나면 다음이 참이어야 한다.

- **프로젝트별 원본 위치를 로컬 SQLite 또는 웹 D1 중에서 고를 수 있다.** 둘 다 지원한다. 웹으로 옮긴 프로젝트는 D1이 쓰기 원본, R2가 파일 원본이고, 그 프로젝트의 로컬 SQLite만 읽기 전용 스냅샷이 된다. 옮기지 않은 프로젝트는 지금처럼 로컬 CLI·로컬 서버로 계속 쓴다. CI는 두 모드를 모두 시험한다.
- 사람은 이메일 매직링크·패스키로 로그인하고, owner/editor/reader 역할과 프로젝트 초대가 동작한다. 승인·reopen·정책·토큰·삭제는 **소유자 사람이 브라우저에서 그 요청에 한정해 확인**해야 한다.
- 방식 A는 웹에서 시작한 run을 **로컬 runner**가 밖으로 연결해 가져가 실행한다. 웹이 로컬로 접속하지 않는다.
- 방식 B는 Claude Code·Claude 앱·Codex CLI·OpenCode TUI 네 가지다. Claude 앱은 원격 커넥터(원격 MCP), Claude Code·Codex CLI·OpenCode TUI는 HTTP MCP/기존 bridge로 같은 API에 붙는다. 붙여넣기 전달은 계속 남는다.
- 질문·승인·실패·백업 이상이 메일과 휴대폰 푸시로 오고, 알림에는 연구 내용이 실리지 않는다.
- 야간 백업과 월 1회 복구 훈련이 돌고, **Workers/D1/Queues/Workflows는 Free 하드 캡 안**, **R2는 무료 포함량 목표와 초과 과금 위험 차단**이 동작한다(도메인 비용은 별도). R2는 플랫폼이 $0을 강제하지 않으므로 실제 비용 노출 전에 사용자 확인을 받는다.

**하지 않는 것**: 6단계의 여러 에이전트·여러 사람 조직 기능, 외부(Linear·Notion) 내보내기, **4단계 기능은 새로 만들지 않음(웹 동등성·성능은 WEB14에서 확인)**, 3단계의 새 작업 공간 디자인. 웹 이전은 **같은 화면·같은 명령을 공개 HTTPS에서 안전하게 쓰는 일**이지 새 제품을 만드는 일이 아니다.

**원칙**: stage-0의 원칙 0(에이전트는 상태를 직접 쓰지 않는다)과 stage-1-db 2절의 결정(한 프로젝트의 쓰기 원본은 하나, 실행 중 DB 동기화 금지)을 그대로 지킨다. 웹 전환은 이 원칙의 예외가 아니다.

## 2. 주제와 결정

| # | 주제 | 결정 | 이슈 |
|---|---|---|---|
| 0 | 코어 언어 | 2단계 코어는 Python, Workers는 JS/TS가 기본이다. 같은 계약을 어느 쪽에서 실행할지는 **번호만 5단계인 WEB0**으로 정하되, **실행은 2단계 PR4·13의 계약 픽스처 직후**로 앞당긴다 | WEB0 |
| 1 | 플랫폼 | stage-1-db 4절의 **SQLite/D1/R2를 승계**하고 Cloudflare **무료 요금제**에 배포. Vercel은 탈출 대안 | WEB0·WEB1 |
| 2 | 로그인·권한 | 자체 로그인(D1 세션, 매직링크+패스키), owner/editor/reader, 승인은 owner만, 중요 동작은 브라우저 step-up(초기 5분) | WEB2·WEB3 |
| 3 | 에이전트 키 | 프로젝트 범위 30일 토큰, **API 6절** 동작 전체 대응 scope·해시·1회 표시·회수·교체, 발급·회수는 owner 사람만 | WEB4 |
| 4 | 방식 A 위치 | **로컬 runner가 밖으로 연결**해 claim. 웹은 queued run만 만든다. 상시 VPS는 필요할 때 선택 | WEB6·WEB7 |
| 5 | 방식 B 원격 | 원격 MCP + OAuth를 **추가**한다. 붙여넣기 전달은 유지. MCP로 사람 답 제출·승인 불가 | WEB5 |
| 6 | 알림 | 메일(Resend) 기본 + Web Push 보조. SMS 없음. 본문 최소·딥링크 | WEB8 |
| 7 | 로컬→웹 | 프로젝트 단위 **한 방향 절단 이전**. 이중 쓰기·양방향 동기화 없음. 미이전 프로젝트는 로컬 유지 | WEB9 |
| 8 | 운영·백업 | staging/prod 분리, Time Travel 7일(Free) + 야간 암호화 export, RPO 24h·RTO 4h | WEB10 |
| 9 | 비용 | **무료 요금제 기준**(도메인 별도). Workers/D1/Queues/Workflows는 Free 하드 캡 $0, **R2는 무료 포함량 목표·초과 과금 위험 차단**. 무료 한도 계측·경보, A 누적 상한은 2단계 결정 승계. 유료 전환은 9절 | WEB12 |
| 10 | WebMCP | **선결론 없이 재조사로 결정**. 결정 전에는 기본 비활성·capabilities 미지원 | WEB13 |
| 11 | 보안 | **Free에서 가능한 플랫폼 방어 + 앱 수준 방어**. 쿠키·CSRF·CSP·rate limit·파일 격리 | WEB11 |

### 2.1 플랫폼·코어 언어·자료 위치

- **정할 것**: 무료 계정의 배포 구성, 코어 명령 서비스를 웹에서 실행할 언어, 연구 자료를 어느 관할에 둘지.
- **승계**: stage-1-db 4절의 "SQLite와 D1이 같은 마이그레이션 한 벌", 파일 원본 R2(`stage-1-db.md:121-124`). D1이 DDL을 "그대로 받는다"는 것은 아직 **운영 검증 전**이다(`stage-1-db.md:170`). Vercel+Postgres를 동등한 재선택지로 올려 DB 합의를 다시 열지 않는다.
- **플랫폼**: **Cloudflare Workers·D1·R2를 무료 요금제로** 승계한다. Vercel은 **탈출 대안**이며, 같은 요구·포함량을 놓고 비교한다. 선택지 ① Cloudflare(승계) ② Vercel + Turso(SQLite, 별도 검증) ③ Cloudflare + 외부 DB.
- **코어 언어**: 2단계 코어는 Python이고 Workers는 JS/TS가 기본이므로 다음 중 하나를 골라야 한다. (a) Python Workers에서 같은 코드 실행, (b) TS로 옮기고 **같은 JSON 계약 시험(골든 파일)을 두 구현에** 돌림, (c) 웹도 Python 서버(Workers 아님). **WEB0은 번호만 5단계에 두고, 실행 시점은 2단계 PR4·13의 언어 중립 계약 픽스처가 나온 직후**로 옮긴다(약 1 PR). 결과는 `docs/plan/decisions/`에 기록하고, **결과가 TS 이식이면 그때 2~4단계 구현 언어를 다시 정한다**. 2단계 PR4·13의 계약 시험도 언어 중립 JSON 픽스처를 쓰도록 2단계 계획서에 알린다. WEB1은 WEB0 결과를 입력으로 받는다. **Python Workers의 Free 포함 여부는 공식 페이지에 요금제 명시가 없어 미확인**이므로 WEB0에서 무료 계정으로 먼저 확인한다.
- **자료 위치·관할**: D1 위치 힌트(아시아 태평양)와 R2 관할 설정을 정한다. **D1/R2에 실제 연구 자료가 올라가는 것은 stage-0 7-1의 Go 전송 허용과 다른 동의다.** 기관 자료 반출 규정 확인을 6절 사용자 결정으로 올리고, 프로젝트별로 "웹으로 옮기지 않음"을 고를 수 있게 한다(1절·2.7). **R2 무료 구간도 대시보드에서 버킷을 켤 때 결제 수단 등록을 요구할 수 있는지는 미확인**이다. WEB1 전에 확인하고, 필요하면 "요금 $0이어도 결제 수단 등록"을 6절 5번의 조건부 확인 항목으로 올린다.

| 기준 | Cloudflare(승계, 무료) | Vercel(탈출 대안) |
|---|---|---|
| DB | D1(SQLite), 같은 DDL | Turso(SQLite), 별도 검증. Neon(Postgres)은 DDL 재작성 |
| 파일 | R2, egress $0 | Blob, egress 과금 |
| 장기 실행 | Workers 일반 실행에는 없음 → 로컬 runner | Functions에 없음. Sandbox·Daemons는 별도 상품·비용 → 로컬 runner |
| 운영 | cron·Queues·Workflows | cron·Functions |
| 비용 | **Workers/D1 Free 하드 캡 $0**, R2 무료 포함량 목표·초과 과금(도메인 별도) | 무료/유료 플랜 혼합 |
| 강점 | D1·R2·비용 예측 | Next.js DX·미리보기 |

#### 2.1.1 무료 한도 (2026-11-05 직접 확인)

| 항목 | Free 한도 | 출처 |
|---|---|---|
| Workers 요청 | **100,000/일**(UTC 자정 리셋, 초과 시 Error 1027) | `https://developers.cloudflare.com/workers/platform/limits/` |
| Workers CPU | **10 ms/호출**(HTTP·Cron 모두). 메모리 128 MB, subrequest 50/요청, 동시 연결 6 | `https://developers.cloudflare.com/workers/platform/limits/` |
| Workers 정적 자산 | 파일 20,000/버전, 개별 25 MiB. 가격 문서는 정적 자산 요청을 "free and unlimited"로 표기 | `https://developers.cloudflare.com/workers/platform/limits/`, `https://developers.cloudflare.com/workers/platform/pricing/` |
| Cron | **5개/계정**, CPU 10 ms. **호출당 wall time 15분은 미확인**(cron-triggers 페이지에 Free 수치 없음) | `https://developers.cloudflare.com/workers/platform/limits/`, `https://developers.cloudflare.com/workers/configuration/cron-triggers/` |
| D1 DB 크기·개수 | **DB당 500 MB**, **10개/계정**, 계정 저장 **5 GB** | `https://developers.cloudflare.com/d1/platform/limits/` |
| D1 읽기/쓰기 | **읽기 500만 행/일**, **쓰기 10만 행/일** | `https://developers.cloudflare.com/d1/platform/limits/`, `https://developers.cloudflare.com/d1/platform/pricing/` |
| D1 기타 | Time Travel **7일**, 호출당 쿼리 50, 행/문자열/BLOB 2 MB, SQL 100 KB, 바인딩 100, 쿼리 30초, 결과 50 MB. **import 5 GB는 미확인**(WEB9에서 확인) | `https://developers.cloudflare.com/d1/platform/limits/` |
| R2 저장 | **10 GB-month/월**(Standard만, Infrequent Access 제외) | `https://developers.cloudflare.com/r2/pricing/` |
| R2 작업 | **Class A 100만/월**, **Class B 1,000만/월**, egress 무료 | `https://developers.cloudflare.com/r2/pricing/` |
| R2 객체 | 객체 5 TiB, 단일 업로드 5 GiB, 버킷 기본 100,000개 | `https://developers.cloudflare.com/r2/platform/limits/` |
| Queues | **10,000 operations/일**, 보존 **24시간 고정**, 큐 10,000개 | `https://developers.cloudflare.com/workers/platform/pricing/` |
| Workflows | 요청 100,000/일(Workers와 공유), CPU 10 ms/호출, 저장 1 GB-month, **step 3,000/일** | `https://developers.cloudflare.com/workers/platform/pricing/` |
| Workers KV (OAuth) | **읽기 100,000/일, 쓰기 1,000/일, 저장 1 GB**(Free, WEB5에서 재확인) | `https://developers.cloudflare.com/kv/platform/limits/` |
| Durable Objects (선택) | **요청·벽시계 실행량·저장을 별도 계측**. Free 포함량·과금은 WEB1 선택 전 확인 | `https://developers.cloudflare.com/durable-objects/platform/pricing/` |
| Resend(Cloudflare 아님) | 3,000통/월, **100통/일** | `https://resend.com/pricing` (2026-11-05 확인) |

**R2는 Workers/D1과 다르게 무료 포함량 초과분이 종량 과금된다.** 저장 10 GB-month·Class A/B 작업을 넘으면 과금되며, 80% 경보·90% 완화만으로 $0을 보장하지 않는다. WEB12에서 업로드·백업·다운로드별 사용량 예약·제한과 초과 위험 시 차단/운영 중지 절차를 둔다. R2 활성화에 결제 수단이 필요한지는 WEB1에서 확인하고, 필요하면 6절 5번의 조건부 확인 항목으로 올린다.

**미확인**: Python Workers의 Free 포함 여부(공식 Python 페이지에 요금제 표기 없음), 정적 자산 요청이 100k/일 집계에 포함되는지(가격 문서는 무료·무제한만 표기), D1 export가 rows read로 계측되는지, Free 플랜의 WAF·rate limiting 세부 제공 범위, **KV/DO의 Free 포함량·과금**. 모두 WEB0·WEB1·WEB5·WEB10·WEB11에서 무료 계정으로 실측한다.

#### 2.1.2 PES가 무료 한도 안에서 도는가 (추정)

가정: **사용자 1명·프로젝트 3개(활성 1개)·하루 페이지 100회·API 1,000회·run 1회·에이전트 2개·활성 8시간**. 실측 전 설계 목표다.

| 자원 | 하루 추정 | Free 한도 대비 | 판단 |
|---|---|---|---|
| Workers 요청 | 페이지 100 + API 1,000 + runner 25초 폴 1,152 + 브라우저 15초 폴 1,920 + 알림·기타 200 ≈ **4,400** | 100,000의 **4.4%** | 여유. 단 **3초 폴링은 8시간에 9,600/탭, 24시간에 28,800/탭**이라 3~4탭이면 100k에 근접 |
| CPU | 설계 추정: 평균 2~3 ms, 인증·SSR 10–20 ms (**출처 미확인**) | **요청당 10 ms** | **가장 위험**. SSR·패스키·세션 검증이 10 ms를 넘으면 그 요청은 실패 |
| D1 읽기 | 페이지 100회 × 100행 + 폴 3,000회 × 1행 ≈ **13,000행** | 5,000,000의 **0.3%** | 여유. 인덱스 없는 전체 스캔 1회가 10만 행이면 100회로 1,000만 행 → 초과 |
| D1 쓰기 | run 1회의 event·lease·답·영수증 ≈ **1,000행** | 100,000의 **1%** | 여유. event 로그 누적은 쓰기보다 저장·읽기 문제 |
| D1 저장 | 텍스트 3프로젝트 **300 MB 목표**, 500 MB는 **상한 시나리오** | 5 GB의 **6~10%**, DB당 500 MB의 **60~100%** | 상한 시나리오는 **경계**. **350 MB는 안전 정지·유료 전환 검토 신호**, 500 MB는 하드 캡. 프로젝트별 DB 분리는 5단계 완료 조건이 아니라 후속 검토 |
| R2 저장 | 파일 5 GB + 백업 2 GB = **7 GB** | 10 GB의 **70%** | 여유가 작다. 큰 파일·백업 보존이 늘면 **무료 포함량 초과 과금** 위험이 있으므로 WEB12에서 예약·차단한다 |
| R2 작업 | 쓰기 30/일, 읽기 1,000/일, 목록 30/일 | Class A 1M/월·Class B 10M/월의 **1% 미만** | 여유. 멀티파트 대용량 업로드는 Class A를 늘림 |
| Queues | 알림 100건 × 3 ops = **300/일** | 10,000의 **3%** | 여유. 보존 24시간이라 그 안에 재시도해야 함 |
| Workflows | import 1회 100 step | 3,000의 **3%** | 여유. 큰 프로젝트를 100행 청크로 나누면 step이 급증 |
| KV (OAuth) | 메타데이터·jti 보조 읽기/쓰기 소량 | 읽기 10만/일·쓰기 1,000/일 | WEB5에서 실측. 쓰기 폭주 없게 캐시 |
| DO (선택) | long poll 선택 시 요청·벽시계 실행량 | Free 포함량 미확인 | WEB1 선택 전 비용·한도 확인, WEB12 계측 |
| Cron | 백업·알림·정리 3개 | 5개 | 여유 |

**넘을 위험이 큰 곳과 줄이는 방법**

1. **요청당 CPU 10 ms(최대 위험)**: 서버 렌더·Better Auth·패스키 검증이 10–20 ms에 든다는 것은 **출처 미확인 추정**이다. → 읽기 화면은 정적 자산·캐시된 조각으로 내리고, 세션은 HMAC 쿠키 + D1 1행 조회로 경량화하고, ORM·큰 JSON 파싱을 피한다. 로그인·승인처럼 무거운 경로는 별도 엔드포인트로 쪼개고 p95 CPU를 계측한다. 그래도 상시 초과면 9절의 유료 신호다.
2. **요청 수 100k/일**: 커서 폴링을 **3초 기본값으로 쓰지 않는다.** 25–30초 long poll/SSE, 탭 숨김 시 중지, 지수 백오프, ETag·304, 묶음 API를 쓴다. 3초는 활성 run을 보는 짧은 구간에만 허용한다. 이는 **1단계 UI 결정 14(활성 약 3초 커서 폴링)의 웹 조정이며 로컬 모드는 그대로**다. U1의 커서 갱신 계약은 같은 의미를 유지하고, 간격만 웹 요청 예산에 맞춘다. **긴 대기의 구현 방식(DO·짧은 폴+ETag·SSE)은 미확인**이며 WEB1에서 정한다.
3. **D1 읽기 500만 행/일**: event·run·답에 인덱스를 두고 `SELECT *`·전체 스캔을 금지한다. keyset 페이지, 요약 표, 오래된 event의 R2 아카이브로 스캔량을 줄인다.
4. **D1 500 MB/DB·5 GB/계정**: event·revision·첨부 텍스트가 증가한다. 보존 기간·아카이브·압축을 두고, **350 MB에 가까우면 쓰기 완화·아카이브·유료 전환을 검토**하며 500 MB는 넘지 않게 한다. 프로젝트별 DB 분리는 후속 검토이며, 아카이브로도 5 GB를 넘으면 유료 전환을 검토한다.
5. **R2 10 GB**: 객체와 백업이 같은 무료량을 나눠 쓴다. 중복 산출물·임시 파일을 남기지 않고, 수명주기로 staging·오래된 백업을 정리하며, **42개 백업 × 압축 크기 + 객체 ≤ 8 GB**를 유지한다. 넘으면 WEB12의 R2 예약·차단/운영 중지 절차를 적용하고, 실제 비용 노출 전에 사용자 확인을 받는다.
6. **R2 Class A 100만/월**: 멀티파트 업로드·잦은 목록 호출이 늘린다. 5 GiB 미만은 단일 업로드, manifest는 묶어서, 불필요한 `ListObjects`를 줄인다.
7. **Cron 5개·Queues 10k/일·Workflows 3k step/일**: 야간 백업과 대량 import의 **실제 자료** 경로는 공개 CI가 아니라 허용된 로컬·비공개 실행 주체가 맡는다. 공개 CI는 합성 검증만 한다. Cron은 알림·정리 dispatcher 하나로 묶는다. 대량 import는 Workflows step을 쪼개지 말고 **합성 검증은** CI의 `wrangler d1 execute`/batch, **실제 프로젝트는 허용된 로컬·비공개 실행 주체**의 같은 batch로 처리한다. 청크 한도를 넘었다는 이유로 실제 연구 자료를 CI로 우회하지 않는다.
8. **정적 자산 20,000개**: 앱 자산은 수백 개 수준이라 여유. 빌드 산출물을 Worker 번들에 넣지 말고 Assets로 보낸다.

- **결정 기록**: `docs/plan/decisions/0005-web-platform.md`에 후보·기준·탈출 조건을 남긴다. 탈출 조건은 "무료 한도 상시 초과(9절), D1 DB 350 MB 안전 신호 또는 500 MB 도달, Cloudflare가 SQLite 호환을 깨는 변경"이다. 플랫폼은 1단계 합의 승계이므로 다시 선택받지 않고, 6절 1번은 자료 위치·관할만 확인한다.

### 2.2 로그인·권한 (사람)

- **정할 것**: 사람 인증 수단, 세션 수명, 역할 경계, 초대·해제, 계정 복구, 중요 동작 재인증.
- **선택지**: ① Cloudflare Access(이메일 OTP·Google) ② 자체 로그인(Better Auth on D1, 매직링크+패스키) ③ Clerk/Auth0 SaaS.
- **판단 기준**: 사용자는 소유자 1명 + 소수 편집자, 역할이 이미 DB(`project_members`, `stage-1-ddl-draft.sql:57-64`)에 있음, 브라우저·API·MCP가 같은 사용자 정체성을 써야 함, 계정 복구 가능성, 월 비용, 공개 HTTPS 공격면.
- **추천**: **② 자체 로그인**. Better Auth를 D1에 붙이고, 이메일 매직링크를 기본으로 하되 첫 로그인 뒤 **패스키 등록을 권장**한다. PES의 `users`가 정본이고, 인증 라이브러리의 사용자 표는 PES `users`에 매핑해 세션·계정·패스키를 맡긴다(`users.auth_subject`에 `provider:subject`를 저장, `stage-1-ddl-draft.sql:12-18`). **채택 버전을 고정하고 D1 어댑터·추가 인증 표·사용자 매핑을 실제로 검증**한다. 세션 표만 떼어 검토하는 것으로 축소하지 않는다. Clerk/Auth0는 월 비용과 개인정보 위탁이 늘고 소수 사용자에게 과하다.
- **Access의 역할**: 기본 경로가 아니다. **`/ops` 관리자 경로의 선택적 바깥 문**으로만 쓴다. Access를 인증에, PES `project_members`를 인가에 쓰는 조합은 가능하지만, "권한 원본이 반드시 둘"이라고 단정하지 않는다. 켜지 않아도 PES 로그인이 모든 권한을 검사한다.
- **역할**: `owner`는 `stage.approve`·`stage.reopen`·`edition.start`·`edition.complete`·`edition.reopen_completion`·Go 정책·토큰·멤버·삭제·데이터 내보내기. `editor`는 답·의견·첨언·초안·질문 추가까지. `reader`는 읽기만. **editor의 승인은 허용하지 않는다** — `stage-1-api.md:42`가 5단계로 미룬 결정이며, 연구 책임의 단일성을 위해 owner만 승인한다. 6단계에서 `approver`를 추가해도 `stage.approve`·`stage.reopen`만이고, `edition.complete`·`edition.reopen_completion`은 owner만 한다.
- **화면**: 로그인·초대 수락·멤버·보안(세션·패스키·복구 코드)·토큰·연결된 앱·알림 설정을 설정 영역에 둔다. 프로젝트 작업 화면은 3단계 U1을 그대로 쓰고, 5단계는 설정과 로그인 화면만 새로 만든다.
- **세션**: 쿠키 이름 `__Host-pes_session`, `HttpOnly; Secure; SameSite=Lax; Path=/`. 절대 14일·유휴 7일, 로그인·권한 변경 시 회전. 기기 목록과 "모든 기기 로그아웃" 제공. 기기·세션 표는 **새 마이그레이션(담당 WEB2)** 이다.
- **재인증(step-up)**: `stage.approve`·`stage.reopen`·`edition.start`·`edition.complete`·`edition.reopen_completion`·정책 변경·토큰 발급/회수·삭제·데이터 내보내기는 최근 재인증을 요구한다. **step-up은 브라우저에서 프로젝트·동작·snapshot/rev를 보여 주고, 그 요청에 한정해 확정**한다. 기기 토큰이나 step-up 토큰을 에이전트가 받아 승인 명령을 대행할 수 없다. 5분은 **운영 초기값**이며 7절에서 재검토한다. 이는 "사람만"(`stage-1-api.md:25`)을 강화하는 것이지 바꾸는 것이 아니다.
- **복구 자격**: 로그인·step-up·복구를 한 표로 정한다.

| 상황 | 허용 자격 | 요구·회수 |
|---|---|---|
| 평상시 로그인 | 매직링크 또는 패스키 | 세션 14일/유휴 7일, 로그인 시 회전 |
| 중요 동작 step-up | 패스키 우선, 매직링크 허용 | 브라우저에서 snapshot/rev 확인, 그 요청에만 5분 |
| 패스키 분실 | 매직링크 + 복구 코드 | 기존 세션·기기 토큰 회수 |
| 기기 분실 | 다른 기기에서 세션·기기 회수 | 해당 기기 토큰 즉시 폐기 |
| 메일 변경 | 현재 세션 + step-up + 복구 코드 | 이전 주소에 알림, OAuth 연결 재검토 |
| 복구 코드 분실·소유자 복구 | Cloudflare 계정 2단계 인증 + DB 접근의 수동 비상 절차 | 정상 업무 명령 아님, 감사 밖 비상 절차로 분리하고 사후 기록 |

- **초대**: 이메일 1회용 7일, 역할 지정, 철회 가능. 복구 코드 10개를 가입 때 발급해 오프라인 보관을 안내한다.
- **CLI·로컬 도구**: `pes login`은 브라우저 **기기 승인(device flow)** 으로 30일 기기 토큰을 받아 OS 키체인에 저장한다. 서버는 기기 토큰도 해시로 보관한다. 이 토큰은 **사람 자격**이며 기기 목록에서 회수한다. 승인·reopen 같은 중요 동작은 CLI에서 직접 하지 않고 브라우저 재인증 링크를 열어 끝낸다. 에이전트 키와 섞지 않는다.

### 2.3 에이전트 접속 키 발급·회수 운영

- **정할 것**: 누가 발급하는가, 키 형식, 범위, 만료, 회수·교체, 보관 위치, 감사, 다중 프로젝트 runner 처리.
- **선택지**: ① 프로젝트 범위 토큰만 ② 기기(machine) 범위 토큰 ③ OAuth client credentials.
- **판단 기준**: 최소 권한, 회수 즉시성, runner가 여러 프로젝트를 맡을 때의 편의, 유출 시 피해 범위, 감사 가능성.
- **추천**: **① 프로젝트 범위 토큰만**. stage-1-db 13의 결정을 그대로 운영으로 옮긴다(`stage-1-db.md:30`). 형식은 `pes_<prefix>_<32바이트 base64url>`, 원문은 발급 응답에서 **한 번만** 보여 주고 DB에는 `HMAC-SHA256(pepper, token)`만 저장한다(`agent_tokens.token_hash`, `stage-1-ddl-draft.sql:66-77`).
- **scope ↔ 명령 ↔ MCP 도구**: API 6절의 E 허용 동작과 3·4단계가 추가한 에이전트 명령을 아래 표로 맞춘다. **이 표가 단일 명세다. 등록 원고의 축약 목록은 대체 목록이 아니며, 구현은 이 표를 기준으로 한다. 새 기능을 단순 누락으로 미지원 처리하지 않는다.** `—`는 MCP 미노출(HTTP/CLI만)이다. 승인·reopen·정책·토큰·삭제·멤버·외부 export scope는 **존재하지 않게** 한다. 각 scope는 실제 actor·run에 귀속되고, 발급 시 고른 scope 밖의 명령은 403이다.

| API 6절 E 동작·3·4단계 명령 | scope | MCP 도구 |
|---|---|---|
| capability·프로젝트 목록 | `context:read` | `pes_capabilities`·`pes_projects` |
| 맥락·버전 읽기 | `context:read`·`version:read` | `pes_context`·`pes_version` |
| 입력 조회(long-poll) | `inputs:read` | `pes_inputs` |
| 변경분 | `changes:read` | `pes_changes` |
| claim | `run:claim` | `pes_claim` |
| heartbeat | `run:heartbeat` | `pes_heartbeat` |
| wait | `run:wait` | `pes_wait` |
| complete | `run:complete` | `pes_complete` |
| 중단·취소 | `run:cancel` | `pes_cancel` |
| 반납 | `run:release` | `pes_release` |
| 인계 | `run:handoff` | `pes_handoff` |
| 결과 제출 | `result:submit` | `pes_submit` |
| 질문 게시·수정 | `question:ask`·`question:revise` | `pes_ask`·`pes_question_revise` |
| 자기 질문 답 | `answer:self` | `pes_self_answer` |
| 첨언·답글 | `thread:write` | `pes_thread`·`pes_reply` |
| 후속 제안 | `followup:propose` | `pes_followup` |
| 첨언 해결·후속 적용 | `thread:resolve`·`followup:apply` | `pes_thread_resolve`·`pes_followup_apply`(reopen 적용은 H만) |
| 가정·결정·반영 제안 | `assumption:propose`·`decision:propose`·`reflection:write` | `pes_assumption`·`pes_decision`·`pes_reflection` |
| 반대 의견 | `objection:raise` | `pes_objection` |
| 편집 제안 | `edit:propose` | `pes_edit_proposal` |
| 파일 | `file:upload`·`file:read` | `pes_upload`·`pes_file` |
| 입력 영수증 | `input:receipt` | `pes_receipt` |
| 라운드 시작·봉인 | `round:write` | `pes_round_start`·`pes_round_seal` |

- **pepper**: `token_hash`에 pepper 버전을 함께 저장하고, 회전 시 새 버전으로 재해시하거나 제한된 이중 허용 창을 둔다. 회전 중에도 회수는 즉시다.
- **수명·교체**: 30일 만료, 회수 즉시 다음 요청부터 401. **교체는 새 키 발급 + 24시간 겹침 + 옛 키 자동 회수**이고, **긴급 회수는 겹침 없이 즉시 전부 폐기**다. 둘을 같은 동작으로 취급하지 않는다. 마지막 사용 시각·마지막 사용 IP·발급자·범위를 UI에 보여 준다. `agent_tokens`에 `label`, `token_prefix`, `last_used_at`, `last_used_ip`, `created_by_user_id`를 **nullable ADD COLUMN**으로 보강한다(파괴적 변경 없음, 새 마이그레이션 담당 WEB4).
- **보관**: runner는 프로젝트별 키를 OS 키체인(Windows Credential Manager, macOS Keychain)에 저장하고 `~/.pes/credentials` 평문 저장을 금지한다. 키는 프롬프트·로그·URL·에러 메시지에 넣지 않는다. MCP 도구가 모델 대신 헤더에 주입한다(`stage-1-api.md:49`).
- **회수 시 진행 중 run**: 새 claim·submit은 즉시 거부하고, 살아 있는 lease는 TTL 만료 뒤 `interrupted`로 표시한다. TTL 뒤의 상태 변경도 검증된 명령·사건으로 수행한다. 이미 커밋된 결과는 지우지 않는다.
- **다중 프로젝트**: 기기 단위 토큰을 새로 만들지 않는다. runner 설정에 프로젝트별 토큰을 여러 개 두고, 각 토큰은 자기 프로젝트만 claim한다. 기기 목록은 표시·회수 편의를 위한 `runner_devices` 보조 표(새 마이그레이션 담당 WEB6)로 관리하되 권한은 토큰이 결정한다.
- **발급·회수는 owner 사람만**. 에이전트·WebMCP·MCP는 토큰을 만들거나 볼 수 없다. 발급·회수·첫 사용은 `events`에 남긴다.

### 2.4 방식 A가 웹에서 도는 위치

- **용어**: runner = 사용자 컴퓨터의 로컬 실행기. 1단계 runners의 "원격 runner"는 웹에서 본 같은 것이다.
- **정할 것**: opencode 프로세스와 PES supervisor가 어디서 도는가, 웹과 로컬이 어느 방향으로 연결되는가, 절전·오프라인·다중 기기를 어떻게 다루는가.
- **선택지**: ① Cloudflare Workers/Containers 안에서 opencode 실행 ② **로컬 runner가 밖으로 연결** ③ 상시 VPS runner ④ Cloudflare Tunnel로 로컬 opencode를 공개.
- **판단 기준**: 인바운드 포트 없음, 노트북 절전·재접속, 연구 자료가 있는 위치, 비용, 같은 API 재사용, 장애 복구, stage-1-runners A3(전용 프로필·프로젝트당 하나) 유지.
- **추천**: **② 로컬 runner 기본, ③ 상시 VPS는 선택**. Workers는 장기 프로세스·로컬 파일·PTY를 제공하지 않고, Containers를 쓰면 연구 자료가 Cloudflare로 가고 상시 비용·이미지 관리가 붙는다. Cloudflare Tunnel(④)은 로컬 opencode를 공개 인터넷에 노출해 공격면과 절전 실패가 커진다.
- **연결 방향**: **runner → 웹, HTTPS 443 아웃바운드만**. runner가 권한 있는 **순수 조회**로 일을 찾고(최대 25초 대기 가능, `GET inputs` 계열), `heartbeat`로 살아 있음을 알린다. 웹은 runner로 접속하지 않는다. runner는 같은 컴퓨터의 전용 opencode 서버에 **loopback으로만** 접속하고 그 서버를 외부에 열지 않는다. **25초 long poll의 구현 방식은 미확인**: Durable Objects 없이 D1을 반복 조회하면 Free의 호출당 쿼리 50·subrequest 50에 걸리고 행 읽기가 늘 수 있다. WEB1에서 **DO로 대기 / 짧은 폴 + ETag / SSE** 중 무엇을 쓸지 정하고 한도를 계측한다. **DO를 고르면 요청 수뿐 아니라 벽시계 실행량·저장도 WEB12에서 계측한다.**
- **일 찾기와 claim 분리**: **일 찾기 = 순수 조회**(대기 가능, 트랜잭션을 잡지 않음), **claim = 원자 쓰기**(대기 없음, `POST /claims`의 run 전이 + lease 획득). claim은 멱등 키·전제 조건(rev/fence)·동시 claim 거부를 유지한다. 25초는 claim의 대기 계약이 아니라 입력 조회의 상한이다(`stage-1-api.md:18, 21, 38`).
- **실행 흐름**: 사람이 웹에서 run을 만들면 `queued`가 된다. runner가 claim하면 그때 opencode 전용 프로필을 띄우고, 첫 모델 호출 전에 run·claim·현재 Go 정책·예산을 확인한다(A2). 결과·질문은 같은 API로 제출하고, `wait`로 `waiting_human` + lease 해제한다. 웹 화면은 "이 컴퓨터의 runner가 맡음 · 마지막 확인 12초 전"을 보여 준다.
- **오프라인**: runner가 없으면 run은 `queued`로 남고 "미접속·상태 미상"을 표시한다. **"확인 없음"은 "꺼짐 확정"이 아니다.** 자동으로 다른 기기로 넘기지 않는다. 다른 기기로 옮기려면 사람이 **인계**를 누르고 새 run을 만든다(`stage-1-runners.md:51`).
- **Go 정책 경계**: 웹은 runner의 실제 outbound를 볼 수 없다. **실제 반출 요청마다 서버에 허가를 받는다**: runner가 `prepared`를 올리고 서버가 현재 정책·버전·자료 범위를 검사해 `authorized`를 주면 그때 보낸다. 서버 확인 실패·단절이면 **차단**하고, 자식 run·요약·첨부·재시도도 각각 같은 검사를 받는다. `outbound_dispatches`에 prepared/authorized/sent/unknown을 남긴다. 이는 **사용자 기기를 신뢰하는 모델**이며 변조된 runner까지 막지는 못한다는 한계를 별도 표시한다. 서명된 runner 업데이트는 정책 최신성을 보장하지 않는다. 이미 나간 자료는 회수 보장이 없고, OFF 뒤 결과 채택을 거부해 피해를 줄인다(`stage-1-db.md:212`, `stage-1-runners.md:30`).
- **기록·경계**: **업무 API가 공급자 DTO에 의존하지 않는다**(`stage-1-api.md:16`). 웹이 모든 세션 참조를 모른다는 뜻은 아니다. run·session 계보와 외부 중단 상태는 보존한다. `actors.kind=system`은 인증된 내부 제어 경로에서만 확정하고, **원격 runner가 임의로 system actor를 주장할 수 없다**(`stage-1-runners.md:70`).

### 2.5 방식 B의 원격 접속

- **정할 것**: Claude 앱·Claude Code·Codex CLI·OpenCode TUI가 공개 HTTPS의 PES에 붙는 경로, 인증 방식, 도구 표면, 장기 대기 처리, 기존 bridge·붙여넣기 전달과의 관계.
- **선택지**: ① 원격 MCP(Claude 커스텀 커넥터) ② 붙여넣기 묶음만 ③ 둘 다.
- **판단 기준**: Claude 앱 지원 범위, OAuth 필요 여부, 도구 호출 시간 제한, 승인 권한 분리, 오프라인·재접속, 사용자 설정 부담.
- **추천**: **③ 둘 다**. 원격 MCP를 추가하되 기존 bridge·붙여넣기 전달을 없애지 않는다. `stage-1-runners.md:39`의 B2가 5단계로 넘긴 "원격 커넥터"를 여기서 실행하고, Claude Code·Codex CLI·OpenCode TUI의 기존 로컬 어댑터도 같은 명령·인증·오류 계약으로 원격 경로에 참여시킨다.
- **경로·도구**: Worker에 `/mcp`(Streamable HTTP)를 둔다. 노출 도구는 **2.3의 `scope ↔ MCP 도구` 표가 단일 목록**이며, `pes_context`·`pes_capabilities`·`pes_projects` 같은 읽기 도구와 claim·wait·submit·ask·영수증·첨언·후속·가정/결정/반영 제안·반대·편집 제안 도구를 포함한다. **WebMCP 목록은 이 표와 별개**이며 `S3-W1`·5단계 WEB13에서 따로 정한다. Claude 앱은 **Customize → Connectors → Add custom connector**에 URL을 넣고 OAuth로 승인한다(Pro/Max 전용이 아니며 실제 지원 환경은 WEB5 종단 시험으로 확인). Claude Code는 `claude mcp add --transport http pes https://…/mcp --header "Authorization: Bearer …"`로 같은 엔드포인트를 쓴다. **Codex CLI·OpenCode TUI는 기존 bridge/HTTP MCP를 같은 `/mcp` 계약에 연결하고 새 어댑터를 만들지 않는다.** Desktop/stdio·CLI·명시적 전달은 지원 수준을 문서화하고, 회수·수신 영수증·옛 결과 거부를 Claude Code·Claude 앱·Codex CLI·OpenCode TUI에서도 시험한다. **등록 원고의 축약 목록은 이 표를 대체하지 않는다.**
- **인증**: 원격 MCP는 **OAuth 2.1 + PKCE**를 쓴다. resource/issuer/audience·metadata discovery·정확한 redirect URI를 검증하고, 동적 클라이언트 등록(DCR)은 선택으로 두되 rate limit·허용 목록·사용자 동의로 제한한다. Cloudflare Workers OAuth Provider를 쓰되 **KV 의존**을 확인하고, **KV 읽기/쓰기/저장 사용량을 WEB12에서 계측**하며, **액세스 토큰 `jti`를 매 요청 D1에서 검사하는 것은 PES가 보강**한다. 1시간 액세스 + 30일 리프레시, refresh 회전·재사용 거부. UI에서 "연결된 앱"으로 회수한다. **OAuth 위임은 사람 세션이 아니다**: `actor.kind=external_agent`, `on_behalf_of_user_id`로 기록하고, 승인·reopen·정책·토큰·삭제는 할 수 없다.
- **범위**: **동의 범위 ∩ 현재 `project_members` ∩ 에이전트 제한**을 매 호출 검사한다. 동의 후 새로 가입한 프로젝트로 자동 확장하지 않고, "사용자의 모든 프로젝트"를 기본으로 주지 않는다. 복수 프로젝트 선택·범위 변경·회수를 제공한다.
- **대기·크기**: 업무 `wait` 전이와 입력 조회 long-poll을 구분한다. 커넥터의 `wait_ms` 최대 10초는 **capabilities로 공지하는 구현값**이지 외부 서비스의 보장값이 아니다. 25초 롱폴은 runner·CLI 전용이다. **긴 대기를 Worker에서 어떻게 구현할지(DO·짧은 폴+ETag·SSE)는 미확인**이며 2.4·WEB1에서 정한다. 결과는 바이트 중간에서 자르지 않고 **digest·정확한 manifest·페이지 커서 또는 명시적 크기 오류**를 반환한다. 크기·transport 때문에 승인·사람 답·결과 제출의 의미를 바꾸지 않는다.
- **권한**: **MCP와 WebMCP의 허용 목록은 별개다.** `pes_submit`은 run 결과 제출이고 사람 답 `submissions`와 다른 명령이다. MCP는 사람 답 제출을 대신하지 않지만, **에이전트가 자기에게 온 질문에 답하는 공통 권한은 유지**한다. **답 초안은 브라우저 저장소만 쓰고 서버 초안 API는 두지 않는다**(`stage-1-api.md` 3절). 사람→AI 질문도 실제 작성 actor를 기록한다.
- **실패·재접속**: 앱에는 지속 heartbeat를 요구하지 않는다(B4). Claude 앱·Claude Code·Codex CLI·OpenCode TUI 모두 재접속 첫 절차는 context → 새 입력 → **수신 확인** → claim. "연결됨"은 마지막 확인 시각일 뿐이다. Codex/TUI의 기존 bridge가 끊긴 뒤 옛 결과·회수된 자격을 거부하는지 시험한다.
- **붙여넣기**: 계속 제공한다. 복사만으로 실행·제출 완료로 표시하지 않고, 가져온 결과는 사람이 새 claim으로 채택한다(B3). 원격 MCP가 막히는 환경의 보장 경로다.

### 2.6 알림 (휴대폰·메일)

- **정할 것**: 채널, 보낼 사건, 본문 내용, 중복·야간 처리, 실패 추적.
- **선택지**: ① 메일만 ② 메일 + Web Push ③ 메일 + Telegram/ntfy ④ SMS.
- **판단 기준**: 한국·iPhone에서 실제 도달, 설치 부담, 비용, 연구 내용 노출, 운영 부담.
- **추천**: **② 메일 + Web Push**. 메일은 Resend(무료 3,000통/월, **하루 100통**)로 보내고, 푸시는 VAPID + 서비스 워커로 보낸다. iPhone은 **홈 화면에 추가한 PWA**에서만 푸시가 되므로(iOS 16.4+) 첫 로그인 뒤 설치 안내를 띄우고, 미설치·거부 사용자는 메일로 받는다. SMS는 비용·개인정보·한국 발신 규제 때문에 쓰지 않는다. 로그인 매직링크·초대·재인증 메일도 같은 무료 발송량에 포함한다.
- **사건**: `waiting_human`(답 대기), **승인 대기(별도 사건)**, 새 질문, run 실패·중단, 토큰 만료 임박, 백업 실패, 이전 완료. 승인 대기와 `waiting_human`은 같은 상태가 아니다. 모든 event를 보내지 않고 사람이 행동해야 하는 것만 보낸다.
- **본문**: **기본 알림은 프로젝트 이름도 넣지 않고** 일반 문구 + 로그인 링크만 보낸다. 프로젝트명·단계·라운드·질문 번호·딥링크 같은 상세 제목은 사용자가 켤 때만 넣는다. **질문 문구·연구 내용·파일명은 넣지 않는다.** 링크는 로그인 후 정확한 버전으로 이동한다.
- **권한 재검사**: 발송 직전 수신자의 현행 `project_members`·채널 허용을 다시 검사한다. 회원 제거·역할 변경 뒤에는 보내지 않는다.
- **중복·시간**: `dedupe_key = endpoint + event_seq + event_type`으로 한 사건은 한 번. 5분 안의 여러 사건은 묶는다. 22:00~08:00 KST는 조용한 시간(실패·보안 경보 제외). **"1분 내 도착"을 보장하지 않고**, 적격 사건의 **enqueue·발송 시도 목표**와 실제 도달 확인을 나눈다. provider 접수 뒤 응답 유실·재시도에 대비해 발송 시도 영수증과 `unknown` 상태를 둔다. **provider 멱등 키·확인 가능한 영수증을 남기고, unknown은 provider 재조회로 해소한다. 확인할 수 없으면 자동 재전송을 멈추고 중복 가능성을 표시한다. 내부 접수 중복 0과 외부 도달/발송 결과를 별도 시험한다.** 기기 오프라인·푸시 거부·바운스의 대안을 UI에 표시한다.
- **표·전송**: `notification_outbox`(업무 변경과 같은 tx에 기록), `notification_endpoints`, `notification_preferences`, `notification_deliveries`를 5단계 보조 표로 추가한다(1단계 54개 표 기준 밖, 2~4단계 확장 표 포함 최종 수는 WEB1에서 갱신, 파괴 없음, **새 마이그레이션 담당 WEB8**). Queue/Cron이 outbox를 읽어 발송하고, 실패는 지수 백오프로 재시도하며 UI에 마지막 오류를 보여 준다. **Queues Free는 10,000 operations/일·보존 24시간 고정**이므로, 재시도는 24시간 안에 끝내되 **24시간이 지났다는 이유만으로 `unknown`으로 바꾸지 않는다.** provider 응답/영수증이 있으면 그 결과를, 없으면 `unknown`과 중복 가능성을 표시하고 자동 재전송을 멈춘다. 알림량이 하루 수백 건이면 3 ops/건 기준 10k/일의 10% 미만이다.
- **재발송 금지**: 복원·import 뒤 과거 사건을 새 알림으로 다시 보내지 않는다.

### 2.7 로컬 → 웹 자료 옮기기

- **정할 것**: 이전 단위, 묶음 형식, 검증, 중단 복구, 되돌리기, 로컬 DB의 최종 상태.
- **선택지**: ① 로컬과 웹 양방향 동기화 ② 프로젝트 단위 한 방향 이전 ③ 웹에서 새로 시작하고 로컬은 버림.
- **판단 기준**: stage-1-db 2·4절(이중 쓰기 금지, 한 프로젝트의 쓰기 원본 하나), 무손실, 되돌리기, 다운타임, 재개 가능성.
- **추천**: **② 프로젝트 단위 한 방향 이전**. ①은 금지한다. ③은 기존 연구를 버리므로 안 된다.
- **동결 범위**: **프로젝트 동결은 로컬 DB 전체 읽기 전용이 아니다.** 옮기는 프로젝트만 동결하고, 미이전 프로젝트는 로컬에서 계속 쓴다. 로컬 DB 전체의 쓰기 경로를 지우는 것은 활성화 뒤 그 프로젝트에만 해당한다.
- **절차**: (1) 해당 프로젝트 쓰기를 동결하고 `pes export --bundle`로 DB 부분·객체·manifest·hash를 만든다(2단계 PR 3 형식 재사용). 기존 `index.html`·`ask-*.html`도 보존 blob으로 함께 넣고, 새 화면은 DB에서 다시 렌더한다. (2) 묶음을 R2 staging에 업로드한다(멀티파트, 업로드 뒤 sha256 검증). (3) **배포 staging 환경과 `import_batches.state=staging`은 다른 것이다.** 배포 staging의 D1에 `import_batches`를 만들고 Workflows로 청크 import를 재개 가능하게 돌린 뒤, 최종 prod 적재·활성화 경로를 명시한다(PR 11·12 재사용). (4) 개수·본문 hash·미처리 답·첨부 hash·보고서 재생성을 검증한다. (5) 활성화하고 해당 프로젝트 로컬 DB를 `exported_readonly`로 표시한다(**현재 DDL에 없는 새 상태 — 새 마이그레이션 담당 WEB9**). (6) 실패하면 동결을 풀고 로컬을 계속 쓴다.
- **청크**: 100행 고정이 아니라 **D1 한도에 맞춘다** — 쿼리당 바인딩 100개, SQL 100KB, 행/문자열/BLOB 2MB, 열 수·바이트·FK/순환 참조·호출/시간 제한. **Free는 호출당 쿼리 50개·Workflows step 3,000/일**이므로, 큰 프로젝트는 `db.batch()`로 묶고 Workflows step을 잘게 쪼개지 않는다. 청크 수가 3,000 step을 넘으면 **합성 검증은** CI의 `wrangler d1 execute`/batch로 넘기되, **실제 프로젝트 import는 허용된 로컬·비공개 실행 주체**가 같은 batch로 처리한다. 실제 크기는 시험으로 정하고 중단·재개를 검증한다.
- **부분 적재**: 청크 실패 시 부분 프로젝트가 업무 화면에 보이지 않아야 한다.
- **활성화 응답 유실**: **자동으로 로컬 동결을 풀지 않는다.** 웹 활성 여부·첫 쓰기 여부를 대조해 이중 원본을 막고, 사람이 확인한 뒤에만 해제한다. 로컬 run/lease·외부 세션·옛 자격의 채택을 차단하고 웹 자격을 재발급한다.
- **CLI 인증**: 업로드는 owner가 웹에서 발급한 **1시간·1회 import 토큰**으로 한다. 에이전트 키로는 가져올 수 없고, 사람 세션과 같은 step-up을 요구한다. 브라우저 업로드는 세션과 CSRF 토큰을 쓴다.
- **되돌리기**: 웹에서 **첫 쓰기 전**에는 로컬 동결 해제로 돌아간다. 첫 쓰기 뒤에는 D1 백업에서만 복구하며, **프로젝트 단위 복원**이라 다른 프로젝트를 되돌리지 않는다. 옛 `project.json`으로 무손실 복귀를 보장하지 않는다(`stage-1-db.md:132`).
- **이전 뒤 로컬**: 옮긴 프로젝트의 `pes` CLI·스킬은 로컬 DB가 아니라 **웹 API**를 쓴다. 로컬 DB는 읽기 전용 스냅샷이고 쓰기 경로는 제거한다(2단계 PR 15·16의 전송만 웹으로 바꾼다). 오프라인 편집은 5단계에 넣지 않는다.
- **역방향**: 웹 → 로컬은 **이전(migration)이 아니라 내보내기(portability)** 다. 같은 번들 형식으로 받아 읽기 전용으로 열 수 있게 한다. 동기화가 아니다.
- **정수 정밀도**: export/import에서 rev·fence·event_seq 같은 int64는 **10진 문자열**로 검사하는 것만으로 부족하다(`stage-1-api.md:19`). **2^53 초과 정수(예: `9007199254740993`과 인접 rev/fence)의 export→import→복원 동일성 게이트**를 두고, 숫자로 변환되기 전 보존하는 export 경로 또는 검증된 도구/버전을 정한다. 손실을 발견하면 그 백업을 유효 복원본으로 채택하지 않는다. 방식 선택 전에는 "정밀도 검사 예정"과 "무손실 복구 검증 완료"를 구분한다.
- **실제 자료**: 합성 fixture로 먼저 검증하고, 실제 프로젝트는 **사용자가 프로젝트별로 명시 허용한 1개**만 시범 이전한다. **공개 CI는 합성 검증만** 하며 실제 자료를 처리하지 않는다. 실제 manifest·경로·수신자·백업·로그는 공개 저장소·CI artifact에 넣지 않는다.

### 2.8 운영 D1·R2 배포·백업

- **정할 것**: 환경 분리, 마이그레이션 규칙, 백업 주기·보존·암호화, 복구 목표, 모니터링.
- **선택지**: ① Time Travel만 ② + 야간 export ③ + 교차 계정 복제.
- **판단 기준**: RPO/RTO, 비용, 휴대 가능성, 운영자의 실수 복구, Cloudflare 장애 대비.
- **추천**: **② + 필요 시 ③**. staging·prod를 Workers 환경·D1·R2 버킷으로 분리하고, 마이그레이션은 **앞으로만(expand/contract)** 간다. 운영 D1은 하나(환경당)를 기본으로 한다. **DB가 350 MB에 가까우면 안전 정지·아카이브·유료 전환을 검토**하고, **프로젝트별 D1 분리는 5단계 완료 조건이 아니라 후속 검토**다. **Free는 DB 10개·DB당 500 MB·계정 5 GB**이고 500 MB는 절대 넘기지 않는 하드 캡이다.
- **배포**: main→staging 자동, 태그→prod 수동 승인(GitHub Environment). prod 전에 staging에서 같은 마이그레이션과 smoke를 돌리고, 배포 뒤 로그인·읽기·답·claim·알림 핵심 경로를 확인한다. 롤백은 Worker 이전 버전 재배포이고, 마이그레이션은 되돌리지 않고 **새 마이그레이션으로 복구**한다. 구버전 앱/신스키마 호환 창을 검증한다.
- **백업**: **Time Travel 7일(Free)** 이 1차다. 여기에 **야간 `wrangler d1 export` → gzip → age 암호화 → R2 백업 버킷**을 더한다. **각 복원 지점은 DB 경계 + 그 시점이 참조하는 객체/hash 목록을 한 묶음으로** 만들고, DB와 객체가 같은 RPO를 갖게 한다. **복원 지점이 참조하는 객체 바이트는 별도 보존/복사**하고, R2 수명주기·GC가 그 객체를 지우지 않게 한다. hash 목록만으로는 삭제·손상된 원본을 되살릴 수 없다. 보존은 일 30개 + 월 12개를 **기본 제안**으로 두되, **R2 무료 10 GB를 객체와 백업이 나눠 쓰므로 42개 백업의 압축 크기 + 객체 크기 ≤ 8 GB**를 유지한다. 넘으면 일 7개 + 월 4개로 줄이거나 9절의 유료 전환을 검토한다. **보존/주기를 줄여 승인된 RPO·복원 지점 조건이 깨지면 운영 변경으로 기록하고 사용자 확인을 받는다.** R2 객체는 불변 키(`backup/d1/YYYY/MM/DD.sql.gz.age`)로 두고 수명주기로 정리한다. **age 암호키는 백업 버킷과 분리해 별도로 복구**할 수 있게 한다(오프라인/별도 시크릿 저장소).
- **실행 주체**: `wrangler`·gzip·age는 Worker/cron 안이 아니라 **허용된 로컬·비공개 실행 주체**가 운영자 승인 아래 최소 권한 Cloudflare API 토큰으로 돌린다. **공개 GitHub Actions는 합성 검증만** 한다. 실제 자료 백업을 Actions로 유지하려면 실행 계정·runner·목적·보존/삭제·원문 로그/캐시/artifact 금지·권한을 먼저 명시하고 실제 자료 허용 기록에 추가한 **별도 승인 변경안**으로만 한다. 임시 파일은 암호화·삭제하고 시크릿을 로그에 남기지 않는다.
- **export 영향**: D1 export는 실행 중 다른 요청을 막는다(`developers.cloudflare.com/d1/best-practices/import-export-data`, 2026-11-05 확인). **새벽 창**에 돌리고 화면에 읽기 전용 안내를 띄우며, 요청 차단·타임아웃·재시도 처리를 함께 둔다. 같은 문서의 **int64 정밀도 손실** 경고에 따라 rev/fence/event_seq의 10진 문자열 계약을 export/복원에서도 검사하고, **2^53 초과 정수(예: `9007199254740993`)의 export→import→복원 동일성**을 시험한다. 손실을 발견하면 해당 백업을 유효 복원본으로 채택하지 않는다. 숫자 변환 전 보존 경로/도구를 정하기 전에는 "정밀도 검사 예정"으로 표시한다. **export가 rows read로 계측되는지는 미확인**이므로, 야간 export 1회의 읽기량을 실측해 **500만 행/일** 예산에 넣는다. 전체 export가 하루 읽기 예산을 크게 먹으면 주 1회로 낮추고 Time Travel 7일로 최근 복구를 맡긴다.
- **복구 목표**: RPO 24시간(야간 백업) + **Time Travel로 최근 7일은 분 단위**. RTO 4시간. **월 1회 스크래치 D1에 복원**해 지원되는 무결성 검사, 표별 개수, 표본 보고서 재생성, **객체 1개 누락·삭제 복구와 키 분리 복구**를 확인하고 소요 시간을 실측한다. 복원 시 커서·lease·세션·토큰·예산·알림 상태 처리도 런북에 넣는다.
- **R2**: **Free 10 GB-month·Class A 100만/월·Class B 1,000만/월** 안에서 객체와 백업이 같은 용량을 나눠 쓴다. `objects/`는 불변 키·덮어쓰기 금지, `staging/`은 30일 뒤 정리, `quarantine/`은 검사 실패 파일(현재 DDL 상태명 `quarantined`, `stage-1-ddl-draft.sql:220`). 버킷은 공개하지 않는다. **사람용 다운로드는 짧은 서명 URL**을 발급하기 전에 `project_members`와 blob의 `project_id`를 검사한다. **Go/에이전트용 파일 읽기는 서명 URL이 아니라 매 요청 정책을 검사하는 PES 프록시**다: 정확한 버전·project·ready 상태·현행 정책을 확인하고, OFF 뒤 유효한 R2 URL로 우회할 수 없게 한다. 객체는 삭제보다 보관이 기본이고, **복원 지점이 참조하는 객체 바이트는 별도 보존/복사하며 수명주기 예외를 둔다**. 월 1회 **객체 목록·hash manifest**를 D1 백업과 함께 보관해 복원 검증에 쓴다. 백업 버킷은 가능하면 **별도 Cloudflare 계정** 또는 최소 권한 토큰으로 분리한다.
- **모니터링**: 5xx 비율, p95 지연, D1 rows read/written, Queue 적체, runner 마지막 확인, 알림 실패, 백업 나이·누락 객체. 경보는 메일 + 운영자 푸시. Cloudflare 계정·GitHub 계정은 2단계 인증, 배포 토큰은 환경별 최소 권한.

### 2.9 비용

- **정할 것**: 무료 한도 계측·경보 기본값, 도메인·메일 발신 하위 도메인. **유료 계정·결제 주체·월 예산은 지금 정하지 않고 9절로 미룬다.** A 실행 상한은 2단계 결정을 승계하므로 다시 묻지 않는다.
- **선택지**: ① **Free만**(지금) ② Free로 시작하고 한도 초과 시 Paid ③ 처음부터 Paid. ③은 사용자 결정과 다르므로 채택하지 않는다.
- **판단 기준**: 예측 가능성, 무료 한도 내 가용성, 기능 제약(요청당 CPU 10 ms), 환율·세금.
- **추천**: **① Free만**. 2026-11-05 기준 Workers Free·D1 Free·R2 무료 구간으로 설계한다. **Workers/D1/Queues/Workflows는 Free 하드 캡으로 $0**이고, **R2는 무료 포함량 안에서 $0를 목표**하지만 초과분은 종량 과금된다. 플랫폼이 R2 $0을 강제하지 않는다. 도메인만 별도다.
- **예상(산식·가정)**: Cloudflare Workers $0 + D1 $0(무료 한도 내) + R2 $0 목표(10 GB·작업 한도 내, 초과 시 종량 과금) + Queues/Workflows $0 + 메일 $0(Resend 무료 3,000통/월, 하루 100통) + 도메인 ~$1/월 = **약 $1/월**. 2.1.2의 하루 사용량(요청 4,400·D1 읽기 1.3만 행·쓰기 1,000행·저장 500 MB·R2 7 GB)을 전제로 한 추정이며 보장값이 아니다. **3초 커서 폴링을 기본으로 쓰면 1탭 24시간 28,800회·8시간 9,600회로 늘어나며, 여러 탭이면 100k/일에 근접한다.** 이는 15초 폴링 기준(하루 4,400회)과 다른 조건이므로 "10배"로 뭉뚱그리지 않는다.
- **한도 집행**: Workers/D1/Queues/Workflows의 무료 한도는 **청구 상한이 아니라 하드 캡**이다. 100k/일을 넘으면 1027, D1 일일 한도를 넘으면 쿼리 오류, 저장이 차면 쓰기가 막힌다. **R2는 하드 캡이 아니라 무료 포함량+초과 과금**이므로, WEB12에서 업로드·백업·다운로드별 사용량 예약·제한과 초과 위험 시 차단/운영 중지 절차를 둔다. WEB12에서 요청·CPU 초과·D1 rows/저장·R2 작업/저장·Queues ops·Workflows step·KV 읽기/쓰기/저장·DO 요청/벽시계 실행량/저장(선택 시)을 계측하고 **80%에서 경보, 90%에서 완화**(폴링 간격 확대, 비필수 알림·백업 연기, 새 run 생성 차단)한다. "새 run 차단"은 D1·R2·요청 사용을 멈추지 않으므로 **한도 준수의 증명이 아니다**를 UI에 표시한다. 모르는 값은 0으로 표시하지 않는다(`stage-1-runners.md:65`).
- **A 실행 상한**: run·단계·프로젝트 누적 상한은 **2단계 6절 2번 결정값을 그대로 승계**한다. **값이 없으면 A 유료 실행을 하지 않고**, unknown 비용은 예약을 자동 해제하지 않는다(`stage-1-runners.md:62-66`). WEB12는 이 값을 새로 묻지 않고 집행·표시만 맡는다.
- **사용자 결정**: 도메인은 6절로 올린다. **80% 경보·90% 완화는 2.9와 WEB12의 기본값**으로 두고 사용자 결정으로 묻지 않는다. **유료 계정·결제 주체·월 예산은 9절의 전환 신호가 나올 때 묻는다.**

### 2.10 WebMCP 재검토

- **정할 것**: 5단계에서 WebMCP를 정식 지원할지, 실험으로 둘지, 보류할지.
- **선택지**: ① 지금 정식 지원 ② 실험 유지 ③ 재조사 후 결정.
- **판단 기준**: `document.modelContext`가 Chrome/Edge **정식판**에서 되는가, 사용자가 실제 쓰는 에이전트가 브라우저 도구를 부르는가, 서버 권한 검사가 브라우저와 독립적인가, 승인류를 노출하지 않았는가.
- **추천**: **재조사 전에 결론을 확정하지 않는다.** 2026-11 기준 WebMCP는 여전히 origin trial 성격이고 이름이 바뀌는 중이라는 것만 **직접 확인**했다. 주요 에이전트의 실사용 여부는 확인하지 못했으므로 `research/webmcp.md`의 과거 제3자 보고를 "현재 미지원"의 증거로 승격하지 않는다. WEB13에서 1~2일 재조사해 **날짜가 있는 결정 기록**을 남기고, 그 결과에 따라 보류·유지·실험을 정한다. 도입 시에도 읽기·답 초안·첨언 도구만 실험으로 붙이고, 답 초안은 브라우저 폼에만 쓴다.
- **3단계 입력**: **`S3-W1`(WebMCP 실험 약 1 PR)의 결과를 입력**으로 받되, 구현 성공을 5단계 지원 근거로 간주하지 않는다.
- **그때까지**: 웹에서는 3단계의 실험 도구를 **기본 비활성화**하고, WEB13 결정 전에는 켜지 않는다. capabilities에 `webmcp: "unsupported"`로 표시하고, 브라우저 에이전트가 한 일은 `actors.kind=browser_agent` + `on_behalf_of_user_id`로 기록한다. 이는 사람의 직접 작성·승인 증거가 아니다(`stage-1-db.md:31`). 승인·reopen·판 시작·정책·토큰·삭제는 앞으로도 노출하지 않는다(`stage-1-api.md:30`).

### 2.11 보안

- **정할 것**: 공개 HTTPS에서의 인증·세션·CSRF·토큰·파일·감사 경계.
- **선택지**: ① 플랫폼 WAF에 맡김 ② 앱 수준 방어만 ③ 둘 다.
- **판단 기준**: OWASP ASVS L1, 최소 권한, 유출 시 피해 범위, 운영자가 재현 가능한가.
- **추천**: **③ 둘 다**, 단 **Free에서 실제로 쓸 수 있는 범위 안에서** 한다. 앱 수준 인가·rate limit·입력 검사가 기본이고, 플랫폼 방어는 Free에서 제공되는 WAF/rate limiting 범위를 WEB11에서 계정으로 확인해 겹친다. **Bot Management는 Enterprise 유료 부가 상품**이라 이 단계에서는 쓰지 않고, 무료 Bot Fight Mode와 앱 방어로 대체한다(`developers.cloudflare.com/bots/`, 2026-11-05 확인). 무료 플랜의 세부 WAF·rate limiting 제공 범위는 **미확인**이다.
- **전송·쿠키**: HTTPS만, HSTS, `__Host-` 쿠키, `Secure; HttpOnly; SameSite=Lax`. 로그인·권한 변경 때 세션 회전, 로그아웃 시 서버 세션 삭제.
- **CSRF**: 쿠키 기반 폼은 `SameSite=Lax` + `Origin`/`Referer` 검사 + 이중 제출 토큰. **Bearer 경로도 `Origin`·CORS·다른 쿠키 인증 경로를 대조**하고 "CSRF 면역"으로 일반화하지 않는다. OAuth는 `state` + PKCE + 정확한 redirect URI 허용 목록.
- **토큰**: 에이전트 키는 해시 저장·1회 표시·30일·회수·범위 제한. URL·쿼리·로그·프롬프트 금지. OAuth 액세스 1시간·리프레시 30일·연결 해제 즉시 폐기. 401/403 폭주는 경보.
- **웹**: CSP는 nonce 기반으로 두되 "인라인 스크립트 전부 금지" 같은 과장 없이 실제 허용·예외를 문서화한다. 저장 Markdown 안전 렌더(XSS), 클릭재킹 방지(`frame-ancestors 'none'`), `X-Content-Type-Options`, 참조 정책. 파일 업로드는 형식·크기 검사, `quarantined` 격리, 필요 시 악성코드 검사, 다운로드는 사람용 짧은 서명 URL 또는 Go용 정책 프록시 + `Content-Disposition`.
- **계정**: 매직링크 요청·로그인 시도에 rate limit, 이메일 존재 여부 비노출, 초대·복구 토큰은 128비트 이상·1회·만료, 반복 실패 잠금. 공개 인터넷에 열리므로 IP 허용 목록을 전제로 하지 않는다.
- **권한**: 모든 명령은 서버에서 `project_members`·actor·정책을 다시 검사한다. UI의 버튼 숨김은 권한 검사가 아니다. **승인류의 `assurance`는 실제 human/user/snapshot/tx 검증 결과**여야 하며 플래그만으로 `verified`가 되지 않는다.
- **프롬프트 주입**: 연구 자료·외부 글은 데이터이지 지시가 아니다. MCP 도구 설명은 고정하고, 자료 안의 "이것을 실행하라"를 따르지 않는다. WebMCP를 켤 경우 `untrustedContentHint`를 붙인다.
- **감사**: `mutation_commits` + `events`가 정본이다. **운영 감사 로그는 업무 변경·사건·멱등 영수증의 같은 tx 기록을 대체하지 않는다.** 로그인·토큰·정책·백업·가져오기·삭제는 별도 운영 감사 로그에 남기고, 운영자도 연구 내용을 볼 수 있는 권한과 그 기록을 남긴다.
- **비밀**: Worker secret, GitHub Environment secret, Cloudflare API 토큰 최소 권한. 저장소에는 실키·실자료 금지(stage-0 7-4, 공개 저장소).

### 2.12 Go 외 전송 정책

Go 기본 ON은 **다른 공급자·공개 배포에 대한 동의가 아니다**(`stage-1-db.md:142`가 5단계로 이월).

- **Claude 앱·OAuth 커넥터/Claude Code**: 수신자(Claude/Anthropic), 자료 범위(프로젝트·정확한 버전·허용 파일 형식), 동작(읽기·초안·결과 제출), 철회(연결 해제)를 OAuth 동의 화면과 "연결된 앱"에 표시한다. 연결 해제는 새 읽기를 즉시 막지만 이미 전송된 자료의 회수를 보장하지 않는다. `external_agent` actor·수신 영수증·옛 결과 거부를 남긴다.
- **웹 호스팅(D1/R2)**: 2.1의 자료 위치·관할 결정과 기관 반출 규정 확인에 묶는다. 프로젝트별 "웹으로 옮기지 않음" 선택을 지원한다.
- **백업**: 암호화된 export만 R2 백업 버킷에 두고, 암호키는 별도 관리한다. 백업에는 연구 자료가 포함되므로 접근 주체·보존·삭제 조건을 6절 4번에서 정한다.
- **메일·푸시**: 기본 본문에 연구 내용·프로젝트명을 넣지 않고, 링크·일반 문구만 보낸다. 상세 제목은 사용자가 켤 때만 보낸다.
- **공개 배포**: 공개 HTTPS 접속은 연구 자료의 공개 열람을 뜻하지 않는다. 공유 링크·인쇄물·내보내기는 별도 허용 범위다.

## 3. 방식 A·B 차이

| | A — PES 안 OpenCode | B — Claude Code·Claude 앱·Codex CLI·OpenCode TUI |
|---|---|---|
| 실행 위치 | 사용자 컴퓨터의 **로컬 runner**가 PES 전용 opencode 프로필을 띄움 | 사용자의 터미널(Claude Code·Codex CLI·OpenCode TUI) 또는 Claude 앱 |
| 연결 방향 | runner → 웹 **아웃바운드만**(일 조회·heartbeat) | Claude Code·Codex CLI·OpenCode TUI → 웹 HTTP MCP/기존 bridge, Claude 앱 → 웹 원격 MCP(OAuth) |
| 인증 | 프로젝트 범위 에이전트 키 | Claude Code·Codex CLI·OpenCode TUI는 기존 프로젝트 토큰·bridge 자격, 앱은 OAuth 위임 토큰 |
| 실행 시작 | 사람이 웹에서 run 생성 → runner가 **원자 claim** | 사람이 웹에서 run 생성 → Claude Code·Claude 앱·Codex CLI·OpenCode TUI가 claim, 또는 붙여넣기 |
| heartbeat | runner가 진행 관측으로 갱신 | **앱에는 지속 heartbeat를 요구하지 않음**. Claude Code·Codex CLI·OpenCode TUI는 도구 호출·진행에 묶음 |
| 대기·재개 | `wait`로 lease 해제, 재개는 새 claim | 같음. 네 가지 B 모두 재접속 절차는 context → 입력 → **수신 확인** → claim |
| 실패 시 | runner 오프라인·opencode 종료·lease 만료를 구분해 표시 | 연결 끊김 ≠ 취소. **마지막 확인 없음은 "꺼짐 확정"이 아니라 상태 미상**. Codex/TUI도 같은 규칙 |
| 데이터 경로 | 웹(D1·R2)에서 필요한 버전만 runner workspace로 내려받고, Go로 가는 것은 따로 기록. 로컬 프로젝트는 로컬에 남음 | 자료가 웹에 있고, Claude Code·Claude 앱·Codex CLI·OpenCode TUI가 읽음(사용자 선택 범위) |
| 비용 집행 | PES가 run·단계·프로젝트 상한을 집행 | PES는 작업량·채택·기한만. 외부 구독 비용은 집행 불가 |
| 5단계 변경 | supervisor를 runner로 옮기고 원격 claim을 붙임 | 원격 MCP·OAuth를 추가하고 기존 bridge·붙여넣기를 유지하며 Codex/TUI를 같은 계약에 연결 |

**같은 것**: 같은 PES 코어·같은 DB·같은 HTTP/JSON 명령·같은 오류 봉투·같은 lease/claim 계약. 화면 문구와 버튼도 같은 상태면 같아야 한다(2단계 PR 21 교차 계약). A와 B의 차이는 **실행 소유자와 연결 방향**이지 업무 의미가 아니다.

## 4. 이 단계 구현 이슈

규칙: **이슈 하나 = PR 하나**, 각 PR에 테스트·문서 포함. 권한·보안 검사는 WEB11까지 미루지 않고 각 WEB의 완료 조건에 넣는다. 1단계 설계서에 이미 나온 번호는 그대로 쓰고(2단계 PR 1~22, 3단계 U1~U6), 5단계에서 새로 필요한 것만 `WEB0~WEB14`로 붙인다. 3단계 초안의 `S3-W1`(WebMCP 실험)과 겹치지 않게 5단계는 `WEB` 접두사를 쓴다. 5단계는 3단계 U1~U6과 4단계가 끝난 뒤를 전제로 한다. **단 WEB0은 번호만 5단계이고, 2단계 PR4·13의 계약 픽스처가 나온 직후 실행한다.** 2단계 PR 10(토큰·정책)·13·14(API)·19·20a·20b(어댑터)·21(교차 계약)을 다시 만들지 않는다. 새 표·열·상태는 **"새 마이그레이션(담당 WEBn)"** 으로 표시하고, 현재 DDL에 있는 값처럼 쓰지 않는다. **표 수는 1단계 54개 고정이 아니라 2~4단계 마이그레이션 체인 기준으로 갱신한다.**

| # | 제목 | 범위 | 선행 | 완료 조건 |
|---|---|---|---|---|
| WEB0 | 코어 언어 기술 시험 | **번호는 5단계, 실행은 2단계 PR4·13의 언어 중립 계약 픽스처 직후.** 2단계 Python 코어를 웹에서 실행할 방식 비교: (a) Python Workers (b) TS 이식 + 언어 중립 JSON 계약 시험(골든 파일) 두 구현 (c) Workers 아닌 Python 서버. 결과를 `docs/plan/decisions/`에 기록 | **2단계 PR4·13의 계약 픽스처 직후**(5단계 착수 전) | **무료 계정에서 Python Workers 포함 여부를 먼저 확인**. 같은 명령·오류·멱등·정수 문자열 계약 시험을 후보 구현에 통과. **요청당 CPU 10 ms·메모리 128 MB·subrequest 50** 안에서 도는지 p95 측정. 지연·콜드스타트·비용 $0 측정. 2단계 PR4·13에 픽스처 사용 통지. **결과가 TS 이식이면 2~4단계 구현 언어를 다시 정하고 WEB1에 입력**. 결과가 (c)면 WEB1 플랫폼 전제 재검토 |
| WEB1 | 웹 실행 골격·배포 | **무료 플랜** Worker 앱(서버 렌더 + ES 모듈), Workers Assets, staging/prod, D1/R2 바인딩, 마이그레이션 실행, GitHub Actions(공개 CI는 합성만), 시크릿, 헬스체크, 기능 플래그, **업무 명령의 D1 어댑터/API 배치 범위 명시**, **2~4단계 마이그레이션 체인**(S4-PR23 `edition_carryovers`·`completed_snapshot_id`, S4-PR25 편집 허가·`projects.settings_json` 등)과 기존 프로젝트 `schema_version` | PR 1·2·4·13·14·18·U1, WEB0 | staging에서 실제 D1로 읽기 화면. **100k 요청/일·10 ms CPU·subrequest 50·Cron 5개·정적 자산 20,000개** 한도 안에서 smoke. D1 batch 원자성·0행 실패·deferred FK·부분 인덱스. 공통 명령 서비스의 D1 구현: rev/멱등/0행·뒤늦은 실패 전체 롤백, 큰 정수 문자열, 공개 DTO·커서 동일 의미, 이중 submit·순수 조회/tx 분리 시험. main→staging 자동·태그→prod 수동, 이전 버전 롤백 1회, 시크릿 스캔. **기존 프로젝트 `schema_version`과 PR23/25 표·열·허가·설정 적용 순서 시험**. **long poll 구현(DO/짧은 폴+ETag/SSE) 선택과 한도 계측**, **R2 활성화에 결제 수단이 필요한지 확인**. **공개 prod 전환은 WEB14 게이트** |
| WEB2 | 사람 로그인·세션 | Better Auth 버전 고정·D1 어댑터·추가 인증 표·`users` 매핑, 매직링크·패스키, `__Host-` 세션, 브라우저 step-up, 기기 목록, 전체 로그아웃, 복구 자격·복구 코드, CLI 기기 승인(device flow), 로그인 감사. 새 마이그레이션(담당 WEB2) | WEB1, PR 4 | **로그인·세션 검증 경로의 p95 CPU가 10 ms 이하**인지 측정. 넘으면 세션을 경량 HMAC 쿠키 + D1 1행으로 줄이고, 그래도 넘으면 9절 신호. 로그인·만료·고정·회전·재인증 시험. 기존 owner 매핑·인증 식별자 변경·다른 프로젝트 접근 거부. 승인류는 5분 내 브라우저 재인증 없으면 403. step-up이 snapshot/rev에 묶이고 기기 토큰으로 대행 불가. 재인증 중 미제출 답 보존. 복구 코드 1회 사용·재사용 거부. CLI 기기 토큰 회수 즉시 401 |
| WEB3 | 멤버·초대·역할 | `project_members` UI/API, owner/editor/reader, 7일 1회 초대, 역할 변경·제거, 권한 매트릭스, 감사, MCP/OAuth scope 정책, **소유권 이전 FK/소유권 이력 마이그레이션**(과거 `project_policy_versions.changed_by_user_id`가 현재 owner를 참조하는 충돌 해소, 옛 정책 작성자·당시 소유자 증거 보존) | WEB2, PR 10 | 역할별 허용·거부 표 전 항목 자동 시험. **프로젝트 owner 최대 1명·`projects.owner_user_id`와 membership 일치·원자적 소유권 이전**. **초기 정책이 있는 합성 프로젝트에서 이전 전후 FK·권한·과거 기록 불변 시험, 옛 정책 작성자를 새 owner로 덮어쓰지 않음, S6-M1과 경계 일치**. 마지막 owner 제거 불가. 역할/회원 제거가 세션·OAuth 위임·에이전트 자격·예약 알림에 반영. editor가 승인·reopen·정책·토큰·삭제 불가, editor 답이 agent lease에 막히지 않음 |
| WEB4 | 에이전트 키 운영 | 발급·1회 표시·HMAC 해시·**API 6절 동작 전체 scope**·30일·회수·24시간 교체·긴급 회수·pepper 버전/회전·마지막 사용/IP·토큰별 rate limit·감사·CLI/UI, `agent_tokens` nullable 보강. 새 마이그레이션(담당 WEB4) | WEB2·WEB3, PR 10 | 회수 즉시 401, 진행 run은 lease 만료 뒤 `interrupted`. 원문이 DB·로그·에러·URL·프롬프트에 0건. **scope×명령×도구 허용/거부 계약 시험**, 인증 후 replay. 교체 중 무중단, 긴급 회수는 겹침 없음. TTL 뒤 상태 변경도 명령·사건. 키로 승인 불가 |
| WEB5 | 원격 MCP·OAuth (B) | `/mcp` Streamable HTTP, 실제 도구 전체(context·claim·submit·ask·wait·complete·heartbeat·release·cancel·영수증·projects), OAuth 2.1(PKCE·resource/audience·metadata), 동의 화면, 연결된 앱 관리, Claude 앱 커넥터·Claude Code HTTP MCP, **Codex CLI·OpenCode TUI 기존 bridge/HTTP MCP 연결**, Desktop/stdio·CLI 지원 수준 | WEB2·WEB3·WEB4, PR 13·14·20a·20b | 합성 프로젝트 1라운드 왕복. **도구 호출 1회가 Free의 10 ms CPU·subrequest 50 안**인지 측정. 도구 호출 10초 내 응답(capabilities 공지값). 승인·정책·토큰·사람 답 제출 도구 없음. 자기에게 온 질문 답은 허용. scope = 동의 ∩ 멤버 ∩ 제한, wrong-project 거부, 중복 제출 거부, **scope×명령×도구 허용/거부 계약 시험**. refresh 회전·재사용 거부, 연결 해제 즉시 401, KV 의존·D1 jti 보강 확인. **앱/Claude Code/Codex/TUI 각각 재접속·만료·옛 결과 거부·수동 전달 대안 시험** |
| WEB6 | runner 등록·연결 (A) | `pes runner` 데몬, 아웃바운드, 등록·기기 목록, **일 조회(순수)·claim(원자) 분리**, heartbeat/wait/complete, 오프라인 표시, 프로젝트 담당 하나, OS 키체인, 로그. 새 마이그레이션(담당 WEB6) | WEB4, PR 5·19 | **기본 폴링 25–30초, 3초 기본값 금지**(1단계 UI 결정 14의 웹 조정, 로컬 모드·U1 커서 갱신 계약은 그대로), 탭·runner 유휴 시 중지·백오프. 1 runner 하루 요청 수를 계측해 100k/일의 5% 이하. 절전·단절·재접속(수신 확인 포함) 시험. 인바운드 포트 0. 등록은 허용하되 **프로젝트 실행 담당 하나**로 동시 claim 거부·사람 인계. 두 runner 경합·회수·옛 fence 제출 거부. 가상 시계 + 실제 Windows/Mac |
| WEB7 | runner의 opencode supervisor | 전용 프로필·프로세스·workspace, **매 반출 요청 서버 허가**, interrupt, crash 복구, usage 보고, 로그 회전, 서명된 업데이트·무결성, Windows/macOS, DeepSeek 하나·폴백 없음·부모만 채택·자식 대기 전파·reviewer·세션 계보 | WEB6, PR 19·21, WEB12 예산 값 | 클라우드 queued run을 로컬에서 **6단계 각 단계 최소 1라운드** 완주. 강제 종료(Windows는 해당 시험) 뒤 재개·중복 없음. OFF 즉시 모든 경로 차단·in-flight unknown. 부모 대기 전파·자식 결과 부모만 채택. interrupt/cancel/인계 202가 재시작 뒤 재처리·조회. 사용량 기록. 서명키 회전·검증 실패 처리 |
| WEB8 | 알림 | 알림 표·outbox, Resend 메일(3,000통/월·100통/일), VAPID Web Push, PWA 매니페스트·서비스 워커, 환경설정, 조용한 시간, 중복 제거, 딥링크, 발송 영수증·unknown·재시도, **승인 대기 별도 사건**, 기본 일반 문구. 새 마이그레이션(담당 WEB8) | WEB1·WEB2·WEB3, PR 14 | **Queues Free 10,000 ops/일·보존 24시간** 안에서 재시도 종료. 적격 사건 enqueue·발송 시도 목표 충족(도착 보장 아님). **내부 접수 중복 0, 외부 도달/발송 결과 별도 시험, provider 멱등 키·영수증·unknown 재조회**. iOS 홈화면 PWA 푸시, 미설치·거부 대안. 실패 UI·재시도. 본문에 연구 내용·프로젝트명 없음(상세는 선택). 발송 직전 권한 재검사. 로그인 메일 포함 무료량. 복원·import 뒤 과거 사건 재발송 0 |
| WEB9 | 로컬→웹 이전 | 번들 업로드(멀티파트·서명), 1시간 1회 import 토큰, R2 staging, Workflows 청크(D1 한도 기반), hash 검증, 재개, 검증 보고서, 활성화, 로컬 읽기 전용 표시(새 마이그레이션 담당 WEB9), **S4-PR23/25의 이월·완료·설정·편집 허가 이력 이전·검증**, CLI·스킬의 웹 API 전환, 되돌리기 | WEB1·WEB2·WEB3, PR 3·9·11·12·15·16·17 | **Free의 Workflows 3,000 step/일·호출당 쿼리 50** 안에서 2MB 합성 이전 완주. step이 모자라면 **합성 검증은** CI의 `wrangler d1 execute`/batch, **실제 import는 허용된 로컬·비공개 실행 주체**의 batch로 대체. 합성(2MB JSON·깨진 참조·이미지) 이전 뒤 보고서 재생성 의미 동등. **이월·완료·설정·편집 허가 이력을 가진 합성 프로젝트 이전**. **2^53 초과 정수 export→import→복원 동일성, 손실 시 백업 채택 금지**. 중단 후 재개, 청크 재실행·FK/순환·ID 충돌·사건 번호/커서 재발급·중복 영수증. 부분 적재 비표시. 활성화 응답 유실 시 자동 해제 금지·이중 원본 차단. 쓰기 전/후 롤백 구분, 프로젝트 단위 복원. 활성화 뒤 로컬 쓰기 0건, 다른 프로젝트 무영향. 실제 프로젝트는 사용자 승인 후 1개. **개발 완료 = 합성 이전·복원**이며, **실제 업로드·활성화는 WEB10·WEB11·WEB14 뒤 사용자 허용을 받은 후속 실행**이다 |
| WEB10 | 운영·백업·복구 | prod/staging, expand/contract 마이그레이션, 야간 D1 export→R2(age), **DB 경계+객체 hash 목록+참조 객체 바이트 보존/복사**, 보존, R2 수명주기, 키 별도 복구, 복구 훈련, 모니터링·경보, 런북, **실행 주체 경계(공개 CI는 합성만, 실제 백업은 허용된 로컬·비공개)** | WEB1 | **Time Travel 7일(Free)·R2 10 GB 공유** 안에서 RPO 24h·RTO 4h 훈련. **D1 350 MB 안전 정지·유료 전환 검토 신호, 500 MB 하드 캡** 확인. 프로젝트별 분리는 후속 검토. **42개 백업 압축 크기 + 객체 ≤ 8 GB** 확인, 넘으면 보존 축소. **2^53 초과 정수 export→import→복원 동일성, 손실 시 유효 복원본 채택 금지**. export 1회의 rows read를 실측해 5M/일 예산에 포함. 백업 누락·누락 객체 경보. **객체 1개 누락·삭제 복구, 키 분리 복구, 보존 축소가 승인된 RPO/복원 지점을 깨면 운영 변경·사용자 확인**. 마이그레이션 롤백 절차 1회. 같은 복원 경계로 프로젝트 단위 복원, 다른 프로젝트 무영향. **이월·완료·설정·편집 허가 이력 복원·무영향**. 키·새 계정 복구, 커서/lease/세션/토큰/예산/알림 처리. 구버전 앱/신스키마 호환 창. 런북만 보고 재현 |
| WEB11 | 보안 강화·점검 | **구현된 전체 경로 보안 점검**, CSP·HSTS·CSRF·Origin·rate limit·WAF, 쿠키, step-up, 파일 격리·형식 검사, 시크릿 회전, 의존성 감사, OWASP ASVS L1(판본·범위 명시), **Free에서 쓸 수 있는 플랫폼 방어 범위 확인(Bot Management 제외)** | WEB2·WEB4·WEB5·WEB7·WEB8·WEB9·WEB10·WEB12 | 치명·높음 0(평가 근거 포함). CSRF·XSS·클릭재킹·토큰 유출 시험. **Go 파일 프록시 우회 0**, 공개 버킷 0. 다른 프로젝트 참조·system 위장·서명 URL 우회·공유 기기 민감 캐시 시험. 401/403 폭주 경보. WEB3·WEB6/7·WEB10·WEB12 계약도 종합 점검 |
| WEB12 | 무료 한도·사용량 계기 | Workers 요청·CPU 초과, D1 rows/저장, R2 작업/저장·**업로드/백업/다운로드별 예약·제한**, Queues ops, Workflows step, KV 읽기/쓰기/저장, DO 요청/벽시계 실행량/저장(선택 시), 메일 사용량 수집, 월 보고서, **80% 경보·90% 완화**, A 누적 예약/정산 분리, unknown 표시, 관리자 화면 | WEB1·WEB8, WEB6/7 계약 또는 가짜 runner | 월 1회 보고서. **100k/일·5M 읽기/일·10만 쓰기/일·5 GB·10 GB·10k ops/일·3,000 step/일** 대비 사용률 표시. 90%에서 폴링·알림·백업·새 run 완화. **R2 초과 과금 위험 표시·차단/운영 중지 절차 시험**. **KV·DO(선택) 사용률 표시**. **"새 run 차단"이 한도 준수의 증명이 아님을 표시**. unknown을 0으로 표시하지 않음. A 상한은 2단계 값 승계, 없으면 유료 실행 안 함. 가짜 runner로 순환 회피 |
| WEB13 | WebMCP 재검토 | 2026-11 기준 표준·브라우저·에이전트 지원 재조사, **`S3-W1` 결과 입력**, 노출 목록 재확인, 조건 충족 시 읽기·초안 도구만 실험, 결정 기록(기존 결정 색인을 확인해 비어 있는 번호 사용, 0007 결함 처리와 겹치지 않음) | WEB2·WEB11 | 근거 날짜가 있는 결정 기록. 직접 확인과 미확인 구분. 도입 시 REA 도구 발견 점검·브라우저 폼 초안·제한 browser_actor·서버 거부·미지원 capability 시험. 미도입 시 capabilities에 미지원 |
| WEB14 | 전환 통합 검증·문서 | **Free 플랜** A/B 클라우드 종단, Windows/Mac, 이전·롤백, 알림, 무료 한도, 사용자 안내·운영 문서, 장애 훈련, **A↔B 인계·경합·지연·OFF·예산·유실/중복**, **Codex/TUI 재접속·회수·인계·Go 경계 회귀**, **U1~U6·S4-U7~U12 웹 동등성**(폼 버전·반영 증거·앵커·전달 manifest·인쇄 manifest), **U1 갱신 주기(25~30초·탭 숨김 중지·백오프)** | WEB0~WEB13 | 5절 게이트 전부 통과. **무료 플랜에서만 시험하고 유료 기능에 의존하지 않음**. CI는 매 PR + main, Windows+macOS, 수동 IME/인쇄 시험. **U1~U6·S4-U7~U12, 25~30초 갱신·탭 숨김 중지·백오프, 폼 버전·반영 증거·앵커·전달 manifest·인쇄 manifest를 시험하고, 제외 항목은 이유와 검증 시점을 적는다.** **Codex/TUI 재접속·회수·인계·Go 경계 회귀를 포함한다.** **WEB14는 합성 종단·전환 승인**이며, **실제 업로드·활성화는 별도 사용자 허용을 받은 후속 실행**이다. **승인은 "실제 자료 업로드 전/운영 전환 전/무료 한도 초과로 유료 전환 전" 경계**로 나누고 완료 뒤 소급 승인으로 쓰지 않음. 실제 이전 산출물·경로·수신자·백업·로그를 공개 저장소·CI artifact에 넣지 않음 |

PR 크기: WEB2·WEB7·WEB9·WEB10은 크다. 기존 구현 재사용과 새 변경을 구분해 단일 목적·외부 계약을 명시하고, **독립 배포물이 생길 때만** 이슈를 분할한다.

이슈 수: **5단계 신규 15개(WEB0~WEB14)**. 누적은 **`docs/plan/roadmap.md` 2절을 단일 기준**으로 참고한다. 이 문서와 이후 단계 문서는 누적 합계를 숫자로 다시 계산하지 않는다. 실제 잔여 수는 Linear 조회로 등록 직전에 확인한다.

## 5. 완료 기준

| 게이트 | 통과 조건 | 이슈 |
|---|---|---|
| 로컬 모드 | 미이전 프로젝트가 로컬 CLI·로컬 서버로 계속 동작하고, 웹 모드와 같은 계약 시험이 통과. 프로젝트별 원본 위치가 하나뿐 | WEB0·WEB9 |
| 플랫폼 | 운영이 **Cloudflare Free** staging/prod에 있고, 같은 마이그레이션이 로컬 SQLite·D1에서 통과. **100k 요청/일·10 ms CPU·D1 500 MB 하드 캡**, **R2 무료 포함량 10 GB 목표·초과 위험** 시험 통과. Vercel 의존 0 | WEB0·WEB1·WEB10 |
| 로그인 | owner/editor/reader 권한 표 전 항목 통과, 브라우저 step-up·복구·기기 로그아웃 시험 | WEB2·WEB3 |
| 키 | 발급·회수·교체·긴급 회수·감사가 시험되고, 원문이 로그·DB에 남지 않음 | WEB4 |
| 방식 A | 웹에서 만든 run을 로컬 runner가 실행해 PES 6단계 각 단계 1라운드 완주. 절전·단절·재접속·OFF·강제 종료 복구 | WEB6·WEB7 |
| 방식 B | Claude 앱 커스텀 커넥터, Claude Code·Codex CLI·OpenCode TUI의 HTTP MCP/기존 bridge가 합성 프로젝트에서 왕복. 승인 도구 없음 | WEB5 |
| 알림 | 적격 사건 enqueue·발송 시도 목표 충족, 푸시 도달, **내부 접수 중복 0, 외부 발송 결과·unknown 별도**, 조용한 시간, 실패·unknown 추적 | WEB8 |
| 이전 | 합성 프로젝트 이전·검증·재개·롤백 통과. 실제 1개는 사용자 승인 뒤 이전하고 활성화는 WEB10·WEB11·WEB14 뒤. **개발 완료(합성)와 실제 활성화(사용자 허용)를 구분하고, 실제 import가 공개 CI를 거치지 않음** | WEB9 |
| 백업 | **Time Travel 7일(Free)** + 야간 export로 RPO 24h·RTO 4h 훈련 통과, DB 경계+객체 hash 일치, **객체 1개 누락·삭제 복구·키 분리 복구**, **2^53 초과 정수 export→import→복원 동일성**, **R2 무료 포함량 10 GB 목표**, 백업 누락 경보, **실제 백업이 공개 CI를 거치지 않음** | WEB10 |
| 보안 | OWASP ASVS L1(판본 명시) 체크, 치명·높음 0, 공개 버킷·실키 0, Go 프록시 우회 0, **Free에서 쓸 수 있는 플랫폼 방어만 사용** | WEB11 |
| 비용 | **Workers/D1/Queues/Workflows Free 하드 캡**, **R2 무료 포함량 목표·초과 과금 위험 표시·차단/운영 중지 절차**, KV/DO(선택) 계측, 무료 한도 사용률 80% 경보·90% 완화 동작, 유료 기능 의존 0, A 상한 승계, **R2 실제 비용 노출 전 사용자 확인** | WEB12 |
| WebMCP | 날짜 있는 재검토 결정 기록이 있고, 미도입이면 capabilities에 미지원으로 표시 | WEB13 |
| 문서 | 사용자 안내(로그인·초대·키·runner·커넥터·이전·복구)와 운영 런북 | WEB14 |
| 승인 | 사용자가 "웹으로 옮겨도 된다"고 승인(운영 전환 승인). **실제 자료 업로드·활성화는 6절 3번의 별도 허용** | — |

## 6. 사용자 결정이 필요한 것 (비용·되돌리기 어려운 일만)

| # | 결정 | 선택지 | 추천 | 이유 |
|---|---|---|---|---|
| 1 | 연구 자료의 D1/R2 적재 위치·관할, 기관 자료 반출 규정 | 국내 보관 / 해외 Cloudflare / 프로젝트별 로컬 | **아시아 태평양 위치 힌트, 기관 규정 확인, 걸리면 로컬 유지** | SQLite/D1/R2는 1단계 합의 승계다. 실제 연구 자료가 해외 클라우드에 올라가는 것은 Go 전송 허용과 다른 동의이고, 올린 뒤엔 되돌리기 어렵다. **유료 계정·결제 주체는 여기서 묻지 않는다(9절).** |
| 2 | 도메인·DNS 관리 주체(메일 발신 하위 도메인 포함) | 새로 구매 / 보유 도메인 하위 | **보유 도메인의 `pes.<도메인>`, 관리 주체 명시** | 메일 발신·패스키 RP·OAuth redirect·쿠키·백업 문서가 모두 도메인에 묶인다. 나중에 바꾸면 재로그인·재설정 |
| 3 | 실제 프로젝트 웹 이전 범위 | 합성만 / 실제 1개 / 전체 | **실제 1개를 동결 후 시범 이전** | 웹 첫 쓰기 뒤에는 로컬로 무손실 복귀가 보장되지 않는다(`stage-1-db.md:132`). 구체적 slug·범위·복구 절차가 검토 가능한 시점(WEB9 활성화 직전)에 허용받는다 |
| 4 | 백업 보존 기간·위치(교차 계정 여부)·암호키 보관 | Time Travel만 / +R2 야간 / +교차 계정 | **+R2 야간(일 30·월 12), 가능하면 교차 계정, 키는 별도 보관** | 보존을 줄이면 이미 지난 자료를 되살릴 수 없다. **Free R2 10 GB를 객체와 백업이 나누므로 42개 백업 + 객체 ≤ 8 GB**를 확인하고, 넘으면 보존을 줄인다. **보존/주기 축소가 승인된 RPO·복원 지점 조건을 깨면 운영 변경으로 기록하고 사용자 확인을 받는다.** 대상 계정·포함 자료·복구/정리 조건·비용 산식을 함께 정한다. **2단계의 실제 자료 사용 허용 기록에 "웹 D1/R2" 목적지를 추가 동의로 묻는다.** |
| 5 | R2 활성화·결제 수단·초과 과금 | 결제 수단 없이 무료 구간만 / **무료 구간 + 필요 시 결제 수단 등록, 초과분은 사용자 승인 뒤** / R2 쓰지 않음 | **무료 구간 안에서 시작하되, 버킷 활성화에 결제 수단이 필요하면 여기서 확인**한다. 초과 위험이 보이면 업로드·백업을 멈추고 사용자 승인 뒤에만 과금한다 | R2는 무료 포함량 초과분이 종량 과금이며 플랫폼이 $0을 강제하지 않는다. 파일 원본·백업이 R2에 묶여 있어 결제 수단이 없으면 5단계 핵심 경로가 막힌다. 실제 비용 노출 전에 결정한다 |

**Cloudflare 유료 계정 개설·결제 주체·월 예산은 지금 결정하지 않는다.** 9절의 전환 신호가 나올 때 그 시점의 한도·비용과 함께 묻는다. 단 **R2 활성화에 결제 수단이 필요하면 5번에서 조건부로 확인**한다.

상시 VPS는 6절에서 빼고, **실제로 필요해질 때 월 비용·보관 범위·중단 방법과 함께 묻는다.**

라이브러리·runner 구현 방식은 구현자 몫이지만, **인증 RP/도메인·계정 복구 방식은 쉽게 되돌릴 수 없다.** WebMCP는 날짜 있는 기술 재검토로 다루고, 비용·실제 자료·계정 잠김 위험을 바꾸는 변경은 위 경계에서 다시 확인한다.

## 7. 다음 단계로 넘기는 것

- **6단계가 받는 것**: 여러 사람·여러 에이전트, `approver` 역할, 외부(Linear·Notion) 내보내기 영수증, `hwpx`, WebMCP 재검토 입력. `approver`·D1 350 MB 안전 신호/500 MB 하드 캡·프로젝트별 DB 분리·WebMCP 재평가는 확정 기능이 아니라 **후속 검토 입력**이다.
- **운영 백로그**: 조직 단위 권한·SSO, 여러 runner의 동시 실행·부하 분산, 감사 로그 내보내기, 모바일 앱·오프라인, 사용량 기반 과금. 6단계 범위 밖이며 필요해질 때 따로 판단한다.
- **값의 구분**: 토큰 30일 등 **기존 합의값은 승계**한다. 세션 14일/7일, step-up 5분, RPO 24h/RTO 4h, 알림 조용한 시간은 **5단계의 새 운영 초기값**이며 실제 사용 3개월 뒤 측정으로 조정한다.
- **탈출 조건**: 무료 한도 상시 초과(9절), D1 DB 500 MB 도달, 쓰기 경합으로 승인 5초 초과, Cloudflare의 SQLite 호환 변경 중 하나가 관측되면 `docs/plan/decisions/0005-web-platform.md`에 따라 Vercel+Turso 이전 또는 유료 전환을 재검토한다.
- **문서**: `docs/plan/decisions/0005-web-platform.md`, 5단계 운영 런북, 사용자 안내(로그인·초대·키·runner·커넥터·이전·복구). 실제 이전 기록은 공개 저장소가 아닌 승인된 비공개 위치에 둔다.

## 8. 근거

| 근거 | 사용한 곳 |
|---|---|
| `00-brief.md:17`(웹 PES·에이전트 API), `:31`(D1+R2 추천), `:37-38`(A·B 정의), `:50`(5단계) | 1·2.1·2.4·2.5절 |
| `stage-0.md:6`(상태 표기), `:20-34`(주제·결정 표), `:87-92`(사용자 결정), `:14`(원칙 0) | 머리·1·4·6절 |
| `stage-1-db.md:19`(여러 컴퓨터), `:20`(저장 위치), `:30`(인증 시점), `:121-124`(SQLite↔D1), `:132`(JSON→DB 복귀의 한계 — 웹 쓰기 뒤 SQLite 역이전이 영원히 불가하다는 증명은 아니다), `:142`(Go 외 전송 정책 이월), `:160-163`(넘기는 것), `:170`(D1 운영 미검증), `:174-199`(2단계 PR) | 1·2.1·2.3·2.7·2.12·4절 |
| `stage-1-api.md:16`(B가 OpenCode 세션/DTO에 의존하지 않음 — 웹이 모든 세션 참조를 모른다는 뜻은 아니다), `:18`(명령·멱등), `:21`(claim은 run 전이+lease의 원자 변경이며 롱폴 근거가 아니다), `:25`(사람만), `:26`(인증), `:38`(조회/쓰기 분리), `:42`(승인 역할), `:49-51`(A 접근), `:86-90`(Claude 앱), `:94-95`(MCP), `:99-103`(넘기는 것) | 2.2·2.4·2.5·4절 |
| `stage-1-ui.md:43`(전송 허용), `:44`(상태 분리), `:56`(서버 렌더), `:58`(U1 조건부 템플릿 공유 시험 — 5단계에서 함께 승계), `:61`(WebMCP), `:117`(5단계) | 2.1·2.2·2.10·4절 |
| `stage-1-runners.md:23-32`(A1~A10), `:39-41`(B2~B4), `:47-51`(lease·인계), `:62-66`(비용), `:70`(system actor), `:108`(원격 runner) | 2.3~2.5·3절 |
| `stage-1-ddl-draft.sql:12-18`(users), `:57-64`(project_members), `:66-77`(agent_tokens), `:220`(blob 상태 `quarantined`), `:823-858`(runs), `:872-887`(leases), `:903-928`(events) | 2.2~2.4·2.8절 |
| `research/webmcp.md:10-13`(표준·에이전트 현황, 2026-08 제3자 미확인 보고), `:30-43`(판단·재검토) | 2.10절 |
| Cloudflare Workers 한도(Free): `https://developers.cloudflare.com/workers/platform/limits/` — 100,000 요청/일, 10 ms CPU/호출, 128 MB, subrequest 50, Cron 5개/계정, 정적 자산 20,000/버전, 25 MiB/파일 (2026-11-05 확인, 문서 수정 2026-10-29) | 2.1.1·2.1.2·4·5절 |
| Cloudflare Workers 가격(Free): `https://developers.cloudflare.com/workers/platform/pricing/` — Workers·D1·R2·Queues·Workflows 무료 포함량, 정적 자산 요청 무료·무제한 표기 (2026-11-05 확인, 2026-10-02) | 2.1.1·2.6·2.9절 |
| Cloudflare D1 한도(Free): `https://developers.cloudflare.com/d1/platform/limits/` — DB 10개, DB당 500 MB, 계정 5 GB, 읽기 500만 행/일, 쓰기 10만 행/일, Time Travel 7일, 쿼리 50/호출, 2 MB 행, 100 KB SQL, 100 바인딩, 30초, 결과 50 MB (2026-11-05 확인, 2026-10-30) | 2.1.1·2.1.2·2.8·4·5절 |
| Cloudflare D1 가격(Free): `https://developers.cloudflare.com/d1/platform/pricing/` — 무료 읽기/쓰기/저장/DB 수, 초과 시 동작 (2026-11-05 확인, 2026-10-30) | 2.1.1·2.9절 |
| Cloudflare D1 import/export: `https://developers.cloudflare.com/d1/best-practices/import-export-data/` — export 중 요청 차단, int64 정밀도 손실. **5 GiB import는 미확인**(WEB9에서 확인) (2026-11-05 확인, 2026-04-21) | 2.7·2.8절 |
| Cloudflare R2 가격(Free): `https://developers.cloudflare.com/r2/pricing/` — 10 GB-month, Class A 100만/월, Class B 1,000만/월, egress 무료, Standard만 적용, **무료 포함량 초과분 종량 과금** (2026-11-05 확인, 2026-10-30) | 2.1.1·2.1.2·2.8·2.9절 |
| Cloudflare KV 한도: `https://developers.cloudflare.com/kv/platform/limits/` — Free 읽기 100,000/일, 쓰기 1,000/일, 저장 1 GB (2026-11-05 확인) | 2.1.1·2.1.2·2.5·2.9·WEB12 |
| Cloudflare Durable Objects 가격: `https://developers.cloudflare.com/durable-objects/platform/pricing/` — 요청·벽시계 실행량·저장 별도 계측, Free 포함량·과금은 WEB1 선택 전 확인 (2026-11-05 확인) | 2.1.1·2.1.2·2.4·2.9·WEB12 |
| Cloudflare R2 한도: `https://developers.cloudflare.com/r2/platform/limits/` — 객체 5 TiB, 단일 업로드 5 GiB, 버킷 기본 100,000 (2026-11-05 확인, 2026-10-30) | 2.1.1·2.8절 |
| Cloudflare Cron Triggers: `https://developers.cloudflare.com/workers/configuration/cron-triggers/` — Free 5개/계정, CPU 10 ms. **wall time 15분은 미확인**(Free 수치 없음) (2026-11-05 확인, 2026-10-17) | 2.1.1·2.8절 |
| Cloudflare Python Workers: `https://developers.cloudflare.com/workers/languages/python/` — Free 포함 여부 명시 없음(**미확인**) (2026-11-05 확인, 2026-09-17) | 2.1·WEB0 |
| Cloudflare Bot 상품: `https://developers.cloudflare.com/bots/`, `https://developers.cloudflare.com/bots/get-started/bot-management/` (2026-11-05 확인) — Bot Management는 Enterprise 유료, Free에서는 사용하지 않음 | 2.11·4절 |
| Vercel 가격: `https://vercel.com/pricing`; Neon 가격: `https://neon.com/pricing` (2026-11-05 확인) | 2.1절 |
| Claude 원격 MCP 커스텀 커넥터: `support.claude.com/en/articles/11175166` (2026-11-05 확인) | 2.5절 |
| iOS Web Push 홈 화면 요구: `webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/` (2026-11-05 확인) | 2.6절 |
| 실제 이전 manifest·경로·수신자·백업·로그는 공개 저장소·CI artifact에 두지 않는다 | 2.7·4·7절 |

## 9. 나중 — 무료 한도를 넘을 때

지금은 무료 요금제로 설계하고, **유료 계정·결제 주체·월 예산은 이 절의 신호가 나올 때만 결정**한다. 신호 없이 미리 유료로 올리지 않는다.

### 9.1 전환 신호

| 자원 | 신호(중 하나가 반복·지속) | 지금 할 일 |
|---|---|---|
| Workers 요청 | 80,000/일 초과가 3일 연속, 또는 1027 발생 | 폴링 간격 확대·캐시·정적 자산 분리로 먼저 줄인다 |
| Workers CPU | p95가 10 ms에 붙고 1102(`exceededCpu`)가 반복 | 경량 경로로 분리해도 해결되지 않으면 전환 |
| D1 읽기 | 400만 행/일 초과가 3일 연속, 또는 전체 스캔이 반복 | 인덱스·페이지·아카이브로 먼저 줄인다 |
| D1 쓰기 | 80,000행/일 초과, 또는 event 로그가 저장을 압박 | event 보존·요약·아카이브로 먼저 줄인다 |
| D1 저장 | 계정 4 GB, DB 400 MB, DB 10개 중 하나에 근접 | 아카이브·유료 전환 검토. 프로젝트별 DB 분리는 후속 검토 |
| R2 저장 | 객체+백업 8 GB 초과 | 수명주기·중복 제거·보존 축소, 그래도 부족하면 전환 |
| R2 작업 | Class A 80만/월, Class B 800만/월 초과 | 멀티파트·목록 호출·불필요한 읽기 줄이기 |
| KV | 읽기 80,000/일·쓰기 800/일 초과, 또는 저장 800 MB 근접 | 캐시·jti 저장 축소, 필요하면 전환 |
| DO (선택) | 요청·벽시계 실행량·저장이 Free 포함량에 근접 | long poll을 짧은 폴+ETag/SSE로 바꾸거나 전환 |
| Queues | 8,000 ops/일 초과, 또는 24시간 넘는 재시도 필요 | 묶음·재시도 정책 조정, 필요하면 전환 |
| Workflows | 2,500 step/일 초과 | 합성 검증은 CI batch, 실제 import는 허용된 로컬·비공개 batch로 대체. 필요하면 전환 |
| Cron | 5개 초과가 필요 | dispatcher 하나로 합친다. 그래도 필요하면 전환 |
| 인증·SSR | 로그인·렌더가 10 ms를 상시 초과 | 경량 세션·정적 조각으로 줄인다. 그래도 안 되면 전환 |
| 사용자·프로젝트 | 사용자 2명 이상, 활성 프로젝트 4개 이상, 또는 하루 요청 8만 건 접근 | 사용량을 2주 실측한 뒤 전환 여부를 판단 |

### 9.2 그때 바꿀 것만

- **Workers Paid $5/월**: 요청 1,000만/월 포함, CPU 3,000만 ms/월 포함, 요청당 CPU 기본 30초·최대 5분, subrequest 10,000, Cron 250개. Free의 100k/일·10 ms·5개 제한이 사라진다.
- **D1 Paid**: DB당 10 GB, DB 100,000개 포함(최대 1,000,000개), 읽기 250억 행/월·쓰기 5,000만 행/월 포함, Time Travel 30일. Free의 500 MB·10개·일일 행 한도가 풀린다.
- **R2 Paid**: 무료 10 GB를 넘는 저장 $0.015/GB-month, Class A $4.50/백만, Class B $0.36/백만. egress는 그대로 무료다.
- **Queues Paid**(필요 시): 100만 ops/월 포함, 보존 4~14일(**미확인**, 전환 시 재확인). **Workflows Paid**(필요 시): 요청 1,000만/월, step 50만/월 포함(**미확인**, 전환 시 재확인).
- **결제 주체·월 예산**: 위 항목 중 실제로 넘은 것만 골라 견적을 내고, 사용자가 승인한 뒤 계정을 올린다. 전환 뒤에도 A 실행 상한은 2단계 결정을 승계한다.

바꾸지 않는 것: 로컬 runner 기본, 프로젝트별 원본 위치, 코어 언어 결정, 로그인·권한 설계, 도메인, 데이터 모델. **요금제만 바꾸고 업무 의미·계약은 바꾸지 않는다.**

전환 결정은 `docs/plan/decisions/0005-web-platform.md`에 **측정값·비용·승인일**과 함께 남긴다. 유료 계정·결제 주체는 이 절에서 처음 묻는다.
