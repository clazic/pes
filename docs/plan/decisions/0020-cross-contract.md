# 0020. A·B 교차 계약 — 같은 DB 상태에서 같은 의미·권한·오류, 그리고 죽은 run 이어받기(F1)

- 날짜: 2026-11-11
- 담당: 2단계 PR21 (SEL-56). 기록: hc-team mid worker
- 상태: **채택** — 시험 머리말 해석 1~20을 leader가 수용했다(2026-11-11). Codex 검수 전.
- 관련: [0019](0019-ai-connection-registration.md), [stage-2-db-guarantees.md 8.20](../stage-2-db-guarantees.md), SEL-68

## 문제

방식 A(내장 실행기, `internal_ai` 행위자)와 방식 B(외부 에이전트, MCP·HTTP, `external_agent` 행위자)는 같은 DB·같은 명령 서비스를 쓴다. PR21은 두 길이 같은 시작 상태에서 같은 의미·권한·오류를 내는지, 인계(A→B·B→A)·지연·프로세스 종료·Go OFF·사용량 문턱에서 유실·중복이 없는지, `unknown` 예약이 자동으로 풀리지 않는지, SQLite와 D1이 같은 결과를 내는지를 자동 시험으로 고정한다. 시험하는 동안 두 가지를 정해야 했다.

1. 두 길의 오류 문장·옛 guard 거부 code가 글자까지 같아야 하는가.
2. 실행 중 죽은 run(`running` + lease 만료)을 같은 행위자가 재시작 뒤 이어받을 수 있어야 하는가 (시험이 드러낸 결함 F1).

## 선택지

- 오류: (가) 글자까지 통일 / (나) code·효과로 같게 하고 문장은 길마다 둔다.
- 옛 guard code: (가) 지금 통일 / (나) 현재 동작을 계약으로 고정하고 통일은 후속.
- F1: (가) 이어받기 없음(새 run만) / (나) 만료된 lease의 `running` run을 자기 행위자가 다시 claim·resume.

## 채택

**범위.** A·B 교차 계약은 `tests/test_cross_{contract,handoff,scenarios,unknown,d1}.test.ts`·`tests/helpers/cross_{env,driver}.ts`·`tests/fixtures/contracts/cross/*.json`이 정한다. 가짜 AI 서버·가짜 MCP 클라이언트·합성 자료·임시 HOME만 쓴다. 실제 모델·외부 호출·유료 호출은 없다.

- **해석 1 — 오류는 code·효과로 같게 한다.** 같은 code(core 철자)·같은 target·같은 효과(쓰기 0)를 계약으로 삼는다. 문장은 통일하지 않는다: A 도구는 모델에게 core의 영어 문장을 `code: message`로 보이고, B(HTTP·MCP)는 code마다 고정된 한국어 문장을 보인다. B의 여섯 도구는 같은 code에 byte 단위로 같은 한국어 문장을 내고, A는 같은 상태에서 매번 같은 문장을 내며, 둘 다 SQL·표 이름·스택을 보이지 않는다.
- **해석 3 — 옛 guard 거부 code는 현재 동작을 계약으로 고정한다.** 옛 lease/fence guard의 거부 code가 `heartbeat`·`release`는 `lease_lost`, `submit`·`wait`·`complete`는 `conflict`로 갈린다. `input-receipts`는 시험으로 고정하지 못했다(가시성 검사가 guard보다 먼저 돌아 guard 거부 code가 드러나지 않음) — 시험 안 함, 계약에 넣지 않는다. 둘 다 거부하고 쓰기 0인 것이 계약이고, 철자 통일은 후속이다(바꾸면 8.17의 B 도구 오류 표와 클라이언트가 같이 바뀐다).
- **해석 13 — 채택 전 제출 버전은 다음 context에 보이지 않는다.** 제출은 승인이 아니다. 새 버전은 DB에 저장되지만 사람이 채택하기 전에는 자료의 current가 아니라서 다음 실행의 context에 나오지 않는다. 이것은 유실이 아니다. 유실 0은 버전 사슬이 DB에 그대로 남는 것으로 시험한다.
- **D1 교차 시험은 001 스키마 한정.** D1에는 마이그레이션 001만 적용한다(8.16: 002의 `foreign_keys=off` 방식은 D1에서 안 된다, 5단계 별도 절차). 그래서 D1 쪽 A run은 001의 Go 라벨 쌍(mode A + opencode-go)으로 표현한다. **002의 D1 적용은 검증하지 않았다.** 표의 SQL은 서비스 코드를 import하지 않고 다시 쓴 것이다. **release·heartbeat는 `commands/runs.ts`와 같은 모양이고, claim은 D1에서 쓸 CAS 변형(`fence`·만료 조건 추가)이며 `runs.ts`의 claim UPDATE와 다르다.** 따라서 이 표는 서비스 SQL의 D1 등가 증명이 아니라 "D1에서 claim을 CAS로 쓰면 SQLite와 같은 결과를 낸다"는 시험이다. 5단계에서 D1 claim을 CAS로 바꿀 때 이 표를 기준으로 삼고, `runs.ts`의 release·heartbeat UPDATE 모양이 바뀌면 이 표도 같이 고친다.
- **B의 외부 비용은 PES가 집행했다고 표시하지 않는다.** B run은 dispatch 행·사용량·단가·A 설정이 없고, B에 대한 API·MCP 답·사건·영수증에 비용 필드가 없다(프로젝트 정책 묶음 `policy`는 B run의 비용이 아니므로 제외). B가 어떤 모델을 얼마에 쓰는지 PES는 모르고, 막지도 않는다.

**F1 — 죽은 `running` run은 자기 행위자가 이어받는다.**

- 증상: 보유자가 죽으면 run은 `running`인 채 lease만 만료된다. 지금까지는 다른 claim(그 run을 `interrupted`로 바꿈)이나 소유자 cancel만 그 run을 움직였다. 그래서 재시작한 같은 행위자가 자기 run을 이어받지 못했다(B `pes_claim {run_id}`, A resume 모두 상태 conflict).
- 결정: **`running`이고 프로젝트에 살아 있는 lease가 없는(만료된) run은 같은 행위자가 이어받을 수 있다.** 새 lease는 fence를 +1 해서 받고, 만료된 옛 lease는 새 lease로 교체되기 전에 사건 `run.interrupted`(`reason: lease_expired`, 옛 `lease_id`·`fence`)로 남긴다. run 자체는 `running`으로 이어진다.
- **옛 규칙을 바꿈**: 8.3(PR5)의 "`run_id` 재개는 `queued`·`waiting_human`·`blocked_usage`·`interrupted`에서만"과 그 규칙을 못 박은 옛 시험 둘(`test_api_hardening` "re-claim … after expiry is refused", `test_runs_leases_hardening` "claim … (running) is refused")은 이 결정으로 대체된다. stage-2-db-guarantees.md의 claim 규칙 줄(151행)도 고쳤다.
- B: `commands/runs.ts` `run_claim`의 `run_id` 분기가 이 경우를 받아들인다. 활성 lease가 살아 있으면 여전히 `conflict`. 다른 행위자의 run(`the run belongs to another actor`)·SEL-68 규칙(mode A·Go 라벨 run은 `internal_ai`만)·`PRE_REPLAY_TABLE` 재전송 검사는 그대로다.
- A: `a_runtime/loop.ts`의 resume 상태 검사가 같은 경우를 받아들인다. **정산 안 된 dispatch(`prepared`·`authorized`·`sent`·`unknown`)가 있으면 여전히 `conflict`** — `unknown`의 자동 해제 금지는 그대로이고, 사람이 `dispatch.resolve_unknown`으로 정리한 뒤에만 이어받는다. 옛 guard(옛 lease_id·fence)는 이어받은 뒤에도 계속 거부된다.

## 이유

- 사용자가 보는 것은 code와 효과다. 문장 글자를 맞추면 A 도구의 모델 대면 문장과 B의 한국어 고정문 중 한쪽을 깨야 하고, 얻는 것이 없다.
- 해석 3을 지금 통일하면 PR20 계열의 B 오류 표·클라이언트 처리와 얽힌다. 현재 동작이 안전(둘 다 거부·쓰기 0)하므로 고정하고 통일은 따로 한다.
- 제출을 current로 보이게 하면 사람 승인 없이 AI 결과가 다음 실행에 흘러든다. 보이지 않는 것이 의도다.
- F1: 재시작은 흔한 사고이고, 새 run을 만들면 같은 일의 run이 쪼개지고 `unknown` 예약이 붙은 옛 run이 영원히 남는다. 만료된 lease는 되살리지 않고(새 fence), 호출 결과가 불확실한 dispatch는 사람만 정리하므로 안전 규칙을 약하게 하지 않는다.

## 영향

- 코드: `scripts/pes_core/commands/runs.ts`(`run_claim`), `scripts/pes_core/a_runtime/loop.ts`(`#resume`, `#project_lease_live`). 새 명령·표·마이그레이션 없음.
- 문서: [stage-2-db-guarantees.md](../stage-2-db-guarantees.md) 새 절 8.20, 이 결정과 색인.
- CI: `d1-smoke` 워크플로의 paths에 `tests/test_cross_d1.test.ts`·`tests/fixtures/contracts/cross/**`.
- 후속: 해석 3의 code 통일, 002의 D1 적용 시험(5단계), B 오류 문장을 A와 맞출지는 필요할 때.

## 재검토 조건

- B 도구의 오류 표나 클라이언트가 `lease_lost`/`conflict` 구분을 쓰게 되거나 버려질 때.
- D1에 마이그레이션 002를 적용하는 절차(5단계)가 정해질 때.
- 죽은 run 이어받기 때문에 한 run에 lease 세대가 여러 개 쌓여 감사·정산이 어려워질 때.
- 이어받기도 `run.interrupted` 사건을 남기고 run은 `running`으로 이어진다. 대시보드가 사건 종류로 상태를 그리기 시작하면 payload에 `resumed` 표지를 넣거나 사건 이름을 나눈다.

## 상태

채택 (2026-11-11)
