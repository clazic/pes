수정 후 승인

- 재검수일: 2026-11-05. HEAD `75c2405`의 현재 작업 트리를 대상으로, 이전 검수의 **F01~F18·R01~R05**, 1·2차 `2026-11-05-fix-*.md`·`2026-11-05-fix2-*.md`, 이후 직접 정정한 WEB0 시점·MAT1 표 이름을 대조했다. 반영 기록의 완료 선언보다 현재 설계서·이슈 원고·DDL을 우선했다.
- 판정은 **계획 계약의 해소 여부**다. 아직 구현하지 않은 서비스 검사도 담당·계약·완료 조건이 명확하면 해소로 보았다. 서비스 권한 검사를 모두 SQL CHECK로 옮기라고 요구하지 않는다.
- 결과: **해소 17건 / 일부 6건 / 미해소 0건**. 일부인 항목은 **F02·F08·F10·F16·R01·R04**다. 핵심 구조는 개선됐지만, 아래 필수 계약 불일치를 정리한 뒤 승인하는 것이 맞다.
- 이 보고서 외 파일은 수정하지 않았다. 실제 `~/pes-projects`·`~/.pes/`는 읽거나 쓰지 않았고, 검사에는 임시 HOME·USERPROFILE·PES_HOME과 합성 메모리 DB만 사용했다. 아래 파일 위치는 `docs/plan/` 기준이며 줄 번호는 재검수 시점이다.

## 필수 F01~F18 재확인

| 항목 | 판정 | 파일:행 근거·남은 일 |
|---|---|---|
| F01 WEB0 언어·선행 | **해소** | `issues/stage-2.md:9`, `stage-2.md:36`, `roadmap.md:51`, `issues/stage-5.md:19`, `spikes/web0-plan.md:7,33~39`: **PR1 전**, 현재 JSON fixture 38개·최소 TS 구현, PR4·13 산출물 불필요로 맞췄다. Claude의 추가 시점 정정도 반영돼 있다. 시험 구현 경로의 새 불일치는 N06에 별도 기록했다. |
| F02 새 Python 구현·시험 지시 | **일부** | `issues/stage-2.md:6,424~440`, `issues/stage-3.md:6~7`, `stage-3.md:59`, `decisions/0016-core-language.md:26~33`: 새 기능·시험의 TS 배정, 기존 0.15 이전, 로컬 TS 런타임은 정리됐다. 그러나 **4단계 완료 게이트의 `pytest`**(`stage-4.md:212`)와 **PR26 전까지만 보존할 Python 검사기를 4~6단계에서 수정·실행하라는 계약**(`issues/stage-4.md:9,25`, `issues/stage-6.md:8~10,48,59`)이 남는다. PR26의 TS 검사기 후속 경로·동등성·인계를 명시해야 한다(N05). |
| F03 플랫폼 결과를 실행 계획에 인계 | **해소** | `decisions/0005-web-platform.md:19,25~28`, `stage-5.md:48,363`, `issues/stage-5.md:11`, `spikes/web0-plan.md:98~107`: 공통 계약과 Cloudflare 기준 구현을 구분하고, Vercel/VPS 선택 시 부품 치환·승인된 예산으로 시험하도록 했다. 개별 Free 문구는 이 공통 조건 아래의 기준 구현으로 읽는다. |
| F04 A 생성·B 최초 등록 | **해소** | `stage-2.md:216~217,237`, `issues/stage-2.md:218,230,240,248,347,353`, `issues/stage-5.md:95~96,111`: `project.create/register`의 PR13/14 담당, owner·초기 정책·첫 판의 원자성, 토큰 없는 최초 기기 승인, 일반 에이전트 우회 금지, 빈 계정 시험과 WEB3 UI가 배정됐다. |
| F05 Go 경로·모델·과금 응답 | **해소** | `stage-1-runners.md:23,29,70~71,120`, `decisions/0013-mode-a-go-subscription-and-model-choice.md:62,68`, `issues/stage-5.md:25`: 옛 `/inference/go/...`는 후보로 낮추고, 공식 계열 경로·모델 목록·원시/내부 ID 매핑·구독 적용을 PR19/SEL-18 검증에 넘겼다. `cost=0`과 billing source·allowance를 구분한다. **실제 Go 호출 검증 완료라는 판정은 아니다.** |
| F06 한도·Extra Usage OFF | **해소** | `stage-1-runners.md:24,67~70`, `decisions/0013-mode-a-go-subscription-and-model-choice.md:53~62`, `issues/stage-2.md:324~335`: 계정 기준점·외부 사용량 미상 차단, OFF 증거·유효 기간·수동 확인, 다음 호출 상한 예약, 병렬/인계/재시작 누적, unknown 예약 보존이 명시됐다. 담당은 PR19이며 가짜 서버 시험도 있다. |
| F07 외부 호출과 PES 저장 멱등 | **해소** | `stage-1-runners.md:32`, `stage-5.md:202`, `schemas/stage-1-ddl-draft.sql:1114~1149`, `schemas/check_ddl.py:442~444,523~534`: attempt·상관키와 response/adopted/unknown 필드가 생겼고, 세션 헤더는 라우팅·캐시용으로 정정됐다. 응답 유실 자동 재호출 금지·저장 재시도 분리·가짜 Go 호출 횟수 검사는 PR19/WEB7 서비스 몫으로 명확하다. |
| F08 파일 정책 식별·FK·엄격 우선 | **일부** | `schemas/stage-1-ddl-draft.sql:476~554`, `schemas/check_ddl.py:388~400,511~522`: blob별 현재 정책·정책 이력·추출본 FK가 추가돼 role 우회와 존재하지 않는 정책 이력은 개선됐다. **owner만 재허용·불변 이력·원본 deny의 추출본 적용은 PR9·10/MAT1 서비스 검사로 배정되어 해소**(`stage-1-db.md:76~78,195`, `issues/stage-3.md:276~287`). 다만 문서는 없는 열 **`file_policies.file_policy_id`**를 쓰고, 서로 다른 원본/텍스트 blob도 같은 정책 ID를 쓰는 듯 설명한다(`stage-1-ui.md:52`, `stage-3.md:266,273`, `issues/stage-3.md:272,277`). 실제 키·파생본 정책 관계에 맞춰 정리해야 한다(N01·N02). |
| F09 B 로컬 파일의 deny 우회 | **해소** | `stage-3.md:267,273`, `stage-5.md:239`, `issues/stage-5.md:364,372`, `issues/stage-6.md:247`: 사람 보관 영역/AI workspace·자격 분리, 파일·셸·업로드 권한 통제, 여섯 도구의 직접 읽기·캐시·OFF 후 재접속 시험이 있다. 통제 불가 경로는 제외를 보장한다고 표시하지 않는다. |
| F10 참조 스냅숏 삭제 | **일부** | `schemas/stage-1-ddl-draft.sql:70~94`, `stage-1-db.md:141`, `stage-3.md:250`, `schemas/check_ddl.py:489~496`: RESTRICT와 **명시적 snapshot FK 해제 후 tombstone·key 보존**으로 바뀌었고 합성 삭제 회귀는 통과한다. 그러나 `issues/stage-3.md:250`은 여전히 **“FK를 NULL로 만들지 않고”**라고 요구해 구현 계약이 정반대다. 이슈 원고를 명시적 해제 절차와 맞춰야 한다(N03). |
| F11 참조의 이전·복원 경계 | **해소** | `schemas/stage-1-ddl-draft.sql:69~89`, `stage-1-db.md:141`, `stage-3.md:250`, `issues/stage-3.md:251,264`, `issues/stage-5.md:238,254,282`: 원본의 안정 key와 nullable 로컬 포인터, A-only 이전의 source_missing, B 묵시적 export 금지·재연결·엄격한 원본 권한 검사가 표현됐다. PR3/12·REF1·WEB9/10의 시험 인계도 명시됐다. F10의 원고 모순은 별도다. |
| F12 도우미·WebSocket의 쓰기/권한 | **해소** | `stage-1-api.md:86~101`, `schemas/stage-1-ddl-draft.sql:558~621`, `issues/stage-5.md:359~370,374`, `issues/stage-5.md:299~306`: 닫힌 sync/schedule/progress 명령·actor/scope·매 메시지 현재 권한·expected rev·멱등·같은 tx가 명시됐다. helper 자격과 sync/schedule의 tx FK도 맞는다. WEB15 후속 보안 게이트와 WEB11 선행을 분리해 순환을 만들지 않았다. 자격 발급·회수·가짜 완료 거부는 WEB15 서비스 검사로 넘긴 것이 명확하다. |
| F13 사용량 차단 상태·재개 | **해소** | `schemas/stage-1-ddl-draft.sql:1008~1031`, `schemas/check_ddl.py:497~509`, `stage-1-runners.md:69`, `issues/stage-2.md:326,335`, `issues/stage-5.md:194,206`: `blocked_usage`·사유·시각·nullable reset이 일치하고 잘못된 조합을 거부한다. lease 해제·사람 재개·C4/R1 준비/정책/새 claim 검사는 서비스 담당으로 명시됐다. |
| F14 A의 HWPX PC 의존 | **해소** | `spikes/web0-plan.md:83~87`, `issues/stage-5.md:24,46,62`, `issues/stage-6.md:349~369,377~378`: WEB0의 후보별 판정→WEB1 실행 경계→X1 서버측/브라우저 변환으로 연결됐다. 로컬 변환기는 보조이며, 두 경로가 불가하면 A 지원 범위 변경을 사용자 결정으로 올린다. 외부 변환기는 TS 코어 밖 도구 경계다. |
| F15 Oracle 공식 수치 | **해소** | `stage-5.md:56,214`, `decisions/0005-web-platform.md:22`, `spikes/web0-plan.md:79~80`, `issues/stage-5.md:23`: 이전 검수에서 확인한 1,500 OCPU-h·9,000 GB-h/월, 상시 2 OCPU·12GB, 7일 각 지표 20% 미만 기준으로 바꿨다. 계정/지역/카드는 실측, Hetzner 총액은 미확인/견적으로 구분했다. 과거 차수 기록의 옛 수치는 현행 기준으로 판정하지 않았다. |
| F16 이슈·표 수 집계 | **일부** | `roadmap.md:28~42`, `summary-for-approval.md:38`, `stage-1-db.md:33,178,182~210`: 이슈 **25/11/9/16/9, 전체 101, 여유 159**와 DB PR20a/b/c·26 목록은 맞는다. 그러나 새 `file_policies`로 실제 **61표**인데 `stage-2.md:186`, `issues/stage-2.md:13,20,25`, `issues/stage-5.md:47`은 여전히 **60표**를 현행 마이그레이션/시험 기준으로 요구한다. `glossary.md:135`의 PR1~22=22개 설명에도 현행/과거 구분이 없다(N04). |
| F17 WebSocket·MCP·WebMCP 역할 | **해소** | `stage-1-runners.md:38,44`, `stage-5.md:247~251`, `issues/stage-5.md:365,374`: PC 도우미↔웹은 WS/HTTP, AI 도구↔PES는 MCP/API, WebMCP는 브라우저 탭 보조로 맞췄다. WebMCP만으로 PC 연결 요구를 충족하지 않는다고 명시한다. |
| F18 Workflow instance 한도 | **해소** | `stage-5.md:199~200`, `stage-1-runners.md:72`, `spikes/web0-plan.md:66~68`, `issues/stage-5.md:22`, `stage-5.md:373`: 50 subrequest를 **instance 전체**로 바로잡았다. 새 instance의 claim/fence와 사용량·unknown·attempt의 승계를 WEB0/6/7 시험에 배정했고, 새 step으로 예산을 초기화한다는 지시는 제거했다. |

## 권장 R01~R05 재확인

| 항목 | 판정 | 파일:행 근거·남은 일 |
|---|---|---|
| R01 A 도구와 U3/U4 매핑 | **일부** | `decisions/0013-mode-a-go-subscription-and-model-choice.md:39~47`, `stage-1-runners.md:26`, `stage-3.md:91,103`: 정확한 allowlist와 가정·반영·답글·후속 제안 매핑은 생겼다. 그러나 **결정 제안**은 빠졌다. `stage-5.md:181`은 `decision:propose`/`pes_decision`을, `stage-3.md:30,188`은 A의 결정 제안을 요구한다. A에 해당 명령을 허용하거나 `result.submit` 등으로 수행하는 정확한 매핑·시험을 적어야 한다(N07). |
| R02 공개 수치와 실측 분리 | **해소** | `stage-5.md:243~244`, `decisions/0005-web-platform.md:23~24`, `issues/stage-5.md:362,371`: DO 20:1은 과금 계산, 메트릭은 실제 수, Free cap은 실측으로 분리했다. Vercel은 모든 플랜·최대 함수 시간 뒤 종료라는 이전 검수 기준을 반영하고, 배포 계정 재확인을 남겼다. |
| R03 확정 사항과 남은 사용자 결정 | **해소** | `roadmap.md:126,139~149`, `summary-for-approval.md:66,71~81`, `decisions/0016-core-language.md:24~29`: TS/0.15 이전·파일 기본 allow·B 양방향은 다시 묻지 않는다. 런타임 실측과 플랫폼 조합 전체·카드·총비용·자료 위치·검색 공급자/반출 범위·기본 모델 변경을 구분했다. |
| R04 근거·상태·검증 차수 | **일부** | `stage-6.md:211~221`의 DDL 인용은 표 이름으로, `decisions/README.md:43`의 0002는 일부 대체로 정정됐다. 두 변경 기록 첫머리도 8차·101개·61표를 안내한다. 다만 `discussion/2026-11-05-mode-a-web-direct-and-references.md:163`의 **“최종 수·검사”는 거부 59**, 현행 결과와 `stage-1-db.md:178`은 **64**다. 59의 검사 시점을 표시하거나 최신 결과로 갱신해야 한다. `stage-6.md:213`이 export 근거로 드는 `stage-1-api.md:99`도 지금은 progress.report 행이다. 과거 54표 승인 이력 자체는 지울 필요가 없다. |
| R05 앱 actor·G3 선행 | **해소** | `issues/stage-2.md:379~388`, `stage-1-api.md:106~107`, `issues/stage-6.md:237`: 직접 인증 앱은 external_agent, 수동 붙여넣기만 human으로 구분됐고 G3 선행에 PR20c가 명시됐다. |

## 이번 수정이 새로 만든 모순·회귀

이 표는 위 일부 판정과 겹치는 원인을 구체화한 것으로, 별도 미해결 건수에 중복 합산하지 않는다. 운영 중인 제품에서 실제 유출·장애가 발생했다는 뜻은 아니다.

| 항목·구분 | 파일:행 근거 | 모순·영향 | 고칠 것 |
|---|---|---|---|
| N01 · 필수/중간 · 새 정책 표의 키 이름 | DDL `schemas/stage-1-ddl-draft.sql:477,505~506,522`; 문서 `stage-1-ui.md:52`, `stage-3.md:59,266`, `issues/stage-3.md:5,272,277` | 실제 PK는 **`file_policies.id`**다. 문서의 **`file_policies.file_policy_id`**는 존재하지 않으며 합성 조회에서 `no such column`이 났다. Claude가 고친 이슈 5행도 `file_policies` 다음 괄호에 `file_policy_id`를 남겨 완전히 맞지 않는다. | 대상 표 PK는 `file_policies.id`, 이를 참조하는 다른 표의 열은 `file_policy_id`/`source_file_policy_id`/`text_file_policy_id`로 구분한다. 현재 DDL·검사기의 올바른 FK를 잘못된 문구에 맞춰 바꿀 이유는 없다. |
| N02 · 필수/중간 · 추출본의 “같은 정책” | `stage-1-db.md:78`; DDL `schemas/stage-1-ddl-draft.sql:490~492,550~554`; `stage-3.md:266,273`, `issues/stage-3.md:277` | DB 설계는 **원본 blob과 추출 텍스트 blob이 각각 정책**을 갖고 서비스가 원본 deny를 적용한다. 후속 문서는 두 ID도 같은 정책을 가리킨다고 한다. 다른 바이트의 추출본에 원본 정책 ID를 그대로 쓰면 blob 복합 FK가 거부한다. | 같은 blob의 버전/role 재사용과, 다른 blob인 파생본의 정책 계승을 구분한다. 후자는 원본·텍스트 정책을 함께 검사해 엄격한 쪽을 적용한다는 DB 문서의 서비스 계약으로 통일한다. |
| N03 · 필수/중간 · tombstone에 필요한 NULL 금지 | `stage-3.md:250`, `stage-1-db.md:141`; DDL `schemas/stage-1-ddl-draft.sql:88~94`; `issues/stage-3.md:250` | 설계/DDL은 source/latest snapshot FK를 명시적으로 비운 뒤 source_missing으로 남긴다. 이슈는 FK를 NULL로 만들지 말라고 한다. FK를 남긴 source_missing 전환은 합성 DB에서 CHECK 실패했고, RESTRICT 때문에 원본 삭제도 불가능하다. | “FK 자동 SET NULL에 기대지 않고, 검증 명령의 같은 tx에서 snapshot 포인터 해제·source_missing·key/label 보존”으로 이슈를 맞춘다. 참조 행과 안정 key는 보존한다. |
| N04 · 필수/중간 · 61표 변경의 이전 기준 누락 | `stage-1-db.md:178`, `roadmap.md:180`; `stage-2.md:186`, `issues/stage-2.md:13,20,25`, `issues/stage-5.md:47`; `stage-4.md:222`, `stage-5.md:263` | 새 정책 표를 더한 현재 DDL은 61표인데 PR1의 필수 시험과 WEB1 초기 스키마 설명은 60표다. 이슈 수 101이 틀린 것은 아니며, **스키마 기준 숫자 인계 누락**이다. | 현재 001 기준을 61표 또는 정확한 DDL/표 목록 참조로 맞춘다. 이후 단계 확장 표 수와 과거 승인 당시 표 수는 시점을 붙여 구분한다. |
| N05 · 필수/중간 · Python 검사기 종료와 후속 의무 | `decisions/0016-core-language.md:27~29`, `issues/stage-6.md:8~10,48,59,138,215,323`, `issues/stage-4.md:9,25`; `stage-4.md:212` | 새로 붙인 “PR26 전까지 한시 보존”과 PR26 이후 단계의 Python 검사기 확장·실행 의무가 충돌한다. 4단계 게이트의 pytest도 TS 시험 계약으로 바뀌지 않았다. | PR26에서 설계 검사 계약을 옮길 TS 검사기·실행 명령·기존 합성 사례의 동등성 인계를 정하고 후속 단계가 그 산출물을 사용하게 한다. 이식 전 한시 Python 실행과 이후 필수 검사를 구분한다. |
| N06 · 권장/낮음 · WEB0 산출물 경로 분기 | `spikes/web0-plan.md:35,39`; `issues/stage-5.md:19,29~30` | 새 시험 계획은 `spikes/web0/ts-core/`·`spikes/web0/package.json`, 이슈 원고는 `web/spike/ts-core/`·`web/spike/package.json`과 npm 명령을 지정한다. 동일 WEB0의 산출물/명령 위치가 다르다. | 시험 구현 루트 하나를 골라 두 문서의 경로·실행 명령을 맞춘다. PR1 전 시점과 JSON fixture 계약은 유지한다. |
| N07 · 권장/낮음 · 닫힌 A allowlist의 결정 제안 누락 | `decisions/0013-mode-a-go-subscription-and-model-choice.md:39~47`, `stage-1-runners.md:26`; `stage-3.md:30,188`; `stage-5.md:181` | 새 정확한 allowlist가 U3의 결정 제안 경로를 설명하지 않는다. B의 decision:propose scope/MCP 도구는 명시돼 있어 A/B 인계가 불균형하다. | `decision.propose` 허용 또는 기존 도구 안의 명시적 제안 매핑을 정하고 A/B 합성 U3 시험에 넣는다. 사람의 결정 채택 권한과 AI 제안 권한은 구분한다. |

신규 회귀와 별개로, 플랫폼 견적 표현에는 낮은 수준의 잔여가 있다. `stage-5.md:71`은 여전히 작은 VPS를 **“월 몇천 원 이하”**로 추천하고 `roadmap.md:149`도 “Hetzner 월 몇천 원”으로 적는다. 미확인 총액을 확정 상한처럼 쓰지 말고 `decisions/0005-web-platform.md:22,26`의 “월 총액은 WEB0 견적”으로 맞추는 것이 좋다. 또한 `stage-5.md:55,213`, `summary-for-approval.md:75`의 “비상업이라 개인·비상업 조건 충족”은 **실제 배포 주체의 personal 조건도 WEB0 확인**으로 남기는 것이 정확하다. 이는 이번 재검수에서 새 요금·약관을 조회해 판정한 사항이 아니라, 이전 검수의 확인 범위와 현재 표현을 대조한 것이다.

## 검사 실행 결과·안전 원칙

| 확인 | 결과·한계 |
|---|---|
| `python3 docs/plan/schemas/check_ddl.py` | **PASS**. 임시 HOME·USERPROFILE·PES_HOME, SQLite **3.54.1**, `:memory:`, **61표** 합성 적재, **거부 64건**(제약 62+부분 UNIQUE 2), 대표 조회 3개, 0행 CAS·뒤늦은 실패 전체 롤백, FK·integrity 통과. **D1은 미시험**이다. |
| `python3 docs/plan/fixtures/check_fixtures.py` | **38/38 PASS**. 기존 API 예제 계약의 검사이며, 미구현 Go 호출·도우미 서비스·B 도구의 실제 권한 집행을 검증한 결과는 아니다. |
| 추가 합성 SQL 대조 | 문서의 `file_policies.file_policy_id` 조회는 `no such column`. snapshot FK를 남긴 source_missing 변경은 CHECK 거부. **포인터 둘을 NULL로 바꾸고 tombstone을 남긴 후 독립 snapshot 삭제는 성공**, `source_snapshot_key` 보존 확인. N01·N03의 문서 불일치를 메모리 DB에서 확인했다. |
| 이슈 원고 실수·중복 | `issues/stage-2~6.md`의 실제 이슈 머리말을 세면 **25 / 11 / 9 / 16 / 9**, 각 단계 안 번호 중복 0. 신규 **70**, 기존 SEL-1~31 **31**, 합계 **101**, 260 대비 **159** 여유. 누적 **56/67/76/92/101**, 승인 요약의 **84+17=101**도 맞는다. 실제 Linear 계정 잔여를 조회한 것은 아니다. |
| 단일 쓰기 경로 | `stage-1-api.md:15,18,88~101`, `issues/stage-2.md:67~78`, `issues/stage-5.md:359~370`에 닫힌 명령·현재 정책 검사 후 재생·CAS·변경/사건/영수증 같은 tx가 유지된다. 새 WS 쓰기를 검증 경로 밖에서 허용하는 지시는 발견하지 못했다. |
| 소유자·불변 이력·엄격한 쪽 우선 | `stage-1-db.md:76~78,141,195`, `issues/stage-3.md:276~287`에 owner만 변경/재허용·불변 이력·원본/파생본·Go OFF/파일 deny의 엄격 우선이 배정돼 있다. **file_policies의 owner 검사 미구현을 DDL 결함으로 다시 세지 않았다.** N01·N02는 SQL과 후속 문서의 계약 표현 문제다. |
| 조용한 덮어쓰기 금지 | `stage-5.md:239`, `issues/stage-5.md:363,369`의 hash/버전 기반 충돌·사람 선택·삭제 비전파 계약을 유지한다. |
| `git diff --check` | **PASS**. |
| 실제 자료·키·절대 로컬 경로 | 변경·신규 파일의 사용자 절대 경로·대표 토큰/개인키 형태 정적 검색에서 발견 0. 제품의 `~/.pes/...` 등 경로 설명은 실제 파일 접근과 구분했다. 임의 형식의 비밀 부재까지 증명하는 검사는 아니다. |
| 변경 범위 | 기존 작업 트리 입력 파일의 hash를 보존해 검수 전후 동일성을 확인하고, 요청한 이 보고서만 추가했다. 실제 서비스·플랫폼 배포·실키 호출·실제 자료 이전은 수행하지 않았다. |

필수 잔여는 TS 검사 인계와 파일 정책/참조/스키마 기준의 문서 일치다. 서비스 구현에 명확히 넘긴 owner 검사·사용량 예약·WS 권한 검사는 이 판정의 미해결 사유가 아니다.

최종 판정: **수정 후 승인**
