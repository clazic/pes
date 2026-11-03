# 방식 A 시험 코드 — opencode serve HTTP API

SEL-18 시험 코드다. PES 제품 코드(`scripts/`, `skills/`, `templates/`)는 건드리지 않는다.
결과 기록은 [`../mode-a-opencode.md`](../mode-a-opencode.md), 실행 결과 요약은 이 문서 아래쪽에 있다.

## 무엇을 하나

임시 폴더(저장소 밖)에 합성 PES 프로젝트를 만들고, **개인** `opencode serve` 를 띄워
HTTP API 로 아래를 3회 반복한다.

1. 서버 정보(`/api/info`)·모델 목록(`/api/model`)에서 `opencode-go/deepseek-v4.1-flash` 확인
2. 세션 생성 → 공통 시나리오 한 라운드
   - 에이전트가 `pes.py status` 로 맥락 읽기
   - 에이전트가 `result.json` 작성
   - PES 가 `merge` / `render`
   - PES 가 `ask-prep` / `ask` 로 질문 화면 생성
   - `scripts/serve.py` 를 빈 포트에 띄우고 `POST /feedback` 으로 사람 답 흉내
   - `pes.py pending` → `pes.py mark` → 같은 세션에 다시 프롬프트(재개)
3. `/api/event` SSE 로 진행 상황 받기(첫 이벤트·실행 시작·종료·이벤트 종류)
4. `POST /api/session/{id}/interrupt` → 같은 세션 이어 쓰기 → 개인 서버 재시작 → 세션 복구 확인
5. 권한 요청(`shell`·`edit`)을 API 로 승인(`once`)·거부(`reject`)하고 결과 확인
6. `/api/experimental/usage/limits` 값 확인

## 안전 규칙(코드가 지킨다)

- `PES_HOME` 은 항상 임시 폴더다. `~/pes-projects`, `~/.pes` 를 읽거나 쓰지 않는다.
- 합성 자료만 보낸다. 실제 연구 자료를 넣지 않는다.
- `opencode serve` 는 **개인 서버**만 띄운다.
  - `--hostname 127.0.0.1 --port <빈 포트>` 만 쓴다.
  - `opencode service ...` / `--service` 는 절대 쓰지 않는다. 다른 작업자가 쓰는 백그라운드 서비스는 건드리지 않는다.
- 모델은 `opencode-go/deepseek-v4.1-flash` 하나만 쓴다.
- 시험용 설정(`opencode.json` 의 `permissions`)은 임시 프로젝트 폴더 안에만 둔다.
  사용자의 `~/.config/opencode/` 는 바꾸지 않는다.
- 시험에서 만든 세션 ID 만 `DELETE /api/session/{id}` 로 지운다. 다른 세션은 건드리지 않는다.
- 서버 비밀번호·토큰을 화면이나 저장소에 남기지 않는다. 서버 로그는 임시 폴더 안에만 두고,
  기본 실행은 끝나면 임시 폴더를 지운다.

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
# 임시 폴더와 로그를 남긴다 (디버깅용, 비밀번호가 로그에 있으니 공유 금지)
python3 docs/plan/spikes/mode-a/mode_a_spike.py --repeats 1 --keep

# opencode 실행 파일을 직접 지정
python3 docs/plan/spikes/mode-a/mode_a_spike.py --opencode /opt/homebrew/bin/opencode

# 결과 JSON 을 원하는 곳에 저장
python3 docs/plan/spikes/mode-a/mode_a_spike.py --out /tmp/sel18-result.json
```

종료하면 표준출력에 항목별 성공 횟수·지연이 나오고, 결과 JSON 은 임시 폴더에 저장된다.
기본 실행은 임시 폴더와 함께 그 JSON도 지운다. 보관하려면 `--out` 으로 저장소 밖 경로를 지정한다.

## 읽는 법

- `server_start`: 서버 기동~`/api/info` 200 까지
- `info_model`: `/api/info` + `/api/model` 왕복, 대상 모델 발견 여부
- `scenario.agent.prompt_ms`: 프롬프트 POST~idle 까지 (권한 승인 대기 포함)
- `scenario.round_ms`: PES 쪽 `round-start`·`merge`·`render`·`ask-prep`·`ask`·`feedback` 합
- `event_stream`: SSE 이벤트 수·종류, 실행 구간(시작~종료)
- `interrupt_resume`: interrupt 응답·idle outcome·같은 세션 재개·서버 재시작 후 복구
- `permission_deny`: 거부 응답 수, `keep.txt` 보존 여부(거부가 실제로 막았는지)
- `usage`: Go 사용량 미터(rolling/weekly/monthly %)와 예산 목록 존재 여부

## 한계

- 시험은 macOS 한 환경에서만 돌았다. Windows 서비스 분리·종료는 확인하지 않았다.
- `opencode serve` 는 HTTP Basic(`opencode:<server password>`) 인증을 요구하고, 비밀번호를 기동 로그에 한 번 출력한다.
  실제 PES 어댑터는 이 값을 비밀 저장소에 넣고 로그에 남기지 않아야 한다.
- 세션은 서버 로컬이 아니라 전역 저장소에 남는다. 시험은 만든 세션만 지웠고, 지운 뒤 목록에서 사라지는 것을 확인했다.
- OpenCode `form` API 는 스키마만 확인했고 실제 폼 왕복은 시험하지 않았다. 이 시험의 사람 질문은 PES `ask`/`/feedback` 이 원본이다.
- `--keep` 으로 남긴 로그에는 서버 비밀번호가 있다. 공유하거나 커밋하지 않는다.
