# 4. 관문(스크립트) — 대시보드 7차 판정 설계서

- 도구: `~/hc-agents/bin/hc-gate.sh` — **AI 없음**. leader가 worker 시도마다 **worktree 루트에서** 직접 돌린다. PASS/FAIL만 내고 코드는 고치지 않는다.
- 근거: [dashboard-v2.md](../dashboard-v2.md) 18.7 · 18.9, [1-leader.md](1-leader.md), 공통 규칙 [README](README.md). Codex 검수 반영(2026-11-10, 필수 1 · 3 · 4).

## 1. 스크립트가 보는 4가지

1. **범위**: worker 커밋이 `--allow` 글롭 밖을 바꿨나. 경로는 **저장소 루트 기준**(`git diff-tree` 출력 그대로). 글롭의 `*`는 `/`도 넘는다.
2. **미커밋**: 커밋 안 된 변경이 남았나.
3. **시험 변조**: worker 커밋이 시험 파일을 건드렸나 / tester 커밋이 시험 아닌 파일을 건드렸나. 시험 파일 = `*.test.*` · `*.spec.*` · `test/` · `__tests__/` 등.
4. **검증 명령**: `--verify`를 순서대로 `bash -c`로 — 하나라도 0이 아니면 FAIL. 파이프는 마지막 명령의 종료 코드만 보므로 쓰지 않는다.

## 2. 완전한 실행 예 (시안 이슈)

```bash
M=docs/plan/mockups/dashboard-v2-react
hc-gate.sh --issue UI7-2 --base main \
  --tester '<tester 커밋 해시들>' \
  --allow "$M/src/lib/draft.ts,$M/src/components/pes/controls.tsx,$M/src/components/pes/confirm.tsx" \
  --verify "cd $M && npm run typecheck" \
  --verify "cd $M && npm run lint -- --max-warnings <기준>" \
  --verify "cd $M && node scripts/lint-budget.mjs 'react(*)=0'" \
  --verify "cd $M && npm test" \
  --verify "cd $M && npm run build" \
  --verify "cd $M && out=\$(sh ~/.claude/plugins/marketplaces/impeccable/plugin/skills/impeccable/scripts/impeccable detect --json src) && [ \"\$(printf %s \"\$out\" | tr -d '[:space:]')\" = '[]' ]"
```

- `<기준>` = 이슈를 시작할 때 린트 경고 총수(leader가 `npx oxlint src --format=json`으로 세어 지시문에 적음). 총수는 **늘지 않음**만 본다.
- **이슈별 목표는 규칙별 수로** 본다: `scripts/lint-budget.mjs`(UI7-0에서 worker가 만듦)는 `oxlint --format=json` 결과를 `diagnostics[].code`로 세어 `'<규칙 글롭>=<수>'` 또는 `'<규칙 글롭><=<수>'`를 어기면 종료 코드 1. 예: UI7-2 `'react(*)=0'`, UI7-1 `'shadcn(no-restyle)<=<목표>'`.
- 디자인 검사는 출력을 변수로 받아 **명령 성공 && 출력이 정확히 `[]`** 일 때만 통과(검사 자체가 실패해도 `[]`를 내는 경우를 막음).
- 린트 **오류**는 `--max-warnings`와 상관없이 늘 FAIL(오류 수준 규칙 — 18.7).

## 3. 이슈별 `--allow` (저장소 루트 기준, `M=docs/plan/mockups/dashboard-v2-react`)

| 이슈 | 커밋 | 허용 파일 |
|---|---|---|
| UI7-0a 시험 도구 | worker | `$M/package.json,$M/package-lock.json,$M/README.md,$M/vitest.config.ts,$M/src/test/setup.ts,$M/scripts/lint-budget.mjs` — 시험 0개로 `npm test` 통과(`--passWithNoTests`) |
| UI7-0b 바탕 시험 | tester만 | 시험 파일만(관문 3번이 지킴). worker 커밋 없음 → 관문은 검증 명령만 의미 |
| UI7-1 카드 변형 | worker | `$M/src/components/ui/card.tsx` + leader가 정한 **화면 파일 목록**(묶음별 PR — R3) |
| UI7-2 React 경고 | worker | 린트가 가리킨 파일 목록(leader가 시작 때 적음) |
| UI7-3 개요 칸 | worker | `$M/src/features/research/OverviewPage.tsx` — UI7-1 뒤(겹침 — R2) |
| UI7-4a · 4b | — | 설계 확인 뒤 정함 |

## 4. 관문이 못 보는 것 (leader · 리뷰어 몫)

- **두 폭 확인**(1440 · 390): 가로 넘침 0 · 가장 작은 글자 12px · 채운 단추 글자 대비 4.5:1 · UI7-3의 “상태 글자 2줄 이하” — leader가 브라우저로 확인해 PR 본문에 붙인다.
- **시험 기대값이 약해졌는지**: 관문은 누가 시험 파일을 바꿨는지만 본다. tester 커밋의 기대값 변경은 leader가 diff로, 리뷰어가 다시 본다.
- 화면 말 · 설계 일치 — 1차 · 최종 리뷰.

## 5. FAIL일 때 (hc-team 규칙 그대로)

- `.ai-gate.log` 마지막 줄 · 실패한 검사 번호를 같은 worker에게 보낸다.
- worker 단계마다 **첫 시도 + 재시도 최대 2회**. 그래도 FAIL이면 한 단계 위(flash → mid → senior). tester 보강의 `BUG`도 재시도 횟수에 넣는다.
