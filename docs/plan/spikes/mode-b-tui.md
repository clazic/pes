# 방식 B 시험 — Claude Code ↔ PES 왕복·재개 (SEL-19)

- 확인일: 2026-11-05
- 환경: macOS, Python 3.15.2, Claude Code **2.1.317**, 모델 `claude-sonnet-5-5`
- 범위: Claude Code **비대화형(`-p`)**만 실행했다. Claude 앱은 연결 방법만 조사했고 실행하지 않았다.
  Codex·OpenCode TUI는 이 시험 범위가 아니다.
- 재현: [`spikes/mode-b/README.md`](spikes/mode-b/README.md), [`run_spike.py`](spikes/mode-b/run_spike.py),
  [`probe_continue.py`](spikes/mode-b/probe_continue.py), [`probe_lock_agent.py`](spikes/mode-b/probe_lock_agent.py)
- 원자료: [`spikes/mode-b/logs/`](spikes/mode-b/logs/) (`run.log`, `claude-*.json`, `pes-calls.log`, `summary.json`,
  `continue-probe.json`, `lock-agent-probe.json`)

## 0. 격리

- 합성 프로젝트만 썼다. `PES_HOME=<임시>/home`, 프로젝트 `<임시>/home/proj`, 주제 "합성 주제".
- `scripts/pes.py`는 항상 `PES_HOME=<임시>/home`으로 실행했다. `PES_HOME`이 설정되면 `pes.py`는
  `~/.pes/config.json`을 읽지 않는다(`scripts/pes.py:77-86`).
- `scripts/serve.py`는 `trusted_origins`를 `Path.home()/.pes/config.json`에서 읽는다
  (`scripts/serve.py:31-38`). 실제 홈을 읽지 않도록 **서버 프로세스의 `HOME`도 `<임시>/home`으로** 바꿨다.
  실행 전후 실제 `~/.pes/config.json`의 atime이 바뀌지 않은 것을 확인했다(참고 증거).
- `claude -p`는 인증·설정 때문에 실제 `HOME`을 그대로 썼다. `~/.claude` 설정 파일은 바꾸지 않았다.
  (Claude Code가 평소처럼 세션 기록을 `~/.claude` 아래에 남겼을 수는 있다.)
- 서버는 빈 포트(52703)에 띄웠고, 끝난 뒤 프로세스를 종료하고 포트가 비었는지 확인했다.

## 1. 결과 요약

| 단계 | 결과 | 근거 |
|---|---|---|
| 합성 프로젝트 `init` | 됨 | exit 0, `project.json` 생성 |
| `serve.py` 기동·`/ping` | 됨 | `/ping` 200, `GET /proj/` 200(89,183 bytes) |
| 1라운드: `status` → 결과 JSON → `merge`/`render` → `ask-prep`/`ask` | 됨 | 9턴·21.8초, PES 호출 7회, 질문 HTML 생성 |
| 사람 답 흉내 `POST /feedback` | 됨 | 200, `feedback/plan-R0-*.json`, `pending` 1개 |
| 재개 1: `claude -p --resume <세션>` | 됨 | 같은 세션 ID, 7턴·17.7초, 미처리 답 0개 |
| 재개 2: `claude -p --continue` | 됨 | 같은 세션 ID, 9턴·21.1초, R2·항목 2건 |
| 재개 3: 새 세션(`--resume`/`--continue` 없음) | 됨 | 새 세션 ID, 8턴·37.5초, `pending`만 보고 처리 |
| 잠금: agent-b CLI `lock`/`merge` | 됨(차단) | 둘 다 exit 3, agent-a 잠금 유지 |
| 잠금: agent-b Claude 호출 | 일부 안 됨 → 별도 탐침에서 됨 | 본 시험은 권한 거부 2회, 탐침은 exit 3 보고 |
| `lock --force` 후 원래 소유자 쓰기 | 됨(차단) | agent-b가 강제 탈취하면 agent-a `merge` exit 3 |
| `unlock` | 됨 | exit 0, `.pes-lock` 제거 |
| `project.json` 직접 편집 | 없음(관측 범위) | 해시 변화가 모두 `pesw.py` 쓰기 명령과 일치 |
| 서버·프로세스 정리 | 됨 | serve.py 종료, 포트 52703 리스너 없음 |

핵심 흐름과 재개는 모두 동작했고, 잠금은 CLI 검사에서 동작했다. 에이전트 수준 잠금은 본 시험에서
권한 때문에 한 번 실행되지 않았지만, 같은 조건을 더 분명히 지시한 별도 탐침에서는 동작했다.
실패는 제품 기능이 아니라 **권한 표면**에서 났다
(`Bash(python3:*)`가 환경변수 접두어·복합 셸 명령을 허용하지 않음). 자세한 내용은 3절.

## 2. 단계별 기록

### 2.1 1라운드 (새 세션)

- 호출: `command claude -p "<지시>" --model claude-sonnet-5-5 --max-turns 30 --output-format json`
  (셸 함수 래퍼를 피하려고 하네스는 `shutil.which("claude")`의 절대 경로로 실행했다.)
  - `--allowedTools "Bash(python3:*)" Read Write Edit`
  - `--add-dir <임시>/home/proj --add-dir <저장소>/scripts`
  - `--dangerously-skip-permissions`는 쓰지 않았다.
  - `--max-turns 30`은 2.1.317에서 정상 동작했다(도움말에는 숨겨져 있음).
- 환경: `PES_HOME=<임시>/home`, `PES_OWNER=agent-a`, 작업 디렉터리 `<임시>/home/proj`.
- 에이전트가 실제로 부른 PES CLI(순서대로):
  `lock` → `status` → `merge plan result-r1.json` → `render plan` → `ask-prep plan` → `ask ask/plan-start.json` → `status`
- 결과: `result-r1.json` 생성, 기획 항목 id 1, `index.html`, `ask-plan-start.html` 생성.
  9턴, 21.8초, 비용 $0.2638, 권한 거부 0회.
- `project.json` 해시는 바뀌었고, 같은 구간에 `lock`·`merge`·`ask` 쓰기 호출이 기록됐다. 직접 편집 징후 없음.

### 2.2 사람 답 흉내와 `--resume`

- `POST /proj/feedback`에 `Origin: http://127.0.0.1:<포트>`로 답을 보냈다.
  `{"stage":"plan","round":0,"kind":"stage_start","text":"...","answers":{...}}` → 200,
  `feedback/plan-R0-*.json` 저장, `pending` 1개.
- `claude -p --resume <1라운드 세션 ID>` 호출. 세션 ID가 1라운드와 **같았다**.
- 에이전트가 `pending` → 답 파일 읽기 → `round-start plan`(R1) → `mark` → `render` → `status`.
  7턴, 17.7초, 비용 $0.3662, 미처리 답 0개.

### 2.3 `--continue`

- 두 번째 답을 보낸 뒤 `claude -p --continue` 호출. 세션 ID가 앞과 **같았다**.
- 에이전트가 `pending` → `round-start plan`(R2) → `result-r2.json` 작성 → `merge`(항목 id 2)
  → `mark` → `render` → `status`. 9턴, 21.1초, 비용 $0.4936.
- `snapshots/plan-R1.json`, `snapshots/plan-R2.json` 생성, 미처리 답 0개.
- 별도 탐침(`probe_continue.py`)에서도 `--continue`가 같은 세션 ID를 유지하고,
  첫 호출에서 기억하라고 한 단어를 두 번째 호출에서 그대로 답했다(`continued: true`).

### 2.4 새 세션(대화 기억 없음)

- 세 번째 답을 보낸 뒤 `--resume`/`--continue` 없이 새 `claude -p` 호출. 세션 ID는 새로 생겼다.
- 에이전트가 PES의 `pending`만 보고 답 파일을 찾아 `note` → `mark` → `render` → `status`.
  8턴, 37.5초, 비용 $0.2420, 미처리 답 0개.
- 즉 **재개의 신뢰 원천은 Claude 세션이 아니라 PES의 `processed`/`pending` 상태**였다.
  세션이 없어도 이어졌다.

### 2.5 잠금

- 본 시험의 agent-b Claude 호출은 `PES_OWNER=agent-b python3 ...`처럼 환경변수 접두어를 붙이려다
  권한 거부 2회로 `lock`을 실행하지 못했다(파일 수정 없음).
- 같은 조건을 더 분명한 지시("접두어를 붙이지 마라")로 다시 시험한 `probe_lock_agent.py`에서는
  agent-b가 `python3 <래퍼> lock <프로젝트>`를 실행했고, exit 3과
  "다른 세션이 사용 중: agent-a…" 메시지를 그대로 보고했다. `--force`는 쓰지 않았다. 2턴, 4.6초, $0.2044.
- CLI 결정 검사(모두 `PES_OWNER`로 소유자 지정):
  - agent-b `lock` → exit 3
  - agent-b `merge` → exit 3 (쓰기 거부)
  - agent-b `lock --force` → exit 0 (탈취)
  - 탈취 후 agent-a `merge` → exit 3
  - agent-b `unlock` → exit 0
- 잠금은 최근 2시간(`LOCK_TTL`) 동안 유효하고 heartbeat가 없다. 프로세스가 죽어도 2시간 동안
  남기 때문에 `--force`가 필요하다. CLI 검사에서 `--force`는 성공했지만, 에이전트가 스스로
  `--force`를 쓰지 않도록 지시·권한으로 막아야 한다.

### 2.6 시간·턴·비용

| 호출 | 턴 | API 시간 | 비용(USD) | 권한 거부 |
|---|---:|---:|---:|---:|
| 1라운드 | 9 | 21.8초 | 0.2638 | 0 |
| `--resume` | 7 | 17.7초 | 0.3662 | 0 |
| `--continue` | 9 | 21.1초 | 0.4936 | 0 |
| 새 세션 | 8 | 37.5초 | 0.2420 | 1 |
| agent-b 잠금(본 시험) | 3 | 10.2초 | 0.2077 | 2 |
| **합계** | **36** | **108.3초** | **1.5734** | **3** |

- 전체 벽시계 시간은 약 1분 54초(설정·피드백·서버 기동 포함). 모델 호출만 108.3초.
- 별도 탐침: `--continue` 2호출 6.0초·$0.2622, agent-b 잠금 1호출 4.6초·$0.2044.
- 턴 수는 PES CLI 호출 수보다 많다. 에이전트가 파일을 읽고, 결과를 확인하고, 권한 거부 뒤
  다시 시도하는 데 턴을 썼다.

## 3. 실패 지점

1. **`Bash(python3:*)` 권한이 좁다.**
   - `P=<임시>; python3 ...` 같은 변수 대입·복합 명령은 거부됐다.
   - `PES_OWNER=agent-b python3 ...`처럼 환경변수 접두어가 붙은 명령도 거부됐다.
   - 에이전트가 개별 `python3 ...` 호출로 다시 시도하면 통과했다(새 세션 호출). 반면 agent-b
     본 시험에서는 두 번 다 접두어를 붙여 실행하지 못했다.
   - 제품에서는 MCP 도구를 기본으로 두거나, CLI를 쓸 때 `Bash(pes:*)`처럼 **PES 전용 실행 파일**을
     허용하고 정확한 호출 형식을 스킬/프롬프트에 고정해야 한다.
2. **질문 다듬기 미시험.** `ask-prep`이 만든 `ask/plan-start.json`을 에이전트가 수정하는 단계는
   이번 지시에 넣지 않았다. `ask`로 HTML을 만드는 데까지만 확인했다.
3. **대기(long-poll) 미시험.** 사람 답은 프로세스 사이에 하네스가 `POST /feedback`으로 넣었다.
   에이전트가 한 프로세스 안에서 답을 기다리는 동작은 시험하지 않았다.
4. **Claude 앱 미실행.** 연결 방법 조사만 했고 실제 도구 왕복은 확인하지 않았다(6절).

그 밖의 PES 기능 실패는 없었다. `merge`·`render`·`ask`·`pending`·`mark`·`lock`·`unlock`은
모두 예상한 종료 코드와 파일을 냈다.

## 4. `project.json` 직접 편집 여부 (원칙 0)

- 각 Claude 호출 전후 `project.json`의 SHA-256 앞 16자를 비교하고, 같은 구간의 `pesw.py` 호출 로그를
  대조했다.
- 해시가 바뀐 모든 호출에 `lock`·`merge`·`ask`·`round-start`·`mark`·`note` 같은 **쓰기 명령**이
  같은 구간에 기록됐다. 해시가 바뀌었는데 쓰기 명령이 없는 경우는 없었다.
- `result-r1.json`·`result-r2.json`은 생성됐지만, `claude -p --output-format json`의 출력에는
  Write/Edit 도구 호출의 상세 목록이 없다. 따라서 "결과 파일에만 Write를 썼다"는 것은 파일 존재와
  `project.json` 해시·CLI 로그로 판단한 것이다. `project.json`을 직접 고쳤다고 볼 근거는 없었다.
- 한계: 래퍼는 `python3 <래퍼> ...` 호출만 기록한다. 에이전트가 `python3 -c`로 `project.json`을
  직접 쓰는 것까지 막거나 탐지하지는 못한다. 이번 로그에서는 그런 호출의 흔적이 없었지만,
  "직접 쓰기 불가능"을 증명한 것은 아니다. 2단계에서는 API만 쓰게 하고 파일 권한을 좁혀야 한다.

## 5. 1단계 API/MCP 설계 시사점

현행 파일·CLI 프로토콜로도 한 라운드는 돌았다. 그러나 에이전트가 **매 턴 경로와 순서를 프롬프트로
안내받아야** 했고, 상태 변경이 여러 CLI 호출로 흩어졌다. 1단계 합의안
([stage-1-api.md](stage-1-api.md) 7·8절, [stage-1-runners.md](stage-1-runners.md) 4·5절)의
HTTP 정본 + stdio MCP 브리지 방향과 맞는다.

| 1단계 도구(안) | 이번 시험의 현행 대응 | 시사점 |
|---|---|---|
| `pes_context(project, stage, round, items?)` | `pes.py status`(텍스트), `pending`(경로 목록) | 상태·미처리 답·다음 할 일을 **구조화된 digest + 정확한 버전**으로 한 번에 줘야 한다. 지금은 에이전트가 `status`와 `pending`을 따로 부르고, `project.json`을 읽지 않도록 프롬프트로 막아야 했다. |
| `pes_claim(project, stage, items[])` → `run_id`+lease | `pes.py lock`(2시간 파일 잠금) | `run_id`·lease·fence가 없고 heartbeat도 없다. 프로세스가 죽으면 2시간 뒤에야 풀리며 `--force`는 감사 흔적이 약하다. claim은 "run 전이 + lease 획득"을 원자적으로 해야 한다. |
| `pes_submit(run_id, item_id, result, idempotency_key)` | `pes.py merge`(JSON 파일 병합) | `merge`는 임의 JSON을 받아 항목을 만들고, `rev`·`idempotency_key`·기준 버전 검사가 없다. 같은 결과를 두 번 제출하면 중복 항목이 생길 수 있다. 제출은 작은 원자 묶음 + 멱등 키 + expected rev가 필요하다. |
| `pes_ask(run_id, questions[])` → `question_ids` | `ask-prep` + `ask`(질문 은행 복사, HTML 생성) | 질문 ID·버전·답 검증이 파일/HTML에 묶여 있다. PES 질문을 원본으로 두고, 실행 권한·폼 질문은 별도로 중계하는 1단계 결정이 타당하다. |
| `pes_wait(run_id, timeout_s)` → answers/events | `POST /feedback` + `pending`/`feedback.log` 폴링 | 에이전트가 기다리는 API가 없다. 이번에는 하네스가 프로세스 사이에 답을 넣었다. long-poll(최대 25초)·입력 영수증·lease 해제가 필요하다. |
| `pes_complete(run_id, status, summary)` | 없음(`render`/`status`로 끝) | "이번 run을 끝냈다"는 신호가 없다. `complete`는 승인·봉인이 아니라 run 종료라는 1단계 결정을 그대로 구현해야 한다. |
| heartbeat·release·cancel·입력 영수증 | 없음 | TUI가 닫히거나 프로세스가 죽는 경우를 상태로 표현할 수 없다. B4(앱 재접속: context → 새 입력 → 수신 확인 → claim)와 C1~C4의 필요성을 뒷받침한다. |

추가로 확인된 것:

- **재개는 PES 상태가 기준이고 Claude 세션은 보조**다. `--resume`/`--continue`는 같은 세션을
  이어 갔지만, 새 세션도 `pending`만으로 이어졌다. 1단계의 "재개 = 새 claim·새 fence"와
  "앱 재접속은 context부터"가 현실적이다.
- **권한 표면이 UX를 좌우한다.** `Bash(python3:*)`는 에이전트가 쓰기 쉬운 형태(변수·접두어·복합 명령)를
  막는다. MCP 도구가 있으면 이 문제가 사라지고, CLI를 유지할 때는 전용 `pes` 실행 파일과
  허용 패턴을 명시해야 한다.
- **`status` 텍스트는 사람에게는 좋지만 에이전트에는 느슨하다.** `pes_context`가
  프로젝트·단계·라운드·미처리 입력·정확한 rev를 구조화해 주면 턴 수와 오해를 줄일 수 있다.
- **`--force` 탈취는 빨리 동작하지만 위험하다.** agent-b가 `--force`로 잠금을 가져가자 agent-a의
  쓰기가 즉시 막혔다. 1단계의 강제 인계(사람만)와 fence가 이 위험을 통제해야 한다.

## 6. Claude 앱 연결 방법 (조사만, 실행 안 함)

Claude 앱은 실행하지 않았다. 공개 문서를 보고 가능한 경로만 정리했다. 실제 동작·권한 UI는 **미확인**이며
1단계 PR 20에서 설치·도구 왕복·종료/재접속을 시험해야 한다.

1. **로컬 MCP 서버(stdio)** — Claude Desktop은 `claude_desktop_config.json`의 `mcpServers`에
   `command`·`args`·`env`를 넣어 로컬 stdio 서버를 자식 프로세스로 띄운다. macOS 경로는
   `~/Library/Application Support/Claude/claude_desktop_config.json`, 설정 → Developer → Edit Config로
   연다. 저장 후 앱을 완전히 종료·재시작해야 한다. PES라면 `serve.py`의 HTTP를 감싸는 stdio MCP
   브리지를 이 방식으로 붙이는 것이 가장 현실적이다. **PES에서 실제 설치·왕복은 미확인.**
2. **데스크톱 확장(.mcpb)** — 로컬 MCP 서버를 묶음으로 설치하는 경로. 로컬 의존성이 있는 PES에
   맞지만 패키징·서명·업데이트 정책은 **미확인**.
3. **원격 커넥터(remote MCP)** — Claude의 Customize → Connectors에서 URL로 추가한다. Claude가
   **Anthropic 클라우드에서** 서버에 접속하므로 `127.0.0.1` 로컬 PES는 그대로는 닿지 않는다.
   공개 HTTPS·인증이 필요해 1단계가 아니라 5단계(웹 이전) 범위다.
4. **명시적 전달(복사/붙여넣기)** — 앱 직접 연결이 안 될 때의 대안. 1단계 B3의 묶음 복사·결과
   가져오기와 같다. 복사만으로 제출 완료로 보지 않는 원칙을 유지해야 한다.

정리: **Claude Code는 stdio MCP 브리지 + CLI 대안**이 맞고, **Claude 앱은 로컬 MCP(설정 파일 또는
.mcpb)** 이 1차 후보, **원격 커넥터는 5단계**다. 앱의 실제 도구 호출·승인 UI·재접속은 이번에
확인하지 못했으므로 "미확인"으로 남긴다.

## 7. 한계

- 합성 주제 1개, 기획 단계 1개만 시험했다. 조사·집필·검증·산출 단계는 돌리지 않았다.
- 웹 조사·법령/KOSIS API·파일 첨부·보고서 생성은 시험하지 않았다.
- 사람 답은 하네스가 `POST /feedback`으로 넣었다. 실제 브라우저 폼·동시 제출·중복 제출은 시험하지 않았다.
- PES 서버를 라운드 중에 재시작하거나, 네트워크를 끊거나, Windows에서 돌려 보지 않았다.
- MCP 서버를 만들지 않았고 CLI 래퍼로 시험했다. MCP 도구의 권한 UI·long-poll 동작은 **미확인**.
- `project.json` 직접 쓰기를 완전히 차단하는 권한 시험은 하지 않았다(4절 한계).
- 비용은 `claude -p` JSON의 `total_cost_usd` 합계다. 실제 청구와 다를 수 있다.

## 8. 정리

- 시험용 `serve.py`는 종료했고, 포트 52703에 리스너가 없음을 확인했다.
- 각 `claude -p`는 호출이 끝나며 종료됐고, 시험용으로 남은 프로세스는 없다.
  (`pgrep` 패턴이 다른 실행 중 프로세스의 명령줄 문자열과 일치한 경우가 있어 PID로 구분했다.)
- 임시 디렉터리는 지웠다. 저장소에는 자리표시로 정리한 로그만 남겼다.
