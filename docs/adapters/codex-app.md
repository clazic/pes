# 어댑터 노트 — Codex 앱 (방식 B)

사람이 직접 켠 **Codex 앱**이 PES와 일하는 길이다. 길은 둘이다: **직접 연결**(앱이 PES의 MCP 서버로 도구를 부른다)과 **명시적 전달**(사람이 묶음을 복사해 앱에 주고, 앱의 답을 PES에 붙여 가져온다). 공통 계약(도구 11개, `idempotency_key`, 진행 알림 형식, 오류, 명시적 전달)은 [adapter-contract.md](adapter-contract.md)이고, 여기에는 Codex 앱만의 부분을 적는다. 터미널판은 [codex.md](codex.md)다. Codex 앱은 PES가 띄우지 않는다.

**직접 연결이 되는지는 이 저장소가 확인하지 못했다.** 앱이 MCP 설정을 읽는지, 환경변수를 서버로 넘기는지는 앱 버전마다 다를 수 있다. 그래서 직접 연결이 안 될 때 **보장하는 길은 명시적 전달**이다 — 앱이 PES에 접속하지 못해도 복사 → 앱과 대화 → 붙여넣기로 같은 일을 하고, 이 길은 앱의 설정에 기대지 않는다.

## 무엇이 아닌가

- **방식 A(내장 실행기)가 아니다.** 내장 실행기(`pes_builtin`)는 PES가 직접 모델을 부르고 사용량을 센다. Codex 앱은 그렇지 않다: PES는 앱이 어떤 모델을 얼마나 쓰는지 보지도 막지도 않는다. 둘은 프로젝트의 lease 하나를 나눠 쓰므로 한쪽이 잡고 있으면 다른 쪽의 시작은 `conflict`로 거부되고 아무것도 쓰지 않는다. 명시적 전달은 lease를 쓰지 않고 방식 A 표(디스패치·사용량·Go 계량·연결)도 바꾸지 않는다.
- Go 구독 경로(`opencode-go`)와 상관이 없다. Go 경로 차단 검사는 OpenCode 연결 항목에만 있다.
- Codex CLI와 섞이지 않는다. 앱은 `runtime=codex_app`, 터미널판은 `runtime=codex_cli`이고, 토큰 이름(`pes-agent-token-codex_app-<프로젝트 id>`)도 따로다. 한쪽이 lease를 잡고 있으면 다른 쪽의 claim은 `conflict`이다.
- 승인·재개방·봉인·정책·등록·토큰·삭제·export 도구는 없다. 그것은 사람의 일이다.

## 직접 연결

`scripts/pes_core/adapters/codex_app.ts`의 `codex_app_mcp_entry`가 Codex 앱의 MCP 설정에 넣을 `[mcp_servers.pes]` 표를 만든다. 모양은 Codex CLI의 항목과 같고 `PES_RUNTIME`만 다르다. 파일을 읽지도 쓰지도 않고 프로세스도 띄우지 않으니, 설정에 넣는 것은 사용자가 한다. `command`는 node 실행 파일의 경로를 그대로 준다(`which`로 찾지 않는다). `<프로젝트 id>`는 등록한 프로젝트의 id로 바꾼다.

```toml pes-config
[mcp_servers.pes]
command = "/path/to/node"
args = ["/path/to/pes/scripts/pes_core/mcp_server.ts"]
env = { PES_PROJECT_ID = "<프로젝트 id>", PES_API_BASE_URL = "http://127.0.0.1:8760", PES_RUNTIME = "codex_app", PES_PROVIDER = "openai", PES_MODEL = "unknown" }
env_vars = ["PES_AGENT_TOKEN"]
```

- **누가 쓰는가**: 직접 연결로 낸 결과는 에이전트 토큰의 `external_agent`가 `runtime=codex_app`, `provider=openai`, `mode B` 실행으로 낸 것이다. 영수증의 행위자는 그 에이전트이고 `via`는 `import`가 아니다. 실제 모델은 앱이 PES에 알려 주지 않으므로 `PES_MODEL`은 `unknown`이다. 사용량은 B 실행에 기록하지 않는다 — 숫자를 지어내지 않는다.
- **토큰은 이름으로만**: `env_vars`는 앱이 시작된 환경에서 `PES_AGENT_TOKEN`을 서버 프로세스로 넘기라는 뜻이다. 토큰 값은 설정에도 `env`에도 적지 않는다.
- **주소**: `PES_API_BASE_URL`은 이 컴퓨터의 루프백 `http` 주소만 받는다(토큰이 컴퓨터 밖으로 나가지 않는다).
- **입력 규칙**: Codex CLI 항목과 같다([codex.md](codex.md)의 「연결 항목」). 제어 문자·`{env:…}`·`{file:…}` 치환 표기·루프백이 아닌 주소는 고정 `code`와 한국어 설명의 `TypeError`로 거부하고 값을 되풀이하지 않는다.

### 토큰 받기

프로젝트와 기기는 사람의 로컬 세션이 등록하고(계약 4절), 돌려받은 에이전트 토큰이 이 연결의 유일한 자격이다. 앱을 켜는 프로세스의 환경변수 `PES_AGENT_TOKEN`에 그 토큰이 있어야 한다 — 값을 채팅에 다시 쓰지 않는다. `codex_app_launch_env({key_store, project_id})`는 키 저장소(PR19의 `KeyStore`)에서 `pes-agent-token-codex_app-<프로젝트 id>`를 **한 번 읽어(`get(ref)`)** `{PES_AGENT_TOKEN}`을 메모리로 돌려준다. 읽기만 하고 쓰거나 지우지 않으며 파일에는 쓰지 않는다. 토큰이 없으면 `token_missing`(한국어 설명)이고, 그 설명은 **명시적 전달**을 항상 쓸 수 있는 길로 알려 준다. 다른 도구(Codex CLI)의 토큰은 이 앱의 것이 아니라서 읽지 않는다.

**한계**: 지금 PES에는 에이전트 토큰을 키 저장소의 `pes-agent-token-…` 항목으로 넣는 명령이 **없다**. 지금 쓸 수 있는 절차는 하나다: 등록으로 받은 토큰을 앱을 켜는 환경의 `PES_AGENT_TOKEN`으로 둔다.

### 한 번에 한 흐름

`pes_context` → `pes_claim` → `pes_ask` → `pes_wait`(사람이 답함) → `pes_claim`(`run_id`로 이어받기) → `pes_context`(`inputs`) → `pes_read`(답 본문) → `pes_submit` → `pes_complete`. 앱을 껐다 켜도 `run_id`를 주면 같은 실행을 새 fence로 이어받는다. 아래 예시는 시험이 이 도구의 연결로 그대로 실행한다.

```json pes-example
{
  "name": "codex app: claim, send one version, complete; a late send needs a new claim",
  "steps": [
    { "tool": "pes_context", "arguments": {}, "expect": "ok" },
    { "tool": "pes_claim", "arguments": { "idempotency_key": "cxa-claim" }, "expect": "ok" },
    {
      "tool": "pes_submit",
      "arguments": { "results": [{ "op": "append_version", "object_id": "${object_id}", "title": "Codex 앱 예시 결과" }], "idempotency_key": "cxa-results" },
      "expect": "ok"
    },
    { "tool": "pes_complete", "arguments": { "status": "succeeded", "idempotency_key": "cxa-done" }, "expect": "ok" },
    {
      "tool": "pes_submit",
      "arguments": { "results": [{ "op": "append_version", "object_id": "${object_id}", "title": "끝난 뒤" }], "idempotency_key": "cxa-late" },
      "expect": "claim_required"
    }
  ]
}
```

## 명시적 전달 (보장 경로)

`CodexAppAdapter`(`scripts/pes_core/adapters/codex_app.ts`)는 Claude 앱의 전달([claude-app.md](claude-app.md), 계약 6절)과 같은 생성자 `{api, project_id, owner_session}`·같은 방법·같은 거부 코드를 쓴다.

1. **복사** — `export_bundle({stage_id, round_id})`가 묶음(JSON 글)을 만든다. 읽기뿐이라 실행도 lease도 행도 생기지 않는다. 묶음에는 토큰·세션 비밀·lease가 없다.
2. **앱과 대화** — 사람이 묶음을 앱에 주고, 앱이 묶음의 안내대로 JSON 한 개로 답한다. 이 단계에서 PES에는 아무 일도 없다.
3. **가져오기** — 사람이 `import_result({bundle_text, result_text})`로 묶음과 앱의 답을 PES에 붙인다. 소유자 세션이 이 행위를 승인한다.

가져온 결과는 앱이나 에이전트의 제출이 **아니라 사람(소유자)이 가져온 것**으로 남는다. 어댑터는 요청에 `app = codex_app`을 실어 보내고, 서버가 그 값으로 실행의 표시를 정한다(붙여 넣은 글이 아니라 서버의 닫힌 목록이 정한다).

| 항목 | 직접 연결 | 명시적 전달 |
|---|---|---|
| 행위자 | `external_agent`(에이전트 토큰) | 사람(소유자) |
| 실행 | `runtime = codex_app`, `provider = openai`, `mode B` | 소유자 자신의 전달용 실행: `runtime = codex_app_handoff`, `provider = openai`, `mode B` |
| 모델 | `unknown` | `unknown` — 붙여 넣은 글이 말한 모델은 주장일 뿐 |
| 영수증 `via` | `import`가 아님 | `import` |
| 에이전트 claim | 있다(`run.claimed`) | 없다. 출처 표지 `provenance = {source: manual_import, claimed_tool, claimed_model, verified: false}` |

거부는 모두 아무것도 쓰지 않는다: `bundle_invalid`, `bundle_hash_mismatch`, `bundle_wrong_project`, `bundle_stale`(복사 뒤 프로젝트나 기반 버전이 바뀜 — 다시 복사), `duplicate_import`(같은 묶음을 두 번 — 내용이 달라도), `result_out_of_scope`, `attachment_missing`, `attachment_unsupported`. 승인된 단계와 봉인된 라운드는 서버가 `conflict`로 거른다 — 가져오기는 사람의 결정을 우회하지 못한다. 같은 키로 다른 요청을 보내면 `idempotency_key_reuse`(409)이고 아무것도 쓰지 않는다. **`manifest_hash`는 인증이 아니다** — 사고를 잡는 무결성 검사일 뿐이다.

## 재현 절차 (노트만 보고)

1. PES 로컬 서버를 켜고 프로젝트를 등록해 에이전트 토큰을 받는다(사람의 일, 계약 4절).
2. **직접 연결**: 토큰을 앱을 켜는 환경의 `PES_AGENT_TOKEN`에 두고, 위 `pes-config` 예시를 앱의 MCP 설정에 넣는다(`/path/to/…`·`<프로젝트 id>`를 바꾼다. Windows 경로는 TOML 작은따옴표 리터럴 문자열로 적는다). 앱에서 첫 일로 `pes_context`를 부르게 한다.
3. **명시적 전달**: `export_bundle`로 묶음을 복사해 앱에 주고, 앱의 JSON 답을 `import_result`로 붙인다.

## 미확인과 시험 결과

- **미확인**: 실제 Codex 앱에서 직접 연결로 6단계를 돈 기록은 없다. 시험은 가짜 MCP 클라이언트와 합성 프로젝트로 같은 뜻을 확인하고, 설정 예시는 임시 폴더에 써서 읽어 본다. 이 저장소의 시험은 실제 Codex 앱·`codex`를 실행하지 않고 사용자의 `~/.codex`와 앱 설정을 읽거나 쓰지 않는다.
- **미확인 (시험 결과)**: Codex 앱과 Codex CLI가 `config.toml` 같은 MCP 설정을 공유하는지는 확인하지 않았다. 이 문서는 설정 공유를 보장하지 않는다. 시험 결과로 확인되기 전에는 앱과 터미널판 각각에 항목을 넣어야 하는 것으로 본다. 확인되면 이 절에 시험 결과로 적는다.
- **미확인**: 앱 버전마다 `env_vars`(환경에서 넘기기)와 `env`의 처리, 긴 대기 중 연결 끊김 처리가 같은지 확인하지 않았다. `PES_AGENT_TOKEN`이 앱을 켠 환경에 없으면 서버가 "환경변수가 필요합니다"라고 알리고 시작하지 않는다 — 값을 설정에 적어 해결하지 않는다. 토큰 값이 틀리면 호출이 `unauthenticated`로 거부된다. 이럴 때는 명시적 전달을 쓴다.
- **호출 제한 시간**: `pes_wait`는 한 번에 최대 25초 기다린다. `tool_timeout_sec`을 25보다 작게 줄이지 않는다(앱이 같은 설정 이름을 쓰는지는 미확인이다. 터미널판의 값은 [codex.md](codex.md)).
- 전달로 가져올 때는 첨부 파일을 저장하지 않는다(`attachment_unsupported`). 모델과 사용량은 PES가 알 수 없어 `unknown`이다. 사람이 쓰는 앱의 사용량은 PES가 막지 못한다.
