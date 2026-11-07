# 결정 기록

설계·개발 결정을 한 건씩 남긴다. 논의안(`docs/plan/discussion/`)과 합의된 계획(`docs/plan/00-brief.md` → `stage-0.md` → `stage-1-{db,api,ui,runners}.md`, 이후 `stage-N*.md`)은 배경이고, 여기에는 **채택한 결정**만 적는다.

## 양식

파일 이름: `<번호>-<짧은-이름>.md` (예: `0001-test-isolation.md`). 아래 7항목을 모두 채운다.

```markdown
# <번호>. <결정 제목>

- 날짜: YYYY-MM-DD
- 담당: (이슈 번호 또는 이름)

## 문제
무엇을 정해야 하는가. 지금 무엇이 불편하거나 위험한가.

## 선택지
1. …
2. …

## 채택
고른 안.

## 이유
왜 이것인가. 비교 기준과 근거.

## 영향
바뀌는 코드·문서·테스트·운영. 뒤따르는 일.

## 재검토 조건
어떤 상황이 되면 다시 본다.

## 상태
제안 / 채택 / 폐기 (날짜)
```

## 색인

| 번호 | 결정 | 파일 | 상태 | 날짜 |
|---|---|---|---|---|
| 0001 | OpenCode Go에 비공개 연구 자료 전송 허용 | [0001-opencode-go-transfer.md](0001-opencode-go-transfer.md) | 채택 | 2026-11-04 |
| 0002 | 방식 A는 연구 6단계 전체를 DeepSeek 하나로 통일 | [0002-mode-a-deepseek.md](0002-mode-a-deepseek.md) | 채택 — **일부 대체(0013)** | 2026-11-04 |
| 0003 | 방식 B 보장 에이전트는 Claude Code와 Claude 앱 | [0003-mode-b-agents.md](0003-mode-b-agents.md) | 채택 | 2026-11-04 |
| 0004 | CI는 매 PR과 main에서 Windows·macOS로 돌린다 | [0004-ci-every-pr.md](0004-ci-every-pr.md) | 채택 | 2026-11-04 |
| 0005 | 5단계 웹 플랫폼은 후보 3군을 WEB0에서 비교 | [0005-web-platform.md](0005-web-platform.md) | 채택(후보 비교) | 2026-11-05 |
| 0007 | 결함은 SEL-12·13에서 재현하고 SEL-31에서 고친다 | [0007-defect-handling.md](0007-defect-handling.md) | 채택 | 2026-11-04 |
| 0008 | 저장소 공개 유지 | [0008-public-repository.md](0008-public-repository.md) | 채택 | 2026-11-05 |
| 0009 | 1단계 DB·API·화면·실행 구조 설계 승인 | [0009-stage-1-design-approval.md](0009-stage-1-design-approval.md) | 채택 | 2026-11-05 |
| 0010 | approver 역할은 6단계에서 결정 | [0010-approver-role-stage6.md](0010-approver-role-stage6.md) | 채택 | 2026-11-05 |
| 0011 | Linear 내보내기 범위는 1단계 UI 결정 11을 유지 | [0011-linear-scope.md](0011-linear-scope.md) | 채택 | 2026-11-05 |
| 0012 | 방식 B의 Codex CLI·OpenCode TUI 어댑터를 2단계로 앞당김 | [0012-mode-b-codex-opencode-tui-stage2.md](0012-mode-b-codex-opencode-tui-stage2.md) | 채택 | 2026-11-05 |
| 0013 | 방식 A는 PES가 Go API를 직접 호출, 모델은 사용자가 선택 | [0013-mode-a-go-subscription-and-model-choice.md](0013-mode-a-go-subscription-and-model-choice.md) | 채택 | 2026-11-05 |
| 0014 | 방식 B에 Codex 앱·OpenCode 앱 추가 | [0014-mode-b-codex-app-opencode-app.md](0014-mode-b-codex-app-opencode-app.md) | 채택 | 2026-11-05 |
| 0016 | PES 코어는 TypeScript 단일 언어 | [0016-core-language.md](0016-core-language.md) | 채택 — Node 26 확정 | 2026-11-05 |
| 0017 | 웹 대시보드 화면은 React + Vite + TypeScript + Tailwind CSS + shadcn/ui | [0017-dashboard-react-vite.md](0017-dashboard-react-vite.md) | 채택(사용자 결정) | 2026-11-05 |

**0006**은 `docs/plan/spikes/web0-plan.md`가 WEB0 코어 언어 결정 파일(`0006-web-core-language.md`)로 예약했으나, 8차 결정은 **0016-core-language.md**가 맡는다. 0006은 비워 둔다. **0005**는 `stage-5.md`가 가리키는 `0005-web-platform.md` 이름을 맞춘 것이다. 번호는 배정 순서이며 날짜 순서와 다를 수 있다.
