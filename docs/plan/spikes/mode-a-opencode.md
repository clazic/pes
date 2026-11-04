# 방식 A 시험 — opencode 서버 API (SEL-18)

- 확인일: 2026-11-05 (리뷰 반영 재시험)
- 환경: macOS 27.2 (arm64, m5), Python 3.15.2, opencode `v2.2.5` (`/opt/homebrew/bin/opencode`)
- 모델: `opencode-go/deepseek-v4.1-flash` **하나만** 사용 (사용자 결정)
- 시험 코드: [`spikes/mode-a/mode_a_spike.py`](spikes/mode-a/mode_a_spike.py), 실행법 [`spikes/mode-a/README.md`](spikes/mode-a/README.md)
- 원시 결과(비밀번호·로컬 경로 제거): [`spikes/mode-a/results-2026-11-05.json`](spikes/mode-a/results-2026-11-05.json)
- 시험 자료: 임시 폴더의 **합성** PES 프로젝트. 실제 연구 자료·`~/pes-projects`·`~/.pes` 는 읽거나 쓰지 않았다.
- 반복: 항목별 3회. 아래 값은 회차별 실측이다.

## 0. 요약

**6개 항목 모두 3/3 성공.** `opencode serve` + HTTP API(A2)로 PES의 공통 시나리오 한 라운드,
이벤트 스트림, 중단·재개, 개인 서버 재시작 후 세션 복구, 권한 승인·거부, 사용량 한도 조회가 모두 동작했다.
제품 코드는 바꾸지 않았고, 시험 중 만든 세션은 API로 삭제했으며, 띄운 서버는 모두 종료하고 포트가 빈 것을 확인했다.

핵심 확인:

- **PES 질문은 PES가 원본**이다. 이 시험의 사람 질문은 PES `ask`/`POST /feedback` 으로만 왕복했고,
  OpenCode `form`/`permission` 은 **실행 수준**(도구 승인)으로 분리했다.
- 공통 시나리오의 재개는 **개인 서버를 끄고 다시 띄운 뒤 같은 세션 ID를 복구**해,
  이전 `result.json` 요약과 사람 답 파일 내용에 의존하는 `plan-result.md` 를 작성하는 것으로 확인했다.
- `interrupt` 는 `sleep 45` 셸이 **실제 running 인 것을 `/api/shell` 로 확인한 뒤** 걸었고,
  응답 `interrupted: true`, idle `interrupted`, 같은 세션 재개, 서버 재시작 후 복구가 모두 확인됐다.
- 권한 승인은 `once` 응답 + 실제 `shell`/`write` 도구 완료로, 거부는 `rm -f keep.txt` 요청에 대한
  `reject` + `keep.txt` 보존으로 **따로** 판정했다.
- `PES_HOME` 은 서버 프로세스 환경과 세션 environment API 양쪽에 넣고,
  도구가 쓴 `env-home.txt`·`env-project.txt` 내용을 PES가 직접 읽어 임시 값인지 확인했다.
  `PES_PROJECT` 는 상속되지 않았다.

## 1. 리뷰 반영

필수 1~9, 권장 1~2를 모두 반영했다. 코드 위치는 [`mode_a_spike.py`](spikes/mode-a/mode_a_spike.py).

| # | 리뷰 지적 | 반영 |
|---|---|---|
| 1 | 권한 응답기가 대상 세션을 구분하지 않음 | `PermissionResponder(api, decision, sid)` 로 `r.sessionID == sid` 인 요청만 처리·기록. 거부 시험은 `rm` + `keep.txt` 인 요청만 대상으로 판정 |
| 2 | 서버·도구 환경에 임시 `PES_HOME` 미보장 | 서버 프로세스 env 에 `PES_HOME` 설정, `PES_PROJECT` 제거. 세션 environment API(`PUT /api/session/{id}/environment`)도 호출(3/3 성공). 도구가 쓴 `env-home.txt`/`env-project.txt` 로 실제 값 확인. `pes.py`·`serve.py` 는 `HOME` 도 임시로 격리 |
| 3 | 세션이 정리 목록에 늦게 등록됨 | `create_session` 이 만든 직후 `owned_sessions` 에 추가. `iteration` finally 가 회차의 모든 세션 ID를 삭제. 서버 장애로 못 지우면 `leftover_ids`·실패를 결과에 보존하고 임시 폴더를 남김 |
| 4 | 재개가 서버 재시작·맥락 의존을 확인하지 않음 | 답 처리 뒤 개인 서버 종료·재기동 → 같은 시나리오 세션 복구 → 이전 `result.json` summary + 사람 답 text + 처리 안 한 답 0 을 `plan-result.md` 에 쓰게 하고 내용을 검증. 회차별 지연 기록 |
| 5 | 중단 성공 판정이 약함 | `/api/shell` 에서 `sleep 45` running(pid 포함) 확인 → interrupt 응답 `interrupted == true` → idle `outcome == interrupted` → `sleep` 셸 종료(`sleep_gone`) → 같은 세션 재개 → 재시작 후 복구를 모두 성공 조건으로 사용 |
| 6 | 사용량 성공이 `all([])` 로 참이 될 수 있음 | 세 측정값이 모두 존재하고, 각 응답의 `data.go.rolling/weekly/monthly` 가 `percent`(0~100)·`limited`(bool)·`resetsAt`(number)를 갖출 때만 성공. 미실행·불완전은 실패 |
| 7 | 권한 승인/거부가 분리 판정되지 않음 | 승인: `once` shell·edit 응답 + 실제 `shell`/`write` 도구 완료 + 결과 JSON 유효. 거부: `rm -f keep.txt` reject + `keep.txt` 보존. 두 조건을 함께 항목 5로 집계하되 개별 결과를 회차별 기록 |
| 8 | 예외·결과에 서버 로그(비밀번호)가 들어감 | 서버 종료 시 로그의 비밀번호 줄 마스킹. 예외·traceback·결과 JSON 저장 전 `scrub()` 으로 비밀번호·`server password` 줄·로컬 경로 제거. 결과 JSON에서 사용자 홈·임시 폴더 경로·비밀번호 없음 확인(2차 리뷰 후 재정제) |
| 9 | `Thread._stop` 이름 충돌 (Python 3.9 `join` TypeError) | `EventStream`·`PermissionResponder` 모두 `_stop_event` 로 변경. `stop()` 은 이벤트 설정 후 연결을 닫고 `join()` |
| 권장 1 | SSE timeout 후 reader 깨짐·close/join 누락 | `resp.read1()` 로 도착분만 읽고, `stop()` 에서 응답 close + `join(5)`. `terminal_seen`(실행 종료 이벤트)도 성공 조건에 포함 |
| 권장 2 | 실패·빈 시험에서도 종료 코드 0 | `--repeats < 1` 은 사용법 오류(2). 필수 항목 실패·미실행·정리 실패·결과 저장 실패 시 1 반환. 실패 시 임시 폴더 보존 |

### 1.1 2차 리뷰 추가 반영

시험은 다시 돌리지 않고, 아래는 코드 수정과 기존 결과 JSON 재정제로 반영했다.

| 항목 | 반영 |
|---|---|
| 필수(경로 잔여) | `scrub()` 의 임시 경로 정규식을 접두 선택형으로 고치고(두 형태 모두), `short()` 가 **자르기 전에** `scrub()` 을 거치게 했다. `tool_evidence` 입력도 잘리기 전에 정제된다. 기존 `results-2026-11-05.json` 을 고친 `scrub()` 으로 다시 정제해 덮어썼다. |
| 권장 1(문서 표기) | 이번 3회는 모두 `라운드=1` 로 정정. 이전 시험의 `라운드=R1` 관찰은 "이전 시험"으로 명시 |
| 권장 2(SSE) | `urlopen(timeout=30)` 의 timeout 을 없애 `stop()` 의 close 로만 읽기를 풀게 했다. 연결이 끊기면 재접속하지 않고 error 로 끝난다(한계에 적음) |
| 권장 3(응답 판정 범위) | `summary.text` 를 **이번 프롬프트의 user 메시지 이후** assistant 텍스트로 한정 |
| 권장 4(`/api/shell`) | sleep 탐지·종료 확인을 `metadata.sessionID == sid` 로 거르고, idle 기준 시각을 중단 프롬프트 직전 epoch 로 바꿈 |
| 권장 5(디버그 출력) | `[debug]` stderr 출력을 `scrub()` 로 마스킹 |

## 2. 항목별 결과

| # | 항목 | 결과 | 비고 |
|---|---|---|---|
| 1 | 서버 정보·모델 목록 | **3/3 됨** | `/api/info` 200, `/api/model` 66개, 대상 모델 active |
| 2 | 공통 시나리오(재시작·재개 포함) | **3/3 됨** | 결과 JSON→merge/render→질문 화면→/feedback→pending/mark→서버 재시작→맥락 의존 재개 |
| 3 | 이벤트 스트림 | **3/3 됨** | 회차당 39~40개·22종, 실행 시작·종료 이벤트 확인 |
| 4 | 중단·재개·서버 재시작 | **3/3 됨** | sleep 실행 확인, interrupt, 같은 세션 재개, 재시작 후 복구 |
| 5 | 권한 승인·거부 | **3/3 됨** | once 승인 + shell/edit 실행, rm 거부 + keep.txt 보존 |
| 6 | 사용량 한도 | **3/3 됨** | 세 번 모두 Go rolling/weekly/monthly 필드 유효 |

### 2.1 서버 정보·모델 목록

| 회차 | 서버 기동~`/api/info` | `/api/info`+`/api/model` | 모델 수 | 대상 발견 | 상태 |
|---|---:|---:|---:|---|---|
| 1 | 324ms | 1,059ms | 66 | 예 | active |
| 2 | 314ms | 1,021ms | 66 | 예 | active |
| 3 | 312ms | 1,025ms | 66 | 예 | active |

- `/api/info`: `version=2.2.5`, URL 1개, `capabilities.persistentPty=true`.
- `/api/model`: `providerID=opencode-go`, `modelID=deepseek-v4.1-flash`, 이름 `DeepSeek V4.1 Flash`.
- 모델 가격 정보: input 0.15 / output 0.60 USD per 1M tokens (cache read 0.003).
- 인증: Basic 사용자 이름 `opencode`, 비밀번호는 서버가 기동 때 출력하는 값. 첫 요청이 401이면 이 인증이 빠진 것이다.

### 2.2 공통 시나리오 한 라운드 (답 처리 → 서버 재시작 → 재개)

흐름(회차마다 새 합성 프로젝트):

1. `pes.py round-start <proj> plan` → R1
2. 세션 생성(모델 지정) → 세션 environment 에 `PES_HOME` 설정
3. 프롬프트: 도구 안에서 `env-home.txt`·`env-project.txt` 작성 + `pes.py status` 실행 + `result.json` 작성
4. PES: `merge plan result.json` → `render plan` → `ask-prep plan` → `ask plan ask/plan-start.json`
5. `scripts/serve.py` 를 빈 포트에 띄우고 `POST /proj/feedback` (Origin 허용) → 답 파일 생성
6. `pes.py pending` → `pes.py mark` → `pending` 0개 확인
7. **개인 서버 종료 → 같은 포트에 재기동 → `GET /api/session/{sid}` 로 복구 확인**
8. 재개 프롬프트: 도구 환경 재확인 + 이전 `result.json` summary + 최근 feedback text + `status` 의 처리 안 한 답 개수를
   `plan-result.md` 에 쓰게 하고 내용 검증

| 회차 | 에이전트 1차 | PES 쪽 한 라운드 | 서버 재시작 | 세션 복구 | 재개 프롬프트 | 재개 검증 |
|---|---:|---:|---:|---|---:|---|
| 1 | 7,114ms | 324ms | 315ms | 성공 | 10,670ms | 성공 |
| 2 | 7,142ms | 328ms | 309ms | 성공 | 14,502ms | 성공 |
| 3 | 8,983ms | 322ms | 315ms | 성공 | 11,260ms | 성공 |

PES 쪽 세부(회차 1/2/3, ms):

| 단계 | 1 | 2 | 3 |
|---|---:|---:|---:|
| round-start | 96 | 94 | 92 |
| merge | 88 | 86 | 85 |
| render | 47 | 50 | 50 |
| ask-prep | 46 | 45 | 47 |
| ask | 45 | 51 | 46 |
| POST /feedback | 2 | 2 | 2 |

- 도구 환경(3/3): `env-home.txt` = 임시 `PES_HOME`, `env-project.txt` = 빈 문자열.
  재시작 뒤 `env-home-after-restart.txt` 도 임시 `PES_HOME` 이었다.
  (서버 프로세스 env 와 세션 environment API 중 어느 경로가 최종값인지는 구분하지 않았다. 둘 다 같은 값으로 설정했다.)
- `plan-result.md`(3/3)에 이전 `result.json` 의 summary, feedback text, `처리 안 한 답: 0` 이 모두 들어갔다.
  회차 1은 `0`, 회차 2·3은 `0개` 로 썼고, 검증은 `처리 안 한 답: 0` 부분 문자열로 했다.
- `ask-plan-start.html`, `index.html` 모두 생성(3/3). `pending` 1→0(3/3).
- 에이전트 토큰(1차): input 11,290 / 5,259 / 5,136, output 389 / 382 / 383.
- 재개 토큰은 세션 전체 누적이라 1차와 합산된다. 세션 `cost` 는 3회 모두 `0`(Go 구독), 토큰은 기록됨.

관찰:

- 1차 프롬프트는 7.1~9.0초, 재개는 10.7~14.5초로 변동이 있다. 재개는 파일 읽기·`status`·쓰기를 함께 해 더 길다.
- 모델은 `write` 도구로 `result.json`·`plan-result.md` 를 썼다. 권한 action 은 `edit` 이지만 도구 이름은 `write` 였다.
  어댑터는 **권한 action 과 도구 이름을 매핑**해야 한다.
- 이번 3회는 모두 `라운드=1` 로 썼다. 다만 **이전 시험에서 `라운드=R1` 표기를 관찰한 적이 있어**,
  고정 문자열 검증은 모델 출력에 취약하다. 시험 코드는 **이전 `result.json` 의 summary 값을 읽어**
  그 값이 `plan-result.md` 에 있는지로 검증한다.

### 2.3 이벤트 스트림

`GET /api/event` 는 SSE 로 `data: {...}` 를 흘려보낸다.

| 회차 | 이벤트 수 | 종류 수 | 첫 이벤트 | 실행 시작→종료 | 종료 이벤트 확인 |
|---|---:|---:|---:|---:|---|
| 1 | 40 | 22 | 51ms | 7,041ms | 예 |
| 2 | 39 | 22 | 49ms | 6,826ms | 예 |
| 3 | 39 | 22 | 51ms | 8,875ms | 예 |

받은 종류(예): `session.inbox.enqueued`, `session.execution.started`, `session.instructions.updated`,
`session.inbox.delivered`, `session.step.started/streamed/ended`, `session.text.started/delta/ended`,
`session.reasoning.started/delta/ended`, `session.tool.input.started/ended`, `session.tool.called`,
`session.tool.progress`, `session.tool.success`, `permission.asked`, `permission.replied`,
`session.usage.updated`, `session.execution.succeeded`.

- SSE 는 비동기다. idle 직후 마지막 이벤트가 늦게 올 수 있어, 시험 코드는
  `session.execution.succeeded|failed|interrupted` 를 최대 8초 기다린 뒤 집계한다.
- 진행 표시에는 `session.text.delta`, `session.reasoning.delta`, `session.tool.progress` 를 쓰면 된다.
- 이벤트 하나에 `sessionID`(또는 `durable.aggregateID`)가 있어 세션별 필터가 가능했다.

### 2.4 중단·재개·서버 재시작

| 회차 | sleep 실행 확인 | sleep→interrupt | interrupt 응답 | idle outcome | sleep 종료 | 같은 세션 재개 | 재시작 | 세션 복구 | 재시작 후 프롬프트 |
|---|---|---|---:|---|---|---|---:|---|---|
| 1 | running, pid 기록 | 2,483ms | `{"interrupted": true}` | interrupted | 확인 | 성공 | 313ms | 성공 | 성공 |
| 2 | running, pid 기록 | 2,282ms | `{"interrupted": true}` | interrupted | 확인 | 성공 | 312ms | 성공 | 성공 |
| 3 | running, pid 기록 | 1,859ms | `{"interrupted": true}` | interrupted | 확인 | 성공 | 314ms | 성공 | 성공 |

- 중단 대상은 `sleep 45 ; echo slow > slow.txt` 셸이었다. `/api/shell` 에서 `status=running`, `pid`, `command` 를 확인한 뒤 중단했다.
- interrupt 응답은 `{"interrupted": true}`, idle `outcome` 은 `interrupted`, interrupt→idle 은 4~14ms.
- 중단 뒤 `/api/shell` 에 running `sleep` 이 없었다(`sleep_gone` 3/3). 5초까지 재확인했다.
- 개인 서버를 **같은 포트**에서 껐다 켰다. 비밀번호는 새로 바뀌었고, 새 자격으로 `GET /api/session/{id}` 가 200,
  같은 세션에 `AFTER-RESTART` 프롬프트가 정상 응답했다.
- 서버 종료는 SIGTERM, 포트가 빌 때까지 최대 15초 대기. 재시작은 309~315ms.

### 2.5 권한 승인·거부

시험용 `opencode.json`:

```json
{
  "permissions": [
    { "action": "shell", "resource": "*", "effect": "ask" },
    { "action": "edit",  "resource": "*", "effect": "ask" }
  ]
}
```

**승인**(시나리오 증거)

| 회차 | once shell | once edit | shell 실제 실행 | edit(write) 실제 실행 | 결과 JSON |
|---|---:|---:|---|---|---|
| 1 | 2 | 2 | 예 | 예 | 유효 |
| 2 | 3 | 2 | 예 | 예 | 유효 |
| 3 | 2 | 2 | 예 | 예 | 유효 |

- `/api/permission/request` 를 poll 해서 **대상 세션의 요청만** `POST /api/session/{id}/permission/{requestID}/reply` 로 `{"decision":"once"}` 응답.
- 실제 실행은 메시지의 tool 상태(`status=completed`)로 확인했다. `edit` 권한은 도구 이름 `write` 로 실행됐다.

**거부**(별도 시험)

| 회차 | 거부 대상 | reject 응답 | keep.txt 보존 | 시도 횟수 |
|---|---|---|---:|---:|
| 1 | `rm -f keep.txt` | 성공 | 예 | 1 |
| 2 | `rm -f keep.txt` | 성공 | 예 | 1 |
| 3 | `rm -f keep.txt` | 성공 | 예 | 1 |

- 거부 시험은 `rm` 계열 명령만 `reject` 하고, `ls`/`cat` 같은 읽기는 `once` 로 허용했다.
  그래야 에이전트가 포기하지 않고 실제 삭제 요청까지 도달한다.
- 1·2회차는 `ls` 를 먼저 허용한 뒤 `rm -f keep.txt` 를 거부했고, 3회차는 `ls`/`wc` 를 허용한 뒤 `rm` 을 거부했다.
- `keep.txt` 는 3/3 그대로였다. 에이전트는 거부 후 삭제를 우회하지 않았다고 보고했다.
- **API enum 은 `once|always|reject`** 다. `allow/deny` 가 아니다. `always` 는 시험하지 않았다.
- 거부는 그 세션의 **다른 대기 요청도 함께 거부**한다(문서 설명과 일치). 재시도 루프를 돌릴 때 주의해야 한다.
- 기본 정책은 사실상 전부 allow 다. PES가 `ask`/`deny` 를 원하면 프로젝트 설정이나 세션 `permissions` 로 명시해야 한다.

### 2.6 사용량 한도

`GET /api/experimental/usage/limits` 는 3회 모두 200, `data.go` 필드 유효.

| 회차 | 응답 시간(3회) | rolling | weekly | monthly | limited | budgets |
|---|---|---:|---:|---:|---|---:|
| 1 | 599 / 626 / 273ms | 5% | 21% | 10% | false | 0 |
| 2 | 612 / 697 / 277ms | 5% | 21% | 10% | false | 0 |
| 3 | 604 / 582 / 270ms | 5% | 21% | 10% | false | 0 |

- 값은 Go 구독의 **비율·리셋 시각**이다. 회차별 토큰 예산이나 금액 상한은 없었다.
- 세션 `cost` 가 0으로 보고되므로, PES의 "라운드당 비용 상한"은 이 API만으로는 세울 수 없다.
  세션 `tokens`(input/output/cache)와 Go 미터를 함께 봐야 한다.

## 3. 됨 / 안 됨 / 일부·미확인

**됨**

- 개인 서버 기동·인증·종료, 모델 목록에서 대상 모델 확인.
- 세션 생성, 프롬프트, 메시지 조회, 파일 쓰기·셸 실행(권한 승인 포함).
- 공통 시나리오 한 라운드 전체 + **서버 재시작 후 세션 복구 + 맥락 의존 재개**.
- SSE 이벤트 스트림과 진행 상황.
- `/api/shell` 로 확인한 sleep 실행, interrupt, 같은 세션 재개, 재시작 후 복구.
- 권한 승인(`once`)·거부(`reject`)와 거부의 실제 차단.
- 사용량 한도 조회(세 번 모두 필드 유효).
- 시험 세션 삭제(204)와 포트 해제.

**일부**

- OpenCode `form` API: 스키마(`Form.CreatePayload`, `Form.Reply`, `form.created/replied` 이벤트)는 확인했지만
  실제 폼 생성·응답 왕복은 시험하지 않았다. 이번 사람 질문은 PES `ask`/`/feedback` 만 썼다.
- 사용량: Go 미터(%)만 있고 회차별 금액·토큰 예산은 없었다. 세션 `cost` 는 0.
- Windows: 이번 시험은 macOS 만. Windows 서비스 분리·종료·경로는 미확인.
- Python 3.9: `_stop` 충돌은 코드에서 제거했지만, 실행은 Python 3.15 에서만 했다. 3.9 실행은 미확인.
- 모델 변형(`low`/`high`/`max`)은 시험하지 않았다. 기본 variant 만 사용.
- 세션 environment API 는 3/3 성공했지만, 재시작 후 값이 프로세스 env 인지 세션 env 인지 구분하지 않았다.
- 권한 `always` 응답은 미확인.

**안 됨**

- 요구 항목 중 실패한 것은 없다. 다만 위 "일부"는 설계 전에 추가 확인이 필요하다.

## 4. 한계·주의

1. **인증 비밀번호**: `opencode serve` 가 기동 로그에 비밀번호를 1회 출력한다.
   시험 코드는 종료 시 로그를 마스킹하고, 예외·결과 JSON 저장 전에 비밀번호를 지운다.
   실제 PES 어댑터는 비밀 저장소(OS 키체인 등)에 넣고 로그를 마스킹해야 한다.
2. **전역 세션 저장소**: 세션은 서버 프로세스가 아니라 사용자 전역 저장소에 남는다. 서버를 재시작해도 복구되지만,
   여러 프로젝트·에이전트가 같은 저장소를 공유한다. PES는 프로젝트/단계/라운드로 세션을 이름 붙이고,
   끝나면 지우거나 보관 정책을 정해야 한다. 이번 시험은 만든 ID만 지웠고, 지운 뒤 목록에서 사라지는 것을 확인했다.
3. **셸 권한의 무게**: 셸은 호스트 사용자 권한으로 돈다. 권한 규칙이 유일한 게이트이고, 별도 샌드박스는 없었다.
   PES는 "프로젝트 안 읽기/쓰기 허용, 셸은 허용 목록, 외부 디렉터리·네트워크는 확인" 같은 정책을 명시해야 한다.
4. **전역 설정 유입**: 서버는 사용자 `~/.config/opencode/` 의 MCP(`rea`)를 함께 로드했다.
   시험에는 쓰지 않았지만, 제품에서는 전용 프로필/설정으로 격리하는 것이 좋다. 이번 시험은 사용자 설정을 바꾸지 않았다.
5. **SSE 지연·재접속**: idle 직후 마지막 이벤트가 늦게 온다. 종료 이벤트를 기다리지 않으면 진행률·지연을 과소 집계한다.
   timeout 은 없앴지만, 연결이 끊기면 **재접속하지 않고** error 로 끝난다. 이번 시험은 한 연결에서 끝났다.
   장시간 실행에서는 재접속·마지막 이벤트 ID 기반 복구가 필요하다(미구현).
6. **모델 품질 변동**: 같은 프롬프트에도 도구 호출 수와 지연이 달랐다(1차 7.1~9.0초, 재개 10.7~14.5초).
   이번 3회는 모두 `라운드=1` 이었지만, 이전 시험에서 `라운드=R1` 표기를 관찰했다.
   고정 문자열 검증은 모델 출력에 취약하므로, 시험 코드는 이전 결과 파일의 실제 값을 읽어 비교한다.
7. **비용**: Go 구독은 세션 `cost=0` 으로 보인다. 비용 상한은 토큰·미터 기반으로 설계해야 한다.
8. **버전 고정**: 이번 값은 v2.2.5 기준이다. `/openapi.json` 으로 기능을 감지하고, 어댑터 안에서 차이를 흡수해야 한다.
9. **Windows**: 프로세스 분리·종료·로그 위치는 미확인. 0단계 게이트에는 macOS 결과만 반영한다.
10. **도구 이름과 권한 action**: `edit` 권한 요청은 실제로 `write` 도구로 실행됐다. 어댑터는 둘을 매핑해야 한다.

## 5. 방식 A 설계 시사점

- **A2(HTTP 서버)는 실용적이다.** A1(CLI one-shot)은 스트리밍·권한·세션 재개가 약하므로,
  PES는 A2를 기본으로 하고 A1을 스모크/폴백으로 두는 것이 맞다.
- **질문의 원본은 PES.** 연구 질문은 PES `ask`/`/feedback`/DB가 원본이고,
  OpenCode `form`/`permission` 은 "도구 실행 승인" 같은 실행 수준으로만 쓴다. 두 저장소를 만들지 않는다.
- **어댑터 책임**: 개인 서버 수명(기동·종료·재시작), 비밀번호 보관, 세션↔(프로젝트·단계·라운드) 매핑,
  이벤트→PES 진행 표시 변환, 권한 요청→PES 대시보드 프록시, 중단·재개, 도구 이름↔권한 action 매핑.
- **환경 주입**: 서버 프로세스 env 만 믿지 말고 세션 environment API 로 `PES_HOME` 을 명시하고,
  도구가 실제로 그 값을 보는지 확인하는 진단을 둔다. `PES_PROJECT` 같은 상속 변수는 지운다.
- **세션 매핑**: `project_id/stage/round` 를 세션 metadata 나 PES DB에 저장한다. 서버 재시작 후에도 ID로 복구되므로
  "세션이 사라졌다"를 전제로 한 재시도 설계는 필요 없다. 대신 고아 세션 정리 정책이 필요하다.
- **권한 정책**: PES 프로젝트 설정에서 `read`/`edit`/`shell`/`external_directory` 규칙을 만들고,
  `ask` 는 PES 대시보드로 프록시한다. `reject` 는 세션의 다른 대기 요청까지 거부하므로 UX에 반영한다.
  위험 명령만 거부하는 정책이 에이전트의 작업 지속성에 유리했다.
- **중단·재개**: `interrupt` 는 즉시 먹고 세션이 살아 있다. `/api/shell` 로 실행 중인 셸을 식별하고,
  중단 후 종료 여부를 확인할 수 있다. 사람이 답하는 동안 멈추고, 답이 오면 같은 세션에 이어 보내는 흐름이 가능하다.
- **사용량**: Go 미터는 "한도에 얼마나 찼는지"만 준다. 라운드별 토큰·비용 상한은 PES가 세션 토큰을 집계해 따로 건다.
- **보안**: 서버는 `127.0.0.1` 에만, 비밀번호는 비밀 저장소에, 로그 마스킹, `--service` 금지(시험·개발),
  사용자 전역 설정과 분리된 프로필, 세션 삭제·보관 정책.
- **버전·기능 감지**: `/api/info` 의 version, `/openapi.json` 의 경로 존재 여부로 기능을 감지한다.

## 6. 재현

```bash
# 저장소 루트에서, opencode-go 로그인 상태
python3 docs/plan/spikes/mode-a/mode_a_spike.py --repeats 3
```

- 표준출력에 항목별 성공 횟수·지연이 나온다.
- 결과 JSON 은 임시 폴더의 `result.json` 에 쓰인다. 기본 실행은 임시 폴더와 함께 지우므로,
  보관하려면 `--out` 으로 저장소 밖 경로를 지정한다. 이 문서의 원시 결과는
  [`spikes/mode-a/results-2026-11-05.json`](spikes/mode-a/results-2026-11-05.json) 에 있다.
- `--repeats` 는 1 이상. 실패·정리 미완이면 종료 코드 1, 모두 통과하면 0.

## 7. 정리 확인

- 최종 3회에서 회차당 세션 3개(시나리오·중단·권한 거부)를 만들고 모두 `DELETE /api/session/{id}` 로 삭제(204).
  `leftover_ids` 0, `still_present` 0.
- 최종 3회의 개인 서버 포트 `64151`, `64785`, `65350` 은 모두 종료 후 비었음을 확인했다(`port_free: true`).
- `opencode serve` 프로세스는 남아 있지 않다. `sleep 45` 잔여 프로세스도 없다.
- 임시 폴더는 성공 실행에서 지웠다. 실패·정리 미완 시에는 남은 세션 ID 보존을 위해 남기는 경로를 코드에 두었다.
- 사용자의 `~/.config/opencode/` 와 기존 세션은 수정·삭제하지 않았다. 다른 작업자의 `opencode service` 는 건드리지 않았다.
- 결과 JSON에서 사용자 홈 디렉터리 경로, 임시 폴더 경로 조각, 서버 비밀번호가 없음을 확인했다.
  2차 리뷰에서 지적된 경로 조각 6곳은 고친 `scrub()` 으로 기존 JSON을 재정제해 제거했고, 재확인 grep 결과는 0이다.
