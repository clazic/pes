# 어댑터 노트 — OpenCode 앱 (방식 B)

사람이 직접 켠 **OpenCode 앱**이 PES와 일하는 길이다. 길은 둘이다: **직접 연결**(앱이 PES의 MCP 서버로 도구를 부른다)과 **명시적 전달**(사람이 묶음을 복사해 앱에 주고, 앱의 답을 PES에 붙여 가져온다). 공통 계약(도구 11개, `idempotency_key`, 진행 알림 형식, 오류, 명시적 전달)은 [adapter-contract.md](adapter-contract.md)이고, 여기에는 OpenCode 앱만의 부분을 적는다. 터미널 화면판은 [opencode-tui.md](opencode-tui.md)이고, 문서 변환·스킬 대응에 대한 옛 노트는 [opencode.md](opencode.md)다. OpenCode 앱은 PES가 띄우지 않는다.

**직접 연결이 되는지는 이 저장소가 확인하지 못했다.** 앱이 `opencode.json`의 MCP 설정을 읽는지, `{env:VAR}`를 채워 주는지는 앱 버전마다 다를 수 있다. 그래서 직접 연결이 안 될 때 **보장하는 길은 명시적 전달**이다 — 앱이 PES에 접속하지 못해도 복사 → 앱과 대화 → 붙여넣기로 같은 일을 하고, 이 길은 앱의 설정에 기대지 않는다.

## OpenCode 앱은 내장 실행기가 아니다

- **방식 A(내장 실행기, `pes_builtin`)와 다르다.** 내장 실행기는 PES가 직접 Go API를 부르고 구독 사용량을 센다. OpenCode 앱은 사람이 직접 켠 앱이고, 모델을 고르고 부르는 것은 앱이다. PES는 그 사용량을 보지도 막지도 못한다. 둘을 같은 이름으로 섞지 않는다.
- **내장 실행기의 프로필과 서버는 건드리지 않는다.** OpenCode 앱은 방식 A가 쓰는 프로필과 서버를 재사용하지 않고 중단하지도 않는다. 앱 연결도 명시적 전달도 방식 A 표(디스패치·사용량·Go 계량·연결)를 바꾸지 않는다.
- 둘은 프로젝트의 lease 하나를 나눠 쓴다. 한쪽이 잡고 있으면 다른 쪽의 시작은 `conflict`로 거부되고 아무것도 쓰지 않는다. B 연결은 방식 A 실행을 만들 수 없다. 명시적 전달은 lease를 쓰지 않는다.
- OpenCode TUI와도 섞이지 않는다. 앱은 `runtime=opencode_app`, 터미널 화면판은 `runtime=opencode_tui`이고 토큰 이름(`pes-agent-token-opencode_app-<프로젝트 id>`)도 따로다.
- 승인·재개방·봉인·정책·등록·토큰·삭제·export 도구는 없다.

## Go 경로: 차단과 한계

Go 구독(`opencode-go/…` 모델)의 계량·한도는 방식 A만 다룬다. 그래서:

- **차단**: `opencode_app_mcp_entry`는 모델이 Go 경로(`opencode-go` 또는 `opencode-go/…`)이면 `go_route_blocked`(한국어 설명)로 연결 항목 만들기를 거부한다. 판정은 OpenCode TUI 항목과 같다(대소문자·전각 문자·보이지 않는 서식 문자·하이픈 비슷한 문자·밑줄·공백을 같은 구분자로 읽는다. 공백이나 서식 문자가 든 모델 이름은 Go가 아니어도 거부한다). 연결 항목에는 Go 경로 이름이 들어가지 않는다.
- **한계**: 이 차단은 연결 항목에 *적는* 모델 이름만 검사하고, 키릴 문자 같은 다른 문자 체계의 비슷한 글자로 흉내 낸 이름은 가려내지 못한다. 사람이 앱 안에서 Go 모델을 골라 쓰는 것을 PES는 보지도 막지도 못하며, 그 사용량은 Go 계량에 잡히지 않는다. B 실행의 provider는 `unknown`, model은 사람이 알려 주지 않으면 `unknown`이다. 명시적 전달은 붙여 넣은 글이 말한 모델을 주장으로만 남기고 `unknown`으로 기록한다.
- Go 모델을 PES가 관리하는 한도 안에서 쓰려면 방식 A를 쓴다.

## 직접 연결

`scripts/pes_core/adapters/opencode_app.ts`의 `opencode_app_mcp_entry`가 `opencode.json`의 `mcp.servers.pes` 항목을 만든다(모양은 OpenCode TUI 항목과 같고 `PES_RUNTIME`만 다르다). 파일을 읽지도 쓰지도 않고 프로세스도 띄우지 않으니 설정에 넣는 것은 사용자가 한다. `command`는 node 실행 파일 경로를 그대로 준다(`which`로 찾지 않는다). `<프로젝트 id>`는 등록한 프로젝트의 id로 바꾼다.

```json pes-config
{
  "mcp": {
    "servers": {
      "pes": {
        "type": "local",
        "command": ["/path/to/node", "/path/to/pes/scripts/pes_core/mcp_server.ts"],
        "environment": {
          "PES_PROJECT_ID": "<프로젝트 id>",
          "PES_API_BASE_URL": "http://127.0.0.1:8760",
          "PES_RUNTIME": "opencode_app",
          "PES_PROVIDER": "unknown",
          "PES_MODEL": "unknown",
          "PES_AGENT_TOKEN": "{env:PES_AGENT_TOKEN}"
        }
      }
    }
  }
}
```

- **누가 쓰는가**: 직접 연결로 낸 결과는 에이전트 토큰의 `external_agent`가 `runtime=opencode_app`, `provider=unknown`, `mode B` 실행으로 낸 것이다. 영수증의 행위자는 그 에이전트이고 `via`는 `import`가 아니다. 모델은 앱이 PES에 알려 주지 않으므로 `unknown`이다. 사용량은 B 실행에 기록하지 않는다.
- **설정 형식**: OpenCode TUI 노트의 「설정 형식」과 같다 — 서버 이름은 `mcp.servers` 밑에 두고, 끄는 항목은 `enabled`가 아니라 `disabled`다. 예시에 `enabled`는 없다. 앱이 어느 형식을 읽는지는 미확인이다.
- **토큰은 참조로만**: `{env:PES_AGENT_TOKEN}`은 앱이 시작된 환경의 변수로 채워진다. 값은 `opencode.json`에 적지 않는다.
- **주소·입력 규칙**: `PES_API_BASE_URL`은 이 컴퓨터의 루프백 `http` 주소만 받는다. 제어 문자·`{env:…}`·`{file:…}` 치환 표기·공백이나 서식 문자가 든 모델 이름은 고정 `code`(`field_invalid`·`substitution_blocked`·`api_base_url_invalid`)와 한국어 설명의 `TypeError`로 거부하고 값을 되풀이하지 않는다.

### 토큰 받기

프로젝트와 기기는 사람의 로컬 세션이 등록하고(계약 4절), 돌려받은 에이전트 토큰이 이 연결의 유일한 자격이다. 앱을 켜는 프로세스의 환경변수 `PES_AGENT_TOKEN`에 그 토큰이 있어야 한다 — 값을 채팅에 다시 쓰지 않는다. `opencode_app_launch_env({key_store, project_id})`는 키 저장소(PR19의 `KeyStore`)에서 `pes-agent-token-opencode_app-<프로젝트 id>`를 **한 번 읽어(`get(ref)`)** `{PES_AGENT_TOKEN}`을 메모리로 돌려준다. 읽기만 하고 파일에는 쓰지 않는다. 없으면 `token_missing`(한국어 설명)이고, 그 설명은 **명시적 전달**을 항상 쓸 수 있는 길로 알려 준다.

**한계**: 지금 PES에는 에이전트 토큰을 키 저장소의 `pes-agent-token-…` 항목으로 넣는 명령이 **없다**. 지금 쓸 수 있는 절차는 하나다: 등록으로 받은 토큰을 앱을 켜는 환경의 `PES_AGENT_TOKEN`으로 둔다.

### 한 번에 한 흐름

`pes_context` → `pes_claim` → `pes_ask` → `pes_wait` → `pes_claim`(`run_id`로 이어받기) → `pes_context`(`inputs`) → `pes_read` → `pes_submit` → `pes_complete`. 아래 예시는 시험이 이 도구의 연결로 그대로 실행한다.

```json pes-example
{
  "name": "opencode app: claim, heartbeat, send one version and complete; a late heartbeat needs a new claim",
  "steps": [
    { "tool": "pes_context", "arguments": {}, "expect": "ok" },
    { "tool": "pes_claim", "arguments": { "idempotency_key": "oca-claim" }, "expect": "ok" },
    { "tool": "pes_heartbeat", "arguments": { "progress": { "phase": "started" }, "idempotency_key": "oca-hb" }, "expect": "ok" },
    {
      "tool": "pes_submit",
      "arguments": { "results": [{ "op": "append_version", "object_id": "${object_id}", "title": "OpenCode 앱 예시 결과" }], "idempotency_key": "oca-results" },
      "expect": "ok"
    },
    { "tool": "pes_complete", "arguments": { "status": "succeeded", "idempotency_key": "oca-done" }, "expect": "ok" },
    { "tool": "pes_heartbeat", "arguments": { "progress": { "phase": "stage" }, "idempotency_key": "oca-late" }, "expect": "claim_required" }
  ]
}
```

## 명시적 전달 (보장 경로)

`OpencodeAppAdapter`(`scripts/pes_core/adapters/opencode_app.ts`)는 Claude 앱의 전달([claude-app.md](claude-app.md), 계약 6절)과 같은 생성자 `{api, project_id, owner_session}`·같은 방법·같은 거부 코드를 쓴다.

1. **복사** — `export_bundle({stage_id, round_id})`가 묶음(JSON 글)을 만든다. 읽기뿐이라 실행도 lease도 행도 생기지 않는다. 묶음에는 토큰·세션 비밀·lease가 없다.
2. **앱과 대화** — 사람이 묶음을 앱에 주고, 앱이 묶음의 안내대로 JSON 한 개로 답한다. 이 단계에서 PES에는 아무 일도 없다.
3. **가져오기** — 사람이 `import_result({bundle_text, result_text})`로 묶음과 앱의 답을 PES에 붙인다. 소유자 세션이 이 행위를 승인한다.

가져온 결과는 앱이나 에이전트의 제출이 **아니라 사람(소유자)이 가져온 것**으로 남는다. 어댑터는 요청에 `app = opencode_app`을 실어 보내고, 서버가 그 값으로 실행의 표시를 정한다(붙여 넣은 글이 아니라 서버의 닫힌 목록이 정한다).

| 항목 | 직접 연결 | 명시적 전달 |
|---|---|---|
| 행위자 | `external_agent`(에이전트 토큰) | 사람(소유자) |
| 실행 | `runtime = opencode_app`, `provider = unknown`, `mode B` | 소유자 자신의 전달용 실행: `runtime = opencode_app_handoff`, `provider = unknown`, `mode B` |
| 모델 | `unknown` | `unknown` — 붙여 넣은 글이 말한 모델은 주장일 뿐 |
| 영수증 `via` | `import`가 아님 | `import` |
| 에이전트 claim | 있다(`run.claimed`) | 없다. 출처 표지 `provenance = {source: manual_import, claimed_tool, claimed_model, verified: false}` |

거부는 모두 아무것도 쓰지 않는다: `bundle_invalid`, `bundle_hash_mismatch`, `bundle_wrong_project`, `bundle_stale`(복사 뒤 프로젝트나 기반 버전이 바뀜 — 다시 복사), `duplicate_import`(같은 묶음을 두 번 — 내용이 달라도), `result_out_of_scope`, `attachment_missing`, `attachment_unsupported`. 승인된 단계와 봉인된 라운드는 서버가 `conflict`로 거른다 — 가져오기는 사람의 결정을 우회하지 못한다. 같은 키로 다른 요청을 보내면 `idempotency_key_reuse`(409)이고 아무것도 쓰지 않는다. **`manifest_hash`는 인증이 아니다** — 사고를 잡는 무결성 검사일 뿐이다.

## 재현 절차 (노트만 보고)

1. PES 로컬 서버를 켜고 프로젝트를 등록해 에이전트 토큰을 받는다(사람의 일, 계약 4절).
2. **직접 연결**: 토큰을 앱을 켜는 환경의 `PES_AGENT_TOKEN`에 두고, 위 `pes-config` 예시를 `opencode.json`에 넣는다(`/path/to/…`·`<프로젝트 id>`를 바꾼다. 모델 이름은 Go 경로가 아닌 것만 적는다. Windows 경로는 JSON 문자열에서 역슬래시를 두 번 적는다). 앱에서 첫 일로 `pes_context`를 부르게 한다.
3. **명시적 전달**: `export_bundle`로 묶음을 복사해 앱에 주고, 앱의 JSON 답을 `import_result`로 붙인다.

## 미확인과 시험 결과

- **미확인**: 실제 OpenCode 앱에서 직접 연결로 6단계를 돈 기록은 없다. 시험은 가짜 MCP 클라이언트와 합성 프로젝트로 같은 뜻을 확인하고, 설정 예시는 임시 폴더에 써서 읽어 본다. 이 저장소의 시험은 실제 OpenCode 앱·`opencode`를 실행하지 않고 사용자의 OpenCode 설정 폴더를 읽거나 쓰지 않는다.
- **미확인 (시험 결과)**: OpenCode 앱과 OpenCode TUI가 `opencode.json` 같은 MCP 설정을 공유하는지는 확인하지 않았다. 이 문서는 설정 공유를 보장하지 않는다. 시험 결과로 확인되기 전에는 앱과 터미널 화면판 각각에 항목을 넣어야 하는 것으로 본다. 확인되면 이 절에 시험 결과로 적는다.
- **미확인**: 앱 버전마다 설정 형식(`mcp.servers`), `{env:VAR}`가 `environment` 값 안에서도 풀리는지, 긴 대기 중 연결 끊김 처리가 같은지 확인하지 않았다. `PES_AGENT_TOKEN`이 앱을 켠 환경에 없으면 서버가 "환경변수가 필요합니다"라고 알리고 시작하지 않는다. 글자 그대로 `{env:PES_AGENT_TOKEN}`이 서버에 닿으면 토큰이 틀려 `unauthenticated`로 거부된다 — 값을 설정 파일에 적어 해결하지 않는다. 이럴 때는 명시적 전달을 쓴다.
- 전달로 가져올 때는 첨부 파일을 저장하지 않는다(`attachment_unsupported`). 모델과 사용량은 PES가 알 수 없어 `unknown`이다.
