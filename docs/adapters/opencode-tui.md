# 어댑터 노트 — OpenCode TUI (방식 B)

사람이 터미널에서 직접 켠 **OpenCode TUI**(화면판)가 PES의 로컬 API로 일하게 하는 길이다. 공통 계약(도구 11개, `idempotency_key`, 진행 알림 형식, 오류)은 [adapter-contract.md](adapter-contract.md)이고, 여기에는 OpenCode TUI만의 부분을 적는다. 문서 변환·스킬 대응에 대한 옛 노트는 [opencode.md](opencode.md)이고, 이 노트는 MCP 연결만 다룬다.

## OpenCode TUI는 내장 실행기가 아니다

- **방식 A(내장 실행기, `pes_builtin`)와 다르다.** 내장 실행기는 PES가 직접 Go API를 부르고 구독 사용량을 센다. OpenCode TUI는 사람이 직접 켠 화면이고, 모델을 고르고 부르는 것은 OpenCode다. PES는 그 사용량을 보지도 막지도 못한다. 둘을 같은 이름으로 섞지 않는다.
- 둘은 프로젝트의 lease 하나를 나눠 쓴다. 한쪽이 잡고 있으면 다른 쪽의 시작은 `conflict`로 거부되고 아무것도 쓰지 않는다. B 연결은 방식 A 실행을 만들 수 없다.
- 승인·재개방·봉인·정책·등록·토큰·삭제·export 도구는 없다.

## Go 경로: 차단과 한계

Go 구독(`opencode-go/…` 모델)의 계량·한도는 방식 A만 다룬다. 그래서:

- **차단**: `opencode_tui_mcp_entry`는 모델이 Go 경로(`opencode-go` 또는 `opencode-go/…`, 대소문자 무시)이면 `go_route_blocked`(한국어 설명)로 연결 항목 만들기를 거부한다. 연결 항목에는 Go 경로 이름이 들어가지 않는다.
- **한계**: 이 차단은 연결 항목에 *적는* 모델 이름만 검사한다. 사람이 OpenCode 안에서 Go 모델을 골라 쓰는 것을 PES는 보지도 막지도 못하며, 그 사용량은 Go 계량에 잡히지 않는다. B 실행의 provider는 `unknown`, model은 사람이 알려 주지 않으면 `unknown`이다.
- Go 모델을 PES가 관리하는 한도 안에서 쓰려면 방식 A를 쓴다.

## 연결 항목

`scripts/pes_core/adapters/opencode_tui.ts`의 `opencode_tui_mcp_entry`가 `opencode.json`의 `mcp.pes` 항목을 만든다. 파일을 읽지도 쓰지도 않고 프로세스도 띄우지 않으니 설정 파일에 넣는 것은 사용자가 한다. `command`는 node 실행 파일 경로를 그대로 준다(`which`로 찾지 않는다). `<프로젝트 id>`는 등록한 프로젝트의 id로 바꾼다.

```json pes-config
{
  "mcp": {
    "pes": {
      "type": "local",
      "command": ["/path/to/node", "/path/to/pes/scripts/pes_core/mcp_server.ts"],
      "environment": {
        "PES_PROJECT_ID": "<프로젝트 id>",
        "PES_API_BASE_URL": "http://127.0.0.1:8760",
        "PES_RUNTIME": "opencode_tui",
        "PES_PROVIDER": "unknown",
        "PES_MODEL": "unknown",
        "PES_AGENT_TOKEN": "{env:PES_AGENT_TOKEN}"
      },
      "enabled": true
    }
  }
}
```

- **토큰은 참조로만**: OpenCode는 `{env:PES_AGENT_TOKEN}`을 시작한 환경의 변수로 채운다. 값은 `opencode.json`에 적지 않는다.
- **실행 표시**: `PES_RUNTIME=opencode_tui`. OpenCode는 여러 제공자를 쓰므로 `PES_PROVIDER`는 `unknown`이고, 모델도 PES에 알려 주지 않으므로 `unknown`이다. 사용량은 B 실행에 기록하지 않는다.
- **주소**: `PES_API_BASE_URL`은 이 컴퓨터의 루프백 `http` 주소만 받는다.

## 토큰 받기

프로젝트와 기기는 사람의 로컬 세션이 등록하고(계약 4절), 돌려받은 에이전트 토큰이 이 연결의 유일한 자격이다. 토큰은 키 저장소(OS 키체인)에 둔다. `opencode_tui_launch_env({key_store, project_id})`는 OpenCode를 켜는 쪽이 부르는 함수로, `pes-agent-token-opencode_tui-<프로젝트 id>`를 **한 번 읽어(`get(ref)`)** `{PES_AGENT_TOKEN}`을 메모리로 돌려준다. 읽기만 하고 파일에는 쓰지 않으며, 없으면 `token_missing`(한국어 설명)이다. 돌려받은 값을 OpenCode를 켜는 프로세스의 환경변수 `PES_AGENT_TOKEN`에 넣는다. 키 저장소 구현은 PR19에서 오고 이 PR은 그것에 의존하지 않는다 — 그 전에는 사람이 환경변수로 직접 둔다.

## 한 번에 한 흐름

`pes_context` → `pes_claim` → `pes_ask` → `pes_wait` → `pes_claim`(`run_id`로 이어받기) → `pes_context`(`inputs`) → `pes_read` → `pes_submit` → `pes_complete`. 아래 예시는 시험이 이 도구의 연결로 그대로 실행한다.

```json pes-example
{
  "name": "opencode tui: claim, heartbeat, send one version and complete; a late heartbeat needs a new claim",
  "steps": [
    { "tool": "pes_context", "arguments": {}, "expect": "ok" },
    { "tool": "pes_claim", "arguments": { "idempotency_key": "oc-claim" }, "expect": "ok" },
    { "tool": "pes_heartbeat", "arguments": { "progress": { "phase": "started" }, "idempotency_key": "oc-hb" }, "expect": "ok" },
    {
      "tool": "pes_submit",
      "arguments": { "results": [{ "op": "append_version", "object_id": "${object_id}", "title": "OpenCode 예시 결과" }], "idempotency_key": "oc-results" },
      "expect": "ok"
    },
    { "tool": "pes_complete", "arguments": { "status": "succeeded", "idempotency_key": "oc-done" }, "expect": "ok" },
    { "tool": "pes_heartbeat", "arguments": { "progress": { "phase": "stage" }, "idempotency_key": "oc-late" }, "expect": "claim_required" }
  ]
}
```

## 재현 절차 (노트만 보고)

1. PES 로컬 서버를 켜고 프로젝트를 등록해 에이전트 토큰을 받는다(사람의 일).
2. 토큰을 키 저장소에 두거나 환경변수 `PES_AGENT_TOKEN`에 둔다.
3. 위 `pes-config` 예시를 `opencode.json`의 `mcp`에 넣는다. `/path/to/…`·`<프로젝트 id>`를 실제 값으로 바꾼다. 모델 이름은 Go 경로가 아닌 것만 적는다.
4. `PES_AGENT_TOKEN`이 들어 있는 환경에서 OpenCode TUI를 켜고, 첫 일로 `pes_context`를 부르게 한다.

## 미확인과 한계

- **미확인**: 실제 OpenCode TUI 세션에서 이 MCP 도구로 6단계를 돈 기록은 없다. 시험은 가짜 MCP 클라이언트와 합성 프로젝트로 같은 뜻을 확인하고, 설정 예시는 임시 폴더에 써서 읽어 본다. 이 저장소의 시험은 실제 `opencode`를 실행하지 않고 사용자의 OpenCode 설정 폴더를 읽거나 쓰지 않는다.
- **미확인**: OpenCode 버전마다 `{env:VAR}` 확장 범위(`mcp.*.environment` 안에서도 풀리는지), MCP 서버 시작 제한 시간, 긴 대기 중 연결 끊김 처리가 같은지 확인하지 않았다. 확장이 안 되면 서버가 토큰으로 글자 그대로 `{env:PES_AGENT_TOKEN}`을 받아 모든 호출이 `unauthenticated`로 거부된다 — 값을 설정 파일에 적어 해결하지 않는다.
- 모델과 사용량은 PES가 알 수 없어 `unknown`이다. Go 경로 사용을 PES가 막지 못하는 한계는 위 「Go 경로」 절에 있다.
