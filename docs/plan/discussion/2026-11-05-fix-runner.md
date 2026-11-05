# 2026-11-05 검수 반영 — runner 묶음

- 대상: [2026-11-05-codex-review.md](2026-11-05-codex-review.md)의 F04·F05·F06·F07·F13·F17·R01·R05·F02
- 고친 네 파일: `decisions/0013-mode-a-go-subscription-and-model-choice.md`, `stage-1-runners.md`, `stage-2.md`, `issues/stage-2.md`
- 범위: 계획·이슈 문서만. 실제 `~/pes-projects`·`~/.pes/`는 읽거나 쓰지 않았고, 커밋·push·Linear 등록은 하지 않았다. 공식 출처는 검수 파일의 URL·2026-11-05 확인일을 썼다.

## 1. 항목별 반영

| 항목 | 반영 내용 | 남은 것 |
|---|---|---|
| F05 Go HTTP 경로·모델 목록·과금 근거 | 0013·runners A1/A7·issues PR19에서 기존 `/inference/go/...`·`/inference/go/v1/models`를 **후보**로 내리고, 공식 문서의 `/inference/openai·anthropic·google/...`·`/inference/v1/models`를 안내했다. **PR19에서 실제 호출로 주소·원시 model ID↔내부 ID·구독 적용 조건을 검증해 고정**하게 했다. provider=`opencode-go` 고정·폴백 금지는 유지. `cost=0`만으로 Go 구독 판단 금지, `billing_source`·`allowance`·오류/스트림 필드 누락 시험을 추가했다. 공식 URL: https://opencode.ai/v2/docs/console/api/inference/ | PR19 실측 전에는 주소·모델 ID 매핑·구독 적용 범위가 미확정 |
| F06 Extra Usage OFF·사용량 기준점·예약 | 0013·runners 7절·issues PR19에 시작 전 Extra Usage OFF 확인 시각·계정 범위·유효 기간 기록, 확인 불가/만료 시 차단, 수동 확인 경로를 넣었다. 계정/워크스페이스 사용률 기준점, 확인된 allowance/가중치, 다음 호출 상한 예약·정산, 병렬·재시도·인계·재시작 누적, unknown 예약 미해제를 넣었다. 공식 URL: https://opencode.ai/v2/docs/console/go/ | 공식 사용량 API·콘솔 확인 API 존재는 PR19/SEL-18에서 확인 |
| F07 세션 헤더·멱등 분리 | 0013에 「호출 시도·멱등」 절을 추가하고 runners A10·issues PR19에 호출 전 영속 attempt/상관키, prepared/sent/response/adopted/unknown, 응답 유실 unknown·자동 재호출 금지, 모델 호출 재시도와 로컬 저장 재시도 분리, 가짜 Go 서버 호출 횟수 시험을 넣었다. `x-opencode-session`은 라우팅·캐시용이며 멱등 보장이 아님을 명시했다. | 외부 멱등/조회 API가 확인되기 전에는 unknown을 사람이 정산 |
| F13 사용량 차단 상태·재개 | 0013·runners 7절·issues PR19에서 상태값·열은 **DDL 묶음이 정하고** 여기서는 차단 사유·`resetsAt`·lease 해제·재개 주체(사람)·자동 진행 금지 계약만 정했다. 응답 도착만으로 자동 진행하지 않고 C4/R1 준비·정책·새 claim 검사를 거치게 했다. | **다른 파일 필요: `schemas/stage-1-ddl-draft.sql`·`check_ddl.py`에 사용량 차단 상태/사유와 lease·재개 필드의 실제 열·CHECK를 DDL 묶음이 추가해야 함** |
| R01 A 업무 도구 allowlist | 0013·runners A4·issues PR19 tools에서 `context.get`·`result.submit`·`question.ask`(공통), `assumption.propose`·`reflection.write`(U3), `thread.reply`·`followup.propose`(U4)로 정확한 allowlist와 U3/U4 매핑을 적었다. 파일·셸·임의 네트워크 도구는 금지 유지. | 3단계 U3/U4의 명령 이름과 최종 대조 필요(다른 파일) |
| F04 project.create/register | stage-2 4.2.1 닫힌 경로에 `POST /api/v1/projects`(PR13)·`POST /api/v1/project-registrations`(PR14)를 넣고, PR13/14/20a와 issues PR13/14/20a에 owner·초기 정책·첫 판 bootstrap 원자성, 중복 slug·멱등·재생, project token 없는 B 최초 등록의 기기 승인 자격, 일반 에이전트 토큰의 owner/정책 우회 금지, 빈 계정/새 프로젝트 시험을 넣었다. | 웹 생성 UI·웹 등록 화면은 5단계(다른 파일) |
| F17 WebMCP 역할 | runners B0/B6에서 PC 도우미↔웹은 WebSocket/HTTP, AI 도구↔PES는 MCP/API, 브라우저 탭 안 보조만 WebMCP로 통일했다. WebMCP 선택이 PC 연결 요구를 충족하지 않음을 명시했다. | stage-5·summary의 같은 문구 정합은 다른 파일 |
| R05 PR20c actor | stage-2 PR20c·issues PR20c에서 직접 인증 앱은 `external_agent`, 사람이 붙여 넣은 수동 전달만 `human`으로 구분했다. | 6단계 G3의 명시 선행에 20c 추가는 다른 파일 |
| F02 새 코드·시험 TS | issues/stage-2의 새 `scripts/pes_core/*`를 `.ts`, 새 `tests/*`를 `.test.ts`/`.spec.ts`로 바꾸고, 테스트 명령을 **`결정 뒤 확정할 TS 테스트 명령`**으로 표시했다. PR26은 기존 0.15 자산의 이전·동등성·설치·제거만 맡고 새 Python 코드·테스트를 만들지 않는다고 정리했다. stage-2의 PR18 테스트도 TS 서버 렌더+Playwright로 표기했다. | **다른 파일 필요: `issues/stage-3.md`·`issues/stage-4.md`·`issues/stage-6.md`, `stage-1-ui.md`, `roadmap.md`의 새 Python 모듈·pytest·`.py` 표기를 TS 계약으로 정리해야 함** |

## 2. 남은 것

- F05/F06/F07의 실제 주소·모델 ID·구독 적용 조건·사용량 API·Extra Usage 확인 API는 PR19/SEL-18 실측 전까지 확정이 아니다.
- F13의 DDL 상태/사유/lease 열은 DDL 묶음이 정해야 한다.
- F04의 웹 생성/등록 UI는 5단계, R05의 G3 선행은 6단계, F17의 stage-5/summary 문구는 다른 작업자 몫이다.
- F02의 3~6단계 이슈·stage-1-ui·roadmap의 잔여 Python 표기는 다른 작업자가 고쳐야 한다.

## 3. 다른 파일 필요

- `docs/plan/schemas/stage-1-ddl-draft.sql`, `docs/plan/schemas/check_ddl.py`: F13 사용량 차단 상태/사유·lease/재개 열과 CHECK, F05/F07 attempt/정산에 필요한 열·제약(DDL 묶음).
- `docs/plan/stage-5.md`, `docs/plan/issues/stage-5.md`: F04 웹 project.create/register UI·인증, F05/F06/F07 Go 사용량·주소·Extra Usage, F17 WebMCP 역할.
- `docs/plan/issues/stage-3.md`, `docs/plan/issues/stage-4.md`, `docs/plan/issues/stage-6.md`, `docs/plan/stage-1-ui.md`, `docs/plan/roadmap.md`: F02 새 코드·시험 TS 표기, R01 U3/U4 명령 매핑, R05 G3 선행.
- `docs/plan/summary-for-approval.md`, `docs/plan/decisions/0003-mode-b-agents.md`: F17 WebMCP/연결 역할 문구 정합.

완료: docs/plan/discussion/2026-11-05-fix-runner.md
