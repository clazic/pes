# 방식 B 시험 (SEL-19) — 실행 방법

Claude Code 터미널 에이전트가 PES와 파일·CLI·HTTP로 왕복하고, 프로세스를 새로 띄워도
미처리 답부터 이어 가는지 확인하는 시험(spike)이다. 제품 코드(`scripts/`, `skills/`,
`templates/`, `commands/`)는 바꾸지 않는다.

## 무엇을 하나

`run_spike.py`가 저장소 **밖** 임시 디렉터리에 합성 PES 홈을 만들고 다음을 순서대로 한다.

1. `PES_HOME=<임시>/home python3 scripts/pes.py init <임시>/home/proj --topic "합성 주제"`
2. 빈 포트에 `PES_HOME=<임시>/home python3 scripts/serve.py <임시>/home <포트>`
3. Claude Code 비대화형 1라운드
   - `pes.py status`로 맥락 읽기 → `result-r1.json` 작성 → `merge` → `render`
   - `ask-prep` → `ask`로 질문 화면(`ask-plan-start.html`) 생성
4. 사람 답 흉내: `POST /<slug>/feedback` (Origin은 `http://127.0.0.1:<포트>`)
5. 재개 3종
   - `claude -p --resume <세션 ID>`: 미처리 답 읽고 `round-start` → `mark` → `render`
   - `claude -p --continue`: 같은 디렉터리의 최근 대화 이어서 처리
   - 새 세션(`--resume`/`--continue` 없음): PES의 `pending`만 보고 처리
6. 잠금
   - `PES_OWNER=agent-b`인 Claude 호출이 `lock`을 시도(실패해야 함)
   - CLI로 `lock`·`merge`·`lock --force`·`unlock`의 종료 코드와 메시지 확인
7. `project.json` 해시 전후 비교 + `pes.py` 호출 로그로 **에이전트가 상태를 직접 고쳤는지** 판단

## 실행

전제: `claude` CLI, Python 3.9 이상. 저장소 루트에서:

```sh
python3 docs/plan/spikes/mode-b/run_spike.py
```

- 임시 디렉터리는 끝나면 지운다. 남기려면 `--keep-temp`.
- 호출 제한 시간은 `--timeout`(초, 기본 420).
- 모델은 `claude-sonnet-5-5`, 턴 상한은 `--max-turns 30`.
- `--continue`의 대화 연속성만 따로 보려면 `python3 docs/plan/spikes/mode-b/probe_continue.py`.
- agent-b Claude 호출의 잠금 거부 동작만 따로 보려면
  `python3 docs/plan/spikes/mode-b/probe_lock_agent.py`.
- 권한은 `Bash(python3:*)`, `Read`, `Write`, `Edit`만 허용하고 `--add-dir`는 임시 프로젝트와
  저장소 `scripts/`로 한정한다. `--dangerously-skip-permissions`는 쓰지 않는다.
- `PES_HOME`은 항상 임시 디렉터리다. 실제 `~/pes-projects`, `~/.pes`는 읽거나 쓰지 않는다.
- `PES_OWNER`는 1~4번 호출이 `agent-a`, 잠금 시험이 `agent-b`다.

## 결과

- `logs/run.log`: 단계별 기록(로컬 경로는 `<임시>`, `<저장소>`, `<홈경로>`로 치환)
- `logs/claude-*.json`: Claude Code JSON 출력 요약(세션·턴·시간·비용·결과)
- `logs/pes-calls.log`: 에이전트가 부른 PES CLI 인자 기록
- `logs/summary.json`: 잠금 CLI 결과·산출물 점검

해석과 결론은 [`../mode-b-tui.md`](../mode-b-tui.md)에 적는다.

## 주의

- 합성 자료만 쓴다. 실제 기관 자료·키·토큰을 넣지 않는다.
- 로그를 저장소에 넣기 전에 `sanitize()`가 `<홈>/...` 같은 로컬 경로와 키 모양 문자열을
  자리표시로 바꾼다. 새 로그를 추가할 때도 같은 처리를 유지한다.
