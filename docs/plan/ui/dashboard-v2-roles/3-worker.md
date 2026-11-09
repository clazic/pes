# 3. worker — 대시보드 7차 구현 설계서 (flash → mid → senior)

- 모델: **flash-worker** OpenCode DeepSeek V4.1 Flash(먼저) → **mid-worker** Sonnet 5.5 → **senior-worker** Opus 5.5. 단계마다 첫 시도 + 재시도 최대 2회, 그래도 관문 FAIL이면 한 단계 위(hc-team 규칙).
- Codex 검수 반영(2026-11-10, 필수 2 · 6 · 8 · 11, 권장 3 · 5).
- 근거: [dashboard-v2.md](../dashboard-v2.md) 18절, leader 지시문, 커밋된 시험. 공통 규칙 [README](README.md).

## 1. 받는 것 · 내는 것

- 받는 것: 이슈 지시문(고칠 파일 목록 · 시험 파일 · 완료 명령). 시험은 **이미 커밋돼 있다**.
- 내는 것: 지시한 파일 안의 변경 커밋 + 결과 보고(완료 명령 출력 마지막 줄 · 린트 경고 수 전/후).
- 하지 않는 것: 시험 파일 고치기 · 지시 밖 파일 고치기 · 새 의존성(지시에 없으면) · 화면 결정을 새로 하기.

## 2. 코드 규칙 (7차)

| 규칙 | 이렇게 | 이렇게 하지 않음 |
|---|---|---|
| 글자 크기 | `text-caption` · `text-meta` · `text-body` · `text-title` · `text-page` | `text-[13px]`, `text-sm`를 새로 섞기 |
| 클래스 합치기 | `import { cn } from "@/lib/utils"` | `import { cn } from "cn"` (토큰 등록이 빠짐 → 글자색 사라짐) |
| 부품 모양 | shadcn 부품 + 변형(variant · size) | `<Card className="px-5 gap-0">`처럼 덮어쓰기(린트 경고 늘어남) |
| 색 | 테마 토큰(`text-ink`, `bg-ok-soft`, `border-line-strong` …) | `bg-pink-500`, `border-neutral-800` |
| 화면 말 | 사전(1.3 · 18.4): AI 작업 중 · 확인 필요 · 시작 전 · 고정된 결과 · API 회사 화면에서 본 숫자 | 옛 말 · 영어 병기 · 설계 용어 · ‘Go’ |
| 초점 | 화면 바뀜 뒤 초점받을 제목에 `tabIndex={-1}` + `data-route-target` | `autoFocus` 남발, 초점 가로채기 |
| 알림 | 한 곳에서 한 번(`role=status` 또는 토스트 하나) | 같은 말을 토스트와 화면에 둘 다 |
| React | 상태는 이벤트 처리기에서 바꾸고, 렌더 중 `ref.current`를 읽지 않음 | effect 안에서 바로 `setState` |
| 디자인 도구 | 화면을 만들거나 고칠 때는 **항상 impeccable**(사용자 지시 2026-11-10): Claude Code worker는 `/impeccable` 스킬(작업에 맞는 명령)을 먼저 부르고, 모든 worker는 끝내기 전에 `impeccable detect --json <바꾼 파일>`로 검사 | 감으로 스타일을 정하기 · 검사 없이 DONE |

## 3. 이슈별 구현 메모

- **UI7-0a 시험 도구**: Vitest · `@testing-library/react` · `@testing-library/user-event` · jsdom을 `--save-exact`로, `vitest.config.ts`(jsdom · `@` 별칭), `src/test/setup.ts`, `package.json`에 `"test": "vitest run --passWithNoTests"`, README 명령 목록. `scripts/lint-budget.mjs`: 표준 입력이 아니라 직접 `oxlint src --format=json`을 실행해 `diagnostics[].code`를 세고, 인자 `'<글롭>=<수>'` · `'<글롭><=<수>'`(글롭의 `*`는 아무 글자)를 하나라도 어기면 어긴 규칙 · 수를 찍고 종료 1. 시험 파일은 만들지 않는다(tester 몫).
- **F1 부탁 시 펼침**: `aiSheet.ask`가 넓은 화면에서 `aiOnRound`도 켜고, 펼쳐진 뒤 부탁할 말 칸에 초점(지금은 `aiPanel`만 켬). **F2 승인 수**: 지금 할 일 머리 · 개요 · 승인 카드 모두 `approvalBlockers().total`과 “승인을 막는 것 n건”. **F3 사용량 줄**: 18.6의 경우별 문구 — 확인할 수 없는 현재 과금을 단정하지 않음.
- **UI7-1 카드 변형**: `card.tsx`에는 cva가 없고 `size: "default" | "sm"`과 `data-size`가 이미 있다 — 이 계약을 그대로 두고 `compact`(지금 화면이 쓰는 `gap-0 px-5`)를 더한다. 화면의 덮어쓰기를 `size="compact"`로 바꾸고, 바깥 여백(`mt-3` 등)은 카드를 감싸는 요소로 옮긴다. leader가 정한 **파일 묶음만** 한 PR에. 화면 모양이 바뀌면 안 된다.
- **UI7-2 React 경고**: 경고 위치는 `npx oxlint src --format=json`의 `react(...)`. 고치는 법: 열릴 때 비우기 → `key`로 다시 그리기 또는 열기 처리기에서 비우기 / 렌더 중 ref → 상태(`useState`)나 계산으로. 동작은 그대로(시험이 지킨다).
- **UI7-3 개요 칸**: `OverviewPage`의 6칸 격자에서 현재 칸만 `col-span`을 넓히거나 글자를 한 줄(“현재 · 나의 할 일” → 칸 아래 한 줄)로. 6칸 순서 · 모양 · 글자는 그대로.

## 4. 끝내기 전에 직접 돌릴 것

```bash
npm run typecheck && npm run lint && npm test && node scripts/lint-budget.mjs '<지시문의 규칙 목표>'
```

- 린트 **오류 0**, 경고 수가 시작 때보다 **늘지 않음**(보고에 숫자).
- 실패하면 원인 한 줄과 함께 보고하고 멈춘다(같은 실패를 세 번 되풀이하지 않는다).

## 5. 단계별 차이

| worker | 맡는 것 | 더 기대하는 것 |
|---|---|---|
| flash | 첫 시도 전부 | 지시문 그대로, 작은 커밋 |
| mid | flash 단계에서 첫 시도 + 재시도 2회 모두 FAIL | 실패 원인을 먼저 한 줄로 적고 고침. 시험이 틀렸다고 보이면 고치지 말고 leader에게 |
| senior | mid 단계도 같음 | 설계와 시험이 서로 어긋나는지 판단해 leader에게 선택지 2개 + 추천. 구조 바꿈은 leader 승인 뒤 |
