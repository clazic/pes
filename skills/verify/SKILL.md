---
name: verify
description: PES 검증 단계 — 원고에서 수치·법령 조문·핵심 주장을 claim 항목으로 뽑아 pes:verifier 서브에이전트가 출처 원문과 대조해 supported/partial/unsupported 로 판정하고, 근거 없는 문장은 점검 질문으로 처리(재조사·완화·삭제)한다. pes:core 를 먼저 로드한다.
---

# 검증 (verify)

## 시작 질문

`ask-prep <dir> verify` → 원고에 법령 인용이 없으면 `law_cite` 삭제.

## 주장 항목 (kind=`claim`)

1. 검증 범위(settings.range)에 맞춰 write section의 원고에서 주장을 뽑는다:
   - numbers: 숫자가 들어간 문장, 법령 조문 인용 전부
   - key: 각 장의 □ 문장·결론 문장
   - all: 모든 문장 (분량이 크면 장별 라운드)
2. claim 항목: title=주장 문장(원문 그대로), links.write=[section], sources=그 문장의 각주 출처, `question`=확인할 점(값·기준일·조문 번호).
3. 장별로 묶어 `pes:verifier` 서브에이전트에 넘긴다 (한 메시지에 여러 개). **결론이나 기대하는 답을 주지 않는다** — 주장 + 출처 URL + 기준일만.
4. 법령 인용은 korean-law `legal_analysis --mode verify_citations`로도 확인한다 (asof=today면 현행 기준).
5. 결과 병합: `merge <dir> verify <파일들>` → claim의 `verdict`(supported|partial|unsupported), `verify`(근거·원문 발췌), confidence.

## 처리

- supported: done.
- partial: 점검 질문 — 표현을 출처에 맞게 고칠지 (고칠 문장 제안을 선택지에).
- unsupported: settings.unsupported에 따라 점검 질문(재조사 / 완화 / 삭제). 재조사를 고르면 `reopen <dir> research`로 해당 조사 항목에 revise를 걸지 묻고, 완화·삭제면 write section을 직접 고친다(그 section에 request 기록, `assemble` 다시).
- 원고를 고치면 write 단계 snapshot이 남도록 `render <dir> write`도 한 번 실행.

## AI 점검 초점

- `weak`/`conflict`: unsupported·partial 주장 (문장과 출처를 detail에)
- `stale`: 기준일이 지난 통계·개정된 조문
- 마지막: 남은 문제가 없으면 "검증을 승인할까요?"

## 승인 전 마무리

0. 마지막 라운드의 **독립 검토(QC/QA)**가 `qa`로 기록돼 있고, high 지적이 처리됐는지(고쳤거나 이유를 남겼는지) 확인한다 (pes:core 「독립 검토」).

1. unsupported 0개 또는 사용자가 남기기로 정한 것만 남았는지.
2. `assemble` 다시 → `stages.verify.summary`: 판정 수(supported/partial/unsupported), 고친 문장 수.
3. `approve <dir> verify` → pes:publish.

## 단계 보고서

승인 직후 `pes:core` 「단계 보고서」대로 `report <dir> verify` + eli5 + 선택한 형식.

## 토큰

서브에이전트 결과는 `<dir>/rounds/verify-R<n>/<id>.json`에 쓰게 하고(지시문에 [결과 파일]), 메인은 `merge` 후 `digest <dir> verify --round <n>`으로 점검한다.
