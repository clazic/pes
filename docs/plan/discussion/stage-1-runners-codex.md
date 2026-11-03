# 1단계 ④ 방식 A·B 실행 구조 — Codex 의견 (SEL-24)

작성: 2026-11-04. 상태: **토론안**. 확정 사항, 공식 문서 확인, 설계 추천, 미시험 사항을 구분한다.
추천은 **PES 코어 하나 + A/B 실행 어댑터 + 같은 명령 계약 + 프로젝트별 실행 담당 하나**다. 실행 세션을 잃어도 PES의 결과·질문·답·결정에서 다시 시작할 수 있어야 한다.
이번 작업은 저장소 파일과 공개 공식 문서 조사뿐이다. 실제 `~/pes-projects`·`~/.pes/`는 읽지 않았고 제품 코드·설정·실행 서버를 변경하거나 실행하지 않았다.

## 0. 바꾸지 않는 전제와 조사 범위

- stage-0 7절과 stage-1-db 2절의 **17개 결정 전부**를 따른다. 전송 기본값·A 모델/6단계·B 지원 대상·공개 저장소/매 PR CI를 다시 묻지 않는다.
- A는 OpenCode **v2.2.5**를 검증 기준으로, `opencode-go/deepseek-v4.1-flash` 하나로 6단계를 수행한다. 실패한다고 모델을 조용히 바꾸거나 조사 단계만 남기지 않는다.
- B는 Claude Code와 Claude 앱을 모두 다룬다. Claude 앱 연결을 ‘미래에 가능할 것’으로 생략하지 않고, 로컬 MCP 경로와 명시적 전달 경로를 설계한다.
- Go 허용은 프로젝트별 기본 켜짐이다. 허용과 자동 실행은 다르다. OFF는 맥락·요약·첨부·재시도에 적용하고, 누락/손상 정책은 차단한다. 재허용은 소유자만, 자동 재시작 없음이다.
- 한 프로젝트의 쓰기 원본은 하나다. 실행 중 DB 파일 동기화·JSON 이중 쓰기를 금지하며, 기기 이동은 DB+객체+manifest 내보내기/가져오기다.
- SEL-18·19의 실험 결과는 **아직 없다**. TTL·heartbeat·연결 지속성·중단 보장·요금 측정을 검증된 사실로 쓰지 않는다. SQLite DDL 검증도 런타임·D1·반출 차단의 증거가 아니다.
- `stage-1-api-opencode.md`와 `stage-1-ui-codex.md`는 연계할 **의견서**이며 확정 API로 간주하지 않는다. 아래 계약 이름은 의미를 설명하는 가칭이다.

근거: `docs/plan/stage-0.md:14–14`, `docs/plan/stage-0.md:85–99`, `docs/plan/stage-1-db.md:14–34`, `docs/plan/stage-1-db.md:158–170`, `docs/plan/stage-1-db.md:203–215`.

### 0.1 공개 공식 문서에서 확인한 범위

확인일은 2026-11-04다. 설치된 OpenCode·Claude 앱 버전, 계정 권한, 실제 도구 왕복은 확인하지 않았다. 브라우저 실행 도구가 시작되지 않아 웹 조회로 공식 자료를 읽었다.

| 자료 | 확인한 사실 | 아직 증명하지 못한 것 |
|---|---|---|
| [OpenCode v2.2.5 릴리스](https://github.com/anomalyco/opencode/releases/tag/v2.2.5) | 해당 릴리스 존재 | 사용자 설치본과 동일함 |
| [OpenCode V2 API](https://opencode.ai/v2/docs/api)·[공개 OpenAPI](https://opencode.ai/v2/openapi.json) | 세션·프롬프트·이벤트·중단·폼·권한·사용량 인터페이스 | 현재 웹 명세와 2.2.5 바이너리의 완전 일치 |
| [OpenCode 서버 플러그인](https://dev.opencode.ai/v2/docs/build/plugins/server) | 모델/HTTP·요약·제목·재시도 훅, WebSocket 별도 경로 | Go에서 훅 실패가 반출 전에 확실히 차단되는지 |
| [Claude Code MCP](https://code.claude.com/docs/en/mcp) | 로컬 stdio와 HTTP 등 MCP 연결 경로 | PES 도구·대기 시간·TUI 종료의 실제 동작 |
| [Claude Desktop 로컬 MCP](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop) | 사용자 정의 `.mcpb` 설치, Python 등 서버 지원, 민감 설정 보호 기능 | 사용자의 앱/조직 정책에서 PES 확장을 쓸 수 있음 |
| [Claude 원격 커넥터](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp) | 원격 접속은 Anthropic 클라우드에서 출발, 공개 도달 주소 필요 | 로컬 PES를 그대로 연결할 수 있음 — 이 경로로는 가정 불가 |
| [MCP 전송 규약](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports) | stdio/Streamable HTTP, 연결 끊김과 취소 구분 | 연결 살아 있음이 PES 작업 진행/lease 소유를 뜻함 |

공식 문서의 기능을 바탕으로 한 **구성·강제 정책·복구 동작은 아래 설계 제안**이다. 최신 웹 문서가 2.2.5 전용 명세라는 보장은 없으므로 구현 때 명세 사본·해시와 고정 바이너리를 함께 대조한다.

## 1. 생각할 주제와 선택 기준

| 주제 | 정할 것·선택지 | 판단 기준 | 추천과 이유 |
|---|---|---|---|
| 책임 경계 | 에이전트가 상태 관리 / 코어 명령 서비스 | A/B 동작·기록 일치 | 코어가 상태·검증·채택, 어댑터는 실행만 연결 |
| 공통 실행 계약 | 제공자별 도구 / HTTP 원본+얇은 MCP·CLI | 같은 결과·오류·재시도 의미 | 후자. 도구 표면이 달라도 상태 규칙은 하나 |
| run·세션 | 프로젝트 영구 세션 / run별 세션+검증된 재개 | 맥락 오염·인계·추적 가능성 | run/역할 경계로 세션 격리, PES 기록에서 재구성 |
| 실행 담당 | 파일 잠금 / lease+fence / 화면만 잠금 | 종료·지연 응답·동시 채택 방지 | 합의된 lease+fence, 사람 입력과 분리 |
| 대기·재개 | 무한 대기·lease 유지 / 질문 저장 후 해제 | 사람 시간·앱 단절 허용 | waiting_human+해제, 재개 시 새 fence |
| A 연결 | CLI one-shot / 서버 HTTP / SDK 이식 | 세션·이벤트·권한·중단 활용 | 서버 HTTP. Python 코어에 추론 루프를 재구현하지 않음 |
| Go OFF | 최초 prompt 검사 / 실제 반출 요청마다 검사 | 자율 후속 요청·요약·재시도 차단 | 실제 요청 경계의 거부 가능한 검사+중단 |
| form·permission | 연구 질문과 합침 / 실행 입력으로 분리 | 사람 답 원본·승인 권한 보존 | PES 연구 질문, 실행 form/permission 별도 중계 |
| 비용·시간 | 경고만 / 상한과 중단 / 고정 무제한 | 한도 초과·미상 비용 처리 | 요청 전 예약·시간 제한·중단, 수치는 실험 후 |
| B Code | MCP / CLI / 파일 직접 편집 | 설치·발견·복구·원본 보호 | MCP 기본+동일 서비스 CLI, 파일은 제안 전달만 |
| B 앱 | 로컬 Desktop MCP / 원격 커넥터 / 명시적 전달 | 로컬 도달성·계정 정책·앱 단절 | 로컬 확장 우선 검증, 전달/가져오기 대안 보장 |
| 스킬 | 에이전트별 복제 / 중립 워크플로+어댑터 노트 | 변경 한 곳·도구 차이 가시성 | 후자. 연구 절차와 실행 문법 분리 |
| 역할 | 주 에이전트 혼자 / 역할별 실행 / 동시 여러 writer | 독립 검토·추적·단일 담당 | 별도 맥락의 역할 실행, 채택 담당은 하나 |
| 인계 | 세션 transcript 복사 / 고정본+미처리 입력 | 제공자 종속·중복 반영 방지 | 새 run·새 담당, PES 기록 묶음 전달 |
| 실행 위치 | 브라우저/요청 수명 안 / 별도 로컬 supervisor | 화면 닫힘·Windows 프로세스 복구 | 코어 옆 supervisor, 웹 이전 시 별도 runner |

## 2. 주제별 추천과 구체적인 동작

### 2.1 하나의 코어와 두 어댑터

```text
사람 화면 ───── 사람용 명령 ─┐
A: OpenCode ─ PES 도구/HTTP ─┼─ PES 명령 서비스 ─ SQLite / 객체 저장소
B: Code·앱 ─ MCP / CLI ─────┘   검증·권한·rev·lease·불변 버전·사건
                                 ↑ 실행 제어/상태 확인도 검증 명령
                      supervisor + A/B 어댑터
                      A → OpenCode 서버 API → Go 반출 검사 → 제공자
                      B → 연결/전달·재접속 안내, 외부 실행은 도구가 담당
```

- 코어: 프로젝트·판·단계·라운드, 상태 전이, actor/권한, 질문·답·첨언·반영, 결과 채택·파일 ready, rev·멱등·lease·기록의 원자성을 소유한다.
- 에이전트: 조사·집필·자체 점검·근거 검토·수정 제안을 만든다. DB·`project.json`·현재 버전 포인터를 직접 쓰지 않는다. 작업용 결과 파일은 **제안**일 뿐이다.
- 어댑터: 세션 시작/중단, 이벤트 변환, 실행 도구 권한, 실제 모델 확인, 연결·세션 참조를 소유한다. 승인·reopen·전송 재허용을 대신하지 않는다.
- supervisor: 재시작 뒤 queued/running/waiting_human·lease·미확인 전송을 조회해 실행을 대조한다. 추론·연구 질문 저장소·별도 업무 DB를 만들지 않는다.
- 어댑터도 상태 변경은 검증 명령으로 한다. ‘어댑터가 결과 제출 API를 호출’하는 것과 ‘DB를 직접 쓰는 것’은 다르다. 모델의 텍스트 출력을 바로 완료 상태로 해석하지 않는다.
- 사람 화면은 꺼져도 이미 저장한 입력을 유지한다. 브라우저 heartbeat나 탭 수명을 에이전트 실행 담당의 생존 증거로 쓰지 않는다.

근거: `docs/plan/stage-0.md:10–14`, `docs/plan/stage-0.md:42–48`, `docs/plan/discussion/stage-0-opencode.md:872–899`, `docs/plan/stage-1-db.md:103–117`.

### 2.2 공통 계약: 실행 시작과 결과 채택을 모두 추적한다

| 의미상 도구 | 공통 입력·결과 | 중요한 제약 |
|---|---|---|
| context | 판/단계/라운드·고정본·대상 버전·결정·가정·입력·정책·한도 | 기본 요약, 필요한 본문·근거만 선택 조회 |
| claim | 프로젝트·run·대상·실제 actor → lease_id/fence/expires_at | 실행 담당 획득은 원자적, 현재 기반 재조회 |
| submit | 기반 rev/버전·lease/fence·결과·근거·멱등 키 → 채택 영수증 | 허용 대상·기반 충돌·파일 ready 검증, 부분 성공 없음 |
| ask | 버전 있는 질문/폼 → 질문 ID·waiting_human·lease 해제 | 연구 질문 원본은 PES. 해제까지 같은 변경 단위 |
| wait/inbox | 입력 커서·짧은 대기 → 새 입력·다음 커서 | 읽기. lease 보유·자율 재개를 의미하지 않음 |
| complete | 결과 요약·상태 → 실행 종료 영수증 | run 종료뿐. 라운드 봉인·단계 승인은 별도 |
| heartbeat/release/cancel | 소유한 lease/fence 또는 사람의 명시적 중단 → 확인 상태 | transport 연결과 구분. 회수 뒤 지연 결과는 거절 |

- HTTP가 의미의 원본이다. MCP/CLI 오류는 같은 코드·현재 rev·재시도 가능 여부·영수증 조회 방법을 돌려준다. 승인·reopen·판 시작·정책 재허용은 에이전트 도구 목록에서 제외한다.
- A는 어댑터가 **연구 자료를 prompt로 보내기 전에** run을 만들고 담당/정책을 확인하는 안을 추천한다. 런타임 도구는 같은 담당을 사용하고 별도 claim을 중복 실행하지 않는다. 빈 세션 준비는 가능하나 모델 호출·자료 전달은 시작하지 않는다.
- `stage-1-api-opencode.md:204–204`의 ‘세션을 먼저 시작하고 내부 pes_claim으로 획득’ 안과 순서를 맞춰야 한다. 첫 모델 호출을 claim 이전에 허용하면 실행 담당 없는 반출이 생긴다. 최종 API에서 획득 주체를 하나로 정한다.
- actor는 토큰/사람 세션/서버 실행 신원에서 확정한다. 어댑터가 제출을 중계해도 외부 작성자를 인간으로 바꾸지 않는다. 시작을 누른 사람은 on_behalf_of/사건 근거로 따로 남긴다.
- 결과 채택·입력 적용·관련 사건·멱등 영수증은 같은 변경 명령에서 기록한다. 같은 키·같은 요청은 저장된 응답, 같은 키·다른 요청은 충돌이다. 제공자 호출의 멱등성과 PES 저장 멱등성은 별도로 검증한다.

근거: `docs/plan/stage-1-db.md:30–32`, `docs/plan/stage-1-db.md:108–117`, `docs/plan/schemas/stage-1-ddl-draft.sql:66–110`, `docs/plan/discussion/stage-0-opencode.md:699–711`.

### 2.3 공통 run 생명주기와 질문 대기

```text
queued → [claim·기반 확인] → running → [submit* → complete] → succeeded
                              ├→ [ask + lease 해제] → waiting_human
                              │                         └→ [입력 확인·새 claim] → running
                              └→ failed / interrupted / cancelled + 담당 해제
```

- waiting_human 전환은 질문 저장·폼 발행·사건·담당 해제를 함께 확정한 뒤 런타임을 정지시킨다. 순서가 어긋나도 후속 모델 호출이 나가지 않도록 반출 검사에서 run/담당도 확인한다.
- 어댑터가 죽더라도 질문은 DB에서 다시 찾는다. 질문 대기 중 supervisor가 lease를 계속 갱신하거나 앱에 무한 wait 호출을 유지하지 않는다.
- 답 도착은 PES 접수다. 실행이 연결됐을 때만 수신 확인 후 seen을 기록한다. applied는 적용 tx와 결과 증거가 있을 때다. 단순 context 다운로드를 ‘이미 읽음/반영’으로 처리하지 않는다.
- 답을 받으면 질문 버전·폼·필수 답·재확인 필요·최근 결정/가정·후속을 다시 검증하고 담당을 획득한다. 대기 중 다른 실행이 진행했으면 최신 맥락에서 계속할지 대조한다.
- 같은 실행의 사람 대기는 동일 run 재개가 가능하다. 실패 뒤 재시도·담당 방식 변경은 새 run을 권하고 retry_of/관련 사건으로 연결한다. terminal run을 무작정 running으로 되돌리지 않는다.
- complete는 성공/실패 기록이며 사용자 승인 아님이다. 사람이 승인하지 않은 단계를 자동으로 넘기거나 옛 승인 불확실성을 지우지 않는다.

근거: `docs/plan/stage-1-db.md:24–24`, `docs/plan/stage-1-db.md:32–32`, `docs/plan/stage-1-db.md:107–117`, `docs/plan/schemas/stage-1-ddl-draft.sql:823–900`.

### 2.4 lease·heartbeat: 값보다 먼저 지킬 규칙

- 매 획득/재획득/인계에서 fence를 단조 증가시킨다. 갱신은 현재 lease_id·fence·actor·활성 run·만료 전 여부가 모두 맞아야 하며 업무 rev는 바꾸지 않는다.
- 코어의 시간을 만료 기준으로 쓴다. 클라이언트 시계·PID·OpenCode 세션 ID·기존 PES_OWNER만으로 소유권을 증명하지 않는다. 만료 뒤 heartbeat로 옛 lease를 부활시키지 않는다.
- 채택 명령에서 현재 담당·미만료·run 상태·대상 버전·rev를 함께 검사한다. 조건부 UPDATE 0행이면 전체 실패다. 유효 토큰만 가지고 지연 결과를 채택하지 못한다.
- 연결 종료 감지는 빠른 회수의 단서다. TUI 강제 종료·네트워크 단절은 서버가 모를 수 있으므로 최종 안전망은 만료+fence다. lease 만료는 외부 프로세스/모델 비용의 실제 중단을 보장하지 않는다.
- Code bridge의 갱신은 **실제 작업을 소유한 런타임의 생존·진행 증거와 최대 실행 기한**에 묶는다. MCP 프로세스나 앱만 켜져 있다는 이유로 영구 갱신하지 않는다.
- Claude 앱에는 기본적으로 지속 heartbeat를 요구하지 않는다. 작업 구간 claim·명령 시 갱신 또는 짧은 claim→submit과, 오래 걸린 제안의 새 기반 재검토 경로를 쓴다. 반환 전 lease가 만료될 수 있음을 정상 복구로 다룬다.

| 변수 | 현재 값 | SEL-18·19에서 측정/확정할 기준 |
|---|---|---|
| H: 갱신 간격 | **미정, 시험으로 결정** | OS 부하·최대 도구 호출·bridge 연결의 갱신 지연 |
| L: lease TTL | **미정, 시험으로 결정** | 허용 누락 횟수 k, 지연 D99, 스케줄 지터 J99, 복구 목표 |
| G: 중단 유예 | **미정, 시험으로 결정** | interrupt·프로세스 종료·잔여 자식 프로세스 확인 시간 |
| W: inbox 대기 | **미정, 시험으로 결정** | Code/앱/MCP 프록시의 실제 타임아웃보다 짧게 |
| S: 무진행 한도 | **미정, 시험으로 결정** | 장시간 도구와 멈춘 작업을 구분할 관측 가능성 |

후보 관계는 `L > k×H + D99 + J99 + 여유`다. 숫자 자체는 확정하지 않는다. 합성 자료로 Windows·macOS의 정상·종료·절전/복귀·패킷 지연·중복 갱신·자식 프로세스 잔존을 반복해 정한다.
API 의견의 ‘TTL 5분·heartbeat 30초’는 측정 전 후보일 뿐 기본값으로 승격하지 않는다. 기존 파일 잠금의 2시간도 새 lease의 근거가 아니다.

근거: `docs/plan/stage-1-db.md:32–32`, `docs/plan/stage-1-db.md:109–117`, `docs/plan/stage-1-db.md:162–162`, `docs/plan/schemas/stage-1-ddl-draft.sql:872–886`, `scripts/pes.py:117–144`, `docs/plan/discussion/stage-1-api-opencode.md:154–154`.

### 2.5 A 프로세스와 세션 수명

선택지는 사용자 공용 OpenCode 서버 공유와 PES 관리 전용 서버다. **초기에는 활성 프로젝트별 PES 관리 프로세스**를 권한다. 정책·작업 디렉터리·종료 범위를 분명히 할 수 있기 때문이다. 자원 비용은 실험으로 측정한다.

- 로컬 supervisor가 고정 2.2.5 바이너리·인자 배열·제한된 환경으로 실행한다. loopback 수신과 인증을 사용하며 사용자 서버를 찾아 임의로 붙거나 전체 OpenCode 프로세스를 종료하지 않는다.
- 프로세스 소유 식별자·시작 시각·접속점·run/세션 매핑을 기록하고 재시작 시 대조한다. PID만 재사용해 남의 프로세스를 종료하지 않는다. Windows 종료/자식 회수와 macOS 프로세스 그룹 동작은 각각 시험한다.
- 전용 작업 디렉터리에 허용된 입력 사본·출력 제안만 둔다. PES DB·객체 원본·사용자 전역 설정 전체를 에이전트 파일 도구에 노출하지 않는다. 경로·인증 자료는 공개 저장소/일반 사건 payload에 넣지 않는다.
- 기본 세션 경계는 역할별 run이다. 같은 run의 답 대기 뒤에는 세션 복구를 시도하되 실제 세션 상태·정책·모델·기반 버전을 확인한다. 확인할 수 없으면 PES 고정본으로 새 세션을 만든다.
- external_session_ref는 접속점/인스턴스와 함께 해석하는 외부 참조다. OpenCode 세션은 증거 보조이며 업무 원본이 아니다. 이전 단계 세션의 숨은 결정을 현재 결정으로 가져오지 않는다.
- OpenCode의 사용자 전역 플러그인·자동 제목·예약 실행·모델 대체가 전용 프로필에 섞이지 않게 검사한다. 자율 후속 요청도 2.8절의 검사를 통과해야 한다.

근거: `docs/plan/discussion/stage-0-opencode.md:631–674`, `docs/plan/stage-1-db.md:107–115`. 전용 프로세스/프로필 방식은 본 의견의 추천이며 해당 버전의 격리 설정 가능 여부는 미시험이다.

### 2.6 A의 OpenCode API 대응

공식 API/OpenAPI에서 확인한 표면은 다음과 같다. `{s}`는 sessionID, `{f}`는 formID, `{p}`는 requestID의 축약이다. 아래 경로는 **PES API와 별개**다.

| 목적 | OpenCode 경로 | PES 어댑터에서의 역할 |
|---|---|---|
| 서버·모델 확인 | GET `/api/info`, GET `/api/model` | 버전·준비·정확한 모델/기능 대조 |
| 세션 | POST `/api/session`, GET `/api/session/{s}` | 생성 응답과 run 연결, 재접속 상태 확인 |
| 프롬프트 | POST `/api/session/{s}/prompt` | 맥락·과제 전달, 접수와 결과 채택 구분 |
| 모델 | POST `/api/session/{s}/model` | 지정 DeepSeek와 일치시킴. 자동 대체 없음 |
| 이벤트 | GET `/api/event` | 진행 알림 수신·연결 복구 |
| 중단 | POST `/api/session/{s}/interrupt` | 중단 요청, 확인된 결과만 상태 반영 |
| 권한 | GET/POST `/api/session/{s}/permission`, POST `/api/session/{s}/permission/{p}/reply` | 실행 권한 요청·응답 중계 |
| 폼 | GET/POST `/api/session/{s}/form`, POST `/api/session/{s}/form/{f}/reply` | 실행 입력 중계, 연구 질문과 분리 |
| 사용량 | GET `/api/experimental/usage/limits` | Go 허용량·Console 예산 확인. run 실제 비용과 구분 |

문서상 prompt 접수는 실행 예약을 포함할 수 있고 `resume` 옵션이 있다. interrupt도 단순 HTTP 성공을 ‘모든 작업 중단’으로 해석할 수 없다. 취소 시 `resume=false`를 명시하는 계약을 시험한다. [공식 API](https://opencode.ai/v2/docs/api), [OpenAPI](https://opencode.ai/v2/openapi.json).

- 시작 시 고정 명세와 런타임 필수 동작을 대조한다. 엔드포인트·스키마를 v1 관습으로 추정하지 않는다. 런타임 명세 제공 위치도 직접 확인하고 공개 `/v2/openapi.json`과 혼동하지 않는다.
- 문서에 있다는 이유로 호출 성공·Go 인증·모델 가용성이 검증됐다고 하지 않는다. 미지원/스키마 변경은 설명 가능한 오류와 B 인계로 이어지고 조용한 API 우회는 하지 않는다.

### 2.7 A 이벤트·제공자 호출·복구

- OpenCode 이벤트는 작업 진행 신호다. PES events는 업무 커밋의 원본이다. 두 사건 번호를 같은 커서로 쓰지 않고 세션/이벤트 참조로 대조한다. 토큰 스트림마다 object_versions를 만들지 않는다.
- 이벤트 중복·순서 변경·연결 끊김을 정상적인 가능성으로 취급한다. 복구는 세션 상태·접수된 메시지·PES 영수증 대조부터 하며, 이벤트가 안 왔다고 prompt를 재전송하지 않는다.
- 요청별 PES 멱등 키와 제공자 입력 식별자를 연결한다. 외부 API의 중복 억제가 고정 버전에서 검증되지 않으면 정확히 한 번 모델 실행을 약속하지 않는다. 결과 불명은 일단 멈추고 조회한다.
- 모델이 ‘완료’라고 말했거나 세션이 idle이어도 결과 payload·근거·파일·기반 버전이 검증되지 않았으면 PES run 성공으로 확정하지 않는다. 실패 결과도 원래 실행·전송 기록과 함께 보존한다.
- supervisor 재시작 시 모든 running을 자동 재실행하지 않는다. 실제 프로세스·lease·외부 세션·미확인 요청을 대조한 뒤 재접속/중단/명시적 재시도 중 하나를 고른다.

근거: `docs/plan/stage-1-db.md:26–26`, `docs/plan/stage-1-db.md:107–117`, `docs/plan/schemas/stage-1-ddl-draft.sql:79–110`, `docs/plan/schemas/stage-1-ddl-draft.sql:903–947`, `docs/plan/research/notion-linear.md:155–163`.

### 2.8 Go OFF의 강제 지점: 최초 프롬프트 검사로 끝내지 않는다

선택지는 어댑터의 prompt 전 검사와 **제공자 요청 직전의 거부 가능한 검사**다. 후자를 필수로 추천한다. OpenCode의 다음 추론·도구 결과·요약·재시도는 최초 prompt 뒤에도 발생할 수 있기 때문이다.

공식 플러그인 문서는 HTTP 요청/응답과 primary·compaction·title·generate 구분, retry 훅 및 별도 WebSocket 훅을 설명한다. 이 기능으로 아래 정책을 구현할 수 있는지는 **2.2.5+Go 실제 전송 시험**이 필요하다. [서버 훅 문서](https://dev.opencode.ai/v2/docs/build/plugins/server).

1. prompt 구성 전: 프로젝트 정책·담당·기반 버전·선택된 입력을 검사한다. run에 context snapshot/입력 목록을 고정하고 필요한 자료만 전달한다.
2. 실제 요청 전: 세션→프로젝트/run 매핑, 실제 목적지·provider/model, 현재 정책, 유효 담당, 시간·예산을 재검사한다. 캐시한 허용만 믿지 않는다.
3. 전송 허가: 최종 요청 자료의 manifest/hash와 policy_version을 가진 dispatch를 준비하고 현재 정책과 같은 순서로 authorized를 확정한다. 판단 중 OFF가 먼저 커밋되면 허가를 거부한다.
4. 허가와 실제 send 사이에도 취소 가능한 문을 둔다. OFF는 대기 중 허가를 차단하고 진행 중 요청에는 취소를 시도한다. DB 커밋과 외부 네트워크 전송이 하나의 트랜잭션인 것처럼 주장하지 않는다.
5. 결과: sent는 전송 관측 사실, failed는 확인된 실패, unknown은 송신 여부/응답 불명이다. 허가됐다는 이유만으로 sent를 만들지 않는다. 이미 나간 자료는 회수 보장 없음이다.
6. OFF 이후: 새 Go 허가·요약·제목·첨부·내부 재시도·자식 세션 전송을 막는다. 해당 실행의 추가 결과 채택도 중단 상태에 맞게 제한하고 lease를 회수한다. OFF/ON을 반복해도 옛 담당·대기 요청은 부활하지 않는다.

- 검사 후보는 PES 관리 서버 플러그인의 요청 훅+코어 허가 서비스다. **훅 예외가 실제 요청을 막는지, 내부 재시도마다 도는지, 최종 수정된 요청을 관측하는지, Go transport가 우회하는지**를 먼저 확인한다.
- 훅만으로 거부를 보장하지 못하면 실제 송신을 맡는 제한된 relay/transport가 필요하다. Go 인증·프로토콜과 호환되는지 증명해야 하며, 일반 HTTP 프록시 설정만으로 보장이 된다고 쓰지 않는다.
- 허가 서비스 불통·매핑 없음·최종 hash 불일치·정책 손상·훅 미적용은 전송을 거부한다. 검사 장애를 ‘합성 자료니까 허용’으로 우회하지 않는다. 다른 플러그인이 검사 뒤 요청을 바꿀 수 없게 구성한다.
- 셸·MCP 도구가 Go로 직접 보내는 우회도 막아야 한다. 전용 런타임에서 Go 자격 증명과 네트워크 경로를 제한하고, 통제되지 않는 도구에는 Go 호출 권한을 주지 않는다. 허용목록은 실제 목적지 기준이다.
- A의 실제 요청과 보조 모델 요청도 지정 DeepSeek인지 확인한다. 제목은 로컬 고정 문자열로 만들 수 있다. 다른 모델을 자동 선택하는 요약·검토·fallback은 허용하지 않는다.
- WebSocket/재사용 연결·첨부 업로드·리다이렉트 등 모든 Go 반출 경로를 검증하지 못하면 그 경로는 비활성화한다. 안전한 전송 경계를 만들기 전 A를 ‘지원 완료’로 표시하지 않는다. B 지원과 A 6단계 요구는 유지한다.
- OFF는 모든 외부 서비스의 전송 금지가 아니다. B의 Claude 전달·Linear 내보내기는 별도 목적지로 표시하되 실제 Go 전송이면 mode=B라도 동일 검사를 적용한다.

근거: `docs/plan/stage-1-db.md:18–18`, `docs/plan/stage-1-db.md:29–32`, `docs/plan/stage-1-db.md:212–212`, `docs/plan/schemas/stage-1-ddl-draft.sql:113–131`, `docs/plan/schemas/stage-1-ddl-draft.sql:930–947`.

### 2.9 연구 질문과 실행 form/permission

- 연구의 범위·판단·승인을 묻는 질문은 PES ask에만 저장한다. OpenCode form을 두 번째 연구 질문 원본으로 두거나 거기서 받은 기본값을 사람 답으로 제출하지 않는다.
- 파일 선택·도구 입력 등 실행 form은 런타임 요청 ID·세션·대상·요구 입력·만료 상태를 PES에 중계할 수 있다. 사용자가 실제로 답한 실행 입력만 해당 form으로 돌려준다.
- 파일 쓰기·셸·네트워크 권한은 수행 범위와 위험을 표시한다. 추천은 작업 폴더 안의 제한된 도구 허용, 범위 밖 요청은 한 번 허용/거부다. 넓은 ‘항상 허용’을 기본으로 만들지 않는다.
- 실행 입력을 기다릴 때도 사람 대기라면 담당을 해제한다. 먼저 추가 모델 호출을 막고, 응답 후 새 담당·정책·기한을 확인한 뒤 reply한다. form/permission reply 자체가 실행을 재개할 수 있음을 시험한다.
- 연결 단절·만료·OFF 후 옛 form에 답해도 자동 재개하지 않는다. 실행 질문 중 ‘단계 승인’ 같은 요청이 나오면 연구 기록·사람 승인 경로로 안내하고 런타임 권한으로 대체하지 않는다.
- B의 셸·파일 권한은 Claude Code/앱에서 집행하는 부분을 구분해 표시한다. PES 프로젝트 토큰과 그 도구의 OS 접근 권한은 서로 다른 경계다.

근거: `docs/plan/stage-0.md:47–48`, `docs/plan/discussion/stage-0-opencode.md:658–668`, `docs/plan/stage-1-db.md:24–24`, `docs/plan/stage-1-db.md:30–32`.

### 2.10 비용·시간·재시도 상한

| 상한 | 정할 값 | 추천 집행 |
|---|---|---|
| run/라운드/프로젝트 누적 비용·사용량 | **미정, 사용자 예산+시험으로 결정** | 요청 전 보수적 예약, 완료 후 실측 정산, 남은 한도 확인 |
| 요청 최대 출력·최대 추론 턴·도구 호출 수 | **미정, 모델·과제 시험으로 결정** | 가능한 런타임 제한+PES 요청 전 차단 |
| 실행 시간·무진행 시간 | **미정, 시험으로 결정** | 실행/대기 시간을 구분, supervisor가 중단 요청 |
| 재시도 횟수·지연·중단 유예 | **미정, 시험으로 결정** | 한 계층이 소유, 기존 실행과 누적 한도를 공유 |

- Go 구독 잔여 허용량과 run에 귀속되는 토큰/실제 비용을 구분한다. 잔액·요금 환산을 모르면 NULL/확인 불가다. 달러 금액이나 ‘무료’로 임의 변환하지 않는다.
- 비용의 정확한 사전 상한이 불가능하면 시간·턴·토큰의 강제 한도와 추정 비용 경고를 따로 표시한다. 비용 불명 요청을 무한 허용하지 않고 보수적 예약/정책상 중지 중 하나로 정한다.
- 재시도·보조 요약·reviewer·새 세션·A/B 인계가 예산을 초기화하면 안 된다. 사람 대기 시간은 모델 실행 시간과 분리하지만 재개 시 남은 예산을 다시 확인한다.
- 읽기/연결 재시도와 유료 prompt 재시도는 다르다. PES 명령은 같은 키로 영수증 확인, 제공자 타임아웃은 결과 조회부터 한다. OFF·권한·스키마·기반 충돌을 자동 재시도하지 않는다.
- 런타임 내부 retry와 어댑터 retry를 중복 적용하지 않는다. 내부 retry/요약 복구도 요청별 허가·잔여 예산을 통과해야 한다. 확인 불가 전송의 예약분을 자동 환불 처리하지 않는다.
- B의 외부 구독·이미 진행 중인 Claude 추론 비용은 PES가 완전히 집행할 수 없다. PES의 작업량·채택·기한 한도와 외부 도구의 실행 한도를 구분하고, ‘중단 요청’과 실제 중단을 따로 기록한다.

근거: `docs/plan/discussion/stage-0-opencode.md:638–665`, `docs/plan/discussion/stage-0-opencode.md:903–911`, `docs/plan/stage-1-db.md:107–113`, `docs/plan/stage-1-db.md:214–214`.

### 2.11 B: Claude Code는 MCP 기본, CLI는 같은 계약의 대안

- 추천 경로: `Claude Code → PES stdio MCP bridge → 로컬 PES HTTP → 명령 서비스`다. 웹 이전 후에는 인증된 HTTP 연결로 바꾸고 업무 의미는 유지한다. MCP stdio/HTTP 경로는 [Claude Code 공식 문서](https://code.claude.com/docs/en/mcp)에 있다.
- 도구는 context/claim/submit/ask/wait/complete를 중심으로 시작하고 heartbeat/release/cancel·영수증 조회를 추가한다. MCP 프로세스의 stdout은 프로토콜만, 로그는 stderr로 분리한다. [MCP 전송 규약](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports).
- CLI도 같은 명령을 호출한다. shell quoting·Windows 공백/한글 경로를 검증하고 결과는 구조화된 JSON과 사람이 읽는 오류를 구분한다. 토큰을 프롬프트·명령 인자·로그에 노출하지 않는다.
- TUI가 닫히면 bridge 연결 종료를 관측해 해제를 요청하되, 강제 종료/잔존 프로세스에는 TTL이 작동한다. 재시작은 상태·담당·미처리 입력·영수증을 읽고 새 claim을 받는다.
- ‘답 기다리기’는 짧은 wait 후 도구 반환이다. 앱/Code 호출을 사람 답까지 무한 블로킹하지 않는다. 도구 연결만 살아 있다고 사람이 없는 동안 새 일을 시작하지 않는다.
- 현재 `/pes:run` 진입점은 유지하되 직접 lock/JSON 편집/Monitor가 원본이던 절차를 새 계약으로 교체한다. `PES_OWNER`는 표시·호환 정보일 뿐 인증 토큰이나 fence가 아니다.

근거: `commands/run.md:6–15`, `skills/core/SKILL.md:16–25`, `skills/core/SKILL.md:109–118`, `docs/plan/discussion/stage-0-opencode.md:678–715`, `docs/plan/stage-1-db.md:190–198`.

### 2.12 B: Claude 앱의 실제 연결 후보

‘Claude 앱’을 원격 HTTP를 직접 부르는 상주 에이전트로 취급하지 않는다. 클라이언트 종류·기능·조직 정책을 확인하고 다음 세 경로의 지원 수준을 각각 표시한다.

| 경로 | 실제 데이터 흐름 | 추천·한계 |
|---|---|---|
| Desktop 로컬 확장 | Claude Desktop → 로컬 stdio PES bridge → loopback PES API | **로컬 기본 검증 후보**. custom mcpb 설치·도구 노출·재시작·회수 시험 |
| 원격 커넥터 | Claude 서비스 → 공개 HTTPS MCP → PES API | 5단계 웹 배포 후보. localhost 주소·DB 공유로 해결하지 않음 |
| 명시적 전달 | PES에서 선택 맥락/요청 복사 → 앱에서 작업 → 결과 제안 가져오기 | 로컬 연결 제한/다른 앱 표면에서도 쓸 기본 대안 |

Desktop 확장은 사용자 정의 mcpb와 민감 설정 보호를 제공한다. 원격 커넥터는 Anthropic 서버에서 접속하므로 로컬 주소에 닿는 것으로 가정할 수 없다. [로컬 확장 공식 안내](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop), [원격 연결 공식 안내](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).

- 같은 Python MCP bridge를 확장으로 포장하는 안을 먼저 검증한다. Node/Python 런타임 가용성·실행 경로·Windows 설치·사용자별 토큰 설정·앱 내 사용 표면을 실제 설치 시험으로 확정한다.
- 앱 대화가 끝났거나 백그라운드 도구 호출이 없으면 heartbeat/수신을 가정하지 않는다. 질문·답은 PES에 남기고 다음 명시적 도구 호출에서 미처리 입력을 반환한다. ‘앱을 깨워서 이어함’을 약속하지 않는다.
- 연결됨 표시도 마지막 확인 시각·도구 접근 가능 여부다. 실행 담당은 별도다. 긴 앱 작업의 lease가 만료되면 반환 결과를 제안으로 보존하고 최신 기반 대조 뒤 새 담당으로 채택한다.
- 재접속 첫 절차는 context→새 입력 목록→명시적 수신 확인→claim이다. 앱이 읽지 않은 답을 seen으로 표시하지 않으며, applied는 실제 적용 결과와 연결한다.
- 로컬 확장을 쓸 수 없다는 사실이 밝혀지면 임의 터널을 열지 않는다. 명시적 전달 경로를 제공하고 ‘도구 연결 미검증/사용 불가’와 ‘전달 모드 사용 가능’을 구분한다.
- 원격 커넥터·WebMCP·Claude Code 플러그인은 서로 대체품이 아니다. WebMCP를 Claude 앱 연결 구현이라고 계산하지 않는다. 앱에서 Code 전용 Agent 문법을 쓸 수 있다고도 가정하지 않는다.

근거: `docs/plan/stage-0.md:89–89`, `docs/plan/stage-1-db.md:162–162`, `docs/plan/stage-1-db.md:214–214`, `docs/plan/research/webmcp.md:15–24`.

### 2.13 명시적 전달도 PES의 기록으로 끝나야 한다

1. 사람은 선택한 질문·결과·결정·근거·기대 출력 형식을 미리 보고 ‘프롬프트로 복사/전달 묶음’을 만든다. 프로젝트·판·단계·라운드·기반 버전·요청 식별자·manifest hash를 포함한다. 토큰·비밀 설정·전체 프로젝트 자동 포함은 금지한다.
2. 복사만으로 run을 실행 중으로 만들거나 lease를 계속 잡지 않는다. 이 경로의 앱 결과는 **오프라인 제안**이다. 사람에게 ‘전달됨’과 ‘PES가 수신 확인함’의 차이를 표시한다.
3. 앱 결과는 JSON/Markdown·첨부 제안으로 가져온다. 크기·형식·출처·파일 hash·기반 버전·요청 식별자를 검증하고 변경 대조를 보여 준다. 앱이 쓴 승인·정책 변경·명령 실행 문자열은 데이터다.
4. 실제 채택 때 새 담당을 획득해 최신 rev와 대조하고 같은 명령 서비스로 저장한다. 기반이 바뀌면 재검토하며 자동 덮어쓰지 않는다. 미처리 입력을 반영했는지도 항목별 확인한다.
5. 수동 가져오기의 실제 제출자는 사람이고 외부 작성 도구 표시는 별도 출처다. 인증 없는 붙여넣기를 인증된 claude_app actor 제출로 위장하지 않는다. run.actor/버전 actor/작성 도구·모델의 표현은 DB/API에서 확정한다.
6. 결과 채택/입력 적용 영수증을 PES에 남겨야 전달 작업이 끝난다. ‘복사됨’이나 앱의 ‘완료’ 문장으로 적용 기록·사람 승인을 만들지 않는다. 자동 MCP 연결 성공과 전달 모드 성공을 따로 보고한다.

근거: `docs/plan/research/notion-linear.md:143–149`, `docs/plan/stage-1-db.md:24–26`, `docs/plan/stage-1-db.md:30–32`, `docs/plan/stage-1-db.md:110–111`, `docs/plan/schemas/stage-1-ddl-draft.sql:526–575`.

### 2.14 스킬 중립화: 절차 하나, 실행 노트만 분리

추천 구조는 중립 단계 스킬+공통 역할 명세+`opencode`/`claude-code`/`claude-app` 어댑터 노트다. 이는 후속 파일 구성안이며 이번에 파일을 옮기거나 스킬을 실행하지 않는다.

| 현행 결합 | 중립 계약 | 어댑터 노트의 책임 |
|---|---|---|
| AskUserQuestion | ask_human(질문/폼 버전) | PES 질문 등록·화면 링크. 채팅 답은 명시적 제안 가져오기 |
| CLAUDE_PLUGIN_ROOT | pes 실행 경로/설치 정보 | Code 플러그인 위치, A 실행 디렉터리, 앱 bridge 경로 |
| Agent·pes:researcher 등 | 수행 역할·입출력·도구 능력 | native subagent/새 세션/역할별 전달로 매핑 |
| model opus·sonnet·mixed | 단계 스킬에서 모델명 제거 | A는 지정 DeepSeek만, B는 실제 모델 기록·미상 표시 |
| anthropic-skills:hwpx-uri/docx/pdf/pptx | export(format, 기준 원고 버전, 스타일 규칙) | 사용 가능한 변환 도구·필수 의존성·검증/실패 경로 |
| 직접 JSON 편집·merge·mark | validated submit·입력 적용 영수증 | 같은 HTTP/MCP/CLI 의미, 직접 상태 쓰기 없음 |
| PES_OWNER·lock --force | actor 토큰·claim·명시적 인계 | 기존 표시와 새 권한/담당의 차이를 안내 |

- core+plan부터 중립 계약을 파일럿하고 6단계·commands·역할 파일 전체로 확장한다. A/B별 연구 절차를 복제하지 않는다. 실행 가능한 명령 예제는 어댑터 노트에 둔다.
- 모델 정책 역할을 넣더라도 strong/cheap을 A의 다른 모델로 매핑하지 않는다. 역할은 연구 책임이며 모델 등급과 별개다. verifier의 실제 출처 확인 도구도 모델명 변경으로 대체할 수 없다.
- hwpx 변환은 stage-0에서 마지막으로 미룬 검증을 별도로 따른다. 이름만 중립화해 변환 지원을 주장하지 않는다. 변환은 고정 원고의 새 파일을 만들고 ready 검증 뒤 등록한다.
- 공통 스킬/명령/역할 정의의 Claude 전용 토큰과 직접 DB/JSON 쓰기 예제를 lint 대상으로 한다. 어댑터 노트·현행 동작 설명·보관 문서는 허용 위치를 명시한다. 단순 문자열 전체 금지로 역사 문서를 깨지 않는다.
- 독립 검토·근거 확인·원문 못 읽음·출처 확인 방법·한글 문체 규칙은 유지한다. provider 전용 문법을 없애는 작업과 연구 품질 규칙을 없애는 작업을 섞지 않는다.

근거: `skills/core/SKILL.md:16–25`, `skills/core/SKILL.md:62–84`, `skills/core/SKILL.md:120–134`, `skills/core/SKILL.md:154–156`, `skills/research/SKILL.md:30–34`, `skills/publish/SKILL.md:14–24`, `docs/plan/discussion/stage-0-opencode.md:719–756`, `docs/plan/00-brief.md:43–45`.

### 2.15 researcher·reviewer·verifier·writer의 A/B 대응

역할의 입력·결과·품질 기준을 공통으로 둔다. **초기 기본은 역할별 순차 실행과 단일 채택 담당**을 추천한다. native subagent 유무와 무관하게 reviewer는 별도 맥락에서 검토할 수 있어야 한다.

| 역할 | 공통 책임 | A | B Code / B 앱 |
|---|---|---|---|
| researcher | 항목 범위 조사·출처/확인 방법·통계·열린 문제 | 역할별 세션, 지정 DeepSeek+확인 도구 | Code 역할 실행/서브에이전트, 앱은 조사 역할 전달 |
| reviewer | 모든 라운드의 QC/QA·표본 대조·독립 판단 | 별도 세션/맥락, 동일 DeepSeek | Code 별도 reviewer, 앱 별도 대화/역할 전달 |
| verifier | 주장별 원문 대조·supported/partial/unsupported와 근거 | 동일 DeepSeek+출처 도구 | Code verifier, 앱은 확인 도구 없으면 미확인 명시 |
| writer | 고정된 근거로 장·절 집필·각주, 부족한 근거 질문 | 동일 DeepSeek, 허용 도구 제한 | Code writer, 앱은 장별 원고 제안 |

- reviewer에게 메인의 기대 결론을 주지 않는다. 기획·기준·결과·근거로 먼저 판단하고 자체 점검은 나중에 비교한다. 같은 모델의 다른 세션 검토를 ‘다른 모델이 검증’했다고 표현하지 않는다.
- 역할별 직접 제출이 필요하면 각 역할을 별도 run으로 순서대로 실행하고 매번 담당을 인계한다. 조정용 코드가 그동안 별도 lease를 잡지 않는다. reviewer 보고서도 reviewer run/actor의 결과로 채택한다.
- DDL의 runs.role은 worker/reviewer 두 값이다. researcher/verifier/writer를 그 열에 바로 넣지 않는다. worker의 세부 역할은 고정 workflow/입력 manifest의 task_role 같은 메타데이터로 표현하는 안을 DB/API에 넘긴다.
- native subagent를 쓰면 자식은 범위가 정해진 제안만 반환하고 별도 PES writer 권한을 받지 않는 안을 우선한다. 실제 자식·모델·도구 결과·부모의 채택 관계를 보존한다. reviewer의 독립 제출은 별도 run 방식으로 검증한다.
- 기존 조사의 최대 5개 병렬 실행은 현행 동작으로 기록한다. 2단계 최소 보장과 병렬 최적화는 구분하되 기존 설정을 무시해 조용히 직렬화하지 말고 지원 수준을 안내한다. 동시 제안 생성도 parent 기한·예산·OFF를 공유해야 한다.
- Claude Code는 별도 맥락의 서브에이전트를 지원하지만 앱에 같은 primitive가 있다고 가정하지 않는다. 앱은 역할별 별도 대화·명시적 입력/출력으로 대체하고 독립 검토 여부를 표시한다. [Code 서브에이전트 문서](https://code.claude.com/docs/en/sub-agents).

근거: `agents/researcher.md:6–24`, `agents/reviewer.md:6–12`, `agents/reviewer.md:30–49`, `agents/verifier.md:6–21`, `agents/writer.md:6–20`, `skills/core/SKILL.md:120–126`, `skills/research/SKILL.md:30–34`, `docs/plan/schemas/stage-1-ddl-draft.sql:823–843`.

### 2.16 A→B, B→A 인계

인계 단위는 제공자 대화가 아니라 **현재 채택된 고정본+남은 일+미처리 입력**이다. 새 방식은 새 run으로 기록한다. 자동 fallback으로 공급자를 바꾸지 않는다.

1. 사람의 인계 요청 또는 기존 실행의 명시적 해제로 출발한다. 코어는 기존 담당/기반을 대조하고 옛 실행의 추가 채택을 막는다. 자발적 반납은 가능하되 다른 담당 강제 회수는 사람 권한으로 제한한다.
2. 옛 런타임 중단·미완료 요청 취소를 시도하고 결과를 기록한다. 담당 회수는 외부 프로세스 종료와 별개다. 중단 확인이 안 되면 추가 비용·부작용 가능성을 표시하고 병행 실행을 몰래 시작하지 않는다.
3. 인계 묶음은 현재 판/단계/라운드, 대상·기반 버전, 결정·가정, 미응답/재확인 질문, 답·첨언·후속·입력 영수증, 검토 지적, 파일 참조, 정책·잔여 예산, 사건 커서를 포함한다.
4. 새 run은 mode/runtime/실제 actor·모델·workflow_version과 앞 실행 관계를 기록한다. 인계는 retry와 의미가 다르므로 retry_of를 무조건 쓰지 않는다. parent_run_id/별도 관계 사건의 의미를 API에서 확정한다.
5. 새 담당은 새 fence를 받고 최신 기반을 재조회한다. 옛 결과/입력 적용 기록을 참고하되 같은 답을 중복 반영하지 않는다. 지연된 옛 submit/heartbeat/reply는 거절하며 임시 제안이 필요하면 대조 경로로 보존한다.
6. A→B는 Go OFF여도 PES 맥락을 조회해 전달할 수 있다. OpenCode 숨은 transcript 전체를 자동 첨부하지 않는다. 이미 Go로 나간 자료의 회수를 인계 성공 조건으로 삼지 않는다.
7. B→A는 새 Go 반출이므로 현재 정책·DeepSeek·예산·요청별 검사 통과가 필요하다. OFF이면 사람에게 차단 이유를 보이고 B를 유지한다. 인계가 소유자 재허용을 대신할 수 없다.

근거: `docs/plan/stage-1-db.md:19–24`, `docs/plan/stage-1-db.md:29–32`, `docs/plan/stage-1-db.md:107–117`, `docs/plan/stage-1-db.md:212–214`, `docs/plan/discussion/stage-0-opencode.md:925–940`.

### 2.17 로컬에서 웹으로 옮길 때의 실행 경계

- 2단계는 로컬 코어·SQLite·객체 저장소와 로컬 runner로 완성한다. 전송 토큰은 프로젝트 범위·최소 권한으로 발급하고 rev/lease는 인증을 대체하지 않는다.
- 5단계의 Workers/D1/R2가 OpenCode나 Claude Code 로컬 프로세스를 직접 실행한다고 가정하지 않는다. 웹 PES에 접속하는 별도 runner가 필요하고 연결 인증·철회·자료 전달·원격 중단 가능 범위를 설계한다.
- 로컬 HTTP는 loopback·인증·출처 검사를 사용한다. localhost를 안다고 권한을 주거나 CORS를 전부 풀지 않는다. 웹·로컬 토큰과 OpenCode/Claude 인증 자료도 분리한다.
- 로그는 request/run/dispatch 식별자·상태·오류 중심이며 원문·키·전체 prompt/첨부를 공개 CI에 남기지 않는다. 필요한 연구 전송 증거는 보호된 객체/manifest로 보존하고 일반 사건 payload를 작게 유지한다.
- 입력 외부 글·앱 출력·Linear 내용은 자료다. 도구 호출·승인 권한 지시로 승격하지 않는다. Linear·Notion은 선택 내보내기이며 실행 큐나 PES 결정 원본으로 삼지 않는다.
- WebMCP는 별도 브라우저 actor의 얇은 통로다. A/B 실행·앱 연결의 전제에서 제외하고 승인·reopen·판 시작은 노출하지 않는다.

근거: `docs/plan/stage-1-db.md:19–21`, `docs/plan/stage-1-db.md:30–31`, `docs/plan/stage-1-db.md:111–124`, `docs/plan/research/notion-linear.md:149–163`, `docs/plan/research/webmcp.md:15–37`.

## 3. 방식 A·B 차이

| 항목 | A: PES 관리 OpenCode | B: Claude Code | B: Claude 앱 |
|---|---|---|---|
| 실행 시작 | PES가 명시적 요청 후 세션/prompt 호출 | 사용자 Code에서 PES 도구/명령 | 로컬 도구 호출 또는 사람이 전달 |
| 실행 소유 | PES supervisor가 프로세스·세션 관측 | 외부 TUI, bridge로 일부 관측 | 대화/앱의 지속 실행을 가정 안 함 |
| 모델 | 지정 DeepSeek 하나, 보조 요청도 검사 | 실제 모델 기록, 미상이면 표시 | 확인 가능한 값만, 전달자 주장과 구분 |
| 도구 연결 | OpenCode API 제어+PES 업무 API | MCP 기본, CLI 대안 | Desktop 로컬 MCP 우선 시험, 전달 대안 |
| 연구 질문 | PES 원본 | PES 원본 | PES 원본, 붙여넣기는 아직 제안 |
| 실행 권한 | PES에 OpenCode 요청 중계 | Code 도구 권한 경로 | 앱/확장 권한, PES 사람 승인과 구분 |
| 사람 대기 | waiting_human, lease 해제, 재개 확인 | 짧은 wait 반환, lease 해제 | 앱을 닫아도 입력은 PES 보존 |
| heartbeat | supervisor의 실제 실행 증거로 갱신 | bridge/런타임 증거, 종료 시 만료 | 지속 heartbeat 없음, 작업 구간/재접속 기준 |
| 중단 보장 | interrupt+전용 프로세스·반출 검사 범위 | PES 채택 중단과 TUI 종료 구분 | PES 채택 중단, 앱 추론 종료 보장 안 함 |
| Go OFF | 모든 실제 Go 반출 차단 | Go를 쓰면 같은 검사, Claude는 별도 | 동일. 복사·Claude 전송과 Go 정책 구분 |
| 비용 | Go 허용량·실측·강제 한도 대조 | 외부 구독 사용량은 관측 한계 | 같은 한계, 확인 불가를 0으로 쓰지 않음 |
| 복구 | 세션 대조 또는 PES 고정본 새 세션 | 재시작→입력/영수증→새 claim | 재접속 호출 또는 제안 가져오기→재검토 |

공통은 같은 결과·근거·질문/답·오류·승인 구분·버전 보존·단일 실행 담당이다. 연결 기능 차이를 숨겨 A/B 화면의 ‘접수/읽음/반영/중단 확인’ 의미가 달라지면 안 된다.

## 4. 완료 기준

### 4.1 SEL-24 설계 완료

- [ ] 공통 상태/계약·A/B 책임·인계·Go 강제 지점과 미정 계약을 종합 설계서에 기록한다. 본 의견서는 확정 설계나 실행 성공 보고가 아니다.
- [ ] Claude Code와 Claude 앱 각각 최소 연결/전달·단절·재접속 절차와 지원 수준을 명시한다. 앱을 삭제하거나 ‘나중에’ 한 줄로 넘기지 않는다.
- [ ] SEL-18·19 측정 계획·변수·채택 기준을 정한다. TTL/상한 수치는 미정으로 남기되 검증 없이 기본값을 확정하지 않는다.
- [ ] SEL-21·22·23과 actor/lease/run·반출/접수 경계의 차이를 해소하고 기존 22개 PR에 연결한다.

### 4.2 구현·실험 통과 조건

| 검사 | 통과 조건 | 담당 |
|---|---|---|
| 격리·CI | 합성 자료·임시 홈/객체/런타임 프로필·stub, 실제 PES 자료/키 읽기 없음 | 각 PR, PR 21·22 |
| 공통 라운드 | context→claim→submit→ask→답→재개→complete, 같은 업무 결과·승인 별도 | SEL-18·19, PR 13·14·19·20 |
| A 버전·범위 | 2.2.5 필수 API·Go 인증·DeepSeek 확인, 6단계 각각 실행·질문·검토·결과 등록 | SEL-18, PR 19 |
| A 이벤트·중단 | 중복/누락 이벤트·prompt 응답 유실·idle interrupt·서버 재시작에 중복 실행/채택 방지 | PR 19·21 |
| Go 강제 차단 | OFF 전·직전·직후, title/compaction/도구 결과/첨부/retry/자식/transport별 반출과 허가 시각 대조 | PR 10·19·21 |
| Go 실패 경계 | 검사 서비스 불통·누락 정책·unknown·훅 실패·검사 뒤 요청 수정·ON 재허용 시 자동 재개 없음 | PR 10·19·21 |
| Code 종료 | 정상/강제 TUI 종료·bridge 잔존·절전 후 만료, 옛 heartbeat/submit 거절 | SEL-19, PR 5·20·21 |
| 앱 실제 경로 | Windows/macOS 로컬 확장 설치→도구 왕복, 또는 제한 사유+명시적 전달/가져오기 왕복 | SEL-19, PR 20·22 |
| 앱 대기·재접속 | 앱 종료 중 사람 답 접수, 재접속 시 미처리 입력 제공, seen과 applied 구별·중복 반영 없음 | PR 5·20·21 |
| 담당·충돌 | 두 claim 중 하나만 성공, 0행 충돌 전체 롤백, 질문 대기 lease 해제·사람 입력 가능 | PR 4·5·14·21 |
| 인계 | A→B/B→A 각각 최신 기반·새 fence, 옛 지연 결과 거절, OFF에서 B→A 차단 | PR 5·19·20·21 |
| 역할·스킬 | 4역할 입력/출력·실제 작성자 추적, 독립 reviewer, 중립 스킬 lint·직접 상태 쓰기 없음 | PR 17·19·20·21 |
| 비용·시간 | 실측/미상·누적 예약·retry 중첩·상한 도달·중단 유예·잔여 프로세스 확인 | SEL-18·19, PR 19·20·21 |

CI는 stub/가상 시계로 재현하고 실제 공급자 시험은 분리한다. 실시험은 합성 자료·별도 시험 자격 증명만 사용하며 키·연구 본문을 공개 fixture/로그로 저장하지 않는다. 현재는 어느 실시험도 통과했다고 주장하지 않는다.

## 5. 사용자 결정이 필요한 것 (추천 포함)

| 새 안건 | 선택지 | 추천 |
|---|---|---|
| 자동 재개 | 매번 실행 누르기 / 이미 허용한 작업은 답 접수 후 재개 | 초기에는 명시적 재개. 자동 재개를 고르면 질문/정책/한도 변경 시 멈춤을 명시 |
| 앱에서 주로 쓸 경로 | Desktop 로컬 확장 / 웹·모바일 명시적 전달 | 로컬 확장 우선 검증+전달 대안. 앱 종류·조직 제한이 확인되면 경로 확정 |
| 실행 예산·기다릴 시간 | 사용자 상한 / 시험 추천 상한 채택 | 합성 시험 측정치를 먼저 제시하고 run·누적 상한 승인. 무제한을 묵시 기본으로 두지 않음 |
| 초기 병렬 범위 | 순차 역할 보장 / 읽기·제안 병렬도 초기 포함 | 순차 채택·역할 보장을 우선. 기존 parallel 설정의 처리와 성능 차이를 안내 |
| 중단 미확인 인계 | 기다리기 / 상태·비용을 확인하고 새 담당 시작 | 먼저 중단 대조, 불명 상태에서의 중복 외부 실행은 사람의 명시적 판단 |

Go 전송 기본 켜짐·프로젝트별 끄기, DeepSeek 6단계, Claude 앱 지원 여부, 공개/CI, 단일 실행 담당은 위 선택지에 넣지 않는다. TTL·heartbeat·transport 세부 수치는 사용자에게 임의로 고르게 하지 않고 실험으로 추천안을 만든다.

## 6. 다른 설계와 2단계로 넘길 것

| 대상 | 인계할 계약/차이 | 이번 의견의 경계 |
|---|---|---|
| DB, SEL-21 후속 | 세부 task_role·세션 매핑·한도/예약·실행 권한 요청 증거를 manifest/사건으로 표현할지 | 현재 열에 있다고 가정하지 않음. 새 표 필요성부터 검토 |
| DB/API | system supervisor 제어와 run 작성 actor 구분 | mutation_commits의 run_id+actor FK는 해당 run.actor를 요구. system 이벤트를 AI 작성으로 위장하지 않고 run_id 생략+관련 사건 또는 명시적 모델 보완 검토 |
| DB/API | 수동 앱 제안의 실제 제출자·작성 도구·미검증 모델 출처, 인계와 retry 관계 | 사람 가져오기를 인증된 외부 actor로 둔갑시키지 않음 |
| API, SEL-22 | claim 주체·첫 prompt 이전 획득, ask+담당 해제 원자성, receipt 확인·입력 적용·rev 충돌 | API 의견의 시작 순서·TTL 후보와 조정 필요 |
| API, SEL-22 | 내부 반출 허가/취소·정책 순서·최종 요청 manifest·unknown·actor 범위 | 일반 에이전트 토큰에 Go 재허용 권한을 추가하지 않음 |
| 화면, SEL-23 | 실제 실행/연결·접수/읽음/반영·대기/만료·중단 요청/확인·Go 허용과 전송 상태 | 입력 중 갱신·A/B 전환에도 답/첨언 유지, 과장된 연결 표시 금지 |
| 실행, SEL-24 종합 | 전용 프로세스·훅/transport 거부 가능성·자식 회수·한도·앱 확장 패키징 | 문서 존재와 바이너리 실험 결과를 분리 |
| 2단계 | DB/API·CLI/MCP 전환, 기존 스킬 직접 쓰기 제거, 기본 A/B·인계·합성 통합 검사 | 기존 PR 18은 새 디자인 없음. 전환할 때 실제 프로젝트는 별도 허용 범위 |
| 3·4단계 | 첨언/가정/반영 후속 자동화·명령 팔레트, 새 판·갈림길·AI 반대 의견 | 실행 코어를 확장하되 새 런타임 원본 저장소를 만들지 않음 |
| 5·6단계 | 웹 runner 연결·로그인·원격 MCP·알림, 여러 agent/사람의 병렬 최적화 | 운영 D1·원격 실행·왕복 동기화를 2단계에 끼워 넣지 않음 |

근거: `docs/plan/stage-1-db.md:158–163`, `docs/plan/stage-1-db.md:203–215`, `docs/plan/schemas/stage-1-ddl-draft.sql:79–110`, `docs/plan/schemas/stage-1-ddl-draft.sql:823–947`, `docs/plan/00-brief.md:43–51`.

## 7. 구현 이슈 예상: 기존 22개 PR에 붙인다

아래 번호는 stage-1-db 10절의 **PR 번호**이며 새 Linear 번호가 아니다. PR마다 테스트를 포함한다. 어댑터를 API·정책·실행 담당보다 먼저 붙이지 않는다.

| 기존 PR | SEL-24에서 붙일 범위·인수 조건 |
|---|---|
| 1·2 | run/actor/lease/dispatch/receipt 제약, 필요한 보완 확정, SQLite/D1 같은 실패 의미 |
| 3 | 실행/담당 정리 후 export/import, 복원 뒤 옛 토큰/세션/커서·담당 자동 재사용 금지 |
| 4 | 모든 런타임 변경의 검증·0행 실패·멱등 영수증·system/agent 실제 actor |
| 5 | claim/heartbeat/release·waiting_human·만료/회수·인계·fence·입력 receipts, 가상 시계 시험 |
| 6 | run 완료와 봉인/사람 승인 분리, reopen·stale 뒤 실행 기반 무효화 |
| 7·9 | 역할 제안의 출처·버전·각주·파일 ready/hash·고정 manifest 채택 |
| 8 | ask와 질문/폼 버전·옛 답·의견만 응답·재확인·대기 전환 |
| 10 | 프로젝트 actor/토큰·Go 정책·재허용·반출 허가·OFF 경합 계약, 19/20의 선행 |
| 11·12 | 옛 JSON/잠금·processed 흔적을 새 실행/영수증과 구분, 합성 이전·복원 |
| 13·14 | 공통 context/claim/submit/ask/wait/complete, run 제어·오류·커서·영수증·사람 통로 |
| 15·16 | CLI 같은 서비스·경로 quoting, serve/stop/home·doctor의 소유 프로세스/연결 진단 |
| 17 | 중립 core+plan부터 6단계/commands/역할, Claude 표기·직접 쓰기 제거와 lint |
| 18 | 기존 화면 실행/담당·전송 표시·승인 경로·입력 보존, 새 디자인 없음 |
| 19 | A 2.2.5 API+프로세스 supervisor·세션·이벤트·허가 훅/필요 transport·한도·4역할·6단계 |
| 20 | Code MCP+CLI·Desktop 로컬 확장·명시적 전달/가져오기·앱 재접속/만료, 능력별 지원표 |
| 21 | A/B 동일 계약·양방향 인계·지연 응답·프로세스 종료·반출 OFF·예산·중복/충돌 교차 검사 |
| 22 | Windows/macOS 설치/제거·복구·앱 연결 안내·미상 상태·비밀 없는 예제/공개 CI |

**2단계 새 PR 추가는 현재 0개**를 추천한다. supervisor·Go 강제 훅·앱 포장은 PR 19·20의 실행 지원을 완성하는 범위다. 실제 diff가 커지면 먼저 해당 PR의 독립 검증 단위로 나누되 표/테스트별 이슈를 늘리지 않는다.
외부 relay가 별도 배포물이어야 한다는 실험 결과가 나오면 PR 19에서 설계·의존·예산을 다시 제시한다. 아직 필요성이 증명되지 않은 별도 relay 이슈는 만들지 않는다.
5단계 원격 runner/원격 MCP 배포, 6단계 여러 worker의 동시 채택·팀 운영은 새 구현 이슈 후보이며 이번 22개에 포함된 것으로 계산하지 않는다.

근거: `docs/plan/stage-1-db.md:172–199`, `docs/plan/stage-1-db.md:212–215`. 이 문서는 이슈 생성·지원 완료·수치 확정이 아니라 구현 범위와 완료 조건에 대한 의견이다.
