# 0단계 기반 다지기 — OpenCode 관점

- 작성: 2026-11-04, OpenCode (`opencode-go/deepseek-v4.1-flash`)
- 읽은 것: `docs/plan/00-brief.md`, `scripts/pes.py`, `scripts/serve.py`, `skills/*/SKILL.md`, `agents/*.md`, `questions/*.json`, `templates/*`, `README.md`, `.claude-plugin/*`, 실제 PES 프로젝트 2개의 구조(내용 아님)
- 전제: **hwpx 변환 확인은 0단계에서 제외**(브리프 `00-brief.md:45`). 이 문서는 코드를 고치지 않고, 0단계 설계서에 들어갈 쟁점·선택지·추천·완료 기준만 제시한다.
- 문서의 위치: `docs/plan/discussion/stage-0-opencode.md`. Claude가 `docs/plan/stage-0.md`로 종합하기 전의 의견서다.

---

## 0. 한 장 요약

1. **0단계의 목표는 기능 추가가 아니라 "바꿔도 안 깨지는 상태"다.** 지금 PES는 1,713줄 CLI·정적 HTML·파일 상태가 서로 강하게 얽혀 있고 테스트가 0개다(`00-brief.md:11`, `scripts/pes.py:1-45`). 1단계에서 DB·API로 바꾸기 전에 **v0.15.6의 동작을 고정**해야 한다.
2. 가장 큰 위험은 테스트 부재 자체보다 **상태를 만드는 경로가 여러 개**라는 점이다. CLI, 스킬의 직접 `project.json` 편집(`skills/core/SKILL.md:62-84`), 웹 `POST /feedback`(`scripts/serve.py:111-152`), 그리고 앞으로의 에이전트 API가 같은 상태를 서로 다르게 쓴다. 0단계에서 **"쓰기는 하나의 검증된 경로로"** 원칙을 세워야 한다.
3. 방식 A·B의 공통 결론은 **"에이전트는 `project.json`을 직접 쓰지 않는다"** 이다. 에이전트는 컨텍스트를 받고, 결과·질문·이벤트를 API로 제출하며, PES가 상태 전이를 검증한다. 이것이 브리프의 "같은 데이터 모델과 같은 API"( `00-brief.md:39`)를 지키는 최소 조건이다.
4. 0단계에서 DB·API를 **구현하지 않는다.** 대신 스키마·이벤트·질문/답·run의 **계약을 문서와 fixture로 고정**하고, 두 방식의 가짜 어댑터가 같은 기록을 만드는지 계약 테스트로 확인한다. 구현은 2단계, 화면은 3단계다.
5. 방식 A는 "저가 모델이 PES 스킬을 따라할 수 있는가"를 **측정하는 스파이크**로 시작해야 한다. OpenCode 서버의 세션·이벤트·권한·폼·사용량 API는 이미 있으므로 새로 만들지 말고 감싼다. 단, 모델 품질이 기준에 못 미치면 A의 범위를 줄이거나 단계별 모델 정책을 택해야 한다.
6. 완료 기준은 "테스트 통과" 하나가 아니다. **v0.15.6 동작 동일 + 스키마/계약 v0 + 두 방식의 가짜 어댑터 통과 + Windows/macOS CI green + 사용자 승인**이 함께 필요하다.

---

## 1. 지금 코드에서 확인한 사실

| 사실 | 근거 | 0단계에 주는 의미 |
|---|---|---|
| CLI 하나가 6단계·30개 이상 명령·렌더·서버 관리·진단을 모두 담당한다 | `scripts/pes.py:1-45`, `:1707-1713` | 리팩터보다 **동작 고정(characterization)** 이 먼저다. 명령 표면이 곧 계약이다. |
| `project.json`이 단일 진실 원천이고, `library.json`은 따로 저장된다 | `skills/core/SKILL.md:18`, `scripts/pes.py:147-158` | DB 이전 시 **어떤 필드가 상태이고 어떤 필드가 첨부인지** 먼저 분류해야 한다. |
| `"pes": 1`을 쓰지만 읽는 곳이 없다 | `scripts/pes.py:206` (읽기 없음) | 스키마 버전이 사실상 없다. 마이그레이션 기준을 새로 세워야 한다. |
| `load()`가 빠진 필드를 조용히 채운다 | `scripts/pes.py:96-114` | 손상·구버전·수기 편집이 **오류 없이 통과**한다. 테스트로 현재 동작을 고정하고, 검증 정책을 따로 정해야 한다. |
| 실제 프로젝트 `project.json`이 322KB·1.76MB까지 커진다 | `~/pes-projects/*/project.json` 실측(2026-11-04) | 전체 파일 읽기/쓰기·전체 렌더는 곧 한계에 닿는다. 성능 예산과 분할 기준이 필요하다. |
| 상태를 바꾸는 경로가 CLI 외에도 있다: 스킬이 Python으로 직접 편집 | `skills/core/SKILL.md:62-84` | API·DB 시대에 가장 먼저 깨질 부분이다. **직접 편집 금지**와 대체 명령 설계가 필요하다. |
| 잠금은 `.pes-lock` 파일 + 2시간 TTL + `PES_OWNER` 환경변수다 | `scripts/pes.py:117-144`, `:1677-1699` | 다중 에이전트·웹에서는 lease·revision·heartbeat로 확장해야 한다. 지금은 마지막 쓰기가 이긴다. |
| 서버는 127.0.0.1에만 열리고 Origin 허용목록·256KB 제한·디렉터리 목록 금지가 있다 | `scripts/serve.py:22-38`, `:80-82`, `:111-152`, `:154` | 기본 보안선은 좋다. 다만 인증은 없고, Tailscale 원격·에이전트 토큰을 붙일 때 다시 봐야 한다. |
| 피드백은 파일로 append-only, 라운드 스냅샷·이력이 이미 있다 | `scripts/serve.py:138-151`, `scripts/pes.py:294-299`, `:400-410` | 이벤트 로그의 씨앗은 있다. 새로 만들기보다 **의미를 정의**하고 DB로 옮기면 된다. |
| 스킬이 Claude 전용 토큰에 의존한다 | `skills/core/SKILL.md:16`(AskUserQuestion), `:23`(CLAUDE_PLUGIN_ROOT), `:123`(Agent, model opus), `:154`(anthropic-skills) | 방식 A/B가 같은 스킬을 쓰려면 **워크플로와 도구 어댑터 분리**가 필요하다. |
| research-loop의 `state.json`을 읽어 `library.json`으로 복사한다 | `scripts/pes.py:219-239` | 외부 저장 포맷과의 계약이 문서화되어 있지 않다. fixture와 버전 확인이 필요하다. |
| 테스트·CI·개발 의존성 선언이 없다 | 저장소 파일 목록, `00-brief.md:11` | 0단계의 핵심 산출물은 테스트와 CI다. |
| Windows 우선, macOS 병행, OneDrive 동기화 사용 | `00-brief.md:12`, `README.md:343-360`, `:503-513` | CI 매트릭스와 경로·인코딩·동시 쓰기 정책이 필요하다. |
| 설치·배포가 플러그인 루트 경로에 의존한다 | `skills/core/SKILL.md:23-25`, `README.md:107-141` | 0단계에서 대규모 디렉터리 이동은 위험하다. 경계만 정하고 이동은 미룬다. |

**정리**: 지금은 "테스트가 없다"보다 **"계약이 코드 곳곳에 흩어져 있다"** 는 것이 본질이다. 0단계는 그 계약을 문서·스키마·테스트로 모으는 단계다.

---

## 2. 0단계 주제 목록

우선순위: **P0** = 0단계에서 반드시 결정·산출, **P1** = 결정하고 최소 구현, **P2** = 결정만 하고 구현은 다음 단계.

### P0 — 안전망과 계약

| # | 주제 | 0단계 산출물 |
|---|---|---|
| 1 | 테스트 범위와 층위 | `tests/` 실행 가능한 스위트, 명령·상태 전이 커버리지 표 |
| 2 | 테스트를 가능하게 하는 경계(seam)와 리팩터 허용 범위 | `main(argv)`, 시간·포트 주입, 동작 보존 리팩터 목록 |
| 3 | 픽스처·실데이터·개인정보 | 합성 fixture, 로컬 전용 golden, 정제 규칙 |
| 4 | CI·품질 게이트·지원 환경 | GitHub Actions, 로컬 검사 스크립트, 필수 체크 |
| 5 | 저장소 구조와 모듈 경계 | 디렉터리 경계표, 예약 디렉터리(`schemas/`, `tests/`, `adapters/`, `web/`) |
| 6 | `AGENTS.md`와 에이전트별 지침 | `AGENTS.md`, `CLAUDE.md` 포인터, OpenCode 지침 연결 |
| 7 | `project.json` 스키마 동결·버전·마이그레이션 | `schemas/*.json`, 마이그레이션 규칙, 백업 규칙, 성능 예산 |
| 8 | 사람 상호작용 계약(질문·답·첨언) | 질문/답 스키마 v0, 하위 호환 규칙, 예약 필드 |
| 9 | 에이전트 API 계약(A/B 공통) | `docs/plan/api-v0.md`, run 봉투, 오류·멱등 규칙 |
| 10 | 동시성·소유권·lease | lease/revision 의미론, 현재 잠금의 알려진 한계 |
| 11 | 보안·프라이버시 기준선 | 위협 모델, 경로/Origin/토큰 테스트, 비밀 금지 규칙 |
| 12 | 방식 A: OpenCode 서버 통합 스파이크 | 측정 리포트, go/no-go, 어댑터 인터페이스 |
| 13 | 방식 B: 외부 에이전트 연결 | MCP 도구 스키마, HTTP/CLI 호환 경로, 스파이크 |
| 14 | 스킬 중립화와 도구 어댑터 | `docs/plan/agent-adapters.md`, 금지 토큰 lint, core+plan 파일럿 |
| 15 | research-loop 저장소·가져오기 계약 | 계약 v1, fixture, 버전 확인 |

### P1 — 규칙과 관측

| # | 주제 | 0단계 산출물 |
|---|---|---|
| 16 | 이벤트·관측성·디버깅 | 이벤트 분류, `runs/<id>/` 산출물 규격, 비밀 제거 규칙 |
| 17 | 개발 규칙·의사결정 기록·릴리스 | ADR 템플릿·색인, 커밋/버전/체인지로그 규칙, 롤백 절차 |
| 18 | 의존성·런타임 정책 | 런타임 stdlib 유지, dev 의존성, Python 최소 버전 결정 |

### P2 — 유예와 경계

| # | 주제 | 0단계 산출물 |
|---|---|---|
| 19 | 유예 목록과 경계(hwpx·웹 UI·DB 구현·다중 사용자) | 유예표, 인터페이스 경계, 건너뛴 테스트 표시 |

---

## 3. 주제별 논의

각 항목은 **정할 것 / 선택지 / 판단 기준 / 추천과 이유** 순서다.

### 3.1 테스트 범위와 층위 — P0

**정할 것**
- 어떤 층위를 테스트하는가: 순수 함수, CLI, 서버 HTTP, 렌더 결과, 마이그레이션, 브라우저 E2E.
- 무엇을 제외하는가: 외부 API(KOSIS·법령·vworld·브라우저), hwpx, 실제 사용자 데이터, 카드 디자인.
- "커버리지"를 무엇으로 측정하는가: 줄 수 비율이 아니라 **명령·상태 전이·답 종류**의 비율.
- 테스트 이름·주석 언어: 코드/테스트는 영어, 사용자에게 보이는 문자열은 한국어(권장).

**선택지**
1. 단위 테스트 중심: 빠르지만 CLI·파일·HTML 계약의 회귀를 놓친다.
2. **CLI 통합 중심 피라미드**: 순수 함수는 단위로, 핵심은 실제 `pes.py` 서브프로세스로, 서버는 HTTP로, 렌더는 구조 단언으로.
3. 브라우저 E2E 중심: 사용자 화면은 잘 보지만 느리고 불안정하며, 0단계에는 과하다.

**판단 기준**
- 리팩터·DB 이전에서 실제로 깨질 곳을 잡는가.
- 로컬에서 60~90초 안에 끝나고, 네트워크 없이 결정적으로 돌아가는가.
- Windows·macOS에서 같은 결과가 나오는가.
- 유지비가 낮은가(테스트가 제품보다 커지지 않는가).

**추천: 2번.**
- 층위를 다음처럼 고정한다.
  - L1 스키마/순수 함수: `load`·`save`·`new_stage`·`blank_item`·`slim`·`stage_md`·`qlabels`·`import_library`·`norm_text`.
  - L2 CLI 통합: `init` → `ask-prep` → `ask` → `round-start` → `merge` → `render` → `approve` → `reopen` → `report` → `assemble`/`web` → `qa-brief`/`qa` → `status`/`pending`/`mark`/`chat`/`note`/`digest`/`show`/`lock`/`unlock`.
  - L3 서버: `serve.py`를 임시 포트로 띄우고 `GET /whoami`, `/version`, `POST /feedback`의 정상·Origin 거부·kind 오류·본문 초과·빈 본문을 확인.
  - L4 렌더: 전체 HTML 스냅샷 대신 **구조 단언**(특정 id/클래스/텍스트/표 행 수). `built` 시각과 파일명 타임스탬프 때문에 전체 스냅샷은 쉽게 깨진다.
  - L5 마이그레이션/golden: v0.15.6 fixture를 재생해 의미상 동일한 JSON·보고서가 나오는지 비교(시각·정렬 정규화).
  - L6 브라우저 E2E: 3단계 이후로 미룬다.
- 최소 규칙: **모든 CLI 명령에 성공 1 + 실패 1**, **모든 상태 전이**, **core의 답 종류 6가지**(`skills/core/SKILL.md:191-206`), **doctor의 주요 검사**(`:1531-1560`)를 테스트로 덮는다.
- 이유: 현재 스킬과 두 방식 모두 결국 `pes` CLI/API를 호출한다. CLI가 가장 안정적인 계약이고, HTML은 생성물이라 구조 단언이 유지비가 낮다. 브라우저 E2E는 0단계의 목적(안전한 변경)에 비해 비싸다.

**주의**
- `serve.py`는 `HUB_PORTS`(8760~8764)를 `pes.py`가 고정하지만, `serve.py` 자체는 포트 인자를 받는다(`scripts/serve.py:29`). 서버 테스트는 `serve.py`를 직접 띄워 **임시 포트**를 쓴다. CLI `serve` 테스트는 포트 충돌을 피하기 위해 별도 표시(integration)로 둔다.
- `open`·브라우저·`tail`·`grep`은 테스트에서 호출하지 않는다. Windows CI에 Git Bash가 없을 수 있다.

---

### 3.2 테스트를 가능하게 하는 경계(seam)와 리팩터 허용 범위 — P0

**정할 것**
- 테스트를 위해 어디까지 코드를 바꿀 수 있는가.
- 어떤 전역·부작용을 주입 가능하게 만들 것인가.
- "동작 보존"의 기준은 무엇인가(출력 문자열, 파일 포맷, HTML 구조, 종료 코드).

**현재 걸림돌**
- `ROOT`·`TPL`·`QB`가 모듈 로드 시 고정된다(`scripts/pes.py:57-59`).
- `CONFIG`가 `Path.home()` 기준으로 고정된다(`:73`). 다만 `PES_HOME`은 이미 지원한다(`:76-86`).
- 시간이 `now()`·`time.time()`에 직접 의존한다(`:181-182`, `:117-144`).
- 포트가 `HUB_PORTS = range(8760, 8765)`로 고정된다(`:1195`).
- `main` 진입점이 모듈 하단의 `sys.argv` 처리다(`:1707-1713`).
- 서버 기동·브라우저 열기·`pkill`이 함수 안에 직접 들어 있다(`:1045-1051`, `:1184-1186`).

**선택지**
1. 전혀 고치지 않고 서브프로세스로만 테스트한다. 안전하지만 시간·잠금·오류 분기 테스트가 어렵다.
2. **최소 seam만 추가**한다: `main(argv=None)`, 시간 주입, 포트 주입, `PES_HOME`/`PES_OWNER` 격리. 나머지는 서브프로세스.
3. 패키지로 전면 재구성한다(`pes/` 패키지, 서비스 계층 분리). 2단계 작업을 0단계로 당긴다.

**판단 기준**
- 테스트가 실제 사용자 경로를 검증하는가(과도한 mock은 가치가 낮다).
- 변경 diff가 작고 리뷰 가능한가.
- 1단계 DB 설계와 충돌하지 않는가.
- Windows에서도 동작하는가.

**추천: 2번.**
- 허용: `main(argv)` 추가, 시간·포트·홈 경로 주입, 순수 함수 추출, 출력은 그대로.
- 금지: 명령 이름·출력 형식·파일 포맷·HTML 구조 변경, 스키마 변경, 디렉터리 이동.
- 각 seam은 **실패하는 테스트가 있을 때만** 추가한다. "나중에 쓸 것 같아서" 만든 추상화는 0단계에서 금지.
- 이유: 지금 필요한 것은 아키텍처가 아니라 **회귀 감지**다. 전면 재구성은 테스트 없이 하면 위험이 크고, 1단계 설계가 끝난 뒤에 하는 편이 낫다.
- 1단계에서 DB·API를 설계할 때 CLI와 API가 **같은 서비스 함수**를 호출하도록 경계를 잡는다. 0단계에서는 그 경계를 문서로만 표시하고, 코드는 최소 seam까지만 만진다.

---

### 3.3 픽스처·실데이터·개인정보 — P0

**정할 것**
- fixture를 저장소에 둘 것인가, 로컬에만 둘 것인가.
- 실제 프로젝트를 테스트에 쓸 것인가, 합성 데이터를 만들 것인가.
- 어떤 edge case를 fixture로 고정할 것인가.
- 민감 정보 정제 기준은 무엇인가.

**선택지**
1. 실제 프로젝트를 복사해 커밋한다. 재현성은 좋지만 **비공개 연구·개인정보·스크린샷**이 유출된다.
2. **합성 fixture를 커밋**하고, 실제 프로젝트 재생은 로컬 전용 스크립트로 둔다.
3. fixture 없이 매번 CLI로 생성한다. 생성기 자체가 깨지면 테스트가 무의미해진다.

**판단 기준**
- 개인정보·비공개 자료가 저장소에 들어가지 않는가.
- 테스트가 결정적이고 작은가.
- 실제 파일 크기·구조·인코딩을 반영하는가.
- 갱신 비용이 낮은가.

**추천: 2번.**
- `tests/fixtures/`에는 **합성**만 둔다. 생성은 가능하면 `pes init`/`round-start`/`merge` 같은 CLI를 호출해 만든다(도그푸딩). 손으로 큰 JSON을 쓰지 않는다.
- `tests/local/`(gitignore)에는 실제 프로젝트를 복사한 **로컬 전용 golden**을 두고, `scripts/golden_local.py` 같은 도구로만 실행한다. CI에는 절대 올리지 않는다.
- fixture 세트:
  - `min/`: 각 단계 최소 1개 항목.
  - `full/`: 6단계, 답 종류 6가지, 재열기·승인 이력 포함.
  - `large/`: 2MB급(생성), 300개 항목, 렌더 성능 측정.
  - `legacy/`: v0.15.6에서 만든 구조(스키마 버전 없음, `pes:1`).
  - `research-loop-v1/`: `state.json` + `shots/` 가져오기.
  - `edge/`: 빈 단계, 중복 id, 깨진 JSON, `project.json.tmp`, OneDrive 충돌 사본, 잠금 만료, 한글·이모지, Windows 경로.
- 정제 규칙: 기관명·사람 이름·전화·이메일·주소·비공개 인용문을 모두 바꾼다. 스크린샷·보고서 원문은 커밋하지 않는다.
- `.gitignore`는 현재 `docs/archive/**/*.jsonl`만 막는다(`.gitignore:19-20`). `tests/local/`, `*.bak-*`, `runs/`도 추가 검토한다.
- 이유: 실제 데이터는 계속 변하고 민감하다. 합성 fixture는 작고 안전하며, 로컬 golden은 성능·마이그레이션 검증에만 쓴다.

---

### 3.4 CI·품질 게이트·지원 환경 — P0

**정할 것**
- CI 제공자와 실행 위치(GitHub Actions, 로컬, 둘 다).
- OS·Python 버전 매트릭스.
- 필수 체크와 실패 시 동작.
- 실행 시간·캐시·아티팩트 정책.
- 비밀·네트워크 접근 금지 규칙.

**선택지**
1. 로컬 스크립트만: 빠르지만 "내 Mac에서는 된다"가 된다.
2. GitHub Actions만: 깨끗하지만 오프라인·즉시 피드백이 약하다.
3. **로컬 검사 + GitHub Actions**: 로컬은 빠른 피드백, CI는 Windows/macOS 보증.

**판단 기준**
- 사용자가 실제로 쓰는 OS(Windows 우선, macOS)를 덮는가.
- 5분 안에 끝나는가(비공개 저장소 분당 비용).
- 네트워크·외부 도구 없이 도는가.
- 실패 원인이 로그만으로 파악되는가.

**추천: 3번.**
- 로컬: `scripts/check` (macOS/Linux) + `scripts/check.ps1` (Windows). `compileall` + `pytest -q` + 스키마 검증 + 스킬 lint.
- CI: `.github/workflows/ci.yml`
  - `windows-latest` + `macos-latest`
  - Python `3.9`(최소, `README.md:84`) + `3.13`(최신)
  - `pip` 캐시, `timeout-minutes: 10`
  - `pytest -q -m "not network"` (기본), 네트워크 테스트는 수동/야간
  - 실패 시 `tests/.artifacts/`(로그·생성 HTML) 업로드
- 필수 체크: `tests`, `schema`, `skill-lint`, `compileall`. 커버리지 임계값은 0단계에서 두지 않는다(줄 수 비율은 목적에 맞지 않음). 대신 **명령·전이 커버리지 표**를 리뷰한다.
- 릴리스는 CI green + README 변경 이력 + `plugin.json` 버전 갱신을 조건으로 한다(`README.md:134-141`, `.claude-plugin/plugin.json:3`).
- 이유: PES는 Windows 사용자가 주이고 macOS에서도 개발한다. CI가 한쪽만 보면 경로·인코딩·프로세스 문제를 놓친다. 로컬 검사는 AI 에이전트가 커밋 전에 빠르게 돌리는 용도로도 필요하다.

---

### 3.5 저장소 구조와 모듈 경계 — P0

**정할 것**
- 플러그인 루트를 유지할 것인가, `plugin/`으로 옮길 것인가.
- `web/`, `tests/`, `schemas/`, `adapters/`의 위치와 소유권.
- 생성물(HTML·보고서·스냅샷)과 소스의 경계.
- OpenCode 설정·명령·스킬을 어디에 둘 것인가.

**선택지**
1. **현재 루트 플러그인 유지 + 예약 디렉터리 추가**.
2. 플러그인을 `plugin/`으로 이동하고 루트는 모노레포 루트로.
3. 처음부터 패키지 분리(`packages/core`, `packages/cli`, `web`).

**판단 기준**
- 기존 설치·업데이트 경로를 깨지 않는가(`README.md:107-141`).
- 1·2단계에서 옮기기 쉬운가.
- 에이전트별 설정이 섞이지 않는가.
- 리뷰·테스트가 단순한가.

**추천: 1번.**
- 0단계에서는 **만들기만 하고 이동하지 않는다.**
  ```
  AGENTS.md                 # 개발 규칙(정본)
  CLAUDE.md                 # @AGENTS.md 포인터
  scripts/                  # 코어 CLI·서버 (지금 그대로)
  skills/                   # 워크플로 (중립화 대상)
  adapters/                 # 에이전트별 설정·명령 매핑 (신규, 문서+설정만)
    claude/                 # 기존 commands/agents를 나중에 옮길 자리
    opencode/
    codex/
  templates/                # 렌더 (0단계에서 디자인 변경 금지)
  questions/                # 질문 은행 (데이터)
  schemas/                  # JSON Schema (신규)
  tests/                    # 테스트 (신규)
  docs/plan/{discussion,decisions,spikes}/
  docs/archive/             # 동결
  web/                      # 2단계 예약(지금은 비움)
  ```
- 경계 규칙:
  - `scripts/`는 상태·검증·렌더·서버의 **코어**다. 에이전트별 분기를 넣지 않는다.
  - `skills/`는 "무엇을 왜 하는가"만 쓴다. 도구 이름·모델 이름은 `adapters/`로.
  - `templates/`는 표시만. 상태를 만들지 않는다(`skills/core/SKILL.md:18`).
  - `docs/plan/`은 설계, `docs/archive/`는 동결. 생성물은 커밋하지 않는다.
- 이유: `${CLAUDE_PLUGIN_ROOT}` 기반 경로(`skills/core/SKILL.md:23-25`)와 설치 스크립트가 루트를 가정한다. 지금 옮기면 사용자 설치가 깨지고, 얻는 것이 없다. 1단계에서 테스트가 갖춰진 뒤 옮긴다.

---

### 3.6 `AGENTS.md`와 에이전트별 지침 — P0

**정할 것**
- 정본 파일은 무엇인가(`AGENTS.md` vs `CLAUDE.md` vs 둘 다).
- 어디까지 쓰는가: 개발 규칙만? 런타임 스킬도?
- 에이전트별 차이를 어떻게 표현하는가.
- 지침이 실제로 로드되는지 어떻게 확인하는가.

**선택지**
1. `CLAUDE.md`만: Claude Code는 읽지만 OpenCode/Codex는 놓칠 수 있다.
2. `AGENTS.md`만: OpenCode/Codex는 읽지만 Claude Code가 `CLAUDE.md`를 우선하면 놓칠 수 있다.
3. 둘 다 전체 복제: 당장은 읽히지만 **반드시 갈라진다**.
4. **`AGENTS.md` 정본 + `CLAUDE.md`는 `@AGENTS.md` 포인터** + OpenCode 설정에서 같은 파일을 가리킴.

**판단 기준**
- 새 세션의 에이전트가 5분 안에 개발 환경을 재현하는가.
- 규칙이 한 곳에서만 바뀌는가.
- 런타임 워크플로(`skills/core`)와 개발 규칙이 섞이지 않는가.
- Windows/macOS 명령이 모두 있는가.

**추천: 4번.**
- `AGENTS.md`에 넣을 것:
  1. PES가 무엇인지 1문단 + 디렉터리 지도.
  2. 설치·실행·테스트 명령(오프라인 기본, Windows `py -3` 포함).
  3. 절대 규칙: `~/pes-projects`를 건드리지 않는다, 테스트는 임시 `PES_HOME`을 쓴다, 생성 HTML·`project.json`을 손으로 고치지 않는다, 비밀을 커밋·로그에 남기지 않는다, 사용자 문구는 한국어.
  4. 변경 규칙: 버그는 재현 테스트 먼저, 동작 보존 리팩터는 별도 커밋, 버전·체인지로그 갱신.
  5. 결정 기록 위치(`docs/plan/decisions`)와 "정해진 것" 색인.
  6. 방식 A/B 어댑터 규칙과 금지 토큰(모델명·도구명을 스킬에 직접 쓰지 않는다).
  7. Windows/macOS 차이, OneDrive 주의.
  8. "런타임 워크플로는 `skills/core`를 읽는다. 이 파일은 개발 규칙이다."
- `CLAUDE.md`는 한 줄: `@AGENTS.md` (지원 여부 확인). OpenCode는 `AGENTS.md` 자동 탐색을 우선하고, V2 설정의 `instructions` 필드로 명시하는 방법도 스파이크에서 확인한다.
- 확인 방법: 새 Claude Code 세션과 새 OpenCode 세션에 "테스트 어떻게 돌려?"를 물어 **같은 명령**이 나오는지 본다. 이건 문서 리뷰가 아니라 수동 체크리스트로 남긴다.
- 이유: 지금 `skills/core`는 런타임 워크플로이고(`skills/core/SKILL.md:1-25`), README는 사용자 문서다(`README.md:1-16`). **개발자(사람·AI)를 위한 단일 지침이 없다.** 복제는 유지비가 크고, OpenCode/Claude/Codex가 각자 다른 파일을 우선하므로 정본+포인터가 안전하다.

---

### 3.7 개발 규칙·의사결정 기록·릴리스 — P0

**정할 것**
- 커밋 메시지·버전·체인지로그 규칙.
- ADR(Architecture Decision Record)를 쓸 것인가, 어디에 둘 것인가.
- 설계 문서 리뷰 절차.
- 롤백·백업 절차.
- "변경 완료"의 정의.

**선택지**
1. 지금처럼 가볍게(커밋 + README 변경 이력).
2. **가벼운 ADR + 기존 체인지로그**.
3. Conventional Commits·SemVer·PR 템플릿까지 갖춘 무거운 체계.

**판단 기준**
- 1인 유지보수에 과하지 않은가.
- 되돌릴 수 없는 결정(스키마·API·저장소·인증)이 기록되는가.
- 사용자에게 보이는 변경이 빠짐없이 설명되는가.
- AI 에이전트가 같은 규칙을 따를 수 있는가.

**추천: 2번.**
- 커밋: `0.x.y: 요약` (현재 관행, `README.md:138`).
- 버전: 사용자에게 보이는 변경마다 `.claude-plugin/plugin.json` 버전 + README 변경 이력(`README.md:597+`).
- ADR: `docs/plan/decisions/NNN-제목.md` (상황·선택지·결정·결과·되돌리는 방법). 최소 다음 결정은 ADR로 남긴다.
  - 스키마 v1과 마이그레이션 정책
  - 에이전트 API 경계(HTTP/MCP/파일)
  - research-loop 계약
  - OpenCode 통합 방식(A1/A2/A3)
  - 인증·토큰 최소선
  - hwpx 유예와 인터페이스
- `docs/plan/decisions/README.md`를 **"정해진 것"의 살아 있는 색인**으로 쓴다(브리프 `00-brief.md:29`의 6번).
- 리뷰: 설계 문서는 다른 AI(Claude/Codex/OpenCode) 1개 + 사용자 확인. 코드는 테스트가 리뷰의 상당 부분을 대신한다.
- 롤백: `v0.15.6` 태그를 기준점으로 두고, 데이터 마이그레이션 전 `project.json`·`library.json`을 `*.bak-<시각>`으로 백업한다. 플러그인은 이전 태그 재설치로 되돌린다.
- "변경 완료": 테스트 green + Windows/macOS 확인 + 체인지로그 + (스키마/API 변경이면) ADR + 사용자 문구 확인.
- 이유: 지금 관행과 크게 다르지 않아 지킬 가능성이 높고, 되돌릴 수 없는 결정만 무겁게 기록하면 충분하다. Conventional Commits는 1인 저장소에서 비용 대비 효익이 낮다.

---

### 3.8 의존성·런타임 정책 — P1

**정할 것**
- 코어 런타임을 stdlib-only로 유지할 것인가.
- 테스트·개발 의존성을 어디에 선언할 것인가.
- Python 최소 버전을 올릴 것인가.
- 2단계 웹 프레임워크·OpenCode 클라이언트를 어디에 둘 것인가.

**현재**
- `pes.py`·`serve.py`는 표준 라이브러리만 쓴다(`scripts/pes.py:46-55`, `scripts/serve.py:14-20`).
- `setup.py`는 `subprocess`로 npm·winget·brew를 호출한다(`scripts/setup.py:21`, `:205-237`).
- 최소 Python 3.9(`README.md:84`, `scripts/pes.py:1402`).

**선택지**
1. 코어 stdlib-only 유지, 개발만 `pytest`.
2. 작은 런타임 의존성 허용(예: `jsonschema`, `httpx`).
3. 지금 웹 프레임워크 도입.

**판단 기준**
- Windows 설치 마찰이 늘지 않는가.
- 오프라인·기관망에서 동작하는가.
- 공급망·보안 위험이 통제되는가.
- 2단계에서 교체 비용이 큰가.

**추천: 1번 + 개발 의존성만.**
- 코어는 1단계까지 stdlib-only. JSON Schema 검증은 테스트에서만 `jsonschema`를 쓰거나, 최소 검증기는 직접 작성한다.
- 개발 의존성은 `requirements-dev.txt` 또는 `pyproject.toml`의 optional-dependencies에 둔다(`pytest`, 선택 `ruff`).
- 2단계 웹은 `web/` 안에서만 프레임워크를 쓴다. 코어가 웹 프레임워크를 import하지 않게 한다.
- OpenCode 연동은 **HTTP**로 한다. Node/Python SDK 의존성을 코어에 넣지 않는다(언어 결합·버전 결합 방지).
- Python 최소 버전: 0단계는 3.9 유지(사용자 환경 보호), 1단계에서 3.11 상향 여부를 결정한다. CI는 3.9와 3.13을 함께 본다.
- 이유: PES의 강점은 "설치가 단순하고 로컬에서 잘 돈다"이다. 저가 모델·웹으로 확장한다고 코어까지 무거워지면 사용자 이탈이 먼저 온다.

---

### 3.9 `project.json` 스키마 동결·버전·마이그레이션 — P0

**정할 것**
- 스키마 버전 필드와 읽기/쓰기 규칙.
- 필드 소유권과 타입, 빈 값 규칙(`""` vs `null` vs `[]`).
- ID 체계(프로젝트·단계·항목·질문·run).
- 시간 형식(로컬 문자열 vs ISO 8601/UTC).
- 알 수 없는 필드의 보존/거부.
- 마이그레이션·백업·검증·성능 예산.

**현재**
- `"pes": 1`을 쓰지만 읽지 않는다(`scripts/pes.py:206`).
- `load()`가 빠진 필드를 조용히 채운다(`:96-114`).
- 항목 스키마는 문서(prose)로만 있다(`skills/core/SKILL.md:74-84`).
- 실제 파일이 1.76MB까지 커진다(실측).
- `doctor`가 중복 id·단계 순서·스냅샷 누락·충돌 사본을 검사한다(`scripts/pes.py:1531-1560`) — **이 검사들이 사실상 스키마 불변식**이다.

**선택지**
1. **현재 모양을 v1로 동결**하고 JSON Schema + characterization + 마이그레이션 규칙을 만든다.
2. 지금 새 스키마로 재설계한다.
3. 스키마는 두지 않고 2단계 DB에서 한 번에 정의한다.

**판단 기준**
- 1단계 DB 매핑에 필요한 정보가 빠짐없이 드러나는가.
- 기존 프로젝트를 잃지 않고 이전할 수 있는가.
- 검증이 너무 엄격해 사용자를 막지 않는가.
- 2단계에서 다시 갈아엎지 않아도 되는가.

**추천: 1번.**
- `schema_version: 1`을 추가하고(`pes`는 호환용으로 유지), 읽을 때 확인한다. 모르는 상위 버전은 **읽기 전용**으로 열고 안내한다.
- `schemas/project-v1.json`, `question-v1.json`, `result-v1.json`, `feedback-v1.json`, `event-v1.json`을 만든다. JSON Schema draft 2020-12.
- 프로젝트 ID: **불변 `project_id`(ULID/UUID)** 를 추가하고 `slug`는 표시·URL 별칭으로 둔다. 현재 slug는 폴더명이라 이름 변경·충돌에 취약하다(`scripts/pes.py:206`).
- 시간: 저장은 ISO 8601 + 타임존(UTC), 표시는 로컬. 현재 `now()`는 로컬 문자열이다(`:181-182`). 0단계에서는 **표시를 바꾸지 않고** 저장 필드만 병행 추가한다.
- ID: 단계별 `max+1`(현재 암묵적), 재사용 금지, 삭제는 `status=removed`(이미 그렇게 동작). 새 ID는 `project_id + stage + seq`로 확장 가능하게 설계.
- 상태 기계를 명시한다.
  - `pending → asking` (ask-prep/ask)
  - `asking → active` (round-start/첫 답)
  - `active → active` (라운드)
  - `active → approved` (approve)
  - `approved → active` (reopen, 이후 단계는 `stale=true`)
  - 위 외의 전이는 거부하고 `doctor`가 알린다.
- 검증: 0단계에서는 **경고**(doctor) 중심, 2단계에서 **쓰기 거부**로 강화한다. 현재의 관대한 `load()` 동작을 characterization으로 먼저 고정한 뒤 바꾼다.
- 마이그레이션: `migrate(p, from, to)` 체인, idempotent, `--dry-run`, 자동 백업, 알 수 없는 필드 보존.
- 성능 예산: 2MB 기준 `load` < 100ms, `save` < 100ms, `render` < 500ms. 0단계에서 측정해 기록하고, 초과하면 1단계에서 단계별 파일 분할/DB를 검토한다.
- `library.json`의 지위를 명확히 한다: **큰 첨부의 외부 저장소**이며 `project.json`에서 분리된다(`scripts/pes.py:111-113`, `:147-158`). 2단계에서는 R2/파일 저장소로 대체 가능하게 경계를 둔다.
- 이유: 1단계 DB 설계의 입력이 필요하고, 지금이 **현재 동작을 가장 잘 아는 시점**이다. 새 스키마를 지금 설계하면 테스트 없이 두 가지(동작·스키마)를 동시에 바꾸게 된다.

**확인 필요**
- `project.json`의 `stages.<stage>.qa`, `history`, `carry_over`, `review_log` 등 문서에 없는 필드가 실제로 어떻게 쓰이는지 목록화해야 한다. 스키마는 코드+실데이터+`doctor`를 함께 보고 만든다.

---

### 3.10 사람 상호작용 계약(질문·답·첨언) — P0

**정할 것**
- 질문 객체의 필드와 타입, 조건부 표시, 기본값, 중요도.
- 답 객체의 필드(값·질문별 의견·건너뜀·채널·시각·응답자).
- 질문 출처(은행/점검/에이전트)와 답 채널(웹/채팅/API)의 구분.
- 첨언(인용 위치)을 위한 예약 필드.
- 하위 호환과 검증 규칙.

**현재**
- 질문 은행은 `id·label·type·options·required·_when·placeholder` 등을 쓴다(`questions/plan.json:1-35`).
- 점검 질문은 `show_if`, `gap`, `recommended`를 쓴다(`skills/core/SKILL.md:181-189`).
- 답은 `answers` 딕셔너리 + `text`로 온다(`scripts/serve.py:131-137`).
- 질문별 `__other` 관례가 있다(`skills/core/SKILL.md:195`).
- 브리프는 "지금은 맨 아래 덧붙일 말 칸 하나뿐"이라고 적지만(`00-brief.md:20`), 코드에는 질문별 `other`가 있다(`skills/core/SKILL.md:195`, 커밋 `af285e2`). **실제 화면을 먼저 감사해야 한다.**

**선택지**
1. 현재 구조를 v0로 동결하고 **추가 필드만** 허용한다.
2. 3단계 UX를 지금 설계해 스키마를 새로 만든다.
3. 3단계까지 미룬다.

**판단 기준**
- 방식 A/B가 같은 질문을 만들고 같은 답을 읽을 수 있는가.
- 기존 `feedback/*.json`을 계속 읽을 수 있는가.
- 3단계의 "질문별 의견·첨언"을 나중에 **깨지 않고** 얹을 수 있는가.
- 웹 폼과 API가 같은 검증을 쓰는가.

**추천: 1번.**
- `Question` v0:
  ```json
  {"id":"...", "label":"...", "type":"single|multi|text|number|scale|file",
   "required":true, "options":[{"value":"...","label":"...","desc":"...","recommended":true}],
   "default":null, "importance":"high|normal|low", "other":true, "comment":true,
   "show_if":{"id":"...","in":["..."]}, "help":"...", "origin":"bank|review|agent"}
  ```
- `Answer` v0:
  ```json
  {"question_id":"...", "value":..., "comment":"...", "skipped":false,
   "source":"web|chat|api", "answered_at":"ISO8601", "answered_by":"..."}
  ```
- 기존 `__other` 접미사는 읽기 호환으로 유지하고, 새 API는 `comment` 필드를 쓴다. `__comment`는 나중에.
- `anchor` 예약: `{"quote":"...", "start":123, "end":180, "section_id":"..."}`. 0단계에서는 스키마에 넣지 않고 **문서에만** 적는다(3단계 구현).
- 검증: 없는 질문 id, 중복 답, 필수 누락, 선택지에 없는 값, 조건 불충족 답을 거부/경고한다.
- 질문 출처와 답 채널을 기록해 "누가 왜 물었는지" 추적한다. 방식 A가 만든 질문과 방식 B(사람이 채팅으로 전달)가 만든 질문이 같은 테이블에 쌓여야 한다.
- 이유: 두 방식의 접점이 바로 질문/답이다. 여기가 갈라지면 "같은 데이터 모델"이 깨진다. 3단계 UX는 필드를 **추가**하는 방식으로 얹을 수 있다.

**확인 필요**
- 실제 대시보드/질문 폼에서 질문별 의견이 가능한지, 브리프의 "덧붙일 말 하나"가 어느 화면을 말하는지. `templates/_questions.html`과 `templates/dashboard.html`을 열어 확인하고, 문서와 코드가 다르면 **코드를 사실로** 기록한다.

---

### 3.11 에이전트 API 계약(A/B 공통) — P0

**정할 것**
- 자원 모델(project, stage, round, run, item, question, answer, event).
- 엔드포인트와 메서드, 요청·응답 스키마.
- 인증·인가(에이전트 토큰, 프로젝트 범위).
- 멱등성·재시도·오류 형식.
- 스트리밍(SSE)과 long-poll.
- "에이전트는 상태를 직접 쓰지 않는다"는 규칙의 구체적 표현.

**현재**
- 통합은 CLI + 파일이다: `feedback/*.json`, `rounds/*.json`, `merge`(`skills/core/SKILL.md:20-49`, `:158-166`).
- 스킬이 `project.json`을 직접 편집한다(`skills/core/SKILL.md:62-84`).
- `digest`/`show`로 토큰을 아낀다(`:86-92`).

**초안(0단계 문서용, 구현 아님)**
| 목적 | 엔드포인트(예) | 비고 |
|---|---|---|
| 작업 받기 | `POST /api/v1/projects/{id}/runs` | `{stage, round, items[], agent}` → `{run_id, lease, context_url}` |
| 컨텍스트 | `GET /api/v1/runs/{id}/context` | 기본은 digest. 항목 상세는 `?items=1,2&fields=...` |
| 결과 제출 | `POST /api/v1/runs/{id}/results` | `{item_id, result, idempotency_key}`. 스키마 검증 실패는 422 |
| 질문 | `POST /api/v1/runs/{id}/questions` | 질문 명세 v0. 비동기 |
| 답 대기 | `GET /api/v1/runs/{id}/answers?wait=30` | long-poll. 또는 SSE |
| 진행/도구/비용 | `POST /api/v1/runs/{id}/events` | `{type, payload, ts}` |
| 완료 | `POST /api/v1/runs/{id}/complete` | `{status, summary}` |
| 사람 피드백 | `POST /api/v1/projects/{id}/feedback` | 기존 `POST /feedback` 대체 |
| 대시보드 스트림 | `GET /api/v1/projects/{id}/events?since=` | SSE |

**규칙**
- `/v1` 고정, 하위 호환은 필드 추가만.
- 쓰기에는 `Idempotency-Key` 필수. 같은 키의 재시도는 같은 결과를 돌려준다.
- 상태 변경에는 `If-Match: <revision>` (낙관적 동시성). 409면 최신 컨텍스트를 다시 받는다.
- 오류는 `{"error":{"code":"...","message":"...","details":...}}`로 통일. 사용자 문구는 한국어, 코드는 영어.
- 본문 크기 제한(현재 256KB, `scripts/serve.py:22`)을 결과·첨부에 맞게 확장하되, 큰 파일은 별도 업로드로 분리.
- **에이전트는 `project.json`/DB를 직접 쓰지 않는다.** 모든 쓰기는 API(또는 같은 서비스 계층을 호출하는 CLI)로만. 상태 전이·검증·감사는 PES가 한다.
- CLI와 API는 **같은 서비스 함수**를 호출한다. 0단계에서는 이 원칙만 정하고, 2단계에서 `pes` CLI를 API의 얇은 클라이언트로 바꾼다.
- 컨텍스트는 기본적으로 digest다. 전체 `project.json`을 API로 내보내지 않는다(`skills/core/SKILL.md:86-92`와 같은 원칙).

**선택지**
1. 파일 프로토콜 유지(지금 방식). 단순하지만 검증·동시성·원격이 약하다.
2. **HTTP/JSON + SSE를 정본**으로 하고, MCP·CLI·파일은 어댑터로.
3. MCP만 정본으로. 웹 브라우저·비-MCP 에이전트가 막힌다.

**판단 기준**
- 웹·방식 A·방식 B가 같은 계약을 쓸 수 있는가.
- 검증·동시성·감사가 가능한가.
- 기존 프로젝트와 오프라인 사용을 깨지 않는가.
- 구현·유지 비용이 감당 가능한가.

**추천: 2번.**
- 이유: 5단계 웹은 HTTP가 필수이고, 방식 A(OpenCode)도 HTTP다. MCP는 방식 B의 편의 인터페이스로 얹는다. 파일은 기존 프로젝트 호환용으로만 유지하고 deprecated 표시한다.
- 0단계 산출물: `docs/plan/api-v0.md` + `schemas/api-v0/*.json` + **가짜 어댑터 계약 테스트**. 실제 서버 구현은 2단계.

**가장 중요한 선행 작업**
- `skills/core/SKILL.md:62-84`의 "직접 편집" 지시를 **전부 목록화**하고, 각각을 어떤 API/명령으로 대체할지 표를 만든다. 이 표가 없으면 2단계에서 스킬이 API를 우회해 파일을 쓰게 된다.

---

### 3.12 동시성·소유권·lease — P0

**정할 것**
- 한 프로젝트에 동시에 쓸 수 있는 주체 수(권장: 1명의 쓰기 소유자 + 다수 읽기).
- lease 획득·갱신·만료·탈취 규칙.
- 낙관적 동시성(revision)과 충돌 해결.
- 사람 답변과 에이전트 작업이 동시에 일어날 때의 순서.
- OneDrive·클라우드 동기화와의 관계.

**현재**
- `.pes-lock` 파일, `PES_OWNER`, 2시간 TTL, `save()`마다 검사(`scripts/pes.py:117-144`).
- `--force`로 탈취(`:1677-1699`).
- 저장은 전체 파일 교체(`:147-158`). 마지막 쓰기가 이긴다.
- OneDrive는 "한 번에 한 컴퓨터" 규칙과 충돌 사본 감지(`README.md:503-513`, `scripts/pes.py:1531-1535`).

**선택지**
1. 현재 파일 잠금 유지(로컬 단일 사용자).
2. **lease + revision + fence**로 확장(2단계 구현, 0단계 의미론 확정).
3. DB 트랜잭션에 전부 맡긴다.

**판단 기준**
- 두 에이전트(또는 사람+에이전트)가 동시에 써도 잃어버리는 변경이 없는가.
- 프로세스가 죽었을 때 자동 복구되는가.
- 사용자에게 "누가 쓰고 있는지" 보이는가.
- OneDrive 같은 파일 동기화와 모순되지 않는가.

**추천: 2번.**
- 0단계에서 의미론을 확정하고, 2단계에서 구현한다.
  - `lease {lease_id, run_id, owner, acquired_at, heartbeat_at, expires_at, fence}`
  - heartbeat 30초, TTL 5분(현재 2시간은 너무 김). 만료 후 탈취는 감사 이벤트를 남긴다.
  - `fence`는 단조 증가. 오래된 writer의 쓰기는 거부.
  - `revision` 정수, 쓰기마다 `If-Match`. 충돌 시 409 + 최신 컨텍스트.
  - 결과·피드백은 `Idempotency-Key`로 중복 제거.
- 사람 답변은 **append-only 이벤트**로 취급한다. 에이전트가 작업 중이어도 답은 쌓이고, 에이전트는 다음 poll에서 받는다. 답 때문에 상태 전체를 덮어쓰지 않는다.
- OneDrive: PES는 **동시 다중 쓰기를 지원하지 않는다**고 명시한다. 충돌 사본은 `doctor`가 감지하고, 자동 병합하지 않는다. 웹/DB 이후에는 클라우드 동기화 폴더를 저장소로 쓰지 않는 방향을 검토한다.
- 이유: 방식 A/B를 동시에 개발하면 "TUI에서 사람이 답하는 동안 PES 내부 에이전트가 같은 프로젝트를 쓰는" 상황이 반드시 생긴다. 전체 파일 저장으로는 lost update가 난다. 이건 기능이 아니라 **정합성** 문제다.

**0단계 테스트**
- 잠금 만료 후 다른 owner가 획득, `--force` 동작, `PES_OWNER` 없음 경고, 동시 저장 시뮬레이션(현재는 lost update가 날 수 있음을 문서화).

---

### 3.13 보안·프라이버시 기준선 — P0

**정할 것**
- 자산·신뢰 경계·위협 모델.
- 로컬/원격 읽기·쓰기 권한.
- 에이전트 토큰의 범위·저장·회전.
- 비밀·개인정보의 로그·프롬프트·이벤트 포함 규칙.
- 에이전트 도구 실행 권한(파일·셸·네트워크).

**현재**
- 127.0.0.1 바인드(`scripts/serve.py:154`), Origin 허용목록(`:30`, `:120-121`), 256KB 제한(`:22`, `:123`), slug 정규식(`:24`), 디렉터리 목록 금지(`:80-82`).
- Tailscale 등 신뢰 Origin 허용(`:33-38`), `who` 헤더 기록(`:148`).
- 인증 없음. GET은 홈 아래 파일을 그대로 서빙한다.
- `.env`·`*.pem`은 gitignore(`.gitignore:14-17`), setup은 키를 마스킹(`scripts/setup.py:43`).

**선택지**
1. 로컬 신뢰 모델 유지(지금).
2. **0단계 위협 모델 + 경로/Origin/크기 테스트 + 토큰 설계**, 구현은 2단계.
3. 지금 전체 인증(OAuth 등) 도입.

**판단 기준**
- 비공개 연구·개인정보가 원격에 노출되지 않는가.
- 에이전트가 실수로 프로젝트 밖을 쓰지 않는가.
- 토큰·API 키가 로그·프롬프트·git에 남지 않는가.
- 5단계 웹 인증으로 자연스럽게 확장되는가.

**추천: 2번.**
- 위협 모델 표를 만든다.
  | 자산 | 위협 | 0단계 통제 |
  |---|---|---|
  | 비공개 연구·보고서 | 원격 무단 읽기, 경로 탈출 | loopback 기본, 원격 읽기 토큰(설계), 경로 정규화 테스트 |
  | 답변·승인 | Origin 위조, CSRF | Origin 허용목록 + 쓰기 토큰(설계) |
  | API 키 | 로그·프롬프트 유출 | 마스킹, 이벤트 redaction, gitignore |
  | 에이전트 도구 | 프로젝트 밖 쓰기·셸 | cwd 제한, 권한 정책, 감사 이벤트 |
  | 동기화 폴더 | 충돌 사본·유출 | 단일 writer, `doctor` 감지 |
- 테스트: `../`·인코딩된 경로·심볼릭 링크, 잘못된 Origin, 큰 본문, 알 수 없는 kind, 토큰 재사용.
- 토큰: `~/.pes/agents.json`에 프로젝트 범위·만료·해시 저장. URL에 넣지 않는다. 로그에 원문을 남기지 않는다.
- 에이전트 권한: 읽기·검색은 자동, 쓰기·셸·네트워크는 정책에 따라 사람 확인. 방식 A의 OpenCode permission API와 연결한다.
- 이유: 이미 Tailscale 원격 답변을 허용했고(`README.md:343-360`), 에이전트 API는 토큰을 전제로 한다. API 모양이 굳은 뒤 인증을 끼워 넣는 비용이 더 크다.

**확인 필요**
- 원격 GET으로 프로젝트 파일 전체가 읽히는 것이 의도인지. Tailscale 사용 시 이 점을 명시해야 한다.

---

### 3.14 방식 A: OpenCode 서버 통합 스파이크 — P0

**정할 것**
- 실행 방식: CLI one-shot vs HTTP 서버 vs SDK 임베드.
- 세션 단위(프로젝트/단계/라운드/항목)와 컨텍스트 전달.
- 모델 선택과 단계별 정책.
- 권한(도구 실행) 처리.
- 실패·재시도·취소·비용 상한.
- OpenCode 버전 고정과 API 변경 대응.

**선택지**
- A1. `opencode run` CLI를 작업마다 실행. 단순하지만 스트리밍·권한·세션 재개가 약하다.
- A2. **`opencode serve` + HTTP API**. 세션·이벤트·권한·중단·사용량을 쓸 수 있다.
- A3. OpenCode SDK를 PES에 임베드. Python 코어와 언어가 다르고 결합이 커진다.

**판단 기준**
- PES(Python)에서 붙이기 쉬운가.
- 사람이 답하는 동안 진행 상황·권한 요청을 보여 줄 수 있는가.
- 세션을 재개·취소할 수 있는가.
- 비용·품질을 측정할 수 있는가.

**추천: A2 (A1은 스모크 테스트·폴백).**
- OpenCode V2 API에서 확인한 것(2026-11-04, <https://opencode.ai/v2/docs/api>):
  - `POST /api/session` 세션 생성, `POST /api/session/{id}/prompt` 메시지, `GET /api/event` 이벤트 스트림.
  - `POST /api/session/{id}/interrupt` 중단, `POST /api/session/{id}/model` 모델 전환.
  - `GET/POST /api/permission/...` 권한 요청·응답, `POST /api/session/{id}/form` + `/reply` 폼.
  - `GET /api/model`, `GET /api/experimental/usage/limits` (Go 사용량).
- **PES 질문은 PES의 정본**으로 둔다. OpenCode의 form/permission은 **실행 수준**이며, 필요하면 PES 대시보드에 프록시하되 연구 질문과 섞지 않는다. 두 개의 질문 저장소를 만들면 안 된다.
- 스파이크(각 1회 이상, 가능하면 3회 반복):
  1. `opencode serve` 기동, `/api/info`·`/api/model` 확인, Go 모델 ID·인증 확인.
  2. 임시 프로젝트에서 세션 생성 → "`pes status`를 실행하고 결과를 `result.json`에 써라" → 파일 생성 확인, 지연·토큰 측정.
  3. 사람 질문 1개: PES API로 질문을 만들고, 에이전트가 답을 기다리는 흐름(또는 OpenCode form → PES 프록시) 확인.
  4. 권한: 파일 쓰기/셸 실행 요청을 사람이 승인/거부하고 계속되는지.
  5. 중단·재개: `interrupt` 후 세션 재사용, 서버 재시작 후 세션 복구.
  6. 비용·한도: `/usage/limits`, 동시 세션 수, 컨텍스트 초과 동작.
- **품질 기준(제안)**: 3개 과제(파일 읽기, CLI 실행, JSON 스키마 준수)를 10회 시도해 **8/10 성공**, 항목당 2분 이내, 라운드당 비용 상한 이내. 미달이면 A의 범위를 "조사 추출·요약"으로 줄이거나 단계별 상위 모델을 쓴다.
- 모델 정책: 스킬에는 모델명을 쓰지 않고 `strong|cheap|vision` 역할만 쓴다. 어댑터가 Go/Claude/Codex 모델로 매핑한다. 현재 `skills/core/SKILL.md:123`의 `model opus`, research 스킬의 `sonnet/opus`는 이 정책으로 바꾼다.
- 권한 정책 파일(예: `.pes/agent-policy.json`): 읽기·검색 허용, 쓰기는 프로젝트 안만, 셸은 허용 목록, 네트워크는 연구 도구만, 그 외는 사람 확인.
- 버전: OpenCode 버전을 고정하고 `/openapi.json`으로 기능 감지. API 변경은 어댑터 안에서 흡수한다.
- 이유: PES가 에이전트 루프·도구 실행·세션을 다시 만들 이유가 없다. OpenCode가 이미 제공하는 것을 감싸고, PES는 상태·질문·기록에 집중하는 것이 역할 분담에 맞다.

**주의**
- OpenCode Go의 약관·데이터 보관·모델 학습 정책을 확인해야 한다. 비공개 연구 데이터를 저가 구독 모델에 보내도 되는지 사용자 확인이 필요하다.
- Windows에서 서버 프로세스 분리·종료·로그 위치를 스파이크에 포함한다.

---

### 3.15 방식 B: 외부 에이전트 연결 — P0

**정할 것**
- 연결 방식: MCP vs HTTP+CLI vs 파일.
- 도구 표면(에이전트가 볼 도구 이름·인자).
- 신원·토큰·프로젝트 범위.
- 사람 답변 대기 방식(블로킹/비동기).
- TUI가 닫혔을 때의 lease 만료·복구.
- Claude Code/Codex/OpenCode TUI 각각의 차이.

**선택지**
- B1. **MCP 서버(stdio)**: 도구 발견·구조화된 인자·권한 표시가 좋다.
- B2. HTTP API + `pes` CLI: 어디서나 가능하지만 에이전트가 셸·curl을 써야 한다.
- B3. 파일 프로토콜(현재): 가장 호환적이지만 검증·동시성·원격이 약하다.

**판단 기준**
- TUI 에이전트가 적은 프롬프트로 정확히 쓸 수 있는가.
- 사람이 답하는 동안 블로킹이 자연스러운가.
- 웹/비-MCP 에이전트도 같은 데이터를 쓸 수 있는가.
- 실패·재시도·감사가 가능한가.

**추천: HTTP 계약을 정본으로, B1 MCP를 방식 B의 기본 인터페이스로, B3은 호환용.**
- MCP 도구(안):
  - `pes_context(project, stage, round, items?)` → digest
  - `pes_claim(project, stage, items[])` → run_id + lease
  - `pes_submit(run_id, item_id, result, idempotency_key)` → 검증 결과
  - `pes_ask(run_id, questions[])` → question_ids
  - `pes_wait(run_id, timeout_s)` → answers/events
  - `pes_complete(run_id, status, summary)`
- `pes` CLI는 같은 서비스 계층의 얇은 클라이언트로 유지한다. 기존 `/pes:run` 명령은 그대로 두고, 내부만 API/MCP로 바꾼다.
- 파일 프로토콜은 2단계까지 읽기 호환. 새 프로젝트는 API/MCP를 기본으로 하고, 파일은 "오프라인/비상" 모드로 남긴다.
- 신원: `PES_OWNER`(세션 ID)는 유지하되, API 시대에는 프로젝트 범위 토큰 + `agent_name`을 쓴다. TUI가 닫히면 heartbeat가 끊겨 lease가 만료된다.
- 스파이크: Claude Code와 OpenCode TUI에서 각각 **한 라운드**(컨텍스트 받기 → 결과 제출 → 질문 1개 → 답 받기 → 완료)를 실제로 돌린다. 설정 단계 수와 실패 지점을 기록한다.
- 이유: TUI 에이전트는 MCP 도구를 가장 자연스럽게 쓴다. 동시에 웹·방식 A는 HTTP가 필요하므로, MCP를 정본으로 삼으면 안 되고 **HTTP 위의 어댑터**로 두어야 한다.

**주의**
- 각 도구의 MCP 지원·권한 UI·긴 대기(long-poll) 동작이 다르다. 스파이크에서 확인한다.
- 현재 `agents/*.md`는 Claude 서브에이전트 형식이다. Codex/OpenCode에는 같은 역할을 다른 방식으로 제공해야 한다(스킬/명령/프롬프트).

---

### 3.16 스킬 중립화와 도구 어댑터 — P0

**정할 것**
- 스킬에서 무엇을 중립화하고, 무엇을 어댑터에 둘 것인가.
- 서브에이전트·모델·도구·질문·렌더의 공통 어휘.
- 어댑터별 파일 위치와 로딩 방식.
- 금지 토큰 lint와 파일럿 범위.

**현재 결합**
| Claude 전용 | 위치 | 중립 대체 |
|---|---|---|
| `AskUserQuestion` | `skills/core/SKILL.md:16` | `ask_human(spec)` |
| `CLAUDE_PLUGIN_ROOT` | `:23` | `pes_root` / 어댑터가 주입 |
| `Agent`, `model opus` | `:123` | `spawn_worker(role, model_policy)` |
| `anthropic-skills:hwpx-uri` | `:154` | `report_format("hwpx")` |
| `pes:researcher` 등 에이전트 이름 | `agents/*.md` | 역할 이름 + 어댑터 매핑 |
| `PES_OWNER` 세션 ID | `:109` | 토큰/lease (호환 유지) |

**선택지**
1. 지금 스킬을 그대로 두고 에이전트별로 복제한다.
2. **워크플로 스킬(중립) + 어댑터 노트(에이전트별)** 로 나눈다.
3. 전부 다시 쓴다.

**판단 기준**
- 방식 A/B가 같은 워크플로를 따르는가.
- 스킬 수정이 한 곳에서 끝나는가.
- 에이전트별 차이를 숨기지 않고 드러내는가.
- 0단계에서 감당 가능한 범위인가.

**추천: 2번, core + plan 파일럿.**
- `skills/core/SKILL.md`와 `skills/plan/SKILL.md`만 중립 어휘로 바꾸고, 나머지는 2단계에서 옮긴다. 한 번에 다 바꾸면 검증할 수 없다.
- `docs/plan/agent-adapters.md`에 어휘 표를 만든다.
  - `ask_human` → Claude: 폼/AskUserQuestion, OpenCode: PES API, Codex: API/CLI.
  - `spawn_worker` → Claude: Agent, OpenCode: session/prompt, Codex: subagent.
  - `browse` → ego-browser, `run_cli` → 셸, `render` → `pes render`.
  - `model_policy` → `strong|cheap|vision` → 각 제공자 모델.
- lint: `skills/`에서 `opus`, `sonnet`, `CLAUDE_PLUGIN_ROOT`, `AskUserQuestion`, `anthropic-skills` 같은 토큰을 찾고, `adapters/` 밖이면 실패. 예외 목록은 ADR로 관리.
- 이유: 지금 스킬은 Claude 플러그인에 최적화되어 있고, 방식 A/B를 동시에 지원하려면 **워크플로의 단일 소스**가 필요하다. 복제는 반드시 갈라진다.

---

### 3.17 research-loop 저장소·가져오기 계약 — P0

여기서 "저장소"는 두 뜻으로 읽힌다. 둘 다 정해야 한다.
1. **저장소(repository) 관계**: research-loop 코드를 PES 저장소에 넣을 것인가.
2. **저장소(storage) 관계**: research-loop의 `state.json`·`shots`를 PES가 어떻게 보관할 것인가.

**정할 것**
- 코드의 소유·릴리스 관계(밖에 둘지, 합칠지).
- `state.json` 계약 필드와 버전 확인 방법.
- `shots`·첨부의 저장 위치와 수명(일방향 복사인지 동기화인지).
- 가져오기 실패·불일치 시 사용자 안내.

**현재**
- research-loop 스킬은 `~/.claude/skills/research-loop/`에 있고, 실행 상태는 작업 폴더의 `research/<slug>/state.json`에 둔다. PES는 그 파일을 직접 읽는다.
- `pes init --import <폴더>`가 `<폴더>/state.json`을 읽고 `shots/`를 복사한다(`scripts/pes.py:219-239`).
- `items`의 `status=removed`를 제외하고, `shots` 경로를 `library/`로 바꾼다(`:230-236`).
- `library`는 `project.json`에서 분리되어 `library.json`에 저장된다(`:147-158`).
- 계약 필드(`topic`, `round`, `settings`, `items`, `suggestions`, `warnings`)가 문서화되어 있지 않다.

**선택지**
1. research-loop을 PES 저장소에 vendoring.
2. **읽기 전용 계약 + fixture**로만 유지(코드는 밖).
3. 가져오기 기능을 없앤다.

**판단 기준**
- 기존 사용자 프로젝트를 잃지 않는가.
- research-loop이 바뀌어도 PES가 조용히 깨지지 않는가.
- 두 저장소의 릴리스 주기를 묶지 않는가.
- 테스트가 가능한가.

**추천: 2번.**
- `docs/plan/research-loop-contract.md`에 v1 계약을 적는다.
  - 필수: `topic`, `round`, `items[]`(`id`, `title`, `summary`, `details`, `sources`, `stats`, `shots`, `confidence`, `conflicts`, `status`), `settings`, `suggestions`, `warnings`.
  - 선택: `state_version`. 없으면 v1로 간주하고 경고.
  - `status=removed`는 가져오지 않는다(현재 동작).
  - 알 수 없는 필드는 보존한다(현재 `dict(it)`가 보존).
  - `shots`는 `library/shots/`로 복사하고 경로를 재작성한다.
- `tests/fixtures/research-loop-v1/`에 `state.json` + `shots/`를 두고, 가져오기 결과를 고정한다. `state_version`이 다르면 명확한 오류와 안내를 낸다.
- **일방향 복사**임을 명시한다. 가져온 뒤 research-loop과 동기화하지 않는다. `library`는 "가져온 시점의 스냅샷"이다.
- 저장 위치: research-loop 실행 폴더는 PES 저장소 밖에 둔다. PES는 경로만 받는다. 두 오케스트레이터를 동시에 돌리지 않는다(방식 A에서 research-loop을 서브에이전트로 부르지 않는다).
- 이유: 코드를 합치면 유지비·릴리스 결합이 커지고, 계약 없이 두면 조용히 깨진다. fixture + 버전 확인이 가장 싼 안전장치다.

**확인 필요**
- research-loop이 앞으로도 유지·개편되는지. 개편된다면 PES는 v1만 지원하고, 새 버전은 별도 어댑터로 받는다.

---

### 3.18 이벤트·관측성·디버깅 — P1

**정할 것**
- 이벤트 종류와 공통 봉투.
- 실행(run) 산출물: 프롬프트·컨텍스트·결과·도구 로그·비용.
- 상관 ID(`project_id`, `run_id`, `lease_id`).
- 비밀 제거·보존 기간·크기 제한.
- `doctor`와의 연결.

**현재**
- `feedback.log` 한 줄 형식(`scripts/serve.py:150-151`), 허브 로그(`scripts/pes.py:1123`), 스냅샷(`:400-410`), 단계 이력(`:294-299`), `doctor`(`:1401-1676`).
- 구조화된 이벤트 로그는 없다.

**선택지**
1. 지금 로그를 그대로 둔다.
2. **이벤트 분류·run 산출물 규격만 0단계에 정하고**, 파일 구현은 0~1단계, DB는 2단계.
3. 지금 DB 이벤트 소싱 도입.

**판단 기준**
- 실패한 라운드를 재현할 수 있는가.
- 방식 A의 품질·비용을 측정할 수 있는가.
- 대시보드 타임라인을 이벤트로 만들 수 있는가.
- 비밀이 로그에 남지 않는가.

**추천: 2번.**
- 이벤트 봉투: `{id, ts, project_id, stage, round, run_id, type, actor, payload, schema_version}`.
- 종류(초안): `project.created`, `stage.asked`, `round.started`, `item.updated`, `agent.run.started`, `agent.tool.called`, `agent.result.submitted`, `human.question.asked`, `human.answer.received`, `stage.approved`, `stage.reopened`, `lease.acquired`, `lease.expired`, `error`.
- run 폴더: `runs/<run_id>/{prompt.md, context.json, result.json, events.jsonl, cost.json}`. 비밀은 redaction 후 저장하고, 원문 프롬프트는 옵션으로만.
- `doctor`에 "이벤트/스냅샷/이력 불일치" 검사를 추가한다(2단계).
- 이유: 방식 A/B를 비교·디버깅하려면 같은 형식의 기록이 필요하다. 지금 로그는 사람이 읽기엔 좋지만 기계가 집계하기엔 부족하다.

---

### 3.19 유예 목록과 경계 — P2

**정할 것**
- 0단계에서 하지 않을 것과, 그 결정이 1·2단계를 막지 않게 할 인터페이스.

**선택지**
1. 유예를 구두로만 합의한다. 빠르지만 나중에 "그건 0단계였지"로 번진다.
2. **유예표 + 인터페이스 경계 + 건너뛴 테스트 표시**로 남긴다.
3. 유예 없이 전부 0단계에 넣는다. 0단계가 끝나지 않는다.

**판단 기준**
- 1·2단계의 설계·구현을 막지 않는가.
- 사용자에게 "왜 아직 안 됐는지" 설명할 수 있는가.
- 나중에 되돌릴 때 비용이 작은가.

| 유예 항목 | 0단계에서 하는 일 | 하지 않는 일 |
|---|---|---|
| hwpx 변환 확인 | `report_formats` 인터페이스 유지(`scripts/pes.py:651-665`), 건너뛴 테스트 표시, 수동 체크리스트 | 실제 변환·품질 확인 |
| 카드 디자인·웹 UI | 템플릿 동결, 테스트용 선택자만 확인 | 디자인 개편(`00-brief.md:53`) |
| DB·API 구현 | 계약 문서·스키마·가짜 어댑터 | 서버·DB 코드 |
| 다중 사용자·로그인 | 위협 모델·토큰 설계 | OAuth·권한 관리 |
| 판(edition)·첨언·알림 | 스키마 예약 필드·이벤트 종류 | 기능 구현 |
| research-loop 개편 | v1 계약·fixture | 코드 통합 |

**추천: 2번.**
- hwpx는 `report.md` → `report.hwpx` → `pes report` 재등록이라는 **현재 인터페이스**만 고정한다(`skills/core/SKILL.md:154`, `scripts/pes.py:830-868`). 변환 도구가 바뀌어도 PES 쪽은 그대로이게 한다.
- 이유: 0단계가 커지면 끝나지 않는다. 유예는 "잊은 것"이 아니라 **경계가 있는 결정**으로 기록한다.

---

## 4. 방식 A·B를 둘 다 개발한다는 전제에서 0단계에 미리 준비할 것

### 4.1 원칙: 하나의 코어, 두 개의 어댑터

- **PES 코어가 소유**: 상태 기계, 검증, 저장, 질문/답, 렌더, 이벤트, 감사.
- **에이전트가 소유**: 추론, 도구 사용, 조사·집필 내용.
- **어댑터가 소유**: 실행 시작/중단/스트리밍, 권한, 모델 매핑, 세션 수명.
- **금지**: 에이전트가 `project.json`을 직접 쓰는 것, 스킬이 제공자별 분기를 갖는 것, 템플릿이 상태를 만드는 것.
- 이 원칙이 없으면 A와 B는 같은 데이터 모델을 쓰면서도 다른 방식으로 상태를 망가뜨린다. 브리프의 "같은 데이터 모델과 같은 API"(`00-brief.md:39`)는 **쓰기 경로의 단일화**를 뜻한다.

### 4.2 공통 계약(라운드 봉투) 초안

0단계에서 문서로 고정할 최소 객체:

```text
Project   {project_id, slug, topic, schema_version, created_at, current_stage}
Stage     {stage, status, round, settings, summary, approved_at, stale}
Item      {item_id, kind, title, question, status, depth, summary, details,
           sources[], stats[], shots[], confidence, conflicts[], links{}, rev}
Run       {run_id, project_id, stage, round, agent{mode,name,model}, lease_id,
           started_at, ended_at, status}
Question  {question_id, run_id?, stage, round, spec, origin, created_at}
Answer    {answer_id, question_id, value, comment, source, answered_at, answered_by}
Event     {event_id, ts, project_id, run_id?, type, actor, payload, schema_version}
```

- 한 라운드의 흐름: `claim → context → (work) → submit* → ask* → wait → complete`.
- 사람 답변은 `Answer` + `Event`로 남고, 에이전트는 `wait`/poll로 받는다.
- 방식 A/B는 이 객체를 **같은 필드**로 만들고, 다른 것은 `agent.mode`와 전송 방식뿐이다.
- `rev`(revision)와 `lease_id`를 처음부터 넣어 동시성 문제를 나중에 끼워 넣지 않게 한다.

### 4.3 방식 A 준비 체크리스트

- [ ] `opencode serve` 기동·종료·health check·로그 위치(Windows 포함).
- [ ] Go 모델 ID·인증·사용량 한도 확인.
- [ ] 세션 생성/프롬프트/이벤트/중단/재개의 최소 래퍼.
- [ ] PES 질문 ↔ OpenCode form/permission의 역할 분리(정본은 PES).
- [ ] 권한 정책 파일과 사람 승인 UI 연결.
- [ ] 모델 정책(`strong|cheap|vision`) 매핑.
- [ ] 비용 상한·시간 상한·실패 시 재시도 1회·idempotency.
- [ ] 가짜 OpenCode 서버(HTTP stub)로 계약 테스트.
- [ ] 실제 프로젝트가 아닌 임시 프로젝트로 3회 반복 측정.
- [ ] 스파이크 리포트와 go/no-go.

### 4.4 방식 B 준비 체크리스트

- [ ] MCP 도구 6개 스키마(`context/claim/submit/ask/wait/complete`).
- [ ] MCP 서버는 아직 구현하지 않더라도 **도구 설명·인자·반환·오류**를 문서로 고정.
- [ ] HTTP API와 같은 서비스 계층을 쓸 수 있는지 경계 확인.
- [ ] `PES_OWNER` → 프로젝트 토큰/lease 마이그레이션 경로.
- [ ] 기존 파일 프로토콜(`feedback/*.json`, `rounds/*.json`) 읽기 호환.
- [ ] Claude Code 1회, OpenCode TUI 1회 실제 라운드 스파이크.
- [ ] TUI 종료 시 lease 만료·복구 시나리오.
- [ ] `/pes:run` 명령이 그대로 사용자 진입점이 되게 유지.

### 4.5 두 방식의 차이·공통 기능 매트릭스

| 기능 | 방식 A(PES 내부) | 방식 B(TUI 외부) | 0단계 결정 |
|---|---|---|---|
| 상태 저장 | PES API | PES API | 동일 서비스 계층 |
| 사람 질문 | PES 대시보드(정본) | PES 대시보드(정본) | 질문 스키마 v0 |
| 진행 스트림 | OpenCode 이벤트 → PES | CLI/MCP 이벤트 → PES | 이벤트 봉투 |
| 도구 권한 | OpenCode permission API | TUI 권한 프롬프트 | 정책 파일 |
| 취소 | `interrupt` | 프로세스/도구 중단 | run 상태 `cancelled` |
| 모델 선택 | Go/제공자 모델 | 사용자 TUI 모델 | `model_policy` |
| 비용 추적 | usage API | 도구별 로그 | `cost.json` |
| 오프라인 | 서버 필요 | 로컬 TUI | A는 서버 필수로 명시 |
| 다중 프로젝트 | lease로 격리 | lease로 격리 | 동일 |
| 알림 | 5단계 | 5단계 | 유예 |

- 이 표의 목적은 "둘 다 된다"를 약속하는 것이 아니라 **차이를 미리 인정**하는 것이다. 예를 들어 A는 OpenCode 서버가 없으면 아무것도 못 하므로, 오프라인 모드 B를 항상 남긴다.

### 4.6 0단계 산출물 목록(코드 아님)

| 산출물 | 내용 |
|---|---|
| `AGENTS.md` / `CLAUDE.md` | 개발 규칙 정본 + 포인터 |
| `docs/plan/decisions/` | ADR 6개 이상 + 색인 |
| `docs/plan/api-v0.md` | 자원·엔드포인트·오류·멱등·인증 |
| `schemas/project-v1.json` 등 | JSON Schema |
| `docs/plan/agent-adapters.md` | 어휘·모델 정책·도구 매핑 |
| `docs/plan/research-loop-contract.md` | v1 계약 |
| `docs/plan/spikes/opencode-mode-a.md` | 측정·go/no-go |
| `docs/plan/spikes/tui-mode-b.md` | 설정 단계·실패 지점 |
| `tests/` | L1~L5 + 가짜 어댑터 계약 |
| `.github/workflows/ci.yml` | Windows/macOS 매트릭스 |
| `scripts/check` / `check.ps1` | 로컬 검사 |
| `docs/plan/risk-register.md` | 위험·완화·담당 |
| `docs/plan/stage-0-report.md` | 완료 보고·1단계 입력 |

---

## 5. 0단계 완료 기준

### 5.1 필수 게이트

| 게이트 | 통과 조건 | 확인 방법 |
|---|---|---|
| G1 동작 고정 | v0.15.6 fixture의 CLI 결과·보고서·대시보드 구조가 의미상 동일 | golden 비교(시각·정렬 정규화) + `pytest` |
| G2 스키마 | `project-v1` 등 스키마 문서·검증·마이그레이션 dry-run·백업 규칙 존재 | 스키마 테스트 + 실제 프로젝트 사본 1개 마이그레이션 |
| G3 사람 계약 | 질문/답 v0 스키마로 은행·점검·피드백이 모두 검증됨 | 스키마 테스트 + 기존 `feedback/*.json` 로드 |
| G4 에이전트 계약 | 가짜 A/B 어댑터가 같은 run/answer/event 기록을 만든다 | 계약 테스트 2개 |
| G5 두 방식 스파이크 | A: OpenCode 1라운드, B: TUI 1라운드, 각각 측정 리포트 | `docs/plan/spikes/*` + 실제 임시 프로젝트 |
| G6 개발 규칙 | 새 세션이 `AGENTS.md`만 보고 테스트 실행 가능 | Claude/OpenCode 수동 체크 |
| G7 CI | Windows+macOS, Python 3.9/3.13 green, 5분 이내 | GitHub Actions 로그 |
| G8 보안 | 경로·Origin·크기·토큰 테스트 통과, 비밀 스캔 없음 | 보안 테스트 + `git grep` |
| G9 research-loop | v1 fixture 가져오기 성공, 버전 불일치 시 명확한 오류 | fixture 테스트 |
| G10 유예 명시 | hwpx·웹 UI·DB 구현이 "하지 않음"으로 기록되고 테스트에 skip 표시 | 유예표 + 리뷰 |

### 5.2 정량 지표(제안)

- CLI 명령 커버리지: **100%**(성공 1 + 실패 1).
- 상태 전이 커버리지: **100%**(허용 전이 + 거부 전이).
- 답 종류 커버리지: **6/6**(`skills/core/SKILL.md:191-206`).
- `doctor` 주요 검사: **100%** 테스트.
- v0.15.6 fixture: **6단계 모두** 렌더·보고서 생성.
- 2MB fixture: `load`/`save` < 100ms, `render` < 500ms (측정값 기록).
- CI: **5분 이내**, 네트워크 호출 0회(기본 job).
- 방식 A 품질: 3과제 × 10회 중 **8/10 성공**, 항목당 2분 이내(잠정).
- 두 방식 계약: 같은 입력에 대해 **필드 단위 동일**(시각·run_id 제외).

### 5.3 완료 판정 방법

1. `docs/plan/stage-0-report.md`에 게이트별 증거(명령·로그·측정값)를 붙인다.
2. Claude가 종합한 `docs/plan/stage-0.md`와 대조해 빠진 항목이 없는지 확인한다.
3. 사용자가 "1단계로 넘어가도 된다"고 승인한다.
4. 승인 시 `docs/plan/decisions/README.md`에 "0단계 종료"와 1단계 입력 목록을 남긴다.

### 5.4 아직 끝나지 않았다고 보는 신호

- 테스트는 있는데 **실제 CLI를 부르지 않는다**(mock만 있다).
- v0.15.6 fixture가 없어 "동작이 같다"고 말할 수 없다.
- `AGENTS.md`는 있는데 새 세션에서 테스트 명령이 재현되지 않는다.
- 방식 A 스파이크가 "성공했다"만 있고 **지연·비용·실패율**이 없다.
- 방식 B가 파일 프로토콜만 보고 "API 준비됐다"고 한다.
- hwpx·웹 UI가 슬그머니 0단계에 들어온다.
- 스키마가 문서에만 있고 **실제 프로젝트 사본**으로 검증되지 않았다.

---

## 6. 하지 않을 것 / 미룰 것

| 항목 | 이유 |
|---|---|
| DB·API 서버 구현 | 1단계 설계, 2단계 구현. 0단계는 계약만. |
| 웹 UI·카드 디자인 | 3단계. 지금 템플릿을 건드리면 테스트 기준이 흔들린다(`00-brief.md:53`). |
| hwpx 변환 확인 | 사용자가 맨 마지막으로 미룸(`00-brief.md:45`). 인터페이스만 고정. |
| 다중 사용자·로그인·알림 | 5단계. 위협 모델·토큰 설계만. |
| 판(edition)·첨언·대화 | 3~4단계. 스키마 예약 필드만. |
| research-loop 코드 통합 | 계약·fixture만. |
| 전면 패키지 재구성 | 1단계 이후. 지금은 최소 seam. |
| 실제 프로젝트 무백업 마이그레이션 | 금지. 항상 사본·백업으로. |
| "두 방식 모두 완벽" | 0단계는 **공통 계약과 스파이크**까지. 기능 동등성은 이후 단계. |

---

## 7. 열린 질문(사용자·Claude에게)

1. **방식 A의 1차 범위**: 6단계 전체를 저가 모델로 돌리는 것이 목표인가, 아니면 조사·요약 같은 특정 단계부터인가? 이 답에 따라 품질 기준과 모델 정책이 달라진다.
2. **비공개 연구 데이터와 OpenCode Go**: 구독 모델에 연구 데이터를 보내도 되는가? 약관·보관·학습 정책 확인이 필요하다.
3. **방식 B의 정본 에이전트**: Claude Code, Codex, OpenCode TUI 중 무엇을 1차로 보장하는가? 모두라면 MCP 도구 표면을 가장 보수적으로 잡아야 한다.
4. **OneDrive 지속 여부**: 웹/DB 이후에도 여러 컴퓨터에서 같은 프로젝트를 쓰는 요구가 남는가? 남으면 동기화 폴더를 저장소로 쓰지 않는 설계가 필요하다.
5. **`project.json`의 수명**: 2단계에서 SQLite로 즉시 옮기는가, 아니면 파일과 DB를 병행하는 기간을 두는가? 병행하면 revision·동기화 규칙이 추가로 필요하다.
6. **Python 최소 버전**: 3.9를 언제까지 지원하는가? 1단계에서 3.11로 올릴 것인가?
7. **테스트 언어**: 테스트 이름·주석을 영어로 하고 사용자 문자열만 한국어로 하는 안을 추천하지만, 저장소 전체가 한국어이므로 통일성을 우선할지 결정이 필요하다.
8. **hwpx 최종 도구**: 나중에 무엇을 쓸지(한글 자동화·문서 변환 라이브러리)에 따라 인터페이스가 달라질 수 있다. 0단계에서는 현재 `report.md` 입력·`report.<fmt>` 출력 계약만 고정하면 된다.
9. **research-loop의 미래**: 계속 유지·개편·폐지 중 무엇인가? PES가 v1만 지원할지, 새 버전 어댑터를 둘지 결정해야 한다.
10. **CI 비용**: 비공개 저장소에서 Windows+macOS×2 Python을 매 PR에 돌릴 것인가, 아니면 main/야간만 돌릴 것인가?

---

## 8. 근거 목록

### 브리프
- `docs/plan/00-brief.md:9-12` — 현재 PES 구조, 테스트 없음, 사용자 환경
- `docs/plan/00-brief.md:31-32` — DB 설계, 한 저장소
- `docs/plan/00-brief.md:35-39` — 방식 A/B, 같은 데이터 모델·API
- `docs/plan/00-brief.md:41-51` — 단계 초안, 0단계 목표, hwpx 유예
- `docs/plan/00-brief.md:53` — 카드 디자인 유예

### CLI·상태
- `scripts/pes.py:1-45` — CLI 전체 명령·구조
- `scripts/pes.py:57-64` — ROOT/TPL/QB, 단계 상수
- `scripts/pes.py:73-93` — CONFIG, PES 홈, slug/경로 판별
- `scripts/pes.py:96-114` — `load()` 기본값 채우기
- `scripts/pes.py:117-144` — 잠금 TTL·검사
- `scripts/pes.py:147-158` — 원자적 저장, library 분리
- `scripts/pes.py:167-178` — 단계·항목 기본 구조
- `scripts/pes.py:186-239` — init, research-loop `state.json` 가져오기
- `scripts/pes.py:243-286` — 질문 은행 복사·폼 렌더
- `scripts/pes.py:290-305` — 라운드 시작·이력
- `scripts/pes.py:315-337` — merge(출처·제안·깊이)
- `scripts/pes.py:400-439` — 스냅샷·대시보드 렌더
- `scripts/pes.py:442-490` — 승인·기획→조사 인계
- `scripts/pes.py:496-513` — 다시 열기·stale
- `scripts/pes.py:587-642` — digest/show
- `scripts/pes.py:651-665` — 보고서 형식
- `scripts/pes.py:709-829` — 단계 보고서 마크다운
- `scripts/pes.py:830-868` — 보고서 생성·등록
- `scripts/pes.py:870-935` — assemble/web
- `scripts/pes.py:937-1013` — QA 브리프·기록
- `scripts/pes.py:1113-1130` — 서버 기동
- `scripts/pes.py:1195` — HUB_PORTS 8760~8764
- `scripts/pes.py:1401-1676` — doctor
- `scripts/pes.py:1531-1560` — doctor의 상태 불변식 검사
- `scripts/pes.py:1677-1699` — lock/unlock
- `scripts/pes.py:1707-1713` — CLI 디스패치

### 서버
- `scripts/serve.py:14-24` — 의존성, 본문 제한, kind, slug
- `scripts/serve.py:30-38` — Origin 허용목록, trusted origins
- `scripts/serve.py:80-82` — 디렉터리 목록 금지
- `scripts/serve.py:89-109` — GET /whoami, /version, 리다이렉트
- `scripts/serve.py:111-152` — POST /feedback 저장·로그
- `scripts/serve.py:154` — 127.0.0.1 바인드

### 스킬·에이전트·질문
- `skills/core/SKILL.md:16` — AskUserQuestion
- `skills/core/SKILL.md:18` — project.json 단일 진실
- `skills/core/SKILL.md:20-49` — CLI 표
- `skills/core/SKILL.md:53-60` — 프로젝트 폴더 구조
- `skills/core/SKILL.md:62-84` — 직접 JSON 편집, 항목 스키마
- `skills/core/SKILL.md:86-92` — 토큰 절약
- `skills/core/SKILL.md:107-112` — 세션 표시·잠금
- `skills/core/SKILL.md:114-135` — 단계 생명주기
- `skills/core/SKILL.md:120-126` — 독립 검토
- `skills/core/SKILL.md:137-156` — 단계 보고서, hwpx
- `skills/core/SKILL.md:158-166` — 답 받기
- `skills/core/SKILL.md:168-189` — AI 점검 스키마
- `skills/core/SKILL.md:191-206` — 답 해석 표
- `agents/researcher.md:1-25` — 결과 파일 계약
- `agents/reviewer.md:1-10` — QC/QA 역할
- `questions/plan.json:1-35` — 질문 은행 구조
- `skills/plan/SKILL.md:1-51` — 기획 산출물
- `skills/research/SKILL.md:1-60` — 조사 흐름·모델 정책

### 저장소·배포·환경
- `README.md:79-91` — 필수 환경, Python 3.9
- `README.md:107-141` — 설치·업데이트·배포
- `README.md:343-360` — OneDrive 동기화 범위
- `README.md:503-513` — 한 번에 한 컴퓨터
- `README.md:537-545` — 토큰 절약
- `README.md:548-563` — 프로젝트 폴더 구조
- `README.md:566-580` — 플러그인 구조
- `README.md:597+` — 변경 이력
- `.claude-plugin/plugin.json:3` — 버전 0.15.6
- `.gitignore:14-20` — 프로젝트·비밀·대화 기록 제외
- `scripts/setup.py:21`, `:43`, `:205-237` — subprocess, 키 마스킹, npm 설치

### 외부 문서(확인일 2026-11-04)
- OpenCode V2 API: <https://opencode.ai/v2/docs/api> — session/prompt/event/permission/form/model/usage 엔드포인트
- OpenCode V2 Client: <https://opencode.ai/v2/docs/build/client> — `session.create`, `session.prompt`, `event.subscribe`
- OpenCode V2 설정: <https://opencode.ai/v2/docs/config> — `instructions` 등 지침 로딩

---

## 9. 마지막 의견

0단계에서 가장 값싸고 효과가 큰 세 가지는 다음 순서다.

1. **CLI characterization 테스트 + 합성 fixture** — 1주 안에 v0.15.6을 고정할 수 있고, 이후 모든 변경의 안전망이 된다.
2. **`AGENTS.md` + ADR + CI** — 사람과 AI가 같은 규칙으로 일하게 만든다. 특히 새 세션의 에이전트가 `~/pes-projects`를 건드리지 않게 하는 것이 중요하다.
3. **API/스키마 계약 v0 + 가짜 어댑터** — A/B를 동시에 개발하는 비용을 가장 많이 줄인다. 구현보다 계약이 먼저다.

반대로, 0단계에서 **DB를 만들거나 웹 화면을 고치거나 hwpx를 확인하면** 끝나지 않는다. 그 셋은 각각 2·3단계와 마지막으로 미루는 것이 맞다.

그리고 한 가지 강조: **"에이전트가 상태를 직접 쓰지 않는다"** 를 0단계의 헌법으로 삼자. 지금 스킬의 직접 편집(`skills/core/SKILL.md:62-84`)을 그대로 두고 API만 얹으면, 방식 A/B는 같은 파일을 서로 덮어쓰는 두 개의 프로그램이 된다.
