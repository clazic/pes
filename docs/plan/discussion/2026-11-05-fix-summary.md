# 2026-11-05 검수 반영 — 묶음 summary

- 입력: [2026-11-05-codex-review.md](2026-11-05-codex-review.md), [2026-11-05-mode-a-web-direct-and-references.md](2026-11-05-mode-a-web-direct-and-references.md), [2026-11-05-go-subscription-and-b-apps-changes.md](2026-11-05-go-subscription-and-b-apps-changes.md)
- 수정 파일: `roadmap.md`, `summary-for-approval.md`, `README.md`, `stage-1-api.md`, `decisions/0003-mode-b-agents.md`, `decisions/README.md`, `00-brief.md`
- 실제 `~/pes-projects`·`~/.pes/`는 읽거나 쓰지 않았다. 실제 자료·키·사용자 절대경로·세션 ID를 넣지 않았다. 커밋·push·Linear 등록은 하지 않았다.
- `stage-1-api.md`는 지시 목록과 F16에 포함되어 수정했다. 다른 `stage-1-*.md`(db·ui·runners)와 `stage-0.md`는 건드리지 않았다.

## F16 — 집계 원본과 잔여 숫자

**반영**
- `roadmap.md` 2절에 현행 집계를 단일 기준으로 명시: 2단계 25·3단계 11·4단계 9·5단계 16·6단계 9, 신규 70 + 기존 31 = 101, 여유 159. 산술은 유지했다.
- 같은 곳에 2026-11-04 당시 2단계 22개 승인 기록은 시점 이력으로 보존하고, 현행 2단계는 PR1~19·20a·20b·20c·21·22·26의 25개라고 적었다.
- `summary-for-approval.md` 3절에 같은 현행 집계·과거 22개 시점 기록을 추가했다.
- `README.md`의 stage-2 설명을 25 PR로, issues/stage-2 색인을 PR1~19·20a·20b·20c·21·22·26으로 고쳤다.
- `stage-1-api.md` 결정 18의 "2단계 22개 PR 유지"를 현행 25개·roadmap 2절 참조로 바꾸고, 2026-11-04 당시 22개는 시점 기록으로 남겼다. 9절 PR 목록도 20a·20b·20c·26을 반영했다.

**남은 것·다른 파일 필요**
- `docs/plan/stage-1-db.md:33,178,203~207`의 24/57/56·PR20 단일/PR26 누락 표기를 25/56/101·20a·20b·20c·26 기준으로 정리해야 한다.
- `docs/plan/stage-1-ui.md:82`의 22 표기를 roadmap 2절 기준으로 정리해야 한다.
- `docs/plan/stage-3.md:17,202`의 24 표기를 11 기준으로 정리해야 한다.
- `docs/plan/issues/stage-3.md:249`의 REF1 표 수 55를 현재 60으로 고쳐야 한다.

## R03 — 이미 결정된 것과 남은 사용자 결정

**반영**
- `roadmap.md` 5.1에 "이미 정한 것"을 명시: TypeScript 단일 언어·0.15 Python 이전(0016), 파일별 AI 참조 기본 allow, B 양방향·통로 분리(PC 도우미↔웹 WebSocket/HTTP, AI 도구↔PES MCP/API, 브라우저 안 보조만 WebMCP). 5.2에서 다시 묻지 않는다고 적었다.
- `roadmap.md` 5.2에서 TypeScript 단일 언어·0.15 이전 행과 웹↔PC 양방향 연결 행을 뺐다. 호스팅 행은 "플랫폼 조합 전체·카드·월 총비용"으로 넓혀 남은 결정을 한 번에 묻게 했다.
- `summary-for-approval.md` 4.1에 같은 "이미 정한 것" 안내를 넣고, 파일별 AI 참조 기본값·웹↔PC 양방향 연결·TypeScript 단일 언어 행을 사용자 결정 표에서 뺐다. 호스팅 행은 조합 전체·카드·월 총비용으로 바꾸고, 중복된 VPS/Workers 밖 행을 합쳤다.

**남은 것**
- 남은 사용자 결정은 플랫폼 조합 전체·카드·월 총비용, 자료 위치·관할, 검색 공급자/자료 반출 범위, 확정 모델/기본값 변경, 실제 자료 사용 허용 범위다.
- 다른 파일 필요 없음.

## R04 — 결정 색인·상태

**반영**
- `decisions/README.md`의 0002 상태를 "채택 — 일부 대체(0013)"로 표시했다.
- 0013·0014·0016 색인 행이 있는 것을 확인했다.

**남은 것·다른 파일 필요**
- `docs/plan/discussion/2026-11-05-go-subscription-and-b-apps-changes.md` 첫머리의 98개·구표 수 안내를 최종 8차 기준 101개·60표로 갱신해야 한다.
- `docs/plan/discussion/2026-11-05-mode-a-web-direct-and-references.md` 첫머리에도 최종 8차·101개·60표를 안내하는 편이 좋다.

## F17 — B 연결 설명의 WebMCP 역할

**반영**
- `decisions/0003-mode-b-agents.md`의 B 흐름을 "PC 도우미↔웹 WebSocket/HTTP, AI 도구↔PES MCP/API, 브라우저 탭 안 보조만 WebMCP"로 고쳤다. WebMCP는 PC↔웹 통로가 아니라고 명시했다.
- `summary-for-approval.md` 용어 설명에 같은 3통로 구분을 넣었다. 3절의 3통로 표는 그대로 유지했다.
- `00-brief.md`와 `roadmap.md`의 B 설명도 같은 구분으로 맞췄다.

**남은 것·다른 파일 필요**
- `docs/plan/stage-1-runners.md:38,44`의 "MCP 또는 WebMCP" 표현을 3통로 구분으로 고쳐야 한다.
- `docs/plan/stage-5.md:245~249`의 B 연결 설명도 같은 구분인지 확인·정리해야 한다.

## F09 — B 로컬 동기화와 파일 스위치

**반영**
- `summary-for-approval.md` 3단계 설명에 "B의 PC 동기화 폴더는 AI 도구가 직접 읽을 수 있으므로, 도우미·파일·셸 권한 통제 범위를 시험하고 통제 불가 경로는 'A·B 모두 제외 보장'으로 표시하지 않는다"를 넣었다.
- `00-brief.md`와 `roadmap.md`의 "금지 파일은 A·B 모두 AI에 내보내지 않는다"를 "A와 PES API/MCP 응답에서 내보내지 않는다"로 바꾸고, B 로컬 직접 읽기 한계와 통제 범위 시험을 덧붙였다.

**남은 것·다른 파일 필요**
- `docs/plan/stage-3.md:265`, `docs/plan/stage-5.md:235~240`, `docs/plan/issues/stage-5.md:339~351`에 같은 로컬 직접 읽기·동기화 캐시·파일/셸 권한 시험을 반영해야 한다.

## F05/F06 — Go 주소·과금 판단

**반영**
- `roadmap.md` SEL-18 실험 행에서 cost=0 확인을 "주소·모델 목록·원시 model ID↔내부 ID·구독 적용 조건 후보 검증, billing source·allowance·오류/스트림 필드 확인"으로 바꾸고, cost=0만으로 Go 구독이라고 판단하지 않는다고 적었다. 후보 주소는 `/inference/...` 계열과 `/inference/v1/models`로 표시했다.
- `roadmap.md` 5.2의 Go 사용량 행에 시작 전 Extra Usage OFF 확인 증거·유효 기간, 확인 불가 시 차단, 계정/워크스페이스 기준점·allowance/가중치·다음 호출 상한 예약·병렬/재시도/인계/재시작 누적·unknown 보존을 넣었다.
- `summary-for-approval.md` 4.1과 위험 표에 같은 후보 검증·OFF 확인·billing source·allowance·오류/스트림 필드 조건을 넣었다.
- `00-brief.md`와 `stage-1-api.md` 9절에도 주소·모델 목록·원시 ID 매핑·구독 적용·billing source·allowance·오류/스트림 필드를 PR19/SEL-18 검증 후보로 적었다.

**남은 것·다른 파일 필요**
- `docs/plan/decisions/0013-mode-a-go-subscription-and-model-choice.md:24,38~50`의 고정 주소·cost=0 판단 표현을 후보·검증 대상으로 고쳐야 한다.
- `docs/plan/stage-1-runners.md:23,68`, `docs/plan/issues/stage-2.md:315,319~320`, `docs/plan/issues/stage-5.md:178,181`, `docs/plan/issues/stage-6.md:208~221`의 F05/F06 계약도 같은 기준으로 정리해야 한다.

완료: docs/plan/discussion/2026-11-05-fix-summary.md
