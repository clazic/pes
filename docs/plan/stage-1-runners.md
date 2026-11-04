# 1단계 ④ 방식 A·B 실행 구조 설계서

- 작성: 2026-11-04, Claude 종합. Linear: SEL-24
- 입력: [stage-1-runners-codex.md](discussion/stage-1-runners-codex.md), [stage-1-runners-opencode.md](discussion/stage-1-runners-opencode.md), Claude 추천안 [stage-1-runners-claude-recs.md](discussion/stage-1-runners-claude-recs.md), Codex 검수 [stage-1-runners-codex-review.md](discussion/stage-1-runners-codex-review.md)(동의 11·수정 17·반대 0), 합의 [stage-1-db.md](stage-1-db.md)·[stage-1-api.md](stage-1-api.md)
- 상태: **확정 — 사용자 승인 2026-11-05.** **합의안(Claude·Codex)** — Codex 최종 대조 [stage-1-runners-final-check.md](discussion/stage-1-runners-final-check.md) 지적 6건 반영. **비용 상한 값은 사용자 확인 필요**(7절).

## 1. 목표

방식 A(PES 안의 OpenCode + DeepSeek)와 방식 B(Claude Code·Claude 앱)가 **같은 PES 코어와 같은 API**로 일하게 하는 실행 구조를 정한다.

## 2. 하나의 코어, 두 어댑터

| 누가 | 맡는 일 | 하지 않는 일 |
|---|---|---|
| PES 코어 | 상태·검증·채택·기록 | 추론 |
| 에이전트 | 조사·집필·검토 | 상태를 직접 쓰기 |
| 어댑터 | 실행 시작·중단·관측, 권한 중계, 모델·세션 관리 | 상태·연구 결과를 임의 생성하거나 직접 저장. **A의 업무 제출은 세션의 인증된 도구 호출로**, 어댑터의 실행 제어·관측 기록은 검증 명령으로 |

## 3. 방식 A — PES 안의 OpenCode

| # | 결정 |
|---|---|
| A1 | PES가 **opencode 서버 HTTP API**로 제어(v2.2.5 고정, 명세 사본·해시와 바이너리 대조). 세션의 도구가 공통 PES API/MCP로 제출 |
| A2 | **시작 순서: 첫 모델 호출·연구 자료 전송 전에 run·claim·현재 Go 정책·예산 확인.** 빈 세션 준비와 연구 prompt 실행을 구분. 최초 claim 주체는 하나로(어댑터 선행 claim 또는 세션 bootstrap claim 중 PR 19에서 확정) — 중복 claim·소유자 없는 유료 실행 금지 |
| A3 | **PES가 소유한 전용 프로필·프로세스, 프로젝트당 최대 하나.** 사용자가 쓰는 OpenCode 서버에는 붙거나 끄지 않음. loopback·인증, 프로세스 소유 증거(식별자·시작 시각·접속점)로 PID 재사용 오인 방지, Windows 자식 회수·macOS 프로세스 그룹 시험. **전체 동시 실행·프로세스 상한은 자원·예산 시험으로.** `waiting_human`(lease 없음)일 때 서버를 멈출지 휴면할지 PR 19에서 정함 |
| A4 | **동시에 활성인 주 세션은 run당 하나.** 같은 run의 대체 세션·하위 세션은 예외로 두고 원/대체/하위 세션과 run·부모 매핑을 덧붙여 보존(external_session_ref 하나를 덮어쓰지 않음). 복구가 불확실하면 옛 세션의 채택·반출을 먼저 막고 PES 고정본으로 새 세션 |
| A5 | 작업 디렉터리 기본값 `~/.pes/runs/<run_id>/workspace`(구성 가능, OS 임시 경로 허용). **경로가 곧 sandbox는 아님** — 파일·셸·MCP 권한과 환경/프로필에서 DB·객체 원본·전역 설정 접근을 막음. 종료 시 지울 임시 사본과 먼저 ready로 채택·보존할 결과/증거를 구분 |
| A6 | 자동 허용은 **API가 허가한 프로젝트/버전·workspace 입력·지정 연구 도구/목적지 범위의 읽기·검색**만. 쓰기·셸·그 밖의 네트워크는 정책 또는 사람 확인. Go 전송은 별도 현재 정책 검사 |
| A7 | **모델 폴백 없음.** 실제 요청마다 `opencode-go/deepseek-v4.1-flash` 확인(내부 요약·제목·하위 세션·reviewer 포함). 실패는 기록하고 B 인계를 제안할 수는 있지만 자동 전환 안 함 |
| A8 | **Go OFF는 실제 반출 요청마다 거부 가능한 검사**(훅/transport·최종 요청·요약·재시도·자식). OFF 뒤 새 허가 금지, in-flight 취소 시도·unknown·회수 보장 없음 구분. 훅이 2.2.5에서 실제로 막는지는 **PR 19 합성 시험**, 못 막는 경로는 쓰지 않음 |
| A9 | PES 질문이 원본. OpenCode form/permission은 **실행 입력으로 따로 중계**(요청 ID·세션·응답자·기한, 응답 뒤 재개 검사). 두 번째 질문 저장소·승인 경로로 쓰지 않음 |
| A10 | 재시도: 읽기/연결 재시도와 유료 prompt 재시도를 구분하고 한 계층에서만. 외부 타임아웃은 결과 조회부터, unknown을 미전송으로 보지 않음, OFF·권한·rev/lease 충돌은 자동 유료 재시도 안 함 |

## 4. 방식 B — Claude Code와 Claude 앱

| # | 결정 |
|---|---|
| B1 | Claude Code: **stdio MCP bridge → 로컬 PES HTTP**가 기본, CLI는 같은 명령·권한·멱등·오류 의미의 대안(토큰·승인 검사 우회 불가). `/pes:run` 진입점 유지, 내부의 파일 잠금·직접 JSON 쓰기는 교체 |
| B2 | **Claude 앱: PR 20에서 Desktop 로컬 확장을 실제 설치·도구 왕복·종료/재접속 시험 → 성공한 환경의 기본 경로.** 명시적 전달(묶음 복사 → 결과 가져오기)은 언제나 제공. 원격 커넥터는 5단계(공개 HTTPS·인증). 로컬 확장이 안 돼도 앱을 보장 대상에서 빼지 않음 |
| B3 | 명시적 전달: 묶음에 프로젝트·판·단계·라운드·기반 버전·요청 ID·manifest hash(**hash는 인증 증명이 아님**). **복사·대화 동안 lease 유지 없음.** 가져온 결과는 오프라인 제안 → 원 요청·기반 manifest 대조·중복 가져오기 방지 → 사람이 새 claim으로 채택. 실제 제출 actor는 사람, 작성 도구·모델 주장은 미검증 출처로 |
| B4 | 앱에는 지속 heartbeat를 요구하지 않음. 재접속 첫 절차 = context → 새 입력 목록 → 수신 확인 → claim. "연결됨"은 마지막 확인 시각·도구 접근 가능 여부일 뿐 |

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
| D1 | **부모 run이 유일한 업무 채택자.** researcher·writer·verifier 자식은 제안만(작업용 제안 파일 쓰기는 허용, PES 업무 상태 쓰기·토큰 접근은 차단). 하위 세션 → 부모 run 매핑·작성 출처 기록. 동시 예산 예약·Go OFF·부모 만료/중단, **그리고 부모의 `waiting_human`·담당 반납도 자식에 전파 — 그동안 자식의 반출·제출 금지**, 재개는 부모의 새 담당·현재 정책·잔여 예산 확인 뒤. 현행 조사 병렬(최대 5)은 native 병렬을 런타임에서 검증한 뒤 지원, 앱은 역할별 별도 묶음으로 같은 역할 의미 |
| D2 | **reviewer는 별도 run**: 부모가 담당을 반납한 뒤 reviewer가 새 claim/fence로 실행·제출, 실제 actor·기준 결과 버전 기록. 메인의 기대 결론을 주지 않음. **reviewer가 기준·결과·근거로 먼저 독립 판단하고, 메인의 자체 점검은 마지막에 비교**(현행 `agents/reviewer.md` 규칙 승계). 같은 모델의 다른 세션 검토를 "다른 모델 검증"이라 하지 않음 |
| D3 | `runs.role`은 worker/reviewer, 세부 역할은 **버전이 있는 workflow/manifest 메타데이터**(workflow_version을 호출마다 역할 문자열로 바꾸지 않음) |
| D4 | 스킬 중립화: **중립 단계 워크플로 + 공통 역할 명세 + 어댑터 노트(opencode / claude-code / claude-app).** core+plan 파일럿 → 단계·명령·역할 전체. 연구 절차·독립 검토·근거 확인은 유지. Claude 전용 표기·직접 쓰기 예제는 예외 위치가 있는 lint로. `anthropic-skills:*` 이름 변경만으로 변환 지원을 주장하지 않음 |

## 7. 비용·시간 상한 — 사용자 확인 필요

- 상한 단위: **run + 단계 + 프로젝트 누적.** 실측 비용 / 구독 허용량 / 토큰·턴·시간 강제 한도를 따로 다룸
- 값이 없다고 무제한을 기본으로 두지 않음. **송신·과금 결과가 불명(unknown)인 요청의 예약은 자동 해제하지 않고 보수적으로 유지**, 조회·명시적 정산으로만 해소(되돌린 뒤 재시도로 상한을 우회하지 못하게). 자식·reviewer·재시도·새 세션·인계가 예산을 초기화하지 않게 예약·정산. 모르는 비용을 무료로 표시하지 않음
- A는 SEL-18, B의 관측·집행 한계는 SEL-19에서 확인. **값은 측정 뒤 추천해 사용자 확인**(비용이라 합의 규칙의 예외). 실자료를 쓰지 않는 유료 합성 시험에도 시험 상한을 명시

## 8. 실행 기록

- supervisor 동작(프로세스 시작·중단·회수)은 `actors.kind=system`. **`mutation_commits.run_id`는 비우고 `events.run_id`엔 대상 run을 남김**(현 DDL로 가능). system/via는 인증된 내부 경로에서 확정, 사건·상태 변경은 같은 tx. 추가 제약이 꼭 필요할 때만 PR 1·4에서
- `events`엔 **저빈도·의미 있는 실행 전이·권한·오류·사용량 확정만**(`execution.*`은 이름 공간, 실제 type 목록은 PR 19에서). 토큰 스트림·SSE 원본·매 heartbeat는 복제하지 않음. 작은 payload, 권한별 공개 목록, tx 경계

- **채택 actor 일치**(PR 1·4·13 계약): 수동 가져오기는 인증된 사람, 자식 제안 채택은 **부모 run의 actor가 실제 채택 주체** — 연결된 run·`mutation_commits`·`object_versions`의 actor가 서로 맞아야 함. 자식의 task/역할/세션·제안 hash·작성 도구/근거는 별도 출처로 보존, 자식 모델·사용량을 모르면 미상으로

## 9. 방식 A·B 차이 (요약)

| | A | B Code | B 앱 |
|---|---|---|---|
| 실행 소유 | PES(어댑터) | 사용자 터미널 | 사용자 앱 |
| 연결 | opencode 서버 HTTP | stdio MCP / CLI | Desktop 로컬 확장(시험) / 명시적 전달 |
| heartbeat | 어댑터가 진행 관측으로 | 도구 호출·진행에 묶음 | 요구 안 함 |
| 모델 | DeepSeek 하나, 폴백 없음 | 사용자 모델(실제 값 기록, 모르면 미상) | 같음 |
| Go 정책 | 실제 반출마다 검사 | 일반 Claude 전송은 대상 아님. **실제 Go 목적지로 가는 전송엔 A·B 공통 검사** | 같음 |
| 비용 집행 | PES가 상한 집행 | PES는 작업량·채택·기한만, 외부 비용은 집행 불가 | 같음 |

## 10. 구현 이슈

**2단계 22개 PR 유지.** PR 19·20만으로 끝나지 않게 선행 계약을 연결:

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
| 19 | A: 2.2.5 API + supervisor·세션 계보·이벤트·Go 훅 시험·한도·4역할·6단계 |
| 20 | B: Code MCP+CLI, Desktop 로컬 확장 시험, 명시적 전달/가져오기, 앱 재접속 |
| 21 | A/B 교차: 같은 계약·양방향 인계·지연 응답·프로세스 종료·OFF·예산·중복/충돌 |
| 22 | Windows/macOS 설치·제거·복구·앱 연결 안내·미상 상태 |

각 PR에서 자기 범위를 시험(21번까지 미루지 않음). 5단계 원격 runner·원격 MCP, 6단계 다중 worker는 그 단계 계획서에서.

## 11. 0단계 시험(SEL-18·19)에서 확인할 것

시작 순서·claim 실패·cold start 중 만료·서버 재시작·옛 세션 지연 결과 / 모든 Go 경로와 자식에 같은 차단·누적 한도·훅 불통·요약·첨부·재시도·WebSocket 우회 / 대기 전환 원자성·긴 추론 중 만료·댓글만 도착·중복 클릭·reviewer와 부모 동시 claim / system 기록의 FK·대상 run 연결 / 앱 종료 중 답 접수·재접속·다른 프로젝트 묶음·중복 가져오기.

## 12. 완료 기준 (SEL-24)

- [x] 2~10절, Claude·Codex 합의
- [x] Codex 최종 대조(지적 6건 반영)
- [ ] 비용 상한 값: SEL-18 측정 뒤 사용자 확인
