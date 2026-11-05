# 1단계 ④ 방식 A·B 실행 구조 설계서

- 작성: 2026-11-04, Claude 종합. Linear: SEL-24
- 입력: [stage-1-runners-codex.md](discussion/stage-1-runners-codex.md), [stage-1-runners-opencode.md](discussion/stage-1-runners-opencode.md), Claude 추천안 [stage-1-runners-claude-recs.md](discussion/stage-1-runners-claude-recs.md), Codex 검수 [stage-1-runners-codex-review.md](discussion/stage-1-runners-codex-review.md)(동의 11·수정 17·반대 0), 합의 [stage-1-db.md](stage-1-db.md)·[stage-1-api.md](stage-1-api.md)
- 상태: **1단계 확정 문서를 사용자 정의 정정으로 개정(2026-11-05).** **합의안(Claude·Codex)** — Codex 최종 대조 [stage-1-runners-final-check.md](discussion/stage-1-runners-final-check.md) 지적 6건 반영. **A는 PES가 Go API를 직접 호출하는 내장 실행기**이고, Go 사용량 멈춤 문턱(기본 90%)·기본 모델은 추천값 그대로면 다시 묻지 않는다(7절, 결정 0013).

## 1. 목표

방식 A(PES 내장 실행기가 Go API를 직접 호출)와 방식 B(Claude Code·Claude 앱·Codex CLI·OpenCode TUI·Codex 앱·OpenCode 앱)가 **같은 PES 코어와 같은 API**로 일하게 하는 실행 구조를 정한다.

## 2. 하나의 코어, 두 어댑터

| 누가 | 맡는 일 | 하지 않는 일 |
|---|---|---|
| PES 코어 | 상태·검증·채택·기록 | 추론 |
| 에이전트 | 조사·집필·검토 | 상태를 직접 쓰기 |
| 어댑터 | 실행 시작·중단·관측, 권한 중계, 모델·세션 관리 | 상태·연구 결과를 임의 생성하거나 직접 저장. **A의 업무 제출은 PES 내장 실행기의 검증된 명령 호출로**, 실행 제어·관측 기록은 검증 명령으로 |

## 3. 방식 A — PES 내장 실행기(Go API 직접 호출)

| # | 결정 |
|---|---|
| A1 | **PES가 OpenCode Go HTTP API를 직접 호출한다.** 2026-11-05 공식 문서([Inference API](https://opencode.ai/v2/docs/console/api/inference/))는 API 계열별 `/inference/openai/...`·`/inference/anthropic/...`·`/inference/google/...`, 모델 목록 `/inference/v1/models`를 안내한다. 기존 `/inference/go/...`·`/inference/go/v1/models`는 **후보**이며 **PR19에서 실제 호출로 주소·원시 model ID↔내부 ID·구독 적용 조건을 검증해 고정**한다. 모델별 요청 형식은 검증된 메타데이터에 맞춘다. **opencode serve·CLI·로컬 runner를 두지 않는다.** PES 고유 user agent와 대화별 안정적인 `x-opencode-session`은 **라우팅·캐시용**이며 멱등 보장이 아니다 |
| A2 | **시작 순서: 첫 모델 호출·연구 자료 전송 전에 run·claim·현재 Go 정책·Go 사용량 기준점/추정·Extra Usage OFF 확인 증거·키 존재 확인.** 확인 불가·증거 만료면 차단. 최초 claim 주체는 하나로(내장 실행기 선행 claim) — 중복 claim·소유자 없는 Go 실행 금지. Go 키는 로컬 OS 키체인, 웹 Worker secret에서 읽고 로그·프롬프트에 넣지 않음 |
| A3 | **PES가 에이전트 루프를 직접 소유한다**: 맥락 조립 → 모델 호출 → 구조화 결과(JSON) 검증 → 기존 업무 명령으로 저장 → 사람 질문(`waiting_human`) → 답이 와도 **C4/R1 준비·정책·새 claim 검사를 거쳐 사람이 재개**하며 자동 진행하지 않음. run당 활성 루프 하나, 단계 상태를 DB에 남겨 재시작 뒤 이어 감. 프로세스·세션 회수는 없고, 같은 호출의 중복 제출은 PES 멱등 키로 막음 |
| A4 | **모델에 주는 도구는 0013의 PES 명령 allowlist만**: `context.get`·`result.submit`·`question.ask`(공통), `assumption.propose`·`decision.propose`·`reflection.write`(U3), `thread.reply`·`followup.propose`(U4). `decision.propose`는 stage-5 `pes_decision`·stage-3 A 결정 제안과 같은 명령이며 **사람만 채택**한다. **파일시스템·셸·임의 네트워크 도구 없음.** 연구 자료·외부 글은 데이터이지 지시가 아니며, 프롬프트 안의 실행 요구를 따르지 않음. 결과는 스키마 검증을 통과해야 저장 |
| A5 | 맥락은 DB·객체 저장소의 **정확한 버전**으로 조립한다. 첨부는 blob 참조·크기 제한·형식 검사를 거치고, 모델 응답에 원본 경로·서명 URL을 넣지 않는다. 로컬 workspace·임시 디렉터리를 A의 전제로 두지 않음 |
| A6 | 자동 허용은 **A4 allowlist 중 현재 run에 허가된 범위**(맥락 읽기·자기 run 결과 제출·질문·U3/U4 제안)만. 그 밖의 쓰기·외부 전송은 현재 정책 또는 사람 확인. Go 전송은 **호출마다** 검사 |
| A7 | **run 시작 때 고른 `opencode-go/<model-id>` 하나, 폴백 없음.** 목록은 **PR19에서 검증해 고정할 모델 목록 경로**(공식 `/inference/v1/models`, 기존 `/inference/go/v1/models`는 후보)의 active `opencode-go/*`, 기본값은 `opencode-go/deepseek-v4.1-flash`. **원시 model ID와 내부 ID 매핑·구독 적용 조건을 기록**한다. 내부 요약·제목·reviewer도 같은 모델. 실패는 기록하고 B 인계를 제안할 수는 있지만 자동으로 다른 모델로 전환하지 않음 |
| A8 | **Go OFF는 실제 호출마다 거부 가능한 검사.** OFF 뒤 새 호출 금지, in-flight 취소 시도·unknown·회수 보장 없음 구분. 맥락 조립·요약·재시도·자식 run도 각각 검사. 프롬프트에 실어 보내는 모든 자료가 대상 |
| A9 | PES 질문이 원본. 외부 form/permission 저장소를 두지 않고, 모델의 질문은 PES `ask`로 만들어 `waiting_human`으로 전환한다. 답이 오면 준비 검사 뒤 같은 run을 이어 감 |
| A10 | 재시도: 읽기/연결 재시도와 Go 모델 호출 재시도를 구분하고 한 계층에서만. **호출 전 영속 attempt/상관키를 만들고 prepared/sent/response/adopted/unknown을 남긴다.** 외부 타임아웃·응답 유실·DB 저장 실패는 unknown으로 보존하고 **자동 재호출하지 않는다**. **모델 호출 재시도와 로컬 결과 저장 재시도를 분리**하며, 저장 재시도는 Go를 다시 호출하지 않는다. `x-opencode-session`은 라우팅·캐시용일 뿐 멱등 보장이 아니다. OFF·권한·rev/lease 충돌은 자동 Go 재시도 안 함. 가짜 Go 서버로 호출 횟수·예약·unknown을 시험한다 |

## 4. 방식 B — 사람 컴퓨터 AI가 만들고, 웹 PES에서 작업

| # | 결정 |
|---|---|
| B0 | **B의 흐름**: 사람 컴퓨터의 Claude Code 등(skill·plugin, 예 `/pes:start`)으로 프로젝트를 만들어 **PES에 등록**하고, 그다음부터 사람은 **웹 PES 대시보드**에서 작업한다. 실제 AI 모델은 **사람 컴퓨터에서** 돌고, **PC 도우미↔웹 PES는 WebSocket/HTTP, AI 도구↔PES는 MCP/API**로 연결된다. **브라우저 탭 안 보조만 WebMCP**이며, WebMCP를 고른다고 PC 연결 요구가 충족되지 않는다. **연결은 PC 발신이지만 데이터는 양방향** — PC→웹 자료·진행/스케줄, 웹→PC 자료·MCP 읽기. AI가 꺼져 있으면 화면에 **"AI 미접속 · 대기 중"** 을 표시하고, 켜면 이어서 한다. 2단계 로컬 모드에서는 같은 흐름을 로컬 PES에 등록한다 |
| B1 | Claude Code: **stdio MCP bridge → PES HTTP**가 기본, CLI는 같은 명령·권한·멱등·오류 의미의 대안(토큰·승인 검사 우회 불가). `/pes:run` 진입점 유지, 내부의 파일 잠금·직접 JSON 쓰기는 교체 |
| B2 | **Claude 앱: PR 20에서 Desktop 로컬 확장을 실제 설치·도구 왕복·종료/재접속 시험 → 성공한 환경의 기본 경로.** 명시적 전달(묶음 복사 → 결과 가져오기)은 언제나 제공. 원격 커넥터는 5단계(공개 HTTPS·인증). 로컬 확장이 안 돼도 앱을 보장 대상에서 빼지 않음 |
| B3 | 명시적 전달: 묶음에 프로젝트·판·단계·라운드·기반 버전·요청 ID·manifest hash(**hash는 인증 증명이 아님**). **복사·대화 동안 lease 유지 없음.** 가져온 결과는 오프라인 제안 → 원 요청·기반 manifest 대조·중복 가져오기 방지 → 사람이 새 claim으로 채택. 실제 제출 actor는 사람, 작성 도구·모델 주장은 미검증 출처로 |
| B4 | 앱에는 지속 heartbeat를 요구하지 않음. 재접속 첫 절차 = context → 새 입력 목록 → 수신 확인 → claim. "연결됨"은 마지막 확인 시각·도구 접근 가능 여부일 뿐 |
| B5 | **Codex CLI·OpenCode TUI·Codex 앱·OpenCode 앱도 같은 PES API/MCP 계약**을 쓴다. Codex 앱·OpenCode 앱의 설정 공유는 **미확인**이며, 직접 연결이 안 되면 명시적 전달(복사·붙여넣기)을 보장 경로로 둔다. 실제 제출 actor는 사람, 도구·모델 주장은 미검증 출처. OpenCode 앱·TUI는 PES의 A 내장 실행기와 분리한다 |
| B6 | **WebMCP는 브라우저 탭 안 보조 경로**일 뿐, PC AI의 MCP/API 연결이나 상시 양방향 통로가 아니다. 노출 도구는 기존 `research/webmcp.md`·`webmcp-tools.md`의 제한된 allowlist(읽기·초안·첨언)를 유지하고, 승인·정책·토큰·사람 답 제출은 금지한다. PC 연결은 B0의 WebSocket/HTTP·MCP/API로 따로 요구한다 |

## 5. 공통: lease·대기·재개·인계

| # | 결정 |
|---|---|
| C1 | **heartbeat는 생존·진행 증거에 묶되 모든 호출·읽기마다 무조건 연장하지 않음.** 현재 actor·lease_id/fence·활성 run·미만료·기한을 검사. 긴 추론·도구 없는 구간은 관측 갱신 또는 만료 뒤 재검토. 만료된 lease 부활 금지, heartbeat는 업무 rev를 바꾸지 않음 |
| C2 | **TTL·heartbeat·대기·무진행·중단 유예는 지금 정하지 않음** — SEL-18·19 시험으로. 기준식 `TTL > k×heartbeat + D99 + J99 + 여유`(주기 갱신 경로용, 앱의 불규칙 호출엔 그대로 대입 안 함). long-poll 25초(API)는 별도 값. 기존 2시간은 현행 파일 잠금 값일 뿐 |
| C3 | API 합의와 같게: **질문·결과 저장(ask/submit)과 대기 전환(`wait`)은 별개 명령, `wait`의 `waiting_human` + lease 해제 + 사건 + 영수증은 원자적.** 저장만으로 대기 완료라 표시하지 않음. 실제 대기 이후엔 런타임의 자율 후속 호출·자식 호출을 막음. 질문 없이 실행 form/permission만 기다리는 경우도 사람 대기면 같은 `wait` 원칙 |
| C4 | **재개는 초기엔 사람이 "계속"** (자동 재개는 3단계 옵션). 단 **유효한 제출 하나가 충분조건은 아님** — 서버가 현재 질문/폼 버전·조건부 필수 답·의견으로 응답 허용·명시적 미루기·실행 상태·Go 정책·기한/한도·새 claim을 검사하고, 화면은 서버의 준비됨/차단 이유를 보여 주며 클릭 때 다시 검증. 실행 form 응답·질문 없는 후속 작업엔 연구 답 제출을 요구하지 않음 |
| C5 | **인계는 사람이 시작**(A↔B 전환, 다른 담당 강제 회수). 에이전트의 자발적 pause/release는 허용. 새 run + PES 고정본 + 미처리 입력, 옛 run·세션의 **과거 증거는 보존**. 새 실행의 모델·정책·한도를 새로 검사, 옛 fence·지연 결과·권한 응답 거부. B→A에서 Go OFF면 차단. 중단 미확인이면 위험을 보여 주고 사람이 결정 |

## 6. 역할과 스킬

| # | 결정 |
|---|---|
| D1 | **부모 run이 유일한 업무 채택자.** researcher·writer·verifier 자식은 제안만(작업용 제안 파일 쓰기는 허용, PES 업무 상태 쓰기·토큰 접근은 차단). 하위 run·제안 → 부모 run 매핑·작성 출처 기록. 동시 Go 사용량 보호·Go OFF·부모 만료/중단, **그리고 부모의 `waiting_human`·담당 반납도 자식에 전파 — 그동안 자식의 반출·제출 금지**, 재개는 부모의 새 담당·현재 정책·잔여 Go 사용량 확인 뒤. 현행 조사 병렬(최대 5)은 PES 내장 실행기에서 하위 run으로 검증한 뒤 지원, 앱은 역할별 별도 묶음으로 같은 역할 의미 |
| D2 | **reviewer는 별도 run**: 부모가 담당을 반납한 뒤 reviewer가 새 claim/fence로 실행·제출, 실제 actor·기준 결과 버전 기록. 메인의 기대 결론을 주지 않음. **reviewer가 기준·결과·근거로 먼저 독립 판단하고, 메인의 자체 점검은 마지막에 비교**(현행 `agents/reviewer.md` 규칙 승계). 같은 모델의 다른 세션 검토를 "다른 모델 검증"이라 하지 않음 |
| D3 | `runs.role`은 worker/reviewer, 세부 역할은 **버전이 있는 workflow/manifest 메타데이터**(workflow_version을 호출마다 역할 문자열로 바꾸지 않음) |
| D4 | 스킬 중립화: **중립 단계 워크플로 + 공통 역할 명세 + 어댑터 노트(a-builtin / claude-code / claude-app / codex / opencode-tui / codex-app / opencode-app).** core+plan 파일럿 → 단계·명령·역할 전체. 연구 절차·독립 검토·근거 확인은 유지. Claude 전용 표기·직접 쓰기 예제는 예외 위치가 있는 lint로. `anthropic-skills:*` 이름 변경만으로 변환 지원을 주장하지 않음 |

## 7. Go 사용량 보호·모델 선택 — 기본값, 사용자 확인은 조건부

- **과금 경로는 OpenCode Go 구독 사용량만**이다. Extra Usage(종량제 잔액)는 PES가 켜지 않으며, 설정 화면·설치 안내에 "꺼 두세요"를 표시한다. 공식 문서: [Go 사용량·Extra Usage](https://opencode.ai/v2/docs/console/go/). **새 유료 호출 전에 Extra Usage OFF 확인 시각·계정 범위·유효 기간을 로컬 정책 기록에 남기고, 확인 불가·만료면 차단**한다. 콘솔 확인을 API로 할 수 없으면 사용자가 콘솔에서 OFF를 확인하고 PES에 시각을 입력하는 **수동 확인 경로**를 쓴다. 확인 없음은 허용이 아니다.
- 직접 호출에서는 **사용량 조회 공식 API가 미확인**이다. 그래서 (1) **계정/워크스페이스 단위 사용률 기준점**을 확인하고 외부 사용량을 모르면 0으로 두지 않고 차단/추가 확인하며, (2) 응답의 **한도 초과 오류**를 받으면 즉시 멈추고 `resetsAt`(없으면 "재개 시각 미확인")을 표시하고, (3) PES가 **호출별 토큰을 집계**해 월·주·5시간 한도(월 금액의 100%·50%·20%) 대비 추정 사용률을 계산해 문턱(기본 90%)에서 새 호출을 중단하며, (4) **다음 호출 상한을 최대 출력·모델 가중치로 예약**하고 호출 뒤 정산하며, 병렬·재시도·reviewer·인계·재시작이 예약을 초기화하지 않게 누적하고, (5) 사용량 API가 확인되면 그것을 우선한다. unknown 예약은 자동 해제하지 않는다.
- 문턱을 넘거나 unknown이면 새 run·재시도·reviewer를 시작하지 않는다. 진행 중 run은 **`runs.status='blocked_usage'` + `go_block_reason`·`go_blocked_at`·`go_block_reset_at`**으로 멈추고 **lease를 해제**하며, `resetsAt`·차단 사유·재개 주체를 남긴다. **`waiting_human`은 질문·입력 대기 의미로 유지하고 사용량 차단에 쓰지 않는다.** 응답 도착만으로 자동 진행하지 않고 C4/R1 준비·정책·새 claim 검사를 거쳐 사람이 재개한다.
- 응답에 과금 표시가 있거나 세션 비용이 0이 아니면 즉시 멈추고 사용자에게 알린다. **`cost=0`만으로 Go 구독이라고 판단하지 않고**, `billing_source`·`allowance`·오류/스트림 필드 누락을 시험한다. **토큰·턴·시간 상한은 폭주 방지용**으로 유지하며 금액 상한을 새로 만들지 않는다.
- **모델은 사용자가 고른다.** 기본값 `opencode-go/deepseek-v4.1-flash`, 프로젝트 설정(소유자만, 불변 이력)과 run 시작 시 선택. 목록은 **PR19에서 검증해 고정할 모델 목록 경로**(공식 `/inference/v1/models`, 기존 `/inference/go/v1/models`는 후보)의 active `opencode-go/*`, provider는 `opencode-go` 고정. **원시 model ID↔내부 ID·구독 적용 조건을 기록**한다. run 하나는 시작 때 고른 모델 하나로만 가고 폴백하지 않는다.
- **웹 Workflows 실행**: subrequest 50은 **step이 아니라 Workflow instance당**이다. 새 step·새 instance가 Go 사용량·unknown·외부 호출 멱등·attempt 상관키를 초기화하지 않게 instance chain 생성 시점·총 subrequest·새 claim/fence·응답 유실 복구를 시험한다. 무거운 렌더링은 step 밖으로 뺀다.
- A는 SEL-18, B의 관측·집행 한계는 SEL-19에서 확인. **멈춤 문턱 90%·기본 모델은 추천값 그대로면 다시 묻지 않고, 바꿀 때만 사용자 확인**한다. 실자료를 쓰지 않는 합성 시험도 같은 문턱을 쓴다.
- **조사 단계 웹 검색**: Go 모델 자체에는 검색이 없다. 선택지는 (a) 무료 검색 API 연결, (b) 조사 단계만 B, (c) 사람이 자료를 첨부다. **추천은 (c)로 시작하고, 필요할 때 (a)를 별도 결정**한다. 검색 결과는 출처·버전과 함께 저장한다.

## 8. 실행 기록

- 실행기 동작(호출 시작·중단·재시작)은 `actors.kind=system`. **`mutation_commits.run_id`는 비우고 `events.run_id`엔 대상 run을 남김**(현 DDL로 가능). system/via는 인증된 내부 경로에서 확정, 사건·상태 변경은 같은 tx. 추가 제약이 꼭 필요할 때만 PR 1·4에서
- `events`엔 **저빈도·의미 있는 실행 전이·권한·오류·사용량 확정만**(`execution.*`은 이름 공간, 실제 type 목록은 PR 19에서). 토큰 스트림·SSE 원본·매 heartbeat는 복제하지 않음. 작은 payload, 권한별 공개 목록, tx 경계

- **채택 actor 일치**(PR 1·4·13 계약): 수동 가져오기는 인증된 사람, 자식 제안 채택은 **부모 run의 actor가 실제 채택 주체** — 연결된 run·`mutation_commits`·`object_versions`의 actor가 서로 맞아야 함. 자식의 task/역할·하위 run/세션·제안 hash·작성 도구/근거는 별도 출처로 보존, 자식 모델·사용량을 모르면 미상으로

## 9. 방식 A·B 차이 (요약)

| | A | B Code | B 앱 |
|---|---|---|---|
| 실행 소유 | PES 내장 실행기 | 사용자 터미널 | 사용자 앱 |
| 연결 | Go HTTP API 직접 호출 | stdio MCP / CLI | Desktop 로컬 확장(시험) / 명시적 전달 |
| heartbeat | PES가 호출·진행 관측으로 | 도구 호출·진행에 묶음 | 요구 안 함 |
| 모델 | 사용자가 고른 opencode-go 모델 하나, 폴백 없음 | 사용자 모델(실제 값 기록, 모르면 미상) | 같음 |
| Go 정책 | 호출마다 검사 | 일반 Claude 전송은 대상 아님. **실제 Go 목적지로 가는 전송엔 A·B 공통 검사** | 같음 |
| 비용 집행 | PES가 Go 사용량 추정·한도 오류 문턱에서 멈춤 | PES는 작업량·채택·기한만, 외부 구독 비용은 집행 불가 | 같음 |

## 10. 구현 이슈

**2단계 25개 PR 유지.** PR 19·20만으로 끝나지 않게 선행 계약을 연결:

| PR | 실행 구조 범위 |
|---|---|
| 1·2 | run·actor·lease·dispatch·receipt 제약, system actor 기록 확인, SQLite/D1 같은 실패 의미 |
| 4 | 모든 런타임 변경의 검증·0행 실패·멱등·system/agent 실제 actor |
| 5 | claim/heartbeat/release·`waiting_human` 원자 전환·만료·인계·fence·입력 영수증, 가상 시계 시험 |
| 6 | run 완료와 봉인·승인 분리, reopen·stale 뒤 실행 기반 무효화 |
| 8 | ask와 질문/폼 버전·재개 준비 검사 |
| 9 | 역할 제안의 출처·버전·파일 ready/hash |
| 10 | actor·토큰·Go 정책·반출 허가·OFF 경합(19·20의 선행) |
| 13·14 | 공통 context/claim/submit/ask/wait/complete, run 제어·오류·커서 |
| 15·16 | CLI 같은 서비스·경로 quoting, serve/stop/home·doctor의 소유 프로세스 진단 |
| 17 | 중립 core+plan → 전체, lint |
| 18 | 기존 화면의 최소 실행 상태·전송 표시(새 live 화면은 3단계 U1) |
| 19 | A: PES 내장 실행기 — Go HTTP 직접 호출, 에이전트 루프, 사용량 추정, 모델 선택, 4역할·6단계 |
| 20 | B: Code MCP+CLI, Desktop 로컬 확장 시험, 명시적 전달/가져오기, 앱 재접속 |
| 21 | A/B 교차: 같은 계약·양방향 인계·지연 응답·프로세스 종료·OFF·Go 사용량·중복/충돌 |
| 22 | Windows/macOS 설치·제거·복구·앱 연결 안내·미상 상태 |

각 PR에서 자기 범위를 시험(21번까지 미루지 않음). 5단계 웹 A 실행기(Workflows)·원격 MCP, 6단계 다중 worker는 그 단계 계획서에서.

## 11. 0단계 시험(SEL-18·19)에서 확인할 것

시작 순서·claim 실패·재시작 중 만료·옛 응답 지연 / **Go API 주소·모델 목록·원시/내부 model ID·구독 적용 조건·billing_source·allowance** / 모든 Go 호출과 자식에 같은 차단·사용량 기준점/추정·다음 호출 예약·한도 오류·요약·첨부·재시도 / **Extra Usage OFF 확인·만료·확인 불가 차단** / **호출 전 attempt·상관키·응답 유실 unknown·자동 재호출 금지·모델 호출/저장 재시도 분리·가짜 서버 호출 횟수** / `blocked_usage`+사유/reset·lease 해제·사람 재개 / 대기 전환 원자성·긴 추론 중 만료·댓글만 도착·중복 클릭·reviewer와 부모 동시 claim / system 기록의 FK·대상 run 연결 / 앱 종료 중 답 접수·재접속·다른 프로젝트 묶음·중복 가져오기. SEL-18의 opencode serve 시험은 **Go 구독 cost=0 확인 근거로만** 쓰고 A 설계 근거로 쓰지 않는다.

## 12. 완료 기준 (SEL-24)

- [x] 2~10절, Claude·Codex 합의
- [x] Codex 최종 대조(지적 6건 반영)
- [ ] Go 사용량 멈춤 문턱(기본 90%)·기본 모델: 추천값 그대로면 다시 묻지 않고, 바꿀 때만 SEL-18 측정 뒤 사용자 확인
