# 1단계 ④ 실행 구조 — Claude 추천안 Codex 검수

작성: 2026-11-04. 대상: `docs/plan/discussion/stage-1-runners-claude-recs.md` A1~18, B1~9, C.
**판정: 수정 후 합의 가능. 동의 11건, 수정 17건, 반대 0건.** 방향을 폐기할 항목은 없다. 다만 시작 순서·세션 계보·자식 권한·재개 조건·system 기록을 보완하기 전에는 ‘그대로 채택’으로 확정하지 않는다.

‘동의’는 제안한 정책/설계에 동의한다는 뜻이며 구현 성공 판정이 아니다. ‘수정’은 방향을 수용하되 합의문에 필요한 구체화 또는 두 의견의 차이 정정이 있다는 뜻이다.
stage-0 7절·stage-1-db 2절의 17개 결정은 그대로 따른다. Go 기본 켜짐+프로젝트별 끄기, 지정 DeepSeek로 6단계, Claude Code·Claude 앱 보장, 공개 저장소+매 PR CI를 재결정하지 않는다.
실제 `~/pes-projects`·`~/.pes/`는 읽지 않았다. 제품 코드·DDL·추천안·기존 의견서를 고치거나 제품/에이전트를 실행하지 않았으며, 이 검수 문서만 작성했다.

## A. ‘두 의견이 같은 것’ 18항목

각 번호는 검수 대상 A의 번호다. 수정안은 해당 항목을 대체하거나 바로 뒤에 붙일 내용이다.

| 번호·대상 줄 | 판정 | 채택할 내용·필요한 수정 | 판단 근거 |
|---|---|---|---|
| A1 코어·어댑터, 8행 | **수정** | 책임 분리는 동의. 다만 ‘어댑터는 결과를 대신 쓰지 않음’을 두 의견의 완전한 공통 주장으로 쓰면 부정확하다. Codex는 **검증 API 중계와 직접 DB 쓰기를 구분**했다. 합의문은 ‘상태·연구 결과를 임의 생성/직접 저장하지 않는다. A의 기본 업무 제출은 세션의 인증된 도구 호출, 어댑터의 실행 제어·관측 기록은 검증 명령을 사용한다’로 정리한다. B2의 사람 가져오기는 별도 경로다. | `docs/plan/stage-0.md:12–14`; `docs/plan/discussion/stage-1-runners-codex.md:70–74`; `docs/plan/discussion/stage-1-runners-opencode.md:75–80`; `docs/plan/discussion/stage-1-api-claude-recs.md:8–9` |
| A2 A 서버 HTTP·직접 제출, 9행 | **수정** | HTTP 제어와 세션의 PES API/MCP 제출을 기본으로 수용한다. **첫 모델 호출/연구 자료 전송 전에 run·claim·현 정책·예산을 확인**하는 시작 순서를 추가한다. 어댑터의 선행 claim과 세션의 bootstrap claim 중 최종 주체를 하나로 정해야 한다. 빈 세션 준비와 연구 prompt 실행을 구분하고, 중복 claim이나 소유자 없는 유료 실행을 허용하지 않는다. | `docs/plan/discussion/stage-1-runners-codex.md:90–94`; `docs/plan/discussion/stage-1-runners-opencode.md:13–15`; `docs/plan/discussion/stage-1-api-claude-recs.md:14–15`; `docs/plan/discussion/stage-1-api-claude-recs.md:37–37`; 공식 근거 O1 |
| A3 질문/form/permission, 10행 | **동의** | 연구 질문·답은 PES 원본, 실행 입력과 권한 요청은 별도 중계한다. 실행 form을 두 번째 연구 질문 저장소나 단계 승인 경로로 쓰지 않는다. 요청 ID·세션·응답자·기한과 응답 뒤 재개 검사는 실행 계약에서 구체화한다. | `docs/plan/stage-0.md:46–48`; `docs/plan/discussion/stage-1-runners-codex.md:205–214`; `docs/plan/discussion/stage-1-runners-opencode.md:96–101` |
| A4 run당 세션 하나, 11행 | **수정** | **‘동시에 활성인 주 세션은 run당 하나’**로 고친다. 같은 run 복구의 대체 세션과 B4의 하위 세션은 예외가 필요하다. 원 세션·대체 세션·하위 세션과 대상 run/부모의 매핑을 덧붙여 보존하고, external_session_ref 하나를 덮어써 이력을 잃지 않는다. 복구 불명 시 고정본 새 세션은 유지하되 옛 세션의 채택·반출을 먼저 차단한다. | `docs/plan/discussion/stage-1-runners-codex.md:145–147`; `docs/plan/discussion/stage-1-runners-opencode.md:91–94`; `docs/plan/schemas/stage-1-ddl-draft.sql:837–843`; 검수 대상 `docs/plan/discussion/stage-1-runners-claude-recs.md:34–34` |
| A5 임시 workspace, 12행 | **수정** | 경로는 권장 기본/구성값으로 두고 OS 임시 경로도 허용한다. 그 경로가 **실제 sandbox를 뜻하지는 않는다**. 파일·셸·MCP 권한과 환경/프로필에서 DB·객체 원본·전역 설정으로 나가는 접근을 제한한다. 종료 시 삭제할 임시 사본과 먼저 ready로 채택·보존할 결과/증거를 구분하고 실패 시 보존/정리 규칙을 둔다. | `docs/plan/discussion/stage-1-runners-codex.md:142–147`; `docs/plan/discussion/stage-1-runners-opencode.md:105–108`; `docs/plan/discussion/stage-1-runners-opencode.md:178–181`; `docs/plan/stage-1-db.md:26–28`; `docs/plan/stage-1-db.md:123–123` |
| A6 읽기·검색 자동, 13행 | **수정** | 자동 허용은 **API가 허가한 프로젝트/버전과 workspace 입력, 지정 연구 도구/목적지** 범위로 한정한다. 모든 로컬 파일 읽기·모든 외부 검색을 포괄 허용한다는 뜻으로 쓰지 않는다. 검색은 네트워크 동작이기도 하므로 정책 적용 범위를 분명히 한다. Go 자료 전송은 별도의 현재 정책 검사로 집행한다. | `docs/plan/discussion/stage-1-runners-codex.md:144–147`; `docs/plan/discussion/stage-1-runners-codex.md:197–201`; `docs/plan/discussion/stage-1-runners-opencode.md:99–101`; `docs/plan/stage-1-db.md:18–18` |
| A7 모델 폴백 없음, 14행 | **동의** | 지정 DeepSeek를 실제 요청마다 확인한다. 내부 요약·제목·하위 세션·reviewer에도 다른 모델을 조용히 쓰지 않는다. 실패는 기록하고 B 인계를 제안할 수 있으나 자동 공급자 변경으로 처리하지 않는다. | `docs/plan/stage-0.md:87–89`; `docs/plan/schemas/stage-1-ddl-draft.sql:847–847`; `docs/plan/discussion/stage-1-runners-codex.md:199–200`; `docs/plan/discussion/stage-1-runners-opencode.md:112–115` |
| A8 Go 실제 반출 검사, 15행 | **동의** | 단순 prompt 전 검사보다 실제 요청 경계의 거부 가능한 검사가 필요하다. 훅/transport·최종 요청·요약·retry·자식까지 합성 시험한다. OFF 뒤 새 허가 금지와 in-flight 취소 시도·unknown·회수 보장 없음을 구분한다. 문서의 훅 존재를 2.2.5+Go 차단 성공으로 간주하지 않는다. | `docs/plan/stage-1-db.md:18–18`; `docs/plan/stage-1-db.md:212–212`; `docs/plan/discussion/stage-1-runners-codex.md:182–203`; `docs/plan/discussion/stage-1-runners-opencode.md:110–115`; 공식 근거 O2 |
| A9 Code MCP/CLI, 16행 | **동의** | stdio bridge→로컬 PES HTTP 기본, CLI는 같은 명령·권한·멱등·오류 의미의 대안이다. `/pes:run` 진입점은 유지하고 내부의 파일 잠금/직접 JSON 쓰기는 교체한다. CLI fallback이 토큰/승인 검사를 우회해서는 안 된다. | `docs/plan/discussion/stage-1-runners-codex.md:234–243`; `docs/plan/discussion/stage-1-runners-opencode.md:119–122`; `commands/run.md:6–15`; 공식 근거 O3 |
| A10 heartbeat, 17행 | **수정** | 생존/진행 증거에 묶는 방향은 수용한다. 하지만 **모든 도구 호출/모든 context 읽기마다 무조건 연장하지 않는다**. 현재 소유 actor·lease_id/fence·활성 run·미만료·기한을 검사하고, 도구 없는 긴 추론·장시간 호출은 실제 관측 갱신 또는 만료 후 재검토로 처리한다. 만료 lease의 부활 금지, heartbeat의 업무 rev 불변도 추가한다. | `docs/plan/discussion/stage-1-runners-codex.md:118–123`; `docs/plan/discussion/stage-1-runners-opencode.md:122–143`; `docs/plan/stage-1-db.md:117–117`; `docs/plan/schemas/stage-1-ddl-draft.sql:872–886` |
| A11 질문 대기·lease 해제, 18행 | **수정** | 합의된 방향에 더해 **질문/폼 발행+waiting_human+lease 해제+사건을 한 변경 명령으로** 확정한다. 런타임의 자율 후속 호출도 막아야 한다. 재개는 새 claim/fence와 최신 기반/입력 대조다. 단절·중복 답에도 seen/applied를 구분한다. 실행 권한/form 대기도 사람 대기라면 같은 원칙을 적용한다. | `docs/plan/stage-1-db.md:32–32`; `docs/plan/discussion/stage-1-runners-codex.md:107–112`; `docs/plan/discussion/stage-1-runners-codex.md:208–211`; `docs/plan/discussion/stage-1-runners-opencode.md:133–136`; `docs/plan/discussion/stage-1-api-claude-recs.md:14–16` |
| A12 TTL 등 시험으로 결정, 19행 | **동의** | 공식값으로 올리지 않는 데 동의한다. 관계식은 주기 갱신 경로의 시험 기준이며 앱의 불규칙 호출에 그대로 대입하지 않는다. API 추천 B1의 25초는 별도의 long-poll 상한 후보로 구분하고 실제 W는 API cap과 클라이언트 검증 범위 안에서 정한다. 기존 2시간은 현행 파일 잠금 값일 뿐이다. | `docs/plan/stage-1-db.md:162–162`; `docs/plan/discussion/stage-1-runners-codex.md:125–136`; `docs/plan/discussion/stage-1-runners-opencode.md:138–143`; `docs/plan/discussion/stage-1-api-claude-recs.md:31–31`; `scripts/pes.py:117–125` |
| A13 reviewer 별도 run, 20행 | **수정** | 독립 맥락·별도 run은 수용한다. **부모 writer가 담당을 반납한 뒤 reviewer가 새 claim/fence로 실행/제출**하고, reviewer의 실제 actor·기준 결과 버전을 남긴다고 추가한다. 메인의 기대 결론을 주지 않고 자체 점검은 마지막에 비교한다. native Agent 호출만으로 별도 PES run/독립 제출이 생기는 것은 아니다. | `docs/plan/discussion/stage-1-runners-codex.md:310–315`; `docs/plan/discussion/stage-1-runners-opencode.md:148–159`; `agents/reviewer.md:6–12`; `skills/core/SKILL.md:120–126`; `docs/plan/schemas/stage-1-ddl-draft.sql:872–886` |
| A14 A↔B 인계, 21행 | **동의** | 새 run+PES 고정본+미처리 입력을 전달한다. 옛 run/모델/세션의 **과거 증거를 지운다는 뜻은 아니다**. 새 실행 모델/정책/한도는 새로 검사하고, 옛 fence·지연 결과·권한 reply는 거부한다. B→A에서 Go OFF이면 인계 실행을 차단한다. 인계와 retry의 관계 의미는 API에 명시한다. | `docs/plan/discussion/stage-1-runners-codex.md:319–331`; `docs/plan/discussion/stage-1-runners-opencode.md:169–174`; `docs/plan/stage-1-db.md:29–32`; `docs/plan/schemas/stage-1-ddl-draft.sql:837–856` |
| A15 스킬 중립화, 22행 | **동의** | core+plan 파일럿 후 단계·명령·역할 전체로 확장한다. provider 문법은 어댑터 노트에 두고 연구 절차·독립 검토·근거 확인은 유지한다. 직접 쓰기 예제 제거와 예외 위치 있는 lint를 함께 한다. `anthropic-skills:*` 이름을 바꾸는 것만으로 변환 지원을 주장하지 않는다. | `docs/plan/discussion/stage-1-runners-codex.md:277–296`; `docs/plan/discussion/stage-1-runners-opencode.md:162–167`; `skills/core/SKILL.md:16–25`; `skills/core/SKILL.md:62–84`; `skills/publish/SKILL.md:14–24` |
| A16 worker/reviewer와 세부 역할, 23행 | **동의** | 현재 DDL에 맞다. 세부 역할은 버전이 있는 workflow/manifest 메타데이터로 기록한다. `workflow_version`을 매 호출 역할 문자열로 바꾸거나 parent_run_id만으로 역할·작성자를 표현하지 않는다. B4의 자식 출처는 별도 메타데이터로 추적한다. | `docs/plan/schemas/stage-1-ddl-draft.sql:834–843`; `docs/plan/discussion/stage-1-runners-codex.md:312–314`; `docs/plan/discussion/stage-1-runners-opencode.md:150–157` |
| A17 execution 사건, 24행 | **수정** | 기존 events 사용은 수용하되 **저빈도·의미 있는 실행 전이/권한/오류/사용량 확정**만 검증 명령으로 남긴다. 토큰/SSE 원본·매 heartbeat를 무조건 events에 복제하지 않는다. 실제 type 이름의 목록, 작은 payload·권한별 공개 목록·tx 경계를 정한다. `execution.*`는 이름 공간 표기이며 단일 wildcard type이 아니다. | `docs/plan/discussion/stage-1-runners-opencode.md:178–181`; `docs/plan/discussion/stage-1-runners-codex.md:172–180`; `docs/plan/stage-1-db.md:112–117`; `docs/plan/schemas/stage-1-ddl-draft.sql:903–927`; `docs/plan/discussion/stage-1-api-claude-recs.md:20–20`; `docs/plan/discussion/stage-1-api-claude-recs.md:42–42` |
| A18 22개 PR, 25행 | **수정** | 22개 유지와 후속 단계 구분은 동의한다. 다만 제시한 8개 PR 외에 **PR 4·8·9·13·14·15·16 등 선행 계약**도 연결해야 한다. 어댑터 PR에 명령 서비스·파일 채택·질문/답 계약까지 몰아넣지 않는다. 최소 상태/오류/정책 표시는 2단계 PR 18, 새 live 화면은 3단계로 나눈다. C에서 구체화한다. | `docs/plan/stage-1-db.md:178–199`; `docs/plan/discussion/stage-1-runners-codex.md:425–447`; `docs/plan/discussion/stage-1-runners-opencode.md:263–276` |

## B. 결정 후보 9항목

| 번호·대상 줄 | 판정 | 채택할 내용·필요한 수정 | 판단 근거 |
|---|---|---|---|
| B1 Claude 앱 연결, 31행 | **동의** | PR 20에서 Desktop 로컬 확장 실제 설치·도구 왕복·종료/재접속을 시험하고 성공한 환경의 기본 경로로 한다. 명시적 전달/가져오기도 제공한다. 원격 커넥터는 공개 도달 HTTPS·인증을 갖출 5단계로 둔다. 로컬 확장 미지원이 밝혀져도 앱 자체를 보장 대상에서 빼지 않는다. | `docs/plan/discussion/stage-1-runners-codex.md:245–264`; `docs/plan/discussion/stage-1-runners-opencode.md:124–129`; `docs/plan/stage-0.md:89–89`; `docs/plan/discussion/stage-1-api-claude-recs.md:40–40`; 공식 근거 O4·O5 |
| B2 명시적 전달의 기록, 32행 | **수정** | 오프라인 제안→사람이 새 담당으로 채택에 동의한다. **복사/대화 동안 lease 유지 없음**, hash는 인증 증명이 아니라는 점, 원 요청·기반 manifest 대조·중복 가져오기 방지를 추가한다. 가져오기 tx/버전/run의 실제 제출 actor가 맞아야 한다. 인증된 외부 actor를 꾸미지 않고 작성 도구/모델 주장은 별도 미검증 출처로 남긴다. §2.2의 DDL 대응을 따른다. | `docs/plan/discussion/stage-1-runners-codex.md:266–273`; `docs/plan/discussion/stage-1-runners-opencode.md:129–129`; `docs/plan/discussion/stage-1-api-claude-recs.md:11–19`; `docs/plan/schemas/stage-1-ddl-draft.sql:85–110`; `docs/plan/schemas/stage-1-ddl-draft.sql:302–316` |
| B3 A 전용 서버, 33행 | **수정** | PES가 소유한 전용 프로필·프로세스, 프로젝트별 최대 하나는 수용한다. 하지만 **프로젝트별 lease 하나는 전체 동시 프로젝트 수가 적다는 근거가 아니다**. 전체 동시 실행/프로세스 상한은 자원·예산 시험으로 정한다. waiting_human은 lease가 없으므로 서버를 중지할지 휴면 보관할지 명시하고 세션 복구·중단 시각·PID 소유 증거를 유지한다. 사용자 공용 서버는 건드리지 않는다. | `docs/plan/discussion/stage-1-runners-codex.md:138–149`; `docs/plan/discussion/stage-1-runners-opencode.md:84–87`; `docs/plan/stage-1-db.md:32–32`; `docs/plan/schemas/stage-1-ddl-draft.sql:872–886` |
| B4 자식 제안 병렬, 34행 | **수정** | **부모가 유일한 업무 채택자, 자식은 제안, reviewer 별도 run**으로 조정하는 안을 수용한다. Codex의 초기 순차 추천을 이 방향으로 조정할 수 있다. 단 native 병렬은 런타임 검증 후 지원하며 앱은 별도 패킷으로 같은 역할 의미를 보장한다. 자식의 직접 PES 변경 도구/토큰 접근 차단, 각 하위 세션→부모 run 매핑·작성 출처, 동시 예산 예약·OFF·부모 만료/중단의 자식 전파를 명시한다. 작업용 제안 파일 쓰기는 허용할 수 있으며 ‘업무 상태 쓰기 없음’과 구별한다. | `docs/plan/discussion/stage-1-runners-codex.md:298–315`; `docs/plan/discussion/stage-1-runners-opencode.md:145–160`; `skills/research/SKILL.md:30–34`; `docs/plan/schemas/stage-1-ddl-draft.sql:302–316`; `docs/plan/schemas/stage-1-ddl-draft.sql:930–947`; 공식 근거 O2·O6 |
| B5 사람이 계속 눌러 재개, 35행 | **수정** | 초기 명시적 재개와 자동 재개 옵션의 후속 구현은 수용한다. 그러나 **유효 submission 하나의 존재는 재개 충분조건이 아니다**. 현재 질문/폼 버전·조건부 필수 답·의견만 응답 허용·명시적 미루기·실행 상태·Go 정책·기한/한도·새 claim을 서버에서 검사한다. 실행 form/permission 응답·질문 없는 후속 작업까지 연구 답 submission을 요구하지 않는다. UI는 서버의 ready/차단 이유를 표시하고 클릭 시 다시 검증한다. | `docs/plan/discussion/stage-1-runners-codex.md:107–112`; `docs/plan/discussion/stage-1-runners-codex.md:208–211`; `docs/plan/discussion/stage-1-api-claude-recs.md:39–39`; `docs/plan/stage-1-db.md:24–24`; `docs/plan/stage-1-db.md:209–209`; `docs/plan/schemas/stage-1-ddl-draft.sql:491–510`; `templates/_questions.html:81–88` |
| B6 사람이 인계 시작, 36행 | **동의** | A↔B 전환·다른 담당 강제 회수는 사람이 시작한다. 에이전트의 자발적 pause/release는 허용하고 사람 입력과 분리한다. 중단 미확인은 상태/비용 위험을 보여 주되 새 담당에도 fence·현재 정책 검사를 적용한다. 사람의 인계 요청이 Go 재허용이나 실제 프로세스 종료의 증거는 아니다. | `docs/plan/discussion/stage-1-runners-codex.md:323–329`; `docs/plan/discussion/stage-1-runners-opencode.md:171–174`; `docs/plan/discussion/stage-1-api-claude-recs.md:17–18` |
| B7 비용·시간 상한, 37행 | **수정** | run+단계+프로젝트 누적 상한과 비용 값의 사용자 확인은 수용한다. **실측 비용/구독 허용량/토큰·턴·시간 강제 한도**를 분리하고 값이 없다고 무제한을 기본으로 두지 않는다. 자식·reviewer·재시도·새 세션·인계가 예산을 초기화하지 않게 예약/정산한다. A는 SEL-18, B의 관측/집행 한계는 SEL-19로 확인한다. 실자료를 안 쓰는 유료 합성 시험도 명시적 시험 상한이 필요하다. 현재 작업에서 실시험을 수행하거나 비용 승인을 요구하는 것은 아니다. | `docs/plan/discussion/stage-1-runners-codex.md:216–232`; `docs/plan/discussion/stage-1-runners-opencode.md:112–115`; `docs/plan/stage-1-db.md:214–214`; `docs/plan/schemas/stage-1-ddl-draft.sql:843–843`; 공식 근거 O7 |
| B8 supervisor actor, 38행 | **수정** | system actor는 맞다. **run_id를 비울 곳은 mutation_commits이며, 연결 사건 events.run_id에는 실제 대상 run을 남길 수 있다.** 현재 DDL로 두 참조는 양립한다. system 신원을 AI로 바꾸거나 run 연결을 통째로 잃을 필요가 없다. system/via를 인증된 내부 경로에서 확정하고 사건·상태 변경을 같은 tx로 남긴다. 꼭 필요한 추가 제약이 있을 때만 PR 1·4에서 보완한다. §2.1 참조. | `docs/plan/discussion/stage-1-runners-codex.md:409–409`; `docs/plan/schemas/stage-1-ddl-draft.sql:85–110`; `docs/plan/schemas/stage-1-ddl-draft.sql:903–924`; `docs/plan/discussion/stage-1-api-claude-recs.md:11–19` |
| B9 재시도, 39행 | **동의** | 읽기/연결과 유료 prompt 재시도를 분리하고 한 계층에서 관리한다. PES 명령은 같은 키 영수증 확인, 외부 타임아웃은 접수/결과 대조부터다. unknown을 미전송으로 보거나 예산 예약을 자동 해제하지 않는다. OFF·권한·rev/lease 충돌은 자동 유료 재시도 대상이 아니다. | `docs/plan/discussion/stage-1-runners-codex.md:175–180`; `docs/plan/discussion/stage-1-runners-codex.md:227–231`; `docs/plan/discussion/stage-1-api-claude-recs.md:11–11`; `docs/plan/schemas/stage-1-ddl-draft.sql:938–943` |

## C. 이슈 배치

| 항목·대상 줄 | 판정 | 수정해 채택할 내용 | 근거 |
|---|---|---|---|
| C, 43행 | **수정** | **2단계 22개 유지**, supervisor/Go 훅은 PR 19, Desktop 확장/전달은 PR 20, 3단계 live 화면·5단계 원격 runner/MCP·6단계 다중 worker 배치는 수용한다. 다만 아래 선행 계약과 **2단계 최소 실행 상태/오류/정책 연결**을 남겨야 한다. PR 안의 검증 단위/커밋 분할과 독립 배포 가능한 새 PR 추가를 구분한다. 별도 relay가 필수가 되면 PR 19의 의존·범위 검토로 올리고 ‘22개 유지’ 때문에 핵심 검증을 누락하지 않는다. | `docs/plan/stage-1-db.md:174–199`; `docs/plan/discussion/stage-1-runners-codex.md:425–447`; `docs/plan/discussion/stage-1-runners-opencode.md:263–276`; `docs/plan/discussion/stage-1-api-claude-recs.md:25–25`; `docs/plan/discussion/stage-1-api-claude-recs.md:47–47` |

| 기존 PR | 이번 합의에서 연결할 책임 |
|---|---|
| 1·4 | actor/run 참조·세션/역할 메타데이터 표현, 검증 명령·0행 실패·멱등·system 사건 |
| 5 | claim 주체·waiting_human 원자 전환·새 fence·만료/회수·입력 영수증·인계 |
| 8·14 | 유효 제출/현재 질문 버전·의견만 응답·재개 준비 상태·권한별 오류/변경분 |
| 9·13 | 파일 ready·제안 채택·정확한 버전/manifest·context/submit·입력 적용 증거 |
| 10 | 프로젝트+run 제한 토큰·실제 actor·현재 Go 정책·전송 허가/차단·자식 접근 제한 |
| 15·16·17 | CLI/doctor·소유 프로세스 진단·스킬/명령/역할 중립화·기존 진입점 전환 |
| 18 | 기존 화면에 현재 run/대기·실패·전송 정책/오류와 필요한 제어 연결, 미제출 입력 보존. 새 디자인 없음 |
| 19·20 | A 런타임/강제 훅/세션과 B MCP/앱 연결·명시적 전달·실행 form 중계의 실제 구현 |
| 각 PR·21·22 | 각 변경의 단위/계약 검증, 교차 인계·유실/중복·OFF/회수·Windows/macOS·안내의 통합 검증 |

## 2. 합의문에서 명확히 할 구현 경계

### 2.1 B8: system 변경과 대상 run을 함께 보존할 수 있다

현재 DDL에서 다음을 **정적 대조**했다. 실제 PES DB나 검사용 DB는 실행하지 않았다.

| 기록 | 제안 값 | 현재 제약에서의 의미 |
|---|---|---|
| mutation_commits.actor_id | 실제 supervisor의 system actor | `actors` FK를 만족해야 한다. 클라이언트 자기 신고로 받지 않는다 |
| mutation_commits.run_id | NULL | `(project_id,run_id,actor_id)`가 AI run.actor 일치를 강제하는 경로를 피한다. actor 자체를 숨기지는 않는다 |
| mutation_commits.via | 인증된 내부 서비스가 정한 기존 값 | 현재 CHECK에는 `internal` 값이 없다. 가령 내부 HTTP 경로라면 http로 기록하고 구체 호출 경로를 서버가 확정한다 |
| events.run_id | 실제 대상 AI run ID | events의 FK는 `(project_id,run_id)`이며 actor 일치 제약이 없다 |
| events.tx_id | 위 system mutation의 ID | 사건 작성자는 tx→mutation→actor로 추적한다. events에 별도 actor 열이 있다고 가정하지 않는다 |

따라서 ‘system이면 run_id를 전부 비워야 한다’는 해석은 불필요하다. 시스템 제어 명령의 상태 변경·사건·영수증을 같은 tx로 묶고, 대상 run과 프로젝트가 맞는지는 서비스에서도 검사한다. FK를 느슨하게 바꿔 AI 사칭을 허용하는 보완은 하지 않는다.

근거: `docs/plan/schemas/stage-1-ddl-draft.sql:20–33`, `docs/plan/schemas/stage-1-ddl-draft.sql:79–110`, `docs/plan/schemas/stage-1-ddl-draft.sql:903–927`.

### 2.2 B2·B4: 제출자와 작성 기여자를 구분한다

- **수동 앱 제안:** 가져오기 명령의 실제 주체는 인증된 사람이다. 결과 버전에 run을 연결한다면 human actor를 실제 채택 주체로 하는 B 가져오기 run 등, run.actor·mutation.actor·object_version.actor가 일치하는 명령 계약을 정한다. 일반 human 답/첨언에 새 lease를 요구하는 뜻은 아니다.
- 외부 도구 이름·모델·작성 주장·전달 packet ID는 별도 출처 메타데이터다. 검증 못 한 값을 인증된 외부 actor 또는 확인된 모델로 승격하지 않는다. 사용자 전달 자료의 hash도 실제 작성자 신원을 보장하지 않는다.
- **부모가 채택한 자식 제안:** 부모 run/actor를 채택 주체로 기록하고 제안의 task ID·역할·세션·작성 도구·원 제안 hash·관련 근거를 보존한다. 자식 신원을 부모 run의 작성 actor로 그대로 바꾸어 끼우면 현재 복합 FK와 맞지 않는다.
- 자식의 실제 모델/사용량을 관측할 수 없으면 ‘확인 불가’로 남긴다. 독립 reviewer 결과를 부모가 자기 검토로 다시 저장해 작성자·독립성 증거를 지우지 않는다.
- 새 표가 무조건 필요하다는 뜻은 아니다. 버전 manifest/사건으로 가능한 표현을 PR 1·4·13에서 확정하고, 현재 DDL이 이미 세부 역할·외부 기여자 전부를 직접 저장한다고 주장하지 않는다.

근거: `docs/plan/schemas/stage-1-ddl-draft.sql:302–317`, `docs/plan/schemas/stage-1-ddl-draft.sql:823–857`, `docs/plan/discussion/stage-1-runners-codex.md:266–273`, `docs/plan/discussion/stage-1-runners-codex.md:310–315`.

### 2.3 B5: ‘계속’은 저장된 봉투 존재보다 강한 조건이다

| 상황 | 추천 동작 |
|---|---|
| 옛 질문 버전에 답한 submission만 있음 | 새 질문은 재확인 필요. 과거 답을 자동 승계해 재개하지 않음 |
| 현재 폼의 필요한 응답이 충족됨 | 사람의 계속 요청 후 정책·한도·현재 run/기반·claim을 재검사 |
| 의견만 있음 | `allow_comment_as_answer`와 명시적 제출 여부로 판단. 일반 댓글만으로 응답/재개를 만들지 않음 |
| 실행 form/permission 답이 옴 | 연구 답 submission과 별도인 실행 입력 계약 검사 후 새 담당/정책 확인, 런타임 reply |
| Go OFF·회수/terminal run·한도 초과 | 사람의 계속 클릭이 있어도 차단. 재허용/새 실행 등 올바른 경로와 이유를 표시 |

‘계속’은 재개 요청이며 승인·reopen·Go 재허용이 아니다. 버튼 활성 뒤에도 상태는 바뀔 수 있으므로 서버에서 원자적으로 검증한다. 이 보완은 API 추천 B9에도 같은 문구로 반영한다.

근거: `docs/plan/stage-1-db.md:24–24`, `docs/plan/stage-1-db.md:29–32`, `docs/plan/stage-1-db.md:209–209`, `docs/plan/schemas/stage-1-ddl-draft.sql:491–575`, `docs/plan/discussion/stage-1-api-claude-recs.md:39–39`.

### 2.4 B4: 제안 병렬과 단일 채택 담당은 양립한다

내 초기안의 ‘역할별 순차’를 유일한 구조로 고집하지 않는다. **부모 한 명의 채택 + 쓰기 권한 없는 자식 제안 병렬 + 독립 reviewer run**은 현행 조사의 병렬 사용을 보존하는 합의안이 될 수 있다.

단, ‘자식에게 쓰지 말라고 지시’하는 것만으로 충분하지 않다. 부모 변경 도구/토큰이 자식에 자동 상속되지 않게 실행 능력을 제한하고 서버에서 검증해야 한다. A의 각 하위 세션은 부모 run에 매핑되어 실제 Go 요청 검사·누적 예약·중단을 공유한다. 부모 waiting_human·만료·OFF 뒤 자식이 계속 전송하거나 제출할 수 없어야 한다.
앱의 별도 패킷은 같은 역할 계약을 구현하지만 native subagent 동시 실행과 동일한 지원 수준으로 표시하지 않는다. 2.2.5·Code·앱 각각 성공 범위를 시험한다.

근거: `skills/research/SKILL.md:30–34`, `docs/plan/discussion/stage-1-runners-opencode.md:145–160`, `docs/plan/discussion/stage-1-runners-codex.md:313–315`, `docs/plan/stage-1-db.md:32–32`, 공식 근거 O2·O6.

## 3. 공식 문서 대조와 검증 한계

확인일: 2026-11-04. 아래는 공개 문서의 설명이며 설치본·사용자 계정·실제 통신·과금·프로세스 종료를 확인한 기록이 아니다. 문서에서 설계로 확장한 부분은 검수자의 제안이다.

| 번호 | 공식 출처·확인 지점 | 검수에 쓴 사실·한계 |
|---|---|---|
| O1 | [OpenCode API](https://opencode.ai/v2/docs/api), `session.prompt`·`session.interrupt`; [공개 OpenAPI](https://opencode.ai/v2/openapi.json) | prompt 접수는 실행 예약을 포함할 수 있다. 따라서 claim을 첫 prompt 이후로 미루지 않는다. 웹 명세와 2.2.5 설치본의 일치·멱등/중단 성공은 별도 시험 대상 |
| O2 | [OpenCode 서버 플러그인](https://dev.opencode.ai/v2/docs/build/plugins/server), Hooks / Native HTTP / Native WebSocket / Retry policy | HTTP 훅은 모델 본 요청·요약·제목·generate를 구분한다. WebSocket은 별도 경로이며 뒤 플러그인이 요청을 바꿀 수도 있다. 훅 존재만으로 최종 요청 차단이 증명되지는 않음 |
| O3 | [Claude Code MCP](https://code.claude.com/docs/en/mcp), local stdio/remote HTTP; [MCP Transports](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports) | Code 연결 표면과 stdio bridge가 가능하다. stdio stdout은 프로토콜용이며, transport의 연결/단절은 업무 lease/외부 작업 취소 확인과 별개 |
| O4 | [Claude Desktop 로컬 MCP](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop), custom desktop extensions·FAQ | custom mcpb·Python 등 로컬 서버·민감 설정 보호 경로가 있다. PES 패키징·권한·현재 앱 표면·Windows/macOS 설치 성공은 미검증 |
| O5 | [Claude 원격 커넥터](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp), Network requirements | 연결은 Anthropic 클라우드에서 출발하므로 로컬 PES 주소로 직접 연결되는 것으로 가정할 수 없다. 임의 터널 설치는 이 검수 범위 아님 |
| O6 | [Claude Code 서브에이전트](https://code.claude.com/docs/en/sub-agents), capabilities·tools·permissions | 별도 맥락·도구/권한 구성이 있다. native subagent가 자동으로 별도 PES run/lease/인증 주체가 되는 것은 아니며 Claude 앱에 같은 primitive가 있다는 근거도 아님 |
| O7 | [OpenCode API](https://opencode.ai/v2/docs/api), `experimental.usage.limits` | Go 허용량/Console 예산 조회와 run별 실측 비용·강제 지출 상한은 구분해야 한다. 미상 사용량을 0으로 만들지 않음 |

## 4. 합의 반영과 구현 인수 조건

| 반영 대상 | 합의문에 남길 조건 | 확인할 실패 사례 |
|---|---|---|
| A2·A4·B3 | 첫 실행 전 claim·현재 정책, 주 세션 1개와 대체/자식 계보, PES 소유 프로세스만 관리 | claim 실패·cold start 중 만료·서버 재시작·옛 세션 지연 결과 |
| A8·B4·B7·B9 | 모든 Go 경로·자식에 같은 차단/누적 한도, 요청 결과 불명은 조회부터 | OFF 경합·훅 불통·후단 요청 수정·요약/첨부/retry/WS 우회·동시 예약 |
| A10~13·B5 | 대기 전환 원자성·새 fence·현 버전 기준 재개·독립 reviewer 담당 | 긴 추론 중 만료·댓글만/옛 답만 도착·중복 클릭·reviewer와 부모 동시 claim |
| A17·B8 | 실제 actor의 검증 명령·의미 있는 실행 사건·대상 run 연결·권한별 공개 | system 기록 시 FK 충돌/대상 유실·SSE 원본 폭주·비공개 payload 노출 |
| B1·B2 | 연결/전달 각각의 지원표·복사 중 lease 없음·정직한 제출자/작성 출처 | 앱 종료 중 답 접수·재접속·옛/다른 프로젝트 packet·중복 가져오기·첨부 누락 |
| C | 22개 PR의 선행 책임과 PR별 테스트, 2단계 최소 연결/3단계 새 화면 구분 | PR 19/20만 완료하고 명령·정책·입력/파일 채택·기존 화면이 연결 안 되는 경우 |

추천안 4행의 **비용 값 사용자 확인**은 유지한다. 그 외 여기서 필요한 수정은 확정된 stage-0/DB 결정을 뒤집는 선택지가 아니라, 동일 결정을 구현·감사·복구 가능한 계약으로 만드는 보완이다.
