---
name: write
description: PES 집필 단계 — 기획 목차대로 장·절 원고(section 항목)를 쓰고, 문장마다 분석 쟁점·조사 출처를 연결해 각주로 단다. 장별 라운드로 사용자 수정을 반영하고 out/report.md 로 조립한다. 울산연구원 양식이면 개조식 규칙을 따른다. pes:core 를 먼저 로드한다.
---

# 집필 (write)

## 시작 질문

`ask-prep <dir> write` → 다듬기: 기획의 format이 hwpx면 template=uri 추천, 분석 단계에 차트가 없으면 `chart_style` 삭제.

## 원고 항목 (kind=`section`)

- 기획의 chapter마다 section 1개(장이 길면 절마다). `order`=목차 순서, links.plan=[chapter], links.analyze=[근거 issue·table·insight].
- `details` = 원고 마크다운. 제목은 `## 1. 장 제목`, `### 1.1 절 제목`.
- **각주**: 문장 끝에 `[^k]`, k는 이 항목 `sources`의 1부터 번호. sources는 근거 조사 항목의 출처에서 **실제로 쓴 것만** 복사한다(url·title·date·method 유지). `assemble`이 전체 번호를 다시 매긴다.
- 원고에 들어가는 수치·조문은 반드시 근거 항목에 있는 값이어야 한다. 없으면 쓰지 말고 점검 질문으로.
- 문체:
  - 울산연구원 양식(uri)·개조식: `□` 핵심 문장, `○` 세부, `-` 보충. 문장은 "~함", "~임" 체. 장 첫머리에 요약 박스 대신 `□` 2~3개.
  - 서술식: 한 문단 3~5문장, 문단마다 하나의 주장.
- 표는 분석 단계 table을 다듬어 넣고 `<표 n> 제목`을 위에, `자료: …`를 아래에. 그림은 `<그림 n> 제목` + 이미지 경로.
- 사람이 쓰는 장(settings.human)은 원고를 쓰지 않고 해당 section에 status=done, summary="사람 집필 — 검토만"으로 둔다.

## 라운드

- order=chapter: 라운드마다 장 1~2개씩. draft: R1에 전체 초안, 이후 장별 수정.
- 장이 3개 이상이면 장마다 `pes:writer` 서브에이전트를 한 메시지에 함께 보낸다. 넘길 것: 전체 목차, 이 장의 chapter 항목, 근거 issue·table·insight 본문, 근거 조사 항목의 summary와 sources, 문체 규칙, 다른 장 제목(겹치지 않게).
- 결과 병합: `merge <dir> write <파일들>` (section의 details·sources·links).
- 렌더 전 `assemble <dir>`로 `out/report.md`를 갱신한다.
- 요약(settings.summary=one)은 마지막 라운드에서 `p.executive_summary`에, 결론은 `p.conclusion`에.

## AI 점검 초점

- `weak`: 각주 없는 수치 문장, 근거 issue 없이 쓴 주장
- `blank`: 기획 chapter 중 원고가 없는 것, 연구 질문에 답하지 않은 장
- `decide`: 같은 내용을 두 장에서 반복 — 어디에 둘지, 표현 수위(단정 vs 완화)
- `scope`: 분량 초과 장
- 장마다 "이 장을 확정할까요?"를 묶어서 물어도 된다 (multi: 확정할 장 선택).

## 승인 전 마무리

1. 모든 chapter에 section, 모든 section에 links.analyze와 sources가 있는지.
2. `assemble` → `stages.write.summary`에 장 수·분량·각주 수.
3. `approve <dir> write` → pes:verify.

## 단계 보고서

승인 직후 `pes:core` 「단계 보고서」대로 `report <dir> write` + eli5 + 선택한 형식.

## 토큰

서브에이전트 결과는 `<dir>/rounds/write-R<n>/<id>.json`에 쓰게 하고(지시문에 [결과 파일]), 메인은 `merge` 후 `digest <dir> write --round <n>`으로 점검한다.
