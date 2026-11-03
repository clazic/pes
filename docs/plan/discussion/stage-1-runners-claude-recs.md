# 1단계 ④ 방식 A·B 실행 구조 — Claude 추천안 (Codex 검수용)

- 작성: 2026-11-04, Claude. 입력: `stage-1-runners-codex.md`, `stage-1-runners-opencode.md`, 확정 `stage-0.md`, 합의 `stage-1-db.md`, 검수 중인 `stage-1-api-claude-recs.md`.
- 규칙: Claude 확인 → Codex 검수 → 합의안. stage-0 7절·stage-1-db 2절은 다시 정하지 않는다. **비용 상한처럼 돈이 드는 값은 합의 후에도 사용자 확인**(사용자 지시의 예외).

## A. 두 의견이 같은 것 (그대로 채택)

1. **하나의 코어·두 어댑터**: 코어 = 상태·검증·채택·기록, 에이전트 = 조사·집필, 어댑터 = 실행 시작/중단·권한·모델·세션. 어댑터는 결과를 대신 쓰지 않음
2. A는 PES가 **opencode 서버 HTTP API**에 붙음(CLI one-shot·SDK 이식 아님). A 세션도 **PES API/MCP로 직접 제출**, 어댑터는 run 생성·세션 수명·정책만
3. **PES 질문이 원본**, OpenCode form/permission은 실행 수준 입력으로 따로 중계
4. 세션은 **run당 하나**, external_session_ref는 보조 증거일 뿐 원본 아님. 세션 복구가 확인 안 되면 PES 고정본으로 새 세션
5. A 작업 디렉터리: **임시 `~/.pes/runs/<run_id>/workspace`**에 허용된 입력 사본·출력 제안만. PES DB·객체 원본·사용자 전역 설정은 노출 안 함
6. A 권한 기본: **읽기·검색은 자동, 쓰기·셸·네트워크는 정책 또는 사람 확인**
7. **모델 폴백 없음** — DeepSeek(`opencode-go/deepseek-v4.1-flash`)가 안 되면 실패로 기록(사용자 결정 7-2)
8. **Go OFF는 최초 prompt 한 번이 아니라 실제 반출 요청마다** 검사(자율 후속 요청·요약·재시도 포함). OpenCode 훅이 반출 전에 확실히 막는지는 PR 19에서 시험, 못 막으면 그 경로는 쓰지 않음
9. B Claude Code: **stdio MCP bridge → 로컬 PES HTTP**가 기본, CLI는 같은 계약의 대안. 직접 JSON/DB 편집 없음. `/pes:run` 진입점은 유지
10. **heartbeat는 도구 호출·실제 작업 진행에 묶음.** MCP 프로세스가 켜져 있다는 이유로 영구 갱신하지 않음. Claude 앱엔 지속 heartbeat를 요구하지 않음
11. 질문 대기: `waiting_human` + lease 해제, 재개 때 새 claim·새 fence. 답·첨언은 lease 없이 가능
12. **lease TTL·heartbeat·대기·무진행 한도는 지금 정하지 않음.** SEL-18·19 시험으로. 관계식 `TTL > k×heartbeat + D99 + J99 + 여유`만 둠. 기존 2시간·API 의견의 5분/30초는 후보일 뿐
13. **reviewer는 별도 run**(독립 맥락). 같은 모델의 다른 세션 검토를 "다른 모델 검증"이라 부르지 않음
14. A↔B 인계: **새 run + PES 고정본 + 미처리 입력**을 넘김. 세션·transcript·모델은 넘기지 않음
15. 스킬 중립화: **중립 단계 워크플로 + 공통 역할 명세 + 어댑터 노트(opencode / claude-code / claude-app)**. core+plan 먼저 파일럿, 그다음 전체. Claude 전용 표기·직접 쓰기 예제는 lint로(어댑터 노트·역사 문서는 예외 위치)
16. `runs.role`은 worker/reviewer만, researcher·verifier·writer 같은 세부 역할은 workflow/입력 manifest 메타데이터로
17. 실행 이벤트는 **`events`에 `type='execution.*'`로**(새 표 없음, 너무 많아지면 2단계에서 검토)
18. **2단계 22개 PR 유지**(PR 5·10·17·18·19·20·21·22에 귀속). 5단계 원격 runner·원격 MCP, 6단계 다중 worker는 그 단계 이슈

## B. 갈린 곳·결정 후보 — Claude 추천

| # | 항목 | Codex | OpenCode | Claude 추천 | 이유 |
|---|---|---|---|---|---|
| 1 | Claude 앱 연결 | Desktop 로컬 확장(.mcpb) 우선 검증 + 명시적 전달 대안 | 패킷(명시적 전달) 기본, 원격 MCP는 5단계 | **2단계 PR 20에서 Desktop 로컬 확장을 실제 설치 시험 → 되면 기본 경로. 명시적 전달(패킷 복사·결과 가져오기)은 언제나 제공.** 원격 커넥터는 5단계(공개 HTTPS 필요) | 사용자 결정(B 보장)을 지키는 가장 확실한 길. 시험 전엔 지원을 약속하지 않음 |
| 2 | 명시적 전달의 기록 | 제안으로 가져와 새 claim으로 채택, 실제 제출자는 사람, 작성 도구는 출처 | 붙여넣기+파일 | **Codex 안**: 전달 묶음에 프로젝트·판·단계·라운드·기반 버전·요청 ID·manifest hash. 가져온 결과는 "오프라인 제안" → 사람이 새 claim으로 채택. 인증 없는 붙여넣기를 claude_app actor 제출로 위장하지 않음 | 기록이 정직해야 함 |
| 3 | A 서버 프로세스 | 활성 프로젝트별 PES 관리 프로세스 | `opencode serve`에 붙음 | **PES가 띄우고 관리하는 전용 프로필 서버, 활성 실행 담당이 있는 프로젝트당 하나.** 사용자가 쓰는 OpenCode 서버에 붙거나 끄지 않음. 고정 버전·loopback·인증, Windows 프로세스 종료·자식 회수 시험 | 정책·작업 디렉터리·종료 범위를 분명히. 활성 담당이 프로젝트당 하나라 동시 개수가 적음 |
| 4 | 서브에이전트 | 역할별 순차 run, 자식은 제안만 | 부모 run 하나, 자식은 lease 없음, reviewer만 별도 run | **부모 run 하나 안에서 자식(researcher·writer·verifier)은 제안만 반환하고 lease·쓰기 권한 없음, 부모가 채택. reviewer만 별도 run.** 현행 조사 병렬(최대 5)은 자식 제안 병렬로 유지, 예산·기한·Go OFF 공유 | 두 안의 공통점. 현행 병렬 성능을 잃지 않음 |
| 5 | 재개 방식 | 초기엔 명시적 재개 | 답이 오면 재-claim | **초기엔 사람이 "계속"을 눌러 재개**(유효한 제출이 있어야 버튼 활성). 자동 재개는 3단계 옵션(질문·정책·한도 바뀌면 멈춤) | 반쯤 답한 상태로 비용이 나가지 않게. API 추천안 B9와 맞춤(유효 제출 전엔 재개 불가) |
| 6 | 인계 시작 | 중단 미확인이면 사람 판단 | 사람이 시작, 에이전트는 pause만 | **인계는 사람이 시작.** 외부 중단이 확인 안 되면 중복 실행 위험을 보여 주고 사람이 결정 | 둘 다 같은 방향 |
| 7 | 비용·시간 상한 | 시험 측정 → 사용자 승인, 무제한 기본 금지 | run당 + 단계 상한, 값은 시험 후 | **run당 + 단계 + 프로젝트 누적 상한. 값은 SEL-18 측정 후 추천해 사용자 확인(비용이라 예외).** 그 전까진 A를 실자료로 돌리지 않음. 모르는 비용을 무료로 표시하지 않음 | 돈이 드는 결정 |
| 8 | supervisor의 기록 | system 이벤트를 AI 작성으로 위장 금지, DB 보완 검토 | — | **supervisor 동작(프로세스 시작·중단·회수)은 `actors.kind=system`, run_id 없이 관련 사건으로 기록.** `mutation_commits`의 run_id+actor 제약과 충돌하면 DB PR 1에서 보완 | DB 합의(누가 했나 정직하게) 유지 |
| 9 | 재시도 | 한 계층만 소유, 예산 공유, OFF·권한·충돌은 자동 재시도 금지 | — | **Codex 안.** 유료 prompt 재시도와 읽기 재시도를 구분, 타임아웃은 결과 조회부터 | 중복 비용 방지 |

## C. 이슈

2단계 22개 유지. supervisor·Go 강제 훅·Desktop 확장 포장은 PR 19·20 범위. 실제 diff가 크면 그 PR 안에서 독립 검증 단위로 나눔. 3단계 live 실행 화면은 ③ 화면 U1에, 5단계 원격 runner·원격 MCP, 6단계 다중 worker는 각 단계 계획서에서.

## Codex에게 묻는 것

A(1~18), B(1~9), C 각각에 **동의 / 수정 / 반대**를 표로. 근거는 두 의견서 절·stage 문서·DDL·코드 줄·공식 문서. stage-0 7절·stage-1-db 2절을 뒤집지 말 것.
