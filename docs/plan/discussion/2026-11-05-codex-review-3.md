수정 후 승인

- 확인일: 2026-11-05. 재검수의 일부 6건·N01~N06·플랫폼 표현 잔여만 현재 문서와 `2026-11-05-fix3-{later,runner,web,summary}.md`에 대조했다. 아래 경로는 `docs/plan/` 기준이다.
- 작성 중인 `issues/stage-2-linear.md`, `spikes/web0-measure.md`, `migration-ts-equivalence.md`는 읽거나 검수하지 않았다. 실제 `~/pes-projects`·`~/.pes/`도 접근하지 않았다. 이 결과 파일만 추가했다.
- **기존 일부 6건 중 5건 해소·1건 일부. N01~N06 중 5건 해소·1건 일부. 플랫폼 표현은 해소.** F02와 N05는 같은 잔여 원인으로 중복 집계하지 않는다.

| 항목 | 판정 | 근거 한 줄 |
|---|---|---|
| F02 TS 단일 언어·검사 인계 | **일부** | `decisions/0016-core-language.md:27`, `stage-4.md:212`, `issues/stage-6.md:10,48,59`는 PR26 산출 TS 검사기로 정리됐으나, `issues/stage-3.md:334`와 `issues/stage-5.md:10`은 이후 단계에서 여전히 Python `check_ddl.py` 갱신을 요구한다. |
| F08 파일 정책 식별·파생본 | **해소** | `stage-1-ui.md:52`, `stage-3.md:266,273`, `issues/stage-3.md:272,277`: PK `file_policies.id`와 참조 열을 구분하고, 다른 blob인 원본/추출본은 각자 정책·서비스의 엄격한 쪽 검사로 맞췄다. |
| F10 참조 스냅숏 삭제 | **해소** | `issues/stage-3.md:250`이 자동 SET NULL 대신 같은 tx의 명시적 snapshot 포인터 해제·source_missing·key/label 보존으로 바뀌어 `stage-3.md:250` 및 DDL과 일치한다. |
| F16 이슈·표 수 | **해소** | `stage-2.md:186`, `issues/stage-2.md:13,20,25`, `issues/stage-5.md:47`, `ddl-gaps.md:3`은 61표, `glossary.md:135`는 현행 25개와 과거 22개를 구분하며 실제 이슈 수도 25/11/9/16/9다. |
| R01 A 결정 제안 | **해소** | `decisions/0013-mode-a-go-subscription-and-model-choice.md:44,48`, `stage-1-runners.md:26`, `stage-3.md:91`, `stage-5.md:188`, `issues/stage-2.md:336`: decision.propose↔decision:propose/pes_decision 매핑·A/B U3 시험·사람만 채택을 명시했다. |
| R04 근거·검증 차수 | **해소** | `discussion/2026-11-05-mode-a-web-direct-and-references.md:163`은 현행 거부 64와 이전 59의 시점을 구분하고, `stage-6.md:213`은 잘못된 API 99행 인용을 POST P/exports로 바꿨다. |
| N01 정책 PK 이름 | **해소** | `issues/stage-3.md:5,272,277`, `stage-3.md:266`에서 file_policies.id와 다른 표의 file_policy_id 계열 참조 열이 구분된다. |
| N02 추출본의 같은 정책 표현 | **해소** | `stage-3.md:266,273`, `issues/stage-3.md:277`: 같은 blob 재사용은 같은 정책, 다른 blob 추출본은 각자 정책이며 원본 deny를 함께 검사한다고 정정했다. |
| N03 tombstone의 NULL 금지 | **해소** | `issues/stage-3.md:250`에서 source_snapshot_id/latest_snapshot_id를 명시적으로 비우도록 고쳤고, 검사기의 독립 snapshot 해제·삭제 회귀도 통과한다. |
| N04 61표 인계 | **해소** | `issues/stage-2.md:13,20,25`, `issues/stage-5.md:47`, `stage-4.md:222`, `stage-5.md:265,365`, `ddl-gaps.md:3`이 현재 DDL 61표 기준으로 맞춰졌다. |
| N05 Python 검사기 종료·후속 의무 | **일부** | `decisions/0016-core-language.md:27`의 PR26 TS 검사 계약·명령·합성 사례 동등성 인계는 명확하지만, `issues/stage-3.md:334`와 `issues/stage-5.md:10`의 후속 Python 갱신 의무가 남아 F02와 같은 정리가 필요하다. |
| N06 WEB0 산출물 경로 | **해소** | `spikes/web0-plan.md:35,39`와 `issues/stage-5.md:19,29~30`이 spikes/web0/ts-core/·spikes/web0/package.json·npm --prefix spikes/web0로 일치한다. |
| 플랫폼 표현 잔여 | **해소** | `stage-5.md:71`, `roadmap.md:149`, `summary-for-approval.md:58`은 VPS 총액을 WEB0 견적으로, `stage-5.md:55,215`, `decisions/0005-web-platform.md:21`, `summary-for-approval.md:75`는 실제 배포 주체의 personal 조건을 WEB0 확인으로 남겼다. |

## 남은 부분·새 모순

**남은 원인은 1건(중간, F02/N05 공통)**이다. PR26의 TS 검사기 담당·명령·동등성 인계가 불명확해서가 아니라, 후속 원고에 예전 Python 검사기 수정 의무가 남아 있어서다. `issues/stage-3.md:334`의 R1 검사기 갱신과 `issues/stage-5.md:10`의 새 표·열 검사기 갱신을 **PR26 산출 TS 검사기**로 맞추면 된다. `roadmap.md:180`의 새 표 추가 시 `check_ddl.py` 갱신 규칙도 PR26 전후를 구분해야 한다. `issues/stage-5.md:47`의 기존 검사 **항목**을 웹 검사로 옮긴다는 계약은 유지할 수 있다.

이번 수정이 만든 별도 새 모순은 확인하지 못했다. 위 잔여는 기존 F02/N05의 미완료 부분이다. owner 검사·원본/추출본의 엄격한 쪽 검사 등 명확히 서비스에 넘긴 책임은 다시 미해결로 세지 않았다. 제외한 세 문서의 내용으로 해소 여부를 추정하지 않았다.

## 실행 결과

| 검사 | 결과 |
|---|---|
| `python3 docs/plan/schemas/check_ddl.py` | **PASS**. 임시 HOME·USERPROFILE·PES_HOME, SQLite 3.54.1·메모리 DB, **61표 적재·거부 64건·대표 조회 3개**, CAS/뒤늦은 실패 롤백·FK·integrity 통과. **D1 미시험**. |
| `python3 docs/plan/fixtures/check_fixtures.py` | **38/38 PASS**. 기존 API 예제 검사이며 미구현 서비스의 실제 권한 집행을 검증한 결과는 아니다. |
| 이슈 원고 재집계 | **25/11/9/16/9**, 단계 안 번호 중복 0. 신규 70+기존 31=**101**, 260 대비 **159** 여유. 제외 문서는 세지 않았다. |

최종 판정: 수정 후 승인 · 완료: docs/plan/discussion/2026-11-05-codex-review-3.md
