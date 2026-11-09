# 1. leader — 대시보드 7차 작업 설계서

- 모델: Claude Code · Opus 5.5. 직접 대량 구현하지 않는다. 나누고 · 배정하고 · 검증하고 · PR 전에 직접 확인한다.
- 근거: [dashboard-v2.md](../dashboard-v2.md) 18절(18.9 고칠 일 포함) · 12절 · 16절, [stage-3.md](../../stage-3.md) U1~U6, 공통 규칙 [README](README.md). Codex 검수 반영(2026-11-10, 필수 2 · 4 · 5 · 12, 권장 1 · 2 · 5 · 6).

## 1. 일의 범위

**A는 실제 앱의 완료 조건**(새 이슈 아님 — U 이슈 설명에 붙임), **B는 시안 정리 이슈**(제안 — 사용자 확인 전 만들지 않음).

### A. 실제 앱(3단계) U 이슈에 붙일 완료 조건

| U 이슈 | 붙일 7차 조건(18절) |
|---|---|
| U1 작업 공간 틀 · 공통 화면 | 글자 5단계 토큰 + `cn` 등록(18.1) · 화면 검사 4종을 `npm run` 명령과 CI에(18.7) · AI 동료 접기(1280+ 조건) · 폭 320/368/400 · 결과 글 부탁 시 펼침(18.2) · “PES 대시보드” · 단계 모양 뜻 줄과 “현재 … · 상태”(18.5) · “승인을 막는 것 n건” 한 정의(18.3-4) · **승인 공통 확인 대화 상자의 끝 상태와 다음 단계 열림 상태 전이**(18.3-3) · **사용량 기본 화면의 사실 문구 한 줄**(18.6 — R1 실시 여부와 무관) |
| U2 질문 작업면 | 질문 카드 ⋯ 메뉴 · 기본값은 선택지 줄로 · 보내기 한 길(18.3-1) · 보낸 뒤 같은 자리 확인 + 제목 초점(18.3-2) |
| U3 가정·결정·반영 | AI 동료 한 줄 요약의 “판단 전 제안 n” |

### B. 시안 정리 이슈(제안)

`M=docs/plan/mockups/dashboard-v2-react`. 완료 조건은 모두 관문 명령으로 확인(4-gate.md 2절).

| 제안 | 할 일 | 완료 조건 | 담당 |
|---|---|---|---|
| UI7-0a 시험 도구 | Vitest + Testing Library(jsdom) 버전 고정, `npm test`(`--passWithNoTests`), `scripts/lint-budget.mjs`(규칙별 경고 수 검사) | 관문 PASS(시험 0개로 `npm test` 통과) · `node scripts/lint-budget.mjs 'react(*)<=17'` 종료 0, `'react(*)=0'` 종료 1 | worker(flash) — 도구라 시험 없이 배정하는 예외 |
| UI7-0b 바탕 시험 | `cn` 토큰 · `approvalBlockers` 회귀 시험(2-tester.md) | `npm test` 통과 | tester만 |
| F1~F3 시안 고칠 일 | 18.9의 F1 부탁 시 펼침 · F2 승인을 막는 것 한 이름 · F3 사용량 사실 문구 | tester 실패 시험 → 통과 · 관문 PASS | tester → flash |
| UI7-1 카드 변형 | `card.tsx`에 기존 `size`(default · sm) 계약을 지키며 `compact` 추가, 화면의 `px-5 gap-0` 덮어쓰기를 그것으로 — **화면 파일 묶음별 PR** | `lint-budget 'shadcn(no-restyle)<=<묶음마다 정한 목표>'` · 오류 0 · 두 폭 넘침 0 | tester → flash |
| UI7-2 React 경고 | effect 안 상태 바꾸기 · 렌더 중 ref · purity | `lint-budget 'react(*)=0'` · 동작 보존 시험 통과 | tester → flash |
| UI7-3 개요 칸 | 연구 개요 “지금 어디까지”의 현재 단계 상태 글자 접힘 없애기 | **1440 · 시안 합성 문구에서 상태 글자 2줄 이하**(leader 브라우저 확인 — 자동화는 U1에서) | flash |
| UI7-4a 단축키 | 선택지 1~4 · ⌘/Ctrl+Enter = 검토 대화 상자 열기 · 끄기 · 한글 조합 · 입력 중 무시 | **설계서에 먼저 적고 사용자 확인** 뒤 정함 | — |
| UI7-4b 가정 일괄 | 판단 전 제안 모두 받아들이기 · 권한 · 한 번 확인 · 부분 실패 처리 | 같음 | — |

## 2. 순서 (DAG)

```text
UI7-0a 도구 ─> UI7-0b 바탕 시험 ─┬─> F1 · F2 · F3 (서로 다른 파일이면 병렬)
                                 ├─> UI7-2 React 경고
                                 └─> UI7-1 카드 변형(묶음별) ─> UI7-3 개요 칸
UI7-4a · 4b ── 설계 확인 뒤에만
```

- UI7-1과 UI7-2는 같은 화면 파일을 건드리므로 **동시에 돌리지 않는다**. UI7-3은 UI7-1의 허용 범위와 겹치므로 그 뒤.
- F2(승인 수)와 UI7-2의 `RoundPage.tsx`도 겹친다 — F2 먼저.

## 3. 이슈 하나의 진행 (hc-team 규칙 그대로)

1. worktree · 브랜치 `ai/<ISSUE>` · PR 하나. 흔적은 `~/hc-work/pes/`. ledger에 상태가 바뀔 때마다 적는다.
2. **tester 작성 모드** → 실패하는 시험 커밋, 해시 기록(`--tester`). leader가 `git show`로 요구와 맞는지 본다.
3. **worker**(flash) — 4절 지시문.
4. **관문**(4-gate.md) — FAIL이면 같은 worker 재시도. 단계마다 **첫 시도 + 재시도 최대 2회**, 그래도 FAIL이면 mid(Sonnet) → senior(Opus, 동시 1개).
5. **관문 PASS → tester 보강 모드**: `BUG`면 그 해시를 tester 목록에 더하고 worker가 고침 → 3번부터(재시도 횟수에 넣음). `HARDENED`면 해시 기록 후 다음.
6. **1차 리뷰**(5-first-reviewer.md) — 승인까지 같은 `r1-`.
7. **최종 리뷰**(6-reviewer.md) — 이슈당 최대 2번. Codex 남은 양 3% 이하면 senior 템플릿으로.
8. **두 폭 확인 · PR** — 아래 5절.

Sonnet 에이전트(tester · mid · first-reviewer)는 모든 이슈 합쳐 **동시 2개**까지.

## 4. worker에게 줄 지시문 틀

```text
이슈: <ID> <제목>
설계: docs/plan/ui/dashboard-v2.md 18.x, docs/plan/ui/dashboard-v2-roles/3-worker.md
고칠 파일: <저장소 루트 기준 목록> (이 밖은 고치지 않음, 시험 파일은 고치지 않음)
시험: <tester 커밋의 시험 파일> — 고치지 말고 통과시킬 것
완료 확인(시안 폴더에서): npm run typecheck && npm run lint && npm test && node scripts/lint-budget.mjs '<규칙 목표>'
린트 경고 총수 기준: <수> (늘리지 않음)
하지 말 것: 임의 글자 크기, cn을 패키지에서 바로 import, 화면 말 사전 밖 문구, 실제 PES 자료
```

## 5. PR 전에 leader가 직접 볼 것

- diff가 지시한 파일 안인가, worker가 시험 파일을 고치지 않았는가, tester 커밋의 기대값이 근거 없이 약해지지 않았는가.
- 화면 검사 4종 결과(typecheck · lint 오류 0 · 규칙별 목표 · detect `[]`) + **두 폭 브라우저 확인**(넘침 · 12px · 단추 대비 · UI7-3 줄 수)을 PR 본문에. 린트 경고 수 전/후.
- 화면 말 — 옛 말(“AI가 하는 중”, “봉인”, “콘솔 기준값”, “다시 확인 필요”, “PES 연구 작업대”) 0.
- 공개 저장소 — 실제 경로 · 키 · `~/pes-projects` 내용 없음.
- 병합은 Claude(메인 세션)가 검토 뒤 squash(사용자 위임). leader는 병합하지 않는다.
