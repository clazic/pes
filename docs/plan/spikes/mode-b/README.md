# 방식 B 시험 (SEL-19) — 실행 방법

Claude Code 터미널 에이전트가 PES와 파일·CLI·HTTP로 왕복하고, 프로세스를 새로 띄워도
미처리 답부터 이어 가는지 확인하는 시험(spike)이다. 제품 코드(`scripts/`, `skills/`,
`templates/`, `commands/`)는 바꾸지 않는다.

## 무엇을 하나

`run_spike.py`가 저장소 **밖** 임시 디렉터리에 합성 PES 홈을 만들고 다음을 순서대로 한다.

1. `PES_HOME=<임시>/home python3 scripts/pes.py init <임시>/home/proj --topic "합성 주제"`
2. 같은 권한 설정으로 `probe_permissions.py`를 실행해 **권한 한정이 실제로 걸리는지** 확인
3. 빈 포트에 `PES_HOME=<임시>/home`, `HOME=<임시>/home`으로 `scripts/serve.py` 기동
4. Claude Code 비대화형 1라운드
   - 검증 래퍼 `pes lock` → `pes status` → `result-r1.json` 작성 → `merge` → `render`
   - `ask-prep` → `ask`로 질문 화면(`ask-plan-start.html`) 생성
5. 사람 답 흉내: `POST /<slug>/feedback` (Origin은 `http://127.0.0.1:<포트>`)
6. 재개 3종
   - `claude -p --resume <세션 ID>`: 미처리 답 읽고 `round-start` → `mark` → `render`
   - `claude -p --continue`: 같은 디렉터리의 최근 대화 이어서 처리
   - 새 세션(`--resume`/`--continue` 없음): PES의 `pending`만 보고 처리
7. 잠금
   - `PES_OWNER=agent-b`인 Claude 호출이 검증 래퍼 `lock`을 시도(exit 3이어야 함)
   - CLI로 `lock`·`merge`·`lock --force`·`unlock`의 종료 코드와 메시지 확인
8. 각 단계의 exit·응답·파일 내용·세션 관계·미처리→처리 전이를 검사한다. **하나라도 실패하면
   비영(1)으로 끝나고, 실패한 선행 단계 뒤의 유료 호출은 중단한다.**

## 권한 한정

- 작업 디렉터리는 `<임시>/home/proj` 하나다.
- Bash는 `<임시>/bin/pes:*` **검증 래퍼 하나만** 허용한다. `Bash(python3:*)`는 쓰지 않는다.
  래퍼는 허용된 PES 명령만 실행하고, `--force`와 시험 루트 밖 경로를 거부하며, 호출별
  exit/stdout/stderr/`project.json` 전후 해시를 기록한다.
- 파일 도구는 `Read(//<임시>/home/proj/**)`, `Write(//<임시>/home/proj/**)`,
  `Edit(//<임시>/home/proj/**)`만 허용한다.
- `project.json`과 `.pes-lock`의 직접 Write/Edit는 `--disallowedTools`로 거부한다.
- 저장소 `scripts/`는 `--add-dir`로 열지 않는다. 래퍼가 저장소의 `pes.py`를 실행한다.
- `--dangerously-skip-permissions`는 쓰지 않는다.
- `--restricted` 모드는 호출당 캐시 생성이 크게 늘어(이 환경에서 약 $2/호출) 쓰지 않았다.
  대신 경로 한정 `--allowedTools`/`--disallowedTools`로 같은 목적을 달성했다.
- `--permission-mode`와 설정 원천은 고정하지 않았다. 실행자 `~/.claude` 설정에 넓은 allow 규칙이나
  `defaultMode`가 있으면 한정이 약해질 수 있다. 이 경우 permission probe가 먼저 실패해 본 시험이
  중단되도록 했지만, 다른 환경에서의 재현성은 **미확인**이다.
- 루트 밖 `Read`/`Glob`/`Grep` 거부는 이번 탐침에 넣지 않았다(미시험). 확인한 것은 쓰기 거부와
  Bash 래퍼 한정이다.

## 실행

전제: `claude` CLI, Python 3.9 이상. 저장소 루트에서:

```sh
python3 docs/plan/spikes/mode-b/run_spike.py
```

- 임시 디렉터리는 끝나면 지운다. 남기려면 `--keep-temp`.
- 호출 제한 시간은 `--timeout`(초, 기본 420).
- 모델은 `claude-sonnet-5-5`, 턴 상한은 `--max-turns 30`.
- 권한 한정만 따로 보려면 `python3 docs/plan/spikes/mode-b/probe_permissions.py`.
- `--continue`의 대화 연속성만 따로 보려면 `python3 docs/plan/spikes/mode-b/probe_continue.py`.
- agent-b Claude 호출의 잠금 거부 동작만 따로 보려면
  `python3 docs/plan/spikes/mode-b/probe_lock_agent.py`.
- `PES_HOME`은 항상 임시 디렉터리다. 서버 `HOME`도 임시 홈으로 두어 실제 `~/pes-projects`,
  `~/.pes`를 쓰지 않도록 한다. 실제 `~/.pes` 읽기 여부는 별도 계측하지 않았다(미확인).
- `PES_OWNER`는 4~6번 호출이 `agent-a`, 잠금 시험이 `agent-b`다.

## 결과

- `logs/run.log`: 단계별 기록(로컬 경로는 `<임시>`, `<저장소>`, `<홈경로>`로 치환)
- `logs/claude-*.json`: Claude Code JSON 출력 요약(세션·턴·시간·비용·결과)
- `logs/pes-calls.log`: 래퍼가 기록한 PES CLI 호출(인자·exit·출력·전후 해시)
- `logs/permission-probe.json`: 권한 한정 시도와 거부 기록
- `logs/continue-probe.json`·`logs/continue-probe.log`: `--continue` 세션 연속성 탐침
- `logs/lock-agent-probe.json`·`logs/lock-agent-probe.log`: agent-b 잠금 호출의 실제 exit·출력·소유자·해시
- `logs/summary.json`: 검사 목록, 산출물, 잠금 CLI 결과, 최종 exit

`run_spike.py`는 시작할 때 **본 시험 로그만** 지우고 `continue-probe.*`·`lock-agent-probe.*`는
보존한다. 모든 원자료를 새로 만들려면 본 시험 뒤 `probe_continue.py`·`probe_lock_agent.py`를
다시 실행한다.

해석과 결론은 [`../mode-b-tui.md`](../mode-b-tui.md)에 적는다.

## 주의

- 합성 자료만 쓴다. 실제 기관 자료·키·토큰을 넣지 않는다.
- 로그를 저장소에 넣기 전에 `sanitize()`가 `<홈>/...` 같은 로컬 경로와 키 모양 문자열을
  자리표시로 바꾼다. 새 로그를 추가할 때도 같은 처리를 유지한다.
- 권한 한정은 Claude Code 도구 규칙 + 래퍼 검증이지 OS sandbox가 아니다.
