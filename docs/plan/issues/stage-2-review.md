# 2단계 구현 이슈 초안 — 동료 검토

- 검토일: 2026-11-05
- 대상: [docs/plan/issues/stage-2.md](stage-2.md)
- 기준: [stage-2.md](../stage-2.md)(Codex·Opus 검수 반영), [stage-1-db.md](../stage-1-db.md)·[stage-1-api.md](../stage-1-api.md)·[stage-1-ui.md](../stage-1-ui.md)·[stage-1-runners.md](../stage-1-runners.md), [DDL](../schemas/stage-1-ddl-draft.sql), 실제 `scripts/`·`templates/`·`tests/`
- 범위: 문서 정적 대조. 실제 `~/pes-projects`·`~/.pes/`는 읽지 않았고, 코드·계획서는 고치지 않았다. Linear 이슈도 만들지 않았다.

## 1. 요약

| 점검 | 결과 |
|---|---|
| 계획서의 2단계 PR 22개가 모두 있는가 | **22/22 있음** (PR 1~22, 제목·범위 대응) |
| 이슈 하나 = PR 하나인가 | **22/22** (하위 PR·표별 이슈 없음) |
| 각 이슈에 선행이 있는가 | **22/22** (PR 1은 0단계 게이트, 나머지는 PR/SEL 번호) |
| 각 이슈에 완료 기준과 테스트 명령이 있는가 | **22/22** (`python3 -m pytest -q <파일>` 형식) |
| 고칠 파일·표 이름이 실제와 맞는가 | **7건 수정** (아래 표) |

## 2. 문제와 고침

| # | 위치 | 문제 | 판정 | 고침 |
|---|---|---|---|---|
| 1 | PR 1 `paths.py` | `PES_HOME`을 "프로젝트 폴더만"이라고 적어, 실제 의미인 **프로젝트 위치(루트)만 바꾸고 DB·객체 경로는 바꾸지 않음**과 어긋남 | 오타·의미 누락 | `PES_HOME`은 프로젝트 위치(루트)만 바꾸고 DB·객체 경로는 바꾸지 않는다고 수정 |
| 2 | PR 6 `carry_over` | `stages.carry_over`라는 열은 DDL에 없음. 실제 `stages`에는 `settings_json`만 있고, 이월은 `artifacts`·`origin_version_id`·`version_relations`로 표현해야 함 | 표·열 이름 불일치 | `stages.settings_json` 임시 JSON이 아니라 기획 `artifacts(kind='topic')`의 정확한 버전에서 조사 `artifacts(kind='topic')`를 만들고 `origin_version_id`·`version_relations`로 연결한다고 수정 |
| 3 | PR 13 API 경로 | `POST /api/v1/runs/{r}/results`·`/complete`가 프로젝트 범위를 빠뜨림. 실제 계약은 `P = /api/v1/projects/{id}` 아래 `P/runs/{r}/...` | 경로 누락 | `POST /api/v1/projects/{id}/runs/{r}/results`·`/complete`로 수정 |
| 4 | PR 14 API 경로 | `POST /questions`, `GET /changes`, `POST /stages/{s}/approve` 등이 `P` 접두어를 생략해 실제 경로와 다름 | 경로 누락 | `P = /api/v1/projects/{id}`를 명시하고 `P/questions`, `P/changes`, `P/stages/...`, `P/runs/...`로 수정 |
| 5 | PR 15 `CMDS` | 기존 32개에 `context/claim/submit/wait/complete` 5개를 더하는데 완료 기준이 "CMDS 32개"로 남아, 신규 5개가 빠진 것처럼 읽힘 | 수량 누락 | "기존 32개(쓰기 19·읽기 13) + 신규 5개"로 수정 |
| 6 | PR 16 `cmd_report` | 읽기·보고서 명령인데 "각주 등록"이라고 적어, 실제 동작인 **정확한 버전·각주 참조**와 어긋남 | 동작·용어 오류 | "정확한 버전·각주를 참조"로 수정 |
| 7 | PR 18 `fill` | `fill`은 템플릿 렌더러인데 "DB 읽기 모델로 바꾼다"에 포함되어, 실제 함수 역할과 어긋남 | 함수 역할 불일치 | `load`·`brief`·`build_index`·`build_hub`만 DB 읽기 모델로 바꾸고, `fill`은 템플릿 렌더러로 유지한다고 수정 |

## 3. 고친 내용

1. PR 1: `PES_HOME`의 의미를 프로젝트 위치(루트)로 한정하고 DB·객체 경로 불변을 명시했다.
2. PR 6: 존재하지 않는 `stages.carry_over` 열 참조를 실제 `artifacts`·`origin_version_id`·`version_relations` 기반 이월로 바꿨다.
3. PR 13: run 결과·완료 API 경로에 `/api/v1/projects/{id}`를 넣었다.
4. PR 14: 질문·답·변경분·승인·reopen·입력 API 경로를 `P = /api/v1/projects/{id}` 기준으로 통일했다.
5. PR 15: 기존 `CMDS` 32개와 신규 5개를 구분해 완료 기준을 맞췄다.
6. PR 16: `cmd_report`의 "각주 등록"을 "각주 참조"로 바로잡았다.
7. PR 18: `fill`을 DB 읽기 모델 변경 대상에서 빼고 템플릿 렌더러로 유지한다고 명시했다.

## 4. 확인했지만 고치지 않은 것

- PR 2의 `tests/d1/wrangler.toml`·`package.json`, PR 3의 `manifest.json`, PR 9의 `scripts/pes_core/files.py`, PR 19·20의 `scripts/pes_core/adapters/*`는 실제에 아직 없는 **신규 파일**이다. 이슈에 신규 작업으로 적혀 있어 오타로 보지 않았다.
- PR 17의 `skills/core/SKILL.md:62-84` 직접 편집 예제, PR 18의 `templates/*.html`·`scripts/pes.py` 함수, PR 15·16의 기존 `CMDS` 32개는 실제 파일·함수와 대조해 일치함을 확인했다.
- PR 1~22의 선행·완료 기준·테스트 명령은 계획서 4.2와 대조해 누락이 없음을 확인했다. 다만 PR 2의 로컬 D1 도구 skip 조건과 PR 18의 Playwright 하네스는 구현 시 실제 CI 환경에서 다시 확인해야 한다.

**문제 7, 고침 7.**
