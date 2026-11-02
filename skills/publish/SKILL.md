---
name: publish
description: PES 산출·공유 단계 — 검증을 마친 out/report.md 를 HWPX(울산연구원 양식, hwpx-uri 스킬)·Word·PDF·웹 페이지·발표자료로 내보내고 부록(출처 목록·통계 원표·라운드 이력)을 붙인다. 산출물마다 output 항목으로 기록하고 최종 승인으로 프로젝트를 마친다. pes:core 를 먼저 로드한다.
---

# 산출·공유 (publish)

## 시작 질문

`ask-prep <dir> publish` → 기획의 format을 formats 추천으로.

## 라운드

1. `assemble <dir>`로 `out/report.md` 최신화.
2. 형식별 변환 (스킬을 로드해 그 절차대로):
   - **hwpx**: `anthropic-skills:hwpx-uri` 스킬 — report.md를 그 작성가이드 규칙(장·절 표기, 개조식, 표·그림 캡션, 각주)에 맞는지 점검해 필요한 만큼 고친 사본 `out/report-uri.md`를 만든 뒤 변환 → `out/report.hwpx`.
   - **docx**: `anthropic-skills:docx` 스킬 → `out/report.docx`.
   - **pdf**: `anthropic-skills:pdf` 스킬 (docx나 html에서) → `out/report.pdf`.
   - **web**: HTML을 직접 쓰지 않는다. 표지 정보를 `out/cover.json`에 쓰고(`{"subtitle", "authors": [..], "org", "client", "asof", "kind"}` — 기획 답에 있는 것만, 모르면 빼거나 점검 질문으로) `web <dir>` → `out/report.html` (표지·목차·요약 상자·각주·출처 부록[확인됨/미확인]·인쇄용 A4). 표 캡션은 `<표 n> 제목`, 자료 줄은 `자료: …`, 그림은 `![설명](경로)`. 공유하려면 artifacts로 게시(사용자에게 링크).
   - **pdf**를 웹 보고서에서 만들 때는 브라우저 인쇄(표지 한 쪽·장마다 새 쪽)를 쓰면 된다.
   - **slides**: `anthropic-skills:pptx` 스킬 → `out/slides.pptx`.
3. 부록: sources → `out/appendix-sources.md`(조사 전 단계 출처를 확인됨/미확인으로 구분), stats → 통계 원표 목록(KOSIS 링크), log → 단계·라운드 이력(project.json history·changes).
4. 산출물마다 kind=`output` 항목: title=형식, `path`=out/ 상대 경로, summary=쪽수·크기·특이사항. 변환에서 손으로 고친 것은 details에.
5. 외부 공유(settings.strip=strip)면 내부 메모·AI 점검 기록·confidence를 뺀 판을 따로 만든다.

## AI 점검 초점

- `weak`: 변환 중 깨진 표·그림·각주, 양식 위반 (hwpx-uri 점검 결과)
- `decide`: 표지·발간 정보(연구진·발주처) 확인, 부록 범위
- 마지막: "최종 승인하고 프로젝트를 마칠까요?"

## 승인

먼저 마지막 라운드의 독립 검토(QC/QA, `qa-brief`→`pes:reviewer`→`qa`)로 산출물이 승인된 원고와 같은지·근거 표기가 빠짐없는지 확인한다.

`approve <dir> publish` → project.complete=true. 서버는 그대로 둔다(열람용, 다른 프로젝트와 함께 쓰는 서버라 끄지 않는다). 사용자가 원하면 `stop` — 목록과 모든 프로젝트 화면이 함께 꺼진다.

## 단계 보고서

승인 직후 `pes:core` 「단계 보고서」대로 `report <dir> publish` + eli5 + 선택한 형식.
