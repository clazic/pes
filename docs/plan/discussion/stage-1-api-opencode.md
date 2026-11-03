# 1단계 ② API 형식 — OpenCode 의견

- 작성: 2026-11-04, OpenCode (`opencode-go/deepseek-v4.1-flash`), Linear **SEL-22**
- 입력: `docs/plan/00-brief.md`, `docs/plan/stage-0.md`, `docs/plan/stage-1-db.md`(2·8·10·11절), `docs/plan/schemas/stage-1-ddl-draft.sql`, `docs/plan/research/notion-linear.md`, `docs/plan/research/webmcp.md`, `docs/plan/discussion/stage-0-opencode.md` 3.14~3.16·4절
- 범위: API 계약 의견. 코드를 고치지 않는다. 실제 `~/pes-projects`·`~/.pes/`는 읽지 않았다.
- 이미 정해진 것: stage-0 7절, stage-1-db 2절 결정 17개. 다시 정하지 않는다.
- 아래 `DDL:`은 `docs/plan/schemas/stage-1-ddl-draft.sql`을 가리킨다.

---

## 0. 한 장 요약

1. **HTTP/JSON이 정본**이다. MCP·CLI·WebMCP는 그 위의 얇은 어댑터다. A의 OpenCode 세션도 같은 PES API를 쓴다.
2. **PES API(에이전트↔PES)와 OpenCode 서버 API(PES A 어댑터↔OpenCode)를 분리**한다. B는 OpenCode를 모른다.
3. 모든 쓰기는 `mutation_commits` 영수증 + 같은 트랜잭션 `events`를 남긴다. `Idempotency-Key`, `base_control_rev`, `lease_id`+`fence`를 검사하고 **0행이면 실패**다.
4. `context`는 digest+대상 버전만 준다. 전체 프로젝트를 밀어 넣지 않는다.
5. claim은 run 생성+lease 획득을 한 묶음으로, 질문을 올리면 lease를 놓고 `waiting_human`으로 간다. 답은 inbox long-poll로 받는다.
6. 승인·reopen·판 시작·정책 변경은 **사람만**. 에이전트 토큰·WebMCP에는 이 동작을 주지 않는다.
7. 변경분은 `event_seq`+`cursor_epoch` 커서로 받는다. 복원·이전 뒤 커서가 무효면 전체 재동기화한다.
8. Go OFF는 새 전송 차단 + prepared 차단 + in-flight interrupt 시도 + sent/unknown 기록. 자동 재시작은 없다.
9. Linear·Notion은 **한 방향 내보내기만**. PES가 원본이고, Notion 글 조각 첨언 왕복은 지원하지 않는다.
10. **2단계 22개 PR 유지**. API 작업은 기존 PR에 붙고, WebMCP(3단계)·외부 내보내기(6단계)만 새 PR이다.

---

## 1. 원칙과 API 표면

| 원칙 | 내용 | 근거 |
|---|---|---|
| 쓰기 경로 하나 | API·CLI 모두 같은 검증 서비스와 `mutation_commits`를 지난다 | `stage-0.md:12-14`, DDL `:79-111` |
| 에이전트는 상태를 직접 쓰지 않는다 | 결과·질문·답·메시지만 제출; PES가 버전·이벤트·상태를 만든다 | `stage-0.md:12-14` |
| A/B 같은 계약 | `runs.mode`·`runtime`만 다르고 endpoint·payload는 같다 | `stage-1-db.md:136-144` |
| 현재값+버전 | 응답은 `object_id`+`version_id`를 준다 | `stage-1-db.md:26`, DDL `:275-331` |
| 사람 승인 분리 | 승인·reopen·판 시작·정책 변경은 human session만 | `stage-1-db.md:29-31`, DDL `:252-273` |
| 얇은 어댑터 | MCP/WebMCP/CLI는 HTTP를 감싸기만 한다 | `stage-0-opencode.md:678-717` |

**공통 형식**: `/api/v1`, `application/json; charset=utf-8`, UTC epoch ms 정수(`stage-1-db.md:38`), `snake_case`, 불투명 ID. 응답 `meta` = `{api_version:"1.0", schema_version:1, event_seq, cursor_epoch, request_id}`. `schema_version`은 `db_meta`(`DDL:950-955`), `workflow_version`은 `runs`(`:842`). 필드 추가는 minor, 삭제·의미 변경은 `/v2`. 클라이언트는 모르는 응답 필드를 무시하고, 중첩 mutation 객체의 모르는 필드는 거부한다.

| Method | Path | Auth | 목적 |
|---|---|---|---|
| GET | `/projects/{id}/summary` | `project:read` | 요약·현재 판/단계·정책·lease·미답 수 |
| GET | `/projects/{id}/context` | `project:read` | digest+targets+질문+정책+커서 |
| POST | `/projects/{id}/runs` | `run:create` | run 생성(`claim:true`면 lease까지) |
| POST | `/runs/{id}/claim` | `run:claim` | 재개·인계 후 lease 획득 |
| POST | `/runs/{id}/heartbeat` | `lease:heartbeat` | lease 연장(rev 불변) |
| POST | `/runs/{id}/results` | `run:submit` | 결과 배치 제출 |
| POST | `/projects/{id}/blobs` | `run:submit` | 첨부 staging 업로드(해시 확인) |
| POST | `/runs/{id}/questions` | `question:ask` | 사람에게 질문, lease 해제 |
| POST | `/runs/{id}/answers` | `answer:write` | 사람→AI 질문에 답 |
| GET | `/runs/{id}/inbox` | `run:claim` | 답·질문·메시지 long-poll |
| POST | `/runs/{id}/pause` | `run:pause` | `waiting_human`/`interrupted` |
| POST | `/runs/{id}/complete` | `run:complete` | run 종료(승인 아님) |
| POST | `/runs/{id}/cancel` | `run:complete` | 취소·lease 해제 |
| POST | `/runs/{id}/handoff` | human only | run 인계(fence 증가) |
| GET | `/changes` | `project:read` | `event_seq` 이후 변경분 |
| POST | `/questions` | **human session** | 사람→AI 질문(`human_to_agent`) |
| POST | `/submissions` | **human session** | 질문 세트 답 제출 |
| POST | `/stages/{id}/approve` | **human only** | 승인(`approvals`) |
| POST | `/stages/{id}/reopen` | **human only** | 다시 열기 |
| PUT | `/projects/{id}/policy` | **owner human** | Go 전송 정책 |
| POST | `/projects/{id}/tokens` | **owner human** | 에이전트 토큰 발급 |
| POST | `/threads`, `/threads/{id}/messages` | `message:write` | 첨언·대화 |
| POST | `/exports` | **human only** | Linear/Notion 한 방향(6단계) |

**핵심 요청·응답 예**

```json
POST /api/v1/projects/01J.../runs        Idempotency-Key: 7f3c...
{"mode":"B","edition_id":"01J...","stage_id":"01J...","round_id":"01J...",
 "role":"worker","runtime":"claude_code","model":"claude-sonnet-...",
 "targets":[{"object_id":"01J...","base_version_id":"01J..."}],
 "base_control_rev":12,"claim":true}

200 OK
{"data":{"run_id":"01J...","status":"running",
  "lease":{"lease_id":"01J...","fence":7,"expires_at":1762300000000},
  "context":{...}},
 "meta":{"api_version":"1.0","schema_version":1,"event_seq":123,"cursor_epoch":1,
         "request_id":"req_..."}}
```

```json
POST /api/v1/runs/01J.../results        Idempotency-Key: 9a1b...
{"lease_id":"01J...","fence":7,"base_control_rev":12,
 "results":[{"object_id":"01J...","base_version_id":"01J...",
   "summary":"...","body_md":"...","status":"done",
   "sources":[{"kind":"web","url":"...","method":"browser"}],
   "stats":[{"name":"...","value":"...","unit":"..."}]}]}
```

```json
409 Conflict
{"error":{"code":"rev_conflict","message":"다른 변경이 먼저 반영되었습니다.",
  "retryable":false,
  "details":{"expected_control_rev":12,"current_control_rev":14,
             "current_version_id":"01J..."},
  "request_id":"req_...","event_seq":130}}
```

**오류 봉투**: `{"error":{"code","message","retryable","details","request_id","event_seq"}}`. 상태: 400/401/403/404/409/410/413/422/429/503. 코드는 `invalid_request`, `unauthorized`, `forbidden`, `human_only`, `policy_blocked`, `out_of_scope`, `not_found`, `rev_conflict`, `lease_held`, `lease_lost`, `state_conflict`, `run_not_active`, `idempotency_conflict`, `cursor_epoch_mismatch`, `payload_too_large`, `validation_failed`, `rate_limited`, `unavailable`.

---

## 2. 주제 목록

| # | 주제 | 정하는 것 |
|---|---|---|
| 1 | API 경계·버전 | PES API vs OpenCode API, `/api/v1`, api/schema/workflow version |
| 2 | 인증·actor·토큰 | Bearer+human session, actor 종류, scope |
| 3 | 맥락 읽기 | digest+targets, 정책·lease·질문·커서 |
| 4 | claim·lease·heartbeat | run+lease, fence, TTL, 인계 |
| 5 | submit | 결과 배치, base version, 원자성 |
| 6 | 질문·답·inbox | ask, wait, answer, `__other`/의견 |
| 7 | complete·pause·resume·handoff·cancel | run 종료≠승인, lease 해제, 재개 |
| 8 | 멱등·0행·rev·오류 | `Idempotency-Key`, 조건부 UPDATE, error |
| 9 | 변경분 커서 | `event_seq`+`cursor_epoch`, tx 묶음 |
| 10 | 사람만 approve/reopen | human-only, 역할, 감사 |
| 11 | A와 OpenCode 서버 API | 세션 수명·prompt·interrupt·permission |
| 12 | B용 MCP | 6도구, HTTP 1:1, Claude Code/앱 |
| 13 | WebMCP 노출표 | 동작별 가능/불가·위험도 |
| 14 | Linear/Notion 한 방향 | export, PES 원본, 왕복 금지 |
| 15 | Go OFF in-flight | prepared 차단, 취소, sent/unknown |

---

## 3. 주제별 논의

### 3.1 API 경계·형식 버전

- **정할 것**: PES API와 OpenCode 서버 API의 경계, URL/응답/DB/workflow 버전, 하위 호환.
- **선택지**: ① 단일 `/api`+헤더 버전 ② **`/api/v1`+`meta` 버전** ③ GraphQL/RPC 단일 endpoint.
- **판단 기준**: 웹·A·B·MCP가 같은 계약을 쓰는가, DB와 API를 따로 배포할 수 있는가, OpenCode 변경이 PES로 새지 않는가.
- **추천**: ②. `/api/v1`, `meta.api_version/schema_version`, `runs.workflow_version`. `schema_version`은 `db_meta`(`DDL:950-955`), `workflow_version`은 `runs`(`:842`). OpenCode API는 `/openapi.json`으로 기능 감지하고 A 어댑터 안에서만 흡수한다(`stage-0-opencode.md:631-676`). 이유: 경로 버전이 디버깅이 쉽고, DB 스키마와 API 버전을 분리해야 2단계·5단계 배포가 독립적이다.

### 3.2 인증·actor·토큰 범위

- **정할 것**: 에이전트 Bearer와 사람 세션, `actors.kind`, `on_behalf_of_user_id`, scope, 만료·회수.
- **선택지**: ① 모든 호출 같은 토큰 ② **에이전트 프로젝트 토큰+사람 세션** ③ 에이전트도 사람 세션 공유.
- **판단 기준**: 에이전트가 승인·reopen·정책 변경을 못 하는가, actor가 모든 기록에 남는가, 토큰 원문이 DB·로그에 없는가, 5단계 로그인으로 확장되는가.
- **추천**: ②. `Authorization: Bearer pes_...`; `agent_tokens`에는 `token_hash`·`scopes`·`expires_at`·`revoked_at`만(`DDL:66-77`). scope는 `project:read`, `object:read`, `run:create/claim/submit/complete/pause`, `lease:heartbeat`, `question:ask`, `answer:write`, `message:write`. **금지**: `stage:approve/reopen`, `edition:start`, `policy:write`, `token:create`, `member:write`, `project:delete`, `export:create`. actor는 본문이 아니라 토큰/세션에서 서버가 정하고 `mutation_commits.actor_id`/`on_behalf_of_user_id`에 남긴다(`DDL:79-111`). A=`internal_ai/opencode/opencode-go`, B=`external_agent/claude_code|claude_app`, WebMCP=`browser_agent/webmcp`, 가져오기=`legacy_unknown`(`stage-1-db.md:44-46`, `:207-208`). 이유: `approvals`가 human actor·user를 요구하므로 토큰 권한과 승인 권한을 분리해야 한다(`DDL:252-273`).

### 3.3 맥락 읽기

- **정할 것**: context 포함 범위(프로젝트·판·단계·라운드·대상 버전·질문·정책·lease·커서), digest vs 전체 본문, 대상 밖 읽기.
- **선택지**: ① `project.json` 전체 ② **digest+targets+질문+정책+커서** ③ 객체별 GET만.
- **판단 기준**: 한 호출로 작업 시작이 가능한가, 토큰 비용이 작은가, 대상 밖 수정이 불가능한가, A/B가 같은 context를 받는가.
- **추천**: ②. `GET /projects/{id}/context?stage_id=&round_id=&targets=...`; `project/edition/stage/round/policy/lease/targets/objects/questions/limits`를 반환하고 `meta`에 `event_seq/cursor_epoch`. 기본 digest, 본문은 `targets`+`include=body`만. `run_targets` 밖 객체는 `object:read`가 있어도 context에 넣지 않는다. `run.context_snapshot_id`가 있으면 그 스냅숏 버전을 고정한다(`stage-1-db.md:60`, `:107`). 이유: 현행 `digest`/`show` 토큰 절약 원칙(`skills/core/SKILL.md:86-92`)을 API에도 유지하고, `base_version_id` 충돌을 정확히 내기 위해서다.

### 3.4 claim·lease·heartbeat·인계

- **정할 것**: run 생성과 claim의 결합, TTL·heartbeat, 질문 대기 중 lease, handoff 권한.
- **선택지**: ① 생성/claim 분리+만료 대기 ② **생성 시 `claim:true`로 한 트랜잭션, 별도 claim으로 재개** ③ lease 없이 control_rev만.
- **판단 기준**: 동시 writer가 없는가, 죽은 프로세스에서 이어받는가, 질문 대기 중 다른 실행이 막히지 않는가, 옛 writer의 늦은 결과가 거부되는가.
- **추천**: ②. `POST /projects/{id}/runs`에 `claim:true`면 `project_leases`를 잡고 `fence`+1, run `running`, 응답에 `lease_id/fence/expires_at/context`. `POST /runs/{id}/claim`은 재개·인계 후 획득, `POST /heartbeat`는 `{lease_id,fence}`로 연장하며 `control_rev` 불변. TTL 5분·heartbeat 30초(0단계 시험으로 조정, SEL-24). **질문을 올리면 lease를 놓고 `waiting_human`**(`stage-1-db.md:32`, `:110`). `handoff`는 사람만: 옛 run `interrupted`, 새 run `queued`, `fence` 증가. 에이전트는 `pause`로 놓고 만료 후 claim한다. **사람의 답·첨언·메시지는 lease 없이 가능**하고, lease는 에이전트 결과 채택만 제한한다(`stage-1-db.md:32`). 이유: 프로젝트당 writer 하나를 지키면서 질문 대기 중 답 처리자가 막히지 않게 한다.

### 3.5 submit(결과 제출)

- **정할 것**: 배치 크기, 새 객체/수정 구분, `base_version_id`·`base_control_rev`·`lease_id`·`fence`, 부분 성공 허용.
- **선택지**: ① 객체별 POST+부분 성공 ② **run 단위 배치+전체 롤백** ③ 자유 JSON blob.
- **판단 기준**: 반쯤 반영된 라운드가 없는가, 재전송이 중복 버전을 안 만드는가, base와 다른 버전을 덮지 않는가, 결과·출처·각주·수치가 함께 저장되는가.
- **추천**: ②. `POST /runs/{id}/results` body `{lease_id,fence,base_control_rev,results[]}`. `object_id`가 없으면 새 객체·`counters` 번호(`stage-1-db.md:50`), 있으면 `base_version_id`가 현재 버전과 같아야 한다. `base_control_rev` 불일치 409 `rev_conflict`, lease/fence 불일치 409 `lease_lost`, `run_targets` 밖 403 `out_of_scope`. 최대 50객체/2MB, 하나라도 실패하면 전체 롤백하고 `event_seq`도 늘리지 않는다. `Idempotency-Key` 동일·해시 동일이면 이전 응답 재생.
- **첨부**: `POST /blobs`로 먼저 `staging` 업로드 → SHA-256 확인 → `ready` → 결과에는 `blob_id`만 넣는다(`DDL:212-224`, `:441-449`). 로컬은 파일, 웹은 R2 서명 URL. 본문·파일·DB를 한 트랜잭션으로 커밋하지 않고, `ready` 전 blob은 결과에서 참조할 수 없다. 이유: 결과 반영은 핵심 쓰기이고, 부분 성공은 복구·재시도를 어렵게 한다.

### 3.6 질문 올리기·답 기다리기

- **정할 것**: AI→사람/사람→AI 질문의 공통 자원, 질문 세트·버전, long-poll/SSE, `__other`·의견.
- **선택지**: ① 질문별 POST+반복 GET ② **run questions+inbox long-poll** ③ WebSocket/웹훅만.
- **판단 기준**: 블로킹 없이 기다리는가, 사람이 본 폼 버전이 남는가, 답이 없어도 run이 죽지 않는가, A/B가 같은 표를 쓰는가.
- **추천**: ②. `POST /runs/{id}/questions` body `{lease_id,fence,base_control_rev,questions[]}`; 서버가 `questions`+`question_versions`+`question_sets/members`를 만들고 run을 `waiting_human`으로, **lease 해제**. `GET /runs/{id}/inbox?since_event_seq=&wait_seconds=30`이 답·질문·메시지·결정·입력 영수증을 반환. 사람 답은 `POST /runs/{id}/answers`(human→AI) 또는 `POST /submissions`(폼 전체, `submissions`+`answer_versions` 한 트랜잭션). 기존 `__other`는 `allow_comment_as_answer=1`로 호환하고(`stage-1-db.md:209`), 선택을 의견으로 바꾸지 않는다. `POST /questions`는 사람→AI 질문(human session)만. 이유: 질문은 폼 버전과 답한 질문 버전이 중요하고(`stage-1-db.md:24`, `:78-89`), long-poll이 MCP·프록시에서 가장 호환적이다.

### 3.7 complete·pause·resume·handoff·cancel

- **정할 것**: complete와 승인의 분리, pause/handoff/cancel의 상태·lease, 실패 결과, 재개 시 다시 주는 것.
- **선택지**: ① complete=승인 ② **complete=run 종료, pause=lease 해제, resume=claim** ③ 클라이언트가 상태를 자유 변경.
- **판단 기준**: 에이전트가 승인을 대신 못 하는가, 죽어도 작업이 남는가, 늦은 결과가 거부되는가, 재개 시 중복 작업이 없는가.
- **추천**: ②. `complete` body `{lease_id,fence,status:succeeded|failed|cancelled,summary}`; run 종료·lease 해제, `approvals` 생성 없음, 응답 `approval_required:true`. `pause` body `{lease_id,fence,reason,waiting_for:human|handoff}`; lease 해제, `run_input_receipts`에 `seen/applied/ignored`(`stage-1-db.md:110`). `resume`은 `claim`으로 통일하고 `fence` 증가, `since_event_seq` 이후 답·메시지·변경분 반환. `cancel`은 lease 소유자/사람; 이후 submit 409 `run_not_active`. `handoff`는 사람만. 이유: run 종료와 단계 승인은 다른 사건이고, `approvals` human-only 보장을 지켜야 한다(`DDL:252-273`).

### 3.8 멱등·0행 실패·rev 충돌·오류

- **정할 것**: 멱등 키 위치·보존, 0행 처리, precondition(`control_rev`/`rev`/`version_id`/`fence`), 오류 코드.
- **선택지**: ① 재시도+마지막 쓰기 승리 ② **Idempotency-Key+base/fence+0행 실패** ③ 서버 자동 병합.
- **판단 기준**: 중복 버전이 없는가, 다른 writer를 덮지 않는가, 실패가 성공으로 보이지 않는가, 복구 방법을 알 수 있는가.
- **추천**: ②. 모든 POST/PUT/PATCH에 `Idempotency-Key`(8~128자). `mutation_commits.client_request_id`에 저장, `request_hash`=정규화 JSON SHA-256; 같은 키·같은 해시는 이전 `result_json` 재생, 같은 키·다른 해시는 409 `idempotency_conflict`. `base_control_rev`(프로젝트), `base_version_id`(객체), `lease_id`+`fence`(run)를 요구. SQLite/D1 모두 **조건부 UPDATE 0행을 SQL 실패로 승격**하고 배치 전체를 롤백한다(`stage-1-db.md:122`). 오류는 `{code,message,retryable,details:{current_control_rev,current_version_id,...},request_id,event_seq}`. 상태: 400/401/403/404/409/410/413/422/429/503. 이유: `mutation_commits`가 이미 `client_request_id`·`request_hash`·`base_control_rev`·`fence`를 갖고 있다(`DDL:79-111`).

### 3.9 변경분 커서

- **정할 것**: 커서 단위, 복원·이전 후 무효화, tx 묶음, UI SSE와 에이전트 long-poll.
- **선택지**: ① `control_rev`만 ② **`event_seq`+`cursor_epoch`+tx 묶음** ③ 매번 전체 상태.
- **판단 기준**: 바뀐 것만 받는가, 부분 적용이 없는가, 복원 뒤 옛 커서가 오적용되지 않는가, run 관련만 받는가.
- **추천**: ②. `GET /changes?since_event_seq=123&cursor_epoch=1&limit=200`; `since`는 배타적, `transactions[].events`를 `tx_id`/`tx_index`/`tx_size`로 묶는다. `cursor_epoch`은 `db_meta.cursor_epoch`(`DDL:950-955`); 복원·이전 뒤 다르면 409 `cursor_epoch_mismatch`+`resync_required:true`로 `summary`/`context`부터 다시 받게 한다. `GET /runs/{id}/inbox`도 같은 `event_seq`를 쓰되 run 관련만. UI SSE는 선택(`GET /projects/{id}/events?since_event_seq=`). 이유: Linear `lastSyncId`·Notion 트랜잭션 로그의 "번호+묶음" 교훈(`notion-linear.md:64-70`, `:155-164`)을 그대로 쓴다.

### 3.10 사람만 approve/reopen

- **정할 것**: 승인·reopen·판 시작의 권한·확인, 승인 스냅숏, 에이전트/WebMCP 차단, 감사.
- **선택지**: ① complete 뒤 자동 승인 ② **human session+owner/editor, `approvals` human·verified** ③ 소유자만, 나중에 확대.
- **판단 기준**: 사람이 보고 승인했는가, 에이전트가 위조할 수 없는가, 승인·reopen 이력이 남는가, 5단계 로그인과 연결되는가.
- **추천**: ②, **2단계는 owner만**. `POST /stages/{id}/approve` body `{snapshot_id,note,base_control_rev}`; human session, `project_members.role=owner`, `approvals`에 `actor_kind='human'`·`human_user_id`·`assurance='verified'`. `POST /stages/{id}/reopen` body `{reason,base_control_rev}`; human only, 과거 `approvals`는 남기고 현재 상태/포인터만 변경하며, 뒤 단계 stale은 `stages.stale_since_event_seq`로 표시한다(`stage-1-db.md:61`). `POST /editions`/`activate`, `PUT /policy`도 human/owner만. 에이전트 토큰 scope에 없고 endpoint도 재확인, WebMCP 비노출(`webmcp.md:24`, `:35`). 이유: `approvals` CHECK가 human actor·user를 요구한다(`DDL:252-273`).

### 3.11 A와 OpenCode 서버 API의 분리

- **정할 것**: PES API와 OpenCode 서버 API의 역할, A 세션의 결과 제출 주체, form/permission과 PES 질문의 관계, 정책·비용.
- **선택지**: ① A 어댑터가 결과를 대신 씀 ② **세션도 PES API/MCP로 직접 제출, 어댑터는 수명만** ③ OpenCode 세션/메시지를 PES 기본 모델로.
- **판단 기준**: A/B가 같은 쓰기 경로인가, 어댑터가 상태를 우회하지 않는가, OpenCode 변경이 PES로 새지 않는가, 권한·비용이 기록되는가.
- **추천**: ②. **PES API**는 에이전트(OpenCode 세션 포함)가 context/claim/submit/ask/wait/complete를 호출. **OpenCode 서버 API**는 PES A 어댑터만 `POST /api/session`, `POST /api/session/{id}/prompt`, `GET /api/event`, `POST /interrupt`, `POST /model`, permission/form에 호출(`stage-0-opencode.md:631-676`). `runs.external_session_ref`에 세션 ID. 어댑터는 run을 `claim:false`로 queued 생성하고 정책 확인·세션 시작만 하며, **세션의 `pes_claim`이 lease를 잡고 결과를 제출**한다. 어댑터가 결과를 쓰지 않는다. OpenCode form/permission은 실행 수준이며 PES `questions`가 아니다(`stage-0-opencode.md:650-651`). Go 전송은 `outbound_dispatches`에 prepared/authorized/sent/blocked/failed/unknown(`stage-1-db.md:113`). 이유: 어댑터가 결과를 쓰면 "직접 쓰지 않는다" 원칙이 우회된다.

### 3.12 B용 MCP(HTTP 위 얇은 층)

- **정할 것**: 도구 이름·인자·반환·오류, HTTP 1:1, 인증, long-poll, Claude Code/앱 연결.
- **선택지**: ① MCP 안에 별도 로직/DB ② **6도구가 HTTP를 1:1로 감쌈** ③ CLI만.
- **판단 기준**: TUI가 적은 프롬프트로 정확히 쓰는가, 도구와 HTTP가 안 갈라지는가, 승인·reopen이 노출되지 않는가, Claude Code/앱에서 연결되는가.
- **추천**: ②. `pes_context`→`GET /runs/{id}/context`; `pes_claim`→`POST /projects/{id}/runs(claim:true)` 또는 `POST /runs/{id}/claim`; `pes_submit`→`POST /runs/{id}/results`; `pes_ask`→`POST /runs/{id}/questions`; `pes_wait`→`GET /runs/{id}/inbox`; `pes_complete`→`POST /runs/{id}/complete`. `Idempotency-Key`는 인자/서버 생성, 도구가 임의 재시도하지 않는다. 오류는 HTTP와 같은 `{code,message,details}`. Claude Code는 `pes mcp --stdio`(2단계), Claude 앱 원격 연결은 SEL-24. MCP에 approve/reopen/policy/edition/delete를 **정의하지 않는다**. 이유: B의 가치는 도구 발견·구조화 인자이고, 별도 로직은 계약을 갈라놓는다.

### 3.13 WebMCP 노출표

- **정할 것**: 동작별 노출/비노출·위험도, annotation, browser_agent actor, 승인·reopen·판 시작·삭제 차단.
- **선택지**: ① 모든 버튼 노출 ② **읽기·초안·첨언·질문 추가만** ③ WebMCP를 중심에 둠.
- **판단 기준**: 사람 승인 권한이 우회되지 않는가, 외부 글 주입이 표시되는가, 브라우저 에이전트가 기록되는가, origin trial 비용이 작은가.
- **추천**: ②.

| 동작 | 노출 | 위험 | 비고 |
|---|---|---|---|
| 요약·context·질문·라운드·스레드 읽기 | 가능 | 낮음 | `readOnlyHint`, 외부 글은 `untrustedContentHint` |
| 답 초안 | 가능 | 낮음 | **브라우저 폼만, API 제출 아님** |
| 첨언 추가·사람→AI 질문·다음 라운드 할 일 제안 | 가능 | 중간 | `consequentialHint`, `browser_agent`+`on_behalf_of_user_id` |
| 답 제출·스레드 해결 | 불가(제안만) | 높음 | 사람이 직접 |
| 승인·reopen·판 시작·정책·토큰·멤버·삭제 | **불가** | 높음 | `webmcp.md:24`, `:35` |
| run claim/submit/complete·export | **불가** | 높음 | 브라우저 에이전트는 실행 에이전트가 아님 |

- 기능 감지 후 등록하고 한 파일에 모아 이름 변경(`navigator.modelContext`→`document.modelContext`)에 대응(`webmcp.md:10`, `:31`). 이유: 로그인된 탭 권한으로 실행되므로 승인·reopen을 노출하면 사람 확인 없이 단계가 넘어간다.

### 3.14 Linear·Notion으로 한 방향 보내기

- **정할 것**: 보낼 대상(연구 내용 vs PES 개발 할 일), 권한, 실패·재시도·영수증, 왕복 금지 경계.
- **선택지**: ① 양방향 동기화 ② **PES 원본, 사람이 고른 것만 한 방향** ③ 지원 안 함.
- **판단 기준**: 연구 내용 확산을 사용자가 통제하는가, Notion API 한계를 우회하지 않는가, 중복 생성이 없는가, PES 기록이 덮이지 않는가.
- **추천**: ②. `POST /exports` body `{target:"linear"|"notion",kind:"issue"|"page",source_version_ids,thread_ids?}`; human session+owner/editor; `Idempotency-Key`. 상태는 `GET /exports/{id}`; 외부 ID/URL은 `mutation_commits.result_json`/`events`에 남기고, 6단계에서 `export_receipts` 표를 추가한다. Linear는 **PES 개발 할 일**(버그·기능 요청)만, 연구 내용은 보내지 않는다(`notion-linear.md:141`). Notion은 최종 보고서 읽기 전용 사본만; 글 조각 첨언 왕복은 API 한계로 불가(`notion-linear.md:49`, `:141`). 인바운드 웹훅·왕복 없음, PES가 원본(`:149`). WebMCP·에이전트 토큰에 `export:create` 없음. 이유: 한 방향이면 충돌·권한·개인정보 위험이 작고 6단계에서 붙이기 쉽다.

### 3.15 Go OFF 시 in-flight 처리

- **정할 것**: 새 전송·prepared·sent/unknown, run/lease, 자동 재시작 금지, 감사.
- **선택지**: ① 새 요청만 막고 진행 중 run은 완주 ② **prepared 차단, in-flight interrupt, sent/unknown 기록, run interrupted** ③ 모든 결과 폐기.
- **판단 기준**: 이미 나간 자료를 회수했다고 거짓말하지 않는가, 새 자료가 더 안 나가는가, 사용자가 상태를 아는가, A/B 계약이 유지되는가.
- **추천**: ②. 기본은 **켜짐**(`project_policy_versions.allow_opencode_go` default 1, `DDL:118`), 프로젝트별로 끈다. `PUT /projects/{id}/policy` body `{allow_opencode_go:false,reason}`; owner human only, `project_policy_versions` 새 `policy_rev`, 응답에 `affected_runs/dispatches`. 새 `mode=A` run·prompt·요약·첨부·재시도는 403 `policy_blocked`; `outbound_dispatches` `prepared/authorized`→`blocked`; `sent/unknown`은 **회수 보장 없음**으로 기록하고 OpenCode 세션 `interrupt` 시도, 실패 시 `unknown`. run `interrupted`, lease 해제, 자동 resume·재시도 없음(`stage-1-db.md:212`). `waiting_human` run도 전송하지 않고, 정책 재허용 후에도 소유자가 명시적으로 새 run/claim해야 한다(`stage-1-db.md:29`). 합성 자료도 우회하지 않는다(`:18`). `GET /projects/{id}/dispatches?state=`로 감사. 이유: "끄면 즉시 안 나감"과 "이미 나간 것은 회수 불가"를 분리해야 오해가 없다.

---

## 4. 방식 A·B 차이

| 항목 | A (PES 내부) | B (외부) | 처리 |
|---|---|---|---|
| 실행 주체 | `internal_ai`, runtime `opencode` | `external_agent`, `claude_code`/`claude_app` | `actors.kind`, `runs.runtime` |
| 모델 | `opencode-go/deepseek-v4.1-flash` 하나로 6단계 | Claude 모델, run마다 다름 | `runs.provider/model` |
| PES API | OpenCode 세션이 직접 | Claude가 MCP/HTTP로 직접 | 같은 endpoint |
| OpenCode 서버 | PES A 어댑터만 | 모름 | `runs.external_session_ref` |
| Go 전송 | `outbound_dispatches` 필수·정책 검사 | 없음(타 공급자 정책은 5단계) | `outbound_dispatches` |
| 질문 | PES 원본, OpenCode form은 실행 수준 | PES 원본 | `questions` |
| 대기 | `waiting_human`, lease 해제 | 같음, TUI 종료 시 heartbeat 중단 | `project_leases` |
| 중단·재개 | `interrupt`+claim | 프로세스 재시작+claim | `fence`, `run_input_receipts` |
| 비용 | usage API 기록 | 선택(모르면 NULL) | `runs.usage_json` |
| 자동 시작 | PES가 세션 시작 가능 | 사람이 TUI/앱에서 시작 | `runs.mode` |

**공통**: `claim→context→submit*→ask*→wait→complete`와 endpoint는 같다(`stage-0-opencode.md:880-899`). 승인은 A/B 모두 사람 `approve`만; `complete`는 승인이 아니다. `run_targets` 밖 수정은 403. B는 OpenCode API를 몰라야 하고, A는 B의 HTTP/MCP 계약을 그대로 쓴다.
**금지**: A 어댑터의 대리 쓰기, B에 OpenCode 세션 요구, `mode`별 endpoint 분기, `complete`를 승인으로 처리.

---

## 5. 완료 기준

- [ ] OpenAPI 3.1 + endpoint 표(context, run/claim, heartbeat, submit, questions, inbox/answers, complete, pause, cancel, changes, approve, reopen, policy, tokens).
- [ ] 모든 쓰기가 `mutation_commits`+같은 tx `events`를 만들고 표 직접 쓰기가 없다. API는 합의 DDL 표만 쓰고 새 표를 만들지 않는다(6단계 `export_receipts` 제외).
- [ ] `Idempotency-Key` 재생/충돌, 0행 실패, rev/lease/fence 충돌 테스트.
- [ ] context가 digest+targets만 주고 `run_targets` 밖 수정이 403.
- [ ] claim이 lease/fence를 만들고, ask가 lease를 놓고 `waiting_human`으로 가며, inbox long-poll이 답을 준다.
- [ ] `complete`가 `approvals`를 만들지 않고, approve/reopen은 human session만 통과한다.
- [ ] `changes`가 `cursor_epoch` 불일치에서 409 `resync_required`를 내고 tx를 부분 적용하지 않는다.
- [ ] MCP 6도구가 HTTP와 1:1이고 승인·reopen 도구가 없다. WebMCP 노출표대로 고위험 동작이 빠진다.
- [ ] Go OFF: 새 run/prompt 403, prepared 차단, in-flight interrupt, sent/unknown 기록, 자동 재시작 없음.
- [ ] A/B 가짜 어댑터가 같은 결과·질문·답·이벤트를 만든다. A만 OpenCode 서버 API를 쓴다.
- [ ] 사용자 결정(6절)이 답해졌고 2단계 PR 매핑(7절)이 승인됐다.
- [ ] 실제 `~/pes-projects`·`~/.pes/` 없이 합성 fixture로만 검증했다.

---

## 6. 사용자 결정이 필요한 것

| # | 결정 | 선택지 | 추천 |
|---|---|---|---|
| 1 | API 경로·버전 | `/api/v1` / `/v1` / 헤더만 | **`/api/v1`** |
| 2 | 인증 | Bearer만 / 세션만 / **에이전트 Bearer+사람 세션** | **혼합**, 승인은 human만 |
| 3 | 승인 역할 | owner만 / owner+editor | **2단계 owner만**, 5단계 editor 검토 |
| 4 | 토큰 만료 | 30일 / 90일 / 무기한 | **30일+회수** |
| 5 | long-poll | 30초 / 60초 / SSE만 | **30초** |
| 6 | context 양 | digest+targets / 전체 / 개별 GET | **digest+targets**, `include=body` opt-in |
| 7 | WebMCP 답 제출 | 초안만 / 제출 허용 | **초안만** |
| 8 | Linear/Notion 범위 | 연구 포함 / 개발 할 일·최종 보고서만 / 안 함 | **개발 할 일·최종 보고서** |
| 9 | Go OFF in-flight | 완주 / interrupt 시도·기록 | **interrupt 시도+기록** |
| 10 | 오류 문구 | 영어만 / 코드 영어+문구 한국어 | **코드 영어+문구 한국어** |
| 11 | A의 PES 접근 | 어댑터 대리 / 세션 직접 | **세션 직접**, 어댑터는 수명만 |
| 12 | export 영수증 | events만 / 6단계 표 | **6단계 `export_receipts`** |
| 13 | rate limit | 없음 / 60 req/min | **60/min**, 429 |
| 14 | Idempotency 보존 | 24시간 / 7일 / 영구 | **7일** |

---

## 7. 다른 설계·2단계로 넘길 것

- **DB**: 합의 DDL 표만 쓴다. 새 표는 6단계 `export_receipts` 정도. WebMCP는 정적 manifest로 충분. `events`에 `visibility`가 없으므로 API가 `type` allowlist로 내부 이벤트를 숨긴다.
- **화면**: 전송 스위치(결정 1), 승인/reopen human-only, `rev_conflict`/`lease_lost`/`cursor_epoch_mismatch` 복구 UI, `waiting_human` 표시. 3단계 WebMCP·첨언 `ambiguous/lost`·반영 내역, 5단계 로그인.
- **실행 구조**: lease TTL/heartbeat는 0단계 SEL-18·19 결과로 SEL-24에서 확정(`stage-1-db.md:162`). A의 OpenCode permission/form→PES UI 프록시, Claude 앱 연결은 SEL-24. `pes home`·DB·객체 위치, 삭제 정책은 2단계(`:163`).
- **2단계**: API 작업은 기존 PR에 붙는다(8절). 실제 프로젝트 이전·D1 운영·웹 로그인은 2단계 이후, 시험은 합성 fixture만(`:134`).

---

## 8. 구현 이슈 예상

**2단계는 stage-1-db 10절의 22개 PR을 유지한다.** API 때문에 새 PR을 만들지 않고 아래에 붙인다. 각 PR에 테스트 포함.

| 기존 PR | API에서 추가되는 일 |
|---|---|
| 2 D1 smoke | batch 원자성, 0행 실패, partial UNIQUE, cursor_epoch |
| 4 변경 명령 | Idempotency/request_hash, 0행, rev/lease/policy guard, error envelope |
| 5 run·lease | claim/heartbeat/pause/resume/handoff, waiting_human 해제, receipts |
| 9 결과물·객체 | `POST /blobs` staging→ready, SHA-256, 로컬/R2 키, 결과의 blob 참조 |
| 10 actor·token·policy | Bearer/session, scope, human-only, Go policy, 발급·회수, rate limit |
| 13 context/claim/submit/complete | context digest, run+claim, results 배치, complete≠approve |
| 14 질문·답·변경분·오류 | questions/answers/submissions/inbox/changes/approve/reopen/error |
| 18 로컬 화면 | 전송 스위치, 승인/reopen, conflict/resync UI |
| 19 A 어댑터 | OpenCode 세션/prompt/event/interrupt/permission, dispatch, A 세션의 PES API |
| 20 B 어댑터 | MCP 6도구, Claude Code/앱, heartbeat/claim |
| 21 A·B 교차 계약 | 같은 결과·질문·답·이벤트, 중복·경쟁·유실, Go OFF |
| 22 통합 검증·문서 | API 문서·오류 예제·사용 안내 |

**새로 필요한 것(2단계 아님)**: 3단계 WebMCP shim+manifest 1개, 6단계 `export_receipts`+Linear/Notion export 1개, 5단계 로그인·원격 MCP·알림. 2단계 이슈 수는 **22개 유지**; API 문서·OpenAPI·계약 테스트는 PR 13·14·21에 포함한다.

---

## 9. 근거

### 확정·합의
- `docs/plan/stage-0.md:12-14` — 원칙 0(에이전트는 상태를 직접 쓰지 않음)
- `docs/plan/stage-0.md:42` — API 계약은 1단계로
- `docs/plan/stage-0.md:46-48` — 공통 시나리오, A/B 역할·차이
- `docs/plan/stage-0.md:87-90` — Go 기본 켜짐+끄기, A DeepSeek, B Claude Code/앱, 공개+CI
- `docs/plan/stage-1-db.md:14-34` — 합의 결정 17개
- `docs/plan/stage-1-db.md:38` — 공통 표 규칙, UTC epoch ms, RESTRICT
- `docs/plan/stage-1-db.md:42-61` — users/actors/tokens/projects/policy/editions/stages/rounds/approvals
- `docs/plan/stage-1-db.md:78-89` — question_sets/questions/submissions/answers/threads
- `docs/plan/stage-1-db.md:103-117` — runs/targets/leases/receipts/mutation/events/outbound
- `docs/plan/stage-1-db.md:119-124` — SQLite/D1, 0행 실패
- `docs/plan/stage-1-db.md:136-144` — A/B 표
- `docs/plan/stage-1-db.md:158-170` — 화면/실행 구조, 완료 기준
- `docs/plan/stage-1-db.md:172-202` — 2단계 22개 PR
- `docs/plan/stage-1-db.md:203-215` — Codex 보완(승인 human, Go OFF, 0행)

### DDL 초안
- `docs/plan/schemas/stage-1-ddl-draft.sql:12-77` — users/actors/projects/members/tokens
- `:79-111` — mutation_commits(멱등·base_control_rev·fence·guard_ok)
- `:113-159` — policy/editions
- `:161-210` — stages/rounds
- `:252-273` — approvals(human actor·user·verified)
- `:275-331` — objects/object_versions
- `:451-524` — questions/question_versions/question_sets
- `:526-576` — submissions/answers
- `:638-698` — anchors/threads
- `:700-821` — messages/followups/reflection
- `:823-901` — runs/targets/leases/receipts
- `:903-948` — events/outbound
- `:950-955` — db_meta.cursor_epoch
- `:990-1002` — events_by_project_seq 등 인덱스

### 조사·0단계
- `docs/plan/research/notion-linear.md:64-70` — Linear sync/lastSyncId/delta
- `:96-102` — 댓글·quotedText·resolvingComment
- `:106` — 에이전트 귀속(onBehalfOf)
- `:149` — PES 원본, 외부는 내보내기만
- `:155-164` — change_log·커서·트랜잭션·ID
- `:49`, `:141` — Notion 글 조각 첨언 한계, 내보내기 범위
- `docs/plan/research/webmcp.md:19-25` — WebMCP 도구·위험도
- `:31` — 얇은 감싸개·기능 감지
- `:35-37` — 승인·reopen·판 시작 비노출, 브라우저 에이전트 기록
- `docs/plan/discussion/stage-0-opencode.md:631-676` — A: OpenCode serve/API, 질문 분리
- `:678-717` — B: MCP 6도구, HTTP 원본, lease
- `:719-745` — 스킬 중립화
- `:880-899` — 공통 객체·claim→context→submit→ask→wait→complete
- `:901-930` — A/B 준비 체크리스트

### 현재 코드·화면
- `scripts/serve.py:22-38` — 256KB, kind, origin/trusted
- `scripts/serve.py:111-152` — POST /feedback, answers/text/kind
- `scripts/serve.py:154` — 127.0.0.1
- `skills/core/SKILL.md:16` — AskUserQuestion(서버 없을 때만)
- `skills/core/SKILL.md:18` — project.json 단일 진실
- `skills/core/SKILL.md:62-84` — 직접 JSON 편집(2단계에서 제거)
- `skills/core/SKILL.md:86-92` — digest/show 토큰 절약
- `skills/core/SKILL.md:114-135` — 단계 생명주기
- `skills/core/SKILL.md:191-206` — 답 해석
- `templates/_questions.html:33-48` — 질문별 `__other`
- `templates/_questions.html:78-93` — answers/answers+`__other`
- `scripts/pes.py:442-512` — approve/reopen
- `scripts/pes.py:516-563` — pending/mark
- `scripts/pes.py:587-640` — digest/show
- `README.md:548-563` — 프로젝트 폴더 구조
