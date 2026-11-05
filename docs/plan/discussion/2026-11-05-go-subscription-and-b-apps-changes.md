# 2026-11-05 Go 구독 사용량·모델 선택, 방식 B 앱 추가 — 변경 기록

> **최종(8차)**: 2단계 25·3단계 11·4단계 9·5단계 16·6단계 9, 신규 70+기존 31=101, DDL **61표**. 아래 97·98개와 54표는 1·2차 시점 기록이다. 최신 내용은 [2026-11-05-mode-a-web-direct-and-references.md](2026-11-05-mode-a-web-direct-and-references.md)를 본다.

- 입력: 사용자 요청 2건(2026-11-05), `decisions/0013`, `decisions/0014`
- 범위: `docs/plan`만 수정. 실제 `~/pes-projects`·`~/.pes/`는 읽거나 쓰지 않았다. 커밋·push·Linear 등록은 하지 않았다.

## 1. 방식 A — Go 구독 사용량·모델 선택

- 과금 경로를 **OpenCode Go 구독 사용량만**으로 정리했다. Extra Usage는 PES가 켜지 않고, 설정 화면·설치 안내에 "꺼 두세요"를 표시한다.
- 실행 전·중에 `usage/limits`를 읽어 rolling/weekly/monthly 중 하나라도 `limited=true`이거나 PES 문턱(기본 90%) 이상이면 새 run·재시도·reviewer를 시작하지 않고, 진행 중 run은 `waiting`+`resetsAt`으로 멈춘다. usage 실패·unknown은 fail-closed.
- 세션 cost가 0이 아니면 즉시 멈추고 알린다. 토큰·턴·시간 상한은 폭주 방지용으로 유지한다.
- 모델은 사용자가 `opencode-go/*` active 목록에서 고른다. 기본값 `opencode-go/deepseek-v4.1-flash`, provider는 `opencode-go` 고정, run 중 폴백 없음, `runs.model`에 기록.
- `runs`의 A 모델 CHECK를 `model LIKE 'opencode-go/%'`로 넓히고, `project_policy_versions`에 `mode_a_model`·`go_usage_stop_percent`를 추가했다.
- 0002 상태에 "일부 대체: 0013"을 추가했다.

## 2. 방식 B — Codex 앱·OpenCode 앱 추가

- 2단계에 **PR20c(Codex 앱·OpenCode 앱)** 를 추가했다. 20a 공통 MCP bridge·계약과 20b의 codex/opencode-tui 노트를 재사용한다.
- Codex 앱의 CLI 설정 공유, OpenCode 앱의 MCP 설정 공유는 **미확인**이다. 직접 연결이 안 되면 명시적 전달(복사·붙여넣기)을 보장 경로로 두고 실제 제출자는 사람으로 기록한다.
- OpenCode 앱은 PES의 A 전용 opencode 프로필·서버와 분리한다.
- `runs` runtime 표기에 `codex_app`·`opencode_app`을 추가하고, D4 어댑터 노트에 `codex-app`·`opencode-app`을 추가했다.
- 0003 영향에 0014를 참조했다.

## 3. 이슈 수·의존

- 2단계 24개(PR1~19, 20a, 20b, 20c, 21, 22), 6단계 9개.
- 전체 97개(SEL-1~31 31 + 2~6단계 신규 66), Linear 260 한도에 163개 여유.
- 누적: 2단계 뒤 55, 3단계 뒤 64, 4단계 뒤 73, 5단계 뒤 88, 6단계 뒤 97.
- B 전체를 뜻하는 선행(PR21, U9, U10, WEB5, G3)에 20c를 추가했다.

## 4. 바꾼 파일

- `docs/plan/decisions/0013-mode-a-go-subscription-and-model-choice.md` (신규)
- `docs/plan/decisions/0014-mode-b-codex-app-opencode-app.md` (신규)
- `docs/plan/decisions/0002-mode-a-deepseek.md`
- `docs/plan/decisions/0003-mode-b-agents.md`
- `docs/plan/decisions/0012-mode-b-codex-opencode-tui-stage2.md` (0014 참조)
- `docs/plan/decisions/README.md`
- `docs/plan/schemas/stage-1-ddl-draft.sql`
- `docs/plan/stage-1-runners.md` (A2·A7·B5·D4·7절·11절·12절, B runtime)
- `docs/plan/stage-1-db.md` (A/B 표, PR19, 예산)
- `docs/plan/stage-2.md` (PR19·20b·20c·21, 의존·묶음, 6절 2번, 24개)
- `docs/plan/stage-3.md` (여섯 어댑터, 24개, R1·U5·T1 의존)
- `docs/plan/stage-4.md` (여섯 에이전트, U9·U10, Go 사용량)
- `docs/plan/stage-5.md` (WEB5·WEB12·WEB14, 여섯 어댑터, Go 사용량)
- `docs/plan/stage-6.md` (G3·H1·2.2절, PR20b·20c 회귀)
- `docs/plan/roadmap.md`
- `docs/plan/summary-for-approval.md`
- `docs/plan/00-brief.md`
- `docs/plan/issues/stage-2.md` (PR19·PR20c·PR21 초안, 24개)
- `docs/plan/issues/stage-3.md` (여섯 어댑터, R1 Go 사용량)
- `docs/plan/issues/stage-4.md` (여섯 경로·20c 선행)
- `docs/plan/issues/stage-5.md` (여섯 경로·20c 선행)
- `docs/plan/issues/stage-6.md` (G3 여섯 에이전트)

## 5. 검사 결과

- `python3 docs/plan/schemas/check_ddl.py` → **PASS**. DDL 실행, 54표 적재, 거부 50건, 대표 조회 3개, 0행 CAS·늦은 실패 롤백, `foreign_key_check`·`integrity_check` 통과. D1은 미시험(기존과 동일).
- `python3 docs/plan/fixtures/check_fixtures.py` → **검사 통과 38/38**.
- `git diff --check` → 오류 없음.

## 6. 남은 확인

- Codex 앱·OpenCode 앱의 설정 공유 여부는 PR20c에서 실제 시험한다.
- OpenCode Go usage/limits 응답 필드와 Extra Usage 콘솔 설정의 API 확인 가능 여부는 미확인이다. PR19·SEL-18에서 실측한다.
- D1에서 새 열·CHECK의 동작은 2단계 PR2에서 확인한다.

완료: docs/plan/discussion/2026-11-05-go-subscription-and-b-apps-changes.md
