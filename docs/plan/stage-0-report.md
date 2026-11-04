# 0단계 기반 다지기 — 완료 보고서

- 작성: 2026-11-05, OpenCode
- 기준: `origin/main` **dbbec18** (SEL-18 merge), [stage-0.md](stage-0.md) 6절
- 확인: `git log origin/main`, `gh pr list --repo clazic/pes --state all`, `gh run list`, 로컬 `pytest`
- 상태: **미완 — CI(SEL-15)·방식 B(SEL-19) 진행 중, 결정 기록 보완 필요**
- 범위: 저장소 문서·PR·CI·합성 테스트만 확인했다. 실제 `~/pes-projects`·`~/.pes/`는 읽지 않았다. Linear 이슈는 만들지 않았다.

## 1. 게이트 요약

| # | 6절 게이트 | 판정 | 핵심 증거 |
|---|---|---|---|
| 1 | 동작 고정 | **통과** | PR #2·#4·#7 merge, `python3 -m pytest -q` 78 passed·1 xfailed |
| 2 | 격리 | **통과** | PR #2 `tests/conftest.py`의 `isolated_home`, `test_guard_rejects_real_home` |
| 3 | 결함 | **통과** | PR #8 merge, 고위험 결함 3건 수정·시험 통과, 나머지는 `defects.md` |
| 4 | CI | **진행 중** | PR #6 open: Windows 3.9·3.13 성공, macOS 3.9·3.13 8분 timeout 실패 |
| 5 | 복원 | **통과** | `test_restore_copy_reloads_and_regenerates_outputs` 통과 |
| 6 | AGENTS.md | **통과** | PR #5 merge, `AGENTS.md`·`CLAUDE.md`, macOS/Windows 재현 명령 |
| 7 | 방식 A | **통과** | PR #9 merge, `docs/plan/spikes/mode-a-opencode.md`, 6항목 3/3 |
| 8 | 방식 B | **진행 중** | PR #10 open, `mode-b-tui.md`·시험 코드가 아직 main에 없음 |
| 9 | 문서 | **미완** | 기준선·용어표·스키마·결함 기록은 있음. origin/main의 `docs/plan/decisions/`는 README만; 작업 트리에는 0001~0011 초안이 있으나 미커밋 |
| 10 | 공개 점검 | **통과** | PR #1 merge, `.gitignore` 보강·공개 자료 정리 |
| 11 | 승인 | **통과** | `bfea07b` "1단계 설계서 4개 확정 (사용자 승인)" |

**전체 판정: 미완.** 11개 중 통과 8, 진행 중 2, 미완 1이다. 1단계 설계는 이미 진행됐지만, 0단계의 형식적 종료 조건은 아직 닫히지 않았다.

## 2. 게이트별 상세

### 2.1 동작 고정 — 통과

- **PR**: #2 SEL-11(`f6e9c37`), #4 SEL-12(`cc6b664`), #7 SEL-13(`0db5a54`).
- **테스트 파일**: `tests/test_project_basic.py`(19), `tests/test_state.py`(19), `tests/test_lock.py`(6), `tests/test_questions.py`(4), `tests/test_serve.py`(11). 테스트 함수 59개, 파라미터 포함 79 실행.
- **실행**: `python3 -m pytest -q` → **78 passed, 1 xfailed, 1 warning in 7.79s** (macOS 27.2, Python 3.15.2, 임시 venv).
- **의미**: 상태 전이·답 수신·잠금·질문 화면·보고서 생성·복원을 한 명령으로 확인했다. 실제 모델·키·외부 네트워크는 쓰지 않았다.
- **xfail 1건**: `tests/test_state.py::test_resubmitting_same_merge_does_not_raise_depth` — 같은 병합 재전송 시 depth 증가. 자료 손실·답 유실·승인 오처리가 아니며 `docs/plan/defects.md`의 SEL-31-②에 기록됐다.

### 2.2 격리 — 통과

- **PR**: #2 SEL-11(`f6e9c37`).
- **증거**: `tests/conftest.py`의 autouse `isolated_home`이 `HOME`·`PES_HOME`을 임시 경로로 바꾼다. `tests/test_project_basic.py::test_guard_rejects_real_home`과 symlink 차단 시험이 실제 홈 접근을 거부한다. `tests/README.md`에 격리 원리·한계가 있다.
- **실행 확인**: 로컬 전체 테스트가 실제 `~/.pes`·`~/pes-projects`를 건드리지 않고 통과했다.

### 2.3 결함 — 통과

- **PR**: #8 SEL-31(`b588965`).
- **고친 고위험 결함**: 같은 라운드 render의 스냅숏 덮어쓰기(자료 손실), 같은 초 동시 답 수신의 답 유실, reopen 뒤 complete 잔존(승인 오처리). 각각 `tests/test_state.py`·`tests/test_serve.py`에서 재현·수정됐다.
- **확인**: `python3 -m pytest -q tests/test_state.py::test_reopen_complete_project_clears_complete tests/test_state.py::test_render_same_round_does_not_overwrite_snapshot tests/test_serve.py::test_simultaneous_submissions_do_not_lose_answers` → **3 passed**.
- **남은 xfail**: SEL-31-② depth 증가(보통, 비차단). SEL-31-⑤ O_EXCL 예약 직후 빈 파일은 결정적 재현 테스트 없이 코드 경로만 기록됐다. 둘 다 `docs/plan/defects.md`에 있다.

### 2.4 CI — 진행 중

- **PR**: #6 SEL-15, **open** (`ai/SEL-15`). merge 전이다.
- **GitHub Actions run 41892497175**:
  - Windows 3.9·3.13: **성공**
  - macOS 3.9·3.13: **실패** — `Run tests`가 8분 timeout. macOS job이 끝까지 가지 못했다.
- **main**: 현재 main에서 실행된 CI 기록이 없다(`gh run list` 기준 SEL-15 branch 실행만 있음).
- **판정 이유**: "매 PR에서 Windows·macOS 통과"를 아직 만족하지 못한다. Windows 성공은 확인됐지만 macOS 실패·main 미실행이 남았다.

### 2.5 복원 — 통과

- **PR**: #4 SEL-12(`cc6b664`).
- **테스트**: `tests/test_state.py::test_restore_copy_reloads_and_regenerates_outputs`.
- **실행**: `python3 -m pytest -q tests/test_state.py::test_restore_copy_reloads_and_regenerates_outputs` → **1 passed**.
- **내용**: 합성 프로젝트를 `복원 위치/사본 프로젝트`로 복사한 뒤 `status`→`render`→`report`→`assemble`→`web`을 다시 실행해 `project.json`·`index.html`·`reports/plan/report.md`·`out/report.md`·`out/report.html`이 재생성됨을 확인한다. 다른 위치에서 재로딩·재생성하는 게이트를 충족한다.

### 2.6 AGENTS.md — 통과

- **PR**: #5 SEL-14(`2e03cfd`).
- **문서**: `AGENTS.md`(개발 규칙 원본), `CLAUDE.md`(가리키기만), `docs/plan/decisions/README.md`, `docs/plan/defects.md`.
- **재현 명령**: `AGENTS.md`에 macOS/Linux `python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt && .venv/bin/python -m pytest -q`, Windows PowerShell 명령, `HOME`·`PES_HOME` 격리, 결함 기록 형식이 있다. `tests/README.md`가 격리 한계를 보충한다.
- **확인**: 새 임시 venv에서 전체 테스트를 재현했다. 다만 Claude·Codex·OpenCode 세 에이전트별 재현 로그를 저장소에 남긴 것은 아니다.

### 2.7 방식 A — 통과

- **PR**: #9 SEL-18(`dbbec18`).
- **문서**: `docs/plan/spikes/mode-a-opencode.md`, 시험 코드 `docs/plan/spikes/mode-a/mode_a_spike.py`, 원자료 `docs/plan/spikes/mode-a/results-2026-11-05.json`.
- **결과**: opencode v2.2.5, `opencode-go/deepseek-v4.1-flash` 하나로 공통 시나리오 한 라운드, 이벤트, 중단·재개, 서버 재시작 후 세션 복구, 권한 승인·거부, 사용량 한도 조회를 **6개 항목 모두 3/3 성공**.
- **측정·한계**: 1차 7.1~9.0초, 재개 10.7~14.5초. Windows·Python 3.9 미확인, OpenCode form 실제 왕복 미시험, 세션 `cost=0`이라 비용 상한은 토큰·미터 기반이어야 함, SSE 재접속 미구현, 사용자 전역 세션 저장소·전역 MCP 유입 위험이 기록됐다.

### 2.8 방식 B — 진행 중

- **PR**: #10 SEL-19, **open** (`ai/SEL-19`). merge 전이다.
- **PR 내용**: Claude Code `claude -p`로 1라운드(status→결과 JSON→merge/render→ask-prep/ask), `POST /feedback`, 미처리 답 처리, 재개 3종(`--resume`·`--continue`·새 세션), 잠금, 권한 11/11, 원칙 0 관측을 확인했다고 보고한다. Claude 앱은 실행하지 않고 연결 방법만 조사했다.
- **아직 main에 없는 증거**: `docs/plan/spikes/mode-b-tui.md`, `docs/plan/spikes/mode-b/`의 시험 코드·로그는 PR #10에만 있다.
- **판정 이유**: PR이 open이고, "Claude Code로 공통 시나리오 + 재개, Claude 앱 연결 방법 조사"를 main 기준으로 확인할 수 없다. PR 내용상 대부분 수행됐지만 merge 전이므로 진행 중으로 둔다.

### 2.9 문서 — 미완

- **PR**: #3 SEL-17(`82c6de5`), #5 SEL-14(`2e03cfd`).
- **있는 것**: `docs/plan/baseline.md`, `docs/plan/glossary.md`, `docs/plan/schemas/project-v0.15.json`, `docs/plan/defects.md`, `docs/plan/decisions/README.md`.
- **origin/main 기준 빠진 것**: `git ls-tree -r origin/main docs/plan/decisions`에는 `README.md`만 있다. README의 색인도 비어 있다. 작업 트리에는 `0001-opencode-go-transfer.md`~`0011-linear-scope.md` 초안이 있으나 `git log origin/main`·PR 기준으로 아직 merge되지 않았다.
- **판정 이유**: "용어표·기준선·스키마 기술·결정 기록·결함 기록" 중 origin/main에 반영된 결정 기록이 형식만 있고 내용이 없어 게이트를 완전히 통과하지 못한다. 작업 트리 초안을 검토·커밋·merge하면 이 게이트는 닫힌다.

### 2.10 공개 점검 — 통과

- **PR**: #1 SEL-16(`e015ff4`).
- **증거**: `.gitignore` 비밀 파일 패턴 보강, `docs/archive/card-redesign/cards.patch`의 실제 프로젝트 경로·주제 정리. PR 제목·본문이 공개 저장소 점검을 명시한다.
- **확인 범위**: 이번 보고서 작성 중 실제 `~/pes-projects`·`~/.pes/`를 읽지 않았고, 새 문서에도 실제 자료·키·기관 자료를 넣지 않았다. 저장소 전체의 민감 자료 재스캔은 PR #1 이후 새 파일이 늘어난 만큼 별도 재점검이 필요하다.

### 2.11 승인 — 통과

- **증거**: `bfea07b` "docs: 1단계 설계서 4개 확정 (사용자 승인)" (2026-11-05 03:31:42 +0900).
- **의미**: 사용자가 1단계 설계서 4개를 확정하고 다음 단계 진행을 승인한 기록이 있다. 0단계 7절 사용자 결정은 `stage-0.md:85-99`에 있다.

## 3. PR·커밋 색인

| PR | 이슈 | 상태 | merge commit | 주요 증거 |
|---|---|---|---|---|
| #1 | SEL-16 | MERGED | `e015ff4` | `.gitignore`, 공개 자료 정리 |
| #2 | SEL-11 | MERGED | `f6e9c37` | `tests/`, `conftest.py`, 격리 fixture |
| #3 | SEL-17 | MERGED | `82c6de5` | `baseline.md`, `glossary.md`, `project-v0.15.json` |
| #4 | SEL-12 | MERGED | `cc6b664` | `test_state.py`, 복원 시험 |
| #5 | SEL-14 | MERGED | `2e03cfd` | `AGENTS.md`, `CLAUDE.md`, `defects.md`, `decisions/README.md` |
| #6 | SEL-15 | **OPEN** | — | CI run 41892497175: Windows 성공, macOS timeout |
| #7 | SEL-13 | MERGED | `0db5a54` | `test_serve.py`, `test_lock.py`, `test_questions.py` |
| #8 | SEL-31 | MERGED | `b588965` | 고위험 결함 수정·회귀 시험 |
| #9 | SEL-18 | MERGED | `dbbec18` | `spikes/mode-a-opencode.md`, A 시험 3/3 |
| #10 | SEL-19 | **OPEN** | — | B 시험 코드·`mode-b-tui.md`가 PR에만 있음 |

## 4. 테스트 실행 기록

- 명령: `python3 -m pytest -q`
- 환경: macOS 27.2(arm64), Python 3.15.2, 임시 venv(`requirements-dev.txt`의 pytest 8.3.5)
- 결과: **78 passed, 1 xfailed, 1 warning in 7.79s**
- 테스트 함수: 59개(파라미터 포함 79 실행). 파일별: `test_project_basic.py` 19, `test_state.py` 19, `test_serve.py` 11, `test_lock.py` 6, `test_questions.py` 4.
- 추가 확인: 복원 시험 1 passed, 고위험 결함 3 passed.
- CI: Windows 3.9·3.13 성공, macOS 3.9·3.13 실패(timeout). main CI 기록 없음.

## 5. 남은 일

1. **SEL-15 CI**: macOS job timeout 원인을 줄이거나 job timeout을 조정하고, PR #6을 다시 실행해 Windows·macOS를 모두 통과시킨 뒤 merge한다. merge 후 main에서도 CI를 확인한다.
2. **SEL-19 방식 B**: PR #10의 시험 코드·`docs/plan/spikes/mode-b-tui.md`를 검토·merge하고, Claude Code 공통 시나리오·재개·잠금·Claude 앱 연결 조사 결과를 main 기준으로 확인한다.
3. **결정 기록**: 작업 트리에 있는 `docs/plan/decisions/0001`~`0011` 초안을 검토해 origin/main에 커밋·merge하고, README 색인을 채운다. 최소한 테스트 격리·Python 버전·DB 위치처럼 이후 구현에 영향을 주는 결정부터 확정한다.
4. **공개 재점검**: PR #1 이후 추가된 계획·시험 문서에 실제 자료·키·기관 정보가 없는지 한 번 더 확인한다.

## 6. 결론

0단계의 핵심인 **테스트·격리·결함 수정·복원·AGENTS.md·방식 A·공개 점검·승인**은 증거와 함께 통과했다. 그러나 **CI(SEL-15)와 방식 B(SEL-19)가 아직 open**이고, **origin/main 기준 `docs/plan/decisions/`의 결정 기록이 비어 있어** 0단계를 "완료"로 닫을 수 없다. 1단계 설계가 먼저 진행된 상태이므로, 위 3개를 마친 뒤 0단계 게이트를 소급해 닫는 것이 좋다.
