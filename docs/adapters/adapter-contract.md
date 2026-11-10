# 어댑터 계약 — 방식 B (AI 도구가 PES에 접속해 일한다)

방식 B는 사람이 직접 켠 AI 도구(Claude Code, 뒤이어 Codex CLI·OpenCode TUI)가 PES의 로컬 API로 일하는 방식이다. 이 문서는 도구마다 달라지지 않는 **공통 계약**이다. 도구별 차이는 [claude-code.md](claude-code.md)·[claude-app.md](claude-app.md)에 적는다. 구현은 `scripts/pes_core/mcp_server.ts`(MCP 도구 10개)와 `scripts/pes_core/adapters/`다.

이 문서의 JSON 예시는 시험이 그대로 실행한다(「문서만 보고 재현」). 예시를 고치면 같은 PR에서 시험이 맞는지 확인한다.

## 1. 한눈에

- AI 도구는 **MCP 서버**가 내놓는 **닫힌 도구 10개**로만 PES에 쓴다. 승인·재개방·봉인·정책 바꾸기·프로젝트 등록·토큰 만들기 도구는 **없다** — 그것은 사람의 일이다.
- MCP 서버는 프로젝트 **에이전트 토큰**을 메모리에만 들고, 자기 API 호출의 `Authorization` 헤더에만 쓴다. 클라이언트로 돌려주는 어떤 답에도, 어떤 파일에도 토큰을 쓰지 않는다. 표준 출력에는 JSON-RPC 줄만 나간다.
- 무엇을 할 수 있는지는 PES API가 정한다(토큰 범위·소유자 세션·정책). 도구가 대신 판단하지 않는다. PES가 거부하면 도구 결과는 `isError: true`이고 내용은 API 오류 그대로다(`code`, 한국어 `message`, `retryable`, `target`, `next_action`).
- 결과 제출은 **승인이 아니다**. `pes_complete`도 단계를 승인하거나 봉인하지 않는다.

## 2. 도구 10개

모든 도구는 `pes_context`를 뺀 모두 `idempotency_key`(비어 있지 않은 문자열)를 받는다. API의 `Idempotency-Key`로 그대로 간다.

| 도구 | 하는 일 | API |
|---|---|---|
| `pes_context` | 현재 상태 읽기(`project_id`, `control_rev`, `digest`, 단계, 자료 목록, 현재 lease). 실행을 아는 경우 그 실행에 온 답을 `inputs` 배열로 덧붙인다. 읽기만 한다 | `GET /context`, `GET /runs/{r}/inputs` |
| `pes_claim` | 작업 시작(lease). `run_id`를 주면 기다리던 실행을 이어받고(새 fence), 없으면 서버 설정의 `runtime`·`provider`·`model`로 새 방식 B 실행을 만든다 | `POST /claims` |
| `pes_submit` | 결과(새 버전) 1~20개 제출 | `POST /runs/{r}/results` |
| `pes_ask` | 사람에게 질문 하나 | `POST /questions` |
| `pes_wait` | 사람의 답을 기다린다(`waiting_human`). lease를 내려놓는다 | `POST /runs/{r}/wait` |
| `pes_complete` | 실행 끝내기(`succeeded`/`failed`) | `POST /runs/{r}/complete` |
| `pes_heartbeat` | lease 연장 + 진행 알림 | `POST /runs/{r}/heartbeat` |
| `pes_release` | 실행을 대기열로 돌려놓고 lease를 내려놓는다 | `POST /runs/{r}/release` |
| `pes_cancel` | 자기 실행 취소. `confirm: true`가 있어야 한다 | `POST /runs/{r}/cancel` |
| `pes_receipt` | 받은 입력을 봤다/반영했다/무시했다는 영수증 | `POST /runs/{r}/input-receipts` |

### 2.1 `idempotency_key` 규칙 (claim_required와 함께)

- 같은 키 + 같은 인자 = 처음 답을 되돌려 준다(`replayed: true`, 새 행 없음).
- 같은 키 + 다른 인자 = `idempotency_key_reuse` (`next_action: use_new_key`).
- 키가 없거나 문자열이 아니면 `invalid_payload`, `target: "$.arguments.idempotency_key"`, `next_action: fix_request`. 단 이 입력 검사보다 **PES의 거부(자격·범위, 존재하지 않는 실행)가 먼저** 답한다. 이때 도구는 쓸 수 없는 형태의 요청(키 없음·빈 본문)으로 PES에 먼저 물어볼 뿐 아무것도 쓰지 않는다.

### 2.2 lease 묶음(guard)과 `claim_required`

서버는 마지막으로 성공한 claim의 `{run_id, lease_id, fence}`를 기억해, `pes_submit`·`pes_ask`·`pes_wait`·`pes_complete`·`pes_heartbeat`·`pes_release`·`pes_receipt`가 다시 받지 않게 한다. `run_id`·`lease_id`·`fence`를 직접 주면 기억한 값보다 우선한다 — **새로 연결한 서버가 이어서 일하는 방법**이다(`pes_context`로 현재 lease를 읽고 그 값을 직접 준다).

기억한 값도 직접 준 값도 없으면 `claim_required`(`next_action: claim`)다. `pes_wait`·`pes_complete`·`pes_release`·`pes_cancel`은 성공하면 기억한 lease를 잊는다. 그 뒤 `pes_claim`으로 이어받으면 fence가 올라가므로 옛 fence로 쓰는 다른 연결은 `conflict`/`lease_lost`로 거부된다.

### 2.3 진행·스케줄 알림 — 하나의 형식

시작·단계 전환·완료·실패·대기·예정된 일은 모두 `pes_heartbeat`의 `progress.phase`다. 도구도, 결과 모양도, 사건 종류(`run.heartbeat`)도, 멱등 규칙도 같다. `phase`는 닫힌 목록이다.

`started`, `stage`, `completed`, `failed`, `waiting`, `scheduled`

`observed_at`(ms)을 생략하면 명령 시계가 채워 저장한다. 결과는 `{run_id, lease: {lease_id, fence, expires_at}, progress: {phase, observed_at}, server_time}`이고 `progress`는 **저장된 값 그대로**다(재전송이면 처음 값). 사건 `run.heartbeat`의 `progress`와 같다. 목록 밖 `phase`는 `invalid_payload`(`target: "$.arguments.progress.phase"`)다. 같은 키의 재전송은 새 사건을 만들지 않는다.

### 2.4 영수증과 `applied_by_key`

`pes_receipt`의 `receipts`는 `[{input_version_id, state, reason?, applied_by_key?}]`다. `state`가 `applied`이면 그 입력을 쓴 `pes_submit`의 `idempotency_key`를 `applied_by_key`로 준다. 어댑터가 그 키의 제출 기록을 읽어 API가 요구하는 `applied_tx_id`를 채운다. **증거는 결과 제출(`pes_submit`)의 키뿐이다**: heartbeat·ask·wait·claim 같은 다른 도구의 키는 `not_found`다. 또 그 제출은 **이 실행의 것**이어야 한다(같은 에이전트의 다른 실행의 제출 키도 `not_found`). 모르는 키도 `not_found`이고 아무것도 쓰지 않는다.

## 3. 실행해 보는 예시

한 연결의 처음 흐름이다. `${object_id}`·`${stage_plan}`·`${round_id}`는 시험이 합성 프로젝트의 값으로 바꾼다.

```json pes-example
{
  "name": "claim, ask, wait: the first round of one connection",
  "steps": [
    { "tool": "pes_context", "arguments": {}, "expect": "ok" },
    { "tool": "pes_claim", "arguments": { "idempotency_key": "doc-claim" }, "expect": "ok" },
    {
      "tool": "pes_ask",
      "arguments": {
        "stage_id": "${stage_plan}",
        "round_id": "${round_id}",
        "purpose": "review",
        "form_key": "doc-form",
        "question": { "text": "문서 예시 질문", "type": "text" },
        "idempotency_key": "doc-ask"
      },
      "expect": "ok"
    },
    { "tool": "pes_wait", "arguments": { "idempotency_key": "doc-wait" }, "expect": "ok" },
    { "tool": "pes_submit", "arguments": { "results": [], "idempotency_key": "doc-after-wait" }, "expect": "claim_required" }
  ]
}
```

제출과 진행 알림, 끝내기까지의 흐름이다.

```json pes-example
{
  "name": "results, heartbeat and complete; reuse of the same key",
  "steps": [
    { "tool": "pes_claim", "arguments": { "idempotency_key": "doc2-claim" }, "expect": "ok" },
    { "tool": "pes_heartbeat", "arguments": { "progress": { "phase": "started" }, "idempotency_key": "doc2-hb" }, "expect": "ok" },
    {
      "tool": "pes_submit",
      "arguments": {
        "results": [{ "op": "append_version", "object_id": "${object_id}", "title": "문서 예시 결과" }],
        "idempotency_key": "doc2-results"
      },
      "expect": "ok"
    },
    {
      "tool": "pes_submit",
      "arguments": {
        "results": [{ "op": "append_version", "object_id": "${object_id}", "title": "다른 내용" }],
        "idempotency_key": "doc2-results"
      },
      "expect": "idempotency_key_reuse"
    },
    { "tool": "pes_heartbeat", "arguments": { "progress": { "phase": "thinking" }, "idempotency_key": "doc2-hb-bad" }, "expect": "invalid_payload" },
    { "tool": "pes_complete", "arguments": { "status": "succeeded", "idempotency_key": "doc2-done" }, "expect": "ok" }
  ]
}
```

## 4. 처음 등록 (빈 계정)

프로젝트와 기기는 **사람의 로컬 세션**이 `POST /api/v1/project-registrations`로 만든다(PR14). 돌려받은 기기 토큰이 MCP 서버에 주는 **유일한 자격**이고, 그 프로젝트에서만 통한다. AI 도구에는 등록 도구가 없고, 에이전트 토큰으로 등록 경로를 부르면 `unauthenticated`다. 소유자 세션 비밀은 MCP 서버·번들·어떤 도구 결과에도 실리지 않는다.

## 5. 설정 항목과 pes link / pes sync 로컬 계약

MCP 서버는 환경변수로 설정한다.

| 변수 | 뜻 |
|---|---|
| `PES_PROJECT_ID` | 일할 프로젝트 |
| `PES_API_BASE_URL` | 이 컴퓨터의 PES 서버 주소(루프백 `http://127.0.0.1:…`만 받는다) |
| `PES_AGENT_TOKEN` | 에이전트 토큰. 설정 파일에는 **참조**(`${PES_AGENT_TOKEN}`)만 적고 값은 사용자의 환경에 둔다 |
| `PES_RUNTIME`·`PES_PROVIDER`·`PES_MODEL` | 새 claim이 쓰는 실행기 표시. 서버는 도구를 짐작하지 않는다: 안 정하면 `mcp`·`unknown`·`unknown`이다. 연결 항목을 만드는 어댑터가 명시한다(Claude Code: `PES_RUNTIME=claude_code`, `PES_PROVIDER=anthropic`). 모델은 알 수 없으면 `unknown` |

pes link와 pes sync는 도우미(helper)가 이 컴퓨터에서 쓰는 **로컬 계약**이다. 도우미는 AI 도구의 MCP 자격과 **다른 종류**(`helper_device`)의 자격을 갖는다. link 응답에는 에이전트 토큰이 없다. sync는 커서를 요청과 응답 양쪽에 싣고, 같은 커서로 다시 보내면 같은 결과를 준다. 이 두 명령의 CLI 구현은 이 PR의 범위 밖이다. 아래는 **초안 계약**으로, 이미 있는 API에 이렇게 대응시킨다. 대응이 없는 부분은 구현 PR에서 확정한다.

- **link** — 자격은 사람의 로컬 세션이 `POST /api/v1/project-registrations`(최초 등록)로 발급한다. 그 응답의 기기 토큰이 `helper_device` 자격이며 한 프로젝트에서만 통한다. link 응답에는 토큰 값이 없고 `mcp_credential: reference_only`(설정에는 참조만)다. 같은 `Idempotency-Key`는 같은 답을 되돌려 주되 토큰은 다시 주지 않는다(`token_issued_before`). 오류는 API 코드 그대로(`unauthenticated`, `idempotency_key_reuse`, `invalid_payload`). *확정 전*: 이미 등록된 프로젝트에 기기를 더하는 경로는 이 API에 아직 없고 구현 PR에서 정한다.
- **sync** — `GET /api/v1/projects/{id}/changes?cursor=`에 대응한다. 커서는 불투명 문자열이고 같은 커서는 같은 결과를 준다(읽기, 멱등). 커서가 이 프로젝트·이 자격의 것이 아니거나 형식이 틀리면 `cursor_invalid`다. DB 인스턴스나 `epoch`가 바뀌면 `cursor_invalid`(`reason`: `database_changed`·`epoch_changed`)로 처음부터 다시 받는다(`cursor: null`). 응답의 `epoch`를 기억해 둔다. *확정 전*: 응답 필드 이름(`events` 개수)은 구현 PR에서 `/changes` 응답에 맞춘다.

```json pes-link-example
{
  "command": "pes link",
  "request": { "project": "synthetic-project", "device_label": "합성 기기", "tool": "claude_code" },
  "response": { "credential_kind": "helper_device", "project_id": "synthetic-project-id", "device_id": "synthetic-device-id", "mcp_credential": "reference_only" }
}
```

```json pes-sync-example
{
  "command": "pes sync",
  "request": { "project": "synthetic-project", "cursor": null },
  "response": { "cursor": "synthetic-cursor-1", "events": 0, "has_more": false }
}
```

## 6. 명시적 전달 (앱이 PES에 접속하지 못할 때)

도구가 PES에 접속하지 못하는 앱은 **복사 → 앱과 대화 → 붙여넣기**로 같은 일을 한다. 앱은 에이전트가 아니다. 가져온 결과는 **사람(소유자)이 가져온 것**으로 기록한다. 자세한 규칙과 한계는 [claude-app.md](claude-app.md).

- 복사(묶음 만들기)는 **읽기뿐**이다. 실행도 lease도 행도 만들지 않는다. 그동안 시간이 아무리 지나도 만료되는 것이 없다. 묶음에는 프로젝트·판·단계·라운드·기반 버전·`control_rev`·요청 ID·`manifest_hash`가 들어 있고 토큰·세션·lease는 없다.
- **hash는 인증이 아니다.** `manifest_hash`는 복사한 뒤 일부만 바뀐 묶음 같은 사고를 잡는 무결성 검사일 뿐이고, 아무 권한도 주지 않는다. 누가 보냈는지 증명하지 않는다. 권한은 소유자 세션을 PES가 검사해서 얻는다.
- 가져오기는 소유자의 한 번의 행위다: 소유자 자신의 전달용 실행(`runtime = claude_app_handoff`, `model = unknown`)을 만들고 결과를 붙이고 끝낸다. 에이전트 claim은 없다(`run.claimed` 사건 없음). 영수증의 행위자와 `adopted_by`는 소유자, `via`는 `import`, 출처 표지는 `provenance.verified = false`다. 붙여 넣은 글이 말하는 도구·모델은 **주장**으로만 남고 믿지 않는다.
- 같은 묶음(요청 ID)은 한 번만 가져온다: 다시 가져오면 내용이 달라도 `duplicate_import`, 행 0개. 거부된 가져오기는 묶음을 쓰지 않은 것이다 — 붙여 넣은 글을 고친 뒤 같은 묶음으로 다시 할 수 있다.
- 거부 코드: `bundle_invalid`, `bundle_hash_mismatch`, `bundle_wrong_project`, `bundle_stale`(복사한 뒤 `control_rev`나 기반 버전이 바뀜), `duplicate_import`, `result_out_of_scope`, `attachment_missing`, `attachment_unsupported`. PES가 거부하면 API 코드(`unauthenticated`, `forbidden` 등)를 그대로 쓴다. 특히:
  - `conflict` — 승인된 단계, 또는 봉인된 라운드(지정한 라운드, 또는 라운드를 안 줬을 때 단계의 현재 라운드). 승인·봉인은 사람의 결정이라 가져오기가 우회하지 못한다. 승인된 단계는 복사도 `conflict`다. 사람이 단계를 다시 열고(봉인이면 새 라운드) 묶음을 다시 복사한다.
  - `invalid_payload` — 한 가져오기가 같은 자료(object)를 둘 이상 말한다(묶음 하나는 한 자료를 한 번만 고친다). 가져오기 멱등 키가 `import-<request_id>`가 아닌 경우도 같다(`$.headers.idempotency-key`) — 서버가 이 키를 강제해 같은 묶음이 두 번 들어오지 못한다.
  - 거부는 모두 쓰기 0이다.
- 묶음의 `base_versions`는 프로젝트 전체의 보조 자료 머리 버전이다(자료가 단계에 묶여 있지 않아 좁히지 못한다 — 한계). 가져올 때 같은 판·같은 단계인지 어댑터가 다시 본다.

## 7. 미확인과 한계

- **미확인**: 실제 Claude Code 세션, 실제 Claude 앱 연결은 이 저장소의 시험이 확인하지 않았다. 시험은 가짜 MCP 클라이언트(JSON-RPC 줄)와 합성 프로젝트로 같은 뜻을 확인한다. 실제 도구가 MCP 설정을 읽는 방식, 도구 호출 중 연결이 끊겼을 때의 동작은 사용 보고가 쌓이면 이 문서에 적는다.
- 앱은 지속 heartbeat를 하지 않는다고 가정한다. 전달에는 lease가 없다.
- 가져오기는 첨부 파일을 저장하지 않는다(`attachment_unsupported`).
- 모델·사용량을 모르면 `unknown`으로 둔다. 추정해서 채우지 않는다.
- MCP 서버가 쓸 수 있는 것은 에이전트 토큰의 범위 안뿐이다. 범위가 모자라면 PES가 `forbidden`으로 거부한다.
