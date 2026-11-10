---
description: PES 설치·점검 — Git·Python·Node.js, kosis·vworld·korean-law(CLI·스킬·MCP)·ego lite 를 확인해 없으면 설치하고, API 키를 웹 화면으로 받아 등록한 뒤 /pes:doctor 로 마무리 (Windows·macOS)
argument-hint: "[keys]  (keys: API 키 화면만 다시 열기)"
---

PES 설치 도우미. 인자: $ARGUMENTS
`PLUG` = 이 플러그인 폴더(`${CLAUDE_PLUGIN_ROOT}`). 사용자는 자동 설치를 원한다 — 단계마다 다시 묻지 말고, 무엇을 하는지 한 줄씩만 알리며 진행한다. **API 키 값은 채팅으로 받지 않는다** (키 화면에서만).

인자가 `keys`면 4번만 하고 5·6번으로.

1. **기본 도구 (bootstrap)** — Python이 없어도 돌도록 OS 셸 스크립트로:
   - Windows: `powershell -NoProfile -ExecutionPolicy Bypass -File "PLUG/scripts/bootstrap.ps1"` (PowerShell 도구가 있으면 그것으로)
   - macOS·Linux: `sh "PLUG/scripts/bootstrap.sh"`
   - 줄 형식 `OK|INSTALLED|FAIL|MISSING <이름> …`, 마지막 줄 `PYTHON <명령>` → 이후 `PY`로 쓴다 (`py -3`, `python3` 등).
   - FAIL이 있으면 그 줄의 안내를 그대로 전하고 멈춘다 (예: macOS Command Line Tools 설치 창, winget 없음).
   - Windows에서 git을 **이번에 새로 설치했다면**: Git Bash가 있어야 답 자동 수신(`watch`)이 되므로 "에이전트 앱을 완전히 끄고 다시 연 뒤 `/pes:setup`을 다시 실행해 주세요"라고 알리고 멈춘다 (환경별 재시작 방법은 `docs/adapters/`의 어댑터 노트).
2. **상태 확인**: `PY -I PLUG/scripts/setup.py check` → 채팅에는 [없음]·[직접]·[키 필요]만 한 줄씩.
3. **설치**: `PY -I PLUG/scripts/setup.py install missing` (kosis·vworld = 공식 설치 스크립트로 CLI+스킬, korean-law = npm, MCP 등록은 그 환경의 CLI가 있을 때만).
   - 출력 `USER ego-browser …`: ego lite는 앱 설치와 첫 실행 안내(온보딩)를 사용자가 직접 해야 한다. 안내 문장을 그대로 전하고, 끝났다고 하면 `PY -I PLUG/scripts/pes.py which ego-browser`로 확인. 사용자가 나중에 하겠다면 넘어간다(조사는 WebSearch로 대체 가능하다고 한 줄).
   - FAIL은 마지막 줄 원인과 함께 표로 정리하고 다음으로 진행한다.
3-1. **업그레이드**: `PY -I PLUG/scripts/setup.py upgrade all` — 이미 설치된 kosis·vworld(CLI+스킬), korean-law(CLI·MCP 공용), ego lite 를 최신으로. 줄마다 `UPGRADED|OK|FAIL`; UPGRADED·FAIL만 채팅에 한 줄씩. ego lite 업그레이드가 진행 중인 브라우저 작업 때문에 막히면(확인 대화상자) 그대로 알리고 넘어간다. 사용자가 '업그레이드는 하지 마'라고 했으면 건너뛴다.
4. **API 키**: `PY -I PLUG/scripts/setup.py keys` → 첫 줄 주소가 브라우저로 열린다. 둘째 줄 `WATCH …` 명령으로 답 대기를 건다(30분쯤 뒤 만료되면 다시). 채팅엔 한 줄: "브라우저에 API 키 화면을 열었습니다. 발급 방법이 함께 있으니 필요한 키만 넣고 '마치기'를 눌러 주세요." 키가 모두 있으면 이 단계는 "키가 모두 등록되어 있습니다(추가하려면 `/pes:setup keys`)"로 건너뛴다.
   - `SETUP keys …` 줄이 오면 결과(ok/fail)를 읽는다. fail은 doctor 결과와 함께 알린다.
5. **진단**: `PY -I PLUG/scripts/pes.py doctor --net` → 요약 한 줄 + [문제]·[주의] 표.
6. **완료 표시**: `PY -I PLUG/scripts/setup.py mark`. 마지막 안내:
   - 키나 PATH를 이번에 바꿨으면 "에이전트 앱(또는 터미널 세션)을 한 번 다시 시작하면 모든 세션에 적용됩니다."
   - 다음: `/pes:start <주제>` 또는 `/pes:run`.
