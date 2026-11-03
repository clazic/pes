# 방식 A 시험 — opencode 서버 API (SEL-18)

- 확인일: 2026-11-04
- 환경: macOS 27.2 (arm64, m5), Python 3.15.2, opencode `v2.2.5` (`/opt/homebrew/bin/opencode`)
- 모델: `opencode-go/deepseek-v4.1-flash` **하나만** 사용 (사용자 결정)
- 시험 코드: [`spikes/mode-a/mode_a_spike.py`](spikes/mode-a/mode_a_spike.py), 실행법 [`spikes/mode-a/README.md`](spikes/mode-a/README.md)
- 시험 자료: 임시 폴더의 **합성** PES 프로젝트. 실제 연구 자료·`~/pes-projects`·`~/.pes` 는 읽거나 쓰지 않았다.
- 반복: 항목별 3회. 아래 값은 회차별 실측이다.

## 0. 요약

**6개 항목 모두 3/3 성공.** `opencode serve` + HTTP API(A2)로 PES의 공통 시나리오 한 라운드,
이벤트 스트림, 중단·재개, 개인 서버 재시작 후 세션 복구, 권한 승인·거부, 사용량 한도 조회가 모두 동작했다.
제품 코드는 바꾸지 않았고, 시험 중 만든 세션은 API로 삭제했으며, 띄운 서버는 모두 종료하고 포트가 빈 것을 확인했다.

가장 중요한 설계 확인:

- **PES 질문은 PES가 원본으로 두는 것이 맞다.** 이 시험의 사람 질문은 PES `ask`/`POST /feedback` 으로만 왕복했고,
  OpenCode `form`/`permission` 은 **실행 수준**(도구 승인)으로 분리했다. 두 질문 저장소를 만들 필요가 없었다.
- 세션은 서버 프로세스가 아니라 **전역 저장소**에 남는다. 개인 서버를 껐다 켜도 같은 세션 ID로 이어 쓸 수 있었고,
  `DELETE /api/session/{id}` 로 지울 수 있었다(204).
- `interrupt` 는 즉시 먹고(응답 `{"interrupted": true}`, idle `interrupted`, 9~12ms),
  같은 세션에 다시 프롬프트를 보내면 이어서 동작했다.
- 권한은 프로젝트 `opencode.json` 의 `permissions`(`action`/`resource`/`effect`)로 `ask` 를 걸고,
  API로 `once`/`reject` 응답이 가능했다. 거부하면 실제 셸 명령이 실행되지 않았다.

## 1. 시험 조건과 안전

- 저장소 밖 `mktemp -d` 임시 폴더에 `PES_HOME` 을 두고 `python3 scripts/pes.py init <임시>/proj --topic ...` 로 합성 프로젝트를 만들었다.
- `opencode serve --hostname 127.0.0.1 --port <빈 포트>` 만 사용했다. `--service`/`opencode service` 는 쓰지 않았고,
  기존 백그라운드 서비스는 조회·중지·재시작하지 않았다.
- 시험용 권한 설정은 임시 프로젝트 폴더의 `opencode.json` 에만 두었다. `~/.config/opencode/` 는 수정하지 않았다.
- 서버는 HTTP Basic 인증(`opencode:<server password>`)을 요구했다. 비밀번호는 기동 로그에 한 번 나오며,
  시험 코드는 이를 화면·저장소에 남기지 않고 임시 로그와 함께 지운다.
- 시험에서 만든 세션 ID 만 `DELETE /api/session/{id}` 로 지웠다. 다른 세션은 건드리지 않았다.

## 2. 항목별 결과

| # | 항목 | 결과 | 비고 |
|---|---|---|---|
| 1 | 서버 정보·모델 목록 | **3/3 됨** | `/api/info` 200, `/api/model` 66개, 대상 모델 active |
| 2 | 공통 시나리오 한 라운드 | **3/3 됨** | 결과 JSON→merge/render→질문 화면→/feedback→pending/mark→재개 |
| 3 | 이벤트 스트림 | **3/3 됨** | `/api/event` SSE, 회차당 40개·23종 |
| 4 | 중단·재개·서버 재시작 | **3/3 됨** | interrupt, 같은 세션 재개, 재시작 후 복구 |
| 5 | 권한 승인·거부 | **3/3 됨** | shell·edit `once` 승인, `reject` 거부, 파일 보존 확인 |
| 6 | 사용량 한도 | **3/3 됨** | Go rolling/weekly/monthly % 조회 |

### 2.1 서버 정보·모델 목록

| 회차 | 서버 기동~`/api/info` | `/api/info`+`/api/model` | 모델 수 | 대상 발견 | 상태 |
|---|---:|---:|---:|---|---|
| 1 | 327ms | 1,116ms | 66 | 예 | active |
| 2 | 313ms | 1,014ms | 66 | 예 | active |
| 3 | 310ms | 998ms | 66 | 예 | active |

- `/api/info`: `version=2.2.5`, URL 1개, `capabilities.persistentPty=true`.
- `/api/model` 응답의 `providerID=opencode-go`, `modelID=deepseek-v4.1-flash`, 이름 `DeepSeek V4.1 Flash`.
- 모델 가격 정보: input 0.15 / output 0.60 USD per 1M tokens (cache read 0.003).
- 인증: Basic 사용자 이름 `opencode`, 비밀번호는 서버가 기동 때 출력하는 값. 첫 요청이 401이면 이 인증이 빠진 것이다.

### 2.2 공통 시나리오 한 라운드

흐름(회차마다 새 합성 프로젝트):

1. `pes.py round-start <proj> plan` → R1
2. 세션 생성(모델 지정) → 프롬프트: `pes.py status` 실행 + `result.json` 작성
3. PES: `merge plan result.json` → `render plan` → `ask-prep plan` → `ask plan ask/plan-start.json`
4. `scripts/serve.py` 를 빈 포트에 띄우고 `POST /proj/feedback` (Origin 허용) → 답 파일 생성
5. `pes.py pending` → `pes.py mark` → `pending` 0개 확인
6. 같은 세션에 재개 프롬프트: `status` 재확인 + `plan-result.md` 작성

| 회차 | 에이전트 1차 프롬프트 | PES 쪽 한 라운드 | 재개 프롬프트 | pending→mark | 결과 JSON |
|---|---:|---:|---:|---|---|
| 1 | 4,394ms | 316ms | 20,729ms | 1→0 | 유효 |
| 2 | 5,292ms | 312ms | 6,200ms | 1→0 | 유효 |
| 3 | 4,090ms | 330ms | 14,863ms | 1→0 | 유효 |

PES 쪽 세부(회차 1/2/3, ms):

| 단계 | 1 | 2 | 3 |
|---|---:|---:|---:|
| round-start | 88 | 91 | 91 |
| merge | 84 | 82 | 99 |
| render | 51 | 47 | 48 |
| ask-prep | 46 | 45 | 45 |
| ask | 45 | 45 | 45 |
| POST /feedback | 2 | 2 | 2 |

- `ask-plan-start.html`, `index.html`, `plan-result.md` 모두 생성됨(3/3).
- 에이전트가 만든 `result.json` 예: `{"id":"plan-agent-1","title":"합성 기획 항목","summary":"현재 단계=기획, 라운드=1","confidence":"medium"}`.
- 에이전트 토큰(1차): input 13,172 / 6,750 / 5,097, output 338 / 329 / 333.
- 재개 토큰: input 23,344 / 8,085 / 7,634, output 1,419 / 721 / 1,279.
- 세션 `cost` 는 3회 모두 `0` 으로 보고됐다(Go 구독). 토큰은 정상 기록됐다.

관찰:

- 재개 프롬프트 지연 변동이 크다(6.2~20.7초). 같은 세션에 맥락이 쌓여 입력 토큰이 늘고, 모델이 `ls` 를 한 번 더 실행하는 회차가 있었다.
- 1차 프롬프트에서도 회차에 따라 도구 호출 수가 달랐다(권한 요청 4~8회).
- "이번 라운드 할 일 3개를 적어라" 지시에 대해, `status` 의 할 일이 0개라며 **없는 항목을 지어내지 않고 사실만 기록**한 회차가 있었다.
  지시 준수는 과제 문구에 민감하다. PES 쪽에서 "할 일"과 "제안"을 구분해 프롬프트에 넣는 편이 낫다.

### 2.3 이벤트 스트림

`GET /api/event` 는 SSE 로 `data: {...}` 를 흘려보낸다. 회차당 **40개, 23종**을 받았다.

| 회차 | 이벤트 수 | 종류 수 | 실행 시작→종료 | 종료 이벤트 확인 |
|---|---:|---:|---:|---|
| 1 | 40 | 23 | 4,386ms | 예 |
| 2 | 40 | 23 | 5,030ms | 예 |
| 3 | 40 | 23 | 3,799ms | 예 |

받은 종류(회차 1): `session.created`, `session.inbox.enqueued`, `session.execution.started`,
`session.instructions.updated`, `session.inbox.delivered`, `session.step.started/streamed/ended`,
`session.text.started/delta/ended`, `session.reasoning.started/delta/ended`,
`session.tool.input.started/ended`, `session.tool.called`, `session.tool.progress`, `session.tool.success`,
`permission.asked`, `permission.replied`, `session.usage.updated`, `session.execution.succeeded`.

주의:

- SSE 는 비동기다. 메시지 목록에서 idle 을 본 직후에는 마지막 이벤트가 아직 도착하지 않을 수 있었다.
  시험 코드는 `session.execution.succeeded|failed|interrupted` 를 최대 8초 기다린 뒤 집계한다.
  이 보정 없이는 이벤트 수·실행 구간이 과소 집계됐다.
- 진행 표시에는 `session.text.delta`, `session.reasoning.delta`, `session.tool.progress` 를 쓰면 된다.
- 이벤트 하나에 `sessionID`(또는 `durable.aggregateID`)가 있어 세션별 필터가 가능했다.

### 2.4 중단·재개·서버 재시작

| 회차 | interrupt 응답 | idle outcome | interrupt→idle | 같은 세션 재개 | 재시작 | 세션 복구 | 재시작 후 프롬프트 |
|---|---|---|---:|---|---:|---|---|
| 1 | `{"interrupted": true}` | interrupted | 12ms | 성공 | 315ms | 성공 | 성공 |
| 2 | `{"interrupted": true}` | interrupted | 9ms | 성공 | 316ms | 성공 | 성공 |
| 3 | `{"interrupted": true}` | interrupted | 12ms | 성공 | 317ms | 성공 | 성공 |

- 중단 대상은 `sleep 30` 셸 명령이었다. interrupt 뒤 idle 이 `interrupted` 로 끝났고, 같은 세션에 `RESUME-OK` 프롬프트가 정상 응답했다.
- 개인 서버를 **같은 포트**에서 껐다 켰다. 비밀번호는 새로 바뀌었고, 새 자격으로 `GET /api/session/{id}` 가 200,
  같은 세션에 `AFTER-RESTART` 프롬프트가 정상 응답했다.
- 중단 후 `sleep 30` 잔여 프로세스는 관찰되지 않았다.
- 서버 종료는 SIGTERM 으로 했고, 포트가 빌 때까지 최대 15초 기다렸다. 재시작까지 315~317ms.

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

- 승인: `/api/permission/request` 를 poll 해서 `POST /api/session/{id}/permission/{requestID}/reply` 에
  `{"decision":"once"}` 로 응답했다. 회차당 8 / 4 / 7건 모두 204.
  실제로 승인된 action 은 `shell`(예: `pes.py status`, `ls`)과 `edit`(예: `result.json`, `plan-result.md`)였다.
- 거부: `{"decision":"reject"}`. 회차당 1건 이상 거부했고, `keep.txt` 는 3/3 그대로 남았다.
  에이전트는 "셸 도구에서 permission.rejected 로 거부되었고, 다른 경로로 우회하지 않았다"고 보고했다.
- **API enum 은 `once|always|reject`** 다. `allow/deny` 가 아니다. 처음에 `allow` 를 보내 400(`Expected Permission.Reply`)을 받았다.
- 거부는 그 세션의 **다른 대기 요청도 함께 거부**한다(문서 설명과 일치). 재시도 루프를 돌릴 때 주의해야 한다.
- 기본 정책은 사실상 전부 allow 다. PES가 `ask`/`deny` 를 원하면 프로젝트 설정이나 세션 `permissions` 로 명시해야 한다.
  "권한 요청이 오면"이 아니라 "우리가 걸어야 온다"가 정확하다.

### 2.6 사용량 한도

`GET /api/experimental/usage/limits` 는 3회 모두 200, `data` 존재.

| 회차 | 응답 시간(3회) | rolling | weekly | monthly | limited | budgets |
|---|---|---:|---:|---:|---|---:|
| 1 | 611 / 589 / 269ms | 3% | 18% | 9% | false | 0 |
| 2 | 601 / 615 / 356ms | 3% | 18% | 9% | false | 0 |
| 3 | 626 / 545 / 293ms | 3% | 18% | 9% | false | 0 |

- 값은 Go 구독의 **비율·리셋 시각**이다. 회차별 토큰 예산이나 금액 상한은 없었다.
- 세션 `cost` 가 0으로 보고되므로, PES의 "라운드당 비용 상한"은 이 API만으로는 세울 수 없다.
  세션 `tokens`(input/output/cache)와 Go 미터를 함께 봐야 한다.

## 3. 됨 / 안 됨 / 일부

**됨**

- 개인 서버 기동·인증·종료, 모델 목록에서 대상 모델 확인.
- 세션 생성, 프롬프트, 메시지 조회, 파일 쓰기·셸 실행(권한 승인 포함).
- 공통 시나리오 한 라운드 전체(PES `status`→`result.json`→`merge`/`render`→`ask`→`/feedback`→`pending`/`mark`→재개).
- SSE 이벤트 스트림과 진행 상황.
- interrupt, 같은 세션 재개, 개인 서버 재시작 후 세션 복구.
- 권한 승인·거부와 거부의 실제 차단.
- 사용량 한도 조회.
- 시험 세션 삭제(204)와 포트 해제.

**일부**

- OpenCode `form` API: 스키마(`Form.CreatePayload`, `Form.Reply`, `form.created/replied` 이벤트)는 확인했지만
  실제 폼 생성·응답 왕복은 시험하지 않았다. 이번 사람 질문은 PES `ask`/`/feedback` 만 썼다.
- 사용량: Go 미터(%)만 있고 회차별 금액·토큰 예산은 없었다. 세션 `cost` 는 0.
- Windows: 이번 시험은 macOS 만. Windows 서비스 분리·종료·경로는 미확인.
- 모델 변형(`low`/`high`/`max`)은 시험하지 않았다. 기본 variant 만 사용.
- `PES_HOME` 은 서버 프로세스 환경에 자동으로 없었다. 프롬프트의 셸 명령에 `PES_HOME=...` 을 직접 붙여 해결했다.
  실제 어댑터는 세션 환경(`PUT /api/session/{id}/environment`)이나 서버 기동 환경으로 넣는 편이 낫다(미시험).

**안 됨**

- 요구 항목 중 실패한 것은 없다. 다만 위 "일부"는 설계 전에 추가 확인이 필요하다.

## 4. 한계·주의

1. **인증 비밀번호**: `opencode serve` 가 기동 로그에 비밀번호를 1회 출력한다. 이 로그를 공개하거나 커밋하면 안 된다.
   PES 어댑터는 비밀 저장소(예: OS 키체인, 홈 밖 파일)에 넣고 로그를 마스킹해야 한다.
2. **전역 세션 저장소**: 세션은 서버 프로세스가 아니라 사용자 전역 저장소에 남는다. 서버를 재시작해도 복구되지만,
   여러 프로젝트·에이전트가 같은 저장소를 공유한다. PES는 프로젝트/단계/라운드로 세션을 이름 붙이고,
   끝나면 지우거나 보관 정책을 정해야 한다. 이번 시험은 만든 ID만 지웠고, 지운 뒤 목록에서 사라지는 것을 확인했다.
3. **셸 권한의 무게**: 셸은 호스트 사용자 권한으로 돈다. 권한 규칙이 유일한 게이트이고, 별도 샌드박스는 없었다.
   PES는 "프로젝트 안 읽기/쓰기 허용, 셸은 허용 목록, 외부 디렉터리·네트워크는 확인" 같은 정책을 명시해야 한다.
4. **전역 설정 유입**: 서버는 사용자 `~/.config/opencode/` 의 MCP(`rea`)를 함께 로드했다.
   시험에는 쓰지 않았지만, 제품에서는 전용 프로필/설정으로 격리하는 것이 좋다. 이번 시험은 사용자 설정을 바꾸지 않았다.
5. **SSE 지연**: idle 직후 마지막 이벤트가 늦게 온다. 종료 이벤트를 기다리지 않으면 진행률·지연을 과소 집계한다.
6. **모델 품질 변동**: 같은 프롬프트에도 도구 호출 수와 지연이 달랐다(1차 4.1~5.3초, 재개 6.2~20.7초).
   "할 일 3개" 같은 지시는 status 값과 충돌하면 모델이 거부할 수 있다. 프롬프트에 사실과 제안을 분리해 넣어야 한다.
7. **비용**: Go 구독은 세션 `cost=0` 으로 보인다. 비용 상한은 토큰·미터 기반으로 설계해야 한다.
8. **버전 고정**: 이번 값은 v2.2.5 기준이다. `/openapi.json` 으로 기능을 감지하고, 어댑터 안에서 차이를 흡수해야 한다.
9. **Windows**: 프로세스 분리·종료·로그 위치는 미확인. 0단계 게이트에는 macOS 결과만 반영한다.

## 5. 방식 A 설계 시사점

- **A2(HTTP 서버)는 실용적이다.** A1(CLI one-shot)은 스트리밍·권한·세션 재개가 약하므로,
  PES는 A2를 기본으로 하고 A1을 스모크/폴백으로 두는 것이 맞다.
- **질문의 원본은 PES.** 연구 질문은 PES `ask`/`/feedback`/DB가 원본이고,
  OpenCode `form`/`permission` 은 "도구 실행 승인" 같은 실행 수준으로만 쓴다. 두 저장소를 만들지 않는다.
- **어댑터 책임**: 개인 서버 수명(기동·종료·재시작), 비밀번호 보관, 세션↔(프로젝트·단계·라운드) 매핑,
  이벤트→PES 진행 표시 변환, 권한 요청→PES 대시보드 프록시, 중단·재개.
- **세션 매핑**: `project_id/stage/round` 를 세션 metadata 나 PES DB에 저장한다. 서버 재시작 후에도 ID로 복구되므로
  "세션이 사라졌다"를 전제로 한 재시도 설계는 필요 없다. 대신 고아 세션 정리 정책이 필요하다.
- **권한 정책**: PES 프로젝트 설정에서 `read`/`edit`/`shell`/`external_directory` 규칙을 만들고,
  `ask` 는 PES 대시보드로 프록시한다. `reject` 는 세션의 다른 대기 요청까지 거부하므로 UX에 반영한다.
- **중단·재개**: `interrupt` 는 즉시 먹고 세션이 살아 있다. 사람이 답하는 동안 에이전트를 멈추고,
  답이 오면 같은 세션에 이어 보내는 흐름이 가능하다. 단, 도구가 실행 중이면 중단 후 잔여 프로세스·파일을 점검해야 한다.
- **사용량**: Go 미터는 "한도에 얼마나 찼는지"만 준다. 라운드별 토큰·비용 상한은 PES가 세션 토큰을 집계해 따로 건다.
- **보안**: 서버는 `127.0.0.1` 에만, 비밀번호는 비밀 저장소에, 로그 마스킹, `--service` 금지(시험·개발),
  사용자 전역 설정과 분리된 프로필, 세션 삭제·보관 정책.
- **버전·기능 감지**: `/api/info` 의 version, `/openapi.json` 의 경로 존재 여부로 기능을 감지한다.
- **PES_HOME**: 에이전트 셸에 PES 환경을 넣는 경로(세션 environment 또는 서버 env)를 어댑터가 책임진다.
  프롬프트에 매번 `PES_HOME=...` 을 붙이는 방식은 임시 시험용이다.

## 6. 재현

```bash
# 저장소 루트에서, opencode-go 로그인 상태
python3 docs/plan/spikes/mode-a/mode_a_spike.py --repeats 3
```

- 표준출력에 항목별 성공 횟수·지연이 나온다.
- 기본 실행은 임시 폴더를 지운다. 로그를 보려면 `--keep`(비밀번호 포함, 공유 금지).
- 결과 JSON 은 임시 폴더의 `result.json` 에 쓰인다. 기본 실행은 임시 폴더와 함께 지우므로,
  보관하려면 `--out` 으로 저장소 밖 경로를 지정한다.
- 이 문서의 수치는 2026-11-04 회차의 실측이다. 모델·네트워크 상태에 따라 달라진다.

## 7. 정리 확인

- 최종 3회에서 만든 세션 9개(회차당 시나리오·중단·권한 거부 3개)와 디버깅 중 남은 세션 9개를
  `DELETE /api/session/{id}` 로 삭제(모두 204). 삭제 후 같은 제목의 남은 세션 0개를 확인했다.
- 최종 3회의 개인 서버 포트 `49235`, `49774`, `50049` 는 모두 종료 후 비었음을 확인했다(`port_free: true`).
  정리용 서버 포트 `50433` 도 비었다.
- `opencode serve` 프로세스는 남아 있지 않다. `sleep 30` 잔여 프로세스도 없다.
- 임시 폴더(`pes-sel18-mode-a-*`, `sel18-dbg-*`)는 지웠다.
- 사용자의 `~/.config/opencode/` 와 기존 세션은 수정·삭제하지 않았다. 다른 작업자의 `opencode service` 는 건드리지 않았다.
