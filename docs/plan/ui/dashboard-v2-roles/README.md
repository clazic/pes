# 대시보드 v2 — hc-team 역할별 설계서 (7차, 2026-11-10)

- 상태: **초안 — 사용자 확인 전.** 확인 전에는 이 문서로 이슈를 만들거나 `ai-ready`를 붙이지 않는다(계획 먼저 · 실행은 확인 뒤).
- 근거 설계: [dashboard-v2.md](../dashboard-v2.md) **18절**(7차 결정)과 12절(기술) · 16절(두 공간). 시안: [mockups/dashboard-v2-react](../../mockups/dashboard-v2-react/README.md).
- 작성: Claude(Opus 5.5 — 대시보드 디자인 설계 역할). **Codex(GPT-6.1 Sol high) 검수 2026-11-10: 수정 후 승인(필수 12 · 권장 6) → 모두 받아들여 반영** — [합의 기록](../../discussion/2026-11-10-dashboard-v2-7th-codex-review.md). 다음: 사용자 확인.

## 무엇을 만드는가

7차 결정(글자 5단계 · AI 동료 접기 · 질문 카드 정리와 보내기 한 길 · 보낸 뒤/승인 뒤 확인 · 쉬운 말 · 단계 모양 뜻 · 사용량 돈 한 줄 · 화면 검사)을 **실제 대시보드 앱(3단계 U1~U6)** 의 완료 조건에 넣고, 시안에 남은 정리 일(카드 크기 변형 · React 경고 · 개요 단계 칸)을 끝낸다.

## 역할과 문서

| 역할 | 모델 | 문서 | 한 줄 |
|---|---|---|---|
| leader | Claude Code · Opus 5.5 | [1-leader.md](1-leader.md) | 이슈 나누기 · 순서 · 배정 · PR 전 확인 |
| tester | Claude Code · Sonnet 5.5 | [2-tester.md](2-tester.md) | 구현 전 정답(테스트) 쓰기 · 구현 뒤 보강 |
| worker (flash → mid → senior) | OpenCode DeepSeek V4.1 Flash → Sonnet 5.5 → Opus 5.5 | [3-worker.md](3-worker.md) | 테스트를 통과하게 구현 |
| 관문(스크립트) | `~/hc-agents/bin/hc-gate.sh` · AI 없음 | [4-gate.md](4-gate.md) | 범위(저장소 루트 기준) · 테스트 변조 · 검사 명령 판정 |
| first-reviewer | Claude Code · Sonnet 5.5 | [5-first-reviewer.md](5-first-reviewer.md) | 승인까지 반복하는 1차 리뷰 |
| reviewer(최종) | Codex · GPT-6.1 Sol high | [6-reviewer.md](6-reviewer.md) | 이슈당 1~2번 최종 리뷰 |

## 모두가 지키는 것

1. **설계서가 먼저다.** 화면을 바꾸는 결정은 dashboard-v2.md에 먼저 적고 확인받는다. 문서에 없는 화면 결정을 코드에서 새로 하지 않는다(필요하면 leader에게 묻는다).
2. **화면 검사 4가지가 단계마다 통과**해야 한다(18.7): `npm run typecheck` 오류 0 · `npm run lint` 오류 0(경고는 늘리지 않음) · `impeccable detect --json src` 지적 0 · 1440 · 390 두 폭 확인.
3. **화면 말은 사전(1.3 · 18.4)대로**: AI 작업 중 · 확인 필요 · 시작 전 · 고정된 결과 · API 회사 화면에서 본 숫자 · PES 대시보드. ‘Go’를 쓰지 않는다. 설계 용어(“확인 대화 상자”, “5단계 웹”)를 화면에 쓰지 않는다.
4. **글자 크기는 토큰만**: `text-caption`(12) · `text-meta`(13) · `text-body`(15) · `text-title`(16) · `text-page`(20). `text-[13px]` 같은 임의 크기를 쓰지 않는다. `cn`은 `@/lib/utils`에서만 가져온다(토큰 등록이 그 안에 있음).
5. **shadcn 부품을 먼저 쓴다**(DropdownMenu · Dialog · Button 등). 부품 모양을 `className`으로 덮어쓰지 말고 변형(variant)을 더한다 — 새 덮어쓰기는 린트 경고가 늘어 관문에서 막힌다.
6. **합성 자료만.** 실제 `~/pes-projects` · `~/.pes` 내용, 로컬 경로, 키를 코드·테스트·PR에 넣지 않는다(공개 저장소).
7. **접근성**: 초점이 보이게(2px), 굵은 포인터 44px, 상태는 모양 + 글자 + 색, 화면이 바뀌면 초점은 새 제목으로(`data-route-target` 우선), 알림은 한 번만 읽히게.
