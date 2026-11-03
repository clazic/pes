# 1단계 ④ 방식 A·B 실행 구조 — OpenCode 의견

- 작성: 2026-11-04, OpenCode (`opencode-go/deepseek-v4.1-flash`), Linear **SEL-24**
- 입력: `docs/plan/00-brief.md`, `docs/plan/stage-0.md`, `docs/plan/stage-1-db.md`(2·8·10·11절), `docs/plan/schemas/stage-1-ddl-draft.sql`, `docs/plan/research/notion-linear.md`, `docs/plan/research/webmcp.md`, `docs/plan/discussion/stage-0-opencode.md` 3.14~3.16·4절, 현재 `agents/`·`skills/`·`commands/`
- 범위: 실행 구조 의견. 코드를 고치지 않는다. 실제 `~/pes-projects`·`~/.pes/`는 읽지 않았다.
- 이미 정해진 것: stage-0 7절, stage-1-db 2절 결정 17개. 다시 정하지 않는다.
- 확인한 OpenCode API: v2.2.5 기준 <https://opencode.ai/v2/docs/api> (session/prompt/event/interrupt/permission/form/model/usage). 아래 `DDL:`은 `docs/plan/schemas/stage-1-ddl-draft.sql`.

---

## 0. 한 장 요약

1. **PES 코어는 상태·검증·기록, 에이전트는 조사·집필, 어댑터는 실행·권한·모델·세션**만 맡는다. 어댑터는 결과를 대신 쓰지 않는다.
2. A는 PES가 `opencode serve`에 붙어 세션·프롬프트·이벤트·중단·권한·폼·사용량을 다룬다. **OpenCode form/permission은 실행 수준**이고, PES 질문이 원본이다.
3. A의 OpenCode 세션도 **PES API/MCP로 직접 제출**한다. PES A 어댑터는 run을 queued로 만들고 세션 수명·정책만 관리한다.
4. B Claude Code는 MCP 6도구로 붙고, **도구 호출 때 heartbeat**한다. TUI가 닫히면 heartbeat가 끊겨 lease가 만료되고, 재시작 후 claim으로 이어간다.
5. B Claude 앱은 **지속 연결·heartbeat를 가정하지 않는다.** 2단계는 "명시적 패킷 전달"이 기본이고, 원격 MCP는 5단계 조사 항목이다.
6. 질문을 올리면 **lease를 놓고 `waiting_human`**. 답이 오면 재-claim하며 `fence`가 올라간다. 답·첨언은 lease 없이 가능하다.
7. **lease TTL·heartbeat 값은 아직 정하지 않는다.** SEL-18·19 시험 결과로 정할 값으로 표시하고, 후보와 시험 표만 남긴다.
8. 스킬은 **중립 워크플로+어댑터 노트**로 나눈다. `AskUserQuestion`·`CLAUDE_PLUGIN_ROOT`·`model opus`·`anthropic-skills:*`는 워크플로에서 제거한다.
9. 서브에이전트는 **하나의 top-level run 안에서** 움직이고 lease를 따로 잡지 않는다. reviewer만 독립성을 위해 별도 run으로 분리한다.
10. A↔B 인계는 **run을 새로 만들고 같은 PES 상태를 이어받는** 방식이다. 세션·모델은 넘기지 않는다. 2단계 22개 PR을 유지한다.

---

## 1. 하나의 코어·두 어댑터

| 층 | 소유 | 하지 않는 것 |
|---|---|---|
| PES 코어 | run/lease, 상태 전이, 질문/답, 버전·이벤트, 정책, API | 모델 추론·도구 실행 |
| 에이전트 | 조사·분석·집필·검증의 내용, 도구 사용 | DB·project.json 직접 쓰기 |
| 어댑터 | 세션 시작/프롬프트/이벤트/중단/권한/모델/사용량 | 결과 대리 제출, 상태 전이 |

**공통 어댑터 인터페이스** (A/B가 같은 의미를 구현)

| 동작 | 입력 | 출력 | 비고 |
|---|---|---|---|
| `start` | run_id, mode, runtime, model, context_snapshot | external_session_ref | A는 OpenCode 세션, B는 TUI 연결 |
| `prompt` | brief, target versions, tools | accepted/turn id | A는 `/prompt`, B는 MCP/CLI |
| `stream` | session/run | execution.event | 도구·권한·비용·중단 |
| `ask/wait` | question set | answers/events | PES API가 원본, lease 해제 |
| `permission` | request | allow/deny/ask-human | A는 OpenCode API, B는 TUI |
| `interrupt` | run_id, reason | stopped | Go OFF·상한·인계 |
| `usage` | session/run | tokens/cost/time | A는 usage API, B는 선택 |
| `close` | run_id | released | lease 해제·로그 정리 |

**공통 계약 테스트**: 가짜 A/B 어댑터가 같은 run·질문·답·artifact·event를 만든다. 어댑터가 `objects`/`questions`/`events`를 직접 쓰면 실패. `start`/`interrupt`/`close`가 멱등인지 확인한다.

---

## 2. 주제 목록

| # | 주제 | 정하는 것 |
|---|---|---|
| 1 | 코어·어댑터 경계 | 책임·금지·공통 인터페이스 |
| 2 | A: OpenCode 서버 수명 | serve/version/connect/health/로그/Windows |
| 3 | A: 세션·프롬프트·이벤트 | session/prompt/event/interrupt/model |
| 4 | A: 권한·폼·사용량 | permission/form/usage, PES 질문과 분리 |
| 5 | A: 작업 공간·도구 | 임시 workspace, PES MCP, 스킬·AGENTS.md |
| 6 | A: DeepSeek·상한·Go OFF | 단일 모델, 비용/시간, 전송 차단 |
| 7 | B: Claude Code | MCP/CLI, heartbeat, TUI 종료·재개 |
| 8 | B: Claude 앱 | 지속 연결 가정 금지, 패킷/원격 MCP |
| 9 | 질문 대기·재개 | lease 해제, 재-claim, fence, receipts |
| 10 | lease TTL·heartbeat | 후보·시험 표, SEL-18·19 입력 |
| 11 | 서브에이전트 역할 | researcher/reviewer/verifier/writer A/B |
| 12 | 스킬 중립화 | 중립 어휘, 어댑터 노트, 금지 토큰 |
| 13 | A↔B 인계 | pause/interrupt, fence, 같은 상태 |
| 14 | 실패·관측·보안 | crash/orphan, execution event, workspace |
| 15 | 시험·측정 | 공통 시나리오, TTL, Go OFF, 역할 독립 |

---

## 3. 주제별 논의

### 3.1 코어·어댑터 경계

- **정할 것**: 코어/에이전트/어댑터의 책임, 어댑터가 쓸 수 있는 API, 금지할 직접 쓰기.
- **선택지**: ① 어댑터가 결과를 대신 읽어 저장 ② **에이전트가 PES API로 제출, 어댑터는 실행만** ③ OpenCode 세션을 PES 모델로.
- **판단 기준**: A/B가 같은 쓰기 경로인가, 어댑터가 상태를 우회하지 않는가, OpenCode 변경이 PES로 새지 않는가.
- **추천**: ②. 어댑터는 `start/prompt/stream/interrupt/permission/usage/close`만 하고, 결과·질문·답은 에이전트가 PES API/MCP로 낸다. `runs.external_session_ref`에 세션 ID만 둔다. 이유: stage-0 원칙 0(`stage-0.md:12-14`)과 stage-1-db의 "run은 에이전트 결과 채택만 제한"(`stage-1-db.md:32`)을 어댑터에서도 지켜야 한다.

### 3.2 방식 A: OpenCode 서버 수명

- **정할 것**: PES가 서버를 띄우는가/기존 서버에 붙는가, 버전 고정, health, 로그, Windows 프로세스.
- **선택지**: ① PES가 항상 새 서버를 띄운다 ② **있으면 붙고 없으면 띄운다** ③ 사용자가 수동으로만 띄운다.
- **판단 기준**: 사용자 설정을 덮지 않는가, 여러 run이 같은 서버를 쓸 수 있는가, 죽었을 때 복구되는가, Windows에서 분리·종료가 되는가.
- **추천**: ②. `PES_OPENCODE_URL`이 있으면 `/api/info`로 health·version 확인 후 붙고, 없으면 `opencode serve`를 PES가 띄운다. v2.2.5를 고정하고 `/openapi.json`으로 기능을 감지한다. 로그는 `~/.pes/logs/opencode-<pid>.log`, 종료는 PES가 띄운 프로세스만. `/api/info`·`/api/model`·`/api/experimental/usage/limits`를 시작 시 확인(`stage-0-opencode.md:631-676`). 이유: 사용자가 이미 쓰는 서버를 죽이지 않으면서, 없을 때 한 번에 시작할 수 있다.

### 3.3 방식 A: 세션·프롬프트·이벤트

- **정할 것**: 세션 단위, 모델 지정, 프롬프트 형식, 이벤트 매핑, 중단·재개.
- **선택지**: ① 프로젝트당 세션 하나 ② **run당 세션 하나, 필요하면 역할별 하위 세션** ③ 항목당 세션.
- **판단 기준**: 컨텍스트 오염이 없는가, 비용·중단이 쉬운가, 이벤트가 run에 귀속되는가, 재개가 되는가.
- **추천**: ②. `POST /api/session` → `POST /api/session/{id}/model`로 `opencode-go/deepseek-v4.1-flash` 고정 → `POST /api/session/{id}/prompt`로 brief 전달. `GET /api/event`를 SSE로 읽어 `run_id`/`session_id`별 `events(type='execution.*')`로 기록. `POST /api/session/{id}/interrupt`로 중단, `GET /api/session/{id}/message`로 마지막 상태 확인. 세션은 run의 `external_session_ref`에 저장. 재개는 새 세션+`pes_claim`이 기본이고, 같은 세션 재사용은 `interrupt` 뒤에만 시도한다. 이유: run 경계가 lease·비용·감사와 일치하고, 한 세션에 여러 단계를 섞으면 컨텍스트가 오염된다.

### 3.4 방식 A: 권한·폼·사용량

- **정할 것**: OpenCode permission/form을 누가 어떻게 처리하는가, PES 질문과의 경계, 사용량 기록.
- **선택지**: ① 모두 자동 허용 ② **읽기·검색은 자동, 쓰기·셸·네트워크는 정책/사람, PES 질문과 분리** ③ 모두 사람에게 묻는다.
- **판단 기준**: 사람이 승인하지 않은 위험한 도구 실행이 없는가, 연구 질문과 실행 질문이 섞이지 않는가, 비용이 기록되는가.
- **추천**: ②. OpenCode permission은 `GET/POST /api/session/{id}/permission` 계열로 받아 PES UI의 "실행 권한"으로 보여 주고, 허용 규칙은 workspace 안 읽기/쓰기, 셸 allowlist, 연구 도구 네트워크만 자동. 그 외는 사람 확인. OpenCode form은 실행 수준 폼으로 PES UI에 프록시하되 `questions`에 넣지 않는다(`stage-0-opencode.md:650-651`). 사용량은 `/api/experimental/usage/limits`와 run 종료 시 `runs.usage_json`에 기록. 이유: 실행 권한은 연구 결정과 다른 종류이고, PES 질문 표에 섞으면 답·승인 이력이 오염된다.

### 3.5 방식 A: 작업 공간·도구

- **정할 것**: OpenCode 세션이 어느 디렉터리에서 도는가, PES 데이터를 어떻게 읽는가, 스킬·AGENTS.md를 어떻게 주는가.
- **선택지**: ① 실제 PES 프로젝트 폴더 ② **run 전용 임시 workspace + PES API/MCP** ③ 홈 전체.
- **판단 기준**: 사용자 실자료를 건드리지 않는가, 큰 파일·첨부를 안전하게 주는가, 재현·정리가 쉬운가, A/B가 같은 context를 쓰는가.
- **추천**: ②. workspace는 `~/.pes/runs/<run_id>/workspace`(또는 OS temp)로 두고, PES context는 API/MCP로만 읽는다. 첨부는 `blobs`에서 내려받아 workspace에 두고, 결과 파일은 `POST /blobs`로 올린다. OpenCode에는 중립 `AGENTS.md`(워크플로)와 PES MCP 서버를 설정하고(OpenCode의 MCP attach 방식은 v2.2.5에서 스파이크 확인), Claude 전용 스킬은 주지 않는다. 작업이 끝나면 workspace를 정리하되 결과·로그는 PES에 남긴다. 이유: 실제 프로젝트 폴더를 에이전트에게 주면 "직접 쓰지 않는다" 원칙이 깨지고, 공개 저장소·실자료 보호도 어렵다.

### 3.6 방식 A: DeepSeek·상한·Go OFF

- **정할 것**: 단일 모델 고정, run/단계별 비용·시간 상한, Go OFF 강제 지점.
- **선택지**: ① 모델 자동 선택·폴백 ② **DeepSeek 하나 고정, 실패 시 명확한 실패(무단 폴백 없음)** ③ 단계별 상위 모델.
- **판단 기준**: 사용자 결정(DeepSeek 하나)을 지키는가, 비용 폭주를 막는가, Go OFF가 즉시 먹는가, 실패가 조용히 넘어가지 않는가.
- **추천**: ②. Go 전송은 기본 켜짐+프로젝트별 끄기(사용자 결정 7-1). `runs.provider='opencode-go'`, `model='opencode-go/deepseek-v4.1-flash'` 고정(`stage-1-db.md:141`). run 상한: wall-clock(예: 20~30분, 시험으로 확정), cost/tokens 상한, prompt 횟수 상한. 초과 시 `interrupt` → run `failed`/`interrupted`, lease 해제, `events`에 기록. Go OFF는 **세션 생성 전, 매 prompt 전, 요약·첨부·재시도 전** 확인하고 `outbound_dispatches`를 prepared→authorized→sent로 남긴다(`stage-1-db.md:113`, `:212`). 진행 중이면 active 세션에 `interrupt`를 시도하고, `sent/unknown`은 회수 불가로 기록하며 자동 재시작하지 않는다. 합성 자료도 우회하지 않는다. 이유: 저가 모델 하나로 6단계를 돌리는 전제이므로, 폴백·무제한 재시도는 비용과 품질 모두를 망친다.

### 3.7 방식 B: Claude Code

- **정할 것**: 연결 방식(MCP/CLI), heartbeat, TUI 종료 시 lease, 재개, 질문 대기.
- **선택지**: ① MCP만 ② **MCP 6도구+CLI 폴백** ③ 파일 프로토콜.
- **판단 기준**: TUI가 적은 프롬프트로 쓰는가, heartbeat 없이도 복구되는가, 승인·reopen이 노출되지 않는가, 재개가 중복 없이 되는가.
- **추천**: ②. `pes mcp --stdio`의 `pes_context/claim/submit/ask/wait/complete`를 쓰고, MCP가 안 되는 환경은 `pes` CLI로 같은 서비스를 호출한다. heartbeat는 **MCP 도구 호출 때마다** 갱신하고, 백그라운드 heartbeat를 가정하지 않는다. TUI가 닫히면 TTL 후 lease 만료; 재시작 시 `/pes:run` → `pes_claim`(같은 run 또는 새 run) → `run_input_receipts`로 미처리 답 확인. `pes_wait`는 최대 30초 long-poll; 답이 없으면 `waiting_human`으로 반환하고 세션은 끝내도 된다. MCP에 approve/reopen/policy 도구는 없다. 이유: Claude Code는 도구 호출 시점에만 확실히 살아 있고, 지속 heartbeat를 전제로 하면 TTL 설계가 틀어진다.

### 3.8 방식 B: Claude 앱

- **정할 것**: 연결 경로(원격 MCP vs 수동 패킷), 지속 연결·heartbeat 가정, 결과 전달·검증, 재개.
- **선택지**: ① 지속 원격 MCP 가정 ② **명시적 패킷 전달(기본) + 원격 MCP 조사(5단계)** ③ 지원 안 함.
- **판단 기준**: 지금 실제로 되는가, 사용자가 결과를 잃지 않는가, 인증·전송이 안전한가, 자동 resume를 약속하지 않는가.
- **추천**: ②. 2단계는 PES가 **실행 패킷**(context digest, run_id, 질문 ID, 결과 JSON 스키마, 정책, 붙여넣기용 프롬프트)을 Markdown으로 만들고, 사용자가 Claude 앱에 붙여 넣고 결과를 PES에 붙여 넣거나 파일로 올리는 경로를 기본으로 한다. `runs.mode='B'`, `runtime='claude_app'`, `external_session_ref`는 NULL, lease는 **턴 단위**로 짧게 잡고 끝나면 해제한다. 원격 MCP/커넥터가 실제로 가능한지는 **2단계에서 조사**하되 기본 경로는 패킷으로 두고, 정식 지원은 5단계에서 정한다. 가능해도 **heartbeat를 가정하지 않는** 같은 규칙을 쓴다. 이유: 현재 Claude 앱의 지속 세션·heartbeat·MCP 연결은 확인되지 않았고, 확인되지 않은 것을 전제로 lease를 설계하면 복구가 깨진다.

### 3.9 질문 대기·재개

- **정할 것**: 질문 시 lease 해제, 답 대기 방식, 재-claim, fence, 중복 방지.
- **선택지**: ① lease 유지한 채 대기 ② **lease 해제+`waiting_human`, 답 오면 재-claim** ③ run 종료.
- **판단 기준**: 다른 실행이 막히지 않는가, 답이 늦어도 run이 살아 있는가, 옛 writer가 결과를 못 넣는가, 중복 처리가 없는가.
- **추천**: ②. `pes_ask`/`POST /questions`는 질문을 저장하고 run을 `waiting_human`으로, lease를 해제한다(`stage-1-db.md:32`, `:110`). A는 세션을 살려 둘 수 있지만 lease는 없다. 답이 오면 `pes_claim`으로 새 `fence`를 받고 `run_input_receipts`로 답을 `seen/applied` 처리한다. B Claude Code는 `pes_wait` 30초 후 `waiting_human` 반환, B Claude 앱은 턴을 끝내고 다음 패킷에 답을 넣는다. 다른 writer가 먼저 claim하면 `lease_lost`로 중단한다. 이유: 질문 대기 중 lease를 쥐고 있으면 사람이 답할 때까지 다른 실행이 막히고, TTL 만료 뒤 옛 writer가 결과를 넣는 사고가 난다.

### 3.10 lease TTL·heartbeat 기준

- **정할 것**: A/B/Claude 앱별 TTL, heartbeat 주기, 만료·탈취, 시험 방법.
- **선택지**: ① 지금 고정 ② **SEL-18·19 결과로 정할 값으로 표시** ③ 무기한.
- **판단 기준**: 사람이 생각하는 시간을 견디는가, 죽은 실행을 빨리 회수하는가, 중복 writer가 없는가, Windows 절전·앱 전환을 견디는가.
- **추천**: ②. **아직 값은 정하지 않는다.** 후보: A TTL 5분/heartbeat 30초(서버가 heartbeat 가능), Claude Code TTL **10~15분**/도구 호출 heartbeat(도구 호출 없이 오래 생각하는 구간을 견뎌야 함), Claude 앱 TTL 2분/턴 단위. 시험 표: TTL 1·3·5·10·15분 × heartbeat 15·30·60초 × 유휴 1·5·30분, 시나리오는 서버 kill, TUI close, 앱 전환, 절전, **도구 호출 없는 긴 추론**. 합격: 같은 프로젝트에 active writer 2명 없음, 죽은 writer 회수, `waiting_human`이 lease를 안 쥠, 늦은 결과가 `lease_lost`. SEL-18·19 결과가 나오면 `stage-1-db` PR 5에서 확정한다.

### 3.11 서브에이전트 역할

- **정할 것**: researcher·reviewer·verifier·writer의 A/B 대응, run/lease 경계, 독립성.
- **선택지**: ① 역할마다 별도 run+lease ② **top-level run 하나+내부 서브에이전트, reviewer만 별도 run** ③ 역할을 스킬에 하드코딩.
- **판단 기준**: 프로젝트 lease 하나를 지키는가, reviewer 독립성이 있는가, 비용·감사가 남는가, A/B가 같은 역할 정의를 쓰는가.
- **추천**: ②, 아래 표. 서브에이전트는 top-level run의 lease를 빌리지 않고 **부모 run 안에서** 결과를 만들고 부모가 PES에 제출한다. reviewer는 부모가 끝난 뒤 lease를 놓고 **별도 reviewer run**으로 돌려 독립성을 지킨다. `runs.role`은 DDL의 `worker|reviewer`만 쓰고, 세부 역할은 `workflow_version`/`parent_run_id`/이벤트로 구분한다(스키마를 늘리지 않음).

| 역할 | A | B Claude Code | B Claude 앱 | PES 기록 |
|---|---|---|---|---|
| researcher | OpenCode 하위 세션/도구 | Claude Task 서브에이전트 | 항목별 패킷 | worker, `research-v1` |
| writer | 장별 하위 세션 | 장별 Task | 장별 패킷 | worker, `write-v1` |
| verifier | 주장 묶음 하위 세션 | 장별 Task | 주장 묶음 패킷 | worker, `verify-v1` |
| reviewer | **별도 run/세션** | **별도 reviewer run/Task** | 별도 2차 패킷 | reviewer, `qa-v1` |

- reviewer에는 메인의 결론·기대를 주지 않고 digest·근거·기준만 준다(`agents/reviewer.md:3-10`, `skills/core/SKILL.md:120-126`).
- 이유: 역할마다 lease를 따로 잡으면 "프로젝트당 writer 하나"가 깨지고, reviewer를 같은 컨텍스트에 두면 독립 검토가 아니다.

### 3.12 스킬 중립화

- **정할 것**: 중립 어휘, 어댑터 노트 위치, Claude 전용 표기 제거, lint.
- **선택지**: ① 스킬 복제 ② **중립 워크플로+어댑터 노트** ③ 전면 재작성.
- **판단 기준**: A/B가 같은 워크플로를 쓰는가, 제공자 변경이 스킬을 안 건드리는가, 리뷰·테스트가 가능한가.
- **추천**: ②. `skills/<stage>/SKILL.md`는 무엇을·왜만 쓰고, `adapters/{claude,opencode,codex}/notes.md`가 도구·모델·질문·렌더를 매핑한다. 표기 치환: `AskUserQuestion`→`ask_human`, `CLAUDE_PLUGIN_ROOT`→`pes_root`, `Agent`/`model opus`→`spawn_worker(role, model_policy)`, `anthropic-skills:*`→`report_format`, `PES_OWNER`→token/lease, `Monitor`/`tail -F`→PES inbox/events, `pes:researcher`→role 이름. A는 DeepSeek 고정, B는 `strong|cheap`을 Claude 모델로 매핑한다. `skills/`에서 `opus|sonnet|CLAUDE_PLUGIN_ROOT|AskUserQuestion|anthropic-skills`를 찾는 lint를 두고 어댑터 밖이면 실패. 이유: 현재 스킬은 Claude 플러그인에 최적화되어 있고(`skills/core/SKILL.md:16`, `:23`, `:123`, `:154`; `skills/research/SKILL.md:33`), A/B 두 러너가 같은 워크플로를 쓰려면 단일 소스가 필요하다.

### 3.13 A↔B 인계

- **정할 것**: 인계 단위, 세션·모델 전달 여부, fence, 미처리 답·진행 작업, 동시 실행 금지.
- **선택지**: ① 같은 run을 모드만 바꿈 ② **run을 새로 만들고 같은 PES 상태·context snapshot을 이어받음** ③ 세션을 복제.
- **판단 기준**: 두 writer가 동시에 없는가, A의 OpenCode 세션을 B가 오해하지 않는가, 답·질문·artifact가 그대로인가, 재현이 되는가.
- **추천**: ②. 인계는 사람이 시작한다. 현재 run `pause`/`interrupt` → 결과 제출 중단 → lease 해제 → `control_rev`·`context_snapshot_id`·`run_targets`·미처리 답 확인 → 새 run `mode`/`runtime`으로 `claim` → `run_input_receipts`로 답 처리. A→B는 OpenCode 세션을 넘기지 않고 `external_session_ref`는 새 run에서 NULL, B→A는 Claude 세션을 넘기지 않고 PES context만 준다. 같은 stage/round에서 A→B→A가 가능하지만 **동시에 두 모드가 active lease를 잡지 않는다**. `runs.parent_run_id`로 인계 계보를 남긴다. 이유: 세션·모델은 공급자 내부이고, PES가 이어받아야 하는 것은 상태·버전·답·결정이다.

### 3.14 실패·관측·보안

- **정할 것**: crash/orphan, 세션 유실, 권한 거부, workspace 정리, execution event, 비밀.
- **선택지**: ① 로그만 ② **events(type='execution.*')+run 상태+lease+usage, workspace 임시** ③ 별도 실행 DB.
- **판단 기준**: 실패를 재현할 수 있는가, 사용자 폴더를 안 건드리는가, 토큰·비밀이 로그에 없는가, orphan 프로세스가 없는가.
- **추천**: ②. 실행 이벤트는 **기존 `events` 표**에 `type='execution.tool'|'execution.permission'|'execution.usage'|'execution.error'`로 작게 남긴다. 전용 `execution_events` 표는 DDL에 없으므로 2단계에서 필요하면 별도 PR/마이그레이션으로 검토한다. run 상태는 `queued/running/waiting_human/succeeded/failed/cancelled/interrupted`(`DDL:823-858`). workspace는 run 종료 시 정리, 실패 시 보존 기간을 두고 `doctor`가 orphan을 찾는다. A는 PES가 띄운 서버/세션만 종료하고, B는 TUI 종료를 감지하지 않고 lease 만료로 처리한다. 토큰·프롬프트 원문·키는 로그에 남기지 않는다. 이유: 실행 로그는 디버깅·비용·감사에 필요하지만, 상태 변경 로그(`events`)와 같은 커서를 탈 수 있으므로 type·payload를 작게 유지해야 한다.

### 3.15 시험·측정

- **정할 것**: 공통 시나리오, A/B 측정값, TTL/heartbeat, Go OFF, 역할 독립, 인계.
- **선택지**: ① 실제 모델만 ② **가짜 어댑터 계약 + 실제 OpenCode/Claude 1회** ③ 문서 리뷰만.
- **판단 기준**: 실제로 세션이 뜨는가, 중단·재개가 되는가, 비용·시간이 측정되는가, 실패가 재현되는가.
- **추천**: ②. 공통 시나리오: 합성 프로젝트에서 context 읽기 → 결과 제출 → 질문 1개 → 답 대기 → 재-claim → complete → reviewer run. A는 OpenCode v2.2.5로 3회, B는 Claude Code로 1회, Claude 앱은 패킷 1회. 측정: 시작 지연, 첫 토큰, 완료 시간, 토큰·비용, 실패율, 중단·재개 성공, lease 만료·탈취. 결과는 `docs/plan/spikes/`에 남기고 TTL/heartbeat 값을 정한다. 실제 사용자 자료 없이 합성 fixture만 쓴다(`stage-0.md:31`, `stage-1-db.md:134`). 이유: A는 "저가 모델이 6단계를 따라하는가"가 핵심이고, B는 "TUI가 닫혀도 이어지는가"가 핵심이다. 둘 다 실제 1회 없이는 완료가 아니다.

---

## 4. 방식 A·B 차이

| 항목 | A (PES 내부) | B (외부) | 공통 |
|---|---|---|---|
| 실행기 | PES runner + OpenCode serve | Claude Code MCP/CLI, Claude 앱 패킷 | 어댑터 인터페이스 |
| 세션 | OpenCode session, `external_session_ref` | TUI 세션 또는 없음 | `runs` |
| 모델 | DeepSeek 하나 고정 | Claude, run마다 다름 | `runs.provider/model` |
| heartbeat | PES runner가 가능 | 도구 호출 때만(앱은 없음) | `project_leases` |
| 권한 | OpenCode permission→PES 실행 권한 | TUI 권한, 앱은 사람 | 실행 수준 분리 |
| 질문 | PES 질문 원본, form은 실행 수준 | PES 질문 원본 | `questions` |
| 대기 | 세션 유지 가능, lease 해제 | TUI 종료 가능, lease 만료 | `waiting_human` |
| 중단·재개 | `/interrupt`+새 세션/claim | 프로세스 재시작+claim | `fence`, receipts |
| 비용 | usage API 기록·상한 | 선택(모르면 NULL) | `runs.usage_json` |
| Go 정책 | 필수, 매 prompt 검사 | 없음(타 공급자 5단계) | `outbound_dispatches` |
| 자동 시작 | PES가 시작 가능 | 사람이 시작 | `runs.mode` |
| 인계 | 새 run, 세션 안 넘김 | 새 run, 세션 안 넘김 | `parent_run_id` |

**공통 금지**: 어댑터 대리 쓰기, `mode`별 endpoint/payload 분기, B에 OpenCode 서버 요구, reviewer에 메인 결론 제공, 지속 heartbeat 가정(앱), Go OFF 뒤 자동 재시작.

---

## 5. 완료 기준

- [ ] 어댑터 인터페이스(`start/prompt/stream/interrupt/permission/usage/close`)와 가짜 A/B 계약 테스트가 있다. 어댑터가 PES 표를 직접 쓰면 실패한다.
- [ ] A: OpenCode v2.2.5 서버 health/version/model/usage 확인, run당 세션, prompt, SSE event, interrupt, permission/form 분리, usage 기록이 동작한다.
- [ ] A: 임시 workspace+PES MCP로 동작하고 실제 `~/pes-projects`·`~/.pes` 자료를 읽지 않는다. 결과는 PES API로 제출한다.
- [ ] A: DeepSeek 고정, 비용/시간 상한, Go OFF(세션 전·매 prompt·요약·첨부·재시도)와 `outbound_dispatches` prepared/authorized/sent/blocked/unknown이 동작한다.
- [ ] B Claude Code: MCP 6도구로 한 라운드, 도구 호출 heartbeat, TUI 종료 후 lease 만료, 재시작 claim·`run_input_receipts` 복구가 동작한다.
- [ ] B Claude 앱: 지속 연결·heartbeat 없이 패킷 전달·결과 회수·검증·재개 경로가 문서와 1회 시험으로 증명된다. 원격 MCP 가능성은 2단계에서 조사하고 정식 지원은 5단계로 남긴다.
- [ ] 질문 시 lease 해제·`waiting_human`, 답 후 재-claim·fence 증가, `lease_lost` 처리가 A/B 모두 같다.
- [ ] 서브에이전트 4역할이 A/B에서 같은 결과 형식을 내고, reviewer는 별도 run으로 독립성을 지킨다.
- [ ] 스킬 lint가 Claude 전용 토큰을 어댑터 밖에서 거부하고, core+plan 파일럿이 A/B에서 같은 워크플로를 따른다.
- [ ] A→B, B→A 인계가 같은 stage/round에서 데이터 손실·중복 없이 된다.
- [ ] TTL/heartbeat 후보가 SEL-18·19 시험 결과와 함께 표로 정리되고, 기본값이 `stage-1-db` PR 5에 반영된다.
- [ ] 2단계 22개 PR 매핑이 승인되고, 새 2단계 PR이 없다(필요 시 사유와 함께).

---

## 6. 사용자 결정이 필요한 것

| # | 결정 | 선택지 | 추천 |
|---|---|---|---|
| 1 | A 세션 단위 | 프로젝트/run/항목 | **run당 1개**, 역할은 하위 세션 |
| 2 | A workspace | 실제 프로젝트 폴더/임시/홈 | **임시 `~/.pes/runs/<id>/workspace`** |
| 3 | A 권한 기본 | 모두 허용/정책/모두 질문 | **읽기·검색 자동, 쓰기·셸·네트워크는 정책/사람** |
| 4 | A 비용·시간 상한 | 없음/run당/단계당 | **run당 + 단계 상한**, 값은 시험 후 |
| 5 | A 폴백 | 자동 상위 모델/실패 | **실패(무단 폴백 없음)**, 사용자 결정 7-2 유지 |
| 6 | B Claude 앱 | 원격 MCP 가정/패킷/안 함 | **패킷 기본**, 원격 MCP는 2단계 조사·5단계 정식 |
| 7 | B heartbeat | 지속/도구 호출/없음 | **도구 호출 때만**, 앱은 없음 |
| 8 | TTL/heartbeat | 지금 고정/시험 후 | **SEL-18·19 후 확정** |
| 9 | 서브에이전트 lease | 역할별/부모만/reviewer 별도 | **부모만, reviewer 별도** |
| 10 | reviewer 독립 | 같은 컨텍스트/별도 run/별도 모델 | **별도 run**, 같은 DeepSeek/Claude |
| 11 | 인계 시작 | 에이전트/사람 | **사람**, 에이전트는 pause만 |
| 12 | Claude 앱 결과 전달 | 붙여넣기/파일/API | **붙여넣기+파일**, API는 5단계 |
| 13 | 실행 이벤트 | `events` 재사용/전용 표 | **`events(type='execution.*')`**, 표는 2단계 검토 |
| 14 | 스킬 중립화 범위 | core+plan/전체/복제 | **전체를 중립, core+plan 먼저 파일럿** |

---

## 7. 다른 설계·2단계로 넘길 것

- **DB**: 새 표를 만들지 않는다. `runs.role`은 `worker|reviewer`만 쓰고 세부 역할은 `workflow_version`/`parent_run_id`/이벤트로 구분한다. 실행 이벤트가 너무 많으면 2단계에서 `execution_events` 표를 별도 PR로 검토한다. `runs.usage_json`, `outbound_dispatches`, `run_input_receipts`를 그대로 쓴다.
- **API**: SEL-22의 HTTP 계약을 쓴다. A 어댑터의 execution event 기록은 내부 서비스로 하고, B에 공개 execution-event endpoint를 만들지 않는다. `pes_ask`/`inbox`/`claim`/`complete`는 SEL-22 계약을 따른다.
- **화면**: run 상태·lease·실행 권한·비용·인계 버튼, `waiting_human`·`lease_lost` 표시. 3단계에서 live event·첨언, 5단계에서 원격 MCP·로그인.
- **실행 구조**: OpenCode 프로세스 관리·Windows 서비스·로그 회전은 2단계 PR 19. Claude 앱 원격 연결 가능성은 2단계에서 조사하고 정식 지원은 5단계. `pes home`·DB·객체 위치는 2단계.
- **0단계 입력**: SEL-18·19의 측정값(시작 지연·비용·중단·재개·TTL)을 PR 5·19·20의 기본값으로 쓴다. 아직 없으므로 본 문서는 후보만 남긴다.

---

## 8. 구현 이슈 예상

**2단계 22개 PR 유지.** 실행 구조 작업은 아래 기존 PR에 붙이고, 새 2단계 PR은 만들지 않는다. 각 PR에 테스트 포함.

| 기존 PR | 실행 구조에서 추가되는 일 |
|---|---|
| 5 run·lease·fence | claim/heartbeat/pause/re-claim, `waiting_human` lease 해제, TTL/heartbeat 값, `run_input_receipts`, 인계 |
| 10 actor·token·policy | A/B actor·runtime, B 토큰, 실행 권한, Go 정책 강제 |
| 17 스킬 직접 편집 제거 | 중립 워크플로+어댑터 노트, 금지 토큰 lint, core+plan 파일럿 |
| 18 로컬 화면 | run 상태·lease·실행 권한·비용·인계·`lease_lost` UI |
| 19 A 어댑터 | OpenCode serve/version/session/prompt/event/interrupt/model/permission/form/usage, workspace·MCP, 상한, Go OFF |
| 20 B 어댑터 | MCP 6도구, Claude Code heartbeat/lease expiry/resume, Claude 앱 패킷 |
| 21 A·B 교차 계약 | 같은 artifact·질문·답·event, 인계, 경쟁·유실·중복, Go OFF |
| 22 통합 검증·문서 | 실행 안내, TTL/heartbeat 표, Windows/Mac, 복구 절차 |

**새로 필요한 것(2단계 아님)**: 5단계 Claude 앱 원격 MCP·인증, 3단계 live execution UI, 6단계 다중 에이전트. 2단계 이슈 수는 **22개 유지**; 실행 이벤트 전용 표가 필요해지면 그때 별도 PR/마이그레이션으로 추가한다.

---

## 9. 근거

### 확정·합의
- `docs/plan/00-brief.md:3`, `docs/plan/stage-0.md:31` — 공개 저장소, 실자료 금지
- `docs/plan/stage-0.md:12-14` — 원칙 0(에이전트는 상태를 직접 쓰지 않음)
- `docs/plan/stage-0.md:42` — API 계약은 1단계로
- `docs/plan/stage-0.md:46-48` — 공통 시나리오, A/B 역할·차이
- `docs/plan/stage-0.md:87-90` — Go 기본 켜짐+끄기, A DeepSeek 하나, B Claude Code/앱
- `docs/plan/stage-1-db.md:14-34` — 합의 결정 17개
- `docs/plan/stage-1-db.md:32` — 실행 담당 하나, lease는 결과 채택만 제한, 질문 대기 중 해제
- `docs/plan/stage-1-db.md:44-50` — actors/project_members/agent_tokens
- `docs/plan/stage-1-db.md:103-117` — runs/run_targets/leases/receipts/events/outbound
- `docs/plan/stage-1-db.md:136-144` — A/B 표
- `docs/plan/stage-1-db.md:158-163` — 화면/실행 구조로 넘기는 것
- `docs/plan/stage-1-db.md:165-170` — 1단계 완료 기준
- `docs/plan/stage-1-db.md:172-202` — 2단계 22개 PR
- `docs/plan/stage-1-db.md:203-215` — Codex 보완(run role/usage, Go OFF, 0행)

### DDL 초안
- `docs/plan/schemas/stage-1-ddl-draft.sql:12-33` — users/actors
- `:35-77` — projects/members/tokens
- `:79-111` — mutation_commits
- `:113-159` — policy/editions
- `:161-210` — stages/rounds
- `:252-273` — approvals
- `:275-331` — objects/versions
- `:451-524` — questions/question_sets
- `:526-576` — submissions/answers
- `:638-698` — anchors/threads
- `:700-821` — messages/followups/reflection
- `:823-901` — runs/run_targets/project_leases/run_input_receipts
- `:903-948` — events/outbound_dispatches
- `:950-955` — db_meta
- `:990-1002` — 인덱스

### OpenCode·조사
- OpenCode v2.2.5 API: <https://opencode.ai/v2/docs/api> — `/api/info`, `/api/session`, `/prompt`, `/event`, `/interrupt`, `/model`, `/permission`, `/form`, `/api/experimental/usage/limits`, `/api/model`
- `docs/plan/discussion/stage-0-opencode.md:631-676` — A: serve/API, 질문 분리, 품질 기준
- `:678-717` — B: MCP 6도구, HTTP 원본, lease
- `:719-745` — 스킬 중립화
- `:880-899` — 공통 객체·claim→context→submit→ask→wait→complete
- `:901-930` — A/B 준비 체크리스트
- `docs/plan/research/notion-linear.md:106` — 에이전트 귀속(onBehalfOf)
- `:149` — PES 원본, 외부는 내보내기만
- `docs/plan/research/webmcp.md:19-25` — WebMCP 도구·위험도
- `:35-37` — 승인·reopen·판 시작 비노출, 브라우저 에이전트 기록

### 현재 코드·스킬
- `agents/researcher.md:1-25` — 항목 하나·결과 파일·한 줄 반환
- `agents/reviewer.md:1-10` — QC/QA 독립 검토
- `agents/verifier.md:1-25` — claim 판정
- `agents/writer.md:1-25` — 장 하나·각주
- `skills/core/SKILL.md:16` — AskUserQuestion
- `:23` — CLAUDE_PLUGIN_ROOT
- `:62-84` — 직접 JSON 편집(2단계 제거)
- `:86-92` — digest/show 토큰 절약
- `:109` — PES_OWNER
- `:120-126` — 독립 검토
- `:123` — Agent, model opus
- `:154` — anthropic-skills
- `skills/research/SKILL.md:31-33` — researcher 병렬·sonnet/opus
- `skills/write/SKILL.md:27` — writer 병렬
- `skills/verify/SKILL.md:19` — verifier
- `commands/run.md:10-15` — pending 처리·재개
- `scripts/pes.py:516-563` — pending/mark
- `scripts/pes.py:587-640` — digest/show
- `README.md:548-563` — 프로젝트 폴더 구조
