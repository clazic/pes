# CLAUDE.md

이 저장소에서 작업할 때는 [AGENTS.md](AGENTS.md)를 먼저 읽고 그 규칙을 따른다.

## 사용자와 일하는 방식 (사용자 지시 2026-11-08)

- **결정은 Claude가 한다.** 대부분의 결정은 Claude가 근거를 확인해 정하고, 사용자에게는 정한 방향을 짧게 알린다. 사용자에게 묻는 것은 꼭 필요한 것만이다.
  - 묻는 것: 되돌리기 어려운 일(공개 전환, 삭제, 이력 고쳐 쓰기), 돈이 드는 일(계정 만들기, 카드 등록, 결제, 실제 유료 API 호출), 사용자가 이미 정한 것을 뒤집는 일, 취향이 갈리는 일(화면 테마 같은 것).
  - 물을 때는 한 번에 하나씩, 추천안을 먼저 둔다.
- **설명 자료는 DeepSeek가 `/eli5` 스킬로 만든다.** 사용자에게 구조·흐름·결정을 설명할 때는 OpenCode DeepSeek에게 eli5 HTML(그림 위주, 글 적게, 한국어)을 만들게 하고 브라우저로 띄운 뒤, 터미널에는 짧은 요약만 쓴다.
  - 실행: **herdr로 옆 칸에 opencode를 띄워 맡긴다**(사용자 지시 2026-11-10 — `opencode run`·`oc-run.sh`·`codex exec`·`claude -p` 같은 일회성 실행은 토큰을 더 쓰므로 쓰지 않는다). 결과 HTML은 저장소 밖 임시 폴더에 둔다.
    1. `herdr pane split --current --direction right --cwd <임시 폴더> --no-focus` → 새 pane ID
    2. `herdr agent start eli5 --kind opencode --pane <pane ID> -- mini -m opencode/deepseek-v4.1-flash-free#high` (무료판 먼저. 사용량 제한이면 그 pane을 닫고 `opencode-go/deepseek-v4.1-flash#high`로 다시)
    3. `herdr agent prompt eli5 "/eli5 <주제와 내용>"` (opencode mini는 작업 중 상태를 herdr에 잘 알리지 않아 `--wait`가 `agent_prompt_stalled`로 끝날 수 있다 — 2026-11-10 시험) → 결과 HTML 파일이 생길 때까지 기다린 뒤 `herdr agent read eli5 --source recent-unwrapped`로 확인
    4. 끝나면 띄운 pane을 닫는다.
  - 다른 모델(Codex 검수, DeepSeek 코딩 등)에게 일을 맡길 때도 같은 방식(herdr pane + `herdr agent start/prompt`)으로 한다. hc-team은 `hc run`(herdr)으로 이미 그렇게 한다.
  - 무료 모델에는 실제 연구 자료를 보내지 않는다. 설계·구조 설명만 보낸다.
- 답은 늘 한국어로 한다.
