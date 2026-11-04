# 방식 B 시험 — Claude Code ↔ PES 왕복·재개 (SEL-19)

- 확인일: 2026-11-05
- 환경: macOS, Python 3.15.2, Claude Code **2.1.317**, 모델 `claude-sonnet-5-5`
- 범위: Claude Code **비대화형(`-p`)**만 실행했다. Claude 앱은 연결 방법만 조사했고 실행하지 않았다.
  Codex·OpenCode TUI는 이 시험 범위가 아니다.
- 재현: [`mode-b/README.md`](mode-b/README.md), [`mode-b/run_spike.py`](mode-b/run_spike.py),
  [`mode-b/probe_permissions.py`](mode-b/probe_permissions.py),
  [`mode-b/probe_continue.py`](mode-b/probe_continue.py),
  [`mode-b/probe_lock_agent.py`](mode-b/probe_lock_agent.py)
- 원자료: [`mode-b/logs/`](mode-b/logs/) (`run.log`, `claude-*.json`, `pes-calls.log`, `summary.json`,
  `permission-probe.json`, `continue-probe.json`, `lock-agent-probe.json`)
- 이 문서는 리뷰(CHANGES) 뒤 **재시험한 결과**다. 이전 기록(a6d4c57)은 Claude 권한이 시험 디렉터리로
  강제되지 않았고, 직접 편집·잠금 탐침 판정이 자기 보고에 의존했다. 이번 기록이 그 판정을 대체한다.

## 0. 격리와 권한 한정

### 0.1 PES·서버

- 합성 프로젝트만 썼다. `PES_HOME=<임시>/home`, 프로젝트 `<임시>/home/proj`, 주제 "합성 주제".
- `scripts/pes.py`는 항상 `PES_HOME=<임시>/home`으로 실행했다. `PES_HOME`이 설정되면 `pes.py`는
  `~/.pes/config.json`을 읽지 않는다(`scripts/pes.py:77-86`).
- `scripts/serve.py`는 `trusted_origins`를 `Path.home()/.pes/config.json`에서 읽는다
  (`scripts/serve.py:31-38`). **서버 프로세스의 `HOME`도 `<임시>/home`으로** 바꿨다.
  실제 `~/.pes`를 읽었는지는 별도 계측하지 않았다(미확인). 코드상 서버의 홈 경로는 임시 홈이다.
- `claude -p`는 인증 때문에 실제 `HOME`을 그대로 썼다. `~/.claude` 설정 파일은 바꾸지 않았다.
  (Claude Code가 평소처럼 세션 기록을 `~/.claude` 아래에 남겼을 수는 있다.)

### 0.2 Claude Code 권한 (핵심 수정)

이번 시험은 `Bash(python3:*)`를 쓰지 않는다. 임의 Python·다른 경로 스크립트를 허용하지 않기 위해서다.

- 작업 디렉터리: `<임시>/home/proj`
- Bash 허용: `<임시>/bin/pes:*` **하나만**. 이 실행 파일은 PES CLI 검증 래퍼다.
- 파일 도구 허용: `Read(//<임시>/home/proj/**)`, `Write(//<임시>/home/proj/**)`,
  `Edit(//<임시>/home/proj/**)` — 프로젝트 폴더 아래만.
- 파일 도구 거부: `project.json`, `.pes-lock`의 Write/Edit(절대·상대 경로 규칙 모두).
- `--add-dir`로 저장소 `scripts/`를 열지 않았다. 에이전트는 래퍼를 통해 PES를 실행하고,
  래퍼가 저장소의 `scripts/pes.py`를 실행한다. 따라서 에이전트 도구 권한으로 제품 코드를 **쓸 수 없다**
  (쓰기 거부는 permission probe에서 확인). 루트 밖 **읽기** 거부는 이번 탐침 항목에 넣지 않았다(미시험).
- `--dangerously-skip-permissions`는 쓰지 않았다.
- `--max-turns 30`은 2.1.317에서 정상 동작했다.

검증 래퍼(`<임시>/bin/pes`)가 하는 일:

- 허용 명령(`lock`, `unlock`, `status`, `pending`, `mark`, `merge`, `render`, `ask-prep`, `ask`,
  `round-start`, `note`)만 실행한다.
- `--force`를 거부한다.
- 절대 경로 인자가 시험 루트 밖이면 exit 2로 거부한다.
- 호출마다 argv·exit·stdout/stderr·`project.json` 전후 해시를 `logs/pes-calls.log`에 남긴다.

### 0.3 권한 한정이 실제로 걸렸는지 (permission probe)

`probe_permissions.py`가 별도 합성 프로젝트에서 같은 권한 설정으로 6가지를 시도했다.
결과는 [`mode-b/logs/permission-probe.json`](mode-b/logs/permission-probe.json)에 있다. 11개 검사 모두 통과.

| 시도 | 결과 | 원자료 |
|---|---|---|
| Write로 시험 루트 밖 `escape.txt` 만들기 | 거부, 파일 없음 | `permission_denials`에 Write 기록 |
| Write로 저장소 `scripts/.sel19-escape.txt` 만들기 | 거부, 파일 없음 | `permission_denials`에 Write 기록 |
| Write로 `project.json` 덮어쓰기 | 거부, 해시 불변 | `permission_denials`에 Write 기록 |
| Bash로 `python3 -c "print('escape')"` | 거부 | `permission_denials`에 Bash 기록 |
| 래퍼로 시험 루트 밖 `status` | exit 2, 래퍼가 거부 | `wrapper_calls`에 rejected 기록 |
| 래퍼로 프로젝트 안 `status` | exit 0 | `wrapper_calls`에 정상 기록 |

- 이 시험은 Claude Code의 **도구 권한 규칙**을 확인한 것이다. OS 수준 sandbox는 아니다.
  래퍼는 저장소의 `pes.py`를 사용자 권한으로 실행하므로, 래퍼 자체의 검증이 두 번째 방어선이다.
- `--restricted` 모드는 파일 도구를 cwd로 묶지만, 이 환경에서는 호출당 캐시 생성이 50만 토큰대로
  늘어 비용이 크게 뛰었다(참고: 한 번의 `status` 호출이 약 $2). 그래서 경로 한정 `--allowedTools`로
  같은 목적을 달성했다. 이 선택과 비용 차이는 시험 환경의 관찰이다.

## 1. 결과 요약

`run_spike.py`는 각 단계의 기대 exit·응답·파일·세션 관계·미처리→처리 전이를 검사하고,
하나라도 실패하면 비영(1)으로 끝난다. 이번 실행은 **필수 검사 전부 통과, exit 0**이다
([`mode-b/logs/summary.json`](mode-b/logs/summary.json)).

| 단계 | 결과 | 근거 |
|---|---|---|
| 합성 프로젝트 `init` | 통과 | exit 0, `project.json` 파싱 |
| 권한 한정 probe | 통과 | 11/11 검사, 거부 4건, 탈출 파일 없음 |
| `serve.py` 기동·`/ping` | 통과 | `/ping` 200 |
| 1라운드: `lock`→`status`→결과 JSON→`merge`/`render`→`ask-prep`/`ask` | 통과 | 9턴, PES 호출 7회, 질문 HTML 생성 |
| 사람 답 흉내 1 `POST /feedback` | 통과 | 200, `pending` 1개 |
| 재개 1: `claude -p --resume` | 통과 | 같은 세션, 7턴, R1, 미처리 0 |
| 사람 답 흉내 2 | 통과 | 200, `pending` 1개 |
| 재개 2: `claude -p --continue` | 통과 | 같은 세션, 9턴, R2, 항목 [1,2], 미처리 0 |
| 사람 답 흉내 3 | 통과 | 200, `pending` 1개 |
| 재개 3: 새 세션 | 통과 | 새 세션, 7턴, `pending`만 보고 처리, 미처리 0 |
| agent-b Claude `lock` | 통과(차단) | 래퍼 호출 exit 3, "다른 세션" 메시지, 소유자 agent-a 유지 |
| CLI 잠금 `lock`/`merge`/`--force`/`unlock` | 통과 | exit 3/3/0/3/0, 강제 탈취 후 원 소유자 쓰기 차단 |
| 최종 `GET /proj/` | 통과 | 200, 89,183 bytes |
| 서버·포트 정리 | 통과 | serve.py 종료, 포트 54339 리스너 없음 |

## 2. 단계별 기록

### 2.1 1라운드 (새 세션)

- 호출: `claude -p "<지시>" --model claude-sonnet-5-5 --max-turns 30 --output-format json`
  (하네스는 PATH에서 `claude`를 찾아 실행한다. `shutil.which`를 쓰지 않는다.)
  - `--allowedTools "Bash(<임시>/bin/pes:*)" "Read(//<임시>/home/proj/**)" "Write(//<임시>/home/proj/**)" "Edit(//<임시>/home/proj/**)"`
  - `--disallowedTools "Write(//<임시>/home/proj/project.json)" "Edit(//<임시>/home/proj/project.json)"` 등(0.2절)
- 권한: 0.2절의 경로 한정 규칙. 환경: `PES_HOME=<임시>/home`, `PES_OWNER=agent-a`,
  작업 디렉터리 `<임시>/home/proj`.
- 에이전트가 실제로 부른 PES CLI(순서대로):
  `lock` → `status` → `merge plan result-r1.json` → `render plan` → `ask-prep plan` → `ask ask/plan-start.json` → `status`
- 결과: `result-r1.json` 생성, 기획 항목 id 1, `index.html`, `ask-plan-start.html` 생성.
  9턴, `duration_ms` 26.4초, `duration_api_ms` 25.5초, 비용 $0.2725, 권한 거부 0회.
- `project.json` 해시는 r1에서 `merge` 호출에서만 바뀌었고(`lock`·`ask`는
  `project_json_changed: false`), 래퍼 호출 사이의 해시 단절은 없었다.

### 2.2 사람 답 흉내와 `--resume`

- `POST /proj/feedback`에 `Origin: http://127.0.0.1:<포트>`로 답을 보냈다.
  `{"stage":"plan","round":0,"kind":"stage_start","text":"...","answers":{...}}` → 200,
  `feedback/plan-R0-*.json` 저장, `pending` 1개.
- `claude -p --resume <1라운드 세션 ID>` 호출. 세션 ID가 1라운드와 **같았다**.
- 에이전트가 `pending` → 답 파일 읽기 → `round-start plan`(R1) → `mark` → `render` → `status`.
  7턴, `duration_ms` 31.9초, `duration_api_ms` 56.7초, 비용 $0.3738, 미처리 답 0개.
- `snapshots/plan-R1.json` 생성.

### 2.3 `--continue`

- 두 번째 답을 보낸 뒤 `claude -p --continue` 호출. 세션 ID가 앞과 **같았다**.
- 에이전트가 `pending` → `round-start plan`(R2) → `result-r2.json` 작성 → `merge`(항목 id 2)
  → `mark` → `render` → `status`. 9턴, `duration_ms` 32.6초, `duration_api_ms` 88.8초, 비용 $0.5005.
- `snapshots/plan-R1.json`, `snapshots/plan-R2.json` 생성, 항목 [1, 2], 미처리 답 0개.
- 별도 탐침(`probe_continue.py`)에서도 `--continue`가 같은 세션 ID를 유지하고,
  첫 호출에서 기억하라고 한 단어를 두 번째 호출에서 그대로 답했다(`continued: true`).
  도구는 모두 끄고 임시 cwd에서 실행했다.

### 2.4 새 세션(대화 기억 없음)

- 세 번째 답을 보낸 뒤 `--resume`/`--continue` 없이 새 `claude -p` 호출. 세션 ID는 새로 생겼다.
- 에이전트가 PES의 `pending`만 보고 답 파일을 찾아 `note` → `mark` → `render` → `status`.
  7턴, `duration_ms` 21.3초, `duration_api_ms` 20.6초, 비용 $0.2430, 미처리 답 0개.
- 즉 **재개의 신뢰 원천은 Claude 세션이 아니라 PES의 `processed`/`pending` 상태**였다.
  세션이 없어도 이어졌다.

### 2.5 잠금

- agent-b Claude 호출: 래퍼 `lock`을 실제로 1회 실행했고 **exit 3**, stderr에
  "다른 세션이 사용 중: agent-a…"가 기록됐다. `project.json` 해시와 잠금 소유자(agent-a)는 그대로였다.
  [`mode-b/logs/claude-r5-lock-b.json`](mode-b/logs/claude-r5-lock-b.json)에 래퍼 원자료가 있다.
- 이 호출에서 에이전트가 `<래퍼> lock <프로젝트>; echo "exit=$?"`처럼 복합 명령을 한 번 시도해
  권한 거부 1회가 있었다. 곧 래퍼 단독 호출로 다시 실행해 exit 3을 받았다. 이 거부는 실패가 아니라
  권한 표면이 실제로 걸린 기록이다.
- 별도 `probe_lock_agent.py`도 같은 결과를 냈다. `logs/lock-agent-probe.json`에는
  agent-a의 `lock`(exit 0), agent-b의 `lock`(exit 3, stdout/stderr), 전후 `project.json` 해시,
  잠금 소유자 전후가 모두 들어 있다.
- CLI 결정 검사(모두 `PES_OWNER`로 소유자 지정, 하네스가 직접 `pes.py` 실행):
  - agent-b `lock` → exit 3
  - agent-b `merge` → exit 3 (쓰기 거부)
  - agent-b `lock --force` → exit 0 (탈취)
  - 탈취 후 agent-a `merge` → exit 3, `project.json` 불변
  - agent-b `unlock` → exit 0, `.pes-lock` 제거
- 잠금은 최근 2시간(`LOCK_TTL`) 동안 유효하다. 쓰기 명령마다 `at`이 갱신되지만 **독립적인 주기
  heartbeat는 없다**. 프로세스가 죽어도 2시간 동안 남기 때문에 `--force`가 필요하다.
  시험 래퍼는 에이전트의 `--force`를 거부하고, CLI 검사에서만 `--force`를 썼다.

### 2.6 시간·턴·비용

`duration_ms`는 Claude Code가 보고한 호출 전체 시간, `duration_api_ms`는 API 시간이다.
둘은 다르며, 재개 호출에서는 API 시간이 더 길 수 있다.

| 호출 | 턴 | duration_ms | duration_api_ms | 비용(USD) | 권한 거부 |
|---|---:|---:|---:|---:|---:|
| 권한 probe | 7 | 18.2초 | 18.0초 | 0.2233 | 4 |
| 1라운드 | 9 | 26.4초 | 25.5초 | 0.2725 | 0 |
| `--resume` | 7 | 31.9초 | 56.7초 | 0.3738 | 0 |
| `--continue` | 9 | 32.6초 | 88.8초 | 0.5005 | 0 |
| 새 세션 | 7 | 21.3초 | 20.6초 | 0.2430 | 0 |
| agent-b 잠금 | 3 | 12.8초 | 12.5초 | 0.2085 | 1 |
| **본 시험 합계(권한 probe 포함)** | **42** | **143.3초** | **222.1초** | **1.8217** | **5** |

- 본 시나리오 5회 호출만 보면 35턴, `duration_ms` 125.1초, `duration_api_ms` 204.1초, $1.5983.
- 전체 벽시계 시간은 약 2분 32초(설정·피드백·서버 기동·권한 probe 포함, 별도 탐침 제외).
- 별도 탐침: `--continue` 2호출 10.5초·$0.0051, agent-b 잠금 1호출 7.6초·$0.2032.
- 비용은 `claude -p` JSON의 `total_cost_usd` 합계다. 실제 청구와 다를 수 있다.

## 3. 실패 지점과 안 된 것

이번 실행에서 **필수 검사 실패는 없다**. 다만 다음은 시험하지 않았거나 환경에 따라 달라질 수 있다.

1. **질문 다듬기 미시험.** `ask-prep`이 만든 `ask/plan-start.json`을 에이전트가 수정하는 단계는
   이번 지시에 넣지 않았다. `ask`로 HTML을 만드는 데까지만 확인했다.
2. **대기(long-poll) 미시험.** 사람 답은 프로세스 사이에 하네스가 `POST /feedback`으로 넣었다.
   에이전트가 한 프로세스 안에서 답을 기다리는 동작은 시험하지 않았다.
3. **답의 의미 반영 미검증.** `commands/run.md:13`의 "시작 질문 답 → 설정 저장 후 R1"에서
   답 값(purpose/audience 등)을 `settings`에 저장하는 호출·검사가 없다. 이번 재개 검증은
   `pending`/`mark` 왕복과 라운드 전이까지다. `/pes:run`·스킬 전체 준수도 검증하지 않았다.
4. **Claude 앱 미실행.** 연결 방법 조사만 했고 실제 도구 왕복은 확인하지 않았다(6절).
5. **도구 호출 전체 추적은 아니다.** `--output-format json`에는 모든 Write/Edit 호출의 상세 목록이
   없다. 직접 편집 판정은 4절의 권한 거부 + 래퍼 전후 해시 + 호출 사이 해시 단절로 한다.
6. **OS sandbox는 아니다.** 권한 한정은 Claude Code 도구 규칙과 래퍼 검증이다. 래퍼는 사용자 권한으로
   저장소 `pes.py`를 실행한다.
7. **Python 3.9 실행 미검증.** 시험 환경은 Python 3.15.2다. 코드는 표준 라이브러리만 쓰지만
   3.9 인터프리터에서 실제로 돌려 보지는 않았다.
8. **`--restricted` 비용 문제.** 시도했으나 호출당 캐시 생성이 크게 늘어(약 $2/호출) 채택하지 않았다.
   경로 한정 규칙으로 대체했고, 이는 0.3절에서 실제 거부를 확인했다.

## 4. `project.json` 직접 편집 여부 (원칙 0)

이번에는 **막는 규칙**과 **탐지 기록**을 같이 썼다.

- 막는 규칙: `Write(//<프로젝트>/project.json)`, `Edit(//<프로젝트>/project.json)`,
  `Write(project.json)`, `Edit(project.json)`를 `--disallowedTools`로 거부했다.
  permission probe에서 실제 Write 시도가 거부되고 해시가 그대로인 것을 확인했다(0.3절).
- 탐지 기록: 래퍼가 PES CLI 호출마다 `project.json` 전후 해시를 남긴다. 하네스는 Claude 호출 전후
  해시와 래퍼 호출의 전후 해시를 대조해 **래퍼 호출 사이의 해시 단절**을 찾는다.
- 결과: r1~r5 모두 해시 단절 0. `project.json` 대상 Write/Edit의 **성공** 기록은 없었다.
  permission probe의 `project.json` Write 시도 1건은 거부됐다.
- 한계: Claude의 모든 도구 호출을 별도 추적하지는 않는다. 위 판정은 권한 거부 기록, 래퍼의
  호출별 해시, 호출 사이 해시 대조에 근거한다. "임의의 모든 우회가 불가능"을 증명한 것은 아니다.

## 5. 1단계 API/MCP 설계 시사점

현행 파일·CLI 프로토콜로도 한 라운드는 돌았다. 그러나 에이전트가 **매 턴 경로와 순서를 프롬프트로
안내받아야** 했고, 상태 변경이 여러 CLI 호출로 흩어졌다. 1단계 합의안
([../stage-1-api.md](../stage-1-api.md) 7·8절, [../stage-1-runners.md](../stage-1-runners.md) 4·5절)의
HTTP 정본 + stdio MCP 브리지 방향과 맞는다.

| 1단계 도구(안) | 이번 시험의 현행 대응 | 시사점 |
|---|---|---|
| `pes_context(project, stage, round, items?)` | `pes.py status`(텍스트), `pending`(경로 목록) | 상태·미처리 답·다음 할 일을 **구조화된 digest + 정확한 버전**으로 한 번에 줘야 한다. 지금은 에이전트가 `status`와 `pending`을 따로 부르고, `project.json`을 직접 쓰지 않도록 권한으로 막아야 했다. |
| `pes_claim(project, stage, items[])` → `run_id`+lease | `pes.py lock`(2시간 파일 잠금) | `run_id`·lease·fence가 없고 독립 heartbeat도 없다. 프로세스가 죽으면 2시간 뒤에야 풀리며 `--force`는 감사 흔적이 약하다. claim은 "run 전이 + lease 획득"을 원자적으로 해야 한다. |
| `pes_submit(run_id, item_id, result, idempotency_key)` | `pes.py merge`(JSON 파일 병합) | `merge`는 임의 JSON을 받아 항목을 만들고, `rev`·`idempotency_key`·기준 버전 검사가 없다. 같은 결과를 두 번 제출하면 중복 항목이 생길 수 있다. 제출은 작은 원자 묶음 + 멱등 키 + expected rev가 필요하다. |
| `pes_ask(run_id, questions[])` → `question_ids` | `ask-prep` + `ask`(질문 은행 복사, HTML 생성) | 질문 ID·버전·답 검증이 파일/HTML에 묶여 있다. PES 질문을 원본으로 두고, 실행 권한·폼 질문은 별도로 중계하는 1단계 결정이 타당하다. |
| `pes_wait(run_id, timeout_s)` → answers/events | `POST /feedback` + `pending`/`feedback.log` 폴링 | 에이전트가 기다리는 API가 없다. 이번에는 하네스가 프로세스 사이에 답을 넣었다. long-poll(최대 25초)·입력 영수증·lease 해제가 필요하다. |
| `pes_complete(run_id, status, summary)` | 없음(`render`/`status`로 끝) | "이번 run을 끝냈다"는 신호가 없다. `complete`는 승인·봉인이 아니라 run 종료라는 1단계 결정을 그대로 구현해야 한다. |
| heartbeat·release·cancel·입력 영수증 | 없음(쓰기마다 `at` 갱신만) | TUI가 닫히거나 프로세스가 죽는 경우를 상태로 표현할 수 없다. B4(앱 재접속: context → 새 입력 → 수신 확인 → claim)와 C1~C4의 필요성을 뒷받침한다. |

추가로 확인된 것:

- **재개는 PES 상태가 기준이고 Claude 세션은 보조**다. `--resume`/`--continue`는 같은 세션을
  이어 갔지만, 새 세션도 `pending`만으로 이어졌다. 1단계의 "재개 = 새 claim·새 fence"와
  "앱 재접속은 context부터"가 현실적이다.
- **권한 표면이 UX를 좌우한다.** `Bash(python3:*)`는 임의 코드를 허용해 위험하고, 경로 한정
  파일 도구는 에이전트가 쓰기 쉬운 절대 경로를 막을 수 있다. MCP 도구가 있으면 이 문제가 줄고,
  CLI를 유지할 때는 전용 `pes` 실행 파일과 경로 규칙을 명시해야 한다.
- **`status` 텍스트는 사람에게는 좋지만 에이전트에는 느슨하다.** `pes_context`가
  프로젝트·단계·라운드·미처리 입력·정확한 rev를 구조화해 주면 턴 수와 오해를 줄일 수 있다.
- **`--force` 탈취는 빨리 동작하지만 위험하다.** agent-b가 `--force`로 잠금을 가져가자 agent-a의
  쓰기가 즉시 막혔다. 1단계의 강제 인계(사람만)와 fence가 이 위험을 통제해야 한다.

## 6. Claude 앱 연결 방법 (조사만, 실행 안 함)

Claude 앱은 실행하지 않았다. 아래는 2026-11-05에 확인한 공개 문서와 1단계 합의안을 구분해 정리한
것이다. 실제 앱 동작·권한 UI·재접속은 **미확인**이며 1단계 PR 20에서 시험해야 한다.

1. **로컬 MCP 서버(stdio)** — Claude Desktop은 `claude_desktop_config.json`의 `mcpServers`에
   `command`·`args`·`env`를 넣어 로컬 stdio 서버를 자식 프로세스로 띄운다. macOS 경로는
   `~/Library/Application Support/Claude/claude_desktop_config.json`, 설정 → Developer → Edit Config로
   연다. 저장 후 앱을 완전히 종료·재시작해야 한다.
   출처: MCP "Connect to local MCP servers" <https://modelcontextprotocol.io/quickstart/user>,
   Claude Code MCP 문서 <https://code.claude.com/docs/en/mcp> (확인일 2026-11-05).
   PES라면 `serve.py`의 HTTP를 감싸는 stdio MCP 브리지를 이 방식으로 붙이는 것이 가장 현실적이다.
   **PES에서 실제 설치·왕복은 미확인.**
2. **데스크톱 확장(.mcpb)** — 로컬 MCP 서버를 묶음으로 설치하는 경로.
   출처: Claude 커넥터 문서 <https://claude.com/docs/connectors/custom/add-unlisted> (확인일 2026-11-05).
   로컬 의존성이 있는 PES에 맞지만 패키징·서명·업데이트 정책은 **미확인**.
3. **원격 커넥터(remote MCP)** — Claude의 Customize → Connectors에서 URL로 추가한다. Claude가
   **Anthropic 클라우드에서** 서버에 접속하므로 `127.0.0.1` 로컬 PES는 그대로는 닿지 않는다.
   공개 HTTPS·인증이 필요해 1단계가 아니라 5단계(웹 이전) 범위다.
   출처: Claude Help Center "Get started with custom connectors using remote MCP"
   <https://support.claude.com/en/articles/11175166-getting-started-with-connectors> (확인일 2026-11-05).
4. **명시적 전달(복사/붙여넣기)** — 앱 직접 연결이 안 될 때의 대안. 1단계 B3의 묶음 복사·결과
   가져오기와 같다. 복사만으로 제출 완료로 보지 않는 원칙을 유지해야 한다.
   출처: 1단계 합의안 [../stage-1-runners.md](../stage-1-runners.md) B3.

정리: **Claude Code는 stdio MCP 브리지 + CLI 대안**이 맞고, **Claude 앱은 로컬 MCP(설정 파일 또는
.mcpb)** 이 1차 후보, **원격 커넥터는 5단계**다. 앱의 실제 도구 호출·승인 UI·재접속은 이번에
확인하지 못했으므로 "미확인"으로 남긴다.

## 7. 한계

- 합성 주제 1개, 기획 단계 1개만 시험했다. 조사·집필·검증·산출 단계는 돌리지 않았다.
- 웹 조사·법령/KOSIS API·파일 첨부·보고서 생성은 시험하지 않았다.
- 사람 답은 하네스가 `POST /feedback`으로 넣었다. 실제 브라우저 폼·동시 제출·중복 제출은 시험하지 않았다.
- PES 서버를 라운드 중에 재시작하거나, 네트워크를 끊거나, Windows에서 돌려 보지 않았다.
- MCP 서버를 만들지 않았고 CLI 래퍼로 시험했다. MCP 도구의 권한 UI·long-poll 동작은 **미확인**.
- 답의 의미 반영(`settings` 저장)과 `/pes:run`·스킬 전체 준수는 검증하지 않았다(3절 3번).
- 권한 한정은 Claude Code 도구 규칙 + 래퍼 검증이지 OS sandbox가 아니다(3절 6번).
- 루트 밖 `Read`/`Glob`/`Grep` 거부는 permission probe 항목에 넣지 않았다(미시험).
  이번에 실제로 확인한 것은 쓰기 거부와 Bash 래퍼 한정이다.
- `--permission-mode`와 설정 원천을 고정하지 않았다. 실행자 `~/.claude` 설정에 넓은 allow 규칙이나
  `defaultMode`가 있으면 경로 한정이 약해질 수 있다. 이번에는 permission probe가 먼저 실패하면
  본 시험이 중단되게 했지만, 다른 환경에서의 재현성은 **미확인**이다.
- `run_spike.py`는 시작할 때 **본 시험 로그만** 지우고 탐침 로그는 보존한다. 모든 원자료를
  새로 만들려면 본 시험 뒤 `probe_continue.py`·`probe_lock_agent.py`를 다시 실행해야 한다.
- Python 3.9 실행 호환성은 미검증이다(3절 7번).
- 비용은 `claude -p` JSON의 `total_cost_usd` 합계다. 실제 청구와 다를 수 있다.

## 8. 정리

- 시험용 `serve.py`는 종료했고, 포트 54339에 리스너가 없음을 확인했다.
- 각 `claude -p`는 호출이 끝나며 종료됐고, 시험용으로 남은 프로세스는 없다.
- 임시 디렉터리는 지웠다. 저장소에는 자리표시로 정리한 로그만 남겼다.
- `PES_HOME`과 서버 `HOME`을 임시 홈으로 두었다. 실제 `~/.pes` 읽기 여부는 별도 계측하지 않았다(미확인).
