# 어댑터 노트 — OpenCode TUI (방식 B)

사람이 터미널에서 직접 켠 **OpenCode TUI**(화면판)가 PES의 로컬 API로 일하게 하는 길이다. 공통 계약(도구 11개, `idempotency_key`, 진행 알림 형식, 오류)은 [adapter-contract.md](adapter-contract.md)이고, 여기에는 OpenCode TUI만의 부분을 적는다. 문서 변환·스킬 대응에 대한 옛 노트는 [opencode.md](opencode.md)이고, 이 노트는 MCP 연결만 다룬다.

## OpenCode TUI는 내장 실행기가 아니다

- **방식 A(내장 실행기, `pes_builtin`)와 다르다.** 내장 실행기는 PES가 직접 Go API를 부르고 구독 사용량을 센다. OpenCode TUI는 사람이 직접 켠 화면이고, 모델을 고르고 부르는 것은 OpenCode다. PES는 그 사용량을 보지도 막지도 못한다. 둘을 같은 이름으로 섞지 않는다.
- 둘은 프로젝트의 lease 하나를 나눠 쓴다. 한쪽이 잡고 있으면 다른 쪽의 시작은 `conflict`로 거부되고 아무것도 쓰지 않는다. B 연결은 방식 A 실행을 만들 수 없다.
- 승인·재개방·봉인·정책·등록·토큰·삭제·export 도구는 없다.

## Go 경로: 차단과 한계

Go 구독(`opencode-go/…` 모델)의 계량·한도는 방식 A만 다룬다. 그래서:

- **차단**: `opencode_tui_mcp_entry`는 모델이 Go 경로(`opencode-go` 또는 `opencode-go/…`)이면 `go_route_blocked`(한국어 설명)로 연결 항목 만들기를 거부한다. 판정 전에 모델 이름을 풀어 읽는다: 대소문자, 전각 문자(유니코드 NFKC), 보이지 않는 서식 문자(너비 0 공백·소프트 하이픈·BOM·방향 바꿈 문자), 하이픈 비슷한 문자·밑줄·공백(`opencode_go/x`, `opencode go/x`)을 같은 구분자로 본다. 공백이나 서식 문자가 든 모델 이름은 Go가 아니어도 거부한다. 연결 항목에는 Go 경로 이름이 들어가지 않는다. 다른 문자 체계의 비슷한 글자(예: 키릴 문자 о)로 흉내 낸 이름은 풀지 못한다 — 아래 한계에 포함된다.
- **한계**: 이 차단은 연결 항목에 *적는* 모델 이름만 검사하고, 키릴 문자 같은 다른 문자 체계의 비슷한 글자로 흉내 낸 이름은 가려내지 못한다. 사람이 OpenCode 안에서 Go 모델을 골라 쓰는 것을 PES는 보지도 막지도 못하며, 그 사용량은 Go 계량에 잡히지 않는다. B 실행의 provider는 `unknown`, model은 사람이 알려 주지 않으면 `unknown`이다.
- Go 모델을 PES가 관리하는 한도 안에서 쓰려면 방식 A를 쓴다.

## 연결 항목

`scripts/pes_core/adapters/opencode_tui.ts`의 `opencode_tui_mcp_entry`가 `opencode.json`의 `mcp.servers.pes` 항목을 만든다(OpenCode 공식 문서의 현행 형식, 아래 「설정 형식」). 파일을 읽지도 쓰지도 않고 프로세스도 띄우지 않으니 설정 파일에 넣는 것은 사용자가 한다. `command`는 node 실행 파일 경로를 그대로 준다(`which`로 찾지 않는다). `<프로젝트 id>`는 등록한 프로젝트의 id로 바꾼다.

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
          "PES_RUNTIME": "opencode_tui",
          "PES_PROVIDER": "unknown",
          "PES_MODEL": "unknown",
          "PES_AGENT_TOKEN": "{env:PES_AGENT_TOKEN}"
        }
      }
    }
  }
}
```

- **설정 형식**: OpenCode 공식 문서(opencode.ai의 MCP servers·Config 쪽, 2026-11-11 확인)는 서버 이름을 `mcp.servers` 밑에 두라고 하고("V2는 서버 이름을 `mcp` 바로 밑에 두지 않는다"), 켜고 끄는 항목은 `enabled`가 아니라 `disabled`(기본 거짓)다. 그래서 예시에 `enabled`는 없고 서버는 기본으로 켜진다. 옛 형식(`mcp.pes` + `enabled: true`)은 OpenCode의 JSON 스키마에 `deprecated`로 남아 아직 받아들여지지만 이 노트와 어댑터는 현행 형식만 만든다. 구버전 OpenCode가 `mcp.servers`를 모르면 옛 형식으로 옮겨 적어야 하며, 그 경우 어댑터의 출력이 아니라 사람이 옮긴 것이다(미확인: 어느 버전부터 현행 형식인지).
- **호출 제한 시간**: `pes_wait`는 한 번에 최대 25초 기다린다. 현행 형식의 서버별 `timeout`은 객체(`startup`·`catalog`·`execution`, 정수 밀리초)이고 `execution` 기본이 12시간이라 예시에 따로 적지 않았다. **옛 형식의 `timeout`은 정수 밀리초이고 기본 5000(5초)**이라 `pes_wait`가 끊기므로 옛 형식으로 옮길 때는 `timeout`을 30000 이상으로 적는다.
- **토큰은 참조로만**: OpenCode는 `{env:PES_AGENT_TOKEN}`을 시작한 환경의 변수로 채운다. 값은 `opencode.json`에 적지 않는다.
- **실행 표시**: `PES_RUNTIME=opencode_tui`. OpenCode는 여러 제공자를 쓰므로 `PES_PROVIDER`는 `unknown`이고, 모델도 PES에 알려 주지 않으므로 `unknown`이다. 사용량은 B 실행에 기록하지 않는다.
- **주소**: `PES_API_BASE_URL`은 이 컴퓨터의 루프백 `http` 주소만 받는다.
- **입력 규칙**: `command`·`server_script`·`project_id`·`model`에는 줄바꿈·탭·NUL·DEL·U+2028/2029 같은 제어 문자를 쓸 수 없다(공백·따옴표는 경로의 일부라 그대로 둔다). 네 값에 `{env:…}`·`{file:…}` 같은 설정 치환 표기가 있어도 거부한다. `api_base_url`은 `http://127.0.0.1:8760` 꼴의 루프백 origin(`127.0.0.1`·`localhost`·`[::1]`)만 받고, 사용자 정보·경로·쿼리·조각·역슬래시·앞뒤 공백이 있으면 거부하며, 항목에는 정규화한 origin을 적는다. 거부는 모두 고정 `code`(`field_invalid`·`substitution_blocked`·`api_base_url_invalid`)와 한국어 설명의 `TypeError`이고 값을 되풀이하지 않는다. OpenCode는 설정의 JSON 문자열 값 안에서 `{env:…}`·`{file:…}`를 풀기 때문에(공식 문서) 이 거부가 특히 중요하다 — 항목에 들어가는 치환은 토큰 참조 하나뿐이다.

## 토큰 받기

프로젝트와 기기는 사람의 로컬 세션이 등록하고(계약 4절), 돌려받은 에이전트 토큰이 이 연결의 유일한 자격이다. OpenCode를 켜는 프로세스의 환경변수 `PES_AGENT_TOKEN`에 그 토큰이 있어야 한다 — 값을 채팅에 다시 쓰지 않는다. `opencode_tui_launch_env({key_store, project_id})`는 그 값을 키 저장소에서 가져오는 함수다: 키 저장소(PR19의 `KeyStore`, `scripts/pes_core/a_runtime/keystore.ts`)에서 `pes-agent-token-opencode_tui-<프로젝트 id>`를 **한 번 읽어(`get(ref)`)** `{PES_AGENT_TOKEN}`을 메모리로 돌려준다. 읽기만 하고 파일에는 쓰지 않으며, 없으면 `token_missing`(한국어 설명)이다.

**한계**: 지금 PES에는 에이전트 토큰을 키 저장소의 `pes-agent-token-…` 항목으로 넣는 명령이 **없다**(PR19의 키 저장소는 AI 연결 키용이다). 토큰을 키 저장소에 두는 길은 후속이다. 지금 쓸 수 있는 절차는 하나다: 등록으로 받은 토큰을 사람이 직접 OpenCode를 켜는 셸의 환경변수 `PES_AGENT_TOKEN`으로 둔다. 토큰을 받는 PES 명령도 아직 없다(계약 5절의 pes link는 초안이다). 있는 것은 계약 4절의 등록 API뿐이다.

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
2. 받은 토큰을 OpenCode를 켤 셸의 환경변수 `PES_AGENT_TOKEN`에 둔다(키 저장소에 넣는 명령은 아직 없다 — 「토큰 받기」).
3. 위 `pes-config` 예시를 `opencode.json`에 넣는다. `/path/to/…`·`<프로젝트 id>`를 실제 값으로 바꾼다. 모델 이름은 Go 경로가 아닌 것만 적는다. 어댑터는 객체만 돌려주고 JSON으로 적는 것은 사람의 몫이다: Windows 경로(`C:\…`)는 JSON 문자열에서 역슬래시를 두 번(`C:\\…`) 적는다.
4. `PES_AGENT_TOKEN`이 들어 있는 환경에서 OpenCode TUI를 켜고, 첫 일로 `pes_context`를 부르게 한다.

## 미확인과 한계

- **미확인**: 실제 OpenCode TUI 세션에서 이 MCP 도구로 6단계를 돈 기록은 없다. 시험은 가짜 MCP 클라이언트와 합성 프로젝트로 같은 뜻을 확인하고, 설정 예시는 임시 폴더에 써서 읽어 본다. 이 저장소의 시험은 실제 `opencode`를 실행하지 않고 사용자의 OpenCode 설정 폴더를 읽거나 쓰지 않는다.
- **미확인**: OpenCode 버전마다 설정 형식(`mcp.servers`가 되는 버전), `{env:VAR}`가 `environment` 값 안에서도 풀리는지, 긴 대기 중 연결 끊김 처리가 같은지 확인하지 않았다. 공식 문서에 따르면 정해지지 않은 환경변수는 빈 문자열로 바뀌므로, `PES_AGENT_TOKEN`이 OpenCode를 켠 환경에 없으면 서버가 "환경변수가 필요합니다"라고 알리고 시작하지 않는다(종료 코드 2). 글자 그대로 `{env:PES_AGENT_TOKEN}`이 서버에 닿는 것은 확장을 아예 하지 않는 구버전뿐이고, 그때는 토큰이 틀려 `unauthenticated`로 거부된다 — 값을 설정 파일에 적어 해결하지 않는다.
- 모델과 사용량은 PES가 알 수 없어 `unknown`이다. Go 경로 사용을 PES가 막지 못하는 한계는 위 「Go 경로」 절에 있다.
