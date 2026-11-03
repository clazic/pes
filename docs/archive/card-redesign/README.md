# PES 카드 디자인 개선 (미반영)

2026-11-02 Codex가 설계한 PES 화면 카드 디자인 개선안. Claude 검토가 로그인 문제로 실패해 PES에 반영되지 않았다.

- `codex-spec.md`: 합의한 설계 명세 (원래 /private/tmp 에 있던 것을 옮김)
- `preview.html`: 독립 시안 (수치는 예시)
- `cards.patch`: 당시 템플릿(ask.html, dashboard.html, hub.html)에 CSS만 추가하는 패치. 경로가 ~/work/pes 기준 절대경로이고, 그 뒤 템플릿이 10번 넘게 바뀌어 **그대로는 적용되지 않는다** → 현재 템플릿에 맞춰 다시 만들어야 한다.
- `build.py`: 패치·시안을 만든 스크립트
- `claude-request.md`: 당시 Claude에게 보낸 검토 요청 (조건: 한국어 정책 연구자, Windows 주 사용, 이모지 최소, 정렬된 표와 같은 크기 카드)
- `codex-session-2026-11-02.jsonl`: 설계 대화 기록 (Codex)
