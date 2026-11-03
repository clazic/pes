# 0단계 기반 다지기 — 계획서 (확정)

- 작성: 2026-11-04, Claude 종합
- 입력: [stage-0-codex.md](discussion/stage-0-codex.md)(Codex, GPT-6.1-Sol high), [stage-0-opencode.md](discussion/stage-0-opencode.md)(OpenCode, DeepSeek V4.1 Flash high), [00-brief.md](00-brief.md)
- 검토: Opus 5.5(2026-11-04) — 확정 15, 수정함 2, 수정 필요 7, 사용자 결정 4. 수정 필요 7건은 이슈 보강·새 이슈(SEL-31)로 반영했고, 사용자 결정 4건은 사용자가 답함(7절).
- 상태: **확정** — 사용자 승인 2026-11-04 ("0단계 계획 확정").

## 1. 목표

**v0.15.6을 깨지 않고 바꿀 수 있는 상태**를 만든다. 기능은 더하지 않는다. 0단계가 끝나면 다른 에이전트가 `AGENTS.md`만 읽고 테스트를 돌리고, 합성 프로젝트 사본을 복원하고, 방식 A·B가 실제로 가능한지 증거를 가지고 1단계 설계를 시작할 수 있어야 한다.

두 의견이 같이 짚은 핵심: 테스트가 없는 것보다 **상태를 쓰는 경로가 여러 개**라는 점이 더 위험하다 — CLI, 스킬의 직접 `project.json` 편집(`skills/core/SKILL.md:62-84`), 웹 `POST /feedback`(`scripts/serve.py:111-152`).

> **원칙 0: 에이전트는 상태를 직접 쓰지 않는다.** 모든 쓰기는 PES가 검증하는 하나의 경로를 지난다. (지금 스킬의 직접 편집은 현행으로 기록하고, 2단계에서 없앤다.)

## 2. 주제와 결정

| # | 주제 | 결정 | 맡은 이슈 |
|---|---|---|---|
| 1 | 현행 기준선 | 사용자 결과·상태 전이를 보존(6단계·라운드·질문별 답과 `__other` 덧붙임·승인·재개·reopen과 stale·출처 연결·보고서). 포트·HTML 배치·파일 시각 알림은 보존 대상 아님. 기준 커밋 `b109177`(v0.15.6) | SEL-17 |
| 2 | 테스트 범위 | `pytest`(개발 전용). 데이터·상태 전이·답 수신·잠금·잘못된 입력·**질문 화면 핵심**·**보고서 생성**. HTML 전체 문자열·LLM 문장 일치는 기준 아님 | SEL-11·12·13 (질문 화면 → SEL-13, 보고서 → SEL-12) |
| 3 | 테스트 경계 | `main(argv)` 진입점, 시각·포트·홈 경로 주입만. 동작 바꾸는 정리 금지 | SEL-11 |
| 4 | 테스트 자료 | 합성 fixture + 임시 홈. `PES_HOME`과 `~/.pes/config.json` 모두 격리. 한글·공백 경로, **깨진 `project.json`, 2MB급 `project.json`** | SEL-11(fixture), SEL-12(읽기 동작) |
| 5 | 결함 | SEL-12·13이 재현(xfail strict) → **자료 손실·답 유실·승인 오처리 계열은 SEL-31이 0단계 안에 고침**(스냅샷 덮어쓰기, 동시 답 수신 `serve.py:141-145`, reopen 후 complete). 나머지는 `docs/plan/defects.md`에 기록 | SEL-12·13 → SEL-31 |
| 6 | AGENTS.md | PES **개발** 규칙의 원본. `CLAUDE.md`는 가리키기만. `skills/core`는 PES로 **연구**하는 규칙 — 섞지 않음 | SEL-14 |
| 7 | 개발 규칙 | 짧은 브랜치·한 변경 한 목적. 결정은 `docs/plan/decisions/`. 문서만 바꾸면 버전 안 올림 | SEL-14 |
| 8 | 환경·CI | Windows+macOS, Python 3.9 이상 유지(`doctor`가 이미 검사, `pes.py:1403`). CI는 **매 PR + main**(7절 4번) | SEL-15 |
| 9 | 백업·복원 | 프로젝트 폴더 전체 목록화(SEL-17) + **합성 프로젝트를 다른 곳에 복원→재로딩→재생성 시험**(SEL-12) | SEL-17, SEL-12 |
| 10 | 스키마 기준선 | 현재 `project.json` 구조를 JSON Schema로 **기술만**. `"pes": 1`은 `pes.py:206`에서 쓰기만 하고 읽는 곳 없음. 검증·마이그레이션은 2단계 | SEL-17 |
| 11 | research-loop | 별도 GitHub 저장소로 보존(`~/projects/research-loop`, 아직 없음). PES엔 가져오기 합성 fixture만 | (PES 밖 — Claude가 직접) |
| 12 | 보안 | 저장소는 **공개**(7절 4번 결정으로 되돌림). 저장소 전체 민감 자료 점검, `.gitignore` 보강, fixture·로그에 실키·기관 자료 금지 | SEL-16, SEL-14 |
| 13 | 방식 A 시험 | opencode 서버 API로 **공통 시나리오**(4절 1번) 한 라운드 + 이벤트·중단·재개·권한·사용량. 모델은 `opencode-go/deepseek-v4.1-flash` 하나(7절 2번). 안 되면 조용히 빼지 않고 다시 정함 | SEL-18 |
| 14 | 방식 B 시험 | Claude Code로 **공통 시나리오** 한 라운드 + 재개·잠금. Claude 앱은 연결 방법만 조사(7절 3번) | SEL-19 |
| 15 | 진단 | 기존 `doctor` 먼저. 결함 기록 형식(버전·OS·명령·기대·실제·재현 자료·심각도·처리 단계)을 `AGENTS.md`에 정하고 `docs/plan/defects.md` | SEL-14 |

## 3. 의견이 갈린 곳

**API·스키마 계약을 0단계에서 어디까지 만들까**

- OpenCode: 0단계에 `api-v0.md`, JSON Schema, MCP 도구 6개 명세, 가짜 A·B 어댑터 계약 테스트, 스킬 중립화까지.
- Codex: 0단계에는 용어표·동작 목록·정상/오류 예제까지만. 필드명·경로·DB 테이블은 1단계.
- **결정: Codex 쪽.** 1단계와 겹치지 않게. OpenCode 안 — 라운드 흐름 `claim → context → submit → ask → wait → complete`, 객체 초안(Project/Stage/Item/Run/Question/Answer/Event), `rev`·`lease_id`, 방식 B는 MCP 도구(HTTP가 원본), 스킬은 "중립 워크플로 + 에이전트별 어댑터", 모델은 역할로만 — 은 **1단계 입력**으로 넘긴다.

## 4. 방식 A·B 공통으로 0단계에 준비할 것

1. **공통 시나리오**(SEL-18·19가 같이 씀): 합성 프로젝트에서 맥락 읽기(`pes.py status`) → 결과 JSON 작성 → `merge`/`render` → 질문 화면 생성 → 사람 답 흉내(`POST /feedback`) → 미처리 답 처리 → 에이전트를 끄고 다시 띄워 재개. A든 B든 결과의 의미가 같아야 한다.
2. **역할 분담**: PES 코어 = 상태·검증·저장·질문/답·기록, 에이전트 = 추론·조사·집필, 어댑터 = 실행 시작/중단·권한·모델 매핑·세션.
3. **차이 인정**: A는 OpenCode 서버 없이는 못 돈다 → B를 늘 남긴다. PES 질문이 원본이고, OpenCode의 form/permission은 실행 수준 질문으로 따로 둔다.
4. **용어표와 동작 목록**(SEL-17).

## 5. 산출물 → 이슈

| 산출물 | 이슈 |
|---|---|
| `tests/`, 실행 명령 하나, 합성 fixture(깨진·큰 파일 포함) | SEL-11 |
| 상태 전이·보고서 생성·복원 시험 | SEL-12 |
| 답 수신·잠금·질문 화면 테스트 | SEL-13 |
| 결함 수정(자료 손실·답 유실·승인 오처리 계열) | SEL-31 |
| `AGENTS.md`, `CLAUDE.md`, `docs/plan/decisions/`, `docs/plan/defects.md` | SEL-14 |
| CI(매 PR + main, Windows·macOS) | SEL-15 |
| 공개 저장소 점검(README·`.gitignore`·민감 자료) | SEL-16 |
| `baseline.md`, `glossary.md`, `schemas/project-v0.15.json`, 보존 파일 목록 | SEL-17 |
| 방식 A 시험 기록 `spikes/mode-a-opencode.md` | SEL-18 |
| 방식 B 시험 기록 `spikes/mode-b-tui.md` | SEL-19 |
| `~/projects/research-loop` 저장소 | (PES 밖 — Claude가 직접, 이슈 없음) |

이슈 수: 0단계 구현 10개(SEL-11~19, 31) + 계획 1개(SEL-20).

## 6. 완료 기준

| 게이트 | 통과 조건 | 이슈 |
|---|---|---|
| 동작 고정 | 2절 2번 범위의 테스트가 한 명령으로 통과. 실제 모델·키·네트워크 없이 | SEL-11·12·13 |
| 격리 | 테스트가 실제 PES 홈·설정·서버를 건드리지 않음 | SEL-11 |
| 결함 | 자료 손실·답 유실·승인 오처리 계열은 고쳐서 xfail 없음. 나머지는 `defects.md`에 기록 | SEL-31 |
| CI | 매 PR에서 Windows·macOS 통과 | SEL-15 |
| 복원 | 합성 프로젝트 별도 위치 복원·재생성 성공 | SEL-12 |
| AGENTS.md | 새 세션(Claude·Codex·OpenCode)이 이것만 보고 테스트 재현 | SEL-14 |
| 방식 A | DeepSeek로 공통 시나리오 + 중단·재개, 측정값과 한계 기록 | SEL-18 |
| 방식 B | Claude Code로 공통 시나리오 + 재개, Claude 앱 연결 방법 조사 | SEL-19 |
| 문서 | 용어표·기준선·스키마 기술·결정 기록·결함 기록 | SEL-14·17 |
| 공개 점검 | 민감 자료 없음 확인 | SEL-16 |
| 승인 | 사용자가 "1단계로 넘어가도 된다"고 승인 | — |

## 7. 결정 사항 (사용자, 2026-11-04)

1. **OpenCode Go에 비공개 연구 자료 전송**: 보내는 방향, 나중에 끌 수 있게. → 프로젝트별로 끌 수 있는 설정을 1단계 DB·API에 넣는다. 0단계 시험은 합성 자료만.
2. **방식 A 범위**: 6단계 **전체**를 일단 **DeepSeek(`opencode-go/deepseek-v4.1-flash`) 하나로** 통일. (모델 역할 나누기는 시험 결과를 보고 나중에)
3. **방식 B 보장 에이전트**: **Claude Code와 Claude 앱**. 0단계 시험은 Claude Code로 하고, Claude 앱은 연결 방법을 조사한다. Codex·OpenCode TUI는 1단계 어댑터 설계 때.
4. **CI**: 저장소를 **다시 공개로 돌리고 매 PR마다** 돌린다(2026-11-04 공개 전환 완료).
5. **결함 처리**: 재현은 SEL-12·13, 고치기는 수정 이슈 하나(SEL-31).
6. (1단계로 넘김) OneDrive로 여러 컴퓨터에서 같은 프로젝트를 계속 쓸지, `project.json`과 DB 병행 기간을 둘지.

## 8. 1단계로 넘기는 입력

- OpenCode의 계약 초안(3절)
- [research/notion-linear.md](research/notion-linear.md): 선택한 글에 "첨언 / AI에게 묻기 / 할 일로", Cmd+K와 AI 전환, 맥락 동작·"프롬프트로 복사", 미리보기, 번호 붙은 변경 기록과 바뀐 것만 동기화, PES가 원본이고 Linear·Notion으로는 보내기만
- [research/webmcp.md](research/webmcp.md): API 동작마다 WebMCP 노출 가능 여부·위험도 표시, 승인·reopen·판 시작은 노출 금지
- 7절 1번(자료 보내기 끄기 설정), 3번(Claude 앱 연결), 6번
