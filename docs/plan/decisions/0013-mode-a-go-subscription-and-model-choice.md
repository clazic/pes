# 0013. 방식 A는 PES가 OpenCode Go API를 직접 호출하고 모델은 사용자가 고른다

- 날짜: 2026-11-05 (같은 날 사용자 정의 정정)
- 담당: 2단계 PR19, SEL-18

## 문제

방식 A의 정의를 다시 정해야 한다. A는 **사람이 웹 PES 대시보드에서 프로젝트 생성부터 작업까지 하고, 사람의 컴퓨터 연결 없이 PES 자체가 OpenCode Go API를 직접 호출해 AI 모델과 작업하는 방식**이다. 2단계 로컬 모드에서도 로컬 PES가 같은 방식으로 Go API를 직접 호출한다.

따라서 (1) opencode 프로그램(serve·CLI)과 로컬 runner를 A에서 빼고, (2) PES가 에이전트 루프와 업무 도구를 직접 가지며, (3) 추가 요금 없이 Go 구독 사용량 안에서 멈추고, (4) 모델을 어떻게 고를지 정해야 한다. 1차 수정의 "opencode serve 경유만, 직접 HTTP 금지"는 이 정의와 반대이므로 폐기한다.

## 선택지

1. opencode serve를 로컬에서 띄워 A를 실행한다.
2. **PES가 Go HTTP API를 직접 호출하고, PES가 에이전트 루프·업무 도구·사용량 보호를 직접 맡는다.**
3. 여러 provider·API 키를 허용하고 run마다 과금 경로를 고른다.

## 채택

**2번.**

### 실행 경로

- PES가 **OpenCode Go HTTP API를 직접 호출**한다. **2026-11-05 공식 문서**([Inference API](https://opencode.ai/v2/docs/console/api/inference/))는 API 계열별 `/inference/openai/...`·`/inference/anthropic/...`·`/inference/google/...`, 모델 목록 `/inference/v1/models`를 안내한다. 기존 `/inference/go/...`·`/inference/go/v1/models`는 **확인 전 후보**로만 둔다. **PR19에서 실제 호출로 주소·원시 model ID↔PES 내부 ID 매핑·구독 적용 조건(어느 API 계열/모델이 Go 구독 사용량에 포함되는지)을 검증해 고정**한다. 모델별 요청 형식은 검증된 메타데이터에 맞춘다.
- opencode 프로그램(serve·CLI)과 로컬 runner를 A에 두지 않는다. 2단계 로컬 PES와 5단계 웹 PES가 **같은 Go 호출 계약**을 쓴다.
- Go는 코딩 에이전트용이고 남용 감시가 있다. PES 고유 **user agent**와 대화별로 안정적인 **`x-opencode-session`** 헤더를 보낸다. PES의 사용이 Go 이용 조건에 맞는지는 **확인 필요** 위험으로 남긴다.
- 키 보관: 로컬은 **OS 키체인**, 웹은 **Cloudflare Worker secret**. 키를 로그·프롬프트·응답·오류 메시지에 넣지 않는다.

### 호출 시도·멱등

- **`x-opencode-session`은 라우팅·캐시용 식별자이지 외부 멱등 보장이 아니다.** 같은 헤더를 보냈다는 이유로 중복 호출이 막힌다고 가정하지 않는다.
- Go 호출 **전에** 영속 attempt/상관키를 만들고 `prepared → sent → response → adopted`(실패 시 `unknown`)를 남긴다. 응답 유실·타임아웃·DB 저장 실패는 **unknown**으로 보존하며 **자동 재호출하지 않는다**. 사람이 확인·정산한 뒤 새 시도로만 진행한다.
- **모델 호출 재시도와 로컬 결과 저장 재시도를 분리**한다. 저장 재시도는 이미 받은 응답을 다시 저장할 뿐 Go 모델을 다시 호출하지 않는다. Workflow/큐가 같은 step을 재시도해도 호출 횟수가 늘지 않아야 한다.
- 가짜 Go 서버로 **호출 횟수·예약·unknown**을 시험한다. 같은 결과를 저장하려다 실패한 경우 Go 호출 1회, 저장 재시도 N회여야 한다.

### PES 내장 에이전트 루프

- PES가 **맥락 조립 → 모델 호출 → 구조화 결과(JSON) 검증 → 기존 업무 명령으로 저장 → 사람 질문(`waiting_human`) → 답이 와도 C4/R1 준비·정책·새 claim 검사를 거쳐 사람이 재개**하는 루프를 직접 돈다. 응답 도착만으로 자동 진행하지 않는다.
- 모델에 주는 도구는 **아래 PES 명령 allowlist만**이다. 파일시스템·셸·임의 네트워크 도구는 없다.
  - `context.get` — 맥락·정확한 버전 읽기(공통)
  - `result.submit` — 결과물 제출(공통)
  - `question.ask` — 사람에게 질문(공통)
  - `assumption.propose` — 가정 제안(U3)
  - `decision.propose` — 결정 제안(U3). stage-5의 `pes_decision`·stage-3의 A 결정 제안과 같은 명령이며, **사람만 결정을 채택**한다.
  - `reflection.write` — 반영 내역 작성(U3)
  - `thread.reply` — 첨언 스레드 답글(U4)
  - `followup.propose` — `edit_text`·`next_round_task` 제안(U4)
  - 위 명령은 모두 기존 명령 서비스·권한 검사를 지나며, 새 도구를 무제한 허용하지 않는다. **A/B 합성 U3 시험**에서 A는 `decision.propose`, B는 `decision:propose`/MCP `pes_decision`으로 같은 제안을 만들고, 채택은 사람만 한다.
- 도구 호출·결과 저장은 모두 기존 명령 서비스와 권한 검사를 지난다. 모델이 상태를 직접 쓰지 않는다.
- 조사 단계의 웹 검색: Go 모델 자체에는 검색이 없다. 선택지는 (a) 무료 검색 API 연결, (b) 조사 단계만 방식 B, (c) 사람이 자료를 첨부하는 것이다. **추천은 (c)로 시작하고, 필요할 때 (a)를 별도 결정으로 검토**한다. 검색 결과는 출처·버전과 함께 저장한다.

### Go 사용량 보호

- 직접 호출에서는 **사용량 조회 공식 API가 미확인**이다. `/zen/go/v1/usage`는 비공개 관례라는 2차 자료뿐이므로 설계 근거로 쓰지 않는다. **PR19에서 공식 사용량 API·응답 필드를 확인**하고, 없으면 아래 수동 확인 경로를 쓴다.
- **시작 전 Extra Usage OFF 확인**: 새 유료 호출 전에 콘솔/계정에서 Extra Usage가 꺼져 있음을 **확인 시각·계정 범위·유효 기간**과 함께 로컬 정책 기록에 남긴다. 공식 문서: [Go 사용량·Extra Usage](https://opencode.ai/v2/docs/console/go/). 화면 캡처·계정 식별자는 공개 저장소에 넣지 않는다. API로 확인할 수 없거나 확인이 오래돼 유효 기간이 지났으면 **새 호출을 차단**한다(fail-closed). 수동 확인 경로는 "사용자가 콘솔에서 OFF를 확인하고 PES에 확인 시각을 입력"이며, 확인 없음은 허용이 아니다.
- 그래서 다음 순서로 막는다.
  1. **계정/워크스페이스 단위 사용률 기준점**을 확인한다. PES 호출 토큰 추정만으로 같은 계정의 다른 앱 사용량을 알 수 없으므로, 외부 사용량을 모르면 **0으로 두지 않고** 차단하거나 추가 확인을 요구한다.
  2. 응답이 **한도 초과 오류(막힘)** 이면 즉시 멈추고 `resetsAt`을 표시한다. `resetsAt`이 없으면 "재개 시각 미확인"으로 표시한다.
  3. PES가 **호출별 토큰을 집계**해 Go 월·주·5시간 한도(월 금액의 100%·50%·20%) 대비 **추정 사용률**을 계산하고, 문턱(기본 90%)에서 새 호출을 중단한다. 확인된 allowance·모델 가중치가 있으면 우선한다.
  4. **다음 호출 상한 예약**: 호출 전 최대 출력 토큰·모델 가중치로 예약하고 호출 뒤 정산한다. 병렬 호출·재시도·reviewer·인계·재시작이 예약을 초기화하지 않게 누적한다. 송신·과금 결과가 unknown인 예약은 자동 해제하지 않는다.
  5. 사용량 API가 확인되면 그것을 우선한다.
- 문턱을 넘거나 unknown이면 새 run·재시도·reviewer run을 시작하지 않는다. 진행 중 run은 **`runs.status='blocked_usage'` + `go_block_reason`·`go_blocked_at`·`go_block_reset_at`**으로 멈추고, **lease를 해제**하며, `resetsAt`/차단 사유/재개 주체를 남긴다. **`waiting_human`은 질문·입력 대기 의미로 유지하고 사용량 차단에 쓰지 않는다.** 열·CHECK는 DDL 묶음이 정한 이름을 그대로 쓴다. 응답 도착만으로 자동 진행하지 않고 C4/R1과 같은 준비·정책·새 claim 검사를 거쳐 **사람이 재개**한다.
- **Extra Usage는 끄도록 안내**한다. 응답에 과금 표시가 있거나 세션 비용이 0이 아니면 즉시 멈추고 사용자에게 알린다. **`cost=0`만으로 Go 구독이라고 판단하지 않는다.** `billing_source`·`allowance`·오류/스트림 필드 누락도 시험하고, 판단 근거를 기록한다.
- 토큰·턴·시간 상한은 **폭주 방지**용으로 유지한다. 별도 금액 상한을 새로 만들지 않는다.

### 모델 선택·폴백

- 기본값 `opencode-go/deepseek-v4.1-flash`. 프로젝트 설정(소유자만, 불변 이력 = `project_policy_versions` 계열)과 run 시작 시 선택한다.
- 고를 수 있는 목록은 **PR19에서 검증해 고정할 모델 목록 경로**(공식 문서의 `/inference/v1/models`, 기존 `/inference/go/v1/models`는 후보)의 `opencode-go/*` 중 active인 것이다. 원시 model ID와 PES 내부 ID의 매핑을 기록한다. provider는 `opencode-go`로 고정하고 다른 provider·API 키 과금 경로는 금지한다.
- **폴백 없음**: run 하나는 시작 때 정한 모델 하나로만 간다(내부 요약·제목·reviewer 포함). 실패해도 자동으로 다른 모델로 바꾸지 않는다. 바꾸려면 사용자가 새 run에서 고른다. `runs.model`에 실제 모델 ID를 기록한다.

### 자료 전송 스위치

- A는 **모든 호출을 PES가 하므로 호출마다** 현재 Go 전송 정책을 검사한다. 이는 가장 확실한 차단 지점이다.
- OFF 프로젝트는 A를 할 수 없고, B 또는 사람 작업으로 간다. 이미 보낸 자료의 회수를 보장하지 않는다.

### 5단계 웹 실행

- A의 실행 위치는 **WEB0에서 고른 플랫폼**을 따른다. 로컬 runner는 없다.
- **Cloudflare(기본 후보)**: Workers + Workflows. 모델 호출 1회=step 1개, step CPU 10ms·step 1,024·동시 100·3일 보존·상태 100MB, Workers 100k/일. **subrequest 50은 step이 아니라 Workflow instance당**이며, 새 step으로 예산이 초기화되지 않는다. instance를 새로 만들어도 **Go 사용량·unknown·외부 호출 멱등·attempt 상관키를 초기화하지 않는다.** instance chain 생성 시점·총 subrequest·새 claim/fence·응답 유실 복구를 정하고 시험한다. 무거운 렌더링은 step 밖.
- **Vercel**: 함수 300초·Active CPU 월 4시간. 모델 호출을 함수/호출 체인으로 나누고, 긴 대기는 cron·큐·재호출로 잇는다(한도 미확인).
- **작은 VPS**: Node/Bun으로 같은 TS 루프를 상시 실행한다. CPU 10ms·300초 한도가 없고, SQLite 파일·웹소켓을 그대로 쓴다.
- **WEB0에서 TS 코드가 후보에서 도는지, A 한 라운드가 무료/저비용 한도 안에서 되는지 실측**한다. Cloudflare면 10ms 안 응답 검증·저장, VPS면 상시 루프·운영 부담, Vercel이면 300초·외부 DB를 본다.
- 플랫폼 후보 비교와 최종 선택은 `stage-5.md` 2.1·2.4와 `0005-web-platform.md`에 둔다. **추천은 무료로 다 되면 Cloudflare, TS 실행성·실시간 통로가 막히면 작은 VPS, Vercel은 중간 대안**이다.

### HWPX 최종 변환

- A는 **사람 PC 상주·연결 없이** 끝나야 한다. HWPX 최종 변환은 **서버측 변환 작업자(Workflows/Container)** 또는 **브라우저 변환**을 우선하고, 로컬 `hwpx-uri` 명령은 보조 경로로만 둔다. 외부 변환기는 도구 경계로 두고 PES의 TS 단일 언어를 유지한다.
- 두 경로 모두 불가능하면 **A의 HWPX 지원 범위를 사용자 결정으로 올린다.** 로컬 명령만 가능한 상태를 A 완료로 표시하지 않는다(`stage-6.md` X1).

## 이유

- 사용자가 웹에서 프로젝트를 만들고 작업하는데 자기 컴퓨터가 켜져 있어야 하는 구조는 A의 정의와 맞지 않는다. PES가 직접 호출하면 웹에서 끝까지 동작한다.
- opencode 프로세스·프로필·세션·권한 중계를 없애면 장애 지점과 시험 범위가 줄고, 2단계 로컬과 5단계 웹이 같은 호출 계약을 쓴다.
- PES가 도구를 PES 명령으로 제한하면 파일·셸 권한 문제를 만들지 않고, 기존 업무 명령·권한·감사를 그대로 쓴다.
- 사용량 API가 확인되지 않은 상태에서 한도 오류·토큰 추정·과금 표시를 함께 쓰는 것이 추가 과금을 막는 현실적인 방법이다.

## 영향

- DDL: `runs`의 A 모델 CHECK를 `model LIKE 'opencode-go/%'`로 넓히고, `project_policy_versions`에 `mode_a_model`·`go_usage_stop_percent`를 둔다. A의 `runs.runtime`은 `pes_builtin`이다.
- `stage-1-runners.md` A1~A7·D4·7절, `stage-1-db.md` A/B 표, `stage-2.md` PR19, `stage-5.md` 2.4·비교표·WEB6·WEB7.
- 2단계 PR19는 "PES 내장 A 실행기"로 바뀐다. opencode 2.2.5 고정·전용 프로필·프로세스 회수·권한 중계 항목은 삭제한다.
- SEL-18의 opencode serve 시험은 **Go 구독 cost=0 확인 근거로만** 남기고 설계 근거에서 뺀다.
- 0001·0002의 A 표현을 이 정의로 갱신한다.
- 5단계 WEB6·WEB7은 로컬 runner·opencode supervisor가 아니라 **웹 A 실행기(Workflows)**와 **A 에이전트 루프·도구·사용량**을 맡는다.

## 재검토 조건

- Go HTTP API의 엔드포인트·요청 형식·모델 목록·한도 오류 형식이 바뀔 때.
- 사용량 조회 공식 API가 확인될 때(그때는 2번 추정보다 우선).
- PES의 사용이 Go 이용 조건·남용 감시에 맞지 않는다고 확인될 때.
- 조사 단계 검색을 무료 검색 API로 붙이기로 할 때.
- Cloudflare Workflows의 Free 한도·step CPU 제약이 설계를 감당하지 못할 때.

## 상태

**채택** (2026-11-05, 사용자 정의 정정). 1차 수정의 `opencode serve` 경유·직접 HTTP 금지 문구를 대체한다.
