# 방식 A 시험 코드 — opencode serve HTTP API

SEL-18 시험 코드다. PES 제품 코드(`scripts/`, `skills/`, `templates/`)는 건드리지 않는다.
결과 기록은 [`../mode-a-opencode.md`](../mode-a-opencode.md), 원시 결과(경로·비밀번호 제거)는
[`results-2026-11-05.json`](results-2026-11-05.json) 이다.

## 무엇을 하나

임시 폴더(저장소 밖)에 합성 PES 프로젝트를 만들고, **개인** `opencode serve` 를 띄워
HTTP API 로 아래를 3회 반복한다.

1. 서버 정보(`/api/info`)·모델 목록(`/api/model`)에서 `opencode-go/deepseek-v4.1-flash` 확인
2. 세션 생성 → 공통 시나리오 한 라운드
   - 에이전트가 `pes.py status` 로 맥락 읽기, `result.json` 작성
   - PES 가 `merge` / `render`
   - PES 가 `ask-prep` / `ask` 로 질문 화면 생성
   - `scripts/serve.py` 를 빈 포트에 띄우고 `POST /feedback` 으로 사람 답 흉내
   - `pes.py pending` → `pes.py mark`
   - **개인 서버를 끄고 다시 띄운 뒤 같은 시나리오 세션을 복구**하고,
     이전 `result.json` 요약과 사람 답 파일 내용에 의존하는 `plan-result.md` 를 작성
3. `/api/event` SSE 로 진행 상황 받기(첫 이벤트·실행 시작·종료·이벤트 종류)
4. 중단: `sleep 45` 셸이 **실제로 running 인 것을 `/api/shell` 로 확인**한 뒤
   `POST /api/session/{id}/interrupt` → 응답 `interrupted: true` → idle `interrupted` →
   같은 세션 재개 → 개인 서버 재시작 후 세션 복구
5. 권한:
   - 승인: 세션의 `shell`·`edit` 요청을 `once` 로 승인하고, 실제 `shell`/`write` 도구가
     완료됐는지 메시지의 tool 상태로 확인
   - 거부: `keep.txt` 삭제(`rm`) 요청만 `reject` 하고, 다른 읽기 명령은 허용해
     에이전트가 실제 삭제 요청까지 도달하는지 확인. `keep.txt` 보존도 확인
6. `/api/experimental/usage/limits` 를 세 번 조회해 세 값과 Go 미터 필드가 모두 유효한지 확인

## 안전 규칙(코드가 지킨다)

- `PES_HOME` 은 항상 임시 폴더다. `~/pes-projects`, `~/.pes` 를 읽거나 쓰지 않는다.
  - `pes.py`·`serve.py` 는 `PES_HOME` 과 `HOME` 을 임시 폴더로 두어 사용자 설정을 읽지 않는다.
  - opencode 서버 프로세스 환경에도 `PES_HOME` 을 넣고 상속된 `PES_PROJECT` 를 지운다.
  - 세션 environment API 로 `PES_HOME` 을 한 번 더 넣고, 도구가 쓴 `env-home.txt`·
    `env-project.txt` 내용을 PES 가 직접 확인한다(프롬프트 문자열에만 의존하지 않는다).
- 합성 자료만 보낸다. 실제 연구 자료를 넣지 않는다.
- `opencode serve` 는 **개인 서버**만 띄운다.
  - `--hostname 127.0.0.1 --port <빈 포트>` 만 쓴다.
  - `opencode service ...` / `--service` 는 절대 쓰지 않는다. 다른 작업자가 쓰는 백그라운드 서비스는 건드리지 않는다.
- 모델은 `opencode-go/deepseek-v4.1-flash` 하나만 쓴다.
- 시험용 설정(`opencode.json` 의 `permissions`)은 임시 프로젝트 폴더 안에만 둔다.
  사용자의 `~/.config/opencode/` 는 바꾸지 않는다.
- 시험에서 만든 세션은 **만든 직후** 소유 목록에 넣고, 서버가 살아 있는 `finally` 에서 ID 로만 지운다.
  다른 세션은 건드리지 않는다. 서버 장애로 못 지우면 남은 ID 와 실패를 결과에 보존하고
  임시 폴더를 지우지 않는다.
- 서버 비밀번호·토큰을 화면이나 저장소에 남기지 않는다.
  - 서버 로그는 임시 폴더 안에만 두고, 종료할 때 로그의 비밀번호 줄을 마스킹한다.
  - 예외 문자열·traceback·결과 JSON 도 비밀번호와 로컬 경로를 지운 뒤 저장한다.
- SSE 연결은 `stop()` 에서 응답을 닫고 스레드 `join()` 을 기다린다.
  (`Thread._stop` 이름 충돌을 피해 `_stop_event` 를 쓴다. Python 3.9 에서도 `join()` 이 안전하다.)

## 준비

- Python 3.9 이상 (표준 라이브러리만 사용)
- `opencode` v2.2.5 이상이 PATH 에 있고, `opencode-go` 로그인이 되어 있을 것
- macOS/Linux 기준. Windows 는 경로·프로세스 종료 부분을 따로 확인해야 한다(이번 시험은 macOS).

## 실행

저장소 루트에서:

```bash
python3 docs/plan/spikes/mode-a/mode_a_spike.py --repeats 3
```

자주 쓰는 옵션:

```bash
# 임시 폴더와 로그를 남긴다 (디버깅용, 로그는 마스킹되지만 공유 금지)
python3 docs/plan/spikes/mode-a/mode_a_spike.py --repeats 1 --keep

# opencode 실행 파일을 직접 지정
python3 docs/plan/spikes/mode-a/mode_a_spike.py --opencode /opt/homebrew/bin/opencode

# 결과 JSON 을 원하는 곳에 저장 (저장 전에 비밀번호·로컬 경로를 지운다)
python3 docs/plan/spikes/mode-a/mode_a_spike.py --out /tmp/sel18-result.json
```

- `--repeats` 는 1 이상이어야 한다. 0·음수는 사용법 오류로 종료한다.
- 종료 코드: 필수 항목 실패·미실행·정리 실패·결과 저장 실패가 있으면 1, 모두 통과하면 0.
- 성공 실행은 임시 폴더를 지운다. 실패·정리 미완이면 남은 세션 ID 보존을 위해 임시 폴더를 남긴다.
- 결과 JSON 은 임시 폴더의 `result.json` 에 쓰인다. 보관하려면 `--out` 으로 저장소 밖 경로를 지정한다.

## 읽는 법

- `server_start`: 서버 기동~`/api/info` 200 까지
- `info_model`: `/api/info` + `/api/model` 왕복, 대상 모델 발견 여부
- `scenario.agent.prompt_ms`: 1차 프롬프트 POST~idle (권한 승인 대기 포함)
- `scenario.round_ms`: PES 쪽 `round-start`·`merge`·`render`·`ask-prep`·`ask`·`feedback` 합
- `scenario.restart_ms` / `recovered` / `resume_ms` / `resume_ok`: 답 처리 뒤 서버 재시작·세션 복구·맥락 의존 재개
- `env_check.home_ok` / `project_removed`: 도구 안에서 본 `PES_HOME`·`PES_PROJECT`
- `event_stream`: SSE 이벤트 수·종류, 실행 구간(시작~종료), `terminal_seen`
- `interrupt_resume.sleep_seen` / `sleep_gone` / `interrupted` / `idle_outcome` / `resume_ok` / `recovered`
- `permission.approval`: `once_shell`·`once_edit`·`shell_executed`·`edit_executed`
- `permission.deny`: `rm -f keep.txt` 거부 응답, `keep_intact`, `reject_target`
- `usage`: 세 번의 Go 사용량 미터(rolling/weekly/monthly %)와 필드 유효성

## 한계

- 시험은 macOS 한 환경에서만 돌았다. Windows 서비스 분리·종료는 확인하지 않았다.
- `opencode serve` 는 HTTP Basic(`opencode:<server password>`) 인증을 요구하고, 비밀번호를 기동 로그에 한 번 출력한다.
  시험 코드는 로그·예외·결과에서 마스킹하지만, 실제 PES 어댑터는 비밀 저장소를 써야 한다.
- 세션은 서버 로컬이 아니라 전역 저장소에 남는다. 시험은 만든 세션만 지웠고, 지운 뒤 목록에서 사라지는 것을 확인했다.
- OpenCode `form` API 는 스키마만 확인했고 실제 폼 왕복은 시험하지 않았다.
  이 시험의 사람 질문은 PES `ask`/`/feedback` 이 원본이다.
- `--keep` 으로 남긴 로그에는 다른 민감 정보가 있을 수 있다. 공유하거나 커밋하지 않는다.
