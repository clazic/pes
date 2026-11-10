---
name: plan
description: PES 기획 단계 — 주제·목적·독자·형식·범위를 HTML 시작 질문으로 받고, 연구 질문·목차·조사 항목(기존 조사 재사용 연결 포함)·일정을 라운드로 다듬어 승인받는다. 승인하면 조사 항목이 조사 단계로 넘어간다. pes:core 를 먼저 로드한다.
---

# 기획 (plan)

pes:core의 단계 생명주기를 따른다. 이 문서는 기획에서 **무엇을 만들고 무엇을 점검하는지**만 다룬다.

## 시작 질문

`ask-prep <dir> plan` → `ask/plan-start.json` 다듬기:
- 요청에 주제가 있으면 `topic` 질문 삭제, `inherited`에 주제.
- `project.library`가 없으면 `library` 질문 삭제. 있으면 inherited에 "기존 조사: 항목 N개(R{round}까지)".
- 형식이 연구보고서가 아닐 법하면 `research_type`·`team` 삭제.
- 답(주제·목적·독자·형식·범위·보고서 형식)은 `pending`이 알려 준 답 파일(`feedback/*.json`)의 answers를 읽어 `set <dir> plan settings <파일>`로 저장한다(프로젝트 설정에도 함께 들어가 보고서 형식과 검토원이 읽는 사용자 기준이 된다).

## R1에 만드는 것 (항목 kind)

| kind | 내용 | 필드 |
|---|---|---|
| `rq` 연구 질문 | 3~5개. 보고서가 답해야 할 질문 | summary=왜 필요한가 |
| `chapter` 목차 | 장·절. 분량 설정에 맞춰 | details=절 구성과 각 절에서 쓸 내용, `order`, links.plan=[관련 rq] |
| `topic` 조사 항목 | 조사 단계로 넘어갈 단위. 장마다 1~3개 | `question`=조사 질문 한 줄, links.plan=[chapter, rq], `reuse`=참고자료 항목 id(겹치면) |
| `schedule` 일정 | 마감이 있으면 단계별 날짜 | details=표 |

- 각 topic은 최소 한 chapter와 연결한다. chapter마다 근거가 될 topic이 있어야 한다.
- **참고자료(library)가 있으면** 항목을 하나씩 대조해 겹치는 topic에 `"reuse": <library id>`를 단다. 그 topic의 summary 첫 줄에 "기존 조사 #N 재사용 — 보완할 점: …"을 적는다. 기획에 맞지 않는 library 항목은 쓰지 않는다(이유를 changes에 한 줄 — `show <dir> plan --fields changes`로 읽은 전체 배열에 더해 `set`).
- 참고자료를 읽는 길: 개수·출처는 `status`, 항목 번호·제목·요약은 `render <dir> plan` 뒤 대시보드 기획 탭의 「참고자료」 칸(`open`). DB 경로(`PES_DB_CORE=1`)에서는 칸이 개수만 보이므로 `--import`에 준 원래 폴더의 `state.json`을 읽는다. 항목 본문이 더 필요하면 `--import`에 준 원래 조사 폴더의 `state.json`을 읽는다 — PES 상태가 아니라 가져온 참고 자료라 읽기만 하고 고치지 않는다. `show`·`digest`는 여섯 단계만 받으므로 library를 대상으로 쓰지 않는다.
- 기획 단계에서는 새 조사를 하지 않는다. 필요하면 주제 파악용 빠른 검색만(출처는 sources에).
- 항목은 제안 파일(JSON 배열: 항목마다 `kind`·`title`·`summary`·`question`·`links`·`reuse` 등)로 쓰고 `merge <dir> plan <파일>`로 넘긴다. `updated_round`·`depth`는 PES가 맞춘다. `merge`는 `reuse`를 그대로 남기고, 기획 승인 때 `reuse`가 달린 topic은 참고자료 내용을 이어받은 조사 항목(deepen)이 된다.

## AI 점검 초점

- `blank`: 연구 질문에 답할 장이 없음 / 장에 근거 topic이 없음 / 목적(정책 제안)에 비해 대안·제언 장이 없음 / 울산 관점 누락(기준 지역이 울산일 때)
- `scope`: 범위(공간·시간) 밖 topic, 분량 대비 과한 장
- `decide`: 목차 구성 방식(지역별 vs 쟁점별), 재사용할지 새로 할지 애매한 library 항목
- `weak`: 연구 질문이 너무 넓거나 답할 수 없는 형태
- 마지막 질문: 충분해 보이면 "기획을 승인하고 조사로 넘어갈까요?" (approve / 한 라운드 더)

## 승인 전 마무리

0. 마지막 라운드의 **독립 검토(QC/QA)**가 `qa`로 기록돼 있고, high 지적이 처리됐는지(고쳤거나 이유를 남겼는지) 확인한다 (pes:core 「독립 검토」).

1. topic마다 question·links가 있는지 확인(`show <dir> plan --fields question,links`). 기획 결정은 받은 답에서 읽은 대로 정리한다.
2. 기획 요약 3~5줄 (연구 질문·장 수·조사 항목 수·재사용 수)을 `set <dir> plan summary <파일>`로 쓴다.
3. `approve <dir> plan` → 조사 항목이 생성된다(재사용 항목은 status=deepen과 보완 요청이 붙는다).
4. 바로 pes:research의 시작 질문으로 이어간다.

## 단계 보고서

승인 직후 `pes:core` 「단계 보고서」대로 `report <dir> plan` + eli5 + 선택한 형식.
