# 어댑터 노트 — Codex CLI (방식 B)

사람이 터미널에서 직접 켠 **Codex CLI**가 PES의 로컬 API로 일하게 하는 길이다. 공통 계약(도구 11개, `idempotency_key`, 진행 알림 형식, 오류)은 [adapter-contract.md](adapter-contract.md)이고, 여기에는 Codex CLI만의 부분을 적는다. Codex CLI는 PES가 띄우지 않는다 — 사람이 켠 세션이 MCP 도구를 부를 뿐이다.

## 무엇이 아닌가

- **방식 A(내장 실행기)가 아니다.** 내장 실행기(`pes_builtin`)는 PES가 직접 모델을 부르고 사용량을 센다. Codex CLI 연결은 그렇지 않다: PES는 Codex가 어떤 모델을 얼마나 쓰는지 보지도 막지도 않는다. 둘은 프로젝트의 lease 하나를 나눠 쓰므로 한쪽이 잡고 있으면 다른 쪽의 시작은 `conflict`로 거부되고 아무것도 쓰지 않는다.
- Go 구독 경로(`opencode-go`)와 상관이 없다. 방식 B 연결은 Go 경로로 실행을 만들지 않는다.
- 승인·재개방·봉인·정책·등록·토큰·삭제·export 도구는 없다. 그것은 사람의 일이다.

## 연결 항목

`scripts/pes_core/adapters/codex_cli.ts`의 `codex_cli_mcp_entry`가 Codex의 MCP 설정(`config.toml`)에 넣을 `[mcp_servers.pes]` 표를 만든다. 파일을 읽지도 쓰지도 않고 프로세스도 띄우지 않으니, 설정 파일에 넣는 것은 사용자가 한다. `command`는 node 실행 파일의 경로를 그대로 준다(`which`로 찾지 않는다). `<프로젝트 id>`는 등록한 프로젝트의 id로 바꾼다.

```toml pes-config
[mcp_servers.pes]
command = "/path/to/node"
args = ["/path/to/pes/scripts/pes_core/mcp_server.ts"]
env = { PES_PROJECT_ID = "<프로젝트 id>", PES_API_BASE_URL = "http://127.0.0.1:8760", PES_RUNTIME = "codex_cli", PES_PROVIDER = "openai", PES_MODEL = "unknown" }
env_vars = ["PES_AGENT_TOKEN"]
```

- **토큰은 이름으로만**: `env_vars`는 Codex가 시작된 환경에서 `PES_AGENT_TOKEN`을 서버 프로세스로 넘기라는 뜻이다. 토큰 값은 설정 파일에도 `env`에도 적지 않는다.
- **실행 표시**: `PES_RUNTIME=codex_cli`, `PES_PROVIDER=openai`(도구를 만든 쪽). 실제 모델은 Codex가 PES에 알려 주지 않으므로 `PES_MODEL`은 `unknown`이다. 사람이 모델을 안다면 그 이름을 적을 수 있지만 PES가 확인하지는 않는다. 사용량은 B 실행에 기록하지 않는다 — 숫자를 지어내지 않는다.
- **주소**: `PES_API_BASE_URL`은 이 컴퓨터의 루프백 `http` 주소만 받는다(토큰이 컴퓨터 밖으로 나가지 않는다). 다른 주소는 연결 항목 만들기와 서버 시작이 모두 거부한다.

## 토큰 받기

프로젝트와 기기는 사람의 로컬 세션이 등록하고(계약 4절), 돌려받은 에이전트 토큰이 이 연결의 유일한 자격이다. 토큰은 **키 저장소**(OS 키체인)에 둔다. `codex_cli_launch_env({key_store, project_id})`는 Codex를 켜는 쪽이 부르는 함수로, 키 저장소에서 `pes-agent-token-codex_cli-<프로젝트 id>`를 **한 번 읽어(`get(ref)`)** `{PES_AGENT_TOKEN}`을 메모리로 돌려준다. 읽기만 하고 쓰거나 지우지 않으며, 파일에는 쓰지 않는다. 토큰이 없으면 `token_missing`(한국어 설명)이다. 돌려받은 값을 Codex를 켜는 프로세스의 환경변수 `PES_AGENT_TOKEN`에 넣어 Codex를 시작한다 — 값을 채팅에 다시 쓰지 않는다.

키 저장소 구현은 PR19에서 오고 이 PR은 그것에 의존하지 않는다(구조만 같은 최소 형태를 쓴다). 그 전에는 토큰을 사람이 직접 `PES_AGENT_TOKEN` 환경변수로 두면 된다.

## 한 번에 한 흐름

`pes_context` → `pes_claim` → `pes_ask` → `pes_wait`(사람이 답함) → `pes_claim`(`run_id`로 이어받기) → `pes_context`(`inputs`) → `pes_read`(답 본문) → `pes_submit` → `pes_complete`. Codex를 껐다 켜도 `run_id`를 주면 같은 실행을 새 fence로 이어받는다. 아래 예시는 시험이 이 도구의 연결로 그대로 실행한다.

```json pes-example
{
  "name": "codex cli: claim, send one version, complete; a late send needs a new claim",
  "steps": [
    { "tool": "pes_context", "arguments": {}, "expect": "ok" },
    { "tool": "pes_claim", "arguments": { "idempotency_key": "cx-claim" }, "expect": "ok" },
    {
      "tool": "pes_submit",
      "arguments": { "results": [{ "op": "append_version", "object_id": "${object_id}", "title": "Codex 예시 결과" }], "idempotency_key": "cx-results" },
      "expect": "ok"
    },
    { "tool": "pes_complete", "arguments": { "status": "succeeded", "idempotency_key": "cx-done" }, "expect": "ok" },
    {
      "tool": "pes_submit",
      "arguments": { "results": [{ "op": "append_version", "object_id": "${object_id}", "title": "끝난 뒤" }], "idempotency_key": "cx-late" },
      "expect": "claim_required"
    }
  ]
}
```

## 재현 절차 (노트만 보고)

1. PES 로컬 서버를 켜고 프로젝트를 등록해 에이전트 토큰을 받는다(사람의 일, 계약 4절).
2. 토큰을 키 저장소에 두거나 환경변수 `PES_AGENT_TOKEN`에 둔다.
3. 위 `pes-config` 예시를 `config.toml`에 넣는다. `/path/to/node`·`/path/to/pes/…`·`<프로젝트 id>`를 실제 값으로 바꾼다.
4. `PES_AGENT_TOKEN`이 들어 있는 환경에서 Codex를 켜고, 첫 일로 `pes_context`를 부르게 한다.

## 미확인과 한계

- **미확인**: 실제 Codex CLI 세션에서 이 MCP 도구로 6단계를 돈 기록은 없다. 시험은 가짜 MCP 클라이언트와 합성 프로젝트로 같은 뜻을 확인하고, 설정 예시는 임시 폴더에 써서 읽어 본다. 이 저장소의 시험은 실제 `codex`를 실행하지 않고 사용자의 `~/.codex`를 읽거나 쓰지 않는다.
- **미확인**: Codex 버전마다 `env_vars`(환경에서 넘기기)와 `env`의 처리, MCP 서버 시작 제한 시간, 긴 대기 중 연결 끊김 처리가 같은지 확인하지 않았다. `env_vars`를 지원하지 않는 버전에서는 토큰이 서버에 닿지 않아 모든 호출이 `unauthenticated`로 거부된다(값을 `env`에 적어서 해결하지 않는다 — 토큰을 설정 파일에 남기지 않는 것이 규칙이다).
- 모델과 사용량은 PES가 알 수 없어 `unknown`이다. 사람이 쓰는 Codex 사용량은 PES가 막지 못한다.
- 이 노트는 Codex의 승인·샌드박스 설정을 다루지 않는다. PES 쪽 권한은 토큰의 범위와 API 규칙이 정한다.
