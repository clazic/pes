# 2026-11-05 검수 반영 2차 — 묶음 summary

- 입력: [fix-web](2026-11-05-fix-web.md)·[fix-runner](2026-11-05-fix-runner.md)·[fix-ddl](2026-11-05-fix-ddl.md)·[fix-later](2026-11-05-fix-later.md)·[fix-summary](2026-11-05-fix-summary.md)
- 수정 파일: `roadmap.md`, `summary-for-approval.md`, `README.md`, `stage-1-api.md`, `decisions/0003-mode-b-agents.md`, `decisions/README.md`, `00-brief.md`, `discussion/2026-11-05-go-subscription-and-b-apps-changes.md`, `discussion/2026-11-05-mode-a-web-direct-and-references.md`
- 실제 `~/pes-projects`·`~/.pes/`는 읽거나 쓰지 않았다. 실제 자료·키·사용자 절대경로·세션 ID를 넣지 않았다. 커밋·push·Linear 등록은 하지 않았다.
- `stage-1-api.md`는 1단계 확정 문서지만 사용자 정의 정정 범위로 개정하고 상태줄에 **2026-11-05 개정**을 유지했다. 다른 `stage-1-*.md`는 건드리지 않았다.

## 처리한 항목

| 출처 | 항목 | 반영 |
|---|---|---|
| web | F01 | `roadmap.md`의 WEB0 표기를 **2단계 PR1 전 TS 계약 픽스처**로 고쳤다(순서도·실험표·3.1). `README.md`의 web0-plan 설명도 PR1 전 TS로 고쳤다. `summary-for-approval.md`는 이미 PR1 전 TS여서 유지했다. |
| web | F03 | `roadmap.md`·`summary-for-approval.md`에 **플랫폼 공통 계약과 Cloudflare 기준 구현을 구분**하고 WEB0 결과를 WEB1~14의 DB·파일·실행기·실시간·백업·비용 계기 설계에 인계하며, 유료 안은 비용 승인 뒤 그 예산으로 시험한다고 추가했다. |
| web | F12 | `stage-1-api.md`에 **6.1 WEB15 양방향 연결 명령(초안)** 표를 추가했다. `sync.link.create/revoke/heartbeat`, `sync.push/pull`, `sync.conflict.resolve`, `schedule.report`, `progress.report`의 actor·scope·expected rev·멱등·tx 경계를 적고, 매 메시지 권한 검사·교차 기기/프로젝트·가짜 완료 거부·파일은 HTTP를 명시했다. 상태줄에 2026-11-05 개정을 유지했다. |
| web | F15 | `discussion/2026-11-05-mode-a-web-direct-and-references.md`의 Oracle 수치를 공식 기준(**1,500 OCPU-h·9,000 GB-h/월=상시 2 OCPU·12GB**, 7일 CPU p95·네트워크·A1 메모리 각 20% 미만 회수, 지역 재고·카드 확인)으로 고쳤다. Hetzner 월 총액은 WEB0 견적(미확인)으로 표시했다. |
| ddl·later·summary | F16 | `roadmap.md`·`summary-for-approval.md`·`README.md`의 표 수를 **61표**로 고쳤다. `stage-1-api.md`의 2단계 22개 표기를 현행 25개(PR1~19·20a·20b·20c·21·22·26)와 roadmap 2절 참조로 바꾸고, 2026-11-04 당시 22개는 시점 기록으로 남겼다. `roadmap.md`·`summary-for-approval.md`의 101·159 산술은 유지했다. `README.md`의 stage-2/issues/stage-2 목록도 25개로 맞췄다. |
| runner | F02 | `roadmap.md`의 U1 템플릿 공유 실험을 **Python/Workers**에서 **TS 서버 렌더/Workers**로 고쳤다. Python 0.15 이전 언급은 PR26 이전 대상으로만 남겼다. |
| summary | R04 | 두 discussion 파일 첫머리에 **최종 8차: 2단계 25·3단계 11·4단계 9·5단계 16·6단계 9, 신규 70+기존 31=101, DDL 61표**를 안내했다. mode-a 파일의 최종 DDL 수치도 61표·거부 59로 고쳤다. `decisions/README.md`의 0002를 **일부 대체(0013)**로 표시했고 0013·0014·0016 색인을 확인했다. |
| summary | F05/F06 | 1차 반영을 확인하고, `roadmap.md`·`summary-for-approval.md`·`00-brief.md`·`stage-1-api.md`에 **원시 model ID↔내부 ID**와 **오류/스트림 필드**를 추가해 후보·검증 대상임을 더 분명히 했다. |
## 건너뛴 항목(이미 반영)

- **R03**: 1차에서 이미 정한 것(TS 단일 언어·0.15 이전·파일 기본 allow·B 양방향·통로 분리)과 남은 결정을 분리했다. 이번에 다시 고치지 않았다.
- **F17**: `0003`·`summary`·`00-brief`·`roadmap`은 1차에서 이미 3통로(PC 도우미↔웹 WebSocket/HTTP, AI 도구↔PES MCP/API, 브라우저 안 보조만 WebMCP)로 고쳤다. 이번에는 확인만 했다.
- **F18**: `stage-5.md`·`decisions/0013`의 instance당 subrequest 50·instance 교체가 Go 사용량/unknown/멱등을 초기화하지 않는다는 문구를 확인했다. 우리 파일에는 추가 변경이 필요 없었다.
- **F09**: `summary`·`roadmap`·`00-brief`는 1차에서 이미 B 로컬 직접 읽기 한계를 반영했다. 이번에는 확인만 했다.
- **F16의 22→25**: 1차에서 이미 반영했다. 이번에는 61표·논의 파일 헤더를 보강했다.
- **stage-1-runners·decisions/0013·stage-5·issues/stage-5·stage-3·stage-6·issues/stage-3·issues/stage-2·issues/stage-6·DDL**의 해당 항목은 각 묶음이 2차에서 이미 반영한 것을 확인했다(Go 주소·Extra Usage·blocked_usage·WebMCP·WEB15·A-only 참조·file_policies·TS 표기·G3 선행·sync 표). 우리 파일에 필요한 부분만 위에서 처리했다.

## 여전히 남은 것(다른 파일)

- `docs/plan/issues/stage-2.md:9,79,249`의 WEB0가 아직 **PR4·13 계약 픽스처 직후**로 적혀 있다. **2단계 PR1 전 TS 계약 픽스처**로 고쳐야 한다.
- `docs/plan/issues/stage-3.md:5`의 MAT1 표기가 아직 `version_files`·`file_ai_access_versions.version_id/blob_id` 중심이다. DDL 묶음의 **`file_policies.file_policy_id`·`file_ai_access_versions.file_policy_id`**로 맞춰야 한다.
- `docs/plan/decisions/0016-core-language.md`의 Python/pytest 언급은 PR26 이전·동등성 시험 맥락으로 남아 있어 추가 조치는 없다. 새 코드·시험을 Python으로 배정하는 문구가 생기면 TS 계약으로 고쳐야 한다.

완료: docs/plan/discussion/2026-11-05-fix2-summary.md
