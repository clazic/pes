# 0005. 5단계 웹 플랫폼은 후보 3군을 WEB0에서 비교한다

- 날짜: 2026-11-05 (같은 날 3·6·7·8차 정정)
- 담당: 5단계 WEB0·WEB1, `stage-5.md`

## 문제

5단계에서 로컬 PES를 공개 HTTPS 웹으로 옮긴다. 1단계 DB는 SQLite와 D1/R2를 전제로 했지만, 어느 플랫폼을 어떤 요금제로 설계할지는 정해야 한다. 처음부터 유료를 전제로 하면 비용 승인 없이 설계가 앞서고, 플랫폼을 미루면 WEB0·WEB1이 결정을 못 한다. PES는 **비상업 용도**다.

## 선택지

1. Cloudflare Workers·D1·R2 무료 요금제를 기본으로 한다.
2. Vercel Hobby + Turso/Blob을 동등 후보로 둔다.
3. 작은 VPS(Oracle Always Free→Hetzner, 월 총액은 WEB0 견적)를 후보로 둔다.
4. 지금 하나를 확정한다.

## 채택

**1·2·3을 후보 3군으로 두고 WEB0에서 같은 기준으로 실측한 뒤 고른다.** 기본 후보는 Cloudflare 무료, 동등 후보는 Vercel Hobby+Turso, TS 실행성·실시간 통로가 막히면 작은 VPS다. 최종 결정 전에는 Cloudflare 무료를 기준선으로 설계한다.

- **Vercel Hobby**: 함수 300초, Active CPU 월 4시간(I/O 대기 제외), 메모리 2GB, **TS/Node 주 경로**, Hobby의 **개인·비상업 제약은 PES가 비상업이라 충족하는 것으로 보나, 실제 배포 주체의 personal 조건은 WEB0에서 확인**한다. DB는 Turso(libSQL·SQLite 호환, 무료 한도 미확인) 또는 Neon Postgres(비SQLite), 파일은 Vercel Blob(한도 미확인). 긴 작업 이어가기(호출 체인·cron·큐) 한도는 미확인이다.
- **작은 VPS**: Oracle Always Free 공식 수치(2026-11-05) **1,500 OCPU-h·9,000 GB-h/월 = 상시 2 OCPU·12GB**. 7일 CPU p95·네트워크·A1 메모리 각각 **20% 미만**이면 회수 대상이고 지역 재고·계정별 할당·카드 등록은 WEB0에서 확인한다. Hetzner CX22 €4~5는 2차 자료이며 지역·세금·IPv4·백업·트래픽 포함 **월 총액은 미확인/WEB0 견적**이다. TS/Node/Bun 코어·SQLite 파일·웹소켓·긴 루프를 그대로 실행한다. 운영 부담은 컨테이너 1개+자동 업데이트+Cloudflare Tunnel+기존 백업으로 줄인다.
- **Cloudflare**: Workflows step CPU 10ms·step 1,024·**subrequest는 instance당 50**, D1/R2/DO. step 추가와 instance 교체를 구분하고, instance 교체가 Go 사용량·unknown·외부 호출 멱등을 초기화하지 않게 한다. DO의 incoming WebSocket **20:1은 과금 계산용**이고 메트릭은 실제 메시지 수다.
- **Vercel**: Hobby 함수 300초·Active CPU 4 CPU-h/월·메모리 2GB. **현재 문서 기준 모든 플랜에서 WebSocket을 제공하고 최대 함수 시간 뒤 연결이 종료**된다. ‘공개 베타’ 문구는 현재 문서·배포 계정으로 갱신한다.
- **WEB0 판정 기준**: ① A 한 라운드 ② TS 단일 코어 재사용(Node/Bun/Deno 실행성) ③ SQLite 계약 ④ 월 사용량 여유 ⑤ 카드 등록 ⑥ 상시 양방향 통로 ⑦ 운영 부담 ⑧ 월 비용 ⑨ **A의 HWPX를 사용자 PC 없이 처리하는 경로**.
- **추천 문장**: 무료로 다 되면 Cloudflare, TS 실행성·실시간 통로가 막히면 작은 VPS(월 총액은 WEB0 견적), Vercel은 중간 대안.
- **공통 계약과 기준 구현**: 명령·SQLite·백업·실시간 계약은 후보 공통이고, WEB1~14의 D1/R2/Workflows/10ms/Free 조건은 Cloudflare 기준 구현이다. WEB0 뒤 선택한 후보에 맞춰 부품을 구체화하며, 유료 안은 비용 승인 뒤 그 예산으로 시험한다.
- **원칙**: 엮더라도 **자료 원본은 한 곳**, 다른 곳은 계산·캐시·백업만. 같은 API·SQLite 스키마·백업 형식으로 부품을 교체한다. 대표 조합은 X(Cloudflare 중심+계산 보조), Y(VPS 중심+Cloudflare 앞단), Z(Vercel+외부 무료)다. 추천 초안은 **X**.

## 이유

- 무료/저비용 후보가 여러 개이고, 각 후보의 한도·운영 부담·자료 위치가 다르다. 하나를 미리 확정하면 WEB0 실측 전에 틀린 전제를 굳힌다.
- PES는 비상업이므로 Vercel Hobby를 탈출 대안이 아니라 동등 후보로 올릴 수 있다. 단 **실제 배포 주체의 personal 조건은 WEB0에서 확인**한다.
- VPS는 CPU 10ms·300초 같은 한도가 없어 A 긴 루프·웹소켓에 유리하지만 운영 부담·월 비용이 있다. WEB0에서 비교해야 한다.

## 영향

- `stage-5.md` 2.1·2.4·6절, WEB0·WEB1·WEB12. WEB1은 측정값·결정을 이 기록에 보태고, 플랫폼을 바꾸면 새 결정 번호를 쓴다.
- `roadmap.md`·`summary-for-approval.md`의 플랫폼 문장, 6단계의 VPS/호스팅 항목.
- 월 비용이 생기는 안은 기존 '유료 전환' 결정과 합쳐 사용자 승인을 받는다.
- 자료 원본 한 곳·SQLite 계약·백업 형식을 유지해 후보를 갈아탈 수 있게 한다.

## 재검토 조건

- WEB0에서 한 후보가 9개 기준을 크게 이기거나, 모든 후보가 A 한 라운드를 무료/저비용으로 못 돌릴 때.
- 무료 조건·가격·TS 실행성·웹소켓 지원이 바뀔 때.
- Oracle Always Free 회수, Hetzner 가격 인상, Vercel Hobby 약관 변경.
- `stage-5.md` 9절의 유료 전환 신호가 날 때.

## WEB0 로컬 시험 결과 (2026-11-05)

`spikes/web0/`에서 같은 TS 코어로 A 한 라운드를 후보별 로컬 대리에서 실행했다. 계정·배포·유료 호출은 하지 않았다. 값은 **판정 아님 — 스모크/대리값**이다.

| 후보(로컬 대리) | 3회 벽시계 중앙값 | 프로세스 CPU 중앙값 | RSS 중앙값 | 신규 행 / 전체 변경 행 / 쓰기 문 | subrequest | 10회 연속 오류 |
|---|---:|---:|---:|---:|---:|---:|
| CF: `wrangler dev --local` + 로컬 D1 | 695.55 ms | 110.00 ms | 528.47 MB | 53 / 85 / 105 | 3 | 0 |
| VC: Vercel형 Node 핸들러 + 로컬 SQLite | 642.05 ms | 40.00 ms | 107.97 MB | 53 / 85 / 105 | 3 | 0 |
| VPS: Node 26 + `node:sqlite` | 625.59 ms | 24.68 ms | 63.32 MB | 53 / 85 / 105 | 3 | 0 |

- **계약**: 38/38 fixture parse/validate, 7개 필수 경로 normal/error/replay 실행, SQLite·로컬 D1 계약 16 pass + 1 info, 미지원 SQL 0, 61표. CF D1에서 deferred FK 누락 거부가 `internal error; reference=…`로 반환되고 원시 INTEGER `number` 읽기가 정밀도를 잃는 것을 확인했다(어댑터는 `CAST AS TEXT` 사용).
- **런타임**: Node 26.13.0·Bun 1.4.4·Deno 2.9.6이 같은 코어 A 라운드를 실행했다(0016).
- **CF CPU 10 ms/호출, Vercel Active CPU, DO/WebSocket, R2/Blob, 실제 요청·과금은 측정하지 않았다.** `wrangler dev` 로컬 CPU는 요청당 CPU가 아니고, 프로세스 RSS는 Worker 128 MB 한도와 비교할 수 없다.
- **계정·카드·비용**: Cloudflare/Vercel/Oracle/Hetzner 계정을 만들지 않았다. 카드 필요 여부, Turso/Blob 한도, Oracle 지역·할당, Hetzner 월 총액은 **사용자 결정 필요**다.
- **시간 상자 밖**: 8시간 soak, 7일 VPS soak, 4주 운영 일지, WebSocket/SSE 8시간, 월 30일 실제 투영은 미측정이다.
- **A HWPX 최소 경로**: 합성 report.md→report.hwpx를 순수 TS + fflate로 만들었다. Node 1.61 ms/5.55 ms CPU/3,061 B, 로컬 workerd 2.58 ms/표본 하한 0 ms CPU/3,061 B로 **같은 sha256**, 브라우저 번들 26,625 B 통과. 한글에서 실제 열기·서식 충실도·hwpx-uri 대비 차이는 **사용자 확인 필요**다.

**이 결과로 플랫폼을 확정하지 않는다.** 로컬 시험은 G1·G2·G3의 로컬 부분만 확인했고, G4~G8은 계정·카드·비용·시간 상자 때문에 미측정이다. 유료 후보를 1순위로 올리지 않는다.

## 상태

**채택 — 후보 3군 WEB0 로컬 시험 완료. 최종 플랫폼 판정은 계정·카드·비용 사용자 결정 뒤 보류** (2026-11-05). 기본 후보 Cloudflare는 유지하되, 이는 최종 선택이 아니다.
