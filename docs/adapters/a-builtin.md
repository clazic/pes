# 어댑터 노트 — 방식 A 내장 실행기 (사용자가 등록한 AI 연결)

PES가 **AI 연결**(사용자가 직접 등록한 주소·키·모델)을 직접 불러 에이전트 루프를 돌리는 방식 A의 실행기다. 결정은 [0019](../plan/decisions/0019-ai-connection-registration.md)(0013의 "Go 하나" 부분을 대체)이고, 표·보장은 [stage-2-db-guarantees.md 8.16](../plan/stage-2-db-guarantees.md)에 있다. opencode serve·CLI·로컬 runner는 두지 않는다. 화면 문구는 제공사 이름이나 "Go" 대신 "AI 연결"·"API"라고 쓴다.

구현: `scripts/pes_core/a_runtime/{spec,formats,http,keystore,usage,tools,connections,loop}.ts`, 명령 정의 `scripts/pes_core/commands/ai.ts`.

## 연결 종류와 요청 형식

| 종류(`kind`) | 요청 형식 | 실행 |
|---|---|---|
| `subscription_api`(구독형 API) | `openai_compatible` | 한다 |
| `openai_compatible`(OpenAI 호환 API) | `openai_compatible` | 한다 |
| `custom`(직접 입력: 내 컴퓨터·로컬 모델 등) | `openai_compatible` | 한다 |
| `anthropic`(Anthropic API) | `anthropic` | 한다 |
| `google`(Google API) | `google` | **하지 않는다.** 등록은 되고 `supported: false`로 보인다. 연결 시험도 하지 않고, 이 연결로 run을 시작하면 `conflict`로 거부한다 |

Google API는 이번 PR에서 요청 형식을 구현하지 않았다(목록에 두되 실행은 미지원). 필요해지면 별도 PR에서 `google` 형식을 더한다.

주소(`base_url`)는 https이거나, 이 컴퓨터(localhost·127.0.0.1)를 가리키는 http여야 한다. 주소에 계정·쿼리·조각을 넣을 수 없다(키가 주소에 실리지 않게). 리디렉션은 따라가지 않는다.

| | `openai_compatible` | `anthropic` |
|---|---|---|
| 주소를 적는 방법 | `/v1`까지 (`https://…/v1`) | `/v1` 없이 (`https://…`; 붙어 있어도 된다) |
| 모델 목록 | `GET <주소>/models` → `{data:[{id}]}` | `GET <주소>/v1/models?limit=1000` → `{data:[{id}]}` |
| 호출 | `POST <주소>/chat/completions` | `POST <주소>/v1/messages` |
| 인증 헤더 | `Authorization: Bearer <키>` | `x-api-key: <키>`, `anthropic-version: 2023-06-01` |
| 도구 | `tools:[{type:"function",function:{name,description,parameters}}]`, 도구 결과는 `role:"tool"`+`tool_call_id` | `tools:[{name,description,input_schema}]`, 도구 결과는 `tool_result` 블록 |
| 출력 상한 | `max_tokens` = run의 `max_output_tokens`(예약과 같은 값). **`max_completion_tokens`만 받는 모델(OpenAI의 o 시리즈 등 일부 최신 모델)은 지원하지 않는다(확인 필요 — 그런 모델은 400으로 run이 실패할 수 있다).** vLLM·Ollama·OpenRouter 같은 호환 서버는 보통 `max_tokens`가 통한다 | `max_tokens` 같은 값 |
| 토큰 수 | `usage.prompt_tokens`·`completion_tokens` | `usage.input_tokens`·`output_tokens` |

키는 인증 헤더 한 곳에만 실린다. 본문·주소·로그·표에는 없다. 응답이 키를 되풀이해도(오류 문구 등) 저장하거나 기록하지 않는다 — 오류에서는 짧은 코드(`error.code`·`error.type`)만 읽는다.

## 연결을 다루는 길 (사람만, 요청마다 재인증)

`AiConnectionService`(`connections.ts`)가 아래 명령을 감싼다. 모든 명령은 프로젝트 소유자(사람)만 낼 수 있고, 에이전트 키로는 `forbidden`이다. 등록·변경·삭제·시험·단가는 **요청 한 건마다** 1회용 재인증 코드(`reauth_code`, 5분)를 쓴다.

| 명령 | 하는 일 |
|---|---|
| `ai_connection.issue_reauth` | 재인증 코드를 낸다. 코드는 한 번만 보여 주고 표에는 해시만 둔다 |
| `ai_connection.register` | 연결을 등록한다. **저장 전에 PES 서버가 연결을 시험**(모델 목록 GET)하고, 실패하면 아무것도 남지 않는다 |
| `ai_connection.update` | 이름·주소·한도·상한·키를 바꾼다. 키나 주소가 바뀌면 다시 시험한다. 새 키가 시험에 실패하면 옛 키가 그대로 남는다 |
| `ai_connection.remove` | 연결을 지운 것으로 표시하고 키 저장소의 키를 지운다(실행·호출 이력이 가리키는 행은 남긴다) |
| `ai_connection.test` | 저장된 연결을 다시 시험하고, 시험했다는 기록(사건)을 남긴다. 결과는 `{ok, models, error_code}` |
| `ai_connection.set_price` | 모델별 단가(입력·출력 100만 토큰당 **마이크로 단위 정수**, 통화)를 사람이 입력한다. 새 항목이 쌓이고 옛 항목은 바꾸지 않는다 |
| `project.set_ai_connection` | 프로젝트가 쓸 연결과 모델을 고른다. **다음 run부터** 적용된다 |
| `ai_connection.confirm_extra_charge_off` | **구독 연결만.** 그 계정에 "추가 요금(플랜 밖 과금)이 꺼져 있음"을 사람이 확인했다고 기록한다: `{reauth_code, connection_id, account_scope, valid_for_ms}` — 확인한 계정 범위(200자까지)·확인 시각·유효 기간(1ms~400일). 새 확인이 쌓이고 가장 최근 것이 쓰인다 |
| `ai_connection.record_usage_baseline` | **구독 연결만.** 제공사 화면에서 읽은 그 계정의 사용량 기준점(`account_used_tokens`, 0 이상 정수)을 기록 시각과 함께 남긴다: `{reauth_code, connection_id, account_used_tokens}` |
| `dispatch.resolve_unknown` | 결과를 모르는 호출을 사람이 "청구 안 됨/청구됨"으로 정리한다. 대상은 `unknown` 호출과, 실행기가 죽어 정산되지 못한 `prepared`·`authorized`·`sent` 고아 호출이다(그 run의 lease가 아직 살아 있으면 `conflict` — 실행기가 직접 정산할 수 있다). 정리하기 전까지는 게이트가 그 호출을 예약(없으면 추정)으로 계속 세고, 재개는 막힌다 |

- **API 키는 명령 필드가 아니다.** `api_key`를 명령에 실어 보내면 `invalid_payload`(필드 이름만 말하고 값은 되풀이하지 않는다). 키는 `AiConnectionService`의 입력으로만 들어와 키 저장소에 가고, 명령에는 끝 4자리·저장 위치 이름·참조 이름만 간다. 화면 DTO에는 `key_last4`·`key_storage`·`key_set_at`·`key_set_by`만 있다.
- 구독 연결: `subscription_limits`(5시간·주간·월간 토큰 한도)가 **필수**다. 한도를 모르면 등록도 시작도 하지 않는다. `stop_percent`(50~100, 기본 90)는 멈춤 문턱이다. 그리고 **유효한 "추가 요금 꺼짐" 확인과 사용량 기준점이 둘 다 있어야** 호출한다(아래 「사용량 보호」).
- 키를 바꾸거나 연결을 지우는 요청은 **연결마다 한 번에 하나씩** 처리한다(키 저장소 읽기부터 명령·되돌리기 끝까지, 같은 프로세스 안). 입력 검사는 키 저장소를 건드리기 전에 끝낸다. 명령이 실패해 되돌릴 때는 **저장소에 아직 이 요청이 쓴 키가 있을 때만** 옛 키를 되돌린다(비교 후 교체) — 실패한 요청이 다른 요청이 저장한 키를 덮거나 지우지 않는다.
- 쓴 만큼 과금 연결: `cost_cap`(통화·상한, 마이크로 단위)이 **필수**이고, 사용하려는 모델의 단가가 있어야 run이 시작된다. 단가를 모르면 0으로 두지 않고 시작하지 않는다. 같은 키를 다른 곳에서 쓰면 그 비용은 PES가 모른다 — 화면은 이를 알리고 제공사 콘솔에도 한도를 걸라고 안내해야 한다.

### 키 저장소

`KeyStore { put(ref, secret), get(ref), delete(ref), where() }`. 로컬 앱은 운영체제의 비밀 저장소(`keystore.ts`의 `os_key_store()`), 웹 서버는 서버 비밀 저장소(5단계 WEB4)를 꽂는다.

| OS | 백엔드 | 비밀을 넘기는 방법 |
|---|---|---|
| macOS | `security`(키체인) | `security -i`의 표준입력(명령줄에 비밀이 없다) |
| Windows | 자격 증명 보관소(PasswordVault, Windows PowerShell) | 표준입력, 이름은 환경변수 |
| Linux | `secret-tool`(Secret Service) | 표준입력 |

OS 도구 호출에는 시간 제한(15초)이 있다 — 넘으면 도구를 죽이고 "키 저장소가 제때 답하지 않았다"는 오류로 끝낸다(잠긴 키체인·대화창 때문에 lease를 쥔 채 무한 대기하지 않는다. 실행 중이면 키를 못 읽은 것으로 보아 run을 `manual_hold`로 멈춘다). 줄바꿈(`\r`·`\n`)·NUL이 든 비밀은 저장소에 넣기 전에 거부한다(`security -i`에 둘째 명령 줄이 끼는 것을 막는다). `key_ref`는 `pes-ai-<connection_id>`여야 한다(다른 연결의 키를 가리킬 수 없다).

OS 도구를 실제로 부르는 `exec`는 `os_key_store()`를 부르는 **실행 지점**이 정한다(`exec`를 주입하지 않으면 실제 자식 프로세스). 시험은 항상 메모리 가짜 저장소를 꽂으므로 시험 중 실제 키체인에는 닿지 않는다. **실제 키체인 백엔드의 동작은 이 PR에서 시험하지 않았다(미확인).**

## 호출 한 번의 순서

`BuiltinExecutor`(`loop.ts`)는 사람이 시작·재개한다. 모델 호출마다 아래를 이 순서로 한다.

1. run이 실행 중이고 lease를 쥐고 있다.
2. 정책 스위치(AI 연결 전송 허용)가 켜져 있다 — **호출마다** 다시 본다.
3. 연결이 살아 있고 키 저장소에 키가 있다. **주소와 키는 함께 읽는다**: 키·주소 변경이 잡는 연결별 잠금 아래에서 읽고, 키 끝 4자리가 표의 값과 같은지 확인한다. 바꾸는 도중의 상태(새 키 + 이전 주소, 이전 키 + 새 주소)는 보내지 않는다 — 같은 프로세스는 잠금이 막고, 다른 프로세스가 바꾸는 중이면 끝 4자리가 어긋나 run을 `manual_hold`로 멈춘다. 연결 시험(`test`)도 같은 방법으로 읽는다.
4. 사용량·비용 문턱이 이번 호출의 예약을 통과시킨다. 판정은 `dispatch.prepare` 트랜잭션 안에서 다시 하고 예약(`allowance_json`)을 그 행에 같이 기록한다 — 같은 연결을 쓰는 다른 실행이 동시에 둘 다 문턱을 넘길 수 없다.
5. 호출 기록(`outbound_dispatches`)을 먼저 쓴다: `prepared → authorized → sent`. 상관 키(`request_key`)와 요청 본문 해시(`payload_hash`)가 이때 정해진다.
6. 요청을 **한 번** 보낸다. 응답이 없으면(시간 초과·연결 끊김) 상태는 `unknown`이고 PES는 그 호출을 다시 보내지 않는다. 답의 과금 신호(`billing_source`·`cost`)는 **HTTP 상태를 보기 전에** 고정 값으로 읽는다 — 오류 답(429 포함 4xx·5xx)이나 끊긴 본문의 받은 부분이 과금됐다고 하거나 읽을 수 없는 과금 값을 담으면 무과금 `failed`로 두지 않고 `unknown`(사유 `charged_error`, 신호·답 해시·예약 보존) + `usage_unknown`으로 멈추며, 구독 연결이면 그 신호가 꺼짐 확인을 무효로 해 재확인 전에는 재개·새 시작·다음 호출이 막힌다. `429`·한도 오류는 즉시 멈추고 `retry-after`로 재개 가능 시각을 기록한다. 다른 오류는 호출을 `failed`로 두고 run을 실패시킨다. 자동 재시도·모델 폴백은 없다.
7. **HTTP 응답 경계에서 키를 찾는다.** 성공(2xx) 답의 원문, 해석한 JSON의 모든 문자열(이름·값), 그리고 PES가 실행할 해석 결과(답 글, 도구 이름, **두 번째 JSON 해석을 거친 도구 인자**)를 본다. 각 문자열은 감싼 층을 벗겨 가며 본다 — JSON `\uXXXX` 이스케이프(앞의 역슬래시 개수와 무관, 여러 겹), URL `%xx`, base64·base64url(패딩 유무, 덩어리 앞 네 위치에서 읽기)을 어떤 순서로든 6겹까지. 그 어디에든 현재 키 전체나 키 조각(8글자, 숫자가 있거나 대소문자가 섞인 것)이 있으면, 그 답은 도구 실행·대화 이력·다음 요청 어디에도 가지 않는다. 호출은 `unknown`(사유 `key_in_reply`, 답 해시·토큰·비용·과금 신호만 보존)으로 정산하고 run은 `blocked_usage`(`usage_unknown`)다. 오류 답은 아래처럼 고정 코드만 남기므로 키가 저장될 길이 없다. 이 검사는 **닫힌 쪽으로, 정해진 시간 안에 끝난다**: 모든 층(`\uXXXX`·`%xx`·base64 덩어리)을 정규식이 아닌 한 번 훑는 글자 스캔으로 벗기고(되짚기 없음), 답 하나의 검사 전체에 작업량 상한(384Mi자 단위)을 두어 **각 단계를 하기 전에** 깎는다(글 한 개는 32Mi자까지). 검사 중 예외가 나거나 상한을 넘으면 "키가 있을 수 있음"으로 보고 같은 방식으로 `unknown`(사유 `key_check_failed`, 답 해시·토큰·비용·과금 신호 보존) + `usage_unknown`으로 멈춘다(모델 목록이면 연결 시험 실패 `key_check_failed`).
   **모양을 읽을 수 없는 답**(배열 안의 `null`·숫자·배열, 객체가 아닌 `message`·`function`, 문자열이 아닌 도구 이름·글, `null`인 `input` 등)도 예외로 실행을 실패시키지 않고 `unknown`(사유 `unreadable_reply`, 답 해시·예약·과금 신호 보존) + `usage_unknown`으로 멈춘다. 사람이 그 호출을 정리하면 재개할 수 있다.
8. 받은 답을 기록한다(`response`: 답 해시·토큰·비용·`billing_source`). 그다음 도구 호출을 PES 명령으로 실행한다. 결과가 저장되면 그 호출은 `adopted`가 된다. 구독 연결인데 답이 과금됐다고 말하면 그 답의 도구 호출(이미 값을 치른 답이다)까지만 처리하고 **다음 호출 전에** 멈춘다(`extra_usage_off`).
9. 저장(`dispatch.settle`의 `response`·`adopted` 포함, 도구 결과)이 실패하면 받은 답을 메모리에 둔 채 같은 요청 키로 저장만 `save_retries`(기본 2)번 다시 한다 — 모델은 다시 부르지 않는다. 계속 실패하면 그 호출을 `unknown`(사유 `save_failed`, 답 해시·토큰·비용·과금 신호·예약 보존)으로 두고 `usage_unknown`으로 멈춘다. 그것조차 저장할 수 없으면 호출은 앞 상태(`sent`)로 남아 계속 세어지고 사람이 `dispatch.resolve_unknown`으로 정리한다.

**오류 코드**: 공급자 오류 답의 `code`·`type` 원문은 저장하지 않는다(키를 되풀이할 수 있다). 알려진 값은 표로 비교만 해 PES 고정 코드(`rate_limited`·`quota_exceeded`·`auth_failed`·`forbidden`·`not_found`·`invalid_request`·`context_too_long`·`request_too_large`·`overloaded`·`server_error`)로 바꾸고, 모르는 값은 HTTP 상태로만 고른다(`client_error`·`server_error`·`provider_error`). `dispatch.settle`도 이 목록 밖의 `error_code`는 `invalid_payload`로 거부한다.

**도구 이름**: 공급자는 도구 이름에 `[a-zA-Z0-9_-]`(64자까지)만 받는다. PES 이름(`context.get`)과 전송 이름(`context_get`)을 고정 표(`formats.ts` `TOOL_WIRE_NAMES`, 점→밑줄)로 양방향 매핑한다: 보내는 도구 목록·이전 assistant 도구 호출·프롬프트는 전송 이름, 답의 도구 호출은 PES 이름으로 돌린다. 표에 없는 이름은 그대로 두어 allowlist가 거부하고, 대화 이력으로 되돌려 보낼 때는 허용 글자로 바꾼다(그 밖의 글자→`_`, 64자).

run 하나는 시작 때 고른 모델 하나로만 간다. 실패해도 다른 모델·연결로 바꾸지 않는다.

### 멈춤과 재개

| 상황 | run 상태 | 사유 | 다음 |
|---|---|---|---|
| 질문(`question.ask`) | `waiting_human` | — | 답이 오면 사람이 재개 |
| 사용량 문턱 | `blocked_usage` | `usage_limit`(+다시 쓸 수 있는 시각) | 사람이 재개(문턱을 다시 본다) |
| 비용 상한 | `blocked_usage` | `cost_cap` | 사람이 상한을 올리거나 새 run |
| 한도 오류(429) | `blocked_usage` | `usage_limit`(+`retry-after`) | 시각이 지난 뒤 사람이 재개 |
| 응답 유실·시간 초과·저장 실패·응답 본문이 너무 큼(8MiB 초과) | `blocked_usage` | `usage_unknown` | 사람이 `dispatch.resolve_unknown`으로 정리한 뒤 재개 |
| 연결·키가 없어짐 | `blocked_usage` | `manual_hold` | 연결을 고친 뒤 재개 |
| 답에 현재 키(전체·조각)가 있음 | `blocked_usage` | `usage_unknown` | 사람이 정리한 뒤 재개(키를 바꾸는 것이 좋다) |
| 구독 연결에 유효한 추가 요금 꺼짐 확인·기준점이 없음, 확인 만료, 확인 뒤 과금 신호가 보임 | `blocked_usage`(시작 전이면 `conflict`) | `extra_usage_off` | 사람이 다시 확인(`confirm_extra_charge_off`)한 뒤 재개 |
| 정책 스위치 끔 | `interrupted` | 사건에 `policy_off` | 스위치를 켜고 재개 |

`blocked_usage`·`waiting_human`은 **lease를 놓는다.** 재개는 `BuiltinExecutor.resume`이고, 사람(소유자)만 낼 수 있으며 새 claim(더 큰 fence)과 함께 정책·사용량·키를 다시 확인한다. 답이 아직 없으면(`resume_ready`) 모델을 부르지 않고 `conflict`다. 결과를 모르는 호출이 정리되지 않았으면 재개는 `conflict`다.

## 사용량 보호

- **진행 중인 호출(`prepared`·`authorized`·`sent`)도 센다**: 토큰이 아직 없으면 기록해 둔 예약(추정 입력 + 출력 상한)으로 센다. 비용 계산이 숫자 범위를 넘으면 예외로 끝내지 않고 그 호출을 `unknown`(예약·추정 유지)으로 정산한 뒤 run을 `blocked_usage`(`usage_unknown`)로 멈춘다.
- **같은 요청 키의 `start`/`resume` 동시 호출은 하나만 구동한다**: 진행 중인 약속(Promise)으로 묶고, claim이 재생(replay)이면 모델을 부르지 않고 결과만 돌려준다.
- **구독형(`subscription`)**: PES가 **자기가 보낸 호출**의 토큰을 센다(제공사가 알려 준 `usage`. 없으면 입력은 예약값, 출력은 `max(답 글자로 잡은 추정, 예약의 출력 상한)` — 숨은 추론 토큰이 있어도 예약보다 낮게 세지 않고 0으로 두지 않는다. 입력 토큰 추정은 `max(UTF-8 2바이트당 1토큰, 글자 수)`로 일부러 높게 잡는다). 5시간·7일·30일 이동 창마다 `이미 쓴 토큰 + 이번 호출의 예약(추정 입력 + 출력 상한) ≤ 한도 × stop_percent`일 때만 보낸다. 창에서 가장 오래된 호출이 빠져나가는 시각을 다시 쓸 수 있는 시각(`go_block_reset_at`)으로 기록한다. 응답이 유실돼 결과를 모르는(unknown) 호출, 실행기가 죽어 남은 `prepared`·`authorized`·`sent` 호출은 사람이 "청구 안 됨"으로 정리할 때까지 계속 센다 — 저장된 사용량이 없으면 그 호출의 예약값으로 센다(0으로 세지 않는다).
- **결과를 모르는 호출은 시간이 지나도 풀리지 않는다**: 사람이 정리하지 않은 `unknown`·`prepared`·`authorized`·`sent` 호출은 5시간·7일·30일 모든 창에서, 얼마가 지나도 센다. "청구 안 됨"으로 정리하면 빠지고, "청구됨"이면 보낸 시각 기준으로 일반 호출처럼 창에서 빠져나간다.
- **구독형의 추가 요금 꺼짐 확인과 기준점**: 구독 연결은 ① 만료되지 않은 "추가 요금 꺼짐" 확인(`ai_extra_charge_off_confirmations`)과 ② 사용량 기준점(`ai_usage_baselines`)이 **둘 다** 있을 때만 호출한다(시작·재개·호출마다, `dispatch.prepare` 트랜잭션 안에서도). 두 기록은 **연결의 지금 키·주소에 묶인다**: 키나 주소를 바꾸면(`ai_connections.credential_rev`가 1 오른다) 그 전의 확인·기준점은 세지 않는다 — 다른 계정·다른 서비스일 수 있으므로 새 키·주소에 대해 둘 다 다시 기록해야 시작·재개·다음 호출이 된다(실행 중이면 다음 호출 전에 멈춘다). 시각이 아니라 세대 번호로 비교하므로 같은 밀리초의 변경도 놓치지 않는다. 이름·`stop_percent`·한도·상한만 바꾸면 그대로다. 없거나 만료·읽을 수 없으면 보내기 전에 멈춘다(`extra_usage_off`). 기준점은 기록 시각의 사용량으로 그 시각을 포함하는 창마다 더하고, 그보다 앞선 PES 호출은 기준점에 들어 있는 것으로 본다(같은 시각의 호출은 겹쳐 세어 많이 세는 쪽).
- **과금 신호**: 답이 과금 방식을 말하면 그대로 `billing_source`로 기록한다 — 연결 설정값을 관측값처럼 쓰지 않는다. 읽는 모양은 표준이 아니어서 PES가 정한 것뿐이다: 최상위나 `usage` 안의 `billing_source`(문자열)·`cost`(숫자, 0보다 크면 과금). 기록값은 `pay_per_use`(과금됐다고 함)·`subscription`(플랜 안이라고 함)·`unrecognized`(PES가 모르는 값)·`not_reported`(말이 없음). **구독 연결에서 `pay_per_use`·`unrecognized`가 보이면 다음 호출 전에 멈추고**, 그 확인 이후 과금 신호가 있는 동안 확인은 무효다(사람이 다시 확인해야 한다). 신호는 `unknown`으로 정산되는 모든 경로(답 저장 실패·채택 저장 실패·키 반사·읽을 수 없는 답·비용 범위 초과)에서도 그 호출에 남는다. 사람이 그 호출을 "청구됨"이나 "청구 안 됨"으로 정리해도 확인은 되살아나지 않는다 — 호출 정리와 계정의 꺼짐 재확인은 별개다. 실제 공급자가 이런 필드를 주는지는 공급자마다 다르며 확인하지 않았다(미확인) — 신호가 없다고 과금이 없다는 뜻은 아니므로 추가 요금 꺼짐 확인은 그대로 필요하다.
- **쓴 만큼 과금(`pay_per_use`)**: 비용 = 토큰 × 단가(정수, 올림). 이 연결로 지금까지 쓴 비용(누적, 창 없음) + 이번 호출 예약 비용이 상한을 넘으면 **보내기 전에** 멈춘다. 단가·통화가 상한과 다르면 시작하지 않는다.
- **단가·문턱의 스냅샷**: 단가와 `stop_percent`는 run을 만들 때 `ai_run_settings`에 복사한다. 단가를 바꿔도 진행 중인 run은 시작 때 값으로 계산하고 다음 run부터 새 단가를 쓴다. 한도와 상한은 스냅샷이 아니라 연결의 현재 값을 읽는다(올리면 막힌 run을 재개할 수 있고, 낮추면 바로 적용된다).
- **구독형 사용량을 제공사에서 조회하는 공식 API는 확인하지 못했다(미확인).** 그래서 PES가 센 토큰과 사람이 넣은 한도로만 추정하며, 다른 곳에서 같은 계정을 쓴 양은 알 수 없다. 추정이 틀릴 수 있다는 점을 화면에 알려야 하고, 제공사 쪽 한도 설정도 함께 쓰라고 안내한다.

## 도구(allowlist)

allowlist(`A_TOOL_ALLOWLIST`)는 8개이고(목록은 얼려 있다), 그중 **지금 모델에게 보여 주는 도구는 7개**다(`thread.reply`는 아래) 파일·셸·임의 네트워크 도구는 없다. 목록 밖의 이름은 오류 결과를 돌려주고 아무 일도 하지 않으며 루프는 계속된다. 모델은 run id·lease·fence를 정할 수 없다 — 실행기가 붙인다.

| 도구 | 실제로 하는 일 |
|---|---|
| `context.get` | 주제·단계·라운드·현재 객체·질문과 답을 읽는다 |
| `result.submit` | DB 결과 형식(`op: append_version`, 이미 있는 `object_id`) 전용 — `result.submit` 명령으로 기존 객체에 새 버전을 덧붙인다 |
| `question.ask` | `question.publish_set` 명령 뒤 `run.wait` — 사람 답을 기다린다 |
| `assumption.propose` · `decision.propose` · `reflection.write` · `followup.propose` | 이 PR에는 대응하는 전용 PES 명령이 없어 `project.add_note` 명령으로 **"AI 제안" 머리말이 붙은 메모**로 남긴다(`decision.propose`는 사람이 채택해야 한다고 적는다). 채택·승인은 하지 않는다 |
| `thread.reply` | 대응 명령이 아직 없다. allowlist에는 이름을 두되 **모델의 도구 목록에는 싣지 않는다**(항상 오류만 돌려줘 턴·토큰만 낭비하므로). 명령이 생기면 도구 목록에 노출한다. 모델이 이름을 불러도 오류 결과만 돌려준다 |

## 한계·미확인

- `google` 형식은 실행하지 않는다.
- 구독형 사용량 공식 API는 확인하지 못했다(위). 공급자가 답에 과금 신호를 싣는 공식 필드도 확인하지 못했다(PES가 정한 모양만 읽는다).
- 키·주소 변경·삭제의 직렬화(와 실행기·연결 시험의 주소+키 함께 읽기)는 한 프로세스 안에서만 잠금으로 보장한다. 여러 프로세스 사이에서는 되돌리기의 비교 후 교체와, 보내기 전 키 끝 4자리 대조(어긋나면 보내지 않음)만 막는다 — 끝 4자리가 우연히 같은 두 키는 구별하지 못한다.
- 모델 목록 응답도 같은 키 검사를 거친다. 키(어떤 모양이든)가 있으면 목록 전체를 버리고 연결 시험은 `key_in_reply`로 실패한다(등록·변경은 `conflict`, 아무것도 저장하지 않는다).
- OS 키체인 백엔드 3종은 구현만 했고 실제 호출은 시험하지 않았다.
- 실제 외부·유료 모델 호출은 시험하지 않았다. 시험은 이 컴퓨터의 가짜 HTTP 서버만 쓴다.
- `thread.reply`는 아직 연결되지 않았다(allowlist에만 있고 모델에게 노출하지 않는다 — 명령이 생기면 노출). 나머지 제안 도구 4개는 전용 명령이 생길 때까지 메모로 남는다.
- OpenAI 호환 본문은 `max_tokens`만 쓴다. `max_completion_tokens`만 받는 모델은 지원하지 않는다(확인 필요, 위 표).
- 응답 본문은 최대 8MiB까지만 읽는다. 넘으면 읽기를 멈추고 "응답을 잃은 것"과 같이 `unknown`으로 둔다.
- 호출 중에 실행기 프로세스가 죽으면 그 호출은 `sent`(또는 `prepared`·`authorized`)로 남고, 다음 재개는 이를 정리되지 않은 호출로 보고 막는다. 사람은 `dispatch.resolve_unknown`(그 run의 lease가 끝난 뒤)으로 "청구 안 됨/청구됨"을 골라 정리한다. 정리하기 전까지 그 호출은 한도·상한을 계속 깎는다. 재시작 뒤 자동 이어가기는 PR21의 몫이다.
- 연결 시험이 사용자가 입력한 주소로 나가므로, 웹 서버(5단계)에서는 서버가 부를 수 있는 주소를 제한하는 규칙이 더 필요하다.
- D1(운영) 적용: 마이그레이션 002는 `runs` 표를 다시 만든다. SQLite 로컬은 외래 키를 잠시 끄고 처리하지만, D1은 같은 방식이 안 되므로 5단계에서 D1 전용 적용 절차가 필요하다.
