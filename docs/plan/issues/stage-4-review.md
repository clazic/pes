# 4단계 구현 이슈 초안 — 동료 검토

- 검토: 2026-11-05, OpenCode
- 대상: [stage-4.md](stage-4.md)(4절·5절), [stage-1-db.md](../stage-1-db.md)(2·3.2·3.5절), [stage-1-api.md](../stage-1-api.md)(2·6절), [stage-1-ui.md](../stage-1-ui.md)(7절), [DDL](../schemas/stage-1-ddl-draft.sql), 실제 `scripts/`·`templates/`
- 범위: 문서 대조만. 코드·계획서는 고치지 않았다. 실제 `~/pes-projects`·`~/.pes/`는 읽지 않았고 합성 예시만 쓴다. Linear 이슈는 만들지 않았다.
- 결론: **문제 13, 고침 7**(나머지 6은 계획서 쪽 결정·범위 조정이 필요해 남김)

## 1. 네 가지 확인 축 요약

| 확인 축 | 결과 |
|---|---|
| 계획서 이슈가 모두 있는가 | **있음.** 계획서 4절의 9개(PR 23~25, U7~U12)와 초안 9개 절이 1:1로 대응한다. 번호·제목도 같다. |
| 이슈 하나 = PR 하나인가 | **형식은 지킴.** 9개 절이 각각 1개 이슈다. 다만 PR 23이 계획서 4절 범위를 넘어 판 시작·프로젝트 보관까지 떠안았다(문제 1·2). |
| 선행·완료 기준(테스트 명령)이 있는가 | **있음.** 9개 절 모두 `선행 이슈`와 `완료 기준`이 있고, 각 절에 `python3 -m pytest …`와 필요한 `npx playwright test …`가 있다. 다만 PR 24 선행이 계획서와 다르고(문제 3), A·B 교차 계약 시험이 공통 규칙에 없었다(문제 13, 고침). |
| 고칠 파일·표 이름이 실제와 맞는가 | **기존 파일은 맞고, 3단계 경로 서술 하나가 틀렸다**(문제 6, 고침). 신규 모듈은 아직 없는 계획 경로이며 경로 전제 줄로 매핑한다. 표·열은 DDL과 대조해 U9 하나가 틀렸다(문제 8, 고침). |

**실제로 확인한 이름**: `scripts/pes.py`(`cmd_serve`·`cmd_open`·`cmd_list`·`cmd_home`·`CMDS`·`main`), `scripts/serve.py`(`do_GET`), `templates/hub.html`, `agents/reviewer.md`, `skills/core/SKILL.md`, `skills/plan/SKILL.md`, `docs/plan/schemas/stage-1-ddl-draft.sql`, `docs/plan/schemas/check_ddl.py`, `docs/plan/decisions/` — 모두 존재한다.

**DDL과 맞는 것**: `editions.settings_json`, `artifacts.origin_version_id`, `object_versions.based_on_version_id`, `decisions.originated_from_version_id`, `followups.origin_version_id`, `followup_versions(kind/state/target_stage_id/target_round_id/base_artifact_version_id/proposed_artifact_version_id)`, `artifact_versions.conflicts`, `stages.approved_snapshot_id`·`stale_since_event_seq`, `rounds.sealed_snapshot_id`, `snapshots.scope`, `projects.active_edition_id`, `db_meta.database_instance_id`·`cursor_epoch`, `events.event_seq`, `mutation_commits.action`·`result_json`, `decision_versions.state`, `threads.context_kind='general'`, `question_sets.purpose='stage_start'`, `anchors`·`anchor_resolutions`, `run_targets`, `project_leases`.

**아직 없는 계획 경로**: `scripts/pes_core/…`, `scripts/pes_api/v1.py`, `scripts/pes_web/workspace.py`, `templates/workspace/`, `static/workspace/`, `tests/test_stage4_*.py`, `tests/e2e/stage4_*.spec.ts`. 2·3단계에서 생길 경로이므로 오타는 아니고, 초안의 "경로 전제" 줄이 이를 매핑한다.

## 2. 문제 목록

| # | 위치 | 확인 축 | 문제 | 근거 | 조치 |
|---:|---|---|---|---|---|
| 1 | PR 23 할 일 — `editions.py`, CLI·API | 1이슈=1PR / 범위 | `start_edition()`과 `cmd_edition_start`, `POST …/editions`를 새로 구현한다. 계획서는 PR 23을 "PR 6의 판 시작·완료·해제 계약을 **재사용**하고 완료 정책·이월 기록만 확장"으로 한정한다. PR 6과 중복될 수 있다. | stage-4 4절 PR 23 | 남김 — PR 6 재사용인지 PR 6 확장인지 명시 필요 |
| 2 | PR 23 할 일 — `archive_project()`·`reopen_project()` | 계획서 이슈 범위 | 프로젝트 보관·다시 열기 서비스와 API·CLI가 계획서 4절 PR 23 범위(완료 정책·이월)에 없다. 2.1절은 보관을 정했지만 4절 표가 단일 기준이라 소유 이슈가 비어 있다. | stage-4 2.1, 4절 | 남김 — 4절 표 갱신 또는 별도 이슈로 분리 |
| 3 | PR 24 선행 | 선행 | 계획서는 `PR 23·14`인데 초안은 `PR 23, PR 14, PR 4, PR 6`으로 2개를 더 둔다. 4절 표가 단일 기준이라는 규칙과 어긋난다. | stage-4 4절 | 남김 — 표에 맞추거나 전이 의존임을 표시 |
| 4 | PR 23 완료 기준 | 완료 조건 누락 | 계획서 2.1의 완료 조건 "실행 차단 상태 없음"이 빠졌다. | stage-4 2.1 | **고침** |
| 5 | PR 23 문서 갱신 | 누락 | `stage-1-db.md` 3.2만 갱신한다고 썼다. 계획서 7절은 3.2·3.5를 함께 갱신하라고 한다. | stage-4 7절 | **고침** |
| 6 | 머리말 "경로 전제" | 파일 이름 | "3단계 U1의 `scripts/pes_web/workspace.py`"라고 단정했지만, 3단계 U1의 경계는 `scripts/serve.py`·`templates/workspace/`·`static/workspace/`다. | issues/stage-3.md 파일 경계, stage-3 4절 | **고침** |
| 7 | 머리말 "공통 지킬 것", PR 23·25 | 표·열 범위 | `projects.settings_json`과 `run_targets.direct_edit_*`를 새 열로 못박았지만 계획서 4절 PR 23·25 범위에는 열 이름이 없다(계획서는 `edition_carryovers`·`completed_snapshot_id`만 명시). 기능 요구(2.6·2.7)는 있으므로 계획서 쪽 갱신이 필요하다. | stage-4 2.6·2.7, 4절 | 남김 — 계획서 4절에 열을 추가하거나 "구현 세부"로 낮춤 |
| 8 | U9 할 일 — 후보 저장 | 표·열 | `decision_versions(scope='edition', state='proposed')`라고 썼다. `scope`는 `decisions`의 열이고 `decision_versions`에는 없다. | DDL `decisions`·`decision_versions`, stage-1-db 3.5 | **고침** |
| 9 | U9 완료 기준 | 계획서와 충돌 | "근거 부족 시 생성하지 않고"라고만 써서, 미검증 가정과 확인할 근거를 표시한 대안을 허용하는 계획서 2.4와 어긋난다. | stage-4 2.4 | **고침** |
| 10 | U9 할 일·완료 기준 | 범위 누락 | 계획서 2.4의 "라운드당 최대 한 묶음", "요청 시 추가는 상한에 계상", "같은 묶음 교체·재생성은 새 run 없이"와 4절의 "MCP 어댑터"가 빠졌다. | stage-4 2.4, 4절 U9 | 남김 — U9 범위 보강 필요 |
| 11 | U12 완료 기준·지킬 것 | 누락 | 계획서 2.7·5절의 "기존 화면 최소 한 마이너 버전 유지"가 없다. | stage-4 2.7, 5절 | **고침** |
| 12 | U12 할 일 | 범위 누락 | 계획서 4절 U12 범위에 있는 "U5 B 전달·복사 흐름"이 할 일에 없다(선행에만 U5가 있다). | stage-4 4절 U12 | 남김 — U12 범위 보강 필요 |
| 13 | 머리말 "공통 테스트" | 완료 기준 누락 | 계획서 3·5절은 PR 21 교차 계약 하네스를 PR 23~25·U7~U12가 확장해 각 PR에서 A/B를 시험하라고 하는데, 공통 규칙에 없었다. | stage-4 3절, 5절 | **고침** |

## 3. 고친 것 (7건)

`docs/plan/issues/stage-4.md`만 고쳤다.

1. **PR 23 완료 기준** — "미종결 run·stale·필수 응답"에 **"실행 차단 상태"**를 더했다(문제 4).
2. **PR 23 문서 갱신** — `stage-1-db.md` **3.2 → 3.2·3.5**(문제 5).
3. **머리말 경로 전제** — 3단계 U1 산출물을 `scripts/pes_web/workspace.py`로 단정한 문장을 **`scripts/serve.py`(서버 렌더·API 라우트)·`templates/workspace/`·`static/workspace/` 경계**로 고치고, 화면 모듈이 분리됐을 때만 `scripts/pes_web/workspace.py`를 쓰도록 조건을 붙였다(문제 6).
4. **U9 후보 저장** — `decision_versions(scope='edition', state='proposed')` → **`decisions(scope='edition')`·`decision_versions(state='proposed')`**(문제 8).
5. **U9 완료 기준** — "근거 부족 시 생성하지 않고" → **"차이를 설명할 근거조차 없을 때만 생성하지 않고(미검증 가정·확인할 근거를 표시한 대안은 허용)"**(문제 9).
6. **U12 완료 기준·지킬 것** — 기존 화면을 **최소 한 마이너 버전 유지**하고 제거는 6단계 별도 결정으로 둔다는 조건을 넣었다(문제 11).
7. **공통 테스트** — **PR 21 교차 계약 하네스를 확장해 각 PR에서 A·B 같은 의미·같은 버전 결과를 시험**한다는 문장을 넣었다(문제 13).

## 4. 남긴 것 (6건)

문제 1·2·3·7·10·12는 문구만 고쳐 해결되지 않는다. 계획서 4절 표의 범위를 넓히거나, PR 23을 나누거나, U9·U12의 범위를 보강해야 하므로 이번에는 고치지 않고 위 표에만 남겼다.

- 문제 1·2: PR 23이 "PR 6 재사용 + 완료·이월"을 넘어 판 시작·프로젝트 보관까지 포함한다. **PR 23 분할 여부는 계획서 결정**이다.
- 문제 3: PR 24 선행에 PR 4·6을 더한 것이 전이 의존 표시인지 실제 선행인지 확인이 필요하다.
- 문제 7: `projects.settings_json`·`run_targets.direct_edit_*`는 기능상 필요하지만 계획서 4절에 없다. **계획서를 고치거나 "구현 세부"로 낮추는 결정**이 필요하다.
- 문제 10·12: U9의 묶음 상한·MCP 어댑터, U12의 U5 B 전달·복사 흐름이 계획서 범위에 있는데 초안 할 일에 없다.
