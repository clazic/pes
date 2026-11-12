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
| 플러그인 경로 | `${CLAUDE_PLUGIN_ROOT}`. 비어 있으면 스킬의 Base directory 기준 `../../scripts/pes.ts` |
| 세션 표시 (`PES_OWNER`) | 세션 처음에 ID를 정해(모르면 `uuidgen`) 모든 pes 호출에 붙인다 |
| 다른 프로젝트 열기 | 다른 터미널 탭의 Claude Code 세션에서 `/pes:run <폴더>` |
| eli5 보고서 | `eli5:eli5` 스킬의 원칙 |
| 공유 | artifacts로 게시해 링크를 준다 |
| 재시작 안내 (설치 뒤) | "Claude Desktop(또는 Claude Code)을 한 번 다시 시작하면 모든 세션에 적용됩니다" |

## 방식 B: MCP 도구로 PES에 접속하기 (PR20a)

Claude Code가 사람이 켠 세션으로 PES의 로컬 API에 일하게 하는 길이다. 공통 계약(도구 14개 — 읽기 `pes_context`·`pes_read` 포함, `idempotency_key`, 진행 알림 형식, 오류)은 [adapter-contract.md](adapter-contract.md)이고, 여기에는 Claude Code만의 부분을 적는다.

- **연결 항목**: `scripts/pes_core/adapters/claude_code.ts`의 `claude_code_mcp_entry`가 Claude Code의 MCP 설정에 넣을 항목을 만든다. 파일을 읽지도 쓰지도 않으니 설정 파일에 넣는 것은 사용자가 한다. 토큰은 **값이 아니라 참조**(`${PES_AGENT_TOKEN}`)로 적는다 — Claude Code가 시작할 때 환경변수에서 채운다. `command`는 node 실행 파일의 경로를 그대로 준다(`which`로 찾지 않는다).

```json
{
  "command": "/path/to/node",
  "args": ["/path/to/pes/scripts/pes_core/mcp_server.ts"],
  "env": {
    "PES_PROJECT_ID": "<프로젝트 id>",
    "PES_API_BASE_URL": "http://127.0.0.1:8760",
    "PES_AGENT_TOKEN": "${PES_AGENT_TOKEN}",
    "PES_RUNTIME": "claude_code",
    "PES_PROVIDER": "anthropic"
  }
}
```

- **토큰 받기**: 프로젝트와 기기는 사람의 로컬 세션이 등록한다(`project-registrations`). 받은 기기 토큰을 환경변수 `PES_AGENT_TOKEN`에 두고 값을 채팅에 다시 쓰지 않는다. Claude Code에는 등록·승인·봉인 도구가 없다.
- **실행 표시**: 연결 항목이 `PES_RUNTIME=claude_code`, `PES_PROVIDER=anthropic`을 명시한다(서버 자체의 기본값은 `mcp`·`unknown`이라 다른 도구가 같은 서버를 쓰다 변수를 빠뜨려도 `claude_code`로 남지 않는다). 모델은 `PES_MODEL`로 알려 주지 않으면 `unknown`으로 기록된다.
- **한 번에 한 흐름**: `pes_context` → `pes_claim` → `pes_ask` → `pes_wait`(사람이 답함) → `pes_claim`(`run_id`로 이어받기) → `pes_context`(`inputs`) → `pes_read`(답 본문 `content.value`·`content.comment`) → `pes_submit` → `pes_complete`. 답이 많으면 `pes_context`의 `inputs_next_cursor`를 `inputs_cursor`로 주어 이어 읽는다. 아래 예시는 시험이 그대로 실행한다.

```json pes-example
{
  "name": "claude code: claim, heartbeat and release, then reclaim the same run",
  "steps": [
    { "tool": "pes_claim", "arguments": { "idempotency_key": "cc-claim" }, "expect": "ok" },
    { "tool": "pes_heartbeat", "arguments": { "progress": { "phase": "stage" }, "idempotency_key": "cc-hb" }, "expect": "ok" },
    { "tool": "pes_release", "arguments": { "idempotency_key": "cc-release" }, "expect": "ok" },
    { "tool": "pes_cancel", "arguments": { "confirm": true, "idempotency_key": "cc-cancel" }, "expect": "claim_required" }
  ]
}
```

- **로컬 도우미**: pes link·pes sync는 도구 연결과 다른 자격(`helper_device`)을 쓴다. 계약만 [adapter-contract.md](adapter-contract.md) 5절에 있고 이 PR은 CLI를 만들지 않는다.

## 서브에이전트가 지키는 것

서브에이전트는 `Write`로 쓴 제안 파일(`rounds/<단계>-R<n>/<id>.json` 등)에만 결과를 남긴다. 업무 상태(프로젝트 상태 파일·업무 DB·잠금 파일)를 직접 고치지 않는다 — 메인이 `merge`·`qa` 같은 pes 명령으로 넘긴다. 제안 파일은 `submit`의 입력 형식(DB 결과 형식)이 아니므로 `submit`으로 내지 않는다. reviewer는 메인의 결론을 모른 채 따로 판단한다(독립 검토는 모든 단계·모든 라운드, 생략하지 않는다).

## 한계 (아직 안 되는 것)

- 이 표는 이름의 대응을 적을 뿐이다. 다른 환경으로 문서를 자동 변환해 주지 않으며, 이름만 바꿔 변환을 지원한다고 말하지 않는다.
- `anthropic-skills:*`는 Claude 환경에서만 있는 스킬이다. 스킬이 없는 환경에서는 hwpx·docx·pdf·pptx 변환이 되지 않으므로 사람이 직접 변환하거나 "변환하지 못했다"고 알려야 한다.
- `set`(단계 요약·변경점·남은 일·설정·점검, 최종 요약·결론)은 지금 옛 방식(v0.15) 프로젝트에서만 쓸 수 있다. DB 경로(`PES_DB_CORE=1`)에서는 대응 명령이 생길 때까지 한국어 이유와 함께 거부되고 아무것도 바뀌지 않는다 — 우회해서 다른 명령에 끼워 넣지 않는다.
- `context`·`claim`·`submit`·`wait`·`complete`는 DB 경로(`PES_DB_CORE=1`, 작업 토큰을 받은 작업자)에서만 동작한다. 기본 경로에서는 거부되므로 `status`·`digest`·`show`와 `pending`이 알려 준 답 파일(`feedback/*.json`)로 읽고, 결과는 `merge`로 낸다. DB 경로에서도 스킬의 제안 파일은 `merge`로 넘긴다 — `submit`은 DB 결과 형식(`op: append_version`, 이미 있는 `object_id`) 전용이다.
- **미확인**: 실제 Claude Code 세션에서 MCP 도구를 불러 6단계를 돈 기록은 아직 없다. 시험은 가짜 MCP 클라이언트로 같은 뜻을 확인한다. Claude Code가 MCP 설정의 `${VAR}`를 어디서까지 풀어 주는지, 긴 대기 중 연결 끊김 처리는 사용해 보고 적는다.
- `Agent` 도구가 없거나 서브에이전트를 못 띄우는 설정이면 독립 검토를 메인이 대신하지 않는다. 사용자에게 알리고 지시문 파일(`qa-brief`)을 다른 세션에서 읽게 한다.
