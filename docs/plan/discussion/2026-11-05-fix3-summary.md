# 2026-11-05 검수 반영 3차 — 묶음 summary

- 입력: [2026-11-05-codex-review-2.md](2026-11-05-codex-review-2.md)
- 수정 파일: `roadmap.md`, `summary-for-approval.md`, `glossary.md`, `discussion/2026-11-05-mode-a-web-direct-and-references.md`
- 실제 `~/pes-projects`·`~/.pes/`는 읽거나 쓰지 않았다. 실제 자료·키·사용자 절대경로·세션 ID를 넣지 않았다. 커밋·push·Linear 등록은 하지 않았다.

## 처리한 항목

| 항목 | 반영 |
|---|---|
| N04 — 61표·PR 번호 | `roadmap.md:180`은 이미 **61표** 기준으로 반영돼 있어 그대로 두었다. `glossary.md:135`의 **PR 1~22 = 22개**를 **PR1~19·20a·20b·20c·21·22·26 = 25개**로 고치고, 2026-11-04 당시 22개였다는 시점을 붙였다. `glossary.md:120`의 WEB0도 Python Workers 후보 표현을 **2단계 PR1 전 TS 단일 언어·플랫폼 후보 시험**으로 맞췄다. |
| R04 — 거부 59 | `discussion/2026-11-05-mode-a-web-direct-and-references.md:163`을 **거부 64(2026-11-05 재검수 기준)**로 고치고, 59는 이전 61표 검사 시점이라고 표시했다. |
| 플랫폼 표현 잔여 | `roadmap.md:122,149`의 **Hetzner 월 몇천 원**을 **월 총액은 WEB0 견적**으로 고쳤다. `summary-for-approval.md:58`도 같게 고쳤다. `roadmap.md:119`, `summary-for-approval.md:57,75`의 Vercel Hobby 비상업 표현에 **실제 배포 주체의 personal 조건도 WEB0에서 확인**을 덧붙였다. |

## 건너뛴 항목(이미 반영)

- **roadmap.md:180 61표**: 2차에서 이미 반영돼 있었다.
- **N04의 25/11/9/16/9·101·159**: 1·2차에서 이미 반영돼 있었다.
- **N01·N02·N03·N05·N06·N07**: 이 묶음의 네 파일에는 해당 없음. 아래 다른 파일 필요에 적었다.

## 여전히 남은 것(다른 파일)

- `stage-2.md:186`, `issues/stage-2.md:13,20,25`, `issues/stage-5.md:47`의 **60표**를 현재 **61표** 또는 정확한 DDL/표 목록 참조로 고쳐야 한다(N04).
- `stage-1-ui.md:52`, `stage-3.md:59,266,273`, `issues/stage-3.md:5,272,277`의 **`file_policies.file_policy_id`**를 **`file_policies.id`**로, 참조 열은 `file_policy_id`/`source_file_policy_id`/`text_file_policy_id`로 구분해야 한다. 원본 blob과 추출 텍스트 blob은 각자 정책을 갖고 서비스가 원본 deny를 함께 검사해 엄격한 쪽을 적용한다(N01·N02).
- `issues/stage-3.md:250`의 “FK를 NULL로 만들지 않고”를 **검증 명령의 같은 tx에서 snapshot 포인터를 명시적으로 비우고 source_missing·key/label 보존**으로 고쳐야 한다(N03).
- `stage-4.md:212`, `issues/stage-4.md:9,25`, `issues/stage-6.md:8~10,48,59,138,215,323`의 pytest/Python 검사기 의무를 PR26의 TS 검사기 인계와 구분해야 한다(N05).
- `spikes/web0-plan.md`와 `issues/stage-5.md`의 WEB0 산출물 경로(`spikes/web0/...` vs `web/spike/...`)를 하나로 맞춰야 한다(N06).
- `decisions/0013`·`stage-1-runners.md`의 A allowlist에 **결정 제안** 경로를 명시해야 한다(N07).
- `stage-6.md:213`이 export 근거로 드는 `stage-1-api.md:99`는 지금 WEB15 `progress.report` 행을 가리킨다. 표 이름 기준으로 인용을 고쳐야 한다(R04).

완료: docs/plan/discussion/2026-11-05-fix3-summary.md
