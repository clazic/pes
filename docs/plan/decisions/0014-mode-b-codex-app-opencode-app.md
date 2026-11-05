# 0014. 방식 B에 Codex 앱과 OpenCode 앱을 추가한다

- 날짜: 2026-11-05
- 담당: 2단계 PR20c

## 문제

방식 B의 현재 2단계 어댑터는 PR20a(Claude Code·Claude 앱)와 PR20b(Codex CLI·OpenCode TUI)다. 사용자는 여기에 **Codex 앱**(OpenAI Codex 데스크톱 앱)과 **OpenCode 앱**(OpenCode 데스크톱 앱)도 포함하기를 원한다. 둘 다 사람이 직접 켜서 쓰는 화면이며 방식 B다.

## 선택지

1. 앱을 6단계나 이후로 미룬다.
2. **2단계 PR20c로 추가한다.** 20a의 공통 MCP bridge·계약과 20b의 codex·opencode-tui 어댑터 노트를 재사용한다.
3. 앱을 방식 A의 Go 호출 경로에 붙인다.

## 채택

**2번.** 2단계에 **PR20c(Codex 앱·OpenCode 앱)** 를 둔다.

- **미확인**: Codex 앱이 CLI와 같은 `~/.codex/config.toml` MCP 설정을 공유한다는 것은 2차 자료이며, OpenAI 공식 문서에는 CLI·IDE 공유만 명시돼 있다. OpenCode 앱의 MCP 설정 공유도 미확인이다. **PR20c 시험에서 실제로 확인한다.**
- 직접 연결이 안 되면 Claude 앱처럼 **명시적 전달(복사·붙여넣기)** 을 보장 경로로 둔다. 실제 제출자는 사람(`human`)이고, 도구·모델 주장은 미검증 출처로만 기록한다(`stage-1-api.md` 7절).
- **OpenCode 앱은 PES의 A 내장 실행기·Go 호출 경로를 건드리지 않는다.** 사용자 앱 세션과 A 실행을 분리한다.
- 어댑터 노트는 D4의 `codex-app`·`opencode-app`을 추가한다.

## 이유

- Codex 앱·OpenCode 앱은 사용자가 이미 쓰는 화면이고, CLI·TUI와 같은 PES API/MCP 계약을 쓸 수 있으면 추가 비용이 작다.
- 20a의 공통 bridge·20b의 노트를 재사용하므로 새 코어를 만들지 않는다.
- 직접 연결이 불확실하므로 명시적 전달을 항상 보장 경로로 두어 "연결됨"을 과장하지 않는다.

## 영향

- 2단계: PR20c 추가. 2단계 이슈 25개(0016 PR26 포함). PR21·U9·U10·WEB5·G3의 B 전체 선행에 20c를 더한다.
- `stage-1-runners.md` D4 노트, `stage-1-db.md`의 B runtime 목록, DDL runtime CHECK가 있으면 `codex_app`·`opencode_app`을 추가한다.
- 로드맵: 2~6단계 신규 70개, 전체 101개, Linear 260 한도에 159개 여유.
- 시험: 각 앱으로 합성 1라운드+재개, 중복 제출·같은 키 다른 요청·버전 오류, 직접 연결 불가 시 전달 경로, A 내장 실행기·OpenCode TUI와 비간섭.

## 재검토 조건

- Codex 앱·OpenCode 앱이 MCP 설정을 공유하지 않아 직접 연결이 불가능할 때(전달 경로만 유지).
- 앱의 인증·도구 호출 제한이 PES 계약을 지킬 수 없을 때.
- 앱 업데이트로 설정 경로·지원 환경이 바뀔 때.

## 상태

채택 (2026-11-05)
