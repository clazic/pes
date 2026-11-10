---
name: analyze
description: PES 분석·종합 단계 — 조사 결과를 비교 축(지역·연도·유형·주체)과 관점으로 묶어 쟁점·비교표·시사점 항목을 만들고 근거(조사 항목·출처)를 연결한다. 남은 충돌을 기준 선택 질문으로 정리하고 승인받는다. pes:core 를 먼저 로드한다.
---

# 분석·종합 (analyze)

## 시작 질문

`ask-prep <dir> analyze` → 다듬기:
- 조사 단계에 conflicts가 없으면 `conflicts` 질문 삭제, 통계가 없으면 `derived` 삭제.
- 기획의 목적·범위(울산 기준 등)에 맞춰 추천을 바꾼다.

## 라운드에서 만드는 것

항목은 제안 파일(JSON)로 쓰고 `merge <dir> analyze <파일…>`로 넘긴다 (토큰을 가진 작업자는 `claim` → `submit`). 상태 파일을 직접 고치지 않는다.

| kind | 내용 | 필수 |
|---|---|---|
| `issue` 쟁점 | 연구 질문에 답하는 핵심 판단 하나. summary=판단 2~3줄, details=근거 정리 | links.research=[근거 항목], links.plan=[관련 rq·chapter] |
| `table` 비교표 | 비교 축별 표 (마크다운 표). 값마다 출처를 조사 항목에서 가져온다 | links.research, 가공 지표는 표 아래 "가공:" 줄 |
| `insight` 시사점 | 쟁점에서 나오는 시사점·정책 방향 (결론 성격이 제언이면 대안·실현 가능성 포함) | links.analyze=[근거 issue] |

- **새 사실을 만들지 않는다.** 조사 항목에 없는 수치가 필요하면 그 조사 항목에 revise를 걸고 reopen 여부를 점검 질문으로 묻는다.
- 통계 가공(증감률·비율·순위)은 kosis(`--change`, `--ratio`, `--sort`)로 다시 뽑거나, 조사 항목 수치에서 계산했다면 표 아래에 계산 방법을 적는다.
- 차트가 필요하면 차트 작성 지침(dataviz 스킬이 있는 환경이면 그것)을 읽고 `shots/<id>-chart.png`(또는 svg)로 저장해 항목 shots에 담아 `merge`한다.
- 연구 질문(rq)마다 최소 하나의 issue가 있어야 한다.
- 항목이 많으면 비교 축별로 pes:researcher 대신 별도 지침이 없는 일반 서브에이전트에 "이 조사 항목들만 보고 표를 만들라"고 맡겨도 된다(근거 항목 본문을 함께 넘긴다).

## AI 점검 초점

- `conflict`: 조사에서 넘어온 충돌 → 어느 값을 쓸지 (출처별 근거를 detail에)
- `blank`: 답이 없는 연구 질문, 비교 축에 빈 칸(지역·연도 누락)
- `weak`: 근거가 원문 미확인 출처 하나뿐인 쟁점
- `decide`: 해석이 갈리는 쟁점 (A/B 서술 방향), 제언의 수준
- `scope`: 연구 질문과 무관한 표·쟁점

## 승인 전 마무리

0. 마지막 라운드의 **독립 검토(QC/QA)**가 `qa`로 기록돼 있고, high 지적이 처리됐는지(고쳤거나 이유를 남겼는지) 확인한다 (pes:core 「독립 검토」).

1. 모든 issue·table에 links.research가 있는지, 모든 rq에 issue가 있는지 확인.
2. 핵심 쟁점 3~5줄을 `note`로 남긴다.
3. `approve <dir> analyze` → pes:write.

## 단계 보고서

승인 직후 `pes:core` 「단계 보고서」대로 `report <dir> analyze` + eli5 + 선택한 형식.
