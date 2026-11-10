# 어댑터 노트 — Claude Code

스킬(`skills/`)·서브에이전트 지침(`agents/`)·명령(`commands/`)은 환경에 매이지 않게 쓴다. 이 노트는 그 중립 표기를 **Claude Code**에서 어떻게 실행하는지 적는다. Claude 전용 이름(도구·스킬·모델)은 이 폴더(`docs/adapters/`)에만 둔다 — `npm run lint:skills`가 다른 곳에 있으면 막는다.

## 중립 표기와 Claude Code 대응

| 문서의 중립 표기 | Claude Code에서 |
|---|---|
| "사람에게 고르게 한다" (서버를 띄울 수 없을 때, 프로젝트 고르기) | `AskUserQuestion` 도구. 프로젝트 고르기 선택지: 「내 차례」 → 최근 순, 라벨=주제, 설명=단계·할 일. 4개를 넘으면 상위 3개 + '목록 화면 열기'(`hub` 후 `open`) |
| 서브에이전트를 띄운다 | `Agent` 도구(옛 이름 `Task`). 한 메시지에 여러 개를 함께 보내면 병렬로 돈다 |
| reviewer 역할 (독립 검토) | `pes:reviewer` 서브에이전트(`agents/reviewer.md`), 모델은 `opus`, 1개. 프롬프트에는 "지시문 파일을 읽고 따르라"만 넘긴다 |
| researcher·writer·verifier 역할 | `pes:researcher`·`pes:writer`·`pes:verifier` 서브에이전트(각 `agents/*.md`). 조사는 항목당 1개, 한 번에 최대 5개 |
| 가벼운 모델 / 강한 모델 (조사 모델 `mixed`) | 가벼운 쪽 `sonnet`, 강한 쪽 `opus`. 서브에이전트를 띄울 때 `model` 인자로 정한다 |
| 형식 변환 도구 (hwpx·docx·pdf·slides) | `anthropic-skills:hwpx-uri`(HWPX, 울산연구원 양식 점검 포함)·`anthropic-skills:docx`·`anthropic-skills:pdf`·`anthropic-skills:pptx` 스킬 |
| 답 대기 (`watch`) | `Monitor` 도구에 `$PES watch <dir>`가 출력하는 명령을 `timeout_ms` 1800000으로 건다. 만료되면 다시 건다 |
| 환경변수 (`LAW_OC`·`NODE_EXTRA_CA_CERTS`) | `~/.claude/settings.json`의 `env`. 사용자가 줄 때만 넣고 값을 채팅에 다시 쓰지 않는다 |
| 플러그인 경로 | `${CLAUDE_PLUGIN_ROOT}`. 비어 있으면 스킬의 Base directory 기준 `../../scripts/pes.py` |
| 세션 표시 (`PES_OWNER`) | 세션 처음에 ID를 정해(모르면 `uuidgen`) 모든 pes 호출에 붙인다 |
| 다른 프로젝트 열기 | 다른 터미널 탭의 Claude Code 세션에서 `/pes:run <폴더>` |
| eli5 보고서 | `eli5:eli5` 스킬의 원칙 |
| 공유 | artifacts로 게시해 링크를 준다 |
| 재시작 안내 (설치 뒤) | "Claude Desktop(또는 Claude Code)을 한 번 다시 시작하면 모든 세션에 적용됩니다" |

## 서브에이전트가 지키는 것

서브에이전트는 `Write`로 쓴 제안 파일(`rounds/<단계>-R<n>/<id>.json` 등)에만 결과를 남긴다. 업무 상태(프로젝트 상태 파일·업무 DB·잠금 파일)를 직접 고치지 않는다 — 메인이 `merge`·`qa` 같은 pes 명령으로 넘기고, 토큰을 받은 작업자는 `claim` → `submit`으로 낸다. reviewer는 메인의 결론을 모른 채 따로 판단한다(독립 검토는 모든 단계·모든 라운드, 생략하지 않는다).

## 한계 (아직 안 되는 것)

- 이 표는 이름의 대응을 적을 뿐이다. 다른 환경으로 문서를 자동 변환해 주지 않으며, 이름만 바꿔 변환을 지원한다고 말하지 않는다.
- `anthropic-skills:*`는 Claude 환경에서만 있는 스킬이다. 스킬이 없는 환경에서는 hwpx·docx·pdf·pptx 변환이 되지 않으므로 사람이 직접 변환하거나 "변환하지 못했다"고 알려야 한다.
- 단계 요약·라운드 변경점·남은 일(`carry_over`)·시작 질문 설정값을 상태에 쓰는 전용 pes 명령은 아직 없다. 지금은 `note`로 남기고 설정값은 받은 답에서 읽는다.
- `Agent` 도구가 없거나 서브에이전트를 못 띄우는 설정이면 독립 검토를 메인이 대신하지 않는다. 사용자에게 알리고 지시문 파일(`qa-brief`)을 다른 세션에서 읽게 한다.
