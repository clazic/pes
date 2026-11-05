# 0012. 방식 B의 Codex CLI·OpenCode TUI 어댑터를 2단계로 앞당긴다

- 날짜: 2026-11-05
- 담당: 2단계 PR20b

## 문제

방식 B의 보장 에이전트는 Claude Code와 Claude 앱이다. Codex CLI와 OpenCode TUI(사람이 직접 켜서 쓰는 화면판)는 0단계 7-3에서 1단계 어댑터 설계로 넘겼지만, 1단계 runners D4의 어댑터 노트(a-builtin·claude-code·claude-app)에는 들어가지 않았고 6단계 G1·G2로 밀려 있었다. 6단계에서 처음 붙이면 2~4단계에서 만든 Python 코어·API·스킬 계약을 다시 손봐야 할 수 있다.

## 선택지

1. 6단계 G1·G2에서 Codex CLI·OpenCode TUI를 붙인다.
2. **2단계 PR20b에서 붙인다.** Claude Code·Claude 앱은 PR20a로 유지하고, 20b는 20a의 공통 MCP bridge·계약을 쓴다.
3. 2단계 PR20 하나에 Claude Code·Claude 앱·Codex CLI·OpenCode TUI를 모두 넣는다.

## 채택

**2번.** 2단계 PR20을 20a(Claude Code·Claude 앱)와 20b(Codex CLI·OpenCode TUI)로 나눈다. 20b는 각 에이전트로 합성 1라운드+재개를 통과하고, D4 어댑터 노트에 `codex`·`opencode-tui`를 추가한다. 6단계 G1·G2는 제거하고 G3를 2단계 어댑터 회귀·추가 에이전트 후보 계약으로 정리한다.

## 이유

- 같은 PES API/MCP·같은 자격 체계·같은 오류 의미를 2단계에서 바로 시험하면, 3~4단계가 어댑터별 분기 없이 같은 계약을 쓸 수 있다.
- Claude Code·Claude 앱 보장은 그대로 두고, Codex·OpenCode TUI는 별도 PR로 독립 검증한다. 20a가 공통 MCP bridge·계약을 먼저 만들고 20b가 이를 쓴다.
- OpenCode TUI는 사람이 직접 켜는 화면판이며, PES가 Go API를 직접 호출하는 방식 A와 다르다. 둘을 같은 이름으로 섞지 않는다.
- 6단계에서 처음 붙이면 코어·스킬·API 계약을 늦게 고쳐야 하므로, 작은 2단계 시험으로 재작업을 줄인다.

## 영향

- 2단계: PR20 → PR20a·20b. 2단계 이슈 25개. PR21 교차 계약은 20a·20b를 모두 선행으로 둔다. **0014에서 PR20c를 더해 24개, 0016에서 PR26(TS 이전)을 더해 25개가 됐다.**
- 6단계: G1·G2 제거, 6단계 신규 9개. G3는 2단계 PR20b 어댑터 회귀와 Gemini 등 추가 에이전트 후보·계약 시험을 맡는다.
- 로드맵: 2~6단계 신규 65개, 전체 96개, Linear 260 한도에 164개 여유. 단계 문서는 누적 수를 `roadmap.md` 2절로 통일한다.
- 어댑터 노트: D4의 `a-builtin`(A)·`claude-code`·`claude-app`에 `codex`·`opencode-tui`를 더한다.
- 시험: Codex CLI와 OpenCode TUI 각각 합성 1라운드+재개, 중복 제출·같은 키 다른 요청·버전 오류, A 내장 실행기 비간섭, Go 경로 차단/한계 표기.

## 재검토 조건

- Codex CLI·OpenCode TUI가 같은 API/MCP 계약을 지키지 못하거나, Go 목적지 경로를 통합 경로에서 막을 수 없어 "보장"으로 표기할 수 없을 때.
- 20b가 한 PR로 독립 검증하기 어려울 만큼 커질 때(그때도 표·테스트별로 쪼개지 않고 독립 배포 단위로만 나눈다).
- 6단계에서 Gemini 등 추가 에이전트 수요가 확인될 때(별도 이슈로 판단).

## 상태

채택 (2026-11-05)
