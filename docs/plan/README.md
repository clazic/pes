# PES 재설계 계획 문서 색인

- 대상: `docs/plan/` 아래 계획서·기준선·대조표·시험 기록·픽스처·이슈 원고
- 기준일: 2026-11-05
- 이 문서는 색인이다. 계획서·DDL·코드는 고치지 않는다. 실제 `~/pes-projects`·`~/.pes/` 자료는 쓰지 않는다.

**상태 뜻**

| 상태 | 뜻 |
|---|---|
| **확정** | 사용자 승인 또는 기준선으로 고정된 문서. 임의로 다시 정하지 않는다. |
| **검수 반영** | Codex·Opus 검수 지적을 반영한 계획서. 사용자 단계 승인은 별도다. |
| **초안** | 아직 승인·실행 전인 원고·시험 계획·시안. |
| **검수 기록** | 계획서에 대한 1·2차 검수, 최종 대조, 교차 대조 기록. 계획서 본문이 아니다. |
| **시험 기록** | 0단계·WEB0 등 실험의 계획·코드·원시 결과. 제품 코드가 아니다. |
| **조사 기록** | 외부 제품·표준 조사 메모. 합의 설계서보다 우선하지 않는다. |
| **운영 기록** | 결함처럼 계속 갱신하는 운영 문서. |

## 1. 읽는 순서

1. **배경**: [00-brief.md](00-brief.md) → [stage-0.md](stage-0.md).
2. **1단계 확정 설계**: [stage-1-db.md](stage-1-db.md) → [stage-1-api.md](stage-1-api.md) → [stage-1-ui.md](stage-1-ui.md) → [stage-1-runners.md](stage-1-runners.md). 함께 [DDL 초안](schemas/stage-1-ddl-draft.sql)·[DDL 검사](schemas/check_ddl.py)·[API 계약 픽스처](fixtures/api-v1/README.md)를 본다.
3. **전체 지도**: [roadmap.md](roadmap.md)의 2절(이슈 수)·3절(의존)·4절(위험)·5절(사용자 결정)을 먼저 본다. 비개발자 승인용으로는 [summary-for-approval.md](summary-for-approval.md)를 함께 본다. 단계 문서의 누적 이슈 수는 숫자 대신 로드맵 2절을 따른다.
4. **구현 단계**: [stage-2.md](stage-2.md) → [stage-3.md](stage-3.md) → [stage-4.md](stage-4.md) → [stage-5.md](stage-5.md) → [stage-6.md](stage-6.md).
5. **Linear 등록 원고**: [issues/stage-2.md](issues/stage-2.md) ~ [issues/stage-6.md](issues/stage-6.md). 등록 전에 각 단계의 `*-review.md`를 함께 본다.
6. **참조**: [baseline.md](baseline.md)(현행 기준선), [glossary.md](glossary.md)(용어), [migration-map.md](migration-map.md)(legacy→DDL), [ddl-gaps.md](ddl-gaps.md)(2~6단계 DDL 누락), [skill-neutral-inventory.md](skill-neutral-inventory.md), [webmcp-tools.md](webmcp-tools.md), [defects.md](defects.md).
7. **근거·실험**: [research/](research/)(외부 조사), [spikes/](spikes/)(0단계·WEB0 시험), [mockups/](mockups/)(정적 시안). 검수 기록 [discussion/](discussion/)은 계획서의 이유를 확인할 때만 읽는다.

## 2. 최상위 문서

| 문서 | 한 줄 설명 | 상태 |
|---|---|---|
| [00-brief.md](00-brief.md) | PES 재설계 배경·현행 구조·사용자 요구·단계 개요. | 확정 |
| [stage-0.md](stage-0.md) | 0단계 기반 다지기: 테스트·기준선·CI·결정/결함 기록·A/B 시험. | 확정 |
| [stage-1-db.md](stage-1-db.md) | 1단계 DB 설계: 표·키·관계·상태 전이·SQLite/D1·이전·DDL. | 확정 |
| [stage-1-api.md](stage-1-api.md) | 1단계 HTTP/JSON API 계약: 닫힌 명령·멱등·오류·MCP·변경분. | 확정 |
| [stage-1-ui.md](stage-1-ui.md) | 1단계 작업 공간 화면 설계: 질문·답·첨언·인쇄·접근성. | 확정 |
| [stage-1-runners.md](stage-1-runners.md) | 1단계 방식 A·B 실행 구조: lease·재개·인계·비용·기록. | 확정 |
| [stage-2.md](stage-2.md) | 2단계 새 뼈대: 로컬 SQLite+API, 25 PR(PR1~19·20a·20b·20c·21·22·26), 프로젝트 이전·전환. | 검수 반영 |
| [stage-3.md](stage-3.md) | 3단계 소통 기능: U1~U6, REF1 이전 프로젝트 참고자료, MAT1 내 자료·AI 참조 스위치, W1 WebMCP·R1 자동 재개·T1 실제 시험. | 검수 반영 |
| [stage-4.md](stage-4.md) | 4단계 판과 고급 소통: PR23~25·U7~U12, 판 이월·비교·편집. | 검수 반영 |
| [stage-5.md](stage-5.md) | 5단계 웹 이전: WEB0~WEB15, 플랫폼 후보 3군·로그인·웹 A 실행기(Workflows)·양방향 연결·백업. | 검수 반영 |
| [stage-6.md](stage-6.md) | 6단계 넓히기: E/M/G/H/X, 다중 에이전트·사람·내보내기·hwpx. | 검수 반영 |
| [roadmap.md](roadmap.md) | 0~6단계 지도: 이슈 수·의존·위험·사용자 결정·불일치 규칙. | 검수 반영 |
| [summary-for-approval.md](summary-for-approval.md) | 2~6단계 계획을 사용자 승인 전에 읽는 비개발자용 요약. | 초안 |
| [baseline.md](baseline.md) | PES v0.15.6 현행 기준선과 보존/변경 판정. | 확정 |
| [glossary.md](glossary.md) | 현행 코드와 1~6단계 계획의 용어·동작 목록. | 확정 |
| [migration-map.md](migration-map.md) | legacy `project.json`·파일 → DDL 표·열 대응(2단계 PR11). | 확정 |
| [ddl-gaps.md](ddl-gaps.md) | 2~6단계가 요구하지만 1단계 DDL에 없는 표·열·상태 값과 마이그레이션 귀속. | 초안 |
| [skill-neutral-inventory.md](skill-neutral-inventory.md) | 스킬·명령의 Claude 전용 표기·직접 쓰기 인벤토리(2단계 PR17). | 초안 |
| [webmcp-tools.md](webmcp-tools.md) | 3단계 WebMCP 실험의 노출 도구 목록·금지 API 초안. | 초안 |
| [defects.md](defects.md) | 재현한 결함만 적는 운영 결함 기록. | 운영 기록 |

## 3. schemas/ — 스키마·검사

| 문서 | 한 줄 설명 | 상태 |
|---|---|---|
| [schemas/stage-1-ddl-draft.sql](schemas/stage-1-ddl-draft.sql) | 1단계 확정 DDL 초안(61개 표, REF1·MAT1·5차 동기화 표 포함). 마이그레이션의 기준 문서. | 확정 |
| [schemas/check_ddl.py](schemas/check_ddl.py) | DDL을 임시 SQLite에서 실행하고 성공·거부·롤백을 검사하는 스크립트. | 확정 |
| [schemas/project-v0.15.json](schemas/project-v0.15.json) | 현행 `project.json` 기준 JSON Schema. | 확정 |

## 4. fixtures/ — 계약 시험 픽스처

| 문서 | 한 줄 설명 | 상태 |
|---|---|---|
| [fixtures/api-v1/README.md](fixtures/api-v1/README.md) | API 6절 동작별 정상·오류·멱등 재생 JSON 픽스처의 색인·규칙. | 확정 |
| [fixtures/api-v1/*.json](fixtures/api-v1/) | 동작별 합성 요청·응답 38개. 실제 서버·DB·자료와 연결하지 않는다. | 확정 |
| [fixtures/check_fixtures.py](fixtures/check_fixtures.py) | 픽스처 형식·계약 정합성 검사 스크립트. | 확정 |

## 5. issues/ — Linear 등록 원고

| 문서 | 한 줄 설명 | 상태 |
|---|---|---|
| [issues/stage-2.md](issues/stage-2.md) | 2단계 PR1~19·20a·20b·20c·21·22·26 구현 이슈 원고. | 초안 |
| [issues/stage-2-review.md](issues/stage-2-review.md) | 2단계 이슈 원고 동료 검토. | 검수 기록 |
| [issues/stage-3.md](issues/stage-3.md) | 3단계 U1~U6·REF1·MAT1·W1·R1·T1 구현 이슈 원고. | 초안 |
| [issues/stage-3-review.md](issues/stage-3-review.md) | 3단계 이슈 원고 동료 검토. | 검수 기록 |
| [issues/stage-4.md](issues/stage-4.md) | 4단계 PR23~25·U7~U12 구현 이슈 원고. | 초안 |
| [issues/stage-4-review.md](issues/stage-4-review.md) | 4단계 이슈 원고 동료 검토. | 검수 기록 |
| [issues/stage-5.md](issues/stage-5.md) | 5단계 WEB0~WEB15 구현 이슈 원고. | 초안 |
| [issues/stage-5-review.md](issues/stage-5-review.md) | 5단계 이슈 원고 동료 검토. | 검수 기록 |
| [issues/stage-6.md](issues/stage-6.md) | 6단계 E1~E2·M1~M3·G1~G3·H1·X1~X2 구현 이슈 원고. | 초안 |
| [issues/stage-6-review.md](issues/stage-6-review.md) | 6단계 이슈 원고 동료 검토. | 검수 기록 |

## 6. spikes/ — 0단계·WEB0 시험

| 문서 | 한 줄 설명 | 상태 |
|---|---|---|
| [spikes/mode-a-opencode.md](spikes/mode-a-opencode.md) | SEL-18 방식 A(opencode HTTP API) 시험 기록·판정. | 시험 기록 |
| [spikes/mode-a/README.md](spikes/mode-a/README.md) | 방식 A 시험 코드 실행법·범위. | 시험 기록 |
| [spikes/mode-a/mode_a_spike.py](spikes/mode-a/mode_a_spike.py) | 방식 A 시험 코드. 제품 코드가 아니다. | 시험 기록 |
| [spikes/mode-a/results-2026-11-05.json](spikes/mode-a/results-2026-11-05.json) | 방식 A 원시 결과(경로·비밀번호 제거). | 시험 기록 |
| [spikes/web0-plan.md](spikes/web0-plan.md) | WEB0 코어 언어 시험 계획. 실행은 2단계 PR1 전, TS 계약 픽스처 사용. | 초안 |

## 7. discussion/ — 검수·대조 기록

| 문서 묶음 | 한 줄 설명 | 상태 |
|---|---|---|
| [discussion/stage-0-codex.md](discussion/stage-0-codex.md), [stage-0-opencode.md](discussion/stage-0-opencode.md) | 0단계 Codex·OpenCode 초안 의견. | 검수 기록 |
| `discussion/stage-1-db-{opencode,codex,claude-recs,codex-review,final-check}.md` | DB 설계 추천안·1차 의견·Codex 검수·최종 대조. | 검수 기록 |
| `discussion/stage-1-api-{opencode,codex,claude-recs,codex-review,final-check}.md` | API 설계 추천안·1차 의견·Codex 검수·최종 대조. | 검수 기록 |
| `discussion/stage-1-ui-{opencode,codex,claude-recs,codex-review,final-check}.md` | 화면 설계 추천안·1차 의견·Codex 검수·최종 대조. | 검수 기록 |
| `discussion/stage-1-runners-{opencode,codex,claude-recs,codex-review,final-check}.md` | 실행 구조 추천안·1차 의견·Codex 검수·최종 대조. | 검수 기록 |
| `discussion/stage-2-{codex-review,final-check,opus-check}.md` | 2단계 1차 검수·최종 대조·Opus 2차 확인. | 검수 기록 |
| `discussion/stage-3-{codex-review,final-check,opus-check}.md` | 3단계 1차 검수·최종 대조·Opus 2차 확인. | 검수 기록 |
| `discussion/stage-4-{codex-review,final-check,opus-check}.md` | 4단계 1차 검수·최종 대조·Opus 2차 확인. | 검수 기록 |
| `discussion/stage-5-{codex-review,final-check,opus-check}.md` | 5단계 1차 검수·최종 대조·Opus 2차 확인. | 검수 기록 |
| `discussion/stage-6-{codex-review,final-check,opus-check}.md` | 6단계 1차 검수·최종 대조·Opus 2차 확인. | 검수 기록 |
| [discussion/cross-check.md](discussion/cross-check.md), [cross-check-opus.md](discussion/cross-check-opus.md) | 계획서 교차 대조와 Opus 판정·파일별 반영 지시. | 검수 기록 |
| [discussion/roadmap-opus-check.md](discussion/roadmap-opus-check.md) | 로드맵 Opus 확인·이슈 수 정정·WEB0 시점 지시. | 검수 기록 |

> 표의 `discussion/stage-1-db-{opencode,codex,...}.md`는 같은 접두어를 가진 파일 묶음을 뜻한다. `discussion/`의 `stage-1-*` 파일은 확정 설계서의 **근거 기록**이다. 확정 본문은 `stage-1-*.md`이며, `discussion/`을 고쳐 설계를 바꾸지 않는다.

## 8. research/ — 외부 조사

| 문서 | 한 줄 설명 | 상태 |
|---|---|---|
| [research/notion-linear.md](research/notion-linear.md) | Notion·Linear의 동작·데이터 모델 조사와 PES 아이디어. | 조사 기록 |
| [research/webmcp.md](research/webmcp.md) | WebMCP 표준·브라우저·에이전트 지원 조사. | 조사 기록 |

## 9. decisions/ — 결정 기록

| 문서 | 한 줄 설명 | 상태 |
|---|---|---|
| [decisions/README.md](decisions/README.md) | 결정 기록 양식·색인. 개별 결정은 `<번호>-<이름>.md`로 추가한다. | 확정 |

## 10. mockups/ — 정적 시안

| 문서 | 한 줄 설명 | 상태 |
|---|---|---|
| [mockups/workspace.html](mockups/workspace.html) | 3단계 작업 공간 정적 시안. 제품 화면이 아니다. | 초안 |

## 11. 문서를 읽을 때의 규칙

- **상태 줄을 먼저 본다.** `확정`과 `검수 반영`은 다르다. 단계 문서는 사용자 단계 승인 전까지 `검수 반영`이다.
- **누적 이슈 수는 단계 문서에서 계산하지 않는다.** [roadmap.md](roadmap.md) 2절의 SEL ID 기준 표를 따른다.
- **1단계 확정 문서는 고치지 않는다.** 바뀐 계약은 `ddl-gaps.md`·`issues/`·`discussion/`에 적고, 1단계 변경은 사용자 확인 뒤 별도로 다룬다.
- **실제 자료·실키·기관 자료는 이 디렉터리에 넣지 않는다.** 모든 예시는 합성 fixture다.
- **Linear 등록 전 원고와 계획서를 구분한다.** `issues/`는 등록 원고이며, Linear에 아직 만들지 않았다.
