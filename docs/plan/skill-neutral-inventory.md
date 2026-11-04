# 스킬 중립화 인벤토리 (2단계 PR17 준비)

- 입력: `skills/`, `commands/`, `agents/`, [stage-1-runners.md](stage-1-runners.md) 6절 D4, [stage-0-opencode.md](discussion/stage-0-opencode.md) 3.16
- 기준: D4의 **중립 단계 워크플로 + 공통 역할 명세 + 어댑터 노트**. Claude 전용 표기·직접 쓰기 예제는 예외 위치가 있는 lint로 막는다.
- 범위: 현재 파일의 `파일:줄` 목록과 바꿀 중립 계약. 코드·계획서는 고치지 않았다. 실제 `~/pes-projects`·`~/.pes`는 읽지 않았다.
- 줄 번호는 2026-11-05 현재 파일 기준이다. 편집 전에 다시 확인한다.
- 집계: **64개** — AskUserQuestion 8, CLAUDE_PLUGIN_ROOT 5, Agent/서브에이전트/model 13, anthropic-skills 5, Monitor 10, PES_OWNER 2, Claude 환경·CLI 7, project.json 직접 편집·JSON 쓰기 14.

## 1. 중립 계약

| 계약 | 뜻 | 어댑터 예 |
|---|---|---|
| `ask_human(spec)` | 사람에게 묻고 답을 받는 단일 통로. 연구 질문·승인은 PES 웹이 원본 | Claude: 폼/AskUserQuestion(서버 불가 시만), OpenCode: PES API, Codex: API/CLI |
| `spawn_worker(role, model_policy)` | 역할 명세로 작업자 실행. 역할·기대 결과만 넘김 | Claude: Agent, OpenCode: session/prompt, Codex: subagent |
| `model_policy(strong\|cheap\|vision)` | 모델명 대신 역할·품질 정책 | Claude: opus/sonnet, OpenCode: DeepSeek, Codex: provider model |
| `validated_submit(result)` | 검증된 명령으로 결과·상태 제출. 파일 직접 쓰기 금지 | PES API/CLI의 `submit`·`merge`·`note` 등 |
| `context` / `digest` | 상태 읽기. `project.json` 통째 읽기 대신 PES 읽기 모델 | `pes status`·`digest`·`show`, API `GET P/context` |
| `wait_for_input(timeout)` / `notify` | 사람 답·이벤트 대기·알림 | Claude: Monitor, OpenCode: event stream, Codex: poll |
| `owner_session` / `lease` | 실행 담당·잠금. 환경변수 세션 ID 대신 토큰·lease | 어댑터가 주입, PES `project_leases` |
| `plugin_root` | 플러그인 경로. 스킬이 제공자 경로를 직접 알지 않음 | 어댑터가 주입 |
| `export(report_format)` | hwpx·docx·pdf·pptx 내보내기 | Claude: `anthropic-skills:*`, 다른 어댑터: 동등 도구 |
| `render` | 대시보드·단계 보고서·웹 보고서 생성 | `pes render`·`pes report` |
| `run_cli` | 셸·도구 실행. 경로·권한은 어댑터가 주입 | Claude Code Bash, OpenCode tool, Codex shell |
| `adapter_note` | 제공자별 환경·진입점·설치·관측 차이 | `adapters/claude-code/`, `adapters/claude-app/` |
| `workflow_step(name)` | 중립 워크플로의 한 단계 | `refine_questions`·`review`·`publish` 등 |

## 2. 인벤토리

### 2.1 AskUserQuestion (8)

| # | 파일:줄 | 현재 | 중립 계약 | 바꿀 내용 |
|---|---|---|---|---|
| 1 | `skills/core/SKILL.md:16` | "AskUserQuestion은 서버를 띄울 수 없을 때만" | `ask_human(spec)` | "사람 질문은 `ask_human(spec)`; Claude 어댑터가 서버 불가 시 AskUserQuestion으로 대체" |
| 2 | `commands/plan.md:8` | 프로젝트 여럿이면 AskUserQuestion | `ask_human(spec)` | "`ask_human(project_choice)`; 어댑터가 폼/CLI 선택으로 매핑" |
| 3 | `commands/research.md:8` | 같음 | `ask_human(spec)` | 같음 |
| 4 | `commands/analyze.md:8` | 같음 | `ask_human(spec)` | 같음 |
| 5 | `commands/write.md:8` | 같음 | `ask_human(spec)` | 같음 |
| 6 | `commands/verify.md:8` | 같음 | `ask_human(spec)` | 같음 |
| 7 | `commands/publish.md:8` | 같음 | `ask_human(spec)` | 같음 |
| 8 | `commands/run.md:10` | 2개 이상이면 AskUserQuestion, 선택지 규칙 | `ask_human(spec)` | 선택지 규칙은 `ask_human` spec으로 옮기고, Claude 전용 UI 언급은 어댑터 노트로 |

### 2.2 CLAUDE_PLUGIN_ROOT (5)

| # | 파일:줄 | 현재 | 중립 계약 | 바꿀 내용 |
|---|---|---|---|---|
| 9 | `skills/core/SKILL.md:23` | `PES="python3 -I ${CLAUDE_PLUGIN_ROOT}/scripts/pes.py"` | `plugin_root` | `PES="${PES_ROOT}/scripts/pes.py"`; `PES_ROOT`는 어댑터가 주입 |
| 10 | `skills/core/SKILL.md:25` | `${CLAUDE_PLUGIN_ROOT}`가 비면 상대 경로 | `plugin_root` | "`PES_ROOT`가 비면 어댑터가 Base directory로 채운다" |
| 11 | `commands/setup.md:7` | `PLUG = ${CLAUDE_PLUGIN_ROOT}` | `plugin_root` | `PLUG=${PES_ROOT}`; 설치 어댑터가 경로 주입 |
| 12 | `commands/run.md:6` | `python3 -I ${CLAUDE_PLUGIN_ROOT}/scripts/setup.py` | `plugin_root` + `run_cli` | `run_cli("${PES_ROOT}/scripts/setup.py needed")` |
| 13 | `commands/start.md:6` | 같음 | `plugin_root` + `run_cli` | 같음 |

### 2.3 Agent·서브에이전트·model (13)

| # | 파일:줄 | 현재 | 중립 계약 | 바꿀 내용 |
|---|---|---|---|---|
| 14 | `skills/core/SKILL.md:30` | "Claude가 다듬음" | `workflow_step("refine_questions")` | "에이전트가 `refine_questions` 단계로 다듬음" |
| 15 | `skills/core/SKILL.md:123` | `pes:reviewer` 서브에이전트(Agent, model opus) | `spawn_worker(reviewer, model_policy=strong)` | 역할·지시문만 넘기고 모델은 정책으로. Claude는 Agent, OpenCode는 session, Codex는 subagent |
| 16 | `skills/research/SKILL.md:3` | description의 `pes:researcher` | `spawn_worker(researcher)` | 역할 이름 `researcher`; `pes:` 접두어는 어댑터 매핑 |
| 17 | `skills/research/SKILL.md:31` | 항목당 `pes:researcher` 서브에이전트, 최대 5 | `spawn_worker(researcher)` | "항목당 researcher 작업자, 동시성 상한은 어댑터·런타임" |
| 18 | `skills/research/SKILL.md:33` | `model: "sonnet"`/`"opus"`, Agent model 인자 | `model_policy(cheap\|strong)` | `sonnet→cheap`, `opus→strong`; 항목에는 `model_policy`만 남김 |
| 19 | `skills/write/SKILL.md:27` | `pes:writer` 서브에이전트 | `spawn_worker(writer)` | 역할 이름 `writer` |
| 20 | `skills/verify/SKILL.md:3` | description의 `pes:verifier` | `spawn_worker(verifier)` | 역할 이름 `verifier` |
| 21 | `skills/verify/SKILL.md:19` | `pes:verifier` 서브에이전트 | `spawn_worker(verifier)` | 역할 이름 `verifier` |
| 22 | `skills/analyze/SKILL.md:26` | "일반 서브에이전트" | `spawn_worker(analyst)` | 역할 이름 `analyst`; 제공자별 실행은 어댑터 |
| 23 | `agents/researcher.md:3` | Claude 서브에이전트 설명 | 역할 명세 `researcher` | `agents/`를 역할 명세로 옮기고 Claude 전용 형식은 `adapters/claude-code/agents/`로 |
| 24 | `agents/writer.md:3` | 같음 | 역할 명세 `writer` | 같음 |
| 25 | `agents/verifier.md:3` | 같음 | 역할 명세 `verifier` | 같음 |
| 26 | `agents/reviewer.md:3` | 같음 | 역할 명세 `reviewer` | 같음 |

### 2.4 anthropic-skills (5)

| # | 파일:줄 | 현재 | 중립 계약 | 바꿀 내용 |
|---|---|---|---|---|
| 27 | `skills/core/SKILL.md:154` | `anthropic-skills:hwpx-uri`·`docx`·`pdf` | `export(report_format)` | `export("hwpx"\|"docx"\|"pdf")`; 도구 매핑은 어댑터 |
| 28 | `skills/publish/SKILL.md:16` | `anthropic-skills:hwpx-uri` | `export("hwpx")` | 중립 이름 `export("hwpx")`; Claude 어댑터가 hwpx-uri로 매핑 |
| 29 | `skills/publish/SKILL.md:17` | `anthropic-skills:docx` | `export("docx")` | 같음 |
| 30 | `skills/publish/SKILL.md:18` | `anthropic-skills:pdf` | `export("pdf")` | 같음 |
| 31 | `skills/publish/SKILL.md:21` | `anthropic-skills:pptx` | `export("pptx")` | 같음 |

### 2.5 Monitor (10)

| # | 파일:줄 | 현재 | 중립 계약 | 바꿀 내용 |
|---|---|---|---|---|
| 32 | `skills/core/SKILL.md:49` | `serve`/`stop`/`watch` 설명의 "Monitor 명령" | `wait_for_input` / `notify` | "`watch`는 `wait_for_input` 명령을 출력; Claude 어댑터가 Monitor로 매핑" |
| 33 | `skills/core/SKILL.md:98` | `pes home` 뒤 "Monitor는 새 경로로 다시" | `wait_for_input` / `notify` | "구독을 새 경로로 다시 연결" |
| 34 | `skills/core/SKILL.md:105` | "Monitor 명령(tail…)" | `wait_for_input` | Claude 전용 tail 명령은 어댑터 노트로 |
| 35 | `skills/core/SKILL.md:116` | 시작 질문 흐름의 Monitor | `wait_for_input` | "답 대기를 `wait_for_input`으로" |
| 36 | `skills/core/SKILL.md:161` | "Monitor (timeout_ms 1800000)" | `wait_for_input(timeout)` | timeout은 어댑터 설정; 중립 문서에는 "만료되면 다시"만 |
| 37 | `commands/setup.md:16` | Git Bash가 있어야 Monitor | `wait_for_input` / `adapter_note` | Claude Desktop·Git Bash 조건은 어댑터 노트로 |
| 38 | `commands/setup.md:22` | `WATCH …`로 Monitor(timeout 1800000) | `wait_for_input` / `notify` | 설치 어댑터가 대기·알림을 연결 |
| 39 | `commands/home.md:11` | feedback.log Monitor 다시 걸기 | `wait_for_input` / `notify` | "구독을 새 경로로 다시" |
| 40 | `commands/run.md:14` | 처리할 답 없으면 Monitor | `wait_for_input` | "답 대기를 `wait_for_input`으로" |
| 41 | `commands/start.md:12` | `Monitor(watch)` | `wait_for_input` | "`watch`가 출력하는 대기 명령을 `wait_for_input`으로" |

### 2.6 PES_OWNER (2)

| # | 파일:줄 | 현재 | 중립 계약 | 바꿀 내용 |
|---|---|---|---|---|
| 42 | `skills/core/SKILL.md:39` | `lock`/`unlock` 설명의 `PES_OWNER` | `owner_session` / `lease` | "세션 표시는 어댑터가 주입하는 owner_session/lease" |
| 43 | `skills/core/SKILL.md:109` | `PES_OWNER=<ID>`를 모든 호출에 붙임 | `owner_session` / `lease` | 환경변수 예시 삭제; "어댑터가 owner_session을 주입" |

### 2.7 Claude 환경·CLI (7)

| # | 파일:줄 | 현재 | 중립 계약 | 바꿀 내용 |
|---|---|---|---|---|
| 44 | `skills/core/SKILL.md:111` | "다른 Claude Code 세션(터미널 탭)에서 `/pes:run`" | `adapter_note(entrypoint)` | "다른 어댑터 세션에서 `run` 진입점" |
| 45 | `skills/core/SKILL.md:213` | `listTaskSpaces()`로 남은 Space 닫기 | `release_worker` / `adapter_note` | "작업자 정리는 어댑터의 `release_worker`" |
| 46 | `skills/core/SKILL.md:215` | Claude Code 설정 env `NODE_EXTRA_CA_CERTS` | `adapter_note(env)` | "어댑터가 환경변수를 주입; 중립 스킬은 경로만 요구" |
| 47 | `skills/research/SKILL.md:71` | `LAW_OC`·`NODE_EXTRA_CA_CERTS`는 Claude Code 설정 | `adapter_note(env)` | 같음 |
| 48 | `skills/research/SKILL.md:79` | `~/.claude/settings.json`의 env에 등록 | `adapter_note(env)` | "어댑터 설정에 등록" |
| 49 | `commands/setup.md:18` | "MCP 등록은 claude CLI가 있을 때만" | `adapter_note(install)` | "Claude 어댑터가 claude CLI 유무를 판단" |
| 50 | `commands/setup.md:26` | "Claude Desktop(또는 Claude Code)을 다시 시작" | `adapter_note(install)` | "해당 어댑터의 재시작 안내" |

### 2.8 project.json 직접 편집·JSON 쓰기 (14)

| # | 파일:줄 | 현재 | 중립 계약 | 바꿀 내용 |
|---|---|---|---|---|
| 51 | `skills/core/SKILL.md:32` | `merge`가 결과 JSON 병합 | `validated_submit(result)` | "결과는 `validated_submit`/`merge` 명령으로 제출" |
| 52 | `skills/core/SKILL.md:62` | `## project.json 편집` | `context` / `validated_submit` | 제목을 `## 상태 읽기·검증된 제출`로; 직접 편집 절 삭제 |
| 53 | `skills/core/SKILL.md:68` | `p = json.loads(f.read_text())` | `context` | `project.json` 직접 읽기 대신 `pes context/show` |
| 54 | `skills/core/SKILL.md:71` | `f.write_text(json.dumps(p, ...))` | `validated_submit(result)` | 파일 쓰기 삭제; 명령 서비스 제출로 대체 |
| 55 | `skills/core/SKILL.md:88` | "고치기는 짧은 Python으로 필요한 필드만" | `validated_submit(result)` | "고치기는 `validated_submit` 명령으로 필요한 필드만" |
| 56 | `skills/core/SKILL.md:90` | 서브에이전트가 `<dir>/rounds/...json`에 씀 | `validated_submit(result)` | "작업자는 결과를 `validated_submit`으로 제출; 파일 경로는 작업 산출물에만" |
| 57 | `skills/research/SKILL.md:32` | 결과를 `<dir>/rounds/research-R<n>/<id>.json`에 씀 | `validated_submit(result)` | 같음 |
| 58 | `skills/write/SKILL.md:54` | 결과를 `<dir>/rounds/write-R<n>/<id>.json`에 씀 | `validated_submit(result)` | 같음 |
| 59 | `skills/verify/SKILL.md:50` | 결과를 `<dir>/rounds/verify-R<n>/<id>.json`에 씀 | `validated_submit(result)` | 같음 |
| 60 | `agents/researcher.md:18` | 결과 JSON을 `Write` 도구로 씀 | `validated_submit(result)` | 역할 명세에는 "검증된 제출"만; Write는 Claude 어댑터 구현 |
| 61 | `agents/writer.md:20` | 결과 JSON을 `Write` 도구로 씀 | `validated_submit(result)` | 같음 |
| 62 | `agents/verifier.md:21` | 결과 JSON을 `Write` 도구로 씀 | `validated_submit(result)` | 같음 |
| 63 | `agents/reviewer.md:35` | 결과 파일을 `Write`로 UTF-8 JSON | `validated_submit(result)` | 같음 |
| 64 | `agents/reviewer.md:49` | "project.json을 고치지 않는다 — 판단만 기록" | `validated_submit(result)` 경계 | "업무 상태는 `validated_submit`만; reviewer는 판단 결과만 제출" |

## 3. lint 규칙·예외 위치

- `skills/`, `commands/`는 중립 영역이다. 금지 토큰: `AskUserQuestion`, `CLAUDE_PLUGIN_ROOT`, `PES_OWNER`, `Monitor`, `anthropic-skills:`, `model opus`, `model sonnet`, `Agent(`, `pes:researcher|writer|verifier|reviewer`(역할 이름은 허용하되 `pes:` 접두어는 어댑터 매핑), `json.dumps(project.json)`, `sqlite3`, `.pes-lock`.
- `adapters/claude-code/`, `adapters/claude-app/`만 Claude 전용 표기·환경·Monitor·AskUserQuestion·Agent·`anthropic-skills:*`를 둔다.
- `agents/`는 지금 Claude 서브에이전트 형식이다. `adapters/claude-code/agents/`로 옮기거나, 중립 `roles/*.md`(역할 명세)로 바꾸고 Claude 형식은 어댑터가 생성한다. 둘 중 하나를 PR17에서 정한다.
- `project.json`·`sqlite3`·`.pes-lock` 직접 쓰기는 `scripts/`의 검증된 명령 서비스 밖에서 금지한다. `skills/`·`commands/`·`agents/`에는 `json.loads`/`json.dumps` 예제를 남기지 않는다.
- `anthropic-skills:*`는 `export(report_format)`의 Claude 어댑터 매핑에만 둔다. 이름 변경만으로 hwpx/docx/pdf/pptx 변환 지원을 주장하지 않는다.
- CI 제안: `python -m pytest -q tests/test_skill_lint.py`(금지 토큰·직접 쓰기·예외 경로 검사). 기존 `tests/`에 lint 테스트가 없으면 PR17에서 추가한다.

## 4. 남은 판단

1. `agents/*.md`를 `adapters/claude-code/agents/`로 옮길지, 중립 `roles/*.md`로 재작성할지. **추천: 중립 roles + Claude 어댑터 생성** — 역할 명세가 한 곳에 남고 OpenCode/Codex가 같은 역할을 쓴다.
2. `model_policy` 매핑: `opus→strong`, `sonnet→cheap`을 기본으로 두고, 정확한 모델은 어댑터 설정으로 뺀다. `vision`은 필요한 단계에서만.
3. `PES_OWNER`를 완전히 없앨지, 2단계 호환 기간에만 어댑터가 주입할지. **추천: 스킬에서는 삭제, 어댑터가 owner_session/lease로 주입**.
4. `Monitor`의 `timeout_ms`·tail 명령을 중립 문서에 남길지. **추천: `wait_for_input(timeout)`만 남기고 tail·Git Bash 조건은 Claude 어댑터 노트로**.
5. `project.json` 읽기 예제(`status`·`digest`·`show`)는 남기되, 직접 `json.loads`/`json.dumps`는 금지한다.
