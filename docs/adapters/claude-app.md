# 어댑터 노트 — Claude 앱 (Claude Desktop)

중립 표기로 쓴 스킬·에이전트·명령 문서를 **Claude 앱**(Claude Desktop)에서 쓸 때의 차이를 적는다. 도구·스킬 이름이 Claude Code와 같은 부분은 [claude-code.md](claude-code.md)의 표를 따른다. Claude 전용 이름은 `docs/adapters/` 안에만 둔다.

## Claude Code와 같은 것

- 질문·승인은 로컬 대시보드와 질문 폼(웹)이 원본이다. 서버를 띄울 수 있으면 앱 안에서 고르게 하지 않는다.
- 상태는 pes 명령(`context`·`merge`·`submit`·`ask`·`note`·`qa` 등)으로만 읽고 쓴다. 앱에서도 프로젝트 상태 파일·업무 DB·잠금 파일을 직접 고치지 않는다.
- 서브에이전트 지침(`agents/reviewer.md` 등)과 결과를 제안 파일에 쓰는 규칙은 같다.

## 다른 것

| 항목 | Claude 앱에서 |
|---|---|
| 설치 | `/pes:setup`. Windows에서 git을 이번에 새로 설치했다면 Git Bash가 있어야 답 자동 수신이 되므로 Claude Desktop을 완전히 끄고 다시 연 뒤 `/pes:setup`을 다시 실행한다 |
| 답 대기 | 앱 환경에서 `Monitor`를 쓸 수 있는지 확인한다. 쓸 수 없으면 채팅으로 "답을 보냈다"는 말을 받은 뒤 `pending`으로 읽는다 |
| 사람에게 고르게 하기 | 질문 폼이 기본이고, 앱이 `AskUserQuestion`을 제공하면 서버를 띄울 수 없을 때만 쓴다 |
| 환경변수·키 | 앱의 설정 파일이나 설정 화면의 `env`에 사용자가 직접 등록한다. 값은 채팅에 다시 쓰지 않는다 |
| 서브에이전트 | 앱이 `Agent` 도구를 제공하는 설정에서만 reviewer·researcher를 띄운다 |
| 형식 변환 | 앱에 `anthropic-skills:*`가 설치되어 있어야 hwpx·docx·pdf·pptx를 만든다 |

## 명시적 전달: 앱이 PES에 접속하지 못해도 같은 일을 한다 (PR20a)

Claude 앱이 PES에 직접 접속하는 연결은 검증하지 않았다(아래 한계). 대신 **명시적 전달**로 한 번의 왕복을 같은 뜻으로 한다: 사람이 PES에서 묶음을 복사해 앱에 붙이고, 앱의 답을 PES에 붙여 가져온다. 구현은 `scripts/pes_core/adapters/claude_app.ts`, 공통 규칙은 [adapter-contract.md](adapter-contract.md) 6절이다.

1. **복사** — `export_bundle`이 묶음(JSON 글)을 만든다. 읽기뿐이라 실행도 lease도 행도 생기지 않고, 앱과 오래 이야기해도 만료되는 것이 없다. 묶음에는 프로젝트·판·단계·라운드·기반 버전·`control_rev`·요청 ID·`manifest_hash`와 앱에게 줄 안내(어떤 모양의 JSON으로 답할지)가 있다. 토큰·세션 비밀·lease는 없다.
2. **앱과 대화** — 앱이 안내대로 JSON 한 개로 답한다(`results`, 선택으로 `claimed`). 이 단계에서 PES에는 아무 일도 없다 — 복사는 제출이 아니다.
3. **가져오기** — 사람이 `import_result`로 묶음과 앱의 답을 PES에 붙인다. 소유자 세션이 이 행위를 승인한다.

가져온 결과는 앱이나 에이전트의 제출이 **아니라 사람(소유자)이 가져온 것**으로 남는다:

| 항목 | 값 |
|---|---|
| 실행 | 소유자 자신의 전달용 실행: `mode B`, `runtime = claude_app_handoff`, `provider = anthropic`, `model = unknown` |
| 영수증 행위자 · `adopted_by` | 소유자(사람) |
| 영수증 `via` | `import` (직접 MCP로 한 제출은 `mcp`가 아니라 에이전트 토큰의 `http`이고 행위자가 에이전트다) |
| 출처 표지 | `provenance = {source: manual_import, claimed_tool, claimed_model, verified: false}` — 앱이 말한 도구·모델은 주장일 뿐 믿지 않는다 |
| 에이전트 claim | 없다(`run.claimed` 사건 없음). 소유자는 이 가져오기가 만든 자기 실행에만 이 경로로 결과를 낸다. 일반 결과 제출 경로는 에이전트 토큰 전용 그대로다 |

거부는 모두 아무것도 쓰지 않는다: `bundle_invalid`, `bundle_hash_mismatch`(묶음 일부가 복사 뒤 바뀜), `bundle_wrong_project`, `bundle_stale`(복사 뒤 프로젝트나 기반 버전이 바뀜 — 다시 복사), `duplicate_import`(같은 묶음을 두 번 — 내용이 달라도), `result_out_of_scope`(묶음에 없는 자료), `attachment_missing`, `attachment_unsupported`. 거부된 묶음은 소모되지 않는다. **`manifest_hash`는 인증이 아니다** — 사고를 잡는 무결성 검사일 뿐이고 아무 권한도 주지 않는다.

## 한계 (아직 안 되는 것)

- **미확인**: Claude 앱 전용 연결(앱 안에서 프로젝트를 열고 닫는 흐름, 재접속 뒤 이어하기)은 아직 검증하지 않았다. 시험은 명시적 전달(복사→가져오기)로 한 번의 왕복·서버 재시작 뒤 이어서 가져오기·중복 가져오기 0·누가 제출했는가의 구분을 확인할 뿐이다. 앱이 지속 heartbeat를 한다고 가정하지 않는다. 이 노트는 확인된 동작이 아니라 Claude Code와의 차이를 적은 초안이다.
- 전달로 가져올 때는 첨부 파일을 저장하지 않는다(`attachment_unsupported`). 앱이 만든 파일은 사람이 PES에 따로 올린다.
- 서브에이전트 도구가 없으면 독립 검토를 메인이 대신하지 않는다. 사용자에게 알리고, `qa-brief`가 만든 지시문 파일을 다른 세션이 읽고 결과 파일을 쓰게 한 뒤 `qa`로 기록한다.
- 변환 스킬이나 `Monitor`가 없는 설정에서는 자동으로 대신해 주지 않는다. 필요한 만큼 사람이 직접 처리한다.
- 문서를 다른 환경 표기로 자동 변환하는 기능은 지원하지 않는다.
- `set`(단계 요약·변경점·남은 일·설정·점검, 최종 요약·결론)은 지금 옛 방식(v0.15) 프로젝트에서만 쓸 수 있다. DB 경로(`PES_DB_CORE=1`)에서는 대응 명령이 생길 때까지 한국어 이유와 함께 거부되고 아무것도 바뀌지 않는다 — 우회해서 다른 명령에 끼워 넣지 않는다.
- `context`·`claim`·`submit`·`wait`·`complete`는 DB 경로(`PES_DB_CORE=1`, 작업 토큰을 받은 작업자)에서만 동작한다. 기본 경로에서는 거부되므로 `status`·`digest`·`show`와 `pending`이 알려 준 답 파일(`feedback/*.json`)로 읽고, 결과는 `merge`로 낸다. DB 경로에서도 스킬의 제안 파일은 `merge`로 넘긴다 — `submit`은 DB 결과 형식(`op: append_version`, 이미 있는 `object_id`) 전용이다.
