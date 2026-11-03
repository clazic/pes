# 0단계 기반 다지기 — 설계서 (초안)

- 작성: 2026-11-04, Claude 종합
- 입력: [stage-0-codex.md](discussion/stage-0-codex.md)(Codex, GPT-6.1-Sol high), [stage-0-opencode.md](discussion/stage-0-opencode.md)(OpenCode, DeepSeek V4.1 Flash high), [00-brief.md](00-brief.md)
- 상태: **초안 — 사용자 결정 대기 항목 있음**(7절). 에이전트 추천은 사용자 승인이 아니다.

## 1. 목표

**v0.15.6을 깨지 않고 바꿀 수 있는 상태**를 만든다. 기능은 더하지 않는다. 0단계가 끝나면 다른 에이전트가 `AGENTS.md`만 읽고 테스트를 돌리고, 실제 프로젝트 사본을 복원하고, 방식 A·B가 실제로 가능한지 증거를 가지고 1단계 설계를 시작할 수 있어야 한다.

두 의견이 같이 짚은 핵심: 테스트가 없는 것보다 **상태를 쓰는 경로가 여러 개**라는 점이 더 위험하다 — CLI, 스킬의 직접 `project.json` 편집(`skills/core/SKILL.md:62-84`), 웹 `POST /feedback`(`scripts/serve.py:111-152`). 그래서 0단계의 원칙을 하나 정한다.

> **원칙 0: 에이전트는 상태를 직접 쓰지 않는다.** 모든 쓰기는 PES가 검증하는 하나의 경로를 지난다. (지금 스킬의 직접 편집은 현행으로 기록하고, 2단계에서 없앤다.)

## 2. 주제와 결정

| # | 주제 | 정할 것 | 결정(추천) | 근거·출처 |
|---|---|---|---|---|
| 1 | 현행 기준선 | 보존할 동작 / 의도적 변경 / 결함 / 미확인 구분 | 사용자 결과·상태 전이를 보존(6단계·라운드·질문별 답과 `__other` 덧붙임·승인·재개·reopen과 stale·출처 연결·보고서). 포트·HTML 배치·파일 시각 알림은 보존 대상 아님. 기준 커밋 `b109177`(v0.15.6) | 둘 다 |
| 2 | 테스트 범위 | 층위·도구·멈춤 기준 | `pytest`(개발 전용, 제품 실행엔 불필요). 데이터·상태 전이·답 수신·잠금·잘못된 입력·질문 화면 핵심·보고서 생성. HTML 전체 문자열·LLM 문장 일치는 기준 아님 | Codex 2절 표, OpenCode 3.1 |
| 3 | 테스트 경계(seam) | 테스트를 위해 허용할 최소 리팩터 | `main(argv)` 진입점, 시각·포트·홈 경로 주입만. 동작 바꾸는 정리는 금지 | OpenCode 3.2 |
| 4 | 테스트 자료 | 실자료 사용 여부, 격리 | 합성 fixture + 임시 홈. `PES_HOME`과 `~/.pes/config.json` 모두 격리. 한글·공백 경로, 깨진 JSON, 2MB급 `project.json` 포함. 실제 `~/pes-projects`는 절대 안 건드림 | 둘 다 |
| 5 | 결함 후보 | 발견한 것 처리 | 재현 테스트로 먼저 확인 후 등록: 완료 후 reopen 시 complete 미해제, 같은 병합 재전송 시 depth 증가, 같은 라운드 스냅샷 덮어쓰기, 동시 답 수신. 자료 손실·승인 오처리·답 유실은 0단계 안에 고침 | Codex 2절 |
| 6 | AGENTS.md | 개발 규칙의 원본 | 루트 `AGENTS.md` = PES **개발** 규칙(저장소 지도, 검사 명령, 실자료 금지, 변경·검토·결정 기록). `CLAUDE.md`는 가리키기만. `skills/core`는 PES로 **연구**하는 규칙 — 섞지 않음 | 둘 다 |
| 7 | 개발 규칙 | 변경 단위·결정 기록 | 짧은 브랜치·한 변경 한 목적. 결정은 `docs/plan/decisions/`(문제/선택지/채택/이유/영향/재검토 조건/상태). 문서만 바꾸면 버전 안 올림 | 둘 다 |
| 8 | 환경·CI | OS·Python·CI | Windows+macOS. Python 최소 3.9 유지(올릴지는 2단계에서). CI 빈도는 **사용자 결정**(7절) | 둘 다 |
| 9 | 백업·복원 | 보존 단위, 이전 기준 | 프로젝트 폴더 전체(`project.json`, `library.json`, `feedback/`, `ask/`, `snapshots/`, `rounds/`, `shots/`, `reports/`, `out/`) 목록화. 합성 프로젝트를 다른 곳에 복원→재로딩→재생성 성공을 확인 | Codex 8 |
| 10 | 스키마 기준선 | `project.json` 버전 | `"pes": 1`을 읽는 곳이 없음 → 현재 구조를 JSON Schema로 **기술만** 하고(동결), 검증·마이그레이션 구현은 2단계 | OpenCode 3.9 |
| 11 | research-loop | 저장소 처리 | 별도 비공개 저장소로 보존(`~/projects/research-loop`, GitHub 비공개). PES에는 가져오기 합성 fixture만. 통합·폐지는 하지 않음 | 둘 다 + 사용자 이전 결정 |
| 12 | 보안 기준선 | 비밀·공개 범위 | 저장소 비공개 전환 반영(README 설치 안내 수정). fixture·로그에 실키·기관 자료 금지. `.gitignore` 보강 | Codex 11 |
| 13 | 방식 A 시험 | OpenCode Go로 실제 되는지 | `opencode serve` + HTTP API로 임시 프로젝트에서 세션 생성→작업→결과 파일→중단·재개까지 확인. 지연·실패율·사용량 기록. 안 되면 조용히 빼지 않고 사용자와 다시 정함 | 둘 다(OpenCode 3.14가 구체적) |
| 14 | 방식 B 시험 | 터미널 에이전트로 되는지 | Claude Code로 합성 작업 받기→결과 제출→답 읽기→껐다 켜도 이어 가기 1회. Codex·OpenCode TUI는 범위 결정에 따라(7절) | 둘 다 |
| 15 | 진단 | 버그 기록 형식 | 기존 `doctor` 활용. 결함은 버전·OS·명령·기대·실제·재현 자료로 기록 | Codex 12 |

## 3. 의견이 갈린 곳

**API·스키마 계약을 0단계에서 어디까지 만들까**

- OpenCode: 0단계에 `api-v0.md`, JSON Schema, MCP 도구 6개 명세, 가짜 A·B 어댑터 계약 테스트, 스킬 중립화(core·plan 파일럿)까지 만들자.
- Codex: 0단계에는 용어표·동작 목록·정상/오류 예제까지만. 필드명·경로·DB 테이블은 1단계에서 확정.
- **Claude 판단: Codex 쪽.** 계약을 0단계에서 만들면 1단계(설계)와 겹치고, 0단계가 끝나지 않는다. 대신 OpenCode의 내용은 버리지 않고 **1단계 입력**으로 넘긴다 — 라운드 흐름 `claim → context → submit → ask → wait → complete`, 객체 초안(Project/Stage/Item/Run/Question/Answer/Event), `rev`·`lease_id`를 처음부터 넣기, 방식 B는 **MCP 도구**로 붙이고 HTTP가 원본, 스킬은 "중립 워크플로 + 에이전트별 어댑터"로 나누기, 모델은 `strong|cheap|vision` 역할로만 적기.

## 4. 방식 A·B 공통으로 0단계에 준비할 것

1. **같은 시나리오 하나**: 사람이 답함 → 작업 → 결과·질문 게시 → 의견 반영 → 승인 → 재개. A든 B든 결과의 의미가 같아야 한다.
2. **역할 분담 원칙**(OpenCode 4.1): PES 코어 = 상태·검증·저장·질문/답·기록, 에이전트 = 추론·조사·집필, 어댑터 = 실행 시작/중단·권한·모델 매핑·세션.
3. **차이를 미리 인정**: A는 OpenCode 서버 없이는 못 돈다 → B(오프라인)를 항상 남긴다. PES 질문이 원본이고, OpenCode의 form/permission은 실행 수준 질문으로 따로 둔다.
4. **용어표와 동작 목록**: 프로젝트·판·단계·라운드·항목·질문·답·작업·실행·산출물·승인 / 맥락 읽기·일 받기·결과 제출·질문 올리기·답 읽기·처리 확인·중단·인계.

## 5. 산출물

| 산출물 | 비고 |
|---|---|
| `tests/` + 실행 명령 하나 | 합성 fixture 포함 |
| `AGENTS.md`, `CLAUDE.md`(포인터) | |
| `.github/workflows/ci.yml` | Windows+macOS |
| `docs/plan/decisions/` | 결정 기록 |
| `docs/plan/baseline.md` | 보존 동작·결함·현행과 요구 차이 |
| `docs/plan/schemas/project-v0.15.json` | 현행 구조 기술(검증 구현 아님) |
| `docs/plan/spikes/mode-a-opencode.md`, `mode-b-tui.md` | 시험 기록·측정값·되는지 여부 |
| `docs/plan/glossary.md` | 용어표·동작 목록 |
| README 설치 안내 수정 | 비공개 저장소 반영 |
| `~/projects/research-loop` 비공개 저장소 | |

## 6. 완료 기준

| 게이트 | 통과 조건 |
|---|---|
| 동작 고정 | 2절 2번 범위의 테스트가 한 명령으로 통과. 실제 모델·키·네트워크 없이 |
| 격리 | 테스트가 실제 PES 홈·설정·서버를 건드리지 않음을 확인 |
| 결함 | 자료 손실·승인 오처리·답 유실 계열은 고침. 나머지는 재현 자료와 처리 단계 기록 |
| CI | Windows·macOS 통과 |
| 복원 | 합성 프로젝트 별도 위치 복원·재생성 성공 |
| AGENTS.md | 새 세션(Claude·Codex·OpenCode)이 이것만 보고 테스트 재현 |
| 방식 A | OpenCode Go로 최소 왕복 + 중단·재개 확인, 측정값과 한계 기록 |
| 방식 B | Claude Code로 최소 왕복 + 재개 확인 |
| 문서 | 용어표·기준선·스키마 기술·결정 기록 존재, README 수정 |
| 승인 | 사용자가 "1단계로 넘어가도 된다"고 승인 |

## 7. 결정 사항

사용자 지시(2026-11-04): "두 가지 길(방식 A·B)로, 일단 해 보자." → 아래 2~4는 **추천안으로 임시 진행**하고, 시험 결과를 보고 사용자가 다시 정한다.

1. **OpenCode Go에 비공개 연구 자료 전송: 보내는 방향으로 진행, 나중에 바꿀 수 있게**(사용자 답). → 프로젝트별 설정으로 끌 수 있어야 한다는 요구를 1단계 설계에 넣는다. 0단계 시험은 합성 자료로만 한다.
2. 방식 A 첫 범위: (임시) 조사·요약부터 시험, 결과 보고 넓힘.
3. 방식 B 보장 에이전트: (임시) Claude Code 먼저. Codex·OpenCode TUI는 1단계 어댑터 설계 때.
4. CI 빈도: (임시) main 반영 + 수동 실행만.
5. (1단계로 넘김) OneDrive로 여러 컴퓨터에서 같은 프로젝트를 계속 쓸지, `project.json`과 DB 병행 기간을 둘지.

## 8. 1단계로 넘기는 입력

- OpenCode의 계약 초안(3절)
- [research/notion-linear.md](research/notion-linear.md): 선택한 글에 "첨언 / AI에게 묻기 / 할 일로", Cmd+K와 AI 전환, 맥락 동작·"프롬프트로 복사", 미리보기, 번호 붙은 변경 기록과 바뀐 것만 동기화, PES가 원본이고 Linear·Notion으로는 보내기만
- [research/webmcp.md](research/webmcp.md): API 동작마다 WebMCP 노출 가능 여부·위험도 표시, 승인·reopen·판 시작은 노출 금지
