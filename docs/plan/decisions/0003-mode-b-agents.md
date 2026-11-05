# 0003. 방식 B 보장 에이전트는 Claude Code와 Claude 앱

- 날짜: 2026-11-04
- 담당: SEL-24(실행 구조), SEL-19(방식 B 시험)

## 문제

방식 B(브라우저 밖 에이전트)의 보장 대상을 정해야 한다. 보장 대상이 많을수록 사용자는 편하지만, 연결 방법·인증·시험 범위가 늘고 "연결됨"을 과장할 위험이 커진다.

## 선택지

1. Claude Code만 보장한다.
2. Claude Code와 Claude 앱을 보장한다.
3. Codex·OpenCode TUI까지 모두 보장한다.

## 채택

2번. **Claude Code와 Claude 앱**을 보장한다. 0단계 시험은 Claude Code로 하고, Claude 앱은 연결 방법을 조사한다. Codex·OpenCode TUI는 1단계 어댑터 설계 때 다룬다.

## 이유

- Claude Code는 터미널에서 바로 쓰고, Claude 앱은 사용자가 이미 쓰는 경로다.
- 앱의 직접 연결이 불확실하므로 "연결됨"을 과장하지 않고, 명시적 전달을 보장 경로로 둔다(`stage-1-api.md` 7절).
- 보장 대상을 좁혀 0단계에서 실제로 시험할 수 있게 한다.

## 영향

- SEL-19, `stage-1-api.md` 7절, `stage-1-runners.md`, 2단계 PR 20, 5단계 WEB5.
- **0014**: Codex 앱·OpenCode 앱을 2단계 PR20c로 추가한다. 보장 에이전트(Claude Code·Claude 앱)는 그대로다.
- **B의 흐름(2026-11-05 사용자 정의)**: 사람 컴퓨터의 skill/plugin으로 프로젝트를 만들어 PES에 등록하고, 이후 사람은 웹 대시보드에서 작업한다. 실제 모델은 사람 컴퓨터에서 돌고, **PC 도우미↔웹은 WebSocket/HTTP, AI 도구↔PES는 MCP/API, 브라우저 탭 안 보조만 WebMCP**로 연결한다. WebMCP는 PC↔웹 통로가 아니다.
- 앱 연결이 안 되면 복사·붙여넣기 전달을 보장 경로로 두고, 사람이 붙여 넣은 제출의 실제 제출자는 사람으로 기록한다.
- 앱·CLI가 같은 PES API 명령을 쓴다.

## 재검토 조건

- Claude 앱 직접 연결이 실제로 동작하지 않을 때.
- Codex·OpenCode TUI를 보장 대상으로 올려야 할 사용자 요구가 생길 때.
- 5단계 원격 MCP의 지원 환경이 달라질 때.

## 상태

**채택** (2026-11-04)
